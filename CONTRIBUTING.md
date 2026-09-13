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

Python is a contributor tool only. The plugin ships no Python: every runtime script is
TypeScript that `bun` runs, and `skills/orchestrate/scripts/worktree-sweep.ts` is tested by
`bun test` like the rest. CI's `py` job runs the prose gate and its regression suite alone,
through `uvx`, because `slopvac` is a Python package.

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
skill, and nothing else.

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
`preflightSettings`) compares the effective values of the six required `task` and `bash`
settings against the overlay and warns once when the optional `modelRoles.reviewer` is
unset. It reports deviations through a `WARN settings` message in the lead transcript and
a comment on the run epic. It never creates or rewrites project configuration. The
required values ship in `config/orchestrate.overlay.yml`.

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

The extension registers a single `tool_call` handler with ten numbered checks. They catch
protocol mistakes. They cannot enforce transactional isolation.

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
  Git work is proven on origin, the one store that outlives a worker's clone. An implementer's `REPORTED` must carry `pushed=<ref>@<sha>`; G4 runs `git ls-remote origin refs/heads/<ref>` and refuses unless that ref is at `head_sha`. An architect's yield or park is refused unless `refs/heads/<metadata.branch>` is at its `head_sha` and the epic is released. A missing ref, another commit, or an origin that does not answer all refuse: the refusal says `origin unreachable; retry git push and REPORTED, the worker stays alive until proven`. When the proof holds, G4 stamps `metadata.pushed_sha` with the observed commit before the yield proceeds.
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
  - a role started as a nested `omp` process (moved to G10, which refuses it)
- **G7 (`bash`):** within a marked run it refuses:
  - `git push` to the run's primary branch (`metadata.primary_branch` on the run epic, `main` when unset): named as a destination, deleted, or pushed bare from a checkout on that branch. G7 reads that checkout's branch with `git symbolic-ref`, at the directory a `-C` names
  - a bare push, a `HEAD` destination, or a `<src>:` with no destination, once the line runs `cd` or `pushd` or the push carries `--git-dir` or `--work-tree`. G7 cannot read the branch git pushes from there. The refusal names the explicit form, `git -C <dir> push origin <src>:<dst>`
  - `git push --force`, `-f`, `--force-with-lease`, or a `+refspec`, to any branch
  - `git push --all`, `--branches`, or `--mirror`
  - a destination the shell fills in: a variable other than `$ORC_PUSH_REF`, a substitution, or a glob. `$ORC_PUSH_REF` is resolved from the call's `env` only, where G6 sets it to the session's capture ref (`omp/task/<id>`); the command text is never read
  - `wt switch --create` from every session but the lead. Worktrunk is the operator's: a role works in the isolated clone it was spawned into, a helper in the tree it was given

  The lead's own `git push` never reaches G7: G9 refuses it first. A push to `omp/task/<id>`, to `HEAD:$ORC_PUSH_REF`, to a branch the session made, or to any other branch by name passes. A detached or unreadable `HEAD` refuses nothing. An unreadable run epic means `main`.
- **G8 (every tool, notice):** in a worker session, compares the agent's `ORC-ROLE` and live model against the core contract once. On a mismatch it sends one notice naming the expected model, the live model, and the parking commands. G8 accepts a model that OMP moved the session onto through retry fallback. When G8 cannot read the model, it logs the cause and stays silent.
- **G9 (`bash`, `edit`, `write`):** the lead plans and never edits or merges. From the lead of an active run it refuses `git commit`, `git push`, `gh pr merge`, `gh pr ready`, and an `edit` or `write` of a product file (any file inside a git working tree, except under `.orchestration/`). Every refusal names the recovery: spawn `orc-architect` with the run id.
- **G10 (`bash`):** agents are subagents, and credentials never enter a transcript. Within a marked run, from every seat, it refuses an `omp` launch (bare, by path, through `bunx`, `bun x`, `npx`, or `mise exec ... --`; `omp --version` and `omp --help` pass), a credential helper (`isengardcli credentials`, `aws sts`, `aws configure export-credentials`, `aws configure ... credential_process`), and a credential print (a read of `~/.aws/credentials`, a bare `printenv` or `env`, `printenv` of an `AWS_*` secret, an expansion of one). The `task` gate beside it refuses an `orc-architect` or `orc-implementer` spawned without `isolated: true`.

### Spelling and scan bounds

- **Role marker.** `orcRole` reads `ORC-ROLE:` from the system-prompt element OMP builds for the spawned agent, the one that opens with `§ Role`. A marker in a repository context file (`CLAUDE.md`, `.cursor/rules`) sets no role, whichever side of the agent body OMP renders it on. A prompt without that element is scanned whole. `test/identity.test.ts` pins the heading against the installed template.
- **Program spelling.** The shell parser folds the program word's basename to lower case before every lookup: `bd`, `env`, the runner prefixes, the wrapper shells, `eval`, and the `git`/`gh` head. APFS and NTFS resolve `PATH` case-insensitively, so `BD update` runs bd there. Subcommands and flags keep their case.
- **Path spelling.** G2 compares paths in the filesystem's own spelling. After the component walk, the longest existing prefix of a cwd or target passes through `fs.realpath`. On a case-insensitive volume `SRC/new.ts` compares as `src/new.ts`; on a case-sensitive volume it stays a distinct path. There is no platform branch.
- **Command parsing.** Structured gates inspect parsed command slots and bounded argument arrays, so quoted mentions are ignored and malformed input fails closed or remains advisory as documented by the gate tests.

## Rules

The plugin's deterministic protocol checks are structured notices in the run-aware extension gate.
The gate parses command slots, so quoted mentions are ignored, and it runs only while a
valid active-run marker is present. Keep deterministic protocol checks in the gate rather
than adding session-wide regex rules.
