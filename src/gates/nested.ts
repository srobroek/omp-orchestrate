/**
 * G10 — agents are subagents, and credentials never enter a transcript.
 *
 * Measured in the end-to-end campaign (`scratch/audit/e2e/probes.md`; D-normal-py-02,
 * D-normal-ts-04, D-normal-docs-01): the planning reference had the lead start the
 * architect as a second `omp --cwd <worktree>` process, because a `task` child could not be
 * rooted in a Worktrunk tree. The launches died on the operator's `omp` shim and on a
 * `credential_process` that could not detect its shell; architects then ran
 * `isengardcli credentials` by hand and printed live STS credentials into session logs. A
 * nested process claimed with no `BEADS_ACTOR`, so its claim was dead and its receipts
 * never reached the wave barrier.
 *
 * The architect is now an isolated `task` child like every other role (`spawn.ts`), so no
 * session in a run has a reason to start `omp`, and none has a reason to mint or print a
 * credential: the tools a role uses carry the identity they need. Inside a run scope, from
 * a `bash` call, this refuses:
 *
 * - an `omp` invocation: bare, by path (`~/.bun/bin/omp`), through `bunx omp`, `bun x omp`,
 *   `npx omp`, or `mise exec ... -- omp`, past the runner prefixes and wrapper shells
 *   `src/shell.ts` expands. A query that opens no session -- `omp --version`, `omp --help`
 *   and nothing else -- passes from every seat;
 * - a credential helper: `isengardcli credentials`, `aws sts ...`,
 *   `aws configure export-credentials`, and any word naming `credential_process`;
 * - a credential print: a read of `~/.aws/credentials` by any program, `printenv` bare or of
 *   an `AWS_*` name, `env` with nothing to run, and any argument that expands an `AWS_*`
 *   variable (`echo $AWS_SECRET_ACCESS_KEY`).
 *
 * Every seat is held to it, the lead included: the run's landing module reads no
 * credential from a transcript, and a credential in a log is a leak whoever wrote it.
 * Matching is on parsed argv, so a comment or a `grep` operand that mentions `omp` is not
 * an invocation. Nothing here reads bd or spawns a process.
 */

import type { ExtensionContext, ToolCallEventResult } from "@oh-my-pi/pi-coding-agent";
import { orcRole } from "../identity";
import { type RunScope } from "../run-scope";
import { commandInvocations, effectiveSegments, programName, splitFlag } from "../shell";

/** `omp` flags that answer a question and exit, opening no session. */
const OMP_QUERY_FLAGS: Record<string, true> = { "--version": true, "-v": true, "--help": true, "-h": true };

/** Package runners that run a named binary: the word after them is the program. */
const PACKAGE_RUNNERS: readonly (readonly string[])[] = [["bunx"], ["bun", "x"], ["npx"]];

/** `mise` subcommands that run a command after `--`. */
const MISE_EXEC: readonly (readonly string[])[] = [["mise", "exec"], ["mise", "x"]];

/** Credential helpers, as `commandInvocations` matches them. */
const CREDENTIAL_HELPERS: readonly (readonly string[])[] = [
	["isengardcli", "credentials"],
	["aws", "sts"],
	["aws", "configure", "export-credentials"],
];

/** The AWS shared credentials file, however the home directory is spelled. */
const AWS_CREDENTIALS_FILE = /(?:^|\/)\.aws\/credentials$/;

/**
 * The environment names that carry a credential. `AWS_REGION` and `AWS_PROFILE` are
 * configuration and are not matched: a script that echoes its region is not a leak.
 */
const AWS_SECRET_NAME = /^AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN|SECURITY_TOKEN)$/;

/** A word that expands a credential variable: `$AWS_SECRET_ACCESS_KEY`, `"${AWS_SESSION_TOKEN}"`. */
const AWS_SECRET_EXPANSION = /\$\{?(AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN|SECURITY_TOKEN))\b/;

/** A leading `NAME=value` word a shell strips before the program name. */
const ASSIGNMENT_WORD = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Whether an `omp` argv opens a session: anything but a pure version or help query does. */
function ompOpensSession(args: readonly string[]): boolean {
	if (args.length === 0) return true;
	return !args.every(arg => OMP_QUERY_FLAGS[splitFlag(arg).flag] === true);
}

/** The argv `omp` receives from a runner's operands, or `undefined` when the runner runs something else. */
function ompViaRunner(args: readonly string[]): readonly string[] | undefined {
	const program = args.findIndex(arg => !arg.startsWith("-"));
	if (program === -1 || programName(args[program] as string) !== "omp") return undefined;
	return args.slice(program + 1);
}

/** The argv `omp` receives after a `mise exec ... --`, or `undefined` when mise runs something else. */
function ompViaMise(args: readonly string[]): readonly string[] | undefined {
	const separator = args.indexOf("--");
	if (separator === -1 || separator + 1 >= args.length) return undefined;
	if (programName(args[separator + 1] as string) !== "omp") return undefined;
	return args.slice(separator + 2);
}

/** Whether the command line starts an `omp` session, through any spelling this gate reads. */
export function opensOmpSession(command: string): boolean {
	if (commandInvocations(command, ["omp"]).some(invocation => ompOpensSession(invocation.args))) return true;
	for (const runner of PACKAGE_RUNNERS) {
		for (const invocation of commandInvocations(command, runner)) {
			const args = ompViaRunner(invocation.args);
			if (args !== undefined && ompOpensSession(args)) return true;
		}
	}
	for (const exec of MISE_EXEC) {
		for (const invocation of commandInvocations(command, exec)) {
			const args = ompViaMise(invocation.args);
			if (args !== undefined && ompOpensSession(args)) return true;
		}
	}
	return false;
}

/**
 * The credential act a command line performs, named as the refusal quotes it, or
 * `undefined` when it performs none.
 */
export function credentialAct(command: string): string | undefined {
	for (const helper of CREDENTIAL_HELPERS) {
		if (commandInvocations(command, helper).length > 0) return helper.join(" ");
	}
	// `aws configure set|get credential_process ...` wires or reveals the helper the SDK runs.
	if (commandInvocations(command, ["aws", "configure"]).some(invocation => invocation.args.includes("credential_process"))) {
		return "aws configure credential_process";
	}
	for (const segment of effectiveSegments(command)) {
		let index = 0;
		while (index < segment.length && ASSIGNMENT_WORD.test(segment[index] as string)) index += 1;
		const head = segment[index];
		if (head === undefined) continue;
		const program = programName(head);
		const operands = segment.slice(index + 1);
		if (program === "printenv") {
			if (operands.length === 0) return "printenv";
			const secret = operands.find(operand => AWS_SECRET_NAME.test(operand));
			if (secret !== undefined) return `printenv ${secret}`;
		}
		// `env` with nothing to run prints the environment; with a program it is a runner.
		if (program === "env" && operands.every(operand => operand.startsWith("-"))) return "env";
		for (const word of segment) {
			if (AWS_CREDENTIALS_FILE.test(word)) return `a read of ${word}`;
			const expansion = AWS_SECRET_EXPANSION.exec(word);
			if (expansion !== null) return `an expansion of $${expansion[1]}`;
		}
	}
	return undefined;
}

/**
 * Refuse an `omp` launch or a credential act from any session of an active run.
 * `scope` is the run the caller already resolved; the gate reads nothing else.
 */
export function gateNestedInvocation(ctx: ExtensionContext, scope: RunScope, input: Record<string, unknown>): ToolCallEventResult | undefined {
	const command = input.command;
	if (typeof command !== "string" || command.length === 0) return undefined;

	const act = credentialAct(command);
	if (act !== undefined) {
		return {
			block: true,
			reason: `${act} is refused inside run ${scope.runId}: it mints or prints a credential into a session transcript. No role reads, exports or prints AWS credentials; the run's tools carry the identity they need`,
		};
	}
	if (opensOmpSession(command)) return nestedOmpRefusal(ctx, scope);
	return undefined;
}

function nestedOmpRefusal(ctx: ExtensionContext, scope: RunScope): ToolCallEventResult {
	const seat = orcRole(ctx) ?? "a session";
	return {
		block: true,
		reason: `omp is refused for ${seat} inside run ${scope.runId}: agents are subagents, and the lead spawns roles with task (isolated: true). A nested omp process has no parent link: its claims are dead claims, its receipts never reach the wave barrier, and stopping and restarting it replays the same failure`,
	};
}

/** Refuse the same nested process policy when a structured hub call starts it. */
export function gateNestedHubInvocation(
	ctx: ExtensionContext,
	scope: RunScope,
	input: Record<string, unknown>,
): ToolCallEventResult | undefined {
	if (input.op !== "start" || !Array.isArray(input.args) || !input.args.every(value => typeof value === "string")) return undefined;
	const args = input.args as string[];
	const application = typeof input.application === "string" ? programName(input.application) : "";
	if (application === "omp") return ompOpensSession(args) ? nestedOmpRefusal(ctx, scope) : undefined;
	if (application !== "sh" && application !== "bash" && application !== "zsh") return undefined;
	const commandIndex = args.findIndex(token => token === "-c" || token === "--command");
	const command = commandIndex >= 0 ? args[commandIndex + 1] : undefined;
	return typeof command === "string" ? gateNestedInvocation(ctx, scope, { command }) : undefined;
}