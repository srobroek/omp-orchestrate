import path from "node:path";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { type BdBead, bdJson, bdShow } from "../bd";
import { beadIds, DESCENDANT_LIMIT, descendants, readStoreMode, readyWave, runShape, todoStrings } from "../dag";
import { readLocator, writeLocator } from "../run";

/** Whether `epic` sits under `ancestor` through parent-child edges, walking at most four levels. */
async function isDescendant(epic: string, ancestor: string, cwd: string): Promise<boolean> {
	let current = epic;
	for (let depth = 0; depth < 4; depth++) {
		const bead = await bdShow(current, cwd);
		const deps = Array.isArray(bead.dependencies) ? bead.dependencies : [];
		const parent = deps.find(dep => dep !== null && typeof dep === "object" && "type" in dep && dep.type === "parent-child" && "depends_on_id" in dep);
		if (parent === undefined || typeof parent.depends_on_id !== "string") return false;
		if (parent.depends_on_id === ancestor) return true;
		current = parent.depends_on_id;
	}
	return false;
}

/**
 * Why the ledger refuses to write at `root`, or `null` when the store is in server mode.
 * Computed per call from the file alone (never from a `bd` call): subagents share one
 * process, so a session-level flag would let one session's checkout gate another's.
 */
export function storeRefusal(root: string): string | null {
	const store = readStoreMode(root);
	if (store === null) return `${NO_STORE} (looked for ${path.join(root, ".beads", "metadata.json")})`;
	return store.mode === "server" ? null : NOT_SERVER_MODE;
}

/**
 * The actor for one tool call: `omp/<session id>` of the session that issued it. Every
 * subagent has its own session, so concurrent children never share an actor even though
 * they share one process. `bd` refuses mutations without an actor, so this is never empty.
 */
export function actorFor(ctx: ExtensionContext): string {
	const id = ctx.sessionManager.getSessionId();
	return `omp/${id.length > 0 ? id : "anon"}`;
}

export interface ClaimResult {
	claimed: boolean;
	bead?: BdBead;
	reason?: string;
}

export interface FinishResult {
	state: "done" | "blocked";
	bead: string;
}

export interface StatusResult {
	run: string | null;
	/** The run epic itself, so a lead can see its status without a second read. */
	epic?: BdBead;
	/** `three-tier` when a direct child of the epic is an epic (one `orc-lead` each), else `two-tier`. */
	shape?: "two-tier" | "three-tier";
	/**
	 * The wave, as `<bead-id> <title>`. Two-tier: unblocked, unassigned tasks. Three-tier: ready
	 * child epics while any is open; once all are closed with terminal subtrees, the run epic's
	 * own ready tasks (the cross-epic review). Withheld when the walk was truncated.
	 */
	ready?: string[];
	store: string;
	beads: BdBead[];
	todo: string[];
	truncated?: true;
	message?: string;
}

/**
 * Bead ids from each session's most recent `orc_status`, for the todo drift advisory.
 * Keyed by session id because subagents share one process: an epic lead's status must not
 * redraw the root's baseline.
 */
const statusIdsBySession = new Map<string, Set<string>>();

export function statusBeadIds(ctx: ExtensionContext): Set<string> | null {
	return statusIdsBySession.get(ctx.sessionManager.getSessionId()) ?? null;
}

function text<T>(details: T, line: string, isError = false): AgentToolResult<T> {
	return { content: [{ type: "text", text: line }], details, isError };
}

function refused<T>(reason: string): AgentToolResult<T> {
	return { content: [{ type: "text", text: reason }], details: undefined as T, isError: true };
}

/** Returned by every ledger tool while the store is not in server mode. */
export const NOT_SERVER_MODE =
	'Beads store is not in server mode; native isolation forks an embedded store. STOP: report this to the human and end the turn. Do not migrate the store, edit .beads/, or dispatch anything; a human runs the migration: bd export > issues.jsonl; bd backup init <dir> && bd backup sync; bd init --shared-server --reinit-local --skip-hooks --skip-agents --prefix <prefix>; set dolt_mode to "server" in .beads/metadata.json and add dolt.shared-server: true to .beads/config.yaml; bd backup restore --force <dir>';

/** Returned when the checkout has no readable `.beads/metadata.json`; unknown is not server mode. */
export const NO_STORE =
	"No Beads store here: .beads/metadata.json is missing or unreadable. Run `bd init --shared-server --skip-hooks` for a new project or `bd bootstrap` for a clone";

export function registerLedger(pi: ExtensionAPI): void {
	const z = pi.zod;
	// Named consts, not inline `z.object(...)` arguments: inlined, the generic no longer
	// infers and `input` degrades to `unknown`.
	const claimParams = z.object({ bead: z.string().describe("bead id to claim") });
	const finishParams = z.object({
		bead: z.string().describe("bead id"),
		state: z.enum(["done", "blocked"]),
		reason: z.string().describe("one-line reason recorded on the transition"),
		comment: z.string().optional().describe("evidence or rationale, stored as a bead comment"),
	});
	const statusParams = z.object({ epic: z.string().optional().describe("run epic id; binds the run when no locator exists") });

	pi.registerTool({
		name: "orc_claim",
		label: "Claim bead",
		description:
			"Claim one Beads task for this agent through `bd update --claim`, then read the bead back. Beads' atomic assignee is the only lock: `claimed: false` names the actor that holds it.",
		approval: "write",
		parameters: claimParams,
		async execute(_id, input, _signal, _update, ctx): Promise<AgentToolResult<ClaimResult | undefined>> {
			const refusal = storeRefusal(ctx.cwd);
			if (refusal !== null) return refused(refusal);
			const bead = input.bead.trim();
			const actor = actorFor(ctx);
			const env = { BEADS_ACTOR: actor };
			// `bd update --claim` exits non-zero when another actor holds the bead; that is
			// the race we read back, so the error is kept for the reason rather than thrown.
			// Any other failure (server down, unknown bead) surfaces from the readback.
			let claimError: string | undefined;
			await bdJson(["update", bead, "--claim", "--json"], ctx.cwd, env).catch((error: unknown) => {
				claimError = error instanceof Error ? error.message : String(error);
			});
			const observed = await bdShow(bead, ctx.cwd, env);
			if (observed.assignee !== actor) {
				const holder = observed.assignee ?? "(unassigned)";
				const reason = claimError === undefined ? `held by ${holder}` : `held by ${holder}; ${claimError}`;
				return text<ClaimResult>({ claimed: false, bead: observed, reason }, `orc_claim ${bead}: not claimed, ${reason}`);
			}
			return text<ClaimResult>({ claimed: true, bead: observed }, `orc_claim ${bead}: claimed by ${actor}`);
		},
	});

	pi.registerTool({
		name: "orc_finish",
		label: "Finish bead",
		description:
			"Record a terminal state on a Beads task: `done` closes it with the reason, `blocked` records the reason as a comment and sets the status. An epic closes only when every bead under it is closed; with an open or in-progress descendant `done` is refused and the ids are listed, and bd itself refuses to close over a blocked child, so finish such an epic `blocked`. An optional comment is written first so the evidence survives even if the transition fails.",
		approval: "write",
		parameters: finishParams,
		async execute(_id, input, _signal, _update, ctx): Promise<AgentToolResult<FinishResult | undefined>> {
			const refusal = storeRefusal(ctx.cwd);
			if (refusal !== null) return refused(refusal);
			const bead = input.bead.trim();
			const env = { BEADS_ACTOR: actorFor(ctx) };
			if (input.comment !== undefined && input.comment.trim().length > 0) {
				await bdJson(["comment", bead, input.comment], ctx.cwd, env);
			}
			if (input.state === "done") {
				// An epic closes only when its subtree is terminal. Observed 2026-09-14: an epic
				// lead closed its epic with two review beads still open, and the root had to reopen
				// it and dispatch a recovery lead.
				const current = await bdShow(bead, ctx.cwd, env);
				if (current.issue_type === "epic") {
					const walk = await descendants(bead, ctx.cwd);
					if (walk.truncated) {
						return text<FinishResult>(
							{ state: "done", bead },
							`orc_finish ${bead}: refused, the epic has more than ${DESCENDANT_LIMIT} descendants and the terminal check cannot see them all. Close its child epics individually.`,
							true,
						);
					}
					const unfinished = walk.beads.filter(child => child.status === "open" || child.status === "in_progress");
					if (unfinished.length > 0) {
						const list = unfinished.map(child => child.id).join(", ");
						return text<FinishResult>(
							{ state: "done", bead },
							`orc_finish ${bead}: refused, epic has unfinished beads: ${list}. Finish or block them first.`,
							true,
						);
					}
				}
				await bdJson(["close", bead, "--reason", input.reason, "--json"], ctx.cwd, env);
			} else {
				// `bd update` has no `--reason` (bd 1.2.2), so the reason is recorded as a
				// comment first; the transition follows only once that write has landed.
				await bdJson(["comment", bead, `blocked: ${input.reason}`], ctx.cwd, env);
				await bdJson(["update", bead, "--status", "blocked", "--json"], ctx.cwd, env);
			}
			return text<FinishResult>({ state: input.state, bead }, `orc_finish ${bead}: ${input.state}`);
		},
	});

	pi.registerTool({
		name: "orc_status",
		label: "Run status",
		description:
			"Read the run epic's whole subtree from Beads. `ready` is the wave and one `task` call dispatches all of it: unblocked, unassigned tasks under the epic (two-tier), or the child epics that are unblocked, not yet bound by a lead, and hold at least one ready task, one `orc-lead` each (three-tier). Binding claims the epic for this lead's actor; an epic another actor holds refuses to bind. `todo` holds `<bead-id> <title>` for every open or in-progress bead and is the only legitimate source of todo items. `shape` is `three-tier` when a direct child of the epic is an epic (dispatch one `orc-lead` per child epic) and `two-tier` otherwise. Pass `epic` once to bind the run for this checkout; the epic must exist, and a bound run refuses a different epic.",
		approval: "read",
		parameters: statusParams,
		async execute(_id, input, _signal, _update, ctx): Promise<AgentToolResult<StatusResult | undefined>> {
			const refusal = storeRefusal(ctx.cwd);
			if (refusal !== null) return refused(refusal);
			const root = ctx.cwd;
			const mode = readStoreMode(root);
			const store = mode === null ? "no .beads/metadata.json" : `${mode.database ?? "?"} (${mode.mode || "?"})`;
			const locator = readLocator(root);
			const requested = input.epic?.trim() || undefined;
			let bound = locator;
			if (requested !== undefined && locator !== null && locator.run_id !== requested) {
				// An isolated clone carries the root's locator. A sub-lead binding a child epic
				// of that run is the intended three-tier case, so the descendant rebinds; any
				// other epic is a different run and refuses.
				if (!(await isDescendant(requested, locator.run_id, root))) {
					const message = `run already bound to ${locator.run_id}; call orc_status without epic, or remove .orchestration/.active-run to rebind`;
					return text<StatusResult>({ run: locator.run_id, store, beads: [], todo: [], message }, message, true);
				}
				bound = null;
			}
			const epic = requested ?? locator?.run_id;
			if (epic === undefined) {
				const message = "no run bound; pass epic or create .orchestration/.active-run";
				return text<StatusResult>({ run: null, store, beads: [], todo: [], message }, message);
			}
			// The epic must exist before anything is bound: `bd list --parent <typo>` exits 0
			// with `[]`, which would otherwise persist a typo as an empty successful run.
			let epicBead = await bdShow(epic, root);
			if (bound === null) {
				// Binding claims the epic: Beads' atomic assignee is the ownership record, so two
				// leads cannot bind one epic, and `bd ready --unassigned` drops it for the root.
				const actor = actorFor(ctx);
				const env = { BEADS_ACTOR: actor };
				if (!epicBead.assignee) await bdJson(["update", epic, "--claim", "--json"], root, env).catch(() => undefined);
				epicBead = await bdShow(epic, root, env);
				if (epicBead.assignee !== actor) {
					const holder = epicBead.assignee ?? "(unassigned)";
					const message = `epic ${epic} is held by ${holder}; a lead binds only the epic it claims`;
					return text<StatusResult>({ run: null, store, beads: [], todo: [], message }, message, true);
				}
			}
			// Idempotent for a bound run (and adds the `.orchestration/.gitignore` a locator
			// written by another tool may lack: an untracked, non-ignored file in the primary
			// breaks OMP's isolation merge-back), binding for an unbound one.
			writeLocator(root, epic);
			const walk = await descendants(epic, root);
			statusIdsBySession.set(ctx.sessionManager.getSessionId(), beadIds(walk.beads));
			const todo = todoStrings(walk.beads);
			const shape = runShape(epic, walk.beads);
			// A truncated walk is not a basis for a wave: the epic tier's terminal check and the
			// two-tier task list both read the snapshot, so `ready` is withheld instead of guessed.
			const ready = walk.truncated ? [] : todoStrings(await readyWave(epic, walk.beads, root));
			const result: StatusResult = { run: epic, epic: epicBead, shape, ready, store, beads: walk.beads, todo };
			if (walk.truncated) {
				result.truncated = true;
				result.message = `subtree exceeds ${DESCENDANT_LIMIT} beads; ready is withheld. Orchestrate the child epics individually.`;
			}
			return text(
				result,
				`orc_status ${epic} (${epicBead.status ?? "?"}, ${shape}): ${walk.beads.length} beads, ${todo.length} open, ${ready.length} ready${walk.truncated ? " (truncated)" : ""}\nready:\n${ready.join("\n") || "(none)"}\ntodo:\n${todo.join("\n")}`,
			);
		},
	});
}
