import { describe, expect, test } from "bun:test";
import { deepWildcard, fnmatch, scopeOf, scopesOverlap } from "../src/scope";

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

	test("interacting wildcard scopes retain their actual common-path witnesses", () => {
		for (const [a, b, witness] of [
			["src/*a.ts", "src/*b*.ts", "src/ba.ts"],
			["src/?a.ts", "src/b?.ts", "src/ba.ts"],
			["src/[ab]*.ts", "src/b*.ts", "src/ba.ts"],
		] as const) {
			expect(fnmatch(witness, a)).toBe(true);
			expect(fnmatch(witness, b)).toBe(true);
			expect(scopesOverlap([a], [b])).toBe(true);
			expect(scopesOverlap([b], [a])).toBe(true);
		}
	});

	test("literal directory scopes intersect wildcard descendants in either direction", () => {
		const directory = "src/api";
		const glob = "src/*/handler.ts";
		const witness = "src/api/handler.ts";
		expect(witness.startsWith(`${directory}/`)).toBe(true);
		expect(fnmatch(witness, glob)).toBe(true);
		expect(scopesOverlap([directory], [glob])).toBe(true);
		expect(scopesOverlap([glob], [directory])).toBe(true);
		expect(scopesOverlap([directory], ["docs/*/handler.ts"])).toBe(false);
	});

	test("normalizes leading relative path components", () => {
		expect(scopesOverlap(["././src/*a.ts"], ["src/*b*.ts"])).toBe(true);
		expect(scopesOverlap(["./src/foo/**"], ["src/bar/**"])).toBe(false);
	});

	test.each(["/src/**", "///src/**", "././src/**", "/././src/**///"])(
		"root-relative spelling %s conflicts with the same territory",
		(scope) => {
			expect(scopesOverlap([scope], ["src/**"])).toBe(true);
			expect(scopesOverlap(["src/**"], [scope])).toBe(true);
			expect(scopesOverlap([scope], ["docs/**"])).toBe(false);
		},
	);

	test("trailing separators preserve literal subtree ownership", () => {
		expect(scopesOverlap(["/./src/api///"], ["src/api"])).toBe(true);
		expect(scopesOverlap(["src/api"], ["/./src/api///"])).toBe(true);
		expect(scopesOverlap(["/./src/api///"], ["src/apis"])).toBe(false);
	});

	test.each(["", "/", "///", "./", "././", "/././//"])(
		"explicit whole-tree scope %j conflicts with every declared territory",
		(scope) => {
			expect(scopesOverlap([scope], ["docs/**"])).toBe(true);
			expect(scopesOverlap(["docs/**"], [scope])).toBe(true);
			expect(scopesOverlap([scope], [])).toBe(false);
		},
	);

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
