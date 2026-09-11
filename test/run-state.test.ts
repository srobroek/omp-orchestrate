import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs, { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as supervision from "../src/supervision";
import * as bd from "../src/bd";
import { execFileSync } from "node:child_process";
import { activateRun, bindRun, isBoundRunActive, markerPath, mkdirRunState, readActiveRun, registerRunCommands } from "../src/run-state";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const patrolSpy = spyOn(supervision, "ensurePatrolWisp").mockResolvedValue(undefined);
afterAll(() => patrolSpy.mockRestore());

let cwd: string;

beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), "orc-run-state-"));
	delete process.env.ORCHESTRATE_MARKER_FILE;
	delete process.env.BD_BIN;
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

describe("mkdirRunState", () => {
	test("writes a self-ignoring .gitignore at the .orchestration root", async () => {
		// Run state lands in the ORCHESTRATED repository, so without this every
		// project acquires an untracked .orchestration/ that shows in git status
		// for every actor.
		await mkdirRunState(join(cwd, ".orchestration", "audit"), cwd);
		const body = await readFile(join(cwd, ".orchestration", ".gitignore"), "utf8");
		expect(body).toContain("*");
		expect(body).toContain("omp-orchestrate");
	});

	test("git then reports nothing untracked for the tree", async () => {
		// The behaviour that matters, asserted through git rather than inferred
		// from the file's contents.
		execFileSync("git", ["init", "-q"], { cwd });
		await mkdirRunState(join(cwd, ".orchestration", "audit"), cwd);
		await writeFile(join(cwd, ".orchestration", "audit", "Child.bdlog"), "{}\n", "utf8");
		const status = execFileSync("git", ["status", "--porcelain=v1"], { cwd, encoding: "utf8" });
		expect(status.trim()).toBe("");
	});

	test("never clobbers a rule someone tuned by hand", async () => {
		await mkdir(join(cwd, ".orchestration"), { recursive: true });
		await writeFile(join(cwd, ".orchestration", ".gitignore"), "audit/\n", "utf8");
		await mkdirRunState(join(cwd, ".orchestration", "audit"), cwd);
		expect(await readFile(join(cwd, ".orchestration", ".gitignore"), "utf8")).toBe("audit/\n");
	});

	test("leaves a redirected directory alone, even one named .orchestration", async () => {
		// ORCHESTRATE_MARKER_FILE and ORCHESTRATE_AUDIT_DIR can point anywhere. The
		// root is cwd's own .orchestration, so a redirected path gets nothing --
		// including a path that merely contains the name, which an ancestor scan
		// would have claimed.
		await mkdirRunState(join(cwd, "somewhere", "audit"), cwd);
		expect(await readdir(join(cwd, "somewhere"))).toEqual(["audit"]);

		const lookalike = join(cwd, "elsewhere", ".orchestration", "audit");
		await mkdirRunState(lookalike, cwd);
		expect(await readdir(join(cwd, "elsewhere", ".orchestration"))).toEqual(["audit"]);
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

	test.each(["", "{broken", "[]", '{"schema_version":1}', '{"run_id":false}', '{"run_id":"orc-existing","schema_version":2}'])(
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
		const show = spyOn(bd, "bdShow").mockResolvedValue(null);
		try {
			expect(await isBoundRunActive(cwd)).toBe(false);
			await seed('{"schema_version": 1, "run_id": "pending"}');
			expect(await isBoundRunActive(cwd)).toBe(false);
			expect(show).not.toHaveBeenCalled();
		} finally {
			show.mockRestore();
		}
	});

	test("requires a known run status and passes the repository cwd", async () => {
		await seed('{"schema_version": 1, "run_id": "orc-7"}');
		const show = spyOn(bd, "bdShow").mockResolvedValue({ id: "orc-7", status: "open" });
		try {
			for (const status of ["open", "in_progress", "blocked", "deferred"]) {
				show.mockResolvedValue({ id: "orc-7", status });
				expect(await isBoundRunActive(cwd)).toBe(true);
			}
			expect(show).toHaveBeenCalledWith("orc-7", undefined, cwd);
			show.mockResolvedValue({ id: "orc-7", status: "closed" });
			expect(await isBoundRunActive(cwd)).toBe(false);
		} finally {
			show.mockRestore();
		}
	});

	test.each([
		[null, "status could not be verified"],
		[{ id: "orc-7" }, "status could not be verified"],
		[{ id: "orc-7", status: "paused" }, "unknown status"],
	])("throws when run evidence is unavailable or unknown: %j", async (run, reason) => {
		await seed('{"schema_version": 1, "run_id": "orc-7"}');
		const show = spyOn(bd, "bdShow").mockResolvedValue(run as { id: string; status?: string } | null);
		try {
			await expect(isBoundRunActive(cwd)).rejects.toThrow(reason);
		} finally {
			show.mockRestore();
		}
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
		const run = handlers.get("orchestrate-run");
		if (run === undefined) throw new Error("orchestrate-run not registered");
		return { run: () => run("", ctx), notices };
	}

	beforeEach(() => {
		// An inherited pin is accepted as-is, which keeps bd out of these tests.
		process.env.BEADS_DIR = join(cwd, ".beads");
	});
	afterEach(() => {
		delete process.env.BEADS_DIR;
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

	test("/orchestrate-run refuses a project without a Beads workspace", async () => {
		delete process.env.BEADS_DIR;
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
});
