/**
 * G9 — the lead plans and never edits or merges.
 *
 * Measured in the end-to-end campaign (`scratch/audit/e2e/normal-py.ledger.md`, D-01;
 * normal-ts D-03; crash-recovery D-01): after `/orchestrate-start` the lead session read
 * the skill and then did the work itself -- created worktrees, edited, committed, pushed,
 * opened PRs and merged one over red CI -- with zero architects spawned and zero beads under
 * the run. Every other gate targets a worker by its role or its claim; the lead is
 * role-less and claims nothing, so nothing refused it.
 *
 * This gate refuses, from the lead of an active run, the acts that are other roles' by
 * contract: `gh pr merge` and `gh pr ready` (the landing sweep and the shepherd own
 * merges), `git commit` and `git push` (an implementer's, captured on its branch), and an
 * `edit` or `write` of a product file (any file inside a git working tree, except under
 * `.orchestration/`, which is the run's own directory). Every refusal names the recovery:
 * spawn `orc-architect` with the run id. `bd`, `task`, reads, and shell commands that
 * neither commit nor push nor merge pass untouched.
 *
 * The lead is `isLeadSession`: the session the marker names. A worker is never refused
 * here, so the identity read runs only once a command or target has matched.
 *
 * Product file, not "inside the run's checkout": the campaign's lead edited in a Worktrunk
 * worktree it created beside the primary, which no containment check on the primary
 * would have seen. A git working tree is recognised by its `.git` entry -- a directory in
 * a primary, a file in a linked worktree or an isolated copy -- walked up from the target
 * without a spawn. Paths outside every checkout (`/tmp` scratch, a temp file for a bead
 * description) and non-path targets (`xd://`, `local://`) are not product files.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { ExtensionContext, ToolCallEventResult } from "@oh-my-pi/pi-coding-agent";
import { runScope } from "../run-scope";
import { isLeadSession } from "../run-state";
import { invokesCommand } from "../shell";
import { declaredTargets, realpathOrUndefined } from "./worktree";

/** Shell commands that land or capture work: the lead does neither. */
const LANDING_COMMANDS: readonly (readonly string[])[] = [
	["gh", "pr", "merge"],
	["gh", "pr", "ready"],
	["git", "commit"],
	["git", "push"],
];

/** The run's own directory beneath a checkout: the marker, artifacts, plans. */
const ORCHESTRATION_DIR = ".orchestration";

/** A target naming a scheme rather than a filesystem path (`xd://lsp`, `local://plan.md`). */
const URI_TARGET = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

/** The context this gate reads: the seat, and the session behind it. */
export type LeadGateContext = Pick<ExtensionContext, "cwd" | "sessionManager">;

function refusal(act: string, runId: string): ToolCallEventResult {
	return {
		block: true,
		reason: `${act} is refused for the lead of run ${runId}: the lead plans and never edits or merges; spawn orc-architect with the run id and let the run's roles do this work`,
	};
}

/**
 * The target's path within the git working tree it sits in, or `undefined` outside every
 * checkout. The target may not exist yet (a `write` creates it), so the walk starts at its
 * lexical location and the longest existing prefix is canonicalised, which keeps a
 * checkout reached through a symlinked path recognisable.
 */
async function checkoutRelative(cwd: string, declared: string): Promise<string | undefined> {
	const target = path.resolve(cwd, declared);
	let existing = path.dirname(target);
	const rest = [path.basename(target)];
	for (;;) {
		const real = await realpathOrUndefined(existing);
		if (real !== undefined) {
			existing = real;
			break;
		}
		const parent = path.dirname(existing);
		if (parent === existing) return undefined;
		rest.push(path.basename(existing));
		existing = parent;
	}
	const resolved = path.join(existing, ...rest.reverse());
	for (let top = path.dirname(resolved); ; top = path.dirname(top)) {
		if (await fs.stat(path.join(top, ".git")).then(() => true, () => false)) return path.relative(top, resolved);
		if (path.dirname(top) === top) return undefined;
	}
}

/**
 * Refuse a landing command, or a product-file edit, from the lead of the active run.
 * `undefined` for every other call, every other tool, and every other seat.
 */
export async function gateLeadContract(ctx: LeadGateContext, toolName: string, input: Record<string, unknown>): Promise<ToolCallEventResult | undefined> {
	if (toolName === "bash") {
		const command = input.command;
		if (typeof command !== "string" || command.length === 0) return undefined;
		const landing = LANDING_COMMANDS.find(argv => invokesCommand(command, argv));
		if (landing === undefined) return undefined;
		const scope = await runScope(ctx);
		if (scope === null || !(await isLeadSession(ctx))) return undefined;
		return refusal(landing.join(" "), scope.runId);
	}
	if (toolName !== "edit" && toolName !== "write") return undefined;
	const targets = declaredTargets(toolName, input);
	if (targets === undefined || targets.length === 0) return undefined;
	const scope = await runScope(ctx);
	if (scope === null || !(await isLeadSession(ctx))) return undefined;
	for (const target of targets) {
		if (target.includes("\0") || URI_TARGET.test(target)) continue;
		const relative = await checkoutRelative(ctx.cwd, target);
		if (relative === undefined || relative.split(path.sep)[0] === ORCHESTRATION_DIR) continue;
		return refusal(`${toolName} ${target}`, scope.runId);
	}
	return undefined;
}
