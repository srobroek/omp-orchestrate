import { describe, expect, test } from "bun:test";
import type { BdBead } from "../src/bd";
import { applies, type Evidence, resourceKind, satisfies } from "../src/gates/exit";

function evidence(bead: Partial<BdBead>, verbs: string[] = [], linkedVerbs: string[] = []): Evidence {
	return { bead: { id: "orc-1", ...bead }, verbs, linkedVerbs };
}

describe("resourceKind", () => {
	test("prefers the declared execution_kind", () => {
		expect(resourceKind({ id: "x", metadata: { execution_kind: "comment", worktree: "/wt" } })).toBe("comment");
	});

	test("derives git from a stamped worktree and artifact from an artifacts dir", () => {
		expect(resourceKind({ id: "x", metadata: { worktree: "/wt" } })).toBe("git");
		expect(resourceKind({ id: "x", metadata: { artifacts_dir: "/a" } })).toBe("artifact");
	});

	test("is undefined when nothing indicates a kind", () => {
		expect(resourceKind({ id: "x" })).toBeUndefined();
	});
});

describe("applies", () => {
	test("a check without when always applies", () => {
		expect(applies({ check: "reported", require: "x" }, undefined)).toBe(true);
	});

	test("a when clause selects on kind, as string or list", () => {
		expect(applies({ check: "c", require: "x", when: "git" }, "git")).toBe(true);
		expect(applies({ check: "c", require: "x", when: "git" }, "artifact")).toBe(false);
		expect(applies({ check: "c", require: "x", when: ["artifact", "comment"] }, "comment")).toBe(true);
	});

	test("a when clause never applies to an unknown kind", () => {
		expect(applies({ check: "c", require: "x", when: "git" }, undefined)).toBe(false);
	});
});

describe("satisfies", () => {
	test("metadata.<key> requires a non-empty value", () => {
		expect(satisfies("metadata.branch", evidence({ metadata: { branch: "feat/x" } }))).toBe(true);
		expect(satisfies("metadata.branch", evidence({ metadata: { branch: "" } }))).toBe(false);
		expect(satisfies("metadata.branch", evidence({}))).toBe(false);
	});

	test("assignee cleared is true only when there is no assignee", () => {
		expect(satisfies("assignee cleared", evidence({}))).toBe(true);
		expect(satisfies("assignee cleared", evidence({ assignee: "" }))).toBe(true);
		expect(satisfies("assignee cleared", evidence({ assignee: "w-1" }))).toBe(false);
	});

	test("label ~ regex searches every label", () => {
		const bead = { labels: ["orc-node", "agent:reviewer"] };
		expect(satisfies("label ~ ^agent:reviewer$", evidence(bead))).toBe(true);
		expect(satisfies("label ~ ^agent:shepherd$", evidence(bead))).toBe(false);
	});

	test("an uncompilable label pattern counts as unmet", () => {
		// Fail closed here, matching the Python: a malformed contract must not
		// silently pass every exit.
		expect(satisfies("label ~ [unclosed", evidence({ labels: ["x"] }))).toBe(false);
	});

	test("comment.verb reads the bead's own verbs, linked. reads the wisps'", () => {
		expect(satisfies("comment.verb in [REPORTED]", evidence({}, ["REPORTED"]))).toBe(true);
		expect(satisfies("comment.verb in [REPORTED]", evidence({}, ["BLOCKED"]))).toBe(false);
		// A reviewer's verdict lands on the linked node, not on the wisp it claimed,
		// so the two pools must not be interchangeable.
		expect(satisfies("linked.comment.verb in [REVIEW, BLOCKED]", evidence({}, [], ["REVIEW"]))).toBe(true);
		expect(satisfies("linked.comment.verb in [REVIEW]", evidence({}, ["REVIEW"], []))).toBe(false);
	});

	test("artifact.output_ref contained demands an absolute path under artifacts_dir", () => {
		const ok = { metadata: { output_ref: "/runs/a/report.md", artifacts_dir: "/runs/a" } };
		expect(satisfies("artifact.output_ref contained", evidence(ok))).toBe(true);

		// Equal to the dir, outside it, relative, or inside the worktree: all unmet.
		expect(
			satisfies("artifact.output_ref contained", evidence({ metadata: { output_ref: "/runs/a", artifacts_dir: "/runs/a" } })),
		).toBe(false);
		expect(
			satisfies(
				"artifact.output_ref contained",
				evidence({ metadata: { output_ref: "/elsewhere/r.md", artifacts_dir: "/runs/a" } }),
			),
		).toBe(false);
		expect(
			satisfies("artifact.output_ref contained", evidence({ metadata: { output_ref: "r.md", artifacts_dir: "/runs/a" } })),
		).toBe(false);
		expect(
			satisfies(
				"artifact.output_ref contained",
				evidence({ metadata: { output_ref: "/wt/f/r.md", artifacts_dir: "/wt", worktree: "/wt" } }),
			),
		).toBe(false);
	});

	test("an unrecognised predicate passes", () => {
		// Matches rules-eval.py: a contract naming a predicate this evaluator does
		// not implement must not fail every exit.
		expect(satisfies("some.future.predicate == 3", evidence({}))).toBe(true);
	});
});
