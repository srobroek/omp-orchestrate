/**
 * Session identity for the gates.
 *
 * Two questions need answering before any gate can act: is this session the lead
 * or a spawned worker, and if a worker, which contract-bound role is it running?
 *
 * Both are answered from documented public API only — `pi.getAllTools()` and
 * `ctx.getSystemPrompt()`. An earlier design read the process-global
 * `AgentRegistry` through a deep import and took the role from
 * `AgentRef.history.agent`; that was dropped for two reasons. The import relied on
 * the package's `"./*"` exports-map wildcard reaching an otherwise unexported
 * module, and `AgentHistorySummary` is documented as *"Historical identity and
 * telemetry that remain available after the live session is disposed"* — so
 * `history.agent` is not dependably populated while the agent is still running,
 * which is exactly when a gate needs it.
 */

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

/** Whether this session was spawned by `task` or is the top-level lead. */
export type SessionRole = "lead" | "worker";

/** The contract-bound roles this plugin defines. */
export type OrcRole = "architect" | "implementer" | "reviewer" | "researcher" | "shepherd";

const ORC_ROLES: Record<string, true> = {
	architect: true,
	implementer: true,
	reviewer: true,
	researcher: true,
	shepherd: true,
};

/**
 * Declared by each `orc-*` agent body as a line of its own, e.g. `ORC-ROLE: implementer`.
 *
 * A marker in the body rather than a lookup of the agent's name: the body is the
 * one artifact this plugin authors and OMP renders verbatim into the child's
 * system prompt, so it survives without depending on registry internals. It also
 * means the role is the bare name — no `orc-` prefix to strip, and no chance of
 * comparing `orc-reviewer` against an `agent:reviewer` bead label.
 */
const ROLE_MARKER = /^ORC-ROLE:[ \t]*([a-z][a-z-]*)[ \t]*$/m;

/**
 * `"worker"` when the hidden `yield` tool is present, `"lead"` otherwise.
 *
 * `yield` is added to the registry only when `session.requireYieldTool === true`
 * (`tools/index.ts:663,676`), which `runSubprocess` and the persisted-revive path
 * set for spawned sessions and nothing else sets. Deliberately not `ctx.hasUI`,
 * which is also false for a top-level `--print` or RPC session, and deliberately
 * not an environment variable, since subagents run in-process and share one
 * environment with the lead.
 */
export function sessionRole(pi: ExtensionAPI): SessionRole {
	return pi.getAllTools().some(tool => tool.name === "yield") ? "worker" : "lead";
}

/**
 * The declared role of this session, or `undefined` when it declares none.
 *
 * Undefined covers the lead, an architect-spawned helper, and any bundled spawn
 * (`scout`, `sonic`, `task`) — none of which carry a bead contract.
 */
export function orcRole(ctx: ExtensionContext): OrcRole | undefined {
	const match = ROLE_MARKER.exec(ctx.getSystemPrompt().join("\n"));
	const declared = match?.[1];
	// `=== true`, not truthiness: the marker text is untrusted, and `ORC_ROLES` is an
	// object literal, so `ORC-ROLE: constructor` would otherwise resolve through
	// `Object.prototype` and declare a role this plugin does not define. That flips two
	// gates the permissive way at once -- `isBeadWriteFree` stops sandboxing the session,
	// and `CONTRACTS[role]` in the exit gate resolves to a prototype member whose
	// `completion` list is undefined, so every exit check is skipped.
	//
	// Only PART of the prototype is reachable from THIS carrier: `ROLE_MARKER` captures
	// `[a-z][a-z-]*`, so `constructor` parses as a marker while `toString`, `valueOf` and
	// `__proto__` never do. The own-property test is still the right shape rather than an
	// over-fix -- that narrowing is a property of the regex, not of this check, and the
	// label carrier below has no equivalent filter.
	return declared !== undefined && ORC_ROLES[declared] === true ? (declared as OrcRole) : undefined;
}

/**
 * True for a spawned session that carries no bead contract, and must therefore
 * never mutate a bead: architect helpers and bundled spawns.
 *
 * The lead is excluded because it creates the run epic and the whole task DAG.
 * Every `orc-*` role is excluded because each one writes beads to satisfy its own
 * exit contract — `reviewer.rules.json` requires `linked.comment.verb in [REVIEW,
 * BLOCKED]`, `researcher.rules.json` requires a `REPORTED` comment plus
 * `metadata.output_ref`, and `shepherd.rules.json` requires
 * `comment.verb in [LANDED, BOUNCED, IDLE, BLOCKED]`. Since `BD_READONLY=1` blocks
 * `bd comment`, sandboxing any of them would make their contracts unsatisfiable and
 * every worker would bounce.
 */
export function isBeadWriteFree(pi: ExtensionAPI, ctx: ExtensionContext): boolean {
	return sessionRole(pi) === "worker" && orcRole(ctx) === undefined;
}

/** Which carrier a bead's routing role was read from. */
export type RoleCarrier = "metadata" | "legacy-label";

/** A bead's routing role, the carrier it came from, and that carrier as written. */
export interface BeadRouting {
	role: OrcRole;
	from: RoleCarrier;
	/**
	 * The carrier verbatim -- `role=implementer`, or the label `agent:integrator`.
	 *
	 * Quoted back in a refusal so the message names what is actually on the bead. A
	 * spelling derived from the resolved role would lie for every legacy suffix that is
	 * not its own role's name.
	 */
	spelling: string;
}

/** A bead's routing fields. Structural on purpose, so this module imports no bd types. */
export interface RoutedBead {
	labels?: readonly string[];
	metadata?: Record<string, unknown> | string;
}

/** The metadata key that routes a bead. The only authoritative carrier. */
export const ROUTING_KEY = "role";

const LEGACY_ROLE_LABEL = "agent:";

/**
 * Legacy `agent:<suffix>` suffixes that name a role, mapped to the role they name.
 *
 * Read only when a bead carries no `metadata.role`, so a run already in flight keeps
 * routing across the move. A bead filed after the move never reaches this table.
 *
 * `integrator` is here because it named no role at all, and that was a live defect
 * rather than a spelling worth preserving: the old resolver returned `undefined` for it,
 * so the claim gate let any role take a merge bead named by id, while the queue-filter
 * comparison refused a shepherd pulling `--label agent:integrator` because the raw token
 * never equalled its declared `shepherd`. Unpullable one way and unguarded the other.
 * Mapping it closes both for the beads that still carry it, without making `integrator`
 * a value anything writes.
 */
const LEGACY_LABEL_ROLES: Record<string, OrcRole> = {
	architect: "architect",
	implementer: "implementer",
	reviewer: "reviewer",
	researcher: "researcher",
	shepherd: "shepherd",
	integrator: "shepherd",
};

/**
 * The role a legacy `agent:<suffix>` label names, or `undefined` for any other label.
 *
 * Shared by the bead resolver and the claim gate's queue-filter check, so one legacy
 * spelling cannot mean two different things in the two places that read it.
 */
export function legacyRoleFromLabel(label: string): OrcRole | undefined {
	if (!label.startsWith(LEGACY_ROLE_LABEL)) return undefined;
	const suffix = label.slice(LEGACY_ROLE_LABEL.length);
	// `Object.hasOwn`, not a bare index: a bead label is agent-written text --
	// `bd label add <bead> agent:<name>` -- and nothing constrains its spelling the way
	// `ROLE_MARKER` constrains a prompt marker. Under a bare index `agent:constructor`
	// resolves through `Object.prototype` and yields a truthy Function, which defeated
	// every `?? generic` fallback downstream and let a dead child label its way out of
	// reclamation.
	return Object.hasOwn(LEGACY_LABEL_ROLES, suffix) ? LEGACY_LABEL_ROLES[suffix] : undefined;
}

/**
 * `metadata.role` as written, or `undefined` when absent.
 *
 * Tolerates the JSON-string form some `bd` subcommands emit for the whole map, because
 * routing must resolve identically whichever shape the read handed back.
 */
function routingValue(metadata: Record<string, unknown> | string | undefined): string | undefined {
	let record: Record<string, unknown>;
	if (typeof metadata === "string") {
		try {
			const parsed: unknown = JSON.parse(metadata);
			if (parsed === null || typeof parsed !== "object") return undefined;
			record = parsed as Record<string, unknown>;
		} catch {
			return undefined;
		}
	} else if (metadata === undefined || metadata === null) {
		return undefined;
	} else {
		record = metadata;
	}
	// Own-property test for the same reason as the label carrier: this map arrives from
	// `JSON.parse`, so it inherits `Object.prototype`, and a bead carrying no routing
	// stamp must read as unrouted rather than as whatever the prototype holds.
	if (!Object.hasOwn(record, ROUTING_KEY)) return undefined;
	const value = record[ROUTING_KEY];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The role a bead routes to, or `undefined` when it routes to none.
 *
 * `metadata.role` is authoritative and wins outright; a legacy `agent:<role>` label is
 * read only when the stamp is absent. Metadata is the carrier because it is the only one
 * a role contract can refuse: `authority.deny_metadata` exists, there is no
 * `deny_labels`, and no presence test on a label could enforce one. Under the old scheme
 * any role could relabel any bead and re-point the queue it is pulled from.
 *
 * A bead legitimately carries `metadata.role=implementer` and the label `agent:reviewer`
 * at once after a handoff. That is not a conflict: the label is the ready-for-review
 * signal and it routes nothing.
 */
export function beadRouting(bead: RoutedBead | null | undefined): BeadRouting | undefined {
	const declared = routingValue(bead?.metadata);
	// `=== true` on an object literal, and the metadata carrier is deliberately strict to
	// the five real roles: `integrator` is a legacy label suffix, never a stamped value.
	if (declared !== undefined && ORC_ROLES[declared] === true) {
		return { role: declared as OrcRole, from: "metadata", spelling: `${ROUTING_KEY}=${declared}` };
	}

	for (const label of bead?.labels ?? []) {
		const role = legacyRoleFromLabel(label);
		if (role !== undefined) return { role, from: "legacy-label", spelling: label };
	}
	return undefined;
}
