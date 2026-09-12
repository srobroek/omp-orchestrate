/**
 * The dormancy predicate: is this session inside an orchestrate run?
 *
 * One answer for every handler in the plugin. A run scope exists iff a strictly valid
 * active-run marker is readable at the session's cwd, or at the primary checkout whose
 * `.git` a linked worktree at the cwd shares. `/orchestrate-start` writes that marker after
 * the run's database has been located, so marker implies a validated store;
 * `/orchestrate-stop` removes it, and that is how a run ends. An isolated copy carries
 * the primary's marker, so a worker reaches its run through the same file at its own cwd;
 * an architect in a Worktrunk worktree holds none (`.orchestration/` is gitignored) and
 * reaches it through `git rev-parse --git-common-dir`, asked once per cwd per process.
 *
 * Nothing else creates a scope. A declared `ORC-ROLE` is a claim the prompt makes about
 * itself, an observed claim is something the agent did by hand, and neither may switch
 * enforcement on in a repository no run has marked. Measured before this predicate
 * existed: a plain session in a repository with no `.beads/` was refused `git worktree
 * add`, spawned `omp config list` on every `task`, ran `bd list` once a minute per silent
 * subagent and wrote `.orchestration/audit/` into the user's tree
 * (`scratch/audit/research/ResInterference.md`). Outside a scope the plugin spawns no
 * process, writes no file, sends no message and refuses no tool call.
 *
 * An unreadable or malformed marker is not positive authority and reads as no scope;
 * `/orchestrate-status` is where the operator learns why.
 *
 * Memoised per cwd for the process. The marker is `stat`ed on every call, which costs
 * microseconds, and the parsed scope is reused while the file's identity and mtime hold.
 * Two writes within one timestamp tick would be indistinguishable, so size and inode are
 * compared too; `writeMarker` renames a fresh temporary into place, so a rewrite always
 * changes the inode. The git answer for a cwd never changes while the checkout exists, so
 * it is kept for the process: a cwd with no marker costs one `git` spawn, then a stat.
 */

import { execFile } from "node:child_process";
import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { getWorktreesDir } from "@oh-my-pi/pi-utils";
import { realpathOrUndefined, within } from "./gates/worktree";
import { markerPath, readActiveRunStrict } from "./run-state";

export interface RunScope {
	/** The run epic the marker names, or `pending` before a bind. */
	runId: string;
	/** The marker file this scope was read from. */
	markerPath: string;
	/** The run's `.beads`, as activation recorded it; absent on a marker written before the field. */
	beadsDir: string | undefined;
	/**
	 * The checkout that owns the run: the session's cwd, or for an isolated copy under
	 * OMP's worktrees base the primary it was cloned from, where its `bd` writes land.
	 */
	root: string;
}

/** The context fields the predicate reads; timers and bus handlers hand it a bare cwd. */
export type RunScopeContext = Pick<ExtensionContext, "cwd">;

interface Memo {
	markerPath: string;
	ino: number;
	mtimeMs: number;
	size: number;
	scope: RunScope | null;
}

const memo = new Map<string, Memo>();

/** The primary checkout a cwd's `.git` belongs to, by cwd; `undefined` when the cwd is its own. */
const primaries = new Map<string, Promise<string | undefined>>();

const execFileAsync = promisify(execFile);

/** Forget every memoised scope and git answer. Tests that rebuild a checkout in place call this. */
export function resetRunScopes(): void {
	memo.clear();
	primaries.clear();
}

/**
 * The run this session is inside, or `null` when it is inside none.
 *
 * Never throws: every failure to read or parse the marker is "no scope", because a
 * throwing `tool_call` handler blocks the tool it was inspecting.
 */
export async function runScope(ctx: RunScopeContext): Promise<RunScope | null> {
	const cwd = ctx.cwd;
	if (typeof cwd !== "string" || cwd.length === 0) return null;
	const own = await markedScope(cwd);
	if (own !== null) return own;
	const primary = await primaryCheckout(cwd);
	return primary === undefined ? null : markedScope(primary);
}

/** The scope the marker at `cwd` describes, memoised on the marker file's identity. */
async function markedScope(cwd: string): Promise<RunScope | null> {
	const marker = markerPath(cwd);
	let stat: Stats;
	try {
		stat = await fs.stat(marker);
	} catch {
		memo.delete(cwd);
		return null;
	}
	const cached = memo.get(cwd);
	if (cached !== undefined && cached.markerPath === marker && cached.ino === stat.ino && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
		return cached.scope;
	}
	let scope: RunScope | null;
	try {
		const run = await readActiveRunStrict(cwd);
		scope = run === null ? null : { runId: run.run_id, markerPath: marker, beadsDir: run.beads_dir, root: await runRoot(cwd, run.beads_dir) };
	} catch {
		// Malformed or unreadable: not positive run authority. Not memoised either, so a
		// permission fix that leaves the mtime alone is seen on the next call.
		return null;
	}
	memo.set(cwd, { markerPath: marker, ino: stat.ino, mtimeMs: stat.mtimeMs, size: stat.size, scope });
	return scope;
}

/** git's exit status for a directory that is not inside any repository: a definite answer. */
const NOT_A_REPOSITORY = 128;

/**
 * The checkout whose `.git` the cwd shares, when that is another directory: the primary
 * of a linked worktree, or the top level above a subdirectory. A cwd that is its own top
 * level, or no git checkout at all, answers `undefined`. Asked of git once per cwd; a
 * verdict git could not give (a timeout, no `git` on PATH) is not kept, so the next call
 * asks again.
 */
function primaryCheckout(cwd: string): Promise<string | undefined> {
	let pending = primaries.get(cwd);
	if (pending === undefined) {
		pending = (async () => {
			try {
				const env = { ...process.env };
				// Repository-selection overrides must not turn another checkout into authority.
				for (const name of Object.keys(env)) if (name.startsWith("GIT_")) delete env[name];
				const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--git-common-dir"], { env, timeout: 1500, maxBuffer: 16 * 1024 });
				const [common, real] = await Promise.all([realpathOrUndefined(path.resolve(cwd, stdout.trim())), realpathOrUndefined(cwd)]);
				if (common === undefined || real === undefined) return undefined;
				const primary = path.dirname(common);
				return primary === real ? undefined : primary;
			} catch (error) {
				const definite = error !== null && typeof error === "object" && "code" in error && error.code === NOT_A_REPOSITORY;
				if (!definite) primaries.delete(cwd);
				return undefined;
			}
		})();
		primaries.set(cwd, pending);
	}
	return pending;
}

/**
 * The primary checkout for an isolated copy, otherwise the cwd itself.
 *
 * A copy sits beneath OMP's worktrees base and its marker names the primary's `.beads`,
 * the store `src/clone-adopt.ts` redirects the copy to. A lead in a linked worktree also
 * has a `beads_dir` elsewhere (bd resolves it through Git's common directory), but its
 * cwd is not a copy, and its cwd is where the run was activated.
 */
async function runRoot(cwd: string, beadsDir: string | undefined): Promise<string> {
	if (beadsDir === undefined) return cwd;
	const [base, real] = await Promise.all([realpathOrUndefined(getWorktreesDir()), realpathOrUndefined(cwd)]);
	if (base === undefined || real === undefined || real === base || !within(real, base)) return cwd;
	return path.dirname(beadsDir);
}
