/**
 * Store probe: is the run's embedded Dolt store free, held, corrupted, or slow?
 *
 * Asked at run activation and before the lead's barrier sync, never per dispatch. The
 * answer is about one directory, so the reader names it with `--db` rather than trusting
 * the cwd or the environment; G6 refuses `--db` in agent shells for the opposite reason
 * (an agent must not choose a store), and the plugin's own spawns pass through no gate.
 *
 * Why three instruments. `bd ping` and `bd show` succeed on a CRC-corrupt journal whose
 * bad record is superseded, and `bd doctor` is unsupported in embedded mode, so bd is not
 * its own probe; but a reachable corrupt record fails every open with one signature
 * (`possible data loss detected in journal file ... corrupted journal`, measured by
 * overwriting 256 bytes mid-journal on a sandbox copy; a truncated tail is tolerated and
 * reports nothing). Dolt's only cross-process exclusion is an `flock` on `noms/LOCK`,
 * which a writer takes while it commits, so a non-blocking `flock` names contention
 * before the read spends its timeout on it. macOS ships no `flock(1)`; perl does the
 * call. `lsof` names the holder when one is visible on the host.
 *
 * What the lock probe cannot see: a Dolt engine inside the colima guest holds a Linux
 * `flock` over virtiofs that the host never observes. That is the corruption vector
 * `scratch/audit/research/ResCorruption.md` demonstrated, and it is closed on the other
 * side -- the `bd` router takes the host lock around the container run -- so a `locked`
 * answer with holder `perl`/`bd-container` is that router doing its job.
 *
 * Invariants this probe serves (the plugin never starts, stops, or kills a Dolt server,
 * never deletes `noms/LOCK` or `dolt-server.*`, never edits `dolt_mode`): the probe only
 * opens `LOCK` read-only, takes the flock for one syscall, and runs one read.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { Subprocess } from "bun";
import { bdRun } from "./bd";

/** The probe's answer about a store that exists. */
export type StoreProbe =
	| { state: "free"; lock: string; ms: number }
	| { state: "locked"; lock: string; holder: string }
	| { state: "corrupted"; lock: string; detail: string }
	| { state: "slow"; lock: string; ms: number };

/** A read past this is `slow`: an uncontended embedded `bd count` measures 0.3-0.4 s. */
export const SLOW_READ_MS = 2_000;

/** The read's hard bound; a kill here is reported as `slow` with the time it spent. */
const READ_TIMEOUT_MS = 10_000;

const TOOL_TIMEOUT_MS = 5_000;

/**
 * Exit 0 when the lock was free (taken and released by process exit), 1 when another
 * process holds it, 3 when the file cannot be opened. `LOCK_EX|LOCK_NB` is the exact
 * call Dolt's writer makes, so what it sees is what a writer would see.
 */
const FLOCK_PROBE = 'open(my $fh, "<", $ARGV[0]) or exit 3; exit(flock($fh, LOCK_EX|LOCK_NB) ? 0 : 1)';

/**
 * The signatures every open of a damaged store prints. A journal with a reachable corrupt
 * record logs the CRC mismatch and then `possible data loss detected in journal file ...
 * corrupted journal`; a damaged `journal.idx` beside it fails earlier with `error
 * bootstrapping chunk journal: journal index is malformed` (measured by overwriting bytes
 * at offset 8 of the index on a sandbox copy, bd 1.2.2). The last matching line is quoted:
 * for the journal that is the line naming the file and offset, the one an operator acts on.
 */
const CORRUPTION = /corrupted journal|invalid journal record|data loss detected in journal|journal index is malformed/;

interface Spawned {
	code: number;
	stdout: string;
	stderr: string;
}

/** Run one host tool; `null` when it could not be spawned or outlived its bound. */
async function run(argv: string[], timeoutMs: number): Promise<Spawned | null> {
	let proc: Subprocess<"ignore", "pipe", "pipe">;
	try {
		proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
	} catch {
		return null;
	}
	let killed = false;
	const timer = setTimeout(() => {
		killed = true;
		proc.kill();
	}, timeoutMs);
	try {
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return killed ? null : { code, stdout, stderr };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * The store's `noms/LOCK`, from `metadata.json`: `<beadsDir>/embeddeddolt/<dolt_database>/.dolt/noms/LOCK`.
 *
 * Rejects when `beadsDir` holds no embedded store to probe. That is the caller's
 * directory being wrong, not a state of a store, so it is not one of the four answers.
 */
async function lockPath(beadsDir: string): Promise<string> {
	const metadataPath = path.join(beadsDir, "metadata.json");
	let metadata: Record<string, unknown>;
	try {
		const parsed: unknown = JSON.parse(await fs.readFile(metadataPath, "utf8"));
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
		metadata = parsed as Record<string, unknown>;
	} catch (error) {
		throw new Error(`no beads store at ${beadsDir}: ${metadataPath} unreadable (${error instanceof Error ? error.message : String(error)})`);
	}
	if (metadata.dolt_mode !== "embedded") {
		throw new Error(`store at ${beadsDir} is not embedded (dolt_mode: ${String(metadata.dolt_mode)}); only embedded stores are probed`);
	}
	const database = metadata.dolt_database;
	if (typeof database !== "string" || database.length === 0) {
		throw new Error(`no beads store at ${beadsDir}: ${metadataPath} names no dolt_database`);
	}
	return path.join(beadsDir, "embeddeddolt", database, ".dolt", "noms", "LOCK");
}

/**
 * Whether another process holds the store's writer lock right now.
 *
 * `undefined` when perl could not run: then the read below is the only instrument, and
 * a held lock shows up as `slow` rather than as `locked`.
 */
async function lockHeld(lock: string): Promise<boolean | undefined> {
	const probe = await run(["perl", "-MFcntl=:flock", "-e", FLOCK_PROBE, lock], TOOL_TIMEOUT_MS);
	if (probe === null || probe.code === 3) return undefined;
	return probe.code !== 0;
}

/**
 * Who has `lock` open, as `command[pid]` pairs, or a stated unknown.
 *
 * `lsof -F pc` prints one `p<pid>` line then one `c<command>` line per process. The
 * unknown is spelled out because it has a known cause: a holder inside the container VM
 * has the file open through virtiofs, invisible to the host's `lsof`.
 */
async function holderOf(lock: string): Promise<string> {
	const listed = await run(["lsof", "-F", "pc", "--", lock], TOOL_TIMEOUT_MS);
	if (listed === null) return "unknown (lsof unavailable)";
	const holders: string[] = [];
	let pid: string | undefined;
	for (const line of listed.stdout.split("\n")) {
		if (line.startsWith("p")) pid = line.slice(1);
		else if (line.startsWith("c") && pid !== undefined) holders.push(`${line.slice(1)}[${pid}]`);
	}
	return holders.length > 0 ? holders.join(", ") : "unknown (no host process has it open; a container engine is invisible to lsof)";
}

/**
 * Probe the embedded store under `beadsDir`; a read longer than `slowMs` is `slow`.
 *
 * Order: lock, then read. The lock probe costs one syscall and names contention before
 * the read would spend up to {@link READ_TIMEOUT_MS} waiting behind it. Rejects when
 * `beadsDir` holds no embedded store, or when `bd` itself cannot run: neither is a state
 * of the store, and a caller refusing on the message is the right outcome for both.
 */
export async function probeStore(beadsDir: string, slowMs = SLOW_READ_MS): Promise<StoreProbe> {
	const lock = await lockPath(beadsDir);
	try {
		await fs.stat(lock);
	} catch {
		// Dolt creates LOCK at init and never removes it; a store without one was copied
		// in part or tampered with, and the router fails closed on the same absence.
		return { state: "corrupted", lock, detail: `${lock} is missing` };
	}

	if ((await lockHeld(lock)) === true) {
		return { state: "locked", lock, holder: await holderOf(lock) };
	}

	const started = performance.now();
	const read = await bdRun(["--db", beadsDir, "count", "--json"], READ_TIMEOUT_MS);
	const ms = Math.round(performance.now() - started);
	if (read === null) {
		// A kill at the bound resolves null after the bound; a spawn failure resolves
		// null at once. The elapsed time tells them apart without a second channel.
		if (ms >= slowMs) return { state: "slow", lock, ms };
		throw new Error(`bd could not be run to read the store at ${beadsDir}`);
	}
	if (read.code !== 0) {
		const signature = read.stderr.split("\n").findLast(line => CORRUPTION.test(line));
		if (signature !== undefined) return { state: "corrupted", lock, detail: signature.trim() };
		throw new Error(`bd count exited ${read.code} on the store at ${beadsDir}: ${read.stderr.trim().split("\n")[0] ?? ""}`);
	}
	return ms > slowMs ? { state: "slow", lock, ms } : { state: "free", lock, ms };
}
