/**
 * W1-W4 — the runtime watchers.
 *
 * Four deterministic observers that record and warn but never gate: stall
 * detection, the bd-mutation audit ledger, dispatch preflight, and the goal
 * relay. Enforcement stays with G1 and the reaper; a watcher's worst failure is
 * silence.
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

import fs from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { type BdBead, bdList, bdRun, claimedBead, metadataString, resetReadBudget } from "./bd";
import { sessionRole } from "./identity";
import { readActiveRun } from "./run-state";
import { bdInvocations } from "./shell";

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

/**
 * Model roles this plugin's agents name that OMP does NOT ship.
 *
 * OMP's built-ins are exactly `default`, `smol`, `slow`, `vision`, `plan`, `designer`,
 * `commit`, `tiny`, `task` and `advisor` (`config/model-roles.ts`). Anything else is a
 * consumer prerequisite, and `resolveExplicitModelRole` returns undefined for an
 * unconfigured alias without warning -- so the run must announce it instead.
 *
 * `reviewer` is here because a critic must not share the model family it judges, and no
 * built-in expresses that: `slow` and `plan` are the authoring tier.
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
	const run = await readActiveRun(cwd);
	if (run === null || run.run_id === PENDING_RUN) return undefined;
	return run.run_id;
}

// ============================================================================
// W1 — stall detection
// ============================================================================

/** How often the sweep runs. Coarse deliberately: the threshold is in minutes. */
const SWEEP_MS = 60_000;

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

/**
 * Children whose last progress delta is older than `thresholdMs`, each returned
 * once. `atMs` is the caller's clock, so a sweep is exercised without waiting on
 * one.
 *
 * Flagging is sticky: the contract is one report per child. A child that resumes
 * and stalls again belongs to the patrol contract as a dead-claim candidate, not
 * to a second comment on the same bead.
 */
export function sweepStalls(atMs: number, thresholdMs: number): StallFlag[] {
	const flagged: StallFlag[] = [];
	for (const [child, state] of activity) {
		if (state.flagged) continue;
		const silentMs = atMs - state.changedMs;
		if (silentMs < thresholdMs) continue;
		state.flagged = true;
		flagged.push({ child, silentMinutes: Math.round(silentMs / 60_000) });
	}
	return flagged;
}

/**
 * Report one stalled child: a `STALL` comment on the bead it holds plus one error
 * wisp linked to that bead. No kill — the spawner decides, because a silent child
 * may be sitting in a long test run.
 *
 * `claimedBead` is the assignee query, tie-broken on `updated_at` so a stale claim
 * cannot shadow a live one. A child holding no bead is left alone: there is
 * nothing to annotate, and the runtime already reports its exit.
 */
async function reportStall(flag: StallFlag): Promise<void> {
	const bead = await claimedBead(flag.child);
	if (bead === null) return;
	const notice = `STALL child ${flag.child} silent ${flag.silentMinutes}m on ${bead.id}`;
	await bdRun(["comment", bead.id, notice]);
	await bdRun([
		"create",
		notice,
		"--ephemeral",
		"--wisp-type",
		"error",
		"--deps",
		`relates-to:${bead.id}`,
		"--silent",
	]);
}

/**
 * One sweep. The read budget is reset first, as every dispatch that reads bd does
 * (`bd.ts:59-62`): a sweep is its own dispatch, and a budget left exhausted by the
 * previous one would silently disable the watcher.
 */
async function sweep(pi: ExtensionAPI): Promise<void> {
	const flagged = sweepStalls(Date.now(), stallMinutes() * 60_000);
	if (flagged.length === 0) return;
	resetReadBudget();
	for (const flag of flagged) {
		try {
			await reportStall(flag);
		} catch (error) {
			logFailure(pi, "stall report", error);
		}
	}
}

// ============================================================================
// W2 — audit ledger
// ============================================================================

/** `bd` subcommands that change bead state. The ledger records only these. */
const MUTATING_SUBCOMMANDS: Record<string, true> = {
	update: true,
	close: true,
	create: true,
	comment: true,
	label: true,
	dep: true,
	reopen: true,
	"set-state": true,
};

/**
 * The mutating `bd` subcommand a command line runs, or `undefined` when it runs
 * none.
 *
 * Shell-aware by construction rather than by regex: `shell.ts`'s tokeniser
 * resolves env-var prefixes, `env`/`command` wrappers, and every `;&|` segment
 * boundary, so `FOO=1 bd update x` and `cd /y && bd close z` both resolve while
 * `echo bd update` — where `bd` is an argument, not the command — does not.
 */
export function bdMutation(command: string): string | undefined {
	for (const invocation of bdInvocations(command)) {
		// `=== true`: a subcommand named `constructor` or `toString` would otherwise
		// resolve through `Object.prototype` and be recorded as a bead mutation.
		if (MUTATING_SUBCOMMANDS[invocation.subcommand] === true) return invocation.subcommand;
	}
	return undefined;
}

let configuredAuditDir: string | undefined;

/**
 * Point the ledger somewhere other than the default. In production that is a run
 * epic's `metadata.artifacts_dir`; it is also the test seam.
 */
export function setAuditDir(dir: string | undefined): void {
	configuredAuditDir = dir;
}

/** Where this session's ledger lives. */
export function auditDir(cwd: string): string {
	return configuredAuditDir ?? path.join(cwd, ".orchestration", "audit");
}

/** One line of the ledger. */
export interface AuditEntry {
	ts: string;
	child: string;
	/** The command line the child ran, verbatim — the provenance a reader needs. */
	argv: string;
	exitCode: number;
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
const pendingBd = new Map<string, { child: string; command: string }>();

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
		const args = event.args;
		if (!("command" in args) || typeof args.command !== "string") return undefined;
		if (bdMutation(args.command) === undefined) return undefined;
		if (pendingBd.size >= PENDING_LIMIT) {
			const oldest = pendingBd.keys().next();
			if (!oldest.done) pendingBd.delete(oldest.value);
		}
		pendingBd.set(key, { child, command: args.command });
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
	const own = "args" in event && event.args !== null && typeof event.args === "object" ? event.args : undefined;
	if (own !== undefined && "command" in own && typeof own.command === "string") {
		if (bdMutation(own.command) === undefined) return undefined;
		return { child, command: own.command, exitCode };
	}

	if (pending === undefined) return undefined;
	return { child: pending.child, command: pending.command, exitCode };
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

// ============================================================================
// W4 — goal relay
// ============================================================================

/** The goal fields an architect acts on. */
interface GoalNotice {
	id: string;
	objective: string;
	status: string;
}

let relayedGoal: string | undefined;

/**
 * The epics of one run. A bound run reaches its epics three ways -- the run epic
 * itself, an epic parented under it, and an epic stamped `metadata.run_epic` (the
 * run-membership stamp) -- and an unbound marker reaches all of them, because there
 * is no run to filter by.
 *
 * `metadata.origin` is the pre-split spelling of that stamp, still read so a run
 * already in flight keeps reaching its epics. Either key holds a run epic id here,
 * so the fallback cannot match an actor handle by accident.
 */
export function runEpics(epics: readonly BdBead[], runId: string | undefined): BdBead[] {
	if (runId === undefined) return [...epics];
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
 * the relay keys on what an architect would act on — id, status, objective — and
 * skips a repeat. The key is recorded before the writes: a re-entrant event during
 * them must not double-stamp, and a goal whose write failed relays again on its
 * next change.
 *
 * The architecture doc's second step is a `hub` doorbell to live architects.
 * Extensions have no IRC API, so the live half is a one-line notice in the lead's
 * own transcript; the content is already durable on the beads.
 */
async function relayGoal(pi: ExtensionAPI, cwd: string, goal: GoalNotice): Promise<void> {
	const key = `${goal.id}\u0000${goal.status}\u0000${goal.objective}`;
	if (key === relayedGoal) return;
	relayedGoal = key;

	resetReadBudget();
	const open = await bdList(["list", "--type", "epic", "--status", "open,in_progress", "--json"]);
	const targets = runEpics(open, await boundEpic(cwd));
	if (targets.length === 0) return;

	for (const epic of targets) {
		await bdRun(["comment", epic.id, `GOAL ${goal.status}: ${goal.objective}`]);
	}
	pi.sendMessage(
		{
			customType: GOAL_RELAY_MESSAGE,
			content: `GOAL ${goal.status} stamped on ${targets.map(epic => epic.id).join(", ")}`,
			display: true,
		},
		{ triggerTurn: false },
	);
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
	relayedGoal = undefined;
	configuredAuditDir = undefined;
	settingsChecked = false;
}

// ============================================================================
// W5 — settings preflight
// ============================================================================

/**
 * The four session settings the integration model depends on, and what silently
 * happens when each is wrong.
 *
 * These were prose-only until an end-to-end run exposed the cost: under the
 * platform defaults (`merge: patch`, `apply: true`) a worker's commits are applied
 * straight into the spawning tree, so no `omp/task/<id>` branch is captured, the
 * architect's deliberate integration step never happens, and the run looks
 * healthy while the contract it rests on is not in force. Nothing in the
 * extension API exposes settings, so the operator's own CLI is asked.
 *
 * `expected` returns the verdict for an observed value. An unreadable setting
 * yields no finding: this warns about what it can prove, never about what it
 * could not read.
 */
interface SettingRequirement {
	key: string;
	/** What the run needs, phrased for a human. */
	want: string;
	/** True when the observed value satisfies the requirement. */
	satisfied: (value: unknown) => boolean;
	/** What breaks while the setting deviates. */
	consequence: string;
}

const REQUIRED_SETTINGS: readonly SettingRequirement[] = [
	{
		key: "task.isolation.mode",
		want: "anything but none",
		satisfied: value => typeof value === "string" && value !== "none",
		consequence: "workers share the architect's tree, so two claims can edit one file",
	},
	{
		key: "task.isolation.merge",
		want: "branch",
		satisfied: value => value === "branch",
		consequence: "commits are replayed as a patch instead of captured as a branch, so no omp/task/<id> branch survives to integrate or to recover after a crash",
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
 * Read one setting through `omp config get --json`, or `undefined` when it could
 * not be read. A missing key prints guidance rather than JSON, which parses to
 * nothing and is therefore indistinguishable from an unavailable CLI -- correctly,
 * because neither is evidence of a deviation.
 */
async function readSetting(key: string, cwd: string): Promise<unknown> {
	const bin = process.env.OMP_BIN ?? "omp";
	try {
		const proc = Bun.spawn([bin, "config", "get", key, "--json"], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
		});
		const timer = setTimeout(() => proc.kill(), 10_000);
		try {
			const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
			if (code !== 0) return undefined;
			const parsed: unknown = JSON.parse(stdout);
			if (parsed === null || typeof parsed !== "object" || !("value" in parsed)) return undefined;
			return parsed.value;
		} finally {
			clearTimeout(timer);
		}
	} catch {
		return undefined;
	}
}

let settingsChecked = false;

/**
 * The value each project-ownable requirement should carry in `<run repo>/.omp/config.yml`.
 *
 * Only settings whose correct value is the same for every machine belong here. The
 * global config cannot be trusted to carry them -- a run can start on any machine, and
 * root config differing per machine is exactly why the project file exists. Storage
 * mode and `modelRoles` stay out: the first is a migration, not a value, and the
 * second names machine-specific model selectors nothing here can guess.
 */
const OWNABLE_VALUES: Record<string, unknown> = {
	"task.isolation.mode": "auto",
	"task.isolation.merge": "branch",
	"task.isolation.apply": false,
	"task.enableEffort": true,
	"task.maxRecursionDepth": 3,
};

/** Render a plain tree as YAML. Objects and scalars only -- all this file ever holds. */
function renderYaml(node: Record<string, unknown>, indent = ""): string {
	let out = "";
	for (const [key, value] of Object.entries(node)) {
		if (value !== null && typeof value === "object" && !Array.isArray(value)) {
			out += `${indent}${key}:\n${renderYaml(value as Record<string, unknown>, `${indent}  `)}`;
		} else {
			out += `${indent}${key}: ${JSON.stringify(value)}\n`;
		}
	}
	return out;
}

/**
 * Write the deviating project-ownable settings into `<run repo>/.omp/config.yml`.
 *
 * Settings are read once at process start, so this cannot repair the RUNNING session --
 * it makes the next start correct, and the preflight message says to restart. An
 * existing file is merged, not clobbered: unrelated keys survive, though comments do
 * not. A file that exists but does not parse is left alone entirely, because rewriting
 * a file we cannot read destroys whatever it held.
 *
 * Returns the file path when written, undefined when nothing was safe to write.
 */
async function ensureProjectSettings(cwd: string, keys: readonly string[]): Promise<string | undefined> {
	const ownable = keys.filter(key => key in OWNABLE_VALUES);
	if (ownable.length === 0) return undefined;

	const file = path.join(cwd, ".omp", "config.yml");
	let root: Record<string, unknown> = {};
	const existing = await fs.readFile(file, "utf8").catch(() => undefined);
	if (existing !== undefined && existing.trim().length > 0) {
		try {
			const parsed: unknown = Bun.YAML.parse(existing);
			if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
			root = structuredClone(parsed) as Record<string, unknown>;
		} catch {
			return undefined;
		}
	}

	for (const key of ownable) {
		const segments = key.split(".");
		let node = root;
		for (const segment of segments.slice(0, -1)) {
			const next = node[segment];
			if (next === null || typeof next !== "object" || Array.isArray(next)) node[segment] = {};
			node = node[segment] as Record<string, unknown>;
		}
		node[segments[segments.length - 1] as string] = OWNABLE_VALUES[key];
	}

	try {
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, renderYaml(root));
		return file;
	} catch {
		return undefined;
	}
}

/**
 * Report deviating settings once per session, on the notification surface and on
 * the run epic.
 *
 * The bead comment is the load-bearing half: a run driven with `--print` shows no
 * notifications, and the operator who has to change a setting is often reading the
 * epic afterwards rather than watching a terminal. Warn-only by construction -- the
 * settings belong to the operator, and refusing to run would strand a repository
 * whose owner cannot reach its configuration.
 */
export async function preflightSettings(pi: ExtensionAPI, cwd: string): Promise<SettingDeviation[]> {
	if (settingsChecked) return [];
	settingsChecked = true;
	const observed: Record<string, unknown> = {};
	for (const { key } of REQUIRED_SETTINGS) {
		const value = await readSetting(key, cwd);
		if (value !== undefined) observed[key] = value;
	}
	const deviations = settingsDeviations(observed);
	const lines = deviations.map(
		deviation =>
			`${deviation.key} is ${JSON.stringify(deviation.observed)}, needs ${deviation.want} -- ${deviation.consequence}`,
	);

	// The database check is independent of the settings: isolation working correctly
	// is exactly what splits the database, so a run with a perfect settings block can
	// still lose every claim.
	//
	// An unreadable mode is not evidence of isolation. `observed` holds only the keys
	// that answered, so testing `!== "none"` would read a missing key as "isolating"
	// and warn about a split database on a run that may have no isolation at all --
	// the opposite of this function's rule of warning only about what it can prove.
	const mode = observed["task.isolation.mode"];
	const isolating = typeof mode === "string" && mode !== "none";
	// A repository with no beads database has no claims to split, so the precondition
	// does not apply and saying so is noise. Observed in the field: this fired in a
	// repository that had never run `bd init`, where the advice was unactionable.
	const tracked = await fs
		.stat(path.join(cwd, ".beads"))
		.then(entry => entry.isDirectory())
		.catch(() => false);
	// Under an embedded database the precondition is a pinned PATH, not a server. bd resolves
	// by walking up from the working directory, `.beads/` is gitignored, so a clone or worktree
	// arrives without one and the walk continues past the checkout. Measured on this host:
	// `$HOME/.beads` exists, so the walk can end in a personal database that no run reads.
	//
	// An earlier version of this line demanded a per-project Dolt server instead. That server
	// cost a lifecycle nobody owned: bd decides whether one runs from `.beads/dolt-server.pid`
	// rather than from the port, so a removed pid file made every later call start a rival --
	// nine consecutive lock refusals in one log, and 28 orphaned servers on this machine.
	if (tracked && isolating && (process.env.BEADS_DIR ?? "") === "") {
		lines.push(
			"isolation is on and BEADS_DIR is unset, so an isolated worker resolves its own beads database rather than this run's. bd walks up from the working directory and `.beads/` is gitignored, so a clone or worktree arrives without one and the walk can end in a personal database. `/orchestrate-run` pins the run's path for this session and every child it spawns",
		);
	}

	// `orc-reviewer` names `@reviewer`, which is NOT one of OMP's ten built-in roles. An
	// alias OMP cannot resolve returns undefined with NO warning and falls back to the
	// session default, so an unconfigured consumer would silently run its reviewer on the
	// author's own model -- losing the family separation the role exists to provide.
	//
	// Announced here because a prerequisite that fails silently is the defect this whole
	// preflight exists to prevent. `test/declared-surface.json` holds the same list, and
	// the suite asserts the two agree, so neither can drift alone.
	//
	// An UNREADABLE setting is skipped, matching this function's rule of warning only
	// about what it can prove. An empty object is not unreadable: it proves the role is
	// absent, which is exactly the case worth warning about.
	const roles = await readSetting("modelRoles", cwd);
	if (typeof roles === "object" && roles !== null) {
		for (const role of DECLARED_MODEL_ROLES) {
			if (Object.hasOwn(roles, role)) continue;
			lines.push(
				`modelRoles.${role} is not configured, so \`@${role}\` resolves to nothing and the agent naming it silently runs the session default -- add it, or accept that a critic shares the family it judges`,
			);
		}
	}

	if (lines.length === 0) return deviations;

	// Ensure, not merely warn: the project-ownable values are written into the run
	// repository's own `.omp/config.yml`, because the global config differs per machine
	// and a run can start on any of them. Settings load at process start, so the write
	// repairs the NEXT session; the message says to restart rather than pretending the
	// running one was fixed.
	const written = await ensureProjectSettings(
		cwd,
		deviations.map(deviation => deviation.key),
	);
	const tail =
		written === undefined
			? "Fix and restart the run, or accept that captured branches, deliberate integration, and cross-worker claim exclusion are unavailable."
			: `The project-ownable settings above were written to ${written} (existing keys kept, comments not preserved). Restart the run to load them; the rest need your hands.`;

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
export function registerWatchers(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		const cwd = ctx.cwd;

		// W1. `progress.id` names the child; `Date.now()` is the only clock the
		// live watcher needs, and the sweep takes its own so it can be exercised.
		pi.events.on(PROGRESS_CHANNEL, data => {
			const sample = progressSample(data);
			if (sample !== undefined) noteProgress(sample, Date.now());
		});
		// Returning the promise is deliberate: the managed timer contains a
		// rejection only when it can see one (`managed-timers.ts:66-75`).
		ctx.setInterval(() => sweep(pi), SWEEP_MS);

		// W5. The isolation contract is a session setting, so it is checked once, in
		// the session that spawns. A worker inherits whatever the lead was given and
		// cannot change it, so warning there would only duplicate the notice.
		if (sessionRole(pi) === "lead") {
			preflightSettings(pi, cwd).catch(error => logFailure(pi, "settings preflight", error));
		}

		// W2. Passive provenance of every child's bead mutations. A bus handler is
		// handed no context, so the ledger is rooted at the session's cwd as it was
		// at start; a run that relocates names its directory through `setAuditDir`,
		// which is why the path is resolved per write rather than captured here.
		pi.events.on(SUBAGENT_EVENT_CHANNEL, async data => {
			const mutation = bdMutationEvent(data);
			if (mutation === undefined) return;
			try {
				await appendAudit(auditDir(cwd), {
					ts: new Date().toISOString(),
					child: mutation.child,
					argv: mutation.command,
					exitCode: mutation.exitCode,
				});
			} catch (error) {
				logFailure(pi, "audit ledger", error);
			}
		});

		// W3, first half: watch what degrades.
		pi.events.on(MCP_STATUS_CHANNEL, noteMcpStatus);
		pi.events.on(LSP_STARTUP_CHANNEL, noteLspStartup);
	});

	/**
	 * W3, second half: observe `task` spawns.
	 *
	 * A handler of its own, separate from the gate dispatcher: every registered
	 * handler runs (`extensions/runner.ts:1462-1470`), and this one returns nothing
	 * on every path, so a degraded dependency can never become a reason a wave does
	 * not launch.
	 */
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "task") return undefined;
		try {
			resetReadBudget();
			await warnPreflight(ctx.cwd, Date.now());
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
		// A cleared goal names no objective, so there is nothing to relay. A
		// dropped or completed one still carries both and relays like any other.
		if (goal === null) return;
		try {
			await relayGoal(pi, ctx.cwd, goal);
		} catch (error) {
			logFailure(pi, "goal relay", error);
		}
	});
}
