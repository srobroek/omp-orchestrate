/**
 * G7 — The primary branch is the lead's.
 *
 * Measured in the end-to-end campaign (D-adversarial-01, D-adversarial-04): a generic
 * helper in an isolated copy made a Worktrunk worktree, committed there and ran
 * `git push origin HEAD:main`. Nothing in the plugin refused it; the operator's git router
 * timing out was all that stopped the push, and a dry run through the same router exited 0.
 * Under the posture that is a proven violation. The run's primary branch
 * (`metadata.primary_branch` on the run epic, `main` when unset) receives the landing
 * sweep's merges and nothing else, and a history rewrite on any remote branch discards
 * work other sessions build on.
 *
 * Inside a run scope, from every session but the lead (`isLeadSession`), this refuses:
 *
 * - a `git push` whose destination is the primary branch: `origin HEAD:main`, `origin main`,
 *   `origin :main`, `--delete origin main`, `refs/heads/main`, and a bare `git push` or
 *   `origin HEAD` from a checkout whose current branch is the primary;
 * - a `git push` that rewrites history: `--force`, `-f`, `--force-with-lease`, `+<refspec>`;
 * - `git push --all`, `--branches` or `--mirror`, which push the primary with everything else;
 * - `wt switch --create` from a generic helper (role-less, not the lead). A helper works in
 *   the tree it was given; G3 covers `git worktree add`, this covers the Worktrunk form.
 *
 * A push to `omp/task/<id>`, to the branch a session made, or to any other branch by name
 * passes, as does every read. Where the destination depends on `HEAD`, the branch is read
 * with one `git symbolic-ref` at the checkout the command addresses (`-C` honoured); a
 * detached or unreadable `HEAD` is no proof and passes, and git itself fails such a push.
 * The primary branch is read from the run epic; an unreadable epic, or an unbound marker,
 * means the default.
 *
 * Matching is on parsed argv (`src/shell.ts`), so a comment that mentions `git push` does
 * not trip the gate and `git log --grep push` is a read. Parsing costs nothing that spawns;
 * the marker read and the epic read happen only once a command is known to push.
 */

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { ExtensionContext, ToolCallEventResult } from "@oh-my-pi/pi-coding-agent";
import { bdShow, metadataString } from "../bd";
import { orcRole } from "../identity";
import { type RunScope, runScope } from "../run-scope";
import { isLeadSession } from "../run-state";
import { commandInvocations, type Invocation, splitFlag } from "../shell";

const execFileAsync = promisify(execFile);

/** The primary branch when the run epic names none. */
const DEFAULT_PRIMARY = "main";

/** Run id an activated, not yet bound, marker carries. It names no epic. */
const PENDING_RUN = "pending";

/** A bundle of short flags: `-fu`, `-nf`. Single-dash, letters only. */
const SHORT_CLUSTER = /^-[A-Za-z]+$/;

/** `git push` options whose operand may be the next token, so that token is not the remote. */
const PUSH_OPERAND_FLAGS: Record<string, true> = {
	"--repo": true,
	"--receive-pack": true,
	"--exec": true,
	"-o": true,
	"--push-option": true,
};

/** `wt switch` options whose operand may be the next token, so that token is not a flag. */
const WT_SWITCH_OPERAND_FLAGS: Record<string, true> = {
	"-b": true,
	"--base": true,
	"-x": true,
	"--execute": true,
	"--format": true,
};

/** What one `git push` asks of the remote, as far as this gate reads it. */
interface Push {
	/** `--force`, `-f`, `--force-with-lease` or a `+refspec`: a history rewrite. */
	force: boolean;
	/** `--all`, `--branches`, `--mirror`: every branch, the primary included. */
	everyBranch: boolean;
	/** `--tags` with no refspec pushes tags only, so it names no branch. */
	tagsOnly: boolean;
	/** The refspecs after the remote, `+` stripped. */
	refspecs: string[];
	/** The program's global flags, for the checkout `HEAD` is read from. */
	globals: readonly string[];
}

/** Read one `git push` argv as git would: flags in any order, positionals after `--` verbatim. */
function parsePush(invocation: Invocation): Push {
	const { args, globals } = invocation;
	let force = false;
	let lease = false;
	let everyBranch = false;
	let tags = false;
	const positionals: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const token = args[index] as string;
		if (token === "--") {
			positionals.push(...args.slice(index + 1));
			break;
		}
		if (!token.startsWith("-") || token === "-") {
			positionals.push(token);
			continue;
		}
		const { flag, inline } = splitFlag(token);
		switch (flag) {
			case "--force": force = true; break;
			case "--no-force": force = false; break;
			case "--force-with-lease": lease = true; break;
			case "--no-force-with-lease": lease = false; break;
			case "--all": case "--branches": case "--mirror": everyBranch = true; break;
			case "--tags": tags = true; break;
			default:
				if (PUSH_OPERAND_FLAGS[flag] === true) {
					if (inline === undefined) index += 1;
				} else if (SHORT_CLUSTER.test(token)) {
					if (token.includes("f")) force = true;
					if (token.endsWith("o")) index += 1;
				}
		}
	}
	// The first positional is the repository; git reads a lone refspec as one too.
	const refspecs: string[] = [];
	for (const refspec of positionals.slice(1)) {
		if (refspec.startsWith("+")) {
			force = true;
			refspecs.push(refspec.slice(1));
		} else {
			refspecs.push(refspec);
		}
	}
	return { force: force || lease, everyBranch, tagsOnly: tags && refspecs.length === 0 && !everyBranch, refspecs, globals };
}

/** Whether a `wt switch` argv carries `--create` or `-c`; words after `--` belong to `--execute`. */
function createsBranch(invocation: Invocation): boolean {
	const { args } = invocation;
	for (let index = 0; index < args.length; index += 1) {
		const token = args[index] as string;
		if (token === "--") return false;
		const { flag, inline } = splitFlag(token);
		if (flag === "--create") return true;
		if (WT_SWITCH_OPERAND_FLAGS[flag] === true) {
			if (inline === undefined) index += 1;
			continue;
		}
		if (SHORT_CLUSTER.test(token) && token.includes("c")) return true;
	}
	return false;
}

/** The checkout a `git` invocation acts on: the cwd, moved by each `-C` in order, as git applies them. */
function repositoryDir(cwd: string, globals: readonly string[]): string {
	let dir = cwd;
	for (let index = 0; index < globals.length; index += 1) {
		if (globals[index] === "-C" && index + 1 < globals.length) {
			dir = path.resolve(dir, globals[index + 1] as string);
			index += 1;
		}
	}
	return dir;
}

/** The branch `HEAD` names at `dir`, or `undefined` when detached, not a repository, or git did not answer. */
async function currentBranch(dir: string): Promise<string | undefined> {
	try {
		const env = { ...process.env };
		// Repository-selection overrides must not describe another checkout as this one.
		for (const name of Object.keys(env)) if (name.startsWith("GIT_")) delete env[name];
		const { stdout } = await execFileAsync("git", ["-C", dir, "symbolic-ref", "--quiet", "--short", "HEAD"], {
			env,
			timeout: 1500,
			maxBuffer: 16 * 1024,
		});
		const branch = stdout.trim();
		return branch.length > 0 ? branch : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The branch names a push writes, in the remote's `refs/heads/`. A refspec's destination
 * is the part after `:`, else its source; `HEAD` is the current branch; `refs/heads/x` is
 * `x`; any other qualified ref (a tag, a remote-tracking ref) is not a branch. A push with
 * no refspec pushes the current branch under every `push.default` but `nothing`.
 */
async function pushedBranches(push: Push, cwd: string): Promise<string[]> {
	if (push.tagsOnly) return [];
	let head: string | undefined;
	let headRead = false;
	const resolveHead = async (): Promise<string | undefined> => {
		if (!headRead) {
			head = await currentBranch(repositoryDir(cwd, push.globals));
			headRead = true;
		}
		return head;
	};

	if (push.refspecs.length === 0) {
		const branch = await resolveHead();
		return branch === undefined ? [] : [branch];
	}

	const branches: string[] = [];
	for (const refspec of push.refspecs) {
		const colon = refspec.indexOf(":");
		const destination = colon === -1 ? refspec : refspec.slice(colon + 1);
		if (destination.length === 0) continue;
		if (destination === "HEAD") {
			const branch = await resolveHead();
			if (branch !== undefined) branches.push(branch);
			continue;
		}
		if (destination.startsWith("refs/")) {
			if (destination.startsWith("refs/heads/")) branches.push(destination.slice("refs/heads/".length));
			continue;
		}
		branches.push(destination);
	}
	return branches;
}

/** The run's primary branch: `metadata.primary_branch` on the run epic, else the default. */
async function primaryBranch(scope: RunScope): Promise<string> {
	if (scope.runId === PENDING_RUN) return DEFAULT_PRIMARY;
	const epic = await bdShow(scope.runId, undefined, scope.root);
	return metadataString(epic, "primary_branch") ?? DEFAULT_PRIMARY;
}

/** Refuse a push to the run's primary branch, a history rewrite, or a helper's own worktree. */
export async function gatePush(ctx: ExtensionContext, input: Record<string, unknown>): Promise<ToolCallEventResult | undefined> {
	const command = input.command;
	if (typeof command !== "string" || command.length === 0) return undefined;

	const pushes = commandInvocations(command, ["git", "push"]).map(parsePush);
	const creates = commandInvocations(command, ["wt", "switch"]).some(createsBranch);
	if (pushes.length === 0 && !creates) return undefined;
	const scope = await runScope(ctx);
	if (scope === null) return undefined;
	if (await isLeadSession(ctx)) return undefined;

	if (creates && orcRole(ctx) === undefined) {
		return {
			block: true,
			reason: "a generic helper creates no checkout; work in the tree you were given, or ask the lead for a role-bound task with its own worktree",
		};
	}

	for (const push of pushes) {
		if (push.force) {
			return {
				block: true,
				reason: "a force push rewrites a branch other sessions build on; only the lead rewrites history inside a run. Push a new commit to your task branch instead",
			};
		}
	}
	if (pushes.length === 0) return undefined;

	const primary = await primaryBranch(scope);
	for (const push of pushes) {
		if (push.everyBranch) {
			return {
				block: true,
				reason: `git push --all, --branches and --mirror push ${primary} with everything else; push your task branch by name`,
			};
		}
		if ((await pushedBranches(push, ctx.cwd)).includes(primary)) {
			return {
				block: true,
				reason: `pushing to ${primary} is the lead's landing step; push your work to omp/task/<id> or your task branch and let the landing sweep merge it`,
			};
		}
	}
	return undefined;
}
