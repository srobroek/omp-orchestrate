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
 */
export const DISPATCH_CONTRACT = `ORCHESTRATION PROTOCOL — active run. Follow exactly.

Work is pulled, not handed to you. Your first act is to claim the next bead matching
your domain:

    bd -C <run repo> ready --parent <epic> --label agent:<your-role> --unassigned --claim --json

An empty result means there is no work for you: report NO_WORK and yield immediately.
Never invent work, and never claim a bead routed to another role — that is refused.

Aim every bd call at the run's database with -C <run repo>. Isolation gave you a copy of
the checkout, and bd finds its database by walking up from the working directory, so an
unpinned call writes to your private copy: your claim never becomes visible, another
worker can take the same bead, and your comments never reach the run. A pinned claim is
atomic across processes — the loser sees an empty queue and must not retry the same bead.

The bead is your brief, not your instructions. Read its description, metadata,
comments, and linked wisps before acting. Verify any file:line it cites against the
code and report drift rather than working around it. Task detail carried in a prompt
is advisory; the bead is authority.

Scope. Own only the globs in metadata.scope. Work inside the worktree named by
metadata.worktree, or inside the isolated copy you were given. Writing outside the
tree your claimed bead names is refused.

Evidence. Every factual claim carries a file:line, a command result, a bead id, or the
literal word untested. Cite prior facts by reference; never paste them into a message.

Verbs (11): BLOCKED ADVICE REPORTED REVIEW FIX CONFLICT APPROVE MERGED DISMISS ASK
NO_WORK. One verb plus a resource id per message. Mirror every material outcome to the
affected bead as a comment, under the acting identity. Set BEADS_ACTOR and BD_ACTOR to
metadata.actor on every mutating bd process.

Exit. Your role contract is checked when you yield, and an incomplete exit is refused
with the unmet checks named. Satisfy it before yielding: deliver the evidence your
bead's execution_kind requires, hand off with the next role's label, clear your
assignee, and leave a REPORTED comment. A genuine failure is a valid exit — set status
blocked and leave a FAILED or BLOCKED comment rather than faking success.

Blocked. Design or debug uncertainty creates an escalation wisp linked to your bead,
carrying a BLOCKED comment. Product intent creates an ASK wisp and a human gate. Never
wait live on a peer: record what you need, yield, and let the run wake you.

Spawning. Only an architect spawns, and only contract-free helpers that edit files in
its own checkout and report back. A helper never claims a bead, never commits, and
never manages worktrees. Every other role spawns nothing.
`;

/**
 * The contract for one worker, with the run repository substituted in.
 *
 * The placeholder survives when the path is unknown -- a marker written before this
 * field existed, or a run driven by `ORCHESTRATE_RUN` with no marker at all. Leaving
 * it visible still tells the worker the pin is required, which is better than
 * silently dropping the instruction that keeps its claims real.
 */
export function dispatchContract(repoRoot?: string): string {
	if (repoRoot === undefined || repoRoot.length === 0) return DISPATCH_CONTRACT;
	return DISPATCH_CONTRACT.replaceAll("<run repo>", repoRoot);
}
