/**
 * G5 — claim eligibility.
 *
 * Beads enforces claim *exclusivity* — verified: two actors claiming the same queue
 * receive different beads and a third receives `[]` — but not *eligibility*. Any
 * actor may claim any bead, so nothing stops a reviewer claiming an implementation
 * task, or the lead claiming anything at all.
 *
 * This gate supplies eligibility. A role-marked session pulls only its own queue and
 * claims only a bead routed to its role, one bead at a time, with the claim report left
 * on stdout for the observer, while the run has capacity for another implementer claim,
 * and only where the candidate's scope is disjoint from every held code-writing claim
 * outside its own lineage. A session declaring no role under a marked run is the lead,
 * or a helper, and claims nothing but the run epic, whose assignee carries the lead
 * lease (`src/run-state.ts`). v19's `orchestrator-claim-deny.py` compared actor
 * names against a regex for "looks like a worker, not a lead", which a cooperative name
 * defeated; here the refusal keys on the absent `ORC-ROLE` marker and the run marker
 * `runScope` reads, neither of which the agent writes.
 *
 * Several checks are on writes rather than claims, because the write is where the
 * authority is spent: a routing re-point of `metadata.role`, a `merge_sha` stamped by a
 * role that never lands, a run-epic governance key rewritten from a role, a node filed
 * under a closed parent, a node closed without landing evidence, and an architect's
 * `scope` that overlaps a live node outside the bead's own lineage. Scope disjointness
 * is judged at decomposition and at claim, never per write: G2 compares each write
 * against the claimed territory and reads nothing else.
 *
 * Every refusal is on evidence. A `bd` that does not answer -- missing, slow, over
 * budget -- proves nothing, so the check that needed it logs the cause and lets the
 * command run; `bd` still enforces exclusivity on its own. Opacity the caller made is
 * not store uncertainty: a `--metadata` operand the shell fills in at run time is refused
 * because the check that needed it could never read it.
 *
 * It does not record the claim. Doing so from the command was wrong twice over: a
 * queue pull names no bead, and a named claim's outcome is unknown until it runs, so a
 * race loser recorded a bead it never held. `src/claim-observer.ts` reads the claim
 * report instead, and the worktree gate reads that.
 */

import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ToolCallEventResult } from "@oh-my-pi/pi-coding-agent";
import { logger } from "@oh-my-pi/pi-utils";
import type { BdBead } from "../bd";
import { bdCommentsChecked, bdFailureText, bdList, bdShow, bdShowMany, commentVerb, lastBdFailure, metadataRecord, metadataString } from "../bd";
import type { ClaimState } from "../claim-state";
import { beadRouting, legacyRoleFromLabel, orcRole, ROUTING_KEY } from "../identity";
import { runScope } from "../run-scope";
import { scopeOf, scopesOverlap } from "../scope";
import { BD_VALUE_FLAGS, type BdInvocation, bdInvocations, effectiveSegments, splitFlag } from "../shell";
import { resourceKind } from "./exit";

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

/**
 * The keys a metadata write flag's operand sets, with their values.
 *
 * `--metadata` takes JSON, the only form `create` accepts; `--set-metadata` takes
 * `key=value`. Both spellings are read for both flags: a `key=value` handed to
 * `--metadata` is a write bd rejects, and a JSON object handed to `--set-metadata` is one
 * bd stores under a nonsense key, but a matcher that knows only the documented pairing
 * is a matcher that can be walked past. Own keys only: `JSON.parse` output inherits
 * `Object.prototype`, so a map carrying no `role` key must read as carrying none.
 * Unparseable JSON is no write this gate can attribute, and bd will reject it.
 */
function metadataPairs(value: string): [string, unknown][] {
 if (value.trimStart().startsWith("{")) {
  const record = metadataRecord(value);
  return record === undefined ? [] : Object.entries(record);
 }
 const cut = value.indexOf("=");
 return cut === -1 ? [] : [[value.slice(0, cut), value.slice(cut + 1)]];
}

/** One metadata write flag on an invocation: the flag, its operand as written, and the keys it sets or clears. */
interface MetadataWrite {
 flag: string;
 /** The operand, or `undefined` when the flag has none: the shell took it (`--metadata $(cat f)`), or it is missing. */
 operand: string | undefined;
 keys: string[];
}

/**
 * Every metadata write this invocation performs.
 *
 * Reads `rest`, never `positionals`: the tokeniser consumes operands only for the global
 * flags it knows, so a write flag's operand can still be sitting in the positional list,
 * and matching there would both miss writes and invent them. Reading `rest` also makes the
 * `-C <run repo>` pin irrelevant to the match, which is the spelling every call carries.
 *
 * Three spellings write a key: `--set-metadata key=<v>`, `--unset-metadata key`, and
 * `--metadata` carrying the key. `--unset-metadata` is repeatable and comma-joinable, so
 * every key it names is listed. An operand that begins with `-` is the next flag, not a
 * value, so the write carries no operand.
 */
function metadataWrites(invocation: BdInvocation): MetadataWrite[] {
 const writes: MetadataWrite[] = [];
 for (let index = 0; index < invocation.rest.length; index++) {
  const { flag, inline } = splitFlag(invocation.rest[index] as string);
  if (METADATA_WRITE_FLAGS[flag] !== true) continue;
  const next = invocation.rest[index + 1];
  const operand = inline ?? (typeof next === "string" && !next.startsWith("-") ? next : undefined);
  if (operand === undefined) {
   writes.push({ flag, operand, keys: [] });
   continue;
  }
  const keys = flag === "--unset-metadata"
   ? operand.split(",").map(key => key.trim())
   : metadataPairs(operand).map(([key]) => key);
  writes.push({ flag, operand, keys });
 }
 return writes;
}

/** The write naming `key`, quoted as written, or `undefined` when the invocation writes no such key. */
function writeOf(invocation: BdInvocation, key: string): string | undefined {
 const write = metadataWrites(invocation).find(({ keys }) => keys.includes(key));
 if (write === undefined) return undefined;
 return write.flag === "--unset-metadata" ? `${write.flag} ${key}` : `${write.flag} ${write.operand}`;
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
 // Clearing counts as a write: a bead with no route reaches no queue.
 if (ROUTING_WRITE_EXEMPT[invocation.subcommand] === true) return undefined;
 const written = writeOf(invocation, ROUTING_KEY);
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

/** The metadata key the landing sweep stamps when a merge lands; the close check below reads it as proof. */
const LANDED_KEY = "merge_sha";

/** Roles that may write `merge_sha`: the shepherd's contract owns it (`shepherd.json`); every other contract denies it. */
const LANDING_WRITERS: Record<string, true> = { shepherd: true };

/**
 * Refuse a `merge_sha` stamped by a role that never lands anything.
 *
 * The close check reads `merge_sha` as landing evidence, so the key is proof only while a
 * role that cannot land cannot write it. The exit contracts already deny it to those roles
 * on the bead they claimed; this is the same denial at the write seam, for every bead.
 */
function landingWriteDenial(
 invocation: BdInvocation,
 sessionRoleName: string | undefined,
): ToolCallEventResult | undefined {
 if (sessionRoleName === undefined || LANDING_WRITERS[sessionRoleName] === true) return undefined;
 const written = writeOf(invocation, LANDED_KEY);
 if (written === undefined) return undefined;
 return {
  block: true,
  reason:
   `'${written}' stamps metadata.${LANDED_KEY}, which is the landing sweep's record that a merge landed, and ` +
   `${sessionRoleName} does not land work. The sweep stamps it when the PR merges; a node without it is not landed.`,
 };
}

/** Maximum number of parent links traversed while checking claim lineage. */
const MAX_LINEAGE_DEPTH = 3;

/** Parent fields emitted by different `bd --json` shapes. */
function parentId(bead: BdBead | null): string | undefined {
 for (const field of ["parent", "parent_id"] as const) {
  const value = bead?.[field];
  if (typeof value === "string" && value.length > 0) return value;
  if (value !== null && typeof value === "object" && typeof (value as { id?: unknown }).id === "string") {
   return (value as { id: string }).id;
  }
 }
 return undefined;
}

/**
 * A bead's ancestry as far as the guard reads it.
 *
 * `complete` is false when a link could not be read -- budget spent, database slow,
 * parent unreadable -- so the set is a prefix of the lineage rather than the lineage. A
 * caller must not read an absent ancestor off a truncated set as "unrelated".
 */
interface Lineage {
 ancestors: Set<string>;
 complete: boolean;
}

/**
 * The ancestries of several beads at once, walked one generation at a time.
 *
 * Each seed is the first ancestor of one chain: a bead's own `parent`, or the parent a
 * bead not yet created is filed under; `undefined` seeds an empty chain. `graph` holds
 * rows already in hand -- `bd list --json` emits `parent` on every row that has one and
 * omits the key otherwise (measured on bd 1.2.2), so the in-flight list resolves most
 * links without a read. The ancestors every chain still needs at a depth are read
 * together, in one `bd list --id`, so the walk costs at most `MAX_LINEAGE_DEPTH - 1`
 * reads however many chains it carries, and the rows it reads join the graph.
 *
 * The guard's own horizon: an ancestor beyond it would be discarded, so the last
 * ancestor kept is never read for its parent.
 */
async function parentChains(seeds: readonly (string | undefined)[], graph: Map<string, BdBead>): Promise<Lineage[]> {
 const chains = seeds.map(seed => ({ ancestors: new Set<string>(), complete: true, next: seed }));
 for (let depth = 0; ; depth++) {
  for (const chain of chains) {
   if (chain.next === undefined) continue;
   if (chain.ancestors.has(chain.next)) {
    chain.next = undefined;
    continue;
   }
   chain.ancestors.add(chain.next);
  }
  if (depth + 1 >= MAX_LINEAGE_DEPTH) break;
  const wanted = new Set<string>();
  for (const chain of chains) {
   if (chain.next !== undefined && !graph.has(chain.next)) wanted.add(chain.next);
  }
  if (wanted.size > 0) {
   const rows = await bdShowMany([...wanted]);
   if (rows === null) {
    for (const chain of chains) {
     if (chain.next !== undefined) chain.complete = false;
    }
    break;
   }
   for (const [id, row] of rows) graph.set(id, row);
  }
  let walking = false;
  for (const chain of chains) {
   if (chain.next === undefined) continue;
   const row = graph.get(chain.next);
   if (row === undefined) {
    // The link exists but its bead does not answer: a prefix, not the lineage.
    chain.complete = false;
    chain.next = undefined;
    continue;
   }
   chain.next = parentId(row);
   walking ||= chain.next !== undefined;
  }
  if (!walking) break;
 }
 return chains.map(({ ancestors, complete }) => ({ ancestors, complete }));
}

/** A promise computed on first call and shared by every later one. */
function once<T>(compute: () => Promise<T>): () => Promise<T> {
 let pending: Promise<T> | undefined;
 return () => (pending ??= compute());
}

/**
 * The `orc-node` beads in the named statuses, or `undefined` when the list could not be
 * read. `bdList` answers `[]` for a failed read as for an empty one; the recorded failure
 * kind tells them apart, and an unreadable list is logged and fails open.
 */
async function listNodes(statuses: string, check: string): Promise<BdBead[] | undefined> {
 const beads = await bdList(["list", "--label", "orc-node", "--status", statuses, "--limit", "0", "--json"]);
 if (beads.length === 0) {
  const failure = lastBdFailure();
  if (failure !== undefined) {
   logger.warn(`orchestrate G5: live beads could not be listed; ${check} skipped`, { cause: bdFailureText(failure) });
   return undefined;
  }
 }
 return beads;
}

/** Roles whose beads hold no territory: they read a scope, and write nothing under it. */
const READ_ONLY_ROLES: Record<string, true> = { researcher: true, reviewer: true };

/** A bead's claim on territory, as friction is judged for it. */
interface Territory {
 /** Set for an existing bead: it is not its own peer, and its descendants are exempt. */
 id: string | undefined;
 scope: string[];
 /** The first ancestor: the bead's parent, or the parent a new bead is filed under. */
 parent: string | undefined;
}

/** The peer an overlap was found with, quoted back in the refusal. */
interface Overlap {
 id: string;
 scope: string[];
}

/**
 * The first peer whose scope overlaps `subject` outside its lineage, or `undefined`.
 *
 * Read-only roles and a bead's own lineage keep their envelopes without reserving
 * territory: a feature's envelope is intentionally the union of its tasks, so neither
 * side of that parent/child relationship is friction. An unrelated architect envelope
 * still counts. With `heldOnly`, a peer nobody holds is no peer, which is the claim-time
 * reading; decomposition reads every live node, held or waiting.
 *
 * Reads are spent only where a verdict needs them. A peer whose scope is empty or
 * disjoint costs nothing, because lineage is purely an exemption for an overlap. Only
 * when some peer overlaps is lineage read, and then once for the subject and every
 * overlapping peer together, through {@link parentChains}, so the cost does not grow
 * with the number of peers.
 */
async function overlappingPeer(subject: Territory, peers: readonly BdBead[], heldOnly: boolean): Promise<Overlap | undefined> {
 const overlapping: { peer: BdBead; scope: string[] }[] = [];
 for (const other of peers) {
  if (other.id === subject.id) continue;
  if (heldOnly && (typeof other.assignee !== "string" || other.assignee.trim().length === 0)) continue;
  const otherRole = beadRouting(other)?.role;
  if (otherRole !== undefined && READ_ONLY_ROLES[otherRole] === true) continue;
  const otherScope = scopeOf(metadataRecord(other.metadata));
  if (otherScope.length === 0) continue;
  if (!scopesOverlap(subject.scope, otherScope)) continue;
  overlapping.push({ peer: other, scope: otherScope });
 }
 if (overlapping.length === 0) return undefined;
 // A bead not yet created has no descendants, so the peers' chains are not consulted.
 const peerSeeds = subject.id === undefined ? [] : overlapping.map(({ peer }) => parentId(peer));
 const [mine, ...theirs] = await parentChains([subject.parent, ...peerSeeds], new Map(peers.map(peer => [peer.id, peer])));
 for (const [index, { peer, scope }] of overlapping.entries()) {
  if (mine!.ancestors.has(peer.id)) continue;
  let complete = mine!.complete;
  if (subject.id !== undefined) {
   const chain = theirs[index]!;
   if (chain.ancestors.has(subject.id)) continue;
   complete &&= chain.complete;
  }
  if (!complete) {
   // An overlap whose lineage could not be read is unknown, not unrelated: refusing it
   // would turn a slow database into a false conflict between a feature and its own
   // task. Unknown fails open, as every gate's unreadable evidence does.
   logger.warn("orchestrate scope friction unresolved: lineage unreadable", {
    bead: subject.id,
    other: peer.id,
    cause: bdFailureText(lastBdFailure()),
   });
   continue;
  }
  return { id: peer.id, scope };
 }
 return undefined;
}

/**
 * Exclusive scope friction between held code-writing claims, judged once, at claim.
 * Read-only roles reserve nothing on either side.
 */
async function scopeConflict(bead: BdBead, inFlight: () => Promise<BdBead[] | undefined>): Promise<ToolCallEventResult | undefined> {
 const role = beadRouting(bead)?.role;
 if (role !== undefined && READ_ONLY_ROLES[role] === true) return undefined;
 const candidate = scopeOf(metadataRecord(bead.metadata));
 if (candidate.length === 0) return undefined;
 const peers = await inFlight();
 if (peers === undefined) return undefined;
 const overlap = await overlappingPeer({ id: bead.id, scope: candidate, parent: parentId(bead) }, peers, true);
 if (overlap === undefined) return undefined;
 return {
  block: true,
  reason:
   `scope conflict (friction guard): '${bead.id}' [${candidate.join(", ")}] overlaps in-flight ` +
   `'${overlap.id}' [${overlap.scope}]. Two agents must not share a file; wait for ` +
   `'${overlap.id}' to report, or re-scope one of the beads.`,
 };
}

/** Subcommands that file or amend a bead, and so may write its `scope`. */
const SCOPE_WRITERS: Record<string, true> = { create: true, new: true, update: true };

/** The `scope` a `create` or `update` writes, and the routing written beside it. */
interface ScopeWrite {
 scope: string[];
 role: string | undefined;
}

/** The scope this invocation stamps, through `--metadata` or `--set-metadata`, or `undefined`. */
function scopeWrite(invocation: BdInvocation): ScopeWrite | undefined {
 if (SCOPE_WRITERS[invocation.subcommand] !== true) return undefined;
 let scope: string[] | undefined;
 let role: string | undefined;
 for (const { flag, operand } of metadataWrites(invocation)) {
  if (flag === "--unset-metadata" || operand === undefined) continue;
  for (const [key, written] of metadataPairs(operand)) {
   if (key === "scope") scope = scopeOf({ scope: written });
   else if (key === ROUTING_KEY && typeof written === "string") role = written;
  }
 }
 return scope === undefined ? undefined : { scope, role };
}

/** Text the shell fills in at run time: a parameter, a command substitution, a backquote. */
const SHELL_EXPANSION = /[$`]/;

/**
 * The metadata operand of a `create` or `update` the overlap check cannot read, quoted as
 * written, or `undefined` when every operand is literal.
 *
 * The tokeniser strips quotes and keeps `$`, so `--metadata "$M"` arrives as `$M`, a
 * quoted `$(cat <<EOF ...)` arrives whole, and an unquoted substitution splits the
 * segment and leaves the flag with no operand at all. `@file` puts the payload in a file
 * this gate does not open. Malformed JSON names no key. Each is a scope the check would
 * read as absent, which is how two siblings with identical scopes both landed.
 *
 * Judged per key where the key is literal: `--set-metadata worktree=$WT` names a key the
 * overlap check never reads, so it passes; a `scope` whose globs carry an expansion, or an
 * operand whose key is itself the expansion, does not.
 */
function opaqueMetadataOperand(invocation: BdInvocation): string | undefined {
 if (SCOPE_WRITERS[invocation.subcommand] !== true) return undefined;
 for (const { flag, operand } of metadataWrites(invocation)) {
  if (flag === "--unset-metadata") continue;
  if (operand === undefined) return flag;
  const written = `${flag} ${operand}`;
  if (operand.startsWith("@")) return written;
  if (operand.trimStart().startsWith("{")) {
   const record = metadataRecord(operand);
   if (record === undefined) return written;
   if (scopeOf(record).some(glob => SHELL_EXPANSION.test(glob))) return written;
   continue;
  }
  const cut = operand.indexOf("=");
  if (cut === -1 || SHELL_EXPANSION.test(operand.slice(0, cut))) return written;
  if (operand.slice(0, cut) === "scope" && SHELL_EXPANSION.test(operand.slice(cut + 1))) return written;
 }
 return undefined;
}

/**
 * Refuse a decomposition write whose scope the overlap check cannot read.
 *
 * Self-inflicted opacity, not store uncertainty: the store answered nothing because it was
 * asked nothing. Literal JSON is what the check compares, so literal JSON is what the
 * architect writes.
 */
function opaqueScopeDenial(invocation: BdInvocation): ToolCallEventResult | undefined {
 const written = opaqueMetadataOperand(invocation);
 if (written === undefined) return undefined;
 return {
  block: true,
  reason:
   `'${written}' is not a literal: scope must be literal for the overlap check. The shell fills that ` +
   `operand in when the command runs, so the gate cannot compare the scope it carries against live ` +
   `siblings, and two beads with the same scope would both land. Write the JSON inline, e.g. ` +
   `--metadata '{"role":"implementer","scope":["src/api/**"]}'.`,
 };
}

/** The operand of the first `--parent` on the invocation, in either spelling. */
function parentFlag(invocation: BdInvocation): string | undefined {
 for (let index = 0; index < invocation.rest.length; index++) {
  const { flag, inline } = splitFlag(invocation.rest[index] as string);
  if (flag !== "--parent") continue;
  const value = inline ?? invocation.rest[index + 1];
  if (typeof value === "string" && !value.startsWith("-")) return value;
 }
 return undefined;
}

/** Subcommands that file a new bead, and so may name a `--parent`. */
const FILING_SUBCOMMANDS: Record<string, true> = { create: true, new: true };

/**
 * Refuse a node filed under a closed parent by a role that does not decompose.
 *
 * A closed feature is finished work; a task filed beneath it reaches the ready queue and
 * is pulled as if the feature were live, with no architect having planned it. The
 * architect may reopen or re-parent, so its filings pass. Fails open, and says why, when
 * the parent cannot be read.
 */
async function closedParentDenial(
 invocation: BdInvocation,
 sessionRoleName: string | undefined,
): Promise<ToolCallEventResult | undefined> {
 if (sessionRoleName === undefined || ROUTING_WRITERS[sessionRoleName] === true) return undefined;
 if (FILING_SUBCOMMANDS[invocation.subcommand] !== true) return undefined;
 const parent = parentFlag(invocation);
 if (parent === undefined) return undefined;
 const bead = await bdShow(parent);
 if (bead === null) {
  logger.warn("orchestrate G5: parent of the new bead could not be read; closed-parent check skipped", {
   bead: parent,
   cause: bdFailureText(lastBdFailure()),
  });
  return undefined;
 }
 if ((bead.status ?? "").toLowerCase() !== "closed") return undefined;
 return {
  block: true,
  reason:
   `'${parent}' is closed, and ${sessionRoleName} may not file work under a closed bead: a child there ` +
   `reaches the ready queue as if the parent were live, with nobody having planned it. File under the ` +
   `open epic or feature you work in, or raise an escalation wisp for the architect to re-plan.`,
 };
}

/** Bead types that are nodes of the work graph: the ones landing closes. */
const NODE_TYPES: Record<string, true> = { task: true, feature: true };

/** Resource kinds whose evidence is accepted at review and closed as dismissed, never landed. */
const NON_GIT_KINDS: Record<string, true> = { artifact: true, comment: true, external: true };

/**
 * Whether closing this bead needs landing evidence: a task or feature that is neither a
 * wisp nor a merge bead, and whose work is git-delivered. A wisp is closed by the reviewer
 * or researcher that answered it, a merge bead by the shepherd, and non-git evidence is
 * accepted at review and closed as dismissed (`references/lifecycle.md`). An undeclared
 * kind is git: that is the default the exit contract judges, and the case the fake close
 * was found in.
 */
function closeNeedsLandingEvidence(bead: BdBead): boolean {
 if (typeof bead.issue_type !== "string" || NODE_TYPES[bead.issue_type] !== true) return false;
 if (bead.ephemeral === true || bead.wisp_type !== undefined) return false;
 if ((bead.labels ?? []).includes("pr:merge")) return false;
 const kind = resourceKind(bead);
 return kind === undefined || NON_GIT_KINDS[kind] !== true;
}

/** The beads an invocation closes: `bd close <id>...`, or `bd update <id>... --status closed` in any spelling. */
function closedTargets(invocation: BdInvocation): string[] {
 if (invocation.subcommand === "close") return claimTargets(invocation);
 if (invocation.subcommand !== "update") return [];
 for (let index = 0; index < invocation.rest.length; index++) {
  const token = invocation.rest[index] as string;
  if (token === "--") break;
  let { flag, inline } = splitFlag(token);
  if (/^-s[^=]/.test(token)) {
   flag = "-s";
   inline = token.slice(2);
  }
  if (flag !== "--status" && flag !== "-s") continue;
  const value = inline ?? invocation.rest[index + 1];
  if (typeof value === "string" && value.trim().toLowerCase() === "closed") return claimTargets(invocation);
 }
 return [];
}

/**
 * Refuse a role closing a node that nothing landed.
 *
 * Found by a run in which an architect closed two tasks `--reason merged` with no
 * reviewer, no PR, and main unchanged. A node is closed by the landing sweep when its
 * merge lands, or by the lead by hand; a role closes it only once the bead itself carries
 * the landing: `metadata.merge_sha`, or a `LANDED` comment. The sweep writes both on the
 * merge bead and `LANDED` on the origin feature. Fails open, and says why, when the bead
 * or its comments cannot be read.
 */
async function closeDenial(
 invocation: BdInvocation,
 sessionRoleName: string | undefined,
): Promise<ToolCallEventResult | undefined> {
 if (sessionRoleName === undefined) return undefined;
 for (const id of closedTargets(invocation)) {
  const bead = await bdShow(id);
  if (bead === null) {
   logger.warn("orchestrate G5: bead being closed could not be read; landing evidence check skipped", {
    bead: id,
    cause: bdFailureText(lastBdFailure()),
   });
   continue;
  }
  if (!closeNeedsLandingEvidence(bead)) continue;
  if (metadataString(bead, LANDED_KEY) !== undefined) continue;
  const comments = await bdCommentsChecked(id);
  if (comments === null) {
   logger.warn("orchestrate G5: comments of the bead being closed could not be read; landing evidence check skipped", {
    bead: id,
    cause: bdFailureText(lastBdFailure()),
   });
   continue;
  }
  if (comments.some(comment => commentVerb(comment.text) === "LANDED")) continue;
  return {
   block: true,
   reason:
    `'${id}' (${bead.issue_type}) carries no landing evidence: neither metadata.${LANDED_KEY} nor a LANDED ` +
    `comment, and ${sessionRoleName} may not close a node nothing landed. The landing sweep writes both ` +
    `when the PR merges; a review alone does not close a node. Hand off with REPORTED and the next role's ` +
    `agent: label, and leave the close to the sweep or the lead.`,
  };
 }
 return undefined;
}

/**
 * Refuse an architect's `scope` that overlaps a live node outside the bead's own lineage.
 *
 * Disjoint scopes written at decomposition are the mechanism behind every later check:
 * the claim-time friction guard and G2's territory both assume them. So the write is
 * where the overlap is caught, with the peer named, while the architect still has the
 * plan in hand. Lineage is exempt in both directions -- a feature's envelope is the
 * union of its tasks -- and read-only roles reserve nothing on either side.
 *
 * Fails open on every read that does not answer: the bead being amended, the parent a
 * new bead is filed under, the live-node list. Each is logged with its cause.
 */
async function decompositionConflict(invocation: BdInvocation): Promise<ToolCallEventResult | undefined> {
 const written = scopeWrite(invocation);
 if (written === undefined || written.scope.length === 0) return undefined;

 let subject: Territory;
 let role = written.role;
 if (invocation.subcommand === "update") {
  const [id] = claimTargets(invocation);
  if (id === undefined) return undefined;
  const bead = await bdShow(id);
  if (bead === null) {
   logger.warn("orchestrate G5: bead being re-scoped could not be read; overlap check skipped", {
    bead: id,
    cause: bdFailureText(lastBdFailure()),
   });
   return undefined;
  }
  role ??= beadRouting(bead)?.role;
  subject = { id, scope: written.scope, parent: parentId(bead) };
 } else {
  subject = { id: undefined, scope: written.scope, parent: parentFlag(invocation) };
 }
 if (role !== undefined && READ_ONLY_ROLES[role] === true) return undefined;

 const peers = await listNodes("open,in_progress", "scope overlap check");
 if (peers === undefined) return undefined;
 const overlap = await overlappingPeer(subject, peers, false);
 if (overlap === undefined) return undefined;
 const named = subject.id === undefined ? "the new bead's" : `'${subject.id}'s`;
 return {
  block: true,
  reason:
   `${named} scope [${written.scope.join(", ")}] overlaps live node '${overlap.id}' [${overlap.scope.join(", ")}]. ` +
   `Scopes are disjoint at decomposition, or serialised with a dependency: narrow one of the two, or make ` +
   `this bead depend on '${overlap.id}'.`,
 };
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

/**
 * Whether the shell would take the claim report off stdout, or merge stderr into it.
 *
 * The observer reads the report from stdout (`src/claim-observer.ts`); a merged stderr
 * interleaves bd's warnings with the JSON, and `>&2` or `&>file` moves the report where
 * the observer never looks. `2>/dev/null` and `>file` leave stdout alone: the first
 * discards what is not read, and the second is the caller's to recover from.
 */
function displacesReport(claim: BdInvocation): boolean {
 return claim.redirections.some(redirection => redirection.includes(">&") || redirection.startsWith("&>"));
}

/** An input redirection whose target is a bare word: what `<epic>` becomes once the shell reads the `<`. */
const BARE_INPUT_REDIRECTION = /^<([A-Za-z][\w.-]*)$/;

/**
 * The angle-bracketed placeholder a command carried, as the user wrote it, or `undefined`.
 *
 * `bd ready --parent <epic> --metadata-field role=implementer` tokenises `<epic` as an
 * input redirection and `>--metadata-field` as an output redirection, so the role filter
 * is gone from argv before any gate reads it. The refusal for a queue that names no role
 * is then accurate and useless; naming the placeholder tells the reader what happened.
 */
function placeholderRedirection(claim: BdInvocation): string | undefined {
 const { redirections } = claim;
 for (let index = 0; index + 1 < redirections.length; index++) {
  const word = BARE_INPUT_REDIRECTION.exec(redirections[index] as string)?.[1];
  if (word !== undefined && (redirections[index + 1] as string).startsWith(">")) return `<${word}>`;
 }
 return undefined;
}

/** Run id an activated, not yet bound, marker carries. It names no epic. */
const PENDING_RUN = "pending";

/**
 * The epic the active-run marker binds this session to, or `undefined` when there is
 * none. The one root `runScope` reads: an isolated copy carries the primary checkout's
 * marker. A malformed marker is no run.
 */
async function boundEpic(cwd: string): Promise<string | undefined> {
 const scope = await runScope({ cwd });
 if (scope === null || scope.runId === PENDING_RUN) return undefined;
 return scope.runId;
}

/**
 * Whether every claim in the command names the run epic and nothing else. The epic's
 * assignee carries the lead lease (`src/run-state.ts`), so `bd update <epic> --claim` is
 * the lead's one claim; a queue pull or any other bead is still a work claim.
 */
async function leadLeaseClaim(claimInvocations: readonly BdInvocation[], cwd: string): Promise<boolean> {
 const epic = await boundEpic(cwd);
 if (epic === undefined) return false;
 return claimInvocations.every(claim => {
  const targets = claimTargets(claim);
  return targets.length === 1 && targets[0] === epic;
 });
}

/** Implementer claims a run admits at once when its epic names no `max_inflight`. */
const DEFAULT_MAX_INFLIGHT = 8;

/**
 * The one role whose claim the governor counts and caps.
 *
 * An architect's claim is its epic, held for integration and coordination while its
 * workers write code; counting it as a code-writing claim deadlocked a run at
 * `max_inflight=1`, where the architect's own epic claim filled the one slot and no
 * implementer could ever claim. Reviewers and researchers read alongside without
 * consuming capacity.
 */
const GOVERNED_ROLE = "implementer";

/**
 * How many implementer claims the run admits at once: `metadata.max_inflight` on the
 * run epic, or the default when the epic is silent or names nonsense. `undefined` when
 * there is no bound epic or it could not be read, which is logged.
 */
async function inflightCap(cwd: string): Promise<number | undefined> {
 const epicId = await boundEpic(cwd);
 if (epicId === undefined) return undefined;
 const epic = await bdShow(epicId);
 if (epic === null) {
  logger.warn("orchestrate G5: run epic could not be read; capacity check skipped", {
   epic: epicId,
   cause: bdFailureText(lastBdFailure()),
  });
  return undefined;
 }
 const raw = metadataRecord(epic.metadata)?.max_inflight;
 const cap = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
 return Number.isInteger(cap) && cap > 0 ? cap : DEFAULT_MAX_INFLIGHT;
}

/**
 * Held implementer claims: in progress, assigned, routed to the implementer. This
 * session's own beads are excluded, so a same-bead retry at the cap is not refused for
 * the bead it already holds.
 */
function implementerClaims(inFlight: readonly BdBead[], own: readonly string[]): number {
 let count = 0;
 for (const bead of inFlight) {
  if (own.includes(bead.id)) continue;
  if (bead.status !== "in_progress") continue;
  if (typeof bead.assignee !== "string" || bead.assignee.trim().length === 0) continue;
  if (beadRouting(bead)?.role === GOVERNED_ROLE) count++;
 }
 return count;
}

/**
 * Refuse an implementer claim while the run is at capacity.
 *
 * The cap bounds concurrent implementer claims, so it is read for claims that would be
 * one: a reviewer's or architect's claim at the cap is not what the cap is for, and
 * refusing it would stall the reviews and integration that let implementers finish. Reads
 * the epic once and the in-flight list once, shared with the friction check that follows.
 */
async function capacityRefusal(
 cwd: string | undefined,
 own: readonly string[],
 inFlight: () => Promise<BdBead[] | undefined>,
): Promise<ToolCallEventResult | undefined> {
 if (cwd === undefined) return undefined;
 const cap = await inflightCap(cwd);
 if (cap === undefined) return undefined;
 const peers = await inFlight();
 if (peers === undefined) return undefined;
 const held = implementerClaims(peers, own);
 if (held < cap) return undefined;
 return {
  block: true,
  reason: `run at capacity (${held}/${cap} implementer claims held; architect epic claims are not counted); retry`,
 };
}

/**
 * Run-epic metadata the lead alone writes: the governor's cap, the landing record and
 * its state, the lead's identity and lease, and the base the exit contract compares a
 * worker's head against. `landing` matches as a prefix: `landing`, `landing_state`, and
 * whatever the sweep records next.
 */
const GOVERNANCE_KEYS: Record<string, true> = { max_inflight: true, lead_actor: true, lease_until: true, base_sha: true };
const GOVERNANCE_PREFIX = "landing";

function governanceKey(key: string): boolean {
 return GOVERNANCE_KEYS[key] === true || key.startsWith(GOVERNANCE_PREFIX);
}

/**
 * Refuse a role rewriting the run epic's governance metadata.
 *
 * Found by a run in which an architect, refused at `max_inflight=1`, raised the cap to 2
 * and then 3 on the run epic and was never refused. The cap is the operator's; a role that
 * meets it retries. Read only for an `update` that names a governance key, so an ordinary
 * write spends no marker read. Fails open outside a bound run: there is no run epic to
 * protect.
 */
async function governanceWriteDenial(
 invocation: BdInvocation,
 sessionRoleName: string | undefined,
 cwd: string | undefined,
): Promise<ToolCallEventResult | undefined> {
 if (sessionRoleName === undefined || cwd === undefined || invocation.subcommand !== "update") return undefined;
 const write = metadataWrites(invocation).find(({ keys }) => keys.some(governanceKey));
 if (write === undefined) return undefined;
 const epic = await boundEpic(cwd);
 if (epic === undefined || !claimTargets(invocation).includes(epic)) return undefined;
 const key = write.keys.find(governanceKey) as string;
 const written = write.flag === "--unset-metadata" ? `${write.flag} ${key}` : `${write.flag} ${write.operand}`;
 return {
  block: true,
  reason:
   `'${written}' rewrites metadata.${key} on the run epic '${epic}', which governs the run, and ${sessionRoleName} ` +
   `may not change it. max_inflight, landing*, lead_actor, lease_until and base_sha are the lead's: a role that ` +
   `meets the cap retries, and a run that needs another cap asks the operator.`,
 };
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
 if (invocation.subcommand === "label" || invocation.subcommand === "tag") {
  // `bd label add|set|propagate <id> <label>...` spells the write out; `bd tag <id>
  // <label>` is bd's documented shorthand for `bd update <id> --add-label <label>` and
  // must land on the same branch, or the alias walks past the denial.
  const args = claimTargets(invocation);
  if (invocation.subcommand === "label" && args[0] !== "add" && args[0] !== "set" && args[0] !== "propagate") return false;
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
 const cwd = typeof ctx.cwd === "string" && ctx.cwd.length > 0 ? ctx.cwd : undefined;

 // Write authority first, and across every invocation rather than the claiming ones: a
 // re-point, a re-scope, a governance rewrite or a close rides `bd update`, which carries
 // no `--claim` and would never reach the walk below. Refusing before that walk also keeps
 // a blocked command out of the claim record. Parse-only checks run before any that reads
 // the store, so a refusal on the command's own text spends no read.
 for (const invocation of invocations) {
  if (sessionRoleName === "shepherd" && shepherdStateWrite(invocation)) {
   return { block: true, reason: "Shepherds may consume inherited approval and reporting states, but may not author approved, changes_requested, or reported states." };
  }
  const denial = routingWriteDenial(invocation, sessionRoleName) ?? landingWriteDenial(invocation, sessionRoleName);
  if (denial) return denial;
  if (sessionRoleName === "architect") {
   const opaque = opaqueScopeDenial(invocation);
   if (opaque) return opaque;
  }
  const governance = await governanceWriteDenial(invocation, sessionRoleName, cwd);
  if (governance) return governance;
  const closedParent = await closedParentDenial(invocation, sessionRoleName);
  if (closedParent) return closedParent;
  const close = await closeDenial(invocation, sessionRoleName);
  if (close) return close;
  if (sessionRoleName === "architect") {
   const overlap = await decompositionConflict(invocation);
   if (overlap) return overlap;
  }
 }

 const claimInvocations = invocations.filter(invocation => invocation.hasClaim);
 if (claimInvocations.length === 0) return undefined;
 if (sessionRoleName === undefined && cwd !== undefined && (await runScope(ctx)) !== null && !(await leadLeaseClaim(claimInvocations, cwd))) {
  return { block: true, reason: "the lead never claims work beads; dispatch a worker through its queue" };
 }
 if (input.async === true) {
  return { block: true, reason: "Run claims in the foreground; background completion is not delivered to the claim observer." };
 }
 if (sessionRoleName !== undefined && (claimInvocations.length !== 1 || effectiveSegments(command).length !== 1)) {
  return { block: true, reason: "Run the claiming command alone so claim observation can bind; no pipelines or additional command leaves." };
 }
 for (const claim of claimInvocations) {
  if (sessionRoleName !== undefined && displacesReport(claim)) {
   return { block: true, reason: "the claim report is read from stdout; do not merge stderr into it" };
  }
  const targets = claimTargets(claim);
  if (sessionRoleName !== undefined && claim.subcommand !== "ready" && targets.length !== 1) {
   return {
    block: true,
    reason: targets.length === 0
     ? "A named claim must identify exactly one bead: 'bd update <id> --claim --json'."
     : `'bd ${claim.subcommand} --claim' names ${targets.length} beads (${targets.join(", ")}); one activation owns at ` +
      `most one bead. Claim '${targets[0]}', finish or release it, then claim the next: parallel work belongs to ` +
      `parallel agents, not parallel claims.`,
   };
  }
  const previous = claims.observedClaim();
  if (previous === undefined) continue;
  const sameBead = targets.length === 1 && previous.beadIds.length === 1 && targets[0] === previous.beadIds[0];
  let live = false;
  for (const beadId of previous.beadIds) {
   const bead = await bdShow(beadId);
   if (bead === null || typeof bead.status !== "string") {
    // Unknown is not held: refusing here sent a worker whose store hiccuped to "refresh
    // ownership" it had already released. The claim is forgotten as a release would be;
    // a same-bead retry keeps it, because that retry is the recovery of this very bead.
    if (sameBead) live = true;
    else {
     logger.warn("orchestrate G5: held bead could not be read; allowing the new claim", {
      bead: beadId,
      cause: bead === null ? bdFailureText(lastBdFailure()) : "its status is unreadable",
     });
    }
    continue;
   }
   if (bead.status === "in_progress" && bead.assignee === previous.actor) live = true;
  }
  if (live && !sameBead) {
   return { block: true, reason: `This activation still holds ${previous.beadIds.join(", ")}; finish or release it before another named or queue claim.` };
  }
  if (!live) claims.forgetClaim();
 }

 const inFlight = once(() => listNodes("in_progress", "capacity and friction checks"));
 const own = claims.observedClaim()?.beadIds ?? [];
 for (const claim of claimInvocations) {
  // `bd ready --claim` selects by filter rather than naming a bead. When the
  // filter already pins a role, compare against that and skip the lookup.
  if (claim.subcommand === "ready") {
   const filters = readyQueueRoles(claim.rest);
   // Beads hands an unfiltered pull "the first ready issue", whatever role routes it,
   // and after the pull nothing compares the bead's routing to the session's: G2 scopes
   // to it and G4 judges it under the session's contract. So a role-marked session
   // must name its queue. A role-less session outside a run is a plain user of bd.
   if (sessionRoleName !== undefined && filters.length === 0) {
    const placeholder = placeholderRedirection(claim);
    return {
     block: true,
     reason: placeholder === undefined
      ? `queue pull must name your role: add --metadata-field ${ROUTING_KEY}=${sessionRoleName} to the bd ready command`
      : `'${placeholder}' was parsed as a redirection, not as an operand: angle brackets are shell syntax, so the ` +
       `flags after it were taken as file names and the command names no queue. Replace the placeholder with the ` +
       `real id, e.g. --parent orc-run, and keep --metadata-field ${ROUTING_KEY}=${sessionRoleName}.`,
    };
   }
   for (const filter of filters) {
    if (sessionRoleName !== undefined && filter.role !== sessionRoleName) {
     return {
      block: true,
      reason: `queue '${filter.spelling}' does not match this session's role '${sessionRoleName}'; pull from your own queue`,
     };
    }
   }
   if (sessionRoleName === GOVERNED_ROLE) {
    const capacity = await capacityRefusal(cwd, own, inFlight);
    if (capacity) return capacity;
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

   if (sessionRoleName === GOVERNED_ROLE) {
    const capacity = await capacityRefusal(cwd, own, inFlight);
    if (capacity) return capacity;
   }

   if (bead === null) continue;
   const conflict = await scopeConflict(bead, inFlight);
   if (conflict) return conflict;
  }
 }

 return undefined;
}
