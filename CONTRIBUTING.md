# Contributing to orchestrate-with-bd

This document is for people changing the plugin. Operators read [README.md](README.md).

## Development

Before `bun run typecheck` or `bun test`, run `bun install --frozen-lockfile`. After every
pull that changes `bun.lock`, run it again. The lockfile pins the `@oh-my-pi/pi-coding-agent`
release the source compiles against. CI installs fresh, so it stays green.

Install for development with `omp plugin link /path/to/orchestrate-with-bd`. Then restart the
session: OMP loads a new extension module at startup only.

Development checkouts need the agnix hook. In each checkout, run
`./scripts/install-agnix-hooks.sh`. It preserves an existing hook path and validates staged
instruction files. Git does not install tracked hooks automatically. The hook needs `agnix`
(`cargo install agnix-cli --version 0.52.2`) and `python3`.

Python is a contributor tool only. The plugin ships no Python. CI's `py` job runs the prose
gate and its regression suite alone, through `uvx`, because `slopvac` is a Python package.

Prose under `README.md` and `skills/orchestrate-with-bd/SKILL.md` passes the prose gate in
CI: `uvx --from slopvac==1.0.1 python scripts/prose-gate.py <files> --profile normal`. Errors
fail the job. The job reports the score without failing on it.

release-please generates `CHANGELOG.md` from conventional-commit subjects. Do not edit it by
hand.

## Architecture

`src/index.ts` is the single registration site: three event handlers and seven tools. The
plugin registers no slash command; its one `tool_call` handler adds an environment variable
to bash calls and blocks nothing.

| Module | Owns |
| --- | --- |
| `src/bd.ts` | spawning `bd` with `BD_JSON_ENVELOPE=1`, parsing the envelope, `bdShow`, `bdList` |
| `src/run.ts` | the locator `.orchestration/.active-run`: `{ "schema_version": 1, "run_id": "<epic>" }` |
| `src/keyword.ts` | OMP's `orchestrate` word boundary, with fenced and inline code masked |
| `src/dag.ts` | store mode from `.beads/metadata.json`; breadth-first `descendants` over `bd list --parent`; todo strings |
| `src/tools/ledger.ts` | `orc_claim`, `orc_finish`, `orc_status` |
| `src/tools/bot-review-*.ts`, `conflict-probe.ts`, `review-round-policy.ts` | the four review tools |

### Handlers

- `tool_call` on `bash` adds `BEADS_ACTOR=omp/<session id>` to the call's `env` unless the
  call names one. Subagents share one process, so a process-wide value would be
  last-session-wins. The ledger tools derive the same actor per call and read
  `.beads/metadata.json` per call; a `dolt_mode` other than `server`, or no store, makes
  them return the migration text without spawning `bd`.
- `before_agent_start` injects the run header (`customType: "orc-run-header"`) when the
  prompt contains the standalone lowercase word `orchestrate` outside code. The header names
  the store, the bound epic or the absence of one, the actor, and the lead contract.
- `todo_reminder` compares each `todo` entry's first token against the bead ids from the
  most recent `orc_status`. It sends one advisory user message naming the entries that match
  no bead. It blocks nothing and spawns nothing.

### Store

The plugin passes no store selector to `bd`: no `--db`, no redirect file, and it removes an
inherited `BEADS_DIR` from its own `bd` spawns (the `beads` plugin pins that variable
process-wide to the first session's checkout). `bd` resolves the shared Dolt server from the
tracked `.beads/metadata.json`, which every isolated clone carries. The ledger returns the
migration text on an embedded store because a clone would fork it.

### Agents

| Agent | Model | Isolated | Spawns |
| --- | --- | --- | --- |
| `orc-lead` | `@plan` | yes | planner, implementer, reviewer, researcher, shepherd, scout, operator |
| `orc-planner` | `@plan` | no | nothing |
| `orc-implementer` | `@task` | yes | `scout`, `operator` |
| `orc-reviewer` | `@reviewer` | no | `scout`, `security-reviewer` |
| `orc-researcher` | `@smol` | no | nothing |
| `orc-shepherd` | `@task` | no | nothing |

`orc-lead` omits itself from `spawns:`; OMP preflight refuses a name outside an explicit
list, so an epic lead cannot start another lead. Only the root session, which has no spawn
policy, dispatches epic leads.

## Tests

`bun test` runs `test/*.test.ts` with `test/preload.ts`. The preload moves the process into
an empty temporary directory and clears `BEADS_DIR`. Suites that need a repository path use
`import.meta.dir`. `test/index.test.ts` drives the extension factory with a recording stub
of `ExtensionAPI` and asserts the exact event and tool names it registers.
