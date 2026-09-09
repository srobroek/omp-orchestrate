import { afterEach, describe, expect, test } from "bun:test";
import { observeClaimResult } from "../src/claim-observer";
import { createClaimState } from "../src/claim-state";

/**
 * A claim report as beads 1.1.2 prints it on success, trimmed to the fields read.
 * Measured: a losing claim prints NO stdout and puts `Error claiming <id>: issue already
 * claimed by <actor>` on stderr, so the absence of this shape is the failure signal.
 */
function report(fields: Record<string, unknown>): { text: string }[] {
 return [{ text: JSON.stringify([{ id: "orc-1", status: "in_progress", assignee: "impl-1", ...fields }]) }];
}

const QUEUE_CLAIM = "bd ready --parent orc-epic --metadata-field role=implementer --unassigned --claim --json";

let claims = createClaimState();

function observe(event: Record<string, unknown>): void {
 observeClaimResult(claims, { toolName: "bash", input: { command: QUEUE_CLAIM }, content: report({}), ...event });
}

afterEach(() => {
 claims = createClaimState();
});

describe("observeClaimResult", () => {
 test("records the bead a queue claim returned", () => {
  observe({});
  expect(claims.observedClaim()).toEqual({ actor: "impl-1", beadIds: ["orc-1"] });
 });

 test("records a named claim from its report, not from the command", () => {
  // The id in the command is irrelevant: the report is what proves acquisition.
  observe({ input: { command: "BEADS_ACTOR=impl-1 bd update orc-1 --claim --json" } });
  expect(claims.observedClaim()).toEqual({ actor: "impl-1", beadIds: ["orc-1"] });
 });

 test("a successful result carries no exitCode, so its absence must not reject", () => {
  // `tools/bash.ts:720-722` sets details.exitCode only on a failing exit. An earlier
  // draft tested `exitCode === 0` and would have recorded nothing, ever.
  observe({
   details: { timeoutSeconds: 120, wallTimeMs: 40 },
   content: [{ text: `${report({})[0]?.text}\n\nWall time: 0.04 seconds` }],
  });
  expect(claims.observedClaim()?.beadIds).toEqual(["orc-1"]);
 });

 test("accepts a decorated supported envelope", () => {
  observe({ content: [{ text: `${JSON.stringify({ schema_version: 1, data: JSON.parse(report({})[0]!.text) })}\n\nWall time: 0.04 seconds` }] });
  expect(claims.observedClaim()?.beadIds).toEqual(["orc-1"]);
 });

 test("observes OMP timeout-clamp and PTY-fallback success notices", () => {
  const cases = [
   { timeoutSeconds: 3600, requestedTimeoutSeconds: 4000, notice: "Timeout clamped to 3600s (requested 4000s; allowed range 1-3600s)." },
   { timeoutSeconds: 30, requestedTimeoutSeconds: 300, notice: "Timeout clamped to 30s (requested 300s; global tools.maxTimeout ceiling 30s)." },
  ];
  for (const { notice, ...details } of cases) {
   claims = createClaimState();
   observe({
    input: { command: QUEUE_CLAIM, pty: true },
    details: { wallTimeMs: 40, ...details },
    content: [{ text: `${report({})[0]?.text}\n\nWall time: 0.04 seconds\n${notice}\npty requested but unavailable in this environment; ran without a terminal` }],
   });
   expect(claims.observedClaim()).toEqual({ actor: "impl-1", beadIds: ["orc-1"] });
  }
 });

 test("observes a PTY-fallback success without a timeout clamp", () => {
  observe({
   input: { command: QUEUE_CLAIM, pty: true },
   details: { timeoutSeconds: 300, wallTimeMs: 40 },
   content: [{ text: `${report({})[0]?.text}\n\nWall time: 0.04 seconds\npty requested but unavailable in this environment; ran without a terminal` }],
  });
  expect(claims.observedClaim()?.beadIds).toEqual(["orc-1"]);
 });

 test("rejects unknown notices, mismatched transport metadata, and partial JSON before recognized notices", () => {
  const footer = "\n\nWall time: 0.04 seconds\nTimeout clamped to 3600s (requested 4000s; allowed range 1-3600s).";
  for (const event of [
   { details: { wallTimeMs: 40, timeoutSeconds: 3600, requestedTimeoutSeconds: 4000 }, content: [{ text: `${report({})[0]?.text}${footer}\nunrecognized notice` }] },
   { details: { wallTimeMs: 40, timeoutSeconds: 30, requestedTimeoutSeconds: 4000 }, content: [{ text: `${report({})[0]?.text}${footer}` }] },
   { details: { wallTimeMs: 50 }, content: [{ text: `${report({})[0]?.text}\n\nWall time: 0.04 seconds` }] },
   { details: { wallTimeMs: 40, timeoutSeconds: 3600, requestedTimeoutSeconds: 4000 }, content: [{ text: `[{"id":"orc-1"${footer}` }] },
  ]) {
   observe(event);
   expect(claims.observedClaim()).toBeUndefined();
  }
 });

 test("records static shell and eval wrappers without counting ancestors", () => {
  for (const command of [`bash -lc '${QUEUE_CLAIM}'`, `eval '${QUEUE_CLAIM}'`]) {
   claims = createClaimState();
   observe({ input: { command } });
   expect(claims.observedClaim()?.beadIds).toEqual(["orc-1"]);
  }
 });

 test("rejects wrapped extra commands and multiple reports", () => {
  for (const command of [`bash -lc '${QUEUE_CLAIM}; true'`, `eval '${QUEUE_CLAIM}; touch extra'`, `${QUEUE_CLAIM}\ntrue`]) {
   observe({ input: { command } });
   expect(claims.observedClaim()).toBeUndefined();
  }
  observe({ content: [{ text: `${report({})[0]?.text}\n${report({})[0]?.text}` }] });
  expect(claims.observedClaim()).toBeUndefined();
 });

 test("rejects truncated payloads even when the visible JSON is complete", () => {
  observe({ details: { meta: { truncation: { originalLines: 20 } } } });
  expect(claims.observedClaim()).toBeUndefined();
  observe({ content: [{ text: `${report({})[0]?.text}\n\nWall time: 0.04 seconds\n(output truncated)` }] });
  expect(claims.observedClaim()).toBeUndefined();
 });

 test("a present exitCode means failure and is rejected", () => {
  observe({ details: { exitCode: 1 } });
  expect(claims.observedClaim()).toBeUndefined();
 });

 test("an error result is rejected", () => {
  observe({ isError: true });
  expect(claims.observedClaim()).toBeUndefined();
 });

 test("a timed-out result is rejected", () => {
  observe({ details: { timedOut: true } });
  expect(claims.observedClaim()).toBeUndefined();
 });

 test("an async result is rejected: it describes a job started, not a claim completed", () => {
  observe({ details: { async: true } });
  expect(claims.observedClaim()).toBeUndefined();
 });

 test("a trailing command cannot launder a failed claim", async () => {
  // The laundering shape: the claim failed, a trailing `true` makes the shell exit 0,
  // and a valid-looking report is on stdout from something else in the chain. The
  // payload alone cannot distinguish this, so the segment count must.
  observeClaimResult(claims, {
   toolName: "bash",
   input: { command: "BEADS_ACTOR=x bd update victim-1 --claim --json; true" },
   content: [{ text: JSON.stringify([{ id: "victim-1", status: "in_progress", assignee: "x" }]) }],
  });
  expect(claims.observedClaim()).toBeUndefined();
 });

 test("prose naming a bead records nothing", () => {
  observe({ content: [{ text: "claimed orc-1 successfully, status in_progress" }] });
  expect(claims.observedClaim()).toBeUndefined();
 });

 test("an echoed lookalike object records nothing", () => {
  // No id scavenging: this is valid JSON in the right shape but not a claim report,
  // because a claim report is an array.
  observe({ content: [{ text: '{"id":"orc-9","status":"in_progress","assignee":"impl-1"}' }] });
  expect(claims.observedClaim()).toBeUndefined();
 });

 test("a two-bead claim records both, so the worktree gate is armed for each", () => {
  // `bd update <a> <b> --claim` claims both, and G2 scopes across every held bead.
  // Recording only one would leave a legitimate claim half observed.
  observe({
   input: { command: "BEADS_ACTOR=impl-1 bd update orc-1 orc-2 --claim --json" },
   content: [
    {
     text: JSON.stringify([
      { id: "orc-1", status: "in_progress", assignee: "impl-1" },
      { id: "orc-2", status: "in_progress", assignee: "impl-1" },
     ]),
    },
   ],
  });
  expect(claims.observedClaim()).toEqual({ actor: "impl-1", beadIds: ["orc-1", "orc-2"] });
 });

 test("records nothing when the report mixes assignees", () => {
  // One actor issued the call, so two assignees mean this is not its claim report.
  observe({
   content: [
    {
     text: JSON.stringify([
      { id: "orc-1", status: "in_progress", assignee: "impl-1" },
      { id: "orc-2", status: "in_progress", assignee: "impl-9" },
     ]),
    },
   ],
  });
  expect(claims.observedClaim()).toBeUndefined();
 });

 test("records nothing when one record in the report is unclaimed", () => {
  observe({
   content: [
    {
     text: JSON.stringify([
      { id: "orc-1", status: "in_progress", assignee: "impl-1" },
      { id: "orc-2", status: "open", assignee: "" },
     ]),
    },
   ],
  });
  expect(claims.observedClaim()).toBeUndefined();
 });

 test("a read of an open bead records nothing", () => {
  observe({ content: report({ status: "open", assignee: "" }) });
  expect(claims.observedClaim()).toBeUndefined();
 });

 test("an in-progress bead with no assignee records nothing", () => {
  observe({ content: report({ assignee: "" }) });
  expect(claims.observedClaim()).toBeUndefined();
 });

 test("a non-claiming command records nothing", () => {
  observe({ input: { command: "bd ready --metadata-field role=implementer --unassigned --json" } });
  expect(claims.observedClaim()).toBeUndefined();
 });

 test("a non-bash tool records nothing", () => {
  observe({ toolName: "read" });
  expect(claims.observedClaim()).toBeUndefined();
 });

 test("malformed JSON records nothing", () => {
  observe({ content: [{ text: "[{" }] });
  expect(claims.observedClaim()).toBeUndefined();
 });
});
