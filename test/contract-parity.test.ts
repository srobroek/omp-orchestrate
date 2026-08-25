/**
 * The dispatch contract exists twice: as the string the extension injects, and as
 * prose in the skill so a reader can audit the protocol without reading the code.
 * Two copies drift, so this asserts the reference file contains the injected string
 * verbatim — no normalisation, since a reader who reformats the prose has changed
 * what the audit trail claims the worker was told.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import { DISPATCH_CONTRACT, dispatchContract } from "../src/contract";

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
