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

import { realpath } from "node:fs/promises";
import path from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ToolCallEventResult } from "@oh-my-pi/pi-coding-agent";
import { logger } from "@oh-my-pi/pi-utils";
import {
 type BdBead,
 bdCommentsChecked,
 bdLinkedChecked,
 bdShow,
 bdShowMany,
 commentVerb,
 lastBdFailure,
 metadataString,
 readBudgetExhausted,
 resetReadBudget,
} from "../bd";
import { type ClaimObservation, type ClaimState } from "../claim-state";
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
 if (bead.wisp_type === "escalation") return "escalation";
 if (bead.wisp_type === "review") return "review";
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
 openEscalation?: boolean;
 artifactContained?: boolean;
}

const SUPPORTED_KINDS: Record<string, readonly string[]> = {
 architect: ["git", "artifact", "comment", "external"],
 implementer: ["git", "artifact", "comment", "external"],
 researcher: ["artifact", "comment", "external", "escalation"],
 reviewer: ["review", "git", "artifact", "comment", "external"],
 shepherd: ["git"],
 generic: ["git", "artifact", "comment", "external"],
};

export function completionKindSupported(role: string, bead: BdBead): boolean {
 const kind = resourceKind(bead);
 if (!Object.hasOwn(SUPPORTED_KINDS, role)) return false;
 if (kind === undefined) return role === "reviewer" || role === "shepherd" || role === "generic";
 return SUPPORTED_KINDS[role]!.includes(kind);
}

export function linkedEvidenceDirection(bead: BdBead): "up" | "down" {
 return bead.ephemeral === true || bead.wisp_type !== undefined || resourceKind(bead) === "escalation" ? "down" : "up";
}

export function isOpenEscalation(bead: BdBead): boolean {
 return bead.wisp_type === "escalation"
  && ["open", "in_progress", "blocked", "deferred"].includes((bead.status ?? "").toLowerCase());
}

export function contractPaused(contract: { pause?: string[] }, evidence: Evidence): boolean {
 return contract.pause?.includes("open-escalation-wisp-linked-to-node") === true
  && evidence.openEscalation === true;
}

/** Evaluate one supported `require` predicate; unknown predicates fail closed. */
export function satisfies(predicate: string, evidence: Evidence): boolean {
 const { bead, verbs, linkedVerbs } = evidence;
 const trimmed = predicate.trim();

 const metadataKey = /^metadata\.([A-Za-z0-9_]+)$/.exec(trimmed);
 if (metadataKey?.[1] !== undefined) return metadataString(bead, metadataKey[1]) !== undefined;

 if (trimmed === "assignee cleared") {
  return bead.assignee === undefined || bead.assignee === null || bead.assignee === "";
 }

 if (trimmed === "artifact.output_ref contained") {
  return evidence.artifactContained === true;
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

 return false;
}

/**
 * What a contract reads off the beads linked to the node, so the evaluator can skip the
 * reads it will never consult.
 *
 * `verbs`: some `require` names `linked.comment.verb`, so every linked bead's comments
 * are read (researcher, reviewer). `escalation`: the contract pauses on an open
 * escalation wisp, so every linked bead's status is read (architect, implementer). A
 * contract wanting neither (shepherd, generic) reads no link at all.
 */
export interface LinkedEvidenceNeeds {
 verbs: boolean;
 escalation: boolean;
}

const ALL_LINKED_EVIDENCE: LinkedEvidenceNeeds = { verbs: true, escalation: true };

export function linkedEvidenceNeeds(contract: Contract): LinkedEvidenceNeeds {
 const requires = (contract.completion ?? []).map(check => check.require);
 if (contract.escape?.require !== undefined) requires.push(contract.escape.require);
 return {
  verbs: requires.some(predicate => predicate.trim().startsWith("linked.")),
  escalation: contract.pause?.includes("open-escalation-wisp-linked-to-node") === true,
 };
}

/**
 * Null is incomplete evidence, never proof of a failed completion contract.
 *
 * Read cost, with L linked beads: one `comments`, then -- only when `needs` asks for
 * anything linked -- two `dep list` and one `bd list --id` hydrating every link at
 * once, then one `comments` per link only when `needs.verbs`. Absent `needs`, everything
 * is read, which is what a caller judging an unknown contract must do.
 */
export async function collectExitEvidence(bead: BdBead, needs: LinkedEvidenceNeeds = ALL_LINKED_EVIDENCE): Promise<Evidence | null> {
 const comments = await bdCommentsChecked(bead.id);
 if (comments === null) return null;
 const verbs = comments.map(comment => commentVerb(comment.text));
 const linkedVerbs: string[] = [];
 let openEscalation = false;
 const direction = linkedEvidenceDirection(bead);
 // An escalation pauses the node it hangs off, so only outgoing links can carry one.
 const wantEscalation = needs.escalation && direction === "up";
 if (needs.verbs || wantEscalation) {
  const linkedIds: string[] = [];
  for (const type of ["relates-to", "replies-to"]) {
   const linked = await bdLinkedChecked(bead.id, type, undefined, direction);
   if (linked === null) return null;
   for (const linkedId of linked) {
    if (!linkedIds.includes(linkedId)) linkedIds.push(linkedId);
   }
  }
  const linkedBeads = linkedIds.length === 0 ? new Map<string, BdBead>() : await bdShowMany(linkedIds);
  if (linkedBeads === null) return null;
  for (const linkedId of linkedIds) {
   const linkedBead = linkedBeads.get(linkedId);
   if (linkedBead === undefined) return null;
   if (wantEscalation) openEscalation ||= isOpenEscalation(linkedBead);
   if (!needs.verbs) continue;
   const linkedComments = await bdCommentsChecked(linkedId);
   if (linkedComments === null) return null;
   const version = ["head_sha", "review_round"].map(key => {
    const value = bead.metadata?.[key] ?? linkedBead.metadata?.[key];
    return { key, value: typeof value === "number" || typeof value === "string" ? String(value) : undefined };
   });
   for (const comment of linkedComments) {
    const tokens = comment.text.split(/\s+/);
    if (version.every(({ key, value }) => value === undefined || tokens.includes(`${key}=${value}`))) {
     linkedVerbs.push(commentVerb(comment.text));
    }
   }
  }
 }
 let artifactContained = false;
 if (resourceKind(bead) === "artifact") {
  const output = metadataString(bead, "output_ref");
  const artifacts = metadataString(bead, "artifacts_dir");
  const worktree = metadataString(bead, "worktree");
  if (output !== undefined && artifacts !== undefined && path.isAbsolute(output) && path.isAbsolute(artifacts)) {
   try {
    const resolvedOutput = await realpath(output);
    const resolvedArtifacts = await realpath(artifacts);
    const relative = path.relative(resolvedArtifacts, resolvedOutput);
    artifactContained = relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    if (worktree !== undefined) {
     const resolvedWorktree = await realpath(worktree);
     const fromWorktree = path.relative(resolvedWorktree, resolvedOutput);
     if (fromWorktree === "" || (fromWorktree !== ".." && !fromWorktree.startsWith(`..${path.sep}`) && !path.isAbsolute(fromWorktree))) {
      artifactContained = false;
     }
    }
   } catch {
    artifactContained = false;
   }
  }
 }
 return { bead, verbs, linkedVerbs, openEscalation, artifactContained };
}

interface ExitGuardState {
 unclaimedReminded: boolean;
 refusalClaim: ClaimObservation | undefined;
 refusalCount: number;
}

/**
 * Reads one `yield` may spend.
 *
 * Twice the per-tool-call cap: the exit contract runs once per session rather than on
 * every tool call, and its reads are the verdict, not a side check. The 20 s dispatch
 * deadline still bounds it, because OMP kills a `tool_call` handler at 30 s.
 */
const EXIT_READ_BUDGET = 24;

/** Create an exit guard with reminder and refusal budgets private to one factory invocation. */
export function createExitGuard(claims: ClaimState): (ctx: ExtensionContext, input?: Record<string, unknown>) => Promise<ToolCallEventResult | undefined> {
 const state: ExitGuardState = { unclaimedReminded: false, refusalClaim: undefined, refusalCount: 0 };
 return async (ctx, input) => {
  resetReadBudget(EXIT_READ_BUDGET);
  const claim = claims.observedClaim();
  if (claim === undefined || claim.beadIds.length === 0) return await gateUnclaimedExit(state, ctx, input);
  for (const beadId of claim.beadIds) {
   const result = await gateClaimedExit(state, ctx, claim, beadId);
   if (result !== undefined) return result;
  }
  return undefined;
 };
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
 state: ExitGuardState,
 ctx: ExtensionContext,
 input: Record<string, unknown> | undefined,
): Promise<ToolCallEventResult | undefined> {
 if (orcRole(ctx) === undefined) return undefined;
 if (state.unclaimedReminded) return undefined;

 const payload = input === undefined ? "" : JSON.stringify(input);
 if (payload.includes("NO_WORK")) return undefined;
 if (CONTENTION_EVIDENCE.test(payload)) return undefined;

 state.unclaimedReminded = true;
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
 * every check here hangs off a bead. Each fail-open is logged with the cause, because
 * an exit accepted unevaluated is otherwise indistinguishable from one that passed.
 */

async function gateClaimedExit(
 state: ExitGuardState,
 ctx: ExtensionContext,
 claim: ClaimObservation,
 beadId: string,
): Promise<ToolCallEventResult | undefined> {

 const bead = await bdShow(beadId);
 if (bead === null) {
  logger.warn("orchestrate exit contract unevaluated: claimed bead unreadable", { bead: beadId, cause: lastBdFailure() });
  return undefined;
 }
 if (bead.assignee && bead.assignee !== claim?.actor) return undefined;

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

 const evidence = await collectExitEvidence(bead, linkedEvidenceNeeds(contract));
 if (evidence === null) {
  logger.warn("orchestrate exit contract unevaluated: evidence unreadable", {
   bead: beadId,
   role,
   cause: lastBdFailure(),
   readBudgetExhausted: readBudgetExhausted(),
  });
  return undefined;
 }
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
 if (!completionKindSupported(role, bead)) {
  failures.push({ check: "execution-kind", detail: `unsupported or missing execution kind: ${kind ?? "unknown"}` });
 }
 const paused = contractPaused(contract, evidence);

 for (const check of contract.completion ?? []) {
  if (paused) continue;
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

 // Refusals belong to this activation, not to mutable shared bead metadata.
 if (state.refusalClaim !== claim) {
  state.refusalClaim = claim;
  state.refusalCount = 0;
 }
 const attempts = ++state.refusalCount;
 const maxAttempts = contract.bounce?.max_attempts ?? 3;
 if (attempts >= maxAttempts) return undefined;

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
