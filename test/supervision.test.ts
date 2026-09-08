import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import * as realBd from "../src/bd";
import type { BdBead, BdComment, BdResult } from "../src/bd";
import type { Exec, ExecResult } from "../src/supervision";

/**
 * The reaper's observable effect is its argv. Spies record those calls while the
 * real pure helpers remain in place; restoring the spies leaves no module mock
 * behind for suites that exercise the real bd subprocess.
 */

/** Every `bd` argv the module under test ran, in order. */
let ran: string[][] = [];

/** What each `bd` read answers this test. */
interface BdWorld {
 /** `bd list --assignee <child> --status in_progress` */
 claimed: BdBead[] | null;
 wisps: BdBead[] | null;
 /** `bd list --metadata-field actor=<child>` */
 stamped: BdBead[] | null;
 /** `bd dep list <id> --direction=up` */
 linked: BdBead[] | null;
 /** Comment text per bead id. */
 comments: Record<string, string[] | null>;
}

let world: BdWorld = { claimed: [], wisps: [], stamped: [], linked: [], comments: {} };

function listFor(args: string[]): BdBead[] | null {
 if (args[0] === "mol") return world.wisps;
 if (args[0] === "dep") return world.linked;
 if (args.includes("--metadata-field")) return world.stamped;
 if (args.includes("--assignee")) return world.claimed;
 return [];
}

const bdSpies = [
 spyOn(realBd, "bdListChecked").mockImplementation(async (args: string[]): Promise<BdBead[] | null> => {
  ran.push(args);
  return listFor(args);
 }),
 spyOn(realBd, "bdRun").mockImplementation(async (args: string[]): Promise<BdResult | null> => {
  ran.push(args);
  return { code: 0, stdout: "", stderr: "" };
 }),
 spyOn(realBd, "bdCommentsChecked").mockImplementation(async (id: string): Promise<BdComment[] | null> => {
  ran.push(["comments", id]);
  if (world.comments[id] === null) return null;
  return (world.comments[id] ?? []).map(text => ({ text }));
 }),
 // No wisps in these fixtures: linked-comment predicates belong to the exit tests.
 spyOn(realBd, "bdLinkedChecked").mockImplementation(async (): Promise<string[]> => []),
];

// Deliberately import after installing spies: the import-time assertion below
// must observe any bd calls made while the module is evaluated.
const { branchIntegrated, reapChild, registerSupervision } = await import("../src/supervision");

/** Nothing may run at import time: the plugin loads in every session, gates included. */
const ranDuringImport = ran.length;

/**
 * A dispatched task bead, in the shape `bd list --json` returns it — including the
 * `assignee: null` of an unassigned bead, which `BdBead`'s optional field cannot type.
 */
function bead(fields: Record<string, unknown> = {}): BdBead {
 return {
  id: "orc-1",
  status: "in_progress",
  labels: ["agent:implementer"],
  metadata: { actor: "impl-7", role: "implementer" },
  ...fields,
 } as BdBead;
}

/** A git seam that answers `branch --list` with `branches` and nothing else. */
function gitWith(branches: string[]): Exec {
 return async (argv: string[]): Promise<ExecResult | null> => {
  if (argv[1] === "branch") return { code: 0, stdout: branches.map(name => `  ${name}\n`).join(""), stderr: "" };
  return null;
 };
}

/** The `bd update` argv the reaper ran, or `undefined` when it ran none. */
function update(): string[] | undefined {
 return ran.find(argv => argv[0] === "update");
}

/** The text of the single comment the reaper wrote, or `undefined`. */
function comment(): string | undefined {
 return ran.find(argv => argv[0] === "comment")?.[2];
}

beforeEach(() => {
 ran = [];
 world = { claimed: [], wisps: [], stamped: [], linked: [], comments: {} };
});

afterAll(() => {
 for (const spy of bdSpies) spy.mockRestore();
});

describe("import", () => {
 test("loading the module touches neither bd nor git", () => {
  expect(ranDuringImport).toBe(0);
 });
});

describe("reapChild recovery observations", () => {
 test("released shepherd IDLE preserves inherited approval and is a clean exit", async () => {
  const head = "a".repeat(40);
  const approved = bead({
   status: "open",
   assignee: "",
   labels: ["state:approved"],
   metadata: { actor: "shepherd-1", role: "shepherd", execution_kind: "git", head_sha: head },
  });
  world.stamped = [approved];
  world.comments["orc-1"] = [`IDLE head_sha=${head}`];
  const outcome = await reapChild({ id: "shepherd-1", status: "completed" }, { cwd: "/repo", exec: gitWith([]) });
  expect(outcome.reaped).toEqual([{ bead: "orc-1", case: "clean", failures: [], recovery: "not-needed" }]);
  expect(approved.labels).toContain("state:approved");
  expect(approved.assignee).toBe("");
  expect(update()).toBeUndefined();
  expect(comment()).toBeUndefined();
 });

 test("a successor claiming during git discovery is never overwritten", async () => {
  const current = bead({ assignee: "impl-7" });
  world.claimed = [{ ...current }];
  const outcome = await reapChild({ id: "impl-7", status: "failed" }, {
   cwd: "/repo", exec: async () => {
    current.assignee = "successor";
    current.status = "closed";
    return { code: 0, stdout: "omp/task/impl-7", stderr: "" };
   },
  });
  expect(current.assignee).toBe("successor");
  expect(current.status).toBe("closed");
  expect(update()).toBeUndefined();
  expect(outcome.reaped[0]?.recovery).toBe("recorded");
  expect(comment()).toContain("exclusive recovery window");
 });

 test("unreadable completion evidence is unknown, never missing", async () => {
  world.stamped = [bead({ status: "open", assignee: null })];
  world.comments["orc-1"] = null;
  const result = await reapChild({ id: "impl-7", status: "completed" }, { cwd: "/repo", exec: gitWith([]) });
  expect(result.reaped[0]).toMatchObject({ case: "unknown", failures: [], recovery: "recorded" });
  expect(update()).toBeUndefined();
 });

 test.each([null, { code: 1, stdout: "", stderr: "git failed" }])("git failure is not evidence of no work", async result => {
  world.claimed = [bead({ assignee: "impl-7" })];
  const outcome = await reapChild({ id: "impl-7", status: "failed" }, { cwd: "/repo", exec: async () => result });
  expect(outcome.branchState).toBe("unknown");
  expect(outcome.reaped[0]?.case).toBe("unknown");
  expect(update()).toBeUndefined();
 });

 test("positive absence and positive branch evidence remain distinct", async () => {
  world.claimed = [bead({ assignee: "impl-7" })];
  const absent = await reapChild({ id: "impl-7", status: "aborted" }, { cwd: "/repo", exec: gitWith([]) });
  const found = await reapChild({ id: "impl-7", status: "aborted" }, { cwd: "/repo", exec: gitWith(["omp/task/impl-7"]) });
  expect(absent.branchState).toBe("absent");
  expect(found.branch).toBe("omp/task/impl-7");
  expect(found.branchState).toBe("found");
  expect(update()).toBeUndefined();
 });

 test("clean completion does not stamp over concurrent metadata", async () => {
  world.stamped = [bead({ status: "open", labels: [], metadata: { actor: "impl-7" }, assignee: null })];
  world.comments["orc-1"] = ["REPORTED delivered"];
  const outcome = await reapChild({ id: "impl-7", status: "completed" }, { cwd: "/repo", exec: gitWith(["omp/task/impl-7"]) });
  expect(outcome.reaped[0]?.case).toBe("clean");
  expect(update()).toBeUndefined();
 });

 test("failed evidence persistence never reports recovery recorded", async () => {
  world.claimed = [bead({ assignee: "impl-7" })];
  const failing = spyOn(realBd, "bdRun").mockResolvedValueOnce({ code: 1, stdout: "", stderr: "write refused" });
  const outcome = await reapChild({ id: "impl-7", status: "failed" }, { cwd: "/repo", exec: gitWith([]) });
  expect(outcome.reaped[0]?.recovery).toBe("record-failed");
  expect(update()).toBeUndefined();
  failing.mockImplementation(async args => { ran.push(args); return { code: 0, stdout: "", stderr: "" }; });
 });

 test("discovers open, blocked, deferred claims and review wisps without truncation", async () => {
  world.claimed = [bead({ id: "orc-open", status: "open", assignee: "impl-7" }), bead({ id: "orc-blocked", status: "blocked", assignee: "impl-7" })];
  world.wisps = [bead({ id: "orc-review", status: "deferred", assignee: "impl-7", ephemeral: true })];
  const outcome = await reapChild({ id: "impl-7", status: "failed" }, { cwd: "/repo", exec: gitWith([]) });
  expect(outcome.reaped.map(row => row.bead)).toEqual(["orc-open", "orc-blocked", "orc-review"]);
  expect(ran[0]).toContain("--include-infra");
  expect(ran[0]).toContain("open,in_progress,blocked,deferred");
  expect(ran[0]).toContain("--limit");
 });

 test("partial candidate lookup is reported, not an empty successful sweep", async () => {
  world.wisps = null;
  const outcome = await reapChild({ id: "impl-7", status: "failed" }, { cwd: "/repo", exec: gitWith([]) });
  expect(outcome.discoveryUnknown).toBe(true);
 });

 test("a nonterminal child and an already reassigned bead cause no writes", async () => {
  world.stamped = [bead({ assignee: "successor" })];
  await reapChild({ id: "impl-7", status: "started" }, { cwd: "/repo", exec: gitWith([]) });
  await reapChild({ id: "impl-7", status: "completed" }, { cwd: "/repo", exec: gitWith([]) });
  expect(comment()).toBeUndefined();
  expect(update()).toBeUndefined();
 });
});

describe("branchIntegrated", () => {
 const cherry = (result: ExecResult | null): Exec => async () => result;

 test("every commit already upstream is integrated", async () => {
  const stdout = "- 845d702a86971732ca63375f3b4ff3137bdf08b5\n- 1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d\n";
  expect(await branchIntegrated("feat/x", "omp/task/impl-7", "/repo", cherry({ code: 0, stdout, stderr: "" }))).toBe(
   "integrated",
  );
  // Nothing to compare is the same answer: no commit is missing upstream.
  expect(await branchIntegrated("feat/x", "omp/task/impl-7", "/repo", cherry({ code: 0, stdout: "", stderr: "" }))).toBe(
   "integrated",
  );
 });

 test("one missing commit is pending, even beside integrated ones", async () => {
  const stdout = "- 845d702a86971732ca63375f3b4ff3137bdf08b5\n+ 1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d\n";
  expect(await branchIntegrated("feat/x", "omp/task/impl-7", "/repo", cherry({ code: 0, stdout, stderr: "" }))).toBe(
   "pending",
  );
 });

 test("an unknown ref, an unrunnable git, or an unparseable line is unknown", async () => {
  const bad = cherry({ code: 128, stdout: "", stderr: "fatal: unknown commit omp/task/impl-7" });
  expect(await branchIntegrated("feat/x", "omp/task/impl-7", "/repo", bad)).toBe("unknown");
  expect(await branchIntegrated("feat/x", "omp/task/impl-7", "/repo", async () => null)).toBe("unknown");
  // Never read as integrated: the caller deletes branches on that answer.
  const noise = cherry({ code: 0, stdout: "warning: refname is ambiguous\n", stderr: "" });
  expect(await branchIntegrated("feat/x", "omp/task/impl-7", "/repo", noise)).toBe("unknown");
 });
});

/** Collect what `registerSupervision` subscribes, without an OMP session. */
function recordingApi(): {
 pi: ExtensionAPI;
 /** Extension events it subscribed, in order. */
 events: string[];
 /** Bus channels it subscribed, in order. */
 channels: string[];
 messages: string[];
 sessionStart: (ctx: ExtensionContext) => void;
 deliver: (payload: unknown) => Promise<void>;
} {
 const events: string[] = [];
 const channels: string[] = [];
 const messages: string[] = [];
 const handlers: ((event: unknown, ctx: ExtensionContext) => void)[] = [];
 const listeners: ((data: unknown) => unknown)[] = [];
 const stub = {
  sendMessage: (message: { content: string }) => { messages.push(message.content); },
  on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => void) => {
   events.push(event);
   handlers.push(handler);
  },
  events: {
   on: (channel: string, listener: (data: unknown) => unknown) => {
    channels.push(channel);
    listeners.push(listener);
   },
  },
  logger: { error: () => { }, debug: () => { }, warn: () => { }, info: () => { } },
 };
 return {
  pi: stub as unknown as ExtensionAPI,
  events,
  channels,
  messages,
  sessionStart: ctx => {
   for (const handler of handlers) handler({}, ctx);
  },
  deliver: async payload => {
   // The handler hands its promise back to the bus, so the reap is awaited
   // here rather than guessed at with a delay.
   for (const listener of listeners) await listener(payload);
  },
 };
}

describe("registerSupervision", () => {
 const ctx = { cwd: "/repo" } as unknown as ExtensionContext;

 test("unread candidate discovery notifies the spawning session with a reconciliation action", async () => {
  const api = recordingApi();
  registerSupervision(api.pi);
  api.sessionStart(ctx);
  world.wisps = null;
  await api.deliver({ id: "impl-7", status: "failed" });
  expect(api.messages.some(message => message.includes("explicitly reconcile"))).toBe(true);
  expect(api.messages.some(message => message.includes("exclusive recovery window"))).toBe(true);
 });

 test("subscribes the lifecycle channel once, inside session_start", () => {
  const api = recordingApi();
  registerSupervision(api.pi);
  expect(api.events).toEqual(["session_start"]);
  expect(api.channels).toEqual([]);

  api.sessionStart(ctx);
  api.sessionStart(ctx);
  expect(api.channels).toEqual(["task:subagent:lifecycle"]);
 });

 test("a terminal payload reaps, a malformed one is ignored", async () => {
  const api = recordingApi();
  registerSupervision(api.pi);
  api.sessionStart(ctx);

  await api.deliver({ id: "impl-7", status: "completed" });
  expect(ran.some(args => args[0] === "mol")).toBe(true);
  expect(update()).toBeUndefined();

  ran = [];
  await api.deliver({ agent: "orc-implementer" });
  await api.deliver(null);
  expect(ran).toEqual([]);
 });
});
