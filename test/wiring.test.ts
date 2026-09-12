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
 event: { toolName: string; input: unknown },
 ctx: ExtensionContext,
) => Promise<ToolCallEventResult | undefined>;
type LifecycleHandler = (event: unknown, ctx: ExtensionContext) => Promise<void>;

function runtimeApi(): {
 pi: ExtensionAPI;
 handlers: ToolCallHandler[];
 starts: LifecycleHandler[];
 results: LifecycleHandler[];
 sent: Sent[];
 errors: LoggedError[];
} {
 const handlers: ToolCallHandler[] = [];
 const sent: Sent[] = [];
 const errors: LoggedError[] = [];
 const starts: LifecycleHandler[] = [];
 const results: LifecycleHandler[] = [];
 const zodStub: unknown = new Proxy(() => zodStub, { get: () => zodStub, apply: () => zodStub });
 const stub = {
  setLabel: () => { },
  on: (event: string, handler: unknown) => {
   if (event === "tool_call") handlers.push(handler as ToolCallHandler);
   if (event === "session_start") starts.push(handler as LifecycleHandler);
   if (event === "tool_result") results.push(handler as LifecycleHandler);
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
 return { pi: stub as unknown as ExtensionAPI, handlers, starts, results, sent, errors };
}

/** Dispatch to every subscriber, as OMP does; registration order is not a contract. */
async function dispatchAll(
 handlers: ToolCallHandler[],
 event: { toolName: string; input: unknown },
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
   const { pi, starts, sent } = runtimeApi();
   if (worker) Object.assign(pi, { getAllTools: () => [{ name: "yield" }] });
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
  const { pi, starts, sent } = runtimeApi();
  Object.assign(pi, { getAllTools: () => [{ name: "yield" }] });
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

 test("a declared role is under orchestration without any pin", async () => {
  const { pi, handlers, errors } = runtimeApi();
  ompOrchestrate(pi);

  const results = await dispatchAll(
   handlers,
   { toolName: "bash", input: { command: "git worktree add ../scratch" } },
   { cwd: dir, role: "implementer" },
  );

  expect(errors).toEqual([]);
  expect(results.some(result => result?.block === true)).toBe(true);
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
