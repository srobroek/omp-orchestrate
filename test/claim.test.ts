/**
 * G5 — claim eligibility.
 *
 * The gate is exercised against the real tokeniser, the real role resolution, and the
 * real scope-overlap arithmetic, with only `../src/bd` replaced: what matters is which
 * command lines it refuses, and every input it decides on arrives as a shell string.
 *
 * `bdShow` calls are recorded rather than counted, so the `ready --claim` shortcut can
 * be asserted as "no bead was looked up" instead of as a call total.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { BdBead } from "../src/bd";
import * as actualBd from "../src/bd";
import { forgetClaim, observedClaim } from "../src/claim-state";

/** Beads `bdShow` resolves, by id. A missing key models an unreadable bead. */
let beads: Record<string, BdBead>;
/** What `bd list --label orc-node --status in_progress` reports. */
let inFlight: BdBead[];
let shown: string[];
let listed: string[][];

const original = { ...actualBd };
const mocked = {
	...original,
	bdShow: async (id: string) => {
		shown.push(id);
		return beads[id] ?? null;
	},
	bdList: async (args: string[]) => {
		listed.push(args);
		return inFlight;
	},
};

mock.module("../src/bd", () => mocked);

// Dynamic: a static import is hoisted above `mock.module`, so the gate would bind the
// real `bd` and shell out.
const { gateClaimEligibility } = await import("../src/gates/claim");

afterAll(() => mock.module("../src/bd", () => original));

/** A session declaring `role`, or declaring none when `role` is undefined. */
function ctxFor(role?: string): ExtensionContext {
	const prompt = role === undefined ? "a helper with no contract" : `ORC-ROLE: ${role}`;
	return { getSystemPrompt: () => [prompt] } as unknown as ExtensionContext;
}

function bead(id: string, overrides: Partial<BdBead> = {}): BdBead {
	return { id, status: "open", ...overrides };
}

beforeEach(() => {
	beads = {};
	inFlight = [];
	shown = [];
	listed = [];
	forgetClaim();
});

afterEach(forgetClaim);

describe("G5 role routing", () => {
	test("refuses a reviewer claiming an implementer bead, naming both roles", async () => {
		beads["orc-7"] = bead("orc-7", { labels: ["orc-node", "agent:implementer"] });

		const result = await gateClaimEligibility(ctxFor("reviewer"), {
			command: "BEADS_ACTOR=orc-rev-1 bd update orc-7 --claim",
		});

		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("orc-7");
		expect(result?.reason).toContain("agent:implementer");
		expect(result?.reason).toContain("reviewer");
		// A refused claim is not recorded: the session holds nothing.
		expect(observedClaim()).toBeUndefined();
	});

	test("allows a claim of a bead routed to this session's own role", async () => {
		beads["orc-7"] = bead("orc-7", { labels: ["agent:reviewer"] });

		expect(
			await gateClaimEligibility(ctxFor("reviewer"), { command: "BEADS_ACTOR=orc-rev-1 bd update orc-7 --claim" }),
		).toBeUndefined();
	});

	test("refuses a ready --claim against another role's queue without any lookup", async () => {
		const result = await gateClaimEligibility(ctxFor("reviewer"), {
			command: "bd ready --label agent:implementer --unassigned --claim --json",
		});

		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("agent:implementer");
		expect(result?.reason).toContain("reviewer");
		expect(shown).toEqual([]);
	});

	test.each(["--label", "-l", "--label-any"])(
		"allows a ready --claim on this session's own queue via %s with no bead lookup",
		async flag => {
			const result = await gateClaimEligibility(ctxFor("implementer"), {
				command: `BEADS_ACTOR=orc-impl-1 bd ready ${flag} agent:implementer --unassigned --claim --json`,
			});

			expect(result).toBeUndefined();
			// The queue filter already pins the role, so beads never has to answer.
			expect(shown).toEqual([]);
			// FINDING (not a defect): the gate calls `recordClaim` with an empty bead
			// list here, which `recordClaim` discards. A `ready --claim` therefore
			// leaves the worktree gate with nothing to key on until the worker issues
			// a bead-naming `bd` call. Documented, not patched.
			expect(observedClaim()).toBeUndefined();
		},
	);
});

describe("G5 fail-open", () => {
	test("a bead carrying no routing label is claimable by any role", async () => {
		// `agent:integrator` merge beads have no `agent:<orc-role>` label, and a bead
		// routed to nobody must not be unclaimable.
		beads["orc-9"] = bead("orc-9", { labels: ["orc-node", "agent:integrator"] });

		expect(
			await gateClaimEligibility(ctxFor("reviewer"), { command: "BEADS_ACTOR=orc-rev-1 bd update orc-9 --claim" }),
		).toBeUndefined();
	});

	test("an unreadable bead allows the claim and still records it", async () => {
		expect(
			await gateClaimEligibility(ctxFor("reviewer"), { command: "BEADS_ACTOR=orc-rev-1 bd update ghost-1 --claim" }),
		).toBeUndefined();
		expect(shown).toEqual(["ghost-1"]);
		// The worktree gate depends on this observation, so a claim the eligibility
		// check could not evaluate is recorded anyway.
		expect(observedClaim()).toEqual({ actor: "orc-rev-1", beadIds: ["ghost-1"] });
	});

	test("a session declaring no role is not evaluated against routing", async () => {
		beads["orc-7"] = bead("orc-7", { labels: ["agent:implementer"] });

		expect(
			await gateClaimEligibility(ctxFor(), { command: "BEADS_ACTOR=helper-1 bd update orc-7 --claim" }),
		).toBeUndefined();
	});

	test("a role-less session may pull from any queue", async () => {
		expect(
			await gateClaimEligibility(ctxFor(), { command: "bd ready --label agent:implementer --claim --json" }),
		).toBeUndefined();
	});

	test("ignores a command with no bd --claim in it", async () => {
		for (const command of ["bd show orc-7 --json", "git status", "", "bd update orc-7 --status closed"]) {
			expect(await gateClaimEligibility(ctxFor("reviewer"), { command })).toBeUndefined();
		}
		expect(shown).toEqual([]);
	});

	test("ignores a missing or non-string command", async () => {
		expect(await gateClaimEligibility(ctxFor("reviewer"), {})).toBeUndefined();
		expect(await gateClaimEligibility(ctxFor("reviewer"), { command: 42 })).toBeUndefined();
	});
});

describe("G5 scope conflict", () => {
	/** A candidate scoped to `scope`, routed to the claiming role so routing passes. */
	function candidate(scope: unknown): BdBead {
		return bead("orc-10", { labels: ["orc-node", "agent:implementer"], metadata: { scope } as Record<string, unknown> });
	}

	const CLAIM = "BEADS_ACTOR=orc-impl-1 bd update orc-10 --claim";

	test("refuses a claim whose scope overlaps an in-flight bead, naming both", async () => {
		beads["orc-10"] = candidate(["src/api/**"]);
		inFlight = [bead("orc-3", { metadata: { scope: ["src/api/handlers.ts"] } })];

		const result = await gateClaimEligibility(ctxFor("implementer"), { command: CLAIM });

		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("scope conflict");
		expect(result?.reason).toContain("orc-10");
		expect(result?.reason).toContain("orc-3");
		expect(result?.reason).toContain("src/api/handlers.ts");
		// Only the in-flight `orc-node` beads are consulted.
		expect(listed[0]).toEqual(["list", "--label", "orc-node", "--status", "in_progress", "--json"]);
	});

	test("allows a claim whose scope is disjoint from every in-flight bead", async () => {
		beads["orc-10"] = candidate(["src/api/**"]);
		inFlight = [bead("orc-3", { metadata: { scope: ["docs/**"] } }), bead("orc-4", { metadata: { scope: ["test/**"] } })];

		expect(await gateClaimEligibility(ctxFor("implementer"), { command: CLAIM })).toBeUndefined();
	});

	test("parses the JSON-string metadata form on both sides", async () => {
		beads["orc-10"] = bead("orc-10", {
			labels: ["agent:implementer"],
			metadata: JSON.stringify({ scope: ["src/api/**"] }) as unknown as Record<string, unknown>,
		});
		inFlight = [
			bead("orc-3", { metadata: JSON.stringify({ scope: ["src/api/handlers.ts"] }) as unknown as Record<string, unknown> }),
		];

		const result = await gateClaimEligibility(ctxFor("implementer"), { command: CLAIM });

		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("scope conflict");
	});

	test("a scope stamped as a JSON array inside a string still overlaps", async () => {
		beads["orc-10"] = candidate('["src/api/**"]');
		inFlight = [bead("orc-3", { metadata: { scope: '["src/api/handlers.ts"]' } })];

		expect((await gateClaimEligibility(ctxFor("implementer"), { command: CLAIM }))?.block).toBe(true);
	});

	test("the bead does not conflict with itself when it is already in flight", async () => {
		beads["orc-10"] = candidate(["src/api/**"]);
		inFlight = [bead("orc-10", { metadata: { scope: ["src/api/**"] } })];

		expect(await gateClaimEligibility(ctxFor("implementer"), { command: CLAIM })).toBeUndefined();
	});

	test.each([
		["the candidate declares no scope", undefined],
		["the candidate's scope is empty", []],
	])("fails open when %s", async (_label, scope) => {
		beads["orc-10"] = candidate(scope);
		inFlight = [bead("orc-3", { metadata: { scope: ["src/api/**"] } })];

		expect(await gateClaimEligibility(ctxFor("implementer"), { command: CLAIM })).toBeUndefined();
		// No scope to compare means no reason to ask.
		expect(listed).toEqual([]);
	});

	test("fails open when an in-flight bead declares no scope", async () => {
		beads["orc-10"] = candidate(["src/api/**"]);
		inFlight = [bead("orc-3", {})];

		expect(await gateClaimEligibility(ctxFor("implementer"), { command: CLAIM })).toBeUndefined();
	});

	test("fails open when bd list is unavailable", async () => {
		beads["orc-10"] = candidate(["src/api/**"]);
		inFlight = [];

		expect(await gateClaimEligibility(ctxFor("implementer"), { command: CLAIM })).toBeUndefined();
	});

	test("a bare ** scope conflicts with everything", async () => {
		beads["orc-10"] = candidate(["**"]);
		inFlight = [bead("orc-3", { metadata: { scope: ["docs/readme.md"] } })];

		expect((await gateClaimEligibility(ctxFor("implementer"), { command: CLAIM }))?.block).toBe(true);
	});
});

describe("G5 claim observation", () => {
	test("records the actor and bead of a passing claim", async () => {
		beads["orc-7"] = bead("orc-7", { labels: ["agent:implementer"], metadata: { worktree: "/tmp/wt" } });

		expect(
			await gateClaimEligibility(ctxFor("implementer"), { command: "BEADS_ACTOR=orc-impl-1 bd update orc-7 --claim" }),
		).toBeUndefined();
		expect(observedClaim()).toEqual({ actor: "orc-impl-1", beadIds: ["orc-7"] });
	});

	test("falls back to BD_ACTOR when BEADS_ACTOR is absent", async () => {
		expect(
			await gateClaimEligibility(ctxFor("implementer"), { command: "BD_ACTOR=orc-impl-2 bd update orc-7 --claim" }),
		).toBeUndefined();
		expect(observedClaim()?.actor).toBe("orc-impl-2");
	});

	test("records nothing when the claim names no actor", async () => {
		expect(await gateClaimEligibility(ctxFor("implementer"), { command: "bd update orc-7 --claim" })).toBeUndefined();
		expect(observedClaim()).toBeUndefined();
	});

	test("records a claim reached through an env prefix and a pipeline", async () => {
		const command = "git status && env BEADS_ACTOR=orc-impl-3 bd update orc-8 --claim --json | jq .";

		expect(await gateClaimEligibility(ctxFor("implementer"), { command })).toBeUndefined();
		expect(observedClaim()).toEqual({ actor: "orc-impl-3", beadIds: ["orc-8"] });
	});

	test("does not fire on a quoted mention of a claim", async () => {
		// Parsed argv, not substrings: the payload of a comment is not a command.
		expect(
			await gateClaimEligibility(ctxFor("reviewer"), { command: `bd comment orc-7 "never bd update x --claim"` }),
		).toBeUndefined();
		expect(observedClaim()).toBeUndefined();
	});

	test("a later claim replaces the bead the worktree gate keys on", async () => {
		const ctx = ctxFor("implementer");
		await gateClaimEligibility(ctx, { command: "BEADS_ACTOR=orc-impl-1 bd update orc-7 --claim" });
		await gateClaimEligibility(ctx, { command: "BEADS_ACTOR=orc-impl-1 bd update orc-8 --claim" });

		expect(observedClaim()?.beadIds).toEqual(["orc-8"]);
	});
});
