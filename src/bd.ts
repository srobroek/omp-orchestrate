/**
 * Thin `bd` runner for the ledger tools.
 *
 * The plugin neither adds nor removes store selectors: `bd` resolves the store the way it
 * would for a human in the same directory, so a `BEADS_DIR` the operator's shell exported
 * is the environment's decision, not this module's. Every caller is a tool handler that
 * turns a thrown error into a tool error, so failures throw rather than return sentinels.
 */

/** A bead as the ledger needs it. Extra fields pass through untouched. */
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

export interface BdResult {
	code: number;
	stdout: string;
	stderr: string;
}

const BD_ENV: Record<string, string> = {
	BD_JSON_ENVELOPE: "1",
	BD_NO_PAGER: "1",
	BD_NON_INTERACTIVE: "1",
};

/**
 * Spawn `bd` and wait. Throws on a missing binary or a timeout; a non-zero exit is returned.
 * `env` is layered over the process environment: the ledger passes `BEADS_ACTOR` per call,
 * because concurrent subagents share one process and a global actor would collide.
 * `BEADS_DIR` is removed for the same reason: the beads plugin pins it process-wide to the
 * first session's checkout, and a second session's ledger call must resolve its own store
 * from `cwd` (the tracked `.beads/metadata.json` every clone carries).
 */
export async function bdRun(
	args: readonly string[],
	cwd: string,
	env: Record<string, string> = {},
	timeoutMs = 20_000,
): Promise<BdResult> {
	const bin = process.env.BD_BIN ?? "bd";
	let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
	try {
		const { BEADS_DIR: _pin, ...inherited } = process.env;
		proc = Bun.spawn([bin, ...args], { cwd, env: { ...inherited, ...env, ...BD_ENV }, stdout: "pipe", stderr: "pipe" });
	} catch {
		throw new Error("bd is not installed or not executable");
	}
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		proc.kill();
	}, timeoutMs);
	try {
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		if (timedOut) throw new Error(`bd ${args.join(" ")} timed out after ${timeoutMs}ms`);
		return { code, stdout, stderr };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Parse a `bd --json` payload, unwrapping the `{ schema_version, data }` envelope
 * when present. `BD_JSON_ENVELOPE=1` asks for the envelope, but fixtures and older
 * subcommands emit a bare value, so both shapes are accepted.
 *
 * `bd` may print a warning line before the payload (a cold server, a redirect target it
 * could not follow), so parsing starts at the first brace or bracket rather than byte 0.
 * `undefined` when there is no JSON value there; a bare `null` is folded into that,
 * because no read answers `null` and means something by it.
 */
export function parsePayload(stdout: string): unknown {
	const starts = [stdout.indexOf("{"), stdout.indexOf("[")].filter(index => index !== -1);
	if (starts.length === 0) return undefined;
	try {
		const parsed: unknown = JSON.parse(stdout.slice(Math.min(...starts)));
		if (parsed !== null && typeof parsed === "object" && "schema_version" in parsed && "data" in parsed) {
			return parsed.data ?? undefined;
		}
		return parsed ?? undefined;
	} catch {
		return undefined;
	}
}

export function metadataRecord(raw: unknown): Record<string, unknown> | undefined {
	if (typeof raw === "string") {
		try {
			raw = JSON.parse(raw);
		} catch {
			return undefined;
		}
	}
	return raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
}

export function asBead(value: unknown): BdBead | null {
	if (value === null || typeof value !== "object") return null;
	if (!("id" in value) || typeof value.id !== "string") return null;
	// Checked above: `value` is an object whose `id` is a string, which is the only
	// field the ledger requires. Every other field stays optional on BdBead.
	const bead = value as BdBead;
	if ("metadata" in bead) {
		const metadata = metadataRecord(bead.metadata);
		if (metadata === undefined) delete bead.metadata;
		else bead.metadata = metadata;
	}
	return bead;
}

/** Run `bd <args>` and return the parsed payload; throws with `bd`'s stderr on a non-zero exit. */
export async function bdJson(args: readonly string[], cwd: string, env: Record<string, string> = {}): Promise<unknown> {
	const result = await bdRun(args, cwd, env);
	if (result.code !== 0) throw new Error(`bd ${args.join(" ")} exited ${result.code}: ${result.stderr.trim()}`);
	return parsePayload(result.stdout);
}

/** `bd show <id> --json`; accepts an object or a one-element array. */
export async function bdShow(id: string, cwd: string, env: Record<string, string> = {}): Promise<BdBead> {
	const payload = await bdJson(["show", id, "--json"], cwd, env);
	const bead = asBead(Array.isArray(payload) && payload.length === 1 ? payload[0] : payload);
	if (bead === null) throw new Error(`bd show ${id} returned no bead`);
	return bead;
}

/**
 * `bd list <args> --json`; a lone object is a list of one. An empty list is only ever an
 * explicit `[]`: no payload, a non-array payload, or a row without a string id throws,
 * because a zero exit with truncated output must not read as "no work".
 */
export async function bdList(args: readonly string[], cwd: string): Promise<BdBead[]> {
	const payload = await bdJson(["list", ...args, "--json"], cwd);
	const entries = Array.isArray(payload) ? payload : payload !== undefined && payload !== null && typeof payload === "object" ? [payload] : null;
	if (entries === null) throw new Error(`bd list ${args.join(" ")} returned no JSON array`);
	const beads: BdBead[] = [];
	for (const entry of entries) {
		const bead = asBead(entry);
		if (bead === null) throw new Error(`bd list ${args.join(" ")} returned a row without an id`);
		beads.push(bead);
	}
	return beads;
}
