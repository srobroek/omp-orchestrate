/**
 * omp-orchestrate — Beads-backed multi-agent orchestration for OMP.
 *
 * Registers one `tool_call` handler, the worker-side protocol injection, and two
 * read-only slash commands. Everything else this plugin contributes — the skill, the
 * agents, the formulas — is data OMP discovers from the package tree.
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { ToolCallEventResult } from "@oh-my-pi/pi-coding-agent";
import { bdList, bdRun, resetReadBudget } from "./bd";
import { dispatchContract } from "./contract";
import { gateBdDiscipline } from "./gates/bd";
import { gateClaimEligibility } from "./gates/claim";
import { gateExitContract } from "./gates/exit";
import { gateOneClaim } from "./gates/one-claim";
import { beadWriteFreeEnv, reviseBashEnv } from "./gates/readonly";
import { GATED_WRITE_TOOLS, gateWorktreeScope } from "./gates/worktree";
import { gateWorktrunkOwnership } from "./gates/wt-guard";
import { sessionRole } from "./identity";
import { readActiveRun, registerRunCommands } from "./run-state";
import { registerSupervision } from "./supervision";
import { registerBotReviewProbe } from "./tools/bot-review-probe";
import { registerConflictProbe } from "./tools/conflict-probe";
import { registerResolveQueueDispatch } from "./tools/resolve-queue-dispatch";
import { registerRunStatus } from "./tools/run-status";
import { registerWatchers } from "./watchers";

/** Tools any gate inspects. Everything else returns before doing work. */
const GATED_TOOLS: Record<string, true> = { bash: true, edit: true, write: true, yield: true };

export default function ompOrchestrate(pi: ExtensionAPI): void {
	pi.setLabel("Orchestrate");

	// Deterministic surfaces the pull loop and the shepherd call by schema, not prose.
	registerRunCommands(pi);
	registerConflictProbe(pi);
	registerRunStatus(pi);
	registerResolveQueueDispatch(pi);
	registerBotReviewProbe(pi);
	// S1 reaper + W1-W4 watchers: deterministic supervision on the lifecycle bus.
	registerSupervision(pi);
	registerWatchers(pi);

	/**
	 * One handler for every gate, dispatching on tool name.
	 *
	 * Blocking gates run before G1's rewrite, because a handler returns a single
	 * result: a refusal must win over a revision of an input that will not run.
	 *
	 * The whole body is wrapped, because a throwing `tool_call` handler blocks the
	 * tool it was inspecting (`extensibility/extensions/wrapper.ts:237`). A bug here
	 * must degrade to fail-open rather than bricking every tool in the session.
	 */
	pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult | undefined> => {
		if (GATED_TOOLS[event.toolName] !== true) return undefined;

		try {
			resetReadBudget();
			const input = event.input as Record<string, unknown>;

			if (event.toolName === "yield") return await gateExitContract(ctx, input);

			if (event.toolName === "bash") {
				const ownership = gateWorktrunkOwnership(input);
				if (ownership) return ownership;

				// G6 before G5: it is a parse plus one marker read where G5 shells out to
				// `bd show` and `bd list`. It takes `pi` because its findings are notices
				// rather than refusals, and a notice leaves through `sendMessage` rather than
				// through the return value.
				const discipline = await gateBdDiscipline(pi, ctx, input);
				if (discipline) return discipline;

				// Also before G5: a refused multi-bead claim must not be recorded, or G2
				// would hold the session to two trees it was never allowed to claim.
				const exclusivity = gateOneClaim(ctx, input);
				if (exclusivity) return exclusivity;

				const eligibility = await gateClaimEligibility(ctx, input);
				if (eligibility) return eligibility;
			}

			if (GATED_WRITE_TOOLS[event.toolName] === true) {
				// G2 needs the input: its containment check is on the path the tool
				// names, not only on the cwd the session sits in.
				const scope = await gateWorktreeScope(ctx, event.toolName, input);
				if (scope) return scope;
			}

			// Last, and only for `bash`: a revision rather than a refusal, built through the
			// one shared builder so a second environment gate can contribute to the same
			// result without a handler returning two of them.
			if (event.toolName === "bash") return reviseBashEnv(input, { ...beadWriteFreeEnv(pi, ctx) });

			return undefined;
		} catch (error) {
			pi.logger.error("orchestrate gate failed open", {
				tool: event.toolName,
				error: error instanceof Error ? error.message : String(error),
			});
			return undefined;
		}
	});

	/**
	 * Inject the protocol into every worker before its first prompt.
	 *
	 * `attribution: "user"` is required: any other value normalises to `"agent"`
	 * (`session/messages.ts:654`), and the contract must read as authority rather
	 * than as something the model said to itself.
	 *
	 * The repository comes from the marker rather than `ctx.cwd`, because in an
	 * isolated worker those differ: the cwd is the clone, and the marker -- copied in
	 * with the rest of the checkout -- still names the original. That path is what
	 * makes the contract's `bd -C` pin resolvable.
	 */
	pi.on("session_start", async (_event, ctx) => {
		if (sessionRole(pi) === "lead") return;
		const marker = await readActiveRun(ctx.cwd).catch(() => null);
		// No run, no contract. Measured without this guard: a plain subagent spawned in
		// this repository received the protocol, obeyed it over its own brief, pulled an
		// empty queue for a role that does not exist, and yielded NO_WORK -- the injected
		// text outranked the task it was actually given.
		if (marker === null) return;
		pi.sendMessage(
			{
				customType: "com.srobroek.omp-orchestrate.contract",
				content: dispatchContract(marker?.repo_root),
				display: false,
				attribution: "user",
			},
			{ triggerTurn: false },
		);
	});

	pi.registerCommand("orchestrate-status", {
		description: "Run status for the active epic",
		handler: async (args, ctx) => {
			const epic = args.trim();
			const result = await bdRun([
				"list",
				"--type",
				"epic",
				...(epic.length > 0 ? ["--parent", epic] : []),
				"--json",
			]);
			if (result === null || result.code !== 0) {
				ctx.ui.notify("bd is unavailable", "warning");
				return;
			}
			// An empty JSON array is a real answer, not a failure: the run has no epics
			// yet. Reporting it as one sent readers looking for a broken bd install.
			const body = result.stdout.trim();
			ctx.ui.notify(body === "[]" || body.length === 0 ? "no epics" : body, "info");
		},
	});

	pi.registerCommand("orchestrate-roster", {
		description: "Pull-queue depth for each role",
		handler: async (_args, ctx) => {
			resetReadBudget();
			const lines: string[] = [];
			for (const role of ["architect", "implementer", "reviewer", "researcher", "shepherd"]) {
				const ready = await bdList(["ready", "--metadata-field", `role=${role}`, "--unassigned", "--json"]);
				lines.push(`${role}: ${ready.length} ready`);
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
