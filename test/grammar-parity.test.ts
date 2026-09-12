import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DISPATCH_CONTRACT } from "../src/contract";
import grammar from "../src/contracts/grammar.json";
import { commentVerbNotice } from "../src/gates/bd";
import { type BdInvocation, bdInvocations } from "../src/shell";

const ROOT = join(import.meta.dir, "..");
/** A `-C` spelling on every line, so the pin's presence is never the variable under test. */
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
	return commentVerbNotice(only(`bd -C ${RUN_REPO} comment orc-1 "${text}"`));
}

const declared = grammar.verbs.map(entry => entry.verb);
const writable = grammar.verbs.filter(entry => !entry.writers.includes("extension")).map(entry => entry.verb);
const extensionOnly = declared.filter(verb => !writable.includes(verb));

test("the live protocol table documents exactly the declared verbs", () => {
	const reference = readFileSync(join(ROOT, "skills/orchestrate/references/message-grammar.md"), "utf8");
	const documented = new Set(
		Array.from(reference.matchAll(/^\|\s*`([A-Z_]+)`\s*\|/gm), match => match[1]),
	);
	expect(documented).toEqual(new Set(declared));
});

describe("the dispatch contract", () => {
	// The contract is the one copy a worker reads without opening grammar.json, so its
	// list is asserted against the grammar by construction rather than by a count typed
	// beside it: a verb added to one and not the other fails here, in either direction.
	const sentence = /Verbs you may write \((\d+)\): ([A-Z_ \n]+?)\./.exec(DISPATCH_CONTRACT);
	const listed = (sentence?.[2] ?? "").split(/\s+/).filter(token => token.length > 0);

	test("lists exactly the verbs an agent may write, in the grammar's order", () => {
		expect(listed).toEqual(writable);
		expect(Number(sentence?.[1])).toBe(writable.length);
	});

	test("names the full set and the extension's share by the grammar's counts", () => {
		expect(DISPATCH_CONTRACT).toContain(`The full set of ${declared.length} lives in`);
		const words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
		expect(DISPATCH_CONTRACT).toContain(`The other ${words[extensionOnly.length]} are the extension's`);
	});

	test("never hands an agent an extension verb", () => {
		for (const verb of extensionOnly) expect(listed).not.toContain(verb);
	});
});

describe("the gate", () => {
	test("admits every declared verb", () => {
		for (const verb of declared) {
			expect({ verb, notice: noticeOn(`${verb} something happened`) }).toEqual({ verb, notice: undefined });
		}
	});

	test("refuses a token no grammar entry defines", () => {
		// The shapes a cut verb leaves behind, and the near-misses of live ones. Each
		// must nag: a stale verb that still passes is a contract nothing can review.
		// NO_WORK is the yield token, not a comment: an empty queue leaves no bead to
		// write on, so a comment leading with it is a slip the gate must name.
		const retired = ["ADVICE", "CONFLICT", "IDLE", "LOCAL_DECISION", "BOUNCE", "RECLAIM", "NO_WORK"];
		const nearMisses = ["ACK", "DONE", "OK", "PROGRESS", "REVIEWED", "NO", "WORK", "CLAIM", "WAIT", "BRIEF"];
		for (const token of [...retired, ...nearMisses]) {
			expect({ token, fires: noticeOn(`${token} something happened`) !== undefined }).toEqual({
				token,
				fires: true,
			});
		}
	});
});

describe("the verbs with a use site", () => {
	test("every verb a role contract requires is declared, writable, and admitted by the gate", () => {
		// Nagging one of these would nag the comment that satisfies the contract demanding
		// it, which is how an advisory teaches agents to ignore it.
		const required = new Set<string>();
		for (const file of ["architect", "generic", "implementer", "researcher", "reviewer", "shepherd"]) {
			const body = readFileSync(join(ROOT, "src/contracts", `${file}.json`), "utf8");
			for (const [, list] of body.matchAll(/comment\.verb in \[([^\]]*)\]/g)) {
				for (const verb of (list as string).split(",")) required.add(verb.trim());
			}
		}

		// The predicates are the point: an empty set would make this pass vacuously.
		expect(required.size).toBeGreaterThan(0);
		for (const verb of required) {
			expect({ verb, writable: writable.includes(verb), notice: noticeOn(`${verb} done`) }).toEqual({
				verb,
				writable: true,
				notice: undefined,
			});
		}
	});
});
