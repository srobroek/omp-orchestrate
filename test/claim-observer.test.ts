import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { BdBead } from "../src/bd";
import * as actualBd from "../src/bd";
import { CLAIM_UNOBSERVED_MESSAGE, observeClaimResult } from "../src/claim-observer";
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
const PTY_NOTICE = "pty requested but unavailable in this environment; ran without a terminal";

/**
 * The claimed bead as the host's sink delivers it when a line exceeds `tools.outputMaxColumns`
 * (768): pretty-printed, the description line cut at the cap and marked with `…`, every
 * other line intact. Modelled on `session/streaming-output.ts` `#applyColumnCap`.
 */
function columnCapped(id: string, assignee: string): string {
 const pretty = JSON.stringify([{ id, title: "brief", description: "x".repeat(1200), status: "in_progress", assignee }], null, 2);
 return pretty.split("\n").map(line => line.length > 768 ? `${line.slice(0, 767)}…` : line).join("\n");
}

/** What `bd list --assignee <actor> …` reports, by actor. Absent means the store holds none. */
let held: Record<string, BdBead[]> = {};
let listed: string[][] = [];
let warned: Record<string, unknown>[] = [];
let sent: { message: Record<string, unknown>; options: Record<string, unknown> | undefined }[] = [];
let claims = createClaimState();

// Restore the original export rather than installing a process-wide module mock: later
// suites must reach the real bd subprocess.
const listSpy = spyOn(actualBd, "bdList").mockImplementation(async (args: string[]) => {
 listed.push(args);
 return held[args[args.indexOf("--assignee") + 1] ?? ""] ?? [];
});
afterAll(() => listSpy.mockRestore());

const pi = {
 logger: {
  warn: (message: string, data?: Record<string, unknown>) => { warned.push({ message, ...data }); },
  error: () => {},
  info: () => {},
  debug: () => {},
 },
 sendMessage: (message: Record<string, unknown>, options?: Record<string, unknown>) => { sent.push({ message, options }); },
} as unknown as ExtensionAPI;

async function observe(event: Record<string, unknown>): Promise<void> {
 await observeClaimResult(pi, claims, { toolName: "bash", input: { command: QUEUE_CLAIM }, content: report({}), ...event });
}

afterEach(() => {
 held = {};
 listed = [];
 warned = [];
 sent = [];
 claims = createClaimState();
});

describe("observeClaimResult", () => {
 test("records the bead a queue claim returned without consulting the store or logging", async () => {
  await observe({});
  expect(claims.observedClaim()).toEqual({ actor: "impl-1", beadIds: ["orc-1"] });
  expect(listed).toEqual([]);
  expect(warned).toEqual([]);
  expect(sent).toEqual([]);
 });

 test("records a named claim from its report, not from the command", async () => {
  // The id in the command is irrelevant: the report is what proves acquisition.
  await observe({ input: { command: "BEADS_ACTOR=impl-1 bd update orc-1 --claim --json" } });
  expect(claims.observedClaim()).toEqual({ actor: "impl-1", beadIds: ["orc-1"] });
 });

 test("a successful result carries no exitCode, so its absence must not reject", async () => {
  // `tools/bash.ts:814-815` sets details.exitCode only on a failing exit. An earlier
  // draft tested `exitCode === 0` and would have recorded nothing, ever.
  await observe({
   details: { timeoutSeconds: 120, wallTimeMs: 40 },
   content: [{ text: `${report({})[0]?.text}\n\nWall time: 0.04 seconds` }],
  });
  expect(claims.observedClaim()?.beadIds).toEqual(["orc-1"]);
 });

 test("accepts a decorated supported envelope", async () => {
  await observe({ content: [{ text: `${JSON.stringify({ schema_version: 1, data: JSON.parse(report({})[0]!.text) })}\n\nWall time: 0.04 seconds` }] });
  expect(claims.observedClaim()?.beadIds).toEqual(["orc-1"]);
 });

 test("with structured wall time, whatever the host appends after the footer is ignored", async () => {
  // The footer boundary is derived from `details.wallTimeMs`, so a notice this plugin has
  // never seen -- the next host release's -- cannot disarm the observer.
  for (const notices of [
   "Timeout clamped to 3600s (requested 4000s; allowed range 1-3600s).",
   `Timeout clamped to 30s (requested 300s; global tools.maxTimeout ceiling 30s).\n${PTY_NOTICE}`,
   PTY_NOTICE,
   "Some notice a later host release added",
   "Timeout clamped to 3600s (requested 4000s; allowed range 1-3600s).\nunrecognized notice",
  ]) {
   claims = createClaimState();
   await observe({
    input: { command: QUEUE_CLAIM, pty: true },
    details: { wallTimeMs: 40, timeoutSeconds: 30 },
    content: [{ text: `${report({})[0]?.text}\n\nWall time: 0.04 seconds\n${notices}` }],
   });
   expect(claims.observedClaim()).toEqual({ actor: "impl-1", beadIds: ["orc-1"] });
  }
  expect(warned).toEqual([]);
 });

 test("structured wall time that does not match the text is not trusted as the boundary", async () => {
  // The host's footer line is derivable exactly; a near miss means the text is not the
  // host's rendering of this result, so nothing past it is separable from the output.
  for (const text of [
   `${report({})[0]?.text}\n\nWall time: 0.04 seconds`,
   `${report({})[0]?.text}\n\nWall time: 0.05 seconds trailing`,
  ]) {
   await observe({ details: { wallTimeMs: 50 }, content: [{ text }] });
   expect(claims.observedClaim()).toBeUndefined();
  }
  expect(warned.map(entry => entry.reason)).toEqual(["footer not recognised", "footer not recognised"]);
 });

 test("without structured wall time, only the host's known notices are accepted after the footer", async () => {
  const clamp = "Timeout clamped to 3600s (requested 4000s; allowed range 1-3600s).";
  await observe({
   input: { command: QUEUE_CLAIM, pty: true },
   details: { timeoutSeconds: 3600, requestedTimeoutSeconds: 4000 },
   content: [{ text: `${report({})[0]?.text}\n\nWall time: 0.04 seconds\n${clamp}\n${PTY_NOTICE}` }],
  });
  expect(claims.observedClaim()).toEqual({ actor: "impl-1", beadIds: ["orc-1"] });

  for (const event of [
   { details: { timeoutSeconds: 3600, requestedTimeoutSeconds: 4000 }, content: [{ text: `${report({})[0]?.text}\n\nWall time: 0.04 seconds\n${clamp}\nunrecognized notice` }] },
   { details: { timeoutSeconds: 30, requestedTimeoutSeconds: 4000 }, content: [{ text: `${report({})[0]?.text}\n\nWall time: 0.04 seconds\n${clamp}` }] },
   { content: [{ text: `${report({})[0]?.text}\n\nWall time: 0.04 seconds\n(output truncated)` }] },
  ]) {
   claims = createClaimState();
   await observe(event);
   expect(claims.observedClaim()).toBeUndefined();
  }
  expect(warned.map(entry => entry.reason)).toEqual(["footer not recognised", "footer not recognised", "footer not recognised"]);
 });

 test("records static shell and eval wrappers without counting ancestors", async () => {
  for (const command of [`bash -lc '${QUEUE_CLAIM}'`, `eval '${QUEUE_CLAIM}'`]) {
   claims = createClaimState();
   await observe({ input: { command } });
   expect(claims.observedClaim()?.beadIds).toEqual(["orc-1"]);
  }
 });

 test("rejects wrapped extra commands and multiple reports", async () => {
  for (const command of [`bash -lc '${QUEUE_CLAIM}; true'`, `eval '${QUEUE_CLAIM}; touch extra'`, `${QUEUE_CLAIM}\ntrue`]) {
   await observe({ input: { command } });
   expect(claims.observedClaim()).toBeUndefined();
  }
  await observe({ content: [{ text: `${report({})[0]?.text}\n${report({})[0]?.text}` }] });
  expect(claims.observedClaim()).toBeUndefined();
 });

 test("a column-capped report is resolved from the store by the command's actor", async () => {
  // F-BUG-01: the sink cuts every line over 768 columns and marks it with `…`, setting only
  // `meta.limits.columnTruncated`. The description line is the brief, so a normal bead
  // arrives this way. The report is unparseable; the store still knows who holds what.
  const text = columnCapped("orc-42", "impl-1");
  expect(text.split("\n").some(line => line.length > 768)).toBe(false);
  expect(() => JSON.parse(text)).toThrow();
  held["impl-1"] = [{ id: "orc-42", status: "in_progress", assignee: "impl-1" }];

  await observe({
   input: { command: QUEUE_CLAIM, env: { BEADS_ACTOR: "impl-1" } },
   details: { wallTimeMs: 40, meta: { limits: { columnTruncated: { maxColumn: 768 } } } },
   content: [{ text: `${text}\n\nWall time: 0.04 seconds\nSome lines truncated to 768 chars` }],
  });
  expect(claims.observedClaim()).toEqual({ actor: "impl-1", beadIds: ["orc-42"] });
  expect(listed).toHaveLength(1);
  expect(listed[0]).toContain("--assignee");
  expect(listed[0]).toContain("impl-1");
  expect(warned).toMatchObject([{ message: "orchestrate claim not observed", reason: "lines truncated at the column cap", actor: "impl-1" }]);
  expect(sent).toEqual([]);
 });

 test("the actor is the one bd read: BEADS_ACTOR inline over env, BD_ACTOR only as a last resort", async () => {
  // `bd --help`: `--actor` defaults to `$BEADS_ACTOR, git user.name, $USER`, so the assignee
  // the store holds is the BEADS_ACTOR the command saw, with an inline assignment shadowing
  // the tool's env as it does in the shell. BD_ACTOR is this plugin's own carrier, not bd's.
  held.inline = [{ id: "orc-7", status: "in_progress", assignee: "inline" }];
  held.exported = [{ id: "orc-8", status: "in_progress", assignee: "exported" }];
  held.plugin = [{ id: "orc-9", status: "in_progress", assignee: "plugin" }];
  const cut = { meta: { limits: { columnTruncated: { maxColumn: 768 } } } };
  await observe({ input: { command: `BEADS_ACTOR=inline ${QUEUE_CLAIM}`, env: { BEADS_ACTOR: "exported" } }, details: cut });
  expect(claims.observedClaim()).toEqual({ actor: "inline", beadIds: ["orc-7"] });
  claims = createClaimState();
  await observe({ input: { command: `BD_ACTOR=plugin ${QUEUE_CLAIM}`, env: { BEADS_ACTOR: "exported" } }, details: cut });
  expect(claims.observedClaim()).toEqual({ actor: "exported", beadIds: ["orc-8"] });
  claims = createClaimState();
  await observe({ input: { command: QUEUE_CLAIM, env: { BD_ACTOR: "plugin" } }, details: cut });
  expect(claims.observedClaim()).toEqual({ actor: "plugin", beadIds: ["orc-9"] });
 });

 test("a window-truncated report is resolved from the store the same way", async () => {
  held["impl-1"] = [{ id: "orc-1", status: "in_progress", assignee: "impl-1" }];
  await observe({
   input: { command: `BEADS_ACTOR=impl-1 ${QUEUE_CLAIM}` },
   details: { meta: { truncation: { originalLines: 20 } } },
  });
  expect(claims.observedClaim()).toEqual({ actor: "impl-1", beadIds: ["orc-1"] });
  expect(warned.map(entry => entry.reason)).toEqual(["output truncated"]);
 });

 test("an unreadable report with no actor on the command warns and tells the worker", async () => {
  // The documented queue pull carries no BEADS_ACTOR, so the store cannot be asked. The
  // worker must learn the claim is unbound rather than proceed with every gate disarmed.
  await observe({
   details: { wallTimeMs: 40, meta: { limits: { columnTruncated: { maxColumn: 768 } } } },
   content: [{ text: `${columnCapped("orc-42", "impl-1")}\n\nWall time: 0.04 seconds` }],
  });
  expect(claims.observedClaim()).toBeUndefined();
  expect(listed).toEqual([]);
  expect(warned).toHaveLength(1);
  expect(warned[0]).toMatchObject({ command: QUEUE_CLAIM, reason: "lines truncated at the column cap", actor: undefined });
  expect((warned[0]?.head as string).length).toBe(200);
  expect(sent).toHaveLength(1);
  expect(sent[0]?.message).toMatchObject({ customType: CLAIM_UNOBSERVED_MESSAGE, display: true, attribution: "user" });
  expect(sent[0]?.options).toEqual({ deliverAs: "steer" });
  const content = sent[0]?.message.content as string;
  expect(content).toContain(QUEUE_CLAIM);
  expect(content).toContain("lines truncated at the column cap");
  expect(content).toContain("BEADS_ACTOR=<assignee> bd update <bead-id> --claim --json");
 });

 test("an actor the store does not know warns and tells the worker", async () => {
  await observe({
   input: { command: `BEADS_ACTOR=ghost ${QUEUE_CLAIM}` },
   details: { meta: { limits: { columnTruncated: { maxColumn: 768 } } } },
  });
  expect(claims.observedClaim()).toBeUndefined();
  expect(listed).toHaveLength(1);
  expect(sent).toHaveLength(1);
  expect(sent[0]?.message.content as string).toContain("no open bead assigned to ghost");
 });

 test("a report that is not a claim warns with what arrived", async () => {
  await observe({ content: [{ text: "claimed orc-1 successfully, status in_progress" }] });
  expect(claims.observedClaim()).toBeUndefined();
  expect(warned).toMatchObject([{ reason: "not a claim report", head: "claimed orc-1 successfully, status in_progress" }]);
  expect(sent).toHaveLength(1);
 });

 test("an empty queue is a real answer: nothing recorded, nothing diagnosed", async () => {
  // `bd ready --claim --json` on a drained queue prints `[]` and exits 0; the worker's next
  // step is NO_WORK, not a rebind.
  for (const text of ["[]", JSON.stringify({ schema_version: 1, data: [] })]) {
   await observe({ content: [{ text }] });
  }
  expect(claims.observedClaim()).toBeUndefined();
  expect(warned).toEqual([]);
  expect(sent).toEqual([]);
 });

 test("a failed, errored, timed-out, or backgrounded claim is neither recorded nor diagnosed", async () => {
  // The model already sees each of these outcomes in the result itself.
  for (const details of [{ exitCode: 1 }, { timedOut: true }, { async: true }]) {
   await observe({ details });
  }
  await observe({ isError: true });
  expect(claims.observedClaim()).toBeUndefined();
  expect(warned).toEqual([]);
  expect(sent).toEqual([]);
 });

 test("a trailing command cannot launder a failed claim", async () => {
  // The laundering shape: the claim failed, a trailing `true` makes the shell exit 0,
  // and a valid-looking report is on stdout from something else in the chain. The
  // payload alone cannot distinguish this, so the segment count must.
  await observeClaimResult(pi, claims, {
   toolName: "bash",
   input: { command: "BEADS_ACTOR=x bd update victim-1 --claim --json; true" },
   content: [{ text: JSON.stringify([{ id: "victim-1", status: "in_progress", assignee: "x" }]) }],
  });
  expect(claims.observedClaim()).toBeUndefined();
 });

 test("an echoed lookalike object records nothing", async () => {
  // No id scavenging: this is valid JSON in the right shape but not a claim report,
  // because a claim report is an array.
  await observe({ content: [{ text: '{"id":"orc-9","status":"in_progress","assignee":"impl-1"}' }] });
  expect(claims.observedClaim()).toBeUndefined();
 });

 test("a two-bead claim records both, so the worktree gate is armed for each", async () => {
  // `bd update <a> <b> --claim` claims both, and G2 scopes across every held bead.
  // Recording only one would leave a legitimate claim half observed.
  await observe({
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

 test("records nothing when the report mixes assignees", async () => {
  // One actor issued the call, so two assignees mean this is not its claim report.
  await observe({
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

 test("records nothing when one record in the report is unclaimed", async () => {
  await observe({
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

 test("a read of an open bead records nothing", async () => {
  await observe({ content: report({ status: "open", assignee: "" }) });
  expect(claims.observedClaim()).toBeUndefined();
 });

 test("an in-progress bead with no assignee records nothing", async () => {
  await observe({ content: report({ assignee: "" }) });
  expect(claims.observedClaim()).toBeUndefined();
 });

 test("a non-claiming command records nothing and is not diagnosed", async () => {
  await observe({ input: { command: "bd ready --metadata-field role=implementer --unassigned --json" } });
  expect(claims.observedClaim()).toBeUndefined();
  expect(warned).toEqual([]);
 });

 test("a non-bash tool records nothing", async () => {
  await observe({ toolName: "read" });
  expect(claims.observedClaim()).toBeUndefined();
 });

 test("malformed JSON records nothing", async () => {
  await observe({ content: [{ text: "[{" }] });
  expect(claims.observedClaim()).toBeUndefined();
 });
});
