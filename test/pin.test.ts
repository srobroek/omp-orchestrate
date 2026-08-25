/**
 * G9 — aim `bd` at the run's database.
 *
 * The gate is exercised against the real tokeniser and the real marker reader, with
 * markers written to temporary directories: what decides the pin is a file on disk and
 * a cwd, so both are real here.
 *
 * `reviseBashEnv` is exercised alongside it, because the observable behaviour is the
 * revision the two of them produce together.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { runPinEnv } from "../src/gates/pin";
import { reviseBashEnv } from "../src/gates/readonly";

const made: string[] = [];

/** A repository directory, with an active-run marker when `repoRoot` is given. */
function repo(repoRoot?: string): string {
	const dir = mkdtempSync(join(tmpdir(), "orc-pin-"));
	made.push(dir);
	if (repoRoot !== undefined) {
		mkdirSync(join(dir, ".orchestration"), { recursive: true });
		writeFileSync(
			join(dir, ".orchestration", ".active-run"),
			JSON.stringify({ schema_version: 1, run_id: "orc-1", repo_root: repoRoot }),
		);
	}
	return dir;
}

const ctxAt = (cwd: string) => ({ cwd }) as unknown as ExtensionContext;

afterEach(() => {
	for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("G9 supplies the pin", () => {
	test("names the run repository's .beads, not its root", async () => {
		// The suffix is load-bearing: BEADS_DIR=<root> is ignored in silence, and the
		// walk-up wins, which is the very bug this gate exists to prevent.
		const run = repo();
		const copy = repo(run);

		expect(await runPinEnv(ctxAt(copy), { command: "bd ready --json" })).toEqual({
			BEADS_DIR: join(run, ".beads"),
		});
	});

	test("for a chain whose second call is pinned and first is not", async () => {
		// The replaced rule scanned the whole line, so the trailing -C suppressed it and
		// the unpinned update went unremarked. validate-rules.sh asserted that miss.
		const run = repo();
		const copy = repo(run);

		expect(
			await runPinEnv(ctxAt(copy), { command: "bd update orc-1 --claim && bd -C /elsewhere show orc-1" }),
		).toEqual({ BEADS_DIR: join(run, ".beads") });
	});

	test("for a bd call inside a wrapper shell's payload", async () => {
		const run = repo();
		const copy = repo(run);

		expect(await runPinEnv(ctxAt(copy), { command: `sh -c 'bd close orc-1'` })).toEqual({
			BEADS_DIR: join(run, ".beads"),
		});
	});
});

describe("G9 stays out of the way", () => {
	test("inside the run repository, where the walk-up already resolves", async () => {
		const run = repo();
		mkdirSync(join(run, ".orchestration"), { recursive: true });
		writeFileSync(
			join(run, ".orchestration", ".active-run"),
			JSON.stringify({ schema_version: 1, run_id: "orc-1", repo_root: run }),
		);

		expect(await runPinEnv(ctxAt(run), { command: "bd ready --json" })).toBeUndefined();
		expect(await runPinEnv(ctxAt(join(run, "src")), { command: "bd ready --json" })).toBeUndefined();
	});

	test("on a command that invokes no bd", async () => {
		const run = repo();
		const copy = repo(run);

		expect(await runPinEnv(ctxAt(copy), { command: "git status --porcelain" })).toBeUndefined();
		// Text about bd is not a bd call, which is what the regex could not tell.
		expect(await runPinEnv(ctxAt(copy), { command: `rg 'bd update|bd close' docs/` })).toBeUndefined();
	});

	test("when no marker names a run repository", async () => {
		const orphan = repo();

		expect(await runPinEnv(ctxAt(orphan), { command: "bd ready --json" })).toBeUndefined();
	});

	test("when the marker carries no repo_root", async () => {
		const dir = mkdtempSync(join(tmpdir(), "orc-pin-"));
		made.push(dir);
		mkdirSync(join(dir, ".orchestration"), { recursive: true });
		writeFileSync(join(dir, ".orchestration", ".active-run"), JSON.stringify({ schema_version: 1, run_id: "orc-1" }));

		expect(await runPinEnv(ctxAt(dir), { command: "bd ready --json" })).toBeUndefined();
	});

	test("on a call with no command", async () => {
		const run = repo();
		const copy = repo(run);

		expect(await runPinEnv(ctxAt(copy), {})).toBeUndefined();
		expect(await runPinEnv(ctxAt(copy), { command: "" })).toBeUndefined();
	});
});

describe("reviseBashEnv composes the environment gates", () => {
	test("carries both additions in one revision", () => {
		const result = reviseBashEnv(
			{ command: "bd ready", i: "pulling" },
			{ BD_READONLY: "1", BEADS_DIR: "/run/.beads" },
		);

		expect(result?.input?.env).toEqual({ BD_READONLY: "1", BEADS_DIR: "/run/.beads" });
		expect(result?.input?.command).toBe("bd ready");
		expect(result?.input?.i).toBe("pulling");
	});

	test("preserves an unrelated variable the caller set", () => {
		const result = reviseBashEnv({ command: "bd ready", env: { PATH: "/bin" } }, { BEADS_DIR: "/run/.beads" });

		expect(result?.input?.env).toEqual({ PATH: "/bin", BEADS_DIR: "/run/.beads" });
	});

	test("returns nothing when every addition is already present", () => {
		expect(
			reviseBashEnv({ command: "bd ready", env: { BEADS_DIR: "/run/.beads" } }, { BEADS_DIR: "/run/.beads" }),
		).toBeUndefined();
		expect(reviseBashEnv({ command: "bd ready" }, {})).toBeUndefined();
	});

	test("drops gate-only fields rather than forwarding them to execute", () => {
		const result = reviseBashEnv({ command: "bd ready", paths: ["derived"] }, { BEADS_DIR: "/run/.beads" });

		expect(result?.input).not.toHaveProperty("paths");
	});
});
