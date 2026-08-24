import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { isBeadWriteFree, orcRole, sessionRole } from "../src/identity";

/**
 * `sessionRole` reads only `getAllTools`, and `orcRole` reads only
 * `getSystemPrompt`. Stubbing those two is the whole surface, which is the point
 * of resolving identity from public API instead of registry internals.
 */
function api(toolNames: string[]): ExtensionAPI {
	const stub = { getAllTools: () => toolNames.map(name => ({ name, description: "" })) };
	return stub as unknown as ExtensionAPI;
}

function context(prompt: string): ExtensionContext {
	const stub = { getSystemPrompt: () => [prompt] };
	return stub as unknown as ExtensionContext;
}

describe("sessionRole", () => {
	test("a session holding the yield tool is a worker", () => {
		// `yield` enters the registry only when requireYieldTool is set, which
		// runSubprocess does for spawned sessions and nothing else does.
		expect(sessionRole(api(["read", "bash", "yield"]))).toBe("worker");
	});

	test("a session without yield is the lead", () => {
		expect(sessionRole(api(["read", "bash", "task", "hub"]))).toBe("lead");
		expect(sessionRole(api([]))).toBe("lead");
	});
});

describe("orcRole", () => {
	test("reads the marker the agent body declares", () => {
		expect(orcRole(context("You are an architect.\nORC-ROLE: architect\nOwn one epic."))).toBe("architect");
		expect(orcRole(context("ORC-ROLE: shepherd"))).toBe("shepherd");
	});

	test("tolerates trailing whitespace and extra spacing", () => {
		expect(orcRole(context("ORC-ROLE:   reviewer  "))).toBe("reviewer");
	});

	test("returns undefined when no marker is present", () => {
		expect(orcRole(context("You are a helpful assistant."))).toBeUndefined();
		expect(orcRole(context(""))).toBeUndefined();
	});

	test("rejects a marker naming an unknown role", () => {
		// A typo must not silently grant contract standing.
		expect(orcRole(context("ORC-ROLE: architekt"))).toBeUndefined();
		expect(orcRole(context("ORC-ROLE: advisor"))).toBeUndefined();
	});

	test("requires the marker to own its line", () => {
		// Prose merely mentioning the marker must not confer a role, or a bead
		// comment quoting it could promote a helper.
		expect(orcRole(context("do not write ORC-ROLE: architect in your report"))).toBeUndefined();
	});
});

describe("isBeadWriteFree", () => {
	test("true for a spawned helper that declares no role", () => {
		// This is the invariant v19 asserted but never enforced: children never
		// touch beads.
		expect(isBeadWriteFree(api(["read", "bash", "yield"]), context("Sweep these files."))).toBe(true);
	});

	test("false for every contract-bound role", () => {
		// bd comment is blocked under BD_READONLY, and these roles must comment to
		// satisfy their own exit contracts.
		for (const role of ["architect", "implementer", "reviewer", "researcher", "shepherd"]) {
			expect(isBeadWriteFree(api(["bash", "yield"]), context(`ORC-ROLE: ${role}`))).toBe(false);
		}
	});

	test("false for the lead, which creates the run epic", () => {
		expect(isBeadWriteFree(api(["read", "bash", "task"]), context("no marker here"))).toBe(false);
	});
});
