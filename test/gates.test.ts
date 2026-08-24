import { beforeEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { forgetClaim, observedClaim, recordClaim } from "../src/claim-state";
import { gateBeadWriteFree } from "../src/gates/readonly";
import { gateWorktrunkOwnership } from "../src/gates/wt-guard";

function api(toolNames: string[]): ExtensionAPI {
	const stub = { getAllTools: () => toolNames.map(name => ({ name, description: "" })) };
	return stub as unknown as ExtensionAPI;
}

function context(prompt: string): ExtensionContext {
	const stub = { getSystemPrompt: () => [prompt] };
	return stub as unknown as ExtensionContext;
}

const WORKER_TOOLS = ["bash", "read", "yield"];

describe("G1 bead-write-free sandbox", () => {
	test("imposes BD_READONLY on an unmarked worker", () => {
		const result = gateBeadWriteFree(api(WORKER_TOOLS), context("Sweep these files."), {
			command: "bd update x --status closed",
		});
		expect(result?.input?.env).toEqual({ BD_READONLY: "1" });
		expect(result?.block).toBeUndefined();
	});

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

	test("leaves every contract-bound role alone", () => {
		// bd comment is blocked under BD_READONLY and these roles must comment to
		// satisfy their exit contracts.
		for (const role of ["architect", "implementer", "reviewer", "researcher", "shepherd"]) {
			const result = gateBeadWriteFree(api(WORKER_TOOLS), context(`ORC-ROLE: ${role}`), {
				command: "bd comment x REPORTED",
			});
			expect(result).toBeUndefined();
		}
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

describe("G3 worktrunk ownership", () => {
	test("refuses git worktree and gh pr checkout", () => {
		expect(gateWorktrunkOwnership({ command: "git worktree add ../wt" })?.block).toBe(true);
		expect(gateWorktrunkOwnership({ command: "gh pr checkout 42" })?.block).toBe(true);
	});

	test("names wt in the refusal so the agent knows the sanctioned route", () => {
		expect(gateWorktrunkOwnership({ command: "git worktree list" })?.reason).toContain("wt switch --create");
	});

	test("still catches it behind a global flag or an env prefix", () => {
		expect(gateWorktrunkOwnership({ command: "git -C /repo worktree prune" })?.block).toBe(true);
		expect(gateWorktrunkOwnership({ command: "FOO=1 git worktree add x" })?.block).toBe(true);
	});

	test("allows sanctioned worktree management and unrelated commands", () => {
		expect(gateWorktrunkOwnership({ command: "wt switch --create feat/x" })).toBeUndefined();
		expect(gateWorktrunkOwnership({ command: "git status" })).toBeUndefined();
		expect(gateWorktrunkOwnership({ command: "gh pr view 42" })).toBeUndefined();
	});

	test("does not fire on prose that merely mentions the command", () => {
		// Matching parsed argv rather than substrings is the whole reason the
		// tokeniser exists.
		expect(gateWorktrunkOwnership({ command: `bd comment x "never run git worktree add"` })).toBeUndefined();
	});

	test("ignores a missing or non-string command", () => {
		expect(gateWorktrunkOwnership({})).toBeUndefined();
		expect(gateWorktrunkOwnership({ command: 42 })).toBeUndefined();
	});
});

describe("claim state", () => {
	beforeEach(() => forgetClaim());

	test("records and returns an observation", () => {
		recordClaim({ actor: "arch-1", beadIds: ["orc-1"] });
		expect(observedClaim()).toEqual({ actor: "arch-1", beadIds: ["orc-1"] });
	});

	test("a later claim replaces an earlier one", () => {
		recordClaim({ actor: "w-1", beadIds: ["orc-1"] });
		recordClaim({ actor: "w-1", beadIds: ["orc-2"] });
		expect(observedClaim()?.beadIds).toEqual(["orc-2"]);
	});

	test("ignores an observation with no actor or no beads", () => {
		recordClaim({ actor: "", beadIds: ["orc-1"] });
		expect(observedClaim()).toBeUndefined();
		recordClaim({ actor: "w-1", beadIds: [] });
		expect(observedClaim()).toBeUndefined();
	});
});
