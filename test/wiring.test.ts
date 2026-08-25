import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ToolCallEventResult } from "@oh-my-pi/pi-coding-agent";
import { BD_NOTICE_MESSAGE } from "../src/gates/bd";
import ompOrchestrate from "../src/index";

/**
 * The seam this file covers.
 *
 * `test/index.test.ts` proves the factory SUBSCRIBES a `tool_call` handler, and
 * `test/gate-bd.test.ts` proves `gateBdDiscipline` RETURNS the notice text. Neither
 * proves the subscribed handler reaches the gate and emits, so the wiring between two
 * covered halves was assumed. It is the same defect shape this plugin exists to catch,
 * one level up: an installed check that does nothing.
 *
 * A notice does not travel on the return value -- `ToolCallEventResult` has no advisory
 * shape -- so it leaves through `pi.sendMessage` (`src/gates/bd.ts:564`). The recording
 * stub therefore captures sends instead of exploding on them, which is why the load-time
 * stub in `index.test.ts` cannot be reused: its whole purpose is that `sendMessage`
 * throws.
 */

interface Sent {
	customType?: string;
	content?: string;
	deliverAs?: string;
}

type ToolCallHandler = (
	event: { toolName: string; input: unknown },
	ctx: { cwd: string },
) => Promise<ToolCallEventResult | undefined>;

function runtimeApi(): { pi: ExtensionAPI; handlers: ToolCallHandler[]; sent: Sent[] } {
	const handlers: ToolCallHandler[] = [];
	const sent: Sent[] = [];
	const zodStub: unknown = new Proxy(() => zodStub, { get: () => zodStub, apply: () => zodStub });
	const stub = {
		setLabel: () => {},
		on: (event: string, handler: unknown) => {
			if (event === "tool_call") handlers.push(handler as ToolCallHandler);
		},
		registerCommand: () => {},
		registerTool: () => {},
		zod: zodStub,
		logger: { error: () => {}, debug: () => {}, warn: () => {}, info: () => {} },
		sendMessage: (message: { customType?: string; content?: string }, options?: { deliverAs?: string }) => {
			sent.push({ customType: message.customType, content: message.content, deliverAs: options?.deliverAs });
		},
	};
	return { pi: stub as unknown as ExtensionAPI, handlers, sent };
}

/**
 * OMP delivers a `tool_call` event to every subscriber, so the test does too. This
 * plugin registers two: W3's observe-only preflight watcher and the gate dispatcher.
 * Selecting one by index was the first version of this file and it asserted against the
 * watcher, which sends nothing -- a test that failed while the code was correct. Feeding
 * all of them removes the ordering assumption instead of encoding it.
 */
async function dispatchAll(
	handlers: ToolCallHandler[],
	event: { toolName: string; input: unknown },
	ctx: { cwd: string },
): Promise<(ToolCallEventResult | undefined)[]> {
	if (handlers.length === 0) throw new Error("no tool_call handler was registered");
	const results: (ToolCallEventResult | undefined)[] = [];
	for (const handler of handlers) results.push(await handler(event, ctx));
	return results;
}

describe("gate dispatcher wiring", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "orc-wiring-"));
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	test("an unattributed bd write inside a run emits the identity notice as a steer", async () => {
		await fs.mkdir(path.join(dir, ".orchestration"), { recursive: true });
		await fs.writeFile(path.join(dir, ".orchestration", ".active-run"), "run-wiring-1");
		const { pi, handlers, sent } = runtimeApi();
		ompOrchestrate(pi);

		const results = await dispatchAll(
			handlers,
			{ toolName: "bash", input: { command: "bd update orc-1 --status in_progress" } },
			{ cwd: dir },
		);

		// The notice never refuses: no subscriber blocks, and the command runs.
		expect(results.some((result) => result?.block === true)).toBe(false);
		expect(sent).toHaveLength(1);
		expect(sent[0]?.customType).toBe(BD_NOTICE_MESSAGE);
		expect(sent[0]?.content).toContain("WARN bd identity");
		// Mid-turn: a steer is consumed at the model call carrying this tool's result.
		expect(sent[0]?.deliverAs).toBe("steer");
	});

	test("the same call outside a run emits nothing", async () => {
		const { pi, handlers, sent } = runtimeApi();
		ompOrchestrate(pi);

		await dispatchAll(
			handlers,
			{ toolName: "bash", input: { command: "bd update orc-1 --status in_progress" } },
			{ cwd: dir },
		);

		// No marker, no notice: this is what keeps the gate off every unrelated session
		// in a repository that happens to hold this plugin.
		expect(sent).toHaveLength(0);
	});

	test("an attributed write inside a run emits nothing", async () => {
		await fs.mkdir(path.join(dir, ".orchestration"), { recursive: true });
		await fs.writeFile(path.join(dir, ".orchestration", ".active-run"), "run-wiring-2");
		const { pi, handlers, sent } = runtimeApi();
		ompOrchestrate(pi);

		await dispatchAll(
			handlers,
			{
				toolName: "bash",
				input: { command: "bd update orc-1 --status in_progress", env: { BEADS_ACTOR: "impl-1" } },
			},
			{ cwd: dir },
		);

		expect(sent).toHaveLength(0);
	});

	test("a tool the gate does not cover reaches no gate at all", async () => {
		await fs.mkdir(path.join(dir, ".orchestration"), { recursive: true });
		await fs.writeFile(path.join(dir, ".orchestration", ".active-run"), "run-wiring-3");
		const { pi, handlers, sent } = runtimeApi();
		ompOrchestrate(pi);

		const results = await dispatchAll(handlers, { toolName: "read", input: { path: "README.md" } }, { cwd: dir });

		expect(results.every((result) => result === undefined)).toBe(true);
		expect(sent).toHaveLength(0);
	});
});
