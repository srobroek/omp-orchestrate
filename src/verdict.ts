/**
 * Graded review verdicts and the escalation ladder.
 *
 * A review bead finishes with a verdict, never a bare `done`:
 * - `approve`: the criteria are met; the review bead closes.
 * - `fix`: every finding is local (no design, contract, or security dimension). The reviewed
 *   tasks are reopened and unassigned with the findings on them, so the next wave dispatches
 *   the same implementer agent at the same tier; the review bead stays open and re-enters
 *   once those tasks close again.
 * - `changes`: a criterion was misread, or a finding changes a design or contract, or is an
 *   exploitable security issue. A fix bead is created one tier up (`basic` -> `deep` ->
 *   `max`) and the review bead depends on it. A `max` bounce escalates no further: the task
 *   is marked and the lead dispatches `orc-planner` to decompose it.
 *
 * A `dag-reviewer` bead follows the same shape with one branch: anything but `approve`
 * records the findings and sends the lead to `orc-planner`; the bead stays open and
 * re-enters after the planner returns.
 *
 * Every `bd` call goes through the injected runner so the plan is testable without a store.
 */

import { asBead, type BdBead, edgesOf, metadataRecord, parentOf } from "./bd";
import { tierOf } from "./dag";

export type Verdict = "approve" | "fix" | "changes";
export type Tier = "basic" | "deep" | "max";

export const REVIEW_ROLES: Record<string, true> = { reviewer: true, "dag-reviewer": true };

/** Longest findings text carried in bead metadata; the full text lives in the comment. */
const FINDINGS_LIMIT = 1500;

export function nextTier(tier: Tier): Tier | null {
	return tier === "basic" ? "deep" : tier === "deep" ? "max" : null;
}

/** The task beads a review bead depends on: its non-parent edges. */
export function reviewTargets(review: BdBead): string[] {
	return edgesOf(review)
		.filter(edge => edge.type !== "parent-child")
		.map(edge => edge.id);
}

export interface VerdictOutcome {
	verdict: Verdict;
	/** Tasks reopened for a same-tier fix. */
	reopened: string[];
	/** Fix beads created one tier up, as `{ from, bead, tier }`. */
	escalated: Array<{ from: string; bead: string; tier: Tier }>;
	/** Planner beads created: a DAG revision, or a decomposition of a task that bounced at `max`. The wave dispatches them. */
	planner: string[];
	/** One line for the tool result. */
	line: string;
}

export type BdRunner = (args: readonly string[]) => Promise<unknown>;

export interface VerdictInput {
	review: BdBead;
	verdict: Verdict;
	reason: string;
	/** Findings text; recorded as a comment and, trimmed, in the fixed tasks' metadata. */
	findings: string;
	/** Explicit task targets; defaults to the review bead's task dependencies. */
	targets?: string[];
	show: (id: string) => Promise<BdBead>;
	bd: BdRunner;
}

async function createPlannerBead(bd: BdRunner, parent: string | undefined, title: string, description: string, extra: Record<string, string>): Promise<string> {
	const created = await bd(["create", "--type", "task", ...(parent === undefined ? [] : ["--parent", parent]), "--title", title, "--description", description, "--metadata", JSON.stringify({ role: "planner", ...extra }), "--json"]);
	const bead = asBead(Array.isArray(created) ? created[0] : created);
	if (bead === null) throw new Error(`bd create returned no bead for "${title}"`);
	return bead.id;
}

function roleOf(bead: BdBead): string {
	const role = metadataRecord(bead.metadata)?.role;
	return typeof role === "string" ? role : "";
}

/** Apply a verdict to a review bead. Throws when the bead is not a review bead. */
export async function applyVerdict(input: VerdictInput): Promise<VerdictOutcome> {
	const { review, verdict, reason, findings, bd, show } = input;
	const role = roleOf(review);
	if (REVIEW_ROLES[role] !== true) throw new Error(`orc_finish ${review.id}: a verdict applies to a review bead; this bead's role is ${role || "(none)"}`);
	if (role === "dag-reviewer" && verdict === "fix") throw new Error(`orc_finish ${review.id}: a DAG review is approve or changes; there is no local fix for a DAG`);
	const outcome: VerdictOutcome = { verdict, reopened: [], escalated: [], planner: [], line: "" };
	if (verdict === "approve") {
		await bd(["close", review.id, "--reason", reason, "--json"]);
		outcome.line = `orc_finish ${review.id}: approve, closed`;
		return outcome;
	}
	const note = findings.trim().length > 0 ? findings.trim() : reason;
	await bd(["comment", review.id, `${verdict}: ${note}`]);
	// The reviewer claimed this bead (in_progress, assigned). It must return to open and
	// unassigned, or `bd ready` would never surface it again once its dependencies close.
	await bd(["update", review.id, "--status", "open", "--assignee", "", "--json"]);
	const parent = parentOf(review);
	if (role === "dag-reviewer") {
		// Planner work is a bead the wave dispatches, not an instruction the lead may drop:
		// the review depends on it, so the review re-enters only after the revision closes.
		const revise = await createPlannerBead(bd, parent, "Revise the DAG", `The DAG review ${review.id} returned ${verdict}.\n\nFindings:\n${note}\n\nRevise the beads under the run epic so every point holds, then finish this bead; the DAG review re-runs on the result.`, { review: review.id });
		await bd(["dep", "add", review.id, revise]);
		outcome.planner.push(revise);
		outcome.line = `orc_finish ${review.id}: ${verdict} on the DAG; planner bead ${revise} created, the DAG review re-runs when it closes`;
		return outcome;
	}
	const targets = input.targets !== undefined && input.targets.length > 0 ? input.targets : reviewTargets(review);
	if (targets.length === 0) throw new Error(`orc_finish ${review.id}: ${verdict} needs a target task; the review bead has no task dependency and none was passed`);
	for (const id of targets) {
		const task = await show(id);
		const metadata = metadataRecord(task.metadata);
		if (verdict === "fix") {
			const round = Number(metadata?.fix_round ?? 0) + 1;
			await bd(["reopen", id, "--reason", `fix requested by ${review.id}: ${reason}`]);
			await bd(["update", id, "--assignee", "", "--set-metadata", `fix_from=${review.id}`, "--set-metadata", `fix_round=${round}`, "--set-metadata", `fix_findings=${note.slice(0, FINDINGS_LIMIT)}`, "--json"]);
			outcome.reopened.push(id);
			continue;
		}
		const tier = tierOf(metadata) ?? "basic";
		const up = nextTier(tier);
		const title = typeof task.title === "string" ? task.title : id;
		const taskParent = parentOf(task);
		if (up === null) {
			// A bounce on the strongest tier is the diagnosis that the bead was too big: the
			// planner decomposes it, and the review depends on that work.
			await bd(["comment", id, `bounced at max by ${review.id}: ${note}`]);
			await bd(["update", id, "--set-metadata", "bounce=max", "--json"]);
			const decompose = await createPlannerBead(bd, taskParent ?? parent, `Decompose: ${title}`, `${id} (${title}) was reviewed as changes at the max tier by ${review.id}; no stronger tier exists, so the bead is too big.\n\nFindings:\n${note}\n\nSplit it into bounded task beads under the same parent, each with files and verifiable criteria and a tier, make ${review.id} depend on each, then finish this bead.`, { review: review.id, decomposes: id });
			await bd(["dep", "add", review.id, decompose]);
			outcome.planner.push(decompose);
			continue;
		}
		const description = `Fix for ${id} (${title}) after review ${review.id} returned changes.\n\nFindings:\n${note}\n\nThe original scope and acceptance criteria of ${id} apply; every criterion is re-verified by the same review bead.`;
		const created = await bd([
			"create",
			"--type",
			"task",
			...(taskParent === undefined ? [] : ["--parent", taskParent]),
			"--title",
			`Fix: ${title}`,
			"--description",
			description,
			"--metadata",
			JSON.stringify({ role: "implementer", tier: up, escalated_from: id, review: review.id }),
			"--json",
		]);
		const fix = asBead(Array.isArray(created) ? created[0] : created);
		if (fix === null) throw new Error(`orc_finish ${review.id}: bd create returned no bead for the fix of ${id}`);
		await bd(["dep", "add", review.id, fix.id]);
		outcome.escalated.push({ from: id, bead: fix.id, tier: up });
	}
	const parts: string[] = [];
	if (outcome.reopened.length > 0) parts.push(`reopened ${outcome.reopened.join(", ")} for the same implementer`);
	if (outcome.escalated.length > 0) parts.push(`fix beads ${outcome.escalated.map(e => `${e.bead} (${e.tier})`).join(", ")}`);
	if (outcome.planner.length > 0) parts.push(`planner beads ${outcome.planner.join(", ")} for tasks bounced at max`);
	outcome.line = `orc_finish ${review.id}: ${verdict}; ${parts.join("; ")}; the review bead stays open and re-enters when they close`;
	return outcome;
}

/** Title and brief of the DAG-review bead `orc_status` creates once per run. */
export const DAG_REVIEW_TITLE = "Review the DAG";
export const DAG_REVIEW_DESCRIPTION = [
	"Judge the run's DAG before any implementation wave, against the planner guard-rails:",
	"1. Every task is bounded: files or symbols named, acceptance criteria an independent reviewer can verify, no design decision left to the implementer.",
	"2. No design decision hides inside a task; such work is a `decision` or research bead that the dependent tasks wait on.",
	"3. Every review bead depends on the tasks it reviews; a review that spans the wave depends on all of them.",
	"4. Dependencies exist only for true ordering; independent work is not chained.",
	"5. Each implementer bead carries `metadata.tier`, and the mark is justified: `basic` for mechanical, fully specified work; `deep` for judgement inside a fixed scope; `max` for wrong-is-expensive work. `deep` and `max` together are a minority.",
	"6. A contract several epics share is recorded as a decision before those epics start.",
	"Verdict: `approve` when every point holds; otherwise `changes` with the failing point and bead ids, and the lead dispatches orc-planner with your findings.",
].join("\n");

/** The exact `bd create` for the run's DAG review, returned by `orc_status` while it is missing. */
export function dagReviewCommand(epic: string): string {
	const q = (s: string) => `'${s.replace(/'/gu, "'\\''")}'`;
	return `bd create --type task --parent ${epic} --title ${q(DAG_REVIEW_TITLE)} --description ${q(DAG_REVIEW_DESCRIPTION)} --metadata ${q(JSON.stringify({ role: "dag-reviewer" }))}`;
}

/** `true` when a bead is the run's DAG review (open or closed). */
export function isDagReview(bead: BdBead): boolean {
	return roleOf(bead) === "dag-reviewer";
}
