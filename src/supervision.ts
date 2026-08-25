/**
 * S1 — the in-process reaper on the subagent lifecycle bus, plus S2's patrol marker.
 *
 * A child that dies leaves its bead assigned to an id that no longer exists. A child
 * that exits `completed` may still not have *finished*: `completed` from the runtime
 * means "yielded successfully" and nothing more. Either way the commits it made sit on
 * a captured branch nobody has been told about, and the bead reads as owned work in
 * flight. This module closes both gaps deterministically, with no model in the loop:
 *
 * - S1 subscribes `task:subagent:lifecycle` and walks the reclamation table on every
 *   terminal event, against live bead state — see {@link reapChild}.
 * - S2's {@link ensurePatrolWisp} writes the durable marker that reconciliation is
 *   still owed, because S1's subscription dies with the process that made it.
 *
 * Everything fails open. A bus handler cannot refuse a tool the way a `tool_call`
 * handler can, so the risk here is not blocking the session but acting on a guess: an
 * unreadable `bd` or an unavailable `git` is "unknown", and unknown never becomes a
 * reclamation, a stamp, or a deletion. Nothing runs at import time.
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { type BdBead, bdComments, bdLinked, bdList, bdRun, commentVerb, metadataString, resetReadBudget } from "./bd";
import architect from "./contracts/architect.json";
import generic from "./contracts/generic.json";
import implementer from "./contracts/implementer.json";
import researcher from "./contracts/researcher.json";
import reviewer from "./contracts/reviewer.json";
import shepherd from "./contracts/shepherd.json";
import { applies, type Evidence, resourceKind, satisfies } from "./gates/exit";
import { roleFromLabels } from "./identity";

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
export type ReapCase = "clean" | "incomplete" | "died-with-work" | "died-without-work";

/** One bead's disposition. `failures` names the contract checks it did not satisfy. */
export interface ReapedBead {
	bead: string;
	case: ReapCase;
	failures: string[];
}

/** What one terminal event did. `reaped` is empty when there was nothing to reap. */
export interface ReapOutcome {
	child: string;
	/** The captured branch, when the repository has one for this child. */
	branch?: string;
	reaped: ReapedBead[];
}

export interface ReapOptions {
	/** The repository the captured branches live in — the spawning session's cwd. */
	cwd: string;
	/** Subprocess seam; defaults to spawning `git`. */
	exec?: Exec;
}

/**
 * Walk the reclamation table for one child's terminal lifecycle event.
 *
 * | Case | Condition | Action |
 * |---|---|---|
 * | clean | `completed`, claim released, contract re-check passes | stamp `metadata.branch` when a captured branch exists |
 * | incomplete | `completed` but still claimed, or the contract re-check fails | RECLAIM comment, release the claim, stamp `recovered_branch` |
 * | died-with-work | `failed`/`aborted` with a captured branch | the same reclaim; the branch is the surviving evidence |
 * | died-without-work | `failed`/`aborted` with no captured branch | RECLAIM comment and release; nothing to recover |
 *
 * Non-destructive by construction: it comments, releases, and stamps. It never
 * commits, discards a worktree, or deletes a branch — those are agent decisions the
 * recovery formula gates on evidence.
 */
export async function reapChild(child: ChildLifecycle, options: ReapOptions): Promise<ReapOutcome> {
	const outcome: ReapOutcome = { child: child.id, reaped: [] };
	if (TERMINAL[child.status] !== true) return outcome;

	// The reaper runs off a bus event, so nothing has reset the per-turn read budget
	// for it. Left exhausted by the turn's gates, the contract re-check would read
	// zero comments and report every clean exit as an incompletion.
	resetReadBudget();

	const candidates = await candidateBeads(child);
	if (candidates.length === 0) return outcome;

	const branch = await capturedBranch(child.id, options);
	if (branch !== undefined) outcome.branch = branch;

	for (const bead of candidates) {
		outcome.reaped.push(await reapBead(bead, child, branch));
	}
	return outcome;
}

/**
 * The beads one child's exit could have stranded.
 *
 * A claim still held is the first and cheapest signal. A compliant exit releases the
 * claim though, so a `completed` child with nothing claimed is looked up a second way:
 * by `metadata.actor`, the stamp dispatch writes and every agent body reads back as
 * `BEADS_ACTOR`. Both rows that a released claim can still be in — the branch stamp a
 * clean exit is owed, and an exit whose contract went unsatisfied — are invisible from
 * the assignee side.
 *
 * A stamped bead that someone else now holds is dropped. Reclaiming it would steal a
 * live claim, which is the one thing recovery may never do on inference alone.
 *
 * Outside an orchestrate run both queries are empty by construction: nothing but
 * dispatch puts a child id in `assignee` or in `metadata.actor`, so the reaper is
 * self-limiting rather than gated on a marker file the architect's worktree may lack.
 */
async function candidateBeads(child: ChildLifecycle): Promise<BdBead[]> {
	const claimed = await bdList(["list", "--assignee", child.id, "--status", "in_progress", "--json"]);
	if (claimed.length > 0) return claimed;

	// A child that died holding nothing stranded nothing: a bead merely stamped with
	// its actor is still open and still claimable by its successor.
	if (child.status !== "completed") return [];

	const stamped = await bdList([
		"list",
		"--metadata-field",
		`actor=${child.id}`,
		"--status",
		"open,in_progress",
		"--json",
	]);
	// `bd` reports an unassigned bead as `null`, which the field's type does not admit.
	const mine: BdBead[] = [];
	for (const bead of stamped) {
		const assignee = typeof bead.assignee === "string" ? bead.assignee : "";
		if (assignee === "" || assignee === child.id) mine.push(bead);
	}
	return mine;
}

/** Apply one row of the table to one bead. */
async function reapBead(bead: BdBead, child: ChildLifecycle, branch: string | undefined): Promise<ReapedBead> {
	if (child.status !== "completed") {
		// A dead child's contract is moot: it never reached its exit, so there is
		// nothing to audit and the claim is stranded either way.
		const evidence =
			branch === undefined ? "no captured branch, nothing to recover" : `commits preserved on ${branch}`;
		await reclaim(bead, `RECLAIM child ${child.id} died (${child.status}); ${evidence}`, branch);
		return { bead: bead.id, case: branch === undefined ? "died-without-work" : "died-with-work", failures: [] };
	}

	const failures = await contractFailures(bead);
	const claimHeld = typeof bead.assignee === "string" && bead.assignee !== "";
	if (failures.length === 0 && !claimHeld) {
		await stampBranch(bead, branch);
		return { bead: bead.id, case: "clean", failures: [] };
	}

	const why = failures.length > 0 ? failures.join(", ") : "claim still held";
	await reclaim(bead, `RECLAIM child ${child.id} exited without completing: ${why}`, branch);
	return { bead: bead.id, case: "incomplete", failures };
}

/**
 * Comment, then release, then stamp — in that order, and in one update.
 *
 * Evidence precedes mutation so a `bd` that dies mid-sequence leaves the reason on the
 * bead rather than a silently freed claim. `--assignee "" --status open` is the only
 * claim release beads offers, and `--set-metadata` merges rather than replacing the
 * map, so the recovery pointer joins the dispatch stamps instead of erasing them.
 */
async function reclaim(bead: BdBead, reason: string, branch: string | undefined): Promise<void> {
	await bdRun(["comment", bead.id, reason]);
	const argv = ["update", bead.id, "--assignee", "", "--status", "open"];
	if (branch !== undefined) argv.push("--set-metadata", `recovered_branch=${branch}`);
	await bdRun(argv);
}

/**
 * Record where a clean exit's commits landed, and only that.
 *
 * A child that stamped `metadata.branch` itself named the branch it delivered, and the
 * reaper never overwrites it. This fills the gap `apply: false` leaves for roles whose
 * contract does not demand the stamp: the branch is created by the runtime, after the
 * child's last chance to write anything.
 */
async function stampBranch(bead: BdBead, branch: string | undefined): Promise<void> {
	if (branch === undefined) return;
	if (metadataString(bead, "branch") !== undefined) return;
	await bdRun(["update", bead.id, "--set-metadata", `branch=${branch}`]);
}

/**
 * The branch OMP captured for this child, or `undefined` when there is none.
 *
 * With `task.isolation.apply: false` the runtime commits a child's work to
 * `omp/task/<agentId>` in the parent repo and creates that branch **only** when the
 * child actually committed (`task/worktree.ts:839,889`; on a merge failure
 * `task/isolation-runner.ts:238` keeps it only while it carries commits). The
 * branch's existence is therefore the commit evidence the table asks for, and the
 * lifecycle id is that same `agentId` (`task/executor.ts:3152`).
 *
 * The glob is queried but only the exact name is accepted: ids are free-form, so
 * `omp/task/impl-7*` also matches child `impl-70`'s branch, and attributing another
 * child's commits to this bead is worse than recording no branch at all.
 */
async function capturedBranch(id: string, options: ReapOptions): Promise<string | undefined> {
	const exec = options.exec ?? spawnExec;
	const wanted = `omp/task/${id}`;
	const result = await exec(["git", "branch", "--list", `${wanted}*`], options.cwd);
	if (result === null || result.code !== 0) return undefined;
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
}

/**
 * The same six contract files G1 evaluates.
 *
 * The gate's table and its evidence collector are module-private, so this repeats the
 * imports — never the evaluation. `resourceKind`, `applies` and `satisfies` come from
 * the gate itself, which is what keeps the exit verdict and the reaper's re-check from
 * drifting into two different answers.
 */
const CONTRACTS: Record<string, RoleContract> = {
	architect,
	implementer,
	researcher,
	reviewer,
	shepherd,
	generic,
};

/**
 * The contract checks this bead does not satisfy, re-run parent-side.
 *
 * This is what upgrades "yielded successfully" to "work accepted", and it closes G1's
 * two escape paths: the bounce-budget force-allow and an abort that never reached
 * `yield` both land here. Authority breaches (`deny_states`, `deny_metadata`) are
 * deliberately not re-checked — a role that wrote a field it does not own has not
 * failed to *finish*, and correcting that is the shepherd's duty, not a reclamation.
 *
 * The role comes from the bead's routing label rather than a session, because the
 * session whose contract is in question no longer exists. That label is worker-writable,
 * so the lookup tests own properties: a bare index resolves `agent:constructor` through
 * `Object.prototype`, and the truthy Function it returns defeats the `?? generic`
 * fallback, leaving `contract.completion` undefined and every check silently skipped.
 * A dead child could therefore label its way out of being reclaimed.
 */
async function contractFailures(bead: BdBead): Promise<string[]> {
	const role = roleFromLabels(bead.labels) ?? "generic";
	const contract = Object.hasOwn(CONTRACTS, role) ? (CONTRACTS[role] ?? generic) : generic;
	const evidence = await collectEvidence(bead);
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

/** Comment verbs on the bead and on the wisps linked to it, as `satisfies` wants them. */
async function collectEvidence(bead: BdBead): Promise<Evidence> {
	const verbs = (await bdComments(bead.id)).map(comment => commentVerb(comment.text));
	const linkedVerbs: string[] = [];
	for (const type of ["relates-to", "replies-to"]) {
		for (const linkedId of await bdLinked(bead.id, type)) {
			for (const comment of await bdComments(linkedId)) linkedVerbs.push(commentVerb(comment.text));
		}
	}
	return { bead, verbs, linkedVerbs };
}

/**
 * S2 — make sure an epic carries its patrol wisp, and never a second one.
 *
 * S1 owns the live process; the patrol owns the gap between processes. It is the
 * durable marker that the sweep is still owed, drained by the next session to open.
 *
 * Existing patrols are found through `bd dep list --direction=up`, not `bd list`:
 * verified on bd 1.1.2, `bd list` hides ephemeral beads outright -- even under
 * `--wisp-type patrol` -- and has no `--include-ephemeral` of its own, while the
 * dependents query returns the wisp with its `wisp_type` intact. Anything not closed
 * counts as present, so a patrol currently being drained is not duplicated, and one
 * that has been closed is re-armed.
 *
 * `cwd` is explicit because the caller binding a run may not be running inside the
 * repository it is binding, and `bd` resolves its database from the working
 * directory: an inherited cwd arms the patrol in the wrong run's beads.
 */
export async function ensurePatrolWisp(epicId: string, cwd?: string): Promise<void> {
	const linked = await bdList(
		["dep", "list", epicId, "--direction=up", "--type", "relates-to", "--json"],
		undefined,
		cwd,
	);
	for (const bead of linked) {
		const wispType = typeof bead.wisp_type === "string" ? bead.wisp_type : "";
		if (wispType === "patrol" && (bead.status ?? "").toLowerCase() !== "closed") return;
	}
	await bdRun(
		[
			"create",
			`patrol: ${epicId} claim reconciliation`,
			"--ephemeral",
			"--wisp-type",
			"patrol",
			"--deps",
			`relates-to:${epicId}`,
			"--silent",
		],
		undefined,
		cwd,
	);
}

/**
 * Bind the reaper to the lifecycle bus.
 *
 * Subscription happens inside `session_start` because `ctx` is where the repository
 * the captured branches live in comes from, and because a subscription taken at load
 * time would outlive nothing useful. The channel only fires in a session that spawns,
 * so this is inert in a worker rather than conditional on one.
 */
export function registerSupervision(pi: ExtensionAPI): void {
	let subscribed = false;

	pi.on("session_start", (_event, ctx) => {
		// `session_start` fires again on a switch or a branch; a second subscription
		// would reap every child exit twice.
		if (subscribed) return;
		subscribed = true;
		// The reap's promise is handed back rather than discarded: `EventBus.on`
		// awaits a handler and logs a rejection, and `emit` never waits on that, so
		// returning it costs the emitter nothing and keeps a fault visible.
		pi.events.on("task:subagent:lifecycle", data => handleLifecycle(pi, data, ctx.cwd));
	});
}

/** Reap one bus payload, reporting what it did and swallowing what it could not. */
async function handleLifecycle(pi: ExtensionAPI, data: unknown, cwd: string): Promise<void> {
	const child = asLifecycle(data);
	if (child === null) return;
	try {
		const outcome = await reapChild(child, { cwd });
		for (const reaped of outcome.reaped) {
			pi.logger.info("orchestrate reaper", {
				child: child.id,
				bead: reaped.bead,
				case: reaped.case,
				branch: outcome.branch,
				failures: reaped.failures,
			});
		}
	} catch (error) {
		// The bus contains a rejected handler but reports it as an anonymous event
		// error; naming the reaper is what makes a silent reclamation diagnosable.
		pi.logger.error("orchestrate reaper failed open", {
			child: child.id,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

/** The lifecycle payload narrowed to the fields this module reads. */
function asLifecycle(data: unknown): ChildLifecycle | null {
	if (data === null || typeof data !== "object") return null;
	if (!("id" in data) || typeof data.id !== "string" || data.id.length === 0) return null;
	if (!("status" in data) || typeof data.status !== "string") return null;
	return { id: data.id, status: data.status };
}
