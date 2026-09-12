import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { createClaimState } from "../src/claim-state";
import { gateBeadWriteFree, pinAddition, rebuildBashInput, reviseBashEnv } from "../src/gates/readonly";
import { markerPath } from "../src/run-state";

function api(toolNames: string[]): ExtensionAPI {
	const stub = { getAllTools: () => toolNames.map(name => ({ name, description: "" })) };
	return stub as unknown as ExtensionAPI;
}

function context(prompt: string, cwd = "/tmp/unrelated-helper"): ExtensionContext {
	const stub = { cwd, getSystemPrompt: () => [prompt] };
	return stub as unknown as ExtensionContext;
}

const WORKER_TOOLS = ["bash", "read", "yield"];

/** The readonly flag a revision carries, if any; the pin mirror alone is not a readonly decision. */
function readonlyFlag(revision: { input?: unknown } | undefined): string | undefined {
	const env = (revision?.input as { env?: Record<string, string> } | undefined)?.env;
	return env?.BD_READONLY;
}

let previousBeadsDir: string | undefined;
let previousMarkerOverride: string | undefined;

beforeEach(() => {
	previousBeadsDir = process.env.BEADS_DIR;
	previousMarkerOverride = process.env.ORCHESTRATE_MARKER_FILE;
	delete process.env.BEADS_DIR;
	delete process.env.ORCHESTRATE_MARKER_FILE;
});

afterEach(() => {
	if (previousBeadsDir === undefined) delete process.env.BEADS_DIR;
	else process.env.BEADS_DIR = previousBeadsDir;
	if (previousMarkerOverride === undefined) delete process.env.ORCHESTRATE_MARKER_FILE;
	else process.env.ORCHESTRATE_MARKER_FILE = previousMarkerOverride;
});

async function activeRun(): Promise<{ root: string; beadsDir: string }> {
	const root = await mkdtemp(join(tmpdir(), "orc-g1-"));
	const beadsDir = join(root, ".beads");
	process.env.BEADS_DIR = beadsDir;
	await mkdir(join(root, ".orchestration"), { recursive: true });
	await writeFile(markerPath(root), JSON.stringify({ schema_version: 1, run_id: "orc-g1" }));
	return { root, beadsDir };
}

describe("pinAddition", () => {
 test("mirrors an absolute process pin onto a call without one; leaves a caller pin; ignores no or relative pin", () => {
  expect(pinAddition({ command: "bd list" }, { BEADS_DIR: "/repo/.beads" })).toEqual({ BEADS_DIR: "/repo/.beads" });
  expect(pinAddition({ command: "bd list", env: { BEADS_DIR: "/mine/.beads" } }, { BEADS_DIR: "/repo/.beads" })).toEqual({});
  expect(pinAddition({ command: "bd list" }, {})).toEqual({});
  expect(pinAddition({ command: "bd list" }, { BEADS_DIR: ".beads" })).toEqual({});
 });

 test("a revision that carries the readonly flag also carries the pin", () => {
  const revised = reviseBashEnv({ command: "bd list" }, { ...pinAddition({ command: "bd list" }, { BEADS_DIR: "/repo/.beads" }), BD_READONLY: "1" });
  expect(revised?.input).toEqual({ command: "bd list", env: { BEADS_DIR: "/repo/.beads", BD_READONLY: "1" } });
 });
});

describe("G1 revision carries the pin with the readonly flag", () => {
	test("an active-run bash call without BEADS_DIR receives both", async () => {
		const root = await mkdtemp(join(tmpdir(), "orc-g1-pin-"));
		const saved = process.env.BEADS_DIR;
		try {
			const beads = join(root, ".beads");
			await mkdir(beads);
			await mkdir(join(root, ".orchestration"), { recursive: true });
			await writeFile(join(root, ".orchestration", ".active-run"), JSON.stringify({ schema_version: 1, run_id: "orc-run" }));
			process.env.BEADS_DIR = beads;
			const revised = await gateBeadWriteFree(api(WORKER_TOOLS), context("helper", root), { command: "bd list" });
			expect((revised?.input as { env: Record<string, string> }).env).toEqual({ BEADS_DIR: beads, BD_READONLY: "1" });
		} finally {
			if (saved === undefined) delete process.env.BEADS_DIR;
			else process.env.BEADS_DIR = saved;
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("G1 bead-write-free sandbox", () => {
	test("fails open without a process-local BEADS_DIR", async () => {
		expect(readonlyFlag(await gateBeadWriteFree(api(WORKER_TOOLS), context("helper"), { command: "bd update x" }))).toBeUndefined();
	});

	test.each(["", "relative/.beads"])("fails open for a blank or relative BEADS_DIR (%s)", async beadsDir => {
		process.env.BEADS_DIR = beadsDir;
		expect(readonlyFlag(await gateBeadWriteFree(api(WORKER_TOOLS), context("helper"), { command: "bd update x" }))).toBeUndefined();
	});

	test("fails open when the pinned repository has no active marker", async () => {
		const root = await mkdtemp(join(tmpdir(), "orc-g1-no-marker-"));
		try {
			process.env.BEADS_DIR = join(root, ".beads");
			expect(readonlyFlag(await gateBeadWriteFree(api(WORKER_TOOLS), context("helper", root), { command: "bd update x" }))).toBeUndefined();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test.each(["{broken", '{"schema_version":1}', '{"schema_version":1,"run_id":false}'])(
		"fails open without injecting readonly for malformed marker %s",
		async body => {
			const root = await mkdtemp(join(tmpdir(), "orc-g1-malformed-"));
			try {
				process.env.BEADS_DIR = join(root, ".beads");
				await mkdir(join(root, ".orchestration"), { recursive: true });
				await writeFile(markerPath(root), body);
				expect(readonlyFlag(await gateBeadWriteFree(api(WORKER_TOOLS), context("helper", root), { command: "bd update x" }))).toBeUndefined();
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	);

	test("fails open when the active marker is unreadable", async () => {
		const { root } = await activeRun();
		const denied = Object.assign(new Error("permission denied"), { code: "EACCES" });
		const readSpy = spyOn(fs, "readFile").mockRejectedValue(denied);
		try {
			expect(readonlyFlag(await gateBeadWriteFree(api(WORKER_TOOLS), context("helper", root), { command: "bd update x" }))).toBeUndefined();
		} finally {
			readSpy.mockRestore();
			await rm(root, { recursive: true, force: true });
		}
	});

	test("fails open when the active marker is removed", async () => {
		const { root } = await activeRun();
		try {
			await rm(markerPath(root));
			expect(readonlyFlag(await gateBeadWriteFree(api(WORKER_TOOLS), context("helper", root), { command: "bd update x" }))).toBeUndefined();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("honors a custom marker path and stops readonly after marker removal", async () => {
		const root = await mkdtemp(join(tmpdir(), "orc-g1-custom-marker-"));
		try {
			process.env.BEADS_DIR = join(root, ".beads");
			process.env.ORCHESTRATE_MARKER_FILE = "run-state/marker";
			await mkdir(join(root, "run-state"), { recursive: true });
			await writeFile(markerPath(root), JSON.stringify({ run_id: "orc-g1" }));
			expect(await gateBeadWriteFree(api(WORKER_TOOLS), context("helper", root), { command: "bd update x" })).toEqual({
				input: { command: "bd update x", env: { BEADS_DIR: process.env.BEADS_DIR, BD_READONLY: "1" } },
			});
			await rm(markerPath(root));
			expect(readonlyFlag(await gateBeadWriteFree(api(WORKER_TOOLS), context("helper", root), { command: "bd update x" }))).toBeUndefined();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("injects readonly for a helper with an active marker", async () => {
		const { root } = await activeRun();
		try {
			const result = await gateBeadWriteFree(api(WORKER_TOOLS), context("helper", root), {
				command: "bd update x",
				env: { FOO: "bar" },
			});
			expect(result?.input?.env).toEqual({ FOO: "bar", BEADS_DIR: process.env.BEADS_DIR, BD_READONLY: "1" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("uses the session marker when a linked worktree shares the primary BEADS_DIR", async () => {
		const primary = await mkdtemp(join(tmpdir(), "orc-g1-primary-"));
		const linked = await mkdtemp(join(tmpdir(), "orc-g1-linked-"));
		try {
			process.env.BEADS_DIR = join(primary, ".beads");
			await mkdir(join(linked, ".orchestration"), { recursive: true });
			await writeFile(markerPath(linked), JSON.stringify({ schema_version: 1, run_id: "orc-g1" }));
			expect(await gateBeadWriteFree(api(WORKER_TOOLS), context("helper", linked), { command: "bd update x" })).toEqual({
				input: { command: "bd update x", env: { BEADS_DIR: join(primary, ".beads"), BD_READONLY: "1" } },
			});
		} finally {
			await Promise.all([
				rm(primary, { recursive: true, force: true }),
				rm(linked, { recursive: true, force: true }),
			]);
		}
	});

	test("preserves a contract-bound orc writer with an active marker", async () => {
		const { root } = await activeRun();
		try {
			expect(readonlyFlag(await gateBeadWriteFree(api(WORKER_TOOLS), context("ORC-ROLE: implementer", root), { command: "bd comment x" }))).toBeUndefined();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("keeps an unrelated same-cwd helper writable without BEADS_DIR", async () => {
		const { root } = await activeRun();
		try {
			delete process.env.BEADS_DIR;
			expect(readonlyFlag(await gateBeadWriteFree(api(WORKER_TOOLS), context("helper", root), { command: "bd update x" }))).toBeUndefined();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("carries real bash params through and drops derived fields", async () => {
		const { root } = await activeRun();
		try {
			const result = await gateBeadWriteFree(api(WORKER_TOOLS), context("helper", root), {
				command: "bd show x",
				cwd: "/tmp",
				timeout: 5,
				derivedGateOnlyField: "must not survive",
			});
			expect(result?.input).toEqual({ command: "bd show x", cwd: "/tmp", timeout: 5, env: { BEADS_DIR: process.env.BEADS_DIR, BD_READONLY: "1" } });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("rebuilds a runtime database rewrite from allowlisted bash fields", () => {
		const rebuilt = rebuildBashInput({
			command: "echo ok",
			cwd: "/tmp",
			env: { BEADS_DIR: "/canonical/.beads" },
			derivedGateOnlyField: "must not survive",
		});
		expect(rebuilt).toEqual({ command: "echo ok", cwd: "/tmp", env: { BEADS_DIR: "/canonical/.beads" } });
	});

	test("does not re-revise an already-sandboxed call", async () => {
		const { root } = await activeRun();
		try {
			// The readonly flag alone is not complete: the pin mirror still has to be added once.
			const pin = process.env.BEADS_DIR as string;
			const once = await gateBeadWriteFree(api(WORKER_TOOLS), context("helper", root), { command: "bd show x", env: { BD_READONLY: "1" } });
			expect((once?.input as { env: Record<string, string> }).env).toEqual({ BD_READONLY: "1", BEADS_DIR: pin });
			expect(await gateBeadWriteFree(api(WORKER_TOOLS), context("helper", root), { command: "bd show x", env: { BD_READONLY: "1", BEADS_DIR: pin } })).toBeUndefined();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("G1 refuses a sandboxed command that edits the sandbox variable", () => {
	test.each([
		["an inline assignment", "BD_READONLY=0 bd update x --status closed"],
		["an empty inline assignment", "BD_READONLY= bd update x --status closed"],
		["an env assignment", "env BD_READONLY=0 bd update x --status closed"],
		["env -u", "env -u BD_READONLY bd update x --status closed"],
		["env --unset=", "env --unset=BD_READONLY bd update x --status closed"],
		["unset in an earlier segment", "unset BD_READONLY; bd update x --status closed"],
		["export in an earlier segment", "export BD_READONLY=0 && bd update x --status closed"],
		["a wrapper shell", "sh -c 'BD_READONLY=0 bd update x --status closed'"],
		["env -S carrying the assignment", "env -S 'BD_READONLY=0 bd update x --status closed'"],
	])("refuses %s", async (_label, command) => {
		const { root } = await activeRun();
		try {
			const result = await gateBeadWriteFree(api(WORKER_TOOLS), context("helper", root), { command });
			expect(result?.block, command).toBe(true);
			expect(result?.reason, command).toContain("BD_READONLY=1 is the read-only sandbox");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("a structured env override is rewritten back to the sandbox, not refused", async () => {
		const { root } = await activeRun();
		try {
			const result = await gateBeadWriteFree(api(WORKER_TOOLS), context("helper", root), { command: "bd update x", env: { BD_READONLY: "0" } });
			expect(result?.block).toBeUndefined();
			expect(readonlyFlag(result)).toBe("1");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("a read that names the variable is a read", async () => {
		const { root } = await activeRun();
		try {
			for (const command of ["printenv BD_READONLY", "echo $BD_READONLY && bd show x", "bd show x"]) {
				const result = await gateBeadWriteFree(api(WORKER_TOOLS), context("helper", root), { command });
				expect(result?.block, command).toBeUndefined();
				expect(readonlyFlag(result), command).toBe("1");
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("only the sandboxed helper is refused", async () => {
		const { root } = await activeRun();
		const escape = "env -u BD_READONLY bd update x --status closed";
		try {
			// A contract-bound role is never sandboxed, so the text is its own business.
			expect(await gateBeadWriteFree(api(WORKER_TOOLS), context("ORC-ROLE: implementer", root), { command: escape })).toEqual({
				input: { command: escape, env: { BEADS_DIR: process.env.BEADS_DIR } },
			});
			// Without the run, G1 fails open on the text as it does on the environment.
			await rm(markerPath(root));
			expect(await gateBeadWriteFree(api(WORKER_TOOLS), context("helper", root), { command: escape })).toEqual({
				input: { command: escape, env: { BEADS_DIR: process.env.BEADS_DIR } },
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("claim state", () => {
	let claims = createClaimState();
	beforeEach(() => { claims = createClaimState(); });

	test("records and returns an observation", () => {
		claims.recordClaim({ actor: "arch-1", beadIds: ["orc-1"] });
		expect(claims.observedClaim()).toEqual({ actor: "arch-1", beadIds: ["orc-1"] });
	});

	test("a later report cannot hide a previous acquisition", () => {
		claims.recordClaim({ actor: "w-1", beadIds: ["orc-1"] });
		claims.recordClaim({ actor: "w-1", beadIds: ["orc-2"] });
		expect(claims.observedClaim()?.beadIds).toEqual(["orc-1", "orc-2"]);
		claims.recordClaim({ actor: "other", beadIds: ["orc-3"] });
		expect(claims.observedClaim()).toEqual({ actor: "w-1", beadIds: ["orc-1", "orc-2"] });
		claims.forgetClaim();
		claims.recordClaim({ actor: "other", beadIds: ["orc-3"] });
		expect(claims.observedClaim()?.beadIds).toEqual(["orc-3"]);
	});

	test("ignores an observation with no actor or no beads", () => {
		claims.recordClaim({ actor: "", beadIds: ["orc-1"] });
		expect(claims.observedClaim()).toBeUndefined();
		claims.recordClaim({ actor: "w-1", beadIds: [] });
		expect(claims.observedClaim()).toBeUndefined();
	});
	
});
