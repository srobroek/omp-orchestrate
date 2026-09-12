/**
 * G2 — mutations stay inside the tree, and the territory, the claimed bead names.
 *
 * Checks containment in the claimed checkout (or the current isolated Git root),
 * then the union of claimed repo-relative scopes. Shell commands are checked at
 * their effective cwd; the tokeniser parses their redirections, but a redirection
 * target is not a declared path here, so `bash` is contained by its cwd alone.
 *
 * A gate that catches slips refuses on evidence, never on its absence. A product
 * mutation is refused when the claimed bead is readable and proves the loss: assigned
 * to another actor, or closed. A bead the store cannot read -- `bd` missing, slow,
 * over budget, or answering nothing -- proves nothing, so the call proceeds and the
 * cause is logged. Narrowly recognized Beads controls keep their grammar on a readable
 * bead: reopen needs the closed bead this actor still holds, reclaim the reopened one,
 * release current ownership. A comment on the claimed bead is admitted once this
 * session has released it, so the terminal report may follow the release. A bead this
 * actor closed ends the claim: product work or a comment on it forgets the claim rather
 * than being refused, while other `bd` commands on it stay under the reopen-then-reclaim
 * grammar. Uninspectable edit payloads are refused rather than silently reduced to a
 * cwd-only check.
 *
 * Every path is compared in the filesystem's own spelling. The declared tree comes from
 * `fs.realpath`; a cwd or target the tool named is walked component by component and
 * then its longest existing prefix is passed through `fs.realpath` too, so on a
 * case-insensitive volume (the macOS default) a path the model spells `SRC/new.ts`
 * compares as `src/new.ts`, which is where the write lands, and on a case-sensitive
 * volume the two stay the distinct paths they are. No platform branch: realpath answers
 * for the volume it is asked about.
 *
 * Scope disjointness between claims is judged once, at claim, by G5. This gate reads
 * only the claimed beads and compares each write against the territory they name.
 *
 * The dispatcher (`src/index.ts`) runs this gate only inside a run scope: the marked run
 * `runScope` (`src/run-scope.ts`) recognises. A plain session that claims a bead by hand
 * is never contained by it.
 */

import path from "node:path";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveToCwd } from "@oh-my-pi/pi-coding-agent/tools/path-utils";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ToolCallEventResult } from "@oh-my-pi/pi-coding-agent";
import { editInspect } from "@oh-my-pi/pi-natives";
import { getWorktreesDir, logger } from "@oh-my-pi/pi-utils";
import { bdFailureText, bdShow, lastBdFailure, metadataRecord, metadataString } from "../bd";
import type { BdBead, BdFailure } from "../bd";
import type { ClaimState } from "../claim-state";
import { fnmatch, normalizeScope, scopeOf } from "../scope";
import { splitSegments } from "../shell";

/** Tools that mutate the working tree and therefore need a scope check. */
export const GATED_WRITE_TOOLS: Record<string, true> = { bash: true, edit: true, write: true };

/** A path the tool named, and where on disk it would land. */
interface Target {
 declared: string;
 resolved: string;
}

/**
 * Resolve a path through symlinks, or return `undefined` when it cannot be resolved.
 *
 * Comparing unresolved paths would let a symlink into another agent's tree pass, so
 * an unresolvable path fails open rather than comparing something misleading.
 */
export async function realpathOrUndefined(target: string): Promise<string | undefined> {
 try {
  return await fs.realpath(target);
 } catch {
  return undefined;
 }
}

/** Whether `child` is `parent` or sits beneath it. Both must already be resolved. */
export function within(child: string, parent: string): boolean {
 return child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`);
}

const execFileAsync = promisify(execFile);

/**
 * Isolated roots by resolved cwd and the base in force, so the `git rev-parse` behind
 * each verdict runs once per session directory rather than once per gated call. A
 * verdict git could not give is not cached; the next call asks again.
 */
const isolatedRoots = new Map<string, string | undefined>();

async function isolatedRoot(cwd: string): Promise<string | undefined> {
 // The shared base is only a discovery hint, never mutation authority.
 const base = await realpathOrUndefined(getWorktreesDir());
 if (base === undefined || cwd === base || !within(cwd, base)) return undefined;
 const key = `${base}\u0000${cwd}`;
 if (isolatedRoots.has(key)) return isolatedRoots.get(key);
 try {
  const env = { ...process.env };
  // Repository-selection overrides must not turn another checkout into authority.
  for (const name of Object.keys(env)) if (name.startsWith("GIT_")) delete env[name];
  const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
   env,
   timeout: 1500,
   maxBuffer: 16 * 1024,
  });
  const root = await realpathOrUndefined(stdout.trim());
  const verdict = root !== undefined && root !== base && within(root, base) && within(cwd, root) ? root : undefined;
  isolatedRoots.set(key, verdict);
  return verdict;
 } catch {
  return undefined;
 }
}

/**
 * How many symlinks one path may traverse before the walk gives up. `MAXSYMLINKS` is
 * 32 on this platform, so a path that needs more of them would not open either.
 */
const MAX_HOPS = 32;

/**
 * A target naming a scheme rather than a filesystem path.
 *
 * `write` addresses more than files: `xd://<tool>` invokes a tool device, and
 * `local://`, `artifact://` and `ssh://` name things no worktree contains. Resolved as
 * a relative path, `xd://lsp` would land at `<cwd>/xd:/lsp` — inside the tree, so
 * containment would pass, but named by no scope glob, so a bead that declares one would
 * have every tool-device call refused. None of these is evidence about a tree, so none
 * of them is compared.
 */
const URI_TARGET = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

/**
 * Resolve a declared path to where it would actually land, in the filesystem's own
 * spelling, or `undefined` when it cannot be resolved at all.
 *
 * Walked one component at a time rather than handed to `fs.realpath`, for two reasons.
 *
 * The first is that a `write` names a file that does not exist yet, so realpath fails on
 * the whole path; a component walk simply appends a segment that is not a link, and a
 * segment that does not exist cannot be one.
 *
 * The second is a correctness bug that would have been the hole this gate is here to
 * close. Bun's `fs.realpath` — and `realpathSync.native` with it — collapses `..`
 * lexically before following any link, so `tree/link/../x` resolves to `tree/x` and
 * looks contained. The kernel does the opposite: it follows `link` first and then takes
 * the parent of wherever that landed, which is how `printf x > tree/link/../x` really
 * writes outside `tree`. Verified against the filesystem, not inferred. So `..` is
 * applied to the already-resolved prefix here, which is the kernel's order, and
 * `POSIX realpath(3)` agrees.
 *
 * Only after the walk is `fs.realpath` asked, and only about the longest prefix that
 * exists: with no link and no `..` left, all it can change is the spelling.
 */
async function resolveTarget(cwd: string, declared: string): Promise<string | undefined> {
 // Neither of these can be turned into a path this gate should compare: a NUL is
 // rejected by `fs` rather than resolved, and a scheme names something no tree holds.
 if (declared.includes("\0") || URI_TARGET.test(declared)) return undefined;
 if (declared === "~" || declared.startsWith("~/")) declared = resolveToCwd(declared, cwd);

 // A relative target starts from the already-resolved cwd, so only the segments the
 // tool actually named need walking.
 const absolute = path.isAbsolute(declared);
 const { root } = path.parse(declared);
 let resolved = absolute ? root : cwd;
 // Reversed and popped from the end, so a link's own segments can be pushed back on
 // and come out in order.
 const pending = (absolute ? declared.slice(root.length) : declared).split(path.sep).reverse();
 let hops = 0;

 while (pending.length > 0) {
  const segment = pending.pop() as string;
  if (segment.length === 0 || segment === ".") continue;
  if (segment === "..") {
   // Applied to the resolved prefix, which is the whole point: `dirname` of a
   // followed link is the parent of its target, not of the link.
   resolved = path.dirname(resolved);
   continue;
  }

  const candidate = path.join(resolved, segment);
  let link: string | undefined;
  try {
   link = await fs.readlink(candidate);
  } catch {
   // EINVAL for a plain file or directory, ENOENT for a path that does not exist
   // yet. Neither redirects anything, so both mean "not a link".
  }
  if (link === undefined) {
   resolved = candidate;
   continue;
  }

  // Fail open: a link cycle resolves to nothing, and nothing is what it gets
  // compared against.
  if (++hops > MAX_HOPS) return undefined;
  const linkRoot = path.parse(link).root;
  if (linkRoot.length > 0) resolved = linkRoot;
  pending.push(...link.slice(linkRoot.length).split(path.sep).reverse());
 }

 return canonical(resolved);
}

/**
 * `resolved` with its longest existing prefix in the filesystem's own spelling and the
 * rest appended as written. A prefix the filesystem will not resolve for any other
 * reason than absence keeps its spelling; that is the fail-open side of this gate.
 */
async function canonical(resolved: string): Promise<string> {
 let existing = resolved;
 const rest: string[] = [];
 for (;;) {
  const real = await realpathOrUndefined(existing);
  if (real !== undefined) return rest.length === 0 ? real : path.join(real, ...rest.reverse());
  const parent = path.dirname(existing);
  if (parent === existing) return resolved;
  rest.push(path.basename(existing));
  existing = parent;
 }
}

export function declaredTargets(toolName: string, input: Record<string, unknown>): string[] | undefined {
 if (toolName === "write") {
  return typeof input.path === "string" && input.path.length > 0 ? [input.path] : [];
 }
 if (toolName !== "edit") return [];
 // Text is authoritative; host compatibility fields are not executable targets.
 const raw = input.input ?? input._input;
 const textual = typeof raw === "string";
 const args = textual ? { input: raw } : { ...input, path: input.path ?? input._path };
 const modes = textual ? ["hashline", "apply_patch", "sloppy"] : ["replace", "patch"];
 const targets = new Set<string>();
 if (textual) {
  for (const match of raw.matchAll(/^\*{3}\s+(?:Add|Update|Delete) File:\s*(.+)$/gim)) {
   const target = match[1]?.trim();
   if (target) targets.add(target);
  }
  for (const match of raw.matchAll(/^\*{3}\s+Move to:\s*(.+)$/gim)) {
   const target = match[1]?.trim();
   if (target) targets.add(target);
  }
  for (const match of raw.matchAll(/^§(?!\*)\s*(\S.*)$/gm)) {
   const target = match[1]?.trim();
   if (target) targets.add(target);
  }
  for (const match of raw.matchAll(/^\[([^\]\n]+)\]$/gm)) {
   const target = match[1]?.replace(/#[0-9a-f]{4}$/i, "").trim();
   if (target) targets.add(target);
  }
 }
 try {
  const json = JSON.stringify(args);
  for (const mode of modes) {
   const inspection = editInspect(mode, json);
   for (const target of inspection.paths) targets.add(target);
   for (const operation of inspection.fileOps) {
    targets.add(operation.path);
    if (operation.to !== undefined) targets.add(operation.to);
   }
  }
 } catch {
  // Native inspection is optional for incomplete payloads; header parsing still applies.
 }
 return targets.size > 0 ? [...targets] : undefined;
}

/**
 * Whether one scope glob can name a repo-relative path.
 *
 * `fnmatch` alone is not enough. `scopesOverlap` treats a wildcard-free glob as owning
 * "that whole path outright", so `src/api` grants `src/api/handler.ts`, and a comparison
 * that ran only the text match would refuse the very files such a scope was written to
 * hand over. Appending `/*` covers that, and costs nothing for a glob that matched
 * already.
 *
 * `fnmatch`'s `*` spans `/`, unlike a shell glob — see `src/scope.ts`, which owns this
 * matcher and keeps it linear-time. That is the widest reading of any scope, which is
 * the right direction for a comparison whose only output is a refusal.
 */
function names(relative: string, glob: string): boolean {
 const trimmed = normalizeScope(glob);
 // An explicitly empty or separator-only scope owns the whole tree.
 if (trimmed.length === 0) return true;
 return fnmatch(relative, trimmed) || fnmatch(relative, `${trimmed}/*`);
}

/**
 * Linear recognition of the former CONTROL_COMMAND grammar. Keep quoting until
 * eligibility is established: splitSegments intentionally discards that evidence.
 * Single quotes are literal; double quotes may not contain $, ` or backslash.
 * Unquoted escapes, expansions, operators and unknown punctuation stay unsupported.
 */
function isControlCommand(command: string): boolean {
 let quote: "'" | '"' | undefined;
 let started = false;
 for (let i = 0; i < command.length; i++) {
  const ch = command[i]!;
  if (quote) {
   if (ch === quote) quote = undefined;
   else if (quote === '"' && (ch === "$" || ch === "`" || ch === "\\")) return false;
  } else if (ch === "'" || ch === '"') {
   quote = ch;
   started = true;
  } else if (ch !== " " && ch !== "\t") {
   if (!/[A-Za-z0-9_./:=@%+,-]/.test(ch)) return false;
   started = true;
  }
 }
 return started && quote === undefined;
}

/**
 * A deliberately narrow escape from a scope conflict, not a shell safety parser.
 * Only literal standalone Beads reads and own-claim comment/release/recovery forms qualify.
 *
 * `comment` is a write with one extra admission: it may land on the claimed bead after
 * this session released it, so the terminal report may follow the release. Recovery is
 * `bd reopen <id>` on an own closed bead, then `bd update <id> --claim [--json]`, the
 * only spelling bd has for a reclaim. `--json` is popped before matching so the observer
 * can re-record the claim from the report.
 */
type ConflictControl = "read" | "write" | "comment" | "release" | "reopen" | "claim" | "deny";

function conflictControl(input: Record<string, unknown>, actor: string, beadId: string): ConflictControl | undefined {
 const command = input.command;
 if (typeof command !== "string") return undefined;
 // Reject expansion, redirection, operators and wrappers before discarding quoting.
 if (!isControlCommand(command)) return undefined;
 const segments = splitSegments(command);
 if (segments.length !== 1) return undefined;
 const tokens = [...segments[0]!];
 if (tokens[0] === "env") tokens.shift();
 const environment = input.env && typeof input.env === "object" ? input.env as Record<string, unknown> : {};
 let trustedEnvironment = true;
 let hasExplicitActor = false;
 let actorMismatch = false;
 for (const [key, value] of Object.entries(environment)) {
  if ((key !== "BEADS_ACTOR" && key !== "BD_ACTOR") || typeof value !== "string") {
   trustedEnvironment = false;
  } else {
   hasExplicitActor = true;
   actorMismatch ||= value !== actor;
  }
 }
 while (tokens[0]?.includes("=")) {
  const assignment = tokens.shift()!;
  const split = assignment.indexOf("=");
  const key = assignment.slice(0, split);
  const value = assignment.slice(split + 1);
  if (key !== "BEADS_ACTOR" && key !== "BD_ACTOR") {
   trustedEnvironment = false;
  } else {
   hasExplicitActor = true;
   actorMismatch ||= value !== actor;
  }
 }
 if (tokens.shift() !== "bd") return undefined;
 if (tokens[0] === "--actor") {
  tokens.shift();
  const supplied = tokens.shift();
  if (supplied === undefined) return undefined;
  hasExplicitActor = true;
  actorMismatch ||= supplied !== actor;
 }
 if (tokens.at(-1) === "--json") tokens.pop();
 const operation = tokens.shift();
 if (actorMismatch) return "deny";
 if ((operation === "show" || operation === "comments") && tokens.length === 1 && tokens[0] === beadId) {
  return trustedEnvironment ? "read" : undefined;
 }
 if ((operation === "list" || operation === "blocked" || operation === "status") && tokens.length === 0) {
  return trustedEnvironment ? "read" : undefined;
 }
 if (operation !== "comment" && operation !== "comments" && operation !== "update" && operation !== "reopen") return undefined;
 const inheritedActor = process.env.BEADS_ACTOR ?? process.env.BD_ACTOR;
 const attributed = hasExplicitActor || inheritedActor === actor;
 if (operation === "reopen") {
  return tokens.length === 1 && tokens[0] === beadId && trustedEnvironment && attributed ? "reopen" : undefined;
 }
 if (operation === "comments" && tokens[0] === "add") tokens.shift();
 if (tokens[0] !== beadId) return undefined;
 if (!trustedEnvironment) return undefined;
 if (!attributed) return undefined;
 if ((operation === "comment" || operation === "comments") && tokens.length === 2) return "comment";
 if (operation !== "update") return undefined;
 tokens.shift();
 if (tokens.length === 1 && tokens[0] === "--claim") return "claim";
 let released = false;
 let changedStatus = false;
 while (tokens.length > 0) {
  const flag = tokens.shift();
  const value = tokens.shift();
  if (flag === "--assignee" && value === "" && !released) released = true;
  else if (flag === "--status" && (value === "open" || value === "in_progress" || value === "blocked")) changedStatus = true;
  else return undefined;
 }
 if (!released) return changedStatus ? "write" : undefined;
 return changedStatus ? "write" : "release";
}

/**
 * Whether a pure release may land: the bead is held by this actor — in_progress, or
 * open after its own reopen — or it is closed and either already unassigned or still
 * assigned to this actor, so a release retried after a close stays idempotent.
 */
function releasable(bead: BdBead, actor: string): boolean {
 if (bead.status === "in_progress" || bead.status === "open") return bead.assignee === actor;
 if (bead.status === "closed") return bead.assignee === undefined || bead.assignee === "" || bead.assignee === actor;
 return false;
}

/**
 * The refusal a readable bead proves, or `undefined` while it proves no loss.
 *
 * Loss is another actor's name on the bead, or a close. A released bead -- assignee
 * cleared, still open -- is held by nobody and taken from nobody, so `next` proceeds:
 * a worker bounced by G4 after its release must be able to repair its evidence. A bead
 * this actor closed is a slip of grammar rather than of ownership, and the refusal
 * names the recovery instead of an owner.
 */
function ownershipRefusal(bead: BdBead, actor: string, next: string): string | undefined {
 const assignee = typeof bead.assignee === "string" && bead.assignee.length > 0 ? bead.assignee : undefined;
 if (assignee !== undefined && assignee !== actor) {
  return `claimed bead '${bead.id}' is now assigned to '${assignee}', not '${actor}'; another actor owns it, so ${next} is refused`;
 }
 if (bead.status !== "closed") return undefined;
 if (assignee === actor) {
  return `claimed bead '${bead.id}' is closed; run 'bd reopen ${bead.id}' and 'bd update ${bead.id} --claim --json' before ${next}`;
 }
 return `claimed bead '${bead.id}' was closed by another actor, so ${next} is refused`;
}

/** One claimed bead as this call read it. `failure` is why the read answered nothing. */
interface BeadView {
 beadId: string;
 bead: BdBead | null;
 failure: BdFailure | undefined;
 control: ConflictControl | undefined;
}

/** Refuse a mutation outside the tree, or the territory, the claimed bead names. */
export async function gateWorktreeScope(
 claims: ClaimState,
 ctx: ExtensionContext,
 toolName: string,
 input: Record<string, unknown>,
): Promise<ToolCallEventResult | undefined> {
 if (!Object.hasOwn(GATED_WRITE_TOOLS, toolName)) return undefined;
 const claim = claims.observedClaim();
 if (!claim || claim.beadIds.length === 0) return undefined;
 const controls = claim.beadIds.map(beadId => toolName === "bash" ? conflictControl(input, claim.actor, beadId) : undefined);
 const hasControl = controls.some(control => control !== undefined);
 const beadViews: BeadView[] = [];
 for (const [index, beadId] of claim.beadIds.entries()) {
  const bead = await bdShow(beadId);
  // Read beside the show: the recorded kind describes the most recent bd call only.
  beadViews.push({ beadId, bead, failure: bead === null ? lastBdFailure() : undefined, control: controls[index] });
 }

 // A bead this actor closed is finished, not lost. Refusing every later edit would hold
 // the session hostage until its next claim command, so product work — and a comment on
 // the finished bead — forgets the claim instead and falls open as it does for a session
 // that never claimed. Any other command naming `bd`, wrapped or literal, stays under
 // the recovery grammar: reopen and reclaim keep the claim so the recovery stays
 // observed, and a mention that is not one is refused with the grammar named.
 if (beadViews.every(({ bead }) => bead?.status === "closed" && bead.assignee === claim.actor)) {
  const command = toolName === "bash" ? input.command : undefined;
  const namesBd = typeof command === "string" &&
   splitSegments(command).some(segment => segment.some(token => token.split(/[ \t]+/).includes("bd")));
  if (!namesBd || controls.some(control => control === "comment")) {
   claims.forgetClaim();
   return undefined;
  }
 }

 for (const { beadId, bead, failure, control } of beadViews) {
  if (control === "deny") {
   return { block: true, reason: `control command is not authorized for claimed bead '${beadId}'` };
  }
  if (bead === null) {
   // Nothing was read, so nothing is proven: the call proceeds, and the cause lands
   // where an operator watching a store under load can see it. `bd` itself still
   // refuses a write that the bead's real owner would contest.
   logger.warn("orchestrate G2: claimed bead could not be read; allowing", {
    bead: beadId,
    actor: claim.actor,
    tool: toolName,
    cause: bdFailureText(failure),
   });
   continue;
  }
  if (!hasControl || control === "write" || control === "comment") {
   const refusal = ownershipRefusal(bead, claim.actor, control === undefined ? "mutating product files" : "writing to it");
   if (refusal !== undefined) return { block: true, reason: refusal };
  }
  if (control === "reopen" && (bead.status !== "closed" || bead.assignee !== claim.actor)) {
   return { block: true, reason: `cannot reopen claimed bead '${beadId}' unless it is closed and assigned to '${claim.actor}'` };
  }
  if (control === "claim" && (bead.status !== "open" || bead.assignee !== claim.actor)) {
   return { block: true, reason: `cannot reclaim claimed bead '${beadId}' unless it is open and assigned to '${claim.actor}'` };
  }
  if (control === "release" && !releasable(bead, claim.actor)) {
   return { block: true, reason: `cannot release ownership of claimed bead '${beadId}' without current ownership` };
  }
 }

 const sessionCwd = await realpathOrUndefined(ctx.cwd);
 if (sessionCwd === undefined) return undefined;
 let executionCwd = ctx.cwd;
 if (toolName === "bash" && typeof input.cwd === "string" && input.cwd.length > 0) {
  try {
   executionCwd = resolveToCwd(input.cwd, ctx.cwd);
  } catch {
   return { block: true, reason: "cannot establish bash input.cwd containment; use a local filesystem cwd" };
  }
 }
 const cwd = await resolveTarget(sessionCwd, executionCwd);
 if (cwd === undefined || (await realpathOrUndefined(cwd)) === undefined) return undefined;
 const isolation = await isolatedRoot(sessionCwd);
 const declaredPaths = declaredTargets(toolName, input);
 if (declaredPaths === undefined) {
  return { block: true, reason: "cannot inspect edit mutation targets; use a supported edit payload with explicit targets" };
 }

 const targets: Target[] = [];
 for (const declared of declaredPaths) {
  const resolved = await resolveTarget(cwd, declared);
  // Fail open, per target: a path the filesystem will not resolve is compared
  // against nothing rather than against a guess.
  if (resolved !== undefined) targets.push({ declared, resolved });
 }

 // Containment is an intersection over claimed beads — the cwd must sit inside every
 // tree they name, which is the behaviour a two-tree claim already inherits. Territory
 // is a union, collected here and judged after the loop: G5 keeps claimed beads' scope
 // globs disjoint, so intersecting them would refuse every write a worker holding two
 // beads could possibly make.
 const scoped: { beadId: string; worktree: string; globs: string[] }[] = [];
 for (const { beadId, bead } of beadViews) {
  // An unreadable bead names no tree, and a bead that declares none leaves nothing to
  // compare. `metadata.scope` is repo-relative and needs that tree as its base, so
  // both comparisons stop here.
  const declaredTree = metadataString(bead, "worktree");
  if (declaredTree === undefined) continue;

  const worktree = isolation ?? await realpathOrUndefined(declaredTree);
  // Fail open: a tree that does not exist on this machine is not evidence.
  if (worktree === undefined) continue;

  if (!within(cwd, worktree)) {
   return {
    block: true,
    reason: `this session's cwd does not match metadata.worktree on claimed bead '${beadId}'; another actor owns that tree`,
   };
  }

  for (const target of targets) {
   if (within(target.resolved, worktree)) continue;
   return {
    block: true,
    reason: `'${target.declared}' resolves to '${target.resolved}', outside metadata.worktree on claimed bead '${beadId}'; another actor owns that tree`,
   };
  }

  // Decode the same metadata representation for containment and territory.
  const globs = scopeOf(metadataRecord(bead?.metadata));
  if (globs.length > 0) scoped.push({ beadId, worktree, globs });
 }

 // Fail open: not one claimed bead declares a territory.
 if (scoped.length === 0) return undefined;

 for (const target of targets) {
  const named = scoped.some(({ worktree, globs }) => {
   const relative = path.relative(worktree, target.resolved).split(path.sep).join("/");
   // The tree root itself is not a file, so no glob needs to name it.
   if (relative.length === 0) return true;
   return globs.some((glob) => names(relative, glob));
  });
  if (named) continue;
  return {
   block: true,
   reason: `'${target.declared}' is named by no claimed bead's metadata.scope — ${scoped
    .map(({ beadId, globs }) => `${beadId} (${globs.join(", ")})`)
    .join(", ")}`,
  };
 }

 return undefined;
}
