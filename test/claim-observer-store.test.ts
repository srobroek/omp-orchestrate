/**
 * `observeClaimResult` against a store the installed `bd` built: the report a real
 * `bd ready --claim --json` prints, rendered as the host's column cap delivers it.
 *
 * rt-ts D3: a task whose description ran past `tools.outputMaxColumns` arrived with that
 * line cut, and the claim went unrecorded. Unit fixtures had stood in for both `bd`'s
 * output and the store's answer, so this file uses neither stand-in.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { observeClaimResult } from "../src/claim-observer";
import { createClaimState } from "../src/claim-state";

const BD_AVAILABLE = Bun.which("bd") !== null;
const ACTOR = "Arch.Worker";
const CLAIM = "bd ready --unassigned --claim --json";
/** The host's default `tools.outputMaxColumns`. */
const MAX_COLUMN = 768;

/** What the sink does to each line over the cap (`session/streaming-output.ts` `#applyColumnCap`). */
function columnCap(output: string): string {
	return output.trimEnd().split("\n").map(line => line.length > MAX_COLUMN ? `${line.slice(0, MAX_COLUMN - 1)}…` : line).join("\n");
}

describe.skipIf(!BD_AVAILABLE)("observeClaimResult on a claim bd made", () => {
	let root: string;
	let beadsDir: string;
	/** The capped rendering of the real claim report, with the host's footer and cap notice. */
	let rendered: string;
	let claimedId: string;
	let warned: Record<string, unknown>[] = [];
	let sent: unknown[] = [];
	const previous = { BD_BIN: process.env.BD_BIN, ORCHESTRATE_MARKER_FILE: process.env.ORCHESTRATE_MARKER_FILE };

	const pi = {
		logger: {
			warn: (message: string, data?: Record<string, unknown>) => { warned.push({ message, ...data }); },
			error: () => {},
			info: () => {},
			debug: () => {},
		},
		sendMessage: (message: unknown) => { sent.push(message); },
	} as unknown as ExtensionAPI;

	/** `process.env` without bd's own variables, so a pinned session's store never receives the fixture. */
	function fixtureEnv(): Record<string, string> {
		const env: Record<string, string> = { BD_ROUTER_OFF: "1", BD_NON_INTERACTIVE: "1", BEADS_ACTOR: ACTOR };
		for (const [key, value] of Object.entries(process.env)) {
			if (value !== undefined && !key.startsWith("BEADS_") && key !== "BD_BIN") env[key] = value;
		}
		return env;
	}

	async function bd(args: string[]): Promise<string> {
		const proc = Bun.spawn(["bd", ...args], { cwd: path.dirname(beadsDir), env: fixtureEnv(), stdout: "pipe", stderr: "pipe", stdin: "ignore" });
		const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
		if (code !== 0) throw new Error(`bd ${args.join(" ")} failed (${code}): ${stderr}`);
		return stdout;
	}

	// `bd init` builds a Dolt store; it flaked once at bun's 5 s default under load.
	beforeAll(async () => {
		root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "orc-observer-bd-"));
		const store = path.join(root, "store");
		await fs.mkdir(store);
		beadsDir = path.join(store, ".beads");
		await bd(["init", "--skip-hooks", "--skip-agents", "--quiet", "-p", "obs"]);
		// A brief-length description: one pretty-printed JSON line well past the cap.
		await bd(["create", "Long brief", "-t", "task", "-p", "1", "--silent", "--description", "x".repeat(900)]);
		const report = await bd(["ready", "--unassigned", "--claim", "--json"]);
		expect(report.split("\n").some(line => line.length > MAX_COLUMN)).toBe(true);
		const parsed: unknown = JSON.parse(report);
		claimedId = Array.isArray(parsed) && typeof parsed[0]?.id === "string" ? parsed[0].id : "";
		expect(claimedId).not.toBe("");
		rendered = `${columnCap(report)}\n\nWall time: 0.40 seconds\nSome lines truncated to ${MAX_COLUMN} chars`;
	}, 30_000);

	afterEach(() => {
		warned = [];
		sent = [];
		for (const [name, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	});

	afterAll(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	function event(input: Record<string, unknown>, details: Record<string, unknown>) {
		return { toolName: "bash", input: { command: CLAIM, ...input }, details: { wallTimeMs: 400, ...details }, content: [{ text: rendered }] };
	}

	test("the capped report binds the claim without the store, even with no actor on the command", async () => {
		// The store is unreachable here, as it was in effect during rt-ts D3. The intact
		// lines of the report name the bead and its assignee, and that is what is recorded.
		process.env.BD_BIN = path.join(root, "no-such-bd");
		const claims = createClaimState();

		await observeClaimResult(pi, claims, event({}, { meta: { limits: { columnTruncated: { maxColumn: MAX_COLUMN } } } }));

		expect(claims.observedClaim()).toEqual({ actor: ACTOR, beadIds: [claimedId] });
		expect(warned).toEqual([]);
		expect(sent).toEqual([]);
	});

	test("a report bd's store must answer for is found by the command's actor on bd 1.2.2", async () => {
		// Window truncation removes lines, so the report is never read; the run's store,
		// named by the active-run marker, is asked which bead the actor now holds.
		const marker = path.join(root, "active-run.json");
		await fs.writeFile(marker, JSON.stringify({ schema_version: 1, run_id: "obs-run", beads_dir: beadsDir }));
		process.env.ORCHESTRATE_MARKER_FILE = marker;
		const claims = createClaimState();

		await observeClaimResult(pi, claims, event({ env: { BEADS_ACTOR: ACTOR } }, { meta: { truncation: { originalLines: 20 } } }));

		expect(claims.observedClaim()).toEqual({ actor: ACTOR, beadIds: [claimedId] });
		expect(warned).toMatchObject([{ reason: "output truncated", actor: ACTOR }]);
		expect(sent).toEqual([]);
	}, 15_000);
});
