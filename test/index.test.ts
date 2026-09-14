import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, spyOn, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import orchestrateWithBd, { runHeader } from "../src/index";
import { mentionsOrchestrate } from "../src/keyword";
import { readLocator, writeLocator } from "../src/run";
import { NO_STORE, NOT_SERVER_MODE, storeRefusal } from "../src/tools/ledger";

type EventHandler = (event: unknown, ctx?: unknown) => unknown;

interface Registered {
	events: string[];
	commands: string[];
	tools: string[];
	eventHandlers: Map<string, EventHandler[]>;
	label?: string;
	userMessages: string[];
}

/**
 * A factory must only register during load. Calling a runtime action such as
 * `sendMessage` at load time throws `ExtensionRuntimeNotInitializedError`, so this
 * stub makes every runtime action explode and asserts the factory never reaches one.
 */
function recordingApi(): { pi: ExtensionAPI; seen: Registered } {
	const seen: Registered = { events: [], commands: [], tools: [], eventHandlers: new Map(), userMessages: [] };
	const explode = (name: string) => () => {
		throw new Error(`runtime action ${name} called during load`);
	};
	// The zod builder is only used to DESCRIBE parameter schemas at registration
	// time; a self-returning proxy stands in for every chained call.
	const zodStub: unknown = new Proxy(() => zodStub, { get: () => zodStub, apply: () => zodStub });
	const stub = {
		setLabel: (label: string) => {
			seen.label = label;
		},
		on: (event: string, handler: EventHandler) => {
			seen.events.push(event);
			const handlers = seen.eventHandlers.get(event) ?? [];
			handlers.push(handler);
			seen.eventHandlers.set(event, handlers);
		},
		registerCommand: (name: string) => {
			seen.commands.push(name);
		},
		registerTool: (definition: { name: string }) => {
			seen.tools.push(definition.name);
		},
		zod: zodStub,
		logger: { error: () => {}, debug: () => {}, warn: () => {}, info: () => {} },
		sendMessage: explode("sendMessage"),
		sendUserMessage: (content: string) => {
			seen.userMessages.push(content);
		},
		appendEntry: explode("appendEntry"),
		getAllTools: explode("getAllTools"),
		getActiveTools: explode("getActiveTools"),
	};
	return { pi: stub as unknown as ExtensionAPI, seen };
}
function fixture(mode: string | null): string {
	const root = mkdtempSync(join(tmpdir(), "orc-index-"));
	if (mode !== null) {
		mkdirSync(join(root, ".beads"));
		writeFileSync(join(root, ".beads", "metadata.json"), JSON.stringify({ dolt_mode: mode, dolt_database: "fx" }));
	}
	return root;
}

describe("extension factory", () => {
	test("registers exactly three events and seven tools, no commands, and reaches no runtime action", () => {
		const { pi, seen } = recordingApi();
		expect(() => orchestrateWithBd(pi)).not.toThrow();
		expect(seen.label).toBe("Orchestrate with bd");
		expect([...new Set(seen.events)].sort()).toEqual(["before_agent_start", "todo_reminder", "tool_call"]);
		expect(seen.commands).toEqual([]);
		expect(seen.tools.sort()).toEqual([
			"orc_bot_review_probe",
			"orc_bot_review_request",
			"orc_claim",
			"orc_conflict_probe",
			"orc_finish",
			"orc_review_round_policy",
			"orc_status",
		]);
	});
});

describe("tool_call actor injection", () => {
	async function bash(input: Record<string, unknown>, sessionId: string): Promise<unknown> {
		const { pi, seen } = recordingApi();
		orchestrateWithBd(pi);
		const ctx = { cwd: "/tmp", sessionManager: { getSessionId: () => sessionId } };
		let result: unknown;
		for (const handler of seen.eventHandlers.get("tool_call") ?? []) result = await handler({ type: "tool_call", toolName: "bash", input }, ctx);
		return result;
	}

	test("adds the calling session's actor to a bash call and keeps one the call already names", async () => {
		expect(await bash({ command: "bd list" }, "sess-1")).toEqual({ input: { command: "bd list", env: { BEADS_ACTOR: "omp/sess-1" } } });
		expect(await bash({ command: "bd list", env: { FOO: "1" } }, "sess-2")).toEqual({
			input: { command: "bd list", env: { FOO: "1", BEADS_ACTOR: "omp/sess-2" } },
		});
		expect(await bash({ command: "bd list", env: { BEADS_ACTOR: "human" } }, "sess-3")).toBeUndefined();
	});

	test("two sessions in one process get two actors", async () => {
		const a = (await bash({ command: "bd list" }, "a")) as { input: { env: { BEADS_ACTOR: string } } };
		const b = (await bash({ command: "bd list" }, "b")) as { input: { env: { BEADS_ACTOR: string } } };
		expect(a.input.env.BEADS_ACTOR).not.toBe(b.input.env.BEADS_ACTOR);
	});
});

describe("before_agent_start", () => {
	async function header(root: string, prompt: string): Promise<unknown> {
		const { pi, seen } = recordingApi();
		orchestrateWithBd(pi);
		const ctx = { cwd: root, sessionManager: { getSessionId: () => "sess-2" } };
		let result: unknown;
		for (const handler of seen.eventHandlers.get("before_agent_start") ?? []) {
			result = await handler({ type: "before_agent_start", prompt }, ctx);
		}
		return result;
	}

	test("injects the run header naming store and run for a prompt that says orchestrate", async () => {
		const root = fixture("server");
		writeLocator(root, "fx-epic");
		const result = (await header(root, "please orchestrate the ready beads")) as {
			message: { customType: string; display: boolean; attribution: string; content: string };
		};
		expect(result.message.customType).toBe("orc-run-header");
		expect(result.message.display).toBe(false);
		expect(result.message.attribution).toBe("user");
		expect(result.message.content).toContain("run epic: fx-epic");
		expect(result.message.content).toContain("store: fx (server mode)");
		expect(result.message.content).toContain("actor: omp/sess-2");
		expect(result.message.content).toContain("skill://orchestrate-with-bd");
		expect(result.message.content).toContain("orc_status.ready");
		expect(result.message.content).toContain("Never implementer, then its reviewer, then the next implementer");
	});

	test("stays silent for inline code, a file name, or a capitalised word", async () => {
		const root = fixture("server");
		expect(await header(root, "look at `orchestrate` here")).toBeUndefined();
		expect(await header(root, "open orchestrate.ts")).toBeUndefined();
		expect(await header(root, "Orchestrate the team")).toBeUndefined();
	});

	test("names the missing run when no locator is bound", () => {
		expect(runHeader(fixture("server"), "omp/x")).toContain("no run epic yet");
	});

	test("an embedded or missing store makes the header say STOP before the contract", () => {
		const embedded = runHeader(fixture("embedded"), "omp/x");
		expect(embedded).toContain("STOP.");
		expect(embedded.indexOf("STOP.")).toBeLessThan(embedded.indexOf("Read `skill://orchestrate-with-bd`"));
		expect(runHeader(fixture(null), "omp/x")).toContain("STOP.");
		expect(runHeader(fixture("server"), "omp/x")).not.toContain("STOP.");
	});
});

describe("mentionsOrchestrate", () => {
	test("keyword boundary and code masking", () => {
		expect(mentionsOrchestrate("orchestrate")).toBe(true);
		expect(mentionsOrchestrate("we orchestrate. now")).toBe(true);
		expect(mentionsOrchestrate("<brief>orchestrate this</brief>")).toBe(true);
		expect(mentionsOrchestrate("```\norchestrate\n```")).toBe(false);
		expect(mentionsOrchestrate("~~~sh\norchestrate\n~~~")).toBe(false);
		// A closer is the same character, at least as long as the opener; an unclosed fence
		// masks to the end of the text, exactly as OMP's maskNonProse does.
		expect(mentionsOrchestrate("```\norchestrate\n`````")).toBe(false);
		expect(mentionsOrchestrate("````\norchestrate\n```\n")).toBe(false);
		expect(mentionsOrchestrate("```\norchestrate\n~~~\n")).toBe(false);
		expect(mentionsOrchestrate("```\ncode\n```\norchestrate")).toBe(true);
		// OMP's fence regex accepts a mixed 3-run as an opener; parity with OMP is the contract.
		expect(mentionsOrchestrate("``~ opener\norchestrate")).toBe(false);
		expect(mentionsOrchestrate("``orchestrate`` and `x`")).toBe(false);
		expect(mentionsOrchestrate("run `orchestrate`")).toBe(false);
		expect(mentionsOrchestrate("orchestrate()")).toBe(false);
		expect(mentionsOrchestrate("src/orchestrate")).toBe(false);
		expect(mentionsOrchestrate("re-orchestrate")).toBe(false);
		expect(mentionsOrchestrate("ns::orchestrate")).toBe(false);
		expect(mentionsOrchestrate("orchestrated")).toBe(false);
		expect(mentionsOrchestrate("   ")).toBe(false);
	});
});

describe("locator", () => {
	test("round-trips, ignores garbage, and keeps the gitignore inside the root", () => {
		const root = fixture(null);
		expect(readLocator(root)).toBeNull();
		writeLocator(root, "epic-1");
		expect(readLocator(root)).toEqual({ schema_version: 1, run_id: "epic-1" });
		expect(readFileSync(join(root, ".orchestration", ".gitignore"), "utf8")).toBe("*\n");
		writeFileSync(join(root, ".orchestration", ".active-run"), "{not json");
		expect(readLocator(root)).toBeNull();
		writeFileSync(join(root, ".orchestration", ".active-run"), JSON.stringify({ schema_version: 2, run_id: "x" }));
		expect(readLocator(root)).toBeNull();
		writeFileSync(join(root, ".orchestration", ".active-run"), JSON.stringify({ schema_version: 1, run_id: "" }));
		expect(readLocator(root)).toBeNull();
	});
});

describe("orc_finish blocked", () => {
	test("records the reason as a comment and never passes --reason to bd update", async () => {
		const root = fixture("server");
		const { pi, seen } = recordingApi();
		const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
		(pi as unknown as { registerTool: (t: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => void }).registerTool = t => {
			seen.tools.push(t.name);
			tools.set(t.name, t);
		};
		orchestrateWithBd(pi);
		const argvs: string[][] = [];
		const spawn = spyOn(Bun, "spawn").mockImplementation(((argv: string[]) => {
			argvs.push(argv);
			return { stdout: new Response('{"id":"b-1"}').body, stderr: new Response("").body, exited: Promise.resolve(0), kill: () => undefined };
		}) as unknown as typeof Bun.spawn);
		try {
			const ctx = { cwd: root, sessionManager: { getSessionId: () => "s" } };
			await tools.get("orc_finish")?.execute("x", { bead: "b-1", state: "blocked", reason: "needs round.ts" }, undefined, undefined, ctx);
		} finally {
			spawn.mockRestore();
		}
		expect(argvs.map(a => a.slice(1).join(" "))).toEqual(["comment b-1 blocked: needs round.ts", "update b-1 --status blocked --json"]);
	});
});

describe("orc_finish done on an epic", () => {
	test("refuses while a descendant is open or in progress, closes when the subtree is terminal", async () => {
		const root = fixture("server");
		const { pi, seen } = recordingApi();
		const tools = new Map<string, { execute: (...args: unknown[]) => Promise<{ content: { text: string }[]; isError?: boolean }> }>();
		(pi as unknown as { registerTool: (t: { name: string; execute: (...args: unknown[]) => Promise<{ content: { text: string }[]; isError?: boolean }> }) => void }).registerTool = t => {
			seen.tools.push(t.name);
			tools.set(t.name, t);
		};
		orchestrateWithBd(pi);
		let children = '[{"id":"E.1","status":"closed"},{"id":"E.2","status":"open"}]';
		const argvs: string[][] = [];
		const spawn = spyOn(Bun, "spawn").mockImplementation(((argv: string[]) => {
			argvs.push(argv);
			const args = argv.slice(1).join(" ");
			let body = '{"id":"E","issue_type":"epic","status":"in_progress"}';
			if (args.startsWith("list --parent E ")) body = children;
			if (args.startsWith("list --parent E.")) body = "[]";
			if (args.startsWith("close")) body = '{"id":"E","status":"closed"}';
			return { stdout: new Response(body).body, stderr: new Response("").body, exited: Promise.resolve(0), kill: () => undefined };
		}) as unknown as typeof Bun.spawn);
		try {
			const ctx = { cwd: root, sessionManager: { getSessionId: () => "s" } };
			const refused = await tools.get("orc_finish")?.execute("x", { bead: "E", state: "done", reason: "all done" }, undefined, undefined, ctx);
			expect(refused?.isError).toBe(true);
			expect(refused?.content[0]?.text).toContain("E.2");
			expect(argvs.some(a => a[1] === "close")).toBe(false);
			children = '[{"id":"E.1","status":"closed"},{"id":"E.2","status":"blocked"}]';
			const closed = await tools.get("orc_finish")?.execute("x", { bead: "E", state: "done", reason: "all done" }, undefined, undefined, ctx);
			expect(closed?.isError ?? false).toBe(false);
			expect(argvs.some(a => a[1] === "close")).toBe(true);
			// Beyond the walk limit the check is blind, so it refuses rather than closes.
			argvs.length = 0;
			children = JSON.stringify(Array.from({ length: 501 }, (_, i) => ({ id: `E.${i}`, status: "closed" })));
			const blind = await tools.get("orc_finish")?.execute("x", { bead: "E", state: "done", reason: "all done" }, undefined, undefined, ctx);
			expect(blind?.isError).toBe(true);
			expect(blind?.content[0]?.text).toContain("more than 500 descendants");
			expect(argvs.some(a => a[1] === "close")).toBe(false);
		} finally {
			spawn.mockRestore();
		}
	});
});

describe("store mode refusal", () => {
	test("server mode passes; embedded and a missing store refuse, from the file alone", () => {
		expect(storeRefusal(fixture("server"))).toBeNull();
		expect(storeRefusal(fixture("embedded"))).toBe(NOT_SERVER_MODE);
		expect(storeRefusal(fixture(null))).toContain(NO_STORE);
		expect(NOT_SERVER_MODE).toContain("bd init --shared-server --reinit-local");
	});
});
