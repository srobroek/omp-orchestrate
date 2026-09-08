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

After either command, restart the session. OMP loads a new extension module only at startup, so
`/reload-plugins` does not find it. Claude Code reads the same catalog from
`.claude-plugin/marketplace.json`.

## Agents

Each agent names an OMP model role without a thinking level. The role controls the
tier. To tune it, edit `modelRoles` in your configuration.

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

## Required configuration

| Setting | Type | Default | Effect |
| --- | --- | --- | --- |
| `modelRoles.reviewer` | model selector | none | `orc-reviewer` names `@reviewer`, which OMP does not ship. Unset, the reviewer shares the family it judges. Point it at another family. |
| `task.maxRecursionDepth` | number | `2` | A helper runs at depth 3. At `2` no worker can spawn one. Set `3`. |
| `bash.autoBackground.enabled` | boolean | set explicitly to `false` | Claim results must stay foreground so the observer can bind them. Never set `async: true` on a claim. |

The extension reports deviations through `WARN settings` notices and a comment on
the bound epic. Preflight never creates or rewrites project configuration.

Choose one response:

- Fix the settings. Then restart.
- Explicitly accept the reported limitations.

If the backgrounding setting is unavailable or incorrect, the observer cannot reliably
bind claims. A warning neither establishes a claim nor makes dispatch safe.

## Gates

The extension registers a single `tool_call` handler with seven checks. They catch
protocol mistakes but cannot enforce transactional isolation. G6 delivers notices.
Unavailable evidence and bounded exit paths can fail open without accepting the work.

- **G1 (`bash`):** imposes `BD_READONLY=1` to block bead writes from sessions without a contract.
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

Before a command runs, four TTSR rules in `rules/` check its arguments for protocol slips.
Each rule is advisory or tool-only, never a security boundary.

The run pins one absolute `BEADS_DIR` to its embedded database.
Each copied checkout inherits that pin. Discovering a local database does not share state.
G6 and G7 check Beads discipline during a run.

The host has a separate regex engine. Python accepting a pattern does not prove the
host accepts it. After editing a rule, run `sh scripts/validate-rules.sh`.
It checks one firing case and one quiet case per rule through `omp ttsr test`.
This local check needs an installed `omp`, so CI does not run it.

## Commands

| Command | Shows |
| --- | --- |
| `/orchestrate-status` | run status for the active epic |
| `/orchestrate-roster` | live agents, beside the queue depth for each routing label |

## License

Apache-2.0 governs this repository. Read the full text in [LICENSE](LICENSE).
