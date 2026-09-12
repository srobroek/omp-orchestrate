/**
 * G5 — claim eligibility.
 *
 * The gate is exercised against the real tokeniser, the real role resolution, and the
 * real scope-overlap arithmetic, with only `../src/bd` replaced: what matters is which
 * command lines it refuses, and every input it decides on arrives as a shell string.
 *
 * `bdShow` and `bdShowMany` calls are recorded rather than counted, so the `ready --claim`
 * shortcut can be asserted as "no bead was looked up" instead of as a call total.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { logger } from "@oh-my-pi/pi-utils";
import type { BdBead, BdFailure } from "../src/bd";
import * as actualBd from "../src/bd";
import { createClaimState } from "../src/claim-state";
import { gateClaimEligibility } from "../src/gates/claim";
import { markerPath } from "../src/run-state";

/** Beads `bdShow` and `bdShowMany` resolve, by id. A missing key models an unreadable bead. */
let beads: Record<string, BdBead>;
let claims = createClaimState();
/** What `bd list --label orc-node --status in_progress` reports. */
let inFlight: BdBead[];
let shown: string[];
let listed: string[][];

// Restore the original exports rather than installing another process-wide module
// mock: later suites (notably watchers) must reach the real bd subprocess.
const showSpy = spyOn(actualBd, "bdShow").mockImplementation(async (id: string) => {
 shown.push(id);
 return beads[id] ?? null;
});
/** Lineage reads arrive here in batches; each id is recorded, and an unreadable one is left out of the map. */
const showManySpy = spyOn(actualBd, "bdShowMany").mockImplementation(async (ids: readonly string[]) => {
 const found = new Map<string, BdBead>();
 for (const id of ids) {
  shown.push(id);
  const bead = beads[id];
  if (bead !== undefined) found.set(id, bead);
 }
 return found;
});
const listSpy = spyOn(actualBd, "bdList").mockImplementation(async (args: string[]) => {
 listed.push(args);
 return inFlight;
});
/** `logger.warn` calls, so every fail-open verdict can be asserted to have named its cause. */
let warned: { message: string; data?: Record<string, unknown> }[] = [];
const warnSpy = spyOn(logger, "warn").mockImplementation(((message: string, data?: Record<string, unknown>) => {
 warned.push({ message, data });
}) as typeof logger.warn);

afterAll(() => {
 showSpy.mockRestore();
 showManySpy.mockRestore();
 listSpy.mockRestore();
 warnSpy.mockRestore();
});

/** A checkout under a bound run: its marker names `orc-run`. */
let runRoot: string;
/** A checkout under no run at all. */
let plainRoot: string;
let priorPin: string | undefined;
let priorMarkerOverride: string | undefined;

beforeAll(async () => {
 runRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "orc-g5-run-")));
 plainRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "orc-g5-plain-")));
 await fs.mkdir(path.dirname(markerPath(runRoot)), { recursive: true });
 await fs.writeFile(markerPath(runRoot), JSON.stringify({ schema_version: 1, run_id: "orc-run" }));
 priorPin = process.env.BEADS_DIR;
 priorMarkerOverride = process.env.ORCHESTRATE_MARKER_FILE;
});

afterAll(async () => {
 if (priorPin === undefined) delete process.env.BEADS_DIR;
 else process.env.BEADS_DIR = priorPin;
 if (priorMarkerOverride === undefined) delete process.env.ORCHESTRATE_MARKER_FILE;
 else process.env.ORCHESTRATE_MARKER_FILE = priorMarkerOverride;
 await fs.rm(runRoot, { recursive: true, force: true });
 await fs.rm(plainRoot, { recursive: true, force: true });
});

/** A session declaring `role`, or declaring none when `role` is undefined, sitting at `cwd`. */
function ctxFor(role?: string, cwd?: string): ExtensionContext {
 const prompt = role === undefined ? "a helper with no contract" : `ORC-ROLE: ${role}`;
 return { cwd, getSystemPrompt: () => [prompt] } as unknown as ExtensionContext;
}

function bead(id: string, overrides: Partial<BdBead> = {}): BdBead {
 return { id, status: "open", ...overrides };
}

beforeEach(() => {
 beads = {};
 inFlight = [];
 shown = [];
 listed = [];
 warned = [];
 claims = createClaimState();
 // Every case states its own run scope; the ambient shell's pin must not supply one.
 delete process.env.BEADS_DIR;
 delete process.env.ORCHESTRATE_MARKER_FILE;
});

/** Run `body` with the process pinned to the run checkout's database, as an active run pins it. */
async function pinned<T>(body: () => Promise<T>): Promise<T> {
 process.env.BEADS_DIR = path.join(runRoot, ".beads");
 try {
  return await body();
 } finally {
  delete process.env.BEADS_DIR;
 }
}



describe("G5 acquisition lifecycle", () => {
 test("explicit async claims are refused without blocking ordinary async reads", async () => {
  expect((await gateClaimEligibility(claims, ctxFor("implementer"), {
   command: "bd ready --claim --json", async: true,
  }))?.block).toBe(true);
  expect(await gateClaimEligibility(claims, ctxFor("implementer"), {
   command: "bd show orc-1 --json", async: true,
  })).toBeUndefined();
 });
 test("a live claim blocks a second named claim and queue acquisition but permits a same-bead retry", async () => {
  claims.recordClaim({ actor: "impl-1", beadIds: ["orc-1"] });
  beads["orc-1"] = bead("orc-1", { status: "in_progress", assignee: "impl-1" });
  expect((await gateClaimEligibility(claims, ctxFor("implementer"), { command: "bd update orc-2 --claim" }))?.block).toBe(true);
  expect((await gateClaimEligibility(claims, ctxFor("implementer"), { command: "bd ready --claim --json" }))?.block).toBe(true);
  expect(await gateClaimEligibility(claims, ctxFor("implementer"), { command: "bd update orc-1 --claim" })).toBeUndefined();
  expect(claims.observedClaim()?.beadIds).toEqual(["orc-1"]);
 });

 test("an unreadable previous owner lets the new claim through, forgets the stale claim, and names the cause", async () => {
  // Unknown is not held. The old refusal ("Cannot verify release") sent a worker whose
  // store had hiccuped to refresh ownership it had already released.
  claims.recordClaim({ actor: "impl-1", beadIds: ["orc-1"] });
  const failure = spyOn(actualBd, "lastBdFailure").mockReturnValue("timeout");
  try {
   expect(await gateClaimEligibility(claims, ctxFor("implementer"), { command: "bd update orc-2 --claim" })).toBeUndefined();
  } finally {
   failure.mockRestore();
  }
  expect(claims.observedClaim()).toBeUndefined();
  expect(warned.map(entry => [entry.data?.bead, entry.data?.cause])).toEqual([["orc-1", "the beads database did not answer in time; retry"]]);

  claims.recordClaim({ actor: "impl-1", beadIds: ["orc-1"] });
  beads["orc-1"] = { id: "orc-1" };
  expect(await gateClaimEligibility(claims, ctxFor("implementer"), { command: "bd update orc-2 --claim" })).toBeUndefined();
  expect(warned.at(-1)?.data?.cause).toBe("its status is unreadable");
 });

 test("a same-bead retry keeps the claim while its bead cannot be read", async () => {
  // The retry is the recovery of this very bead; forgetting it would disarm G2 for it.
  claims.recordClaim({ actor: "impl-1", beadIds: ["orc-1"] });
  expect(await gateClaimEligibility(claims, ctxFor("implementer"), { command: "bd update orc-1 --claim" })).toBeUndefined();
  expect(claims.observedClaim()?.beadIds).toEqual(["orc-1"]);
  expect(warned).toEqual([]);
 });

 test.each([
  ["bare", "bd update orc-1 orc-2 --claim"],
  ["--claim ahead of the ids", "bd update --claim orc-1 orc-2"],
  ["behind a database pin", "bd -C /repo update orc-1 orc-2 --claim"],
  ["inside a wrapper shell", "sh -c 'bd update orc-1 orc-2 --claim'"],
  ["with a real second id after a flag's value", "bd update orc-1 orc-2 --claim --parent orc-3"],
 ])("refuses a claim naming two beads, %s, and names them", async (_label, command) => {
  const result = await gateClaimEligibility(claims, ctxFor("implementer"), { command });

  expect(result?.block).toBe(true);
  expect(result?.reason).toContain("2 beads");
  expect(result?.reason).toContain("orc-1");
  expect(result?.reason).toContain("orc-2");
  expect(result?.reason).toContain("one bead");
  expect(shown).toEqual([]);
 });

 test("counts ids with nonnumeric, hyphenated suffixes", async () => {
  const result = await gateClaimEligibility(claims, ctxFor("implementer"), { command: "bd update orc-chaos-c1-6gq orc-chaos-c2-sbv --claim" });
  expect(result?.reason).toContain("orc-chaos-c2-sbv");
 });

 test("a claim naming no bead is refused with the spelling that names one", async () => {
  const result = await gateClaimEligibility(claims, ctxFor("implementer"), { command: "bd update --claim" });
  expect(result?.block).toBe(true);
  expect(result?.reason).toContain("exactly one bead");
 });

 test.each([
  ["--parent", "bd update orc-1 --claim --parent orc-2"],
  ["--assignee", "bd update orc-1 --claim --assignee orc-impl-1"],
  ["--reason", "bd update orc-1 --claim --reason build-failed"],
  ["--set-metadata", "bd update orc-1 --claim --set-metadata worktree=/tmp/wt-1"],
  ["the same id twice, which --claim treats as idempotent", "bd update orc-1 orc-1 --claim"],
 ])("does not mistake %s for a second bead", async (_label, command) => {
  expect(await gateClaimEligibility(claims, ctxFor("implementer"), { command })).toBeUndefined();
 });

 test.each([
  "bd ready --claim --json",
  "bd ready --parent orc-epic --claim --json",
  "bd ready --parent orc-epic --unassigned --claim --json",
  "bd ready --include-ephemeral --claim --json",
 ])("a role-marked session must name its queue: %s", async command => {
  // Beads hands an unfiltered pull the first ready bead of any role, and nothing
  // downstream compares that bead's routing to the session, so the filter is the only
  // place cross-role pulls are stopped.
  const result = await gateClaimEligibility(claims, ctxFor("implementer"), { command });
  expect(result?.block).toBe(true);
  expect(result?.reason).toContain("queue pull must name your role");
  expect(result?.reason).toContain("role=implementer");
  expect(shown).toEqual([]);
 });

 test.each([
  ["implementer", "bd ready --parent orc-epic --metadata-field role=implementer --unassigned --claim --json"],
  ["implementer", "bd ready --metadata-field=role=implementer --claim --json"],
  ["reviewer", "bd ready --include-ephemeral --parent orc-epic --metadata-field role=reviewer --unassigned --claim --json"],
  ["shepherd", "bd ready --metadata-field role=shepherd --unassigned --claim --json"],
  // The legacy label carrier still pins a queue, through the alias table.
  ["shepherd", "bd ready --label agent:integrator --unassigned --claim --json"],
  ["implementer", "bd ready --label agent:implementer --claim --json"],
 ])("%s pulling its own named queue is allowed: %s", async (role, command) => {
  expect(await gateClaimEligibility(claims, ctxFor(role), { command })).toBeUndefined();
  expect(shown).toEqual([]);
 });

 test("verified release permits the next claim without mutating Beads", async () => {
  claims.recordClaim({ actor: "impl-1", beadIds: ["orc-1"] });
  beads["orc-1"] = bead("orc-1", { status: "open", assignee: "" });
  expect(await gateClaimEligibility(claims, ctxFor("implementer"), { command: "bd update orc-2 --claim" })).toBeUndefined();
  expect(claims.observedClaim()).toBeUndefined();
  claims.recordClaim({ actor: "impl-1", beadIds: ["orc-2"] });
  expect(claims.observedClaim()?.beadIds).toEqual(["orc-2"]);
 });

 test("separate claiming leaves and option-interleaved targets are refused", async () => {
  for (const command of [
   "bd update orc-1 --claim; bd update orc-2 --claim",
   "bd update orc-1 --json orc-2 --claim",
   "bd update orc-1 --parent orc-parent orc-2 --claim",
  ]) {
   expect((await gateClaimEligibility(claims, ctxFor("implementer"), { command }))?.block).toBe(true);
  }
  expect(await gateClaimEligibility(claims, ctxFor("implementer"), {
   command: "bd update orc-1 --parent orc-parent --claim",
  })).toBeUndefined();
 });
});

describe("G5 role routing", () => {
 test("routing writes after newlines and comments are refused", async () => {
  const result = await gateClaimEligibility(claims, ctxFor("implementer"), {
   command: "printf ready\n# explanation\nbd update orc-1 --set-metadata role=reviewer",
  });
  expect(result?.block).toBe(true);
 });
 test("refuses a reviewer claiming an implementer bead, naming both roles", async () => {
  beads["orc-7"] = bead("orc-7", { labels: ["orc-node", "agent:implementer"] });

  const result = await gateClaimEligibility(claims, ctxFor("reviewer"), {
   command: "BEADS_ACTOR=orc-rev-1 bd update orc-7 --claim",
  });

  expect(result?.block).toBe(true);
  expect(result?.reason).toContain("orc-7");
  expect(result?.reason).toContain("agent:implementer");
  expect(result?.reason).toContain("reviewer");
  // A refused claim is not recorded: the session holds nothing.
  expect(claims.observedClaim()).toBeUndefined();
 });

 test("allows a claim of a bead routed to this session's own role", async () => {
  beads["orc-7"] = bead("orc-7", { labels: ["agent:reviewer"] });

  expect(
   await gateClaimEligibility(claims, ctxFor("reviewer"), { command: "BEADS_ACTOR=orc-rev-1 bd update orc-7 --claim" }),
  ).toBeUndefined();
 });

 test("refuses a ready --claim against another role's queue without any lookup", async () => {
  const result = await gateClaimEligibility(claims, ctxFor("reviewer"), {
   command: "bd ready --label agent:implementer --unassigned --claim --json",
  });

  expect(result?.block).toBe(true);
  expect(result?.reason).toContain("agent:implementer");
  expect(result?.reason).toContain("reviewer");
  expect(shown).toEqual([]);
 });

 test.each(["--label", "-l", "--label-any"])(
  "allows a ready --claim on this session's own queue via %s with no bead lookup",
  async flag => {
   const result = await gateClaimEligibility(claims, ctxFor("implementer"), {
    command: `BEADS_ACTOR=orc-impl-1 bd ready ${flag} agent:implementer --unassigned --claim --json`,
   });

   expect(result).toBeUndefined();
   // The queue filter already pins the role, so beads never has to answer.
   expect(shown).toEqual([]);
   expect(claims.observedClaim()).toBeUndefined();
  },
 );
});

describe("G5 fail-open", () => {
 test("a bead carrying no routing carrier is claimable by any role", async () => {
  // Neither a `metadata.role` stamp nor a legacy `agent:<role>` label, so the bead
  // routes to nobody, and a bead routed to nobody must not be unclaimable.
  beads["orc-9"] = bead("orc-9", { labels: ["orc-node", "kind:incidental"] });

  expect(
   await gateClaimEligibility(claims, ctxFor("reviewer"), { command: "BEADS_ACTOR=orc-rev-1 bd update orc-9 --claim" }),
  ).toBeUndefined();
 });

 test("a legacy agent:integrator bead now routes to the shepherd", async () => {
  // It used to route to nobody, which meant any role could claim a merge bead named
  // by id. Resolving it is a hole closed, not fail-open behaviour lost.
  beads["orc-9"] = bead("orc-9", { labels: ["orc-node", "agent:integrator"] });

  const result = await gateClaimEligibility(claims, ctxFor("reviewer"), {
   command: "BEADS_ACTOR=orc-rev-1 bd update orc-9 --claim",
  });

  expect(result?.block).toBe(true);
  expect(result?.reason).toContain("agent:integrator");
  expect(
   await gateClaimEligibility(claims, ctxFor("shepherd"), { command: "BEADS_ACTOR=orc-shep-1 bd update orc-9 --claim" }),
  ).toBeUndefined();
 });

 test("an unreadable bead allows the claim, and records nothing", async () => {
  expect(
   await gateClaimEligibility(claims, ctxFor("reviewer"), { command: "BEADS_ACTOR=orc-rev-1 bd update ghost-1 --claim" }),
  ).toBeUndefined();
  expect(shown).toEqual(["ghost-1"]);
  // It used to record here, reasoning that the worktree gate needed the observation
  // even from a claim it could not evaluate. That recorded a bead the call had not
  // yet acquired. The claim report arms G2 now, so a failing claim arms nothing.
  expect(claims.observedClaim()).toBeUndefined();
 });

 test("a session declaring no role is not evaluated against routing", async () => {
  beads["orc-7"] = bead("orc-7", { labels: ["agent:implementer"] });

  expect(
   await gateClaimEligibility(claims, ctxFor(), { command: "BEADS_ACTOR=helper-1 bd update orc-7 --claim" }),
  ).toBeUndefined();
 });

 test("a role-less session may pull from any queue", async () => {
  expect(
   await gateClaimEligibility(claims, ctxFor(), { command: "bd ready --label agent:implementer --claim --json" }),
  ).toBeUndefined();
 });

 test("a role-less session may pull without naming a queue", async () => {
  expect(await gateClaimEligibility(claims, ctxFor(), { command: "bd ready --claim --json" })).toBeUndefined();
 });

 test("ignores a command with no bd --claim in it", async () => {
  for (const command of ["bd show orc-7 --json", "git status", "", "bd update orc-7 --status closed"]) {
   expect(await gateClaimEligibility(claims, ctxFor("reviewer"), { command })).toBeUndefined();
  }
  expect(shown).toEqual([]);
 });

 test("ignores a missing or non-string command", async () => {
  expect(await gateClaimEligibility(claims, ctxFor("reviewer"), {})).toBeUndefined();
  expect(await gateClaimEligibility(claims, ctxFor("reviewer"), { command: 42 })).toBeUndefined();
 });
});

describe("G5 scope conflict", () => {
 /** A candidate scoped to `scope`, routed to the claiming role so routing passes. */
 function candidate(scope: unknown, overrides: Partial<BdBead> = {}): BdBead {
  return bead("orc-10", { labels: ["orc-node", "agent:implementer"], metadata: { scope } as Record<string, unknown>, ...overrides });
 }

 const CLAIM = "BEADS_ACTOR=orc-impl-1 bd update orc-10 --claim";

 test("refuses a claim whose scope overlaps an in-flight bead, naming both", async () => {
  beads["orc-10"] = candidate(["src/api/**"]);
  inFlight = [bead("orc-3", { assignee: "writer-3", status: "in_progress", metadata: { scope: ["src/api/handlers.ts"] } })];

  const result = await gateClaimEligibility(claims, ctxFor("implementer"), { command: CLAIM });

  expect(result?.block).toBe(true);
  expect(result?.reason).toContain("scope conflict");
  expect(result?.reason).toContain("orc-10");
  expect(result?.reason).toContain("orc-3");
  expect(result?.reason).toContain("src/api/handlers.ts");
  // Only the in-flight `orc-node` beads are consulted, and all of them: `bd list`
  // defaults to 50 rows, past which the tail would never be compared.
  expect(listed[0]).toEqual(["list", "--label", "orc-node", "--status", "in_progress", "--limit", "0", "--json"]);
 });

 test("a literal directory and a wildcard descendant cannot be held by competing writers", async () => {
  for (const [candidateScope, heldScope] of [
   ["src/api", "src/*/handler.ts"],
   ["src/*/handler.ts", "src/api"],
  ]) {
   beads["orc-10"] = candidate([candidateScope]);
   inFlight = [bead("orc-3", {
    assignee: "writer-3", status: "in_progress",
    metadata: { role: "implementer", scope: [heldScope] },
   })];
   expect((await gateClaimEligibility(claims, ctxFor("implementer"), { command: CLAIM }))?.block).toBe(true);
  }
 });

 test("allows a claim whose scope is disjoint from every in-flight bead", async () => {
  beads["orc-10"] = candidate(["src/api/**"]);
  inFlight = [
   bead("orc-3", { assignee: "writer-3", status: "in_progress", metadata: { scope: ["docs/**"] } }),
   bead("orc-4", { assignee: "writer-4", status: "in_progress", metadata: { scope: ["test/**"] } }),
  ];

  expect(await gateClaimEligibility(claims, ctxFor("implementer"), { command: CLAIM })).toBeUndefined();
 });

 test("parses the JSON-string metadata form on both sides", async () => {
  beads["orc-10"] = bead("orc-10", {
   labels: ["agent:implementer"],
   metadata: JSON.stringify({ scope: ["src/api/**"] }) as unknown as Record<string, unknown>,
  });
  inFlight = [
   bead("orc-3", { assignee: "writer-3", status: "in_progress", metadata: JSON.stringify({ scope: ["src/api/handlers.ts"] }) as unknown as Record<string, unknown> }),
  ];

  const result = await gateClaimEligibility(claims, ctxFor("implementer"), { command: CLAIM });

  expect(result?.block).toBe(true);
  expect(result?.reason).toContain("scope conflict");
 });

 test("a scope stamped as a JSON array inside a string still overlaps", async () => {
  beads["orc-10"] = candidate('["src/api/**"]');
  inFlight = [bead("orc-3", { assignee: "writer-3", status: "in_progress", metadata: { scope: '["src/api/handlers.ts"]' } })];

  expect((await gateClaimEligibility(claims, ctxFor("implementer"), { command: CLAIM }))?.block).toBe(true);
 });

 test("allows a feature parent and its child task to overlap", async () => {
  beads["orc-10"] = bead("orc-10", {
   parent: "orc-feature",
   labels: ["agent:implementer"],
   metadata: { scope: ["src/merge.ts"] },
  });
  inFlight = [bead("orc-feature", {
   assignee: "architect-1", status: "in_progress", metadata: { role: "architect", scope: ["src/**"] },
  })];

  expect(await gateClaimEligibility(claims, ctxFor("implementer"), { command: CLAIM })).toBeUndefined();
 });

 test("blocks an unrelated architect envelope that overlaps", async () => {
  beads["orc-10"] = candidate(["src/merge.ts"]);
  inFlight = [bead("orc-other-feature", {
   assignee: "architect-2", status: "in_progress", metadata: { role: "architect", scope: ["src/**"] },
  })];

  const result = await gateClaimEligibility(claims, ctxFor("implementer"), { command: CLAIM });
  expect(result?.block).toBe(true);
  expect(result?.reason).toContain("friction guard");
 });

 test("allows an architect-held feature envelope over a task", async () => {
  beads["orc-10"] = candidate(["src/**"]);
  inFlight = [bead("orc-task", {
   parent: "orc-10", assignee: "writer-1", status: "in_progress",
   metadata: { role: "implementer", scope: ["src/merge.ts"] },
  })];

  expect(await gateClaimEligibility(claims, ctxFor("implementer"), { command: CLAIM })).toBeUndefined();
 });

 test("reads no lineage while no in-flight scope overlaps", async () => {
  // Lineage is an exemption for an overlap; with nothing to exempt, every ancestor read
  // would be spent learning nothing. Scope-less architect envelopes are the common case.
  beads["orc-10"] = candidate(["src/api/**"], { parent: "orc-feature" });
  inFlight = [
   bead("orc-feature", { assignee: "architect-1", status: "in_progress", metadata: { role: "architect" } }),
   bead("orc-epic", { assignee: "architect-1", status: "in_progress", metadata: { role: "architect" } }),
   bead("orc-3", { parent: "orc-feature", assignee: "writer-3", status: "in_progress", metadata: { scope: ["docs/**"] } }),
   bead("orc-4", { parent: "orc-feature", assignee: "writer-4", status: "in_progress", metadata: { scope: ["test/**"] } }),
  ];

  expect(await gateClaimEligibility(claims, ctxFor("implementer"), { command: CLAIM })).toBeUndefined();
  // The one show is G5's own read of the named claim target.
  expect(shown).toEqual(["orc-10"]);
 });

 test("an overlap whose lineage cannot be read is unknown, not a conflict", async () => {
  // `orc-parent` is unreadable here, so the candidate's ancestry is a prefix of the
  // truth: `orc-feature` may well be its grandparent. A slow database must not turn a
  // feature and its own task into a conflict; unknown fails open like every gate.
  beads["orc-10"] = candidate(["src/merge.ts"], { parent: "orc-parent" });
  inFlight = [bead("orc-feature", {
   assignee: "architect-1", status: "in_progress", metadata: { role: "architect", scope: ["src/**"] },
  })];

  expect(await gateClaimEligibility(claims, ctxFor("implementer"), { command: CLAIM })).toBeUndefined();
  expect(shown).toEqual(["orc-10", "orc-parent"]);

  // The same overlap with a readable, unrelated lineage is the conflict it looks like.
  beads["orc-parent"] = bead("orc-parent");
  shown = [];
  expect((await gateClaimEligibility(claims, ctxFor("implementer"), { command: CLAIM }))?.block).toBe(true);
 });

 test("skips a three-level ancestor but retains sibling friction", async () => {
  beads["orc-10"] = bead("orc-10", {
   parent: "orc-parent", labels: ["agent:implementer"], metadata: { scope: ["src/merge.ts"] },
  });
  beads["orc-parent"] = bead("orc-parent", { parent: "orc-epic" });
  beads["orc-epic"] = bead("orc-epic", { parent: "orc-root" });
  inFlight = [bead("orc-root", {
   assignee: "architect-1", status: "in_progress", metadata: { role: "implementer", scope: ["src/**"] },
  })];
  expect(await gateClaimEligibility(claims, ctxFor("implementer"), { command: CLAIM })).toBeUndefined();

  inFlight = [bead("orc-sibling", {
   assignee: "writer-1", status: "in_progress", metadata: { role: "implementer", scope: ["src/**"] },
  })];
  expect((await gateClaimEligibility(claims, ctxFor("implementer"), { command: CLAIM }))?.block).toBe(true);
 });

 test("the bead does not conflict with itself when it is already in flight", async () => {
  beads["orc-10"] = candidate(["src/api/**"]);
  inFlight = [bead("orc-10", { assignee: "writer-10", status: "in_progress", metadata: { scope: ["src/api/**"] } })];

  expect(await gateClaimEligibility(claims, ctxFor("implementer"), { command: CLAIM })).toBeUndefined();
 });

 test.each([
  ["the candidate declares no scope", undefined],
  ["the candidate's scope is empty", []],
 ])("fails open when %s", async (_label, scope) => {
  beads["orc-10"] = candidate(scope);
  inFlight = [bead("orc-3", { assignee: "writer-3", status: "in_progress", metadata: { scope: ["src/api/**"] } })];

  expect(await gateClaimEligibility(claims, ctxFor("implementer"), { command: CLAIM })).toBeUndefined();
  // No scope to compare means no reason to ask.
  expect(listed).toEqual([]);
 });

 test("fails open when an in-flight bead declares no scope", async () => {
  beads["orc-10"] = candidate(["src/api/**"]);
  inFlight = [bead("orc-3", { assignee: "writer-3", status: "in_progress" })];

  expect(await gateClaimEligibility(claims, ctxFor("implementer"), { command: CLAIM })).toBeUndefined();
 });

 test("fails open when bd list is unavailable", async () => {
  beads["orc-10"] = candidate(["src/api/**"]);
  inFlight = [];

  expect(await gateClaimEligibility(claims, ctxFor("implementer"), { command: CLAIM })).toBeUndefined();
 });

 test("a bare ** scope conflicts with everything", async () => {
  beads["orc-10"] = candidate(["**"]);
  inFlight = [bead("orc-3", { assignee: "writer-3", status: "in_progress", metadata: { scope: ["docs/readme.md"] } })];

  expect((await gateClaimEligibility(claims, ctxFor("implementer"), { command: CLAIM }))?.block).toBe(true);
 });

 test("scoped research and review can proceed alongside a paused writer", async () => {
  inFlight = [bead("orc-paused", {
   assignee: "writer-3", status: "in_progress",
   metadata: { role: "implementer", scope: ["src/api/**"] },
  })];
  for (const role of ["researcher", "reviewer"]) {
   beads["orc-10"] = bead("orc-10", { metadata: { role, scope: ["src/api/**"] } });
   expect(await gateClaimEligibility(claims, ctxFor(role), { command: CLAIM })).toBeUndefined();
  }
 });

 test("released reports and held read-only claims do not reserve writer territory", async () => {
  beads["orc-10"] = candidate(["src/api/**"]);
  inFlight = [
   bead("orc-reported", { status: "in_progress", assignee: "", metadata: { role: "implementer", scope: ["src/api/**"] } }),
   bead("orc-advice", { status: "in_progress", assignee: "research-1", metadata: { role: "researcher", scope: ["src/api/**"] } }),
   bead("orc-review", { status: "in_progress", assignee: "review-1", metadata: { role: "reviewer", scope: ["src/api/**"] } }),
  ];
  expect(await gateClaimEligibility(claims, ctxFor("implementer"), { command: CLAIM })).toBeUndefined();
 });
});

/**
 * G5 no longer records the claim, and these pin that.
 *
 * It used to record from the command, which was wrong in both directions: a queue pull
 * names no bead, and a named claim's outcome is unknown before it runs, so a race loser
 * recorded a bead it never held. Recording moved to the claim report -- see
 * `test/claim-observer.test.ts`, which owns the positive cases.
 *
 * The block this replaces asserted the old behaviour, including one case that pinned a
 * pipeline as a legitimate recording path. That was the bypass: a trailing command can
 * make the shell exit 0 while the claim failed.
 */
describe("G5 records nothing", () => {
 test("a passing named claim is allowed and not recorded", async () => {
  beads["orc-7"] = bead("orc-7", { labels: ["agent:implementer"], metadata: { worktree: "/tmp/wt" } });

  expect(
   await gateClaimEligibility(claims, ctxFor("implementer"), { command: "BEADS_ACTOR=orc-impl-1 bd update orc-7 --claim" }),
  ).toBeUndefined();
  expect(claims.observedClaim()).toBeUndefined();
 });

 test("a queue claim is allowed and not recorded", async () => {
  expect(
   await gateClaimEligibility(claims, ctxFor("implementer"), {
    command: "bd ready --metadata-field role=implementer --unassigned --claim --json",
   }),
  ).toBeUndefined();
  expect(claims.observedClaim()).toBeUndefined();
 });

 test("a claim inside a pipeline is refused before an unobservable acquisition", async () => {
  const command = "git status && env BEADS_ACTOR=orc-impl-3 bd update orc-8 --claim --json | jq .";

  expect((await gateClaimEligibility(claims, ctxFor("implementer"), { command }))?.block).toBe(true);
  expect(claims.observedClaim()).toBeUndefined();
 });

 test("does not fire on a quoted mention of a claim", async () => {
  // Parsed argv, not substrings: the payload of a comment is not a command.
  expect(
   await gateClaimEligibility(claims, ctxFor("reviewer"), { command: `bd comment orc-7 "never bd update x --claim"` }),
  ).toBeUndefined();
  expect(claims.observedClaim()).toBeUndefined();
 });
});

/**
 * Routing reads `metadata.role` first and a legacy `agent:<role>` label second. The
 * refusal quotes the carrier verbatim, so a message naming `role=implementer` and one
 * naming `agent:implementer` are the two carriers reporting themselves.
 */
describe("G5 routing reads metadata", () => {
 test("refuses a reviewer claiming a metadata-routed implementer bead", async () => {
  beads["orc-7"] = bead("orc-7", { metadata: { role: "implementer" } });

  const result = await gateClaimEligibility(claims, ctxFor("reviewer"), {
   command: "BEADS_ACTOR=orc-rev-1 bd -C /run/repo update orc-7 --claim",
  });

  expect(result?.block).toBe(true);
  expect(result?.reason).toContain("role=implementer");
  expect(claims.observedClaim()).toBeUndefined();
 });

 test("allows the role the metadata names", async () => {
  beads["orc-7"] = bead("orc-7", { metadata: { role: "implementer", worktree: "/tmp/wt" } });

  expect(
   await gateClaimEligibility(claims, ctxFor("implementer"), {
    command: "BEADS_ACTOR=orc-impl-1 bd -C /run/repo update orc-7 --claim",
   }),
  ).toBeUndefined();
  // Recording is the observer's job now, so this asserts acceptance only.
 });

 test("refuses a pull against another role's metadata queue without reading a bead", async () => {
  const result = await gateClaimEligibility(claims, ctxFor("reviewer"), {
   command: "bd -C /run/repo ready --metadata-field role=implementer --unassigned --claim --json",
  });

  expect(result?.block).toBe(true);
  expect(result?.reason).toContain("role=implementer");
  expect(shown).toEqual([]);
 });

 test("allows the canonical pull for this session's own queue", async () => {
  expect(
   await gateClaimEligibility(claims, ctxFor("implementer"), {
    command:
     "BEADS_ACTOR=orc-impl-1 bd -C /run/repo ready --parent orc-1 --metadata-field role=implementer --unassigned --claim --json",
   }),
  ).toBeUndefined();
 });

 test("the legacy integrator queue belongs to the shepherd", async () => {
  // It resolved to no role before, so this pull was refused for naming a queue that
  // could never equal the session's declared role.
  expect(
   await gateClaimEligibility(claims, ctxFor("shepherd"), {
    command: "BEADS_ACTOR=orc-shep-1 bd -C /run/repo ready --label agent:integrator --unassigned --claim --json",
   }),
  ).toBeUndefined();
 });

 test("a merge bead is refused to a non-shepherd", async () => {
  // `pr:merge` classifies, `role=shepherd` routes. Before the move the merge bead
  // resolved to nobody and any role could claim it by id.
  beads["orc-m"] = bead("orc-m", { labels: ["pr:merge"], metadata: { role: "shepherd" } });

  const result = await gateClaimEligibility(claims, ctxFor("implementer"), {
   command: "BEADS_ACTOR=orc-impl-1 bd -C /run/repo update orc-m --claim",
  });

  expect(result?.block).toBe(true);
  expect(result?.reason).toContain("role=shepherd");
 });

 test("a handoff label does not re-route the node it marks", async () => {
  // The reported state of every implementer node: routing still names the owner
  // while `agent:reviewer` signals that review is owed. A label-first resolver
  // refused the owner its own bead.
  beads["orc-7"] = bead("orc-7", {
   labels: ["orc-node", "agent:reviewer"],
   metadata: { role: "implementer", worktree: "/tmp/wt" },
  });

  expect(
   await gateClaimEligibility(claims, ctxFor("implementer"), {
    command: "BEADS_ACTOR=orc-impl-1 bd -C /run/repo update orc-7 --claim",
   }),
  ).toBeUndefined();
 });
});

/**
 * Routing authority, enforced where the write happens rather than at the exit.
 *
 * `deny_metadata` cannot carry this: it is a presence test on the claimed bead, and
 * routing metadata is present on every routed bead. So the authority is a table in the
 * gate, and these are the tests that keep it honest.
 */
describe("G5 routing authority", () => {
 const REPOINT = "bd -C /run/repo update orc-7 --set-metadata role=reviewer";

 test.each(["implementer", "researcher", "reviewer", "shepherd"])(
  "%s may not re-point a route",
  async role => {
   const result = await gateClaimEligibility(claims, ctxFor(role), { command: REPOINT });

   expect(result?.block).toBe(true);
   expect(result?.reason).toContain("metadata.role");
   expect(result?.reason).toContain(role);
  },
 );

 test("the architect may, because it routes the epic it decomposed", async () => {
  expect(await gateClaimEligibility(claims, ctxFor("architect"), { command: REPOINT })).toBeUndefined();
 });

 test("a session declaring no role is not checked", async () => {
  // The lead routes the whole DAG, and a contract-free helper is already behind
  // BD_READONLY=1, so it cannot write a bead at all.
  expect(await gateClaimEligibility(claims, ctxFor(), { command: REPOINT })).toBeUndefined();
 });

 test("clearing a route counts as re-pointing it", async () => {
  // A bead with no route reaches no queue, which strands it as surely as a wrong one.
  const result = await gateClaimEligibility(claims, ctxFor("implementer"), {
   command: "bd -C /run/repo update orc-7 --unset-metadata role",
  });

  expect(result?.block).toBe(true);
 });

 test("filing new work routed is allowed", async () => {
  // An unrouted bug bead reaches no queue and then fails close-out as stranded, and
  // a bead that does not exist yet has no route to steal.
  expect(
   await gateClaimEligibility(claims, ctxFor("implementer"), {
    command: `bd -C /run/repo create "flaky retry path" --type bug --metadata '{"role":"implementer"}'`,
   }),
  ).toBeUndefined();
 });

 test("a refused re-point records no claim", async () => {
  // The denial runs before the claim walk, so a blocked command cannot leave the
  // worktree gate keyed on a bead this session never took.
  beads["orc-7"] = bead("orc-7", { metadata: { role: "implementer" } });

  const result = await gateClaimEligibility(claims, ctxFor("implementer"), {
   command: "BEADS_ACTOR=orc-impl-1 bd -C /run/repo update orc-7 --claim --set-metadata role=reviewer",
  });

  expect(result?.block).toBe(true);
  expect(claims.observedClaim()).toBeUndefined();
 });
});

/**
 * The matcher corpus.
 *
 * Command-text matching has failed twice in this repo: two nag rules were dead because
 * they matched a bare `bd <verb>` and never the pinned `bd -C <repo> <verb>` spelling
 * every call actually uses, and a verb guard fired on a `grep` that merely quoted the
 * text. Both failures are invisible without a corpus, so the counts are asserted rather
 * than assured.
 */
const PINS = ["", "-C /run/repo ", "--directory /run/repo ", "--directory=/run/repo "];

/** Every spelling that writes or clears `metadata.role`. */
const ROUTING_WRITES = [
 "--set-metadata role=reviewer",
 "--set-metadata=role=reviewer",
 "--unset-metadata role",
 "--metadata role=reviewer",
 "--metadata=role=reviewer",
 `--metadata '{"role":"reviewer"}'`,
 `--metadata '{"role": "reviewer"}'`,
];

/** Metadata writes naming any other key. The `role` prefix is the trap. */
const OTHER_KEY_WRITES = [
 "--metadata role_hint=reviewer",
 "--metadata payroll=42",
 `--metadata '{"role_hint":"reviewer"}'`,
 `--metadata '{"payroll":"42"}'`,
 "--set-metadata role_hint=reviewer",
 "--unset-metadata role_hint",
];

const MUST_FIRE = PINS.flatMap(pin => ROUTING_WRITES.map(write => `bd ${pin}update orc-7 ${write}`));

const MUST_STAY_QUIET = [
 // Creation is exempt at every pin and every spelling.
 ...PINS.flatMap(pin => ROUTING_WRITES.map(write => `bd ${pin}create "a new bug" --type bug ${write}`)),
 ...PINS.flatMap(pin => OTHER_KEY_WRITES.map(write => `bd ${pin}update orc-7 ${write}`)),
 // `--metadata-field` filters a query and writes nothing.
 ...PINS.map(pin => `bd ${pin}ready --metadata-field role=implementer --unassigned --json`),
 ...PINS.map(pin => `bd ${pin}show orc-7 --json`),
 // Text, not a command: the program is grep.
 `grep -n 'set-metadata role' src/gates/claim.ts`,
 `bd -C /run/repo comment orc-7 "REPORTED do not run bd update x --set-metadata role=reviewer"`,
];

describe("G5 routing-write matcher corpus", () => {
 test("every routing-write spelling fires, at every pin", async () => {
  const missed: string[] = [];
  for (const command of MUST_FIRE) {
   const result = await gateClaimEligibility(claims, ctxFor("implementer"), { command });
   if (result?.block !== true) missed.push(command);
  }

  expect({ total: MUST_FIRE.length, missed }).toEqual({ total: 28, missed: [] });
 });

 test("nothing else fires", async () => {
  const leaked: string[] = [];
  for (const command of MUST_STAY_QUIET) {
   const result = await gateClaimEligibility(claims, ctxFor("implementer"), { command });
   if (result !== undefined) leaked.push(command);
  }

  expect({ total: MUST_STAY_QUIET.length, leaked }).toEqual({ total: 62, leaked: [] });
 });
});

/**
 * The claim report is read from stdout by `src/claim-observer.ts`. A redirection that
 * merges stderr into it, or moves it, is a claim the observer cannot bind.
 */
describe("G5 claim report on stdout", () => {
 const CLAIM = "bd ready --metadata-field role=implementer --unassigned --claim --json";

 test.each([
  "2>&1",
  "2>& 1",
  ">&2",
  "1>&2",
  "&>out.log",
  "&>>out.log",
 ])("refuses a claim whose stdout is merged or moved by %s", async redirection => {
  const result = await gateClaimEligibility(claims, ctxFor("implementer"), { command: `${CLAIM} ${redirection}` });
  expect(result?.block).toBe(true);
  expect(result?.reason).toContain("the claim report is read from stdout");
  expect(shown).toEqual([]);
 });

 test("refuses the merge on the wrapper shell that runs the claim", async () => {
  expect((await gateClaimEligibility(claims, ctxFor("implementer"), { command: `bash -c '${CLAIM}' 2>&1` }))?.block).toBe(true);
 });

 test.each(["2>/dev/null", "> claim.json", "2>err.log", "< /dev/null"])("leaves stdout alone with %s", async redirection => {
  expect(await gateClaimEligibility(claims, ctxFor("implementer"), { command: `${CLAIM} ${redirection}` })).toBeUndefined();
 });

 test("a role-less session outside a run is a plain bd user and is not refused", async () => {
  expect(await gateClaimEligibility(claims, ctxFor(), { command: "bd update orc-1 --claim 2>&1" })).toBeUndefined();
 });
});

/** The lead declares no role. Under a pinned run it dispatches; it never claims. */
describe("G5 the lead never claims", () => {
 test.each([
  "bd ready --label agent:implementer --claim --json",
  "bd ready --claim --json",
  "BEADS_ACTOR=lead bd update orc-7 --claim",
 ])("refuses a role-less claim under a pinned run: %s", async command => {
  const result = await pinned(() => gateClaimEligibility(claims, ctxFor(undefined, runRoot), { command }));
  expect(result?.block).toBe(true);
  expect(result?.reason).toContain("the lead never claims work beads");
  expect(shown).toEqual([]);
 });

 test("reads the marker beside the pin when the session checkout has none", async () => {
  // A linked worktree shares the primary checkout's marker, as `pinnedRunActive` reads it.
  expect((await pinned(() => gateClaimEligibility(claims, ctxFor(undefined, plainRoot), { command: "bd ready --claim --json" })))?.block).toBe(true);
 });

 test("a role-less session with a pin but no marker anywhere is under no run", async () => {
  process.env.BEADS_DIR = path.join(plainRoot, ".beads");
  expect(await gateClaimEligibility(claims, ctxFor(undefined, plainRoot), { command: "bd ready --claim --json" })).toBeUndefined();
 });

 test("a role-less session with a marker but no pin is under no run", async () => {
  expect(await gateClaimEligibility(claims, ctxFor(undefined, runRoot), { command: "bd ready --claim --json" })).toBeUndefined();
 });

 test("a role-less read under a pinned run is not a claim", async () => {
  expect(await pinned(() => gateClaimEligibility(claims, ctxFor(undefined, runRoot), { command: "bd show orc-7 --json" }))).toBeUndefined();
 });
});

/**
 * The governor: `metadata.max_inflight` on the run epic caps held code-writing claims.
 * The epic is found through the marker in the session checkout, so no pin is needed.
 */
describe("G5 capacity governor", () => {
 const PULL = "bd ready --metadata-field role=implementer --unassigned --claim --json";

 /** `count` implementer beads held in progress. */
 function held(count: number, role = "implementer"): BdBead[] {
  return Array.from({ length: count }, (_, index) => bead(`orc-held-${role}-${index}`, {
   status: "in_progress", assignee: `${role}-${index}`, labels: ["orc-node"], metadata: { role, scope: [`src/${role}${index}/**`] },
  }));
 }

 beforeEach(() => {
  beads["orc-run"] = bead("orc-run", { metadata: { max_inflight: 2 } });
 });

 test("refuses a queue pull at the cap, naming the count", async () => {
  inFlight = held(2);
  const result = await gateClaimEligibility(claims, ctxFor("implementer", runRoot), { command: PULL });
  expect(result?.block).toBe(true);
  expect(result?.reason).toBe("run at capacity (2/2); retry");
  expect(listed).toEqual([["list", "--label", "orc-node", "--status", "in_progress", "--limit", "0", "--json"]]);
 });

 test("admits a queue pull below the cap", async () => {
  inFlight = held(1);
  expect(await gateClaimEligibility(claims, ctxFor("implementer", runRoot), { command: PULL })).toBeUndefined();
 });

 test("refuses a named claim at the cap, before the friction check", async () => {
  inFlight = held(3);
  beads["orc-10"] = bead("orc-10", { metadata: { role: "implementer", scope: ["docs/**"] } });
  const result = await gateClaimEligibility(claims, ctxFor("implementer", runRoot), { command: "BEADS_ACTOR=impl-9 bd update orc-10 --claim" });
  expect(result?.reason).toBe("run at capacity (3/2); retry");
  expect(listed).toHaveLength(1);
 });

 test("counts architect envelopes, and neither reviewers, researchers, nor unheld nodes", async () => {
  inFlight = [
   ...held(1),
   ...held(1, "architect"),
   ...held(3, "reviewer"),
   ...held(3, "researcher"),
   bead("orc-waiting", { status: "in_progress", assignee: "", metadata: { role: "implementer" } }),
   bead("orc-open", { status: "open", assignee: "impl-x", metadata: { role: "implementer" } }),
  ];
  expect((await gateClaimEligibility(claims, ctxFor("implementer", runRoot), { command: PULL }))?.reason).toBe("run at capacity (2/2); retry");
  inFlight = inFlight.slice(1);
  expect(await gateClaimEligibility(claims, ctxFor("implementer", runRoot), { command: PULL })).toBeUndefined();
 });

 test("does not cap a reviewer's claim: it is not the claim the cap bounds", async () => {
  inFlight = held(5);
  expect(await gateClaimEligibility(claims, ctxFor("reviewer", runRoot), {
   command: "bd ready --metadata-field role=reviewer --unassigned --claim --json",
  })).toBeUndefined();
  expect(listed).toEqual([]);
 });

 test("excludes this session's own bead, so a same-bead retry at the cap passes", async () => {
  claims.recordClaim({ actor: "implementer-0", beadIds: ["orc-held-implementer-0"] });
  inFlight = held(2);
  beads["orc-held-implementer-0"] = inFlight[0]!;
  expect(await gateClaimEligibility(claims, ctxFor("implementer", runRoot), { command: "bd update orc-held-implementer-0 --claim" })).toBeUndefined();
 });

 test.each([
  ["absent", {}],
  ["not a number", { max_inflight: "many" }],
  ["zero", { max_inflight: 0 }],
 ])("defaults to eight when max_inflight is %s", async (_label, metadata) => {
  beads["orc-run"] = bead("orc-run", { metadata });
  inFlight = held(8);
  expect((await gateClaimEligibility(claims, ctxFor("implementer", runRoot), { command: PULL }))?.reason).toBe("run at capacity (8/8); retry");
  inFlight = held(7);
  expect(await gateClaimEligibility(claims, ctxFor("implementer", runRoot), { command: PULL })).toBeUndefined();
 });

 test("reads a cap stamped as a string", async () => {
  beads["orc-run"] = bead("orc-run", { metadata: { max_inflight: "3" } });
  inFlight = held(3);
  expect((await gateClaimEligibility(claims, ctxFor("implementer", runRoot), { command: PULL }))?.reason).toBe("run at capacity (3/3); retry");
 });

 test("fails open, and says why, when the epic cannot be read", async () => {
  delete beads["orc-run"];
  inFlight = held(9);
  expect(await gateClaimEligibility(claims, ctxFor("implementer", runRoot), { command: PULL })).toBeUndefined();
  expect(warned.map(entry => entry.data?.epic)).toEqual(["orc-run"]);
  expect(listed).toEqual([]);
 });

 test("fails open, and says why, when the in-flight list cannot be read", async () => {
  const failure = spyOn(actualBd, "lastBdFailure").mockReturnValue("budget" as BdFailure);
  try {
   expect(await gateClaimEligibility(claims, ctxFor("implementer", runRoot), { command: PULL })).toBeUndefined();
  } finally {
   failure.mockRestore();
  }
  expect(warned.map(entry => entry.data?.cause)).toEqual(["this call's bd read budget is spent; retry"]);
 });

 test.each([
  ["no marker", () => plainRoot],
  ["no cwd", () => undefined],
 ])("applies no cap with %s: there is no run epic to read", async (_label, cwd) => {
  inFlight = held(9);
  expect(await gateClaimEligibility(claims, ctxFor("implementer", cwd()), { command: PULL })).toBeUndefined();
  expect(shown).toEqual([]);
  expect(listed).toEqual([]);
 });
});

/**
 * Disjoint scopes at decomposition are the mechanism the later checks assume, so the
 * architect's scope write is where an overlap is caught, with the peer named.
 */
describe("G5 decomposition scope", () => {
 const architect = ctxFor("architect");

 beforeEach(() => {
  beads["orc-feature"] = bead("orc-feature", { status: "in_progress", assignee: "arch-1", metadata: { role: "architect", scope: ["src/**"] } });
  beads["orc-10"] = bead("orc-10", { parent: "orc-feature", metadata: { role: "implementer", scope: ["src/api/**"] } });
  inFlight = [
   beads["orc-feature"]!,
   bead("orc-3", { status: "open", labels: ["orc-node"], parent: "orc-feature", metadata: { role: "implementer", scope: ["src/api/handlers.ts"] } }),
  ];
 });

 test.each([
  ["create with a JSON envelope", `bd create "t2" --parent orc-feature --labels orc-node --metadata '{"role":"implementer","scope":["src/api/**"]}' --silent`],
  ["create behind a pin, inline spelling", `bd -C /run/repo create "t2" --parent=orc-feature --metadata='{"role":"implementer","scope":["src/api/**"]}'`],
  ["update with --set-metadata", "bd update orc-10 --set-metadata scope=src/api/**"],
  ["update with a JSON-array string", `bd update orc-10 --set-metadata 'scope=["src/api/**"]'`],
  ["update with --metadata", `bd update orc-10 --metadata '{"scope":["src/api/**"]}'`],
 ])("refuses a scope overlapping a live sibling outside the lineage, naming it: %s", async (_label, command) => {
  const result = await gateClaimEligibility(claims, architect, { command });
  expect(result?.block).toBe(true);
  expect(result?.reason).toContain("orc-3");
  expect(result?.reason).toContain("src/api/handlers.ts");
  expect(listed).toEqual([["list", "--label", "orc-node", "--status", "open,in_progress", "--limit", "0", "--json"]]);
 });

 test("exempts the lineage: the parent envelope on create, the parent and children on update", async () => {
  inFlight.push(bead("orc-10.1", { status: "in_progress", assignee: "impl-2", parent: "orc-10", metadata: { role: "implementer", scope: ["src/api/deep/**"] } }));
  inFlight.splice(1, 1);
  expect(await gateClaimEligibility(claims, architect, {
   command: `bd create "t2" --parent orc-feature --metadata '{"role":"implementer","scope":["src/other/**"]}'`,
  })).toBeUndefined();
  expect(await gateClaimEligibility(claims, architect, { command: "bd update orc-10 --set-metadata scope=src/api/**" })).toBeUndefined();
 });

 test("a new bead filed with no parent is exempt from nothing", async () => {
  inFlight.splice(1, 1);
  const result = await gateClaimEligibility(claims, architect, { command: `bd create "t2" --metadata '{"scope":["src/other/**"]}'` });
  expect(result?.reason).toContain("orc-feature");
 });

 test.each([
  ["a scope written for a researcher", `bd create "q" --metadata '{"role":"researcher","scope":["src/api/**"]}'`],
  ["a scope written on a reviewer bead", "bd update orc-10 --set-metadata scope=src/api/** --set-metadata role=reviewer"],
  ["a disjoint scope", "bd update orc-10 --set-metadata scope=docs/**"],
  ["a metadata write naming no scope", "bd update orc-10 --set-metadata worktree=/tmp/wt"],
  ["a scope on a subcommand that files nothing", "bd list --metadata-field scope=src/api/**"],
 ])("leaves %s alone", async (_label, command) => {
  expect(await gateClaimEligibility(claims, architect, { command })).toBeUndefined();
 });

 test("overlapping peers routed to read-only roles reserve nothing", async () => {
  inFlight = [bead("orc-r", { status: "open", metadata: { role: "reviewer", scope: ["src/**"] } })];
  expect(await gateClaimEligibility(claims, architect, { command: `bd create "t2" --metadata '{"scope":["src/api/**"]}'` })).toBeUndefined();
 });

 test("is the architect's check alone", async () => {
  for (const role of ["implementer", "shepherd", undefined]) {
   expect(await gateClaimEligibility(claims, ctxFor(role), { command: "bd update orc-10 --set-metadata scope=src/api/**" })).toBeUndefined();
  }
  expect(listed).toEqual([]);
 });

 test.each([
  ["the bead being re-scoped", "bd update orc-ghost --set-metadata scope=src/api/**", "orc-ghost"],
  ["the parent of a new bead", `bd create "t2" --parent orc-ghost --metadata '{"scope":["src/api/**"]}'`, undefined],
 ])("fails open, and says why, when %s cannot be read", async (_label, command, warnedBead) => {
  expect(await gateClaimEligibility(claims, architect, { command })).toBeUndefined();
  // One warning per unresolved overlap; each names the subject and the cause.
  expect(warned.length).toBeGreaterThan(0);
  expect(warned.every(entry => entry.data?.bead === warnedBead && typeof entry.data?.cause === "string")).toBe(true);
 });

 test("fails open, and says why, when the live list cannot be read", async () => {
  inFlight = [];
  const failure = spyOn(actualBd, "lastBdFailure").mockReturnValue("unavailable" as BdFailure);
  try {
   expect(await gateClaimEligibility(claims, architect, { command: "bd update orc-10 --set-metadata scope=src/api/**" })).toBeUndefined();
  } finally {
   failure.mockRestore();
  }
  expect(warned.map(entry => entry.data?.cause)).toEqual(["bd could not be run"]);
 });
});
