import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { execFile } from "node:child_process";
import fs, { mkdtemp, readFile, readdir, rm, writeFile, mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { BdBead, BdComment, BdResult } from "../src/bd";
import * as bd from "../src/bd";
import * as landing from "../src/landing";
import type { LandingRecord } from "../src/landing";
import * as storeProbe from "../src/store-probe";
import type { StoreProbe } from "../src/store-probe";
import {
	type AnswerDeps,
	answerBead,
	bindRun,
	closeRun,
	isBoundRunActive,
	markerPath,
	readActiveRun,
	readActiveRunStrict,
	registerRunCommands,
	resumeRun,
	runStatusReport,
	startRun,
	stopRun,
} from "../src/run-state";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const execFileAsync = promisify(execFile);

/**
 * What Beads answers. `bd show <id>` returns `epics[id]`, `null` when unknown; `bd list`
 * returns `store`, `null` for an unreadable one; `bd comments <id>` returns
 * `comments[id]`, `null` when `commentsUnreadable`. Spied once for the file, so a test
 * that restores would not strip the default from the tests after it.
 */
let epics: Record<string, BdBead | null> = {};
let store: BdBead[] | null = [];
let comments: Record<string, BdComment[]> = {};
let commentsUnreadable = false;
let listArgs: string[][] = [];
const showSpy = spyOn(bd, "bdShow").mockImplementation(async id => epics[id] ?? null);
const listSpy = spyOn(bd, "bdListChecked").mockImplementation(async args => {
	listArgs.push(args);
	return store;
});
const commentsSpy = spyOn(bd, "bdCommentsChecked").mockImplementation(async id => (commentsUnreadable ? null : comments[id] ?? []));
/**
 * Every write the module ran, by argv. `failWrites` makes a subcommand fail with that
 * stderr; `bd where` answers this checkout's `.beads`, or a missing workspace when
 * `noWorkspace`. Nothing here reaches a real `bd`.
 */
let writes: string[][] = [];
let failWrites: Record<string, string> = {};
let noWorkspace = false;
let createdEpic = "orc-new";
const runSpy = spyOn(bd, "bdRun").mockImplementation(async (args): Promise<BdResult | null> => {
	if (args[0] === "where") {
		return noWorkspace
			? { code: 1, stdout: "", stderr: "No active beads workspace found\n" }
			: { code: 0, stdout: JSON.stringify({ schema_version: 1, data: { path: join(cwd, ".beads") } }), stderr: "" };
	}
	writes.push(args);
	const failure = failWrites[args[0]!];
	if (failure !== undefined) return { code: 1, stdout: "", stderr: failure };
	if (args[0] === "create") return { code: 0, stdout: JSON.stringify({ schema_version: 1, data: { id: createdEpic } }), stderr: "" };
	return { code: 0, stdout: "", stderr: "" };
});
/** What the start path hears from the landing probe; a stub, so no test reaches `gh`. */
let landingRecord: LandingRecord = { ok: false, error: "not probed in this test" };
const landingCalls: string[] = [];
const landingSpy = spyOn(landing, "recordLandingCapabilities").mockImplementation(async (_cwd, runId) => {
	landingCalls.push(runId);
	return landingRecord;
});
/** The store probe's answer, or the error it throws. */
let probe: StoreProbe | Error = { state: "free", lock: "LOCK", ms: 300 };
const probeCalls: string[] = [];
const probeSpy = spyOn(storeProbe, "probeStore").mockImplementation(async beadsDir => {
	probeCalls.push(beadsDir);
	if (probe instanceof Error) throw probe;
	return probe;
});
afterAll(() => {
	showSpy.mockRestore();
	listSpy.mockRestore();
	commentsSpy.mockRestore();
	runSpy.mockRestore();
	landingSpy.mockRestore();
	probeSpy.mockRestore();
});

let cwd: string;
const SESSION = "session-t";
const LEAD = `lead:${SESSION}`;

/** A run epic Beads shows with `status`. */
function epic(id: string, status = "open", extra: Partial<BdBead> = {}): void {
	epics[id] = { id, status, ...extra };
}

/** A lease still live at any `now` a test uses, or long lapsed. */
const LIVE = { lease_until: "2999-01-01T00:00:00.000Z" };
const LAPSED_AT = "2020-01-01T00:00:00Z";

beforeEach(async () => {
	cwd = await realpath(await mkdtemp(join(tmpdir(), "orc-run-state-")));
	await mkdir(join(cwd, ".beads"));
	delete process.env.ORCHESTRATE_MARKER_FILE;
	// Every id a test binds below is an open epic unless the test says otherwise.
	epics = {};
	for (const id of ["orc-1", "orc-2", "orc-7", "orc-42", "orc-a", "orc-b", "orc-legacy", "orc-new", "orc-other", "orc.run_1:2-3"]) epic(id);
	store = [];
	comments = {};
	commentsUnreadable = false;
	listArgs = [];
	writes = [];
	failWrites = {};
	noWorkspace = false;
	createdEpic = "orc-new";
	landingRecord = { ok: false, error: "not probed in this test" };
	landingCalls.length = 0;
	probe = { state: "free", lock: "LOCK", ms: 300 };
	probeCalls.length = 0;
	showSpy.mockClear();
	commentsSpy.mockClear();
});

afterEach(async () => {
	delete process.env.ORCHESTRATE_MARKER_FILE;
	await rm(cwd, { recursive: true, force: true });
});

/** Write a marker body directly, bypassing the module, to fake prior state. */
async function seed(body: string): Promise<void> {
	await mkdir(join(cwd, ".orchestration"), { recursive: true });
	await writeFile(markerPath(cwd), body, "utf8");
}

/** A marker as `/orchestrate-start` leaves it for this session, bound to `run`. */
function bound(run: string, session = SESSION): string {
	return JSON.stringify({ schema_version: 1, run_id: run, session_id: session, beads_dir: join(cwd, ".beads") });
}

/** The lease writes among `writes`, trimmed to their fenced prefix. */
function fenced(): string[][] {
	return writes.filter(argv => argv[0] === "update" && argv.includes("--claim")).map(argv => argv.slice(1, 5));
}

describe("markerPath", () => {
	test("defaults to the repository's .orchestration marker", () => {
		expect(markerPath(cwd)).toBe(join(cwd, ".orchestration", ".active-run"));
	});

	test("ORCHESTRATE_MARKER_FILE wins, resolved against cwd", () => {
		process.env.ORCHESTRATE_MARKER_FILE = "custom-marker";
		expect(markerPath(cwd)).toBe(join(cwd, "custom-marker"));
		process.env.ORCHESTRATE_MARKER_FILE = "/tmp/absolute-marker";
		expect(markerPath(cwd)).toBe("/tmp/absolute-marker");
	});

	test("an empty override reads as unset", () => {
		// Blank-but-exported must not point the marker at the repository root.
		process.env.ORCHESTRATE_MARKER_FILE = "";
		expect(markerPath(cwd)).toBe(join(cwd, ".orchestration", ".active-run"));
	});
});

describe("readActiveRun", () => {
	test("returns null with no marker", async () => {
		expect(await readActiveRun(cwd)).toBeNull();
	});

	test("returns null for an empty marker", async () => {
		await seed("  \n");
		expect(await readActiveRun(cwd)).toBeNull();
	});

	test("reads a legacy raw-string marker as the run id", async () => {
		await seed("orc-legacy\n");
		expect(await readActiveRun(cwd)).toEqual({ schema_version: 1, run_id: "orc-legacy" });
	});

	test("reads a JSON-quoted run id as the run id", async () => {
		await seed('"orc-quoted"');
		expect(await readActiveRun(cwd)).toEqual({ schema_version: 1, run_id: "orc-quoted" });
	});

	test("returns null for a marker that is not an object or string", async () => {
		await seed("[1, 2]");
		expect(await readActiveRun(cwd)).toBeNull();
		await seed("17");
		expect(await readActiveRun(cwd)).toBeNull();
	});

	test("normalises a marker missing its run id to pending", async () => {
		await seed('{"schema_version": 1}');
		expect(await readActiveRun(cwd)).toEqual({ schema_version: 1, run_id: "pending" });
	});

	test("ignores a non-string session id and a relative database", async () => {
		await seed('{"run_id": "orc-9", "session_id": 5, "beads_dir": "relative/.beads"}');
		expect(await readActiveRun(cwd)).toEqual({ schema_version: 1, run_id: "orc-9" });
	});

	test("a marker from before the pin was retired still reads, without its dead field", async () => {
		await seed(`{"repo_root":${JSON.stringify(resolve(cwd))},"run_id":"orc-9","schema_version":1}\n`);
		expect(await readActiveRun(cwd)).toEqual({ schema_version: 1, run_id: "orc-9" });
	});
});

describe("readActiveRunStrict", () => {
	test("absent is null; a bound marker reads back whole", async () => {
		expect(await readActiveRunStrict(cwd)).toBeNull();
		await seed(bound("orc-7"));
		expect(await readActiveRunStrict(cwd)).toEqual({ schema_version: 1, run_id: "orc-7", session_id: SESSION, beads_dir: join(cwd, ".beads") });
	});

	test("a legacy marker reads: a bare id, a quoted id, or JSON without schema_version", async () => {
		await seed("orc-legacy\n");
		expect(await readActiveRunStrict(cwd)).toEqual({ schema_version: 1, run_id: "orc-legacy" });
		await seed('"orc-legacy"');
		expect(await readActiveRunStrict(cwd)).toEqual({ schema_version: 1, run_id: "orc-legacy" });
		await seed('{"run_id":"orc-legacy"}');
		expect(await readActiveRunStrict(cwd)).toEqual({ schema_version: 1, run_id: "orc-legacy" });
	});

	test("a marker a newer plugin wrote is refused by its schema, not as malformed", async () => {
		await seed('{"schema_version":2,"run_id":"orc-7","lease_epoch":4}');
		await expect(readActiveRunStrict(cwd)).rejects.toThrow(/schema 2 is newer than this plugin's 1; upgrade the plugin/);
	});

	test.each([
		["broken JSON", "{broken"],
		["a list", "[]"],
		["a non-integer schema", '{"schema_version":"1","run_id":"orc-7"}'],
		["schema zero", '{"schema_version":0,"run_id":"orc-7"}'],
		["a non-identifier run id", '{"schema_version":1,"run_id":"has space"}'],
		["a blank session", '{"schema_version":1,"run_id":"orc-7","session_id":""}'],
		["a relative database", '{"schema_version":1,"run_id":"orc-7","beads_dir":"rel/.beads"}'],
	])("%s is malformed", async (_label, body) => {
		await seed(body);
		await expect(readActiveRunStrict(cwd)).rejects.toThrow(/malformed/);
	});

	test("an unreadable marker is an error, not absence", async () => {
		await seed(bound("orc-7"));
		const denied = Object.assign(new Error("permission denied"), { code: "EACCES" });
		const read = spyOn(fs, "readFile").mockRejectedValue(denied);
		try {
			await expect(readActiveRunStrict(cwd)).rejects.toThrow("permission denied");
		} finally {
			read.mockRestore();
		}
	});
});

describe("isBoundRunActive", () => {
	test("does not query Beads for an absent or pending marker", async () => {
		expect(await isBoundRunActive(cwd)).toBe(false);
		await seed('{"schema_version": 1, "run_id": "pending"}');
		expect(await isBoundRunActive(cwd)).toBe(false);
		expect(showSpy).not.toHaveBeenCalled();
	});

	test("requires a known run status and passes the repository cwd", async () => {
		await seed('{"schema_version": 1, "run_id": "orc-7"}');
		for (const status of ["open", "in_progress", "blocked", "deferred"]) {
			epic("orc-7", status);
			expect(await isBoundRunActive(cwd)).toBe(true);
		}
		expect(showSpy.mock.calls.some(call => call[0] === "orc-7" && call[2] === cwd)).toBe(true);
		epic("orc-7", "closed");
		expect(await isBoundRunActive(cwd)).toBe(false);
	});

	test.each([
		[null, "status could not be verified"],
		[{ id: "orc-7" }, "status could not be verified"],
		[{ id: "orc-7", status: "paused" }, "unknown status"],
	])("throws when run evidence is unavailable or unknown: %j", async (run, reason) => {
		await seed('{"schema_version": 1, "run_id": "orc-7"}');
		epics["orc-7"] = run;
		await expect(isBoundRunActive(cwd)).rejects.toThrow(reason);
	});
});

describe("bindRun", () => {
	test("a fresh checkout gets a bound marker naming the session and the database", async () => {
		expect(await bindRun(cwd, "orc-7", SESSION, join(cwd, ".beads"))).toEqual({ lease: "written" });
		expect(JSON.parse(await readFile(markerPath(cwd), "utf8"))).toEqual({
			beads_dir: join(cwd, ".beads"), run_id: "orc-7", schema_version: 1, session_id: SESSION,
		});
		expect((await readdir(join(cwd, ".orchestration"))).filter(name => name.endsWith(".tmp") || name.endsWith(".lock"))).toEqual([]);
	});

	test("rebinding the same id keeps what the marker recorded unless told otherwise", async () => {
		await bindRun(cwd, "orc-1", SESSION, join(cwd, ".beads"));
		await bindRun(cwd, "orc-1");
		expect(await readActiveRun(cwd)).toEqual({ schema_version: 1, run_id: "orc-1", session_id: SESSION, beads_dir: join(cwd, ".beads") });
		await bindRun(cwd, "orc-1", "session-b");
		expect((await readActiveRun(cwd))?.session_id).toBe("session-b");
	});

	test("refuses a different id once bound, and leaves the marker as it was", async () => {
		await bindRun(cwd, "orc-1", SESSION);
		await expect(bindRun(cwd, "orc-2")).rejects.toThrow(/already bound to orc-1/);
		expect((await readActiveRun(cwd))?.run_id).toBe("orc-1");
	});

	test("binds over a pending marker an older release left, and over a legacy marker naming the same run", async () => {
		await seed('{"schema_version":1,"run_id":"pending","session_id":"session-a"}');
		await bindRun(cwd, "orc-7");
		expect(await readActiveRun(cwd)).toEqual({ schema_version: 1, run_id: "orc-7", session_id: "session-a" });
		await seed("orc-legacy\n");
		await bindRun(cwd, "orc-legacy");
		expect(JSON.parse(await readFile(markerPath(cwd), "utf8"))).toEqual({ run_id: "orc-legacy", schema_version: 1 });
		await seed("orc-legacy\n");
		await expect(bindRun(cwd, "orc-new")).rejects.toThrow(/already bound to orc-legacy/);
	});

	test("rejects ids that are not Beads identifiers, accepts the punctuation Beads uses", async () => {
		for (const bad of ["", "-leading", "has space", "has/slash", "quote'", "semi;colon"]) {
			await expect(bindRun(cwd, bad)).rejects.toThrow(/Beads identifier/);
		}
		expect(await readActiveRun(cwd)).toBeNull();
		await bindRun(cwd, "orc.run_1:2-3");
		expect((await readActiveRun(cwd))?.run_id).toBe("orc.run_1:2-3");
	});

	test.each([
		["an epic Beads does not know", null, /could not be read from Beads; binding refused/],
		["a closed epic", { id: "orc-typo", status: "closed" }, /status "closed", which cannot host a run/],
		["an epic in a status supervision does not recognise", { id: "orc-typo", status: "paused" }, /status "paused", which cannot host a run/],
	])("refuses %s and writes nothing", async (_label, shown, reason) => {
		// A typo accepted here disarmed supervision for the whole run: every child exit
		// hit "run liveness unavailable" and the reaper skipped, while the operator was
		// told the run was bound.
		epics["orc-typo"] = shown;
		await expect(bindRun(cwd, "orc-typo")).rejects.toThrow(reason);
		expect(await readActiveRun(cwd)).toBeNull();
		expect(writes).toEqual([]);
	});

	test("reads the epic before touching the marker, in the repository cwd", async () => {
		await bindRun(cwd, "orc-7");
		expect(showSpy.mock.calls.some(call => call[0] === "orc-7" && call[2] === cwd)).toBe(true);
	});

	test("stamps the binding session's lead lease on the epic", async () => {
		expect(await bindRun(cwd, "orc-7", SESSION)).toEqual({ lease: "written" });
		expect(fenced()).toEqual([["orc-7", "--actor", LEAD, "--claim"]]);
		expect(writes[0]?.[6]).toMatch(/^lease_until=\d{4}-\d{2}-\d{2}T/);
	});

	test("refuses to take another lead's live lease, binds anyway, and says so", async () => {
		epic("orc-7", "in_progress", { assignee: "lead:other", updated_at: new Date().toISOString(), metadata: { lease_until: new Date(Date.now() + 600_000).toISOString() } });
		const result = await bindRun(cwd, "orc-7", SESSION);
		expect(result.lease).toMatchObject({ failed: expect.stringContaining("leased to lead:other") });
		expect((await readActiveRun(cwd))?.run_id).toBe("orc-7");
		expect(writes).toEqual([]);
	});

	test("takes another lead's lapsed lease: binding is the explicit act", async () => {
		epic("orc-7", "in_progress", { assignee: "lead:old", updated_at: LAPSED_AT, metadata: { lease_until: LAPSED_AT } });
		expect(await bindRun(cwd, "orc-7", SESSION)).toEqual({ lease: "written" });
		expect(fenced()).toEqual([["orc-7", "--actor", "lead:old", "--claim"], ["orc-7", "--actor", LEAD, "--claim"]]);
	});

	test("a refused lease write binds, is returned, and is not emitted as a process warning", async () => {
		failWrites.update = "store locked";
		const warnings: string[] = [];
		const onWarning = (warning: Error) => warnings.push(warning.message);
		process.on("warning", onWarning);
		try {
			expect(await bindRun(cwd, "orc-7")).toEqual({ lease: { failed: "store locked" } });
			expect((await readActiveRun(cwd))?.run_id).toBe("orc-7");
			await new Promise(resolveNext => setImmediate(resolveNext));
			expect(warnings).toEqual([]);
		} finally {
			process.off("warning", onWarning);
		}
	});

	test("overlapping different binders cannot both acquire a fresh checkout", async () => {
		const results = await Promise.allSettled([bindRun(cwd, "orc-a"), bindRun(cwd, "orc-b")]);
		expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
		const winner = results[0]?.status === "fulfilled" ? "orc-a" : "orc-b";
		expect((await readActiveRun(cwd))?.run_id).toBe(winner);
		const refusal = results.find(result => result.status === "rejected");
		expect(refusal?.status === "rejected" && String(refusal.reason)).toContain("already bound");
	});

	test("an existing cross-process lock is not stolen or deleted", async () => {
		await mkdir(join(cwd, ".orchestration"), { recursive: true });
		const lock = `${markerPath(cwd)}.lock`;
		await writeFile(lock, "other writer");
		await expect(bindRun(cwd, "orc-a")).rejects.toThrow(/locked/);
		expect(await readFile(lock, "utf8")).toBe("other writer");
		expect(await readActiveRun(cwd)).toBeNull();
	});
});

describe("closeRun", () => {
	test("removes the marker and its lock once the marker names the run", async () => {
		await bindRun(cwd, "orc-7", SESSION);
		await closeRun(cwd, "orc-7");
		expect(await readActiveRun(cwd)).toBeNull();
		expect(await readdir(join(cwd, ".orchestration"))).toEqual([]);
		expect(listArgs).toEqual([["list", "--status", "all", "--exclude-type", "event", "--limit", "0", "--json"]]);
	});

	test("refuses an id the marker does not name", async () => {
		await bindRun(cwd, "orc-7");
		await expect(closeRun(cwd, "orc-2")).rejects.toThrow(/bound to orc-7, not orc-2/);
		expect((await readActiveRun(cwd))?.run_id).toBe("orc-7");
		expect(listArgs).toEqual([]);
	});

	test("finds in_progress tasks below features, through a closed feature, and ignores other runs", async () => {
		// `bd list --parent` is direct-only (bd 1.2.2), and claims live on tasks two levels
		// down while their feature stays open; a close that read direct children only would
		// strip supervision from every worker still holding one.
		await bindRun(cwd, "orc-7");
		store = [
			{ id: "orc-7.1", status: "open", parent: "orc-7" },
			{ id: "orc-7.1.1", status: "in_progress", parent: "orc-7.1" },
			{ id: "orc-7.2", status: "closed", parent: "orc-7" },
			{ id: "orc-7.2.1", status: "in_progress", parent: "orc-7.2" },
			{ id: "orc-7.3", status: "open", parent: "orc-7" },
			{ id: "orc-7.3.1", status: "closed", parent: "orc-7.3" },
			{ id: "orc-9", status: "in_progress" },
			{ id: "orc-9.1", status: "in_progress", parent: "orc-9" },
		];
		await expect(closeRun(cwd, "orc-7")).rejects.toThrow(/2 beads under orc-7 still in_progress \(orc-7\.1\.1, orc-7\.2\.1\); pass --force/);
		expect((await readActiveRun(cwd))?.run_id).toBe("orc-7");
		store = [{ id: "orc-9", status: "in_progress" }, { id: "orc-9.1", status: "in_progress", parent: "orc-9" }];
		await closeRun(cwd, "orc-7");
		expect(await readActiveRun(cwd)).toBeNull();
	});

	test("refuses when the children cannot be read, unless forced; force skips the read entirely", async () => {
		await bindRun(cwd, "orc-7");
		store = null;
		await expect(closeRun(cwd, "orc-7")).rejects.toThrow(/could not be read; pass --force/);
		expect((await readActiveRun(cwd))?.run_id).toBe("orc-7");
		listArgs = [];
		await closeRun(cwd, "orc-7", { force: true });
		expect(await readActiveRun(cwd)).toBeNull();
		expect(listArgs).toEqual([]);
	});

	test("a pending marker closes under its sentinel without a children read", async () => {
		await seed('{"schema_version":1,"run_id":"pending"}');
		await expect(closeRun(cwd, "orc-7")).rejects.toThrow(/pending, not bound to orc-7/);
		await closeRun(cwd, "pending");
		expect(await readActiveRun(cwd)).toBeNull();
		expect(listArgs).toEqual([]);
	});

	test("refuses with no marker, a malformed marker, or a held lock", async () => {
		await expect(closeRun(cwd, "orc-7")).rejects.toThrow(/no active-run marker/);
		await seed("{broken");
		await expect(closeRun(cwd, "orc-7")).rejects.toThrow(/malformed/);
		expect(await readFile(markerPath(cwd), "utf8")).toBe("{broken");
		await seed('{"schema_version":1,"run_id":"orc-7"}');
		await writeFile(`${markerPath(cwd)}.lock`, "other writer");
		await expect(closeRun(cwd, "orc-7")).rejects.toThrow(/locked/);
		expect((await readActiveRun(cwd))?.run_id).toBe("orc-7");
	});
});

describe("startRun", () => {
	test("binds an existing epic: probes the store, writes the marker with the database, leases, stamps, probes landing", async () => {
		landingRecord = { ok: true, level: "info", notice: "landing mode direct for o/r (main)", caps: {} as never };
		const started = await startRun(cwd, SESSION, { epic: "orc-7" });
		expect(started).toMatchObject({ run: "orc-7", created: false, lease: "written", stamp: "written", probe: { state: "free" } });
		expect(probeCalls).toEqual([join(cwd, ".beads")]);
		expect(await readActiveRun(cwd)).toEqual({ schema_version: 1, run_id: "orc-7", session_id: SESSION, beads_dir: join(cwd, ".beads") });
		expect(fenced()).toEqual([["orc-7", "--actor", LEAD, "--claim"]]);
		// An adopted epic keeps the operator's metadata; only the schema is stamped.
		expect(writes.find(argv => argv[0] === "update" && !argv.includes("--claim"))).toEqual(["update", "orc-7", "--metadata", '{"schema":1}']);
		expect(landingCalls).toEqual(["orc-7"]);
	});

	test("--new creates the epic from the checkout, then stamps its handle and artifacts directory", async () => {
		await execFileAsync("git", ["init", "-q", "-b", "trunk", cwd]);
		await execFileAsync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "base"]);
		const head = (await execFileAsync("git", ["-C", cwd, "rev-parse", "HEAD"])).stdout.trim();
		createdEpic = "orc-made";
		epic("orc-made");
		const started = await startRun(cwd, SESSION, { title: "Wave 3" });
		expect(started).toMatchObject({ run: "orc-made", created: true, lease: "written", stamp: "written" });
		const create = writes.find(argv => argv[0] === "create")!;
		expect(create.slice(0, 6)).toEqual(["create", "Wave 3", "--type", "epic", "--actor", LEAD]);
		expect(JSON.parse(create[7]!)).toEqual({ origin_actor: LEAD, primary_branch: "trunk", base_sha: head });
		const stamp = writes.find(argv => argv[0] === "update" && !argv.includes("--claim"))!;
		expect(JSON.parse(stamp[3]!)).toEqual({ schema: 1, run_id: "orc-made", artifacts: join(cwd, ".orchestration", "orc-made", "artifacts") });
		expect((await fs.stat(join(cwd, ".orchestration", "orc-made", "artifacts"))).isDirectory()).toBe(true);
		expect((await readActiveRun(cwd))?.run_id).toBe("orc-made");
	});

	test("--new outside a git checkout still creates the epic, without branch or head", async () => {
		await startRun(cwd, SESSION, { title: "no git here" });
		const create = writes.find(argv => argv[0] === "create")!;
		expect(JSON.parse(create[7]!)).toEqual({ origin_actor: LEAD });
	});

	test("the session's own run restarts idempotently: same id, or no id", async () => {
		await startRun(cwd, SESSION, { epic: "orc-7" });
		writes = [];
		expect((await startRun(cwd, SESSION, { epic: "orc-7" })).run).toBe("orc-7");
		expect((await startRun(cwd, SESSION, undefined)).run).toBe("orc-7");
		expect(fenced()).toHaveLength(2);
		expect(writes.filter(argv => argv[0] === "create")).toEqual([]);
	});

	test("refuses a run another session started, naming that session and the two ways out", async () => {
		await seed(bound("orc-7", "session-other"));
		await expect(startRun(cwd, SESSION, { epic: "orc-7" })).rejects.toThrow(/already active in this checkout: orc-7, started by session session-other; \/orchestrate-resume adopts it once its lead lease lapses, \/orchestrate-stop ends it/);
		await seed('{"schema_version":1,"run_id":"orc-7"}');
		await expect(startRun(cwd, SESSION, undefined)).rejects.toThrow(/started by an earlier session/);
		expect(writes).toEqual([]);
		expect(probeCalls).toEqual([]);
	});

	test("refuses a second epic for the session's own run, whether named or new", async () => {
		await seed(bound("orc-7"));
		await expect(startRun(cwd, SESSION, { epic: "orc-2" })).rejects.toThrow(/already bound to orc-7, not orc-2/);
		await expect(startRun(cwd, SESSION, { title: "another" })).rejects.toThrow(/already active in this checkout: orc-7; \/orchestrate-stop ends it before a new epic is created/);
		expect(writes).toEqual([]);
	});

	test("with no marker and no target there is nothing to start", async () => {
		await expect(startRun(cwd, SESSION, undefined)).rejects.toThrow(/no run to restart/);
	});

	test("refuses a checkout without a Beads workspace before creating anything", async () => {
		noWorkspace = true;
		await expect(startRun(cwd, SESSION, { title: "x" })).rejects.toThrow(/run not started: no active Beads workspace was found/);
		expect(writes).toEqual([]);
		expect(await readActiveRun(cwd)).toBeNull();
	});

	test.each([
		["locked", { state: "locked", lock: "LOCK", holder: "bd[123]" } satisfies StoreProbe, /is locked by bd\[123\]; stop that writer first/],
		["corrupted", { state: "corrupted", lock: "LOCK", detail: "corrupted journal at 4096" } satisfies StoreProbe, /is corrupted \(corrupted journal at 4096\); recover it first/],
	])("a %s store refuses the start with nothing written", async (_state, answer, reason) => {
		probe = answer;
		await expect(startRun(cwd, SESSION, { epic: "orc-7" })).rejects.toThrow(reason);
		expect(writes).toEqual([]);
		expect(await readActiveRun(cwd)).toBeNull();
	});

	test("a slow store starts and is reported; a probe that throws refuses", async () => {
		probe = { state: "slow", lock: "LOCK", ms: 4200 };
		expect((await startRun(cwd, SESSION, { epic: "orc-7" })).probe).toEqual({ state: "slow", lock: "LOCK", ms: 4200 });
		await closeRun(cwd, "orc-7", { force: true });
		probe = new Error("bd could not be run to read the store");
		await expect(startRun(cwd, SESSION, { epic: "orc-7" })).rejects.toThrow(/could not be probed: bd could not be run/);
		expect(await readActiveRun(cwd)).toBeNull();
	});

	test("an epic created but not bound is named, with the retry", async () => {
		createdEpic = "orc-typo";
		epics["orc-typo"] = null;
		await expect(startRun(cwd, SESSION, { title: "x" })).rejects.toThrow(/run epic orc-typo was created but the run did not start: run epic orc-typo could not be read from Beads; binding refused; \/orchestrate-start orc-typo retries/);
	});

	test("failures after the marker exists are reported, not thrown", async () => {
		failWrites.update = "store locked";
		landingRecord = { ok: false, error: "gh repo view failed" };
		const started = await startRun(cwd, SESSION, { epic: "orc-7" });
		expect(started.lease).toEqual({ failed: "store locked" });
		expect(started.stamp).toEqual({ failed: "store locked" });
		expect(started.landing).toEqual({ ok: false, error: "gh repo view failed" });
		expect((await readActiveRun(cwd))?.run_id).toBe("orc-7");
	});
});

describe("resumeRun", () => {
	const NOW = Date.parse("2026-01-01T12:00:00Z");

	test("nothing to resume: no marker, or a pending one", async () => {
		expect(await resumeRun(cwd, SESSION, NOW)).toMatchObject({ kind: "no-run", reason: expect.stringContaining("/orchestrate-start starts one") });
		await seed('{"schema_version":1,"run_id":"pending"}');
		expect(await resumeRun(cwd, SESSION, NOW)).toMatchObject({ kind: "no-run", reason: expect.stringContaining("pending") });
		expect(writes).toEqual([]);
	});

	test("a marker a newer plugin wrote is refused, unread and untouched", async () => {
		await seed('{"schema_version":2,"run_id":"orc-7"}');
		expect(await resumeRun(cwd, SESSION, NOW)).toEqual({ kind: "refused", reason: "Active-run marker schema 2 is newer than this plugin's 1; upgrade the plugin before resuming" });
		expect(await readFile(markerPath(cwd), "utf8")).toBe('{"schema_version":2,"run_id":"orc-7"}');
		expect(writes).toEqual([]);
	});

	test("adopts a lapsed lead lease, records this session on the marker, sweeps lapsed claims", async () => {
		await seed(bound("orc-7", "session-old"));
		epic("orc-7", "in_progress", { assignee: "lead:session-old", updated_at: LAPSED_AT, metadata: { lease_until: LAPSED_AT } });
		store = [
			{ id: "orc-7.1", status: "open", parent: "orc-7" },
			{ id: "orc-7.1.1", status: "in_progress", parent: "orc-7.1" },
			{ id: "orc-7.1.2", status: "in_progress", parent: "orc-7.1" },
			{ id: "orc-7.1.3", status: "in_progress", parent: "orc-7.1" },
		];
		epic("orc-7.1.1", "in_progress", { assignee: "impl-dead", updated_at: LAPSED_AT, metadata: { lease_until: LAPSED_AT } });
		epic("orc-7.1.2", "in_progress", { assignee: "impl-live", updated_at: LAPSED_AT, metadata: LIVE });
		// Listed as in flight, but a fresh read shows the lease renewed: kept.
		epic("orc-7.1.3", "in_progress", { assignee: "impl-renewed", updated_at: new Date(NOW).toISOString() });

		const outcome = await resumeRun(cwd, SESSION, NOW);

		expect(outcome).toEqual({
			kind: "resumed", run: "orc-7", adopted: true, from: "lead:session-old", migrated: false,
			sweep: { released: ["orc-7.1.1"], kept: ["orc-7.1.2", "orc-7.1.3"], failed: [] },
		});
		expect(await readActiveRun(cwd)).toEqual({ schema_version: 1, run_id: "orc-7", session_id: SESSION, beads_dir: join(cwd, ".beads") });
		expect(fenced()).toEqual([
			["orc-7", "--actor", "lead:session-old", "--claim"],
			["orc-7", "--actor", LEAD, "--claim"],
			["orc-7.1.1", "--actor", "impl-dead", "--claim"],
		]);
		const recovered = writes.find(argv => argv[0] === "comment" && argv[1] === "orc-7.1.1")!;
		// The deadline is the later of `lease_until` and `updated_at + TTL`, so the lapse is at 00:15.
		expect(recovered[2]).toMatch(/^RECOVERED impl-dead lease lapsed at 2020-01-01T00:15:00\.000Z; no live session renewed it; released by lead:session-t/);
		expect(recovered.slice(3)).toEqual(["--actor", LEAD]);
	});

	test("the session that already leads resumes too: no takeover, the same sweep", async () => {
		await seed(bound("orc-7"));
		epic("orc-7", "in_progress", { assignee: LEAD, metadata: LIVE });
		store = [{ id: "orc-7.1", status: "in_progress", parent: "orc-7" }];
		epic("orc-7.1", "in_progress", { assignee: "impl-dead", updated_at: LAPSED_AT });
		const outcome = await resumeRun(cwd, SESSION, NOW);
		expect(outcome).toMatchObject({ kind: "resumed", adopted: false, from: LEAD, sweep: { released: ["orc-7.1"], kept: [], failed: [] } });
		expect(fenced()).toEqual([["orc-7.1", "--actor", "impl-dead", "--claim"]]);
	});

	test("refuses a live lease with the holder and its state, and records the refusal on the epic", async () => {
		await seed(bound("orc-7", "session-old"));
		epic("orc-7", "in_progress", { assignee: "lead:session-old", metadata: LIVE });
		const outcome = await resumeRun(cwd, SESSION, NOW);
		expect(outcome).toEqual({ kind: "held-by-other", run: "orc-7", reason: "run epic orc-7 is leased to lead:session-old; lease live until 2999-01-01T00:00:00.000Z" });
		expect(writes).toEqual([["comment", "orc-7", `NOTE adoption refused: ${LEAD} asked to adopt orc-7; run epic orc-7 is leased to lead:session-old; lease live until 2999-01-01T00:00:00.000Z`, "--actor", LEAD]]);
		expect((await readActiveRun(cwd))?.session_id).toBe("session-old");
	});

	test("an epic Beads cannot show refuses adoption", async () => {
		await seed(bound("orc-7", "session-old"));
		epics["orc-7"] = null;
		expect(await resumeRun(cwd, SESSION, NOW)).toEqual({ kind: "refused", run: "orc-7", reason: "run epic orc-7 could not be read" });
	});

	test("migrates a legacy marker: rewritten in this schema with this session, the epic stamped", async () => {
		await seed("orc-7\n");
		epic("orc-7", "open");
		const outcome = await resumeRun(cwd, SESSION, NOW);
		expect(outcome).toMatchObject({ kind: "resumed", adopted: true, from: undefined, migrated: true });
		expect(JSON.parse(await readFile(markerPath(cwd), "utf8"))).toEqual({ run_id: "orc-7", schema_version: 1, session_id: SESSION });
		expect(writes).toContainEqual(["update", "orc-7", "--metadata", '{"schema":1}']);
	});

	test("the release refused by a successor's fence, or an unreadable store, is named per bead", async () => {
		await seed(bound("orc-7"));
		epic("orc-7", "in_progress", { assignee: LEAD, metadata: LIVE });
		store = [{ id: "orc-7.1", status: "in_progress", parent: "orc-7" }, { id: "orc-7.2", status: "in_progress", parent: "orc-7" }];
		epic("orc-7.1", "in_progress", { assignee: "impl-dead", updated_at: LAPSED_AT });
		epics["orc-7.2"] = null;
		failWrites.update = "Error claiming orc-7.1: issue already claimed by impl-next";
		const outcome = await resumeRun(cwd, SESSION, NOW);
		expect(outcome).toMatchObject({ sweep: { released: [], kept: [], failed: ["orc-7.1: a successor holds it", "orc-7.2: could not be read"] } });
		store = null;
		expect(await resumeRun(cwd, SESSION, NOW)).toMatchObject({ kind: "resumed", sweep: "unread" });
	});
});

describe("stopRun", () => {
	test("refuses with no marker; removes a pending marker with nothing to release", async () => {
		await expect(stopRun(cwd, SESSION)).rejects.toThrow(/no active run to stop/);
		await seed('{"schema_version":1,"run_id":"pending"}');
		expect(await stopRun(cwd, SESSION)).toEqual({ run: "pending", lease: "not-held", abandoned: [] });
		expect(await readActiveRun(cwd)).toBeNull();
		expect(writes).toEqual([]);
	});

	test("removes the marker and releases this session's lease under its own fence", async () => {
		await seed(bound("orc-7"));
		epic("orc-7", "in_progress", { assignee: LEAD, metadata: LIVE });
		expect(await stopRun(cwd, SESSION)).toEqual({ run: "orc-7", lease: "released", abandoned: [] });
		expect(await readActiveRun(cwd)).toBeNull();
		expect(writes).toEqual([["update", "orc-7", "--actor", LEAD, "--claim", "--assignee", "", "--status", "open"]]);
	});

	test("refuses while another lead's lease is live, unless forced; a lapsed one is not this session's to release", async () => {
		await seed(bound("orc-7", "session-other"));
		epic("orc-7", "in_progress", { assignee: "lead:session-other", metadata: LIVE });
		await expect(stopRun(cwd, SESSION)).rejects.toThrow(/leased to lead:session-other \(lease live until 2999-01-01T00:00:00\.000Z\); that lead stops it, or pass --force/);
		expect((await readActiveRun(cwd))?.run_id).toBe("orc-7");
		expect(await stopRun(cwd, SESSION, { force: true })).toMatchObject({ run: "orc-7", lease: "not-held" });
		expect(await readActiveRun(cwd)).toBeNull();
		expect(fenced()).toEqual([]);
	});

	test("in-flight beads refuse the stop and keep the lease; --force notes what it abandoned, after the marker is gone", async () => {
		await seed(bound("orc-7"));
		epic("orc-7", "in_progress", { assignee: LEAD, metadata: LIVE });
		store = [{ id: "orc-7.1", status: "in_progress", parent: "orc-7" }];
		await expect(stopRun(cwd, SESSION)).rejects.toThrow(/1 bead under orc-7 still in_progress \(orc-7\.1\); pass --force/);
		expect(writes).toEqual([]);
		expect((await readActiveRun(cwd))?.run_id).toBe("orc-7");
		expect(await stopRun(cwd, SESSION, { force: true })).toEqual({ run: "orc-7", lease: "released", abandoned: ["orc-7.1"] });
		expect(await readActiveRun(cwd)).toBeNull();
		expect(writes).toEqual([
			["comment", "orc-7", `NOTE run stopped with --force by ${LEAD}; 1 in_progress: orc-7.1`, "--actor", LEAD],
			["update", "orc-7", "--actor", LEAD, "--claim", "--assignee", "", "--status", "open"],
		]);
	});

	test("a closed epic and an unreadable one leave nothing to release; a refused release is reported", async () => {
		await seed(bound("orc-7"));
		epic("orc-7", "closed", { assignee: LEAD });
		expect((await stopRun(cwd, SESSION)).lease).toBe("epic-closed");
		await seed(bound("orc-7"));
		epics["orc-7"] = null;
		expect((await stopRun(cwd, SESSION)).lease).toBe("not-held");
		await seed(bound("orc-7"));
		epic("orc-7", "in_progress", { assignee: LEAD, metadata: LIVE });
		failWrites.update = "Error claiming orc-7: issue already claimed by lead:next";
		expect((await stopRun(cwd, SESSION)).lease).toEqual({ failed: "another lead holds the epic" });
		expect(await readActiveRun(cwd)).toBeNull();
	});
});

describe("answerBead", () => {
	let registry: Record<string, { status: "running" | "idle" | "parked" | "aborted" }>;
	let wakes: [string, string][];
	let wakeOutcome: { outcome: string; error?: string };
	const deps: AnswerDeps = {
		registry: { get: id => registry[id] },
		wake: async (to, body) => {
			wakes.push([to, body]);
			return wakeOutcome;
		},
	};

	beforeEach(() => {
		registry = {};
		wakes = [];
		wakeOutcome = { outcome: "revived" };
	});

	function ask(id: string, author: string, ...more: string[]): void {
		comments[id] = [{ text: `ASK ${id}\nowner: lead\nquestion: which colour?`, author }, ...more.map(text => ({ text, author }))];
	}

	test("refuses a bad id, an unreadable bead, and a note that did not land -- nothing else moves", async () => {
		await expect(answerBead(cwd, SESSION, "has space", "blue", deps)).rejects.toThrow(/Beads identifier/);
		await expect(answerBead(cwd, SESSION, "orc-none", "blue", deps)).rejects.toThrow(/orc-none could not be read; nothing recorded/);
		epic("orc-7.1", "blocked", { assignee: "arch-1" });
		registry["arch-1"] = { status: "parked" };
		failWrites.comment = "store locked";
		await expect(answerBead(cwd, SESSION, "orc-7.1", "blue", deps)).rejects.toThrow(/answer not recorded on orc-7\.1: store locked/);
		expect(wakes).toEqual([]);
	});

	test("records NOTE ANSWER as the lead, then wakes a holder this process knows -- parked, idle or running", async () => {
		epic("orc-7", "blocked", { assignee: "arch-1" });
		ask("orc-7", "arch-1");
		for (const status of ["parked", "idle", "running"] as const) {
			registry["arch-1"] = { status };
			expect(await answerBead(cwd, SESSION, "orc-7", "blue, and ship it", deps)).toEqual({ kind: "woken", holder: "arch-1", outcome: "revived" });
		}
		expect(writes).toEqual(Array(3).fill(["comment", "orc-7", "NOTE ANSWER orc-7: blue, and ship it", "--actor", LEAD]));
		expect(wakes).toEqual(Array(3).fill(["arch-1", "ANSWER recorded on orc-7; read `bd comments orc-7` and resume"]));
	});

	test("a wake the bus refuses leaves the claim standing and says why", async () => {
		epic("orc-7", "blocked", { assignee: "arch-1" });
		registry["arch-1"] = { status: "parked" };
		wakeOutcome = { outcome: "failed", error: "Agent \"arch-1\" has no live session." };
		expect(await answerBead(cwd, SESSION, "orc-7", "blue", deps)).toEqual({ kind: "wake-failed", holder: "arch-1", error: "Agent \"arch-1\" has no live session." });
		expect(writes.filter(argv => argv[0] === "update")).toEqual([]);
	});

	test.each(["ASK", "ESCALATED", "FAILED"])("a blocked bead whose exited holder wrote %s is requeued: assignee cleared, status open", async verb => {
		epic("orc-7.1", "blocked", { assignee: "impl-1" });
		comments["orc-7.1"] = [{ text: "REPORTED earlier", author: "impl-0" }, { text: `${verb} orc-7.1\nquestion: which?`, author: "impl-1" }, { text: "NOTE claim preserved: child exited", author: "extension" }];
		expect(await answerBead(cwd, SESSION, "orc-7.1", "the second", deps)).toEqual({ kind: "requeued", holder: "impl-1", gates: [] });
		expect(writes).toEqual([
			["comment", "orc-7.1", "NOTE ANSWER orc-7.1: the second", "--actor", LEAD],
			// Unfenced: bd's `--claim` fence refuses a blocked bead outright, and nobody can have claimed one.
			["update", "orc-7.1", "--status", "open", "--assignee", "", "--actor", LEAD],
		]);
		expect(wakes).toEqual([]);
	});

	test("a hard-aborted holder counts as exited", async () => {
		epic("orc-7.1", "blocked", { assignee: "impl-1" });
		registry["impl-1"] = { status: "aborted" };
		ask("orc-7.1", "impl-1");
		expect(await answerBead(cwd, SESSION, "orc-7.1", "x", deps)).toMatchObject({ kind: "requeued", holder: "impl-1" });
	});

	test("an unstarted bead held for a human is opened and its human gates resolved; other gates stay", async () => {
		epic("orc-7.2", "blocked", {
			dependencies: [
				{ id: "orc-g1", issue_type: "gate", status: "open", await_type: "human", dependency_type: "blocks" },
				{ id: "orc-g2", issue_type: "gate", status: "open", await_type: "gh:pr", dependency_type: "blocks" },
				{ id: "orc-g3", issue_type: "gate", status: "closed", await_type: "human", dependency_type: "blocks" },
				{ id: "orc-7", issue_type: "epic", status: "open", dependency_type: "parent-child" },
			],
		});
		ask("orc-7.2", "arch-1");
		expect(await answerBead(cwd, SESSION, "orc-7.2", "yes", deps)).toEqual({ kind: "requeued", holder: undefined, gates: ["orc-g1"] });
		expect(writes.slice(1)).toEqual([
			["update", "orc-7.2", "--status", "open", "--assignee", "", "--actor", LEAD],
			["gate", "resolve", "orc-g1", "--reason", `ANSWER by ${LEAD} on orc-7.2`, "--actor", LEAD],
		]);
	});

	test("a requeue bd refuses is reported with its reason; an unreadable comment list keeps the hold", async () => {
		epic("orc-7.1", "blocked", { assignee: "impl-1" });
		ask("orc-7.1", "impl-1");
		failWrites.update = "Error: store locked";
		expect(await answerBead(cwd, SESSION, "orc-7.1", "x", deps)).toEqual({ kind: "requeue-refused", holder: "impl-1", reason: "Error: store locked" });
		delete failWrites.update;
		commentsUnreadable = true;
		expect(await answerBead(cwd, SESSION, "orc-7.1", "x", deps)).toMatchObject({ kind: "kept", reason: expect.stringContaining("could not be read") });
		expect(writes.filter(argv => argv[0] === "update")).toHaveLength(1);
	});

	test("a bead that is not blocked, or blocked without a hold verb, keeps the note only", async () => {
		epic("orc-7.1", "in_progress", { assignee: "impl-1" });
		ask("orc-7.1", "impl-1");
		expect(await answerBead(cwd, SESSION, "orc-7.1", "x", deps)).toEqual({ kind: "kept", reason: "orc-7.1 is in_progress with last hold ASK; nothing requeued" });
		epic("orc-7.3", "blocked");
		comments["orc-7.3"] = [{ text: "BLOCKED orc-7.3 waits on gate orc-g9", author: "impl-1" }];
		expect(await answerBead(cwd, SESSION, "orc-7.3", "x", deps)).toEqual({ kind: "kept", reason: "orc-7.3 is blocked with no hold verb; nothing requeued" });
		expect(writes.filter(argv => argv[0] === "update")).toEqual([]);
	});
});

describe("runStatusReport", () => {
	const NOW = Date.parse("2026-01-01T12:00:00Z");

	test("an absent marker is an inactive repository, not hidden", async () => {
		const report = await runStatusReport(cwd, NOW);
		expect(report.healthy).toBe(false);
		expect(report.lines).toEqual([`no active run: ${markerPath(cwd)} is absent; /orchestrate-start starts one`]);
		expect(showSpy).not.toHaveBeenCalled();
	});

	test("a malformed marker, and one a newer plugin wrote, are reported for reconciliation", async () => {
		await seed("{broken");
		expect((await runStatusReport(cwd, NOW)).lines[0]).toContain("malformed");
		await seed('{"schema_version":3,"run_id":"orc-7"}');
		expect((await runStatusReport(cwd, NOW)).lines[0]).toContain("schema 3 is newer than this plugin's 1");
	});

	test("a pending marker names the release that left it and both ways out", async () => {
		await seed('{"schema_version":1,"run_id":"pending","session_id":"session-a"}');
		const report = await runStatusReport(cwd, NOW);
		expect(report.healthy).toBe(false);
		expect(report.lines).toEqual([`run: pending (marker ${markerPath(cwd)}, session session-a, written by an older plugin release); /orchestrate-start <epic-id> binds it, /orchestrate-stop removes it`]);
	});

	test("a bound, open run with nothing pending is healthy and says attention: none", async () => {
		await seed(bound("orc-7"));
		epic("orc-7", "in_progress", { assignee: LEAD, metadata: LIVE });
		const report = await runStatusReport(cwd, NOW);
		expect(report.healthy).toBe(true);
		expect(report.lines).toEqual([
			`run: bound to orc-7 (marker ${markerPath(cwd)}, session ${SESSION})`,
			"epic orc-7: in_progress",
			`lead: ${LEAD}, lease live until 2999-01-01T00:00:00.000Z`,
			"attention: none",
		]);
		expect(probeCalls).toEqual([join(cwd, ".beads")]);
	});

	test("an epic without a recorded lead says how to stamp one", async () => {
		await seed(bound("orc-7"));
		expect((await runStatusReport(cwd, NOW)).lines[2]).toBe("lead: none recorded; /orchestrate-start orc-7 stamps this session's lease");
	});

	test.each([
		["closed", { id: "orc-7", status: "closed" }, "epic orc-7: closed; supervision is off, and /orchestrate-stop removes the marker"],
		["unverifiable", null, "epic orc-7: status could not be verified (bd unavailable or bead missing); child supervision is suspended until it can"],
		["unknown", { id: "orc-7", status: "paused" }, 'epic orc-7: status "paused" is not a run status; child supervision is suspended'],
	])("a %s epic says what supervision does about it", async (_label, shown, line) => {
		await seed(bound("orc-7"));
		epics["orc-7"] = shown;
		const report = await runStatusReport(cwd, NOW);
		expect(report.healthy).toBe(false);
		expect(report.lines[1]).toBe(line);
	});

	describe("attention", () => {
		/** The attention lines of a healthy bound run, without the three header lines. */
		async function attention(): Promise<string[]> {
			const report = await runStatusReport(cwd, NOW);
			return report.lines.slice(3);
		}

		beforeEach(async () => {
			await seed(bound("orc-7"));
			epic("orc-7", "in_progress", { assignee: LEAD, metadata: LIVE });
		});

		test("a lapsed lead lease points at resume", async () => {
			epic("orc-7", "in_progress", { assignee: "lead:gone", updated_at: LAPSED_AT, metadata: { lease_until: LAPSED_AT } });
			expect(await attention()).toEqual(["attention:", "- lead lease lapsed: lead:gone; /orchestrate-resume adopts the run"]);
		});

		test.each([
			[{ state: "locked", lock: "L", holder: "bd[42]" } satisfies StoreProbe, "- store locked by bd[42] (L)"],
			[{ state: "corrupted", lock: "L", detail: "corrupted journal" } satisfies StoreProbe, "- store corrupted: corrupted journal"],
			[{ state: "slow", lock: "L", ms: 3100 } satisfies StoreProbe, "- store slow: one read took 3100 ms"],
		])("a store the probe reports as %j", async (answer, line) => {
			probe = answer;
			expect(await attention()).toEqual(["attention:", line]);
		});

		test("a probe that throws, and a marker without a database, are said and skipped respectively", async () => {
			probe = new Error("bd could not be run");
			expect(await attention()).toEqual(["attention:", "- store probe failed: bd could not be run"]);
			await seed(JSON.stringify({ schema_version: 1, run_id: "orc-7", session_id: SESSION }));
			probeCalls.length = 0;
			expect(await attention()).toEqual(["attention: none"]);
			expect(probeCalls).toEqual([]);
		});

		test("in-flight claims whose lease lapsed, with their holder; live ones are silent", async () => {
			store = [
				{ id: "orc-7.1", status: "open", parent: "orc-7" },
				{ id: "orc-7.1.1", status: "in_progress", parent: "orc-7.1", assignee: "impl-dead", updated_at: LAPSED_AT, metadata: { lease_until: LAPSED_AT } },
				{ id: "orc-7.1.2", status: "in_progress", parent: "orc-7.1", assignee: "impl-live", metadata: LIVE },
				{ id: "orc-9.1", status: "in_progress", parent: "orc-9", assignee: "other-run", updated_at: LAPSED_AT },
			];
			expect(await attention()).toEqual(["attention:", "- lease lapsed: orc-7.1.1 held by impl-dead, lease lapsed at 2020-01-01T00:15:00.000Z"]);
		});

		test("landings the sweep bounced or blocked, with the fix bead; landed and closed merge beads are silent", async () => {
			store = [
				{ id: "orc-m1", status: "open", metadata: { landing_state: "bounced", landing_fix: "orc-7.1.9" } },
				{ id: "orc-m2", status: "blocked", metadata: { landing_state: "closed" } },
				{ id: "orc-m3", status: "open", metadata: { landing_state: "armed", landing_notice: "disarmed:abc1234" } },
				{ id: "orc-m4", status: "closed", metadata: { landing_state: "bounced" } },
				{ id: "orc-m5", status: "open", metadata: { landing_state: "landed", landing_notice: "" } },
			];
			expect(await attention()).toEqual([
				"attention:",
				"- landing BOUNCED: orc-m1 (fix orc-7.1.9)",
				"- landing BOUNCED: orc-m2",
				"- landing BLOCKED: orc-m3 (disarmed:abc1234)",
			]);
		});

		test("open questions on blocked beads: the question line, the author, the verb; answered ones are silent", async () => {
			store = [
				{ id: "orc-7.1", status: "blocked", comment_count: 2 },
				{ id: "orc-7.2", status: "blocked", comment_count: 3 },
				{ id: "orc-m1", status: "blocked", comment_count: 1 },
				{ id: "orc-7.3", status: "blocked", comment_count: 0 },
				{ id: "orc-7.4", status: "in_progress", comment_count: 1 },
				{ id: "orc-7.5", status: "blocked" },
			];
			comments["orc-7.1"] = [{ text: "REPORTED head=abc", author: "impl-0" }, { text: "ASK orc-7.1\nowner: lead\nquestion: dark or light theme?\nimpact: all screens", author: "impl-1" }];
			comments["orc-7.2"] = [{ text: "ASK orc-7.2 which?", author: "impl-2" }, { text: `NOTE ANSWER orc-7.2: the first`, author: LEAD }, { text: "NOTE picked up", author: "impl-3" }];
			comments["orc-m1"] = [{ text: "**ESCALATED** orc-m1 bot round limit reached; question: accept the lint waiver?" }];
			comments["orc-7.4"] = [{ text: "ASK orc-7.4 not blocked yet" }];
			comments["orc-7.5"] = [{ text: "- ask orc-7.5 lowercase and bulleted", author: "impl-5" }];
			expect(await attention()).toEqual([
				"attention:",
				"- ASK orc-7.1 (impl-1): dark or light theme?",
				"- ESCALATED orc-m1 (unknown): orc-m1 bot round limit reached; question: accept the lint waiver?",
				"- ASK orc-7.5 (impl-5): orc-7.5 lowercase and bulleted",
			]);
			expect(commentsSpy.mock.calls.map(call => call[0])).toEqual(["orc-7.1", "orc-7.2", "orc-m1", "orc-7.5", "orc-7"]);
		});

		test("a refused adoption and the last WARN on the epic", async () => {
			comments["orc-7"] = [
				{ text: "WARN settings: task.isolation.apply is true; captures are applied", author: "extension" },
				{ text: "NOTE adoption refused: lead:s9 asked to adopt orc-7; run epic orc-7 is leased to lead:session-t; lease live until 2999-01-01T00:00:00.000Z", author: "lead:s9" },
				{ text: "WARN agents: orc-scout: not found", author: "extension" },
				{ text: "NOTE something else", author: "impl-1" },
			];
			expect(await attention()).toEqual([
				"attention:",
				"- adoption refused: lead:s9 asked to adopt orc-7; run epic orc-7 is leased to lead:session-t; lease live until 2999-01-01T00:00:00.000Z",
				"- WARN agents: orc-scout: not found",
			]);
		});

		test("unreadable beads or comments are said, never silently dropped", async () => {
			store = null;
			expect(await attention()).toEqual(["attention:", "- beads unreadable: lapsed leases, landings and open questions are unknown"]);
			store = [{ id: "orc-7.1", status: "blocked", comment_count: 1 }];
			commentsUnreadable = true;
			expect(await attention()).toEqual(["attention:", "- orc-7.1 is blocked; its comments could not be read", "- comments on orc-7 could not be read"]);
		});
	});
});

describe("registerRunCommands", () => {
	type Handler = (args: string, ctx: unknown) => Promise<void>;

	function rig(onActivate?: (cwd: string) => Promise<unknown>, deps?: Partial<AnswerDeps>) {
		const handlers = new Map<string, Handler>();
		const notices: Array<[string, string]> = [];
		const pi = {
			registerCommand: (name: string, spec: { handler: Handler }) => {
				handlers.set(name, spec.handler);
			},
		} as unknown as ExtensionAPI;
		registerRunCommands(pi, onActivate, deps);
		const ctx = {
			sessionManager: { getCwd: () => cwd, getSessionId: () => SESSION },
			ui: { notify: (text: string, level: string) => notices.push([level, text]) },
		};
		const command = (name: string) => {
			const handler = handlers.get(name);
			if (handler === undefined) throw new Error(`${name} not registered`);
			return (args = "") => handler(args, ctx);
		};
		return {
			registered: [...handlers.keys()],
			start: command("orchestrate-start"),
			resume: command("orchestrate-resume"),
			status: command("orchestrate-status"),
			answer: command("orchestrate-answer"),
			stop: command("orchestrate-stop"),
			notices,
		};
	}

	test("registers the five operator commands, and no others", () => {
		expect(rig().registered).toEqual(["orchestrate-start", "orchestrate-resume", "orchestrate-status", "orchestrate-answer", "orchestrate-stop"]);
	});

	test.each([
		["start", "--new", 'usage: /orchestrate-start <epic-id> | --new "<title>"'],
		["start", "orc-7 orc-8", 'usage: /orchestrate-start <epic-id> | --new "<title>"'],
		["start", "--bogus", 'usage: /orchestrate-start <epic-id> | --new "<title>"'],
		["answer", "orc-7", "usage: /orchestrate-answer <bead> <text>"],
		["answer", "", "usage: /orchestrate-answer <bead> <text>"],
		["stop", "orc-7", "usage: /orchestrate-stop [--force]"],
		["stop", "--force --now", "usage: /orchestrate-stop [--force]"],
	] as const)("/orchestrate-%s %j is a usage error before anything runs", async (name, args, usage) => {
		const commands = rig();
		await commands[name](args);
		expect(commands.notices).toEqual([["error", usage]]);
		expect(writes).toEqual([]);
		expect(probeCalls).toEqual([]);
	});

	test("/orchestrate-start with an epic: one notice with the run, the lease, the landing mode, then the readiness hook", async () => {
		landingRecord = { ok: true, level: "info", notice: "landing mode direct for o/r (main): auto-merge off, required checks none", caps: {} as never };
		const seen: Array<string | null> = [];
		const { start, notices } = rig(async hookCwd => {
			seen.push((await readActiveRun(hookCwd))?.run_id ?? null);
		});
		await start("orc-7");
		expect(notices).toEqual([["info", [
			"orchestrate run bound: orc-7",
			"lead lease stamped",
			"landing mode direct for o/r (main): auto-merge off, required checks none",
		].join("\n")]]);
		expect(seen).toEqual(["orc-7"]);
		expect((await readActiveRun(cwd))?.beads_dir).toBe(join(cwd, ".beads"));
	});

	test('/orchestrate-start --new "<title>" quotes the title whole, reports creation', async () => {
		createdEpic = "orc-made";
		epic("orc-made");
		const { start, notices } = rig();
		await start('--new "Release 4: the big one"');
		expect(writes.find(argv => argv[0] === "create")?.[1]).toBe("Release 4: the big one");
		expect(notices[0]?.[1].split("\n")[0]).toBe("orchestrate run started: orc-made (epic created)");
		expect(notices[0]?.[0]).toBe("warning");
		expect(notices[0]?.[1]).toContain("landing capabilities not recorded on orc-made: not probed in this test; the sweep lands directly on CLEAN");
	});

	test("/orchestrate-start refusals are one error notice and no hook", async () => {
		let calls = 0;
		const { start, notices } = rig(async () => {
			calls += 1;
		});
		await seed(bound("orc-7", "session-other"));
		await start("orc-7");
		expect(notices).toEqual([["error", expect.stringContaining("started by session session-other")]]);
		expect(calls).toBe(0);
	});

	test("/orchestrate-start warns, never errors, on a slow store, a missing lease, a failed stamp or a failed hook", async () => {
		probe = { state: "slow", lock: "L", ms: 2500 };
		failWrites.update = "store locked";
		const { start, notices } = rig(async () => {
			throw new Error("omp config unreadable");
		});
		await start("orc-7");
		expect(notices).toEqual([["warning", [
			"orchestrate run bound: orc-7",
			"store slow: one read took 2500 ms",
			"lead lease not stamped: store locked",
			"epic not stamped: store locked",
			"landing capabilities not recorded on orc-7: not probed in this test; the sweep lands directly on CLEAN",
			"readiness check failed: omp config unreadable",
		].join("\n")]]);
		expect((await readActiveRun(cwd))?.run_id).toBe("orc-7");
	});

	test("/orchestrate-resume: adoption summary with the claim sweep, then the readiness hook; refusals are errors", async () => {
		await seed(bound("orc-7", "session-old"));
		epic("orc-7", "in_progress", { assignee: "lead:session-old", updated_at: LAPSED_AT, metadata: { lease_until: LAPSED_AT } });
		store = [{ id: "orc-7.1", status: "in_progress", parent: "orc-7" }, { id: "orc-7.2", status: "in_progress", parent: "orc-7" }];
		epic("orc-7.1", "in_progress", { assignee: "impl-dead", updated_at: LAPSED_AT });
		epic("orc-7.2", "in_progress", { assignee: "impl-live", metadata: LIVE });
		let hooked = 0;
		const { resume, notices } = rig(async () => {
			hooked += 1;
		});
		await resume();
		expect(notices).toEqual([["info", "orchestrate run orc-7 adopted from lead:session-old\nclaims: 1 released (orc-7.1), 1 kept"]]);
		expect(hooked).toBe(1);

		epic("orc-7", "in_progress", { assignee: "lead:session-old", metadata: LIVE });
		await seed(bound("orc-7", "session-old"));
		await resume();
		expect(notices.at(-1)).toEqual(["error", expect.stringMatching(/^resume refused: run epic orc-7 is leased to lead:session-old; lease live until/)]);
		expect(hooked).toBe(1);
	});

	test("/orchestrate-resume on a legacy marker reports the migration; an unread sweep is a warning", async () => {
		await seed("orc-7\n");
		store = null;
		const { resume, notices } = rig();
		await resume();
		expect(notices).toEqual([["warning", "orchestrate run orc-7 adopted from no recorded lead\nmarker migrated to schema 1\nin-flight claims could not be read; none released"]]);
	});

	test("/orchestrate-status prints the report at the level its health warrants", async () => {
		const { status, notices } = rig();
		await status();
		expect(notices.at(-1)).toEqual(["warning", `no active run: ${markerPath(cwd)} is absent; /orchestrate-start starts one`]);
		await seed(bound("orc-7"));
		epic("orc-7", "in_progress", { assignee: LEAD, metadata: LIVE });
		await status();
		expect(notices.at(-1)?.[0]).toBe("info");
		expect(notices.at(-1)?.[1]).toEndWith("attention: none");
	});

	test("/orchestrate-answer <bead> <text>: the text is everything after the id, and the hold's fate is reported", async () => {
		epic("orc-7.1", "blocked", { assignee: "impl-1", dependencies: [{ id: "orc-g1", issue_type: "gate", status: "open", await_type: "human" }] });
		comments["orc-7.1"] = [{ text: "ASK orc-7.1 which?", author: "impl-1" }];
		const wakes: string[] = [];
		const { answer, notices } = rig(undefined, {
			registry: { get: id => (id === "arch-1" ? { status: "parked" } : undefined) },
			wake: async to => {
				wakes.push(to);
				return { outcome: "revived" };
			},
		});
		await answer("orc-7.1   go with the second option, keep the API");
		expect(writes[0]).toEqual(["comment", "orc-7.1", "NOTE ANSWER orc-7.1: go with the second option, keep the API", "--actor", LEAD]);
		expect(notices.at(-1)).toEqual(["info", "answer recorded on orc-7.1\norc-7.1 requeued (released from impl-1); human gate orc-g1 resolved"]);

		epic("orc-7", "blocked", { assignee: "arch-1" });
		await answer("orc-7 yes");
		expect(notices.at(-1)).toEqual(["info", "answer recorded on orc-7\narch-1 revived"]);
		expect(wakes).toEqual(["arch-1"]);

		await answer("orc-none yes");
		expect(notices.at(-1)).toEqual(["error", "bead orc-none could not be read; nothing recorded"]);
	});

	test("/orchestrate-stop reads the run from the marker; --force is the only flag", async () => {
		await seed(bound("orc-7"));
		epic("orc-7", "in_progress", { assignee: LEAD, metadata: LIVE });
		store = [{ id: "orc-7.1", status: "in_progress", parent: "orc-7" }];
		const { stop, notices } = rig();
		await stop();
		expect(notices.at(-1)).toEqual(["error", expect.stringContaining("1 bead under orc-7 still in_progress (orc-7.1); pass --force")]);
		expect((await readActiveRun(cwd))?.run_id).toBe("orc-7");
		await stop("--force");
		expect(notices.at(-1)).toEqual(["warning", "orchestrate run orc-7 stopped; marker removed\nlead lease released\nabandoned in_progress: orc-7.1"]);
		expect(await readActiveRun(cwd)).toBeNull();
		await stop();
		expect(notices.at(-1)).toEqual(["error", "no active run to stop"]);
	});

	test("/orchestrate-stop then /orchestrate-start starts the next run in the same repository", async () => {
		// The operator-stranding path: without stop, the second start was refused as
		// "already bound" until the marker was deleted by hand.
		const { start, stop, notices } = rig();
		await start("orc-7");
		epic("orc-7", "in_progress", { assignee: LEAD, metadata: LIVE });
		await stop();
		expect(notices.at(-1)).toEqual(["info", "orchestrate run orc-7 stopped; marker removed\nlead lease released"]);
		await start("orc-2");
		expect(notices.at(-1)?.[1]).toStartWith("orchestrate run bound: orc-2");
		expect((await readActiveRun(cwd))?.run_id).toBe("orc-2");
	});
});
