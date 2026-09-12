/**
 * The dormancy matrix: what the installed plugin does in a repository no run has marked,
 * driven through the real extension factory, and what arms once a marker exists.
 *
 * Measured before `runScope`: a plain session in a repository with no `.beads/` was
 * refused `git worktree add`, had its hand claim observed and then every edit judged,
 * spawned `omp config list` on each `task`, ran `bd list` once a minute per silent
 * subagent, and gained an `.orchestration/audit/` it never asked for. Every row here
 * dispatches one of those paths and asserts the whole surface stays inert: no process,
 * no file, no message, no refusal. The second half repeats the rows with a marker and
 * asserts the same paths fire, so a guard that goes dormant for good fails here too.
 */

import { afterEach, beforeEach, describe, expect, type Mock, setSystemTime, spyOn, test } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext, ToolCallEventResult } from "@oh-my-pi/pi-coding-agent";
import { withOmpExtensionRootScope } from "@oh-my-pi/pi-coding-agent/discovery/omp-extension-roots";
import { BD_NOTICE_MESSAGE } from "../src/gates/bd";
import ompOrchestrate from "../src/index";
import { resetRunScopes, runScope } from "../src/run-scope";
import { markerPath } from "../src/run-state";
import { resetWatchers } from "../src/watchers";

const MINUTE = 60_000;

type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => Promise<unknown>;

interface Sent {
	customType?: string;
	content?: string;
}

/** The registered surface of one `ompOrchestrate(pi)`, and every side channel it can use. */
interface Rig {
	pi: ExtensionAPI;
	/** Dispatch one extension event to every handler registered for it. */
	fire(event: string, payload: Record<string, unknown>, ctx: ExtensionContext): Promise<unknown[]>;
	/** Publish on a bus channel and settle every subscriber. */
	emit(channel: string, data: unknown): Promise<void>;
	/** Callbacks handed to `ctx.setInterval`, run by hand. */
	sweeps: Array<() => unknown>;
	sent: Sent[];
	errors: string[];
	commands: string[];
}

function rig(tools: string[]): Rig {
	const handlers = new Map<string, Handler[]>();
	const listeners = new Map<string, Array<(data: unknown) => unknown>>();
	const sweeps: Array<() => unknown> = [];
	const sent: Sent[] = [];
	const errors: string[] = [];
	const commands: string[] = [];
	const zodStub: unknown = new Proxy(() => zodStub, { get: () => zodStub, apply: () => zodStub });
	const pi = {
		setLabel: () => {},
		on: (event: string, handler: Handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		events: {
			on: (channel: string, handler: (data: unknown) => unknown) => {
				const list = listeners.get(channel) ?? [];
				list.push(handler);
				listeners.set(channel, list);
				return () => {
					const index = list.indexOf(handler);
					if (index !== -1) list.splice(index, 1);
				};
			},
		},
		registerCommand: (name: string) => {
			commands.push(name);
		},
		registerTool: () => {},
		zod: zodStub,
		getAllTools: () => tools.map(name => ({ name, description: "" })),
		logger: { error: (message: string) => errors.push(message), warn: () => {}, info: () => {}, debug: () => {} },
		sendMessage: (message: Sent) => sent.push({ customType: message.customType, content: message.content }),
	};
	return {
		pi: pi as unknown as ExtensionAPI,
		fire: async (event, payload, ctx) => {
			const results: unknown[] = [];
			for (const handler of handlers.get(event) ?? []) results.push(await handler({ type: event, ...payload }, ctx));
			return results;
		},
		emit: async (channel, data) => {
			for (const listener of listeners.get(channel) ?? []) await listener(data);
		},
		sweeps,
		sent,
		errors,
		commands,
	};
}

/** A session context at `cwd`, declaring `role` when one is given, with the timer seam the watchers need. */
function ctxAt(cwd: string, sweeps: Array<() => unknown>, role?: string): ExtensionContext {
	return {
		cwd,
		getSystemPrompt: () => [role === undefined ? "a plain brief" : `ORC-ROLE: ${role}`],
		sessionManager: { getSessionId: () => "matrix-session", getEntries: () => [] },
		hasTool: () => false,
		setInterval: (callback: () => unknown) => {
			sweeps.push(callback);
			return callback;
		},
		setTimeout: (callback: () => unknown) => callback,
		clearTimer: () => {},
	} as unknown as ExtensionContext;
}

/** Every path beneath `root`, sorted, so "no file was created" is one comparison. */
async function listing(root: string): Promise<string[]> {
	const entries = await fs.readdir(root, { recursive: true });
	return entries.map(String).sort();
}

/** A `bd` that records nothing and answers every list with an empty array: enough to count spawns. */
async function fakeBd(root: string): Promise<void> {
	const bin = path.join(root, "fake-bd");
	await fs.writeFile(bin, `#!${process.execPath}\nconsole.log("[]");\n`, { mode: 0o755 });
	process.env.BD_BIN = bin;
}

/** How `runScope` asks git for a cwd's primary checkout, reduced to its verb. */
const GIT_QUERY = "git rev-parse --git-common-dir";

/**
 * Every process the plugin started, as the binary's basename plus its subcommand words with
 * `-C <cwd>` dropped. `Bun.spawn` takes argv directly (bd) or as `{ cmd }` (node's execFile).
 */
function spawned(): string[] {
	return spawn.mock.calls.map(call => {
		const first: unknown = call[0];
		const words = Array.isArray(first) ? first : first !== null && typeof first === "object" && "cmd" in first && Array.isArray(first.cmd) ? first.cmd : [];
		const argv = words.map(String).filter((word, index, all) => word !== "-C" && all[index - 1] !== "-C");
		return `${path.basename(argv[0] ?? "")} ${argv.slice(1).join(" ")}`.trim();
	});
}

const CLAIM_REPORT = {
	toolName: "bash",
	toolCallId: "claim-1",
	isError: false,
	input: { command: "bd update orc-1 --claim --json" },
	details: {},
	content: [{ type: "text", text: JSON.stringify([{ id: "orc-1", status: "in_progress", assignee: "me" }]) }],
};

/** The child-lifecycle pair a `bash` call emits on the bus, as the executor spells it. */
function bashEvents(child: string, command: string): unknown[] {
	return [
		{ id: child, event: { type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command } } },
		{ id: child, event: { type: "tool_execution_end", toolCallId: "call-1", toolName: "bash", result: {}, isError: false } },
	];
}

let sandbox: string;
/** A repository with one file, no `.beads/`, no marker: the plain user's checkout. */
let repo: string;
let priorBdBin: string | undefined;
let priorWorktreeDir: string | undefined;
let spawn: Mock<typeof Bun.spawn>;

beforeEach(async () => {
	sandbox = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "orc-run-scope-")));
	repo = path.join(sandbox, "repo");
	await fs.mkdir(path.join(repo, "src"), { recursive: true });
	await fs.writeFile(path.join(repo, "src", "main.ts"), "export {};\n");
	priorBdBin = process.env.BD_BIN;
	priorWorktreeDir = process.env.OMP_WORKTREE_DIR;
	process.env.OMP_WORKTREE_DIR = path.join(sandbox, "isolation-base");
	delete process.env.ORCHESTRATE_MARKER_FILE;
	await fakeBd(sandbox);
	resetRunScopes();
	resetWatchers();
	spawn = spyOn(Bun, "spawn");
});

afterEach(async () => {
	spawn.mockRestore();
	setSystemTime();
	resetWatchers();
	if (priorBdBin === undefined) delete process.env.BD_BIN;
	else process.env.BD_BIN = priorBdBin;
	if (priorWorktreeDir === undefined) delete process.env.OMP_WORKTREE_DIR;
	else process.env.OMP_WORKTREE_DIR = priorWorktreeDir;
	await fs.rm(sandbox, { recursive: true, force: true });
});

async function mark(cwd: string, body: Record<string, unknown> = { schema_version: 1, run_id: "orc-run" }): Promise<void> {
	await fs.mkdir(path.dirname(markerPath(cwd)), { recursive: true });
	await fs.writeFile(markerPath(cwd), JSON.stringify(body));
}

/**
 * Every gated path once, from the seat that used to trip it. Returns the handler results
 * so the caller can assert silence or refusals.
 */
async function driveMatrix(lead: Rig, worker: Rig, role: Rig): Promise<Record<string, unknown[]>> {
	const leadCtx = ctxAt(repo, lead.sweeps);
	const workerCtx = ctxAt(repo, worker.sweeps);
	const roleCtx = ctxAt(repo, role.sweeps, "implementer");
	const results: Record<string, unknown[]> = {};

	results.leadStart = await lead.fire("session_start", {}, leadCtx);
	results.workerStart = await worker.fire("session_start", {}, workerCtx);
	results.roleStart = await role.fire("session_start", {}, roleCtx);

	results.worktree = await lead.fire("tool_call", { toolName: "bash", toolCallId: "wt", input: { command: "git worktree add ../scratch" } }, leadCtx);
	results.leadClaim = await lead.fire("tool_call", { toolName: "bash", toolCallId: "lc", input: { command: "bd update orc-1 --claim --json" } }, leadCtx);
	results.nestedOmp = await lead.fire("tool_call", { toolName: "bash", toolCallId: "omp", input: { command: 'omp -p "summarise this file"' } }, leadCtx);
	results.sync = await role.fire("tool_call", { toolName: "bash", toolCallId: "sync", input: { command: "bd dolt pull" } }, roleCtx);
	results.sandboxEscape = await worker.fire("tool_call", { toolName: "bash", toolCallId: "esc", input: { command: "BD_READONLY=0 bd update orc-1 --status closed" } }, workerCtx);
	results.helperShell = await worker.fire("tool_call", { toolName: "bash", toolCallId: "sh", input: { command: "echo ok" } }, workerCtx);
	results.spawn = await lead.fire("tool_call", { toolName: "task", toolCallId: "task", input: { name: "Impl", agent: "orc-implementer", task: "epic orc-1" } }, leadCtx);

	// A hand claim from a plain subagent, then the writes and the exit that used to be judged by it.
	await worker.fire("tool_result", CLAIM_REPORT, workerCtx);
	results.edit = await worker.fire("tool_call", { toolName: "edit", toolCallId: "edit", input: { path: path.join(sandbox, "elsewhere.ts"), edits: [] } }, workerCtx);
	results.write = await worker.fire("tool_call", { toolName: "write", toolCallId: "write", input: { path: path.join(sandbox, "elsewhere.ts"), content: "x" } }, workerCtx);
	results.yield = await worker.fire("tool_call", { toolName: "yield", toolCallId: "yield", input: { result: { data: "done" } } }, workerCtx);
	results.roleYield = await role.fire("tool_call", { toolName: "yield", toolCallId: "yield-role", input: { result: { data: "done" } } }, roleCtx);
	results.agentEnd = await lead.fire("agent_end", { willContinue: false, messages: [{ role: "assistant", content: "done" }] }, leadCtx);

	// The bus: a child's bd mutation for W2, and twenty silent minutes for W1's sweep.
	for (const event of bashEvents("kid-1", "bd update orc-7 --status open")) await lead.emit("task:subagent:event", event);
	setSystemTime(new Date("2026-09-12T10:00:00.000Z"));
	await lead.emit("task:subagent:progress", { progress: { id: "kid-1", status: "running", tokens: 10, recentOutput: ["working"] } });
	setSystemTime(new Date("2026-09-12T10:20:00.000Z"));
	for (const sweep of lead.sweeps) await sweep();

	return results;
}

function boot(): { lead: Rig; worker: Rig; role: Rig } {
	const lead = rig(["bash", "edit", "write", "task", "read"]);
	const worker = rig(["bash", "edit", "write", "read", "yield"]);
	const role = rig(["bash", "edit", "write", "read", "yield"]);
	withOmpExtensionRootScope([repo], "explicit-only", () => {
		ompOrchestrate(lead.pi);
		ompOrchestrate(worker.pi);
		ompOrchestrate(role.pi);
	});
	return { lead, worker, role };
}

describe("outside a run scope the plugin is inert", () => {
	test("no process, no file, no message, no refusal, from every seat", async () => {
		const before = await listing(sandbox);
		const { lead, worker, role } = boot();

		const results = await driveMatrix(lead, worker, role);

		for (const [row, outcomes] of Object.entries(results)) {
			expect(outcomes.every(outcome => outcome === undefined), row).toBe(true);
		}
		// The one process a dormant session may start: git, asked once per cwd whether the
		// cwd is a linked worktree of a marked primary. Nothing else: no bd, no omp.
		expect(spawned()).toEqual([GIT_QUERY]);
		expect([...lead.sent, ...worker.sent, ...role.sent]).toEqual([]);
		expect([...lead.errors, ...worker.errors, ...role.errors]).toEqual([]);
		expect(await listing(sandbox)).toEqual(before);
		// The only surface left: the slash commands, registered whatever the checkout holds.
		expect(lead.commands.sort()).toEqual(
			["orchestrate-bind", "orchestrate-close", "orchestrate-roster", "orchestrate-run", "orchestrate-status", "orchestrate-stop"].sort(),
		);
	});

	test("a malformed marker is no scope either", async () => {
		await fs.mkdir(path.dirname(markerPath(repo)), { recursive: true });
		await fs.writeFile(markerPath(repo), "{broken");
		const before = await listing(sandbox);
		const { lead, worker, role } = boot();

		const results = await driveMatrix(lead, worker, role);

		for (const [row, outcomes] of Object.entries(results)) {
			expect(outcomes.every(outcome => outcome === undefined), row).toBe(true);
		}
		expect(spawned()).toEqual([GIT_QUERY]);
		expect([...lead.sent, ...worker.sent, ...role.sent]).toEqual([]);
		expect(await listing(sandbox)).toEqual(before);
	});
});

describe("inside a run scope the same paths arm", () => {
	test("the marker alone switches every gate and watcher on", async () => {
		await mark(repo);
		const { lead, worker, role } = boot();

		const results = await driveMatrix(lead, worker, role);
		const refusal = (row: string): ToolCallEventResult | undefined =>
			(results[row] ?? []).find((outcome): outcome is ToolCallEventResult => outcome !== undefined && outcome !== null && typeof outcome === "object" && "block" in outcome);
		const revision = (row: string): ToolCallEventResult | undefined =>
			(results[row] ?? []).find((outcome): outcome is ToolCallEventResult => outcome !== undefined && outcome !== null && typeof outcome === "object" && "input" in outcome);

		// G3, G5's lead rule, the spawn gate, G6's sync refusal, G1's sandbox and G4's unclaimed exit.
		expect(refusal("worktree")?.reason).toContain("wt switch");
		expect(refusal("leadClaim")?.reason).toContain("the lead never claims");
		expect(refusal("spawn")?.reason).toContain("isolated: true");
		expect(refusal("sync")?.reason).toContain("sync is the lead's barrier step");
		expect(refusal("sandboxEscape")?.reason).toContain("BD_READONLY=1 is the read-only sandbox");
		expect(revision("helperShell")?.input).toEqual({ command: "echo ok", env: { BD_READONLY: "1" } });
		expect(refusal("roleYield")?.reason).toContain("without ever claiming a bead");
		// G6's nested-omp notice, and the protocol for the contract-bound worker only.
		expect(lead.sent.some(message => message.customType === BD_NOTICE_MESSAGE && message.content?.includes("WARN nested omp: 'omp -p'"))).toBe(true);
		expect(role.sent.some(message => message.customType === "com.srobroek.omp-orchestrate.contract")).toBe(true);
		expect(worker.sent.some(message => message.customType === "com.srobroek.omp-orchestrate.contract")).toBe(false);
		// W2's ledger and W1's sweep, the two watchers that used to run in every repository.
		const ledger = await fs.readFile(path.join(repo, ".orchestration", "audit", "kid-1.bdlog"), "utf8");
		expect(JSON.parse(ledger.trim()).argv).toBe("bd update orc-7 --status open");
		expect(spawn.mock.calls.map(call => (call[0] as string[]).slice(1, 2)[0])).toContain("list");
		expect([...lead.errors, ...worker.errors, ...role.errors]).toEqual([]);
	});

	test("a plain subagent's hand claim inside the scope is not judged generic at exit without a role", async () => {
		// The claim is observed (the scope exists), and the exit gate reads the bead through
		// the fake bd, which answers nothing: an unreadable bead is left unjudged, and the
		// worker leaves. The refusal path for a role-less claim is G2's ownership check, not G4.
		await mark(repo);
		const { worker } = boot();
		const ctx = ctxAt(repo, worker.sweeps);

		await worker.fire("tool_result", CLAIM_REPORT, ctx);
		const outcome = await worker.fire("tool_call", { toolName: "yield", toolCallId: "y", input: { result: { data: "done" } } }, ctx);

		expect(outcome).toEqual([undefined]);
	});
});

describe("runScope", () => {
	test("answers null with no cwd, no marker, or a marker it cannot trust", async () => {
		expect(await runScope({ cwd: "" })).toBeNull();
		expect(await runScope({ cwd: repo })).toBeNull();
		expect(await runScope({ cwd: path.join(repo, "no-such-dir") })).toBeNull();
		await fs.mkdir(path.dirname(markerPath(repo)), { recursive: true });
		await fs.writeFile(markerPath(repo), "{broken");
		expect(await runScope({ cwd: repo })).toBeNull();
		await fs.writeFile(markerPath(repo), JSON.stringify({ schema_version: 2, run_id: "orc-run" }));
		expect(await runScope({ cwd: repo })).toBeNull();
	});

	test("reads the marker once while it is unchanged, and again when it is rewritten or removed", async () => {
		await mark(repo, { schema_version: 1, run_id: "pending" });
		const reads = spyOn(fs, "readFile");
		try {
			const first = await runScope({ cwd: repo });
			const second = await runScope({ cwd: repo });
			expect(first).toEqual({ runId: "pending", markerPath: markerPath(repo), beadsDir: undefined, root: repo });
			expect(second).toBe(first);
			expect(reads).toHaveBeenCalledTimes(1);

			// A bind rewrites the marker in place: same path, new content.
			await mark(repo, { schema_version: 1, run_id: "orc-run", beads_dir: path.join(repo, ".beads") });
			expect((await runScope({ cwd: repo }))?.runId).toBe("orc-run");
			expect(reads).toHaveBeenCalledTimes(2);

			await fs.rm(markerPath(repo));
			expect(await runScope({ cwd: repo })).toBeNull();
		} finally {
			reads.mockRestore();
		}
	});

	describe("a linked worktree reaches the primary's marker through git", () => {
		const git = promisify(execFile);
		let primary: string;
		let linked: string;

		/** A real repository with one commit and one linked worktree; `.orchestration/` is gitignored, as in this repository. */
		beforeEach(async () => {
			primary = path.join(sandbox, "primary");
			linked = path.join(sandbox, "linked");
			await fs.mkdir(primary);
			const run = (args: string[], cwd = primary) => git("git", ["-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, timeout: 5000 });
			await run(["init", "-q", "-b", "main"]);
			await fs.writeFile(path.join(primary, ".gitignore"), ".orchestration/\n");
			await run(["add", ".gitignore"]);
			await run(["commit", "-q", "-m", "init"]);
			await run(["worktree", "add", "-q", "-b", "feature", linked]);
			// The fixture's own git calls are not the plugin's.
			spawn.mockClear();
		});

		test("the primary's marker is the worktree's scope, with the primary as root", async () => {
			await mark(primary, { schema_version: 1, run_id: "orc-run", beads_dir: path.join(primary, ".beads") });

			const scope = await runScope({ cwd: linked });

			expect(scope).toEqual({ runId: "orc-run", markerPath: markerPath(primary), beadsDir: path.join(primary, ".beads"), root: primary });
			// A subdirectory of the primary resolves to the same run.
			await fs.mkdir(path.join(primary, "src"));
			expect((await runScope({ cwd: path.join(primary, "src") }))?.root).toBe(primary);
		});

		test("a worktree of a repository with no marker stays dormant, through the real factory", async () => {
			const before = await listing(sandbox);
			const lead = rig(["bash", "edit", "write", "task", "read"]);
			withOmpExtensionRootScope([linked], "explicit-only", () => ompOrchestrate(lead.pi));
			const ctx = ctxAt(linked, lead.sweeps);

			await lead.fire("session_start", {}, ctx);
			const worktree = await lead.fire("tool_call", { toolName: "bash", toolCallId: "wt", input: { command: "git worktree add ../scratch" } }, ctx);
			const spawnTask = await lead.fire("tool_call", { toolName: "task", toolCallId: "t", input: { name: "Impl", agent: "orc-implementer", task: "epic orc-1" } }, ctx);

			expect([...worktree, ...spawnTask].every(outcome => outcome === undefined)).toBe(true);
			expect(spawned()).toEqual([GIT_QUERY]);
			expect(lead.sent).toEqual([]);
			expect(await listing(sandbox)).toEqual(before);
			expect(await runScope({ cwd: linked })).toBeNull();
		});

		test("marking the primary arms the worktree's gates without a restart", async () => {
			const lead = rig(["bash", "edit", "write", "task", "read"]);
			withOmpExtensionRootScope([linked], "explicit-only", () => ompOrchestrate(lead.pi));
			const ctx = ctxAt(linked, lead.sweeps);
			expect(await lead.fire("tool_call", { toolName: "bash", toolCallId: "wt-1", input: { command: "git worktree add ../scratch" } }, ctx)).toEqual([undefined, undefined]);

			await mark(primary);
			const refused = await lead.fire("tool_call", { toolName: "bash", toolCallId: "wt-2", input: { command: "git worktree add ../scratch" } }, ctx);

			expect(refused.some(outcome => outcome !== null && typeof outcome === "object" && "block" in outcome)).toBe(true);
		});
	});

	test("an isolated copy answers the primary it was cloned from as root", async () => {
		const primary = path.join(sandbox, "primary");
		const copy = path.join(process.env.OMP_WORKTREE_DIR as string, "copy");
		await fs.mkdir(path.join(primary, ".beads"), { recursive: true });
		await mark(copy, { schema_version: 1, run_id: "orc-run", beads_dir: path.join(primary, ".beads") });
		// A lead in a linked worktree also records a `.beads` elsewhere; it is not a copy.
		await mark(repo, { schema_version: 1, run_id: "orc-run", beads_dir: path.join(primary, ".beads") });

		expect((await runScope({ cwd: copy }))?.root).toBe(primary);
		expect((await runScope({ cwd: repo }))?.root).toBe(repo);
	});
});
