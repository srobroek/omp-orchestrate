# Release queue watcher handoff

Orchestrate's side of the watcher handoff. `release-queue-watch` owns the sensor itself:
start mechanics, record shapes, transition semantics, and `lifecycleKey` are defined once in
its own `references/runtime.md`. Read that for the emitter contract; this file covers only
what orchestrate does with a record.

Orchestrate resolves its own beads first. A record with no orchestrate owner may route once
to `pr-shepherd`.

## Start and ownership boundary

Start the watcher as `release-queue-watch` documents, with `--slots=1`. Consume records
serially: do not read the next line until the current receipt is durable. One watcher slot
bounds outstanding readiness notifications. It is not the beads merge lock.

| Concern | Owner |
|---|---|
| Signature verification, debounce, PR ranking, REST repair | `release-queue-watch` |
| Orchestrate bead lookup and dispatch | the lead session |
| Unmatched generic merge-bead lookup | `pr-shepherd` resolver |
| Orchestrate PR/head revalidation | `orc-shepherd` |
| Generic PR/head revalidation | `pr-shepherd` |
| Exclusive integration lock | `bd merge-slot`, held by the acting shepherd |

An exact active orchestrate bead owns its PR. Every merge bead this run creates carries
`integration_owner=orchestrate` alongside its `pr:merge` label and `role=shepherd` metadata,
and the generic shepherd refuses those. That precedence is what stops two merge actors from
racing.
Live ownership includes `open`, `in_progress` and `blocked` beads marked either
`orc-node` or both `pr:merge` and `metadata.integration_owner=orchestrate`.
Exactly one node and one marked `role=shepherd` merge bead for the same PR transfer
integration ownership to the merge only when its `origin_bead` equals that node's id
or explicit parent. The merge's own status, approval and head govern eligibility.
Dispatch, lifecycle and replay then target only the merge; source receipts remain
history and do not replay. Multiple nodes/merges, three or more candidates, or missing
or contradictory lineage remain ambiguous and fail closed.
Only a candidate missing both repository and PR with no queue receipt is never-owned;
partial or malformed identity fails closed.

## Record identity

`release-queue-watch` defines the `dispatch` and `pr-lifecycle` shapes, the five transitions,
and `lifecycleKey`. Orchestrate adds only this: a dispatch's identity is
`repository#number@headSha`, and readiness admission is not authorization to merge.

## Deterministic routing

For every line:

1. Snapshot the whole beads workspace, including unparented merge beads:

   ```text
   bd list --status all --json > <snapshot>
   ```

2. Call `orc_resolve_queue_dispatch` with `nodesFile: <snapshot>` and `record: <the line>`.
   Despite its name the resolver validates both dispatch and lifecycle records.
3. Resolve the live `open`, `blocked` or `in_progress` owner by canonical repository and PR first.
   Exit 2 positively establishes no orchestrate owner: offer the unchanged line once to
   `pr-shepherd`'s `resolve-queue-event` with an active merge-bead snapshot.
4. Exit 3 means an existing owner is stale, unapproved, malformed or ambiguous and must
   not fall through. Exit 1 is invalid input. Control records are ignored. Invalid
   ownership produces an `orc.note` and no dispatch. Never fan one line to both consumers.

## Ready dispatch receipts

The resolver first requires exactly one live orchestrate owner matching canonical
`repo` and `pr`, then requires that owner to be `in_progress`, carry `state:approved`
and match the dispatch's exact `head_sha`. A parked owner or failed approval/head
check does not erase ownership and never permits generic-shepherd fallback.
Lifecycle records still route to a parked owner; terminal beads do not own records.

1. Apply all `requiredMetadata` in one `bd update`. A new dispatch atomically stamps
   `queue_dispatch` and `queue_dispatch_pending`.
2. Write the durable handoff on the resolved canonical owner, then wake:

   ```text
   NOTE <bead>
   branch: <metadata.branch>
   base: <metadata.base_sha>
   source: release-queue-watch
   repo: <repository>
   pr: <number>
   head: <headSha>
   dispatch: <identity-key>
   ```

3. The wake is a spawn of `orc-shepherd`, or a content-free `hub` send to a live one.
   A spawn may identify the durable receipt, never assign ownership through its prompt.
   Stamp `queue_dispatch_sent=<identity-key>` only after the wake is accepted.
   Before claiming, the shepherd takes a fresh complete workspace snapshot and resolves
   the stored dispatch again, requiring the same canonical owner, repository, PR and
   exact approved head. Validate `role=shepherd`, run membership, scope, checkout and
   actor identity. An owner routed to another role remains owned: report BLOCKED to its
   architect for the established linked merge handoff, without rewriting role, status,
   assignee or labels and without generic fallback.
   A same-actor `in_progress` claim may be resumed directly only after operational
   proof that this activation exclusively controls that actor. Another live holder
   requires release/recovery under `lifecycle.md`; a receipt never authorizes
   impersonating that holder. An unassigned `in_progress` owner is NOT directly
   claimable: Beads rejects it with `issue not claimable: status in_progress`.
   For that case, the lead or owning architect must perform the exclusive
   reconciliation below. Then, or for the validated same-actor resume, the designated
   shepherd runs one standalone foreground acquisition:

   ```text
   BEADS_ACTOR=<metadata.actor> BD_ACTOR=<metadata.actor> bd update <exact-owner-id> --claim --json
   ```

   Do not use `bd ready --unassigned --claim` for this dispatch or its reconciliation.
   Keep the run's BEADS_DIR unchanged and
   `bash.autoBackground.enabled=false`; no pipes, extra commands or async execution.
   Observe the successful unmodified claim result, then freshly resolve the stored
   dispatch against the whole workspace and re-read all current receipts. Require
   the same canonical owner, restored `in_progress`, your assignee, approval, head
   and exact receipt keys before stamping `queue_dispatch_ack=<identity-key>`.
   Changed authority, another holder or missing claim evidence means BLOCKED, not
   NO_WORK or a substitute target.
   Only then revalidate GitHub head, base, review, dependencies and checks for landing;
   repeat authoritative checks under the merge slot and merge with the exact head guard.
4. `status=replay` reuses pending or sent receipts; apply any emitted legacy normalization
   first. `status=duplicate` already has a matching ack and is not re-sent.

Pending, sent, and ack are monotonic receipts. A late sent update must not erase an ack.
Every receipt present for the current dispatch must carry its exact identity key. Do not
replace an unacknowledged dispatch with a later record: the resolver exits 3 on crossed or
mismatched receipts. Acknowledgment records delivery, never merge permission.

### Unassigned approved-owner reconciliation

This is an exact receipt handoff, not a return to the ordinary ready queue. The
shepherd must not reopen the owner on a fresh read alone.

1. The lead or owning architect establishes an operationally exclusive window:
   stop or exclude every other claim, status, dispatch, receipt, supervision and branch
   writer that could affect this owner. Keep that exclusion through the designated
   shepherd's observed acquisition and final authoritative re-read. A fresh read,
   an old actor timestamp, human consent or the merge slot alone is not exclusion.
   If exclusion cannot be established, preserve the bead and report BLOCKED.
2. Inside that window, resolve the stored dispatch against a fresh complete snapshot.
   Require the exact canonical owner to remain unassigned, `in_progress`,
   `state:approved`, `role=shepherd`, and unchanged in repository, PR, head, scope,
   run and actor identity. Record the exact receipt and status-only reconciliation
   as a durable NOTE. Preserve approval, evidence, dependencies, routing, receipts,
   assignee and every branch/resource anchor.
3. Only the coordinator changes status with `bd update <exact-owner-id> --status open`,
   using its own attributed identity. Do not clear an assignee or call `set-state`;
   do not wake an ordinary puller. This transient `open` is not resolver admission.
   While every competing writer remains excluded, the designated shepherd executes
   the exact standalone named claim above under its validated actor identity.
4. Observe successful claim JSON, then freshly resolve the stored dispatch against
   the whole workspace. Require the same canonical owner and receipt authority,
   restored `in_progress` and the intended actor's assignee. Only then acknowledge
   delivery and release exclusion. All normal GitHub, dependency and merge checks
   still apply; the transient reopen authorizes no code work or landing.
5. On an acquisition error or interruption, retain exclusion and inspect the actual
   owner before deciding. If still unassigned and transiently `open` with the same
   receipt authority, the coordinator restores only status to `in_progress` before
   releasing exclusion. If a claim succeeded, preserve it and reconcile its observed
   result; never clear it as rollback. Changed authority or lost exclusion means
   unresolved recovery: no blind restoration, release, acknowledgment or retry.

## Lifecycle receipts

Lifecycle resolution matches one active orchestrate bead by `repo` and `pr`. A head mismatch
is reported as `headChanged` and is never trusted as the new anchor until the shepherd
confirms it against GitHub.

- Approved beads and `failed`, `merged`, or `closed` transitions set `wakeShepherd=true`.
  Persist `queue_lifecycle`, `queue_lifecycle_transition`, `queue_lifecycle_head`, and
  `queue_lifecycle_pending` atomically, then write the same handoff block with
  `source: release-queue-watch-lifecycle` plus `transition:` and `lifecycle:` lines, and wake
  the shepherd. Stamp `queue_lifecycle_sent` after the wake; the shepherd stamps
  `queue_lifecycle_ack` only after it revalidates and records the outcome.
- `opened` or `updated` on an unapproved bead is informational. Persist the resolver's atomic
  `queue_lifecycle_ack` and wake no merge actor.
- A stale failure is a no-op after revalidation. A confirmed failure routes back to the
  architect as an unassigned fix bead. For a confirmed external merge, the approved head must
  still equal GitHub's head; the shepherd verifies the actual merge SHA and closes only on
  final-base ancestry or exact-content proof. A confirmed close-without-merge is reported, not
  silently treated as merged.
- A lifecycle wake never acquires the merge slot and never merges. Entering the merge path
  needs a separate valid dispatch. Even when the bead already stores an older dispatch, finish
  and acknowledge the lifecycle handling first and resume the dispatch in its own pass.

## Crash recovery and fallback

Before reading new watcher output on start or resume, call `orc_resolve_queue_dispatch` with
`nodesFile: <snapshot>` and `replayUnacknowledged: true`. Replay the returned `dispatches`
and `lifecycles` after applying any non-empty `requiredMetadata`. Invalid persisted identity
stops that replay: log it rather than guessing. A current key holding a receipt for another
key, or a new record arriving before the current key is acknowledged, is invalid ownership
state.

A shepherd's startup scan also examines current durable dispatch receipts on acknowledged,
approved, unmerged owners. Resume one exact owner through the same fresh resolution and
named acquisition above; an acknowledged receipt is not permission to skip those checks.
No matching receipt work leaves the ordinary role-specific ready pull unchanged.

REST reconciliation belongs to the watcher, and initial reconciliation may emit records before
`watcher-active`. On `webhook-error`, `reconcile-error`, malformed output, or watcher exit,
surface the error and run one explicit `bd gate check` plus the existing shepherd pass.
Restart or stop the watcher; never start a duplicate CI polling loop, and never infer green or
merged state from silence.

Stop the watcher during run cleanup.
