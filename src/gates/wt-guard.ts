/**
 * G3 — Worktrunk owns worktrees, and the operator owns Worktrunk.
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
 * The refusal names the route the seat actually has. The lead is the operator's session
 * and creates checkouts through `wt switch --create`. A role session has no such route:
 * an architect and an implementer each run in an isolated clone OMP made for them, a
 * reviewer reads the architect's tree, and G7 (`./push`) refuses the Worktrunk form from
 * every role; sending a role to `wt switch` would only hand it a second refusal. So a
 * role is told to work in the tree it was given. A role-less helper hears the lead's
 * wording, because the lead is the only seat that may act on it.
 *
 * Matching is on parsed argv rather than substrings, so a bead comment that merely
 * mentions `git worktree` does not trip the gate.
 *
 * The dispatcher (`src/index.ts`) runs this only inside a run scope (`src/run-scope.ts`):
 * a valid active-run marker in the session checkout. OMP's own `git worktree add` rewrite
 * lives inside the bash tool's `execute`, after `tool_call` handlers, so an unconditional
 * refusal here had made that host feature unreachable in every session that installed
 * the plugin.
 */

import type { ExtensionContext, ToolCallEventResult } from "@oh-my-pi/pi-coding-agent";
import { orcRole } from "../identity";
import { invokesCommand } from "../shell";

interface ForbiddenInvocation {
 argv: readonly string[];
 /** What was refused, quoted back so the reader knows which command tripped the gate. */
 named: string;
}

const FORBIDDEN: readonly ForbiddenInvocation[] = [
 ...["add", "move", "lock", "unlock", "prune", "remove", "repair"].map(subcommand => ({
  argv: ["git", "worktree", subcommand],
  named: "git worktree",
 })),
 { argv: ["gh", "pr", "checkout"], named: "gh pr checkout" },
];

/** The route the refused seat has instead, by whether the session declares a role. */
function sanctionedRoute(role: string | undefined, named: string): string {
 if (role === undefined) {
  return named === "git worktree"
   ? "worktrees are managed by wt; use 'wt switch --create <branch>' rather than 'git worktree'"
   : "use 'wt switch' rather than 'gh pr checkout'; the checkout must stay bound to its bead";
 }
 return (
  `'${named}' creates a checkout, and Worktrunk is the operator's: a ${role} creates no checkout in a run. ` +
  `Work in the tree you were given -- your isolated clone, or the architect's tree you were spawned into -- ` +
  `and push your commits to omp/task/<your id> before you yield.`
 );
}

/**
 * Refuse a shell command that would create a checkout Worktrunk does not know about.
 * Without `ctx` the seat is unknown and the refusal names the lead's route.
 */
export function gateWorktrunkOwnership(input: Record<string, unknown>, ctx?: ExtensionContext): ToolCallEventResult | undefined {
 const command = input.command;
 if (typeof command !== "string" || command.length === 0) return undefined;

 for (const forbidden of FORBIDDEN) {
  if (invokesCommand(command, forbidden.argv)) {
   return { block: true, reason: sanctionedRoute(ctx === undefined ? undefined : orcRole(ctx), forbidden.named) };
  }
 }
 return undefined;
}
