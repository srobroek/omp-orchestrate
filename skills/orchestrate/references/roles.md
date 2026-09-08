# Roles, models, escalation

Five agents ship: `orc-architect`, `orc-implementer`, `orc-reviewer`, `orc-researcher`,
`orc-shepherd`. Each names one OMP model role. Tune model selection through `modelRoles`,
not raw provider selectors in agent files. Each role inherits its configured thinking level.

`orc-reviewer` names `@reviewer`, which OMP does not ship. Configure
`modelRoles.reviewer` before a run. The verdict comes from a separate agent;
model-family separation requires an explicit model choice. An unresolved role can fall back
to the session model or fail selection; preflight reports it before dispatch.

Escalation is per-spawn `effort`, not a second agent. There is no deep variant of any role.

| Role | Agent | Model role | Lifetime | Works in | Claims |
|---|---|---|---|---|---|
| Lead | you (this session) | session model | whole run | the primary checkout | never claims anything |
| Architect | `orc-architect` | `@plan` | long-lived, parked between waves, revivable | its Worktrunk feature worktree; **not** isolated | one epic, pulled |
| Implementer | `orc-implementer` | `@task` | ephemeral, one bead | an isolated copy; commits captured on `omp/task/<id>` | one task bead, pulled |
| Reviewer | `orc-reviewer` | `@reviewer` | ephemeral, one verdict | inspects the captured branch or feature tree without editing code; dispatch determines checkout isolation | one review wisp, pulled |
| Researcher | `orc-researcher` | `@smol` | ephemeral, one answer | reads assigned sources without editing code; dispatch determines checkout isolation | one escalation wisp or research bead, pulled |
| Shepherd | `orc-shepherd` | `@task` | ephemeral, two phases across the CI gate | PR and merge state only; no content edits | merge beads (label `pr:merge`, metadata `role=shepherd`), pulled |
| Helper | `scout`, or another non-claiming child its spawner's allowlist names | its loaded definition | ephemeral, inside its spawner's await | its spawner's checkout; mutation only when explicitly scoped and granted | nothing -- architect helpers are traced by a wisp; worker factual lookups return directly |

The reviewer uses the configured `@reviewer` role. The researcher uses `@smol` and
escalates hard cases per spawn with `effort`.

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
- **Escalation that once went to an advisor routes to `role=researcher`.** The researcher's
  contract is a durable `ADVICE` comment on the bead, read-only. Never spawn an advisor, and
  never answer your own escalation.
- **Product intent was never an advisor's to decide.** It is an `ASK` wisp plus a human gate.

## Capabilities and access

| Role | Writes | Spawns | Notes |
|---|---|---|---|
| Lead | run epics, their metadata, wakes | architects | coordination and bounded factual inspection; delegates implementation and substantive domain investigation |
| Architect | its feature tree, commits, draft PR, decomposition beads | exactly the names in its own `spawns:` allowlist | owns feature-tree mutations, directly or through one awaited scoped helper; explicitly cherry-picks captures; never merges a PR |
| Implementer | code inside `metadata.scope`, in its isolated copy | `scout`, `operator` | operator is write-capable; its exact targets stay inside the claimed scope and isolated checkout |
| Reviewer | comments and verdicts | `scout` | reads the captured branch or feature tree; omits `edit` and `write`, but retains `bash` for verdicts and reading git, so no-code-edit is also a prose contract |
| Researcher | comments (`ADVICE`), artifacts under `<artifacts>` | nothing | investigation only; never edits code |
| Shepherd | PR state, `pr` and `merge_sha`, fix beads, merge-slot | nothing | the only role that may merge; never edits or pushes content |
| Helper | only explicitly scoped files in its spawner's checkout when write-capable | only its own allowlist within the depth limit | no bead, no commit, no PR, no worktree. An architect's helper outcome is promoted to a feature comment before its trace wisp can be compacted |

`tools:` restricts built-in tools, not every execution path. The parser adds `yield`;
child execution adds `hub` and grants `task` only when spawn policy and depth allow it.
Extension-registered tools and configured MCP tools can remain available outside that list.
No `tools:` key means inherited tools. Bash, GitHub and eval-capable tools can mutate state
without `edit` or `write`; no-code-edit rules are behavioral contracts, not a sandbox.

The shepherd explicitly requests its conflict/CI and bot-review probes plus `hub`.
The extension must register those probes. Missing probes require BLOCKED, not a shell
substitute that skips their evidence checks.

A declaration guarantees nothing about which definition answers to a name. Discovery resolves
a bare name in order, and a marketplace plugin claims it before a bundled agent. Bundled
agents load last, and a claimed name is dropped (`@oh-my-pi/pi-coding-agent`,
`src/task/discovery.ts:120-133`). An allowlist entry names a name, not a definition, so an
install can change what it grants with no edit to these files.

Only the architect spawns a role that claims beads. Two independent conditions gate any
spawn, and the allowlist is the binding one:

1. **The agent declares an explicit `spawns:` allowlist.** Package agents without a
   grant spawn nothing. Do not grant `*` or add `task` to a non-spawning role's tools.
   Native preflight enforces the resolved names for both `task` and eval child APIs;
   a disallowed child is rejected before model execution.
2. **The depth ladder allows the child.** `lead(0) → architect(1) → worker(2) → leaf(3)`, so
   a worker's helper needs `task.maxRecursionDepth: 3`. At the default 2 the
   lead-architect-worker chain has already spent the ladder.

Depth alone fixes nothing: raise the ceiling without declaring the allowlist and every
worker spawn is still refused. Declare the allowlist without the ceiling and the child is
refused for depth. A bead-claiming role spawned by a worker stays a design error under both.

## Choosing between a queue and a spawn

| Situation | Do this |
|---|---|
| The work deserves a bead, review, and a captured branch | create the task bead with `role=implementer` and dispatch a wave |
| A bounded sweep or mechanical operation that saves substantial context/execution | optionally spawn an allowlisted helper in your checkout, trace architect helpers with a wisp, and await the terminal result before resuming writes |
| A design or debug question that needs judgment, not a factual lookup | route it to `role=researcher` rather than deciding it yourself |
| A small repository or external-library fact | read it directly; use `scout` only for a substantial bounded lookup. Worker factual returns need no bead, wisp or consent; external briefs require package/version and primary-source citations |
| A verdict on work that reported | create the review wisp with `role=reviewer`; never review what you wrote |
| A landing unit is approved | create the merge bead and spawn the shepherd |

A read-only node goes to the researcher rather than the architect in the first place. On
pure analysis the reading *is* the reasoning, so a delegating layer only adds a hop and
re-reads context the analyst already holds.

## Research escalation: four steps

A worker cannot spawn a bead-claiming role. Its architect owns dispatch and resumption:

1. The implementer creates a parented, related escalation wisp with
   `role=researcher`, `execution_kind=escalation`, source scope and `origin_actor`.
   It records `BLOCKED` and yields paused, retaining the source claim.
2. The architect dispatches `orc-researcher` on that queue.
3. The researcher verifies version-matching `ADVICE` on both node and wisp, closes
   and releases the answered wisp, then notifies the architect with its id. A ping to
   a still-live requester is optional; it cannot resume a finished isolated task.
4. The architect collects both actual terminal results and preserves any successful
   paused-worker capture. Before releasing/requeueing the retained source claim,
   establish an operationally exclusive window with every claim/dispatch/branch writer
   stopped and re-read current evidence. No exclusion means no mutation: preserve
   the claim and report unresolved resumption. A replacement reads the durable advice.

Findings stand on the wisp whether or not the ping lands, so the flow never depends on a
message surviving. The ping is a doorbell over writing that already happened: not retried,
not blocked on, carrying no content.

**The factual shortcut.** `scout` returns `summary`, `files`, `architecture` and an
optional `report`. A worker reads that direct return with no bead, wisp, consent or
hop 2. For an external-library question, name the package and version, require
installed source or official documentation, and request citations and excerpts in
`report`. There are no dedicated library-answer or API-signature fields. Keep the
four steps for unresolved design or debug uncertainty and choices someone must own.

Scout's declared tools are `read`, `grep`, `glob`, `web_search`. Its contract forbids
mutation and command execution; inspect runtime-added tools before treating it as isolated.
The bundled scout sets `readSummarize: false`: bare code reads return source rather than
structural summaries with bodies elided. Keep bounded reads and return exact evidence.

`operator` declares no `tools:` key and is write-capable. The architect grants it
for bounded mechanical work in its own feature checkout and allowed scope; the
implementer grants it inside its claimed scope and isolated checkout. Neither may
target another agent's tree. This is not a read-only helper grant.

UI work goes to a scoped `orc-implementer` bead with approved intent, existing
tokens/primitives, required states, viewport widths and accessibility acceptance.
Unresolved product choices require an `ASK` wisp and human gate. UI implementation is
not a contract-free helper task.

Depth closes the fan-out half instead. A worker sits at depth 2, so its helper lands at depth
3, where the executor empties `spawnsEnv`. That helper spawns nothing, whatever its tools say.
Containment is the worktree-confinement gate plus the helper's own prose.

Read the loaded definition and keep every helper's no-bead, no-commit, no-PR and
no-worktree constraints explicit. An allowlist authorizes a name, not a sandbox.

The factual shortcut requires `scout` in the worker's own `spawns:` allowlist and
`task.maxRecursionDepth: 3`. The implementer and reviewer already grant it. The four
hops still route judgment to the researcher through the architect's existing grant.

## Research fan-out / fan-in

The actor needing the answer owns the question and decomposition. Resolve small facts
directly. Use one researcher for a bounded investigation; fan out only independent
source slices that merit separate contexts. Add a synthesis pass only when conflicting
or voluminous results need one; otherwise the owner combines the bounded returns.

Bound the fan-out width to the sources that matter, and record what was skipped. Gatherers
spawn nothing.

## Escalation ladder
`effort` is a relative selector, not a literal thinking level. It overrides the agent's
default when `task.enableEffort` is enabled:

| Supported levels | `lo` | `med` | `hi` |
|---|---|---|---|
| low, medium | low | low | medium |
| low, medium, high, xhigh | low | medium | xhigh |

Use `lo` for routine scout collection. Researcher work uses `@smol`;
omit `effort` to retain that role's configured thinking level.
Before escalation, inspect the resolved model's supported levels and configured ceiling.
Select `hi` only for an explicitly justified escalation to that model's highest allowed level.
`hi` does not request an unsupported literal high or bypass the model ceiling.
Do not change the global ceiling to handle one model.


1. **The instance, not the role.** A task that failed on reasoning depth is respawned with
   `effort: "hi"`. Name the attempt that failed and say why it was depth rather than missing
   context, a tooling block, or bad scope -- if you cannot, effort is not the answer.
   `effort` requires `task.enableEffort: true`; without it the escalation silently no-ops.
2. **`BLOCKED kind:design|debug`** creates an escalation wisp linked to the bead, carrying a
   `BLOCKED` comment, and the blocked actor yields. An open escalation wisp pauses the
   author's exit contract rather than failing it, so waiting is not punished. A researcher
   pulls the wisp (`--include-ephemeral`) and completes the four-step escalation
   lifecycle above, including closure and architect-owned safe resumption.
3. **A dispute that durable evidence does not settle** gets one fresh read-only researcher
   at `effort: "hi"` on the escalation wisp. Its `ADVICE` is promoted to a comment before
   anyone acts on it.
4. **Product intent, or anything outside the brief,** becomes an `ASK` wisp plus
   `bd gate create --type=human`. No agent decides it.

Never upgrade a whole role to paper over one hard case, and never wait live on a peer at any
rung: record what you need, yield, and let the run wake you.

## Optional specialist briefs

Select review dimensions for material risks or project policy. Independent node review
remains required; a fixed roster of additional guards does not.

| Helper | When and required input |
|---|---|
| `adversarial-challenger` | unresolved material claim/decision; give facts, evidence and attempts without leading reasoning |
| `security-reviewer` | material trust-boundary risk; give scoped paths, entry points and trust assumptions |
| `docs-guard`, `lint-guard` | existing command findings need judgment; first run the repo command and supply a bounded `lint_report` artifact with node, bead, scope and files. They cannot run the command themselves |
| `pr-reviewer` | PR-level risks or project policy require a pass; give PR number, repository and conventions. Its verdict informs landing, never authorizes a merge |

`orc-reviewer` supplies the required bead verdict against captured work. `pr-reviewer`
is optional, non-claiming PR inspection across the assembled diff and repository context.
Skip it when it would repeat the same review without a distinct risk or policy requirement.

Read the loaded helper's output schema rather than assuming a name fixes its return shape.
`pr-reviewer` has GitHub mutation capabilities; retain the no-PR-mutation helper boundary.
Use `skill://sniff` for its analyzer-backed workflow rather than spawning its internal
`bloodhound` or `refactor-challenger` steps bare.
