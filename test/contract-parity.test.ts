/**
 * The dispatch contract exists twice: as the string the extension injects, and as
 * prose in the skill so a reader can audit the protocol without reading the code.
 * Two copies drift, so this asserts the reference file contains the injected string
 * verbatim — no normalisation, since a reader who reformats the prose has changed
 * what the audit trail claims the worker was told.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import { COMMENT_VERBS, DISPATCH_CONTRACT, dispatchContract, PROTOCOL_VERBS } from "../src/contract";

const REFERENCE = "skills/orchestrate/references/dispatch-contract.md";

describe("dispatch contract parity", () => {
	test("the skill reference reproduces the injected contract verbatim", async () => {
		const fileText = await fs.readFile(REFERENCE, "utf8");
		expect(fileText).toContain(DISPATCH_CONTRACT);
	});

	test("the reference points at the source of truth", async () => {
		// Without the pointer, the next reader has no way to know which copy leads.
		const fileText = await fs.readFile(REFERENCE, "utf8");
		expect(fileText).toContain("src/contract.ts");
	});
});

/**
 * G8 refuses a comment body whose first word is not in `COMMENT_VERBS`, and the worker
 * learns which words those are from the injected contract. If the two drift, a worker
 * follows the text it was given and is refused for it — so the table's protocol half is
 * asserted against the text that teaches it.
 */
describe("comment verb parity", () => {
	test("the contract names all 11 protocol verbs, and the gate admits each", () => {
		const line = /Verbs \(11\): ([\s\S]*?)\. One verb/.exec(DISPATCH_CONTRACT)?.[1] ?? "";
		const named = line.split(/\s+/).filter(word => word.length > 0);

		expect(named).toEqual([...PROTOCOL_VERBS]);
		for (const verb of named) expect(COMMENT_VERBS[verb]).toBe(true);
	});

	test("every verb the gate admits is uppercase, as commentVerb produces", () => {
		// `commentVerb` uppercases the body's first token before the lookup, so a
		// lower-case entry here would be unreachable.
		for (const verb of Object.keys(COMMENT_VERBS)) expect(verb).toBe(verb.toUpperCase());
	});
});

/**
 * The pin is what keeps an isolated worker's claims real. Isolation hands the child a
 * copy of the checkout and `bd` resolves its database from the working directory, so
 * an unpinned call mutates the copy: the claim never becomes visible and two workers
 * can hold one bead. Verified directly -- a bead created in a copied checkout is
 * invisible in the original.
 */
describe("the database pin", () => {
	test("the canonical text instructs the worker to pin every call", () => {
		expect(DISPATCH_CONTRACT).toContain("bd -C <run repo>");
		// The claim example itself must carry it, not just the prose.
		expect(DISPATCH_CONTRACT).toContain("bd -C <run repo> ready --parent <epic>");
	});

	test("a known repository is substituted everywhere the placeholder appears", () => {
		const rendered = dispatchContract("/repos/run-7");
		expect(rendered).toContain("bd -C /repos/run-7 ready --parent <epic>");
		expect(rendered).not.toContain("<run repo>");
	});

	test("an unknown repository leaves the instruction visible", () => {
		// A marker written before `repo_root` existed, or a run armed by
		// ORCHESTRATE_RUN with no marker. Dropping the instruction would silently
		// return the worker to a private database.
		for (const missing of [undefined, ""]) {
			expect(dispatchContract(missing)).toBe(DISPATCH_CONTRACT);
			expect(dispatchContract(missing)).toContain("bd -C <run repo>");
		}
	});
});
