import { describe, expect, test } from "bun:test";
import { acceptanceHash } from "../src/acceptance";
import { satisfies, type Evidence } from "../src/gates/exit";

const hash = acceptanceHash("1. ship\n2. test");
const nodeHash = "abcdef012345";
function ev(overrides: Partial<Evidence> = {}): Evidence {
	return { bead: { id: "wisp", metadata: { dimension: "code" } }, verbs: ["REPORTED"], linkedVerbs: ["REVIEW"], beadComments: [], linkedReviewComments: [], ...overrides };
}

describe("exit coverage predicates", () => {
	test("integrated approve needs every live id, hash, and met", () => {
		const base = ev({ linkedReviewComments: [`REVIEW verdict=approve nodes=node-a:${nodeHash}:met,node-b:0123456789ab:met`], integratedIds: ["node-a", "node-b"], integratedHashes: new Map([["node-a", nodeHash], ["node-b", "0123456789ab"]]) });
		expect(satisfies("linked.REVIEW covers integrated", base)).toBe(true);
		expect(satisfies("linked.REVIEW covers integrated", { ...base, linkedReviewComments: [`REVIEW verdict=approve nodes=node-a:${nodeHash}:met`] })).toBe(false);
		expect(satisfies("linked.REVIEW covers integrated", { ...base, linkedReviewComments: [`REVIEW verdict=approve nodes=node-a:${nodeHash}:met,node-b:0123456789ab:unmet`] })).toBe(false);
		expect(satisfies("linked.REVIEW covers integrated", { ...base, linkedReviewComments: [`REVIEW verdict=changes nodes=node-a:${nodeHash}:met,node-b:0123456789ab:unmet`] })).toBe(true);
	});
	test("plan approval is version-bound and override uses live hash", () => {
		expect(satisfies("linked.REVIEW covers plan", ev({ planHash: "0123456789ab", linkedReviewComments: ["REVIEW verdict=approve plan=0123456789ab"] }))).toBe(true);
		expect(satisfies("linked.REVIEW covers plan", ev({ planHash: "0123456789ab", linkedReviewComments: ["REVIEW verdict=approve plan=abcdef012345"] }))).toBe(false);
		expect(satisfies("linked.REVIEW covers override", ev({ linkedAcceptanceHash: nodeHash, linkedReviewComments: [`REVIEW verdict=approve override=${nodeHash}`] }))).toBe(true);
	});
	test("REPORTED without DOD is refused with live hash and items available to recovery", () => {
		const evidence = ev({ bead: { id: "node", acceptance_criteria: "1. ship\n2. test" }, beadComments: ["REPORTED node src/a.ts"] });
		expect(satisfies("comment.REPORTED covers dod", evidence)).toBe(false);
	});
});
