import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolCallEventResult } from "@oh-my-pi/pi-coding-agent";
import { BD_NOTICE_MESSAGE } from "../src/gates/bd";
import ompOrchestrate from "../src/index";

/** Exercise the registered handlers, not just individual gates or hook counts. */

interface Sent {
 customType?: string;
 content?: string;
 deliverAs?: string;
}

type ToolCallHandler = (
 event: { toolName: string; input: unknown },
 ctx: { cwd: string },
) => Promise<ToolCallEventResult | undefined>;

function runtimeApi(): {
 pi: ExtensionAPI;
 handlers: ToolCallHandler[];
 starts: ((event: unknown, ctx: ExtensionContext) => Promise<void>)[];
 sent: Sent[];
} {
 const handlers: ToolCallHandler[] = [];
 const sent: Sent[] = [];
 const starts: ((event: unknown, ctx: ExtensionContext) => Promise<void>)[] = [];
 const zodStub: unknown = new Proxy(() => zodStub, { get: () => zodStub, apply: () => zodStub });
 const stub = {
  setLabel: () => { },
  on: (event: string, handler: unknown) => {
   if (event === "tool_call") handlers.push(handler as ToolCallHandler);
   if (event === "session_start") starts.push(handler as (event: unknown, ctx: ExtensionContext) => Promise<void>);
  },
  registerCommand: () => { },
  registerTool: () => { },
  zod: zodStub,
  getAllTools: () => [],
  logger: { error: () => { }, debug: () => { }, warn: () => { }, info: () => { } },
  sendMessage: (message: { customType?: string; content?: string }, options?: { deliverAs?: string }) => {
   sent.push({ customType: message.customType, content: message.content, deliverAs: options?.deliverAs });
  },
 };
 return { pi: stub as unknown as ExtensionAPI, handlers, starts, sent };
}

/** Dispatch to every subscriber, as OMP does; registration order is not a contract. */
async function dispatchAll(
 handlers: ToolCallHandler[],
 event: { toolName: string; input: unknown },
 ctx: { cwd: string },
): Promise<(ToolCallEventResult | undefined)[]> {
 if (handlers.length === 0) throw new Error("no tool_call handler was registered");
 const results: (ToolCallEventResult | undefined)[] = [];
 for (const handler of handlers) results.push(await handler(event, ctx));
 return results;
}

describe("gate dispatcher wiring", () => {
 let dir: string;

 beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "orc-wiring-"));
 });

 afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
 });

 test("an unattributed bd write inside a run emits the identity notice as a steer", async () => {
  await fs.mkdir(path.join(dir, ".orchestration"), { recursive: true });
  await fs.writeFile(path.join(dir, ".orchestration", ".active-run"), "run-wiring-1");
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
  await fs.mkdir(path.join(dir, ".orchestration"), { recursive: true });
  await fs.writeFile(path.join(dir, ".orchestration", ".active-run"), "run-wiring-2");
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

 test("a tool the gate does not cover reaches no gate at all", async () => {
  await fs.mkdir(path.join(dir, ".orchestration"), { recursive: true });
  await fs.writeFile(path.join(dir, ".orchestration", ".active-run"), "run-wiring-3");
  const { pi, handlers, sent } = runtimeApi();
  ompOrchestrate(pi);

  const results = await dispatchAll(handlers, { toolName: "read", input: { path: "README.md" } }, { cwd: dir });

  expect(results.every((result) => result === undefined)).toBe(true);
  expect(sent).toHaveLength(0);
 });

 test("only contract-bound workers receive the claim protocol", async () => {
  await fs.mkdir(path.join(dir, ".orchestration"), { recursive: true });
  await fs.writeFile(path.join(dir, ".orchestration", ".active-run"), "run-wiring-contract");
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
});
