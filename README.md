# omp-orchestrate

This plugin orchestrates many agents in OMP. Work lives in
[Beads](https://github.com/gastownhall/beads) as a three-level graph. An epic contains feature beads, and
each feature bead contains task beads. Each agent claims the next bead that matches its domain, works in an
isolated copy of the repository, and reports back through the graph. One extension enforces the role
contracts that make this safe.

| | |
| --- | --- |
| Status | Prerelease. The install reports the version it resolved. |
| Requires | `bd` (Beads) and `wt` (Worktrunk) on `PATH` |
| Install | `omp plugin marketplace add srobroek/omp-orchestrate` then `omp plugin install orchestrate@omp-orchestrate` |
| Install for development | `omp plugin link /path/to/omp-orchestrate` |

After either command, restart the session. OMP loads a new extension module only at startup, so
`/reload-plugins` does not find it. Claude Code reads the same catalog from
`.claude-plugin/marketplace.json`.

## Agents

Each agent names an OMP model role and sets no thinking level, so the tier travels with the role rather
than the file. Tune them by editing `modelRoles` in your own configuration.

| Agent | Role | Edits code | May spawn |
| --- | --- | --- | --- |
| `orc-architect` | `@plan` | yes | the other four, plus eight borrowed helpers |
| `orc-implementer` | `@task` | yes | `librarian`, `scout`, `operator` |
| `orc-shepherd` | `@task` | no | nothing |
| `orc-reviewer` | `@reviewer` | no | nothing |
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

A run reports either of these as a `WARN settings` notice on its epic.

## Gates

The extension registers a single `tool_call` handler. It runs seven checks. Six fail closed. G6
refuses nothing: it delivers notices. A bug in the handler degrades to fail-open rather than
blocking every tool.

| Gate | Tool | Denied call |
| --- | --- | --- |
| G1 | `bash` | bead writes from a session under no contract, by imposing `BD_READONLY=1` |
| G2 | `bash`, `edit`, `write` | edits outside the worktree that the claimed bead names |
| G3 | `bash` | `git worktree` and `gh pr checkout`, which bypass Worktrunk |
| G4 | `yield` | an exit before the claimed bead's role contract is met. Also a role-marked worker that claimed nothing, whose exit reaches no bead. That second refusal fires once, so a revival is never trapped |
| G5 | `bash` | claiming a bead that routes to another role |
| G6 | `bash` | nothing. Inside a run it warns on three shapes: a `bd` write with no actor, a comment with no protocol verb, and a bug bead no queue can reach |
| G7 | `bash` | a claim naming two or more beads, because one activation owns one bead |

## Rules

Four TTSR rules in `rules/` catch protocol slips in tool arguments. They fire before a command
runs. Each one is advisory or tool-only, never a security boundary.

Five bd rules used to sit beside them. Four are G6 and G7 now: a regex over a command string cannot
tell whether a run is active, so it nagged every session that mentioned `bd`. The fifth demanded a
`-C` database pin, and this repository retired it. A per-project Dolt server resolves the database
by host and port, and that survives a copied checkout.

The host evaluates these conditions with its own regex engine, so a pattern Python accepts proves
nothing.
After editing a rule, run `sh scripts/validate-rules.sh`. It asserts one firing case and one
quiet case per rule through `omp ttsr test`. It needs an installed `omp`, so it stays a local
gate rather than a CI step.

## Commands

| Command | Shows |
| --- | --- |
| `/orchestrate-status` | run status for the active epic |
| `/orchestrate-roster` | live agents, beside the queue depth for each routing label |

## License

Apache-2.0 governs this repository. Read the full text in [LICENSE](LICENSE).
