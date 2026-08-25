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
 * Writes go through a `<name>.<pid>.tmp` sibling plus rename, because the gates
 * read this file on paths they do not control: a reader must never observe a
 * half-written marker, and a crash must not leave one behind.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { ensurePatrolWisp } from "./supervision";

/**
 * The marker's on-disk shape.
 *
 * `repo_root` is the run repository's absolute path, and it is what makes the
 * marker useful to an isolated worker. Isolation hands a child a filesystem copy of
 * the checkout, so the child's own cwd is the clone and every relative path it
 * resolves -- including the beads database `bd` discovers by walking up -- belongs
 * to that copy. The copied marker still names the original, which is the only way a
 * worker can aim its `bd` calls at the run's database rather than its private one.
 */
export interface ActiveRun {
	schema_version: 1;
	run_id: string;
	session_id?: string;
	repo_root?: string;
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
	const repoRoot = typeof record.repo_root === "string" && record.repo_root.length > 0 ? record.repo_root : undefined;
	const state: ActiveRun = { schema_version: 1, run_id: runId };
	if (sessionId !== undefined) state.session_id = sessionId;
	if (repoRoot !== undefined) state.repo_root = repoRoot;
	return state;
}

/** Write the marker atomically, leaving no temporary behind on either path. */
async function writeMarker(target: string, state: ActiveRun): Promise<void> {
	await fs.mkdir(path.dirname(target), { recursive: true });
	const temporary = `${target}.${process.pid}.tmp`;
	try {
		// Sorted keys keep the file byte-stable across rewrites, so an unchanged
		// marker does not show up as a diff in a run's worktree.
		await fs.writeFile(temporary, `${JSON.stringify(state, Object.keys(state).sort())}\n`, "utf8");
		await fs.rename(temporary, target);
	} catch (error) {
		await fs.rm(temporary, { force: true }).catch(() => {});
		throw error;
	}
}

/**
 * Put this repository under the run protocol, preserving any existing binding.
 * `sessionId` names the activating session; an omitted one keeps whatever the
 * previous activation recorded.
 */
export async function activateRun(cwd: string, sessionId?: string): Promise<ActiveRun> {
	const existing = await readActiveRun(cwd);
	const session = sessionId ?? existing?.session_id;
	const state: ActiveRun = { schema_version: 1, run_id: existing?.run_id ?? PENDING };
	if (session !== undefined) state.session_id = session;
	// Resolved here, where the path is the real checkout: a worker reads this out of
	// its own copy of the marker and can no longer tell the two apart.
	state.repo_root = path.resolve(cwd);
	await writeMarker(markerPath(cwd), state);
	return state;
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
	const existing = await readActiveRun(cwd);
	if (existing === null) throw new Error("no active-run marker to bind; run /orchestrate-run first");
	if (existing.run_id !== PENDING && existing.run_id !== runId) {
		throw new Error(`active-run marker is already bound to ${existing.run_id}`);
	}
	await writeMarker(markerPath(cwd), { ...existing, run_id: runId });
	await ensurePatrolWisp(runId, cwd);
}

/**
 * Whether this repository is under a run, ignoring liveness. `ORCHESTRATE_RUN`
 * arms the protocol without a marker, for runs driven from outside a checkout.
 */
export async function isRunActive(cwd: string): Promise<boolean> {
	const flag = process.env.ORCHESTRATE_RUN;
	if (flag !== undefined && flag.length > 0) return true;
	try {
		return (await fs.stat(markerPath(cwd))).isFile();
	} catch {
		return false;
	}
}

/**
 * The two marker commands. Registration is a function rather than import-time
 * work so the extension entry point owns the order commands appear in, and so
 * tests can import the marker functions without touching the registry.
 *
 * `orchestrate-status` is registered by the entry point, not here.
 */
export function registerRunCommands(pi: ExtensionAPI): void {
	pi.registerCommand("orchestrate-run", {
		description: "Activate orchestrate run enforcement in this repository",
		handler: async (_args, ctx) => {
			try {
				const state = await activateRun(ctx.sessionManager.getCwd(), ctx.sessionManager.getSessionId());
				ctx.ui.notify(
					state.run_id === PENDING
						? "orchestrate run active, awaiting a run epic (/orchestrate-bind <run-id>)"
						: `orchestrate run active, bound to ${state.run_id}`,
					"info",
				);
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`could not activate orchestrate run: ${reason}`, "error");
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
				ctx.ui.notify(`orchestrate run bound to ${runId}; patrol armed`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}

