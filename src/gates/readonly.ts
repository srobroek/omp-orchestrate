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

/** `BD_READONLY=1` when this session holds no bead contract, nothing otherwise. */
export function beadWriteFreeEnv(pi: ExtensionAPI, ctx: ExtensionContext): Record<string, string> | undefined {
	// Unresolvable identity means no rewrite: sandboxing a writer by mistake would
	// break every run, while missing a helper's stray write only loses a guard.
	return isBeadWriteFree(pi, ctx) ? { BD_READONLY: "1" } : undefined;
}

/**
 * One revision carrying every gate's environment addition, or nothing when the call
 * already has them all.
 *
 * A `tool_call` handler returns a single result, so gates that impose an environment
 * cannot each return their own revision. G1 is the only contributor left -- a database
 * pin gate supplied `BEADS_DIR` here until the pin was retired, since this project runs
 * a per-project Dolt server -- and this stays the seam that merges them, so the next one
 * contributes additions instead of a second revision that would be dropped.
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
