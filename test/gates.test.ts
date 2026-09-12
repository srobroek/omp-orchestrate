import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { createClaimState } from "../src/claim-state";
import { gateBeadWriteFree, rebuildBashInput, reviseBashEnv } from "../src/gates/readonly";
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

/** The readonly flag a revision carries, if any. */
function readonlyFlag(revision: { input?: unknown } | undefined): string | undefined {
	const env = (revision?.input as { env?: Record<string, string> } | undefined)?.env;
	return env?.BD_READONLY;
}

let previousMarkerOverride: string | undefined;

beforeEach(() => {
	previousMarkerOverride = process.env.ORCHESTRATE_MARKER_FILE;
	delete process.env.ORCHESTRATE_MARKER_FILE;
});

afterEach(() => {
	if (previousMarkerOverride === undefined) delete process.env.ORCHESTRATE_MARKER_FILE;
	else process.env.ORCHESTRATE_MARKER_FILE = previousMarkerOverride;
});

async function activeRun(): Promise<{ root: string }> {
	const root = await mkdtemp(join(tmpdir(), "orc-g1-"));
	await mkdir(join(root, ".orchestration"), { recursive: true });
	await writeFile(markerPath(root), JSON.stringify({ schema_version: 1, run_id: "orc-g1" }));
	return { root };
}

describe("reviseBashEnv", () => {
	test("adds the readonly flag beside existing environment and reports nothing when it is already there", () => {
		expect(reviseBashEnv({ command: "bd list", env: { FOO: "bar" } }, { BD_READONLY: "1" })?.input).toEqual({
			command: "bd list",
			env: { FOO: "bar", BD_READONLY: "1" },
		});
		expect(reviseBashEnv({ command: "bd list", env: { BD_READONLY: "1" } }, { BD_READONLY: "1" })).toBeUndefined();
	});
});

describe("G1 bead-write-free sandbox", () => {
	test("fails open in a checkout no run has marked", async () => {
		const root = await mkdtemp(join(tmpdir(), "orc-g1-no-marker-"));
		try {
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

	test("honors a custom marker path and stops readonly after marker removal", async () => {
		const root = await mkdtemp(join(tmpdir(), "orc-g1-custom-marker-"));
		try {
			process.env.ORCHESTRATE_MARKER_FILE = "run-state/marker";
			await mkdir(join(root, "run-state"), { recursive: true });
			await writeFile(markerPath(root), JSON.stringify({ run_id: "orc-g1" }));
			expect(await gateBeadWriteFree(api(WORKER_TOOLS), context("helper", root), { command: "bd update x" })).toEqual({
				input: { command: "bd update x", env: { BD_READONLY: "1" } },
			});
			await rm(markerPath(root));
			expect(readonlyFlag(await gateBeadWriteFree(api(WORKER_TOOLS), context("helper", root), { command: "bd update x" }))).toBeUndefined();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("injects readonly for a helper with an active marker, keeping its environment", async () => {
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

	test("preserves a contract-bound orc writer with an active marker", async () => {
		const { root } = await activeRun();
		try {
			expect(readonlyFlag(await gateBeadWriteFree(api(WORKER_TOOLS), context("ORC-ROLE: implementer", root), { command: "bd comment x" }))).toBeUndefined();
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

	test("rebuilds a revised input from allowlisted bash fields", () => {
		const rebuilt = rebuildBashInput({
			command: "echo ok",
			cwd: "/tmp",
			env: { BEADS_ACTOR: "omp/x" },
			derivedGateOnlyField: "must not survive",
		});
		expect(rebuilt).toEqual({ command: "echo ok", cwd: "/tmp", env: { BEADS_ACTOR: "omp/x" } });
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
			expect(await gateBeadWriteFree(api(WORKER_TOOLS), context("ORC-ROLE: implementer", root), { command: escape })).toBeUndefined();
			// Without the run, G1 fails open on the text as it does on the environment.
			await rm(markerPath(root));
			expect(await gateBeadWriteFree(api(WORKER_TOOLS), context("helper", root), { command: escape })).toBeUndefined();
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
