import { readFileSync } from "node:fs";
import path from "node:path";
import { type BdBead, bdList, metadataRecord } from "./bd";

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
	while (queue.length > 0) {
		const parent = queue.shift() as string;
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

export function beadIds(beads: readonly BdBead[]): Set<string> {
	return new Set(beads.map(bead => bead.id));
}
