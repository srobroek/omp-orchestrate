/**
 * G1 — bead-write-free sessions.
 *
 * A generic helper (a spawned worker with no `ORC-ROLE`) has no bead contract of
 * its own. During an active orchestrate run, its checkout carries a valid active-run
 * marker; only then does G1 impose `BD_READONLY=1` on the helper's shell calls.
 *
 * The variable rides on the tool's `env`, which is a default the command text can
 * override: `BD_READONLY=0 bd ...`, `env -u BD_READONLY bd ...`, `unset BD_READONLY;
 * bd ...`. So under the sandbox a command that sets or unsets the variable is refused,
 * with a reason that names the sandbox. That is the one refusal here; everything else
 * is a revision. bd's own error (`operation 'update' is not allowed in read-only mode`)
 * names the variable, so editing it is the plausible next slip, not only an evasion.
 *
 * The run check is deliberate. A helper in an unrelated OMP process, or in a checkout
 * no run has marked, remains writable. Contract-bound `orc-*` roles remain writable
 * because their exit contracts require bead comments and state transitions.
 *
 * Verified against a scratch database: under `BD_READONLY=1`, `bd show`,
 * `bd ready`, and `bd list` all exit 0, while `bd update`, `bd comment`,
 * `bd label add`, `bd close`, and `bd ready --claim` each exit 1 with
 * `Error: operation '<op>' is not allowed in read-only mode` and leave the
 * bead untouched. The variable name is exact — `BEADS_READONLY` and
 * `BD_READ_ONLY` do nothing, and there is no config key.
 */

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ToolCallEventResult } from "@oh-my-pi/pi-coding-agent";
import { isBeadWriteFree } from "../identity";
import { readActiveRunStrict } from "../run-state";
import { editsVariable, effectiveSegments } from "../shell";

/** The variable the sandbox sets, so the refusal can name it. */
const SANDBOX_VARIABLE = "BD_READONLY";

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
 * Whether an orchestrate run marks this session: a valid active-run marker in the
 * session checkout. An isolated copy carries the primary's marker with it, so the one
 * root is enough; a linked worktree holds none and is under no run unless it declares a
 * role. `readActiveRunStrict` rejects malformed authority, so an uncertain marker reads
 * as no run.
 *
 * This is the run predicate every run-scoped check shares: G1 here, and in
 * `src/index.ts` G3, G6, the claim observer and G2.
 */
export async function pinnedRunActive(cwd: string): Promise<boolean> {
	try {
		return (await readActiveRunStrict(cwd)) !== null;
	} catch {
		// An unreadable or malformed marker is not positive run authority.
		return false;
	}
}

/** Return the G1 environment addition for a generic helper in an active run. */
export async function beadWriteFreeEnv(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): Promise<Record<string, string> | undefined> {
	if (!isBeadWriteFree(pi, ctx)) return undefined;
	return (await pinnedRunActive(ctx.cwd)) ? { BD_READONLY: "1" } : undefined;
}

/** Rebuild raw Bash input from the allowlist, dropping derived gate-only fields. */
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

/**
 * Whether the command sets or unsets the sandbox variable in any segment the shell will
 * run, wrapper shells included. Read only when the sandbox is on: a session G1 leaves
 * writable may say what it likes about the variable.
 */
function escapesSandbox(command: unknown): boolean {
	if (typeof command !== "string") return false;
	return effectiveSegments(command).some(segment => editsVariable(segment, SANDBOX_VARIABLE));
}

/**
 * G1 for one `bash` call: the sandbox refusal, or the environment revision.
 *
 * Returns a block when the helper is sandboxed and its command edits the sandbox
 * variable; otherwise the revision adding the readonly flag, or `undefined` when the
 * call is not sandboxed or already carries it.
 */
export async function gateBeadWriteFree(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	input: Record<string, unknown>,
): Promise<ToolCallEventResult | undefined> {
	const sandbox = await beadWriteFreeEnv(pi, ctx);
	if (sandbox === undefined) return undefined;
	if (escapesSandbox(input.command)) {
		return {
			block: true,
			reason:
				`${SANDBOX_VARIABLE}=1 is the read-only sandbox this helper runs under during the orchestrate run: ` +
				`a session without a bead contract reads beads and writes none. The command sets or unsets ` +
				`${SANDBOX_VARIABLE}; leave the variable alone, and hand any bead write to the contract-bound role that owns it.`,
		};
	}
	return reviseBashEnv(input, sandbox);
}

