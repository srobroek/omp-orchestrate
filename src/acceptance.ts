/**
 * Acceptance criteria as evidence: the hash a reviewer quotes, the numbered items it
 * covers, and the comment tokens that carry coverage.
 *
 * A bead's `acceptance_criteria` (bd's `--acceptance` field) is the definition of done
 * the architect wrote. Nothing stores its hash: a reviewer quotes the hash of the text it
 * read, and every gate recomputes the hash from the live field at evaluation time, so an
 * edit after review invalidates the coverage with nothing to keep in sync.
 *
 * Tokens, one per comment, whitespace-delimited like every other grammar token:
 *
 * - `nodes=<id>:<hash>:met|unmet,...` on a feature's `REVIEW` at a head: per-node
 *   coverage of the children the architect declared integrated at that head.
 * - `dod=<hash>:<n>:met|unmet,...` on an implementer's `REPORTED`: the worker's own
 *   report against each numbered item. A self-report, never the judgement.
 * - `plan=<hash>` on an epic's `REVIEW`: the decomposition the verdict judged.
 * - `override=<hash>` on a node's `REVIEW`: an override verdict against the live criteria.
 *
 * Hashes are the first {@link HASH_LENGTH} hex digits of SHA-256 over canonical text, short
 * enough to type into a comment and long enough that two criteria in one run never collide.
 */

import { createHash } from "node:crypto";
import { bdListChecked, metadataRecord } from "./bd";
import type { BdBead } from "./bd";
import { scopeOf } from "./scope";

export const HASH_LENGTH = 12;

const HASH_RE = new RegExp(`^[0-9a-f]{${HASH_LENGTH}}$`);

/** The bd field `--acceptance` writes, as `bd show --json` names it. */
export const ACCEPTANCE_FIELD = "acceptance_criteria";

/** The bead's acceptance text, or `undefined` when the field is absent or blank. */
export function acceptanceText(bead: BdBead): string | undefined {
	const value = (bead as Record<string, unknown>)[ACCEPTANCE_FIELD];
	if (typeof value !== "string") return undefined;
	const text = value.trim();
	return text.length === 0 ? undefined : text;
}

/** Line endings folded, trailing whitespace per line dropped, outer whitespace trimmed. */
export function canonicalText(text: string): string {
	return text.replace(/\r\n?/g, "\n").split("\n").map(line => line.trimEnd()).join("\n").trim();
}

function digest(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex").slice(0, HASH_LENGTH);
}

/** The hash a reviewer quotes for this acceptance text. */
export function acceptanceHash(text: string): string {
	return digest(canonicalText(text));
}

/** The bead's live acceptance hash, or `undefined` when it has no acceptance text. */
export function beadAcceptanceHash(bead: BdBead): string | undefined {
	const text = acceptanceText(bead);
	return text === undefined ? undefined : acceptanceHash(text);
}

/** `1. item`, `2) item`, `3: item` — a numbered acceptance item. */
const ITEM_RE = /^\s*(\d+)\s*[.):]\s+\S/;

/**
 * The item numbers an acceptance text declares, in order of appearance. Text with no
 * numbered line is one item, `1`, so an unnumbered criterion is still coverable.
 */
export function acceptanceItems(text: string): number[] {
	const items: number[] = [];
	for (const line of canonicalText(text).split("\n")) {
		const match = ITEM_RE.exec(line);
		if (match?.[1] === undefined) continue;
		const n = Number(match[1]);
		if (!items.includes(n)) items.push(n);
	}
	return items.length === 0 ? [1] : items;
}

export type Disposition = "met" | "unmet";

function disposition(value: string | undefined): Disposition | undefined {
	return value === "met" || value === "unmet" ? value : undefined;
}

/** Decoration a sentence hangs on a token: the same trim the exit gate applies to paths. */
const TOKEN_TRIM = /^[[(`'"<{,;:]+|[\])`'">}:,;.!?]+$/g;

/** The value of the first `<key>=` token in `text`, decoration stripped, or `undefined`. */
export function tokenValue(text: string, key: string): string | undefined {
	const prefix = `${key}=`;
	for (const raw of text.split(/\s+/)) {
		const token = raw.replace(TOKEN_TRIM, "");
		if (token.startsWith(prefix)) return token.slice(prefix.length);
	}
	return undefined;
}

/** One node's coverage as a `nodes=` token spells it. */
export interface NodeCoverage {
	id: string;
	hash: string;
	disposition: Disposition;
}

/**
 * The `nodes=` token of a comment, or `undefined` when absent or malformed. Malformed is
 * the whole token: a reviewer who spells one entry wrong has covered nothing, because a
 * gate that guesses which half was meant would accept a verdict the reviewer never wrote.
 */
export function nodesToken(text: string): NodeCoverage[] | undefined {
	const value = tokenValue(text, "nodes");
	if (value === undefined || value.length === 0) return undefined;
	const entries: NodeCoverage[] = [];
	for (const entry of value.split(",")) {
		const parts = entry.split(":");
		if (parts.length !== 3) return undefined;
		const [id, hash, verdict] = parts as [string, string, string];
		const status = disposition(verdict);
		if (id.length === 0 || !HASH_RE.test(hash) || status === undefined) return undefined;
		entries.push({ id, hash, disposition: status });
	}
	return entries;
}

/** One numbered item's self-report as a `dod=` token spells it. */
export interface ItemCoverage {
	hash: string;
	item: number;
	disposition: Disposition;
}

/** The `dod=` token of a comment, or `undefined` when absent or malformed. */
export function dodToken(text: string): ItemCoverage[] | undefined {
	const value = tokenValue(text, "dod");
	if (value === undefined || value.length === 0) return undefined;
	const entries: ItemCoverage[] = [];
	for (const entry of value.split(",")) {
		const parts = entry.split(":");
		if (parts.length !== 3) return undefined;
		const [hash, item, verdict] = parts as [string, string, string];
		const status = disposition(verdict);
		if (!HASH_RE.test(hash) || !/^\d+$/.test(item) || status === undefined) return undefined;
		entries.push({ hash, item: Number(item), disposition: status });
	}
	return entries;
}

/** The `plan=<hash>` token of a comment, or `undefined` when absent or not a hash. */
export function planToken(text: string): string | undefined {
	const value = tokenValue(text, "plan");
	return value !== undefined && HASH_RE.test(value) ? value : undefined;
}

/** The `override=<hash>` token of a comment, or `undefined` when absent or not a hash. */
export function overrideToken(text: string): string | undefined {
	const value = tokenValue(text, "override");
	return value !== undefined && HASH_RE.test(value) ? value : undefined;
}

/**
 * Whether `coverage` covers every item of `text` at its live hash with `met`. A missing
 * item, a stale hash, or one `unmet` is not covered; extra items are ignored.
 */
export function itemsCovered(text: string, coverage: readonly ItemCoverage[]): boolean {
	const hash = acceptanceHash(text);
	return acceptanceItems(text).every(item =>
		coverage.some(entry => entry.hash === hash && entry.item === item && entry.disposition === "met"),
	);
}

/** What the plan hash is computed over for one child: identity, territory, ordering, and done-ness. */
export interface PlanChild {
	id: string;
	scope: readonly string[];
	/** Ids this child depends on. */
	dependsOn: readonly string[];
	/** The child's live acceptance hash, or `undefined` when it has none. */
	acceptanceHash: string | undefined;
}

/**
 * The hash of a decomposition: its children, each with sorted scope and dependencies and
 * its acceptance hash, in id order. Any edit to any of those yields a new hash, which is
 * what makes a plan `REVIEW` version-bound.
 */
export function planHash(children: readonly PlanChild[]): string {
	const canonical = [...children]
		.sort((a, b) => a.id.localeCompare(b.id))
		.map(child => ({
			id: child.id,
			scope: [...child.scope].sort(),
			dependsOn: [...child.dependsOn].sort(),
			acceptance: child.acceptanceHash ?? null,
		}));
	return digest(JSON.stringify(canonical));
}

/**
 * Read an epic's live `orc-node` children and hash the decomposition the plan reviewer
 * judged. A failed read is unknown rather than an empty plan: the claim and exit gates
 * must not turn an unreadable store into a valid plan review.
 */
export async function planHashOf(epicId: string): Promise<string | undefined> {
	const queue = [epicId];
	const seen = new Set<string>();
	const children: BdBead[] = [];
	while (queue.length > 0) {
		const parent = queue.shift() as string;
		const rows = await bdListChecked(["list", "--parent", parent, "--label", "orc-node", "--limit", "0", "--json"]);
		if (rows === null) return undefined;
		for (const child of rows) {
			if (seen.has(child.id)) continue;
			seen.add(child.id);
			children.push(child);
			queue.push(child.id);
		}
	}
	return planHash(children.map(child => {
		const rawDependencies = (child as Record<string, unknown>).dependencies;
		const dependsOn = Array.isArray(rawDependencies)
			? rawDependencies.flatMap(entry => {
				if (typeof entry === "string") return [entry];
				if (entry !== null && typeof entry === "object" && typeof (entry as Record<string, unknown>).id === "string") return [(entry as Record<string, string>).id];
				return [];
			})
			: [];
		return { id: child.id, scope: scopeOf(metadataRecord(child.metadata)), dependsOn, acceptanceHash: beadAcceptanceHash(child) };
	}));
}
