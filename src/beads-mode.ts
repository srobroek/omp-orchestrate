import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { bdRun } from "./bd";

const execFileAsync = promisify(execFile);

/**
 * Point every client at the run's beads database.
 *
 * The database is embedded: bd opens `.beads/embeddeddolt` in process, with no server, no
 * port file, and no pid file. That is the whole reason this file is short. An earlier
 * version required a per-project Dolt server, and the server was the wrong instrument for
 * the problem it was bought for -- see the history note below.
 *
 * What actually needs solving is narrower. A copied checkout can resolve a private or
 * unrelated ancestor database because `.beads/` is gitignored. A linked Git worktree
 * resolves the primary checkout's database, but still needs the same explicit pin so every
 * child process uses that answer. Measured on this host: `$HOME/.beads` exists, so an
 * unvalidated walk can end in a personal database that no run reads.
 *
 * `BEADS_DIR` closes that. Measured: from a directory holding no `.beads/` at all,
 * `BEADS_DIR=<run>/.beads bd list` listed the run's beads, and two concurrent writers from
 * different working directories both landed theirs in one embedded store. `src/bd.ts` spawns
 * with `{ ...process.env }` and subagents inherit the parent's environment, so one assignment
 * here reaches every later bd call and every child.
 *
 * HISTORY, so the next reader does not re-derive it. Server mode was adopted to stop an
 * isolated worker mutating a private copy, and it brought a server per project. bd decides
 * whether one is running from `.beads/dolt-server.pid` rather than from the port, so any tool
 * that removed that file made every later call start a rival: nine consecutive `database is
 * locked by another dolt process` refusals in one log, and 28 orphaned `dolt sql-server`
 * processes on this machine. A container could not reach a loopback-bound server at all,
 * which broke the Dolt sync that had worked under embedded mode. Embedded plus `BEADS_DIR`
 * gives the same guarantee -- one database, shared by every client -- and spawns nothing.
 */
export type BeadsReadiness = { ok: true; tracked?: boolean; note?: string } | { ok: false; reason: string };

function firstLine(text: string | undefined): string {
	const line = (text ?? "").split("\n").find(entry => entry.trim().length > 0);
	return line === undefined ? "no output" : line.trim();
}

async function canonicalPath(value: string): Promise<string> {
	return fs.realpath(value).catch(() => path.resolve(value));
}

async function sharedCheckoutBeadsDir(cwd: string): Promise<string | null> {
	const env = { ...process.env };
	for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
	try {
		const { stdout } = await execFileAsync(
			"git",
			["-C", cwd, "rev-parse", "--git-common-dir", "--is-bare-repository"],
			{
				env,
				timeout: 1500,
				maxBuffer: 16 * 1024,
			},
		);
		const [commonDirAnswer, bareAnswer] = stdout.trim().split("\n");
		if (commonDirAnswer === undefined || bareAnswer !== "false") return null;
		const commonDir = path.resolve(cwd, commonDirAnswer);
		if (path.basename(commonDir) !== ".git") return null;
		return path.join(path.dirname(commonDir), ".beads");
	} catch {
		return null;
	}
}

/**
 * Resolve the run's `.beads` and put it in the environment.
 *
 * Idempotent by design: an inherited `BEADS_DIR` is the run's answer already, and
 * re-resolving it inside an isolated checkout would replace a correct value with a local one.
 */
export async function ensureBeadsPath(cwd: string): Promise<BeadsReadiness> {
	const inherited = process.env.BEADS_DIR;
	if (inherited !== undefined && inherited.length > 0) {
		return { ok: true };
	}

	// `bd where` answers with the resolved directory on its first line, which is bd's own
	// resolution rather than a path this file guesses.
	const where = await bdRun(["where"], undefined, cwd);
	if (where === null) {
		return { ok: false, reason: "bd could not be run, so the run's database cannot be located" };
	}
	if (where.code !== 0) {
		const detail = firstLine(where.stderr || where.stdout);
		if (/no active beads workspace found|no beads database found/i.test(detail)) return { ok: true, tracked: false };
		return { ok: false, reason: `bd could not locate a beads database: ${detail}` };
	}
	const resolved = firstLine(where.stdout);
	if (!path.isAbsolute(resolved)) {
		return { ok: false, reason: `\`bd where\` answered "${resolved}", which is not an absolute path` };
	}

	// A linked worktree legitimately resolves the primary checkout's `.beads`, beside Git's
	// shared common directory. Accept that exact path as the same repository, while retaining
	// cwd containment for ordinary checkouts and refusing unrelated ancestor/home databases.
	const sharedBeads = await sharedCheckoutBeadsDir(cwd);
	const [canonicalResolved, canonicalCwd, canonicalSharedBeads] = await Promise.all([
		canonicalPath(resolved),
		canonicalPath(cwd),
		sharedBeads === null ? Promise.resolve(null) : canonicalPath(sharedBeads),
	]);
	const insideCheckout =
		canonicalResolved === canonicalCwd || canonicalResolved.startsWith(`${canonicalCwd}${path.sep}`);
	if (!insideCheckout && canonicalResolved !== canonicalSharedBeads) {
		return {
			ok: false,
			reason: `bd resolved its database to ${resolved}, which does not belong to this checkout (${cwd}). Set BEADS_DIR to the run's .beads before starting work here.`,
		};
	}

	process.env.BEADS_DIR = canonicalResolved;
	return { ok: true, note: `pointed this session at the run's database at ${resolved}` };
}
