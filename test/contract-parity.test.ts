/**
 * The dispatch contract exists twice: as the string the extension injects, and as
 * prose in the skill so a reader can audit the protocol without reading the code.
 * Two copies drift, so this asserts the reference file contains the injected string
 * verbatim — no normalisation, since a reader who reformats the prose has changed
 * what the audit trail claims the worker was told.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import { DISPATCH_CONTRACT } from "../src/contract";

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
 * The pin mandate is gone: this project runs a per-project Dolt server, so bd resolves
 * the run's database by host and port from `.beads/dolt-server.port`, which travels with
 * a copied checkout. The contract must say the mechanism that holds, and must not demand
 * a flag nothing enforces.
 */
describe("the database resolution", () => {
	test("the canonical pull does not demand a pin", () => {
		expect(DISPATCH_CONTRACT).not.toContain("bd -C");
		expect(DISPATCH_CONTRACT).toContain("bd ready --parent <epic>");
	});

	test("the contract states the server mechanism, not the embedded one", () => {
		expect(DISPATCH_CONTRACT).toContain("per-project Dolt server");
		expect(DISPATCH_CONTRACT).toContain(".beads/dolt-server.port");
		// The embedded walk-up story is the claim that was false here.
		expect(DISPATCH_CONTRACT).not.toContain("walking up from the working directory");
	});
});
