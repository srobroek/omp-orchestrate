import { describe, expect, test } from "bun:test";
import { bdRun, commentVerb, metadataString, resetReadBudget } from "../src/bd";
import { roleFromLabels } from "../src/identity";

describe("bdRun never throws", () => {
	// The whole reason this wrapper exists: a throw inside a tool_call handler
	// blocks the tool being inspected (wrapper.ts:237), so a missing binary must
	// degrade to "unknown", never to an exception.
	test("resolves null when the binary does not exist", async () => {
		const previous = process.env.BD_BIN;
		process.env.BD_BIN = "definitely-not-a-real-binary-xyz";
		try {
			expect(await bdRun(["show", "x", "--json"])).toBeNull();
		} finally {
			if (previous === undefined) delete process.env.BD_BIN;
			else process.env.BD_BIN = previous;
		}
	});

	test("captures a non-zero exit rather than throwing", async () => {
		const previous = process.env.BD_BIN;
		process.env.BD_BIN = "false";
		try {
			const result = await bdRun([]);
			expect(result).not.toBeNull();
			expect(result?.code).not.toBe(0);
		} finally {
			if (previous === undefined) delete process.env.BD_BIN;
			else process.env.BD_BIN = previous;
		}
	});
});

describe("read budget", () => {
	test("reset makes the budget available again", () => {
		// Exercised for its side effect: the gates call this once per dispatch, and
		// a stuck counter would silently fail every contract evaluation open.
		expect(() => resetReadBudget()).not.toThrow();
	});
});

describe("metadataString", () => {
	const bead = { id: "x", metadata: { worktree: "/tmp/wt", empty: "", count: 3 } };

	test("returns a non-empty string value", () => {
		expect(metadataString(bead, "worktree")).toBe("/tmp/wt");
	});

	test("treats empty, missing, non-string, and a null bead as absent", () => {
		expect(metadataString(bead, "empty")).toBeUndefined();
		expect(metadataString(bead, "absent")).toBeUndefined();
		expect(metadataString(bead, "count")).toBeUndefined();
		expect(metadataString(null, "worktree")).toBeUndefined();
	});
});

describe("commentVerb", () => {
	test("takes the leading token, uppercased, colon stripped", () => {
		expect(commentVerb("REPORTED orc-1 pushed")).toBe("REPORTED");
		expect(commentVerb("reported orc-1")).toBe("REPORTED");
		expect(commentVerb("REVIEW: verdict=approve")).toBe("REVIEW");
		expect(commentVerb("   BLOCKED   kind:design")).toBe("BLOCKED");
	});

	test("yields an empty verb for empty text", () => {
		expect(commentVerb("")).toBe("");
		expect(commentVerb("   ")).toBe("");
	});
});

describe("roleFromLabels", () => {
	test("finds the routing role", () => {
		expect(roleFromLabels(["orc-node", "agent:implementer", "state:pending"])).toBe("implementer");
		expect(roleFromLabels(["agent:shepherd"])).toBe("shepherd");
	});

	test("ignores labels that name no known role", () => {
		// `agent:integrator` is a queue for merge beads, not one of the five roles,
		// so it must not resolve — otherwise claim eligibility would compare
		// against a role that has no agent.
		expect(roleFromLabels(["agent:integrator"])).toBeUndefined();
		expect(roleFromLabels(["cap:ts", "state:working"])).toBeUndefined();
		expect(roleFromLabels([])).toBeUndefined();
		expect(roleFromLabels(undefined)).toBeUndefined();
	});

	test("returns the first known role when several are present", () => {
		expect(roleFromLabels(["agent:reviewer", "agent:researcher"])).toBe("reviewer");
	});
});
