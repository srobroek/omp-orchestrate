/**
 * G6 — actor attribution on bead writes.
 *
 * The worker contract requires `BEADS_ACTOR` and `BD_ACTOR` on "every mutating bd
 * process" (`contract.ts:44`). Every worker in a run shares one git identity, so
 * without the assignment bd attributes the write to `git user.name` and the audit
 * trail cannot say which role acted.
 *
 * This replaces the `orc-bd-actor-prefix` TTSR rule, which asserted the same thing
 * with a regex over the raw command string. A regex cannot tell whether `bd close` is
 * a command or a substring. Measured against 4,673 distinct `bash`/`eval` commands
 * recovered from 587 local session transcripts, the rule fired 154 times and 5 of
 * those were an agent writing *about* bd rather than calling it: a `bun -e` tokeniser
 * test, two heredocs of regexes, a JS table of cases, and a `grep` whose alternation
 * `\|bd create\|` supplied the separator the pattern was looking for. The same
 * pattern also missed writes its verb list omitted — `assign`, `delete`, `reopen`,
 * `note`, `tag`, `link`, `priority`, and `promote` all mutate and never triggered it.
 *
 * Both defects have one cause: classifying text that only a shell parse can
 * classify. So this gate asks the tokeniser, which already backs G5 and G2, and
 * `skill://omp-surface-choice` puts an invariant needing evidence on a `tool_call`
 * gate rather than in TTSR, "never a security boundary".
 *
 * Exemptions are reads, not writes. A write list drifts as bd grows subcommands and a
 * missing entry loses attribution silently, so an unrecognised subcommand requires
 * attribution and the cost of an unlisted read verb is one over-strict refusal. The
 * table is bd's own verdict rather than a reading of its help: under `BD_READONLY=1`
 * a write path exits with `operation '<op>' is not allowed in read-only mode`, and
 * every entry below was probed that way against a scratch database at bd 1.1.2.
 */

import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ToolCallEventResult } from "@oh-my-pi/pi-coding-agent";
import { orcRole } from "../identity";
import type { BdInvocation } from "../shell";
import { bdInvocations } from "../shell";

/**
 * Subcommands that exited 0 under `BD_READONLY=1`, so bd itself does not count them
 * as writes. `context` is included on its help text alone: it cannot reach the
 * read-only check from a scratch database, refusing first with
 * `cannot resolve repo context`.
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
 * bead. They are exempt because attribution has nothing to attach to: `bd init`
 * creates the store, `bd dolt push` moves commits under the caller's git identity,
 * and `bd setup` writes editor integration files. Requiring `metadata.actor` on them
 * would refuse setup steps in the name of an audit trail they never touch.
 *
 * Found by scoring this gate against 4,673 recorded commands: an earlier revision
 * blocked `bd init`, `bd setup`, `bd bootstrap`, `bd dolt`, and `bd help`.
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
 * `bd 2>&1 | head` presents `2>&1` as its first positional — that command prints
 * help, and treating the artefact as an unrecognised write would refuse it.
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
 * Write actions of the grouped subcommands. These outrank the exemption table,
 * because a group can read by default and still carry a writing action: `comments`
 * alone prints an issue's comments and exits 0 under `BD_READONLY=1`, while
 * `comments add` refuses. `gate create`, `dep add`, `kv set`, and `label add` were
 * each confirmed to refuse the same way.
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

/** Either spelling satisfies bd; the contract sets both. */
const ACTOR_KEYS = ["BEADS_ACTOR", "BD_ACTOR"] as const;

/**
 * True when the invocation writes to the bead store *and* the actor is knowable, so
 * attribution can be required of it.
 *
 * `bd ready --claim` is the one write deliberately exempt. Dispatch writes
 * `metadata.actor` onto the bead and every agent body reads it back from there
 * (`supervision.ts:157`), so a queue pull — which names no bead — precedes the
 * identity it would have to carry. Demanding it would refuse the protocol's first
 * command. A claim that names its bead is not exempt: `bd show` yields
 * `metadata.actor` before the claim.
 */
function writesBeads(invocation: BdInvocation): boolean {
	if (invocation.hasClaim) return invocation.subcommand !== "ready";

	const subcommand = invocation.subcommand;
	// A bare `bd`, or a first positional that is really a redirection: both print help.
	if (!SUBCOMMAND.test(subcommand)) return false;
	if (ADMIN_SUBCOMMANDS[subcommand] === true) return false;

	const action = invocation.positionals[0] ?? "";
	if (WRITE_ACTIONS[action] === true) return true;
	if (READ_ACTIONS[action] === true) return false;
	return READ_SUBCOMMANDS[subcommand] !== true;
}

/**
 * `env` on the `bash` call reaches every command in it, so attribution set there
 * satisfies the contract as fully as an inline assignment. Without this the gate
 * would refuse the tool's own documented way of setting a variable.
 */
function envCarriesActor(env: unknown): boolean {
	if (env === null || typeof env !== "object") return false;
	const record = env as Record<string, unknown>;
	return ACTOR_KEYS.some(key => typeof record[key] === "string" && (record[key] as string).length > 0);
}

/** Refuse a bead write that names no actor, so the audit trail keeps an identity. */
export function gateActorAttribution(
	ctx: ExtensionContext,
	input: Record<string, unknown>,
): ToolCallEventResult | undefined {
	const command = input.command;
	if (typeof command !== "string" || command.length === 0) return undefined;

	// The requirement is the worker contract's, so it binds contract-bound sessions
	// only. The lead writes under its own git identity, and a helper that declares no
	// role is already sandboxed read-only by G1.
	if (orcRole(ctx) === undefined) return undefined;

	if (envCarriesActor(input.env)) return undefined;

	for (const invocation of bdInvocations(command)) {
		if (!writesBeads(invocation)) continue;
		if (ACTOR_KEYS.some(key => (invocation.assignments.get(key) ?? "").length > 0)) continue;

		const written = invocation.hasClaim ? `${invocation.subcommand} --claim` : invocation.subcommand;
		return {
			block: true,
			reason: `'bd ${written}' writes beads under no identity; prefix it with BEADS_ACTOR=<metadata.actor> BD_ACTOR=<metadata.actor> so the audit trail names the acting role`,
		};
	}

	return undefined;
}
