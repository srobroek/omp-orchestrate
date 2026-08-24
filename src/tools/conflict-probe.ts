/**
 * `orc_conflict_probe` — deterministic merge-conflict and CI probe for the Shepherd.
 *
 * A native port of `orchestrate/scripts/conflict-probe.sh`. It predicts whether a
 * branch merges into a base WITHOUT mutating any tree (`git merge-tree`), whether
 * two branches touch overlapping files, and what CI says about a PR.
 *
 * Every answer is a tool result, never an exception: a missing `git`/`gh`, a bad
 * ref, or a merge-tree the caller's git cannot classify all return text plus
 * structured `details`, so a probe failure degrades to "unknown" instead of
 * bricking the tool call that asked.
 */

import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

/** Which question the probe answers. */
export type ProbeMode = "conflicts" | "pairwise" | "ci";

/** Structured result payload. `error` is set only when the probe could not answer. */
export interface ConflictProbeDetails {
	mode: ProbeMode;
	/** Merge/overlap verdict. Absent for `ci`, and whenever `error` is set. */
	clean?: boolean;
	/** Conflicting paths (`conflicts`). */
	paths?: string[];
	/** Paths both branches touch (`pairwise`). */
	overlap?: string[];
	/** `gh pr checks` exit status (`ci`), which the caller interprets as gh does. */
	exitCode?: number;
	error?: string;
}

/** A finished subprocess. `null` from {@link run} means it never ran at all. */
interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

const TIMEOUT_MS = 30_000;

/**
 * A git object id as `merge-tree` prints it. Width is not pinned to 40: a
 * SHA-256 repository emits 64 hex characters.
 */
const OID = /^[0-9a-f]{40,64}$/i;

/** `git rev-parse` for a ref, pinned to a commit so a tag or tree cannot slip through. */
export function revParseArgv(ref: string): string[] {
	return ["git", "rev-parse", "--verify", `${ref}^{commit}`];
}

/** Predict a merge without writing anything into the working tree. */
export function mergeTreeArgv(base: string, branch: string): string[] {
	return ["git", "merge-tree", "--write-tree", "--name-only", base, branch];
}

export function mergeBaseArgv(base: string, branch: string): string[] {
	return ["git", "merge-base", base, branch];
}

/** Paths a branch changed since its merge base. */
export function diffNamesArgv(from: string, to: string): string[] {
	return ["git", "diff", "--name-only", from, to];
}

export function ghChecksArgv(pr: string): string[] {
	return ["gh", "pr", "checks", pr];
}

/**
 * Parse `git merge-tree --write-tree --name-only` output.
 *
 * Line 1 is the resulting tree oid; on conflict the conflicting paths follow,
 * terminated by a blank line before git's informational messages. Output whose
 * first line is not an oid is not classifiable, and reports neither clean nor any
 * paths — the caller must treat that as unknown rather than as a clean merge.
 */
export function parseMergeTreeOutput(stdout: string): { clean: boolean; paths: string[] } {
	const lines = stdout.split("\n");
	const head = (lines[0] ?? "").trim();
	if (!OID.test(head)) return { clean: false, paths: [] };

	const seen = new Set<string>();
	for (const raw of lines.slice(1)) {
		const line = raw.trim();
		if (line === "") break;
		seen.add(line);
	}
	const paths = [...seen].sort();
	return { clean: paths.length === 0, paths };
}

/** Sorted, de-duplicated intersection of two path lists (the script's `comm -12`). */
export function intersectPaths(a: string[], b: string[]): string[] {
	const right = new Set(b);
	const both = new Set<string>();
	for (const path of a) {
		if (right.has(path)) both.add(path);
	}
	return [...both].sort();
}

/** Non-empty, trimmed lines of a git listing. */
function lines(stdout: string): string[] {
	const out: string[] = [];
	for (const raw of stdout.split("\n")) {
		const line = raw.trim();
		if (line !== "") out.push(line);
	}
	return out;
}

/** Run one argv and capture it, or `null` when the binary is missing or spawn failed. */
async function run(argv: string[], cwd: string): Promise<RunResult | null> {
	const [bin, ...args] = argv;
	if (bin === undefined) return null;
	try {
		const proc = Bun.spawn([bin, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
		const timer = setTimeout(() => proc.kill(), TIMEOUT_MS);
		try {
			const [stdout, stderr, code] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			return { code, stdout, stderr };
		} finally {
			clearTimeout(timer);
		}
	} catch {
		return null;
	}
}

function ok(text: string, details: ConflictProbeDetails): AgentToolResult<ConflictProbeDetails> {
	return { content: [{ type: "text", text }], details };
}

function fail(text: string, details: ConflictProbeDetails): AgentToolResult<ConflictProbeDetails> {
	return { content: [{ type: "text", text: `conflict-probe: ${text}` }], details, isError: true };
}

/** The binary named by an argv could not be executed at all. */
function missing(argv: string[], mode: ProbeMode): AgentToolResult<ConflictProbeDetails> {
	const bin = argv[0] ?? "git";
	return fail(`${bin} not found (or failed to run)`, { mode, error: `${bin} not found` });
}

async function probeConflicts(base: string, branch: string, cwd: string): Promise<AgentToolResult<ConflictProbeDetails>> {
	const mode: ProbeMode = "conflicts";
	const baseArgv = revParseArgv(base);
	const baseRev = await run(baseArgv, cwd);
	if (!baseRev) return missing(baseArgv, mode);
	if (baseRev.code !== 0) return fail(`bad base ${base}`, { mode, error: "bad ref" });

	const branchArgv = revParseArgv(branch);
	const branchRev = await run(branchArgv, cwd);
	if (!branchRev) return missing(branchArgv, mode);
	if (branchRev.code !== 0) return fail(`bad branch ${branch}`, { mode, error: "bad ref" });

	const baseSha = baseRev.stdout.trim();
	const branchSha = branchRev.stdout.trim();
	const argv = mergeTreeArgv(baseSha, branchSha);
	const merge = await run(argv, cwd);
	if (!merge) return missing(argv, mode);

	// Exit 0 is the only clean answer. A non-zero exit with conflicting paths is a
	// real conflict; a non-zero exit without them is unknown and must never be
	// reported clean, since the Shepherd would merge on that answer.
	if (merge.code === 0) return ok("clean", { mode, clean: true, paths: [] });

	const { paths } = parseMergeTreeOutput(merge.stdout);
	if (paths.length === 0) {
		return fail(`merge-tree could not classify ${base} and ${branch}`, { mode, error: "unclassified" });
	}
	return ok(paths.join("\n"), { mode, clean: false, paths });
}

async function probePairwise(
	base: string,
	branch: string,
	branchB: string,
	cwd: string,
): Promise<AgentToolResult<ConflictProbeDetails>> {
	const mode: ProbeMode = "pairwise";
	const sides: string[] = [];
	for (const side of [branch, branchB]) {
		const mergeBaseArgs = mergeBaseArgv(base, side);
		const mergeBase = await run(mergeBaseArgs, cwd);
		if (!mergeBase) return missing(mergeBaseArgs, mode);
		if (mergeBase.code !== 0) return fail(`cannot find merge base for ${base} and ${side}`, { mode, error: "no merge base" });

		const diffArgs = diffNamesArgv(mergeBase.stdout.trim(), side);
		const diff = await run(diffArgs, cwd);
		if (!diff) return missing(diffArgs, mode);
		if (diff.code !== 0) return fail(`cannot diff ${side}`, { mode, error: "diff failed" });
		sides.push(diff.stdout);
	}

	const overlap = intersectPaths(lines(sides[0] ?? ""), lines(sides[1] ?? ""));
	if (overlap.length === 0) return ok("disjoint", { mode, clean: true, overlap: [] });
	return ok(`overlap:\n${overlap.join("\n")}`, { mode, clean: false, overlap });
}

async function probeCi(pr: string, cwd: string): Promise<AgentToolResult<ConflictProbeDetails>> {
	const mode: ProbeMode = "ci";
	const argv = ghChecksArgv(pr);
	const checks = await run(argv, cwd);
	if (!checks) return missing(argv, mode);

	// `gh pr checks` exits non-zero for pending or failing checks. That is an
	// answer, not a tool failure, so the exit code is passed through in `details`
	// and the result is not marked as an error.
	const text = checks.stdout.trim() !== "" ? checks.stdout : checks.stderr;
	return ok(text.trim() === "" ? `gh pr checks exited ${checks.code} with no output` : text, {
		mode,
		exitCode: checks.code,
	});
}

/** Register `orc_conflict_probe`. The caller wires this from the extension entry point. */
export function registerConflictProbe(pi: ExtensionAPI): void {
	const z = pi.zod;

	pi.registerTool({
		name: "orc_conflict_probe",
		label: "Conflict Probe",
		description:
			"Predict merge conflicts and read CI without touching any tree. " +
			"`conflicts`: does <branch> merge cleanly into <base>? " +
			"`pairwise`: do <branch> and <branchB> touch the same files since <base>? " +
			"`ci`: what does `gh pr checks <pr>` say?",
		approval: "read",
		parameters: z.object({
			mode: z
				.enum(["conflicts", "pairwise", "ci"])
				.describe("conflicts: base vs branch merge prediction; pairwise: file overlap of two branches; ci: gh pr checks"),
			base: z.string().optional().describe("Base ref for `conflicts` and `pairwise` (required for both)"),
			branch: z.string().optional().describe("Branch ref to probe (required for `conflicts` and `pairwise`)"),
			branchB: z.string().optional().describe("Second branch ref, `pairwise` only"),
			pr: z.string().optional().describe("PR number or branch, `ci` only"),
			cwd: z.string().optional().describe("Repository directory to probe in; defaults to the session cwd"),
		}),
		async execute(
			_id: string,
			params: { mode: ProbeMode; base?: string; branch?: string; branchB?: string; pr?: string; cwd?: string },
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		): Promise<AgentToolResult<ConflictProbeDetails>> {
			const cwd = params.cwd ?? ctx.cwd;
			try {
				switch (params.mode) {
					case "conflicts": {
						if (!params.base || !params.branch) {
							return fail("conflicts needs base and branch", { mode: "conflicts", error: "missing arguments" });
						}
						return await probeConflicts(params.base, params.branch, cwd);
					}
					case "pairwise": {
						if (!params.base || !params.branch || !params.branchB) {
							return fail("pairwise needs base, branch and branchB", { mode: "pairwise", error: "missing arguments" });
						}
						return await probePairwise(params.base, params.branch, params.branchB, cwd);
					}
					case "ci": {
						if (!params.pr) return fail("ci needs pr", { mode: "ci", error: "missing arguments" });
						return await probeCi(params.pr, cwd);
					}
				}
			} catch (err) {
				// Defence in depth: an unexpected throw here would surface as a tool
				// crash, which reads to the model as "the repo is broken".
				return fail(String(err), { mode: params.mode, error: "probe failed" });
			}
		},
	});
}
