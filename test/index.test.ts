import { describe, expect, spyOn, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import ompOrchestrate from "../src/index";

type CommandHandler = Parameters<ExtensionAPI["registerCommand"]>[1]["handler"];

interface Registered {
	events: string[];
	commands: string[];
	tools: string[];
	handlers: Map<string, CommandHandler>;
	label?: string;
}

/**
 * A factory must only register during load. Calling a runtime action such as
 * `sendMessage` at load time throws `ExtensionRuntimeNotInitializedError`, so this
 * stub makes every runtime action explode and asserts the factory never reaches one.
 */
function recordingApi(): { pi: ExtensionAPI; seen: Registered } {
	const seen: Registered = { events: [], commands: [], tools: [], handlers: new Map() };
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
		on: (event: string) => {
			seen.events.push(event);
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
		getAllTools: explode("getAllTools"),
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
			["tool_call", "session_start", "goal_updated", "tool_result", "session_shutdown"].sort(),
		);
	});

	test("registers the four commands and three schema-visible tools", () => {
		const { pi, seen } = recordingApi();
		ompOrchestrate(pi);
		expect(seen.commands.sort()).toEqual(
			["orchestrate-bind", "orchestrate-roster", "orchestrate-run", "orchestrate-status"].sort(),
		);
		expect(seen.tools.sort()).toEqual(
			["orc_bot_review_probe", "orc_conflict_probe", "orc_run_status"].sort(),
		);
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
