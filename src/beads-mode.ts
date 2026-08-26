import path from "node:path";
import { bdRun } from "./bd";

/**
 * Point every client at the run's beads database.
 *
 * The database is embedded: bd opens `.beads/embeddeddolt` in process, with no server, no
 * port file, and no pid file. That is the whole reason this file is short. An earlier
 * version required a per-project Dolt server, and the server was the wrong instrument for
 * the problem it was bought for -- see the history note below.
 *
 * What actually needs solving is narrower. bd resolves its database by walking up from the
 * working directory, so a worker in an isolated checkout resolves to whatever `.beads` it
 * finds there. `.beads/` is gitignored, so a clone and a worktree both arrive without one,
 * and the walk continues past the checkout. Measured on this host: `$HOME/.beads` exists, so
 * the walk can end in a personal database that no run reads.
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
export type BeadsReadiness = { ok: true; note?: string } | { ok: false; reason: string };

function firstLine(text: string | undefined): string {
	const line = (text ?? "").split("\n").find(entry => entry.trim().length > 0);
	return line === undefined ? "no output" : line.trim();
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
		return { ok: false, reason: `bd could not locate a beads database: ${firstLine(where.stderr || where.stdout)}` };
	}
	const resolved = firstLine(where.stdout);
	if (!path.isAbsolute(resolved)) {
		return { ok: false, reason: `\`bd where\` answered "${resolved}", which is not an absolute path` };
	}

	// A resolution that landed outside the checkout is the walk-up hazard, not a database. It
	// is refused rather than adopted, because writing a run's beads into a personal database
	// is silent and unrecoverable by anyone else.
	if (!resolved.startsWith(`${cwd}${path.sep}`) && resolved !== cwd) {
		return {
			ok: false,
			reason: `bd resolved its database to ${resolved}, which is outside this checkout (${cwd}). bd walks up from the working directory and \`.beads/\` is gitignored, so an isolated checkout can resolve to a personal database instead of the run's. Set BEADS_DIR to the run's \`.beads\` before starting work here.`,
		};
	}

	process.env.BEADS_DIR = resolved;
	return { ok: true, note: `pointed this session at the run's database at ${resolved}` };
}
