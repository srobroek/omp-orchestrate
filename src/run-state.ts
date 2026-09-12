/**
 * The active-run marker and the operator commands that move it.
 *
 * The marker, `.orchestration/.active-run`, says whether this repository is under an
 * orchestrate run and which run epic the run answers to. `/orchestrate-start` writes it
 * already bound: the run's database is located and probed and the epic is created or
 * verified first, so a marker always names a validated store and a live epic. Marker reads
 * stay cheap enough for every gated call; `isBoundRunActive` owns the explicit Beads
 * liveness probe used only by child supervision.
 *
 * Two properties this keeps. Starting is idempotent for the session that started: a
 * retried `/orchestrate-start` re-takes the lease and re-records the capabilities.
 * Rebinding to a different id is refused -- a second run epic in one tree is a mistake,
 * not a retarget -- and a run another session started is refused too: `/orchestrate-resume`
 * takes it over once its lead lease has lapsed, `/orchestrate-stop` ends it.
 *
 * A run ends when `/orchestrate-stop` removes the marker; nothing else does. Writers hold
 * an exclusive sibling lock through read/validate/rename. Readers see atomic snapshots; a
 * leftover lock requires explicit operator reconciliation.
 *
 * `pending`, the id an older plugin release wrote before an epic existed, is still read so
 * a marker that release left behind binds or stops cleanly; nothing writes it any more.
 */

import { execFile } from "node:child_process";
import fs, { type FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentRegistry, type AgentStatus, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { locateBeadsDir } from "./beads-mode";
import { type BdBead, type BdComment, bdCommentsChecked, bdListChecked, bdRun, bdShow, commentVerb, metadataString, resetReadBudget } from "./bd";
import { type LandingRecord, recordLandingCapabilities } from "./landing";
import { type LeadLeaseRenewal, fenceRefused, leaseExpired, leaseState, leaseUntil, releaseDeadClaim } from "./lease";
import { probeStore, type StoreProbe } from "./store-probe";

/** The marker shape this plugin writes; a marker stamped with a higher number is refused. */
export const MARKER_SCHEMA = 1;

/**
 * The marker's on-disk shape.
 *
 * `beads_dir` is the run's `.beads`, canonical and absolute, as `bd where` answered at
 * start. It is what an isolated copy redirects its own `.beads` to
 * (`src/clone-adopt.ts`): the copy carries this marker, so the run's database travels
 * with it and nothing has to be re-established when a lead restarts. A marker written
 * before the field existed reads without it, and W5 asks for a restart to record it.
 *
 * `session_id` is the session that started or last resumed the run: what `/orchestrate-start`
 * checks before refusing a second operator, and what `/orchestrate-status` names. The lead
 * lease itself is read from the session, never from here (`leadActor`).
 *
 * A `repo_root` field was written here once and read by nothing; `asActiveRun` keeps
 * only the fields below, so a marker written by an older version still reads.
 */
export interface ActiveRun {
	schema_version: typeof MARKER_SCHEMA;
	run_id: string;
	session_id?: string;
	beads_dir?: string;
}

/** Run id an older plugin release wrote before the run epic existed. Bindable; never treated as bound. */
const PENDING = "pending";

/** A Beads identifier, as `orchestrator-run-activate.py` defined it. */
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/**
 * The marker this repository uses. `ORCHESTRATE_MARKER_FILE` wins outright, and
 * is resolved against `cwd` so a relative override means the same file whatever
 * directory the process was started from. An empty value reads as unset, so
 * exporting the variable blank cannot point the marker at the repository root.
 */
export function markerPath(cwd: string): string {
	const configured = process.env.ORCHESTRATE_MARKER_FILE;
	if (configured !== undefined && configured.length > 0) return path.resolve(cwd, configured);
	return path.join(cwd, ".orchestration", ".active-run");
}

/**
 * The marker as currently written, or `null` when there is none to read.
 *
 * A body that is not JSON is taken as a bare run id: early runs wrote the id
 * alone, and reading such a marker as absent would let a start overwrite a live
 * run's binding.
 */
export async function readActiveRun(cwd: string): Promise<ActiveRun | null> {
	let raw: string;
	try {
		raw = (await fs.readFile(markerPath(cwd), "utf8")).trim();
	} catch {
		return null;
	}
	if (raw.length === 0) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { schema_version: MARKER_SCHEMA, run_id: raw };
	}
	return asActiveRun(parsed);
}

/**
 * Normalise a parsed marker body, or `null` when it is not a marker at all.
 *
 * Optional fields are omitted rather than set to `undefined`, so a marker rewritten
 * from a parsed one stays byte-identical instead of gaining `null`s.
 */
function asActiveRun(value: unknown): ActiveRun | null {
	if (typeof value === "string") return value.length > 0 ? { schema_version: MARKER_SCHEMA, run_id: value } : null;
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	const runId = typeof record.run_id === "string" && record.run_id.length > 0 ? record.run_id : PENDING;
	const sessionId = typeof record.session_id === "string" && record.session_id.length > 0 ? record.session_id : undefined;
	const beadsDir = typeof record.beads_dir === "string" && path.isAbsolute(record.beads_dir) ? record.beads_dir : undefined;
	// An unknown key is dropped rather than carried: see the note on ActiveRun.
	const state: ActiveRun = { schema_version: MARKER_SCHEMA, run_id: runId };
	if (sessionId !== undefined) state.session_id = sessionId;
	if (beadsDir !== undefined) state.beads_dir = beadsDir;
	return state;
}

const MALFORMED = "Active-run marker is malformed; reconcile it before starting or resuming";

/** A strict marker read: the run, and whether the file predates `schema_version`. */
interface MarkerRead {
	run: ActiveRun;
	legacy: boolean;
}

/**
 * Authority reads distinguish absence from unreadable or malformed markers, and a marker
 * a newer plugin wrote from one this version can carry: a higher `schema_version` is
 * refused by name, because reading it as this shape could drop a field the newer run
 * depends on.
 */
async function readMarker(cwd: string): Promise<MarkerRead | null> {
	let raw: string;
	try {
		raw = (await fs.readFile(markerPath(cwd), "utf8")).trim();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		if (RUN_ID_RE.test(raw)) return { run: { schema_version: MARKER_SCHEMA, run_id: raw }, legacy: true };
		throw new Error(MALFORMED);
	}
	if (typeof parsed === "string" && RUN_ID_RE.test(parsed)) {
		return { run: { schema_version: MARKER_SCHEMA, run_id: parsed }, legacy: true };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(MALFORMED);
	const record = parsed as Record<string, unknown>;
	const schema = record.schema_version;
	if (typeof schema === "number" && Number.isInteger(schema) && schema > MARKER_SCHEMA) {
		throw new Error(`Active-run marker schema ${schema} is newer than this plugin's ${MARKER_SCHEMA}; upgrade the plugin before resuming`);
	}
	if (typeof record.run_id !== "string" || !RUN_ID_RE.test(record.run_id)
		|| (schema !== undefined && schema !== MARKER_SCHEMA)
		|| (record.session_id !== undefined && (typeof record.session_id !== "string" || record.session_id.length === 0))
		|| (record.beads_dir !== undefined && (typeof record.beads_dir !== "string" || !path.isAbsolute(record.beads_dir)))) {
		throw new Error(MALFORMED);
	}
	const state: ActiveRun = { schema_version: MARKER_SCHEMA, run_id: record.run_id };
	if (typeof record.session_id === "string") state.session_id = record.session_id;
	if (typeof record.beads_dir === "string") state.beads_dir = record.beads_dir;
	return { run: state, legacy: schema === undefined };
}

/** Authority reads distinguish absence from unreadable or malformed markers. */
export async function readActiveRunStrict(cwd: string): Promise<ActiveRun | null> {
	return (await readMarker(cwd))?.run ?? null;
}

const ACTIVE_RUN_STATUSES: Record<string, true> = {
	open: true,
	in_progress: true,
	blocked: true,
	deferred: true,
};

/** What one `bd show` of a run epic establishes. Only `active` authorises supervision. */
type RunLiveness =
	| { kind: "active" | "closed"; status: string }
	| { kind: "unverified" }
	| { kind: "unknown"; status: string };

function runLiveness(run: BdBead | null): RunLiveness {
	if (run === null || typeof run.status !== "string") return { kind: "unverified" };
	const status = run.status.toLowerCase();
	if (status === "closed") return { kind: "closed", status: run.status };
	if (ACTIVE_RUN_STATUSES[status] === true) return { kind: "active", status: run.status };
	return { kind: "unknown", status: run.status };
}

/**
 * Verify that the bound run still authorises child supervision.
 *
 * A missing or pending marker is an ordinary inactive repository. Once a run id
 * is bound, only a positively observed Beads status establishes supervision.
 * Unreadable, malformed, missing, and unknown authority remains unavailable so
 * callers cannot mistake uncertainty for an inactive or closed run.
 */
export async function isBoundRunActive(cwd: string): Promise<boolean> {
	const marker = await readActiveRunStrict(cwd);
	if (marker === null || marker.run_id === PENDING) return false;
	const liveness = runLiveness(await bdShow(marker.run_id, undefined, cwd));
	switch (liveness.kind) {
		case "active": return true;
		case "closed": return false;
		case "unverified": throw new Error(`run liveness unavailable: bound run ${marker.run_id} status could not be verified`);
		case "unknown": throw new Error(`run liveness unavailable: bound run ${marker.run_id} has unknown status ${JSON.stringify(liveness.status)}`);
	}
}

/** Write the marker atomically, leaving no temporary behind on either path. */
async function writeMarker(target: string, state: ActiveRun): Promise<void> {
	await fs.mkdir(path.dirname(target), { recursive: true });
	const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
	try {
		// Sorted keys keep the file byte-stable across rewrites, so an unchanged
		// marker does not show up as a diff in a run's worktree.
		await fs.writeFile(temporary, `${JSON.stringify(state, Object.keys(state).sort())}\n`, { encoding: "utf8", flag: "wx" });
		await fs.rename(temporary, target);
	} catch (error) {
		await fs.rm(temporary, { force: true }).catch(() => { });
		throw error;
	}
}

/** Bounded cross-process exclusion; never steal a lock based on age or a guessed PID. */
async function withMarkerLock<T>(cwd: string, action: () => Promise<T>): Promise<T> {
	const target = markerPath(cwd);
	await fs.mkdir(path.dirname(target), { recursive: true });
	const lock = `${target}.lock`;
	let handle: FileHandle | undefined;
	for (let attempt = 0; attempt < 20; attempt++) {
		try {
			handle = await fs.open(lock, "wx");
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (attempt === 19) throw new Error(`Active-run marker is locked: ${lock}; reconcile its writer before retrying`);
			await delay(25);
		}
	}
	if (handle === undefined) throw new Error(`Could not acquire active-run marker lock: ${lock}`);
	try {
		return await action();
	} finally {
		await handle.close();
		await fs.unlink(lock);
	}
}

/** How binding left the lead lease: taken on the epic, or why the lead must look. */
export interface BindResult {
	lease: "written" | { failed: string };
}

/**
 * The lead's lease identity: the session driving the run. Read from the session, never
 * from the marker's `session_id`, which a resuming lead rewrites in the shared checkout;
 * an old lead reading it there would renew the new lead's lease.
 */
export function leadActor(sessionId: string | undefined): string {
	return sessionId === undefined ? "lead" : `lead:${sessionId}`;
}

/** Wall-clock ceiling for a write on the epic; a write, so the operation timeout. */
const EPIC_WRITE_TIMEOUT_MS = 20_000;

/** What one fenced write on the epic did. */
type FencedWrite = "written" | "held-by-other" | { failed: string };

/**
 * One fenced write as `actor`: `bd update <epic> --actor <actor> --claim ...`. The lead
 * lease is carried exactly like a worker's -- the epic's assignee is the lead and the
 * `--claim` fence refuses any other actor -- so a zombie lead's renewal fails the moment
 * a replacement holds the epic, and two leads cannot both believe they own the run.
 */
async function fencedEpicWrite(runId: string, actor: string, fields: string[], cwd: string, autoCommit: boolean): Promise<FencedWrite> {
	const args = ["update", runId, "--actor", actor, "--claim", ...fields];
	if (!autoCommit) args.push("--dolt-auto-commit", "off");
	const written = await bdRun(args, EPIC_WRITE_TIMEOUT_MS, cwd);
	if (written === null) return { failed: "bd did not answer" };
	if (written.code === 0) return "written";
	if (fenceRefused(written)) return "held-by-other";
	return { failed: written.stderr.trim() || `bd exited ${written.code}` };
}

/** Take or extend `actor`'s lease on the epic: the fenced claim plus `lease_until`. */
async function claimLeadLease(runId: string, actor: string, now: number, cwd: string, autoCommit: boolean): Promise<FencedWrite> {
	return fencedEpicWrite(runId, actor, ["--set-metadata", `lease_until=${leaseUntil(now)}`], cwd, autoCommit);
}

/**
 * Take over the epic from `holder`, whose lease has lapsed: release as the old lead
 * (refused once anyone else holds it), then claim as the new. Either fence losing means
 * another adopter won; nothing is retried.
 */
async function takeOverLeadLease(runId: string, holder: string, actor: string, now: number, cwd: string): Promise<FencedWrite> {
	const released = await fencedEpicWrite(runId, holder, ["--assignee", "", "--status", "open"], cwd, true);
	if (released !== "written") return released;
	return claimLeadLease(runId, actor, now, cwd, true);
}

/** The lead the epic names, or `undefined` when nobody holds it. */
function epicHolder(epic: BdBead): string | undefined {
	return typeof epic.assignee === "string" && epic.assignee !== "" ? epic.assignee : undefined;
}

/**
 * Name the run bead this run answers to. Throws on a refusal -- a malformed id, an epic
 * Beads cannot show as open, or a marker already bound elsewhere -- so callers surface
 * the reason rather than silently leaving the marker unbound.
 *
 * The epic is read before the marker is written. A typo accepted here would leave
 * `isBoundRunActive` throwing on every child exit, disabling supervision for the whole
 * run while the operator believes it bound; the same rule that governs supervision --
 * only a positively observed status counts -- governs binding, so a bind with `bd`
 * unreachable is refused rather than trusted.
 *
 * A missing marker is created bound; a `pending` one, or one already naming `runId`, is
 * rewritten in place, keeping the session and database it recorded unless the caller
 * names new ones. The lead lease belongs here rather than in the command handler: it is
 * the durable consequence of a binding existing, so every caller must get it. Binding
 * claims the epic as the lead; another lead's live lease refuses the claim (the bind
 * stands, the failure is returned), and another lead's lapsed lease is taken over,
 * because binding is the explicit act.
 */
export async function bindRun(cwd: string, runId: string, sessionId?: string, beadsDir?: string): Promise<BindResult> {
	if (!RUN_ID_RE.test(runId)) throw new Error(`run id must be a Beads identifier, got ${JSON.stringify(runId)}`);
	resetReadBudget();
	const epic = await bdShow(runId, undefined, cwd, { fresh: true });
	const liveness = runLiveness(epic);
	if (liveness.kind !== "active" || epic === null) {
		throw new Error(liveness.kind === "unverified"
			? `run epic ${runId} could not be read from Beads; binding refused`
			: `run epic ${runId} has status ${JSON.stringify(liveness.status)}, which cannot host a run; binding refused`);
	}
	const bound = await withMarkerLock(cwd, async () => {
		const existing = await readActiveRunStrict(cwd);
		if (existing !== null && existing.run_id !== PENDING && existing.run_id !== runId) {
			throw new Error(`active-run marker is already bound to ${existing.run_id}`);
		}
		const state: ActiveRun = { schema_version: MARKER_SCHEMA, run_id: runId };
		const session = sessionId ?? existing?.session_id;
		const beads = beadsDir ?? existing?.beads_dir;
		if (session !== undefined) state.session_id = session;
		if (beads !== undefined) state.beads_dir = beads;
		await writeMarker(markerPath(cwd), state);
		return state;
	});
	const now = Date.now();
	const actor = leadActor(bound.session_id);
	const holder = epicHolder(epic);
	const lease = holder !== undefined && holder !== actor
		? (leaseExpired(epic, now) ? await takeOverLeadLease(runId, holder, actor, now, cwd) : "held-by-other")
		: await claimLeadLease(runId, actor, now, cwd, true);
	if (lease === "written") return { lease };
	if (lease === "held-by-other") {
		return { lease: { failed: `run epic ${runId} is leased to ${holder ?? "another lead"} (${leaseState(epic, now)}); /orchestrate-resume adopts it once it lapses, or stop the other lead` } };
	}
	return { lease };
}

/**
 * Renew this session's lead lease on the bound run epic, on activity: the same fenced
 * renewal a worker gets, so no read precedes it. `held-by-other` means a replacement
 * lead holds the epic and this session must stop dispatching. `no-run` is a repository
 * without a bound run: nothing to renew.
 */
export async function renewLeadLease(cwd: string, sessionId: string, now = Date.now()): Promise<LeadLeaseRenewal> {
	const actor = leadActor(sessionId);
	const marker = await readActiveRun(cwd);
	if (marker === null || marker.run_id === PENDING) return { outcome: "no-run", actor };
	const run = marker.run_id;
	const lease = await claimLeadLease(run, actor, now, cwd, false);
	return { outcome: lease === "written" ? "renewed" : lease === "held-by-other" ? "held-by-other" : "failed", actor, run };
}

/** What taking over a run did. */
export type AdoptOutcome =
	| { kind: "adopted"; run: string; from: string | undefined }
	| { kind: "already-lead"; run: string }
	| { kind: "held-by-other"; run: string; reason: string }
	| { kind: "refused"; run: string; reason: string }
	| { kind: "no-run" };

/**
 * Take over a run whose lead lease has lapsed: what `/orchestrate-resume` does before it
 * sweeps the run's claims. Binding does the same for the lease alone.
 *
 * Three steps, each fenced: a fresh read of the epic; if the lease has lapsed, a release
 * as the OLD lead (`--actor <old> --claim --assignee "" --status open`, refused once
 * anyone else holds the epic); then a claim as the new lead (refused if another adopter
 * got there first). Two adopters racing a lapsed lease therefore produce exactly one
 * lead. Adoption is refused while the old lease is live, because a slow lead is not a
 * dead one.
 *
 * The TTL-only rule. Everywhere else, a lapsed lease alone releases no claim: the
 * spawner that holds the claimant in its `AgentRegistry` decides, and a holder absent
 * from that registry is unknown, never dead. The adopting lead is the one exception,
 * because the spawner chain that could have judged is gone with the old lead: after
 * adoption, `resumeRun` reads each in-flight claim fresh and releases those whose lease
 * has lapsed, on the lease alone. The worst case is bounded and visible: a live worker
 * released in error re-claims on its next renewal and leaves one stray `RECOVERED`, or
 * loses to a new claimant and is stopped by G2's ownership check.
 */
export async function adoptRun(cwd: string, sessionId: string, now = Date.now()): Promise<AdoptOutcome> {
	const actor = leadActor(sessionId);
	const marker = await readActiveRun(cwd);
	if (marker === null || marker.run_id === PENDING) return { kind: "no-run" };
	const run = marker.run_id;
	const epic = await bdShow(run, undefined, cwd, { fresh: true });
	if (epic === null) return { kind: "refused", run, reason: `run epic ${run} could not be read` };
	const holder = epicHolder(epic);
	if (holder === actor) return { kind: "already-lead", run };
	if (holder !== undefined && !leaseExpired(epic, now)) {
		return { kind: "held-by-other", run, reason: `run epic ${run} is leased to ${holder}; ${leaseState(epic, now)}` };
	}
	const lease = holder === undefined
		? await claimLeadLease(run, actor, now, cwd, true)
		: await takeOverLeadLease(run, holder, actor, now, cwd);
	if (lease === "written") return { kind: "adopted", run, from: holder };
	if (lease === "held-by-other") return { kind: "held-by-other", run, reason: `another lead adopted ${run} first` };
	return { kind: "refused", run, reason: lease.failed };
}

/**
 * The `in_progress` beads beneath `rootId` at any depth.
 *
 * `bd list --parent` answers direct children only (measured on bd 1.2.2), and a run's
 * claims sit on tasks two levels below the run epic, under features that stay `open`
 * while their tasks are worked. So the store is read once and walked here. A parent
 * cycle is stopped by `seen`, and a closed container still carries the chain, which is
 * why the read below asks for every status.
 */
export function inFlightDescendants(beads: readonly BdBead[], rootId: string): BdBead[] {
	const childrenOf = new Map<string, BdBead[]>();
	for (const bead of beads) {
		if (typeof bead.parent !== "string") continue;
		const siblings = childrenOf.get(bead.parent);
		if (siblings) siblings.push(bead);
		else childrenOf.set(bead.parent, [bead]);
	}
	const inFlight: BdBead[] = [];
	const seen = new Set<string>([rootId]);
	const queue = [rootId];
	for (let next = 0; next < queue.length; next++) {
		for (const child of childrenOf.get(queue[next]!) ?? []) {
			if (seen.has(child.id)) continue;
			seen.add(child.id);
			if (child.status === "in_progress") inFlight.push(child);
			queue.push(child.id);
		}
	}
	return inFlight;
}

/** The one store read every walk below starts from: every bead, event records excluded. */
const STORE_LIST = ["list", "--status", "all", "--exclude-type", "event", "--limit", "0", "--json"];

/**
 * End a run: remove the marker once it names `runId`.
 *
 * A marker outliving its run keeps injecting the protocol into every `orc-*` session
 * in the repository and refuses the next start, so this is how a run ends. Beads still
 * `in_progress` anywhere beneath the epic are the reason to refuse: their claims would
 * lose the supervision the marker arms. `force` skips that check for a run whose beads
 * are already gone or unreadable. The lock is released, and its file removed, by the
 * same exclusion that guards every marker write.
 */
export async function closeRun(cwd: string, runId: string, options: { force?: boolean } = {}): Promise<void> {
	if (!RUN_ID_RE.test(runId)) throw new Error(`run id must be a Beads identifier, got ${JSON.stringify(runId)}`);
	await withMarkerLock(cwd, async () => {
		const existing = await readActiveRunStrict(cwd);
		if (existing === null) throw new Error("no active-run marker to close");
		if (existing.run_id !== runId) {
			throw new Error(existing.run_id === PENDING
				? `active-run marker is pending, not bound to ${runId}; close it as ${PENDING}`
				: `active-run marker is bound to ${existing.run_id}, not ${runId}`);
		}
		// A pending marker has no epic and so no children to protect.
		if (options.force !== true && runId !== PENDING) {
			resetReadBudget();
			// Event beads are `bd set-state`'s closed transition records; they never carry a claim.
			const beads = await bdListChecked(STORE_LIST, undefined, cwd);
			if (beads === null) throw new Error(`in-flight beads under ${runId} could not be read; pass --force to close without that check`);
			const inFlight = inFlightDescendants(beads, runId);
			if (inFlight.length > 0) {
				throw new Error(`${inFlight.length} bead${inFlight.length === 1 ? "" : "s"} under ${runId} still in_progress (${inFlight.map(bead => bead.id).join(", ")}); pass --force to close anyway`);
			}
		}
		await fs.rm(markerPath(cwd), { force: true });
	});
}

// ============================================================================
// Start
// ============================================================================

/** What `/orchestrate-start` was asked to bind: an epic that exists, or one to create. */
export type StartTarget = { epic: string } | { title: string };

/** What starting did. Every field but `run` is something the operator may need to act on. */
export interface StartResult {
	run: string;
	/** The epic was created here from a `--new` title. */
	created: boolean;
	probe: StoreProbe;
	lease: BindResult["lease"];
	/** The run epic's `schema` stamp, and `run_id`/`artifacts` for a created epic. */
	stamp: "written" | { failed: string };
	landing: LandingRecord;
}

const execFileAsync = promisify(execFile);

/** One git read at `cwd`, or `undefined` when git could not answer; never throws. */
async function gitRead(cwd: string, args: readonly string[]): Promise<string | undefined> {
	try {
		const env = { ...process.env };
		// Repository-selection overrides must not describe another checkout as this run's.
		for (const name of Object.keys(env)) if (name.startsWith("GIT_")) delete env[name];
		const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { env, timeout: 10_000 });
		const value = stdout.trim();
		return value.length > 0 ? value : undefined;
	} catch {
		return undefined;
	}
}

/** The id a `bd create --json` answer names, or `undefined` when it names none. */
function createdId(stdout: string): string | undefined {
	try {
		const parsed: unknown = JSON.parse(stdout.slice(Math.max(0, stdout.indexOf("{"))));
		const record = parsed !== null && typeof parsed === "object" && "data" in parsed ? parsed.data : parsed;
		const id = record !== null && typeof record === "object" && "id" in record ? record.id : undefined;
		return typeof id === "string" && RUN_ID_RE.test(id) ? id : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Create the run epic from the checkout: `primary_branch` and `base_sha` are what the
 * landing sweep and the fix beads read, `origin_actor` is the lead. `run_id` and
 * `artifacts` need the id and are stamped by the caller.
 */
async function createRunEpic(cwd: string, title: string, actor: string): Promise<string> {
	const [branch, sha] = await Promise.all([gitRead(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]), gitRead(cwd, ["rev-parse", "HEAD"])]);
	const metadata: Record<string, string> = { origin_actor: actor };
	if (branch !== undefined) metadata.primary_branch = branch;
	if (sha !== undefined) metadata.base_sha = sha;
	const created = await bdRun(["create", title, "--type", "epic", "--actor", actor, "--metadata", JSON.stringify(metadata), "--json"], EPIC_WRITE_TIMEOUT_MS, cwd);
	if (created === null) throw new Error("run epic not created: bd did not answer");
	if (created.code !== 0) throw new Error(`run epic not created: ${created.stderr.trim() || `bd exited ${created.code}`}`);
	const id = createdId(created.stdout);
	if (id === undefined) throw new Error("run epic not created: bd create answered without an id");
	return id;
}

/** One unfenced metadata write on the epic; the fields merge per key, so nothing else moves. */
async function stampEpic(runId: string, fields: Record<string, unknown>, cwd: string): Promise<"written" | { failed: string }> {
	const written = await bdRun(["update", runId, "--metadata", JSON.stringify(fields)], EPIC_WRITE_TIMEOUT_MS, cwd);
	if (written === null) return { failed: "bd did not answer" };
	return written.code === 0 ? "written" : { failed: written.stderr.trim() || `bd exited ${written.code}` };
}

/**
 * Start a run: locate and probe the store, create or verify the epic, write the marker
 * bound, take the lead lease, stamp the epic, record the landing capabilities. Throws on
 * every refusal before the marker is written; after it, failures are reported in the
 * result, because the run is active by then and a partial stamp is not a failed start.
 *
 * Refused: a marker another session wrote (that run is resumed or stopped, never
 * overwritten), a database `bd where` cannot name, a store that is locked or corrupted
 * (`slow` starts, and says so), a second epic for a run this session already has. The
 * session's own run restarts idempotently: the same id re-leases and re-records.
 */
export async function startRun(cwd: string, sessionId: string, target: StartTarget | undefined): Promise<StartResult> {
	const existing = await readActiveRunStrict(cwd);
	let runId: string | undefined;
	if (existing !== null && existing.run_id !== PENDING) {
		if (existing.session_id !== sessionId) {
			const who = existing.session_id === undefined ? "an earlier session" : `session ${existing.session_id}`;
			throw new Error(`a run is already active in this checkout: ${existing.run_id}, started by ${who}; /orchestrate-resume adopts it once its lead lease lapses, /orchestrate-stop ends it`);
		}
		if (target !== undefined && "title" in target) {
			throw new Error(`a run is already active in this checkout: ${existing.run_id}; /orchestrate-stop ends it before a new epic is created`);
		}
		if (target !== undefined && target.epic !== existing.run_id) {
			throw new Error(`active-run marker is already bound to ${existing.run_id}, not ${target.epic}`);
		}
		runId = existing.run_id;
	} else if (target === undefined) {
		throw new Error('no run to restart; /orchestrate-start <epic-id> binds an epic, /orchestrate-start --new "<title>" creates one');
	} else if ("epic" in target) {
		if (!RUN_ID_RE.test(target.epic)) throw new Error(`run id must be a Beads identifier, got ${JSON.stringify(target.epic)}`);
		runId = target.epic;
	}

	// Refusing here is the point. Starting arms enforcement for every agent the run
	// spawns, and the database recorded here is what every isolated copy redirects its
	// own `.beads` to; a run started without one would leave each copy writing to a
	// store nobody else reads.
	const beads = await locateBeadsDir(cwd);
	if (!beads.ok) throw new Error(`run not started: ${beads.reason}`);
	let probe: StoreProbe;
	try {
		probe = await probeStore(beads.beadsDir);
	} catch (error) {
		throw new Error(`run not started: the store at ${beads.beadsDir} could not be probed: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (probe.state === "locked") {
		throw new Error(`run not started: the store at ${beads.beadsDir} is locked by ${probe.holder}; stop that writer first`);
	}
	if (probe.state === "corrupted") {
		throw new Error(`run not started: the store at ${beads.beadsDir} is corrupted (${probe.detail}); recover it first`);
	}

	const actor = leadActor(sessionId);
	const created = runId === undefined;
	if (runId === undefined) runId = await createRunEpic(cwd, (target as { title: string }).title, actor);
	let lease: BindResult["lease"];
	try {
		lease = (await bindRun(cwd, runId, sessionId, beads.beadsDir)).lease;
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(created ? `run epic ${runId} was created but the run did not start: ${reason}; /orchestrate-start ${runId} retries` : reason);
	}
	// The epic records the schema its run was started under, so a later plugin can tell
	// what it is resuming (C-OPS-08). A created epic also gets the handle and artifacts
	// directory the references describe; an adopted one keeps the operator's.
	const fields: Record<string, unknown> = { schema: MARKER_SCHEMA };
	if (created) {
		const artifacts = path.join(cwd, ".orchestration", runId, "artifacts");
		await fs.mkdir(artifacts, { recursive: true }).catch(() => { });
		fields.run_id = runId;
		fields.artifacts = artifacts;
	}
	const stamp = await stampEpic(runId, fields, cwd);
	// Landing capabilities are the durable consequence of a run having an epic to carry
	// them: probed once here, read by every sweep. A failed probe leaves the start
	// standing and the sweep in `direct` mode, said where the operator reads.
	const landing = await recordLandingCapabilities(cwd, runId);
	return { run: runId, created, probe, lease, stamp, landing };
}

// ============================================================================
// Resume
// ============================================================================

/** The sweep of in-flight claims after adoption, by bead id. */
export interface ClaimSweep {
	/** Released under the TTL-only rule: lease lapsed, `RECOVERED` written. */
	released: string[];
	/** Lease live, or unknowable: left with its holder. */
	kept: string[];
	/** The release was refused or did not land; the reason follows the id. */
	failed: string[];
}

export type ResumeOutcome =
	| { kind: "resumed"; run: string; adopted: boolean; from: string | undefined; migrated: boolean; sweep: ClaimSweep | "unread" }
	| { kind: "held-by-other"; run: string; reason: string }
	| { kind: "refused"; run?: string; reason: string }
	| { kind: "no-run"; reason: string };

/**
 * Release every in-flight claim beneath the run whose lease has lapsed, on the lease
 * alone (the adopting lead's exception, documented on `adoptRun`). Each bead is read
 * fresh before the decision, so a renewal that landed since the list was taken keeps its
 * claim.
 */
export async function sweepLapsedClaims(cwd: string, run: string, actor: string, now: number): Promise<ClaimSweep | "unread"> {
	const beads = await bdListChecked(STORE_LIST, undefined, cwd);
	if (beads === null) return "unread";
	const sweep: ClaimSweep = { released: [], kept: [], failed: [] };
	for (const listed of inFlightDescendants(beads, run)) {
		const bead = await bdShow(listed.id, undefined, cwd, { fresh: true });
		if (bead === null) {
			sweep.failed.push(`${listed.id}: could not be read`);
			continue;
		}
		const holder = epicHolder(bead);
		if (holder === undefined || !leaseExpired(bead, now)) {
			sweep.kept.push(bead.id);
			continue;
		}
		const released = await releaseDeadClaim(bead.id, holder, {
			cause: `${leaseState(bead, now)}; no live session renewed it; released by ${actor}`,
			recoveredBy: actor,
		}, cwd);
		if (released === "released" || released === "comment-failed") sweep.released.push(bead.id);
		else sweep.failed.push(`${bead.id}: ${released === "held-by-other" ? `a successor holds it` : "the store did not answer"}`);
	}
	return sweep;
}

/**
 * Take over the run in this checkout: adopt its lead lease once the previous lead's has
 * lapsed, record this session on the marker, migrate a marker written before
 * `schema_version` existed (rewritten in this shape, the epic stamped `schema`), then
 * release the in-flight claims whose lease has lapsed. A marker a newer plugin wrote is
 * refused by `readMarker`; a live lease is refused with its holder and state, and that
 * refusal is recorded on the epic so the holder's `/orchestrate-status` shows it.
 */
export async function resumeRun(cwd: string, sessionId: string, now = Date.now()): Promise<ResumeOutcome> {
	const actor = leadActor(sessionId);
	let marker: MarkerRead | null;
	try {
		marker = await readMarker(cwd);
	} catch (error) {
		return { kind: "refused", reason: error instanceof Error ? error.message : String(error) };
	}
	if (marker === null) return { kind: "no-run", reason: `no active run: ${markerPath(cwd)} is absent; /orchestrate-start starts one` };
	if (marker.run.run_id === PENDING) {
		return { kind: "no-run", reason: "the marker is pending, written by an older plugin release before an epic existed; /orchestrate-start <epic-id> binds it, /orchestrate-stop removes it" };
	}
	resetReadBudget();
	const adopted = await adoptRun(cwd, sessionId, now);
	switch (adopted.kind) {
		case "no-run": return { kind: "no-run", reason: `no active run: ${markerPath(cwd)} is absent` };
		case "refused": return adopted;
		case "held-by-other":
			await bdRun(["comment", adopted.run, `NOTE adoption refused: ${actor} asked to adopt ${adopted.run}; ${adopted.reason}`, "--actor", actor], EPIC_WRITE_TIMEOUT_MS, cwd);
			return adopted;
		case "adopted":
		case "already-lead":
			break;
	}
	const run = adopted.run;
	if (marker.legacy || marker.run.session_id !== sessionId) {
		try {
			await withMarkerLock(cwd, async () => {
				const state: ActiveRun = { schema_version: MARKER_SCHEMA, run_id: run, session_id: sessionId };
				if (marker.run.beads_dir !== undefined) state.beads_dir = marker.run.beads_dir;
				await writeMarker(markerPath(cwd), state);
			});
		} catch (error) {
			return { kind: "refused", reason: `adopted ${run} but the marker could not be rewritten: ${error instanceof Error ? error.message : String(error)}` };
		}
	}
	if (marker.legacy) await stampEpic(run, { schema: MARKER_SCHEMA }, cwd);
	const sweep = await sweepLapsedClaims(cwd, run, actor, now);
	return { kind: "resumed", run, adopted: adopted.kind === "adopted", from: adopted.kind === "adopted" ? adopted.from : actor, migrated: marker.legacy, sweep };
}

// ============================================================================
// Stop
// ============================================================================

export interface StopResult {
	run: string;
	/** What happened to this session's lead lease on the epic. */
	lease: "released" | "not-held" | "epic-closed" | { failed: string };
	/** In-flight beads named in the `NOTE` a forced stop leaves on the epic. */
	abandoned: string[];
}

/**
 * End the run: refuse while another lead's lease is live (that lead stops it), remove the
 * marker under `closeRun`'s in-flight check, then release this session's lead lease.
 * `force` skips the in-flight check and records what it abandoned on the epic first, so
 * the next reader of the epic knows the run was stopped over held claims rather than
 * finished. A pending marker is removed without a lease to release.
 */
export async function stopRun(cwd: string, sessionId: string, options: { force?: boolean } = {}, now = Date.now()): Promise<StopResult> {
	const marker = await readActiveRunStrict(cwd);
	if (marker === null) throw new Error("no active run to stop");
	const run = marker.run_id;
	if (run === PENDING) {
		await closeRun(cwd, PENDING);
		return { run, lease: "not-held", abandoned: [] };
	}
	const actor = leadActor(sessionId);
	resetReadBudget();
	const epic = await bdShow(run, undefined, cwd, { fresh: true });
	const holder = epic === null ? undefined : epicHolder(epic);
	if (epic !== null && holder !== undefined && holder !== actor && !leaseExpired(epic, now) && options.force !== true) {
		throw new Error(`run ${run} is leased to ${holder} (${leaseState(epic, now)}); that lead stops it, or pass --force`);
	}
	// Read what a forced stop abandons before the marker goes, note it after: a refused
	// close must leave no note claiming the run was stopped.
	const beads = options.force === true ? await bdListChecked(STORE_LIST, undefined, cwd) : [];
	const abandoned = beads === null ? [] : inFlightDescendants(beads, run).map(bead => bead.id);
	await closeRun(cwd, run, options);
	if (options.force === true) {
		const detail = beads === null ? "in-flight beads could not be read" : abandoned.length === 0 ? "no bead in_progress" : `${abandoned.length} in_progress: ${abandoned.join(", ")}`;
		await bdRun(["comment", run, `NOTE run stopped with --force by ${actor}; ${detail}`, "--actor", actor], EPIC_WRITE_TIMEOUT_MS, cwd);
	}
	let lease: StopResult["lease"];
	if (epic === null || holder !== actor) lease = "not-held";
	else if (runLiveness(epic).kind !== "active") lease = "epic-closed";
	else {
		const released = await fencedEpicWrite(run, actor, ["--assignee", "", "--status", "open"], cwd, true);
		lease = released === "written" ? "released" : released === "held-by-other" ? { failed: "another lead holds the epic" } : released;
	}
	return { run, lease, abandoned };
}

// ============================================================================
// Answer
// ============================================================================

/** Verbs that hold a bead for a human; an answer releases the hold. */
const HOLD_VERBS: Record<string, true> = { ASK: true, ESCALATED: true, FAILED: true };

/** The verb token and what `commentVerb` strips before it: markdown's bullets, quotes and emphasis. */
const VERB_TOKEN = /^[\s\-*+>`_~]*\S+\s*/;

/** `NOTE ANSWER ...`: the verb is the grammar's, the second token says what the note is. */
function isAnswer(text: string): boolean {
	return commentVerb(text) === "NOTE" && commentVerb(text.replace(VERB_TOKEN, "")) === "ANSWER";
}

/** The `question:` field of an ASK, else its first line after the verb, cut for one notice line. */
function askQuestion(text: string): string {
	const lines = text.split("\n").map(line => line.trim()).filter(line => line.length > 0);
	const question = lines.find(line => /^question:/i.test(line))?.replace(/^question:\s*/i, "")
		?? lines[0]?.replace(VERB_TOKEN, "")
		?? "";
	return question.length > 120 ? `${question.slice(0, 117)}...` : question;
}

/** The latest hold comment (`ASK`/`ESCALATED`) with no `NOTE ANSWER` after it. */
function openAsk(comments: readonly BdComment[]): BdComment | undefined {
	let hold: BdComment | undefined;
	for (const comment of comments) {
		const verb = commentVerb(comment.text);
		if (verb === "ASK" || verb === "ESCALATED") hold = comment;
		else if (isAnswer(comment.text)) hold = undefined;
	}
	return hold;
}

/** Registry answering whether a claim holder is an agent of this process, and in what state. */
export interface HolderRegistry {
	get(id: string): { status: AgentStatus } | undefined;
}

/** A wake, as OMP's IRC bus delivers it: revives a parked recipient, wakes an idle one. */
export type Wake = (to: string, body: string) => Promise<{ outcome: string; error?: string }>;

/** What `/orchestrate-answer` did with the hold, once the note landed. */
export type AnswerHold =
	| { kind: "woken"; holder: string; outcome: string }
	| { kind: "wake-failed"; holder: string; error: string }
	| { kind: "requeued"; holder: string | undefined; gates: string[] }
	| { kind: "requeue-refused"; holder: string; reason: string }
	| { kind: "kept"; reason: string };

/** The extension's `bd` dependencies `/orchestrate-answer` reaches past the store. */
export interface AnswerDeps {
	registry: HolderRegistry;
	wake: Wake;
}

/**
 * Answer a bead's question: one `NOTE ANSWER` comment, then whatever moves the hold.
 *
 * A holder this process knows as a live or parked agent is woken through the IRC bus
 * -- an architect parked on its epic revives and reads the answer off the bead. A
 * holder absent from the registry has exited (workers yield after `ASK`/`FAILED`), so a
 * `blocked` bead whose last hold verb is one of those is requeued: assignee cleared,
 * status opened, and any open human gate blocking it resolved, so `bd ready --claim`
 * offers it to the next worker, answer in hand. The release is unfenced by necessity and
 * safe by construction: bd's `--claim` fence applies to `in_progress` beads only
 * (measured on 1.2.2: "not claimable: status blocked"), and a blocked bead is one no
 * successor can have claimed in the meantime. A bead in any other state keeps the note
 * and nothing else.
 */
export async function answerBead(cwd: string, sessionId: string, beadId: string, text: string, deps: AnswerDeps): Promise<AnswerHold> {
	if (!RUN_ID_RE.test(beadId)) throw new Error(`bead id must be a Beads identifier, got ${JSON.stringify(beadId)}`);
	const actor = leadActor(sessionId);
	resetReadBudget();
	const bead = await bdShow(beadId, undefined, cwd, { fresh: true });
	if (bead === null) throw new Error(`bead ${beadId} could not be read; nothing recorded`);
	const comments = await bdCommentsChecked(beadId);
	const noted = await bdRun(["comment", beadId, `NOTE ANSWER ${beadId}: ${text}`, "--actor", actor], EPIC_WRITE_TIMEOUT_MS, cwd);
	if (noted === null || noted.code !== 0) {
		throw new Error(`answer not recorded on ${beadId}: ${noted === null ? "bd did not answer" : noted.stderr.trim() || `bd exited ${noted.code}`}`);
	}

	const holder = epicHolder(bead);
	const state = holder === undefined ? undefined : deps.registry.get(holder)?.status;
	if (holder !== undefined && state !== undefined && state !== "aborted") {
		const receipt = await deps.wake(holder, `ANSWER recorded on ${beadId}; read \`bd comments ${beadId}\` and resume`);
		return receipt.outcome === "failed"
			? { kind: "wake-failed", holder, error: receipt.error ?? "delivery failed" }
			: { kind: "woken", holder, outcome: receipt.outcome };
	}
	if (comments === null) return { kind: "kept", reason: `comments on ${beadId} could not be read, so the hold is unknown; nothing requeued` };
	const hold = comments.findLast(comment => HOLD_VERBS[commentVerb(comment.text)] === true);
	if (bead.status !== "blocked" || hold === undefined) {
		return { kind: "kept", reason: `${beadId} is ${bead.status ?? "of unknown status"} with ${hold === undefined ? "no hold verb" : `last hold ${commentVerb(hold.text)}`}; nothing requeued` };
	}
	const requeue = await bdRun(["update", beadId, "--status", "open", "--assignee", "", "--actor", actor], EPIC_WRITE_TIMEOUT_MS, cwd);
	if (requeue === null || requeue.code !== 0) {
		return { kind: "requeue-refused", holder: holder ?? "nobody", reason: requeue === null ? "bd did not answer" : requeue.stderr.trim() || `bd exited ${requeue.code}` };
	}
	const gates: string[] = [];
	for (const dependency of Array.isArray(bead.dependencies) ? bead.dependencies : []) {
		if (dependency === null || typeof dependency !== "object") continue;
		const gate = dependency as Record<string, unknown>;
		if (gate.issue_type !== "gate" || gate.status !== "open" || typeof gate.id !== "string") continue;
		if (gate.await_type !== undefined && gate.await_type !== "human") continue;
		const resolved = await bdRun(["gate", "resolve", gate.id, "--reason", `ANSWER by ${actor} on ${beadId}`, "--actor", actor], EPIC_WRITE_TIMEOUT_MS, cwd);
		if (resolved?.code === 0) gates.push(gate.id);
	}
	return { kind: "requeued", holder, gates };
}

// ============================================================================
// Status
// ============================================================================

/** What `/orchestrate-status` prints. `healthy` is bound and the epic active -- nothing less. */
export interface RunStatusReport {
	lines: string[];
	healthy: boolean;
}

/**
 * The attention items one store walk yields: lapsed claims, landings the sweep bounced or
 * blocked, and open questions on blocked beads. Each open question costs one comment
 * read; the read budget bounds how many a single status pays for, and the rest are named
 * as unread rather than dropped.
 */
async function storeAttention(cwd: string, run: string, now: number): Promise<string[]> {
	const beads = await bdListChecked(STORE_LIST, undefined, cwd);
	if (beads === null) return ["- beads unreadable: lapsed leases, landings and open questions are unknown"];
	const items: string[] = [];
	for (const bead of inFlightDescendants(beads, run)) {
		if (leaseExpired(bead, now)) items.push(`- lease lapsed: ${bead.id} held by ${epicHolder(bead) ?? "nobody"}, ${leaseState(bead, now)}`);
	}
	for (const bead of beads) {
		if (bead.status === "closed") continue;
		const landing = metadataString(bead, "landing_state");
		if (landing === "bounced" || landing === "closed") {
			const fix = metadataString(bead, "landing_fix");
			items.push(`- landing BOUNCED: ${bead.id}${fix === undefined ? "" : ` (fix ${fix})`}`);
		}
		const notice = metadataString(bead, "landing_notice");
		if (notice !== undefined) items.push(`- landing BLOCKED: ${bead.id} (${notice})`);
	}
	for (const bead of beads) {
		if (bead.status !== "blocked" || bead.comment_count === 0) continue;
		const comments = await bdCommentsChecked(bead.id);
		if (comments === null) {
			items.push(`- ${bead.id} is blocked; its comments could not be read`);
			continue;
		}
		const ask = openAsk(comments);
		if (ask !== undefined) items.push(`- ${commentVerb(ask.text)} ${bead.id} (${ask.author ?? "unknown"}): ${askQuestion(ask.text)}`);
	}
	return items;
}

/** The epic's own comments: the latest adoption the run refused, the latest WARN. */
async function epicAttention(run: string): Promise<string[]> {
	const comments = await bdCommentsChecked(run);
	if (comments === null) return [`- comments on ${run} could not be read`];
	const items: string[] = [];
	const refused = comments.findLast(comment => /^\W*NOTE\s+adoption refused/i.test(comment.text));
	if (refused !== undefined) items.push(`- ${refused.text.replace(/^\W*NOTE\s+/i, "").split("\n")[0]}`);
	const warned = comments.findLast(comment => commentVerb(comment.text) === "WARN");
	if (warned !== undefined) items.push(`- ${warned.text.split("\n")[0]}`);
	return items;
}

/**
 * The marker, the epic's liveness, the lead lease, then an Attention section: everything
 * a human is needed for or should know -- lapsed leases with their holder, landings the
 * sweep bounced or blocked, open `ASK`/`ESCALATED` questions, an adoption this run
 * refused, the last `WARN`, and a store the probe does not report `free`. Reads only.
 */
export async function runStatusReport(cwd: string, now = Date.now()): Promise<RunStatusReport> {
	const marker = markerPath(cwd);
	let run: ActiveRun | null;
	try {
		run = await readActiveRunStrict(cwd);
	} catch (error) {
		return { lines: [`marker ${marker}: ${error instanceof Error ? error.message : String(error)}`], healthy: false };
	}
	if (run === null) return { lines: [`no active run: ${marker} is absent; /orchestrate-start starts one`], healthy: false };
	const session = run.session_id === undefined ? "" : `, session ${run.session_id}`;
	if (run.run_id === PENDING) {
		return { lines: [`run: pending (marker ${marker}${session}, written by an older plugin release); /orchestrate-start <epic-id> binds it, /orchestrate-stop removes it`], healthy: false };
	}
	const lines = [`run: bound to ${run.run_id} (marker ${marker}${session})`];
	resetReadBudget();
	const epic = await bdShow(run.run_id, undefined, cwd);
	const liveness = runLiveness(epic);
	switch (liveness.kind) {
		case "active": lines.push(`epic ${run.run_id}: ${liveness.status}`); break;
		case "closed": lines.push(`epic ${run.run_id}: closed; supervision is off, and /orchestrate-stop removes the marker`); break;
		case "unverified": lines.push(`epic ${run.run_id}: status could not be verified (bd unavailable or bead missing); child supervision is suspended until it can`); break;
		case "unknown": lines.push(`epic ${run.run_id}: status ${JSON.stringify(liveness.status)} is not a run status; child supervision is suspended`); break;
	}
	const attention: string[] = [];
	if (epic !== null) {
		const lead = epicHolder(epic);
		lines.push(lead === undefined
			? `lead: none recorded; /orchestrate-start ${run.run_id} stamps this session's lease`
			: `lead: ${lead}, ${leaseState(epic, now)}`);
		if (lead !== undefined && leaseExpired(epic, now)) attention.push(`- lead lease lapsed: ${lead}; /orchestrate-resume adopts the run`);
	}
	if (run.beads_dir !== undefined) {
		try {
			const probe = await probeStore(run.beads_dir);
			if (probe.state === "locked") attention.push(`- store locked by ${probe.holder} (${probe.lock})`);
			else if (probe.state === "corrupted") attention.push(`- store corrupted: ${probe.detail}`);
			else if (probe.state === "slow") attention.push(`- store slow: one read took ${probe.ms} ms`);
		} catch (error) {
			attention.push(`- store probe failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	attention.push(...await storeAttention(cwd, run.run_id, now));
	attention.push(...await epicAttention(run.run_id));
	lines.push(attention.length === 0 ? "attention: none" : "attention:", ...attention);
	return { lines, healthy: liveness.kind === "active" };
}

// ============================================================================
// Commands
// ============================================================================

/** Notification level; `warning` wins over `info`, `error` over both. */
type Level = "info" | "warning" | "error";

function notify(ctx: ExtensionCommandContext, lines: string[], level: Level): void {
	ctx.ui.notify(lines.join("\n"), level);
}

function reason(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Split a command's arguments into words, honouring double quotes around a title. */
function words(args: string): string[] {
	const found: string[] = [];
	for (const match of args.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) found.push(match[1] ?? match[2] ?? match[3] ?? "");
	return found;
}

const START_USAGE = 'usage: /orchestrate-start <epic-id> | --new "<title>"';

/** The start command's arguments as a target, `undefined` for a bare restart, or a usage line. */
function startTarget(args: string): StartTarget | undefined | string {
	const parts = words(args);
	if (parts.length === 0) return undefined;
	if (parts[0] === "--new") {
		const title = parts.slice(1).join(" ").trim();
		return title.length === 0 ? START_USAGE : { title };
	}
	if (parts.length > 1 || parts[0]!.startsWith("--")) return START_USAGE;
	return { epic: parts[0]! };
}

/** The wake OMP's own `hub send` performs, from the lead's seat. */
const ircWake: Wake = (to, body) => IrcBus.global().send({ from: MAIN_AGENT_ID, to, body });

/**
 * The operator commands: start, resume, status, answer, stop. Registration is a
 * function rather than import-time work so the extension entry point owns the order
 * commands appear in, and so tests can import the marker functions without touching the
 * registry. `orchestrate-roster` reads queues, not the marker, and stays with the entry
 * point.
 *
 * `onActivate` runs once a run is active in this session -- after `start` has written
 * the marker with the run's database in it, and after `resume` has adopted -- so the
 * settings preflight in `watchers.ts`, which imports this module, is injected rather
 * than imported. `deps` are the process registry and the wake `answer` reaches for;
 * tests hand in fakes.
 */
export function registerRunCommands(pi: ExtensionAPI, onActivate?: (cwd: string) => Promise<unknown>, deps: Partial<AnswerDeps> = {}): void {
	// The registry is read at answer time, never at registration: OMP owns when its global
	// exists, and a test's fake stands in for the whole of it.
	const answerDeps: AnswerDeps = { registry: deps.registry ?? { get: id => AgentRegistry.global().get(id) }, wake: deps.wake ?? ircWake };

	/** The run is active by now, whatever the hook does; a failing readiness check must not read as a failed start. */
	const activate = async (cwd: string, lines: string[]): Promise<Level> => {
		try {
			await onActivate?.(cwd);
			return "info";
		} catch (error) {
			lines.push(`readiness check failed: ${reason(error)}`);
			return "warning";
		}
	};

	pi.registerCommand("orchestrate-start", {
		description: 'Start a run here: /orchestrate-start <epic-id> binds an existing epic, --new "<title>" creates one; records the database, takes the lead lease, probes landing',
		handler: async (args, ctx) => {
			const target = startTarget(args);
			if (typeof target === "string") {
				ctx.ui.notify(target, "error");
				return;
			}
			const cwd = ctx.sessionManager.getCwd();
			let started: StartResult;
			try {
				started = await startRun(cwd, ctx.sessionManager.getSessionId(), target);
			} catch (error) {
				ctx.ui.notify(reason(error), "error");
				return;
			}
			let level: Level = "info";
			const lines = [`orchestrate run ${started.created ? "started" : "bound"}: ${started.run}${started.created ? " (epic created)" : ""}`];
			if (started.probe.state === "slow") {
				lines.push(`store slow: one read took ${started.probe.ms} ms`);
				level = "warning";
			}
			if (started.lease === "written") lines.push("lead lease stamped");
			else {
				// The start stands; the lease does not. Said where the operator reads, because
				// the lease is what a replacement lead adopts against.
				lines.push(`lead lease not stamped: ${started.lease.failed}`);
				level = "warning";
			}
			if (started.stamp !== "written") {
				lines.push(`epic not stamped: ${started.stamp.failed}`);
				level = "warning";
			}
			if (started.landing.ok) {
				lines.push(started.landing.notice);
				if (started.landing.level === "warning") level = "warning";
			} else {
				lines.push(`landing capabilities not recorded on ${started.run}: ${started.landing.error}; the sweep lands directly on CLEAN`);
				level = "warning";
			}
			if ((await activate(cwd, lines)) === "warning") level = "warning";
			notify(ctx, lines, level);
		},
	});

	pi.registerCommand("orchestrate-resume", {
		description: "Take over the run in this checkout once its lead lease has lapsed; releases in-flight claims whose lease lapsed with the old lead",
		handler: async (_args, ctx) => {
			const cwd = ctx.sessionManager.getCwd();
			const outcome = await resumeRun(cwd, ctx.sessionManager.getSessionId());
			switch (outcome.kind) {
				case "no-run":
				case "refused":
					ctx.ui.notify(outcome.reason, "error");
					return;
				case "held-by-other":
					ctx.ui.notify(`resume refused: ${outcome.reason}`, "error");
					return;
				case "resumed":
					break;
			}
			const lines = [outcome.adopted
				? `orchestrate run ${outcome.run} adopted from ${outcome.from ?? "no recorded lead"}`
				: `orchestrate run ${outcome.run}: this session already leads it`];
			if (outcome.migrated) lines.push(`marker migrated to schema ${MARKER_SCHEMA}`);
			let level: Level = "info";
			if (outcome.sweep === "unread") {
				lines.push("in-flight claims could not be read; none released");
				level = "warning";
			} else {
				const { released, kept, failed } = outcome.sweep;
				lines.push(`claims: ${released.length} released${released.length === 0 ? "" : ` (${released.join(", ")})`}, ${kept.length} kept`);
				if (failed.length > 0) {
					lines.push(`releases failed: ${failed.join("; ")}`);
					level = "warning";
				}
			}
			if ((await activate(cwd, lines)) === "warning") level = "warning";
			notify(ctx, lines, level);
		},
	});

	pi.registerCommand("orchestrate-status", {
		description: "Active run: marker binding, run epic liveness, lead lease, and what needs attention",
		handler: async (_args, ctx) => {
			const report = await runStatusReport(ctx.sessionManager.getCwd());
			ctx.ui.notify(report.lines.join("\n"), report.healthy ? "info" : "warning");
		},
	});

	pi.registerCommand("orchestrate-answer", {
		description: "Answer a bead's question: /orchestrate-answer <bead> <text> records NOTE ANSWER, wakes a parked holder or requeues the bead",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const split = trimmed.search(/\s/);
			const beadId = split === -1 ? trimmed : trimmed.slice(0, split);
			const text = split === -1 ? "" : trimmed.slice(split).trim();
			if (beadId.length === 0 || text.length === 0) {
				ctx.ui.notify("usage: /orchestrate-answer <bead> <text>", "error");
				return;
			}
			let hold: AnswerHold;
			try {
				hold = await answerBead(ctx.sessionManager.getCwd(), ctx.sessionManager.getSessionId(), beadId, text, answerDeps);
			} catch (error) {
				ctx.ui.notify(reason(error), "error");
				return;
			}
			const noted = `answer recorded on ${beadId}`;
			switch (hold.kind) {
				case "woken": notify(ctx, [noted, `${hold.holder} ${hold.outcome}`], "info"); return;
				case "wake-failed": notify(ctx, [noted, `${hold.holder} could not be woken: ${hold.error}; its claim stands`], "warning"); return;
				case "requeued":
					notify(ctx, [noted, `${beadId} requeued${hold.holder === undefined ? "" : ` (released from ${hold.holder})`}${hold.gates.length === 0 ? "" : `; human gate${hold.gates.length === 1 ? "" : "s"} ${hold.gates.join(", ")} resolved`}`], "info");
					return;
				case "requeue-refused": notify(ctx, [noted, `${beadId} not requeued: ${hold.reason}`], "warning"); return;
				case "kept": notify(ctx, [noted, hold.reason], "info"); return;
			}
		},
	});

	pi.registerCommand("orchestrate-stop", {
		description: "End the run: release this session's lead lease and remove the marker once no bead beneath the epic, at any depth, is in_progress (--force skips the check and notes what it abandoned)",
		handler: async (args, ctx) => {
			const parts = words(args);
			if (parts.some(word => word !== "--force")) {
				ctx.ui.notify("usage: /orchestrate-stop [--force]", "error");
				return;
			}
			let stopped: StopResult;
			try {
				stopped = await stopRun(ctx.sessionManager.getCwd(), ctx.sessionManager.getSessionId(), { force: parts.length > 0 });
			} catch (error) {
				ctx.ui.notify(reason(error), "error");
				return;
			}
			const lines = [`orchestrate run ${stopped.run} stopped; marker removed`];
			let level: Level = "info";
			if (stopped.lease === "released") lines.push("lead lease released");
			else if (stopped.lease === "epic-closed") lines.push("epic already closed; no lease to release");
			else if (stopped.lease === "not-held") lines.push("this session held no lead lease");
			else {
				lines.push(`lead lease not released: ${stopped.lease.failed}`);
				level = "warning";
			}
			if (stopped.abandoned.length > 0) {
				lines.push(`abandoned in_progress: ${stopped.abandoned.join(", ")}`);
				level = "warning";
			}
			notify(ctx, lines, level);
		},
	});
}
