# Roles, models, escalation

Five agents ship: `orc-architect`, `orc-implementer`, `orc-reviewer`, `orc-researcher`,
`orc-shepherd`. Each names exactly one built-in OMP model role and sets no thinking level.
The plugin defines no model roles of its own -- tune the tiers by editing `modelRoles` in
your own configuration, and never write a raw provider selector into an agent.

Escalation is per-spawn `effort`, not a second agent. There is no deep variant of any role.

| Role | Agent | Model role | Lifetime | Works in | Claims |
|---|---|---|---|---|---|
| Lead | you (this session) | session model | whole run | the primary checkout | never claims anything |
| Architect | `orc-architect` | `@plan` | long-lived, parked between waves, revivable | its Worktrunk feature worktree; **not** isolated | one epic, pulled |
| Implementer | `orc-implementer` | `@task` | ephemeral, one bead | an isolated copy; commits captured on `omp/task/<id>` | one task bead, pulled |
| Reviewer | `orc-reviewer` | `@task` | ephemeral, one verdict | read-only, no checkout of its own | one review wisp, pulled |
| Researcher | `orc-researcher` | `@smol` | ephemeral, one answer | read-only, no checkout of its own | one escalation wisp or research bead, pulled |
| Shepherd | `orc-shepherd` | `@task` | ephemeral, two phases across the CI gate | no content tree; PR and merge state only | merge beads (`pr:merge` + `agent:integrator`), pulled |
| Helper | `scout`, `sonic`, or a plain child | inherited | ephemeral, inside the architect's own await | the architect's checkout | nothing -- traced by a wisp, never claims |

The reviewer is `@task` rather than the cheap tier on purpose: a reviewer cannot be weaker
than the work it is evaluating. The researcher is cheap because its output is a digest with
citations, and its hard cases escalate by `effort`.

"Long-lived" does not mean one never-restarted process. An architect may be replaced
mid-epic; the Worktrunk branch and the bead state are what carry the domain, so the
replacement resumes the same tree.

## What replaced the scribe and the advisor

Neither is an agent. Both duties survive; neither costs a spawn.

- **The scribe's ledger duty** is `orc_run_status` plus `/orchestrate-status`, and the
  provenance half is the extension's passive audit ledger
  (`<artifacts_dir>/audit/<child-id>.bdlog`, one line per child `bd` mutation). There is no
  ledger wisp to drain and no report agent to activate.
- **The advisor is OMP's native watchdog**, bound to the architect by frontmatter
  `advisor: true`. It reviews transcript deltas in band and can never block a call, which is
  exactly the advisory role a spawned advisor approximated at the cost of a session.
- **Escalation that once went to an advisor routes to `agent:researcher`.** The researcher's
  contract is a durable `ADVICE` comment on the bead, read-only. Never spawn an advisor, and
  never answer your own escalation.
- **Product intent was never an advisor's to decide.** It is an `ASK` wisp plus a human gate.

## Capabilities and access

| Role | Writes | Spawns | Notes |
|---|---|---|---|
| Lead | run epics, their metadata, wakes | architects | coordination, `bd`, the `orc_*` tools, the slash commands. Never code, never content |
| Architect | its feature tree, commits, draft PR, decomposition beads | the other four roles, plus helpers | **sole mutator** of its feature worktree; integrates captured task branches by explicit cherry-pick; never merges a PR |
| Implementer | code inside `metadata.scope`, in its isolated copy | nothing | commits; the branch is captured automatically. Never pushes a PR, never merges, never manages a worktree |
| Reviewer | comments and verdicts | nothing | reads the captured branch or the feature tree; "read-only" is enforced by its agent definition omitting `edit` and `write`, not by sandboxing `bd` -- it must write its own verdict |
| Researcher | comments (`ADVICE`), artifacts under `<artifacts>` | nothing | investigation only; never edits code |
| Shepherd | PR state, `pr` and `merge_sha`, fix beads, merge-slot | nothing | the only role that may merge; never edits or pushes content |
| Helper | files in the architect's checkout | nothing | no bead, no commit, no PR, no worktree. Its outcome is promoted to a comment on the feature bead before its trace wisp can be compacted |

Only the architect spawns. Depth is `lead(0) → architect(1) → worker(2)`, which fits inside
`task.maxRecursionDepth: 2`; a worker that spawns is a design error, not a shortcut.

## Choosing between a queue and a spawn

| Situation | Do this |
|---|---|
| The work deserves a bead, review, and a captured branch | create the task bead on `agent:implementer` and dispatch a wave |
| A read-only sweep or a mechanical rename, too small for a bead's round trip | spawn a helper (`scout` for reading, `sonic` for bulk edits) inside your own await, traced by a `ping` wisp |
| A question about the codebase, not a change to it | route it to `agent:researcher` rather than reading it yourself |
| A verdict on work that reported | create the review wisp on `agent:reviewer`; never review what you wrote |
| A landing unit is approved | create the merge bead and spawn the shepherd |

A read-only node goes to the researcher rather than the architect in the first place. On
pure analysis the reading *is* the reasoning, so a delegating layer only adds a hop and
re-reads context the analyst already holds.

## Research fan-out / fan-in

The actor that needs the answer owns the decomposition, and it never reads raw sources
itself.

- **Narrow question:** one researcher, one terse digest.
- **Broad question:** fan out several `@smol` gatherers in one `task` batch, each scoped to
  one source, slice, or sub-question, each returning facts plus refs and nothing raw. Then
  fan in: one `effort: "hi"` researcher dedupes, resolves conflicts, and returns a single
  synthesis with citations. Keep the synthesis; the gatherers are done.

Bound the fan-out width to the sources that matter, and record what was skipped. Gatherers
spawn nothing.

## Escalation ladder

1. **The instance, not the role.** A task that failed on reasoning depth is respawned with
   `effort: "hi"`. Name the attempt that failed and say why it was depth rather than missing
   context, a tooling block, or bad scope -- if you cannot, effort is not the answer.
   `effort` requires `task.enableEffort: true`; without it the escalation silently no-ops.
2. **`BLOCKED kind:design|debug`** creates an escalation wisp linked to the bead, carrying a
   `BLOCKED` comment, and the blocked actor yields. An open escalation wisp pauses the
   author's exit contract rather than failing it, so waiting is not punished. A researcher
   pulls the wisp (`--include-ephemeral`) and answers with `ADVICE`.
3. **A dispute that durable evidence does not settle** gets one fresh read-only researcher
   at `effort: "hi"` on the escalation wisp. Its `ADVICE` is promoted to a comment before
   anyone acts on it.
4. **Product intent, or anything outside the brief,** becomes an `ASK` wisp plus
   `bd gate create --type=human`. No agent decides it.

Never upgrade a whole role to paper over one hard case, and never wait live on a peer at any
rung: record what you need, yield, and let the run wake you.
