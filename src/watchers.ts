/**
 * W1-W5 — the runtime watchers.
 *
 * Five deterministic observers that record and warn but never gate: stall
 * detection, the bd-mutation audit ledger, agent and dependency preflight,
 * the goal relay, and settings checks. Enforcement stays with G1 and the reaper;
 * a watcher's worst failure is silence. The one refusal registered here is the
 * `task` preflight, which declines to spawn a core agent whose definition is broken;
 * G8, the assignment notice (`gates/assignment.ts`), runs from the same handler and
 * only ever speaks.
 *
 * Nothing here throws out of a handler. A throwing `tool_call` handler blocks the
 * tool it was inspecting (`extensibility/extensions/wrapper.ts:237`), and
 * background work runs on `ctx.setInterval` rather than a raw timer because the
 * managed timer contains a throw or a rejected promise instead of letting it
 * surface as a fatal `uncaughtException` (`extensions/managed-timers.ts:1-16`).
 *
 * The module-level state is session-scoped without extra work: the extension
 * module is re-imported and its factory re-run per session, so one session's
 * children cannot leak into another's (the argument is spelled out in
 * `claim-state.ts`). Each session also gets its own event bus — the task executor
 * does not pass its bus into the child sessions it builds
 * (`task/executor.ts:3095-3167`) — so a subscriber sees only the children it
 * spawned, never a sibling's.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { findScopedSettings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { SettingPath } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import {
 coreContractForAgent,
 type AgentDiscoveryFinding,
 discoverAgentFindings,
 requestedAgentNames,
} from "./agent-preflight";
import { type BdBead, bdList, bdRun, claimedBead, metadataString, resetReadBudget } from "./bd";
import { sessionRole } from "./identity";
import { runScope } from "./run-scope";
import { createClaimState, type ClaimState } from "./claim-state";
import { createAssignmentNotice } from "./gates/assignment";
import { writesBeads } from "./gates/bd";
import { type BdInvocation, bdInvocations } from "./shell";
import { landingSweep } from "./landing";
type AgentPreflightContext = Pick<ExtensionContext, "cwd" | "setTimeout" | "clearTimer"> &
 Partial<Pick<ExtensionContext, "models">>;

/**
 * Bus channels, as `task/types.ts:59-65`, `mcp/startup-events.ts:4`, and
 * `lsp/startup-events.ts:3` name them. Named here rather than imported: the
 * package re-exports `task/types` with `export type *` (`src/index.ts:57`), so
 * the constants are unavailable as values.
 */
const PROGRESS_CHANNEL = "task:subagent:progress";
const SUBAGENT_EVENT_CHANNEL = "task:subagent:event";
const MCP_STATUS_CHANNEL = "mcp:connection-status";
const LSP_STARTUP_CHANNEL = "lsp:startup";

/** Custom-message types for the plugin's notices, namespaced as its others are. */
const GOAL_RELAY_MESSAGE = "com.srobroek.omp-orchestrate.goal-relay";
const SETTINGS_PREFLIGHT_MESSAGE = "com.srobroek.omp-orchestrate.settings-preflight";
const AGENT_PREFLIGHT_MESSAGE = "com.srobroek.omp-orchestrate.agent-preflight";

/**
 * Model roles this plugin's agents name that OMP does NOT ship.
 *
 * OMP's built-ins are exactly `default`, `smol`, `slow`, `vision`, `plan`, `designer`,
 * `commit`, `tiny`, `task` and `advisor` (`config/model-roles.ts`). Anything else is a
 * consumer prerequisite, and `resolveExplicitModelRole` returns undefined for an
 * unconfigured alias without warning -- so the run must announce it instead.
 *
 * `reviewer` gives the independent review agent its own configurable model selection.
 * Model-family separation is optional and requires an explicit model choice.
 *
 * `test/declared-surface.json` carries the same list and the suite asserts they agree.
 */
export const DECLARED_MODEL_ROLES: readonly string[] = ["reviewer"];

/**
 * Run id written before the run epic exists (`run-state.ts:37`). A marker still
 * carrying it names no bead, so there is nothing to annotate.
 */
const PENDING_RUN = "pending";

/** Record a watcher failure and carry on: a watcher never interferes with a session. */
function logFailure(pi: ExtensionAPI, watcher: string, error: unknown): void {
 pi.logger.error(`orchestrate ${watcher} failed`, {
  error: error instanceof Error ? error.message : String(error),
 });
}

/**
 * The run epic this repository answers to, or `undefined` when it is not under a
 * bound run.
 */
async function boundEpic(cwd: string): Promise<string | undefined> {
 const scope = await runScope({ cwd });
 if (scope === null || scope.runId === PENDING_RUN) return undefined;
 return scope.runId;
}

// ============================================================================
// W1 — stall detection
// ============================================================================

/** How often the sweep runs. Coarse deliberately: the threshold is in minutes. */
const SWEEP_MS = 60_000;

/** How often the landing sweep polls GitHub: one `gh pr list` per repository with open merge beads. */
const LANDING_SWEEP_MS = 60_000;

const DEFAULT_STALL_MINUTES = 10;

/** Minutes of silence that make a child stalled: `ORC_STALL_MINUTES`, or 10. */
export function stallMinutes(): number {
 const configured = Number(process.env.ORC_STALL_MINUTES);
 return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_STALL_MINUTES;
}

/** What stall detection reads off one progress payload. */
export interface ProgressSample {
 child: string;
 /** Cumulative tokens the child has spent. */
 tokens: number;
 /** The child's recent output tail, flattened so two samples compare by value. */
 output: string;
 /** True once the runtime reports the child as settled. */
 terminal: boolean;
}

/**
 * A `task:subagent:progress` payload reduced to the fields W1 needs, or
 * `undefined` when the emit carries none of them.
 *
 * The child's id rides on `progress.id` (`task/types.ts:398-400`); the payload's
 * own top level carries only `index` and `sessionFile`. The bus is untyped at
 * runtime (`utils/event-bus.ts:15`), so this verifies the shape rather than
 * casting — the doctrine `mcp/startup-events.ts:108-112` states for the same bus.
 */
export function progressSample(data: unknown): ProgressSample | undefined {
 if (data === null || typeof data !== "object" || !("progress" in data)) return undefined;
 const progress = data.progress;
 if (progress === null || typeof progress !== "object") return undefined;
 if (!("id" in progress) || typeof progress.id !== "string" || progress.id.length === 0) return undefined;

 const tokens = "tokens" in progress && typeof progress.tokens === "number" ? progress.tokens : 0;
 const lines =
  "recentOutput" in progress && Array.isArray(progress.recentOutput)
   ? progress.recentOutput.filter(line => typeof line === "string")
   : [];
 const status = "status" in progress ? progress.status : undefined;

 return {
  child: progress.id,
  tokens,
  output: lines.join("\n"),
  terminal: status === "completed" || status === "failed" || status === "aborted",
 };
}

interface ChildActivity {
 tokens: number;
 output: string;
 /** When this child's last progress delta was observed. */
 changedMs: number;
 /** Whether it has already been reported. Reported at most once. */
 flagged: boolean;
 /** The bead and notice, resolved once; kept across sweeps until the comment lands. */
 report?: { bead: string; notice: string };
}

const activity = new Map<string, ChildActivity>();

/**
 * Record one progress sample against the clock. A sample identical to its
 * predecessor is not a delta, which is what "silent" means here: a child
 * re-emitting the same token count and output tail is making no progress.
 *
 * A terminal sample drops the child. A finished child stops emitting progress, so
 * a tracker that kept it would report every completed worker as stalled once the
 * threshold elapsed.
 */
export function noteProgress(sample: ProgressSample, atMs: number): void {
 if (sample.terminal) {
  activity.delete(sample.child);
  return;
 }
 const seen = activity.get(sample.child);
 if (seen === undefined) {
  activity.set(sample.child, {
   tokens: sample.tokens,
   output: sample.output,
   changedMs: atMs,
   flagged: false,
  });
  return;
 }
 if (seen.tokens === sample.tokens && seen.output === sample.output) return;
 seen.tokens = sample.tokens;
 seen.output = sample.output;
 seen.changedMs = atMs;
}

/** A child that has gone silent, and for how long. */
export interface StallFlag {
 child: string;
 silentMinutes: number;
}

/** Pending silent children. Persistence, not detection, makes a report sticky. */
export function sweepStalls(atMs: number, thresholdMs: number): StallFlag[] {
 const flagged: StallFlag[] = [];
 for (const [child, state] of activity) {
  if (state.flagged) continue;
  const silentMs = atMs - state.changedMs;
  if (silentMs < thresholdMs) continue;
  flagged.push({ child, silentMinutes: Math.round(silentMs / 60_000) });
 }
 return flagged;
}

/**
 * Report one stalled child: a `STALL` comment on the bead it holds, the one carrier.
 * No kill — the spawner decides, because a silent child may be sitting in a long test
 * run. Liveness is the lease's business (`src/lease.ts`); this measures productivity.
 *
 * `claimedBead` is the assignee query, tie-broken on `updated_at` so a stale claim
 * cannot shadow a live one. A child holding no bead is left alone: there is
 * nothing to annotate, and the runtime already reports its exit.
 */
async function reportStall(flag: StallFlag): Promise<void> {
 const state = activity.get(flag.child);
 if (state === undefined) return;
 if (state.report === undefined) {
  const bead = await claimedBead(flag.child);
  if (bead === null || activity.get(flag.child) !== state) return;
  state.report = { bead: bead.id, notice: `STALL child ${flag.child} silent ${flag.silentMinutes}m on ${bead.id}` };
 }
 const result = await bdRun(["comment", state.report.bead, state.report.notice]);
 if (result?.code === 0) state.flagged = true;
}

/**
 * One sweep. The read budget is reset first, as every dispatch that reads bd does
 * (`bd.ts:59-62`): a sweep is its own dispatch, and a budget left exhausted by the
 * previous one would silently disable the watcher.
 */
let sweepInFlight = false;

async function sweep(pi: ExtensionAPI): Promise<void> {
 resetReadBudget();
 if (sweepInFlight) return;
 sweepInFlight = true;
 try {
  for (const flag of sweepStalls(Date.now(), stallMinutes() * 60_000)) {
   try {
    await reportStall(flag);
   } catch (error) {
    logFailure(pi, "stall report", error);
   }
  }
 } finally {
  // Rotate the first pending child so repeated unavailable claims cannot
  // monopolize every later sweep's read budget.
  for (const [child, state] of activity) {
   if (state.flagged) continue;
   activity.delete(child);
   activity.set(child, state);
   break;
  }
  sweepInFlight = false;
 }
}

// ============================================================================
// W2 — audit ledger
// ============================================================================

/**
 * The first writing `bd` invocation on a command line, or `undefined` when it runs
 * none.
 *
 * Shell-aware by construction rather than by regex: `shell.ts`'s tokeniser
 * resolves env-var prefixes, `env`/`command` wrappers, and every `;&|` segment
 * boundary, so `FOO=1 bd update x` and `cd /y && bd close z` both resolve while
 * `echo bd update` — where `bd` is an argument, not the command — does not.
 *
 * What counts as a write is G6's `writesBeads`, so the ledger and the actor notice
 * cannot disagree about it; the allowlist this replaced missed `assign`, `delete`,
 * `note`, `promote`, `link` and `merge-slot` while recording `label list`. The one
 * shape `writesBeads` exempts, `bd ready --claim`, is exempt for the notice's sake --
 * a queue pull precedes the identity it would carry -- and is the claim the
 * dead-claim procedure most wants to see, so the ledger records it.
 */
function bdWrite(command: string): BdInvocation | undefined {
 for (const invocation of bdInvocations(command)) {
  if (writesBeads(invocation) || invocation.hasClaim) return invocation;
 }
 return undefined;
}

/** The writing `bd` subcommand a command line runs, or `undefined` when it runs none. */
export function bdMutation(command: string): string | undefined {
 return bdWrite(command)?.subcommand;
}

/**
 * Where this session's ledger lives: under the cwd of the session that spawned the
 * children, which is where the dead-claim procedure reads it.
 */
export function auditDir(cwd: string): string {
 return path.join(cwd, ".orchestration", "audit");
}

/** One line of the ledger. */
export interface AuditEntry {
 ts: string;
 child: string;
 /** The command line the child ran, verbatim — the provenance a reader needs. */
 argv: string;
 exitCode: number;
 /** The beads directory the command wrote to, when the call or the session named one. */
 store?: string;
 /**
  * Present when the command named a store of its own -- `--db`, `BEADS_DB`, `-C` or
  * `--directory` -- rather than letting bd resolve the run's. Such a row is provenance
  * of a sandbox or another repository, not a run mutation, and a reader counting the
  * run's writes skips it.
  */
 foreign_store?: true;
}

/**
 * The longest stem a ledger name carries, leaving room for `.bdlog` inside the 255-byte
 * `NAME_MAX` every filesystem here enforces. The sanitiser below leaves only ASCII, so a
 * character is a byte and the margin needs no encoding arithmetic.
 */
const MAX_AUDIT_STEM = 200;

/**
 * A child id as a ledger file name, or `undefined` when nothing usable survives.
 * Ids arrive off the bus, and a path separator or a leading `..` in one would
 * write outside the ledger directory.
 *
 * Over-long ids are truncated rather than passed through: `appendFile` raises
 * ENAMETOOLONG past `NAME_MAX` and the W2 handler only logs that, so the line was lost
 * outright — a hole in the one record that says which child mutated which bead. Two long
 * ids sharing a file costs a reader nothing, because every row carries `child` verbatim:
 * the name is an index, not the datum.
 */
export function auditFileName(child: string): string | undefined {
 const safe = child.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
 if (safe.length === 0) return undefined;
 // Trimmed from the tail, so neither containment rule can be reintroduced: the
 // sanitiser has already removed every separator and every leading dot.
 return `${safe.slice(0, MAX_AUDIT_STEM)}.bdlog`;
}

/**
 * Append one JSONL line. `appendFile` opens `O_APPEND`, so concurrent children
 * writing their own files — or the same one — cannot interleave a partial line.
 */
export async function appendAudit(dir: string, entry: AuditEntry): Promise<void> {
 const name = auditFileName(entry.child);
 if (name === undefined) return;
 await fs.mkdir(dir, { recursive: true });
 await fs.appendFile(path.join(dir, name), `${JSON.stringify(entry)}\n`, "utf8");
}

/** A bd mutation a child ran, as read off `task:subagent:event`. */
export interface BdMutationEvent {
 child: string;
 command: string;
 exitCode: number;
 /**
  * The store the command named, when it named one: the `--db` path, a `BEADS_DB`
  * assignment on the invocation or in the call's structured `env`, or the directory
  * given to `-C`/`--directory`. `undefined` when bd resolved the run's database from the
  * working directory, which is how every call inside a run is meant to reach it; a
  * named store is foreign to the run by construction.
  */
 store: string | undefined;
}

/** `bd` flags whose value names a store or the directory it is resolved from. */
const STORE_FLAGS: Record<string, true> = { "--db": true, "-C": true, "--directory": true };

/**
 * The write a bash call performs, with the store it targets, or `undefined` when the
 * command writes no bead. Classifying by command text alone attributed a researcher's
 * sandbox writes to the run; the store is what tells them apart.
 */
function bdWriteOf(args: object): Pick<BdMutationEvent, "command" | "store"> | undefined {
 if (!("command" in args) || typeof args.command !== "string") return undefined;
 const invocation = bdWrite(args.command);
 if (invocation === undefined) return undefined;
 let store = invocation.assignments.get("BEADS_DB");
 if (store === undefined && "env" in args && args.env !== null && typeof args.env === "object") {
  if ("BEADS_DB" in args.env && typeof args.env.BEADS_DB === "string") store = args.env.BEADS_DB;
 }
 for (let index = 0; store === undefined && index < invocation.rest.length; index += 1) {
  const token = invocation.rest[index] as string;
  const split = token.indexOf("=");
  const flag = split === -1 ? token : token.slice(0, split);
  if (STORE_FLAGS[flag] !== true) continue;
  store = split === -1 ? invocation.rest[index + 1] : token.slice(split + 1);
 }
 return { command: args.command, store };
}

/**
 * The command's exit status. `bash` records `details.exitCode` only for a non-zero
 * exit (`tools/bash.ts:720-722`), so an absent code reads as 0 — unless the call
 * errored, which the ledger reports as 1 rather than as success.
 */
function exitCodeOf(result: unknown, isError: boolean): number {
 if (result !== null && typeof result === "object" && "details" in result) {
  const details = result.details;
  if (details !== null && typeof details === "object" && "exitCode" in details) {
   if (typeof details.exitCode === "number") return details.exitCode;
  }
 }
 return isError ? 1 : 0;
}

/**
 * Pending `bd` mutations, keyed by child and tool call, awaiting their exit status.
 *
 * Correlation is forced by the event shapes, verified against the installed
 * `pi-agent-core/src/types.ts:883-885`: `tool_execution_start` carries `args` but no
 * result, and `tool_execution_end` carries `result` and `isError` but **no `args`**.
 * The command therefore only ever appears on the start event and the status only on
 * the end event, so neither alone can produce a ledger line. An earlier version read
 * `args` off the end event and consequently recorded nothing at all, across a whole
 * run, while every unit test passed against the assumed shape.
 */
const pendingBd = new Map<string, Pick<BdMutationEvent, "child" | "command" | "store">>();

/**
 * Cap on un-settled starts. A child killed between start and end leaves its entry
 * behind, so the map is bounded rather than trusted to drain: the oldest entry goes
 * first, because `Map` preserves insertion order.
 */
const PENDING_LIMIT = 256;

/** The child id a forwarded payload names, or `undefined` when it names none. */
function childOf(data: unknown): string | undefined {
 if (data === null || typeof data !== "object") return undefined;
 if (!("id" in data) || typeof data.id !== "string" || data.id.length === 0) return undefined;
 return data.id;
}

/**
 * The bd mutation a `task:subagent:event` payload completes, or `undefined` when it
 * completes none.
 *
 * Fed every forwarded event: a start is remembered, an end is resolved against what
 * was remembered, and everything else is ignored. A `bd` call whose start was never
 * seen -- a session that began mid-flight -- is not invented, because the ledger's
 * value is that every line is a command a child actually ran.
 */
export function bdMutationEvent(data: unknown): BdMutationEvent | undefined {
 const child = childOf(data);
 if (child === undefined || data === null || typeof data !== "object" || !("event" in data)) return undefined;
 const event = data.event;
 if (event === null || typeof event !== "object" || !("type" in event)) return undefined;
 if (!("toolName" in event) || event.toolName !== "bash") return undefined;
 if (!("toolCallId" in event) || typeof event.toolCallId !== "string") return undefined;
 const key = `${child}\u0000${event.toolCallId}`;

 if (event.type === "tool_execution_start") {
  if (!("args" in event) || event.args === null || typeof event.args !== "object") return undefined;
  const write = bdWriteOf(event.args);
  if (write === undefined) return undefined;
  if (pendingBd.size >= PENDING_LIMIT) {
   const oldest = pendingBd.keys().next();
   if (!oldest.done) pendingBd.delete(oldest.value);
  }
  pendingBd.set(key, { child, ...write });
  return undefined;
 }

 if (event.type !== "tool_execution_end") return undefined;
 // Consumed either way, so a replayed end cannot double-count.
 const pending = pendingBd.get(key);
 pendingBd.delete(key);
 const result = "result" in event ? event.result : undefined;
 const isError = "isError" in event && event.isError === true;
 const exitCode = exitCodeOf(result, isError);

 // Prefer the end event's own `args` when the runtime supplies them. The typed
 // union omits the field, and the executor itself only probes for it
 // (`task/executor.ts:1470-1471`), but a live run records commands through this
 // path -- so it is read when present and correlated when not. Either shape alone
 // would silently record nothing on the runtime that uses the other.
 if ("args" in event && event.args !== null && typeof event.args === "object") {
  const write = bdWriteOf(event.args);
  return write === undefined ? undefined : { child, ...write, exitCode };
 }

 if (pending === undefined) return undefined;
 return { ...pending, exitCode };
}

// ============================================================================
// W3 — dispatch preflight
// ============================================================================

const degraded = new Set<string>();

/** Every MCP server or language server that reported itself unhealthy, sorted. */
export function degradedSet(): string[] {
 return [...degraded].sort();
}

/**
 * Fold one `mcp:connection-status` event in. Shapes are
 * `{type:"connecting", serverNames}`, `{type:"connected", serverName}`, and
 * `{type:"failed", serverName, error}` (`mcp/startup-events.ts:12-15`).
 *
 * A later `connected` clears the server: a retry that succeeds is not a
 * degradation, and warning about it would train the reader to ignore the warning.
 */
export function noteMcpStatus(data: unknown): void {
 if (data === null || typeof data !== "object" || !("type" in data)) return;
 if (!("serverName" in data) || typeof data.serverName !== "string") return;
 const item = `mcp:${data.serverName}`;
 if (data.type === "failed") degraded.add(item);
 else if (data.type === "connected") degraded.delete(item);
}

/**
 * Fold one `lsp:startup` event in. `completed` carries a per-server status,
 * `failed` means startup itself never ran (`lsp/startup-events.ts:5-13`).
 */
export function noteLspStartup(data: unknown): void {
 if (data === null || typeof data !== "object" || !("type" in data)) return;
 if (data.type === "failed") {
  degraded.add("lsp:startup");
  return;
 }
 if (data.type !== "completed") return;
 if (!("servers" in data)) return;
 const servers = data.servers;
 if (!Array.isArray(servers)) return;
 for (const server of servers) {
  if (server === null || typeof server !== "object") continue;
  if (!("name" in server) || typeof server.name !== "string") continue;
  const item = `lsp:${server.name}`;
  if ("status" in server && server.status === "error") degraded.add(item);
  else degraded.delete(item);
 }
}

/** How rarely the preflight warning repeats: one per wave, not one per spawn. */
const PREFLIGHT_INTERVAL_MS = 10 * 60_000;

let lastPreflightMs = Number.NEGATIVE_INFINITY;

/**
 * Warn that a spawn is going out into a degraded dependency. Writes to the bead
 * trail; revises nothing, blocks nothing. One comment is far easier to diagnose
 * than N identical worker failures.
 *
 * The stamp is taken before the write so two spawns in the same wave cannot both
 * warn.
 */
async function warnPreflight(cwd: string, atMs: number): Promise<void> {
 const items = degradedSet();
 if (items.length === 0) return;
 if (atMs - lastPreflightMs < PREFLIGHT_INTERVAL_MS) return;
 const epic = await boundEpic(cwd);
 if (epic === undefined) return;
 lastPreflightMs = atMs;
 await bdRun(["comment", epic, `WARN preflight: ${items.join(", ")} degraded`]);
}

const AGENT_PREFLIGHT_TIMEOUT_MS = 10_000;

function findingKey(finding: AgentDiscoveryFinding): string {
 return `${finding.agent}\0${finding.message}\0${finding.path ?? ""}`;
}

function findingLine(finding: AgentDiscoveryFinding): string {
 return `${finding.agent}: ${finding.message}${finding.path === undefined ? "" : ` (${finding.path})`}`;
}

/**
 * Check core and explicitly requested agent definitions without changing spawn policy.
 * When the runtime exposes effective roots, callers can pass them to the discovery
 * helper; ExtensionContext currently exposes no roots field, so the watcher delegates
 * to OMP's initialized discovery scope and otherwise reports what that scope resolves.
 */
export async function preflightAgents(
 pi: ExtensionAPI,
 ctx: AgentPreflightContext,
 requested: readonly string[] = [],
 reportedAgentFindings?: Set<string>,
): Promise<AgentDiscoveryFinding[]> {
 if (ctx.models === undefined) return [];
 const settings = readSettings() ?? {};
 const rawOverrides = settings["task.agentModelOverrides"];
 const modelOverrides =
  rawOverrides !== null && typeof rawOverrides === "object" && !Array.isArray(rawOverrides)
   ? (rawOverrides as Record<string, unknown>)
   : {};
 let rejectTimeout: (reason: Error) => void = () => { };
 const timeout = new Promise<AgentDiscoveryFinding[]>((_, reject) => {
  rejectTimeout = reason => reject(reason);
 });
 const timer = ctx.setTimeout(() => rejectTimeout(new Error("agent discovery timed out")), AGENT_PREFLIGHT_TIMEOUT_MS);
 try {
  const findings = await Promise.race([discoverAgentFindings(ctx, requested, modelOverrides), timeout]).catch(
   (error): AgentDiscoveryFinding[] => [{
    agent: "discovery",
    message: `unavailable: ${error instanceof Error ? error.message : String(error)}`,
   }],
  );
  const fresh = findings.filter(finding => {
   const key = findingKey(finding);
   if (reportedAgentFindings?.has(key)) return false;
   reportedAgentFindings?.add(key);
   return true;
  });
  if (fresh.length > 0) {
   pi.sendMessage({
    customType: AGENT_PREFLIGHT_MESSAGE,
    content: ["WARN agents: runtime discovery is incomplete or inconsistent.", ...fresh.map(finding => `- ${findingLine(finding)}`)].join("\n"),
    display: true,
   });
  }
  if (findings.length === 0) return findings;
  const epic = await boundEpic(ctx.cwd);
  if (epic !== undefined) {
   const pending = findings.filter(finding => !reportedAgentFindings?.has(`epic:${epic}\0${findingKey(finding)}`));
   if (pending.length > 0) {
    const keys = pending.map(finding => `epic:${epic}\0${findingKey(finding)}`);
    for (const key of keys) reportedAgentFindings?.add(key);
    const result = await bdRun(["comment", epic, `WARN agents: ${pending.map(findingLine).join("; ")}`], undefined, ctx.cwd);
    if (result?.code !== 0) {
     for (const key of keys) reportedAgentFindings?.delete(key);
    }
   }
  }
  return findings;
 } finally {
  ctx.clearTimer(timer);
 }
}

// ============================================================================
// W4 — goal relay
// ============================================================================

/** The goal fields an architect acts on. */
interface GoalNotice {
 id: string;
 objective: string;
 status: string;
}

interface GoalDelivery {
 delivered: Set<string>;
 complete: boolean;
 notified: number;
}
interface GoalQueue {
 latest: GoalNotice | null;
 running: Promise<void> | undefined;
 deliveries: Map<string, GoalDelivery>;
}
const goalQueues = new Map<string, GoalQueue>();

/**
 * The epics of one run. A bound run reaches its epics three ways -- the run epic
 * itself, an epic parented under it, and an epic stamped `metadata.run_epic`.
 * Without a positive binding there is no authorized write target.
 *
 * `metadata.origin` is the pre-split spelling of that stamp, still read so a run
 * already in flight keeps reaching its epics. Either key holds a run epic id here,
 * so the fallback cannot match an actor handle by accident.
 */
export function runEpics(epics: readonly BdBead[], runId: string | undefined): BdBead[] {
 if (runId === undefined) return [];
 return epics.filter(
  epic =>
   epic.id === runId ||
   epic.parent === runId ||
   metadataString(epic, "run_epic") === runId ||
   metadataString(epic, "origin") === runId,
 );
}

/**
 * Relay a goal change to the run's epics, durable first: a restarted or parked
 * architect reads the comment on wake, so the relay survives process death.
 *
 * `goal_updated` also fires for token accounting (`goals/runtime.ts:340-352`), so
 * receipts belong to the current consecutive goal version and its bound run.
 * One repository queue serializes versions and discards superseded work before
 * its next write. The managed sweep retries the latest goal after failures or binding.
 *
 * The architecture doc's second step is a `hub` doorbell to live architects.
 * Extensions have no IRC API, so the live half is a one-line notice in the lead's
 * own transcript; the content is already durable on the beads.
 */
async function deliverGoal(
 pi: ExtensionAPI,
 cwd: string,
 queue: GoalQueue,
 goal: GoalNotice,
 refresh: boolean,
): Promise<void> {
 resetReadBudget();
 const runId = await boundEpic(cwd);
 if (runId === undefined || queue.latest !== goal) return;
 let delivery = queue.deliveries.get(runId);
 if (delivery === undefined) {
  delivery = { delivered: new Set(), complete: false, notified: 0 };
  queue.deliveries.set(runId, delivery);
 }
 if (delivery.complete && !refresh) return;
 const open = await bdList(
  ["list", "--type", "epic", "--status", "open,in_progress", "--limit", "0", "--json"],
  undefined,
  cwd,
 );
 const targets = runEpics(open, runId);
 if (targets.length === 0 || queue.latest !== goal) return;
 delivery.complete = false;
 for (const epic of targets) {
  if (queue.latest !== goal) return;
  if (delivery.delivered.has(epic.id)) continue;
  const result = await bdRun(["comment", epic.id, `GOAL ${goal.status}: ${goal.objective}`], undefined, cwd);
  if (result?.code === 0) delivery.delivered.add(epic.id);
 }
 if (queue.latest !== goal || !targets.every(epic => delivery.delivered.has(epic.id))) return;
 delivery.complete = true;
 if (delivery.notified === delivery.delivered.size) return;
 delivery.notified = delivery.delivered.size;
 pi.sendMessage(
  {
   customType: GOAL_RELAY_MESSAGE,
   content: `GOAL ${goal.status} stamped on ${targets.map(epic => epic.id).join(", ")}`,
   display: true,
  },
  { triggerTurn: false },
 );
}

async function retryGoal(pi: ExtensionAPI, cwd: string, refresh = false): Promise<void> {
 resetReadBudget();
 const queue = goalQueues.get(cwd);
 if (queue === undefined) return;
 if (queue.running !== undefined) return queue.running;
 queue.running = (async () => {
  while (queue.latest !== null) {
   const goal = queue.latest;
   await deliverGoal(pi, cwd, queue, goal, refresh);
   if (queue.latest === goal) break;
  }
 })();
 try {
  await queue.running;
 } finally {
  queue.running = undefined;
 }
}

async function relayGoal(pi: ExtensionAPI, cwd: string, goal: GoalNotice | null): Promise<void> {
 resetReadBudget();
 let queue = goalQueues.get(cwd);
 if (queue === undefined) {
  queue = { latest: goal === null ? null : { ...goal }, running: undefined, deliveries: new Map() };
  goalQueues.set(cwd, queue);
 } else if (
  goal === null ||
  queue.latest === null ||
  goal.id !== queue.latest.id ||
  goal.status !== queue.latest.status ||
  goal.objective !== queue.latest.objective
 ) {
  queue.latest = goal === null ? null : { ...goal };
  queue.deliveries.clear();
 }
 await retryGoal(pi, cwd);
}

// ============================================================================
// Registration
// ============================================================================

/**
 * Drop every watcher's session state. Test seam; also the correct reset when a
 * run is re-bound beneath a live session.
 */
export function resetWatchers(): void {
 activity.clear();
 pendingBd.clear();
 degraded.clear();
 lastPreflightMs = Number.NEGATIVE_INFINITY;
 for (const queue of goalQueues.values()) queue.latest = null;
 goalQueues.clear();
 settingsChecked = false;
}

// ============================================================================
// W5 — settings preflight
// ============================================================================

/**
 * The session settings the integration model depends on, and what silently
 * happens when each is wrong.
 *
 * These were prose-only until an end-to-end run exposed the cost: under the
 * platform defaults (`merge: patch`, `apply: true`) a worker's commits are applied
 * straight into the spawning tree, so no `omp/task/<id>` branch is captured, the
 * architect's deliberate integration step never happens, and the run looks
 * healthy while the contract it rests on is not in force.
 *
 * `expected` returns the verdict for an observed value. An unreadable setting
 * yields no finding: this warns about what it can prove, never about what it
 * could not read.
 */
interface SettingRequirement {
 key: SettingPath;
 /** What the run needs, phrased for a human. */
 want: string;
 /** True when the observed value satisfies the requirement. */
 satisfied: (value: unknown) => boolean;
 /** What breaks while the setting deviates. */
 consequence: string;
}

/**
 * The shipped overlay that satisfies every requirement below. Applied to a session
 * with `omp --config <file>`, a layer above the operator's global and project
 * config, which is why the preflight can name a repair without rewriting either.
 */
export const OVERLAY_FILE = path.resolve(import.meta.dir, "..", "config", "orchestrate.overlay.yml");

const REQUIRED_SETTINGS: readonly SettingRequirement[] = [
 {
  key: "task.isolation.enabled",
  want: "true",
  satisfied: value => value === true,
  consequence: "workers share the architect's tree, so two claims can edit one file",
 },
 {
  key: "task.isolation.merge",
  want: "branch",
  satisfied: value => value === "branch",
  consequence:
   "commits are replayed as a patch instead of captured as a branch, so no omp/task/<id> branch survives to integrate or to recover after a crash",
 },
 {
  key: "task.isolation.apply",
  want: "false",
  satisfied: value => value === false,
  consequence: "child work is merged into the spawning tree automatically, so the architect never owns integration",
 },
 {
  key: "task.enableEffort",
  want: "true",
  satisfied: value => value === true,
  consequence: "the per-spawn effort is silently ignored, so every agent runs at the session default",
 },
 {
  key: "task.maxRecursionDepth",
  want: "3 or more",
  satisfied: value => typeof value === "number" && value >= 3,
  consequence:
   "a worker's helper sits at depth 3, so at the default 2 no worker can spawn librarian, scout, or operator",
 },
 {
  key: "bash.autoBackground.enabled",
  want: "false",
  satisfied: value => value === false,
  consequence:
   "slow claim commands can auto-background, so their completion bypasses the tool_result observer and the worker's claim is not adopted",
 },
];

/** One setting that deviates, named with what it should be and what that costs. */
export interface SettingDeviation {
 key: string;
 observed: unknown;
 want: string;
 consequence: string;
}

/**
 * Compare observed settings against the requirements. A key absent from `observed`
 * was unreadable and is skipped rather than reported.
 */
export function settingsDeviations(observed: Readonly<Record<string, unknown>>): SettingDeviation[] {
 const found: SettingDeviation[] = [];
 for (const requirement of REQUIRED_SETTINGS) {
  if (!(requirement.key in observed)) continue;
  const value = observed[requirement.key];
  if (requirement.satisfied(value)) continue;
  found.push({
   key: requirement.key,
   observed: value,
   want: requirement.want,
   consequence: requirement.consequence,
  });
 }
 return found;
}

/**
 * The settings the preflights read. Every one is a schema path, so the host answers each
 * with its effective value or its default; there is no unreadable key.
 */
const OBSERVED_SETTINGS: readonly SettingPath[] = [
 ...REQUIRED_SETTINGS.map(setting => setting.key),
 "modelRoles",
 "task.agentModelOverrides",
];

/**
 * The effective settings of the session this handler runs for, or `null` when no
 * settings instance is live.
 *
 * Read in process through the host's own accessor: the extension runner scopes every
 * handler to its session's `Settings` (`extensibility/extensions/runner.ts`,
 * `withActiveSettings`), and `findScopedSettings` answers with that instance, else the
 * global singleton. The values are the ones `omp config list` prints; spawning that CLI
 * cost 0.5 s idle and up to 3 s under load on every `task` dispatch. Unreadable proves
 * nothing, and a caller that treated `{}` as an answer would mark a check done that
 * never ran.
 */
export function readSettings(): Record<string, unknown> | null {
 const instance = findScopedSettings();
 if (instance === undefined) return null;
 const observed: Record<string, unknown> = {};
 for (const key of OBSERVED_SETTINGS) observed[key] = instance.get(key);
 return observed;
}

/** Set once the settings have actually been read; an unreadable host leaves the check pending. */
let settingsChecked = false;

/**
 * Report deviating settings once per session, on the notification surface and on
 * the run epic, and put the run's database pin in place.
 *
 * The bead comment is the load-bearing half: a run driven with `--print` shows no
 * notifications, and the operator who has to change a setting is often reading the
 * epic afterwards rather than watching a terminal. Warn-only by construction -- the
 * settings belong to the operator, and refusing to run would strand a repository
 * whose owner cannot reach its configuration.
 *
 * "Once" means once the settings were actually read. A process with no live settings
 * instance leaves the check pending, says so, and runs it again on the next
 * activation, instead of marking a check done that never happened.
 */
export async function preflightSettings(pi: ExtensionAPI, cwd: string): Promise<SettingDeviation[]> {
 resetReadBudget();
 if (settingsChecked) return [];
 const observed = readSettings();
 const lines: string[] = [];
 let deviations: SettingDeviation[] = [];
 if (observed === null) {
  lines.push(
   "the effective settings could not be read (no settings instance is live for this session), so the required task settings are unverified; the check runs again on the next /orchestrate-start",
  );
 } else {
  settingsChecked = true;
  deviations = settingsDeviations(observed);
  for (const deviation of deviations) {
   lines.push(`${deviation.key} is ${JSON.stringify(deviation.observed)}, needs ${deviation.want} -- ${deviation.consequence}`);
  }

  // `orc-reviewer` requires an explicitly configured `@reviewer` alias. Missing aliases
  // may fall back to the session model or fail selection. Preflight checks that the
  // selection exists, not whether author and reviewer use different model families.
  //
  // An UNREADABLE setting is skipped, matching this function's rule of warning only
  // about what it can prove. An empty object is not unreadable: it proves the role is
  // absent, which is exactly the case worth warning about.
  const roles = observed.modelRoles;
  if (typeof roles === "object" && roles !== null) {
   for (const role of DECLARED_MODEL_ROLES) {
    if (Object.hasOwn(roles, role)) continue;
    lines.push(
     `modelRoles.${role} is not configured; configure it before dispatch. An unresolved alias may fall back to the session model or fail selection. Independent review uses a separate agent; model-family separation is optional and requires an explicit model choice`,
    );
   }
  }
 }

 // The run's database is independent of the settings, and of whether they could be read.
 // Every isolated copy redirects its own `.beads` to the `beads_dir` the marker records
 // (`src/clone-adopt.ts`); a marker written before that field existed leaves each copy
 // writing to its private store. Re-activation records it, so that is the repair named.
 const scope = await runScope({ cwd });
 if (scope !== null && scope.beadsDir === undefined) {
  lines.push(
   "the run marker names no beads database, so an isolated worker resolves its own store rather than this run's: run /orchestrate-start again to record it",
  );
 }

 if (lines.length === 0) return deviations;

 const tail =
  `Restart the lead session with \`omp --config ${OVERLAY_FILE}\` (the shipped overlay; /orchestrate-doctor prints this command), or accept that captured branches, deliberate integration, and cross-worker claim exclusion are unavailable.`;

 pi.sendMessage({
  customType: SETTINGS_PREFLIGHT_MESSAGE,
  content: [
   "WARN settings: this run's coordination contract is not fully in force.",
   ...lines.map(line => `- ${line}`),
   tail,
  ].join("\n"),
  display: true,
 });

 const epic = await boundEpic(cwd);
 if (epic !== undefined) {
  await bdRun(["comment", epic, `WARN settings: ${lines.join("; ")}`], undefined, cwd);
 }
 return deviations;
}

/**
 * Wire all five watchers.
 *
 * Registration only: every bus subscription happens inside `session_start`, and
 * the two extension-event handlers are `pi.on` registrations, so importing this
 * module has no observable effect.
 */
export function registerWatchers(pi: ExtensionAPI, claims: ClaimState = createClaimState()): void {
 // Lifecycle handlers can run after construction's async scope has ended.
 const runInDiscoveryScope = AsyncLocalStorage.snapshot();
 let reportedAgentFindings = new Set<string>();
 let dispose = () => { };
 pi.on("session_start", async (_event, ctx) => {
  dispose();
  reportedAgentFindings = new Set<string>();
  const unsubscribers: Array<() => void> = [];
  dispose = () => {
   for (const unsubscribe of unsubscribers) unsubscribe();
  };
  const cwd = ctx.cwd;
  // W1. `progress.id` names the child; `Date.now()` is the only clock the
  // live watcher needs, and the sweep takes its own so it can be exercised.
  unsubscribers.push(
   pi.events.on(PROGRESS_CHANNEL, data => {
    const sample = progressSample(data);
    if (sample !== undefined) noteProgress(sample, Date.now());
   }),
  );
  // Returning the promise is deliberate: the managed timer contains a
  // rejection only when it can see one (`managed-timers.ts:66-75`). Nothing runs
  // outside a run scope: a silent child in a plain session is not this plugin's
  // business, and the sweep would otherwise spawn `bd list` for it every minute.
  const timer = ctx.setInterval(async () => {
   if ((await runScope({ cwd })) === null) return;
   await sweep(pi);
   if (sessionRole(pi) === "lead") {
    await retryGoal(pi, cwd, true).catch(error => logFailure(pi, "goal retry", error));
   }
  }, SWEEP_MS);
  unsubscribers.push(() => ctx.clearTimer(timer));
  // Landing (`landing.ts`): the lead polls every open merge bead's PR once a minute
  // and lands, refreshes, reruns or bounces it. Lead only, under a bound run: a worker
  // copy or a plain session must never merge. The sweep reads its own budget and
  // never throws; a failure is logged and the next tick tries again.
  const landing = ctx.setInterval(async () => {
   if (sessionRole(pi) !== "lead") return;
   const scope = await runScope(ctx);
   if (scope === null || scope.runId === PENDING_RUN) return;
   await landingSweep({ cwd: scope.root, runId: scope.runId }).catch(error => logFailure(pi, "landing sweep", error));
  }, LANDING_SWEEP_MS);
  unsubscribers.push(() => ctx.clearTimer(landing));

  // W5. The isolation contract is a session setting, so it is checked once, in
  // the session that spawns. A worker inherits whatever the lead was given and
  // cannot change it, so warning there would only duplicate the notice.
  //
  // Checked at start only where a run is already active: the contract governs
  // orchestrated runs, and a repository that merely tracks work in beads has no
  // claims to split until one starts. `/orchestrate-start` runs the settings check
  // at activation, and the `task` handler below checks agents at spawn, so a
  // session that never orchestrates hears nothing. Both preflights read the settings
  // in process, so neither costs a spawn.
  if (sessionRole(pi) === "lead" && (await runScope(ctx)) !== null) {
   preflightSettings(pi, cwd).catch(error => logFailure(pi, "settings preflight", error));
   runInDiscoveryScope(() => preflightAgents(pi, ctx, [], reportedAgentFindings)).catch(error =>
    logFailure(pi, "agent discovery preflight", error),
   );
  }
  // W2. Passive provenance of every child's bead mutations. A bus handler is
  // handed no context, so the ledger is rooted at the session's cwd as it was
  // at start. Read per event: a run activated mid-session starts recording without
  // re-subscribing, and a plain session never gains an `.orchestration/audit/`.
  unsubscribers.push(
   pi.events.on(SUBAGENT_EVENT_CHANNEL, async data => {
    const mutation = bdMutationEvent(data);
    if (mutation === undefined) return;
    if ((await runScope({ cwd })) === null) return;
    try {
     await appendAudit(auditDir(cwd), {
      ts: new Date().toISOString(),
      child: mutation.child,
      argv: mutation.command,
      exitCode: mutation.exitCode,
      ...(mutation.store === undefined ? {} : { store: mutation.store, foreign_store: true }),
     });
    } catch (error) {
     logFailure(pi, "audit ledger", error);
    }
   }),
  );

  // W3, first half: watch what degrades.
  unsubscribers.push(pi.events.on(MCP_STATUS_CHANNEL, noteMcpStatus));
  unsubscribers.push(pi.events.on(LSP_STARTUP_CHANNEL, noteLspStartup));
 });
 pi.on("session_shutdown", () => dispose());

 /**
  * W3, second half: G8's assignment notice, then the `task` preflight. Warning
  * dedupe never weakens the refusal: a known bad core request blocks every spawn.
  * Both wait for a run scope: spawning an `orc-*` agent outside a run gets no refusal
  * and costs no `omp config list`.
  */
 const noteAssignment = createAssignmentNotice(pi);
 pi.on("tool_call", async (event, ctx) => {
  try {
   if ((await runScope(ctx)) === null) return undefined;
   noteAssignment(ctx, claims.observedClaim());
   if (event.toolName !== "task") return undefined;
   const requested = requestedAgentNames(event.input);
   const findings = await runInDiscoveryScope(() =>
    preflightAgents(pi, ctx, requested, reportedAgentFindings),
   );
   const requestedCoreFindings = findings.filter(
    finding => requested.includes(finding.agent) && coreContractForAgent(finding.agent) !== undefined,
   );
   await warnPreflight(ctx.cwd, Date.now());
   if (requestedCoreFindings.length > 0) {
    return {
     block: true,
     reason: `requested core assignment refused: ${requestedCoreFindings.map(findingLine).join("; ")}`,
    };
   }
  } catch (error) {
   logFailure(pi, "preflight warning", error);
  }
  return undefined;
 });

 /**
  * W4. `goal_updated` fires only in the goal-owning session — subagents have no
  * `goal` tool — and the role guard states that rather than relying on it.
  */
 pi.on("goal_updated", async (event, ctx) => {
  if (sessionRole(pi) !== "lead") return;
  const goal = event.goal;
  // Clearing also cancels the latest pending relay and its timer retries.
  try {
   await relayGoal(pi, ctx.cwd, goal);
  } catch (error) {
   logFailure(pi, "goal relay", error);
  }
 });
}
