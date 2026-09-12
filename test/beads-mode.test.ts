import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { locateBeadsDir } from "../src/beads-mode";

/**
 * Every branch is driven through a stub `bd` on `BD_BIN`, the same seam `bdRun` reads.
 * The stub records its argv, because the call is the contract: exactly one
 * `bd where --json` and nothing else. Nothing is exported into the environment; the
 * answer goes into the run marker, which is where an isolated copy reads it.
 */
let dir: string;
let previousBin: string | undefined;

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

beforeEach(async () => {
	dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "orc-beads-")));
	previousBin = process.env.BD_BIN;
});

afterEach(async () => {
	if (previousBin === undefined) delete process.env.BD_BIN;
	else process.env.BD_BIN = previousBin;
	await fs.rm(dir, { recursive: true, force: true });
});

describe("locateBeadsDir", () => {
	test("returns bd's own canonical answer from one call", async () => {
		const alias = path.join(dir, "alias");
		await fs.mkdir(path.join(dir, "checkout", ".beads"), { recursive: true });
		await fs.symlink(path.join(dir, "checkout"), alias, "dir");
		await stub(`echo '{"schema_version":1,"data":{"path":"${path.join(alias, ".beads")}","prefix":"sb"}}'
exit 0`);

		expect(await locateBeadsDir(dir)).toEqual({ ok: true, beadsDir: path.join(dir, "checkout", ".beads") });
		expect(await argv()).toEqual(["where --json"]);
	});

	test("a project without a beads workspace is refused by name", async () => {
		await stub(`echo "No active beads workspace found" >&2
exit 1`);

		expect(await locateBeadsDir(dir)).toEqual({ ok: false, reason: "no active Beads workspace was found" });
	});

	test.each([
		["a relative path", `echo '{"path":".beads"}'; exit 0`, "not an absolute path"],
		["a missing directory", `echo '{"path":"${path.join(dir, "gone", ".beads")}"}'; exit 0`, "does not exist"],
		["bd's unexpected failure", `echo "permission denied" >&2; exit 1`, "permission denied"],
	])("%s is refused rather than recorded", async (_label, script, reason) => {
		await stub(script);

		const result = await locateBeadsDir(dir);
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.reason).toContain(reason);
	});

	test("a missing bd refuses rather than proceeding unverified", async () => {
		process.env.BD_BIN = path.join(dir, "definitely-not-a-binary");

		const result = await locateBeadsDir(dir);
		expect(result.ok === false && result.reason).toContain("bd could not be run");
	});
});
