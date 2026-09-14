# Planning

The DAG is the plan. A step with no bead is not work the run knows about.

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

Three tiers for a multi-epic run. The root session dispatches one `orc-lead` per epic with
`isolated: true`. Each brief names its epic and contains the word `orchestrate`, so the epic
lead receives the same run header. Each epic lead runs the two-tier shape inside its clone.
OMP captures the lead's final tree as `omp/task/<lead-name>`, and the root merges those
branches. `maxRecursionDepth` is 2 for two tiers and 3 for three.

`orc_status.shape` reports which shape the DAG implies. When a direct child of the run epic
is itself an epic, the shape is `three-tier`; otherwise it is `two-tier`. No separate human
switch exists. The plan the human approved is the input: its `## Beads` section names the
child epics or does not. A prompt that asks for two tiers over a multi-epic DAG gets two
tiers: the lead dispatches the epics' tasks directly.

## Write the DAG

- One epic per independent deliverable. `bd create --type epic --title <t>`.
- One task per unit an implementer finishes in one isolated checkout:
  `bd create --parent <epic> --type task --title <t> --description <d> --metadata role=<r>`.
  The description names the scope (paths and symbols) and numbered acceptance criteria a
  reviewer can check without asking.
- `bd dep add <task> <depends-on>` for an order two tasks must keep.
- Before either epic runs, record a contract two epics share as a `decision` bead:
  LOAD `skill://orchestrate-with-bd/references/decisions.md`.
- Adopt beads that already exist under the epic. NOT Build a parallel DAG beside them.

When the domain is unfamiliar or the DAG does not exist, dispatch `orc-planner`. It creates
the beads and returns their ids. Otherwise write them yourself.

## Plan mode

A plan-mode plan for a run has a `## Beads` section. It lists the epic id and every task
bead the plan implements, one per line as `<bead-id> <title>`. Before adding a step without
a bead, create the bead. A plan whose steps outnumber its beads is not approved work.

```markdown
## Beads
- repo-pih            Epic: interactive browser fixture
- repo-pih.1          Add the click harness
- repo-pih.2          Record the network log
```

## Dispatch

1. `orc_status` → rewrite the `todo` list from `orc_status.todo`.
2. One `task` call per wave: every bead with no open dependency, in one array. Each brief
   names the bead id, the agent's role, and nothing the bead already says.
3. Implementers and epic leads `isolated: true`; every other role without it.
4. After the wave, read each `orc_finish` comment on its bead.
5. If a review bead exists, its verdict comes first and the merge second.
6. Merge accepted branches into your tree. OMP names a captured branch
   `omp/task/<agent-name>` after the name you gave the `task` call. To make the branch name
   carry the bead id, name the call `Impl_<bead-id>`.
7. `orc_status` again and redraw the `todo` list.
8. A `changes` verdict from a reviewer becomes a new task bead under the same epic naming
   the findings. Dispatch it in the next wave.

## The `todo` list

The `todo` list is a per-turn view of `orc_status`. Every entry is `<bead-id> <title>`
copied from `orc_status.todo`. The plugin's `todo_reminder` handler names any entry whose
first token is not a bead id in the bound run. On that advisory, re-read `orc_status` and
rewrite the list. `todo done` redraws the view; `orc_finish` changes the state.
