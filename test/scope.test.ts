import { describe, expect, test } from "bun:test";
import { deepWildcard, scopeOf, scopesOverlap } from "../src/scope";

describe("deepWildcard", () => {
	test("true when a wildcard sits above the last segment", () => {
		expect(deepWildcard("src/a*/f.py")).toBe(true);
		expect(deepWildcard("src/**/f.py")).toBe(true);
		expect(deepWildcard("**")).toBe(false); // no separator, so nothing above it
	});

	test("false when the wildcard is confined to the last segment", () => {
		expect(deepWildcard("src/api/*.py")).toBe(false);
		expect(deepWildcard("src/api/*")).toBe(false);
	});
});

describe("scopesOverlap", () => {
	test("disjoint directories do not overlap", () => {
		expect(scopesOverlap(["src/foo/**"], ["src/bar/**"])).toBe(false);
		expect(scopesOverlap(["docs/*.md"], ["src/*.ts"])).toBe(false);
	});

	test("a bare wildcard owns everything", () => {
		expect(scopesOverlap(["**"], ["src/foo/**"])).toBe(true);
		expect(scopesOverlap(["src/foo/**"], ["*"])).toBe(true);
	});

	test("nested directories overlap", () => {
		expect(scopesOverlap(["src/api/**"], ["src/api/v2/**"])).toBe(true);
		expect(scopesOverlap(["src/api/v2/**"], ["src/api/**"])).toBe(true);
	});

	test("a wildcard-free scope owns its whole path", () => {
		expect(scopesOverlap(["src/api/handler.ts"], ["src/api/handler.ts"])).toBe(true);
		expect(scopesOverlap(["src/api"], ["src/api/*.ts"])).toBe(true);
	});

	test("subsumption counts in either direction", () => {
		// `src/api/*` subsumes `src/api/*.py`; the reverse is not true, and one
		// direction is enough.
		expect(scopesOverlap(["src/api/*"], ["src/api/*.py"])).toBe(true);
		expect(scopesOverlap(["src/api/*.py"], ["src/api/*"])).toBe(true);
	});

	test("a wildcard above the last segment makes text comparison unsound, so it conflicts", () => {
		// The case the original calls out: these share `src/ab/f.py` while matching in
		// neither direction as text.
		expect(scopesOverlap(["src/a*/f.py"], ["src/*b/f.py"])).toBe(true);
	});

	test("sibling prefixes diverging mid-segment conflict when a deep wildcard can span them", () => {
		expect(scopesOverlap(["src/a**/x.ts"], ["src/ab/x.ts"])).toBe(true);
	});

	test("any conflicting pair makes the whole sets overlap", () => {
		expect(scopesOverlap(["docs/**", "src/api/**"], ["tests/**", "src/api/v2/**"])).toBe(true);
	});

	test("empty scopes cannot conflict", () => {
		// An undeclared scope is not a claim on anything, so it must not serialize
		// every other bead.
		expect(scopesOverlap([], ["src/**"])).toBe(false);
		expect(scopesOverlap(["src/**"], [])).toBe(false);
	});
});

describe("scopeOf", () => {
	test("reads an array", () => {
		expect(scopeOf({ scope: ["src/**", "docs/**"] })).toEqual(["src/**", "docs/**"]);
	});

	test("reads a JSON array stamped as a string", () => {
		expect(scopeOf({ scope: '["src/**"]' })).toEqual(["src/**"]);
	});

	test("treats a bare string as a single glob", () => {
		expect(scopeOf({ scope: "src/**" })).toEqual(["src/**"]);
	});

	test("is empty for absent, non-string, or absent metadata", () => {
		expect(scopeOf({})).toEqual([]);
		expect(scopeOf(undefined)).toEqual([]);
		expect(scopeOf({ scope: 42 })).toEqual([]);
		expect(scopeOf({ scope: ["src/**", 42] })).toEqual(["src/**"]);
	});
});
