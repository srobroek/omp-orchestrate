/**
 * Claim leases: `metadata.lease_until` on the claimed bead, renewed by the plugin.
 *
 * One carrier. The bead already holds the claim, so it holds the lease too; there is no
 * heartbeat wisp, no patrol wisp, and agents write nothing. Every write here is fenced by
 * `bd update --claim` under the holder's actor: bd refuses it, exit 1 and no side effect,
 * when anyone else holds the bead, so only the holder can extend a lease and a release
 * loses to a successor's claim. That fence conditions on the assignee, not on a lease
 * version (bd 1.2.2 has no metadata compare-and-swap), which bounds the worst case of a
 * wrong release rather than preventing it: a live holder released in error re-claims on
 * its next renewal (one stray `RECOVERED`), or loses to a new claimant and is stopped by
 * G2's ownership check. Who may call {@link releaseDeadClaim}, and on what evidence, is
 * the reaper's contract (`src/supervision.ts`), not this module's.
 *
 * Expiry is `max(lease_until, updated_at + TTL) < now`: `--claim` bumps `updated_at` and
 * `bd comment` does not, so a claim that was never renewed still expires TTL after it was
 * taken, and no bead needs a backfilled lease. Callers deciding on expiry read the bead
 * with `fresh: true` (`src/bd.ts`).
 *
 * `--claim` refuses a `blocked` or `deferred` bead (`issue not claimable: status
 * blocked`, measured), so the fence is available only for `open` and `in_progress`
 * claims. A dead holder's blocked bead keeps its claim and gets a NOTE; `bd ready` never
 * offers a blocked bead, so the held claim costs nothing until a human unblocks it.
 *
 * Measurement (bd 1.2.2, embedded sandbox, 2026-09-12). A fenced renewal with
 * `--dolt-auto-commit off` took 0.57-0.60 s, added no Dolt commit (`bd history` 7 -> 7
 * over three renewals) and still moved both halves of the store token: the journal grew
 * 1294349 -> 1302823 -> 1312110 bytes and the manifest `lock:root` was rewritten each
 * time, so the read cache's invariants (`src/bd.ts` I1-I5) hold and every reader sees the
 * new lease. With auto-commit on: 0.59-0.72 s and one commit per renewal. Renewals and
 * releases therefore run with auto-commit off; the next ordinary write commits them.
 * The same renewal as a non-holder: exit 1 `issue already claimed by <holder>`, metadata
 * unchanged. The release as a non-holder: the same refusal; as the holder: success, and a
 * harmless re-release when the bead is already free.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AgentRegistry, type ExtensionAPI, type ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { type BdBead, bdListChecked, bdRun, metadataString } from "./bd";
import type { ClaimState } from "./claim-state";
import { sessionRole } from "./identity";

const DEFAULT_TTL_MS = 15 * 60_000;
const DEFAULT_RENEW_MS = 5 * 60_000;

/** Wall-clock ceiling for a lease write: an ordinary `bd update` plus the store lock. */
const WRITE_TIMEOUT_MS = 20_000;

function positiveMs(name: string, fallback: number): number {
 const configured = Number(process.env[name]);
 return Number.isFinite(configured) && configured > 0 ? configured : fallback;
}

/** How long a claim lives without renewal: `ORC_LEASE_TTL_MS`, or 15 minutes. */
export function leaseTtlMs(): number {
 return positiveMs("ORC_LEASE_TTL_MS", DEFAULT_TTL_MS);
}

/** How often activity renews a held lease: `ORC_LEASE_RENEW_MS`, or 5 minutes. */
export function leaseRenewMs(): number {
 return positiveMs("ORC_LEASE_RENEW_MS", DEFAULT_RENEW_MS);
}

/** `now + TTL` as bd stores it. */
export function leaseUntil(now: number, ttlMs = leaseTtlMs()): string {
 return new Date(now + ttlMs).toISOString();
}

/** What bd prints when the claim fence refuses a write; an outage or another error reads differently. */
const FENCE_REFUSAL = /already claimed by/i;

/** Whether a failed `bd update --claim` was the fence, not an outage or another error. */
export function fenceRefused(result: { stdout: string; stderr: string }): boolean {
 return FENCE_REFUSAL.test(result.stderr) || FENCE_REFUSAL.test(result.stdout);
}

export type RenewOutcome = "renewed" | "held-by-other" | "failed";

/**
 * Extend `holder`'s lease on `bead` to `now + TTL`, fenced on the claim.
 *
 * `held-by-other` is the fence: another actor holds the bead, so this holder has been
 * displaced. `failed` is everything else, an unreachable store or an unclaimable status,
 * and says nothing about ownership.
 */
export async function renewLease(bead: string, holder: string, now = Date.now(), cwd?: string): Promise<RenewOutcome> {
 const result = await bdRun([
  "update", bead, "--actor", holder, "--claim",
  "--set-metadata", `lease_until=${leaseUntil(now)}`,
  "--dolt-auto-commit", "off",
 ], WRITE_TIMEOUT_MS, cwd);
 if (result === null) return "failed";
 if (result.code === 0) return "renewed";
 return fenceRefused(result) ? "held-by-other" : "failed";
}

/** Epoch ms of an RFC3339 field, or `undefined` when absent or unparseable. */
function instant(value: string | undefined): number | undefined {
 if (value === undefined || value === "") return undefined;
 const parsed = Date.parse(value);
 return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * When `bead`'s lease lapses: the later of `metadata.lease_until` and `updated_at + TTL`.
 * `undefined` when the bead carries neither, which no expiry decision may read as lapsed.
 */
export function leaseDeadline(bead: BdBead, ttlMs = leaseTtlMs()): number | undefined {
 const renewed = instant(metadataString(bead, "lease_until"));
 const updated = instant(typeof bead.updated_at === "string" ? bead.updated_at : undefined);
 const implied = updated === undefined ? undefined : updated + ttlMs;
 if (renewed === undefined) return implied;
 if (implied === undefined) return renewed;
 return Math.max(renewed, implied);
}

/** Whether `bead`'s lease has lapsed at `now`. An unknown deadline is never lapsed. */
export function leaseExpired(bead: BdBead, now: number): boolean {
 const deadline = leaseDeadline(bead);
 return deadline !== undefined && deadline < now;
}

/** The lease as a NOTE states it: lapsed, live, or unknowable. */
export function leaseState(bead: BdBead, now: number): string {
 const deadline = leaseDeadline(bead);
 if (deadline === undefined) return "lease unknown (no lease_until or updated_at)";
 const at = new Date(deadline).toISOString();
 return deadline < now ? `lease lapsed at ${at}` : `lease live until ${at}`;
}

/** What a release records beside the transition. */
export interface ReleaseEvidence {
 /** Why the holder is dead, as the `RECOVERED` comment states it. */
 cause: string;
 /** The identity releasing, stamped as `metadata.recovered_by` and authoring the comment. */
 recoveredBy: string;
 /** The holder's captured branch, when the repository showed one; stamped as `recovered_branch`. */
 branch?: string;
 /**
  * Observations appended to the comment after the cause. A caller that made none (the
  * lease sweep, which has no child frame to judge) leaves this out, and the release looks
  * up the holder's `omp/task/<holder>` capture in `cwd` itself, so every `RECOVERED` names
  * the branch a replacement should look at, whichever path released the claim.
  */
 observations?: readonly string[];
}

export type ReleaseOutcome = "released" | "held-by-other" | "failed" | "comment-failed";

const execFileAsync = promisify(execFile);

/**
 * What the repository at `cwd` shows for the holder's capture: the branch name when
 * `refs/heads/omp/task/<holder>` exists, with its tip's committer date so a reader can
 * tell a leftover from an earlier run apart from this claim's work, and a hedged
 * observation either way. The reaper (`src/supervision.ts`) makes the same observation
 * with the child's start time in hand; this is the sweep's version, without one.
 */
export async function capturedBranchEvidence(holder: string, cwd: string): Promise<{ branch?: string; observation: string }> {
 const name = `omp/task/${holder}`;
 try {
  const { stdout } = await execFileAsync(
   "git", ["-C", cwd, "for-each-ref", "--format=%(committerdate:iso-strict)", `refs/heads/${name}`],
   { timeout: 5_000, maxBuffer: 4096 },
  );
  const tip = stdout.trim();
  if (tip.length === 0) return { observation: "no captured branch observed (not proof of no work)" };
  return { branch: name, observation: `captured branch observed: ${name} (tip committed ${tip}; verify it postdates this claim)` };
 } catch {
  return { observation: "captured branch unknown" };
 }
}

/**
 * Release a dead holder's claim: the fenced transition to `open` and unassigned, then one
 * `RECOVERED` comment. Requeue is implicit, because an open unassigned bead is what
 * `bd ready --claim` offers.
 *
 * `held-by-other`: the fence refused, a successor holds the bead, and nothing was written.
 * `failed`: the store did not answer or refused for another reason; nothing was written.
 * `comment-failed`: the claim is released but the comment did not land; the caller says so.
 * Nothing here touches `metadata.worktree`, branches, or captured refs.
 */
export async function releaseDeadClaim(bead: string, holder: string, evidence: ReleaseEvidence, cwd?: string): Promise<ReleaseOutcome> {
 let { branch, observations } = evidence;
 if (observations === undefined) {
  const capture = await capturedBranchEvidence(holder, cwd ?? process.cwd());
  branch ??= capture.branch;
  observations = [capture.observation];
 }
 const args = [
  "update", bead, "--actor", holder, "--claim", "--assignee", "", "--status", "open",
  "--set-metadata", `recovered_by=${evidence.recoveredBy}`,
 ];
 if (branch !== undefined) args.push("--set-metadata", `recovered_branch=${branch}`);
 args.push("--dolt-auto-commit", "off");
 const released = await bdRun(args, WRITE_TIMEOUT_MS, cwd);
 if (released === null) return "failed";
 if (released.code !== 0) {
  return fenceRefused(released) ? "held-by-other" : "failed";
 }

 const text = [`RECOVERED ${holder} ${evidence.cause}`, ...observations].join("; ");
 const commented = await bdRun(["comment", bead, text, "--actor", evidence.recoveredBy], WRITE_TIMEOUT_MS, cwd);
 return commented?.code === 0 ? "released" : "comment-failed";
}

// ============================================================================
// Renewal on activity and on the clock
// ============================================================================

/**
 * Renews what this session holds, at most once per cadence per lease, from two sources:
 * activity (`touch`, after a gated tool call passes) and the minute timer (`tick`, from
 * `src/watchers.ts`). Both share one cadence, so a lease is written once per
 * `ORC_LEASE_RENEW_MS` however it was reached.
 *
 * The timer is what makes a lease mean liveness. Renewal on activity alone let a lead in
 * one long tool call, or a lead idle between prompts, lapse while its process lived, and
 * `/orchestrate-status` advised adopting a run whose lead was alive (E2E D-normal-ts-06,
 * D-crash-recovery-02). With the timer, a lapsed lease says no live session renews it.
 */
export interface LeaseRenewer {
 /** Called after a gated tool call passes. Never awaits bd; the tool runs regardless. */
 touch(ctx: ExtensionContext, now?: number): void;
 /**
  * Called from the sweep timer while the session lives. Awaits its writes. Renews this
  * session's own leases and, from the lead's seat, the claims of children the registry
  * reports parked: a parked child's session is disposed, so no timer of its own runs,
  * yet it is revivable and keeps its claim by the reaper's contract. Reports whether this
  * session holds the lead lease, which is what licenses the lapsed-claim sweep.
  */
 tick(ctx: ExtensionContext, now?: number): Promise<{ leadsRun: boolean }>;
}

/** What one lead-lease renewal did. `run` names the epic when the marker bound one. */
export interface LeadLeaseRenewal {
 outcome: RenewOutcome | "no-run";
 actor: string;
 run?: string;
}

/** The lead's renewal: `run-state.ts` owns the marker and the epic, this module the cadence. */
export type LeadLeaseRenew = (cwd: string, sessionId: string, now: number) => Promise<LeadLeaseRenewal>;

/** The registry rows the timer reads: which spawned agents are parked. `AgentRegistry.global()` answers it. */
export interface ParkedRegistry {
 list(): ReadonlyArray<{ id: string; kind: string; status: string }>;
}

/** The lead lease is one per session, keyed apart from any bead id. */
const LEAD_KEY = "\u0000lead";

/**
 * Cadence is per lease, not per call: a worker holding one bead renews it once per
 * `ORC_LEASE_RENEW_MS` however many tools it runs, and a session that holds nothing and
 * leads nothing costs one map lookup. A worker renews each bead its claim observation
 * names; the lead renews the run epic's lease through `renewLead`.
 *
 * Outcomes are reported, never acted on: a displaced worker is told, and G2's ownership
 * check refuses its next write on the bead; a displaced lead is told another session
 * holds the run.
 */
export function createLeaseRenewer(
 pi: ExtensionAPI,
 claims: ClaimState,
 renewLead: LeadLeaseRenew,
 registry: ParkedRegistry = AgentRegistry.global(),
): LeaseRenewer {
 const last = new Map<string, number>();
 let leadsRun = false;

 const due = (key: string, now: number): boolean => {
  const previous = last.get(key);
  if (previous !== undefined && now - previous < leaseRenewMs()) return false;
  last.set(key, now);
  return true;
 };

 const report = (kind: "claim" | "lead", subject: string, holder: string, outcome: RenewOutcome | "no-run"): void => {
  if (kind === "lead") leadsRun = outcome === "renewed";
  if (outcome === "renewed" || outcome === "no-run") return;
  if (outcome === "held-by-other") {
   pi.logger.warn(`orchestrate ${kind} lease renewal refused: held by another actor`, { subject, holder });
   pi.sendMessage({
    customType: "orchestrate-lease",
    content: kind === "claim"
     ? `Your claim on ${subject} is now held by another actor: the lease renewal as ${holder} was refused. Stop writing to ${subject}; the worktree-scope gate refuses edits on a bead you no longer hold. Pull again for new work.`
     : `The run epic ${subject} is leased to another lead session; this session's renewal as ${holder} was refused. Only one lead may drive a run. /orchestrate-resume adopts a run whose lead lease has lapsed.`,
    display: true,
   }, { triggerTurn: false });
   return;
  }
  pi.logger.info(`orchestrate ${kind} lease not renewed`, { subject, holder, outcome });
 };

 /** Every renewal this session owes at `now`, started; the lead's is last so its standing is current. */
 const renewals = (ctx: ExtensionContext, now: number): Promise<void>[] => {
  const pending: Promise<void>[] = [];
  const claim = claims.observedClaim();
  if (claim !== undefined) {
   for (const bead of claim.beadIds) {
    if (!due(bead, now)) continue;
    pending.push(renewLease(bead, claim.actor, now, ctx.cwd)
     .then(outcome => report("claim", bead, claim.actor, outcome))
     .catch((error: unknown) => pi.logger.error("orchestrate lease renewal threw", { bead, error: String(error) })));
   }
  }
  if (sessionRole(pi) === "lead" && due(LEAD_KEY, now)) {
   pending.push(renewLead(ctx.cwd, ctx.sessionManager.getSessionId(), now)
    .then(renewed => report("lead", renewed.run ?? "run", renewed.actor, renewed.outcome))
    .catch((error: unknown) => pi.logger.error("orchestrate lead lease renewal threw", { error: String(error) })));
  }
  return pending;
 };

 /** The claims of every parked child, renewed under each child's own actor, once per cadence per child. */
 const renewParked = async (ctx: ExtensionContext, now: number): Promise<void> => {
  for (const ref of registry.list()) {
   if (ref.kind !== "sub" || ref.status !== "parked" || !due(`\u0000parked:${ref.id}`, now)) continue;
   const held = await bdListChecked(["list", "--include-infra", "--assignee", ref.id, "--status", "in_progress", "--limit", "0", "--json"], undefined, ctx.cwd);
   if (held === null) {
    pi.logger.info("orchestrate parked child's claims unread; leases not renewed", { child: ref.id });
    continue;
   }
   for (const bead of held) report("claim", bead.id, ref.id, await renewLease(bead.id, ref.id, now, ctx.cwd));
  }
 };

 // Nothing in here may reach the tool_call handler: a thrown renewal would fail the gate
 // open and log a gate failure for what is bookkeeping. Every path swallows and logs.
 return {
  touch(ctx, now = Date.now()): void {
   try {
    renewals(ctx, now);
   } catch (error) {
    pi.logger.error("orchestrate lease renewal threw", { error: String(error) });
   }
  },
  async tick(ctx, now = Date.now()): Promise<{ leadsRun: boolean }> {
   try {
    await Promise.all(renewals(ctx, now));
    if (sessionRole(pi) === "lead") await renewParked(ctx, now);
   } catch (error) {
    pi.logger.error("orchestrate lease renewal threw", { error: String(error) });
   }
   return { leadsRun };
  },
 };
}
