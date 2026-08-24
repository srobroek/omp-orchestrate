/**
 * G3 — Worktrunk owns worktrees.
 *
 * A port of `hooks-worktrunk`'s `worktrunk-guard.py`, which is a live
 * `PreToolUse:Bash` denial in the v19 package. The invariant survives the
 * migration: a feature checkout must stay bound to its bead through Worktrunk's
 * state vars, and `git worktree` or `gh pr checkout` creates one behind
 * Worktrunk's back, leaving a tree no bead names and no sweep reclaims.
 *
 * Its sibling `worktrunk-agent-guard.py` is deliberately **not** ported. That one
 * rejected Claude's `isolation: "worktree"` spawn request, and OMP's `isolated: true`
 * provisions and reclaims per-task workspaces itself, so there is nothing left to
 * deny.
 *
 * Matching is on parsed argv rather than substrings, so a bead comment that merely
 * mentions `git worktree` does not trip the gate.
 */

import type { ToolCallEventResult } from "@oh-my-pi/pi-coding-agent";
import { invokesCommand } from "../shell";

interface ForbiddenInvocation {
	argv: readonly string[];
	reason: string;
}

const FORBIDDEN: readonly ForbiddenInvocation[] = [
	{
		argv: ["git", "worktree"],
		reason: "worktrees are managed by wt; use 'wt switch --create <branch>' rather than 'git worktree'",
	},
	{
		argv: ["gh", "pr", "checkout"],
		reason: "use 'wt switch' rather than 'gh pr checkout'; the checkout must stay bound to its bead",
	},
];

/** Refuse a shell command that would create a checkout Worktrunk does not know about. */
export function gateWorktrunkOwnership(input: Record<string, unknown>): ToolCallEventResult | undefined {
	const command = input.command;
	if (typeof command !== "string" || command.length === 0) return undefined;

	for (const forbidden of FORBIDDEN) {
		if (invokesCommand(command, forbidden.argv)) {
			return { block: true, reason: forbidden.reason };
		}
	}
	return undefined;
}
