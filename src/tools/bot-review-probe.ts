/**
 * `orc_bot_review_probe` — classify a PR's review-bot round at one exact head SHA.
 *
 * A native port of `skills/orchestrate/scripts/bot-review-probe.py`, keeping the split
 * that made the script testable: {@link fetchBotReviewEvidence} performs the four `gh`
 * reads through an injectable seam, and {@link classifyBotReviews} is pure, so every
 * classification path is reachable without a network.
 *
 * Review bots (CodeRabbit, Copilot review, Greptile, ...) post findings outside every
 * status check the merge decision already reads, and each signals actionability its own
 * way. That per-bot knowledge stays in one adapter table, so adding a bot is a table
 * entry rather than a parser change.
 *
 * The vocabulary is the landing contract's, verbatim from the script's docstring:
 *   0  absent      no configured bot on this PR; merge decision unchanged
 *   0  clean       the bot's latest round at this head reports nothing actionable
 *   10 pending     check still running, or no review at this head yet
 *   11 stale       the bot reviewed an older head only
 *   12 actionable
 *   13 declined    the bot refused the round (quota/rate limit); re-trigger, do not wait
 *   2  unknown     malformed or unreadable evidence -- never treated as clean
 *
 * Nothing here throws. The script raised `ValueError`/`RuntimeError` and let `main` map
 * the raise onto exit 2; this port returns that code directly, so a caller cannot forget
 * the `try` that turns unreadable evidence into a refusal. An unanswered probe must never
 * read as a satisfied one.
 */

import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

export const EXIT_UNKNOWN = 2;
export const EXIT_WAITING = 10;
export const EXIT_STALE = 11;
export const EXIT_ACTIONABLE = 12;
export const EXIT_DECLINED = 13;

export const DEFAULT_BOTS = "coderabbitai";
/**
 * A bot slug is matched against check names and details URLs by alphanumeric containment
 * in either direction ("CodeRabbit" vs "coderabbitai"). The floor keeps a short slug from
 * matching unrelated checks.
 */
export const MIN_SLUG_MATCH = 4;

// A decline notice is matched LOOSELY ON PURPOSE, in two independent halves: an indicator
// that the bot refused, and -- separately -- any duration figure anywhere in the body. A
// downstream script once matched the bot's exact sentence ("next review available in: N
// minutes"); the bot reworded it to "your next included review will be available in N
// minutes", the match returned empty, the caller read that as "no limit notice" and
// reported the quota window as reopened while it was exhausted, burning four re-triggers.
// Tightening either half into one sentence pattern reintroduces that bug: word order,
// "included", "will be", bold markers, and minutes-vs-hours all vary.
//
// None of these patterns carries `g`: a global regexp keeps `lastIndex` between calls, so
// the same body would match or not depending on what was tested before it.
const DECLINE_INDICATORS =
	/limit\s+(?:is\s+)?(?:currently\s+)?reached|fair\s+usage|rate[-\s]?limit|quota|usage\s+limit|review\s+skipped/i;
const WAIT_FIGURE = /(\d+)\s*\**\s*(minute|hour)s?/i;

/** True when this body is the bot saying it refused the round. */
export function indicatesDecline(body: string): boolean {
	return DECLINE_INDICATORS.test(body ?? "");
}

/** Per-bot knowledge: how this bot says "here is what you must fix". */
interface Adapter {
	slug: string;
	/** The actionable-finding count for a review body, or `null` when it carries no verdict this adapter recognises. */
	count: (body: string) => number | null;
	note: string;
	/**
	 * True when this body is the bot refusing the round. Defaults to the cross-bot
	 * indicator set; override only to ADD wording, never to narrow it to one sentence.
	 */
	declined: (body: string) => boolean;
}

// CodeRabbit posts one summary review per round whose body carries "Actionable comments
// posted: N". Every fix suggestion hangs under that summary, so N is the actionability
// signal and a long nitpick-only body with N=0 merges.
const ADAPTERS: Record<string, Adapter> = {
	coderabbitai: {
		slug: "coderabbitai",
		count: (body) => {
			const digits = /actionable comments posted:\s*(?<n>\d+)/i.exec(body ?? "")?.groups?.n;
			if (digits === undefined) return null;
			const parsed = Number.parseInt(digits, 10);
			// CLAMP, for the reason `reopenInstant` clamps: the figure is the bot's own prose,
			// so it is data this tool does not control. `parseInt` on enough digits returns
			// Infinity, which rendered as `actionable=Infinity` and JSON-serialised to `null`
			// -- a field typed `number` reaching the caller as null. Returning `null` instead
			// would be worse than either: it reads as "no verdict at head yet" and waits
			// forever on a round that already answered. Any figure past a real round means
			// the same thing operationally, and every value here is only ever tested `> 0`.
			return Number.isSafeInteger(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
		},
		note: 'CodeRabbit summary line "Actionable comments posted: N"',
		declined: indicatesDecline,
	},
};

// A bot with no adapter still gets classified: its check and review presence are visible,
// and a CHANGES_REQUESTED verdict is actionable everywhere. Only the count is unavailable,
// which reads as "no recognised verdict yet".
const GENERIC_NOTE = "no adapter: review state only";

function adapterFor(slug: string): Adapter {
	// `Object.hasOwn`, not a plain index: the slug is caller data (`--bots`,
	// `$PR_REVIEW_BOTS`), and a slug naming an `Object.prototype` member -- "constructor",
	// "toString" -- resolved through the prototype chain to a truthy non-Adapter, whose
	// missing `.declined`/`.count` threw a TypeError out of a function documented never to
	// throw.
	const exact = Object.hasOwn(ADAPTERS, slug) ? ADAPTERS[slug] : undefined;
	if (exact) return exact;
	for (const known of Object.keys(ADAPTERS)) {
		// PARITY: a variant slug ("coderabbit") reuses the table entry unchanged, so the
		// adapter keeps the canonical slug rather than the configured spelling.
		if (related(normalize(slug), normalize(known))) return ADAPTERS[known] as Adapter;
	}
	return { slug, count: () => null, note: GENERIC_NOTE, declined: indicatesDecline };
}

/** How this slug's actionability is read — the script's `bots` subcommand, one slug at a time. */
export function adapterNote(slug: string): string {
	return adapterFor(slug).note;
}

/** Python's truthiness for a decoded JSON value: `null`, `false`, `0`, `""`, `[]`, `{}`. */
function truthy(value: unknown): boolean {
	if (value === undefined || value === null || value === false || value === "") return false;
	if (typeof value === "number") return value !== 0;
	if (Array.isArray(value)) return value.length > 0;
	if (typeof value === "object") return Object.keys(value).length > 0;
	return true;
}

/**
 * `str(value or "")` on a decoded JSON value.
 *
 * PARITY: Python's `str()` spells booleans "True"/"False" and lists with repr quoting.
 * Only malformed evidence reaches those branches, and every consumer of this is a
 * containment or equality test that fails on either spelling.
 */
function str(value: unknown): string {
	if (!truthy(value)) return "";
	if (typeof value === "string") return value;
	return typeof value === "object" ? JSON.stringify(value) : String(value);
}

/** A JSON object, which is what Python's `isinstance(x, dict)` accepts — arrays excluded. */
function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `(row.get(outer) or {}).get(inner) or ""`. */
function nested(row: Record<string, unknown>, outer: string, inner: string): string {
	const value = row[outer];
	return isObject(value) ? str(value[inner]) : "";
}

/** Python's `<` on two strings, for `sort(key=...)` and `max(...)` parity. */
function compare(left: string, right: string): number {
	if (left < right) return -1;
	return left > right ? 1 : 0;
}

function normalize(value: string): string {
	return (value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function related(left: string, right: string): boolean {
	if (left.length < MIN_SLUG_MATCH || right.length < MIN_SLUG_MATCH) return false;
	return left.includes(right) || right.includes(left);
}

/**
 * The bot slugs to probe for: the caller's list, else `$PR_REVIEW_BOTS`, else the default.
 *
 * PARITY: only an *absent* value falls back. An explicit empty string configures zero
 * bots, exactly as `--bots ''` did, and every PR then reads `absent`.
 */
export function configuredSlugs(raw?: string, env: Record<string, string | undefined> = process.env): string[] {
	const source = raw ?? env.PR_REVIEW_BOTS ?? DEFAULT_BOTS;
	const slugs: string[] = [];
	for (const part of source.split(",")) {
		const slug = part.trim();
		if (slug !== "") slugs.push(slug.toLowerCase());
	}
	return slugs;
}

function isBotCheck(check: Record<string, unknown>, slugs: string[]): boolean {
	const name = normalize(str(check.name));
	const url = normalize(str(check.detailsUrl));
	return slugs.some((slug) => related(name, normalize(slug)) || related(url, normalize(slug)));
}

/** The configured slug this review author is, or `null`. */
function loginSlug(login: string, slugs: string[]): string | null {
	const actual = (login ?? "").toLowerCase();
	for (const slug of slugs) {
		if (actual === slug || actual === `${slug}[bot]`) return slug;
	}
	return null;
}

// The Checks API reports `status: completed`; the older commit-status API reports
// `state: SUCCESS|FAILURE|PENDING|ERROR` and has no `status` at all. Only "completed"
// counted as finished, so a status-API bot reporting SUCCESS read as "still running" and
// the probe returned EXIT_WAITING forever -- a bot that had already answered kept the
// merge waiting indefinitely.
const STATUS_API_TERMINAL: Record<string, true> = { success: true, failure: true, error: true };

/**
 * The check's state, normalized to the Checks API vocabulary.
 *
 * A commit-status `state` is mapped onto `completed` when it is terminal, so the one
 * caller comparing against "completed" treats both APIs alike. `pending` stays itself,
 * because it means the same thing in both.
 */
function checkState(check: Record<string, unknown>): string {
	const status = str(check.status).toLowerCase();
	if (status !== "") return status;
	const state = str(check.state).toLowerCase();
	// `=== true`, for the same prototype-chain reason as `adapterFor`: a check whose state
	// is the literal "constructor" read as `completed`, grading a round the bot had not
	// answered yet.
	return STATUS_API_TERMINAL[state] === true ? "completed" : state;
}

/** Minutes until the bot says it will review again, from any wording. */
export function waitMinutes(body: string): number | null {
	const match = WAIT_FIGURE.exec(body ?? "");
	if (!match) return null;
	const value = Number.parseInt(match[1] as string, 10);
	return (match[2] as string).toLowerCase() === "hour" ? value * 60 : value;
}

// `datetime.fromisoformat`, hand-rolled. `new Date("2026-07-30T11:00:00")` reads a
// timestamp with no offset as LOCAL time, so the quota window would move with the
// machine's zone; Python read it as naive and stamped it UTC.
const ISO_INSTANT =
	/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?(?:(Z|z)|([+-])(\d{2}):?(\d{2}))?$/;

function parseInstant(at: string): Date | null {
	const match = ISO_INSTANT.exec(at ?? "");
	if (!match) return null;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const hour = Number(match[4]);
	const minute = Number(match[5]);
	const second = match[6] === undefined ? 0 : Number(match[6]);
	const fraction = match[7] === undefined ? 0 : Math.floor(Number(`0.${match[7]}`) * 1000);
	if (month < 1 || month > 12 || day < 1 || day > 31) return null;
	if (hour > 23 || minute > 59 || second > 59) return null;

	const stamp = Date.UTC(year, month - 1, day, hour, minute, second, fraction);
	const probe = new Date(stamp);
	// Date.UTC rolls February 30th into March; `fromisoformat` refused it, and a refusal
	// is the honest answer for a timestamp nothing can place.
	if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
		return null;
	}
	if (match[9] === undefined) return probe;

	const offsetHours = Number(match[10]);
	const offsetMinutes = Number(match[11]);
	if (offsetHours > 23 || offsetMinutes > 59) return null;
	const offset = (offsetHours * 60 + offsetMinutes) * 60_000;
	return new Date(match[9] === "-" ? stamp + offset : stamp - offset);
}

/** `datetime.isoformat()` for a UTC instant: a `+00:00` offset, microseconds only when non-zero. */
function isoUtc(at: Date): string {
	const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
	const ms = at.getUTCMilliseconds();
	const fraction = ms === 0 ? "" : `.${pad(ms, 3)}000`;
	return (
		`${pad(at.getUTCFullYear(), 4)}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}` +
		`T${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}:${pad(at.getUTCSeconds())}${fraction}+00:00`
	);
}

/**
 * Absolute reopen time, or `null` when the notice has no usable timestamp.
 *
 * The bot's figure is relative to when it POSTED the notice, so it decays; a stored figure
 * alone cannot say whether the window is open.
 */
export function reopenInstant(at: string, minutes: number): Date | null {
	const posted = parseInstant(at);
	if (posted === null) return null;
	// CLAMP: the figure comes from the bot's own prose, so it is data this tool does not
	// control. Python's `timedelta` raised OverflowError past its range and `main` caught
	// only ValueError, so "retry in 999999999999999999999999 minutes" exited 1 with a
	// traceback instead of the documented exit 2. A week is far past any real backoff, and
	// anything beyond it means the same thing operationally.
	const bounded = Math.max(0, Math.min(minutes, 7 * 24 * 60));
	return new Date(posted.getTime() + bounded * 60_000);
}

/** The word the landing contract uses for this round. */
export type BotReviewState = "absent" | "clean" | "pending" | "stale" | "actionable" | "declined" | "unknown";

/** Everything the probe read, in the shape {@link renderBotReview} prints. */
export interface BotReviewFindings {
	head: string;
	/** The configured slugs, comma-joined. */
	bots: string;
	/** `name/state` per matched bot check, comma-joined, or `"none"`. */
	check: string;
	actionable: number;
	changesRequested: number;
	/** URL of the review round that decided this verdict, or `"none"`. */
	summary: string;
	/** When the bot says it will review again: an instant, `"UNKNOWN"`, `"<n>m"`, or `"none"`. */
	wait: string;
	detail: string;
	/** `path:line url` per bot comment at this head, sorted. */
	files: string[];
}

export interface BotReviewVerdict {
	code: number;
	verdict: BotReviewState;
	findings: BotReviewFindings;
}

export interface ClassifyOptions {
	/**
	 * The exact head SHA a round must match. A blank one is refused as unread evidence:
	 * it is the frame of reference every comparison below needs.
	 */
	head: string;
	slugs: string[];
	/** Injected so decline-window arithmetic stays deterministic in tests. */
	now?: Date;
}

interface Decline {
	wait: string;
	detail: string;
}

/** `null` = no refusal notice; `"malformed"` = a notice that is not an object. */
type DeclineOutcome = Decline | null | "malformed";

/**
 * The bot's newest refusal notice, or `null`.
 *
 * Advisory only: the caller must consult this AFTER evidence of a real review, because a
 * refusal notice stays in the comment history forever and would otherwise mask the genuine
 * review that landed after it.
 */
function declines(notices: unknown[], slugs: string[], now: Date): DeclineOutcome {
	const found: [string, string][] = [];
	for (const notice of notices) {
		if (!isObject(notice)) return "malformed";
		const slug = loginSlug(str(notice.login), slugs);
		const body = str(notice.body);
		if (slug === null || !adapterFor(slug).declined(body)) continue;
		found.push([str(notice.at), body]);
	}
	const newest = found[0];
	if (newest === undefined) return null;
	// PARITY: `max()` on `(at, body)` tuples breaks a timestamp tie on the body, and keeps
	// the first of two identical pairs.
	let best = newest;
	for (const candidate of found) {
		const byTime = compare(candidate[0], best[0]);
		if (byTime > 0 || (byTime === 0 && compare(candidate[1], best[1]) > 0)) best = candidate;
	}

	const [at, body] = best;
	const minutes = waitMinutes(body);
	if (minutes === null) {
		return { wait: "UNKNOWN", detail: "bot declined the round; re-check before re-trigger" };
	}
	const reopen = reopenInstant(at, minutes);
	if (reopen === null) {
		return {
			wait: `${minutes}m`,
			detail: `bot declined the round for ${minutes}m from an unreadable timestamp; re-check before re-trigger`,
		};
	}
	const stamp = isoUtc(reopen);
	if (reopen.getTime() <= now.getTime()) {
		return { wait: stamp, detail: `bot declined the round; window reopened at ${stamp}, re-trigger` };
	}
	return { wait: stamp, detail: `bot declined the round; retry after ${stamp}` };
}

/** `payload.get(key) or []`, or `null` when the value is truthy but not an array. */
function arrayField(value: unknown): unknown[] | null {
	if (!truthy(value)) return [];
	return Array.isArray(value) ? value : null;
}

function verdictOf(
	findings: BotReviewFindings,
	verdict: BotReviewState,
	code: number,
	detail: string,
): BotReviewVerdict {
	return { code, verdict, findings: { ...findings, detail } };
}

/**
 * Pure classification of one fetched payload against one head SHA.
 *
 * PARITY: the script raised `ValueError` on evidence it could not read and `main` printed
 * it and returned exit 2. Here that path returns exit 2 with `verdict: "unknown"` — the
 * same observable answer, minus the chance of an uncaught raise reading as a crash rather
 * than as unread evidence.
 */
export function classifyBotReviews(payload: unknown, opts: ClassifyOptions): BotReviewVerdict {
	const { slugs, head } = opts;
	const now = opts.now ?? new Date();
	const findings: BotReviewFindings = {
		head,
		bots: slugs.join(","),
		check: "none",
		actionable: 0,
		changesRequested: 0,
		summary: "none",
		wait: "none",
		detail: "",
		files: [],
	};
	const unknown = (detail: string): BotReviewVerdict => verdictOf(findings, "unknown", EXIT_UNKNOWN, detail);

	// A blank head is unread evidence, not a PR with nothing on it.
	// {@link fetchBotReviewEvidence} already refuses a head-less `gh pr view`, but the
	// comparison lives HERE, and with head="" a review carrying no `commit_id` compared
	// equal to it and returned `clean`, exit 0 -- an approval synthesised out of a round
	// that named no commit at all. Every other verdict at a blank head is equally
	// unfounded, so this refuses before reading the payload rather than per-branch.
	if ((head ?? "").trim() === "") return unknown("no head SHA to classify a round against");

	if (!isObject(payload)) return unknown("payload must be a JSON object");
	const checks = arrayField(payload.checks);
	const reviews = arrayField(payload.reviews);
	const comments = arrayField(payload.comments);
	const notices = arrayField(payload.notices);
	if (checks === null || reviews === null || comments === null || notices === null) {
		return unknown("checks, reviews, comments, and notices must be arrays");
	}

	const botChecks: Record<string, unknown>[] = [];
	for (const check of checks) {
		if (isObject(check) && isBotCheck(check, slugs)) botChecks.push(check);
	}

	const botReviews: [string, Record<string, unknown>][] = [];
	const refusals: unknown[] = [...notices];
	for (const review of reviews) {
		if (!isObject(review)) return unknown("each review must be an object");
		const slug = loginSlug(str(review.login), slugs);
		if (slug === null) continue;
		// A refusal is not a review round. Left in `botReviews` it would read as
		// `pending`/`stale` -- "keep waiting" -- exactly the ambiguity that cost the
		// wasted re-triggers.
		if (adapterFor(slug).declined(str(review.body))) refusals.push(review);
		else botReviews.push([slug, review]);
	}

	findings.check =
		botChecks.map((check) => `${str(check.name) || "?"}/${checkState(check) || "?"}`).join(",") || "none";

	const decline = declines(refusals, slugs, now);
	if (decline === "malformed") return unknown("each notice must be an object");

	if (botChecks.length === 0 && botReviews.length === 0 && decline === null) {
		return verdictOf(findings, "absent", 0, "no configured review bot on this PR");
	}

	// A PR check rollup always describes the current head, so a running bot check needs no
	// head comparison of its own.
	if (botChecks.some((check) => checkState(check) !== "completed")) {
		return verdictOf(findings, "pending", EXIT_WAITING, "bot check still running");
	}

	const atHead = botReviews.filter(([, review]) => str(review.commit) === head);
	atHead.sort((left, right) => compare(str(left[1].at), str(right[1].at)));

	// A REAL REVIEW ALWAYS BEATS A NOTICE. The decline notice is only consulted where there
	// is no review to read at all: with a review at this head the count decides, and with a
	// review at an older head only the answer is `stale`. A refusal notice from an earlier
	// commit must never mask either.
	const newest = atHead[atHead.length - 1];
	if (newest === undefined) {
		if (botReviews.length === 0) {
			if (decline !== null) {
				return {
					code: EXIT_DECLINED,
					verdict: "declined",
					findings: { ...findings, wait: decline.wait, detail: decline.detail },
				};
			}
			return verdictOf(findings, "pending", EXIT_WAITING, "bot check complete, no review posted yet");
		}
		return verdictOf(findings, "stale", EXIT_STALE, "bot reviewed an older head only");
	}

	// A re-review at the same head supersedes the earlier one, so read the LATEST round.
	// Taking the maximum would let a resolved round block the PR forever, and reusing an
	// older clean count when the latest round has none would treat an unrecognised review
	// as approval.
	const latest = {
		actionable: adapterFor(newest[0]).count(str(newest[1].body)),
		changesRequested: str(newest[1].state) === "CHANGES_REQUESTED",
		url: str(newest[1].url),
	};
	const changes = latest.changesRequested ? 1 : 0;
	findings.changesRequested = changes;
	findings.summary = latest.url || "none";
	findings.files = [];
	for (const entry of comments) {
		if (!isObject(entry)) continue;
		if (loginSlug(str(entry.login), slugs) === null || str(entry.commit) !== head) continue;
		const line = truthy(entry.line) ? str(entry.line) : truthy(entry.original_line) ? str(entry.original_line) : "0";
		findings.files.push(`${str(entry.path) || "?"}:${line} ${str(entry.url)}`.trim());
	}
	findings.files.sort(compare);

	if (latest.actionable === null) {
		if (changes) {
			return verdictOf(findings, "actionable", EXIT_ACTIONABLE, "changes requested without a summary count");
		}
		return verdictOf(findings, "pending", EXIT_WAITING, "no actionable-comment summary at head yet");
	}

	findings.actionable = latest.actionable;
	if (changes || latest.actionable > 0) {
		return verdictOf(findings, "actionable", EXIT_ACTIONABLE, `${latest.actionable} actionable comment(s)`);
	}
	return verdictOf(findings, "clean", 0, "0 actionable comments");
}

/** The one-line `BOT_REVIEW` record, plus one `COMMENT` line per bot comment at head. */
export function renderBotReview(result: BotReviewVerdict): string {
	const f = result.findings;
	const lines = [
		`BOT_REVIEW ${result.verdict} bots=${f.bots} head=${f.head} check=${f.check} ` +
			`actionable=${f.actionable} changes_requested=${f.changesRequested} ` +
			`summary=${f.summary} wait=${f.wait} detail="${f.detail}"`,
	];
	for (const entry of f.files) lines.push(`COMMENT ${entry}`);
	return lines.join("\n");
}

/** A finished subprocess. `null` from an {@link Exec} means it never ran, or never answered. */
export interface ExecResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface ExecOptions {
	cwd?: string;
	timeoutMs?: number;
}

/**
 * The subprocess seam: one argv, never a throw.
 *
 * Exported so tests answer `gh` from a transcript instead of a network, and so a caller
 * that already has a `gh` runner can pass it instead of paying for a second spawn path.
 */
export type Exec = (argv: string[], opts: ExecOptions) => Promise<ExecResult | null>;

/**
 * Per-call bound on a `gh` read. None of the reads had a timeout, so a wedged `gh` -- an
 * auth prompt, a hung proxy -- hung the shepherd indefinitely rather than failing.
 *
 * FIVE SECONDS, not thirty. Four reads run per probe, so the bound has to leave the whole
 * probe inside a caller's patience; a paginated GitHub read that has not answered in five
 * seconds is not about to. Overridable for a genuinely slow link.
 *
 * PARITY: the script's `int(os.environ[...])` raised at import on a junk value. A tool
 * cannot take the session down over a stray env var, so unreadable falls back to five.
 */
export function ghTimeoutMs(env: Record<string, string | undefined> = process.env): number {
	const seconds = Number.parseInt(env.PR_SHEPHERD_GH_TIMEOUT ?? "", 10);
	return (Number.isFinite(seconds) && seconds > 0 ? seconds : 5) * 1000;
}

/** The default {@link Exec}: capture `gh`, and resolve `null` for every failure to answer. */
export const spawnExec: Exec = async (argv, opts) => {
	const [bin, ...args] = argv;
	if (bin === undefined) return null;
	try {
		const proc = Bun.spawn([bin, ...args], { cwd: opts.cwd, stdout: "pipe", stderr: "pipe" });
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			proc.kill();
		}, opts.timeoutMs ?? ghTimeoutMs());
		try {
			const [stdout, stderr, code] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			// A killed process still resolves with an exit code; reporting it would dress a
			// timeout up as an answer.
			return timedOut ? null : { code, stdout, stderr };
		} finally {
			clearTimeout(timer);
		}
	} catch {
		return null;
	}
};

/** `gh pr view` omits each review's commit id, so only the head and the rollup come from it. */
export function prViewArgv(repo: string, pr: string): string[] {
	return ["gh", "pr", "view", pr, "--repo", repo, "--json", "headRefOid,statusCheckRollup"];
}

/** One REST read, paginated because a single bot round can exceed a page. */
export function ghApiArgv(path: string): string[] {
	return ["gh", "api", "--paginate", "--slurp", path];
}

type Read<T> = { ok: true; value: T } | { ok: false; error: string };

async function ghJson(argv: string[], exec: Exec, opts: ExecOptions): Promise<Read<unknown>> {
	const label = argv.slice(1).join(" ");
	const result = await exec(argv, opts);
	// PARITY: the script told a timeout apart from a spawn failure by exception type. The
	// seam reports both as "no answer", which is the same operational fact.
	if (result === null) {
		const seconds = (opts.timeoutMs ?? ghTimeoutMs()) / 1000;
		return { ok: false, error: `gh ${label} did not answer: gh is missing, or it exceeded ${seconds}s` };
	}
	if (result.code !== 0) return { ok: false, error: `gh ${label} failed: ${result.stderr.trim()}` };
	// EMPTY STDOUT IS NOT "no data". `gh` exiting 0 with nothing on stdout turned into
	// `null`, which built a payload with an empty head and all-empty review arrays -- and
	// that classifies as `absent`, exit 0, clearing the merge as though the bot gate had
	// been satisfied. Silence from an upstream read cannot be evidence that a check passed.
	if (result.stdout.trim() === "") {
		return { ok: false, error: `gh ${label} exited 0 with empty output; refusing to read silence as an answer` };
	}
	try {
		return { ok: true, value: JSON.parse(result.stdout) };
	} catch (error) {
		return { ok: false, error: `gh ${label} returned unreadable JSON: ${String(error)}` };
	}
}

/** Read and flatten the REST pages `gh api --paginate --slurp` emits. */
async function ghPaginatedJson(
	path: string,
	exec: Exec,
	opts: ExecOptions,
): Promise<Read<Record<string, unknown>[]>> {
	const read = await ghJson(ghApiArgv(path), exec, opts);
	if (!read.ok) return read;
	if (!Array.isArray(read.value)) return { ok: false, error: "paginated gh response must be an array of pages" };
	const rows: Record<string, unknown>[] = [];
	for (const page of read.value) {
		if (!Array.isArray(page)) return { ok: false, error: "paginated gh response contains a malformed page" };
		for (const row of page) {
			if (!isObject(row)) return { ok: false, error: "paginated gh response contains a malformed page" };
			rows.push(row);
		}
	}
	return { ok: true, value: rows };
}

/** What the four `gh` reads produce, and the only input {@link classifyBotReviews} takes. */
export interface BotReviewPayload {
	head: string;
	/**
	 * `statusCheckRollup` exactly as it arrived. A truthy non-array is evidence classify
	 * must refuse, not something to quietly empty into "no bot checks".
	 */
	checks: unknown;
	reviews: { login: string; state: string; body: string; commit: string; url: string; at: string }[];
	comments: { login: string; path: string; line: unknown; commit: string; url: string }[];
	notices: { login: string; body: string; at: string }[];
}

export type FetchOutcome = { ok: true; payload: BotReviewPayload } | { ok: false; error: string };

/**
 * Four reads, no classification.
 *
 * `gh pr view` omits each review's commit id, so the reviews and their inline comments come
 * from REST. Issue comments are read as well, because a quota refusal arrives there rather
 * than as a review.
 */
export async function fetchBotReviewEvidence(
	repo: string,
	pr: string,
	opts: { exec?: Exec; cwd?: string; timeoutMs?: number } = {},
): Promise<FetchOutcome> {
	const exec = opts.exec ?? spawnExec;
	const run: ExecOptions = { cwd: opts.cwd, timeoutMs: opts.timeoutMs ?? ghTimeoutMs() };

	const view = await ghJson(prViewArgv(repo, pr), exec, run);
	if (!view.ok) return { ok: false, error: view.error };
	// A `null` or head-less view is not a PR with no reviews -- it is a read that did not
	// answer. Without this the payload carried head="" and empty review arrays, which
	// classifies as `absent` and exit 0, clearing the bot gate as though it had been
	// satisfied. The head is the one field every downstream comparison needs, so its
	// absence is the honest place to stop.
	const head = isObject(view.value) ? str(view.value.headRefOid) : "";
	if (head === "") {
		return {
			ok: false,
			error:
				`gh pr view ${pr} returned no headRefOid; refusing to treat an unanswered read as ` +
				"an absent review",
		};
	}
	const rollup = isObject(view.value) ? view.value.statusCheckRollup : undefined;

	const reviews = await ghPaginatedJson(`repos/${repo}/pulls/${pr}/reviews`, exec, run);
	if (!reviews.ok) return { ok: false, error: reviews.error };
	const comments = await ghPaginatedJson(`repos/${repo}/pulls/${pr}/comments`, exec, run);
	if (!comments.ok) return { ok: false, error: comments.error };
	const notices = await ghPaginatedJson(`repos/${repo}/issues/${pr}/comments`, exec, run);
	if (!notices.ok) return { ok: false, error: notices.error };

	return {
		ok: true,
		payload: {
			head,
			checks: truthy(rollup) ? rollup : [],
			reviews: reviews.value.map((r) => ({
				login: nested(r, "user", "login"),
				state: str(r.state),
				body: str(r.body),
				commit: str(r.commit_id),
				url: str(r.html_url),
				at: str(r.submitted_at),
			})),
			comments: comments.value.map((c) => ({
				login: nested(c, "user", "login"),
				path: str(c.path),
				line: truthy(c.line) ? c.line : truthy(c.original_line) ? c.original_line : 0,
				commit: str(c.commit_id),
				url: str(c.html_url),
			})),
			notices: notices.value.map((n) => ({
				login: nested(n, "user", "login"),
				body: str(n.body),
				at: str(n.created_at),
			})),
		},
	};
}

/** An `owner/repo` plus PR number, however the caller spelled the reference. */
export interface PrRef {
	repo: string;
	number: string;
}

const PR_URL = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/;
const PR_QUALIFIED = /^([^/\s]+)\/([^/\s]+)[#/](\d+)$/;
const PR_NUMBER = /^#?(\d+)$/;

/**
 * Split a PR reference into the repo and number the reads need.
 *
 * The repository cannot be derived — `gh pr view` is always called with an explicit
 * `--repo` — so a bare number is only usable alongside `repo`. Returning `null` there is
 * deliberate: guessing the repository from the session's checkout would silently probe a
 * different PR and report its verdict as this one's.
 */
export function parsePrRef(pr: string, repo?: string): PrRef | null {
	const text = pr.trim();
	const url = PR_URL.exec(text);
	if (url?.[1] && url[2] && url[3]) return { repo: `${url[1]}/${url[2]}`, number: url[3] };
	const qualified = PR_QUALIFIED.exec(text);
	if (qualified?.[1] && qualified[2] && qualified[3]) {
		return { repo: `${qualified[1]}/${qualified[2]}`, number: qualified[3] };
	}
	const bare = PR_NUMBER.exec(text);
	const owner = repo?.trim();
	if (bare?.[1] && owner) return { repo: owner, number: bare[1] };
	return null;
}

/** The caveat every bot-review verdict carries, because two codes are routinely misread. */
const NEVER_CLEAN =
	"unknown (2) and declined (13) are never to be treated as clean: unknown means the evidence could not " +
	"be read, declined means the bot refused the round and must be re-triggered.";

/** What the tool reports alongside its text. `error` is set only on unread evidence. */
export interface BotReviewDetails {
	/** A code from the landing contract's vocabulary. Unread evidence is 2, never `null`. */
	code: number;
	verdict: BotReviewState;
	head?: string;
	actionable?: number;
	changesRequested?: number;
	wait?: string;
	files?: string[];
	error?: string;
}

function unreadable(text: string, error: string): AgentToolResult<BotReviewDetails> {
	return {
		content: [{ type: "text", text: `verdict: unknown (exit ${EXIT_UNKNOWN}) — ${text}\n${NEVER_CLEAN}` }],
		details: { code: EXIT_UNKNOWN, verdict: "unknown", error },
		isError: true,
	};
}

/** Register `orc_bot_review_probe`. The orchestrator wires this from `src/index.ts`. */
export function registerBotReviewProbe(pi: ExtensionAPI, exec: Exec = spawnExec): void {
	const z = pi.zod;

	// A named const, not an inline `z.object(...)` argument: inlined, the generic no longer
	// infers and `params` degrades to `unknown`.
	const probeParams = z.object({
		pr: z.string().describe("PR reference: a github.com pull URL, `owner/repo#123`, or a number with `repo`"),
		repo: z.string().optional().describe("`owner/repo`, required when `pr` is a bare number"),
		bots: z.string().optional().describe("comma-separated bot slugs; defaults to $PR_REVIEW_BOTS"),
		cwd: z.string().optional().describe("working directory for the gh reads"),
	});

	pi.registerTool({
		name: "orc_bot_review_probe",
		label: "Bot review probe",
		description:
			"Classify a PR's review-bot round (CodeRabbit, Copilot review, ...) at its exact head SHA. Reads the " +
			"PR with `gh` — `pr view` for the head and check rollup, then the reviews, review comments and issue " +
			"comments — and grades the latest round at that head. Verdicts: clean (0), absent (0), pending (10), " +
			`stale (11), actionable (12), declined (13), unknown (2). ${NEVER_CLEAN}`,
		parameters: probeParams,
		approval: "read",
		async execute(
			_id,
			params,
			_signal,
			_onUpdate,
			ctx: ExtensionContext,
		): Promise<AgentToolResult<BotReviewDetails>> {
			try {
				const ref = parsePrRef(String(params.pr ?? ""), params.repo === undefined ? undefined : String(params.repo));
				if (!ref) {
					return unreadable(
						`cannot read a repository from pr=${JSON.stringify(params.pr)}. Pass a github.com pull URL, ` +
							"`owner/repo#123`, or a bare number together with `repo`.",
						"unreadable pr reference",
					);
				}

				const fetched = await fetchBotReviewEvidence(ref.repo, ref.number, {
					exec,
					cwd: params.cwd ?? ctx.cwd,
				});
				if (!fetched.ok) {
					return unreadable(`the PR read failed, so no round was classified.\n${fetched.error}`, fetched.error);
				}

				// The head a round must match is the one the reads just returned, never a
				// caller-supplied SHA: classifying against a stale head is how a `stale`
				// round reads as `clean`.
				const slugs = configuredSlugs(params.bots ? params.bots : undefined);
				const result = classifyBotReviews(fetched.payload, { head: fetched.payload.head, slugs });
				const adapters = slugs.map((slug) => `${slug}=${adapterNote(slug)}`).join("; ");
				const text = [
					`verdict: ${result.verdict} (exit ${result.code}) at head ${result.findings.head}`,
					renderBotReview(result),
					adapters === "" ? "" : `adapters: ${adapters}`,
					NEVER_CLEAN,
				]
					.filter(Boolean)
					.join("\n");

				return {
					content: [{ type: "text", text }],
					details: {
						code: result.code,
						verdict: result.verdict,
						head: result.findings.head,
						actionable: result.findings.actionable,
						changesRequested: result.findings.changesRequested,
						wait: result.findings.wait,
						files: result.findings.files,
					},
					// pending, stale, actionable and declined are answers, not failures. Only
					// evidence that could not be read is an error result.
					isError: result.verdict === "unknown",
				};
			} catch (error) {
				// Defence in depth: an unexpected throw would surface as a tool crash, which
				// reads to the model as "the repo is broken" rather than "the probe failed".
				return unreadable(`the probe failed: ${String(error)}`, "probe failed");
			}
		},
	});
}
