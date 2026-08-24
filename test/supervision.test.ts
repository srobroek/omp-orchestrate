import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import * as realBd from "../src/bd";
import type { BdBead, BdComment, BdResult } from "../src/bd";
import type { Exec, ExecResult } from "../src/supervision";

/**
 * `bd` is replaced wholesale, because the reaper's whole observable effect is the argv
 * it runs. The real module's pure helpers (`commentVerb`, `metadataString`) are spread
 * back in: `satisfies` in the exit gate calls them, and a second copy here would be a
 * copy of the predicate semantics under test.
 */
const real = { ...realBd };

/** Every `bd` argv the module under test ran, in order. */
let ran: string[][] = [];

/** What each `bd` read answers this test. */
interface BdWorld {
	/** `bd list --assignee <child> --status in_progress` */
	claimed: BdBead[];
	/** `bd list --metadata-field actor=<child>` */
	stamped: BdBead[];
	/** `bd dep list <id> --direction=up` */
	linked: BdBead[];
	/** Comment text per bead id. */
	comments: Record<string, string[]>;
}

let world: BdWorld = { claimed: [], stamped: [], linked: [], comments: {} };

function listFor(args: string[]): BdBead[] {
	if (args[0] === "dep") return world.linked;
	if (args.includes("--metadata-field")) return world.stamped;
	if (args.includes("--assignee")) return world.claimed;
	return [];
}

mock.module("../src/bd", () => ({
	...real,
	bdList: async (args: string[]): Promise<BdBead[]> => {
		ran.push(args);
		return listFor(args);
	},
	bdRun: async (args: string[]): Promise<BdResult | null> => {
		ran.push(args);
		return { code: 0, stdout: "", stderr: "" };
	},
	bdComments: async (id: string): Promise<BdComment[]> => {
		ran.push(["comments", id]);
		return (world.comments[id] ?? []).map(text => ({ text }));
	},
	// No wisps in these fixtures: `linked.comment.verb` predicates belong to the
	// reviewer contract, which the exit-gate tests already cover.
	bdLinked: async (): Promise<string[]> => [],
}));

// `mock.module` installs the fake `bd` at runtime, so the module under test must be
// loaded after that statement; a static import would evaluate it first and bind the
// real one.
const { branchIntegrated, ensurePatrolWisp, reapChild, registerSupervision } = await import("../src/supervision");

/** Nothing may run at import time: the plugin loads in every session, gates included. */
const ranDuringImport = ran.length;

/**
 * A dispatched task bead, in the shape `bd list --json` returns it — including the
 * `assignee: null` of an unassigned bead, which `BdBead`'s optional field cannot type.
 */
function bead(fields: Record<string, unknown> = {}): BdBead {
	return {
		id: "orc-1",
		status: "in_progress",
		labels: ["agent:implementer"],
		metadata: { actor: "impl-7" },
		...fields,
	} as BdBead;
}

/** A git seam that answers `branch --list` with `branches` and nothing else. */
function gitWith(branches: string[]): Exec {
	return async (argv: string[]): Promise<ExecResult | null> => {
		if (argv[1] === "branch") return { code: 0, stdout: branches.map(name => `  ${name}\n`).join(""), stderr: "" };
		return null;
	};
}

/** The `bd update` argv the reaper ran, or `undefined` when it ran none. */
function update(): string[] | undefined {
	return ran.find(argv => argv[0] === "update");
}

/** The text of the single comment the reaper wrote, or `undefined`. */
function comment(): string | undefined {
	return ran.find(argv => argv[0] === "comment")?.[2];
}

beforeEach(() => {
	ran = [];
	world = { claimed: [], stamped: [], linked: [], comments: {} };
});

afterAll(() => {
	// `mock.module` mutates the process-wide module registry and `mock.restore()`
	// does not undo a module mock (bun 1.3.14), while bun runs every test file in one
	// process: re-mocking with the captured real exports is what stops
	// `test/bd.test.ts` from exercising this file's fake `bd`.
	mock.module("../src/bd", () => real);
});

describe("import", () => {
	test("loading the module touches neither bd nor git", () => {
		expect(ranDuringImport).toBe(0);
	});
});

describe("reapChild — clean exit", () => {
	test("a released claim whose contract holds only gets its branch recorded", async () => {
		// Routing label absent: the generic contract applies, whose one check is a
		// REPORTED comment. The claim is released, so the bead is found by actor.
		world.stamped = [bead({ status: "open", labels: [], assignee: null })];
		world.comments["orc-1"] = ["REPORTED delivered the parser"];

		const outcome = await reapChild({ id: "impl-7", status: "completed" }, {
			cwd: "/repo",
			exec: gitWith(["omp/task/impl-7"]),
		});

		expect(outcome.reaped).toEqual([{ bead: "orc-1", case: "clean", failures: [] }]);
		expect(outcome.branch).toBe("omp/task/impl-7");
		expect(comment()).toBeUndefined();
		expect(update()).toEqual(["update", "orc-1", "--set-metadata", "branch=omp/task/impl-7"]);
	});

	test("a branch the child stamped itself is never overwritten", async () => {
		world.stamped = [
			bead({ status: "open", labels: [], assignee: null, metadata: { actor: "impl-7", branch: "omp/task/impl-7" } }),
		];
		world.comments["orc-1"] = ["REPORTED delivered the parser"];

		const outcome = await reapChild({ id: "impl-7", status: "completed" }, {
			cwd: "/repo",
			exec: gitWith(["omp/task/impl-7"]),
		});

		expect(outcome.reaped[0]?.case).toBe("clean");
		expect(update()).toBeUndefined();
	});

	test("a branch belonging to a child with a longer id is not attributed", async () => {
		world.stamped = [bead({ status: "open", labels: [], assignee: null })];
		world.comments["orc-1"] = ["REPORTED delivered the parser"];

		// `omp/task/impl-7*` also matches child impl-70's captured branch.
		const outcome = await reapChild({ id: "impl-7", status: "completed" }, {
			cwd: "/repo",
			exec: gitWith(["omp/task/impl-70"]),
		});

		expect(outcome.branch).toBeUndefined();
		expect(update()).toBeUndefined();
	});
});

describe("reapChild — semantic incompletion", () => {
	test("a completed child that never released its claim is reclaimed", async () => {
		world.claimed = [bead({ assignee: "impl-7" })];
		world.comments["orc-1"] = ["REPORTED shipped it"];

		const outcome = await reapChild({ id: "impl-7", status: "completed" }, {
			cwd: "/repo",
			exec: gitWith(["omp/task/impl-7"]),
		});

		expect(outcome.reaped).toEqual([{ bead: "orc-1", case: "incomplete", failures: [] }]);
		expect(comment()).toBe("RECLAIM child impl-7 exited without completing: claim still held");
		expect(update()).toEqual([
			"update",
			"orc-1",
			"--assignee",
			"",
			"--status",
			"open",
			"--set-metadata",
			"recovered_branch=omp/task/impl-7",
		]);
	});

	test("a released claim with an unsatisfied contract is reclaimed and named", async () => {
		// Delivered nothing: no REPORTED comment, and a git-kind bead owes a branch,
		// a push, a reviewer hand-off and a released claim.
		world.stamped = [
			bead({ status: "open", assignee: null, metadata: { actor: "impl-7", worktree: "/wt", execution_kind: "git" } }),
		];

		const outcome = await reapChild({ id: "impl-7", status: "completed" }, {
			cwd: "/repo",
			exec: gitWith([]),
		});

		expect(outcome.reaped[0]?.case).toBe("incomplete");
		expect(outcome.reaped[0]?.failures).toEqual(["branch", "delivery", "handoff", "reported"]);
		expect(comment()).toBe("RECLAIM child impl-7 exited without completing: branch, delivery, handoff, reported");
		// No captured branch, so nothing is stamped as recoverable.
		expect(update()).toEqual(["update", "orc-1", "--assignee", "", "--status", "open"]);
	});

	test("a bead another actor now holds is left alone", async () => {
		world.stamped = [bead({ status: "in_progress", assignee: "impl-9" })];

		const outcome = await reapChild({ id: "impl-7", status: "completed" }, {
			cwd: "/repo",
			exec: gitWith(["omp/task/impl-7"]),
		});

		expect(outcome.reaped).toEqual([]);
		expect(ran.filter(argv => argv[0] === "comment" || argv[0] === "update")).toEqual([]);
	});
});

describe("reapChild — technical death", () => {
	test("a captured branch survives as the recovery pointer", async () => {
		world.claimed = [bead({ assignee: "impl-7" })];

		const outcome = await reapChild({ id: "impl-7", status: "failed" }, {
			cwd: "/repo",
			exec: gitWith(["main", "omp/task/impl-7"]),
		});

		expect(outcome.reaped).toEqual([{ bead: "orc-1", case: "died-with-work", failures: [] }]);
		expect(comment()).toBe("RECLAIM child impl-7 died (failed); commits preserved on omp/task/impl-7");
		expect(update()).toEqual([
			"update",
			"orc-1",
			"--assignee",
			"",
			"--status",
			"open",
			"--set-metadata",
			"recovered_branch=omp/task/impl-7",
		]);
		// A dead child's contract is moot, so its comments are never read.
		expect(ran.some(argv => argv[0] === "comments")).toBe(false);
	});

	test("with no branch the claim is released and nothing is stamped", async () => {
		world.claimed = [bead({ assignee: "impl-7" })];

		const outcome = await reapChild({ id: "impl-7", status: "aborted" }, {
			cwd: "/repo",
			exec: gitWith([]),
		});

		expect(outcome.reaped).toEqual([{ bead: "orc-1", case: "died-without-work", failures: [] }]);
		expect(outcome.branch).toBeUndefined();
		expect(comment()).toBe("RECLAIM child impl-7 died (aborted); no captured branch, nothing to recover");
		expect(update()).toEqual(["update", "orc-1", "--assignee", "", "--status", "open"]);
	});

	test("a dead child holding nothing is not looked up by actor", async () => {
		world.stamped = [bead({ status: "open", assignee: null })];

		const outcome = await reapChild({ id: "impl-7", status: "failed" }, { cwd: "/repo", exec: gitWith([]) });

		expect(outcome.reaped).toEqual([]);
		expect(ran).toEqual([["list", "--assignee", "impl-7", "--status", "in_progress", "--json"]]);
	});
});

describe("reapChild — non-terminal and unavailable", () => {
	test("a started child is not reaped", async () => {
		world.claimed = [bead({ assignee: "impl-7" })];

		const outcome = await reapChild({ id: "impl-7", status: "started" }, { cwd: "/repo", exec: gitWith([]) });

		expect(outcome).toEqual({ child: "impl-7", reaped: [] });
		expect(ran).toEqual([]);
	});

	test("git that cannot run leaves the reclaim without a branch", async () => {
		world.claimed = [bead({ assignee: "impl-7" })];

		const outcome = await reapChild({ id: "impl-7", status: "failed" }, { cwd: "/repo", exec: async () => null });

		expect(outcome.reaped[0]?.case).toBe("died-without-work");
		expect(update()).toEqual(["update", "orc-1", "--assignee", "", "--status", "open"]);
	});
});

describe("branchIntegrated", () => {
	const cherry = (result: ExecResult | null): Exec => async () => result;

	test("every commit already upstream is integrated", async () => {
		const stdout = "- 845d702a86971732ca63375f3b4ff3137bdf08b5\n- 1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d\n";
		expect(await branchIntegrated("feat/x", "omp/task/impl-7", "/repo", cherry({ code: 0, stdout, stderr: "" }))).toBe(
			"integrated",
		);
		// Nothing to compare is the same answer: no commit is missing upstream.
		expect(await branchIntegrated("feat/x", "omp/task/impl-7", "/repo", cherry({ code: 0, stdout: "", stderr: "" }))).toBe(
			"integrated",
		);
	});

	test("one missing commit is pending, even beside integrated ones", async () => {
		const stdout = "- 845d702a86971732ca63375f3b4ff3137bdf08b5\n+ 1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d\n";
		expect(await branchIntegrated("feat/x", "omp/task/impl-7", "/repo", cherry({ code: 0, stdout, stderr: "" }))).toBe(
			"pending",
		);
	});

	test("an unknown ref, an unrunnable git, or an unparseable line is unknown", async () => {
		const bad = cherry({ code: 128, stdout: "", stderr: "fatal: unknown commit omp/task/impl-7" });
		expect(await branchIntegrated("feat/x", "omp/task/impl-7", "/repo", bad)).toBe("unknown");
		expect(await branchIntegrated("feat/x", "omp/task/impl-7", "/repo", async () => null)).toBe("unknown");
		// Never read as integrated: the caller deletes branches on that answer.
		const noise = cherry({ code: 0, stdout: "warning: refname is ambiguous\n", stderr: "" });
		expect(await branchIntegrated("feat/x", "omp/task/impl-7", "/repo", noise)).toBe("unknown");
	});
});

describe("ensurePatrolWisp", () => {
	test("creates the wisp when the epic has none", async () => {
		await ensurePatrolWisp("orc-epic-1");

		expect(ran).toEqual([
			["dep", "list", "orc-epic-1", "--direction=up", "--type", "relates-to", "--json"],
			[
				"create",
				"patrol: orc-epic-1 claim reconciliation",
				"--ephemeral",
				"--wisp-type",
				"patrol",
				"--deps",
				"relates-to:orc-epic-1",
				"--silent",
			],
		]);
	});

	test("an open patrol is left as the one marker", async () => {
		world.linked = [{ id: "orc-wisp-vcg", status: "open", ephemeral: true, wisp_type: "patrol" }];

		await ensurePatrolWisp("orc-epic-1");

		expect(ran.some(argv => argv[0] === "create")).toBe(false);
	});

	test("a patrol being drained is not duplicated", async () => {
		world.linked = [{ id: "orc-wisp-vcg", status: "in_progress", ephemeral: true, wisp_type: "patrol" }];

		await ensurePatrolWisp("orc-epic-1");

		expect(ran.some(argv => argv[0] === "create")).toBe(false);
	});

	test("a closed patrol is re-armed, and other wisps do not count", async () => {
		world.linked = [
			{ id: "orc-wisp-vcg", status: "closed", ephemeral: true, wisp_type: "patrol" },
			{ id: "orc-wisp-abc", status: "open", ephemeral: true, wisp_type: "error" },
		];

		await ensurePatrolWisp("orc-epic-1");

		expect(ran.some(argv => argv[0] === "create")).toBe(true);
	});
});

/** Collect what `registerSupervision` subscribes, without an OMP session. */
function recordingApi(): {
	pi: ExtensionAPI;
	/** Extension events it subscribed, in order. */
	events: string[];
	/** Bus channels it subscribed, in order. */
	channels: string[];
	sessionStart: (ctx: ExtensionContext) => void;
	deliver: (payload: unknown) => Promise<void>;
} {
	const events: string[] = [];
	const channels: string[] = [];
	const handlers: ((event: unknown, ctx: ExtensionContext) => void)[] = [];
	const listeners: ((data: unknown) => unknown)[] = [];
	const stub = {
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => void) => {
			events.push(event);
			handlers.push(handler);
		},
		events: {
			on: (channel: string, listener: (data: unknown) => unknown) => {
				channels.push(channel);
				listeners.push(listener);
			},
		},
		logger: { error: () => {}, debug: () => {}, warn: () => {}, info: () => {} },
	};
	return {
		pi: stub as unknown as ExtensionAPI,
		events,
		channels,
		sessionStart: ctx => {
			for (const handler of handlers) handler({}, ctx);
		},
		deliver: async payload => {
			// The handler hands its promise back to the bus, so the reap is awaited
			// here rather than guessed at with a delay.
			for (const listener of listeners) await listener(payload);
		},
	};
}

describe("registerSupervision", () => {
	const ctx = { cwd: "/repo" } as unknown as ExtensionContext;

	test("subscribes the lifecycle channel once, inside session_start", () => {
		const api = recordingApi();
		registerSupervision(api.pi);
		expect(api.events).toEqual(["session_start"]);
		expect(api.channels).toEqual([]);

		api.sessionStart(ctx);
		api.sessionStart(ctx);
		expect(api.channels).toEqual(["task:subagent:lifecycle"]);
	});

	test("a terminal payload reaps, a malformed one is ignored", async () => {
		const api = recordingApi();
		registerSupervision(api.pi);
		api.sessionStart(ctx);

		await api.deliver({ id: "impl-7", status: "completed" });
		expect(ran).toEqual([
			["list", "--assignee", "impl-7", "--status", "in_progress", "--json"],
			["list", "--metadata-field", "actor=impl-7", "--status", "open,in_progress", "--json"],
		]);

		ran = [];
		await api.deliver({ agent: "orc-implementer" });
		await api.deliver(null);
		expect(ran).toEqual([]);
	});
});
