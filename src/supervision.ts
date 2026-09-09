/**
 * S1 observes terminal children and records recovery-needed evidence for the architect.
 * Beads has no conditional owner/version update: releasing or stamping from a snapshot
 * can overwrite a successor. This module therefore never changes ownership or metadata.
 * S2 creates a run-derived patrol id, relying on database id uniqueness.
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { type BdBead, bdListChecked, bdRun, bdWispListChecked, resetReadBudget } from "./bd";
import architect from "./contracts/architect.json";
import generic from "./contracts/generic.json";
import implementer from "./contracts/implementer.json";
import researcher from "./contracts/researcher.json";
import reviewer from "./contracts/reviewer.json";
import shepherd from "./contracts/shepherd.json";
import { applies, collectExitEvidence, completionKindSupported, contractPaused, resourceKind, satisfies } from "./gates/exit";
import { beadRouting } from "./identity";

/** The `task:subagent:lifecycle` fields this module reads. */
export interface ChildLifecycle {
 id: string;
 /** `started | completed | failed | aborted`, as the executor emits it. */
 status: string;
}

/** Statuses that end a child. `started` is the only other value the bus emits. */
const TERMINAL: Record<string, true> = { aborted: true, completed: true, failed: true };

/** A finished subprocess. `null` from an {@link Exec} means it never ran at all. */
export interface ExecResult {
 code: number;
 stdout: string;
 stderr: string;
}

/**
 * The subprocess seam: one argv, one working directory, never a throw.
 *
 * Exported so tests can answer `git` without a repository, and so a caller that
 * already has a git runner can pass it instead of paying for a second spawn path.
 */
export type Exec = (argv: string[], cwd: string) => Promise<ExecResult | null>;

/** Wall-clock ceiling per git call. Both queries are local ref reads. */
const TIMEOUT_MS = 15_000;

/** The default {@link Exec}. Mirrors `bd.ts`: every failure resolves to `null`. */
const spawnExec: Exec = async (argv, cwd) => {
 const [bin, ...args] = argv;
 if (bin === undefined) return null;
 try {
  const proc = Bun.spawn([bin, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), TIMEOUT_MS);
  try {
   const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
   ]);
   return { code, stdout, stderr };
  } finally {
   clearTimeout(timer);
  }
 } catch {
  return null;
 }
};

/** Non-empty, trimmed lines of a git listing. */
function lines(stdout: string): string[] {
 const out: string[] = [];
 for (const raw of stdout.split("\n")) {
  const line = raw.trim();
  if (line !== "") out.push(line);
 }
 return out;
}

/** Which row of the reclamation table one bead took. */
export type ReapCase = "clean" | "incomplete" | "died-with-work" | "died-without-work" | "unknown" | "paused";

/** One bead's disposition. `failures` names the contract checks it did not satisfy. */
export interface ReapedBead {
 bead: string;
 case: ReapCase;
 failures: string[];
 /** Observation only: no claim has been recovered. */
 recovery: "not-needed" | "recorded" | "record-failed";
}

/** What one terminal event did. `reaped` is empty when there was nothing to reap. */
export interface ReapOutcome {
 child: string;
 /** The captured branch, when the repository has one for this child. */
 branch?: string;
 branchState?: "found" | "absent" | "unknown";
 discoveryUnknown?: boolean;
 reaped: ReapedBead[];
}

export interface ReapOptions {
 /** The repository the captured branches live in — the spawning session's cwd. */
 cwd: string;
 /** Subprocess seam; defaults to spawning `git`. */
 exec?: Exec;
}

/** Observe a terminal child's candidates without asserting authority over their current state. */
export async function reapChild(child: ChildLifecycle, options: ReapOptions): Promise<ReapOutcome> {
 const outcome: ReapOutcome = { child: child.id, reaped: [] };
 if (TERMINAL[child.status] !== true) return outcome;

 // The reaper runs off a bus event, so nothing has reset the per-turn read budget
 // for it. Left exhausted by the turn's gates, the contract re-check would read
 // zero comments and report every clean exit as an incompletion.
 resetReadBudget();

 const { beads: candidates, unknown } = await candidateBeads(child);
 if (unknown) outcome.discoveryUnknown = true;
 if (candidates.length === 0) return outcome;

 const branch = await capturedBranch(child.id, options);
 outcome.branchState = branch === null ? "unknown" : branch === undefined ? "absent" : "found";
 if (typeof branch === "string") outcome.branch = branch;

 for (const bead of candidates) {
  outcome.reaped.push(await reapBead(bead, child, branch));
 }
 return outcome;
}

/** Ordinary lists exclude wisps; query both carriers and merge by id. */
async function candidateBeads(child: ChildLifecycle): Promise<{ beads: BdBead[]; unknown: boolean }> {
 const flags = ["--include-infra", "--include-gates", "--status", "open,in_progress,blocked,deferred", "--limit", "0", "--json"];
 const claimed = await bdListChecked(["list", "--assignee", child.id, ...flags]);
 const wisps = await bdWispListChecked();
 const stamped = child.status === "completed"
  ? await bdListChecked(["list", "--metadata-field", `actor=${child.id}`, ...flags])
  : [];
 const beads = new Map<string, BdBead>();
 for (const bead of [...(claimed ?? []), ...(wisps ?? []), ...(stamped ?? [])]) {
  if (!["open", "in_progress", "blocked", "deferred"].includes(bead.status ?? "")) continue;
  const assignee = typeof bead.assignee === "string" ? bead.assignee : "";
  if (assignee !== "" && assignee !== child.id) continue;
  if (assignee !== child.id && !(child.status === "completed" && bead.metadata?.actor === child.id)) continue;
  beads.set(bead.id, bead);
 }
 return { beads: [...beads.values()], unknown: claimed === null || wisps === null || stamped === null };
}

/** Append observations only; even a fresh read cannot authorize an unconditional update. */
async function reapBead(bead: BdBead, child: ChildLifecycle, branch: string | undefined | null): Promise<ReapedBead> {
 const failures = child.status === "completed" ? await contractFailures(bead) : [];
 const claimHeld = typeof bead.assignee === "string" && bead.assignee !== "";
 const disposition: ReapCase = child.status !== "completed"
  ? branch === null ? "unknown" : branch === undefined ? "died-without-work" : "died-with-work"
  : failures === "paused" ? "paused" : failures === null ? "unknown" : failures.length === 0 && !claimHeld ? "clean" : "incomplete";
 if (disposition === "clean" && branch === undefined) {
  return { bead: bead.id, case: disposition, failures: [], recovery: "not-needed" };
 }
 const branchEvidence = branch === null ? "captured branch unknown"
  : branch === undefined ? "no captured branch observed (not proof of no work)" : `captured branch observed: ${branch}`;
 const contractEvidence = failures === "paused" ? "paused on open escalation; preserve claim until architect resolves escalation"
  : failures === null ? "contract evidence unknown"
   : failures.length > 0 ? `unsatisfied checks: ${failures.join(", ")}` : `contract disposition: ${disposition}`;
 const routing = beadRouting(bead);
 const carrier = routing?.from === "legacy-label" ? `; contract from legacy ${routing.spelling}` : "";
 const result = await bdRun(["comment", bead.id,
  `NOTE recovery needed: child ${child.id} exited (${child.status}); observed assignee=${bead.assignee ?? ""}, status=${bead.status ?? ""}; ${contractEvidence}; ${branchEvidence}${carrier}; architect must establish an exclusive recovery window excluding all claim/dispatch writers before re-checking ownership and making any recovery mutation; no owner, status, or metadata changed`]);
 return {
  bead: bead.id,
  case: disposition,
  failures: Array.isArray(failures) ? failures : [],
  recovery: result?.code === 0 ? "recorded" : "record-failed",
 };
}

/**
 * Exact captured branch, undefined for a successful absent lookup, null for unknown.
 * Absence does not prove that a failed child produced no work or that its delta survived.
 *
 * The glob is queried but only the exact name is accepted: ids are free-form, so
 * `omp/task/impl-7*` also matches child `impl-70`'s branch, and attributing another
 * child's commits to this bead is worse than recording no branch at all.
 */
async function capturedBranch(id: string, options: ReapOptions): Promise<string | undefined | null> {
 const exec = options.exec ?? spawnExec;
 const wanted = `omp/task/${id}`;
 const result = await exec(["git", "branch", "--list", `${wanted}*`], options.cwd);
 if (result === null || result.code !== 0) return null;
 for (const line of lines(result.stdout)) {
  // `git branch --list` marks the checked-out branch `*` and one checked out in
  // another worktree `+`.
  if (line.replace(/^[*+]\s*/, "") === wanted) return wanted;
 }
 return undefined;
}

/**
 * Whether `taskBranch`'s commits are already in `feature`.
 *
 * Integration is cherry-pick, so ancestry proves nothing and patch-id containment is
 * the only sound test: `git cherry` prints `-` for each commit whose patch is already
 * upstream and `+` for each one that is not. No output means nothing is missing
 * upstream, which is the integrated answer for a replayed or empty branch.
 *
 * Anything else — an unreadable repository, an unknown ref, a line in neither form —
 * is `"unknown"`, never `"integrated"`. Callers delete branches on this answer.
 */
export async function branchIntegrated(
 feature: string,
 taskBranch: string,
 cwd: string,
 exec: Exec = spawnExec,
): Promise<"integrated" | "pending" | "unknown"> {
 const result = await exec(["git", "cherry", feature, taskBranch], cwd);
 if (result === null || result.code !== 0) return "unknown";
 const marks = lines(result.stdout);
 if (marks.some(mark => mark.startsWith("+"))) return "pending";
 return marks.every(mark => mark.startsWith("-")) ? "integrated" : "unknown";
}

/** The `require` predicates a role's exit is checked against. */
interface CompletionCheck {
 check: string;
 require: string;
 when?: string | string[];
}

/** The two clauses the reaper reads. The gate owns the rest of the contract. */
interface RoleContract {
 completion?: CompletionCheck[];
 escape?: { state?: string; require?: string };
 pause?: string[];
}

/** Contracts and evidence evaluation are shared with the exit gate. */
const CONTRACTS: Record<string, RoleContract> = {
 architect,
 implementer,
 researcher,
 reviewer,
 shepherd,
 generic,
};

/** Re-check supported completion contracts without converting unread evidence into failure. */
async function contractFailures(bead: BdBead): Promise<string[] | "paused" | null> {
 const role = beadRouting(bead)?.role ?? "generic";
 const contract: RoleContract = Object.hasOwn(CONTRACTS, role) ? (CONTRACTS[role] ?? generic) : generic;
 const evidence = await collectExitEvidence(bead);
 if (evidence === null) return null;
 if (!completionKindSupported(role, bead)) return ["unsupported-resource"];
 if (contractPaused(contract, evidence)) return "paused";
 const status = (bead.status ?? "").toLowerCase();

 // A declared failure is a valid exit, not an incompletion.
 if (contract.escape?.state === status) {
  if (contract.escape.require === undefined || satisfies(contract.escape.require, evidence)) return [];
 }

 const kind = resourceKind(bead);
 const failures: string[] = [];
 for (const check of contract.completion ?? []) {
  if (applies(check, kind) && !satisfies(check.require, evidence)) failures.push(check.check);
 }
 return failures;
}


/** Local calls share a lookup; database id uniqueness arbitrates cross-process creation. */
const patrolChecks = new Map<string, Promise<void>>();

export async function ensurePatrolWisp(epicId: string, cwd?: string): Promise<void> {
 const key = JSON.stringify([cwd ?? process.cwd(), epicId]);
 const existing = patrolChecks.get(key);
 if (existing !== undefined) return existing;
 const check = (async () => {
  const query = ["dep", "list", epicId, "--direction=up", "--type", "relates-to", "--json"];
  const linked = await bdListChecked(query, undefined, cwd);
  if (linked === null) throw new Error(`Patrol ${epicId} lookup unknown; creation refused`);
  const id = `${epicId}-patrol`;
  const live = (bead: BdBead) => bead.wisp_type === "patrol" && bead.ephemeral === true
   && ["open", "in_progress", "blocked", "deferred"].includes(bead.status ?? "")
   && (bead.id !== id || bead.metadata?.patrol_epic === epicId);
  if (linked.some(live)) return;
  if (linked.some(bead => bead.id === id)) {
   throw new Error(`Patrol ${id} is closed or invalid; architect must reconcile it before rearming`);
  }
  // No overwrite or generation rollover: a closed deterministic id remains a
  // tombstone until the architect decides how to resume this run's patrol.
  await bdRun(["create", `patrol: ${epicId} claim reconciliation`, "--id", id,
   "--ephemeral", "--wisp-type", "patrol", "--metadata", JSON.stringify({ patrol_epic: epicId }),
   "--deps", `relates-to:${epicId}`, "--silent"], undefined, cwd);
  // Success and conflict both need positive durable evidence, including the
  // relation to this epic. A failed/partial create is never called armed.
  const confirmed = await bdListChecked(query, undefined, cwd);
  if (!confirmed?.some(bead => bead.id === id && live(bead) && bead.metadata?.patrol_epic === epicId)) {
   throw new Error(`Patrol ${id} not confirmed; architect must inspect/provision the patrol for ${epicId}`);
  }
 })();
 patrolChecks.set(key, check);
 try {
  await check;
 } finally {
  patrolChecks.delete(key);
 }
}

/** Bind the reaper to the lifecycle bus for repositories with an active run. */
export function registerSupervision(pi: ExtensionAPI, isRunBound: (cwd: string) => Promise<boolean>): void {
	let cwd: string | undefined;
	let unsubscribe: (() => void) | undefined;

	pi.on("session_start", (_event, ctx) => {
		cwd = ctx.cwd;
		// `session_start` fires again on a switch or branch. Keep one listener and
		// let it read the current cwd rather than capturing a stale repository.
		unsubscribe ??= pi.events.on("task:subagent:lifecycle", data => {
			const currentCwd = cwd;
			if (currentCwd === undefined) return;
			return handleLifecycle(pi, data, currentCwd, isRunBound);
		});
	});
	pi.on("session_shutdown", () => {
		unsubscribe?.();
		unsubscribe = undefined;
		cwd = undefined;
	});
}

/** Reap one bus payload, reporting what it did and swallowing what it could not. */
async function handleLifecycle(
	pi: ExtensionAPI,
	data: unknown,
	cwd: string,
	isRunBound: (cwd: string) => Promise<boolean>,
): Promise<void> {
	const child = asLifecycle(data);
	if (child === null || TERMINAL[child.status] !== true) return;
	resetReadBudget();
	try {
		if (!await isRunBound(cwd)) return;
	} catch (error) {
		pi.logger.error("orchestrate run liveness check unavailable; recovery skipped", {
			child: child.id,
			error: error instanceof Error ? error.message : String(error),
		});
		return;
	}
	try {
		const outcome = await reapChild(child, { cwd });
		if (outcome.discoveryUnknown) pi.logger.warn("orchestrate recovery candidate discovery incomplete", { child: child.id });
		for (const reaped of outcome.reaped) {
			pi.logger.info("orchestrate recovery observation", {
				child: child.id,
				bead: reaped.bead,
				case: reaped.case,
				branch: outcome.branch,
				failures: reaped.failures,
				recovery: reaped.recovery,
				branchState: outcome.branchState,
			});
			if (reaped.recovery !== "not-needed") {
				pi.sendMessage({
					customType: "orchestrate-recovery-needed",
					content: `Recovery observation for ${reaped.bead}, child ${child.id}: ${reaped.case}; NOTE ${reaped.recovery}; branch=${outcome.branch ?? outcome.branchState ?? "unknown"}. No claim or metadata changed. Architect: inspect current bead and branch evidence; establish an exclusive recovery window excluding all dispatch/claim writers before any recovery mutation. Paused work must wait for escalation resolution. Failed NOTE persistence requires explicit reconciliation; this is not a recovery success.`,
					display: true,
				}, { triggerTurn: false });
			}
		}
		if (outcome.discoveryUnknown) {
			pi.sendMessage({
				customType: "orchestrate-recovery-needed",
				content: `Recovery discovery for child ${child.id} is incomplete. Architect: explicitly reconcile ordinary and ephemeral claims after storage is readable; nothing was released. Establish an exclusive recovery window before any mutation.`,
				display: true,
			}, { triggerTurn: false });
		}
	} catch (error) {
		// The bus contains a rejected handler but reports it as an anonymous event
		// error; naming the reaper is what makes a silent reclamation diagnosable.
		pi.logger.error("orchestrate reaper failed open", {
			child: child.id,
			error: error instanceof Error ? error.message : String(error),
		});
		pi.sendMessage({
			customType: "orchestrate-recovery-needed",
			content: `Recovery observation failed for child ${child.id}. Architect must explicitly reconcile its claims and evidence; no automatic recovery is confirmed. Exclude all claim/dispatch writers before any recovery mutation.`,
			display: true,
		}, { triggerTurn: false });
	}
}

/** The lifecycle payload narrowed to the fields this module reads. */
function asLifecycle(data: unknown): ChildLifecycle | null {
 if (data === null || typeof data !== "object") return null;
 if (!("id" in data) || typeof data.id !== "string" || data.id.length === 0) return null;
 if (!("status" in data) || typeof data.status !== "string") return null;
 return { id: data.id, status: data.status };
}
