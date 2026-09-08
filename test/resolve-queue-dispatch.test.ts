/**
 * Conformance tests for `src/tools/resolve-queue-dispatch.ts`.
 *
 * Every case in `skills/orchestrate/scripts/_test_resolve_queue_dispatch.py` is reproduced
 * here, fixtures included, in the script's own order — that suite is the contract this port
 * is judged against. The four `test_cli_*` cases become tests of the exit-code surface and
 * the registered tool, since there is no longer a subprocess to run.
 *
 * Tests below the ported block cover branches the Python suite leaves unexercised, and pin
 * the handful of documented divergences so a later reader sees them fail loudly if changed.
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { zod } from "@oh-my-pi/pi-coding-agent";
import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
 canonicalJson,
 ContractError,
 type HandoffResult,
 type LifecycleResult,
 type QueueDispatchDetails,
 registerResolveQueueDispatch,
 replayUnacknowledged,
 replayUnacknowledgedLifecycles,
 resolve,
 type ResolveResult,
 resolveQueueDispatch,
 ResolutionError,
 type SnapshotReader,
 UnmatchedError,
} from "../src/tools/resolve-queue-dispatch";

const A40 = "a".repeat(40);
const B40 = "b".repeat(40);
const C40 = "c".repeat(40);
const DISPATCH_KEY = `owner/repo#42@${A40}`;

interface NodeFixture {
 id: string;
 status: string;
 labels: string[];
 metadata: Record<string, unknown>;
}

/** `dispatch(**overrides)` from the Python suite. */
function dispatch(overrides: Record<string, unknown> = {}): Record<string, unknown> {
 return {
  type: "dispatch",
  pullRequest: {
   repository: "owner/repo",
   number: 42,
   title: "Ready change",
   headSha: A40,
   baseRef: "main",
   labels: ["priority:high"],
   priority: 1,
   draft: false,
   mergeable: true,
   checks: "pass",
   createdAt: "2026-07-21T00:00:00Z",
   updatedAt: "2026-07-21T01:00:00Z",
   state: "active",
   activeSince: "2026-07-21T01:00:01Z",
   ...overrides,
  },
 };
}

/** `lifecycle(transition, **overrides)` from the Python suite. */
function lifecycle(transition = "updated", overrides: Record<string, unknown> = {}): Record<string, unknown> {
 return {
  type: "pr-lifecycle",
  transition,
  source: "webhook",
  lifecycleKey: `owner/repo#42#${transition}#opaque`,
  pullRequest: dispatch(overrides).pullRequest,
  deliveryId: "delivery-1",
  webhookAction: "synchronize",
 };
}

/** `node(identifier, **metadata)` from the Python suite. */
function node(identifier = "orc-run.1", metadata: Record<string, unknown> = {}): NodeFixture {
 return {
  id: identifier,
  status: "in_progress",
  labels: ["orc-node", "state:approved"],
  metadata: { repo: "owner/repo", pr: 42, head_sha: A40, branch: "coder/t1", base_sha: B40, ...metadata },
 };
}

/** `assertRaisesRegex`: the class fixes the exit code, the pattern fixes the message. */
function raises(fn: () => unknown, type: new (message?: string) => Error, pattern: string | RegExp): void {
 let thrown: unknown;
 try {
  fn();
 } catch (error) {
  thrown = error;
 }
 expect(thrown).toBeInstanceOf(type);
 expect((thrown as Error).message).toMatch(pattern);
}

/** Narrow to a dispatch handoff, failing loudly when another branch answered. */
function handoff(result: ResolveResult): HandoffResult {
 if (!("dispatchKey" in result)) throw new Error(`expected a dispatch handoff, got ${canonicalJson(result)}`);
 return result;
}

/** Narrow to a lifecycle result, failing loudly when another branch answered. */
function lifecycleOf(result: ResolveResult): LifecycleResult {
 if (!("lifecycleKey" in result)) throw new Error(`expected a lifecycle result, got ${canonicalJson(result)}`);
 return result;
}

describe("dispatch resolution", () => {
 test("resolves exact approved node", () => {
  const result = handoff(resolve(dispatch(), [node()]));
  expect(result.status).toBe("resolved");
  expect(result.node).toBe("orc-run.1");
  expect(result.dispatchKey).toBe(DISPATCH_KEY);
  expect(result.requiredMetadata).toEqual({
   queue_dispatch: DISPATCH_KEY,
   queue_dispatch_pending: DISPATCH_KEY,
  });
 });

 test("marks acknowledged dispatch as duplicate", () => {
  const result = resolve(dispatch(), [
   node("orc-run.1", { queue_dispatch: DISPATCH_KEY, queue_dispatch_ack: DISPATCH_KEY }),
  ]);
  expect(result.status).toBe("duplicate");
 });

 test("replays unacknowledged dispatch after crash", () => {
  const key = DISPATCH_KEY;
  const initial = resolve(dispatch(), [node()]);
  const pendingAfterPreSendCrash = handoff(
   resolve(dispatch(), [node("orc-run.1", { queue_dispatch: key, queue_dispatch_pending: key })]),
  );
  const sentBeforeAckCrash = handoff(
   resolve(dispatch(), [
    node("orc-run.1", { queue_dispatch: key, queue_dispatch_pending: key, queue_dispatch_sent: key }),
   ]),
  );
  const acknowledged = resolve(dispatch(), [
   node("orc-run.1", {
    queue_dispatch: key,
    queue_dispatch_pending: key,
    queue_dispatch_sent: key,
    queue_dispatch_ack: key,
   }),
  ]);

  expect(initial.status).toBe("resolved");
  expect(pendingAfterPreSendCrash.status).toBe("replay");
  expect(pendingAfterPreSendCrash.deliveryState).toBe("pending");
  expect(pendingAfterPreSendCrash.requiredMetadata).toEqual({});
  expect(sentBeforeAckCrash.status).toBe("replay");
  expect(sentBeforeAckCrash.deliveryState).toBe("sent");
  expect(acknowledged.status).toBe("duplicate");
 });

 test("untracked migration is normalized before shepherd handoff", () => {
  const key = DISPATCH_KEY;
  const migrationNode = node("orc-run.1", { queue_dispatch: key });

  const reconstructed = replayUnacknowledged([migrationNode])[0];
  Object.assign(migrationNode.metadata, reconstructed.requiredMetadata);
  const normalized = handoff(resolve(dispatch(), [migrationNode]));

  expect(reconstructed.deliveryState).toBe("untracked");
  expect(reconstructed.requiredMetadata).toEqual({ queue_dispatch_pending: key });
  expect(normalized.status).toBe("replay");
  expect(normalized.deliveryState).toBe("pending");
  expect(normalized.requiredMetadata).toEqual({});
  expect(migrationNode.metadata.queue_dispatch_pending).toBe(normalized.dispatchKey);
 });

 test("resume scan reconstructs only unacknowledged handoffs", () => {
  const key = DISPATCH_KEY;
  const sentKey = `owner/repo#43@${A40}`;
  const ackKey = `owner/repo#44@${A40}`;
  const pending = node("orc-run.2", { queue_dispatch: key, queue_dispatch_pending: key });
  const sent = node("orc-run.1", {
   pr: 43,
   queue_dispatch: sentKey,
   queue_dispatch_pending: sentKey,
   queue_dispatch_sent: sentKey,
  });
  const acknowledged = node("orc-run.3", {
   pr: 44,
   queue_dispatch: ackKey,
   queue_dispatch_pending: ackKey,
   queue_dispatch_sent: ackKey,
   queue_dispatch_ack: ackKey,
  });

  const result = replayUnacknowledged([pending, acknowledged, sent, node("orc-run.1", { pr: 45 })]);

  expect(result.map((item) => item.node)).toEqual(["orc-run.1", "orc-run.2"]);
  expect(result.map((item) => item.deliveryState)).toEqual(["sent", "pending"]);
 });

 test("a stale dispatch cannot bypass its orchestrate owner", () => {
  const outcome = resolveQueueDispatch(dispatch({ headSha: C40 }), [node()]);
  expect(outcome.code).toBe(3);
  expect(outcome.result).toBeNull();
  expect(outcome.actions).toEqual([]);
 });

 test("rejects non-ready dispatch", () => {
  raises(() => resolve(dispatch({ checks: "fail" }), [node()]), ContractError, "checks must be pass");
 });

 test("rejects ambiguous approved nodes", () => {
  raises(() => resolve(dispatch(), [node(), node("orc-run.2")]), ResolutionError, "found 2");
 });

 test("a malformed owner identity cannot authorize fallback", () => {
  const outcome = resolveQueueDispatch(dispatch({ number: 1 }), [node("orc-run.1", { pr: true })]);
  expect(outcome.code).toBe(3);
  expect(outcome.result).toBeNull();
  expect(outcome.actions).toEqual([]);
 });

 test("rejects node without git anchors", () => {
  raises(() => resolve(dispatch(), [node("orc-run.1", { branch: null })]), ResolutionError, "metadata.branch");
 });

 test("rejects mismatched dispatch receipt", () => {
  raises(
   () =>
    resolve(dispatch(), [
     node("orc-run.1", { queue_dispatch: DISPATCH_KEY, queue_dispatch_pending: `owner/repo#42@${C40}` }),
    ]),
   ResolutionError,
   "receipt mismatch",
  );
 });

 test("rejects new dispatch while previous receipt is unacknowledged", () => {
  const oldKey = `owner/repo#42@${C40}`;
  raises(
   () => resolve(dispatch(), [node("orc-run.1", { queue_dispatch: oldKey, queue_dispatch_pending: oldKey })]),
   ResolutionError,
   "cannot replace",
  );
 });

 test("new dispatch replays after completed prior lineage", () => {
  const oldKey = `owner/repo#42@${A40}`;
  const newKey = `owner/repo#42@${C40}`;
  const tracked = node("orc-run.1", {
   head_sha: C40,
   queue_dispatch: oldKey,
   queue_dispatch_pending: oldKey,
   queue_dispatch_sent: oldKey,
   queue_dispatch_ack: oldKey,
  });

  const admitted = handoff(resolve(dispatch({ headSha: C40 }), [tracked]));
  Object.assign(tracked.metadata, admitted.requiredMetadata);
  const pending = handoff(resolve(dispatch({ headSha: C40 }), [tracked]));
  const replayed = replayUnacknowledged([tracked]);
  tracked.metadata.queue_dispatch_sent = newKey;
  const sent = handoff(resolve(dispatch({ headSha: C40 }), [tracked]));

  expect(admitted.status).toBe("resolved");
  expect(pending.deliveryState).toBe("pending");
  expect(replayed[0].dispatchKey).toBe(newKey);
  expect(replayed[0].deliveryState).toBe("pending");
  expect(sent.deliveryState).toBe("sent");
 });
});

describe("lifecycle resolution", () => {
 test("resolves lifecycle for exact orchestrate node", () => {
  const result = lifecycleOf(resolve(lifecycle("failed", { checks: "fail" }), [node()]));

  expect(result.status).toBe("resolved");
  expect(result.eventType).toBe("pr-lifecycle");
  expect(result.node).toBe("orc-run.1");
  expect(result.transition).toBe("failed");
  expect(result.wakeShepherd).toBe(true);
  expect(result.requiredMetadata).toEqual({
   queue_lifecycle: "owner/repo#42#failed#opaque",
   queue_lifecycle_head: A40,
   queue_lifecycle_pending: "owner/repo#42#failed#opaque",
   queue_lifecycle_transition: "failed",
  });
 });

 test("records nonterminal lifecycle without waking unapproved node", () => {
  const unapproved = node();
  unapproved.labels = ["orc-node", "state:reported"];

  const result = lifecycleOf(resolve(lifecycle("updated"), [unapproved]));

  expect(result.status).toBe("resolved");
  expect(result.wakeShepherd).toBe(false);
  expect(result.requiredMetadata.queue_lifecycle_ack).toBe("owner/repo#42#updated#opaque");
 });

 test("marks acknowledged lifecycle as duplicate", () => {
  const key = "owner/repo#42#updated#opaque";
  const result = lifecycleOf(
   resolve(lifecycle(), [node("orc-run.1", { queue_lifecycle: key, queue_lifecycle_ack: key })]),
  );

  expect(result.status).toBe("duplicate");
  expect(result.eventType).toBe("pr-lifecycle");
  expect(result.deliveryState).toBe("ack");
 });

 test("lifecycle receipts survive each crash boundary", () => {
  const event = lifecycle("failed", { checks: "fail" });
  const tracked = node();

  const initial = lifecycleOf(resolve(event, [tracked]));
  Object.assign(tracked.metadata, initial.requiredMetadata);
  const pending = lifecycleOf(resolve(event, [tracked]));
  tracked.metadata.queue_lifecycle_sent = initial.lifecycleKey;
  const sent = lifecycleOf(resolve(event, [tracked]));
  tracked.metadata.queue_lifecycle_ack = initial.lifecycleKey;
  const acknowledged = resolve(event, [tracked]);

  expect(initial.status).toBe("resolved");
  expect(pending.deliveryState).toBe("pending");
  expect(sent.deliveryState).toBe("sent");
  expect(acknowledged.status).toBe("duplicate");
 });

 test("replays unacknowledged lifecycle after crash", () => {
  const key = "owner/repo#42#failed#opaque";
  const pending = node("orc-run.1", {
   queue_lifecycle: key,
   queue_lifecycle_head: A40,
   queue_lifecycle_pending: key,
   queue_lifecycle_transition: "failed",
  });

  const result = replayUnacknowledgedLifecycles([pending]);

  expect(result).toHaveLength(1);
  expect(result[0].status).toBe("replay");
  expect(result[0].deliveryState).toBe("pending");
  expect(result[0].wakeShepherd).toBe(true);
 });

 test("normalizes unapproved nonterminal lifecycle to ack", () => {
  const key = "owner/repo#42#updated#opaque";
  const unapproved = node("orc-run.1", {
   queue_lifecycle: key,
   queue_lifecycle_head: A40,
   queue_lifecycle_transition: "updated",
  });
  unapproved.labels = ["orc-node", "state:reported"];

  const result = replayUnacknowledgedLifecycles([unapproved])[0];

  expect(result.wakeShepherd).toBe(false);
  expect(result.requiredMetadata).toEqual({ queue_lifecycle_ack: key });
 });

 test("lifecycle head change is observed not trusted", () => {
  const result = resolve(lifecycle("updated", { headSha: C40 }), [node()]);

  expect(lifecycleOf(result).headChanged).toBe(true);
  expect(lifecycleOf(result).headSha).toBe(C40);
  expect("dispatchKey" in result).toBe(false);
 });

 test("rejects mismatched lifecycle receipt", () => {
  const key = "owner/repo#42#failed#opaque";
  raises(
   () =>
    resolve(lifecycle("failed", { checks: "fail" }), [
     node("orc-run.1", { queue_lifecycle: key, queue_lifecycle_pending: "owner/repo#42#other#opaque" }),
    ]),
   ResolutionError,
   "receipt mismatch",
  );
 });

 test("rejects new lifecycle while previous receipt is unacknowledged", () => {
  const oldKey = "owner/repo#42#updated#old";
  raises(
   () =>
    resolve(lifecycle("failed", { checks: "fail" }), [
     node("orc-run.1", {
      queue_lifecycle: oldKey,
      queue_lifecycle_head: A40,
      queue_lifecycle_pending: oldKey,
      queue_lifecycle_transition: "updated",
     }),
    ]),
   ResolutionError,
   "cannot replace",
  );
 });

 test("new lifecycle replays after completed prior lineage", () => {
  const oldKey = "owner/repo#42#updated#old";
  const newKey = "owner/repo#42#failed#opaque";
  const tracked = node("orc-run.1", {
   queue_lifecycle: oldKey,
   queue_lifecycle_head: A40,
   queue_lifecycle_pending: oldKey,
   queue_lifecycle_sent: oldKey,
   queue_lifecycle_ack: oldKey,
   queue_lifecycle_transition: "updated",
  });
  const event = lifecycle("failed", { checks: "fail" });

  const admitted = lifecycleOf(resolve(event, [tracked]));
  Object.assign(tracked.metadata, admitted.requiredMetadata);
  const pending = lifecycleOf(resolve(event, [tracked]));
  const replayed = replayUnacknowledgedLifecycles([tracked]);
  tracked.metadata.queue_lifecycle_sent = newKey;
  const sent = lifecycleOf(resolve(event, [tracked]));

  expect(admitted.status).toBe("resolved");
  expect(pending.deliveryState).toBe("pending");
  expect(replayed[0].lifecycleKey).toBe(newKey);
  expect(replayed[0].deliveryState).toBe("pending");
  expect(sent.deliveryState).toBe("sent");
 });

 test("accepts reconciled external merge for proof only", () => {
  const event = lifecycle("merged", { state: "closed" });
  event.source = "reconciliation";

  const result = resolve(event, [node()]);

  expect(lifecycleOf(result).transition).toBe("merged");
  expect(lifecycleOf(result).wakeShepherd).toBe(true);
  expect("dispatchKey" in result).toBe(false);
 });

 test("rejects malformed lifecycle", () => {
  raises(() => resolve(lifecycle("unknown"), [node()]), ContractError, "transition");
 });

 test("rejects impossible lifecycle combination", () => {
  raises(
   () => resolve(lifecycle("failed", { checks: "pass" }), [node()]),
   ContractError,
   "failed lifecycle checks must be fail",
  );
 });
});

describe("watcher records", () => {
 test("surfaces watcher error as explicit fallback", () => {
  const result = resolve({ type: "webhook-error", message: "bad signature" }, [node()]);

  expect(result.status).toBe("fallback");
  expect("action" in result && result.action).toBe("gate-check-and-pass");
 });

 test("ignores watcher control record", () => {
  const result = resolve({ type: "watcher-active" }, [node()]);
  expect(result).toEqual({ status: "ignored", recordType: "watcher-active" });
 });

 test("any unrecognised type is ignored, and reported as the script reports it", () => {
  // `record.get("type")` passes the value through untouched, and an absent or null type
  // prints as JSON null rather than vanishing from the payload.
  expect(resolve({ type: 5 }, [node()])).toEqual({ status: "ignored", recordType: 5 });
  expect(resolve({}, [node()])).toEqual({ status: "ignored", recordType: null });
  expect(resolve({ type: null }, [node()])).toEqual({ status: "ignored", recordType: null });
 });

 // PARITY: an array or object `type` is unhashable, so CPython raises `TypeError` testing it
 // against the error-type set and exits 1. This ignores it at exit 0 — what the script itself
 // does for every *hashable* unrecognised type, `5` and `null` above included.
 test("an unhashable record type is ignored, where the script crashes", () => {
  const outcome = resolveQueueDispatch({ type: ["dispatch"] }, [node()]);
  expect(outcome.code).toBe(0);
  expect(outcome.result).toEqual({ status: "ignored", recordType: ["dispatch"] });
 });
});

describe("replay scans", () => {
 test("dispatch replay rejects duplicate pr ownership", () => {
  raises(
   () =>
    replayUnacknowledged([
     node("orc-run.1", { queue_dispatch: DISPATCH_KEY, queue_dispatch_ack: DISPATCH_KEY }),
     node("orc-run.2", { queue_dispatch: DISPATCH_KEY }),
    ]),
   ResolutionError,
   "duplicate",
  );
 });

 test("lifecycle replay rejects duplicate pr ownership", () => {
  const key = "owner/repo#42#failed#opaque";
  const metadata = {
   queue_lifecycle: key,
   queue_lifecycle_head: A40,
   queue_lifecycle_pending: key,
   queue_lifecycle_transition: "failed",
  };
  raises(
   () => replayUnacknowledgedLifecycles([node("orc-run.1", metadata), node("orc-run.2", metadata)]),
   ResolutionError,
   "duplicate",
  );
 });
});

describe("exit codes", () => {
 // `test_cli_accepts_bd_envelope`.
 test("accepts a bd envelope", () => {
  const outcome = resolveQueueDispatch(dispatch(), { schema_version: 1, data: [node()] });
  expect(outcome.code).toBe(0);
  expect(outcome.result?.status).toBe("resolved");
 });

 // `test_cli_distinguishes_unmatched_from_ambiguous_ownership`. The two codes drive
 // different shepherd behaviour, so conflating them is the failure this guards.
 test("distinguishes unmatched from ambiguous ownership", () => {
  const unmatched = resolveQueueDispatch(dispatch(), []);
  const ambiguous = resolveQueueDispatch(dispatch(), [node(), node("orc-run.2")]);

  expect(unmatched.code).toBe(2);
  expect(unmatched.error).toContain("unmatched watcher record");
  expect(ambiguous.code).toBe(3);
  expect(ambiguous.error).toContain("unresolved watcher record");
 });

 test("ownership ambiguity is checked before dispatch eligibility", () => {
  const unapproved = node("orc-run.2");
  unapproved.labels = ["orc-node", "state:reported"];
  for (const competingOwner of [unapproved, node("orc-run.2", { head_sha: C40 })]) {
   const owners = [node("orc-run.1", { queue_dispatch: DISPATCH_KEY }), competingOwner];
   for (const outcome of [
    resolveQueueDispatch(dispatch(), owners),
    resolveQueueDispatch(lifecycle(), owners),
    resolveQueueDispatch(undefined, owners, { replayUnacknowledged: true }),
   ]) {
    expect(outcome.code).toBe(3);
    expect(outcome.result).toBeNull();
    expect(outcome.actions).toEqual([]);
   }
  }
 });

 // `test_cli_replays_without_watcher_input`.
 test("replays without watcher input", () => {
  const outcome = resolveQueueDispatch(undefined, [
   node("orc-run.1", { queue_dispatch: DISPATCH_KEY, queue_dispatch_pending: DISPATCH_KEY }),
  ], { replayUnacknowledged: true });

  expect(outcome.code).toBe(0);
  expect(outcome.result).toMatchObject({ status: "replay" });
  expect(outcome.result && "dispatches" in outcome.result && outcome.result.dispatches[0].status).toBe("replay");
 });

 // `test_cli_replays_dispatches_and_lifecycles`.
 test("replays dispatches and lifecycles", () => {
  const lifecycleKey = "owner/repo#43#failed#opaque";
  const lifecycleNode = node("orc-run.2", {
   pr: 43,
   queue_lifecycle: lifecycleKey,
   queue_lifecycle_head: C40,
   queue_lifecycle_pending: lifecycleKey,
   queue_lifecycle_transition: "failed",
  });
  const outcome = resolveQueueDispatch(
   undefined,
   [node("orc-run.1", { queue_dispatch: DISPATCH_KEY, queue_dispatch_pending: DISPATCH_KEY }), lifecycleNode],
   { replayUnacknowledged: true },
  );

  expect(outcome.code).toBe(0);
  const result = outcome.result;
  if (!result || !("dispatches" in result)) throw new Error("expected a replay result");
  expect(result.dispatches).toHaveLength(1);
  expect(result.lifecycles).toHaveLength(1);
 });

 test("maps each error class to the script's code and meaning", () => {
  const contract = resolveQueueDispatch(dispatch({ checks: "fail" }), [node()]);
  const unmatched = resolveQueueDispatch(dispatch(), []);
  const unresolved = resolveQueueDispatch(dispatch(), [node(), node("orc-run.2")]);
  const resolved = resolveQueueDispatch(dispatch(), [node()]);

  expect([contract.code, unmatched.code, unresolved.code, resolved.code]).toEqual([1, 2, 3, 0]);
  expect(contract.error).toBe("invalid watcher record: dispatch checks must be pass");
  expect(unmatched.meaning).toBe("no orchestrate owner: safe to route once to pr-shepherd resolve-queue-event");
  expect(unresolved.meaning).toBe("ambiguous or invalid orchestrate ownership: do not reroute");
  expect(resolved.error).toBeNull();
  expect(unmatched.result).toBeNull();
 });

 test("a record the resolver has no opinion about never reads the snapshot", () => {
  // The script returns `ignored` before it validates the nodes argument, so a control
  // record survives a snapshot that could not be used at all.
  const outcome = resolveQueueDispatch({ type: "watcher-active" }, "not a list");
  expect(outcome.code).toBe(0);
  expect(outcome.result).toEqual({ status: "ignored", recordType: "watcher-active" });
 });

 test("a dispatch against a non-array snapshot is invalid input", () => {
  const outcome = resolveQueueDispatch(dispatch(), { schema_version: 1, data: "nope" });
  expect(outcome.code).toBe(1);
  expect(outcome.error).toBe("invalid watcher record: nodes snapshot must be a JSON array");
 });

 test("actions flatten the receipts the caller owes, and only those", () => {
  const resolved = resolveQueueDispatch(dispatch(), [node()]);
  const duplicate = resolveQueueDispatch(dispatch(), [
   node("orc-run.1", { queue_dispatch: DISPATCH_KEY, queue_dispatch_ack: DISPATCH_KEY }),
  ]);
  const replay = resolveQueueDispatch(undefined, [node("orc-run.1", { queue_dispatch: DISPATCH_KEY })], {
   replayUnacknowledged: true,
  });

  expect(resolved.actions).toEqual([
   { node: "orc-run.1", metadata: { queue_dispatch: DISPATCH_KEY, queue_dispatch_pending: DISPATCH_KEY } },
  ]);
  expect(duplicate.actions).toEqual([]);
  expect(replay.actions).toEqual([{ node: "orc-run.1", metadata: { queue_dispatch_pending: DISPATCH_KEY } }]);
 });
});

describe("receipt lineage branches the python suite leaves untested", () => {
 test("a receipt naming an event the anchor does not is a half-written rollback", () => {
  raises(
   () => resolve(dispatch(), [node("orc-run.1", { queue_dispatch_pending: DISPATCH_KEY })]),
   ResolutionError,
   "queue_dispatch does not match receipts in queue_dispatch_pending",
  );
 });

 test("a non-string receipt is rejected before it is compared", () => {
  raises(
   () => resolve(dispatch(), [node("orc-run.1", { queue_dispatch_sent: 5 })]),
   ResolutionError,
   "queue_dispatch_sent must be a non-empty string",
  );
 });

 test("an empty-string receipt is rejected too", () => {
  raises(
   () => resolve(dispatch(), [node("orc-run.1", { queue_dispatch_ack: "" })]),
   ResolutionError,
   "queue_dispatch_ack must be a non-empty string",
  );
 });

 test("every stale receipt is named, in pending-sent-ack order", () => {
  const stale = `owner/repo#42@${C40}`;
  raises(
   () =>
    resolve(dispatch(), [
     node("orc-run.1", {
      queue_dispatch: DISPATCH_KEY,
      queue_dispatch_pending: stale,
      queue_dispatch_sent: stale,
     }),
    ]),
   ResolutionError,
   "receipt mismatch in queue_dispatch_pending, queue_dispatch_sent",
  );
 });

 test("a null receipt is absent, not a violation", () => {
  const result = handoff(resolve(dispatch(), [node("orc-run.1", { queue_dispatch_pending: null })]));
  expect(result.status).toBe("resolved");
 });
});

describe("node matching", () => {
 test("an unapproved owner refuses dispatch without authorizing fallback", () => {
  const unapproved = node();
  unapproved.labels = ["orc-node", "state:reported"];
  const outcome = resolveQueueDispatch(dispatch(), [unapproved]);
  expect(outcome.code).toBe(3);
  expect(outcome.result).toBeNull();
  expect(outcome.actions).toEqual([]);
 });

 test("a lifecycle needs orc-node, and ignores the head the node is anchored to", () => {
  const anchoredElsewhere = node("orc-run.1", { head_sha: C40 });
  const result = lifecycleOf(resolve(lifecycle("updated"), [anchoredElsewhere]));
  expect(result.node).toBe("orc-run.1");
  expect(result.headChanged).toBe(true);
 });

 test("closed nodes no longer own a PR", () => {
  const closed = node();
  closed.status = "closed";
  expect(resolveQueueDispatch(dispatch(), [closed]).code).toBe(2);
 });

 test("parked owners refuse dispatch and replay without permitting fallback", () => {
  for (const status of ["open", "blocked"]) {
   const parked = { ...node("orc-run.1", { queue_dispatch: DISPATCH_KEY }), status };
   for (const outcome of [
    resolveQueueDispatch(dispatch(), [parked]),
    resolveQueueDispatch(undefined, [parked], { replayUnacknowledged: true }),
   ]) {
    expect(outcome.code).toBe(3);
    expect(outcome.result).toBeNull();
    expect(outcome.actions).toEqual([]);
   }
   expect(resolveQueueDispatch(lifecycle(), [parked]).result).toMatchObject({ node: parked.id });
   const ambiguous = resolveQueueDispatch(dispatch(), [parked, node("orc-run.2")]);
   expect(ambiguous.code).toBe(3);
   expect(ambiguous.actions).toEqual([]);
  }
 });

 test("working siblings with no ownership identity do not block the PR owner", () => {
  const working = { ...node("orc-run.2"), labels: ["orc-node", "state:working"], metadata: { role: "implementer" } };
  for (const record of [dispatch(), lifecycle()]) {
   expect(resolveQueueDispatch(record, [working]).code).toBe(2);
   expect(resolveQueueDispatch(record, [working, node()]).result).toMatchObject({ node: "orc-run.1" });
  }
  const replay = resolveQueueDispatch(
   undefined,
   [working, node("orc-run.1", { queue_dispatch: DISPATCH_KEY })],
   { replayUnacknowledged: true },
  );
  expect(replay.code).toBe(0);
  expect(replay.result).toMatchObject({ dispatches: [{ node: "orc-run.1" }] });
  for (const metadata of [{ repo: "owner/repo" }, { pr: 42 }, { queue_dispatch_pending: DISPATCH_KEY }]) {
   const malformed = resolveQueueDispatch(dispatch(), [{ ...working, metadata }]);
   expect(malformed.code).toBe(3);
   expect(malformed.actions).toEqual([]);
  }
 });

 test("explicit orchestrate merge ownership is honored independently of dispatch eligibility", () => {
  const merge = node("merge-1", { integration_owner: "orchestrate", queue_dispatch: DISPATCH_KEY });
  merge.labels = ["pr:merge", "state:approved"];
  for (const status of ["open", "blocked", "in_progress"]) {
   const owner = { ...merge, status };
   const dispatchOutcome = resolveQueueDispatch(dispatch(), [owner]);
   const replayOutcome = resolveQueueDispatch(undefined, [owner], { replayUnacknowledged: true });
   if (status === "in_progress") {
    expect(dispatchOutcome.code).toBe(0);
    expect(dispatchOutcome.result).toMatchObject({ node: merge.id });
    expect(replayOutcome.code).toBe(0);
    expect(replayOutcome.result).toMatchObject({ dispatches: [{ node: merge.id }] });
   } else {
    expect(dispatchOutcome.code).toBe(3);
    expect(dispatchOutcome.actions).toEqual([]);
    expect(replayOutcome.code).toBe(3);
    expect(replayOutcome.actions).toEqual([]);
   }
   expect(resolveQueueDispatch(lifecycle(), [owner]).result).toMatchObject({ node: merge.id });
   for (const outcome of [
    resolveQueueDispatch(dispatch(), [owner, node()]),
    resolveQueueDispatch(lifecycle(), [owner, node()]),
    resolveQueueDispatch(undefined, [owner, node()], { replayUnacknowledged: true }),
   ]) {
    expect(outcome.code).toBe(3);
    expect(outcome.result).toBeNull();
    expect(outcome.actions).toEqual([]);
   }
  }
  const unapproved = { ...merge, labels: ["pr:merge"] };
  const stale = { ...merge, metadata: { ...merge.metadata, head_sha: C40 } };
  for (const ineligible of [unapproved, stale]) {
   expect(resolveQueueDispatch(dispatch(), [ineligible]).code).toBe(3);
  }
 });

 test("a linked merge takes over dispatch and receipt replay from its source node", () => {
  const lifecycleKey = "owner/repo#42#failed#opaque";
  const receipts = {
   queue_dispatch: DISPATCH_KEY,
   queue_dispatch_pending: DISPATCH_KEY,
   queue_lifecycle: lifecycleKey,
   queue_lifecycle_pending: lifecycleKey,
   queue_lifecycle_head: A40,
   queue_lifecycle_transition: "failed",
  };
  const source = { ...node("orc-run.1", receipts), parent: "feature-1" };
  for (const origin_bead of [source.id, source.parent]) {
   const merge = node("merge-1", { ...receipts, role: "shepherd", integration_owner: "orchestrate", origin_bead });
   merge.labels = ["pr:merge", "state:approved"];
   for (const record of [dispatch(), lifecycle("failed", { checks: "fail" })]) {
    const outcome = resolveQueueDispatch(record, [source, merge]);
    expect(outcome.code).toBe(0);
    expect(outcome.result).toMatchObject({ node: merge.id });
   }
   const replay = resolveQueueDispatch(undefined, [source, merge], { replayUnacknowledged: true });
   expect(replay.code).toBe(0);
   expect(replay.result).toMatchObject({
    dispatches: [{ node: merge.id }],
    lifecycles: [{ node: merge.id }],
   });
  }
 });

 test("source approval and receipts cannot bypass its designated merge", () => {
  const source = node("orc-run.1", { queue_dispatch: DISPATCH_KEY });
  const merge = node("merge-1", {
   role: "shepherd",
   integration_owner: "orchestrate",
   origin_bead: source.id,
   queue_dispatch: DISPATCH_KEY,
  });
  merge.labels = ["pr:merge", "state:approved"];
  for (const ineligible of [
   { ...merge, status: "open" },
   { ...merge, status: "blocked" },
   { ...merge, labels: ["pr:merge", "state:reported"] },
   { ...merge, metadata: { ...merge.metadata, head_sha: C40 } },
  ]) {
   for (const outcome of [
    resolveQueueDispatch(dispatch(), [source, ineligible]),
    resolveQueueDispatch(undefined, [source, ineligible], { replayUnacknowledged: true }),
   ]) {
    expect(outcome.code).toBe(3);
    expect(outcome.result).toBeNull();
    expect(outcome.actions).toEqual([]);
   }
  }
  const noMergeReceipt = { ...merge, status: "open", metadata: { ...merge.metadata } };
  delete noMergeReceipt.metadata.queue_dispatch;
  const replay = resolveQueueDispatch(undefined, [source, noMergeReceipt], { replayUnacknowledged: true });
  expect(replay.code).toBe(0);
  expect(replay.result).toEqual({ status: "replay", dispatches: [], lifecycles: [] });
  expect(replay.actions).toEqual([]);
 });

 test("ownership transfer requires a unique merge and positively validated lineage", () => {
  const source = { ...node(), parent: "feature-1" };
  const merge = node("merge-1", { role: "shepherd", integration_owner: "orchestrate", origin_bead: source.id });
  merge.labels = ["pr:merge", "state:approved"];
  for (const candidates of [
   [source, { ...merge, metadata: { ...merge.metadata, origin_bead: "other-feature" } }],
   [node(), { ...merge, metadata: { ...merge.metadata, origin_bead: "feature-1" } }],
   [source, { ...merge, metadata: { ...merge.metadata, role: "implementer" } }],
   [source, { ...merge, id: source.id }],
   [source, merge, node("orc-run.2")],
   [source, merge, { ...merge, id: "merge-2" }],
  ]) {
   for (const outcome of [
    resolveQueueDispatch(dispatch(), candidates),
    resolveQueueDispatch(lifecycle(), candidates),
    resolveQueueDispatch(undefined, candidates, { replayUnacknowledged: true }),
   ]) {
    expect(outcome.code).toBe(3);
    expect(outcome.result).toBeNull();
    expect(outcome.actions).toEqual([]);
   }
  }
 });

 test("a generic merge bead or ownership metadata alone does not authorize orchestrate handoff", () => {
  const generic = { ...node(), labels: ["pr:merge", "state:approved"] };
  const unlabelled = { ...node("stray", { integration_owner: "orchestrate" }), labels: ["state:approved"] };
  for (const stray of [generic, unlabelled]) {
   expect(resolveQueueDispatch(dispatch(), [stray]).code).toBe(2);
   expect(resolveQueueDispatch(lifecycle(), [stray]).code).toBe(2);
   expect(replayUnacknowledged([{ ...stray, metadata: { ...stray.metadata, queue_dispatch: DISPATCH_KEY } }])).toEqual([]);
  }
 });

 test("non-node entries are ignored but malformed owner metadata blocks routing", () => {
  expect(resolveQueueDispatch(dispatch(), ["orc-run.1", 7, null, []]).code).toBe(2);
  const badMetadata = { ...node(), metadata: ["repo", "owner/repo"] };
  for (const record of [dispatch(), lifecycle()]) {
   const outcome = resolveQueueDispatch(record, [badMetadata]);
   expect(outcome.code).toBe(3);
   expect(outcome.result).toBeNull();
   expect(outcome.actions).toEqual([]);
  }
 });

 test("a metadata.pr spelled as a decimal string still matches", () => {
  // `int("42")` is how the script reads a bd metadata value, which is often a string.
  const stringPr = node("orc-run.1", { pr: "42" });
  expect(handoff(resolve(dispatch(), [stringPr])).number).toBe(42);
 });

 test("an invalid owner PR cannot prove the record is unowned", () => {
  for (const pr of ["0x2a", "42.0", "forty-two", "", null, [42], { pr: 42 }]) {
   const outcome = resolveQueueDispatch(dispatch(), [node("orc-run.1", { pr })]);
   expect(outcome.code).toBe(3);
   expect(outcome.actions).toEqual([]);
  }
 });

 test("a lifecycle for a PR nobody owns is unmatched, not unresolved", () => {
  const outcome = resolveQueueDispatch(lifecycle("updated"), []);
  expect(outcome.code).toBe(2);
  expect(outcome.error).toBe("unmatched watcher record: no orchestrate node for owner/repo#42");
 });

 test("two orchestrate nodes for one PR block a lifecycle", () => {
  const outcome = resolveQueueDispatch(lifecycle("updated"), [node(), node("orc-run.2")]);
  expect(outcome.code).toBe(3);
  expect(outcome.actions).toEqual([]);
 });

 test("a node missing its id cannot be handed a dispatch", () => {
  const anonymous = node();
  anonymous.id = "";
  raises(() => resolve(dispatch(), [anonymous]), ResolutionError, "approved node is missing its id");
 });

 test("a woken lifecycle needs the git anchors an unwoken one does not", () => {
  const noAnchors = node("orc-run.1", { branch: null });
  raises(
   () => resolve(lifecycle("failed", { checks: "fail" }), [noAnchors]),
   ResolutionError,
   "orchestrate node is missing metadata.branch",
  );

  const unapproved = node("orc-run.1", { branch: null });
  unapproved.labels = ["orc-node", "state:reported"];
  const recorded = lifecycleOf(resolve(lifecycle("updated"), [unapproved]));
  expect(recorded.wakeShepherd).toBe(false);
  expect("branch" in recorded).toBe(false);
 });

 test("unreadable ownership labels refuse routing", () => {
  const numeric = { ...node(), labels: 7 };
  const outcome = resolveQueueDispatch(dispatch(), [numeric]);
  expect(outcome.code).toBe(3);
  expect(outcome.result).toBeNull();
  expect(outcome.actions).toEqual([]);
 });
});

describe("record validation", () => {
 test("missing pull-request fields are listed in sorted order", () => {
  const record = dispatch();
  record.pullRequest = { repository: "owner/repo", number: 42 };
  raises(
   () => resolve(record, [node()]),
   ContractError,
   "dispatch.pullRequest missing fields: activeSince, baseRef, checks, createdAt, draft, headSha, labels, " +
   "mergeable, priority, state, title, updatedAt",
  );
 });

 test("each readiness field is re-checked, not trusted", () => {
  const cases: [Record<string, unknown>, string][] = [
   [{ repository: "owner" }, "repository must be OWNER/REPO"],
   [{ repository: "owner/repo/extra" }, "repository must be OWNER/REPO"],
   [{ number: 0 }, "number must be a positive integer"],
   [{ number: true }, "number must be a positive integer"],
   [{ number: "42" }, "number must be a positive integer"],
   [{ headSha: "nothex" }, "headSha must be a hexadecimal Git object id"],
   [{ headSha: "abc" }, "headSha must be a hexadecimal Git object id"],
   [{ priority: 5 }, "priority must be an integer from 0 through 4"],
   [{ priority: -1 }, "priority must be an integer from 0 through 4"],
   [{ labels: "priority:high" }, "labels must be an array of strings"],
   [{ labels: [1] }, "labels must be an array of strings"],
   [{ title: "" }, "title must be a non-empty string"],
   [{ baseRef: null }, "baseRef must be a non-empty string"],
   [{ activeSince: null }, "activeSince must be a non-empty string"],
   [{ draft: true }, "dispatch must describe a non-draft pull request"],
   [{ mergeable: null }, "dispatch must describe a mergeable pull request"],
   [{ checks: "pending" }, "dispatch checks must be pass"],
   [{ state: "queued" }, "dispatch state must be active"],
  ];
  for (const [overrides, expected] of cases) {
   raises(() => resolve(dispatch(overrides), [node()]), ContractError, expected);
  }
 });

 test("a dispatch whose pullRequest is not an object is rejected", () => {
  raises(
   () => resolve({ type: "dispatch", pullRequest: [] }, [node()]),
   ContractError,
   "dispatch.pullRequest must be a JSON object",
  );
 });

 test("a record that is not an object at all is rejected", () => {
  for (const record of ["dispatch", 7, null, [], true]) {
   raises(() => resolve(record, [node()]), ContractError, "watcher record must be a JSON object");
  }
 });

 test("lifecycle vocabularies are reported with their allowed values", () => {
  const cases: [Record<string, unknown>, string][] = [
   [{ transition: "rebased" }, "transition must be one of ['closed', 'failed', 'merged', 'opened', 'updated']"],
   [{ source: "poll" }, "source must be one of ['reconciliation', 'webhook']"],
   [{ lifecycleKey: "" }, "lifecycleKey must be a non-empty string"],
  ];
  for (const [overrides, expected] of cases) {
   const record = { ...lifecycle("updated"), ...overrides };
   raises(() => resolve(record, [node()]), ContractError, expected);
  }
 });

 test("a lifecycle tolerates a draft, failing, or closed PR that a dispatch may not", () => {
  const draft = lifecycle("updated", { draft: true, mergeable: null, checks: "pending", state: "blocked" });
  const result = lifecycleOf(resolve(draft, [node()]));
  expect(result.status).toBe("resolved");
  expect(result.transition).toBe("updated");
 });

 test("lifecycle field types are still checked", () => {
  const cases: [Record<string, unknown>, string][] = [
   [{ draft: "no" }, "draft must be a boolean"],
   [{ mergeable: "yes" }, "mergeable must be a boolean or null"],
   [{ checks: "green" }, "checks must be one of ['fail', 'pass', 'pending']"],
   [{ state: "open" }, "state must be one of ['active', 'blocked', 'closed', 'queued']"],
   [{ activeSince: "" }, "activeSince must be a non-empty string or null"],
  ];
  for (const [overrides, expected] of cases) {
   raises(() => resolve(lifecycle("updated", overrides), [node()]), ContractError, expected);
  }
 });

 test("a lifecycle may carry a null activeSince", () => {
  const result = lifecycleOf(resolve(lifecycle("updated", { activeSince: null }), [node()]));
  expect(result.status).toBe("resolved");
 });

 test("a terminal transition must describe a closed PR", () => {
  raises(
   () => resolve(lifecycle("merged"), [node()]),
   ContractError,
   "terminal lifecycle pullRequest.state must be closed",
  );
  raises(
   () => resolve(lifecycle("closed"), [node()]),
   ContractError,
   "terminal lifecycle pullRequest.state must be closed",
  );
 });

 test("a webhook lifecycle must carry its delivery evidence", () => {
  for (const field of ["deliveryId", "webhookAction"]) {
   const record = lifecycle("updated");
   delete record[field];
   raises(() => resolve(record, [node()]), ContractError, `webhook lifecycle ${field} must be a non-empty string`);
  }
  const reconciled: Record<string, unknown> = { ...lifecycle("updated"), source: "reconciliation" };
  delete reconciled.deliveryId;
  delete reconciled.webhookAction;
  expect(lifecycleOf(resolve(reconciled, [node()])).source).toBe("reconciliation");
 });

 test("a watcher error must say what failed, and may name a repository", () => {
  raises(
   () => resolve({ type: "reconcile-error" }, [node()]),
   ContractError,
   "watcher error message must be a non-empty string",
  );
  raises(
   () => resolve({ type: "webhook-error", message: "bad signature", repository: "owner" }, [node()]),
   ContractError,
   "watcher error repository must be OWNER/REPO",
  );
  expect(resolve({ type: "reconcile-error", message: "api down", repository: "owner/repo" }, [])).toEqual({
   status: "fallback",
   recordType: "reconcile-error",
   action: "gate-check-and-pass",
   message: "api down",
   repository: "owner/repo",
  });
  expect(resolve({ type: "webhook-error", message: "bad signature" }, [])).toEqual({
   status: "fallback",
   recordType: "webhook-error",
   action: "gate-check-and-pass",
   message: "bad signature",
   repository: null,
  });
 });

 test("priority zero survives, because it is a priority and not an absence", () => {
  expect(handoff(resolve(dispatch({ priority: 0 }), [node()])).priority).toBe(0);
 });

 test("a replayed handoff carries no priority: the record that had one is gone", () => {
  const replayed = replayUnacknowledged([node("orc-run.1", { queue_dispatch: DISPATCH_KEY })])[0];
  expect("priority" in replayed).toBe(false);
 });
});

describe("replay scan validation", () => {
 test("a dispatch key that contradicts the node's identity is refused", () => {
  raises(
   () => replayUnacknowledged([node("orc-run.1", { queue_dispatch: `owner/repo#43@${A40}` })]),
   ResolutionError,
   "queued node dispatch key does not match its identity",
  );
 });

 test("invalid queued owner identity refuses replay without receipt writes", () => {
  for (const overrides of [
   { pr: null },
   { pr: true },
   { pr: 0 },
   { repo: "owner" },
   { head_sha: "nothex" },
  ]) {
   const outcome = resolveQueueDispatch(
    undefined,
    [node("orc-run.1", { queue_dispatch: DISPATCH_KEY, ...overrides })],
    { replayUnacknowledged: true },
   );
   expect(outcome.code).toBe(3);
   expect(outcome.result).toBeNull();
   expect(outcome.actions).toEqual([]);
  }
 });

 test("a node with no queue_dispatch is not owed a delivery", () => {
  expect(replayUnacknowledged([node(), node("orc-run.2", { pr: 43, queue_dispatch: "" })])).toEqual([]);
 });

 test("lifecycle replay validates the transition and head it rebuilds the record from", () => {
  const key = "owner/repo#42#failed#opaque";
  raises(
   () =>
    replayUnacknowledgedLifecycles([
     node("orc-run.1", { queue_lifecycle: key, queue_lifecycle_head: A40, queue_lifecycle_transition: "poked" }),
    ]),
   ResolutionError,
   "queued node has invalid lifecycle transition",
  );
  raises(
   () =>
    replayUnacknowledgedLifecycles([
     node("orc-run.1", {
      queue_lifecycle: key,
      queue_lifecycle_head: "nothex",
      queue_lifecycle_transition: "failed",
     }),
    ]),
   ResolutionError,
   "queued node has invalid lifecycle head",
  );
 });

 test("a replayed lifecycle is sourced as a replay, never as the webhook it once was", () => {
  const key = "owner/repo#42#failed#opaque";
  const replayed = replayUnacknowledgedLifecycles([
   node("orc-run.1", { queue_lifecycle: key, queue_lifecycle_head: A40, queue_lifecycle_transition: "failed" }),
  ])[0];
  expect(replayed.source).toBe("replay");
  expect(replayed.headChanged).toBe(false);
  expect(replayed.requiredMetadata).toEqual({ queue_lifecycle_pending: key });
 });

 test("handoffs come back ordered by node id, so a scan reads the same twice", () => {
  const nodes = ["orc-run.9", "orc-run.10", "orc-run.2"].map((id, index) =>
   node(id, {
    pr: 50 + index,
    queue_dispatch: `owner/repo#${50 + index}@${A40}`,
   }),
  );
  expect(replayUnacknowledged(nodes).map((item) => item.node)).toEqual(["orc-run.10", "orc-run.2", "orc-run.9"]);
 });

 test("an approved non-orchestrate bead never receives dispatch or replay", () => {
  const lifecycleKey = "owner/repo#42#failed#opaque";
  const metadata = {
   queue_dispatch: DISPATCH_KEY,
   queue_lifecycle: lifecycleKey,
   queue_lifecycle_head: A40,
   queue_lifecycle_transition: "failed",
  };
  const stray = node("orc-run.2", metadata);
  stray.labels = ["state:approved"];
  const owner = node("orc-run.1", metadata);
  for (const record of [dispatch(), lifecycle("failed", { checks: "fail" })]) {
   const unowned = resolveQueueDispatch(record, [stray]);
   expect(unowned.code).toBe(2);
   expect(unowned.actions).toEqual([]);
   const owned = resolveQueueDispatch(record, [owner, stray]);
   expect(owned.code).toBe(0);
   expect(owned.result).toMatchObject({ node: owner.id });
   expect(owned.actions.map((action) => action.node)).toEqual([owner.id]);
  }
  const replay = resolveQueueDispatch(undefined, [owner, stray], { replayUnacknowledged: true });
  expect(replay.code).toBe(0);
  const result = replay.result;
  if (!result || !("dispatches" in result)) throw new Error("expected replay");
  expect(result.dispatches.map((item) => item.node)).toEqual([owner.id]);
  expect(result.lifecycles.map((item) => item.node)).toEqual([owner.id]);
  expect(replay.actions.map((action) => action.node)).toEqual([owner.id, owner.id]);
 });
});

describe("canonicalJson", () => {
 test("sorts keys at every depth and separates without spaces", () => {
  expect(canonicalJson({ b: 1, a: { d: [{ f: 1, e: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[{"e":2,"f":1}]},"b":1}');
 });

 test("escapes non-ascii the way json.dump does by default", () => {
  expect(canonicalJson({ title: "café" })).toBe('{"title":"caf\\u00e9"}');
 });

 test("renders a resolved handoff exactly as the script printed it", () => {
  const outcome = resolveQueueDispatch(dispatch(), [node()]);
  expect(canonicalJson(outcome.result)).toBe(
   '{"baseSha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","branch":"coder/t1",' +
   `"deliveryState":null,"dispatchKey":"${DISPATCH_KEY}","headSha":"${A40}","node":"orc-run.1",` +
   '"number":42,"priority":1,"repository":"owner/repo","requiredMetadata":' +
   `{"queue_dispatch":"${DISPATCH_KEY}","queue_dispatch_pending":"${DISPATCH_KEY}"},"status":"resolved"}`,
  );
 });
});

/** Collect what `registerResolveQueueDispatch` registers, without an OMP session. */
function registered(read?: SnapshotReader): {
 execute: (
  id: string,
  params: { record?: string; nodesFile?: string; nodes?: string; replayUnacknowledged?: boolean; cwd?: string },
 ) => Promise<{ content: { type: string; text: string }[]; details?: QueueDispatchDetails; isError?: boolean }>;
} {
 const tools: unknown[] = [];
 const pi = { zod, registerTool: (tool: unknown) => tools.push(tool) } as unknown as ExtensionAPI;
 registerResolveQueueDispatch(pi, read);
 expect(tools).toHaveLength(1);
 return tools[0] as ReturnType<typeof registered>;
}

describe("registerResolveQueueDispatch", () => {
 test("reads a bd envelope out of nodesFile and mirrors the script's stdout", async () => {
  const seen: string[] = [];
  const tool = registered(async (file) => {
   seen.push(file);
   return JSON.stringify({ schema_version: 1, data: [node()] });
  });

  const result = await tool.execute("id", {
   nodesFile: "nodes.json",
   cwd: "/snapshots",
   record: JSON.stringify(dispatch()),
  });

  expect(seen).toEqual(["/snapshots/nodes.json"]);
  expect(result.isError).toBeFalsy();
  expect(result.details?.code).toBe(0);
  expect(result.details?.status).toBe("resolved");
  const lines = result.content[0].text.split("\n");
  expect(lines[0]).toBe("exit 0: resolved/replay/duplicate/control record");
  expect(JSON.parse(lines[1]).dispatchKey).toBe(DISPATCH_KEY);
 });

 test("takes the snapshot inline, and prefers it over nodesFile", async () => {
  const tool = registered(async () => {
   throw new Error("nodesFile must not be read when nodes is given");
  });
  const result = await tool.execute("id", {
   nodes: JSON.stringify([node()]),
   nodesFile: "unused.json",
   record: JSON.stringify(dispatch()),
  });
  expect(result.details?.code).toBe(0);
 });

 test("replays without a record", async () => {
  const tool = registered(async () =>
   JSON.stringify([node("orc-run.1", { queue_dispatch: DISPATCH_KEY, queue_dispatch_pending: DISPATCH_KEY })]),
  );
  const result = await tool.execute("id", { nodesFile: "nodes.json", replayUnacknowledged: true });

  expect(result.details?.code).toBe(0);
  const payload = JSON.parse(result.content[0].text.split("\n")[1]);
  expect(payload.dispatches[0].status).toBe("replay");
  expect(payload.lifecycles).toEqual([]);
 });

 test("an unmatched record is an error result carrying code 2, never a throw", async () => {
  const tool = registered(async () => "[]");
  const result = await tool.execute("id", { nodesFile: "nodes.json", record: JSON.stringify(dispatch()) });

  expect(result.isError).toBe(true);
  expect(result.details?.code).toBe(2);
  expect(result.details?.meaning).toContain("safe to route once to pr-shepherd");
 });

 test("an unreadable snapshot is invalid input, not a crash", async () => {
  const tool = registered(async () => {
   throw new Error("ENOENT: no such file or directory");
  });
  const result = await tool.execute("id", { nodesFile: "/missing/nodes.json", record: JSON.stringify(dispatch()) });

  expect(result.isError).toBe(true);
  expect(result.details?.code).toBe(1);
  expect(result.details?.error).toBe(
   "invalid watcher record: cannot read JSON from /missing/nodes.json: ENOENT: no such file or directory",
  );
 });

 test("a snapshot that is not JSON is invalid input", async () => {
  const tool = registered(async () => "{oops");
  const result = await tool.execute("id", { nodesFile: "nodes.json", record: JSON.stringify(dispatch()) });
  expect(result.details?.code).toBe(1);
  expect(result.details?.error).toContain("cannot read JSON from nodes.json");
 });

 test("a record that is not JSON is invalid watcher JSON", async () => {
  const tool = registered(async () => "[]");
  const result = await tool.execute("id", { nodesFile: "nodes.json", record: "{oops" });
  expect(result.details?.code).toBe(1);
  expect(result.details?.error).toContain("invalid watcher JSON:");
 });

 test("a missing record is refused before any snapshot is matched", async () => {
  const tool = registered(async () => "[]");
  const result = await tool.execute("id", { nodesFile: "nodes.json" });
  expect(result.details?.code).toBe(1);
  expect(result.details?.error).toContain("no record was given");
 });

 // PARITY: the script's argparse exits 2 for a missing `--nodes-file`, which is the code
 // that tells a shepherd it may reroute. A missing argument reports 1 here instead.
 test("a missing snapshot argument is invalid input, not a reroute", async () => {
  const result = await registered().execute("id", { record: JSON.stringify(dispatch()) });
  expect(result.details?.code).toBe(1);
  expect(result.details?.error).toBe("invalid watcher record: pass `nodes` or `nodesFile`; neither was given");
 });

 test("details carry the receipts to persist", async () => {
  const tool = registered(async () => JSON.stringify([node()]));
  const result = await tool.execute("id", { nodesFile: "nodes.json", record: JSON.stringify(dispatch()) });
  expect(result.details?.actions).toEqual([
   { node: "orc-run.1", metadata: { queue_dispatch: DISPATCH_KEY, queue_dispatch_pending: DISPATCH_KEY } },
  ]);
 });

 // Everything above injects a reader, so the default one — the module's only filesystem
 // touch — would otherwise ship unexercised.
 test("the default reader loads a real snapshot, resolving nodesFile against cwd", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orc-rqd-"));
  try {
   await fs.writeFile(path.join(dir, "nodes.json"), JSON.stringify({ schema_version: 1, data: [node()] }));
   const result = await registered().execute("id", {
    nodesFile: "nodes.json",
    cwd: dir,
    record: JSON.stringify(dispatch()),
   });

   expect(result.isError).toBeFalsy();
   expect(result.details?.code).toBe(0);
   expect(JSON.parse(result.content[0].text.split("\n")[1]).dispatchKey).toBe(DISPATCH_KEY);
  } finally {
   await fs.rm(dir, { recursive: true, force: true });
  }
 });

 test("the default reader reports an absent snapshot as invalid input", async () => {
  const absent = path.join(os.tmpdir(), "orc-rqd-absent", "nodes.json");
  const result = await registered().execute("id", { nodesFile: absent, record: JSON.stringify(dispatch()) });

  expect(result.isError).toBe(true);
  expect(result.details?.code).toBe(1);
  expect(result.details?.error).toContain(`cannot read JSON from ${absent}`);
 });
});
