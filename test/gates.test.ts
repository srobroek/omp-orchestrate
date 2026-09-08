import { beforeEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { createClaimState } from "../src/claim-state";
import { beadWriteFreeEnv, reviseBashEnv } from "../src/gates/readonly";

function api(toolNames: string[]): ExtensionAPI {
	const stub = { getAllTools: () => toolNames.map(name => ({ name, description: "" })) };
	return stub as unknown as ExtensionAPI;
}

function context(prompt: string): ExtensionContext {
	const stub = { getSystemPrompt: () => [prompt] };
	return stub as unknown as ExtensionContext;
}

const WORKER_TOOLS = ["bash", "read", "yield"];

/**
 * G1 as `index.ts` applies it: the gate decides the environment and one shared builder
 * turns it into the revision, so the assertions below are on what a `bash` call
 * actually executes with.
 */
function gateBeadWriteFree(pi: ExtensionAPI, ctx: ExtensionContext, input: Record<string, unknown>) {
	return reviseBashEnv(input, { ...beadWriteFreeEnv(pi, ctx) });
}

describe("G1 bead-write-free sandbox", () => {
	test("preserves the caller's other env vars", () => {
		const result = gateBeadWriteFree(api(WORKER_TOOLS), context("helper"), {
			command: "bd show x",
			env: { FOO: "bar" },
		});
		expect(result?.input?.env).toEqual({ FOO: "bar", BD_READONLY: "1" });
	});

	test("carries real bash params through and drops derived fields", () => {
		// A revision is the raw execution input, and the normalized event.input view
		// may carry gate-only fields that are not real parameters. Forwarding one
		// into execute would be a bug, so the replacement is rebuilt from an
		// allowlist.
		const result = gateBeadWriteFree(api(WORKER_TOOLS), context("helper"), {
			command: "bd show x",
			cwd: "/tmp",
			timeout: 5,
			derivedGateOnlyField: "must not survive",
		});
		expect(result?.input).toEqual({ command: "bd show x", cwd: "/tmp", timeout: 5, env: { BD_READONLY: "1" } });
	});

	test("leaves the lead alone", () => {
		const result = gateBeadWriteFree(api(["bash", "task"]), context("no marker"), { command: "bd create epic" });
		expect(result).toBeUndefined();
	});

	test("does not re-revise an already-sandboxed call", () => {
		const result = gateBeadWriteFree(api(WORKER_TOOLS), context("helper"), {
			command: "bd show x",
			env: { BD_READONLY: "1" },
		});
		expect(result).toBeUndefined();
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
