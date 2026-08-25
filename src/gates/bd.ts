/**
 * G6 — bd call discipline: the identity, the comment verb, the bug route.
 *
 * TTSR rules, converted. Each was advisory because a regex over a command string cannot
 * see whether a run is active and cannot parse a shell line. The verb condition ran from
 * `comment` to any later quote, so a grep for the literal text nagged every turn. A
 * parser-backed check earns what a regex could not be trusted with, and reading the run
 * marker is what keeps it off every other session.
 *
 * None of the three blocks. Each returns a sentence the entry point sends with
 * `pi.sendMessage`, and the command runs. `ToolCallEventResult` carries no advisory
 * shape, but `pi` is in scope inside the handler, so a notice needs no new return
 * channel.
 *
 * A pin check (`-C <run repo>` required on every call) existed here and was removed:
 * this project runs a per-project Dolt server, where bd resolves the database by host
 * and port from `.beads/dolt-server.port`, which travels with a copied checkout. The
 * embedded walk-up-from-cwd hazard the check guarded against does not exist under a
 * server, so the block refused correct commands while citing a mechanism that did not
 * apply. `-C` remains legal and harmless; it is simply not demanded.
 *
 * Nothing here fires outside an active run: `readActiveRun` is the whole discriminator,
 * and a plain session in this repository sees no gate at all. That is the defect the
 * conversion exists to fix — a rule condition matched every session that mentioned `bd`.
 *
 * Each check is pure and takes the parsed invocation, so the shell parsing stays at the
 * entry point and the predicates are testable without a tool event. A check that cannot
 * decide returns `undefined`: a comment body arriving through `--file`, a metadata
 * payload arriving through `@file.json`, a first token the shell has yet to expand. A
 * throwing handler blocks the tool it was inspecting (`src/index.ts:49-52`), so silence
 * is the only safe answer to a shape this gate does not understand.
 */

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ToolCallEventResult } from "@oh-my-pi/pi-coding-agent";
import { commentVerb } from "../bd";
import grammar from "../contracts/grammar.json";
import { legacyRoleFromLabel, ROUTING_KEY } from "../identity";
import { readActiveRun } from "../run-state";
import { type BdInvocation, bdInvocations } from "../shell";

/** One finding on one parsed invocation: what to say, or `undefined` for silence. */
export type BdCheck = (invocation: BdInvocation, runRepo: string | undefined) => string | undefined;

export const BD_NOTICE_MESSAGE = "com.srobroek.omp-orchestrate.bd-notice";

/**
 * The verb set, read from the file that leads it.
 *
 * `=== true` on the lookup, because the token compared against it is agent-written text:
 * a comment reading `constructor something` would otherwise resolve through
 * `Object.prototype` and pass as a declared verb.
 */
const DECLARED_VERBS: Record<string, true> = Object.fromEntries(grammar.verbs.map(entry => [entry.verb, true]));

/** The declared verbs as a notice quotes them, built once. */
const VERB_LIST = grammar.verbs.map(entry => entry.verb).join(" ");

/**
 * A flag token split into its name and its inline `=` operand.
 *
 * A copy of the module-private helper in `./claim`, deliberately: exporting one would
 * widen a just-landed public surface, and consolidating the pair is worth doing on its
 * own rather than inside this conversion.
 */
function splitFlag(token: string): { flag: string; inline?: string } {
	if (!token.startsWith("-")) return { flag: token };
	const cut = token.indexOf("=");
	if (cut === -1) return { flag: token };
	return { flag: token.slice(0, cut), inline: token.slice(cut + 1) };
}

/** A flag and its operand, as written, so a message can quote the spelling it names. */
interface FlagOperand {
	flag: string;
	value: string;
}

/**
 * Every operand carried by any of `names`, in either spelling, in order.
 *
 * All of them rather than the first, because `--labels` is repeatable and a route may
 * ride the second copy. A following token that itself starts with `-` is another flag,
 * never this one's operand: `--parent --silent` names no parent.
 */
function flagOperands(rest: readonly string[], names: Record<string, true>): FlagOperand[] {
	const found: FlagOperand[] = [];
	for (let index = 0; index < rest.length; index++) {
		const { flag, inline } = splitFlag(rest[index] as string);
		if (names[flag] !== true) continue;
		const value = inline ?? rest[index + 1];
		if (typeof value !== "string" || value.length === 0) continue;
		if (inline === undefined && value.startsWith("-")) continue;
		found.push({ flag, value });
	}
	return found;
}


/** One `bd` operation, with the `comments add` long form folded onto `comment`. */
interface BdOperation {
	name: string;
	/** Positionals after the subcommand, with the `add` operand stripped. */
	operands: readonly string[];
}

/**
 * The operation an invocation performs.
 *
 * `bd comment <id> "text"` is bd's own shorthand for `bd comments add <id> "text"`
 * (verified: `bd comment --help`). Folding them keeps one check per operation — a guard a
 * documented alias walks past is decoration. The deleted rules matched `comment` alone.
 */
function operation(invocation: BdInvocation): BdOperation {
	if (invocation.subcommand === "comments" && invocation.positionals[0] === "add") {
		return { name: "comment", operands: invocation.positionals.slice(1) };
	}
	return { name: invocation.subcommand, operands: invocation.positionals };
}


/** Subcommands that write a bead, verbatim from the deleted rule's condition. */
const MUTATING_SUBCOMMANDS: Record<string, true> = {
	create: true,
	update: true,
	close: true,
	comment: true,
	dep: true,
	label: true,
	gate: true,
	"merge-slot": true,
	"set-state": true,
	audit: true,
};

/** The identity carriers, either of which attributes the write. */
const ACTOR_VARS = ["BEADS_ACTOR", "BD_ACTOR"] as const;

/**
 * Notice: a mutation that records no actor.
 *
 * Advisory rather than blocking, because the write itself is correct and only its
 * provenance degrades. Refusing a correct write over an audit field is disproportionate.
 *
 * Either variable satisfies it, as the deleted condition's lookahead did. The `--actor`
 * flag deliberately does not: the dispatch contract mandates the environment prefix on
 * every mutating process, and `./claim` reads the environment to record a claim for the
 * worktree gate, so a flag-only identity would leave that gate blind.
 *
 * An assignment with an empty value is no identity. The regex silently agreed by
 * accident — it required `\w+=\S+` and so never matched `BEADS_ACTOR= bd ...` at all.
 */
export const actorNotice: BdCheck = invocation => {
	const { name } = operation(invocation);
	if (MUTATING_SUBCOMMANDS[name] !== true) return undefined;
	if (ACTOR_VARS.some(variable => (invocation.assignments.get(variable) ?? "").length > 0)) return undefined;
	return (
		`WARN bd identity: 'bd ${name}' carries neither BEADS_ACTOR nor BD_ACTOR, so the write lands ` +
		`attributed to nobody. Prefix the command with both, set to the claimed bead's metadata.actor: ` +
		`'BEADS_ACTOR=<actor> BD_ACTOR=<actor> bd ${name} ...'.`
	);
};

/** Flags that carry the comment body off the command line, where no check can read it. */
const OFFLINE_BODY_FLAGS: Record<string, true> = { "--file": true, "--stdin": true };

/**
 * Notice: a comment whose first token is not a protocol verb.
 *
 * Calls `commentVerb` rather than restating its normalisation, which collapses the old
 * guard-mirrors-parser invariant into an identity: one implementation, so the guard and
 * the exit contract can no longer disagree about what a comment says.
 *
 * Advisory, and the notice states the cost, because the cost is delayed and invisible:
 * supervision reads an unparseable first token as an unsatisfied contract and bounces the
 * worker at exit, long after the comment landed.
 */
export const commentVerbNotice: BdCheck = invocation => {
	const { name, operands } = operation(invocation);
	if (name !== "comment") return undefined;
	// `--file` and `--stdin` read the body elsewhere (verified: `bd comment --help`), so
	// there is no first token on this line to judge.
	if (invocation.rest.some(token => OFFLINE_BODY_FLAGS[splitFlag(token).flag] === true)) return undefined;
	const text = operands[1];
	if (text === undefined) return undefined;

	const verb = commentVerb(text);
	if (DECLARED_VERBS[verb] === true) return undefined;
	// A body the shell has yet to assemble names no verb until it runs, and `src/shell.ts`
	// expands nothing by design. Nagging what cannot be read would nag correct work.
	if (verb.includes("$")) return undefined;

	return (
		`WARN comment verb: 'bd comment ${operands[0] ?? ""}' leads with '${verb}', which no protocol verb ` +
		`matches, so supervision reads your contract as unsatisfied and bounces you at exit over something ` +
		`this comment never showed you. Rewrite it now, leading with one of: ${VERB_LIST}. Case is free and ` +
		`decoration is normalised, but the first whitespace token is the whole signal, so 'NO WORK' parses ` +
		`as 'NO' and the underscored NO_WORK is the verb.`
	);
};

const TYPE_FLAGS: Record<string, true> = { "--type": true, "-t": true };
const PARENT_FLAGS: Record<string, true> = { "--parent": true };
const METADATA_FLAGS: Record<string, true> = { "--metadata": true, "--set-metadata": true };
/** Verified against the installed `bd`: `create` spells its label flag `-l, --labels`. */
const LABEL_FLAGS: Record<string, true> = { "--labels": true, "-l": true };

/** Whether a `--metadata` JSON object routes: a `role` key carrying a non-empty role. */
function jsonCarriesRole(value: string): boolean {
	if (!value.trimStart().startsWith("{")) return false;
	try {
		const parsed: unknown = JSON.parse(value);
		// Own-property test: `JSON.parse` output inherits `Object.prototype`, so a payload
		// carrying no `role` key must read as carrying none.
		if (parsed === null || typeof parsed !== "object" || !Object.hasOwn(parsed, ROUTING_KEY)) return false;
		const role = (parsed as Record<string, unknown>)[ROUTING_KEY];
		return typeof role === "string" && role.length > 0;
	} catch {
		// Unparseable JSON is no route this gate can attribute, and `bd` rejects it too.
		return false;
	}
}

/**
 * Whether this `create` names a role route, or `undefined` when that is unreadable.
 *
 * Three carriers. `metadata.role` as `key=value`, `metadata.role` inside a `--metadata`
 * JSON object, and a legacy `agent:<role>` label, which still routes while in-flight runs
 * drain. `role_hint` is not a route: the key is compared exactly, never matched as text.
 *
 * `undefined` for `--metadata @file.json`, which puts the payload in a file this gate does
 * not open. Guessing there would nag a bead that is routed.
 */
function routesToRole(rest: readonly string[]): boolean | undefined {
	for (const { value } of flagOperands(rest, METADATA_FLAGS)) {
		if (value.startsWith("@")) return undefined;
		// `key=value` before the JSON shape: a JSON payload can carry `=` inside a value,
		// so the key comparison has to fail before the shape test runs.
		const cut = value.indexOf("=");
		if (cut !== -1 && value.slice(0, cut) === ROUTING_KEY && value.length > cut + 1) return true;
		if (jsonCarriesRole(value)) return true;
	}
	for (const { value } of flagOperands(rest, LABEL_FLAGS)) {
		// `--labels` is comma-joined, and the suffix resolves through the same alias table
		// the bead resolver uses, so one legacy spelling cannot route here and nowhere else.
		if (value.split(",").some(label => legacyRoleFromLabel(label.trim()) !== undefined)) return true;
	}
	return false;
}

/**
 * Notice: a bug bead no queue can reach.
 *
 * Advisory, and the notice names who pays, because the filer does not: the bead lands,
 * and the close-out gate faults it as stranded on a later session.
 */
export const bugRouteNotice: BdCheck = invocation => {
	if (operation(invocation).name !== "create") return undefined;
	const type = flagOperands(invocation.rest, TYPE_FLAGS)[0];
	if (type?.value !== "bug") return undefined;

	const parented = flagOperands(invocation.rest, PARENT_FLAGS).length > 0;
	const routed = routesToRole(invocation.rest);
	if (routed === undefined) return undefined;
	if (parented && routed) return undefined;

	const missing = [
		parented ? undefined : "--parent <epic>",
		routed ? undefined : `--metadata '{"${ROUTING_KEY}":"<role>"}'`,
	].filter((flag): flag is string => flag !== undefined);
	return (
		`WARN bug bead: '${type.flag} ${type.value}' with no ${missing.join(" and no ")}, so the bead lands ` +
		`where no queue can reach it -- 'bd ready --parent <epic> --metadata-field ${ROUTING_KEY}=<role> ` +
		`--unassigned' is how a worker finds it, and the close-out gate faults it as stranded on a later ` +
		`session rather than on yours. Add ${missing.join(" and ")}: the epic you work under, and the role ` +
		`that would fix it, with the assignee left empty.`
	);
};

/**
 * The advisory checks, in the order their notices read best: identity, then the comment
 * body, then the shape of a filed bead.
 */
const NOTICES: readonly BdCheck[] = [actorNotice, commentVerbNotice, bugRouteNotice];

/**
 * Refuse a `bd` call this run cannot see; warn about one it cannot attribute, cannot read,
 * or cannot route.
 *
 * Parses before reading the marker, because most `bash` calls name no `bd` at all and a
 * file read for each of those buys nothing. The marker then gates all four checks: outside
 * a run this returns `undefined` before any of them is consulted.
 *
 * The refusal is decided across every invocation before any notice is collected. A notice
 * about a command that will not run is noise.
 *
 * `deliverAs: "steer"` is chosen from the handler's timing, not from tidiness. This runs
 * mid-turn, before the tool result exists, so the session is streaming and
 * `sendCustomMessage` will "queue as steer/follow-up or store for next turn"
 * (`session/agent-session.d.ts:585-598`). A steer is consumed at the next model call in
 * the SAME turn — the request that carries this tool's result — which is where TTSR put
 * its own non-interrupting tool reminder, in-band on that result. `nextTurn` would hold
 * the notice until a turn that a worker about to yield may never take, and `followUp`
 * would force a fresh turn after the agent stopped. Verified end to end against a live
 * session: the notice text came back quoted by the model in the same turn as the command.
 *
 * `attribution: "user"` for the same reason the dispatch contract uses it: any other value
 * normalises to `"agent"`, and a nag that reads as the model talking to itself is a nag it
 * may discount. This is the extension's voice, which is what WARN means in the grammar.
 */
export async function gateBdDiscipline(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	input: Record<string, unknown>,
): Promise<ToolCallEventResult | undefined> {
	const command = input.command;
	if (typeof command !== "string" || command.length === 0) return undefined;

	const invocations = bdInvocations(command);
	if (invocations.length === 0) return undefined;

	// `.catch`, as `src/index.ts` does at the same call: an unreadable marker is not a run.
	const run = await readActiveRun(ctx.cwd).catch(() => null);
	if (run === null) return undefined;


	const notices: string[] = [];
	for (const invocation of invocations) {
		for (const notice of NOTICES) {
			const text = notice(invocation, run.repo_root);
			// Deduped: a chain of three unattributed mutations says it once.
			if (text !== undefined && !notices.includes(text)) notices.push(text);
		}
	}
	if (notices.length > 0) {
		pi.sendMessage(
			{
				customType: BD_NOTICE_MESSAGE,
				content: notices.join("\n"),
				display: true,
				attribution: "user",
			},
			{ deliverAs: "steer" },
		);
	}
	return undefined;
}
