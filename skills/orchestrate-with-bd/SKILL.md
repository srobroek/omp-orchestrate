---
name: orchestrate
description: Use when coordinating independent work across isolated agents or resuming a durable Beads orchestration run.
---

# Orchestrate

TRIGGER
+ Coordinate substantial independent work across agents, or resume a durable run.
- Unless the user explicitly requires orchestration, use direct execution for one bounded task.

You are the lead. Define the run's shape and completion criteria. Spawn `orc-architect` with the run id and `isolated: true`; the plugin refuses a non-isolated architect spawn. Architects own their epics and dispatch workers. Workers pull their queues.

Origin is the only store that outlives an agent. After every integration, the architect pushes its feature branch. Before it yields, every implementer pushes its head to `omp/task/<id>`.

While the run is active the plugin refuses the lead's `git commit`, `git push`, `gh pr merge`, `gh pr ready`, and any edit or write of a product file outside `.orchestration/`; the lead contract it sends on start says the same.

Before bootstrap, confirm that parallel work or durable resumption justifies the run. Once the run is started, every role follows its claim contract. This check never permits a bypass.

## Workflow

LOAD the named reference before entering its phase. Follow that reference's procedure; this table routes work rather than restating the steps.

| Phase | Required reference |
|---|---|
| Bootstrap or database sync | `skill://orchestrate/references/beads-store.md` |
| Planning or dispatch | `skill://orchestrate/references/planning.md` |
| Helper selection or escalation | `skill://orchestrate/references/roles.md` |
| Review or landing | `skill://orchestrate/references/lifecycle.md` |
| Recovery or replacement | `skill://orchestrate/references/lifecycle.md`, then `planning.md` → Replacement |
| Incidental bugs or cleanup | `skill://orchestrate/references/lifecycle.md` |
| Decisions across scope boundaries | `skill://orchestrate/references/decisions.md` |
| Durable comment syntax | `skill://orchestrate/references/message-grammar.md` |

## Rules

- MUST Follow the injected dispatch contract. It owns shared claim and evidence semantics. Each agent prompt holds its role's claim command.
- NOT Paste the protocol into spawn prompts. Its human mirror is `skill://orchestrate/references/dispatch-contract.md`.
- MUST Never pass `--db` or point `bd` at another `.beads` in any child; the run database is reached by redirect.
- MUST Adopt existing SpecKit beads. Never pour a second graph beside them.
- DEFAULT Check small facts directly. Delegate substantial work, not every lookup.
- MUST Retain independent review. Fan baseline review out by exact-diff weight and code locality; add a specialist only for a material risk or unresolved gap, or when project policy requires it.
- MUST Keep feature-tree writes under the architect's control. Only the architect or one scoped helper may write there at a time.
- MUST Spawn the architect and every implementer `isolated: true` with apply=false. Before integration, verify the terminal result, `dod=` coverage and the pushed `omp/task/<id>` ref at its head. Integrate captures serially. After each integration, push the feature branch and stamp the feature's `metadata.integrated` node-id array.
- MUST Confine helpers to the owner's checkout and scope. Keep their grants unchanged.
- NOT Let helpers claim beads or commit. They cannot touch PRs or manage worktrees either.
- MUST Collect a helper's terminal result before another writer acts. A job receipt is not completion.
- MUST Treat an architect's yield or death as a rollover when its epic remains actionable. A yielded architect has released its epic, and the reaper releases a dead one's claim. Spawn a fresh `orc-architect`, isolated, naming the run epic and role. It resumes from origin (`planning.md` → Replacement). Never restart from chat memory alone.
- NOT Launch any role as an `omp` process, from `bash` or `hub start`, and NOT run a credential helper in a run. Roles are `task` subagents; G10 refuses both from every role session.
- NOT Create a worktree for an agent. Worktrunk is the operator's tool. In a run, G7 refuses `wt switch --create` from every role session, and G3 refuses `git worktree add` from every session.
- MUST Version CI and review evidence by exact head. Every push invalidates earlier green, review and security evidence; re-observe the new head before landing.
- MUST Record external waits on the bead with the awaited id and resume steps. Take ready work or yield instead of polling a gate.
- MUST Preserve held claims and captures after an incomplete exit. Neither a completed task nor an unevaluated exit proves acceptance.
- MUST Leave dead-claim release to the reaper. It releases under the claim fence on the holder's terminal frame, or on registry `aborted` plus a lapsed lease read fresh; a lapsed lease alone proves nothing.
- NOT Infer authority from age or a fresh read. Unknown ownership or evidence permits neither claim release nor cleanup.
- NOT Treat gates as isolation or atomic authorization.
- MUST Keep decisions on beads. Messages carry ids rather than relayed findings.
- MUST Let the landing sweep write `LANDED`, close covered nodes with `--reason merged`, and close an all-closed feature. Architects never close nodes; they reopen a closed feature before filing a child. `/orchestrate-stop` refuses non-forced teardown when patch containment is unresolved.

## Tools and status

| Need | Tool |
|---|---|
| Conflict or CI evidence | `orc_conflict_probe` |
| Bot round at the exact head | `orc_bot_review_probe`; unknown and declined are never clean |
| Request a provider review | Architect only: `orc_bot_review_request`; retain sole PR-update ownership, use modes in `review-providers.md`, and pass the exact expected head |
| Decide actionable-round bounce or escalation | `orc_review_round_policy`; pass only issues actionable at the exact head |
| Run status | `orc_run_status`; use its rollup, not a hand-built `bd list` summary |
| Exact-head security scan | `security_scan`; a security-dimension reviewer runs it when a feature has `metadata.security_review=required`, while a release review needs explicit repository policy on the release node. REVIEW needs a completed full native-store result with operation provenance and matching node/wisp stamps; BLOCKED may omit unavailable scan fields |

| Status scope | Filter |
|---|---|
| Whole run | none |
| Every bead in an epic | `epic: <id>, full: true` |
| Architect domain (an epic under the run) | `epic: <id>`; one feature beneath it: `feature: <id>` |
| One actor's held work | `actor: <name>` |

Slash commands, typed by the operator in the lead session:

- `/orchestrate-start --new "<title>"` or `/orchestrate-start <epic-id>` creates or adopts the run epic, writes the marker with the run's database and how it was found, stamps this session's lead lease, records landing capabilities, and sends the lead contract. `--store <path>` binds a database that is not the checkout's own. Without it, the command refuses a store that the process environment named. After it reports the run, dispatch.
- `/orchestrate-status` shows the run epic, its liveness, the lead lease, and the store the marker names. Its Attention section lists open `ASK` comments, lapsed leases, `BOUNCED` landings, refused adoptions, a store probe that is not `free`, and a marker with no `beads_dir`.
- `/orchestrate-roster` shows ready-queue depth per role, wisps included.
- `/orchestrate-answer <bead> <text>` writes an `ANSWER` note on a bead beneath the run epic. It requeues a `FAILED`+`ASK` implementer bead, and an epic a yielded architect released, for the next claimant. A live non-isolated holder gets a wake instead. The command refuses a bead outside the run.
- `/orchestrate-resume` takes over a run whose lead lease lapsed and releases in-flight claims whose lease lapsed.
- `/orchestrate-stop [--force]` ends the run: releases the lead lease and removes the marker. With any bead beneath the epic still `in_progress`, it refuses; `--force` skips that check.

Every command finds the run through the marker at the checkout, or at the primary checkout of a linked worktree.

Final assistant verdicts and durable comment verbs are separate channels.
