/**
 * The active-run marker: whether this repository is under an orchestrate run,
 * and which run bead that run answers to.
 *
 * Replaces the marker halves of `orchestrator-run-activate.py` and
 * `orchestrate_run_marker.py`. Marker reads stay cheap enough for every gated
 * call; `isBoundRunActive` owns the explicit Beads liveness probe used only by
 * child supervision.
 *
 * Two properties the scripts established and this keeps:
 *
 * Activation is idempotent and never clobbers a binding. A lead may re-run
 * activation at any point in a run, so `activateRun` reads the existing run id
 * back and rewrites it; only a markerless repository gets the `pending`
 * sentinel. Binding, conversely, refuses to move an already-bound marker to a
 * different id -- a second run epic in the same tree is a mistake, not a
 * retarget -- while rebinding to the same id stays a no-op so a retried command
 * is harmless. Binding also refuses an epic Beads cannot show as open: a bound id
 * that resolves to nothing would suspend supervision for the whole run.
 *
 * A run ends when `closeRun` removes the marker; nothing else does. Writers hold an
 * exclusive sibling lock through read/validate/rename. Readers see atomic snapshots;
 * a leftover lock requires explicit operator reconciliation.
 */

import fs, { type FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { ensureBeadsPath } from "./beads-mode";
import { type BdBead, bdListChecked, bdShow, resetReadBudget } from "./bd";
import { ensurePatrolWisp, patrolState } from "./supervision";

/**
 * The marker's on-disk shape.
 *
 * A `repo_root` field was written here and read by nothing after the `bd -C` pin was
 * retired. Its rationale was the embedded database `bd` finds by walking up from the cwd,
 * and that hazard is real: it is closed once here instead of on every call, by pinning
 * BEADS_DIR at activation. Every child inherits the environment, so an isolated worker
 * reaches the run's database with no flag of its own. `asActiveRun`
 * keeps only the fields below, so a marker written by an older version still reads.
 */
export interface ActiveRun {
 schema_version: 1;
 run_id: string;
 session_id?: string;
}

/** Run id written before the run epic exists. Bindable; never treated as bound. */
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
 * alone, and reading such a marker as absent would let a bind overwrite a live
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
  return { schema_version: 1, run_id: raw };
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
 if (typeof value === "string") return value.length > 0 ? { schema_version: 1, run_id: value } : null;
 if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
 const record = value as Record<string, unknown>;
 const runId = typeof record.run_id === "string" && record.run_id.length > 0 ? record.run_id : PENDING;
 const sessionId = typeof record.session_id === "string" && record.session_id.length > 0 ? record.session_id : undefined;
 // An unknown key is dropped rather than carried: see the note on ActiveRun.
 const state: ActiveRun = { schema_version: 1, run_id: runId };
 if (sessionId !== undefined) state.session_id = sessionId;
 return state;
}

/** Authority reads distinguish absence from unreadable or malformed markers. */
export async function readActiveRunStrict(cwd: string): Promise<ActiveRun | null> {
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
  if (RUN_ID_RE.test(raw)) return { schema_version: 1, run_id: raw };
  throw new Error("Active-run marker is malformed; reconcile it before activation or binding");
 }
 if (typeof parsed === "string" && RUN_ID_RE.test(parsed)) {
  return { schema_version: 1, run_id: parsed };
 }
 if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
  throw new Error("Active-run marker is malformed; reconcile it before activation or binding");
 }
 const record = parsed as Record<string, unknown>;
 if (typeof record.run_id !== "string" || !RUN_ID_RE.test(record.run_id)
  || (record.schema_version !== undefined && record.schema_version !== 1)
  || (record.session_id !== undefined && (typeof record.session_id !== "string" || record.session_id.length === 0))) {
  throw new Error("Active-run marker is malformed or unsupported; reconcile it before activation or binding");
 }
 const state: ActiveRun = { schema_version: 1, run_id: record.run_id };
 if (typeof record.session_id === "string") state.session_id = record.session_id;
 return state;
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

/**
 * Put this repository under the run protocol, preserving any existing binding.
 * `sessionId` names the activating session; an omitted one keeps whatever the
 * previous activation recorded.
 */
export async function activateRun(cwd: string, sessionId?: string): Promise<ActiveRun> {
 return withMarkerLock(cwd, async () => {
  const existing = await readActiveRunStrict(cwd);
  const session = sessionId ?? existing?.session_id;
  const state: ActiveRun = { schema_version: 1, run_id: existing?.run_id ?? PENDING };
  if (session !== undefined) state.session_id = session;
  await writeMarker(markerPath(cwd), state);
  return state;
 });
}

/** How binding left the S2 patrol: armed, or why the architect must arm it by hand. */
export interface BindResult {
 patrol: "armed" | { failed: string };
}

/**
 * Name the run bead this run answers to. Throws on a refusal -- a malformed id,
 * an epic Beads cannot show as open, no marker to bind, or a marker already bound
 * elsewhere -- so callers surface the reason rather than silently leaving the
 * marker unbound.
 *
 * The epic is read before the marker is written. A typo accepted here would leave
 * `isBoundRunActive` throwing on every child exit, disabling supervision for the
 * whole run while the operator believes it bound; the same rule that governs
 * supervision -- only a positively observed status counts -- governs binding, so a
 * bind with `bd` unreachable is refused rather than trusted.
 *
 * Arming the patrol wisp belongs here rather than in the command handler: the
 * patrol is the durable consequence of a binding existing, so every caller must
 * get it. It is idempotent, and a beads failure must not fail the bind -- an
 * unarmed patrol costs a reconciliation sweep, an unbound marker costs the run --
 * but the failure is returned, not swallowed, so the caller can say so.
 */
export async function bindRun(cwd: string, runId: string): Promise<BindResult> {
 if (!RUN_ID_RE.test(runId)) throw new Error(`run id must be a Beads identifier, got ${JSON.stringify(runId)}`);
 resetReadBudget();
 const liveness = runLiveness(await bdShow(runId, undefined, cwd));
 if (liveness.kind !== "active") {
  throw new Error(liveness.kind === "unverified"
   ? `run epic ${runId} could not be read from Beads; binding refused`
   : `run epic ${runId} has status ${JSON.stringify(liveness.status)}, which cannot host a run; binding refused`);
 }
 await withMarkerLock(cwd, async () => {
  const existing = await readActiveRunStrict(cwd);
  if (existing === null) throw new Error("no active-run marker to bind; run /orchestrate-run first");
  if (existing.run_id !== PENDING && existing.run_id !== runId) {
   throw new Error(`active-run marker is already bound to ${existing.run_id}`);
  }
  await writeMarker(markerPath(cwd), { ...existing, run_id: runId });
 });
 // Binding owns its evidence budget; arming failure must not undo the marker.
 resetReadBudget();
 try {
  await ensurePatrolWisp(runId, cwd);
  return { patrol: "armed" };
 } catch (error) {
  return { patrol: { failed: error instanceof Error ? error.message : String(error) } };
 }
}

/**
 * End a run: remove the marker once it names `runId`.
 *
 * A marker outliving its run keeps injecting the protocol into every `orc-*` session
 * in the repository and refuses the next bind, so this is how a run ends. Children
 * still `in_progress` are the reason to refuse: their claims would lose the supervision
 * the marker arms. `force` skips that check for a run whose beads are already gone or
 * unreadable. The lock is released, and its file removed, by the same exclusion that
 * guards every marker write.
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
   const inFlight = await bdListChecked(["list", "--parent", runId, "--status", "in_progress", "--limit", "0", "--json"], undefined, cwd);
   if (inFlight === null) throw new Error(`in-flight children of ${runId} could not be read; pass --force to close without that check`);
   if (inFlight.length > 0) {
    throw new Error(`${inFlight.length} child${inFlight.length === 1 ? "" : "ren"} of ${runId} still in_progress (${inFlight.map(bead => bead.id).join(", ")}); pass --force to close anyway`);
   }
  }
  await fs.rm(markerPath(cwd), { force: true });
 });
}

/** What `/orchestrate-status` prints. `healthy` is bound, epic active, patrol armed -- nothing less. */
export interface RunStatusReport {
 lines: string[];
 healthy: boolean;
}

/** The marker, the epic's liveness, the patrol. Reads only. */
export async function runStatusReport(cwd: string): Promise<RunStatusReport> {
 const marker = markerPath(cwd);
 let run: ActiveRun | null;
 try {
  run = await readActiveRunStrict(cwd);
 } catch (error) {
  return { lines: [`marker ${marker}: ${error instanceof Error ? error.message : String(error)}`], healthy: false };
 }
 if (run === null) return { lines: [`no active run: ${marker} is absent; /orchestrate-run activates one`], healthy: false };
 const session = run.session_id === undefined ? "" : `, activated by session ${run.session_id}`;
 if (run.run_id === PENDING) {
  return { lines: [`run: pending (marker ${marker}${session}); /orchestrate-bind <epic> binds it`], healthy: false };
 }
 const lines = [`run: bound to ${run.run_id} (marker ${marker}${session})`];
 resetReadBudget();
 const liveness = runLiveness(await bdShow(run.run_id, undefined, cwd));
 switch (liveness.kind) {
  case "active": lines.push(`epic ${run.run_id}: ${liveness.status}`); break;
  case "closed": lines.push(`epic ${run.run_id}: closed; supervision is off, and /orchestrate-close ${run.run_id} removes the marker`); break;
  case "unverified": lines.push(`epic ${run.run_id}: status could not be verified (bd unavailable or bead missing); child supervision is suspended until it can`); break;
  case "unknown": lines.push(`epic ${run.run_id}: status ${JSON.stringify(liveness.status)} is not a run status; child supervision is suspended`); break;
 }
 const patrol = await patrolState(run.run_id, cwd);
 lines.push(patrol === "armed" ? "patrol: armed"
  : patrol === "absent" ? `patrol: absent; /orchestrate-bind ${run.run_id} arms it`
   : "patrol: unknown (the linked-wisp lookup failed)");
 return { lines, healthy: liveness.kind === "active" && patrol === "armed" };
}

/**
 * The marker commands: activate, bind, status, close. Registration is a function
 * rather than import-time work so the extension entry point owns the order commands
 * appear in, and so tests can import the marker functions without touching the
 * registry. `orchestrate-roster` reads queues, not the marker, and stays with the
 * entry point.
 *
 * `onActivate` runs after the marker is written and the database is pinned. The
 * settings preflight lives in `watchers.ts`, which imports this module, so the
 * hook is injected rather than imported.
 */
export function registerRunCommands(pi: ExtensionAPI, onActivate?: (cwd: string) => Promise<unknown>): void {
 pi.registerCommand("orchestrate-run", {
  description: "Activate orchestrate run enforcement in this repository",
  handler: async (_args, ctx) => {
   const cwd = ctx.sessionManager.getCwd();
   // Refusing here is the point. Activation arms enforcement for every agent the run
   // spawns, and bd resolves its database by walking up from the working directory, so
   // a worker in an isolated checkout can reach a database nobody else reads. This
   // pins one path for the run and every child that inherits its environment.
   const beads = await ensureBeadsPath(cwd);
   if (!beads.ok) {
    ctx.ui.notify(`orchestrate run NOT activated: ${beads.reason}`, "error");
    return;
   }
   if (beads.tracked === false) {
    ctx.ui.notify("orchestrate run NOT activated: no active Beads workspace was found", "error");
    return;
   }
   if (beads.note !== undefined) ctx.ui.notify(beads.note, "info");
   try {
    const state = await activateRun(cwd, ctx.sessionManager.getSessionId());
    ctx.ui.notify(
     state.run_id === PENDING
      ? "orchestrate run active, awaiting a run epic (/orchestrate-bind <run-id>)"
      : `orchestrate run active, bound to ${state.run_id}`,
     "info",
    );
   } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`could not activate orchestrate run: ${reason}`, "error");
    return;
   }
   // The run is active by now, whatever the hook does; a failing readiness check
   // must not read as a failed activation.
   try {
    await onActivate?.(cwd);
   } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`orchestrate run active; readiness check failed: ${reason}`, "warning");
   }
  },
 });

 pi.registerCommand("orchestrate-bind", {
  description: "Bind the active orchestrate run to a run epic id and arm its patrol",
  handler: async (args, ctx) => {
   const runId = args.trim();
   try {
    const bound = await bindRun(ctx.sessionManager.getCwd(), runId);
    if (bound.patrol === "armed") {
     ctx.ui.notify(`orchestrate run bound to ${runId}; patrol armed`, "info");
    } else {
     // The bind stands; the patrol does not. Said where the operator reads, because
     // an unarmed patrol is the layer that covers process death.
     ctx.ui.notify(`orchestrate run bound to ${runId}, but patrol arming needs architect attention: ${bound.patrol.failed}`, "warning");
    }
   } catch (error) {
    ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
   }
  },
 });

 pi.registerCommand("orchestrate-status", {
  description: "Active run: marker binding, run epic liveness, patrol",
  handler: async (_args, ctx) => {
   const report = await runStatusReport(ctx.sessionManager.getCwd());
   ctx.ui.notify(report.lines.join("\n"), report.healthy ? "info" : "warning");
  },
 });

 pi.registerCommand("orchestrate-close", {
  description: "End the run: remove the marker once it names <epic> and no child is in_progress (--force skips the check)",
  handler: async (args, ctx) => {
   const words = args.trim().split(/\s+/).filter(word => word.length > 0);
   const ids = words.filter(word => word !== "--force");
   const runId = ids[0];
   if (runId === undefined || ids.length > 1) {
    ctx.ui.notify("usage: /orchestrate-close <epic> [--force]", "error");
    return;
   }
   try {
    await closeRun(ctx.sessionManager.getCwd(), runId, { force: words.length > ids.length });
    ctx.ui.notify(`orchestrate run ${runId} closed; marker removed`, "info");
   } catch (error) {
    ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
   }
  },
 });
}

