import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

test("the live protocol table documents exactly the declared verbs", () => {
	const reference = readFileSync(join(ROOT, "skills/orchestrate/references/message-grammar.md"), "utf8");
	const documented = new Set(
		Array.from(reference.matchAll(/^\|\s*`([A-Z_]+)`\s*\|/gm), match => match[1]),
	);
	expect(documented).toEqual(new Set(declared));
});

describe("the gate", () => {
	test("admits every declared verb, prefix pairs included", () => {
		// BOUNCE is a prefix of BOUNCED. Comparing the sets as text would not catch a
		// normalisation change that lets the shorter one shadow the longer.
		for (const verb of declared) {
			expect({ verb, notice: noticeOn(`${verb} something happened`) }).toEqual({ verb, notice: undefined });
		}
	});

	test("refuses a token no grammar entry defines", () => {
		// The shapes a cut verb leaves behind, and the near-misses of live ones. Each
		// must nag: a stale verb that still passes is a contract nothing can review.
		// BRIEF is here because it is the one verb the deleted regex admitted with no use
		// site anywhere in this repository: the single place the acceptance set narrowed.
		for (const token of ["ACK", "DONE", "OK", "PROGRESS", "REVIEWED", "NO", "WORK", "CLAIM", "WAIT", "BRIEF"]) {
			expect({ token, fires: noticeOn(`${token} something happened`) !== undefined }).toEqual({
				token,
				fires: true,
			});
		}
	});
});

describe("the verbs with a use site", () => {
	test("every verb a role contract requires is declared, and the gate admits it", () => {
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
			expect({ verb, declared: declared.includes(verb), notice: noticeOn(`${verb} done`) }).toEqual({
				verb,
				declared: true,
				notice: undefined,
			});
		}
	});
});
