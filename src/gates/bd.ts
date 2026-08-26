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
 * the run pins BEADS_DIR instead, which every child inherits, so bd reads the run's
 * database without a per-call flag. The walk-up-from-cwd hazard the check guarded against
 * is closed at the environment rather than at each call site. It does not exist under a
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
import { type BdInvocation, BEAD_ID, bdInvocations } from "../shell";

/**
 * One finding on one parsed invocation: what to say, or `undefined` for silence.
 *
 * `env` is the `bash` call's own `env` parameter, unvalidated as the tool delivers it. It
 * reaches every command in the call, so a check that reads inline assignments has to read
 * it too or it nags the tool's documented way of setting a variable.
 */
export type BdCheck = (invocation: BdInvocation, env?: unknown) => string | undefined;

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


/**
 * Subcommands that exited 0 under `BD_READONLY=1`, so bd itself does not count them as
 * writes. `context` is included on its help text alone: it cannot reach the read-only
 * check from a scratch database, refusing first with `cannot resolve repo context`.
 */
const READ_SUBCOMMANDS: Record<string, true> = {
	blocked: true,
	children: true,
	comments: true,
	context: true,
	count: true,
	doctor: true,
	export: true,
	graph: true,
	history: true,
	info: true,
	lint: true,
	list: true,
	memories: true,
	ping: true,
	preflight: true,
	prime: true,
	query: true,
	ready: true,
	recall: true,
	search: true,
	show: true,
	stale: true,
	status: true,
	statuses: true,
	types: true,
	version: true,
	where: true,
};

/**
 * Subcommands that administer the workspace or the database rather than authoring a
 * bead. They are exempt because attribution has nothing to attach to: `bd init` creates
 * the store, `bd dolt push` moves commits under the caller's git identity, and `bd setup`
 * writes editor integration files. Naming an actor on them would nag setup steps in the
 * name of an audit trail they never touch.
 *
 * Found by scoring this classification against 4,673 recorded commands: an earlier
 * revision flagged `bd init`, `bd setup`, `bd bootstrap`, `bd dolt`, and `bd help`.
 */
const ADMIN_SUBCOMMANDS: Record<string, true> = {
	admin: true,
	backup: true,
	bootstrap: true,
	"codex-hook": true,
	compact: true,
	completion: true,
	config: true,
	dolt: true,
	flatten: true,
	gc: true,
	help: true,
	hooks: true,
	human: true,
	init: true,
	migrate: true,
	onboard: true,
	prune: true,
	purge: true,
	quickstart: true,
	"recompute-blocked": true,
	"rename-prefix": true,
	restore: true,
	setup: true,
	sql: true,
	upgrade: true,
	vc: true,
	worktree: true,
};

/**
 * A real subcommand is a lowercase word. The tokeniser expands no redirections, so
 * `bd 2>&1 | head` presents `2>&1` as its first positional -- that command prints help,
 * and reading the artefact as an unrecognised write would nag it.
 */
const SUBCOMMAND = /^[a-z][a-z0-9-]*$/;

/**
 * Read actions of the grouped subcommands, matched on the token after the group:
 * `gate list`, `dep tree`, `kv get`, `label list`, `epic list`, `swarm status`.
 */
const READ_ACTIONS: Record<string, true> = {
	get: true,
	list: true,
	show: true,
	status: true,
	tree: true,
};

/**
 * Write actions of the grouped subcommands. These outrank the exemption table, because a
 * group can read by default and still carry a writing action: `comments` alone prints an
 * issue's comments and exits 0 under `BD_READONLY=1`, while `comments add` refuses.
 * `gate create`, `dep add`, `kv set`, and `label add` were each confirmed to refuse the
 * same way.
 */
const WRITE_ACTIONS: Record<string, true> = {
	add: true,
	append: true,
	claim: true,
	close: true,
	create: true,
	delete: true,
	edit: true,
	release: true,
	remove: true,
	resolve: true,
	rm: true,
	set: true,
	update: true,
};

/** The identity carriers, either of which attributes the write. */
const ACTOR_VARS = ["BEADS_ACTOR", "BD_ACTOR"] as const;

/**
 * Whether this invocation writes to the bead store.
 *
 * Unrecognised is a write, because the alternative is a list of writing subcommands that
 * drifts every time bd grows one: the deleted rule's condition named ten, and `bd assign`,
 * `bd reopen`, `bd tag`, `bd link`, and `bd promote` all walked past it. What bd itself
 * refuses under `BD_READONLY=1` is the exemption table instead, so the classification
 * tracks the tool rather than a copy of it.
 *
 * `bd ready --claim` is the one write deliberately exempt. Dispatch writes `metadata.actor`
 * onto the bead and every agent body reads it back from there (`src/supervision.ts`), so a
 * queue pull -- which names no bead -- precedes the identity it would have to carry.
 * Nagging it would nag the protocol's first command. A claim that names its bead is not
 * exempt: `bd show` yields `metadata.actor` before the claim.
 */
function writesBeads(invocation: BdInvocation): boolean {
	if (invocation.hasClaim) return invocation.subcommand !== "ready";

	const { subcommand } = invocation;
	// A bare `bd`, or a first positional that is really a redirection: both print help.
	if (!SUBCOMMAND.test(subcommand)) return false;
	if (ADMIN_SUBCOMMANDS[subcommand] === true) return false;

	const action = invocation.positionals[0] ?? "";
	if (WRITE_ACTIONS[action] === true) return true;
	if (READ_ACTIONS[action] === true) return false;
	return READ_SUBCOMMANDS[subcommand] !== true;
}

/**
 * Whether the `bash` call's own `env` names an actor.
 *
 * `env` reaches every command in the call, so attribution set there satisfies the
 * contract as fully as an inline assignment. Without this the notice would nag the tool's
 * own documented way of setting a variable.
 */
function envCarriesActor(env: unknown): boolean {
	if (env === null || typeof env !== "object") return false;
	const record = env as Record<string, unknown>;
	return ACTOR_VARS.some(variable => {
		const value = record[variable];
		return typeof value === "string" && value.length > 0;
	});
}

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
 * accident -- it required `\w+=\S+` and so never matched `BEADS_ACTOR= bd ...` at all.
 */
export const actorNotice: BdCheck = (invocation, env) => {
	if (!writesBeads(invocation)) return undefined;
	if (ACTOR_VARS.some(variable => (invocation.assignments.get(variable) ?? "").length > 0)) return undefined;
	if (envCarriesActor(env)) return undefined;

	const { name } = operation(invocation);
	const written = invocation.hasClaim ? `${name} --claim` : name;
	return (
		`WARN bd identity: 'bd ${written}' carries neither BEADS_ACTOR nor BD_ACTOR, so the write lands ` +
		`attributed to nobody. Prefix the command with both, set to the claimed bead's metadata.actor: ` +
		`'BEADS_ACTOR=<actor> BD_ACTOR=<actor> bd ${name} ...'.`
	);
};

/**
 * A token the tokeniser produced that a shell would not hand `bd` as a body.
 *
 * Redirections are the case that matters: `src/shell.ts` expands none of them, so
 * `bd comment list <id> 2>&1 | sed ...` presents `2>` where a body would sit. Reading that
 * as a body would nag a command that never carried one.
 */
const REDIRECTION = /^\d*(?:>>?|<)/;

/**
 * A token in the body position that is really a flag, so the body is elsewhere:
 * `--file`, `--stdin`, `-f`, `--json`.
 *
 * A flag shape rather than a leading `-`, because `commentVerb` normalises markdown and
 * `- REVIEW approved` is a body this check must still read. A flag carries no whitespace;
 * a bulleted body does.
 */
const BODY_FLAG = /^--?[A-Za-z]\S*$/;

/**
 * An unexpanded expansion, matched against the first token alone. `bd comment <id>
 * "$SUMMARY"` names no verb until a shell runs, but a body whose *later* words carry a `$`
 * still opens with a word this check can read -- so testing the whole body would excuse
 * `"Wired $X into $Y"`, which is exactly the narration being named.
 */
const EXPANSION = /[$`]/;

/**
 * A body that is nothing but a backticked run: `bd comment <id> "`summarise`"`, which a
 * shell expands before bd sees it.
 *
 * Tested on the raw body rather than on the verb, because `commentVerb` normalises a
 * leading tick as markdown decoration -- deliberately, so `` `REVIEW` approved `` is
 * judged. A code span used that way carries text after the closing tick; a substitution is
 * the whole body, and that is the difference this draws.
 */
const SUBSTITUTION = /^`[^`]*`$/;

/** The comment body this invocation carries, with the bead id it is written on. */
interface CommentBody {
	id: string;
	text: string;
}

/**
 * The comment body on this command line, or `undefined` when it is not on it at all.
 *
 * bd 1.1.2 has no `-m`/`--body`/`--message` on either spelling: `bd comment <id> [text...]`
 * and `bd comments add [id] [text]` take the body positionally, and otherwise from
 * `--file`/`-f`/`--stdin`. So the body is the token immediately after the bead id -- and a
 * flag in that position means the body is elsewhere, which covers the file and stdin forms
 * without naming them, and covers `bd comment list <id>` too: a read whose next token is a
 * redirection carries no body at all.
 *
 * Adjacency is recovered by consuming `positionals` in order while walking `rest`, the way
 * `src/gates/one-claim.ts` recovers it: a token `parseBdInvocation` did not count as an
 * operand is a token this walk does not match.
 */
function commentBody(invocation: BdInvocation): CommentBody | undefined {
	const operands = invocation.positionals;
	let next = 0;

	for (let index = 0; index < invocation.rest.length; index++) {
		const token = invocation.rest[index] as string;
		if (next >= operands.length || token !== operands[next]) continue;
		next += 1;
		if (!BEAD_ID.test(token)) continue;

		// The very next token, not the next operand: a flag here means `--file`, `--stdin`,
		// or `--json` took the position a body would have held.
		const text = invocation.rest[index + 1];
		if (text === undefined || BODY_FLAG.test(text) || REDIRECTION.test(text)) return undefined;
		return { id: token, text };
	}

	return undefined;
}

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
	if (operation(invocation).name !== "comment") return undefined;
	const body = commentBody(invocation);
	if (body === undefined || SUBSTITUTION.test(body.text.trim())) return undefined;

	const verb = commentVerb(body.text);
	if (DECLARED_VERBS[verb] === true) return undefined;
	// A body the shell has yet to assemble names no verb until it runs, and `src/shell.ts`
	// expands nothing by design. Nagging what cannot be read would nag correct work.
	if (EXPANSION.test(verb)) return undefined;

	return (
		`WARN comment verb: 'bd comment ${body.id}' leads with '${verb}', which no protocol verb ` +
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
 * Warn about a `bd` call this run cannot attribute, cannot read, or cannot route.
 *
 * Parses before reading the marker, because most `bash` calls name no `bd` at all and a
 * file read for each of those buys nothing. The marker then gates all three checks:
 * outside a run this returns `undefined` before any of them is consulted.
 *
 * The return value is always `undefined`: nothing here refuses, so the notices leave
 * through `pi.sendMessage` and the command runs. It stays in the refusal position in
 * `src/index.ts` so a check that later has to refuse cannot land after G5 recorded a
 * claim.
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
			const text = notice(invocation, input.env);
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
