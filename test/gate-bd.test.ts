/** G6: bd notices and run-scoped delivery through the gate entry point. */

import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import * as actualBd from "../src/bd";
import { createClaimState, type ClaimState } from "../src/claim-state";
import {
	ACTOR_NOTICE_ARBITER,
	actorNotice,
	BD_NOTICE_MESSAGE,
	bugRouteNotice,
	commentVerbNotice,
	gateBdDiscipline,
} from "../src/gates/bd";
import { type BdInvocation, bdInvocations } from "../src/shell";

/** Reject a missing invocation instead of silently testing an empty parse. */
function only(command: string): BdInvocation {
	const invocations = bdInvocations(command);
	if (invocations.length !== 1) {
		throw new Error(`${command} parsed to ${invocations.length} invocations, not 1`);
	}
	return invocations[0] as BdInvocation;
}

/** Mutating subcommands require attribution; queue acquisition is exempt. */
const UNATTRIBUTED = [
	"bd update orc-1 --claim",
	"bd close orc-1",
	'bd comment orc-1 "REPORTED done"',
	'bd create "x" --type task',
	"bd label add orc-1 kind:design",
	"bd dep add orc-1 orc-2",
	"bd set-state orc-1 review",
	"bd gate resolve gate-1",
	"bd audit record --kind tool_call",
];

describe("the identity notice", () => {
	test.each(UNATTRIBUTED)("fires on %s", command => {
		expect(actorNotice(only(command))).toContain("WARN bd identity");
	});

	test("accepts both actor variables", () => {
		expect(actorNotice(only("BEADS_ACTOR=impl BD_ACTOR=impl bd update orc-1 --claim"))).toBeUndefined();
	});

	test.each([
		["BEADS_ACTOR alone", "BEADS_ACTOR=impl bd -C /run/repo update orc-1 --claim"],
		["BD_ACTOR alone", "BD_ACTOR=impl bd -C /run/repo update orc-1 --claim"],
		["the env form", "env BEADS_ACTOR=impl BD_ACTOR=impl bd -C /run/repo update orc-1 --claim"],
		["env with a valueless flag", "env -i BEADS_ACTOR=impl bd -C /run/repo close orc-1"],
	])("accepts %s", (_label, command) => {
		expect(actorNotice(only(command))).toBeUndefined();
	});

	test.each([
		["a show", "bd -C /run/repo show orc-1 --json"],
		["a list", "bd -C /run/repo list --status open"],
		["a blocked query", "bd -C /run/repo blocked --json"],
	])("leaves %s alone", (_label, command) => {
		expect(actorNotice(only(command))).toBeUndefined();
	});

	test.each([
		["an unrelated inline prefix", "FOO=1 bd -C /run/repo comment orc-1 REPORTED"],
		["an unrelated env prefix", "env FOO=1 bd -C /run/repo update orc-1 --claim"],
		["an empty assignment", "BEADS_ACTOR= bd -C /run/repo update orc-1 --claim"],
		["both empty", "BEADS_ACTOR= BD_ACTOR= bd -C /run/repo close orc-1"],
		// Deliberate: the dispatch contract mandates the environment prefix, and
		// `src/gates/claim.ts` reads the environment to record a claim for G2.
		["the --actor flag standing in for it", "bd -C /run/repo --actor impl update orc-1 --claim"],
	])("fires on %s", (_label, command) => {
		expect(actorNotice(only(command))).toContain("WARN bd identity");
	});

	test("the claiming queue pull is exempt, because it precedes the identity", () => {
		// A queue pull cannot read metadata.actor until it knows which bead it acquired.
		const pull = "bd -C /run/repo ready --label agent:implementer --unassigned --claim --json";
		expect(actorNotice(only(pull))).toBeUndefined();
		expect(actorNotice(only("bd -C /run/repo update orc-1 --claim"))).toContain("WARN bd identity");
	});

	test.each([
		// Unknown verbs require attribution; only recognized reads are exempt.
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
		["duplicates auto-merge", "bd duplicates --auto-merge"],
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
		["duplicates", "bd duplicates"],
		["duplicates dry run", "bd duplicates --auto-merge --dry-run"],
		// Store administration has no bead to attribute.
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

	test.each([
		["mol list", "bd mol list"],
		["mol help", "bd mol --help"],
		["mol show", "bd mol show mol-1"],
		["mol current", "bd mol current mol-1"],
		["mol progress", "bd mol progress mol-1"],
		["mol ready", "bd mol ready"],
		["mol stale", "bd mol stale"],
		["mol last-activity", "bd mol last-activity mol-1"],
		["mol seed", "bd mol seed formula"],
		["mol pour preview", "bd mol pour formula --dry-run"],
		["mol wisp preview", "bd mol wisp formula --dry-run"],
		["mol wisp list", "bd mol wisp list"],
		["mol wisp help", "bd mol wisp --help"],
		["formula list", "bd formula list"],
		["formula show", "bd formula show mol-review"],
		["epic status", "bd epic status epic-1"],
		["merge-slot check", "bd merge-slot check"],
		["swarm list", "bd swarm list"],
		["swarm status", "bd swarm status epic-1"],
		["swarm validate", "bd swarm validate epic-1"],
		["dep cycles", "bd dep cycles"],
		["dep list", "bd dep list orc-1"],
		["dep tree", "bd dep tree orc-1"],
		["dep help", "bd dep --help"],
		["label list", "bd label list orc-1"],
		["label list-all", "bd label list-all"],
		["kv get", "bd kv get somekey"],
		["kv list", "bd kv list"],
		["audit list", "bd audit list"],
		["audit help", "bd audit --help"],
		["gate discover", "bd gate discover --type gh:run"],
		["gate list", "bd gate list"],
		["gate show", "bd gate show gate-1"],
		["todo list", "bd todo list"],
		["comments list", "bd comments orc-1"],
	])("leaves grouped read %s alone", (_label, command) => {
		expect(actorNotice(only(command))).toBeUndefined();
	});

	test.each([
		["mol pour", "bd mol pour formula"],
		["bare mol wisp", "bd mol wisp"],
		["mol wisp proto", "bd mol wisp beads-release"],
		["mol wisp create", "bd mol wisp create formula"],
		["mol wisp gc", "bd mol wisp gc"],
		["formula convert", "bd formula convert formula.json"],
		["epic close-eligible", "bd epic close-eligible"],
		["merge-slot acquire", "bd merge-slot acquire"],
		["merge-slot create", "bd merge-slot create"],
		["merge-slot release", "bd merge-slot release"],
		["swarm create", "bd swarm create epic-1"],
		["dep --blocks", "bd dep orc-1 --blocks orc-2"],
		["dep remove", "bd dep remove orc-1 orc-2"],
		["label propagate", "bd label propagate orc-1 kind:design"],
		["kv clear", "bd kv clear key"],
		["audit label", "bd audit label event-1 keep"],
		["audit record", "bd audit record --kind tool_call"],
		["gate check", "bd gate check"],
		["todo done", "bd todo done todo-1"],
		["comments add", "bd comments add orc-1 REPORTED"],
		["unknown grouped action", "bd gate frobnicate"],
	])("fires on grouped write %s", (_label, command) => {
		expect(actorNotice(only(command))).toContain("WARN bd identity");
	});

	test("keeps claim help non-mutating", () => {
		expect(actorNotice(only("bd update orc-1 --claim --help"))).toBeUndefined();
	});

	test.each([
		["help after option terminator", "bd create -- --help"],
		["wisp dry-run after option terminator", "bd mol wisp beads-release -- --dry-run"],
		["pour dry-run after option terminator", "bd mol pour formula -- --dry-run"],
	])("does not treat positional %s as a control flag", (_label, command) => {
		expect(actorNotice(only(command))).toContain("WARN bd identity");
	});

	test.each([
		["separate long help", "bd update orc-1 --description --help"],
		["separate short help", "bd update orc-1 --notes -h"],
		["inline long help", "bd update orc-1 --description=--help"],
		["close reason", "bd close orc-1 --reason --help"],
		["audit kind", "bd audit record --kind --help"],
	])("does not treat %s option data as help", (_label, command) => {
		expect(actorNotice(only(command))).toContain("WARN bd identity");
	});

	test("keeps a genuine update help call non-mutating", () => {
		expect(actorNotice(only("bd update orc-1 --help"))).toBeUndefined();
	});

	test("keeps help after a valueless flag non-mutating", () => {
		expect(actorNotice(only("bd create x --ephemeral --help"))).toBeUndefined();
	});
	test("accepts an identity set through the bash call's own env", () => {
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
		'bd -C /run/repo comment orc-1 "NO_WORK"',
		// Decoration and case do not change the verb.
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
		// The body follows the bead id; a flag or redirection there is not prose.
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
		// Quoted command text is not an invocation.
		["a grep", "grep -n 'bd comment' src/bd.ts"],
		["a sentence", 'echo "run bd comment orc-1 with a REVIEW verb"'],
		["a heredoc line", "printf '%s' 'bd comment orc-1 finished it'"],
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
		// JSON metadata accepts separate and inline flag values.
		'bd -C /run/repo create "x" --type bug --parent orc-1 --metadata \'{"role":"implementer"}\' --silent',
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
		const command = 'bd -C /run/repo create "x" --type bug --parent orc-1 --metadata \'{"role":\' --silent';
		expect(bugRouteNotice(only(command))).toContain("WARN bug bead");
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
		JSON.stringify({ schema_version: 1, run_id: "orc-1" }),
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

afterEach(() => {
	Reflect.deleteProperty(globalThis, ACTOR_NOTICE_ARBITER);
});

async function rawGateInput(
	input: Record<string, unknown>,
	cwd: string = inRun,
	toolCallId: string = "tool-call",
	claims?: ClaimState,
): Promise<unknown> {
	sent = [];
	return gateBdDiscipline(pi, ctxAt(cwd), input, toolCallId, claims);
}

async function gateInput(
	input: Record<string, unknown>,
	cwd: string = inRun,
	toolCallId: string = "tool-call",
	claims?: ClaimState,
): Promise<Outcome> {
	const result = await rawGateInput(input, cwd, toolCallId, claims);
	const refusal = result !== undefined && typeof result === "object" ? result as Record<string, unknown> : undefined;
	return {
		block: refusal?.block === true ? String(refusal.reason) : undefined,
		notices: sent.flatMap(entry => String(entry.message.content).split("\n")),
	};
}

function gate(command: unknown, cwd: string = inRun): Promise<Outcome> {
	return gateInput({ command }, cwd);
}

const SILENT: Outcome = { block: undefined, notices: [] };

function installActorNoticeArbiter(): Set<string> {
	const handledToolCalls = new Set<string>();
	Reflect.set(globalThis, ACTOR_NOTICE_ARBITER, { handledToolCalls });
	return handledToolCalls;
}

/** One defect per notice, checked both inside and outside a run. */
const THREE_DEFECTS: [string, string, string][] = [
	["an unattributed mutation", "bd -C /run/repo update orc-1 --claim", "WARN bd identity"],
	[
		"a comment leading with a non-verb",
		'BEADS_ACTOR=impl BD_ACTOR=impl bd -C /run/repo comment orc-1 "finished it"',
		"WARN comment verb",
	],
	[
		"an unrouted bug bead",
		'BEADS_ACTOR=impl BD_ACTOR=impl bd -C /run/repo create "x" --type bug --silent',
		"WARN bug bead",
	],
];

/** Reproduction: plain creation outside a run must not be blocked or nagged. */
const PLAIN_CREATE = 'bd create "x"';

describe("G6 outside a run", () => {
	test.each(THREE_DEFECTS)("is silent on %s", async (_label, command) => {
		expect(await gate(command, outsideRun)).toEqual(SILENT);
	});

	test("is silent on the plain bd create the report named", async () => {
		expect(await gate(PLAIN_CREATE, outsideRun)).toEqual(SILENT);
	});

	test("is silent when the marker cannot be read at all", async () => {
		// `.catch(() => null)`: an unreadable marker is not a run. A cwd that does not
		// exist is the cheapest shape of that, and an isolated worker's cwd can vanish.
		expect(await gate("bd update orc-1 --claim", path.join(outsideRun, "no-such-dir"))).toEqual(SILENT);
	});
});

describe("G6 inside a run", () => {
	test.each(THREE_DEFECTS)("notifies, and refuses nothing, on %s", async (_label, command, prefix) => {
		const outcome = await gate(command);
		expect(outcome.block).toBeUndefined();
		expect(outcome.notices.filter(line => line.startsWith(prefix))).toHaveLength(1);
	});

	test("claims actor-notice delivery for the beads tool-result adapter", async () => {
		const handled = installActorNoticeArbiter();
		const outcome = await gateInput({ command: "bd close orc-1" }, inRun, "mutation-1");
		expect(outcome.notices.some(line => line.startsWith("WARN bd identity"))).toBe(true);
		expect(handled.has("mutation-1")).toBe(true);
	});

	test.each([
		["update --claim", "bd update orc-1 --claim"],
		["top-level claim", "bd claim orc-1"],
	])("leaves unattributed %s to the beads blocking gate", async (_label, command) => {
		const handled = installActorNoticeArbiter();
		const outcome = await gateInput({ command }, inRun, `claim-${_label}`);
		expect(outcome).toEqual(SILENT);
		expect(handled.has(`claim-${_label}`)).toBe(false);
	});

	test("reads a bare-id marker as a run", async () => {
		const outcome = await gate(PLAIN_CREATE, legacyMarker);
		expect(outcome.block).toBeUndefined();
		expect(outcome.notices).toHaveLength(1);
		expect(outcome.notices.some(line => line.startsWith("WARN bd identity"))).toBe(true);
	});

	test("judges each invocation of a chain on its own", async () => {
		// Attribution on one invocation must not silence a neighboring write.
		const outcome = await gate(
			'BEADS_ACTOR=impl BD_ACTOR=impl bd -C /run/repo comment orc-1 "REPORTED a" && bd update orc-2 --claim',
		);
		expect(outcome.notices.some(line => line.startsWith("WARN bd identity"))).toBe(true);
	});

	test.each([
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
		// Glued grouping punctuation must not hide the executable or its flags.
		expect((await gate(command)).notices.some(line => line.startsWith("WARN bd identity"))).toBe(true);
	});

	test("an env flag taking an operand remains outside parser coverage", async () => {
		// The parser does not know env flag arities and treats FOO as the executable.
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
		// Delivery must steer the current turn, not defer the notice until next turn.
		await gate('BEADS_ACTOR=impl BD_ACTOR=impl bd -C /run/repo comment orc-1 "finished it"');
		expect(sent.length).toBe(1);
		expect(sent[0]?.message.customType).toBe(BD_NOTICE_MESSAGE);
		expect(sent[0]?.message.attribution).toBe("user");
		expect(sent[0]?.message.display).toBe(true);
		expect(sent[0]?.options).toEqual({ deliverAs: "steer" });
	});

	test("rewrites a single claim with the target bead metadata actor", async () => {
		const show = spyOn(actualBd, "bdShow").mockResolvedValue({
			id: "orc-1",
			metadata: { actor: "metadata/actor" },
		});
		const handled = installActorNoticeArbiter();
		try {
			const result = await rawGateInput(
				{ command: "bd update orc-1 --claim" },
				inRun,
				"metadata-claim",
				createClaimState(),
			);
			expect(result).toEqual({ input: { command: "BEADS_ACTOR=metadata/actor BD_ACTOR=metadata/actor bd update orc-1 --claim" } });
			expect(sent).toEqual([]);
			expect(handled.has("metadata-claim")).toBe(true);
		} finally {
			show.mockRestore();
		}
	});

	test("rewrites later writes with the actor from an observed claim", async () => {
		const claims = createClaimState();
		claims.recordClaim({ actor: "worker actor", beadIds: ["orc-1"] });
		const result = await rawGateInput(
			{ command: "bd comments add orc-1 'REPORTED done'" },
			inRun,
			"observed-comment",
			claims,
		);
		expect(result).toEqual({ input: { command: "BEADS_ACTOR='worker actor' BD_ACTOR='worker actor' bd comments add orc-1 'REPORTED done'" } });
		expect(sent).toEqual([]);
	});

	test("keeps the warning for a compound command", async () => {
		const claims = createClaimState();
		claims.recordClaim({ actor: "worker-1", beadIds: ["orc-1"] });
		const result = await gate("cd dir && bd update orc-1");
		expect(result).toEqual({ block: undefined, notices: [expect.stringContaining("WARN bd identity")] });
	});

	test("does not rewrite a command that already carries BD_ACTOR", async () => {
		const result = await rawGateInput({ command: "BD_ACTOR=worker-1 bd update orc-1" });
		expect(result).toBeUndefined();
		expect(sent).toEqual([]);
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

/** Unreadable input must not throw from the tool-call handler and block the tool. */
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
