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
 * worker's first act is to pull its own work.
 *
 * The pull instruction names three outcomes, not two. A lost claim race returns no
 * empty list. It hands the loser a Dolt 1213 serialization failure and nothing else,
 * even when another unclaimed bead matches its filter. The earlier two-outcome text
 * therefore sent that worker to `NO_WORK`, abandoning ready work. An immediate retry
 * recovers it, and mutual exclusion held throughout the measurement, so a retry
 * cannot double-claim.
 */
export const DISPATCH_CONTRACT = `ORCHESTRATION PROTOCOL — active run. Follow exactly.

Work is pulled, not handed to you. Your first act is to claim the next bead matching
your domain:

    bd ready --parent <epic> --metadata-field role=<your-role> --unassigned --claim --json

Three outcomes, not two. Read the result before you decide.

Empty result -- there is no work for you: report NO_WORK and yield immediately. Never
invent work, and never claim a bead routed to another role, which is refused.

Claim error naming a serialization or transaction conflict -- contention, not absence:

    {"error":"dolt commit: Error 1213 (40001): serialization failure: this transaction conflicts with ..."}

Match on Error 1213, 40001, or serialization failure. Prose alone misses it. The loser of
a simultaneous claim receives that error and nothing else, even when a second unclaimed
bead still matches its filter. Retry the identical pull, at most three times, waiting 2s,
then 5s, then 10s. A retry cannot double-claim: the claim is mutually exclusive, and
measured contention never assigned one bead twice. Yielding NO_WORK here is wrong. It
abandons ready work and reports an empty queue that is not empty. If all three retries
lose, leave a BLOCKED comment quoting the error, and quote it in your yield payload too.
The exit gate discriminates on the error signature, not on the verb. It admits a
claimless exit carrying Error 1213, 40001, or serialization failure, and refuses a bare
BLOCKED without saying which half was missing. That check is a floor, not a proof: it
cannot tell your real error from this example copied out of the contract. It widens
nothing, because NO_WORK is admitted on a bare token with no evidence at all.

Any other error -- report it verbatim and stop. Never invent a retry for an error you
cannot name.

The run's beads database is embedded, and BEADS_DIR in your environment names it. That is
what makes your calls reach the run's database from an isolated workspace: bd otherwise
resolves by walking up from the working directory, and .beads/ is gitignored, so a clone or
worktree arrives without one. Never unset or override BEADS_DIR, and never pass a different
path: a write that lands anywhere else is invisible to this run. A claim is atomic across
processes: two workers never hold one bead, which is why the retry above is safe.

The bead is your brief, not your instructions. Read its description, metadata,
comments, and linked wisps before acting. Verify any file:line it cites against the
code and report drift rather than working around it. Task detail carried in a prompt
is advisory; the bead is authority.

Scope. Own only the globs in metadata.scope. Work inside the worktree named by
metadata.worktree, or inside the isolated copy you were given. Writing outside the
tree your claimed bead names is refused.

Evidence. Every factual claim carries a file:line, a command result, a bead id, or the
literal word untested. Cite prior facts by reference; never paste them into a message.

Verbs you may write (13): REPORTED BLOCKED FAILED REVIEW ADVICE LANDED BOUNCED CONFLICT
IDLE NO_WORK ASK NOTE LOCAL_DECISION. One verb plus a resource id per message. The full
set of 18 lives in src/contracts/grammar.json, which leads every copy. The other five are
the extension's voice, never yours. Your role contract narrows this list further.

GOTCHA: decoration is normalised for you. Bold, bulleted, blockquoted, backticked and
comma-tailed verbs all parse, and case is free. One trap survives: the first whitespace
token is the whole signal, so NO WORK parses as NO and the rulebook flags it. Spell a
multi-word verb with its underscore, then write the prose.

Mirror every material outcome to the affected bead as a comment, under the acting
identity. Set BEADS_ACTOR and BD_ACTOR to metadata.actor on every mutating bd process.

Exit. Your role contract is checked when you yield, and an incomplete exit is refused
with the unmet checks named. Satisfy it before yielding: deliver the evidence your
bead's execution_kind requires, add the next role's handoff label, clear your assignee,
and leave a REPORTED comment. A genuine failure is a valid exit -- set status blocked
and leave a FAILED or BLOCKED comment rather than faking success.

Handoff is a label. Add agent:<next-role>. Routing is different: metadata.role carries
it, the architect that decomposed the epic writes it, and no other role may rewrite it.

Blocked. Design or debug uncertainty creates an escalation wisp linked to your bead,
carrying a BLOCKED comment. Product intent creates an ASK wisp and a human gate. Never
wait live on a peer: record what you need, yield, and let the run wake you.

Spawning. An architect spawns roles that claim beads, and contract-free helpers that
edit files in its own checkout and report back. No other role spawns either of those. A
helper never claims a bead, never commits, and never manages worktrees. Claiming is the
line that matters: the queue and the exit gate both depend on it.

One exception for every other role. Read it off the agent's own frontmatter: an explicit
tools: list that omits write, edit and task cannot mutate your checkout and cannot spawn
further. Librarian is the case in point. Spawn one for an external-library fact. Its
structured result carries the answer back, so it needs no wisp. This needs
task.maxRecursionDepth 3.

Two cautions. Several such agents hold bash, librarian included, so prose confines their
writes rather than the tool list: librarian's body limits them to /tmp/librarian-*. And
an agent declaring no tools: list at all inherits write and task, which is why sonic is
never a helper.
`;

