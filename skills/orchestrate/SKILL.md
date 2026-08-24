---
name: orchestrate
description: Use when decomposing work across multiple subagents with isolated worktrees, independent review, safe merging, and durable run state in beads (bd).
---

# Orchestrate

Role: lead session. You own the run's shape and nothing else. Work lives in beads as
`epic → feature → task`, and no actor hands work to another:

- You create run epics and spawn architects.
- An architect owns one epic and dispatches its own workers.
- Every worker pulls the next bead matching its domain.

Your context window is the run's scarcest non-recoverable resource. Spend it on routing
decisions, never on content.

The extension injects the dispatch protocol (`references/dispatch-contract.md`) into every
worker before its first prompt. When a worker yields, the extension re-checks that worker's
role contract. Never paste the protocol into a prompt.

## Core rules

1. **Orchestrate, don't execute.** Push every token-heavy action to the cheapest capable
   agent and keep only its terse result. Token-heavy work means reading source, writing
   code, research, diff review, running tests. Your own direct actions are high-level
   decomposition, `bd`, the `orc_*` tools, the slash commands, content-free wakes. Never
   open a gate, tool, or formula implementation to debug an actor. Diagnose the actor from
   its durable evidence, or delegate the diagnosis.
2. **Dispatch belongs to the actor that created the work.** You spawn architects. An
   architect spawns the workers for its own epic and its own shepherd. Bead creation and
   dispatch are then consecutive acts of one actor, so ready work never sits unobserved
   behind a parked lead.
3. **Pull, never hand off.** A spawn prompt names the epic and the queue, never the work.
   The bead is the brief. Send no activation message. A worker acknowledges nothing.
4. **The architect is the sole mutator of its feature tree.** Workers run isolated with
   `task.isolation.apply: false`, so their commits are captured on `omp/task/<id>`
   branches and no worker touches the architect's checkout. The architect integrates those
   branches when it chooses (rule: push, don't merge).
5. **Only the architect spawns.** It may spawn the four other `orc-*` roles plus
   contract-free helpers that edit files in its own checkout while it waits on them. A
   helper never claims a bead, never commits, and never manages a worktree. Every other
   role spawns nothing.
6. **Route content peer to peer.** A blocked worker writes an escalation wisp. A
   researcher answers it with a durable `ADVICE` comment. A reviewer writes its FIX
   material on the review wisp. You create shells, wake actors, and read state -- you never
   relay questions, findings, or briefs.
7. **Never wait live on a gate or a peer.** A gate is not work: CI, release workflows, bot
   rounds, long reviewers. Park the bead with what is awaited and how to resume, take the
   next ready node, and exit when only external waits remain. A run that ends mid-stream
   because the lead sat on a gate has failed its record even when the work landed.
8. **Durable state, bounded processes.** Beads, captured branches, and GitHub are the
   record. Wisps and hub messages are coordination. Promote every material outcome to a
   comment before the wisp can be compacted away.

## Bootstrap

1. Prerequisites: `bd` (run state) and `wt` (Worktrunk, all local checkout lifecycle) on
   `PATH`. Missing either → stop. Orchestrate has no fallback store and no second checkout
   mechanism.
2. No database yet → `bd init --stealth --prefix orc`. Stealth init is git-invisible: it
   writes `.git/info/exclude` and leaves `git status` clean.
3. Copy the plugin's `formulas/*.formula.toml` into this repository's `.beads/formulas/`.
   `bd` reads formulas from `<beads-dir>/formulas/` and `.beads/formulas/` only, so a
   linked package contributes no formulas until you copy them. Verify with
   `bd formula list`.
4. `/orchestrate-run` writes `.orchestration/.active-run` with `run_id=pending`. Where a
   previous activation recorded a binding, it preserves that binding instead. The command
   is idempotent, so a restart re-runs it safely. Gitignore `.orchestration/`.
5. Create the run epic and its artifacts directory. The directory is absolute and lives
   outside every worktree. Both a relative path and a path under a Worktrunk checkout are
   invalid.

   ```
   EPIC=$(bd create "orchestrate run-<id>" --type epic --silent \
     --metadata '{"run_id":"run-<id>","primary_branch":"main","base_sha":"<sha>",
                  "artifacts":"<abs>/.orchestration/run-<id>/artifacts","origin":"<lead-actor>"}')
   bd create "patrol run-<id>" --ephemeral --wisp-type patrol --deps relates-to:"$EPIC" --silent
   ```

6. `/orchestrate-bind <epic-id>` binds the pending marker to that epic. Rebinding the same
   id is a harmless no-op. A *different* id is refused, because a second run epic in one
   tree is a mistake rather than a retarget. Binding without a marker is refused too:
   activate first. Read the binding back before dispatching -- a pending marker makes every
   claim invalid.

Put run identity and artifact paths on the epic. Never broadcast them in prompts.

## Decompose

You own the high-level plan: which epics exist, who owns them, what "done" means. The
decomposition inside an epic belongs to its architect, which reads the domain you have not
read. Delegate any planning pass that needs domain code.

- One epic per architect domain. A feature is the PR + worktree unit. A task is the worker
  unit. Give every task a `scope` of disjoint globs, and serialize overlap with a
  dependency instead of hoping.
- Order with `bd dep add <dependent> <dependency>`. `bd dep cycles` must stay clean. A bead
  with an open blocker is invisible to `bd ready`, which is how sequencing works.
- Gate on structure before dispatching anything: `bd swarm validate <epic> --json`, and
  stop on `swarmable=false`. Read `warnings` too and triage them. These warnings are real:
  cycles, disconnected nodes, multiple endpoints, an empty graph. An `outside epic` warning
  naming a merge bead is **expected**: merge beads are deliberately unparented so a
  shepherd can drain them across runs. The same warning on any other bead is a real
  finding.
- Create a `bd swarm` marker only when durable coordinator discovery or an external
  scheduler needs a handle. The epic is already persistent.

Details: `references/planning.md`. Store contract: `references/beads-store.md`. A choice
that leaves one bead's scope is a decision bead: `references/decisions.md`.

### SpecKit: adopt, never re-pour

A poured SpecKit molecule already is a dependency-aware DAG. Detect it by `spec_id` plus
`metadata.spec_dir` on the beads under the feature. The architect adopts the implement-step
children as its decomposition: add the `orc-node` label and one `agent:<role>` routing
label, stamp `scope` metadata, and reconcile each step against the code. Phase steps route
by their `skill_hints`. `speckit-verify` and `speckit-sync` keep their own agents, and human
gates resolve with `bd gate resolve`.

Never pour a second molecule over work that is already poured, and never build a parallel
graph beside one that exists. `specs/*/tasks.md` is the conductor's file, not yours -- the
extension denies writes to it.

## Dispatch

An architect sizes each wave to the ready front of its epic and spawns it as one `task`
batch. The entry shape is literal:

```
{ name: "<CamelCase>", agent: "orc-implementer", task: "<epic id + queue, not the work>", isolated: true }
```

Add `effort: "lo" | "med" | "hi"` per entry to escalate one hard case instead of upgrading a
whole role. Add `outputSchema` with `schemaMode: "strict"`: a non-conforming exit then
hard-fails parent-side, which is the shape-only net under the exit contract.

Required settings. The model silently degrades without every one of them:

| Setting | Value | Why |
|---|---|---|
| `task.isolation.mode` | anything but `none` | workers must not share the architect's tree |
| `task.isolation.merge` | `branch` | commits are captured as a branch, not replayed |
| `task.isolation.apply` | `false` | the runtime reports "captured on branch, not merged" and leaves the architect's tree untouched. Integration stays an explicit architect act |
| `task.enableEffort` | `true` | defaults **false** platform-wide. Without it, the per-entry `effort` is silently ignored |
| `BEADS_DOLT_SHARED_SERVER` | `1` | isolation gives each worker a copy of the checkout, and `bd` finds its database by walking up from the working directory. Without shared-server mode each worker writes a private database, so its claims, comments and statuses never reach the run, and two workers can hold one bead |

Depth is `lead(0) → architect(1) → worker(2)`, inside `task.maxRecursionDepth: 2`.
`task.maxConcurrency` bounds wave width: a wave that finishes early is cheap to respawn,
one that is too big idles against the cap.

The database rule outranks the other four. Isolation working correctly is what splits the
database, so a run whose settings block is perfect still loses every claim. A bead created in
a copied checkout is invisible in the original. Where shared-server mode is unavailable, every
agent must aim its own calls at the run's checkout with `bd -C <run repo>`. The extension
reports both preconditions once per session, in a `WARN settings` comment on the run epic.

A wave launched into a degraded MCP server or LSP is diagnosable from the bead trail: the
extension writes a `WARN preflight: <servers> degraded` comment on the epic and lets the
spawn proceed. It never holds a wave.

## Pull loops

Every role's first act is its own claim. `--claim` is atomic and first-wins, so a lost race
returns empty and mutates nothing. `bd ready --claim` takes the first bead matching the
filter. `bd update --claim` is idempotent for the same actor. An empty result means
`NO_WORK`: report it and yield rather than widening the filter.

| Role | Claim |
|---|---|
| `orc-architect` | `bd ready --parent <run-epic> --label agent:architect --unassigned --claim --json` |
| `orc-implementer` | `bd ready --parent <epic> --label agent:implementer --unassigned --claim --json` |
| `orc-reviewer` | `bd ready --include-ephemeral --parent <epic> --label agent:reviewer --unassigned --claim --json` |
| `orc-researcher` | `bd ready --include-ephemeral --parent <epic> --label agent:researcher --unassigned --claim --json` |
| `orc-shepherd` | `bd ready --label agent:integrator --unassigned --claim --json` |

Without these two filter facts, both queues read empty forever:

- Review and research work arrives as ephemeral wisps, and `bd ready` hides ephemeral beads
  unless `--include-ephemeral` is passed.
- Merge beads are deliberately unparented, so the shepherd's pull **must not** use
  `--parent`.

Set `BEADS_ACTOR` and `BD_ACTOR` to the claimed bead's `metadata.actor` on every mutating
`bd` process. One activation owns at most one bead and cannot claim another until the first
is terminal.

## Review and merge

1. A worker reports: evidence stamped, `agent:reviewer` label added, assignee cleared,
   `REPORTED` comment written. Its commits are already on `omp/task/<id>`.
2. The architect integrates those branches into its feature tree, serially, resolving
   conflicts as its own work. With the branches integrated, it creates one review wisp for
   each dimension **before** any reviewer starts, and opens the PR in `draft` state.
3. Reviewers pull their wisps, write verdicts as comments, and never review their own work.
   A `CHANGES` verdict returns the node to its queue with the union of FIX items attached.
   The last reviewer to approve closes the final wisp and makes the PR ready.
4. The architect creates the merge bead and spawns a shepherd. A merge bead carries
   **labels `pr:merge` + `agent:integrator`, no parent, and no type of its own** --
   `merge-request` is a `bd ready -t` filter alias, not a creatable type. Stamp these keys:
   `repo`, `branch`, `base_sha`, `origin`, `integration_owner=orchestrate`. The cross-run
   queue finds the bead by those keys, and the standalone drain refuses it.
5. The shepherd is ephemeral and two-phase across the CI gate. Phase one reviews the
   landing unit, opens or readies the PR, creates the gate. It yields **without** holding
   the merge slot. Phase two spawns fresh after the gate clears, acquires the slot without
   `--wait` (or enqueues as a waiter and yields), merges, stamps `pr` and `merge_sha`, and
   releases. Its five duties:

   - landing-unit review: approved scope, no extra commits, no stale base, not code
     judgment
   - unlanded-dependency check
   - queue-priority adjustment
   - reading the real CI and bot outcomes
   - informing the architect by comment on the feature bead
6. A bounce writes bead state first: fix bead created unassigned, assignee cleared, routing
   label restored. It wakes the bead's `metadata.origin` architect last, with a
   content-free `hub` send. The state is complete without the message. The message only
   saves a round trip.

Probe evidence with these tools, and never read the evidence by eye:

| Tool | Answers |
|---|---|
| `orc_conflict_probe` | `conflicts`: does the branch merge into the base? `pairwise`: do two branches touch the same files? `ci`: what does `gh pr checks` say? Mutates no tree. |
| `orc_bot_review_probe` | the review-bot round at the exact head of the PR: clean, absent, pending, stale, actionable, declined, unknown. Neither `unknown` nor `declined` is **ever** clean. |
| `orc_resolve_queue_dispatch` | one `release-queue-watch` record → an orchestrate node. Exit 2 means no orchestrate owner (route once to `pr-shepherd`). Exit 3 means ambiguous ownership -- never reroute. See `references/queue-watcher.md`. |
| `orc_run_status` | the standardized rollup: epic → feature → task, with blockers resolved. |

## Recovery

Bead state is the truth and it is complete at every instant, so recovery reads state rather
than reconstructing intent.

- **Automatic, in-process.** The extension subscribes to the subagent lifecycle bus in
  every session that spawns. On a child's terminal event it re-runs the same contract
  evaluator the exit gate uses against live bead state. A child that exited `completed`
  but left its bead claimed or its contract unmet is treated as a bounce: `RECLAIM`
  comment, assignee cleared, status back to `open`, `recovered_branch` stamped when
  commits survive on `omp/task/<id>`. A branch is deleted only once `git cherry` proves
  every commit is already integrated and the bead is terminal -- cleanup is proof-gated,
  never time-gated.
- **Across a restart.** Those subscriptions die with the process. The per-epic patrol wisp
  is the durable marker that reconciliation is owed. Draining it is a fresh architect's
  first duty: run the same sweep from bead state alone (cross-check every `in_progress`
  assignee under the epic against the live roster), run the merge-completeness scan,
  re-arm the wisp.
- **By hand.** `orc_run_status` reports in-flight beads with their blockers, and
  `/orchestrate-status` names the run's epics. `/orchestrate-roster` shows each queue's
  ready depth. Unanswered patrols, unintegrated branches, and closed-but-unmerged
  inconsistencies are explicit queries -- the ones in `references/beads-store.md`. A
  contested claim runs the `mol-dead-claim-recovery` formula, whose human gate is the
  backstop. `bd stale --status in_progress` proposes candidates and proves nothing: age is
  a diagnostic, never evidence of death. Never steal a claim on a timestamp.

Recovery preserves artifacts, pushed branches, and comments. It never auto-commits a dirty
worktree and never force-deletes an unscanned branch. See `references/lifecycle.md`.

## Enforcement

One gate fails closed. The rest are friction: they catch the honest mistake at near-zero
cost and say so in their own refusal text. Do not design a control on top of friction.

| Layer | Surface | Status |
|---|---|---|
| exit contract | `tool_call` on `yield`, in every claim-holding session including the architect's | **fail-closed.** Resolves the caller's bead from live `bd` state, evaluates the role's contract, blocks with the unmet checks named. |
| claim routing + scope | `tool_call` on `bash` (`bd … --claim`) | friction. Refuses a bead routed to another role, or one whose `scope` overlaps a live claim. |
| read-only `bd` | `tool_call` on `bash` | friction. Imposes `BD_READONLY=1` on a session holding no bead contract -- a helper, not an `orc-*` role, whose contracts need `bd` writes. |
| worktree confinement | `tool_call` on `bash`, `edit`, `write` | friction. Refuses edits outside the tree the claimed bead names. |
| Worktrunk bypass | `tool_call` on `bash` | friction. Denies `git worktree`, `gh pr checkout`, and writes to `specs/*/tasks.md`. |
| strict output schema | parent-side, per spawn | shape only. `schemaMode: "strict"` hard-fails a malformed exit. Semantics stay with the exit contract. |

After three refusals the exit contract force-allows. It writes `BOUNCE`, clears the
assignee, and reopens the bead first, so nothing exits claimed-and-silent. The lead declares
no role, so it fails every eligibility check and can claim nothing.

Every friction rule is bypassable by construction -- another tool, `sh -c`, a `write` then
a run. Real authority lives in `bd` itself (`bd --readonly`), or the exit contract detects
the violation after the fact: `merge_sha` and `pr` written by a non-shepherd are caught at
exit and corrected by the shepherd. The two paths that skip `yield` entirely -- the bounce
force-allow and an abort -- are caught parent-side by the reaper, which runs the same
evaluator.

## References

| Ref | Contents |
|---|---|
| `references/dispatch-contract.md` | the protocol the extension injects into every worker |
| `references/roles.md` | the five agents, their model roles, capabilities, escalation |
| `references/lifecycle.md` | states, transitions, completion paths, recovery, gates, cleanup |
| `references/beads-store.md` | the store: bead vocabulary, state mapping, anchors, audit, shepherd primitives |
| `references/planning.md` | decomposition, routing envelope, scope hygiene, concurrency |
| `references/decisions.md` | cross-boundary decision beads, edge types, duplicate resolution |
| `references/queue-watcher.md` | `release-queue-watch` handoff and receipt discipline |

## Reporting status

Asked for status -- of the run, one architect domain, or one actor -- run `orc_run_status`
and report what it prints. It rolls each epic up through its feature beads and resolves
blockers with `bd blocked`. It reads `metadata.actor` alongside `assignee`, because `bd
update --status` does not set an assignee.

| Question | Call |
|---|---|
| whole run | `orc_run_status` |
| one epic, every bead | `orc_run_status` with `epic: <id>`, `full: true` |
| one architect domain | `orc_run_status` with `feature: <id>` |
| what one actor holds | `orc_run_status` with `actor: <name>` |

Do not hand-assemble a summary from `bd list`: it drops the blocker chain and the feature
rollup, and two hand-written summaries never match.
