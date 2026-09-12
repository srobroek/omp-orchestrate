import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fnmatch, scopeOf, scopesOverlap } from "../src/scope";
import { type BdInvocation, bdInvocations, effectiveSegments, invokesCommand } from "../src/shell";
import { type BotReviewState, classifyBotReviews } from "../src/tools/bot-review-probe";
import { appendAudit, auditFileName, bdMutation } from "../src/watchers";

/** mulberry32: four lines, uniform enough for corpus generation, and seedable. */
function seeded(seed: number): () => number {
 let state = seed >>> 0;
 return () => {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
 };
}

const CONTROLS = "\u0000\u0001\u0007\u001b\u007f";
const ASTRAL = "\u{1F600}\u{1F4A9}\u{10FFFF}";
const RTL = "\u202e\u200f\u061c";
const LONE_SURROGATE = "\ud800";

/** Text classes that have historically broken tokenisers, path sanitisers and matchers. */
const HOSTILE_TEXT: readonly string[] = [
 "",
 " ",
 "   \t  ",
 "\n",
 "\n\n\n",
 "\t\r\n",
 '"',
 "'",
 `"'`,
 `'"`,
 `"'"'"'`,
 "\\",
 "\\\\",
 "\\\n",
 "x\\",
 CONTROLS,
 `a${CONTROLS}b`,
 ASTRAL,
 `a${ASTRAL}b`,
 LONE_SURROGATE,
 RTL,
 `${RTL}gpj.exe`,
 ";",
 "&&",
 "||",
 ";;;&&&|||",
 "|&;",
 "()",
 "((()))",
 "{}",
 "!",
 "(",
 ")",
 ")(",
 "$(",
 "$((",
 "`",
 "<(",
 ">(",
 ">",
 ">>",
 "<",
 "<<",
 "<<<",
 "<<EOF",
 "2>&1",
 "2>&1|",
 ">&-",
 "&>",
 "&>>",
 ">|",
 "<>",
 "1>&2>&3",
 "a>b",
 "2>",
 "#",
 "../../etc/passwd",
 "/etc/passwd",
 "//host/share/x",
 "..\\..\\windows\\system32",
 "C:\\Windows\\system32",
 "~/.ssh/id_rsa",
 "$HOME",
 "${HOME}",
 "$(whoami)",
 "`whoami`",
 "**/**/**/**",
 "a;b|c&&d`e$(f)",
 "orc-1;bd close orc-2",
 "orc\n1",
 "-",
 "--",
 "---claim",
 "=",
 "a=b=c",
 "__proto__",
 "constructor",
 "prototype",
 "toString",
 "valueOf",
 "hasOwnProperty",
];

/** Object-literal lookup tables resolve these through `Object.prototype` if left unguarded. */
const PROTOTYPE_KEYS: readonly string[] = ["__proto__", "constructor", "prototype", "toString", "valueOf", "hasOwnProperty"];

/** `bd` subcommands the audit ledger is documented to record. */
const MUTATING = ["update", "close", "create", "comment", "label", "dep", "reopen", "set-state"];

const CLAIM = "bd update orc-1 --claim";

/** A `sh -c` payload nested `depth` times, each level quoted inside the one above. */
function nestedShell(depth: number): string {
 let command = CLAIM;
 for (let level = 0; level < depth; level++) {
  command = `sh -c "${command.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
 }
 return command;
}

const HOSTILE_COMMANDS: readonly string[] = [
 ...HOSTILE_TEXT,
 ...HOSTILE_TEXT.map(text => `bd update ${text} --claim`),
 ...HOSTILE_TEXT.map(text => `bd comment orc-1 "${text}"`),
 ...HOSTILE_TEXT.map(text => `${text} ${CLAIM}`),
 ...HOSTILE_TEXT.map(text => `git worktree add ${text}`),
];

describe("shell parsing under hostile input", () => {
 test("every parser lands on its documented shape and none of them throw", () => {
  for (const command of HOSTILE_COMMANDS) {
   const label = JSON.stringify(command.slice(0, 60));

   const segments = effectiveSegments(command);
   expect(Array.isArray(segments), label).toBe(true);
   for (const segment of segments) {
    expect(Array.isArray(segment), label).toBe(true);
    for (const token of segment) expect(typeof token, label).toBe("string");
   }

   const found: BdInvocation[] = bdInvocations(command);
   for (const invocation of found) {
    expect(invocation.assignments, label).toBeInstanceOf(Map);
    expect(typeof invocation.subcommand, label).toBe("string");
    expect(typeof invocation.hasClaim, label).toBe("boolean");
    for (const id of invocation.positionals) expect(typeof id, label).toBe("string");
  for (const token of invocation.rest) expect(typeof token, label).toBe("string");
  // A redirection is named by its operator, descriptor first; a word that merely
  // looks like one never lands here because the tokeniser saw it quoted.
  for (const redirection of invocation.redirections) expect(redirection, label).toMatch(/^(?:\d*(?:<<<|<<|>>|<&|>&|<>|>\||<|>)|&>>?)/);
   }

   expect(typeof invokesCommand(command, ["git", "worktree"]), label).toBe("boolean");
   expect(typeof invokesCommand(command, []), label).toBe("boolean");

   const mutation = bdMutation(command);
   // The ledger's own vocabulary. A prototype-chain hit here reported
   // `constructor`/`toString`/`valueOf` as mutating subcommands and wrote a
   // phantom provenance line for a command that changed no bead.
   if (mutation !== undefined) expect(MUTATING, label).toContain(mutation);
  }
 });

 test("a 100k-character command is parsed in linear time", () => {
  const started = performance.now();
  for (const command of [
   "x".repeat(100_000),
   ";".repeat(100_000),
   '"'.repeat(100_000),
   "\\".repeat(100_000),
   `${"( ".repeat(50_000)}${CLAIM}`,
   `${"(".repeat(100_000)}${CLAIM}`,
   `${CLAIM} ${")".repeat(100_000)}`,
   `${"$(".repeat(50_000)}${CLAIM}`,
   "`".repeat(100_000),
   ">".repeat(100_000),
   `${CLAIM} ${"2>&1 ".repeat(20_000)}`,
   `${CLAIM} ${"<<x ".repeat(25_000)}`,
   `bd update ${"**/".repeat(30_000)}x --claim`,
  ]) {
   bdInvocations(command);
   invokesCommand(command, ["git", "worktree"]);
  }
  expect(performance.now() - started).toBeLessThan(2_000);
 });

 test("wrapper-shell recursion is bounded, so a self-nesting payload cannot spin", () => {
  // Depth is capped at four, so the innermost claim of a deeper nest is invisible.
  // Termination is the contract, not depth.
  expect(bdInvocations(nestedShell(3))).toHaveLength(1);
  expect(bdInvocations(nestedShell(12))).toHaveLength(0);
  const started = performance.now();
  expect(bdInvocations(`${"sh -c ".repeat(5_000)}${CLAIM}`)).toEqual([]);
  expect(performance.now() - started).toBeLessThan(1_000);
 });

 test("a quoted bead id keeps its shell metacharacters instead of splitting the segment", () => {
  // The whole reason the gates tokenise: a claim whose id carries `;` or `&&` must
  // arrive as one operand, or a worker could hide a second claim inside the first.
  for (const id of ["a;b", "a&&b", "a|b", "a`b`c", "a$(b)c", "a(b)c", "2>&1", "a>b", "{x}", `a${CONTROLS}b`, `a${ASTRAL}b`, `a${RTL}b`]) {
   const found = bdInvocations(`bd update '${id}' --claim`);
   expect(found).toHaveLength(1);
   expect(found[0]?.positionals).toEqual([id]);
   expect(found[0]?.hasClaim).toBe(true);
  }
 });

 test("a literal newline inside quotes stays inside the operand", () => {
  // Quotes span a raw newline: `bd update 'a\nb' --claim` is one invocation
  // whose id contains the newline. Per-line tokenising used to discard the
  // quoted operand and `--claim` as an unterminated second line.
  const found = bdInvocations("bd update 'a\nb' --claim");
  expect(found).toHaveLength(1);
  expect(found[0]?.subcommand).toBe("update");
  expect(found[0]?.positionals).toEqual(["a\nb"]);
  expect(found[0]?.hasClaim).toBe(true);
 });

 test("a prototype-named operand is an operand, not a flag that eats the next one", () => {
  // `VALUE_FLAGS[token]` used to resolve `__proto__` to `Object.prototype`, which is
  // truthy, so the parser skipped the following token and the claim arrived with no
  // bead id at all — the gate then had nothing to check.
  for (const key of PROTOTYPE_KEYS) {
   const found = bdInvocations(`bd update ${key} orc-9 --claim`);
   expect(found).toHaveLength(1);
   expect(found[0]?.positionals).toEqual([key, "orc-9"]);
  }
 });

 test("a prototype-named word is not a transparent runner prefix", () => {
  // `TRANSPARENT_PREFIXES[token]` resolving through the prototype made any such word
  // see-through, so an unrelated program read as the one behind it.
  for (const key of PROTOTYPE_KEYS) {
   expect(bdInvocations(`${key} bd ready --claim`)).toEqual([]);
   expect(invokesCommand(`${key} git worktree add /tmp/x`, ["git", "worktree"])).toBe(false);
  }
 });

 test("a prototype-named subcommand is not recorded as a bead mutation", () => {
  for (const key of PROTOTYPE_KEYS) expect(bdMutation(`bd ${key} orc-1`)).toBeUndefined();
 });
});

describe("auditFileName under hostile child ids", () => {
 test("no name escapes the ledger directory and none is hidden", () => {
  const children = [
   ...HOSTILE_TEXT,
   ...PROTOTYPE_KEYS,
   ".",
   "..",
   "...",
   ".....",
   ".bdlog",
   "..bdlog",
   "a/../../b",
   "/",
   "//",
   "\\",
   "a".repeat(100_000),
   `${ASTRAL}/${RTL}`,
   "con",
   "-rf",
   "NUL",
  ];
  for (const child of children) {
   const name = auditFileName(child);
   if (name === undefined) continue;
   const label = JSON.stringify(child.slice(0, 40));
   // A separator would write outside the ledger directory; a leading dot would
   // hide the file from the reader the ledger exists for.
   expect(name.includes("/"), label).toBe(false);
   expect(name.includes("\\"), label).toBe(false);
   expect(name.startsWith("."), label).toBe(false);
   expect(name.includes("\u0000"), label).toBe(false);
   expect(name.endsWith(".bdlog"), label).toBe(true);
   // Nothing outside the sanitiser's alphabet survives, so no shell, glob or
   // unicode-direction trickery reaches a path.
   expect(/^[A-Za-z0-9_-][A-Za-z0-9._-]*\.bdlog$/.test(name), label).toBe(true);
   // NAME_MAX is 255 bytes and the alphabet above is ASCII, so this is the byte
   // count too. Past it `appendFile` raises ENAMETOOLONG and the ledger line is
   // lost, which is a hole in the only record of who mutated which bead.
   expect(name.length, label).toBeLessThanOrEqual(255);
  }
 });

 test("distinct children keep distinct names where the alphabet allows it", () => {
  // The sanitiser is lossy by design, but it must not collapse ids that differ
  // inside its own alphabet, or two children would share one ledger.
  expect(auditFileName("orc-a")).not.toBe(auditFileName("orc-b"));
  expect(auditFileName("orc.1")).toBe("orc.1.bdlog");
 });

 test("a 100k-character child id is written to the ledger rather than dropped", async () => {
  // The end of the argument, exercised end to end: the name is bounded, so
  // `appendFile` succeeds instead of raising ENAMETOOLONG, and the row still carries
  // the whole id — the file name is an index, the row is the datum.
  const child = "w".repeat(100_000);
  const name = auditFileName(child);
  expect(name).toBeDefined();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orc-fuzz-audit-"));
  try {
   const entry = { ts: "2026-01-01T00:00:00.000Z", child, argv: "bd update orc-1 --claim", exitCode: 0 };
   await appendAudit(dir, entry);
   const rows = (await fs.readFile(path.join(dir, name as string), "utf8")).trimEnd().split("\n");
   expect(rows).toHaveLength(1);
   expect((JSON.parse(rows[0] as string) as typeof entry).child).toBe(child);
  } finally {
   await fs.rm(dir, { recursive: true, force: true });
  }
 });
});

/** Independent regexp oracle; inputs stay short to avoid its exponential backtracking. */
function retiredFnmatch(text: string, pattern: string): boolean {
 let source = "";
 for (let index = 0; index < pattern.length; index++) {
  const char = pattern[index] as string;
  if (char === "*") {
   source += ".*";
  } else if (char === "?") {
   source += ".";
  } else if (char === "[") {
   const close = pattern.indexOf("]", index + 1);
   if (close === -1) {
    source += "\\[";
   } else {
    let group = pattern.slice(index + 1, close);
    index = close;
    if (group.startsWith("!")) group = `^${group.slice(1)}`;
    source += `[${group}]`;
   }
  } else {
   source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
 }
 try {
  return new RegExp(`^${source}$`, "s").test(text);
 } catch {
  return true;
 }
}

describe("fnmatch", () => {
 test("decides every generated pair exactly as the retired regexp translation did", () => {
  // Short inputs on purpose: the oracle is the implementation that backtracks, so a
  // long pattern would hang the test rather than the code under test.
  //
  // Half the corpus is random-vs-random, which is almost always a non-match and so
  // exercises the backtracking path; the other half derives the pattern FROM the text
  // by wildcarding characters in place, which is almost always a match. A one-sided
  // corpus would prove parity on one branch and nothing on the other.
  const next = seeded(0x5eed_2);
  const alphabet = [..."ab/.-!^", "*", "?", "[", "]"];
  const build = (max: number): string => {
   const length = Math.floor(next() * max);
   let out = "";
   for (let index = 0; index < length; index++) out += alphabet[Math.floor(next() * alphabet.length)] as string;
   return out;
  };
  let matched = 0;
  for (let round = 0; round < 4_000; round++) {
   const text = build(10);
   let pattern: string;
   if (round % 2 === 0) {
    pattern = build(12);
   } else {
    pattern = "";
    for (const char of text) {
     const roll = next();
     if (roll < 0.2) pattern += "*";
     else if (roll < 0.35) pattern += "?";
     else if (roll < 0.5) pattern += `[${char}z]`;
     else if (roll < 0.6) pattern += "[!z]";
     else pattern += char;
    }
    // A near-miss now and then, so the derived half is not uniformly a match.
    if (next() < 0.3) pattern += "z";
   }
   const label = `text=${JSON.stringify(text)} pattern=${JSON.stringify(pattern)}`;
   const verdict = fnmatch(text, pattern);
   expect(verdict, label).toBe(retiredFnmatch(text, pattern));
   if (verdict) matched += 1;
  }
  // Both branches genuinely covered, or the agreement above is worth little.
  expect(matched).toBeGreaterThan(400);
  expect(matched).toBeLessThan(3_600);
 });

 test("keeps the semantics the module documents", () => {
  expect(fnmatch("src/api/v2/f.py", "src/*")).toBe(true); // `*` crosses `/`
  expect(fnmatch("src/api/ff.py", "src/api/?.py")).toBe(false); // `?` is exactly one
  expect(fnmatch("src/api/a.py", "src/api/?.py")).toBe(true);
  expect(fnmatch("src/api/a.py", "src/api/[ab].py")).toBe(true);
  expect(fnmatch("src/api/c.py", "src/api/[ab].py")).toBe(false);
  expect(fnmatch("src/api/c.py", "src/api/[!ab].py")).toBe(true);
  expect(fnmatch("src/api/m.py", "src/api/[a-z].py")).toBe(true);
  expect(fnmatch("src/api/M.py", "src/api/[a-z].py")).toBe(false);
  expect(fnmatch("", "")).toBe(true);
  expect(fnmatch("", "*")).toBe(true);
  expect(fnmatch("a", "")).toBe(false);
  expect(fnmatch("a\nb", "a?b")).toBe(true); // `s` semantics: `?` spans a newline
 });

 test("a bracket group that will not compile is reported as a match, not a throw", () => {
  // The module's stated bias: what it cannot settle is a conflict, because a false
  // positive only serialises work that was safe to parallelise.
  for (const pattern of ["[a-\\]", "[\\]", "[a-", "[[[", "[!"]) {
   expect(() => fnmatch("src/a.py", pattern)).not.toThrow();
   expect(typeof fnmatch("src/a.py", pattern)).toBe("boolean");
  }
  expect(fnmatch("src/a.py", "[a-\\]")).toBe(true);
 });

 test("a star bomb is decided in constant-ish time instead of exponential time", () => {
  // Interleaved stars made the regexp matcher backtrack exponentially.
  const started = performance.now();
  for (const stars of [16, 18, 24, 32, 64, 200]) {
   const pattern = `src${"*a".repeat(stars)}b`;
   const text = `src${"a".repeat(stars * 2 + 4)}`;
   expect(fnmatch(text, pattern)).toBe(false);
   // A literal scope owns descendants; this path witnesses the overlap.
   expect(fnmatch(`${text}/ab`, pattern)).toBe(true);
   expect(scopesOverlap([pattern], [text])).toBe(true);
  }
  // Character classes are the other variable-cost step, so interleave them too.
  for (const groups of [16, 32, 64]) {
   const pattern = `src${"[a-z]*".repeat(groups)}b`;
   expect(fnmatch(`src${"a".repeat(groups * 2 + 4)}`, pattern)).toBe(false);
  }
  // A run of stars collapses to one step, so `**` padding costs nothing. Both stay
  // under the length ceiling, or they would be answered by the ceiling instead.
  expect(fnmatch("src/a/b/c.ts", `src/${"**/".repeat(100)}x.ts`)).toBe(false);
  expect(fnmatch("src/a/b/x.ts", `src/${"**".repeat(200)}/x.ts`)).toBe(true);
  expect(performance.now() - started).toBeLessThan(500);
 });

 test("a pair too large to settle is a conflict rather than a long wait", () => {
  // Past the ceiling the match is not attempted at all: the operands are not paths
  // at that size, and the answer errs toward serialising.
  const started = performance.now();
  expect(fnmatch("a".repeat(200_000), `${"*a".repeat(50_000)}b`)).toBe(true);
  expect(fnmatch("a".repeat(2_000), "a*")).toBe(true);
  expect(performance.now() - started).toBeLessThan(200);
  // Just inside the ceiling the real answer is still computed.
  expect(fnmatch("a".repeat(1_024), `${"a".repeat(1_024)}`)).toBe(true);
  expect(fnmatch("a".repeat(1_024), `b${"a".repeat(1_023)}`)).toBe(false);
 });
});

describe("scope resolution under hostile metadata", () => {
 test("scopeOf always yields an array of strings, whatever the bead carries", () => {
  const values: unknown[] = [
   undefined,
   null,
   42,
   -0,
   Number.NaN,
   true,
   {},
   { k: 1 },
   [],
   [1, 2, 3],
   ["src/**", 42, null, ["x"], { k: 1 }],
   '["src/**", 42, null, ["x"], {"k":1}]',
   '"src/**"',
   "[",
   "{}",
   "null",
   "42",
   "src/**",
   ...HOSTILE_TEXT,
   JSON.parse('{"__proto__": {"scope": "**"}}'),
  ];
  for (const scope of values) {
   const globs = scopeOf({ scope } as Record<string, unknown>);
   expect(Array.isArray(globs), JSON.stringify(scope)?.slice(0, 40)).toBe(true);
   for (const glob of globs) expect(typeof glob).toBe("string");
  }
  // A non-string entry never reaches the matcher, in either carrier.
  expect(scopeOf({ scope: ["src/**", 42, null, ["x"], { k: 1 }] })).toEqual(["src/**"]);
  expect(scopeOf({ scope: '["src/**", 42, null]' })).toEqual(["src/**"]);
  // `__proto__` in a JSON object is an own property, so it names no scope.
  expect(scopeOf(JSON.parse('{"__proto__": {"scope": "**"}}'))).toEqual([]);
 });

 test("an undeclared scope still declares nothing", () => {
  // The one asymmetry that must not drift: an empty scope claims no path, so it
  // cannot serialise every other bead. Everything else here errs toward conflict.
  expect(scopesOverlap([], ["src/**"])).toBe(false);
  expect(scopesOverlap(["src/**"], [])).toBe(false);
  expect(scopesOverlap([], [])).toBe(false);
  // An empty *glob* is not an empty scope: it has no literal prefix, so it owns
  // everything, exactly as a bare `**` does.
  expect(scopesOverlap([""], ["src/**"])).toBe(true);
 });
});


describe("classifyBotReviews under hostile evidence", () => {
 /** The verdict-to-exit-code map the landing contract routes on. */
 const CODES: Record<BotReviewState, number> = {
  absent: 0,
  clean: 0,
  pending: 10,
  stale: 11,
  actionable: 12,
  declined: 13,
  unknown: 2,
 };

 function payloads(): unknown[] {
  const out: unknown[] = [];
  for (const text of HOSTILE_TEXT) {
   out.push({ reviews: [{ login: "coderabbitai", commit: "abc", body: text, state: text, url: text, at: text }] });
   out.push({ notices: [{ login: "coderabbitai", at: text, body: `quota reached, ${text} minutes` }] });
   out.push({ comments: [{ login: "coderabbitai", commit: "abc", path: text, line: text, url: text }] });
   out.push({ checks: [{ name: text, status: text, state: text, detailsUrl: text }] });
  }
  return out;
 }

 test("hostile text evidence lands on a documented verdict whose code matches it", () => {
  const now = new Date("2026-06-01T00:00:00Z");
  for (const payload of payloads()) {
   const slugs = ["coderabbitai"];
   const label = `${JSON.stringify(payload)?.slice(0, 70)} slugs=${JSON.stringify(slugs)}`;
   const result = classifyBotReviews(payload, { head: "abc", slugs, now });
   expect(Object.keys(CODES), label).toContain(result.verdict);
   expect(result.code, label).toBe(CODES[result.verdict]);
  }
 });

 test("an absurd or unparseable actionable count still routes the conservative way", () => {
  // The count is the bot's prose, so it is data this tool does not control. Every
  // unusable figure must land on `actionable` or `pending` — never `clean`, which
  // would merge on a round nobody read.
  const at = { head: "abc", slugs: ["coderabbitai"] };
  const review = (body: string): unknown => ({ reviews: [{ login: "coderabbitai", commit: "abc", body }] });
  expect(classifyBotReviews(review(`actionable comments posted: ${"9".repeat(400)}`), at).verdict).toBe("actionable");
  expect(classifyBotReviews(review("actionable comments posted: 007"), at).verdict).toBe("actionable");
  expect(classifyBotReviews(review("actionable comments posted: 0"), at).verdict).toBe("clean");
  // No recognised summary line at all is "not answered yet", not "nothing to fix".
  expect(classifyBotReviews(review("looks good to me"), at).verdict).toBe("pending");
  expect(classifyBotReviews(review("actionable comments posted: -3"), at).verdict).toBe("pending");
 });

 test("a prototype-named bot slug is classified, not crashed on", () => {
  // `ADAPTERS[slug]` resolved `constructor` to the `Object` constructor and returned
  // it as an adapter; the next line called `.declined(body)` on it and threw a
  // TypeError straight out of a function documented never to raise.
  for (const key of PROTOTYPE_KEYS) {
   const payload = { reviews: [{ login: key, commit: "abc", body: "anything", state: "COMMENTED" }] };
   expect(() => classifyBotReviews(payload, { head: "abc", slugs: [key] })).not.toThrow();
   const result = classifyBotReviews(payload, { head: "abc", slugs: [key] });
   expect(Object.keys(CODES)).toContain(result.verdict);
   expect(result.code).toBe(CODES[result.verdict]);
  }
 });

 test("a prototype-named check state is not read as a finished check", () => {
  // `STATUS_API_TERMINAL[state]` resolving through the prototype graded a round
  // before the bot had answered.
  for (const key of PROTOTYPE_KEYS) {
   const result = classifyBotReviews(
    { checks: [{ name: "coderabbitai", state: key }] },
    { head: "abc", slugs: ["coderabbitai"] },
   );
   expect(result.verdict).toBe("pending");
   expect(result.code).toBe(CODES.pending);
  }
 });
});

describe("prototype pollution", () => {
 test("no hostile payload leaves anything behind on Object.prototype", () => {
  // `JSON.parse` makes `__proto__` an OWN property rather than reassigning the
  // prototype, and nothing in this plugin deep-merges untrusted metadata, so the
  // expected answer is "nothing leaked". Asserted rather than assumed: the day
  // somebody reaches for `Object.assign` over a bead's metadata, this is the test
  // that says so, and every reader downstream of it trusts a plain object.
  const canary = [
   "polluted",
   "pr",
   "repo",
   "scope",
   "head_sha",
   "branch",
   "takesDuration",
   "declined",
  ];
  const before = canary.map(key => key in ({} as Record<string, unknown>));

  const hostile: unknown = JSON.parse(
   '{"__proto__":{"polluted":true,"pr":9,"repo":"a/b","scope":"**","head_sha":"deadbeef",' +
   '"branch":"b","takesDuration":true,"declined":true},' +
   '"constructor":{"prototype":{"polluted":true}},"prototype":{"polluted":true},' +
   '"type":"dispatch","status":"in_progress","labels":["orc-node","state:approved"]}',
  );

  classifyBotReviews(hostile, { head: "abc", slugs: ["coderabbitai", "__proto__"] });
  scopesOverlap(scopeOf(hostile as Record<string, unknown>), ["src/**"]);
  bdInvocations("bd update __proto__ constructor --claim");
  auditFileName("__proto__");

  expect(canary.map(key => key in ({} as Record<string, unknown>))).toEqual(before);
  expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
 });
});
