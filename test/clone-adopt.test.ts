/**
 * Adoption of the run's database by an isolated copy.
 *
 * The one test that runs real `bd` proves the contract end to end: a copy of a checkout
 * that holds its own embedded store, once adopted, answers `bd where` with the primary's
 * `.beads` and lands a write there. It is skipped where `bd` is not installed (CI), and
 * the store shape it depends on is what `bd init` produces, not a fixture this file
 * invents. Every other case is filesystem-only and runs everywhere.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { adoptRunDatabase } from "../src/clone-adopt";
import type { ActiveRun } from "../src/run-state";

const execFileAsync = promisify(execFile);
const BD = Bun.which("bd");

let root: string;
/** OMP's isolation base for these tests; copies live beneath it. */
let base: string;
let previousWorktreeDir: string | undefined;

function marker(beadsDir?: string): ActiveRun {
	return beadsDir === undefined ? { schema_version: 1, run_id: "pending" } : { schema_version: 1, run_id: "pending", beads_dir: beadsDir };
}

/** A tree under the isolation base holding a store-shaped `.beads`, without running bd. */
async function fakeCopy(name: string): Promise<string> {
	const copy = path.join(base, name);
	await fs.mkdir(path.join(copy, ".beads", "embeddeddolt"), { recursive: true });
	await fs.writeFile(path.join(copy, ".beads", "embeddeddolt", "marker"), "copied store");
	return copy;
}

/**
 * Run `bd` the way a worker's shell would, with the process's own pin removed: this
 * test asserts what the redirect resolves, and an operator's stale export would answer
 * for it. The deletion below is the one place outside `src/clone-adopt.ts` that spells
 * the retired variable.
 */
async function bd(cwd: string, ...args: string[]): Promise<string> {
	const env: Record<string, string | undefined> = { ...process.env, BD_ROUTER_OFF: "1", BEADS_ACTOR: "clone-adopt-test", BD_NO_PAGER: "1", BD_NON_INTERACTIVE: "1" };
	delete env.BEADS_DIR;
	delete env.BD_JSON_ENVELOPE;
	const { stdout } = await execFileAsync(BD as string, args, { cwd, env, timeout: 30_000, maxBuffer: 1024 * 1024 });
	return stdout;
}

beforeAll(async () => {
	root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "orc-adopt-")));
	base = path.join(root, "wt");
	await fs.mkdir(base);
	previousWorktreeDir = process.env.OMP_WORKTREE_DIR;
	process.env.OMP_WORKTREE_DIR = base;
});

afterAll(async () => {
	if (previousWorktreeDir === undefined) delete process.env.OMP_WORKTREE_DIR;
	else process.env.OMP_WORKTREE_DIR = previousWorktreeDir;
	await fs.rm(root, { recursive: true, force: true });
});

describe("adoptRunDatabase", () => {
	test.skipIf(BD === null)("a copy with a store adopts the run's database, and bd follows the redirect", async () => {
		const primary = path.join(root, "primary");
		await fs.mkdir(primary);
		await execFileAsync("git", ["init", "-q", primary]);
		await bd(primary, "init", "--skip-hooks", "--skip-agents", "--non-interactive", "-p", "sb");
		const primaryBeads = path.join(primary, ".beads");
		const copy = path.join(base, "copy-1");
		await fs.cp(primary, copy, { recursive: true });
		expect(JSON.parse(await bd(copy, "where", "--json")).path).toBe(path.join(copy, ".beads"));

		expect(await adoptRunDatabase(copy, marker(primaryBeads))).toEqual({ kind: "adopted", target: primaryBeads });

		expect(await fs.readFile(path.join(copy, ".beads", "redirect"), "utf8")).toBe(`${primaryBeads}\n`);
		expect(await fs.stat(path.join(copy, ".beads", "embeddeddolt")).catch(() => null)).toBeNull();
		const where = JSON.parse(await bd(copy, "where", "--json"));
		expect(where.path).toBe(primaryBeads);
		expect(where.redirected_from).toBe(path.join(copy, ".beads"));
		// A write from the copy is a write to the run: the whole reason the redirect exists.
		await bd(copy, "q", "written from the copy");
		const listed = JSON.parse(await bd(primary, "list", "--json")) as Array<{ title: string }>;
		expect(listed.map(bead => bead.title)).toEqual(["written from the copy"]);
		// Adopted once is adopted: the second call finds no store and changes nothing.
		expect(await adoptRunDatabase(copy, marker(primaryBeads))).toEqual({ kind: "redirected" });
	}, 90_000);

	test("a marker naming a database with no store is refused and the copy keeps its own", async () => {
		const copy = await fakeCopy("copy-missing-target");
		const target = path.join(root, "nowhere", ".beads");

		const adoption = await adoptRunDatabase(copy, marker(target));

		expect(adoption.kind).toBe("refused");
		expect(adoption.kind === "refused" && adoption.reason).toContain(target);
		expect(await fs.readdir(path.join(copy, ".beads"))).toEqual(["embeddeddolt"]);
	});

	test("a marker from before the field existed is refused with the repair named", async () => {
		const copy = await fakeCopy("copy-old-marker");

		const adoption = await adoptRunDatabase(copy, marker());

		expect(adoption.kind === "refused" && adoption.reason).toContain("/orchestrate-start");
		expect(await fs.readdir(path.join(copy, ".beads"))).toEqual(["embeddeddolt"]);
	});

	test("a tree outside the isolation base is the primary, whatever its marker says", async () => {
		const elsewhere = path.join(root, "elsewhere");
		await fs.mkdir(path.join(elsewhere, ".beads", "embeddeddolt"), { recursive: true });

		expect(await adoptRunDatabase(elsewhere, marker(path.join(root, "other", ".beads")))).toEqual({ kind: "primary" });
		expect(await fs.readdir(path.join(elsewhere, ".beads"))).toEqual(["embeddeddolt"]);
	});

	test("a copy whose marker names its own database is never redirected to itself", async () => {
		// The primary checkout itself may live under the isolation base. Redirecting it to
		// itself and removing its store would destroy the run's database.
		const copy = await fakeCopy("copy-self");

		expect(await adoptRunDatabase(copy, marker(path.join(copy, ".beads")))).toEqual({ kind: "primary" });
		expect(await fs.readdir(path.join(copy, ".beads"))).toEqual(["embeddeddolt"]);
	});

	test("a copy without a store is left alone", async () => {
		const copy = path.join(base, "copy-bare");
		await fs.mkdir(path.join(copy, ".beads"), { recursive: true });

		expect(await adoptRunDatabase(copy, marker(path.join(root, "primary", ".beads")))).toEqual({ kind: "redirected" });
		expect(await fs.readdir(path.join(copy, ".beads"))).toEqual([]);
	});
});
