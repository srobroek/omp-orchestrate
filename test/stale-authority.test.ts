/**
 * Stale authority: work that banks on authority granted earlier and no longer valid.
 *
 * Three carriers of borrowed authority are attacked here. A review bot's verdict is
 * authority over ONE tree, named by a commit SHA; the moment the head moves that verdict
 * describes a tree nobody is merging. A bead's comment history is append-only, so a
 * verdict written in an earlier review round stays readable forever -- whether or not the
 * round it answered is still current. And the role a session claims to hold selects the
 * contract it is judged by, so a role name is itself authority a worker can try to write.
 *
 * Half of what this file records is a rule the gates genuinely enforce. The other half is
 * marked FINDING: a staleness rule that exists only as prose, with no predicate behind it.
 * Those cases assert the real behaviour rather than the wished-for one -- the gates are
 * friction, they fail open on unknowns, and a test that demands enforcement where the
 * design documents fail-open only teaches the next reader to delete it.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ExtensionContext, ToolCallEventResult } from "@oh-my-pi/pi-coding-agent";
import type { BdBead, BdComment } from "../src/bd";
import * as actualBd from "../src/bd";
import { forgetClaim, recordClaim } from "../src/claim-state";
import architect from "../src/contracts/architect.json";
import generic from "../src/contracts/generic.json";
import implementer from "../src/contracts/implementer.json";
import researcher from "../src/contracts/researcher.json";
import reviewer from "../src/contracts/reviewer.json";
import shepherd from "../src/contracts/shepherd.json";
import { orcRole, roleFromLabels } from "../src/identity";
import {
	type BotReviewState,
	type BotReviewVerdict,
	classifyBotReviews,
	configuredSlugs,
	EXIT_ACTIONABLE,
	EXIT_DECLINED,
	EXIT_STALE,
	EXIT_UNKNOWN,
	EXIT_WAITING,
	renderBotReview,
	reopenInstant,
} from "../src/tools/bot-review-probe";

// ---------------------------------------------------------------------------
// Review staleness at head. The classifier is pure, so no `gh` and no network.
// ---------------------------------------------------------------------------

const HEAD = "a".repeat(40);
const OLD_HEAD = "b".repeat(40);
const CODERABBIT = "coderabbitai[bot]";
const NOW = new Date("2026-07-30T12:00:00Z");
const POSTED = "2026-07-30T11:00:00Z";
const LIMIT_BODY =
	"Your included review limit is currently reached under our Fair Usage Limits Policy. " +
	"Your next included review will be available in 48 minutes.";

type Row = Record<string, unknown>;

function review(over: Row = {}): Row {
	return { login: CODERABBIT, state: "COMMENTED", body: "", commit: HEAD, url: "u", at: POSTED, ...over };
}

function notice(over: Row = {}): Row {
	return { login: CODERABBIT, body: LIMIT_BODY, at: POSTED, ...over };
}

function payload(over: Row = {}): Row {
	return { checks: [], reviews: [], comments: [], notices: [], ...over };
}

/** A finished CodeRabbit check, so no case below is decided by a still-running bot. */
const DONE = [{ name: "CodeRabbit", status: "COMPLETED" }];

function classify(data: unknown, opts: { head?: string } = {}): BotReviewVerdict {
	return classifyBotReviews(data, {
		head: opts.head === undefined ? HEAD : opts.head,
		slugs: configuredSlugs("coderabbitai", {}),
		now: NOW,
	});
}

const CLEAN_ROUND = "**Actionable comments posted: 0**\n\nnitpicks only, nothing blocking";

describe("a bot verdict is authority over one tree only", () => {
	test("a round that found nothing at the previous head is stale, never clean", () => {
		// THE banking attack: the newest verdict in existence says "nothing to fix", and it
		// is the round that would have merged -- one push earlier.
		const result = classify(payload({ checks: DONE, reviews: [review({ body: CLEAN_ROUND, commit: OLD_HEAD })] }));

		expect(result.verdict).toBe("stale");
		expect(result.code).toBe(EXIT_STALE);
		// The superseded round's URL is not published as "the review that decided this":
		// a caller citing `summary` would be citing a verdict about another tree.
		expect(result.findings.summary).toBe("none");
		expect(result.findings.files).toEqual([]);
		expect(renderBotReview(result)).toStartWith("BOT_REVIEW stale ");
	});

	test("the same round at head is clean, so the case above is not vacuously stale", () => {
		const result = classify(payload({ checks: DONE, reviews: [review({ body: CLEAN_ROUND })] }));

		expect(result.verdict).toBe("clean");
		expect(result.code).toBe(0);
		expect(result.findings.summary).toBe("u");
	});

	test("an APPROVED verdict at an older head does not approve this head", () => {
		const older = review({ state: "APPROVED", body: CLEAN_ROUND, commit: OLD_HEAD });

		expect(classify(payload({ checks: DONE, reviews: [older] })).code).toBe(EXIT_STALE);
	});

	test("an APPROVED verdict with no summary count is a wait, not an approval", () => {
		// Even at the exact head, the bot's review STATE never clears the gate on its own:
		// the count is the actionability signal, and an unrecognised body carries none.
		// Reading `state: APPROVED` as clean would merge a round whose findings went
		// unparsed.
		const result = classify(payload({ checks: DONE, reviews: [review({ state: "APPROVED", body: "LGTM" })] }));

		expect(result.verdict).toBe("pending");
		expect(result.code).toBe(EXIT_WAITING);
	});

	test.each([
		["absent", { login: CODERABBIT, state: "COMMENTED", body: CLEAN_ROUND, url: "u", at: POSTED }],
		["empty", review({ commit: "", body: CLEAN_ROUND })],
	])("a review with an %s commit association is stale, never clean", (_label, row) => {
		// The SHA is the ENTIRE association -- no branch, ref, or timestamp can stand in for
		// it -- so a review naming no commit cannot be shown to describe the tree being
		// merged.
		const result = classify(payload({ checks: DONE, reviews: [row] }));

		expect(result.verdict).toBe("stale");
		expect(result.code).toBe(EXIT_STALE);
	});

	test.each(["", "   "])("a blank head is unread evidence, not a clean round", head => {
		// The hole this closed: with head="" a review carrying no `commit_id` compared
		// EQUAL to it, so a round that named no commit graded as clean, exit 0 -- the bot
		// gate cleared by evidence that placed itself nowhere. `fetchBotReviewEvidence`
		// refuses a head-less `gh pr view`, but the comparison lives in the classifier and
		// the classifier is exported.
		const data = payload({
			checks: DONE,
			reviews: [{ login: CODERABBIT, state: "APPROVED", body: CLEAN_ROUND, url: "u", at: POSTED }],
		});
		const result = classify(data, { head });

		expect(result.verdict).toBe("unknown");
		expect(result.code).toBe(EXIT_UNKNOWN);
		expect(result.findings.detail).toContain("no head SHA");
		expect(renderBotReview(result)).not.toContain("clean");
	});

	test("a branch name is not evidence; only the SHA is", () => {
		// Reviews are read per-PR (`repos/<repo>/pulls/<pr>/reviews`), so a review from
		// another PR never enters the payload at all. Within one PR the branch is not part
		// of the evidence: a row naming the PR's own branch at the wrong SHA is still stale,
		// and a row naming a foreign branch at the right SHA still decides.
		const wrongSha = payload({
			checks: DONE,
			reviews: [review({ body: CLEAN_ROUND, commit: OLD_HEAD, head_ref: "feat/mine", branch: "feat/mine" })],
		});
		expect(classify(wrongSha).code).toBe(EXIT_STALE);

		const rightSha = payload({
			checks: DONE,
			reviews: [review({ body: "Actionable comments posted: 2", head_ref: "someone/else", branch: "someone/else" })],
		});
		expect(classify(rightSha).code).toBe(EXIT_ACTIONABLE);
	});

	test("a re-opened round after a new push is graded at the new head, in both steps", () => {
		const approved = review({ state: "APPROVED", body: CLEAN_ROUND, commit: OLD_HEAD, url: "round-1" });

		// Step one: the push has landed, the bot has not answered again. The approval does
		// not travel with the branch.
		const beforeRerun = classify(payload({ checks: DONE, reviews: [approved] }));
		expect(beforeRerun.verdict).toBe("stale");
		expect(beforeRerun.findings.detail).toContain("older head");

		// Step two: round two arrives at the new head and finds problems. The reopened round
		// decides, and it is the one cited.
		const round2 = review({ body: "Actionable comments posted: 2", url: "round-2", at: "2026-07-30T11:50:00Z" });
		const reopened = classify(payload({ checks: DONE, reviews: [approved, round2] }));

		expect(reopened.verdict).toBe("actionable");
		expect(reopened.code).toBe(EXIT_ACTIONABLE);
		expect(reopened.findings.actionable).toBe(2);
		expect(reopened.findings.summary).toBe("round-2");
	});

	test("only the two zero codes are clean or absent, and the vocabulary is exact", () => {
		// The exit table `orc-shepherd.md` and `SKILL.md` both quote, asserted in one place:
		// a caller keying on the leading token can never read "clean" off a round that was
		// not one, and `unknown`/`declined` never carry exit 0.
		const cases: [BotReviewState, number, unknown][] = [
			["absent", 0, payload({ checks: [{ name: "test", status: "COMPLETED" }] })],
			["clean", 0, payload({ checks: DONE, reviews: [review({ body: CLEAN_ROUND })] })],
			["pending", EXIT_WAITING, payload({ checks: [{ name: "CodeRabbit", status: "IN_PROGRESS" }] })],
			["stale", EXIT_STALE, payload({ checks: DONE, reviews: [review({ body: CLEAN_ROUND, commit: OLD_HEAD })] })],
			[
				"actionable",
				EXIT_ACTIONABLE,
				payload({ checks: DONE, reviews: [review({ body: "Actionable comments posted: 1" })] }),
			],
			["declined", EXIT_DECLINED, payload({ checks: DONE, notices: [notice()] })],
			["unknown", EXIT_UNKNOWN, "not a payload at all"],
		];

		for (const [verdict, code, data] of cases) {
			const result = classify(data);
			expect([result.verdict, result.code]).toEqual([verdict, code]);
			expect(renderBotReview(result)).toStartWith(`BOT_REVIEW ${verdict} `);
			if (verdict !== "clean" && verdict !== "absent") expect(result.code).not.toBe(0);
		}
	});
});

// ---------------------------------------------------------------------------
// Timestamp trust. The probe hand-parses ISO instants precisely so that no
// verdict depends on where the machine thinks it is.
// ---------------------------------------------------------------------------

// Captured before anything mutates the zone. `delete process.env.TZ` does NOT restore
// Bun's cached zone, so restoring means assigning a concrete name back.
const ORIGINAL_TZ = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
const BASELINE_OFFSET = new Date().getTimezoneOffset();
/** Two extremes and a half-hour zone; none of them is UTC. */
const SHIFTED = ["Pacific/Kiritimati", "Pacific/Pago_Pago", "Asia/Kolkata"];
const NAIVE_POSTED = "2026-07-30T11:00:00";
const NAIVE_LATE = "2026-07-30T11:59:00";

function underTz<T>(tz: string, body: () => T): T {
	process.env.TZ = tz;
	try {
		return body();
	} finally {
		process.env.TZ = ORIGINAL_TZ;
	}
}

describe("a verdict does not depend on the machine's timezone", () => {
	test("the hazard is live on this machine: one naive stamp reads differently per zone", () => {
		// Without this the sweep below could pass on a box where nothing moves.
		const readings = new Set(SHIFTED.map(tz => underTz(tz, () => new Date(NAIVE_POSTED).toISOString())));

		expect(readings.size).toBe(SHIFTED.length);
		expect(readings.has("2026-07-30T11:00:00.000Z")).toBe(false);
	});

	test.each(["UTC", ...SHIFTED])("an offset-less notice stamp is UTC under TZ=%s", tz => {
		underTz(tz, () => {
			expect(reopenInstant(NAIVE_POSTED, 60)?.toISOString()).toBe("2026-07-30T12:00:00.000Z");

			// Posted 11:00 + 48m = 11:48, already past at NOW=12:00.
			const reopened = classify(payload({ checks: DONE, notices: [notice({ at: NAIVE_POSTED })] }));
			expect(reopened.verdict).toBe("declined");
			expect(reopened.findings.wait).toBe("2026-07-30T11:48:00+00:00");
			expect(reopened.findings.detail).toContain("reopened at");

			// The verdict that actually FLIPS under a local-time read: at +14 the naive stamp
			// lands on the previous day, so a window with 47 minutes left would report as
			// reopened and burn a re-trigger.
			const live = classify(payload({ checks: DONE, notices: [notice({ at: NAIVE_LATE })] }));
			expect(live.findings.wait).toBe("2026-07-30T12:47:00+00:00");
			expect(live.findings.detail).toContain("retry after");
			expect(live.findings.detail).not.toContain("reopened");
		});
	});

	test("a future-dated review cannot stand in for a review at head", () => {
		// `at` orders rounds WITHIN one head. It never establishes head association, so a
		// forged or clock-skewed stamp cannot promote a superseded clean round over the
		// round that actually ran on this tree.
		const result = classify(
			payload({
				checks: DONE,
				reviews: [
					review({ body: "Actionable comments posted: 2", url: "at-head" }),
					review({ body: CLEAN_ROUND, commit: OLD_HEAD, url: "from-the-future", at: "2999-01-01T00:00:00Z" }),
				],
			}),
		);

		expect(result.verdict).toBe("actionable");
		expect(result.code).toBe(EXIT_ACTIONABLE);
		expect(result.findings.summary).toBe("at-head");
	});

	test("a future-dated refusal notice never reads as a reopened window", () => {
		const result = classify(payload({ checks: DONE, notices: [notice({ at: "2999-01-01T00:00:00Z" })] }));

		expect(result.verdict).toBe("declined");
		expect(result.code).toBe(EXIT_DECLINED);
		expect(result.findings.detail).toContain("retry after");
		expect(result.findings.detail).not.toContain("reopened");
	});

	test("FINDING: rounds at one head are ordered by timestamp STRING, not by instant", () => {
		// `compare` is Python's `<` on two strings, kept for parity with the script this
		// ports. That is chronological only while every stamp shares one offset spelling,
		// which GitHub's `submitted_at` does (always `Z`) -- so this is unreachable through
		// the real read path, and NOT a hole to fix by churning the comparator.
		//
		// It is pinned rather than left implicit because the exposure is real the moment
		// evidence arrives from anywhere else: below, `+14:00` spells 06:00Z -- the OLDER
		// round -- yet sorts last, and its clean count decides a head whose truly newest
		// round reported three findings.
		const result = classify(
			payload({
				checks: DONE,
				reviews: [
					review({ body: "Actionable comments posted: 3", url: "truly-newer", at: "2026-07-30T09:00:00Z" }),
					review({ body: CLEAN_ROUND, url: "string-newest", at: "2026-07-30T20:00:00+14:00" }),
				],
			}),
		);

		expect(result.verdict).toBe("clean");
		expect(result.findings.summary).toBe("string-newest");

		// With one offset spelling, out-of-order rows still pick the true latest.
		const uniform = classify(
			payload({
				checks: DONE,
				reviews: [
					review({ body: CLEAN_ROUND, url: "older", at: "2026-07-30T06:00:00Z" }),
					review({ body: "Actionable comments posted: 3", url: "newer", at: "2026-07-30T09:00:00Z" }),
				],
			}),
		);
		expect(uniform.verdict).toBe("actionable");
		expect(uniform.findings.summary).toBe("newer");
	});

	test("the sweep left the process zone as it found it", () => {
		// Declared last on purpose: it guards this file's own cleanup, so a sibling test
		// file cannot inherit a shifted clock.
		expect(new Date().getTimezoneOffset()).toBe(BASELINE_OFFSET);
	});
});

// ---------------------------------------------------------------------------
// Exit-contract authority replay. Only `../src/bd` is replaced; the evaluator,
// the predicate grammar, and the six role contracts are the real ones.
// ---------------------------------------------------------------------------

/** Reads the evaluator performs, swapped per scenario. */
interface Reads {
	bead: BdBead | null;
	/**
	 * Keyed by bead id, unlike test/exit-bounce.test.ts: the reviewer contract reads its
	 * verdict off the LINKED node, and an id-blind mock would satisfy that from the claimed
	 * wisp's own comments -- passing for the wrong reason.
	 */
	comments: Record<string, BdComment[]>;
	linked: string[];
}

let reads: Reads;
let issued: string[][];

const original = { ...actualBd };
const mocked = {
	...original,
	bdShow: async () => reads.bead,
	bdList: async () => [],
	bdComments: async (id: string) => reads.comments[id] ?? [],
	bdLinked: async () => reads.linked,
	bdRun: async (args: string[]) => {
		issued.push(args);
		return { code: 0, stdout: "", stderr: "" };
	},
};

mock.module("../src/bd", () => mocked);

// Dynamic by necessity: a static import is hoisted above `mock.module`, so the evaluator
// would bind the real `bd` and shell out.
const { gateExitContract, resetUnclaimedReminder, satisfies } = await import("../src/gates/exit");

afterAll(() => {
	mock.module("../src/bd", () => original);
	process.env.TZ = ORIGINAL_TZ;
	forgetClaim();
});

const NODE = "orc-42";
const WISP = "orc-42.1";
const DELIVERED_SHA = "c".repeat(40);

/** A session declaring one role, or none at all so the generic fallback applies. */
function roleCtx(role?: string): ExtensionContext {
	const prompt = role === undefined ? "you are a helpful assistant" : `ORC-ROLE: ${role}`;
	return { getSystemPrompt: () => [prompt] } as unknown as ExtensionContext;
}

const IMPLEMENTER = roleCtx("implementer");

/**
 * An implementer node satisfying its git contract outright: captured branch, final sha,
 * reviewer handoff, assignee cleared, and a REPORTED comment. The control every authority
 * case below is one field away from.
 */
function delivered(metadata: Record<string, unknown> = {}, overrides: Partial<BdBead> = {}): BdBead {
	return {
		id: NODE,
		status: "in_progress",
		assignee: "",
		labels: ["agent:reviewer"],
		metadata: { worktree: "/tmp/wt", branch: "omp/task/orc-42", head_sha: DELIVERED_SHA, ...metadata },
		...overrides,
	};
}

function failures(result: ToolCallEventResult | undefined): { check: string; detail: string }[] {
	expect(result?.block).toBe(true);
	const reason = JSON.parse(result?.reason ?? "") as { failed_checks: { check: string; detail: string }[] };
	return reason.failed_checks;
}

function checks(result: ToolCallEventResult | undefined): string[] {
	return [...new Set(failures(result).map(failure => failure.check))].sort();
}

beforeEach(() => {
	issued = [];
	reads = { bead: delivered(), comments: { [NODE]: [{ text: "REPORTED: 3 files, tests green" }] }, linked: [] };
	resetUnclaimedReminder();
	recordClaim({ actor: "orc-impl-1", beadIds: [NODE] });
});

describe("G4 replay of an earlier round's verdict", () => {
	test("the control passes, so every failure below is caused by the field it names", async () => {
		expect(await gateExitContract(IMPLEMENTER)).toBeUndefined();
		expect(issued).toEqual([]);
	});

	test("FINDING: an approval written in round one satisfies round three unchanged", async () => {
		// No predicate in any of the six contracts encodes round freshness, and none can:
		// `BdComment` carries `text` and `author` only -- no round, no timestamp -- so there
		// is nothing to compare `metadata.review_round` against. An APPROVE from the round
		// before the last push therefore still closes the current round's contract.
		//
		// Freshness IS enforced one layer out: the queue resolver requires a `state:approved`
		// bead matching `repo`, `pr` AND `head_sha` (`references/queue-watcher.md`). The exit
		// contract has no equivalent.
		reads.bead = { id: WISP, status: "in_progress", assignee: "", labels: [], metadata: { review_round: "3" } };
		reads.linked = [NODE];
		reads.comments = { [WISP]: [], [NODE]: [{ text: "REVIEW verdict=approve round=1 head=b0b0b0b" }] };
		recordClaim({ actor: "orc-rev-1", beadIds: [WISP] });

		expect(await gateExitContract(roleCtx("reviewer"))).toBeUndefined();
		expect(issued).toEqual([]);
	});

	test("the same wisp with no verdict at all is refused, so the replay is what satisfied it", async () => {
		reads.bead = { id: WISP, status: "in_progress", assignee: "", labels: [], metadata: { review_round: "3" } };
		reads.linked = [NODE];
		reads.comments = { [WISP]: [], [NODE]: [{ text: "note: read the diff, no opinion recorded" }] };
		recordClaim({ actor: "orc-rev-1", beadIds: [WISP] });

		expect(checks(await gateExitContract(roleCtx("reviewer")))).toEqual(["verdict"]);
	});

	test("FINDING: metadata.review_round is written by the bounce and read by nothing", async () => {
		// The evaluator resets `review_round: 0` when it releases a bead, which is the only
		// mention of the field in the plugin. Its value cannot change any verdict.
		const verdicts: (ToolCallEventResult | undefined)[] = [];
		for (const round of [undefined, "0", "9"]) {
			reads.bead = delivered(round === undefined ? {} : { review_round: round });
			verdicts.push(await gateExitContract(IMPLEMENTER));
		}

		expect(verdicts).toEqual([undefined, undefined, undefined]);
		expect(issued).toEqual([]);
	});

	test("FINDING: an unrecognised predicate passes silently, so a freshness clause would be inert", () => {
		// Documented and deliberate: a contract naming a predicate this evaluator has not
		// implemented must not fail every exit. The trap is that adding a freshness clause to
		// a contract JSON -- the obvious fix for the finding above -- READS as enforcement
		// while changing nothing until `satisfies` learns the form.
		const evidence = { bead: delivered(), verbs: [], linkedVerbs: [] };
		for (const wished of [
			"comment.round == metadata.review_round",
			"comment.head_sha == metadata.head_sha",
			"review fresh at head",
			// A typo in a recognised form falls through the same way: an unclosed bracket, a
			// capitalised prefix, or a hyphen silently disables the check it was meant to be.
			"comment.verb in [REPORTED",
			"Comment.verb in [REPORTED]",
			"metadata.head-sha",
		]) {
			expect(satisfies(wished, evidence)).toBe(true);
		}

		// The contrast that makes the above a finding rather than a shrug: a form the
		// evaluator DOES recognise fails when unmet.
		expect(satisfies("metadata.output_ref", evidence)).toBe(false);
		expect(satisfies("comment.verb in [REPORTED]", evidence)).toBe(false);
	});

	test("FINDING: metadata presence is not provenance -- any string satisfies the delivery check", async () => {
		// `metadata.<key>` is a presence test. The exit contract never checks that `head_sha`
		// is a sha, that it is reachable from `metadata.branch`, or that this worker produced
		// it -- while `resolve-queue-dispatch.ts` applies `HEAD_SHA_RE` to the same field. A
		// worker can close its `delivery` check with the word "none".
		for (const sha of ["none", "unknown", "see the branch", OLD_HEAD]) {
			reads.bead = delivered({ head_sha: sha });
			expect(await gateExitContract(IMPLEMENTER)).toBeUndefined();
		}

		// Absent, however, is refused: the check is live, it just cannot judge the value.
		reads.bead = delivered({ head_sha: undefined });
		expect(checks(await gateExitContract(IMPLEMENTER))).toEqual(["delivery"]);
	});
});

describe("G4 deny-state and deny-metadata replay", () => {
	test.each(["merge_sha", "pr"])("an implementer pointing at a %s it cannot own is refused", async key => {
		reads.bead = delivered({ [key]: key === "pr" ? "412" : "d".repeat(40) });

		const failed = failures(await gateExitContract(IMPLEMENTER));
		// Denied outright: a plausible value is refused exactly like an implausible one,
		// because the evaluator cannot attribute authorship of a field.
		expect(failed.map(f => f.check)).toEqual(["metadata-authority"]);
		expect(failed[0]?.detail).toContain(`metadata.${key}`);
	});

	test("both denied keys at once are reported as two separate failures", async () => {
		reads.bead = delivered({ merge_sha: "d".repeat(40), pr: "412" });

		const named = failures(await gateExitContract(IMPLEMENTER)).map(f => f.detail);
		expect(named).toHaveLength(2);
		expect(named.join(" ")).toContain("metadata.merge_sha");
		expect(named.join(" ")).toContain("metadata.pr");
	});

	test.each([
		["status", (denied: string): Partial<BdBead> => ({ status: denied })],
		["state: label", (denied: string): Partial<BdBead> => ({ labels: ["agent:reviewer", `state:${denied}`] })],
	])("a denied state carried as a %s is refused, whoever set it", async (_carrier, shape) => {
		// A `state:` label is written by `bd set-state` and outlives the transition that set
		// it, so a role claiming the bead later inherits it. The gate cannot see who wrote it;
		// the bounce budget, not attribution, is what keeps this from trapping a worker.
		reads.bead = delivered({}, shape("closed"));

		const failed = failures(await gateExitContract(IMPLEMENTER));
		expect(failed.map(f => f.check)).toEqual(["state-authority"]);
		expect(failed[0]?.detail).toContain("closed");
	});

	test("a mixed-case state label is refused exactly like a mixed-case status", async () => {
		// The hole this closed: `status` was lower-cased before the comparison and the label
		// was not, so `state:CLOSED` walked past the denial that `status: "CLOSED"` was caught
		// by -- a one-keystroke bypass of the authority check.
		reads.bead = delivered({}, { labels: ["agent:reviewer", "state:CLOSED"] });
		expect(checks(await gateExitContract(IMPLEMENTER))).toEqual(["state-authority"]);

		reads.bead = delivered({}, { status: "CLOSED" });
		expect(checks(await gateExitContract(IMPLEMENTER))).toEqual(["state-authority"]);
	});

	test("the gate owns the state: dimension only, and does not guess at other prefixes", async () => {
		reads.bead = delivered({}, { labels: ["agent:reviewer", "phase:closed", "was-state:closed"] });

		expect(await gateExitContract(IMPLEMENTER)).toBeUndefined();
	});

	test("FINDING: a shepherd may declare LANDED with no merge evidence at all", async () => {
		// `merge_sha` is DENIED to every role that must not write it and REQUIRED of none.
		// The shepherd's own contract comment says why the landed check is missing -- the
		// predicate grammar has no verb-conditional form -- so `shepherd.md` prose owns it. A
		// disposition verb alone closes the contract.
		reads.bead = { id: NODE, status: "closed", assignee: "", labels: [], metadata: {} };
		reads.comments = { [NODE]: [{ text: "LANDED pr=412" }] };

		expect(await gateExitContract(roleCtx("shepherd"))).toBeUndefined();

		// And a junk sha is equally acceptable, because nothing reads it back.
		reads.bead = { id: NODE, status: "closed", assignee: "", labels: [], metadata: { merge_sha: "probably fine" } };
		expect(await gateExitContract(roleCtx("shepherd"))).toBeUndefined();
	});
});

/** The six role contracts, driven off the JSON so no assertion below can drift from them. */
interface RoleContract {
	completion: { check: string; require: string; when?: string | string[] }[];
	authority: { deny_states: string[]; deny_metadata: string[] };
}

const ROLE_CONTRACTS: [string, RoleContract][] = [
	["architect", architect],
	["implementer", implementer],
	["researcher", researcher],
	["reviewer", reviewer],
	["shepherd", shepherd],
	["generic", generic],
];

/** Roles whose contract asks for something of EVERY exit, whatever the resource kind. */
const WITH_FLOOR = ROLE_CONTRACTS.filter(([, contract]) =>
	contract.completion.some(check => check.when === undefined),
).map(([role]) => role);

/** Roles whose every check is gated on a resource kind, so an unstamped bead skips them all. */
const WITHOUT_FLOOR = ROLE_CONTRACTS.map(([role]) => role).filter(role => !WITH_FLOOR.includes(role));

/**
 * A role name is authority: it selects the contract the exit is judged by, and a worker can
 * write one with `bd label add <bead> agent:<name>`.
 *
 * The chain this closes ran: `ORC_ROLES[candidate]` and `CONTRACTS[role]` were plain index
 * lookups on object literals, so `agent:constructor` resolved through `Object.prototype` to
 * a truthy `Function`. The `?? CONTRACTS.generic` fallback never fired, `contract.completion
 * ?? []` read as an empty check list, and the worker exited with its contract wholly
 * unevaluated. One self-written label bought a free exit.
 *
 * The semantics chosen is `generic`, not refusal. `generic.json` documents itself as the
 * contract for "ANY agent that holds a claim but has no per-agent rules file" -- a name with
 * no contract entry is exactly that, and the fleet-wide net is what a claim is supposed to
 * fall back to. Refusing outright would strand a legitimately mislabelled bead behind a
 * verdict it cannot correct, which is the opposite of friction.
 */
describe("G4 a role name cannot buy a contract-free exit", () => {
	// Not a denylist of `constructor`: the class of inherited keys is larger than any list,
	// so the fix is an own-property test and these are samples of it.
	const INHERITED = ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"];

	test.each(INHERITED)("a bead labelled agent:%s names no role", name => {
		expect(roleFromLabels([`agent:${name}`])).toBeUndefined();
	});

	test.each(INHERITED)("a session declaring ORC-ROLE: %s holds no role", name => {
		expect(orcRole(roleCtx(name))).toBeUndefined();
	});

	const REAL_ROLES = ["architect", "implementer", "reviewer", "researcher", "shepherd"] as const;

	test("the five real roles still resolve, from either carrier", () => {
		for (const role of REAL_ROLES) {
			expect(roleFromLabels([`agent:${role}`])).toBe(role);
			expect(orcRole(roleCtx(role))).toBe(role);
		}
		// An inherited name is SKIPPED, not fatal: a real routing label after it still wins.
		expect(roleFromLabels(["agent:constructor", "agent:implementer"])).toBe("implementer");
	});

	test.each(INHERITED)("a bead labelled agent:%s is evaluated against the generic contract", async name => {
		// End to end, through the real evaluator: the label is the only thing naming a role,
		// and the exit must be judged, not waved through with an empty check list.
		reads.bead = { id: NODE, status: "in_progress", assignee: "", labels: [`agent:${name}`], metadata: {} };
		reads.comments = { [NODE]: [{ text: "note: finished, I think" }] };

		// `generic.completion` is the single REPORTED check, and this bead has no such
		// comment -- so a non-empty failure list proves a real contract was applied.
		expect(checks(await gateExitContract(roleCtx()))).toEqual(["reported"]);
	});

	test("a session declaring an inherited role name is judged the same way", async () => {
		reads.bead = { id: NODE, status: "in_progress", assignee: "", labels: [], metadata: {} };
		reads.comments = { [NODE]: [{ text: "note: finished, I think" }] };

		expect(checks(await gateExitContract(roleCtx("constructor")))).toEqual(["reported"]);
	});

	test("generic's authority list applies too, so the bypass cannot smuggle a merge_sha", async () => {
		reads.bead = {
			id: NODE,
			status: "closed",
			assignee: "",
			labels: ["agent:constructor"],
			metadata: { merge_sha: "d".repeat(40) },
		};
		reads.comments = { [NODE]: [{ text: "REPORTED: done" }] };

		// `closed` and `merge_sha` are both denied to the generic role.
		expect(checks(await gateExitContract(roleCtx()))).toEqual(["metadata-authority", "state-authority"]);
	});

	test.each([...WITH_FLOOR, ...INHERITED])("a bead that satisfies nothing is judged under role %s", async name => {
		// The invariant both halves of the chain exist to hold, over every role name the
		// system can produce that has an unconditional check: a claimed bead delivering
		// nothing is never waved through. A real role is judged by its own contract, an
		// inherited name by the generic net -- neither by an empty check list. This fails if
		// either own-property guard is removed, without asserting which one carries it.
		reads.bead = { id: NODE, status: "in_progress", assignee: "", labels: [`agent:${name}`], metadata: {} };
		reads.comments = { [NODE]: [{ text: "note: finished, I think" }] };

		expect(checks(await gateExitContract(roleCtx()))).not.toEqual([]);
	});

	test.each(WITHOUT_FLOOR)("FINDING: role %s has no unconditional check, so an unstamped node exits unjudged", async name => {
		// Not a bypass of the role lookup -- a gap in the contract itself. Every
		// `researcher.json` check is `when`-gated on `artifact`, `comment`, or `escalation`,
		// and `resourceKind` yields one of those only from an explicit `execution_kind` or a
		// stamped `artifacts_dir`. A researcher node the dispatcher left unstamped -- or one
		// stamped `worktree`, which derives `git` -- matches no check at all and exits with
		// nothing required of it. `comment` is unreachable from the derivation entirely.
		//
		// Asserted, not fixed: giving the role a floor is a fleet-wide contract change, and
		// the day one is added this test flips and must be rewritten.
		for (const metadata of [{}, { worktree: "/tmp/wt" }]) {
			reads.bead = { id: NODE, status: "in_progress", assignee: "", labels: [`agent:${name}`], metadata };
			reads.comments = { [NODE]: [{ text: "note: nothing delivered" }] };
			expect(await gateExitContract(roleCtx())).toBeUndefined();
		}

		// The same role IS judged once the dispatcher stamps a kind its checks name.
		reads.bead = {
			id: NODE,
			status: "in_progress",
			assignee: "",
			labels: [`agent:${name}`],
			metadata: { artifacts_dir: "/tmp/art" },
		};
		expect(checks(await gateExitContract(roleCtx()))).not.toEqual([]);
	});
});

/**
 * Every contract's `authority` list. The point is that no declared denial is a silent
 * no-op: `ORCHESTRATOR_ANCHORS` exempts the keys a dispatcher stamps, and a contract
 * denying one of those would read as enforcement while doing nothing. Today none does --
 * this is what fails the day one is added.
 */
describe("G4 every declared denial is live", () => {
	for (const [role, contract] of ROLE_CONTRACTS) {
		// `generic` is reached by declaring no role at all, so its bead must carry no `agent:`
		// routing label either -- one would select a different contract.
		const ctx = roleCtx(role === "generic" ? undefined : role);
		const bead = (over: Partial<BdBead>): BdBead => ({
			id: NODE,
			status: "in_progress",
			assignee: "",
			labels: [],
			metadata: {},
			...over,
		});

		test.each(contract.authority.deny_metadata)(`${role} denies metadata.%s`, async key => {
			reads.bead = bead({ metadata: { [key]: "anything" } });
			expect(checks(await gateExitContract(ctx))).toContain("metadata-authority");
		});

		test.each(contract.authority.deny_states)(`${role} denies the state %s`, async denied => {
			reads.bead = bead({ status: denied });
			expect(checks(await gateExitContract(ctx))).toContain("state-authority");

			reads.bead = bead({ labels: [`state:${denied}`] });
			expect(checks(await gateExitContract(ctx))).toContain("state-authority");
		});
	}
});
