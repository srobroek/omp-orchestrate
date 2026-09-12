---
description: "a role launched as a nested omp process instead of a task subagent"
condition:
  - "\"application\"\\s*:\\s*\"omp\""
  - "\"args\"\\s*:\\s*\\[[^\\]]*\"(?:[^\"]*\\s)?omp(?:\\s|\")"
scope: "tool:hub"
interruptMode: "never"
---

Roles in an orchestrate run are spawned with `task` (or `agent()` in eval), never as a
nested `omp` process through `hub start` or a shell. A nested process has no parent
link: it does not inherit `BEADS_ACTOR`, its claims are dead claims, its receipts never
reach the wave barrier, and stopping and restarting it only replays the same failure.
One profiled run spent 27 of its 40 minutes in `hub start`/`wait`/`stop` cycles on
nested `omp` processes after its `task` workers were cancelled.

Recover instead:

1. Read the cancelled worker's transcript (`history://<name>`) for the refusal it hit
   (`BEADS_ACTOR` unset, a scope conflict from the friction guard, a missing tool).
2. Fix the cause on the bead (disjoint `metadata.scope`, the routing envelope, the
   actor export) and re-dispatch with `task` and `isolated: true`.
3. When the cause is outside the run, write the escalation wisp and stop the wave.

Both conditions read the `hub start` arguments. The shell form (`omp -p`, `--print`,
`--cwd`, `--session-dir` from `bash`) is a G6 notice in `src/gates/bd.ts`: a rule cannot
see whether a run is active, and this one fired on `omp -p` probes in sessions no run
ever touched. The notice inherits G6's run gate and exempts
`--config <plugin-root>/config/orchestrate.overlay.yml`, the lead's rooted re-entry
documented in `planning.md`.
