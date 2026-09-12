import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentRegistry, type AgentSession, type ExtensionAPI, type ExtensionContext, type ToolCallEventResult } from "@oh-my-pi/pi-coding-agent";
import * as actualBd from "../src/bd";
import { BD_NOTICE_MESSAGE } from "../src/gates/bd";
import ompOrchestrate from "../src/index";

/**
 * The session every `verdict` below runs as, registered as the spawned agent `wiring-agent`
 * the way the executor registers a child: G6 hands each call that identity, and a claim by
 * a session the registry does not know is refused.
 */
beforeAll(() => {
	AgentRegistry.global().register({
		id: "wiring-agent", displayName: "wiring-agent", kind: "sub",
		session: { sessionManager: { getSessionId: () => "wiring-session" } } as unknown as AgentSession,
	});
});
afterAll(() => AgentRegistry.global().unregister("wiring-agent"));

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
 const runtimeCtx = { cwd: ctx.cwd, getSystemPrompt: () => prompt, sessionManager: { getSessionId: () => "wiring-session" } } as unknown as ExtensionContext;
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
 * `.beads` beside it, which is how `/orchestrate-start` leaves a lead session.
 */
async function pinnedRun(dir: string, body = JSON.stringify({ schema_version: 1, run_id: "run-wiring" })): Promise<void> {
 await fs.mkdir(path.join(dir, ".orchestration"), { recursive: true });
 await fs.writeFile(path.join(dir, ".orchestration", ".active-run"), body);
}

describe("gate dispatcher wiring", () => {
 let dir: string;

 beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "orc-wiring-"));
 });

 afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
 });

 test("a bd write inside a run by a registered session carries that session's identity, with no notice", async () => {
  await pinnedRun(dir, "run-wiring-1");
  const { pi, handlers, sent } = runtimeApi();
  ompOrchestrate(pi);

  const results = await dispatchAll(
   handlers,
   { toolName: "bash", input: { command: "bd update orc-1 --status in_progress" } },
   { cwd: dir },
  );

  // A registered session's write is attributed by the gate: this session's identity rides
  // on the call's env, so no notice is owed and nothing refuses.
  expect(results.some((result) => result?.block === true)).toBe(false);
  expect(sent).toEqual([]);
  expect(results.some(result => (result?.input as { env?: Record<string, string> } | undefined)?.env?.BEADS_ACTOR === "wiring-agent")).toBe(true);
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

 test("a bash call in a run that no gate revises leaves with its input untouched", async () => {
  await pinnedRun(dir);
  const { pi, handlers, errors } = runtimeApi();
  ompOrchestrate(pi);

  const results = await dispatchAll(
   handlers,
   { toolName: "bash", input: { command: "echo ok", derivedGateOnlyField: "must not survive" } },
   { cwd: dir },
  );

  expect(errors).toEqual([]);
  // The one revision is the identity; the gate-only field does not survive it.
  expect(results.filter(result => result !== undefined)).toEqual([
   { input: { command: "echo ok", env: { BEADS_ACTOR: "wiring-agent", BD_ACTOR: "wiring-agent" } } },
  ]);
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

 test("a contract-bound worker whose checkout holds a malformed marker receives no protocol", async () => {
  await fs.mkdir(path.join(dir, ".orchestration"), { recursive: true });
  await fs.writeFile(path.join(dir, ".orchestration", ".active-run"), "{broken");
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
  * The calls the run-scoped checks refuse, in the shape an ordinary session reaches for:
  * OMP's own worktree command.
  */
 const SCOPED_REFUSALS: [string, Record<string, unknown>][] = [
  ["a worktree command", { command: "git worktree add ../scratch" }],
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

 test("a declared role in a checkout no run has marked is under no orchestration: G3 lets the checkout through", async () => {
  // Role never activates: an `orc-*` agent spawned outside any run is a plain session,
  // and the prompt's claim about itself is not run authority.
  const { pi, handlers, errors, sent } = runtimeApi();
  ompOrchestrate(pi);

  const results = await dispatchAll(
   handlers,
   { toolName: "bash", input: { command: "git worktree add ../scratch" } },
   { cwd: dir, role: "implementer" },
  );

  expect(errors).toEqual([]);
  expect(results.every(result => result === undefined)).toBe(true);
  expect(sent).toEqual([]);
 });

 test("an isolated copy finds the run through the marker it carries", async () => {
  const isolated = await fs.mkdtemp(path.join(os.tmpdir(), "orc-wiring-isolated-"));
  try {
   await pinnedRun(isolated);
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
 let previousWorktreeDir: string | undefined;

 beforeEach(async () => {
  // realpath: macOS reaches `/var` through a link and G2 compares resolved paths.
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "orc-wiring-worker-")));
  // A base that does not exist, so OMP's isolation exemption cannot fire by accident.
  previousWorktreeDir = process.env.OMP_WORKTREE_DIR;
  process.env.OMP_WORKTREE_DIR = path.join(dir, "no-such-isolation-base");
 });

 afterEach(async () => {
  if (previousWorktreeDir === undefined) delete process.env.OMP_WORKTREE_DIR;
  else process.env.OMP_WORKTREE_DIR = previousWorktreeDir;
  await fs.rm(dir, { recursive: true, force: true });
 });

 /** One worker call. The marker written by `pinnedRun` is what puts the session under orchestration. */
 function call(toolCallId: string, command: string): { toolName: string; toolCallId: string; input: unknown } {
  return { toolName: "bash", toolCallId, input: { command } };
 }

 test("a two-bead named claim is refused by G5 before any bead is read", async () => {
  const show = spyOn(actualBd, "bdShow").mockResolvedValue(null);
  try {
   await pinnedRun(dir);
   const { pi, handlers, errors } = workerApi();
   ompOrchestrate(pi);

   // Attributed, so G6 has no actor to resolve and the only bead read in question is G5's.
   const result = await verdict(handlers, call("claim-two", "BEADS_ACTOR=impl bd update orc-1 orc-2 --claim"), { cwd: dir, role: "implementer" });

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
   // The worker sits in the tree its bead names; an isolated copy carries the marker with it.
   await pinnedRun(owned);
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

 test("a generic helper in an isolated copy is sandboxed by G1 through the copied marker", async () => {
  const isolated = path.join(dir, "isolated-copy");
  await pinnedRun(isolated);
  const { pi, handlers, errors } = workerApi();
  ompOrchestrate(pi);

  const result = await verdict(handlers, call("helper-echo", "echo ok"), { cwd: isolated });

  expect(errors).toEqual([]);
  expect(result?.input).toEqual({ command: "echo ok", env: { BEADS_ACTOR: "wiring-agent", BD_ACTOR: "wiring-agent", BD_READONLY: "1" } });
 });

 describe("a copy that keeps a private store", () => {
  test.each([
   ["the run's store is missing", false],
   ["the redirect cannot be written", true],
  ])("refuses bd commands but not other commands while %s", async (_label, unwritable) => {
   // An isolated copy under OMP's base holding a store. Its marker names a run database
   // that either does not exist or exists while the copy's `.beads` refuses the redirect.
   const base = path.join(dir, "isolation-base");
   process.env.OMP_WORKTREE_DIR = base;
   const copy = path.join(base, "copy");
   await fs.mkdir(path.join(copy, ".beads", "embeddeddolt"), { recursive: true });
   await fs.writeFile(path.join(copy, ".beads", "embeddeddolt", "data"), "copied store");
   const primary = path.join(dir, "primary", ".beads");
   if (unwritable) await fs.mkdir(path.join(primary, "embeddeddolt"), { recursive: true });
   await pinnedRun(copy, JSON.stringify({ schema_version: 1, run_id: "run-wiring", beads_dir: primary }));
   if (unwritable) await fs.chmod(path.join(copy, ".beads"), 0o555);
   const { pi, handlers, errors } = workerApi();
   ompOrchestrate(pi);
   try {
    const refused = await verdict(handlers, call("bd-list", "bd list --json"), { cwd: copy, role: "implementer" });
    const allowed = await verdict(handlers, call("echo", "echo ok"), { cwd: copy, role: "implementer" });

    expect(errors).toEqual([]);
    expect(refused?.block).toBe(true);
    expect(refused?.reason).toContain("private copy of the beads store");
    expect(allowed?.block).not.toBe(true);
    expect(await fs.readFile(path.join(copy, ".beads", "embeddeddolt", "data"), "utf8")).toBe("copied store");
    expect(await fs.stat(path.join(copy, ".beads", "redirect")).catch(() => null)).toBeNull();
   } finally {
    await fs.chmod(path.join(copy, ".beads"), 0o755);
   }
  });
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
   await pinnedRun(dir);
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

  beforeEach(() => pinnedRun(dir));

  test("a second claim while the first awaits its result is refused, and passes once the result lands", async () => {
   const show = spyOn(actualBd, "bdShow").mockImplementation(async id => plain(id));
   try {
    const { pi, handlers, results: observers, errors } = workerApi();
    ompOrchestrate(pi);
    const worker = { cwd: dir, role: "implementer" };

    const first = await verdict(handlers, call("claim-1", "bd update orc-1 --claim --json"), worker);
    const second = await verdict(handlers, call("claim-2", "bd update orc-2 --claim --json"), worker);

    expect(first?.block).toBeUndefined();
    expect(second?.block).toBe(true);
    expect(second?.reason).toContain("a claim is already in flight this turn");

    // The first call's result, whatever it says: a failed claim records nothing but
    // still settles the mark.
    const failed = { toolName: "bash", toolCallId: "claim-1", isError: true, input: { command: "bd update orc-1 --claim --json" }, details: {}, content: [] };
    const ctx = { cwd: dir, getSystemPrompt: () => ["ORC-ROLE: implementer"] } as unknown as ExtensionContext;
    for (const observe of observers) await observe(failed, ctx);

    const third = await verdict(handlers, call("claim-3", "bd update orc-3 --claim --json"), worker);

    expect(errors).toEqual([]);
    expect(third?.block).toBeUndefined();
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

    expect((await verdict(handlers, call("claim-1", "bd update orc-1 --claim --json"), worker))?.block).toBeUndefined();
    for (const turnEnd of turns) await turnEnd({}, ctx);

    expect((await verdict(handlers, call("claim-2", "bd update orc-2 --claim --json"), worker))?.block).toBeUndefined();
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
    expect((await verdict(handlers, call("claim-one", "bd update orc-3 --claim --json"), worker))?.block).toBeUndefined();
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
   await pinnedRun(dir);
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
   await pinnedRun(dir);
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

 describe("G6 refusals reach the verdict", () => {
  test("a worker's routed sync under an active marker is blocked, not merely noticed", async () => {
   await pinnedRun(dir);
   const { pi, handlers, sent, errors } = workerApi();
   ompOrchestrate(pi);

   const result = await verdict(handlers, call("worker-sync", "bd dolt pull"), { cwd: dir, role: "implementer" });

   expect(errors).toEqual([]);
   expect(result?.block).toBe(true);
   expect(result?.reason).toContain("sync is the lead's barrier step");
   expect(sent).toEqual([]);
  });

  test("the lead's own sync under the same marker passes G6", async () => {
   await pinnedRun(dir);
   const { pi, handlers, errors } = runtimeApi();
   ompOrchestrate(pi);

   const result = await verdict(handlers, call("lead-sync", "bd dolt push"), { cwd: dir });

   expect(errors).toEqual([]);
   expect(result?.block).toBeUndefined();
  });
 });
});
