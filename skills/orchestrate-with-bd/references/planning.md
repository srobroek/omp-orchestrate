# Planning

The DAG is the plan. A step with no bead is not work the run knows about.

## Shape

Two tiers by default: the lead dispatches workers directly and integrates their branches.

```
lead (root session, or orc-lead for one epic)
├─ orc-planner        writes the DAG, returns          not isolated
├─ orc-implementer    ready task beads per wave          isolated: true
├─ orc-reviewer       one review bead each, in review waves     not isolated
├─ orc-researcher     one question each                  not isolated
└─ orc-shepherd       one PR bead each                   not isolated
```

Three tiers for a multi-epic run. The root session dispatches one `orc-lead` per epic with
`isolated: true`. Each brief names its epic and contains the word `orchestrate`, so the epic
lead receives the same run header. Each epic lead runs the two-tier shape inside its clone.
OMP captures the lead's final tree as `omp/task/<lead-name>`, and the root merges those
branches. `maxRecursionDepth` is 2 for two tiers and 3 for three.

A cross-epic review is a review bead placed directly under the run epic. bd refuses a
task-to-epic dependency, so `orc_status.ready` gates it instead. While any child epic stays
open, `ready` holds epics. Once the leads close every child epic, `ready` holds the run
epic's own `task` beads. The root merges the epic branches first. Then it dispatches that
review wave over the run's `merge-base..HEAD` diff. A `decision` bead under the run epic is
never a wave item: the root closes it with `orc_finish` once the leads have read it.

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
- Every review bead depends on the task or tasks it reviews. One bead per task fans out to
  one reviewer each; one bead spanning the wave gives one reviewer. Both surface as one
  review wave when the tasks land.
- Epic order is an epic-to-epic dependency: `bd dep add <epic-B> <epic-A>`. bd 1.2.2 refuses
  an epic-to-decision dependency, so a decision gates an epic through its tasks:
  `bd dep add <task> <decision>` for each task that needs it.
- At the epic tier, `orc_status.ready` lists a child epic under three conditions. `bd ready`
  reports it unblocked. No lead has bound it (binding sets `in_progress`). At least one of
  its tasks is ready. An epic with no tasks stays in the wave; its lead plans it.
- `bd ready --parent <epic> --unassigned` is what `orc_status.ready` reads. A dependency is
  the only thing that keeps a task out of a wave.
- Independent tasks have no dependency between them.
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

1. `orc_status` → read `orc_status.ready` as the current wave and rewrite the `todo` list.
2. Dispatch every ready bead in one `task` call. State a reason when the call carries fewer
   items than `ready`.
3. When the wave lands, merge every captured `omp/task/<agent-name>` branch into your tree.
   Resolve conflicts there. When `.beads/interactions.jsonl` conflicts, keep both sides.
4. Run `orc_status` again. The review beads, which depend on the landed tasks, are now the
   `ready` wave.
5. Dispatch them in one `task` call, one `orc-reviewer` per review bead. Each reviewer judges
   its bead against the integrated `merge-base..HEAD` diff.
6. Turn every `changes` finding into a fix bead for the next wave.
7. Run `orc_status` again and redraw the `todo` list.

## The `todo` list

The `todo` list is a per-turn view of `orc_status`. Every entry is `<bead-id> <title>`
copied from `orc_status.todo`. The plugin's `todo_reminder` handler names any entry whose
first token is not a bead id in the bound run. On that advisory, re-read `orc_status` and
rewrite the list. `todo done` redraws the view; `orc_finish` changes the state.
