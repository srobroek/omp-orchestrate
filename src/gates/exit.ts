/**
 * G4 — the bead-as-brief exit contract, enforced on `yield`.
 *
 * A port of `rules-eval.py`'s evaluator onto OMP's only child-completion seam. The
 * `yield` tool exists solely in spawned sessions (`tools/index.ts:663,676`), so this
 * handler is inert in the lead by construction, and blocking it returns the verdict
 * to the worker as a tool error it can correct — the same shape `SubagentStop`'s
 * `{"decision":"block","reason":...}` had.
 *
 * The seven role contracts move across as data; only the evaluator changes language.
 */

import path from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ToolCallEventResult } from "@oh-my-pi/pi-coding-agent";
import { type BdBead, bdComments, bdLinked, bdRun, bdShow, commentVerb, metadataString } from "../bd";
import { observedClaim } from "../claim-state";
import { beadRouting, orcRole } from "../identity";

import architect from "../contracts/architect.json";
import generic from "../contracts/generic.json";
import implementer from "../contracts/implementer.json";
import researcher from "../contracts/researcher.json";
import reviewer from "../contracts/reviewer.json";
import shepherd from "../contracts/shepherd.json";

interface CompletionCheck {
	check: string;
	require: string;
	when?: string | string[];
}

interface Contract {
	agent?: string;
	completion?: CompletionCheck[];
	authority?: { deny_states?: string[]; deny_metadata?: string[] };
	escape?: { state?: string; require?: string };
	pause?: string[];
	bounce?: { max_attempts?: number };
}

const CONTRACTS: Record<string, Contract> = {
	architect,
	implementer,
	researcher,
	reviewer,
	shepherd,
	generic,
};

/**
 * Metadata keys the orchestrator stamps, exempt from `deny_metadata`.
 *
 * A role must not be faulted for a key its dispatcher wrote. Mirrors
 * `ORCHESTRATOR_ANCHORS` in `rules-eval.py`.
 *
 * Matched by key name, not by meaning, so the `origin` split needs all three successors
 * listed here. Legacy `origin` stays: beads stamped before the split still carry it.
 *
 * The general rule this list encodes, stated once here because it decides what may go on
 * a `deny_metadata` list at all: the loop below is a PRESENCE test, and it reads presence
 * as authorship. The key is on the claimed bead, therefore the claimant wrote it. That
 * inference is sound only for outcome fields no dispatcher stamps -- `merge_sha`, `pr`,
 * `push`, `output_ref`. For any key the dispatcher must stamp, presence is the normal
 * case and a denial would fault every worker on every bead, so the key belongs here
 * instead of on a denial list.
 *
 * `role` is the sharpest case and is deliberately on NEITHER list. It routes the bead, so
 * the dispatcher must stamp it, which rules out a presence test; and the exit is the
 * wrong moment anyway, because a bead a worker re-pointed has already been claimed and
 * worked by whoever the new route named. Routing authority is enforced by G5 at the write
 * seam, where the actor comes from the prompt marker rather than from a field on the bead
 * under judgement. Adding `role` to a `deny_metadata` list would not harden anything; it
 * would bounce every worker.
 */
const ORCHESTRATOR_ANCHORS: Record<string, true> = {
	actor: true,
	artifacts_dir: true,
	base_ref: true,
	base_sha: true,
	branch: true,
	complexity_tier: true,
	execution_agent: true,
	execution_dispatch: true,
	execution_kind: true,
	execution_task_kind: true,
	lease_token: true,
	origin: true,
	origin_actor: true,
	origin_bead: true,
	run_epic: true,
	runtime_context: true,
	runtime_handle: true,
	scope: true,
	worktree: true,
};

interface Failure {
	check: string;
	detail: string;
}

/**
 * The resource kind a `when` clause selects against.
 *
 * `metadata.execution_kind` is authoritative; absent it, a stamped worktree means
 * git-delivered work and a stamped artifacts dir means artifact-delivered, matching
 * the derivation v19's evaluator added.
 */
export function resourceKind(bead: BdBead): string | undefined {
	const declared = metadataString(bead, "execution_kind");
	if (declared !== undefined) return declared;
	if (metadataString(bead, "worktree") !== undefined) return "git";
	if (metadataString(bead, "artifacts_dir") !== undefined) return "artifact";
	return undefined;
}

export function applies(check: CompletionCheck, kind: string | undefined): boolean {
	if (check.when === undefined) return true;
	const wanted = Array.isArray(check.when) ? check.when : [check.when];
	return kind !== undefined && wanted.includes(kind);
}

/** State a predicate may need, fetched once per evaluation. */
export interface Evidence {
	bead: BdBead;
	verbs: string[];
	linkedVerbs: string[];
}

/**
 * Evaluate one `require` predicate.
 *
 * An unrecognised form returns `true`, exactly as `rules-eval.py` did: a contract
 * naming a predicate this evaluator does not implement must not fail every exit.
 */
export function satisfies(predicate: string, evidence: Evidence): boolean {
	const { bead, verbs, linkedVerbs } = evidence;
	const trimmed = predicate.trim();

	const metadataKey = /^metadata\.([A-Za-z0-9_]+)$/.exec(trimmed);
	if (metadataKey?.[1] !== undefined) return metadataString(bead, metadataKey[1]) !== undefined;

	if (trimmed === "assignee cleared") {
		return bead.assignee === undefined || bead.assignee === null || bead.assignee === "";
	}

	if (trimmed === "artifact.output_ref contained") {
		const output = metadataString(bead, "output_ref");
		const artifacts = metadataString(bead, "artifacts_dir");
		if (output === undefined || artifacts === undefined) return false;
		if (!path.isAbsolute(output) || !path.isAbsolute(artifacts)) return false;
		const inside = output.startsWith(`${artifacts}${path.sep}`);
		const worktree = metadataString(bead, "worktree");
		const underWorktree = worktree !== undefined && output.startsWith(`${worktree}${path.sep}`);
		return inside && output !== artifacts && !underWorktree;
	}

	const labelMatch = /^label\s*~\s*(.+)$/.exec(trimmed);
	if (labelMatch?.[1] !== undefined) {
		let pattern: RegExp;
		try {
			pattern = new RegExp(labelMatch[1].replace(/^["']|["']$/g, ""));
		} catch {
			// An uncompilable pattern counts as unmet, matching the Python's
			// fail-closed handling for a malformed label regex.
			return false;
		}
		return (bead.labels ?? []).some(label => pattern.test(label));
	}

	const verbMatch = /^(linked\.)?comment\.verb\s+in\s*\[([^\]]*)\]$/.exec(trimmed);
	if (verbMatch !== null) {
		const wanted = (verbMatch[2] ?? "")
			.split(",")
			.map(entry => entry.trim().toUpperCase())
			.filter(entry => entry.length > 0);
		const pool = verbMatch[1] === undefined ? verbs : linkedVerbs;
		return pool.some(verb => wanted.includes(verb));
	}

	return true;
}

/** Gather the comment verbs a contract may test, on the bead and on its linked wisps. */
async function collectEvidence(bead: BdBead): Promise<Evidence> {
	const verbs = (await bdComments(bead.id)).map(comment => commentVerb(comment.text));
	const linkedVerbs: string[] = [];
	for (const type of ["relates-to", "replies-to"]) {
		for (const linkedId of await bdLinked(bead.id, type)) {
			for (const comment of await bdComments(linkedId)) {
				linkedVerbs.push(commentVerb(comment.text));
			}
		}
	}
	return { bead, verbs, linkedVerbs };
}

/**
 * Whether this session has already been told it holds no claim. One reminder is the
 * whole budget: a revived worker whose claim was made in a previous process has no
 * observed claim through no fault of its own, and trapping it would cost the run
 * more than the silent exit costs.
 */
let unclaimedReminded = false;

/** Test seam, and the correct reset when a session is replaced. */
export function resetUnclaimedReminder(): void {
	unclaimedReminded = false;
}

/**
 * Evidence that a claimless exit lost a claim race rather than found an empty queue.
 *
 * A database-level failure signature, not a verb. The pull contract has the loser of a
 * simultaneous claim quote the Dolt error it received. It names these three tokens as
 * the match (`src/contract.ts`). A worker asserting `BLOCKED` states its own conclusion.
 * Only the quoted error shows it ran the pull at all, so a bare verb stays refused.
 */
const CONTENTION_EVIDENCE = /error\s*1213|40001|serialization failure/i;

/**
 * Refuse one exit from a role-marked worker that never claimed anything.
 *
 * Found by an adversarial run: a worker briefed that "there are no beads, invent
 * your own task list" wrote code, claimed nothing, and exited `completed`. Its work
 * reached no bead and no captured branch -- with nothing claimed there is no id to
 * name one -- so the run recorded a healthy child and lost the work. The contract
 * evaluator could not see it, because every check it owns hangs off a claimed bead.
 *
 * The protocol already defines every legal exit, so this only insists on one of them.
 * Claim work, report `NO_WORK` on an empty queue, or quote the claim error that beat
 * you. The third matters: `NO_WORK` for a lost race abandons ready work and files a
 * false empty queue.
 */
async function gateUnclaimedExit(
	ctx: ExtensionContext,
	input: Record<string, unknown> | undefined,
): Promise<ToolCallEventResult | undefined> {
	// No marker means a contract-free helper or the lead: neither pulls work.
	if (orcRole(ctx) === undefined) return undefined;
	if (unclaimedReminded) return undefined;

	const payload = input === undefined ? "" : JSON.stringify(input);
	// `NO_WORK` is the declared empty-queue exit, wherever the payload carries it.
	if (payload.includes("NO_WORK")) return undefined;
	// Contention is the other claimless exit the protocol defines, and the quoted error
	// is what separates it from an invented one.
	if (CONTENTION_EVIDENCE.test(payload)) return undefined;

	unclaimedReminded = true;
	return {
		block: true,
		reason:
			"You are exiting without ever claiming a bead. Work is pulled, not invented: run your role's `bd ready ... --claim` and deliver the bead you get. Two exits need no claim, and the pull result decides which. Empty result -- report NO_WORK. Claim error naming Error 1213, 40001, or serialization failure -- retry the identical pull, at most three times. Then quote that error here. Never report NO_WORK for a race you lost: the queue was not empty. Uncommitted work under no claim reaches no branch and no bead.",
	};
}

/**
 * Refuse a `yield` that leaves the claimed bead short of its role contract.
 *
 * Fails open on every unknown: an unreadable bead, or no contract for the role. A
 * session holding no claim is handled by {@link gateUnclaimedExit} instead, because
 * every check here hangs off a bead.
 */
export async function gateExitContract(
	ctx: ExtensionContext,
	input?: Record<string, unknown>,
): Promise<ToolCallEventResult | undefined> {
	const claim = observedClaim();
	const beadId = claim?.beadIds[0];
	if (beadId === undefined) return await gateUnclaimedExit(ctx, input);

	const bead = await bdShow(beadId);
	if (bead === null) return undefined;

	const routing = beadRouting(bead);
	const role = orcRole(ctx) ?? routing?.role ?? "generic";
	// `Object.hasOwn`, not a plain index: `CONTRACTS` is an object literal, so an inherited
	// key ("constructor", "toString") resolved to a truthy prototype member. The
	// `?? CONTRACTS.generic` fallback never fired, `contract.completion ?? []` read as an
	// empty check list, and the exit passed with its contract wholly unevaluated.
	//
	// Both producers of `role` now return a closed union, so no prototype name can reach
	// here: `orcRole` filters the prompt marker, and `beadRouting` resolves through two
	// own-property tables. The guard stays because the fallback is what makes a claim
	// always judged, and that must hold on this line alone.
	const contract = (Object.hasOwn(CONTRACTS, role) ? CONTRACTS[role] : undefined) ?? CONTRACTS.generic;
	if (contract === undefined) return undefined;

	const evidence = await collectEvidence(bead);
	const status = (bead.status ?? "").toLowerCase();

	// Escape first: a genuine failure declared as such is a valid exit, not a
	// contract breach.
	if (contract.escape?.state !== undefined && status === contract.escape.state) {
		if (contract.escape.require === undefined || satisfies(contract.escape.require, evidence)) {
			return undefined;
		}
	}

	const kind = resourceKind(bead);
	const failures: Failure[] = [];

	for (const check of contract.completion ?? []) {
		if (!applies(check, kind)) continue;
		if (!satisfies(check.require, evidence)) {
			failures.push({ check: check.check, detail: `unsatisfied: ${check.require}` });
		}
	}

	// Lower-cased exactly like `status` above. Every `deny_states` entry is a lowercase
	// state name, and case is not contractual for either carrier of the state -- but only
	// `status` was folded, so a `state:CLOSED` label walked past the same denial that
	// `status: "CLOSED"` was caught by.
	const stateLabels = (bead.labels ?? [])
		.filter(label => label.startsWith("state:"))
		.map(label => label.slice("state:".length).toLowerCase());
	for (const denied of contract.authority?.deny_states ?? []) {
		if (status === denied || stateLabels.includes(denied)) {
			failures.push({ check: "state-authority", detail: `status=${denied} set by a role forbidden to set it` });
		}
	}

	for (const denied of contract.authority?.deny_metadata ?? []) {
		// `=== true`, same reason: an anchor list is a boolean table, and a `deny_metadata`
		// key naming a prototype member would silently skip the denial it declares.
		if (ORCHESTRATOR_ANCHORS[denied] === true) continue;
		if (metadataString(bead, denied) !== undefined) {
			failures.push({
				check: "metadata-authority",
				detail: `metadata.${denied} is set and this role may not own it; unset it or escalate`,
			});
		}
	}

	if (failures.length === 0) return undefined;

	// Bounce budget: after enough attempts the bead is released for redispatch and
	// the exit is allowed, so a worker cannot be trapped against a contract it
	// cannot satisfy.
	const attempts = Number(metadataString(bead, "stop_attempts") ?? "0") + 1;
	const maxAttempts = contract.bounce?.max_attempts ?? 3;

	if (attempts >= maxAttempts) {
		await bdRun(["comment", beadId, `BOUNCE agent=${role} attempt=${attempts}`]);
		if (status === "closed") await bdRun(["reopen", beadId, "--reason", "contract bounce"]);
		await bdRun([
			"update",
			beadId,
			"--assignee",
			"",
			"--status",
			"open",
			"--metadata",
			JSON.stringify({ stop_attempts: 0, review_round: 0 }),
		]);
		return undefined;
	}

	await bdRun(["update", beadId, "--metadata", JSON.stringify({ stop_attempts: attempts })]);

	return {
		block: true,
		reason: JSON.stringify({
			bead: beadId,
			agent: role,
			attempt: attempts,
			// Which carrier routed the bead, and only when it was the legacy one. A worker
			// reads this verdict, so a bead still routed by label says so where the failure
			// is already being read, rather than in a log nobody opens.
			...(routing?.from === "legacy-label" ? { routing: routing.spelling } : {}),
			failed_checks: failures,
		}),
	};
}
