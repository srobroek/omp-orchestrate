import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { beadRouting, isBeadWriteFree, legacyRoleFromLabel, orcRole, sessionRole } from "../src/identity";

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

/**
 * Routing moved from a label to `metadata.role` because metadata is the only carrier a
 * role contract can refuse: `authority.deny_metadata` exists and there is no
 * `deny_labels`. The legacy label stays readable so a run already in flight keeps
 * routing, which is why every one of these four cases has to hold at once.
 */
describe("beadRouting", () => {
	test("a metadata-routed bead resolves, and says so", () => {
		expect(beadRouting({ metadata: { role: "implementer" } })).toEqual({
			role: "implementer",
			from: "metadata",
			spelling: "role=implementer",
		});
	});

	test("a legacy label-only bead still resolves, marked as the fallback", () => {
		// An in-flight run must not stop routing the moment this lands.
		expect(beadRouting({ labels: ["orc-node", "agent:implementer", "state:pending"] })).toEqual({
			role: "implementer",
			from: "legacy-label",
			spelling: "agent:implementer",
		});
	});

	test("both carriers present and agreeing resolves once, from metadata", () => {
		expect(beadRouting({ labels: ["agent:shepherd"], metadata: { role: "shepherd" } })).toEqual({
			role: "shepherd",
			from: "metadata",
			spelling: "role=shepherd",
		});
	});

	test("neither carrier routes to no role", () => {
		// A bead routed to nobody must stay claimable: the claim gate allows what it
		// cannot resolve, so returning a role here would invent an eligibility rule.
		expect(beadRouting({ labels: ["cap:ts", "state:working"], metadata: { worktree: "/tmp/wt" } })).toBeUndefined();
		expect(beadRouting({ labels: [] })).toBeUndefined();
		expect(beadRouting({})).toBeUndefined();
		expect(beadRouting(null)).toBeUndefined();
		expect(beadRouting(undefined)).toBeUndefined();
	});

	test("metadata wins when the two carriers disagree", () => {
		// The handoff case, and it is the normal state of a reported node: the worker
		// adds `agent:reviewer` as a ready-for-review signal while the bead stays routed
		// to the role that owns it. A label-first lookup judged such a node against the
		// REVIEWER contract.
		expect(beadRouting({ labels: ["agent:reviewer"], metadata: { role: "implementer" } })?.role).toBe(
			"implementer",
		);
	});

	test("the legacy integrator suffix routes to the shepherd", () => {
		// It named no role at all before, so a merge bead was claimable by anyone named
		// by id while the shepherd's own queue filter was refused.
		expect(beadRouting({ labels: ["pr:merge", "agent:integrator"] })).toEqual({
			role: "shepherd",
			from: "legacy-label",
			spelling: "agent:integrator",
		});
	});

	test("integrator is a legacy label only, never a stamped value", () => {
		// Nothing writes it, so admitting it on the authoritative carrier would keep a
		// dead token alive on the one carrier that is supposed to be exact.
		expect(beadRouting({ metadata: { role: "integrator" } })).toBeUndefined();
	});

	test("reads metadata handed back as a JSON string", () => {
		// Some bd subcommands emit the whole map as a string. Routing must resolve the
		// same either way, or eligibility would depend on which read produced the bead.
		expect(beadRouting({ metadata: JSON.stringify({ role: "reviewer" }) })?.role).toBe("reviewer");
		expect(beadRouting({ metadata: "{not json" })).toBeUndefined();
		expect(beadRouting({ metadata: "null" })).toBeUndefined();
	});

	test("falls back to the label when metadata names no known role", () => {
		// A typo on the stamp must not strand a bead that still carries its old label.
		expect(beadRouting({ labels: ["agent:reviewer"], metadata: { role: "implementor" } })).toEqual({
			role: "reviewer",
			from: "legacy-label",
			spelling: "agent:reviewer",
		});
	});

	test("an empty or non-string stamp is no stamp", () => {
		expect(beadRouting({ metadata: { role: "" } })).toBeUndefined();
		expect(beadRouting({ metadata: { role: 7 } })).toBeUndefined();
		expect(beadRouting({ metadata: { role: ["implementer"] } })).toBeUndefined();
	});

	test("neither carrier resolves an inherited property name", () => {
		// Both carriers are agent-writable text. Under a bare index `constructor`
		// resolves through `Object.prototype` to a truthy Function, which defeated the
		// `?? generic` fallback downstream and let a dead child label its way out of
		// reclamation.
		for (const name of ["constructor", "toString", "valueOf", "__proto__", "hasOwnProperty"]) {
			expect(beadRouting({ labels: [`agent:${name}`] })).toBeUndefined();
			expect(beadRouting({ metadata: { role: name } })).toBeUndefined();
		}
	});

	test("a bead whose metadata map has no role key reads as unrouted", () => {
		// The map arrives from JSON.parse, so it inherits Object.prototype.
		expect(beadRouting({ metadata: { worktree: "/tmp/wt", scope: ["src/**"] } })).toBeUndefined();
	});

	test("the first known label wins when several are present", () => {
		expect(beadRouting({ labels: ["agent:reviewer", "agent:researcher"] })?.role).toBe("reviewer");
	});
});

describe("legacyRoleFromLabel", () => {
	test("resolves every legacy suffix, including the aliased one", () => {
		expect(legacyRoleFromLabel("agent:architect")).toBe("architect");
		expect(legacyRoleFromLabel("agent:implementer")).toBe("implementer");
		expect(legacyRoleFromLabel("agent:reviewer")).toBe("reviewer");
		expect(legacyRoleFromLabel("agent:researcher")).toBe("researcher");
		expect(legacyRoleFromLabel("agent:shepherd")).toBe("shepherd");
		expect(legacyRoleFromLabel("agent:integrator")).toBe("shepherd");
	});

	test("ignores any label that is not a legacy routing label", () => {
		expect(legacyRoleFromLabel("pr:merge")).toBeUndefined();
		expect(legacyRoleFromLabel("kind:incidental")).toBeUndefined();
		expect(legacyRoleFromLabel("orc-node")).toBeUndefined();
		expect(legacyRoleFromLabel("agent:")).toBeUndefined();
		expect(legacyRoleFromLabel("")).toBeUndefined();
	});
});
