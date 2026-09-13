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
 *
 * One predicate reads outside bd. Every role's checkout is an isolated clone that OMP
 * deletes when the agent completes, so origin is the only copy of its work that survives
 * the yield this gate judges. `origin.pushed == head_sha` (implementer) and
 * `origin.branch == head_sha` (architect) ask origin with one `git ls-remote`
 * (`src/origin.ts`) whether the recorded head is there. Unlike every bd read, an
 * unanswered origin is a refusal, not an unevaluated exit: the clone is gone the moment
 * the yield is allowed, so "unknown" and "lost" are the same outcome. When the proof
 * holds, the plugin stamps `metadata.pushed_sha` with the observed commit before the
 * yield proceeds, so an offline reader can tell a push target from a landed push.
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
 bdRun,
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
import { fenceRefused } from "../lease";
import { type OriginHead, localState, originHead } from "../origin";
import { runScope } from "../run-scope";

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
 /** What to do about an unsatisfied check, quoted in the refusal beside the predicate. */
 recovery?: string;
}

interface Contract {
 agent?: string;
 completion?: CompletionCheck[];
 authority?: { deny_states?: string[]; deny_metadata?: string[] };
 escape?: { state?: string; require?: string; recovery?: string };
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
 pushed_sha: true,
 run_epic: true,
 runtime_context: true,
 runtime_handle: true,
 scope: true,
 worktree: true,
};

interface Failure {
 check: string;
 detail: string;
 recovery?: string;
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

/**
 * Whether origin holds the head a role recorded, and where the question was put.
 *
 * `ref` is the branch asked about: the `pushed=<ref>@<sha>` token of an implementer's
 * `REPORTED`, or `metadata.branch` for an architect. `matched` is the one outcome that
 * satisfies; `detail` says why the others did not, in the words the refusal quotes.
 */
export interface OriginProof {
 matched: boolean;
 ref?: string;
 /** The commit origin holds at `ref`, when it answered with one. */
 observed?: string;
 detail: string;
}

/** State a predicate may need, fetched once per evaluation. */
export interface Evidence {
 bead: BdBead;
 verbs: string[];
 linkedVerbs: string[];
 openEscalation?: boolean;
 artifactContained?: boolean;
 /** The commit the bead's work started from: its own `base_sha`, else the run epic's. Absent when neither is known. */
 baseSha?: string;
 /** Some `REPORTED` comment on the bead names a changed path. */
 reportedPath?: boolean;
 /** The worker wrote `NOTE no-change: <reason>`: the task needed no edit, and says so. */
 noChangeNoted?: boolean;
 /** The `pushed=<ref>@<sha>` token of the bead's `REPORTED` comments, when one names it. */
 pushed?: { ref: string; sha: string };
 /** Origin's answer for the role's ref; read only when a predicate under judgement asks. */
 origin?: OriginProof;
 /** Whether the clone's own work is on origin or absent; read only when a predicate asks. */
 cloneWork?: OriginProof;
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

/**
 * A commit as a worker or the sweep writes it: seven to forty hex digits.
 *
 * Two shas name the same commit when one is a prefix of the other, because `head_sha` is
 * often stamped short while `base_sha` is stamped full. Anything that is not a sha compares
 * as text: the exit contract never judged what a `head_sha` value is, and does not start.
 */
const COMMIT_SHA = /^[0-9a-f]{7,40}$/;

export function sameCommit(a: string, b: string): boolean {
 const left = a.trim().toLowerCase();
 const right = b.trim().toLowerCase();
 if (!COMMIT_SHA.test(left) || !COMMIT_SHA.test(right)) return left === right;
 return left.startsWith(right) || right.startsWith(left);
}

/**
 * A token that names a file: a slash-separated path with a letter in it, or a dotted
 * file name such as `README.md`. Generous on purpose: a false path counts a comment as
 * evidence, which fails open, while a real path missed would refuse honest work.
 */
const PATH_TOKEN = /^(?=.*[A-Za-z])(?:[\w.@+-]+\/)+[\w.@+-]*$|^[\w@+-]+(?:\.[\w-]+)*\.[A-Za-z][\w-]*$/;

/** Decoration around a token: brackets, quotes, backticks, and the punctuation a sentence hangs on it. */
const TOKEN_TRIM = /^[[(`'"<{,;:]+|[\])`'">}:,;.!?]+$/g;

/**
 * Whether a comment names a changed path. Tokens are read as written, decoration
 * stripped, `key=value` read for its value and comma lists for each entry, so
 * `REPORTED docs/faq.md changed; head_sha d4ca85f`, `files=src/a.ts,src/b.ts` and
 * `` `README.md` `` all count. A URL is not a path.
 */
export function namesPath(text: string): boolean {
 for (const raw of text.split(/\s+/)) {
  let token = raw.replace(TOKEN_TRIM, "");
  const cut = token.indexOf("=");
  // `pushed=omp/task/<id>@<sha>` spells a ref, not a file the worker changed.
  if (cut !== -1 && token.slice(0, cut) === "pushed") continue;
  if (cut !== -1) token = token.slice(cut + 1);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token)) continue;
  if (token.split(",").some(entry => PATH_TOKEN.test(entry))) return true;
 }
 return false;
}

/** The text after a comment's verb, or `undefined` when the comment is the verb alone. */
const AFTER_VERB = /^[\s\-*+>`_~]*\S+\s+([\s\S]*)$/;

/**
 * `NOTE no-change: <reason>`, the bead id optionally between the verb and the marker.
 * The reason is required: a bare marker states nothing the gate can quote back.
 */
export function noChangeNote(comment: string, beadId: string): boolean {
 if (commentVerb(comment) !== "NOTE") return false;
 let rest = AFTER_VERB.exec(comment)?.[1]?.trim() ?? "";
 if (rest.startsWith(`${beadId} `)) rest = rest.slice(beadId.length).trimStart();
 return /^no-change\b[:\s]\s*\S/i.test(rest);
}

/**
 * The `pushed=<ref>@<sha>` token of a `REPORTED` comment: where the worker says its head
 * landed on origin. The ref is a branch name as `git push origin HEAD:<ref>` spells it
 * (`omp/task/<id>`), the sha the commit it pushed. Decoration is stripped like a path
 * token; a `refs/heads/` prefix is folded away so both spellings name the same branch.
 * The last token wins, so a re-push after a bounce supersedes the first report.
 */
export function pushedToken(comments: readonly string[]): { ref: string; sha: string } | undefined {
 let found: { ref: string; sha: string } | undefined;
 for (const comment of comments) {
  if (commentVerb(comment) !== "REPORTED") continue;
  for (const raw of comment.split(/\s+/)) {
   const token = raw.replace(TOKEN_TRIM, "");
   if (!token.startsWith("pushed=")) continue;
   const at = token.lastIndexOf("@");
   if (at <= "pushed=".length) continue;
   const ref = token.slice("pushed=".length, at).replace(/^refs\/heads\//, "");
   const sha = token.slice(at + 1).toLowerCase();
   if (ref.length > 0 && COMMIT_SHA.test(sha)) found = { ref, sha };
  }
 }
 return found;
}

/** The predicates that read origin, and the ref each one asks about. */
const ORIGIN_PREDICATES: Record<string, "pushed" | "branch"> = {
 "origin.pushed == head_sha": "pushed",
 "origin.branch == head_sha": "branch",
};

/**
 * The predicates that read the clone itself: its `HEAD` against the bead's base, and its
 * tree. Work that exists on the clone -- a commit past the base, or an uncommitted change
 * -- must be on origin at `HEAD` (or discarded) before any exit, a park included, because
 * the clone is deleted either way. The ref asked about is the same one the role pushes to.
 */
const CLONE_PREDICATES: Record<string, "pushed" | "branch"> = {
 "clone.work on origin.pushed": "pushed",
 "clone.work on origin.branch": "branch",
};

/** Whether a `require` clause, alternatives included, needs origin read. */
export function asksOrigin(predicate: string): "pushed" | "branch" | undefined {
 for (const clause of predicate.split(/\s+(?:or|and)\s+/)) {
  const source = ORIGIN_PREDICATES[clause.trim()];
  if (source !== undefined) return source;
 }
 return undefined;
}

/** Whether a `require` clause, alternatives included, needs the clone read. */
export function asksClone(predicate: string): "pushed" | "branch" | undefined {
 for (const clause of predicate.split(/\s+(?:or|and)\s+/)) {
  const source = CLONE_PREDICATES[clause.trim()];
  if (source !== undefined) return source;
 }
 return undefined;
}

/**
 * Evaluate one supported `require` predicate; unknown predicates fail closed.
 *
 * `A or B` is either predicate and `A and B` is both, `and` binding tighter as usual; no
 * supported predicate contains either word, so the splits are safe at the top level and
 * a `label ~` pattern must not spell them.
 */
export function satisfies(predicate: string, evidence: Evidence): boolean {
 const { bead, verbs, linkedVerbs } = evidence;
 const trimmed = predicate.trim();

 const alternatives = trimmed.split(/\s+or\s+/);
 if (alternatives.length > 1) return alternatives.some(alternative => satisfies(alternative, evidence));
 const conjuncts = trimmed.split(/\s+and\s+/);
 if (conjuncts.length > 1) return conjuncts.every(conjunct => satisfies(conjunct, evidence));

 if (ORIGIN_PREDICATES[trimmed] !== undefined) return evidence.origin?.matched === true;
 if (CLONE_PREDICATES[trimmed] !== undefined) return evidence.cloneWork?.matched === true;

 const metadataKey = /^metadata\.([A-Za-z0-9_]+)$/.exec(trimmed);
 if (metadataKey?.[1] !== undefined) return metadataString(bead, metadataKey[1]) !== undefined;

 if (trimmed === "metadata.head_sha != base_sha") {
  // Proof only: with no head the delivery check speaks, and with no base there is
  // nothing to compare against, so both are unknown rather than unmet.
  const head = metadataString(bead, "head_sha");
  if (head === undefined || evidence.baseSha === undefined) return true;
  return !sameCommit(head, evidence.baseSha);
 }

 if (trimmed === "comment.REPORTED names a path") return evidence.reportedPath === true;
 if (trimmed === "comment.NOTE no-change") return evidence.noChangeNoted === true;

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
 * What a contract reads beyond the bead's own comments, so the evaluator can skip the
 * reads it will never consult.
 *
 * `verbs`: some `require` names `linked.comment.verb`, so every linked bead's comments
 * are read (researcher, reviewer). `escalation`: the contract pauses on an open
 * escalation wisp, so every linked bead's status is read (architect, implementer). A
 * contract wanting neither (shepherd, generic) reads no link at all. `base`: some
 * `require` compares the head against `base_sha`, so the run epic is read for its base
 * when the bead carries none of its own (implementer).
 */
export interface LinkedEvidenceNeeds {
 verbs: boolean;
 escalation: boolean;
 base: boolean;
}

const ALL_LINKED_EVIDENCE: LinkedEvidenceNeeds = { verbs: true, escalation: true, base: true };

export function linkedEvidenceNeeds(contract: Contract): LinkedEvidenceNeeds {
 const requires = (contract.completion ?? []).map(check => check.require);
 if (contract.escape?.require !== undefined) requires.push(contract.escape.require);
 return {
  verbs: requires.some(predicate => predicate.trim().startsWith("linked.")),
  escalation: contract.pause?.includes("open-escalation-wisp-linked-to-node") === true,
  base: requires.some(predicate => predicate.includes("base_sha")),
 };
}

/**
 * Null is incomplete evidence, never proof of a failed completion contract.
 *
 * Read cost, with L linked beads: one `comments`, then -- only when `needs` asks for
 * anything linked -- two `dep list` and one `bd list --id` hydrating every link at
 * once, then one `comments` per link only when `needs.verbs`; then one `show` of the run
 * epic only when `needs.base`, the bead stamps a head but no base of its own, and a run
 * epic is bound. Absent `needs`, everything is read, which is what a caller judging an
 * unknown contract must do.
 *
 * An unreadable run epic is logged and leaves the base unknown rather than voiding the
 * evidence: the rest of the contract is still judged, and the one predicate that wanted
 * the base fails open on its own.
 */
export async function collectExitEvidence(bead: BdBead, needs: LinkedEvidenceNeeds = ALL_LINKED_EVIDENCE, runEpic?: string): Promise<Evidence | null> {
 const comments = await bdCommentsChecked(bead.id);
 if (comments === null) return null;
 const verbs = comments.map(comment => commentVerb(comment.text));
 const reportedPath = comments.some((comment, index) => verbs[index] === "REPORTED" && namesPath(comment.text));
 const noChangeNoted = comments.some(comment => noChangeNote(comment.text, bead.id));
 const pushed = pushedToken(comments.map(comment => comment.text));
 let baseSha = metadataString(bead, "base_sha");
 if (baseSha === undefined && needs.base && runEpic !== undefined && metadataString(bead, "head_sha") !== undefined) {
  const epic = await bdShow(runEpic);
  if (epic === null) {
   logger.warn("orchestrate exit contract: run epic could not be read; head-versus-base check skipped", {
    bead: bead.id,
    epic: runEpic,
    cause: lastBdFailure(),
   });
  } else {
   baseSha = metadataString(epic, "base_sha");
  }
 }
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
 return { bead, verbs, linkedVerbs, openEscalation, artifactContained, baseSha, reportedPath, noChangeNoted, pushed };
}

/**
 * Ask origin whether the role's recorded head is there, at the ref `source` names.
 *
 * `pushed`: the `REPORTED` token's ref, the sha it claims checked against `head_sha` first
 * so a report that contradicts the stamp is refused without a network read. `branch`:
 * `metadata.branch`. A bead that stamps no `head_sha` has recorded nothing origin could
 * hold, so it passes here and the head check speaks; a stamped head with no ref to ask
 * about is a refusal, because it names a commit nobody can find.
 *
 * Origin not answering is a refusal too, and says so: the worker is alive until proven,
 * and a retry of the push and the report costs nothing that a lost unit would not.
 */
export async function proveOrigin(source: "pushed" | "branch", evidence: Evidence, cwd: string): Promise<OriginProof> {
 const head = metadataString(evidence.bead, "head_sha");
 if (head === undefined) return { matched: true, detail: "no head_sha recorded, so nothing to find on origin" };
 let ref: string | undefined;
 if (source === "pushed") {
  if (evidence.pushed === undefined) return { matched: false, detail: "REPORTED names no pushed=<ref>@<sha>; push your head (`git push origin HEAD:$ORC_PUSH_REF`) and report where it landed" };
  if (!sameCommit(evidence.pushed.sha, head)) {
   return { matched: false, ref: evidence.pushed.ref, detail: `REPORTED says pushed=${evidence.pushed.ref}@${evidence.pushed.sha} but head_sha is ${head}; push the head you stamped and report that sha` };
  }
  ref = evidence.pushed.ref;
 } else {
  ref = metadataString(evidence.bead, "branch");
  if (ref === undefined) return { matched: false, detail: `head_sha ${head} is recorded but metadata.branch names no branch to find it on` };
 }
 const answer: OriginHead = await originHead(cwd, ref);
 switch (answer.kind) {
  case "at":
   if (sameCommit(answer.sha, head)) return { matched: true, ref, observed: answer.sha, detail: `origin ${ref} is at ${answer.sha}` };
   return { matched: false, ref, observed: answer.sha, detail: `origin ${ref} is at ${answer.sha}, not head_sha ${head}; push the head you stamped (\`git push origin HEAD:${ref}\`)` };
  case "missing":
   return { matched: false, ref, detail: `origin has no ${ref}; push it (\`git push origin HEAD:${ref}\`) before yielding, the clone is deleted at yield` };
  case "unreachable":
   return { matched: false, ref, detail: `origin unreachable (${answer.cause}); retry \`git push\` and REPORTED, the worker stays alive until proven` };
 }
}

/**
 * Ask whether the clone holds work origin does not: a `HEAD` past the bead's base (its own
 * `base_sha`, else the run epic's), or an uncommitted change. A clean tree at the base has
 * nothing to lose and passes. Anything else must be on origin at `HEAD`, at the ref the
 * role pushes to; a dirty tree is refused outright, because nothing can prove it. An
 * unknown base, or a clone git cannot describe, is judged as work present.
 */
export async function proveCloneWork(source: "pushed" | "branch", evidence: Evidence, cwd: string, runEpic?: string): Promise<OriginProof> {
 const local = await localState(cwd);
 if (local === undefined) return { matched: false, detail: "the clone's HEAD and tree could not be read; commit and push, or discard, before yielding" };
 if (local.dirty) return { matched: false, detail: `the clone has uncommitted changes at HEAD ${local.head.slice(0, 7)}; commit and push (\`git push origin HEAD:$ORC_PUSH_REF\`), or discard them, before yielding` };
 let base = evidence.baseSha;
 if (base === undefined && runEpic !== undefined) base = metadataString(await bdShow(runEpic), "base_sha");
 if (base !== undefined && sameCommit(local.head, base)) return { matched: true, detail: `the clone is at its base ${base.slice(0, 7)} with a clean tree; nothing to lose` };
 const ref = source === "pushed" ? evidence.pushed?.ref : metadataString(evidence.bead, "branch");
 if (ref === undefined) {
  return { matched: false, detail: `the clone has commits at HEAD ${local.head.slice(0, 7)} that origin does not hold; push them (\`git push origin HEAD:$ORC_PUSH_REF\`) and report pushed=<ref>@${local.head.slice(0, 7)} before yielding` };
 }
 // Origin was already asked about this ref for the stamped head: one read serves both proofs.
 const known = evidence.origin;
 const answer: OriginHead = known?.matched === true && known.ref === ref && known.observed !== undefined ? { kind: "at", sha: known.observed } : await originHead(cwd, ref);
 switch (answer.kind) {
  case "at":
   if (sameCommit(answer.sha, local.head)) return { matched: true, ref, observed: answer.sha, detail: `origin ${ref} is at the clone's HEAD ${answer.sha}` };
   return { matched: false, ref, observed: answer.sha, detail: `origin ${ref} is at ${answer.sha}, not the clone's HEAD ${local.head}; push HEAD (\`git push origin HEAD:${ref}\`) before yielding` };
  case "missing":
   return { matched: false, ref, detail: `origin has no ${ref}; push HEAD (\`git push origin HEAD:${ref}\`) before yielding, the clone is deleted at yield` };
  case "unreachable":
   return { matched: false, ref, detail: `origin unreachable (${answer.cause}); retry \`git push\` and REPORTED, the worker stays alive until proven` };
 }
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

/**
 * Create an exit guard with reminder and refusal budgets private to one factory invocation.
 *
 * Every claimed bead is hydrated in one `bd list --id` before any is judged; a bead the
 * list does not carry is logged and left unjudged, as an unreadable bead always was.
 */
export function createExitGuard(claims: ClaimState): (ctx: ExtensionContext, input?: Record<string, unknown>) => Promise<ToolCallEventResult | undefined> {
 const state: ExitGuardState = { unclaimedReminded: false, refusalClaim: undefined, refusalCount: 0 };
 return async (ctx, input) => {
  resetReadBudget(EXIT_READ_BUDGET);
  const claim = claims.observedClaim();
  if (claim === undefined || claim.beadIds.length === 0) return await gateUnclaimedExit(state, ctx, input);
  const beads = await bdShowMany(claim.beadIds);
  for (const beadId of claim.beadIds) {
   const bead = beads?.get(beadId);
   if (bead === undefined) {
    logger.warn("orchestrate exit contract unevaluated: claimed bead unreadable", {
     bead: beadId,
     cause: beads === null ? lastBdFailure() : "missing",
    });
    continue;
   }
   const result = await gateClaimedExit(state, ctx, claim, bead);
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
 bead: BdBead,
): Promise<ToolCallEventResult | undefined> {
 const beadId = bead.id;
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

 // The base a git head is compared against, when the bead stamps none: the run epic's,
 // named by the marker. `pending` names no epic yet.
 const scope = await runScope(ctx);
 const runEpic = scope === null || scope.runId === "pending" ? undefined : scope.runId;
 const evidence = await collectExitEvidence(bead, linkedEvidenceNeeds(contract), runEpic);
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
 // contract breach. A declared state whose clause is unmet is still judged by the
 // completion checks, as before; the unmet clause is then the first failure named, so a
 // worker that parked its bead reads why the park was refused, not only what a
 // completed exit would have needed.
 let escapeFailure: Failure | undefined;
 if (contract.escape?.state !== undefined && status === contract.escape.state) {
  const require = contract.escape.require;
  if (require === undefined) return undefined;
  const asks = asksOrigin(require);
  if (asks !== undefined) evidence.origin = await proveOrigin(asks, evidence, ctx.cwd);
  const clone = asksClone(require);
  // One refusal is enough: the clone is not read once origin has already said no.
  if (clone !== undefined && evidence.origin?.matched !== false) evidence.cloneWork = await proveCloneWork(clone, evidence, ctx.cwd, runEpic);
  if (satisfies(require, evidence)) return await recordPushed(bead, claim, evidence);
  escapeFailure = { check: "escape", detail: unsatisfied(require, evidence), recovery: contract.escape.recovery };
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
  // Origin is asked once, and only for a check that is actually judged: a paused or
  // inapplicable check spends no network read.
  const asks = asksOrigin(check.require);
  if (asks !== undefined && evidence.origin === undefined) evidence.origin = await proveOrigin(asks, evidence, ctx.cwd);
  const clone = asksClone(check.require);
  // Read once, and only when it can change the verdict: not after origin refused, and not
  // for a bead with no head, where the delivery check already speaks and no epic read is owed.
  if (clone !== undefined && evidence.cloneWork === undefined && metadataString(bead, "head_sha") === undefined) {
   evidence.cloneWork = { matched: true, detail: "no head_sha recorded; the delivery check speaks" };
  } else if (clone !== undefined && evidence.cloneWork === undefined && evidence.origin?.matched !== false) {
   evidence.cloneWork = await proveCloneWork(clone, evidence, ctx.cwd, runEpic);
  }
  if (!satisfies(check.require, evidence)) {
   failures.push({ check: check.check, detail: unsatisfied(check.require, evidence), recovery: check.recovery });
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

 if (failures.length === 0) return await recordPushed(bead, claim, evidence);
 if (escapeFailure !== undefined) failures.unshift(escapeFailure);

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

/** `unsatisfied: <require>`, with origin's or the clone's answer when the predicate asked and it said no. */
function unsatisfied(require: string, evidence: Evidence): string {
 const causes: string[] = [];
 if (asksOrigin(require) !== undefined && evidence.origin !== undefined && !evidence.origin.matched) causes.push(evidence.origin.detail);
 if (asksClone(require) !== undefined && evidence.cloneWork !== undefined && !evidence.cloneWork.matched) causes.push(evidence.cloneWork.detail);
 return `unsatisfied: ${require}${causes.length === 0 ? "" : ` -- ${causes.join("; ")}`}`;
}

/**
 * What bd prints when `--claim` finds nobody to displace and a status it will not claim
 * through. Measured on bd 1.2.2: the assignee is checked first, so this text means the bead
 * is unassigned or the actor's own, and its status is not `open`. Nothing is written.
 */
const CLAIM_NOT_OFFERED = /not claimable: status/i;

/**
 * Record the commit origin was observed to hold, once every check has passed, and let the
 * yield proceed only when that record landed on a bead no other actor holds.
 *
 * `metadata.push` and `metadata.branch` are targets a role stamps before pushing, so a
 * worker that died between the stamp and the push leaves them looking complete.
 * `pushed_sha` is the plugin's own word that it saw the head on origin. The contract has
 * the worker release before it yields, so by now the bead is unassigned; a plain update
 * could land this session's stamp on a successor's claim. `--claim` as the yielding actor
 * is the only fence bd 1.2.2 offers (`bd update --help` lists no release verb), and it
 * answers one of three ways, measured on a real store:
 *
 * - Success: the bead was the actor's own, or unassigned and `open`. `--assignee ""`
 *   releases it in the same write and the status is restated, so an open bead stays open
 *   and a park stays parked. One write, stamped and released together.
 * - `already claimed by <holder>`: the fence. Another actor holds the bead, nothing is
 *   written there, and the exit is refused with the holder named.
 * - `not claimable: status <s>`: the contract's own aftermath. bd claims nothing that is not
 *   `open`, so a released `in_progress` bead refuses its ex-holder as it refuses everyone,
 *   and a `blocked` bead the worker kept refuses the same way. The assignee check runs
 *   first, so this text is proof that no other actor holds the bead. The stamp is then
 *   written plainly under the same actor, touching neither assignee nor status: a retained
 *   claim stays retained. The gap between the two writes is bounded, not closed -- a
 *   successor can hold the bead only after a requeue to `open` and a claim, both by other
 *   actors, and bd 1.2.2 has no metadata compare-and-swap to close it (`src/lease.ts`).
 *
 * Any other failure is logged and the exit allowed: the proof holds, and the sha is a
 * record for offline readers rather than a condition of the exit.
 */
async function recordPushed(bead: BdBead, claim: ClaimObservation, evidence: Evidence): Promise<ToolCallEventResult | undefined> {
 const proof = [evidence.origin, evidence.cloneWork].find(candidate => candidate?.matched === true && candidate.observed !== undefined);
 if (proof?.observed === undefined) return undefined;
 if (metadataString(bead, "pushed_sha") === proof.observed) return undefined;
 const stamp = `pushed_sha=${proof.observed}`;
 const fenced = ["update", bead.id, "--actor", claim.actor, "--claim", "--assignee", "", "--set-metadata", stamp];
 if (typeof bead.status === "string" && bead.status.length > 0) fenced.push("--status", bead.status);
 let written = await bdRun(fenced);
 if (written !== null && written.code !== 0) {
  if (fenceRefused(written)) {
   return {
    block: true,
    reason: `${bead.id} is now claimed by another actor (${(written.stderr || written.stdout).trim()}); your pushed head ${proof.observed} is on origin but this exit cannot be recorded on a bead you no longer hold. Write nothing more to it and yield NO_WORK`,
   };
  }
  if (CLAIM_NOT_OFFERED.test(written.stderr) || CLAIM_NOT_OFFERED.test(written.stdout)) {
   written = await bdRun(["update", bead.id, "--actor", claim.actor, "--set-metadata", stamp]);
  }
 }
 if (written !== null && written.code === 0) return undefined;
 logger.warn("orchestrate exit contract: pushed_sha not recorded", {
  bead: bead.id,
  sha: proof.observed,
  cause: written === null ? lastBdFailure() : written.stderr.trim() || `bd exited ${written.code}`,
 });
 return undefined;
}
