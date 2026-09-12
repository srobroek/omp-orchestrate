/**
 * `orc_run_status` — the standardised run status report.
 *
 * Originally a Python reporting script in the orchestrate skill; the shape is kept so a
 * reader compares runs instead of re-learning a format. A run epic rolls up through its
 * architect-domain epics and their features to the tasks, and the report names what is
 * claimable now, what is active, and what is blocked.
 *
 * `bd blocked` supplies the blocked set directly rather than walking the dependency
 * graph, because it already resolves which of a bead's dependencies are still open.
 *
 * Reads only. Never mutates a bead, and — per `bd.ts`'s doctrine — never throws:
 * a missing binary or a stalled read resolves to an error-flagged result.
 */

import type { AgentToolResult, ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { type BdBead, bdBlockedChecked, bdListChecked, metadataString, resetReadBudget } from "../bd";

/**
 * A bead's derived lifecycle state.
 *
 * The built-ins are `closed`, `deferred`, `blocked`, `active`, `claimed`, `ready`
 * and `unknown`. A `state:` label contributes its own value verbatim, because the
 * lifecycle phases a role reports (`reported`, `in_review`, `approved`, …) are not
 * bd statuses and are project-defined.
 */
export type BeadState = string;

/** How many beads sit in each state. Keyed by {@link BeadState}. */
export type Counts = Record<BeadState, number>;

/** One bead, flattened to what the report prints. */
export interface StatusNode {
 id: string;
 title: string;
 /** `issue_type` as bd reported it, or `""` when it named none. */
 type: string;
 state: BeadState;
 assignee?: string;
 /** `metadata.actor`: the acting identity dispatch stamped on this bead; holds it even when the claim set no assignee. */
 actor?: string;
 /** `metadata.role`: who this routes to while it is still unclaimed. */
 role?: string;
 /** `metadata.run_epic`: the run epic this bead was poured under. */
 run_epic?: string;
 /** `metadata.origin_actor`: the actor handle a bounce or report routes back to. */
 origin_actor?: string;
 /** `metadata.origin_bead`: the bead id a bounce or report routes back to. */
 origin_bead?: string;
 /**
  * Legacy `metadata.origin`, carried verbatim under its own name. That key held an
  * actor handle, a bead id, or a run epic id, and which one is not recoverable from
  * the value, so the report never files it under one of the three above.
  */
 origin?: string;
 parent?: string;
 /** In the blocked set `bd blocked` returned. */
 blocked: boolean;
}

/** A feature and every bead beneath it, at any depth. */
export interface StatusFeature extends StatusNode {
 tasks: StatusNode[];
 counts: Counts;
}

/**
 * An epic as a rollup. A run epic holds one epic per architect domain, each holding
 * its features, so an epic child of an epic is a nested rollup, never a task.
 */
export interface StatusEpic extends StatusNode {
 epics: StatusEpic[];
 features: StatusFeature[];
 /** Direct children that are neither epics nor features, plus their descendants. */
 tasks: StatusNode[];
 /** Every node beneath this epic at any depth, including nested epics and features. */
 counts: Counts;
}

export interface StatusTree {
 epics: StatusEpic[];
 /** Beads no root epic reaches. Reported rather than dropped. */
 orphans: StatusNode[];
 /** Ids of blocked beads that appear in this tree. */
 blocked: string[];
}

export type RunStatusDetails = StatusTree | {
 incomplete: true;
 beads: BdBead[] | null;
 blocked: string[] | null;
};

export interface StatusFilter {
 epic?: string;
 feature?: string;
 actor?: string;
}

export interface RenderOptions {
 /** Include one line per bead. Off, only rollups and counts are printed. */
 full?: boolean;
 filter?: StatusFilter;
}

/** Sibling ordering: the rollup reads top-down, so structure precedes work. */
const TYPE_ORDER: Record<string, number> = { epic: 0, feature: 1, task: 2, bug: 3, decision: 4, chore: 5 };

const STATE_MARK: Record<string, string> = {
 closed: "●",
 active: "◐",
 claimed: "◑",
 blocked: "◌",
 deferred: "◇",
 ready: "○",
};


/** A string field off a bead's passthrough properties, or `undefined`. */
function field(bead: BdBead, key: string): string | undefined {
 const value = bead[key];
 return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The lifecycle state of one bead.
 *
 * Terminal statuses win outright: a stale `state:` label must not resurrect
 * finished work. Below them the `state:` label is the finer signal, because a role
 * reports its phase by label while its bead stays `in_progress`. Only then does
 * status decide, and an open bead with an assignee is `claimed`, not `ready` —
 * that distinction is the whole point of a pull queue.
 */
export function deriveState(bead: BdBead, blocked: ReadonlySet<string> = new Set()): BeadState {
 const status = bead.status ?? "";
 if (status === "closed") return "closed";
 if (status === "deferred") return "deferred";

 for (const label of bead.labels ?? []) {
  if (label.startsWith("state:")) {
   const phase = label.slice("state:".length);
   if (phase.length > 0) return phase;
  }
 }

 if (status === "blocked" || blocked.has(bead.id)) return "blocked";
 if (status === "in_progress") return "active";
 if (status === "open") return bead.assignee ? "claimed" : "ready";
 return status.length > 0 ? status : "unknown";
}

function toNode(bead: BdBead, blocked: ReadonlySet<string>): StatusNode {
 const node: StatusNode = {
  id: bead.id,
  title: field(bead, "title") ?? "",
  type: field(bead, "issue_type") ?? "",
  state: deriveState(bead, blocked),
  blocked: blocked.has(bead.id),
 };
 const assignee = bead.assignee;
 if (typeof assignee === "string" && assignee.length > 0) node.assignee = assignee;
 const actor = metadataString(bead, "actor");
 if (actor !== undefined) node.actor = actor;
 const role = metadataString(bead, "role");
 if (role !== undefined) node.role = role;
 const runEpic = metadataString(bead, "run_epic");
 if (runEpic !== undefined) node.run_epic = runEpic;
 const originActor = metadataString(bead, "origin_actor");
 if (originActor !== undefined) node.origin_actor = originActor;
 const originBead = metadataString(bead, "origin_bead");
 if (originBead !== undefined) node.origin_bead = originBead;
 const origin = metadataString(bead, "origin");
 if (origin !== undefined) node.origin = origin;
 const parent = field(bead, "parent");
 if (parent !== undefined) node.parent = parent;
 return node;
}

function tally(nodes: readonly StatusNode[]): Counts {
 const counts: Counts = {};
 for (const node of nodes) counts[node.state] = (counts[node.state] ?? 0) + 1;
 return counts;
}

/** Every node an epic covers, at any depth: nested epics, features, and tasks. */
function epicNodes(epic: StatusEpic): StatusNode[] {
 const nodes: StatusNode[] = [];
 for (const child of epic.epics) nodes.push(child, ...epicNodes(child));
 for (const feature of epic.features) nodes.push(feature, ...feature.tasks);
 nodes.push(...epic.tasks);
 return nodes;
}

function progress(counts: Counts): string {
 let all = 0;
 for (const count of Object.values(counts)) all += count;
 if (all === 0) return "no children";
 const done = counts.closed ?? 0;
 return `${done}/${all} closed (${Math.round((100 * done) / all)}%)`;
}

/**
 * Group beads into epic → epic → feature → task, deriving each bead's state.
 *
 * A root epic is an `epic` whose parent is not itself a known bead: a parent id
 * pointing at nothing is a dangling link, not a reason to hide the epic. An epic
 * beneath an epic is a nested rollup (the architect domain under the run). Beneath a
 * feature, tasks are flattened to every descendant at any depth, so a subtask never
 * escapes its feature's counts.
 *
 * `event` beads are dropped before grouping. `bd set-state` writes one closed event
 * child per transition, so a task in review already has several "closed" children;
 * counting them reports a run half done when nothing has closed.
 */
export function buildStatusTree(allBeads: readonly BdBead[], blockedIds: readonly string[]): StatusTree {
 const blocked = new Set(blockedIds);
 const beads = allBeads.filter(bead => field(bead, "issue_type") !== "event");
 const known = new Set(beads.map(bead => bead.id));

 const childrenOf = new Map<string, BdBead[]>();
 for (const bead of beads) {
  const parent = field(bead, "parent");
  if (parent === undefined) continue;
  const siblings = childrenOf.get(parent);
  if (siblings) siblings.push(bead);
  else childrenOf.set(parent, [bead]);
 }
 const rank = (bead: BdBead): number => TYPE_ORDER[field(bead, "issue_type") ?? ""] ?? 9;
 for (const siblings of childrenOf.values()) {
  siblings.sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
 }

 const placed = new Set<string>();
 /** Preorder descendants, keeping the sibling order above. */
 const descendants = (root: string): BdBead[] => {
  const out: BdBead[] = [];
  const walk = (id: string): void => {
   for (const kid of childrenOf.get(id) ?? []) {
    if (placed.has(kid.id)) continue; // a parent cycle must not loop forever
    placed.add(kid.id);
    out.push(kid);
    walk(kid.id);
   }
  };
  walk(root);
  return out;
 };

 /** The rollup for one epic whose id is already placed. */
 const rollup = (root: BdBead): StatusEpic => {
  const epics: StatusEpic[] = [];
  const features: StatusFeature[] = [];
  const tasks: StatusNode[] = [];
  for (const child of childrenOf.get(root.id) ?? []) {
   if (placed.has(child.id)) continue;
   placed.add(child.id);
   const type = field(child, "issue_type");
   if (type === "epic") {
    epics.push(rollup(child));
    continue;
   }
   const kin = descendants(child.id).map(bead => toNode(bead, blocked));
   if (type === "feature") features.push({ ...toNode(child, blocked), tasks: kin, counts: tally(kin) });
   else tasks.push(toNode(child, blocked), ...kin);
  }
  const epic: StatusEpic = { ...toNode(root, blocked), epics, features, tasks, counts: {} };
  epic.counts = tally(epicNodes(epic));
  return epic;
 };

 const roots = beads
  .filter(bead => {
   if (field(bead, "issue_type") !== "epic") return false;
   const parent = field(bead, "parent");
   return parent === undefined || !known.has(parent);
  })
  .sort((a, b) => a.id.localeCompare(b.id));

 const epics: StatusEpic[] = [];
 for (const root of roots) {
  placed.add(root.id);
  epics.push(rollup(root));
 }

 const orphans = beads
  .filter(bead => !placed.has(bead.id))
  .sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id))
  .map(bead => toNode(bead, blocked));

 return { epics, orphans, blocked: retainedBlocked({ epics, orphans, blocked: [] }) };
}

/** Blocked ids present in a tree, so a filtered tree does not report others' blockers. */
function retainedBlocked(tree: StatusTree): string[] {
 const ids: string[] = [];
 for (const epic of tree.epics) {
  for (const node of [epic, ...epicNodes(epic)]) {
   if (node.blocked) ids.push(node.id);
  }
 }
 for (const node of tree.orphans) {
  if (node.blocked) ids.push(node.id);
 }
 return ids;
}

function heldBy(node: StatusNode, actor: string): boolean {
 // assignee is the claim of record, but `bd update --status` does not set it (only
 // `--claim` does), so `metadata.actor` -- the identity dispatch stamps on the bead --
 // is a second and often more truthful signal. `metadata.role` is routing, not holding:
 // matching it would return every unclaimed bead queued for that role.
 return node.assignee === actor || node.actor === actor;
}

/** The epic with this id at any depth, or `undefined`. */
function findEpic(epics: readonly StatusEpic[], id: string): StatusEpic | undefined {
 for (const epic of epics) {
  if (epic.id === id) return epic;
  const nested = findEpic(epic.epics, id);
  if (nested) return nested;
 }
 return undefined;
}

/** The epic directly holding the feature with this id, narrowed to that feature alone. */
function findFeatureHolder(epics: readonly StatusEpic[], id: string): StatusEpic | undefined {
 for (const epic of epics) {
  const feature = epic.features.find(f => f.id === id);
  if (feature) {
   const holder: StatusEpic = { ...epic, epics: [], features: [feature], tasks: [], counts: {} };
   holder.counts = tally(epicNodes(holder));
   return holder;
  }
  const nested = findFeatureHolder(epic.epics, id);
  if (nested) return nested;
 }
 return undefined;
}

/** The epic pruned to what `actor` holds, or `undefined` when that is nothing. */
function heldSubtree(epic: StatusEpic, actor: string): StatusEpic | undefined {
 const epics: StatusEpic[] = [];
 for (const child of epic.epics) {
  const kept = heldSubtree(child, actor);
  if (kept) epics.push(kept);
 }
 const features: StatusFeature[] = [];
 for (const feature of epic.features) {
  const kept = feature.tasks.filter(task => heldBy(task, actor));
  if (kept.length > 0 || heldBy(feature, actor)) features.push({ ...feature, tasks: kept, counts: tally(kept) });
 }
 const tasks = epic.tasks.filter(task => heldBy(task, actor));
 if (epics.length === 0 && features.length === 0 && tasks.length === 0 && !heldBy(epic, actor)) return undefined;
 const held: StatusEpic = { ...epic, epics, features, tasks, counts: {} };
 held.counts = tally(epicNodes(held));
 return held;
}

/**
 * Narrow a tree to one epic, one feature, or one actor's holdings.
 *
 * The named epic — a run or an architect domain — becomes the report's root; a named
 * feature is reported under the epic that holds it. Counts are recomputed from what
 * survives, so a filtered report never quotes totals for work it does not show.
 */
export function filterTree(tree: StatusTree, filter: StatusFilter): StatusTree {
 const { epic: wantEpic, feature: wantFeature, actor } = filter;
 if (wantEpic === undefined && wantFeature === undefined && actor === undefined) return tree;

 let epics = tree.epics;
 if (wantEpic !== undefined) {
  const found = findEpic(epics, wantEpic);
  epics = found ? [found] : [];
 }
 if (wantFeature !== undefined) {
  const holder = findFeatureHolder(epics, wantFeature);
  epics = holder ? [holder] : [];
 }
 if (actor !== undefined) {
  const held: StatusEpic[] = [];
  for (const epic of epics) {
   const kept = heldSubtree(epic, actor);
   if (kept) held.push(kept);
  }
  epics = held;
 }

 let orphans = wantEpic === undefined && wantFeature === undefined ? tree.orphans : [];
 if (actor !== undefined) orphans = orphans.filter(node => heldBy(node, actor));

 const filtered: StatusTree = { epics, orphans, blocked: [] };
 filtered.blocked = retainedBlocked(filtered);
 return filtered;
}

/** The report's first line: how many epics, features, tasks and blockers it covers, at every depth. */
export function statusSummaryLine(tree: StatusTree): string {
 let epics = 0;
 let features = 0;
 let tasks = 0;
 const count = (epic: StatusEpic): void => {
  epics += 1;
  features += epic.features.length;
  tasks += epic.tasks.length;
  for (const feature of epic.features) tasks += feature.tasks.length;
  for (const child of epic.epics) count(child);
 };
 for (const epic of tree.epics) count(epic);
 const bits = [`${epics} epics`, `${features} features`, `${tasks} tasks`, `${tree.blocked.length} blocked`];
 if (tree.orphans.length > 0) bits.push(`${tree.orphans.length} unparented`);
 return bits.join(" · ");
}

function nodeLine(node: StatusNode, indent: string): string {
 const bits: string[] = [];
 if (node.assignee) bits.push(`@${node.assignee}`);
 else if (node.actor) bits.push(`actor=${node.actor}`);
 else if (node.role) bits.push(`role=${node.role}`);
 if (node.blocked) bits.push("blocked");
 // Each bit names the key it came from: an actor handle, a bead id and a run epic id
 // are indistinguishable as values, so the label is what makes the line readable.
 if (node.run_epic) bits.push(`run_epic=${node.run_epic}`);
 if (node.origin_actor) bits.push(`origin_actor=${node.origin_actor}`);
 if (node.origin_bead) bits.push(`origin_bead=${node.origin_bead}`);
 if (node.origin) bits.push(`origin=${node.origin}`);
 const tail = bits.length > 0 ? `  [${bits.join(" ")}]` : "";
 // `?` marks a project-defined `state:` phase with no glyph of its own.
 return `${indent}${STATE_MARK[node.state] ?? "?"} ${node.id.padEnd(12)} ${node.state.padEnd(11)} ${node.title}${tail}`;
}

function countsLine(counts: Counts): string {
 const parts = Object.entries(counts)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([state, count]) => `${state} ${count}`);
 return parts.length > 0 ? parts.join("  ") : "no children";
}

/** One epic's rollup, nested epics indented beneath it. */
function renderEpic(epic: StatusEpic, indent: string, opts: RenderOptions, lines: string[]): void {
 lines.push(`${indent}EPIC  ${epic.id}  ${epic.title}  [${epic.state}]`);
 lines.push(`${indent}  ${progress(epic.counts)}   ${countsLine(epic.counts)}`);
 for (const child of epic.epics) renderEpic(child, `${indent}  `, opts, lines);
 for (const feature of epic.features) {
  lines.push(nodeLine(feature, `${indent}  `));
  lines.push(`${indent}      ${progress(feature.counts)}`);
  if (opts.full) {
   for (const task of feature.tasks) lines.push(nodeLine(task, `${indent}      `));
  }
 }
 if (epic.tasks.length > 0) {
  lines.push(`${indent}  direct tasks (${epic.tasks.length}): ${countsLine(tally(epic.tasks))}`);
  if (opts.full) {
   for (const task of epic.tasks) lines.push(nodeLine(task, `${indent}  `));
  }
 }
}

/** The report a reader (or the model) sees. */
export function renderStatus(tree: StatusTree, opts: RenderOptions = {}): string {
 const lines: string[] = [statusSummaryLine(tree)];
 const filter = opts.filter ?? {};
 const named = [
  filter.epic !== undefined ? `epic=${filter.epic}` : "",
  filter.feature !== undefined ? `feature=${filter.feature}` : "",
  filter.actor !== undefined ? `actor=${filter.actor}` : "",
 ].filter(bit => bit.length > 0);
 if (named.length > 0) lines.push(`filter: ${named.join(" ")}`);

 if (tree.epics.length === 0 && tree.orphans.length === 0) {
  lines.push("", "no matching epic, feature, or bead");
  return lines.join("\n");
 }

 for (const epic of tree.epics) {
  lines.push("");
  renderEpic(epic, "", opts, lines);
  // Blockers once per root, covering every nested epic, so a domain's blockers are not
  // printed again under the run.
  const blocked = epicNodes(epic).filter(node => node.blocked);
  if (blocked.length > 0) lines.push(`  BLOCKED (${blocked.length}): ${blocked.map(n => n.id).join(", ")}`);
 }

 if (tree.orphans.length > 0) {
  lines.push("", `UNPARENTED (${tree.orphans.length}): ${countsLine(tally(tree.orphans))}`);
  if (opts.full) {
   for (const node of tree.orphans) lines.push(nodeLine(node, "  "));
  }
 }

 return lines.join("\n");
}

const DESCRIPTION = [
 "Standardised beads run status: rolls a run epic up through its architect-domain epics and",
 "their features to the tasks, deriving per-bead state from status, `state:` labels, and",
 "assignee, and marking what `bd blocked` reports as blocked. `bd set-state` event beads are",
 "not counted. Reads only; never mutates a bead.",
 "Use this instead of hand-assembling a summary from `bd list`, which loses blockers and",
 "the rollup.",
].join(" ");

/** Register `orc_run_status`. The orchestrator wires this from `src/index.ts`. */
export function registerRunStatus(pi: ExtensionAPI): void {
 const z = pi.zod;
 pi.registerTool({
  name: "orc_run_status",
  label: "Run status",
  description: DESCRIPTION,
  approval: "read",
  parameters: z.object({
   epic: z.string().optional().describe("Report only this epic — the run or one architect domain — by bead id."),
   feature: z.string().optional().describe("Report only this feature, by bead id."),
   actor: z.string().optional().describe("Report only what this actor holds, by assignee or metadata.actor."),
   full: z.boolean().optional().describe("Include one line per bead. Off, only rollups and counts."),
  }),
  async execute(_toolCallId, params: StatusFilter & { full?: boolean }): Promise<AgentToolResult<RunStatusDetails>> {
   try {
    resetReadBudget();
    const [beads, blockedIds] = await Promise.all([
     // Events are `bd set-state`'s audit trail, one closed child per transition; the
     // tree drops them too, so `bd blocked` ids keep lining up with what is shown.
     bdListChecked(["list", "--status", "all", "--exclude-type", "event", "--limit", "0", "--json"]),
     bdBlockedChecked(),
    ]);

    if (beads === null || blockedIds === null) {
     return {
      content: [{
       type: "text" as const,
       text: "Run status incomplete: bead or blocker query failed or returned malformed data; readiness and blocker counts are unknown.",
      }],
      details: { incomplete: true, beads, blocked: blockedIds },
      isError: true,
     };
    }
    const filter: StatusFilter = {};
    if (params.epic !== undefined) filter.epic = params.epic;
    if (params.feature !== undefined) filter.feature = params.feature;
    if (params.actor !== undefined) filter.actor = params.actor;

    const tree = filterTree(buildStatusTree(beads, blockedIds), filter);
    return {
     content: [{ type: "text" as const, text: renderStatus(tree, { full: params.full === true, filter }) }],
     details: tree,
    };
   } catch (error) {
    // A throw here would surface as a hard tool failure mid-run; degrade instead.
    return {
     content: [{ type: "text" as const, text: `run status could not be built: ${String(error)}` }],
     details: { epics: [], orphans: [], blocked: [] } satisfies StatusTree,
     isError: true,
    };
   }
  },
 });
}
