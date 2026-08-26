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
	test("a bead carrying no routing carrier is claimable by any role", async () => {
		// Neither a `metadata.role` stamp nor a legacy `agent:<role>` label, so the bead
		// routes to nobody, and a bead routed to nobody must not be unclaimable.
		beads["orc-9"] = bead("orc-9", { labels: ["orc-node", "kind:incidental"] });

		expect(
			await gateClaimEligibility(ctxFor("reviewer"), { command: "BEADS_ACTOR=orc-rev-1 bd update orc-9 --claim" }),
		).toBeUndefined();
	});

	test("a legacy agent:integrator bead now routes to the shepherd", async () => {
		// It used to route to nobody, which meant any role could claim a merge bead named
		// by id. Resolving it is a hole closed, not fail-open behaviour lost.
		beads["orc-9"] = bead("orc-9", { labels: ["orc-node", "agent:integrator"] });

		const result = await gateClaimEligibility(ctxFor("reviewer"), {
			command: "BEADS_ACTOR=orc-rev-1 bd update orc-9 --claim",
		});

		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("agent:integrator");
		expect(
			await gateClaimEligibility(ctxFor("shepherd"), { command: "BEADS_ACTOR=orc-shep-1 bd update orc-9 --claim" }),
		).toBeUndefined();
	});

	test("an unreadable bead allows the claim, and records nothing", async () => {
		expect(
			await gateClaimEligibility(ctxFor("reviewer"), { command: "BEADS_ACTOR=orc-rev-1 bd update ghost-1 --claim" }),
		).toBeUndefined();
		expect(shown).toEqual(["ghost-1"]);
		// It used to record here, reasoning that the worktree gate needed the observation
		// even from a claim it could not evaluate. That recorded a bead the call had not
		// yet acquired. The claim report arms G2 now, so a failing claim arms nothing.
		expect(observedClaim()).toBeUndefined();
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

/**
 * G5 no longer records the claim, and these pin that.
 *
 * It used to record from the command, which was wrong in both directions: a queue pull
 * names no bead, and a named claim's outcome is unknown before it runs, so a race loser
 * recorded a bead it never held. Recording moved to the claim report -- see
 * `test/claim-observer.test.ts`, which owns the positive cases.
 *
 * The block this replaces asserted the old behaviour, including one case that pinned a
 * pipeline as a legitimate recording path. That was the bypass: a trailing command can
 * make the shell exit 0 while the claim failed.
 */
describe("G5 records nothing", () => {
	test("a passing named claim is allowed and not recorded", async () => {
		beads["orc-7"] = bead("orc-7", { labels: ["agent:implementer"], metadata: { worktree: "/tmp/wt" } });

		expect(
			await gateClaimEligibility(ctxFor("implementer"), { command: "BEADS_ACTOR=orc-impl-1 bd update orc-7 --claim" }),
		).toBeUndefined();
		expect(observedClaim()).toBeUndefined();
	});

	test("a queue claim is allowed and not recorded", async () => {
		expect(
			await gateClaimEligibility(ctxFor("implementer"), {
				command: "bd ready --metadata-field role=implementer --unassigned --claim --json",
			}),
		).toBeUndefined();
		expect(observedClaim()).toBeUndefined();
	});

	test("a claim inside a pipeline is allowed and not recorded", async () => {
		const command = "git status && env BEADS_ACTOR=orc-impl-3 bd update orc-8 --claim --json | jq .";

		expect(await gateClaimEligibility(ctxFor("implementer"), { command })).toBeUndefined();
		expect(observedClaim()).toBeUndefined();
	});

	test("does not fire on a quoted mention of a claim", async () => {
		// Parsed argv, not substrings: the payload of a comment is not a command.
		expect(
			await gateClaimEligibility(ctxFor("reviewer"), { command: `bd comment orc-7 "never bd update x --claim"` }),
		).toBeUndefined();
		expect(observedClaim()).toBeUndefined();
	});
});

/**
 * Routing reads `metadata.role` first and a legacy `agent:<role>` label second. The
 * refusal quotes the carrier verbatim, so a message naming `role=implementer` and one
 * naming `agent:implementer` are the two carriers reporting themselves.
 */
describe("G5 routing reads metadata", () => {
	test("refuses a reviewer claiming a metadata-routed implementer bead", async () => {
		beads["orc-7"] = bead("orc-7", { metadata: { role: "implementer" } });

		const result = await gateClaimEligibility(ctxFor("reviewer"), {
			command: "BEADS_ACTOR=orc-rev-1 bd -C /run/repo update orc-7 --claim",
		});

		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("role=implementer");
		expect(observedClaim()).toBeUndefined();
	});

	test("allows the role the metadata names", async () => {
		beads["orc-7"] = bead("orc-7", { metadata: { role: "implementer", worktree: "/tmp/wt" } });

		expect(
			await gateClaimEligibility(ctxFor("implementer"), {
				command: "BEADS_ACTOR=orc-impl-1 bd -C /run/repo update orc-7 --claim",
			}),
		).toBeUndefined();
		// Recording is the observer's job now, so this asserts acceptance only.
	});

	test("refuses a pull against another role's metadata queue without reading a bead", async () => {
		const result = await gateClaimEligibility(ctxFor("reviewer"), {
			command: "bd -C /run/repo ready --metadata-field role=implementer --unassigned --claim --json",
		});

		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("role=implementer");
		expect(shown).toEqual([]);
	});

	test("allows the canonical pull for this session's own queue", async () => {
		expect(
			await gateClaimEligibility(ctxFor("implementer"), {
				command:
					"BEADS_ACTOR=orc-impl-1 bd -C /run/repo ready --parent orc-1 --metadata-field role=implementer --unassigned --claim --json",
			}),
		).toBeUndefined();
	});

	test("the legacy integrator queue belongs to the shepherd", async () => {
		// It resolved to no role before, so this pull was refused for naming a queue that
		// could never equal the session's declared role.
		expect(
			await gateClaimEligibility(ctxFor("shepherd"), {
				command: "BEADS_ACTOR=orc-shep-1 bd -C /run/repo ready --label agent:integrator --unassigned --claim --json",
			}),
		).toBeUndefined();
	});

	test("a merge bead is refused to a non-shepherd", async () => {
		// `pr:merge` classifies, `role=shepherd` routes. Before the move the merge bead
		// resolved to nobody and any role could claim it by id.
		beads["orc-m"] = bead("orc-m", { labels: ["pr:merge"], metadata: { role: "shepherd" } });

		const result = await gateClaimEligibility(ctxFor("implementer"), {
			command: "BEADS_ACTOR=orc-impl-1 bd -C /run/repo update orc-m --claim",
		});

		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("role=shepherd");
	});

	test("a handoff label does not re-route the node it marks", async () => {
		// The reported state of every implementer node: routing still names the owner
		// while `agent:reviewer` signals that review is owed. A label-first resolver
		// refused the owner its own bead.
		beads["orc-7"] = bead("orc-7", {
			labels: ["orc-node", "agent:reviewer"],
			metadata: { role: "implementer", worktree: "/tmp/wt" },
		});

		expect(
			await gateClaimEligibility(ctxFor("implementer"), {
				command: "BEADS_ACTOR=orc-impl-1 bd -C /run/repo update orc-7 --claim",
			}),
		).toBeUndefined();
	});
});

/**
 * Routing authority, enforced where the write happens rather than at the exit.
 *
 * `deny_metadata` cannot carry this: it is a presence test on the claimed bead, and
 * routing metadata is present on every routed bead. So the authority is a table in the
 * gate, and these are the tests that keep it honest.
 */
describe("G5 routing authority", () => {
	const REPOINT = "bd -C /run/repo update orc-7 --set-metadata role=reviewer";

	test.each(["implementer", "researcher", "reviewer", "shepherd"])(
		"%s may not re-point a route",
		async role => {
			const result = await gateClaimEligibility(ctxFor(role), { command: REPOINT });

			expect(result?.block).toBe(true);
			expect(result?.reason).toContain("metadata.role");
			expect(result?.reason).toContain(role);
		},
	);

	test("the architect may, because it routes the epic it decomposed", async () => {
		expect(await gateClaimEligibility(ctxFor("architect"), { command: REPOINT })).toBeUndefined();
	});

	test("a session declaring no role is not checked", async () => {
		// The lead routes the whole DAG, and a contract-free helper is already behind
		// BD_READONLY=1, so it cannot write a bead at all.
		expect(await gateClaimEligibility(ctxFor(), { command: REPOINT })).toBeUndefined();
	});

	test("clearing a route counts as re-pointing it", async () => {
		// A bead with no route reaches no queue, which strands it as surely as a wrong one.
		const result = await gateClaimEligibility(ctxFor("implementer"), {
			command: "bd -C /run/repo update orc-7 --unset-metadata role",
		});

		expect(result?.block).toBe(true);
	});

	test("filing new work routed is allowed", async () => {
		// An unrouted bug bead reaches no queue and then fails close-out as stranded, and
		// a bead that does not exist yet has no route to steal.
		expect(
			await gateClaimEligibility(ctxFor("implementer"), {
				command: `bd -C /run/repo create "flaky retry path" --type bug --metadata '{"role":"implementer"}'`,
			}),
		).toBeUndefined();
	});

	test("a refused re-point records no claim", async () => {
		// The denial runs before the claim walk, so a blocked command cannot leave the
		// worktree gate keyed on a bead this session never took.
		beads["orc-7"] = bead("orc-7", { metadata: { role: "implementer" } });

		const result = await gateClaimEligibility(ctxFor("implementer"), {
			command: "BEADS_ACTOR=orc-impl-1 bd -C /run/repo update orc-7 --claim --set-metadata role=reviewer",
		});

		expect(result?.block).toBe(true);
		expect(observedClaim()).toBeUndefined();
	});
});

/**
 * The matcher corpus.
 *
 * Command-text matching has failed twice in this repo: two nag rules were dead because
 * they matched a bare `bd <verb>` and never the pinned `bd -C <repo> <verb>` spelling
 * every call actually uses, and a verb guard fired on a `grep` that merely quoted the
 * text. Both failures are invisible without a corpus, so the counts are asserted rather
 * than assured.
 */
const PINS = ["", "-C /run/repo ", "--directory /run/repo ", "--directory=/run/repo "];

/** Every spelling that writes or clears `metadata.role`. */
const ROUTING_WRITES = [
	"--set-metadata role=reviewer",
	"--set-metadata=role=reviewer",
	"--unset-metadata role",
	"--metadata role=reviewer",
	"--metadata=role=reviewer",
	`--metadata '{"role":"reviewer"}'`,
	`--metadata '{"role": "reviewer"}'`,
];

/** Metadata writes naming any other key. The `role` prefix is the trap. */
const OTHER_KEY_WRITES = [
	"--metadata role_hint=reviewer",
	"--metadata payroll=42",
	`--metadata '{"role_hint":"reviewer"}'`,
	`--metadata '{"payroll":"42"}'`,
	"--set-metadata role_hint=reviewer",
	"--unset-metadata role_hint",
];

const MUST_FIRE = PINS.flatMap(pin => ROUTING_WRITES.map(write => `bd ${pin}update orc-7 ${write}`));

const MUST_STAY_QUIET = [
	// Creation is exempt at every pin and every spelling.
	...PINS.flatMap(pin => ROUTING_WRITES.map(write => `bd ${pin}create "a new bug" --type bug ${write}`)),
	...PINS.flatMap(pin => OTHER_KEY_WRITES.map(write => `bd ${pin}update orc-7 ${write}`)),
	// `--metadata-field` filters a query and writes nothing.
	...PINS.map(pin => `bd ${pin}ready --metadata-field role=implementer --unassigned --json`),
	...PINS.map(pin => `bd ${pin}show orc-7 --json`),
	// Text, not a command: the program is grep.
	`grep -n 'set-metadata role' src/gates/claim.ts`,
	`bd -C /run/repo comment orc-7 "REPORTED do not run bd update x --set-metadata role=reviewer"`,
];

describe("G5 routing-write matcher corpus", () => {
	test("every routing-write spelling fires, at every pin", async () => {
		const missed: string[] = [];
		for (const command of MUST_FIRE) {
			const result = await gateClaimEligibility(ctxFor("implementer"), { command });
			if (result?.block !== true) missed.push(command);
		}

		expect({ total: MUST_FIRE.length, missed }).toEqual({ total: 28, missed: [] });
	});

	test("nothing else fires", async () => {
		const leaked: string[] = [];
		for (const command of MUST_STAY_QUIET) {
			const result = await gateClaimEligibility(ctxFor("implementer"), { command });
			if (result !== undefined) leaked.push(command);
		}

		expect({ total: MUST_STAY_QUIET.length, leaked }).toEqual({ total: 62, leaked: [] });
	});
});
