/**
 * Reclaim finished Worktrunk checkouts and quarantine broken harness orphans.
 *
 * This module owns the sweep for both the skill's Bun CLI and the in-process OMP
 * tool. Registered worktrees are removed only through `wt remove`; prune mode
 * scans known harness roots and moves broken, unregistered directories to a
 * unique quarantine path without deleting their contents.
 */

import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmdirSync,
	renameSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const USAGE = "usage: worktree-sweep.ts [--discard-branch] <worktree-path> | worktree-sweep.ts --prune <repo-path>";

/** One worktree as the sweep reads it: where it is, and whether it is the primary. */
export interface InventoryRow {
	path?: string;
	is_main?: boolean;
}

/** A valid inventory array may carry non-enumerable item warnings for its caller. */
export interface InventoryRows extends Array<InventoryRow> {
	issues?: string[];
}

export interface InventoryInvalid {
	invalid: string;
}

/** Result returned by the CLI implementation and the registered tool. */
export interface SweepResult {
	code: number;
	stdout: string;
	stderr: string;
}

interface Captured {
	code: number;
	stdout: string;
	stderr: string;
}

interface Sink {
	stdout: string[];
	stderr: string[];
}

function finish(sink: Sink, code: number): SweepResult {
	return { code, stdout: sink.stdout.join(""), stderr: sink.stderr.join("") };
}

function out(sink: Sink, text: string): void {
	sink.stdout.push(text);
}

function err(sink: Sink, text: string): void {
	sink.stderr.push(`worktree-sweep: ${text}\n`);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Flatten Worktrunk's schema-2 envelope to rows carrying `path` and `is_main`.
 * Malformed individual rows are skipped and reported; malformed top-level shapes
 * remain fatal because there is no safe inventory to classify against.
 */
export function flattenInventory(payload: unknown): InventoryRows | InventoryInvalid {
	let rows: unknown;
	const issues: string[] = [];
	if (isObject(payload)) {
		const items = payload.items;
		if (!Array.isArray(items)) return { invalid: "inventory envelope has no items array" };
		const flattened: unknown[] = [];
		for (const [index, item] of items.entries()) {
			if (!isObject(item)) {
				issues.push(`inventory item ${index} is not an object; skipped`);
				continue;
			}
			const merged: Record<string, unknown> = { ...item };
			const worktree = item.worktree;
			if (worktree !== undefined && !isObject(worktree)) {
				issues.push(`inventory item ${index} worktree is not an object; skipped`);
				continue;
			}
			if (isObject(worktree)) {
				if ("path" in worktree && typeof worktree.path !== "string") {
					issues.push(`inventory item ${index} path is not a string; skipped`);
					continue;
				}
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

	const outRows: InventoryRows = [];
	for (const [index, row] of rows.entries()) {
		if (!isObject(row)) {
			issues.push(`inventory item ${index} is not an object; skipped`);
			continue;
		}
		if ("path" in row && typeof row.path !== "string") {
			issues.push(`inventory item ${index} path is not a string; skipped`);
			continue;
		}
		const entry: InventoryRow = {};
		if (typeof row.path === "string") entry.path = row.path;
		if (row.is_main !== undefined) entry.is_main = Boolean(row.is_main);
		outRows.push(entry);
	}
	Object.defineProperty(outRows, "issues", { value: issues, enumerable: false, writable: false });
	return outRows;
}

/** A path with symlinks resolved; a path that does not exist resolves lexically. */
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

function isDirectory(target: string): boolean {
	try {
		return statSync(target).isDirectory();
	} catch {
		return false;
	}
}

function safeTmpRoot(): string {
 for (const candidate of [tmpdir(), "/tmp", "/private/tmp", process.cwd()]) {
  if (isDirectory(candidate)) return realpath(candidate);
 }
 return process.cwd();
}

function isRegularFile(target: string): boolean {
	try {
		return statSync(target).isFile();
	} catch {
		return false;
	}
}

function capture(argv: string[], cwd?: string): Captured | null {
	try {
		const result = Bun.spawnSync(argv, {
			...(cwd === undefined ? {} : { cwd }),
			stdout: "pipe",
			stderr: "pipe",
			stdin: "ignore",
		});
		return {
			code: result.exitCode,
			stdout: result.stdout.toString(),
			stderr: result.stderr.toString(),
		};
	} catch {
		return null;
	}
}

function readInventory(wt: string, anchor: string, sink: Sink): InventoryRows | null {
	// Pin the JSON schema so a future Worktrunk default flip cannot change the parsed shape.
	const listed = capture([wt, "-C", anchor, "--config-set", "list.json-schema=2", "list", "--format=json"]);
	if (listed === null || listed.code !== 0) {
		err(sink, `wt list failed for: ${anchor}`);
		return null;
	}
	let payload: unknown;
	try {
		payload = JSON.parse(listed.stdout);
	} catch {
		err(sink, `wt list returned invalid inventory for: ${anchor}`);
		return null;
	}
	const rows = flattenInventory(payload);
	if ("invalid" in rows) {
		err(sink, `wt list returned invalid inventory for: ${anchor}: ${rows.invalid}`);
		return null;
	}
	for (const issue of rows.issues ?? []) err(sink, issue);
	return rows;
}

function quarantinePath(source: string, tmpRoot: string, sink: Sink, env: NodeJS.ProcessEnv): void {
	const quarantineRoot = env.ORCHESTRATE_ORPHAN_QUARANTINE || path.join(tmpRoot, "orchestrate-orphan-quarantine");
	mkdirSync(quarantineRoot, { recursive: true });
	const stamp = new Date().toISOString().replace(/[-:]|\.\d{3}/g, "");
	// mkdtemp supplies a race-free unique name. Remove only its empty directory, then
	// rename the source into that name; both paths are under the same quarantine root.
	const unique = mkdtempSync(path.join(quarantineRoot, `${path.basename(source)}.${stamp}-`));
	rmdirSync(unique);
	try {
		renameSync(source, unique);
	} catch (error) {
		try { rmdirSync(unique); } catch { /* preserve the original failure */ }
		throw error;
	}
	out(sink, `quarantined orphan: ${source} -> ${unique}\n`);
}

function appendCaptured(sink: Sink, captured: Captured): void {
	if (captured.stdout) out(sink, captured.stdout);
	if (captured.stderr) sink.stderr.push(captured.stderr);
}

function repoRoots(tmpRoot: string, repoName: string, extra: string | undefined, sink: Sink): string[] | null {
	const roots = new Set<string>([
		path.join(tmpRoot, "claude-worktrees", repoName),
		path.join(tmpRoot, "codex-worktrees", repoName),
		path.join("/private/tmp", "claude-worktrees", repoName),
		path.join("/private/tmp", "codex-worktrees", repoName),
	]);
	if (extra !== undefined && extra.length > 0) {
		if (!isDirectory(extra)) {
			err(sink, `not a directory: ${extra}`);
			return null;
		}
		roots.add(realpath(extra));
	}
	return [...roots];
}

function inside(root: string, target: string): boolean {
	return target === root || target.startsWith(`${root}${path.sep}`);
}

function refuse(sink: Sink, message: string): void {
	err(sink, message);
}

function prune(wt: string, git: string, rawRepo: string, env: NodeJS.ProcessEnv, sink: Sink): SweepResult {
	if (!isDirectory(rawRepo)) {
		err(sink, `not a directory: ${rawRepo}`);
		return finish(sink, 2);
	}
	const repoPath = realpath(rawRepo);
	const top = capture([git, "rev-parse", "--show-toplevel"], repoPath);
	if (top === null || top.code !== 0 || top.stdout.trim() === "") {
		err(sink, `not a Git repository: ${repoPath}`);
		return finish(sink, 2);
	}
	const repoName = path.basename(top.stdout.trim());
	const inventory = readInventory(wt, repoPath, sink);
	if (inventory === null) return finish(sink, 2);
	const tmpRoot = safeTmpRoot();
	const roots = repoRoots(tmpRoot, repoName, env.ORCHESTRATE_HARNESS_ROOT, sink);
	if (roots === null) return finish(sink, 2);

	let quarantined = 0;
	let refused = 0;
	for (const root of roots) {
		if (!isDirectory(root)) continue;
		const harnessRoot = realpath(root);
		let names: string[];
		try {
			names = readdirSync(harnessRoot).sort();
		} catch (error) {
			refuse(sink, `cannot inspect harness root ${harnessRoot}: ${error instanceof Error ? error.message : String(error)}`);
			refused++;
			continue;
		}
		for (const name of names) {
			if (name.startsWith(".")) continue;
			const rawCandidate = path.join(harnessRoot, name);
			try {
				if (!isDirectory(rawCandidate)) continue;
				if (lstatSync(rawCandidate).isSymbolicLink()) {
					refuse(sink, `refusing symlink candidate: ${rawCandidate}`);
					refused++;
					continue;
				}
				const candidate = realpath(rawCandidate);
				if (!inside(harnessRoot, candidate)) {
					refuse(sink, `refusing escaped harness path: ${candidate}`);
					refused++;
					continue;
				}

				const registration = classifyPath(inventory, candidate);
				if (registration === "main") {
					refuse(sink, `refusing primary worktree: ${candidate}`);
					refused++;
					continue;
				}
				if (registration === "linked") continue;

				const insideWorktree = capture([git, "rev-parse", "--is-inside-work-tree"], candidate);
				if (insideWorktree !== null && insideWorktree.code === 0) {
					const status = capture([git, "status", "--porcelain"], candidate);
					const dirty = status !== null && status.code === 0 && status.stdout.length > 0;
					refuse(sink, `refusing ${dirty ? "dirty" : "valid"} unregistered worktree: ${candidate}`);
					refused++;
					continue;
				}

				if (!isRegularFile(path.join(candidate, ".git"))) {
					refuse(sink, `refusing unknown harness directory: ${candidate}`);
					refused++;
					continue;
				}

				quarantinePath(candidate, tmpRoot, sink, env);
				quarantined++;
			} catch (error) {
				refuse(sink, `could not inspect or quarantine ${rawCandidate}: ${error instanceof Error ? error.message : String(error)}`);
				refused++;
			}
		}
	}

	out(sink, `worktree-sweep: quarantined ${quarantined} orphan(s); refused ${refused} path(s)\n`);
	return finish(sink, refused === 0 ? 0 : 1);
}

function sweep(wt: string, git: string, rawPath: string, discardBranch: boolean, env: NodeJS.ProcessEnv, sink: Sink): SweepResult {
	if (!isDirectory(rawPath)) {
		err(sink, `not a directory: ${rawPath}`);
		return finish(sink, 2);
	}
	const wtPath = realpath(rawPath);
	const inventory = readInventory(wt, wtPath, sink);
	if (inventory === null) return finish(sink, 2);
	const registration = classifyPath(inventory, wtPath);
	if (registration === "main") {
		err(sink, `refusing to remove the primary worktree: ${wtPath}`);
		return finish(sink, 2);
	}
	if (registration === undefined) {
		err(sink, `path is not registered with Worktrunk: ${wtPath}`);
		return finish(sink, 2);
	}

	const status = capture([git, "status", "--porcelain"], wtPath);
	if (status === null || status.code !== 0) {
		err(sink, `cannot inspect registered worktree: ${wtPath}`);
		return finish(sink, 2);
	}
	if (status.stdout.length > 0) {
		refuse(sink, `dirty, refusing: ${wtPath}`);
		return finish(sink, 1);
	}

	const argv = [wt, "-C", wtPath, "remove", "--foreground"];
	if (discardBranch) argv.push("--force-delete");
	argv.push(wtPath);
	const removed = capture(argv);
	if (removed === null) {
		err(sink, `wt remove failed for: ${wtPath}`);
		return finish(sink, 2);
	}
	appendCaptured(sink, removed);
	if (removed.code !== 0) {
		err(sink, `wt remove failed for: ${wtPath}`);
		return finish(sink, 2);
	}
	out(sink, `swept: ${wtPath}\n`);
	return finish(sink, 0);
}

function binaryAvailable(binary: string): boolean {
	try {
		return Bun.which(binary) !== null;
	} catch {
		return false;
	}
}

/** Execute the sweep and return stdout, stderr, and the process-style exit code. */
export function runWorktreeSweep(args: readonly string[], env: NodeJS.ProcessEnv = process.env): SweepResult {
	const sink: Sink = { stdout: [], stderr: [] };
	const wt = env.WT_BIN || "wt";
	const git = env.GIT_BIN || "git";
	if (!binaryAvailable(wt)) {
		err(sink, "wt is not available");
		return finish(sink, 2);
	}
	if (!binaryAvailable(git)) {
		err(sink, "git is not available");
		return finish(sink, 2);
	}

	if (args[0] === "--prune") {
		if (args.length !== 2) {
			err(sink, `usage: ${USAGE}`);
			return finish(sink, 2);
		}
		return prune(wt, git, args[1]!, env, sink);
	}
	let discardBranch = false;
	let rest = [...args];
	if (rest[0] === "--discard-branch") {
		discardBranch = true;
		rest = rest.slice(1);
	}
	if (rest.length !== 1) {
		err(sink, USAGE);
		return finish(sink, 2);
	}
	return sweep(wt, git, rest[0]!, discardBranch, env, sink);
}

/** CLI entry point used by the published skill script. */
export function main(args: readonly string[] = process.argv.slice(2)): never {
	const result = runWorktreeSweep(args);
	process.stdout.write(result.stdout);
	process.stderr.write(result.stderr);
	process.exit(result.code);
}
