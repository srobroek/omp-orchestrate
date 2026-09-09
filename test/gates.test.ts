import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { createClaimState } from "../src/claim-state";
import { beadWriteFreeEnv, reviseBashEnv } from "../src/gates/readonly";
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

/** G1 as `index.ts` applies it: environment decision followed by the shared revision builder. */
async function gateBeadWriteFree(pi: ExtensionAPI, ctx: ExtensionContext, input: Record<string, unknown>) {
	return reviseBashEnv(input, { ...(await beadWriteFreeEnv(pi, ctx)) });
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

describe("G1 bead-write-free sandbox", () => {
	test("fails open without a process-local BEADS_DIR", async () => {
		expect(await gateBeadWriteFree(api(WORKER_TOOLS), context("helper"), { command: "bd update x" })).toBeUndefined();
	});

	test.each(["", "relative/.beads"])("fails open for a blank or relative BEADS_DIR (%s)", async beadsDir => {
		process.env.BEADS_DIR = beadsDir;
		expect(await gateBeadWriteFree(api(WORKER_TOOLS), context("helper"), { command: "bd update x" })).toBeUndefined();
	});

	test("fails open when the pinned repository has no active marker", async () => {
		const root = await mkdtemp(join(tmpdir(), "orc-g1-no-marker-"));
		try {
			process.env.BEADS_DIR = join(root, ".beads");
			expect(await gateBeadWriteFree(api(WORKER_TOOLS), context("helper", root), { command: "bd update x" })).toBeUndefined();
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
				expect(await gateBeadWriteFree(api(WORKER_TOOLS), context("helper", root), { command: "bd update x" })).toBeUndefined();
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
			expect(await gateBeadWriteFree(api(WORKER_TOOLS), context("helper", root), { command: "bd update x" })).toBeUndefined();
		} finally {
			readSpy.mockRestore();
			await rm(root, { recursive: true, force: true });
		}
	});

	test("fails open when the active marker is removed", async () => {
		const { root } = await activeRun();
		try {
			await rm(markerPath(root));
			expect(await gateBeadWriteFree(api(WORKER_TOOLS), context("helper", root), { command: "bd update x" })).toBeUndefined();
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
				input: { command: "bd update x", env: { BD_READONLY: "1" } },
			});
			await rm(markerPath(root));
			expect(await gateBeadWriteFree(api(WORKER_TOOLS), context("helper", root), { command: "bd update x" })).toBeUndefined();
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
			expect(result?.input?.env).toEqual({ FOO: "bar", BD_READONLY: "1" });
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
				input: { command: "bd update x", env: { BD_READONLY: "1" } },
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
			expect(await gateBeadWriteFree(api(WORKER_TOOLS), context("ORC-ROLE: implementer", root), { command: "bd comment x" })).toBeUndefined();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("keeps an unrelated same-cwd helper writable without BEADS_DIR", async () => {
		const { root } = await activeRun();
		try {
			delete process.env.BEADS_DIR;
			expect(await gateBeadWriteFree(api(WORKER_TOOLS), context("helper", root), { command: "bd update x" })).toBeUndefined();
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
			expect(result?.input).toEqual({ command: "bd show x", cwd: "/tmp", timeout: 5, env: { BD_READONLY: "1" } });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("does not re-revise an already-sandboxed call", async () => {
		const { root } = await activeRun();
		try {
			expect(await gateBeadWriteFree(api(WORKER_TOOLS), context("helper", root), { command: "bd show x", env: { BD_READONLY: "1" } })).toBeUndefined();
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
