# Planning

The DAG is the plan. A step with no bead is not planned work.

## Shape

Two tiers by default: the lead dispatches workers directly and integrates their branches.

```
lead (root session, or orc-lead for one epic)
├─ orc-planner        writes the DAG, returns          not isolated
├─ orc-implementer    one task bead each               isolated: true
├─ orc-reviewer       one review bead each             not isolated
├─ orc-researcher     one question each                not isolated
└─ orc-shepherd       one PR bead each                 not isolated
```

Three tiers for a multi-epic run: the root session dispatches one `orc-lead` per epic with
`isolated: true` and a brief that names the epic and contains the word `orchestrate`, so the
epic lead receives the same run header. Each epic lead runs the two-tier shape inside its
clone; its final tree is captured as the epic branch, and the root merges the epic branches.
`maxRecursionDepth` is 2 for two tiers and 3 for three.

## Write the DAG

- One epic per independent deliverable. `bd create --type epic --title <t>`.
- One task per unit an implementer finishes in one isolated checkout:
  `bd create --parent <epic> --type task --title <t> --description <d> --metadata role=<r>`.
  The description names the scope (paths and symbols) and numbered acceptance criteria a
  reviewer can check without asking.
- `bd dep add <task> <depends-on>` for an order two tasks must keep.
- A contract two epics share becomes a `decision` bead before either epic is dispatched:
  LOAD `skill://orchestrate-with-bd/references/decisions.md`.
- Adopt beads that already exist under the epic. NOT Build a parallel DAG beside them.

Dispatch `orc-planner` for this when the domain is unfamiliar or the DAG does not exist; it
creates the beads and returns their ids. Otherwise write them yourself.

## Plan mode

A plan-mode plan for a run has a `## Beads` section listing the epic id and every task bead
the plan implements, one per line as `<bead-id> <title>`. Create a bead before adding a step
that has none. A plan whose steps outnumber its beads is not approved work.

```markdown
## Beads
- repo-pih            Epic: interactive browser fixture
- repo-pih.1          Add the click harness
- repo-pih.2          Record the network log
```

## Dispatch

1. `orc_status` → rewrite the todo list from `orc_status.todo`.
2. One `task` call per wave: every bead with no open dependency, in one array. Each brief
   names the bead id, the agent's role, and nothing the bead already says.
3. Implementers and epic leads `isolated: true`; every other role without it.
4. After the wave: read each `orc_finish` comment on its bead, merge accepted
   `omp/task/<id>` branches into your tree, `orc_status` again, redraw the todo list.
5. A `changes` verdict from a reviewer becomes a new task bead under the same epic naming
   the findings; dispatch it in the next wave.

## Todo discipline

The todo list is a per-turn view of `orc_status`. Every item is `<bead-id> <title>` copied
from `orc_status.todo`. The plugin's `todo_reminder` handler names any item whose first
token is not a bead id in the bound run; on that advisory, re-read `orc_status` and rewrite
the list. `todo done` redraws the view; `orc_finish` changes the state.
