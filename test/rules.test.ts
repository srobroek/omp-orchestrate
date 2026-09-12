/**
 * TTSR rule conditions, compiled the way the host compiles them.
 *
 * The host runs every condition against the whole streamed argument buffer after each
 * delta, with no cap on the buffer (`export/ttsr.ts`). A condition whose cost grows
 * faster than the buffer therefore stalls the host's event loop for the length of one
 * tool stream. The shapes below are the ones that did: one line repeating `bd ready`, so
 * every occurrence started a scan to the end of the line, and an `args` array that never
 * closed, so every `"args"` started a scan to the end of the buffer. The rows are timed,
 * not matched: what a rule fires on is `scripts/validate-rules.sh`'s business, through
 * `omp ttsr test`.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

const RULES_DIR = path.join(import.meta.dir, "..", "rules");

interface Condition {
	rule: string;
	pattern: RegExp;
}

/** Every condition of every rule, as `new RegExp` compiles it; none carries inline flags. */
async function conditions(): Promise<Condition[]> {
	const found: Condition[] = [];
	for (const file of (await fs.readdir(RULES_DIR)).filter(name => name.endsWith(".md")).sort()) {
		const text = await fs.readFile(path.join(RULES_DIR, file), "utf8");
		const frontmatter = text.slice(4, text.indexOf("\n---", 4));
		const parsed = Bun.YAML.parse(frontmatter) as { condition: string | string[] };
		const patterns = Array.isArray(parsed.condition) ? parsed.condition : [parsed.condition];
		patterns.forEach((pattern, index) => found.push({ rule: `${file}[${index}]`, pattern: new RegExp(pattern) }));
	}
	return found;
}

/** One `.test()` over `input`, in milliseconds. */
function timed(pattern: RegExp, input: string): { hit: boolean; ms: number } {
	const start = performance.now();
	const hit = pattern.test(input);
	return { hit, ms: performance.now() - start };
}

const SIZE = 100_000;
/** A streamed bash argument whose command is one long benign line. */
const BENIGN = `{"command":"${"a".repeat(SIZE)}`;
/** A streamed bash argument whose one line repeats `bd ready` to the buffer's end. */
const READY_LINE = `{"command":"${"bd ready ".repeat(SIZE / 9)}`;
/** A streamed hub argument whose `args` array never closes. */
const OPEN_ARGS = `{"op":"start","application":"sh",${'"args": ["x", '.repeat(SIZE / 14)}`;

describe("rule conditions stay linear on a 100k buffer", async () => {
	const all = await conditions();

	test("every rule is loaded", () => {
		expect(all.map(({ rule }) => rule)).toEqual([
			"orc-no-nested-omp.md[0]",
			"orc-no-nested-omp.md[1]",
			"orc-ready-ephemeral.md[0]",
			"orc-shepherd-no-parent.md[0]",
		]);
	});

	test.each(all.map(condition => [condition.rule, condition] as const))("%s: a benign line costs under 50 ms", (_rule, { pattern }) => {
		expect(timed(pattern, BENIGN).ms).toBeLessThan(50);
	});

	test.each(all.map(condition => [condition.rule, condition] as const))("%s: a hostile buffer costs under 250 ms", (_rule, { pattern }) => {
		// Unbounded, the two `bd ready` rules cost ~480 ms here and the nested-omp array
		// scan ~1500 ms; bounded, all three stay under 25 ms. The margin is for a slow CI
		// runner, and the bound still fails on the quadratic shape everywhere.
		expect(timed(pattern, READY_LINE).ms).toBeLessThan(250);
		expect(timed(pattern, OPEN_ARGS).ms).toBeLessThan(250);
	});

	test("a trigger after the noise is still seen", () => {
		// Not only slow: past ~50k of the hostile prefix the unbounded spans hit the
		// engine's match limit and `test` returned false, so a real `bd ready` later in
		// the same stream went unflagged. Bounded, the same probe hits at 1 M.
		const ready = all.find(({ rule }) => rule === "orc-ready-ephemeral.md[0]")?.pattern as RegExp;
		const args = all.find(({ rule }) => rule === "orc-no-nested-omp.md[1]")?.pattern as RegExp;
		expect(timed(ready, `${READY_LINE}\\nbd ready --label agent:reviewer --claim --json"}`).hit).toBe(true);
		expect(timed(args, `${OPEN_ARGS}], "args": ["-c", "omp -p hi"]}`).hit).toBe(true);
	});
});
