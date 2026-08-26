import { describe, expect, test } from "bun:test";
import { bdRun, commentVerb, metadataString, resetReadBudget } from "../src/bd";

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

