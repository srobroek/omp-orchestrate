import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BdBead } from "../src/bd";
import {
	capabilityQueryArgv,
	checkEntries,
	classifyChecks,
	conflictRole,
	type LandingCapabilities,
	landingSweep,
	parseCapabilities,
	prListArgv,
	prViewArgv,
	probeLandingCapabilities,
	recordLandingCapabilities,
	recordedCapabilities,
	repoOfRemote,
	resetLanding,
	selectMode,
} from "../src/landing";
import type { Exec, ExecResult } from "../src/tools/bot-review-probe";

const H = "a".repeat(40);
const OTHER = "b".repeat(40);
const BASE = "c".repeat(40);
const TREE = "d".repeat(40);
const REFRESHED = "e".repeat(40);
const MERGE_SHA = "f".repeat(40);
const REPO = "o/r";
const RUN = "orc-run";
const MERGE = "orc-m1";
const ORIGIN = "orc-f1";

function out(stdout: string, code = 0, stderr = ""): ExecResult {
	return { code, stdout, stderr };
}

/**
 * Answer `gh`/`git` from rules matched in order; the first predicate that accepts the
 * argv answers it. Anything unscripted fails loudly, as a non-zero exit that names it.
 */
function script(rules: Array<[(argv: string[]) => boolean, ExecResult | (() => ExecResult)]>): { exec: Exec; calls: string[][] } {
	const calls: string[][] = [];
	const exec: Exec = async (argv) => {
		calls.push(argv);
		for (const [when, then] of rules) {
			if (when(argv)) return typeof then === "function" ? then() : then;
		}
		return { code: 1, stdout: "", stderr: `unexpected argv: ${argv.join(" ")}` };
	};
	return { exec, calls };
}

const argvIs = (expected: string[]) => (argv: string[]) => argv.join(" ") === expected.join(" ");
const gitVerb = (verb: string) => (argv: string[]) => argv[0] === "git" && argv.includes(verb);

/** A capability payload as `gh api graphql` prints it. */
function capabilityPayload(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		data: {
			repository: {
				autoMergeAllowed: false,
				squashMergeAllowed: true,
				viewerPermission: "ADMIN",
				mergeQueue: null,
				ref: { branchProtectionRule: null },
				rulesets: { nodes: [] },
				...overrides,
			},
		},
	});
}

function caps(overrides: Partial<LandingCapabilities> = {}): LandingCapabilities {
	return {
		repo: REPO,
		base: "main",
		mode: "direct",
		auto_merge_allowed: false,
		squash_allowed: true,
		required_checks: [],
		strict: false,
		queue: false,
		probed_at: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

interface PrFixture {
	number?: number;
	state?: string;
	isDraft?: boolean;
	headRefOid?: string;
	mergeStateStatus?: string;
	autoMergeRequest?: unknown;
	statusCheckRollup?: unknown[];
	mergeCommit?: { oid: string } | null;
}

function pr(fixture: PrFixture = {}): Record<string, unknown> {
	return {
		number: 7,
		state: "OPEN",
		isDraft: false,
		headRefOid: H,
		headRefName: "feat",
		baseRefName: "main",
		mergeStateStatus: "CLEAN",
		autoMergeRequest: null,
		statusCheckRollup: [],
		mergeCommit: null,
		...fixture,
	};
}

const green = (name: string) => ({ __typename: "CheckRun", name, status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: `https://github.com/o/r/actions/runs/500/job/1` });
const failing = (name: string, run = "123") => ({ __typename: "CheckRun", name, status: "COMPLETED", conclusion: "FAILURE", detailsUrl: `https://github.com/o/r/actions/runs/${run}/job/2` });
const running = (name: string) => ({ __typename: "CheckRun", name, status: "IN_PROGRESS", conclusion: null, detailsUrl: `https://github.com/o/r/actions/runs/501/job/3` });

// ============================================================================
// bd
// ============================================================================

interface FakeStore {
	beads: Record<string, BdBead>;
	blocked: string[];
	/** Every mutating argv, first word onward. */
	writes: string[][];
	nextId: string;
	restore: () => void;
}

/**
 * A `bd` on the spawn seam. Reads answer from `beads`; `update --metadata` merges into
 * the bead as bd does, so a second sweep reads what the first stamped; `create` answers
 * `nextId` as `--silent` prints it.
 */
function fakeBd(beads: Record<string, BdBead>, blocked: string[] = []): FakeStore {
	const store: FakeStore = { beads, blocked, writes: [], nextId: "orc-fix1", restore: () => { } };
	const spawn = spyOn(Bun, "spawn").mockImplementation(((argv: string[]) => {
		const args = argv.slice(1);
		let payload: unknown;
		let code = 0;
		let text: string | undefined;
		switch (args[0]) {
			case "list":
				payload = args.includes("pr:merge") ? Object.values(store.beads).filter(bead => bead.labels?.includes("pr:merge")) : [];
				break;
			case "blocked":
				payload = store.blocked.map(id => ({ id }));
				break;
			case "show":
				payload = store.beads[args[1]!] === undefined ? undefined : [store.beads[args[1]!]];
				if (payload === undefined) code = 1;
				break;
			case "update": {
				store.writes.push(args);
				const bead = store.beads[args[1]!];
				const flag = args.indexOf("--metadata");
				if (bead !== undefined && flag !== -1) {
					bead.metadata = { ...bead.metadata, ...(JSON.parse(args[flag + 1]!) as Record<string, unknown>) };
				}
				text = "";
				break;
			}
			case "create":
				store.writes.push(args);
				text = `${store.nextId}\n`;
				break;
			case "comment":
			case "close":
				store.writes.push(args);
				text = "";
				break;
			default:
				code = 1;
		}
		return {
			stdout: new Response(text ?? (payload === undefined ? "" : JSON.stringify(payload))).body,
			stderr: new Response("").body,
			exited: Promise.resolve(code),
			kill: () => { },
		} as unknown as Bun.Subprocess;
	}) as unknown as typeof Bun.spawn);
	store.restore = () => spawn.mockRestore();
	return store;
}

function mergeBead(metadata: Record<string, unknown> = {}): BdBead {
	return {
		id: MERGE,
		status: "open",
		labels: ["pr:merge"],
		metadata: { repo: REPO, pr: 7, head_sha: H, branch: "feat", origin_bead: ORIGIN, role: "shepherd", ...metadata },
	};
}

/** The run epic; `null` records no landing capabilities. */
function runEpic(recorded: LandingCapabilities | null = caps()): BdBead {
	return { id: RUN, status: "open", issue_type: "epic", metadata: recorded === null ? {} : { landing: recorded } };
}

/** The origin feature; `null` declares no scope. */
function origin(scope: unknown = ["src/api/*"]): BdBead {
	return { id: ORIGIN, status: "in_progress", issue_type: "epic", metadata: scope === null ? {} : { scope } };
}

/** Comments written on `id`, verb-first, in order. */
function commentsOn(store: FakeStore, id: string): string[] {
	return store.writes.filter(args => args[0] === "comment" && args[1] === id).map(args => args[2]!);
}

function metadataWrites(store: FakeStore, id: string): Array<Record<string, unknown>> {
	return store.writes
		.filter(args => args[0] === "update" && args[1] === id && args.includes("--metadata"))
		.map(args => JSON.parse(args[args.indexOf("--metadata") + 1]!) as Record<string, unknown>);
}

let cwd: string;
let store: FakeStore | undefined;

beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), "orc-landing-test-"));
	resetLanding();
});

afterEach(async () => {
	store?.restore();
	store = undefined;
	await rm(cwd, { recursive: true, force: true });
});

// ============================================================================
// Capabilities
// ============================================================================

describe("capabilities", () => {
	test("auto needs both auto-merge and a required check", () => {
		expect(selectMode({ auto_merge_allowed: true, required_checks: ["ci"] })).toBe("auto");
		expect(selectMode({ auto_merge_allowed: true, required_checks: [] })).toBe("direct");
		expect(selectMode({ auto_merge_allowed: false, required_checks: ["ci"] })).toBe("direct");
	});

	test("reads the protection rule and active rulesets covering the base into one required set", () => {
		const parsed = parseCapabilities(JSON.parse(capabilityPayload({
			autoMergeAllowed: true,
			ref: { branchProtectionRule: { requiredStatusCheckContexts: ["ts"], requiresStrictStatusChecks: true } },
			rulesets: {
				nodes: [
					{
						enforcement: "ACTIVE", target: "BRANCH", conditions: { refName: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
						rules: { nodes: [
							{ type: "REQUIRED_STATUS_CHECKS", parameters: { strictRequiredStatusChecksPolicy: false, requiredStatusChecks: [{ context: "py" }, { context: "ts" }] } },
							{ type: "MERGE_QUEUE", parameters: null },
						] },
					},
					{
						// Disabled, and on another branch: contributes nothing.
						enforcement: "DISABLED", target: "BRANCH", conditions: { refName: { include: ["refs/heads/release"], exclude: [] } },
						rules: { nodes: [{ type: "REQUIRED_STATUS_CHECKS", parameters: { requiredStatusChecks: [{ context: "never" }] } }] },
					},
				],
			},
		})), REPO, "main", "2026-01-01T00:00:00.000Z");
		expect(parsed).toEqual(caps({ mode: "auto", auto_merge_allowed: true, required_checks: ["py", "ts"], strict: true, queue: true, viewer_permission: "ADMIN" }));
	});

	test("a payload without the repository fields is no capability set", () => {
		expect(parseCapabilities({ data: { repository: null } }, REPO, "main", "t")).toBeUndefined();
		expect(parseCapabilities({ data: { repository: { autoMergeAllowed: "yes" } } }, REPO, "main", "t")).toBeUndefined();
	});

	test("the probe is one GraphQL read and reports gh failures as errors, never as direct", async () => {
		const query = capabilityQueryArgv(REPO, "main")!;
		const ok = script([[argvIs(query), out(capabilityPayload({ autoMergeAllowed: true }))]]);
		const probed = await probeLandingCapabilities(REPO, "main", ok.exec, cwd, () => 0);
		expect(probed).toEqual({ ok: true, caps: caps({ auto_merge_allowed: true, viewer_permission: "ADMIN", probed_at: "1970-01-01T00:00:00.000Z" }) });
		expect(ok.calls).toHaveLength(1);

		const failed = script([[argvIs(query), out("", 1, "gh: not logged in")]]);
		expect(await probeLandingCapabilities(REPO, "main", failed.exec, cwd)).toEqual({ ok: false, error: "gh api graphql exited 1: gh: not logged in" });
		expect(await probeLandingCapabilities("not-a-repo", "main", failed.exec, cwd)).toMatchObject({ ok: false });
	});

	test("the recorded set is re-derived, so a hand-written auto without a required check is direct", () => {
		expect(recordedCapabilities(runEpic(caps({ mode: "auto", auto_merge_allowed: true })))?.mode).toBe("direct");
		expect(recordedCapabilities(runEpic(caps({ mode: "direct", auto_merge_allowed: true, required_checks: ["ci"] })))?.mode).toBe("auto");
		expect(recordedCapabilities(runEpic(null))).toBeUndefined();
		expect(recordedCapabilities(null)).toBeUndefined();
	});

	test("recording stamps metadata.landing on the run epic and advises an admin on a direct repository", async () => {
		store = fakeBd({ [RUN]: { id: RUN, status: "open", metadata: { primary_branch: "main" } } });
		const { exec } = script([
			[argvIs(["gh", "repo", "view", "--json", "nameWithOwner,defaultBranchRef"]), out(JSON.stringify({ nameWithOwner: REPO, defaultBranchRef: { name: "trunk" } }))],
			[argvIs(capabilityQueryArgv(REPO, "main")!), out(capabilityPayload())],
		]);
		const recorded = await recordLandingCapabilities(cwd, RUN, exec);
		expect(recorded.ok).toBe(true);
		if (!recorded.ok) return;
		expect(recorded.level).toBe("info");
		expect(recorded.notice).toContain("landing mode direct for o/r (main)");
		expect(recorded.notice).toContain("allow_auto_merge=true");
		expect(metadataWrites(store, RUN)).toEqual([{ landing: recorded.caps }]);
	});

	test("recording warns when squash merges are off, and fails without a repository", async () => {
		store = fakeBd({ [RUN]: { id: RUN, status: "open" } });
		const off = script([
			[argvIs(["gh", "repo", "view", "--json", "nameWithOwner,defaultBranchRef"]), out(JSON.stringify({ nameWithOwner: REPO, defaultBranchRef: { name: "main" } }))],
			[argvIs(capabilityQueryArgv(REPO, "main")!), out(capabilityPayload({ squashMergeAllowed: false }))],
		]);
		const recorded = await recordLandingCapabilities(cwd, RUN, off.exec);
		expect(recorded).toMatchObject({ ok: true, level: "warning" });
		if (recorded.ok) expect(recorded.notice).toContain("squash merges are disabled");

		const noRepo = script([[argvIs(["gh", "repo", "view", "--json", "nameWithOwner,defaultBranchRef"]), out("", 1, "no git remotes found")]]);
		expect(await recordLandingCapabilities(cwd, RUN, noRepo.exec)).toEqual({ ok: false, error: "gh repo view failed: no git remotes found" });
	});
});

// ============================================================================
// Checks
// ============================================================================

describe("checks", () => {
	test("reads check runs and status contexts; anything unfinished or unrecognised is not green", () => {
		expect(checkEntries([
			green("ts"),
			failing("py", "77"),
			running("lint"),
			{ __typename: "StatusContext", context: "ci/legacy", state: "SUCCESS", targetUrl: "https://ci/1" },
			{ __typename: "StatusContext", context: "ci/pending", state: "PENDING" },
			{ __typename: "StatusContext", context: "ci/error", state: "ERROR" },
			{ __typename: "CheckRun", name: "odd", status: "COMPLETED", conclusion: null },
			"not an object",
		])).toEqual([
			{ name: "ts", state: "green", url: "https://github.com/o/r/actions/runs/500/job/1", runId: "500" },
			{ name: "py", state: "failing", url: "https://github.com/o/r/actions/runs/77/job/2", runId: "77" },
			{ name: "lint", state: "pending", url: "https://github.com/o/r/actions/runs/501/job/3", runId: "501" },
			{ name: "ci/legacy", state: "green", url: "https://ci/1" },
			{ name: "ci/pending", state: "pending" },
			{ name: "ci/error", state: "failing" },
			{ name: "odd", state: "failing" },
		]);
	});

	test("pending outranks failing, the required set filters, and an unreported required check is pending", () => {
		const entries = checkEntries([green("ts"), failing("py"), running("lint")]);
		expect(classifyChecks(entries, []).state).toBe("pending");
		expect(classifyChecks(checkEntries([green("ts"), failing("py")]), [])).toMatchObject({ state: "failing", failing: [{ name: "py" }] });
		expect(classifyChecks(entries, ["ts"]).state).toBe("green");
		expect(classifyChecks(entries, ["py"]).state).toBe("failing");
		expect(classifyChecks(entries, ["ts", "docs"]).state).toBe("pending");
		expect(classifyChecks([], []).state).toBe("green");
	});
});

describe("routing", () => {
	test("a conflicting path outside the origin's scope routes to the architect", () => {
		expect(conflictRole(["src/api/a.ts", "src/api/deep/b.ts"], ["src/api/*"])).toBe("implementer");
		expect(conflictRole(["src/api/a.ts", "README.md"], ["src/api/*"])).toBe("architect");
		expect(conflictRole(["anything"], [])).toBe("implementer");
		expect(conflictRole(["src/api/handler.ts"], ["src/api"])).toBe("implementer");
	});

	test("repoOfRemote reads both remote spellings", () => {
		expect(repoOfRemote("git@github.com:O/R.git\n")).toBe("o/r");
		expect(repoOfRemote("https://github.com/o/r")).toBe("o/r");
		expect(repoOfRemote("https://github.com/o/r.git/")).toBe("o/r");
		expect(repoOfRemote("https://gitlab.com/o/r.git")).toBeUndefined();
	});
});

// ============================================================================
// The sweep
// ============================================================================

/** A sweep against one merge bead, the run epic and the origin, with `gh`/`git` scripted. */
function rig(options: {
	beads?: Record<string, BdBead>;
	blocked?: string[];
	recorded?: LandingCapabilities;
	open?: Array<Record<string, unknown>>;
	rules?: Array<[(argv: string[]) => boolean, ExecResult | (() => ExecResult)]>;
	view?: Record<string, unknown>;
} = {}) {
	store = fakeBd(
		options.beads ?? { [RUN]: runEpic(options.recorded), [MERGE]: mergeBead(), [ORIGIN]: origin() },
		options.blocked,
	);
	const rules: Array<[(argv: string[]) => boolean, ExecResult | (() => ExecResult)]> = [
		[argvIs(prListArgv(REPO)), out(JSON.stringify(options.open ?? [pr()]))],
		...(options.rules ?? []),
	];
	if (options.view !== undefined) rules.push([argvIs(prViewArgv(REPO, 7)), out(JSON.stringify(options.view))]);
	const { exec, calls } = script(rules);
	const sweep = () => landingSweep({ cwd, runId: RUN, exec, now: () => Date.UTC(2026, 0, 1) });
	const gh = (verb: string) => calls.filter(argv => argv[0] === "gh" && argv[1] === "pr" && argv[2] === verb);
	return { sweep, calls, gh, store: store! };
}

const MERGE_DIRECT = ["gh", "pr", "merge", "7", "--repo", REPO, "--squash", "--match-head-commit", H];
const MERGE_AUTO = ["gh", "pr", "merge", "7", "--repo", REPO, "--auto", "--squash", "--match-head-commit", H];

describe("landingSweep: direct mode", () => {
	test("merges on CLEAN at the reviewed head, reads the merge back, and records LANDED once", async () => {
		const merged = pr({ state: "MERGED", mergeCommit: { oid: MERGE_SHA } });
		const r = rig({
			open: [pr({ statusCheckRollup: [green("ts")] })],
			rules: [[argvIs(MERGE_DIRECT), out("")], [argvIs(prViewArgv(REPO, 7)), out(JSON.stringify(merged))]],
		});
		expect(await r.sweep()).toEqual([{ bead: MERGE, pr: 7, outcome: "merged" }]);
		expect(r.gh("merge")).toEqual([MERGE_DIRECT]);
		expect(commentsOn(r.store, MERGE)).toEqual([`LANDED ${MERGE_SHA} pr=7 head=${H.slice(0, 7)}`]);
		expect(commentsOn(r.store, ORIGIN)).toEqual([`LANDED ${MERGE_SHA} pr=7 head=${H.slice(0, 7)} merge=${MERGE}`]);
		expect(metadataWrites(r.store, MERGE)).toEqual([{ landing_state: "landed", merge_sha: MERGE_SHA, landed_head: H }]);
		expect(r.store.writes.filter(args => args[0] === "close")).toEqual([["close", MERGE, "--reason", `LANDED ${MERGE_SHA}`]]);
	});

	test("waits on UNSTABLE with checks still running, and on UNKNOWN, writing nothing", async () => {
		const r = rig({ open: [pr({ mergeStateStatus: "UNSTABLE", statusCheckRollup: [running("ts")] })] });
		expect(await r.sweep()).toEqual([{ bead: MERGE, pr: 7, outcome: "pending" }]);
		const unknown = rig({ open: [pr({ mergeStateStatus: "UNKNOWN" })] });
		expect(await unknown.sweep()).toEqual([{ bead: MERGE, pr: 7, outcome: "unknown" }]);
		expect(r.gh("merge")).toEqual([]);
		expect(r.store.writes).toEqual([]);
		expect(unknown.store.writes).toEqual([]);
	});

	test("never merges a head that is not the reviewed one, and says so once", async () => {
		const r = rig({ open: [pr({ headRefOid: OTHER, statusCheckRollup: [green("ts")] })] });
		expect(await r.sweep()).toEqual([{ bead: MERGE, pr: 7, outcome: "blocked" }]);
		expect(await r.sweep()).toEqual([{ bead: MERGE, pr: 7, outcome: "blocked" }]);
		expect(r.gh("merge")).toEqual([]);
		expect(commentsOn(r.store, MERGE)).toEqual([
			`BLOCKED landing: PR #7 head ${OTHER.slice(0, 7)} is not the reviewed head ${H.slice(0, 7)}; re-review and stamp head_sha`,
		]);
	});

	test("a draft, a blocked merge bead and a landed one are left alone", async () => {
		const r = rig({ open: [pr({ isDraft: true, statusCheckRollup: [green("ts")] })] });
		expect(await r.sweep()).toEqual([{ bead: MERGE, pr: 7, outcome: "draft" }]);
		expect(r.store.writes).toEqual([]);

		const blocked = rig({ blocked: [MERGE] });
		expect(await blocked.sweep()).toEqual([{ bead: MERGE, outcome: "skipped" }]);
		expect(blocked.calls).toEqual([]);
	});

	test("a merge bead without pr, repo or head_sha is reported once and never polled", async () => {
		const r = rig({ beads: { [RUN]: runEpic(), [MERGE]: mergeBead({ pr: undefined, head_sha: "short" }) } });
		expect(await r.sweep()).toEqual([{ bead: MERGE, outcome: "blocked", detail: "missing pr, head_sha" }]);
		await r.sweep();
		expect(commentsOn(r.store, MERGE)).toEqual([`BLOCKED landing: merge bead ${MERGE} lacks metadata pr, head_sha; the sweep cannot land it`]);
		expect(r.calls).toEqual([]);
	});

	test("a PR gone from the open list is viewed; merged lands, closed bounces", async () => {
		const r = rig({ open: [], view: pr({ state: "MERGED", headRefOid: H, mergeCommit: { oid: MERGE_SHA } }) });
		expect(await r.sweep()).toEqual([{ bead: MERGE, pr: 7, outcome: "merged" }]);
		expect(commentsOn(r.store, MERGE)).toEqual([`LANDED ${MERGE_SHA} pr=7 head=${H.slice(0, 7)}`]);

		const closed = rig({ open: [], view: pr({ state: "CLOSED" }) });
		expect(await closed.sweep()).toEqual([{ bead: MERGE, pr: 7, outcome: "closed" }]);
		expect(commentsOn(closed.store, MERGE)[0]).toStartWith("BOUNCED reason=closed pr=7");
		expect(closed.store.writes.find(args => args[0] === "update")).toEqual(["update", MERGE, "--metadata", JSON.stringify({ landing_state: "closed" }), "--status", "blocked"]);
	});

	test("a merge landed under a moved head is LANDED UNGUARDED with a review note on the origin", async () => {
		const r = rig({ open: [], view: pr({ state: "MERGED", headRefOid: OTHER, mergeCommit: { oid: MERGE_SHA } }) });
		expect(await r.sweep()).toEqual([{ bead: MERGE, pr: 7, outcome: "merged" }]);
		expect(commentsOn(r.store, MERGE)).toEqual([`LANDED ${MERGE_SHA} pr=7 head=${OTHER.slice(0, 7)} UNGUARDED reviewed=${H.slice(0, 7)}`]);
		expect(commentsOn(r.store, ORIGIN).at(-1)).toContain("review the landed diff");
	});

	test("a refused gh merge is a BLOCKED notice, not a retry storm", async () => {
		const r = rig({
			open: [pr({ statusCheckRollup: [green("ts")] })],
			rules: [[argvIs(MERGE_DIRECT), out("", 1, "GraphQL: Head branch was modified")]],
		});
		expect(await r.sweep()).toEqual([{ bead: MERGE, pr: 7, outcome: "blocked" }]);
		await r.sweep();
		expect(r.gh("merge")).toHaveLength(2);
		expect(commentsOn(r.store, MERGE)).toEqual([`BLOCKED landing: gh pr merge refused PR #7 at ${H.slice(0, 7)}: GraphQL: Head branch was modified`]);
	});

	test("BLOCKED by branch rules with checks green is reported, never forced", async () => {
		const r = rig({ open: [pr({ mergeStateStatus: "BLOCKED", statusCheckRollup: [green("ts")] })] });
		expect(await r.sweep()).toEqual([{ bead: MERGE, pr: 7, outcome: "blocked" }]);
		expect(r.gh("merge")).toEqual([]);
		expect(commentsOn(r.store, MERGE)[0]).toContain("blocked by branch rules");
	});
});

describe("landingSweep: auto mode", () => {
	const auto = caps({ mode: "auto", auto_merge_allowed: true, required_checks: ["ts"] });

	test("arms GitHub while a required check is pending, once, and observes the armed PR", async () => {
		const r = rig({
			recorded: auto,
			open: [pr({ mergeStateStatus: "BLOCKED", statusCheckRollup: [running("ts")] })],
			rules: [[argvIs(MERGE_AUTO), out("")]],
		});
		expect(await r.sweep()).toEqual([{ bead: MERGE, pr: 7, outcome: "armed" }]);
		expect(r.gh("merge")).toEqual([MERGE_AUTO]);
		expect(metadataWrites(r.store, MERGE)).toEqual([{ landing_state: "armed", armed_head: H, armed_at: "2026-01-01T00:00:00.000Z" }]);

		const armed = rig({ recorded: auto, open: [pr({ mergeStateStatus: "BLOCKED", autoMergeRequest: { enabledAt: "t" }, statusCheckRollup: [running("ts")] })] });
		expect(await armed.sweep()).toEqual([{ bead: MERGE, pr: 7, outcome: "armed" }]);
		expect(armed.gh("merge")).toEqual([]);
	});

	test("does not arm on UNSTABLE while the required check is pending: gh would merge at once", async () => {
		const r = rig({ recorded: auto, open: [pr({ mergeStateStatus: "UNSTABLE", statusCheckRollup: [running("ts"), failing("optional")] })] });
		expect(await r.sweep()).toEqual([{ bead: MERGE, pr: 7, outcome: "pending" }]);
		expect(r.gh("merge")).toEqual([]);
	});

	test("auto-merge allowed without a required check is merged directly, never with --auto", async () => {
		const merged = pr({ state: "MERGED", mergeCommit: { oid: MERGE_SHA } });
		const r = rig({
			recorded: caps({ auto_merge_allowed: true, required_checks: [] }),
			open: [pr({ statusCheckRollup: [green("ts")] })],
			rules: [[argvIs(MERGE_DIRECT), out("")], [argvIs(prViewArgv(REPO, 7)), out(JSON.stringify(merged))]],
		});
		expect(await r.sweep()).toEqual([{ bead: MERGE, pr: 7, outcome: "merged" }]);
		expect(r.gh("merge")).toEqual([MERGE_DIRECT]);
	});

	test("a disarmed auto-merge at the same head is a BLOCKED notice", async () => {
		const r = rig({
			beads: { [RUN]: runEpic(auto), [MERGE]: mergeBead({ landing_state: "armed", armed_head: H }), [ORIGIN]: origin() },
			open: [pr({ mergeStateStatus: "BLOCKED", statusCheckRollup: [running("ts")] })],
		});
		expect(await r.sweep()).toEqual([{ bead: MERGE, pr: 7, outcome: "blocked" }]);
		expect(r.gh("merge")).toEqual([]);
		expect(commentsOn(r.store, MERGE)[0]).toContain("disarmed auto-merge");
	});
});

describe("landingSweep: DIRTY", () => {
	const remoteRules = (): Array<[(argv: string[]) => boolean, ExecResult | (() => ExecResult)]> => [
		[argvIs(["git", "remote", "get-url", "origin"]), out("git@github.com:o/r.git\n")],
		[gitVerb("clone"), out("")],
		[gitVerb("fetch"), out("")],
		[gitVerb("rev-parse"), out(`${BASE}\n${H}\n`)],
	];

	test("a clean merge-tree is committed with plumbing and fast-forward pushed; the reviewed head follows", async () => {
		const r = rig({
			open: [pr({ mergeStateStatus: "DIRTY" })],
			rules: [
				...remoteRules(),
				[gitVerb("merge-tree"), out(`${TREE}\n`)],
				[gitVerb("commit-tree"), out(`${REFRESHED}\n`)],
				[gitVerb("push"), out("")],
			],
		});
		expect(await r.sweep()).toEqual([{ bead: MERGE, pr: 7, outcome: "refreshed" }]);
		const git = r.calls.filter(argv => argv[0] === "git").map(argv => argv.slice(1));
		expect(git.find(argv => argv[0] === "clone")?.slice(0, 4)).toEqual(["clone", "--quiet", "--bare", "--shared"]);
		expect(git.find(argv => argv[0] === "fetch")).toEqual(["fetch", "--quiet", "git@github.com:o/r.git", "+refs/heads/main:refs/landing/base", "+refs/heads/feat:refs/landing/branch"]);
		expect(git.find(argv => argv.includes("merge-tree"))).toEqual(["merge-tree", "--write-tree", "--name-only", "refs/landing/base", "refs/landing/branch"]);
		const commit = git.find(argv => argv.includes("commit-tree"))!;
		expect(commit.slice(commit.indexOf("commit-tree"), commit.indexOf("commit-tree") + 6)).toEqual(["commit-tree", TREE, "-p", H, "-p", BASE]);
		expect(git.find(argv => argv[0] === "push")).toEqual(["push", "--quiet", "git@github.com:o/r.git", `${REFRESHED}:refs/heads/feat`]);
		expect(metadataWrites(r.store, MERGE)).toEqual([{ head_sha: REFRESHED, refreshed_from: BASE, refreshed_head: H, landing_notice: "" }]);
		expect(commentsOn(r.store, MERGE)).toEqual([`NOTE landing refreshed feat from main@${BASE.slice(0, 7)}: head ${H.slice(0, 7)} -> ${REFRESHED.slice(0, 7)}; reviewed diff unchanged`]);
		expect(r.store.writes.filter(args => args[0] === "create")).toEqual([]);
	});

	test("conflicts inside the origin's scope file an implementer fix bead that blocks the merge", async () => {
		const r = rig({
			open: [pr({ mergeStateStatus: "DIRTY" })],
			rules: [...remoteRules(), [gitVerb("merge-tree"), out(`${TREE}\nsrc/api/a.ts\nsrc/api/b.ts\n\nCONFLICT (content)\n`, 1)]],
		});
		expect(await r.sweep()).toEqual([{ bead: MERGE, pr: 7, outcome: "dirty" }]);
		expect(r.calls.some(argv => argv[0] === "git" && (argv[1] === "push" || argv.includes("commit-tree")))).toBe(false);
		const create = r.store.writes.find(args => args[0] === "create")!;
		expect(create.slice(0, 2)).toEqual(["create", "fix: resolve landing conflict for PR #7"]);
		expect(create.slice(create.indexOf("--parent"), create.indexOf("--parent") + 4)).toEqual(["--parent", ORIGIN, "--deps", `discovered-from:${ORIGIN},blocks:${MERGE}`]);
		expect(JSON.parse(create[create.indexOf("--metadata") + 1]!)).toEqual({
			role: "implementer", stage: "fix", origin_bead: MERGE, repo: REPO, pr: 7, branch: "feat", execution_kind: "git", landing_reason: "conflict", scope: ["src/api/*"],
		});
		expect(create[create.indexOf("--description") + 1]).toContain("- src/api/a.ts\n- src/api/b.ts");
		expect(metadataWrites(r.store, MERGE)).toEqual([{ landing_state: "bounced", landing_fix: "orc-fix1", landing_notice: "" }]);
		expect(commentsOn(r.store, MERGE)).toEqual([`BOUNCED reason=conflict fix=orc-fix1 pr=7 head=${H.slice(0, 7)} role=implementer: 2 conflicting paths: src/api/a.ts, src/api/b.ts`]);
		expect(commentsOn(r.store, ORIGIN)).toHaveLength(1);
	});

	test("a conflicting path outside the scope routes the fix to the architect without a scope", async () => {
		const r = rig({
			open: [pr({ mergeStateStatus: "BEHIND" })],
			rules: [...remoteRules(), [gitVerb("merge-tree"), out(`${TREE}\nREADME.md\nsrc/api/a.ts\n\n`, 1)]],
		});
		expect(await r.sweep()).toEqual([{ bead: MERGE, pr: 7, outcome: "dirty" }]);
		const create = r.store.writes.find(args => args[0] === "create")!;
		const metadata = JSON.parse(create[create.indexOf("--metadata") + 1]!) as Record<string, unknown>;
		expect(metadata.role).toBe("architect");
		expect(metadata).not.toHaveProperty("scope");
		expect(commentsOn(r.store, MERGE)[0]).toContain("role=architect");
	});

	test("an origin without a scope keeps the conflict with the implementer", async () => {
		const r = rig({
			beads: { [RUN]: runEpic(), [MERGE]: mergeBead(), [ORIGIN]: origin(null) },
			open: [pr({ mergeStateStatus: "DIRTY" })],
			rules: [...remoteRules(), [gitVerb("merge-tree"), out(`${TREE}\nREADME.md\n\n`, 1)]],
		});
		await r.sweep();
		const create = r.store.writes.find(args => args[0] === "create")!;
		expect((JSON.parse(create[create.indexOf("--metadata") + 1]!) as Record<string, unknown>).role).toBe("implementer");
	});

	test("an unclassifiable merge-tree, a foreign remote, and a moved head write no merge and no fix bead", async () => {
		const unclassified = rig({
			open: [pr({ mergeStateStatus: "DIRTY" })],
			rules: [...remoteRules(), [gitVerb("merge-tree"), out("", 128, "fatal: refusing to merge unrelated histories")]],
		});
		expect(await unclassified.sweep()).toEqual([{ bead: MERGE, pr: 7, outcome: "blocked" }]);
		expect(commentsOn(unclassified.store, MERGE)[0]).toContain("merge-tree could not classify");
		expect(unclassified.store.writes.filter(args => args[0] === "create")).toEqual([]);

		const foreign = rig({
			open: [pr({ mergeStateStatus: "DIRTY" })],
			rules: [[argvIs(["git", "remote", "get-url", "origin"]), out("git@github.com:someone/else.git\n")]],
		});
		expect(await foreign.sweep()).toEqual([{ bead: MERGE, pr: 7, outcome: "blocked" }]);
		expect(foreign.calls.filter(argv => argv[0] === "git")).toHaveLength(1);

		const moved = rig({
			open: [pr({ mergeStateStatus: "DIRTY" })],
			rules: [
				[argvIs(["git", "remote", "get-url", "origin"]), out("git@github.com:o/r.git\n")],
				[gitVerb("clone"), out("")],
				[gitVerb("fetch"), out("")],
				[gitVerb("rev-parse"), out(`${BASE}\n${OTHER}\n`)],
			],
		});
		expect(await moved.sweep()).toEqual([{ bead: MERGE, pr: 7, outcome: "pending" }]);
		expect(moved.store.writes).toEqual([]);
	});

	test("a refused push is reported once and the reviewed head is left as it was", async () => {
		const r = rig({
			open: [pr({ mergeStateStatus: "DIRTY" })],
			rules: [
				...remoteRules(),
				[gitVerb("merge-tree"), out(`${TREE}\n`)],
				[gitVerb("commit-tree"), out(`${REFRESHED}\n`)],
				[gitVerb("push"), out("", 1, "! [rejected] non-fast-forward")],
			],
		});
		expect(await r.sweep()).toEqual([{ bead: MERGE, pr: 7, outcome: "blocked" }]);
		expect(metadataWrites(r.store, MERGE)).toEqual([{ landing_notice: `push:${H}` }]);
		expect(commentsOn(r.store, MERGE)[0]).toContain("could not be pushed: ! [rejected] non-fast-forward");
	});
});

describe("landingSweep: UNSTABLE", () => {
	test("a failing check is rerun once per head, then becomes an implementer fix bead", async () => {
		const RERUN = ["gh", "run", "rerun", "123", "--failed", "--repo", REPO];
		const r = rig({
			open: [pr({ mergeStateStatus: "UNSTABLE", statusCheckRollup: [green("ts"), failing("py")] })],
			rules: [[argvIs(RERUN), out("")]],
		});
		expect(await r.sweep()).toEqual([{ bead: MERGE, pr: 7, outcome: "unstable" }]);
		expect(r.calls.filter(argv => argv[1] === "run")).toEqual([RERUN]);
		expect(metadataWrites(r.store, MERGE)).toEqual([{ ci_rerun_head: H, ci_reruns: "1" }]);
		expect(commentsOn(r.store, MERGE)).toEqual([`NOTE landing rerun ci: py run 123 at ${H.slice(0, 7)}`]);
		expect(r.store.writes.filter(args => args[0] === "create")).toEqual([]);

		// Still failing at the same head on the next sweep: no second rerun.
		expect(await r.sweep()).toEqual([{ bead: MERGE, pr: 7, outcome: "unstable" }]);
		expect(r.calls.filter(argv => argv[1] === "run")).toEqual([RERUN]);
		const create = r.store.writes.find(args => args[0] === "create")!;
		expect(create[1]).toBe("fix: repair failing check py for PR #7");
		expect(create.slice(create.indexOf("--parent"), create.indexOf("--parent") + 4)).toEqual(["--parent", ORIGIN, "--deps", `discovered-from:${ORIGIN},blocks:${MERGE}`]);
		expect((JSON.parse(create[create.indexOf("--metadata") + 1]!) as Record<string, unknown>).role).toBe("implementer");
		expect(create[create.indexOf("--description") + 1]).toContain("after one rerun");
		expect(create[create.indexOf("--description") + 1]).toContain(`gh run view 123 --log-failed --repo ${REPO}`);
		expect(commentsOn(r.store, MERGE).at(-1)).toBe(`BOUNCED reason=ci fix=orc-fix1 pr=7 head=${H.slice(0, 7)} role=implementer: failing py at ${H.slice(0, 7)}`);
	});

	test("a failing status context with no workflow run goes straight to a fix bead", async () => {
		const r = rig({
			open: [pr({ mergeStateStatus: "UNSTABLE", statusCheckRollup: [{ __typename: "StatusContext", context: "ci/legacy", state: "FAILURE", targetUrl: "https://ci/9" }] })],
		});
		expect(await r.sweep()).toEqual([{ bead: MERGE, pr: 7, outcome: "unstable" }]);
		expect(r.calls.filter(argv => argv[1] === "run")).toEqual([]);
		expect(r.store.writes.find(args => args[0] === "create")?.[1]).toBe("fix: repair failing check ci/legacy for PR #7");
	});

	test("a fix bead needs a readable origin; without one the sweep says so and files nothing", async () => {
		const r = rig({
			beads: { [RUN]: runEpic(), [MERGE]: mergeBead({ origin_bead: "orc-gone" }) },
			open: [pr({ mergeStateStatus: "UNSTABLE", statusCheckRollup: [{ __typename: "StatusContext", context: "ci", state: "FAILURE" }] })],
		});
		expect(await r.sweep()).toEqual([{ bead: MERGE, pr: 7, outcome: "blocked" }]);
		expect(r.store.writes.filter(args => args[0] === "create")).toEqual([]);
		expect(commentsOn(r.store, MERGE)[0]).toContain("origin orc-gone could not be read");
	});
});

describe("landingSweep: reads", () => {
	test("polls each repository once and gives up on a bead whose PR gh cannot answer", async () => {
		const r = rig({
			beads: {
				[RUN]: runEpic(),
				[MERGE]: mergeBead(),
				"orc-m2": { ...mergeBead({ pr: 8, head_sha: OTHER }), id: "orc-m2" },
				[ORIGIN]: origin(),
			},
			open: [pr({ isDraft: true })],
		});
		expect(await r.sweep()).toEqual([
			{ bead: MERGE, pr: 7, outcome: "draft" },
			{ bead: "orc-m2", pr: 8, outcome: "unknown", detail: "gh did not answer" },
		]);
		expect(r.gh("list")).toHaveLength(1);
		expect(r.gh("view")).toEqual([prViewArgv(REPO, 8)]);
	});

	test("an unreadable bead list or blocked list ends the sweep with nothing written and no gh call", async () => {
		store = fakeBd({ [RUN]: runEpic(), [MERGE]: mergeBead() });
		const listSpy = spyOn(Bun, "spawn");
		const { exec, calls } = script([]);
		// `blocked` is answered from `store.blocked`, so break it by making the fake exit 1.
		const original = listSpy.getMockImplementation()!;
		listSpy.mockImplementation(((argv: string[]) => {
			if (argv[1] === "blocked") {
				return { stdout: new Response("").body, stderr: new Response("").body, exited: Promise.resolve(1), kill: () => { } } as unknown as Bun.Subprocess;
			}
			return original(argv as never);
		}) as unknown as typeof Bun.spawn);
		expect(await landingSweep({ cwd, runId: RUN, exec })).toEqual([]);
		expect(calls).toEqual([]);
		expect(store.writes).toEqual([]);
	});

	test("a repository the run epic does not record is probed once and, unprobeable, landed directly", async () => {
		const merged = pr({ state: "MERGED", mergeCommit: { oid: MERGE_SHA } });
		const r = rig({
			recorded: caps({ repo: "other/repo", auto_merge_allowed: true, required_checks: ["ts"] }),
			open: [pr({ statusCheckRollup: [green("ts")] })],
			rules: [
				[argvIs(capabilityQueryArgv(REPO, "main")!), out("", 1, "gh: rate limited")],
				[argvIs(MERGE_DIRECT), out("")],
				[argvIs(prViewArgv(REPO, 7)), out(JSON.stringify(merged))],
			],
		});
		expect(await r.sweep()).toEqual([{ bead: MERGE, pr: 7, outcome: "merged" }]);
		expect(r.gh("merge")).toEqual([MERGE_DIRECT]);
		expect(r.calls.filter(argv => argv[1] === "api")).toHaveLength(1);
	});
});
