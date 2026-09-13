import type { AgentToolResult, ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { runWorktreeSweep, type SweepResult } from "../worktree-sweep";

export interface WorktreeSweepParams {
	path: string;
	prune?: boolean;
	discardBranch?: boolean;
}

/** Map the typed tool input to the published CLI's argv contract. */
export function worktreeSweepArgs(params: WorktreeSweepParams): string[] {
	if (params.prune) return ["--prune", params.path];
	return [...(params.discardBranch ? ["--discard-branch"] : []), params.path];
}

function resultText(result: SweepResult): string {
	return [result.stdout, result.stderr].filter(text => text.length > 0).join(result.stdout.length > 0 && result.stderr.length > 0 ? "\n" : "");
}

/** Execute one sweep through the shared implementation and preserve subprocess evidence. */
export function executeWorktreeSweep(
	params: WorktreeSweepParams,
	run: (args: readonly string[]) => SweepResult = runWorktreeSweep,
): AgentToolResult<SweepResult> {
	const result = run(worktreeSweepArgs(params));
	return {
		content: [{ type: "text", text: resultText(result) }],
		details: result,
		isError: result.code !== 0,
	};
}

/** Register `worktree_sweep`; the skill CLI and this tool share `src/worktree-sweep.ts`. */
export function registerWorktreeSweep(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "worktree_sweep",
		label: "Worktree sweep",
		description: "Remove a clean registered Worktrunk worktree, or prune and quarantine broken unregistered harness directories.",
		approval: "exec",
		parameters: pi.zod.object({
			path: pi.zod.string().describe("Worktree path to remove, or repository path when prune is true"),
			prune: pi.zod.boolean().optional().describe("Scan harness roots and quarantine broken unregistered directories"),
			discardBranch: pi.zod.boolean().optional().describe("When removing one worktree, also delete its disposable role branch"),
		}),
		execute: async (_toolCallId, params: WorktreeSweepParams) => executeWorktreeSweep(params),
	});
}
