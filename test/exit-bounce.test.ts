import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { BdBead, BdComment } from "../src/bd";
import * as actualBd from "../src/bd";
import { createClaimState } from "../src/claim-state";
import { createExitGuard } from "../src/gates/exit";

const BEAD = "orc-42";
const CTX = { getSystemPrompt: () => ["ORC-ROLE: implementer"] } as unknown as ExtensionContext;
let bead: BdBead | null;
let comments: BdComment[] | null;
let linked: string[] | null;
let linkedBead: BdBead | null;
let linkedComments: BdComment[] | null;
let issued: string[][];
let fixture: string;
let claims = createClaimState();
let gateExitContract: ReturnType<typeof createExitGuard>;
const spies = [
 spyOn(actualBd, "bdShow").mockImplementation(async id => id === BEAD ? bead : linkedBead),
 // Linked beads arrive through the one-call hydration; an unreadable linked bead is a
 // failed read, so the whole map is unknown rather than one entry missing.
 spyOn(actualBd, "bdShowMany").mockImplementation(async ids => {
  const hydrated = linkedBead;
  return hydrated === null ? null : new Map(ids.map(id => [id, hydrated]));
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
 bead = { id: BEAD, status: "in_progress", assignee: "A", metadata: { execution_kind: "git" } };
 comments = [];
 linked = [];
 linkedBead = null;
 linkedComments = [];
 claims.recordClaim({ actor: "A", beadIds: [BEAD] });
});

test("released shepherd preserves inherited approval on an exact-head IDLE exit", async () => {
 bead = {
  id: BEAD,
  status: "open",
  assignee: "",
  labels: ["orc-merge", "state:approved"],
  metadata: { role: "shepherd", execution_kind: "git", head_sha: "abc123" },
 };
 comments = [{ text: `IDLE ${BEAD} head_sha=abc123 waiting for merge window` }];
 const shepherd = { getSystemPrompt: () => ["ORC-ROLE: shepherd"] } as unknown as ExtensionContext;
 expect(await gateExitContract(shepherd)).toBeUndefined();
 expect(bead.labels).toContain("state:approved");
 expect(bead.assignee).toBe("");
 expect(issued).toEqual([]);
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
  bead = { id: BEAD, status: "blocked", assignee: "A" };
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
  comments = [{ text: `IDLE ${BEAD} waiting for merge window` }];
  bead.assignee = "";
  expect(await gateExitContract(shepherd)).toBeUndefined();
  expect(issued).toEqual([]);
 });
 test("a git implementer can report and release before host branch capture", async () => {
  bead = { id: BEAD, status: "in_progress", assignee: "", labels: ["agent:reviewer"], metadata: { execution_kind: "git", head_sha: "abc123" } };
  comments = [{ text: "REPORTED committed abc123" }];
  expect(await gateExitContract(CTX)).toBeUndefined();
  delete bead.metadata!.head_sha;
  expect((await gateExitContract(CTX))?.block).toBe(true);
 });
 test.each(["artifact", "comment", "external"])("%s writer completion requires handoff and release", async kind => {
  bead = { id: BEAD, status: "in_progress", assignee: "A", metadata: { execution_kind: kind, artifacts_dir: path.join(fixture, "artifacts"), output_ref: path.join(fixture, "artifacts/result") } };
  comments = [{ text: "REPORTED result" }];
  const result = await gateExitContract(CTX);
  expect(JSON.parse(result!.reason!).failed_checks.map((failure: { check: string }) => failure.check)).toEqual(["handoff", "unclaimed"]);
  bead.assignee = "";
  bead.labels = ["agent:reviewer"];
  expect(await gateExitContract(CTX)).toBeUndefined();
 });
 test.each(["review", "escalation"])("claimed %s wisp reads its outgoing node verdict", async kind => {
  bead = { id: BEAD, ephemeral: true, wisp_type: kind, assignee: "", status: "closed" };
  linked = ["node"];
  linkedBead = { id: "node" };
  linkedComments = [{ text: kind === "review" ? "REVIEW approved" : "ADVICE use the existing API" }];
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
