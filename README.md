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
| `BEADS_DIR` | one absolute path to the run's `.beads` in every child | a worker's clone holds a private copy of `.beads/`, and its `bd` writes land there |

Isolation clones the whole checkout, `.beads/` included. A worker that discovers a
database by walking up from its cwd finds a private copy that no other agent reads.
`/orchestrate-run` pins the database, and every child inherits the pin. The `apply: false`
row keeps integration with the architect, who cherry-picks each captured branch.

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

The extension registers a single `tool_call` handler with seven numbered checks and one
runtime database check. They catch protocol mistakes. They cannot enforce transactional
isolation. G6 delivers notices. When evidence is unavailable, a bounded exit path can fail
open without accepting the work.

Every refusing check runs only under orchestration. A session is under orchestration when
it declares an `ORC-ROLE`, or when its process carries an absolute `BEADS_DIR` pin and a
valid active-run marker exists in the session checkout or beside that pin. A plain session
in a repository that merely has this plugin installed sees no gate. A claim it makes by
hand is never observed. G6 and the contract injection require the pinned run itself.

- **Runtime `BEADS_DIR` (`bash`):** refuses any command text that names `BEADS_DIR`, including inside quotes. The variable travels in the tool's `env` field, so a wrapper such as `env -S` cannot smuggle an override. A structured `env.BEADS_DIR` must identify the pinned database. The gate rewrites it to its canonical path.
- **G1 (`bash`):** For a generic helper without an ORC contract, G1 sets `BD_READONLY=1` only when the top-level OMP process has a non-empty absolute `BEADS_DIR` pin from `ensureBeadsPath`. The session checkout or pinned repository must also have a valid active-run marker. A missing or invalid marker fails open. Contract-bound `orc-*` roles and unrelated processes remain writable.
  G1 checks the session checkout first, then the pinned repository. This preserves linked-worktree runs whose shared `.beads` lives in the primary checkout.
- **G2 (`bash`, `edit`, `write`):** refuses a mutation outside the worktree named by the claimed bead, or outside its `metadata.scope` globs. `bash` is checked by its cwd only. G2 also refuses when the claimed bead is no longer `in_progress` and assigned to the claiming actor. A missing or unreadable bead fails closed. The terminal comment after the release is admitted. A bead you closed yourself ends the claim: the next product edit or comment passes and the gate disarms. To recover a closed bead, run `bd reopen <id>` and then `bd update <id> --claim --json`. To hand a reopened bead back, run `bd update <id> --assignee ""`.
- **G3 (`bash`):** blocks mutating `git worktree` commands and `gh pr checkout` because they bypass Worktrunk.
  Inspection remains allowed.
- **G4 (`yield`):** refuses exits when workers do not meet their contracts.
  A worker with a role but no claim receives one refusal.
  This refusal does not repeat, so revived sessions can exit.
- **G5 (`bash`):** blocks claims for another role and review states authored by shepherds.
- **G6 (`bash`):** warns without blocking. Within a pinned run, it checks for:
  - writes without actors: the identity is the assignee your claim report printed
  - comments without protocol verbs
  - bug beads unreachable from queues
- **G7 (`bash`):** blocks claims naming multiple beads. Each activation owns one bead.

## Rules

Five TTSR rules in `rules/` watch tool arguments as the model streams them and inject a
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

The run pins one absolute `BEADS_DIR` to its embedded database. G1 uses that process-local
pin and a valid marker in the session checkout or pinned repository before sandboxing a
generic helper. Each copied checkout inherits the pin. Discovering a local database does
not share state. G6 checks Beads discipline during a run.

The host has a separate regex engine. Python accepting a pattern does not prove the
host accepts it. After editing a rule, run `sh scripts/validate-rules.sh`. It feeds
`omp ttsr test` the shape the host matches: bash snippets wrapped as
`{"command":"…"}`, `task` and `hub` argument objects verbatim. This local check needs an
installed `omp`, so CI does not run it.

## Commands

Bootstrap a run in three steps, all in the lead session:

1. `/orchestrate-run`. It pins the database and writes a `pending` marker.
2. `bd create --type epic ...` with the run metadata that `beads-store.md` lists.
3. `/orchestrate-bind <epic>`. It arms the patrol. After this step, dispatch.

| Command | Does |
| --- | --- |
| `/orchestrate-run` | activates run enforcement in this repository: pins `BEADS_DIR` to the run's database and writes the marker `.orchestration/.active-run`, `pending` until bound |
| `/orchestrate-bind <epic>` | binds the marker to the run epic once `bd show` confirms that it is open, then arms the patrol wisp. When the patrol did not arm, it warns |
| `/orchestrate-status` | shows the marker binding, the run epic's status or the reason its liveness check failed, and whether the patrol armed |
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
