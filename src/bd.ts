/**
 * The one place that shells out to `bd`.
 *
 * Gates never assemble `bd` argv themselves, so the JSON-envelope handling, the
 * timeout, and the per-turn read budget live in exactly one file.
 *
 * **Nothing here throws.** A throw inside a `tool_call` handler blocks the tool it
 * was inspecting (`extensibility/extensions/wrapper.ts:237` turns any handler
 * exception into a block), so a missing `bd` binary or a malformed payload would
 * brick every tool in the session rather than degrading. Every failure resolves to
 * `null` or an empty list, and each gate decides what an unknown answer means —
 * uniformly, fail open.
 */

/** A bead as the gates need it. Extra fields pass through untouched. */
export interface BdBead {
	id: string;
	status?: string;
	assignee?: string;
	labels?: string[];
	metadata?: Record<string, unknown>;
	spec_id?: string;
	updated_at?: string;
	[key: string]: unknown;
}

export interface BdComment {
	text: string;
	author?: string;
}

export interface BdResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** Env every invocation sets, so output is parseable and never blocks on a pager. */
const BD_ENV: Record<string, string> = {
	BD_JSON_ENVELOPE: "1",
	BD_NO_PAGER: "1",
	BD_NON_INTERACTIVE: "1",
};

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Reads allowed per turn, mirroring `rules-eval.py`'s `BD_READ_BUDGET = 12`.
 *
 * A contract evaluation hydrates a bead, its comments, and its linked wisps, so an
 * unbounded evaluator can issue dozens of subprocess calls while the model waits on
 * one `yield`. The budget caps that; exhausting it degrades to fail open, which is
 * the same outcome as `bd` being unavailable.
 */
const READ_BUDGET = 12;

let readsUsed = 0;

/** Reset the per-turn read budget. Call once per `tool_call` dispatch. */
export function resetReadBudget(): void {
	readsUsed = 0;
}

/**
 * Run `bd` and capture its result, or `null` when it could not run at all.
 *
 * `cwd` defaults to the process's, which is the session's repository for every
 * in-session caller. It is explicit for callers that already hold a repository
 * path and may not be running inside it: `bd` resolves its database by walking up
 * from the working directory, so an inherited cwd silently writes to a different
 * run's beads.
 */
export async function bdRun(
	args: string[],
	timeoutMs = DEFAULT_TIMEOUT_MS,
	cwd?: string,
): Promise<BdResult | null> {
	const bin = process.env.BD_BIN ?? "bd";
	try {
		const proc = Bun.spawn([bin, ...args], {
			...(cwd === undefined ? {} : { cwd }),
			env: { ...process.env, ...BD_ENV },
			stdout: "pipe",
			stderr: "pipe",
		});

		const timer = setTimeout(() => proc.kill(), timeoutMs);
		try {
			const [stdout, stderr, code] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			return { code, stdout, stderr };
		} finally {
			clearTimeout(timer);
		}
	} catch {
		// Missing binary, spawn failure, or a killed process. The caller treats an
		// unknown answer as permission to proceed.
		return null;
	}
}

/**
 * Parse a `bd --json` payload, unwrapping the `{ schema_version, data }` envelope
 * when present. `BD_JSON_ENVELOPE=1` asks for the envelope, but fixtures and older
 * subcommands emit a bare value, so both shapes are accepted.
 */
function parsePayload(stdout: string): unknown {
	try {
		const parsed: unknown = JSON.parse(stdout);
		if (parsed !== null && typeof parsed === "object" && "schema_version" in parsed && "data" in parsed) {
			return parsed.data;
		}
		return parsed;
	} catch {
		return undefined;
	}
}

/** Run a read, honouring the per-turn budget, and return its parsed payload. */
async function readJson(args: string[], timeoutMs = DEFAULT_TIMEOUT_MS, cwd?: string): Promise<unknown> {
	if (readsUsed >= READ_BUDGET) return undefined;
	readsUsed += 1;
	const result = await bdRun(args, timeoutMs, cwd);
	if (!result || result.code !== 0) return undefined;
	return parsePayload(result.stdout);
}

function asBead(value: unknown): BdBead | null {
	if (value === null || typeof value !== "object") return null;
	if (!("id" in value) || typeof value.id !== "string") return null;
	// Checked above: `value` is an object whose `id` is a string, which is the only
	// field the gates require. Every other field stays optional on BdBead.
	const bead = value as BdBead;
	return bead;
}

/**
 * One bead by id, or `null` when it does not exist or could not be read.
 *
 * `bd show --json` returns a single-element array, so both an array and a bare
 * object are accepted.
 */
export async function bdShow(id: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<BdBead | null> {
	const payload = await readJson(["show", id, "--json"], timeoutMs);
	if (Array.isArray(payload)) return asBead(payload[0]);
	return asBead(payload);
}

/** Beads matching a caller-supplied query. The caller passes its own `--json`. */
export async function bdList(args: string[], timeoutMs = DEFAULT_TIMEOUT_MS, cwd?: string): Promise<BdBead[]> {
	const payload = await readJson(args, timeoutMs, cwd);
	if (!Array.isArray(payload)) return [];
	const beads: BdBead[] = [];
	for (const entry of payload) {
		const bead = asBead(entry);
		if (bead) beads.push(bead);
	}
	return beads;
}

/** Comments on a bead, oldest first as `bd` returns them. */
export async function bdComments(id: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<BdComment[]> {
	const payload = await readJson(["comments", id, "--json"], timeoutMs);
	if (!Array.isArray(payload)) return [];
	const comments: BdComment[] = [];
	for (const entry of payload) {
		if (entry === null || typeof entry !== "object") continue;
		// `text` is the documented field; `body` and `comment` appear in older
		// payloads and fixtures, so accept any of them rather than silently
		// evaluating a contract against zero comments.
		let text: unknown;
		if ("text" in entry) text = entry.text;
		else if ("body" in entry) text = entry.body;
		else if ("comment" in entry) text = entry.comment;
		if (typeof text !== "string") continue;
		const author = "author" in entry && typeof entry.author === "string" ? entry.author : undefined;
		comments.push(author === undefined ? { text } : { text, author });
	}
	return comments;
}

/**
 * Ids of beads linked to `id` by `type`, looking at dependents.
 *
 * A review or escalation wisp is attached to its node with `relates-to`, so from
 * the node the wisps are its *dependents* — hence `--direction=up`. `bd dep list`
 * emits "a flat array of dependency records"; the field naming is not contractual,
 * so every string field that is not the queried id is treated as a candidate rather
 * than guessing one key.
 */
export async function bdLinked(id: string, type: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string[]> {
	const payload = await readJson(["dep", "list", id, "--direction=up", "--type", type, "--json"], timeoutMs);
	if (!Array.isArray(payload)) return [];
	const linked: string[] = [];
	for (const entry of payload) {
		if (entry === null || typeof entry !== "object") continue;
		for (const value of Object.values(entry)) {
			if (typeof value !== "string" || value === id || value === type) continue;
			// Bead ids are `<prefix>-<suffix>`, optionally dotted for children. This
			// filters out free-text fields such as a description or a timestamp.
			if (/^[A-Za-z0-9][A-Za-z0-9._]*-[A-Za-z0-9][A-Za-z0-9._]*$/.test(value) && !linked.includes(value)) {
				linked.push(value);
			}
		}
	}
	return linked;
}

/**
 * The bead this actor currently holds, or `null` when it holds none.
 *
 * Picks the most recently updated candidate, matching `rules-eval.py`'s
 * `max((updated_at, id))` tie-break, so a stale claim never shadows a live one.
 */
export async function claimedBead(actor: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<BdBead | null> {
	if (actor.length === 0) return null;
	const candidates = await bdList(
		["list", "--include-infra", "--assignee", actor, "--status", "open,in_progress,blocked", "--json"],
		timeoutMs,
	);
	let best: BdBead | null = null;
	for (const bead of candidates) {
		if (!best) {
			best = bead;
			continue;
		}
		const a = `${bead.updated_at ?? ""}\u0000${bead.id}`;
		const b = `${best.updated_at ?? ""}\u0000${best.id}`;
		if (a > b) best = bead;
	}
	return best;
}

/** A metadata value as a string, or `undefined` when absent or not a string. */
export function metadataString(bead: BdBead | null, key: string): string | undefined {
	const value = bead?.metadata?.[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The leading verb of a comment: first whitespace-delimited token, uppercased,
 * with a trailing colon stripped. Mirrors `rules-eval.py`'s comment-verb parse.
 */
export function commentVerb(text: string): string {
	const first = text.trim().split(/\s+/, 1)[0] ?? "";
	return first.replace(/:$/, "").toUpperCase();
}
