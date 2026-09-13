/**
 * `runStatusReport` against a store the installed `bd` built: the Attention section over
 * claims `bd` itself made, renewed and released.
 *
 * rt-ts D5: after an implementer REPORTed -- assignee cleared, `in_progress` awaiting
 * review -- status kept listing the bead as `lease lapsed: <bead> held by nobody` once
 * its stale `lease_until` passed. The unit suite stands in for `bd`, so the shapes a
 * release leaves on a real bead are checked here.
 *
 * wsy: the epic's comments were read without the run's cwd, so a report requested from
 * any other directory (the test process here) said the comments could not be read.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runStatusReport } from "../src/run-state";

const BD_AVAILABLE = Bun.which("bd") !== null;
const LEAD = "lead:status-test";
const HELD_BY = "impl-dead";
const RELEASED_BY = "impl-reported";
/** A lease deadline every wall clock has passed. */
const LAPSED_AT = "2020-01-01T00:15:00Z";

describe.skipIf(!BD_AVAILABLE)("runStatusReport on a store bd built", () => {
	let root: string;
	let repo: string;
	let epic: string;
	let held: string;
	let released: string;

	/** `process.env` without bd's own variables, so a pinned session's store never receives the fixture. */
	function fixtureEnv(actor: string): Record<string, string> {
		const env: Record<string, string> = { BD_ROUTER_OFF: "1", BD_NON_INTERACTIVE: "1", BEADS_ACTOR: actor };
		for (const [key, value] of Object.entries(process.env)) {
			if (value !== undefined && !key.startsWith("BEADS_") && key !== "BD_BIN") env[key] = value;
		}
		return env;
	}

	async function bd(actor: string, args: string[]): Promise<string> {
		const proc = Bun.spawn(["bd", ...args], { cwd: repo, env: fixtureEnv(actor), stdout: "pipe", stderr: "pipe", stdin: "ignore" });
		const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
		if (code !== 0) throw new Error(`bd ${args.join(" ")} failed (${code}): ${stderr}`);
		return stdout.trim();
	}

	// `bd init` builds a Dolt store; it flaked once at bun's 5 s default under load.
	beforeAll(async () => {
		root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "orc-status-bd-"));
		repo = path.join(root, "repo");
		await fs.mkdir(repo);
		await bd(LEAD, ["init", "--skip-hooks", "--skip-agents", "--quiet", "-p", "st"]);
		epic = await bd(LEAD, ["create", "Run", "-t", "epic", "-p", "1", "--silent"]);
		await bd(LEAD, ["update", epic, "--claim", "--set-metadata", `lease_until=2999-01-01T00:00:00Z`]);
		const feature = await bd(LEAD, ["create", "Feature", "-t", "feature", "-p", "1", "--parent", epic, "--silent"]);
		held = await bd(LEAD, ["create", "Held", "-t", "task", "-p", "1", "--parent", feature, "--silent"]);
		released = await bd(LEAD, ["create", "Reported", "-t", "task", "-p", "1", "--parent", feature, "--silent"]);
		// Both claimed and leased as `renewLease` writes it; the lease is long past.
		for (const [task, actor] of [[held, HELD_BY], [released, RELEASED_BY]] as const) {
			await bd(actor, ["update", task, "--claim", "--set-metadata", `lease_until=${LAPSED_AT}`]);
		}
		// The REPORTED release as `recordPushed` (`src/gates/exit.ts`) writes it: fenced by
		// `--claim`, assignee cleared in the same write, status restated.
		await bd(RELEASED_BY, ["update", released, "--claim", "--assignee", "", "--set-metadata", "pushed_sha=abc1234", "--status", "in_progress"]);
		await fs.mkdir(path.join(repo, ".orchestration"));
		await fs.writeFile(
			path.join(repo, ".orchestration", ".active-run"),
			JSON.stringify({ schema_version: 1, run_id: epic, session_id: "s1", beads_dir: path.join(repo, ".beads"), store_origin: "checkout" }),
		);
	}, 30_000);

	afterAll(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	test("a lapsed lease is attention for the bead still held; the REPORTED bead nobody holds is not", async () => {
		// Expiry is `max(lease_until, updated_at + TTL)` and the claims were just written, so
		// the clock is read a day on: both tasks' leases have lapsed by then.
		const report = await runStatusReport(repo, Date.now() + 24 * 60 * 60 * 1000);

		expect(report.lines[1]).toBe(`epic ${epic}: in_progress`);
		expect(report.lines.filter(line => line.startsWith("- lease lapsed:"))).toEqual([
			expect.stringMatching(new RegExp(`^- lease lapsed: ${held.replaceAll(".", "\\.")} held by ${HELD_BY}, lease lapsed at 20\\d\\d-`)),
		]);
		expect(report.lines.filter(line => line.includes(released))).toEqual([]);
	}, 30_000);

	test("the epic's WARN reaches attention when the report runs from another directory", async () => {
		await bd(LEAD, ["comment", epic, "WARN landing capabilities not recorded"]);
		expect(process.cwd()).not.toBe(repo);

		const report = await runStatusReport(repo, Date.now());

		expect(report.lines).toContain("- WARN landing capabilities not recorded");
		expect(report.lines).not.toContain(`- comments on ${epic} could not be read`);
	}, 30_000);
});
