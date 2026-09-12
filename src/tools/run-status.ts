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
import { type BdBead, bdBlockedChecked, bdCyclesChecked, bdListChecked, metadataString, resetReadBudget } from "../bd";

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

/** A merge bead the shepherd queue cannot match, and the anchors it lacks. */
export interface UndrainableMerge {
 id: string;
 missing: string[];
}

/** A merge bead whose captured branch carries no landing proof. */
export interface UnlandedMerge {
 id: string;
 state: BeadState;
 branch?: string;
}

/**
 * The close-out gate as data: what still stands between a run and `/orchestrate-stop`.
 *
 * A row is a list, or `null` when the read behind it did not answer, and `clean` holds
 * only when every row is known and empty. `in_progress`, `blocked` and `stranded` cover
 * the beads the report shows, at any depth. `undrainable` reads the whole store: a merge
 * bead carries no parent and the shepherd queue is repository-global, so one that no
 * queue can match belongs to no run. `unlanded` follows the report: a merge bead counts
 * when it, or the feature it captured, is in the tree.
 */
export interface CloseOut {
 /** `bd dep cycles`: each cycle as the ids it visits, in edge order. */
 cycles: string[][] | null;
 /** Stored status `in_progress`, whatever `state:` label the bead also carries. */
 in_progress: string[];
 /** In `bd blocked`, or stored status `blocked`; closed and deferred beads excluded. */
 blocked: string[];
 /** Open and unassigned, yet absent from `bd ready` and not blocked: no worker can ever pull it. */
 stranded: string[] | null;
 /** Open merge beads missing the `pr:merge` label, `role=shepherd`, `repo`, `origin_bead`, or `branch`. */
 undrainable: UndrainableMerge[];
 /** Merge beads not closed, with neither `merge_sha` nor `landing_state=landed`. */
 unlanded: UnlandedMerge[];
 clean: boolean;
}

export type RunStatusDetails = (StatusTree & { closeOut: CloseOut }) | {
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
 /** Append the close-out gate. */
 closeOut?: CloseOut;
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

/** Every id a tree shows: roots, everything beneath them, and the unparented. */
function treeIds(tree: StatusTree): Set<string> {
 const ids = new Set<string>();
 for (const epic of tree.epics) {
  ids.add(epic.id);
  for (const node of epicNodes(epic)) ids.add(node.id);
 }
 for (const node of tree.orphans) ids.add(node.id);
 return ids;
}

/** The reads the close-out gate is derived from, each `null` when it did not answer. */
export interface CloseOutReads {
 blocked: readonly string[];
 /** `bd ready --include-ephemeral`: what a worker could pull now. */
 ready: readonly string[] | null;
 /** `bd dep cycles`. */
 cycles: string[][] | null;
}

/**
 * The close-out gate over the beads a tree shows.
 *
 * `beads` is the whole store as `bd list --status all` returned it; the tree decides
 * which of them are in scope. The merge rows are the two the shepherd queue cannot
 * answer itself: a merge bead missing an anchor is never matched by the cross-run
 * `bd ready` net, and a merge bead without `merge_sha` holds captured code the run has
 * not proven landed.
 */
export function buildCloseOut(beads: readonly BdBead[], tree: StatusTree, reads: CloseOutReads): CloseOut {
 const scope = treeIds(tree);
 const blockedSet = new Set(reads.blocked);
 const ready = reads.ready === null ? null : new Set(reads.ready);

 const inProgress: string[] = [];
 const blocked: string[] = [];
 const stranded: string[] = [];
 const undrainable: UndrainableMerge[] = [];
 const unlanded: UnlandedMerge[] = [];
 for (const bead of beads) {
  const status = bead.status ?? "";
  const labels = bead.labels ?? [];
  const isMergeBead = labels.includes("pr:merge");
  const origin = metadataString(bead, "origin_bead") ?? metadataString(bead, "origin");

  if (scope.has(bead.id)) {
   const isBlocked = status === "blocked" || blockedSet.has(bead.id);
   if (status === "in_progress") inProgress.push(bead.id);
   if (isBlocked && status !== "closed" && status !== "deferred") blocked.push(bead.id);
   if (status === "open" && !bead.assignee && !isBlocked && ready !== null && !ready.has(bead.id)) stranded.push(bead.id);
  }

  if (status === "open" && (isMergeBead || metadataString(bead, "role") === "shepherd")) {
   const missing: string[] = [];
   if (!isMergeBead) missing.push("label pr:merge");
   if (metadataString(bead, "role") !== "shepherd") missing.push("role=shepherd");
   if (metadataString(bead, "repo") === undefined) missing.push("repo");
   if (origin === undefined) missing.push("origin_bead");
   if (metadataString(bead, "branch") === undefined) missing.push("branch");
   if (missing.length > 0) undrainable.push({ id: bead.id, missing });
  }

  if (isMergeBead && status !== "closed" && (scope.has(bead.id) || (origin !== undefined && scope.has(origin)))) {
   const landed = metadataString(bead, "merge_sha") !== undefined || metadataString(bead, "landing_state") === "landed";
   if (!landed) {
    const entry: UnlandedMerge = { id: bead.id, state: deriveState(bead, blockedSet) };
    const branch = metadataString(bead, "branch");
    if (branch !== undefined) entry.branch = branch;
    unlanded.push(entry);
   }
  }
 }

 const cycles = reads.cycles;
 return {
  cycles,
  in_progress: inProgress,
  blocked,
  stranded: ready === null ? null : stranded,
  undrainable,
  unlanded,
  clean:
   cycles !== null && cycles.length === 0 && inProgress.length === 0 && blocked.length === 0 && ready !== null && stranded.length === 0
   && undrainable.length === 0 && unlanded.length === 0,
 };
}

/** The close-out section: one line when clean, otherwise one line per row that is not. */
function renderCloseOut(gate: CloseOut, lines: string[]): void {
 lines.push("", `CLOSE-OUT: ${gate.clean ? "clean" : "not clean"}`);
 if (gate.clean) return;
 if (gate.cycles === null) lines.push("  cycles: unknown (bd dep cycles did not answer)");
 else if (gate.cycles.length > 0) {
  lines.push(`  cycles (${gate.cycles.length}):`);
  for (const cycle of gate.cycles) lines.push(`    ${[...cycle, cycle[0]].join(" → ")}`);
 }
 if (gate.in_progress.length > 0) lines.push(`  in_progress (${gate.in_progress.length}): ${gate.in_progress.join(", ")}`);
 if (gate.blocked.length > 0) lines.push(`  blocked (${gate.blocked.length}): ${gate.blocked.join(", ")}`);
 if (gate.stranded === null) lines.push("  stranded: unknown (bd ready did not answer)");
 else if (gate.stranded.length > 0) lines.push(`  stranded (${gate.stranded.length}): ${gate.stranded.join(", ")}`);
 if (gate.undrainable.length > 0) {
  lines.push(`  undrainable merge beads (${gate.undrainable.length}): ${gate.undrainable.map(m => `${m.id} (missing ${m.missing.join(", ")})`).join("; ")}`);
 }
 if (gate.unlanded.length > 0) {
  lines.push(`  unlanded (${gate.unlanded.length}): ${gate.unlanded.map(m => `${m.id} (${m.branch === undefined ? m.state : `${m.branch}, ${m.state}`})`).join("; ")}`);
 }
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

 if (opts.closeOut !== undefined) renderCloseOut(opts.closeOut, lines);

 return lines.join("\n");
}

const DESCRIPTION = [
 "Standardised beads run status: rolls a run epic up through its architect-domain epics and",
 "their features to the tasks, deriving per-bead state from status, `state:` labels, and",
 "assignee, and marking what `bd blocked` reports as blocked. `bd set-state` event beads are",
 "not counted. Ends with the close-out gate: dependency cycles, in-progress and blocked beads",
 "at any depth, stranded beads no worker can pull, undrainable merge beads, and captured",
 "branches without landing proof. Reads only; never mutates a bead.",
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
    const [beads, blockedIds, readyBeads, cycles] = await Promise.all([
     // Events are `bd set-state`'s audit trail, one closed child per transition; the
     // tree drops them too, so `bd blocked` ids keep lining up with what is shown.
     bdListChecked(["list", "--status", "all", "--exclude-type", "event", "--limit", "0", "--json"]),
     bdBlockedChecked(),
     // Wisps included, or every review and research queue would read as stranded.
     bdListChecked(["ready", "--include-ephemeral", "--limit", "0", "--json"]),
     bdCyclesChecked(),
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
    const closeOut = buildCloseOut(beads, tree, { blocked: blockedIds, ready: readyBeads === null ? null : readyBeads.map(bead => bead.id), cycles });
    return {
     content: [{ type: "text" as const, text: renderStatus(tree, { full: params.full === true, filter, closeOut }) }],
     details: { ...tree, closeOut },
    };
   } catch (error) {
    // A throw here would surface as a hard tool failure mid-run; degrade instead.
    return {
     content: [{ type: "text" as const, text: `run status could not be built: ${String(error)}` }],
     details: { incomplete: true, beads: null, blocked: null },
     isError: true,
    };
   }
  },
 });
}
