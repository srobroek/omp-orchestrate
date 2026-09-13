/**
 * G4 against a store the installed `bd` built.
 *
 * The unit tests mock `bdRun`, and two release defects shipped through that seam. bd 1.2.2
 * refuses `--claim` on the released `in_progress` bead every contract leaves behind, so the
 * fenced `pushed_sha` stamp never landed; and it refuses a `relates-to` from a review wisp
 * to the parent it hangs off, so a reviewer's verdict on the node was never linked
 * evidence. Origin stays a stand-in -- these defects are the store's -- but every bead,
 * claim, comment and refusal here is the real binary's. Skipped where `bd` is not installed
 * (CI).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext, ToolCallEventResult } from "@oh-my-pi/pi-coding-agent";
import { logger } from "@oh-my-pi/pi-utils";
import * as actualBd from "../src/bd";
import type { BdBead } from "../src/bd";
import { createClaimState } from "../src/claim-state";
import { createExitGuard } from "../src/gates/exit";
import { gateWorktreeScope } from "../src/gates/worktree";
import * as origin from "../src/origin";

const BD_AVAILABLE = Bun.which("bd") !== null;
/** The head every fixture worker pushed; origin's stand-in answers with it. */
const HEAD = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const BASE = "0123456789abcdef0123456789abcdef01234567";
/** One live yield: a handful of real spawns at 0.5-1 s each, well inside the gate's 20 s deadline. */
const YIELD_MS = 60_000;

function ctx(cwd: string, role: string): ExtensionContext {
	return { cwd, getSystemPrompt: () => [`ORC-ROLE: ${role}`] } as unknown as ExtensionContext;
}

describe.skipIf(!BD_AVAILABLE)("G4 on a store bd built", () => {
	let root: string;
	let beadsDir: string;
	let priorMarker: string | undefined;
	let claims = createClaimState();
	let gate: (ctx: ExtensionContext, input?: Record<string, unknown>) => Promise<ToolCallEventResult | undefined>;

	/** `process.env` without bd's own variables, so a pinned session's store never receives the fixture. */
	function fixtureEnv(): Record<string, string> {
		const env: Record<string, string> = { BD_ROUTER_OFF: "1", BD_NON_INTERACTIVE: "1", BD_NO_PAGER: "1" };
		for (const [key, value] of Object.entries(process.env)) {
			if (value !== undefined && !key.startsWith("BEADS_") && key !== "BD_BIN") env[key] = value;
		}
		return env;
	}

	/** Run the real `bd` against the fixture store, as a worker's shell would. */
	async function bd(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
		const proc = Bun.spawn(["bd", "--db", beadsDir, ...args], { cwd: root, env: fixtureEnv(), stdout: "pipe", stderr: "pipe", stdin: "ignore" });
		const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
		return { code, stdout, stderr };
	}

	/** A write that must land; the failure text is the assertion message. */
	async function write(...args: string[]): Promise<void> {
		const result = await bd(...args);
		expect(result.stderr + result.stdout, `bd ${args.join(" ")}`).toSatisfy(() => result.code === 0);
	}

	async function create(title: string, ...args: string[]): Promise<string> {
		const result = await bd("create", title, "--silent", ...args);
		expect(result.code, result.stderr).toBe(0);
		return result.stdout.trim();
	}

	async function shown(id: string): Promise<BdBead> {
		const result = await bd("show", id, "--json");
		expect(result.code, result.stderr).toBe(0);
		return (JSON.parse(result.stdout) as BdBead[])[0]!;
	}

	// `bd init` builds a Dolt store; it flaked once at bun's 5 s default under load.
	beforeAll(async () => {
		root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "orc-exit-bd-"));
		beadsDir = path.join(root, ".beads");
		const init = Bun.spawn(["bd", "init", "--skip-hooks", "--skip-agents", "--quiet", "-p", "live"], {
			cwd: root, env: fixtureEnv(), stdout: "pipe", stderr: "pipe", stdin: "ignore",
		});
		const [stderr, code] = await Promise.all([new Response(init.stderr).text(), init.exited]);
		if (code !== 0) throw new Error(`bd init failed (${code}): ${stderr}`);
		// The active-run marker names the store, so every read and write the gate spawns
		// carries `--db <beadsDir>` whatever this process's own pin says.
		const marker = path.join(root, "active-run.json");
		await fs.writeFile(marker, JSON.stringify({ schema_version: 1, run_id: "pending", beads_dir: beadsDir }));
		priorMarker = process.env.ORCHESTRATE_MARKER_FILE;
		process.env.ORCHESTRATE_MARKER_FILE = marker;
	}, 30_000);

	afterAll(async () => {
		if (priorMarker === undefined) delete process.env.ORCHESTRATE_MARKER_FILE;
		else process.env.ORCHESTRATE_MARKER_FILE = priorMarker;
		await fs.rm(root, { recursive: true, force: true });
	});

	/** `logger.warn` payloads, so an exit allowed by the refusal budget can be told from one accepted on evidence. */
	let warned: Record<string, unknown>[] = [];
	const spies = [
		spyOn(origin, "originHead").mockImplementation(async () => ({ kind: "at", sha: HEAD })),
		spyOn(origin, "localState").mockImplementation(async () => ({ head: HEAD, dirty: false })),
		spyOn(logger, "warn").mockImplementation(((_message: string, data?: Record<string, unknown>) => {
			warned.push(data ?? {});
		}) as typeof logger.warn),
	];
	afterAll(() => { for (const spy of spies) spy.mockRestore(); });

	beforeEach(() => {
		claims = createClaimState();
		gate = createExitGuard(claims);
		warned = [];
	});

	/** The reviewer's bash call as G2 judges it in its session, reading the real store. */
	function shell(command: string): Promise<ToolCallEventResult | undefined> {
		return gateWorktreeScope(claims, ctx(root, "reviewer"), "bash", { command });
	}

	/** The documented review wisp under `node`: a child, no other edge, stamped for round 1 at HEAD. */
	function reviewWisp(node: string): Promise<string> {
		return create(`Review ${node}`, "--parent", node, "--ephemeral", "-t", "task", "-p", "1", "--labels", "orc-node",
			"--metadata", JSON.stringify({ role: "reviewer", head_sha: HEAD, review_round: 1, origin_bead: node }));
	}

	/** The comment texts on `id`, as the store has them. */
	async function commentsOn(id: string): Promise<string[]> {
		const result = await bd("comments", id, "--json");
		expect(result.code, result.stderr).toBe(0);
		const comments: { text: string }[] = JSON.parse(result.stdout);
		return comments.map(comment => comment.text);
	}

	/** The failed checks a refusal carries. */
	function checks(result: ToolCallEventResult | undefined): { check: string; detail: string }[] {
		expect(result?.block).toBe(true);
		const verdict: { failed_checks: { check: string; detail: string }[] } = JSON.parse(result!.reason!);
		return verdict.failed_checks;
	}

	/** A git task bead as the dispatcher routes it, with its base and head stamped. */
	function task(title: string): Promise<string> {
		return create(title, "--labels", "orc-node", "--metadata", JSON.stringify({ role: "implementer", execution_kind: "git", head_sha: HEAD, base_sha: BASE }));
	}

	/** The implementer's pre-yield writes: the pushed token in REPORTED, the handoff label, the claim kept. */
	async function report(id: string, actor: string): Promise<void> {
		await write("update", id, "--actor", actor, "--add-label", "agent:reviewer");
		await write("comments", "add", id, `REPORTED ${id} src/api.ts pushed=omp/task/${actor}@${HEAD}`, "--actor", actor);
	}

	/** Every write the gate issues, each passed through to the real binary. */
	function recordWrites(): { issued: string[][]; restore: () => void } {
		const issued: string[][] = [];
		const realRun = actualBd.bdRun;
		const run = spyOn(actualBd, "bdRun").mockImplementation(async (args, timeoutMs, cwd) => {
			issued.push(args);
			return await realRun(args, timeoutMs, cwd);
		});
		return { issued, restore: () => run.mockRestore() };
	}

	describe("recordPushed", () => {
		test("a held report is stamped and released in one fenced write", async () => {
			const id = await task("held task");
			await write("update", id, "--actor", "impl-A", "--claim");
			await report(id, "impl-A");
			const writes = recordWrites();
			try {
				claims.recordClaim({ actor: "impl-A", beadIds: [id] });
				expect(await gate(ctx(root, "implementer"))).toBeUndefined();
			} finally {
				writes.restore();
			}
			expect(writes.issued).toEqual([["update", id, "--actor", "impl-A", "--claim", "--assignee", "", "--set-metadata", `pushed_sha=${HEAD}`, "--status", "in_progress"]]);

			const after = await shown(id);
			expect(after.metadata?.pushed_sha).toBe(HEAD);
			expect(after.assignee ?? "").toBe("");
			expect(after.status).toBe("in_progress");
		}, YIELD_MS);

		test("a bead released before the proof is accepted with no write at all", async () => {
			const id = await task("released task");
			await write("update", id, "--actor", "impl-A", "--claim");
			await report(id, "impl-A");
			await write("update", id, "--actor", "impl-A", "--assignee", "");
			// The refusal the release re-test observed: the released bead is `in_progress`,
			// and bd claims nothing that is not `open`, its ex-holder included. No fence exists
			// for this bead, so the gate must not write to it.
			const shipped = await bd("update", id, "--actor", "impl-A", "--claim", "--assignee", "", "--set-metadata", `pushed_sha=${HEAD}`, "--status", "in_progress");
			expect(shipped.code).toBe(1);
			expect(shipped.stderr).toContain("not claimable: status in_progress");
			const writes = recordWrites();
			try {
				claims.recordClaim({ actor: "impl-A", beadIds: [id] });
				expect(await gate(ctx(root, "implementer"))).toBeUndefined();
			} finally {
				writes.restore();
			}
			expect(writes.issued).toEqual([]);

			const after = await shown(id);
			expect(after.metadata?.pushed_sha).toBeUndefined();
			expect(after.assignee ?? "").toBe("");
		}, YIELD_MS);

		test("a parked bead the worker kept is accepted unstamped with its claim retained", async () => {
			const id = await task("parked task");
			await write("update", id, "--actor", "impl-A", "--claim");
			await write("comments", "add", id, `BLOCKED ${id} missing prerequisite`, "--actor", "impl-A");
			await write("comments", "add", id, `REPORTED ${id} partial: src/x.ts pushed=omp/task/impl-A@${HEAD}`, "--actor", "impl-A");
			await write("update", id, "--actor", "impl-A", "--status", "blocked");
			const writes = recordWrites();
			try {
				claims.recordClaim({ actor: "impl-A", beadIds: [id] });
				expect(await gate(ctx(root, "implementer"))).toBeUndefined();
			} finally {
				writes.restore();
			}
			expect(writes.issued).toEqual([]);

			const after = await shown(id);
			expect(after.metadata?.pushed_sha).toBeUndefined();
			expect(after.assignee).toBe("impl-A");
			expect(after.status).toBe("blocked");
		}, YIELD_MS);

		test("a successor holding the bead by the time of the write refuses the exit and is left untouched", async () => {
			const id = await task("raced task");
			await write("update", id, "--actor", "impl-A", "--claim");
			await report(id, "impl-A");
			// The gate has read the bead held by impl-A; before its write lands, the claim has
			// changed hands (a lapsed lease reaped and re-claimed). Interposed on the one seam
			// every write takes, so the refusal below is bd's own.
			const realRun = actualBd.bdRun;
			let raced = false;
			const run = spyOn(actualBd, "bdRun").mockImplementation(async (args, timeoutMs, cwd) => {
				if (args[0] === "update" && !raced) {
					raced = true;
					await write("update", id, "--actor", "reaper", "--assignee", "impl-B");
				}
				return await realRun(args, timeoutMs, cwd);
			});
			try {
				claims.recordClaim({ actor: "impl-A", beadIds: [id] });
				const result = await gate(ctx(root, "implementer"));
				expect(result?.block).toBe(true);
				expect(result?.reason).toContain("already claimed by impl-B");
			} finally {
				run.mockRestore();
			}
			expect(raced).toBe(true);

			const after = await shown(id);
			expect(after.metadata?.pushed_sha).toBeUndefined();
			expect(after.assignee).toBe("impl-B");
			expect(after.status).toBe("in_progress");
		}, YIELD_MS);

		/** A git feature epic as the architect stamps it: branch, push target and the integrated head. */
		function feature(title: string): Promise<string> {
			return create(title, "-t", "feature", "--labels", "orc-node", "--metadata", JSON.stringify({ role: "architect", execution_kind: "git", branch: "feat/login", push: "origin/feat/login", head_sha: HEAD, base_sha: BASE }));
		}

		test("an architect completing its epic yields holding it, and is stamped and released in one fenced write", async () => {
			const id = await feature("completed feature");
			await write("update", id, "--actor", "arch-A", "--claim");
			await write("update", id, "--actor", "arch-A", "--add-label", "agent:reviewer");
			await write("comments", "add", id, `REPORTED ${id} integrated 2 tasks; head_sha=${HEAD}`, "--actor", "arch-A");
			const writes = recordWrites();
			try {
				claims.recordClaim({ actor: "arch-A", beadIds: [id] });
				expect(await gate(ctx(root, "architect"))).toBeUndefined();
			} finally {
				writes.restore();
			}
			expect(writes.issued).toEqual([["update", id, "--actor", "arch-A", "--claim", "--assignee", "", "--set-metadata", `pushed_sha=${HEAD}`, "--status", "in_progress"]]);

			const after = await shown(id);
			expect(after.metadata?.pushed_sha).toBe(HEAD);
			expect(after.assignee ?? "").toBe("");
			expect(after.status).toBe("in_progress");
		}, YIELD_MS);

		test("an architect's park releases itself and is accepted unstamped with no write", async () => {
			const id = await feature("parked feature");
			await write("update", id, "--actor", "arch-A", "--claim");
			await write("comments", "add", id, `BLOCKED ${id} design question on the token format`, "--actor", "arch-A");
			await write("update", id, "--actor", "arch-A", "--status", "blocked");
			await write("update", id, "--actor", "arch-A", "--assignee", "");
			const writes = recordWrites();
			try {
				claims.recordClaim({ actor: "arch-A", beadIds: [id] });
				expect(await gate(ctx(root, "architect"))).toBeUndefined();
			} finally {
				writes.restore();
			}
			expect(writes.issued).toEqual([]);

			const after = await shown(id);
			expect(after.metadata?.pushed_sha).toBeUndefined();
			expect(after.assignee ?? "").toBe("");
			expect(after.status).toBe("blocked");
		}, YIELD_MS);
	});

	describe("a reviewer's verdict on the wisp's parent", () => {
		test("the documented review wisp passes on the node's REVIEW and is refused without it", async () => {
			const node = await create("node under review", "--labels", "orc-node", "--metadata", JSON.stringify({ role: "implementer", execution_kind: "git", head_sha: HEAD }));
			// The shape lifecycle.md documents and the architect ran: a child wisp, no other edge.
			const wisp = await create(`Review ${node}`, "--parent", node, "--ephemeral", "-t", "task", "-p", "1", "--labels", "orc-node",
				"--metadata", JSON.stringify({ role: "reviewer", head_sha: HEAD, review_round: 1, origin_bead: node }));
			// The refusal the release re-test observed: the edge G4 used to read cannot be added.
			const related = await bd("dep", "add", wisp, node, "--type", "relates-to");
			expect(related.code).toBe(1);
			expect(related.stderr).toContain("already a child");
			await write("update", wisp, "--actor", "rev-A", "--claim");
			claims.recordClaim({ actor: "rev-A", beadIds: [wisp] });

			const refused = await gate(ctx(root, "reviewer"));
			expect(refused?.block).toBe(true);
			const verdict: { failed_checks: { check: string; detail: string }[] } = JSON.parse(refused!.reason!);
			expect(verdict.failed_checks).toEqual([{ check: "verdict", detail: "unsatisfied: linked.comment.verb in [REVIEW, BLOCKED]" }]);

			// The reviewer's exit as its definition spells it: the verdict on the node at this
			// head and round, then the wisp closed and released.
			await write("comments", "add", node, `REVIEW ${node} dimension=behavior verdict=approve head_sha=${HEAD} review_round=1`, "--actor", "rev-A");
			await write("close", wisp, "--actor", "rev-A", "--reason", "approved");
			await write("update", wisp, "--actor", "rev-A", "--assignee", "");

			expect(await gate(ctx(root, "reviewer"))).toBeUndefined();
		}, YIELD_MS);
	});

	describe("a reviewer that closes its wisp stays bound to its verdict", () => {
		/**
		 * The final release run's sequence (omp-orchestrate-cdo), step for step: a REVIEW
		 * written as `head <sha>`, the yield refused, the wisp closed, its comments read, one
		 * unrelated command, then two more yields. Before the fix the unrelated command
		 * forgot the claim, the second yield drew the never-claimed reminder, and the third
		 * was accepted with the verdict never judged.
		 */
		test("close, read and unrelated work keep the claim; the yield is refused until the stamped REVIEW lands", async () => {
			const node = await create("node under review", "--labels", "orc-node", "--metadata", JSON.stringify({ role: "implementer", execution_kind: "git", head_sha: HEAD }));
			const wisp = await reviewWisp(node);
			await write("update", wisp, "--actor", "rev-A", "--claim");
			claims.recordClaim({ actor: "rev-A", beadIds: [wisp] });

			const unstamped = `REVIEW ${node} dimension=behavior,evidence,scope verdict=approve -- see ${wisp}. head ${HEAD} vs base ${BASE}`;
			await write("comments", "add", wisp, unstamped, "--actor", "rev-A");
			await write("comments", "add", node, unstamped, "--actor", "rev-A");
			const first = await gate(ctx(root, "reviewer"));
			expect(checks(first)).toEqual([{
				check: "verdict",
				detail: `unsatisfied: linked.comment.verb in [REVIEW, BLOCKED] -- REVIEW on ${node} lacks head_sha=${HEAD} and lacks review_round=1; the expected values are the claimed bead's metadata, else the node's`,
			}]);
			expect(JSON.parse(first!.reason!).attempt).toBe(1);

			expect(await shell(`bd close ${wisp} --reason approve`)).toBeUndefined();
			await write("close", wisp, "--actor", "rev-A", "--reason", "approve");
			expect((await shown(wisp)).assignee).toBe("rev-A");
			expect(await shell(`bd comments ${wisp}`)).toBeUndefined();
			expect(await shell("echo hello")).toBeUndefined();
			expect(claims.observedClaim()?.beadIds).toEqual([wisp]);

			const second = await gate(ctx(root, "reviewer"));
			expect(second?.reason).not.toContain("without ever claiming");
			expect(checks(second).map(failure => failure.check)).toEqual(["verdict"]);
			expect(JSON.parse(second!.reason!).attempt).toBe(2);

			await write("comments", "add", node, `REVIEW ${node} dimension=behavior verdict=approve head_sha=${HEAD} review_round=1`, "--actor", "rev-A");
			expect(await gate(ctx(root, "reviewer"))).toBeUndefined();
			// Accepted on evidence, not let out by the budget: no NOTE landed and nothing warned.
			expect((await commentsOn(wisp)).some(text => text.startsWith("NOTE exit allowed"))).toBe(false);
			expect(warned).toEqual([]);
		}, 2 * YIELD_MS);

		test("a release without the verdict is still refused: the wisp's evidence is owed on the node", async () => {
			const node = await create("node under review", "--labels", "orc-node", "--metadata", JSON.stringify({ role: "implementer", execution_kind: "git", head_sha: HEAD }));
			const wisp = await reviewWisp(node);
			await write("update", wisp, "--actor", "rev-A", "--claim");
			claims.recordClaim({ actor: "rev-A", beadIds: [wisp] });

			expect(await shell(`bd update ${wisp} --assignee ""`)).toBeUndefined();
			await write("update", wisp, "--actor", "rev-A", "--assignee", "");
			// The release is observed on the next product call and ends G2's claim, not G4's.
			expect(await shell("echo hello")).toBeUndefined();
			expect(claims.observedClaim()).toBeUndefined();

			expect(checks(await gate(ctx(root, "reviewer"))).map(failure => failure.check)).toEqual(["verdict"]);
		}, YIELD_MS);

		test("the third refusal lets the exit out, accepts nothing, and leaves a NOTE on the held wisp", async () => {
			const node = await create("node under review", "--labels", "orc-node", "--metadata", JSON.stringify({ role: "implementer", execution_kind: "git", head_sha: HEAD }));
			const wisp = await reviewWisp(node);
			await write("update", wisp, "--actor", "rev-A", "--claim");
			claims.recordClaim({ actor: "rev-A", beadIds: [wisp] });

			expect(JSON.parse((await gate(ctx(root, "reviewer")))!.reason!).attempt).toBe(1);
			expect(JSON.parse((await gate(ctx(root, "reviewer")))!.reason!).attempt).toBe(2);
			expect(await gate(ctx(root, "reviewer"))).toBeUndefined();

			const after = await shown(wisp);
			expect(after.status).toBe("in_progress");
			expect(after.assignee).toBe("rev-A");
			const notes = (await commentsOn(wisp)).filter(text => text.startsWith("NOTE exit allowed unaccepted after 3 refusals; claim retained; "));
			expect(notes).toHaveLength(1);
			expect(notes[0]).toContain("verdict: unsatisfied: linked.comment.verb in [REVIEW, BLOCKED]");
			expect(warned.some(entry => entry.bead === wisp && entry.attempts === 3)).toBe(true);
		}, YIELD_MS);
	});

	describe("the REVIEW shape the reviewer definition spells", () => {
		test("written as documented, with the wisp's metadata values, it is accepted at the first yield", async () => {
			const definition = await fs.readFile(path.join(import.meta.dir, "..", "agents", "orc-reviewer.md"), "utf8");
			const shape = /^\s+(REVIEW <node-id> dimension=<dimension> verdict=approve\|changes head_sha=<sha> review_round=<n>)$/m.exec(definition)?.[1];
			expect(shape, "agents/orc-reviewer.md step 3 spells the REVIEW line").toBeDefined();

			const node = await create("node under review", "--labels", "orc-node", "--metadata", JSON.stringify({ role: "implementer", execution_kind: "git", head_sha: HEAD }));
			const wisp = await reviewWisp(node);
			await write("update", wisp, "--actor", "rev-A", "--claim");
			claims.recordClaim({ actor: "rev-A", beadIds: [wisp] });
			const stamped = (await shown(wisp)).metadata!;
			const review = shape!
				.replace("<node-id>", node)
				.replace("<dimension>", "behavior")
				.replace("approve|changes", "approve")
				.replace("<sha>", String(stamped.head_sha))
				.replace("<n>", String(stamped.review_round));
			await write("comments", "add", node, review, "--actor", "rev-A");
			await write("close", wisp, "--actor", "rev-A", "--reason", "approved");

			expect(await gate(ctx(root, "reviewer"))).toBeUndefined();
			expect((await commentsOn(wisp)).some(text => text.startsWith("NOTE exit allowed"))).toBe(false);
			expect(warned).toEqual([]);
		}, YIELD_MS);
	});
});
