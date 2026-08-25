/**
 * G2 — mutations stay inside the tree, and the territory, the claimed bead names.
 *
 * Restores the bead-keyed write enforcement that died when the `worktrunk-writer`
 * package was deleted, and moves it earlier: v19 detected an out-of-scope write at
 * `SubagentStop`, after it had landed. This refuses it before it happens.
 *
 * Two comparisons, in this order:
 *
 *  1. Containment. The session's cwd, and every path the tool declares it will write,
 *     must resolve inside `metadata.worktree`. Resolution goes through the filesystem,
 *     so `../`, an absolute path into another checkout, and a symlink planted inside the
 *     tree all land outside it and are refused.
 *  2. Territory. When the bead also declares `metadata.scope`, a target that is inside
 *     the tree but that none of those globs can name is refused too. Until now
 *     `metadata.scope` was read only by G5, at claim time, to keep two beads' globs
 *     disjoint — nothing compared it against an actual write.
 *
 * The actor is not looked up. It arrives from the claim gate, which observes this
 * session's own `bd ... --claim` — see `src/claim-state.ts` for why a cold lookup is
 * circular.
 *
 * Every unknown fails open, and each one is marked below: no observed claim, an
 * unreadable bead, a bead declaring no worktree or no scope, a target path that will not
 * resolve. The asymmetry is deliberate. A refusal costs one tool call the agent can read
 * a reason for and retry; a missed escape lets a worker write into another agent's tree,
 * which surfaces later as a conflict nobody can attribute. So a proven violation is
 * refused and everything unsettled is allowed — and nothing here throws, because a
 * throwing gate blocks the call it was inspecting outright.
 */

import path from "node:path";
import fs from "node:fs/promises";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ToolCallEventResult } from "@oh-my-pi/pi-coding-agent";
import { bdShow, metadataString } from "../bd";
import { observedClaim } from "../claim-state";
import { fnmatch, scopeOf } from "../scope";

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
	return child === parent || child.startsWith(`${parent}${path.sep}`);
}

/**
 * The base directory OMP materialises task isolation workspaces under.
 *
 * An isolated worker's cwd is its isolation copy, not the feature worktree the bead
 * names, so a cwd under this base is legitimate and must pass. `OMP_WORKTREE_DIR`
 * overrides the `task.worktreeDir` setting, which itself defaults to `~/.omp/wt`.
 */
function isolationBase(): string {
	const configured = process.env.OMP_WORKTREE_DIR;
	if (configured !== undefined && configured.length > 0) return configured;
	return path.join(process.env.HOME ?? "", ".omp", "wt");
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

/** A hashline section header, `[PATH#TAG]`, alone on its line. */
const SECTION_HEADER = /^\[(.+)#[0-9A-Fa-f]{4}\]\s*$/;
/**
 * A hashline `MV DEST`, which renames the section's file and so names a second target.
 * The quoted alternatives come first because `MV` allows them around a path containing
 * spaces, and the bare form would otherwise capture the quotes as part of the name.
 */
const MOVE_OP = /^MV\s+(?:"([^"]*)"|'([^']*)'|(\S.*?))\s*$/;

/**
 * Every path an `edit` declares it will touch: one per section header, plus the
 * destination of any `MV`, which is a write to a second file and escapes the same way.
 *
 * Reading the patch is safe because body rows all begin with `+`, so neither pattern can
 * match agent-supplied content. A patch whose headers do not parse yields no target and
 * the gate falls through to the cwd comparison alone.
 */
function hashlineTargets(raw: unknown): string[] {
	if (typeof raw !== "string") return [];
	const targets: string[] = [];
	for (const line of raw.split("\n")) {
		const section = SECTION_HEADER.exec(line);
		if (section?.[1] !== undefined) {
			targets.push(section[1]);
			continue;
		}
		const move = MOVE_OP.exec(line);
		const destination = move?.[1] ?? move?.[2] ?? move?.[3];
		if (destination !== undefined && destination.length > 0) targets.push(destination);
	}
	return targets;
}

/**
 * The paths a gated write tool declares it will mutate.
 *
 * `bash` is deliberately absent, and that is not an oversight. A shell command's write
 * targets hide in redirections, heredocs, `tee`, `cp`, `sed -i`, and anything a subshell
 * or a variable expands; a parser for that would be confidently wrong far more often
 * than it was right, and each wrong answer is either a refused honest command or a false
 * sense of containment. `bash` stays covered by the cwd comparison, which every command
 * inherits, and by G3's refusal of any checkout the tree does not own.
 *
 * A tool whose input does not carry a path in the shape below yields no target, and the
 * gate degrades to the cwd comparison rather than guessing.
 */
function declaredTargets(toolName: string, input: Record<string, unknown>): string[] {
	if (toolName === "write") {
		const target = input.path;
		return typeof target === "string" && target.length > 0 ? [target] : [];
	}
	if (toolName === "edit") return hashlineTargets(input.input);
	return [];
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
	// A leading `./` or `/` is how a repo-relative glob is sometimes written, and
	// `path.relative` never produces either, so strip both rather than refuse over it.
	const trimmed = glob.replace(/^\.?\/+/, "").replace(/\/+$/, "");
	// A glob that is nothing but separators owns the whole tree.
	if (trimmed.length === 0) return true;
	return fnmatch(relative, trimmed) || fnmatch(relative, `${trimmed}/*`);
}

/** Refuse a mutation outside the tree, or the territory, the claimed bead names. */
export async function gateWorktreeScope(
	ctx: ExtensionContext,
	toolName: string,
	input: Record<string, unknown>,
): Promise<ToolCallEventResult | undefined> {
	const claim = observedClaim();
	// Fail open: nothing was observed this session, so no bead names a territory.
	if (!claim || claim.beadIds.length === 0) return undefined;

	const cwd = await realpathOrUndefined(ctx.cwd);
	// Fail open: an unresolvable cwd makes every comparison below meaningless.
	if (cwd === undefined) return undefined;

	// An isolated worker writes in its own copy; the bead still names the feature
	// worktree it was cloned from, so a comparison would always mismatch. Targets are
	// exempt for the same reason: they resolve into the copy, never into the original.
	const base = await realpathOrUndefined(isolationBase());
	if (base !== undefined && within(cwd, base)) return undefined;

	const targets: Target[] = [];
	for (const declared of declaredTargets(toolName, input)) {
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
		// Fail open: an unreadable bead names no tree, and a bead that declares none
		// leaves nothing to compare. `metadata.scope` is repo-relative and needs that
		// tree as its base, so both comparisons stop here.
		const declaredTree = metadataString(bead, "worktree");
		if (declaredTree === undefined) continue;

		const worktree = await realpathOrUndefined(declaredTree);
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

		// Fail open: no declared scope, no territory to be outside of. A bead whose
		// metadata arrives as a JSON string declares none here, matching how
		// `metadataString` reads `worktree` above — one gate must not enforce half a bead.
		const globs = scopeOf(bead?.metadata);
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
