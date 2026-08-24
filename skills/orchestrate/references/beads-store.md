# Beads store: run state, mapping, audit, coordination

A run's DAG, bead state, and audit trail live in the project's beads database (the `bd`
CLI). Every worktree and every isolated worker copy shares one database, so agents read and
write live state with plain `bd` commands -- no shared-path bookkeeping. Artifacts (full
briefs and reports) are files under `<primary>/.orchestration/run-<id>/artifacts/`. Bead
comments reference them by absolute path.

## Coordination and policy carriers

| Carrier | Stores | Authority |
|---|---|---|
| Work-bead comment | A choice that affects only that bead and its owned scope | The durable local truth. The comment author is the actor. Accepted comments remain. A provisional comment names an objective revisit trigger. |
| `decision` bead | A choice that affects a second bead, agent, or package, or constrains later work | The durable cross-boundary truth. It carries an owner, a stable key, a design, acceptance/verification, status/disposition. Each affected bead gets a non-blocking link. |
| Message wisp | Live coordination: a question, a reply, a notification, a trace | Ephemeral coordination only. Wisps are TTL-compacted, so promote a material outcome to a comment or decision bead before acting on it or closing it. Neither acknowledgment nor compaction deletes the promoted truth. |
| Artifact / `output_ref` | A large inspectable payload of evidence: a brief, a report, a test log. A citing bead names its absolute path | Evidence only. A citing comment or decision bead joins it to a decision or report. Alone it is not policy or lifecycle state. |
| Captured branch | The code a worker produced, on `omp/task/<id>` in the parent repository | Evidence that survives the worker, the architect, and the process. It is not integration: only `git cherry` against the feature branch proves that. |

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

## Local decision comments

Set `BEADS_ACTOR` to the choosing actor. Add this record to the work bead. Before acting,
read it back with `bd comments <bead> --json`:

```text
LOCAL_DECISION
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
Record the operation as `orc.note` in the audit trail.

A readable comment is the local truth. A failed audit write after a successful comment
needs a retry before closing, never a duplicate comment. A failed comment write or read-back
means the choice does not apply.

A cross-boundary choice needs a `decision` bead instead. Its creation contract, edge-type
rendering, and duplicate/supersession resolution are in `references/decisions.md`; read that
only when a choice leaves one bead's scope.

## Prerequisite (checked once, at run start)

```
command -v bd >/dev/null || { echo "orchestrate requires the beads CLI (bd)"; }
bd info >/dev/null 2>&1 || bd init --stealth --prefix orc
```

- No `bd` on `PATH` → stop and tell the user to install beads. No fallback store exists.
- `bd` present, no database → `bd init --stealth --prefix orc` (git-invisible: writes
  `.git/info/exclude`, leaves `git status` clean).
- The recovery and landing formulas are read from `<beads-dir>/formulas/` and
  `.beads/formulas/`. Copy the plugin's `formulas/*.formula.toml` there once per repository;
  a linked package contributes none of them by itself.

## Bead type vocabulary

| Type | Use |
|---|---|
| `epic` | architect domain / run root |
| `feature` | the grouping an architect creates: the natural PR + Worktrunk branch unit |
| `task` | worker-sized unit |
| `bug` | mid-run defect, linked `discovered-from` its finder |
| `decision` | architecture decision record. The `adr` skill and `bd lint` already handle these |

Merge beads carry no type of their own. Readers identify them by the labels `pr:merge` +
`agent:integrator`, never by a type. `merge-request` is a filter alias accepted by
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
| Run | one **epic** bead. Metadata `run_id` `primary_branch` `base_sha` `artifacts` (abs dir) `origin`, with an optional `swarm` handle |
| Architect domain | **epic** bead, one architect. Metadata `origin` `artifacts_dir` `worktree` |
| Feature | **feature** bead: one Worktrunk branch, one PR. Metadata `worktree` `branch` `base_sha` |
| DAG node | **task** bead under its feature, label `orc-node` + one `agent:<role>` label. Metadata `node`, `scope` (JSON array of globs), `execution_kind`, `origin` |
| Node dep | `bd dep add <dependent> <dependency>` (`blocks` type), one per edge |
| Merge bead | labels `pr:merge` + `agent:integrator`, **no parent**. Metadata `repo` `branch` `base_sha` `origin` `integration_owner` |
| Git anchors | stamped per the contract below |

```
EPIC=$(bd create "orchestrate run-<id>" --type epic --silent \
  --metadata '{"run_id":"run-<id>","primary_branch":"main","base_sha":"<sha>","artifacts":"<abs>/.orchestration/run-<id>/artifacts"}')
# `bd swarm validate "$EPIC" --json` gates the structure and needs no marker.
# Only create a marker (`bd swarm create "$EPIC"`, handle -> metadata key `swarm`)
# when coordinator discovery or an external scheduler needs a durable handle.
T1=$(bd create "t1: <desc>" --parent "$FEATURE" --labels orc-node,agent:implementer --silent \
  --metadata '{"node":"t1","scope":["src/auth/**"],"execution_kind":"git"}')
bd dep add "$T3" "$T1"        # t3 depends on t1
bd dep cycles                 # must stay clean
```

The label MUST be `orc-node` (hyphen, plain label). `bd set-state` owns the `state:` label
dimension: each transition deletes the previous `state:<value>` label, adds the new one, and
emits an event bead -- the transition record.

## State mapping -- 11-state enum → bead status + `state:` label

Beads statuses are coarse and drive `bd ready`. The `state:` label carries the review-round
sub-state. One place per transition sets both:

```
bd set-state <bead> state=<name> --reason "<why>"     # label + event bead
bd update <bead> --status <status>                    # only where status changes
```

| Enum state | Bead status | `state:` label | Set by / how |
|---|---|---|---|
| `pending` | `open` | `state:pending` | creator at `bd create` (lead for epics, architect for features and tasks) |
| `ready` | `open` | -- (derived, never stored) | `bd ready --parent <epic> --label agent:<role> --unassigned` |
| `working` | `in_progress` | `state:working` | the claimant itself: `bd ready … --claim` (atomic, first-wins, sets assignee) then `set-state` |
| `reported` | `in_progress` | `state:reported` | worker, after its commits are captured |
| `in_review` | `in_progress` | `state:in_review` | architect, when it creates the review wisps |
| `changes_requested` | `in_progress` | `state:changes_requested` | architect on `REVIEW verdict=changes` |
| `approved` | `in_progress` | `state:approved` | architect on `REVIEW verdict=approve` |
| `merged` | `closed` | `state:merged` | shepherd: `set-state` then `bd close <bead> --reason merged` |
| `dismissed` | `closed` | `state:dismissed` | architect: `set-state` then `bd close <bead> --reason dismissed` |
| `failed` | `blocked` | `state:failed` | claimant: `set-state` then `bd update <bead> --status blocked` |
| `waiting_human` | `in_progress` | `state:waiting_human` | any role on `ASK`. When the node has not started yet, add `bd gate create --type=human --blocks <bead>` |

Semantics that fall out of the status column:

- **Deps clear on `closed`.** A dependent becomes ready only once its upstreams are
  `merged`/`dismissed`.
- **Pick the dependency type from what the dependent waits for.** `blocks` waits for the
  shepherd's merge, and the worker's code is already captured on a branch at `reported`.
  - Needs the upstream CODE: use a non-blocking type and stamp `base_ref=<upstream branch>`
    on the dependent. It then starts from the captured branch instead of the merge.
  - Needs the upstream DECISION to land first: keep `blocks`, which gates `bd ready`.
  - A `base_ref` dependent rebases when the upstream takes review changes. That rebase
    returns through the existing CONFLICT bounce-back path.
- **`failed` = `blocked` status** → never satisfies a dependency, never reappears in
  `bd ready`. Stranded downstream = `bd dep tree <bead>`.
- **`bd ready` excludes** gated beads, `in_progress`, `blocked`, `deferred`, and (by
  default) ephemeral beads. The ready front is therefore dep-correct by construction.
- **Review handoff is one enforced field.** The exit gate evaluates `label ~
  ^agent:reviewer$` on the reporting bead, and that label is the whole enforced handoff. A
  cleared assignee and `status=in_progress` are separate contract checks, evaluated
  independently -- never as one joined condition.

## Git-anchor contract

Two mechanisms hold code, and they are not interchangeable.

- **Worktrunk owns feature branches.** An architect works in a `wt` checkout that outlives
  it, so a replacement architect resumes the same tree. It is the **sole mutator** of that
  tree.
- **OMP isolation owns task work.** A worker is spawned `isolated: true` with
  `task.isolation.merge: branch` and `task.isolation.apply: false`, so its commits are
  captured on `omp/task/<id>` in the parent repository and no worker ever writes the
  architect's tree. The architect integrates those branches by explicit cherry-pick, when it
  chooses.

Anchors are stamped so any later session can find where work physically lives:

| When | Who | Stamp |
|---|---|---|
| Feature worktree prepared | architect | `wt switch --create <branch> --base <base> --no-cd --format=json`, stamp the Worktrunk var `bead=<feature-id>` on the branch (`wt config state vars set bead <feature-id> --branch <branch>`), stamp the feature's `branch`, canonical `worktree`, `base_sha` |
| Task dispatched | architect | nothing to provision: the runtime creates the isolated copy. Stamp `scope`, `execution_kind`, `origin` on the task bead |
| Worker reported | worker | `metadata.branch=omp/task/<id>` plus `push=<commit sha>` (the captured head) |
| Branch reclaimed after a child died | extension (reaper) | `recovered_branch=omp/task/<id>` |
| Branch proven integrated | extension (reaper) | `integrated=true`, then the branch is deleted |
| Claim | claim-holder | read `metadata.worktree` off the claimed bead -- the only authoritative source of where it works -- and cross-check `wt -C <path> step eval '{{ vars.bead }}' --format json` returns the same bead id. A mismatch means another actor owns that tree: stop and do not write |
| Merge | shepherd | `bd update <bead> --metadata '{"pr":<n>,"merge_sha":"<sha>"}'` |

Add a `repo` key when work lands in a different repository than the run epic. `--metadata`
merges with existing keys, so stamps never clobber `node` or `scope`. Branch, push, PR, and
merge anchors survive checkout teardown.

`worktree` rules:

- Every claim-holder resource that owns a tree owns its own canonical `worktree`. Task beads
  inherit from their feature; do not store a reviewer's path on a work node.
- Stamp it as an absolute path. The worktree-confinement rule matches the session's `cwd`
  against that value.
- Clear the pointer only after the claim is released and the checkout is reclaimed.

Choosing between a label and a metadata key is a cardinality rule, not a style preference.
Both filter on `bd ready` and both compose with `--claim`, so filterability does not
distinguish them.

| Carrier | Cardinality | Carries |
|---|---|---|
| Label | multi-value. A bead holds every label added | multi-value routing: `agent:`, `pr:`, `state:`, `kind:`, `lang:`, `evidence:` |
| Metadata | single-value per key. `--metadata` merges per key on write, so stamps never clobber `node` or `scope` | single-value enforcement: `worktree`, `branch`, `scope`, `base_sha`, `actor`, `origin`, `merge_sha`, `stage` |

A bead can hold `agent:implementer` AND `agent:reviewer` at once. A stage pipeline built on
labels accumulated `stage:implement` + `stage:review` + `stage:fix` and sat in three queues
simultaneously. Single-value keys therefore MUST be metadata: `worktree` as a label would
mean two confinement boundaries and a write guard that cannot choose. Worktree resolution is
also "own `metadata.worktree` else inherit from parent", and that walk reads exactly one
value per bead, so two worktree labels make it ambiguous at every level.

Flag forms: `bd update --metadata` takes a JSON string or `@file.json`, and
`--set-metadata key=value` is the repeatable form. Labels use `--add-label`,
`--remove-label`, `--set-labels`.

## Ready front + scope disjointness

Beads does not know about file scopes, so disjointness is checked beside it. The claim rule
in the extension reads the candidate's `scope` and every live claim's `scope` and applies a
conservative glob-overlap test (prefix containment in either direction; a bare `**`
conflicts with everything). A claim that overlaps a live one is refused with both bead ids
named.

```
bd ready --parent <epic> --label agent:<role> --unassigned --claim --json
```

That is one command, not a list-then-pick: the claim is atomic and first-wins, and an actor
accepts whatever the claim returns rather than cherry-picking a candidate. On a refusal,
leave the bead alone and pull again -- the overlap is a decomposition defect to report, not
an obstacle to route around.

The overlap check is friction, not a boundary: it catches the honest mistake and is
bypassable by construction. Disjoint `scope` globs written at decomposition time are the
real mechanism.

## Events: audit records + comments

The acting agent records every material protocol verb (`blocked advice reported review fix
conflict approve merged dismiss ask` + `failed`/`note`) as two writes, with identity from
`BEADS_ACTOR=<actor>`:

```
bd audit record --actor <actor> --kind tool_call --tool-name orc.<verb> \
  --issue-id <bead> --exit-code 0                    # append-only .beads/interactions.jsonl
bd comment <bead> "<VERB> <node> field=… output_ref=<abs artifact path>"
```

- **Audit record** = machine-parsable, append-only trail. `--tool-name orc.<verb>` carries
  the verb. Failures use `--exit-code 1` + `--error`.
- **Comment** = human-readable payload (the message fields), citing artifact paths instead
  of inlining long text.
- **Artifacts**: full briefs and reports go to
  `<artifacts>/<node>-<verb>-<resource>-<n>.md`, where `<resource>` is the id of the claimed
  bead or wisp. Every dimension reviewer of one node writes its REVIEW artifact at the same
  time, and the resource id is what keeps those filenames apart.
- State-carrying verbs additionally flip status and label per the mapping table;
  `bd set-state` emits its own event bead, so transitions are double-anchored.

Alongside these voluntary records, the extension keeps an involuntary one: every child's
mutating `bd` command is appended to `<artifacts_dir>/audit/<child-id>.bdlog` as
`ts, child, argv, exitCode`. It is passive provenance, never a gate, and it is the evidence
the `read-evidence` step of `mol-dead-claim-recovery` wants.

## Shepherd primitives

- **Mutual exclusion:** `bd merge-slot create` once per run (idempotent), with a stable
  holder such as `run-<id>-shepherd`. Acquire without `--wait`. Contention is advisory, so
  report the current holder and either enqueue as a waiter and yield, or retry after
  release. Always release -- on success, conflict, CI wait, and failure alike. On restart,
  `bd merge-slot check` and verify remote state before releasing a slot held by the same
  stable actor.
- **Async waits:** `bd gate create --type=gh:pr --blocks <bead> --await-id <pr#>` (PR merge)
  or `--type=gh:run --await-id <run-id>` (CI). `bd gate check` evaluates and closes resolved
  gates; `bd ready --gated` finds what a cleared gate released. A gated bead stays out of
  `bd ready`.
- **Evidence:** `orc_conflict_probe` (`conflicts`, `pairwise`, `ci`) predicts merges without
  touching a tree and reads CI; `orc_bot_review_probe` grades the review-bot round at the
  PR's exact head. `unknown` and `declined` are never clean.

## Read the run (status / resume / close-out)

`orc_run_status` is the standard report: it rolls each epic up through its features to their
tasks and resolves blockers via `bd blocked`. Use it instead of hand-assembling a summary.
The queries below are for the questions it does not answer.

| Question | Command |
|---|---|
| one bead's story | `bd show <bead> --json` + `bd comments <bead>` |
| audit trail | filter `.beads/interactions.jsonl` by `issue_id`/`actor`, plus `<artifacts_dir>/audit/*.bdlog` |
| dep structure / impact | `bd dep tree <bead>`, `bd graph` |
| open waits | `bd gate list`, `bd merge-slot check`, `bd ready --gated --json` |
| unanswered patrols | `bd dep list <epic> --direction=up --type relates-to --json` filtered on `wisp_type == "patrol"` and a non-closed status. `bd list` hides ephemeral beads outright, even under `--wisp-type patrol`, and takes no `--include-ephemeral`: only `bd ready` does |
| resume after crash | in-flight = `bd list --parent <epic> --status in_progress --json`; actor = `assignee`; location = `metadata.worktree`/`branch`; surviving code = `git branch --list 'omp/task/*'` |
| unintegrated code | `git cherry <feature-branch> omp/task/<id>` -- `+` per commit not yet upstream, `-` per patch-equivalent already integrated. Ancestry checks are useless here, because integration is cherry-pick |
| close-out gate | `bd dep cycles` clean AND `bd list --parent <epic> --status in_progress,blocked --json` empty AND no stranded bead AND no undrainable merge bead AND every captured branch scanning all `-` |
| stranded beads | `comm -13 <(bd ready --parent <epic> --json \| jq -r '.[].id' \| sort) <(bd list --parent <epic> --status open,blocked --no-assignee --json \| jq -r '.[].id' \| sort)`, which lists beads that are unassigned but not ready. Then run `bd list --parent <epic> --status in_progress --json` and check each nonempty `assignee` against a live actor |

A bead that is neither ready nor claimed counts as stranded. The store never reports a dead
actor, so the stranded query is the only signal. Two measured cases, both of which pass the
`in_progress,blocked` gate:

- A provider 403 killed two test shepherds before they wrote any claim or comment. Three
  merge beads stayed claimable after both actors died.
- A bounced bead keeps an owner who never returns.

Merge beads carry no `orc-node` label and no parent, so both queries above skip them. They
strand a third way: the bead is open and unassigned, yet missing an anchor the cross-run
queue matches on. Before close-out, run this query.

```bash
bd list --label-any pr:merge,agent:integrator --status open --json \
  | jq -r '.[] | select((.labels|index("pr:merge")|not)
      or (.labels|index("agent:integrator")|not)
      or ([.metadata.repo,.metadata.origin,.metadata.branch]|any(.==null))) | .id'
```

Empty output passes the gate. Any id listed is drainable by nobody: the cross-run queue
finds a merge bead only when every anchor is present. A run on bd 1.2.2 made merge beads
holding `agent:integrator` alone, so `bd list --label pr:merge` returned nothing against
beads that existed. Presence checks pass that run; label checks do not.

## SpecKit / external frameworks

A poured SpecKit molecule already IS a dependency-aware run DAG. When one drives the work,
its implement-step children ARE the node beads. Never pour a second molecule and never build
a second graph: add the `orc-node` label, one `agent:<role>` routing label, and `scope`
metadata to the existing step beads. The claim rule, the state mapping, and the anchor
contract then apply unchanged.
