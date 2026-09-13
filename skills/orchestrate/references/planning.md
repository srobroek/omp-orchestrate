# Planning: decomposition, frameworks, routing, concurrency

Two actors own two different plans, and neither does the other's job.

- **The lead** owns which epics exist, who owns them, and what "done" means for the run.
- **The architect** owns the decomposition inside its epic: feature beads, tasks, scopes,
  dependencies. It reads the domain, because that is the part that cannot be delegated
  upward.

Do small factual checks directly. Delegate a bounded investigation when its read set or
independent slices justify a separate context; retain ownership of decisions and the graph.

## Decide the planning system

- **A framework is already in play (SpecKit or similar):** adopt it, never re-pour it. A
  poured molecule is already a dependency-aware DAG, and its implement-step children are the
  worker units. Detect it by `spec_id` plus `metadata.spec_dir`, then add the `orc-node`
  label, one `role=<role>` routing key, and `scope` metadata to the existing step beads.
  Phase steps route by their `skill_hints`. Reconcile each step against the code as it is
  now, and report drift rather than implementing around it. Questions the spec raises become
  `ASK` wisps. `speckit-verify` and `speckit-sync` keep their own agents, and `specs/*/tasks.md`
  belongs to the conductor -- writes to it are denied.
- **No framework:** build the default DAG below.
- **Unfamiliar subsystem or unresolved cross-cutting dependencies:** investigate the gap
  before committing the graph. A helper is optional, not a task-count-triggered planning phase.

Never build a second graph beside one that exists. There is no in-memory ledger, no JSON
plan, and no `graph.py`: the epic and its dependency edges ARE the DAG.

## Default DAG decomposition

The DAG is per-project and runtime-mutable. Nodes and edges are added as the domain is
understood, and agents update state live. It is not a static authored graph.

1. Split the work into tasks small enough for one worker. Give every task a disjoint `scope`:
   tracked-file globs for git work, or canonical artifact and resource prefixes for non-git
   work. Serialize overlapping scopes with a dependency.
2. One bead per task under its feature: `bd create "<title>" --parent
   <feature> --labels orc-node --metadata '{"role":"<role>", <rest of the envelope>}'
   --silent`.
3. Encode dependencies with `bd dep add <dependent> <dependency>`; the dependency must close
   before the dependent becomes ready. `bd dep cycles` must stay clean, and `bd` rejects a
   cycle-creating edge at add time.
4. Gate on structure before dispatching: `bd swarm validate <epic> --json`, stop on
   `swarmable=false`, and triage `warnings` rather than treating each as a defect. Cycles,
   disconnected nodes, multiple endpoints, and an empty graph are real findings. An
   `outside epic` warning naming a merge bead is expected and correct -- merge beads are
   deliberately unparented, and `work → merge bead` is the required edge direction. The same
   warning naming anything else is a real finding. Validation needs no swarm marker, so it
   runs on a bare epic.
5. Drive execution off the ready front: `bd ready --parent <epic>
   --metadata-field role=<role> --unassigned --claim --json`, run by the worker, not by
   you.

`bd swarm status <epic>` is a coarse progress view. It omits external blockers, gates, and
deferral, so it never proves a run is healthy. Create a `bd swarm` marker only when durable
coordinator discovery or an external scheduler needs a handle -- not to make the epic
persistent, which it already is.

## Routing envelope

Write the route before dispatch, so recovery never has to infer it from prose.

| Field | Value |
|---|---|
| `scope` metadata | owned tracked-file globs, or canonical non-git resource prefixes. Never empty |
| `execution_task_kind` metadata | stable routing kind: `code`, `docs`, `research`, `review`, `operations` |
| `execution_kind` metadata | `git`, `artifact`, `comment`, or `external`: which completion proof the exit contract demands |
| `origin_actor` metadata | the actor handle a bounce routes back to |
| `role` metadata | the pull queue this bead sits in. Every ready query filters on it |
| `orc-node` label | run-DAG membership |

`origin` carried three unrelated values and is split. `origin_actor` holds an actor handle.
`origin_bead` holds a bead id -- the merge bead behind a fix, the feature behind a merge.
`run_epic` holds the run epic a bead was poured under, which is membership and never a
route. A reader still accepts a legacy `origin`, and nothing writes it again.

`execution_kind=git` means tracked files change, even when the task is documentation or
configuration: it requires a commit and a `push` stamp, and it lands through a merge bead.
Other evidence modes need an `output_ref` or a verifiable external-state reference, never an
empty commit.

## Dispatch ready work

Ordinary dispatch is a pull, and the `role` key is the whole route. There is no activation message.

**Queue (the default).** Leave the bead unassigned with one `role=<role>` key. A worker
claims the first ready bead in its queue atomically:

```
bd ready --parent <epic> --metadata-field role=<role> \
  --metadata-field execution_task_kind=<kind> \
  --metadata-field execution_kind=<evidence> --unassigned --sort priority \
  --claim --json
```

The worker accepts the bead `--claim` returns; it never lists candidates and cherry-picks
one. A lost race surfaces as a claim error naming a serialization conflict, never as an
empty result, and the loser retries the identical pull -- `references/dispatch-contract.md`
holds the signatures and the retry budget. One activation owns at most one bead and cannot
claim another until the first is terminal.

**No directed preassignment.** A bead with an assignee is invisible to every
`--unassigned` pull. Spawning that actor does not make the role's pull acquire it.
Leave new work unassigned; an existing assignment needs explicit release or recovery
under `references/lifecycle.md`, never automatic assignee correction.

While a bead stays unassigned, the architect that owns the epic may stamp, change, or drop
its `role` key (`--set-metadata role=<role>`, `--unset-metadata role`). No other role may:
the write seam refuses a routing rewrite from anyone else, while `bd create` stays exempt so
filed work can arrive routed. A routing envelope the worker cannot satisfy is a routing
defect: the worker does no task work, records the mismatch, and reports `BLOCKED kind:design`
so the envelope can be repaired.

Spawn a wave only against observed ready work. An idle worker with nothing to claim is not
parallelism -- it reports `NO_WORK` and exits, and the spawn was wasted.

## Merge order is not encoded

Do not encode merge order in the graph; you cannot predict which worker finishes when.
Approved landing units become `pr:merge` beads. The plugin's landing sweep merges each PR
when GitHub reports it `CLEAN` at the reviewed head, guarded by `--match-head-commit`.
No slot or queue orders the merges: a lost race surfaces as `BEHIND` or `DIRTY` on the
next sweep, which refreshes or bounces it. Predict conflicts with `orc_conflict_probe`
before a merge bead exists. The graph expresses dependencies, not integration sequence.

## Scope hygiene

Scope choice decides whether beads can run concurrently.

- Prefer directory-level ownership (`src/auth/**`) over scattering one bead across many trees.
- If two tasks must touch the same file, they are not concurrent. Give one a dependency on
  the other so the ready front serializes them.
- A shared contract or interface that two or more beads depend on is its own early bead that
  the others depend on.
- Artifact-only and external-state scopes use stable prefixes such as `artifact:/abs/path` or
  `external:<system>/<resource>`, so overlap is checked the same way as file ownership.

Overlapping scopes are what produce the merge conflicts an architect then has to arbitrate.
Spend the effort here rather than there. The extension checks overlap at two points and
nowhere else:

- When an architect writes a `scope` with `bd create` or `bd update`, the gate refuses one
  that overlaps an open or in-progress `orc-node` of the same run outside the bead's own
  lineage.
- When a worker claims a named bead (`bd update <id> --claim`), the gate compares that
  bead's `scope` with every live claim's `scope`.

A queue pull (`bd ready … --claim`) names no bead, so nothing is compared there; the
decomposition check is what keeps the queue's beads disjoint. No per-write check exists: G2
confines a write to the claimant's own checkout and `metadata.scope`, and does not consult
other claims. Friction catches the honest mistake. It is not a substitute for disjoint globs.

A feature bead's scope may be the union of its tasks: a bead's own parent chain and children are exempt from the friction check, so an architect can hold the feature envelope while its workers hold task scopes. An unrelated architect's envelope still counts as friction. Architects never take a code-writing claim over task territory; their feature claim is for integration and coordination, not editing.

## Concurrency

`task.maxConcurrency` is a per-spawner ceiling, not a run-wide budget. Each architect
can admit its own full wave, including reviewers, researchers and helpers. The lead
must coordinate aggregate wave widths across architects when provider, context or
disk limits require a run-wide cap. Reported workers exit rather than waiting for review.
Three limits matter:

- **Provider rate limit.** Narrow aggregate waves when requests are rejected.
- **Lead context.** Every wave you observe costs the lead tokens it never gets back.
- **Disk.** Every isolated worker copy carries its own build artifacts. If disk is tight,
  narrow the wave again.

Wave sizing is the architect's judgement: a wave that finishes early is cheap to respawn, and
one sized past the cap simply idles against it.

## Runtime dispatch settings

The six required effective settings ship in the plugin's `config/orchestrate.overlay.yml`;
the operator starts the lead session with `omp --config <plugin-root>/config/orchestrate.overlay.yml`.
`modelRoles.reviewer` is required and lives in the operator's own config, never in the
overlay; unset, the doctor fails its row and the spawn gate refuses `orc-reviewer` (`roles.md`).
Before the first wave, preflight compares the effective values against it and reports a
deviation as `WARN settings`. Preflight never rewrites config.

On a deviation, the operator restarts with the overlay or explicitly accepts the reported
limitations. Claim foreground observation remains mandatory even if a settings warning is
accepted. Each spawner also needs its explicit `spawns:` allowlist;
`task.maxRecursionDepth` alone does not grant a helper.

Every bead-claiming role is a `task` subagent, and the architect and implementer run
isolated; the spawn gate refuses either without `isolated: true`. Architect entry, from the
lead, and worker entry, from the architect:

```
{ name: "<CamelCase>", agent: "orc-architect", task: "<run epic id + role, not the work>", isolated: true }
{ name: "<CamelCase>", agent: "orc-implementer", task: "<epic id + queue, not the work>", isolated: true }
```

Use per-entry `effort: "lo" | "med" | "hi"` for the actual slice. Use `outputSchema`
with `schemaMode: "strict"` for shape checking; it does not prove semantic acceptance.
Collect terminal results, not job receipts, before consuming captures or resuming writes.
MCP/LSP degradation is recorded as `WARN preflight` on the epic; it does not hold a wave.

## Architect entry, feature branch, and replacement

The architect's cwd is a clone of the primary checkout, taken at spawn. OMP deletes the
clone when the architect completes, when the lead cancels it, or when it hits the 30-minute
wall-clock cap; OMP 18.1.17 has no keep option. Nothing that exists only in a clone
survives it. Origin is the durable store, so each entry step pushes before anything depends
on it.

Entry, after the claim (`bd ready --parent <run-epic> --metadata-field role=architect
--unassigned --claim --json`; no path filter):

1. Create the feature branch and push it before any dispatch:

   ```sh
   git switch -c "<branch>" && git push -u origin "<branch>"
   ```

2. Stamp the epic. `worktree` is informational: G2 confines writes to the isolation root
   the runtime reports, and no queue pull filters on the path.

   ```sh
   bd update "<epic>" --metadata '{"branch":"<branch>","base_sha":"<sha>","push":"origin/<branch>","head_sha":"<sha>","worktree":"<clone root>"}'
   ```

3. Dispatch implementers `isolated: true`. Each runs in a clone of your clone, on
   `<branch>` at its head. Before yield it pushes its head to `origin/omp/task/<id>` and
   reports `pushed=omp/task/<id>@<sha>`; G4 refuses its yield until
   `git ls-remote origin refs/heads/omp/task/<id>` shows that head. At successful
   completion OMP also captures `omp/task/<id>` in your clone; the two hold the same commits.
4. Integrate serially, from the local capture or from `origin/omp/task/<id>`, then push
   and re-stamp before the next integration:

   ```sh
   git push origin "<branch>"
   bd update "<epic>" --set-metadata head_sha="$(git rev-parse HEAD)"
   ```

   G4 refuses your yield, terminal or paused, while
   `git ls-remote origin refs/heads/<branch>` differs from `metadata.head_sha`.
5. On completion, write `REPORTED` and yield holding the epic: G4 proves the feature head
   on origin, then releases the claim in the same fenced write that stamps `pushed_sha`.
   A yielded isolated architect is finished: its clone is gone and no wake revives it. A
   pause is different: write `BLOCKED` (escalation wisp) or `ASK` first, set the epic
   `blocked`, then release it yourself (`bd update "<epic>" --claim --assignee ""`); G4
   admits that exit only with the feature head on origin. The escalation's `NOTE` or
   `/orchestrate-answer` reopens the epic for the fresh architect the lead spawns.

### Replacement

A timeout or cancel ends the architect's process and deletes its clone; the reaper in
the lead's session releases the epic claim under the lease fence and writes `RECOVERED`.
A voluntary yield has released it, by the plugin on completion or by the architect on a pause. Either way the lead spawns one replacement
`orc-architect`, `isolated: true`, naming the run epic and the role. The replacement:

1. Pulls the epic by role. The claimed epic carries `branch`, `push`, `head_sha`.
2. Checks out the branch from origin and requires the stamped head:

   ```sh
   git fetch origin "<branch>" && git switch "<branch>" && test "$(git rev-parse HEAD)" = "<head_sha>"
   ```

   A mismatch means the last push and the last stamp disagree: report `BLOCKED` quoting
   both values. Never reset or force-push an origin branch.
3. Finds unintegrated worker output from bead evidence, never from a clone. For each task
   whose last verb is `REPORTED`, read `pushed=<ref>@<sha>`, then:

   ```sh
   git fetch origin "<ref>" && git cherry "<branch>" FETCH_HEAD
   ```

   A `+` line is a commit the branch lacks. Integrate it, push, re-stamp `head_sha`.
4. Leaves dead workers' claims to the reaper (`lifecycle.md`, Dead-claim recovery). A
   `RECOVERED` comment's `recovered_branch` names a capture in the dead architect's clone;
   read the origin ref instead.

An architect crash loses at most the integration it had not pushed; a worker crash loses the
unit it had not pushed. Nobody rescues a local tree, because none outlives its agent.
