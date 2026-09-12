import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { claimedBead, resetReadBudget } from "./bd";
import type { ClaimState } from "./claim-state";
import { type BdInvocation, effectiveSegments, parseBdInvocation } from "./shell";

/**
 * Record the bead a claim actually acquired, from the report it printed.
 *
 * Two defects made this necessary, pulling in opposite directions.
 *
 * `bd ready --claim` selects by filter, so no id exists until the result does. The gate
 * recorded `beadIds: []`, which `recordClaim` rejects, so after every normal pull
 * `observedClaim()` held nothing. `gateExitContract` then took its no-bead branch for
 * every correctly working session, and the contract evaluation that hangs off the claimed
 * bead never ran.
 *
 * `bd update <id> --claim` does carry the id, and the gate recorded it *before* the
 * command ran. Named claims are atomic, so the loser of a race recorded a bead it never
 * acquired and would have had its exit contract judged against another session's work.
 *
 * The claim report settles both, and it is structured rather than prose. Measured against
 * beads 1.1.2:
 *
 *   won  -> exit 0, stdout is a JSON array holding the claimed issue
 *   lost -> exit 1, stdout EMPTY, stderr `Error claiming <id>: issue already claimed by <actor>`
 *
 * So a one-record claim report is itself the proof of acquisition: a loss produces no JSON
 * to mistake for one. That is why nothing here matches message text, and why no id is
 * scavenged from output -- a command can print whatever it likes, and prose is not a
 * contract.
 *
 * `--json` is required for a claim to be observable. Every documented queue pull already
 * carries it, so the report is machine-readable by protocol rather than by luck.
 *
 * The report is the fast path, not the only one. The host caps every output line at
 * `tools.outputMaxColumns` (768 by default) before this handler sees it, and a bead's
 * description is one JSON line, so a brief-length bead arrives unparseable with only
 * `details.meta.limits.columnTruncated` to say so. A claim that plausibly succeeded but
 * whose report cannot be read is therefore resolved from the store instead: the actor the
 * command carried (`BEADS_ACTOR` inline or in the tool's `env`) names the bead it now
 * holds. That needs an explicit actor -- the process environment is shared by every
 * in-process session, so reading it there could bind another session's bead -- and when
 * no actor was carried, or the store answers nothing, the worker is told rather than left
 * with every claim-dependent gate silently unarmed. Each unrecorded claim is also logged
 * with the head of what arrived, so drift in `bd` or in the host is visible.
 */

/** A `tool_result` event, structurally: the host's own type is not needed at runtime. */
export interface ToolResultLike {
 toolName?: string;
 isError?: boolean;
 input?: Record<string, unknown>;
 details?: unknown;
 content?: unknown;
}

/** Custom-message type of the notice that a claim ran but could not be bound. */
export const CLAIM_UNOBSERVED_MESSAGE = "com.srobroek.omp-orchestrate.claim-unobserved";

/** Characters of the unparsed result a warning carries: enough to see what arrived. */
const WARN_HEAD_CHARS = 200;

/**
 * The identity carriers, in the order they are consulted. `bd --help` resolves `--actor` from
 * `$BEADS_ACTOR, git user.name, $USER`, so BEADS_ACTOR anywhere on the command is what the
 * store recorded; BD_ACTOR is this plugin's carrier (`src/gates/bd.ts`) and only a last resort.
 */
const ACTOR_VARS = ["BEADS_ACTOR", "BD_ACTOR"] as const;

/** The `details` fields read, as `BashToolDetails` and `OutputMeta` name them, untrusted. */
interface BashDetailsLike {
 exitCode?: unknown;
 timedOut?: unknown;
 async?: unknown;
 meta?: { truncation?: unknown; limits?: { columnTruncated?: unknown } };
 wallTimeMs?: unknown;
 timeoutSeconds?: unknown;
 requestedTimeoutSeconds?: unknown;
}

/** Concatenate the text parts of a result payload, ignoring images. */
function resultText(content: unknown): string {
 if (!Array.isArray(content)) return "";
 let text = "";
 for (const part of content) {
  if (part !== null && typeof part === "object" && "text" in part && typeof part.text === "string") text += part.text;
 }
 return text;
}

/**
 * Whether the command completed with exit 0 in the foreground.
 *
 * `details.exitCode` is set only on a failing exit (`tools/bash.ts:814-815`, guarded by
 * `failedExit`), so its presence means failure and success leaves it undefined --
 * comparing it to zero would have accepted nothing. An async result is rejected outright:
 * its payload describes a job that was started, not a claim that completed.
 */
function plausiblySucceeded(event: ToolResultLike, details: BashDetailsLike | undefined): boolean {
 if (event.isError === true) return false;
 if (details?.exitCode !== undefined) return false;
 if (details?.timedOut === true) return false;
 if (details?.async !== undefined && details.async !== false) return false;
 return true;
}

/**
 * Why the result text is not the command's output, or `undefined` when it is.
 *
 * Window and byte truncation land in `meta.truncation` (`truncationFromSummary`,
 * `tools/output-meta.ts:241`). The per-line column cap is applied at the sink's write time
 * and lands only in `meta.limits.columnTruncated` (`:238-239`): the visible JSON looks
 * complete apart from one `…`-marked line, so this is the signal the parse would otherwise
 * never see.
 */
function reportCut(details: BashDetailsLike | undefined): string | undefined {
 if (details?.meta?.truncation) return "output truncated";
 if (details?.meta?.limits?.columnTruncated) return "lines truncated at the column cap";
 return undefined;
}

/**
 * The command's own output, with the host's footer removed; `undefined` when the footer
 * cannot be told apart from the output.
 *
 * The host appends `"", "Wall time: <s> seconds", ...notices` after the output
 * (`tools/bash.ts:783-793`) and records the same `wallTimeMs` in `details` (`:811-813`).
 * The wall-time line is therefore derivable from structured data, and its last occurrence
 * is the boundary: the command cannot print anything after a footer the host appends last.
 * Everything past that line is the host's, whatever it says, so a notice the host adds in
 * a later release cannot disarm the observer.
 *
 * Without `details.wallTimeMs` the boundary is found by wording alone, and then the notices
 * after it must be ones this host is known to print. That path exists for a host that does
 * not report wall time; on the pinned host every completed command does.
 */
function commandOutput(text: string, details: BashDetailsLike | undefined): string | undefined {
 const wallTimeMs = details?.wallTimeMs;
 if (typeof wallTimeMs === "number" && Number.isFinite(wallTimeMs)) {
  const footer = `\n\nWall time: ${(wallTimeMs / 1000).toFixed(2)} seconds`;
  const at = text.lastIndexOf(footer);
  if (at === -1) return undefined;
  const end = at + footer.length;
  if (end !== text.length && text[end] !== "\n") return undefined;
  return text.slice(0, at);
 }
 if (wallTimeMs !== undefined) return undefined;

 const footerAt = text.lastIndexOf("\n\nWall time: ");
 if (footerAt === -1) return text;
 const notices = text.slice(footerAt + 2).split("\n");
 if (!/^Wall time: \d+\.\d{2} seconds$/.test(notices[0] ?? "")) return undefined;
 let next = 1;
 if (notices[next]?.startsWith("Timeout clamped to ")) {
  const effective = details?.timeoutSeconds;
  const requested = details?.requestedTimeoutSeconds;
  if (typeof effective !== "number" || !Number.isFinite(effective) ||
   typeof requested !== "number" || !Number.isFinite(requested) || effective === requested) return undefined;
  const prefix = `Timeout clamped to ${effective}s (requested ${requested}s; `;
  const notice = notices[next];
  if (notice !== `${prefix}allowed range 1-3600s).` &&
   !(effective > 0 && effective < 3600 && notice === `${prefix}global tools.maxTimeout ceiling ${effective}s).`)) return undefined;
  next++;
 }
 if (notices[next] === "pty requested but unavailable in this environment; ran without a terminal") next++;
 if (next !== notices.length) return undefined;
 return text.slice(0, footerAt);
}

/**
 * A claimed issue as `bd` reports it, or nothing.
 *
 * `assignee` is the actor, read from the report. Every documented queue pull leaves
 * `BEADS_ACTOR` in the environment rather than inline, so requiring an inline actor would
 * reject every normal claim.
 */
function claimedRecord(record: unknown): { id: string; assignee: string } | undefined {
 if (record === null || typeof record !== "object") return undefined;
 if (!("id" in record) || typeof record.id !== "string" || record.id.length === 0) return undefined;
 // A claim sets both. Either absent means this is a read, or some other JSON.
 if (!("status" in record) || record.status !== "in_progress") return undefined;
 if (!("assignee" in record) || typeof record.assignee !== "string" || record.assignee.length === 0) return undefined;
 return { id: record.id, assignee: record.assignee };
}

/**
 * Every claimed record a `--json` claim reports, when the output is exactly that.
 *
 * Plural on purpose. `bd update <a> <b> --claim` claims both, `recordClaim` takes
 * `beadIds` as a list, and the worktree gate scopes across all of them, so recording only
 * a single-record report would leave a legitimate two-bead claim unobserved and that gate
 * unarmed.
 *
 * All records must name the same assignee. One actor issued the call, so a report mixing
 * assignees is not one session's claim and records nothing.
 *
 * An empty array is a real answer, not a failure to observe: `bd ready --claim` on a drained
 * queue prints `[]` and exits 0, and the worker's next step is NO_WORK. It is reported as
 * `"empty"` so the caller neither records nor diagnoses it.
 */
function reportedClaims(output: string): { actor: string; beadIds: string[] } | "empty" | undefined {
 let parsed: unknown;
 try {
  parsed = JSON.parse(output);
 } catch {
  return undefined;
 }
 if (parsed !== null && typeof parsed === "object" && "schema_version" in parsed && "data" in parsed) {
  parsed = parsed.data;
 }
 if (!Array.isArray(parsed)) return undefined;
 if (parsed.length === 0) return "empty";

 const beadIds: string[] = [];
 let actor: string | undefined;
 for (const record of parsed) {
  const claimed = claimedRecord(record);
  // One unclaimed record means this is not a claim report at all.
  if (claimed === undefined) return undefined;
  if (actor === undefined) actor = claimed.assignee;
  else if (actor !== claimed.assignee) return undefined;
  beadIds.push(claimed.id);
 }
 if (actor === undefined) return undefined;
 return { actor, beadIds };
}

/**
 * The one claiming `bd` call when the command is exactly that and nothing else.
 *
 * Segments, not `bdInvocations`: `bd update victim --claim; true` holds one bd invocation
 * and two segments, and the trailing `true` makes the shell exit 0 while the claim failed.
 * Counting invocations would have recorded `victim` on a failure.
 */
function soleClaimingInvocation(command: unknown): BdInvocation | undefined {
 if (typeof command !== "string") return undefined;
 const segments = effectiveSegments(command);
 if (segments.length !== 1) return undefined;
 const segment = segments[0];
 if (segment === undefined) return undefined;
 const invocation = parseBdInvocation(segment);
 return invocation !== null && invocation.hasClaim ? invocation : undefined;
}

/**
 * The actor the claim ran as, from the command itself.
 *
 * Per variable, an inline assignment is closest to the command and wins over the tool's
 * `env`, as it does in the shell. An empty value is no identity, matching `src/gates/bd.ts`.
 * The process environment is deliberately not consulted: see the module comment.
 */
function commandActor(invocation: BdInvocation, env: unknown): string | undefined {
 // The tool's `env` is a free-form record (`src/gates/bd.ts` reads it the same way); only
 // string values are taken from it.
 const exported = env !== null && typeof env === "object" ? env as Record<string, unknown> : undefined;
 for (const variable of ACTOR_VARS) {
  const inline = invocation.assignments.get(variable);
  if (inline !== undefined && inline.length > 0) return inline;
  const value = exported?.[variable];
  if (typeof value === "string" && value.length > 0) return value;
 }
 return undefined;
}

/**
 * Observe a `bash` result and record the claim it acquired.
 *
 * Runs after every bash call, so it stays cheap on the common path and never throws.
 * Only a claim that completed successfully and still went unrecorded is diagnosed: a
 * failed or backgrounded claim already shows the model its own outcome, and a command
 * that is not a sole claim is not this handler's business.
 *
 * The remedy the notice names is safe to repeat: `bd update --claim` is "idempotent if
 * already claimed by you" (`bd update --help`, bd 1.2.2), and G5 permits a same-bead retry.
 * With the actor on the command, the retry's report may be just as unreadable and still
 * binds, because the store answers.
 */
export async function observeClaimResult(pi: ExtensionAPI, claims: ClaimState, event: ToolResultLike): Promise<void> {
 if (event.toolName !== "bash") return;
 const details = event.details !== null && typeof event.details === "object" ? event.details as BashDetailsLike : undefined;
 if (!plausiblySucceeded(event, details)) return;
 const command = event.input?.command;
 const invocation = soleClaimingInvocation(command);
 if (invocation === undefined) return;

 const text = resultText(event.content).trim();
 let reason = reportCut(details);
 if (reason === undefined) {
  const output = commandOutput(text, details);
  if (output === undefined) reason = "footer not recognised";
  else {
   const claimed = reportedClaims(output);
   if (claimed === "empty") return;
   if (claimed !== undefined) {
    claims.recordClaim(claimed);
    return;
   }
   reason = "not a claim report";
  }
 }

 const actor = commandActor(invocation, event.input?.env);
 pi.logger.warn("orchestrate claim not observed", { command, reason, actor, head: text.slice(0, WARN_HEAD_CHARS) });

 if (actor !== undefined) {
  resetReadBudget();
  const bead = await claimedBead(actor);
  if (bead !== null) {
   claims.recordClaim({ actor, beadIds: [bead.id] });
   return;
  }
 }

 const cause = actor === undefined
  ? "the command carried no BEADS_ACTOR, so the store could not be asked which bead it holds"
  : `the store returned no open bead assigned to ${actor}`;
 pi.sendMessage(
  {
   customType: CLAIM_UNOBSERVED_MESSAGE,
   content:
    `WARN claim: '${String(command)}' completed, but its claim report could not be read (${reason}) and ${cause}. ` +
    "This session's claim is unbound: the worktree-scope, exit-contract, and attribution gates will not see it. " +
    "Bind it by re-running the claim with the actor on the command, `BEADS_ACTOR=<assignee> bd update <bead-id> --claim --json` " +
    "(idempotent for the same actor); the observer then resolves the claim from the store even when the report is unreadable.",
   display: true,
   attribution: "user",
  },
  { deliverAs: "steer" },
 );
}
