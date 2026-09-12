import { describe, expect, test } from "bun:test";
import { bdInvocations, editsVariable, effectiveSegments, invokesCommand, parseBdInvocation, splitSegments } from "../src/shell";

describe("splitSegments", () => {
	test("splits on every shell operator", () => {
		expect(splitSegments("a && b")).toEqual([["a"], ["b"]]);
		expect(splitSegments("a; b")).toEqual([["a"], ["b"]]);
		expect(splitSegments("a | b")).toEqual([["a"], ["b"]]);
		expect(splitSegments("a || b; c")).toEqual([["a"], ["b"], ["c"]]);
	});

	test("group punctuation and substitutions bound a command like an operator", () => {
		// Each of these runs what it encloses as a command of its own, so a glued `(bd`
		// or `$(bd` must not hide `bd` inside a longer word.
		expect(splitSegments("(a; b) | c")).toEqual([["a"], ["b"], ["c"]]);
		expect(splitSegments("x=$(a b) c")).toEqual([["x="], ["a", "b"], ["c"]]);
		expect(splitSegments("echo `a b`")).toEqual([["echo"], ["a", "b"]]);
		expect(splitSegments("case x in x) a;; esac")).toEqual([["case", "x", "in", "x"], ["a"], ["esac"]]);
	});

	test("redirections are not words", () => {
		expect(splitSegments("bd update x --claim 2>&1 > out")).toEqual([["bd", "update", "x", "--claim"]]);
		// `2>&1` used to split on its `&`, presenting `1` as a second command.
		expect(splitSegments("bd 2>&1 | head")).toEqual([["bd"], ["head"]]);
	});

	test("a digit run is a descriptor only when it is the whole word", () => {
		// `echo a2>x` writes `a2`; `echo 2>x` writes nothing and redirects stderr.
		expect(splitSegments("echo a2>x")).toEqual([["echo", "a2"]]);
		expect(splitSegments("echo 2>x")).toEqual([["echo"]]);
	});

	test("collapses line continuations before tokenising", () => {
		expect(splitSegments("bd update x \\\n  --claim")).toEqual([["bd", "update", "x", "--claim"]]);
	});

	test("does not treat quoted operators as syntax", () => {
		// The whole point of tokenising: a payload containing `&&` or `;` must not
		// split the segment, or a gate could be evaded by quoting.
		expect(splitSegments(`bd comment x "a && b; c"`)).toEqual([["bd", "comment", "x", "a && b; c"]]);
	});

	test("preserves hashes inside operands", () => {
		expect(splitSegments("bd show orc#1")).toEqual([["bd", "show", "orc#1"]]);
	});

	test("discards a partial token from an unterminated quote", () => {
		expect(splitSegments(`bd comment x "unterminated`)).toEqual([["bd", "comment", "x"]]);
	});

	test("separates newline commands and ignores shell comments", () => {
		expect(bdInvocations("printf ready\n# explanation\nbd update orc-1 --set-metadata role=reviewer")[0]?.subcommand).toBe("update");
		expect(invokesCommand("true # explanation\ngit worktree add /tmp/foreign-tree", ["git", "worktree"])).toBe(true);
	});

	test("heredoc bodies are data while commands after delimiters remain visible", () => {
		const command = "cat <<'EOF'\nbd update orc-hidden --claim\nEOF\nbd update orc-real --claim";
		expect(bdInvocations(command).map(call => call.positionals)).toEqual([["orc-real"]]);
		expect(invokesCommand("cat <<-EOF\n\tgit worktree add hidden\n\tEOF\ngit worktree add real", ["git", "worktree"])).toBe(true);
		expect(invokesCommand("cat <<EOF\ngit worktree add hidden\nEOF", ["git", "worktree"])).toBe(false);
	});

	test("continuations join words but quoted newlines remain operands", () => {
		expect(splitSegments("b\\\nd ready")).toEqual([["bd", "ready"]]);
		expect(splitSegments("printf 'a\\\nb'")).toEqual([["printf", "a\\\nb"]]);
	});
});

describe("parseBdInvocation", () => {
	test("returns null for a non-bd segment", () => {
		expect(parseBdInvocation(["git", "status"])).toBeNull();
		expect(parseBdInvocation([])).toBeNull();
	});

	test("matches bd through an absolute path", () => {
		expect(parseBdInvocation(["/usr/local/bin/bd", "ready"])?.subcommand).toBe("ready");
	});

	test("collects inline environment assignments", () => {
		const parsed = parseBdInvocation(["BEADS_ACTOR=a-1", "BD_ACTOR=a-1", "bd", "update", "x", "--claim"]);
		expect(parsed?.assignments.get("BEADS_ACTOR")).toBe("a-1");
		expect(parsed?.assignments.get("BD_ACTOR")).toBe("a-1");
		expect(parsed?.hasClaim).toBe(true);
		expect(parsed?.subcommand).toBe("update");
		expect(parsed?.positionals).toEqual(["x"]);
	});

	test("collects assignments behind an env prefix with flags", () => {
		const parsed = parseBdInvocation(["env", "-i", "BD_ACTOR=w-2", "bd", "update", "y", "--claim"]);
		expect(parsed?.assignments.get("BD_ACTOR")).toBe("w-2");
		expect(parsed?.positionals).toEqual(["y"]);
	});

	test("sees through a command or builtin wrapper", () => {
		expect(parseBdInvocation(["command", "bd", "update", "z", "--claim"])?.positionals).toEqual(["z"]);
		expect(parseBdInvocation(["builtin", "bd", "show", "z"])?.subcommand).toBe("show");
	});

	test("keeps an = inside an assignment value", () => {
		const parsed = parseBdInvocation(["Q=a=b", "bd", "ready"]);
		expect(parsed?.assignments.get("Q")).toBe("a=b");
	});

	test("skips the value of a flag that consumes one", () => {
		// Without VALUE_FLAGS, `/tmp` would read as the subcommand and `update`
		// as the bead id.
		const parsed = parseBdInvocation(["bd", "-C", "/tmp", "update", "x", "--claim"]);
		expect(parsed?.subcommand).toBe("update");
		expect(parsed?.positionals).toEqual(["x"]);
	});

	test("treats every positional after the subcommand as a bead id", () => {
		// `bd update` accepts [id...] and claims each one.
		const parsed = parseBdInvocation(["bd", "update", "x", "y", "z", "--claim"]);
		expect(parsed?.positionals).toEqual(["x", "y", "z"]);
	});

	test("reports absent --claim rather than refusing to parse", () => {
		const parsed = parseBdInvocation(["bd", "show", "x", "--json"]);
		expect(parsed).not.toBeNull();
		expect(parsed?.hasClaim).toBe(false);
	});

	test("reads the inline --claim=<bool> spelling the way pflag does", () => {
		// bd accepts exactly ParseBool's truthy set; `--claim=false` is a legal no-op
		// and `--claim=yes` is rejected by bd before any write, so neither is a claim.
		for (const truthy of ["1", "t", "T", "TRUE", "true", "True"]) {
			expect(parseBdInvocation(["bd", "update", "x", `--claim=${truthy}`])?.hasClaim).toBe(true);
		}
		for (const falsy of ["0", "false", "False", "yes", ""]) {
			expect(parseBdInvocation(["bd", "update", "x", `--claim=${falsy}`])?.hasClaim).toBe(false);
		}
		// The inline spelling is a flag, not a bead id.
		expect(parseBdInvocation(["bd", "update", "x", "--claim=true"])?.positionals).toEqual(["x"]);
	});
});

describe("bdInvocations", () => {
	test("finds a bd claim hidden after another command", () => {
		const found = bdInvocations("git status && BD_ACTOR=w-1 bd update x --claim");
		expect(found).toHaveLength(1);
		expect(found[0]?.hasClaim).toBe(true);
		expect(found[0]?.assignments.get("BD_ACTOR")).toBe("w-1");
	});

	test("finds every invocation in a chain", () => {
		expect(bdInvocations("bd show a; bd ready --claim").map(i => i.subcommand)).toEqual(["show", "ready"]);
	});

	test("a bd token inside another command's quoted operand is not an invocation", () => {
		expect(bdInvocations("git commit -m 'bd create x'")).toEqual([]);
	});

	test("env assignment prefix still leaves bd in the command slot", () => {
		const found = bdInvocations("env BEADS_ACTOR=a bd create x");
		expect(found).toHaveLength(1);
		expect(found[0]?.subcommand).toBe("create");
		expect(found[0]?.assignments.get("BEADS_ACTOR")).toBe("a");
	});

	test("quoted operand bd does not count; a later command-slot bd does", () => {
		const found = bdInvocations("git commit -m 'bd create' && bd ready");
		expect(found).toHaveLength(1);
		expect(found[0]?.subcommand).toBe("ready");
	});

	test("a quoted operand that spans a newline is still not an invocation", () => {
		// Live repro: a commit -m whose body contains `bd create` after a newline
		// used to re-tokenise the second line as its own command.
		expect(bdInvocations('git commit -m "fix something\nbd create x || true"')).toEqual([]);
	});
});

describe("redirections", () => {
	const CLAIM = "bd update orc-1 --claim --json";

	test.each([
		["2>&1", ["2>&1"]],
		["2>/dev/null", ["2>/dev/null"]],
		["> orc-2.log", [">orc-2.log"]],
		[">> log 2>&1", [">>log", "2>&1"]],
		[">&2", [">&2"]],
		["&>out", ["&>out"]],
		["< in", ["<in"]],
		["<<< here", ["<<<here"]],
	])("%s rides on the invocation, never in its operands", (suffix, redirections) => {
		// Before the tokeniser owned redirections, `2>&1` split the claim into two
		// segments (G5 refused it as "not alone") and `2>/dev/null` was counted as a
		// second bead id (G7 refused a one-bead claim as two).
		const found = bdInvocations(`${CLAIM} ${suffix}`);
		expect(found).toHaveLength(1);
		expect(found[0]?.positionals).toEqual(["orc-1"]);
		expect(found[0]?.hasClaim).toBe(true);
		expect(found[0]?.rest).toEqual(["update", "orc-1", "--claim", "--json"]);
		expect(found[0]?.redirections).toEqual(redirections);
	});

	test("a pipeline after a redirection still ends the segment", () => {
		expect(bdInvocations(`${CLAIM} 2>&1 | tee log`).map(i => i.redirections)).toEqual([["2>&1"]]);
		expect(bdInvocations(`${CLAIM} |& tee log`).map(i => i.redirections)).toEqual([[]]);
	});

	test("a bare bd with only a redirection carries no subcommand", () => {
		// `bd 2>&1 | head` prints help; `2>&1` used to sit where the subcommand does.
		const found = bdInvocations("bd 2>&1 | head -20");
		expect(found).toHaveLength(1);
		expect(found[0]?.subcommand).toBe("");
		expect(found[0]?.redirections).toEqual(["2>&1"]);
	});

	test("a wrapper shell's redirection applies to the payload it runs", () => {
		// The observer parses this claim's stdout; a merge on the wrapper merges it too.
		expect(bdInvocations(`bash -c '${CLAIM}' 2>&1`).map(i => i.redirections)).toEqual([["2>&1"]]);
	});
});

describe("compound commands", () => {
	const CLAIM = "bd update orc-1 --claim";

	test("a reserved word at command position is not the program", () => {
		for (const command of [
			`for i in 1; do ${CLAIM}; done`,
			`if true; then ${CLAIM}; fi`,
			`while true; do ${CLAIM}; done`,
			`{ ${CLAIM}; }`,
			`! ${CLAIM}`,
		]) {
			const found = bdInvocations(command);
			expect(found, command).toHaveLength(1);
			expect(found[0]?.positionals, command).toEqual(["orc-1"]);
			expect(found[0]?.hasClaim, command).toBe(true);
		}
		expect(bdInvocations("if bd show orc-1; then echo y; fi").map(i => i.subcommand)).toEqual(["show"]);
	});

	test("an assignment after a reserved word is still the environment", () => {
		// The documented batch shape: the actor prefix follows `do`, and a parser that
		// read assignments before reserved words saw `BEADS_ACTOR=w` as the program.
		const found = bdInvocations("for id in orc-1 orc-2; do BEADS_ACTOR=w bd update $id --claim --json; done");
		expect(found).toHaveLength(1);
		expect(found[0]?.assignments.get("BEADS_ACTOR")).toBe("w");
		expect(found[0]?.positionals).toEqual(["$id"]);
	});

	test("a glued subshell hides nothing, whatever it glues to", () => {
		// `(bd` was one token that never basenamed as `bd`; the strip that fixed it ran on
		// the program slot only, so `(FOO=1 bd` and `(env FOO=1 bd` stayed invisible.
		for (const command of [`(${CLAIM})`, `((${CLAIM}))`, `(FOO=1 ${CLAIM})`, `(env FOO=1 ${CLAIM})`, `( ${CLAIM} )`]) {
			const found = bdInvocations(command);
			expect(found, command).toHaveLength(1);
			expect(found[0]?.subcommand, command).toBe("update");
			expect(found[0]?.hasClaim, command).toBe(true);
			// A stray `)` reaching the id list would be recorded as a bead id.
			expect(found[0]?.positionals, command).toEqual(["orc-1"]);
		}
		expect(bdInvocations(`(FOO=1 ${CLAIM})`)[0]?.assignments.get("FOO")).toBe("1");
	});

	test("a command substitution runs its body", () => {
		// The architect's documented DAG build: `EPIC=$(bd create ...)`.
		const create = bdInvocations('EPIC=$(bd create "orchestrate run-1" --type epic --json)');
		expect(create.map(i => i.subcommand)).toEqual(["create"]);
		expect(create[0]?.positionals).toEqual(["orchestrate run-1"]);
		expect(bdInvocations(`x=$(${CLAIM})`).map(i => i.hasClaim)).toEqual([true]);
		expect(bdInvocations(`echo \`${CLAIM}\``).map(i => i.hasClaim)).toEqual([true]);
	});
});

describe("transparent runners and wrapper shells", () => {
	const CLAIM = "bd update orc-1 --claim";

	test("a runner prefix does not hide a claim", () => {
		for (const command of [
			`timeout 5 ${CLAIM}`,
			`timeout -k 2 5 ${CLAIM}`,
			`timeout -s KILL 5 ${CLAIM}`,
			`timeout --signal=KILL 5 ${CLAIM}`,
			`nohup ${CLAIM} &`,
			`time ${CLAIM}`,
			`exec ${CLAIM}`,
			`exec -a foo ${CLAIM}`,
			`stdbuf -oL ${CLAIM}`,
			`stdbuf -o L ${CLAIM}`,
			`/usr/bin/env ${CLAIM}`,
			`/usr/bin/env FOO=1 ${CLAIM}`,
		]) {
			const found = bdInvocations(command);
			expect(found, command).toHaveLength(1);
			expect(found[0]?.hasClaim, command).toBe(true);
			expect(found[0]?.positionals, command).toEqual(["orc-1"]);
		}
		expect(bdInvocations(`/usr/bin/env FOO=1 ${CLAIM}`)[0]?.assignments.get("FOO")).toBe("1");
	});

	test("an env flag that takes an operand does not hand the operand over as the program", () => {
		// `env -u X bd ...` used to read `X` as the executable, so the claim behind it was
		// invisible to every gate at once. Both spellings of each flag, and getopt's glued
		// short form, consume their operand.
		for (const command of [
			`env -u FOO ${CLAIM}`,
			`env --unset FOO ${CLAIM}`,
			`env --unset=FOO ${CLAIM}`,
			`env -uFOO ${CLAIM}`,
			`env -C /tmp ${CLAIM}`,
			`env --chdir /tmp ${CLAIM}`,
			`env --chdir=/tmp ${CLAIM}`,
			`env -P /usr/bin ${CLAIM}`,
			`env -i -u FOO BAR=1 ${CLAIM}`,
			`env -0 ${CLAIM}`,
			`env -- ${CLAIM}`,
		]) {
			const found = bdInvocations(command);
			expect(found, command).toHaveLength(1);
			expect(found[0]?.hasClaim, command).toBe(true);
			expect(found[0]?.positionals, command).toEqual(["orc-1"]);
		}
		expect(bdInvocations(`env -u FOO --unset=BAR -uBAZ ${CLAIM}`)[0]?.unsets).toEqual(["FOO", "BAR", "BAZ"]);
		expect(bdInvocations(`env -i -u FOO BAR=1 ${CLAIM}`)[0]?.assignments.get("BAR")).toBe("1");
		expect(bdInvocations(`env -C /tmp ${CLAIM}`)[0]?.unsets).toEqual([]);
		// An operand flag with nothing after it names no program.
		expect(bdInvocations("env -u")).toEqual([]);
	});

	test("env -S splits its string into further env words", () => {
		// The shebang idiom: env itself word-splits the operand, so the program and its
		// assignments may sit inside it and the rest of the line continues after it.
		for (const command of [
			`env -S '${CLAIM}'`,
			`env -S'${CLAIM}'`,
			`env --split-string='${CLAIM}'`,
			"env -S 'FOO=1 bd' update orc-1 --claim",
			"env -u BAR -S 'bd update' orc-1 --claim",
		]) {
			const found = bdInvocations(command);
			expect(found, command).toHaveLength(1);
			expect(found[0]?.subcommand, command).toBe("update");
			expect(found[0]?.positionals, command).toEqual(["orc-1"]);
			expect(found[0]?.hasClaim, command).toBe(true);
		}
		expect(bdInvocations("env -S 'FOO=1 bd' update orc-1 --claim")[0]?.assignments.get("FOO")).toBe("1");
		expect(invokesCommand("env -S 'git worktree add ../x'", ["git", "worktree"])).toBe(true);
		// Handed a raw segment, the parser reads the string as an operand and finds no program.
		expect(parseBdInvocation(["env", "-S", CLAIM])).toBeNull();
	});

	test("xargs runs the command it is given", () => {
		// The batch shapes: ids arrive on stdin, so the claim names no bead on the line.
		const piped = bdInvocations("echo orc-1 | xargs bd update --claim");
		expect(piped.map(i => [i.subcommand, i.positionals, i.hasClaim])).toEqual([["update", [], true]]);
		expect(bdInvocations("bd list --json | jq -r '.[].id' | xargs -n1 bd close").map(i => i.subcommand)).toEqual(["list", "close"]);
		// `-I` takes an operand, so the placeholder is not read as the program.
		expect(bdInvocations("echo orc-1 | xargs -I {} bd update {} --claim")[0]?.positionals).toEqual(["{}"]);
	});

	test("a wrapper shell's payload is parsed, not treated as opaque text", () => {
		for (const command of [
			`sh -c "${CLAIM}"`,
			`bash -lc '${CLAIM}'`,
			`bash -ce '${CLAIM}'`,
			`bash -c -x '${CLAIM}'`,
			`bash -c -- '${CLAIM}'`,
			`bash -o pipefail -c '${CLAIM}'`,
			`zsh -c "${CLAIM}"`,
			`eval '${CLAIM}'`,
		]) {
			const found = bdInvocations(command);
			expect(found, command).toHaveLength(1);
			expect(found[0]?.subcommand, command).toBe("update");
			expect(found[0]?.hasClaim, command).toBe(true);
		}
	});

	test("a shell without -c runs a script file, not a command line", () => {
		// `bash -c -- '...'` used to recurse on `--` itself and lose the wrapper segment.
		expect(bdInvocations(`sh '${CLAIM}'`)).toEqual([]);
		expect(bdInvocations(`bash -- '${CLAIM}'`)).toEqual([]);
	});

	test("a quoted value carrying brackets arrives intact", () => {
		// Only unquoted parentheses are syntax: `--metadata '{"role":"x"}'` must reach the
		// route check as parseable JSON, and a comment body keeps its parenthetical.
		const json = bdInvocations(`(bd -C /r create x --type bug --metadata '{"role":"impl"}')`);
		expect(json[0]?.rest.at(-1)).toBe('{"role":"impl"}');
		const prose = bdInvocations(`bd -C /r comment orc-1 "REPORTED done (see x)"`);
		expect(prose[0]?.rest.at(-1)).toBe("REPORTED done (see x)");
	});

	test("the worktree denials survive the same wrapping", () => {
		for (const command of [
			"sh -c 'git worktree add /tmp/x'",
			"timeout 5 git worktree add /tmp/x",
			"nohup git worktree add /tmp/x &",
			"eval \"git worktree add /tmp/x\"",
			"( git worktree add /tmp/x )",
			"(git worktree add /tmp/x)",
			"(git worktree add /tmp/x) &",
			"for b in a; do git worktree add ../$b; done",
			"if true; then git worktree add x; fi",
			"echo ../x | xargs git worktree add",
			"/usr/bin/env git worktree add ../x",
			"env -u FOO git worktree add ../x",
			"env -C /tmp git worktree add ../x",
			"env --chdir=/tmp -i git worktree add ../x",
		]) {
			expect(invokesCommand(command, ["git", "worktree"]), command).toBe(true);
		}
		expect(invokesCommand("sh -c 'gh pr checkout 42'", ["gh", "pr", "checkout"])).toBe(true);
		expect(invokesCommand("(gh pr checkout 12)", ["gh", "pr", "checkout"])).toBe(true);
	});

	test("wrapping still does not invent a command from quoted prose", () => {
		// The payload is only re-parsed when the segment actually runs a shell.
		expect(invokesCommand(`bd comment x "run sh -c 'git worktree add y'"`, ["git", "worktree"])).toBe(false);
		expect(bdInvocations(`git commit -m "bd update orc-1 --claim"`)).toEqual([]);
	});

	test("a program spelled in another case is the same program", () => {
		// The default filesystems here (APFS, NTFS) resolve PATH case-insensitively, so
		// `BD update` runs bd; a case-exact match let it walk past every bash gate. One
		// fold covers the program, `env`, the runners, the wrapper shells and `eval`.
		for (const command of [
			`BD update orc-1 --claim`,
			`/usr/local/bin/BD update orc-1 --claim`,
			`Bd update orc-1 --claim`,
			`ENV BEADS_ACTOR=x ${CLAIM}`,
			`/usr/bin/ENV -u FOO ${CLAIM}`,
			`NOHUP ${CLAIM} &`,
			`Timeout 5 ${CLAIM}`,
			`SH -c '${CLAIM}'`,
			`Bash -lc '${CLAIM}'`,
			`EVAL '${CLAIM}'`,
			`echo orc-1 | XARGS bd update --claim`,
		]) {
			const found = bdInvocations(command);
			expect(found, command).toHaveLength(1);
			expect(found[0]?.subcommand, command).toBe("update");
			expect(found[0]?.hasClaim, command).toBe(true);
		}
		expect(invokesCommand("GIT worktree add ../x", ["git", "worktree"])).toBe(true);
		expect(invokesCommand("NOHUP git worktree add ../x &", ["git", "worktree"])).toBe(true);
		expect(invokesCommand("GH pr checkout 12", ["gh", "pr", "checkout"])).toBe(true);
	});

	test("subcommands and flags keep their case; only the program folds", () => {
		// bd, git and gh are case-exact about their own grammar, so `BD Update` is not a
		// write and `git Worktree add` is not a worktree command.
		expect(bdInvocations("BD Update orc-1 --claim")[0]?.subcommand).toBe("Update");
		expect(bdInvocations("BD update orc-1 --CLAIM")[0]?.hasClaim).toBe(false);
		expect(invokesCommand("git Worktree add ../x", ["git", "worktree"])).toBe(false);
	});
});

describe("invokesCommand", () => {
	test("matches a two-word command", () => {
		expect(invokesCommand("git worktree add ../wt", ["git", "worktree"])).toBe(true);
		expect(invokesCommand("gh pr checkout 12", ["gh", "pr", "checkout"])).toBe(true);
	});

	test("matches despite an intervening global flag", () => {
		expect(invokesCommand("git -C /repo worktree list", ["git", "worktree"])).toBe(true);
	});

	test("matches after an env prefix", () => {
		expect(invokesCommand("FOO=1 git worktree prune", ["git", "worktree"])).toBe(true);
	});

	test("does not match a different subcommand", () => {
		expect(invokesCommand("git status", ["git", "worktree"])).toBe(false);
		expect(invokesCommand("gh pr view 12", ["gh", "pr", "checkout"])).toBe(false);
	});

	test("does not match the words inside a quoted payload", () => {
		expect(invokesCommand(`bd comment x "do not run git worktree add"`, ["git", "worktree"])).toBe(false);
	});
});

describe("editsVariable", () => {
	const NAME = "BD_READONLY";

	/** Whether any segment the shell would run edits the variable, as the readonly gate asks. */
	const edits = (command: string): boolean => effectiveSegments(command).some(segment => editsVariable(segment, NAME));

	test.each([
		["an inline assignment", "BD_READONLY=0 bd update x"],
		["an empty inline assignment", "BD_READONLY= bd update x"],
		["a bare shell assignment", "BD_READONLY=0; bd update x"],
		["an env assignment", "env BD_READONLY=0 bd update x"],
		["env -u", "env -u BD_READONLY bd update x"],
		["env --unset=", "env --unset=BD_READONLY bd update x"],
		["env -S carrying the assignment", "env -S 'BD_READONLY=0 bd update x'"],
		["unset", "unset BD_READONLY; bd update x"],
		["unset -v", "unset -v BD_READONLY"],
		["export", "export BD_READONLY=0"],
		["declare -x", "declare -x BD_READONLY=0"],
		["a wrapper shell", "sh -c 'BD_READONLY=0 bd update x'"],
		["a reserved word in front", "if true; then unset BD_READONLY; fi"],
	])("sees %s", (_label, command) => {
		expect(edits(command)).toBe(true);
	});

	test.each([
		["a read of the variable", "printenv BD_READONLY"],
		["an expansion", "echo $BD_READONLY"],
		["a bare export of the current value", "export BD_READONLY"],
		["the name inside an operand", "grep BD_READONLY= notes.md"],
		["another variable", "BEADS_ACTOR=a bd update x"],
		["a plain bd call", "bd show x"],
	])("leaves %s alone", (_label, command) => {
		expect(edits(command)).toBe(false);
	});
});
