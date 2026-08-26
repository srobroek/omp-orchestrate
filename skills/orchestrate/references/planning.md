# Planning: decomposition, frameworks, routing, concurrency

Two actors own two different plans, and neither does the other's job.

- **The lead** owns which epics exist, who owns them, and what "done" means for the run. It
  never reads domain code to decide that.
- **The architect** owns the decomposition inside its epic: features, tasks, scopes,
  dependencies. It reads the domain, because that is the part that cannot be delegated
  upward.

Owning a plan means owning the decisions and the graph, not doing the deep reading. Push
codebase exploration and any large planning pass to a read-only agent and keep only its
conclusions.

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
- **Work spanning more than three tasks with cross-cutting deps, or an unfamiliar
  subsystem:** delegate one deep planning pass to a read-only agent before committing the
  decomposition. You still own the final graph.

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

Dispatch is a pull, and the `role` key is the whole route. There is no activation message.

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

**Directed (the exception).** A bead with an assignee is invisible to every `--unassigned`
pull, so it goes only to that actor and must be spawned deliberately. Confirm its
`execution_task_kind`, `execution_kind`, and `scope` are compatible with that actor first;
an incompatible directed assignment stays pinned and unclaimed rather than being silently
rerouted. Automatic correction may update evidence-backed envelope fields only. It never
changes an assignee: that needs an explicit release or a recovery under the contracts in
`references/lifecycle.md`.

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

For GitHub-backed runs, `release-queue-watch` priority affects which eligible PR readiness
hint arrives first. It does not rewrite the DAG and does not reserve the merge slot. Only an
exact existing approved bead is admitted; after admission, the slot waiters remain the
integration order. See `references/queue-watcher.md`.

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

`task.maxConcurrency` is the ceiling, and it counts live agents rather than CPU. Count every
one of these:

- each architect
- each worker in a wave, including one still waiting for its review
- each reviewer and researcher
- the shepherd
- each helper inside an architect's await

Nothing in a run is CPU-bound. Three limits matter:

- **Provider rate limit.** While requests are accepted and the lead's context has room, a
  wider wave is free. On the first rejection, narrow it.
- **Lead context.** Every wave you observe costs the lead tokens it never gets back.
- **Disk.** Every isolated worker copy carries its own build artifacts. If disk is tight,
  narrow the wave again.

Wave sizing is the architect's judgement: a wave that finishes early is cheap to respawn, and
one sized past the cap simply idles against it.
