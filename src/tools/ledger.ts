import path from "node:path";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { type BdBead, bdJson, bdShow } from "../bd";
import { beadIds, descendants, readStoreMode, runShape, todoStrings } from "../dag";
import { readLocator, writeLocator } from "../run";

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
	'Beads store is not in server mode; native isolation forks an embedded store. Migrate: bd export > issues.jsonl; bd backup init <dir> && bd backup sync; bd init --shared-server --reinit-local --skip-hooks --skip-agents --prefix <prefix>; set dolt_mode to "server" in .beads/metadata.json and add dolt.shared-server: true to .beads/config.yaml; bd backup restore --force <dir>';

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
			"Record a terminal state on a Beads task: `done` closes it, `blocked` marks it blocked. An optional comment is written first so the rationale survives even if the transition fails.",
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
			if (input.state === "done") await bdJson(["close", bead, "--reason", input.reason, "--json"], ctx.cwd, env);
			else await bdJson(["update", bead, "--status", "blocked", "--reason", input.reason, "--json"], ctx.cwd, env);
			return text<FinishResult>({ state: input.state, bead }, `orc_finish ${bead}: ${input.state}`);
		},
	});

	pi.registerTool({
		name: "orc_status",
		label: "Run status",
		description:
			"Read the run epic's whole subtree from Beads. `todo` holds `<bead-id> <title>` for every open or in-progress bead and is the only legitimate source of todo items. `shape` is `three-tier` when a direct child of the epic is an epic (dispatch one `orc-lead` per child epic) and `two-tier` otherwise (dispatch workers directly). Pass `epic` once to bind the run for this checkout; the epic must exist, and a bound run refuses a different epic.",
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
			if (requested !== undefined && locator !== null && locator.run_id !== requested) {
				const message = `run already bound to ${locator.run_id}; call orc_status without epic, or remove .orchestration/.active-run to rebind`;
				return text<StatusResult>({ run: locator.run_id, store, beads: [], todo: [], message }, message, true);
			}
			const epic = requested ?? locator?.run_id;
			if (epic === undefined) {
				const message = "no run bound; pass epic or create .orchestration/.active-run";
				return text<StatusResult>({ run: null, store, beads: [], todo: [], message }, message);
			}
			// The epic must exist before anything is bound: `bd list --parent <typo>` exits 0
			// with `[]`, which would otherwise persist a typo as an empty successful run.
			const epicBead = await bdShow(epic, root);
			// Idempotent for a bound run (and adds the `.orchestration/.gitignore` a locator
			// written by another tool may lack: an untracked, non-ignored file in the primary
			// breaks OMP's isolation merge-back), binding for an unbound one.
			writeLocator(root, epic);
			const walk = await descendants(epic, root);
			statusIdsBySession.set(ctx.sessionManager.getSessionId(), beadIds(walk.beads));
			const todo = todoStrings(walk.beads);
			const shape = runShape(epic, walk.beads);
			const result: StatusResult = { run: epic, epic: epicBead, shape, store, beads: walk.beads, todo };
			if (walk.truncated) result.truncated = true;
			return text(
				result,
				`orc_status ${epic} (${epicBead.status ?? "?"}, ${shape}): ${walk.beads.length} beads, ${todo.length} open${walk.truncated ? " (truncated)" : ""}\n${todo.join("\n")}`,
			);
		},
	});
}
