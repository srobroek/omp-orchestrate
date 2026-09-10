/**
 * G1 — bead-write-free sessions.
 *
 * A generic helper (a spawned worker with no `ORC-ROLE`) has no bead contract of
 * its own. During an active orchestrate run, the pinned `BEADS_DIR` identifies
 * the run database and the repository beside it owns a valid active-run marker;
 * only then does G1 impose `BD_READONLY=1` on the helper's shell calls.
 *
 * The run and pin checks are deliberate. A helper in an unrelated OMP process,
 * or a process sharing the same cwd without the process-local pin, remains
 * writable. Contract-bound `orc-*` roles remain writable because their exit
 * contracts require bead comments and state transitions.
 *
 * Verified against a scratch database: under `BD_READONLY=1`, `bd show`,
 * `bd ready`, and `bd list` all exit 0, while `bd update`, `bd comment`,
 * `bd label add`, `bd close`, and `bd ready --claim` each exit 1 with
 * `Error: operation '<op>' is not allowed in read-only mode` and leave the
 * bead untouched. The variable name is exact — `BEADS_READONLY` and
 * `BD_READ_ONLY` do nothing, and there is no config key.
 */

import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ToolCallEventResult } from "@oh-my-pi/pi-coding-agent";
import { isBeadWriteFree } from "../identity";
import { readActiveRunStrict } from "../run-state";

/**
 * Real `bash` parameters, used to rebuild the replacement input.
 *
 * A revision must be the tool's **raw execution input**, not the normalized
 * `event.input` view a handler receives — that view "may carry derived gate-only
 * fields ... that are not real parameters" (`extensibility/shared-events.ts:315-321`).
 * Spreading `event.input` would forward those into `execute`, so the replacement is
 * rebuilt from this allowlist instead.
 */
const BASH_PARAMS = ["command", "cwd", "env", "i", "pty", "timeout", "async"] as const;

/**
 * Return the G1 environment addition for a generic helper in an active run.
 *
 * `ensureBeadsPath` supplies a non-empty absolute process-local pin. The active
 * marker normally belongs to the session checkout, while a linked worktree may
 * share the primary checkout's `.beads`; check both roots without treating either
 * as mutation authority. `readActiveRunStrict` rejects malformed authority, so
 * every uncertain candidate fails open.
 */
export async function beadWriteFreeEnv(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): Promise<Record<string, string> | undefined> {
	if (!isBeadWriteFree(pi, ctx)) return undefined;

	const beadsDir = process.env.BEADS_DIR;
	if (beadsDir === undefined || beadsDir.length === 0 || !path.isAbsolute(beadsDir)) return undefined;

	for (const root of new Set([ctx.cwd, path.dirname(beadsDir)])) {
		try {
			if ((await readActiveRunStrict(root)) !== null) return { BD_READONLY: "1" };
		} catch {
			// An unreadable or malformed candidate is not positive run authority.
		}
	}
	return undefined;
}

/**
 * The process pin, as an addition for a Bash call that carries no `BEADS_DIR`.
 *
 * The persistent shell of an interactive session predates the pin the run (or the
 * beads plugin) placed on `process.env`, so the pin has to travel on the call. The
 * beads plugin injects it too; a `tool_call` handler's revision replaces any other
 * extension's, so whichever revision wins must carry the pin itself.
 */
export function pinAddition(input: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
	const pin = env.BEADS_DIR;
	if (pin === undefined || pin.length === 0 || !path.isAbsolute(pin)) return {};
	const existing = input.env;
	const current = existing !== null && typeof existing === "object" ? (existing as Record<string, unknown>).BEADS_DIR : undefined;
	if (typeof current === "string" && current.length > 0) return {};
	return { BEADS_DIR: pin };
}

/** Rebuild raw Bash input from the allowlist, preserving a rewritten BEADS_DIR. */
export function rebuildBashInput(input: Record<string, unknown>): Record<string, unknown> {
	const existing = input.env;
	const env: Record<string, unknown> =
		existing !== null && typeof existing === "object" ? { ...existing } : {};
	const revised: Record<string, unknown> = {};
	for (const key of BASH_PARAMS) {
		if (key in input) revised[key] = input[key];
	}
	if (Object.keys(env).length > 0) revised.env = env;
	return revised;
}

/**
 * One revision carrying every gate's environment addition, or nothing when the call
 * already has them all.
 *
 * A `tool_call` handler returns a single result, so environment gates cannot each
 * return their own revision. G1 is the only contributor left, and this stays the seam
 * that merges additions instead of returning a second revision that would be dropped.
 *
 * An addition already present is dropped rather than rewritten, so a call the gates
 * have nothing to add to re-enters no revalidation path.
 */
export function reviseBashEnv(
	input: Record<string, unknown>,
	additions: Record<string, string>,
): ToolCallEventResult | undefined {
	const existing = input.env;
	const env: Record<string, unknown> =
		existing !== null && typeof existing === "object" ? { ...existing } : {};

	let changed = false;
	for (const [key, value] of Object.entries(additions)) {
		if (env[key] === value) continue;
		env[key] = value;
		changed = true;
	}
	if (!changed) return undefined;

	const revised: Record<string, unknown> = {};
	for (const key of BASH_PARAMS) {
		if (key in input) revised[key] = input[key];
	}
	revised.env = env;

	return { input: revised };
}
