#!/usr/bin/env bun
/**
 * Reclaim finished Worktrunk checkouts and quarantine broken harness orphans.
 *
 * Registered worktrees are removed only through `wt remove`. Prune mode scans known
 * harness roots and moves broken, unregistered directories to quarantine. It never
 * deletes their contents (disk/orphan history: bead astro-plan-ki35).
 *
 * Usage:
 *   worktree-sweep.ts [--discard-branch] <worktree-path>
 *   worktree-sweep.ts --prune <repo-path>
 * Exit codes: 0 swept/quarantined, 1 dirty (refused), 2 usage/tool/safety error.
 *
 * Environment: `WT_BIN` and `GIT_BIN` name the binaries; `ORCHESTRATE_HARNESS_ROOT` adds
 * one harness root to prune; `ORCHESTRATE_ORPHAN_QUARANTINE` places the quarantine
 * directory (default `$TMPDIR/orchestrate-orphan-quarantine`).
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, statSync } from "node:fs";
import path from "node:path";

const USAGE = "usage: worktree-sweep.ts [--discard-branch] <worktree-path> | --prune <repo-path>";

/** One worktree as the sweep reads it: where it is, and whether it is the primary. */
export interface InventoryRow {
	path?: string;
	is_main?: boolean;
}

/** A JSON object as the shell port's `isinstance(x, dict)` accepted it: arrays excluded. */
function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Flatten a `wt list --format=json` payload to rows carrying `path` and `is_main`.
 *
 * Schema 1 is a flat array of rows. Schema 2 is an envelope whose `items[]` nest the
 * location under `worktree.path` and the primary flag under `worktree.main`; both are
 * lifted to the flat names. Returns the reason as a string when the shape is neither.
 */
export function flattenInventory(payload: unknown): InventoryRow[] | { invalid: string } {
	let rows: unknown;
	if (isObject(payload)) {
		const items = payload.items;
		if (!Array.isArray(items)) return { invalid: "inventory envelope has no items array" };
		const flattened: Record<string, unknown>[] = [];
		for (const item of items) {
			if (!isObject(item)) return { invalid: "inventory contains a non-object item" };
			const merged: Record<string, unknown> = { ...item };
			const worktree = item.worktree;
			if (isObject(worktree)) {
				if ("path" in worktree) merged.path = worktree.path;
				merged.is_main = Boolean(worktree.main);
			}
			flattened.push(merged);
		}
		rows = flattened;
	} else {
		rows = payload;
	}
	if (!Array.isArray(rows)) return { invalid: "inventory is not an array" };
	const out: InventoryRow[] = [];
	for (const row of rows) {
		if (!isObject(row)) return { invalid: "inventory contains a non-object item" };
		if ("path" in row && typeof row.path !== "string") return { invalid: "inventory path is not a string" };
		const entry: InventoryRow = {};
		if (typeof row.path === "string") entry.path = row.path;
		if (row.is_main !== undefined) entry.is_main = Boolean(row.is_main);
		out.push(entry);
	}
	return out;
}

/** A path with its symlinks resolved; a path that does not exist resolves lexically. */
function realpath(target: string): string {
	try {
		return realpathSync(target);
	} catch {
		return path.resolve(target);
	}
}

/** `main` for the primary worktree, `linked` for a registered one, `undefined` for a stranger. */
export function classifyPath(rows: readonly InventoryRow[], target: string): "main" | "linked" | undefined {
	const wanted = realpath(target);
	for (const row of rows) {
		if (row.path !== undefined && row.path.length > 0 && realpath(row.path) === wanted) {
			return row.is_main ? "main" : "linked";
		}
	}
	return undefined;
}

function die(message: string): never {
	process.stderr.write(`worktree-sweep: ${message}\n`);
	process.exit(2);
}

function refuse(message: string): void {
	process.stderr.write(`worktree-sweep: ${message}\n`);
}

function isDirectory(target: string): boolean {
	try {
		return statSync(target).isDirectory();
	} catch {
		return false;
	}
}

function isRegularFile(target: string): boolean {
	try {
		return statSync(target).isFile();
	} catch {
		return false;
	}
}

interface Captured {
	code: number;
	stdout: string;
}

/**
 * Run a binary and capture stdout; stderr is discarded unless `showStderr`. `null` when it
 * could not run. `git` runs inside `cwd` rather than with `-C`, which a git router shim
 * may refuse; `wt` takes its own `-C` and runs from the caller's directory.
 */
function capture(argv: string[], cwd?: string, showStderr = false): Captured | null {
	try {
		const result = Bun.spawnSync(argv, { ...(cwd === undefined ? {} : { cwd }), stdout: "pipe", stderr: showStderr ? "inherit" : "ignore", stdin: "ignore" });
		return { code: result.exitCode, stdout: result.stdout.toString() };
	} catch {
		return null;
	}
}

function readInventory(wt: string, anchor: string): InventoryRow[] {
	// Pin the JSON schema so a future Worktrunk default flip cannot change the parsed
	// shape underneath this sweep.
	const listed = capture([wt, "-C", anchor, "--config-set", "list.json-schema=2", "list", "--format=json"]);
	if (listed === null || listed.code !== 0) die(`wt list failed for: ${anchor}`);
	let payload: unknown;
	try {
		payload = JSON.parse(listed.stdout);
	} catch {
		die(`wt list returned invalid inventory for: ${anchor}`);
	}
	const rows = flattenInventory(payload);
	if ("invalid" in rows) die(`wt list returned invalid inventory for: ${anchor}`);
	return rows;
}

function quarantinePath(source: string, tmpRoot: string): void {
	const quarantineRoot = process.env.ORCHESTRATE_ORPHAN_QUARANTINE || path.join(tmpRoot, "orchestrate-orphan-quarantine");
	mkdirSync(quarantineRoot, { recursive: true });
	const stamp = new Date().toISOString().replace(/[-:]|\.\d{3}/g, "");
	const base = path.join(quarantineRoot, `${path.basename(source)}.${stamp}`);
	let destination = base;
	for (let counter = 2; existsSync(destination); counter++) destination = `${base}-${counter}`;
	try {
		renameSync(source, destination);
	} catch (error) {
		die(`cannot move ${source} to ${destination}: ${error instanceof Error ? error.message : String(error)}`);
	}
	console.log(`quarantined orphan: ${source} -> ${destination}`);
}

function prune(wt: string, git: string, rawRepo: string): never {
	if (!isDirectory(rawRepo)) die(`not a directory: ${rawRepo}`);
	const repoPath = realpath(rawRepo);
	const top = capture([git, "rev-parse", "--show-toplevel"], repoPath, true);
	if (top === null || top.code !== 0) die(`not a Git repository: ${repoPath}`);
	const repoName = path.basename(top.stdout.trim());
	const inventory = readInventory(wt, repoPath);
	const tmpRoot = realpath(process.env.TMPDIR || "/tmp");
	const roots = [
		path.join(tmpRoot, "claude-worktrees", repoName),
		path.join(tmpRoot, "codex-worktrees", repoName),
		path.join("/private/tmp/claude-worktrees", repoName),
		path.join("/private/tmp/codex-worktrees", repoName),
	];
	const extraRoot = process.env.ORCHESTRATE_HARNESS_ROOT;
	if (extraRoot) {
		if (!isDirectory(extraRoot)) die(`not a directory: ${extraRoot}`);
		roots.push(realpath(extraRoot));
	}

	let quarantined = 0;
	let refused = 0;
	for (const root of roots) {
		if (!isDirectory(root)) continue;
		const harnessRoot = realpath(root);
		// Dot entries are skipped as the shell glob skipped them.
		for (const name of readdirSync(harnessRoot).sort()) {
			if (name.startsWith(".")) continue;
			const rawCandidate = path.join(harnessRoot, name);
			if (!isDirectory(rawCandidate)) continue;
			if (lstatSync(rawCandidate).isSymbolicLink()) {
				refuse(`refusing symlink candidate: ${rawCandidate}`);
				refused++;
				continue;
			}
			const candidate = realpath(rawCandidate);
			if (!candidate.startsWith(`${harnessRoot}/`)) {
				refuse(`refusing escaped harness path: ${candidate}`);
				refused++;
				continue;
			}

			const registration = classifyPath(inventory, candidate);
			if (registration === "main") {
				refuse(`refusing primary worktree: ${candidate}`);
				refused++;
				continue;
			}
			if (registration === "linked") continue;

			const inside = capture([git, "rev-parse", "--is-inside-work-tree"], candidate);
			if (inside !== null && inside.code === 0) {
				const status = capture([git, "status", "--porcelain"], candidate);
				const dirty = status !== null && status.code === 0 && status.stdout.length > 0;
				refuse(`refusing ${dirty ? "dirty" : "valid"} unregistered worktree: ${candidate}`);
				refused++;
				continue;
			}

			if (!isRegularFile(path.join(candidate, ".git"))) {
				refuse(`refusing unknown harness directory: ${candidate}`);
				refused++;
				continue;
			}

			quarantinePath(candidate, tmpRoot);
			quarantined++;
		}
	}

	console.log(`worktree-sweep: quarantined ${quarantined} orphan(s); refused ${refused} path(s)`);
	process.exit(refused === 0 ? 0 : 1);
}

function sweep(wt: string, git: string, rawPath: string, discardBranch: boolean): never {
	if (!isDirectory(rawPath)) die(`not a directory: ${rawPath}`);
	const wtPath = realpath(rawPath);
	const registration = classifyPath(readInventory(wt, wtPath), wtPath);
	if (registration === "main") die(`refusing to remove the primary worktree: ${wtPath}`);
	if (registration === undefined) die(`path is not registered with Worktrunk: ${wtPath}`);

	const status = capture([git, "status", "--porcelain"], wtPath, true);
	if (status === null || status.code !== 0) die(`cannot inspect registered worktree: ${wtPath}`);
	if (status.stdout.length > 0) {
		refuse(`dirty, refusing: ${wtPath}`);
		process.exit(1);
	}

	const argv = [wt, "-C", wtPath, "remove", "--foreground"];
	if (discardBranch) argv.push("--force-delete");
	argv.push(wtPath);
	let code: number;
	try {
		code = Bun.spawnSync(argv, { stdout: "inherit", stderr: "inherit", stdin: "ignore" }).exitCode;
	} catch {
		code = -1;
	}
	if (code !== 0) die(`wt remove failed for: ${wtPath}`);
	console.log(`swept: ${wtPath}`);
	process.exit(0);
}

function main(args: readonly string[]): never {
	const wt = process.env.WT_BIN || "wt";
	const git = process.env.GIT_BIN || "git";
	if (Bun.which(wt) === null) die("wt is not available");
	if (Bun.which(git) === null) die("git is not available");

	if (args[0] === "--prune") {
		if (args.length !== 2) die("usage: worktree-sweep.ts --prune <repo-path>");
		prune(wt, git, args[1]!);
	}
	let discardBranch = false;
	let rest = args;
	if (rest[0] === "--discard-branch") {
		discardBranch = true;
		rest = rest.slice(1);
	}
	if (rest.length !== 1) die(USAGE);
	sweep(wt, git, rest[0]!, discardBranch);
}

if (import.meta.main) main(process.argv.slice(2));
