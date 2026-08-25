/**
 * G8 — a bead comment leads with its protocol verb.
 *
 * Driven against the real tokeniser, the real verb table, and the real role resolution;
 * nothing is mocked.
 *
 * The passing cases are not invented. Each is a verbatim command recovered from a local
 * session transcript that the regex rule this gate replaces flagged, and none of them
 * carries a narrated body: they are help text, a read, or a body the command never put
 * on the line at all.
 */

import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { COMMENT_VERBS, PROTOCOL_VERBS } from "../src/contract";
import { gateCommentVerb } from "../src/gates/comment-verb";

/** A session declaring `role`, or declaring none when `role` is undefined. */
function ctxFor(role?: string): ExtensionContext {
	const prompt = role === undefined ? "a helper with no contract" : `ORC-ROLE: ${role}`;
	return { getSystemPrompt: () => [prompt] } as unknown as ExtensionContext;
}

const worker = ctxFor("implementer");

/** The gate's verdict on one command line from a contract-bound worker. */
function verdict(command: string) {
	return gateCommentVerb(worker, { command });
}

describe("G8 refuses a narrated comment", () => {
	test.each([
		["quoted", `bd comment orc-1 "finished the thing"`],
		// The regex needed a quote after the bead id, so it never saw the bare form.
		["unquoted, which bd accepts as [text...]", "bd comment orc-1 finished the thing"],
		// The regex required `comment` immediately after `bd`, so the long form escaped
		// it — and the long form is what every real violation in the corpus used.
		["through comments add", `bd comments add orc-1 "narrated prose"`],
		// A pinned call, which the regex could not match either: the same rule-versus-rule
		// interaction that killed the actor guard in 6e8ee0c.
		["behind a database pin", `bd -C /repo comment orc-1 "narrated prose"`],
		["inside a wrapper shell", `sh -c 'bd comment orc-1 "narrated prose"'`],
		["second in a chain", `cd /repo && bd comment orc-1 "narrated prose"`],
	])("%s", (_label, command) => {
		expect(verdict(command)?.block).toBe(true);
	});

	test("names the offending word and what to lead with instead", () => {
		const reason = verdict(`bd comment orc-1 "finished the thing"`)?.reason ?? "";

		expect(reason).toContain("'FINISHED'");
		expect(reason).toContain("without narration");
	});

	test.each([
		["NEW", `bd comments add chezmoi-6nu "NEW plugin landed"`],
		["ADOPT", `bd comments add chezmoi-gk3 "ADOPT both"`],
		["RESOLVED", `bd comments add chezmoi-42o "Resolved: the role takes the other branch"`],
		["DESIGN", `bd comments add chezmoi-lpp "DESIGN RATIONALE (post-hoc audit): standalone plugin"`],
	])("a real corpus violation opening with %s", (_verb, command) => {
		// Reduced from the transcript commands, which run to several hundred bytes of
		// prose. Every one used `bd comments add`, which is why the regex caught none.
		expect(verdict(command)?.block).toBe(true);
	});
});

describe("G8 allows a comment that leads with a verb", () => {
	test.each([
		["a protocol verb", `bd comment orc-1 "REPORTED landed on omp/task/orc-1"`],
		["a verb with a trailing colon, which commentVerb strips", `bd comment orc-1 "REPORTED: landed"`],
		["a disposition", `bd comment orc-1 "LANDED merge_sha abc123"`],
		["an escape", `bd comment orc-1 "FAILED the build will not link"`],
		["a supervision verb", `bd comment orc-1 "RECLAIM child impl-7 died"`],
		["a skill verb", `bd comment orc-1 "WAITING_HUMAN which of the two schemas"`],
		["through comments add", `bd comments add orc-1 "REPORTED landed"`],
	])("%s", (_label, command) => {
		expect(verdict(command)).toBeUndefined();
	});

	test("in any case, because the exit contract reads it that way too", () => {
		// `commentVerb` uppercases, and `src/gates/exit.ts` judges the same comment with
		// it. A case-sensitive gate would refuse a comment its own exit check accepts.
		expect(verdict(`bd comment orc-1 "Landed the branch"`)).toBeUndefined();
		expect(verdict(`bd comment orc-1 "reported done"`)).toBeUndefined();
	});
});

/**
 * Verbatim from local session transcripts. The regex flagged all of these; not one
 * carries a body the gate can read, so refusing them would cost a legitimate command.
 */
describe("G8 passes a comment whose body is not on the command line", () => {
	test.each([
		[
			"a read whose next token is a redirection",
			`bd comment list orc-chaos-c3-05k.1 2>&1 | sed -n 1,30p; echo "---ready---"; bd ready --parent orc-chaos-c3-05k --label agent:implementer --unassigned --json 2>&1 | sed -n 1,20p`,
		],
		["help text", `bd comment --help 2>&1 | sed -n '1,25p'; echo "=== dep types ==="; bd dep add --help 2>&1 | sed -n '1,30p'`],
		["help across four subcommands", `bd update --help; echo '===='; bd comments --help; echo '===='; bd comment --help; echo '===='; bd unclaim --help`],
		["the short help flag", `bd comments -h; bd comment -h; bd --help | sed -n '1,80p'`],
		[
			"a body read from a file",
			`BEADS_ACTOR=impl-x BD_ACTOR=impl-x bd comment orc-chaos-c2-sbv.1 --file /tmp/orc-c2-comment.txt && BEADS_ACTOR=impl-x BD_ACTOR=impl-x bd update orc-chaos-c2-sbv.1 --status blocked --assignee '' --json`,
		],
	])("%s", (_shape, command) => {
		expect(verdict(command)).toBeUndefined();
	});

	test.each([
		["--stdin with a heredoc", "bd comment orc-1 --stdin <<EOF\nnarrated prose\nEOF"],
		["-f, the short file flag", "bd comments add orc-1 -f /tmp/body.txt"],
		["an id with nothing after it", "bd comment orc-1"],
		// The agent's own intent carried the verb; bd 1.1.2 has no such flags, so the
		// command fails at bd rather than at this gate.
		["flags bd does not have", `bd comment orc-1 --type REPORTED --message "delivered"`],
	])("%s", (_shape, command) => {
		expect(verdict(command)).toBeUndefined();
	});

	test("a body arriving through a shell expansion", () => {
		// The tokeniser expands nothing, so the first token is not text yet.
		expect(verdict(`bd comment orc-1 "$SUMMARY"`)).toBeUndefined();
		expect(verdict("bd comment orc-1 \"`build_summary`\"")).toBeUndefined();
	});

	test("but an expansion later in a readable body does not excuse it", () => {
		expect(verdict(`bd comment orc-1 "Wired $X into $Y"`)?.block).toBe(true);
	});
});

describe("G8 ignores everything that is not a comment", () => {
	test.each([
		["a read", "bd show orc-1 --json"],
		["a status write whose notes are narrated", `bd update orc-1 --notes "finished the thing"`],
		["a create whose title is narrated", `bd create "finished the thing" -t task`],
		["a comment on nothing", "bd comments list orc-1"],
	])("%s", (_label, command) => {
		expect(verdict(command)).toBeUndefined();
	});

	test("a call carrying no command", () => {
		expect(gateCommentVerb(worker, {})).toBeUndefined();
		expect(gateCommentVerb(worker, { command: "" })).toBeUndefined();
	});
});

describe("G8 binds contract-bound sessions only", () => {
	test("a session declaring no role writes its own bead histories", () => {
		// 13 of the 19 commands the regex flagged came from ordinary sessions working
		// their own beads. The comment grammar is the orchestrate protocol's, not bd's.
		expect(gateCommentVerb(ctxFor(), { command: `bd comments add chezmoi-6nu "NEW plugin landed"` })).toBeUndefined();
	});

	test("every declared role is bound", () => {
		for (const role of ["architect", "implementer", "reviewer", "researcher", "shepherd"]) {
			expect(gateCommentVerb(ctxFor(role), { command: `bd comment orc-1 "narrated"` })?.block).toBe(true);
		}
	});
});

describe("the verb table", () => {
	test("admits every verb the role contracts require", () => {
		// Refusing one of these would make the contract that demands it unsatisfiable.
		for (const verb of ["REPORTED", "FAILED", "BLOCKED", "REVIEW", "ADVICE", "LANDED", "BOUNCED", "IDLE"]) {
			expect(COMMENT_VERBS[verb]).toBe(true);
		}
	});

	test("admits every verb this extension writes itself", () => {
		// `src/supervision.ts`, `src/watchers.ts`, and `src/gates/exit.ts` write these, so
		// a worker mirroring one to a bead must not be refused for it.
		for (const verb of ["RECLAIM", "STALL", "WARN", "GOAL", "BOUNCE"]) {
			expect(COMMENT_VERBS[verb]).toBe(true);
		}
	});

	test("drops BRIEF, which nothing in this repository defines", () => {
		// The one verb the regex admitted with no use site anywhere. Recorded because it
		// is the single place the replaced rule's acceptance set narrowed.
		expect(COMMENT_VERBS.BRIEF).toBeUndefined();
		expect(verdict(`bd comment orc-1 "BRIEF the next worker"`)?.block).toBe(true);
	});

	test("contains the 11 protocol verbs", () => {
		expect(PROTOCOL_VERBS.length).toBe(11);
		for (const verb of PROTOCOL_VERBS) expect(COMMENT_VERBS[verb]).toBe(true);
	});
});
