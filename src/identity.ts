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

/**
 * The role named by a bead's labels, or `undefined` when it routes to none.
 *
 * Used by the claim-eligibility gate to compare a bead's routing against the
 * claiming session's declared role. Callers build the label with
 * `` `agent:${role}` `` directly.
 */
export function roleFromLabels(labels: readonly string[] | undefined): OrcRole | undefined {
	for (const label of labels ?? []) {
		if (!label.startsWith("agent:")) continue;
		const candidate = label.slice("agent:".length);
		// A bead label is agent-written text -- `bd label add <bead> agent:<name>` -- and
		// nothing constrains its spelling the way `ROLE_MARKER` constrains a prompt marker.
		// This is therefore the reachable half of the hazard `orcRole` describes, and for
		// the whole inherited surface rather than the lowercase names alone.
		if (ORC_ROLES[candidate] === true) return candidate as OrcRole;
	}
	return undefined;
}
