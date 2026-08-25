import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { bdList } from "../src/bd";
import { activateRun, bindRun, isRunActive, markerPath, readActiveRun, registerRunCommands } from "../src/run-state";

let cwd: string;

beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), "orc-run-state-"));
	delete process.env.ORCHESTRATE_MARKER_FILE;
	delete process.env.ORCHESTRATE_RUN;
});

afterEach(async () => {
	delete process.env.ORCHESTRATE_MARKER_FILE;
	delete process.env.ORCHESTRATE_RUN;
	await rm(cwd, { recursive: true, force: true });
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

	test("writes marker keys in sorted order", async () => {
		await activateRun(cwd, "session-a");
		expect(await readFile(markerPath(cwd), "utf8")).toBe(
			`{"run_id":"pending","schema_version":1,"session_id":"session-a"}\n`,
		);
	});

	test("a marker from before the pin was retired still reads, without its dead field", async () => {
		// `repo_root` was written for the `bd -C` substitution and is read by nothing.
		// Removing it from the type must not strand a run activated by an older build:
		// the field is dropped on read rather than rejected, and re-activation stops
		// writing it.
		await seed(`{"repo_root":${JSON.stringify(resolve(cwd))},"run_id":"orc-9","schema_version":1}\n`);
		expect(await readActiveRun(cwd)).toEqual({ schema_version: 1, run_id: "orc-9" });
		expect(await activateRun(cwd)).toEqual({ schema_version: 1, run_id: "orc-9" });
		expect(await readFile(markerPath(cwd), "utf8")).toBe(`{"run_id":"orc-9","schema_version":1}\n`);
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

describe("bindRun", () => {
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
});

describe("isRunActive", () => {
	test("false in a repository with no marker", async () => {
		expect(await isRunActive(cwd)).toBe(false);
	});

	test("true once a marker exists", async () => {
		await activateRun(cwd);
		expect(await isRunActive(cwd)).toBe(true);
	});

	test("ORCHESTRATE_RUN arms the protocol without a marker", async () => {
		process.env.ORCHESTRATE_RUN = "1";
		expect(await isRunActive(cwd)).toBe(true);
	});

	test("an empty ORCHESTRATE_RUN does not arm it", async () => {
		process.env.ORCHESTRATE_RUN = "";
		expect(await isRunActive(cwd)).toBe(false);
	});

	test("a directory at the marker path does not count", async () => {
		await mkdir(join(cwd, ".orchestration", ".active-run"), { recursive: true });
		expect(await isRunActive(cwd)).toBe(false);
	});
});

describe("registerRunCommands", () => {
	test("registers nothing at import time and both commands when called", () => {
		const registered: string[] = [];
		const pi = { registerCommand: (name: string) => registered.push(name) } as unknown as ExtensionAPI;
		expect(registered).toEqual([]);
		registerRunCommands(pi);
		// orchestrate-status belongs to the entry point; registering it twice would
		// collide.
		expect(registered).toEqual(["orchestrate-run", "orchestrate-bind"]);
	});
});
