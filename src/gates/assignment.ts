/**
 * G8 — the assignment notice: is this worker running as the agent and model it was
 * dispatched as?
 *
 * A notice, never a block. The check compares the session's `ORC-ROLE` marker with the
 * core contract its `session_init.agent` names, and the live model with the one the
 * contract's alias resolves to. A mismatch is reported once per session to the worker,
 * naming both models and the command that parks the claim; every tool stays available.
 * The earlier refusal bricked a worker whose model OMP's retry fallback had moved for a
 * condition that was already recovered (`session/turn-recovery.ts`), so a fallback OMP
 * applies is accepted for the rest of the session: `retry_fallback_applied` fires after
 * the swap, which makes the live model at that moment the sanctioned one.
 *
 * Unreadable evidence — a registry that throws, an alias that resolves to nothing — is
 * logged once and otherwise ignored: nothing was proven.
 */

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { coreContractForAgent, coreContractForRole, ROLE_MARKER } from "../agent-preflight";
import type { ClaimObservation } from "../claim-state";
import { sessionRole } from "../identity";

/** Custom-message type of the notice, namespaced as the plugin's others are. */
export const ASSIGNMENT_NOTICE_MESSAGE = "com.srobroek.omp-orchestrate.assignment-notice";

/** `provider/id`, the identity two models are compared by, or `undefined` for a non-model. */
function modelIdentity(model: unknown): string | undefined {
	if (model === null || typeof model !== "object") return undefined;
	const record = model as Record<string, unknown>;
	return typeof record.provider === "string" && typeof record.id === "string"
		? `${record.provider}/${record.id}`
		: undefined;
}

/** The live model's identity, or `undefined` when the registry cannot answer. */
function liveIdentity(ctx: ExtensionContext): string | undefined {
	try {
		return modelIdentity(ctx.models?.current?.());
	} catch {
		return undefined;
	}
}

/** The commands that park a claim for re-dispatch, with the bead named when it is known. */
function parkingCommand(claim: ClaimObservation | undefined, reason: string): string {
	const id = claim?.beadIds[0] ?? "<claimed-id>";
	return `\`bd comment ${id} 'BLOCKED ${reason}'\` then \`bd update ${id} --status blocked\``;
}

/**
 * The per-session check. Call it on every tool call in a worker session: the model is
 * read live each time, so a switch after the first call is still seen.
 */
export type AssignmentNotice = (ctx: ExtensionContext, claim: ClaimObservation | undefined) => void;

/**
 * Create the notice with its once-per-session memory. The fallback subscriptions are
 * `pi.on` registrations, so calling this at load has no observable effect.
 */
export function createAssignmentNotice(pi: ExtensionAPI): AssignmentNotice {
	/** Model identities OMP's retry fallback moved the session onto. */
	const accepted = new Set<string>();
	let noticed = false;
	let warnedUnavailable = false;

	const acceptLive = (_event: unknown, ctx: ExtensionContext): void => {
		const identity = liveIdentity(ctx);
		if (identity !== undefined) accepted.add(identity);
	};
	pi.on("retry_fallback_applied", acceptLive);
	pi.on("retry_fallback_succeeded", acceptLive);
	pi.on("session_start", () => {
		accepted.clear();
		noticed = false;
		warnedUnavailable = false;
	});

	const notice = (content: string): void => {
		if (noticed) return;
		noticed = true;
		pi.sendMessage({ customType: ASSIGNMENT_NOTICE_MESSAGE, content, display: true });
	};

	return (ctx, claim) => {
		if (noticed || sessionRole(pi) !== "worker") return;
		if (
			ctx.sessionManager === undefined ||
			typeof ctx.sessionManager.getEntries !== "function" ||
			ctx.models === undefined ||
			typeof ctx.models.resolve !== "function" ||
			typeof ctx.models.current !== "function" ||
			typeof ctx.getSystemPrompt !== "function"
		) return;

		const entries = ctx.sessionManager.getEntries();
		let namedAgent: string | undefined;
		for (let index = entries.length - 1; index >= 0; index -= 1) {
			const entry = entries[index];
			if (entry !== null && typeof entry === "object" && "type" in entry && entry.type === "session_init") {
				if ("agent" in entry && typeof entry.agent === "string" && entry.agent.length > 0) namedAgent = entry.agent;
				break;
			}
		}
		const namedContract = namedAgent === undefined ? undefined : coreContractForAgent(namedAgent);
		if (namedAgent !== undefined && namedContract === undefined) return;

		const marker = ROLE_MARKER.exec(ctx.getSystemPrompt().join("\n"))?.[1];
		const contract = namedContract ?? coreContractForRole(marker ?? "");
		if (contract === undefined) return;
		const sourceAgent = namedAgent ?? `marker-only (${contract.role})`;

		if (namedContract !== undefined && marker !== namedContract.role) {
			const mismatch = `expected ORC-ROLE ${namedContract.role}, actual ${marker ?? "missing"}`;
			notice(
				`ORC assignment notice for ${sourceAgent}: ${mismatch}. Tools stay available. If the architect did not sanction this assignment, park the claim before yielding: ${parkingCommand(claim, `assignment mismatch: ${mismatch}`)}.`,
			);
			return;
		}

		let expected: string | undefined;
		let actual: string | undefined;
		try {
			expected = modelIdentity(ctx.models.resolve(contract.modelAlias));
			actual = modelIdentity(ctx.models.current());
		} catch (error) {
			if (warnedUnavailable) return;
			warnedUnavailable = true;
			pi.logger.warn("orchestrate assignment check skipped: model evidence unavailable", {
				agent: sourceAgent,
				error: error instanceof Error ? error.message : String(error),
			});
			return;
		}
		if (expected === undefined || actual === undefined) {
			if (warnedUnavailable) return;
			warnedUnavailable = true;
			pi.logger.warn("orchestrate assignment check skipped: model evidence unavailable", {
				agent: sourceAgent,
				expected: expected ?? contract.modelAlias,
				actual: actual ?? "unavailable",
			});
			return;
		}
		if (expected === actual || accepted.has(actual)) return;

		const mismatch = `expected model ${expected} (from ${contract.modelAlias}), live model ${actual}`;
		notice(
			`ORC assignment notice for ${sourceAgent}: ${mismatch}. Tools stay available. If the architect did not sanction this model, park the claim before yielding: ${parkingCommand(claim, `model mismatch: expected ${expected}, live ${actual}`)}.`,
		);
	};
}
