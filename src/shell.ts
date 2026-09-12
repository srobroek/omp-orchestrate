/**
 * Shell-command parsing for the bash gates.
 *
 * Grew out of the tokeniser in
 * `agentic-packages/packages/orchestrate/scripts/orchestrator-claim-deny.py`
 * (v19.0.4, `shell_segments` / `claim_envelope` / `claim_bead_ids`). There is no
 * OMP or Bun equivalent: `Bun.$` runs a command but exposes no parsed AST, so the
 * gates would otherwise have to substring-match, which a quoted payload defeats.
 *
 * The contract these gates need is narrow: split a command line into the
 * segments a shell would run separately, and decide whether a given segment
 * invokes `bd` — without interpreting quoted payload text as syntax.
 */

/** `bd` flags that consume the following token, shared by parsing and policy gates. */
export const BD_VALUE_FLAGS: Record<string, true> = {
	"-C": true, "--directory": true, "--actor": true, "--db": true, "--dolt-auto-commit": true, "--profile": true,
	"--acceptance": true, "--add-label": true, "--append-notes": true, "-a": true, "--assignee": true, "--await-id": true,
	"--body-file": true, "--defer": true, "-d": true, "--description": true, "--design": true, "--design-file": true,
	"--due": true, "-e": true, "--estimate": true, "--external-ref": true, "--metadata": true, "--notes": true,
	"--parent": true, "-p": true, "--priority": true, "--remove-label": true, "--session": true, "--set-labels": true,
	"--set-metadata": true, "--spec-id": true, "-s": true, "--status": true, "--title": true, "-t": true,
	"--type": true, "--unset-metadata": true, "--reason": true, "--reason-file": true, "--kind": true,
	"--id": true, "--labels": true, "--deps": true, "--wisp-type": true, "--metadata-field": true,
	"--label": true, "--label-any": true, "--limit": true, "--direction": true, "--sort": true,
	"--order": true, "--format": true,
};

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Control-operator characters: an unquoted run of them ends a command. */
const OPERATOR_CHARS: Record<string, true> = { ";": true, "&": true, "|": true };
/** A heredoc opener with its delimiter word, matched in place (sticky) so a long line is never re-sliced. */
const HEREDOC = /<<(-?)[ \t]*((?:'[^']*'|"[^"]*"|\\[^\s]|[^\s;&|<>"'])+)/y;

/**
 * One lexical token. Words are what a program receives as argv; the other two kinds are
 * shell syntax named so `segmentize` can keep them out of argv: operators end a command
 * (control operators, `(`/`)`, `$(`, a backtick), redirections ride beside the command they
 * apply to.
 */
type Token =
	| { kind: "word"; text: string }
	| { kind: "operator" }
	| { kind: "redirection"; text: string };

/**
 * The redirection operator starting at an unquoted `<`, `>` or `&`, or undefined when that
 * character is not one. `<<` is a heredoc and is the caller's; `<<<` is a here-string.
 */
function redirectionOperator(line: string, at: number): string | undefined {
	const ch = line[at];
	const next = line[at + 1];
	if (ch === ">") {
		if (next === ">") return ">>";
		if (next === "&") return ">&";
		if (next === "|") return ">|";
		return ">";
	}
	if (ch === "<") {
		if (next === "<") return line[at + 2] === "<" ? "<<<" : undefined;
		if (next === "&") return "<&";
		if (next === ">") return "<>";
		return "<";
	}
	if (ch === "&" && next === ">") return line[at + 2] === ">" ? "&>>" : "&>";
	return undefined;
}

/**
 * Tokenize a static shell command: quoted operands are preserved, heredoc bodies are
 * skipped, and redirections are read the way a shell reads them -- a `2>&1` or `> file`
 * is one redirection token, not words, and a digit run is its file descriptor only when
 * it is the whole word so far (`echo a2>f` writes `a2`).
 */
function tokenize(line: string): Token[] {
	const tokens: Token[] = [];
	let current = "";
	let started = false;
	let quote: '"' | "'" | undefined;
	/** A redirection operator waiting for its target word. */
	let pending: string | undefined;
	const heredocs: { delimiter: string; stripTabs: boolean }[] = [];

	const flush = (): void => {
		if (!started) return;
		if (pending === undefined) {
			tokens.push({ kind: "word", text: current });
		} else {
			tokens.push({ kind: "redirection", text: pending + current });
			pending = undefined;
		}
		current = "";
		started = false;
	};
	/** End of a command: a redirection still waiting for its target has none. */
	const settle = (): void => {
		flush();
		if (pending !== undefined) {
			tokens.push({ kind: "redirection", text: pending });
			pending = undefined;
		}
	};
	const operator = (): void => {
		settle();
		tokens.push({ kind: "operator" });
	};
	/** Begin a redirection, taking a bare digit word before it as the descriptor. */
	const redirect = (op: string): void => {
		if (started && pending === undefined && /^\d+$/.test(current)) {
			pending = current + op;
			current = "";
			started = false;
			return;
		}
		settle();
		pending = op;
	};

	for (let i = 0; i < line.length; i++) {
		const ch = line[i] as string;

		if (quote) {
			if (ch === quote) {
				quote = undefined;
			} else if (ch === "\\" && quote === '"' && i + 1 < line.length) {
				const escaped = line[++i] as string;
				if (escaped !== "\n") current += escaped;
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
				const escaped = line[++i] as string;
				if (escaped !== "\n") {
					current += escaped;
					started = true;
				}
			}
			continue;
		}

		if (ch === "#" && !started) {
			while (i + 1 < line.length && line[i + 1] !== "\n") i++;
			continue;
		}

		// Group punctuation and command substitution: what runs inside is its own command.
		if (ch === "(" || ch === ")" || ch === "`") {
			operator();
			continue;
		}
		if (ch === "$" && line[i + 1] === "(") {
			operator();
			i += 1;
			continue;
		}

		if (ch === "<" && line[i + 1] === "<" && line[i + 2] !== "<") {
			HEREDOC.lastIndex = i;
			const match = HEREDOC.exec(line);
			// The delimiter word is part of the operator, so the token is complete here.
			redirect(match ? match[0] : "<<");
			tokens.push({ kind: "redirection", text: pending as string });
			pending = undefined;
			if (match) {
				const raw = match[2] as string;
				const delimiter = raw.replace(/'([^']*)'|"([^"]*)"|\\(.)/g, (_all, single, double, escaped) => single ?? double ?? escaped);
				heredocs.push({ delimiter, stripTabs: match[1] === "-" });
				i += match[0].length - 1;
			} else {
				i += 1;
			}
			continue;
		}

		const op = redirectionOperator(line, i);
		if (op !== undefined) {
			// `<(...)` / `>(...)` is process substitution: a command, not a file.
			if (op.length === 1 && line[i + 1] === "(") {
				operator();
				i += 1;
				continue;
			}
			redirect(op);
			i += op.length - 1;
			continue;
		}

		if (ch === "\n") {
			operator();
			for (const heredoc of heredocs) {
				let found = false;
				while (i + 1 < line.length) {
					const start = i + 1;
					const end = line.indexOf("\n", start);
					const stop = end === -1 ? line.length : end;
					const body = line.slice(start, stop);
					i = stop;
					if ((heredoc.stripTabs ? body.replace(/^\t+/, "") : body) === heredoc.delimiter) {
						found = true;
						break;
					}
				}
				if (!found) return tokens;
			}
			heredocs.length = 0;
			continue;
		}

		if (ch === " " || ch === "\t") {
			flush();
			continue;
		}

		if (OPERATOR_CHARS[ch]) {
			while (i + 1 < line.length && OPERATOR_CHARS[line[i + 1] as string]) i++;
			operator();
			continue;
		}

		current += ch;
		started = true;
	}

	// An unterminated quote is a malformed command. Python's shlex raises
	// ValueError and the caller skips that line; do the same by discarding the
	// partial token rather than inventing one.
	if (quote) return tokens;

	settle();
	return tokens;
}

/** One simple command: its argv words, and the redirections a shell applies to it. */
interface Segment {
	words: string[];
	/** As written, less the whitespace between operator and target: `2>&1`, `>/dev/null`, `<<EOF`. */
	redirections: string[];
}

/** Split on unquoted operators, group punctuation and non-continued newlines. */
function segmentize(command: string): Segment[] {
	const segments: Segment[] = [];
	let current: Segment = { words: [], redirections: [] };
	for (const token of tokenize(command)) {
		if (token.kind === "word") {
			current.words.push(token.text);
		} else if (token.kind === "redirection") {
			current.redirections.push(token.text);
		} else if (current.words.length > 0 || current.redirections.length > 0) {
			segments.push(current);
			current = { words: [], redirections: [] };
		}
	}
	if (current.words.length > 0 || current.redirections.length > 0) segments.push(current);
	return segments;
}

/** The argv words of each command a shell would run separately; redirections are not words. */
export function splitSegments(command: string): string[][] {
	return segmentize(command).map(segment => segment.words);
}

/** A duration operand, as `timeout` accepts it: `5`, `0.5`, `30s`, `2m`. */
const DURATION = /^\d+(?:\.\d+)?[smhd]?$/;

/**
 * Words the shell reads as syntax at command position, so the program is the token after
 * them: `for id in ...; do bd update $id --claim; done` runs bd from the `do` segment, and
 * `if bd show x; then` from the `if` one. `{`/`}` are reserved only as separate words -- a
 * glued `{bd` is a syntax error, not a group -- and `${VAR}` stays one word.
 */
const RESERVED_WORDS: Record<string, true> = {
	if: true, then: true, else: true, elif: true, fi: true,
	do: true, done: true, while: true, until: true,
	"{": true, "}": true, "!": true,
};

/** A runner word: how its own flags and operands are told apart from the command it runs. */
interface Runner {
	/** Bare operands are durations rather than the command: `timeout -k 2 5 bd ...` carries two. */
	takesDuration: boolean;
	/** Flags whose operand is the next token, so that token is not the program: `timeout -s KILL`. */
	operandFlags?: Record<string, true>;
}

/**
 * Runner words that stand in front of the real command without changing which
 * program runs.
 *
 * These are not evasion shapes, which is the point of covering them: a worker that
 * writes `timeout 30 bd ready --claim`, `nohup bd update x --claim &` or
 * `bd list --json | jq -r '.[].id' | xargs -n1 bd close` is making an ordinary
 * command-line choice, and a gate that goes blind there fails on the honest path it
 * exists to cover.
 */
const TRANSPARENT_PREFIXES: Record<string, Runner> = {
	command: { takesDuration: false },
	builtin: { takesDuration: false },
	exec: { takesDuration: false, operandFlags: { "-a": true } },
	nohup: { takesDuration: false },
	time: { takesDuration: false },
	timeout: { takesDuration: true, operandFlags: { "-s": true, "--signal": true, "-k": true, "--kill-after": true } },
	stdbuf: { takesDuration: false, operandFlags: { "-i": true, "-o": true, "-e": true, "--input": true, "--output": true, "--error": true } },
	xargs: {
		takesDuration: false,
		operandFlags: {
			"-I": true, "-n": true, "-P": true, "-L": true, "-s": true, "-d": true, "-E": true, "-a": true,
			"--max-args": true, "--max-procs": true, "--max-lines": true, "--max-chars": true,
			"--delimiter": true, "--eof": true, "--arg-file": true,
		},
	},
};

/** Shells whose `-c` payload is a command line in its own right. */
const WRAPPER_SHELLS: Record<string, true> = { sh: true, bash: true, zsh: true, dash: true, ksh: true };

/** Wrapper-shell options whose operand is the next token, so that token is not the payload. */
const SHELL_OPTION_OPERAND: Record<string, true> = {
	"-o": true, "+o": true, "-O": true, "+O": true, "--rcfile": true, "--init-file": true,
};

/**
 * Advance past transparent runner prefixes, returning the index of the token that
 * names the program actually being run.
 *
 * Operands are recognised by shape rather than counted, because a flag can take one
 * of its own: `timeout -k 2 5` carries a kill delay and a duration, and a fixed
 * count would stop on the duration and read it as the program.
 */
function skipTransparentPrefix(segment: readonly string[], from: number): number {
	let index = from;
	while (index < segment.length) {
		const name = basename(segment[index] as string);
		// Own keys only. An arbitrary token indexing this literal otherwise reaches
		// `Object.prototype`, so `valueOf bd ready --claim` would be seen through as if
		// `valueOf` were a runner prefix.
		const runner = Object.hasOwn(TRANSPARENT_PREFIXES, name) ? TRANSPARENT_PREFIXES[name] : undefined;
		if (runner === undefined) break;
		index += 1;
		while (index < segment.length) {
			const next = segment[index] as string;
			if (runner.operandFlags?.[next] === true) {
				index += 2;
				continue;
			}
			// Flags belong to the runner, not the payload.
			if (next.startsWith("-")) {
				index += 1;
				continue;
			}
			if (runner.takesDuration && DURATION.test(next)) {
				index += 1;
				continue;
			}
			break;
		}
	}
	return index;
}

/**
 * `env` options whose operand is the next word, so that word is not the program:
 * `env -u NAME bd ...` and `env -C DIR bd ...` run bd. Long options also take the
 * operand inline (`--unset=NAME`), short ones glued (`-uNAME`), as getopt reads them.
 * `-S` splits its string into further `env` words and `leafSegments` splices them in;
 * `-P` is BSD env's alternate `PATH`. Every other option is a switch (`-i`, `-0`, `-v`).
 */
const ENV_OPERAND_FLAGS: Record<string, true> = {
	"-u": true, "--unset": true,
	"-C": true, "--chdir": true,
	"-S": true, "--split-string": true,
	"-P": true,
};

/** What a segment's assignment and `env` prefix does to the environment before its program runs. */
interface EnvEdits {
	/** `KEY=VALUE` words, inline or as `env` operands. */
	assignments: Map<string, string>;
	/** Names removed by `env -u NAME`, `--unset NAME` or `--unset=NAME`, in order. */
	unsets: string[];
	/** The first `env -S STR` on the walk, for the caller that splices its words in. */
	split?: { at: number; consumed: number; text: string };
}

function noEnvEdits(): EnvEdits {
	return { assignments: new Map<string, string>(), unsets: [] };
}

/**
 * Advance past `KEY=VALUE` assignments and an `env [-flags] KEY=VALUE...` prefix,
 * recording what they do to the environment when a collector is given.
 */
function skipEnvPrefix(segment: readonly string[], from: number, edits?: EnvEdits): number {
	const assign = (token: string): void => {
		if (edits === undefined) return;
		const cut = token.indexOf("=");
		edits.assignments.set(token.slice(0, cut), token.slice(cut + 1));
	};
	let index = from;
	while (index < segment.length && ASSIGNMENT.test(segment[index] as string)) {
		assign(segment[index] as string);
		index += 1;
	}
	const env = segment[index];
	if (env === undefined || basename(env) !== "env") return index;
	index += 1;
	while (index < segment.length) {
		const token = segment[index] as string;
		if (ASSIGNMENT.test(token)) {
			assign(token);
			index += 1;
			continue;
		}
		if (!token.startsWith("-")) break;
		let { flag, inline } = splitFlag(token);
		if (ENV_OPERAND_FLAGS[flag] !== true && !token.startsWith("--") && token.length > 2 && ENV_OPERAND_FLAGS[token.slice(0, 2)] === true) {
			flag = token.slice(0, 2);
			inline = token.slice(2);
		}
		if (ENV_OPERAND_FLAGS[flag] !== true) {
			// A switch, or the `--` that ends the options.
			index += 1;
			continue;
		}
		const operand = inline ?? segment[index + 1];
		const consumed = inline === undefined ? 2 : 1;
		if (edits !== undefined && operand !== undefined) {
			if (flag === "-u" || flag === "--unset") edits.unsets.push(operand);
			else if ((flag === "-S" || flag === "--split-string") && edits.split === undefined) {
				edits.split = { at: index, consumed, text: operand };
			}
		}
		index += consumed;
	}
	return index;
}

/**
 * Index of the token naming the program a segment runs: past reserved words, inline
 * assignments, an `env` prefix and transparent runners, in the order a shell reads
 * them (`then BEADS_ACTOR=w timeout 5 bd ...`).
 */
function programIndex(segment: readonly string[], edits?: EnvEdits): number {
	let index = 0;
	while (index < segment.length && RESERVED_WORDS[segment[index] as string] === true) index += 1;
	index = skipEnvPrefix(segment, index, edits);
	return skipTransparentPrefix(segment, index);
}

/** Builtins whose `NAME=VALUE` operands set variables the way an assignment prefix does. */
const ASSIGNING_BUILTINS: Record<string, true> = { export: true, declare: true, typeset: true, readonly: true, local: true };

/**
 * Whether one segment sets or unsets the variable `name`: as an assignment prefix
 * (`NAME=v bd ...`, `env NAME=v bd ...`), an `env -u NAME` removal, or through a variable
 * builtin (`export NAME=v`, `unset NAME`). A tool's `env` parameter sets a default the
 * command text can override, so a gate that relies on a variable has to read the text.
 */
export function editsVariable(segment: readonly string[], name: string): boolean {
	const edits = noEnvEdits();
	const index = programIndex(segment, edits);
	if (edits.assignments.has(name) || edits.unsets.includes(name)) return true;
	const program = segment[index];
	if (program === undefined) return false;
	const operands = segment.slice(index + 1);
	if (program === "unset") return operands.includes(name);
	if (ASSIGNING_BUILTINS[program] === true) return operands.some(word => word.startsWith(`${name}=`));
	return false;
}

/** Bound on wrapper-shell recursion, so a self-nesting payload cannot spin. */
const MAX_WRAPPER_DEPTH = 4;

/**
 * The command string a wrapper shell runs, or undefined when the segment carries none.
 *
 * Options are read as the shell reads them: a `c` anywhere in a flag bundle selects
 * command mode (`-ce`, `-lc`), further options may follow it (`bash -c -x '...'`),
 * `-o`/`-O` take an operand, and `--` ends the options. The payload is the first operand.
 */
function wrapperPayload(words: readonly string[], head: number): string | undefined {
	let commandMode = false;
	for (let index = head + 1; index < words.length; index++) {
		const token = words[index] as string;
		if (token === "--") return commandMode ? words[index + 1] : undefined;
		if (token.length > 1 && (token[0] === "-" || token[0] === "+")) {
			if (/^-[A-Za-z]*c[A-Za-z]*$/.test(token)) commandMode = true;
			if (SHELL_OPTION_OPERAND[token] === true) index += 1;
			continue;
		}
		return commandMode ? token : undefined;
	}
	return undefined;
}

/**
 * Executable leaf segments, expanding static shell wrappers and eval payloads. A
 * wrapper's own redirections apply to everything its payload runs, so they are carried
 * onto each leaf. `env -S STR` is expanded in place: env splits the string into further
 * words of its own, so `env -S 'FOO=1 bd' update x` runs `bd update x` under `FOO=1`.
 */
function leafSegments(command: string, depth: number): Segment[] {
	const expanded: Segment[] = [];
	for (const segment of segmentize(command)) {
		if (depth >= MAX_WRAPPER_DEPTH) {
			expanded.push(segment);
			continue;
		}

		const edits = noEnvEdits();
		let head = programIndex(segment.words, edits);
		if (edits.split !== undefined) {
			const { at, consumed, text } = edits.split;
			segment.words = [...segment.words.slice(0, at), ...splitSegments(text).flat(), ...segment.words.slice(at + consumed)];
			head = programIndex(segment.words);
		}
		const words = segment.words;
		const program = words[head];
		if (program === undefined) {
			expanded.push(segment);
			continue;
		}

		let payload: string | undefined;
		if (basename(program) === "eval") {
			// `eval` concatenates its operands into one command line.
			const joined = words.slice(head + 1).join(" ");
			if (joined.length > 0) payload = joined;
		} else if (WRAPPER_SHELLS[basename(program)] === true) {
			payload = wrapperPayload(words, head);
		}
		if (payload === undefined) {
			expanded.push(segment);
			continue;
		}
		for (const leaf of leafSegments(payload, depth + 1)) {
			leaf.redirections.push(...segment.redirections);
			expanded.push(leaf);
		}
	}
	return expanded;
}

/** The argv words of each executable leaf segment, wrapper shells and `eval` expanded. */
export function effectiveSegments(command: string): string[][] {
	return leafSegments(command, 0).map(segment => segment.words);
}

function basename(p: string): string {
	const cut = p.lastIndexOf("/");
	return cut === -1 ? p : p.slice(cut + 1);
}

/**
 * A flag token split into its name and its inline `=` operand, when it carries one.
 *
 * Every bd flag has two spellings, `--flag value` and `--flag=value`, and a matcher that
 * knows only the first is a matcher that can be walked past.
 */
export function splitFlag(token: string): { flag: string; inline?: string } {
	if (!token.startsWith("-")) return { flag: token };
	const cut = token.indexOf("=");
	if (cut === -1) return { flag: token };
	return { flag: token.slice(0, cut), inline: token.slice(cut + 1) };
}

/** The spellings pflag's `ParseBool` accepts as true, so `--claim=true` claims and `--claim=false` does not. */
const PFLAG_TRUE: Record<string, true> = { "1": true, t: true, T: true, TRUE: true, true: true, True: true };

/** A parsed `bd` invocation within one shell segment. */
export interface BdInvocation {
	/** Environment assignments carried on the segment, inline or via `env`. */
	assignments: Map<string, string>;
	/** Variables the segment removes with `env -u NAME` before bd runs, in order. */
	unsets: string[];
	/** The `bd` subcommand, e.g. `update`, `ready`, `comment`. Empty when absent. */
	subcommand: string;
	/** Positionals after the subcommand — bead ids for most subcommands. */
	positionals: string[];
	/** Every word after `bd`, flags included. Redirections are not words. */
	rest: string[];
	/** True when `--claim`, or `--claim=<true>` in a spelling bd accepts, appears after `bd`. */
	hasClaim: boolean;
	/**
	 * The redirections the shell applies to this invocation, wrapper shells included:
	 * `2>&1`, `>/dev/null`. A claim's report is read from stdout, so a gate can refuse the
	 * ones that merge stderr into it.
	 */
	redirections: string[];
}

/**
 * A bead id, as one parsed token: a lowercase word, then one or more hyphen-separated
 * groups.
 *
 * Wider than the pattern `src/bd.ts` uses to sieve ids out of a dependency record, which
 * forbids a hyphen in the suffix and so rejects `orc-chaos-c3-05k` -- a real id, since a
 * configured issue prefix may itself contain one. Exported because G6 needs the same
 * answer twice: the token after an id is a comment body, and a claim's first positional
 * is the bead whose `metadata.actor` seeds attribution. A second copy would let the two
 * disagree about what an id is.
 *
 * Matched against a single token the tokeniser produced, never against command text.
 */
export const BEAD_ID = /^[a-z][a-z0-9]*(?:-[A-Za-z0-9._]+)+$/;

/**
 * Parse one segment as a `bd` invocation, or return null when it is not one.
 *
 * Consumes leading reserved words, `KEY=VALUE` assignments, an optional
 * `env [-flags] KEY=VALUE...` prefix (its operand-taking flags modelled, so `env -u X bd`
 * runs bd) and transparent runners, then requires the next token to basename as `bd`.
 * Mirrors `claim_envelope` in the Python, except that `--claim` is reported rather than
 * required, so callers can gate on any `bd` invocation. `redirections` are the
 * segment's, as `bdInvocations` supplies them.
 */
export function parseBdInvocation(segment: readonly string[], redirections: readonly string[] = []): BdInvocation | null {
	const edits = noEnvEdits();
	const index = programIndex(segment, edits);
	const head = segment[index];
	if (head === undefined || basename(head) !== "bd") return null;

	const rest = segment.slice(index + 1);

	// Positionals, skipping flags and the values of flags that take one. The
	// first positional is the subcommand; the remainder are ids. `#` deliberately
	// still is one, because a bead id or label may contain it.
	const positionals: string[] = [];
	let skip = false;
	let hasClaim = false;
	for (const token of rest) {
		if (skip) {
			skip = false;
			continue;
		}
		const { flag, inline } = splitFlag(token);
		// `=== true`, as WRAPPER_SHELLS already does: a bead id that collides with an
		// `Object.prototype` key (`__proto__`, `toString`, `constructor`) would otherwise
		// resolve truthy here, and the parser would swallow the *following* positional as
		// its operand -- dropping the real bead id and leaving the claim gate nothing to check.
		if (BD_VALUE_FLAGS[flag] === true) {
			skip = inline === undefined;
			continue;
		}
		if (flag === "--claim") {
			if (inline === undefined || PFLAG_TRUE[inline] === true) hasClaim = true;
			continue;
		}
		if (token.startsWith("-")) continue;
		positionals.push(token);
	}

	return {
		assignments: edits.assignments,
		unsets: edits.unsets,
		subcommand: positionals[0] ?? "",
		positionals: positionals.slice(1),
		rest,
		hasClaim,
		redirections: [...redirections],
	};
}

/**
 * Every `bd` invocation in a command line, in order, including those inside a
 * wrapper shell's `-c` payload.
 */
export function bdInvocations(command: string): BdInvocation[] {
	const found: BdInvocation[] = [];
	for (const segment of leafSegments(command, 0)) {
		const parsed = parseBdInvocation(segment.words, segment.redirections);
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
		const index = programIndex(segment);
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
