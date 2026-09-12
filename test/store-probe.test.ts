/** `probeStore`: the four answers, each from the instrument that produces it. */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { probeStore, SLOW_READ_MS } from "../src/store-probe";

/**
 * A store's directory shape without a Dolt engine behind it: `metadata.json` naming the
 * database, and the `noms/LOCK` Dolt would have created. The read goes through a `bd`
 * stand-in on `BD_BIN`, the seam `bdRun` reads, so each answer is driven by what the
 * real one would print. A real `bd` builds a second fixture below.
 */
async function layout(root: string, database = "probe", metadata: Record<string, unknown> = { dolt_mode: "embedded", dolt_database: database }): Promise<{ beadsDir: string; lock: string }> {
	const beadsDir = path.join(root, ".beads");
	const noms = path.join(beadsDir, "embeddeddolt", database, ".dolt", "noms");
	await fs.mkdir(noms, { recursive: true });
	await fs.writeFile(path.join(beadsDir, "metadata.json"), JSON.stringify(metadata));
	const lock = path.join(noms, "LOCK");
	await fs.writeFile(lock, "");
	return { beadsDir, lock };
}

let dir: string;
let previousBin: string | undefined;

/** Install a `bd` stand-in whose body is `script`, run by `sh`. */
async function stubBd(script: string): Promise<string> {
	const bin = path.join(dir, "bd-stub");
	await fs.writeFile(bin, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
	process.env.BD_BIN = bin;
	return bin;
}

beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "orc-probe-"));
	previousBin = process.env.BD_BIN;
});

afterEach(async () => {
	if (previousBin === undefined) delete process.env.BD_BIN;
	else process.env.BD_BIN = previousBin;
	await fs.rm(dir, { recursive: true, force: true });
});

/** What the real `bd` 1.2.2 prints when a journal record it must read fails its CRC. */
const CORRUPT_STDERR = [
	'time="2026-09-12T11:02:50+04:00" level=error msg="invalid journal record at offset 599185: invalid journal record: CRC checksum does not match"',
	"Error: failed to open database: embeddeddolt: init schema: embeddeddolt: open db: possible data loss detected in journal file /store/.beads/embeddeddolt/probe/.dolt/noms/journal.idx at offset 599185: corrupted journal",
	"please run 'dolt fsck' to assess the damage and attempt repairs",
].join("\n");

describe("probeStore on a laid-out store", () => {
	test("free: the lock is nobody's and the read returns within the threshold", async () => {
		const { beadsDir, lock } = await layout(dir);
		await stubBd(`printf '%s\\n' "$@" > "${path.join(dir, "argv")}"; echo '{"count":1}'`);

		const result = await probeStore(beadsDir);

		expect(result.state).toBe("free");
		expect(result.lock).toBe(lock);
		expect(result.state === "free" && result.ms).toBeLessThan(SLOW_READ_MS);
		// The read names the store it was asked about; cwd and environment do not choose.
		expect((await fs.readFile(path.join(dir, "argv"), "utf8")).split("\n")).toEqual(["--db", beadsDir, "count", "--json", ""]);
	});

	test("locked: a process holding the writer flock is named before any read", async () => {
		const { beadsDir, lock } = await layout(dir);
		await stubBd(`echo "read ran" > "${path.join(dir, "read-ran")}"; echo '{"count":1}'`);
		const holder = Bun.spawn(
			["perl", "-MFcntl=:flock", "-e", '$| = 1; open(my $fh, "<", $ARGV[0]) or die; flock($fh, LOCK_EX) or die; print "held\\n"; sleep 30', lock],
			{ stdout: "pipe", stderr: "inherit", stdin: "ignore" },
		);
		try {
			// Wait for the lock to be taken rather than racing the child's startup.
			const reader = holder.stdout.getReader();
			const first = await reader.read();
			expect(new TextDecoder().decode(first.value)).toContain("held");

			const result = await probeStore(beadsDir);

			expect(result.state).toBe("locked");
			if (result.state === "locked") {
				if (Bun.which("lsof") !== null) expect(result.holder).toBe(`perl[${holder.pid}]`);
				else expect(result.holder).toContain("unknown");
			}
			// The lock answered first, so the read that would have queued behind it never ran.
			expect(await fs.exists(path.join(dir, "read-ran"))).toBe(false);
		} finally {
			holder.kill();
			await holder.exited;
		}
	});

	test("corrupted: the reader's journal signature is quoted, the line naming the file", async () => {
		const { beadsDir } = await layout(dir);
		await stubBd(`cat >&2 <<'EOF'\n${CORRUPT_STDERR}\nEOF\nexit 1`);

		const result = await probeStore(beadsDir);

		expect(result.state).toBe("corrupted");
		expect(result.state === "corrupted" && result.detail).toContain("possible data loss detected in journal file");
		expect(result.state === "corrupted" && result.detail).toContain("journal.idx at offset 599185: corrupted journal");
	});

	test("corrupted: a store whose LOCK is gone is refused without running bd", async () => {
		const { beadsDir, lock } = await layout(dir);
		await stubBd(`echo "read ran" > "${path.join(dir, "read-ran")}"; echo '{"count":1}'`);
		await fs.rm(lock);

		const result = await probeStore(beadsDir);

		expect(result).toEqual({ state: "corrupted", lock, detail: `${lock} is missing` });
		expect(await fs.exists(path.join(dir, "read-ran"))).toBe(false);
	});

	test("slow: a read past the threshold is slow, with the time it took", async () => {
		const { beadsDir } = await layout(dir);
		await stubBd(`sleep 0.3; echo '{"count":1}'`);

		const result = await probeStore(beadsDir, 100);

		expect(result.state).toBe("slow");
		expect(result.state === "slow" && result.ms).toBeGreaterThanOrEqual(300);
	});

	test("a non-zero exit without the signature is not a verdict about the store", async () => {
		const { beadsDir } = await layout(dir);
		await stubBd(`echo "Error: database is locked by another dolt process" >&2; exit 1`);

		await expect(probeStore(beadsDir)).rejects.toThrow(/bd count exited 1 .* database is locked by another dolt process/);
	});

	test("an unrunnable bd rejects rather than answering for the store", async () => {
		const { beadsDir } = await layout(dir);
		process.env.BD_BIN = path.join(dir, "no-such-bd");

		await expect(probeStore(beadsDir)).rejects.toThrow(/bd could not be run/);
	});

	test.each([
		["no metadata.json", async () => path.join(dir, ".beads"), /no beads store at .*metadata\.json unreadable/],
		["a server-mode store", async () => (await layout(dir, "probe", { dolt_mode: "server", dolt_database: "probe" })).beadsDir, /not embedded \(dolt_mode: server\)/],
		["metadata naming no database", async () => (await layout(dir, "probe", { dolt_mode: "embedded" })).beadsDir, /names no dolt_database/],
	])("%s is not a store to probe and rejects", async (_label, beadsDir, message) => {
		await stubBd(`echo '{"count":1}'`);
		await expect(probeStore(await beadsDir())).rejects.toThrow(message);
	});
});

/**
 * The same probe against a store the installed `bd` built, so the `--db <beadsDir>`
 * contract and the corruption signature are checked against the real binary rather than
 * against a transcript of it. Skipped where `bd` is not installed (CI).
 */
const BD_AVAILABLE = Bun.which("bd") !== null;
/** Dolt's chunk journal, the file two engines wrote at their own offsets in the incident. */
const JOURNAL = "vvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv";

describe.skipIf(!BD_AVAILABLE)("probeStore on a store bd built", () => {
	/** Holds the store bd builds and the damaged copies of it, side by side. */
	let root: string;
	let beadsDir: string;

	/** `process.env` without bd's own variables, so a pinned session's store never receives the fixture. */
	function fixtureEnv(): Record<string, string> {
		const env: Record<string, string> = { BD_ROUTER_OFF: "1", BD_NON_INTERACTIVE: "1" };
		for (const [key, value] of Object.entries(process.env)) {
			if (value !== undefined && !key.startsWith("BEADS_") && key !== "BD_BIN") env[key] = value;
		}
		return env;
	}

	beforeAll(async () => {
		root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "orc-probe-bd-"));
		const store = path.join(root, "store");
		await fs.mkdir(store);
		const init = Bun.spawn(["bd", "init", "--skip-hooks", "--skip-agents", "--quiet", "-p", "probe"], {
			cwd: store, env: fixtureEnv(), stdout: "pipe", stderr: "pipe", stdin: "ignore",
		});
		const [stderr, code] = await Promise.all([new Response(init.stderr).text(), init.exited]);
		if (code !== 0) throw new Error(`bd init failed (${code}): ${stderr}`);
		beadsDir = path.join(store, ".beads");
	});

	/** A copy of the built store's `.beads` under `name`, with its journal replaced by `journal`. */
	async function copyWithJournal(name: string, journal: Buffer): Promise<string> {
		const copy = path.join(root, name, ".beads");
		await fs.cp(beadsDir, copy, { recursive: true });
		await fs.writeFile(path.join(copy, "embeddeddolt", "probe", ".dolt", "noms", JOURNAL), journal);
		return copy;
	}

	afterAll(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	test("a fresh store is free, read through --db from an unrelated cwd", async () => {
		const result = await probeStore(beadsDir);

		expect(result.state).toBe("free");
		expect(result.lock).toBe(path.join(beadsDir, "embeddeddolt", "probe", ".dolt", "noms", "LOCK"));
	});

	test("a journal with a record overwritten mid-file is corrupted; a truncated tail is not", async () => {
		const bytes = await fs.readFile(path.join(beadsDir, "embeddeddolt", "probe", ".dolt", "noms", JOURNAL));

		// Dolt tolerates a partial final record: the tail is where a writer was cut off.
		const truncated = await copyWithJournal("truncated", bytes.subarray(0, bytes.length - 300));
		expect((await probeStore(truncated)).state).toBe("free");

		// Two engines writing at their own offsets leave a record whose CRC fails with valid
		// data beyond it: the incident's shape, and the one every open refuses.
		const damaged = Buffer.from(bytes);
		damaged.fill(0xff, Math.floor(bytes.length / 2), Math.floor(bytes.length / 2) + 256);
		const overwritten = await copyWithJournal("overwritten", damaged);

		const result = await probeStore(overwritten);

		expect(result.state).toBe("corrupted");
		expect(result.state === "corrupted" && result.detail).toMatch(/corrupted journal|invalid journal record/);
	});
});
