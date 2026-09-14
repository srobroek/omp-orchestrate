import type { AgentToolResult, ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { type BdBead, bdJson, bdShow } from "../bd";
import { beadIds, descendants, readStoreMode, todoStrings } from "../dag";
import { readLocator, writeLocator } from "../run";

/** The plugin's actor string, set at `session_start`; `bd` refuses mutations without one. */
export interface LedgerContext {
	actor(): string;
	/** Non-`null` when the store is not in server mode: every ledger tool returns it unchanged. */
	refusal(): string | null;
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
	store: string;
	beads: BdBead[];
	todo: string[];
	truncated?: true;
	message?: string;
}

/** Bead ids from the most recent `orc_status`, for the todo drift advisory. Empty until then. */
let lastStatusIds: Set<string> | null = null;

export function statusBeadIds(): Set<string> | null {
	return lastStatusIds;
}

function text<T>(details: T, line: string, isError = false): AgentToolResult<T> {
	return { content: [{ type: "text", text: line }], details, isError };
}

function refused<T>(reason: string): AgentToolResult<T> {
	return { content: [{ type: "text", text: reason }], details: undefined as T, isError: true };
}

function storeLabel(root: string): string {
	const mode = readStoreMode(root);
	return mode === null ? "no .beads/metadata.json" : `${mode.database ?? "?"} (${mode.mode || "?"})`;
}

export function registerLedger(pi: ExtensionAPI, ledger: LedgerContext): void {
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
			const refusal = ledger.refusal();
			if (refusal !== null) return refused(refusal);
			const bead = input.bead.trim();
			const actor = ledger.actor();
			await bdJson(["update", bead, "--claim", "--json"], ctx.cwd).catch(() => undefined);
			const observed = await bdShow(bead, ctx.cwd);
			if (observed.assignee !== actor) {
				const holder = observed.assignee ?? "(unassigned)";
				return text<ClaimResult>(
					{ claimed: false, bead: observed, reason: `held by ${holder}` },
					`orc_claim ${bead}: not claimed, held by ${holder}`,
				);
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
			const refusal = ledger.refusal();
			if (refusal !== null) return refused(refusal);
			const bead = input.bead.trim();
			if (input.comment !== undefined && input.comment.trim().length > 0) {
				await bdJson(["comment", bead, input.comment], ctx.cwd);
			}
			if (input.state === "done") await bdJson(["close", bead, "--reason", input.reason, "--json"], ctx.cwd);
			else await bdJson(["update", bead, "--status", "blocked", "--reason", input.reason, "--json"], ctx.cwd);
			return text<FinishResult>({ state: input.state, bead }, `orc_finish ${bead}: ${input.state}`);
		},
	});

	pi.registerTool({
		name: "orc_status",
		label: "Run status",
		description:
			"Read the run epic's whole subtree from Beads. `todo` holds `<bead-id> <title>` for every open or in-progress bead and is the only legitimate source of todo items. Pass `epic` once to bind the run for this checkout.",
		approval: "read",
		parameters: statusParams,
		async execute(_id, input, _signal, _update, ctx): Promise<AgentToolResult<StatusResult | undefined>> {
			const refusal = ledger.refusal();
			if (refusal !== null) return refused(refusal);
			const root = ctx.cwd;
			const store = storeLabel(root);
			const locator = readLocator(root);
			const epic = input.epic?.trim() || locator?.run_id;
			if (epic === undefined) {
				const message = "no run bound; pass epic or create .orchestration/.active-run";
				return text<StatusResult>({ run: null, store, beads: [], todo: [], message }, message);
			}
			if (locator === null) writeLocator(root, epic);
			const walk = await descendants(epic, root);
			lastStatusIds = beadIds(walk.beads);
			const todo = todoStrings(walk.beads);
			const result: StatusResult = { run: epic, store, beads: walk.beads, todo };
			if (walk.truncated) result.truncated = true;
			return text(
				result,
				`orc_status ${epic}: ${walk.beads.length} beads, ${todo.length} open${walk.truncated ? " (truncated)" : ""}\n${todo.join("\n")}`,
			);
		},
	});
}
