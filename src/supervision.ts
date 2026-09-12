/**
 * S1 reaps terminal children. On a child's terminal lifecycle frame it finds the beads the
 * child holds, re-checks the exit contract, and either releases the dead holder's claim
 * under the lease (`src/lease.ts`) or records why it did not.
 *
 * The release contract. A spawner releases only its OWN children -- the agents this
 * process's `AgentRegistry` knows -- and on this evidence alone: the child's terminal frame
 * reads `failed` or `aborted`, so this process observed the death; or the registry reports
 * the child `aborted` and its lease has lapsed, read fresh rather than from the cache. A
 * `completed` child whose contract is unmet is not dead: an `idle` or `parked` holder is
 * revivable and keeps its claim. A holder absent from this registry is UNKNOWN, never dead,
 * and gets one NOTE naming the lease state. The one path that releases on the lease alone is
 * a new lead adopting a run whose spawner chain died (`adoptRun` in `src/run-state.ts`).
 *
 * The frame arrives after `finalizeSubagentLifecycle` has settled the registry
 * (`task/executor.ts`: the settled frame is emitted by `finalizeRunResult`, which runs
 * after the finally block that calls it), so the status read here is the child's final one:
 * a hard kill leaves an `aborted` tombstone, a kept-alive finish leaves `idle`, an isolated
 * finish `parked`, and a one-shot helper is already unregistered.
 */

import { type AgentRef, AgentRegistry, type ExtensionAPI, type ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { type BdBead, bdFailureText, bdListChecked, bdRun, bdShow, lastBdFailure, readBudgetExhausted, resetReadBudget } from "./bd";
import type { ClaimState } from "./claim-state";
import architect from "./contracts/architect.json";
import generic from "./contracts/generic.json";
import implementer from "./contracts/implementer.json";
import researcher from "./contracts/researcher.json";
import reviewer from "./contracts/reviewer.json";
import shepherd from "./contracts/shepherd.json";
import {
 applies,
 collectExitEvidence,
 completionKindSupported,
 contractPaused,
 linkedEvidenceNeeds,
 resourceKind,
 satisfies,
} from "./gates/exit";
import { beadRouting } from "./identity";
import { leaseExpired, leaseState, releaseDeadClaim } from "./lease";
import { leadActor } from "./run-state";

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

/**
 * Which row of the reclamation table one bead took. A child that did not complete is
 * `died`; what its branch shows is a separate observation ({@link BranchState}), because
 * the branch is all that is knowable about a failed child's work. `parked` is a completed
 * child whose contract is unmet but whose holder the registry still reports revivable.
 */
export type ReapCase = "clean" | "incomplete" | "died" | "unknown" | "paused" | "parked";

/**
 * What the repository shows for `omp/task/<id>`. `stale` is a branch by that name whose
 * tip predates this child, so it is a leftover from an earlier run rather than this
 * child's capture. Absence and staleness are not proof that no work was done.
 */
export type BranchState = "found" | "absent" | "stale" | "unknown";

/** A holder's liveness as this process's registry reports it. `absent` is unknown, never dead. */
export type HolderState = AgentRef["status"] | "absent";

/**
 * What the reaper did about a bead's claim.
 *
 * - `released`: the fenced release landed and the `RECOVERED` comment with it.
 * - `released-unrecorded`: the claim is released but the comment did not land.
 * - `release-refused`: the fence refused; a successor holds the bead. Nothing written.
 * - `release-failed`: the store did not answer the release. Nothing written.
 * - `noted`: no release was warranted or possible; one NOTE names the lease state.
 * - `note-failed`: that NOTE did not land.
 * - `preserved`: the holder is revivable or paused; nothing written to the store.
 * - `not-needed`: a clean exit.
 */
export type ReapRecovery =
 | "released" | "released-unrecorded" | "release-refused" | "release-failed"
 | "noted" | "note-failed" | "preserved" | "not-needed";

/** One bead's disposition. `failures` names the contract checks it did not satisfy. */
export interface ReapedBead {
 bead: string;
 case: ReapCase;
 failures: string[];
 recovery: ReapRecovery;
 /** The holder's registry state when the decision was taken. */
 holder: HolderState;
}

/** What one terminal event did. `reaped` is empty when there was nothing to reap. */
export interface ReapOutcome {
 child: string;
 /** The captured branch, when the repository has a fresh one for this child. */
 branch?: string;
 branchState?: BranchState;
 discoveryUnknown?: boolean;
 reaped: ReapedBead[];
}

/** The one registry question the reaper asks. `AgentRegistry.global()` answers it. */
export interface HolderRegistry {
 get(id: string): { status: AgentRef["status"] } | undefined;
}

export interface ReapOptions {
 /** The repository the captured branches live in — the spawning session's cwd. */
 cwd: string;
 /**
  * When this session saw the child start (its `started` frame, else the reaper's own
  * subscription). A branch whose tip was committed before this is not the child's.
  */
 startedAtMs: number;
 /** The identity releasing: the spawner's claim actor, or the lead's lease actor. */
 recoveredBy: string;
 /** Subprocess seam; defaults to spawning `git`. */
 exec?: Exec;
 /** This process's registry; defaults to the global one. */
 registry?: HolderRegistry;
 /** The clock the lease is judged against; defaults to now. */
 now?: number;
}

/** Reap a terminal child's beads: release what the evidence allows, record the rest. */
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
 outcome.branchState = branch;
 if (branch === "found") outcome.branch = `omp/task/${child.id}`;

 for (const bead of candidates) {
  outcome.reaped.push(await reapBead(bead, child, branch, options));
 }
 return outcome;
}

/**
 * The beads a child holds, wisps included: `--include-infra --include-gates` lists a
 * claimed wisp with its assignee (measured on bd 1.2.2). `bd mol wisp list --json` rows
 * carry no assignee at all, so merging that listing here, as this once did, found nothing.
 */
async function candidateBeads(child: ChildLifecycle): Promise<{ beads: BdBead[]; unknown: boolean }> {
 const flags = ["--include-infra", "--include-gates", "--status", "open,in_progress,blocked,deferred", "--limit", "0", "--json"];
 const claimed = await bdListChecked(["list", "--assignee", child.id, ...flags]);
 const stamped = child.status === "completed"
  ? await bdListChecked(["list", "--metadata-field", `actor=${child.id}`, ...flags])
  : [];
 const beads = new Map<string, BdBead>();
 for (const bead of [...(claimed ?? []), ...(stamped ?? [])]) {
  if (!["open", "in_progress", "blocked", "deferred"].includes(bead.status ?? "")) continue;
  const assignee = typeof bead.assignee === "string" ? bead.assignee : "";
  if (assignee !== "" && assignee !== child.id) continue;
  if (assignee !== child.id && !(child.status === "completed" && bead.metadata?.actor === child.id)) continue;
  beads.set(bead.id, bead);
 }
 return { beads: [...beads.values()], unknown: claimed === null || stamped === null };
}

/** Hedged wording per branch state; the reaper never claims a branch proves or disproves work. */
const BRANCH_EVIDENCE: Record<BranchState, (name: string) => string> = {
 found: name => `captured branch observed: ${name}`,
 absent: () => "no captured branch observed (not proof of no work)",
 stale: name => `branch ${name} exists but predates this child (leftover from an earlier run, not this child's capture; not proof of no work)`,
 unknown: () => "captured branch unknown",
};

/** The registry state as a NOTE or RECOVERED comment states it. */
const HOLDER_EVIDENCE: Record<HolderState, string> = {
 aborted: "registry=aborted (this session's child, hard-killed)",
 running: "registry=running (this session's child, live)",
 idle: "registry=idle (this session's child, revivable)",
 parked: "registry=parked (this session's child, revivable)",
 absent: "registry=absent (not this session's child, or already unregistered; liveness unknown, not dead)",
};

/** Statuses the claim fence can pass: `bd update --claim` refuses `blocked` and `deferred`. */
const FENCEABLE: Record<string, true> = { open: true, in_progress: true };

/**
 * Decide one bead. The frame is the death evidence for `failed`/`aborted`; a `completed`
 * child with an unmet contract is released only when the registry says `aborted` and a
 * fresh read says the lease has lapsed. Everything else preserves the claim and says why.
 */
async function reapBead(bead: BdBead, child: ChildLifecycle, branch: BranchState, options: ReapOptions): Promise<ReapedBead> {
 const failures = child.status === "completed" ? await contractFailures(bead) : [];
 const holder = typeof bead.assignee === "string" ? bead.assignee : "";
 const disposition: ReapCase = child.status !== "completed"
  ? "died"
  : failures === "paused" ? "paused" : failures === null ? "unknown" : failures.length === 0 && holder === "" ? "clean" : "incomplete";
 const reaped = (recovery: ReapRecovery, state: HolderState, kase: ReapCase = disposition): ReapedBead =>
  ({ bead: bead.id, case: kase, failures: Array.isArray(failures) ? failures : [], recovery, holder: state });

 const state: HolderState = (options.registry ?? AgentRegistry.global()).get(child.id)?.status ?? "absent";
 // A clean exit is the documented success outcome whether or not it captured a branch;
 // the branch is logged by the caller, not recorded as a recovery. A paused writer keeps
 // its claim by contract: the linked escalation is the record, not a second comment.
 if (disposition === "clean") return reaped("not-needed", state);
 if (disposition === "paused") return reaped("preserved", state);

 const branchEvidence = BRANCH_EVIDENCE[branch](`omp/task/${child.id}`);
 // An unread contract names its cause: the reaper spent its own read cap, or bd
 // answered nothing and says why. The remedies differ -- re-check with fewer linked
 // beads against retry once the store answers -- so one word for both sent the
 // architect to the wrong one.
 const unreadCause = readBudgetExhausted() ? "the reaper's bd read budget is spent" : bdFailureText(lastBdFailure());
 const contractEvidence = failures === null
  ? `contract evidence unread (${unreadCause}); the contract is unevaluated, not failed`
  : Array.isArray(failures) && failures.length > 0 ? `unsatisfied checks: ${failures.join(", ")}` : "claim still held after a completed exit";
 const routing = beadRouting(bead);
 const carrier = routing?.from === "legacy-label" ? [`contract from legacy ${routing.spelling}`] : [];
 const now = options.now ?? Date.now();

 const note = async (why: string, lease: string, kase: ReapCase = disposition): Promise<ReapedBead> => {
  const text = [`NOTE claim preserved: child ${child.id} exited (${child.status}); holder ${holder || "none"} ${HOLDER_EVIDENCE[state]}`,
   lease, why, contractEvidence, branchEvidence, ...carrier, "no owner, status or metadata changed"].join("; ");
  const result = await bdRun(["comment", bead.id, text, "--actor", options.recoveredBy], undefined, options.cwd);
  return reaped(result?.code === 0 ? "noted" : "note-failed", state, kase);
 };

 // A held claim is releasable only from a status the fence can pass, by a holder this
 // process saw die. The frame is that proof for a died child; for a completed one the
 // registry must say aborted and a fresh read must say the lease has lapsed.
 if (holder === "") return note("no claim to release", leaseState(bead, now));
 let cause: string;
 if (disposition === "died") {
  cause = `child exited (${child.status}); ${HOLDER_EVIDENCE[state]}`;
 } else if (disposition === "unknown") {
  return note("release needs a readable contract", leaseState(bead, now));
 } else if (state === "running" || state === "idle" || state === "parked") {
  return reaped("preserved", state, "parked");
 } else if (state === "absent") {
  return note("release needs this session's registry to report the holder aborted", leaseState(bead, now));
 } else {
  const fresh = await bdShow(bead.id, undefined, options.cwd, { fresh: true });
  if (fresh === null) return note("release needs a fresh read of the lease, which bd did not answer", leaseState(bead, now));
  if (typeof fresh.assignee !== "string" || fresh.assignee !== holder) return reaped("release-refused", state);
  if (!leaseExpired(fresh, now)) return note("release waits for the lease to lapse", leaseState(fresh, now));
  cause = `child completed with its contract unmet; ${HOLDER_EVIDENCE[state]}; ${leaseState(fresh, now)}`;
 }
 if (FENCEABLE[bead.status ?? ""] !== true) {
  return note(`bd refuses --claim on a ${bead.status ?? "statusless"} bead, so the fenced release is unavailable; a human unblocks it`, leaseState(bead, now));
 }
 const released = await releaseDeadClaim(bead.id, holder, {
  cause,
  recoveredBy: options.recoveredBy,
  branch: branch === "found" ? `omp/task/${child.id}` : undefined,
  observations: [contractEvidence, branchEvidence, ...carrier],
 }, options.cwd);
 const recovery: ReapRecovery = released === "released" ? "released"
  : released === "comment-failed" ? "released-unrecorded"
   : released === "held-by-other" ? "release-refused" : "release-failed";
 return reaped(recovery, state);
}

/**
 * What the repository shows for this child's `omp/task/<id>`.
 *
 * Only the exact ref is accepted: ids are free-form, so a glob for `impl-7` also matches
 * child `impl-70`'s branch, and attributing another child's commits to this bead is worse
 * than recording no branch at all. `for-each-ref` matches a full ref name literally.
 *
 * A branch by the right name is not yet this child's: OMP allocates ids per session and
 * force-overwrites a stale `omp/task/<id>` from an earlier run, so a leftover can carry
 * the name until the capture replaces it. The tip's committer date is the session-scoped
 * evidence available -- both capture paths commit after the child started -- so a tip
 * older than the child's start is reported as `stale`, never as its capture.
 */
async function capturedBranch(id: string, options: ReapOptions): Promise<BranchState> {
 const exec = options.exec ?? spawnExec;
 const ref = `refs/heads/omp/task/${id}`;
 const result = await exec(["git", "for-each-ref", "--format=%(refname)%09%(committerdate:unix)", ref], options.cwd);
 if (result === null || result.code !== 0) return "unknown";
 for (const line of lines(result.stdout)) {
  const [name, committed] = line.split("\t");
  if (name !== ref) continue;
  const committedAt = Number(committed);
  if (!Number.isFinite(committedAt)) return "unknown";
  // Committer dates have second resolution; compare in the coarser unit.
  return committedAt >= Math.floor(options.startedAtMs / 1000) ? "found" : "stale";
 }
 return "absent";
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
 const evidence = await collectExitEvidence(bead, linkedEvidenceNeeds(contract));
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

/**
 * What one lifecycle subscription remembers about its children.
 *
 * A revived agent's every follow-up turn ends in the same terminal frame as a first run
 * (`runSubagentFollowUpTurn` -> `finalizeRunResult`), so without memory a parked
 * architect would be reaped -- notice and all -- on every wake. Start times make the
 * captured-branch check session-scoped.
 */
interface ReaperMemory {
	/** Children whose terminal frame already produced observations. */
	reaped: Set<string>;
	/** When this subscription saw each child's `started` frame. */
	started: Map<string, number>;
	/** When the subscription began; the floor for children whose start was not seen. */
	subscribedAtMs: number;
}

/**
 * Bind the reaper to the lifecycle bus for repositories with an active run.
 *
 * `claims` names the identity a release is attributed to: an architect reaping its
 * workers releases as its own claim actor; the lead, which claims nothing, releases as
 * its lease actor (`leadActor`).
 */
export function registerSupervision(pi: ExtensionAPI, isRunBound: (cwd: string) => Promise<boolean>, claims: ClaimState): void {
	let context: ExtensionContext | undefined;
	let unsubscribe: (() => void) | undefined;

	const bindSession = (ctx: ExtensionContext): void => {
		context = ctx;
		if (unsubscribe !== undefined) return;
		const memory: ReaperMemory = { reaped: new Set(), started: new Map(), subscribedAtMs: Date.now() };
		unsubscribe = pi.events.on("task:subagent:lifecycle", data => {
			// The session manager owns cwd. `/move` mutates it without another
			// `session_start`, while switch and branch events may supply a new context.
			const currentCwd = context?.sessionManager.getCwd();
			if (currentCwd === undefined || context === undefined) return;
			const recoveredBy = claims.observedClaim()?.actor ?? leadActor(context.sessionManager.getSessionId());
			return handleLifecycle(pi, data, currentCwd, recoveredBy, isRunBound, memory);
		});
	};

	pi.on("session_start", (_event, ctx) => bindSession(ctx));
	pi.on("session_switch", (_event, ctx) => bindSession(ctx));
	pi.on("session_branch", (_event, ctx) => bindSession(ctx));
	pi.on("session_shutdown", () => {
		unsubscribe?.();
		unsubscribe = undefined;
		context = undefined;
	});
}

/** The notice each recovery outcome earns in the spawner's transcript. */
const RECOVERY_NOTICE: Record<ReapRecovery, string> = {
 "released": "claim released under the lease and RECOVERED recorded; the bead is open and unassigned, and the next pull re-offers it",
 "released-unrecorded": "claim released under the lease, but the RECOVERED comment did not land; the bead is open and unassigned without its record",
 "release-refused": "release refused by the claim fence: a successor already holds the bead; nothing changed",
 "release-failed": "release not confirmed: bd did not answer; the claim stands, so inspect it once the store answers",
 "noted": "claim preserved; a NOTE on the bead names the holder's registry state and lease",
 "note-failed": "claim preserved; the NOTE naming the holder's registry state and lease did not land",
 "preserved": "claim preserved; the holder is revivable or paused, so nothing was written",
 "not-needed": "clean exit",
};

/** Reap one bus payload, reporting what it did and swallowing what it could not. */
async function handleLifecycle(
	pi: ExtensionAPI,
	data: unknown,
	cwd: string,
	recoveredBy: string,
	isRunBound: (cwd: string) => Promise<boolean>,
	memory: ReaperMemory,
): Promise<void> {
	const child = asLifecycle(data);
	if (child === null) return;
	if (child.status === "started") {
		memory.started.set(child.id, Date.now());
		return;
	}
	if (TERMINAL[child.status] !== true) return;
	if (memory.reaped.has(child.id)) {
		pi.logger.info("orchestrate reaper skipped a repeat terminal frame", { child: child.id, status: child.status });
		return;
	}
	resetReadBudget();
	try {
		if (!await isRunBound(cwd)) return;
	} catch (error) {
		// The same outage as a failed reap, so it gets the same notice: a child that
		// exits while the store is unreadable must not vanish into a log line.
		const reason = error instanceof Error ? error.message : String(error);
		pi.logger.error("orchestrate run liveness check unavailable; reap skipped", { child: child.id, error: reason });
		pi.sendMessage({
			customType: "orchestrate-recovery",
			content: `Reap of child ${child.id} was skipped: ${reason}. Nothing was released. Its claims are reaped when the run's status can be read again and the child's terminal frame recurs; otherwise inspect them by hand once the store answers.`,
			display: true,
		}, { triggerTurn: false });
		return;
	}
	try {
		const outcome = await reapChild(child, { cwd, recoveredBy, startedAtMs: memory.started.get(child.id) ?? memory.subscribedAtMs });
		// A release the store never confirmed is not a reap: leave the child reapable.
		if (outcome.reaped.some(reaped => reaped.recovery !== "release-failed")) memory.reaped.add(child.id);
		if (outcome.discoveryUnknown) pi.logger.warn("orchestrate recovery candidate discovery incomplete", { child: child.id });
		for (const reaped of outcome.reaped) {
			pi.logger.info("orchestrate recovery observation", {
				child: child.id,
				bead: reaped.bead,
				case: reaped.case,
				holder: reaped.holder,
				branch: outcome.branch,
				failures: reaped.failures,
				recovery: reaped.recovery,
				branchState: outcome.branchState,
			});
			if (reaped.recovery !== "not-needed") {
				pi.sendMessage({
					customType: "orchestrate-recovery",
					content: `Reaped ${reaped.bead} on child ${child.id} (${child.status}): ${reaped.case}, holder ${reaped.holder} in this session's registry; ${RECOVERY_NOTICE[reaped.recovery]}. Branch: ${outcome.branchState ?? "unknown"}${outcome.branch === undefined ? "" : ` (${outcome.branch})`}; no branch or worktree was touched.`,
					display: true,
				}, { triggerTurn: false });
			}
		}
		if (outcome.discoveryUnknown) {
			pi.sendMessage({
				customType: "orchestrate-recovery",
				content: `Candidate discovery for child ${child.id} was incomplete: a bd list did not answer, so some of its claims may not have been reaped. Nothing beyond the listed outcomes was released; list its claims by hand once the store answers.`,
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
			customType: "orchestrate-recovery",
			content: `Reap of child ${child.id} failed before it finished. Nothing is confirmed released; inspect its claims by hand.`,
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
