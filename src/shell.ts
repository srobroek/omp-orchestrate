/**
 * Shell-command parsing for the bash gates.
 *
 * A faithful port of the tokeniser in
 * `agentic-packages/packages/orchestrate/scripts/orchestrator-claim-deny.py`
 * (v19.0.4, `shell_segments` / `claim_envelope` / `claim_bead_ids`). There is no
 * OMP or Bun equivalent: `Bun.$` runs a command but exposes no parsed AST, so the
 * gates would otherwise have to substring-match, which a quoted payload defeats.
 *
 * The contract these gates need is narrow: split a command line into the
 * segments a shell would run separately, and decide whether a given segment
 * invokes `bd` — without interpreting quoted payload text as syntax.
 */

/** Global `bd` flags that consume the following token. */
const VALUE_FLAGS: Record<string, true> = {
	"-C": true,
	"--actor": true,
	"--db": true,
	"--directory": true,
	"--dolt-auto-commit": true,
};

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const OPERATOR_CHARS: Record<string, true> = { ";": true, "&": true, "|": true };
/** Punctuation that closes a group rather than naming an operand. */
const GROUPING: Record<string, true> = { ")": true, "}": true };

/**
 * POSIX-ish tokeniser matching Python's
 * `shlex.shlex(line, posix=True, punctuation_chars=";&|")` with
 * `whitespace_split = True` and `commenters = ""`.
 *
 * Quotes group without being interpreted further, backslash escapes the next
 * character outside single quotes, and runs of `;&|` become standalone operator
 * tokens so the caller can split on them. `#` is NOT a comment, matching
 * `commenters = ""` — a bead id or label may legitimately contain one.
 */
function tokenize(line: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let started = false;
	let quote: '"' | "'" | undefined;

	const flush = (): void => {
		if (started) {
			tokens.push(current);
			current = "";
			started = false;
		}
	};

	for (let i = 0; i < line.length; i++) {
		const ch = line[i] as string;

		if (quote) {
			if (ch === quote) {
				quote = undefined;
			} else if (ch === "\\" && quote === '"' && i + 1 < line.length) {
				current += line[++i] as string;
			} else {
				current += ch;
			}
			continue;
		}

		if (ch === "'" || ch === '"') {
			quote = ch;
			started = true;
			continue;
		}

		if (ch === "\\") {
			if (i + 1 < line.length) {
				current += line[++i] as string;
				started = true;
			}
			continue;
		}

		if (ch === " " || ch === "\t") {
			flush();
			continue;
		}

		if (OPERATOR_CHARS[ch]) {
			flush();
			let op = ch;
			while (i + 1 < line.length && OPERATOR_CHARS[line[i + 1] as string]) {
				op += line[++i] as string;
			}
			tokens.push(op);
			continue;
		}

		current += ch;
		started = true;
	}

	// An unterminated quote is a malformed command. Python's shlex raises
	// ValueError and the caller skips that line; do the same by discarding the
	// partial token rather than inventing one.
	if (quote) return tokens;

	flush();
	return tokens;
}

/**
 * Split a command line into the segments a shell would run separately.
 *
 * `\\\n` line continuations collapse to a space first, then each line is
 * tokenised and split on tokens made purely of `;&|` — so `a && b`, `a; b`, and
 * `a | b` all yield two segments. A line that fails to tokenise is skipped.
 */
export function splitSegments(command: string): string[][] {
	const segments: string[][] = [];
	const normalized = command.replaceAll("\\\n", " ");
	const lines = normalized.split("\n");

	for (const line of lines) {
		const tokens = tokenize(line);
		let current: string[] = [];
		for (const token of tokens) {
			const isOperator = token.length > 0 && [...token].every(c => OPERATOR_CHARS[c] === true);
			if (isOperator) {
				if (current.length > 0) {
					segments.push(current);
					current = [];
				}
				continue;
			}
			current.push(token);
		}
		if (current.length > 0) segments.push(current);
	}

	return segments;
}

/** A duration operand, as `timeout` accepts it: `5`, `0.5`, `30s`, `2m`. */
const DURATION = /^\d+(?:\.\d+)?[smhd]?$/;

/**
 * Runner words that stand in front of the real command without changing which
 * program runs. `takesDuration` marks the ones whose own operands are times rather
 * than the command: `timeout -k 2 5 bd ...` carries two of them.
 *
 * These are not evasion shapes, which is the point of covering them: a worker that
 * writes `timeout 30 bd ready --claim` or `nohup bd update x --claim &` is making
 * an ordinary command-line choice, and a gate that goes blind there fails on the
 * honest path it exists to cover.
 */
const TRANSPARENT_PREFIXES: Record<string, { takesDuration: boolean }> = {
	command: { takesDuration: false },
	builtin: { takesDuration: false },
	exec: { takesDuration: false },
	nohup: { takesDuration: false },
	time: { takesDuration: false },
	timeout: { takesDuration: true },
	stdbuf: { takesDuration: false },
};

/** Shells whose `-c` payload is a command line in its own right. */
const WRAPPER_SHELLS: Record<string, true> = { sh: true, bash: true, zsh: true, dash: true, ksh: true };

/**
 * Advance past grouping punctuation and transparent runner prefixes, returning the
 * index of the token that names the program actually being run.
 *
 * Operands are recognised by shape rather than counted, because a flag can take one
 * of its own: `timeout -k 2 5` carries a kill delay and a duration, and a fixed
 * count would stop on the duration and read it as the program.
 */
function skipTransparentPrefix(segment: readonly string[], from: number): number {
	let index = from;
	while (index < segment.length) {
		const token = segment[index] as string;
		if (token === "(" || token === "{" || token === "!") {
			index += 1;
			continue;
		}
		// Own keys only. An arbitrary token indexing this literal otherwise reaches
		// `Object.prototype`, so `valueOf bd ready --claim` would be seen through as if
		// `valueOf` were a runner prefix.
		const prefix = Object.hasOwn(TRANSPARENT_PREFIXES, token) ? TRANSPARENT_PREFIXES[token] : undefined;
		if (prefix === undefined) break;
		index += 1;
		while (index < segment.length) {
			const next = segment[index] as string;
			// Flags belong to the runner, not the payload.
			if (next.startsWith("-")) {
				index += 1;
				continue;
			}
			if (prefix.takesDuration && DURATION.test(next)) {
				index += 1;
				continue;
			}
			break;
		}
	}
	return index;
}

/** Bound on wrapper-shell recursion, so a self-nesting payload cannot spin. */
const MAX_WRAPPER_DEPTH = 4;

/**
 * The segments a command line effectively runs, with wrapper shells and `eval`
 * payloads expanded into segments of their own.
 *
 * A quoted payload is re-tokenised rather than pattern-matched, so `sh -c "git
 * worktree add x"` presents the same shape to a gate as the bare command. Truly
 * dynamic construction stays out of reach and is meant to: `$(which bd) update`
 * and `eval "$CMD"` name no program until the shell runs, and this parser does not
 * run anything. The gates are documented as friction rather than a security
 * boundary for exactly this reason.
 */
export function effectiveSegments(command: string, depth = 0): string[][] {
	const expanded: string[][] = [];
	for (const segment of splitSegments(command)) {
		expanded.push(segment);
		if (depth >= MAX_WRAPPER_DEPTH) continue;

		const head = skipTransparentPrefix(segment, 0);
		const program = segment[head];
		if (program === undefined) continue;

		if (basename(program) === "eval") {
			// `eval` concatenates its operands into one command line.
			const payload = segment.slice(head + 1).join(" ");
			if (payload.length > 0) expanded.push(...effectiveSegments(payload, depth + 1));
			continue;
		}

		if (WRAPPER_SHELLS[basename(program)] !== true) continue;
		// The payload follows the flag bundle that contains `c`, so `-lc` counts.
		const flagIndex = segment.findIndex((token, at) => at > head && /^-[a-z]*c$/.test(token));
		if (flagIndex === -1) continue;
		const payload = segment[flagIndex + 1];
		if (payload !== undefined) expanded.push(...effectiveSegments(payload, depth + 1));
	}
	return expanded;
}

function basename(p: string): string {
	const cut = p.lastIndexOf("/");
	return cut === -1 ? p : p.slice(cut + 1);
}

/** A parsed `bd` invocation within one shell segment. */
export interface BdInvocation {
	/** Environment assignments carried on the segment, inline or via `env`. */
	assignments: Map<string, string>;
	/** The `bd` subcommand, e.g. `update`, `ready`, `comment`. Empty when absent. */
	subcommand: string;
	/** Positionals after the subcommand — bead ids for most subcommands. */
	positionals: string[];
	/** Every token after `bd`, flags included. */
	rest: string[];
	/** True when `--claim` appears anywhere after `bd`. */
	hasClaim: boolean;
}


/**
 * Drop the trailing `)`/`}` a subshell or group close glues onto the last token.
 *
 * Balance-counted rather than trimmed, because a trimmed `--metadata '{"role":"x"}'`
 * arrives as `{"role":"x"}` and a blind strip would corrupt it into unparseable JSON --
 * turning a readable route into an unreadable one. Only an UNBALANCED closer is shell
 * punctuation; a matched pair belongs to the value.
 */
function stripGroupClose(token: string): string {
	let end = token.length;
	for (;;) {
		const last = token[end - 1];
		if (last !== ")" && last !== "}") break;
		const open = last === ")" ? "(" : "{";
		const body = token.slice(0, end);
		let depth = 0;
		for (const char of body) {
			if (char === open) depth += 1;
			else if (char === last) depth -= 1;
		}
		// depth < 0 means this closer has no opener inside the token: shell grouping.
		if (depth >= 0) break;
		end -= 1;
	}
	return token.slice(0, end);
}

/**
 * Parse one segment as a `bd` invocation, or return null when it is not one.
 *
 * Consumes leading `KEY=VALUE` assignments, an optional `env [-flags] KEY=VALUE...`
 * prefix, and an optional `command`/`builtin` wrapper, then requires the next
 * token to basename as `bd`. Mirrors `claim_envelope` in the Python, except that
 * `--claim` is reported rather than required, so callers can gate on any `bd`
 * invocation.
 */
export function parseBdInvocation(segment: string[]): BdInvocation | null {
	const assignments = new Map<string, string>();
	let index = 0;

	while (index < segment.length && ASSIGNMENT.test(segment[index] as string)) {
		const [key, ...value] = (segment[index] as string).split("=");
		assignments.set(key as string, value.join("="));
		index += 1;
	}

	if (segment[index] === "env") {
		index += 1;
		while (index < segment.length) {
			const token = segment[index] as string;
			if (ASSIGNMENT.test(token)) {
				const [key, ...value] = token.split("=");
				assignments.set(key as string, value.join("="));
			} else if (!token.startsWith("-")) {
				break;
			}
			index += 1;
		}
	}

	index = skipTransparentPrefix(segment, index);

	// A subshell or group opener glued to the command leaves `(bd` as one token, because the
	// tokeniser promotes only `;&|` to standalone operators. Stripping it here keeps
	// `(bd update x --claim)` visible: it is a plausible thing to write, and a gate that
	// misses it is a bypass rather than a rough edge.
	const head = segment[index]?.replace(/^[({]+/, "");
	if (head === undefined || head.length === 0 || basename(head) !== "bd") return null;

	// Balance-aware, because the same glued close that hides `(bd` also lands on the LAST
	// token: in `(bd -C /r update orc-1 --claim)` the tail is `--claim)`, so an exact-token
	// `--claim` test reads false and the claim gate skips a real claim.
	//
	// A token that BECAME empty was pure grouping punctuation and was never an operand. One
	// that arrived empty is an empty argument -- `bd comment orc-1 ""` -- and the verb notice
	// fires on it, so dropping that would silence a real finding.
	const rest = segment
		.slice(index + 1)
		.map(token => ({ token, stripped: stripGroupClose(token) }))
		.filter(({ token, stripped }) => stripped.length > 0 || token.length === 0)
		.map(({ stripped }) => stripped);

	// Positionals, skipping flags and the values of flags that take one. The
	// first positional is the subcommand; the remainder are ids. Grouping
	// punctuation closing a subshell is not an operand -- `#` deliberately still is,
	// because a bead id or label may contain one.
	const positionals: string[] = [];
	let skip = false;
	for (const token of rest) {
		if (skip) {
			skip = false;
			continue;
		}
		// `=== true`, as GROUPING and WRAPPER_SHELLS already do: a bead id that collides
		// with an `Object.prototype` key (`__proto__`, `toString`, `constructor`) would
		// otherwise resolve truthy here, and the parser would swallow the *following*
		// positional as its operand -- dropping the real bead id and leaving the claim
		// gate nothing to check.
		if (VALUE_FLAGS[token] === true) {
			skip = true;
			continue;
		}
		if (token.startsWith("-") || GROUPING[token] === true) continue;
		positionals.push(token);
	}

	return {
		assignments,
		subcommand: positionals[0] ?? "",
		positionals: positionals.slice(1),
		rest,
		hasClaim: rest.includes("--claim"),
	};
}

/**
 * Every `bd` invocation in a command line, in order, including those inside a
 * wrapper shell's `-c` payload.
 */
export function bdInvocations(command: string): BdInvocation[] {
	const found: BdInvocation[] = [];
	for (const segment of effectiveSegments(command)) {
		const parsed = parseBdInvocation(segment);
		if (parsed) found.push(parsed);
	}
	return found;
}

/**
 * Global flags whose operand may be written as a separate token, so that operand
 * belongs to the program rather than being its subcommand.
 *
 * Needed because the subcommand is matched positionally: without this,
 * `git -C /repo worktree add` would present `/repo` as git's subcommand and the
 * denial would be missed. The inline spellings (`--git-dir=<path>`) carry no separate
 * operand and are covered by the plain flag skip. `-R`/`--repo` are gh's.
 */
const SEPARATE_OPERAND_FLAGS: Record<string, true> = {
	"-C": true,
	"-c": true,
	"--git-dir": true,
	"--work-tree": true,
	"--namespace": true,
	"--exec-path": true,
	"--config-env": true,
	"-R": true,
	"--repo": true,
};

/**
 * True when any segment matches `argv` as a leading token sequence, ignoring an
 * `env`/assignment prefix. Used by the worktree gate for `git worktree` and
 * `gh pr checkout`, which must never run directly.
 */
export function invokesCommand(command: string, argv: readonly string[]): boolean {
	if (argv.length === 0) return false;
	for (const segment of effectiveSegments(command)) {
		let index = 0;
		while (index < segment.length && ASSIGNMENT.test(segment[index] as string)) index += 1;
		if (segment[index] === "env") {
			index += 1;
			while (index < segment.length) {
				const token = segment[index] as string;
				if (ASSIGNMENT.test(token)) index += 1;
				else if (token.startsWith("-")) index += 1;
				else break;
			}
		}
		index = skipTransparentPrefix(segment, index);

		const head = segment[index];
		if (head === undefined || basename(head) !== argv[0]) continue;
		if (argv.length === 1) return true;

		// Both git and gh spell a subcommand as the first positionals after their own
		// global flags -- `git [-c x] <cmd>`, `gh [-R x] <group> <cmd>` -- so the
		// remaining argv words must be *consecutive positionals*, not merely present in
		// order. Scanning for them anywhere refused legitimate reads whose operand
		// happened to be the word: `git log --grep worktree` and `git commit -m worktree`
		// both matched `git worktree`. Stopping at the first positional that is not the
		// expected word is git's own grammar, and it keeps `git -C /repo worktree add`
		// matching because a global flag's operand is skipped with the flag.
		let cursor = index + 1;
		let matched = 1;
		while (cursor < segment.length && matched < argv.length) {
			const token = segment[cursor] as string;
			if (token === argv[matched]) {
				matched += 1;
				cursor += 1;
				continue;
			}
			// A positional that is not the expected word names a different subcommand.
			if (!token.startsWith("-")) break;
			cursor += 1;
			if (SEPARATE_OPERAND_FLAGS[token] === true) cursor += 1;
		}
		if (matched === argv.length) return true;
	}
	return false;
}
