import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { bdRun } from "./bd";
import { within } from "./gates/worktree";

/**
 * Locate the run's `.beads`, and say how it was reached.
 *
 * `bd where` answers with bd's own resolution from `cwd`: the checkout's `.beads`, the
 * primary checkout's for a linked worktree (bd resolves Git's common directory natively),
 * or the target of a `.beads/redirect` in an isolated copy. Before bd is asked, the process
 * environment is read: bd honours a store selector there over every on-disk carrier, which
 * is how a session inheriting one from another checkout created its run epic in a foreign
 * store. `src/bd.ts` strips those selectors from every child it spawns, so the answer below
 * is never distorted by one; the selector is reported as the origin instead, and
 * `/orchestrate-start` refuses it unless the operator names the store explicitly.
 *
 * The canonical answer goes into the run marker, and every isolated copy of the checkout
 * reads it from there (`src/clone-adopt.ts`). Nothing is exported into the environment: a
 * process-wide pin reached every `bd` call of the session, including an operator's calls
 * against unrelated repositories, while `bd -C` bypassed it.
 *
 * The database is embedded, so there is no server to probe or start. Server mode was
 * tried and rejected: bd decides whether a server runs from a pid file, so any tool that
 * removed it made the next call start a rival, and a container could not reach a
 * loopback-bound server at all.
 */
export type StoreOrigin = "checkout" | "common-dir" | "redirect" | "env" | "explicit";

export type StoreLocation = { ok: true; path: string; origin: StoreOrigin } | { ok: false; reason: string };

/**
 * Environment variables bd reads as a store selector, measured on bd 1.2.2: each one
 * overrides the walk up from the working directory and a `.beads/redirect`; `--db` or `-C`
 * on the command line beats it. `BEADS_DIR` names the `.beads` directory; `BEADS_DB` and
 * `BD_DB` accept either that directory or the `embeddeddolt` database beneath it.
 * `src/bd.ts` strips every one of them from the children it spawns.
 */
export const STORE_SELECTOR_VARS: readonly string[] = ["BEADS_DIR", "BEADS_DB", "BD_DB"];

/** The first store selector set in this process, with its value. */
export function inheritedStoreSelector(env: NodeJS.ProcessEnv = process.env): { name: string; value: string } | undefined {
	for (const name of STORE_SELECTOR_VARS) {
		const value = env[name];
		if (typeof value === "string" && value.length > 0) return { name, value };
	}
	return undefined;
}

const execFileAsync = promisify(execFile);

/** A git answer about `cwd`, resolved to a real path: its top level, or its common directory. */
async function gitDir(cwd: string, flag: "--show-toplevel" | "--git-common-dir"): Promise<string | undefined> {
	try {
		const env = { ...process.env };
		// Repository-selection overrides must not turn another checkout into authority.
		for (const name of Object.keys(env)) if (name.startsWith("GIT_")) delete env[name];
		const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", flag], { env, timeout: 1500, maxBuffer: 16 * 1024 });
		const answer = stdout.trim();
		if (answer.length === 0) return undefined;
		return await fs.realpath(path.resolve(cwd, answer)).catch(() => undefined);
	} catch {
		return undefined;
	}
}

/** The origin of a store bd resolved from `cwd` without a selector: where the checkout keeps it. */
async function resolvedOrigin(cwd: string, store: string, redirected: boolean): Promise<StoreOrigin> {
	if (redirected) return "redirect";
	const [real, toplevel] = await Promise.all([fs.realpath(cwd).catch(() => cwd), gitDir(cwd, "--show-toplevel")]);
	if (within(store, toplevel ?? real)) return "checkout";
	const common = await gitDir(cwd, "--git-common-dir");
	if (common !== undefined && within(store, path.dirname(common))) return "common-dir";
	// bd walked up past the checkout to a parent directory's store: a store of the
	// enclosing tree, reached exactly as the checkout's own would be.
	return "checkout";
}

/**
 * The run's store, resolved from `cwd`, and how it was reached.
 *
 * `explicit` is the operator's `--store`: taken as given once it exists, whatever the
 * environment says. Otherwise a store selector in the process environment wins, as it
 * would for bd, and is reported as `env` so the caller can refuse it. Otherwise bd answers
 * from `cwd` and the origin says whether the store is the checkout's, the primary
 * checkout's through Git's common directory, or a redirect target.
 */
export async function storeOrigin(cwd: string, explicit?: string): Promise<StoreLocation> {
	if (explicit !== undefined) {
		const canonical = await fs.realpath(path.resolve(cwd, explicit)).catch(() => null);
		if (canonical === null) return { ok: false, reason: `the store ${explicit} does not exist` };
		return { ok: true, path: canonical, origin: "explicit" };
	}
	const selector = inheritedStoreSelector();
	if (selector !== undefined) {
		// bd accepts the database directory for the `.beads` it sits in.
		const named = path.basename(selector.value) === "embeddeddolt" ? path.dirname(selector.value) : selector.value;
		const canonical = await fs.realpath(named).catch(() => null);
		if (canonical === null) return { ok: false, reason: `${selector.name} in this session's environment names ${selector.value}, which does not exist` };
		return { ok: true, path: canonical, origin: "env" };
	}

	const where = await bdRun(["where", "--json"], undefined, cwd);
	if (where === null) return { ok: false, reason: "bd could not be run, so the run's database cannot be located" };
	if (where.code !== 0) {
		const detail = (where.stderr || where.stdout).split("\n").find(line => line.trim().length > 0)?.trim() ?? "no output";
		if (/no active beads workspace found|no beads database found/i.test(detail)) return { ok: false, reason: "no active Beads workspace was found" };
		return { ok: false, reason: `bd could not locate a beads database: ${detail}` };
	}
	let payload: unknown;
	try {
		payload = JSON.parse(where.stdout);
	} catch {
		return { ok: false, reason: "`bd where --json` answered something other than JSON" };
	}
	// `BD_JSON_ENVELOPE=1` wraps the answer as `{ schema_version, data }`; older builds do not.
	const record = payload !== null && typeof payload === "object" && "data" in payload ? payload.data : payload;
	const answer = record !== null && typeof record === "object" && "path" in record ? record.path : undefined;
	if (typeof answer !== "string" || !path.isAbsolute(answer)) {
		return { ok: false, reason: `\`bd where\` answered ${JSON.stringify(answer)}, which is not an absolute path` };
	}
	const canonical = await fs.realpath(answer).catch(() => null);
	if (canonical === null) return { ok: false, reason: `bd resolved its database to ${answer}, which does not exist` };
	const redirected = record !== null && typeof record === "object" && "redirected_from" in record && typeof record.redirected_from === "string";
	return { ok: true, path: canonical, origin: await resolvedOrigin(cwd, canonical, redirected) };
}

/**
 * The run's `.beads` alone. Callers that only need the path; `/orchestrate-start` and the
 * doctor read {@link storeOrigin} so they can refuse or report an inherited selector.
 */
export type BeadsWorkspace = { ok: true; beadsDir: string } | { ok: false; reason: string };

export async function locateBeadsDir(cwd: string): Promise<BeadsWorkspace> {
	const located = await storeOrigin(cwd);
	return located.ok ? { ok: true, beadsDir: located.path } : located;
}
