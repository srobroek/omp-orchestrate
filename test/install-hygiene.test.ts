import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { INSTALL_ROOT, isMarketplaceCacheEntry, STRAY_PATHS, sweepInstallTree } from "../src/install-hygiene";

/**
 * A fake `~/.omp/plugins/cache/plugins/` holding one entry for this plugin plus a sibling
 * entry, each laid out the way a local-checkout `marketplace add` leaves them: tracked
 * package files beside the checkout's store, run state and scratch notes.
 */
const ENTRY = "omp-orchestrate___orchestrate___0.3.14";
const SIBLING = "srobroek-omp___build___1.2.3";

async function populate(root: string): Promise<void> {
	await mkdir(join(root, ".beads", "embeddeddolt", "noms"), { recursive: true });
	await writeFile(join(root, ".beads", "embeddeddolt", "noms", "manifest"), "dolt");
	await mkdir(join(root, ".beads", "backups", "2026-09-13"), { recursive: true });
	await writeFile(join(root, ".beads", "interactions.jsonl"), "{}\n");
	await writeFile(join(root, ".beads", "config.yaml"), "issue-prefix: omp-orchestrate\n");
	await mkdir(join(root, ".orchestration"), { recursive: true });
	await writeFile(join(root, ".orchestration", ".active-run"), "{}");
	await mkdir(join(root, "scratch", "audit"), { recursive: true });
	await writeFile(join(root, "scratch", "audit", "probes.md"), "# probes");
	await mkdir(join(root, "src"), { recursive: true });
	await writeFile(join(root, "src", "index.ts"), "export default () => {};");
	await writeFile(join(root, "package.json"), "{}");
}

async function exists(path: string): Promise<boolean> {
	return stat(path).then(() => true, () => false);
}

interface Logged {
	message: string;
	details: unknown;
}

let cache: string;
let logged: Logged[];
const log = { warn: (message: string, details?: Record<string, unknown>) => { logged.push({ message, details }); } };

beforeEach(async () => {
	cache = await mkdtemp(join(tmpdir(), "orc-hygiene-"));
	logged = [];
	await populate(join(cache, ENTRY));
	await populate(join(cache, SIBLING));
});
afterEach(() => rm(cache, { recursive: true, force: true }));

describe("install hygiene", () => {
	test("removes the checkout's store, run state and scratch from the plugin's own cache entry", async () => {
		const root = join(cache, ENTRY);
		const removed = await sweepInstallTree(log, root);

		expect(removed).toEqual([...STRAY_PATHS]);
		for (const stray of STRAY_PATHS) expect(await exists(join(root, stray))).toBe(false);
		// The package's own files, tracked `.beads/config.yaml` included, stay.
		expect(await exists(join(root, ".beads", "config.yaml"))).toBe(true);
		expect(await exists(join(root, "src", "index.ts"))).toBe(true);
		expect(await exists(join(root, "package.json"))).toBe(true);
	});

	test("touches nothing outside its own install root", async () => {
		await sweepInstallTree(log, join(cache, ENTRY));
		for (const stray of STRAY_PATHS) expect(await exists(join(cache, SIBLING, stray))).toBe(true);
	});

	test("logs one line naming what it removed, and stays silent on a clean tree", async () => {
		const root = join(cache, ENTRY);
		await sweepInstallTree(log, root);
		expect(logged).toHaveLength(1);
		expect(logged[0]?.details).toEqual({ installRoot: root, removed: [...STRAY_PATHS] });

		const again = await sweepInstallTree(log, root);
		expect(again).toEqual([]);
		expect(logged).toHaveLength(1);
	});

	test("leaves a linked development checkout alone: its store and run marker are real", async () => {
		const checkout = join(cache, "omp-orchestrate");
		await populate(checkout);
		expect(await sweepInstallTree(log, checkout)).toEqual([]);
		for (const stray of STRAY_PATHS) expect(await exists(join(checkout, stray))).toBe(true);
		expect(logged).toEqual([]);
	});

	test("recognises the cache layout and only that", () => {
		expect(isMarketplaceCacheEntry("/x/omp-orchestrate___orchestrate___0.3.14")).toBe(true);
		expect(isMarketplaceCacheEntry("/x/srobroek-omp___build___1.2.3-rc.1+build")).toBe(true);
		expect(isMarketplaceCacheEntry("/x/omp-orchestrate")).toBe(false);
		expect(isMarketplaceCacheEntry("/x/fix-plugin-cache-hygiene")).toBe(false);
		// This test suite runs from a checkout or worktree, never from a cache entry: the
		// default sweep at activation is a no-op here and in every developer's linked tree.
		expect(isMarketplaceCacheEntry(INSTALL_ROOT)).toBe(false);
	});
});
