import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { markerPath, readActiveRun } from "../src/run-state";
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
 spyOn(realBd, "bdWispListChecked").mockImplementation(async (): Promise<BdBead[] | null> => {
  ran.push(["mol", "wisp", "list", "--json"]);
  return world.wisps;
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

/** Epoch seconds a test treats as "the child started"; captures at or after it are fresh. */
const STARTED_AT_S = 1_700_000_000;

/** `reapChild` options for a child that started at {@link STARTED_AT_S}. */
function at(exec: Exec): { cwd: string; exec: Exec; startedAtMs: number } {
 return { cwd: "/repo", exec, startedAtMs: STARTED_AT_S * 1000 };
}

/**
 * A git seam that answers `for-each-ref` with `branches`, each tip committed at
 * `committedAt` (epoch seconds), and nothing else.
 */
function gitWith(branches: string[], committedAt = STARTED_AT_S + 60): Exec {
 return async (argv: string[]): Promise<ExecResult | null> => {
  if (argv[1] === "for-each-ref") {
   return { code: 0, stdout: branches.map(name => `refs/heads/${name}\t${committedAt}\n`).join(""), stderr: "" };
  }
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
  const outcome = await reapChild({ id: "shepherd-1", status: "completed" }, at(gitWith([])));
  expect(outcome.reaped).toEqual([{ bead: "orc-1", case: "clean", failures: [], recovery: "not-needed" }]);
  expect(approved.labels).toContain("state:approved");
  expect(approved.assignee).toBe("");
  expect(update()).toBeUndefined();
  expect(comment()).toBeUndefined();
 });

 test("a successor claiming during git discovery is never overwritten", async () => {
  const current = bead({ assignee: "impl-7" });
  world.claimed = [{ ...current }];
  const outcome = await reapChild({ id: "impl-7", status: "failed" }, at(async () => {
   current.assignee = "successor";
   current.status = "closed";
   return { code: 0, stdout: `refs/heads/omp/task/impl-7\t${STARTED_AT_S + 60}`, stderr: "" };
  }));
  expect(current.assignee).toBe("successor");
  expect(current.status).toBe("closed");
  expect(update()).toBeUndefined();
  expect(outcome.reaped[0]?.recovery).toBe("recorded");
  expect(comment()).toContain("exclusive recovery window");
 });

 test("unreadable completion evidence is unknown, never missing", async () => {
  world.stamped = [bead({ status: "open", assignee: null })];
  world.comments["orc-1"] = null;
  const result = await reapChild({ id: "impl-7", status: "completed" }, at(gitWith([])));
  expect(result.reaped[0]).toMatchObject({ case: "unknown", failures: [], recovery: "recorded" });
  expect(update()).toBeUndefined();
 });

 test.each([null, { code: 1, stdout: "", stderr: "git failed" }])("git failure is not evidence of no work", async result => {
  world.claimed = [bead({ assignee: "impl-7" })];
  const outcome = await reapChild({ id: "impl-7", status: "failed" }, at(async () => result));
  expect(outcome.branchState).toBe("unknown");
  expect(outcome.reaped[0]?.case).toBe("died");
  expect(comment()).toContain("captured branch unknown");
  expect(update()).toBeUndefined();
 });

 test("positive absence and positive branch evidence remain distinct", async () => {
  world.claimed = [bead({ assignee: "impl-7" })];
  const absent = await reapChild({ id: "impl-7", status: "aborted" }, at(gitWith([])));
  const found = await reapChild({ id: "impl-7", status: "aborted" }, at(gitWith(["omp/task/impl-7"])));
  expect(absent.branchState).toBe("absent");
  expect(absent.reaped[0]?.case).toBe("died");
  expect(found.branch).toBe("omp/task/impl-7");
  expect(found.branchState).toBe("found");
  expect(found.reaped[0]?.case).toBe("died");
  expect(update()).toBeUndefined();
 });

 test("a branch whose tip predates the child is a stale leftover, not its capture", async () => {
  // OMP allocates ids per session and force-overwrites `omp/task/<id>`, so a branch
  // from run N can carry run N+1's child id until the capture replaces it.
  world.claimed = [bead({ assignee: "impl-7" })];
  const outcome = await reapChild({ id: "impl-7", status: "failed" }, at(gitWith(["omp/task/impl-7"], STARTED_AT_S - 3600)));
  expect(outcome.branchState).toBe("stale");
  expect(outcome.branch).toBeUndefined();
  expect(comment()).toContain("predates this child");
  expect(comment()).toContain("not proof of no work");
 });

 test("another child's branch with a longer id is not this child's", async () => {
  world.claimed = [bead({ assignee: "impl-7" })];
  const outcome = await reapChild({ id: "impl-7", status: "failed" }, at(gitWith(["omp/task/impl-70"])));
  expect(outcome.branchState).toBe("absent");
 });

 test("a clean completion that captured its branch needs no recovery", async () => {
  // The documented success outcome of every isolated task; a NOTE here trained the
  // architect to ignore the channel real deaths arrive on.
  world.stamped = [bead({ status: "open", labels: [], metadata: { actor: "impl-7" }, assignee: null })];
  world.comments["orc-1"] = ["REPORTED delivered"];
  const outcome = await reapChild({ id: "impl-7", status: "completed" }, at(gitWith(["omp/task/impl-7"])));
  expect(outcome.reaped).toEqual([{ bead: "orc-1", case: "clean", failures: [], recovery: "not-needed" }]);
  expect(outcome.branchState).toBe("found");
  expect(comment()).toBeUndefined();
  expect(update()).toBeUndefined();
 });

 test("failed evidence persistence never reports recovery recorded", async () => {
  world.claimed = [bead({ assignee: "impl-7" })];
  const failing = spyOn(realBd, "bdRun").mockResolvedValueOnce({ code: 1, stdout: "", stderr: "write refused" });
  const outcome = await reapChild({ id: "impl-7", status: "failed" }, at(gitWith([])));
  expect(outcome.reaped[0]?.recovery).toBe("record-failed");
  expect(update()).toBeUndefined();
  failing.mockImplementation(async args => { ran.push(args); return { code: 0, stdout: "", stderr: "" }; });
 });

 test("discovers open, blocked, deferred claims and review wisps without truncation", async () => {
  world.claimed = [bead({ id: "orc-open", status: "open", assignee: "impl-7" }), bead({ id: "orc-blocked", status: "blocked", assignee: "impl-7" })];
  world.wisps = [bead({ id: "orc-review", status: "deferred", assignee: "impl-7", ephemeral: true })];
  const outcome = await reapChild({ id: "impl-7", status: "failed" }, at(gitWith([])));
  expect(outcome.reaped.map(row => row.bead)).toEqual(["orc-open", "orc-blocked", "orc-review"]);
  expect(ran[0]).toContain("--include-infra");
  expect(ran[0]).toContain("open,in_progress,blocked,deferred");
  expect(ran[0]).toContain("--limit");
 });

 test("partial candidate lookup is reported, not an empty successful sweep", async () => {
  world.wisps = null;
  const outcome = await reapChild({ id: "impl-7", status: "failed" }, at(gitWith([])));
  expect(outcome.discoveryUnknown).toBe(true);
 });

 test("a nonterminal child and an already reassigned bead cause no writes", async () => {
  world.stamped = [bead({ assignee: "successor" })];
  await reapChild({ id: "impl-7", status: "started" }, at(gitWith([])));
  await reapChild({ id: "impl-7", status: "completed" }, at(gitWith([])));
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

/** Match the marker half of production binding without a Beads fixture. */
async function markerBound(cwd: string): Promise<boolean> {
 const marker = await readActiveRun(cwd);
 return marker !== null && marker.run_id !== "pending";
}

function contextAt(getCwd: () => string): ExtensionContext {
 return { sessionManager: { getCwd } } as unknown as ExtensionContext;
}

/** Collect what `registerSupervision` subscribes, without an OMP session. */
function recordingApi(): {
 pi: ExtensionAPI;
 /** Extension events it subscribed, in order. */
 events: string[];
 /** Bus channels it subscribed, in order. */
 channels: string[];
 messages: string[];
 errors: string[];
 sessionStart: (ctx: ExtensionContext) => void;
 sessionSwitch: (ctx: ExtensionContext) => void;
 sessionBranch: (ctx: ExtensionContext) => void;
 sessionShutdown: () => void;
 deliver: (payload: unknown) => Promise<void>;
} {
 const events: string[] = [];
 const channels: string[] = [];
 const messages: string[] = [];
 const errors: string[] = [];
 const handlers: { event: string; handler: (event: unknown, ctx: ExtensionContext) => unknown }[] = [];
 const listeners = new Set<(data: unknown) => unknown>();
 const emitSession = (event: string, ctx: ExtensionContext): void => {
  for (const entry of handlers) {
   if (entry.event === event) void entry.handler({}, ctx);
  }
 };
 const stub = {
  sendMessage: (message: { content: string }) => { messages.push(message.content); },
  on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
   events.push(event);
   handlers.push({ event, handler });
  },
  events: {
   on: (channel: string, listener: (data: unknown) => unknown) => {
    channels.push(channel);
    listeners.add(listener);
    return () => listeners.delete(listener);
   },
  },
  logger: {
   error: (message: string) => { errors.push(message); },
   debug: () => { },
   warn: () => { },
   info: () => { },
  },
 };
 return {
  pi: stub as unknown as ExtensionAPI,
  events,
  channels,
  messages,
  errors,
  sessionStart: ctx => emitSession("session_start", ctx),
  sessionSwitch: ctx => emitSession("session_switch", ctx),
  sessionBranch: ctx => emitSession("session_branch", ctx),
  sessionShutdown: () => emitSession("session_shutdown", {} as ExtensionContext),
  deliver: async payload => {
   for (const listener of listeners) await listener(payload);
  },
 };
}

describe("registerSupervision", () => {
 const ctx = contextAt(() => "/repo");
 const bound = async () => true;

 test("unbound and pending markers skip discovery and notices", async () => {
  const noRun = await mkdtemp(join(tmpdir(), "orc-supervision-no-run-"));
  const pending = await mkdtemp(join(tmpdir(), "orc-supervision-pending-"));
  try {
   await mkdir(join(pending, ".orchestration"));
   await writeFile(markerPath(pending), JSON.stringify({ schema_version: 1, run_id: "pending" }));
   const api = recordingApi();
   registerSupervision(api.pi, markerBound);

   api.sessionStart(contextAt(() => noRun));
   await api.deliver({ id: "impl-7", status: "failed" });
   api.sessionSwitch(contextAt(() => pending));
   await api.deliver({ id: "impl-7", status: "failed" });

   expect(ran).toEqual([]);
   expect(api.messages).toEqual([]);
  } finally {
   await Promise.all([rm(noRun, { recursive: true, force: true }), rm(pending, { recursive: true, force: true })]);
  }
 });

 test("binding after session start activates subsequent terminal events", async () => {
  let boundNow = false;
  const api = recordingApi();
  registerSupervision(api.pi, async () => boundNow);
  api.sessionStart(ctx);

  await api.deliver({ id: "impl-7", status: "failed" });
  expect(ran).toEqual([]);
  expect(api.messages).toEqual([]);

  boundNow = true;
  world.wisps = null;
  await api.deliver({ id: "impl-7", status: "failed" });
  expect(ran.some(args => args[0] === "mol")).toBe(true);
  expect(api.messages.some(message => message.includes("explicitly reconcile"))).toBe(true);
 });

 test("reads live cwd and follows session switch and branch contexts", async () => {
  const oldCwd = "/bound-repository";
  const movedCwd = "/moved-repository";
  const switchedCwd = "/switched-repository";
  const branchedCwd = "/branched-repository";
  let currentCwd = oldCwd;
  const checked: string[] = [];
  const api = recordingApi();
  registerSupervision(api.pi, async cwd => {
   checked.push(cwd);
   return cwd === oldCwd;
  });
  api.sessionStart(contextAt(() => currentCwd));
  await api.deliver({ id: "impl-7", status: "failed" });
  expect(ran.length).toBeGreaterThan(0);

  ran = [];
  currentCwd = movedCwd;
  await api.deliver({ id: "impl-7", status: "failed" });
  api.sessionSwitch(contextAt(() => switchedCwd));
  await api.deliver({ id: "impl-7", status: "failed" });
  api.sessionBranch(contextAt(() => branchedCwd));
  await api.deliver({ id: "impl-7", status: "failed" });
  expect(checked).toEqual([oldCwd, movedCwd, switchedCwd, branchedCwd]);
  expect(ran).toEqual([]);
  expect(api.messages).toEqual([]);
 });

 test("an unavailable liveness check alleges no recovery but tells the architect", async () => {
  const api = recordingApi();
  registerSupervision(api.pi, async () => {
   throw new Error("run liveness unavailable: bound run orc-1 status could not be verified");
  });
  api.sessionStart(ctx);
  await api.deliver({ id: "impl-7", status: "failed" });
  expect(ran).toEqual([]);
  expect(api.errors).toEqual(["orchestrate run liveness check unavailable; recovery skipped"]);
  // The same outage as a failed reap gets the same notice; a log line alone left
  // the child's claims held with nobody told.
  expect(api.messages).toHaveLength(1);
  expect(api.messages[0]).toContain("impl-7");
  expect(api.messages[0]).toContain("bound run orc-1 status could not be verified");
  expect(api.messages[0]).toContain("explicitly reconcile");
 });

 test("a revived child's repeat terminal frame is not reaped again", async () => {
  // Every follow-up turn of a parked agent ends in the same terminal frame as a
  // first run; the architect holding its epic mid-run would otherwise collect a
  // NOTE and a notice on every wake.
  const api = recordingApi();
  registerSupervision(api.pi, bound);
  api.sessionStart(ctx);
  world.claimed = [bead({ id: "orc-epic", assignee: "arch-1" })];
  await api.deliver({ id: "arch-1", status: "completed" });
  await api.deliver({ id: "arch-1", status: "completed" });
  await api.deliver({ id: "arch-1", status: "failed" });
  expect(ran.filter(args => args[0] === "comment")).toHaveLength(1);
  expect(api.messages.filter(message => message.includes("orc-epic"))).toHaveLength(1);
 });

 test("a child that had nothing to reap is still reaped when it later dies holding work", async () => {
  const api = recordingApi();
  registerSupervision(api.pi, bound);
  api.sessionStart(ctx);
  await api.deliver({ id: "helper-1", status: "completed" });
  expect(ran.filter(args => args[0] === "comment")).toEqual([]);
  world.claimed = [bead({ id: "orc-late", assignee: "helper-1" })];
  await api.deliver({ id: "helper-1", status: "failed" });
  expect(ran.filter(args => args[0] === "comment")).toHaveLength(1);
 });

 test("a branch captured before this session saw the child start is stale", async () => {
  const api = recordingApi();
  registerSupervision(api.pi, bound);
  api.sessionStart(ctx);
  world.claimed = [bead({ assignee: "impl-7" })];
  const branchAt = (seconds: number) => `refs/heads/omp/task/impl-7\t${seconds}`;
  const oldTip = Math.floor(Date.now() / 1000) - 3600;
  const spawn = spyOn(Bun, "spawn").mockImplementation(() => ({
   stdout: new Response(`${branchAt(oldTip)}\n`).body,
   stderr: new Response("").body,
   exited: Promise.resolve(0),
   kill: () => { },
  }) as unknown as Bun.Subprocess);
  try {
   await api.deliver({ id: "impl-7", status: "started" });
   await api.deliver({ id: "impl-7", status: "failed" });
  } finally {
   spawn.mockRestore();
  }
  expect(api.messages[0]).toContain("branch: stale");
  expect(comment()).toContain("predates this child");
 });

 test("unread candidate discovery notifies the spawning session with a reconciliation action", async () => {
  const api = recordingApi();
  registerSupervision(api.pi, bound);
  api.sessionStart(ctx);
  world.wisps = null;
  await api.deliver({ id: "impl-7", status: "failed" });
  expect(api.messages.some(message => message.includes("explicitly reconcile"))).toBe(true);
  expect(api.messages.some(message => message.includes("exclusive recovery window"))).toBe(true);
 });

 test("subscribes the lifecycle channel once, inside session_start", () => {
  const api = recordingApi();
  registerSupervision(api.pi, bound);
  expect(api.events).toEqual(["session_start", "session_switch", "session_branch", "session_shutdown"]);
  expect(api.channels).toEqual([]);

  api.sessionStart(ctx);
  api.sessionStart(ctx);
  expect(api.channels).toEqual(["task:subagent:lifecycle"]);
 });

 test("disposes the lifecycle subscription on shutdown", async () => {
  const api = recordingApi();
  registerSupervision(api.pi, bound);
  api.sessionStart(ctx);
  api.sessionShutdown();
  await api.deliver({ id: "impl-7", status: "failed" });
  expect(ran).toEqual([]);

  api.sessionStart(ctx);
  await api.deliver({ id: "impl-7", status: "failed" });
  expect(ran.filter(args => args[0] === "mol")).toHaveLength(1);
  expect(api.channels).toEqual(["task:subagent:lifecycle", "task:subagent:lifecycle"]);
 });

 test("a completed generic helper with empty candidate lists remains quiet", async () => {
  const api = recordingApi();
  registerSupervision(api.pi, bound);
  api.sessionStart(ctx);

  await api.deliver({ id: "impl-7", status: "completed" });
  expect(ran.some(args => args[0] === "mol")).toBe(true);
  expect(update()).toBeUndefined();
  expect(api.messages).toEqual([]);

  ran = [];
  await api.deliver({ agent: "orc-implementer" });
  await api.deliver(null);
  expect(ran).toEqual([]);
 });
});
