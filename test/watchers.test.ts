import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { chmod, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { BdBead } from "../src/bd";
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
	DECLARED_MODEL_ROLES,
	preflightSettings,
	registerWatchers,
	resetWatchers,
	settingsDeviations,
	runEpics,
	setAuditDir,
	stallMinutes,
	sweepStalls,
} from "../src/watchers";
import declaredSurface from "./declared-surface.json";

const MINUTE = 60_000;

let cwd: string;

const ENV_KEYS = ["ORC_STALL_MINUTES", "BD_BIN", "ORC_TEST_BD_LOG", "ORC_TEST_BD_LIST"] as const;

beforeEach(async () => {
	cwd = join(tmpdir(), `orc-watchers-${Math.random().toString(36).slice(2)}`);
	await mkdir(cwd, { recursive: true });
	for (const key of ENV_KEYS) delete process.env[key];
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

describe("bdMutationEvent", () => {
	test("a start alone records nothing; the end completes it", () => {
		// The regression this pins: the command lives on the start, the status on the
		// end, so only the pair is a ledger line. Reading one event was silently a
		// no-op for an entire live run.
		expect(bdMutationEvent(bashStart("kid-1", "bd update bd-7 --claim"))).toBeUndefined();
		expect(bdMutationEvent(bashEnd("kid-1"))).toEqual({
			child: "kid-1",
			command: "bd update bd-7 --claim",
			exitCode: 0,
		});
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
		expect(bdMutationEvent(bashEndWithArgs("kid-7", "bd update orc-9 --claim"))).toEqual({
			child: "kid-7",
			command: "bd update orc-9 --claim",
			exitCode: 0,
		});
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

/**
 * The precondition that outranks the settings block: isolation working correctly is
 * exactly what splits the beads database, so a run with perfect settings can still
 * lose every claim. Verified against a real checkout copy, where a bead created in
 * the copy is invisible in the original.
 */
describe("W5 shared-database precondition", () => {
	/**
	 * Stub the settings CLI. Without it these tests read whatever this host is
	 * configured for -- which passed locally and failed on a CI runner that has no
	 * `omp` at all, where every key reads as unknown and the check correctly stays
	 * quiet. The precondition under test is the database, so isolation is pinned on.
	 */
	async function stubOmp(mode: string): Promise<void> {
		const bin = join(cwd, "fake-omp");
		await writeFile(
			bin,
			`#!/bin/sh\nif [ "$3" = "task.isolation.mode" ]; then printf '{"key":"task.isolation.mode","value":"${mode}"}'; else exit 1; fi\n`,
			{ mode: 0o755 },
		);
		process.env.OMP_BIN = bin;
	}

	afterEach(() => {
		delete process.env.BEADS_DOLT_SHARED_SERVER;
		delete process.env.OMP_BIN;
	});

	test("a repo-local database under isolation is reported even with clean settings", async () => {
		// The default `bd init` layout: a `.beads` directory with no shared-server
		// marker in either carrier.
		await stubOmp("worktree");
		await mkdir(join(cwd, ".beads"), { recursive: true });
		const rig = harness();
		resetWatchers();
		await preflightSettings(rig.pi, cwd);
		const notice = String(rig.messages.at(-1)?.content ?? "");
		expect(notice).toContain("per-checkout database");
		expect(notice).toContain("two workers can hold one bead");
		// The pin is no longer offered as a remedy: this project requires a per-project
		// Dolt server, and `-C` buys nothing under one. The env var is deliberately NOT
		// offered alone either: with `metadata.json` still pinning embedded, bd announces
		// it is using the shared server and then fails with `database not found`.
		expect(notice).toContain("per-project Dolt server");
		expect(notice).toContain("bd init --server");
		expect(notice).toContain("bd backup restore");
		expect(notice).not.toContain("bd -C");
		expect(notice).not.toContain("Set BEADS_DOLT_SHARED_SERVER=1");
	});

	test("a repository with no beads database says nothing", async () => {
		// Observed in the field: this warning fired in a repository that had never run
		// `bd init`, where there are no claims to split and the advice was
		// unactionable. The precondition applies to runs that track work in beads.
		await stubOmp("worktree");
		const rig = harness();
		resetWatchers();
		await preflightSettings(rig.pi, cwd);
		expect(rig.messages.map(message => String(message.content)).join("\n")).not.toContain("per-checkout database");
	});

	/**
	 * `DECLARED_MODEL_ROLES` names roles OMP does not ship. An unconfigured alias resolves
	 * to undefined with no warning and falls back to the session default, so the whole
	 * value of declaring one is that its absence is announced.
	 */
	async function stubOmpRoles(roles: string | undefined): Promise<void> {
		const bin = join(cwd, "fake-omp-roles");
		// `roles === undefined` leaves the key unreadable, which is a different state from
		// an empty object: unreadable proves nothing, empty proves the role is absent.
		const branch =
			roles === undefined
				? "exit 1"
				: `printf '{"key":"modelRoles","value":${roles.replace(/'/g, "'\\''")}}'`;
		await writeFile(
			bin,
			`#!/bin/sh\nif [ "$3" = "modelRoles" ]; then ${branch}; else exit 1; fi\n`,
			{ mode: 0o755 },
		);
		process.env.OMP_BIN = bin;
	}

	test.each([
		["an empty roles object", "{}", true],
		["roles that omit it", '{"plan":"x/y:high","task":"x/y:auto"}', true],
		["roles that configure it", '{"reviewer":"mantle/openai.gpt-5.6-sol:medium"}', false],
	])("a declared model role missing from %s warns=%p", async (_label, roles, wantWarning) => {
		await stubOmpRoles(roles);
		const rig = harness();
		resetWatchers();
		await preflightSettings(rig.pi, cwd);
		const notice = rig.messages.map(message => String(message.content)).join("\n");
		expect(notice.includes("modelRoles.reviewer is not configured")).toBe(wantWarning);
	});

	test("an unreadable roles setting says nothing, since it proves nothing", async () => {
		// This function's rule is to warn only about what it can prove. A setting that did
		// not answer is not evidence the role is absent.
		await stubOmpRoles(undefined);
		const rig = harness();
		resetWatchers();
		await preflightSettings(rig.pi, cwd);
		expect(rig.messages.map(message => String(message.content)).join("\n")).not.toContain(
			"modelRoles.reviewer",
		);
	});

	test("the declared list matches the one the suite asserts against", () => {
		// Two carriers, one truth: src announces an absent role, the manifest is what
		// test/agents.test.ts accepts as a non-built-in alias. Drift would let an agent
		// name a role nothing announces.
		expect([...DECLARED_MODEL_ROLES]).toEqual(declaredSurface.modelRoles.roles);
	});

	test("the flat dotted key bd actually writes silences it", async () => {
		// Verbatim from a scratch `bd init --shared-server`: a flat `dolt.shared-server`
		// key, not the nested block a reader might assume.
		await stubOmp("worktree");
		await mkdir(join(cwd, ".beads"), { recursive: true });
		await writeFile(join(cwd, ".beads", "config.yaml"), "dolt.shared-server: true\n");
		const rig = harness();
		resetWatchers();
		await preflightSettings(rig.pi, cwd);
		expect(rig.messages.map(message => String(message.content)).join("\n")).not.toContain("per-checkout database");
	});

	test("server mode declared only in metadata.json silences it", async () => {
		// `bd init --server` sets the metadata field without the config key, and a
		// client that resolves a host and port cannot be redirected by a file copy.
		// Reading only config.yaml would nag a correctly configured project forever.
		await stubOmp("worktree");
		await mkdir(join(cwd, ".beads"), { recursive: true });
		await writeFile(
			join(cwd, ".beads", "metadata.json"),
			JSON.stringify({ backend: "dolt", dolt_mode: "server", dolt_database: "proj" }),
		);
		const rig = harness();
		resetWatchers();
		await preflightSettings(rig.pi, cwd);
		expect(rig.messages.map(message => String(message.content)).join("\n")).not.toContain("per-checkout database");
	});

	test("metadata pinning embedded still reports", async () => {
		// The default `bd init` layout, which is exactly the case that loses claims.
		await stubOmp("worktree");
		await mkdir(join(cwd, ".beads"), { recursive: true });
		await writeFile(
			join(cwd, ".beads", "metadata.json"),
			JSON.stringify({ backend: "dolt", dolt_mode: "embedded", dolt_database: "proj" }),
		);
		const rig = harness();
		resetWatchers();
		await preflightSettings(rig.pi, cwd);
		expect(String(rig.messages.at(-1)?.content ?? "")).toContain("per-checkout database");
	});

	test("a malformed metadata file proves nothing and still reports", async () => {
		await stubOmp("worktree");
		await mkdir(join(cwd, ".beads"), { recursive: true });
		await writeFile(join(cwd, ".beads", "metadata.json"), "{ not json");
		const rig = harness();
		resetWatchers();
		await preflightSettings(rig.pi, cwd);
		expect(String(rig.messages.at(-1)?.content ?? "")).toContain("per-checkout database");
	});

	test("shared-server mode via the environment silences it", async () => {
		await stubOmp("worktree");
		process.env.BEADS_DOLT_SHARED_SERVER = "1";
		const rig = harness();
		resetWatchers();
		await preflightSettings(rig.pi, cwd);
		expect(rig.messages.map(message => String(message.content)).join("\n")).not.toContain("per-checkout database");
	});

	test("shared-server mode declared in the beads config silences it", async () => {
		await stubOmp("worktree");
		await mkdir(join(cwd, ".beads"), { recursive: true });
		await writeFile(join(cwd, ".beads", "config.yaml"), "dolt:\n  shared-server: true\n");
		const rig = harness();
		resetWatchers();
		await preflightSettings(rig.pi, cwd);
		expect(rig.messages.map(message => String(message.content)).join("\n")).not.toContain("per-checkout database");
	});

	test("the commented-out default does not read as enabled", async () => {
		// `bd init` ships every key commented; treating that as configured would hide
		// the failure on exactly the layout that has it.
		await stubOmp("worktree");
		await mkdir(join(cwd, ".beads"), { recursive: true });
		await writeFile(join(cwd, ".beads", "config.yaml"), "# dolt:\n#   shared-server: true\n");
		const rig = harness();
		resetWatchers();
		await preflightSettings(rig.pi, cwd);
		expect(String(rig.messages.at(-1)?.content ?? "")).toContain("per-checkout database");
	});

	test("an unreadable isolation mode warns about nothing", async () => {
		// `omp` absent: nothing is known, so nothing is claimed. Reading a missing key
		// as "isolating" would warn about a split database on a run with no isolation.
		process.env.OMP_BIN = "definitely-not-a-real-omp-xyz";
		const rig = harness();
		resetWatchers();
		await preflightSettings(rig.pi, cwd);
		expect(rig.messages).toEqual([]);
	});

	test("isolation explicitly off warns about nothing", async () => {
		await stubOmp("none");

		const rig = harness();
		resetWatchers();
		await preflightSettings(rig.pi, cwd);
		// A run without isolation shares one checkout, so it shares one database.
		expect(String(rig.messages.at(-1)?.content ?? "")).not.toContain("per-checkout database");
	});
});

/**
 * Prerequisites are ensured, not merely named: the deviating project-ownable settings
 * are written into the run repository's own `.omp/config.yml`, because the global
 * config differs per machine and a run can start on any of them. Settings load at
 * process start, so the write repairs the next session and the message says restart.
 */
describe("the settings preflight writes the project config", () => {
	async function stubDeviantOmp(): Promise<void> {
		const bin = join(cwd, "fake-omp-deviant");
		await writeFile(
			bin,
			[
				"#!/bin/sh",
				'case "$3" in',
				'  task.isolation.mode) printf \'{"key":"k","value":"worktree"}\';;',
				'  task.isolation.merge) printf \'{"key":"k","value":"patch"}\';;',
				'  task.isolation.apply) printf \'{"key":"k","value":true}\';;',
				'  task.enableEffort) printf \'{"key":"k","value":false}\';;',
				'  task.maxRecursionDepth) printf \'{"key":"k","value":2}\';;',
				"  *) exit 1;;",
				"esac",
			].join("\n"),
			{ mode: 0o755 },
		);
		process.env.OMP_BIN = bin;
	}

	const configFile = () => join(cwd, ".omp", "config.yml");

	afterEach(async () => {
		delete process.env.OMP_BIN;
		await rm(join(cwd, ".omp"), { recursive: true, force: true });
	});

	test("deviating ownable settings land in .omp/config.yml, and the message says restart", async () => {
		await stubDeviantOmp();
		const rig = harness();
		resetWatchers();
		await preflightSettings(rig.pi, cwd);

		const written = Bun.YAML.parse(await readFile(configFile(), "utf8")) as {
			task: { isolation: { merge: string; apply: boolean }; enableEffort: boolean; maxRecursionDepth: number };
		};
		expect(written.task.isolation.merge).toBe("branch");
		expect(written.task.isolation.apply).toBe(false);
		expect(written.task.enableEffort).toBe(true);
		expect(written.task.maxRecursionDepth).toBe(3);

		const notice = String(rig.messages.at(-1)?.content ?? "");
		expect(notice).toContain("task.maxRecursionDepth is 2");
		expect(notice).toContain("written to");
		expect(notice).toContain("Restart the run");
	});

	test("an existing config keeps its unrelated keys", async () => {
		await stubDeviantOmp();
		await mkdir(join(cwd, ".omp"), { recursive: true });
		await writeFile(configFile(), 'task:\n  agentModelOverrides:\n    operator: "@smol"\n');
		const rig = harness();
		resetWatchers();
		await preflightSettings(rig.pi, cwd);

		const written = Bun.YAML.parse(await readFile(configFile(), "utf8")) as {
			task: { agentModelOverrides: { operator: string }; isolation: { merge: string } };
		};
		expect(written.task.agentModelOverrides.operator).toBe("@smol");
		expect(written.task.isolation.merge).toBe("branch");
	});

	test("a file that does not parse is left alone", async () => {
		// Rewriting a file we cannot read destroys whatever it held, so the preflight
		// falls back to the warn-only tail.
		await stubDeviantOmp();
		await mkdir(join(cwd, ".omp"), { recursive: true });
		const broken = "task: [unclosed\n";
		await writeFile(configFile(), broken);
		const rig = harness();
		resetWatchers();
		await preflightSettings(rig.pi, cwd);

		expect(await readFile(configFile(), "utf8")).toBe(broken);
		const notice = String(rig.messages.at(-1)?.content ?? "");
		expect(notice).toContain("Fix and restart the run");
	});

	test("clean settings write nothing", async () => {
		const bin = join(cwd, "fake-omp-clean");
		await writeFile(
			bin,
			[
				"#!/bin/sh",
				'case "$3" in',
				'  task.isolation.mode) printf \'{"key":"k","value":"worktree"}\';;',
				'  task.isolation.merge) printf \'{"key":"k","value":"branch"}\';;',
				'  task.isolation.apply) printf \'{"key":"k","value":false}\';;',
				'  task.enableEffort) printf \'{"key":"k","value":true}\';;',
				'  task.maxRecursionDepth) printf \'{"key":"k","value":3}\';;',
				"  *) exit 1;;",
				"esac",
			].join("\n"),
			{ mode: 0o755 },
		);
		process.env.OMP_BIN = bin;
		const rig = harness();
		resetWatchers();
		await preflightSettings(rig.pi, cwd);
		expect(await readFile(configFile(), "utf8").catch(() => "absent")).toBe("absent");
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

	test("defaults under the session cwd and honours the override", () => {
		expect(auditDir("/repo")).toBe(join("/repo", ".orchestration", "audit"));
		setAuditDir("/artifacts/run-7/audit");
		expect(auditDir("/repo")).toBe("/artifacts/run-7/audit");
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

	test("flags a silent child exactly once", () => {
		note("kid-1", 0);
		expect(sweepStalls(11 * MINUTE, 10 * MINUTE)).toEqual([{ child: "kid-1", silentMinutes: 11 }]);
		// A second sweep must not write a second comment on the same bead.
		expect(sweepStalls(30 * MINUTE, 10 * MINUTE)).toEqual([]);
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

	test("an unbound marker reaches every open epic", () => {
		expect(runEpics(epics, undefined).map(epic => epic.id)).toEqual(["bd-1", "bd-2", "bd-3", "bd-9"]);
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
			"#!/bin/sh",
			'{ printf ">>>\\n"; for arg in "$@"; do printf "%s\\n" "$arg"; done; } >> "$ORC_TEST_BD_LOG"',
			'if [ "$1" = "list" ]; then printf "%s" "$ORC_TEST_BD_LIST"; fi',
			"exit 0",
		].join("\n"),
		"utf8",
	);
	await chmod(bin, 0o755);
	process.env.BD_BIN = bin;
	process.env.ORC_TEST_BD_LOG = join(cwd, "bd.log");
	process.env.ORC_TEST_BD_LIST = "[]";
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
}

function harness(tools: string[] = ["bash", "read", "task"]): Harness {
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const listeners = new Map<string, Array<(data: unknown) => unknown>>();
	const sweeps: Array<() => unknown> = [];
	const messages: Array<Record<string, unknown>> = [];
	const failures: string[] = [];

	const ctx = {
		cwd,
		setInterval: (callback: () => unknown) => {
			sweeps.push(callback);
			return 0;
		},
		setTimeout: (callback: () => unknown) => {
			sweeps.push(callback);
			return 0;
		},
		clearTimer: () => {},
	};

	const pi = {
		getAllTools: () => tools.map(name => ({ name, description: "" })),
		logger: { error: (message: string) => failures.push(message) },
		events: {
			on: (channel: string, handler: (data: unknown) => unknown) => {
				const list = listeners.get(channel) ?? [];
				list.push(handler);
				listeners.set(channel, list);
				return () => {};
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
	};
}

describe("registerWatchers", () => {
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

	test("W2 writes the ledger from live bus traffic", async () => {
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

		const kid1 = (await readFile(join(cwd, ".orchestration", "audit", "kid-1.bdlog"), "utf8")).trim().split("\n");
		expect(kid1).toHaveLength(1);
		expect(JSON.parse(kid1[0]!)).toMatchObject({
			child: "kid-1",
			argv: "bd update bd-7 --status open",
			exitCode: 0,
		});
		expect(typeof JSON.parse(kid1[0]!).ts).toBe("string");

		const kid2 = JSON.parse((await readFile(join(cwd, ".orchestration", "audit", "kid-2.bdlog"), "utf8")).trim());
		expect(kid2).toMatchObject({ child: "kid-2", exitCode: 1 });
		expect(rig.failures).toEqual([]);
	});

	test("W1 comments on the stalled child's bead and raises one error wisp", async () => {
		await fakeBd();
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

	test("W3 warns on a task spawn without ever blocking it", async () => {
		await fakeBd();
		await mkdir(join(cwd, ".orchestration"), { recursive: true });
		await writeFile(join(cwd, ".orchestration", ".active-run"), JSON.stringify({ schema_version: 1, run_id: "bd-1" }));

		const rig = harness();
		registerWatchers(rig.pi);
		await rig.fire("session_start", {});
		await rig.emit("mcp:connection-status", { type: "failed", serverName: "context7", error: "x" });

		expect(await rig.fire("tool_call", { toolName: "task", input: {} })).toEqual([undefined]);
		const warn = (await bdCalls()).find(argv => argv[0] === "comment");
		expect(warn).toEqual(["comment", "bd-1", "WARN preflight: mcp:context7 degraded"]);

		// Once per interval, and never for a tool it does not observe.
		await rig.fire("tool_call", { toolName: "task", input: {} });
		expect(await rig.fire("tool_call", { toolName: "bash", input: { command: "ls" } })).toEqual([undefined]);
		expect((await bdCalls()).filter(argv => argv[0] === "comment")).toHaveLength(1);
	});

	test("W3 stays quiet when nothing is degraded", async () => {
		await fakeBd();
		await mkdir(join(cwd, ".orchestration"), { recursive: true });
		await writeFile(join(cwd, ".orchestration", ".active-run"), JSON.stringify({ schema_version: 1, run_id: "bd-1" }));

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
		await writeFile(join(cwd, ".orchestration", ".active-run"), JSON.stringify({ schema_version: 1, run_id: "bd-1" }));

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
		await writeFile(join(cwd, ".orchestration", ".active-run"), JSON.stringify({ schema_version: 1, run_id: "bd-1" }));

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
			"task.isolation.mode": "auto",
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
				"task.isolation.mode": "worktree",
				"task.isolation.merge": "branch",
				"task.isolation.apply": false,
				"task.enableEffort": true,
			}),
		).toEqual([]);
	});

	test("isolation mode rejects only none", () => {
		for (const mode of ["auto", "worktree", "apfs", "fuse"]) {
			expect(settingsDeviations({ "task.isolation.mode": mode })).toEqual([]);
		}
		expect(settingsDeviations({ "task.isolation.mode": "none" })).toHaveLength(1);
	});

	test("an unreadable setting is not a finding", () => {
		// The whole point of the fail-open rule: a CLI that could not answer must not
		// manufacture a warning about a setting that may well be correct.
		expect(settingsDeviations({})).toEqual([]);
	});

	test("a string 'false' is not the boolean the runtime honours", () => {
		// The settings layer is typed, so a string here means something upstream
		// stringified it; treating it as satisfied would hide a live misconfiguration.
		expect(settingsDeviations({ "task.isolation.apply": "false" })).toHaveLength(1);
	});

	test("a missing omp binary reports nothing and does not throw", async () => {
		process.env.OMP_BIN = "definitely-not-a-real-omp-xyz";
		const rig = harness();
		expect(await preflightSettings(rig.pi, cwd)).toEqual([]);
		delete process.env.OMP_BIN;
	});

	test("the check runs once per session", async () => {
		process.env.OMP_BIN = "definitely-not-a-real-omp-xyz";
		const rig = harness();
		await preflightSettings(rig.pi, cwd);
		// A second call short-circuits, so a re-fired `session_start` cannot spam the
		// epic with duplicate comments.
		expect(await preflightSettings(rig.pi, cwd)).toEqual([]);
		delete process.env.OMP_BIN;
	});
});
