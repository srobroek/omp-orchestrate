/**
 * `orc_run_status` — the standardised run status report.
 *
 * A TypeScript port of the reporting core of `scripts/run-status.py`. Every status
 * answer takes the same shape, so a reader compares runs instead of re-learning a
 * format: an epic rolls up through its features to their tasks, and the report
 * names what is claimable now, what is active, and what is blocked.
 *
 * `bd blocked` supplies the blocked set directly rather than walking the dependency
 * graph, because it already resolves which of a bead's dependencies are still open.
 *
 * Reads only. Never mutates a bead, and — per `bd.ts`'s doctrine — never throws:
 * a missing binary or a stalled read resolves to an error-flagged result.
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { type BdBead, bdList, bdRun, metadataString } from "../bd";

/**
 * A bead's derived lifecycle state.
 *
 * The built-ins are `closed`, `deferred`, `blocked`, `active`, `claimed`, `ready`
 * and `unknown`. A `state:` label contributes its own value verbatim, because the
 * lifecycle phases a role reports (`reported`, `in_review`, `approved`, …) are not
 * bd statuses and are project-defined.
 */
export type BeadState = string;

/** How many beads sit in each state. Keyed by {@link BeadState}. */
export type Counts = Record<BeadState, number>;

/** One bead, flattened to what the report prints. */
export interface StatusNode {
	id: string;
	title: string;
	/** `issue_type` as bd reported it, or `""` when it named none. */
	type: string;
	state: BeadState;
	assignee?: string;
	/** `metadata.role`: who this routes to while it is still unclaimed. */
	role?: string;
	/** `metadata.origin`: which run or formula poured this bead. */
	origin?: string;
	parent?: string;
	/** In the blocked set `bd blocked` returned. */
	blocked: boolean;
}

/** A feature (one architect domain) and every bead beneath it, at any depth. */
export interface StatusFeature extends StatusNode {
	tasks: StatusNode[];
	counts: Counts;
}

export interface StatusEpic extends StatusNode {
	features: StatusFeature[];
	/** Direct children that are not features, plus their descendants. */
	tasks: StatusNode[];
	counts: Counts;
}

export interface StatusTree {
	epics: StatusEpic[];
	/** Beads no root epic reaches. Reported rather than dropped. */
	orphans: StatusNode[];
	/** Ids of blocked beads that appear in this tree. */
	blocked: string[];
}

export interface StatusFilter {
	epic?: string;
	feature?: string;
	actor?: string;
}

export interface RenderOptions {
	/** Include one line per bead. Off, only rollups and counts are printed. */
	full?: boolean;
	filter?: StatusFilter;
}

/** Sibling ordering: the rollup reads top-down, so structure precedes work. */
const TYPE_ORDER: Record<string, number> = { epic: 0, feature: 1, task: 2, bug: 3, decision: 4, chore: 5 };

const STATE_MARK: Record<string, string> = {
	closed: "●",
	active: "◐",
	claimed: "◑",
	blocked: "◌",
	deferred: "◇",
	ready: "○",
};


/** A string field off a bead's passthrough properties, or `undefined`. */
function field(bead: BdBead, key: string): string | undefined {
	const value = bead[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * A metadata string, tolerating metadata that arrived as stringified JSON.
 *
 * `bd` emits `metadata` as an object on most subcommands but as a JSON string on
 * some, and the actor filter is wrong if it cannot read `metadata.actor` in both
 * shapes. The object path stays in `bd.ts`; only the string fallback lives here.
 */
function metaString(bead: BdBead, key: string): string | undefined {
	const direct = metadataString(bead, key);
	if (direct !== undefined) return direct;
	const raw = bead.metadata;
	if (typeof raw !== "string") return undefined;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (parsed === null || typeof parsed !== "object") return undefined;
		const value = (parsed as Record<string, unknown>)[key];
		return typeof value === "string" && value.length > 0 ? value : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The lifecycle state of one bead.
 *
 * Terminal statuses win outright: a stale `state:` label must not resurrect
 * finished work. Below them the `state:` label is the finer signal, because a role
 * reports its phase by label while its bead stays `in_progress`. Only then does
 * status decide, and an open bead with an assignee is `claimed`, not `ready` —
 * that distinction is the whole point of a pull queue.
 */
export function deriveState(bead: BdBead, blocked: ReadonlySet<string> = new Set()): BeadState {
	const status = bead.status ?? "";
	if (status === "closed") return "closed";
	if (status === "deferred") return "deferred";

	for (const label of bead.labels ?? []) {
		if (label.startsWith("state:")) {
			const phase = label.slice("state:".length);
			if (phase.length > 0) return phase;
		}
	}

	if (status === "blocked" || blocked.has(bead.id)) return "blocked";
	if (status === "in_progress") return "active";
	if (status === "open") return bead.assignee ? "claimed" : "ready";
	return status.length > 0 ? status : "unknown";
}

function toNode(bead: BdBead, blocked: ReadonlySet<string>): StatusNode {
	const node: StatusNode = {
		id: bead.id,
		title: field(bead, "title") ?? "",
		type: field(bead, "issue_type") ?? "",
		state: deriveState(bead, blocked),
		blocked: blocked.has(bead.id),
	};
	const assignee = bead.assignee;
	if (typeof assignee === "string" && assignee.length > 0) node.assignee = assignee;
	const role = metaString(bead, "role");
	if (role !== undefined) node.role = role;
	const origin = metaString(bead, "origin");
	if (origin !== undefined) node.origin = origin;
	const parent = field(bead, "parent");
	if (parent !== undefined) node.parent = parent;
	return node;
}

function tally(nodes: readonly StatusNode[]): Counts {
	const counts: Counts = {};
	for (const node of nodes) counts[node.state] = (counts[node.state] ?? 0) + 1;
	return counts;
}

/** Every node an epic covers: its features, their tasks, and its direct tasks. */
function epicNodes(epic: StatusEpic): StatusNode[] {
	const nodes: StatusNode[] = [];
	for (const feature of epic.features) {
		nodes.push(feature, ...feature.tasks);
	}
	nodes.push(...epic.tasks);
	return nodes;
}

function progress(counts: Counts): string {
	let all = 0;
	for (const count of Object.values(counts)) all += count;
	if (all === 0) return "no children";
	const done = counts.closed ?? 0;
	return `${done}/${all} closed (${Math.round((100 * done) / all)}%)`;
}

/**
 * Group beads into epic → feature → task, deriving each bead's state.
 *
 * A root epic is an `epic` whose parent is not itself a known bead: a parent id
 * pointing at nothing is a dangling link, not a reason to hide the epic. Beneath a
 * feature, tasks are flattened to every descendant at any depth, so a subtask never
 * escapes its feature's counts.
 */
export function buildStatusTree(beads: readonly BdBead[], blockedIds: readonly string[]): StatusTree {
	const blocked = new Set(blockedIds);
	const known = new Set(beads.map(bead => bead.id));

	const childrenOf = new Map<string, BdBead[]>();
	for (const bead of beads) {
		const parent = field(bead, "parent");
		if (parent === undefined) continue;
		const siblings = childrenOf.get(parent);
		if (siblings) siblings.push(bead);
		else childrenOf.set(parent, [bead]);
	}
	const rank = (bead: BdBead): number => TYPE_ORDER[field(bead, "issue_type") ?? ""] ?? 9;
	for (const siblings of childrenOf.values()) {
		siblings.sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
	}

	const placed = new Set<string>();
	/** Preorder descendants, keeping the sibling order above. */
	const descendants = (root: string): BdBead[] => {
		const out: BdBead[] = [];
		const walk = (id: string): void => {
			for (const kid of childrenOf.get(id) ?? []) {
				if (placed.has(kid.id)) continue; // a parent cycle must not loop forever
				placed.add(kid.id);
				out.push(kid);
				walk(kid.id);
			}
		};
		walk(root);
		return out;
	};

	const roots = beads
		.filter(bead => {
			if (field(bead, "issue_type") !== "epic") return false;
			const parent = field(bead, "parent");
			return parent === undefined || !known.has(parent);
		})
		.sort((a, b) => a.id.localeCompare(b.id));

	const epics: StatusEpic[] = [];
	for (const root of roots) {
		placed.add(root.id);
		const features: StatusFeature[] = [];
		const tasks: StatusNode[] = [];
		for (const child of childrenOf.get(root.id) ?? []) {
			if (placed.has(child.id)) continue;
			placed.add(child.id);
			const kin = descendants(child.id).map(bead => toNode(bead, blocked));
			if (field(child, "issue_type") === "feature") {
				features.push({ ...toNode(child, blocked), tasks: kin, counts: tally(kin) });
			} else {
				tasks.push(toNode(child, blocked), ...kin);
			}
		}
		const epic: StatusEpic = { ...toNode(root, blocked), features, tasks, counts: {} };
		epic.counts = tally(epicNodes(epic));
		epics.push(epic);
	}

	const orphans = beads
		.filter(bead => !placed.has(bead.id))
		.sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id))
		.map(bead => toNode(bead, blocked));

	return { epics, orphans, blocked: retainedBlocked({ epics, orphans, blocked: [] }) };
}

/** Blocked ids present in a tree, so a filtered tree does not report others' blockers. */
function retainedBlocked(tree: StatusTree): string[] {
	const ids: string[] = [];
	for (const epic of tree.epics) {
		for (const node of [epic, ...epicNodes(epic)]) {
			if (node.blocked) ids.push(node.id);
		}
	}
	for (const node of tree.orphans) {
		if (node.blocked) ids.push(node.id);
	}
	return ids;
}

function heldBy(node: StatusNode, actor: string): boolean {
	// assignee is the claim of record, but `bd update --status` does not set it (only
	// `--claim` does), so `metadata.actor` is a second and often more truthful signal.
	return node.assignee === actor || node.role === actor;
}

/**
 * Narrow a tree to one epic, one feature, or one actor's holdings.
 *
 * Counts are recomputed from what survives, so a filtered report never quotes
 * totals for work it does not show.
 */
export function filterTree(tree: StatusTree, filter: StatusFilter): StatusTree {
	const { epic: wantEpic, feature: wantFeature, actor } = filter;
	if (wantEpic === undefined && wantFeature === undefined && actor === undefined) return tree;

	const epics: StatusEpic[] = [];
	for (const epic of tree.epics) {
		if (wantEpic !== undefined && epic.id !== wantEpic) continue;

		let features = wantFeature === undefined ? epic.features : epic.features.filter(f => f.id === wantFeature);
		let tasks = wantFeature === undefined ? epic.tasks : [];

		if (actor !== undefined) {
			features = features
				.map(feature => {
					const kept = feature.tasks.filter(task => heldBy(task, actor));
					return { ...feature, tasks: kept, counts: tally(kept) };
				})
				.filter(feature => feature.tasks.length > 0 || heldBy(feature, actor));
			tasks = tasks.filter(task => heldBy(task, actor));
		}

		if (wantFeature !== undefined && features.length === 0) continue;
		if (actor !== undefined && features.length === 0 && tasks.length === 0 && !heldBy(epic, actor)) continue;

		const next: StatusEpic = { ...epic, features, tasks, counts: {} };
		next.counts = tally(epicNodes(next));
		epics.push(next);
	}

	let orphans = wantEpic === undefined && wantFeature === undefined ? tree.orphans : [];
	if (actor !== undefined) orphans = orphans.filter(node => heldBy(node, actor));

	const filtered: StatusTree = { epics, orphans, blocked: [] };
	filtered.blocked = retainedBlocked(filtered);
	return filtered;
}

/** One line naming the shape of a run: what a slash command shows without the rollup. */
export function statusSummaryLine(tree: StatusTree): string {
	const features = tree.epics.reduce((sum, epic) => sum + epic.features.length, 0);
	const tasks = tree.epics.reduce(
		(sum, epic) => sum + epic.tasks.length + epic.features.reduce((n, f) => n + f.tasks.length, 0),
		0,
	);
	const bits = [
		`${tree.epics.length} epics`,
		`${features} features`,
		`${tasks} tasks`,
		`${tree.blocked.length} blocked`,
	];
	if (tree.orphans.length > 0) bits.push(`${tree.orphans.length} unparented`);
	return bits.join(" · ");
}

function nodeLine(node: StatusNode, indent: string): string {
	const bits: string[] = [];
	if (node.assignee) bits.push(`@${node.assignee}`);
	else if (node.role) bits.push(`role=${node.role}`);
	if (node.blocked) bits.push("blocked");
	if (node.origin) bits.push(`origin=${node.origin}`);
	const tail = bits.length > 0 ? `  [${bits.join(" ")}]` : "";
	// `?` marks a project-defined `state:` phase with no glyph of its own.
	return `${indent}${STATE_MARK[node.state] ?? "?"} ${node.id.padEnd(12)} ${node.state.padEnd(11)} ${node.title}${tail}`;
}

function countsLine(counts: Counts): string {
	const parts = Object.entries(counts)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([state, count]) => `${state} ${count}`);
	return parts.length > 0 ? parts.join("  ") : "no children";
}

/** The report a reader (or the model) sees. */
export function renderStatus(tree: StatusTree, opts: RenderOptions = {}): string {
	const lines: string[] = [statusSummaryLine(tree)];
	const filter = opts.filter ?? {};
	const named = [
		filter.epic !== undefined ? `epic=${filter.epic}` : "",
		filter.feature !== undefined ? `feature=${filter.feature}` : "",
		filter.actor !== undefined ? `actor=${filter.actor}` : "",
	].filter(bit => bit.length > 0);
	if (named.length > 0) lines.push(`filter: ${named.join(" ")}`);

	if (tree.epics.length === 0 && tree.orphans.length === 0) {
		lines.push("", "no matching epic, feature, or bead");
		return lines.join("\n");
	}

	for (const epic of tree.epics) {
		lines.push("", `EPIC  ${epic.id}  ${epic.title}  [${epic.state}]`);
		lines.push(`  ${progress(epic.counts)}   ${countsLine(epic.counts)}`);
		for (const feature of epic.features) {
			lines.push(nodeLine(feature, "  "));
			lines.push(`      ${progress(feature.counts)}`);
			if (opts.full) {
				for (const task of feature.tasks) lines.push(nodeLine(task, "      "));
			}
		}
		if (epic.tasks.length > 0) {
			lines.push(`  direct tasks (${epic.tasks.length}): ${countsLine(tally(epic.tasks))}`);
			if (opts.full) {
				for (const task of epic.tasks) lines.push(nodeLine(task, "  "));
			}
		}
		const blocked = epicNodes(epic).filter(node => node.blocked);
		if (blocked.length > 0) lines.push(`  BLOCKED (${blocked.length}): ${blocked.map(n => n.id).join(", ")}`);
	}

	if (tree.orphans.length > 0) {
		lines.push("", `UNPARENTED (${tree.orphans.length}): ${countsLine(tally(tree.orphans))}`);
		if (opts.full) {
			for (const node of tree.orphans) lines.push(nodeLine(node, "  "));
		}
	}

	return lines.join("\n");
}

/**
 * Blocked bead ids out of `bd blocked --json`.
 *
 * `bd` may print a warning banner before the payload, so the scan starts at the
 * first brace or bracket rather than trusting byte 0, and the
 * `{ schema_version, data }` envelope is unwrapped when present.
 */
export function parseBlockedIds(stdout: string): string[] {
	const brace = stdout.indexOf("{");
	const bracket = stdout.indexOf("[");
	const candidates = [brace, bracket].filter(index => index !== -1);
	if (candidates.length === 0) return [];
	let payload: unknown;
	try {
		payload = JSON.parse(stdout.slice(Math.min(...candidates)));
	} catch {
		return [];
	}
	if (payload !== null && typeof payload === "object" && !Array.isArray(payload) && "data" in payload) {
		payload = payload.data;
	}
	const entries = Array.isArray(payload) ? payload : [payload];
	const ids: string[] = [];
	for (const entry of entries) {
		if (entry === null || typeof entry !== "object") continue;
		const id = (entry as Record<string, unknown>).id;
		if (typeof id === "string" && id.length > 0) ids.push(id);
	}
	return ids;
}

const DESCRIPTION = [
	"Standardised beads run status: rolls each epic up through its features to their tasks,",
	"deriving per-bead state from status, `state:` labels, and assignee, and marking what",
	"`bd blocked` reports as blocked. Reads only; never mutates a bead.",
	"Use this instead of hand-assembling a summary from `bd list`, which loses blockers and",
	"the feature rollup.",
].join(" ");

/** Register `orc_run_status`. The orchestrator wires this from `src/index.ts`. */
export function registerRunStatus(pi: ExtensionAPI): void {
	const z = pi.zod;
	pi.registerTool({
		name: "orc_run_status",
		label: "Run status",
		description: DESCRIPTION,
		approval: "read",
		parameters: z.object({
			epic: z.string().optional().describe("Report only this epic, by bead id."),
			feature: z.string().optional().describe("Report only this feature (one architect domain), by bead id."),
			actor: z.string().optional().describe("Report only what this actor holds, by assignee or metadata.role."),
			full: z.boolean().optional().describe("Include one line per bead. Off, only rollups and counts."),
		}),
		async execute(_toolCallId, params: StatusFilter & { full?: boolean }) {
			try {
				const [beads, blockedResult] = await Promise.all([
					bdList(["list", "--status", "all", "--json"]),
					bdRun(["blocked", "--json"]),
				]);

				if (beads.length === 0) {
					// An unreachable `bd` and an empty workspace both yield no beads; the
					// blocked probe is what tells them apart.
					const unreachable = blockedResult === null;
					const text = unreachable
						? "bd is unavailable (binary missing, or the read timed out); no run status could be read."
						: "no beads found (is this a beads workspace?)";
					return {
						content: [{ type: "text" as const, text }],
						details: { epics: [], orphans: [], blocked: [] } satisfies StatusTree,
						isError: unreachable,
					};
				}

				const blockedIds =
					blockedResult !== null && blockedResult.code === 0 ? parseBlockedIds(blockedResult.stdout) : [];
				const filter: StatusFilter = {};
				if (params.epic !== undefined) filter.epic = params.epic;
				if (params.feature !== undefined) filter.feature = params.feature;
				if (params.actor !== undefined) filter.actor = params.actor;

				const tree = filterTree(buildStatusTree(beads, blockedIds), filter);
				return {
					content: [{ type: "text" as const, text: renderStatus(tree, { full: params.full === true, filter }) }],
					details: tree,
				};
			} catch (error) {
				// A throw here would surface as a hard tool failure mid-run; degrade instead.
				return {
					content: [{ type: "text" as const, text: `run status could not be built: ${String(error)}` }],
					details: { epics: [], orphans: [], blocked: [] } satisfies StatusTree,
					isError: true,
				};
			}
		},
	});
}
