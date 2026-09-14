# orchestrate-with-bd

An OMP plugin that keeps a [Beads](https://github.com/gastownhall/beads) ledger beside OMP's
native `orchestrate` keyword. OMP runs the agents and lands the result. The plugin records
which beads exist, who holds each one, and how each one ended.

| | |
| --- | --- |
| Status | Prerelease. OMP reports the version it installs. |
| Requires | OMP 18.1.19 or later, `bd` 1.2.2 or later in shared-server mode, `gh` 2.100 or later for the review tools |
| Contributing | [CONTRIBUTING.md](CONTRIBUTING.md): architecture, tests, development |

## How it works

1. A run is one Beads epic. Its tasks are the beads under it.
2. Typing `orchestrate` in a prompt injects a run header naming the store, the bound epic,
   and the lead contract. The lead dispatches workers through OMP's `task` tool.
3. A worker calls `orc_claim` on the bead its brief names, works in the isolated clone OMP
   gave it, and calls `orc_finish` with its evidence. Beads' atomic assignee is the only
   lock.
4. The lead's `todo` list is a view of `orc_status`: every entry is `<bead-id> <title>`. An
   entry with no bead behind it draws one advisory message.
5. Every clone reaches the same database because the store runs on the machine's shared
   Dolt server, named by the tracked `.beads/metadata.json`.

## Install

```sh
omp plugin marketplace add srobroek/orchestrate-with-bd
omp plugin install orchestrate-with-bd@orchestrate-with-bd
```

The `operator` helper the implementer may spawn comes from the `build` plugin in the
`srobroek/omp-plugins` marketplace; `scout` and `security-reviewer` ship with OMP.

## Store

The project's Beads store runs in shared-server mode: `.beads/metadata.json` pins
`"dolt_mode": "server"` and `.beads/config.yaml` carries `dolt.shared-server: true`. A new
project gets there with `bd init --shared-server`. An embedded project migrates with the
route in `skills/orchestrate-with-bd/references/beads-store.md`. On an embedded store the
ledger tools return that route and write nothing.

## Tools

| Tool | Does |
| --- | --- |
| `orc_status` | reads every bead under the run epic; `todo` holds `<bead-id> <title>` for the open ones; binds the run when passed `epic` |
| `orc_claim` | `bd update <bead> --claim`, then reads the assignee back |
| `orc_finish` | writes the comment, then `bd close` or `bd update --status blocked` |
| `orc_bot_review_probe` | classifies a PR's review-bot round at its exact head |
| `orc_bot_review_request` | requests one allowlisted provider review at an exact head |
| `orc_conflict_probe` | predicts merge conflicts and reads CI without touching a tree |
| `orc_review_round_policy` | decides whether an actionable round bounces to a fix bead or escalates |

## Agents

- `orc-lead`, `orc-planner`
- `orc-implementer`, `orc-reviewer`, `orc-researcher`, `orc-shepherd`

Implementers and epic leads run `isolated: true`. The skill
`skill://orchestrate-with-bd` holds the procedure; `references/roles.md` holds the model,
spawn, and depth table.

## License

Apache-2.0.
