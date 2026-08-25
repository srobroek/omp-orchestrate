/**
 * G6 — bd call discipline, and the corpus the deleted TTSR rules leave behind.
 *
 * `rules/orc-bd-pin.md`, `rules/orc-bd-actor-prefix.md`, `rules/orc-comment-verbs.md` and
 * `rules/orc-bug-bead-routing.md` were these checks written as regexes over a command
 * string. Every case their corpus pinned is here: each row was added to catch a real
 * defect, and a row that survives the carrier change is the only proof the conversion lost
 * nothing. `scripts/validate-rules.sh` ran them through `omp ttsr test`, which needs an
 * installed `omp`, so this suite could never have held them before.
 *
 * The pin is not among the checks. It is retired outright -- this project runs a
 * per-project Dolt server, which resolves by host and port and travels with a copied
 * checkout -- so every pin spelling appears here only as a shape the surviving checks must
 * judge identically, which is what `atEveryPin` crosses them against.
 *
 * Two levels, for one reason. The three checks are pure predicates over a parsed
 * invocation, so the old fire/miss rows port onto them exactly. The entry point then owns
 * what a regex could not express at all: the run marker as the sole discriminator,
 * per-invocation judgement inside one line, dedup, and silence on input it cannot parse.
 *
 * Rows marked as migrated came from `test/actor.test.ts` and `test/comment-verb.test.ts`,
 * the two suites that arrived with the separate gates this consolidated one replaced. Each
 * was scored against 4,673 commands recovered from 587 local session transcripts, so they
 * carry corpus evidence this file would otherwise have lost.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
	actorNotice,
	BD_NOTICE_MESSAGE,
	bugRouteNotice,
	commentVerbNotice,
	gateBdDiscipline,
} from "../src/gates/bd";
import { type BdInvocation, bdInvocations } from "../src/shell";

/** The `repo_root` the marker carries. A path, not a directory that has to exist. */
const RUN_REPO = "/run/repo";

/** Every `-C` spelling a call may carry, plus the bare form. None is required any more. */
const PINS = ["", "-C /run/repo ", "--directory /run/repo ", "--directory=/run/repo "];

/**
 * The single invocation a one-command line parses to.
 *
 * Throws rather than asserting, so a row whose command the parser does not see at all
 * fails by name instead of silently checking an empty list.
 */
function only(command: string): BdInvocation {
	const invocations = bdInvocations(command);
	if (invocations.length !== 1) {
		throw new Error(`${command} parsed to ${invocations.length} invocations, not 1`);
	}
	return invocations[0] as BdInvocation;
}

/** Cross a corpus with every pin spelling, as `test/claim.test.ts` does. */
function atEveryPin(templates: readonly string[]): string[] {
	return PINS.flatMap(pin => templates.map(template => template.replace("bd ", `bd ${pin}`)));
}

/**
 * Every mutating subcommand, unattributed. `bd ready --claim` is deliberately absent --
 * see the FINDING row below.
 */
const UNATTRIBUTED = [
	"bd update orc-1 --claim",
	"bd close orc-1",
	'bd comment orc-1 "REPORTED done"',
	'bd create "x" --type task',
	"bd label add orc-1 kind:design",
	"bd dep add orc-1 orc-2",
	"bd set-state orc-1 review",
	"bd gate orc-1 --pass",
	"bd audit orc-1 --note x",
];

describe("the identity notice", () => {
	test.each(atEveryPin(UNATTRIBUTED))("fires on %s", command => {
		expect(actorNotice(only(command))).toContain("WARN bd identity");
	});

	test.each(atEveryPin(["BEADS_ACTOR=impl BD_ACTOR=impl bd update orc-1 --claim"]))(
		"stays quiet on %s",
		command => {
			expect(actorNotice(only(command))).toBeUndefined();
		},
	);

	test.each([
		// Either variable satisfies it, as the deleted condition's lookahead did.
		["BEADS_ACTOR alone", "BEADS_ACTOR=impl bd -C /run/repo update orc-1 --claim"],
		["BD_ACTOR alone", "BD_ACTOR=impl bd -C /run/repo update orc-1 --claim"],
		// `env KEY=V bd ...`, which the deleted regex could not see through at all: its
		// prefix group matched `\w+=\S+` runs and `env` is not one, so the whole
		// condition failed to anchor and the call went unjudged either way.
		["the env form", "env BEADS_ACTOR=impl BD_ACTOR=impl bd -C /run/repo update orc-1 --claim"],
		["env with a valueless flag", "env -i BEADS_ACTOR=impl bd -C /run/repo close orc-1"],
	])("accepts %s", (_label, command) => {
		expect(actorNotice(only(command))).toBeUndefined();
	});

	test.each([
		// Reads need no prefix, verbatim from the rule body.
		["a show", "bd -C /run/repo show orc-1 --json"],
		["a list", "bd -C /run/repo list --status open"],
		["a blocked query", "bd -C /run/repo blocked --json"],
	])("leaves %s alone", (_label, command) => {
		expect(actorNotice(only(command))).toBeUndefined();
	});

	test.each([
		// An unrelated assignment is not identity. The deleted regex agreed here.
		["an unrelated inline prefix", "FOO=1 bd -C /run/repo comment orc-1 REPORTED"],
		// New: the same shape behind `env`, which that regex was blind to.
		["an unrelated env prefix", "env FOO=1 bd -C /run/repo update orc-1 --claim"],
		// An assignment with an empty value is no identity. The regex required
		// `\w+=\S+` and so never matched this line at all.
		["an empty assignment", "BEADS_ACTOR= bd -C /run/repo update orc-1 --claim"],
		["both empty", "BEADS_ACTOR= BD_ACTOR= bd -C /run/repo close orc-1"],
		// Deliberate: the dispatch contract mandates the environment prefix, and
		// `src/gates/claim.ts` reads the environment to record a claim for G2.
		["the --actor flag standing in for it", "bd -C /run/repo --actor impl update orc-1 --claim"],
	])("fires on %s", (_label, command) => {
		expect(actorNotice(only(command))).toContain("WARN bd identity");
	});

	test("the claiming queue pull is exempt, because it precedes the identity", () => {
		// `bd ready --claim` writes, and is the one write left unattributed on purpose:
		// dispatch puts `metadata.actor` on the bead and the worker reads it back from
		// there, so a pull -- which names no bead -- cannot yet know the name it would
		// carry. Nagging it would nag the protocol's first command. A claim that names its
		// bead is not exempt: `bd show` yields `metadata.actor` before the claim.
		const pull = "bd -C /run/repo ready --label agent:implementer --unassigned --claim --json";
		expect(actorNotice(only(pull))).toBeUndefined();
		expect(actorNotice(only("bd -C /run/repo update orc-1 --claim"))).toContain("WARN bd identity");
	});

	test("names the subcommand and both variables it wants", () => {
		const notice = actorNotice(only("bd -C /run/repo close orc-1")) ?? "";

		expect(notice).toContain("bd close");
		expect(notice).toContain("BEADS_ACTOR");
		expect(notice).toContain("BD_ACTOR");
	});

	test.each([
		// Writes the deleted condition's ten-name list omitted, so it judged none of them.
		// The list itself was the defect: it drifts every time bd grows a verb, so an
		// unrecognised subcommand now counts as a write and what bd permits under
		// `BD_READONLY=1` is the exemption instead.
		["assign", "bd assign orc-7 someone"],
		["delete", "bd delete orc-7"],
		["reopen", "bd reopen orc-7"],
		["note", "bd note orc-7 'a note'"],
		["tag", "bd tag orc-7 blocked"],
		["link", "bd link orc-7 orc-8"],
		["priority", "bd priority orc-7 1"],
		["promote", "bd promote orc-wisp-1"],
		["an unrecognised subcommand", "bd frobnicate orc-7"],
		// A group that reads by default still carries writing actions, and those outrank
		// the exemption: `bd comments` prints, `bd comments add` writes.
		["gate create", "bd gate create g-1"],
		["kv set", "bd kv set k v"],
	])("fires on %s", (_label, command) => {
		expect(actorNotice(only(command))).toContain("WARN bd identity");
	});

	test.each([
		// Reads, by what bd itself allows under `BD_READONLY=1`.
		["a queue read", "bd ready --json"],
		["prime", "bd prime"],
		["gate list", "bd gate list"],
		["dep tree", "bd dep tree orc-7"],
		["label list", "bd label list orc-7"],
		["kv get", "bd kv get somekey"],
		// Store administration has no bead to attribute: `bd init` creates the store,
		// `bd dolt push` moves commits under the caller's git identity. Each was flagged
		// by an earlier revision of this check and cleared by scoring it against the corpus.
		["init", "bd init --quiet"],
		["setup", "bd setup codex --check"],
		["bootstrap", "bd bootstrap"],
		["dolt push", "bd dolt push"],
		["help", "bd help close"],
		["codex-hook", "bd codex-hook SessionStart"],
		// The tokeniser expands no redirections, so this presents `2>&1` where a
		// subcommand would be. The command prints help.
		["a redirection where a subcommand would be", "bd 2>&1 | head -20"],
	])("leaves %s alone", (_label, command) => {
		expect(actorNotice(only(command))).toBeUndefined();
	});

	test("accepts an identity set through the bash call's own env", () => {
		// `env` on the tool call reaches every command in it, so attribution set there is
		// as real as an inline assignment -- and it is the tool's documented way of
		// setting a variable, so nagging it would nag a compliant call.
		expect(actorNotice(only("bd close orc-1"), { BEADS_ACTOR: "impl" })).toBeUndefined();
		expect(actorNotice(only("bd close orc-1"), { BD_ACTOR: "impl" })).toBeUndefined();
	});

	test.each([
		["an empty value", { BEADS_ACTOR: "" }],
		["a value that is not a string", { BEADS_ACTOR: 7 }],
		["an unrelated variable", { FOO: "impl" }],
		["no env at all", undefined],
		// The parameter arrives unvalidated, so a caller that passes text where a map
		// belongs must read as no identity rather than throw inside a gate.
		["text where a map belongs", "BEADS_ACTOR=impl"],
	])("still fires on %s", (_label, env) => {
		expect(actorNotice(only("bd close orc-1"), env)).toContain("WARN bd identity");
	});
});

describe("the comment-verb notice", () => {
	test.each([
		'bd comment orc-1 "finished the thing"',
		'bd -C /run/repo comment orc-1 "finished the thing"',
		// Every pin spelling sits between `bd` and the subcommand, which is where both
		// deleted nag conditions went dead.
		'bd --directory /run/repo comment orc-1 "finished the thing"',
		// `NO WORK` parses to `NO`, a non-verb. The underscored spelling is the verb.
		'BEADS_ACTOR=impl bd --directory=/run/repo comment orc-1 "NO WORK"',
		'bd -C /run/repo comment orc-1 "NO WORKTREE was created"',
		// A verb later in the sentence is prose.
		'bd -C /run/repo comment orc-1 "the REVIEW is done"',
		'bd -C /run/repo comment orc-1 "REVIEWED the branch"',
	])("fires on %s", command => {
		expect(commentVerbNotice(only(command))).toContain("WARN comment verb");
	});

	test.each([
		'bd comment orc-1 "REPORTED finished the thing"',
		'bd -C /run/repo comment orc-1 "REPORTED finished the thing"',
		'bd --directory /run/repo comment orc-1 "REPORTED finished the thing"',
		'bd -C /run/repo comment orc-1 "NO_WORK"',
		// Decoration is normalised and case is free: every one of these parses to
		// REVIEW, and every one of them reached supervision as a non-verb before
		// `commentVerb` existed.
		'bd -C /run/repo comment orc-1 "**REVIEW** approved"',
		'bd -C /run/repo comment orc-1 "- REVIEW approved"',
		'bd -C /run/repo comment orc-1 "`REVIEW` approved"',
		'bd -C /run/repo comment orc-1 "REVIEW, approved"',
		'bd -C /run/repo comment orc-1 "> REVIEW approved"',
		'bd -C /run/repo comment orc-1 "_REVIEW_ approved"',
		'bd -C /run/repo comment orc-1 "~~REVIEW~~ approved"',
		'bd -C /run/repo comment orc-1 "review approved"',
		'bd -C /run/repo comment orc-1 "> - **REPORTED**: orc-1 pushed"',
		'bd -C /run/repo comment orc-1 "   BLOCKED   kind:design"',
	])("stays quiet on %s", command => {
		expect(commentVerbNotice(only(command))).toBeUndefined();
	});

	test("reads the documented long form the same way", () => {
		// `bd comment` is bd's own shorthand for `bd comments add`. A guard a documented
		// alias walks past is decoration.
		const bad = 'bd -C /run/repo comments add orc-1 "finished the thing"';
		const good = 'bd -C /run/repo comments add orc-1 "REPORTED finished the thing"';
		expect(commentVerbNotice(only(bad))).toContain("WARN comment verb");
		expect(commentVerbNotice(only(good))).toBeUndefined();
	});

	test.each([
		// The body is in a file this check does not open, so there is no first token on
		// the line to judge.
		["--file", "bd -C /run/repo comment orc-1 --file body.md"],
		["--stdin", "bd -C /run/repo comment orc-1 --stdin"],
		// A body the shell has yet to assemble names no verb until it runs.
		["an unexpanded variable", 'bd -C /run/repo comment orc-1 "$MSG"'],
		["a substitution", 'bd -C /run/repo comment orc-1 "$(cat body.md)"'],
		// No body on the line at all.
		["a bare id", "bd -C /run/repo comment orc-1"],
	])("declines to judge %s", (_label, command) => {
		expect(commentVerbNotice(only(command))).toBeUndefined();
	});

	test.each([
		// Verbatim corpus shapes. bd 1.1.2 takes the body positionally on both spellings,
		// so the body is the token straight after the bead id -- and a flag or a
		// redirection there means the body is not on this line. A first-token-after-the-id
		// read is what tells `bd comment list <id>`, a read, from a comment on it.
		["a read whose next token is a redirection", "bd comment list orc-chaos-c3-05k.1 2>&1 | sed -n 1,30p"],
		["-f, the short file flag", "bd comments add orc-1 -f /tmp/body.txt"],
		// bd has no such flags, so the command fails at bd rather than here -- but the
		// flag still holds the position a body would.
		["flags bd does not have", 'bd comment orc-1 --type REPORTED --message "delivered"'],
		["--stdin ahead of a heredoc", "bd comment orc-1 --stdin <<EOF"],
		// A backticked run is a substitution the shell resolves before bd sees it, so it
		// names no verb yet. `commentVerb` strips a leading tick as markdown, which is why
		// the whole-body shape is what excuses this and `` `REVIEW` approved `` is judged.
		["a backticked body", 'bd comment orc-1 "`summarise`"'],
	])("declines to judge %s", (_label, command) => {
		expect(commentVerbNotice(only(command))).toBeUndefined();
	});

	test.each([
		// A bulleted body is a body, so the flag test is a flag shape and not a leading
		// `-`: `commentVerb` normalises the bullet and the verb underneath it is judged.
		["a bulleted non-verb", 'bd -C /run/repo comment orc-1 "- REVIEWED the branch"'],
		// An expansion later in a readable body does not excuse the word it opens with.
		["narration carrying an expansion", 'bd -C /run/repo comment orc-1 "Wired $X into $Y"'],
		// The long form is what every real violation in the corpus used, and the deleted
		// condition required `comment` immediately after `bd`, so it caught none of them.
		["a corpus violation opening with NEW", 'bd comments add chezmoi-6nu "NEW plugin landed"'],
		["a corpus violation opening with ADOPT", 'bd comments add chezmoi-gk3 "ADOPT both"'],
		["a corpus violation opening with Resolved:", 'bd comments add chezmoi-42o "Resolved: the role takes the other branch"'],
		["a corpus violation opening with DESIGN", 'bd comments add chezmoi-lpp "DESIGN RATIONALE: standalone plugin"'],
	])("fires on %s", (_label, command) => {
		expect(commentVerbNotice(only(command))).toContain("WARN comment verb");
	});

	test("fires on an empty body, which names no verb either", () => {
		expect(commentVerbNotice(only('bd -C /run/repo comment orc-1 ""'))).toContain("WARN comment verb");
	});

	test.each([
		// The deleted condition ran from `comment` to any later quote, so a grep for the
		// literal text nagged every turn. The parser sees no `bd` program here at all.
		["a grep", "grep -n 'bd comment' src/bd.ts"],
		["a sentence", 'echo "run bd comment orc-1 with a REVIEW verb"'],
		["a heredoc line", "printf '%s' 'bd comment orc-1 finished it'"],
		// Recovered verbatim from local transcripts, where the deleted conditions flagged
		// every one of them: a quoted `|` or `;` supplied the separator they matched on,
		// and six of the nineteen hits were scripts *writing this rule set*, whose own
		// condition text carried the `bd comment` the pattern was looking for.
		[
			"an alternation inside a grep",
			`cd /tmp/psc-verify && echo "=== beads run record in recipes:"; grep -rl 'orchestration/audit\\|bd create\\|beads' recipes/ --include='*.yml' 2>/dev/null | head -8`,
		],
		["a regex table in source", `const conds = { gateclose: [/\\bbd\\s+close\\b[^\\n]*gate/i] };`],
		["a case list in source", `const cases = { yes: ["bd close bd-x --reason done", "cd /repo && bd close bd-a"] };`],
		["a heredoc writing a pattern", `cd /tmp && cat > rx.mjs <<'EOF'\nconst specid = /\\bbd\\s+create\\b/;\nEOF`],
		["an alternation passed to rg", `rg 'bd update|bd close' docs/`],
	])("sees no invocation in %s, so nothing is judged", (_label, command) => {
		expect(bdInvocations(command)).toEqual([]);
	});
});

describe("the bug-route notice", () => {
	test.each([
		'bd create "x" --type bug --silent',
		'bd create "x" --type bug --parent orc-1 --silent',
		'bd create "x" --type bug --labels agent:implementer --silent',
		'bd -C /run/repo create "x" --type bug --metadata role=implementer --silent',
		'bd -C /run/repo create "x" --type bug --parent orc-1 --silent',
		// A different metadata key is not a route: `role` is compared exactly, never
		// matched as text.
		'bd -C /run/repo create "x" --type bug --parent orc-1 --metadata role_hint=implementer --silent',
		'bd -C /run/repo create "x" --type bug --parent orc-1 --metadata \'{"role_hint":"implementer"}\' --silent',
		// An empty role routes nowhere.
		'bd -C /run/repo create "x" --type bug --parent orc-1 --metadata role= --silent',
		// `--parent --silent` names no parent.
		'bd -C /run/repo create "x" --type bug --parent --metadata role=implementer --silent',
	])("fires on %s", command => {
		expect(bugRouteNotice(only(command))).toContain("WARN bug bead");
	});

	test.each([
		// A legacy `agent:<role>` label still routes while in-flight runs drain, so both
		// spellings satisfy it and neither may be the only one that does.
		'bd -C /repo create "x" --type bug --parent orc-1 --labels agent:implementer,kind:incidental --silent',
		'bd -C /run/repo create "x" --type bug --parent orc-1 --metadata role=implementer --silent',
		'bd -C /run/repo create "x" --type bug --parent orc-1 --metadata=role=implementer --silent',
		// The JSON payload, with and without a space after the colon.
		'bd -C /run/repo create "x" --type bug --parent orc-1 --metadata \'{"role":"implementer"}\' --silent',
		'bd -C /run/repo create "x" --type bug --parent orc-1 --metadata \'{"role": "implementer"}\' --silent',
		'bd -C /run/repo create "x" --type bug --parent orc-1 --metadata=\'{"role":"implementer"}\' --silent',
		// The short spellings of both flags.
		'bd -C /run/repo create "x" -t bug --parent orc-1 -l agent:implementer --silent',
		// A route riding a second repeat of a repeatable flag.
		'bd -C /run/repo create "x" --type bug --parent orc-1 --labels kind:incidental --labels agent:reviewer --silent',
	])("stays quiet on %s", command => {
		expect(bugRouteNotice(only(command))).toBeUndefined();
	});

	test.each([
		// Ordinary node and epic creation must stay silent: this is a bug-bead rule.
		'bd create "an epic" --type epic --silent',
		'bd create "a task" --type task --labels agent:implementer --silent',
		'bd -C /run/repo create "a task" --type task --silent',
		// Not a create at all.
		"bd -C /run/repo update orc-1 --status closed",
	])("does not judge %s", command => {
		expect(bugRouteNotice(only(command))).toBeUndefined();
	});

	test("declines to judge a payload held in a file", () => {
		// `--metadata @route.json` puts the route in a file this check does not open, and
		// guessing there would nag a bead that is routed.
		const command = 'bd -C /run/repo create "x" --type bug --metadata @route.json --silent';
		expect(bugRouteNotice(only(command))).toBeUndefined();
	});

	test("treats an unparseable payload as no route", () => {
		// `bd` rejects it too, so the notice names a defect the agent was about to hit
		// anyway rather than inventing one.
		const command = 'bd -C /run/repo create "x" --type bug --parent orc-1 --metadata \'{"role":\' --silent';
		expect(bugRouteNotice(only(command))).toContain("WARN bug bead");
	});

	test("names both missing flags when both are missing", () => {
		const notice = bugRouteNotice(only('bd -C /run/repo create "x" --type bug --silent'));
		expect(notice).toContain("--parent <epic>");
		expect(notice).toContain('--metadata \'{"role":"<role>"}\'');
	});
});

/** A `bash` call as the entry point judged it. */
interface Outcome {
	/** The refusal reason, or `undefined` when nothing was refused. */
	block: string | undefined;
	/** Every line of every notice the gate sent. */
	notices: string[];
}

let sent: { message: Record<string, unknown>; options: Record<string, unknown> }[] = [];

/** `ExtensionAPI` as this gate consumes it: one channel, recorded rather than delivered. */
const pi = {
	sendMessage: (message: Record<string, unknown>, options: Record<string, unknown>) => {
		sent.push({ message, options });
	},
} as unknown as ExtensionAPI;

/** The temporary tree holding all three. */
let root: string;
/** A run this repository is under. */
let inRun: string;
/** A repository with no marker, which is every other session. */
let outsideRun: string;
/** A marker written as a bare run id, as early runs wrote it. */
let legacyMarker: string;
let priorMarkerFile: string | undefined;

function ctxAt(cwd: string): ExtensionContext {
	return { cwd, getSystemPrompt: () => [] } as unknown as ExtensionContext;
}

async function marked(root: string, body: string): Promise<string> {
	await fs.mkdir(path.join(root, ".orchestration"), { recursive: true });
	await fs.writeFile(path.join(root, ".orchestration", ".active-run"), body);
	return root;
}

beforeAll(async () => {
	root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "orc-gate-bd-")));
	inRun = await marked(
		path.join(root, "in-run"),
		JSON.stringify({ schema_version: 1, run_id: "orc-1", repo_root: RUN_REPO }),
	);
	legacyMarker = await marked(path.join(root, "legacy"), "orc-1");
	outsideRun = path.join(root, "outside-run");
	await fs.mkdir(outsideRun, { recursive: true });
	// The override wins outright over the default path, so an exported value in the
	// ambient environment would point every case at one file.
	priorMarkerFile = process.env.ORCHESTRATE_MARKER_FILE;
	delete process.env.ORCHESTRATE_MARKER_FILE;
});

afterAll(async () => {
	if (priorMarkerFile !== undefined) process.env.ORCHESTRATE_MARKER_FILE = priorMarkerFile;
	await fs.rm(root, { recursive: true, force: true });
});

async function gateInput(input: Record<string, unknown>, cwd: string = inRun): Promise<Outcome> {
	sent = [];
	const result = await gateBdDiscipline(pi, ctxAt(cwd), input);
	return {
		block: result?.block === true ? result.reason : undefined,
		notices: sent.flatMap(entry => String(entry.message.content).split("\n")),
	};
}

function gate(command: unknown, cwd: string = inRun): Promise<Outcome> {
	return gateInput({ command }, cwd);
}

const SILENT: Outcome = { block: undefined, notices: [] };

/** One command per check, each a defect the corresponding rule existed to catch. */
const THREE_DEFECTS: [string, string][] = [
	["an unattributed mutation", "bd -C /run/repo update orc-1 --claim"],
	[
		"a comment leading with a non-verb",
		'BEADS_ACTOR=impl BD_ACTOR=impl bd -C /run/repo comment orc-1 "finished it"',
	],
	[
		"an unrouted bug bead",
		'BEADS_ACTOR=impl BD_ACTOR=impl bd -C /run/repo create "x" --type bug --silent',
	],
];

/**
 * The defect the conversion exists to fix, and the case no rule condition could express.
 *
 * A regex cannot see run context, so `orc-bd-pin` blocked a plain session in this
 * repository that merely mentioned `bd` -- measured, in a scratch checkout with no marker.
 * The marker read is the whole discriminator, and it gates the notices too.
 */
describe("G6 outside a run", () => {
	test.each(THREE_DEFECTS)("is silent on %s", async (_label, command) => {
		expect(await gate(command, outsideRun)).toEqual(SILENT);
	});

	test("is silent when the marker cannot be read at all", async () => {
		// `.catch(() => null)`: an unreadable marker is not a run. A cwd that does not
		// exist is the cheapest shape of that, and an isolated worker's cwd can vanish.
		expect(await gate("bd update orc-1 --claim", path.join(outsideRun, "no-such-dir"))).toEqual(SILENT);
	});
});

describe("G6 inside a run", () => {
	test.each(THREE_DEFECTS)("speaks on %s", async (_label, command) => {
		const outcome = await gate(command);
		expect(outcome.block !== undefined || outcome.notices.length > 0).toBe(true);
	});

	test("judges each invocation of a chain on its own", async () => {
		// Per-invocation reach, which the deleted line-scoped condition could not do: an
		// attributed call beside an unattributed one does not silence the notice.
		const outcome = await gate(
			'BEADS_ACTOR=impl BD_ACTOR=impl bd -C /run/repo comment orc-1 "REPORTED a" && bd update orc-2 --claim',
		);
		expect(outcome.notices.some(line => line.startsWith("WARN bd identity"))).toBe(true);
	});

	test.each([
		// A spaced subshell and a wrapper shell are ordinary command-line choices, and
		// the parser follows both.
		["a spaced subshell", '( bd comment orc-1 "REPORTED done" )'],
		["a subshell after a cd", '(cd /repo && bd comment orc-1 "REPORTED done")'],
		["sh -c", "sh -c 'bd update orc-1 --claim'"],
		["a timeout prefix", "timeout 30 bd update orc-1 --claim"],
		["eval", "eval 'bd update orc-1 --claim'"],
	])("sees an unattributed mutation inside %s", async (_label, command) => {
		expect((await gate(command)).notices.some(line => line.startsWith("WARN bd identity"))).toBe(true);
	});

	test.each([
		["an unspaced subshell", "(bd update orc-1 --claim)"],
		["a nested unspaced subshell", "((bd update orc-1 --claim))"],
		["an unspaced brace group", "{bd update orc-1 --claim;}"],
	])("sees an unattributed mutation inside %s", async (_label, command) => {
		// Was a FINDING: `(bd` tokenises as one word, so `basename` never read `bd` and
		// the parser saw nothing. Closed in `src/shell.ts` by stripping a leading run of
		// `(` and `{` from the head token; this pins that the gate still sees through it.
		expect((await gate(command)).notices.some(line => line.startsWith("WARN bd identity"))).toBe(true);
	});

	test("FINDING: an env flag taking an operand hides the call too", async () => {
		// `env -u FOO bd ...` stops the prefix scan on `FOO`: the parser skips the flag,
		// then reads its operand as the program. Same residue, same owner -- the prefix
		// loop in `parseBdInvocation` knows no flag arities. Neither is an evasion story:
		// these gates are documented friction, not a boundary.
		expect(bdInvocations("env -u FOO bd update orc-1 --claim")).toEqual([]);
		expect(await gate("env -u FOO bd update orc-1 --claim")).toEqual(SILENT);
	});


	test("says one thing once when a chain repeats the same defect", async () => {
		const outcome = await gate(
			'bd -C /run/repo comment orc-1 "REPORTED a" && bd -C /run/repo comment orc-2 "REPORTED b" ' +
				'&& bd -C /run/repo comment orc-3 "REPORTED c"',
		);
		expect(sent.length).toBe(1);
		expect(outcome.notices.length).toBe(1);
		expect(outcome.notices[0]).toContain("WARN bd identity");
	});

	test("keeps distinct findings distinct, in one message", async () => {
		// Dedup is on the sentence, not on a count: three subcommands name themselves
		// differently and each has something of its own to say.
		const outcome = await gate(
			"bd -C /run/repo update orc-1 --status open && bd -C /run/repo close orc-2 " +
				"&& bd -C /run/repo label add orc-3 kind:design",
		);
		expect(sent.length).toBe(1);
		expect(outcome.notices.length).toBe(3);
	});

	test("collects every check that fires on one call", async () => {
		const outcome = await gate('bd -C /run/repo create "x" --type bug --silent');
		expect(outcome.notices.some(line => line.startsWith("WARN bd identity"))).toBe(true);
		expect(outcome.notices.some(line => line.startsWith("WARN bug bead"))).toBe(true);
	});

	test("delivers a notice as a steer, in the extension's voice", async () => {
		// A steer is consumed at the next model call in the SAME turn -- the request
		// carrying this tool's result -- which is where the deleted rule put its own
		// non-interrupting reminder. `nextTurn` would hold it for a turn a worker about
		// to yield may never take.
		await gate('BEADS_ACTOR=impl BD_ACTOR=impl bd -C /run/repo comment orc-1 "finished it"');
		expect(sent.length).toBe(1);
		expect(sent[0]?.message.customType).toBe(BD_NOTICE_MESSAGE);
		expect(sent[0]?.message.attribution).toBe("user");
		expect(sent[0]?.message.display).toBe(true);
		expect(sent[0]?.options).toEqual({ deliverAs: "steer" });
	});

	test.each([
		"git status",
		"echo 'bd update orc-1 --claim'",
		"grep -rn 'bd comment' src",
		'BEADS_ACTOR=impl BD_ACTOR=impl bd -C /run/repo comment orc-1 "REPORTED done"',
		"bd -C /run/repo show orc-1 --json",
		"bd version",
	])("leaves %s entirely alone", async command => {
		expect(await gate(command)).toEqual(SILENT);
	});
});

/**
 * A throwing `tool_call` handler blocks the tool it was inspecting
 * (`src/index.ts:49-52`), so a shape this gate does not understand has to come back as
 * `undefined` rather than as an exception.
 */
describe("G6 on input it cannot read", () => {
	test.each([
		["no command key", {}],
		["a number", { command: 42 }],
		["null", { command: null }],
		["undefined", { command: undefined }],
		["an empty string", { command: "" }],
		["an argv array", { command: ["bd", "update", "orc-1", "--claim"] }],
		["an object that stringifies", { command: { toString: () => "bd update orc-1 --claim" } }],
	])("returns undefined on %s", async (_label, input) => {
		expect(await gateInput(input as Record<string, unknown>)).toEqual(SILENT);
	});

	test.each([
		// The tokeniser discards a partial token rather than inventing one, so the line
		// still parses -- to an invocation with no body to judge.
		["an unterminated quote", 'BEADS_ACTOR=i BD_ACTOR=i bd -C /run/repo comment orc-1 "unterminated'],
		["a lone program", "bd"],
		["a lone program with flags", "bd --json"],
	])("stays silent on %s", async (_label, command) => {
		expect(await gate(command)).toEqual(SILENT);
	});
});
