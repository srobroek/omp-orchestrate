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

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolCallEventResult } from "@oh-my-pi/pi-coding-agent";
import type { BdBead } from "../src/bd";
import * as actualBd from "../src/bd";
import { forgetClaim, observedClaim, recordClaim } from "../src/claim-state";
import { gateClaimEligibility } from "../src/gates/claim";
import { gateOneClaim } from "../src/gates/one-claim";
import { beadWriteFreeEnv, reviseBashEnv } from "../src/gates/readonly";
import { GATED_WRITE_TOOLS, gateWorktreeScope } from "../src/gates/worktree";
import { gateWorktrunkOwnership } from "../src/gates/wt-guard";

/** Beads `bdShow` resolves, by id. A missing key models an unreadable bead. */
let beads: Record<string, BdBead>;
/** What `bd list --label orc-node --status in_progress` reports. */
let inFlight: BdBead[];
/** Ids the gates looked up, so "evaluated every bead id" can be asserted directly. */
let shown: string[];

// Restore the original exports rather than installing another process-wide module
// mock: later suites (notably watchers) must reach the real bd subprocess.
const showSpy = spyOn(actualBd, "bdShow").mockImplementation(async (id: string) => {
 shown.push(id);
 return beads[id] ?? null;
});
const listSpy = spyOn(actualBd, "bdList").mockImplementation(async () => inFlight);

afterAll(() => {
 showSpy.mockRestore();
 listSpy.mockRestore();
});

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
 * G6 is the one check left out: it raises notices rather than refusals, so it changes no
 * row here, and `test/gate-bd.test.ts` drives it against the corpus shapes it exists for.
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
  const exclusivity = gateOneClaim(ctx, input);
  if (exclusivity) return exclusivity;
  const eligibility = await gateClaimEligibility(ctx, input);
  if (eligibility) return eligibility;
 }
 if (GATED_WRITE_TOOLS[toolName] === true) {
  const scope = await gateWorktreeScope(ctx, toolName, input);
  if (scope) return scope;
 }
 // Mirrors `index.ts`: the environment gate contributes to one revision.
 if (toolName === "bash") {
  return reviseBashEnv(input, { ...beadWriteFreeEnv(WORKER, ctx) });
 }
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
 ["gh pr checkout", "gh pr checkout 42", "gh pr checkout"],
 ["gh pr checkout with a flag", "gh pr checkout --branch mine 42", "gh pr checkout"],
 ["sh -c", `sh -c "git worktree add /tmp/x"`, "git worktree"],
 ["bash -lc", `bash -lc 'git worktree remove /tmp/x'`, "git worktree"],
 ["zsh -c", `zsh -c "gh pr checkout 42"`, "gh pr checkout"],
 ["nested sh -c behind timeout", `timeout 5 sh -c 'git worktree add x'`, "git worktree"],
 ["timeout with a duration", "timeout 60 git worktree add /tmp/x", "git worktree"],
 ["timeout with a kill delay", "timeout -k 2 5 git worktree prune", "git worktree"],
 ["nohup, backgrounded", "nohup git worktree add /tmp/x &", "git worktree"],
 ["exec", "exec git worktree add /tmp/x", "git worktree"],
 ["stdbuf", "stdbuf -oL git worktree add /tmp/x", "git worktree"],
 ["command", "command git worktree add /tmp/x", "git worktree"],
 ["subshell", "( git worktree add /tmp/x )", "git worktree"],
 ["brace group", "{ git worktree add /tmp/x; }", "git worktree"],
 ["negation", "! git worktree add /tmp/x", "git worktree"],
 ["eval", `eval 'git worktree add /tmp/x'`, "git worktree"],
 ["git -C pin", "git -C /repo worktree add /tmp/x", "git worktree"],
 ["git --git-dir= pin", "git --git-dir=/repo/.git worktree add x", "git worktree"],
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
 ["git worktree list", "git worktree list"],
 ["git worktree help", "git worktree"],
 ["timed worktree inspection", "time git worktree list"],
 ["worktree inspection without pager", "git --no-pager worktree list"],
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

/** Direct and wrapped claims exercise eligibility through the full gate chain. */
function claimShapes(beadId: string): [string, string][] {
 const claim = `bd update ${beadId} --claim`;
 return [
  ["bare, actor-prefixed", `BEADS_ACTOR=${ACTOR} ${claim}`],
  ["bash -lc", `bash -lc '${claim}'`],
 ];
}

describe("G5 refuses a claim routed to another role", () => {
 beforeEach(forgetClaim);
 test.each(claimShapes(FOREIGN_BEAD))("refuses it %s", async (_label, command) => {
  const result = await bash(command);

  expect(result?.block).toBe(true);
  expect(result?.reason).toContain(FOREIGN_BEAD);
  expect(result?.reason).toContain("agent:reviewer");
  expect(result?.reason).toContain("implementer");
  expect(observedClaim()).toBeUndefined();
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
  forgetClaim();
  expect(await bash(command)).toBeUndefined();
 });

 test.each([
  `git status && bd update ${BEAD} --claim --json`,
  `bd update ${BEAD} --claim --json | jq .`,
  `bd ready --metadata-field role=implementer --claim --json && touch changed.ts`,
 ])("refuses a claim combined with another executable command: %s", async (command) => {
  expect((await bash(command))?.block).toBe(true);
  expect(observedClaim()?.beadIds).toEqual([BEAD]);
 });

 test("allows a fresh acquisition from this session's role queue", async () => {
  forgetClaim();
  expect(await bash("bd ready --metadata-field role=implementer --unassigned --claim --json")).toBeUndefined();
 });

 test("refuses another acquisition while the previous bead remains held", async () => {
  beads[BEAD] = { id: BEAD, status: "in_progress", assignee: ACTOR, metadata: { role: "implementer", worktree: owned } };
  expect((await bash("bd ready --metadata-field role=implementer --unassigned --claim --json"))?.block).toBe(true);
  expect(observedClaim()?.beadIds).toEqual([BEAD]);
 });
});

describe("G5 multi-bead claims", () => {
 test.each([
  ["the foreign bead named second", `BEADS_ACTOR=${ACTOR} bd update ${BEAD} ${FOREIGN_BEAD} --claim`],
  ["the foreign bead named first", `BEADS_ACTOR=${ACTOR} bd update ${FOREIGN_BEAD} ${BEAD} --claim`],
 ])("refuses a multi-bead claim smuggling another role's bead, with %s", async (_label, command) => {
  // G5 also enforces one acquisition target when invoked without G7.
  const result = await gateClaimEligibility(ctxAt(owned), { command });

  expect(result?.block).toBe(true);
 });

 test("G5 refuses two beads even when their roles and worktrees match", async () => {
  const command = `BEADS_ACTOR=${ACTOR} bd update ${BEAD} ${SAME_TREE} --claim`;
  expect((await gateClaimEligibility(ctxAt(owned), { command }))?.block).toBe(true);
 });

 test("two beads in one tree are refused by the chain, and claim nothing", async () => {
  // G7 must refuse before G5 records a claim that G2 would subsequently enforce.
  const result = await bash(`BEADS_ACTOR=${ACTOR} bd update ${BEAD} ${SAME_TREE} --claim`);

  expect(result?.block).toBe(true);
  expect(result?.reason).toContain(SAME_TREE);
  // Untouched: still the one bead `beforeEach` seeded, so G5 never ran.
  expect(observedClaim()?.beadIds).toEqual([BEAD]);
  expect(shown).toEqual([]);
 });

 test("G2 contains every accumulated claim even if acquisition bypassed G5", async () => {
  const command = "echo hi";
  recordClaim({ actor: ACTOR, beadIds: [BEAD, SECOND] });

  const result = await gateWorktreeScope(ctxAt(owned), "bash", { command });

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
  const input = tool === "edit"
   ? { path: target(), old_string: "old", new_string: "new" }
   : { path: target(), content: "x" };
  expect(await gateChain(ctxAt(owned), tool, input)).toBeUndefined();
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
