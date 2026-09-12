/**
 * The dormancy predicate: is this session inside an orchestrate run?
 *
 * One answer for every handler in the plugin. A run scope exists iff a strictly valid
 * active-run marker is readable at the session's cwd. `/orchestrate-run` writes that
 * marker after the run's database has been located, so marker implies a validated store;
 * `/orchestrate-close` removes it, and that is how a run ends. An isolated copy carries
 * the primary's marker, so a worker reaches its run through the same file at its own cwd.
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
 * changes the inode.
 */

import type { Stats } from "node:fs";
import fs from "node:fs/promises";
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

/** Forget every memoised scope. Tests that rewrite a marker in place within one tick call this. */
export function resetRunScopes(): void {
	memo.clear();
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
