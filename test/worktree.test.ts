/**
 * G2 — writes stay inside the tree the claimed bead names.
 *
 * The gate compares realpaths, so the fixtures are real directories in a temp tree
 * rather than string literals: a stubbed `fs` would test the comparison and not the
 * resolution, and resolution is where the symlink hazard lives.
 *
 * `OMP_WORKTREE_DIR` is pinned per test. It is read at call time and defaults to
 * `~/.omp/wt`, which exists on a developer machine, so leaving it unset would make
 * the isolation-base exemption fire or not depending on the host.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { BdBead } from "../src/bd";
import * as actualBd from "../src/bd";
import { forgetClaim, recordClaim } from "../src/claim-state";

let beads: Record<string, BdBead>;

const original = { ...actualBd };
// `metadataString` is a pure helper the gate also imports from this module, so the
// replacement namespace keeps the real one by spreading the original first.
const mocked = { ...original, bdShow: async (id: string) => beads[id] ?? null };

mock.module("../src/bd", () => mocked);

// Dynamic: a static import is hoisted above `mock.module`, so the gate would bind the
// real `bd` and shell out.
const { GATED_WRITE_TOOLS, gateWorktreeScope } = await import("../src/gates/worktree");

afterAll(() => mock.module("../src/bd", () => original));

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

beforeAll(async () => {
	// realpath, because macOS resolves /var and /tmp through symlinks and the gate
	// compares resolved paths.
	root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "orc-wt-")));
	owned = path.join(root, "owned");
	foreign = path.join(root, "foreign");
	isolationBase = path.join(root, "isolation");
	isolated = path.join(isolationBase, "wt-1");
	await fs.mkdir(path.join(owned, "src", "deep"), { recursive: true });
	await fs.mkdir(foreign, { recursive: true });
	await fs.mkdir(isolated, { recursive: true });
	priorWorktreeDir = process.env.OMP_WORKTREE_DIR;
});

afterAll(async () => {
	if (priorWorktreeDir === undefined) delete process.env.OMP_WORKTREE_DIR;
	else process.env.OMP_WORKTREE_DIR = priorWorktreeDir;
	await fs.rm(root, { recursive: true, force: true });
});

beforeEach(() => {
	beads = { [BEAD]: { id: BEAD, metadata: { worktree: owned } } };
	// A base that does not exist, so its exemption cannot fire by accident.
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
		expect(await gateWorktreeScope(ctxAt(at()))).toBeUndefined();
	});
});

describe("G2 outside the claimed tree", () => {
	test("refuses a mutation from another tree, naming the bead", async () => {
		const result = await gateWorktreeScope(ctxAt(foreign));

		expect(result?.block).toBe(true);
		expect(result?.reason).toContain(BEAD);
		expect(result?.reason).toContain("metadata.worktree");
	});

	test("refuses a mutation from the parent of the claimed tree", async () => {
		// A prefix comparison alone would let `/root` pass for `/root/owned`; the gate
		// requires the cwd to be the tree or beneath it.
		expect((await gateWorktreeScope(ctxAt(root)))?.block).toBe(true);
	});

	test("refuses a sibling whose path is a string prefix of the claimed tree", async () => {
		// `owned-2` starts with `owned` as text but is a different directory, which is
		// why the gate appends a separator before comparing.
		const sibling = `${owned}-2`;
		await fs.mkdir(sibling, { recursive: true });
		try {
			expect((await gateWorktreeScope(ctxAt(sibling)))?.block).toBe(true);
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
			expect((await gateWorktreeScope(ctxAt(link)))?.block).toBe(true);
		} finally {
			await fs.rm(link, { force: true });
		}
	});

	test("refuses when any one of several claimed beads names another tree", async () => {
		beads["orc-43"] = { id: "orc-43", metadata: { worktree: foreign } };
		recordClaim({ actor: "orc-impl-1", beadIds: [BEAD, "orc-43"] });

		const result = await gateWorktreeScope(ctxAt(owned));

		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("orc-43");
	});
});

describe("G2 fail-open", () => {
	test("no observed claim allows the mutation", async () => {
		forgetClaim();
		expect(await gateWorktreeScope(ctxAt(foreign))).toBeUndefined();
	});

	test("a bead declaring no worktree allows the mutation", async () => {
		beads[BEAD] = { id: BEAD, metadata: {} };
		expect(await gateWorktreeScope(ctxAt(foreign))).toBeUndefined();
	});

	test("an unreadable bead allows the mutation", async () => {
		beads = {};
		expect(await gateWorktreeScope(ctxAt(foreign))).toBeUndefined();
	});

	test("a declared worktree that does not exist allows the mutation", async () => {
		beads[BEAD] = { id: BEAD, metadata: { worktree: path.join(root, "never-created") } };
		expect(await gateWorktreeScope(ctxAt(foreign))).toBeUndefined();
	});

	test("an unresolvable cwd allows the mutation", async () => {
		expect(await gateWorktreeScope(ctxAt(path.join(root, "gone")))).toBeUndefined();
	});

	test("metadata in the JSON-string form is not read as a worktree", async () => {
		// FINDING: the claim gate tolerates string-encoded metadata via its own
		// `metadataRecord`, but `metadataString` in src/bd.ts indexes `metadata`
		// directly, so a bead whose metadata arrives as a JSON string declares no
		// worktree here and the gate fails open. Documented, not patched.
		beads[BEAD] = { id: BEAD, metadata: JSON.stringify({ worktree: owned }) as unknown as Record<string, unknown> };
		expect(await gateWorktreeScope(ctxAt(foreign))).toBeUndefined();
	});
});

describe("G2 isolation base", () => {
	test.each([
		["the base itself", () => isolationBase],
		["a workspace under it", () => isolated],
	])("allows a mutation from %s", async (_label, at) => {
		// An isolated worker's cwd is its own copy, while the bead still names the
		// feature worktree it was cloned from, so the comparison would always fail.
		process.env.OMP_WORKTREE_DIR = isolationBase;
		expect(await gateWorktreeScope(ctxAt(at()))).toBeUndefined();
	});

	test("the exemption does not extend to a sibling of the base", async () => {
		process.env.OMP_WORKTREE_DIR = isolationBase;
		expect((await gateWorktreeScope(ctxAt(foreign)))?.block).toBe(true);
	});
});

describe("G2 scope of the check", () => {
	test("a bash cd out of the claimed tree is not caught", async () => {
		// FINDING: `gateWorktreeScope` takes only `ctx`, so it never sees the bash
		// command line and no `cd` form is parsed. A worker whose cwd is the owned
		// tree can `cd` elsewhere and write there within one bash call. Enforcing it
		// would mean tracking cwd across a command line; the gate deliberately does
		// not, and this test pins the current behaviour rather than asserting a wish.
		expect(await gateWorktreeScope(ctxAt(owned))).toBeUndefined();
	});

	test("an edit or write target outside the claimed tree is not caught either", async () => {
		// FINDING, same root cause: the check is keyed on the session's cwd, not on
		// the `path` argument of `edit`/`write`, so an absolute path into another
		// tree passes while the cwd is legitimate.
		expect(await gateWorktreeScope(ctxAt(owned))).toBeUndefined();
	});
});
