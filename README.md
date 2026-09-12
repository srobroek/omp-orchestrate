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
| Requires | `bd` (Beads) and `wt` (Worktrunk) on `PATH` |
| Install | `omp plugin marketplace add srobroek/omp-orchestrate` then `omp plugin install orchestrate@omp-orchestrate` |
| Install for development | `omp plugin link /path/to/omp-orchestrate` |

For development, run `./scripts/install-agnix-hooks.sh` once in each checkout. It preserves
an existing hook path and validates staged instruction files; Git does not install tracked
hooks automatically.

After either command, restart the session. OMP loads a new extension module only at startup, so
`/reload-plugins` does not find it. Claude Code reads the same catalog from
`.claude-plugin/marketplace.json`.

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
required bead verdict or authorize a merge. Skip it when no separate PR risk needs review.

Per-spawn `effort` selects the lowest (`lo`), middle (`med`) or highest (`hi`)
supported thinking level. With only low and medium available, both `lo` and `med`
select low; `hi` selects medium. It never requests an unsupported literal high.

## Required configuration

| Setting | Type | Default | Effect |
| --- | --- | --- | --- |
| `modelRoles.reviewer` | model selector | none | Defines the model used by the independent review role. Configure it before dispatch. |
| `task.maxRecursionDepth` | number | `2` | A helper runs at depth 3. At `2` no worker can spawn one. Set `3`. |
| `bash.autoBackground.enabled` | boolean | set explicitly to `false` | Claim results must stay foreground so the observer can bind them. Never set `async: true` on a claim. |

The extension reports deviations through `WARN settings` notices and a comment on
the bound epic. Preflight never creates or rewrites project configuration.

Agent discovery preflight reports missing core roles, incorrect role markers and
unresolved model aliases. It checks optional helpers when a task requests them.
Warnings include the resolved definition path when one exists.

If `/agents` and task dispatch disagree, check the effective `extensions` roots.
With the `claude-plugins` source disabled, list the installed package root in `extensions`
so native discovery can load its agents. Files under `agents/` alone do not register them.

Choose one response:

- Fix the settings. Then restart.
- Explicitly accept the reported limitations.

If the backgrounding setting is unavailable or incorrect, the observer cannot reliably
bind claims. A warning neither establishes a claim nor makes dispatch safe.

## Gates

The extension registers a single `tool_call` handler with seven checks. They catch
protocol mistakes but cannot enforce transactional isolation. G6 delivers notices.
Unavailable evidence and bounded exit paths can fail open without accepting the work.

- **G1 (`bash`):** For a generic helper without an ORC contract, G1 sets `BD_READONLY=1` only when the top-level OMP process has a non-empty absolute `BEADS_DIR` pin from `ensureBeadsPath`. The session checkout or pinned repository must also have a valid active-run marker. A missing or invalid marker fails open. Contract-bound `orc-*` roles and unrelated processes remain writable.
  G1 checks the session checkout first, then the pinned repository. This preserves linked-worktree runs whose shared `.beads` lives in the primary checkout.
- **G2 (`bash`, `edit`, `write`):** blocks edits outside the worktree named by the claimed bead.
- **G3 (`bash`):** blocks mutating `git worktree` commands and `gh pr checkout` because they bypass Worktrunk.
  Inspection remains allowed.
- **G4 (`yield`):** refuses exits when workers do not meet their contracts.
  A worker with a role but no claim receives one refusal.
  This refusal does not repeat, so revived sessions can exit.
- **G5 (`bash`):** blocks claims for another role and review states authored by shepherds.
- **G6 (`bash`):** warns without blocking. Within a run, it checks for:
  - writes without actors
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
- A rule that asserts a key is absent (`orc-spawn-isolated`) must wait for the object to close. Until the last delta the buffer is a prefix.

`interruptMode` sets the cost of a match. `never` lets the call run and folds the rule
text into its result. `tool-only` aborts the assistant message, discards it, injects the
rule, and continues. Either way a rule fires once per session (`repeatMode: once`). The
`bd ready` rules and `orc-no-nested-omp` use `never`, because the flagged command is
harmless (an empty queue, a doomed process) and the reminder arrives with the result.
`orc-spawn-isolated` uses `tool-only`, because its reminder is useless after the worker
has run.

The run pins one absolute `BEADS_DIR` to its embedded database. G1 uses that process-local
pin and a valid marker in the session checkout or pinned repository before sandboxing a
generic helper. Each copied checkout inherits the pin. Discovering a local database does
not share state. G6 and G7 check Beads discipline during a run.

The host has a separate regex engine. Python accepting a pattern does not prove the
host accepts it. After editing a rule, run `sh scripts/validate-rules.sh`. It feeds
`omp ttsr test` the shape the host matches: bash snippets wrapped as
`{"command":"…"}`, `task` and `hub` argument objects verbatim, including partial
buffers for the stream-sensitive rule. This local check needs an installed `omp`, so CI
does not run it.

## Commands

| Command | Shows |
| --- | --- |
| `/orchestrate-status` | run status for the active epic |
| `/orchestrate-roster` | live agents, beside the queue depth for each routing label |

## Development

Run `bun install --frozen-lockfile` before `bun run typecheck` or `bun test`, and
again after every pull that changes `bun.lock`. The lockfile pins the
`@oh-my-pi/pi-coding-agent` release the source compiles against; a `node_modules`
left over from an older release fails with missing-export errors in
`src/agent-preflight.ts` and `src/worktree.ts` and a missing `pi-natives` export in
`test/wiring.test.ts`, while CI, which installs fresh, stays green.

## License

Apache-2.0 governs this repository. Read the full text in [LICENSE](LICENSE).
