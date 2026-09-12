import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ensureBeadsPath } from "../src/beads-mode";

const execFileAsync = promisify(execFile);

/**
 * Every branch is driven through a stub `bd` on `BD_BIN`, the same seam `bdRun` reads.
 *
 * The stub records its argv, because the call is the contract: exactly one `bd where` and
 * nothing else. An earlier version of this module policed storage modes and initialised
 * databases, and its cost was a server per project plus 28 orphaned `dolt sql-server`
 * processes on the host. Embedded mode needs a path, not a lifecycle.
 */
let dir: string;
let previousBin: string | undefined;
let previousBeadsDir: string | undefined;

/** A fresh repository with one commit and no host hooks, signing, or identity lookups. */
const GIT_QUIET = ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "user.email=test@example.com", "-c", "user.name=Test"];
async function git(...args: string[]): Promise<void> {
	await execFileAsync("git", [...GIT_QUIET, ...args]);
}
async function initRepo(root: string): Promise<void> {
	await fs.mkdir(root, { recursive: true });
	await git("init", "-q", root);
	await git("-C", root, "commit", "-q", "--allow-empty", "-m", "init");
}
/** Long enough for three git spawns on a loaded host; short enough to name a hang. */
const GIT_TIMEOUT_MS = 15_000;

async function stub(script: string): Promise<void> {
	const bin = path.join(dir, "bd-stub");
	await fs.writeFile(bin, `#!/bin/sh\nARGV_LOG='${path.join(dir, "argv.log")}'\n${script}\n`);
	await fs.chmod(bin, 0o755);
	process.env.BD_BIN = bin;
}

async function argv(): Promise<string[]> {
	const log = await fs.readFile(path.join(dir, "argv.log"), "utf8").catch(() => "");
	return log.split("\n").filter(line => line.length > 0);
}

beforeEach(async () => {
	// Canonical from the start: the guard compares bd's answer with the working directory
	// after resolving symlinks, and macOS reports the temp root through /private. A fixture
	// under the raw os.tmpdir() would then expect the uncanonical spelling back.
	dir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "orc-beads-"));
	previousBin = process.env.BD_BIN;
	// This module assigns BEADS_DIR deliberately, so it is saved and restored rather than left
	// to leak into every later test in the process.
	previousBeadsDir = process.env.BEADS_DIR;
	delete process.env.BEADS_DIR;
});

afterEach(async () => {
	if (previousBin === undefined) delete process.env.BD_BIN;
	else process.env.BD_BIN = previousBin;
	if (previousBeadsDir === undefined) delete process.env.BEADS_DIR;
	else process.env.BEADS_DIR = previousBeadsDir;
	await fs.rm(dir, { recursive: true, force: true });
});

describe("ensureBeadsPath", () => {
	test("a resolved database is pinned in the environment", async () => {
		await stub(`echo "$@" >> "$ARGV_LOG"
echo "${path.join("$PWD", ".beads")}"
echo "  database: ${path.join("$PWD", ".beads", "embeddeddolt")}"
exit 0`);

		const result = await ensureBeadsPath(dir);
		expect(result.ok).toBe(true);
		// The assignment is the product: src/bd.ts spawns with { ...process.env } and subagents
		// inherit it, so one assignment reaches every later bd call and every child.
		expect(process.env.BEADS_DIR).toBe(path.join(dir, ".beads"));
		// One question, once. No init, no mode probe, no server lifecycle.
		expect(await argv()).toEqual(["where"]);
	});

	test("a database bd names beneath a symlinked checkout is pinned even before it exists", async () => {
		// `bd where` answers `<cwd>/.beads` as bd spells the cwd, and on macOS a run started
		// under /var is spelled /private/var once resolved. A missing `.beads` has no realpath,
		// so the raw answer was compared with the canonical cwd and every such run was refused.
		const real = path.join(dir, "checkout");
		await fs.mkdir(real);
		const alias = path.join(dir, "alias");
		await fs.symlink(real, alias, "dir");
		const answered = path.join(alias, ".beads");
		await stub(`echo "$@" >> "$ARGV_LOG"
echo "${answered}"
exit 0`);

		const result = await ensureBeadsPath(alias);

		expect(result.ok).toBe(true);
		expect(process.env.BEADS_DIR).toBe(path.join(real, ".beads"));
	});

	test("a linked worktree pins the primary checkout database", async () => {
		const primary = path.join(dir, "primary");
		const worktree = path.join(dir, "linked");
		await initRepo(primary);
		await git("-C", primary, "worktree", "add", "-q", "-b", "linked", worktree);
		const primaryBeads = path.join(primary, ".beads");
		await fs.mkdir(primaryBeads);
		await stub(`echo "$@" >> "$ARGV_LOG"
echo "${primaryBeads}"
exit 0`);

		const result = await ensureBeadsPath(worktree);

		expect(result.ok).toBe(true);
		expect(process.env.BEADS_DIR).toBe(primaryBeads);
	}, GIT_TIMEOUT_MS);

	test("a worktree attached to a bare repository cannot adopt an ancestor database", async () => {
		const source = path.join(dir, "source");
		const bare = path.join(dir, "remote.git");
		const worktree = path.join(dir, "bare-linked");
		await initRepo(source);
		await git("clone", "-q", "--bare", source, bare);
		await git("--git-dir", bare, "worktree", "add", "-q", "-b", "linked", worktree);
		const ancestorBeads = path.join(dir, ".beads");
		await fs.mkdir(ancestorBeads);
		await stub(`echo "$@" >> "$ARGV_LOG"
echo "${ancestorBeads}"
exit 0`);

		const result = await ensureBeadsPath(worktree);

		expect(result.ok).toBe(false);
		expect(result.ok === false && result.reason).toContain("does not belong to this checkout");
		expect(process.env.BEADS_DIR).toBeUndefined();
	}, GIT_TIMEOUT_MS);

	test("a valid inherited BEADS_DIR is kept, canonicalised, and never re-resolved", async () => {
		// The run resolved it; re-resolving inside an isolated checkout would replace a correct
		// value with a local one, which is the whole failure this module exists to prevent.
		const owned = path.join(dir, "run-owned", ".beads");
		await fs.mkdir(owned, { recursive: true });
		const alias = path.join(dir, "alias");
		await fs.symlink(path.join(dir, "run-owned"), alias, "dir");
		process.env.BEADS_DIR = path.join(alias, ".beads");
		await stub(`echo "$@" >> "$ARGV_LOG"
echo "/somewhere/else/.beads"
exit 0`);

		expect(await ensureBeadsPath(dir)).toEqual({ ok: true });
		// Canonical, so it compares equal to the paths the gates canonicalise.
		expect(process.env.BEADS_DIR).toBe(await fs.realpath(owned));
		// bd is not consulted at all, so an inherited answer costs nothing.
		expect(await argv()).toEqual([]);
	});

	test.each([
		["relative", ".beads", "not an absolute path"],
		["nonexistent", "/definitely/not/here/.beads", "does not exist"],
	])("an inherited BEADS_DIR that is %s is refused, not trusted", async (_label, value, reason) => {
		// G1, the runtime-override gate, and the mismatch report all require an absolute pin;
		// accepting this value reported the run active with every one of them disarmed.
		process.env.BEADS_DIR = value;
		await stub(`echo "$@" >> "$ARGV_LOG"
echo "/somewhere/else/.beads"
exit 0`);

		const result = await ensureBeadsPath(dir);
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.reason).toContain(reason);
		expect(process.env.BEADS_DIR).toBe(value);
		expect(await argv()).toEqual([]);
	});

	test("an inherited BEADS_DIR naming a file is refused", async () => {
		const file = path.join(dir, "not-a-dir");
		await fs.writeFile(file, "");
		process.env.BEADS_DIR = file;

		const result = await ensureBeadsPath(dir);
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.reason).toContain("is not a directory");
	});

	test("a database resolved outside the checkout is refused, not adopted", async () => {
		// Measured on this host: $HOME/.beads exists. bd walks up from the working directory and
		// `.beads/` is gitignored, so a clone or worktree arrives without one and the walk can
		// end in a personal database that no run reads. Adopting it would be silent.
		await stub(`echo "$@" >> "$ARGV_LOG"
echo "${path.join(process.env.HOME ?? os.homedir(), ".beads")}"
exit 0`);

		const result = await ensureBeadsPath(dir);
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.reason).toContain("does not belong to this checkout");
		expect(process.env.BEADS_DIR).toBeUndefined();
	});

	test("a relative answer is refused rather than joined to a guess", async () => {
		await stub(`echo "$@" >> "$ARGV_LOG"
echo ".beads"
exit 0`);

		const result = await ensureBeadsPath(dir);
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.reason).toContain("not an absolute path");
		expect(process.env.BEADS_DIR).toBeUndefined();
	});

	test("a project without a beads workspace is left unpinned", async () => {
		await stub(`echo "$@" >> "$ARGV_LOG"
echo "No active beads workspace found" >&2
exit 1`);

		expect(await ensureBeadsPath(dir)).toEqual({ ok: true, tracked: false });
		expect(process.env.BEADS_DIR).toBeUndefined();
	});

	test("bd's unexpected failure is reported rather than worked around", async () => {
		await stub(`echo "$@" >> "$ARGV_LOG"
echo "permission denied" >&2
exit 1`);

		const result = await ensureBeadsPath(dir);
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.reason).toContain("permission denied");
		expect(process.env.BEADS_DIR).toBeUndefined();
	});

	test("a missing bd refuses rather than proceeding unverified", async () => {
		process.env.BD_BIN = path.join(dir, "definitely-not-a-binary");

		const result = await ensureBeadsPath(dir);
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.reason).toContain("bd could not be run");
	});
});
