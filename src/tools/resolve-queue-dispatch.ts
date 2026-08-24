/**
 * `orc_resolve_queue_dispatch` — resolve one release-queue-watch record to an orchestrate node.
 *
 * A native port of `skills/orchestrate/scripts/resolve-queue-dispatch.py`, pinned by that
 * script's own suite (`_test_resolve_queue_dispatch.py`), which `test/resolve-queue-dispatch.test.ts`
 * reproduces case for case. The decision is pure: a watcher record plus a `bd list --json`
 * snapshot in, a receipt plan out. Nothing here mutates a bead — the caller persists
 * `requiredMetadata`, which is what makes a crashed handoff replayable rather than lost.
 *
 * The exit vocabulary is the contract callers branch on, so it is preserved verbatim:
 * 0 resolved/replay/duplicate/control record, 1 invalid input, 2 no orchestrate owner (safe to
 * route once to pr-shepherd), 3 ambiguous or invalid orchestrate ownership (do not reroute).
 * Codes 2 and 3 are distinct on purpose: rerouting an ambiguously owned PR hands the same
 * branch to two owners.
 *
 * `// PARITY:` marks every point where this port knowingly reads differently from CPython.
 */

import type { AgentToolResult, ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import path from "node:path";

const REPOSITORY_RE = /^[^/\s]+\/[^/\s]+$/;
const HEAD_SHA_RE = /^[0-9a-fA-F]{7,64}$/;

const REQUIRED_PULL_REQUEST_FIELDS = [
	"repository",
	"number",
	"title",
	"headSha",
	"baseRef",
	"labels",
	"priority",
	"draft",
	"mergeable",
	"checks",
	"createdAt",
	"updatedAt",
	"state",
	"activeSince",
] as const;

const LIFECYCLE_TRANSITIONS: Record<string, true> = {
	opened: true,
	updated: true,
	failed: true,
	merged: true,
	closed: true,
};
const LIFECYCLE_SOURCES: Record<string, true> = { webhook: true, reconciliation: true };
const CHECK_STATES: Record<string, true> = { pass: true, pending: true, fail: true };
const QUEUE_STATES: Record<string, true> = { active: true, queued: true, blocked: true, closed: true };

/** Transitions that wake the shepherd whatever the node's review state. */
const TERMINAL_TRANSITIONS: Record<string, true> = { failed: true, merged: true, closed: true };

/** A watcher record violated the handoff contract. Exit 1. */
export class ContractError extends Error {
	override readonly name: string = "ContractError";
}

/** A valid queue record has no *unique* orchestrate owner. Exit 3. */
export class ResolutionError extends Error {
	override readonly name: string = "ResolutionError";
}

/** A valid queue record has no orchestrate owner at all. Exit 2. */
export class UnmatchedError extends ResolutionError {
	override readonly name: string = "UnmatchedError";
}

/** How far a receipt for one event key got before the last crash. */
export type DeliveryState = "ack" | "sent" | "pending" | "untracked";

/** Both event kinds share the replay ladder: first sighting, redelivery, already acked. */
export type EventStatus = "resolved" | "replay" | "duplicate";

/** An approved dispatch matched to the node that owns the branch. */
export interface HandoffResult {
	status: EventStatus;
	/** `null` once the event is admitted: the receipt does not exist yet. */
	deliveryState: DeliveryState | null;
	requiredMetadata: Record<string, string>;
	node: string;
	dispatchKey: string;
	repository: string;
	number: number;
	headSha: string;
	branch: string;
	baseSha: string;
	priority?: number;
}

/** A lifecycle transition matched to its orchestrate node. */
export interface LifecycleResult {
	status: EventStatus;
	eventType: "pr-lifecycle";
	deliveryState: DeliveryState | null;
	requiredMetadata: Record<string, string>;
	node: string;
	lifecycleKey: string;
	transition: string;
	source: string;
	wakeShepherd: boolean;
	repository: string;
	number: number;
	headSha: string;
	/** The PR moved off the head the node is anchored to. Observed, never acted on here. */
	headChanged: boolean;
	branch?: string;
	baseSha?: string;
}

/** The watcher itself failed; the run falls back to gate-checking the PR by hand. */
export interface FallbackResult {
	status: "fallback";
	recordType: string;
	action: "gate-check-and-pass";
	message: string;
	repository: string | null;
}

/** A record this resolver has no opinion about (watcher heartbeats and the like). */
export interface IgnoredResult {
	status: "ignored";
	recordType: unknown;
}

export type ResolveResult = HandoffResult | LifecycleResult | FallbackResult | IgnoredResult;

/** Everything the snapshot says is still owed a delivery. */
export interface ReplayResult {
	status: "replay";
	dispatches: HandoffResult[];
	lifecycles: LifecycleResult[];
}

/** A validated `pr-lifecycle` record, narrowed to the fields the resolver reads. */
export interface LifecycleEvent {
	transition: string;
	source: string;
	lifecycleKey: string;
	pullRequest: Record<string, unknown>;
}

/** A bead or its metadata: an untyped JSON object out of a `bd` snapshot. */
type Bead = Record<string, unknown>;

/**
 * A JSON object, which is what Python's `isinstance(x, dict)` accepts — arrays excluded.
 *
 * The module's one guard: the script tests `isinstance(..., dict)` a dozen times, and
 * open-coding that at each site would bury the parity this port is judged on.
 */
function isObject(value: unknown): value is Bead {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

/**
 * `type(value) is int` for a JSON number.
 *
 * PARITY: `json` gives CPython a `float` for `42.0` and the script rejects it; `JSON.parse`
 * cannot tell `42.0` from `42`, so this accepts it. The distinction is unrecoverable after
 * parsing, and no caller emits fractional PR numbers or priorities.
 */
function isInt(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value);
}

/** Render a table's keys the way Python renders `sorted(...)` inside an f-string. */
function pyList(values: Record<string, true>): string {
	return `[${Object.keys(values)
		.sort()
		.map((value) => `'${value}'`)
		.join(", ")}]`;
}

/**
 * Python's `int()` over a JSON value, or `null` where it would raise.
 *
 * Booleans are rejected rather than coerced. CPython's `int(True) == 1`, which is why every
 * caller in the script guards with `isinstance(raw_pr, bool)` first — a node carrying
 * `pr: true` must never answer for PR #1.
 *
 * PARITY: `int()` also accepts non-ASCII decimal digits (`int('٤٢') == 42`); this does not.
 */
function pyInt(value: unknown): number | null {
	if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : null;
	if (typeof value === "string") {
		const text = value.trim();
		// Python permits single underscores between digits (`int("1_000")`), nowhere else.
		if (!/^[+-]?\d+(?:_\d+)*$/.test(text)) return null;
		return Number(text.replace(/_/g, ""));
	}
	return null;
}

/**
 * A node's labels as a set, ignoring non-string entries.
 *
 * PARITY: the script iterates whatever `labels` holds, so an object yields its keys and a
 * string yields its characters; both are reproduced. A non-iterable value (a number, or an
 * explicit `null`) raises `TypeError` there and exits 1 with a traceback — this raises
 * `ContractError`, which is the same exit code with a message a reader can act on.
 */
function labelSet(node: Bead): Set<string> {
	const labels = node.labels;
	if (labels === undefined) return new Set();
	if (Array.isArray(labels)) return new Set(labels.filter((label): label is string => typeof label === "string"));
	if (typeof labels === "string") return new Set(labels);
	if (isObject(labels)) return new Set(Object.keys(labels));
	throw new ContractError("node labels must be an array of strings");
}

/** A live orchestrate node paired with its metadata, or `null` when the entry is neither. */
function liveNode(entry: unknown): { node: Bead; metadata: Bead } | null {
	if (!isObject(entry) || entry.status !== "in_progress") return null;
	return isObject(entry.metadata) ? { node: entry, metadata: entry.metadata } : null;
}

/** The PR number a node claims, or `null` when it claims none usable. */
function nodePr(metadata: Bead): number | null {
	if (typeof metadata.pr === "boolean") return null;
	return pyInt(metadata.pr);
}

/**
 * Validate a `dispatch` record, or return `null` when the record is not one.
 *
 * A dispatch is only ever emitted for a PR the watcher believes is ready, so every readiness
 * field is re-checked here: the resolver refuses to hand a shepherd a draft or a failing PR
 * even if the watcher offers one.
 */
export function validateRecord(record: unknown): Bead | null {
	if (!isObject(record)) throw new ContractError("watcher record must be a JSON object");
	if (record.type !== "dispatch") return null;
	const pullRequest = record.pullRequest;
	if (!isObject(pullRequest)) throw new ContractError("dispatch.pullRequest must be a JSON object");
	const missing = REQUIRED_PULL_REQUEST_FIELDS.filter((field) => !(field in pullRequest)).sort();
	if (missing.length > 0) {
		throw new ContractError(`dispatch.pullRequest missing fields: ${missing.join(", ")}`);
	}

	const { repository, number, headSha, priority, labels } = pullRequest;
	if (typeof repository !== "string" || !REPOSITORY_RE.test(repository)) {
		throw new ContractError("repository must be OWNER/REPO");
	}
	if (!isInt(number) || number < 1) throw new ContractError("number must be a positive integer");
	if (typeof headSha !== "string" || !HEAD_SHA_RE.test(headSha)) {
		throw new ContractError("headSha must be a hexadecimal Git object id");
	}
	if (!isInt(priority) || priority < 0 || priority > 4) {
		throw new ContractError("priority must be an integer from 0 through 4");
	}
	if (!Array.isArray(labels) || !labels.every((label) => typeof label === "string")) {
		throw new ContractError("labels must be an array of strings");
	}
	for (const field of ["title", "baseRef", "createdAt", "updatedAt", "activeSince"] as const) {
		if (!isNonEmptyString(pullRequest[field])) throw new ContractError(`${field} must be a non-empty string`);
	}
	if (pullRequest.draft !== false) throw new ContractError("dispatch must describe a non-draft pull request");
	if (pullRequest.mergeable !== true) throw new ContractError("dispatch must describe a mergeable pull request");
	if (pullRequest.checks !== "pass") throw new ContractError("dispatch checks must be pass");
	if (pullRequest.state !== "active") throw new ContractError("dispatch state must be active");
	return pullRequest;
}

/**
 * Validate a `pr-lifecycle` record, or return `null` when the record is not one.
 *
 * Lifecycle records describe a PR at any point in its life, so unlike a dispatch they may
 * carry a draft, failing, or closed PR. What is checked is internal consistency: a `failed`
 * transition whose checks pass, or a `merged` one whose PR is still open, is a watcher bug.
 */
export function validateLifecycleRecord(record: unknown): LifecycleEvent | null {
	if (!isObject(record)) throw new ContractError("watcher record must be a JSON object");
	if (record.type !== "pr-lifecycle") return null;
	const { transition, source, lifecycleKey } = record;
	if (typeof transition !== "string" || LIFECYCLE_TRANSITIONS[transition] !== true) {
		throw new ContractError(`transition must be one of ${pyList(LIFECYCLE_TRANSITIONS)}`);
	}
	if (typeof source !== "string" || LIFECYCLE_SOURCES[source] !== true) {
		throw new ContractError(`source must be one of ${pyList(LIFECYCLE_SOURCES)}`);
	}
	if (!isNonEmptyString(lifecycleKey)) throw new ContractError("lifecycleKey must be a non-empty string");
	const pullRequest = record.pullRequest;
	if (!isObject(pullRequest)) throw new ContractError("pr-lifecycle.pullRequest must be a JSON object");
	const missing = REQUIRED_PULL_REQUEST_FIELDS.filter((field) => !(field in pullRequest)).sort();
	if (missing.length > 0) {
		throw new ContractError(`pr-lifecycle.pullRequest missing fields: ${missing.join(", ")}`);
	}
	const { repository, number, headSha, checks, state, activeSince } = pullRequest;
	if (typeof repository !== "string" || !REPOSITORY_RE.test(repository)) {
		throw new ContractError("repository must be OWNER/REPO");
	}
	if (!isInt(number) || number < 1) throw new ContractError("number must be a positive integer");
	if (typeof headSha !== "string" || !HEAD_SHA_RE.test(headSha)) {
		throw new ContractError("headSha must be a hexadecimal Git object id");
	}
	const priority = pullRequest.priority;
	if (!isInt(priority) || priority < 0 || priority > 4) {
		throw new ContractError("priority must be an integer from 0 through 4");
	}
	if (!Array.isArray(pullRequest.labels) || !pullRequest.labels.every((label) => typeof label === "string")) {
		throw new ContractError("labels must be an array of strings");
	}
	for (const field of ["title", "baseRef", "createdAt", "updatedAt"] as const) {
		if (!isNonEmptyString(pullRequest[field])) throw new ContractError(`${field} must be a non-empty string`);
	}
	if (typeof pullRequest.draft !== "boolean") throw new ContractError("draft must be a boolean");
	if (pullRequest.mergeable !== null && typeof pullRequest.mergeable !== "boolean") {
		throw new ContractError("mergeable must be a boolean or null");
	}
	if (typeof checks !== "string" || CHECK_STATES[checks] !== true) {
		throw new ContractError(`checks must be one of ${pyList(CHECK_STATES)}`);
	}
	if (typeof state !== "string" || QUEUE_STATES[state] !== true) {
		throw new ContractError(`state must be one of ${pyList(QUEUE_STATES)}`);
	}
	if (activeSince !== null && !isNonEmptyString(activeSince)) {
		throw new ContractError("activeSince must be a non-empty string or null");
	}
	if (transition === "failed" && checks !== "fail") throw new ContractError("failed lifecycle checks must be fail");
	if ((transition === "merged" || transition === "closed") && state !== "closed") {
		throw new ContractError("terminal lifecycle pullRequest.state must be closed");
	}
	if (source === "webhook") {
		for (const field of ["deliveryId", "webhookAction"] as const) {
			if (!isNonEmptyString(record[field])) {
				throw new ContractError(`webhook lifecycle ${field} must be a non-empty string`);
			}
		}
	}
	return { transition, source, lifecycleKey, pullRequest };
}

/** Which receipt the node already carries for `eventKey`, newest stage first. */
function deliveryState(metadata: Bead, prefix: string, eventKey: string): DeliveryState {
	if (metadata[`${prefix}_ack`] === eventKey) return "ack";
	if (metadata[`${prefix}_sent`] === eventKey) return "sent";
	if (metadata[`${prefix}_pending`] === eventKey) return "pending";
	return "untracked";
}

/**
 * Refuse to act on a node whose receipts contradict its current event key.
 *
 * Three shapes are rejected, and each one would otherwise lose or duplicate a delivery:
 * receipts for a *different* key than the one the node is anchored to; receipts naming this
 * event while the anchor does not (a half-written rollback); and replacing an anchor whose
 * own delivery was never acknowledged, which would silently drop the earlier handoff.
 *
 * A fully acknowledged prior lineage is the one exception — its receipts are allowed to sit
 * alongside the new anchor until the next stage overwrites them.
 */
function validateReceiptLineage(metadata: Bead, prefix: string, eventKey: string): void {
	const currentKey = metadata[prefix];
	const acknowledgedKey = metadata[`${prefix}_ack`];
	// Order is load-bearing: it decides which field a mismatch message names first.
	const receipts: [string, unknown][] = [
		[`${prefix}_pending`, metadata[`${prefix}_pending`]],
		[`${prefix}_sent`, metadata[`${prefix}_sent`]],
		[`${prefix}_ack`, acknowledgedKey],
	];
	for (const [field, value] of receipts) {
		if (value !== undefined && value !== null && !isNonEmptyString(value)) {
			throw new ResolutionError(`${field} must be a non-empty string`);
		}
	}

	if (currentKey === eventKey) {
		const completedPriorKey =
			typeof acknowledgedKey === "string" && acknowledgedKey !== eventKey ? acknowledgedKey : null;
		const mismatched = receipts
			.filter(([, value]) => value !== undefined && value !== null)
			.filter(([, value]) => value !== eventKey && value !== completedPriorKey)
			.map(([field]) => field);
		if (mismatched.length > 0) {
			throw new ResolutionError(`${prefix} receipt mismatch in ${mismatched.join(", ")}`);
		}
		return;
	}

	const matching = receipts.filter(([, value]) => value === eventKey).map(([field]) => field);
	if (matching.length > 0) {
		throw new ResolutionError(`${prefix} does not match receipts in ${matching.join(", ")}`);
	}

	if (isNonEmptyString(currentKey) && acknowledgedKey !== currentKey) {
		throw new ResolutionError(`cannot replace unacknowledged ${prefix} ${currentKey}`);
	}
}

/**
 * Reject a snapshot where two live nodes claim the same PR.
 *
 * Only the replay scans check this. A single record resolves through its own candidate count,
 * but a scan walks every node, so without this a duplicate claim would fan one PR's receipts
 * out to two owners.
 */
function ensureUniqueNodeOwnership(nodes: unknown[]): void {
	const owners = new Map<string, string>();
	for (const entry of nodes) {
		const live = liveNode(entry);
		if (!live || !labelSet(live.node).has("orc-node")) continue;
		const number = nodePr(live.metadata);
		if (number === null) continue;
		const repository = live.metadata.repo;
		if (typeof repository !== "string" || !REPOSITORY_RE.test(repository)) continue;
		const identity = `${repository}\u0000${number}`;
		const existing = owners.get(identity);
		const owner = String(live.node.id);
		if (existing !== undefined) {
			throw new ResolutionError(
				`duplicate orchestrate node ownership for ${repository}#${number}: ${existing} and ${owner}`,
			);
		}
		owners.set(identity, owner);
	}
}

function handoffResult(
	node: Bead,
	metadata: Bead,
	repository: string,
	number: number,
	headSha: string,
	dispatchKey: string,
	status: EventStatus,
	priority?: number,
): HandoffResult {
	if (!isNonEmptyString(node.id)) throw new ResolutionError("approved node is missing its id");
	for (const field of ["branch", "base_sha"] as const) {
		if (!isNonEmptyString(metadata[field])) throw new ResolutionError(`approved node is missing metadata.${field}`);
	}
	let state: DeliveryState | null = deliveryState(metadata, "queue_dispatch", dispatchKey);
	let requiredMetadata: Record<string, string> = {};
	if (status === "resolved") {
		// Admitting the event writes the anchor and its first receipt together, so a crash
		// between them cannot leave an anchor nobody will replay.
		state = null;
		requiredMetadata = { queue_dispatch: dispatchKey, queue_dispatch_pending: dispatchKey };
	} else if (status === "replay" && state === "untracked") {
		requiredMetadata = { queue_dispatch_pending: dispatchKey };
	}
	const result: HandoffResult = {
		status,
		deliveryState: state,
		requiredMetadata,
		node: node.id,
		dispatchKey,
		repository,
		number,
		headSha,
		branch: metadata.branch as string,
		baseSha: metadata.base_sha as string,
	};
	if (priority !== undefined) result.priority = priority;
	return result;
}

function lifecycleResult(node: Bead, metadata: Bead, lifecycle: LifecycleEvent, status: EventStatus): LifecycleResult {
	const identifier = node.id;
	if (!isNonEmptyString(identifier)) throw new ResolutionError("orchestrate node is missing its id");
	const { pullRequest, lifecycleKey, transition } = lifecycle;
	// An unapproved node has no shepherd waiting on it, so a routine push is recorded and
	// nothing is woken. A terminal transition is different: it ends the run either way.
	const wakeShepherd = labelSet(node).has("state:approved") || TERMINAL_TRANSITIONS[transition] === true;
	if (wakeShepherd) {
		for (const field of ["branch", "base_sha"] as const) {
			if (!isNonEmptyString(metadata[field])) {
				throw new ResolutionError(`orchestrate node is missing metadata.${field}`);
			}
		}
	}

	let state: DeliveryState | null = deliveryState(metadata, "queue_lifecycle", lifecycleKey);
	let requiredMetadata: Record<string, string> = {};
	if (status === "resolved") {
		state = null;
		requiredMetadata = {
			queue_lifecycle: lifecycleKey,
			queue_lifecycle_head: pullRequest.headSha as string,
			queue_lifecycle_transition: transition,
		};
		// Nothing will be delivered for a no-wake transition, so it is acknowledged on the
		// spot rather than left pending for a replay scan to pick up forever.
		requiredMetadata[wakeShepherd ? "queue_lifecycle_pending" : "queue_lifecycle_ack"] = lifecycleKey;
	} else if (status === "replay" && state === "untracked") {
		requiredMetadata = { [wakeShepherd ? "queue_lifecycle_pending" : "queue_lifecycle_ack"]: lifecycleKey };
	}

	const anchoredHead = metadata.head_sha;
	const result: LifecycleResult = {
		status,
		eventType: "pr-lifecycle",
		deliveryState: state,
		requiredMetadata,
		node: identifier,
		lifecycleKey,
		transition,
		source: lifecycle.source,
		wakeShepherd,
		repository: pullRequest.repository as string,
		number: pullRequest.number as number,
		headSha: pullRequest.headSha as string,
		headChanged: typeof anchoredHead === "string" && anchoredHead !== pullRequest.headSha,
	};
	if (wakeShepherd) {
		result.branch = metadata.branch as string;
		result.baseSha = metadata.base_sha as string;
	}
	return result;
}

/** The node list out of a snapshot, whether it arrived bare or inside a `bd` JSON envelope. */
function nodeList(nodesValue: unknown): unknown[] {
	const nodes =
		isObject(nodesValue) && "data" in nodesValue && "schema_version" in nodesValue ? nodesValue.data : nodesValue;
	if (!Array.isArray(nodes)) throw new ContractError("nodes snapshot must be a JSON array");
	return nodes;
}

function resolveLifecycle(lifecycle: LifecycleEvent, nodesValue: unknown): LifecycleResult {
	const nodes = nodeList(nodesValue);
	const pullRequest = lifecycle.pullRequest;
	const candidates: { node: Bead; metadata: Bead }[] = [];
	for (const entry of nodes) {
		const live = liveNode(entry);
		// Lifecycle records match the PR's owner, not its head: the point of the record is
		// often that the head moved.
		if (!live || !labelSet(live.node).has("orc-node")) continue;
		const number = nodePr(live.metadata);
		if (number === null) continue;
		if (live.metadata.repo === pullRequest.repository && number === pullRequest.number) candidates.push(live);
	}
	const reference = `${String(pullRequest.repository)}#${String(pullRequest.number)}`;
	if (candidates.length === 0) throw new UnmatchedError(`no orchestrate node for ${reference}`);
	if (candidates.length !== 1) {
		throw new ResolutionError(`expected one orchestrate node for ${reference}, found ${candidates.length}`);
	}
	const { node, metadata } = candidates[0];
	const lifecycleKey = lifecycle.lifecycleKey;
	validateReceiptLineage(metadata, "queue_lifecycle", lifecycleKey);
	const status: EventStatus =
		metadata.queue_lifecycle_ack === lifecycleKey
			? "duplicate"
			: metadata.queue_lifecycle === lifecycleKey
				? "replay"
				: "resolved";
	return lifecycleResult(node, metadata, lifecycle, status);
}

/**
 * Resolve one watcher record against a snapshot.
 *
 * Throws `ContractError` (exit 1), `UnmatchedError` (exit 2), or `ResolutionError` (exit 3);
 * {@link resolveQueueDispatch} is the non-throwing surface over this.
 */
export function resolve(record: unknown, nodesValue: unknown): ResolveResult {
	if (isObject(record) && (record.type === "webhook-error" || record.type === "reconcile-error")) {
		const message = record.message;
		if (!isNonEmptyString(message)) throw new ContractError("watcher error message must be a non-empty string");
		const repository = record.repository;
		if (
			repository !== undefined &&
			repository !== null &&
			(typeof repository !== "string" || !REPOSITORY_RE.test(repository))
		) {
			throw new ContractError("watcher error repository must be OWNER/REPO");
		}
		return {
			status: "fallback",
			recordType: record.type,
			action: "gate-check-and-pass",
			message,
			repository: (repository as string | null | undefined) ?? null,
		};
	}
	const lifecycle = validateLifecycleRecord(record);
	if (lifecycle !== null) return resolveLifecycle(lifecycle, nodesValue);
	const pullRequest = validateRecord(record);
	if (pullRequest === null) {
		// Both validators reject a non-object, so this is an object whose `type` is neither
		// `dispatch` nor `pr-lifecycle`: a control record. The snapshot is never read.
		//
		// PARITY: an unhashable `type` (an array or object) raises `TypeError` in the script's
		// set membership test and exits 1; here it is ignored, which is what the script
		// already does for every other unrecognised `type`, including `5` and `"dispatchh"`.
		return { status: "ignored", recordType: isObject(record) ? (record.type ?? null) : null };
	}

	const nodes = nodeList(nodesValue);
	const repository = pullRequest.repository as string;
	const number = pullRequest.number as number;
	const headSha = pullRequest.headSha as string;
	const candidates: { node: Bead; metadata: Bead }[] = [];
	for (const entry of nodes) {
		const live = liveNode(entry);
		// A dispatch is only ever handed to a node a reviewer approved, at the exact head
		// that was approved. `orc-node` is not enough.
		if (!live || !labelSet(live.node).has("state:approved")) continue;
		const nodeNumber = nodePr(live.metadata);
		if (nodeNumber === null) continue;
		const { repo, head_sha } = live.metadata;
		if (repo === repository && nodeNumber === number && head_sha === headSha) candidates.push(live);
	}

	const key = `${repository}#${number}@${headSha}`;
	if (candidates.length === 0) throw new UnmatchedError(`no approved node for ${key}`);
	if (candidates.length !== 1) {
		throw new ResolutionError(`expected one approved node for ${key}, found ${candidates.length}`);
	}
	const { node, metadata } = candidates[0];
	validateReceiptLineage(metadata, "queue_dispatch", key);
	const status: EventStatus =
		metadata.queue_dispatch_ack === key ? "duplicate" : metadata.queue_dispatch === key ? "replay" : "resolved";
	return handoffResult(node, metadata, repository, number, headSha, key, status, pullRequest.priority as number);
}

/** Stable, code-point ordering by node id, matching the script's `sorted(key=...)`. */
const byNodeId = (a: { node: string }, b: { node: string }): number =>
	a.node < b.node ? -1 : a.node > b.node ? 1 : 0;

/**
 * Reconstruct approved handoffs whose current dispatch lacks an ack.
 *
 * This is the crash-recovery path: the receipts on a node are enough to rebuild the handoff
 * without the original watcher record, so a dispatch is never lost to a restart.
 */
export function replayUnacknowledged(nodesValue: unknown): HandoffResult[] {
	const nodes = nodeList(nodesValue);
	ensureUniqueNodeOwnership(nodes);
	const handoffs: HandoffResult[] = [];
	for (const entry of nodes) {
		const live = liveNode(entry);
		if (!live || !labelSet(live.node).has("state:approved")) continue;
		const { node, metadata } = live;
		const dispatchKey = metadata.queue_dispatch;
		if (!isNonEmptyString(dispatchKey)) continue;
		validateReceiptLineage(metadata, "queue_dispatch", dispatchKey);
		if (metadata.queue_dispatch_ack === dispatchKey) continue;
		const { repo, head_sha } = metadata;
		const number = nodePr(metadata);
		if (number === null || number < 1) throw new ResolutionError("queued node has invalid metadata.pr");
		if (typeof repo !== "string" || !REPOSITORY_RE.test(repo)) {
			throw new ResolutionError("queued node has invalid metadata.repo");
		}
		if (typeof head_sha !== "string" || !HEAD_SHA_RE.test(head_sha)) {
			throw new ResolutionError("queued node has invalid metadata.head_sha");
		}
		// The key is the node's identity restated; if they disagree the receipts belong to
		// some other PR and replaying them would dispatch the wrong branch.
		if (dispatchKey !== `${repo}#${number}@${head_sha}`) {
			throw new ResolutionError("queued node dispatch key does not match its identity");
		}
		handoffs.push(handoffResult(node, metadata, repo, number, head_sha, dispatchKey, "replay"));
	}
	return handoffs.sort(byNodeId);
}

/** Reconstruct lifecycle wake-ups whose current key lacks an ack. */
export function replayUnacknowledgedLifecycles(nodesValue: unknown): LifecycleResult[] {
	const nodes = nodeList(nodesValue);
	ensureUniqueNodeOwnership(nodes);
	const handoffs: LifecycleResult[] = [];
	for (const entry of nodes) {
		const live = liveNode(entry);
		if (!live || !labelSet(live.node).has("orc-node")) continue;
		const { node, metadata } = live;
		const lifecycleKey = metadata.queue_lifecycle;
		if (!isNonEmptyString(lifecycleKey)) continue;
		validateReceiptLineage(metadata, "queue_lifecycle", lifecycleKey);
		if (metadata.queue_lifecycle_ack === lifecycleKey) continue;
		const transition = metadata.queue_lifecycle_transition;
		const headSha = metadata.queue_lifecycle_head;
		const repository = metadata.repo;
		const number = nodePr(metadata);
		// PARITY: the two replay scans validate in different orders, so a node that is wrong
		// in more than one way reports a different field depending on the scan. Kept as is —
		// the pr / transition / repo / number / head order below is the script's.
		if (number === null) throw new ResolutionError("queued node has invalid metadata.pr");
		if (typeof transition !== "string" || LIFECYCLE_TRANSITIONS[transition] !== true) {
			throw new ResolutionError("queued node has invalid lifecycle transition");
		}
		if (typeof repository !== "string" || !REPOSITORY_RE.test(repository)) {
			throw new ResolutionError("queued node has invalid metadata.repo");
		}
		if (number < 1) throw new ResolutionError("queued node has invalid metadata.pr");
		if (typeof headSha !== "string" || !HEAD_SHA_RE.test(headSha)) {
			throw new ResolutionError("queued node has invalid lifecycle head");
		}
		const lifecycle: LifecycleEvent = {
			transition,
			// Not a real watcher source: a replayed record has no delivery behind it, and
			// labelling it `webhook` would claim evidence that no longer exists.
			source: "replay",
			lifecycleKey,
			pullRequest: { repository, number, headSha },
		};
		handoffs.push(lifecycleResult(node, metadata, lifecycle, "replay"));
	}
	return handoffs.sort(byNodeId);
}

/** The script's exit vocabulary, verbatim from its docstring. */
export function dispatchMeaning(code: number): string {
	switch (code) {
		case 0:
			return "resolved/replay/duplicate/control record";
		case 1:
			return "invalid input";
		case 2:
			return "no orchestrate owner: safe to route once to pr-shepherd resolve-queue-event";
		case 3:
			return "ambiguous or invalid orchestrate ownership: do not reroute";
		default:
			return "unrecognised exit code: treat as unresolved and do not reroute";
	}
}

export interface ResolveQueueDispatchOptions {
	/** Scan the snapshot for unacknowledged receipts instead of resolving a record. */
	replayUnacknowledged?: boolean;
}

/** One metadata write the caller must persist before it delivers anything. */
export interface QueueAction {
	node: string;
	metadata: Record<string, string>;
}

/** The whole decision: the script's exit code, its stdout payload, and its stderr line. */
export interface QueueDispatchOutcome {
	code: 0 | 1 | 2 | 3;
	meaning: string;
	/** What the script prints on stdout, or `null` on any non-zero code. */
	result: ResolveResult | ReplayResult | null;
	/** Receipts to persist, flattened out of `requiredMetadata`. Empty when nothing is owed. */
	actions: QueueAction[];
	/** The script's stderr line, prefix included, or `null` on success. */
	error: string | null;
}

/** The receipt writes a result implies, in the order they were resolved. */
function actionsFor(result: ResolveResult | ReplayResult): QueueAction[] {
	const owed: (HandoffResult | LifecycleResult)[] =
		"dispatches" in result ? [...result.dispatches, ...result.lifecycles] : "requiredMetadata" in result ? [result] : [];
	const actions: QueueAction[] = [];
	for (const item of owed) {
		if (Object.keys(item.requiredMetadata).length > 0) {
			actions.push({ node: item.node, metadata: item.requiredMetadata });
		}
	}
	return actions;
}

function failed(code: 1 | 2 | 3, error: string): QueueDispatchOutcome {
	return { code, meaning: dispatchMeaning(code), result: null, actions: [], error };
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Resolve a record, or scan for unacknowledged receipts, without throwing.
 *
 * `nodes` is typed `unknown` rather than `unknown[]` so a `bd` JSON envelope can be handed
 * over as read; an array is of course still accepted.
 */
export function resolveQueueDispatch(
	record: unknown,
	nodes: unknown,
	opts: ResolveQueueDispatchOptions = {},
): QueueDispatchOutcome {
	try {
		const result: ResolveResult | ReplayResult =
			opts.replayUnacknowledged === true
				? {
						status: "replay",
						dispatches: replayUnacknowledged(nodes),
						lifecycles: replayUnacknowledgedLifecycles(nodes),
					}
				: resolve(record, nodes);
		return { code: 0, meaning: dispatchMeaning(0), result, actions: actionsFor(result), error: null };
	} catch (error) {
		if (error instanceof ContractError) return failed(1, `invalid watcher record: ${message(error)}`);
		// UnmatchedError extends ResolutionError, so it must be tested first — exit 2 says
		// "reroute once", exit 3 says "do not reroute", and they are not interchangeable.
		if (error instanceof UnmatchedError) return failed(2, `unmatched watcher record: ${message(error)}`);
		if (error instanceof ResolutionError) return failed(3, `unresolved watcher record: ${message(error)}`);
		// PARITY: the script exits 1 with a traceback for any other failure. Same code, but
		// the message says which layer broke instead of naming the record as the culprit.
		return failed(1, `resolve-queue-dispatch failed: ${message(error)}`);
	}
}

/**
 * `json.dump(..., separators=(",",":"), sort_keys=True)`.
 *
 * Byte-identical to the script's stdout, including its ASCII-only escaping, so a reader
 * diffing this tool's output against the old script's sees nothing.
 */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(sortKeys(value)).replace(
		/[\u0080-\uffff]/g,
		(char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (!isObject(value)) return value;
	const sorted: Bead = {};
	for (const key of Object.keys(value).sort()) {
		if (value[key] !== undefined) sorted[key] = sortKeys(value[key]);
	}
	return sorted;
}

/** Reads a `bd list --json` snapshot. Injected so tests never touch the filesystem. */
export type SnapshotReader = (file: string) => Promise<string>;

const readSnapshotFile: SnapshotReader = (file) => Bun.file(file).text();

/** What the tool reports alongside its text. */
export interface QueueDispatchDetails {
	code: 0 | 1 | 2 | 3;
	meaning: string;
	/** The payload's own status word (`resolved`, `replay`, `duplicate`, `fallback`, ...). */
	status?: string;
	actions?: QueueAction[];
	error?: string;
}

const DESCRIPTION = [
	"Resolve one release-queue-watch JSON record to an orchestrate node, read-only.",
	"Matches a dispatch to the approved node at that exact head, matches a pr-lifecycle record",
	"to the PR's owner, and reconciles crash-replay receipts. Codes: 0 resolved/replay/duplicate/",
	"control, 1 invalid input, 2 no orchestrate owner (safe to route once to pr-shepherd",
	"resolve-queue-event), 3 ambiguous or invalid ownership (do not reroute).",
	"Never mutates a bead: apply `actions` yourself once delivery is arranged.",
].join(" ");

/** The script's own output shape: the decoded exit line, then its stdout, then its stderr. */
function report(outcome: QueueDispatchOutcome): AgentToolResult<QueueDispatchDetails> {
	const text = [
		`exit ${outcome.code}: ${outcome.meaning}`,
		outcome.result === null ? "" : canonicalJson(outcome.result),
		outcome.error ?? "",
	]
		.filter(Boolean)
		.join("\n");
	const details: QueueDispatchDetails = { code: outcome.code, meaning: outcome.meaning };
	if (outcome.result !== null) details.status = outcome.result.status;
	if (outcome.actions.length > 0) details.actions = outcome.actions;
	if (outcome.error !== null) details.error = outcome.error;
	return { content: [{ type: "text", text }], details, isError: outcome.code !== 0 };
}

/** Register `orc_resolve_queue_dispatch`. The orchestrator wires this from `src/index.ts`. */
export function registerResolveQueueDispatch(pi: ExtensionAPI, read: SnapshotReader = readSnapshotFile): void {
	const z = pi.zod;

	// A named const, not an inline `z.object(...)`: inlined, the generic stops inferring and
	// `params` degrades to `unknown`.
	const dispatchParams = z.object({
		record: z.string().optional().describe("the watcher record JSON; omit only with replayUnacknowledged"),
		nodesFile: z.string().optional().describe("path to a `bd list --json` snapshot; a bd envelope is unwrapped"),
		nodes: z.string().optional().describe("the snapshot inline as a JSON array; takes precedence over nodesFile"),
		replayUnacknowledged: z
			.boolean()
			.optional()
			.describe("emit approved dispatches and lifecycles lacking a matching ack; reads no record"),
		cwd: z.string().optional().describe("directory a relative nodesFile is resolved against"),
	});

	pi.registerTool({
		name: "orc_resolve_queue_dispatch",
		label: "Resolve queue dispatch",
		description: DESCRIPTION,
		parameters: dispatchParams,
		approval: "read",
		async execute(_id, params): Promise<AgentToolResult<QueueDispatchDetails>> {
			const replay = params.replayUnacknowledged === true;

			let nodes: unknown;
			if (params.nodes !== undefined) {
				try {
					nodes = JSON.parse(params.nodes);
				} catch (error) {
					return report(failed(1, `invalid watcher record: nodes is not JSON: ${message(error)}`));
				}
			} else if (params.nodesFile !== undefined) {
				const file = params.cwd === undefined ? params.nodesFile : path.resolve(params.cwd, params.nodesFile);
				try {
					nodes = JSON.parse(await read(file));
				} catch (error) {
					return report(failed(1, `invalid watcher record: cannot read JSON from ${file}: ${message(error)}`));
				}
			} else {
				// PARITY: the script's `--nodes-file` is required, so argparse exits 2 when it is
				// missing — the same code that means "no orchestrate owner, safe to reroute".
				// A missing argument is invalid input, so this reports 1 and says so.
				return report(failed(1, "invalid watcher record: pass `nodes` or `nodesFile`; neither was given"));
			}

			let record: unknown;
			if (!replay) {
				if (params.record === undefined || params.record === "") {
					return report(
						failed(
							1,
							"invalid watcher JSON: no record was given; pass `record`, or set " +
								"`replayUnacknowledged` to scan the snapshot instead",
						),
					);
				}
				try {
					record = JSON.parse(params.record);
				} catch (error) {
					return report(failed(1, `invalid watcher JSON: ${message(error)}`));
				}
			}

			return report(resolveQueueDispatch(record, nodes, { replayUnacknowledged: replay }));
		},
	});
}
