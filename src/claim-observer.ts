import { recordClaim } from "./claim-state";
import { effectiveSegments, parseBdInvocation } from "./shell";

/**
 * Record the bead a claim actually acquired, from the report it printed.
 *
 * Two defects made this necessary, pulling in opposite directions.
 *
 * `bd ready --claim` selects by filter, so no id exists until the result does. The gate
 * recorded `beadIds: []`, which `recordClaim` rejects, so after every normal pull
 * `observedClaim()` held nothing. `gateExitContract` then took its no-bead branch for
 * every correctly working session, and the contract evaluation that hangs off the claimed
 * bead never ran.
 *
 * `bd update <id> --claim` does carry the id, and the gate recorded it *before* the
 * command ran. Named claims are atomic, so the loser of a race recorded a bead it never
 * acquired and would have had its exit contract judged against another session's work.
 *
 * The claim report settles both, and it is structured rather than prose. Measured against
 * beads 1.1.2:
 *
 *   won  -> exit 0, stdout is a JSON array holding the claimed issue
 *   lost -> exit 1, stdout EMPTY, stderr `Error claiming <id>: issue already claimed by <actor>`
 *
 * So a one-record claim report is itself the proof of acquisition: a loss produces no JSON
 * to mistake for one. That is why nothing here matches message text, and why no id is
 * scavenged from output -- a command can print whatever it likes, and prose is not a
 * contract.
 *
 * `--json` is required for a claim to be observable. Every documented queue pull already
 * carries it, so the report is machine-readable by protocol rather than by luck.
 */

/** A `tool_result` event, structurally: the host's own type is not needed at runtime. */
export interface ToolResultLike {
	toolName?: string;
	isError?: boolean;
	input?: Record<string, unknown>;
	details?: unknown;
	content?: unknown;
}

/** Concatenate the text parts of a result payload, ignoring images. */
function resultText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	let text = "";
	for (const part of content) {
		if (part !== null && typeof part === "object" && "text" in part) {
			const value = (part as { text?: unknown }).text;
			if (typeof value === "string") text += value;
		}
	}
	return text;
}

/**
 * A cheap pre-filter, no longer the authority.
 *
 * `details.exitCode` is set only on a failing exit (`tools/bash.ts:720-722`, guarded by
 * `failedExit`), so its presence means failure and success leaves it undefined --
 * comparing it to zero would have accepted nothing. An async result is rejected outright:
 * its payload describes a job that was started, not a claim that completed.
 */
function plausiblySucceeded(event: ToolResultLike): boolean {
	if (event.isError === true) return false;
	const details = event.details as { exitCode?: unknown; timedOut?: unknown; async?: unknown } | undefined;
	if (details?.exitCode !== undefined) return false;
	if (details?.timedOut === true) return false;
	if (details?.async !== undefined && details.async !== false) return false;
	return true;
}

/**
 * A claimed issue as `bd` reports it, or nothing.
 *
 * `assignee` is the actor, read from the report. Every documented queue pull leaves
 * `BEADS_ACTOR` in the environment rather than inline, so requiring an inline actor would
 * reject every normal claim.
 */
function claimedBead(record: unknown): { id: string; assignee: string } | undefined {
	if (record === null || typeof record !== "object") return undefined;
	const { id, status, assignee } = record as { id?: unknown; status?: unknown; assignee?: unknown };
	if (typeof id !== "string" || id.length === 0) return undefined;
	// A claim sets both. Either absent means this is a read, or some other JSON.
	if (status !== "in_progress") return undefined;
	if (typeof assignee !== "string" || assignee.length === 0) return undefined;
	return { id, assignee };
}

/**
 * Every claimed record a `--json` claim reports, when the payload is exactly that.
 *
 * Plural on purpose. `bd update <a> <b> --claim` claims both, `recordClaim` takes
 * `beadIds` as a list, and the worktree gate scopes across all of them, so recording only
 * a single-record report would leave a legitimate two-bead claim unobserved and that gate
 * unarmed.
 *
 * All records must name the same assignee. One actor issued the call, so a report mixing
 * assignees is not one session's claim and records nothing.
 */
function reportedClaims(event: ToolResultLike): { actor: string; beadIds: string[] } | undefined {
	const text = resultText(event.content).trim();
	if (!text.startsWith("[")) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!Array.isArray(parsed) || parsed.length === 0) return undefined;

	const beadIds: string[] = [];
	let actor: string | undefined;
	for (const record of parsed) {
		const claimed = claimedBead(record);
		// One unclaimed record means this is not a claim report at all.
		if (claimed === undefined) return undefined;
		if (actor === undefined) actor = claimed.assignee;
		else if (actor !== claimed.assignee) return undefined;
		beadIds.push(claimed.id);
	}
	if (actor === undefined) return undefined;
	return { actor, beadIds };
}
/**
 * Whether the command is exactly one claiming `bd` call and nothing else.
 *
 * Segments, not `bdInvocations`: `bd update victim --claim; true` holds one bd invocation
 * and two segments, and the trailing `true` makes the shell exit 0 while the claim failed.
 * Counting invocations would have recorded `victim` on a failure.
 */
function soleClaimingSegment(command: unknown): boolean {
	if (typeof command !== "string") return false;
	const segments = effectiveSegments(command);
	if (segments.length !== 1) return false;
	const segment = segments[0];
	if (segment === undefined) return false;
	const invocation = parseBdInvocation(segment);
	return invocation !== null && invocation.hasClaim;
}

/**
 * Observe a `bash` result and record the claim it acquired.
 *
 * Silent on anything unexpected. This runs after every bash call, so it stays cheap and
 * never throws: each guard returns before any parse that could.
 */
export function observeClaimResult(event: ToolResultLike): void {
	if (event.toolName !== "bash") return;
	if (!plausiblySucceeded(event)) return;
	if (!soleClaimingSegment(event.input?.command)) return;

	const claimed = reportedClaims(event);
	if (claimed === undefined) return;
	recordClaim(claimed);
}
