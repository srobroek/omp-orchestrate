import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs, { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import * as supervision from "../src/supervision";
import * as bd from "../src/bd";
import type { BdBead } from "../src/bd";
import { activateRun, bindRun, closeRun, isBoundRunActive, markerPath, readActiveRun, registerRunCommands, runStatusReport } from "../src/run-state";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

/**
 * What Beads answers. `bd show <id>` returns `epics[id]`, `null` when unknown; `bd list`
 * returns `store`, `null` for an unreadable one. Spied once for the file, so a test that
 * restores would not strip the default from the tests after it.
 */
let epics: Record<string, BdBead | null> = {};
let store: BdBead[] | null = [];
let listArgs: string[][] = [];
const showSpy = spyOn(bd, "bdShow").mockImplementation(async id => epics[id] ?? null);
const listSpy = spyOn(bd, "bdListChecked").mockImplementation(async args => {
	listArgs.push(args);
	return store;
});
let patrol: "armed" | "absent" | "unknown" = "armed";
let arming: Error | undefined;
const patrolSpy = spyOn(supervision, "ensurePatrolWisp").mockImplementation(async () => {
	if (arming !== undefined) throw arming;
});
const patrolStateSpy = spyOn(supervision, "patrolState").mockImplementation(async () => patrol);
afterAll(() => {
	showSpy.mockRestore();
	listSpy.mockRestore();
	patrolSpy.mockRestore();
	patrolStateSpy.mockRestore();
});

let cwd: string;

/** A run epic Beads shows with `status`. */
function epic(id: string, status = "open"): void {
	epics[id] = { id, status };
}

beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), "orc-run-state-"));
	delete process.env.ORCHESTRATE_MARKER_FILE;
	delete process.env.BD_BIN;
	// Every id a test binds below is an open epic unless the test says otherwise.
	epics = {};
	for (const id of ["orc-1", "orc-2", "orc-7", "orc-42", "orc-a", "orc-b", "orc-legacy", "orc-new", "orc-other", "orc.run_1:2-3"]) epic(id);
	store = [];
	listArgs = [];
	patrol = "armed";
	arming = undefined;
	showSpy.mockClear();
});

afterEach(async () => {
	delete process.env.ORCHESTRATE_MARKER_FILE;
	await rm(cwd, { recursive: true, force: true });
	delete process.env.BD_BIN;
});

/** Write a marker body directly, bypassing `activateRun`, to fake prior state. */
async function seed(body: string): Promise<void> {
	await mkdir(join(cwd, ".orchestration"), { recursive: true });
	await writeFile(markerPath(cwd), body, "utf8");
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

describe("activateRun", () => {
	test("unreadable existing authority aborts activation and binding without rewriting bytes", async () => {
		const original = '{"run_id":"orc-existing","schema_version":1}\n';
		await seed(original);
		const denied = Object.assign(new Error("permission denied"), { code: "EACCES" });
		const readSpy = spyOn(fs, "readFile").mockRejectedValue(denied);
		try {
			await expect(activateRun(cwd)).rejects.toThrow("permission denied");
			await expect(bindRun(cwd, "orc-other")).rejects.toThrow("permission denied");
		} finally {
			readSpy.mockRestore();
		}
		expect(await readFile(markerPath(cwd), "utf8")).toBe(original);
		await expect(bindRun(cwd, "orc-other")).rejects.toThrow("already bound to orc-existing");
		expect(await readFile(markerPath(cwd), "utf8")).toBe(original);
	});

	test.each(["", "{broken", "[]", '{"schema_version":1}', '{"run_id":false}', '{"run_id":"orc-existing","schema_version":2}', '{"run_id":"orc-existing","beads_dir":"relative/.beads"}'])(
		"malformed marker %s is never treated as permission to activate or bind",
		async original => {
			await seed(original);
			await expect(activateRun(cwd)).rejects.toThrow(/malformed/);
			await expect(bindRun(cwd, "orc-other")).rejects.toThrow(/malformed/);
			expect(await readFile(markerPath(cwd), "utf8")).toBe(original);
		},
	);

	test("a fresh repository activates as pending", async () => {
		const state = await activateRun(cwd, "session-a");
		expect(state).toEqual({
			schema_version: 1,
			run_id: "pending",
			session_id: "session-a",
		});
		expect(await readActiveRun(cwd)).toEqual(state);
	});

	test("creates the .orchestration directory", async () => {
		await activateRun(cwd);
		expect(await readdir(join(cwd, ".orchestration"))).toContain(".active-run");
	});

	test("preserves an existing binding", async () => {
		await activateRun(cwd, "session-a");
		await bindRun(cwd, "orc-42");
		const reactivated = await activateRun(cwd, "session-b");
		// Re-activation mid-run must not reset the run id to pending, or the gates
		// would stop resolving liveness against the real run bead.
		expect(reactivated.run_id).toBe("orc-42");
		expect(reactivated.session_id).toBe("session-b");
	});

	test("keeps the recorded session when none is supplied", async () => {
		await activateRun(cwd, "session-a");
		expect((await activateRun(cwd)).session_id).toBe("session-a");
	});

	test("omits session_id entirely when never supplied", async () => {
		const state = await activateRun(cwd);
		expect("session_id" in state).toBe(false);
		expect(JSON.parse(await readFile(markerPath(cwd), "utf8"))).toEqual({
			schema_version: 1,
			run_id: "pending",
		});
	});

	test("leaves no temporary file behind", async () => {
		await activateRun(cwd, "session-a");
		await bindRun(cwd, "orc-1");
		expect((await readdir(join(cwd, ".orchestration"))).filter(name => name.endsWith(".tmp"))).toEqual([]);
	});

	test("a marker from before the pin was retired still reads, without its dead field", async () => {
		// `repo_root` was written for the `bd -C` substitution and is read by nothing.
		// Removing it from the type must not strand a run activated by an older build:
		// the field is dropped on read rather than rejected, and re-activation stops
		// writing it.
		await seed(`{"repo_root":${JSON.stringify(resolve(cwd))},"run_id":"orc-9","schema_version":1}\n`);
		expect(await readActiveRun(cwd)).toEqual({ schema_version: 1, run_id: "orc-9" });
		expect(await activateRun(cwd)).toEqual({ schema_version: 1, run_id: "orc-9" });
		expect(JSON.parse(await readFile(markerPath(cwd), "utf8"))).toEqual({ run_id: "orc-9", schema_version: 1 });
	});

	test("records the run's database and keeps it across re-activation, binding and a lenient read", async () => {
		const beadsDir = join(cwd, ".beads");
		expect((await activateRun(cwd, "session-a", beadsDir)).beads_dir).toBe(beadsDir);
		// A re-activation that names no database keeps the recorded one, as it keeps the session.
		expect((await activateRun(cwd)).beads_dir).toBe(beadsDir);
		await bindRun(cwd, "orc-42");
		expect(await readActiveRun(cwd)).toEqual({ schema_version: 1, run_id: "orc-42", session_id: "session-a", beads_dir: beadsDir });
		// The lenient reader drops a relative path rather than handing a copy a target it
		// would resolve against its own tree.
		await seed('{"run_id":"orc-9","schema_version":1,"beads_dir":"relative/.beads"}');
		expect(await readActiveRun(cwd)).toEqual({ schema_version: 1, run_id: "orc-9" });
	});
});

describe("readActiveRun", () => {
	test("returns null with no marker", async () => {
		expect(await readActiveRun(cwd)).toBeNull();
	});

	test("returns null for an empty marker", async () => {
		await seed("   \n");
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

	test("ignores a non-string session id", async () => {
		await seed('{"run_id": "orc-9", "session_id": 5}');
		expect(await readActiveRun(cwd)).toEqual({ schema_version: 1, run_id: "orc-9" });
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
		expect(showSpy).toHaveBeenCalledWith("orc-7", undefined, cwd);
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

	test("throws when marker authority is unreadable", async () => {
		const denied = Object.assign(new Error("permission denied"), { code: "EACCES" });
		const read = spyOn(fs, "readFile").mockRejectedValue(denied);
		try {
			await expect(isBoundRunActive(cwd)).rejects.toThrow("permission denied");
		} finally {
			read.mockRestore();
		}
	});
});

describe("bindRun", () => {
	test("overlapping different binders cannot both acquire the pending marker", async () => {
		await activateRun(cwd);
		const results = await Promise.allSettled([bindRun(cwd, "orc-a"), bindRun(cwd, "orc-b")]);
		expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
		const winner = results[0]?.status === "fulfilled" ? "orc-a" : "orc-b";
		expect((await readActiveRun(cwd))?.run_id).toBe(winner);
		const refusal = results.find(result => result.status === "rejected");
		expect(refusal?.status === "rejected" && String(refusal.reason)).toContain("already bound");
	});

	test("activation interleaved with binding cannot erase its winner", async () => {
		await activateRun(cwd);
		await Promise.all([activateRun(cwd, "session-new"), bindRun(cwd, "orc-a")]);
		expect((await readActiveRun(cwd))?.run_id).toBe("orc-a");
	});

	test("an existing cross-process lock is not stolen or deleted", async () => {
		await activateRun(cwd);
		const lock = `${markerPath(cwd)}.lock`;
		await writeFile(lock, "other writer");
		await expect(bindRun(cwd, "orc-a")).rejects.toThrow(/locked/);
		expect(await readFile(lock, "utf8")).toBe("other writer");
		expect((await readActiveRun(cwd))?.run_id).toBe("pending");
	});

	test("binds a pending marker", async () => {
		await activateRun(cwd, "session-a");
		await bindRun(cwd, "orc-7");
		expect((await readActiveRun(cwd))?.run_id).toBe("orc-7");
	});

	test("preserves the session id across a bind", async () => {
		await activateRun(cwd, "session-a");
		await bindRun(cwd, "orc-7");
		expect((await readActiveRun(cwd))?.session_id).toBe("session-a");
	});

	test("rejects ids that are not Beads identifiers", async () => {
		await activateRun(cwd);
		for (const bad of ["", "-leading", "has space", "has/slash", "quote\"d", "semi;colon"]) {
			await expect(bindRun(cwd, bad)).rejects.toThrow(/Beads identifier/);
		}
		expect((await readActiveRun(cwd))?.run_id).toBe("pending");
	});

	test("accepts the punctuation Beads ids use", async () => {
		await activateRun(cwd);
		await bindRun(cwd, "orc.run_1:2-3");
		expect((await readActiveRun(cwd))?.run_id).toBe("orc.run_1:2-3");
	});

	test("refuses a different id once bound", async () => {
		await activateRun(cwd);
		await bindRun(cwd, "orc-1");
		await expect(bindRun(cwd, "orc-2")).rejects.toThrow(/already bound to orc-1/);
		expect((await readActiveRun(cwd))?.run_id).toBe("orc-1");
	});

	test("rebinding the same id is a no-op", async () => {
		await activateRun(cwd);
		await bindRun(cwd, "orc-1");
		await bindRun(cwd, "orc-1");
		expect((await readActiveRun(cwd))?.run_id).toBe("orc-1");
	});

	test("refuses when there is no marker to bind", async () => {
		await expect(bindRun(cwd, "orc-1")).rejects.toThrow(/no active-run marker/);
	});

	test("binds over a legacy raw-string marker naming the same run", async () => {
		await seed("orc-legacy\n");
		await bindRun(cwd, "orc-legacy");
		expect(JSON.parse(await readFile(markerPath(cwd), "utf8"))).toEqual({
			schema_version: 1,
			run_id: "orc-legacy",
		});
	});

	test("refuses to retarget a legacy raw-string marker", async () => {
		await seed("orc-legacy\n");
		await expect(bindRun(cwd, "orc-new")).rejects.toThrow(/already bound to orc-legacy/);
	});

	test.each([
		["an epic Beads does not know", null, /could not be read from Beads; binding refused/],
		["an epic whose status is unreadable", { id: "orc-typo" }, /could not be read from Beads; binding refused/],
		["a closed epic", { id: "orc-typo", status: "closed" }, /status "closed", which cannot host a run/],
		["an epic in a status supervision does not recognise", { id: "orc-typo", status: "paused" }, /status "paused", which cannot host a run/],
	])("refuses %s and leaves the marker pending", async (_label, shown, reason) => {
		// A typo accepted here disarmed supervision for the whole run: every child exit
		// hit "run liveness unavailable" and the reaper skipped, while the operator was
		// told the run was bound.
		await activateRun(cwd);
		epics["orc-typo"] = shown;
		await expect(bindRun(cwd, "orc-typo")).rejects.toThrow(reason);
		expect((await readActiveRun(cwd))?.run_id).toBe("pending");
		expect(patrolSpy).not.toHaveBeenCalledWith("orc-typo", cwd);
	});

	test("reads the epic before touching the marker, in the repository cwd", async () => {
		await activateRun(cwd);
		await bindRun(cwd, "orc-7");
		expect(showSpy).toHaveBeenCalledWith("orc-7", undefined, cwd);
	});

	test("reports the patrol armed", async () => {
		await activateRun(cwd);
		expect(await bindRun(cwd, "orc-7")).toEqual({ patrol: "armed" });
	});

	test("a failed arming binds, is returned, and is not emitted as a process warning", async () => {
		arming = new Error("Patrol orc-7 lookup unknown; creation refused");
		const warnings: string[] = [];
		const onWarning = (warning: Error) => { warnings.push(warning.message); };
		process.on("warning", onWarning);
		try {
			await activateRun(cwd);
			expect(await bindRun(cwd, "orc-7")).toEqual({ patrol: { failed: "Patrol orc-7 lookup unknown; creation refused" } });
			expect((await readActiveRun(cwd))?.run_id).toBe("orc-7");
			await setImmediate();
			expect(warnings).toEqual([]);
		} finally {
			process.off("warning", onWarning);
		}
	});
});

describe("closeRun", () => {
	test("removes the marker and its lock once the marker names the run", async () => {
		await activateRun(cwd, "session-a");
		await bindRun(cwd, "orc-7");
		await closeRun(cwd, "orc-7");
		expect(await readActiveRun(cwd)).toBeNull();
		expect(await readdir(join(cwd, ".orchestration"))).toEqual([]);
		expect(listArgs).toEqual([["list", "--status", "all", "--exclude-type", "event", "--limit", "0", "--json"]]);
	});

	test("refuses an id the marker does not name", async () => {
		await activateRun(cwd);
		await bindRun(cwd, "orc-7");
		await expect(closeRun(cwd, "orc-2")).rejects.toThrow(/bound to orc-7, not orc-2/);
		expect((await readActiveRun(cwd))?.run_id).toBe("orc-7");
		expect(listArgs).toEqual([]);
	});

	test("refuses while beads under the run are in_progress, naming them", async () => {
		await activateRun(cwd);
		await bindRun(cwd, "orc-7");
		store = [{ id: "orc-7.1", status: "in_progress", parent: "orc-7" }, { id: "orc-7.4", status: "in_progress", parent: "orc-7" }];
		await expect(closeRun(cwd, "orc-7")).rejects.toThrow(/2 beads under orc-7 still in_progress \(orc-7\.1, orc-7\.4\); pass --force/);
		expect((await readActiveRun(cwd))?.run_id).toBe("orc-7");
	});

	test("finds in_progress tasks below features, through a closed feature, and ignores other runs", async () => {
		// `bd list --parent` is direct-only (bd 1.2.2), and claims live on tasks two levels
		// down while their feature stays open; a close that read direct children only would
		// strip supervision from every worker still holding one.
		await activateRun(cwd);
		await bindRun(cwd, "orc-7");
		store = [
			{ id: "orc-7", status: "in_progress" },
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
		// Another run's in-flight work in the same store is not this run's reason to stay open.
		store = [{ id: "orc-9", status: "in_progress" }, { id: "orc-9.1", status: "in_progress", parent: "orc-9" }];
		await closeRun(cwd, "orc-7");
		expect(await readActiveRun(cwd)).toBeNull();
	});

	test("refuses when the children cannot be read, unless forced", async () => {
		await activateRun(cwd);
		await bindRun(cwd, "orc-7");
		store = null;
		await expect(closeRun(cwd, "orc-7")).rejects.toThrow(/could not be read; pass --force/);
		expect((await readActiveRun(cwd))?.run_id).toBe("orc-7");
		await closeRun(cwd, "orc-7", { force: true });
		expect(await readActiveRun(cwd)).toBeNull();
	});

	test("force skips the children check entirely", async () => {
		await activateRun(cwd);
		await bindRun(cwd, "orc-7");
		store = [{ id: "orc-7.1", status: "in_progress", parent: "orc-7" }];
		await closeRun(cwd, "orc-7", { force: true });
		expect(await readActiveRun(cwd)).toBeNull();
		expect(listArgs).toEqual([]);
	});

	test("a pending marker closes under its sentinel without a children read", async () => {
		await activateRun(cwd);
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

describe("runStatusReport", () => {
	test("an absent marker is an inactive repository", async () => {
		const report = await runStatusReport(cwd);
		expect(report.healthy).toBe(false);
		expect(report.lines).toEqual([`no active run: ${markerPath(cwd)} is absent; /orchestrate-run activates one`]);
		expect(showSpy).not.toHaveBeenCalled();
	});

	test("a malformed marker is reported for reconciliation, not hidden", async () => {
		await seed("{broken");
		const report = await runStatusReport(cwd);
		expect(report.healthy).toBe(false);
		expect(report.lines[0]).toContain("malformed");
	});

	test("a pending marker names the bind step and its session", async () => {
		await activateRun(cwd, "session-a");
		const report = await runStatusReport(cwd);
		expect(report.healthy).toBe(false);
		expect(report.lines).toEqual([`run: pending (marker ${markerPath(cwd)}, activated by session session-a); /orchestrate-bind <epic> binds it`]);
	});

	test("a bound, open, patrolled run is healthy", async () => {
		await activateRun(cwd);
		await bindRun(cwd, "orc-7");
		epic("orc-7", "in_progress");
		const report = await runStatusReport(cwd);
		expect(report.healthy).toBe(true);
		expect(report.lines).toEqual([
			`run: bound to orc-7 (marker ${markerPath(cwd)})`,
			"epic orc-7: in_progress",
			"patrol: armed",
		]);
	});

	test.each([
		["closed", { id: "orc-7", status: "closed" }, "epic orc-7: closed; supervision is off, and /orchestrate-close orc-7 removes the marker"],
		["unverifiable", null, "epic orc-7: status could not be verified (bd unavailable or bead missing); child supervision is suspended until it can"],
		["unknown", { id: "orc-7", status: "paused" }, 'epic orc-7: status "paused" is not a run status; child supervision is suspended'],
	])("a %s epic says what supervision does about it", async (_label, shown, line) => {
		await activateRun(cwd);
		await bindRun(cwd, "orc-7");
		epics["orc-7"] = shown;
		const report = await runStatusReport(cwd);
		expect(report.healthy).toBe(false);
		expect(report.lines[1]).toBe(line);
	});

	test.each([
		["absent", "patrol: absent; /orchestrate-bind orc-7 arms it"],
		["unknown", "patrol: unknown (the linked-wisp lookup failed)"],
	] as const)("an %s patrol is not healthy", async (state, line) => {
		await activateRun(cwd);
		await bindRun(cwd, "orc-7");
		patrol = state;
		const report = await runStatusReport(cwd);
		expect(report.healthy).toBe(false);
		expect(report.lines[2]).toBe(line);
	});
});

describe("registerRunCommands", () => {
	type Handler = (args: string, ctx: unknown) => Promise<void>;

	function rig(onActivate?: (cwd: string) => Promise<unknown>) {
		const handlers = new Map<string, Handler>();
		const notices: Array<[string, string]> = [];
		const pi = {
			registerCommand: (name: string, spec: { handler: Handler }) => {
				handlers.set(name, spec.handler);
			},
		} as unknown as ExtensionAPI;
		registerRunCommands(pi, onActivate);
		const ctx = {
			sessionManager: { getCwd: () => cwd, getSessionId: () => "session-t" },
			ui: { notify: (text: string, level: string) => notices.push([level, text]) },
		};
		const command = (name: string) => {
			const handler = handlers.get(name);
			if (handler === undefined) throw new Error(`${name} not registered`);
			return (args = "") => handler(args, ctx);
		};
		return {
			registered: [...handlers.keys()],
			run: command("orchestrate-run"),
			bind: command("orchestrate-bind"),
			status: command("orchestrate-status"),
			close: command("orchestrate-close"),
			stop: command("orchestrate-stop"),
			notices,
		};
	}

	beforeEach(async () => {
		// A stub bd answers `where --json` with this checkout's `.beads`, which keeps the real
		// binary out of these tests while activation still records what bd resolved.
		await mkdir(join(cwd, ".beads"));
		const bd = join(cwd, "bd-where");
		await writeFile(bd, `#!/bin/sh\necho '{"schema_version":1,"data":{"path":"${join(cwd, ".beads")}","prefix":"orc"}}'\n`, { mode: 0o755 });
		process.env.BD_BIN = bd;
	});

	test("registers the five marker commands", () => {
		expect(rig().registered).toEqual(["orchestrate-run", "orchestrate-bind", "orchestrate-status", "orchestrate-close", "orchestrate-stop"]);
	});

	test("/orchestrate-stop is /orchestrate-close under its own name", async () => {
		const { run, bind, stop, notices } = rig();
		await run();
		await bind("orc-7");
		await stop("");
		expect(notices.at(-1)).toEqual(["error", "usage: /orchestrate-stop <epic> [--force]"]);
		await stop("orc-7");
		expect(notices.at(-1)).toEqual(["info", "orchestrate run orc-7 closed; marker removed"]);
		expect(await readActiveRun(cwd)).toBeNull();
	});

	test("/orchestrate-run calls the activation hook once, after the marker exists", async () => {
		const seen: Array<string | null> = [];
		const { run, notices } = rig(async hookCwd => {
			seen.push((await readActiveRun(hookCwd))?.run_id ?? null);
		});
		await run();
		expect(seen).toEqual(["pending"]);
		expect(notices.map(([level]) => level)).toEqual(["info"]);
	});

	test("/orchestrate-run records the located database in the marker", async () => {
		const { run } = rig();
		await run();
		expect((await readActiveRun(cwd))?.beads_dir).toBe(await fs.realpath(join(cwd, ".beads")));
	});

	test("/orchestrate-run refuses a project without a Beads workspace", async () => {
		const bd = join(cwd, "bd-no-workspace");
		await writeFile(bd, '#!/bin/sh\necho "No active beads workspace found" >&2\nexit 1\n', { mode: 0o755 });
		process.env.BD_BIN = bd;
		let calls = 0;
		const { run, notices } = rig(async () => {
			calls += 1;
		});

		await run();

		expect(await readActiveRun(cwd)).toBeNull();
		expect(calls).toBe(0);
		expect(notices).toEqual([["error", "orchestrate run NOT activated: no active Beads workspace was found"]]);
	});

	test("a failing hook is reported as a readiness failure, not a failed activation", async () => {
		const { run, notices } = rig(async () => {
			throw new Error("omp config unreadable");
		});
		await run();
		expect((await readActiveRun(cwd))?.run_id).toBe("pending");
		expect(notices.at(-1)).toEqual(["warning", "orchestrate run active; readiness check failed: omp config unreadable"]);
	});

	test("the hook does not run when activation fails", async () => {
		await seed('{"run_id":"orc-existing","schema_version":1}\n');
		const denied = Object.assign(new Error("permission denied"), { code: "EACCES" });
		const readSpy = spyOn(fs, "readFile").mockRejectedValue(denied);
		let calls = 0;
		try {
			const { run, notices } = rig(async () => {
				calls += 1;
			});
			await run();
			expect(notices.at(-1)?.[0]).toBe("error");
		} finally {
			readSpy.mockRestore();
		}
		expect(calls).toBe(0);
	});

	test("/orchestrate-bind reports an armed patrol as success", async () => {
		const { run, bind, notices } = rig();
		await run();
		await bind("orc-7");
		expect(notices.at(-1)).toEqual(["info", "orchestrate run bound to orc-7; patrol armed"]);
	});

	test("/orchestrate-bind says so, as a warning, when the patrol did not arm", async () => {
		// The bind stands and the marker is bound; what the operator was not told before is
		// that the layer covering process death is missing.
		arming = new Error("Patrol orc-7 lookup unknown; creation refused");
		const { run, bind, notices } = rig();
		await run();
		await bind("orc-7");
		expect((await readActiveRun(cwd))?.run_id).toBe("orc-7");
		expect(notices.at(-1)).toEqual([
			"warning",
			"orchestrate run bound to orc-7, but patrol arming needs architect attention: Patrol orc-7 lookup unknown; creation refused",
		]);
	});

	test("/orchestrate-bind refuses an epic Beads cannot show as open", async () => {
		const { run, bind, notices } = rig();
		await run();
		await bind("orc-typo");
		expect(notices.at(-1)).toEqual(["error", "run epic orc-typo could not be read from Beads; binding refused"]);
		expect((await readActiveRun(cwd))?.run_id).toBe("pending");
	});

	test("/orchestrate-status prints the report at the level its health warrants", async () => {
		const { run, bind, status, notices } = rig();
		await status();
		expect(notices.at(-1)).toEqual(["warning", `no active run: ${markerPath(cwd)} is absent; /orchestrate-run activates one`]);
		await run();
		await bind("orc-7");
		await status();
		expect(notices.at(-1)).toEqual(["info", `run: bound to orc-7 (marker ${markerPath(cwd)}, activated by session session-t)\nepic orc-7: open\npatrol: armed`]);
		patrol = "absent";
		await status();
		expect(notices.at(-1)?.[0]).toBe("warning");
		expect(notices.at(-1)?.[1]).toContain("patrol: absent");
	});

	test("/orchestrate-close needs exactly one id and honours --force in either position", async () => {
		const { run, bind, close, notices } = rig();
		await run();
		await bind("orc-7");
		await close("");
		expect(notices.at(-1)).toEqual(["error", "usage: /orchestrate-close <epic> [--force]"]);
		await close("orc-7 orc-8");
		expect(notices.at(-1)).toEqual(["error", "usage: /orchestrate-close <epic> [--force]"]);
		store = [{ id: "orc-7.1", status: "in_progress", parent: "orc-7" }];
		await close("orc-7");
		expect(notices.at(-1)?.[0]).toBe("error");
		expect(notices.at(-1)?.[1]).toContain("still in_progress");
		expect((await readActiveRun(cwd))?.run_id).toBe("orc-7");
		await close("--force orc-7");
		expect(notices.at(-1)).toEqual(["info", "orchestrate run orc-7 closed; marker removed"]);
		expect(await readActiveRun(cwd)).toBeNull();
	});

	test("/orchestrate-close then /orchestrate-bind starts the next run in the same repository", async () => {
		// The operator-stranding path: without close, the second bind was refused as
		// "already bound" until the marker was deleted by hand.
		const { run, bind, close, notices } = rig();
		await run();
		await bind("orc-7");
		await close("orc-7");
		await run();
		await bind("orc-2");
		expect(notices.at(-1)).toEqual(["info", "orchestrate run bound to orc-2; patrol armed"]);
		expect((await readActiveRun(cwd))?.run_id).toBe("orc-2");
	});
});
