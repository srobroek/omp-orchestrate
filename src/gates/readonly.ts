/**
 * G1 — bead-write-free sessions.
 *
 * A spawned session that declares no `ORC-ROLE` carries no bead contract: an
 * architect-spawned helper, or a bundled `scout`/`sonic`/`task` spawn. v19's agent
 * bodies asserted *"Children never touch beads or PRs"* but nothing enforced it.
 * This does, by imposing `BD_READONLY=1` on every shell call the session makes.
 *
 * Verified against a scratch database: under `BD_READONLY=1`, `bd show`, `bd ready`,
 * and `bd list` all exit 0, while `bd update`, `bd comment`, `bd label add`,
 * `bd close`, and `bd ready --claim` each exit 1 with
 * `Error: operation '<op>' is not allowed in read-only mode` and leave the bead
 * untouched. The variable name is exact — `BEADS_READONLY` and `BD_READ_ONLY` do
 * nothing, and there is no config key.
 *
 * This gate deliberately does **not** apply to any `orc-*` role. Each writes beads
 * to satisfy its own exit contract: `reviewer.rules.json` requires
 * `linked.comment.verb in [REVIEW, BLOCKED]`, `researcher.rules.json` requires a
 * `REPORTED` comment plus `metadata.output_ref`, and `shepherd.rules.json` requires
 * `comment.verb in [LANDED, BOUNCED, IDLE, BLOCKED]`. Since `bd comment` is blocked
 * under `BD_READONLY`, sandboxing them would make their contracts unsatisfiable and
 * every worker would bounce. "Read-only" in the v19 charters means read-only on the
 * working tree, which the agent's `tools` list enforces by omitting `edit`/`write`.
 */

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ToolCallEventResult } from "@oh-my-pi/pi-coding-agent";
import { isBeadWriteFree } from "../identity";

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

/** Impose `BD_READONLY=1` when this session holds no bead contract. */
export function gateBeadWriteFree(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	input: Record<string, unknown>,
): ToolCallEventResult | undefined {
	// Unresolvable identity means no rewrite: sandboxing a writer by mistake would
	// break every run, while missing a helper's stray write only loses a guard.
	if (!isBeadWriteFree(pi, ctx)) return undefined;

	const existingEnv = input.env;
	const env: Record<string, unknown> =
		existingEnv !== null && typeof existingEnv === "object" ? { ...existingEnv } : {};

	// Already imposed: nothing to revise, and returning an identical input would
	// pointlessly re-enter the revalidation path.
	if (env.BD_READONLY === "1") return undefined;
	env.BD_READONLY = "1";

	const revised: Record<string, unknown> = {};
	for (const key of BASH_PARAMS) {
		if (key in input) revised[key] = input[key];
	}
	revised.env = env;

	return { input: revised };
}
