/**
 * G6 — actor attribution on bead writes.
 *
 * The gate is exercised against the real tokeniser and the real role resolution; it
 * shells out to nothing, so nothing is mocked.
 *
 * The false-positive cases are not invented. Each is a verbatim command recovered
 * from a local session transcript that the regex rule this gate replaces flagged, and
 * every one of them is an agent writing about bd rather than calling it.
 */

import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { gateActorAttribution } from "../src/gates/actor";

/** A session declaring `role`, or declaring none when `role` is undefined. */
function ctxFor(role?: string): ExtensionContext {
	const prompt = role === undefined ? "a helper with no contract" : `ORC-ROLE: ${role}`;
	return { getSystemPrompt: () => [prompt] } as unknown as ExtensionContext;
}

const worker = ctxFor("implementer");

/** The gate's verdict on one command line from a contract-bound worker. */
function verdict(command: string, input: Record<string, unknown> = {}) {
	return gateActorAttribution(worker, { command, ...input });
}

describe("G6 refuses an unattributed write", () => {
	test.each([
		["close", "bd close orc-7 --reason done"],
		["update", "bd update orc-7 --status in_progress"],
		["comments add", "bd comments add orc-7 'REPORTED landed'"],
		["create", "bd create 'a title' -t task"],
		// Verbs the replaced regex omitted from its list, so it never saw these.
		["assign", "bd assign orc-7 someone"],
		["delete", "bd delete orc-7"],
		["reopen", "bd reopen orc-7"],
		["note", "bd note orc-7 'a note'"],
		["tag", "bd tag orc-7 blocked"],
		["link", "bd link orc-7 orc-8"],
		["priority", "bd priority orc-7 1"],
		["promote", "bd promote orc-wisp-1"],
	])("%s", (_verb, command) => {
		expect(verdict(command)?.block).toBe(true);
	});

	test("names the subcommand and both variables it wants", () => {
		const reason = verdict("bd close orc-7")?.reason ?? "";

		expect(reason).toContain("bd close");
		expect(reason).toContain("BEADS_ACTOR");
		expect(reason).toContain("BD_ACTOR");
	});

	test("a claim that names its bead, whose actor bd show already yields", () => {
		expect(verdict("bd update orc-7 --claim")?.block).toBe(true);
	});

	test("but not the queue pull, which precedes the identity it would carry", () => {
		expect(verdict("bd ready --label agent:implementer --unassigned --claim --json")).toBeUndefined();
		expect(verdict("bd ready --label agent:implementer --unassigned --json")).toBeUndefined();
	});

	test("a write in the second segment of a pipeline", () => {
		expect(verdict("cd /repo && bd update orc-7 --status open")?.block).toBe(true);
	});
	test("a write reached through a wrapper shell's payload", () => {
		expect(verdict(`sh -c 'bd close orc-7'`)?.block).toBe(true);
	});


	test("an unrecognised subcommand, because a write list would drift", () => {
		expect(verdict("bd frobnicate orc-7")?.block).toBe(true);
	});
});

describe("G6 allows an attributed write", () => {
	test("inline assignment, either spelling", () => {
		expect(verdict("BEADS_ACTOR=orc-impl-1 BD_ACTOR=orc-impl-1 bd close orc-7")).toBeUndefined();
		expect(verdict("BD_ACTOR=orc-impl-1 bd close orc-7")).toBeUndefined();
	});

	test("through env, which reaches every command in the call", () => {
		expect(verdict("bd close orc-7", { env: { BEADS_ACTOR: "orc-impl-1" } })).toBeUndefined();
	});

	test("an empty assignment is no identity", () => {
		expect(verdict("BEADS_ACTOR= bd close orc-7")?.block).toBe(true);
		expect(verdict("bd close orc-7", { env: { BEADS_ACTOR: "" } })?.block).toBe(true);
	});
});

describe("G6 exempts reads", () => {
	test.each([
		["show", "bd show orc-7"],
		["list", "bd list --status all --json"],
		["ready", "bd ready --json"],
		["blocked", "bd blocked"],
		["prime", "bd prime"],
		// Group verbs whose write siblings refuse under BD_READONLY=1.
		["gate list", "bd gate list"],
		["dep tree", "bd dep tree orc-7"],
		["label list", "bd label list orc-7"],
		["kv get", "bd kv get somekey"],
	])("%s", (_verb, command) => {
		expect(verdict(command)).toBeUndefined();
	});

	test("but not their write siblings", () => {
		expect(verdict("bd gate create g-1")?.block).toBe(true);
		expect(verdict("bd dep add orc-7 orc-8")?.block).toBe(true);
		expect(verdict("bd label add orc-7 x")?.block).toBe(true);
		expect(verdict("bd kv set k v")?.block).toBe(true);
	});
});

/**
 * Each of these was blocked by an earlier revision of the gate, and each was found by
 * scoring it against 4,673 recorded commands rather than by reasoning about it.
 */
describe("G6 exempts store administration, which has no bead to attribute", () => {
	test.each([
		["init", "bd init --quiet"],
		["setup", "bd setup codex --check"],
		["bootstrap", "bd bootstrap"],
		["dolt push", "bd dolt push"],
		["help", "bd help close"],
		["codex-hook", "bd codex-hook SessionStart"],
	])("%s", (_verb, command) => {
		expect(verdict(command)).toBeUndefined();
	});

	test("a redirection is not a subcommand", () => {
		// The tokeniser expands no redirections, so this presents `2>&1` where a
		// subcommand would be. The command prints help.
		expect(verdict("bd 2>&1 | head -20")).toBeUndefined();
	});
});


describe("G6 leaves text about bd alone", () => {
	/**
	 * Verbatim from local session transcripts. The regex rule flagged all five,
	 * because a quoted `|` or `;` supplied the command separator it matched on.
	 */
	test.each([
		[
			"grep alternation",
			`cd /tmp/psc-verify && echo "=== beads run record in recipes:"; grep -rl 'orchestration/audit\\|bd create\\|beads' recipes/ --include='*.yml' 2>/dev/null | head -8`,
		],
		["regex table", `const conds = { gateclose: [/\\bbd\\s+close\\b[^\\n]*gate/i] };`],
		["case list", `const cases = { yes: ["bd close bd-x --reason done", "cd /repo && bd close bd-a"] };`],
		["heredoc", `cd /tmp && cat > rx.mjs <<'EOF'\nconst specid = /\\bbd\\s+create\\b/;\nEOF`],
		["alternation in rg", `rg 'bd update|bd close' docs/`],
	])("%s", (_shape, command) => {
		expect(verdict(command)).toBeUndefined();
	});
});

describe("G6 binds contract-bound sessions only", () => {
	test("a session declaring no role is left to G1", () => {
		expect(gateActorAttribution(ctxFor(), { command: "bd close orc-7" })).toBeUndefined();
	});

	test("every declared role is bound", () => {
		for (const role of ["architect", "implementer", "reviewer", "researcher", "shepherd"]) {
			expect(gateActorAttribution(ctxFor(role), { command: "bd close orc-7" })?.block).toBe(true);
		}
	});

	test("a call carrying no command is not a bd write", () => {
		expect(gateActorAttribution(worker, {})).toBeUndefined();
		expect(gateActorAttribution(worker, { command: "" })).toBeUndefined();
	});
});
