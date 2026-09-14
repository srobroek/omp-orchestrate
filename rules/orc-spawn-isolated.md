---
name: orc-spawn-isolated
description: Which orchestrate-with-bd agents are dispatched with isolated true.
---

Dispatch `orc-implementer` and `orc-lead` with `isolated: true`; each edits in its own
clone of the checkout and OMP captures the result as a branch. Dispatch `orc-planner`,
`orc-reviewer`, `orc-researcher`, and `orc-shepherd` without it; none of them edits product
code. Never create a worktree for an agent.
