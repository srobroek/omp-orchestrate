# Testing orchestrate-with-bd

Contributor reference: how each behaviour of the plugin is exercised end to end, and what each
run showed. Every scenario is a headless OMP session against a disposable fixture on the
shared Dolt server, except the server-outage scenario, which uses a per-project server so it
can be frozen. Most prompts name the epic plus the scenario's own steering (the failure to
provoke, the helper to use); the run header and the skill are the plugin steering under test.

## Harness

### Fixture

```sh
mkdir -p /tmp/orc-e2e/<name>/repo && cd /tmp/orc-e2e/<name>/repo && git init -q -b main
printf '{"name":"calc","type":"module","private":true}\n' > package.json
mkdir src && printf 'export function add(a: number, b: number): number {\n\treturn a + b;\n}\n' > src/calc.ts
printf 'import { expect, test } from "bun:test";\nimport { add } from "./calc";\ntest("add", () => expect(add(2, 3)).toBe(5));\n' > src/calc.test.ts
printf 'node_modules/\n' > .gitignore && git add -A && git commit -q -m init
env -u BEADS_DIR BEADS_ACTOR=omp/e2e-setup bd init --shared-server --skip-hooks --skip-agents --prefix e2e$(openssl rand -hex 2)
rm -f .beads/dolt-backup*.json
printf 'interactions.jsonl\n' >> .beads/.gitignore && git rm -q --cached .beads/interactions.jsonl
git add -A && git commit -q -m "beads: shared server"
```

Create beads with `env -u BEADS_DIR BEADS_ACTOR=omp/e2e-setup bd create ... --json`. A task bead
carries `--metadata '{"role":"implementer"}'` (or `reviewer`, `researcher`, `shepherd`) and a
description with a file scope and numbered acceptance criteria. A review bead depends on its
task: `bd dep add <review> <task>`. Epic order is `bd dep add <epic-B> <epic-A>`; a decision
gates an epic through its tasks (`bd dep add <task> <decision>`), because bd 1.2.2 refuses
epic-to-decision and task-to-epic edges.

### Session

```sh
cd /tmp/orc-e2e/<name>/repo
env -u BEADS_DIR omp -p "orchestrate epic <id>: finish every task under it." \
  --session-dir /tmp/orc-e2e/<name>/session </dev/null > /tmp/orc-e2e/<name>/stdout.txt 2>&1 &
```

- `</dev/null` is required: with an open non-TTY stdin, `omp -p` waits for piped input forever.
- Per-session settings go in `--config <overlay.yml>` (for example `task:\n  maxConcurrency: 2`).
- To test an unreleased build, add `extensions:\n  - <worktree>/src/index.ts` to the overlay
  and pass `--plugin-dir <worktree>` so the skill and agents come from the same tree.
- Never set `BEADS_DIR` yourself; the `beads` plugin pins it on bash calls, and that names the
  same server database.

### Reading a transcript

| What | Where |
| --- | --- |
| Root transcript | `<session-dir>/*.jsonl` |
| Child agents | `<session-dir>/<id>/<AgentName>.jsonl`; helpers nest one level deeper |
| Run header | `{"type":"custom_message","customType":"orc-run-header"}` |
| Dispatches | assistant `content[].type == "toolCall"`, `name == "task"`, `arguments.tasks[]` (`agent`, `isolated`, `name`) |
| Ledger calls | `toolResult` entries with `toolName == "write"`; `orc_status` text starts `orc_status <epic> (<status>, <shape>): N beads, N open, N ready` |
| Wave shape | one `task` call per `orc_status` whose `ready` lists several beads |
| Captured branches | `git branch --list 'omp/*'` in the fixture; named `omp/task/<agent-name>` |

### Cleanup

`dolt --host 127.0.0.1 --port 3308 --user root --password '' --no-tls sql -q "DROP DATABASE <prefix>"`.
Never stop the shared server; another project's run may be writing to it.

## Scenarios

Each row names its setup (the DAG where one applies), the prompt, and what the transcript must
show. "Observed" columns record the 2026-09-14 runs on 0.4.2 to 0.4.10.

### Single tier

| Scenario | DAG | Prompt | Expect | Observed |
| --- | --- | --- | --- | --- |
| Independent wave | epic; 3 implementer tasks; 1 review bead depending on all three | `orchestrate epic E: finish every task under it, including the review, then close the epic.` | one `task` call with 3 implementers; 3 merges; 1 reviewer; epic closed | WORKS |
| Review fan-out | epic; 3 tasks; 3 review beads, one per task | same | one call ×3 implementers; 3 merges; one call ×3 reviewers under distinct actors | WORKS |
| Wide wave under a cap | epic; 10 tasks; 10 review beads; overlay `task.maxConcurrency: 4` | same | one call with 10 items; child starts staggered by 4; one call with 10 reviewers | WORKS |
| Bounce into the next wave | T1, T2, T3 (T3 depends on T1); R1 with a criterion T1 lacks; R2 | `...including reviews; act on every verdict.` | `[T1,T2]` → merge → `[R1,R2,T3]` → R1 `changes` → fix bead in the next `ready` → re-review → close | WORKS |
| Blocked task | task whose criteria need a file outside its scope that does not exist | `finish every task under it.` | implementer `orc_finish blocked`; bead `blocked` with a `blocked: ...` comment; epic finished `blocked` (bd refuses to close over a blocked child) | WORKS |
| Claim race | one task; prompt asks for two implementers on the same bead | explicit prompt | one `claimed: true`; the other `not claimed, held by <actor>` | WORKS |
| Rebind refusal | bound fixture | `Call orc_status with epic "<other>"` | `run already bound to <epic>` | WORKS |
| Truncation | epic with 520 tasks | `Call orc_status with epic BIG` | `500 beads ... (truncated)`; `ready` withheld | WORKS |
| Server outage | per-project server (`bd init --server`, never port 3308); `kill -STOP` the server mid-wave | `finish every task under it.` | every write fails closed with `i/o timeout` within seconds; no false success; run recovers after `kill -CONT` | WORKS |
| Security review | task that executes user input in a shell; review bead saying so | `...act on every verdict...` | reviewer dispatches `security-reviewer`; exploitable finding → `changes` → fix bead → re-review → close | INCOMPLETE: `security-reviewer` dispatched on every security-relevant diff and its CWE-78 verdict drove the first bounce (WORKS); the run was stopped at 67 min and 15 beads because the reviewer then judged each fix against defects the bead never named, and every worker brief told the implementer to skip tests. Both fixed in the agents (0.4.9); rerun pending |

### Store guards

| Scenario | Setup | Prompt | Expect | Observed |
| --- | --- | --- | --- | --- |
| Embedded store | second repo with `bd init` (no server carrier: unset `BEADS_DOLT_SHARED_SERVER`, move `~/.config/bd/config.yaml` aside during init) | `orchestrate epic <id>: finish every task under it.` | STOP-only header; one sentence to the human; zero tool calls | FAIL on 0.4.5; WORKS on 0.4.6 (gate) |
| Missing store | `git clone` the fixture, `rm -rf .beads` | `orchestrate: report the store line of your run header and stop.` | `store: no .beads/metadata.json`; STOP; no `bd init` | WORKS |
| `bd init` gate (beads plugin) | empty dir | `Run exactly: bd init --skip-hooks ...` | refused with the mode text; `cd sub && bd init --shared-server --prefix <existing>` refused as a collision | WORKS |
| Model-role preflight | server-mode fixture; `--config` overlay with `modelRoles.slow: nonexistent-provider/no-such-model` | `orchestrate epic <id>: finish everything under it and close it.` | STOP header naming `@slow (orc-implementer-max, orc-reviewer)` and `modelRoles.slow`; one sentence to the human; zero tool calls | WORKS (0.4.9) |

### Planner and roles

| Scenario | DAG | Prompt | Expect | Observed |
| --- | --- | --- | --- | --- |
| Planner from an empty epic | epic with only a decision bead | `...no task beads exist yet. Plan it: <units>, where <one> needs a research answer first, then finish every task including reviews.` | `orc-planner` first (not isolated, spawns nothing); tasks with role metadata and per-task review beads; research bead; dependency on it | WORKS |
| Mixed-role wave | as above | as above | first wave carries researcher and implementers in one call; the dependent task waits; answer lands as a bead comment | WORKS |
| Implementer helpers | task spanning many files: "first dispatch `scout` to list call sites, then `operator` for the rename, quote both receipts" | `finish every task under it.` | implementer spawns `scout`, then `operator`; receipts in the `orc_finish` comment | WORKS (operator after malformed retries) |
| Reviewer helper | review bead: "confirm by dispatching `scout` to grep for `X`" | same | reviewer spawns `scout`; receipt quoted | WORKS |
| Implementer tiers | two tasks, `metadata.tier` `basic` and `deep`, one review bead depending on both | `finish everything under it, integrate into main, and close the run epic.` | `orc_status.wave` names `orc-implementer` and `orc-implementer-deep`; the child transcripts show those agents ran; reviewer over the merged diff | FAIL then WORKS on 0.4.9: the first run dispatched `orc-implementer` for the deep bead despite the wave (see defects); with the routing gate the deep child ran `orc-implementer-deep` |
| Shepherd (simulated bots) | PR bead with `pr`, `head_sha`, `bot_review_requests`; a `gh` shim first on `PATH` answering canned JSON per a `SCENARIO` file | `shepherd the PR bead, act on the outcome...` | actionable → policy `bounce` → fix bead with thread URLs → implementer → re-probe clean → closed; pending → request posted → `blocked` naming the provider | WORKS WITH DEVIATIONS (shim) |

### Three tier

| Scenario | DAG | Prompt | Expect | Observed |
| --- | --- | --- | --- | --- |
| Two child epics | run epic; decision; 2 child epics × 2 tasks; cross-epic review task under the run epic | `orchestrate epic R: it has two child epics and a cross-epic review; finish everything under it, integrate into main, and close the run epic.` | one call ×2 `orc-lead` isolated. Each lead binds its epic without touching `.orchestration/.active-run`. Epic branches merged at the root. `ready` turns to the cross-epic review only after both epics close. Run closed. | WORKS on 0.4.8 |
| Sub-lead waves under a cap | child epics × 3 tasks × 3 review beads; overlay `task.maxConcurrency: 2` | same | each sub-lead: one 3-item implementer call → 3 merges → one 3-item review call | WORKS |
| Empty child epic | one child epic with no tasks | `...one is empty and needs planning...` | that sub-lead dispatches `orc-planner`, then waves | WORKS |
| Conflicting epics | both epics edit one file | same | conflict at the root; root resolves in its own tree | WORKS |
| Epic closed over open children | any | any | `orc_finish done` on the epic refused, ids listed | WORKS (unit); no refusal needed live once leads waited |

### Not exercised

- `orc-shepherd` against real review bots.
- A security-review chain that converges: the one run was stopped (see the row above). The
  0.4.9 reviewer-scope and acceptance-check fixes came from it, but no rerun has been made as
  of 0.4.10.

## Defects the matrix found

| Release | Defect | Fix |
| --- | --- | --- |
| 0.4.1 | `orc_finish blocked` always failed: `bd update` has no `--reason` | reason as a comment, then `--status blocked` |
| 0.4.1 | lead migrated an embedded store unasked | header says STOP |
| 0.4.6 | lead still migrated after reading the skill | STOP-only header; `tool_call` gate refuses every `bd`, `.beads/` write, and dispatch in that session |
| 0.4.3 | lead closed an epic over two open review beads | `orc_finish done` on an epic refuses while a descendant is open |
| 0.4.4 | terminal check blind past 500 descendants | refuse on a truncated walk; `ready` withheld |
| 0.4.4 | open root decision entered the review wave | final wave holds `task` beads only |
| 0.4.7 | sub-lead yielded an empty result; OMP captured no branch | `orc-lead` ends on the integrated tree and always returns its receipt |
| 0.4.7, 0.4.8 | sub-leads deleted the inherited locator by hand | a clone rebinds to a child epic of the inherited run; 0.4.8 reads `bd show`'s parent shape |
| 0.4.9 | every worker brief told the implementer to skip tests (copied from OMP's `task` guidance about suites), so criteria went unverified and fix beads multiplied | header, skill, lead, implementer: the bead's own checks always run; only repository-wide suites and formatters are the lead's |
| 0.4.9 | reviewer judged each fix against defects the bead never named, producing an unbounded review chain | reviewer: a defect outside the criteria is a note, not a verdict, unless it is an exploitable security finding |
| 0.4.9 | lead read a wave naming `orc-implementer-deep` and dispatched `orc-implementer` | `tool_call` on `task` routes each item that names one wave bead to that entry's `agent` and `isolated` |
| 0.4.9 | `orc-reviewer` named the custom alias `@reviewer`; on a machine without `modelRoles.reviewer` OMP runs it on the caller's model without notice | every shipped agent names a built-in role; the preflight resolves each alias through `ctx.models.resolve` and stops the session when one has no callable model |
