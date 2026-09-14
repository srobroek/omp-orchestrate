---
name: orchestrate-with-bd
description: Durable Beads-backed orchestration on native OMP task dispatch. Use when the user says orchestrate, or when resuming a run recorded in Beads.
---

# Orchestrate with bd

TRIGGER
+ The prompt says `orchestrate`; the plugin's run header arrives on that word alone.
+ Resuming a run: the checkout carries `.orchestration/.active-run`; say `orchestrate` in
  the prompt to receive the header, then `orc_status {}` reads the bound run.
- One bounded task with no independent slices: execute it directly.

You are the lead. OMP owns scheduling, isolation, capture, and landing. Beads records what
work exists and what state it is in. The run header the plugin injected on your prompt is
the contract. This document is the procedure behind it.

## Three facts nobody re-derives

1. The native `orchestrate` notice reaches a dispatched agent whose brief contains the bare
   lowercase word when that agent has the `task` tool. That is how `orc-lead` receives the
   contract. It is also why a worker brief never contains the word.
2. Workers have no `todo` list. OMP withholds the `todo` tool from every dispatched agent.
   A worker tracks nothing outside its bead, and `orc_finish` is its only progress record.
3. Beads outranks both the plan and the `todo` list. A plan-mode plan names its beads in a
   `## Beads` section. A `todo` entry is `<bead-id> <title>` copied from `orc_status.todo`.

## Workflow

| Phase | LOAD |
|---|---|
| Store setup, migration, or a `Dolt server unreachable` error | `skill://orchestrate-with-bd/references/beads-store.md` |
| Writing or adopting the DAG, plan-mode plans, dispatch shape | `skill://orchestrate-with-bd/references/planning.md` |
| Which agent, which model, `isolated`, recursion depth | `skill://orchestrate-with-bd/references/roles.md` |
| A contract two epics share | `skill://orchestrate-with-bd/references/decisions.md` |
| Review bots on a PR | `skill://orchestrate-with-bd/references/review-providers.md` |

1. Bind. `orc_status { epic: <id> }` binds the run to this checkout and returns every bead
   under the epic. No epic yet: `bd create --type epic`, or dispatch `orc-planner` when the
   domain is unfamiliar, then bind.
2. Plan. Rewrite your `todo` list from `orc_status.todo`. Every entry is a bead.
3. Dispatch. One `task` call per wave of independent beads. Name the bead id in each brief.
   Implementers run `isolated: true`. Every other role runs without it.
4. Integrate. OMP captures each isolated agent's tree as `omp/task/<agent-name>` (the name
   you gave the `task` call, not the bead id; an epic lead's branch is `omp/task/<lead-name>`).
   Merge each accepted branch yourself after its review verdict and resolve conflicts in your
   tree. A conflict in `.beads/interactions.jsonl` (bd's per-clone audit log) is resolved by
   keeping both sides. Then `orc_status` again and redraw the `todo` list.
5. Close. When every task is closed or blocked, `orc_finish` the epic.

## Rules

- MUST Dispatch through the native `task` tool. NOT Start a nested `omp` process. NOT
  Create a worktree for an agent; OMP's `isolated: true` is the worker's workspace.
- MUST Keep the store in server mode. Native isolation clones the checkout, and an embedded
  Dolt store forks with it. Every ledger tool returns the migration text on an embedded store.
- NOT Migrate a store, edit `.beads/`, or dispatch an agent to do so. On an embedded or
  missing store, report the route from `references/beads-store.md` to the human and end the
  turn; a human runs the migration.
- NOT Claim a bead or edit product code as the lead. Workers claim; reviewers judge.
- MUST Copy `todo` entries from `orc_status.todo`. On any disagreement re-read `orc_status`
  and rewrite the list. `todo done` redraws the view. `orc_finish` changes the state.
- MUST Record a cross-epic contract as a `decision` bead before dispatching the epics.
- MUST Set `maxRecursionDepth` to 2 for a single-epic run and 3 for a multi-epic run.
- NOT Put the bare lowercase word `orchestrate` in a worker brief. Put it in an `orc-lead`
  brief.
- NOT Pass `--db` or a store path to a child yourself. `bd` resolves the shared server
  from the tracked `.beads/metadata.json` in every clone. The `beads` plugin pins
  `BEADS_DIR` to the primary checkout's `.beads` on every bash call; that names the same
  server database and is not a fork.

## Tools

| Need | Tool |
|---|---|
| Bind the run, read the DAG, source the `todo` list | `orc_status` |
| Take a bead (workers) | `orc_claim`; `claimed: false` names the holder |
| Close or block a bead with evidence (workers, lead for the epic) | `orc_finish` |
| Bot round at the exact PR head | `orc_bot_review_probe`; `unknown` and `declined` are never clean |
| Request a provider review | `orc_bot_review_request`, shepherd only |
| Conflict or CI evidence for a branch | `orc_conflict_probe` |
| Bounce or escalate an actionable round | `orc_review_round_policy` |
