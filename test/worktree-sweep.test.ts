/**
 * `skills/orchestrate/scripts/worktree-sweep.ts` as an operator runs it: spawned with
 * fake `wt` and `git` binaries, asserted on exit code, stderr, the `wt remove` argv it
 * issued, and what moved on disk. The inventory flatten is tested directly for the
 * payload shapes Worktrunk has shipped.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyPath, flattenInventory } from "../skills/orchestrate/scripts/worktree-sweep";

const SWEEP = join(import.meta.dir, "..", "skills", "orchestrate", "scripts", "worktree-sweep.ts");

const FAKE_WT = `#!/usr/bin/env bash
set -eu
if [[ " $* " == *" list --format=json "* ]]; then
  if [[ "\${WT_LIST_EXIT:-0}" != 0 ]]; then
    exit "\${WT_LIST_EXIT}"
  fi
  printf '%s' "\${WT_LIST_JSON:-[]}"
  exit 0
fi
if [[ " $* " == *" remove "* ]]; then
  printf '%s\\n' "$*" >> "$WT_LOG"
  exit 0
fi
exit 2
`;

const FAKE_GIT = `#!/usr/bin/env bash
set -eu
if [[ " $* " == *" status --porcelain "* ]]; then
  printf '%s' "\${FAKE_GIT_STATUS:-}"
  exit "\${FAKE_GIT_STATUS_EXIT:-0}"
fi
if [[ " $* " == *" rev-parse --is-inside-work-tree "* ]]; then
  exit "\${FAKE_GIT_REV_PARSE_EXIT:-0}"
fi
if [[ " $* " == *" rev-parse --show-toplevel "* ]]; then
  printf '%s\\n' "\${FAKE_GIT_TOPLEVEL:?}"
  exit 0
fi
exit 2
`;

let binDir: string;
let wtBin: string;
let gitBin: string;
/** Per-test fixture root, resolved so the sweep's realpath output compares equal on macOS. */
let root: string;
let log: string;

// The fakes are written once: macOS charges a first-execution scan of roughly half a
// second to every freshly written script, which per-test fakes would pay twice per test.
beforeAll(() => {
	binDir = mkdtempSync(join(tmpdir(), "orc-sweep-bin-"));
	wtBin = join(binDir, "fake-wt");
	gitBin = join(binDir, "fake-git");
	writeFileSync(wtBin, FAKE_WT);
	writeFileSync(gitBin, FAKE_GIT);
	chmodSync(wtBin, 0o755);
	chmodSync(gitBin, 0o755);
});

afterAll(() => {
	rmSync(binDir, { recursive: true, force: true });
});

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "orc-sweep-")));
	log = join(root, "wt.log");
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

interface Outcome {
	code: number;
	stdout: string;
	stderr: string;
}

async function sweep(target: string, rows: unknown, extra: string[] = [], env: Record<string, string> = {}): Promise<Outcome> {
	const proc = Bun.spawn([process.execPath, SWEEP, ...extra, target], {
		env: {
			...process.env,
			WT_BIN: wtBin,
			GIT_BIN: gitBin,
			WT_LIST_JSON: JSON.stringify(rows),
			WT_LOG: log,
			FAKE_GIT_TOPLEVEL: join(root, "repo"),
			...env,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	return { code, stdout, stderr };
}

function dir(...parts: string[]): string {
	const made = join(root, ...parts);
	mkdirSync(made, { recursive: true });
	return made;
}

function removeLog(): string {
	return existsSync(log) ? readFileSync(log, "utf8") : "";
}

describe("sweeping one registered worktree", () => {
	test("a clean linked worktree is removed through wt remove without deleting its branch", async () => {
		const worktree = dir("registered");
		const result = await sweep(worktree, [{ path: worktree, is_main: false }]);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain(`swept: ${worktree}`);
		expect(removeLog()).toContain("remove --foreground");
		expect(removeLog()).not.toContain("--force-delete");
	});

	test("--discard-branch asks wt to delete the role branch too", async () => {
		const worktree = dir("review");
		const result = await sweep(worktree, [{ path: worktree, is_main: false }], ["--discard-branch"]);
		expect(result.code).toBe(0);
		expect(removeLog()).toContain("--force-delete");
	});

	test("a dirty worktree is refused with exit 1 and left in place", async () => {
		const worktree = dir("dirty");
		const result = await sweep(worktree, [{ path: worktree, is_main: false }], [], { FAKE_GIT_STATUS: " M source.rs\n" });
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("dirty, refusing");
		expect(existsSync(log)).toBe(false);
		expect(existsSync(worktree)).toBe(true);
	});

	test("the primary worktree is never removed", async () => {
		const worktree = dir("primary");
		const result = await sweep(worktree, [{ path: worktree, is_main: true }]);
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("primary worktree");
		expect(existsSync(log)).toBe(false);
	});

	test("a path Worktrunk does not list is a usage error, not a removal", async () => {
		const worktree = dir("stranger");
		const result = await sweep(worktree, [{ path: join(root, "elsewhere"), is_main: false }]);
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("not registered with Worktrunk");
		expect(existsSync(log)).toBe(false);
	});

	test("a schema-2 envelope resolves a linked worktree", async () => {
		const worktree = dir("registered");
		const result = await sweep(worktree, { schema: 2, items: [{ worktree: { path: worktree, main: false } }] });
		expect(result.code).toBe(0);
	});

	test("an empty schema-2 envelope is well-formed; the path is just unknown", async () => {
		const worktree = dir("registered");
		const result = await sweep(worktree, { schema: 2, items: [] });
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("not registered with Worktrunk");
	});

	test("a payload that is neither shape is fatal", async () => {
		const worktree = dir("registered");
		const result = await sweep(worktree, { schema: 2 });
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("invalid inventory");
	});

	test("a failing wt list is fatal", async () => {
		const worktree = dir("registered");
		const result = await sweep(worktree, [], [], { WT_LIST_EXIT: "7" });
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("wt list failed");
	});

	test("a missing target directory and a bad argument count are usage errors", async () => {
		const missing = await sweep(join(root, "absent"), []);
		expect(missing.code).toBe(2);
		expect(missing.stderr).toContain("not a directory");

		const tooMany = await sweep(dir("one"), [], [dir("two")]);
		expect(tooMany.code).toBe(2);
		expect(tooMany.stderr).toContain("usage:");
	});
});

describe("--prune", () => {
	test("quarantines a broken harness orphan without deleting its contents", async () => {
		const repo = dir("repo");
		const harness = dir("harness");
		const orphan = dir("harness", "worktree-10374");
		writeFileSync(join(orphan, ".git"), "gitdir: /missing/worktrees/10374\n");
		const quarantine = join(root, "quarantine");

		const result = await sweep(repo, [], ["--prune"], {
			FAKE_GIT_REV_PARSE_EXIT: "1",
			ORCHESTRATE_HARNESS_ROOT: harness,
			ORCHESTRATE_ORPHAN_QUARANTINE: quarantine,
		});

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("quarantined 1 orphan(s); refused 0 path(s)");
		expect(existsSync(orphan)).toBe(false);
		const moved = readdirSync(quarantine);
		expect(moved).toHaveLength(1);
		expect(moved[0]).toStartWith("worktree-10374.");
		expect(statSync(join(quarantine, moved[0]!, ".git")).isFile()).toBe(true);
	});

	test("skips a registered path and quarantines the orphan beside it", async () => {
		const repo = dir("repo");
		const harness = dir("harness");
		const registered = dir("harness", "registered");
		const orphan = dir("harness", "orphan");
		writeFileSync(join(orphan, ".git"), "gitdir: /missing/worktrees/orphan\n");
		const quarantine = join(root, "quarantine");

		const result = await sweep(repo, [{ path: registered, is_main: false }], ["--prune"], {
			FAKE_GIT_REV_PARSE_EXIT: "1",
			ORCHESTRATE_HARNESS_ROOT: harness,
			ORCHESTRATE_ORPHAN_QUARANTINE: quarantine,
		});

		expect(result.code).toBe(0);
		expect(existsSync(registered)).toBe(true);
		expect(existsSync(orphan)).toBe(false);
		expect(readdirSync(quarantine)).toHaveLength(1);
	});

	test("refuses a valid but unregistered worktree and reports exit 1", async () => {
		const repo = dir("repo");
		const harness = dir("harness");
		const candidate = dir("harness", "valid");
		writeFileSync(join(candidate, ".git"), "gitdir: /still/valid\n");

		const result = await sweep(repo, [], ["--prune"], { FAKE_GIT_REV_PARSE_EXIT: "0", ORCHESTRATE_HARNESS_ROOT: harness });

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("valid unregistered worktree");
		expect(existsSync(candidate)).toBe(true);
	});

	test("names a dirty unregistered worktree as dirty", async () => {
		const repo = dir("repo");
		const harness = dir("harness");
		dir("harness", "dirty");

		const result = await sweep(repo, [], ["--prune"], {
			FAKE_GIT_REV_PARSE_EXIT: "0",
			FAKE_GIT_STATUS: " M a.ts\n",
			ORCHESTRATE_HARNESS_ROOT: harness,
		});

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("dirty unregistered worktree");
	});

	test("refuses a directory with no .git file and the primary worktree", async () => {
		const repo = dir("repo");
		const harness = dir("harness");
		const unknown = dir("harness", "unknown");
		const primary = dir("harness", "primary");

		const result = await sweep(repo, [{ path: primary, is_main: true }], ["--prune"], {
			FAKE_GIT_REV_PARSE_EXIT: "1",
			ORCHESTRATE_HARNESS_ROOT: harness,
		});

		expect(result.code).toBe(1);
		expect(result.stderr).toContain(`refusing unknown harness directory: ${unknown}`);
		expect(result.stderr).toContain(`refusing primary worktree: ${primary}`);
		expect(result.stdout).toContain("quarantined 0 orphan(s); refused 2 path(s)");
		expect(existsSync(unknown)).toBe(true);
	});

	test("a second orphan with the same name lands beside the first, never over it", async () => {
		const repo = dir("repo");
		const harnessA = dir("harness-a");
		const harnessB = dir("harness-b");
		for (const harness of [harnessA, harnessB]) {
			mkdirSync(join(harness, "same"));
			writeFileSync(join(harness, "same", ".git"), "gitdir: /missing\n");
		}
		const quarantine = join(root, "quarantine");

		for (const harness of [harnessA, harnessB]) {
			const result = await sweep(repo, [], ["--prune"], {
				FAKE_GIT_REV_PARSE_EXIT: "1",
				ORCHESTRATE_HARNESS_ROOT: harness,
				ORCHESTRATE_ORPHAN_QUARANTINE: quarantine,
			});
			expect(result.code).toBe(0);
		}
		expect(readdirSync(quarantine)).toHaveLength(2);
	});

	test("a missing harness root override and a non-repository are usage errors", async () => {
		const repo = dir("repo");
		const absent = await sweep(repo, [], ["--prune"], { ORCHESTRATE_HARNESS_ROOT: join(root, "nowhere") });
		expect(absent.code).toBe(2);
		expect(absent.stderr).toContain("not a directory");

		const plain = await sweep(join(root, "absent"), [], ["--prune"]);
		expect(plain.code).toBe(2);
		expect(plain.stderr).toContain("not a directory");
	});
});

describe("flattenInventory", () => {
	test("a schema-1 array passes through with is_main normalised", () => {
		expect(flattenInventory([{ path: "/a", is_main: 1 }, { path: "/b" }])).toEqual([{ path: "/a", is_main: true }, { path: "/b" }]);
	});

	test("a schema-2 envelope lifts worktree.path and worktree.main", () => {
		expect(flattenInventory({ schema: 2, items: [{ worktree: { path: "/a", main: true } }, { worktree: { main: false } }] })).toEqual([
			{ path: "/a", is_main: true },
			{ is_main: false },
		]);
	});

	test.each([
		[{ schema: 2 }, "no items array"],
		[{ schema: 2, items: [1] }, "non-object item"],
		["rows", "not an array"],
		[[{ path: 7 }], "path is not a string"],
		[[null], "non-object item"],
	])("%j is invalid: %s", (payload, reason) => {
		const result = flattenInventory(payload);
		if (!("invalid" in result)) throw new Error(`accepted ${JSON.stringify(payload)}`);
		expect(result.invalid).toContain(reason);
	});
});

describe("classifyPath", () => {
	test("matches through symlinks and tells the primary from a linked worktree", () => {
		const real = dir("real");
		const alias = join(root, "alias");
		Bun.spawnSync(["ln", "-s", real, alias]);
		expect(classifyPath([{ path: alias, is_main: true }], real)).toBe("main");
		expect(classifyPath([{ path: real }], alias)).toBe("linked");
		expect(classifyPath([{ path: join(root, "other") }], real)).toBeUndefined();
	});
});
