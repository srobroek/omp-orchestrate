import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { zod } from "@oh-my-pi/pi-coding-agent";
import * as hostSettings from "@oh-my-pi/pi-coding-agent/config/settings";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { SettingPath } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import * as agentPreflight from "../src/agent-preflight";
import { PLUGIN_AGENTS_BY_PACKAGE } from "../src/agent-preflight";
import * as beadsMode from "../src/beads-mode";
import * as storeProbe from "../src/store-probe";
import type { Exec, ExecResult } from "../src/tools/bot-review-probe";
import { type DoctorCheck, type DoctorReport, MIN_BD_VERSION, parseVersion, registerDoctor, renderDoctor, runDoctor } from "../src/tools/doctor";
import { OVERLAY_FILE, readSettings, settingsDeviations } from "../src/watchers";
import declared from "./declared-surface.json";

const COMPLIANT: Partial<Record<SettingPath, unknown>> = {
	"task.isolation.enabled": true,
	"task.isolation.merge": "branch",
	"task.isolation.apply": false,
	"task.enableEffort": true,
	"task.maxRecursionDepth": 3,
	"bash.autoBackground.enabled": false,
	modelRoles: { plan: "p/plan", task: "p/task", smol: "p/smol", reviewer: "x/y" },
};

function out(stdout: string, code = 0, stderr = ""): ExecResult {
	return { code, stdout, stderr };
}

/** A capability payload as `gh api graphql` prints it. */
function capabilityPayload(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		data: {
			repository: {
				autoMergeAllowed: false,
				squashMergeAllowed: true,
				viewerPermission: "ADMIN",
				mergeQueue: null,
				ref: { branchProtectionRule: null },
				rulesets: { nodes: [] },
				...overrides,
			},
		},
	});
}

/** Every executable the doctor asks, answering as the healthy host does. */
function healthy(): Record<string, ExecResult | null> {
	return {
		"bd --version": out("bd version 1.2.2 (6c124203e)"),
		"wt --version": out("wt v0.77.0"),
		"git --version": out("git version 2.55.0"),
		"gh --version": out("gh version 2.100.0 (2026-09-03)\nhttps://github.com/cli/cli/releases/tag/v2.100.0"),
		"gh auth status": out("github.com\n  Logged in to github.com account someone"),
		"bun --version": out("1.4.2"),
		"gh repo view --json nameWithOwner,defaultBranchRef": out(JSON.stringify({ nameWithOwner: "o/r", defaultBranchRef: { name: "main" } })),
		"gh api graphql": out(capabilityPayload()),
	};
}

/**
 * Answer argv from a transcript keyed by its leading words; the longest matching key
 * wins. `null` is a binary that never answered. Anything unscripted throws so a new
 * subprocess the doctor grows cannot pass silently.
 */
function transcript(answers: Record<string, ExecResult | null>): { exec: Exec; calls: string[][] } {
	const calls: string[][] = [];
	const keys = Object.keys(answers).sort((a, b) => b.length - a.length);
	const exec: Exec = async argv => {
		calls.push(argv);
		const line = argv.join(" ");
		const key = keys.find(candidate => line === candidate || line.startsWith(`${candidate} `));
		if (key === undefined) throw new Error(`unscripted argv: ${line}`);
		return answers[key] ?? null;
	};
	return { exec, calls };
}

function row(report: DoctorReport, name: string): DoctorCheck {
	const found = report.checks.find(check => check.name === name);
	if (found === undefined) throw new Error(`no row ${name} in ${JSON.stringify(report.checks.map(check => check.name))}`);
	return found;
}

/**
 * Status and detail asserted separately: Bun 1.4's `toMatchObject` with an
 * `expect.stringContaining` member overwrites the received property with the matcher,
 * so a later read of the same row would see an object, not the text.
 */
function expectRow(report: DoctorReport, name: string, status: DoctorCheck["status"], contains: string): void {
	const found = row(report, name);
	expect(found.status).toBe(status);
	expect(found.detail).toContain(contains);
}

let cwd: string;
let stubbed: Settings | undefined;
const settingsSpy = spyOn(hostSettings, "findScopedSettings").mockImplementation(() => stubbed);
const locateSpy = spyOn(beadsMode, "locateBeadsDir");
const probeSpy = spyOn(storeProbe, "probeStore");
const discoverSpy = spyOn(agentPreflight, "discoverAgentFindings");

beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), "orc-doctor-"));
	stubbed = Settings.isolated(COMPLIANT);
	locateSpy.mockImplementation(async () => ({ ok: true, beadsDir: join(cwd, ".beads") }));
	probeSpy.mockImplementation(async () => ({ state: "free", lock: "LOCK", ms: 300 }));
	discoverSpy.mockImplementation(async () => []);
	locateSpy.mockClear();
	probeSpy.mockClear();
	discoverSpy.mockClear();
	delete process.env.BD_BIN;
});

afterEach(async () => {
	await rm(cwd, { recursive: true, force: true });
});

afterAll(() => {
	settingsSpy.mockRestore();
	locateSpy.mockRestore();
	probeSpy.mockRestore();
	discoverSpy.mockRestore();
});

async function doctor(answers: Record<string, ExecResult | null> = healthy()): Promise<DoctorReport> {
	return runDoctor({ cwd }, transcript(answers).exec);
}

describe("the shipped overlay", () => {
	test("loads through OMP's own overlay reader and satisfies every required setting", async () => {
		// An empty agentDir and cwd keep this host's global and project settings out of
		// the layering, so what the overlay sets is all the reader sees above defaults.
		const overlaid = await Settings.loadReadOnly({ cwd, agentDir: join(cwd, "agent"), configFiles: [OVERLAY_FILE] });
		stubbed = overlaid;
		const observed = readSettings();
		expect(observed).not.toBeNull();
		expect(settingsDeviations(observed!)).toEqual([]);
	});

	test("without the overlay the same reader deviates on every required setting", async () => {
		stubbed = await Settings.loadReadOnly({ cwd, agentDir: join(cwd, "agent") });
		expect(settingsDeviations(readSettings()!).map(item => item.key)).toEqual([
			"task.isolation.enabled",
			"task.isolation.merge",
			"task.isolation.apply",
			"task.enableEffort",
			"task.maxRecursionDepth",
			"bash.autoBackground.enabled",
		]);
	});
});

describe("the declared surface", () => {
	test("the borrowed agents the doctor checks are the ones the agent suite declares", () => {
		expect(PLUGIN_AGENTS_BY_PACKAGE).toEqual(declared.pluginAgents.byPackage);
	});
});

describe("runDoctor", () => {
	test("a healthy host passes every row", async () => {
		const report = await doctor();
		expect(report.ok).toBe(true);
		expect(report.checks.map(check => check.status)).toEqual(report.checks.map(() => "pass"));
		expect(row(report, "bd").detail).toBe("1.2.2");
		expect(row(report, "gh").detail).toBe("2.100.0, authenticated");
		expect(row(report, "overlay").detail).toBe(`omp --config ${OVERLAY_FILE}`);
		expect(row(report, "landing").detail).toBe("o/r (main): mode direct, auto-merge off, squash on, required checks none");
		expect(renderDoctor(report).split("\n")[0]).toBe("doctor: ok (0 warnings)");
	});

	test.each([
		["bd version 1.1.9 (abc)", "fail"],
		[`bd version ${MIN_BD_VERSION.major}.${MIN_BD_VERSION.minor}.0 (abc)`, "pass"],
		["bd version 2.0.0 (abc)", "pass"],
		["bd (development build)", "warn"],
	] as const)("bd answering %s is %s", async (banner, status) => {
		const report = await doctor({ ...healthy(), "bd --version": out(banner) });
		expect(row(report, "bd").status).toBe(status);
	});

	test("a missing bd names the binary the plugin would run", async () => {
		process.env.BD_BIN = "/opt/nowhere/bd";
		const report = await doctor({ ...healthy(), "/opt/nowhere/bd --version": null });
		expectRow(report, "bd", "fail", "/opt/nowhere/bd not found");
	});

	test("missing required binaries fail; a missing bun warns and leaves ok standing", async () => {
		const report = await doctor({ ...healthy(), "wt --version": null, "bun --version": null });
		expect(row(report, "wt").status).toBe("fail");
		expectRow(report, "bun", "warn", "worktree-sweep.ts");
		expect(report.ok).toBe(false);

		const optionalOnly = await doctor({ ...healthy(), "bun --version": null });
		expect(optionalOnly.ok).toBe(true);
		expect(renderDoctor(optionalOnly).split("\n")[0]).toBe("doctor: ok (1 warning)");
	});

	test("gh present but unauthenticated fails with the login repair", async () => {
		const report = await doctor({ ...healthy(), "gh auth status": out("", 1, "You are not logged into any GitHub hosts. To log in, run: gh auth login") });
		expectRow(report, "gh", "fail", "not authenticated");
		expect(row(report, "gh").detail).toContain("run `gh auth login`");
	});

	test("a deviating setting fails with the value, the consequence, and the overlay command", async () => {
		stubbed = Settings.isolated({ ...COMPLIANT, "task.isolation.merge": "patch" });
		const report = await doctor();
		const settings = row(report, "settings");
		expect(settings.status).toBe("fail");
		expect(settings.detail).toContain('task.isolation.merge is "patch", needs branch');
		expect(settings.detail).toContain(`omp --config ${OVERLAY_FILE}`);
		expect(report.ok).toBe(false);
	});

	test("one row per model role: reviewer warns when unset, plan/task/smol fail; unreadable settings warn rather than fail", async () => {
		stubbed = Settings.isolated({ ...COMPLIANT, modelRoles: { plan: "p/plan", task: "p/task", smol: "p/smol" } });
		const reviewerless = await doctor();
		expect(reviewerless.checks.filter(check => check.name.startsWith("modelRoles.")).map(check => check.name)).toEqual(["modelRoles.plan", "modelRoles.task", "modelRoles.smol", "modelRoles.reviewer"]);
		expectRow(reviewerless, "modelRoles.reviewer", "warn", "orc-reviewer falls back to the session model");
		expect(row(reviewerless, "core agents").status).toBe("pass");
		expect(reviewerless.ok).toBe(true);

		stubbed = Settings.isolated({ ...COMPLIANT, modelRoles: { reviewer: "x/y" } });
		const planless = await doctor();
		expectRow(planless, "modelRoles.plan", "fail", "orc-architect cannot be spawned");
		expectRow(planless, "modelRoles.task", "fail", "orc-implementer, orc-shepherd cannot be spawned");
		expectRow(planless, "modelRoles.smol", "fail", "orc-researcher cannot be spawned");
		expect(planless.ok).toBe(false);

		stubbed = undefined;
		const unread = await doctor();
		expectRow(unread, "settings", "warn", "could not be read");
		expectRow(unread, "modelRoles.reviewer", "warn", "no model registry is live");
		expect(unread.ok).toBe(false);
	});

	test("with a live model registry, resolution decides each role row and the core agents row ignores the alias", async () => {
		const resolve = (spec: string) => (spec === "@reviewer" ? undefined : { id: `model-for-${spec.slice(1)}` });
		discoverSpy.mockImplementation(async () => [{ agent: "orc-reviewer", message: 'model alias "@reviewer" does not resolve', path: "/p/orc-reviewer.md" }]);
		const report = await runDoctor({ cwd, models: { resolve } as never }, transcript(healthy()).exec);
		expectRow(report, "modelRoles.plan", "pass", "@plan resolves to model-for-plan");
		expectRow(report, "modelRoles.reviewer", "warn", "@reviewer does not resolve");
		expect(row(report, "core agents").status).toBe("pass");
		expect(report.ok).toBe(true);
	});

	test("a borrowed helper missing warns its package alone; a core agent finding fails", async () => {
		discoverSpy.mockImplementation(async () => [{ agent: "operator", message: "requested agent is not discoverable" }]);
		const report = await doctor();
		expectRow(report, "plugin @srobroek/build", "warn", "operator not discoverable");
		expect(row(report, "plugin @srobroek/quality").status).toBe("pass");
		expect(row(report, "core agents").status).toBe("pass");
		expect(report.ok).toBe(true);

		discoverSpy.mockImplementation(async () => [
			{ agent: "orc-reviewer", message: "resolved override declares ORC-ROLE missing; expected reviewer", path: "/p/orc-reviewer.md" },
		]);
		const core = row(await doctor(), "core agents");
		expect(core.status).toBe("fail");
		expect(core.detail).toBe("orc-reviewer: resolved override declares ORC-ROLE missing; expected reviewer (/p/orc-reviewer.md)");
	});

	test("the doctor asks discovery for exactly the borrowed names", async () => {
		await doctor();
		expect(discoverSpy.mock.calls.at(-1)?.[1]).toEqual(Object.values(PLUGIN_AGENTS_BY_PACKAGE).flat());
	});

	test.each([
		[{ state: "free", lock: "L", ms: 200 }, "pass"],
		[{ state: "slow", lock: "L", ms: 4000 }, "warn"],
		[{ state: "locked", lock: "L", holder: "perl[12]" }, "fail"],
		[{ state: "corrupted", lock: "L", detail: "corrupted journal" }, "fail"],
	] as const)("store probe %j is %s", async (probe, status) => {
		probeSpy.mockImplementation(async () => probe);
		expect(row(await doctor(), "beads store").status).toBe(status);
	});

	test("no workspace fails before any probe; a probe that throws is a fail row, not a throw", async () => {
		locateSpy.mockImplementation(async () => ({ ok: false, reason: "no active Beads workspace was found" }));
		const report = await doctor();
		expectRow(report, "beads store", "fail", "no active Beads workspace");
		expect(probeSpy).not.toHaveBeenCalled();

		locateSpy.mockImplementation(async () => ({ ok: true, beadsDir: "/db" }));
		probeSpy.mockImplementation(async () => { throw new Error("bd could not be run to read the store at /db"); });
		expect(row(await doctor(), "beads store")).toEqual({ name: "beads store", status: "fail", detail: "bd could not be run to read the store at /db" });
	});

	test("landing: no GitHub repository fails, disabled squash warns, protection is reported", async () => {
		const noRepo = await doctor({ ...healthy(), "gh repo view --json nameWithOwner,defaultBranchRef": out("", 1, "none of the git remotes configured for this repository point to a known GitHub host") });
		expectRow(noRepo, "landing", "fail", "none of the git remotes");

		const noSquash = await doctor({ ...healthy(), "gh api graphql": out(capabilityPayload({ squashMergeAllowed: false })) });
		expectRow(noSquash, "landing", "warn", "squash merges are enabled");

		const protectedRepo = await doctor({
			...healthy(),
			"gh api graphql": out(capabilityPayload({
				autoMergeAllowed: true,
				ref: { branchProtectionRule: { requiredStatusCheckContexts: ["ts", "py"], requiresStrictStatusChecks: true } },
			})),
		});
		expect(row(protectedRepo, "landing").detail).toBe("o/r (main): mode auto, auto-merge on, squash on, required checks py, ts");
	});
});

describe("parseVersion", () => {
	test.each([
		["bd version 1.2.2 (6c124203e)", { major: 1, minor: 2, patch: 2, text: "1.2.2" }],
		["wt v0.77.0", { major: 0, minor: 77, patch: 0, text: "0.77.0" }],
		["jq-1.7", { major: 1, minor: 7, patch: 0, text: "1.7" }],
		["no digits here", undefined],
	])("%s", (banner, expected) => {
		expect(parseVersion(banner)).toEqual(expected);
	});
});

describe("registration", () => {
	function recording() {
		const tools: Array<{ name: string; approval?: string; execute: (...args: unknown[]) => Promise<{ isError?: boolean; details: DoctorReport; content: Array<{ text: string }> }> }> = [];
		const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
		const pi = {
			zod,
			registerTool: (tool: (typeof tools)[number]) => tools.push(tool),
			registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, options.handler),
		} as unknown as ExtensionAPI;
		registerDoctor(pi);
		return { tools, commands };
	}

	test("orc_doctor is a read tool whose result is an error exactly when a row fails", async () => {
		const { tools } = recording();
		expect(tools.map(tool => tool.name)).toEqual(["orc_doctor"]);
		expect(tools[0]!.approval).toBe("read");
		// Every real executable is unstubbed here, so run the tool with a deliberately
		// broken discovery to see the mapping: one fail row => isError.
		discoverSpy.mockImplementation(async () => { throw new Error("no roots"); });
		const result = await tools[0]!.execute("id", {}, undefined, undefined, { cwd });
		expect(result.isError).toBe(true);
		expect(result.details.checks.some(check => check.name === "agents" && check.status === "fail")).toBe(true);
		expect(result.content[0]!.text).toContain("agents");
	});

	test("/orchestrate-doctor notifies at the level of its worst row", async () => {
		const { commands } = recording();
		const notices: Array<{ message: string; level: string }> = [];
		const ctx = { cwd, ui: { notify: (message: string, level: string) => notices.push({ message, level }) } };
		discoverSpy.mockImplementation(async () => { throw new Error("no roots"); });
		await commands.get("orchestrate-doctor")!("", ctx);
		expect(notices.at(-1)?.level).toBe("error");
		expect(notices.at(-1)?.message).toContain("FAIL agents");
	});
});
