import { readFileSync } from "node:fs";
import path from "node:path";
import { asBead, type BdBead, bdJson, bdList, metadataRecord } from "./bd";

/** What `.beads/metadata.json` says about the store. */
export type StoreMode = { mode: string; database: string | null };

/** The store mode from `<root>/.beads/metadata.json`; `null` when the file is absent or unreadable. */
export function readStoreMode(root: string): StoreMode | null {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path.join(root, ".beads", "metadata.json"), "utf8"));
	} catch {
		return null;
	}
	const record = metadataRecord(raw);
	if (record === undefined) return null;
	const mode = record.dolt_mode;
	const database = record.dolt_database;
	return {
		mode: typeof mode === "string" ? mode : "",
		database: typeof database === "string" ? database : null,
	};
}

/** Upper bound on beads one `descendants` walk returns; the caller reports truncation. */
export const DESCENDANT_LIMIT = 500;

export interface Descendants {
	beads: BdBead[];
	truncated: boolean;
}

/**
 * Every bead under `epic`, breadth-first. `bd list --parent` returns direct children only,
 * so the walk queues each child in turn, dedupes by id, and stops at `DESCENDANT_LIMIT`.
 * A non-zero `bd` exit propagates; nothing falls back to a different store.
 */
export async function descendants(epic: string, cwd: string): Promise<Descendants> {
	const seen = new Set<string>([epic]);
	const beads: BdBead[] = [];
	const queue = [epic];
	for (let cursor = 0; cursor < queue.length; cursor++) {
		const parent = queue[cursor] as string;
		for (const child of await bdList(["--parent", parent, "--all"], cwd)) {
			if (seen.has(child.id)) continue;
			seen.add(child.id);
			if (beads.length >= DESCENDANT_LIMIT) return { beads, truncated: true };
			beads.push(child);
			queue.push(child.id);
		}
	}
	return { beads, truncated: false };
}

/** `<id> <title>` for every open or in-progress bead, in the order given. */
export function todoStrings(beads: readonly BdBead[]): string[] {
	const out: string[] = [];
	for (const bead of beads) {
		if (bead.status !== "open" && bead.status !== "in_progress") continue;
		const title = typeof bead.title === "string" ? bead.title : "";
		out.push(title.length > 0 ? `${bead.id} ${title}` : bead.id);
	}
	return out;
}

/**
 * The run shape the DAG implies: three tiers when any direct child of the run epic is
 * itself an epic (one `orc-lead` per child epic), two tiers otherwise (workers dispatched
 * directly). Derived from Beads, never from a flag, so the plan the human approved is the
 * human input.
 */
export function runShape(epic: string, beads: readonly BdBead[]): "two-tier" | "three-tier" {
	return childEpics(epic, beads).length > 0 ? "three-tier" : "two-tier";
}

/** Direct children of `epic` (parent-child dependency on it), in the order given. */
export function directChildren(epic: string, beads: readonly BdBead[]): BdBead[] {
	return beads.filter(bead => {
		const deps = Array.isArray(bead.dependencies) ? bead.dependencies : [];
		return deps.some(dep => dep !== null && typeof dep === "object" && "depends_on_id" in dep && dep.depends_on_id === epic && "type" in dep && dep.type === "parent-child");
	});
}

/** Direct child epics of `epic`, in the order given. */
export function childEpics(epic: string, beads: readonly BdBead[]): BdBead[] {
	return directChildren(epic, beads).filter(bead => bead.issue_type === "epic");
}

/** Ids of every bead under `root` in `beads` (transitive parent-child), excluding `root`. */
export function subtreeIds(root: string, beads: readonly BdBead[]): Set<string> {
	const children = new Map<string, string[]>();
	for (const bead of beads) {
		const deps = Array.isArray(bead.dependencies) ? bead.dependencies : [];
		for (const dep of deps) {
			if (dep === null || typeof dep !== "object" || !("depends_on_id" in dep) || !("type" in dep) || dep.type !== "parent-child") continue;
			const parent = dep.depends_on_id;
			if (typeof parent !== "string") continue;
			const list = children.get(parent) ?? [];
			list.push(bead.id);
			children.set(parent, list);
		}
	}
	const out = new Set<string>();
	const queue = [root];
	for (let cursor = 0; cursor < queue.length; cursor++) {
		for (const child of children.get(queue[cursor] as string) ?? []) {
			if (out.has(child)) continue;
			out.add(child);
			queue.push(child);
		}
	}
	return out;
}

async function readyUnder(parent: string, cwd: string, type?: "epic"): Promise<BdBead[]> {
	const args = ["ready", ...(type === undefined ? [] : ["--type", type]), "--parent", parent, "--unassigned", "--limit", "0", "--json"];
	const payload = await bdJson(args, cwd);
	const entries = Array.isArray(payload) ? payload : payload === undefined ? [] : [payload];
	const out: BdBead[] = [];
	for (const entry of entries) {
		const bead = asBead(entry);
		if (bead !== null) out.push(bead);
	}
	return out;
}

/**
 * The current wave for this tier, dependency-aware through `bd ready`, which honours
 * `blocks` edges and excludes `in_progress` issues.
 *
 * Two-tier: every task under `epic` that `bd ready` reports as unblocked and unassigned.
 *
 * Three-tier, while a child epic is still open: the direct child epics that `bd ready`
 * reports as ready (epic-to-epic blockers honoured; an epic a lead has bound is
 * `in_progress` and drops out), minus any epic whose open tasks are all blocked. bd 1.2.2
 * refuses an epic-to-decision dependency, so a decision gates an epic through its tasks; an
 * epic with no tasks at all stays in the wave, because its lead plans it.
 *
 * Three-tier, once every child epic is closed and nothing under them is open: the ready
 * `task` beads that sit directly under the run epic, which is where a cross-epic review
 * lives. bd refuses a task-to-epic dependency, so this is the only gate keeping that review
 * out of the first wave. Root-level tasks are therefore the run's final wave by definition.
 */
export async function readyWave(epic: string, beads: readonly BdBead[], cwd: string): Promise<BdBead[]> {
	const epics = childEpics(epic, beads);
	if (epics.length === 0) return (await readyUnder(epic, cwd)).filter(bead => bead.issue_type !== "epic");
	const direct = new Set(epics.map(bead => bead.id));
	// The run epic's own tasks (the cross-epic review) are the wave only once every child
	// epic is closed AND nothing under any of them is still open: an epic's status alone is
	// a lead's claim, and a lead once closed its epic over two open review beads.
	const epicSubtrees = new Set<string>();
	for (const child of epics) for (const id of subtreeIds(child.id, beads)) epicSubtrees.add(id);
	const unfinishedInside = beads.some(bead => epicSubtrees.has(bead.id) && (bead.status === "open" || bead.status === "in_progress"));
	if (epics.every(bead => bead.status === "closed") && !unfinishedInside) {
		// Only `task` beads: a `decision` left open under the run epic is the lead's to close,
		// not a reviewer's to judge (observed: one was dispatched to orc-reviewer).
		const rootTasks = new Set(directChildren(epic, beads).filter(bead => bead.issue_type === "task").map(bead => bead.id));
		return (await readyUnder(epic, cwd)).filter(bead => rootTasks.has(bead.id));
	}
	const candidates = (await readyUnder(epic, cwd, "epic")).filter(bead => direct.has(bead.id));
	const wave: BdBead[] = [];
	for (const candidate of candidates) {
		const inside = subtreeIds(candidate.id, beads);
		const openTasks = beads.filter(bead => inside.has(bead.id) && bead.issue_type !== "epic" && (bead.status === "open" || bead.status === "in_progress"));
		if (openTasks.length === 0) {
			wave.push(candidate);
			continue;
		}
		const readyTasks = await readyUnder(candidate.id, cwd);
		if (readyTasks.some(bead => bead.issue_type !== "epic")) wave.push(candidate);
	}
	return wave;
}

export function beadIds(beads: readonly BdBead[]): Set<string> {
	return new Set(beads.map(bead => bead.id));
}
