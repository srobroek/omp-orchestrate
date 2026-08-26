import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureBeadsServer } from "../src/beads-mode";

/**
 * Every branch is driven through a stub `bd` on `BD_BIN`, the same seam `bdRun` reads.
 *
 * The stub records its argv, because the flags are the contract: `--server` selects the
 * mode this plugin requires, `--skip-hooks` avoids repointing `core.hooksPath` and
 * copying ~349MB of hooks that are broken on arm64, and `--init-if-missing` is what makes
 * calling init on an unreadable database safe rather than a way to create a second one.
 */
let dir: string;
let previousBin: string | undefined;

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
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "orc-beads-"));
	previousBin = process.env.BD_BIN;
});

afterEach(async () => {
	if (previousBin === undefined) delete process.env.BD_BIN;
	else process.env.BD_BIN = previousBin;
	await fs.rm(dir, { recursive: true, force: true });
});

describe("ensureBeadsServer", () => {
	test("a server-mode database passes with nothing to report", async () => {
		await stub(`echo "$@" >> "$ARGV_LOG"
case "$1 $2" in
  "dolt show") echo "  Mode:     per-project"; exit 0 ;;
esac
exit 0`);

		expect(await ensureBeadsServer(dir)).toEqual({ ok: true });
		expect(await argv()).toEqual(["info", "dolt show"]);
	});

	test("an embedded database refuses the run and is not converted", async () => {
		await stub(`echo "$@" >> "$ARGV_LOG"
case "$1 $2" in
  "dolt show") echo "  Mode:     embedded (in-process Dolt engine)"; exit 0 ;;
esac
exit 0`);

		const result = await ensureBeadsServer(dir);
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.reason).toContain("embeddeddolt");
		// The refusal must not attempt a conversion: a measured flag flip leaves bd unable
		// to open the database at all, so only `info` and `dolt show` may be called.
		expect(await argv()).toEqual(["info", "dolt show"]);
	});

	test("an absent database is initialised, and the result is verified not assumed", async () => {
		await stub(`echo "$@" >> "$ARGV_LOG"
case "$1 $2" in
  "dolt show") echo "  Mode:     per-project"; exit 0 ;;
esac
case "$1" in
  info) exit 1 ;;
  init) exit 0 ;;
esac
exit 0`);

		expect(await ensureBeadsServer(dir)).toEqual({
			ok: true,
			note: "initialised beads as a per-project Dolt server",
		});
		const calls = await argv();
		expect(calls[0]).toBe("info");
		expect(calls[1]).toBe("init --init-if-missing --skip-hooks --server --non-interactive");
		// The third call is the point: success is reported from the mode, not the flag.
		expect(calls[2]).toBe("dolt show");
	});

	test("init succeeding while the mode stays embedded refuses and blames the flag", async () => {
		await stub(`echo "$@" >> "$ARGV_LOG"
case "$1 $2" in
  "dolt show") echo "  Mode:     embedded (in-process Dolt engine)"; exit 0 ;;
esac
case "$1" in
  info) exit 1 ;;
  init) exit 0 ;;
esac
exit 0`);

		const result = await ensureBeadsServer(dir);
		expect(result.ok).toBe(false);
		// Names the tooling, not a data migration: there is no data to migrate here.
		expect(result.ok === false && result.reason).toContain("does not honour the flag");
		expect(result.ok === false && result.reason).not.toContain("bd doctor");
	});

	test("a failing init refuses the run and reports bd's first line", async () => {
		await stub(`echo "$@" >> "$ARGV_LOG"
case "$1" in
  info) exit 1 ;;
  init) echo "Error: prefix collides with an existing database" >&2; exit 3 ;;
esac
exit 0`);

		const result = await ensureBeadsServer(dir);
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.reason).toBe(
			"bd init failed: Error: prefix collides with an existing database",
		);
	});

	test("an unreadable mode refuses rather than assuming a server", async () => {
		await stub(`echo "$@" >> "$ARGV_LOG"
case "$1 $2" in
  "dolt show") exit 4 ;;
esac
exit 0`);

		const result = await ensureBeadsServer(dir);
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.reason).toContain("bd dolt show");
	});

	test("a missing bd refuses rather than proceeding unverified", async () => {
		process.env.BD_BIN = path.join(dir, "definitely-not-a-binary");

		const result = await ensureBeadsServer(dir);
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.reason).toContain("bd could not be run");
	});
});
