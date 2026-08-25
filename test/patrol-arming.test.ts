/**
 * Patrol arming, with `bd` mocked rather than stubbed on disk.
 *
 * This began as a fixture that wrote an executable stub and pointed `BD_BIN` at it.
 * That fixture was silently inert on a CI runner, and three diagnoses were wrong
 * before the runner itself answered: the stub executed fine, but `bun test` runs
 * files concurrently, and `test/watchers.test.ts` clears `BD_BIN` in its own cleanup.
 * A process-global environment variable is not an injection seam when two files share
 * the process, so the subprocess is gone and the module is mocked instead -- the
 * pattern `test/exit-bounce.test.ts` already established here.
 *
 * What these tests defend: arming happens on every bind, exactly once per live
 * patrol, against the run's own repository rather than the process's.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { BdBead } from "../src/bd";
import * as actualBd from "../src/bd";

/** One recorded `bd` invocation: its argv and the directory it was aimed at. */
interface Call {
	args: string[];
	cwd: string | undefined;
}

let calls: Call[] = [];
let depList: BdBead[] = [];

// Built before `mock.module` runs, so the replacement keeps the real pure helpers.
const original = { ...actualBd };
const mocked = {
	...original,
	bdRun: async (args: string[], _timeoutMs?: number, cwd?: string) => {
		calls.push({ args, cwd });
		return { code: 0, stdout: "", stderr: "" };
	},
	bdList: async (args: string[], _timeoutMs?: number, cwd?: string) => {
		calls.push({ args, cwd });
		return depList;
	},
};

mock.module("../src/bd", () => mocked);

// Dynamic by necessity: a static import is hoisted above `mock.module`, so the
// module under test would bind the real `bd`.
const { activateRun, bindRun, readActiveRun } = await import("../src/run-state");

afterAll(() => mock.module("../src/bd", () => original));

let cwd: string;

beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), "orc-patrol-"));
	calls = [];
	depList = [];
	delete process.env.ORCHESTRATE_MARKER_FILE;
});

afterEach(async () => {
	await rm(cwd, { recursive: true, force: true });
});

/** Calls whose argv begins with the given words. */
function matching(...head: string[]): Call[] {
	return calls.filter(call => head.every((word, index) => call.args[index] === word));
}

describe("bindRun arms the patrol wisp", () => {
	test("creates one patrol, aimed at the run's repository", async () => {
		await activateRun(cwd);
		await bindRun(cwd, "orc-1");

		// The dependents query must run: it is what makes arming idempotent.
		expect(matching("dep", "list")).toHaveLength(1);
		const created = matching("create");
		expect(created).toHaveLength(1);
		expect(created[0]?.args).toContain("--wisp-type");
		expect(created[0]?.args).toContain("patrol");
		expect(created[0]?.args).toContain("relates-to:orc-1");
		// Aimed at the run, never inherited from the process: `bd` resolves its
		// database by walking up from the working directory, so an inherited cwd arms
		// the patrol in whichever repository the process happens to sit in.
		expect(created[0]?.cwd).toBe(resolve(cwd));
		expect(created[0]?.cwd).not.toBe(process.cwd());
	});

	test("an existing open patrol is not duplicated", async () => {
		depList = [{ id: "w-1", status: "open", wisp_type: "patrol" } as BdBead];
		await activateRun(cwd);
		await bindRun(cwd, "orc-1");

		expect(matching("dep", "list")).toHaveLength(1);
		expect(matching("create")).toEqual([]);
	});

	test("a closed patrol is re-armed", async () => {
		depList = [{ id: "w-1", status: "closed", wisp_type: "patrol" } as BdBead];
		await activateRun(cwd);
		await bindRun(cwd, "orc-1");

		expect(matching("create")).toHaveLength(1);
	});

	test("a linked bead that is not a patrol does not count as one", async () => {
		// Only `wisp_type: patrol` satisfies the check; any other link is unrelated
		// work and must not suppress arming.
		depList = [{ id: "w-1", status: "open", wisp_type: "escalation" } as BdBead];
		await activateRun(cwd);
		await bindRun(cwd, "orc-1");

		expect(matching("create")).toHaveLength(1);
	});

	test("rebinding the same id does not stack patrols", async () => {
		await activateRun(cwd);
		await bindRun(cwd, "orc-1");
		// The second bind sees the patrol the first one armed.
		depList = [{ id: "w-1", status: "open", wisp_type: "patrol" } as BdBead];
		await bindRun(cwd, "orc-1");

		expect(matching("create")).toHaveLength(1);
	});

	test("a refused bind arms nothing", async () => {
		await activateRun(cwd);
		await bindRun(cwd, "orc-1");
		calls = [];
		// Retargeting is refused, so the run it would have armed never exists.
		await expect(bindRun(cwd, "orc-2")).rejects.toThrow(/already bound to orc-1/);
		expect(calls).toEqual([]);
	});

	test("the marker survives a bd failure, because arming fails open", async () => {
		const failing = {
			...mocked,
			bdRun: async () => null,
			bdList: async () => {
				throw new Error("bd exploded");
			},
		};
		mock.module("../src/bd", () => failing);
		try {
			await activateRun(cwd);
			// An unarmed patrol costs a reconciliation sweep; an unbound marker costs
			// the run, so the throw must not reach the caller.
			await bindRun(cwd, "orc-1");
			expect((await readActiveRun(cwd))?.run_id).toBe("orc-1");
		} finally {
			mock.module("../src/bd", () => mocked);
		}
	});
});
