# Lifecycle: states, dispatch, review, supervision, ambiguity, cleanup

Agent lifetime and bead state share one vocabulary, tracked on the bead:
`bd set-state <bead> state=<name> --reason "<why>"` plus bead status per the mapping table in
`references/beads-store.md`.

## State diagram

```
                 ┌────────── ASK (question) ──► waiting_human ──(answer)──┐
                 │                                                         ▼
pending ─ready─► working ─(BLOCKED wisp→researcher ADVICE)─► working ─► reported ─► in_review
   ▲ pulled +                                                               │
   │ scope disjoint                             changes_requested ◄─────────┤ verdict=changes
   │                                                    │                   │ verdict=approve
   └──────────── deps closed + scope free ──────────────┘                   ▼
                                                                         approved
                                             git: merge bead → shepherd   │ non-git: evidence accepted
                                    CONFLICT ─► working (rebase)          │
                                                 │                        ▼
                                                 └────────► merged ───► dismissed
                                            (any state) ───────────────► failed
```

A blocked worker leaves the bead in `working`. `BLOCKED` is written on an escalation wisp,
never stored as a bead state.

## Transitions

| Transition | Trigger |
|---|---|
| `pending → ready` | `bd ready --parent <epic> --label agent:<role> --unassigned` reports the bead, no gate is open, and its routing envelope is complete |
| `ready → working` | a worker pulls it: `bd ready … --claim` returns the bead, atomically and first-wins, and the worker adopts what it was given |
| `working → reported` | the worker delivers the evidence its `execution_kind` requires, adds the next role's label, clears its assignee, and comments `REPORTED`. Its commits are already captured on `omp/task/<id>` |
| `reported → in_review` | the architect integrates the captured branch, then creates every review-wisp shell before any reviewer starts |
| `working` (blocked) | the worker writes `BLOCKED` on a linked escalation wisp and yields; a researcher pulls that wisp and answers it with `ADVICE` |
| `changes_requested → working` | the bead returns to its queue with the union of FIX items attached; the next puller applies them |
| `approved → merged` | the last approving reviewer closes the final review wisp and makes the PR ready; the architect creates the merge bead; the shepherd claims it, proves CI and the bot round, serializes on the merge slot, merges, stamps, releases, closes |
| `approved → dismissed` | non-git evidence only: the architect records the accepted evidence, sets `state=dismissed`, and closes |
| `waiting_human` | an agent raised `ASK`. The question is recorded on the bead and the bead is held. A bead not yet started also gets `bd gate create --type=human --blocks <bead>` |
| `waiting_gate` | only an external machine gate remains (CI, a release workflow, a bot round). The bead is parked with the awaited identifier and a resume instruction, and nobody polls it |
| `failed` | unrecoverable: `state:failed` plus status `blocked`, with the error recorded and surfaced |

## Completion paths

The bead's `execution_kind` selects the terminal path, not whether its subject sounds
technical.

| Evidence | Required completion proof | Terminal owner |
|---|---|---|
| `git` | captured branch, commit SHAs, scoped verification, independent review | shepherd closes as `merged` |
| `artifact` | absolute `output_ref`, method, verification, independent evidence review | architect closes as `dismissed` |
| `comment` | bead comment or audit-event ref, verification, independent evidence review | architect closes as `dismissed` |
| `external` | resource identity, read-back or before/after evidence, verification, independent evidence review | architect closes as `dismissed` |

Tracked documentation and configuration changes use `git`. Research, analysis, read-only
review, and external operations may use non-git evidence, and follow the same claim, report,
independent review, fix, approval, and closure states. Non-git work never creates an empty
commit, a placeholder branch, or a fake merge requirement.

## Persistence classes

| Class | Agents | Rule |
|---|---|---|
| Session | the lead | owns the run epics and the marker; restartable from bead state alone |
| Domain | architect | one epic, one Worktrunk feature branch; replaceable mid-epic, because the tree and the beads carry the domain |
| Landing | shepherd | one merge bead, two phases across the CI gate; the second phase is a fresh spawn, not a wait |
| Task-scoped | implementer, reviewer, researcher | claim one bead or wisp, report there, release, exit. Respawn reads the bead, its comments, and its linked wisps |
| Untracked | helper | lives only inside the architect's blocking await; its outcome is promoted to a comment before its trace wisp can be compacted |

An isolated worker parks without a reviver when it finishes, so nothing wakes it: a
replacement pulls the bead instead. A non-isolated architect parks after
`task.agentIdleTtlMs` and *is* revived by a `hub` send, which is why a bounce writes bead
state first and only then rings the doorbell.

A `BOUNCE` comment invalidates that attempt. Repair the durable envelope -- the bead's
scope, evidence requirement, or dependency -- and let a fresh worker pull it. Never continue
the bounced session, never hand it the contract data it failed to produce, and never accept
its later evidence.

## Resume after compaction or crash

1. Find the run epic: `bd list --type epic --json`, matched on `metadata.run_id`, or read the
   binding from `/orchestrate-status`.
2. Read in-flight beads: `bd list --parent <epic> --status in_progress --json`. Each carries
   the actor in `assignee`, the location in `metadata.worktree`/`branch`, and the
   fine-grained `state:` label. Confirm every stamped checkout with `wt list --format=json`;
   a recorded branch with no worktree is recovered by `wt switch <branch> --no-cd
   --format=json`, and the bead is updated when Worktrunk returns a different path.
3. Find surviving code: `git branch --list 'omp/task/*'`, then `git cherry <feature-branch>
   <task-branch>` per branch. A branch printing any `+` holds work that is not integrated,
   whatever the bead says.
4. Run `bd merge-slot check`. Never infer a dead holder from age or from a recycled shepherd.
   Resume the landing transaction, or use its evidence-gated recovery path after proving the
   exact actor lease is dead.
5. Drain the patrol wisp for each epic (below) before dispatching anything new.
6. For GitHub-backed runs, restart the release watcher with `--slots=1` and replay
   unacknowledged records first: `orc_resolve_queue_dispatch` with a `bd list --json`
   snapshot and `replayUnacknowledged`. Only a matching ack suppresses a replay. See
   `references/queue-watcher.md`.

Live actors are not re-activated with a message: a claim already names its bead, and a
replacement pulls the same bead atomically. Waking a parked architect with `hub` is a
doorbell for state that is already durable, never a way to carry content.

## Supervision

Three layers, ordered by immediacy. The first is deterministic extension code with no model
in the loop.

**In-process reaper.** The extension subscribes to the subagent lifecycle bus in every
session that spawns. On a child's terminal event it reads that child's claimed beads, its
metadata, and its `omp/task/<id>` branches, then re-runs *the same contract evaluator the
exit gate uses* against live bead state:

| Case | Condition | Action |
|---|---|---|
| clean exit | `completed`, contract re-check passes, claim released | stamp `metadata.branch` if a captured branch exists; nothing else |
| semantic incompletion | `completed` but the bead is still claimed, or the contract re-check fails | treat as a bounce: `RECLAIM` comment naming the failed checks, assignee cleared, status `open`, `recovered_branch` stamped if commits exist |
| technical death, work exists | `failed`/`aborted` with commits on the branch | `RECLAIM` + unclaim + `recovered_branch`; the branch is the surviving evidence, and the next claimant's bead says to resume from it |
| technical death, no work | `failed`/`aborted`, no commits | `RECLAIM` + unclaim; nothing to recover |

`completed` from the runtime means only "yielded successfully". The contract re-check is what
upgrades it to "work accepted", and it is also what catches the two paths that skip `yield`
entirely: the exit gate's bounce force-allow, and an abort.

**Patrol wisps** cover what the reaper cannot: those subscriptions die with the process. One
patrol wisp per epic is created at run start
(`bd create --ephemeral --wisp-type patrol --deps relates-to:<epic>`) and is the durable
marker that reconciliation is owed. Its contract: run the reaper's sweep from bead state
alone -- cross-check every `in_progress` assignee under the epic against the live roster and
apply the table above -- run the merge-completeness scan, then re-arm. Draining it is the
first duty of the next session or architect to open. Wisps carry no per-wisp TTL; compaction
removes them by policy, so a patrol persists as a restart marker rather than expiring by
surprise.

**Merge-completeness scan.** Integration is cherry-pick, so ancestry proves nothing and
patch-id containment is the primitive:

| Scan result | Bead state | Verdict |
|---|---|---|
| all `-` | terminal | integrated -- delete the branch, stamp `integrated=true` |
| all `-` | open | integrated early -- flag it; the bead belongs in reported or review |
| any `+` | open / `in_progress` | pending integration -- the architect's duty; teardown blocks on it |
| any `+` | closed | inconsistency: closed but unmerged. Comment, treat as a reopen candidate, and surface it in `/orchestrate-status` |

The scan runs on each child terminal event, in the architect's `integrate-branches` teardown
step (the epic must scan clean before `commit-work`), in the patrol contract, and in
`/orchestrate-status`. Branch deletion happens only on the all-`-` plus terminal row:
cleanup is proof-gated, never time-gated.

**`bd stale` plus a human gate** is the backstop, not the mechanism. Deterministic code
records, comments, unclaims, and deletes only proven-integrated branches. It never
auto-commits a dirty worktree, never discards WIP, and never force-deletes an unscanned
branch -- those are agent decisions through `mol-dead-claim-recovery`.

## Dead-claim recovery

Age is a diagnostic, not proof of death. `bd stale --status in_progress` may propose
candidates, but there is no lease expiry and no daemon. Never steal a claim because a
timestamp is old.

1. Read the bead, its comments, the audit trail (`.beads/interactions.jsonl` plus
   `<artifacts_dir>/audit/<child-id>.bdlog`), the actor handle, the branch or worktree, and
   the last verification evidence.
2. Try to resume the actor. Clear ownership only when the runtime reports the handle stopped
   or absent, the actor explicitly releases it, or the user confirms the session is dead.
   Record that evidence before mutating anything.
3. Preserve the worktree, the captured branch, artifacts, comments, and external resource
   references. Do not sweep them during recovery.
4. Record the recovery with a bead comment and an `orc.recover` audit event. There is no
   `bd unclaim`; release and reopen with:

```
bd update <bead> --assignee "" --status open
bd set-state <bead> state=pending --reason "dead claim verified; redispatch"
```

5. Restore one compatible `agent:<role>` label and leave the bead unassigned. The next
   worker claims it atomically and inherits every preserved anchor, including
   `recovered_branch`.

If holder death is uncertain, keep the assignment and record a revisit trigger. That safe
default is what stops two workers from mutating one scope. A contested claim runs
`mol-dead-claim-recovery`, whose `confirm-dead` step is a human gate.

## Failure propagation

- `failed` never satisfies a dependency. A failed bead is `blocked`, never `closed`, so
  dependents stay out of `bd ready`.
- `bd dep tree <bead>` shows every downstream bead stranded by a failure. Replan with a
  replacement bead or abandon the subtree deliberately; never leave the graph silently
  stalled.

## Recycle runtime processes

Every process is restartable because beads, wisps, captured branches, and GitHub are the
source of truth.

- **Architect:** replace it between waves, never mid-integration. The feature branch and the
  bead state carry the domain.
- **Shepherd:** it is already two ephemeral phases. Restart from the merge bead after the
  slot is released, never during a landing transaction.
- **Workers:** never resumed. A dead worker's bead is reclaimed and pulled again.
- **Standalone `pr-shepherd`:** repository-global recovery and queue drain only, when no run
  shepherd owns the landing.

## Human-in-the-loop and safe autonomy

An agent may choose a default autonomously only when every condition is true:

- the action and its effects are reversible;
- the effect is local to one bead and its owned resources;
- the downside and rollback boundary are explicit and bounded;
- the choice is compatible with accepted policy and recorded evidence; and
- the choice preserves user intent rather than selecting or changing it.

Record the ambiguity before applying the default. A cross-boundary choice that existing
evidence fully resolves uses a decision bead. Cross-boundary uncertainty, irreversible
action, external mutation, security/financial/legal risk, or missing user intent is not an
autonomous default. It enters `waiting_human` with one exact question and its impact.

The holding actor adds this comment to the affected bead:

```text
WAITING_HUMAN
owner: <actor responsible for resumption>
scope: <bead and affected resource>
question: <one exact choice the human must make>
impact: <what remains stopped and what each answer changes>
resume: <exact state transition, gate action, and actor to wake>
```

Every field is nonempty. The question cannot delegate discovery back to the human or ask for
general approval. Record `orc.ask`, run `bd set-state <bead> state=waiting_human --reason
"<question summary>"`, and keep status `in_progress`. The resulting `state:waiting_human`
label is the durable hold. A bead that had not started also receives
`bd gate create --type=human --blocks <bead> --reason "<question>"`.

Nobody polls the human or the held worker. Unrelated ready beads continue. On an answer,
promote any message into a work-bead comment or decision bead, resolve the human gate when
one exists, and follow the stored `resume` instruction. A started bead returns to
`state=working`, status `in_progress`. An unstarted bead returns to `state=pending`, status
`open`, and normal dispatch.

## Waiting on an external machine gate

The same rule applies when the wait is on a machine rather than a person: a CI run, a
release workflow, a release PR's checks, a review bot's round, or a long-running reviewer.
Nobody polls it and nobody holds a session open for it.

Park the bead instead. Record what is awaited with `bd set-state <bead> state=waiting_gate
--reason "<what is awaited and how to resume>"`, add `bd gate create --type=gh:run --blocks
<bead> --await-id <run-id>` for a workflow run or `--type=gh:pr --await-id <pr#>` for a PR
merge, then continue unrelated beads from `bd ready`. When nothing else is ready and only
external waits remain, write the run report and exit; the gate bead and the next pass own
the wait. `bd gate check` plus `bd ready --gated` is how the cleared gate re-enters the run.

Two campaign runs violated this on their final release bead: each polled a release workflow
and a package-executing reviewer until the stream aborted, leaving that bead `in_progress`
even though every PR, tag, and release had already landed correctly. A run whose only
remaining work is an external wait must terminate with a clean record, not an aborted
stream.

## Reversible local defaults, revisit, and late evidence

Before applying a reversible bead-local default, write a provisional `LOCAL_DECISION`
comment using the contract in `references/beads-store.md`. Its objective `revisit` trigger
defines when the default becomes stale. A choice affecting another bead, agent, package,
shared contract, ordering rule, or later work uses a decision bead instead.

At the recorded trigger, the owner re-reads the cited evidence before any further use of the
default, then supersedes the provisional comment with an accepted `LOCAL_DECISION`, creates
a decision bead, or enters `waiting_human`. Routing changes only while the bead is
unassigned.

A local choice that changes gets a new comment referencing the old one; no comment is edited
or erased. A cross-boundary change gets a replacement decision bead and explicit
supersession. Duplicate, conflicting, superseded, and partially linked decisions follow the
deterministic rules in `references/decisions.md`; chronology alone never selects policy.

Restart recovery reads work-bead comments, decision beads, their dispositions and links, and
`state:waiting_human` before resuming anything. Wisps and artifacts supply coordination and
evidence only -- an unpromoted material message is not replay authority.

Late evidence follows the same revisit flow. If the affected bead is closed, append the
evidence and disposition to that closed bead or its decision bead. When behaviour must
change, create follow-up work with a `discovered-from` link; do not reopen the completed bead
or rewrite its terminal evidence.

## Incidental bug beads

A worker that trips over a pre-existing defect outside its scope fixes it in passing when
trivial, and otherwise files one bug bead. Filing is a record, not self-dispatch: the worker
keeps its own scope, its own evidence, and its own bead.

Such a bead enters the run routed, or it does not enter it at all. Every queue pulls with
`--parent <epic>` plus one `agent:<role>` label. An unparented or unlabelled bug bead is
invisible to all of them, and it lands in the stranded query, which fails close-out.

| Field | Value |
|---|---|
| parent | the epic the filing worker sits under, so that epic's queues and every `bd list --parent <epic>` close-out scan see it |
| route | exactly one `agent:<role>` label, the role that would do the fix -- `agent:implementer` for a code defect, never `agent:architect` |
| assignee | empty, so the next worker claims it atomically through `bd ready … --claim`. Every queue here is an `--unassigned` pull, so an assigned bug leaves `bd ready` and shows only under `bd list --assignee` |
| provenance | `discovered-from` its finder, plus the label `kind:incidental` |

Merge beads are the one deliberate unparented exception, and a bug bead never copies it.
`discovered-from` does not gate `bd ready`, so that link costs the bead no readiness.

Route it to the role that would fix it, never to `agent:architect`:

- the parent link is how the owning architect sees it. Its own sweeps, `bd list --parent
  <epic>`, and every close-out scan already carry the bead, so a triage label adds no
  visibility.
- `agent:architect` is the queue that hands an architect an epic to own, and a bug bead is not
  an epic.
- fix-role routing degrades safely. An implementer pulls and fixes the bug even when no
  architect triages it, while a bug parked in the architect queue drains on nobody's contract.

The filer does not assign the bead, does not open an epic or feature for it, and does not
`bd dep add` its own bead behind it. The defect is incidental, so blocking on it would stall
work already proven independent of it.

`kind:incidental` separates an adopted bug from the architect's own decomposition. Two carriers
could hold that marker:

| Carrier | Verdict |
|---|---|
| label `kind:incidental` | chosen. `kind:` is an established namespace, and labels are multi-value, so the marker rides the `--labels` flag the route already needs. It reads back with `bd list --parent <epic> --label kind:incidental` |
| `metadata.incidental` | rejected. Single-value, one more key to register in the metadata contract, and read with jq instead of a label filter |

The bead carries no `orc-node` label either. It is nobody's DAG node until an architect adopts
it and adds one.

```
bd -C <run repo> create "<what is broken>" --type bug --parent <epic> \
  --labels agent:implementer,kind:incidental \
  --deps discovered-from:<your-bead> \
  --metadata '{"scope":["<glob>"],"execution_kind":"git","origin":"<your-bead>"}' --silent
```

Then comment `NOTE` with the new id on your own bead, and record `orc.note`. The history then
shows how a bead the architect never decomposed arrived under its epic.

The wake is optional, content-free, and last:

- write the bead, comment on it, then at most ring a doorbell.
- the bead is complete without the message, so a failed send changes nothing. Never retry it,
  and never block on it.
- the message carries no instructions and no description of the bug. The bead is the brief.
- it buys triage while the run is live rather than at close-out, plus the revival of an
  architect parked past `task.agentIdleTtlMs`. One saved round trip, nothing more.

A worker sends nothing. Its own exit is the doorbell: the child terminal event resumes the
architect, which then reads the reporting bead, its `NOTE`, and the `discovered-from` link. The
wake belongs to the lead, or to an architect handing a bug to a sibling architect. Both already
hold the peer id, and neither is about to exit.

| Metadata key | Why a worker cannot address the wake with it |
|---|---|
| `origin` | not an agent id at all. It holds an actor handle on a run epic or a helper bead, and a bead id on a merge bead or a bounced fix. This bug bead stamps the finder's bead |
| `actor` | the agent id, stamped by dispatch and readable with `bd show <epic> --json`. It goes stale the moment the lead replaces an architect, and no worker can check the roster for liveness |

An open incidental bug bead never blocks close-out. It is open, unassigned, and ungated, which
makes it ready. A ready bead is never stranded, never `in_progress`, and never `blocked`. Those
are the conditions that gate reads.

The architect hands it off three ways:

- adopt it into the current decomposition.
- reparent it to the epic that owns that code.
- park it with `bd update <bug> --status deferred`, and name it by id in the run report.
  `deferred` keeps it out of `bd ready`, while its parent keeps it findable.

`bd list --type bug` audits every incidental bug at any time, without touching a queue.

## Cleanup

Three kinds of tree exist, and only one of them is swept:

- **Isolated worker copies** are runtime-owned. They are created and removed by OMP, and
  nothing in this package touches them.
- **Captured branches** (`omp/task/*`) are deleted only when `git cherry` proves every commit
  is already integrated and the bead is terminal. An unscanned branch is never force-deleted.
- **Worktrunk feature worktrees** are inspected with `wt list` and removed with `wt remove`,
  through `scripts/worktree-sweep.sh`. Raw `git worktree` lifecycle commands are denied.

On an architect's death, its feature worktree is triaged through a `recovery` wisp rather
than deleted: the tree may hold uncommitted work worth rescuing. On epic teardown, verify the
Worktrunk state vars are cleared and the worktree is released.

At run end, after every feature tree is reclaimed, run `scripts/worktree-sweep.sh --prune
<primary-repo-path>`. Exit 1 means at least one dirty, valid-but-unregistered, unknown, or
symlink path was refused: inspect those paths and keep the run open instead of forcing
deletion. The dirty primary checkout, the artifacts directory, the beads database, and the
shared build target are never swept.

Stop repository watchers before removing run-local process state, and remove the active-run
marker only after verifying it names this run.
