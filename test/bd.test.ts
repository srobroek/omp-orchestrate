import { afterEach, describe, expect, spyOn, test } from "bun:test";
import os from "node:os";
import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { BdBead } from "../src/bd";
import {
	bdBlockedChecked,
	bdLinkedChecked,
	bdListChecked,
	bdRun,
	bdShow,
	bdShowMany,
	commentVerb,
	lastBdFailure,
	metadataString,
	readBudgetExhausted,
	resetReadBudget,
	storeToken,
} from "../src/bd";
import { createClaimState } from "../src/claim-state";
import { createExitGuard } from "../src/gates/exit";
import { gateWorktreeScope } from "../src/gates/worktree";

describe("bdRun never throws", () => {
	// The whole reason this wrapper exists: a throw inside a tool_call handler
	// blocks the tool being inspected (wrapper.ts:237), so a missing binary must
	// degrade to "unknown", never to an exception.
	test("resolves null when the binary does not exist", async () => {
		const previous = process.env.BD_BIN;
		process.env.BD_BIN = "definitely-not-a-real-binary-xyz";
		try {
			expect(await bdRun(["show", "x", "--json"])).toBeNull();
		} finally {
			if (previous === undefined) delete process.env.BD_BIN;
			else process.env.BD_BIN = previous;
		}
	});

	test("captures a non-zero exit rather than throwing", async () => {
		const previous = process.env.BD_BIN;
		process.env.BD_BIN = "false";
		try {
			const result = await bdRun([]);
			expect(result).not.toBeNull();
			expect(result?.code).not.toBe(0);
		} finally {
			if (previous === undefined) delete process.env.BD_BIN;
			else process.env.BD_BIN = previous;
		}
	});
});

describe("read budget", () => {
	test("overlapping operations retain independent read counts across resets", async () => {
		const previous = process.env.BD_BIN;
		process.env.BD_BIN = "echo";
		const paused = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		try {
			const first = (async () => {
				resetReadBudget();
				for (let i = 0; i < 12; i++) expect(await bdListChecked(["[]"])).toEqual([]);
				paused.resolve();
				await resume.promise;
				expect(await bdListChecked(["[]"])).toBeNull();
			})();
			await paused.promise;
			resetReadBudget();
			expect(await bdListChecked(["[]"])).toEqual([]);
			resume.resolve();
			await first;
			for (let i = 1; i < 12; i++) expect(await bdListChecked(["[]"])).toEqual([]);
			expect(await bdListChecked(["[]"])).toBeNull();
		} finally {
			resume.resolve();
			if (previous === undefined) delete process.env.BD_BIN;
			else process.env.BD_BIN = previous;
		}
	});

	test("successful calls share an absolute deadline and expiry prevents mutations", async () => {
		let now = 0;
		const clock = spyOn(performance, "now").mockImplementation(() => now);
		const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
			now += 8_000;
			return {
				stdout: new Response("[]").body,
				stderr: new Response("").body,
				exited: Promise.resolve(0),
				kill: () => { },
			} as unknown as Bun.Subprocess;
		});
		try {
			resetReadBudget();
			expect(await bdListChecked(["list", "--json"])).toEqual([]);
			expect(await bdListChecked(["list", "--json"])).toEqual([]);
			expect(await bdListChecked(["list", "--json"])).toBeNull();
			expect(await bdRun(["update", "bd-task", "--status", "open"])).toBeNull();
			expect(spawn).toHaveBeenCalledTimes(3);
			resetReadBudget();
			expect(await bdListChecked(["list", "--json"])).toEqual([]);
		} finally {
			spawn.mockRestore();
			clock.mockRestore();
			resetReadBudget();
		}
	});

	test("a process is killed at the remaining deadline rather than a fresh timeout", async () => {
		let now = 0;
		const clock = spyOn(performance, "now").mockImplementation(() => now);
		let scheduled: (() => void) | undefined;
		let delay: number | undefined;
		const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, ms: number) => {
			scheduled = callback;
			delay = ms;
			return 0;
		}) as unknown as typeof setTimeout);
		const exited = Promise.withResolvers<number>();
		let killed = false;
		const spawn = spyOn(Bun, "spawn").mockImplementation(() => ({
			stdout: new Response("").body,
			stderr: new Response("").body,
			exited: exited.promise,
			kill: () => { killed = true; exited.resolve(143); },
		}) as unknown as Bun.Subprocess);
		try {
			resetReadBudget();
			now = 19_900;
			const pending = bdRun(["list", "--json"]);
			expect(delay).toBe(100);
			scheduled?.();
			expect(await pending).toBeNull();
			expect(killed).toBe(true);
		} finally {
			exited.resolve(0);
			spawn.mockRestore();
			timer.mockRestore();
			clock.mockRestore();
			resetReadBudget();
		}
	});
});

/**
 * A `bd` that answers from an in-memory store, standing in for `Bun.spawn`.
 *
 * Argv is the contract: `show`, `comments`, `dep list`, `list --label` and `list --id`
 * are answered from `store`; anything else exits 1. `spawned` records each argv's first
 * two words, so a test can assert what a dispatch cost and not only what it decided.
 */
function fakeBd(store: {
	beads: Record<string, BdBead>;
	comments?: Record<string, string[]>;
	linked?: Record<string, string[]>;
	inFlight?: BdBead[];
}): { spawned: string[]; restore: () => void } {
	const spawned: string[] = [];
	const spawn = spyOn(Bun, "spawn").mockImplementation(((argv: string[]) => {
		const args = argv.slice(1);
		spawned.push(args.slice(0, 2).join(" "));
		let payload: unknown;
		if (args[0] === "show") payload = store.beads[args[1]!] === undefined ? undefined : [store.beads[args[1]!]];
		else if (args[0] === "comments") payload = (store.comments?.[args[1]!] ?? []).map(text => ({ text }));
		else if (args[0] === "dep" && args[1] === "list") {
			const down = args.includes("--direction=down");
			payload = (store.linked?.[args[2]!] ?? []).map(linked =>
				down ? { issue_id: args[2], depends_on_id: linked } : { issue_id: linked, depends_on_id: args[2] });
		} else if (args[0] === "list") {
			const idFlag = args.indexOf("--id");
			payload = idFlag === -1
				? store.inFlight ?? []
				: args[idFlag + 1]!.split(",").map(id => store.beads[id]).filter(bead => bead !== undefined);
		}
		return {
			stdout: new Response(payload === undefined ? "" : JSON.stringify(payload)).body,
			stderr: new Response("").body,
			exited: Promise.resolve(payload === undefined ? 1 : 0),
			kill: () => {},
		} as unknown as Bun.Subprocess;
	}) as unknown as typeof Bun.spawn);
	return { spawned, restore: () => spawn.mockRestore() };
}

/** The two files the store token reads, as a version-5 manifest names them. */
const JOURNAL = "vvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv";
function manifestText(lock: string, root: string): string {
	return `5:__DOLT__:${lock}:${root}:00000000000000000000000000000000:${JOURNAL}:1`;
}

interface FakeStore {
	beadsDir: string;
	/** What a `bd` mutation does to the two files: append a journal record, move the manifest root. */
	write: () => Promise<void>;
	setManifest: (lock: string, root: string) => Promise<void>;
	/** A new inode holding fewer bytes, as a journal repair or conjoin leaves. */
	replaceJournal: () => Promise<void>;
	/** Unhooks the marker and removes the store. */
	restore: () => Promise<void>;
}

/**
 * An embedded store on disk as {@link storeToken} reads it, and the active-run marker
 * that names it, so reads in this process cache against it.
 */
async function fakeStore(options: { mode?: string; journal?: boolean; marker?: boolean } = {}): Promise<FakeStore> {
	const root = await mkdtemp(join(os.tmpdir(), "orc-bd-store-"));
	const beadsDir = join(root, ".beads");
	const noms = join(beadsDir, "embeddeddolt", "sbx", ".dolt", "noms");
	await mkdir(noms, { recursive: true });
	await writeFile(join(beadsDir, "metadata.json"), JSON.stringify({ dolt_mode: options.mode ?? "embedded", dolt_database: "sbx" }));
	const journal = join(noms, JOURNAL);
	const manifest = join(noms, "manifest");
	if (options.journal !== false) await writeFile(journal, "root-record-0\n");
	await writeFile(manifest, manifestText("lock0", "root0"));
	const marker = join(root, ".active-run");
	if (options.marker !== false) {
		await writeFile(marker, JSON.stringify({ schema_version: 1, run_id: "orc-run", beads_dir: beadsDir }));
	}
	const priorMarker = process.env.ORCHESTRATE_MARKER_FILE;
	process.env.ORCHESTRATE_MARKER_FILE = marker;
	let writes = 0;
	return {
		beadsDir,
		async write() {
			writes += 1;
			await appendFile(journal, `root-record-${writes}\n`);
			await writeFile(manifest, manifestText(`lock${writes}`, `root${writes}`));
		},
		async setManifest(lock, root) {
			await writeFile(manifest, manifestText(lock, root));
		},
		async replaceJournal() {
			await rm(journal);
			await writeFile(journal, "r\n");
		},
		async restore() {
			if (priorMarker === undefined) delete process.env.ORCHESTRATE_MARKER_FILE;
			else process.env.ORCHESTRATE_MARKER_FILE = priorMarker;
			await rm(root, { recursive: true, force: true });
		},
	};
}

describe("failure kinds", () => {
	afterEach(() => resetReadBudget());

	test("a spent read cap is budget, and marks the dispatch exhausted", async () => {
		const bd = fakeBd({ beads: {} });
		try {
			resetReadBudget();
			for (let read = 0; read < 12; read += 1) expect(await bdListChecked(["list", "--json"])).toEqual([]);
			expect(readBudgetExhausted()).toBe(false);
			expect(await bdListChecked(["list", "--json"])).toBeNull();
			expect(lastBdFailure()).toBe("budget");
			expect(readBudgetExhausted()).toBe(true);
			resetReadBudget();
			expect(readBudgetExhausted()).toBe(false);
			expect(lastBdFailure()).toBeUndefined();
		} finally {
			bd.restore();
		}
	});

	test("a non-zero exit, a missing bead and a malformed payload are told apart", async () => {
		const spawn = spyOn(Bun, "spawn");
		const answer = (stdout: string, code: number) => spawn.mockImplementation((() => ({
			stdout: new Response(stdout).body,
			stderr: new Response("").body,
			exited: Promise.resolve(code),
			kill: () => {},
		}) as unknown as Bun.Subprocess) as unknown as typeof Bun.spawn);
		try {
			resetReadBudget();
			answer("", 1);
			expect(await bdShow("orc-1")).toBeNull();
			expect(lastBdFailure()).toBe("exit");
			answer("[]", 0);
			expect(await bdShow("orc-1")).toBeNull();
			expect(lastBdFailure()).toBe("missing");
			answer("not json", 0);
			expect(await bdListChecked(["list", "--json"])).toBeNull();
			expect(lastBdFailure()).toBe("missing");
			answer(JSON.stringify([{ id: "orc-1" }]), 0);
			expect(await bdShow("orc-1")).toEqual({ id: "orc-1" });
			// A success clears the record: the kind describes the most recent call only.
			expect(lastBdFailure()).toBeUndefined();
		} finally {
			spawn.mockRestore();
		}
	});

	test("a missing binary is unavailable", async () => {
		const previous = process.env.BD_BIN;
		process.env.BD_BIN = "definitely-not-a-real-binary-xyz";
		try {
			resetReadBudget();
			expect(await bdShow("orc-1")).toBeNull();
			expect(lastBdFailure()).toBe("unavailable");
		} finally {
			if (previous === undefined) delete process.env.BD_BIN;
			else process.env.BD_BIN = previous;
		}
	});

	test("a killed call, and every call after it in the dispatch, is timeout", async () => {
		const previous = process.env.BD_BIN;
		process.env.BD_BIN = "sleep";
		try {
			resetReadBudget();
			expect(await bdRun(["30"], 50)).toBeNull();
			expect(lastBdFailure()).toBe("timeout");
			expect(await bdShow("orc-1")).toBeNull();
			expect(lastBdFailure()).toBe("timeout");
			expect(readBudgetExhausted()).toBe(false);
		} finally {
			if (previous === undefined) delete process.env.BD_BIN;
			else process.env.BD_BIN = previous;
		}
	});
});

describe("the store token", () => {
	test("is the journal's inode and size with the manifest's lock and root", async () => {
		const store = await fakeStore();
		try {
			expect(storeToken(store.beadsDir)).toMatch(/^\d+:14\|lock0:root0$/);
		} finally {
			await store.restore();
		}
	});

	test.each([
		["a non-embedded store", { mode: "server" }],
		["a store without a journal", { journal: false }],
	])("is undefined for %s", async (_label, options) => {
		const store = await fakeStore(options);
		try {
			expect(storeToken(store.beadsDir)).toBeUndefined();
		} finally {
			await store.restore();
		}
	});

	test("is undefined where there is no store", async () => {
		expect(storeToken(join(os.tmpdir(), "orc-no-such-store"))).toBeUndefined();
	});
});

/**
 * The cache in `readJson`, driven through the public readers with the subprocess replaced
 * and a store on disk whose token the tests move by hand. Every row here is one of the
 * invariants I1-I7 in `src/bd.ts`'s header.
 */
describe("the read cache", () => {
	afterEach(() => resetReadBudget());
	const beads: Record<string, BdBead> = { "orc-1": { id: "orc-1", status: "open" }, "orc-2": { id: "orc-2", status: "open" }, "orc-w1": { id: "orc-w1", ephemeral: true } };

	test("a read is spawned once per store token, across dispatches", async () => {
		const store = await fakeStore();
		const bd = fakeBd({ beads, inFlight: [beads["orc-2"]] });
		try {
			resetReadBudget();
			expect(await bdShow("orc-1")).toEqual(beads["orc-1"]);
			expect(await bdListChecked(["list", "--label", "orc-node", "--json"])).toEqual([beads["orc-2"]]);
			resetReadBudget();
			expect(await bdShow("orc-1")).toEqual(beads["orc-1"]);
			expect(await bdListChecked(["list", "--label", "orc-node", "--json"])).toEqual([beads["orc-2"]]);
			// A different argv is a different answer.
			await bdListChecked(["list", "--label", "orc-node", "--status", "open", "--json"]);
			expect(bd.spawned).toEqual(["show orc-1", "list --label", "list --label"]);
		} finally {
			bd.restore();
			await store.restore();
		}
	});

	test("a hit spends no read and clears the failure a refused read left", async () => {
		const store = await fakeStore();
		const bd = fakeBd({ beads });
		try {
			resetReadBudget(1);
			await bdShow("orc-1");
			for (let hit = 0; hit < 5; hit += 1) expect(await bdShow("orc-1")).not.toBeNull();
			expect(readBudgetExhausted()).toBe(false);
			expect(await bdShow("orc-2")).toBeNull();
			expect(lastBdFailure()).toBe("budget");
			expect(await bdShow("orc-1")).not.toBeNull();
			expect(lastBdFailure()).toBeUndefined();
			expect(bd.spawned).toEqual(["show orc-1"]);
		} finally {
			bd.restore();
			await store.restore();
		}
	});

	test("this process's own write drops the cache at once, before the store moves", async () => {
		// The fake `bd` writes nothing to the store, so only the drop in `bdRun` can explain
		// the second show (I4).
		const store = await fakeStore();
		const bd = fakeBd({ beads });
		try {
			resetReadBudget();
			await bdShow("orc-1");
			await bdRun(["comment", "orc-1", "NOTE"]);
			await bdShow("orc-1");
			expect(bd.spawned).toEqual(["show orc-1", "comment orc-1", "show orc-1"]);
		} finally {
			bd.restore();
			await store.restore();
		}
	});

	test("identical reads around a create are two reads", async () => {
		// A reader that lists, writes, then lists again to confirm the write must see the
		// write; an argv-keyed cache that survived the create would confirm nothing.
		const store = await fakeStore();
		const bd = fakeBd({ beads, linked: { "orc-1": ["orc-w1"] } });
		try {
			resetReadBudget();
			expect(await bdLinkedChecked("orc-1", "relates-to")).toEqual(["orc-w1"]);
			await bdRun(["create", "patrol", "--ephemeral"]);
			expect(await bdLinkedChecked("orc-1", "relates-to")).toEqual(["orc-w1"]);
			expect(bd.spawned).toEqual(["dep list", "create patrol", "dep list"]);
		} finally {
			bd.restore();
			await store.restore();
		}
	});

	test("a fresh read spawns past a hot entry and stores nothing", async () => {
		// The lease-expiry decision asks for a spawn regardless of the token; the answer
		// it gets must not be what an ordinary read cached, nor become one.
		const store = await fakeStore();
		const bd = fakeBd({ beads });
		try {
			resetReadBudget();
			expect((await bdShow("orc-1"))?.id).toBe("orc-1");
			expect((await bdShow("orc-1"))?.id).toBe("orc-1");
			expect(bd.spawned).toEqual(["show orc-1"]);
			expect((await bdShow("orc-1", undefined, undefined, { fresh: true }))?.id).toBe("orc-1");
			expect(bd.spawned).toEqual(["show orc-1", "show orc-1"]);
			expect((await bdShow("orc-1"))?.id).toBe("orc-1");
			expect(bd.spawned).toEqual(["show orc-1", "show orc-1"]);
		} finally {
			bd.restore();
			await store.restore();
		}
	});

	test.each([
		["a write by another process", (store: FakeStore) => store.write()],
		["a moved manifest root alone", (store: FakeStore) => store.setManifest("lock0", "root-elsewhere")],
		["a replaced, smaller journal", (store: FakeStore) => store.replaceJournal()],
	])("%s invalidates a hot entry", async (_label, move) => {
		const store = await fakeStore();
		const bd = fakeBd({ beads });
		try {
			resetReadBudget();
			await bdShow("orc-1");
			await bdShow("orc-1");
			await move(store);
			resetReadBudget();
			await bdShow("orc-1");
			expect(bd.spawned).toEqual(["show orc-1", "show orc-1"]);
		} finally {
			bd.restore();
			await store.restore();
		}
	});

	test("a bead that does not answer is not cached", async () => {
		const store = await fakeStore();
		const bd = fakeBd({ beads });
		try {
			resetReadBudget();
			expect(await bdShow("ghost")).toBeNull();
			expect(await bdShow("ghost")).toBeNull();
			expect(bd.spawned).toEqual(["show ghost", "show ghost"]);
		} finally {
			bd.restore();
			await store.restore();
		}
	});

	test("a zero exit that says null is missing, and not cached", async () => {
		const store = await fakeStore();
		const spawn = spyOn(Bun, "spawn").mockImplementation((() => ({
			stdout: new Response("null").body,
			stderr: new Response("").body,
			exited: Promise.resolve(0),
			kill: () => {},
		}) as unknown as Bun.Subprocess) as unknown as typeof Bun.spawn);
		try {
			resetReadBudget();
			expect(await bdShow("orc-1")).toBeNull();
			expect(lastBdFailure()).toBe("missing");
			expect(await bdShow("orc-1")).toBeNull();
			expect(spawn).toHaveBeenCalledTimes(2);
		} finally {
			spawn.mockRestore();
			await store.restore();
		}
	});

	test.each([
		["no marker names the store", { marker: false }],
		["the marker names a non-embedded store", { mode: "server" }],
		["the store has no journal", { journal: false }],
	])("nothing is cached while %s", async (_label, options) => {
		const store = await fakeStore(options);
		const bd = fakeBd({ beads });
		try {
			resetReadBudget();
			await bdShow("orc-1");
			await bdShow("orc-1");
			expect(bd.spawned).toEqual(["show orc-1", "show orc-1"]);
		} finally {
			bd.restore();
			await store.restore();
		}
	});

	test("a marker without the store field caches nothing", async () => {
		const store = await fakeStore({ marker: false });
		const bd = fakeBd({ beads });
		try {
			await writeFile(process.env.ORCHESTRATE_MARKER_FILE!, JSON.stringify({ schema_version: 1, run_id: "orc-run" }));
			resetReadBudget();
			await bdShow("orc-1");
			await bdShow("orc-1");
			expect(bd.spawned).toEqual(["show orc-1", "show orc-1"]);
		} finally {
			bd.restore();
			await store.restore();
		}
	});

	test("bdShowMany reads only the ids no read has carried, and feeds later shows", async () => {
		const store = await fakeStore();
		const bd = fakeBd({ beads });
		try {
			resetReadBudget();
			await bdShow("orc-1");
			resetReadBudget();
			const many = await bdShowMany(["orc-1", "orc-2", "orc-w1", "orc-2"]);
			expect([...many!.keys()].sort()).toEqual(["orc-1", "orc-2", "orc-w1"]);
			expect(bd.spawned).toEqual(["show orc-1", "list --id"]);
			resetReadBudget();
			expect(await bdShow("orc-w1")).toEqual(beads["orc-w1"]);
			expect(await bdShow("orc-2")).toEqual(beads["orc-2"]);
			expect(await bdShowMany(["orc-1", "orc-w1"])).toEqual(new Map([["orc-1", beads["orc-1"]], ["orc-w1", beads["orc-w1"]]]));
			expect(bd.spawned).toHaveLength(2);
		} finally {
			bd.restore();
			await store.restore();
		}
	});

	test("bdShowMany leaves an id bd did not return absent, and is null when the read failed", async () => {
		const bd = fakeBd({ beads });
		try {
			resetReadBudget();
			const many = await bdShowMany(["orc-1", "ghost"]);
			expect(many!.has("orc-1")).toBe(true);
			expect(many!.has("ghost")).toBe(false);
			for (let read = 0; read < 12; read += 1) await bdListChecked(["list", "--json"]);
			expect(await bdShowMany(["orc-2"])).toBeNull();
			expect(lastBdFailure()).toBe("budget");
		} finally {
			bd.restore();
		}
	});

	test("the list argv asks for closed beads and wisps without a row cap", async () => {
		const spawn = spyOn(Bun, "spawn").mockImplementation(((argv: string[]) => {
			expect(argv.slice(1)).toEqual(["list", "--id", "a,b", "--status", "all", "--include-infra", "--include-gates", "--limit", "0", "--json"]);
			return {
				stdout: new Response("[]").body,
				stderr: new Response("").body,
				exited: Promise.resolve(0),
				kill: () => {},
			} as unknown as Bun.Subprocess;
		}) as unknown as typeof Bun.spawn);
		try {
			resetReadBudget();
			expect(await bdShowMany(["a", "b"])).toEqual(new Map());
			expect(spawn).toHaveBeenCalledTimes(1);
		} finally {
			spawn.mockRestore();
		}
	});
});

/**
 * What one gated call costs, through the real gates and the real `bd.ts`, with only the
 * subprocess replaced. These pin the read counts the audit measured, so a regression in
 * the cache, the lineage short-circuit, or the linked-wisp batching shows up as spawns.
 */
describe("dispatch read cost", () => {
	afterEach(() => resetReadBudget());

	/** A task under a feature under an epic, with N in-flight sibling tasks. */
	function run(siblings: number, siblingScope: (index: number) => string[] | undefined): Record<string, BdBead> {
		const beads: Record<string, BdBead> = {
			"orc-task-1": { id: "orc-task-1", status: "in_progress", assignee: "orc-impl-1", parent: "orc-feat-1", labels: ["orc-node"], metadata: { role: "implementer", scope: ["src/mod1/**"] } },
			"orc-feat-1": { id: "orc-feat-1", status: "in_progress", assignee: "orc-arch-1", parent: "orc-epic-1", labels: ["orc-node"], metadata: { role: "architect" } },
			"orc-epic-1": { id: "orc-epic-1", status: "in_progress", assignee: "orc-arch-1", labels: ["orc-node"], metadata: { role: "architect" } },
		};
		for (let index = 0; index < siblings; index += 1) {
			const scope = siblingScope(index);
			beads[`orc-other-${index}`] = {
				id: `orc-other-${index}`, status: "in_progress", assignee: `orc-impl-${index + 2}`, parent: "orc-feat-1", labels: ["orc-node"],
				metadata: { role: "implementer", ...(scope === undefined ? {} : { scope }) },
			};
		}
		return beads;
	}

	async function ctxFor(role: string): Promise<ExtensionContext> {
		return { cwd: await realpath(os.tmpdir()), getSystemPrompt: () => [`ORC-ROLE: ${role}`] } as unknown as ExtensionContext;
	}

	test.each([1, 5, 20])("with %d in-flight peers, a claimed implementer's writes cost one show after a store write and none otherwise", async peers => {
		// Measured before the memo and the lineage short-circuit: 10 spawns at N=3, 12 at
		// N=5 (the cap). Scope friction has since moved to claim time, so a write reads the
		// claimed bead alone, and the store token serves that read until anyone writes.
		const beads = run(peers, index => [`src/other${index}/**`]);
		const store = await fakeStore();
		const bd = fakeBd({ beads, inFlight: Object.values(beads) });
		try {
			const claims = createClaimState();
			claims.recordClaim({ actor: "orc-impl-1", beadIds: ["orc-task-1"] });
			const ctx = await ctxFor("implementer");
			const write = async () => {
				resetReadBudget();
				return await gateWorktreeScope(claims, ctx, "write", { path: `${ctx.cwd}/src/mod1/x.ts`, content: "x" });
			};
			expect(await write()).toBeUndefined();
			expect(bd.spawned).toEqual(["show orc-task-1"]);
			expect(await write()).toBeUndefined();
			expect(await write()).toBeUndefined();
			expect(bd.spawned).toHaveLength(1);
			await store.write();
			expect(await write()).toBeUndefined();
			expect(bd.spawned).toEqual(["show orc-task-1", "show orc-task-1"]);
		} finally {
			bd.restore();
			await store.restore();
		}
	});

	test.each([
		["scope-less", () => undefined],
		["disjoint scopes", (index: number) => [`src/other${index}/**`]],
	])("without a store token a write from a claimed implementer with three in-flight peers (%s) costs exactly the freshness show", async (_label, siblingScope) => {
		const beads = run(3, siblingScope);
		const bd = fakeBd({ beads, inFlight: Object.values(beads) });
		try {
			const claims = createClaimState();
			claims.recordClaim({ actor: "orc-impl-1", beadIds: ["orc-task-1"] });
			resetReadBudget();
			const ctx = await ctxFor("implementer");
			expect(await gateWorktreeScope(claims, ctx, "write", { path: `${ctx.cwd}/src/mod1/x.ts`, content: "x" })).toBeUndefined();
			expect(bd.spawned).toEqual(["show orc-task-1"]);
		} finally {
			bd.restore();
		}
	});

	test("an architect envelope over six overlapping grandchildren costs one spawn: friction is not re-judged per write", async () => {
		// Measured before: 12 spawns and a false "scope conflict" block at N=6, because the
		// sixth grandchild's lineage walk was the read the budget refused.
		const beads = run(6, index => [`src/other${index}/**`]);
		beads["orc-feat-1"]!.metadata = { role: "architect", scope: ["src/**"] };
		const bd = fakeBd({ beads, inFlight: Object.values(beads) });
		try {
			const claims = createClaimState();
			claims.recordClaim({ actor: "orc-arch-1", beadIds: ["orc-feat-1"] });
			resetReadBudget();
			const ctx = await ctxFor("architect");
			expect(await gateWorktreeScope(claims, ctx, "write", { path: `${ctx.cwd}/src/x.ts`, content: "x" })).toBeUndefined();
			expect(bd.spawned).toEqual(["show orc-feat-1"]);
		} finally {
			bd.restore();
		}
	});

	test("an implementer yield with five linked wisps is evaluated in five spawns, the claimed bead hydrated by list", async () => {
		// Measured before: 4 + 2L reads, so the fifth linked wisp spent the twelfth read and
		// the exit was accepted with its contract unevaluated.
		const linked = ["w1", "w2", "w3", "w4", "w5"];
		const beads: Record<string, BdBead> = {
			"orc-1": { id: "orc-1", status: "in_progress", assignee: "A", metadata: { execution_kind: "git" } },
		};
		for (const id of linked) beads[id] = { id, ephemeral: true, wisp_type: "escalation", status: "closed" };
		const bd = fakeBd({ beads, linked: { "orc-1": linked } });
		try {
			const claims = createClaimState();
			claims.recordClaim({ actor: "A", beadIds: ["orc-1"] });
			const verdict = await createExitGuard(claims)(await ctxFor("implementer"));
			expect(verdict?.block).toBe(true);
			expect(bd.spawned).toEqual(["list --id", "comments orc-1", "dep list", "dep list", "list --id"]);
		} finally {
			bd.restore();
		}
	});

	test("an open escalation among many linked wisps still pauses the exit", async () => {
		const linked = ["w1", "w2", "w3", "w4", "w5", "w6"];
		const beads: Record<string, BdBead> = {
			"orc-1": { id: "orc-1", status: "in_progress", assignee: "A", metadata: { execution_kind: "git" } },
		};
		for (const id of linked) beads[id] = { id, ephemeral: true, wisp_type: "escalation", status: id === "w6" ? "open" : "closed" };
		const bd = fakeBd({ beads, linked: { "orc-1": linked } });
		try {
			const claims = createClaimState();
			claims.recordClaim({ actor: "A", beadIds: ["orc-1"] });
			expect(await createExitGuard(claims)(await ctxFor("implementer"))).toBeUndefined();
			expect(bd.spawned).toHaveLength(5);
		} finally {
			bd.restore();
		}
	});

	test("a reviewer yield reads every linked node's comments under the yield's own budget", async () => {
		// 5 + L reads: fifteen linked nodes would have blown the per-tool-call cap of 12 and
		// been accepted unevaluated; the exit contract runs once per session and gets more.
		const linked = Array.from({ length: 15 }, (_, index) => `node-${index}`);
		const beads: Record<string, BdBead> = {
			"orc-w": { id: "orc-w", ephemeral: true, wisp_type: "review", assignee: "", status: "closed" },
		};
		for (const id of linked) beads[id] = { id, status: "in_progress" };
		const bd = fakeBd({ beads, linked: { "orc-w": linked }, comments: { "node-14": ["note: no opinion recorded"] } });
		try {
			const claims = createClaimState();
			claims.recordClaim({ actor: "R", beadIds: ["orc-w"] });
			const verdict = await createExitGuard(claims)(await ctxFor("reviewer"));
			expect(verdict?.block).toBe(true);
			expect(JSON.parse(verdict!.reason!).failed_checks[0].check).toBe("verdict");
			expect(bd.spawned).toHaveLength(5 + linked.length);
		} finally {
			bd.restore();
		}
	});
});

describe("checked blocked ids", () => {
	async function blockedFrom(stdout: string, code = 0): Promise<string[] | null> {
		const spawn = spyOn(Bun, "spawn").mockImplementation((() => ({
			stdout: new Response(stdout).body,
			stderr: new Response("").body,
			exited: Promise.resolve(code),
			kill: () => {},
		}) as unknown as Bun.Subprocess) as unknown as typeof Bun.spawn);
		try {
			resetReadBudget();
			return await bdBlockedChecked();
		} finally {
			spawn.mockRestore();
		}
	}

	test.each([
		["a bare list", '[{"id":"bd-5","blocked_by":["bd-4"]},{"id":"bd-7"}]', ["bd-5", "bd-7"]],
		["the json envelope", '{"schema_version":1,"data":[{"id":"bd-5"}]}', ["bd-5"]],
		["a warning banner before the payload", 'warning: dolt server is cold\n[{"id":"bd-5"}]', ["bd-5"]],
		["a single object", '{"id":"bd-5"}', ["bd-5"]],
		["a known empty set", "[]", []],
	])("reads %s", async (_label, stdout, expected) => {
		expect(await blockedFrom(stdout)).toEqual(expected);
	});

	test.each([
		["nothing", ""],
		["prose", "bd: not a beads workspace"],
		["truncated json", "[{oops"],
		["an entry without an id", '[{"id":"bd-1"},{"blocked_by":["bd-4"]},null,7]'],
	])("keeps %s unknown rather than empty", async (_label, stdout) => {
		expect(await blockedFrom(stdout)).toBeNull();
	});

	test("keeps a failed read unknown", async () => {
		expect(await blockedFrom("[]", 1)).toBeNull();
	});
});

describe("checked linked evidence", () => {
	test("node dependents and wisp dependencies follow their requested directions", async () => {
		const spawn = spyOn(Bun, "spawn").mockImplementation((...args) => {
			const argv = args[0] as string[];
			const payload = argv.includes("--direction=down")
				? [{ issue_id: "bd-wisp", depends_on_id: "bd-node" }]
				: [{ issue_id: "bd-dependent", depends_on_id: "bd-wisp" }];
			return {
				stdout: new Response(JSON.stringify(payload)).body,
				stderr: new Response("").body,
				exited: Promise.resolve(0),
				kill: () => { },
			} as unknown as Bun.Subprocess;
		});
		try {
			resetReadBudget();
			expect(await bdLinkedChecked("bd-wisp", "relates-to")).toEqual(["bd-dependent"]);
			expect(await bdLinkedChecked("bd-wisp", "relates-to", undefined, "down")).toEqual(["bd-node"]);
		} finally {
			spawn.mockRestore();
		}
	});

	test.each([
		{
			rows: [{ id: "omp-orchestrate-wisp-42", title: "review-task", assignee: "reviewer-7", dependency_type: "relates-to" }],
			expected: ["omp-orchestrate-wisp-42"],
		},
		{
			rows: [{ issue_id: "omp-orchestrate-wisp-42", depends_on_id: "bd-node", created_by: "lead-1", type: "relates-to" }],
			expected: ["omp-orchestrate-wisp-42"],
		},
		{ rows: [{ assignee: "reviewer-7" }], expected: null },
		{ rows: [{ issue_id: "bd-wisp", depends_on_id: "bd-unrelated" }], expected: null },
	])("reads dependency endpoints without harvesting actor IDs: %j", async ({ rows, expected }) => {
		const spawn = spyOn(Bun, "spawn").mockImplementation(() => ({
			stdout: new Response(JSON.stringify(rows)).body,
			stderr: new Response("").body,
			exited: Promise.resolve(0),
			kill: () => { },
		}) as unknown as Bun.Subprocess);
		try {
			resetReadBudget();
			expect(await bdLinkedChecked("bd-node", "relates-to")).toEqual(expected === null ? null : [...expected]);
		} finally {
			spawn.mockRestore();
		}
	});
});

describe("metadataString", () => {
	const bead = { id: "x", metadata: { worktree: "/tmp/wt", empty: "", count: 3 } };

	test("returns a non-empty string value", () => {
		expect(metadataString(bead, "worktree")).toBe("/tmp/wt");
	});

	test("treats empty, missing, non-string, and a null bead as absent", () => {
		expect(metadataString(bead, "empty")).toBeUndefined();
		expect(metadataString(bead, "absent")).toBeUndefined();
		expect(metadataString(bead, "count")).toBeUndefined();
		expect(metadataString(null, "worktree")).toBeUndefined();
	});

	test("object and JSON-string metadata produce identical evidence", async () => {
		const metadata = { worktree: "/tmp/worktree", execution_kind: "git", output_ref: "refs/heads/feature" };
		expect(metadataString({ metadata }, "worktree")).toBe("/tmp/worktree");
		expect(metadataString({ metadata: JSON.stringify(metadata) }, "worktree")).toBe("/tmp/worktree");
		for (const raw of ["{broken", "[]", "null", '"text"']) {
			expect(metadataString({ metadata: raw }, "worktree")).toBeUndefined();
		}
		const spawn = spyOn(Bun, "spawn").mockImplementation(() => ({
			stdout: new Response(JSON.stringify([
				{ id: "bd-object", metadata },
				{ id: "bd-string", metadata: JSON.stringify(metadata) },
			])).body,
			stderr: new Response("").body,
			exited: Promise.resolve(0),
			kill: () => { },
		}) as unknown as Bun.Subprocess);
		try {
			resetReadBudget();
			const beads = await bdListChecked(["list", "--json"]);
			expect(beads?.map(value => value.metadata)).toEqual([metadata, metadata]);
			expect(beads?.map(value => metadataString(value, "execution_kind"))).toEqual(["git", "git"]);
		} finally {
			spawn.mockRestore();
		}
	});
});

describe("commentVerb", () => {
	test("takes the leading token, uppercased, colon stripped", () => {
		expect(commentVerb("REPORTED orc-1 pushed")).toBe("REPORTED");
		expect(commentVerb("reported orc-1")).toBe("REPORTED");
		expect(commentVerb("REVIEW: verdict=approve")).toBe("REVIEW");
		expect(commentVerb("   BLOCKED   kind:design")).toBe("BLOCKED");
	});

	test("reads through the markdown an honest writer uses", () => {
		// Every one of these reached supervision as a non-verb, so the contract that
		// wanted the verb read unsatisfied while the work had in fact been done.
		expect(commentVerb("**REVIEW** approved")).toBe("REVIEW");
		expect(commentVerb("- REVIEW approved")).toBe("REVIEW");
		expect(commentVerb("`REVIEW` approved")).toBe("REVIEW");
		expect(commentVerb("REVIEW, approved")).toBe("REVIEW");
		expect(commentVerb("> REVIEW approved")).toBe("REVIEW");
		expect(commentVerb("_REVIEW_ approved")).toBe("REVIEW");
		expect(commentVerb("~~REVIEW~~ approved")).toBe("REVIEW");
		expect(commentVerb("> - **REPORTED**: orc-1 pushed")).toBe("REPORTED");
	});

	test("keeps NO WORK a non-verb", () => {
		// Deliberate. Reading two tokens would make NO_WORK the only verb assembled
		// from two, and `gateUnclaimedExit` matches the literal `NO_WORK`, so leniency
		// would move the divergence rather than close it. `commentVerbNotice` nags this
		// form, which is what turns the old silent failure into a warning.
		expect(commentVerb("NO WORK")).toBe("NO");
		expect(commentVerb("NO WORK in my queue")).toBe("NO");
		expect(commentVerb("NO_WORK")).toBe("NO_WORK");
		expect(commentVerb("**NO_WORK**: queue empty")).toBe("NO_WORK");
	});

	test("never harvests a verb out of prose", () => {
		// The first token is the whole signal. A comment opening on a word stays a
		// non-verb, so supervision can tell an absent verb from a mangled one. The
		// leading strip cannot cross a word, and the trailing strip is punctuation
		// only -- a slash keeps the token mangled rather than quietly repairing it.
		expect(commentVerb("the REVIEW is done")).toBe("THE");
		expect(commentVerb("Looks good, REVIEW passed")).toBe("LOOKS");
		expect(commentVerb("done")).toBe("DONE");
		expect(commentVerb("REVIEWED the branch")).toBe("REVIEWED");
		expect(commentVerb("NO WORKTREE was created")).toBe("NO");
		expect(commentVerb("REVIEW/approved")).toBe("REVIEW/APPROVED");
	});

	test("yields an empty verb for empty text", () => {
		expect(commentVerb("")).toBe("");
		expect(commentVerb("   ")).toBe("");
		expect(commentVerb("- ")).toBe("");
	});
});

describe("the timeout breaker", () => {
	/**
	 * A stub that outlives any timeout, so the kill path is what runs.
	 *
	 * `sleep` is used rather than a script, because the point is a process that does not
	 * exit on its own.
	 */
	function withSleepBin<T>(body: () => Promise<T>): Promise<T> {
		const previous = process.env.BD_BIN;
		process.env.BD_BIN = "sleep";
		return body().finally(() => {
			if (previous === undefined) delete process.env.BD_BIN;
			else process.env.BD_BIN = previous;
		});
	}

	test("a killed call reports unknown rather than the kill's own exit", async () => {
		// Handing back the killed process's result would let a gate read a signal's exit code
		// as bd's answer. Every gate treats null as permission to proceed; a nonzero code is
		// a finding.
		resetReadBudget();
		await withSleepBin(async () => {
			expect(await bdRun(["30"], 120)).toBeNull();
		});
	});

	test("one timeout short-circuits the rest of the dispatch", async () => {
		// Measured cost of not doing this: with the database unresponsive, several gates ran
		// per tool_call at 10s each and the extension blew its 30s budget, so every bash call
		// in the session died instead of degrading.
		resetReadBudget();
		await withSleepBin(async () => {
			const first = Date.now();
			expect(await bdRun(["30"], 150)).toBeNull();
			const waited = Date.now() - first;
			expect(waited).toBeGreaterThanOrEqual(140);

			// The second call must not spawn at all, so it cannot have waited.
			const second = Date.now();
			expect(await bdRun(["30"], 150)).toBeNull();
			expect(Date.now() - second).toBeLessThan(50);
		});
	});

	test("another operation cannot clear or inherit a pending timeout breaker", async () => {
		await withSleepBin(async () => {
			const resumed = Promise.withResolvers<void>();
			const timedOut = Promise.withResolvers<void>();
			resetReadBudget();
			const first = (async () => {
				expect(await bdRun(["30"], 30)).toBeNull();
				timedOut.resolve();
				await resumed.promise;
				expect(await bdRun(["0"])).toBeNull();
			})();
			resetReadBudget();
			await timedOut.promise;
			try {
				expect((await bdRun(["0"]))?.code).toBe(0);
			} finally {
				resumed.resolve();
			}
			await first;
		});
	});
	test("the next dispatch starts with the breaker clear", async () => {
		// The breaker is per dispatch, not per session: a database that recovers must be
		// readable again on the next tool_call rather than staying written off.
		resetReadBudget();
		await withSleepBin(async () => {
			expect(await bdRun(["30"], 120)).toBeNull();
		});

		resetReadBudget();
		const previous = process.env.BD_BIN;
		process.env.BD_BIN = "true";
		try {
			const result = await bdRun([]);
			expect(result).not.toBeNull();
			expect(result?.code).toBe(0);
		} finally {
			if (previous === undefined) delete process.env.BD_BIN;
			else process.env.BD_BIN = previous;
		}
	});
});

