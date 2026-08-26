import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureBeadsPath } from "../src/beads-mode";

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
	// Built under $HOME rather than os.tmpdir(): the resolution guard compares the answer
	// against the working directory, and macOS reports /tmp as /private/tmp, which would make
	// a correct answer look like it landed outside the checkout.
	dir = await fs.mkdtemp(path.join(process.env.HOME ?? os.homedir(), ".orc-beads-"));
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

	test("an inherited BEADS_DIR is left exactly as it arrived", async () => {
		// The run resolved it; re-resolving inside an isolated checkout would replace a correct
		// value with a local one, which is the whole failure this module exists to prevent.
		process.env.BEADS_DIR = "/run/owned/.beads";
		await stub(`echo "$@" >> "$ARGV_LOG"
echo "/somewhere/else/.beads"
exit 0`);

		expect(await ensureBeadsPath(dir)).toEqual({ ok: true });
		expect(process.env.BEADS_DIR).toBe("/run/owned/.beads");
		// bd is not consulted at all, so an inherited answer costs nothing.
		expect(await argv()).toEqual([]);
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
		expect(result.ok === false && result.reason).toContain("outside this checkout");
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

	test("bd's own failure is reported rather than worked around", async () => {
		await stub(`echo "$@" >> "$ARGV_LOG"
echo "Error: no beads database found" >&2
exit 1`);

		const result = await ensureBeadsPath(dir);
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.reason).toContain("no beads database found");
		expect(process.env.BEADS_DIR).toBeUndefined();
	});

	test("a missing bd refuses rather than proceeding unverified", async () => {
		process.env.BD_BIN = path.join(dir, "definitely-not-a-binary");

		const result = await ensureBeadsPath(dir);
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.reason).toContain("bd could not be run");
	});
});
