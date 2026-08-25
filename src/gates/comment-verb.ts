/**
 * G8 — a bead comment leads with its protocol verb.
 *
 * "Start every bead comment with its protocol verb ... so histories read without
 * narration. Free prose belongs after the verb, not instead of it."
 *
 * This replaces the `orc-comment-verbs` TTSR rule, whose condition looked for
 * `bd comment`, then any run of non-quote characters, then a quote not followed by a
 * verb. Measured against 4,673 distinct `bash`/`eval` commands recovered from 587 local
 * session transcripts it fired 19 times, and 6 of those contain no bd invocation at
 * all: scripts that *write* this rule set, whose own condition text supplied the `bd
 * comment` the pattern was looking for. It also could not tell a body from anything
 * else that follows the bead id — `bd comments add <id> -f notes.txt` reads as a body
 * of `notes.txt`, and `bd comment list <id>` as a body of the redirection after it.
 *
 * The same pattern missed `bd comments add`, the long form that appears throughout the
 * corpus, because it required the word `comment` immediately after `bd`.
 *
 * So this asks the tokeniser, and reads the body from the parsed operands.
 *
 * ## Why this blocks, where the rule only advised
 *
 * The rule declared `interruptMode: never`, so the tool ran and the reminder arrived
 * afterwards — by which point the narrated comment is already in the bead's history.
 * An advisory channel cannot prevent the thing it names; it can only affect the next
 * comment. Blocking at write time is the only surface that keeps a history clean.
 *
 * The exit contract does not cover this either, and cannot. Its verb predicate is
 * existential — `pool.some(verb => wanted.includes(verb))` (`src/gates/exit.ts:157`) —
 * so it asks whether *some* comment on the bead carries a required verb. A worker that
 * leaves five narrated comments and one `REPORTED` satisfies every contract in
 * `src/contracts/` while leaving exactly the history this rule exists to prevent.
 *
 * ## Why an unreadable body passes
 *
 * The verdict is only ever taken on text the gate can actually see. A body behind
 * `--file`, `--stdin`, or a shell expansion is not evidence of a missing verb, and
 * refusing it would cost a legitimate comment for no reason. Every such shape returns
 * `undefined`, which is the same direction every other gate in this plugin fails.
 *
 * `commentVerb` is reused rather than reimplemented, so this gate and the exit contract
 * read one comment the same way: both uppercase the first token and strip a trailing
 * colon. Without that a body of `Landed the branch` could pass one and fail the other.
 */

import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ToolCallEventResult } from "@oh-my-pi/pi-coding-agent";
import { commentVerb } from "../bd";
import { COMMENT_VERBS } from "../contract";
import { orcRole } from "../identity";
import type { BdInvocation } from "../shell";
import { bdInvocations } from "../shell";

/**
 * A bead id, as `src/gates/one-claim.ts` matches one: a lowercase word then one or more
 * hyphen-separated groups. Applied to a single token, never to command text.
 */
const BEAD_ID = /^[a-z][a-z0-9]*(?:-[A-Za-z0-9._]+)+$/;

/**
 * A token the tokeniser produced that a shell would not pass to `bd` as a word.
 *
 * Redirections are the case that matters: `src/shell.ts` expands none of them, so
 * `bd comment list <id> 2>&1 | sed ...` presents `2>` where a body would sit. Treating
 * that as a body would refuse a command that never carried one.
 */
const REDIRECTION = /^\d*(?:>>?|<)/;

/**
 * An unexpanded expansion, matched against the first token alone. `bd comment <id>
 * "$SUMMARY"` names no verb until a shell runs, but a body whose *later* words carry a
 * `$` still opens with a word this gate can read — so testing the whole body would
 * excuse `"Wired $X into $Y"`, which is exactly the narration being refused.
 */
const EXPANSION = /[$`]/;

/**
 * The comment body this invocation carries, or `undefined` when it is not on the
 * command line at all.
 *
 * bd 1.1.2 has no `-m`/`--body`/`--message` on either spelling: `bd comment <id>
 * [text...]` and `bd comments add [id] [text]` take the body positionally, and
 * otherwise from `--file`/`-f`/`--stdin`. So the body is the operand immediately after
 * the bead id — and any flag in that position means the body is elsewhere, which
 * covers the file and stdin forms without naming them.
 */
function commentBody(invocation: BdInvocation): string | undefined {
	const operands = invocation.positionals;
	let next = 0;

	for (let index = 0; index < invocation.rest.length; index++) {
		const token = invocation.rest[index] as string;
		if (next >= operands.length || token !== operands[next]) continue;
		next += 1;
		if (!BEAD_ID.test(token)) continue;

		// The very next token, not the next operand: a flag here means `--file`, `--stdin`,
		// or `--json` took the position a body would have held.
		const body = invocation.rest[index + 1];
		if (body === undefined || body.startsWith("-")) return undefined;
		if (REDIRECTION.test(body)) return undefined;
		return body;
	}

	return undefined;
}

/** Refuse a bead comment whose body does not lead with a protocol verb. */
export function gateCommentVerb(ctx: ExtensionContext, input: Record<string, unknown>): ToolCallEventResult | undefined {
	const command = input.command;
	if (typeof command !== "string" || command.length === 0) return undefined;

	// The grammar is the protocol's, so it binds contract-bound sessions only. An
	// ordinary session's bead histories are not this plugin's to shape.
	if (orcRole(ctx) === undefined) return undefined;

	for (const invocation of bdInvocations(command)) {
		const grouped = invocation.subcommand === "comments" && invocation.positionals[0] === "add";
		if (invocation.subcommand !== "comment" && !grouped) continue;

		const body = commentBody(invocation);
		if (body === undefined) continue;

		const verb = commentVerb(body);
		if (EXPANSION.test(verb) || COMMENT_VERBS[verb] === true) continue;

		return {
			block: true,
			reason: `this comment opens with '${verb}', which is not a protocol verb; lead with one so the bead history reads without narration — the 11-verb set, a disposition (LANDED, BOUNCED, IDLE, FAILED), or a supervision verb. Free prose belongs after the verb, not instead of it.`,
		};
	}

	return undefined;
}
