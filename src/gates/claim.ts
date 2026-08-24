/**
 * G5 — claim eligibility, and the observation point for the session's actor.
 *
 * Beads enforces claim *exclusivity* — verified: two actors claiming the same queue
 * receive different beads and a third receives `[]` — but not *eligibility*. Any
 * actor may claim any bead, so nothing stops a reviewer claiming an implementation
 * task, or the lead claiming anything at all.
 *
 * This gate supplies eligibility, and replaces v19's deleted lead-never-claims rule
 * with something stronger. `orchestrator-claim-deny.py` compared `BEADS_ACTOR` and
 * `BD_ACTOR` against a regex for "looks like a worker, not a lead", which a
 * cooperative name defeated. Here the lead simply declares no `ORC-ROLE`, so it
 * fails every eligibility check and can claim nothing.
 *
 * It doubles as the observation point for the worktree gate: every `bd ... --claim`
 * that passes is recorded, giving G2 the actor and bead it cannot otherwise resolve.
 */

import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ToolCallEventResult } from "@oh-my-pi/pi-coding-agent";
import type { BdBead } from "../bd";
import { bdList, bdShow } from "../bd";
import { recordClaim } from "../claim-state";
import { orcRole, roleFromLabels } from "../identity";
import { scopeOf, scopesOverlap } from "../scope";
import { bdInvocations } from "../shell";

/**
 * The `agent:<role>` filter values on a `bd ready --claim`, which pin the queue the
 * caller is pulling from. A `ready --claim` naming the caller's own role needs no
 * bead lookup: beads hands back only a matching bead.
 */
function readyLabelRoles(rest: readonly string[]): string[] {
	const roles: string[] = [];
	for (let index = 0; index < rest.length; index++) {
		const token = rest[index];
		if (token !== "--label" && token !== "-l" && token !== "--label-any") continue;
		const value = rest[index + 1];
		if (typeof value === "string" && value.startsWith("agent:")) {
			roles.push(value.slice("agent:".length));
		}
	}
	return roles;
}

/** A bead's metadata as a record, tolerating the JSON-string form some subcommands emit. */
function metadataRecord(bead: BdBead | null): Record<string, unknown> | undefined {
	const raw = bead?.metadata;
	if (raw && typeof raw === "object") return raw as Record<string, unknown>;
	if (typeof raw === "string") {
		try {
			const parsed: unknown = JSON.parse(raw);
			if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
		} catch {
			return undefined;
		}
	}
	return undefined;
}

/**
 * Refuse a claim whose `metadata.scope` globs can name a path an in-flight bead's
 * globs also name — the ported `scope-check.py` disjointness rule, biased toward
 * false positives on purpose: serializing safe work is cheaper than two agents in
 * one file. Friction, not enforcement: it reads only what `bd list` reports, and
 * it fails open when scopes or the list are unavailable.
 */
async function scopeConflict(bead: BdBead | null): Promise<ToolCallEventResult | undefined> {
	if (!bead) return undefined;
	const candidate = scopeOf(metadataRecord(bead));
	if (candidate.length === 0) return undefined;
	const inFlight = await bdList(["list", "--label", "orc-node", "--status", "in_progress", "--json"]);
	for (const other of inFlight) {
		if (other.id === bead.id) continue;
		const otherScope = scopeOf(metadataRecord(other));
		if (otherScope.length === 0) continue;
		if (scopesOverlap(candidate, otherScope)) {
			return {
				block: true,
				reason:
					`scope conflict (friction guard): '${bead.id}' [${candidate.join(", ")}] overlaps in-flight ` +
					`'${other.id}' [${otherScope.join(", ")}]. Two agents must not share a file; wait for ` +
					`'${other.id}' to report, or re-scope one of the beads.`,
			};
		}
	}
	return undefined;
}

/**
 * Refuse a claim of a bead routed to another role, and record the ones that pass.
 *
 * Fails open wherever the answer is unknown — an unresolvable role, a bead that
 * cannot be read, or a bead carrying no routing label. A claim this gate cannot
 * evaluate is still recorded, so the worktree gate keeps working.
 */
export async function gateClaimEligibility(
	ctx: ExtensionContext,
	input: Record<string, unknown>,
): Promise<ToolCallEventResult | undefined> {
	const command = input.command;
	if (typeof command !== "string" || command.length === 0) return undefined;

	const claims = bdInvocations(command).filter(invocation => invocation.hasClaim);
	if (claims.length === 0) return undefined;

	const sessionRoleName = orcRole(ctx);

	for (const claim of claims) {
		const actor = claim.assignments.get("BEADS_ACTOR") ?? claim.assignments.get("BD_ACTOR") ?? "";

		// `bd ready --claim` selects by filter rather than naming a bead. When the
		// filter already pins a role, compare against that and skip the lookup.
		if (claim.subcommand === "ready") {
			const queueRoles = readyLabelRoles(claim.rest);
			for (const queueRole of queueRoles) {
				if (sessionRoleName !== undefined && queueRole !== sessionRoleName) {
					return {
						block: true,
						reason: `queue 'agent:${queueRole}' does not match this session's role '${sessionRoleName}'; pull from your own queue`,
					};
				}
			}
			if (actor.length > 0) recordClaim({ actor, beadIds: [] });
			continue;
		}

		for (const beadId of claim.positionals) {
			const bead = await bdShow(beadId);
			const beadRole = roleFromLabels(bead?.labels);

			// Unknown either side: allow. A bead with no `agent:` label routes to no
			// role — `agent:integrator` merge beads included — and a session with no
			// declared role is a helper the bead-write gate already sandboxes.
			if (beadRole !== undefined && sessionRoleName !== undefined && beadRole !== sessionRoleName) {
				return {
					block: true,
					reason: `bead '${beadId}' is routed to agent:${beadRole}; this session is ${sessionRoleName} and may not claim it`,
				};
			}

			const conflict = await scopeConflict(bead);
			if (conflict) return conflict;
		}

		if (actor.length > 0) recordClaim({ actor, beadIds: claim.positionals });
	}

	return undefined;
}
