---
description: "a role launched as a nested omp process instead of a task subagent"
condition:
  - "\"application\"\\s*:\\s*\"omp\""
  - "\"args\"\\s*:\\s*\\[[^\\]]*\"(?:[^\"]*\\s)?omp(?:\\s|\")"
  - "(?:^|[\"`;|&(]|\\\\[nt])(?:\\s|\\\\[nt])*(?:[A-Z_][A-Z0-9_]*=\\S*\\s+)*omp\\s+(?:-p\\b|--print\\b|--cwd\\b|--session-dir\\b)(?!(?:\\\\[^n]|[^\"\\\\\\n])*--config\\b)"
scope: "tool:hub, tool:bash"
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

Running `omp -p` from a shell is legitimate for probes and benchmarks that are not part
of the run (those do not claim beads) and for the lead's rooted re-entry documented in
`planning.md`, which carries `--config <run-overlay>` and is exempt from the shell
condition.

Conditions 1 and 2 read the `hub start` arguments. Condition 3 reads the streamed Bash
JSON (`{"command":"…"}`): `omp` at command position means after the opening `"`, a
shell separator, or the two-character `\n` escape, optionally behind `NAME=value`
prefixes; `--config` anywhere on the same escaped line exempts the command.
