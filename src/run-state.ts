/**
 * The active-run marker: whether this repository is under an orchestrate run,
 * and which run bead that run answers to.
 *
 * Replaces the marker halves of `orchestrator-run-activate.py` and
 * `orchestrate_run_marker.py`. Liveness (`bd show` on the run bead) is not here:
 * the gates that need it own that probe, and marker presence must stay cheap
 * enough to sit in front of every gated call.
 *
 * Two properties the scripts established and this keeps:
 *
 * Activation is idempotent and never clobbers a binding. A lead may re-run
 * activation at any point in a run, so `activateRun` reads the existing run id
 * back and rewrites it; only a markerless repository gets the `pending`
 * sentinel. Binding, conversely, refuses to move an already-bound marker to a
 * different id -- a second run epic in the same tree is a mistake, not a
 * retarget -- while rebinding to the same id stays a no-op so a retried command
 * is harmless.
 *
 * Writers hold an exclusive sibling lock through read/validate/rename. Readers see
 * atomic snapshots; a leftover lock requires explicit operator reconciliation.
 */

import fs, { type FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { ensureBeadsPath } from "./beads-mode";
import { resetReadBudget } from "./bd";
import { ensurePatrolWisp } from "./supervision";

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

/** Transactional reads distinguish absence from unreadable or malformed authority. */
async function readMarkerForMutation(cwd: string): Promise<ActiveRun | null> {
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
  const existing = await readMarkerForMutation(cwd);
  const session = sessionId ?? existing?.session_id;
  const state: ActiveRun = { schema_version: 1, run_id: existing?.run_id ?? PENDING };
  if (session !== undefined) state.session_id = session;
  await writeMarker(markerPath(cwd), state);
  return state;
 });
}

/**
 * Name the run bead this run answers to. Throws on a refusal -- a malformed id,
 * no marker to bind, or a marker already bound elsewhere -- so callers surface
 * the reason rather than silently leaving the marker unbound.
 *
 * Arming the patrol wisp belongs here rather than in the command handler: the
 * patrol is the durable consequence of a binding existing, so every caller must
 * get it. It is idempotent, and a beads failure must not fail the bind -- an
 * unarmed patrol costs a reconciliation sweep, an unbound marker costs the run.
 */
export async function bindRun(cwd: string, runId: string): Promise<void> {
 if (!RUN_ID_RE.test(runId)) throw new Error(`run id must be a Beads identifier, got ${JSON.stringify(runId)}`);
 await withMarkerLock(cwd, async () => {
  const existing = await readMarkerForMutation(cwd);
  if (existing === null) throw new Error("no active-run marker to bind; run /orchestrate-run first");
  if (existing.run_id !== PENDING && existing.run_id !== runId) {
   throw new Error(`active-run marker is already bound to ${existing.run_id}`);
  }
  await writeMarker(markerPath(cwd), { ...existing, run_id: runId });
 });
 // Binding owns its evidence budget; arming failure must not undo the marker.
 resetReadBudget();
 await ensurePatrolWisp(runId, cwd).catch(error => {
  process.emitWarning(
   `Run ${runId} is bound, but patrol arming needs architect attention: ${error instanceof Error ? error.message : String(error)}`,
   { code: "ORCHESTRATE_PATROL_UNCONFIRMED" },
  );
 });
}

/**
 * The two marker commands. Registration is a function rather than import-time
 * work so the extension entry point owns the order commands appear in, and so
 * tests can import the marker functions without touching the registry.
 *
 * `orchestrate-status` is registered by the entry point, not here.
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
  description: "Bind the active orchestrate run to a run epic id",
  handler: async (args, ctx) => {
   const runId = args.trim();
   try {
    // `bindRun` arms the S2 patrol wisp; this handler only reports.
    await bindRun(ctx.sessionManager.getCwd(), runId);
    // Not "patrol armed": arming fails open, so the bind succeeding does not
    // prove a patrol exists. `/orchestrate-status` reports the run's wisps.
    ctx.ui.notify(`orchestrate run bound to ${runId}`, "info");
   } catch (error) {
    ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
   }
  },
 });
}

