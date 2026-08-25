import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile, mkdir } from "node:fs/promises";
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
	test("a fresh repository activates as pending, naming its own root", async () => {
		const state = await activateRun(cwd, "session-a");
		// `repo_root` is resolved, so a worker reading a copy of this marker still
		// finds the original checkout rather than its clone.
		expect(state).toEqual({
			schema_version: 1,
			run_id: "pending",
			session_id: "session-a",
			repo_root: resolve(cwd),
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
			repo_root: resolve(cwd),
		});
	});

	test("leaves no temporary file behind", async () => {
		await activateRun(cwd, "session-a");
		await bindRun(cwd, "orc-1");
		expect((await readdir(join(cwd, ".orchestration"))).filter(name => name.endsWith(".tmp"))).toEqual([]);
	});

	test("writes marker keys in sorted order", async () => {
		await activateRun(cwd, "session-a");
		const root = resolve(cwd);
		expect(await readFile(markerPath(cwd), "utf8")).toBe(
			`{"repo_root":${JSON.stringify(root)},"run_id":"pending","schema_version":1,"session_id":"session-a"}\n`,
		);
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

/**
 * `bindRun` arms the S2 patrol, so it shells out to `bd`. These tests replace the
 * binary with a script that records argv and its own working directory, which is the
 * only way to observe the bug this covers: `bd` resolves its database by walking up
 * from the working directory, so a patrol armed in the process's cwd instead of the
 * run's lands in a different repository's beads -- silently, because arming fails
 * open by design.
 */
describe("bindRun arms the patrol wisp", () => {
	let bin: string;
	let log: string;
	let stubDir: string;
	let probe = 0;

	/**
	 * Install a stub `bd` that records every invocation and answers `dep list` with
	 * `depJson`. The ledger is unique per test: a shared path let one test read
	 * another's calls, which is how a Linux runner reported six `create`s.
	 *
	 * The stub lives under the repository rather than the temp directory it drives.
	 * A runner whose temp filesystem is mounted `noexec` cannot execute a script
	 * there, and `bdRun` swallows a spawn failure by design, so the whole fixture
	 * went silently inert and every "no create" expectation passed vacuously. The
	 * repository checkout is executable by construction, since the test runner itself
	 * was loaded from it.
	 */
	async function writeStub(depJson: string): Promise<void> {
		await writeFile(
			bin,
			`#!/bin/sh\nprintf '%s\\t%s\\n' "$(pwd)" "$*" >> ${JSON.stringify(log)}\nif [ "$1" = "dep" ]; then printf '${depJson}'; fi\n`,
			{ mode: 0o755 },
		);
	}

	beforeEach(async () => {
		probe += 1;
		stubDir = await mkdtemp(join(process.cwd(), ".stub-"));
		log = join(stubDir, `bd-calls-${probe}.log`);
		bin = join(stubDir, `fake-bd-${probe}`);
		// `pwd` is the assertion: it reports where the child was spawned, not where
		// the parent happens to be. An empty dep list makes every run arm once.
		await writeStub("[]");
		process.env.BD_BIN = bin;
	});

	afterEach(async () => {
		delete process.env.BD_BIN;
		await rm(stubDir, { recursive: true, force: true });
	});

	async function calls(): Promise<{ cwd: string; args: string }[]> {
		const body = await readFile(log, "utf8").catch(() => "");
		return body
			.split("\n")
			.filter(line => line.length > 0)
			.map(line => {
				const [dir, args] = line.split("\t");
				return { cwd: dir ?? "", args: args ?? "" };
			});
	}

	/**
	 * Every arming path must consult the dependents query exactly once. Asserting it
	 * keeps the "no create" expectations from passing vacuously when the stub never
	 * ran at all -- the failure mode that hid a real defect from this suite.
	 */
	async function assertProbed(): Promise<{ cwd: string; args: string }[]> {
		const seen = await calls();
		expect(seen.filter(call => call.args.startsWith("dep list "))).toHaveLength(1);
		return seen;
	}

	test("creates one patrol, in the run's repository rather than the process's", async () => {
		await activateRun(cwd);
		await bindRun(cwd, "orc-1");
		const created = (await assertProbed()).filter(call => call.args.startsWith("create "));
		expect(created).toHaveLength(1);
		expect(created[0]?.args).toContain("--wisp-type patrol");
		expect(created[0]?.args).toContain("--deps relates-to:orc-1");
		// The fixture's cwd, never `process.cwd()`, which is the repository under test.
		expect(created[0]?.cwd).toBe(await realpath(cwd));
		expect(created[0]?.cwd).not.toBe(process.cwd());
	});

	test("an existing open patrol is not duplicated", async () => {
		// A dep list naming a live patrol must short-circuit arming entirely.
		await writeStub('[{"id":"w-1","status":"open","wisp_type":"patrol"}]');
		await activateRun(cwd);
		await bindRun(cwd, "orc-1");
		expect((await assertProbed()).filter(call => call.args.startsWith("create "))).toEqual([]);
	});

	test("consults the dependents query even when the turn's read budget is spent", async () => {
		// The real defect a CI runner exposed. `bd.ts` caps reads per dispatch and only
		// the `tool_call` handler resets the counter, so `/orchestrate-bind` arriving
		// after twelve gated reads in the same turn found the budget spent. `bdList`
		// then returns WITHOUT spawning, so the existence check reports "none linked".
		//
		// The consequence is not a missing patrol -- `bdRun`'s create is not budgeted,
		// so one is still armed -- it is a DUPLICATE one, because the check that would
		// have found the live patrol never ran. Asserting the dependents query fires is
		// therefore the assertion that matters; asserting a create would pass either way.
		await writeStub('[{"id":"w-1","status":"open","wisp_type":"patrol"}]');
		for (let spent = 0; spent < 15; spent += 1) await bdList(["show", "orc-1", "--json"]);
		await activateRun(cwd);
		await bindRun(cwd, "orc-1");
		const seen = await assertProbed();
		// And with the query restored, the live patrol is still not duplicated.
		expect(seen.filter(call => call.args.startsWith("create "))).toEqual([]);
	});

	test("a closed patrol is re-armed", async () => {
		await writeStub('[{"id":"w-1","status":"closed","wisp_type":"patrol"}]');
		await activateRun(cwd);
		await bindRun(cwd, "orc-1");
		expect((await assertProbed()).filter(call => call.args.startsWith("create "))).toHaveLength(1);
	});

	test("a failing bd does not fail the bind", async () => {
		await activateRun(cwd);
		await writeFile(bin, "#!/bin/sh\nexit 3\n", { mode: 0o755 });
		await bindRun(cwd, "orc-1");
		// The marker is the thing that must survive: an unarmed patrol costs a sweep,
		// an unbound marker costs the run.
		expect((await readActiveRun(cwd))?.run_id).toBe("orc-1");
	});
});
