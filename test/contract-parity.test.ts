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
 * The pin mandate stays gone, and the mechanism that replaced it changed. An earlier version
 * required a per-project Dolt server, so bd resolved by host and port and no path was needed.
 * The database is embedded again, so the path is exactly what is needed, and the run pins
 * `BEADS_DIR` once for every child. The contract must say the mechanism that holds, and must
 * not demand a flag nothing enforces.
 */
describe("the database resolution", () => {
	test("the canonical pull does not demand a pin", () => {
		expect(DISPATCH_CONTRACT).not.toContain("bd -C");
		expect(DISPATCH_CONTRACT).toContain("bd ready --parent <epic>");
	});

	test("the contract names BEADS_DIR as what reaches the run's database", () => {
		expect(DISPATCH_CONTRACT).toContain("BEADS_DIR");
		// The walk-up hazard is why the pin exists, so a worker is told the reason rather than
		// just the rule.
		expect(DISPATCH_CONTRACT).toContain("walking up from the working directory");
		// The server is gone: its state files must not be cited to workers as a mechanism.
		expect(DISPATCH_CONTRACT).not.toContain("dolt-server.port");
		expect(DISPATCH_CONTRACT).not.toContain("per-project Dolt server");
	});
});
