/**
 * G5 — claim eligibility.
 *
 * Beads enforces claim *exclusivity* — verified: two actors claiming the same queue
 * receive different beads and a third receives `[]` — but not *eligibility*. Any
 * actor may claim any bead, so nothing stops a reviewer claiming an implementation
 * task, or the lead claiming anything at all.
 *
 * This gate supplies eligibility, and replaces v19's deleted lead-never-claims rule
 * with something stronger. `orchestrator-claim-deny.py` compared `BEADS_ACTOR` and
 * `BD_ACTOR` against a regex for "looks like a worker, not a lead", which a
 * cooperative name defeated. Here the lead simply declares no `ORC-ROLE`, so it
 * fails every eligibility check and can claim nothing.
 *
 * It does not record the claim. Doing so from the command was wrong twice over: a
 * queue pull names no bead, and a named claim's outcome is unknown until it runs, so a
 * race loser recorded a bead it never held. `src/claim-observer.ts` reads the claim
 * report instead, and the worktree gate reads that.
 */

import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ToolCallEventResult } from "@oh-my-pi/pi-coding-agent";
import type { BdBead } from "../bd";
import { bdList, bdShow } from "../bd";
import type { ClaimState } from "../claim-state";
import { beadRouting, legacyRoleFromLabel, orcRole, ROUTING_KEY } from "../identity";
import { scopeOf, scopesOverlap } from "../scope";
import { BD_VALUE_FLAGS, type BdInvocation, bdInvocations, effectiveSegments } from "../shell";

/**
 * A flag token split into its name and its inline `=` operand, when it carries one.
 *
 * Every flag this gate reads has two spellings, `--flag value` and `--flag=value`, and a
 * matcher that knows only the first is a matcher that can be walked past.
 */
function splitFlag(token: string): { flag: string; inline?: string } {
 if (!token.startsWith("-")) return { flag: token };
 const cut = token.indexOf("=");
 if (cut === -1) return { flag: token };
 return { flag: token.slice(0, cut), inline: token.slice(cut + 1) };
}

/** A queue filter on a `bd ready`, resolved to the role it pulls for. */
interface QueueFilter {
 role: string;
 /** The filter verbatim, quoted back in a refusal. */
 spelling: string;
}

const QUEUE_METADATA_FLAGS: Record<string, true> = { "--metadata-field": true };
const QUEUE_LABEL_FLAGS: Record<string, true> = { "--label": true, "-l": true, "--label-any": true };

/**
 * The role filters on a `bd ready --claim`, which pin the queue the caller pulls from. A
 * pull naming the caller's own role needs no bead lookup: beads hands back only a
 * matching bead.
 *
 * Both carriers are read. `--metadata-field role=<role>` is the live spelling; a legacy
 * `--label agent:<role>` resolves through the same alias table the bead resolver uses, so
 * one legacy token cannot pin a queue here and route a bead there. That mattered: the
 * previous code compared the raw label suffix against the session's declared role, which
 * refused a shepherd pulling `--label agent:integrator` from its own merge queue.
 */
function readyQueueRoles(rest: readonly string[]): QueueFilter[] {
 const filters: QueueFilter[] = [];
 for (let index = 0; index < rest.length; index++) {
  const { flag, inline } = splitFlag(rest[index] as string);
  const value = inline ?? rest[index + 1];
  if (typeof value !== "string") continue;

  if (QUEUE_METADATA_FLAGS[flag] === true) {
   const cut = value.indexOf("=");
   if (cut === -1 || value.slice(0, cut) !== ROUTING_KEY) continue;
   filters.push({ role: value.slice(cut + 1), spelling: value });
   continue;
  }

  if (QUEUE_LABEL_FLAGS[flag] === true) {
   const role = legacyRoleFromLabel(value);
   if (role !== undefined) filters.push({ role, spelling: value });
  }
 }
 return filters;
}

/**
 * Roles permitted to write `metadata.role`, the key that routes a bead.
 *
 * Only the architect: it decomposes its epic into nodes and routes each one, so within
 * its subtree it is the dispatcher. Every other role receives a route and must not
 * re-point one. The lead is absent because it declares no role at all and never reaches
 * the check.
 *
 * A code table rather than a `deny_metadata` clause, and deliberately so. That list is a
 * presence test on the claimed bead at yield, routing metadata is present on every routed
 * bead, and a denial there would fault every worker on every bead. `ORCHESTRATOR_ANCHORS`
 * in `./exit` states the limit in full.
 */
const ROUTING_WRITERS: Record<string, true> = { architect: true };

/**
 * `bd` flags that write or clear a metadata key.
 *
 * `--metadata-field` is absent on purpose: it filters a query and writes nothing.
 */
const METADATA_WRITE_FLAGS: Record<string, true> = {
 "--metadata": true,
 "--set-metadata": true,
 "--unset-metadata": true,
};

/**
 * Subcommands exempt from routing-write denial.
 *
 * Filing a NEW bead routed is legitimate for every role -- an unrouted bug bead reaches no
 * queue and strands, and the close-out gate then faults it -- and it deprives nobody,
 * because a bead that does not exist yet has no route to steal. The hazard is
 * REASSIGNMENT: re-pointing a bead that already carries a route. So creation is named
 * exempt and everything else is gated, which refuses a subcommand this plugin has not met
 * rather than waving it through.
 */
const ROUTING_WRITE_EXEMPT: Record<string, true> = { create: true };

/** Whether a `--metadata` JSON object names `role` as its own key. */
function jsonCarriesRouting(value: string): boolean {
 if (!value.trimStart().startsWith("{")) return false;
 try {
  const parsed: unknown = JSON.parse(value);
  // Own-property test: `JSON.parse` output inherits `Object.prototype`, so a map
  // carrying no `role` key must read as carrying none.
  return parsed !== null && typeof parsed === "object" && Object.hasOwn(parsed, ROUTING_KEY);
 } catch {
  // Unparseable JSON is no write this gate can attribute, and `bd` will reject it.
  return false;
 }
}

/**
 * The `metadata.role` write this invocation performs, verbatim, or `undefined`.
 *
 * Reads `rest`, never `positionals`: the tokeniser consumes operands only for the global
 * flags it knows, so a write flag's operand can still be sitting in the positional list,
 * and matching there would both miss writes and invent them. Reading `rest` also makes the
 * `-C <run repo>` pin irrelevant to the match, which is the spelling every call carries.
 *
 * Three spellings write the key: `--set-metadata role=<v>`, `--unset-metadata role`, and
 * `--metadata` carrying a `role` key -- as JSON, the only form `create` takes, or as
 * `key=value`. Clearing counts as a write: a bead with no route reaches no queue.
 */
function routingMetadataWrite(invocation: BdInvocation): string | undefined {
 if (ROUTING_WRITE_EXEMPT[invocation.subcommand] === true) return undefined;

 for (let index = 0; index < invocation.rest.length; index++) {
  const { flag, inline } = splitFlag(invocation.rest[index] as string);
  if (METADATA_WRITE_FLAGS[flag] !== true) continue;
  const value = inline ?? invocation.rest[index + 1];
  if (typeof value !== "string") continue;

  if (flag === "--unset-metadata") {
   // Repeatable and comma-joinable, so every key named is checked.
   if (value.split(",").some(key => key.trim() === ROUTING_KEY)) return `${flag} ${ROUTING_KEY}`;
   continue;
  }

  // `key=value` first, then JSON. A JSON payload can itself contain `=` inside a
  // value, so the key test must fail before the shape test runs.
  const cut = value.indexOf("=");
  if (cut !== -1 && value.slice(0, cut) === ROUTING_KEY) return `${flag} ${value}`;
  if (jsonCarriesRouting(value)) return `${flag} ${value}`;
 }
 return undefined;
}

/**
 * Refuse a write that re-points the queue a bead is pulled from.
 *
 * This is where routing authority is actually enforced, and it is a write seam rather than
 * an exit seam for two reasons. The actor is `orcRole(ctx)`, read from the marker OMP
 * renders into the child's prompt, so unlike a label or a metadata value it is not
 * agent-writable. And a re-point judged at exit is judged too late: the bead has already
 * been claimed and worked by whoever the new route named.
 *
 * Fails open on an unresolvable role. That is the lead, which routes the whole DAG, and a
 * spawned session carrying no contract -- which G1 has already put behind `BD_READONLY=1`
 * and which therefore cannot write a bead at all.
 */
function routingWriteDenial(
 invocation: BdInvocation,
 sessionRoleName: string | undefined,
): ToolCallEventResult | undefined {
 if (sessionRoleName === undefined) return undefined;
 if (ROUTING_WRITERS[sessionRoleName] === true) return undefined;
 const written = routingMetadataWrite(invocation);
 if (written === undefined) return undefined;
 return {
  block: true,
  reason:
   `'${written}' rewrites metadata.${ROUTING_KEY}, which is what routes the bead, and ${sessionRoleName} ` +
   `may not re-point work. Routing is assigned by the architect that decomposed the epic. Hand off with ` +
   `the next role's agent: label instead -- that is a signal, not a route -- and if the bead is genuinely ` +
   `misrouted, say so on an escalation wisp rather than re-routing it yourself. Filing new work routed is ` +
   `allowed: bd create carries ${ROUTING_KEY} freely.`,
 };
}

/** A bead's metadata as a record, tolerating the JSON-string form some subcommands emit. */
function metadataRecord(bead: BdBead | null): Record<string, unknown> | undefined {
 const raw = bead?.metadata;
 if (raw && typeof raw === "object") return raw as Record<string, unknown>;
 if (typeof raw === "string") {
  try {
   const parsed: unknown = JSON.parse(raw);
   if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
  } catch {
   return undefined;
  }
 }
 return undefined;
}

/** Exclusive scope friction between held code-writing claims; read-only roles keep their envelopes without reserving territory. */
export async function scopeConflict(bead: BdBead | null): Promise<ToolCallEventResult | undefined> {
 if (!bead) return undefined;
 const role = beadRouting(bead)?.role;
 if (role === "researcher" || role === "reviewer") return undefined;
 const candidate = scopeOf(metadataRecord(bead));
 if (candidate.length === 0) return undefined;
 const inFlight = await bdList(["list", "--label", "orc-node", "--status", "in_progress", "--json"]);
 for (const other of inFlight) {
  if (other.id === bead.id) continue;
  if (typeof other.assignee !== "string" || other.assignee.trim().length === 0) continue;
  const otherRole = beadRouting(other)?.role;
  if (otherRole === "researcher" || otherRole === "reviewer") continue;
  const otherScope = scopeOf(metadataRecord(other));
  if (otherScope.length === 0) continue;
  if (scopesOverlap(candidate, otherScope)) {
   return {
    block: true,
    reason:
     `scope conflict (friction guard): '${bead.id}' [${candidate.join(", ")}] overlaps in-flight ` +
     `'${other.id}' [${otherScope.join(", ")}]. Two agents must not share a file; wait for ` +
     `'${other.id}' to report, or re-scope one of the beads.`,
   };
  }
 }
 return undefined;
}


/** Named targets excluding option operands, including flags interleaved between IDs. */
function claimTargets(claim: BdInvocation): string[] {
 if (claim.subcommand === "ready") return [];
 const targets: string[] = [];
 let subcommandSeen = false;
 let positionalOnly = false;
 for (let index = 0; index < claim.rest.length; index++) {
  const token = claim.rest[index] as string;
  if (!positionalOnly && token === "--") {
   positionalOnly = true;
   continue;
  }
  if (!positionalOnly && token.startsWith("-")) {
   if (!token.includes("=") && BD_VALUE_FLAGS[token] === true) index++;
   continue;
  }
  if (!subcommandSeen) {
   subcommandSeen = true;
   continue;
  }
  if (!targets.includes(token)) targets.push(token);
 }
 return targets;
}

const SHEPHERD_DENIED_STATES: Record<string, true> = {
 approved: true,
 changes_requested: true,
 reported: true,
};

const SET_STATE_VALUE_FLAGS: Record<string, true> = {
 "-C": true, "--directory": true, "--actor": true, "--db": true, "--dolt-auto-commit": true, "--reason": true,
};

/** Review and reporting states are inherited by shepherds, never authored by them. */
function shepherdStateWrite(invocation: BdInvocation): boolean {
 if (invocation.subcommand === "set-state") {
  // `bd set-state <issue-id> <dimension>=<value> ... --reason <prose>`.
  // Only positional state assignments author review state; global option values,
  // the issue id, reasons, and assignments to other dimensions do not.
  let positionalOnly = false;
  let position = 0;
  for (let index = 0; index < invocation.rest.length; index++) {
   const token = invocation.rest[index]!;
   if (!positionalOnly && token === "--") {
    positionalOnly = true;
    continue;
   }
   if (!positionalOnly && token.startsWith("-")) {
    const { flag, inline } = splitFlag(token);
    if (inline === undefined && SET_STATE_VALUE_FLAGS[flag] === true) index++;
    continue;
   }
   // The first two positionals are the subcommand and issue id.
   if (position++ < 2) continue;
   const match = /^state=([^=]+)$/.exec(token);
   if (match && SHEPHERD_DENIED_STATES[match[1]!.toLowerCase()] === true) return true;
  }
  return false;
 }
 if (invocation.subcommand === "label") {
  const args = claimTargets(invocation);
  if (args[0] !== "add" && args[0] !== "set" && args[0] !== "propagate") return false;
  return args.slice(1).some(value => value.split(",").some(label => {
   const normalized = label.trim().toLowerCase();
   return normalized.startsWith("state:") && SHEPHERD_DENIED_STATES[normalized.slice(6)] === true;
  }));
 }
 if (!["update", "create", "new"].includes(invocation.subcommand)) return false;
 for (let index = 0; index < invocation.rest.length; index++) {
  const token = invocation.rest[index]!;
  if (token === "--") break;
  let { flag, inline } = splitFlag(token);
  if (/^-[sl][^=]/.test(token)) {
   flag = token.slice(0, 2);
   inline = token.slice(2);
  }
  const status = flag === "--status" || flag === "-s";
  const labels = flag === "--add-label" || flag === "--set-labels" || flag === "--labels" || flag === "-l";
  if (status || labels) {
   const value = inline ?? invocation.rest[++index];
   if (value === undefined) continue;
   if (value.split(",").some(entry => {
    const normalized = entry.trim().toLowerCase();
    const state = status ? normalized : normalized.startsWith("state:") ? normalized.slice(6) : "";
    return SHEPHERD_DENIED_STATES[state] === true;
   })) return true;
  } else if (inline === undefined && BD_VALUE_FLAGS[flag] === true) {
   index++;
  }
 }
 return false;
}

/**
 * Refuse cross-role named claims and inspect named candidates for scope conflicts.
 * Queue claims are observed from their result and checked for conflicts before work.
 */
export async function gateClaimEligibility(
 claims: ClaimState,
 ctx: ExtensionContext,
 input: Record<string, unknown>,
): Promise<ToolCallEventResult | undefined> {
 const command = input.command;
 if (typeof command !== "string" || command.length === 0) return undefined;

 const invocations = bdInvocations(command);
 if (invocations.length === 0) return undefined;

 const sessionRoleName = orcRole(ctx);

 // Routing authority first, and across every invocation rather than the claiming ones: a
 // re-point rides `bd update`, which carries no `--claim` and would never reach the walk
 // below. Refusing before that walk also keeps a blocked command out of the claim record.
 for (const invocation of invocations) {
  if (sessionRoleName === "shepherd" && shepherdStateWrite(invocation)) {
   return { block: true, reason: "Shepherds may consume inherited approval and reporting states, but may not author approved, changes_requested, or reported states." };
  }
  const denial = routingWriteDenial(invocation, sessionRoleName);
  if (denial) return denial;
 }

 const claimInvocations = invocations.filter(invocation => invocation.hasClaim);
 if (claimInvocations.length === 0) return undefined;
 if (input.async === true) {
  return { block: true, reason: "Run claims in the foreground; background completion is not delivered to the claim observer." };
 }
 if (sessionRoleName !== undefined && (claimInvocations.length !== 1 || effectiveSegments(command).length !== 1)) {
  return { block: true, reason: "Run the claiming command alone so claim observation can bind; no pipelines or additional command leaves." };
 }
 for (const claim of claimInvocations) {
  const targets = claimTargets(claim);
  if (sessionRoleName !== undefined && claim.subcommand !== "ready" && targets.length !== 1) {
   return { block: true, reason: "A named claim must identify exactly one bead; finish or release it before claiming another." };
  }
  const previous = claims.observedClaim();
  if (previous === undefined) continue;
  const sameBead = targets.length === 1 && previous.beadIds.length === 1 && targets[0] === previous.beadIds[0];
  let live = false;
  for (const beadId of previous.beadIds) {
   const bead = await bdShow(beadId);
   if (bead === null || typeof bead.status !== "string" || (bead.status === "in_progress" && typeof bead.assignee !== "string")) {
    if (!sameBead) return { block: true, reason: `Cannot verify release of '${beadId}'; no new acquisition is permitted.` };
    live = true;
    continue;
   }
   if (bead.status === "in_progress" && bead.assignee === previous.actor) live = true;
  }
  if (live && !sameBead) {
   return { block: true, reason: `This activation still holds ${previous.beadIds.join(", ")}; finish or release it before another named or queue claim.` };
  }
  if (!live) claims.forgetClaim();
 }

 for (const claim of claimInvocations) {
  // `bd ready --claim` selects by filter rather than naming a bead. When the
  // filter already pins a role, compare against that and skip the lookup.
  if (claim.subcommand === "ready") {
   for (const filter of readyQueueRoles(claim.rest)) {
    if (sessionRoleName !== undefined && filter.role !== sessionRoleName) {
     return {
      block: true,
      reason: `queue '${filter.spelling}' does not match this session's role '${sessionRoleName}'; pull from your own queue`,
     };
    }
   }
   // Recording moved to the result: see src/claim-observer.ts. A claim's outcome is
   // not knowable here, and `bd ready --claim` names no bead at all.
   continue;
  }

  for (const beadId of claimTargets(claim)) {
   const bead = await bdShow(beadId);
   const routing = beadRouting(bead);

   // Unknown either side: allow. A bead with neither a routing stamp nor a legacy
   // label routes to no role, and a session with no declared role is a helper the
   // bead-write gate already sandboxes. The refusal quotes the carrier as written,
   // so a bead still routed by label says so in the message that refuses it.
   if (routing !== undefined && sessionRoleName !== undefined && routing.role !== sessionRoleName) {
    return {
     block: true,
     reason: `bead '${beadId}' is routed to ${routing.spelling}; this session is ${sessionRoleName} and may not claim it`,
    };
   }

   const conflict = await scopeConflict(bead);
   if (conflict) return conflict;
  }

 }

 return undefined;
}
