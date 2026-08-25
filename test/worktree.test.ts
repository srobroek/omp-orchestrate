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

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext, ToolCallEventResult } from "@oh-my-pi/pi-coding-agent";
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

	test("metadata in the JSON-string form is not read as a worktree or a scope", async () => {
		// FINDING: the claim gate tolerates string-encoded metadata via its own
		// `metadataRecord`, but `metadataString` in src/bd.ts indexes `metadata`
		// directly, so a bead whose metadata arrives as a JSON string declares no
		// worktree here and the gate fails open. `scopeOf` reads the same field off the
		// same value and finds nothing either, which keeps one gate from enforcing half
		// a bead. Documented, not patched.
		beads[BEAD] = {
			id: BEAD,
			metadata: JSON.stringify({ worktree: owned, scope: ["src/api/**"] }) as unknown as Record<string, unknown>,
		};
		expect(await fromBash(foreign)).toBeUndefined();
		expect(await writing(path.join(foreign, "src", "api.ts"))).toBeUndefined();
	});

	test("an input carrying no path at all allows the mutation", async () => {
		expect(await gateWorktreeScope(ctxAt(owned), "write", {})).toBeUndefined();
		expect(await gateWorktreeScope(ctxAt(owned), "write", { path: 42 })).toBeUndefined();
		expect(await gateWorktreeScope(ctxAt(owned), "edit", { input: "not a patch" })).toBeUndefined();
	});

	test("an unrecognised tool name allows the mutation", async () => {
		// The gate only knows where `write` and `edit` keep their target. Anything else
		// degrades to the cwd comparison rather than probing fields by guess.
		expect(await gateWorktreeScope(ctxAt(owned), "notepad", { path: path.join(foreign, "x.ts") })).toBeUndefined();
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
		expect(await fromBash(at())).toBeUndefined();
	});

	test("the exemption covers target paths in the isolation copy too", async () => {
		// A write in the copy resolves outside the tree the bead names, so exempting the
		// cwd and then refusing the write would exempt nothing.
		process.env.OMP_WORKTREE_DIR = isolationBase;
		beads[BEAD] = { id: BEAD, metadata: { worktree: owned, scope: ["src/api/**"] } };
		expect(await writing(path.join(isolated, "src", "other.ts"), isolated)).toBeUndefined();
	});

	test("the exemption does not extend to a sibling of the base", async () => {
		process.env.OMP_WORKTREE_DIR = isolationBase;
		expect((await fromBash(foreign))?.block).toBe(true);
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
