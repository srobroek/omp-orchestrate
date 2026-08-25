/**
 * The verb set exists twice: as `src/contracts/grammar.json`, which leads, and as the
 * table in `references/message-grammar.md`, which restates it for humans. Two copies
 * drift silently and asymmetrically -- a verb missing from the table is a verb no writer
 * knows they may use, a row surviving a cut reads as authoritative long after the verb
 * died. So parity is asserted in both directions, by name.
 *
 * The third copy used to be the alternation inside `rules/orc-comment-verbs.md`. That
 * rule is gone, converted into `src/gates/bd.ts`, so the drift guard moved with it: the
 * verbs the GATE enforces must equal the ones this file declares. The gate is exercised
 * rather than only compared, because a set can contain a verb and still fail to admit it.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { commentVerb } from "../src/bd";
import grammar from "../src/contracts/grammar.json";
import { commentVerbNotice } from "../src/gates/bd";
import { type BdInvocation, bdInvocations } from "../src/shell";

const ROOT = join(import.meta.dir, "..");
const REFERENCE = "skills/orchestrate/references/message-grammar.md";
/** The pin the gate's own refusal mandates, so only the verb check can speak. */
const RUN_REPO = "/run/repo";

/** The single invocation a one-command line parses to. */
function only(command: string): BdInvocation {
	const invocations = bdInvocations(command);
	if (invocations.length !== 1) {
		throw new Error(`${command} parsed to ${invocations.length} invocations, not 1`);
	}
	return invocations[0] as BdInvocation;
}

/** What the gate says about a comment body, or `undefined` when it says nothing. */
function noticeOn(text: string): string | undefined {
	return commentVerbNotice(only(`bd -C ${RUN_REPO} comment orc-1 "${text}"`), RUN_REPO);
}

/**
 * The verb set the gate enforces, read back out of the notice it writes.
 *
 * The notice quotes that set, so this is the list an agent is actually told to use --
 * which is the copy that matters. A gate enforcing one set and naming another trains
 * agents to distrust it, and nothing else in the repository would notice.
 */
function gateVerbs(): string[] {
	const notice = noticeOn("unrecognised body");
	if (notice === undefined) throw new Error("the gate raised no notice on a non-verb");
	const listed = /leading with one of: (.+?)\. Case is free/.exec(notice)?.[1];
	if (listed === undefined) throw new Error("the gate's notice quotes no verb set");
	return listed.split(" ").filter(verb => verb.length > 0);
}

const declared = grammar.verbs.map(entry => entry.verb);

describe("verb grammar parity", () => {
	test("the gate enforces exactly the verbs the grammar declares", () => {
		expect([...gateVerbs()].sort()).toEqual([...declared].sort());
	});

	test("no verb reaches the gate without a grammar entry", () => {
		// Drift direction 1: the gate sanctions a token whose meaning and writer are
		// undefined, so nothing can review who was allowed to write it.
		expect(gateVerbs().filter(verb => !declared.includes(verb))).toEqual([]);
	});

	test("no verb the grammar declares is refused by the gate", () => {
		// Drift direction 2: the grammar promises a verb the gate then nags, which
		// trains agents to ignore the advisory.
		expect(declared.filter(verb => !gateVerbs().includes(verb))).toEqual([]);
	});

	test("no verb is declared twice", () => {
		// The array form permits a duplicate where an object would have swallowed it.
		// Filtering rather than deduping so the failure names the repeated verb.
		expect(declared.filter((verb, at) => declared.indexOf(verb) !== at)).toEqual([]);
	});
});

describe("the gate", () => {
	test("admits every declared verb, prefix pairs included", () => {
		// BOUNCE is a prefix of BOUNCED. Comparing the sets as text would not catch a
		// normalisation change that lets the shorter one shadow the longer.
		for (const verb of declared) {
			expect({ verb, notice: noticeOn(`${verb} something happened`) }).toEqual({ verb, notice: undefined });
		}
	});

	test("fires exactly when the parser yields a non-verb", () => {
		// The invariant the deleted rule body stated, asserted in both directions and now
		// against the gate. A form the gate admits but `commentVerb` rejects fails a
		// contract in silence; a form the gate nags but `commentVerb` accepts trains
		// agents to ignore the advisory. `commentVerbNotice` calls `commentVerb`, so this
		// is an identity rather than a comparison -- and it is asserted because the two
		// were separate implementations until this conversion, and drifted.
		const forms = [
			"REVIEW approved",
			"**REVIEW** approved",
			"- REVIEW approved",
			"`REVIEW` approved",
			"REVIEW, approved",
			"> REVIEW approved",
			"_REVIEW_ approved",
			"~~REVIEW~~ approved",
			"> - **REPORTED**: orc-1 pushed",
			"reported orc-1",
			"   BLOCKED   kind:design",
			"NO_WORK",
			"NO WORK for me",
			"NO WORKTREE was created",
			"done",
			"the REVIEW is done",
			"REVIEWED the branch",
			"REVIEW/approved",
			"",
		];
		for (const text of forms) {
			// Compared as a pair so a failure names the form rather than just a boolean.
			const fires = noticeOn(text) !== undefined;
			expect({ text, fires }).toEqual({ text, fires: !declared.includes(commentVerb(text)) });
		}
	});

	test("refuses a token no grammar entry defines", () => {
		// The shapes a cut verb leaves behind, and the near-misses of live ones. Each
		// must nag: a stale verb that still passes is a contract nothing can review.
		for (const token of ["ACK", "DONE", "OK", "PROGRESS", "REVIEWED", "NO", "WORK", "CLAIM", "WAIT"]) {
			expect({ token, fires: noticeOn(`${token} something happened`) !== undefined }).toEqual({
				token,
				fires: true,
			});
		}
	});
});

describe("the hand-written reference", () => {
	test("it names the source of truth", () => {
		// Without the pointer, the next reader has no way to know which copy leads.
		expect(readFileSync(join(ROOT, REFERENCE), "utf8")).toContain("src/contracts/grammar.json");
	});

	test("it lists every verb with its writers", () => {
		const body = readFileSync(join(ROOT, REFERENCE), "utf8");
		for (const entry of grammar.verbs) {
			expect(body).toContain(`\`${entry.verb}\``);
			for (const writer of entry.writers) expect(body).toContain(writer);
		}
	});

	test("its table invents no verb the grammar does not declare", () => {
		// The forward direction above catches a dropped row. This catches the opposite:
		// a row surviving a cut, which reads as authoritative long after the verb died.
		const declared = grammar.verbs.map((entry) => entry.verb);
		const rows = readFileSync(join(ROOT, REFERENCE), "utf8")
			.split("\n")
			.map((line) => /^\|\s*`([A-Z_]+)`\s*\|/.exec(line)?.[1])
			.filter((verb): verb is string => verb !== undefined);
		expect(rows.length).toBe(declared.length);
		expect(rows.filter((verb) => !declared.includes(verb))).toEqual([]);
	});
});

describe("every entry", () => {
	test("names at least one writer and a known provenance", () => {
		// An entry with no writer is a verb anyone may write, which is what this file
		// exists to prevent.
		for (const entry of grammar.verbs) {
			expect(entry.writers.length).toBeGreaterThan(0);
			expect(["contract", "code", "inferred"]).toContain(entry.source.kind);
			expect(entry.source.where.length).toBeGreaterThan(0);
			expect(entry.meaning.length).toBeGreaterThan(0);
		}
	});
});
