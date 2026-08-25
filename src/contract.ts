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
 * The 11 verbs the contract above names, in its own order.
 *
 * Kept beside the text that declares them so the two cannot drift; the parity test
 * asserts every one of them still appears in `DISPATCH_CONTRACT`.
 */
export const PROTOCOL_VERBS = [
	"BLOCKED",
	"ADVICE",
	"REPORTED",
	"REVIEW",
	"FIX",
	"CONFLICT",
	"APPROVE",
	"MERGED",
	"DISMISS",
	"ASK",
	"NO_WORK",
] as const;

/**
 * Every verb a bead comment may lead with: the 11 above, the dispositions and escapes
 * the role contracts test for, the verbs this extension writes itself, and the three
 * the skill defines for a worker.
 *
 * Assembled from the repository rather than from the `orc-comment-verbs` regex this
 * table replaces, and each entry has a use site:
 *
 *  - `FAILED` — the escape clause of every role contract, `comment.verb in [FAILED,
 *    BLOCKED]` (`src/contracts/implementer.json:52` and its five siblings).
 *  - `LANDED`, `BOUNCED`, `IDLE` — the shepherd's disposition
 *    (`src/contracts/shepherd.json:6`).
 *  - `RECLAIM` — the reaper's comment when a child dies still holding a bead
 *    (`src/supervision.ts:201`).
 *  - `STALL`, `WARN`, `GOAL` — the watchers' comments (`src/watchers.ts:206`, `:506`,
 *    `:560`).
 *  - `BOUNCE` — written when the exit contract's bounce budget is spent
 *    (`src/gates/exit.ts:305`).
 *  - `NOTE`, `WAITING_HUMAN`, `LOCAL_DECISION` — the skill's own comment contracts
 *    (`skills/orchestrate/references/lifecycle.md:343`, `:226`, and
 *    `references/beads-store.md:44`).
 *
 * The regex also admitted `BRIEF`, which nothing in this repository defines or writes.
 * It is dropped rather than carried: a verb with no use site cannot be the reason a
 * comment is accepted.
 */
export const COMMENT_VERBS: Record<string, true> = {
	...Object.fromEntries(PROTOCOL_VERBS.map(verb => [verb, true])),
	FAILED: true,
	LANDED: true,
	BOUNCED: true,
	IDLE: true,
	RECLAIM: true,
	STALL: true,
	WARN: true,
	GOAL: true,
	BOUNCE: true,
	NOTE: true,
	WAITING_HUMAN: true,
	LOCAL_DECISION: true,
};

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
