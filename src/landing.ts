/**
 * Landing — deterministic PR landing from the lead session.
 *
 * Replaces the two-phase shepherd, the `gh:run` gate and the merge slot: nothing woke
 * the second phase when CI finished, so a landing stalled in silence. Here the 60 s
 * sweep (`watchers.ts`) reads every open merge bead, polls its PR once per repository,
 * and acts on what GitHub reports. GitHub does the waiting; the plugin does the
 * merging; a model is spawned for nothing but a review-bot round.
 *
 * Two modes, chosen from a capability probe recorded on the run epic at bind:
 *
 * - `auto`: arm GitHub's auto-merge (`gh pr merge --auto --squash --match-head-commit`)
 *   and observe. Safe ONLY when the repository allows auto-merge AND at least one status
 *   check is required: without a required check `gh --auto` performs an immediate
 *   merge, and `UNSTABLE` (failing non-required checks) counts as immediately
 *   mergeable (`cli/cli pkg/cmd/pr/merge/merge.go`, `isImmediatelyMergeable`). That
 *   precondition is enforced in {@link attemptMerge}, not left to prose.
 * - `direct`: observe the checks; when GitHub reports `CLEAN` at the reviewed head,
 *   `gh pr merge --squash --match-head-commit <head>`. The fallback for every other
 *   repository, this one included.
 *
 * Invariants, in the memo's numbering: (I1) the merger is not the author; (I2) the head
 * that was reviewed is the head that lands -- `metadata.head_sha` on the merge bead is
 * the architect's reviewed head, and every merge call carries `--match-head-commit`;
 * (I3) CI is proven at that head; (I4) a failure becomes a routed fix bead, never a
 * silent stall; (I5) unknown evidence (`UNKNOWN`, an unreadable `gh`, an unclassifiable
 * `merge-tree`) never transitions anything. Never `--admin`, never a force push.
 *
 * Terminals: a `DIRTY`/`BEHIND` PR gets a `merge-tree` precheck in a throwaway bare
 * clone; a clean merge is committed with plumbing and fast-forward pushed to the PR
 * branch (the reviewed diff against the base is unchanged, so the new head is re-stamped
 * without a review round); conflicts become an implementer fix bead, or an architect
 * one when a conflicting path leaves the origin's scope. A failing check is rerun once
 * per head (`gh run rerun --failed`), then becomes an implementer fix bead. Every fix
 * bead `blocks` the merge bead, which is what keeps the sweep off it until the fix lands
 * and the architect re-stamps the reviewed head. Every terminal writes one verb comment
 * on the merge bead: `LANDED <sha>` or `BOUNCED reason=<cause>`.
 *
 * State lives on the merge bead's metadata, one carrier: `landing_state`, `armed_head`,
 * `ci_rerun_head`, `ci_reruns`, `landing_fix`, `landing_notice`. Attention states
 * (`BLOCKED ...`) are written once per cause through `landing_notice`, so a sweep that
 * finds the same cause every minute says it once.
 *
 * Nothing here throws out of the sweep. Every subprocess goes through the injectable
 * {@link Exec} seam, so tests drive `gh` and `git` from transcripts and never touch a
 * real PR.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
 type BdBead,
 bdBlockedChecked,
 bdListChecked,
 bdRun,
 bdShow,
 metadataRecord,
 metadataString,
 resetReadBudget,
} from "./bd";
import { fnmatch, normalizeScope, scopeOf } from "./scope";
import { type Exec, type ExecResult, spawnExec } from "./tools/bot-review-probe";
import { mergeTreeArgv, mergeTreeOid, parseMergeTreeOutput } from "./tools/conflict-probe";

// ============================================================================
// Capabilities
// ============================================================================

export type LandingMode = "auto" | "direct";

/** What one repository lets the plugin do, recorded on the run epic as `metadata.landing`. */
export interface LandingCapabilities {
 repo: string;
 base: string;
 mode: LandingMode;
 auto_merge_allowed: boolean;
 squash_allowed: boolean;
 required_checks: string[];
 strict: boolean;
 queue: boolean;
 viewer_permission?: string;
 probed_at: string;
}

export type ProbeResult = { ok: true; caps: LandingCapabilities } | { ok: false; error: string };

const GH_READ_TIMEOUT_MS = 15_000;
const GH_WRITE_TIMEOUT_MS = 30_000;
const GIT_TIMEOUT_MS = 30_000;
const GIT_FETCH_TIMEOUT_MS = 120_000;
const BD_WRITE_TIMEOUT_MS = 20_000;

const CAPABILITY_QUERY =
 "query($owner:String!,$name:String!,$base:String!,$ref:String!){repository(owner:$owner,name:$name){" +
 "autoMergeAllowed squashMergeAllowed viewerPermission mergeQueue(branch:$base){id} " +
 "ref(qualifiedName:$ref){branchProtectionRule{requiredStatusCheckContexts requiresStrictStatusChecks}} " +
 "rulesets(first:50){nodes{enforcement target conditions{refName{include exclude}} " +
 "rules(first:50){nodes{type parameters{__typename ... on RequiredStatusChecksParameters{" +
 "strictRequiredStatusChecksPolicy requiredStatusChecks{context}}}}}}}}}";

/** One GraphQL read for everything the mode decision needs; `gh repo view` has no `autoMergeAllowed`. */
export function capabilityQueryArgv(repo: string, base: string): string[] | undefined {
 const [owner, name, ...rest] = repo.split("/");
 if (!owner || !name || rest.length > 0) return undefined;
 return [
  "gh", "api", "graphql",
  "-f", `query=${CAPABILITY_QUERY}`,
  "-F", `owner=${owner}`,
  "-F", `name=${name}`,
  "-F", `base=${base}`,
  "-F", `ref=refs/heads/${base}`,
 ];
}

/** `auto` only where GitHub will actually wait; everything else is observed and merged directly. */
export function selectMode(caps: Pick<LandingCapabilities, "auto_merge_allowed" | "required_checks">): LandingMode {
 return caps.auto_merge_allowed && caps.required_checks.length > 0 ? "auto" : "direct";
}

function record(value: unknown): Record<string, unknown> | undefined {
 return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function strings(value: unknown): string[] {
 return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/** Whether a ruleset's ref conditions name `base`. No condition means every branch. */
function rulesetCovers(conditions: unknown, base: string): boolean {
 const include = strings(record(record(conditions)?.refName)?.include);
 if (include.length === 0) return true;
 return include.some(pattern => pattern === "~ALL" || pattern === "~DEFAULT_BRANCH" || pattern === `refs/heads/${base}`);
}

/**
 * Read the capability payload. Required checks are the union of the classic branch
 * protection rule and every active ruleset on the base; a merge queue is either the
 * repository's queue on that branch or a `MERGE_QUEUE` ruleset rule.
 */
export function parseCapabilities(payload: unknown, repo: string, base: string, probedAt: string): LandingCapabilities | undefined {
 const repository = record(record(record(payload)?.data)?.repository);
 if (repository === undefined) return undefined;
 if (typeof repository.autoMergeAllowed !== "boolean" || typeof repository.squashMergeAllowed !== "boolean") return undefined;

 const required = new Set<string>();
 let strict = false;
 let queue = record(repository.mergeQueue) !== undefined;

 const protection = record(record(repository.ref)?.branchProtectionRule);
 if (protection !== undefined) {
  for (const context of strings(protection.requiredStatusCheckContexts)) required.add(context);
  if (protection.requiresStrictStatusChecks === true) strict = true;
 }
 for (const node of Array.isArray(record(repository.rulesets)?.nodes) ? (record(repository.rulesets)?.nodes as unknown[]) : []) {
  const ruleset = record(node);
  if (ruleset === undefined || ruleset.enforcement !== "ACTIVE" || ruleset.target !== "BRANCH") continue;
  if (!rulesetCovers(ruleset.conditions, base)) continue;
  for (const ruleNode of Array.isArray(record(ruleset.rules)?.nodes) ? (record(ruleset.rules)?.nodes as unknown[]) : []) {
   const rule = record(ruleNode);
   if (rule === undefined) continue;
   if (rule.type === "MERGE_QUEUE") queue = true;
   if (rule.type !== "REQUIRED_STATUS_CHECKS") continue;
   const parameters = record(rule.parameters);
   if (parameters?.strictRequiredStatusChecksPolicy === true) strict = true;
   for (const check of Array.isArray(parameters?.requiredStatusChecks) ? (parameters.requiredStatusChecks as unknown[]) : []) {
    const context = record(check)?.context;
    if (typeof context === "string" && context.length > 0) required.add(context);
   }
  }
 }

 const caps: LandingCapabilities = {
  repo,
  base,
  mode: "direct",
  auto_merge_allowed: repository.autoMergeAllowed,
  squash_allowed: repository.squashMergeAllowed,
  required_checks: [...required].sort(),
  strict,
  queue,
  probed_at: probedAt,
 };
 if (typeof repository.viewerPermission === "string") caps.viewer_permission = repository.viewerPermission;
 caps.mode = selectMode(caps);
 return caps;
}

/** Probe one repository's landing capabilities. Never throws; an unreadable answer is an error result. */
export async function probeLandingCapabilities(
 repo: string,
 base: string,
 exec: Exec = spawnExec,
 cwd?: string,
 now: () => number = Date.now,
): Promise<ProbeResult> {
 const argv = capabilityQueryArgv(repo, base);
 if (argv === undefined) return { ok: false, error: `repository must be owner/name, got ${JSON.stringify(repo)}` };
 const result = await exec(argv, { cwd, timeoutMs: GH_READ_TIMEOUT_MS });
 if (result === null) return { ok: false, error: "gh did not answer the capability query" };
 if (result.code !== 0) return { ok: false, error: `gh api graphql exited ${result.code}: ${result.stderr.trim()}` };
 let payload: unknown;
 try {
  payload = JSON.parse(result.stdout);
 } catch {
  return { ok: false, error: "capability query returned no JSON" };
 }
 const caps = parseCapabilities(payload, repo, base, new Date(now()).toISOString());
 return caps === undefined ? { ok: false, error: "capability query payload lacks the repository fields" } : { ok: true, caps };
}

/** What `/orchestrate-start` tells the operator after recording the capabilities. */
export type LandingRecord = { ok: true; caps: LandingCapabilities; notice: string; level: "info" | "warning" } | { ok: false; error: string };

/**
 * Probe the run's repository and record the result on the run epic as
 * `metadata.landing`. The repository is the one the lead's checkout answers to
 * (`gh repo view`); the base is the epic's `primary_branch`, else GitHub's default.
 */
export async function recordLandingCapabilities(cwd: string, runId: string, exec: Exec = spawnExec): Promise<LandingRecord> {
 const epic = await bdShow(runId, undefined, cwd);
 const view = await exec(["gh", "repo", "view", "--json", "nameWithOwner,defaultBranchRef"], { cwd, timeoutMs: GH_READ_TIMEOUT_MS });
 if (view === null || view.code !== 0) {
  return { ok: false, error: `gh repo view failed${view === null ? "" : `: ${view.stderr.trim()}`}` };
 }
 let repo: string | undefined;
 let defaultBranch: string | undefined;
 try {
  const parsed = record(JSON.parse(view.stdout));
  if (typeof parsed?.nameWithOwner === "string") repo = parsed.nameWithOwner;
  const ref = record(parsed?.defaultBranchRef);
  if (typeof ref?.name === "string") defaultBranch = ref.name;
 } catch {
  return { ok: false, error: "gh repo view returned no JSON" };
 }
 if (repo === undefined) return { ok: false, error: "gh repo view did not name the repository" };
 const base = metadataString(epic, "primary_branch") ?? defaultBranch;
 if (base === undefined) return { ok: false, error: "no base branch: the run epic has no primary_branch and GitHub reports no default" };

 const probe = await probeLandingCapabilities(repo, base, exec, cwd);
 if (!probe.ok) return probe;
 const written = await bdRun(["update", runId, "--metadata", JSON.stringify({ landing: probe.caps })], BD_WRITE_TIMEOUT_MS, cwd);
 if (written === null || written.code !== 0) {
  return { ok: false, error: `could not record landing capabilities on ${runId}${written === null ? "" : `: ${written.stderr.trim()}`}` };
 }
 const { caps } = probe;
 if (!caps.squash_allowed) {
  return { ok: true, caps, level: "warning", notice: `landing: squash merges are disabled on ${repo}; the sweep will not merge until they are enabled` };
 }
 let notice = `landing mode ${caps.mode} for ${repo} (${base}): auto-merge ${caps.auto_merge_allowed ? "on" : "off"}, required checks ${caps.required_checks.length === 0 ? "none" : caps.required_checks.join(", ")}`;
 if (caps.mode === "direct" && caps.viewer_permission === "ADMIN" && !caps.auto_merge_allowed) {
  notice += `; mode auto needs \`gh api -X PATCH repos/${repo} -f allow_auto_merge=true\` and one required check`;
 }
 return { ok: true, caps, level: "info", notice };
}

/** The recorded `metadata.landing` of a run epic, or `undefined` when absent or malformed. */
export function recordedCapabilities(epic: BdBead | null): LandingCapabilities | undefined {
 const raw = record(metadataRecord(epic?.metadata)?.landing);
 if (raw === undefined) return undefined;
 if (typeof raw.repo !== "string" || typeof raw.base !== "string" || typeof raw.auto_merge_allowed !== "boolean"
  || typeof raw.squash_allowed !== "boolean" || typeof raw.probed_at !== "string") return undefined;
 const caps: LandingCapabilities = {
  repo: raw.repo,
  base: raw.base,
  mode: "direct",
  auto_merge_allowed: raw.auto_merge_allowed,
  squash_allowed: raw.squash_allowed,
  required_checks: strings(raw.required_checks),
  strict: raw.strict === true,
  queue: raw.queue === true,
  probed_at: raw.probed_at,
 };
 if (typeof raw.viewer_permission === "string") caps.viewer_permission = raw.viewer_permission;
 // The mode is derived, never trusted from the record: a hand-edited `mode: auto` on a
 // repository without a required check is exactly the silent immediate merge.
 caps.mode = selectMode(caps);
 return caps;
}

// ============================================================================
// PR observation
// ============================================================================

/** One PR as the sweep reads it. */
export interface PrView {
 number: number;
 state: "OPEN" | "MERGED" | "CLOSED";
 isDraft: boolean;
 headRefOid: string;
 headRefName?: string;
 baseRefName?: string;
 mergeStateStatus: string;
 armed: boolean;
 checks: CheckEntry[];
 mergeCommit?: string;
}

/** One status check at the head, reduced to what the decision reads. */
export interface CheckEntry {
 name: string;
 state: "green" | "pending" | "failing";
 url?: string;
 runId?: string;
}

const GREEN_CONCLUSIONS: Record<string, true> = { SUCCESS: true, NEUTRAL: true, SKIPPED: true };
const GREEN_STATES: Record<string, true> = { SUCCESS: true };
const PENDING_STATES: Record<string, true> = { PENDING: true, EXPECTED: true };

const PR_FIELDS = "number,state,isDraft,headRefOid,headRefName,baseRefName,mergeStateStatus,autoMergeRequest,statusCheckRollup,mergeCommit";

export function prListArgv(repo: string): string[] {
 return ["gh", "pr", "list", "--repo", repo, "--state", "open", "--limit", "100", "--json", PR_FIELDS];
}

export function prViewArgv(repo: string, pr: number): string[] {
 return ["gh", "pr", "view", String(pr), "--repo", repo, "--json", PR_FIELDS];
}

/** `https://github.com/o/r/actions/runs/<id>/job/<job>` names the workflow run a rerun addresses. */
function runIdOf(url: string | undefined): string | undefined {
 return url === undefined ? undefined : /\/actions\/runs\/(\d+)/.exec(url)?.[1];
}

/** Reduce a `statusCheckRollup` to check entries; unknown shapes are pending, never green. */
export function checkEntries(rollup: unknown): CheckEntry[] {
 const entries: CheckEntry[] = [];
 for (const raw of Array.isArray(rollup) ? rollup : []) {
  const entry = record(raw);
  if (entry === undefined) continue;
  if (typeof entry.context === "string") {
   const state = typeof entry.state === "string" ? entry.state : "";
   const item: CheckEntry = {
    name: entry.context,
    state: GREEN_STATES[state] === true ? "green" : PENDING_STATES[state] === true ? "pending" : "failing",
   };
   if (typeof entry.targetUrl === "string") item.url = entry.targetUrl;
   entries.push(item);
   continue;
  }
  if (typeof entry.name !== "string") continue;
  const conclusion = typeof entry.conclusion === "string" ? entry.conclusion : "";
  const item: CheckEntry = {
   name: entry.name,
   state: entry.status !== "COMPLETED" ? "pending" : GREEN_CONCLUSIONS[conclusion] === true ? "green" : "failing",
  };
  if (typeof entry.detailsUrl === "string") {
   item.url = entry.detailsUrl;
   const runId = runIdOf(entry.detailsUrl);
   if (runId !== undefined) item.runId = runId;
  }
  entries.push(item);
 }
 return entries;
}

export interface CheckVerdict {
 state: "green" | "pending" | "failing";
 failing: CheckEntry[];
}

/**
 * Judge the checks at one head. With required checks, only those count and a required
 * check that has not reported yet is pending; without, every check counts. Pending
 * outranks failing: a rerun in flight is a pending entry beside a failed one, and the
 * verdict on a head is read once its checks have settled.
 */
export function classifyChecks(entries: readonly CheckEntry[], required: readonly string[]): CheckVerdict {
 const relevant = required.length === 0 ? entries : entries.filter(entry => required.includes(entry.name));
 if (required.some(name => !entries.some(entry => entry.name === name))) return { state: "pending", failing: [] };
 if (relevant.some(entry => entry.state === "pending")) return { state: "pending", failing: [] };
 const failing = relevant.filter(entry => entry.state === "failing");
 return failing.length > 0 ? { state: "failing", failing } : { state: "green", failing: [] };
}

/** One `gh pr` JSON object as a {@link PrView}, or `undefined` when it lacks the decision fields. */
export function prView(raw: unknown): PrView | undefined {
 const entry = record(raw);
 if (entry === undefined || typeof entry.number !== "number" || typeof entry.headRefOid !== "string") return undefined;
 const state = entry.state;
 if (state !== "OPEN" && state !== "MERGED" && state !== "CLOSED") return undefined;
 const view: PrView = {
  number: entry.number,
  state,
  isDraft: entry.isDraft === true,
  headRefOid: entry.headRefOid,
  mergeStateStatus: typeof entry.mergeStateStatus === "string" ? entry.mergeStateStatus : "UNKNOWN",
  armed: record(entry.autoMergeRequest) !== undefined,
  checks: checkEntries(entry.statusCheckRollup),
 };
 if (typeof entry.headRefName === "string") view.headRefName = entry.headRefName;
 if (typeof entry.baseRefName === "string") view.baseRefName = entry.baseRefName;
 const mergeCommit = record(entry.mergeCommit)?.oid;
 if (typeof mergeCommit === "string") view.mergeCommit = mergeCommit;
 return view;
}

async function ghJson(exec: Exec, argv: string[], cwd: string): Promise<unknown | undefined> {
 const result = await exec(argv, { cwd, timeoutMs: GH_READ_TIMEOUT_MS });
 if (result === null || result.code !== 0) return undefined;
 try {
  return JSON.parse(result.stdout);
 } catch {
  return undefined;
 }
}

// ============================================================================
// The merge bead
// ============================================================================

/** What a merge bead must carry before the sweep acts on it. */
interface MergeUnit {
 bead: BdBead;
 repo: string;
 pr: number;
 head: string;
 branch: string | undefined;
 origin: string | undefined;
}

const HEAD_RE = /^[0-9a-f]{40,64}$/i;

function mergeUnit(bead: BdBead): { unit: MergeUnit } | { missing: string[] } {
 const metadata = metadataRecord(bead.metadata);
 const missing: string[] = [];
 const repo = metadataString(bead, "repo");
 if (repo === undefined || repo.split("/").length !== 2) missing.push("repo");
 const rawPr = metadata?.pr;
 const pr = typeof rawPr === "number" ? rawPr : typeof rawPr === "string" && /^\d+$/.test(rawPr) ? Number.parseInt(rawPr, 10) : undefined;
 if (pr === undefined) missing.push("pr");
 const head = metadataString(bead, "head_sha");
 if (head === undefined || !HEAD_RE.test(head)) missing.push("head_sha");
 if (missing.length > 0 || repo === undefined || pr === undefined || head === undefined) return { missing };
 return {
  unit: {
   bead,
   repo,
   pr,
   head,
   branch: metadataString(bead, "branch"),
   origin: metadataString(bead, "origin_bead") ?? metadataString(bead, "origin"),
  },
 };
}

function short(sha: string): string {
 return sha.slice(0, 7);
}

// ============================================================================
// Bead writes
// ============================================================================

interface Io {
 exec: Exec;
 cwd: string;
 now: () => number;
}

async function comment(io: Io, id: string, text: string): Promise<boolean> {
 const result = await bdRun(["comment", id, text], BD_WRITE_TIMEOUT_MS, io.cwd);
 return result?.code === 0;
}

async function stamp(io: Io, id: string, metadata: Record<string, unknown>, extra: string[] = []): Promise<boolean> {
 const result = await bdRun(["update", id, "--metadata", JSON.stringify(metadata), ...extra], BD_WRITE_TIMEOUT_MS, io.cwd);
 return result?.code === 0;
}

/**
 * An attention notice, written once per cause: the cause key is stamped first so a
 * repeated sweep finding the same cause is silent, and a changed cause speaks again.
 */
async function notice(io: Io, bead: BdBead, key: string, text: string): Promise<void> {
 if (metadataString(bead, "landing_notice") === key) return;
 if (!(await stamp(io, bead.id, { landing_notice: key }))) return;
 await comment(io, bead.id, text);
}

/** Write the same verb on the merge bead and on the origin the architect watches. */
async function disposition(io: Io, unit: MergeUnit, text: string): Promise<void> {
 await comment(io, unit.bead.id, text);
 if (unit.origin !== undefined) await comment(io, unit.origin, `${text} merge=${unit.bead.id}`);
}

// ============================================================================
// Fix beads
// ============================================================================

/** Whether one scope glob names a repo-relative path; the same reading G2 gives a scope. */
function scopeNames(relative: string, glob: string): boolean {
 const trimmed = normalizeScope(glob);
 if (trimmed.length === 0) return true;
 return fnmatch(relative, trimmed) || fnmatch(relative, `${trimmed}/*`);
}

/**
 * Who repairs a conflict: the implementer when every conflicting path is inside the
 * origin's scope, the architect when one leaves it. An origin that declares no scope
 * bounds nothing, so its conflicts stay with the implementer.
 */
export function conflictRole(paths: readonly string[], scope: readonly string[]): "implementer" | "architect" {
 if (scope.length === 0) return "implementer";
 const outside = paths.some(file => !scope.some(glob => scopeNames(normalizeScope(file), glob)));
 return outside ? "architect" : "implementer";
}

/** The epic an origin's queue is pulled from: the feature itself, or a task's feature. */
function fixParent(origin: BdBead): string {
 if (origin.issue_type === "epic") return origin.id;
 return typeof origin.parent === "string" && origin.parent.length > 0 ? origin.parent : origin.id;
}

interface FixSpec {
 role: "implementer" | "architect";
 title: string;
 description: string;
 reason: "conflict" | "ci";
}

/**
 * File the fix bead under the origin's feature, routed and scoped, blocking the merge
 * bead and discovered from the origin. Returns the new id, or `undefined` when the
 * origin could not be read (nothing is filed blind: a parentless fix is unreachable
 * from every queue) or `bd create` failed.
 */
async function createFixBead(io: Io, unit: MergeUnit, origin: BdBead, spec: FixSpec): Promise<string | undefined> {
 const metadata: Record<string, unknown> = {
  role: spec.role,
  stage: "fix",
  origin_bead: unit.bead.id,
  repo: unit.repo,
  pr: unit.pr,
  execution_kind: "git",
  landing_reason: spec.reason,
 };
 if (unit.branch !== undefined) metadata.branch = unit.branch;
 const baseSha = metadataString(unit.bead, "base_sha");
 if (baseSha !== undefined) metadata.base_sha = baseSha;
 const originScope = metadataRecord(origin.metadata)?.scope;
 if (spec.role === "implementer" && originScope !== undefined) metadata.scope = originScope;
 const result = await bdRun([
  "create", spec.title,
  "--type", "task",
  "--parent", fixParent(origin),
  "--deps", `discovered-from:${origin.id},blocks:${unit.bead.id}`,
  "--metadata", JSON.stringify(metadata),
  "--description", spec.description,
  "--silent",
 ], BD_WRITE_TIMEOUT_MS, io.cwd);
 if (result === null || result.code !== 0) return undefined;
 const id = result.stdout.trim().split("\n").at(-1)?.trim() ?? "";
 return /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id) ? id : undefined;
}

/** File a fix bead and record the bounce; `unstable`/`dirty` outcomes end here. */
async function bounce(io: Io, unit: MergeUnit, spec: FixSpec, summary: string): Promise<Outcome> {
 if (unit.origin === undefined) {
  await notice(io, unit.bead, "origin:absent", `BLOCKED landing: PR #${unit.pr} needs a fix bead but the merge bead names no origin_bead`);
  return "blocked";
 }
 const origin = await bdShow(unit.origin, undefined, io.cwd);
 if (origin === null) {
  await notice(io, unit.bead, `origin:${unit.origin}`, `BLOCKED landing: PR #${unit.pr} needs a fix bead but origin ${unit.origin} could not be read`);
  return "blocked";
 }
 const fix = await createFixBead(io, unit, origin, spec);
 if (fix === undefined) {
  await notice(io, unit.bead, `fix:${spec.reason}:${unit.head}`, `BLOCKED landing: could not file the ${spec.reason} fix bead for PR #${unit.pr}`);
  return "blocked";
 }
 await stamp(io, unit.bead.id, { landing_state: "bounced", landing_fix: fix, landing_notice: "" });
 await disposition(io, unit, `BOUNCED reason=${spec.reason} fix=${fix} pr=${unit.pr} head=${short(unit.head)} role=${spec.role}: ${summary}`);
 return spec.reason === "conflict" ? "dirty" : "unstable";
}

// ============================================================================
// Terminals
// ============================================================================

/** Per-PR sweep outcome. `armed`, `merged`, `dirty`, `unstable`, `blocked`, `draft` act or wait; the rest observe. */
export type Outcome =
 | "armed"
 | "merged"
 | "refreshed"
 | "dirty"
 | "unstable"
 | "blocked"
 | "draft"
 | "pending"
 | "unknown"
 | "closed"
 | "skipped";

async function landed(io: Io, unit: MergeUnit, pr: PrView, sha: string): Promise<Outcome> {
 const guarded = pr.headRefOid === unit.head;
 await stamp(io, unit.bead.id, { landing_state: "landed", merge_sha: sha, landed_head: pr.headRefOid });
 await disposition(io, unit, `LANDED ${sha} pr=${unit.pr} head=${short(pr.headRefOid)}${guarded ? "" : ` UNGUARDED reviewed=${short(unit.head)}`}`);
 if (!guarded && unit.origin !== undefined) {
  await comment(io, unit.origin, `NOTE landing: PR #${unit.pr} merged at ${short(pr.headRefOid)}, not the reviewed head ${short(unit.head)}; review the landed diff`);
 }
 await bdRun(["close", unit.bead.id, "--reason", `LANDED ${sha}`], BD_WRITE_TIMEOUT_MS, io.cwd);
 return "merged";
}

async function closedUnmerged(io: Io, unit: MergeUnit): Promise<Outcome> {
 await stamp(io, unit.bead.id, { landing_state: "closed" }, ["--status", "blocked"]);
 await disposition(io, unit, `BOUNCED reason=closed pr=${unit.pr}: the PR was closed without merging; reopen it or close the merge bead`);
 return "closed";
}

/**
 * Merge, or arm the merge, at the reviewed head.
 *
 * `auto` is taken only when the recorded capabilities make GitHub wait: auto-merge
 * allowed AND a required check. Any other capability set is merged directly, whatever
 * the caller believed, because `gh pr merge --auto` on a repository without a required
 * check merges immediately -- `UNSTABLE` included.
 */
export async function attemptMerge(io: Io, unit: MergeUnit, pr: PrView, caps: LandingCapabilities, verdict: CheckVerdict): Promise<Outcome> {
 if (!caps.squash_allowed) {
  await notice(io, unit.bead, "squash", `BLOCKED landing: squash merges are disabled on ${unit.repo}; PR #${unit.pr} cannot land until they are enabled`);
  return "blocked";
 }
 if (caps.auto_merge_allowed && caps.required_checks.length > 0) {
  if (pr.armed) return "armed";
  // `gh --auto` merges at once on anything GitHub calls immediately mergeable, UNSTABLE
  // included, so it is armed only where GitHub will wait (BLOCKED by a pending required
  // check) or where the required set is already green and an immediate merge is the
  // guarded merge this module would perform itself.
  if (pr.mergeStateStatus !== "BLOCKED" && verdict.state !== "green") return "pending";
  if (metadataString(unit.bead, "armed_head") === pr.headRefOid && metadataString(unit.bead, "landing_state") === "armed") {
   // Armed by an earlier sweep and now unarmed by GitHub at the same head: disarmed.
   await notice(io, unit.bead, `disarmed:${pr.headRefOid}`, `BLOCKED landing: GitHub disarmed auto-merge on PR #${unit.pr} at ${short(pr.headRefOid)}; re-arm by hand or re-review`);
   return "blocked";
  }
  const armed = await io.exec(
   ["gh", "pr", "merge", String(pr.number), "--repo", unit.repo, "--auto", "--squash", "--match-head-commit", unit.head],
   { cwd: io.cwd, timeoutMs: GH_WRITE_TIMEOUT_MS },
  );
  if (armed === null || armed.code !== 0) {
   await notice(io, unit.bead, `arm:${pr.headRefOid}`, `BLOCKED landing: gh pr merge --auto refused PR #${unit.pr} at ${short(pr.headRefOid)}${armed === null ? "" : `: ${armed.stderr.trim()}`}`);
   return "blocked";
  }
  await stamp(io, unit.bead.id, { landing_state: "armed", armed_head: pr.headRefOid, armed_at: new Date(io.now()).toISOString() });
  return "armed";
 }

 // Direct: the required set (or, with none required, every check) is green and GitHub
 // agrees the PR is mergeable. UNSTABLE counts only when a required set exists and is
 // green, since the failing check is then one the repository itself does not require.
 const mergeable = pr.mergeStateStatus === "CLEAN" || pr.mergeStateStatus === "HAS_HOOKS"
  || (pr.mergeStateStatus === "UNSTABLE" && caps.required_checks.length > 0);
 if (verdict.state !== "green" || !mergeable) return "pending";
 const merged = await io.exec(
  ["gh", "pr", "merge", String(pr.number), "--repo", unit.repo, "--squash", "--match-head-commit", unit.head],
  { cwd: io.cwd, timeoutMs: GH_WRITE_TIMEOUT_MS },
 );
 if (merged === null || merged.code !== 0) {
  await notice(io, unit.bead, `merge:${pr.headRefOid}`, `BLOCKED landing: gh pr merge refused PR #${unit.pr} at ${short(pr.headRefOid)}${merged === null ? "" : `: ${merged.stderr.trim()}`}`);
  return "blocked";
 }
 // Read the record back; a read that fails here is caught by the next sweep, which
 // finds the PR gone from the open list and views it.
 const after = prView(await ghJson(io.exec, prViewArgv(unit.repo, pr.number), io.cwd));
 if (after?.state === "MERGED" && after.mergeCommit !== undefined) return await landed(io, unit, after, after.mergeCommit);
 return "pending";
}

// ============================================================================
// DIRTY / BEHIND: refresh the branch from its base, or file the conflict
// ============================================================================

/** `owner/name` of a GitHub remote URL in either https or ssh spelling, lowercased. */
export function repoOfRemote(url: string): string | undefined {
 const match = /github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim());
 return match === null ? undefined : `${match[1]}/${match[2]}`.toLowerCase();
}

async function git(io: Io, argv: string[], cwd: string, timeoutMs = GIT_TIMEOUT_MS): Promise<ExecResult | null> {
 return await io.exec(["git", ...argv], { cwd, timeoutMs });
}

/**
 * Bring the PR branch up to its base without touching the lead's checkout: a bare
 * clone sharing the checkout's objects, both refs fetched from the remote, `merge-tree`
 * as the precheck and the merge, `commit-tree` for the commit, and a plain fast-forward
 * push of the result. A branch that moved under us is refused by the push itself. On
 * conflict, the paths route a fix bead by scope.
 */
export async function resolveDirty(io: Io, unit: MergeUnit, pr: PrView): Promise<Outcome> {
 const branch = unit.branch ?? pr.headRefName;
 const base = pr.baseRefName;
 if (branch === undefined || base === undefined) {
  await notice(io, unit.bead, `refs:${pr.headRefOid}`, `BLOCKED landing: PR #${unit.pr} is ${pr.mergeStateStatus} and the merge bead names no branch to refresh`);
  return "blocked";
 }
 const remote = await git(io, ["remote", "get-url", "origin"], io.cwd);
 const url = remote?.code === 0 ? remote.stdout.trim() : "";
 if (repoOfRemote(url) !== unit.repo.toLowerCase()) {
  await notice(io, unit.bead, `remote:${unit.repo}`, `BLOCKED landing: PR #${unit.pr} is ${pr.mergeStateStatus} but this checkout's origin is not ${unit.repo}`);
  return "blocked";
 }

 const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "orc-landing-"));
 const clone = path.join(tmp, "repo.git");
 try {
  const cloned = await git(io, ["clone", "--quiet", "--bare", "--shared", io.cwd, clone], io.cwd);
  if (cloned?.code !== 0) return "unknown";
  const fetched = await git(io, ["fetch", "--quiet", url, `+refs/heads/${base}:refs/landing/base`, `+refs/heads/${branch}:refs/landing/branch`], clone, GIT_FETCH_TIMEOUT_MS);
  if (fetched?.code !== 0) return "unknown";
  const heads = await git(io, ["rev-parse", "refs/landing/base", "refs/landing/branch"], clone);
  if (heads?.code !== 0) return "unknown";
  const [baseHead, branchHead] = heads.stdout.trim().split("\n").map(line => line.trim());
  if (baseHead === undefined || branchHead === undefined) return "unknown";
  // The PR head moved between the poll and the fetch: judge it on the next sweep.
  if (branchHead !== pr.headRefOid) return "pending";

  const merge = await git(io, mergeTreeArgv("refs/landing/base", "refs/landing/branch").slice(1), clone);
  if (merge === null) return "unknown";
  if (merge.code === 0) {
   const tree = mergeTreeOid(merge.stdout);
   if (tree === undefined) return "unknown";
   const committed = await git(io, [
    "-c", "user.name=omp-orchestrate", "-c", "user.email=omp-orchestrate@localhost", "-c", "commit.gpgsign=false",
    "commit-tree", tree, "-p", branchHead, "-p", baseHead,
    "-m", `Merge ${base} into ${branch}\n\nomp-orchestrate landing refresh for PR #${unit.pr}; the reviewed diff against ${base} is unchanged.`,
   ], clone);
   const commit = committed?.code === 0 ? committed.stdout.trim() : "";
   if (!HEAD_RE.test(commit)) return "unknown";
   const pushed = await git(io, ["push", "--quiet", url, `${commit}:refs/heads/${branch}`], clone, GIT_FETCH_TIMEOUT_MS);
   if (pushed?.code !== 0) {
    await notice(io, unit.bead, `push:${pr.headRefOid}`, `BLOCKED landing: refresh of ${branch} from ${base} could not be pushed${pushed === null ? "" : `: ${pushed.stderr.trim()}`}`);
    return "blocked";
   }
   // The plugin moved the head, and by construction the diff against the base is the
   // reviewed one, so the reviewed head follows without a review round.
   await stamp(io, unit.bead.id, { head_sha: commit, refreshed_from: baseHead, refreshed_head: branchHead, landing_notice: "" });
   await comment(io, unit.bead.id, `NOTE landing refreshed ${branch} from ${base}@${short(baseHead)}: head ${short(branchHead)} -> ${short(commit)}; reviewed diff unchanged`);
   return "refreshed";
  }
  const { paths } = parseMergeTreeOutput(merge.stdout);
  if (paths.length === 0) {
   await notice(io, unit.bead, `merge-tree:${pr.headRefOid}`, `BLOCKED landing: merge-tree could not classify ${base} into ${branch} for PR #${unit.pr}: ${merge.stderr.trim()}`);
   return "blocked";
  }
  const origin = unit.origin === undefined ? null : await bdShow(unit.origin, undefined, io.cwd);
  const role = conflictRole(paths, scopeOf(metadataRecord(origin?.metadata)));
  return await bounce(io, unit, {
   role,
   reason: "conflict",
   title: `fix: resolve landing conflict for PR #${unit.pr}`,
   description: [
    `Landing of PR #${unit.pr} (${unit.repo}, branch ${branch}) is blocked: ${base}@${short(baseHead)} no longer merges cleanly into ${branch}@${short(branchHead)}.`,
    "",
    "Conflicting paths:",
    ...paths.map(file => `- ${file}`),
    "",
    role === "architect"
     ? `A conflicting path is outside the origin's scope, so the architect resolves it: merge origin/${base} on ${branch}, keep the reviewed behaviour, push, and re-review the new head.`
     : `Resolve on ${branch}: merge origin/${base}, keep the reviewed behaviour, push. The landing sweep resumes once this bead closes and the architect stamps the reviewed head_sha on ${unit.bead.id}.`,
   ].join("\n"),
  }, `${paths.length} conflicting path${paths.length === 1 ? "" : "s"}: ${paths.join(", ")}`);
 } finally {
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => { });
 }
}

// ============================================================================
// UNSTABLE: one rerun, then a fix bead
// ============================================================================

/**
 * A failing check at the reviewed head is rerun once per head; a second failure at the
 * same head is real and becomes an implementer fix bead carrying the check, its run
 * and the `--log-failed` pointer. A status context without a workflow run cannot be
 * rerun and goes straight to the fix bead.
 */
async function ciFailure(io: Io, unit: MergeUnit, pr: PrView, verdict: CheckVerdict): Promise<Outcome> {
 const rerunHead = metadataString(unit.bead, "ci_rerun_head");
 const runId = verdict.failing.map(entry => entry.runId).find((id): id is string => id !== undefined);
 if (rerunHead !== pr.headRefOid && runId !== undefined) {
  const rerun = await io.exec(["gh", "run", "rerun", runId, "--failed", "--repo", unit.repo], { cwd: io.cwd, timeoutMs: GH_WRITE_TIMEOUT_MS });
  if (rerun === null || rerun.code !== 0) {
   // The rerun is not spent by a gh that did not answer; the operator hears why.
   await notice(io, unit.bead, `rerun:${pr.headRefOid}`, `BLOCKED landing: gh run rerun ${runId} refused for PR #${unit.pr}${rerun === null ? "" : `: ${rerun.stderr.trim()}`}`);
   return "blocked";
  }
  const reruns = Number.parseInt(metadataString(unit.bead, "ci_reruns") ?? "0", 10);
  await stamp(io, unit.bead.id, { ci_rerun_head: pr.headRefOid, ci_reruns: String((Number.isFinite(reruns) ? reruns : 0) + 1) });
  await comment(io, unit.bead.id, `NOTE landing rerun ci: ${verdict.failing.map(entry => entry.name).join(", ")} run ${runId} at ${short(pr.headRefOid)}`);
  return "unstable";
 }
 const names = verdict.failing.map(entry => entry.name).join(", ");
 const lines = [
  `Landing of PR #${unit.pr} (${unit.repo}${unit.branch === undefined ? "" : `, branch ${unit.branch}`}) is blocked: ${verdict.failing.length === 1 ? "a check" : "checks"} failed at head ${pr.headRefOid}${rerunHead === pr.headRefOid ? " after one rerun" : ""}.`,
  "",
  ...verdict.failing.map(entry => `- ${entry.name}${entry.url === undefined ? "" : `: ${entry.url}`}`),
  "",
 ];
 if (runId !== undefined) lines.push(`Inspect with \`gh run view ${runId} --log-failed --repo ${unit.repo}\`.`);
 lines.push(`Fix on the branch, push, and let review re-stamp head_sha on ${unit.bead.id}; the landing sweep resumes once this bead closes.`);
 return await bounce(io, unit, {
  role: "implementer",
  reason: "ci",
  title: `fix: repair failing check ${names} for PR #${unit.pr}`,
  description: lines.join("\n"),
 }, `failing ${names} at ${short(pr.headRefOid)}`);
}

// ============================================================================
// Dispatch
// ============================================================================

/** Decide and act on one merge bead against its observed PR. */
async function sweepUnit(io: Io, unit: MergeUnit, pr: PrView, caps: LandingCapabilities): Promise<Outcome> {
 // A merged PR always carries its merge commit; one that does not yet is read again next sweep.
 if (pr.state === "MERGED") return pr.mergeCommit === undefined ? "unknown" : await landed(io, unit, pr, pr.mergeCommit);
 if (pr.state === "CLOSED") return await closedUnmerged(io, unit);
 if (pr.isDraft) return "draft";
 if (pr.headRefOid !== unit.head) {
  await notice(io, unit.bead, `head:${pr.headRefOid}`, `BLOCKED landing: PR #${unit.pr} head ${short(pr.headRefOid)} is not the reviewed head ${short(unit.head)}; re-review and stamp head_sha`);
  return "blocked";
 }
 const verdict = classifyChecks(pr.checks, caps.required_checks);
 switch (pr.mergeStateStatus) {
  case "UNKNOWN":
   return "unknown";
  case "DIRTY":
  case "BEHIND":
   return await resolveDirty(io, unit, pr);
  case "UNSTABLE":
  case "BLOCKED":
  case "CLEAN":
  case "HAS_HOOKS":
   if (verdict.state === "failing") return await ciFailure(io, unit, pr, verdict);
   if (pr.mergeStateStatus === "BLOCKED" && verdict.state === "green") {
    await notice(io, unit.bead, `rules:${pr.headRefOid}`, `BLOCKED landing: PR #${unit.pr} is blocked by branch rules at ${short(pr.headRefOid)} with checks green (approvals or conversation resolution)`);
    return "blocked";
   }
   return await attemptMerge(io, unit, pr, caps, verdict);
  default:
   return "unknown";
 }
}

export interface SweepEntry {
 bead: string;
 pr?: number;
 outcome: Outcome;
 detail?: string;
}

export interface SweepOptions {
 cwd: string;
 runId: string;
 exec?: Exec;
 now?: () => number;
}

/** Capabilities per repository, probed once per process for repositories the run epic does not record. */
const probed = new Map<string, LandingCapabilities>();

/** Test seam. */
export function resetLanding(): void {
 probed.clear();
}

async function capabilitiesFor(io: Io, repo: string, recorded: LandingCapabilities | undefined, base: string | undefined): Promise<LandingCapabilities> {
 if (recorded !== undefined && recorded.repo.toLowerCase() === repo.toLowerCase()) return recorded;
 const known = probed.get(repo.toLowerCase());
 if (known !== undefined) return known;
 const probe = await probeLandingCapabilities(repo, base ?? recorded?.base ?? "main", io.exec, io.cwd, io.now);
 // An unprobeable repository is landed directly and only on CLEAN: the mode that
 // needs no capability to be safe.
 const caps: LandingCapabilities = probe.ok
  ? probe.caps
  : { repo, base: base ?? "main", mode: "direct", auto_merge_allowed: false, squash_allowed: true, required_checks: [], strict: false, queue: false, probed_at: new Date(io.now()).toISOString() };
 probed.set(repo.toLowerCase(), caps);
 return caps;
}

let sweepInFlight = false;

/**
 * One sweep: every open, unblocked merge bead with a PR, polled once per repository,
 * dispatched per the state table. Reads are budgeted like any dispatch; an unreadable
 * bead list or blocked list ends the sweep with nothing written.
 */
export async function landingSweep(options: SweepOptions): Promise<SweepEntry[]> {
 if (sweepInFlight) return [];
 sweepInFlight = true;
 try {
  return await sweepOnce(options);
 } finally {
  sweepInFlight = false;
 }
}

async function sweepOnce(options: SweepOptions): Promise<SweepEntry[]> {
 const io: Io = { exec: options.exec ?? spawnExec, cwd: options.cwd, now: options.now ?? Date.now };
 resetReadBudget();
 const beads = await bdListChecked(["list", "--label", "pr:merge", "--status", "open,in_progress", "--limit", "0", "--json"], undefined, io.cwd);
 if (beads === null || beads.length === 0) return [];
 const blocked = await bdBlockedChecked(undefined, io.cwd);
 if (blocked === null) return [];
 const epic = await bdShow(options.runId, undefined, io.cwd);
 const recorded = recordedCapabilities(epic);

 const entries: SweepEntry[] = [];
 const units = new Map<string, MergeUnit[]>();
 for (const bead of beads) {
  if (blocked.includes(bead.id) || metadataString(bead, "landing_state") === "landed") {
   entries.push({ bead: bead.id, outcome: "skipped" });
   continue;
  }
  const parsed = mergeUnit(bead);
  if ("missing" in parsed) {
   const fields = parsed.missing.join(", ");
   await notice(io, bead, `missing:${fields}`, `BLOCKED landing: merge bead ${bead.id} lacks metadata ${fields}; the sweep cannot land it`);
   entries.push({ bead: bead.id, outcome: "blocked", detail: `missing ${fields}` });
   continue;
  }
  const group = units.get(parsed.unit.repo) ?? [];
  group.push(parsed.unit);
  units.set(parsed.unit.repo, group);
 }

 for (const [repo, group] of units) {
  const listed = await ghJson(io.exec, prListArgv(repo), io.cwd);
  const open = new Map<number, PrView>();
  for (const raw of Array.isArray(listed) ? listed : []) {
   const view = prView(raw);
   if (view !== undefined) open.set(view.number, view);
  }
  for (const unit of group) {
   let pr = open.get(unit.pr);
   if (pr === undefined && listed !== undefined) pr = prView(await ghJson(io.exec, prViewArgv(repo, unit.pr), io.cwd));
   if (pr === undefined) {
    entries.push({ bead: unit.bead.id, pr: unit.pr, outcome: "unknown", detail: "gh did not answer" });
    continue;
   }
   const caps = await capabilitiesFor(io, repo, recorded, pr.baseRefName);
   try {
    entries.push({ bead: unit.bead.id, pr: unit.pr, outcome: await sweepUnit(io, unit, pr, caps) });
   } catch (error) {
    entries.push({ bead: unit.bead.id, pr: unit.pr, outcome: "unknown", detail: error instanceof Error ? error.message : String(error) });
   }
  }
 }
 return entries;
}
