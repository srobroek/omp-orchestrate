# Planning: decomposition, frameworks, routing, concurrency

Two actors own two different plans, and neither does the other's job.

- **The lead** owns which epics exist, who owns them, and what "done" means for the run.
- **The architect** owns the decomposition inside its epic: features, tasks, scopes,
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
Approved landing units integrate under the exclusive merge slot (`bd merge-slot acquire`,
never with `--wait`). A held slot is advisory: report the holder and either enqueue as a
waiter and yield, or retry later. Order follows successful acquisition, not a FIFO guarantee.
The shepherd conflict-guards every integration with `orc_conflict_probe`. The graph expresses
dependencies, not integration sequence.

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
Spend the effort here rather than there: the claim rule's overlap check is friction that
catches the honest mistake, not a substitute for disjoint globs.

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

Before the first wave, require these effective settings; fix deviations and restart or
obtain explicit acceptance of the reported limitations. Preflight never rewrites config.
Claim foreground observation remains mandatory even if a settings warning is accepted.

| Setting | Value |
|---|---|
| `task.isolation.enabled` | `true` |
| `task.isolation.merge` | `branch` |
| `task.isolation.apply` | `false` |
| `task.enableEffort` | `true` for per-entry effort |
| `task.maxRecursionDepth` | `3` for worker helpers; each spawner also needs its explicit allowlist |
| `bash.autoBackground.enabled` | `false` |
| `BEADS_DIR` | the same absolute embedded run database in every child |

Architects use persistent Worktrunk feature trees, not isolated spawns. Worker entry:

```
{ name: "<CamelCase>", agent: "orc-implementer", task: "<epic id + queue, not the work>", isolated: true }
```

Use per-entry `effort: "lo" | "med" | "hi"` for the actual slice. Use `outputSchema`
with `schemaMode: "strict"` for shape checking; it does not prove semantic acceptance.
Collect terminal results, not job receipts, before consuming captures or resuming writes.
MCP/LSP degradation is recorded as `WARN preflight` on the epic; it does not hold a wave.

## Architect runtime entry and recovery

Start the architect in the canonical Worktrunk root derived from the session before
claiming or dispatching. Non-isolated children inherit the parent session's cwd;
isolated children run in a runtime-created copy snapshotted from that cwd.
`metadata.worktree` routes queue ownership and scope; it never switches cwd.
Verify the architect session root matches before any write or dispatch.

When re-entry changes the discovery root, use the supported rooted lead CLI and
preserve the loaded native agent's role and spawn policy:

```sh
BEADS_DIR="<absolute-beads-dir>" \
ORCHESTRATE_MARKER_FILE="<absolute-marker-file>" \
omp --cwd "<canonical-worktree>" --config "<run-overlay>" --print \
  "Lead: dispatch the loaded native orc-architect for the bound epic; preserve its role and spawn policy; collect and return the actual terminal result." </dev/null
```

Pass `--config "<run-overlay>"` when re-entry changes discovery root; otherwise retain
the active run configuration. A supervised PTY is also valid for `--print`; closed
stdin prevents a hanging process. Collect the actual result before replacement.
Keep experiment-only isolation enablement in the run overlay. Do not silently
override the user's project or global isolation preference.

### Canonical checkout recovery

Recovery is one ordered operation inside an explicit exclusive claim/dispatch/branch-writer
window. Stop every claim writer, dispatch writer, and branch writer before entering it;
do not release a retained claim merely to relocate a session. First collect the prior
actor's terminal result, capture, dirty delta, branch, comments, and audit evidence and
preserve every one of those anchors throughout recovery.

1. Inventory the exact owning epic's current metadata and every Worktrunk checkout:

   ```sh
   bd show "<epic>" --json
   wt list --format=json
   ```

   Record the stamped `metadata.branch` and `metadata.worktree`, the owning epic id,
   and the checkout's returned branch/path. Do not infer a path from a branch name or
   accept a path from a different bead.
2. If the stamped path exists, preserve it exactly, including an accepted dirty
   resumed checkout; inspect its status and evidence, and never reset, clean, or
   replace it merely to make recovery look fresh.
3. If the stamped path is missing, keep the claim and evidence in place, verify the
   branch and source-root Git object/capture independently, and recreate only the
   missing checkout from the actual source root:

   ```sh
   wt -C "<source-root>" switch "<branch>" --no-cd --format=json
   ```

   Use the returned JSON `path` as `<canonical-worktree>` for every subsequent command.
   Do not derive it from `<branch>`, reuse stale metadata, or treat a missing Git object
   as a cwd problem.
4. At that returned or preserved canonical path, read the WT bead binding:

   ```sh
   wt -C "<canonical-worktree>" step eval '{{ vars.bead }}' --format json
   ```

   Reject an unresolved read or a binding naming another bead/epic (a foreign WT
   binding). An absent binding is acceptable only for the newly recreated checkout
   whose branch ownership was independently verified; it must be stamped before
   re-entry.
5. Stamp both sides of the binding for the exact owning epic, without changing its
   assignee, status, claim, branch, or evidence:

   ```sh
   bd update "<epic>" --metadata '{"worktree":"<canonical-worktree>","branch":"<branch>"}'
   wt -C "<canonical-worktree>" config state vars set bead="<epic>" --branch "<branch>"
   ```

6. Read both authoritative records back and require exact equality before any actor
   re-entry or dispatch:

   ```sh
   bd show "<epic>" --json
   wt -C "<canonical-worktree>" step eval '{{ vars.bead }}' --format json
   ```

   The bead's `metadata.worktree` must equal the returned canonical path, its branch
   must equal the inventoried branch, and the WT `bead` value must equal the owning
   epic id. A mismatch, stale value, foreign binding, or unresolved read is BLOCKED;
   retain the claim, checkout, captures, and terminal evidence for explicit recovery.
7. Only after those equality checks pass, re-enter the loaded architect through the
   rooted `omp --cwd "<canonical-worktree>" --config "<run-overlay>"` procedure above.
   A missing Git object, missing commit/capture, or source-root failure remains a
   separate setup failure and must be reported with its own evidence; cwd correction
   never proves the object exists or that dispatch succeeded.
