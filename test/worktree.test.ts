/**
 * G2 — mutations stay inside the tree, and the territory, the claimed bead names.
 *
 * The gate compares realpaths, so the fixtures are real directories in a temp tree
 * rather than string literals: a stubbed `fs` would test the comparison and not the
 * resolution, and resolution is where the symlink hazard lives. The same reason applies
 * to the target paths — a `write` names a file that does not exist yet, so the gate
 * resolves the deepest ancestor that does, and only a real tree exercises that walk.
 *
 * `OMP_WORKTREE_DIR` is pinned per test. It is read at call time and defaults to
 * `~/.omp/wt`, which exists on a developer machine, so leaving it unset would make
 * the isolation-base exemption fire or not depending on the host.
 */

import { pinAddition } from "../src/gates/readonly";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionContext, ToolCallEventResult } from "@oh-my-pi/pi-coding-agent";
import { getWorktreesDir, logger, setWorktreesDir } from "@oh-my-pi/pi-utils";
import type { BdBead } from "../src/bd";
import * as actualBd from "../src/bd";
import { createClaimState } from "../src/claim-state";
import { GATED_WRITE_TOOLS, gateWorktreeScope, normalizeRuntimeBeadsDir } from "../src/gates/worktree";

let beads: Record<string, BdBead>;
let claims = createClaimState();

// Restore each export without leaving a process-wide module mock for later suites.
const showSpy = spyOn(actualBd, "bdShow").mockImplementation(async (id: string) => beads[id] ?? null);
const listSpy = spyOn(actualBd, "bdList").mockResolvedValue([]);
/** `logger.warn` calls, so a fail-open verdict can be asserted to have named its cause. */
let warned: { message: string; data?: Record<string, unknown> }[] = [];
const warnSpy = spyOn(logger, "warn").mockImplementation(((message: string, data?: Record<string, unknown>) => {
 warned.push({ message, data });
}) as typeof logger.warn);

afterAll(() => {
 showSpy.mockRestore();
 listSpy.mockRestore();
 warnSpy.mockRestore();
});

const BEAD = "orc-42";

let root: string;
/** The tree the bead names. */
let owned: string;
/** A tree the bead does not name. */
let foreign: string;
/** OMP's task-isolation base, and a workspace materialised under it. */
let isolationBase: string;
let isolated: string;
/** Canonical and alternate database paths used by runtime BEADS_DIR checks. */
let beadsDir: string;
let beadsAlias: string;
let foreignBeadsDir: string;
let nonDirectory: string;
let priorWorktreeDir: string | undefined;

/** `ExtensionContext` as this gate consumes it: a cwd, and nothing else. */
function ctxAt(cwd: string): ExtensionContext {
 return { cwd } as unknown as ExtensionContext;
}

/** What every helper below returns: a refusal, or `undefined` for an allowed call. */
type Verdict = Promise<ToolCallEventResult | undefined>;

/**
 * The gate as `src/index.ts` calls it for a `bash` command: a tool that declares no
 * path, so only the cwd comparison applies.
 */
function fromBash(cwd: string, command = "echo hi", env?: Record<string, string>): Verdict {
 return gateWorktreeScope(claims, ctxAt(cwd), "bash", { command, ...(env === undefined ? {} : { env }) });
}

async function withPinnedBeadsDir<T>(run: () => Promise<T>): Promise<T> {
 const previous = process.env.BEADS_DIR;
 process.env.BEADS_DIR = beadsDir;
 try {
  return await run();
 } finally {
  if (previous === undefined) delete process.env.BEADS_DIR;
  else process.env.BEADS_DIR = previous;
 }
}

/** The gate as `src/index.ts` calls it for a `write` of one file. */
function writing(target: string, cwd = owned): Verdict {
 return gateWorktreeScope(claims, ctxAt(cwd), "write", { path: target, content: "x" });
}

/** The gate as `src/index.ts` calls it for an `edit` patch against one file. */
function editing(target: string, cwd = owned): Verdict {
 const input = `§${target}\n«\nold\n»\nnew`;
 return gateWorktreeScope(claims, ctxAt(cwd), "edit", { input });
}

beforeAll(async () => {
 // realpath, because macOS resolves /var and /tmp through symlinks and the gate
 // compares resolved paths.
 root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "orc-wt-")));
 owned = path.join(root, "owned");
 foreign = path.join(root, "foreign");
 isolationBase = path.join(root, "isolation");
 isolated = path.join(isolationBase, "wt-1");
 await fs.mkdir(path.join(owned, "src", "deep"), { recursive: true });
 await fs.mkdir(path.join(owned, "src", "api"), { recursive: true });
 await fs.mkdir(path.join(foreign, "src"), { recursive: true });
 beadsDir = path.join(root, "run-beads");
 beadsAlias = path.join(root, "run-beads-alias");
 foreignBeadsDir = path.join(root, "foreign-beads");
 nonDirectory = path.join(root, "not-a-directory");
 await fs.mkdir(beadsDir);
 await fs.mkdir(foreignBeadsDir);
 await fs.symlink(beadsDir, beadsAlias, "dir");
 await fs.writeFile(nonDirectory, "not a database directory");
 await fs.mkdir(isolated, { recursive: true });
 await promisify(execFile)("git", ["init", isolated], { timeout: 1500 });
 priorWorktreeDir = process.env.OMP_WORKTREE_DIR;
});

afterAll(async () => {
 if (priorWorktreeDir === undefined) delete process.env.OMP_WORKTREE_DIR;
 else process.env.OMP_WORKTREE_DIR = priorWorktreeDir;
 await fs.rm(root, { recursive: true, force: true });
});

beforeEach(() => {
 claims = createClaimState();
 warned = [];
 beads = { [BEAD]: { id: BEAD, status: "in_progress", assignee: "orc-impl-1", metadata: { worktree: owned } } };
 // Disable isolated-root discovery outside the isolation-specific cases.
 process.env.OMP_WORKTREE_DIR = path.join(root, "no-such-isolation-base");
 claims.recordClaim({ actor: "orc-impl-1", beadIds: [BEAD] });
});



describe("G2 gated tools", () => {
 test("gates exactly the tools that mutate the working tree", () => {
  expect(GATED_WRITE_TOOLS).toEqual({ bash: true, edit: true, write: true });
 });
});

describe("G2 inside the claimed tree", () => {
 test.each([
  ["the worktree itself", () => owned],
  ["a subdirectory of it", () => path.join(owned, "src")],
  ["a deeper subdirectory", () => path.join(owned, "src", "deep")],
 ])("allows a mutation from %s", async (_label, at) => {
  expect(await fromBash(at())).toBeUndefined();
 });

 test.each([
  ["an absolute path in the tree", () => path.join(owned, "src", "api.ts")],
  ["a path under a directory that does not exist yet", () => path.join(owned, "src", "new", "deep", "api.ts")],
  ["a relative path", () => "src/api.ts"],
  ["a `..` that stays inside the tree", () => "src/deep/../api.ts"],
  ["the tree root itself", () => owned],
 ])("allows a write to %s", async (_label, at) => {
  expect(await writing(at())).toBeUndefined();
 });

 test("allows an edit whose section header names a file in the tree", async () => {
  expect(await editing(path.join(owned, "src", "api.ts"))).toBeUndefined();
 });
});

describe("G2 outside the claimed tree", () => {
 test("refuses a mutation from another tree, naming the bead", async () => {
  const result = await fromBash(foreign);

  expect(result?.block).toBe(true);
  expect(result?.reason).toContain(BEAD);
  expect(result?.reason).toContain("metadata.worktree");
 });

 test("refuses a mutation from the parent of the claimed tree", async () => {
  // A prefix comparison alone would let `/root` pass for `/root/owned`; the gate
  // requires the cwd to be the tree or beneath it.
  expect((await fromBash(root))?.block).toBe(true);
 });

 test("refuses a sibling whose path is a string prefix of the claimed tree", async () => {
  // `owned-2` starts with `owned` as text but is a different directory, which is
  // why the gate appends a separator before comparing.
  const sibling = `${owned}-2`;
  await fs.mkdir(sibling, { recursive: true });
  try {
   expect((await fromBash(sibling))?.block).toBe(true);
  } finally {
   await fs.rm(sibling, { recursive: true, force: true });
  }
 });

 test("refuses a symlink that points out of the claimed tree", async () => {
  // The reason realpath is used at all: an unresolved comparison would accept a
  // link planted inside the owned tree.
  const link = path.join(owned, "escape");
  await fs.symlink(foreign, link);
  try {
   expect((await fromBash(link))?.block).toBe(true);
  } finally {
   await fs.rm(link, { force: true });
  }
 });

 test("refuses when any one of several claimed beads names another tree", async () => {
  beads["orc-43"] = { id: "orc-43", status: "in_progress", assignee: "orc-impl-1", metadata: { worktree: foreign } };
  claims.recordClaim({ actor: "orc-impl-1", beadIds: [BEAD, "orc-43"] });

  const result = await fromBash(owned);

  expect(result?.block).toBe(true);
  expect(result?.reason).toContain("orc-43");
 });
});

describe("G2 target paths that escape the claimed tree", () => {
 test("refuses a write whose `..` climbs out of the tree", async () => {
  // The gap this closes: the cwd is legitimate, so before the gate read the input
  // nothing compared the path the write actually named.
  const result = await writing("../foreign/src/api.ts");

  expect(result?.block).toBe(true);
  expect(result?.reason).toContain("../foreign/src/api.ts");
  expect(result?.reason).toContain("metadata.worktree");
  expect(result?.reason).toContain(BEAD);
 });

 test("refuses a write to an absolute path in another checkout", async () => {
  expect((await writing(path.join(foreign, "src", "api.ts")))?.block).toBe(true);
 });

 test("refuses a write to a sibling directory that is a string prefix of the tree", async () => {
  const sibling = `${owned}-2`;
  await fs.mkdir(sibling, { recursive: true });
  try {
   expect((await writing(path.join(sibling, "api.ts")))?.block).toBe(true);
  } finally {
   await fs.rm(sibling, { recursive: true, force: true });
  }
 });

 test("refuses a write through a symlink that leaves the tree", async () => {
  // Planted inside the owned tree, so a lexical comparison accepts it and only
  // realpath catches it.
  const link = path.join(owned, "src", "linked");
  await fs.symlink(path.join(foreign, "src"), link);
  try {
   const result = await writing(path.join(link, "api.ts"));

   expect(result?.block).toBe(true);
   // Named as the agent wrote it, and as it resolves, because those differ.
   expect(result?.reason).toContain(path.join(foreign, "src", "api.ts"));
  } finally {
   await fs.rm(link, { force: true });
  }
 });

 test("refuses a write through a symlink whose target is relative", async () => {
  // A relative link body is read against the directory holding the link, not
  // against the cwd, so this is a distinct branch of the walk from the one above.
  const link = path.join(owned, "src", "up");
  await fs.symlink(path.join("..", "..", "foreign", "src"), link);
  try {
   expect((await writing("src/up/api.ts"))?.block).toBe(true);
  } finally {
   await fs.rm(link, { force: true });
  }
 });

 test("refuses a `..` that steps out through a symlink", async () => {
  // The case that made the gate resolve paths itself. `owned/hop/../api.ts`
  // collapses lexically to `owned/api.ts`, which is contained, and that is what
  // Bun's `fs.realpath` returns. The kernel follows `hop` first and then takes the
  // parent of where it landed, so the write really goes to `root/api.ts` — the
  // assertion below is against a file created through exactly that path.
  const link = path.join(owned, "hop");
  await fs.symlink(foreign, link);
  try {
   // Template-concatenated, because `path.join` performs the very lexical
   // collapse this test exists to distinguish from the kernel's order.
   await fs.writeFile(`${owned}/hop/../kernel.txt`, "x");
   expect(await fs.readFile(path.join(root, "kernel.txt"), "utf8")).toBe("x");

   expect((await writing("hop/../api.ts"))?.block).toBe(true);
  } finally {
   await fs.rm(link, { force: true });
   await fs.rm(path.join(root, "kernel.txt"), { force: true });
  }
 });

 test("refuses an edit whose section header names a file in another tree", async () => {
  const result = await editing(path.join(foreign, "src", "api.ts"));

  expect(result?.block).toBe(true);
  expect(result?.reason).toContain("metadata.worktree");
 });

 test("refuses an edit that moves a file out of the tree", async () => {
  // `MV` is a second write target in the same patch, and escapes identically.
  const result = await gateWorktreeScope(claims, ctxAt(owned), "edit", {
   input: `[${path.join(owned, "src", "api.ts")}#A1B2]\nPUT 1.=1:\n+x\nMV ${path.join(foreign, "src", "api.ts")}`,
  });

  expect(result?.block).toBe(true);
 });

 test("refuses a quoted `MV` destination out of the tree", async () => {
  const result = await gateWorktreeScope(claims, ctxAt(owned), "edit", {
   input: `[${path.join(owned, "src", "api.ts")}#A1B2]\nMV "${path.join(foreign, "src", "a b.ts")}"`,
  });

  expect(result?.block).toBe(true);
  // The quotes are stripped, so the reason names the path and not `"path"`.
  expect(result?.reason).toContain(path.join(foreign, "src", "a b.ts"));
 });

 test("refuses the escaping target among several the patch names", async () => {
  const result = await gateWorktreeScope(claims, ctxAt(owned), "edit", {
   input: [
    `[${path.join(owned, "src", "api.ts")}#A1B2]`,
    "PUT 1.=1:",
    "+x",
    `[${path.join(foreign, "src", "api.ts")}#C3D4]`,
    "PUT 1.=1:",
    "+x",
   ].join("\n"),
  });

  expect(result?.block).toBe(true);
 });
});

describe("G2 metadata.scope territory", () => {
 beforeEach(() => {
  beads[BEAD] = { id: BEAD, status: "in_progress", assignee: "orc-impl-1", metadata: { worktree: owned, scope: ["src/api/**"] } };
 });

 test.each(["src/**", "/src/**"])("scope %s grants matching writes and refuses the rest of the tree", async scope => {
  beads[BEAD] = { id: BEAD, status: "in_progress", assignee: "orc-impl-1", metadata: { worktree: owned, scope: [scope] } };
  expect(await writing("src/api.ts")).toBeUndefined();
  expect((await writing("docs/api.ts"))?.block).toBe(true);
 });

 test.each(["", "/"])("whole-tree scope %j grants in-tree writes but not escapes", async scope => {
  beads[BEAD] = { id: BEAD, status: "in_progress", assignee: "orc-impl-1", metadata: { worktree: owned, scope: [scope] } };
  expect(await writing("docs/api.ts")).toBeUndefined();
  expect((await writing("../foreign/src/api.ts"))?.reason).toContain("metadata.worktree");
 });

 test("reads no in-flight peers: scope friction is judged once, at claim", async () => {
  // The per-write friction check was the read amplification the audit measured; G2
  // now compares the target against the claimed territory and lists nothing.
  expect(await writing("src/api/handler.ts")).toBeUndefined();
  expect(listSpy).not.toHaveBeenCalled();
 });

 test("allows a write the scope globs name", async () => {
  expect(await writing("src/api/handler.ts")).toBeUndefined();
 });

 test("allows a write the scope globs name from a subdirectory of the tree", async () => {
  // The globs are repo-relative, so the gate makes the target relative to the
  // declared worktree rather than to the cwd. Keyed on the cwd it would compare
  // `api/handler.ts` and refuse this.
  expect(await writing("api/handler.ts", path.join(owned, "src"))).toBeUndefined();
 });

 test("refuses a write inside the tree the globs cannot name, listing them", async () => {
  const result = await writing("src/other/api.ts");

  expect(result?.block).toBe(true);
  expect(result?.reason).toContain("metadata.scope");
  expect(result?.reason).toContain("src/api/**");
  expect(result?.reason).toContain(BEAD);
 });

 test("refuses an edit inside the tree the globs cannot name", async () => {
  expect((await editing(path.join(owned, "src", "deep", "api.ts")))?.block).toBe(true);
 });

 test("allows a wildcard-free glob to grant its whole subtree", async () => {
  // `scopesOverlap` treats a wildcard-free scope as owning that path outright, so
  // `src/api` must grant the files under it or the scope grants nothing at all.
  beads[BEAD] = { id: BEAD, status: "in_progress", assignee: "orc-impl-1", metadata: { worktree: owned, scope: ["src/api"] } };
  expect(await writing("src/api/deep/handler.ts")).toBeUndefined();
 });

 test("allows any of several declared globs to name the target", async () => {
  beads[BEAD] = { id: BEAD, status: "in_progress", assignee: "orc-impl-1", metadata: { worktree: owned, scope: ["docs/**", "src/deep/**"] } };
  expect(await writing("src/deep/api.ts")).toBeUndefined();
 });

 test.each([
  ["a tool device", "xd://lsp"],
  ["a shared plan artifact", "local://plan.md"],
  ["a remote host", "ssh://build-box/etc/hosts"],
 ])("allows a write to %s, which is not a path in any tree", async (_label, target) => {
  // The false positive this guards. `write` addresses more than files, and a URI
  // resolved as a relative path lands inside the tree but is named by no glob, so a
  // bead with a scope — the fixture here — would have every tool-device call
  // refused. The scheme is not evidence about a tree, so it is not compared.
  expect(await writing(target)).toBeUndefined();
 });

 test("reads the JSON-array-in-a-string form of scope", async () => {
  // `scopeOf` accepts it because some producers stamp metadata that way.
  beads[BEAD] = { id: BEAD, status: "in_progress", assignee: "orc-impl-1", metadata: { worktree: owned, scope: JSON.stringify(["src/api/**"]) } };
  expect((await writing("src/other/api.ts"))?.block).toBe(true);
 });

 test("allows the tree root itself, which no glob needs to name", async () => {
  expect(await writing(owned)).toBeUndefined();
 });

 test("refuses an out-of-tree target before comparing globs", async () => {
  // Containment is the first comparison, so the reason names the tree and not the
  // scope even though both would refuse.
  const result = await writing(path.join(foreign, "src", "api.ts"));

  expect(result?.reason).toContain("metadata.worktree");
  expect(result?.reason).not.toContain("metadata.scope");
 });

 test("allows a target either claimed bead's scope names", async () => {
  // Territory is a union across claimed beads. G5 keeps claimed beads' globs
  // disjoint, so intersecting them would leave a worker holding two of them with
  // nowhere legal to write at all.
  beads["orc-43"] = { id: "orc-43", status: "in_progress", assignee: "orc-impl-1", metadata: { worktree: owned, scope: ["src/deep/**"] } };
  claims.recordClaim({ actor: "orc-impl-1", beadIds: [BEAD, "orc-43"] });

  expect(await writing("src/api/handler.ts")).toBeUndefined();
  expect(await writing("src/deep/handler.ts")).toBeUndefined();
 });

 test("refuses a target neither claimed bead's scope names, listing both", async () => {
  beads["orc-43"] = { id: "orc-43", status: "in_progress", assignee: "orc-impl-1", metadata: { worktree: owned, scope: ["src/deep/**"] } };
  claims.recordClaim({ actor: "orc-impl-1", beadIds: [BEAD, "orc-43"] });

  const result = await writing("src/other/handler.ts");

  expect(result?.block).toBe(true);
  expect(result?.reason).toContain("src/api/**");
  expect(result?.reason).toContain("src/deep/**");
  expect(result?.reason).toContain("orc-43");
 });

 test("a claimed bead that declares no scope neither widens nor narrows the territory", async () => {
  // DECISION, and the one reading of a mixed claim that keeps enforcement on. A
  // bead declaring no scope is an unknown territory, not an unlimited one: treating
  // the silence as a grant would let one scope-less bead in a claim switch the
  // comparison off entirely, so the union is over the beads that actually spoke.
  beads["orc-43"] = { id: "orc-43", status: "in_progress", assignee: "orc-impl-1", metadata: { worktree: owned } };
  claims.recordClaim({ actor: "orc-impl-1", beadIds: [BEAD, "orc-43"] });

  expect(await writing("src/api/handler.ts")).toBeUndefined();
  expect((await writing("src/other/handler.ts"))?.block).toBe(true);
 });
});

describe("G2 ownership freshness", () => {
 const actor = "orc-impl-1";
 const successor = "orc-successor";

 beforeEach(() => {
  beads[BEAD] = {
   id: BEAD,
   status: "in_progress",
   assignee: successor,
   metadata: { worktree: owned, scope: ["src/**"] },
  };
 });

 test.each([
  ["write", () => writing("src/api.ts")],
  ["edit", () => editing(path.join(owned, "src", "api.ts"))],
  ["bash", () => fromBash(owned, "touch src/api.ts")],
 ])("rejects the superseded actor's ordinary %s mutation, naming the new owner", async (_tool, mutate) => {
  const result = await mutate();
  expect(result?.block).toBe(true);
  expect(result?.reason).toContain(BEAD);
  expect(result?.reason).toContain(successor);
  expect(result?.reason).toContain("mutating product files");
 });

 test("allows the currently assigned actor to mutate the same scope", async () => {
  beads[BEAD]!.assignee = actor;

  expect(await writing("src/api.ts")).toBeUndefined();
  expect(await editing(path.join(owned, "src", "api.ts"))).toBeUndefined();
  expect(await fromBash(owned, "touch src/api.ts")).toBeUndefined();
 });

 test.each([
  ["reopened and still assigned to this actor", { status: "open", assignee: actor }],
  ["released", { status: "open", assignee: "" }],
  ["blocked", { status: "blocked", assignee: actor }],
 ])("allows product mutation while the bead is %s: nobody else holds it", async (_state, bead) => {
  // Only proof of loss refuses: a released bead is taken from nobody, and a worker
  // bounced by G4 after its release must be able to repair its evidence.
  beads[BEAD] = { id: BEAD, ...bead, metadata: { worktree: owned, scope: ["src/**"] } };

  expect(await writing("src/api.ts")).toBeUndefined();
  expect(warned).toEqual([]);
 });

 test.each([
  ["timeout", "did not answer in time"],
  ["unavailable", "bd could not be run"],
  ["budget", "read budget is spent"],
  ["missing", "no such bead"],
  [undefined, "could not be read"],
 ])("allows product mutation and warns with the cause when the bead cannot be read (%s)", async (kind, cause) => {
  // Uncertainty is not evidence: the store under load must not lock a worker out of
  // its own tree, and the reason lands in the log rather than in a refusal.
  delete beads[BEAD];
  const failure = spyOn(actualBd, "lastBdFailure").mockReturnValue(kind as actualBd.BdFailure | undefined);
  try {
   expect(await writing("src/api.ts")).toBeUndefined();
   expect(await fromBash(owned, "touch src/api.ts")).toBeUndefined();
  } finally {
   failure.mockRestore();
  }
  expect(warned.length).toBeGreaterThan(0);
  expect(warned.every(entry => entry.data?.bead === BEAD && String(entry.data?.cause).includes(cause))).toBe(true);
  expect(claims.observedClaim()).toBeDefined();
 });

 test("keeps a recognized Beads read control path safe after reassignment", async () => {
  expect(await fromBash(owned, `bd show ${BEAD} --json`)).toBeUndefined();
 });

 test.each([
  ["a cleared assignee", ""],
  ["no assignee", undefined],
 ])("allows the terminal comment and later product work on the claimed bead after its release leaves %s", async (_state, assignee) => {
  // The documented completion writes REPORTED and then releases; a worker that releases
  // first must still be able to report, and one bounced by G4 must be able to repair.
  beads[BEAD] = { id: BEAD, status: "in_progress", metadata: { worktree: owned, scope: ["src/**"] } };
  if (assignee !== undefined) beads[BEAD]!.assignee = assignee;

  expect(await fromBash(owned, `BEADS_ACTOR=${actor} bd comment ${BEAD} "REPORTED done"`)).toBeUndefined();
  expect(await fromBash(owned, `BD_ACTOR=${actor} bd comments add ${BEAD} "REPORTED done"`)).toBeUndefined();
  expect(await fromBash(owned, "git log -1")).toBeUndefined();
  expect(await writing("src/api.ts")).toBeUndefined();
 });

 test("refuses the comment once the bead belongs to a successor, without calling it a product file", async () => {
  const result = await fromBash(owned, `BEADS_ACTOR=${actor} bd comment ${BEAD} "REPORTED done"`);

  expect(result?.block).toBe(true);
  expect(result?.reason).toContain(BEAD);
  expect(result?.reason).not.toContain("product files");
 });

 test.each([
  ["a commit", () => fromBash(owned, "git commit -am done")],
  ["a write", () => writing("src/api.ts")],
  ["a comment on it", () => fromBash(owned, `BEADS_ACTOR=${actor} bd comment ${BEAD} "NOTE closing remark"`)],
 ])("forgets the claim and admits %s once this actor closed the bead", async (_label, mutate) => {
  // A finished bead is a release, not a loss of ownership: refusing every later call
  // locked the session until its next claim command.
  beads[BEAD] = { id: BEAD, status: "closed", assignee: actor, metadata: { worktree: owned, scope: ["src/**"] } };

  expect(await mutate()).toBeUndefined();
  expect(claims.observedClaim()).toBeUndefined();
 });

 test.each([
  ["a successor", { status: "closed", assignee: successor }],
  ["nobody", { status: "closed" }],
 ])("keeps refusing after a close that left the bead assigned to %s", async (_label, bead) => {
  beads[BEAD] = { id: BEAD, ...bead, metadata: { worktree: owned, scope: ["src/**"] } };

  expect((await fromBash(owned, "git commit -am done"))?.block).toBe(true);
  expect(claims.observedClaim()).toBeDefined();
 });

 test("keeps the claim through its own recovery commands on the closed bead", async () => {
  // Reopen and reclaim rely on the retained claim state; a wrapped bd command on the
  // closed bead is neither recovery nor product work, so it is refused rather than
  // treated as the end of the claim.
  beads[BEAD] = { id: BEAD, status: "closed", assignee: actor, metadata: { worktree: owned, scope: ["src/**"] } };

  expect(await fromBash(owned, `BEADS_ACTOR=${actor} bd reopen ${BEAD}`)).toBeUndefined();
  expect((await fromBash(owned, `BEADS_ACTOR=${actor} sh -c 'bd reopen ${BEAD}'`))?.block).toBe(true);
  expect((await fromBash(owned, `BEADS_ACTOR=${actor} bd update ${BEAD} --status in_progress`))?.block).toBe(true);
  expect(claims.observedClaim()).toBeDefined();
 });
});

describe("G2 runtime database identity", () => {
 // The check defends a pinned run's database and is reached only under orchestration
 // (`test/wiring.test.ts` drives that predicate); these direct calls exercise the
 // identity comparison itself against the process pin.

 test("the documented re-entry command passes through the env field and is refused inline", async () => {
  // Mirrors skills/orchestrate/references/planning.md "re-entry changes the discovery root".
  await withPinnedBeadsDir(async () => {
   const pinned = process.env.BEADS_DIR as string;
   const command = `omp --cwd "${owned}" --config overlay.json --print "Lead: dispatch" </dev/null`;
   const documented = await normalizeRuntimeBeadsDir(ctxAt(owned), { command, env: { ORCHESTRATE_MARKER_FILE: "/run/.active-run" } });
   expect(documented.ok).toBe(true); // no BEADS_DIR on the call: the pin rides in through the revision
   expect(pinAddition({ command, env: { ORCHESTRATE_MARKER_FILE: "/run/.active-run" } })).toEqual({ BEADS_DIR: pinned });
   const inline = await normalizeRuntimeBeadsDir(ctxAt(owned), { command: `BEADS_DIR="${pinned}" ORCHESTRATE_MARKER_FILE=/run/.active-run ${command}` });
   expect(inline.ok).toBe(false);
  });
 });

 test("accepts the canonical runtime pin without rewriting it", async () => {
  await withPinnedBeadsDir(async () => {
   const input = { command: "echo ok", env: { BEADS_DIR: beadsDir } };
   const validation = await normalizeRuntimeBeadsDir(ctxAt(owned), input);

   expect(validation).toEqual({ ok: true, input, changed: false });
  });
 });

 test.each([
  ["a symlink alias", () => beadsAlias, undefined],
  ["a path relative to Bash cwd", () => path.relative(owned, beadsDir), owned],
 ])("normalizes %s to the canonical runtime pin", async (_label, requested, cwd) => {
  await withPinnedBeadsDir(async () => {
   const input = { command: "echo ok", ...(cwd === undefined ? {} : { cwd }), env: { BEADS_DIR: requested() } };
   const validation = await normalizeRuntimeBeadsDir(ctxAt(foreign), input);

   expect(validation.ok).toBe(true);
   if (!validation.ok) return;
   expect(validation.changed).toBe(true);
   expect((validation.input.env as Record<string, unknown>).BEADS_DIR).toBe(beadsDir);
  });
 });

 test.each([
  ["another database", () => foreignBeadsDir],
  ["a missing path", () => path.join(root, "missing-beads")],
  ["a non-directory", () => nonDirectory],
 ])("refuses runtime BEADS_DIR targeting %s", async (_label, requested) => {
  await withPinnedBeadsDir(async () => {
   const validation = await normalizeRuntimeBeadsDir(ctxAt(owned), {
    command: "echo no",
    env: { BEADS_DIR: requested() },
   });

   expect(validation.ok).toBe(false);
   if (validation.ok) return;
   expect(validation.refusal.block).toBe(true);
  });
 });

 test("blocks a mismatched runtime database even without an observed claim", async () => {
  claims = createClaimState();
  await withPinnedBeadsDir(async () => {
   const result = await fromBash(owned, "echo no", { BEADS_DIR: foreignBeadsDir });

   expect(result?.block).toBe(true);
   expect(result?.reason).toContain("session-pinned database");
  });
 });

 test.each([
  ["direct prefix", `BEADS_DIR=${foreignBeadsDir} bd update ${BEAD} --status open`],
  ["persistent assignment", `BEADS_DIR=${foreignBeadsDir}; bd update ${BEAD} --status open`],
  ["export", `export BEADS_DIR=${foreignBeadsDir}; bd update ${BEAD} --status open`],
  ["absolute env wrapper", `/usr/bin/env BEADS_DIR=${foreignBeadsDir} bd update ${BEAD} --status open`],
  ["env split-string wrapper", `env -S 'BEADS_DIR=${foreignBeadsDir} bd update ${BEAD} --status open'`],
 ])("blocks a %s database override even without an observed claim", async (_label, command) => {
  claims = createClaimState();
  await withPinnedBeadsDir(async () => {
   const result = await fromBash(owned, command);

   expect(result?.block).toBe(true);
   expect(result?.reason).toContain("Bash tool environment");
  });
 });
});

describe("G2 standalone ownership controls", () => {
 const actor = "orc-impl-1";
 const foreignActor = "other-worker";

 test("allows a pure release by the observed actor on a closed bead", async () => {
  beads[BEAD] = { id: BEAD, status: "closed", assignee: actor, metadata: { worktree: owned } };

  expect(await fromBash(owned, `BEADS_ACTOR=${actor} bd update ${BEAD} --assignee ""`)).toBeUndefined();
 });

 test("allows an idempotent pure release of a closed already-unassigned bead", async () => {
  beads[BEAD] = { id: BEAD, status: "closed", metadata: { worktree: owned } };

  expect(await fromBash(owned, `env BD_ACTOR=${actor} bd update ${BEAD} --assignee ""`)).toBeUndefined();
 });

 test("refuses release flags that would reopen a terminal bead", async () => {
  beads[BEAD] = { id: BEAD, status: "closed", assignee: actor, metadata: { worktree: owned } };

  expect((await fromBash(owned, `BD_ACTOR=${actor} bd update ${BEAD} --status open --assignee ""`))?.block).toBe(true);
 });

 test("allows the observed actor to recover a closed claim in two steps", async () => {
  // `bd reopen` sets status open and keeps the assignee; the only reclaim bd has is
  // `bd update <id> --claim`, with `--json` so the observer re-records it.
  beads[BEAD] = { id: BEAD, status: "closed", assignee: actor, metadata: { worktree: owned, scope: ["src/api/**"] } };

  expect(await fromBash(owned, `BEADS_ACTOR=${actor} bd reopen ${BEAD}`)).toBeUndefined();
  beads[BEAD]!.status = "open";
  expect(await fromBash(owned, `BEADS_ACTOR=${actor} bd update ${BEAD} --claim --json`)).toBeUndefined();
  expect(await fromBash(owned, `BEADS_ACTOR=${actor} bd update ${BEAD} --claim`)).toBeUndefined();
 });

 test("allows the observed actor to hand a reopened bead back instead of reclaiming it", async () => {
  beads[BEAD] = { id: BEAD, status: "open", assignee: actor, metadata: { worktree: owned } };

  expect(await fromBash(owned, `BEADS_ACTOR=${actor} bd update ${BEAD} --assignee ""`)).toBeUndefined();
 });

 test("a reclaim with extra flags is product work on an open bead this actor holds, and passes", async () => {
  // Not the reclaim control, so no grammar applies; and an open bead assigned to this
  // actor proves no loss.
  beads[BEAD] = { id: BEAD, status: "open", assignee: actor, metadata: { worktree: owned } };

  expect(await fromBash(owned, `BEADS_ACTOR=${actor} bd update ${BEAD} --claim --status in_progress`)).toBeUndefined();
 });

 test("allows matching structured BEADS_DIR for standalone recovery", async () => {
  beads[BEAD] = { id: BEAD, status: "closed", assignee: actor, metadata: { worktree: owned } };
  await withPinnedBeadsDir(async () => {
   expect(await fromBash(owned, `BEADS_ACTOR=${actor} bd reopen ${BEAD}`, { BEADS_DIR: beadsDir })).toBeUndefined();
  });
 });

 test("keeps unrelated structured environment keys untrusted for recovery", async () => {
  beads[BEAD] = { id: BEAD, status: "closed", assignee: actor, metadata: { worktree: owned } };
  await withPinnedBeadsDir(async () => {
   const result = await fromBash(owned, `BEADS_ACTOR=${actor} bd reopen ${BEAD}`, { BEADS_DIR: beadsDir, OTHER: "x" });
   expect(result?.block).toBe(true);
  });
 });

 test.each([
  ["reopen unassigned", `bd reopen ${BEAD}`, { status: "closed" }],
  ["reopen foreign owner", `bd reopen ${BEAD}`, { status: "closed", assignee: foreignActor }],
  ["reopen wrong status", `bd reopen ${BEAD}`, { status: "open", assignee: actor }],
  ["reclaim unassigned", `bd update ${BEAD} --claim --json`, { status: "open" }],
  ["reclaim foreign owner", `bd update ${BEAD} --claim`, { status: "open", assignee: foreignActor }],
  ["reclaim wrong status", `bd update ${BEAD} --claim`, { status: "closed", assignee: actor }],
 ] as const)("refuses %s", async (_label, command, bead) => {
  if (bead === undefined) delete beads[BEAD];
  else beads[BEAD] = { id: BEAD, ...bead, metadata: { worktree: owned } };

  expect((await fromBash(owned, `BEADS_ACTOR=${actor} ${command}`))?.block).toBe(true);
 });

 test.each([
  ["a foreign actor", "closed", `BEADS_ACTOR=${foreignActor} bd reopen ${BEAD}`],
  ["a wrapped reopen", "closed", `BEADS_ACTOR=${actor} sh -c 'bd reopen ${BEAD}'`],
  ["a compound reopen", "closed", `BEADS_ACTOR=${actor} bd reopen ${BEAD}; true`],
  ["a foreign actor reclaim", "open", `BEADS_ACTOR=${foreignActor} bd update ${BEAD} --claim`],
  ["a foreign bead", "closed", `BEADS_ACTOR=${actor} bd reopen orc-foreign`],
 ])("refuses recovery through %s", async (_label, status, command) => {
  beads[BEAD] = { id: BEAD, status, assignee: actor, metadata: { worktree: owned } };

  expect((await fromBash(owned, command))?.block).toBe(true);
 });

 test.each([
  ["after reassignment", { status: "closed", assignee: foreignActor }],
  ["while open and unassigned", { status: "open" }],
 ])("refuses a pure release %s", async (_state, bead) => {
  if (bead === undefined) delete beads[BEAD];
  else beads[BEAD] = { id: BEAD, ...bead, metadata: { worktree: owned } };

  expect((await fromBash(owned, `BEADS_ACTOR=${actor} bd update ${BEAD} --assignee ""`))?.block).toBe(true);
 });

 test.each([
  `BEADS_ACTOR=${foreignActor} bd update ${BEAD} --assignee ""`,
  `env BD_ACTOR=${foreignActor} bd comment ${BEAD} "foreign note"`,
 ])("refuses a foreign-actor control without an overlapping owner: %s", async (command) => {
  expect((await fromBash(owned, command))?.block).toBe(true);
 });

 test("rejects explicit foreign identity on otherwise permitted reads", async () => {
  expect((await fromBash(owned, `BEADS_ACTOR=${foreignActor} bd show ${BEAD}`))?.block).toBe(true);
  expect((await fromBash(owned, `bd --actor ${foreignActor} list --json`))?.block).toBe(true);
  expect((await fromBash(owned, `bd show ${BEAD}`, { BEADS_ACTOR: actor, BD_ACTOR: foreignActor }))?.block).toBe(true);
 });

 test("allows a bare owned Beads mutation without a scope conflict", async () => {
  expect(await fromBash(owned, `bd comment ${BEAD} "ordinary note"`)).toBeUndefined();
 });

 test("denies an explicit foreign actor in the execution environment without a scope conflict", async () => {
  expect((await fromBash(owned, `bd comment ${BEAD} "foreign note"`, { BEADS_ACTOR: foreignActor }))?.block).toBe(true);
 });

 test.each([
  `BEADS_ACTOR=${foreignActor} BD_ACTOR=${actor}`,
  `BEADS_ACTOR=${actor} BD_ACTOR=${foreignActor}`,
 ])("rejects conflicting explicit actor identities: %s", async (bindings) => {
  expect((await fromBash(owned, `${bindings} bd update ${BEAD} --assignee ""`))?.block).toBe(true);
 });

 test("rejects conflicting actor identities in the execution environment", async () => {
  expect((await fromBash(owned, `bd update ${BEAD} --assignee ""`, {
   BEADS_ACTOR: foreignActor, BD_ACTOR: actor,
  }))?.block).toBe(true);
 });

 test("does not hide an explicit foreign actor behind unrelated environment values", async () => {
  expect((await fromBash(owned, `bd update ${BEAD} --assignee ""`, {
   BEADS_ACTOR: foreignActor, CI: "1",
  }))?.block).toBe(true);
 });

 test("preserves an inherited actor's release while unknown identity cannot escape a conflict", async () => {
  const priorActor = process.env.BEADS_ACTOR;
  const priorLegacyActor = process.env.BD_ACTOR;
  try {
   process.env.BEADS_ACTOR = actor;
   delete process.env.BD_ACTOR;
   beads[BEAD] = { id: BEAD, status: "closed", assignee: actor, metadata: { worktree: owned } };
   expect(await fromBash(owned, `bd update ${BEAD} --assignee ""`)).toBeUndefined();
   delete process.env.BEADS_ACTOR;
  } finally {
   if (priorActor === undefined) delete process.env.BEADS_ACTOR;
   else process.env.BEADS_ACTOR = priorActor;
   if (priorLegacyActor === undefined) delete process.env.BD_ACTOR;
   else process.env.BD_ACTOR = priorLegacyActor;
  }
 });
});

describe("G2 fail-open", () => {
 test("no observed claim allows the mutation", async () => {
  claims = createClaimState();
  expect(await fromBash(foreign)).toBeUndefined();
  expect(await writing(path.join(foreign, "src", "api.ts"))).toBeUndefined();
 });

 test("a bead declaring no worktree allows the mutation", async () => {
  beads[BEAD] = { id: BEAD, status: "in_progress", assignee: "orc-impl-1", metadata: {} };
  expect(await fromBash(foreign)).toBeUndefined();
  expect(await writing(path.join(foreign, "src", "api.ts"))).toBeUndefined();
 });

 test("an unreadable bead names no tree, so the cwd and target comparisons are skipped", async () => {
  // Nothing read is nothing proven: the mutation proceeds and the cause is logged.
  beads = {};
  expect(await fromBash(foreign)).toBeUndefined();
  expect(await writing(path.join(foreign, "src", "api.ts"))).toBeUndefined();
  expect(warned.map(entry => entry.data?.bead)).toEqual([BEAD, BEAD]);
 });

 test("a bead declaring no scope allows any target inside the tree", async () => {
  // The containment comparison still applies; only the territory one is skipped.
  expect(await writing("src/other/api.ts")).toBeUndefined();
  expect(await writing("src/deep/anything.ts")).toBeUndefined();
 });

 test("a target path that cannot be resolved allows the mutation", async () => {
  // A NUL can never name a real path, so there is nothing to resolve and nothing to
  // compare. The gate declines to guess rather than declining the write.
  expect(await writing("src/api\0/handler.ts")).toBeUndefined();
 });

 test("a symlink cycle in the target path allows the mutation", async () => {
  // The walk gives up after `MAXSYMLINKS` hops. A cycle resolves to no path at
  // all, and a path that does not exist cannot be shown to escape — the kernel
  // would refuse this write with ELOOP long before the gate mattered.
  const first = path.join(owned, "loop-a");
  const second = path.join(owned, "loop-b");
  await fs.symlink(second, first);
  await fs.symlink(first, second);
  try {
   expect(await writing("loop-a/api.ts")).toBeUndefined();
  } finally {
   await fs.rm(first, { force: true });
   await fs.rm(second, { force: true });
  }
 });

 test("a declared worktree that does not exist allows the mutation", async () => {
  beads[BEAD] = { id: BEAD, status: "in_progress", assignee: "orc-impl-1", metadata: { worktree: path.join(root, "never-created") } };
  expect(await fromBash(foreign)).toBeUndefined();
  expect(await writing(path.join(foreign, "src", "api.ts"))).toBeUndefined();
 });

 test("an unresolvable cwd allows the mutation", async () => {
  expect(await fromBash(path.join(root, "gone"))).toBeUndefined();
 });

 test("JSON-string metadata enforces the same containment and scope as object metadata", async () => {
  beads[BEAD] = {
   id: BEAD,
   status: "in_progress",
   assignee: "orc-impl-1",
   metadata: JSON.stringify({ worktree: owned, scope: ["src/api/**"] }) as unknown as Record<string, unknown>,
  };
  expect((await fromBash(foreign))?.block).toBe(true);
  expect((await writing(path.join(foreign, "src", "api.ts")))?.block).toBe(true);
  expect((await writing("src/other.ts"))?.block).toBe(true);
  expect(await writing("src/api/handler.ts")).toBeUndefined();
 });

 test("an uninspectable edit is refused even with a forged compatibility path", async () => {
  expect(await gateWorktreeScope(claims, ctxAt(owned), "write", {})).toBeUndefined();
  expect(await gateWorktreeScope(claims, ctxAt(owned), "write", { path: 42 })).toBeUndefined();
  expect((await gateWorktreeScope(claims, ctxAt(owned), "edit", { input: "not a patch", path: "src/api.ts" }))?.block).toBe(true);
 });

 test("an unrecognised tool name allows the mutation", async () => {
  // The gate only knows where `write` and `edit` keep their target. Anything else
  // degrades to the cwd comparison rather than probing fields by guess.
  expect(await gateWorktreeScope(claims, ctxAt(owned), "notepad", { path: path.join(foreign, "x.ts") })).toBeUndefined();
 });
});

describe("G2 isolated checkout containment", () => {
 beforeEach(() => {
  process.env.OMP_WORKTREE_DIR = isolationBase;
  beads[BEAD] = { id: BEAD, status: "in_progress", assignee: "orc-impl-1", metadata: { worktree: owned, scope: ["src/api/**"] } };
 });

 test("allows only the current Git root, not its shared parent", async () => {
  expect(await fromBash(isolated)).toBeUndefined();
  expect((await fromBash(isolationBase))?.block).toBe(true);
  expect(await writing("src/api/handler.ts", isolated)).toBeUndefined();
  expect((await writing("src/other.ts", isolated))?.reason).toContain("metadata.scope");
 });

 test("refuses original, sibling, external and parent-relative destinations", async () => {
  for (const target of [
   path.join(owned, "src/api/x.ts"),
   path.join(isolationBase, "worker-B/src/api/x.ts"),
   path.join(foreign, "src/api/x.ts"),
   "../worker-B/src/api/x.ts",
  ]) expect((await writing(target, isolated))?.block).toBe(true);
 });

 test("resolves symlinks before parent traversal inside the isolated copy", async () => {
  const link = path.join(isolated, "escape");
  await fs.symlink(path.join(foreign, "src"), link);
  try {
   expect((await writing("escape/../x.ts", isolated))?.block).toBe(true);
  } finally {
   await fs.rm(link);
  }
 });

 test("does not accept bash cwd as the current worker's root", async () => {
  expect((await gateWorktreeScope(claims, ctxAt(isolated), "bash", { cwd: owned, command: "touch x" }))?.block).toBe(true);
 });

 test("uses an XDG native default isolation root instead of the legacy home path", async () => {
  const childFlag = "OMP_NATIVE_WORKTREE_ROOT_TEST";
  if (process.env[childFlag] === "1") {
   delete process.env.OMP_WORKTREE_DIR;
   const base = getWorktreesDir();
   expect(base).toBe(path.join(process.env.XDG_DATA_HOME!, "omp", "wt"));
   await fs.mkdir(base, { recursive: true });
   const workspace = await fs.mkdtemp(path.join(base, "orc-confinement-"));
   try {
    await promisify(execFile)("git", ["init", workspace], { timeout: 1500 });
    expect((await gateWorktreeScope(claims, ctxAt(workspace), "bash", { cwd: owned, command: "touch src/api/x.ts" }))?.block).toBe(true);
    expect(await writing("src/api/x.ts", workspace)).toBeUndefined();
   } finally {
    await fs.rm(workspace, { recursive: true, force: true });
   }
   return;
  }

  const xdgData = path.join(root, "xdg-data");
  await fs.mkdir(path.join(xdgData, "omp"), { recursive: true });
  const result = await promisify(execFile)(process.execPath, [
   "test", import.meta.path, "--test-name-pattern",
   "uses an XDG native default isolation root instead of the legacy home path",
  ], {
   env: { ...process.env, [childFlag]: "1", XDG_DATA_HOME: xdgData, OMP_WORKTREE_DIR: "" },
   timeout: 10_000,
  });
  expect(result.stderr + result.stdout).toContain("1 pass");
 });

 test("honors the runtime worktree.base override without trusting the original checkout", async () => {
  const childFlag = "OMP_WORKTREE_BASE_OVERRIDE_TEST";
  if (process.env[childFlag] === "1") {
   delete process.env.OMP_WORKTREE_DIR;
   setWorktreesDir(isolationBase);
   expect((await gateWorktreeScope(claims, ctxAt(isolated), "bash", { cwd: owned, command: "touch src/api/x.ts" }))?.block).toBe(true);
   expect(await writing("src/api/x.ts", isolated)).toBeUndefined();
   return;
  }

  const result = await promisify(execFile)(process.execPath, [
   "test", import.meta.path, "--test-name-pattern",
   "honors the runtime worktree.base override without trusting the original checkout",
  ], {
   env: { ...process.env, [childFlag]: "1", OMP_WORKTREE_DIR: "" },
   timeout: 10_000,
  });
  expect(result.stderr + result.stdout).toContain("1 pass");
 });
});

describe("G2 effective bash cwd and edit modes", () => {
 test("checks the actual bash cwd, including relative paths and the host root alias", async () => {
  expect((await gateWorktreeScope(claims, ctxAt(owned), "bash", { cwd: foreign, command: "touch x" }))?.block).toBe(true);
  expect((await gateWorktreeScope(claims, ctxAt(owned), "bash", { cwd: "../foreign", command: "touch x" }))?.block).toBe(true);
  expect(await gateWorktreeScope(claims, ctxAt(foreign), "bash", { cwd: owned, command: "touch x" })).toBeUndefined();
  expect(await gateWorktreeScope(claims, ctxAt(owned), "bash", { cwd: "/", command: "touch x" })).toBeUndefined();
 });

 test("checks replace paths and structured patch rename destinations", async () => {
  expect((await gateWorktreeScope(claims, ctxAt(owned), "edit", {
   path: path.join(foreign, "x.ts"), old_string: "old", new_string: "new",
  }))?.block).toBe(true);
  expect((await gateWorktreeScope(claims, ctxAt(owned), "edit", {
   path: "src/api.ts", edits: [{ op: "update", rename: path.join(foreign, "x.ts"), diff: "-old\n+new" }],
  }))?.block).toBe(true);
 });

 test("checks every apply-patch file and move destination", async () => {
  expect((await gateWorktreeScope(claims, ctxAt(owned), "edit", {
   input: `*** Begin Patch\n*** Update File: src/api.ts\n*** Move to: ${foreign}/x.ts\n@@\n-old\n+new\n*** End Patch`,
  }))?.block).toBe(true);
  expect((await gateWorktreeScope(claims, ctxAt(owned), "edit", {
   input: `*** Begin Patch\n*** Add File: ${foreign}/x.ts\n+new\n*** End Patch`,
  }))?.block).toBe(true);
 });

 test("checks sloppy edit targets instead of compatibility path hints", async () => {
  const input = `§${foreign}/x.ts\n«\nold\n»\nnew`;
  expect((await gateWorktreeScope(claims, ctxAt(owned), "edit", { input, path: "src/api.ts" }))?.block).toBe(true);
  expect(await gateWorktreeScope(claims, ctxAt(owned), "edit", {
   input: input.replace(`${foreign}/x.ts`, "src/api.ts"),
  })).toBeUndefined();
 });

});

describe("G2 scope of the check", () => {
 test("a bash cd out of the claimed tree is not caught", async () => {
  // FINDING, and deliberate. The gate reads a target path only for `write` and
  // `edit`, which declare one. A shell command's writes hide in redirections,
  // heredocs, `tee`, and anything a subshell expands, and a parser for that would
  // refuse honest commands more often than it caught an escape. `bash` keeps the
  // cwd comparison, which every command inherits, and G3's checkout refusal.
  expect(await fromBash(owned, "cd ../foreign && echo x > api.ts")).toBeUndefined();
 });

 test("a bash redirect out of the claimed tree is not caught", async () => {
  expect(await fromBash(owned, "echo x > ../foreign/src/api.ts")).toBeUndefined();
 });
});
