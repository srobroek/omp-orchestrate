/**
 * orchestrate-with-bd — a durable Beads ledger beside OMP's native `orchestrate` keyword.
 *
 * OMP owns scheduling, agent lifecycle, isolated workspaces, capture, cancellation, and
 * landing. This plugin owns three things: the per-session actor every `bd` mutation is
 * attributed to, a run header injected when a prompt says `orchestrate`, and the ledger tools
 * (`orc_claim`, `orc_finish`, `orc_status`) that make Beads the source of truth for what
 * work exists and what state it is in. Four review-bot tools ride along untouched.
 *
 * The plugin never schedules, supervises, reaps, leases, captures, or discovers a store.
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { readStoreMode } from "./dag";
import { mentionsOrchestrate } from "./keyword";
import { readLocator } from "./run";
import { registerBotReviewProbe } from "./tools/bot-review-probe";
import { registerBotReviewRequest } from "./tools/bot-review-request";
import { registerConflictProbe } from "./tools/conflict-probe";
import { actorFor, registerLedger, statusBeadIds } from "./tools/ledger";
import { registerReviewRoundPolicy } from "./tools/review-round-policy";

const CONTRACT = [
	"- Read `skill://orchestrate-with-bd` before dispatching.",
	"- Beads is the only source of truth for what work exists and what state it is in. The todo list is a per-turn view of `orc_status`, never an independent plan: every item is `<bead-id> <title>` copied from `orc_status.todo`, never invented. On any disagreement, re-read `orc_status` and rewrite the list from it. `orc_finish` makes progress real; `todo done` only redraws the view.",
	"- In plan mode, the plan must name the epic and every task bead it implements in a `## Beads` section. A step with no bead is not planned work: create the bead first.",
	"- Dispatch every worker through the native `task` tool. Never start a nested `omp` process and never create a worktree for an agent.",
	"- The DAG decides the shape and `orc_status.shape` states it: `two-tier` (no child epic) means dispatch workers directly; `three-tier` (a direct child of the run epic is an epic) means dispatch one `orc-lead` per child epic with `isolated: true`, each brief naming its epic and containing the word `orchestrate` so the epic lead receives this same contract, then merge the returned epic branches yourself. Record cross-epic contracts as a `decision` bead before any epic lead starts. Dispatch `orc-planner` first only when the DAG does not exist yet or the domain is unfamiliar; it writes beads and returns.",
	"- Claim-holding implementers and epic leads run `isolated: true`; planner, reviewer, researcher, and shepherd do not.",
	"- You never claim a bead and never edit product code. A worker brief must not contain the bare lowercase word `orchestrate`.",
].join("\n");

/** The bash input with `BEADS_ACTOR` added to its `env`, or `undefined` when nothing changes. */
function withActor(input: unknown, actor: string): Record<string, unknown> | undefined {
	if (input === null || typeof input !== "object") return undefined;
	const env = "env" in input ? input.env : undefined;
	if (env !== undefined && (env === null || typeof env !== "object" || Array.isArray(env))) return undefined;
	const current = env === undefined ? undefined : (env as Record<string, unknown>).BEADS_ACTOR;
	if (typeof current === "string" && current.length > 0) return undefined;
	return { ...(input as Record<string, unknown>), env: { ...((env as Record<string, unknown> | undefined) ?? {}), BEADS_ACTOR: actor } };
}

const NO_RUN = "no run epic yet — create the epic, then call orc_status { epic } to bind it";

/** Build the run header for one prompt. Exported for the keyword tests; `index.ts` is the only registration site. */
export function runHeader(root: string, actor: string): string {
	const store = readStoreMode(root);
	const storeLine = store === null ? "no .beads/metadata.json" : `${store.database ?? "?"} (${store.mode || "?"} mode)`;
	const run = readLocator(root)?.run_id ?? NO_RUN;
	return [
		"<system-notice>",
		"orchestrate-with-bd run header",
		`store: ${storeLine}`,
		`run epic: ${run}`,
		`actor: ${actor}`,
		"",
		CONTRACT,
		"</system-notice>",
	].join("\n");
}

export default function orchestrateWithBd(pi: ExtensionAPI): void {
	pi.setLabel("Orchestrate with bd");

	// Every `bd` the model runs through bash carries the calling session's actor on the
	// call itself. A process-wide `BEADS_ACTOR` would be last-session-wins, because
	// concurrent subagents share one Bun process; a value the call already names is kept.
	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== "bash") return undefined;
		const revised = withActor(event.input, actorFor(ctx));
		return revised === undefined ? undefined : { input: revised };
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!mentionsOrchestrate(event.prompt)) return undefined;
		return {
			message: {
				customType: "orc-run-header",
				display: false,
				attribution: "user",
				content: runHeader(ctx.cwd, actorFor(ctx)),
			},
		};
	});

	// Advisory drift detector, deliberately non-blocking: it never spawns a process and
	// holds no state beyond the id set this session's most recent `orc_status` cached.
	pi.on("todo_reminder", async (event, ctx) => {
		if (readLocator(ctx.cwd) === null) return;
		const ids = statusBeadIds(ctx);
		if (ids === null) return;
		const drifted = event.todos
			.map(todo => todo.content)
			.filter(content => !ids.has(content.trim().split(/\s+/u, 1)[0] ?? ""));
		if (drifted.length === 0) return;
		pi.sendUserMessage(
			`todo items not backed by a bead in the bound run: ${drifted.map(item => JSON.stringify(item)).join(", ")}. Re-read orc_status and rewrite the todo list from orc_status.todo.`,
			{ deliverAs: "followUp" },
		);
	});

	registerLedger(pi);
	registerBotReviewProbe(pi);
	registerBotReviewRequest(pi);
	registerConflictProbe(pi);
	registerReviewRoundPolicy(pi);
}
