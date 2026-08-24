import { describe, expect, test } from "bun:test";
import type { BdBead } from "../src/bd";
import {
	buildStatusTree,
	deriveState,
	filterTree,
	parseBlockedIds,
	renderStatus,
	statusSummaryLine,
} from "../src/tools/run-status";

/** A bead in the shape `bd list --status all --json` returns. */
function bead(id: string, fields: Partial<BdBead> & Record<string, unknown> = {}): BdBead {
	return { id, title: id, status: "open", issue_type: "task", ...fields };
}

/** One epic, two features, tasks at two depths, one of them a grandchild. */
const RUN: BdBead[] = [
	bead("bd-1", { issue_type: "epic", title: "Ship dispatch", status: "in_progress" }),
	bead("bd-2", { issue_type: "feature", title: "auth domain", parent: "bd-1", status: "in_progress", assignee: "arch-1" }),
	bead("bd-3", { title: "hash passwords", parent: "bd-2", status: "closed", metadata: { origin: "run-7" } }),
	bead("bd-4", { title: "rotate tokens", parent: "bd-2", assignee: "impl-2", status: "in_progress" }),
	bead("bd-5", { title: "token TTL sweep", parent: "bd-4" }),
	bead("bd-6", { issue_type: "feature", title: "billing domain", parent: "bd-1", metadata: { role: "architect" } }),
	bead("bd-7", { title: "invoice totals", parent: "bd-6" }),
	bead("bd-8", { issue_type: "chore", title: "tidy the changelog", parent: "bd-1" }),
];

describe("buildStatusTree", () => {
	test("groups epic -> feature -> task through parent links, flattening depth", () => {
		const tree = buildStatusTree(RUN, []);
		expect(tree.epics.map(e => e.id)).toEqual(["bd-1"]);

		const epic = tree.epics[0]!;
		expect(epic.features.map(f => f.id)).toEqual(["bd-2", "bd-6"]);
		// bd-5 is a grandchild of the feature; it must not escape bd-2's rollup.
		expect(epic.features[0]!.tasks.map(t => t.id)).toEqual(["bd-3", "bd-4", "bd-5"]);
		expect(epic.features[1]!.tasks.map(t => t.id)).toEqual(["bd-7"]);
		// A non-feature direct child of the epic is not silently a feature.
		expect(epic.tasks.map(t => t.id)).toEqual(["bd-8"]);
		expect(tree.orphans).toEqual([]);
	});

	test("counts every descendant per feature and per epic", () => {
		const tree = buildStatusTree(RUN, []);
		const epic = tree.epics[0]!;
		expect(epic.features[0]!.counts).toEqual({ closed: 1, active: 1, ready: 1 });
		expect(epic.features[1]!.counts).toEqual({ ready: 1 });
		// Epic counts cover its features themselves plus all their work, plus bd-8.
		expect(epic.counts).toEqual({ active: 2, closed: 1, ready: 4 });
	});

	test("carries assignee, role, and origin onto nodes", () => {
		const tree = buildStatusTree(RUN, []);
		const features = tree.epics[0]!.features;
		expect(features[0]!.assignee).toBe("arch-1");
		expect(features[1]!.role).toBe("architect");
		expect(features[0]!.tasks[0]!.origin).toBe("run-7");
	});

	test("an epic whose parent names a missing bead is still a root", () => {
		const tree = buildStatusTree([bead("bd-9", { issue_type: "epic", parent: "gone-1" })], []);
		expect(tree.epics.map(e => e.id)).toEqual(["bd-9"]);
	});

	test("reports beads no epic reaches rather than dropping them", () => {
		const tree = buildStatusTree([bead("bd-20"), bead("bd-21", { parent: "nowhere" })], []);
		expect(tree.epics).toEqual([]);
		expect(tree.orphans.map(o => o.id)).toEqual(["bd-20", "bd-21"]);
	});

	test("a parent cycle terminates", () => {
		const cyclic = [
			bead("bd-30", { issue_type: "epic" }),
			bead("bd-31", { issue_type: "feature", parent: "bd-30" }),
			bead("bd-32", { parent: "bd-33" }),
			bead("bd-33", { parent: "bd-32" }),
		];
		const tree = buildStatusTree(cyclic, []);
		expect(tree.epics[0]!.features.map(f => f.id)).toEqual(["bd-31"]);
		expect(tree.orphans.map(o => o.id)).toEqual(["bd-32", "bd-33"]);
	});

	test("sorts siblings structure-first then by id", () => {
		const shuffled = [
			bead("bd-1", { issue_type: "epic" }),
			bead("bd-9", { issue_type: "chore", parent: "bd-1" }),
			bead("bd-3", { issue_type: "feature", parent: "bd-1" }),
			bead("bd-2", { issue_type: "feature", parent: "bd-1" }),
		];
		const epic = buildStatusTree(shuffled, [])!.epics[0]!;
		expect(epic.features.map(f => f.id)).toEqual(["bd-2", "bd-3"]);
		expect(epic.tasks.map(t => t.id)).toEqual(["bd-9"]);
	});
});

describe("deriveState", () => {
	test("status alone decides when no label or assignee speaks", () => {
		expect(deriveState(bead("a", { status: "open" }))).toBe("ready");
		expect(deriveState(bead("a", { status: "in_progress" }))).toBe("active");
		expect(deriveState(bead("a", { status: "closed" }))).toBe("closed");
		expect(deriveState(bead("a", { status: "deferred" }))).toBe("deferred");
		expect(deriveState(bead("a", { status: "blocked" }))).toBe("blocked");
	});

	test("an open bead with an assignee is claimed, not ready", () => {
		expect(deriveState(bead("a", { status: "open", assignee: "impl-1" }))).toBe("claimed");
	});

	test("a `state:` label is the finer signal below a terminal status", () => {
		expect(deriveState(bead("a", { status: "in_progress", labels: ["agent:reviewer", "state:in_review"] }))).toBe(
			"in_review",
		);
		expect(deriveState(bead("a", { status: "open", labels: ["state:reported"], assignee: "impl-1" }))).toBe("reported");
	});

	test("a terminal status outranks a stale lifecycle label", () => {
		expect(deriveState(bead("a", { status: "closed", labels: ["state:in_review"] }))).toBe("closed");
		expect(deriveState(bead("a", { status: "deferred", labels: ["state:reported"] }))).toBe("deferred");
	});

	test("labels that are not lifecycle phases are ignored", () => {
		expect(deriveState(bead("a", { status: "open", labels: ["agent:implementer", "state:"] }))).toBe("ready");
	});

	test("membership in the blocked set overrides an open status", () => {
		expect(deriveState(bead("a", { status: "open" }), new Set(["a"]))).toBe("blocked");
		expect(deriveState(bead("b", { status: "open" }), new Set(["a"]))).toBe("ready");
	});

	test("an unknown or absent status is reported, not guessed", () => {
		expect(deriveState(bead("a", { status: "wedged" }))).toBe("wedged");
		expect(deriveState({ id: "a" })).toBe("unknown");
	});
});

describe("blocked marking", () => {
	test("marks blocked nodes and reports only ids present in the tree", () => {
		const tree = buildStatusTree(RUN, ["bd-5", "bd-7", "ghost-1"]);
		expect(tree.blocked.sort()).toEqual(["bd-5", "bd-7"]);
		const auth = tree.epics[0]!.features[0]!;
		expect(auth.tasks.find(t => t.id === "bd-5")!.blocked).toBe(true);
		expect(auth.tasks.find(t => t.id === "bd-5")!.state).toBe("blocked");
		expect(auth.tasks.find(t => t.id === "bd-3")!.blocked).toBe(false);
	});

	test("a filtered tree stops reporting blockers it no longer shows", () => {
		const tree = filterTree(buildStatusTree(RUN, ["bd-5", "bd-7"]), { feature: "bd-6" });
		expect(tree.blocked).toEqual(["bd-7"]);
	});

	test("the render names the blocked beads under their epic", () => {
		const text = renderStatus(buildStatusTree(RUN, ["bd-5"]));
		expect(text).toContain("BLOCKED (1): bd-5");
	});
});

describe("filterTree", () => {
	test("no filter returns the tree untouched", () => {
		const tree = buildStatusTree(RUN, []);
		expect(filterTree(tree, {})).toBe(tree);
	});

	test("epic filter keeps one epic", () => {
		const two = [...RUN, bead("bd-40", { issue_type: "epic" }), bead("bd-41", { issue_type: "feature", parent: "bd-40" })];
		const tree = filterTree(buildStatusTree(two, []), { epic: "bd-40" });
		expect(tree.epics.map(e => e.id)).toEqual(["bd-40"]);
	});

	test("feature filter keeps its epic, only that feature, and no direct tasks", () => {
		const tree = filterTree(buildStatusTree(RUN, []), { feature: "bd-2" });
		expect(tree.epics.map(e => e.id)).toEqual(["bd-1"]);
		expect(tree.epics[0]!.features.map(f => f.id)).toEqual(["bd-2"]);
		expect(tree.epics[0]!.tasks).toEqual([]);
		expect(tree.epics[0]!.counts).toEqual({ active: 2, closed: 1, ready: 1 });
	});

	test("actor filter keeps only what that actor holds, recounting as it prunes", () => {
		const tree = filterTree(buildStatusTree(RUN, []), { actor: "impl-2" });
		expect(tree.epics.map(e => e.id)).toEqual(["bd-1"]);
		// bd-2 survives only as the parent of a held task; its own claim is arch-1's.
		expect(tree.epics[0]!.features.map(f => f.id)).toEqual(["bd-2"]);
		expect(tree.epics[0]!.features[0]!.tasks.map(t => t.id)).toEqual(["bd-4"]);
		expect(tree.epics[0]!.features[0]!.counts).toEqual({ active: 1 });
		expect(tree.epics[0]!.counts).toEqual({ active: 2 });
	});

	test("actor filter keeps a feature the actor holds even with no held tasks", () => {
		const tree = filterTree(buildStatusTree(RUN, []), { actor: "arch-1" });
		const auth = tree.epics[0]!.features[0]!;
		expect(auth.id).toBe("bd-2");
		expect(auth.tasks).toEqual([]);
	});

	test("actor filter reads metadata.role for work claimed without an assignee", () => {
		const tree = filterTree(buildStatusTree(RUN, []), { actor: "architect" });
		expect(tree.epics[0]!.features.map(f => f.id)).toEqual(["bd-6"]);
	});

	test("actor filter reads metadata that arrived as stringified JSON", () => {
		const beads = [
			bead("bd-1", { issue_type: "epic" }),
			bead("bd-2", { issue_type: "feature", parent: "bd-1" }),
			bead("bd-3", { parent: "bd-2", metadata: '{"role":"reviewer"}' as unknown as Record<string, unknown> }),
		];
		const tree = filterTree(buildStatusTree(beads, []), { actor: "reviewer" });
		expect(tree.epics[0]!.features[0]!.tasks.map(t => t.id)).toEqual(["bd-3"]);
	});

	test("an actor holding nothing yields an empty tree", () => {
		const tree = filterTree(buildStatusTree(RUN, []), { actor: "nobody" });
		expect(tree.epics).toEqual([]);
		expect(tree.blocked).toEqual([]);
	});

	test("an unknown epic or feature id matches nothing", () => {
		expect(filterTree(buildStatusTree(RUN, []), { epic: "bd-999" }).epics).toEqual([]);
		expect(filterTree(buildStatusTree(RUN, []), { feature: "bd-999" }).epics).toEqual([]);
	});
});

describe("statusSummaryLine", () => {
	test("counts epics, features, tasks, and blockers", () => {
		expect(statusSummaryLine(buildStatusTree(RUN, ["bd-5"]))).toBe("1 epics · 2 features · 5 tasks · 1 blocked");
	});

	test("names unparented beads only when there are some", () => {
		const line = statusSummaryLine(buildStatusTree([...RUN, bead("bd-50")], []));
		expect(line).toBe("1 epics · 2 features · 5 tasks · 0 blocked · 1 unparented");
	});

	test("an empty tree is a line, not a crash", () => {
		expect(statusSummaryLine(buildStatusTree([], []))).toBe("0 epics · 0 features · 0 tasks · 0 blocked");
	});
});

describe("renderStatus", () => {
	test("summary mode rolls up without printing per-bead lines", () => {
		const text = renderStatus(buildStatusTree(RUN, []));
		expect(text).toContain("EPIC  bd-1  Ship dispatch");
		expect(text).toContain("1/7 closed"); // features count toward the rollup, as in run-status.py
		expect(text).toContain("auth domain");
		expect(text).not.toContain("hash passwords");
	});

	test("full mode prints one line per bead", () => {
		const text = renderStatus(buildStatusTree(RUN, []), { full: true });
		expect(text).toContain("hash passwords");
		expect(text).toContain("token TTL sweep");
		expect(text).toContain("tidy the changelog");
		expect(text).toContain("@impl-2");
	});

	test("names the filter it applied", () => {
		const text = renderStatus(buildStatusTree(RUN, []), { filter: { actor: "impl-2", epic: "bd-1" } });
		expect(text).toContain("filter: epic=bd-1 actor=impl-2");
	});

	test("an empty tree says so instead of printing an empty rollup", () => {
		expect(renderStatus(buildStatusTree([], []))).toContain("no matching epic, feature, or bead");
	});

	test("unparented beads are surfaced", () => {
		const text = renderStatus(buildStatusTree([bead("bd-60")], []), { full: true });
		expect(text).toContain("UNPARENTED (1)");
		expect(text).toContain("bd-60");
	});
});

describe("parseBlockedIds", () => {
	test("reads a bare list", () => {
		expect(parseBlockedIds('[{"id":"bd-5","blocked_by":["bd-4"]},{"id":"bd-7"}]')).toEqual(["bd-5", "bd-7"]);
	});

	test("unwraps the json envelope", () => {
		expect(parseBlockedIds('{"schema_version":1,"data":[{"id":"bd-5"}]}')).toEqual(["bd-5"]);
	});

	test("skips a warning banner printed before the payload", () => {
		expect(parseBlockedIds('warning: dolt server is cold\n[{"id":"bd-5"}]')).toEqual(["bd-5"]);
	});

	test("accepts a single object", () => {
		expect(parseBlockedIds('{"id":"bd-5"}')).toEqual(["bd-5"]);
	});

	test("empty, non-json, and malformed payloads yield no ids", () => {
		expect(parseBlockedIds("")).toEqual([]);
		expect(parseBlockedIds("bd: not a beads workspace")).toEqual([]);
		expect(parseBlockedIds("[{oops")).toEqual([]);
		expect(parseBlockedIds('[{"blocked_by":["bd-4"]},null,7]')).toEqual([]);
	});
});

describe("empty bd", () => {
	test("no beads builds an empty tree that renders and summarises", () => {
		const tree = buildStatusTree([], parseBlockedIds(""));
		expect(tree).toEqual({ epics: [], orphans: [], blocked: [] });
		expect(renderStatus(tree, { full: true })).toContain("no matching epic, feature, or bead");
	});
});
