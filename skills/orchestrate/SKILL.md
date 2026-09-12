---
name: orchestrate
description: Use when coordinating independent work across isolated agents or resuming a durable Beads orchestration run.
---

# Orchestrate

TRIGGER
+ Coordinate substantial independent work across agents, or resume a durable run.
- Unless the user explicitly requires orchestration, use direct execution for one bounded task.

You are the lead. Define the run's shape and completion criteria. Architects own their epics and dispatch workers. Workers pull their queues.

Before bootstrap, confirm that parallel work or durable resumption justifies the run. Once bound, every role follows its claim contract. This check never permits a bypass.

## Workflow

LOAD the named reference before entering its phase. Follow that reference's procedure; this table routes work rather than restating the steps.

| Phase | Required reference |
|---|---|
| Bootstrap or database sync | `skill://orchestrate/references/beads-store.md` |
| Planning or dispatch | `skill://orchestrate/references/planning.md` |
| Helper selection or escalation | `skill://orchestrate/references/roles.md` |
| Review or landing | `skill://orchestrate/references/lifecycle.md` |
| Parking or recovery | `skill://orchestrate/references/lifecycle.md` |
| Incidental bugs or cleanup | `skill://orchestrate/references/lifecycle.md` |
| Decisions across scope boundaries | `skill://orchestrate/references/decisions.md` |
| Durable comment syntax | `skill://orchestrate/references/message-grammar.md` |

## Rules

- MUST Follow the injected dispatch contract. It owns shared claim and evidence semantics. Each agent prompt holds its role's claim command.
- NOT Paste the protocol into spawn prompts. Its human mirror is `skill://orchestrate/references/dispatch-contract.md`.
- MUST Preserve the same pinned absolute `BEADS_DIR` in every child.
- MUST Adopt existing SpecKit beads. Never pour a second graph beside them.
- DEFAULT Check small facts directly. Delegate substantial work, not every lookup.
- MUST Retain independent review. Add another specialist only for a material risk or unresolved gap, or when project policy requires it.
- MUST Keep feature-tree writes under the architect's control. Only the architect or one scoped helper may write there at a time.
- MUST Use isolated implementer copies with apply=false. Before integration, verify the terminal result and captured branch/head. Integrate captures serially.
- MUST Confine helpers to the owner's checkout and scope. Keep their grants unchanged.
- NOT Let helpers claim beads or commit. They cannot touch PRs or manage worktrees either.
- MUST Collect a helper's terminal result before another writer acts. A job receipt is not completion.
- MUST Treat an architect runtime stop as a rollover when its epic remains actionable. LOAD `roles.md`, build the handover from durable epic and worktree evidence, and start a replacement `orc-architect` for the same epic. Never restart from chat memory alone.
- MUST Preserve required CI at the exact head. A closed gate does not prove success.
- MUST Record external waits on the bead with the awaited id and resume steps. Take ready work or yield instead of polling a gate.
- MUST Preserve held claims and captures after an incomplete exit. Neither a completed task nor an unevaluated exit proves acceptance.
- MUST Establish holder evidence before recovery. Hold an exclusive recovery window with every competing writer stopped, including claim, dispatch and branch writers.
- NOT Infer authority from age or a fresh read. Unknown ownership or evidence permits neither claim release nor cleanup.
- NOT Treat gates as isolation or atomic authorization.
- NOT Let the lead claim beads. Workers cannot rewrite existing routing; only shepherds merge.
- MUST Keep decisions on beads. Messages carry ids rather than relayed findings.

## Tools and status

| Need | Tool |
|---|---|
| Conflict or CI evidence | `orc_conflict_probe` |
| Bot round at the exact head | `orc_bot_review_probe`; unknown and declined are never clean |
| Request a provider review | Architect only: `orc_bot_review_request`; retain sole PR-update ownership, use modes in `review-providers.md`, and pass the exact expected head |
| Decide actionable-round bounce or escalation | `orc_review_round_policy`; pass only issues actionable at the exact head |
| Run status | `orc_run_status`; use its rollup, not a hand-built `bd list` summary |

| Status scope | Filter |
|---|---|
| Whole run | none |
| Every bead in an epic | `epic: <id>, full: true` |
| Architect domain (an epic under the run) | `epic: <id>`; one feature beneath it: `feature: <id>` |
| One actor's held work | `actor: <name>` |

Slash commands, typed by the lead:

- `/orchestrate-run` pins the database and writes the `pending` marker. Run it first.
- `/orchestrate-bind <epic>` binds the marker to the run epic and arms the patrol. After it, dispatch.
- `/orchestrate-status` shows the marker binding, the run epic's liveness, and whether the patrol armed.
- `/orchestrate-roster` shows ready-queue depth per role, wisps included.
- `/orchestrate-close <epic>` ends a run by removing the marker. With any bead beneath the epic still `in_progress`, it refuses. `--force` skips that check.

Final assistant verdicts and durable comment verbs are separate channels.
