import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { ExtensionContext, ToolCallEventResult } from "@oh-my-pi/pi-coding-agent";
import { logger } from "@oh-my-pi/pi-utils";
import type { BdBead, BdComment } from "../src/bd";
import * as actualBd from "../src/bd";
import * as origin from "../src/origin";
import { createClaimState } from "../src/claim-state";
import { createExitGuard } from "../src/gates/exit";
import { markerPath } from "../src/run-state";

const BEAD = "orc-42";
/** The `REPORTED` token naming where a worker pushed its head, as the fixture worker spells it. */
function pushed(sha: string): string { return `pushed=omp/task/A@${sha}`; }
/** The run epic's recorded base: the commit every worker's head is compared against. */
const BASE = "72c609ac23fba9be420212169d05f8a9c2f49911";
const CTX = { getSystemPrompt: () => ["ORC-ROLE: implementer"] } as unknown as ExtensionContext;
let bead: BdBead | null;
let comments: BdComment[] | null;
let linked: string[] | null;
let linkedBead: BdBead | null;
let linkedComments: BdComment[] | null;
/** The run epic `bd show orc-run` answers with; `null` models an unreadable epic. */
let epic: BdBead | null;
let issued: string[][];
let shown: string[];
let warned: Record<string, unknown>[];
/** What origin answers for any ref; `undefined` mirrors the bead's own `head_sha`, the pushed case. */
let remote: origin.OriginHead | undefined;
let asked: string[];
/** The clone as git describes it; `undefined` mirrors the bead's head with a clean tree. */
let local: origin.LocalState | undefined;
let unreadableClone = false;
let fixture: string;
let claims = createClaimState();
let gateExitContract: ReturnType<typeof createExitGuard>;
const spies = [
 // The claimed beads and the linked beads both arrive through the one-call hydration; an
 // unreadable bead among them is a failed read, so the whole map is unknown rather than
 // one entry missing.
 spyOn(actualBd, "bdShowMany").mockImplementation(async ids => {
  const hydrated = new Map<string, BdBead>();
  for (const id of ids) {
   const row = id === BEAD ? bead : linkedBead;
   if (row === null) return null;
   hydrated.set(id, row);
  }
  return hydrated;
 }),
 spyOn(actualBd, "bdCommentsChecked").mockImplementation(async id => id === BEAD ? comments : linkedComments),
 spyOn(actualBd, "bdLinkedChecked").mockImplementation(async (_id, _type, _timeout, direction) => {
  const expected = bead?.ephemeral === true || bead?.wisp_type !== undefined ? "down" : "up";
  return direction === expected ? linked : [];
 }),
 spyOn(actualBd, "bdRun").mockImplementation(async (args: string[]) => {
  issued.push(args);
  return { code: 0, stdout: "", stderr: "" };
 }),
 spyOn(actualBd, "bdShow").mockImplementation(async (id: string) => {
  shown.push(id);
  return id === "orc-run" ? epic : null;
 }),
 spyOn(origin, "originHead").mockImplementation(async (_cwd, ref) => {
  asked.push(ref);
  if (remote !== undefined) return remote;
  const head = bead?.metadata?.head_sha;
  return typeof head === "string" ? { kind: "at", sha: head } : { kind: "missing" };
 }),
 spyOn(origin, "localState").mockImplementation(async () => {
  if (unreadableClone) return undefined;
  if (local !== undefined) return local;
  const head = bead?.metadata?.head_sha;
  return { head: typeof head === "string" ? head : BASE, dirty: false };
 }),
 spyOn(logger, "warn").mockImplementation(((_message: string, data?: Record<string, unknown>) => {
  warned.push(data ?? {});
 }) as typeof logger.warn),
];
afterAll(() => { for (const spy of spies) spy.mockRestore(); });
afterEach(async () => { claims = createClaimState(); await rm(fixture, { recursive: true, force: true }); });
beforeEach(async () => {
 fixture = await mkdtemp(path.join(tmpdir(), "orc-exit-"));
 await mkdir(path.join(fixture, "artifacts"));
 await writeFile(path.join(fixture, "artifacts/result"), "evidence");
 claims = createClaimState();
 gateExitContract = createExitGuard(claims);
 issued = [];
 shown = [];
 warned = [];
 remote = undefined;
 asked = [];
 local = undefined;
 unreadableClone = false;
 bead = { id: BEAD, status: "in_progress", assignee: "A", metadata: { execution_kind: "git", base_sha: BASE } };
 comments = [];
 linked = [];
 linkedBead = null;
 linkedComments = [];
 epic = { id: "orc-run", status: "in_progress", metadata: { base_sha: BASE } };
 claims.recordClaim({ actor: "A", beadIds: [BEAD] });
});

test("a released shepherd exit with a BLOCKED wait mutates nothing it inherited", async () => {
 bead = {
  id: BEAD,
  status: "open",
  assignee: "",
  labels: ["orc-merge", "pr:merge"],
  metadata: { role: "shepherd", execution_kind: "git", head_sha: "abc123" },
 };
 comments = [{ text: `BLOCKED ${BEAD} head_sha=abc123 gate=gate-7 waiting for merge window` }];
 const shepherd = { getSystemPrompt: () => ["ORC-ROLE: shepherd"] } as unknown as ExtensionContext;
 expect(await gateExitContract(shepherd)).toBeUndefined();
 expect(bead.labels).toEqual(["orc-merge", "pr:merge"]);
 expect(bead.assignee).toBe("");
 expect(issued).toEqual([]);
});

test("a held bead is a valid exit: status blocked plus ASK, claim retained", async () => {
 // The human hold has one carrier. Without ASK in the escape clause the worker that
 // parked its bead correctly would be refused for lacking REPORTED.
 bead = { id: BEAD, status: "blocked", assignee: "A", metadata: { execution_kind: "git", base_sha: BASE } };
 comments = [{ text: `ASK ${BEAD} question: which API?` }];
 expect(await gateExitContract(CTX)).toBeUndefined();
 comments = [{ text: `NOTE ${BEAD} leaning towards the old API` }];
 expect((await gateExitContract(CTX))?.block).toBe(true);
});

describe("G4 activation refusal budget", () => {
 test("repeated invalid exits are bounded without rewriting shared state", async () => {
  bead!.metadata = { execution_kind: "git", stop_attempts: "bad" };
  expect((await gateExitContract(CTX))?.block).toBe(true);
  expect(JSON.parse((await gateExitContract(CTX))!.reason!).attempt).toBe(2);
  expect(await gateExitContract(CTX)).toBeUndefined();
  expect(await gateExitContract(CTX)).toBeUndefined();
  expect(issued).toEqual([]);
  expect(bead!.assignee).toBe("A");
  expect(bead!.status).toBe("in_progress");
 });
 test("a new activation gets its own refusal budget", async () => {
  for (let i = 0; i < 3; i++) await gateExitContract(CTX);
  claims = createClaimState();
  gateExitContract = createExitGuard(claims);
  claims.recordClaim({ actor: "A", beadIds: [BEAD] });
  expect(JSON.parse((await gateExitContract(CTX))!.reason!).attempt).toBe(1);
 });
 test("late A yield cannot change successor B ownership", async () => {
  bead!.assignee = "B";
  expect(await gateExitContract(CTX)).toBeUndefined();
  expect(issued).toEqual([]);
  expect(bead!.assignee).toBe("B");
 });
 test("closed invalid work is never reopened at the cap", async () => {
  bead!.status = "closed";
  for (let i = 0; i < 3; i++) await gateExitContract(CTX);
  expect(issued).toEqual([]);
  expect(bead!.status).toBe("closed");
 });
 test("completion of the first bead does not conceal another unfinished claim", async () => {
  bead = { id: BEAD, status: "blocked", assignee: "A", metadata: { base_sha: BASE } };
  comments = [{ text: "BLOCKED awaiting prerequisite" }];
  linkedBead = { id: "second", assignee: "A", metadata: { execution_kind: "git" } };
  claims.recordClaim({ actor: "A", beadIds: [BEAD, "second"] });
  expect(JSON.parse((await gateExitContract(CTX))!.reason!).bead).toBe("second");
  expect(issued).toEqual([]);
 });
});

describe("G4 checked evidence", () => {
 test.each(["bead", "comments", "links", "linked bead"])("unknown %s permits an unevaluated exit without mutation", async source => {
  if (source === "bead") bead = null;
  if (source === "comments") comments = null;
  if (source === "links") linked = null;
  if (source === "linked bead") linked = ["node"];
  expect(await gateExitContract(CTX)).toBeUndefined();
  expect(issued).toEqual([]);
 });
 test("unknown linked comments permit an unevaluated exit for a role that reads them", async () => {
  bead = { id: BEAD, ephemeral: true, wisp_type: "review", assignee: "", status: "closed" };
  linked = ["node"];
  linkedBead = { id: "node" };
  linkedComments = null;
  const reviewer = { getSystemPrompt: () => ["ORC-ROLE: reviewer"] } as unknown as ExtensionContext;
  expect(await gateExitContract(reviewer)).toBeUndefined();
  expect(issued).toEqual([]);
 });
 test("a review wisp linked to its node by the parent edge alone is judged on the node's verdict", async () => {
  // The documented shape: `bd create --parent <node> --ephemeral`, and bd refuses a
  // relates-to from a child to its parent, so no dep list answers with the node.
  bead = { id: BEAD, ephemeral: true, parent: "node", assignee: "A", status: "in_progress", metadata: { role: "reviewer", head_sha: "abc1234", review_round: 1 } };
  linked = [];
  linkedBead = { id: "node", metadata: { head_sha: "abc1234" } };
  linkedComments = [{ text: "REPORTED node src/api.ts" }];
  const reviewer = { getSystemPrompt: () => ["ORC-ROLE: reviewer"] } as unknown as ExtensionContext;
  const verdict: { failed_checks: { check: string; detail: string }[] } = JSON.parse((await gateExitContract(reviewer))!.reason!);
  expect(verdict.failed_checks).toEqual([{ check: "verdict", detail: "unsatisfied: linked.comment.verb in [REVIEW, BLOCKED]" }]);
  linkedComments.push({ text: "REVIEW node dimension=behavior verdict=approve head_sha=abc1234 review_round=1" });
  expect(await gateExitContract(reviewer)).toBeUndefined();
  expect(issued).toEqual([]);
 });
 test("an implementer's contract never reads linked comments, so their absence cannot excuse its exit", async () => {
  // The implementer contract reads linked beads only for an open escalation; with
  // none open, the unreported bead is judged and refused rather than waved through.
  linked = ["review-wisp"];
  linkedBead = { id: "review-wisp", ephemeral: true, wisp_type: "escalation", status: "closed" };
  linkedComments = null;
  expect((await gateExitContract(CTX))?.block).toBe(true);
  expect(issued).toEqual([]);
 });
 test("a shepherd's contract reads no links at all", async () => {
  bead = { id: BEAD, status: "in_progress", assignee: "A", labels: ["orc-merge"], metadata: { role: "shepherd", execution_kind: "git" } };
  linked = null;
  const shepherd = { getSystemPrompt: () => ["ORC-ROLE: shepherd"] } as unknown as ExtensionContext;
  expect((await gateExitContract(shepherd))?.block).toBe(true);
  comments = [{ text: `BLOCKED ${BEAD} gate=gate-7 waiting for merge window` }];
  bead.assignee = "";
  expect(await gateExitContract(shepherd)).toBeUndefined();
  expect(issued).toEqual([]);
 });
 test("a git implementer whose pushed ref is at its head is stamped and released in one fenced write", async () => {
  bead = { id: BEAD, status: "in_progress", assignee: "A", labels: ["agent:reviewer"], metadata: { execution_kind: "git", head_sha: "abc1234" } };
  comments = [{ text: `REPORTED src/api.ts committed abc1234 ${pushed("abc1234")}` }];
  expect(await gateExitContract(CTX)).toBeUndefined();
  expect(asked).toEqual(["omp/task/A"]);
  // The plugin's own word that the head was seen on origin, and the release, in the one write bd fences.
  expect(issued).toEqual([["update", BEAD, "--actor", "A", "--claim", "--assignee", "", "--set-metadata", "pushed_sha=abc1234", "--status", "in_progress"]]);
  delete bead.metadata!.head_sha;
  expect((await gateExitContract(CTX))?.block).toBe(true);
 });
 test("a completed report with its pushed head on origin is still refused while the tree is dirty", async () => {
  bead = { id: BEAD, status: "in_progress", assignee: "", labels: ["agent:reviewer"], metadata: { execution_kind: "git", head_sha: "abc1234" } };
  comments = [{ text: `REPORTED src/api.ts committed abc1234 ${pushed("abc1234")}` }];
  local = { head: "abc1234abc1234abc1234abc1234abc1234abc12", dirty: true };
  const verdict: { failed_checks: { check: string; detail: string }[] } = JSON.parse((await gateExitContract(CTX))!.reason!);
  expect(verdict.failed_checks.map(failure => failure.check)).toEqual(["pushed"]);
  expect(verdict.failed_checks[0]!.detail).toContain("commit and push (`git push origin HEAD:$ORC_PUSH_REF`), or discard them, before yielding");
  expect(issued).toEqual([]);
  local = { head: "abc1234abc1234abc1234abc1234abc1234abc12", dirty: false };
  remote = { kind: "at", sha: "abc1234abc1234abc1234abc1234abc1234abc12" };
  expect(await gateExitContract(CTX)).toBeUndefined();
 });
 test("a REPORTED without a pushed token is refused before origin is asked", async () => {
  bead = { id: BEAD, status: "in_progress", assignee: "", labels: ["agent:reviewer"], metadata: { execution_kind: "git", head_sha: "abc1234" } };
  comments = [{ text: "REPORTED src/api.ts committed abc1234" }];
  const verdict: { failed_checks: { check: string; detail: string; recovery?: string }[] } = JSON.parse((await gateExitContract(CTX))!.reason!);
  expect(verdict.failed_checks.map(failure => failure.check)).toEqual(["pushed"]);
  expect(verdict.failed_checks[0]!.detail).toContain("names no pushed=<ref>@<sha>");
  expect(verdict.failed_checks[0]!.recovery).toContain("git push origin HEAD:$ORC_PUSH_REF");
  expect(asked).toEqual([]);
  expect(issued).toEqual([]);
 });
 test.each([
  ["origin holds another commit", { kind: "at", sha: "0000000" } as origin.OriginHead, "is at 0000000, not head_sha abc1234"],
  ["origin has no such ref", { kind: "missing" } as origin.OriginHead, "origin has no omp/task/A"],
  ["origin does not answer", { kind: "unreachable", cause: "Could not resolve host" } as origin.OriginHead, "origin unreachable (Could not resolve host); retry `git push` and REPORTED, the worker stays alive until proven"],
 ])("an implementer whose pushed ref is not proven is refused: %s", async (_label, answer, text) => {
  bead = { id: BEAD, status: "in_progress", assignee: "", labels: ["agent:reviewer"], metadata: { execution_kind: "git", head_sha: "abc1234" } };
  comments = [{ text: `REPORTED src/api.ts ${pushed("abc1234")}` }];
  remote = answer;
  const verdict: { failed_checks: { check: string; detail: string }[] } = JSON.parse((await gateExitContract(CTX))!.reason!);
  expect(verdict.failed_checks.map(failure => failure.check)).toEqual(["pushed"]);
  expect(verdict.failed_checks[0]!.detail).toContain(text);
  expect(issued).toEqual([]);
 });
 test("a pushed token contradicting head_sha is refused without asking origin", async () => {
  bead = { id: BEAD, status: "in_progress", assignee: "", labels: ["agent:reviewer"], metadata: { execution_kind: "git", head_sha: "abc1234" } };
  comments = [{ text: `REPORTED src/api.ts ${pushed("fedcba9")}` }];
  expect(JSON.parse((await gateExitContract(CTX))!.reason!).failed_checks[0].detail).toContain("but head_sha is abc1234");
  expect(asked).toEqual([]);
 });
 test("an implementer paused on an open escalation asks origin nothing", async () => {
  linked = ["question"];
  linkedBead = { id: "question", ephemeral: true, wisp_type: "escalation", status: "open" };
  expect(await gateExitContract(CTX)).toBeUndefined();
  expect(asked).toEqual([]);
 });
 describe("an architect's exit is judged against origin and its own release", () => {
  const ARCH = { getSystemPrompt: () => ["ORC-ROLE: architect"] } as unknown as ExtensionContext;
  const FEATURE = "feat/login";
  function feature(overrides: Partial<BdBead> = {}): BdBead {
   return {
    id: BEAD, status: "in_progress", assignee: "", labels: ["agent:reviewer"],
    metadata: { role: "architect", execution_kind: "git", branch: FEATURE, push: `origin/${FEATURE}`, head_sha: "abc1234" },
    ...overrides,
   };
  }
  test("released, reported, feature head on origin: allowed, and the stamp is skipped on a bead nobody holds", async () => {
   bead = feature();
   comments = [{ text: `REPORTED ${BEAD} integrated 3 tasks; head_sha=abc1234` }];
   expect(await gateExitContract(ARCH)).toBeUndefined();
   expect(asked).toEqual([FEATURE]);
   // No fence exists for a released bead, so no write is issued; the missing stamp is logged.
   expect(issued).toEqual([]);
   expect(warned.map(entry => entry.cause)).toEqual(["released before proof"]);
  });
  test("a feature head origin does not hold is refused, naming the push", async () => {
   bead = feature();
   comments = [{ text: `REPORTED ${BEAD} integrated; head_sha=abc1234` }];
   remote = { kind: "at", sha: "1111111" };
   const verdict: { failed_checks: { check: string; detail: string; recovery?: string }[] } = JSON.parse((await gateExitContract(ARCH))!.reason!);
   expect(verdict.failed_checks.map(failure => failure.check)).toEqual(["push_head"]);
   expect(verdict.failed_checks[0]!.detail).toContain("origin feat/login is at 1111111, not head_sha abc1234");
   expect(verdict.failed_checks[0]!.recovery).toContain("git push origin <branch>");
   expect(issued).toEqual([]);
  });
  test("an epic still held by the architect is refused: an isolated architect cannot be revived", async () => {
   bead = feature({ assignee: "A" });
   comments = [{ text: `REPORTED ${BEAD} integrated; head_sha=abc1234` }];
   const verdict: { failed_checks: { check: string; recovery?: string }[] } = JSON.parse((await gateExitContract(ARCH))!.reason!);
   expect(verdict.failed_checks.map(failure => failure.check)).toEqual(["unclaimed"]);
   expect(verdict.failed_checks[0]!.recovery).toContain('bd update <epic> --claim --assignee ""');
  });
  test("a park needs the comment, the release and the pushed head; the refusal names the two steps", async () => {
   bead = feature({ status: "blocked", assignee: "A" });
   comments = [{ text: `BLOCKED ${BEAD} design question on the token format` }];
   const verdict: { failed_checks: { check: string; detail: string; recovery?: string }[] } = JSON.parse((await gateExitContract(ARCH))!.reason!);
   expect(verdict.failed_checks[0]!.check).toBe("escape");
   expect(verdict.failed_checks[0]!.recovery).toContain("push the feature branch");
   expect(verdict.failed_checks[0]!.recovery).toContain("then release the epic");
   bead.assignee = "";
   remote = { kind: "missing" };
   expect(JSON.parse((await gateExitContract(ARCH))!.reason!).failed_checks[0].detail).toContain("origin has no feat/login");
   remote = undefined;
   expect(await gateExitContract(ARCH)).toBeUndefined();
  });
  test("an open escalation does not pause an architect: it parks or completes", async () => {
   bead = feature({ assignee: "A" });
   linked = ["question"];
   linkedBead = { id: "question", ephemeral: true, wisp_type: "escalation", status: "open" };
   expect((await gateExitContract(ARCH))?.block).toBe(true);
  });
 });
 test.each(["artifact", "comment", "external"])("%s writer completion requires handoff, and the gate releases the held claim", async kind => {
  bead = { id: BEAD, status: "in_progress", assignee: "A", metadata: { execution_kind: kind, artifacts_dir: path.join(fixture, "artifacts"), output_ref: path.join(fixture, "artifacts/result") } };
  comments = [{ text: "REPORTED result" }];
  const result = await gateExitContract(CTX);
  expect(JSON.parse(result!.reason!).failed_checks.map((failure: { check: string }) => failure.check)).toEqual(["handoff"]);
  bead.labels = ["agent:reviewer"];
  expect(await gateExitContract(CTX)).toBeUndefined();
  expect(issued).toEqual([["update", BEAD, "--actor", "A", "--claim", "--assignee", "", "--status", "in_progress"]]);
 });
 test.each(["review", "escalation"])("claimed %s wisp reads its outgoing node verdict", async kind => {
  bead = { id: BEAD, ephemeral: true, wisp_type: kind, assignee: "", status: "closed" };
  linked = ["node"];
  linkedBead = { id: "node" };
  linkedComments = [{ text: kind === "review" ? "REVIEW approved" : "NOTE use the existing API" }];
  const role = kind === "review" ? "reviewer" : "researcher";
  const ctx = { getSystemPrompt: () => [`ORC-ROLE: ${role}`] } as unknown as ExtensionContext;
  expect(await gateExitContract(ctx)).toBeUndefined();
  linkedComments = [];
  expect((await gateExitContract(ctx))?.block).toBe(true);
 });
 test("historical linked verdict cannot satisfy the current head and round", async () => {
  bead = { id: BEAD, ephemeral: true, wisp_type: "review", metadata: { head_sha: "new", review_round: 2 } };
  linked = ["node"];
  linkedBead = { id: "node", metadata: { head_sha: "old", review_round: 1 } };
  linkedComments = [{ text: "REVIEW node head_sha=old review_round=1" }];
  const ctx = { getSystemPrompt: () => ["ORC-ROLE: reviewer"] } as unknown as ExtensionContext;
  expect((await gateExitContract(ctx))?.block).toBe(true);
  linkedComments = [{ text: "REVIEW node head_sha=new review_round=2" }];
  expect(await gateExitContract(ctx)).toBeUndefined();
 });
 test.each(["traversal", "symlink", "missing"])("artifact %s is not contained evidence", async kind => {
  await writeFile(path.join(fixture, "outside"), "outside");
  await symlink(path.join(fixture, "outside"), path.join(fixture, "artifacts/link"));
  const output = kind === "traversal" ? `${fixture}/artifacts/../outside`
   : path.join(fixture, "artifacts", kind === "symlink" ? "link" : "missing");
  bead = { id: BEAD, assignee: "", labels: ["agent:reviewer"], metadata: { execution_kind: "artifact", artifacts_dir: path.join(fixture, "artifacts"), output_ref: output } };
  comments = [{ text: "REPORTED artifact" }];
  expect(JSON.parse((await gateExitContract(CTX))!.reason!).failed_checks.map((failure: { check: string }) => failure.check)).toEqual(["artifact_path"]);
 });
 test("research without execution evidence cannot pass with zero checks", async () => {
  bead = { id: BEAD, assignee: "A" };
  const ctx = { getSystemPrompt: () => ["ORC-ROLE: researcher"] } as unknown as ExtensionContext;
  expect(JSON.parse((await gateExitContract(ctx))!.reason!).failed_checks[0].check).toBe("execution-kind");
 });
 test("unknown declared mode cannot bypass conditional checks", async () => {
  bead!.metadata = { execution_kind: "future" };
  expect(JSON.parse((await gateExitContract(CTX))!.reason!).failed_checks[0].check).toBe("execution-kind");
 });
 test("open escalation pauses work; closure restores completion checks without requeue writes", async () => {
  linked = ["question"];
  linkedBead = { id: "question", ephemeral: true, wisp_type: "escalation", status: "open" };
  expect(await gateExitContract(CTX)).toBeUndefined();
  expect(bead!.assignee).toBe("A");
  linkedBead.status = "closed";
  expect((await gateExitContract(CTX))?.block).toBe(true);
  expect(issued).toEqual([]);
 });
 test("blocked escape requires positively read declaration", async () => {
  bead!.status = "blocked";
  expect((await gateExitContract(CTX))?.block).toBe(true);
  comments = [{ text: "BLOCKED missing prerequisite" }];
  expect(await gateExitContract(CTX)).toBeUndefined();
  expect(issued).toEqual([]);
 });
 describe("a blocked exit deletes the clone like any other, so its work must be on origin or absent", () => {
  const HEAD = "abc1234abc1234abc1234abc1234abc1234abc12";
  beforeEach(() => {
   bead!.status = "blocked";
   comments = [{ text: "BLOCKED missing prerequisite" }];
  });
  test("clean tree at the base: nothing to lose, allowed as before", async () => {
   expect(await gateExitContract(CTX)).toBeUndefined();
   expect(asked).toEqual([]);
   expect(issued).toEqual([]);
  });
  test("commits past the base without a pushed token are refused", async () => {
   local = { head: HEAD, dirty: false };
   const verdict: { failed_checks: { check: string; detail: string; recovery?: string }[] } = JSON.parse((await gateExitContract(CTX))!.reason!);
   expect(verdict.failed_checks[0]!.check).toBe("escape");
   expect(verdict.failed_checks[0]!.detail).toContain(`the clone has commits at HEAD ${HEAD.slice(0, 7)} that origin does not hold`);
   expect(verdict.failed_checks[0]!.recovery).toContain("a blocked exit deletes your clone like any other");
  });
  test("an uncommitted change is refused, whatever origin holds", async () => {
   local = { head: BASE, dirty: true };
   expect(JSON.parse((await gateExitContract(CTX))!.reason!).failed_checks[0].detail).toContain("commit and push (`git push origin HEAD:$ORC_PUSH_REF`), or discard them, before yielding");
   expect(asked).toEqual([]);
  });
  test("commits past the base with the pushed ref at HEAD are allowed; a park keeps its claim, so nothing is stamped", async () => {
   local = { head: HEAD, dirty: false };
   comments = [{ text: "BLOCKED missing prerequisite" }, { text: `REPORTED partial: src/x.ts ${pushed(HEAD.slice(0, 7))}` }];
   remote = { kind: "at", sha: HEAD };
   expect(await gateExitContract(CTX)).toBeUndefined();
   expect(asked).toEqual(["omp/task/A"]);
   expect(issued).toEqual([]);
   expect(warned.map(entry => entry.cause)).toEqual(["status blocked keeps its claim"]);
  });
  test("a clone git cannot read is judged as work present", async () => {
   unreadableClone = true;

   expect(JSON.parse((await gateExitContract(CTX))!.reason!).failed_checks[0].detail).toContain("could not be read");
  });
 });
 test("a successor's claim by the time of the write refuses the exit and stamps nothing on its bead", async () => {
  bead = { id: BEAD, status: "in_progress", assignee: "A", labels: ["agent:reviewer"], metadata: { execution_kind: "git", head_sha: "abc1234" } };
  comments = [{ text: `REPORTED src/api.ts ${pushed("abc1234")}` }];
  const run = spyOn(actualBd, "bdRun").mockImplementation(async (args: string[]) => {
   issued.push(args);
   return { code: 1, stdout: "", stderr: `Error claiming ${BEAD}: issue already claimed by B` };
  });
  try {
   const result = await gateExitContract(CTX);
   expect(result?.block).toBe(true);
   expect(result?.reason).toContain("is now claimed by another actor");
   expect(result?.reason).toContain("already claimed by B");
   // The one write attempted was the fenced one; nothing else touched the bead.
   expect(issued).toEqual([["update", BEAD, "--actor", "A", "--claim", "--assignee", "", "--set-metadata", "pushed_sha=abc1234", "--status", "in_progress"]]);
  } finally {
   run.mockRestore();
   spies[3] = spyOn(actualBd, "bdRun").mockImplementation(async (args: string[]) => {
    issued.push(args);
    return { code: 0, stdout: "", stderr: "" };
   });
  }
 });
 test("a bead released before the proof is accepted with no write; the missing stamp is logged", async () => {
  // bd 1.2.2 claims nothing that is not `open`, so a released `in_progress` bead has no
  // fence for anyone. An unfenced stamp could land on a successor's claim, so none is written.
  bead = { id: BEAD, status: "in_progress", assignee: "", labels: ["agent:reviewer"], metadata: { execution_kind: "git", head_sha: "abc1234" } };
  comments = [{ text: `REPORTED src/api.ts ${pushed("abc1234")}` }];
  expect(await gateExitContract(CTX)).toBeUndefined();
  expect(issued).toEqual([]);
  expect(warned).toEqual([{ bead: BEAD, sha: "abc1234", cause: "released before proof" }]);
 });
});

/**
 * Git work is judged as work. Found by a run in which a worker wrote REPORTED, added the
 * handoff label, stamped `head_sha` equal to the base commit, released, and was accepted
 * at the first attempt with nothing changed.
 */
describe("G4 zero-work report", () => {
 const HEAD = "d4ca85f1e2b3c4d5e6f708192a3b4c5d6e7f8091";
 /** A checkout under a bound run: its marker names `orc-run`, so the epic's base is read. */
 let runRoot: string;
 let priorMarker: string | undefined;

 beforeAll(async () => {
  runRoot = await realpath(await mkdtemp(path.join(tmpdir(), "orc-exit-run-")));
  await mkdir(path.dirname(markerPath(runRoot)), { recursive: true });
  await writeFile(markerPath(runRoot), JSON.stringify({ schema_version: 1, run_id: "orc-run" }));
  priorMarker = process.env.ORCHESTRATE_MARKER_FILE;
  delete process.env.ORCHESTRATE_MARKER_FILE;
 });
 afterAll(async () => {
  if (priorMarker !== undefined) process.env.ORCHESTRATE_MARKER_FILE = priorMarker;
  await rm(runRoot, { recursive: true, force: true });
 });

 function ctxIn(root: string): ExtensionContext {
  return { cwd: root, getSystemPrompt: () => ["ORC-ROLE: implementer"] } as unknown as ExtensionContext;
 }
 function checks(result: ToolCallEventResult | undefined): string[] {
  expect(result?.block).toBe(true);
  const verdict: { failed_checks: { check: string }[] } = JSON.parse(result!.reason!);
  return verdict.failed_checks.map(failure => failure.check);
 }
 /** A released, handed-off git bead at `head`, with its own `base_sha` when `ownBase` is given. */
 function released(head: string, ownBase?: string): BdBead {
  return {
   id: BEAD, status: "in_progress", assignee: "", labels: ["agent:reviewer"],
   metadata: { execution_kind: "git", head_sha: head, ...(ownBase === undefined ? {} : { base_sha: ownBase }) },
  };
 }

 test("a head equal to the run epic's base with no changed path is refused on both counts", async () => {
  bead = released(BASE);
  comments = [{ text: `REPORTED ${BEAD} head_sha=${BASE.slice(0, 7)} ${pushed(BASE.slice(0, 7))}` }];
  expect(checks(await gateExitContract(ctxIn(runRoot)))).toEqual(["work", "changed_paths"]);
  // The base came from the run epic, read once through the marker's run id.
  expect(shown).toEqual(["orc-run"]);
 });

 test("a moved head naming a changed path passes", async () => {
  bead = released(HEAD);
  comments = [{ text: `REPORTED docs/faq.md changed; head_sha ${HEAD.slice(0, 7)} ${pushed(HEAD.slice(0, 7))}` }];
  expect(await gateExitContract(ctxIn(runRoot))).toBeUndefined();
 });

 test("the bead's own base_sha wins, and costs no epic read", async () => {
  bead = released(HEAD, HEAD.slice(0, 7));
  comments = [{ text: `REPORTED src/x.ts ${pushed(HEAD)}` }];
  expect(checks(await gateExitContract(ctxIn(runRoot)))).toEqual(["work"]);
  expect(shown).toEqual([]);
 });

 test.each([
  ["a path in a key=value list", `REPORTED files=src/a.ts,src/b.ts head_sha=abc ${pushed(HEAD)}`],
  ["a backticked file name", `REPORTED updated \`README.md\` ${pushed(HEAD)}`],
  ["a bracketed path", `REPORTED [docs/guide/install.md] rewritten ${pushed(HEAD)}`],
 ])("%s counts as a changed path", async (_label, text) => {
  bead = released(HEAD);
  comments = [{ text }];
  expect(await gateExitContract(ctxIn(runRoot))).toBeUndefined();
 });

 test.each([
  ["a sha and a count", `REPORTED 3 files, head_sha=abc1234, tests green ${pushed(HEAD)}`],
  ["a URL alone", `REPORTED see https://example.com/pr/2 ${pushed(HEAD)}`],
  ["a version number", `REPORTED bumped to 1.2.3 ${pushed(HEAD)}`],
 ])("%s is not a changed path", async (_label, text) => {
  bead = released(HEAD);
  comments = [{ text }];
  expect(checks(await gateExitContract(ctxIn(runRoot)))).toEqual(["changed_paths"]);
 });

 test.each([
  `NOTE no-change: the faq already documents the new input format`,
  `NOTE ${BEAD} no-change: nothing to edit after reading the spec`,
  `- **NOTE** no-change: verified in place`,
 ])("an explicit no-change note waives both checks: %s", async note => {
  bead = released(BASE);
  comments = [{ text: note }, { text: `REPORTED ${BEAD} nothing changed ${pushed(BASE)}` }];
  expect(await gateExitContract(ctxIn(runRoot))).toBeUndefined();
 });

 test.each(["NOTE no-change:", "NOTE no-change", "NOTE nothing changed, no-change: really"])(
  "a note that states no reason, or buries the marker, waives nothing: %s",
  async note => {
   bead = released(BASE);
   comments = [{ text: note }, { text: `REPORTED ${BEAD} done ${pushed(BASE)}` }];
   expect(checks(await gateExitContract(ctxIn(runRoot)))).toEqual(["work", "changed_paths"]);
  },
 );

 test("no recorded base anywhere leaves the head comparison unknown", async () => {
  epic = { id: "orc-run", status: "in_progress" };
  bead = released(BASE);
  comments = [{ text: `REPORTED src/x.ts ${pushed(BASE)}` }];
  expect(await gateExitContract(ctxIn(runRoot))).toBeUndefined();
 });

 test("an unreadable run epic fails the comparison open, says why, and still judges the rest", async () => {
  epic = null;
  bead = released(BASE);
  comments = [{ text: `REPORTED ${BEAD} done ${pushed(BASE)}` }];
  expect(checks(await gateExitContract(ctxIn(runRoot)))).toEqual(["changed_paths"]);
  expect(warned.map(entry => entry.epic)).toEqual(["orc-run"]);
 });

 test("outside a bound run there is no epic to read", async () => {
  bead = released(BASE);
  comments = [{ text: `REPORTED src/x.ts ${pushed(BASE)}` }];
  expect(await gateExitContract(CTX)).toBeUndefined();
  expect(shown).toEqual([]);
 });

 test("a bead without a head spends no epic read: delivery already speaks", async () => {
  bead = released(HEAD);
  delete bead.metadata!.head_sha;
  comments = [{ text: `REPORTED src/x.ts ${pushed(HEAD)}` }];
  expect(checks(await gateExitContract(ctxIn(runRoot)))).toEqual(["delivery"]);
  expect(shown).toEqual([]);
 });
});

describe("G4 unclaimed exit", () => {
 beforeEach(() => {
  claims = createClaimState();
  claims = createClaimState();
 gateExitContract = createExitGuard(claims);
 });

 test("a role-marked worker holding no claim is refused once", async () => {
  const result = await gateExitContract(CTX, { result: { data: "wrote src/greet.ts, all done" } });

  expect(result?.block).toBe(true);
  expect(result?.reason).toContain("without ever claiming a bead");
  // Nothing to mutate: there is no bead to carry a bounce counter.
  expect(issued).toEqual([]);
 });

 test("the refusal never repeats, so a revived worker cannot be trapped", async () => {
  // A worker revived after a crash holds a claim this process never observed.
  expect((await gateExitContract(CTX, { result: { data: "done" } }))?.block).toBe(true);
  expect(await gateExitContract(CTX, { result: { data: "done" } })).toBeUndefined();
 });

 test("a declared NO_WORK exit is allowed immediately", async () => {
  expect(await gateExitContract(CTX, { result: { data: "NO_WORK: implementer queue is empty" } })).toBeUndefined();
 });

 /**
  * The other honest claimless exit. The pull hands the loser of a simultaneous claim
  * a Dolt serialization failure and nothing else, even with a second bead still
  * unclaimed -- so this worker's queue was not empty and `NO_WORK` would be false.
  */
 test.each([
  ["the Dolt error", "dolt commit: Error 1213 (40001): serialization failure: this transaction conflicts"],
  ["the SQL state alone", "claim lost after 3 retries at 2s/5s/10s, last error 40001"],
  ["the prose signature", "BLOCKED: three pulls lost, the last a serialization failure"],
 ])("a contention exit quoting %s is allowed", async (_label, quoted) => {
  expect(await gateExitContract(CTX, { result: { data: quoted } })).toBeUndefined();
  // No bead, so nothing to mutate either way.
  expect(issued).toEqual([]);
 });

 // Otherwise the claim is optional: any worker skips it by asserting a race it never
 // ran. The quoted error is the one part of the exit only a real pull produces.
 test.each(["BLOCKED", "BLOCKED: could not claim anything", "BLOCKED: contention on the queue, giving up"])(
  "a bare BLOCKED carrying no error is still refused (%s)",
  async data => {
   expect((await gateExitContract(CTX, { result: { data } }))?.block).toBe(true);
   expect(issued).toEqual([]);
  },
 );

 test("a contract-free session is not asked to claim anything", async () => {
  // No ORC-ROLE marker: an architect helper or a bundled spawn, neither of
  // which pulls work, so insisting on a claim would break both.
  const helper = { getSystemPrompt: () => ["you are a helpful assistant"] } as unknown as ExtensionContext;
  expect(await gateExitContract(helper, { result: { data: "done" } })).toBeUndefined();
 });

 test("a yield with no payload still gets the reminder", async () => {
  expect((await gateExitContract(CTX))?.block).toBe(true);
 });
});
