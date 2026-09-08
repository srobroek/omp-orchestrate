import { describe, expect, spyOn, test } from "bun:test";
import { bdLinkedChecked, bdListChecked, bdRun, commentVerb, metadataString, resetReadBudget } from "../src/bd";

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
	test("overlapping operations retain independent read counts across resets", async () => {
		const previous = process.env.BD_BIN;
		process.env.BD_BIN = "echo";
		const paused = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		try {
			const first = (async () => {
				resetReadBudget();
				for (let i = 0; i < 12; i++) expect(await bdListChecked(["[]"])).toEqual([]);
				paused.resolve();
				await resume.promise;
				expect(await bdListChecked(["[]"])).toBeNull();
			})();
			await paused.promise;
			resetReadBudget();
			expect(await bdListChecked(["[]"])).toEqual([]);
			resume.resolve();
			await first;
			for (let i = 1; i < 12; i++) expect(await bdListChecked(["[]"])).toEqual([]);
			expect(await bdListChecked(["[]"])).toBeNull();
		} finally {
			resume.resolve();
			if (previous === undefined) delete process.env.BD_BIN;
			else process.env.BD_BIN = previous;
		}
	});

	test("successful calls share an absolute deadline and expiry prevents mutations", async () => {
		let now = 0;
		const clock = spyOn(performance, "now").mockImplementation(() => now);
		const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
			now += 8_000;
			return {
				stdout: new Response("[]").body,
				stderr: new Response("").body,
				exited: Promise.resolve(0),
				kill: () => { },
			} as unknown as Bun.Subprocess;
		});
		try {
			resetReadBudget();
			expect(await bdListChecked(["list", "--json"])).toEqual([]);
			expect(await bdListChecked(["list", "--json"])).toEqual([]);
			expect(await bdListChecked(["list", "--json"])).toBeNull();
			expect(await bdRun(["update", "bd-task", "--status", "open"])).toBeNull();
			expect(spawn).toHaveBeenCalledTimes(3);
			resetReadBudget();
			expect(await bdListChecked(["list", "--json"])).toEqual([]);
		} finally {
			spawn.mockRestore();
			clock.mockRestore();
			resetReadBudget();
		}
	});

	test("a process is killed at the remaining deadline rather than a fresh timeout", async () => {
		let now = 0;
		const clock = spyOn(performance, "now").mockImplementation(() => now);
		let scheduled: (() => void) | undefined;
		let delay: number | undefined;
		const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, ms: number) => {
			scheduled = callback;
			delay = ms;
			return 0;
		}) as unknown as typeof setTimeout);
		const exited = Promise.withResolvers<number>();
		let killed = false;
		const spawn = spyOn(Bun, "spawn").mockImplementation(() => ({
			stdout: new Response("").body,
			stderr: new Response("").body,
			exited: exited.promise,
			kill: () => { killed = true; exited.resolve(143); },
		}) as unknown as Bun.Subprocess);
		try {
			resetReadBudget();
			now = 19_900;
			const pending = bdRun(["list", "--json"]);
			expect(delay).toBe(100);
			scheduled?.();
			expect(await pending).toBeNull();
			expect(killed).toBe(true);
		} finally {
			exited.resolve(0);
			spawn.mockRestore();
			timer.mockRestore();
			clock.mockRestore();
			resetReadBudget();
		}
	});
});

describe("checked linked evidence", () => {
	test("node dependents and wisp dependencies follow their requested directions", async () => {
		const spawn = spyOn(Bun, "spawn").mockImplementation((...args) => {
			const argv = args[0] as string[];
			const payload = argv.includes("--direction=down")
				? [{ issue_id: "bd-wisp", depends_on_id: "bd-node" }]
				: [{ issue_id: "bd-dependent", depends_on_id: "bd-wisp" }];
			return {
				stdout: new Response(JSON.stringify(payload)).body,
				stderr: new Response("").body,
				exited: Promise.resolve(0),
				kill: () => { },
			} as unknown as Bun.Subprocess;
		});
		try {
			resetReadBudget();
			expect(await bdLinkedChecked("bd-wisp", "relates-to")).toEqual(["bd-dependent"]);
			expect(await bdLinkedChecked("bd-wisp", "relates-to", undefined, "down")).toEqual(["bd-node"]);
		} finally {
			spawn.mockRestore();
		}
	});

	test.each([
		{
			rows: [{ id: "omp-orchestrate-wisp-42", title: "review-task", assignee: "reviewer-7", dependency_type: "relates-to" }],
			expected: ["omp-orchestrate-wisp-42"],
		},
		{
			rows: [{ issue_id: "omp-orchestrate-wisp-42", depends_on_id: "bd-node", created_by: "lead-1", type: "relates-to" }],
			expected: ["omp-orchestrate-wisp-42"],
		},
		{ rows: [{ assignee: "reviewer-7" }], expected: null },
		{ rows: [{ issue_id: "bd-wisp", depends_on_id: "bd-unrelated" }], expected: null },
	])("reads dependency endpoints without harvesting actor IDs: %j", async ({ rows, expected }) => {
		const spawn = spyOn(Bun, "spawn").mockImplementation(() => ({
			stdout: new Response(JSON.stringify(rows)).body,
			stderr: new Response("").body,
			exited: Promise.resolve(0),
			kill: () => { },
		}) as unknown as Bun.Subprocess);
		try {
			resetReadBudget();
			expect(await bdLinkedChecked("bd-node", "relates-to")).toEqual(expected === null ? null : [...expected]);
		} finally {
			spawn.mockRestore();
		}
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

	test("object and JSON-string metadata produce identical evidence", async () => {
		const metadata = { worktree: "/tmp/worktree", execution_kind: "git", output_ref: "refs/heads/feature" };
		expect(metadataString({ metadata }, "worktree")).toBe("/tmp/worktree");
		expect(metadataString({ metadata: JSON.stringify(metadata) }, "worktree")).toBe("/tmp/worktree");
		for (const raw of ["{broken", "[]", "null", '"text"']) {
			expect(metadataString({ metadata: raw }, "worktree")).toBeUndefined();
		}
		const spawn = spyOn(Bun, "spawn").mockImplementation(() => ({
			stdout: new Response(JSON.stringify([
				{ id: "bd-object", metadata },
				{ id: "bd-string", metadata: JSON.stringify(metadata) },
			])).body,
			stderr: new Response("").body,
			exited: Promise.resolve(0),
			kill: () => { },
		}) as unknown as Bun.Subprocess);
		try {
			resetReadBudget();
			const beads = await bdListChecked(["list", "--json"]);
			expect(beads?.map(value => value.metadata)).toEqual([metadata, metadata]);
			expect(beads?.map(value => metadataString(value, "execution_kind"))).toEqual(["git", "git"]);
		} finally {
			spawn.mockRestore();
		}
	});
});

describe("commentVerb", () => {
	test("takes the leading token, uppercased, colon stripped", () => {
		expect(commentVerb("REPORTED orc-1 pushed")).toBe("REPORTED");
		expect(commentVerb("reported orc-1")).toBe("REPORTED");
		expect(commentVerb("REVIEW: verdict=approve")).toBe("REVIEW");
		expect(commentVerb("   BLOCKED   kind:design")).toBe("BLOCKED");
	});

	test("reads through the markdown an honest writer uses", () => {
		// Every one of these reached supervision as a non-verb, so the contract that
		// wanted the verb read unsatisfied while the work had in fact been done.
		expect(commentVerb("**REVIEW** approved")).toBe("REVIEW");
		expect(commentVerb("- REVIEW approved")).toBe("REVIEW");
		expect(commentVerb("`REVIEW` approved")).toBe("REVIEW");
		expect(commentVerb("REVIEW, approved")).toBe("REVIEW");
		expect(commentVerb("> REVIEW approved")).toBe("REVIEW");
		expect(commentVerb("_REVIEW_ approved")).toBe("REVIEW");
		expect(commentVerb("~~REVIEW~~ approved")).toBe("REVIEW");
		expect(commentVerb("> - **REPORTED**: orc-1 pushed")).toBe("REPORTED");
	});

	test("keeps NO WORK a non-verb", () => {
		// Deliberate. Reading two tokens would make NO_WORK the only verb assembled
		// from two, and `gateUnclaimedExit` matches the literal `NO_WORK`, so leniency
		// would move the divergence rather than close it. `commentVerbNotice` nags this
		// form, which is what turns the old silent failure into a warning.
		expect(commentVerb("NO WORK")).toBe("NO");
		expect(commentVerb("NO WORK in my queue")).toBe("NO");
		expect(commentVerb("NO_WORK")).toBe("NO_WORK");
		expect(commentVerb("**NO_WORK**: queue empty")).toBe("NO_WORK");
	});

	test("never harvests a verb out of prose", () => {
		// The first token is the whole signal. A comment opening on a word stays a
		// non-verb, so supervision can tell an absent verb from a mangled one. The
		// leading strip cannot cross a word, and the trailing strip is punctuation
		// only -- a slash keeps the token mangled rather than quietly repairing it.
		expect(commentVerb("the REVIEW is done")).toBe("THE");
		expect(commentVerb("Looks good, REVIEW passed")).toBe("LOOKS");
		expect(commentVerb("done")).toBe("DONE");
		expect(commentVerb("REVIEWED the branch")).toBe("REVIEWED");
		expect(commentVerb("NO WORKTREE was created")).toBe("NO");
		expect(commentVerb("REVIEW/approved")).toBe("REVIEW/APPROVED");
	});

	test("yields an empty verb for empty text", () => {
		expect(commentVerb("")).toBe("");
		expect(commentVerb("   ")).toBe("");
		expect(commentVerb("- ")).toBe("");
	});
});

describe("the timeout breaker", () => {
	/**
	 * A stub that outlives any timeout, so the kill path is what runs.
	 *
	 * `sleep` is used rather than a script, because the point is a process that does not
	 * exit on its own.
	 */
	function withSleepBin<T>(body: () => Promise<T>): Promise<T> {
		const previous = process.env.BD_BIN;
		process.env.BD_BIN = "sleep";
		return body().finally(() => {
			if (previous === undefined) delete process.env.BD_BIN;
			else process.env.BD_BIN = previous;
		});
	}

	test("a killed call reports unknown rather than the kill's own exit", async () => {
		// Handing back the killed process's result would let a gate read a signal's exit code
		// as bd's answer. Every gate treats null as permission to proceed; a nonzero code is
		// a finding.
		resetReadBudget();
		await withSleepBin(async () => {
			expect(await bdRun(["30"], 120)).toBeNull();
		});
	});

	test("one timeout short-circuits the rest of the dispatch", async () => {
		// Measured cost of not doing this: with the database unresponsive, several gates ran
		// per tool_call at 10s each and the extension blew its 30s budget, so every bash call
		// in the session died instead of degrading.
		resetReadBudget();
		await withSleepBin(async () => {
			const first = Date.now();
			expect(await bdRun(["30"], 150)).toBeNull();
			const waited = Date.now() - first;
			expect(waited).toBeGreaterThanOrEqual(140);

			// The second call must not spawn at all, so it cannot have waited.
			const second = Date.now();
			expect(await bdRun(["30"], 150)).toBeNull();
			expect(Date.now() - second).toBeLessThan(50);
		});
	});

	test("another operation cannot clear or inherit a pending timeout breaker", async () => {
		await withSleepBin(async () => {
			const resumed = Promise.withResolvers<void>();
			const timedOut = Promise.withResolvers<void>();
			resetReadBudget();
			const first = (async () => {
				expect(await bdRun(["30"], 30)).toBeNull();
				timedOut.resolve();
				await resumed.promise;
				expect(await bdRun(["0"])).toBeNull();
			})();
			resetReadBudget();
			await timedOut.promise;
			try {
				expect((await bdRun(["0"]))?.code).toBe(0);
			} finally {
				resumed.resolve();
			}
			await first;
		});
	});
	test("the next dispatch starts with the breaker clear", async () => {
		// The breaker is per dispatch, not per session: a database that recovers must be
		// readable again on the next tool_call rather than staying written off.
		resetReadBudget();
		await withSleepBin(async () => {
			expect(await bdRun(["30"], 120)).toBeNull();
		});

		resetReadBudget();
		const previous = process.env.BD_BIN;
		process.env.BD_BIN = "true";
		try {
			const result = await bdRun([]);
			expect(result).not.toBeNull();
			expect(result?.code).toBe(0);
		} finally {
			if (previous === undefined) delete process.env.BD_BIN;
			else process.env.BD_BIN = previous;
		}
	});
});

