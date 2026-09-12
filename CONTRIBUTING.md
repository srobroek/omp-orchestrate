# Contributing to omp-orchestrate

This document is for people changing the plugin. Operators read [README.md](README.md).

## Development

Before `bun run typecheck` or `bun test`, run `bun install --frozen-lockfile`. After every
pull that changes `bun.lock`, run it again. The lockfile pins the `@oh-my-pi/pi-coding-agent`
release the source compiles against. A `node_modules` left over from an older release fails
in two places: missing-export errors in `src/agent-preflight.ts` and `src/gates/worktree.ts`,
and a missing `pi-natives` export in `test/wiring.test.ts`. CI installs fresh, so it stays
green.

Install for development with `omp plugin link /path/to/omp-orchestrate`. Then restart the
session: OMP loads a new extension module at startup only.

Development checkouts need the agnix hook. In each checkout, run
`./scripts/install-agnix-hooks.sh`. It preserves an existing hook path and validates staged
instruction files. Git does not install tracked hooks automatically. The hook needs `agnix`
(`cargo install agnix-cli --version 0.52.2`) and `python3`.

Prose under `README.md` and `skills/orchestrate/SKILL.md` passes the prose gate in CI:
`uvx --from slopvac==1.0.1 python scripts/prose-gate.py <files> --profile normal`. Errors
fail the job. The job reports the score without failing on it.

release-please generates `CHANGELOG.md` from conventional-commit subjects. Do not edit it by
hand.

## Architecture

### Run scope

Every check runs only inside a run scope (`src/run-scope.ts`). A session is inside a run
scope when one of these holds:

- a valid active-run marker `.orchestration/.active-run` exists in its checkout.
  `/orchestrate-start` writes it and `/orchestrate-stop` removes it
- its checkout is an isolated copy, which carries the primary's marker
- its checkout is a linked git worktree of a primary that holds the marker; the plugin asks
  `git rev-parse --git-common-dir` once per directory

An `ORC-ROLE` declaration, a claim made by hand, and an observed claim create no scope.
Outside a run scope the plugin spawns no process beyond that one `git` query and writes no
file. It sends no message and refuses no tool call. A plain session in a repository that
has this plugin installed sees the slash commands, the `orc_*` tools, the agents, the
skill and three rules, and nothing else.

The marker is JSON: `schema_version`, `run_id`, `beads_dir`, `session_id`
(`src/run-state.ts`). A writer holds the sibling lock `.orchestration/.active-run.lock`
from its read to its rename, so readers see atomic snapshots. `ORCHESTRATE_MARKER_FILE`
overrides the marker path.

### Lead lease

The lead session holds a lease on the run epic: the epic's `assignee` is `lead:<session id>`
and `metadata.lease_until` is `now + TTL` (`src/lease.ts`, TTL `ORC_LEASE_TTL_MS`, default
15 min; renewal `ORC_LEASE_RENEW_MS`, default 5 min). The claim fence guards every write:
`bd update <epic> --actor <lead> --claim`, so only the holder extends it and a release loses
to a successor's claim. `adoptRun` takes over a lapsed lease in two fenced steps: release as
the old lead, then claim as the new one; two adopters racing a lapsed lease produce one lead.
Worker claims carry the same lease, renewed on tool activity.

### Run database

`/orchestrate-start` asks `bd where --json` once and records the run's `.beads` in the
marker as `beads_dir` (`src/beads-mode.ts`). At a worker's first `session_start`, the plugin
finds the isolated copy's own `.beads/embeddeddolt`, writes a `.beads/redirect` naming the
run's directory, and removes the copied store (`src/clone-adopt.ts`). Every `bd` call from
the copy, `bd -C` included, reaches the run's database. A copy whose target does not exist
fails closed: `bd` refuses its calls. The plugin exports nothing into the environment, so
`bd` elsewhere touches only that directory's store. Diagnose a copy with `bd where --json`:
`redirected_from` names the copy.

`src/store-probe.ts` reports a run's store as `free`, `locked` (with the holder),
`corrupted` (with the journal error) or `slow`. It opens `noms/LOCK` read-only, takes a
non-blocking `flock`, and runs one read. The plugin never starts, stops, or kills a Dolt
server and never touches `noms/LOCK`; a `corrupted` store is the operator's `dolt fsck`.

### Agents

| Agent | Role | Edits code | May spawn |
| --- | --- | --- | --- |
| `orc-architect` | `@plan` | yes | the other four, plus seven borrowed helpers |
| `orc-implementer` | `@task` | yes | `scout`, `operator` |
| `orc-shepherd` | `@task` | no | nothing |
| `orc-reviewer` | `@reviewer` | no | `scout` |
| `orc-researcher` | `@smol` | no | nothing |

Only the architect may spawn a role that claims a bead. A worker may spawn helpers instead.
A helper claims no bead, makes no commit, and manages no worktree. The architect holds the
feature branch, so it is the one agent that outlives a single bead.

Use scout for routine factual collection and researcher for unresolved research or
design/debug questions that need durable evidence.

OMP enforces child-spawn names and recursion depth for both task and eval calls. Tool lists
are not sandboxes: runtime-added tools and Bash can permit mutation. Reviewer and researcher
code-edit restrictions remain behavioral contracts.

The optional `pr-reviewer` checks PR-wide risks. It does not replace `orc-reviewer`'s
required bead verdict or authorize a merge. When no separate PR risk needs review, skip it.

Per-spawn `effort` selects the lowest (`lo`), middle (`med`) or highest (`hi`) supported
thinking level. With only low and medium available, both `lo` and `med` select low; `hi`
selects medium. It never requests an unsupported literal high.

`test/declared-surface.json` names the helper agents that come from other packages, the
model roles beyond OMP's built-ins, and the roles allowed a `spawns:` allowlist.
`test/agents.test.ts` asserts the file and the agent definitions agree in both directions.

Agent discovery preflight reports missing core roles, incorrect role markers and unresolved
model aliases. When a task requests an optional helper, preflight checks it. When a
definition path resolves, the warning names it.

### Settings preflight

At start and before each wave, the settings preflight (`src/watchers.ts`,
`preflightSettings`) compares the effective values of the six `task` and `bash` settings and
`modelRoles.reviewer` against the required values. It reports deviations through a
`WARN settings` message in the lead transcript and a comment on the run epic. It never
creates or rewrites project configuration. The required values ship in
`config/orchestrate.overlay.yml`.

If the backgrounding setting is unavailable or incorrect, the observer cannot reliably
adopt claims. A warning neither establishes a claim nor makes dispatch safe.

### Landing

The plugin lands approved PRs; no agent merges (`src/landing.ts`). `/orchestrate-start`
runs one `gh api graphql` read for `autoMergeAllowed`, `squashMergeAllowed`, branch
protection, rulesets and the merge queue, and records the result on the run epic as
`metadata.landing`. Mode `auto` requires auto-merge and at least one required check; every
other repository, this one included, is `direct`. The mode is re-derived from the recorded
flags on every read, never trusted from the record.

Every 60 s the lead session reads the open, unblocked `pr:merge` beads and polls their PRs
with one `gh pr list` per repository:

- The sweep merges a `CLEAN` PR at the reviewed `head_sha` with `gh pr merge --squash
  --match-head-commit <head>`. In `auto` mode it adds `--auto` and GitHub waits for the
  required checks.
- A `DIRTY` or `BEHIND` PR gets a `git merge-tree` precheck in a throwaway bare clone. The
  sweep commits a clean merge and fast-forward pushes it to the PR branch. Conflicts become a fix
  bead under the origin feature (`role=implementer`, or `role=architect` when a conflicting
  path leaves the origin's scope) that blocks the merge bead.
- A failing check is rerun once per head with `gh run rerun --failed`, then becomes a fix
  bead.

The sweep writes `LANDED <sha>` or `BOUNCED reason=<cause>` on the merge bead and its
origin, never uses `--admin`, and never force-pushes. The shepherd agent keeps one duty:
turning an actionable review-bot round into a fix bead under `orc_review_round_policy`.

## Gates

The extension registers a single `tool_call` handler with six numbered checks, one runtime
database check, and one assignment notice. They catch protocol mistakes. They cannot
enforce transactional isolation.

Every refusal rests on evidence. When `bd` cannot answer, the check that needed it logs the
cause and lets the call run. A check refuses only what it read and can prove:

- a bead assigned to another actor
- a queue that is not yours
- a scope that overlaps a live node

- **G1 (`bash`):** For a generic helper without an ORC contract, G1 sets `BD_READONLY=1` when the session checkout holds a valid active-run marker. A missing or invalid marker fails open. Contract-bound `orc-*` roles and unrelated processes remain writable.
- **G2 (`bash`, `edit`, `write`):** refuses a mutation outside the worktree named by the claimed bead, or outside its `metadata.scope` globs. For `bash`, G2 compares the cwd only. G2 reads the claimed bead and nothing else. G5 judges scope overlap between claims, at claim. G2 refuses a mutation when the bead is readable and assigned to another actor, or closed. A released bead refuses nothing, so a worker bounced after its release can repair its evidence. When G2 cannot read the bead, it logs the cause and lets the call run. A bead you closed yourself ends the claim: the next product edit or comment passes and the gate disarms. To recover a closed bead, run `bd reopen <id>`. Then run `bd update <id> --claim --json`. To hand a reopened bead back, run `bd update <id> --assignee ""`.
- **G3 (`bash`):** blocks mutating `git worktree` commands and `gh pr checkout` because they bypass Worktrunk.
  Inspection remains allowed.
- **G4 (`yield`):** refuses exits when workers do not meet their contracts.
  A worker with a role but no claim receives one refusal.
  This refusal does not repeat, so revived sessions can exit.
- **G5 (`bash`):** judges claims and the writes that shape them. It refuses:
  - a queue pull that names no role, or another role's queue
  - a named claim of a bead routed to another role
  - a claim naming two beads: one activation owns one bead
  - a second claim while the bead you hold is still in progress
  - a claim whose scope overlaps a held code-writing claim outside its own lineage
  - a claim while held code-writing claims reach the run epic's `metadata.max_inflight` (default 8). The refusal says `run at capacity (N/N); retry`
  - a claim that merges stderr into stdout, or redirects stdout away. The observer reads the claim report from stdout
  - any claim from a role-less session under a marked run: the lead dispatches and never claims
  - a routing re-point (`metadata.role`) by any role but the architect
  - an architect's `scope` that overlaps an open or in-progress node outside the bead's own lineage
  - review and reporting states authored by shepherds
- **G6 (`bash`):** within a marked run, it refuses two things and warns about four. It refuses:
  - `bd dolt push|pull|fetch|clone|sync` from any spawned session. Sync is the lead's barrier step: `bd dolt commit`, then `bd dolt push`, once, after every agent has yielded. The `bd` router runs those verbs in a container whose lock the host never sees, so a worker's sync is a second engine on the run's journal (`.config/wt.toml` explains the incident and skips its own hook syncs during a run)
  - `--db <path>` or `BEADS_DB` on any `bd` call, from any seat: the run's database is the one bd resolves

  It warns about:
  - writes without actors: the identity is the assignee your claim report printed
  - comments without protocol verbs
  - bug beads unreachable from queues
  - a role started as a nested `omp` process: `omp -p`, `--print`, `--prompt`, `--cwd`, `--agent` or `--session-dir` from a shell. `--config` on the same command exempts it
- **G8 (every tool, notice):** in a worker session, compares the agent's `ORC-ROLE` and live model against the core contract once. On a mismatch it sends one notice naming the expected model, the live model, and the parking commands. G8 accepts a model that OMP moved the session onto through retry fallback. When G8 cannot read the model, it logs the cause and stays silent.

## Rules

Three TTSR rules in `rules/` watch tool arguments as the model streams them and inject a
reminder on a protocol slip. None is a security boundary.

The host matches the raw tool-argument JSON as the model streams it
(`session/ttsr-coordinator.ts`, `export/ttsr.ts` in the pinned `@oh-my-pi/pi-coding-agent`).
Consequences for rule authors:

- Each `toolcall_delta` appends the provider's `partial_json` to a per-call buffer. Every condition runs against the whole buffer again.
- Only `edit` and `write` expose a `matcherDigest` with the file content. `bash`, `eval`, `task`, and `hub` match the argument JSON itself.
- A bash rule therefore sees `{"command":"bd ready …"}`. `bd` follows `"`. A shell newline is the two characters `\n`. A quote is `\"`. `^` never precedes a command.
- Anchor on `\b` or on the `\n`/`\t` escape. "Same line" ends at the next `\n` escape or the closing `"`.

`interruptMode` sets the cost of a match. `never` lets the call run and folds the rule text
into its result. `tool-only` aborts the assistant message, discards it, injects the rule,
and continues. In both modes a rule fires one time per session (`repeatMode: once`).

The `bd ready` rules and `orc-no-nested-omp` use `never`, because the flagged command is
harmless (an empty queue, a doomed process) and the reminder arrives with the result.
`orc-no-nested-omp` reads `hub start` arguments only. The shell form (`omp -p` from `bash`)
is a G6 notice, so it fires only inside a run scope.

The host has a separate regex engine. Python accepting a pattern does not prove the host
accepts it. After editing a rule, run `sh scripts/validate-rules.sh`. It feeds
`omp ttsr test` the shape the host matches: bash snippets wrapped as `{"command":"…"}`,
`task` and `hub` argument objects verbatim. This local check needs an installed `omp`, so CI
does not run it.
