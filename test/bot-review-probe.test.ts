/**
 * Conformance tests for the native `bot-review-probe` port.
 *
 * Every case in `skills/orchestrate/scripts/_test_bot_review_probe.py` appears here,
 * fixture for fixture: the pytest suite is the contract, and the classification half is
 * pure, so none of these tests runs a subprocess. The three `gh` reads are answered from a
 * transcript through the exported {@link Exec} seam.
 *
 * Where the script's CLI was the observable surface (exit code, rendered stdout, the `bots`
 * subcommand, `$PR_REVIEW_BOTS`), the test asserts on the function that now carries it:
 * `code` for the exit status, `renderBotReview` for stdout, `adapterNote` for the roster.
 */

import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { zod } from "@oh-my-pi/pi-coding-agent";
import { describe, expect, test } from "bun:test";
import {
	adapterNote,
	type BotReviewDetails,
	type BotReviewVerdict,
	classifyBotReviews,
	configuredSlugs,
	EXIT_ACTIONABLE,
	EXIT_DECLINED,
	EXIT_STALE,
	EXIT_UNKNOWN,
	EXIT_WAITING,
	type Exec,
	type ExecResult,
	fetchBotReviewEvidence,
	ghApiArgv,
	ghTimeoutMs,
	parsePrRef,
	prViewArgv,
	registerBotReviewProbe,
	renderBotReview,
	reopenInstant,
	waitMinutes,
} from "../src/tools/bot-review-probe";

const HEAD = "a".repeat(40);
const OLD_HEAD = "b".repeat(40);
const CODERABBIT = "coderabbitai[bot]";

type Row = Record<string, unknown>;

function review(over: Row = {}): Row {
	return { login: CODERABBIT, state: "COMMENTED", body: "", commit: HEAD, url: "u", at: "x", ...over };
}

function comment(over: Row = {}): Row {
	return { login: CODERABBIT, path: "a.py", line: 12, commit: HEAD, url: "c", ...over };
}

function payload(over: Row = {}): Row {
	return { checks: [], reviews: [], comments: [], notices: [], ...over };
}

const NOW = new Date("2026-07-30T12:00:00Z");
const POSTED = "2026-07-30T11:00:00Z";
// CodeRabbit's wording at the time of the incident. The probe must not depend on this exact
// sentence -- see the reworded variants below.
const LIMIT_BODY =
	"Your included review limit is currently reached under our Fair Usage Limits Policy. " +
	"This review may still proceed through usage-based billing if eligible. " +
	"Your next included review will be available in 48 minutes.";

function notice(over: Row = {}): Row {
	return { login: CODERABBIT, body: LIMIT_BODY, at: POSTED, ...over };
}

/** The pytest `classify()` helper: fixed head, fixed `now`, and an env that cannot leak in. */
function classify(data: unknown, opts: { head?: string; bots?: string; now?: Date } = {}): BotReviewVerdict {
	return classifyBotReviews(data, {
		head: opts.head ?? HEAD,
		slugs: configuredSlugs(opts.bots ?? "coderabbitai", {}),
		now: opts.now ?? NOW,
	});
}

describe("absence", () => {
	test("no configured bot is absent, not a wait", () => {
		const result = classify(payload({ checks: [{ name: "test", status: "COMPLETED" }] }));
		expect(result.verdict).toBe("absent");
		expect(result.code).toBe(0);
	});

	test("human reviews alone are not a bot round", () => {
		const data = payload({ reviews: [review({ login: "sjors", state: "APPROVED", body: "lgtm" })] });
		expect(classify(data).verdict).toBe("absent");
	});

	test("an unconfigured bot stays invisible", () => {
		const data = payload({
			checks: [{ name: "Greptile", status: "COMPLETED" }],
			reviews: [review({ login: "greptile-apps[bot]", body: "Actionable comments posted: 3" })],
		});
		expect(classify(data).verdict).toBe("absent");
	});
});

describe("pending", () => {
	test("a running check is pending", () => {
		const result = classify(payload({ checks: [{ name: "CodeRabbit", status: "IN_PROGRESS" }] }));
		expect(result.verdict).toBe("pending");
		expect(result.code).toBe(EXIT_WAITING);
	});

	test("a check is matched by its details URL", () => {
		const data = payload({
			checks: [{ name: "review", detailsUrl: "https://coderabbit.ai/x", status: "IN_PROGRESS" }],
		});
		expect(classify(data).verdict).toBe("pending");
	});

	test("a completed check without a review is still pending", () => {
		const result = classify(payload({ checks: [{ name: "CodeRabbit", status: "COMPLETED" }] }));
		expect(result.verdict).toBe("pending");
		expect(result.findings.detail).toContain("no review posted yet");
	});

	test("a review without a recognised verdict is pending", () => {
		expect(classify(payload({ reviews: [review({ body: "just some prose" })] })).verdict).toBe("pending");
	});

	test("a terminal commit-status state counts as completed", () => {
		// The status API has no `status` field at all; only "completed" counted as finished,
		// so a bot reporting SUCCESS read as "still running" and waited forever.
		for (const state of ["SUCCESS", "FAILURE", "ERROR"]) {
			const data = payload({ checks: [{ name: "CodeRabbit", state }] });
			const result = classify(data);
			expect(result.verdict).toBe("pending");
			expect(result.findings.detail).toContain("no review posted yet");
		}
		const running = classify(payload({ checks: [{ name: "CodeRabbit", state: "PENDING" }] }));
		expect(running.findings.detail).toBe("bot check still running");
	});
});

describe("stale", () => {
	test("a review of an older head only is stale, never clean", () => {
		const data = payload({ reviews: [review({ body: "Actionable comments posted: 3", commit: OLD_HEAD })] });
		const result = classify(data);
		expect(result.verdict).toBe("stale");
		expect(result.code).toBe(EXIT_STALE);
	});
});

describe("verdicts", () => {
	test("zero actionable is clean", () => {
		const data = payload({
			checks: [{ name: "CodeRabbit", status: "COMPLETED" }],
			reviews: [review({ body: "**Actionable comments posted: 0**\n\nnitpicks follow" })],
		});
		const result = classify(data);
		expect(result.verdict).toBe("clean");
		expect(result.code).toBe(0);
		expect(result.findings.actionable).toBe(0);
	});

	test("an actionable count bounces, and lists only bot comments at head", () => {
		const data = payload({
			checks: [{ name: "CodeRabbit", status: "COMPLETED" }],
			reviews: [review({ body: "Actionable comments posted: 2", url: "u2" })],
			comments: [
				comment({ path: "a.py", url: "c1" }),
				comment({ path: "human.py", login: "sjors", url: "c9" }),
				comment({ path: "old.py", commit: OLD_HEAD, url: "c8" }),
			],
		});
		const result = classify(data);
		expect(result.verdict).toBe("actionable");
		expect(result.code).toBe(EXIT_ACTIONABLE);
		expect(result.findings.actionable).toBe(2);
		expect(result.findings.files).toEqual(["a.py:12 c1"]);
		expect(result.findings.summary).toBe("u2");
	});

	test("changes requested without a count is actionable", () => {
		const data = payload({ reviews: [review({ state: "CHANGES_REQUESTED", body: "no count here" })] });
		const result = classify(data);
		expect(result.verdict).toBe("actionable");
		expect(result.findings.changesRequested).toBe(1);
	});

	test("the latest round at the same head supersedes an earlier one", () => {
		const data = payload({
			checks: [{ name: "CodeRabbit", status: "COMPLETED" }],
			reviews: [
				review({ body: "Actionable comments posted: 5", url: "r1", at: "2026-01-01T00:00:00Z" }),
				review({ body: "Actionable comments posted: 0", url: "r2", at: "2026-01-02T00:00:00Z" }),
			],
		});
		const result = classify(data);
		expect(result.verdict).toBe("clean");
		expect(result.findings.summary).toBe("r2");
	});

	test("a later round finding new problems reopens the bounce", () => {
		const data = payload({
			checks: [{ name: "CodeRabbit", status: "COMPLETED" }],
			reviews: [
				review({ body: "Actionable comments posted: 0", url: "r1", at: "2026-01-01T00:00:00Z" }),
				review({ body: "Actionable comments posted: 3", url: "r2", at: "2026-01-02T00:00:00Z" }),
			],
		});
		expect(classify(data).findings.actionable).toBe(3);
	});

	test("unordered timestamps still pick the latest", () => {
		const data = payload({
			checks: [{ name: "CodeRabbit", status: "COMPLETED" }],
			reviews: [
				review({ body: "Actionable comments posted: 4", url: "late", at: "2026-01-09T00:00:00Z" }),
				review({ body: "Actionable comments posted: 0", url: "early", at: "2026-01-02T00:00:00Z" }),
			],
		});
		const result = classify(data);
		expect(result.verdict).toBe("actionable");
		expect(result.findings.summary).toBe("late");
	});

	test("a latest unrecognised round does not reuse an older count", () => {
		const data = payload({
			checks: [{ name: "CodeRabbit", status: "COMPLETED" }],
			reviews: [
				review({ body: "Actionable comments posted: 0", url: "r1", at: "2026-01-01T00:00:00Z" }),
				review({ body: "review still processing", url: "r2", at: "2026-01-02T00:00:00Z" }),
			],
		});
		expect(classify(data).verdict).toBe("pending");
	});
});

describe("slug matching", () => {
	test("a short slug does not match unrelated checks", () => {
		const data = payload({ checks: [{ name: "test", status: "IN_PROGRESS" }] });
		expect(classify(data, { bots: "ai" }).verdict).toBe("absent");
	});

	test("another bot works by configuration alone", () => {
		const data = payload({
			checks: [{ name: "Greptile Review", status: "COMPLETED" }],
			reviews: [review({ login: "greptile-apps[bot]", state: "CHANGES_REQUESTED", body: "fix it" })],
		});
		expect(classify(data, { bots: "greptile-apps" }).verdict).toBe("actionable");
	});

	test("a bot without an adapter reports state only", () => {
		// No count parser: a COMMENTED round is a wait, not a silent pass.
		const data = payload({
			checks: [{ name: "Greptile Review", status: "COMPLETED" }],
			reviews: [review({ login: "greptile-apps[bot]", body: "Actionable comments posted: 2" })],
		});
		expect(classify(data, { bots: "greptile-apps" }).verdict).toBe("pending");
	});

	test("the adapter is reused for a slug variant", () => {
		const data = payload({
			checks: [{ name: "CodeRabbit", status: "COMPLETED" }],
			reviews: [review({ login: "coderabbit[bot]", body: "Actionable comments posted: 1" })],
		});
		const result = classify(data, { bots: "coderabbit" });
		expect(result.verdict).toBe("actionable");
		expect(result.findings.actionable).toBe(1);
	});

	test("multiple bots are configured together", () => {
		const data = payload({
			checks: [{ name: "CodeRabbit", status: "COMPLETED" }],
			reviews: [review({ body: "Actionable comments posted: 0" })],
		});
		const result = classify(data, { bots: "coderabbitai, greptile-apps" });
		expect(result.verdict).toBe("clean");
		expect(result.findings.bots).toBe("coderabbitai,greptile-apps");
	});
});

describe("declines", () => {
	test("a limit notice with no review is declined", () => {
		const data = payload({ checks: [{ name: "CodeRabbit", status: "COMPLETED" }], notices: [notice()] });
		const result = classify(data);
		expect(result.verdict).toBe("declined");
		expect(result.code).toBe(EXIT_DECLINED);
	});

	test("the reopen instant is relative to when the notice was posted", () => {
		// Posted 11:00 + 48m = 11:48, already past at NOW=12:00.
		const result = classify(payload({ notices: [notice()] }));
		expect(result.findings.detail).toContain("reopened");
		expect(result.findings.wait).toContain("2026-07-30T11:48:00");
	});

	test("a live window says retry after, not reopened", () => {
		const result = classify(payload({ notices: [notice({ at: "2026-07-30T11:59:00Z" })] }));
		expect(result.findings.detail).toContain("retry after");
		expect(result.findings.detail).not.toContain("reopened");
	});

	test("hours are converted to minutes", () => {
		const data = payload({
			notices: [notice({ body: "Rate limited. Try again in 2 hours.", at: "2026-07-30T11:59:00Z" })],
		});
		const result = classify(data);
		expect(result.verdict).toBe("declined");
		expect(result.findings.wait).toContain("2026-07-30T13:59:00");
	});

	test("no parseable figure is declined with an unknown wait", () => {
		// An unparsed deadline must read as re-check, never as a reopened window.
		const data = payload({ notices: [notice({ body: "Your review limit is currently reached." })] });
		const result = classify(data);
		expect(result.verdict).toBe("declined");
		expect(result.findings.wait).toBe("UNKNOWN");
		expect(result.findings.detail).toContain("re-check");
		expect(result.findings.detail).not.toContain("reopened");
	});

	test("reworded notices still parse", () => {
		// The match is deliberately loose: wording, order, and markup all vary.
		const variants = [
			"**Review limit reached.** Your next included review will be available in: 30 minutes",
			"Fair Usage Limits Policy — next review in 30 minutes.",
			"Rate limited; 30 minute cooldown remains before the next review.",
			"Quota reached. In 30 minutes your next review becomes available.",
		];
		for (const body of variants) {
			const result = classify(payload({ notices: [notice({ body })] }));
			expect(result.verdict).toBe("declined");
			expect(result.findings.wait).toContain("2026-07-30T11:30:00");
		}
	});

	test("a duration without a refusal indicator is not a decline", () => {
		const data = payload({ notices: [notice({ body: "I will re-review in 30 minutes if you push." })] });
		expect(classify(data).verdict).toBe("absent");
	});

	test("a declining review body is not counted as a review round", () => {
		const data = payload({
			checks: [{ name: "CodeRabbit", status: "COMPLETED" }],
			reviews: [review({ body: LIMIT_BODY, at: POSTED })],
		});
		expect(classify(data).verdict).toBe("declined");
	});

	test("an unconfigured bot's notice is invisible", () => {
		expect(classify(payload({ notices: [notice({ login: "greptile-apps[bot]" })] })).verdict).toBe("absent");
	});

	test("the newest notice sets the window", () => {
		const data = payload({
			notices: [
				notice({ body: "Rate limited, retry in 5 minutes.", at: "2026-07-30T09:00:00Z" }),
				notice({ body: "Rate limited, retry in 90 minutes.", at: "2026-07-30T11:30:00Z" }),
			],
		});
		expect(classify(data).findings.wait).toContain("2026-07-30T13:00:00");
	});

	test("a figure on an unreadable timestamp reports the raw wait, never a reopened window", () => {
		const data = payload({ notices: [notice({ body: "Quota reached, retry in 15 minutes.", at: "later" })] });
		const result = classify(data);
		expect(result.verdict).toBe("declined");
		expect(result.findings.wait).toBe("15m");
		expect(result.findings.detail).toContain("re-check");
		expect(result.findings.detail).not.toContain("reopened");
	});
});

describe("evidence beats a notice", () => {
	// A refusal notice lives in comment history forever; a real review outranks it.
	test("a review at head beats an old limit notice", () => {
		const data = payload({
			checks: [{ name: "CodeRabbit", status: "COMPLETED" }],
			reviews: [review({ body: "Actionable comments posted: 0", at: "2026-07-30T11:50:00Z" })],
			notices: [notice({ at: "2026-07-30T09:00:00Z" })],
		});
		const result = classify(data);
		expect(result.verdict).toBe("clean");
		expect(result.code).toBe(0);
	});

	test("an actionable review at head beats an old limit notice", () => {
		const data = payload({
			checks: [{ name: "CodeRabbit", status: "COMPLETED" }],
			reviews: [review({ body: "Actionable comments posted: 3", at: "2026-07-30T11:50:00Z" })],
			notices: [notice({ at: "2026-07-30T09:00:00Z" })],
		});
		const result = classify(data);
		expect(result.verdict).toBe("actionable");
		expect(result.findings.actionable).toBe(3);
	});

	test("a decline from an earlier commit does not mask the head review", () => {
		const data = payload({
			checks: [{ name: "CodeRabbit", status: "COMPLETED" }],
			reviews: [
				review({ body: LIMIT_BODY, commit: OLD_HEAD, at: "2026-07-30T09:00:00Z" }),
				review({ body: "Actionable comments posted: 0", at: "2026-07-30T11:50:00Z" }),
			],
		});
		expect(classify(data).verdict).toBe("clean");
	});

	test("a review at an older head only is stale, not declined", () => {
		const data = payload({
			checks: [{ name: "CodeRabbit", status: "COMPLETED" }],
			reviews: [review({ body: "Actionable comments posted: 3", commit: OLD_HEAD })],
			notices: [notice({ at: "2026-07-30T09:00:00Z" })],
		});
		const result = classify(data);
		expect(result.verdict).toBe("stale");
		expect(result.code).toBe(EXIT_STALE);
	});

	test("a running check still wins over a limit notice", () => {
		const data = payload({ checks: [{ name: "CodeRabbit", status: "IN_PROGRESS" }], notices: [notice()] });
		const result = classify(data);
		expect(result.verdict).toBe("pending");
		expect(result.code).toBe(EXIT_WAITING);
	});

	test("no notice keeps the existing pending case", () => {
		const result = classify(payload({ checks: [{ name: "CodeRabbit", status: "COMPLETED" }] }));
		expect(result.verdict).toBe("pending");
		expect(result.findings.detail).toContain("no review posted yet");
	});
});

describe("malformed evidence", () => {
	// PARITY: the script raised ValueError and let `main` print it and exit 2. The port
	// returns that exit code with `verdict: "unknown"` instead of raising, so the never-clean
	// rule cannot be lost to a missing `try`.
	test("a non-object payload is unknown", () => {
		const result = classify([1, 2, 3]);
		expect(result.code).toBe(EXIT_UNKNOWN);
		expect(result.verdict).toBe("unknown");
		expect(result.findings.detail).toBe("payload must be a JSON object");
	});

	test("non-array reviews are unknown", () => {
		const result = classify({ checks: [], reviews: { login: CODERABBIT }, comments: [] });
		expect(result.code).toBe(EXIT_UNKNOWN);
		expect(result.findings.detail).toContain("must be arrays");
	});

	test("non-array notices are unknown", () => {
		const result = classify({ checks: [], reviews: [], comments: [], notices: { a: 1 } });
		expect(result.code).toBe(EXIT_UNKNOWN);
		expect(result.findings.detail).toContain("must be arrays");
	});

	test("a non-object row inside reviews or notices is unknown", () => {
		expect(classify(payload({ reviews: ["nope"] })).findings.detail).toBe("each review must be an object");
		expect(classify(payload({ notices: [7] })).findings.detail).toBe("each notice must be an object");
	});

	test("an empty container is read as empty, not as malformed", () => {
		// Python's `or []` accepts every falsy spelling of "nothing here".
		for (const empty of [null, false, 0, "", {}, []]) {
			const result = classify({ checks: empty, reviews: empty, comments: empty, notices: empty });
			expect(result.verdict).toBe("absent");
		}
	});
});

describe("rendering and exit codes", () => {
	test("an actionable round renders its record and its comments", () => {
		const result = classify(
			payload({
				checks: [{ name: "CodeRabbit", status: "COMPLETED" }],
				reviews: [review({ body: "Actionable comments posted: 1", url: "u1" })],
				comments: [comment({ url: "c1" })],
			}),
		);
		expect(result.code).toBe(EXIT_ACTIONABLE);
		const text = renderBotReview(result);
		expect(text).toContain("BOT_REVIEW actionable");
		expect(text).toContain("COMMENT a.py:12 c1");
		expect(text).toContain("check=CodeRabbit/completed");
	});

	test("a declined round exits thirteen and renders the wait", () => {
		const result = classify(payload({ checks: [{ name: "CodeRabbit", status: "COMPLETED" }], notices: [notice()] }));
		expect(result.code).toBe(EXIT_DECLINED);
		const text = renderBotReview(result);
		expect(text).toContain("BOT_REVIEW declined");
		expect(text).toContain("wait=2026-07-30T11:48:00");
	});

	test("malformed evidence renders as unknown, never as clean", () => {
		const result = classify("notjson");
		expect(result.code).toBe(EXIT_UNKNOWN);
		expect(renderBotReview(result)).not.toContain("clean");
	});

	test("a bot check with no name or state still renders a placeholder", () => {
		const data = payload({ checks: [{ detailsUrl: "https://coderabbit.ai/x", status: "" }] });
		expect(renderBotReview(classify(data))).toContain("check=?/?");
	});
});

describe("configured slugs", () => {
	test("the environment configures bots without an argument", () => {
		const slugs = configuredSlugs(undefined, { PR_REVIEW_BOTS: "greptile" });
		expect(slugs).toEqual(["greptile"]);
		const data = payload({ checks: [{ name: "Greptile", status: "IN_PROGRESS" }] });
		expect(classifyBotReviews(data, { head: HEAD, slugs, now: NOW }).code).toBe(EXIT_WAITING);
	});

	test("the default applies with no environment", () => {
		const slugs = configuredSlugs(undefined, {});
		expect(slugs).toEqual(["coderabbitai"]);
		const data = payload({ checks: [{ name: "CodeRabbit", status: "IN_PROGRESS" }] });
		const result = classifyBotReviews(data, { head: HEAD, slugs, now: NOW });
		expect(result.code).toBe(EXIT_WAITING);
		expect(renderBotReview(result)).toContain("bots=coderabbitai");
	});

	test("an explicit list wins over the environment, and is normalised", () => {
		expect(configuredSlugs("CodeRabbitAI , greptile-apps ,", { PR_REVIEW_BOTS: "ignored" })).toEqual([
			"coderabbitai",
			"greptile-apps",
		]);
	});

	test("an explicit empty list configures no bots at all", () => {
		// PARITY: `--bots ''` meant zero bots, so every PR read `absent`. Only an absent
		// value falls back to the environment.
		expect(configuredSlugs("", { PR_REVIEW_BOTS: "coderabbitai" })).toEqual([]);
	});

	test("the adapter roster names how each slug's actionability is read", () => {
		// The script's `bots` subcommand, which is now one line of the tool's text.
		expect(adapterNote("coderabbitai")).toContain("Actionable comments posted");
		expect(adapterNote("greptile-apps")).toContain("no adapter");
		expect(adapterNote("coderabbit")).toBe(adapterNote("coderabbitai"));
	});
});

describe("wait arithmetic", () => {
	test("reads minutes and hours from any wording", () => {
		expect(waitMinutes("available in 48 minutes")).toBe(48);
		expect(waitMinutes("**30** minutes")).toBe(30);
		expect(waitMinutes("try again in 2 hours")).toBe(120);
		expect(waitMinutes("1 hour")).toBe(60);
		expect(waitMinutes("no figure at all")).toBeNull();
	});

	test("a naive timestamp is read as UTC, not as local time", () => {
		// `new Date("2026-07-30T11:00:00")` is LOCAL time; the quota window would then move
		// with the machine's zone.
		expect(reopenInstant("2026-07-30T11:00:00", 60)?.toISOString()).toBe("2026-07-30T12:00:00.000Z");
		expect(reopenInstant("2026-07-30T11:00:00Z", 60)?.toISOString()).toBe("2026-07-30T12:00:00.000Z");
		expect(reopenInstant("2026-07-30T13:00:00+02:00", 60)?.toISOString()).toBe("2026-07-30T12:00:00.000Z");
	});

	test("an unplaceable timestamp has no reopen instant", () => {
		for (const at of ["", "x", "later", "2026-02-30T11:00:00Z", "2026-13-01T00:00:00Z", "2026-07-30"]) {
			expect(reopenInstant(at, 30)).toBeNull();
		}
	});

	test("an absurd figure is clamped to a week rather than overflowing", () => {
		// The figure is the bot's own prose, so it is data this tool does not control.
		const reopen = reopenInstant(POSTED, 999_999_999_999);
		expect(reopen?.toISOString()).toBe("2026-08-06T11:00:00.000Z");
		expect(reopenInstant(POSTED, -5)?.toISOString()).toBe("2026-07-30T11:00:00.000Z");
	});

	test("an absurd actionable count stays a real integer, and still bounces", () => {
		// Same class as the clamp above, on the other figure the bot writes in prose.
		// `parseInt` on enough digits returns Infinity, which rendered as
		// `actionable=Infinity` and JSON-serialised to `null` -- a `number`-typed field
		// reaching the caller as null. The verdict must not soften either: reading an
		// unrepresentable count as "no verdict yet" would wait forever on a round that
		// already answered.
		const data = payload({
			checks: [{ name: "CodeRabbit", status: "COMPLETED" }],
			reviews: [review({ body: `Actionable comments posted: ${"9".repeat(400)}` })],
		});
		const result = classify(data);

		expect(result.verdict).toBe("actionable");
		expect(result.code).toBe(EXIT_ACTIONABLE);
		expect(Number.isSafeInteger(result.findings.actionable)).toBe(true);
		expect(result.findings.actionable).toBeGreaterThan(0);
		// What the tool actually hands back: the details payload round-trips as a number.
		expect(JSON.parse(JSON.stringify({ actionable: result.findings.actionable }))).toEqual({
			actionable: Number.MAX_SAFE_INTEGER,
		});
		expect(renderBotReview(result)).not.toContain("Infinity");
	});
});

/** Answer `gh` from a transcript keyed by joined argv, and record every call. */
function transcript(answers: Record<string, ExecResult | null>): { exec: Exec; calls: string[][] } {
	const calls: string[][] = [];
	const exec: Exec = async (argv) => {
		calls.push(argv);
		const key = argv.join(" ");
		if (key in answers) return answers[key] ?? null;
		return { code: 1, stdout: "", stderr: `unexpected argv: ${key}` };
	};
	return { exec, calls };
}

function ok(value: unknown): ExecResult {
	return { code: 0, stdout: JSON.stringify(value), stderr: "" };
}

const REPO = "acme/widgets";
const PR = "7";
const VIEW = prViewArgv(REPO, PR).join(" ");
const REVIEWS = ghApiArgv(`repos/${REPO}/pulls/${PR}/reviews`).join(" ");
const REVIEW_COMMENTS = ghApiArgv(`repos/${REPO}/pulls/${PR}/comments`).join(" ");
const ISSUE_COMMENTS = ghApiArgv(`repos/${REPO}/issues/${PR}/comments`).join(" ");

/** A transcript where every read answers, with the reviews page the caller supplies. */
function reads(over: Record<string, ExecResult | null> = {}): Record<string, ExecResult | null> {
	return {
		[VIEW]: ok({ headRefOid: HEAD, statusCheckRollup: [{ name: "CodeRabbit", status: "COMPLETED" }] }),
		[REVIEWS]: ok([[]]),
		[REVIEW_COMMENTS]: ok([[]]),
		[ISSUE_COMMENTS]: ok([[]]),
		...over,
	};
}

describe("argument vectors", () => {
	test("the head and the rollup come from one `gh pr view`", () => {
		expect(prViewArgv(REPO, PR)).toEqual([
			"gh",
			"pr",
			"view",
			"7",
			"--repo",
			"acme/widgets",
			"--json",
			"headRefOid,statusCheckRollup",
		]);
	});

	test("every REST read is slurped and paginated", () => {
		expect(ghApiArgv("repos/acme/widgets/pulls/7/reviews")).toEqual([
			"gh",
			"api",
			"--paginate",
			"--slurp",
			"repos/acme/widgets/pulls/7/reviews",
		]);
	});

	test("the per-read bound defaults to five seconds and honours the override", () => {
		expect(ghTimeoutMs({})).toBe(5_000);
		expect(ghTimeoutMs({ PR_SHEPHERD_GH_TIMEOUT: "30" })).toBe(30_000);
		// PARITY: the script's `int(...)` raised at import on junk; a tool falls back instead.
		expect(ghTimeoutMs({ PR_SHEPHERD_GH_TIMEOUT: "soon" })).toBe(5_000);
		expect(ghTimeoutMs({ PR_SHEPHERD_GH_TIMEOUT: "0" })).toBe(5_000);
	});
});

describe("fetch", () => {
	test("slurps and flattens all REST pages", async () => {
		const { exec, calls } = transcript(
			reads({ [REVIEWS]: ok([[{ user: { login: CODERABBIT } }], []]) }),
		);
		const result = await fetchBotReviewEvidence(REPO, PR, { exec });

		expect(result.ok).toBe(true);
		const paginated = calls.filter((argv) => argv[1] === "api");
		expect(paginated).toHaveLength(3);
		expect(paginated.every((argv) => argv.includes("--paginate") && argv.includes("--slurp"))).toBe(true);
		if (!result.ok) return;
		expect(result.payload.reviews).toHaveLength(1);
		expect(result.payload.head).toBe(HEAD);
	});

	test("maps the REST fields the classifier reads", async () => {
		const { exec } = transcript(
			reads({
				[REVIEWS]: ok([
					[
						{
							user: { login: CODERABBIT },
							state: "COMMENTED",
							body: "Actionable comments posted: 2",
							commit_id: HEAD,
							html_url: "https://r/1",
							submitted_at: "2026-07-30T11:50:00Z",
						},
					],
				]),
				[REVIEW_COMMENTS]: ok([
					[{ user: { login: CODERABBIT }, path: "src/a.ts", original_line: 9, commit_id: HEAD, html_url: "https://c/1" }],
				]),
				[ISSUE_COMMENTS]: ok([[{ user: { login: CODERABBIT }, body: LIMIT_BODY, created_at: POSTED }]]),
			}),
		);
		const fetched = await fetchBotReviewEvidence(REPO, PR, { exec });
		expect(fetched.ok).toBe(true);
		if (!fetched.ok) return;

		expect(fetched.payload.reviews[0]).toEqual({
			login: CODERABBIT,
			state: "COMMENTED",
			body: "Actionable comments posted: 2",
			commit: HEAD,
			url: "https://r/1",
			at: "2026-07-30T11:50:00Z",
		});
		// `line` is absent on an outdated comment, so `original_line` carries the position.
		expect(fetched.payload.comments[0]?.line).toBe(9);
		expect(fetched.payload.notices[0]?.at).toBe(POSTED);

		const result = classifyBotReviews(fetched.payload, {
			head: fetched.payload.head,
			slugs: configuredSlugs("coderabbitai", {}),
			now: NOW,
		});
		expect(result.verdict).toBe("actionable");
		expect(result.findings.files).toEqual(["src/a.ts:9 https://c/1"]);
	});

	test("a head-less view is refused, never read as an absent review", async () => {
		for (const answer of [ok({}), ok(null), ok({ headRefOid: "" })]) {
			const { exec } = transcript(reads({ [VIEW]: answer }));
			const result = await fetchBotReviewEvidence(REPO, PR, { exec });
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.error).toContain("returned no headRefOid");
		}
	});

	test("silence from a read is not an answer", async () => {
		const { exec } = transcript(reads({ [VIEW]: { code: 0, stdout: "  \n", stderr: "" } }));
		const result = await fetchBotReviewEvidence(REPO, PR, { exec });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain("refusing to read silence as an answer");
	});

	test("a failing read reports gh's own words", async () => {
		const { exec } = transcript(reads({ [REVIEWS]: { code: 1, stdout: "", stderr: "gh: not authenticated\n" } }));
		const result = await fetchBotReviewEvidence(REPO, PR, { exec });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toBe(`gh api --paginate --slurp repos/${REPO}/pulls/${PR}/reviews failed: gh: not authenticated`);
	});

	test("a read that never answers is refused", async () => {
		const { exec } = transcript(reads({ [ISSUE_COMMENTS]: null }));
		const result = await fetchBotReviewEvidence(REPO, PR, { exec, timeoutMs: 5_000 });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain("did not answer");
		expect(result.error).toContain("5s");
	});

	test("a paginated response that is not pages of rows is refused", async () => {
		const cases: [ExecResult, string][] = [
			[ok({ not: "pages" }), "must be an array of pages"],
			[ok(["not a page"]), "contains a malformed page"],
			[ok([[1, 2]]), "contains a malformed page"],
		];
		for (const [answer, expected] of cases) {
			const { exec } = transcript(reads({ [REVIEWS]: answer }));
			const result = await fetchBotReviewEvidence(REPO, PR, { exec });
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.error).toContain(expected);
		}
	});

	test("unreadable JSON is refused", async () => {
		const { exec } = transcript(reads({ [VIEW]: { code: 0, stdout: "notjson", stderr: "" } }));
		const result = await fetchBotReviewEvidence(REPO, PR, { exec });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain("unreadable JSON");
	});

	test("a non-array rollup is passed through for the classifier to refuse", async () => {
		// Quietly emptying it would classify as `absent`, exit 0 — the bot gate cleared by a
		// read nobody could interpret.
		const { exec } = transcript(reads({ [VIEW]: ok({ headRefOid: HEAD, statusCheckRollup: { name: "x" } }) }));
		const fetched = await fetchBotReviewEvidence(REPO, PR, { exec });
		expect(fetched.ok).toBe(true);
		if (!fetched.ok) return;
		const result = classifyBotReviews(fetched.payload, {
			head: fetched.payload.head,
			slugs: configuredSlugs("coderabbitai", {}),
			now: NOW,
		});
		expect(result.code).toBe(EXIT_UNKNOWN);
		expect(result.verdict).toBe("unknown");
	});

	test("a missing rollup is an empty check list", async () => {
		const { exec } = transcript(reads({ [VIEW]: ok({ headRefOid: HEAD }) }));
		const fetched = await fetchBotReviewEvidence(REPO, PR, { exec });
		expect(fetched.ok).toBe(true);
		if (!fetched.ok) return;
		expect(fetched.payload.checks).toEqual([]);
	});
});

describe("parsePrRef", () => {
	test("reads a github pull URL", () => {
		expect(parsePrRef("https://github.com/acme/widgets/pull/42")).toEqual({ repo: REPO, number: "42" });
		expect(parsePrRef("github.com/acme/widgets/pull/42")).toEqual({ repo: REPO, number: "42" });
		expect(parsePrRef("https://github.com/acme/widgets/pull/42/files")).toEqual({ repo: REPO, number: "42" });
	});

	test("reads a qualified reference in either separator", () => {
		expect(parsePrRef("acme/widgets#42")).toEqual({ repo: REPO, number: "42" });
		expect(parsePrRef("acme/widgets/42")).toEqual({ repo: REPO, number: "42" });
	});

	test("accepts a bare number only alongside a repo", () => {
		expect(parsePrRef("42", REPO)).toEqual({ repo: REPO, number: "42" });
		expect(parsePrRef("#42", REPO)).toEqual({ repo: REPO, number: "42" });
		// Refusing to guess the repository is the point: `gh pr view` is always called with
		// an explicit --repo, so a guess would report another PR's verdict as this one's.
		expect(parsePrRef("42")).toBeNull();
		expect(parsePrRef("42", "   ")).toBeNull();
	});

	test("trims surrounding whitespace", () => {
		expect(parsePrRef("  acme/widgets#42  ")).toEqual({ repo: REPO, number: "42" });
		expect(parsePrRef(" 42 ", " acme/widgets ")).toEqual({ repo: REPO, number: "42" });
	});

	test("rejects a reference with no number", () => {
		expect(parsePrRef("acme/widgets")).toBeNull();
		expect(parsePrRef("")).toBeNull();
		expect(parsePrRef("not a ref", REPO)).toBeNull();
		expect(parsePrRef("https://github.com/acme/widgets/pull/abc")).toBeNull();
	});
});

interface RegisteredTool {
	name: string;
	approval?: string;
	execute: (
		id: string,
		params: { pr: string; repo?: string; bots?: string; cwd?: string },
		signal: undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	) => Promise<AgentToolResult<BotReviewDetails>>;
}

/** Collect what `registerBotReviewProbe` registers, without an OMP session. */
function registered(exec?: Exec): RegisteredTool {
	const tools: unknown[] = [];
	const pi = { zod, registerTool: (tool: unknown) => tools.push(tool) } as unknown as ExtensionAPI;
	if (exec) registerBotReviewProbe(pi, exec);
	else registerBotReviewProbe(pi);
	expect(tools).toHaveLength(1);
	return tools[0] as RegisteredTool;
}

const CTX = { cwd: "/tmp" } as unknown as ExtensionContext;

function textOf(result: AgentToolResult<BotReviewDetails>): string {
	const block = result.content[0];
	return block && block.type === "text" ? block.text : "";
}

describe("registerBotReviewProbe", () => {
	test("registers exactly one read-only tool, and only when called", () => {
		// Importing the module must not register anything: `src/index.ts` owns wiring.
		const tool = registered();
		expect(tool.name).toBe("orc_bot_review_probe");
		expect(tool.approval).toBe("read");
	});

	test("refuses to guess a repository, as a result rather than a throw", async () => {
		const tool = registered(transcript({}).exec);
		const result = await tool.execute("id", { pr: "42" }, undefined, undefined, CTX);
		expect(result.isError).toBe(true);
		expect(result.details?.code).toBe(EXIT_UNKNOWN);
		expect(result.details?.verdict).toBe("unknown");
		expect(result.details?.error).toBe("unreadable pr reference");
	});

	test("chains the reads into the classification", async () => {
		const { exec, calls } = transcript(
			reads({
				[REVIEWS]: ok([
					[
						{
							user: { login: CODERABBIT },
							state: "COMMENTED",
							body: "Actionable comments posted: 2",
							commit_id: HEAD,
							html_url: "https://r/1",
							submitted_at: "2026-07-30T11:50:00Z",
						},
					],
				]),
			}),
		);
		const tool = registered(exec);
		const result = await tool.execute("id", { pr: `https://github.com/${REPO}/pull/${PR}` }, undefined, undefined, CTX);

		expect(result.isError).toBeFalsy();
		expect(result.details).toMatchObject({ code: EXIT_ACTIONABLE, verdict: "actionable", head: HEAD, actionable: 2 });
		const text = textOf(result);
		expect(text).toContain(`verdict: actionable (exit ${EXIT_ACTIONABLE}) at head ${HEAD}`);
		expect(text).toContain("BOT_REVIEW actionable");
		expect(text).toContain('adapters: coderabbitai=CodeRabbit summary line "Actionable comments posted: N"');
		expect(text).toContain("never to be treated as clean");
		expect(calls.map((argv) => argv.join(" "))).toEqual([VIEW, REVIEWS, REVIEW_COMMENTS, ISSUE_COMMENTS]);
	});

	test("classifies against the head the reads returned, so an older round stays stale", async () => {
		const { exec } = transcript(
			reads({
				[REVIEWS]: ok([
					[
						{
							user: { login: CODERABBIT },
							body: "Actionable comments posted: 0",
							commit_id: OLD_HEAD,
							submitted_at: "2026-07-30T11:50:00Z",
						},
					],
				]),
			}),
		);
		const tool = registered(exec);
		const result = await tool.execute("id", { pr: `${REPO}#${PR}` }, undefined, undefined, CTX);
		expect(result.details).toMatchObject({ code: EXIT_STALE, verdict: "stale", head: HEAD });
		expect(result.isError).toBeFalsy();
	});

	test("a declined round is an answer, not an error result", async () => {
		const { exec } = transcript(
			reads({ [ISSUE_COMMENTS]: ok([[{ user: { login: CODERABBIT }, body: LIMIT_BODY, created_at: POSTED }]]) }),
		);
		const tool = registered(exec);
		const result = await tool.execute("id", { pr: PR, repo: REPO }, undefined, undefined, CTX);
		expect(result.details).toMatchObject({ code: EXIT_DECLINED, verdict: "declined" });
		expect(result.isError).toBeFalsy();
		expect(result.details?.wait).toContain("2026-07-30T11:48:00");
	});

	test("a failed read is unknown and flagged, never clean", async () => {
		const { exec } = transcript({ [VIEW]: { code: 1, stdout: "", stderr: "no such PR" } });
		const tool = registered(exec);
		const result = await tool.execute("id", { pr: PR, repo: REPO }, undefined, undefined, CTX);
		expect(result.isError).toBe(true);
		expect(result.details?.code).toBe(EXIT_UNKNOWN);
		expect(result.details?.verdict).toBe("unknown");
		expect(textOf(result)).toContain("no such PR");
	});

	test("an empty bots argument falls back rather than configuring no bots", async () => {
		// The wrapper only passed `--bots` when it was non-empty; a model sending `bots: ""`
		// must not silently turn every PR into `absent`.
		const { exec } = transcript(reads());
		const tool = registered(exec);
		const result = await tool.execute("id", { pr: PR, repo: REPO, bots: "" }, undefined, undefined, CTX);
		expect(textOf(result)).toContain("bots=coderabbitai");
	});

	test("an unrunnable gh is unknown, not an absent bot", async () => {
		const tool = registered(async () => null);
		const result = await tool.execute("id", { pr: PR, repo: REPO }, undefined, undefined, CTX);
		expect(result.isError).toBe(true);
		expect(result.details?.code).toBe(EXIT_UNKNOWN);
		expect(textOf(result)).not.toContain("BOT_REVIEW");
	});
});
