---
description: "a role launched as a nested omp process instead of a task subagent"
condition:
  - "\"application\"\\s*:\\s*\"omp\""
  - "\"args\"\\s*:\\s*\\[[^\\]]{0,300}\"(?:[^\"]*\\s)?omp(?:\\s|\")"
scope: "tool:hub"
interruptMode: "never"
---

Roles in an orchestrate run are spawned with `task` and `isolated: true`, never as a nested
`omp` process. The enforcement is G10 (`src/gates/nested.ts`): inside a run it refuses every
`omp` launch from `bash`, bare, by path, through `bunx`, `bun x`, `npx` or `mise exec`, and
every credential helper or credential print. This rule is the `hub start` remainder, which
no `tool_call` gate sees: a reminder, not a boundary.

A nested process has no parent link: it does not inherit `BEADS_ACTOR`, its claims are dead
claims, and its receipts never reach the wave barrier. Recover with `task` instead: read the
cancelled worker's transcript (`history://<name>`) for the refusal it hit, fix the cause on
the bead, and re-dispatch `isolated: true`. When the cause is outside the run, write the
escalation wisp and stop the wave.

Both conditions read the `hub start` arguments. The second looks for an `omp` word in an
`args` element that opens within 300 characters of the array's `[`. Unbounded, every
`"args"` in a stream that never closed its array started a scan to the end of the buffer.
