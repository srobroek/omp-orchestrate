import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import ompOrchestrate from "../src/index";

interface Registered {
	events: string[];
	commands: string[];
	tools: string[];
	label?: string;
}

/**
 * A factory must only register during load. Calling a runtime action such as
 * `sendMessage` at load time throws `ExtensionRuntimeNotInitializedError`, so this
 * stub makes every runtime action explode and asserts the factory never reaches one.
 */
function recordingApi(): { pi: ExtensionAPI; seen: Registered } {
	const seen: Registered = { events: [], commands: [], tools: [] };
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
		registerCommand: (name: string) => {
			seen.commands.push(name);
		},
		registerTool: (definition: { name: string }) => {
			seen.tools.push(definition.name);
		},
		zod: zodStub,
		logger: { error: () => {}, debug: () => {}, warn: () => {}, info: () => {} },
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

	test("subscribes the gate dispatcher, injection, supervision, and watchers", () => {
		const { pi, seen } = recordingApi();
		ompOrchestrate(pi);
		const counts = new Map<string, number>();
		for (const event of seen.events) counts.set(event, (counts.get(event) ?? 0) + 1);
		// tool_call: the gate dispatcher plus W3's observe-only preflight watcher.
		expect(counts.get("tool_call")).toBe(2);
		// session_start: worker protocol injection, S1 reaper wiring, W1-W3 wiring.
		expect(counts.get("session_start")).toBe(3);
		// goal_updated: W4 relay, lead-side.
		expect(counts.get("goal_updated")).toBe(1);
		expect(seen.events).toHaveLength(6);
	});

	test("registers the four commands and four schema-visible tools", () => {
		const { pi, seen } = recordingApi();
		ompOrchestrate(pi);
		expect(seen.commands.sort()).toEqual(
			["orchestrate-bind", "orchestrate-roster", "orchestrate-run", "orchestrate-status"].sort(),
		);
		expect(seen.tools.sort()).toEqual(
			["orc_bot_review_probe", "orc_conflict_probe", "orc_resolve_queue_dispatch", "orc_run_status"].sort(),
		);
	});
});
