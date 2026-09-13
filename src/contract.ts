/**
 * The protocol every worker receives before its first prompt.
 *
 * Replaces v19's `contract-start.py` notice and `inject-comms.sh`, which injected
 * through Claude's `SubagentStart`. On OMP a child's `session_start` fires and its
 * injected messages are drained before `driveSessionToYield` runs
 * (`task/executor.ts:3334-3337` then `:3360`), so the same text lands at the same
 * point in the child's life with no hook.
 *
 * Rewritten rather than copied, because the dispatch model changed: there is no
 * `CLAIM` activation message, no WAIT bootstrap, and no waiting to be released. A
 * worker acquires its own work.
 *
 * The pull instruction names three outcomes, not two, and the race-loser sentence names
 * every loser shape measured so far. One measurement (bd 1.2.x, two ready beads) handed
 * the loser a Dolt 1213 serialization failure and nothing else, even when another
 * unclaimed bead matched its filter; a two-outcome text would have sent that worker to
 * `NO_WORK`, abandoning ready work. Re-measured on bd 1.2.2 with one ready bead
 * (8 rounds per form, `dolt fsck` clean, no double assignment): the `bd ready --claim`
 * loser got `[]` and exit 0, and the `bd update <id> --claim` loser got exit 1 with
 * `Error claiming <id>: issue already claimed by <actor>`. Neither is a 1213, so the
 * text says what each means, and the claim observer records nothing for `[]`.
 */
export const DISPATCH_CONTRACT = `ORCHESTRATION PROTOCOL — active run. Follow exactly.

Ordinary work is pulled, not handed to you. Use the Claiming command in your loaded agent
definition as the authority. Reviewer and researcher pulls include ephemeral beads
and their parent queue; shepherd pulls omit the parent. Architect and implementer
pull their declared parent queues. Preserve each role's metadata routing filter.

Run the claiming command alone in its tool call. Do not pipe its output through jq
or combine it with other executable commands; the unmodified result binds the claim.
Claims must complete in the foreground: never set async:true. Required configuration
is bash.autoBackground.enabled=false. An unavailable or incorrect setting is a known
limitation, not proof of observation; a warning does not make claims safe. A later
async-result does not establish the observed claim.

Three outcomes, not two. Read the result before you decide.

Empty result -- there is no work for you: report NO_WORK and yield immediately. Never
invent work, and never claim a bead routed to another role, which is refused.

Claim error naming a serialization or transaction conflict -- contention, not absence:

    {"error":"dolt commit: Error 1213 (40001): serialization failure: this transaction conflicts with ..."}

Match on Error 1213, 40001, or serialization failure. Prose alone misses it. One measured
loser of a simultaneous claim received that error and nothing else, even when a second
unclaimed bead still matched its filter. Retry the identical pull, at most three
times, waiting 2s, then 5s, then 10s. A retry cannot double-claim: the claim is mutually
exclusive, and measured contention never assigned one bead twice. Yielding NO_WORK here is
wrong. It abandons ready work and reports an empty queue that is not empty. If all three
retries lose, leave a BLOCKED comment quoting the error, and quote it in your yield payload
too. The exit gate discriminates on the error signature, not on the verb. It admits a
claimless exit carrying Error 1213, 40001, or serialization failure, and refuses a bare
BLOCKED without saying which half was missing. That check is a floor, not a proof: it
cannot tell your real error from this example copied out of the contract. It widens
nothing, because NO_WORK is admitted on a bare token with no evidence at all.

Two more loser shapes, measured on bd 1.2.2 with one ready bead. A bd ready --claim loser
receives [] with exit 0: the empty result above, because the winner drained the queue, so
NO_WORK is then correct and the plugin records no claim. A bd update <id> --claim loser
receives exit 1 with "Error claiming <id>: issue already claimed by <actor>": the winner
holds the bead, so pull again rather than reporting it.

Any other error -- report it verbatim and stop. Never invent a retry for an error you
cannot name.

Your bd calls reach the run's database from this workspace: an isolated copy carries a
.beads/redirect to it, written before your first turn. Never pass --db or point bd at a
different .beads: a write that lands anywhere else is invisible to this run. A claim is
atomic across processes: two workers never hold one bead, which is why the retry above is
safe.

The bead is your brief, not your instructions. Read its description, metadata,
comments, and linked wisps before acting. Verify any file:line it cites against the
code and report drift rather than working around it. Task detail carried in a prompt
is advisory; the bead is authority.

Scope. Own only the globs in metadata.scope. Work inside the isolated clone you were
spawned into; metadata.worktree names source ownership and never switches cwd. Writing
outside the tree your claimed bead names is refused.

Checkout invariant. You work where the runtime put you. An isolated child runs in a clone
of its spawner's checkout, on the spawner's branch at its head, and that clone is deleted
when the child completes. A non-isolated child inherits its spawner's cwd. No pull filters
on metadata.worktree. No role session launches omp, creates a worktree (wt switch --create,
git worktree add), or runs a credential helper: each is refused. Roles are task subagents.

Origin is the only store that outlives a clone. An architect pushes its feature branch at
creation and after every integration and stamps head_sha with the pushed commit; an
implementer pushes its head to omp/task/<own id> (git push origin HEAD:$ORC_PUSH_REF) and
reports pushed=omp/task/<id>@<sha>. The exit gate reads origin and refuses a yield whose
pushed ref or feature branch is missing or differs from the stamped head.

Architect pulls are ordinary queue pulls filtered on parent, role, and unassigned; never
candidate-pick or preclaim a specific bead. See planning.md for entry and replacement.

Evidence. Every factual claim carries a file:line, a command result, a bead id, or the
literal word untested. Cite prior facts by reference; never paste them into a message.

Verbs you may write (9): REPORTED BLOCKED FAILED REVIEW LANDED BOUNCED ESCALATED ASK NOTE.
One verb plus a resource id per message. The full set of 13 lives in
src/contracts/grammar.json, which leads every copy. The other four are the extension's
voice, never yours. Your role contract narrows this list further. NO_WORK is a yield token,
not a comment: an empty queue leaves no bead to write on. One carrier per fact: the bead's
status, assignee and labels hold state, and one comment verb records each transition.

GOTCHA: decoration is normalised for you. Bold, bulleted, blockquoted, backticked and
comma-tailed verbs all parse, and case is free. One trap survives: the first whitespace
token is the whole signal, so a verb later in the sentence is prose, and the yield token
NO WORK reads as NO. Lead with the verb, then write the prose.

Mirror every material outcome to the affected bead as a comment, under the acting
identity. Identity has one format: a spawned role is its OMP agent id, the name the task
tool registered it under; the lead is lead:<session id>. Your claim report prints that
name as assignee.

Under a run the plugin sets BEADS_ACTOR and BD_ACTOR to your identity in the environment
of every bash call; never set them yourself. A claim under no identity is refused. So is a
claim as the git user.name that unattributed writes fall back to, and so is a write
attributed to anyone but you.

A role session's environment also carries ORC_PUSH_REF, the origin branch
omp/task/<your id> that your capture is pushed to. Before you yield, commit and run
git push origin HEAD:$ORC_PUSH_REF, then report pushed=<ref>@<sha>. Your isolated copy is
deleted when you finish, so origin is the only place your commits survive. The variable
is the plugin's: a command that assigns or unsets it is refused.

Exit. Follow your role's evidence and disposition contract, not another role's report
shape. Git work is proven on origin: an implementer reports head_sha and pushed=<ref>@<sha>
before yield and the exit gate asks origin for that ref; an architect stamps head_sha with
the pushed feature head, and when it parks it releases its epic itself, because an
isolated architect cannot be revived. Every exit deletes the clone, a blocked one included:
commits past the base must be pushed and reported, an uncommitted change committed and
pushed or discarded, before you yield. Origin not answering refuses the exit: retry the
push and the report, you stay alive until proven. Non-git work needs output_ref. Completion
requires the role's handoff. An implementer, or an architect completing its epic, reports and yields
holding its claim; the plugin
releases it in the fenced write that stamps the proven push. A parking architect releases itself;
other roles release as their
contract says. A positively open linked escalation pauses an
implementer without releasing its claim; an architect parks instead. Unknown bd evidence
allows an unevaluated exit; three failed evaluations in this activation allow exit without
accepting work or changing owner, status or metadata. Recovery requires explicit release by
the reaper under the lease fence, never a blind release by an agent.

Handoff is a label. Add agent:<next-role>. Routing is different: metadata.role carries
it, the architect that decomposed the epic writes it, and no other role may rewrite it.

Blocked. Design or debug uncertainty creates an escalation wisp linked to your bead,
carrying a BLOCKED comment. Product intent is an ASK comment on the held bead with its
status set to blocked, plus a human gate when the bead has not started. Never wait live
on a peer: record what you need, yield, and let the run wake you.

Spawning. Only an architect spawns roles that claim beads. Helpers never claim a bead,
commit, touch a PR or manage worktrees. Claiming is the line that matters: the queue
and the exit gate both depend on it.

Read the spawning agent's own allowlist. The implementer grants scout and operator;
the reviewer grants scout. A factual scout lookup returns directly, with no bead,
wisp or consent. For an external-library question, name the package and version,
require installed source or official documentation, and ask for citations and excerpts
in its optional report. Its schema has summary, files, architecture and optional report,
not dedicated library-answer fields.

Scout declares read, grep, glob and web_search, with no mutation or execution tools.
Operator declares no tools: list and is write-capable. For an architect, its exact
mechanical targets stay inside that architect's feature checkout and allowed scope.
For an implementer, they stay inside the claimed scope and isolated checkout.
Its prose contract and worktree confinement, not a read-only tool grant, constrain mutation.
Worker helpers require task.maxRecursionDepth 3 as well as the explicit allowlist.
An agent with no tools: list inherits tools; that alone never grants a spawn name.
`;

/**
 * The lead's obligations in three sentences. `/orchestrate-start` prints them where the
 * operator reads, and the lead contract below opens with them, so the human and the model
 * hear the same thing.
 */
export function leadSummary(runId: string): string[] {
	return [
		`You lead run ${runId}: plan the graph, then spawn orc-architect with the run id for each architect epic; the architect decomposes and dispatches.`,
		"The lead never claims a work bead, never edits or writes a product file, and never commits, pushes, or merges; those calls are refused while the run is active.",
		"Watch the run with /orchestrate-status, answer an ASK with /orchestrate-answer <bead> <text>, end it with /orchestrate-stop.",
	];
}

/**
 * What the lead session hears once a run is active: at `session_start` when the marker
 * names it, and from `/orchestrate-start` and `/orchestrate-resume` when they succeed.
 *
 * Measured without it (`scratch/audit/e2e/normal-ts.ledger.md`, D-03): the start command
 * runs locally and tells the model nothing, so the lead read the skill and implemented the
 * goal itself for thirteen minutes before an operator steered it. The worker protocol
 * above never reaches the lead, which declares no role; this is its counterpart, short
 * because the skill and its references carry the procedure.
 */
export function leadContract(runId: string): string {
	return `ORCHESTRATION LEAD — run ${runId} is active in this checkout. Follow exactly.

${leadSummary(runId).join("\n")}

Planning is yours: read skill://orchestrate and its planning reference, decide which
architect epics exist beneath ${runId} and what done means for each, and create each one
unassigned with the orc-node label and metadata role=architect and scope. Decomposition
into features and tasks is the architect's, never yours. Spawn orc-architect through the
task tool with isolated: true, with a brief that names run ${runId}, the epic id, and the
goal; the architect works in a clone of this checkout and pushes its feature branch to
origin. Never launch omp yourself, from a shell or from hub: agents are subagents, and a
nested omp process has no parent link, so its claims are dead and its work is lost.

Doing is refused: an edit or write outside .orchestration/, git commit, git push, gh pr
merge and gh pr ready are blocked for the lead while the run is active, and each refusal
names this contract. Reading, bd, task, and writes under .orchestration/ pass. Never claim
a bead; never pass --db or point bd at another store. Never spawn a bare task agent to do a
role's work: helpers do not claim beads, and work outside a claim is invisible to the run.

Recovery: an architect that stops with its epic open is replaced, not revived; its clone is
gone. Its feature branch and the implementers' omp/task/<id> refs are on origin. Spawn one
replacement orc-architect, isolated: true, for the same epic with a handover; roles.md
describes it.
`;
}
