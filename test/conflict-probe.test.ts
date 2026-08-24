import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { zod } from "@oh-my-pi/pi-coding-agent";
import { describe, expect, test } from "bun:test";
import {
	type ConflictProbeDetails,
	diffNamesArgv,
	ghChecksArgv,
	intersectPaths,
	mergeBaseArgv,
	mergeTreeArgv,
	parseMergeTreeOutput,
	type ProbeMode,
	registerConflictProbe,
	revParseArgv,
} from "../src/tools/conflict-probe";

describe("parseMergeTreeOutput", () => {
	test("a lone tree oid is a clean merge", () => {
		expect(parseMergeTreeOutput("4b825dc642cb6eb9a060e54bf8d69288fbee4904\n")).toEqual({ clean: true, paths: [] });
	});

	test("reads the conflicting paths between the oid and the blank line", () => {
		const out = [
			"9f2b1c4d0e6a7b8c9d0e1f2a3b4c5d6e7f8091a2",
			"src/index.ts",
			"README.md",
			"",
			"Auto-merging src/index.ts",
			"CONFLICT (content): Merge conflict in src/index.ts",
		].join("\n");
		expect(parseMergeTreeOutput(out)).toEqual({ clean: false, paths: ["README.md", "src/index.ts"] });
	});

	test("de-duplicates repeated paths", () => {
		const out = ["9f2b1c4d0e6a7b8c9d0e1f2a3b4c5d6e7f8091a2", "a.ts", "a.ts", ""].join("\n");
		expect(parseMergeTreeOutput(out).paths).toEqual(["a.ts"]);
	});

	test("accepts a sha-256 tree oid", () => {
		const oid = "a".repeat(64);
		expect(parseMergeTreeOutput(`${oid}\nsrc/a.ts\n`)).toEqual({ clean: false, paths: ["src/a.ts"] });
	});

	test("output that does not start with an oid is neither clean nor conflicting", () => {
		// The whole point of this branch: an unclassifiable merge-tree result must
		// never read as clean, or the Shepherd would merge on a non-answer.
		expect(parseMergeTreeOutput("fatal: not a git repository\n")).toEqual({ clean: false, paths: [] });
		expect(parseMergeTreeOutput("")).toEqual({ clean: false, paths: [] });
	});
});

describe("intersectPaths", () => {
	test("returns the sorted shared paths", () => {
		expect(intersectPaths(["src/b.ts", "src/a.ts", "docs/x.md"], ["src/a.ts", "src/b.ts", "other.ts"])).toEqual([
			"src/a.ts",
			"src/b.ts",
		]);
	});

	test("disjoint and empty inputs yield no overlap", () => {
		expect(intersectPaths(["a"], ["b"])).toEqual([]);
		expect(intersectPaths([], ["a"])).toEqual([]);
		expect(intersectPaths(["a"], [])).toEqual([]);
		expect(intersectPaths([], [])).toEqual([]);
	});

	test("a path repeated on either side appears once", () => {
		expect(intersectPaths(["a", "a"], ["a"])).toEqual(["a"]);
	});
});

describe("argument vectors", () => {
	test("conflicts mode pins refs to commits, then predicts the merge", () => {
		expect(revParseArgv("main")).toEqual(["git", "rev-parse", "--verify", "main^{commit}"]);
		expect(mergeTreeArgv("abc123", "def456")).toEqual([
			"git",
			"merge-tree",
			"--write-tree",
			"--name-only",
			"abc123",
			"def456",
		]);
	});

	test("pairwise mode diffs each branch against its own merge base", () => {
		expect(mergeBaseArgv("main", "feature")).toEqual(["git", "merge-base", "main", "feature"]);
		expect(diffNamesArgv("abc123", "feature")).toEqual(["git", "diff", "--name-only", "abc123", "feature"]);
	});

	test("ci mode asks gh for the PR's checks", () => {
		expect(ghChecksArgv("42")).toEqual(["gh", "pr", "checks", "42"]);
	});
});

/** Collect what `registerConflictProbe` registers, without an OMP session. */
function registered(): {
	name: string;
	execute: (
		id: string,
		params: { mode: ProbeMode; base?: string; branch?: string; branchB?: string; pr?: string },
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	) => Promise<{ isError?: boolean; details?: ConflictProbeDetails }>;
} {
	const tools: unknown[] = [];
	const pi = { zod, registerTool: (tool: unknown) => tools.push(tool) } as unknown as ExtensionAPI;
	registerConflictProbe(pi);
	expect(tools).toHaveLength(1);
	return tools[0] as ReturnType<typeof registered>;
}

describe("registerConflictProbe", () => {
	test("registers exactly one prefixed tool, and only when called", () => {
		// Importing the module must not register anything: `src/index.ts` owns wiring.
		expect(registered().name).toBe("orc_conflict_probe");
	});

	test("missing mode arguments fail as a result, never as a throw", async () => {
		const tool = registered();
		const ctx = { cwd: "/tmp" } as unknown as ExtensionContext;

		const cases: { mode: ProbeMode; base?: string; branch?: string }[] = [
			{ mode: "conflicts", base: "main" },
			{ mode: "pairwise", base: "main", branch: "a" },
			{ mode: "ci" },
		];
		for (const params of cases) {
			const result = await tool.execute("id", params, undefined, undefined, ctx);
			expect(result.isError).toBe(true);
			expect(result.details?.error).toBe("missing arguments");
			expect(result.details?.mode).toBe(params.mode);
		}
	});
});
