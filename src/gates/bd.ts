/**
 * G6 — bd call discipline: the identity, the comment verb, the bug route.
 *
 * TTSR rules, converted. Each was advisory because a regex over a command string cannot
 * see whether a run is active and cannot parse a shell line. The verb condition ran from
 * `comment` to any later quote, so a grep for the literal text nagged every turn. A
 * parser-backed check earns what a regex could not be trusted with, and reading the run
 * marker is what keeps it off every other session.
 *
 * None of the three notices blocks. A single unattributed mutation may instead return a rewritten
 * input when a run-scoped actor is known; otherwise the notice leaves through `pi.sendMessage`
 * and the command runs. `ToolCallEventResult` carries no advisory shape, but `pi` is in scope
 * inside the handler, so a notice needs no new return channel.
 *
 * A pin check (`-C <run repo>` required on every call) existed here and was removed:
 * the run pins BEADS_DIR instead, which every child inherits, so bd reads the run's
 * database without a per-call flag. The walk-up-from-cwd hazard the check guarded against
 * is closed at the environment rather than at each call site. It does not exist under a
 * server, so the block refused correct commands while citing a mechanism that did not
 * apply. `-C` remains legal and harmless; it is simply not demanded.
 *
 * Nothing here fires outside a pinned run: `pinnedRunActive` — the process pin plus a
 * valid marker in the session checkout or the pinned repository — is the whole
 * discriminator, and a plain session in this repository sees no gate at all. That is the
 * defect the conversion exists to fix — a rule condition matched every session that
 * mentioned `bd`.
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
import { bdShow, commentVerb, metadataRecord } from "../bd";
import type { ClaimState } from "../claim-state";
import grammar from "../contracts/grammar.json";
import { legacyRoleFromLabel, ROUTING_KEY } from "../identity";
import { BD_VALUE_FLAGS, type BdInvocation, BEAD_ID, bdInvocations } from "../shell";
import { pinnedRunActive } from "./readonly";

/** Shell metacharacters that make a command unsafe to rewrite as one invocation. */
const REWRITE_METACHARACTERS = /[;&|`\n]/;

/** Optional plain shell assignments followed directly by the `bd` executable. */
const SINGLE_BD_COMMAND = /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|[^\s;&|`]*)\s+)*bd(?:\s|$)/;

/**
 * Process-wide seam owned by the beads actor gate. G6 claims a tool-call id only after
 * delivering its richer run-scoped actor notice; the beads tool_result adapter consumes
 * that id and omits its generic advisory. A missing registry keeps G6's historical fallback.
 */
export const ACTOR_NOTICE_ARBITER = Symbol.for(
	"com.srobroek.beads.actor-notice-arbiter.v1",
);

interface ActorNoticeArbiter {
	handledToolCalls: Set<string>;
}

/** Read the beads-owned registry without creating one; installation proves the adapter exists. */
function actorNoticeArbiter(): ActorNoticeArbiter | undefined {
	const candidate: unknown = Reflect.get(globalThis, ACTOR_NOTICE_ARBITER);
	if (
		candidate === null ||
		typeof candidate !== "object" ||
		!("handledToolCalls" in candidate)
	) {
		return undefined;
	}
	const handledToolCalls = candidate.handledToolCalls;
	return handledToolCalls instanceof Set ? { handledToolCalls } : undefined;
}

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

/** Flags proven not to consume a following token; unknown flags fail closed as value-taking. */
const BOOLEAN_FLAGS: Record<string, true> = {
	"--claim": true,
	"--claim-next": true,
	"--continue": true,
	"--ephemeral": true,
	"--force": true,
	"--global": true,
	"--ignore-schema-skew": true,
	"--json": true,
	"--no-auto": true,
	"--quiet": true,
	"--readonly": true,
	"--sandbox": true,
	"--silent": true,
	"--suggest-next": true,
	"--unassigned": true,
	"--verbose": true,
};


/** Grouped subcommands whose first positional selects a read. */
const GROUP_READ_ACTIONS: Record<string, Record<string, true>> = {
	audit: { list: true, show: true },
	comments: { list: true, show: true },
	dep: { cycles: true, list: true, tree: true },
	epic: { status: true },
	formula: { list: true, show: true },
	gate: { discover: true, list: true, show: true },
	kv: { get: true, list: true },
	label: { list: true, "list-all": true, show: true },
	"merge-slot": { check: true },
	mol: {
		current: true,
		"last-activity": true,
		list: true,
		progress: true,
		ready: true,
		seed: true,
		show: true,
		stale: true,
	},
	swarm: { list: true, status: true, validate: true },
	todo: { list: true },
};

/** Grouped subcommands whose first positional selects a write. */
const GROUP_WRITE_ACTIONS: Record<string, Record<string, true>> = {
	audit: { label: true, record: true },
	comments: { add: true },
	dep: { add: true, relate: true, remove: true, unrelate: true },
	epic: { "close-eligible": true },
	formula: { convert: true },
	gate: { "add-waiter": true, check: true, create: true, resolve: true },
	kv: { append: true, clear: true, delete: true, rm: true, set: true, update: true },
	label: { add: true, propagate: true, remove: true },
	mol: { bond: true, burn: true, distill: true, pour: true, squash: true },
	"merge-slot": { acquire: true, create: true, release: true },
	swarm: { create: true },
	todo: { add: true, done: true },
};

const MOL_WISP_READS: Record<string, true> = { list: true };
const MOL_WISP_WRITES: Record<string, true> = { create: true, gc: true };

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
 * `bd ready --claim` is the one write deliberately exempt. A queue pull names no bead, so
 * it precedes the identity it would have to carry: the assignee its report prints is the
 * identity every later write attributes to (`src/claim-observer.ts`). Nagging it would nag
 * the protocol's first command. A claim that names its bead is not exempt: `bd show`
 * yields the bead's `metadata.actor`, which seeds that first claim.
 */
export function writesBeads(invocation: BdInvocation): boolean {
	let hasHelp = false;
	let hasDryRun = false;
	let hasBlocks = false;
	let skipValue = false;
	for (const token of invocation.rest) {
		if (token === "--") break;
		if (skipValue) {
			skipValue = false;
			continue;
		}
		const { flag, inline } = splitFlag(token);
		if (BD_VALUE_FLAGS[flag] === true) {
			skipValue = inline === undefined;
			continue;
		}
		if (token === "--help" || token === "-h") hasHelp = true;
		else if (token === "--dry-run") hasDryRun = true;
		else if (token === "--blocks") hasBlocks = true;
		else if (inline === undefined && token.startsWith("-") && BOOLEAN_FLAGS[flag] !== true) skipValue = true;
	}
	if (hasHelp) return false;
	if (invocation.hasClaim) return invocation.subcommand !== "ready";

	const { subcommand } = invocation;
	if (subcommand === "duplicates") {
		return invocation.rest.includes("--auto-merge") && !invocation.rest.includes("--dry-run");
	}
	// A bare `bd`, or a first positional that is really a redirection: both print help.
	if (!SUBCOMMAND.test(subcommand)) return false;
	if (ADMIN_SUBCOMMANDS[subcommand] === true) return false;

	const action = invocation.positionals[0] ?? "";
	// Every non-`add` positional is an issue ID in `bd comments <issue-id>`.
	if (subcommand === "comments") return action === "add";
	if (subcommand === "mol" && action === "wisp") {
		// Dry-run is inherited by proto creation, `create`, and `gc`; all are previews.
		if (hasDryRun) return false;
		const wispAction = invocation.positionals[1];
		if (wispAction !== undefined && MOL_WISP_READS[wispAction] === true) return false;
		if (wispAction !== undefined && MOL_WISP_WRITES[wispAction] === true) return true;
		return true;
	}
	if (subcommand === "mol" && action === "pour" && hasDryRun) return false;
	if (subcommand === "dep" && hasBlocks) return true;
	if (GROUP_WRITE_ACTIONS[subcommand]?.[action] === true) return true;
	if (GROUP_READ_ACTIONS[subcommand]?.[action] === true) return false;
	if ((GROUP_READ_ACTIONS[subcommand] !== undefined || GROUP_WRITE_ACTIONS[subcommand] !== undefined) && action === "") {
		return false;
	}
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
/** Whether this raw command is safe to rewrite as one direct `bd` invocation. */
function isSingleBdCommand(command: string): boolean {
 return !REWRITE_METACHARACTERS.test(command) && SINGLE_BD_COMMAND.test(command);
}

/** Quote an actor only when shell syntax requires it. */
function shellActor(actor: string): string {
 if (/^[A-Za-z0-9_./:@-]+$/.test(actor)) return actor;
 return `'${actor.replaceAll("'", "'\\''")}'`;
}

/** Resolve the best actor available before falling back to the existing warning. */
async function resolvedActor(
 invocation: BdInvocation,
 input: Record<string, unknown>,
 claims: ClaimState | undefined,
): Promise<string | undefined> {
 if (invocationCarriesActor(invocation, input.env)) return undefined;
 const observed = claims?.observedClaim()?.actor;
 if (typeof observed === "string" && observed.length > 0) return observed;
 if (!invocation.hasClaim || invocation.subcommand === "ready") return undefined;
 const target = invocation.positionals[0];
 if (target === undefined || !BEAD_ID.test(target)) return undefined;
 const bead = await bdShow(target);
 const metadata = metadataRecord(bead?.metadata);
 const actor = metadata?.actor;
 return typeof actor === "string" && actor.length > 0 ? actor : undefined;
}

function invocationCarriesActor(
	invocation: BdInvocation,
	env: unknown,
): boolean {
	if (ACTOR_VARS.some(variable => (invocation.assignments.get(variable) ?? "").length > 0)) {
		return true;
	}
	return envCarriesActor(env);
}

export const actorNotice: BdCheck = (invocation, env) => {
	if (!writesBeads(invocation)) return undefined;
	if (invocationCarriesActor(invocation, env)) return undefined;

	const { name } = operation(invocation);
	const written = invocation.hasClaim ? `${name} --claim` : name;
	return (
		`WARN bd identity: 'bd ${written}' carries neither BEADS_ACTOR nor BD_ACTOR, so the write lands ` +
		`attributed to nobody. Prefix the command with either variable, set to the assignee your claim report printed: ` +
		`'BEADS_ACTOR=<assignee> bd ${name} ...'.`
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

/** The advisory checks, in the order their notices read best. */
const NOTICES: readonly BdCheck[] = [actorNotice, commentVerbNotice, bugRouteNotice];

/**
 * Warn about a `bd` call this run cannot attribute, cannot read, or cannot route.
 */
export async function gateBdDiscipline(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	input: Record<string, unknown>,
	toolCallId: string,
	claims?: ClaimState,
): Promise<ToolCallEventResult | undefined> {
	const command = input.command;
	if (typeof command !== "string" || command.length === 0) return undefined;

	const invocations = bdInvocations(command);
	if (invocations.length === 0) return undefined;

	if (!(await pinnedRunActive(ctx.cwd))) return undefined;

	const arbiter = actorNoticeArbiter();
	if (invocations.length === 1 && isSingleBdCommand(command)) {
		const invocation = invocations[0] as BdInvocation;
		if (writesBeads(invocation) && !invocationCarriesActor(invocation, input.env)) {
			const actor = await resolvedActor(invocation, input, claims);
			if (actor !== undefined && !invocation.assignments.has("BEADS_ACTOR") && !invocation.assignments.has("BD_ACTOR")) {
				arbiter?.handledToolCalls.add(toolCallId);
				return {
					input: {
						...input,
						command: `BEADS_ACTOR=${shellActor(actor)} BD_ACTOR=${shellActor(actor)} ${command}`,
					},
				};
			}
		}
	}

	const beadsWillBlockClaim = arbiter !== undefined && invocations.some(
		invocation =>
			(invocation.subcommand === "claim" || invocation.hasClaim) &&
			!invocationCarriesActor(invocation, input.env),
	);
	const notices: string[] = [];
	let deliveredActorNotice = false;
	for (const invocation of invocations) {
		for (const notice of NOTICES) {
			if (notice === actorNotice && beadsWillBlockClaim) continue;
			const text = notice(invocation, input.env);
			if (text === undefined || notices.includes(text)) continue;
			notices.push(text);
			if (notice === actorNotice) deliveredActorNotice = true;
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
		if (deliveredActorNotice) arbiter?.handledToolCalls.add(toolCallId);
	}
	return undefined;
}
