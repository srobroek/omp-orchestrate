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

/**
 * Python `fnmatch` semantics, which is what the original compared with.
 *
 * `*` maps to `.*` and therefore crosses `/`, unlike a shell glob or `Bun.Glob`. That
 * difference is load-bearing: the original matches one glob string against another as
 * text, so `src/api/*` subsuming `src/api/*.py` depends on `*` spanning separators.
 */
function fnmatch(text: string, pattern: string): boolean {
	let source = "";
	for (let index = 0; index < pattern.length; index++) {
		const char = pattern[index] as string;
		if (char === "*") {
			source += ".*";
		} else if (char === "?") {
			source += ".";
		} else if (char === "[") {
			const close = pattern.indexOf("]", index + 1);
			if (close === -1) {
				source += "\\[";
			} else {
				let group = pattern.slice(index + 1, close);
				index = close;
				if (group.startsWith("!")) group = `^${group.slice(1)}`;
				source += `[${group}]`;
			}
		} else {
			source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
		}
	}
	try {
		return new RegExp(`^${source}$`, "s").test(text);
	} catch {
		// An untranslatable pattern cannot be settled, and this module's bias is to
		// treat what it cannot settle as a conflict.
		return true;
	}
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
