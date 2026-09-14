import { describe, expect, test } from "bun:test";
import { acceptanceHash } from "../src/acceptance";
import type { BdBead, BdComment } from "../src/bd";
import { buildHygiene, buildStatusTree, type Containment, hygieneCandidates, renderStatus } from "../src/tools/run-status";

/** A bead in the shape `bd list --status all --json` returns. */
function bead(id: string, fields: Partial<BdBead> & Record<string, unknown> = {}): BdBead {
	return { id, title: id, status: "open", issue_type: "task", ...fields };
}

const NODE = ["orc-node"];

function reads(comments: Record<string, BdComment[] | null> = {}, containment: Record<string, Containment> = {}) {
	return { comments: new Map(Object.entries(comments)), containment: new Map(Object.entries(containment)) };
}

function hygiene(beads: BdBead[], r = reads()) {
	return buildHygiene(beads, buildStatusTree(beads, []), r);
}

const BASE: BdBead[] = [
	bead("run", { issue_type: "epic", status: "in_progress" }),
	bead("feat", { issue_type: "feature", parent: "run", status: "in_progress", metadata: { branch: "feat/x" } }),
];

describe("graph rows", () => {
	test("an open node under a closed parent names the reopen", () => {
		const rows = hygiene([
			bead("run", { issue_type: "epic" }),
			bead("feat", { issue_type: "feature", parent: "run", status: "closed" }),
			bead("t1", { parent: "feat", labels: NODE, status: "in_progress" }),
		]);
		expect(rows).toEqual([{ kind: "closed-parent-open-child", id: "t1", detail: "parent feat is closed", recovery: "bd reopen feat" }]);
	});

	test("a feature whose every child closed is reported; one open child silences it", () => {
		const closedChildren = [...BASE, bead("t1", { parent: "feat", labels: NODE, status: "closed" }), bead("t2", { parent: "feat", labels: NODE, status: "closed" })];
		expect(hygiene(closedChildren).map(row => row.kind)).toEqual(["feature-children-closed"]);
		const oneOpen = [...BASE, bead("t1", { parent: "feat", labels: NODE, status: "closed" }), bead("t2", { parent: "feat", labels: NODE })];
		expect(hygiene(oneOpen)).toEqual([]);
	});

	test("a node with no feature or epic above it is an orphan, whether parentless or dangling", () => {
		const rows = hygiene([
			bead("run", { issue_type: "epic" }),
			bead("loose", { labels: NODE }),
			bead("dangling", { labels: NODE, parent: "gone" }),
			bead("chained", { labels: NODE, parent: "helper" }),
			bead("helper", { issue_type: "chore" }),
		]);
		expect(rows.map(row => [row.kind, row.id, row.detail])).toEqual([
			["orphan-node", "loose", "no parent"],
			["orphan-node", "dangling", "parent gone is not in the store"],
			["orphan-node", "chained", "no feature or epic above it"],
		]);
	});

	test("a blocked node with dependents strands them", () => {
		const rows = hygiene([...BASE, bead("t1", { parent: "feat", labels: NODE, status: "blocked", dependent_count: 2 })]);
		expect(rows).toEqual([{ kind: "stranded-behind-failed", id: "t1", detail: "2 dependents wait behind a blocked node", recovery: "bd dep tree t1" }]);
	});
});

describe("acceptance rows", () => {
	test("a routed node without acceptance is reported; one with acceptance is not", () => {
		const rows = hygiene([
			...BASE,
			bead("t1", { parent: "feat", labels: NODE, metadata: { role: "implementer" } }),
			bead("t2", { parent: "feat", labels: NODE, metadata: { role: "implementer" }, acceptance_criteria: "1. done" }),
			bead("t3", { parent: "feat", labels: NODE, metadata: { role: "reviewer" } }),
		]);
		expect(rows).toEqual([{ kind: "no-acceptance", id: "t1", detail: "routed with no acceptance criteria", recovery: 'bd update t1 --acceptance "1. ..." --status open' }]);
	});

	test("a deferred node the gate released is told apart by its NOTE", () => {
		const beads = [...BASE, bead("t1", { parent: "feat", labels: NODE, status: "deferred", metadata: { role: "researcher" } })];
		const released = hygiene(beads, reads({ t1: [{ text: "NOTE no-acceptance: released by gate; architect adds --acceptance and reopens with --status open" }] }));
		expect(released[0]?.kind).toBe("deferred-no-acceptance");
		const merelyDeferred = hygiene(beads, reads({ t1: [] }));
		expect(merelyDeferred[0]?.kind).toBe("no-acceptance");
	});
});

describe("landing rows", () => {
	test("a landed merge bead still open is reported with its attempts", () => {
		const rows = hygiene([
			...BASE,
			bead("m1", { labels: ["pr:merge"], parent: "run", metadata: { landing_state: "landed", merge_sha: "abcdef1234567", close_attempts: 3 } }),
		]);
		expect(rows).toEqual([{ kind: "landed-but-open", id: "m1", detail: "merge_sha abcdef1 stamped, close not proven after 3 attempts; the sweep retries" }]);
	});

	test("a landed uncovered node asks for an override until its wisp is open", () => {
		const uncovered = [{ text: "NOTE landed uncovered: merge=m1 head=abc" }];
		const beads = [...BASE, bead("t1", { parent: "feat", labels: NODE, status: "in_progress" })];
		expect(hygiene(beads, reads({ t1: uncovered })).map(row => [row.kind, row.recovery])).toEqual([
			["landed-uncovered", 'bd comment t1 "NOTE override requested: <reason>"'],
		]);
		const withWisp = [...beads, bead("w1", { parent: "t1", ephemeral: true, metadata: { role: "reviewer", dimension: "override", origin_bead: "t1" } })];
		expect(hygiene(withWisp, reads({ t1: uncovered })).map(row => row.kind)).toEqual(["override-pending"]);
	});

	test("a lead override close is surfaced from the close reason or a NOTE", () => {
		const open = bead("t0", { parent: "feat", labels: NODE });
		const byReason = [...BASE, open, bead("t1", { parent: "feat", labels: NODE, status: "closed", close_reason: "override: accepted by hand" })];
		expect(hygiene(byReason).map(row => [row.kind, row.detail])).toEqual([["lead-override", "override: accepted by hand"]]);
		const byNote = [...BASE, open, bead("t2", { parent: "feat", labels: NODE, status: "closed" })];
		expect(hygiene(byNote, reads({ t2: [{ text: "NOTE closed by lead override: no reviewer available" }] })).map(row => row.kind)).toEqual(["lead-override"]);
		expect(hygiene(byNote, reads({ t2: [{ text: "LANDED abc merge=m1" }] }))).toEqual([]);
	});
});

describe("containment rows", () => {
	const pushed = [...BASE, bead("t1", { parent: "feat", labels: NODE, status: "in_progress", metadata: { pushed_sha: "1234567abcdef" } })];

	test("uncontained and unverified pushed refs are reported; contained ones are silent", () => {
		expect(hygiene(pushed, reads({}, { t1: "uncontained" })).map(row => [row.kind, row.detail])).toEqual([["not-integrated", "pushed 1234567 is not in the feature branch"]]);
		expect(hygiene(pushed, reads({}, { t1: "unverified" })).map(row => row.kind)).toEqual(["integration-unverified"]);
		expect(hygiene(pushed, reads({}, { t1: "contained" }))).toEqual([]);
	});

	test("candidates are only the beads whose comments or containment a row can use", () => {
		const beads = [
			...pushed,
			bead("t2", { parent: "feat", labels: NODE }),
			bead("t3", { parent: "feat", labels: NODE, status: "deferred" }),
			bead("m1", { labels: ["pr:merge"], metadata: { landing_state: "landed" } }),
			bead("m2", { labels: ["pr:merge"], status: "closed", metadata: { landing_state: "landed" } }),
		];
		const candidates = hygieneCandidates(beads);
		expect(candidates.containment).toEqual(["t1"]);
		expect([...new Set(candidates.comments)].sort()).toEqual(["m1", "t1", "t3"]);
	});
});

describe("rendering", () => {
	test("the section is clean with no rows and lists each row with its recovery", () => {
		const tree = buildStatusTree(BASE, []);
		expect(renderStatus(tree, { hygiene: [] })).toContain("HYGIENE: clean");
		const rows = hygiene([...BASE, bead("t1", { parent: "feat", labels: NODE, metadata: { role: "implementer" } })]);
		const text = renderStatus(tree, { hygiene: rows });
		expect(text).toContain("HYGIENE: 1 finding");
		expect(text).toContain(`  no-acceptance t1: routed with no acceptance criteria -> bd update t1 --acceptance "1. ..." --status open`);
	});

	test("hashes in acceptance are recomputed from the live field, so the row needs no stored hash", () => {
		// A node with acceptance text carries no hash anywhere; the row logic asks only whether text exists.
		const withText = bead("t1", { parent: "feat", labels: NODE, metadata: { role: "implementer" }, acceptance_criteria: "1. a\r\n2. b  " });
		expect(hygiene([...BASE, withText])).toEqual([]);
		expect(acceptanceHash("1. a\n2. b")).toBe(acceptanceHash("1. a\r\n2. b  "));
	});
});
