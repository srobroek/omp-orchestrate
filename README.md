# omp-orchestrate

Multi-agent orchestration for OMP. Work lives in
[Beads](https://github.com/gastownhall/beads) as a three-level graph. An epic contains feature beads, and
each feature bead contains task beads. Each agent claims the next bead that matches its domain, works in an
isolated copy of the repository, and reports back through the graph. One extension enforces the role
contracts that make this safe.

| | |
| --- | --- |
| Status | Prerelease. Not yet published to a marketplace catalog. |
| Requires | `bd` (Beads) and `wt` (Worktrunk) on `PATH` |
| Install for development | `omp plugin link /path/to/omp-orchestrate` |

After linking, restart the session. OMP loads a new extension module only at startup, so
`/reload-plugins` does not find it.

## Agents

Each agent names one built-in OMP model role and sets no thinking level. The plugin defines no roles of its
own. Tune the tiers by editing `modelRoles` in your own configuration.

| Agent | Role | Edits code | May spawn |
| --- | --- | --- | --- |
| `orc-architect` | `@plan` | yes | the other four, plus `scout` and `sonic` |
| `orc-implementer` | `@task` | yes | no |
| `orc-shepherd` | `@task` | no | no |
| `orc-reviewer` | `@smol` | no | no |
| `orc-researcher` | `@smol` | no | no |

Only the architect may spawn. It also holds the feature branch, so it is the one agent that outlives a
single bead.

## Gates

The extension registers one `tool_call` handler covering five rules. Each one fails closed. A bug in the
handler degrades to fail-open instead of blocking every tool.

| Gate | Tool | Refuses |
| --- | --- | --- |
| G1 | `bash` | bead writes from a session under no contract, by imposing `BD_READONLY=1` |
| G2 | `bash`, `edit`, `write` | edits outside the worktree that the claimed bead names |
| G3 | `bash` | `git worktree` and `gh pr checkout`, which bypass Worktrunk |
| G4 | `yield` | exiting before the claimed bead's role contract is met. Also a role-marked worker that claimed nothing, whose exit reaches no bead and no branch. That second refusal fires once, so a revived worker is never trapped |
| G5 | `bash` | claiming a bead that routes to another role |

## Rules

Eight TTSR rules in `rules/` catch protocol slips in tool arguments. They fire before a command
runs. Each one is advisory or tool-only, never a security boundary.

The host's regex engine evaluates these conditions, so a pattern Python accepts proves nothing.
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
