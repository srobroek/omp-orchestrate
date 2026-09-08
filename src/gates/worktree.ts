/**
 * G2 — mutations stay inside the tree, and the territory, the claimed bead names.
 *
 * Checks containment in the claimed checkout (or the current isolated Git root),
 * then the union of claimed repo-relative scopes. Shell commands are checked at
 * their effective cwd; their arbitrary redirections are not parsed.
 * Unavailable Beads/filesystem evidence fails open. Uninspectable edit payloads
 * are refused rather than silently reduced to a cwd-only check.
 */

import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveToCwd } from "@oh-my-pi/pi-coding-agent/tools/path-utils";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ToolCallEventResult } from "@oh-my-pi/pi-coding-agent";
import { editInspect } from "@oh-my-pi/pi-natives";
import { bdShow, metadataRecord, metadataString } from "../bd";
import { observedClaim } from "../claim-state";
import { fnmatch, normalizeScope, scopeOf } from "../scope";
import { scopeConflict } from "./claim";
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
async function realpathOrUndefined(target: string): Promise<string | undefined> {
 try {
  return await fs.realpath(target);
 } catch {
  return undefined;
 }
}

/** Whether `child` is `parent` or sits beneath it. Both must already be resolved. */
function within(child: string, parent: string): boolean {
 return child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`);
}

const execFileAsync = promisify(execFile);


async function isolatedRoot(cwd: string): Promise<string | undefined> {
 try {
  // The shared base is only a discovery hint, never mutation authority.
  const configured = process.env.OMP_WORKTREE_DIR;
  const basePath = configured ? resolveToCwd(configured, os.homedir()) : path.join(os.homedir(), ".omp", "wt");
  const base = await realpathOrUndefined(basePath);
  if (base === undefined || cwd === base || !within(cwd, base)) return undefined;
  const env = { ...process.env };
  // Repository-selection overrides must not turn another checkout into authority.
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
   env,
   timeout: 1500,
   maxBuffer: 16 * 1024,
  });
  const root = await realpathOrUndefined(stdout.trim());
  return root !== undefined && root !== base && within(root, base) && within(cwd, root) ? root : undefined;
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
 * Resolve a declared path to where it would actually land, or `undefined` when it cannot
 * be resolved at all.
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

 return resolved;
}

function declaredTargets(toolName: string, input: Record<string, unknown>): string[] | undefined {
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
  return undefined;
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

const CONTROL_WORD = /(?:[A-Za-z0-9_./:=@%+,-]+|'[^']*'|"[^"$`\\]*")+/.source;
const CONTROL_COMMAND = new RegExp(`^[ \\t]*${CONTROL_WORD}(?:[ \\t]+${CONTROL_WORD})*[ \\t]*$`);

/**
 * A deliberately narrow escape from a scope conflict, not a shell safety parser.
 * Only literal standalone Beads reads and own-claim comment/release forms qualify.
 */
function conflictControl(input: Record<string, unknown>, actor: string, beadId: string): "read" | "write" | undefined {
 const command = input.command;
 if (typeof command !== "string") return undefined;
 // Reject expansion, redirection, operators and wrappers before discarding quoting.
 if (!CONTROL_COMMAND.test(command)) return undefined;
 const segments = splitSegments(command);
 if (segments.length !== 1) return undefined;
 const tokens = [...segments[0]!];
 if (tokens[0] === "env") tokens.shift();
 const environment = input.env && typeof input.env === "object" ? input.env as Record<string, unknown> : {};
 if (Object.entries(environment).some(([key, value]) => (key !== "BEADS_ACTOR" && key !== "BD_ACTOR") || value !== actor)) return undefined;
 let boundActor = environment.BEADS_ACTOR ?? environment.BD_ACTOR ?? process.env.BEADS_ACTOR ?? process.env.BD_ACTOR;
 while (tokens[0]?.includes("=")) {
  const assignment = tokens.shift()!;
  const split = assignment.indexOf("=");
  const key = assignment.slice(0, split);
  const value = assignment.slice(split + 1);
  if ((key !== "BEADS_ACTOR" && key !== "BD_ACTOR") || value !== actor) return undefined;
  boundActor = value;
 }
 if (tokens.shift() !== "bd") return undefined;
 if (tokens[0] === "--actor") {
  tokens.shift();
  boundActor = tokens.shift();
 }
 if (tokens.at(-1) === "--json") tokens.pop();
 const operation = tokens.shift();
 if ((operation === "show" || operation === "comments") && tokens.length === 1 && tokens[0] === beadId) return "read";
 if ((operation === "list" || operation === "blocked" || operation === "status") && tokens.length === 0) return "read";
 if (boundActor !== actor) return undefined;
 if (operation === "comments" && tokens[0] === "add") tokens.shift();
 if ((operation === "comment" || operation === "comments") && tokens.length === 2 && tokens[0] === beadId) return "write";
 if (operation !== "update" || tokens.shift() !== beadId) return undefined;
 let released = false;
 while (tokens.length > 0) {
  const flag = tokens.shift();
  const value = tokens.shift();
  if (flag === "--assignee" && value === "" && !released) released = true;
  else if (flag !== "--status" || (value !== "open" && value !== "in_progress" && value !== "blocked")) return undefined;
 }
 return released ? "write" : undefined;
}


/** Refuse a mutation outside the tree, or the territory, the claimed bead names. */
export async function gateWorktreeScope(
 ctx: ExtensionContext,
 toolName: string,
 input: Record<string, unknown>,
): Promise<ToolCallEventResult | undefined> {
 if (!Object.hasOwn(GATED_WRITE_TOOLS, toolName)) return undefined;
 const claim = observedClaim();
 if (!claim || claim.beadIds.length === 0) return undefined;

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

 for (const beadId of claim.beadIds) {
  const bead = await bdShow(beadId);
  const control = toolName === "bash" ? conflictControl(input, claim.actor, beadId) : undefined;
  const ownsControl = control === "read" || (control === "write" && bead?.assignee === claim.actor && bead.status === "in_progress");
  if (!ownsControl) {
   const conflict = await scopeConflict(bead);
   if (conflict) return conflict;
  }
  // Fail open: an unreadable bead names no tree, and a bead that declares none
  // leaves nothing to compare. `metadata.scope` is repo-relative and needs that
  // tree as its base, so both comparisons stop here.
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
