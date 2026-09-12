/**
 * Spawn gate — an implementer runs in an isolated copy.
 *
 * A worker spawned `isolated: true` commits on `omp/task/<id>` and never writes the
 * architect's tree; one spawned without it inherits the parent's cwd and edits the
 * feature worktree the architect is standing in. The `orc-spawn-isolated` TTSR rule used
 * to remind about this from a regex over the streamed `task` JSON, which had to wait for
 * the object to close and went quiet on an `outputSchema` nested more than four levels
 * deep. This gate reads the parsed arguments instead: both spawn forms, any key order,
 * any nesting.
 *
 * Only `orc-implementer` is held to it. The architect stays on its Worktrunk feature tree,
 * and reviewer, researcher and shepherd isolation is a dispatch decision (`roles.md`).
 */

import type { ToolCallEventResult } from "@oh-my-pi/pi-coding-agent";

const ISOLATED_AGENT = "orc-implementer";

/** The worker entry `planning.md` documents, quoted so the refusal is also the fix. */
const SPAWN_SHAPE = `{ name: "<CamelCase>", agent: "${ISOLATED_AGENT}", task: "<epic id + queue, not the work>", isolated: true }`;

/** Refuse a `task` call that spawns an implementer without `isolated: true`. */
export function gateImplementerIsolation(input: Record<string, unknown>): ToolCallEventResult | undefined {
	const entries = Array.isArray(input.tasks) ? input.tasks : [input];
	for (const entry of entries) {
		if (entry === null || typeof entry !== "object") continue;
		const { agent, isolated, name } = entry as Record<string, unknown>;
		if (agent !== ISOLATED_AGENT || isolated === true) continue;
		const which = typeof name === "string" && name.length > 0 ? `'${name}'` : `an ${ISOLATED_AGENT}`;
		return {
			block: true,
			reason: `${which} is spawned without isolated: true; an implementer must run in an isolated copy so its commits land on omp/task/<id> and never in this tree. Spawn it as ${SPAWN_SHAPE}`,
		};
	}
	return undefined;
}
