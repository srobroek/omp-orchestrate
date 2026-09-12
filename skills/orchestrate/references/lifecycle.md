# Lifecycle: states, dispatch, wakes, review, supervision, ambiguity, cleanup

Agent lifetime and bead state share one vocabulary, tracked on the bead: `status`,
`assignee` and labels hold the state, and one comment verb records each transition. The
phase table in `references/beads-store.md` says how a reader derives the finer phase.

## State diagram

```
                 ┌────────── ASK (question) ──► waiting_human ──(answer)──┐
                 │                                                         ▼
pending ─ready─► working ─(BLOCKED wisp→researcher NOTE)─► working ─► reported ─► in_review
   ▲ pulled +                                                               │
   │ scope disjoint                             changes_requested ◄─────────┤ verdict=changes
   │                                                    │                   │ verdict=approve
   └──────────── deps closed + scope free ──────────────┘                   ▼
                                                                         approved
                                             git: merge bead → shepherd   │ non-git: evidence accepted
                          BOUNCED reason=conflict ─► working (rebase)     │
                                                 │                        ▼
                                                 └────────► merged ───► dismissed
                                            (any state) ───────────────► failed
```

A blocked worker leaves the bead in `working`. `BLOCKED` is written on an escalation wisp,
never stored as a bead state.

## Transitions

| Transition | Trigger |
|---|---|
| `pending → ready` | `bd ready --parent <epic> --metadata-field role=<role> --unassigned` reports the bead, no gate is open, and its routing envelope is complete |
| `ready → working` | a worker pulls it: `bd ready … --claim` returns the bead, atomically and first-wins, and the worker adopts what it was given |
| `working → reported` | the worker stamps pre-yield evidence (`head_sha` for git) and the handoff label, writes `REPORTED`, then releases with a single `bd update <id> --assignee ""`. The release comes last: it clears the ownership every other write on the bead is checked against, and only the terminal comment is admitted after it. Successful task completion then captures the parent-side branch; failed completion may leave no capture |
| `reported → in_review` | the architect collects the successful terminal task result, verifies the captured branch and head, integrates it, then creates review-wisp shells. A pre-yield report alone is not capture proof |
| `working` (blocked) | the worker writes `BLOCKED` on a linked escalation wisp and yields; a researcher pulls that wisp and answers it with a `NOTE` on the node |

| `changes_requested → working` | after all required verdicts arrive, the architect follows the requeue procedure below to reopen the node unassigned; a fresh worker claims it and applies the combined findings |
| `approved → merged` | the last approving reviewer closes the final review wisp and makes the PR ready; the architect creates the merge bead with `pr` and the reviewed `head_sha`; the plugin's landing sweep merges it at that head and writes `LANDED <sha>` |
| `approved → dismissed` | non-git evidence only: the architect records the accepted evidence and closes with `--reason dismissed` |
| `waiting_human` | an agent raised `ASK` on the bead and set its status `blocked`. The question is recorded in that comment. A bead not yet started also gets `bd gate create --type=human --blocks <bead>` |
| `waiting_gate` | only an external machine gate remains (a release workflow, a bot round). A gate bead blocks the work bead, `BLOCKED` names it and how to resume, the claim is released, and nobody polls it. CI on a merge bead's PR is not a gate: the landing sweep observes it |
| `failed` | unrecoverable: status `blocked` plus a `FAILED` comment, with the error recorded and surfaced |
The lead has the same terminal duty as a claimed worker: it must finish or explicitly terminate every held bead before its session settles. Because the lead has no `yield` tool, G4 cannot intercept an incomplete final turn; the lead-exit watch checks the bound run and claim state after `agent_end`, then gives the lead up to three follow-ups when its final text has no terminal grammar verb. The lead must finish the held work and end with a terminal verb, or write `ESCALATED`/`BLOCKED` with the reason required by the grammar.

Review and escalation evidence is version-bound when either endpoint names a version.
Stamp `head_sha=<value>` and `review_round=<value>` on linked-node `REVIEW`/`NOTE`
comments using the claimed wisp's fields, falling back per field to the linked node.
Omit a token only when neither endpoint carries it.

An answered escalation ends only after the researcher verifies both `NOTE` writes,
closes and releases its wisp, then notifies the architect. The architect collects
the paused worker's actual terminal result and any successful capture. Resuming
unfinished work requires the reaper to release its retained claim under the lease;
neither a ping nor wisp closure automatically requeues it.

## Completion paths

The bead's `execution_kind` selects the terminal path, not whether its subject sounds
technical.

| Evidence | Required completion proof | Terminal owner |
|---|---|---|
| `git` | captured branch, commit SHAs, scoped verification, independent review | the landing sweep closes as `merged` |
| `artifact` | absolute `output_ref`, method, verification, independent evidence review | architect closes as `dismissed` |
| `comment` | bead comment or audit-event ref, verification, independent evidence review | architect closes as `dismissed` |
| `external` | resource identity, read-back or before/after evidence, verification, independent evidence review | architect closes as `dismissed` |

A same-PR merge fix stays nonterminal until actual landing. After verifying captured
fix integration, independent approval and CI at the current exact PR head, the
architect removes only the merge-to-fix `blocks` edge and re-stamps the merge bead's
`head_sha`, preserving provenance. The landing sweep then lands the PR and closes the
fix with verified merge evidence. A separate prerequisite PR retains its normal
close-before-ready dependency.

Tracked documentation and configuration changes use `git`. Research, analysis, read-only
review, and external operations may use non-git evidence, and follow the same claim, report,
independent review, fix, approval, and closure states. Non-git work never creates an empty
commit, a placeholder branch, or a fake merge requirement.

### Review and merge handoff

After verifying terminal capture and integrating branches, the architect creates all
required review-wisp shells before dispatch and opens the PR as a draft. Choose dimensions
for material risks and project policy, not a mandatory specialist roster. Reviewers remain
independent.

Two edges hold the handoff:

- The draft is the interlock. The merge eligibility probe ignores drafts, so nothing can
  land before review.
- Readiness follows every required verdict, never a fix round alone. The final approving
  reviewer closes the final wisp and makes the PR ready; that edge keeps an unreviewed PR
  from going ready.

For CHANGES:

1. Collect every required dimension's verdict at the current head and review round.
   Any `changes` verdict requires a fix round; preserve the union of actionable findings.
2. Collect the prior writer's terminal result and preserve its capture and evidence
   anchors. A live writer cannot hand its node to a replacement. An unresolved retained
   claim is released only by the reaper, per `Dead-claim recovery` below.
3. Preserve the owning epic, scope and implementer route. Re-read current ownership;
   with the prior writer terminal and its claim released, set the node to `status=open`
   with an empty assignee: `bd update <node> --status open --assignee ""`.
4. Dispatch a fresh implementer to pull its queue, never activate it with a bead-id
   message. A changed head starts a new review round.

A `REVIEW … verdict=changes` comment records the review disposition, not readiness to
claim. The node stays `in_progress` and out of `bd ready` until the explicit reopen.

Create the merge bead with label `pr:merge`, metadata `role=shepherd`, and no parent.
Do not use type `merge-request`: it is a ready-filter alias, not a creatable type.
Stamp `repo` (`owner/name`), `pr`, `head_sha` (the reviewed head), `branch`, `base_sha`,
`origin_bead`, `integration_owner=orchestrate`, `bot_same_issue_limit=3`, an empty
`bot_issue_attempts` map, `bot_round_limit=6`, `bot_rounds_completed=0`, and a
`bot_review_requests` provider-to-mode object. Keep the request object empty unless the
originating work, repository policy, or a recorded material-risk decision requires a
provider second opinion. `origin_bead` names the source node or its explicit parent;
preserve that parent in ownership snapshots. Source approval does not transfer. While
retaining sole PR-update ownership, the architect requests every configured provider at
the exact head and records the request result before dispatching the shepherd.

### Landing

The plugin lands. `/orchestrate-bind` probes the repository once (`autoMergeAllowed`,
`squashMergeAllowed`, branch protection and rulesets, merge queue) and records the
result on the run epic as `metadata.landing`. Mode `auto` needs auto-merge allowed and at
least one required check; every other repository is `direct`. Every 60 s the lead's
landing sweep reads the open, unblocked merge beads, polls their PRs with one `gh pr
list` per repository, and acts:

| Observation | Action |
|---|---|
| `MERGED` | stamp `merge_sha`, write `LANDED <sha>` on merge and origin, close the merge bead. A head other than `head_sha` lands as `LANDED ... UNGUARDED` with a review note on the origin |
| `CLOSED` unmerged | `BOUNCED reason=closed`, status `blocked` |
| draft, `UNKNOWN`, checks running | wait, write nothing |
| head is not `head_sha` | `BLOCKED` once; the architect re-reviews and re-stamps `head_sha` |
| `CLEAN` at `head_sha`, checks green | `auto`: `gh pr merge --auto --squash --match-head-commit <head>`; `direct`: `gh pr merge --squash --match-head-commit <head>`, then read the merge back |
| `DIRTY` or `BEHIND` | `git merge-tree` precheck in a throwaway bare clone. Clean: commit the merged tree, fast-forward push it to the PR branch, stamp the new `head_sha`, `NOTE landing refreshed`. Conflicts: an implementer fix bead under the origin's feature, `blocks` the merge bead, `discovered-from` the origin; `role=architect` when a conflicting path leaves the origin's scope. `BOUNCED reason=conflict` |
| a required (or, with none required, any) check failing | `gh run rerun --failed` once per head, then an implementer fix bead with the check, run and `--log-failed` pointer. `BOUNCED reason=ci` |
| `BLOCKED` by branch rules with checks green | `BLOCKED` once, naming the rule class |

The sweep never merges with `--admin`, never force-pushes, and never arms `--auto` on a
repository without a required check: there `gh` merges at once, `UNSTABLE` included. A
fix bead's `blocks` edge keeps the sweep off the merge bead until the fix closes; the
architect then re-stamps `head_sha` and the next sweep lands. Attention states write
one `BLOCKED` per cause. Every terminal writes one verb: `LANDED <sha>` or `BOUNCED
reason=<cause>`.
 
### Automated review loop

The architect owns automated review requests; the shepherd owns observation. Neither
holds a watcher agent open. LOAD `review-providers.md` before configuring or requesting
a provider. The request tool accepts only allowlisted commands, verifies the exact head,
and uses provider/mode/head markers for replay-safe deduplication. The tool does not lock
GitHub comments, so the architect serializes calls under sole PR-update ownership. The
shepherd requires the probe's request marker for each configured provider and probes that
provider separately. For ten minutes from `requestedAt`, an absent, pending or stale result
is a wait: the shepherd records BLOCKED naming the provider and releases; after ten minutes
without provider evidence, BLOCKED names the missing evidence instead. Missing
markers or timestamps are BLOCKED. Manual requests, clean verdicts and external waits do
not increment remediation rounds.

For an actionable round, collect every configured bot before routing one fix bead. Use
the GitHub review-thread node id as the issue identity. When a finding has no thread, use
its review URL plus a stable fingerprint of bot, path, location and finding. Each entry
in `metadata.bot_issue_attempts` counts completed fixes for that issue and begins at zero.
`metadata.bot_rounds_completed` counts integrated and pushed bot-fix rounds for the PR
and begins at zero. Missing, invalid or non-positive limits resolve to three same-issue
fixes and six total rounds.

Before creating a fix bead, call `orc_review_round_policy` with total completed rounds
and only issues actionable in the current exact-head round. A `decision=escalate`
result produces ESCALATED instead of another fix. An invalid result is BLOCKED. The
escalation record names the exhausted bound, completed rounds, issue identities,
attempts, prior heads, fix beads, thread URLs, and the `ASK` fields: one human question,
its impact and the resume transition. Set the merge bead's status to `blocked`, preserve
the PR and feature tree, and notify `Main` through `hub` with only the merge bead id. No
unrelated queue waits.

When both limits permit a fix, the shepherd records BOUNCED, creates one unassigned fix
bead for the aggregated round, and wakes the owning architect with the bead id. When two
shepherds raced and both created one, the oldest open fix bead stands and the newer closes
as a duplicate. The architect dispatches a fresh implementer through the queue. After
capture, the architect
integrates and pushes the fix, increments `bot_rounds_completed` once, increments each
addressed issue count once, replies where a rejection needs evidence, resolves addressed
threads with GitHub's `resolveReviewThread` mutation, and reads back `isResolved=true`.
Record the resolved thread ids and new head before removing the same-PR merge blocker.
Before waking the shepherd, the architect requests configured manual providers for the
new exact head and re-stamps the merge bead's `head_sha`. The next shepherd pass verifies
those markers and probes every bot; the landing sweep lands the PR.

## Persistence classes

| Class | Agents | Rule |
|---|---|---|
| Session | the lead | owns the run epics and the marker; restartable from bead state alone |
| Domain | architect | one epic, one Worktrunk feature branch; replaceable mid-epic, because the tree and the beads carry the domain |
| Landing | the plugin's landing sweep; the shepherd only for a bot round | one merge bead; the sweep is a 60 s timer in the lead session, the shepherd one ephemeral pass |
| Task-scoped | implementer, reviewer, researcher | claim one bead or wisp, report there, release, exit. Respawn reads the bead, its comments, and its linked wisps |
| Untracked | helper | runs inside its spawner's awaited job; architect outcomes are promoted to feature comments before trace compaction. A task receipt is not completion; the parent must collect the terminal result before mutating a shared checkout |

An isolated worker gets no wake when it finishes: nobody sends to it, and a replacement pulls
the bead instead. A non-isolated architect parks after `task.agentIdleTtlMs` and *is* revived
by a `hub` send.

An exit allowed after the local refusal budget is not accepted work and does not release
the claim. Inspect the terminal result and durable evidence; the reaper releases a dead
holder's claim under the lease (`Dead-claim recovery` below), and nothing else does.

## Wakes and messages

An agent performs every wake. The extension has no IRC API (`src/watchers.ts:553-555`), so
its own live half is one notice in the lead's transcript. No code rings a doorbell for you.
If no agent sends, nobody wakes.

State lands on the bead or the wisp first. The send only saves a round trip. `hub` writes
your message into the recipient's transcript, never onto the work. A replacement claiming
that bead reads the bead, its comments, and its wisps, never its predecessor's transcript. A
wake carrying the only copy of a decision is a data-loss bug. Promote it, then ring.

A bounce shows the order. The shepherd creates the fix bead unassigned and routed, parks the
merge bead behind it, and comments both dispositions. It wakes the `metadata.origin_actor`
architect last, and that send carries no content. Every step before it already holds the
whole truth.

Siblings address each other directly. A researcher answers the implementer that asked. A
worker filing a cross-epic bug wakes the architect that owns the code. Neither message
travels through the parent that spawned the sender, and a relay hop only adds one more place
to lose the answer.

`hub` is a tool taking an `op`, never a shell command. `op: "list"` reads the roster, and
`op: "send"` delivers. Every role here holds `bash`, so prose that reads like a command line
invites a command that does not exist.

The roster lists live peers and omits only the caller. An agent cannot find its own handle
there: it reads that off the `Your id is <name>` line its parent injects at spawn. An
implementer stamping `origin_actor` on a wisp it raises is writing that handle.

## Resume after compaction or crash

1. Find the run epic: `/orchestrate-status` prints the marker binding, the epic's
   liveness, and the lead lease (`lead_actor`, `lease_until`); or `bd list --type epic
   --json`, matched on `metadata.run_id`.
2. Read in-flight beads: `bd list --parent <epic> --status in_progress --json`. Each carries
   the actor in `assignee`, the location in `metadata.worktree`/`branch`, its lease in
   `metadata.lease_until`, and its last verb in `bd comments`. Confirm every stamped
   checkout with `wt list --format=json`.
3. If a stamped path is missing or the runtime root mismatches, execute `planning.md`'s
   **Canonical checkout recovery**. Inventory the owning epic's stamped branch/path and WT
   rows first; preserve an existing dirty resumed checkout, captures, terminal results, and
   all evidence. Recreate only a missing checkout with `wt -C "<source-root>" switch
   "<branch>" --no-cd --format=json`, use its returned JSON `path` as the canonical
   worktree, and reject an unresolved or foreign WT bead binding. A missing Git object or
   capture is a separate setup failure, not cwd repair.
4. Stamp the updated `metadata.worktree` and WT `bead` binding for the exact owning epic,
   read both back, and require equality before actor re-entry. Do not release a retained
   claim merely to relocate; a mismatch preserves the claim, checkout, capture, terminal
   result, and evidence. Re-enter only through the rooted `omp --cwd
   "<canonical-worktree>" --config "<run-overlay>"` procedure in `planning.md`, with the
   same absolute `ORCHESTRATE_MARKER_FILE`.
5. Find surviving code: `git branch --list 'omp/task/*'`, then `git cherry <feature-branch>
   <task-branch>` per branch. A branch printing any `+` holds work that is not integrated,
   whatever the bead says.
6. Claims whose holder died with the old lead's process are the adopting lead's to release:
   `/orchestrate-bind <epic>` takes over a lapsed lead lease, and `/orchestrate-resume`
   (wave 3.3) then releases each in-flight claim whose lease has lapsed, on the lease alone.
   Until it exists, release such a claim by hand only after reading `lease_until` fresh and
   finding it lapsed: `bd update <bead> --actor <holder> --claim --assignee "" --status
   open`, then a `RECOVERED` comment. A live lease is a live holder until it lapses.

Live actors are not re-activated with a message: a claim already names its bead, and a
replacement pulls the same bead atomically. A parked architect needs a wake, under the rules
in `Wakes and messages` above.

## Supervision

Two layers, ordered by immediacy. The first is deterministic extension code with no model
in the loop.

**In-process reaper.** The extension subscribes to the subagent lifecycle bus in every
session that spawns. On a child's terminal event it reads that child's claimed beads and
wisps (`bd list --assignee <child> --include-infra --include-gates`), its `omp/task/<id>`
branch, and this process's agent registry, then re-runs *the same contract evaluator the
exit gate uses* against live bead state:

| Case | Condition | Action |
|---|---|---|
| clean exit | `completed`, contract re-check passes, claim released | nothing written, whether or not a branch was captured; the branch state is logged |
| paused writer | positively open linked escalation | claim preserved, nothing written; the escalation is the record |
| died | `failed`/`aborted` | fenced release as the holder (`--claim --assignee "" --status open`), `recovered_by` and `recovered_branch` stamped, one `RECOVERED` comment naming the frame, the registry state and the branch (`found`, `absent`, `stale`, or `unknown`; absence is not proof of no work) |
| completed, contract unmet, holder `aborted` in this process's registry | fresh read says `lease_until` has lapsed | the same fenced release and `RECOVERED` |
| completed, contract unmet, holder `idle`/`parked` | registry says revivable | claim preserved, nothing written, one notice in the spawner's transcript |
| completed, contract unmet, holder absent from this process's registry, or lease live, or contract unreadable, or bead `blocked`/`deferred` | liveness unknown, or the fence cannot pass | `NOTE claim preserved` naming the registry state and the lease; no owner, status or metadata changed |

`completed` means successful task termination, not accepted work. Parent-side capture
exists only after successful completion and can include uncommitted delta. Failed isolated
runs may lose local commits and uncommitted work. The reaper never touches branches,
worktrees, or captured refs. Each child is reaped once per session: a revived agent's
follow-up turns re-emit the terminal frame, and a parked architect is not re-noticed on
every wake. When the run's liveness cannot be read at a child's exit, the reaper skips and
sends an `orchestrate-recovery` notice saying nothing was released.

**Leases** cover process death. Every claim carries `metadata.lease_until`, renewed by the
plugin on the holder's tool activity (`bd update <bead> --actor <holder> --claim
--set-metadata lease_until=<now+TTL>`, at most once per `ORC_LEASE_RENEW_MS`, default 5
min; TTL `ORC_LEASE_TTL_MS`, default 15 min). The `--claim` fence means only the holder
can extend a lease and a release loses to a successor's claim. A lapsed lease alone
releases nothing: the spawner that holds the claimant in its registry decides, and a
holder absent from that registry is unknown, never dead. The lead holds the same lease
on the run epic (`lead_actor`, `lease_until`), renewed on its own activity; a second lead
cannot bind while it is live, and `/orchestrate-status` prints it.

**Merge-completeness scan.** Integration is cherry-pick, so ancestry proves nothing and
patch-id containment is the primitive:

| Scan result | Bead state | Verdict |
|---|---|---|
| all `-` | terminal | cleanup candidate; only the architect, after this scan, may delete and stamp integration |
| all `-` | open | integrated early -- flag it; the bead belongs in reported or review |
| any `+` | open / `in_progress` | pending integration -- the architect's duty; teardown blocks on it |
| any `+` | closed | inconsistency: closed but unmerged. Comment on the bead and treat it as a reopen candidate; the comment is the record, since neither `/orchestrate-status` nor `orc_run_status` runs the scan |

The architect runs the scan before teardown. Only the architect stamps integration or
deletes branches, after re-reading terminal state and patch containment; the reaper never
does. Unreadable containment preserves the branch and reports unresolved cleanup.

## Dead-claim recovery

The reaper releases dead claims; agents do not. A release needs one of two proofs: the
holder's own terminal frame (`failed`/`aborted`) in the session that spawned it, or that
session's registry reporting the holder `aborted` plus a fresh read showing `lease_until`
lapsed. Age alone is neither: `bd stale --status in_progress` proposes candidates, and a
lapsed lease on a holder no registry knows is an unknown, not a death.

The fence bounds the worst case rather than preventing it. `--claim` conditions on the
assignee, not on a lease version, so a live holder released in error either re-claims on
its next renewal (one stray `RECOVERED`) or loses to a new claimant and is stopped by the
worktree-scope gate's ownership check. Both are visible on the bead.

What a release leaves behind: the bead `open` and unassigned, `metadata.recovered_by`,
`metadata.recovered_branch` when the repository showed `omp/task/<holder>`, and a
`RECOVERED <holder> <cause>` comment carrying the branch and contract evidence. Worktree,
captured branch, artifacts, comments and external references are untouched. Requeue is
implicit: the next `bd ready --claim` offers the bead, and the claimant inherits every
preserved anchor including `recovered_branch`.

What the reaper leaves alone, and why: a `blocked` or `deferred` bead (bd refuses
`--claim` on it, so the fence cannot pass; a human unblocks it and `bd ready` never offers
it meanwhile), a holder the registry reports `idle` or `parked` (revivable), and a holder
absent from the registry (unknown). Each gets a `NOTE claim preserved` or a notice naming
the lease state; none gets a blind release. If checkout or runtime-root repair is needed
before a replacement can work, run `planning.md`'s **Canonical checkout recovery** first.

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
- **Shepherd:** one ephemeral pass over the ordinary merge bead. Restart from the merge
  bead; nothing else holds state for it.
- **Workers:** replace only after the reaper releases their claim under the lease; a
  `NOTE claim preserved` never makes work claimable. Recovery inventories ordinary and
  ephemeral ownership separately and releases each through its own path.
- **Store sync:** only the lead syncs the beads database during a run, once, at the barrier
  after every agent has yielded: `bd dolt commit`, then `bd dolt push`. Workers never run
  `bd dolt push|pull` (G6 refuses it), because the routed sync is a second Dolt engine on the
  run's journal; `references/beads-store.md` has the discipline and the store probe.

## Human-in-the-loop and safe autonomy

An agent may choose a default autonomously only when every condition is true:

- the action and its effects are reversible;
- the effect is local to one bead and its owned resources;
- the downside and rollback boundary are explicit and bounded;
- the choice is compatible with accepted policy and recorded evidence; and
- the choice preserves user intent rather than selecting or changing it.

Record the ambiguity before applying the default. A cross-boundary choice that existing
evidence fully resolves uses a decision bead. Cross-boundary uncertainty, irreversible
action, external mutation, security/financial/legal risk, missing user intent, or a
review issue that exhausted its own fix-attempt limit is not an autonomous default. It
enters `waiting_human` with one exact question and its impact.

The holding actor adds this comment to the affected bead:

```text
ASK <bead>
owner: <actor responsible for resumption>
scope: <bead and affected resource>
question: <one exact choice the human must make>
impact: <what remains stopped and what each answer changes>
resume: <exact state transition, gate action, and actor to wake>
```

Every field is nonempty. The question cannot delegate discovery back to the human or ask for
general approval. Then set the hold: `bd update <bead> --status blocked`. Status `blocked`
plus the `ASK` comment is the durable hold; `bd ready` skips it and no dependent clears. A
shepherd whose review loop exhausted its limit writes `ESCALATED` carrying these same fields
instead of a separate `ASK`. A bead that had not started also receives
`bd gate create --type=human --blocks <bead> --reason "<question>"`.

Nobody polls the human or the held worker. Unrelated ready beads continue. On an answer,
promote it into a work-bead comment or decision bead, resolve the human gate when one
exists, and follow the stored `resume` instruction: reopen the bead unassigned with
`bd update <bead> --status open --assignee ""`. Normal dispatch re-offers it, and the next
claimant reads the answer on the bead.

## Ordering and waits are bead primitives

No step list or poured molecule carries the process. Two invariants replace what one might
have enforced:

- **Ordering is an edge on the work bead.** Any "X before Y" the process needs is
  `bd dep add <Y> <X>` between real work beads; no step beads exist beside them. Check:
  `bd list --status all --json` holds no `issue_type: molecule` this run created, and
  `orc_run_status` reports zero orphans from it.
- **An external wait is a gate on the bead that waits.** CI, PR and human waits are
  `bd gate create --type=<kind> --blocks <work bead>`, created by the actor that discovered
  the wait. A merge bead's PR is not gated: the landing sweep observes its checks and merge
  state. Timer semantics live in the plugin sweep, never in a timer gate.

## Waiting on an external machine gate

The same rule applies when the wait is on a machine rather than a person: a CI run, a
release workflow, a release PR's checks, a review bot's round, or a long-running reviewer.
Nobody polls it and nobody holds a session open for it.

Park the bead instead. Add `bd gate create --type=gh:pr --blocks <bead> --await-id <pr#>` for
a PR outside the run's landing, or `--type=human` for a person, comment `BLOCKED` naming the
gate bead and how to resume, then release the claim with
`bd update <bead> --status open --assignee ""`. The gate bead is the hold: `bd ready` hides
the work bead until the gate resolves. Continue unrelated beads from `bd ready`. When
nothing else is ready and only external waits remain, write the run report and exit; the
gate bead and the next pass own the wait. `bd gate check` plus `bd ready --gated` is how the
cleared gate is discovered, after which ordinary `bd ready --claim` acquires the reopened
bead.

Two campaign runs violated this on their final release bead: each polled a release workflow
and a package-executing reviewer until the stream aborted, leaving that bead `in_progress`
even though every PR, tag, and release had already landed correctly. A run whose only
remaining work is an external wait must terminate with a clean record, not an aborted
stream.

## Reversible local defaults, revisit, and late evidence

Before applying a reversible bead-local default, write a provisional `NOTE decision`
comment using the contract in `references/beads-store.md`. Its objective `revisit` trigger
defines when the default becomes stale. A choice affecting another bead, agent, package,
shared contract, ordering rule, or later work uses a decision bead instead.

At the recorded trigger, the owner re-reads the cited evidence before any further use of the
default, then supersedes the provisional comment with an accepted `NOTE decision`, creates
a decision bead, or enters `waiting_human`. Routing changes only while the bead is
unassigned.

A local choice that changes gets a new comment referencing the old one; no comment is edited
or erased. A cross-boundary change gets a replacement decision bead and explicit
supersession. Duplicate, conflicting, superseded, and partially linked decisions follow the
deterministic rules in `references/decisions.md`; chronology alone never selects policy.

Restart recovery reads work-bead comments, decision beads, their dispositions and links, and
every `blocked` bead carrying `ASK` before resuming anything. Wisps and artifacts supply
coordination and evidence only -- an unpromoted material message is not replay authority.

Late evidence follows the same revisit flow. If the affected bead is closed, append the
evidence and disposition to that closed bead or its decision bead. When behaviour must
change, create follow-up work with a `discovered-from` link; do not reopen the completed bead
or rewrite its terminal evidence.

## Incidental bug beads

A worker never fixes a pre-existing defect outside its claimed scope, even when trivial.
It files one routed bug bead and keeps its own scope, evidence and bead. The architect
adopts the bug or transfers it to the owning epic; it never leaves the bug ownerless.

Such a bead enters the run routed, or it does not enter it at all. Every queue pulls with
`--parent <epic>` plus `--metadata-field role=<role>`. An unparented or unrouted bug bead is
invisible to all of them, and it lands in the stranded query, which fails close-out.

| Field | Value |
|---|---|
| parent | the epic whose nodes own the broken files, which is not automatically your own. Its queues and every `bd list --parent <epic>` close-out scan then see the bead |
| route | exactly one `role=<role>` key, the role that would do the fix -- `role=implementer` for a code defect, never `role=architect`. `bd create` carries routing freely for every role, so filing routed needs no architect |
| assignee | empty, so the next worker claims it atomically through `bd ready … --claim`. Every queue here is an `--unassigned` pull, so an assigned bug leaves `bd ready` and shows only under `bd list --assignee` |
| provenance | `discovered-from` its finder, plus the label `kind:incidental` |

Merge beads are the one deliberate unparented exception, and a bug bead never copies it.
`discovered-from` does not gate `bd ready`, so that link costs the bead no readiness.

An epic carries no `scope` key of its own, so match the defect's paths against the `scope`
globs of the beads under each epic (`bd list --parent <epic> --json`):

- **Exactly one epic matches.** Parent it there and ping that epic's architect. That is the
  fast path, and it needs no question -- the match is the answer.
- **No epic matches, or several do.** File it under your own epic, and let its architect
  reparent with one `bd update <bug> --parent <their-epic>`. An ambiguous match
  is not worth a round trip, and your own epic is always a legitimate home.

Never hold a bug bead unparented and unrouted while you work out which epic owns it. Parent
it somewhere with a fix role, then refine.

Route it to the role that would fix it, never to `role=architect`:

- the parent link is how the owning architect sees it. Its own sweeps, `bd list --parent
  <epic>`, and every close-out scan already carry the bead, so a triage label adds no
  visibility.
- `role=architect` is the queue that hands an architect an epic to own, and a bug bead is not
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
| label `kind:incidental` | chosen. `kind:` is an established namespace, the marker is a classification nothing claims on, and it reads back with `bd list --parent <epic> --label kind:incidental` |
| `metadata.incidental` | rejected. Single-value, one more key to register in the metadata contract, and read with jq instead of a label filter |

The bead carries no `orc-node` label either. It is nobody's DAG node until an architect adopts
it and adds one.

```
bd create "<what is broken>" --type bug --parent <owning-epic> \
  --labels kind:incidental \
  --deps discovered-from:<your-bead> \
  --metadata '{"role":"implementer","scope":["<glob>"],"execution_kind":"git","origin_bead":"<your-bead>"}' --silent
```

Then comment `NOTE` with the new id on your own bead. The history then shows how a bead the
architect never decomposed arrived under its epic.

The wake is content-free and last:

- write the bead, comment on it, then ring the doorbell -- in that order.
- ping the architect of the epic you parented under. That is the one actor whose queues now
  carry the bead. `metadata.actor` on that epic names the handle, and `hub` `op: "list"`
  confirms it is live.
- the bead is complete without the message, so a failed send changes nothing. Never retry it,
  and never block on it.
- the message carries no instructions and no description of the bug. The bead is the brief.
- it buys triage while the run is live rather than at close-out, plus the revival of an
  architect parked past `task.agentIdleTtlMs`. One saved round trip, nothing more.

When you parented under your own epic, send nothing: your exit is already the doorbell. The
child terminal event resumes your architect, which then reads the reporting bead, its `NOTE`,
and the `discovered-from` link. A sibling architect gets no such event, which is exactly why
a cross-epic filing pings and a same-epic filing does not.

`origin` carried incompatible meanings under one key and is split into three value-named keys.
This is the contract for all of them, and none of them addresses the wake.

| Key | Value | Use |
|---|---|---|
| `origin_actor` | an actor handle, `BEADS_ACTOR` form | the peer a bounce or a report wakes over `hub`. Never resolvable by `bd show`, never a dependency edge. Stamped on a run epic, a dispatched node, a helper wisp |
| `origin_bead` | a bead id | the bead a bounce or a report comments on: the merge bead behind a fix, the feature behind a merge bead, the finder's bead behind an incidental bug |
| `run_epic` | a run epic's bead id | run membership, which is why it left the `origin_*` family. Provenance only, never a routing target. Stamped on an architect domain epic |
| `origin` | legacy: any of the three | pre-split beads only. A reader tries the successor key first, then this one. Nothing writes it again |

This bug bead stamps `origin_bead`, the finder's bead -- a comment target, not an addressable
peer. The wake resolves the other way: read `metadata.actor` off the epic you parented under
(`bd show <epic> --json`), then confirm that handle with `hub` `op: "list"`.

Every worker can read that roster. It lists live peers and omits only the caller, so you can
check an architect's liveness but never your own name. The handle goes stale the moment the
lead replaces an architect, so the roster check is what makes the ping worth attempting. A
stale handle costs nothing, because the bead is already complete.

An open incidental bug bead never blocks close-out. It is open, unassigned, and ungated, which
makes it ready. A ready bead is never stranded, never `in_progress`, and never `blocked`. Those
are the conditions that gate reads.

The architect either adopts the bug into its decomposition or reparents it to the epic
that owns the code. If no owner exists, the discovering architect adopts it. Deferral
is not a third, ownerless disposition.

`bd list --type bug` audits every incidental bug at any time, without touching a queue.

## Cleanup

Three kinds of tree exist, and only one of them is swept:

- **Isolated worker copies** are runtime-owned. They are created and removed by OMP, and
  nothing in this package touches them.
- **Captured branches** (`omp/task/*`) are explicit cleanup candidates only after patch
  containment and terminal state are established by the architect's scan above.
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

Stop repository watchers before removing run-local process state. `/orchestrate-close
<epic>` removes the active-run marker only after verifying it names this run and no child
is `in_progress`; `--force` skips the child check for a run whose beads are gone.
