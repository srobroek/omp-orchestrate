/**
 * G7 — one bead per activation.
 *
 * "One activation owns at most one bead. Claim a single id, finish or release it, then
 * claim the next." G5 evaluates each named bead's routing and never the count
 * (`test/gate-matrix.test.ts` recorded that as a finding), so the count was owned by
 * the `orc-one-claim` TTSR rule alone.
 *
 * That rule asserted it with a regex over the raw command string, and it needed two
 * literal `<name>-<digits>` ids somewhere after `bd update`. Measured against 4,673
 * distinct `bash`/`eval` commands recovered from 587 local session transcripts, it
 * fired 4 times and all 4 were text about bd rather than a call to it — a 100% false
 * positive rate. It also could not see:
 *
 *  - a claim through any subcommand but `update`;
 *  - an id whose suffix carries a hyphen, which is most of them: `orc-chaos-c3-05k`
 *    appears throughout the corpus and `[A-Za-z][A-Za-z0-9_-]*-\d+` never matched it;
 *  - a claim inside a wrapper shell's payload, until the pattern's leading character
 *    class was widened to admit a quote.
 *
 * So this asks the tokeniser instead. The count is taken from the invocation's own
 * operands, which is what makes it exact: `bd update <id> --claim --parent <other>`
 * names one bead and a flag value, and no regex over the line can tell those apart.
 *
 * Two ids count only when they are *adjacent* operands. A flag's value is separated
 * from the leading run of ids by the flag itself, and bd has many that take one
 * (`--parent`, `--assignee`, `--reason`, `--status`) — none of which `src/shell.ts`
 * knows, because its `VALUE_FLAGS` covers bd's global flags only. Adjacency needs no
 * such table, so it cannot drift: a flag bd adds tomorrow still separates its value
 * from the ids.
 */

import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ToolCallEventResult } from "@oh-my-pi/pi-coding-agent";
import { orcRole } from "../identity";
import type { BdInvocation } from "../shell";
import { bdInvocations } from "../shell";

/**
 * A bead id: a lowercase word, then one or more hyphen-separated groups.
 *
 * Wider than the pattern `src/bd.ts` uses to sieve ids out of a dependency record,
 * which forbids a hyphen in the suffix and therefore rejects `orc-chaos-c3-05k` —
 * real ids from the corpus, since a configured issue prefix may itself contain one.
 * Matched against a single token the tokeniser produced, never against command text.
 */
const BEAD_ID = /^[a-z][a-z0-9]*(?:-[A-Za-z0-9._]+)+$/;

/**
 * The bead ids one claim names, taken from the longest run of adjacent operands.
 *
 * Adjacency is recovered by consuming `positionals` in order while walking `rest`:
 * anything `parseBdInvocation` did not count as an operand — the subcommand, a flag,
 * the value of a global flag — is a token the walk does not match, and so ends the
 * run. Ids are de-duplicated because `--claim` is idempotent when the caller already
 * holds the bead, so naming one twice claims one bead.
 */
function claimedBeadIds(invocation: BdInvocation): string[] {
	const operands = invocation.positionals;
	let next = 0;
	let run: string[] = [];
	let longest: string[] = [];

	for (const token of invocation.rest) {
		if (next < operands.length && token === operands[next]) {
			next += 1;
			if (BEAD_ID.test(token) && !run.includes(token)) run.push(token);
			continue;
		}
		if (run.length > longest.length) longest = run;
		run = [];
	}

	return run.length > longest.length ? run : longest;
}

/** Refuse a claim that names two or more beads, so one activation owns one bead. */
export function gateOneClaim(ctx: ExtensionContext, input: Record<string, unknown>): ToolCallEventResult | undefined {
	const command = input.command;
	if (typeof command !== "string" || command.length === 0) return undefined;

	// The invariant is the worker contract's: an activation is a spawned agent's run,
	// and "parallel work belongs to parallel agents". The lead declares no role and
	// claims nothing at all (`src/gates/claim.ts:12-13`), and an ordinary session
	// outside a run must not be refused for using bd normally.
	if (orcRole(ctx) === undefined) return undefined;

	for (const invocation of bdInvocations(command)) {
		if (!invocation.hasClaim) continue;
		// `bd ready --claim` claims "the first ready issue matching the filters"
		// (`bd ready --help`, bd 1.1.2), so it takes exactly one bead however many
		// filters it carries — and the ids on such a line are filters, not targets:
		// `--parent orc-1` names the epic being pulled from.
		if (invocation.subcommand === "ready") continue;

		const beadIds = claimedBeadIds(invocation);
		if (beadIds.length < 2) continue;

		return {
			block: true,
			reason: `'bd ${invocation.subcommand} --claim' names ${beadIds.length} beads (${beadIds.join(", ")}); one activation owns at most one bead. Claim '${beadIds[0]}', finish or release it, then claim the next — parallel work belongs to parallel agents, not parallel claims.`,
		};
	}

	return undefined;
}
