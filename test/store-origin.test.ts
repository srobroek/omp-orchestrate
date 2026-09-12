/** `storeOrigin`: the run's store and how it was reached, through a stub `bd` on `BD_BIN`. */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inheritedStoreSelector, STORE_SELECTOR_VARS, storeOrigin } from "../src/beads-mode";

let dir: string;
let previousBin: string | undefined;
const previousSelectors = new Map<string, string | undefined>();

/** A stub `bd` that records its argv, because the call is the contract: `where --json` or nothing. */
async function stub(script: string): Promise<void> {
	const bin = path.join(dir, "bd-stub");
	await fs.writeFile(bin, `#!/bin/sh\nARGV_LOG='${path.join(dir, "argv.log")}'\necho "$@" >> "$ARGV_LOG"\n${script}\n`);
	await fs.chmod(bin, 0o755);
	process.env.BD_BIN = bin;
}

async function argv(): Promise<string[]> {
	const log = await fs.readFile(path.join(dir, "argv.log"), "utf8").catch(() => "");
	return log.split("\n").filter(line => line.length > 0);
}

/** A stub answering `bd where --json` with `store`, redirected or not. */
function whereAnswer(store: string, redirectedFrom?: string): string {
	const data: Record<string, string> = { path: store, prefix: "sb" };
	if (redirectedFrom !== undefined) data.redirected_from = redirectedFrom;
	return `echo '${JSON.stringify({ schema_version: 1, data })}'\nexit 0`;
}

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

/** A repository with a `.beads` and one commit, so a linked worktree can be added. */
async function repository(name: string): Promise<string> {
	const root = path.join(dir, name);
	await fs.mkdir(path.join(root, ".beads"), { recursive: true });
	git(root, "init", "-q");
	git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
	return root;
}

beforeEach(async () => {
	dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "orc-store-origin-")));
	previousBin = process.env.BD_BIN;
	for (const name of STORE_SELECTOR_VARS) {
		previousSelectors.set(name, process.env[name]);
		delete process.env[name];
	}
});

afterEach(async () => {
	if (previousBin === undefined) delete process.env.BD_BIN;
	else process.env.BD_BIN = previousBin;
	for (const [name, value] of previousSelectors) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	await fs.rm(dir, { recursive: true, force: true });
});

describe("storeOrigin", () => {
	test("the checkout's own store, canonical, from one bd call", async () => {
		const root = await repository("checkout");
		const alias = path.join(dir, "alias");
		await fs.symlink(root, alias, "dir");
		await stub(whereAnswer(path.join(alias, ".beads")));

		expect(await storeOrigin(root)).toEqual({ ok: true, path: path.join(root, ".beads"), origin: "checkout" });
		expect(await argv()).toEqual(["where --json"]);
	});

	test("a subdirectory of the checkout still reads as the checkout's store", async () => {
		const root = await repository("checkout");
		const sub = path.join(root, "src", "deep");
		await fs.mkdir(sub, { recursive: true });
		await stub(whereAnswer(path.join(root, ".beads")));

		expect(await storeOrigin(sub)).toMatchObject({ ok: true, origin: "checkout" });
	});

	test("a linked worktree resolves the primary's store through the common directory", async () => {
		const root = await repository("checkout");
		const worktree = path.join(dir, "linked");
		git(root, "worktree", "add", "-q", worktree, "-b", "linked");
		await stub(whereAnswer(path.join(root, ".beads")));

		expect(await storeOrigin(worktree)).toEqual({ ok: true, path: path.join(root, ".beads"), origin: "common-dir" });
	});

	test("an isolated copy's redirect is reported as such", async () => {
		const root = await repository("checkout");
		const copy = path.join(dir, "copy");
		await fs.mkdir(path.join(copy, ".beads"), { recursive: true });
		await stub(whereAnswer(path.join(root, ".beads"), path.join(copy, ".beads")));

		expect(await storeOrigin(copy)).toEqual({ ok: true, path: path.join(root, ".beads"), origin: "redirect" });
	});

	test.each([...STORE_SELECTOR_VARS])("a %s selector in the process environment is the origin, and bd is not asked", async name => {
		const root = await repository("checkout");
		const foreign = await repository("foreign");
		process.env[name] = name === "BEADS_DB" ? path.join(foreign, ".beads", "embeddeddolt") : path.join(foreign, ".beads");
		await stub(whereAnswer(path.join(root, ".beads")));

		expect(await storeOrigin(root)).toEqual({ ok: true, path: path.join(foreign, ".beads"), origin: "env" });
		expect(await argv()).toEqual([]);
		expect(inheritedStoreSelector()).toEqual({ name, value: process.env[name] });
	});

	test("a selector naming a missing directory is refused by name", async () => {
		const root = await repository("checkout");
		process.env.BEADS_DIR = path.join(dir, "gone", ".beads");

		const result = await storeOrigin(root);
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.reason).toContain("BEADS_DIR");
		expect(result.ok === false && result.reason).toContain("does not exist");
	});

	test("an explicit store wins over the environment and is reported as explicit", async () => {
		const root = await repository("checkout");
		const foreign = await repository("foreign");
		process.env.BEADS_DIR = path.join(foreign, ".beads");
		await stub(whereAnswer(path.join(foreign, ".beads")));

		expect(await storeOrigin(root, path.join(root, ".beads"))).toEqual({ ok: true, path: path.join(root, ".beads"), origin: "explicit" });
		expect(await argv()).toEqual([]);
	});

	test("an explicit store is resolved against cwd and must exist", async () => {
		const root = await repository("checkout");

		expect(await storeOrigin(root, ".beads")).toEqual({ ok: true, path: path.join(root, ".beads"), origin: "explicit" });
		const missing = await storeOrigin(root, path.join(dir, "nowhere"));
		expect(missing.ok === false && missing.reason).toContain("does not exist");
	});

	test("a project without a beads workspace is refused by name", async () => {
		await stub(`echo "No active beads workspace found" >&2\nexit 1`);

		expect(await storeOrigin(dir)).toEqual({ ok: false, reason: "no active Beads workspace was found" });
	});

	test.each([
		["a relative path", () => `echo '{"path":".beads"}'; exit 0`, "not an absolute path"],
		["a missing directory", () => `echo '{"path":"${path.join(dir, "gone", ".beads")}"}'; exit 0`, "does not exist"],
		["bd's unexpected failure", () => `echo "permission denied" >&2; exit 1`, "permission denied"],
	])("%s is refused rather than recorded", async (_label, script, reason) => {
		await stub(script());

		const result = await storeOrigin(dir);
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.reason).toContain(reason);
	});

	test("a missing bd refuses rather than proceeding unverified", async () => {
		process.env.BD_BIN = path.join(dir, "definitely-not-a-binary");

		const result = await storeOrigin(dir);
		expect(result.ok === false && result.reason).toContain("bd could not be run");
	});
});
