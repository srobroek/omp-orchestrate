import fs from "node:fs/promises";
import path from "node:path";
import { bdRun } from "./bd";

/**
 * Locate the run's `.beads`.
 *
 * `bd where` answers with bd's own resolution from `cwd`: the checkout's `.beads`, or the
 * primary checkout's for a linked worktree, which bd resolves through Git's common
 * directory natively. The canonical answer goes into the run marker, and every isolated
 * copy of the checkout reads it from there (`src/clone-adopt.ts`). Nothing is exported
 * into the environment: a process-wide pin reached every `bd` call of the session,
 * including an operator's calls against unrelated repositories, while `bd -C` bypassed it.
 *
 * The database is embedded, so there is no server to probe or start. Server mode was
 * tried and rejected: bd decides whether a server runs from a pid file, so any tool that
 * removed it made the next call start a rival, and a container could not reach a
 * loopback-bound server at all.
 */
export type BeadsWorkspace = { ok: true; beadsDir: string } | { ok: false; reason: string };

export async function locateBeadsDir(cwd: string): Promise<BeadsWorkspace> {
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
	return { ok: true, beadsDir: canonical };
}
