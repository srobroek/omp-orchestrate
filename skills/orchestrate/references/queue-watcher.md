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
`integration_owner=orchestrate` alongside its `pr:merge` + `agent:integrator` labels, and the
generic shepherd refuses those. That precedence is what stops two merge actors from racing.

## Record identity

`release-queue-watch` defines the `dispatch` and `pr-lifecycle` shapes, the five transitions,
and `lifecycleKey`. Orchestrate adds only this: a dispatch's identity is
`repository#number@headSha`, and readiness admission is not authorization to merge.

## Deterministic routing

For every line:

1. Snapshot the active beads:

   ```text
   bd list --parent <epic> --status in_progress --json > <snapshot>
   ```

2. Call `orc_resolve_queue_dispatch` with `nodesFile: <snapshot>` and `record: <the line>`.
   Despite its name the resolver validates both dispatch and lifecycle records.
3. An exact orchestrate match owns the record. Exit 2 means no orchestrate owner: offer the
   unchanged line once to `pr-shepherd`'s `resolve-queue-event` with an active merge-bead
   snapshot.
4. Exit 3 means ambiguous or invalid orchestrate ownership and must not fall through. Exit 1
   is invalid input. Control records are ignored. Malformed, stale, or ambiguous records
   produce an `orc.note` and no dispatch. Never fan one line to both consumers.

## Ready dispatch receipts

The resolver requires exactly one `state:approved` bead matching `repo`, `pr`, and `head_sha`.

1. Apply all `requiredMetadata` in one `bd update`. A new dispatch atomically stamps
   `queue_dispatch` and `queue_dispatch_pending`.
2. Write the durable handoff on the merge bead, then wake:

   ```text
   APPROVE <bead>
   branch: <metadata.branch>
   base: <metadata.base_sha>
   source: release-queue-watch
   repo: <repository>
   pr: <number>
   head: <headSha>
   dispatch: <identity-key>
   ```

3. The wake is a spawn of `orc-shepherd`, or a content-free `hub` send to a live one. Stamp
   `queue_dispatch_sent=<identity-key>` only after the wake is accepted. The shepherd
   validates the matching pending or sent receipt and stamps
   `queue_dispatch_ack=<identity-key>` before it revalidates anything authoritative.
4. `status=replay` reuses pending or sent receipts; apply any emitted legacy normalization
   first. `status=duplicate` already has a matching ack and is not re-sent.

Pending, sent, and ack are monotonic receipts. A late sent update must not erase an ack.
Every receipt present for the current dispatch must carry its exact identity key. Do not
replace an unacknowledged dispatch with a later record: the resolver exits 3 on crossed or
mismatched receipts. Acknowledgment records delivery, never merge permission.

## Lifecycle receipts

Lifecycle resolution matches one active orchestrate bead by `repo` and `pr`. A head mismatch
is reported as `headChanged` and is never trusted as the new anchor until the shepherd
confirms it against GitHub.

- Approved beads and `failed`, `merged`, or `closed` transitions set `wakeShepherd=true`.
  Persist `queue_lifecycle`, `queue_lifecycle_transition`, `queue_lifecycle_head`, and
  `queue_lifecycle_pending` atomically, then write the same `APPROVE` block with
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

A shepherd's own startup scan also resumes acknowledged, approved, unmerged beads, so a lost
wake is not a lost landing.

REST reconciliation belongs to the watcher, and initial reconciliation may emit records before
`watcher-active`. On `webhook-error`, `reconcile-error`, malformed output, or watcher exit,
surface the error and run one explicit `bd gate check` plus the existing shepherd pass.
Restart or stop the watcher; never start a duplicate CI polling loop, and never infer green or
merged state from silence.

Stop the watcher during run cleanup.
