/**
 * Scope-glob disjointness.
 *
 * A port of `scope-check.py`'s `_scopes_overlap`, moved from an advisory CLI into
 * something the claim gate enforces. Two beads whose `metadata.scope` globs can name a
 * common path must not run in parallel: that is precisely how two agents end up editing
 * one file and producing a conflict the shepherd then has to bounce.
 *
 * The original's bias is preserved deliberately, and it is asymmetric: a pair the text
 * comparison cannot settle is reported as **overlapping**. Its own comment gives the
 * reason — "a false positive only serializes work that was safe to parallelize, a false
 * negative puts two agents on one file."
 */

/** One step of a compiled glob. Every step but `star` consumes exactly one character. */
type CharStep = { kind: "any" } | { kind: "literal"; char: string } | { kind: "class"; member: RegExp };
type Step = CharStep | { kind: "star" };

/**
 * Compile a glob to steps, or `null` when a bracket group will not compile.
 *
 * A run of `*` collapses to one step, which is free: two adjacent "any characters" are
 * one, so a glob padded with stars costs no more than a glob with a single one.
 */
function compile(pattern: string): Step[] | null {
	const steps: Step[] = [];
	for (let index = 0; index < pattern.length; index++) {
		const char = pattern[index] as string;
		if (char === "*") {
			if (steps[steps.length - 1]?.kind !== "star") steps.push({ kind: "star" });
			continue;
		}
		if (char === "?") {
			steps.push({ kind: "any" });
			continue;
		}
		if (char !== "[") {
			steps.push({ kind: "literal", char });
			continue;
		}
		const close = pattern.indexOf("]", index + 1);
		// An unclosed bracket is a literal one.
		if (close === -1) {
			steps.push({ kind: "literal", char });
			continue;
		}
		const group = pattern.slice(index + 1, close);
		index = close;
		const body = group.startsWith("!") ? `^${group.slice(1)}` : group;
		try {
			// One regexp per group, so the bracket dialect -- ranges, negation, whatever
			// else -- stays exactly the one V8 implements rather than a hand-rolled guess.
			steps.push({ kind: "class", member: new RegExp(`^[${body}]$`, "s") });
		} catch {
			return null;
		}
	}
	return steps;
}

/**
 * Greedy match with a single backtrack point.
 *
 * `star` is the only step of variable width, so remembering just the last one is
 * complete, and `resume` only ever advances: the cost is bounded by text length times
 * step count instead of growing exponentially in the number of stars.
 */
function matchSteps(text: string, steps: readonly Step[]): boolean {
	let at = 0;
	let step = 0;
	let lastStar = -1;
	let resume = 0;
	while (at < text.length) {
		const current = steps[step];
		if (current?.kind === "star") {
			lastStar = step;
			step += 1;
			resume = at;
			continue;
		}
		const char = text[at] as string;
		const hit =
			current !== undefined &&
			(current.kind === "any" || (current.kind === "literal" ? current.char === char : current.member.test(char)));
		if (hit) {
			step += 1;
			at += 1;
			continue;
		}
		if (lastStar === -1) return false;
		// Let the last star swallow one more character and retry from just after it.
		step = lastStar + 1;
		resume += 1;
		at = resume;
	}
	while (steps[step]?.kind === "star") step += 1;
	return step === steps.length;
}

/** Longer than any real path, and far longer than any real scope glob. */
const MAX_GLOB_LENGTH = 1024;

/**
 * Python `fnmatch` semantics, which is what the original compared with.
 *
 * `*` means "any characters" and therefore crosses `/`, unlike a shell glob or
 * `Bun.Glob`. That difference is load-bearing: the original matches one glob string
 * against another as text, so `src/api/*` subsuming `src/api/*.py` depends on `*`
 * spanning separators.
 *
 * Matched step by step rather than by translating the glob into a regexp. That
 * translation turned every `*` into `.*`, and a pattern carrying a dozen of them
 * backtracked exponentially: the claim gate calls this on `metadata.scope`, which any
 * agent can write, and the 38-character `src*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*b` against
 * a literal sibling scope took 7 seconds at sixteen stars and doubled per star. A gate
 * that does not return blocks the bash call it was inspecting, so that is an outage.
 *
 * Exported so the parity suite can judge the rewrite against the retired translation
 * directly; `scopesOverlap` is the only caller in the plugin.
 */
export function fnmatch(text: string, pattern: string): boolean {
	// Neither operand is a path at this length, and comparing them would cost their
	// product in character tests. Unsettleable, and this module's bias is to call what it
	// cannot settle a conflict.
	if (text.length > MAX_GLOB_LENGTH || pattern.length > MAX_GLOB_LENGTH) return true;
	const steps = compile(pattern);
	// An untranslatable bracket group cannot be settled either. Same bias.
	if (steps === null) return true;
	return matchSteps(text, steps);
}

/**
 * Whether a wildcard sits above the glob's last path segment.
 *
 * That makes the segment-wise text comparison unsound: `src/a*​/f.py` and `src/*b/f.py`
 * share `src/ab/f.py` while matching in neither direction. Covers `**`, which `fnmatch`
 * does not treat as spanning separators.
 */
export function deepWildcard(glob: string): boolean {
	const cut = glob.lastIndexOf("/");
	return (cut === -1 ? "" : glob.slice(0, cut)).includes("*");
}

/** The literal prefix of a glob, before its first wildcard, without a trailing slash. */
function literalPrefix(glob: string): string {
	const star = glob.indexOf("*");
	const head = star === -1 ? glob : glob.slice(0, star);
	return head.replace(/\/+$/, "");
}

/** True when any glob in `a` can name a path some glob in `b` also names. */
export function scopesOverlap(a: readonly string[], b: readonly string[]): boolean {
	for (const globA of a) {
		const prefixA = literalPrefix(globA);
		for (const globB of b) {
			const prefixB = literalPrefix(globB);

			// A bare `**` has no literal prefix and owns everything.
			if (prefixA.length === 0 || prefixB.length === 0) return true;

			// One prefix contains the other: nested directories.
			if (prefixA.startsWith(`${prefixB}/`) || prefixB.startsWith(`${prefixA}/`)) return true;

			if (prefixA === prefixB) {
				// A wildcard-free scope owns that whole path outright.
				if (!globA.includes("*") || !globB.includes("*")) return true;
				if (deepWildcard(globA) || deepWildcard(globB)) return true;
				if (fnmatch(globA, globB) || fnmatch(globB, globA)) return true;
				continue;
			}

			if (fnmatch(prefixA, globB) || fnmatch(prefixB, globA)) return true;

			// Sibling prefixes diverging mid-segment: the wildcard that ended the
			// shorter prefix can still expand across the longer one.
			if (
				(prefixA.startsWith(prefixB) && deepWildcard(globB)) ||
				(prefixB.startsWith(prefixA) && deepWildcard(globA))
			) {
				return true;
			}
		}
	}
	return false;
}

/** The `scope` globs a bead declares, or an empty list when it declares none. */
export function scopeOf(metadata: Record<string, unknown> | undefined): string[] {
	const raw = metadata?.scope;
	if (typeof raw === "string") {
		// Stamped as a JSON array in a string by some producers.
		try {
			const parsed: unknown = JSON.parse(raw);
			if (Array.isArray(parsed)) return parsed.filter((entry): entry is string => typeof entry === "string");
		} catch {
			return [raw];
		}
		return [raw];
	}
	if (Array.isArray(raw)) return raw.filter((entry): entry is string => typeof entry === "string");
	return [];
}
