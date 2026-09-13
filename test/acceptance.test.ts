import { describe, expect, test } from "bun:test";
import { acceptanceHash, acceptanceItems, beadAcceptanceHash, dodToken, itemsCovered, nodesToken, planHash } from "../src/acceptance";

describe("acceptance evidence", () => {
	test("canonical hash folds line endings and trailing whitespace", () => {
		expect(acceptanceHash("1. ship\r\n2. test  \r\n")).toBe(acceptanceHash("1. ship\n2. test"));
		expect(acceptanceHash("1. ship")).not.toBe(acceptanceHash("1. break"));
	});
	test("items parse numbered lines and default unnumbered text to one", () => {
		expect(acceptanceItems("1. one\n2) two\n3: three")).toEqual([1, 2, 3]);
		expect(acceptanceItems("ship it")).toEqual([1]);
	});
	test("malformed coverage tokens invalidate the whole token", () => {
		expect(nodesToken("nodes=a:0123456789ab:met,bad")).toBeUndefined();
		expect(dodToken("dod=0123456789ab:1:met,bad")).toBeUndefined();
	});
	test("itemsCovered rejects stale, missing, and unmet entries", () => {
		const text = "1. one\n2. two";
		const hash = acceptanceHash(text);
		expect(itemsCovered(text, [{ hash, item: 1, disposition: "met" }, { hash, item: 2, disposition: "met" }])).toBe(true);
		expect(itemsCovered(text, [{ hash: acceptanceHash("changed"), item: 1, disposition: "met" }, { hash, item: 2, disposition: "met" }])).toBe(false);
		expect(itemsCovered(text, [{ hash, item: 1, disposition: "met" }])).toBe(false);
		expect(itemsCovered(text, [{ hash, item: 1, disposition: "unmet" }, { hash, item: 2, disposition: "met" }])).toBe(false);
	});
	test("plan hash is order-independent but changes with scope, dependencies, and acceptance", () => {
		const children = [
			{ id: "b", scope: ["src/b"], dependsOn: ["a"], acceptanceHash: "0123456789ab" },
			{ id: "a", scope: ["src/a"], dependsOn: [], acceptanceHash: "abcdef012345" },
		];
		expect(planHash(children)).toBe(planHash([...children].reverse()));
		expect(planHash(children.map(child => child.id === "a" ? { ...child, scope: ["src/other"] } : child))).not.toBe(planHash(children));
		expect(planHash(children.map(child => child.id === "b" ? { ...child, dependsOn: [] } : child))).not.toBe(planHash(children));
		expect(planHash(children.map(child => child.id === "a" ? { ...child, acceptanceHash: "fedcba987654" } : child))).not.toBe(planHash(children));
	});
});
