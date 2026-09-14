# Beads store: run state, mapping, audit, coordination

A run's DAG, bead state, and audit trail live in the project's beads database (the `bd`
CLI). Every isolated clone reaches the same database through `.beads/redirect`, so agents
read and write live state with plain `bd` commands -- no shared-path bookkeeping. Artifacts
(full briefs and reports) are files under `<primary>/.orchestration/run-<id>/artifacts/`.
Bead comments reference them by absolute path.

## Coordination and policy carriers

| Carrier | Stores | Authority |
|---|---|---|
| Work-bead comment | A choice that affects only that bead and its owned scope | The durable local truth. The comment author is the actor. Accepted comments remain. A provisional comment names an objective revisit trigger. |
| `decision` bead | A choice that affects a second bead, agent, or package, or constrains later work | The durable cross-boundary truth. It carries an owner, a stable key, a design, acceptance/verification, status/disposition. Each affected bead gets a non-blocking link. |
| Message wisp | Live coordination: a question, a reply, a notification, a trace | Ephemeral coordination only. Wisps are TTL-compacted, so promote a material outcome to a comment or decision bead before acting on it or closing it. Neither acknowledgment nor compaction deletes the promoted truth. |
| Artifact / `output_ref` | A large inspectable payload of evidence: a brief, a report, a test log. A citing bead names its absolute path | Evidence only. A citing comment or decision bead joins it to a decision or report. Alone it is not policy or lifecycle state. |
| Pushed ref | The code a worker produced, on `origin/omp/task/<id>`, pushed before the worker yields; OMP also captures it in the architect's clone at completion | Evidence that survives the worker, the architect, and the process, because origin holds it; a clone's copy dies with the clone. It is not integration: only `git cherry` against the feature branch proves that. |

A message counts as material when it changes any of these:

- a choice, default, or scope
- a route or ordering
- acceptance evidence or disposition
- a human answer

Handle it in this order:

1. Classify its effect as bead-local or cross-boundary.
2. Write the local comment or decision bead and any affected-bead links.
3. Read the durable record back. A decision is effective only after every affected link is
   visible and non-blocking.
4. Act from that record and cite it in later comments or reports.
5. Acknowledge or compact the message only after promotion succeeds.

No promotion means no policy action and no closure based on that message. A restart puts
comments and decision beads first in recovery. Message wisps and artifacts come second.

## Bead-local defaults

A reversible default that a reviewer must know to judge the work is recorded as a `NOTE`
on the work bead, under the choosing actor's `BEADS_ACTOR`. Before acting on it, read it
back with `bd comments <bead> --json`:

```text
NOTE decision
owner: <actor>
scope: <work-bead and owned resource>
decision: <chosen implementation behavior>
rationale: <why this choice fits the brief>
evidence: <file:line, bead id, command result, or searched-none>
status: <accepted|provisional>
revisit: <objective trigger; required when provisional>
```

The comment author and `owner` must match. `accepted` omits `revisit`. `provisional`
requires one nonempty trigger:

- an event
- a dependency transition
- an exact evidence change
- an RFC3339 deadline

`later`, `if needed`, and elapsed time without an observable condition are not triggers.

A readable comment is the local truth, and the only record: nothing is written twice. A
failed comment write or read-back means the choice does not apply.

A cross-boundary choice needs a `decision` bead instead. Its creation contract, edge-type
rendering, and duplicate/supersession resolution are in `references/decisions.md`; read that
only when a choice leaves one bead's scope.

## Prerequisite (checked once, at run start)

- Require `bd` on `PATH`; missing → stop. No fallback store exists. A failed database read
  is not proof no database exists. Worktrunk (`wt`) is optional and operator-only; the
  doctor reports it as information.
- `bd` present, no database → `bd init --stealth --prefix orc` (git-invisible: writes
  `.git/info/exclude`, leaves `git status` clean).

At run start the operator runs `/orchestrate-start --new "<title>"`, or
`/orchestrate-start <epic-id>` for an epic that already exists. The command:

- with `--new`, creates the run epic with `run_id`, `primary_branch`, `base_sha`,
  `origin_actor` and an absolute `artifacts` directory under `.orchestration/<epic-id>/`
- with an epic id, keeps that epic's metadata as written; it needs those five fields
- writes `.orchestration/.active-run` naming the epic and the run's `.beads`
- stamps the lead lease on the epic and records `metadata.landing`

Dispatch only after the command reports the run. A claim before the marker names an epic
is invalid.

Sync discipline:

- The lead is the only session that runs `bd dolt push` or `bd dolt pull` while a run is
  active. It does so once, at the barrier, after every agent yields: `bd dolt commit`, then
  `bd dolt push`. Also push after graph creation and before standing down.
- The routed `bd dolt` sync runs a second Dolt engine against the same journal from a lock
  domain host writers cannot see, which is how one run corrupted the store. G6 refuses
  `bd dolt push|pull|fetch|clone|sync` from every spawned session, and the Worktrunk
  `post-commit`/`post-merge` hooks skip their sync while `.orchestration/.active-run` exists.
- A git branch push does not carry `refs/dolt/data`; `bd backup` is not remote sync.
- `src/store-probe.ts` answers `free`, `locked` (naming the holder), `corrupted` (quoting
  the journal error) or `slow` for a store. A `locked` or `corrupted` store is never synced.
  The plugin repairs neither: it starts, stops, and kills no Dolt server and never touches
  `noms/LOCK`. `dolt fsck` in the store directory is the operator's diagnosis.

## Bead type vocabulary

| Type | Use |
|---|---|
| `epic` | architect domain / run root |
| `feature` | the grouping an architect creates: the natural PR + branch unit |
| `task` | worker-sized unit |
| `bug` | mid-run defect, linked `discovered-from` its finder |
| `decision` | architecture decision record. The `adr` skill and `bd lint` already handle these |

Merge beads carry no type of their own. Readers identify them by the label `pr:merge` plus
metadata `role=shepherd`, never by a type. `merge-request` is a filter alias accepted by
`bd ready -t` and is NOT a creatable type: `bd create -t merge-request` is rejected.

`bd` is internally inconsistent about types. An adopted vocabulary MUST stay inside the
`create`/`update` intersection, or `bd create` rejects the bead:

| Command | Accepted `-t` values |
|---|---|
| `bd create`, `bd update` | `bug feature task epic chore decision` |
| `bd ready` | those minus `chore`, plus `merge-request` |
| `bd list` | all of the above plus `molecule gate convoy` |

No code validates or enumerates this vocabulary. Review enforces it.

A wisp is not a type either. It is `--ephemeral` plus `--wisp-type
{heartbeat,ping,patrol,gc_report,recovery,error,escalation}` plus a naming convention,
orthogonal to `issue_type`. `bd ready` hides ephemeral beads unless `--include-ephemeral` is
passed, which is why the review and research queues carry that flag and the others do not.

## Run, epic, and task beads

| Object | Beads representation |
|---|---|
| Run | one **epic** bead. Metadata `run_id` `primary_branch` `base_sha` `artifacts` (abs dir) `origin_actor`, with an optional `swarm` handle |
| Architect domain | **epic** bead, one architect. Metadata `run_epic` `artifacts_dir` `branch` `base_sha` `push` `head_sha` `worktree` |
| Feature | **feature** bead: one branch, one PR. Metadata `worktree` `branch` `base_sha` |
| DAG node | **task** bead under its feature, label `orc-node`. Metadata `role`, `node`, `scope` (JSON array of globs), `execution_kind`, `origin_actor` |
| Node dep | `bd dep add <dependent> <dependency>` (`blocks` type), one per edge |
| Merge bead | label `pr:merge`, **no parent**. Metadata `role=shepherd` `repo` `branch` `base_sha` `origin_bead` `integration_owner` |
| Git anchors | stamped per the contract below |

Three distinct keys above, not one key spelled three ways: `origin_actor` an actor handle,
`run_epic` run membership, `origin_bead` a comment target. `references/lifecycle.md` holds the
contract, and every reader still accepts a pre-split `origin`.

```
EPIC=$(bd create "orchestrate run-<id>" --type epic --silent \
  --metadata '{"run_id":"run-<id>","primary_branch":"main","base_sha":"<sha>","artifacts":"<abs>/.orchestration/run-<id>/artifacts"}')
# `bd swarm validate "$EPIC" --json` gates the structure and needs no marker.
# Only create a marker (`bd swarm create "$EPIC"`, handle -> metadata key `swarm`)
# when coordinator discovery or an external scheduler needs a durable handle.
T1=$(bd create "t1: <desc>" --parent "$FEATURE" --labels orc-node --silent \
  --metadata '{"role":"implementer","node":"t1","scope":["src/auth/**"],"execution_kind":"git"}')
bd dep add "$T3" "$T1"        # t3 depends on t1
bd dep cycles                 # must stay clean
```

The label MUST be `orc-node` (hyphen, plain label). No `state:` label exists: a bead's
`status`, `assignee` and labels hold its state, and one comment verb records each
transition. Nothing writes a second record of the same fact.

## Phase derivation -- bead status + fields → the phase a reader needs

Beads statuses are coarse and drive `bd ready`. The finer phase is never stored; a reader
derives it from the fields below, and `orc_run_status` renders the same derivation. Only
`status` and `assignee` are ever written for a transition, and only where they change.

| Phase | Bead status | Derived from | Written by |
|---|---|---|---|
| `pending` | `open` | no assignee, `bd ready` does not list it (a dependency or gate is open) | creator at `bd create` |
| `ready` | `open` | no assignee and `bd ready --parent <epic> --metadata-field role=<role> --unassigned` lists it | derived, never stored |
| `working` | `in_progress` | assignee set | the claimant: `bd ready … --claim` (atomic, first-wins, sets assignee) |
| `reported` | `in_progress` | assignee cleared, label `agent:reviewer`, last verb `REPORTED` carrying `pushed=`, `metadata.pushed_sha` stamped by the exit gate | the worker, before yield; the parent integrates after the terminal task result |
| `in_review` | `in_progress` | an open review wisp linked to the node | the architect, when it creates the review wisps |
| `changes_requested` | `in_progress` | `REVIEW … verdict=changes` on the node at the current head and round | the reviewer's comment |
| `approved` | `in_progress` | every required `REVIEW … verdict=approve` at the current head and round; the wisps closed | the reviewers' comments |
| `merged` | `closed` | `LANDED <sha> merge=<merge-bead-id>` on the node, then `bd close <node> --reason merged`; feature closes with the same reason after every `orc-node` child is closed | landing sweep |
| `dismissed` | `closed` | `REVIEW … verdict=approve` covers the node, then `bd close <node> --reason dismissed` after accepted non-git evidence | landing sweep |
| `deferred` | `deferred` | fenced claim release for missing acceptance, with `NOTE no-acceptance` | claim gate |
| `landed uncovered` | `in_progress` or `open` | landing evidence exists but no covering approve; `NOTE landed uncovered: merge=<id> head=<sha>` is present | landing sweep, auditor derives attention |
| `override pending` | `in_progress` or `open` | `NOTE override requested` exists and its single review wisp is open | landing sweep, auditor derives attention |
| `failed` | `blocked` | `FAILED` comment; `bd update <bead> --status blocked` | claimant |
| `waiting_human` | `blocked` | `ASK` comment (or a shepherd's `ESCALATED` carrying the same fields); a human gate when the bead had not started | the holding actor |
| `waiting_gate` | `open` | a gate bead blocks it; `BLOCKED` names the gate; assignee cleared | the actor that discovered the wait |

Semantics that fall out of the status column:

- **Deps clear on `closed`.** A dependent becomes ready only once its upstreams are
  `merged`/`dismissed`.
- **Pick the dependency type from what the dependent waits for.** `blocks` waits for the
  shepherd's merge. A `reported` phase proves a pushed ref (`pushed_sha`), not integration.
  - Needs upstream CODE: first verify the pushed `omp/task/<id>` ref at `pushed_sha`, then
    use a non-blocking type and stamp `base_ref=<upstream ref>` on the dependent.
  - Needs the upstream DECISION to land first: keep `blocks`, which gates `bd ready`.
  - A `base_ref` dependent rebases when the upstream takes review changes. That rebase
    returns through the `BOUNCED reason=conflict` path.
- **`failed` = `blocked` status** → never satisfies a dependency, never reappears in
  `bd ready`. Stranded downstream = `bd dep tree <bead>`.
- **`bd ready` excludes** gated beads, `in_progress`, `blocked`, `deferred`, and (by
  default) ephemeral beads. The ready front is therefore dep-correct by construction.
- **Review handoff is one enforced field, and it is a label.** The exit gate evaluates
  `label ~ ^agent:reviewer$` on the reporting bead, and that label is the whole enforced
  handoff. It signals "ready for the next role"; it does not route. A cleared assignee and
  `status=in_progress` are separate contract checks, evaluated independently -- never as one
  joined condition.

## Git-anchor contract

Two mechanisms hold code, and they are not interchangeable.

- **Origin owns feature branches.** An architect works in an isolated clone that OMP deletes
  when the architect completes. It pushes the feature branch at creation and after every
  integration, and it is the **sole writer** of that branch. A replacement architect fetches
  the branch; no local tree outlives its agent.
- **OMP isolation owns task work.** A worker is spawned `isolated: true` with
  `task.isolation.merge: branch` and `task.isolation.apply: false`, so its commits are
  captured on `omp/task/<id>` in the architect's clone and no worker ever writes the
  architect's tree. Before yield the worker pushes the same head to `origin/omp/task/<id>`.
  The architect integrates by explicit cherry-pick, when it chooses.

Anchors are stamped so any later session can find where work lives:

| When | Who | Stamp |
|---|---|---|
| Feature branch created | architect | `git switch -c <branch> && git push -u origin <branch>`; stamp the epic's `branch`, `base_sha`, `push=origin/<branch>`, `head_sha`, and `worktree` (the clone root). `push` is the target, `pushed_sha` the proof |
| Task dispatched | architect | nothing to provision: an isolated child runs in a clone of the architect's clone, on the feature branch at its head; a non-isolated child inherits the architect's cwd. Stamp `scope`, `execution_kind`, `origin_actor` on the task bead |
| Worker reported | worker | `git push origin HEAD:$ORC_PUSH_REF`, then `head_sha=<final commit>` and `REPORTED … pushed=omp/task/<id>@<sha>` before yield. G4 runs `git ls-remote origin refs/heads/omp/task/<id>`, refuses the yield unless it shows `head_sha`, and stamps `pushed_sha=<observed sha>` itself |
| Successful child result collected | architect | verify the `omp/task/<id>` capture in your clone, or `origin/omp/task/<id>`, against the reported head before integrating; include accepted dirty delta in the source snapshot |
| Integration pushed | architect | `git push origin <branch>`, then `--set-metadata head_sha=<sha>` and `--set-metadata integrated='["<node-id>",…]'` on the **feature** at every feature-branch push. The set is the review's `nodes=` coverage |
| Recovery or branch cleanup | architect | the reaper releases a dead holder's claim under the lease fence and records `RECOVERED`; only the architect rewrites anchors or deletes branches, after the patch-containment scan |
| Claim | claim-holder | a claim binds a role to a bead, never to a path. Every claimant works in the checkout the runtime gave it; `metadata.worktree` names source ownership and relocates nobody |
| Merge | landing sweep | `bd update <merge-bead> --metadata '{"pr":<n>,"merge_sha":"<sha>"}'`, write `LANDED <sha> merge=<merge-bead-id>` on merge and origin node, then close covered nodes and the feature with `--reason merged` |

Add a `repo` key when work lands in a different repository than the run epic. `--metadata`
merges with existing keys, so stamps never clobber `node` or `scope`. Branch, push, PR, and
merge anchors survive the clone they were written from.

`worktree` rules:

- The architect stamps its clone root on the epic; the feature and task beads beneath it
  inherit the value. Do not store a reviewer's path on a work node.
- It is informational. G2 confines a write to the isolation root the runtime reports, and no
  queue pull filters on the path.
- Stamp it as an absolute path.
- No run checkout carries a Worktrunk binding. `wt config state vars` and `wt step eval`
  are the operator's tools for the operator's worktrees.

On resumed work, preserve pushed refs, accepted deltas, and anchors; a dead clone's dirty
tree is gone. Dead-claim release is the reaper's, per `lifecycle.md`, before any replacement.

Choosing between a label and a metadata key is a cardinality rule plus an authority rule,
not a style preference. Both filter on `bd ready` and both compose with `--claim`, so
filterability does not distinguish them.

| Carrier | Cardinality | Carries |
|---|---|---|
| Label | multi-value. A bead holds every label added | multi-value classification: `pr:`, `state:`, `kind:`, `lang:`, `evidence:` |
| Metadata | single-value per key. `--metadata` merges per key on write, so stamps never clobber `node` or `scope` | single-value enforcement: `role`, `worktree`, `branch`, `push`, `head_sha`, `pushed_sha`, `scope`, `base_sha`, `actor`, `origin_actor`, `origin_bead`, `run_epic`, `merge_sha`, `stage`, `bot_same_issue_limit`, `bot_issue_attempts`, `bot_round_limit`, `bot_rounds_completed`, `bot_review_requests` |

Cardinality first. A label set accumulates: a stage pipeline built on labels collected
`stage:implement` + `stage:review` + `stage:fix` and sat in three queues simultaneously.
Single-value keys therefore MUST be metadata: `worktree` as a label would mean two
confinement boundaries and a write guard that cannot choose. Worktree resolution is also
"own `metadata.worktree` else inherit from parent", and that walk reads exactly one value
per bead, so two worktree labels make it ambiguous at every level.

Authority second. The route is `metadata.role` rather than the old `agent:<role>` label
because a metadata write can be refused per role:

- the write seam admits `--metadata`, `--set-metadata` and `--unset-metadata` against `role`
  only from the architect that decomposed the epic.
- a role contract can deny keys outright through `deny_metadata`.
- nothing equivalent exists for labels. There is no `deny_labels` and no seam that refuses a
  label write, so under label routing any role could re-point any bead.

That hole was exercised for real: a worker-writable label let a dead child label its way out
of reclamation. A route deciding who may claim work has to sit on the carrier that can say
no.

Two consequences follow, and they are not symmetric. `bd create` is exempt, so any role may
file NEW work already routed -- an unrouted bug bead reaches no queue and strands. And the
handoff a worker writes stays the `agent:reviewer` label precisely because it is not a
route: the worker signals the next role without touching who may claim the bead.

`pr:merge` and `kind:incidental` stay labels for the same reason as that signal. They
classify, nothing claims on them, and no role needs to be refused the right to write them.
Labels remain legal as advisory annotation. They simply stopped being authoritative for
routing.

Flag forms: `bd update --metadata` takes a JSON string or `@file.json`, and
`--set-metadata key=value` is the repeatable form. Labels use `--add-label`,
`--remove-label`, `--set-labels`.

## Ready front + scope disjointness

Beads does not know about file scopes, so disjointness is checked beside it, at two points.

At decomposition, when an architect's `bd create` or `bd update` writes a `scope`, the
extension refuses one that overlaps an open or in-progress `orc-node` of the same run
outside the bead's own lineage. Fix the globs and write again.

At claim, when a worker names a bead (`bd update <id> --claim`), the extension reads that
bead's `scope` and every live claim's `scope` and applies a conservative glob-overlap test
(prefix containment in either direction; a bare `**` conflicts with everything). A claim
that overlaps a live one is refused with both bead ids named. On a refusal, leave the bead
alone and report the overlap as a decomposition defect; do not route around it.

```
bd ready --parent <epic> --metadata-field role=<role> --unassigned --claim --json
```

That is one command, not a list-then-pick: the claim is atomic and first-wins, and an actor
accepts whatever the claim returns rather than cherry-picking a candidate. A queue pull names
no bead before it runs, so no overlap test runs on it; the decomposition check is what keeps
a queue's beads disjoint from each other.

No check runs per write. G2 confines a mutation to the claimant's own checkout and `metadata.scope`
and never consults other claims. Both overlap checks are friction, not a boundary: they catch
the honest mistake and are bypassable by construction. Disjoint `scope` globs written at
decomposition time are the real mechanism.

## Events: one comment per transition

`REPORTED BLOCKED FAILED REVIEW LANDED BOUNCED ESCALATED ASK NOTE` -- the nine verbs an
acting agent may write. `src/contracts/grammar.json` leads the set; the other four are the
extension's voice. Each material transition is one write, with identity from
`BEADS_ACTOR=<actor>`:

```
bd comment <bead> "<VERB> <node> field=… output_ref=<abs artifact path>"
```

- **Comment** = the record. Human-readable fields, citing artifact paths instead of inlining
  long text. Where the transition also changes `status` or `assignee`, that field changes in
  the same batch; nothing else is written for it. `bd audit record` and `bd set-state` are
  not part of the protocol: nothing reads either, and the ledger below is the trail.
- **Artifacts**: full briefs and reports go to
  `<artifacts>/<node>-<verb>-<resource>-<n>.md`, where `<resource>` is the id of the claimed
  bead or wisp. Every dimension reviewer of one node writes its REVIEW artifact at the same
  time, and the resource id is what keeps those filenames apart.

Alongside these voluntary comments, the extension keeps an involuntary record: every child's
mutating `bd` command is appended to
`<spawning-session-cwd>/.orchestration/audit/<child-id>.bdlog` as
`ts, child, argv, exitCode, store`. `store` is present only when the command named a store
of its own (`--db`, `BEADS_DB`, `-C`) instead of letting bd resolve the run's; such a row
also carries `foreign_store: true`. It is provenance of a sandbox or another repository, not
a run mutation, and a reader counting the run's writes skips it. The ledger is passive
provenance, never a gate, and it is the evidence a dead-claim recovery reads first.

## Landing primitives

- **Capabilities:** `/orchestrate-start` records `metadata.landing` on the run epic:
  `repo`, `base`, `mode` (`auto` or `direct`), `auto_merge_allowed`, `squash_allowed`,
  `required_checks`, `strict`, `queue`, `viewer_permission`, `probed_at`. The sweep
  re-derives `mode` from the flags on every read.
- **Merge bead state:** the sweep stamps `landing_state` (`armed`, `bounced`, `refreshing`, `refreshed`, `landed`,
  `closed`), `armed_head`, `armed_at`, `ci_rerun_head`, `ci_reruns`, `landing_fix`,
  `landing_refresh`, `landing_refresh_notice`, `refreshed_from`, `refreshed_head`, `refresh_candidate`, `landing_notice`
  and, on landing, `merge_sha` and `landed_head`. The architect alone changes the merge
  bead's reviewed `head_sha`. After a clean base refresh, the sweep records
  `refresh_candidate`, disables armed auto-merge from a fresh PR read, and moves the PR to
  draft before it pushes. It verifies the PR remains open, unarmed and draft-held at the candidate.
  The sweep walks the origin's parent chain to identify the owning architect epic. It then creates one run-level
  `role=architect`, `stage=review-refresh`, comment-output epic with `target_epic=<owner>`.
  The draft PR and older merge-bead `head_sha` hold landing until that epic finishes every exact-head review,
  stamps the candidate as reviewed, makes the PR ready, reports its output and yields. Neither the owner epic nor its claim is mutated.
- **Fix beads:** `bd create --parent <origin's feature> --deps discovered-from:<origin>,blocks:<merge>`
  with `metadata.role`, `stage=fix`, `origin_bead=<merge>`, `landing_reason` (`conflict`
  or `ci`) and, for the implementer, the origin's `scope`. The `blocks` edge is what
  keeps the sweep off the merge bead: `bd blocked` lists it until the fix closes.
- **Async waits:** `bd gate create --type=gh:pr --blocks <bead> --await-id <pr#>` for a PR
  outside the run's landing. `bd gate check` evaluates and closes resolved gates;
  `bd ready --gated` finds what a cleared gate released. A gated bead stays out of
  `bd ready`. No gate wraps a merge bead's CI; the sweep observes it.
- **Evidence:** `orc_conflict_probe` (`conflicts`, `pairwise`, `ci`) predicts merges
  without touching a tree and reads CI; `orc_bot_review_probe` grades the review-bot
  round at the PR's exact head. `unknown` and `declined` are never clean.

## Read the run (status / resume / close-out)

`orc_run_status` is the standard report: it rolls the run epic up through its domain epics
and feature beads to their tasks, at any depth, and resolves blockers with `bd blocked`. Use it
instead of hand-assembling a summary. `bd list --parent <id>` answers direct children only
(bd 1.2.2), so a hand-built `--parent <epic>` query misses every task under a feature. The
report ends with a `CLOSE-OUT` section, also returned as `details.closeOut`; the queries
below are for the questions the report does not answer.

| Question | Command |
|---|---|
| one bead's story | `bd show <bead> --json` + `bd comments <bead>` |
| audit trail | `bd comments <bead>` for the verbs, plus `<spawning-session-cwd>/.orchestration/audit/*.bdlog` for every mutating command (skip rows tagged `foreign_store`) |
| dep structure / impact | `bd dep tree <bead>`, `bd graph` |
| open waits | `bd gate list`, `bd ready --gated --json`, and the `BLOCKED landing:` comments on open merge beads |
| resume after crash | in-flight = the `in_progress` rows of `orc_run_status`, or `bd list --status in_progress --limit 0 --json` filtered to beads whose parent chain reaches `<epic>`. Actor = `assignee`, the identity the claim report printed (`metadata.actor` is not identity). Location = `metadata.push`/`branch` on origin; every clone died with its agent. Surviving code = `git ls-remote origin 'refs/heads/omp/task/*'` |
| unintegrated code | integration is cherry-pick or squash, so ancestry does not prove containment. In the bare clone, fetch the feature branch and each candidate `omp/task/<id>` ref, then run `git cherry <feature-head> <pushed_sha> <base>` where `base` is the node or epic `base_sha`, or `git merge-base` of the two. Containment means no line starts with `+`; a fetch or comparison failure is `unverified` and blocks close-out |
| close-out gate | `orc_run_status` with `epic=<run>`: `CLOSE-OUT: clean` means every row below is known and empty. The unintegrated-code row above proves patch-id containment against the reviewed pre-squash head. `/orchestrate-stop` makes the in-progress and containment checks itself before it removes the marker; `--force` skips them |
| stranded beads | the `stranded` row: open and unassigned, absent from `bd ready --include-ephemeral`, and not blocked, so no worker can ever pull it. Then check each nonempty `assignee` in the rollup against a live actor |

A bead that is neither ready nor claimed counts as stranded. The store never reports a dead
actor, so the stranded row is the only signal. Two measured cases, both of which pass the
in-progress and blocked checks of the close-out gate:

- A provider 403 killed two test shepherds before they wrote any claim or comment. Three
  merge beads stayed claimable after both actors died.
- A bounced bead keeps an owner who never returns.

The `CLOSE-OUT` rows, each a list of bead ids or `unknown` when its read did not answer:

| Row | Reads | Lists |
|---|---|---|
| `cycles` | `bd dep cycles` | each cycle as the ids it visits |
| `in_progress` | the rollup | stored status `in_progress` at any depth, whatever `state:` label the bead carries |
| `blocked` | `bd blocked` and stored status | open beads something still blocks |
| `stranded` | `bd ready --include-ephemeral` | open, unassigned, not ready, not blocked |
| `undrainable merge beads` | the whole store | open beads carrying `pr:merge` or `role=shepherd` that lack the label, the role, `repo`, `origin_bead` (or legacy `origin`), or `branch` |
| `unlanded` | the whole store, narrowed to the report | merge beads not closed, with neither `merge_sha` nor `landing_state=landed`; a merge bead counts when it or the feature it captured is in the tree |
| `not on origin` | the rollup, `pr:merge` beads excluded | open beads whose `head_sha` has no `pushed_sha`, or one naming another commit (`head <sha>, never pushed` / `head <sha>, pushed <sha>`), and open beads carrying `branch` without a `push` target (`<branch>, no push target`). `details.closeOut.not_on_origin` |

Merge beads carry no `orc-node` label and no parent, so the tree rows skip them. They
strand a third way: the bead is open and unassigned, yet missing an anchor the cross-run
queue matches on. The `undrainable` row reads the whole store for that reason: the shepherd
queue is repository-global, and a merge bead no queue can match belongs to no run.

The row nets both markers and re-checks each bead. A run on bd 1.2.2 made merge beads
carrying one marker alone, and a filter on the marker a bead is missing can never find it.

## SpecKit / external frameworks

A poured SpecKit molecule already IS a dependency-aware run DAG. When one drives the work,
its implement-step children ARE the node beads. Never pour a second molecule and never build
a second graph: add the `orc-node` label, stamp one `role=<role>` routing key, and stamp
`scope` metadata on the existing step beads. The claim rule, the phase derivation, and the
anchor contract then apply unchanged.
