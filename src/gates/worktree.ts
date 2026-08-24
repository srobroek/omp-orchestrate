/**
 * G2 — writes stay inside the tree the claimed bead names.
 *
 * Restores the bead-keyed write enforcement that died when the `worktrunk-writer`
 * package was deleted, and moves it earlier: v19 detected an out-of-scope write at
 * `SubagentStop`, after it had landed. This refuses it before it happens.
 *
 * The actor is not looked up. It arrives from the claim gate, which observes this
 * session's own `bd ... --claim` — see `src/claim-state.ts` for why a cold lookup is
 * circular.
 */

import path from "node:path";
import fs from "node:fs/promises";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ToolCallEventResult } from "@oh-my-pi/pi-coding-agent";
import { bdShow, metadataString } from "../bd";
import { observedClaim } from "../claim-state";

/** Tools that mutate the working tree and therefore need a scope check. */
export const GATED_WRITE_TOOLS: Record<string, true> = { bash: true, edit: true, write: true };

/**
 * Resolve a path through symlinks, or return `undefined` when it cannot be resolved.
 *
 * Comparing unresolved paths would let a symlink into another agent's tree pass, so
 * an unresolvable path fails open rather than comparing something misleading.
 */
async function realpathOrUndefined(target: string): Promise<string | undefined> {
	try {
		return await fs.realpath(target);
	} catch {
		return undefined;
	}
}

/**
 * The base directory OMP materialises task isolation workspaces under.
 *
 * An isolated worker's cwd is its isolation copy, not the feature worktree the bead
 * names, so a cwd under this base is legitimate and must pass. `OMP_WORKTREE_DIR`
 * overrides the `task.worktreeDir` setting, which itself defaults to `~/.omp/wt`.
 */
function isolationBase(): string {
	const configured = process.env.OMP_WORKTREE_DIR;
	if (configured !== undefined && configured.length > 0) return configured;
	return path.join(process.env.HOME ?? "", ".omp", "wt");
}

/** Refuse a mutation outside the worktree the claimed bead names. */
export async function gateWorktreeScope(ctx: ExtensionContext): Promise<ToolCallEventResult | undefined> {
	const claim = observedClaim();
	if (!claim || claim.beadIds.length === 0) return undefined;

	const cwd = await realpathOrUndefined(ctx.cwd);
	if (cwd === undefined) return undefined;

	// An isolated worker writes in its own copy; the bead still names the feature
	// worktree it was cloned from, so a comparison would always mismatch.
	const base = await realpathOrUndefined(isolationBase());
	if (base !== undefined && (cwd === base || cwd.startsWith(`${base}${path.sep}`))) return undefined;

	for (const beadId of claim.beadIds) {
		const bead = await bdShow(beadId);
		const declared = metadataString(bead, "worktree");
		if (declared === undefined) continue;

		const expected = await realpathOrUndefined(declared);
		if (expected === undefined) continue;

		if (cwd !== expected && !cwd.startsWith(`${expected}${path.sep}`)) {
			return {
				block: true,
				reason: `this session's cwd does not match metadata.worktree on claimed bead '${beadId}'; another actor owns that tree`,
			};
		}
	}

	return undefined;
}
