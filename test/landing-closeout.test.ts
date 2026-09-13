import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptanceHash } from "../src/acceptance";
import type { BdBead } from "../src/bd";
import { landingSweep, resetLanding, type LandingCapabilities } from "../src/landing";
import type { Exec, ExecResult } from "../src/tools/bot-review-probe";

const H = "a".repeat(40);
const MERGE_SHA = "f".repeat(40);
const PUSHED = "b".repeat(40);
const REPO = "o/r";
const RUN = "orc-run";
const MERGE = "orc-m1";
const FEATURE = "orc-feature";
const EPIC = "orc-epic";
const TASK = "orc-task";

function out(stdout: string, code = 0, stderr = ""): ExecResult {
 return { code, stdout, stderr };
}

interface FakeStore {
 beads: Record<string, BdBead>;
 comments: Record<string, Array<{ text: string }>>;
 writes: string[][];
 failClose: Set<string>;
 restore: () => void;
}

const caps: LandingCapabilities = {
 repo: REPO,
 base: "main",
 mode: "direct",
 auto_merge_allowed: false,
 squash_allowed: true,
 required_checks: [],
 strict: false,
 queue: false,
 probed_at: "2026-01-01T00:00:00.000Z",
};

function pr(): Record<string, unknown> {
 return {
  number: 7,
  state: "MERGED",
  isDraft: false,
  headRefOid: H,
  headRefName: "feat",
  baseRefName: "main",
  mergeStateStatus: "CLEAN",
  autoMergeRequest: null,
  statusCheckRollup: [],
  mergeCommit: { oid: MERGE_SHA },
 };
}

function merge(origin = FEATURE, metadata: Record<string, unknown> = {}): BdBead {
 return {
  id: MERGE,
  status: "open",
  labels: ["pr:merge"],
  metadata: { repo: REPO, pr: 7, head_sha: H, branch: "feat", origin_bead: origin, role: "shepherd", ...metadata },
 };
}

function feature(): BdBead {
 return { id: FEATURE, status: "open", issue_type: "feature", parent: EPIC, labels: ["orc-node"], metadata: { role: "architect", branch: "feat" } };
}

function task(overrides: Record<string, unknown> = {}): BdBead {
 return {
  id: TASK,
  status: "open",
  issue_type: "task",
  parent: FEATURE,
  labels: ["orc-node"],
  acceptance_criteria: "1. x",
  metadata: { role: "implementer", pushed_sha: PUSHED, ...overrides },
 };
}

function epic(): BdBead {
 return { id: EPIC, status: "open", issue_type: "epic", metadata: {} };
}

function fakeBd(beads: Record<string, BdBead>, comments: Record<string, Array<{ text: string }>> = {}): FakeStore {
 const store: FakeStore = { beads, comments, writes: [], failClose: new Set(), restore: () => { } };
 const spawn = spyOn(Bun, "spawn").mockImplementation(((argv: string[]) => {
  const args = argv.slice(1);
  let payload: unknown;
  let text = "";
  let code = 0;
  switch (args[0]) {
   case "list":
    if (args.includes("pr:merge")) payload = Object.values(store.beads).filter(bead => bead.labels?.includes("pr:merge") && bead.status !== "closed");
    else payload = Object.values(store.beads);
    break;
   case "blocked":
    payload = [];
    break;
   case "show":
    payload = store.beads[args[1]!] === undefined ? undefined : [store.beads[args[1]!]!];
    if (payload === undefined) code = 1;
    break;
   case "comments":
    payload = store.comments[args[1]!] ?? [];
    break;
   case "update": {
    store.writes.push(args);
    const bead = store.beads[args[1]!];
    const metadataFlag = args.indexOf("--metadata");
    if (bead !== undefined && metadataFlag !== -1) bead.metadata = { ...bead.metadata, ...(JSON.parse(args[metadataFlag + 1]!) as Record<string, unknown>) };
    const statusFlag = args.indexOf("--status");
    if (bead !== undefined && statusFlag !== -1) bead.status = args[statusFlag + 1];
    break;
   }
   case "comment": {
    store.writes.push(args);
    (store.comments[args[1]!] ??= []).push({ text: args[2]! });
    break;
   }
   case "close": {
    store.writes.push(args);
    if (!store.failClose.has(args[1]!)) store.beads[args[1]!]!.status = "closed";
    break;
   }
   case "create": {
    store.writes.push(args);
    const metadataFlag = args.indexOf("--metadata");
    const id = `orc-wisp-${Object.keys(store.beads).length}`;
    store.beads[id] = { id, status: "open", issue_type: "task", parent: args[args.indexOf("--parent") + 1], metadata: JSON.parse(args[metadataFlag + 1]!) as Record<string, unknown>, labels: ["orc-node"] };
    text = `${id}\n`;
    break;
   }
   default:
    code = 1;
  }
  return { stdout: new Response(text || (payload === undefined ? "" : JSON.stringify(payload))).body, stderr: new Response("").body, exited: Promise.resolve(code), kill: () => { } } as unknown as Bun.Subprocess;
 }) as unknown as typeof Bun.spawn);
 store.restore = () => spawn.mockRestore();
 return store;
}

function execTranscript(): { exec: Exec; calls: string[][] } {
 const calls: string[][] = [];
 const exec: Exec = async (argv) => {
  calls.push(argv);
  if (argv[0] === "gh" && argv[1] === "pr" && argv[2] === "list") return out("[]");
  if (argv[0] === "gh" && argv[1] === "pr" && argv[2] === "view") return out(JSON.stringify(pr()));
  if (argv[0] === "git" && argv[1] === "remote") return out("git@github.com:o/r.git\n");
		if (argv[0] === "git" && argv[1] === "clone") return out("");
		if (argv[0] === "git" && argv[1] === "fetch") {
			// Both refs are fetched into named refs; a FETCH_HEAD comparison would be a bug.
			expect(argv).toEqual(["git", "fetch", "--quiet", "git@github.com:o/r.git", `+refs/pull/${pr().number}/head:refs/orc/pr/${pr().number}`, expect.stringMatching(/^\+refs\/heads\/omp\/task\/.+:refs\/orc\/task\/.+$/)]);
			return out("");
		}
		if (argv[0] === "git" && argv[1] === "rev-parse") return out(`${H}\n`);
		if (argv[0] === "git" && argv[1] === "cherry") {
			expect(argv.slice(2)).toEqual([H, PUSHED]);
			return out(`- ${PUSHED}\n`);
		}
  return out("", 1, `unexpected ${argv.join(" ")}`);
 };
 return { exec, calls };
}

let cwd: string;
let store: FakeStore | undefined;

beforeEach(async () => {
 cwd = await mkdtemp(join(tmpdir(), "orc-landing-closeout-"));
 resetLanding();
});

afterEach(async () => {
 store?.restore();
 store = undefined;
 await rm(cwd, { recursive: true, force: true });
});

function run(beads: Record<string, BdBead>, comments: Record<string, Array<{ text: string }>> = {}) {
 store = fakeBd({ [RUN]: { id: RUN, status: "open", issue_type: "epic", metadata: { landing: caps } }, ...beads }, comments);
 const transcript = execTranscript();
 const sweep = () => landingSweep({ cwd, runId: RUN, exec: transcript.exec, now: () => Date.UTC(2026, 0, 1) });
 return { sweep, calls: transcript.calls, store };
}

function commentsOn(id: string): string[] {
 return (store?.comments[id] ?? []).map(comment => comment.text);
}

describe("landing close-out", () => {
 test("read-back failure is repaired on the next pass and landed-open is not skipped", async () => {
  const r = run({ [MERGE]: merge(EPIC), [EPIC]: epic() });
  r.store.failClose.add(MERGE);
  expect(await r.sweep()).toEqual([{ bead: MERGE, pr: 7, outcome: "merged" }]);
  r.store.failClose.delete(MERGE);
  expect(await r.sweep()).toEqual([{ bead: MERGE, pr: 7, outcome: "repaired" }]);
  expect(r.store.beads[MERGE]?.status).toBe("closed");
 });

 test("covered node closes with LANDED evidence and merged reason", async () => {
  const hash = acceptanceHash("1. x");
  const r = run({ [MERGE]: merge(), [FEATURE]: feature(), [EPIC]: epic(), [TASK]: task() }, {
   [FEATURE]: [{ text: `REVIEW feature verdict=approve head_sha=${H} nodes=${TASK}:${hash}:met` }],
  });
  await r.sweep();
  expect(r.store.beads[TASK]?.status).toBe("closed");
  expect(r.store.beads[FEATURE]?.status).toBe("closed");
  expect(commentsOn(FEATURE)).toContain(`LANDED ${MERGE_SHA} merge=${MERGE}`);
  expect(r.store.writes).toContainEqual(["close", FEATURE, "--reason", "merged"]);
  expect(r.store.writes).toContainEqual(["close", TASK, "--reason", "merged"]);
 });

 test("contained but uncovered node gets one NOTE and stays open", async () => {
  const r = run({ [MERGE]: merge(), [FEATURE]: feature(), [EPIC]: epic(), [TASK]: task() });
  await r.sweep();
  expect(r.store.beads[TASK]?.status).toBe("open");
  expect(commentsOn(TASK)).toEqual([`NOTE landed uncovered: merge=${MERGE} head=${H}`]);
 });

 test("stale nodes hash is uncovered", async () => {
  const r = run({ [MERGE]: merge(), [FEATURE]: feature(), [EPIC]: epic(), [TASK]: task() }, {
   [FEATURE]: [{ text: `REVIEW feature verdict=approve head_sha=${H} nodes=${TASK}:000000000000:met` }],
  });
  await r.sweep();
  expect(r.store.beads[TASK]?.status).toBe("open");
  expect(commentsOn(TASK)).toContain(`NOTE landed uncovered: merge=${MERGE} head=${H}`);
 });

 test("override approval at the live hash closes the node", async () => {
  const hash = acceptanceHash("1. x");
  const r = run({ [MERGE]: merge(), [FEATURE]: feature(), [EPIC]: epic(), [TASK]: task() }, {
   [TASK]: [{ text: "NOTE override requested: accept the landed patch" }, { text: `REVIEW ${TASK} dimension=override verdict=approve override=${hash}` }],
  });
  await r.sweep();
  expect(r.store.beads[TASK]?.status).toBe("closed");
  expect(r.store.writes).toContainEqual(["close", TASK, "--reason", "merged"]);
 });

 test("feature closes only when all children are closed", async () => {
  const hash = acceptanceHash("1. x");
  const second = "orc-task-2";
  const r = run({ [MERGE]: merge(), [FEATURE]: feature(), [EPIC]: epic(), [TASK]: task(), [second]: { ...task(), id: second } }, {
   [FEATURE]: [{ text: `REVIEW feature verdict=approve head_sha=${H} nodes=${TASK}:${hash}:met` }],
  });
  await r.sweep();
  expect(r.store.beads[FEATURE]?.status).toBe("open");
  expect(r.store.writes.filter(args => args[0] === "close" && args[1] === FEATURE)).toEqual([]);
 });

 test("an epic origin is never closed", async () => {
  const r = run({ [MERGE]: merge(EPIC), [EPIC]: epic() });
  await r.sweep();
  expect(r.store.writes.filter(args => args[0] === "close" && args[1] === EPIC)).toEqual([]);
 });
});
