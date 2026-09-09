/** G7: one bead per acquisition, judged per invocation in contract-bound sessions. */

import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { gateOneClaim } from "../src/gates/one-claim";

/** A session declaring `role`, or declaring none when `role` is undefined. */
function ctxFor(role?: string): ExtensionContext {
	const prompt = role === undefined ? "a helper with no contract" : `ORC-ROLE: ${role}`;
	return { getSystemPrompt: () => [prompt] } as unknown as ExtensionContext;
}

const worker = ctxFor("implementer");
const ACTOR = "orc-impl-1";

/** The gate's verdict on one command line from a contract-bound worker. */
function verdict(command: string) {
	return gateOneClaim(worker, { command });
}

describe("G7 refuses a claim naming more than one bead", () => {
	test.each([
		["bare", "bd update orc-1 orc-2 --claim"],
		["--claim ahead of the ids", "bd update --claim orc-1 orc-2"],
		["behind a database pin", "bd -C /repo update orc-1 orc-2 --claim"],
	])("%s", (_label, command) => {
		expect(verdict(command)?.block).toBe(true);
	});

	test("counts claims inside a wrapper shell", () => {
		expect(verdict("sh -c 'bd update orc-1 orc-2 --claim'")?.block).toBe(true);
	});

	test("counts ids with nonnumeric, hyphenated suffixes", () => {
		expect(verdict("bd update orc-chaos-c1-6gq orc-chaos-c2-sbv --claim")?.block).toBe(true);
	});

	test("names the count and every id", () => {
		const reason = verdict("bd update orc-1 orc-2 --claim")?.reason ?? "";

		expect(reason).toContain("2 beads");
		expect(reason).toContain("orc-1");
		expect(reason).toContain("orc-2");
	});

	test("counts claims on subcommands other than update", () => {
		expect(verdict("bd assign orc-1 orc-2 --claim")?.block).toBe(true);
	});
});

describe("G7 leaves a single claim alone", () => {
	test.each([
		["a single-bead claim", "bd update orc-1 --claim"],
		["a multi-id update that claims nothing", "bd update orc-1 orc-2 --status closed"],
		["a read of two beads", "bd show orc-1 orc-2 --json"],
		["the same id named twice, which --claim treats as idempotent", "bd update orc-1 orc-1 --claim"],
	])("%s", (_label, command) => {
		expect(verdict(command)).toBeUndefined();
	});

	test("the queue pull, which claims the first match however many filters it carries", () => {
		// `bd ready --claim` claims "the first ready issue matching the filters"
		// (bd 1.1.2). Its ids are filters: `--parent orc-1` names the epic. A count over
		// operands would read that plus a label as two beads.
		expect(verdict("bd ready --parent orc-1 --label agent:implementer --unassigned --claim --json")).toBeUndefined();
		expect(verdict("bd ready --parent orc-1 --mol orc-2 --claim")).toBeUndefined();
	});

	test("a grouped subcommand whose own name is id-shaped", () => {
		// `merge-slot` matches the id pattern, so counting it beside a real id would
		// refuse every slot acquisition. The subcommand is not an operand.
		expect(verdict("bd merge-slot acquire orc-1 --claim")).toBeUndefined();
	});
});

/**
 * Where a count over `positionals` alone goes wrong. `src/shell.ts` skips the operands
 * of bd's *global* flags only, so every one of these leaves a second operand behind
 * that a plain count reads as a second bead.
 */
describe("G7 does not mistake a flag's value for a second bead", () => {
	test.each([
		["--parent", "bd update orc-1 --claim --parent orc-2"],
		["--assignee", `bd update orc-1 --claim --assignee ${ACTOR}`],
		["-s, whose value is not even id-shaped", "bd update orc-1 --claim -s in_progress"],
		["--reason", "bd update orc-1 --claim --reason build-failed"],
		["--set-metadata", "bd update orc-1 --claim --set-metadata worktree=/tmp/wt-1"],
		["--add-label", "bd update orc-1 --claim --add-label agent:implementer"],
	])("%s", (_label, command) => {
		expect(verdict(command)).toBeUndefined();
	});

	test("but a real second id after a flag's value is still counted", () => {
		expect(verdict("bd update orc-1 orc-2 --claim --parent orc-3")?.block).toBe(true);
	});
});

describe("G7 binds contract-bound sessions only", () => {
	test("a session declaring no role is left alone", () => {
		// The invariant is the worker contract's, and the lead claims nothing at all.
		expect(gateOneClaim(ctxFor(), { command: "bd update orc-1 orc-2 --claim" })).toBeUndefined();
	});

	test("every declared role is bound", () => {
		for (const role of ["architect", "implementer", "reviewer", "researcher", "shepherd"]) {
			expect(gateOneClaim(ctxFor(role), { command: "bd update orc-1 orc-2 --claim" })?.block).toBe(true);
		}
	});

	test("a call carrying no command is not a claim", () => {
		expect(gateOneClaim(worker, {})).toBeUndefined();
		expect(gateOneClaim(worker, { command: "" })).toBeUndefined();
	});
});

describe("G7 leaves text about bd alone", () => {
	// Quoted scripts mentioning multiple claims are data, not acquisitions.
	test.each([
		[
			"a heredoc'd case table for the rules themselves",
			`python3 - <<'PY'\ncases = {"orc-bd-actor-prefix.md": {"pos": ["bd update x-1 --status open"]},\n "orc-one-claim.md": {"pos": ["bd update orc-1 orc-2 --claim"]}}\nPY`,
		],
		[
			"a bun -e table of tokeniser evasions",
			`bun -e 'const cases = ["bd update orc-1 --claim", "bd    update    orc-1   --claim", "bd update orc-1 orc-2 --claim"];'`,
		],
	])("%s", (_shape, command) => {
		expect(verdict(command)).toBeUndefined();
	});
});

describe("G7 residue, recorded rather than left to be discovered", () => {
	test("ids arriving through a shell variable are out of reach", () => {
		// `src/shell.ts` expands no variables by design: the line names no bead until a
		// shell runs it, so neither the regex nor the tokeniser can count two.
		expect(verdict(`ids="orc-1 orc-2"; bd update $ids --claim`)).toBeUndefined();
	});

	test("counts claims inside glued and spaced subshells", () => {
		expect(verdict("(bd update orc-1 orc-2 --claim)")?.block).toBe(true);
		expect(verdict("( bd update orc-1 orc-2 --claim )")?.block).toBe(true);
	});

	test("two single-bead claims in one command line are two invocations, each legal", () => {
		// Count per invocation, not across a claim-release-claim line.
		expect(verdict("bd update orc-1 --claim && bd update orc-2 --claim")).toBeUndefined();
	});
});
