/**
 * Slash-command notices under `omp -p`: OMP's print mode hands handlers a no-op `ui`,
 * so a notice must also reach the process's own output there, and only there. A worker
 * shares the lead's terminal and must stay silent; a JSON stream must stay parseable.
 */

import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { commandNotice, type NoticeContext } from "../src/tools/notice";

const lead = { getAllTools: () => [] } as unknown as ExtensionAPI;
const worker = { getAllTools: () => [{ name: "yield" }] } as unknown as ExtensionAPI;

function ctxOf(hasUI: boolean, mode: NoticeContext["mode"], notices: string[]): NoticeContext {
	return { hasUI, mode, ui: { notify: (text: string) => notices.push(text) } } as unknown as NoticeContext;
}

describe("commandNotice", () => {
	const out = spyOn(process.stdout, "write").mockImplementation(() => true);
	const err = spyOn(process.stderr, "write").mockImplementation(() => true);

	afterEach(() => {
		out.mockClear();
		err.mockClear();
	});

	afterAll(() => {
		out.mockRestore();
		err.mockRestore();
	});

	test("with a UI attached the notice goes to the UI and nowhere else", () => {
		const notices: string[] = [];
		commandNotice(lead, ctxOf(true, "tui", notices), "run bound", "info");

		expect(notices).toEqual(["run bound"]);
		expect(out).not.toHaveBeenCalled();
		expect(err).not.toHaveBeenCalled();
	});

	test("headless text mode prints the notice on stdout, a non-info level named", () => {
		const notices: string[] = [];
		commandNotice(lead, ctxOf(false, "print", notices), "run bound\nstore: x", "info");
		commandNotice(lead, ctxOf(false, "print", notices), "lease lapsed", "warning");

		expect(notices).toEqual(["run bound\nstore: x", "lease lapsed"]);
		expect(out.mock.calls.map(call => call[0])).toEqual(["run bound\nstore: x\n", "warning: lease lapsed\n"]);
		expect(err).not.toHaveBeenCalled();
	});

	test("headless JSON mode keeps stdout for the event stream and prints on stderr", () => {
		commandNotice(lead, ctxOf(false, "json", []), "no run here", "error");

		expect(out).not.toHaveBeenCalled();
		expect(err.mock.calls.map(call => call[0])).toEqual(["error: no run here\n"]);
	});

	test("a worker has no UI either, but its stdout is the lead's terminal: silent", () => {
		const notices: string[] = [];
		commandNotice(worker, ctxOf(false, "print", notices), "run bound", "info");

		expect(notices).toEqual(["run bound"]);
		expect(out).not.toHaveBeenCalled();
		expect(err).not.toHaveBeenCalled();
	});
});
