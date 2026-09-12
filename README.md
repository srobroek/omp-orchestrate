# omp-orchestrate

An OMP plugin that runs a team of agents against one goal. The operator starts a run,
answers the questions it raises, and stops it. Agents claim their own work from a
[Beads](https://github.com/gastownhall/beads) graph; the plugin merges the approved PRs.

| | |
| --- | --- |
| Status | Prerelease. OMP reports the version it installs. |
| Requires | the tools and plugins under [Prerequisites](#prerequisites) |
| Contributing | [CONTRIBUTING.md](CONTRIBUTING.md): gates, rules, architecture, development |

## How it works

1. A run is one Beads epic. Each feature under it is an epic holding its tasks.
2. Agents pull the next bead in their queue with `bd ready --claim`; nobody assigns work.
3. Workers edit in isolated copies of the checkout. The architect integrates their captured
   branches into one feature branch and opens one PR per feature.
4. The plugin merges each approved PR at its reviewed head. No agent merges.
5. Eight tool-call gates and three rules hold every agent to its claim. The operator's writes
   are `start`, `answer`, and `stop`.

## Prerequisites

`/orchestrate-doctor` reports every row below except `omp`, which it runs inside, with a
version and a pass, warn, or fail. A fail breaks a run started now; a warn degrades a later
step and names it.

| Tool | Version | Used by |
| --- | --- | --- |
| `omp` | current | the lead session; the settings preflight and the doctor read its effective settings in process |
| `bd` (Beads) | 1.2 or later | every claim, comment, and status read. `bd` embeds the database, so no server runs |
| `wt` (Worktrunk) | current | architect feature worktrees |
| `gh` | 2.100 or later, signed in (`gh auth status`) | conflict and review probes, the landing capability probe, and the merges |
| `git` | 2.x | every worktree, capture, and integration step |
| `bun` | 1.3.14 or later, the runtime `omp` itself requires | `skills/orchestrate/scripts/worktree-sweep.ts` at run end |

The architect and implementer may spawn seven helpers. `scout` and `security-reviewer`
ship with OMP. The other five come from three plugins in the `srobroek-omp` marketplace:

| Plugin | Agents |
| --- | --- |
| `build` | `operator` |
| `delivery` | `pr-reviewer` |
| `quality` | `adversarial-challenger`, `docs-guard`, `lint-guard` |

A spawn that names an uninstalled agent fails with an unknown-agent error. Before that
failure, agent discovery preflight reports the missing helper.

## Install

```sh
omp plugin marketplace add srobroek/omp-orchestrate
omp plugin install orchestrate@omp-orchestrate
omp plugin marketplace add srobroek/omp-plugins
omp plugin install build@srobroek-omp
omp plugin install delivery@srobroek-omp
omp plugin install quality@srobroek-omp
```

After installing, restart the session. OMP loads a new extension module at startup only, so
`/reload-plugins` does not find it. Claude Code reads the same catalog from
`.claude-plugin/marketplace.json`. Upgrade between runs, never during one.

## Configure

The plugin ships its six required OMP settings as one overlay,
`config/orchestrate.overlay.yml`. Start the lead session with it:

```sh
omp --config <plugin-root>/config/orchestrate.overlay.yml
```

`<plugin-root>` is `~/.omp/plugins/cache/plugins/omp-orchestrate___orchestrate___<version>`
for a marketplace install, or the checkout you passed to `omp plugin link`.
`/orchestrate-doctor` prints the resolved path and this command; `omp plugin list --json`
exposes it as `entries[].installPath`. A missing or malformed overlay path is a startup
error.

| Setting | Value | Without it |
| --- | --- | --- |
| `task.isolation.enabled` | `true` | workers share the architect's tree, so two claims can edit one file |
| `task.isolation.merge` | `branch` | commits replay as a patch, so no `omp/task/<id>` branch survives to integrate or to recover after a crash |
| `task.isolation.apply` | `false` | OMP merges child work into the spawning tree, so the architect never owns integration |
| `task.enableEffort` | `true` | OMP ignores the per-spawn effort, so every agent runs at the session default |
| `task.maxRecursionDepth` | `3` | a worker's helper sits at depth 3, so at the default `2` no worker can spawn one |
| `bash.autoBackground.enabled` | `false` | a slow claim can auto-background, so its result bypasses the observer and the claim is never adopted |

The five agents select their models through four `modelRoles` entries and inherit each
role's thinking level. OMP ships the names `plan`, `task` and `smol` without a default
model, so each one must resolve in your configuration before a run starts; `reviewer` is
optional. `/orchestrate-doctor` prints one row per role:

| Role | Agents | Unresolved |
| --- | --- | --- |
| `modelRoles.plan` | `orc-architect` | `fail`: the architect cannot be spawned |
| `modelRoles.task` | `orc-implementer`, `orc-shepherd` | `fail`: neither agent can be spawned |
| `modelRoles.smol` | `orc-researcher` | `fail`: the researcher cannot be spawned |
| `modelRoles.reviewer` | `orc-reviewer` | `warn`: the reviewer falls back to the session model, and the preflight writes one `WARN` |

The overlay carries `modelRoles.reviewer` as a commented line; uncomment it and name the
model you want independent review to use.

| Agent | Model role | Edits code |
| --- | --- | --- |
| `orc-architect` | `@plan` | yes |
| `orc-implementer` | `@task` | yes |
| `orc-shepherd` | `@task` | no |
| `orc-reviewer` | `@reviewer` | no |
| `orc-researcher` | `@smol` | no |

The settings preflight compares the effective values at start and before each wave. It
reports a deviation as a `WARN settings` message in the lead transcript and as a comment
on the run epic. It never rewrites your configuration.

## Start

Before the first run in a checkout:

1. When no database exists, create one: `bd init --stealth --prefix orc`. It writes
   `.git/info/exclude`, so `git status` stays clean.
2. Add `.orchestration/` to `.gitignore`.

Then, in the lead session started with the overlay:

```text
/orchestrate-start --new "<run title>"
```

Pass an epic id instead of `--new` to run an existing epic: `/orchestrate-start <epic-id>`.
Add `--store <path>` to bind a `.beads` directory that is not the checkout's own.
The command:

- creates the run epic, or reads the epic you named and leaves its metadata as written.
  A new epic gets `run_id`, `primary_branch`, `base_sha`, `origin_actor`, and an
  `artifacts` directory under `.orchestration/<epic-id>/`
- resolves the run's store and refuses one that a store selector in the process
  environment named, unless `--store` names the same path
- probes the store and refuses a `locked` or `corrupted` one
- writes the marker `.orchestration/.active-run` naming the epic, the run's `.beads`, and
  how that store was found (`checkout`, `common-dir`, `redirect`, or `explicit`)
- stamps this session's lead lease on the epic
- records the repository's landing capabilities on the epic as `metadata.landing`
- arms the watchers
- prints the lead's three obligations and sends the lead contract to the model

When another session's run is active in the checkout, it refuses. One checkout hosts one
run, and one session leads it. A second person joins by opening a session in the same
checkout without starting a run. Every slash command finds the run through the marker at
the checkout, or at the primary checkout of a linked worktree.

Once the command reports the run, describe the goal to the lead. The lead plans the
graph and spawns `orc-architect` with the run id; it never claims a work bead. While the
run is active, the plugin refuses the lead's `git commit`, `git push`, `gh pr merge`,
`gh pr ready`, and every `edit` or `write` of a file inside a git working tree outside
`.orchestration/`. Each refusal names the recovery: spawn `orc-architect`.

## Watch

| Command | Shows |
| --- | --- |
| `/orchestrate-status` | the run epic the marker names, its status or why its liveness check failed, the lead lease with its holder, the store the marker names (or a warning that it names none), then **Attention** |
| `/orchestrate-roster` | ready-queue depth per role, wisps included |
| `/orchestrate-doctor` | every prerequisite, the six required settings, one row per model role, the landing capabilities, and the store probe |

**Attention** lists what needs you:

- `ASK <bead> (<author>): <question>` for every open question on a run bead
- `lead lease lapsed` and `lease lapsed: <bead> held by <holder>`
- `landing BOUNCED: <merge> (fix <id>)` and `landing BLOCKED: <merge>`
- `adoption refused`
- `store locked by <holder>`
- the last `WARN` from the settings or agent preflight

With nothing open it prints `attention: none`.

For one bead, `bd show <bead>` and `bd comments <bead>` hold its story. Every transition
is one comment whose first word is a verb: `REPORTED`, `BLOCKED`, `ASK`, `LANDED`.

## Answer

```text
/orchestrate-answer <bead> <text>
```

The bead must sit beneath the run epic, at any depth. A bead outside the run, or one
whose parent chain cannot be read, is refused and nothing is written. Otherwise the
command writes a `NOTE` comment prefixed `ANSWER` on the bead. Then it acts on the
bead's state:

- last verbs `FAILED` and `ASK` from an implementer: it requeues the bead as `open` and
  unassigned, so the next worker pulls it with your answer
- held by a parked architect: it wakes that architect

## Stop

```text
/orchestrate-stop [--force]
```

The command reads the run from the marker. It refuses in two cases:

- another session's lead lease is live: `run <epic> is leased to <holder> (lease live until
  <time>); that lead stops it, or pass --force`
- any bead beneath the run epic, at any depth, is `in_progress`

`--force` skips both checks and writes `NOTE run stopped with --force` on the epic, naming
the in-progress beads. On success the command releases this session's lead lease and
removes the marker and its lock file `.orchestration/.active-run.lock`. The lead's close-out
procedure in the skill comes first; stopping is the last step.

## Resume

When the lead session died or you open a new one, run `/orchestrate-resume` in a session
in the same checkout, started with the overlay. The lease lasts 15 minutes without renewal
(`ORC_LEASE_TTL_MS`). The command:

- refuses while the previous lead lease is live, naming the holder and the deadline
- refuses a marker whose schema is newer than the plugin's: `upgrade the plugin before
  resuming`
- rewrites an older marker as schema 1 and prints `marker migrated to schema 1`
- takes over the run once the lease lapses
- reads every `in_progress` bead beneath the epic and releases each one with a lapsed
  lease, writing `RECOVERED` on it. It names a live lease in the summary and keeps it

After adoption the lead dispatches again. A replacement worker pulls the same bead
atomically, and a parked architect gets a wake.

## Troubleshooting

### Store probe states

`/orchestrate-start` and `/orchestrate-status` probe the run's embedded Dolt store.

| State | Meaning | Do |
| --- | --- | --- |
| `free` | the writer lock is free and one read took under 2 s | nothing |
| `slow` | one read took over 2 s; start continues | watch for a `locked` state on the next probe |
| `locked` | another process holds `noms/LOCK`; the probe names the holder as `command[pid]` | wait for it to exit, or find why a second `bd` runs against this store. A `bd-container` or `perl` holder is the `bd` router taking the host lock around a routed command |
| `corrupted` | opening the journal fails with `corrupted journal` or `invalid journal record`; the message quotes the file and offset | run `dolt fsck` in the store directory. The plugin never repairs, starts, stops, or kills a Dolt engine |

### `/orchestrate-start` refuses

- `a run is already active in this checkout: <epic>, started by session <sid>`: stop it from
  that session. Once its lead lease lapses, `/orchestrate-resume` adopts it.
- `no active Beads workspace was found`: run `bd init --stealth --prefix orc` in the
  checkout.
- `bd resolved its database to <dir> through a store selector in this process's
  environment`: the session inherited a variable that points bd at another store. Unset
  it, or pass `--store <dir>` to bind that store on purpose.
- `run not started: the store at <dir> is locked by <holder>` or `is corrupted`: read
  [Store probe states](#store-probe-states).

### Refused adoption

`/orchestrate-resume` prints one of three refusals:

- `resume refused: run epic <id> is leased to <holder>; lease live until <time>`: the
  previous lead still renews, or its lease has time left. Wait for the deadline or stop
  that session. The epic also gets a `NOTE adoption refused` comment.
- `another lead adopted <id> first`: two sessions resumed at once; the other one leads.
- `run epic <id> could not be read`: `bd show <id>` fails. Check the store probe.

### Lapsed lead lease

`/orchestrate-status` shows `lease lapsed at <time>` when the lead missed renewal for
longer than the TTL. Its watchers, landing sweep, and dispatch stopped with it. Run
`/orchestrate-resume` from a live session in the checkout.

### Landing `BOUNCED`

The landing sweep writes `BOUNCED reason=<cause>` on the merge bead and its origin feature.

| Reason | Cause | What happens next |
| --- | --- | --- |
| `conflict` | the base branch fails to merge cleanly into the PR branch | a fix bead blocks the merge bead: `role=implementer`, or `role=architect` when a conflicting path leaves the feature's scope |
| `ci` | a required check failed twice at the same head; the sweep reran the first failure once with `gh run rerun --failed` | an implementer fix bead names the check and the run |
| `closed` | someone closed the PR without merging | reopen the PR, or close the merge bead |
| `bot` | a review bot posted an actionable round | the shepherd files one implementer fix bead |

A `BLOCKED landing:` comment without a bounce means the sweep waits: GitHub disarmed
auto-merge on the PR, or the merge bead names no `origin_bead` to file a fix under.

### `WARN settings`

You started the lead session without the overlay, or your global configuration overrides a
row. Restart the session with `omp --config <plugin-root>/config/orchestrate.overlay.yml`.
Accepting the warning leaves captured branches, deliberate integration, and cross-worker
claim exclusion unavailable.

### Unknown agent or a missing helper

When `/agents` and task dispatch disagree, check the effective `extensions` roots. With
the `claude-plugins` source disabled, list the installed package root in `extensions` so
native discovery can load its agents. Files under `agents/` alone do not register them.

### Dormancy

Outside a run the plugin spawns no process and writes no file. It sends no message and
refuses no tool call. A plain session sees the slash commands, the `orc_*` tools, the
agents, the skill, and three rules. A run scope exists only while a valid marker
`.orchestration/.active-run` is readable at one of three places:

- the checkout
- an isolated copy of the checkout
- the primary of a linked git worktree

A marker left behind by a finished run keeps the plugin active: it injects the protocol
into every `orc-*` session and sandboxes generic helpers. `/orchestrate-stop` removes it.
A marker written by an older plugin version that names no epic reads the same way:
`/orchestrate-start <epic-id>` adopts it, `/orchestrate-stop` removes it.

### Worker copies and the redirect

OMP isolation clones the whole checkout, `.beads/` included. At a worker's first turn the
plugin writes `.beads/redirect` in the copy, naming the run's `.beads` from the marker, and
removes the copied store. Every `bd` call from the copy reaches the run's database.
`bd where --json` in a copy shows `redirected_from`.

A copy whose target does not exist fails closed: `bd` reports `no beads database found`.
A marker that names no database leaves each copy on a private store. The preflight reports
it, and `/orchestrate-start <epic-id>` from the lead records the database.

## License

Apache-2.0 governs this repository. Read the full text in [LICENSE](LICENSE).
