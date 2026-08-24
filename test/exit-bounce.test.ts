/**
 * The bounce budget in `gateExitContract` is the one path in this plugin that
 * mutates a bead, so it is exercised against the real evaluator with only `../src/bd`
 * replaced. The mock records argv rather than call counts: the contract with `bd` is
 * the command line, and asserting on counts would fail on a harmless extra read.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { BdBead, BdComment } from "../src/bd";
import * as actualBd from "../src/bd";
import { forgetClaim, recordClaim } from "../src/claim-state";
import implementer from "../src/contracts/implementer.json";

/** Reads the evaluator performs, swapped per scenario. */
interface Reads {
	bead: BdBead | null;
	comments: BdComment[];
	linked: string[];
}

let reads: Reads;
let issued: string[][];

// Built before `mock.module` runs, so the replacement namespace keeps the real pure
// helpers (`metadataString`, `commentVerb`) instead of the mock's own bindings.
const original = { ...actualBd };
const mocked = {
	...original,
	bdShow: async () => reads.bead,
	bdList: async () => [],
	bdComments: async () => reads.comments,
	bdLinked: async () => reads.linked,
	bdRun: async (args: string[]) => {
		issued.push(args);
		return { code: 0, stdout: "", stderr: "" };
	},
};

mock.module("../src/bd", () => mocked);

// Dynamic by necessity: a static import is hoisted above `mock.module`, so the
// evaluator would bind the real `bd` and shell out during the test.
const { gateExitContract, resetUnclaimedReminder } = await import("../src/gates/exit");

// Restore, so a mock scoped to this file cannot leak into test/bd.test.ts.
afterAll(() => mock.module("../src/bd", () => original));

const BEAD = "orc-42";
const MAX_ATTEMPTS = implementer.bounce.max_attempts;
const CTX = { getSystemPrompt: () => ["ORC-ROLE: implementer"] } as unknown as ExtensionContext;

/**
 * A claimed implementer bead that fails its git contract outright: no branch, no
 * push, no reviewer handoff, still assigned, and no REPORTED comment.
 */
function failingBead(overrides: Partial<BdBead> = {}): BdBead {
	const { metadata, ...rest } = overrides;
	return {
		id: BEAD,
		status: "in_progress",
		assignee: "orc-impl-1",
		labels: ["agent:implementer"],
		metadata: { worktree: "/tmp/wt", ...metadata },
		...rest,
	};
}

/** The `--metadata` payload of an issued argv, parsed. */
function metadataPayload(args: string[] | undefined): unknown {
	const at = args?.indexOf("--metadata") ?? -1;
	expect(at).toBeGreaterThan(-1);
	return JSON.parse(args?.[at + 1] ?? "");
}

beforeEach(() => {
	issued = [];
	reads = { bead: failingBead(), comments: [], linked: [] };
	recordClaim({ actor: "orc-impl-1", beadIds: [BEAD] });
});

afterEach(forgetClaim);

describe("G4 bounce budget", () => {
	test("the role contract still sets the cap this suite assumes", () => {
		expect(MAX_ATTEMPTS).toBe(3);
	});

	test.each([
		["absent", undefined, 1],
		["0", "0", 1],
		["1", "1", 2],
	])("blocks below the cap with stop_attempts %s", async (_label, stored, attempt) => {
		reads.bead = failingBead({ metadata: stored === undefined ? {} : { stop_attempts: stored } });

		const result = await gateExitContract(CTX);

		expect(result?.block).toBe(true);
		const reason = JSON.parse(result?.reason ?? "") as {
			bead: string;
			agent: string;
			attempt: number;
			failed_checks: { check: string; detail: string }[];
		};
		expect(reason.bead).toBe(BEAD);
		expect(reason.agent).toBe("implementer");
		expect(reason.attempt).toBe(attempt);
		// Every git-gated check plus the REPORTED comment is unmet, and each failure
		// names the predicate the worker has to satisfy.
		expect(reason.failed_checks.map(failure => failure.check).sort()).toEqual([
			"branch",
			"delivery",
			"handoff",
			"reported",
			"unclaimed",
		]);
		expect(reason.failed_checks.every(failure => failure.detail.startsWith("unsatisfied: "))).toBe(true);

		// The only mutation below the cap is the incremented attempt counter: the
		// bead stays claimed so the same worker can correct and retry.
		expect(issued.map(args => args[0])).toEqual(["update"]);
		expect(issued[0]?.slice(0, 2)).toEqual(["update", BEAD]);
		expect(metadataPayload(issued[0])).toEqual({ stop_attempts: attempt });
	});

	test("releases the bead and allows the exit at the cap", async () => {
		reads.bead = failingBead({ metadata: { stop_attempts: String(MAX_ATTEMPTS - 1) } });

		const result = await gateExitContract(CTX);

		// ALLOW: a worker must not be trapped against a contract it cannot satisfy.
		expect(result).toBeUndefined();
		expect(issued.map(args => args[0])).toEqual(["comment", "update"]);

		const comment = issued[0] ?? [];
		expect(comment.slice(0, 2)).toEqual(["comment", BEAD]);
		expect(comment[2]).toStartWith("BOUNCE ");
		expect(comment[2]).toContain("agent=implementer");
		expect(comment[2]).toContain(`attempt=${MAX_ATTEMPTS}`);

		const update = issued[1] ?? [];
		expect(update.slice(0, 2)).toEqual(["update", BEAD]);
		// The claim is dropped and the bead re-queued for redispatch.
		expect(update[update.indexOf("--assignee") + 1]).toBe("");
		expect(update[update.indexOf("--status") + 1]).toBe("open");
		expect(metadataPayload(update)).toEqual({ stop_attempts: 0, review_round: 0 });
	});

	test("reopens a closed bead before releasing it", async () => {
		// `closed` is also a denied state for this role, so the exit fails the
		// authority check too; the bounce still has to leave the bead workable.
		reads.bead = failingBead({ status: "closed", metadata: { stop_attempts: String(MAX_ATTEMPTS - 1) } });

		const result = await gateExitContract(CTX);

		expect(result).toBeUndefined();
		// Order matters: the audit comment lands first, and the reopen precedes the
		// update so `--status open` is not applied to a closed bead.
		expect(issued.map(args => args[0])).toEqual(["comment", "reopen", "update"]);
		expect(issued[1]).toEqual(["reopen", BEAD, "--reason", "contract bounce"]);
	});

	test("an evaluation past the cap resets rather than re-incrementing", async () => {
		reads.bead = failingBead({ metadata: { stop_attempts: String(MAX_ATTEMPTS + 5) } });

		expect(await gateExitContract(CTX)).toBeUndefined();
		expect(metadataPayload(issued.at(-1))).toEqual({ stop_attempts: 0, review_round: 0 });
	});
});

describe("G4 fail-open", () => {
	test("an unreadable bead allows the exit and mutates nothing", async () => {
		reads = { bead: null, comments: [], linked: [] };

		expect(await gateExitContract(CTX)).toBeUndefined();
		expect(issued).toEqual([]);
	});

	test("no observed claim still mutates nothing, but is no longer a free exit", async () => {
		// Superseded deliberately: this asserted that an unclaimed worker exits
		// silently, which an adversarial run showed loses the work. It now takes one
		// reminder, and still touches no bead -- there is none to touch.
		forgetClaim();
		resetUnclaimedReminder();

		expect((await gateExitContract(CTX))?.block).toBe(true);
		expect(issued).toEqual([]);
	});
});

describe("G4 escape hatch", () => {
	test.each(["FAILED", "BLOCKED"])("%s on a blocked bead exits without a bounce", async verb => {
		reads.bead = failingBead({ status: implementer.escape.state, metadata: { stop_attempts: "1" } });
		reads.comments = [{ text: `${verb}: toolchain missing, cannot build` }];

		expect(await gateExitContract(CTX)).toBeUndefined();
		// No increment: a declared failure is a valid exit, not a contract breach.
		expect(issued).toEqual([]);
	});

	test("a blocked bead with no declaring comment still bounces", async () => {
		reads.bead = failingBead({ status: implementer.escape.state, metadata: { stop_attempts: "1" } });
		reads.comments = [{ text: "note: went quiet" }];

		const result = await gateExitContract(CTX);

		expect(result?.block).toBe(true);
		expect(metadataPayload(issued[0])).toEqual({ stop_attempts: 2 });
	});
});

/**
 * The hole an adversarial run found: a worker told "there are no beads, invent your
 * own task list" wrote code, claimed nothing, and exited `completed`. With no claim
 * there is no bead to evaluate and no id to name a captured branch, so the work was
 * lost while the run recorded a healthy child.
 */
describe("G4 unclaimed exit", () => {
	beforeEach(() => {
		forgetClaim();
		resetUnclaimedReminder();
	});

	test("a role-marked worker holding no claim is refused once", async () => {
		const result = await gateExitContract(CTX, { result: { data: "wrote src/greet.ts, all done" } });

		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("without ever claiming a bead");
		// Nothing to mutate: there is no bead to carry a bounce counter.
		expect(issued).toEqual([]);
	});

	test("the refusal never repeats, so a revived worker cannot be trapped", async () => {
		// A worker revived after a crash holds a claim this process never observed.
		expect((await gateExitContract(CTX, { result: { data: "done" } }))?.block).toBe(true);
		expect(await gateExitContract(CTX, { result: { data: "done" } })).toBeUndefined();
	});

	test("a declared NO_WORK exit is allowed immediately", async () => {
		expect(await gateExitContract(CTX, { result: { data: "NO_WORK: implementer queue is empty" } })).toBeUndefined();
	});

	test("a contract-free session is not asked to claim anything", async () => {
		// No ORC-ROLE marker: an architect helper or a bundled spawn, neither of
		// which pulls work, so insisting on a claim would break both.
		const helper = { getSystemPrompt: () => ["you are a helpful assistant"] } as unknown as ExtensionContext;
		expect(await gateExitContract(helper, { result: { data: "done" } })).toBeUndefined();
	});

	test("a yield with no payload still gets the reminder", async () => {
		expect((await gateExitContract(CTX))?.block).toBe(true);
	});
});
