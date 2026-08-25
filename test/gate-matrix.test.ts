/**
 * The gate matrix — both sides of it, driven through the real gate entry points.
 *
 * A gate that refuses nothing is decoration. A gate that refuses ordinary work is
 * worse than decoration: a worker that cannot run `git status` stops working, and the
 * run stalls behind it. So every row here is one of two claims — a forbidden action in
 * a shape an agent plausibly reaches for *after* a first refusal must be refused with a
 * reason that names the right thing, and legitimate work must come back exactly
 * `undefined`.
 *
 * Calls go through `gateChain`, which is `src/index.ts`'s dispatch order rather than a
 * single gate: an ordinary command has to survive all four gates, not just the one
 * under test, and a forbidden one must be refused by whichever gate owns it.
 *
 * Where the design fails open, that is what gets asserted, with the reason written
 * down. These gates are documented friction, not a security boundary: they fail closed
 * on a proven violation and open on anything they cannot resolve, because a false
 * refusal costs a stalled run while a missed one costs a guard. Rows marked FINDING
 * pin behaviour that the enumerated matrix wanted refused and no gate refuses.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolCallEventResult } from "@oh-my-pi/pi-coding-agent";
import type { BdBead } from "../src/bd";
import * as actualBd from "../src/bd";
import { forgetClaim, observedClaim, recordClaim } from "../src/claim-state";
import { gateBeadWriteFree } from "../src/gates/readonly";
import { gateWorktrunkOwnership } from "../src/gates/wt-guard";

/** Beads `bdShow` resolves, by id. A missing key models an unreadable bead. */
let beads: Record<string, BdBead>;
/** What `bd list --label orc-node --status in_progress` reports. */
let inFlight: BdBead[];
/** Ids the gates looked up, so "evaluated every bead id" can be asserted directly. */
let shown: string[];

// Built before `mock.module` runs, so the replacement namespace keeps the real pure
// helpers (`metadataString`) rather than losing them to the mock.
const original = { ...actualBd };
const mocked = {
	...original,
	bdShow: async (id: string) => {
		shown.push(id);
		return beads[id] ?? null;
	},
	bdList: async () => inFlight,
};

mock.module("../src/bd", () => mocked);

// Dynamic: a static import is hoisted above `mock.module`, so these gates would bind
// the real `bd` and shell out. G1 and G3 read neither, so they import statically.
const { gateClaimEligibility } = await import("../src/gates/claim");
const { GATED_WRITE_TOOLS, gateWorktreeScope } = await import("../src/gates/worktree");

// Restore, so a mock scoped to this file cannot leak into test/bd.test.ts.
afterAll(() => mock.module("../src/bd", () => original));

/** The bead this session claimed, routed to its own role, naming the owned tree. */
const BEAD = "orc-42";
/** A second bead of this session's own role, naming a *different* tree. */
const SECOND = "orc-43";
/** A second bead of this session's own role, naming the *same* tree. */
const SAME_TREE = "orc-44";
/** A bead routed to another role. */
const FOREIGN_BEAD = "orc-77";
const ACTOR = "orc-impl-1";

let root: string;
/** The tree the claimed bead names. */
let owned: string;
/** A tree no claimed bead names. */
let foreign: string;
let priorWorktreeDir: string | undefined;

/**
 * `ExtensionContext` as the gates consume it: a cwd and a system prompt.
 *
 * `null` rather than an omitted argument for the role-less case, because a default
 * parameter also fires on an explicit `undefined` and would silently hand back a
 * role-marked session.
 */
function ctxAt(cwd: string, role: string | null = "implementer"): ExtensionContext {
	const prompt = role === null ? "a helper with no contract" : `ORC-ROLE: ${role}`;
	return { cwd, getSystemPrompt: () => [prompt] } as unknown as ExtensionContext;
}

function api(toolNames: string[]): ExtensionAPI {
	const stub = { getAllTools: () => toolNames.map(name => ({ name, description: "" })) };
	return stub as unknown as ExtensionAPI;
}

/** A spawned worker: `yield` present, and the tools an implementer holds. */
const WORKER = api(["bash", "edit", "write", "read", "yield"]);

/**
 * The gates `src/index.ts` runs for one tool call, in its order: every refusal before
 * G1's revision, because a handler returns a single result and a refusal must win over
 * a revision of an input that will not run.
 *
 * G2 is handed the tool name and the input, because its containment check is on the path
 * an `edit` or `write` names and not only on the cwd the session sits in.
 */
async function gateChain(
	ctx: ExtensionContext,
	toolName: string,
	input: Record<string, unknown>,
): Promise<ToolCallEventResult | undefined> {
	if (toolName === "bash") {
		const ownership = gateWorktrunkOwnership(input);
		if (ownership) return ownership;
		const eligibility = await gateClaimEligibility(ctx, input);
		if (eligibility) return eligibility;
	}
	if (GATED_WRITE_TOOLS[toolName] === true) {
		const scope = await gateWorktreeScope(ctx, toolName, input);
		if (scope) return scope;
	}
	if (toolName === "bash") return gateBeadWriteFree(WORKER, ctx, input);
	return undefined;
}

/** One `bash` call from a worker sitting in its own worktree. */
function bash(command: string, ctx: ExtensionContext = ctxAt(owned)): Promise<ToolCallEventResult | undefined> {
	return gateChain(ctx, "bash", { command });
}

beforeAll(async () => {
	// realpath, because macOS resolves /var and /tmp through symlinks and G2 compares
	// resolved paths.
	root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "orc-matrix-")));
	owned = path.join(root, "owned");
	foreign = path.join(root, "foreign");
	await fs.mkdir(path.join(owned, "src"), { recursive: true });
	await fs.mkdir(path.join(foreign, "src"), { recursive: true });
	priorWorktreeDir = process.env.OMP_WORKTREE_DIR;
});

afterAll(async () => {
	if (priorWorktreeDir === undefined) delete process.env.OMP_WORKTREE_DIR;
	else process.env.OMP_WORKTREE_DIR = priorWorktreeDir;
	await fs.rm(root, { recursive: true, force: true });
});

beforeEach(() => {
	beads = {
		[BEAD]: { id: BEAD, labels: ["orc-node", "agent:implementer"], metadata: { worktree: owned } },
		[SECOND]: { id: SECOND, labels: ["orc-node", "agent:implementer"], metadata: { worktree: foreign } },
		[SAME_TREE]: { id: SAME_TREE, labels: ["orc-node", "agent:implementer"], metadata: { worktree: owned } },
		[FOREIGN_BEAD]: { id: FOREIGN_BEAD, labels: ["orc-node", "agent:reviewer"], metadata: { worktree: owned } },
	};
	inFlight = [];
	shown = [];
	// A base that does not exist, so OMP's isolation exemption cannot fire by accident.
	process.env.OMP_WORKTREE_DIR = path.join(root, "no-such-isolation-base");
	recordClaim({ actor: ACTOR, beadIds: [BEAD] });
});

afterEach(forgetClaim);

/**
 * Every shape of a forbidden checkout, beside the sanctioned route its refusal must
 * name. The wrappers are not exotic: an agent that has just been refused reaches for
 * `sh -c`, then `timeout`, then a subshell, and a gate that goes blind at the first
 * wrapper only teaches the agent to wrap.
 */
const FORBIDDEN_CHECKOUTS: [string, string, string][] = [
	["git worktree add", "git worktree add ../wt", "git worktree"],
	["git worktree remove", "git worktree remove ../wt", "git worktree"],
	["git worktree prune", "git worktree prune", "git worktree"],
	["git worktree list", "git worktree list", "git worktree"],
	["bare subcommand word", "git worktree", "git worktree"],
	["gh pr checkout", "gh pr checkout 42", "gh pr checkout"],
	["gh pr checkout with a flag", "gh pr checkout --branch mine 42", "gh pr checkout"],
	["sh -c", `sh -c "git worktree add /tmp/x"`, "git worktree"],
	["bash -lc", `bash -lc 'git worktree remove /tmp/x'`, "git worktree"],
	["zsh -c", `zsh -c "gh pr checkout 42"`, "gh pr checkout"],
	["nested sh -c behind timeout", `timeout 5 sh -c 'git worktree add x'`, "git worktree"],
	["timeout with a duration", "timeout 60 git worktree add /tmp/x", "git worktree"],
	["timeout with a kill delay", "timeout -k 2 5 git worktree prune", "git worktree"],
	["nohup, backgrounded", "nohup git worktree add /tmp/x &", "git worktree"],
	["time", "time git worktree list", "git worktree"],
	["exec", "exec git worktree add /tmp/x", "git worktree"],
	["stdbuf", "stdbuf -oL git worktree add /tmp/x", "git worktree"],
	["command", "command git worktree add /tmp/x", "git worktree"],
	["subshell", "( git worktree add /tmp/x )", "git worktree"],
	["brace group", "{ git worktree add /tmp/x; }", "git worktree"],
	["negation", "! git worktree add /tmp/x", "git worktree"],
	["eval", `eval 'git worktree add /tmp/x'`, "git worktree"],
	["git -C pin", "git -C /repo worktree add /tmp/x", "git worktree"],
	["git --git-dir= pin", "git --git-dir=/repo/.git worktree add x", "git worktree"],
	["git --no-pager", "git --no-pager worktree list", "git worktree"],
	["gh -R pin", "gh -R owner/repo pr checkout 42", "gh pr checkout"],
	["absolute git", "/usr/bin/git worktree add /tmp/x", "git worktree"],
	["absolute gh", "/opt/homebrew/bin/gh pr checkout 42", "gh pr checkout"],
	["env prefix", "GIT_DIR=/repo/.git git worktree add ../wt", "git worktree"],
	["env -i", "env -i git worktree add x", "git worktree"],
	["after a cd", "cd /repo && git worktree add ../wt", "git worktree"],
	["second in a chain", "echo hi; git worktree add x", "git worktree"],
	["fallback after a failure", "git worktree add x || gh pr checkout 42", "git worktree"],
];

describe("G3 refuses a checkout Worktrunk would not know about", () => {
	test.each(FORBIDDEN_CHECKOUTS)("refuses %s", async (_label, command, named) => {
		const result = await bash(command);

		expect(result?.block).toBe(true);
		// The refusal has to name what was refused and the sanctioned route, or the
		// agent's next move is another shape of the same command.
		expect(result?.reason).toContain(named);
		expect(result?.reason).toContain("wt switch");
	});
});

/**
 * Legitimate work, which must pass untouched. Read commands dominate because that is
 * what a worker spends its turns on: a gate that trips on `git log` is a broken run,
 * not a strict one.
 */
const LEGITIMATE: [string, string][] = [
	["git status", "git status"],
	["git status --porcelain", "git status --porcelain"],
	["git log", "git log --oneline -20"],
	["git diff", "git diff --stat"],
	["git add", "git add -A"],
	["git commit", `git commit -m "fix the thing"`],
	["git cherry", "git cherry -v main"],
	["git branch --list", "git branch --list"],
	["gh pr view", "gh pr view 42"],
	["gh pr view --json", "gh pr view --json files"],
	["gh pr checks", "gh pr checks 42"],
	["gh pr diff", "gh pr diff 42"],
	["gh run watch", "gh run watch 12345"],
	["bd show", "bd show orc-42 --json"],
	["bd list", "bd list --status open --json"],
	["bd ready without a claim", "bd ready --label agent:implementer --unassigned --json"],
	["bd ready --claim on this session's own queue", "bd ready --label agent:implementer --unassigned --claim --json"],
	["bun test", "bun test"],
	["bun test behind timeout", "timeout 60 bun test"],
	["an actor-prefixed mutation", `BEADS_ACTOR=${ACTOR} BD_ACTOR=${ACTOR} bd comment ${BEAD} "REPORTED done"`],
	["the sanctioned worktree route", "wt switch --create feat/x"],
];

/**
 * The false-positive shapes that matter most, because each is a *word* the gates
 * pattern on appearing somewhere it is not a command. A substring matcher fails every
 * one of these, which is the entire reason `src/shell.ts` tokenises.
 */
const LEGITIMATE_NEAR_MISSES: [string, string][] = [
	["git worktree quoted inside a bead comment", `bd comment ${BEAD} "never run git worktree add"`],
	["git worktree quoted inside a commit message", `git commit -m "stop using git worktree"`],
	["a wrapped command quoted inside a comment", `bd comment ${BEAD} "run sh -c 'git worktree add y'"`],
	["a bd claim quoted inside a commit message", `git commit -m "bd update ${BEAD} --claim"`],
	["a path whose basename is worktree", "bun test test/worktree.test.ts"],
	["a staged file named worktree.ts", "git add src/gates/worktree.ts"],
	["a pathspec naming worktree.ts", "git diff -- src/worktree.ts"],
	["a blob path containing worktree", "git show HEAD:src/worktree.ts"],
	// Both of these were refused before this file existed: any later bare token equal
	// to `worktree` satisfied the old in-order argv scan, so a grep pattern and an
	// unquoted commit message read as `git worktree`.
	["worktree as a grep pattern", "git log --grep worktree"],
	["worktree as an inline grep pattern", "git log --grep=worktree"],
	["worktree as an unquoted commit message", "git commit -m worktree"],
	["a command that merely prints it", "echo git worktree add"],
	["a different command that starts with the word", "git worktree-ish"],
];

describe("G3 leaves legitimate work alone", () => {
	test.each([...LEGITIMATE, ...LEGITIMATE_NEAR_MISSES])("allows %s", async (_label, command) => {
		expect(await bash(command)).toBeUndefined();
	});
});

describe("G3 shapes the parser does not reach", () => {
	test.each([
		["a runner word outside the transparent list", "nice -n 10 git worktree add x"],
		["another one", "ionice -c3 git worktree add x"],
		["privilege escalation as the runner", "sudo git worktree add x"],
		["argv arriving on stdin", "xargs git worktree add"],
		["a program named by substitution", "$(which git) worktree add x"],
		["a program named by a variable", "g=git; $g worktree add x"],
		["a payload piped into a shell", `printf '%s' "git worktree add x" | sh`],
		["a shell keyword before the command", "if true; then git worktree add x; fi"],
	])("does not refuse %s", async (_label, command) => {
		// FINDING, pinned rather than wished away. `TRANSPARENT_PREFIXES` covers the
		// runner words an honest command line uses (`timeout`, `nohup`, `exec`,
		// `stdbuf`, `time`, `command`), and `src/shell.ts` documents that dynamic
		// construction is out of reach by design: it names no program until a shell
		// runs, and this parser runs nothing. Widening the list to `nice`/`sudo`/`then`
		// is a judgement call about how much evasion to chase in a layer that is
		// documented as friction rather than a boundary, so it is reported, not taken.
		expect(await bash(command)).toBeUndefined();
	});
});

/** One claim, in every shape an agent reaches for after a refusal. */
function claimShapes(beadId: string): [string, string][] {
	const claim = `bd update ${beadId} --claim`;
	return [
		["bare, actor-prefixed", `BEADS_ACTOR=${ACTOR} ${claim}`],
		["behind env", `env BEADS_ACTOR=${ACTOR} ${claim}`],
		["sh -c", `sh -c "${claim}"`],
		["bash -lc", `bash -lc '${claim}'`],
		["zsh -c", `zsh -c "${claim}"`],
		["eval", `eval '${claim}'`],
		["subshell", `( ${claim} )`],
		["timeout with a duration", `timeout 30 ${claim}`],
		["timeout with a kill delay", `timeout -k 2 5 ${claim}`],
		["nohup, backgrounded", `nohup ${claim} &`],
		["time", `time ${claim}`],
		["exec", `exec ${claim}`],
		["stdbuf", `stdbuf -oL ${claim}`],
		["command", `command ${claim}`],
		["an absolute bd", `/opt/homebrew/bin/bd update ${beadId} --claim`],
		["a -C database pin", `bd -C /repo update ${beadId} --claim`],
		["second in a chain", `git status && ${claim}`],
		["piped into jq", `${claim} --json | jq .`],
	];
}

describe("G5 refuses a claim routed to another role", () => {
	test.each(claimShapes(FOREIGN_BEAD))("refuses it %s", async (_label, command) => {
		const result = await bash(command);

		expect(result?.block).toBe(true);
		expect(result?.reason).toContain(FOREIGN_BEAD);
		expect(result?.reason).toContain("agent:reviewer");
		expect(result?.reason).toContain("implementer");
		// A refused claim is not recorded: the session still holds only its own bead.
		expect(observedClaim()?.beadIds).toEqual([BEAD]);
	});

	test("refuses a ready --claim against another role's queue", async () => {
		const result = await bash("bd ready --label agent:reviewer --unassigned --claim --json");

		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("agent:reviewer");
		// The queue filter already pins the role, so no bead has to be read.
		expect(shown).toEqual([]);
	});
});

describe("G5 leaves a claim of this session's own bead alone", () => {
	test.each(claimShapes(BEAD))("allows it %s", async (_label, command) => {
		expect(await bash(command)).toBeUndefined();
	});
});

describe("G5 multi-bead claims", () => {
	test.each([
		["the foreign bead named second", `BEADS_ACTOR=${ACTOR} bd update ${BEAD} ${FOREIGN_BEAD} --claim`],
		["the foreign bead named first", `BEADS_ACTOR=${ACTOR} bd update ${FOREIGN_BEAD} ${BEAD} --claim`],
	])("refuses a multi-bead claim smuggling another role's bead, with %s", async (_label, command) => {
		// Every id is evaluated, not just the first, so position is no evasion.
		const result = await bash(command);

		expect(result?.block).toBe(true);
		expect(result?.reason).toContain(FOREIGN_BEAD);
	});

	test("G5 itself does not refuse two beads of this session's own role", async () => {
		// FINDING: G5 evaluates each named bead's routing and never the count, so the
		// one-bead-per-activation invariant is not a gate at all. It is the
		// `orc-one-claim` TTSR rule below, whose `tool-only` interrupt aborts the call
		// before the command runs.
		const command = `BEADS_ACTOR=${ACTOR} bd update ${BEAD} ${SAME_TREE} --claim`;

		expect(await gateClaimEligibility(ctxAt(owned), { command })).toBeUndefined();
		expect(shown).toEqual([BEAD, SAME_TREE]);
		expect(observedClaim()?.beadIds).toEqual([BEAD, SAME_TREE]);
	});

	test("two beads in one tree pass the whole chain", async () => {
		// The same finding at the surface an agent meets: when both beads name the tree
		// the session is sitting in, nothing downstream objects either.
		expect(await bash(`BEADS_ACTOR=${ACTOR} bd update ${BEAD} ${SAME_TREE} --claim`)).toBeUndefined();
	});

	test("two beads in two trees refuse the claiming command itself", async () => {
		// `bash` is a gated write tool, so G2 runs on the claim command too, against the
		// claim G5 has just recorded. A second tree therefore refuses the very call that
		// claimed it — and every mutation after it, in either tree, since the cwd must
		// sit inside *every* claimed bead's worktree.
		const result = await bash(`BEADS_ACTOR=${ACTOR} bd update ${BEAD} ${SECOND} --claim`);

		expect(result?.block).toBe(true);
		expect(result?.reason).toContain(SECOND);

		const inOwned = await gateChain(ctxAt(owned), "write", { path: path.join(owned, "src/api.ts"), content: "x" });
		const inForeign = await gateChain(ctxAt(foreign), "write", { path: path.join(foreign, "src/api.ts"), content: "x" });

		expect(inOwned?.block).toBe(true);
		expect(inOwned?.reason).toContain(SECOND);
		expect(inForeign?.block).toBe(true);
		expect(inForeign?.reason).toContain(BEAD);
	});
});

describe("G2 mutations against the claimed tree", () => {
	test.each([
		["a write inside the claimed tree", "write", () => path.join(owned, "src/api.ts")],
		["an edit inside the claimed tree", "edit", () => path.join(owned, "src/deep-enough.ts")],
	])("allows %s", async (_label, tool, target) => {
		expect(await gateChain(ctxAt(owned), tool, { path: target(), content: "x" })).toBeUndefined();
	});

	test("refuses a mutation issued from another tree, naming the bead", async () => {
		const result = await gateChain(ctxAt(foreign), "write", { path: path.join(foreign, "src/api.ts"), content: "x" });

		expect(result?.block).toBe(true);
		expect(result?.reason).toContain(BEAD);
		expect(result?.reason).toContain("metadata.worktree");
	});

	test.each<[string, string, () => Record<string, unknown>, string]>([
		["a parent-relative traversal", "write", () => ({ path: "../foreign/src/api.ts", content: "x" }), "metadata.worktree"],
		[
			"an absolute path into another tree",
			"write",
			() => ({ path: path.join(foreign, "src/api.ts"), content: "x" }),
			"metadata.worktree",
		],
		[
			"a path buried in a patch header",
			"edit",
			() => ({ input: `[${foreign}/src/api.ts#A1B2]\nPUT 1.=1:\n+x` }),
			"metadata.worktree",
		],
		["a sibling the bead's scope globs do not name", "write", () => ({ path: "src/other/api.ts", content: "x" }), "metadata.scope"],
	])("refuses %s", async (_label, tool, input, rule) => {
		// Closed, and this group is where it shows. G2 is no longer keyed on the cwd
		// alone: `src/index.ts` threads the tool input to it, `write` contributes its
		// `path` and `edit` every `[PATH#TAG]` header, and each target is resolved
		// through the filesystem before being compared against `metadata.worktree` and
		// then `metadata.scope`. The bead declares both, which is what the last row
		// needs — it never leaves the tree, so only the scope globs can refuse it.
		beads[BEAD] = { id: BEAD, labels: ["agent:implementer"], metadata: { worktree: owned, scope: ["src/api/**"] } };

		const result = await gateChain(ctxAt(owned), tool, input());

		expect(result?.block).toBe(true);
		expect(result?.reason).toContain(rule);
		expect(result?.reason).toContain(BEAD);
	});

	test("does not refuse a bash redirect out of the tree", async () => {
		// FINDING, and the one row of this group that stays permissive deliberately. A
		// shell command's write targets hide in redirections, heredocs, `tee`, and
		// anything a subshell expands. G2 reads a declared path only for `write` and
		// `edit`; `bash` keeps the cwd comparison every command inherits, plus G3's
		// refusal of any checkout the tree does not own. A redirect parser would refuse
		// honest commands more often than it caught this one.
		beads[BEAD] = { id: BEAD, labels: ["agent:implementer"], metadata: { worktree: owned, scope: ["src/api/**"] } };

		expect(await gateChain(ctxAt(owned), "bash", { command: "echo x > ../foreign/src/api.ts" })).toBeUndefined();
	});
});

describe("G1 refuses nothing", () => {
	test("a contract-bound role is left entirely alone", async () => {
		// Every `orc-*` role must write beads to satisfy its exit contract, and
		// `bd comment` is blocked under BD_READONLY, so sandboxing one would make its
		// contract unsatisfiable and bounce the worker.
		for (const role of ["architect", "implementer", "reviewer", "researcher", "shepherd"]) {
			expect(await bash(`BEADS_ACTOR=${ACTOR} bd comment ${BEAD} "REPORTED done"`, ctxAt(owned, role))).toBeUndefined();
		}
	});

	test("a contract-free helper is revised, never refused", async () => {
		const result = await bash("bd update orc-1 --status closed", ctxAt(owned, null));

		expect(result?.block).toBeUndefined();
		expect(result?.input?.env).toEqual({ BD_READONLY: "1" });
	});
});

/**
 * The one-bead-per-activation invariant, which lives in a TTSR rule rather than a gate.
 *
 * `orc-one-claim` declares `interruptMode: tool-only`, so a match aborts the tool call
 * before the command runs — that is where the refusal G5 does not issue comes from. The
 * host regex engine evaluates the condition, so it is asserted here with `RegExp`
 * against the raw command string, which is the text OMP matches for a `tool:bash`
 * scope. `scripts/validate-rules.sh` covers the same rules through `omp ttsr test`, but
 * it needs an installed `omp` and so cannot be part of this suite.
 */
function ruleCondition(file: string): RegExp {
	const body = readFileSync(path.join(import.meta.dir, "..", "rules", file), "utf8");
	const declared = /^condition: (".*")$/m.exec(body)?.[1];
	if (declared === undefined) throw new Error(`no condition in rules/${file}`);
	return new RegExp(JSON.parse(declared) as string);
}

describe("orc-one-claim, the rule that owns multi-bead claims", () => {
	const rule = ruleCondition("orc-one-claim.md");

	test.each([
		["bare", "bd update orc-1 orc-2 --claim"],
		["actor-prefixed", `BEADS_ACTOR=${ACTOR} bd update orc-1 orc-2 --claim`],
		["behind timeout", "timeout 30 bd update orc-1 orc-2 --claim"],
		["second in a chain", "git status && bd update orc-1 orc-2 --claim"],
		["three ids", "bd update orc-1 orc-2 orc-3 --claim"],
	])("fires on a multi-bead claim %s", (_label, command) => {
		expect(rule.test(command)).toBe(true);
	});

	test.each([
		["a single-bead claim", "bd update orc-1 --claim"],
		["an actor-prefixed single-bead claim", `BEADS_ACTOR=${ACTOR} bd update orc-1 --claim`],
		["a multi-id update that claims nothing", "bd update orc-1 orc-2 --status closed"],
		["a read of two beads", "bd show orc-1 orc-2 --json"],
	])("stays quiet on %s", (_label, command) => {
		expect(rule.test(command)).toBe(false);
	});

	test.each([
		["sh -c", `sh -c 'bd update orc-1 orc-2 --claim'`],
		["bash -lc", `bash -lc "bd update orc-1 orc-2 --claim"`],
		["eval", `eval 'bd update orc-1 orc-2 --claim'`],
		["an unspaced subshell", "(bd update orc-1 orc-2 --claim)"],
	])("fires on a multi-bead claim quoted inside a %s payload", (_label, command) => {
		// This row was the reverse assertion until the rule's leading class was widened
		// from `[\s;|&]` to `[\s;|&('"]`: a quote or an opening paren is now an accepted
		// left boundary, so the wrapped payloads a refused agent reaches for no longer
		// slip past the regex layer.
		expect(rule.test(command)).toBe(true);
	});

	test("does not fire when the bead ids arrive through a variable", () => {
		// FINDING, and the residue that no widening reaches: the condition needs two
		// literal `<name>-<digits>` ids after `bd update`, and `$ids` is neither. Nothing
		// refuses this command — the gate layer cannot see it either, because
		// `src/shell.ts` expands no variables by design and documents dynamic
		// construction as out of reach: the line names no bead until a shell runs it.
		expect(rule.test(`ids="orc-1 orc-2"; bd update $ids --claim`)).toBe(false);
	});
});

/**
 * The nag rule for identity, included for its false-positive side: it cannot refuse
 * anything (`interruptMode: never` folds a reminder into the tool result), so the cost
 * of a bad condition is a correct call being nagged every turn.
 */
describe("orc-bd-actor-prefix leaves a correct call alone", () => {
	const rule = ruleCondition("orc-bd-actor-prefix.md");

	test.each([
		["both identity vars set", `BEADS_ACTOR=${ACTOR} BD_ACTOR=${ACTOR} bd comment ${BEAD} "REPORTED done"`],
		["a read, which needs no prefix", "bd show orc-1 --json"],
		["a ready pull", "bd ready --label agent:implementer --unassigned --claim --json"],
	])("stays quiet on %s", (_label, command) => {
		expect(rule.test(command)).toBe(false);
	});

	test.each([
		["an unprefixed mutation", "bd update orc-1 --claim"],
		["an unrelated env prefix standing in for identity", "FOO=1 bd comment orc-1 REPORTED"],
	])("fires on %s", (_label, command) => {
		expect(rule.test(command)).toBe(true);
	});
});
