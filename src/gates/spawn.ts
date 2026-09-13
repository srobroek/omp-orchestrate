/**
 * Spawn gate — an architect or an implementer runs in an isolated copy.
 *
 * A worker spawned `isolated: true` commits in a clone of its spawner's checkout and never
 * writes the spawner's tree; one spawned without it inherits the parent's cwd and edits
 * whatever tree the parent is standing in. The `orc-spawn-isolated` TTSR rule used to
 * remind about this from a regex over the streamed `task` JSON, which had to wait for the
 * object to close and went quiet on an `outputSchema` nested more than four levels deep.
 * This gate reads the parsed arguments instead: both spawn forms, any key order, any
 * nesting.
 *
 * Two roles are held to it. The architect is spawned by the lead and works in a clone of
 * the primary checkout at `main`: it creates the feature branch there, pushes it to origin
 * at once and after every integration, and spawns implementers, each a clone of its clone.
 * Measured before this was required (`scratch/audit/e2e/probes.md`): a non-isolated
 * architect had to be launched as a second `omp --cwd` process to reach a checkout of its
 * own, which broke on the shim and exposed live credentials in the transcript. The
 * implementer's `omp/task/<id>` capture lands in the architect's clone, and its own clone
 * is deleted at yield. Reviewer, researcher and shepherd isolation is a dispatch decision
 * (`roles.md`).
 */

import type { ToolCallEventResult } from "@oh-my-pi/pi-coding-agent";

/** The agents that must run isolated, by the name a `task` call spawns them under. */
const ISOLATED_ROLES: Record<string, "architect" | "implementer"> = {
	"orc-architect": "architect",
	"orc-implementer": "implementer",
};

/** Where each role's commits land when it runs isolated, quoted in the refusal. */
const LANDING: Record<"architect" | "implementer", string> = {
	architect: "the feature branch it pushes to origin, in a clone of this checkout",
	implementer: "omp/task/<id>, in a clone of the architect's clone",
};

/** The spawn form `planning.md` documents, quoted so the refusal is also the fix. */
function spawnShape(agent: string): string {
	return `{ name: "<CamelCase>", agent: "${agent}", task: "<epic id + queue, not the work>", isolated: true }`;
}

/** Refuse a `task` call that spawns an architect or an implementer without `isolated: true`. */
export function gateRoleIsolation(input: Record<string, unknown>): ToolCallEventResult | undefined {
	const entries = Array.isArray(input.tasks) ? input.tasks : [input];
	for (const entry of entries) {
		if (entry === null || typeof entry !== "object") continue;
		const { agent, isolated, name } = entry as Record<string, unknown>;
		if (typeof agent !== "string" || isolated === true) continue;
		// Own keys only: `agent` is model-written text, and `"constructor"` must not resolve.
		const role = Object.hasOwn(ISOLATED_ROLES, agent) ? ISOLATED_ROLES[agent] : undefined;
		if (role === undefined) continue;
		const which = typeof name === "string" && name.length > 0 ? `'${name}'` : `an ${agent}`;
		return {
			block: true,
			reason: `${which} is spawned without isolated: true; an ${role} must run in an isolated copy so its commits land on ${LANDING[role]} and never in this tree. Spawn it as ${spawnShape(agent)}`,
		};
	}
	return undefined;
}
