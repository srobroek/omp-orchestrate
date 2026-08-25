import { describe, expect, test } from "bun:test";
import { bdInvocations, invokesCommand, parseBdInvocation, splitSegments } from "../src/shell";

describe("splitSegments", () => {
	test("splits on every shell operator", () => {
		expect(splitSegments("a && b")).toEqual([["a"], ["b"]]);
		expect(splitSegments("a; b")).toEqual([["a"], ["b"]]);
		expect(splitSegments("a | b")).toEqual([["a"], ["b"]]);
		expect(splitSegments("a || b; c")).toEqual([["a"], ["b"], ["c"]]);
	});

	test("collapses line continuations before tokenising", () => {
		expect(splitSegments("bd update x \\\n  --claim")).toEqual([["bd", "update", "x", "--claim"]]);
	});

	test("does not treat quoted operators as syntax", () => {
		// The whole point of tokenising: a payload containing `&&` or `;` must not
		// split the segment, or a gate could be evaded by quoting.
		expect(splitSegments(`bd comment x "a && b; c"`)).toEqual([["bd", "comment", "x", "a && b; c"]]);
	});

	test("does not treat # as a comment", () => {
		// Python's shlex ran with commenters = "", because a bead id or label may
		// legitimately contain a hash.
		expect(splitSegments("bd show orc#1")).toEqual([["bd", "show", "orc#1"]]);
	});

	test("discards a partial token from an unterminated quote", () => {
		expect(splitSegments(`bd comment x "unterminated`)).toEqual([["bd", "comment", "x"]]);
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

/**
 * Shapes a live fuzz pass found the parser blind to. Two of them -- `timeout` and
 * `nohup` -- are ordinary command-line usage rather than evasion, which is why a
 * gate that misses them fails on the honest path it exists to cover.
 */
describe("transparent runners and wrapper shells", () => {
	const CLAIM = "bd update orc-1 --claim";

	test("a runner prefix does not hide a claim", () => {
		for (const command of [
			`timeout 5 ${CLAIM}`,
			`timeout -k 2 5 ${CLAIM}`,
			`nohup ${CLAIM} &`,
			`time ${CLAIM}`,
			`exec ${CLAIM}`,
			`stdbuf -oL ${CLAIM}`,
		]) {
			const found = bdInvocations(command);
			expect(found).toHaveLength(1);
			expect(found[0]?.hasClaim).toBe(true);
			expect(found[0]?.positionals).toEqual(["orc-1"]);
		}
	});

	test("a wrapper shell's payload is parsed, not treated as opaque text", () => {
		for (const command of [`sh -c "${CLAIM}"`, `bash -lc '${CLAIM}'`, `zsh -c "${CLAIM}"`, `eval '${CLAIM}'`]) {
			const found = bdInvocations(command);
			expect(found).toHaveLength(1);
			expect(found[0]?.subcommand).toBe("update");
			expect(found[0]?.hasClaim).toBe(true);
		}
	});

	test("a subshell group yields the claim without its punctuation", () => {
		const found = bdInvocations(`( ${CLAIM} )`);
		expect(found).toHaveLength(1);
		// A stray `)` reaching the id list would be recorded as a bead id.
		expect(found[0]?.positionals).toEqual(["orc-1"]);
	});

	test("a glued subshell close does not hide the claim flag", () => {
		// `(bd ... --claim)` tokenises with the paren fused to BOTH ends: `(bd` never
		// basenamed as `bd`, and the tail read `--claim)`, so `hasClaim` was false and
		// `gateClaimEligibility` filtered the call out -- skipping the cross-role refusal
		// and the scope check on a claim that was really being made. The pin gate could not
		// see it either, because such a call is normally pinned.
		for (const command of [`(${CLAIM})`, `((${CLAIM}))`, `{${CLAIM};}`]) {
			const found = bdInvocations(command);
			expect(found).toHaveLength(1);
			expect(found[0]?.subcommand).toBe("update");
			expect(found[0]?.hasClaim).toBe(true);
			expect(found[0]?.positionals).toEqual(["orc-1"]);
		}
	});

	test("a balanced bracket inside a value survives stripping", () => {
		// The strip counts balance rather than trimming, or `--metadata '{"role":"x"}'` would
		// arrive as unparseable JSON and a readable route would read as unroutable. Single
		// quotes are the form that reaches the gate with its JSON intact.
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
		]) {
			expect(invokesCommand(command, ["git", "worktree"])).toBe(true);
		}
		expect(invokesCommand("sh -c 'gh pr checkout 42'", ["gh", "pr", "checkout"])).toBe(true);
	});

	test("wrapping still does not invent a command from quoted prose", () => {
		// The payload is only re-parsed when the segment actually runs a shell.
		expect(invokesCommand(`bd comment x "run sh -c 'git worktree add y'"`, ["git", "worktree"])).toBe(false);
		expect(bdInvocations(`git commit -m "bd update orc-1 --claim"`)).toEqual([]);
	});

	test("nesting is bounded rather than unbounded", () => {
		// Five levels exceeds the cap, so the innermost claim is not reported. The
		// point is termination, not depth: a parser that recursed forever on a
		// self-nesting payload would hang the gate it serves.
		const deep = `sh -c "sh -c \\"sh -c 'sh -c \\\\\\"sh -c ${CLAIM}\\\\\\"'\\""`;
		expect(() => bdInvocations(deep)).not.toThrow();
	});
});
