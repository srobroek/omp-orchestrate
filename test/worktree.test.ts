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

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionContext, ToolCallEventResult } from "@oh-my-pi/pi-coding-agent";
import type { BdBead } from "../src/bd";
import * as actualBd from "../src/bd";
import { forgetClaim, recordClaim } from "../src/claim-state";
import { GATED_WRITE_TOOLS, gateWorktreeScope } from "../src/gates/worktree";

let beads: Record<string, BdBead>;

// Restore each export without leaving a process-wide module mock for later suites.
const showSpy = spyOn(actualBd, "bdShow").mockImplementation(async (id: string) => beads[id] ?? null);
const listSpy = spyOn(actualBd, "bdList").mockResolvedValue([]);

afterAll(() => {
 showSpy.mockRestore();
 listSpy.mockRestore();
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
function fromBash(cwd: string, command = "echo hi"): Verdict {
 return gateWorktreeScope(ctxAt(cwd), "bash", { command });
}

/** The gate as `src/index.ts` calls it for a `write` of one file. */
function writing(target: string, cwd = owned): Verdict {
 return gateWorktreeScope(ctxAt(cwd), "write", { path: target, content: "x" });
}

/** The gate as `src/index.ts` calls it for an `edit` patch against one file. */
function editing(target: string, cwd = owned): Verdict {
 return gateWorktreeScope(ctxAt(cwd), "edit", { input: `[${target}#A1B2]\nPUT 1.=1:\n+x` });
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
 beads = { [BEAD]: { id: BEAD, metadata: { worktree: owned } } };
 // Disable isolated-root discovery outside the isolation-specific cases.
 process.env.OMP_WORKTREE_DIR = path.join(root, "no-such-isolation-base");
 recordClaim({ actor: "orc-impl-1", beadIds: [BEAD] });
});

afterEach(forgetClaim);

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
  beads["orc-43"] = { id: "orc-43", metadata: { worktree: foreign } };
  recordClaim({ actor: "orc-impl-1", beadIds: [BEAD, "orc-43"] });

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
  const result = await gateWorktreeScope(ctxAt(owned), "edit", {
   input: `[${path.join(owned, "src", "api.ts")}#A1B2]\nPUT 1.=1:\n+x\nMV ${path.join(foreign, "src", "api.ts")}`,
  });

  expect(result?.block).toBe(true);
 });

 test("refuses a quoted `MV` destination out of the tree", async () => {
  const result = await gateWorktreeScope(ctxAt(owned), "edit", {
   input: `[${path.join(owned, "src", "api.ts")}#A1B2]\nMV "${path.join(foreign, "src", "a b.ts")}"`,
  });

  expect(result?.block).toBe(true);
  // The quotes are stripped, so the reason names the path and not `"path"`.
  expect(result?.reason).toContain(path.join(foreign, "src", "a b.ts"));
 });

 test("refuses the escaping target among several the patch names", async () => {
  const result = await gateWorktreeScope(ctxAt(owned), "edit", {
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
  beads[BEAD] = { id: BEAD, metadata: { worktree: owned, scope: ["src/api/**"] } };
 });

 test.each(["src/**", "/src/**", "///src/**", "././src/**", "/././src/**///"])(
  "uses root-relative acceptance for %s and detects a competing owner of the same write",
  async (scope) => {
   beads[BEAD] = { id: BEAD, metadata: { worktree: owned, scope: [scope] } };
   expect(await writing("src/api.ts")).toBeUndefined();
   expect((await writing("docs/api.ts"))?.block).toBe(true);
   listSpy.mockResolvedValueOnce([
    { id: "orc-other", status: "in_progress", assignee: "other-worker", metadata: { scope: ["src/**"] } },
   ]);
   expect((await writing("src/api.ts"))?.reason).toContain("scope conflict");
  },
 );

 test.each(["", "/", "///", "./", "././", "/././//"])(
  "an explicit whole-tree scope %j grants in-tree writes but not escapes",
  async (scope) => {
   beads[BEAD] = { id: BEAD, metadata: { worktree: owned, scope: [scope] } };
   expect(await writing("docs/api.ts")).toBeUndefined();
   expect((await writing("../foreign/src/api.ts"))?.reason).toContain("metadata.worktree");
   listSpy.mockResolvedValueOnce([
    { id: "orc-other", status: "in_progress", assignee: "other-worker", metadata: { scope: ["docs/**"] } },
   ]);
   expect((await writing("docs/api.ts"))?.reason).toContain("scope conflict");
  },
 );

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
  beads[BEAD] = { id: BEAD, metadata: { worktree: owned, scope: ["src/api"] } };
  expect(await writing("src/api/deep/handler.ts")).toBeUndefined();
 });

 test("allows any of several declared globs to name the target", async () => {
  beads[BEAD] = { id: BEAD, metadata: { worktree: owned, scope: ["docs/**", "src/deep/**"] } };
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
  beads[BEAD] = { id: BEAD, metadata: { worktree: owned, scope: JSON.stringify(["src/api/**"]) } };
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
  beads["orc-43"] = { id: "orc-43", metadata: { worktree: owned, scope: ["src/deep/**"] } };
  recordClaim({ actor: "orc-impl-1", beadIds: [BEAD, "orc-43"] });

  expect(await writing("src/api/handler.ts")).toBeUndefined();
  expect(await writing("src/deep/handler.ts")).toBeUndefined();
 });

 test("refuses a target neither claimed bead's scope names, listing both", async () => {
  beads["orc-43"] = { id: "orc-43", metadata: { worktree: owned, scope: ["src/deep/**"] } };
  recordClaim({ actor: "orc-impl-1", beadIds: [BEAD, "orc-43"] });

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
  beads["orc-43"] = { id: "orc-43", metadata: { worktree: owned } };
  recordClaim({ actor: "orc-impl-1", beadIds: [BEAD, "orc-43"] });

  expect(await writing("src/api/handler.ts")).toBeUndefined();
  expect((await writing("src/other/handler.ts"))?.block).toBe(true);
 });
});

describe("G2 fail-open", () => {
 test("no observed claim allows the mutation", async () => {
  forgetClaim();
  expect(await fromBash(foreign)).toBeUndefined();
  expect(await writing(path.join(foreign, "src", "api.ts"))).toBeUndefined();
 });

 test("a bead declaring no worktree allows the mutation", async () => {
  beads[BEAD] = { id: BEAD, metadata: {} };
  expect(await fromBash(foreign)).toBeUndefined();
  expect(await writing(path.join(foreign, "src", "api.ts"))).toBeUndefined();
 });

 test("an unreadable bead allows the mutation", async () => {
  beads = {};
  expect(await fromBash(foreign)).toBeUndefined();
  expect(await writing(path.join(foreign, "src", "api.ts"))).toBeUndefined();
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
  beads[BEAD] = { id: BEAD, metadata: { worktree: path.join(root, "never-created") } };
  expect(await fromBash(foreign)).toBeUndefined();
  expect(await writing(path.join(foreign, "src", "api.ts"))).toBeUndefined();
 });

 test("an unresolvable cwd allows the mutation", async () => {
  expect(await fromBash(path.join(root, "gone"))).toBeUndefined();
 });

 test("JSON-string metadata enforces the same containment and scope as object metadata", async () => {
  beads[BEAD] = {
   id: BEAD,
   metadata: JSON.stringify({ worktree: owned, scope: ["src/api/**"] }) as unknown as Record<string, unknown>,
  };
  expect((await fromBash(foreign))?.block).toBe(true);
  expect((await writing(path.join(foreign, "src", "api.ts")))?.block).toBe(true);
  expect((await writing("src/other.ts"))?.block).toBe(true);
  expect(await writing("src/api/handler.ts")).toBeUndefined();
 });

 test("an uninspectable edit is refused even with a forged compatibility path", async () => {
  expect(await gateWorktreeScope(ctxAt(owned), "write", {})).toBeUndefined();
  expect(await gateWorktreeScope(ctxAt(owned), "write", { path: 42 })).toBeUndefined();
  expect((await gateWorktreeScope(ctxAt(owned), "edit", { input: "not a patch", path: "src/api.ts" }))?.block).toBe(true);
 });

 test("an unrecognised tool name allows the mutation", async () => {
  // The gate only knows where `write` and `edit` keep their target. Anything else
  // degrades to the cwd comparison rather than probing fields by guess.
  expect(await gateWorktreeScope(ctxAt(owned), "notepad", { path: path.join(foreign, "x.ts") })).toBeUndefined();
 });
});

describe("G2 isolated checkout containment", () => {
 beforeEach(() => {
  process.env.OMP_WORKTREE_DIR = isolationBase;
  beads[BEAD] = { id: BEAD, metadata: { worktree: owned, scope: ["src/api/**"] } };
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
  expect((await gateWorktreeScope(ctxAt(isolated), "bash", { cwd: owned, command: "touch x" }))?.block).toBe(true);
 });
});

describe("G2 effective bash cwd and edit modes", () => {
 test("checks the actual bash cwd, including relative paths and the host root alias", async () => {
  expect((await gateWorktreeScope(ctxAt(owned), "bash", { cwd: foreign, command: "touch x" }))?.block).toBe(true);
  expect((await gateWorktreeScope(ctxAt(owned), "bash", { cwd: "../foreign", command: "touch x" }))?.block).toBe(true);
  expect(await gateWorktreeScope(ctxAt(foreign), "bash", { cwd: owned, command: "touch x" })).toBeUndefined();
  expect(await gateWorktreeScope(ctxAt(owned), "bash", { cwd: "/", command: "touch x" })).toBeUndefined();
 });

 test("checks replace paths and structured patch rename destinations", async () => {
  expect((await gateWorktreeScope(ctxAt(owned), "edit", {
   path: path.join(foreign, "x.ts"), old_string: "old", new_string: "new",
  }))?.block).toBe(true);
  expect((await gateWorktreeScope(ctxAt(owned), "edit", {
   path: "src/api.ts", edits: [{ op: "update", rename: path.join(foreign, "x.ts"), diff: "-old\n+new" }],
  }))?.block).toBe(true);
 });

 test("checks every apply-patch file and move destination", async () => {
  expect((await gateWorktreeScope(ctxAt(owned), "edit", {
   input: `*** Begin Patch\n*** Update File: src/api.ts\n*** Move to: ${foreign}/x.ts\n@@\n-old\n+new\n*** End Patch`,
  }))?.block).toBe(true);
  expect((await gateWorktreeScope(ctxAt(owned), "edit", {
   input: `*** Begin Patch\n*** Add File: ${foreign}/x.ts\n+new\n*** End Patch`,
  }))?.block).toBe(true);
 });

 test("checks sloppy edit targets instead of compatibility path hints", async () => {
  const input = `<SM:EDIT path="${foreign}/x.ts">\n<SM:FIND>\nold\n</SM:FIND>\n<SM:PUT>\nnew\n</SM:PUT>\n</SM:EDIT>`;
  expect((await gateWorktreeScope(ctxAt(owned), "edit", { input, path: "src/api.ts" }))?.block).toBe(true);
  expect(await gateWorktreeScope(ctxAt(owned), "edit", {
   input: input.replace(`${foreign}/x.ts`, "src/api.ts"),
  })).toBeUndefined();
 });

 test("blocks work when the acquired queue candidate overlaps an active claim", async () => {
  beads[BEAD] = { id: BEAD, metadata: { worktree: owned, scope: ["src/api/**"] } };
  listSpy.mockResolvedValueOnce([{ id: "orc-other", status: "in_progress", assignee: "other-worker", metadata: { scope: ["src/api/**"] } }]);
  expect((await writing("src/api/x.ts"))?.reason).toContain("scope conflict");
 });
});

describe("G2 conflicting owners can reconcile without writing product files", () => {
 const actor = "orc-impl-1";
 beforeEach(() => {
  beads[BEAD] = { id: BEAD, status: "in_progress", assignee: actor, metadata: { role: "implementer", worktree: owned, scope: ["src/api/**"] } };
  listSpy.mockResolvedValue([{ id: "orc-other", status: "in_progress", assignee: "other-worker", metadata: { role: "implementer", scope: ["src/api/**"] } }]);
 });
 afterEach(() => listSpy.mockResolvedValue([]));

 test("refuses product edits while both overlapping owners remain live", async () => {
  expect((await editing("src/api/x.ts"))?.block).toBe(true);
 });

 test.each([
  `BEADS_ACTOR=${actor} bd comment ${BEAD} "NOTE overlapping owner; coordinating release"`,
  `BEADS_ACTOR=${actor} bd comments add ${BEAD} "REPORTED findings"`,
  `BEADS_ACTOR=${actor} bd update ${BEAD} --assignee "" --json`,
  `BEADS_ACTOR=${actor} bd update ${BEAD} --status open --assignee ""`,
  `bd show ${BEAD} --json`,
  `bd comments ${BEAD}`,
  "bd list --json",
  `env BD_ACTOR='${actor}' b'd' comment ${BEAD} 'literal $(touch changed.ts); > \`cmd\` \\ $HOME'`,
  `BEADS_ACTOR=${actor} bd comment ${BEAD} pre" quoted "'literal'`,
  `BEADS_ACTOR=${actor} bd comment ${BEAD} ''`,
  `BEADS_ACTOR=${actor} bd comment ${BEAD} 'line one\nline two'`,
 ])("allows a standalone reconciliation operation: %s", async (command) => {
  expect(await fromBash(owned, command)).toBeUndefined();
 });

 test.each([
  `BEADS_ACTOR=${actor} bd comment ${BEAD} "NOTE conflict"; touch changed.ts`,
  `BEADS_ACTOR=${actor} bd comment ${BEAD} "NOTE conflict" > changed.ts`,
  `BEADS_ACTOR=${actor} bd comment ${BEAD} "NOTE $(touch changed.ts)"`,
  `BEADS_ACTOR=other-worker bd comment ${BEAD} "NOTE conflict"`,
  `BEADS_ACTOR=${actor} bd comment orc-other "NOTE conflict"`,
  `BEADS_ACTOR=${actor} bd update ${BEAD} --assignee "" --title hijacked`,
  `BEADS_ACTOR=${actor} bd create "unrelated work"`,
  `BEADS_ACTOR=${actor} bd comment ${BEAD} "$HOME"`,
  `BEADS_ACTOR=${actor} bd comment ${BEAD} "\`touch changed.ts\`"`,
  `BEADS_ACTOR=${actor} bd comment ${BEAD} "escaped \\"quote"`,
  `BEADS_ACTOR=${actor} bd comment ${BEAD} escaped\\ word`,
  `BEADS_ACTOR=${actor} bd comment ${BEAD} 'unterminated`,
  `BEADS_ACTOR=${actor} bd comment ${BEAD} ok\nbd list`,
  `BEADS_ACTOR=${actor} bd comment ${BEAD} *`,
  `BEADS_ACTOR=${actor} bd comment ${BEAD} ok # comment`,
  `sh -c 'bd list'`,
 ])("refuses side effects or authority outside reconciliation: %s", async (command) => {
  expect((await fromBash(owned, command))?.block).toBe(true);
 });

 test("bounds late-forbidden control parsing in a killable subprocess", async () => {
  const childFlag = "OMP_WORKTREE_CONTROL_ADVERSARY";
  if (process.env[childFlag] === "1") {
   // No command is executed: only the gate sees these adversarial strings.
   // An unquoted run has exponentially many partitions in the former regex.
   const prefix = `BEADS_ACTOR=${actor} bd comment ${BEAD} ${"a".repeat(32_768)}`;
   const started = performance.now();
   for (const suffix of ["; touch changed.ts", " > changed.ts", '"$(touch changed.ts)"']) {
    expect((await fromBash(owned, prefix + suffix))?.block).toBe(true);
   }
   // Exclude child startup and fixtures. The old regex may eventually fall back
   // instead of hanging, but still spends seconds parsing these three refusals.
   expect(performance.now() - started).toBeLessThan(2_000);
   return;
  }
  // A test timeout cannot interrupt synchronous regex backtracking. The parent
  // stays responsive and kills the separate Bun process even on the old code.
  const result = await promisify(execFile)(process.execPath, [
   "test", import.meta.path, "--test-name-pattern",
   "bounds late-forbidden control parsing in a killable subprocess",
  ], {
   env: { ...process.env, [childFlag]: "1" },
   timeout: 10_000,
   killSignal: "SIGKILL",
  });
  expect(result.stderr + result.stdout).toContain("1 pass");
 }, 15_000);

 test("does not exempt a release after the observed owner lost the claim", async () => {
  beads[BEAD]!.assignee = "replacement";
  expect((await fromBash(owned, `BEADS_ACTOR=${actor} bd update ${BEAD} --assignee ""`))?.block).toBe(true);
 });

 test("does not allow an execution-environment hook with a control command", async () => {
  expect((await gateWorktreeScope(ctxAt(owned), "bash", {
   command: `bd comment ${BEAD} "NOTE conflict"`,
   env: { BEADS_ACTOR: actor, BASH_ENV: "/tmp/mutating-hook" },
  }))?.block).toBe(true);
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
