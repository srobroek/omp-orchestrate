# omp-orchestrate

This plugin coordinates agents in OMP. It stores work in
[Beads](https://github.com/gastownhall/beads) as three levels:

- A run epic contains one epic per feature.
- Each feature has an epic containing its tasks.
- Agents claim the next bead in their domain, work in isolated repository copies,
  and report through the graph. The extension checks each role's contract.

| | |
| --- | --- |
| Status | Prerelease. OMP reports the version it installs. |
| Requires | the tools and plugins under [Prerequisites](#prerequisites) |
| Install | `omp plugin marketplace add srobroek/omp-orchestrate` then `omp plugin install orchestrate@omp-orchestrate` |
| Install for development | `omp plugin link /path/to/omp-orchestrate` |

Development checkouts need the agnix hook. In each checkout, run
`./scripts/install-agnix-hooks.sh`. It preserves an existing hook path and validates staged
instruction files. Git does not install tracked hooks automatically.

After either command, restart the session. OMP loads a new extension module only at startup, so
`/reload-plugins` does not find it. Claude Code reads the same catalog from
`.claude-plugin/marketplace.json`.

## Prerequisites

Before the first run, put these on `PATH`:

| Tool | Version | Used by |
| --- | --- | --- |
| `bd` (Beads) | 1.2.x | every claim, comment, and status read. `bd` embeds the database, so no server runs |
| `wt` (Worktrunk) | current | architect feature worktrees. G3 refuses `git worktree` commands that bypass it |
| `gh` | current | `orc_conflict_probe`, the review probes, and the shepherd's merge |
| `git` | 2.x | every worktree, capture, and integration step |
| `python3` | 3.x | `scripts/worktree-sweep.sh` |
| `jq` | current | the close-out and stranded-bead queries in `beads-store.md` |

The architect and implementer may spawn seven helpers. `scout` and `security-reviewer`
ship with OMP. The other five come from three plugins in the `srobroek-omp` marketplace:

| Plugin | Agents |
| --- | --- |
| `build` | `operator` |
| `delivery` | `pr-reviewer` |
| `quality` | `adversarial-challenger`, `docs-guard`, `lint-guard` |

Two commands install them. `omp plugin marketplace add srobroek/omp-plugins` registers the
marketplace. `omp plugin install <plugin>@srobroek-omp` installs one plugin. When a spawn
names an agent that is not installed, the task fails with an unknown-agent error. Before
that, agent discovery preflight reports the missing helper.

## Agents

Agents select models through `modelRoles` in your configuration and inherit the
role's configured thinking level.

| Agent | Role | Edits code | May spawn |
| --- | --- | --- | --- |
| `orc-architect` | `@plan` | yes | the other four, plus seven borrowed helpers |
| `orc-implementer` | `@task` | yes | `scout`, `operator` |
| `orc-shepherd` | `@task` | no | nothing |
| `orc-reviewer` | `@reviewer` | no | `scout` |
| `orc-researcher` | `@smol` | no | nothing |

Only the architect may spawn a role that claims a bead. A worker may spawn helpers instead. A helper:

- claims no bead
- makes no commit
- manages no worktree

The architect holds the feature branch, so it is the one agent that outlives a single bead.

Use scout for routine factual collection and researcher for unresolved research or
design/debug questions that need durable evidence.

OMP enforces child-spawn names and recursion depth for both task and eval calls.
Tool lists are not sandboxes: runtime-added tools and Bash can permit mutation.
Reviewer and researcher code-edit restrictions remain behavioral contracts.

The optional `pr-reviewer` checks PR-wide risks. It does not replace `orc-reviewer`'s
required bead verdict or authorize a merge. When no separate PR risk needs review, skip it.

Per-spawn `effort` selects the lowest (`lo`), middle (`med`) or highest (`hi`)
supported thinking level. With only low and medium available, both `lo` and `med`
select low; `hi` selects medium. It never requests an unsupported literal high.

## Required configuration

The settings preflight runs at activation and before each wave. It checks these effective
values. OMP's defaults satisfy none of the six `task` and `bash` rows, so set each one.

| Setting | Required value | When it deviates |
| --- | --- | --- |
| `task.isolation.enabled` | `true` | workers share the architect's tree, so two claims can edit one file |
| `task.isolation.merge` | `branch` | commits replay as a patch, so no `omp/task/<id>` branch survives to integrate or to recover after a crash |
| `task.isolation.apply` | `false` | OMP merges child work into the spawning tree, so the architect never owns integration |
| `task.enableEffort` | `true` | OMP ignores the per-spawn effort, so every agent runs at the session default |
| `task.maxRecursionDepth` | `3` or more | a worker's helper sits at depth 3, so at the default `2` no worker can spawn one |
| `bash.autoBackground.enabled` | `false` | a slow claim can auto-background, so its result bypasses the observer and the claim is never adopted |
| `modelRoles.reviewer` | a model selector | the independent review role falls back to the session model or fails selection |

Isolation clones the whole checkout, `.beads/` included. A worker that discovers a
database by walking up from its cwd finds a private copy that no other agent reads.
`/orchestrate-run` records the run's `.beads` in the marker, and each copy is redirected to
it before its first turn (see Run database). The `apply: false` row keeps integration
with the architect, who cherry-picks each captured branch.

The extension reports deviations through `WARN settings` notices and a comment on
the bound epic. Preflight never creates or rewrites project configuration.

Agent discovery preflight reports missing core roles, incorrect role markers and
unresolved model aliases. When a task requests an optional helper, preflight checks it.
When a definition path resolves, the warning names it.

If `/agents` and task dispatch disagree, check the effective `extensions` roots.
With the `claude-plugins` source disabled, list the installed package root in `extensions`
so native discovery can load its agents. Files under `agents/` alone do not register them.

Choose one response:

- Fix the settings. Then restart.
- Explicitly accept the reported limitations.

If the backgrounding setting is unavailable or incorrect, the observer cannot reliably
bind claims. A warning neither establishes a claim nor makes dispatch safe.

## Gates

The extension registers a single `tool_call` handler with six numbered checks, one
runtime database check, and one assignment notice. They catch protocol mistakes. They
cannot enforce transactional isolation.

Every refusal rests on evidence. When `bd` cannot answer, the check that needed it logs
the cause and lets the call run. A check refuses only what it read and can prove:
- a bead assigned to another actor
- a queue that is not yours
- a scope that overlaps a live node

Every refusing check runs only under orchestration. A session is under orchestration when
it declares an `ORC-ROLE`, or when a valid active-run marker exists in its checkout. An
isolated copy carries the primary's marker. A plain session in a repository that merely
has this plugin installed sees no gate. A claim it makes by hand is never observed. G6 and
the contract injection require the marked run itself.

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
- **G6 (`bash`):** within a marked run, it refuses two things and warns about three. It refuses:
  - `bd dolt push|pull|fetch|clone|sync` from any spawned session. Sync is the lead's barrier step: `bd dolt commit`, then `bd dolt push`, once, after every agent has yielded. The `bd` router runs those verbs in a container whose lock the host never sees, so a worker's sync is a second engine on the run's journal (`.config/wt.toml` explains the incident and skips its own hook syncs during a run)
  - `--db <path>` or `BEADS_DB` on any `bd` call, from any seat: the run's database is the one bd resolves

  It warns about:
  - writes without actors: the identity is the assignee your claim report printed
  - comments without protocol verbs
  - bug beads unreachable from queues

  Store safety beyond the gate: `src/store-probe.ts` reports a run's store as `free`, `locked` (with the holder), `corrupted` (with the journal error) or `slow`. The plugin never starts, stops, or kills a Dolt server and never touches `noms/LOCK`; a `corrupted` store is the operator's `dolt fsck`.
- **G8 (every tool, notice):** in a worker session, compares the agent's `ORC-ROLE` and live model against the core contract once. On a mismatch it sends one notice naming the expected model, the live model, and the parking commands. G8 accepts a model that OMP moved the session onto through retry fallback. When G8 cannot read the model, it logs the cause and stays silent.

## Rules

Four TTSR rules in `rules/` watch tool arguments as the model streams them and inject a
reminder on a protocol slip. None is a security boundary.

The host matches the raw tool-argument JSON as the model streams it (`session/ttsr-coordinator.ts`,
`export/ttsr.ts` in the pinned `@oh-my-pi/pi-coding-agent`). Consequences for rule authors:

- Each `toolcall_delta` appends the provider's `partial_json` to a per-call buffer. Every condition runs against the whole buffer again.
- Only `edit` and `write` expose a `matcherDigest` with the file content. `bash`, `eval`, `task`, and `hub` match the argument JSON itself.
- A bash rule therefore sees `{"command":"bd ready …"}`. `bd` follows `"`. A shell newline is the two characters `\n`. A quote is `\"`. `^` never precedes a command.
- Anchor on `\b` or on the `\n`/`\t` escape. "Same line" ends at the next `\n` escape or the closing `"`.

`interruptMode` sets the cost of a match. `never` lets the call run and folds the rule
text into its result. `tool-only` aborts the assistant message, discards it, injects the
rule, and continues. In both modes a rule fires one time per session (`repeatMode: once`). The
`bd ready` rules and `orc-no-nested-omp` use `never`, because the flagged command is
harmless (an empty queue, a doomed process) and the reminder arrives with the result.

### Run database

`/orchestrate-run` asks `bd where` once and records the run's `.beads` in the marker as
`beads_dir`. At a worker's first `session_start`, an isolated copy holding its own
`.beads/embeddeddolt` gets a `.beads/redirect` naming that directory, and its copied store
is removed. Every `bd` call from the copy, `bd -C` included, then reaches the run's
database; a copy whose target is missing fails closed and its `bd` calls are refused.
Nothing is exported into the environment, so `bd` elsewhere touches only that directory's
store. Diagnose a copy with `bd where --json`: `redirected_from` names the copy.

The host has a separate regex engine. Python accepting a pattern does not prove the
host accepts it. After editing a rule, run `sh scripts/validate-rules.sh`. It feeds
`omp ttsr test` the shape the host matches: bash snippets wrapped as
`{"command":"…"}`, `task` and `hub` argument objects verbatim. This local check needs an
installed `omp`, so CI does not run it.

## Commands

Bootstrap a run in three steps, all in the lead session:

1. `/orchestrate-run`. It pins the database and writes a `pending` marker.
2. `bd create --type epic ...` with the run metadata that `beads-store.md` lists.
3. `/orchestrate-bind <epic>`. It stamps this session's lead lease on the epic. After this step, dispatch.

| Command | Does |
| --- | --- |
| `/orchestrate-run` | activates run enforcement in this repository: records the run's `.beads` from `bd where` and writes the marker `.orchestration/.active-run`, `pending` until bound |
| `/orchestrate-bind <epic>` | binds the marker to the run epic once `bd show` confirms that it is open, then stamps this session's lead lease (`lead_actor`, `lease_until`) on it. When the lease was not stamped, or another lead's lease is live, it warns |
| `/orchestrate-status` | shows the marker binding, the run epic's status or the reason its liveness check failed, and the lead lease |
| `/orchestrate-roster` | ready-queue depth per role, wisps included |
| `/orchestrate-close <epic> [--force]` | ends the run: removes the marker once it names `<epic>` and no bead beneath it, at any depth, is `in_progress`. `--force` skips that check. `/orchestrate-close pending` undoes an activation that never bound |

The pin lives in the OMP process environment. After a restart, a lead session that
finds the marker re-pins at start and reports a pin it cannot establish. Re-issue
`/orchestrate-run` to re-pin by hand. A marker left behind by a finished run keeps
injecting the protocol into every `orc-*` session in the repository. It also refuses
the next bind until `/orchestrate-close` removes it, together with the lock file
`.orchestration/.active-run.lock`.

## Development

Before `bun run typecheck` or `bun test`, run `bun install --frozen-lockfile`. After
every pull that changes `bun.lock`, run it again. The lockfile pins the
`@oh-my-pi/pi-coding-agent` release the source compiles against. A `node_modules` left
over from an older release fails in two places: missing-export errors in
`src/agent-preflight.ts` and `src/gates/worktree.ts`, and a missing `pi-natives` export in
`test/wiring.test.ts`. CI installs fresh, so it stays green.

## License

Apache-2.0 governs this repository. Read the full text in [LICENSE](LICENSE).
