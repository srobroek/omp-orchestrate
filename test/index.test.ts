import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BdBead } from "../src/bd";
import { describe, expect, spyOn, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import * as actualBd from "../src/bd";
import ompOrchestrate from "../src/index";

type CommandHandler = Parameters<ExtensionAPI["registerCommand"]>[1]["handler"];
type EventHandler = (event: unknown, ctx?: unknown) => unknown;

interface Registered {
	events: string[];
	commands: string[];
	tools: string[];
	handlers: Map<string, CommandHandler>;
	eventHandlers: Map<string, EventHandler[]>;
	label?: string;
}

/**
 * A factory must only register during load. Calling a runtime action such as
 * `sendMessage` at load time throws `ExtensionRuntimeNotInitializedError`, so this
 * stub makes every runtime action explode and asserts the factory never reaches one.
 */
function recordingApi(mode: "load" | "worker" = "load"): { pi: ExtensionAPI; seen: Registered } {
	const seen: Registered = {
		events: [], commands: [], tools: [], handlers: new Map(), eventHandlers: new Map(),
	};
	const explode = (name: string) => () => {
		throw new Error(`runtime action ${name} called during load`);
	};
	// The zod builder is only used to DESCRIBE parameter schemas at registration
	// time; a self-returning proxy stands in for every chained call.
	const zodStub: unknown = new Proxy(() => zodStub, {
		get: () => zodStub,
		apply: () => zodStub,
	});
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
		registerCommand: (name: string, definition: { handler: CommandHandler }) => {
			seen.commands.push(name);
			seen.handlers.set(name, definition.handler);
		},
		registerTool: (definition: { name: string }) => {
			seen.tools.push(definition.name);
		},
		zod: zodStub,
		logger: { error: () => { }, debug: () => { }, warn: () => { }, info: () => { } },
		sendMessage: explode("sendMessage"),
		sendUserMessage: explode("sendUserMessage"),
		appendEntry: explode("appendEntry"),
		getAllTools: mode === "worker" ? () => [{ name: "yield" }] : explode("getAllTools"),
		getActiveTools: explode("getActiveTools"),
	};
	return { pi: stub as unknown as ExtensionAPI, seen };
}


describe("extension factory", () => {
	test("registers without invoking any runtime action", () => {
		const { pi, seen } = recordingApi();
		expect(() => ompOrchestrate(pi)).not.toThrow();
		expect(seen.label).toBe("Orchestrate");
	});

	test("registers the lifecycle entrypoints the host dispatches", () => {
		const { pi, seen } = recordingApi();
		ompOrchestrate(pi);
		expect([...new Set(seen.events)].sort()).toEqual(
			["tool_call", "session_start", "session_switch", "session_branch", "goal_updated", "tool_result", "session_shutdown"].sort(),
		);
	});

	test("registers the four commands and five schema-visible tools", () => {
		const { pi, seen } = recordingApi();
		ompOrchestrate(pi);
		expect(seen.commands.sort()).toEqual(
			["orchestrate-bind", "orchestrate-roster", "orchestrate-run", "orchestrate-status"].sort(),
		);
		expect(seen.tools.sort()).toEqual(
			["orc_bot_review_probe", "orc_bot_review_request", "orc_conflict_probe", "orc_review_round_policy", "orc_run_status"].sort(),
		);
	});
	test("keeps claim and exit state private to reused factory bindings", async () => {
		const beads = new Map<string, BdBead>([
			["orc-parent-1", { id: "orc-parent-1", status: "in_progress", assignee: "parent" }],
			["orc-child-1", { id: "orc-child-1", status: "in_progress", assignee: "child" }],
			["orc-child-2", { id: "orc-child-2", status: "open", assignee: "" }],
		]);
		const showSpy = spyOn(actualBd, "bdShow").mockImplementation(async id => beads.get(id) ?? null);
		try {
			const parent = recordingApi("worker");
			const child = recordingApi("worker");
			ompOrchestrate(parent.pi);
			ompOrchestrate(child.pi);
			const parentToolCall = parent.seen.eventHandlers.get("tool_call")!.at(-1)!;
			const childToolCall = child.seen.eventHandlers.get("tool_call")!.at(-1)!;
			const parentResult = parent.seen.eventHandlers.get("tool_result")!.at(-1)!;
			const childResult = child.seen.eventHandlers.get("tool_result")!.at(-1)!;
			const parentCtx = {
				cwd: "/tmp/orc-parent",
				getSystemPrompt: () => ["ORC-ROLE: implementer"],
			} as unknown as ExtensionContext;
			const childCtx = {
				cwd: "/tmp/orc-child",
				getSystemPrompt: () => ["ORC-ROLE: implementer"],
			} as unknown as ExtensionContext;
			const claimReport = (id: string, actor: string) => ({
				toolName: "bash",
				isError: false,
				input: { command: "bd ready --metadata-field role=implementer --claim --json" },
				details: {},
				content: [{ type: "text", text: JSON.stringify([{ id, status: "in_progress", assignee: actor }]) }],
			});

			await parentResult(claimReport("orc-parent-1", "parent"));
			expect(await childToolCall(
				{ toolName: "bash", input: { command: "bd ready --metadata-field role=implementer --claim --json" } },
				childCtx,
			)).toBeUndefined();
			expect(await parentToolCall(
				{ toolName: "bash", input: { command: "bd update orc-parent-2 --claim" } },
				parentCtx,
			)).toMatchObject({ block: true, reason: expect.stringContaining("orc-parent-1") });

			await childResult(claimReport("orc-child-1", "child"));
			expect(await childToolCall(
				{ toolName: "bash", input: { command: "bd update orc-child-1 --status open" } },
				childCtx,
			)).toBeUndefined();
			beads.set("orc-child-1", { id: "orc-child-1", status: "open", assignee: "" });
			expect(await childToolCall(
				{ toolName: "bash", input: { command: "bd update orc-child-2 --claim" } },
				childCtx,
			)).toBeUndefined();
			expect(await parentToolCall(
				{ toolName: "bash", input: { command: "bd update orc-parent-2 --claim" } },
				parentCtx,
			)).toMatchObject({ block: true, reason: expect.stringContaining("orc-parent-1") });

			beads.clear();
			const unclaimedParent = recordingApi("worker");
			const unclaimedChild = recordingApi("worker");
			ompOrchestrate(unclaimedParent.pi);
			ompOrchestrate(unclaimedChild.pi);
			const unclaimedParentToolCall = unclaimedParent.seen.eventHandlers.get("tool_call")!.at(-1)!;
			const unclaimedChildToolCall = unclaimedChild.seen.eventHandlers.get("tool_call")!.at(-1)!;
			const unclaimedCtx = {
				cwd: "/tmp/orc-unclaimed",
				getSystemPrompt: () => ["ORC-ROLE: implementer"],
			} as unknown as ExtensionContext;
			const yieldEvent = { toolName: "yield", input: { result: { data: "finished" } } };
			expect(await unclaimedParentToolCall(yieldEvent, unclaimedCtx)).toMatchObject({ block: true });
			expect(await unclaimedParentToolCall(yieldEvent, unclaimedCtx)).toBeUndefined();
			expect(await unclaimedChildToolCall(yieldEvent, unclaimedCtx)).toMatchObject({ block: true });
		} finally {
			showSpy.mockRestore();
		}
	});
});

describe("orchestrate-roster", () => {
	function roster() {
		const { pi, seen } = recordingApi();
		ompOrchestrate(pi);
		const notifications: { message: string; level: string }[] = [];
		const handler = seen.handlers.get("orchestrate-roster")!;
		const ctx = {
			ui: { notify: (message: string, level: string) => notifications.push({ message, level }) },
		} as unknown as Parameters<CommandHandler>[1];
		return { run: () => handler("", ctx), notifications };
	}

	test("reports complete mixed role queues with all five reads in flight", async () => {
		const counts: Record<string, number> = {
			architect: 2, implementer: 137, reviewer: 0, researcher: 1, shepherd: 3,
		};
		const exit = Promise.withResolvers<number>();
		let started = 0;
		const spawn = spyOn(Bun, "spawn").mockImplementation((...args) => {
			started++;
			const argv = args[0] as string[];
			const role = argv[argv.indexOf("--metadata-field") + 1]!.split("=")[1]!;
			const limitIndex = argv.indexOf("--limit");
			const limit = limitIndex < 0 ? 100 : Number(argv[limitIndex + 1]);
			const count = limit === 0 ? counts[role]! : Math.min(counts[role]!, limit);
			const rows = Array.from({ length: count }, (_, index) => ({ id: `${role}-${index}` }));
			return {
				stdout: new Response(JSON.stringify({ schema_version: 1, data: rows })).body,
				stderr: new Response("").body,
				exited: exit.promise,
				kill: () => { },
			} as unknown as Bun.Subprocess;
		});
		try {
			const command = roster();
			const result = command.run();
			try {
				expect(started).toBe(5);
				expect(command.notifications).toEqual([]);
			} finally {
				exit.resolve(0);
				await result;
			}
			expect(command.notifications).toEqual([{
				message: "architect: 2 ready\nimplementer: 137 ready\nreviewer: 0 ready\nresearcher: 1 ready\nshepherd: 3 ready",
				level: "info",
			}]);
		} finally {
			spawn.mockRestore();
		}
	});

	test.each([
		{ stdout: "[]", code: 1 },
		{ stdout: '{"schema_version":1,"data":[{"title":"missing id"}]}', code: 0 },
		{ stdout: '[{"id":"truncated"}', code: 0 },
	])("keeps unavailable role evidence distinct from empty queues: %j", async failure => {
		const spawn = spyOn(Bun, "spawn").mockImplementation((...args) => {
			const argv = args[0] as string[];
			const failed = argv.includes("role=implementer");
			return {
				stdout: new Response(failed ? failure.stdout : "[]").body,
				stderr: new Response("").body,
				exited: Promise.resolve(failed ? failure.code : 0),
				kill: () => { },
			} as unknown as Bun.Subprocess;
		});
		try {
			const command = roster();
			await command.run();
			expect(command.notifications).toEqual([{
				message: "architect: 0 ready\nimplementer: unavailable\nreviewer: 0 ready\nresearcher: 0 ready\nshepherd: 0 ready",
				level: "warning",
			}]);
		} finally {
			spawn.mockRestore();
		}
	});
});

describe("actor rewrite keeps claim gates active", () => {
	async function activeRun(): Promise<{ root: string; prior: string | undefined }> {
		const root = await mkdtemp(join(tmpdir(), "orc-index-actor-"));
		await mkdir(join(root, ".orchestration"), { recursive: true });
		await writeFile(join(root, ".orchestration", ".active-run"), JSON.stringify({ schema_version: 1, run_id: "orc-run" }));
		const prior = process.env.ORCHESTRATE_MARKER_FILE;
		process.env.ORCHESTRATE_MARKER_FILE = join(root, ".orchestration", ".active-run");
		return { root, prior };
	}

	function restoreMarker(prior: string | undefined): void {
		if (prior === undefined) delete process.env.ORCHESTRATE_MARKER_FILE;
		else process.env.ORCHESTRATE_MARKER_FILE = prior;
	}

	test("still blocks a rewritten claim rejected by routing", async () => {
		const { root, prior } = await activeRun();
		const show = spyOn(actualBd, "bdShow").mockResolvedValue({
			id: "orc-claim",
			labels: ["agent:reviewer"],
			metadata: { actor: "worker-1" },
		});
		try {
			const { pi, seen } = recordingApi("worker");
			ompOrchestrate(pi);
			const toolCall = seen.eventHandlers.get("tool_call")!.at(-1)!;
			const result = await toolCall(
				{ toolName: "bash", input: { command: "bd update orc-claim --claim" }, toolCallId: "claim-route" },
				{ cwd: root, getSystemPrompt: () => ["ORC-ROLE: implementer"] } as unknown as ExtensionContext,
			);
			expect(result).toMatchObject({ block: true, reason: expect.stringContaining("reviewer") });
		} finally {
			show.mockRestore();
			restoreMarker(prior);
			await rm(root, { recursive: true, force: true });
		}
	});

	test("returns the prefixed command after an eligible rewritten claim", async () => {
		const { root, prior } = await activeRun();
		const show = spyOn(actualBd, "bdShow").mockResolvedValue({
			id: "orc-claim",
			labels: ["agent:implementer"],
			metadata: { actor: "worker-1" },
		});
		try {
			const { pi, seen } = recordingApi("worker");
			ompOrchestrate(pi);
			const toolCall = seen.eventHandlers.get("tool_call")!.at(-1)!;
			const result = await toolCall(
				{ toolName: "bash", input: { command: "bd update orc-claim --claim" }, toolCallId: "claim-pass" },
				{ cwd: root, getSystemPrompt: () => ["ORC-ROLE: implementer"] } as unknown as ExtensionContext,
			);
			expect(result).toMatchObject({ input: { command: "BEADS_ACTOR=worker-1 BD_ACTOR=worker-1 bd update orc-claim --claim" } });
		} finally {
			show.mockRestore();
			restoreMarker(prior);
			await rm(root, { recursive: true, force: true });
		}
	});
});
