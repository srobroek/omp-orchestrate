import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEndEvent, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import grammar from "../src/contracts/grammar.json";
import type { ClaimObservation, ClaimState } from "../src/claim-state";
import { createLeadExitWatch, type LeadExitSender } from "../src/gates/lead-exit";
import * as runState from "../src/run-state";

interface SentMessage {
 message: Record<string, unknown>;
 options: Record<string, unknown>;
}

function claims(observation?: ClaimObservation): ClaimState {
 return {
  recordClaim: () => { },
  observedClaim: () => observation,
  forgetClaim: () => { },
 };
}

function context(prompt: string[] = []): ExtensionContext {
 return { getSystemPrompt: () => prompt } as unknown as ExtensionContext;
}

function event(text: string, willContinue = false): AgentEndEvent {
 return {
  type: "agent_end",
  willContinue,
  messages: [{ role: "assistant", content: [{ type: "text", text }] }] as AgentEndEvent["messages"],
 } as AgentEndEvent;
}

function fakePi() {
 const handlers: ((event: AgentEndEvent, ctx: ExtensionContext) => Promise<void>)[] = [];
 const sent: SentMessage[] = [];
 const sendMessage: LeadExitSender = (message, options) => {
  sent.push({ message: message as unknown as Record<string, unknown>, options: options as unknown as Record<string, unknown> });
 };
 const pi = {
  on: (name: string, handler: unknown) => {
   if (name === "agent_end") handlers.push(handler as (event: AgentEndEvent, ctx: ExtensionContext) => Promise<void>);
  },
  sendMessage,
 };
 return { handlers, sent, pi };
}
describe("lead exit watch", () => {
 let cwd: string;
 let restoreActiveRun: () => void = () => { };

 beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "orc-lead-exit-"));
  const activeRun = spyOn(runState, "isBoundRunActive").mockResolvedValue(true);
  restoreActiveRun = () => activeRun.mockRestore();
 });

 afterEach(async () => {
  restoreActiveRun();
  await rm(cwd, { recursive: true, force: true });
 });

 async function bind(runId = "run-1") {
  await mkdir(join(cwd, ".orchestration"), { recursive: true });
  await writeFile(join(cwd, ".orchestration", ".active-run"), JSON.stringify({ schema_version: 1, run_id: runId }));
 }

 function watch(observation: ClaimObservation = { actor: "lead", beadIds: ["orc-held-1"] }) {
  const fake = fakePi();
  const handler = createLeadExitWatch(claims(observation), cwd, fake.pi.sendMessage);
  fake.pi.on("agent_end", handler);
  return { ...fake, handler: fake.handlers[0]! };
 }

 test("fires once for a bound run when the lead ends on a plan", async () => {
  await bind();
  const fake = watch();
  await fake.handler(event("Plan:\n1. Resolve the remaining work\n2. Run verification"), context());

  expect(fake.sent).toHaveLength(1);
  expect(fake.sent[0]?.message).toMatchObject({
   customType: "orc-lead-exit",
   display: true,
   details: { bead: "orc-held-1", role: "lead" },
  });
  expect(fake.sent[0]?.message.content).toContain("Finish the held work");
  expect(fake.sent[0]?.options).toEqual({ deliverAs: "followUp", triggerTurn: true });
 });

 test("stays silent when willContinue is true", async () => {
  await bind();
  const fake = watch();
  await fake.handler(event("Plan: continue", true), context());
  expect(fake.sent).toHaveLength(0);
 });

 test("stays silent with no bound run", async () => {
  const fake = watch();
  await fake.handler(event("Plan: continue"), context());
  expect(fake.sent).toHaveLength(0);
 });

 test("stays silent with no observed claim", async () => {
  await bind();
  const fake = fakePi();
  const handler = createLeadExitWatch(claims(), cwd, fake.pi.sendMessage);
  await handler(event("Plan: continue"), context());
  expect(fake.sent).toHaveLength(0);
 });

 test("stays silent when the final text starts with terminal grammar verbs", async () => {
  await bind();
  const terminalCases = grammar.verbs.filter(verb =>
   verb.terminal === true && ["REPORTED", "BLOCKED", "ESCALATED"].includes(verb.verb),
  );
  expect(terminalCases.map(verb => verb.verb)).toEqual(["REPORTED", "BLOCKED", "ESCALATED"]);

  for (const terminalCase of terminalCases) {
   const fake = watch({ actor: "lead", beadIds: [`${terminalCase.verb.toLowerCase()}-bead`] });
   await fake.handler(event(`${terminalCase.verb} the held work`), context());
   expect(fake.sent).toHaveLength(0);
  }
 });

 test("caps follow-ups at three per session", async () => {
  await bind();
  const fake = watch();
  for (let index = 0; index < 4; index++) {
   await fake.handler(event(`Plan ${index}: continue the held work`), context());
  }
  expect(fake.sent).toHaveLength(3);
 });

 test("stays inert in a spawned role", async () => {
  await bind();
  const fake = watch();
  await fake.handler(event("Plan: continue"), context(["ORC-ROLE: implementer"]));
  expect(fake.sent).toHaveLength(0);
 });

 test("re-prompts on the run-02 final assistant text", async () => {
  await bind("repo-rh2");
  const fake = watch({ actor: "lead", beadIds: ["repo-rh2.1"] });
  const finalText = `Run is still incomplete.

The isolated config-fix worker finished successfully:

- Bead: \`repo-rh2.1.4\`
- Capture: \`MergeFixWorker.patch\`
- Worker commit: \`638173e5db127ae7b96139d9c6ce0d241f9987ba\`
- Scoped verification: \`bun test test/merge.test.ts\` — 6 passed

Integration hit a real conflict because the fix patch was based on the original \`src/merge.ts\`, while feature head \`4ec0120\` already contains the first-round implementation. \`test/merge.test.ts\` applied cleanly; \`src/merge.ts\` is conflicted in the feature worktree.

Required remaining work:

1. Resolve \`src/merge.ts\` by combining the first-round recursive merge with:
   - recursive omission of nested \`undefined\`;
   - safe own-\`__proto__\` handling.
2. Commit the resolved feature head.
3. Obtain a new independent config-merge review.
4. Run full \`bun test\`.
5. Close the beads and produce \`orc_run_status\`.

Nothing was pushed, published, or sent to an external service.`;

  await fake.handler(event(finalText), context());
  expect(fake.sent).toHaveLength(1);
  expect(fake.sent[0]?.message.customType).toBe("orc-lead-exit");
  expect(fake.sent[0]?.message.details).toMatchObject({ bead: "repo-rh2.1", role: "lead" });
 });
});
