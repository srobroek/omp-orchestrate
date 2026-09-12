import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolCallEventResult } from "@oh-my-pi/pi-coding-agent";
import * as actualBd from "../src/bd";
import { BD_NOTICE_MESSAGE } from "../src/gates/bd";
import ompOrchestrate from "../src/index";

/** Exercise the registered handlers, not just individual gates or hook counts. */

interface Sent {
 customType?: string;
 content?: string;
 deliverAs?: string;
}
interface LoggedError {
 message: string;
 details: unknown;
}


type ToolCallHandler = (
 event: { toolName: string; toolCallId?: string; input: unknown },
 ctx: ExtensionContext,
) => Promise<ToolCallEventResult | undefined>;
type LifecycleHandler = (event: unknown, ctx: ExtensionContext) => Promise<void>;

/** The registered handlers and the side channels a run of them leaves behind. */
interface Harness {
 pi: ExtensionAPI;
 handlers: ToolCallHandler[];
 starts: LifecycleHandler[];
 results: LifecycleHandler[];
 turns: LifecycleHandler[];
 sent: Sent[];
 errors: LoggedError[];
}

function runtimeApi(): Harness {
 const handlers: ToolCallHandler[] = [];
 const sent: Sent[] = [];
 const errors: LoggedError[] = [];
 const starts: LifecycleHandler[] = [];
 const results: LifecycleHandler[] = [];
 const turns: LifecycleHandler[] = [];
 const zodStub: unknown = new Proxy(() => zodStub, { get: () => zodStub, apply: () => zodStub });
 const stub = {
  setLabel: () => { },
  on: (event: string, handler: unknown) => {
   if (event === "tool_call") handlers.push(handler as ToolCallHandler);
   if (event === "session_start") starts.push(handler as LifecycleHandler);
   if (event === "tool_result") results.push(handler as LifecycleHandler);
   if (event === "turn_end") turns.push(handler as LifecycleHandler);
  },
  registerCommand: () => { },
  registerTool: () => { },
  zod: zodStub,
  getAllTools: () => [],
  logger: { error: (message: string, details: unknown) => { errors.push({ message, details }); }, debug: () => { }, warn: () => { }, info: () => { } },
  sendMessage: (message: { customType?: string; content?: string }, options?: { deliverAs?: string }) => {
   sent.push({ customType: message.customType, content: message.content, deliverAs: options?.deliverAs });
  },
 };
 return { pi: stub as unknown as ExtensionAPI, handlers, starts, results, turns, sent, errors };
}

/** The same factory as a spawned worker sees it: the hidden `yield` tool is present. */
function workerApi(): Harness {
 const api = runtimeApi();
 Object.assign(api.pi, { getAllTools: () => [{ name: "yield" }] });
 return api;
}

/** Dispatch to every subscriber, as OMP does; registration order is not a contract. */
async function dispatchAll(
 handlers: ToolCallHandler[],
 event: { toolName: string; toolCallId?: string; input: unknown },
 ctx: { cwd: string; role?: string },
): Promise<(ToolCallEventResult | undefined)[]> {
 if (handlers.length === 0) throw new Error("no tool_call handler was registered");
 const prompt = ctx.role === undefined ? [] : [`ORC-ROLE: ${ctx.role}`];
 const runtimeCtx = { cwd: ctx.cwd, getSystemPrompt: () => prompt } as unknown as ExtensionContext;
 const results: (ToolCallEventResult | undefined)[] = [];
 for (const handler of handlers) results.push(await handler(event, runtimeCtx));
 return results;
}

/**
 * The one answer among every subscriber's, or `undefined` when none spoke. Several
 * handlers answering one call is an ambiguity, not a result, and fails the test.
 */
async function verdict(
 handlers: ToolCallHandler[],
 event: { toolName: string; toolCallId?: string; input: unknown },
 ctx: { cwd: string; role?: string },
): Promise<ToolCallEventResult | undefined> {
 const spoken = (await dispatchAll(handlers, event, ctx)).filter(result => result !== undefined);
 if (spoken.length > 1) throw new Error(`${spoken.length} handlers answered one call: ${JSON.stringify(spoken)}`);
 return spoken[0];
}

/**
 * A run pinned to `dir`: the marker in its `.orchestration/` and the process pin on a
 * `.beads` beside it, which is how `/orchestrate-run` leaves a lead session.
 */
async function pinnedRun(dir: string, body = JSON.stringify({ schema_version: 1, run_id: "run-wiring" })): Promise<void> {
 await fs.mkdir(path.join(dir, ".orchestration"), { recursive: true });
 await fs.writeFile(path.join(dir, ".orchestration", ".active-run"), body);
 process.env.BEADS_DIR = path.join(dir, ".beads");
}

describe("gate dispatcher wiring", () => {
 let dir: string;
 let previousPin: string | undefined;

 beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "orc-wiring-"));
  // Every case states its own run scope; the ambient shell's pin must not supply one.
  previousPin = process.env.BEADS_DIR;
  delete process.env.BEADS_DIR;
 });

 afterEach(async () => {
  if (previousPin === undefined) delete process.env.BEADS_DIR;
  else process.env.BEADS_DIR = previousPin;
  await fs.rm(dir, { recursive: true, force: true });
 });

 test("an unattributed bd write inside a run emits the identity notice as a steer", async () => {
  await pinnedRun(dir, "run-wiring-1");
  const { pi, handlers, sent } = runtimeApi();
  ompOrchestrate(pi);

  const results = await dispatchAll(
   handlers,
   { toolName: "bash", input: { command: "bd update orc-1 --status in_progress" } },
   { cwd: dir },
  );

  // The notice never refuses: no subscriber blocks, and the command runs.
  expect(results.some((result) => result?.block === true)).toBe(false);
  expect(sent).toHaveLength(1);
  expect(sent[0]?.customType).toBe(BD_NOTICE_MESSAGE);
  expect(sent[0]?.content).toContain("WARN bd identity");
  // Mid-turn: a steer is consumed at the model call carrying this tool's result.
  expect(sent[0]?.deliverAs).toBe("steer");
 });

 test("the same call outside a run emits nothing", async () => {
  const { pi, handlers, sent } = runtimeApi();
  ompOrchestrate(pi);

  await dispatchAll(
   handlers,
   { toolName: "bash", input: { command: "bd update orc-1 --status in_progress" } },
   { cwd: dir },
  );

  // No marker, no notice: this is what keeps the gate off every unrelated session
  // in a repository that happens to hold this plugin.
  expect(sent).toHaveLength(0);
 });

 test("an attributed write inside a run emits nothing", async () => {
  await pinnedRun(dir, "run-wiring-2");
  const { pi, handlers, sent } = runtimeApi();
  ompOrchestrate(pi);

  await dispatchAll(
   handlers,
   {
    toolName: "bash",
    input: { command: "bd update orc-1 --status in_progress", env: { BEADS_ACTOR: "impl-1" } },
   },
   { cwd: dir },
  );

  expect(sent).toHaveLength(0);
 });

 test("rewrites a matching runtime database alias to the canonical session pin", async () => {
  await pinnedRun(dir);
  const beadsDir = process.env.BEADS_DIR as string;
  const alias = path.join(dir, "run-beads-alias");
  await fs.mkdir(beadsDir);
  await fs.symlink(beadsDir, alias, "dir");
  const { pi, handlers, errors } = runtimeApi();
  ompOrchestrate(pi);

  const results = await dispatchAll(
   handlers,
   { toolName: "bash", input: { command: "echo ok", env: { BEADS_DIR: alias }, derivedGateOnlyField: "must not survive" } },
   { cwd: dir },
  );
  const revision = results.find(result => result?.input !== undefined);

  expect(errors).toEqual([]);
  expect(revision?.input).toEqual({ command: "echo ok", env: { BEADS_DIR: await fs.realpath(beadsDir) } });
  expect(revision?.input).not.toHaveProperty("derivedGateOnlyField");
 });

 test("a tool the gate does not cover reaches no gate at all", async () => {
  await pinnedRun(dir, "run-wiring-3");
  const { pi, handlers, sent } = runtimeApi();
  ompOrchestrate(pi);

  const results = await dispatchAll(handlers, { toolName: "read", input: { path: "README.md" } }, { cwd: dir });

  expect(results.every((result) => result === undefined)).toBe(true);
  expect(sent).toHaveLength(0);
 });

 test("only contract-bound workers in a pinned run receive the claim protocol", async () => {
  await pinnedRun(dir, "run-wiring-contract");
  for (const [prompt, worker, expected] of [
   ["helper", true, false],
   ["ORC-ROLE: implementer", true, true],
   ["ORC-ROLE: implementer", false, false],
  ] as const) {
   const { pi, starts, sent } = worker ? workerApi() : runtimeApi();
   ompOrchestrate(pi);
   const ctx = {
    cwd: dir,
    getSystemPrompt: () => [prompt],
    sessionManager: { getSessionId: () => "wiring-worker" },
   } as unknown as ExtensionContext;
   // Lifecycle watchers are registered separately; the protocol injector is the final subscriber.
   await starts.at(-1)?.({}, ctx);
   expect(sent.some(message => message.customType === "com.srobroek.omp-orchestrate.contract")).toBe(expected);
  }
 });

 test("a contract-bound worker outside a pinned run receives no protocol", async () => {
  // The marker alone is the old run gate; without the process pin an isolated worker
  // could not find it, and a worker whose cwd holds a stray marker is not in this run.
  await fs.mkdir(path.join(dir, ".orchestration"), { recursive: true });
  await fs.writeFile(path.join(dir, ".orchestration", ".active-run"), "run-wiring-unpinned");
  const { pi, starts, sent } = workerApi();
  ompOrchestrate(pi);
  const ctx = {
   cwd: dir,
   getSystemPrompt: () => ["ORC-ROLE: implementer"],
   sessionManager: { getSessionId: () => "wiring-worker" },
  } as unknown as ExtensionContext;
  await starts.at(-1)?.({}, ctx);
  expect(sent.some(message => message.customType === "com.srobroek.omp-orchestrate.contract")).toBe(false);
 });

 /**
  * The calls the run-scoped checks refuse, each in the shape an ordinary session reaches
  * for: a read of the pin, a commit message quoting an assignment, OMP's own worktree
  * command, and a structured override pointing at another database.
  */
 const SCOPED_REFUSALS: [string, Record<string, unknown>][] = [
  ["a read of the pin variable", { command: "printenv BEADS_DIR" }],
  ["a quoted mention in a commit message", { command: 'git commit -m "docs: reproduce with BEADS_DIR=/tmp/x bd list"' }],
  ["a worktree command", { command: "git worktree add ../scratch" }],
  ["a structured override of the database", { command: "bd list --json", env: { BEADS_DIR: "/tmp/another/.beads" } }],
 ];

 test.each(SCOPED_REFUSALS)("a role-less session under no pinned run is not refused %s", async (_label, input) => {
  const { pi, handlers, errors } = runtimeApi();
  ompOrchestrate(pi);

  const results = await dispatchAll(handlers, { toolName: "bash", input }, { cwd: dir });

  expect(errors).toEqual([]);
  expect(results.every(result => result === undefined)).toBe(true);
 });

 test("a claim observed under no pinned run is not recorded", async () => {
  // Discriminating, because the write is dispatched after the run is pinned: a claim
  // recorded earlier would send G2 to `bdShow`, whose stub names a tree this cwd is not
  // in, and the write would be refused.
  const show = spyOn(actualBd, "bdShow").mockResolvedValue({
   id: "orc-hand", status: "in_progress", assignee: "me", metadata: { worktree: "/somewhere/else" },
  });
  try {
   const { pi, handlers, results: observers } = runtimeApi();
   ompOrchestrate(pi);
   const claimReport = {
    toolName: "bash", isError: false, input: { command: "bd update orc-hand --claim --json" }, details: {},
    content: [{ type: "text", text: JSON.stringify([{ id: "orc-hand", status: "in_progress", assignee: "me" }]) }],
   };
   for (const observe of observers) await observe(claimReport, { cwd: dir, getSystemPrompt: () => [] } as unknown as ExtensionContext);
   await pinnedRun(dir);

   const results = await dispatchAll(handlers, { toolName: "write", input: { path: path.join(dir, "notes.md"), content: "x" } }, { cwd: dir });

   expect(results.every(result => result === undefined)).toBe(true);
   expect(show).not.toHaveBeenCalled();
  } finally {
   show.mockRestore();
  }
 });

 test.each(SCOPED_REFUSALS)("a role-less session in a pinned run is refused %s", async (_label, input) => {
  await pinnedRun(dir);
  const { pi, handlers, errors } = runtimeApi();
  ompOrchestrate(pi);

  const results = await dispatchAll(handlers, { toolName: "bash", input }, { cwd: dir });

  expect(errors).toEqual([]);
  expect(results.some(result => result?.block === true)).toBe(true);
 });

 test("a declared role is under orchestration without any pin: G3 refuses the checkout and names the route", async () => {
  const { pi, handlers, errors } = runtimeApi();
  ompOrchestrate(pi);

  const results = await dispatchAll(
   handlers,
   { toolName: "bash", input: { command: "git worktree add ../scratch" } },
   { cwd: dir, role: "implementer" },
  );

  expect(errors).toEqual([]);
  const refusal = results.find(result => result?.block === true);
  expect(refusal?.reason).toContain("wt switch");
 });

 test("an isolated worker finds the run through the pinned repository", async () => {
  // The isolated copy's cwd holds no marker; the pin's parent does.
  await pinnedRun(dir);
  const isolated = await fs.mkdtemp(path.join(os.tmpdir(), "orc-wiring-isolated-"));
  try {
   const { pi, handlers } = runtimeApi();
   ompOrchestrate(pi);

   const results = await dispatchAll(
    handlers,
    { toolName: "bash", input: { command: "git worktree add ../scratch" } },
    { cwd: isolated },
   );

   expect(results.some(result => result?.block === true)).toBe(true);
  } finally {
   await fs.rm(isolated, { recursive: true, force: true });
  }
 });
});

/**
 * Each gate once through the real handler from a worker's seat, so a gate the dispatcher
 * stops calling, a tool it stops inspecting, or a branch that throws has a test to fail.
 * `test/gate-matrix.test.ts` composes the gates itself; these rows are about `index.ts`.
 */
describe("gate dispatcher wiring: a worker's calls reach every gate", () => {
 let dir: string;
 let previousPin: string | undefined;
 let previousWorktreeDir: string | undefined;

 beforeEach(async () => {
  // realpath: macOS reaches `/var` through a link and G2 compares resolved paths.
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "orc-wiring-worker-")));
  previousPin = process.env.BEADS_DIR;
  delete process.env.BEADS_DIR;
  // A base that does not exist, so OMP's isolation exemption cannot fire by accident.
  previousWorktreeDir = process.env.OMP_WORKTREE_DIR;
  process.env.OMP_WORKTREE_DIR = path.join(dir, "no-such-isolation-base");
 });

 afterEach(async () => {
  if (previousPin === undefined) delete process.env.BEADS_DIR;
  else process.env.BEADS_DIR = previousPin;
  if (previousWorktreeDir === undefined) delete process.env.OMP_WORKTREE_DIR;
  else process.env.OMP_WORKTREE_DIR = previousWorktreeDir;
  await fs.rm(dir, { recursive: true, force: true });
 });

 /** One worker call; the role is what puts the session under orchestration here. */
 function call(toolCallId: string, command: string): { toolName: string; toolCallId: string; input: unknown } {
  return { toolName: "bash", toolCallId, input: { command } };
 }

 test("a two-bead named claim is refused by G5 before any bead is read", async () => {
  const show = spyOn(actualBd, "bdShow").mockResolvedValue(null);
  try {
   const { pi, handlers, errors } = workerApi();
   ompOrchestrate(pi);

   const result = await verdict(handlers, call("claim-two", "bd update orc-1 orc-2 --claim"), { cwd: dir, role: "implementer" });

   expect(errors).toEqual([]);
   expect(result?.block).toBe(true);
   expect(result?.reason).toContain("one bead");
   expect(show).not.toHaveBeenCalled();
  } finally {
   show.mockRestore();
  }
 });

 test("a write outside the claimed tree is refused by G2 with the bead that owns the tree", async () => {
  const owned = path.join(dir, "owned");
  const foreign = path.join(dir, "foreign");
  await fs.mkdir(owned);
  await fs.mkdir(foreign);
  const show = spyOn(actualBd, "bdShow").mockResolvedValue({
   id: "orc-hand", status: "in_progress", assignee: "me", metadata: { worktree: owned },
  });
  try {
   await pinnedRun(dir);
   const { pi, handlers, results: observers, errors } = workerApi();
   ompOrchestrate(pi);
   const claimReport = {
    toolName: "bash", toolCallId: "claim-hand", isError: false, input: { command: "bd update orc-hand --claim --json" }, details: {},
    content: [{ type: "text", text: JSON.stringify([{ id: "orc-hand", status: "in_progress", assignee: "me" }]) }],
   };
   const ctx = { cwd: owned, getSystemPrompt: () => ["ORC-ROLE: implementer"] } as unknown as ExtensionContext;
   for (const observe of observers) await observe(claimReport, ctx);

   const result = await verdict(
    handlers,
    { toolName: "write", toolCallId: "write-out", input: { path: path.join(foreign, "notes.md"), content: "x" } },
    { cwd: owned, role: "implementer" },
   );

   expect(errors).toEqual([]);
   expect(result?.block).toBe(true);
   expect(result?.reason).toContain("orc-hand");
   expect(result?.reason).toContain("metadata.worktree");
  } finally {
   show.mockRestore();
  }
 });

 test("a generic helper in an isolated copy is sandboxed by G1 through the pinned repository", async () => {
  // The helper's cwd holds no marker and it declares no role; the pin's parent has the
  // marker, which is the second root G1 documents and the one an isolated helper needs.
  await pinnedRun(dir);
  const isolated = path.join(dir, "isolated-copy");
  await fs.mkdir(isolated);
  const { pi, handlers, errors } = workerApi();
  ompOrchestrate(pi);

  const result = await verdict(handlers, call("helper-echo", "echo ok"), { cwd: isolated });

  expect(errors).toEqual([]);
  expect(result?.input).toEqual({ command: "echo ok", env: { BEADS_DIR: path.join(dir, ".beads"), BD_READONLY: "1" } });
 });

 test("a generic helper that sets the sandbox variable inline is refused by G1", async () => {
  await pinnedRun(dir);
  const { pi, handlers, errors } = workerApi();
  ompOrchestrate(pi);

  const result = await verdict(handlers, call("helper-escape", "BD_READONLY=0 bd update orc-1 --status closed"), { cwd: dir });

  expect(errors).toEqual([]);
  expect(result?.block).toBe(true);
  expect(result?.reason).toContain("BD_READONLY=1 is the read-only sandbox");
 });

 test("a gate that throws fails the call open and logs the cause", async () => {
  const show = spyOn(actualBd, "bdShow").mockImplementation(async () => { throw new Error("boom from bdShow"); });
  try {
   const { pi, handlers, errors } = workerApi();
   ompOrchestrate(pi);

   const result = await verdict(handlers, call("claim-boom", "bd update orc-1 --claim"), { cwd: dir, role: "implementer" });

   expect(result).toBeUndefined();
   expect(errors).toEqual([{ message: "orchestrate gate failed open", details: { tool: "bash", error: "boom from bdShow" } }]);
  } finally {
   show.mockRestore();
  }
 });

 describe("one claim in flight per turn", () => {
  /** A bead routed to no role and naming no territory: G5 allows any session to claim it. */
  const plain = (id: string) => ({ id, status: "open", labels: [], metadata: {} });

  test("a second claim while the first awaits its result is refused, and passes once the result lands", async () => {
   const show = spyOn(actualBd, "bdShow").mockImplementation(async id => plain(id));
   try {
    const { pi, handlers, results: observers, errors } = workerApi();
    ompOrchestrate(pi);
    const worker = { cwd: dir, role: "implementer" };

    const first = await verdict(handlers, call("claim-1", "bd update orc-1 --claim --json"), worker);
    const second = await verdict(handlers, call("claim-2", "bd update orc-2 --claim --json"), worker);

    expect(first).toBeUndefined();
    expect(second?.block).toBe(true);
    expect(second?.reason).toContain("a claim is already in flight this turn");

    // The first call's result, whatever it says: a failed claim records nothing but
    // still settles the mark.
    const failed = { toolName: "bash", toolCallId: "claim-1", isError: true, input: { command: "bd update orc-1 --claim --json" }, details: {}, content: [] };
    const ctx = { cwd: dir, getSystemPrompt: () => ["ORC-ROLE: implementer"] } as unknown as ExtensionContext;
    for (const observe of observers) await observe(failed, ctx);

    const third = await verdict(handlers, call("claim-3", "bd update orc-3 --claim --json"), worker);

    expect(errors).toEqual([]);
    expect(third).toBeUndefined();
   } finally {
    show.mockRestore();
   }
  });

  test("the turn's end lifts a mark whose call never produced a result", async () => {
   const show = spyOn(actualBd, "bdShow").mockImplementation(async id => plain(id));
   try {
    const { pi, handlers, turns } = workerApi();
    ompOrchestrate(pi);
    const worker = { cwd: dir, role: "implementer" };
    const ctx = { cwd: dir, getSystemPrompt: () => ["ORC-ROLE: implementer"] } as unknown as ExtensionContext;

    expect(await verdict(handlers, call("claim-1", "bd update orc-1 --claim --json"), worker)).toBeUndefined();
    for (const turnEnd of turns) await turnEnd({}, ctx);

    expect(await verdict(handlers, call("claim-2", "bd update orc-2 --claim --json"), worker)).toBeUndefined();
   } finally {
    show.mockRestore();
   }
  });

  test("a refused claim leaves no mark behind", async () => {
   // The refusal here is G5's own: a two-bead claim. Had it marked the call, the
   // legitimate single-bead claim after it would be refused for a result never coming.
   const show = spyOn(actualBd, "bdShow").mockImplementation(async id => plain(id));
   try {
    const { pi, handlers } = workerApi();
    ompOrchestrate(pi);
    const worker = { cwd: dir, role: "implementer" };

    expect((await verdict(handlers, call("claim-two", "bd update orc-1 orc-2 --claim"), worker))?.block).toBe(true);
    expect(await verdict(handlers, call("claim-one", "bd update orc-3 --claim --json"), worker)).toBeUndefined();
   } finally {
    show.mockRestore();
   }
  });
 });

 describe("the spawn gate on task", () => {
  const SHAPE = 'agent: "orc-implementer", task: "<epic id + queue, not the work>", isolated: true';

  test("an implementer spawned without isolation is refused with the spawn shape", async () => {
   await pinnedRun(dir);
   const { pi, handlers, errors } = runtimeApi();
   ompOrchestrate(pi);

   const result = await verdict(
    handlers,
    { toolName: "task", toolCallId: "spawn-flat", input: { name: "Impl1", agent: "orc-implementer", task: "epic orc-1" } },
    { cwd: dir },
   );

   expect(errors).toEqual([]);
   expect(result?.block).toBe(true);
   expect(result?.reason).toContain("'Impl1'");
   expect(result?.reason).toContain(SHAPE);
  });

  test("a batch names the entry that lacks isolation", async () => {
   const { pi, handlers } = runtimeApi();
   ompOrchestrate(pi);
   const input = {
    context: "wave 1",
    tasks: [
     { name: "A", agent: "orc-implementer", task: "orc-1", isolated: true },
     { name: "B", agent: "orc-implementer", task: "orc-2", isolated: false },
    ],
   };

   const result = await verdict(handlers, { toolName: "task", toolCallId: "spawn-batch", input }, { cwd: dir, role: "architect" });

   expect(result?.block).toBe(true);
   expect(result?.reason).toContain("'B'");
   expect(result?.reason).not.toContain("'A'");
  });

  test.each([
   ["an isolated implementer", { name: "Impl1", agent: "orc-implementer", task: "epic orc-1", isolated: true }],
   ["a reviewer, whose isolation is a dispatch decision", { name: "Rev", agent: "orc-reviewer", task: "epic orc-1" }],
   ["an isolated batch", { context: "wave 1", tasks: [{ name: "A", agent: "orc-implementer", task: "orc-1", isolated: true }] }],
   ["a plain helper", { task: "count the tests" }],
  ])("allows %s", async (_label, input) => {
   const { pi, handlers, errors } = runtimeApi();
   ompOrchestrate(pi);

   const result = await verdict(handlers, { toolName: "task", toolCallId: "spawn-ok", input }, { cwd: dir, role: "architect" });

   expect(errors).toEqual([]);
   expect(result).toBeUndefined();
  });

  test("outside a run the shape is not this plugin's business", async () => {
   const { pi, handlers } = runtimeApi();
   ompOrchestrate(pi);

   const result = await verdict(
    handlers,
    { toolName: "task", toolCallId: "spawn-unscoped", input: { name: "Impl1", agent: "orc-implementer", task: "epic orc-1" } },
    { cwd: dir },
   );

   expect(result).toBeUndefined();
  });
 });
});
