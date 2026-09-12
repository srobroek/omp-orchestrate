import { describe, expect, spyOn, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { BdBead } from "../src/bd";
import {
	buildCloseOut,
	buildStatusTree,
	type CloseOutReads,
	deriveState,
	filterTree,
	registerRunStatus,
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
	bead("bd-2", { issue_type: "feature", title: "auth login", parent: "bd-1", status: "in_progress", assignee: "arch-1" }),
	bead("bd-3", { title: "hash passwords", parent: "bd-2", status: "closed", metadata: { origin: "run-7" } }),
	bead("bd-4", { title: "rotate tokens", parent: "bd-2", assignee: "impl-2", status: "in_progress" }),
	bead("bd-5", { title: "token TTL sweep", parent: "bd-4" }),
	bead("bd-6", { issue_type: "feature", title: "billing invoices", parent: "bd-1", metadata: { role: "architect" } }),
	bead("bd-7", { title: "invoice totals", parent: "bd-6" }),
	bead("bd-8", { issue_type: "chore", title: "tidy the changelog", parent: "bd-1" }),
];

/**
 * The documented run shape (README, `beads-store.md`): a run epic holding one epic per
 * architect domain, each holding its features, each holding its tasks.
 */
const DOMAINS: BdBead[] = [
	bead("run", { issue_type: "epic", title: "Run", status: "in_progress" }),
	bead("dom-a", { issue_type: "epic", title: "Auth domain", parent: "run", status: "in_progress", metadata: { role: "architect", run_epic: "run", actor: "arch-a" } }),
	bead("feat-1", { issue_type: "feature", title: "login", parent: "dom-a", status: "in_progress", assignee: "arch-a" }),
	bead("t1", { title: "hash passwords", parent: "feat-1", status: "closed" }),
	bead("t2", { title: "rotate tokens", parent: "feat-1", metadata: { actor: "impl-7" } }),
	bead("dom-b", { issue_type: "epic", title: "Billing domain", parent: "run", metadata: { role: "architect", run_epic: "run" } }),
	bead("feat-2", { issue_type: "feature", title: "invoices", parent: "dom-b" }),
	bead("t3", { title: "invoice totals", parent: "feat-2", assignee: "impl-9" }),
];

/** A `bd set-state` event bead: a closed child recording one transition. */
function event(id: string, parent: string, phase: string): BdBead {
	return bead(id, { issue_type: "event", title: `State change: state → ${phase}`, parent, status: "closed" });
}

/** A merge bead as the architect creates it and the sweep stamps it. */
function merge(id: string, fields: Partial<BdBead> & Record<string, unknown> = {}): BdBead {
	const { metadata, ...rest } = fields;
	return bead(id, {
		title: `land ${id}`,
		labels: ["pr:merge"],
		metadata: { role: "shepherd", repo: "o/r", origin_bead: "feat-1", branch: `omp/task/${id}`, pr: 7, head_sha: "a".repeat(40), ...metadata },
		...rest,
	});
}

/** Every read answered and nothing outstanding: what a finished run reports. */
const ALL_READY: CloseOutReads = { blocked: [], ready: [], cycles: [] };

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

	test("an epic under an epic is a nested rollup, not a task", () => {
		const tree = buildStatusTree(DOMAINS, []);
		expect(tree.epics.map(e => e.id)).toEqual(["run"]);
		const run = tree.epics[0]!;
		expect(run.epics.map(e => e.id)).toEqual(["dom-a", "dom-b"]);
		expect(run.features).toEqual([]);
		expect(run.tasks).toEqual([]);
		expect(run.epics[0]!.features.map(f => f.id)).toEqual(["feat-1"]);
		expect(run.epics[0]!.features[0]!.tasks.map(t => t.id)).toEqual(["t1", "t2"]);
		expect(run.epics[1]!.features[0]!.tasks.map(t => t.id)).toEqual(["t3"]);
		expect(tree.orphans).toEqual([]);
	});

	test("a run's counts roll up through its domains", () => {
		const run = buildStatusTree(DOMAINS, [])!.epics[0]!;
		// dom-a: feat-1 active, t1 closed, t2 ready. dom-b: feat-2 ready, t3 claimed.
		expect(run.epics[0]!.counts).toEqual({ active: 1, closed: 1, ready: 1 });
		expect(run.epics[1]!.counts).toEqual({ ready: 1, claimed: 1 });
		// The run counts both domains themselves plus everything beneath them.
		expect(run.counts).toEqual({ active: 2, closed: 1, ready: 3, claimed: 1 });
	});

	test("set-state event beads are not tasks and do not close anything", () => {
		const withEvents = [
			...DOMAINS,
			event("t2.1", "t2", "reported"),
			event("t2.2", "t2", "in_review"),
			event("t2.3", "t2", "approved"),
			event("run.1", "run", "working"),
		];
		const tree = buildStatusTree(withEvents, []);
		expect(tree).toEqual(buildStatusTree(DOMAINS, []));
		expect(statusSummaryLine(tree)).toBe("3 epics · 2 features · 3 tasks · 0 blocked");
		expect(renderStatus(tree, { full: true })).not.toContain("State change");
	});

	test("carries metadata.actor onto nodes", () => {
		const run = buildStatusTree(DOMAINS, [])!.epics[0]!;
		expect(run.epics[0]!.actor).toBe("arch-a");
		expect(run.epics[0]!.features[0]!.tasks[1]!.actor).toBe("impl-7");
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

	test("actor filter reads metadata.actor for work held without an assignee", () => {
		const tree = filterTree(buildStatusTree(DOMAINS, []), { actor: "impl-7" });
		expect(tree.epics.map(e => e.id)).toEqual(["run"]);
		expect(tree.epics[0]!.epics.map(e => e.id)).toEqual(["dom-a"]);
		expect(tree.epics[0]!.epics[0]!.features[0]!.tasks.map(t => t.id)).toEqual(["t2"]);
		expect(tree.epics[0]!.counts).toEqual({ active: 2, ready: 1 });
	});

	test("a role name is routing, not holding, and matches nothing", () => {
		// dom-a and dom-b both route to `architect`; only dom-a is held (by arch-a).
		expect(filterTree(buildStatusTree(DOMAINS, []), { actor: "architect" }).epics).toEqual([]);
		expect(filterTree(buildStatusTree(DOMAINS, []), { actor: "arch-a" }).epics[0]!.epics.map(e => e.id)).toEqual(["dom-a"]);
	});

	test("actor filter reads metadata that arrived as stringified JSON", () => {
		const beads = [
			bead("bd-1", { issue_type: "epic" }),
			bead("bd-2", { issue_type: "feature", parent: "bd-1" }),
			bead("bd-3", { parent: "bd-2", metadata: '{"actor":"rev-3"}' as unknown as Record<string, unknown> }),
		];
		const tree = filterTree(buildStatusTree(beads, []), { actor: "rev-3" });
		expect(tree.epics[0]!.features[0]!.tasks.map(t => t.id)).toEqual(["bd-3"]);
	});

	test("epic filter reports a nested domain epic as the root", () => {
		const tree = filterTree(buildStatusTree(DOMAINS, []), { epic: "dom-b" });
		expect(tree.epics.map(e => e.id)).toEqual(["dom-b"]);
		expect(tree.epics[0]!.features.map(f => f.id)).toEqual(["feat-2"]);
		expect(tree.epics[0]!.counts).toEqual({ ready: 1, claimed: 1 });
		expect(tree.orphans).toEqual([]);
	});

	test("feature filter finds a feature under a nested epic and reports its domain as the root", () => {
		const tree = filterTree(buildStatusTree(DOMAINS, ["t2"]), { feature: "feat-1" });
		expect(tree.epics.map(e => e.id)).toEqual(["dom-a"]);
		expect(tree.epics[0]!.epics).toEqual([]);
		expect(tree.epics[0]!.features.map(f => f.id)).toEqual(["feat-1"]);
		expect(tree.epics[0]!.counts).toEqual({ active: 1, closed: 1, blocked: 1 });
		expect(tree.blocked).toEqual(["t2"]);
	});

	test("a feature outside the named epic matches nothing", () => {
		expect(filterTree(buildStatusTree(DOMAINS, []), { epic: "dom-a", feature: "feat-2" }).epics).toEqual([]);
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

	test("counts nested epics and their work at every depth", () => {
		expect(statusSummaryLine(buildStatusTree(DOMAINS, ["t3"]))).toBe("3 epics · 2 features · 3 tasks · 1 blocked");
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
		expect(text).toContain("1/7 closed"); // features count toward the rollup
		expect(text).toContain("auth login");
		expect(text).not.toContain("hash passwords");
	});

	test("nested epics render indented under the run, blockers named once at the root", () => {
		const text = renderStatus(buildStatusTree(DOMAINS, ["t2", "t3"]), { full: true });
		const lines = text.split("\n");
		expect(lines).toContain("EPIC  run  Run  [active]");
		expect(lines).toContain("  EPIC  dom-a  Auth domain  [active]");
		expect(lines).toContain("  EPIC  dom-b  Billing domain  [ready]");
		expect(lines.filter(line => line.startsWith("  BLOCKED"))).toEqual(["  BLOCKED (2): t2, t3"]);
		expect(text).toContain("actor=impl-7");
		expect(text.indexOf("dom-a")).toBeLessThan(text.indexOf("hash passwords"));
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

describe("empty bd", () => {
	test("no beads builds an empty tree that renders and summarises", () => {
		const tree = buildStatusTree([], []);
		expect(tree).toEqual({ epics: [], orphans: [], blocked: [] });
		expect(renderStatus(tree, { full: true })).toContain("no matching epic, feature, or bead");
	});
});

describe("buildCloseOut", () => {
	const finished = DOMAINS.map(item => ({ ...item, status: "closed", assignee: undefined }));

	test("a finished run with every read answered is clean and renders as one line", () => {
		const tree = buildStatusTree(finished, []);
		const gate = buildCloseOut(finished, tree, ALL_READY);
		expect(gate).toEqual({ cycles: [], in_progress: [], blocked: [], stranded: [], undrainable: [], unlanded: [], clean: true });
		const text = renderStatus(tree, { closeOut: gate });
		expect(text).toEndWith("CLOSE-OUT: clean");
	});

	test("stored status in_progress counts at any depth, whatever state: label the bead carries", () => {
		const beads = [...DOMAINS, bead("t2.1", { parent: "t2", status: "in_progress", labels: ["state:in_review"] })];
		const gate = buildCloseOut(beads, buildStatusTree(beads, []), { ...ALL_READY, ready: ["t3"] });
		expect(gate.in_progress).toEqual(["run", "dom-a", "feat-1", "t2.1"]);
		expect(gate.clean).toBe(false);
	});

	test("blocked unions bd blocked with stored status, and skips finished beads", () => {
		const beads = [...DOMAINS, bead("t4", { parent: "feat-2", status: "blocked" }), bead("t5", { parent: "feat-2", status: "closed" })];
		const gate = buildCloseOut(beads, buildStatusTree(beads, ["t2", "t5"]), { ...ALL_READY, blocked: ["t2", "t5"] });
		expect(gate.blocked).toEqual(["t2", "t4"]);
	});

	test("stranded is open, unassigned, not ready, and not blocked", () => {
		// t2 is open and unassigned yet absent from ready: stranded. dom-b, feat-2 are ready.
		// t3 is claimed. t6 is open and unassigned but blocked, so it is reported once, as blocked.
		const beads = [...DOMAINS, bead("t6", { parent: "feat-2" })];
		const gate = buildCloseOut(beads, buildStatusTree(beads, ["t6"]), { ...ALL_READY, blocked: ["t6"], ready: ["dom-b", "feat-2"] });
		expect(gate.stranded).toEqual(["t2"]);
		expect(gate.blocked).toEqual(["t6"]);
	});

	test("an unanswered ready or cycles read leaves its row unknown and the gate not clean", () => {
		const tree = buildStatusTree(finished, []);
		const noReady = buildCloseOut(finished, tree, { ...ALL_READY, ready: null });
		expect(noReady.stranded).toBeNull();
		expect(noReady.clean).toBe(false);
		expect(renderStatus(tree, { closeOut: noReady })).toContain("stranded: unknown (bd ready did not answer)");

		const noCycles = buildCloseOut(finished, tree, { ...ALL_READY, cycles: null });
		expect(noCycles.clean).toBe(false);
		expect(renderStatus(tree, { closeOut: noCycles })).toContain("cycles: unknown (bd dep cycles did not answer)");
	});

	test("a cycle renders as its path closed on the first member", () => {
		const tree = buildStatusTree(finished, []);
		const gate = buildCloseOut(finished, tree, { ...ALL_READY, cycles: [["t1", "t2"]] });
		expect(gate.clean).toBe(false);
		expect(renderStatus(tree, { closeOut: gate })).toContain("    t1 → t2 → t1");
	});

	test("undrainable names the anchors an open merge bead lacks, store-wide", () => {
		const beads = [
			...finished,
			merge("m-ok"),
			merge("m-bare", { metadata: { branch: undefined, repo: undefined } }),
			merge("m-legacy", { metadata: { origin_bead: undefined, origin: "feat-1" } }),
			merge("m-unlabelled", { labels: [] }),
			bead("m-mislabelled", { labels: ["pr:merge"], metadata: { role: "implementer", repo: "o/r", origin_bead: "feat-1", branch: "b" } }),
			merge("m-closed", { status: "closed", metadata: { branch: undefined } }),
		];
		// The filter drops every merge bead from the tree; the row still reads the store.
		const tree = filterTree(buildStatusTree(beads, []), { epic: "dom-a" });
		const gate = buildCloseOut(beads, tree, ALL_READY);
		expect(gate.undrainable).toEqual([
			{ id: "m-bare", missing: ["repo", "branch"] },
			{ id: "m-unlabelled", missing: ["label pr:merge"] },
			{ id: "m-mislabelled", missing: ["role=shepherd"] },
		]);
		expect(renderStatus(tree, { closeOut: gate })).toContain("undrainable merge beads (3): m-bare (missing repo, branch); ");
	});

	test("unlanded follows the report: a merge bead counts through the feature it captured", () => {
		const beads = [
			...finished,
			merge("m-open", { status: "in_progress" }),
			merge("m-landed", { metadata: { merge_sha: "b".repeat(40) } }),
			merge("m-swept", { metadata: { landing_state: "landed" } }),
			merge("m-closed", { status: "closed" }),
			merge("m-other", { metadata: { origin_bead: "elsewhere" } }),
			merge("m-legacy", { metadata: { origin_bead: undefined, origin: "feat-1", branch: undefined } }),
		];
		const whole = buildCloseOut(beads, buildStatusTree(beads, []), ALL_READY);
		expect(whole.unlanded.map(m => m.id)).toEqual(["m-open", "m-other", "m-legacy"]);

		const domain = filterTree(buildStatusTree(beads, []), { epic: "dom-a" });
		const gate = buildCloseOut(beads, domain, ALL_READY);
		expect(gate.unlanded).toEqual([
			{ id: "m-open", state: "active", branch: "omp/task/m-open" },
			{ id: "m-legacy", state: "ready" },
		]);
		expect(renderStatus(domain, { closeOut: gate })).toContain("unlanded (2): m-open (omp/task/m-open, active); m-legacy (ready)");
	});
});

describe("registered run status", () => {
	function registered() {
		let tool: unknown;
		const zod: unknown = new Proxy(() => zod, { get: () => zod, apply: () => zod });
		registerRunStatus({
			zod,
			registerTool: (value: unknown) => { tool = value; },
		} as unknown as ExtensionAPI);
		return tool as {
			execute(id: string, params: { epic?: string; full?: boolean }): Promise<{
				isError?: boolean;
				content: { text: string }[];
				details: { incomplete?: boolean; blocked: string[] | null; closeOut?: { stranded: string[] | null; cycles: string[][] | null; clean: boolean } };
			}>;
		};
	}

	test("reports a run and its tasks beyond the default first 50 beads", async () => {
		const beads = [
			...Array.from({ length: 50 }, (_, index) => bead(`unrelated-${index}`)),
			bead("late-run", { issue_type: "epic" }),
			bead("late-task", { parent: "late-run", title: "Late task" }),
		];
		const spawn = spyOn(Bun, "spawn").mockImplementation((...args) => {
			const argv = args[0] as string[];
			const limitIndex = argv.indexOf("--limit");
			const limit = limitIndex === -1 ? 50 : Number(argv[limitIndex + 1]);
			const payload = argv.includes("blocked") ? [] : limit === 0 ? beads : beads.slice(0, limit);
			return {
				stdout: new Response(JSON.stringify(payload)).body,
				stderr: new Response("").body,
				exited: Promise.resolve(0),
				kill: () => { },
			} as unknown as Bun.Subprocess;
		});
		try {
			const result = await registered().execute("late-run", { epic: "late-run", full: true });
			expect(result.isError).not.toBe(true);
			expect(result.content[0]?.text).toContain("late-run");
			expect(result.content[0]?.text).toContain("late-task");
			expect(result.content[0]?.text).toContain("ready 1");
			expect(result.content[0]?.text).not.toContain("unrelated-");
		} finally {
			spawn.mockRestore();
		}
	});

	test("the close-out gate reads bd ready with wisps and bd dep cycles, and lands in the details", async () => {
		const beads = [bead("run", { issue_type: "epic" }), bead("pulled", { parent: "run" }), bead("stuck", { parent: "run" })];
		const argvs: string[][] = [];
		const spawn = spyOn(Bun, "spawn").mockImplementation((...args) => {
			const argv = args[0] as string[];
			argvs.push(argv);
			let payload: unknown = beads;
			if (argv.includes("blocked")) payload = [];
			else if (argv.includes("ready")) payload = beads.filter(item => item.id !== "stuck");
			else if (argv.includes("cycles")) payload = [[{ id: "pulled" }, { id: "stuck" }]];
			return {
				stdout: new Response(JSON.stringify(payload)).body,
				stderr: new Response("").body,
				exited: Promise.resolve(0),
				kill: () => { },
			} as unknown as Bun.Subprocess;
		});
		try {
			const result = await registered().execute("gate", {});
			expect(result.isError).not.toBe(true);
			expect(argvs.find(argv => argv.includes("ready"))).toEqual(["bd", "ready", "--include-ephemeral", "--limit", "0", "--json"]);
			expect(argvs.find(argv => argv.includes("cycles"))).toEqual(["bd", "dep", "cycles", "--json"]);
			expect(result.details.closeOut).toMatchObject({ stranded: ["stuck"], cycles: [["pulled", "stuck"]], clean: false });
			expect(result.content[0]?.text).toContain("CLOSE-OUT: not clean");
			expect(result.content[0]?.text).toContain("stranded (1): stuck");
		} finally {
			spawn.mockRestore();
		}
	});

	test("each invocation owns a fresh budget", async () => {
		const spawn = spyOn(Bun, "spawn").mockImplementation((...args) => {
			const argv = args[0] as string[];
			const payload = argv.includes("blocked") ? [] : [bead("bd-task")];
			return {
				stdout: new Response(JSON.stringify(payload)).body,
				stderr: new Response("").body,
				exited: Promise.resolve(0),
				kill: () => { },
			} as unknown as Bun.Subprocess;
		});
		try {
			const tool = registered();
			for (let i = 0; i < 15; i++) {
				const result = await tool.execute(String(i), {});
				expect(result.isError).not.toBe(true);
				expect(result.content[0]?.text).toContain("ready 1");
			}
		} finally {
			spawn.mockRestore();
		}
	});

	test.each([
		{ code: 1, stdout: "[]" },
		{ code: 0, stdout: "not json" },
		{ code: 0, stdout: '[{"id":"bd-task"},{}]' },
	])("unknown blockers never produce readiness: %j", async blocked => {
		const spawn = spyOn(Bun, "spawn").mockImplementation((...args) => {
			const argv = args[0] as string[];
			return {
				stdout: new Response(argv.includes("blocked") ? blocked.stdout : JSON.stringify([bead("bd-task")])).body,
				stderr: new Response("").body,
				exited: Promise.resolve(argv.includes("blocked") ? blocked.code : 0),
				kill: () => { },
			} as unknown as Bun.Subprocess;
		});
		try {
			const result = await registered().execute("unknown", {});
			expect(result.isError).toBe(true);
			expect(result.details.incomplete).toBe(true);
			expect(result.details.blocked).toBeNull();
			expect(result.content[0]?.text).not.toContain("ready 1");
		} finally {
			spawn.mockRestore();
		}
	});
});
