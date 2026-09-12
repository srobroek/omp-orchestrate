import { afterAll, afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { chmod, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import * as hostSettings from "@oh-my-pi/pi-coding-agent/config/settings";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { SettingPath } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import { withOmpExtensionRootScope } from "@oh-my-pi/pi-coding-agent/discovery/omp-extension-roots";
import type { BdBead } from "../src/bd";
import * as bd from "../src/bd";
import { createClaimState } from "../src/claim-state";
import { ASSIGNMENT_NOTICE_MESSAGE } from "../src/gates/assignment";
import {
	appendAudit,
	auditDir,
	auditFileName,
	bdMutation,
	bdMutationEvent,
	degradedSet,
	noteLspStartup,
	noteMcpStatus,
	noteProgress,
	progressSample,
	preflightSettings,
	registerWatchers,
	resetWatchers,
	settingsDeviations,
	runEpics,
	stallMinutes,
	sweepStalls,
} from "../src/watchers";

const MINUTE = 60_000;

let cwd: string;

const ENV_KEYS = ["ORC_STALL_MINUTES", "BD_BIN", "ORC_TEST_BD_LOG", "ORC_TEST_BD_LIST", "ORC_TEST_BD_FAIL", "ORC_TEST_BD_TARGET", "ORC_TEST_BD_WHERE", "ORC_TEST_BD_SHOW", "ORC_TEST_BD_COMMENTS"] as const;

beforeEach(async () => {
	cwd = join(tmpdir(), `orc-watchers-${Math.random().toString(36).slice(2)}`);
	await mkdir(cwd, { recursive: true });
	for (const key of ENV_KEYS) delete process.env[key];
	stubbed = undefined;
	settingsSpy.mockClear();
	resetWatchers();
});

afterEach(async () => {
	for (const key of ENV_KEYS) delete process.env[key];
	setSystemTime();
	resetWatchers();
	await rm(cwd, { recursive: true, force: true });
});

/** A `task:subagent:progress` payload, in the shape the executor emits. */
function progress(child: string, fields: Record<string, unknown> = {}): unknown {
	return {
		index: 0,
		agent: "orc-implementer",
		task: "do the thing",
		sessionFile: `/tmp/${child}.jsonl`,
		progress: { id: child, status: "running", tokens: 100, recentOutput: ["working"], ...fields },
	};
}

/**
 * The two `task:subagent:event` payloads a real `bash` call produces, with the
 * shapes the installed runtime actually emits (`pi-agent-core/src/types.ts:883-885`):
 * `args` exists only on the start, `result`/`isError` only on the end.
 */
function bashStart(child: string, command: string, callId = "call-1"): unknown {
	return {
		id: child,
		event: { type: "tool_execution_start", toolCallId: callId, toolName: "bash", args: { command } },
	};
}

function bashEnd(child: string, result?: unknown, isError = false, callId = "call-1"): unknown {
	return {
		id: child,
		event: { type: "tool_execution_end", toolCallId: callId, toolName: "bash", result, isError },
	};
}

// ============================================================================
// W2 — the word scanner
// ============================================================================

describe("bdMutation", () => {
	test("names the mutating subcommand of a plain invocation", () => {
		expect(bdMutation("bd update bd-1 --status open")).toBe("update");
		expect(bdMutation("bd close bd-1 --reason merged")).toBe("close");
		expect(bdMutation('bd comment bd-1 "REPORTED pushed"')).toBe("comment");
		expect(bdMutation("bd create 'a title' --type task")).toBe("create");
		expect(bdMutation("bd reopen bd-1")).toBe("reopen");
		expect(bdMutation("bd set-state bd-1 state=working")).toBe("set-state");
		expect(bdMutation("bd dep add bd-2 bd-1")).toBe("dep");
		expect(bdMutation("bd label add bd-1 orc-node")).toBe("label");
	});

	test("classifies by G6's write table, so bd's shorthand mutators leave a line", () => {
		// The allowlist this replaced named eight verbs; a child that released,
		// relabelled, or took the merge slot through any of these left no ledger line.
		expect(bdMutation("bd assign bd-1 alice")).toBe("assign");
		expect(bdMutation("bd delete bd-1")).toBe("delete");
		expect(bdMutation("bd note bd-1 'a note'")).toBe("note");
		expect(bdMutation("bd promote bd-1")).toBe("promote");
		expect(bdMutation("bd link bd-1 bd-2")).toBe("link");
		expect(bdMutation("bd merge-slot acquire orc-1 --claim")).toBe("merge-slot");
		expect(bdMutation("bd mol pour mol-bounce")).toBe("mol");
		expect(bdMutation("bd comments add bd-1 'REPORTED done'")).toBe("comments");
		// A queue pull is the claim the dead-claim procedure most wants to see.
		expect(bdMutation("bd ready --claim")).toBe("ready");
	});

	test("does not record a grouped read as a mutation", () => {
		expect(bdMutation("bd label list")).toBeUndefined();
		expect(bdMutation("bd dep tree orc-1")).toBeUndefined();
		expect(bdMutation("bd mol pour mol-bounce --dry-run")).toBeUndefined();
		expect(bdMutation("bd update --help")).toBeUndefined();
	});

	test("sees through an env-var prefix", () => {
		expect(bdMutation("FOO=1 bd update x")).toBe("update");
		expect(bdMutation("BEADS_ACTOR=arch-1 BD_ACTOR=arch-1 bd update x --claim")).toBe("update");
		expect(bdMutation("env BD_ACTOR=arch-1 bd close x")).toBe("close");
	});

	test("scans every segment of a compound command", () => {
		expect(bdMutation("cd /y && bd close z")).toBe("close");
		expect(bdMutation("bd show x && bd update y")).toBe("update");
		expect(bdMutation("bd list --json | jq .; bd comment x hi")).toBe("comment");
	});

	test("resolves an absolute path to the same binary", () => {
		expect(bdMutation("/usr/local/bin/bd update x")).toBe("update");
	});

	test("ignores a read-only invocation", () => {
		expect(bdMutation("bd show bd-1 --json")).toBeUndefined();
		expect(bdMutation("bd list --type epic --json")).toBeUndefined();
		expect(bdMutation("bd comments bd-1 --json")).toBeUndefined();
		expect(bdMutation("bd")).toBeUndefined();
	});

	test("ignores a command that merely mentions bd", () => {
		// The ledger records what a child ran, not what it printed. `bd` here is an
		// argument, so treating it as the command would log a phantom mutation.
		expect(bdMutation("echo bd update x")).toBeUndefined();
		expect(bdMutation('echo "bd update x"')).toBeUndefined();
		expect(bdMutation('git commit -m "bd update bd-1"')).toBeUndefined();
		expect(bdMutation("grep -r 'bd close' src")).toBeUndefined();
	});
});

/** The event `bdMutationEvent` reports for a clean write against the run's own store. */
function ownWrite(child: string, command: string) {
	return { child, command, exitCode: 0, store: undefined };
}

describe("bdMutationEvent", () => {
	test("a start alone records nothing; the end completes it", () => {
		// The regression this pins: the command lives on the start, the status on the
		// end, so only the pair is a ledger line. Reading one event was silently a
		// no-op for an entire live run.
		expect(bdMutationEvent(bashStart("kid-1", "bd update bd-7 --claim"))).toBeUndefined();
		expect(bdMutationEvent(bashEnd("kid-1"))).toEqual(ownWrite("kid-1", "bd update bd-7 --claim"));
	});

	test.each([
		["a --db path", "bd create 'sandbox' --type task --db /tmp/sandbox/.beads/embeddeddolt", undefined, "/tmp/sandbox/.beads/embeddeddolt"],
		["a --db= path", "bd close bd-7 --db=/tmp/sandbox/.beads", undefined, "/tmp/sandbox/.beads"],
		["a -C directory", "bd -C /tmp/sandbox close bd-7", undefined, "/tmp/sandbox"],
		["an inline BEADS_DB assignment", "BEADS_DB=/tmp/inline/.beads bd close bd-7", { BEADS_DB: "/tmp/env/.beads" }, "/tmp/inline/.beads"],
		["a structured BEADS_DB env", "bd close bd-7", { BEADS_DB: "/tmp/env/.beads" }, "/tmp/env/.beads"],
	])("attributes a write naming %s to that store, as provenance rather than a run mutation", (_label, command, env, store) => {
		// A researcher's sandbox writes were counted as run mutations because the ledger
		// classified by command text alone. Inside a run bd resolves the run's store from the
		// working directory; a call that names one points elsewhere.
		bdMutationEvent({
			id: "kid-1",
			event: { type: "tool_execution_start", toolCallId: "call-2", toolName: "bash", args: { command, ...(env === undefined ? {} : { env }) } },
		});
		expect(bdMutationEvent(bashEnd("kid-1", undefined, false, "call-2"))).toMatchObject({ store });
	});

	test("a write naming no store is the run's", () => {
		bdMutationEvent(bashStart("kid-1", "bd close bd-8"));
		expect(bdMutationEvent(bashEnd("kid-1"))).toEqual(ownWrite("kid-1", "bd close bd-8"));
	});

	test("carries the reported exit code through", () => {
		bdMutationEvent(bashStart("kid-1", "bd close bd-7"));
		expect(bdMutationEvent(bashEnd("kid-1", { details: { exitCode: 3 } }, true))?.exitCode).toBe(3);
	});

	test("reads an errored call with no code as a failure, never as success", () => {
		// `bash` omits `details.exitCode` on a timeout or a kill; reporting 0 there
		// would record a mutation that never landed as one that did.
		bdMutationEvent(bashStart("kid-1", "bd close bd-7"));
		expect(bdMutationEvent(bashEnd("kid-1", { details: {} }, true))?.exitCode).toBe(1);
	});

	test("an end is consumed once, so a replayed event cannot double-count", () => {
		bdMutationEvent(bashStart("kid-1", "bd update bd-7 --claim"));
		expect(bdMutationEvent(bashEnd("kid-1"))).toBeDefined();
		expect(bdMutationEvent(bashEnd("kid-1"))).toBeUndefined();
	});

	test("concurrent children and calls do not cross", () => {
		// Keyed on child *and* tool call: two children share call ids, and one child
		// runs several bd calls, so either key alone mixes commands up.
		bdMutationEvent(bashStart("kid-1", "bd update bd-1 --claim"));
		bdMutationEvent(bashStart("kid-2", "bd close bd-2"));
		bdMutationEvent(bashStart("kid-1", "bd comment bd-1 REPORTED", "call-2"));
		expect(bdMutationEvent(bashEnd("kid-2"))?.command).toBe("bd close bd-2");
		expect(bdMutationEvent(bashEnd("kid-1", undefined, false, "call-2"))?.command).toBe("bd comment bd-1 REPORTED");
		expect(bdMutationEvent(bashEnd("kid-1"))?.command).toBe("bd update bd-1 --claim");
	});

	test("an end with no remembered start is not invented", () => {
		// A session that attached mid-flight has no command to record, and guessing
		// one would put a line in the ledger no child ran.
		expect(bdMutationEvent(bashEnd("kid-9"))).toBeUndefined();
	});

	test("ignores anything that is not a bd mutation", () => {
		expect(bdMutationEvent(bashStart("kid-1", "bd show bd-7 --json"))).toBeUndefined();
		expect(bdMutationEvent(bashEnd("kid-1"))).toBeUndefined();
		expect(
			bdMutationEvent({ id: "kid-1", event: { type: "tool_execution_start", toolCallId: "c", toolName: "edit" } }),
		).toBeUndefined();
		expect(bdMutationEvent({ event: { type: "tool_execution_end", toolCallId: "c", toolName: "bash" } })).toBeUndefined();
		expect(bdMutationEvent(null)).toBeUndefined();
		expect(bdMutationEvent("bd update x")).toBeUndefined();
	});
});

/**
 * The runtime's typed union omits `args` on `tool_execution_end`, but a live
 * multi-agent run recorded commands through exactly that field, and the executor
 * itself only probes for it. Both shapes must therefore work: pinning only one
 * silently disables the ledger on the runtime that uses the other.
 */
describe("bdMutationEvent across both runtime shapes", () => {
	/** The forwarded end event as the live run produced it: args on the end. */
	function bashEndWithArgs(child: string, command: string, callId = "call-1"): unknown {
		return {
			id: child,
			event: { type: "tool_execution_end", toolCallId: callId, toolName: "bash", args: { command }, result: {} },
		};
	}

	test("an end event carrying its own args needs no start", () => {
		expect(bdMutationEvent(bashEndWithArgs("kid-7", "bd update orc-9 --claim"))).toEqual(
			ownWrite("kid-7", "bd update orc-9 --claim"),
		);
	});

	test("the end event's own args win over a stale correlated start", () => {
		bdMutationEvent(bashStart("kid-7", "bd close orc-1"));
		expect(bdMutationEvent(bashEndWithArgs("kid-7", "bd update orc-9 --claim"))?.command).toBe(
			"bd update orc-9 --claim",
		);
	});

	test("a non-mutating command on the end event is still ignored", () => {
		expect(bdMutationEvent(bashEndWithArgs("kid-7", "bd show orc-9 --json"))).toBeUndefined();
	});
});

/** Every required setting at the value the run wants, and the declared role configured: a preflight with nothing to say. */
const COMPLIANT_SETTINGS: Partial<Record<SettingPath, unknown>> = {
	"task.isolation.enabled": true,
	"task.isolation.merge": "branch",
	"task.isolation.apply": false,
	"task.enableEffort": true,
	"task.maxRecursionDepth": 3,
	"bash.autoBackground.enabled": false,
	modelRoles: { reviewer: "x/y" },
};

/** The settings instance the watchers read, or none. Set by {@link stubSettings}; cleared before every test. */
let stubbed: Settings | undefined;
const settingsSpy = spyOn(hostSettings, "findScopedSettings").mockImplementation(() => stubbed);
afterAll(() => settingsSpy.mockRestore());

/**
 * Make these the session's effective settings; anything unnamed takes its schema default,
 * as it does for a real session. The precondition that outranks the settings block:
 * isolation working correctly is exactly what splits the beads database, so a run with
 * perfect settings can still lose every claim. Verified against a real checkout copy,
 * where a bead created in the copy is invisible in the original.
 */
async function stubSettings(values: Partial<Record<SettingPath, unknown>>): Promise<void> {
	stubbed = Settings.isolated(values);
}

/** How many times the settings were read in process. */
function settingsReads(): number {
	return settingsSpy.mock.calls.length;
}

/**
 * A run marker at `cwd`, recording the run's database unless `beadsDir` is `null`. The
 * watchers arm on it and on nothing else; `pending` names a run activated but not bound,
 * which arms them without giving the settings preflight an epic to comment on.
 */
async function marked(beadsDir: string | null = join(cwd, ".beads"), runId = "orc-w5"): Promise<void> {
	await mkdir(join(cwd, ".orchestration"), { recursive: true });
	await writeFile(join(cwd, ".orchestration", ".active-run"), JSON.stringify({ schema_version: 1, run_id: runId, ...(beadsDir === null ? {} : { beads_dir: beadsDir }) }));
}

describe("W5 shared-database precondition", () => {
	/**
	 * Inject the settings. Without them these tests would read whatever this host is
	 * configured for, or nothing at all on a CI runner with no settings instance, where
	 * the check correctly stays quiet. The precondition under test is the database, so
	 * isolation alone varies and every other requirement is satisfied.
	 */
	async function stubOmp(enabled: boolean): Promise<void> {
		await stubSettings({ ...COMPLIANT_SETTINGS, "task.isolation.enabled": enabled });
	}

	test("a marker without the run's database asks for a re-activation", async () => {
		// A marker written before the field existed leaves every isolated copy on its private
		// store; re-activation records the database, so that is the repair the line names.
		await stubOmp(true);
		await marked(null);
		const rig = harness();
		resetWatchers();
		await preflightSettings(rig.pi, cwd);
		const notice = String(rig.messages.at(-1)?.content ?? "");
		expect(notice).toContain("the run marker names no beads database");
		expect(notice).toContain("/orchestrate-run");
		expect((await bdCalls()).map(call => call[0])).not.toContain("where");
	});

	test("a marker recording the database is silent, and no bd is spawned for it", async () => {
		await stubOmp(true);
		await fakeBd();
		await marked();
		const rig = harness();
		resetWatchers();
		await preflightSettings(rig.pi, cwd);
		expect(rig.messages).toEqual([]);
		expect(await bdCalls()).toEqual([]);
	});

	test("a repository with no run says nothing about the database", async () => {
		await stubOmp(true);
		const rig = harness();
		resetWatchers();
		await preflightSettings(rig.pi, cwd);
		expect(rig.messages).toEqual([]);
	});

	/**
	 * `DECLARED_MODEL_ROLES` names roles OMP does not ship. An unconfigured alias resolves
	 * to undefined with no warning and falls back to the session default, so the whole
	 * value of declaring one is that its absence is announced.
	 */
	test.each([
		["an empty roles object", {}, true],
		["roles that omit it", { plan: "x/y:high", task: "x/y:auto" }, true],
		["roles that configure it", { reviewer: "mantle/openai.gpt-5.6-sol:medium" }, false],
	])("a declared model role missing from %s warns=%p", async (_label, modelRoles, wantWarning) => {
		await stubSettings({ ...COMPLIANT_SETTINGS, modelRoles });
		await marked();
		const rig = harness();
		resetWatchers();
		await preflightSettings(rig.pi, cwd);
		const notice = rig.messages.map(message => String(message.content)).join("\n");
		expect(notice.includes("modelRoles.reviewer is not configured")).toBe(wantWarning);
	});

	test("no live settings instance is reported as unverified, never as a deviation", async () => {
		// Nothing is known about the settings, so no setting is named -- reading a missing
		// value as "isolating" would warn about a split database on a run with no
		// isolation. What the operator is told is that the check did not run.
		await marked();
		const rig = harness();
		resetWatchers();
		expect(await preflightSettings(rig.pi, cwd)).toEqual([]);
		expect(rig.messages).toHaveLength(1);
		const notice = String(rig.messages[0]?.content);
		expect(notice).toContain("could not be read");
		expect(notice).not.toContain("task.isolation");
		expect(notice).not.toContain("beads database");
	});

	test("isolation explicitly off warns about shared trees only", async () => {
		await stubOmp(false);
		await marked();

		const rig = harness();
		resetWatchers();
		const deviations = await preflightSettings(rig.pi, cwd);
		expect(deviations.map(item => item.key)).toEqual(["task.isolation.enabled"]);
		expect(String(rig.messages.at(-1)?.content ?? "")).not.toContain("beads database");
	});
});

describe("the settings preflight preserves user configuration", () => {
	async function deviantSettings(): Promise<void> {
		await stubSettings({
			...COMPLIANT_SETTINGS,
			"task.isolation.merge": "patch",
			"task.isolation.apply": true,
			"task.enableEffort": false,
			"task.maxRecursionDepth": 2,
		});
	}

	test("deviations warn without creating a project config", async () => {
		await deviantSettings();
		const rig = harness();
		const deviations = await preflightSettings(rig.pi, cwd);
		expect(deviations.map(item => item.key)).toEqual([
			"task.isolation.merge", "task.isolation.apply", "task.enableEffort", "task.maxRecursionDepth",
		]);
		expect(rig.messages).toHaveLength(1);
		expect(await readdir(cwd)).not.toContain(".omp");
	});

	test.each([
		'# keep comments\n"key: with colon": yes\ntask:\n  isolation:\n    merge: patch\n',
		"task: [unclosed\n",
	])("existing configuration remains byte-for-byte unchanged", async config => {
		await deviantSettings();
		await mkdir(join(cwd, ".omp"));
		const file = join(cwd, ".omp", "config.yml");
		await writeFile(file, config);
		await preflightSettings(harness().pi, cwd);
		expect(await readFile(file, "utf8")).toBe(config);
	});
});

describe("the audit ledger on disk", () => {
	test("appends one JSONL line per mutation", async () => {
		const dir = join(cwd, "audit");
		await appendAudit(dir, { ts: "2026-08-24T00:00:00.000Z", child: "kid-1", argv: "bd update x", exitCode: 0 });
		await appendAudit(dir, { ts: "2026-08-24T00:00:01.000Z", child: "kid-1", argv: "bd close x", exitCode: 1 });

		const lines = (await readFile(join(dir, "kid-1.bdlog"), "utf8")).trim().split("\n");
		expect(lines.map(line => JSON.parse(line).argv)).toEqual(["bd update x", "bd close x"]);
		expect(JSON.parse(lines[1]!).exitCode).toBe(1);
	});

	test("keeps a hostile child id inside the ledger directory", async () => {
		// The contract is containment, not a tidy name: no separator survives, and
		// no name starts with a dot, so no id can write outside the directory.
		const escaped = auditFileName("../../etc/passwd");
		expect(escaped).not.toContain("/");
		expect(escaped?.startsWith(".")).toBe(false);
		expect(auditFileName("kid/1")).toBe("kid_1.bdlog");
		expect(auditFileName("..")).toBeUndefined();
		expect(auditFileName("")).toBeUndefined();

		const dir = join(cwd, "audit");
		await appendAudit(dir, { ts: "t", child: "../escape", argv: "bd update x", exitCode: 0 });
		expect(await readdir(dir)).toEqual(["_escape.bdlog"]);
	});

	test("lives under the spawning session's cwd", () => {
		expect(auditDir("/repo")).toBe(join("/repo", ".orchestration", "audit"));
	});
});

// ============================================================================
// W1 — stall detection
// ============================================================================

describe("progressSample", () => {
	test("reads the child id off progress, where the executor puts it", () => {
		// The payload's own top level carries `index` and `sessionFile` only, so a
		// tracker keyed on the top level would have no id to name a bead's holder.
		expect(progressSample(progress("kid-1"))).toEqual({
			child: "kid-1",
			tokens: 100,
			output: "working",
			terminal: false,
		});
	});

	test("marks a settled child terminal", () => {
		expect(progressSample(progress("kid-1", { status: "completed" }))?.terminal).toBe(true);
		expect(progressSample(progress("kid-1", { status: "failed" }))?.terminal).toBe(true);
		expect(progressSample(progress("kid-1", { status: "aborted" }))?.terminal).toBe(true);
	});

	test("tolerates a payload missing the fields it reads", () => {
		expect(progressSample({ progress: { id: "kid-1" } })).toEqual({
			child: "kid-1",
			tokens: 0,
			output: "",
			terminal: false,
		});
		expect(progressSample({ progress: {} })).toBeUndefined();
		expect(progressSample({ index: 0 })).toBeUndefined();
		expect(progressSample(null)).toBeUndefined();
	});
});

describe("sweepStalls", () => {
	/** Note a sample at `atMs`, asserting the payload parsed. */
	function note(child: string, atMs: number, fields: Record<string, unknown> = {}): void {
		const sample = progressSample(progress(child, fields));
		expect(sample).toBeDefined();
		noteProgress(sample!, atMs);
	}

	test("leaves a child alone until the threshold passes", () => {
		note("kid-1", 0);
		expect(sweepStalls(9 * MINUTE, 10 * MINUTE)).toEqual([]);
		expect(sweepStalls(10 * MINUTE, 10 * MINUTE)).toEqual([{ child: "kid-1", silentMinutes: 10 }]);
	});

	test("keeps an unreported child eligible on later sweeps", () => {
		note("kid-1", 0);
		expect(sweepStalls(11 * MINUTE, 10 * MINUTE)).toEqual([{ child: "kid-1", silentMinutes: 11 }]);
		expect(sweepStalls(30 * MINUTE, 10 * MINUTE)).toEqual([{ child: "kid-1", silentMinutes: 30 }]);
	});

	test("a progress delta restarts the clock", () => {
		note("kid-1", 0);
		note("kid-1", 8 * MINUTE, { tokens: 200 });
		expect(sweepStalls(15 * MINUTE, 10 * MINUTE)).toEqual([]);
		expect(sweepStalls(19 * MINUTE, 10 * MINUTE)).toEqual([{ child: "kid-1", silentMinutes: 11 }]);
	});

	test("a repeated identical sample is not a delta", () => {
		// A child re-emitting the same token count and output tail is silent, and
		// the 150ms coalescing means it emits often while doing nothing.
		note("kid-1", 0);
		note("kid-1", 5 * MINUTE);
		note("kid-1", 9 * MINUTE);
		expect(sweepStalls(11 * MINUTE, 10 * MINUTE)).toEqual([{ child: "kid-1", silentMinutes: 11 }]);
	});

	test("a settled child is dropped rather than flagged", () => {
		// A finished child stops emitting progress; keeping it would report every
		// completed worker as stalled once the threshold elapsed.
		note("kid-1", 0);
		note("kid-1", MINUTE, { status: "completed" });
		expect(sweepStalls(60 * MINUTE, 10 * MINUTE)).toEqual([]);
	});

	test("reports each silent child separately", () => {
		note("kid-1", 0);
		note("kid-2", 2 * MINUTE);
		note("kid-3", 20 * MINUTE);
		expect(sweepStalls(21 * MINUTE, 10 * MINUTE)).toEqual([
			{ child: "kid-1", silentMinutes: 21 },
			{ child: "kid-2", silentMinutes: 19 },
		]);
	});
});

describe("stallMinutes", () => {
	test("defaults to ten", () => {
		expect(stallMinutes()).toBe(10);
	});

	test("ORC_STALL_MINUTES wins when it names a positive number", () => {
		process.env.ORC_STALL_MINUTES = "3";
		expect(stallMinutes()).toBe(3);
	});

	test("a blank, negative, or unparseable value falls back", () => {
		for (const value of ["", "0", "-5", "soon"]) {
			process.env.ORC_STALL_MINUTES = value;
			expect(stallMinutes()).toBe(10);
		}
	});
});

// ============================================================================
// W3 — degraded set
// ============================================================================

describe("degradedSet", () => {
	test("adds a failed MCP server and clears it when it connects", () => {
		expect(degradedSet()).toEqual([]);
		noteMcpStatus({ type: "failed", serverName: "context7", error: "spawn ENOENT" });
		expect(degradedSet()).toEqual(["mcp:context7"]);
		noteMcpStatus({ type: "connected", serverName: "context7" });
		expect(degradedSet()).toEqual([]);
	});

	test("adds only the language servers that reported an error", () => {
		noteLspStartup({
			type: "completed",
			servers: [
				{ name: "typescript", status: "ready" },
				{ name: "gopls", status: "error" },
			],
		});
		expect(degradedSet()).toEqual(["lsp:gopls"]);
		noteLspStartup({ type: "completed", servers: [{ name: "gopls", status: "ready" }] });
		expect(degradedSet()).toEqual([]);
	});

	test("names a wholesale LSP startup failure", () => {
		noteLspStartup({ type: "failed", error: "no servers configured" });
		expect(degradedSet()).toEqual(["lsp:startup"]);
	});

	test("reports every source together, sorted", () => {
		noteMcpStatus({ type: "failed", serverName: "context7", error: "x" });
		noteLspStartup({ type: "completed", servers: [{ name: "gopls", status: "error" }] });
		expect(degradedSet()).toEqual(["lsp:gopls", "mcp:context7"]);
	});

	test("ignores a payload it cannot read", () => {
		noteMcpStatus({ type: "connecting", serverNames: ["context7"] });
		noteMcpStatus(null);
		noteMcpStatus({ type: "failed" });
		noteLspStartup({ type: "completed" });
		noteLspStartup({ type: "completed", servers: [{ status: "error" }] });
		noteLspStartup("failed");
		expect(degradedSet()).toEqual([]);
	});
});

// ============================================================================
// W4 — run membership
// ============================================================================

describe("runEpics", () => {
	const epics: BdBead[] = [
		{ id: "bd-1", status: "in_progress" },
		{ id: "bd-2", parent: "bd-1" },
		{ id: "bd-3", metadata: { origin: "bd-1" } },
		{ id: "bd-9", parent: "bd-8" },
	];

	test("keeps the run epic, its children, and anything stamped with its origin", () => {
		expect(runEpics(epics, "bd-1").map(epic => epic.id)).toEqual(["bd-1", "bd-2", "bd-3"]);
	});

	test("an unbound marker reaches no epics", () => {
		expect(runEpics(epics, undefined)).toEqual([]);
	});

	test("a run with no epics yields none rather than everything", () => {
		expect(runEpics(epics, "bd-77")).toEqual([]);
	});
});

// ============================================================================
// Wiring
// ============================================================================

/** Records every `bd` argv and answers `list` from `ORC_TEST_BD_LIST`. */
async function fakeBd(): Promise<string> {
	const bin = join(cwd, "fake-bd");
	await writeFile(
		bin,
		[
			`#!${process.execPath}`,
			'import { appendFileSync } from "node:fs";',
			'const args = process.argv.slice(2);',
			'appendFileSync(process.env.ORC_TEST_BD_LOG, ">>>\\n" + args.join("\\n") + "\\n");',
			'if (args[0] === process.env.ORC_TEST_BD_FAIL && (!process.env.ORC_TEST_BD_TARGET || args[1] === process.env.ORC_TEST_BD_TARGET)) process.exit(1);',
			'const beads = JSON.parse(process.env.ORC_TEST_BD_LIST || "[]");',
			'if (args[0] === "where") console.log(process.env.ORC_TEST_BD_WHERE);',
			'if (args[0] === "show") {',
			'  const source = process.env.ORC_TEST_BD_SHOW ? JSON.parse(process.env.ORC_TEST_BD_SHOW) : beads;',
			'  console.log(JSON.stringify(source.find(item => item.id === args[1]) || null));',
			'  process.exit(0);',
			'}',
			'if (args[0] === "comments") {',
			'  const comments = JSON.parse(process.env.ORC_TEST_BD_COMMENTS || "{}");',
			'  console.log(JSON.stringify(comments[args[1]] || []));',
			'  process.exit(0);',
			'}',
			'if (args[0] === "dep") { console.log("[]"); process.exit(0); }',
			'if (args[0] === "list") {',
			'  const index = args.indexOf("--assignee");',
			'  const matches = index === -1 ? beads : beads.filter(bead => bead.assignee === args[index + 1]);',
			'  const limitIndex = args.indexOf("--limit");',
			'  const limit = limitIndex === -1 ? 50 : Number(args[limitIndex + 1]);',
			'  console.log(JSON.stringify(limit === 0 ? matches : matches.slice(0, limit)));',
			'}',
		].join("\n"),
		"utf8",
	);
	await chmod(bin, 0o755);
	process.env.BD_BIN = bin;
	process.env.ORC_TEST_BD_LOG = join(cwd, "bd.log");
	process.env.ORC_TEST_BD_LIST = "[]";
	process.env.ORC_TEST_BD_WHERE = join(cwd, ".beads");
	process.env.ORC_TEST_BD_COMMENTS = "{}";
	return bin;
}

/** Every `bd` invocation the fake saw, as argv arrays. */
async function bdCalls(): Promise<string[][]> {
	let raw: string;
	try {
		raw = await readFile(join(cwd, "bd.log"), "utf8");
	} catch {
		return [];
	}
	return raw
		.split(">>>\n")
		.filter(record => record.length > 0)
		.map(record => record.split("\n").filter(line => line.length > 0));
}

interface Harness {
	pi: ExtensionAPI;
	/** Dispatch an extension event to every handler, in registration order. */
	fire(event: string, payload: Record<string, unknown>): Promise<unknown[]>;
	/** Publish on a bus channel and settle every subscriber. */
	emit(channel: string, data: unknown): Promise<void>;
	/** Channels subscribed so far. */
	channels(): string[];
	/** Callbacks handed to `ctx.setInterval`. */
	sweeps: Array<() => unknown>;
	messages: Array<Record<string, unknown>>;
	failures: string[];
	warnings: string[];
}

interface ChildHarnessOptions {
	entries?: unknown[];
	systemPrompt?: string;
	resolve?: (spec: string) => unknown;
	current?: () => unknown;
}

function harness(
	tools: string[] = ["bash", "read", "task"],
	withModels = false,
	child?: ChildHarnessOptions,
): Harness {
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const listeners = new Map<string, Array<(data: unknown) => unknown>>();
	const sweeps: Array<() => unknown> = [];
	const messages: Array<Record<string, unknown>> = [];
	const failures: string[] = [];
	const warnings: string[] = [];
	const timeouts = new Set<() => unknown>();

	const ctx = {
		cwd,
		...((withModels || child !== undefined)
			? {
				models: {
					resolve: child?.resolve ?? (() => undefined),
					...(child?.current === undefined ? {} : { current: child.current }),
				},
			}
			: {}),
		...(child === undefined
			? {}
			: {
				sessionManager: { getEntries: () => child.entries ?? [] },
				getSystemPrompt: () => [child.systemPrompt ?? ""],
			}),
		setTimeout: (callback: () => unknown) => {
			timeouts.add(callback);
			return callback;
		},
		setInterval: (callback: () => unknown) => {
			sweeps.push(callback);
			return callback;
		},
		clearTimer: (callback: () => unknown) => {
			const index = sweeps.indexOf(callback);
			if (index !== -1) sweeps.splice(index, 1);
			timeouts.delete(callback);
		},
	};

	const pi = {
		getAllTools: () => tools.map(name => ({ name, description: "" })),
		logger: {
			error: (message: string) => failures.push(message),
			warn: (message: string) => warnings.push(message),
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
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		sendMessage: (message: Record<string, unknown>) => messages.push(message),
	};

	return {
		pi: pi as unknown as ExtensionAPI,
		fire: async (event, payload) => {
			const results: unknown[] = [];
			for (const handler of handlers.get(event) ?? []) {
				results.push(await handler({ type: event, ...payload }, ctx));
			}
			return results;
		},
		emit: async (channel, data) => {
			for (const listener of listeners.get(channel) ?? []) await listener(data);
		},
		channels: () => [...listeners.keys()],
		sweeps,
		messages,
		failures,
		warnings,
	};
}

async function coreFixture(name: string, marker: string, model = "@task"): Promise<void> {
	await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "core-fixture", omp: {} }));
	await mkdir(join(cwd, "agents"), { recursive: true });
	await writeFile(
		join(cwd, "agents", `${name}.md`),
		`---\nname: ${name}\ndescription: fixture\nmodel: "${model}"\n---\nORC-ROLE: ${marker}\n`,
	);
}

function registerFixture(rig: Harness): void {
	withOmpExtensionRootScope([cwd], "explicit-only", () => registerWatchers(rig.pi));
}

/** The G8 notices a harness received. */
function assignmentNotices(rig: Harness): string[] {
	return rig.messages
		.filter(message => message.customType === ASSIGNMENT_NOTICE_MESSAGE)
		.map(message => String(message.content));
}

describe("assignment enforcement", () => {
	// G8 is a run-scoped notice: every seat below sits in a marked checkout.
	beforeEach(() => marked());

	test("refuses repeated requests for a malformed core assignment but leaves helpers available", async () => {
		await coreFixture("orc-reviewer", "researcher", "@reviewer");
		const rig = harness(undefined, true);
		registerFixture(rig);

		for (let attempt = 0; attempt < 2; attempt += 1) {
			const result = await rig.fire("tool_call", { toolName: "task", input: { agent: "orc-reviewer" } });
			expect(result[0]).toMatchObject({ block: true });
			expect(String((result[0] as Record<string, unknown>).reason)).toContain("expected reviewer");
		}
		expect(
			rig.messages.filter(message => message.customType === "com.srobroek.omp-orchestrate.agent-preflight"),
		).toHaveLength(1);

		await coreFixture("orc-helper", "helper", "@task");
		const helper = harness(undefined, true);
		registerFixture(helper);
		expect(await helper.fire("tool_call", { toolName: "task", input: { agent: "orc-helper" } })).toEqual([undefined]);
	});

	test("a model mismatch is one notice naming both models and the parking command, never a block", async () => {
		// The refusal this replaced bricked a worker whose model OMP's retry fallback had
		// moved: every tool including `yield` was refused for a condition already recovered.
		const expected = { provider: "test-provider", id: "task-model" };
		let current: unknown = expected;
		const claims = createClaimState();
		claims.recordClaim({ actor: "worker-1", beadIds: ["bd-claim"] });
		const rig = harness(["bash", "read", "yield"], false, {
			entries: [{ type: "session_init", agent: "orc-implementer" }],
			systemPrompt: "ORC-ROLE: implementer",
			resolve: spec => (spec === "@task" ? expected : undefined),
			current: () => current,
		});
		registerWatchers(rig.pi, claims);
		expect(await rig.fire("tool_call", { toolName: "bash", input: {} })).toEqual([undefined]);
		expect(assignmentNotices(rig)).toEqual([]);

		current = { provider: "test-provider", id: "other-model" };
		for (const toolName of ["read", "bash", "yield"]) {
			expect(await rig.fire("tool_call", { toolName, input: {} })).toEqual([undefined]);
		}
		const notices = assignmentNotices(rig);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("orc-implementer");
		expect(notices[0]).toContain("expected model test-provider/task-model (from @task)");
		expect(notices[0]).toContain("live model test-provider/other-model");
		expect(notices[0]).toContain("`bd comment bd-claim 'BLOCKED model mismatch: expected test-provider/task-model, live test-provider/other-model'` then `bd update bd-claim --status blocked`");
		expect(rig.failures).toEqual([]);
	});

	test("a role marker mismatch is a notice too, with a placeholder when no claim is known", async () => {
		const expected = { provider: "test-provider", id: "task-model" };
		const rig = harness(["read", "yield"], false, {
			entries: [{ type: "session_init", agent: "orc-reviewer" }],
			systemPrompt: "ORC-ROLE: implementer",
			resolve: spec => (spec === "@reviewer" ? expected : undefined),
			current: () => expected,
		});
		registerWatchers(rig.pi);
		expect(await rig.fire("tool_call", { toolName: "read", input: {} })).toEqual([undefined]);
		expect(await rig.fire("tool_call", { toolName: "read", input: {} })).toEqual([undefined]);
		const notices = assignmentNotices(rig);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("expected ORC-ROLE reviewer, actual implementer");
		expect(notices[0]).toContain("`bd comment <claimed-id> 'BLOCKED assignment mismatch:");
	});

	test("a fallback OMP applied is accepted for the rest of the session", async () => {
		const expected = { provider: "test-provider", id: "task-model" };
		const fallback = { provider: "other-provider", id: "fallback-model" };
		let current: unknown = expected;
		const rig = harness(["bash", "yield"], false, {
			entries: [{ type: "session_init", agent: "orc-implementer" }],
			systemPrompt: "ORC-ROLE: implementer",
			resolve: spec => (spec === "@task" ? expected : undefined),
			current: () => current,
		});
		registerWatchers(rig.pi);
		expect(await rig.fire("tool_call", { toolName: "bash", input: {} })).toEqual([undefined]);

		// OMP swaps the model before it emits the event (`turn-recovery.ts`), so the live
		// model at that moment is the fallback it chose.
		current = fallback;
		await rig.fire("retry_fallback_applied", { from: "test-provider/task-model", to: "other-provider/fallback-model", role: "task" });
		expect(await rig.fire("tool_call", { toolName: "bash", input: {} })).toEqual([undefined]);
		expect(await rig.fire("tool_call", { toolName: "yield", input: {} })).toEqual([undefined]);
		expect(assignmentNotices(rig)).toEqual([]);

		// A model nobody sanctioned is still noticed.
		current = { provider: "test-provider", id: "rogue-model" };
		expect(await rig.fire("tool_call", { toolName: "bash", input: {} })).toEqual([undefined]);
		expect(assignmentNotices(rig)).toHaveLength(1);
		expect(assignmentNotices(rig)[0]).toContain("live model test-provider/rogue-model");
	});

	test("unavailable model evidence is logged once and proves nothing", async () => {
		const expected = { provider: "test-provider", id: "task-model" };
		const rig = harness(["read", "yield"], false, {
			entries: [{ type: "session_init", agent: "orc-implementer" }],
			systemPrompt: "ORC-ROLE: implementer",
			resolve: spec => (spec === "@task" ? expected : undefined),
			current: () => {
				throw new Error("model registry unavailable");
			},
		});
		registerWatchers(rig.pi);
		expect(await rig.fire("tool_call", { toolName: "read", input: {} })).toEqual([undefined]);
		expect(await rig.fire("tool_call", { toolName: "read", input: {} })).toEqual([undefined]);
		expect(assignmentNotices(rig)).toEqual([]);
		expect(rig.warnings).toEqual(["orchestrate assignment check skipped: model evidence unavailable"]);
		expect(rig.failures).toEqual([]);
	});

	test("a lead session is never checked", async () => {
		const rig = harness(["bash", "task"], false, {
			entries: [{ type: "session_init", agent: "orc-implementer" }],
			systemPrompt: "ORC-ROLE: implementer",
			resolve: () => ({ provider: "test-provider", id: "task-model" }),
			current: () => ({ provider: "test-provider", id: "other-model" }),
		});
		registerWatchers(rig.pi);
		expect(await rig.fire("tool_call", { toolName: "bash", input: {} })).toEqual([undefined]);
		expect(assignmentNotices(rig)).toEqual([]);
	});

	test("checks marker-only legacy workers without inventing helper identity", async () => {
		const expected = { provider: "test-provider", id: "smol-model" };
		let current = expected;
		const worker = harness(["bash", "yield"], false, {
			entries: [{ type: "session_init", task: "legacy worker" }],
			systemPrompt: "ORC-ROLE: researcher",
			resolve: spec => (spec === "@smol" ? expected : undefined),
			current: () => current,
		});
		registerWatchers(worker.pi);
		expect(await worker.fire("tool_call", { toolName: "bash", input: {} })).toEqual([undefined]);
		current = { provider: "test-provider", id: "wrong" };
		expect(await worker.fire("tool_call", { toolName: "bash", input: {} })).toEqual([undefined]);
		expect(assignmentNotices(worker)[0]).toContain("marker-only (researcher)");

		const helper = harness(["bash", "yield"], false, {
			entries: [{ type: "session_init", task: "helper" }],
			systemPrompt: "ORC-ROLE: helper",
			resolve: () => expected,
			current: () => ({ provider: "test-provider", id: "wrong" }),
		});
		registerWatchers(helper.pi);
		expect(await helper.fire("tool_call", { toolName: "bash", input: {} })).toEqual([undefined]);
		expect(assignmentNotices(helper)).toEqual([]);
	});
});

describe("registerWatchers", () => {
	test("reports an unresolved discovery defect again in the next session", async () => {
		await fakeBd();
		await marked(undefined, "pending");
		const rig = harness(undefined, true);
		await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "empty-agent-fixture", omp: {} }));
		withOmpExtensionRootScope(
			[cwd], "explicit-only",
			() => registerWatchers(rig.pi),
		);
		const warnings = () => rig.messages.filter(message => message.customType === "com.srobroek.omp-orchestrate.agent-preflight");

		await rig.fire("session_start", {});
		await rig.fire("tool_call", { toolName: "task", input: {} });
		expect(warnings()).toHaveLength(1);
		expect(warnings()[0]?.content).toContain("orc-architect");

		await rig.fire("session_shutdown", {});
		await rig.fire("session_start", {});
		await rig.fire("tool_call", { toolName: "task", input: {} });
		expect(warnings()).toHaveLength(2);
		expect(warnings()[1]?.content).toContain("orc-architect");
		await rig.fire("session_shutdown", {});
	});

	test("records an already displayed discovery warning after an epic is bound", async () => {
		await fakeBd();
		await marked(undefined, "pending");
		const rig = harness(undefined, true);
		withOmpExtensionRootScope([cwd], "explicit-only", () => registerWatchers(rig.pi));
		await rig.fire("session_start", {});
		await rig.fire("tool_call", { toolName: "task", input: {} });
		expect(rig.messages.filter(message => message.customType === "com.srobroek.omp-orchestrate.agent-preflight")).toHaveLength(1);
		expect((await bdCalls()).filter(call => call[0] === "comment")).toEqual([]);

		// Binding rewrites the marker in place; the scope memo must see the new epic.
		await marked(undefined, "bd-1");
		await rig.fire("tool_call", { toolName: "task", input: {} });
		await rig.fire("tool_call", { toolName: "task", input: {} });
		const comments = (await bdCalls()).filter(call => call[0] === "comment");
		expect(comments).toHaveLength(1);
		expect(comments[0]?.[1]).toBe("bd-1");
		expect(comments[0]?.[2]).toContain("orc-architect");
		expect(rig.messages.filter(message => message.customType === "com.srobroek.omp-orchestrate.agent-preflight")).toHaveLength(1);
		await rig.fire("session_shutdown", {});
	});

	test("a session with no active run starts silently", async () => {
		// Every lead session in every repository that tracks work in beads used to hear
		// the contract warnings at start, orchestrated or not. The contract governs runs.
		await fakeBd();
		await stubSettings(COMPLIANT_SETTINGS);
		await mkdir(join(cwd, ".beads"), { recursive: true });
		const rig = harness(undefined, true);
		withOmpExtensionRootScope([cwd], "explicit-only", () => registerWatchers(rig.pi));
		await rig.fire("session_start", {});
		expect(rig.messages).toEqual([]);
		await rig.fire("session_shutdown", {});
	});

	test("the settings are read in process, never through a spawned CLI", async () => {
		// `omp config list --json` measured 0.5 s idle and 1-3 s under load, and every
		// `task` dispatch used to pay it to read a session-constant value.
		await fakeBd();
		await stubSettings({ ...COMPLIANT_SETTINGS, "task.agentModelOverrides": {} });
		await mkdir(join(cwd, ".orchestration"), { recursive: true });
		await writeFile(join(cwd, ".orchestration", ".active-run"), JSON.stringify({ schema_version: 1, run_id: "bd-1", beads_dir: join(cwd, ".beads") }));
		const rig = harness(undefined, true);
		const spawn = spyOn(Bun, "spawn");
		try {
			withOmpExtensionRootScope([cwd], "explicit-only", () => registerWatchers(rig.pi));
			await rig.fire("session_start", {});
			await rig.fire("tool_call", { toolName: "task", input: {} });
			await rig.fire("tool_call", { toolName: "task", input: {} });
			expect(settingsReads()).toBeGreaterThanOrEqual(3);
			expect(spawn.mock.calls.map(call => (call[0] as string[])[0]).filter(bin => bin !== process.env.BD_BIN)).toEqual([]);
		} finally {
			spawn.mockRestore();
		}
		await rig.fire("session_shutdown", {});
	});

	test("subscribes nothing before a session starts", async () => {
		const rig = harness();
		registerWatchers(rig.pi);
		expect(rig.channels()).toEqual([]);
		expect(rig.sweeps).toEqual([]);

		await rig.fire("session_start", {});
		expect(rig.channels().sort()).toEqual([
			"lsp:startup",
			"mcp:connection-status",
			"task:subagent:event",
			"task:subagent:progress",
		]);
		expect(rig.sweeps).toHaveLength(1);
	});

	test("repeated starts replace timers and audit subscriptions", async () => {
		await marked(undefined, "pending");
		const rig = harness();
		registerWatchers(rig.pi);
		await rig.fire("session_start", {});
		await rig.fire("session_start", {});
		expect(rig.sweeps).toHaveLength(1);
		await rig.emit("task:subagent:event", {
			...(bashEnd("kid-1") as Record<string, unknown>),
			event: {
				type: "tool_execution_end", toolName: "bash", toolCallId: "call-1",
				args: { command: "bd update bd-7 --status open" },
				result: {}, isError: false,
			},
		});
		const entries = (await readFile(join(cwd, ".orchestration", "audit", "kid-1.bdlog"), "utf8")).trim().split("\n");
		expect(entries.map(entry => JSON.parse(entry).argv)).toEqual(["bd update bd-7 --status open"]);
		await rig.fire("session_shutdown", {});
		expect(rig.sweeps).toEqual([]);
	});

	test("W2 writes the ledger from live bus traffic", async () => {
		await marked(undefined, "pending");
		const rig = harness();
		registerWatchers(rig.pi);
		await rig.fire("session_start", {});

		// Live traffic is start/end pairs, so the ledger is only written when both
		// halves arrive -- exercised here through the real subscription.
		await rig.emit("task:subagent:event", bashStart("kid-1", "bd update bd-7 --status open"));
		await rig.emit("task:subagent:event", bashEnd("kid-1"));
		await rig.emit("task:subagent:event", bashStart("kid-1", "bd show bd-7 --json", "call-2"));
		await rig.emit("task:subagent:event", bashEnd("kid-1", undefined, false, "call-2"));
		await rig.emit("task:subagent:event", bashStart("kid-2", "cd /w && bd comment bd-8 hi"));
		await rig.emit("task:subagent:event", bashEnd("kid-2", { details: {} }, true));
		await rig.emit("task:subagent:event", {
			id: "kid-3",
			event: {
				type: "tool_execution_start",
				toolCallId: "call-1",
				toolName: "bash",
				args: { command: `bd -C ${join(cwd, "sandbox")} create 'scratch' --type task` },
			},
		});
		await rig.emit("task:subagent:event", bashEnd("kid-3"));

		const kid1 = (await readFile(join(cwd, ".orchestration", "audit", "kid-1.bdlog"), "utf8")).trim().split("\n");
		expect(kid1).toHaveLength(1);
		expect(JSON.parse(kid1[0]!)).toEqual({
			ts: expect.any(String),
			child: "kid-1",
			argv: "bd update bd-7 --status open",
			exitCode: 0,
		});

		const kid2 = JSON.parse((await readFile(join(cwd, ".orchestration", "audit", "kid-2.bdlog"), "utf8")).trim());
		expect(kid2).toMatchObject({ child: "kid-2", exitCode: 1 });

		// The sandbox write is kept as provenance and tagged, so a reader counting the
		// run's mutations can skip it.
		const kid3 = JSON.parse((await readFile(join(cwd, ".orchestration", "audit", "kid-3.bdlog"), "utf8")).trim());
		expect(kid3).toMatchObject({ child: "kid-3", store: join(cwd, "sandbox"), foreign_store: true });
		expect(rig.failures).toEqual([]);
	});

	test("W1 comments on the stalled child's bead and raises one error wisp", async () => {
		await fakeBd();
		await marked(undefined, "pending");
		process.env.ORC_TEST_BD_LIST = JSON.stringify([{ id: "bd-7", status: "in_progress", assignee: "kid-1" }]);

		const rig = harness();
		registerWatchers(rig.pi);
		await rig.fire("session_start", {});

		// The live watcher reads `Date.now()`, so the clock is moved rather than waited on.
		setSystemTime(new Date("2026-08-24T00:00:00.000Z"));
		await rig.emit("task:subagent:progress", progress("kid-1"));
		setSystemTime(new Date("2026-08-24T00:20:00.000Z"));
		await rig.sweeps[0]!();

		const calls = await bdCalls();
		const comment = calls.find(argv => argv[0] === "comment");
		expect(comment).toEqual(["comment", "bd-7", "STALL child kid-1 silent 20m on bd-7"]);

		const create = calls.find(argv => argv[0] === "create");
		expect(create).toBeDefined();
		expect(create).toContain("--ephemeral");
		expect(create?.[create.indexOf("--wisp-type") + 1]).toBe("error");
		expect(create?.[create.indexOf("--deps") + 1]).toBe("relates-to:bd-7");

		// No kill, and no second report on the next sweep.
		await rig.sweeps[0]!();
		expect((await bdCalls()).filter(argv => argv[0] === "comment")).toHaveLength(1);
	});

	test("W1 eventually reports stalls beyond the read budget", async () => {
		await fakeBd();
		await marked(undefined, "pending");
		const beads = Array.from({ length: 13 }, (_, i) => ({ id: `bd-${i}`, status: "in_progress", assignee: `kid-${i}` }));
		process.env.ORC_TEST_BD_LIST = JSON.stringify(beads);
		const rig = harness();
		registerWatchers(rig.pi);
		await rig.fire("session_start", {});
		for (const bead of beads) noteProgress({ child: bead.assignee, tokens: 0, output: "", terminal: false }, Date.now() - 20 * MINUTE);
		await rig.sweeps[0]!();
		expect((await bdCalls()).filter(call => call[0] === "comment")).toHaveLength(12);
		await rig.sweeps[0]!();
		expect((await bdCalls()).filter(call => call[0] === "comment").map(call => call[1]).sort()).toEqual(beads.map(bead => bead.id).sort());
	});

	test("W1 retries failed writes without duplicating a successful partial comment", async () => {
		await fakeBd();
		await marked(undefined, "pending");
		process.env.ORC_TEST_BD_LIST = JSON.stringify([{ id: "bd-7", status: "in_progress", assignee: "kid-1" }]);
		const rig = harness();
		registerWatchers(rig.pi);
		await rig.fire("session_start", {});
		noteProgress({ child: "kid-1", tokens: 0, output: "", terminal: false }, Date.now() - 20 * MINUTE);
		process.env.ORC_TEST_BD_FAIL = "comment";
		await rig.sweeps[0]!();
		expect((await bdCalls()).filter(call => call[0] === "create")).toEqual([]);
		process.env.ORC_TEST_BD_FAIL = "create";
		await rig.sweeps[0]!();
		delete process.env.ORC_TEST_BD_FAIL;
		await Promise.all([rig.sweeps[0]!(), rig.sweeps[0]!()]);
		await rig.sweeps[0]!();
		expect((await bdCalls()).filter(call => call[0] === "comment")).toHaveLength(2);
		expect((await bdCalls()).filter(call => call[0] === "create")).toHaveLength(2);
	});

	test("W3 warns on a task spawn without ever blocking it", async () => {
		await fakeBd();
		await mkdir(join(cwd, ".orchestration"), { recursive: true });
		await writeFile(join(cwd, ".orchestration", ".active-run"), JSON.stringify({ schema_version: 1, run_id: "bd-1", beads_dir: join(cwd, ".beads") }));

		const rig = harness();
		registerWatchers(rig.pi);
		await rig.fire("session_start", {});
		await rig.emit("mcp:connection-status", { type: "failed", serverName: "context7", error: "x" });

		expect(await rig.fire("tool_call", { toolName: "task", input: {} })).toEqual([undefined]);
		const warn = (await bdCalls()).find(argv => argv[0] === "comment" && String(argv[2]).startsWith("WARN preflight"));
		expect(warn).toEqual(["comment", "bd-1", "WARN preflight: mcp:context7 degraded"]);

		// Once per interval, and never for a tool it does not observe.
		await rig.fire("tool_call", { toolName: "task", input: {} });
		expect(await rig.fire("tool_call", { toolName: "bash", input: { command: "ls" } })).toEqual([undefined]);
		expect((await bdCalls()).filter(argv => argv[0] === "comment" && String(argv[2]).startsWith("WARN preflight"))).toHaveLength(1);
	});

	test("W3 stays quiet when nothing is degraded", async () => {
		await fakeBd();
		await mkdir(join(cwd, ".orchestration"), { recursive: true });
		await writeFile(join(cwd, ".orchestration", ".active-run"), JSON.stringify({ schema_version: 1, run_id: "bd-1", beads_dir: join(cwd, ".beads") }));

		const rig = harness();
		registerWatchers(rig.pi);
		await rig.fire("session_start", {});
		await rig.fire("tool_call", { toolName: "task", input: {} });
		expect(await bdCalls()).toEqual([]);
	});

	test("W4 stamps every epic of the run and names them in the transcript", async () => {
		await fakeBd();
		process.env.ORC_TEST_BD_LIST = JSON.stringify([
			{ id: "bd-1", status: "in_progress" },
			{ id: "bd-2", parent: "bd-1" },
			{ id: "bd-50", parent: "bd-49" },
		]);
		await mkdir(join(cwd, ".orchestration"), { recursive: true });
		await writeFile(join(cwd, ".orchestration", ".active-run"), JSON.stringify({ schema_version: 1, run_id: "bd-1", beads_dir: join(cwd, ".beads") }));

		const rig = harness(["bash", "read"]);
		registerWatchers(rig.pi);
		await rig.fire("goal_updated", { goal: { id: "g-1", objective: "ship dispatch", status: "active" } });

		const comments = (await bdCalls()).filter(argv => argv[0] === "comment");
		expect(comments).toEqual([
			["comment", "bd-1", "GOAL active: ship dispatch"],
			["comment", "bd-2", "GOAL active: ship dispatch"],
		]);
		expect(rig.messages).toHaveLength(1);
		expect(rig.messages[0]).toMatchObject({ content: "GOAL active stamped on bd-1, bd-2", display: true });

		// Token accounting re-fires `goal_updated` with an unchanged goal; relaying
		// it again would comment on every epic once per turn.
		await rig.fire("goal_updated", { goal: { id: "g-1", objective: "ship dispatch", status: "active" } });
		expect((await bdCalls()).filter(argv => argv[0] === "comment")).toHaveLength(2);

		// A status change is a change, and relays.
		await rig.fire("goal_updated", { goal: { id: "g-1", objective: "ship dispatch", status: "complete" } });
		const after = (await bdCalls()).filter(argv => argv[0] === "comment");
		expect(after).toHaveLength(4);
		expect(after[2]).toEqual(["comment", "bd-1", "GOAL complete: ship dispatch"]);
	});

	test("W4 reaches run epics beyond the default first 50 recipients", async () => {
		await fakeBd();
		process.env.ORC_TEST_BD_LIST = JSON.stringify([
			...Array.from({ length: 50 }, (_, index) => ({ id: `unrelated-${index}`, parent: "other-run" })),
			{ id: "late-run", status: "in_progress" },
			{ id: "late-epic", parent: "late-run" },
		]);
		await mkdir(join(cwd, ".orchestration"), { recursive: true });
		await writeFile(join(cwd, ".orchestration", ".active-run"), JSON.stringify({ schema_version: 1, run_id: "late-run" }));
		const rig = harness(["bash"]);
		registerWatchers(rig.pi);
		await rig.fire("goal_updated", { goal: { id: "g-1", objective: "ship late work", status: "active" } });

		expect((await bdCalls()).filter(argv => argv[0] === "comment")).toEqual([
			["comment", "late-run", "GOAL active: ship late work"],
			["comment", "late-epic", "GOAL active: ship late work"],
		]);
		expect(rig.messages).toEqual([
			expect.objectContaining({ content: "GOAL active stamped on late-run, late-epic" }),
		]);
	});

	test.each([undefined, "pending"])("W4 writes nothing without a bound run (%p)", async runId => {
		await fakeBd();
		process.env.ORC_TEST_BD_LIST = JSON.stringify([{ id: "bd-1" }, { id: "bd-2" }]);
		if (runId !== undefined) {
			await mkdir(join(cwd, ".orchestration"));
			await writeFile(join(cwd, ".orchestration", ".active-run"), JSON.stringify({ schema_version: 1, run_id: runId }));
		}
		const rig = harness(["bash"]);
		registerWatchers(rig.pi);
		await rig.fire("goal_updated", { goal: { id: "g-1", objective: "x", status: "active" } });
		expect(await bdCalls()).toEqual([]);
		expect(rig.messages).toEqual([]);
	});

	test("W4 retries failed reads and partial writes, coalesces concurrent events, and scopes deduplication by run", async () => {
		await fakeBd();
		await mkdir(join(cwd, ".orchestration"));
		const marker = join(cwd, ".orchestration", ".active-run");
		await writeFile(marker, JSON.stringify({ schema_version: 1, run_id: "bd-1", beads_dir: join(cwd, ".beads") }));
		process.env.ORC_TEST_BD_LIST = JSON.stringify([{ id: "bd-1" }, { id: "bd-2", parent: "bd-1" }]);
		const rig = harness(["bash"]);
		registerWatchers(rig.pi);
		const payload = { goal: { id: "g-1", objective: "x", status: "active" } };
		process.env.ORC_TEST_BD_FAIL = "list";
		await rig.fire("goal_updated", payload);
		expect(rig.messages).toEqual([]);
		process.env.ORC_TEST_BD_FAIL = "comment";
		process.env.ORC_TEST_BD_TARGET = "bd-2";
		await rig.fire("goal_updated", payload);
		expect(rig.messages).toEqual([]);
		delete process.env.ORC_TEST_BD_FAIL;
		await Promise.all([rig.fire("goal_updated", payload), rig.fire("goal_updated", payload)]);
		await rig.fire("goal_updated", payload);
		expect((await bdCalls()).filter(call => call[0] === "comment").map(call => call[1])).toEqual(["bd-1", "bd-2", "bd-2"]);
		expect(rig.messages).toHaveLength(1);
		await writeFile(marker, JSON.stringify({ schema_version: 1, run_id: "bd-2" }));
		await rig.fire("goal_updated", payload);
		expect((await bdCalls()).filter(call => call[0] === "comment").map(call => call[1])).toEqual(["bd-1", "bd-2", "bd-2", "bd-2"]);
		expect(rig.messages).toHaveLength(2);
	});

	test("W4 discards an older goal whose lookup finishes after a newer event", async () => {
		await fakeBd();
		await mkdir(join(cwd, ".orchestration"));
		await writeFile(join(cwd, ".orchestration", ".active-run"), JSON.stringify({ schema_version: 1, run_id: "bd-1", beads_dir: join(cwd, ".beads") }));
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<BdBead[]>();
		const lookup = spyOn(bd, "bdList")
			.mockImplementationOnce(() => {
				started.resolve();
				return release.promise;
			})
			.mockResolvedValue([{ id: "bd-1" }]);
		const rig = harness(["bash"]);
		registerWatchers(rig.pi);
		try {
			const old = rig.fire("goal_updated", { goal: { id: "g-1", objective: "old", status: "active" } });
			await started.promise;
			const latest = rig.fire("goal_updated", { goal: { id: "g-1", objective: "new", status: "active" } });
			release.resolve([{ id: "bd-1" }]);
			await Promise.all([old, latest]);
			expect((await bdCalls()).filter(call => call[0] === "comment")).toEqual([
				["comment", "bd-1", "GOAL active: new"],
			]);
		} finally {
			release.resolve([]);
			lookup.mockRestore();
		}
	});

	test("W4 managed sweeps retry after binding and failed writes without another goal event", async () => {
		await fakeBd();
		process.env.ORC_TEST_BD_LIST = JSON.stringify([{ id: "bd-1" }]);
		const rig = harness(["bash"]);
		registerWatchers(rig.pi);
		await rig.fire("session_start", {});
		await rig.fire("goal_updated", { goal: { id: "g-1", objective: "latest", status: "active" } });
		expect(await bdCalls()).toEqual([]);
		await mkdir(join(cwd, ".orchestration"));
		await writeFile(join(cwd, ".orchestration", ".active-run"), JSON.stringify({ schema_version: 1, run_id: "bd-1", beads_dir: join(cwd, ".beads") }));
		process.env.ORC_TEST_BD_FAIL = "comment";
		await rig.sweeps[0]!();
		expect(rig.messages).toEqual([]);
		delete process.env.ORC_TEST_BD_FAIL;
		await rig.sweeps[0]!();
		await rig.sweeps[0]!();
		expect((await bdCalls()).filter(call => call[0] === "comment")).toEqual([
			["comment", "bd-1", "GOAL active: latest"],
			["comment", "bd-1", "GOAL active: latest"],
		]);
		expect(rig.messages).toHaveLength(1);
	});

	test("W4 relays A, B, then A again as three consecutive goal versions", async () => {
		await fakeBd();
		await mkdir(join(cwd, ".orchestration"));
		await writeFile(join(cwd, ".orchestration", ".active-run"), JSON.stringify({ schema_version: 1, run_id: "bd-1", beads_dir: join(cwd, ".beads") }));
		process.env.ORC_TEST_BD_LIST = JSON.stringify([{ id: "bd-1" }]);
		const rig = harness(["bash"]);
		registerWatchers(rig.pi);
		for (const objective of ["A", "B", "A", "A"]) {
			await rig.fire("goal_updated", { goal: { id: "g-1", objective, status: "active" } });
		}
		expect((await bdCalls()).filter(call => call[0] === "comment")).toEqual([
			["comment", "bd-1", "GOAL active: A"],
			["comment", "bd-1", "GOAL active: B"],
			["comment", "bd-1", "GOAL active: A"],
		]);
	});

	test("W4 periodic refresh delivers unchanged goals to newly created run epics only", async () => {
		await fakeBd();
		// The session starts under a marker, so W5 runs too; keep it satisfied so the
		// comments below are W4's alone.
		await stubSettings(COMPLIANT_SETTINGS);
		await mkdir(join(cwd, ".orchestration"));
		await writeFile(join(cwd, ".orchestration", ".active-run"), JSON.stringify({ schema_version: 1, run_id: "bd-1", beads_dir: join(cwd, ".beads") }));
		process.env.ORC_TEST_BD_LIST = JSON.stringify([{ id: "bd-1" }]);
		const rig = harness(["bash"]);
		registerWatchers(rig.pi);
		await rig.fire("session_start", {});
		await rig.fire("goal_updated", { goal: { id: "g-1", objective: "A", status: "active" } });
		process.env.ORC_TEST_BD_LIST = JSON.stringify([
			{ id: "bd-1" }, { id: "bd-2", parent: "bd-1" }, { id: "bd-3", parent: "other-run" },
		]);
		await rig.sweeps[0]!();
		await rig.sweeps[0]!();
		expect((await bdCalls()).filter(call => call[0] === "comment")).toEqual([
			["comment", "bd-1", "GOAL active: A"],
			["comment", "bd-2", "GOAL active: A"],
		]);
	});

	test("W4 clearing a failed goal cancels managed retries", async () => {
		await fakeBd();
		// Complete settings, or the lead's session_start makes the settings preflight warn
		// and the message assertion below would not be W4's alone.
		await stubSettings(COMPLIANT_SETTINGS);
		await mkdir(join(cwd, ".orchestration"));
		await writeFile(join(cwd, ".orchestration", ".active-run"), JSON.stringify({ schema_version: 1, run_id: "bd-1", beads_dir: join(cwd, ".beads") }));
		process.env.ORC_TEST_BD_LIST = JSON.stringify([{ id: "bd-1" }]);
		const rig = harness(["bash"]);
		registerWatchers(rig.pi);
		await rig.fire("session_start", {});
		process.env.ORC_TEST_BD_FAIL = "comment";
		await rig.fire("goal_updated", { goal: { id: "g-1", objective: "cancelled", status: "active" } });
		await rig.fire("goal_updated", { goal: null });
		delete process.env.ORC_TEST_BD_FAIL;
		await rig.sweeps[0]!();
		expect((await bdCalls()).filter(call => call[0] === "comment")).toHaveLength(1);
		expect(rig.messages).toEqual([]);
	});

	test("W4 relays from the lead only, and a cleared goal relays nothing", async () => {
		await fakeBd();
		process.env.ORC_TEST_BD_LIST = JSON.stringify([{ id: "bd-1" }]);

		// `yield` present means this session is a spawned worker.
		const worker = harness(["bash", "yield"]);
		registerWatchers(worker.pi);
		await worker.fire("goal_updated", { goal: { id: "g-1", objective: "x", status: "active" } });
		expect(await bdCalls()).toEqual([]);

		const lead = harness(["bash"]);
		registerWatchers(lead.pi);
		await lead.fire("goal_updated", { goal: null });
		expect(await bdCalls()).toEqual([]);
		expect(lead.messages).toEqual([]);
	});

	test("a watcher failure is logged, never thrown at the session", async () => {
		// bd is gone: every watcher must degrade to silence rather than breaking a
		// `tool_call` handler, which would block the tool it was inspecting.
		process.env.BD_BIN = "definitely-not-a-real-binary-xyz";
		await mkdir(join(cwd, ".orchestration"), { recursive: true });
		await writeFile(join(cwd, ".orchestration", ".active-run"), JSON.stringify({ schema_version: 1, run_id: "bd-1", beads_dir: join(cwd, ".beads") }));

		const rig = harness();
		registerWatchers(rig.pi);
		await rig.fire("session_start", {});
		await rig.emit("lsp:startup", { type: "failed", error: "boom" });

		expect(await rig.fire("tool_call", { toolName: "task", input: {} })).toEqual([undefined]);
		await rig.fire("goal_updated", { goal: { id: "g-1", objective: "x", status: "active" } });
		expect(rig.failures).toEqual([]);
	});
});

describe("W5 settings preflight", () => {
	test("the platform defaults that broke a real run are all reported", () => {
		// Observed live: `merge: patch` + `apply: true` captured no branch at all.
		const found = settingsDeviations({
			"task.isolation.enabled": true,
			"task.isolation.merge": "patch",
			"task.isolation.apply": true,
			"task.enableEffort": true,
		});
		expect(found.map(deviation => deviation.key)).toEqual(["task.isolation.merge", "task.isolation.apply"]);
		expect(found[0]?.consequence).toContain("omp/task/<id>");
	});

	test("the required combination reports nothing", () => {
		expect(
			settingsDeviations({
				"task.isolation.enabled": true,
				"task.isolation.merge": "branch",
				"task.isolation.apply": false,
				"task.enableEffort": true,
				"bash.autoBackground.enabled": false,
			}),
		).toEqual([]);
	});

	test("isolation requires the boolean true, not a truthy value", () => {
		expect(settingsDeviations({ "task.isolation.enabled": true })).toEqual([]);
		for (const enabled of [false, "true", "false", 1, 0, null]) {
			expect(settingsDeviations({ "task.isolation.enabled": enabled }).map(item => item.key)).toEqual([
				"task.isolation.enabled",
			]);
		}
	});

	test.each([true, "false"])("an unsafe automatic background snapshot (%p) warns without changing config", async enabled => {
		await stubSettings({ ...COMPLIANT_SETTINGS, "bash.autoBackground.enabled": enabled });
		await mkdir(join(cwd, ".omp"));
		const file = join(cwd, ".omp", "config.yml");
		const config = "# operator owned\nbash:\n  autoBackground:\n    enabled: true\n";
		await writeFile(file, config);
		const rig = harness();
		const deviations = await preflightSettings(rig.pi, cwd);
		expect(deviations).toMatchObject([{
			key: "bash.autoBackground.enabled",
			want: "false",
			observed: enabled,
		}]);
		expect(String(rig.messages[0]?.content)).toContain("bash.autoBackground.enabled");
		expect(await readFile(file, "utf8")).toBe(config);
	});

	test("a disabled automatic background snapshot satisfies claim observation", async () => {
		await stubSettings({ ...COMPLIANT_SETTINGS, "bash.autoBackground.enabled": false });
		const rig = harness();
		expect(await preflightSettings(rig.pi, cwd)).toEqual([]);
		expect(rig.messages).toEqual([]);
	});

	test("a key the reader did not carry is not a finding", () => {
		// The fail-open rule: what was not read must not manufacture a warning about a
		// setting that may well be correct.
		expect(settingsDeviations({})).toEqual([]);
	});

	test("a string 'false' is not the boolean the runtime honours", () => {
		// The settings layer is typed, so a string here means something upstream
		// stringified it; treating it as satisfied would hide a live misconfiguration.
		expect(settingsDeviations({ "task.isolation.apply": "false" })).toHaveLength(1);
	});

	test("no live settings instance finds nothing, does not throw, and says the check did not run", async () => {
		const rig = harness();
		expect(await preflightSettings(rig.pi, cwd)).toEqual([]);
		expect(String(rig.messages[0]?.content)).toContain("could not be read");
	});

	test("the check runs once per session, once it has run", async () => {
		await stubSettings(COMPLIANT_SETTINGS);
		const rig = harness();
		await preflightSettings(rig.pi, cwd);
		expect(settingsReads()).toBe(1);
		// A second call short-circuits, so a re-fired `session_start` cannot spam the
		// epic with duplicate comments -- and does not read the settings again.
		stubbed = undefined;
		expect(await preflightSettings(rig.pi, cwd)).toEqual([]);
		expect(rig.messages).toEqual([]);
		expect(settingsReads()).toBe(1);
	});

	test("an unreadable host leaves the check pending for the next activation", async () => {
		// Marking the check done on a host where the settings could not be read meant the
		// `/orchestrate-run` hook returned [] forever with no notice.
		const rig = harness();
		expect(await preflightSettings(rig.pi, cwd)).toEqual([]);
		await stubSettings({ ...COMPLIANT_SETTINGS, "task.isolation.merge": "patch" });
		expect((await preflightSettings(rig.pi, cwd)).map(item => item.key)).toEqual(["task.isolation.merge"]);
		expect(rig.messages).toHaveLength(2);
		expect(String(rig.messages[1]?.content)).toContain("task.isolation.merge");
	});
});
