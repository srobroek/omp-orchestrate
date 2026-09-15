import { describe, expect, test } from "bun:test";
import type { BdBead } from "../src/bd";
import { parentOf } from "../src/bd";
import { applyVerdict, nextTier, reviewTargets } from "../src/verdict";

/** A recorded `bd` runner: every call is captured; `create` returns a fresh id. */
function recorder(shows: Record<string, BdBead>) {
	const calls: string[][] = [];
	let created = 0;
	const bd = async (args: readonly string[]) => {
		calls.push([...args]);
		if (args[0] === "create") return { id: `fix-${++created}`, title: args[args.indexOf("--title") + 1] };
		return undefined;
	};
	const show = async (id: string) => {
		const bead = shows[id];
		if (bead === undefined) throw new Error(`no bead ${id}`);
		return bead;
	};
	return { calls, bd, show };
}

const review: BdBead = {
	id: "e.9",
	title: "Review the wave",
	issue_type: "task",
	metadata: { role: "reviewer" },
	dependencies: [
		{ id: "e", dependency_type: "parent-child" },
		{ id: "e.1", dependency_type: "blocks" },
		{ id: "e.2", dependency_type: "blocks" },
	],
};
const tasks: Record<string, BdBead> = {
	"e.1": { id: "e.1", title: "Add subtract", issue_type: "task", metadata: { role: "implementer", tier: "basic" }, dependencies: [{ id: "e", dependency_type: "parent-child" }] },
	"e.2": { id: "e.2", title: "Add divide", issue_type: "task", metadata: { role: "implementer", tier: "max" }, dependencies: [{ id: "e", dependency_type: "parent-child" }] },
	"e.3": { id: "e.3", title: "Round two", issue_type: "task", metadata: { role: "implementer", tier: "deep", fix_round: 1 }, dependencies: [{ id: "e", dependency_type: "parent-child" }] },
};

describe("verdict helpers", () => {
	test("the ladder climbs basic -> deep -> max and stops", () => {
		expect(nextTier("basic")).toBe("deep");
		expect(nextTier("deep")).toBe("max");
		expect(nextTier("max")).toBeNull();
	});

	test("targets are the review's non-parent dependencies; parent is the parent-child edge", () => {
		expect(reviewTargets(review)).toEqual(["e.1", "e.2"]);
		expect(parentOf(review)).toBe("e");
		expect(parentOf({ id: "x" })).toBeUndefined();
	});
});

describe("applyVerdict", () => {
	test("refuses a non-review bead", async () => {
		const { bd, show } = recorder(tasks);
		await expect(applyVerdict({ review: tasks["e.1"] as BdBead, verdict: "approve", reason: "r", findings: "", bd, show })).rejects.toThrow("role is implementer");
	});

	test("approve closes the review bead and nothing else", async () => {
		const { calls, bd, show } = recorder(tasks);
		const out = await applyVerdict({ review, verdict: "approve", reason: "criteria met", findings: "", bd, show });
		expect(calls).toEqual([["close", "e.9", "--reason", "criteria met", "--json"]]);
		expect(out.reopened).toEqual([]);
		expect(out.escalated).toEqual([]);
	});

	test("fix reopens each target unassigned with the findings, keeps its tier, counts rounds, and leaves the review open", async () => {
		const { calls, bd, show } = recorder(tasks);
		const out = await applyVerdict({ review, verdict: "fix", reason: "two local nits", findings: "1. narrow the type\n2. add the zero test", targets: ["e.1", "e.3"], bd, show });
		expect(out.reopened).toEqual(["e.1", "e.3"]);
		expect(calls[0]).toEqual(["comment", "e.9", "fix: 1. narrow the type\n2. add the zero test"]);
		expect(calls[1]).toEqual(["update", "e.9", "--status", "open", "--assignee", "", "--json"]);
		expect(calls[2]).toEqual(["reopen", "e.1", "--reason", "fix requested by e.9: two local nits"]);
		expect(calls[3]).toEqual(["update", "e.1", "--assignee", "", "--set-metadata", "fix_from=e.9", "--set-metadata", "fix_round=1", "--set-metadata", "fix_findings=1. narrow the type\n2. add the zero test", "--json"]);
		expect(calls[5]).toContain("fix_round=2");
		expect(calls.some(call => call[0] === "close" || call[0] === "create")).toBe(false);
	});

	test("changes creates a fix bead one tier up under the task's parent and makes the review depend on it", async () => {
		const { calls, bd, show } = recorder(tasks);
		const out = await applyVerdict({ review, verdict: "changes", reason: "criterion 2 misread", findings: "OPERATIONS not updated", targets: ["e.1"], bd, show });
		expect(out.escalated).toEqual([{ from: "e.1", bead: "fix-1", tier: "deep" }]);
		const create = calls.find(call => call[0] === "create") as string[];
		expect(create).toContain("--parent");
		expect(create[create.indexOf("--parent") + 1]).toBe("e");
		expect(create[create.indexOf("--title") + 1]).toBe("Fix: Add subtract");
		expect(JSON.parse(create[create.indexOf("--metadata") + 1] as string)).toEqual({ role: "implementer", tier: "deep", escalated_from: "e.1", review: "e.9" });
		expect(calls).toContainEqual(["dep", "add", "e.9", "fix-1"]);
		expect(calls.some(call => call[0] === "close")).toBe(false);
	});

	test("changes on a max-tier task escalates no further: a planner decomposition bead is created and the review depends on it", async () => {
		const { calls, bd, show } = recorder(tasks);
		const out = await applyVerdict({ review, verdict: "changes", reason: "design wrong", findings: "needs a decomposition", targets: ["e.2"], bd, show });
		expect(out.planner).toEqual(["fix-1"]);
		expect(out.escalated).toEqual([]);
		expect(calls).toContainEqual(["update", "e.2", "--set-metadata", "bounce=max", "--json"]);
		const create = calls.find(call => call[0] === "create") as string[];
		expect(create[create.indexOf("--title") + 1]).toBe("Decompose: Add divide");
		expect(JSON.parse(create[create.indexOf("--metadata") + 1] as string)).toEqual({ role: "planner", review: "e.9", decomposes: "e.2" });
		expect(calls).toContainEqual(["dep", "add", "e.9", "fix-1"]);
	});

	test("defaults to the review's task dependencies and refuses when there are none", async () => {
		const { calls, bd, show } = recorder(tasks);
		const out = await applyVerdict({ review, verdict: "changes", reason: "r", findings: "f", bd, show });
		expect(out.escalated.map(e => e.from)).toEqual(["e.1"]);
		expect(out.planner).toHaveLength(1);
		expect(calls.filter(call => call[0] === "create")).toHaveLength(2);
		const lonely: BdBead = { id: "r", metadata: { role: "reviewer" }, dependencies: [{ id: "e", dependency_type: "parent-child" }] };
		await expect(applyVerdict({ review: lonely, verdict: "fix", reason: "r", findings: "", bd, show })).rejects.toThrow("needs a target task");
	});

	test("a DAG review that does not approve records the findings, reopens itself, and creates a planner revision it depends on", async () => {
		const { calls, bd, show } = recorder(tasks);
		const dag: BdBead = { id: "e.0", metadata: { role: "dag-reviewer" }, dependencies: [{ id: "e", dependency_type: "parent-child" }] };
		const out = await applyVerdict({ review: dag, verdict: "changes", reason: "unbounded bead", findings: "e.4 names no files", bd, show });
		expect(out.planner).toEqual(["fix-1"]);
		expect(calls[0]).toEqual(["comment", "e.0", "changes: e.4 names no files"]);
		expect(calls[1]).toEqual(["update", "e.0", "--status", "open", "--assignee", "", "--json"]);
		const create = calls.find(call => call[0] === "create") as string[];
		expect(create[create.indexOf("--parent") + 1]).toBe("e");
		expect(create[create.indexOf("--title") + 1]).toBe("Revise the DAG");
		expect(calls).toContainEqual(["dep", "add", "e.0", "fix-1"]);
		expect(calls.some(call => call[1] === "e.1" || call[1] === "e.2")).toBe(false);
	});
});
