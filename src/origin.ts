/**
 * What origin holds at a ref, read with one `git ls-remote`.
 *
 * Origin is the only store that outlives a session's checkout: an isolated clone is deleted
 * when its agent completes or is cancelled (OMP `isolation-runner.ts`, unconditional in
 * `finally`), so a commit that is not on origin when the agent yields is gone. The exit
 * contract (G4) therefore asks origin, not the local tree, whether a role's head landed.
 *
 * `unreachable` covers every way the read can fail to answer -- no network, no `origin`
 * remote, no git, the 10 s bound -- and is not proof of absence. The caller decides what
 * an unanswered question means; for the exit contract it is a refusal, because an
 * unverified push can lose the unit.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** `ls-remote` may cross a network; bounded well inside the 30 s the host allows a handler. */
const LS_REMOTE_TIMEOUT_MS = 10_000;

/** A full commit sha as `ls-remote` prints it. */
const FULL_SHA = /^[0-9a-f]{40}$/;

export type OriginHead =
	/** The ref exists on origin and points at `sha`. */
	| { kind: "at"; sha: string }
	/** Origin answered, and holds no such ref. */
	| { kind: "missing" }
	/** Origin did not answer; `cause` is git's first line of complaint. */
	| { kind: "unreachable"; cause: string };

/**
 * The commit origin holds at `refs/heads/<branch>`, asked from the repository at `cwd`.
 *
 * `GIT_*` overrides are dropped so a `--git-dir` in the environment cannot describe
 * another checkout's remote as this one's. The ref is qualified, so a branch named like a
 * tag or a sha is not confused with one.
 */
export async function originHead(cwd: string, branch: string): Promise<OriginHead> {
	const env = { ...process.env };
	for (const name of Object.keys(env)) if (name.startsWith("GIT_")) delete env[name];
	try {
		const { stdout } = await execFileAsync(
			"git",
			["-C", cwd, "ls-remote", "--exit-code", "origin", `refs/heads/${branch}`],
			{ env, timeout: LS_REMOTE_TIMEOUT_MS, maxBuffer: 16 * 1024 },
		);
		const sha = stdout.split(/\s+/, 1)[0] ?? "";
		return FULL_SHA.test(sha) ? { kind: "at", sha } : { kind: "unreachable", cause: `unexpected ls-remote output: ${stdout.trim() || "empty"}` };
	} catch (error) {
		// `--exit-code` makes an answered-but-absent ref exit 2; anything else is no answer.
		const failure = error as { code?: unknown; stderr?: unknown; killed?: boolean };
		if (failure.code === 2) return { kind: "missing" };
		const stderr = typeof failure.stderr === "string" ? failure.stderr : "";
		const cause = failure.killed === true
			? `ls-remote did not answer within ${LS_REMOTE_TIMEOUT_MS / 1000}s`
			: stderr.split("\n").find(line => line.trim().length > 0)?.trim() ?? (error instanceof Error ? error.message : String(error));
		return { kind: "unreachable", cause };
	}
}

/** The clone's `HEAD` and whether its tree carries uncommitted changes. */
export interface LocalState {
	head: string;
	dirty: boolean;
}

/**
 * The clone at `cwd`: its `HEAD` commit and whether `git status --porcelain` prints
 * anything. `undefined` when git did not answer, which the exit contract treats like an
 * unreachable origin: work that cannot be shown to be safe is not.
 */
export async function localState(cwd: string): Promise<LocalState | undefined> {
	const env = { ...process.env };
	for (const name of Object.keys(env)) if (name.startsWith("GIT_")) delete env[name];
	try {
		const options = { env, timeout: LS_REMOTE_TIMEOUT_MS, maxBuffer: 1024 * 1024 };
		const [{ stdout: head }, { stdout: status }] = await Promise.all([
			execFileAsync("git", ["-C", cwd, "rev-parse", "HEAD"], options),
			execFileAsync("git", ["-C", cwd, "status", "--porcelain"], options),
		]);
		const sha = head.trim();
		if (!FULL_SHA.test(sha)) return undefined;
		return { head: sha, dirty: status.trim().length > 0 };
	} catch {
		return undefined;
	}
}
