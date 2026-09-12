/**
 * G7: the primary branch is the lead's.
 *
 * A worker's checkout here is a real linked worktree on `omp/task/t1`, because the
 * destination of a bare `git push` or a `HEAD` refspec is whatever branch the checkout is
 * on, and the gate reads that with git rather than guessing. The primary checkout carries
 * the marker; the linked worktree reaches it through `git rev-parse --git-common-dir`, as
 * an architect's Worktrunk worktree does. The run epic is a `bdShow` fake.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, type Mock, spyOn, test } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import * as bd from "../src/bd";
import { gatePush } from "../src/gates/push";
import { markerPath } from "../src/run-state";

const execFileAsync = promisify(execFile);

const RUN = "orc-push";
const LEAD = "lead-session";
const WORKER = "worker-session";

/** The primary checkout, on `main`, carrying the marker. */
let primary: string;
/** A linked worktree on `omp/task/t1`: a worker's seat. */
let task: string;
/** A repository no run has marked. */
let unmarked: string;
let show: Mock<typeof bd.bdShow>;
/** What `bdShow` answers for the run epic; `null` models an unreadable epic. */
let epic: bd.BdBead | null;

async function git(cwd: string, ...args: string[]): Promise<void> {
	await execFileAsync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args]);
}

/** A gate's context: the seat, the declared role, and the session. */
function seat(cwd: string, options: { role?: string; session?: string } = {}): ExtensionContext {
	const prompt = options.role === undefined ? [] : [`ORC-ROLE: ${options.role}`];
	return { cwd, getSystemPrompt: () => prompt, sessionManager: { getSessionId: () => options.session ?? WORKER } } as unknown as ExtensionContext;
}

beforeAll(async () => {
	const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "orc-push-")));
	primary = path.join(base, "primary");
	task = path.join(base, "task");
	unmarked = path.join(base, "unmarked");
	await fs.mkdir(primary);
	await git(primary, "init", "-q", "-b", "main");
	await git(primary, "commit", "-q", "--allow-empty", "-m", "init");
	await git(primary, "worktree", "add", "-q", "-b", "omp/task/t1", task);
	await fs.mkdir(path.join(primary, ".orchestration"));
	await fs.writeFile(markerPath(primary), JSON.stringify({ schema_version: 1, run_id: RUN, session_id: LEAD }));
	await fs.mkdir(unmarked);
	await git(unmarked, "init", "-q", "-b", "main");
	await git(unmarked, "commit", "-q", "--allow-empty", "-m", "init");
});

afterAll(async () => {
	await fs.rm(path.dirname(primary), { recursive: true, force: true });
});

beforeEach(() => {
	epic = { id: RUN, status: "in_progress", labels: [], metadata: {} };
	show = spyOn(bd, "bdShow").mockImplementation(async id => (id === RUN ? epic : null));
});

afterEach(() => {
	show.mockRestore();
});

describe("G7 refuses a worker's push to the primary branch", () => {
	test.each([
		["HEAD to main", "git push origin HEAD:main"],
		["main by name", "git push origin main"],
		["a qualified destination", "git push origin omp/task/t1:refs/heads/main"],
		["with the upstream flag", "git push -u origin HEAD:main"],
		["a delete by flag", "git push --delete origin main"],
		["a delete by refspec", "git push origin :main"],
		["every branch", "git push --all origin"],
		["a mirror", "git push origin --mirror"],
		["after an env prefix", "GIT_TRACE=1 git push origin HEAD:main"],
		["inside a wrapper shell", "sh -c 'git push origin HEAD:main'"],
		["after a commit in the same line", "git commit -am wip && git push origin HEAD:main"],
		["past a push option", "git push -o ci.skip origin HEAD:main"],
		["a dry run, which the router the campaign hit let through", "git push --dry-run origin HEAD:main"],
	])("refuses %s", async (_label, command) => {
		const result = await gatePush(seat(task, { role: "implementer" }), { command });

		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("main");
	});

	test("a bare push from a checkout on the primary branch is refused, and from a task branch passes", async () => {
		expect((await gatePush(seat(primary, { role: "implementer" }), { command: "git push" }))?.block).toBe(true);
		expect(await gatePush(seat(task, { role: "implementer" }), { command: "git push" })).toBeUndefined();
	});

	test("a -C is followed: the branch is read at the checkout it names", async () => {
		expect((await gatePush(seat(task, { role: "implementer" }), { command: `git -C ${primary} push origin HEAD` }))?.block).toBe(true);
		expect((await gatePush(seat(task, { role: "implementer" }), { command: `git -C ${primary} push` }))?.reason).toContain("main");
		expect(await gatePush(seat(primary, { role: "implementer" }), { command: `git -C ${task} push origin HEAD` })).toBeUndefined();
		expect(await gatePush(seat(primary, { role: "implementer" }), { command: `git -C ${task} push` })).toBeUndefined();
	});

	test("a generic helper is refused like a role", async () => {
		const result = await gatePush(seat(task), { command: "git push origin HEAD:main" });

		expect(result?.block).toBe(true);
	});
});

describe("G7 refuses a HEAD-dependent push once the line has moved the shell", () => {
	/** The bypass the campaign's fix wave found: HEAD read at the copy, pushed from the primary. */
	test.each([
		["a bare push after cd", "cd /x && git push"],
		["HEAD after cd", "cd /x && git push origin HEAD"],
		["a source with its destination left off", "cd /x && git push origin omp/task/t1:"],
		["a cd in an earlier segment", "cd /x; git status; git push -u origin HEAD"],
		["pushd", "pushd /x && git push origin HEAD"],
		["--git-dir", "git --git-dir=/x/.git push"],
		["--work-tree with a separate operand", "git --work-tree /x push origin HEAD"],
	])("refuses %s", async (_label, command) => {
		const result = await gatePush(seat(task, { role: "implementer" }), { command });

		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("destination cannot be resolved after a directory change");
		expect(show).not.toHaveBeenCalled();
	});

	test.each([
		["an explicit destination after cd", "cd /x && git push origin feat:feat"],
		["an explicit destination that is not the primary", `cd ${primary} && git push origin HEAD:omp/task/t1`],
		["tags only after cd", "cd /x && git push origin --tags"],
		["a cd with no push", "cd /x && git status"],
	])("allows %s", async (_label, command) => {
		expect(await gatePush(seat(task, { role: "implementer" }), { command })).toBeUndefined();
	});

	test("an explicit destination after cd is still judged: the primary is refused", async () => {
		expect((await gatePush(seat(task, { role: "implementer" }), { command: "cd /x && git push origin HEAD:main" }))?.reason).toContain("main");
	});

	test("the lead, and a checkout no run has marked, are not held to it", async () => {
		expect(await gatePush(seat(primary, { session: LEAD }), { command: `cd ${primary} && git push` })).toBeUndefined();
		expect(await gatePush(seat(unmarked, { role: "implementer" }), { command: "cd /x && git push" })).toBeUndefined();
	});
});

describe("G7 refuses a history rewrite from any worker seat", () => {
	test.each([
		["--force", "git push --force origin HEAD"],
		["-f", "git push -f origin omp/task/t1"],
		["-f in a cluster", "git push -fu origin omp/task/t1"],
		["--force-with-lease", "git push --force-with-lease origin omp/task/t1"],
		["--force-with-lease with an expectation", "git push --force-with-lease=omp/task/t1:abc origin omp/task/t1"],
		["a + refspec", "git push origin +omp/task/t1"],
		["a + refspec with a source", "git push origin +HEAD:omp/task/t1"],
	])("refuses %s even to the task branch", async (_label, command) => {
		const result = await gatePush(seat(task, { role: "implementer" }), { command });

		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("force push");
		expect(show).not.toHaveBeenCalled();
	});

	test("--no-force after --force is git's last-wins, and the push is judged by its destination", async () => {
		expect(await gatePush(seat(task, { role: "implementer" }), { command: "git push --force --no-force origin HEAD:omp/task/t1" })).toBeUndefined();
	});
});

describe("G7 leaves a worker's own branches and every read alone", () => {
	test.each([
		["the task branch with upstream", "git push -u origin omp/task/t1"],
		["HEAD to the task branch", "git push origin HEAD:omp/task/t1"],
		["HEAD from a task checkout", "git push origin HEAD"],
		["a branch the session made", "git switch -c fix/thing && git push -u origin fix/thing"],
		["another feature branch by name", "git push origin HEAD:feature/other"],
		["tags only", "git push origin --tags"],
		["a tag destination", "git push origin HEAD:refs/tags/v1"],
		["a read whose operand is the word", "git log --grep push"],
		["a quoted mention", 'bd comment orc-1 "do not git push origin main"'],
		["an echo", 'echo "git push origin HEAD:main"'],
		["a fetch", "git fetch origin main"],
	])("allows %s", async (_label, command) => {
		expect(await gatePush(seat(task, { role: "implementer" }), { command })).toBeUndefined();
	});

	test("a command that pushes nothing reads neither the marker nor the epic", async () => {
		await gatePush(seat(task, { role: "implementer" }), { command: "echo ok" });

		expect(show).not.toHaveBeenCalled();
	});
});

describe("G7 exempts the lead and sleeps outside a run", () => {
	test.each([
		["a push to main", "git push origin HEAD:main"],
		["a force push", "git push --force origin main"],
		["a Worktrunk checkout", "wt switch --create fix/x --base origin/main --no-cd"],
	])("the lead's %s passes", async (_label, command) => {
		expect(await gatePush(seat(primary, { session: LEAD }), { command })).toBeUndefined();
	});

	test.each([
		["a force push to main", "git push --force origin HEAD:main"],
		["a Worktrunk checkout", "wt switch --create fix/x"],
	])("%s in a checkout no run has marked is not this gate's business", async (_label, command) => {
		expect(await gatePush(seat(unmarked), { command })).toBeUndefined();
		expect(await gatePush(seat(unmarked, { role: "implementer" }), { command })).toBeUndefined();
	});
});

describe("G7 reads the primary branch from the run epic", () => {
	test("a run whose primary is develop refuses develop and lets main through", async () => {
		epic = { id: RUN, status: "in_progress", labels: [], metadata: { primary_branch: "develop" } };

		const refused = await gatePush(seat(task, { role: "implementer" }), { command: "git push origin HEAD:develop" });
		const allowed = await gatePush(seat(task, { role: "implementer" }), { command: "git push origin HEAD:main" });

		expect(refused?.block).toBe(true);
		expect(refused?.reason).toContain("develop");
		expect(allowed).toBeUndefined();
	});

	test("an unreadable epic means main", async () => {
		epic = null;

		expect((await gatePush(seat(task, { role: "implementer" }), { command: "git push origin HEAD:main" }))?.block).toBe(true);
	});
});

describe("G7 refuses a generic helper's Worktrunk checkout", () => {
	test.each([
		["--create", "wt switch --create fix/x --base origin/main --no-cd --no-hooks --format json"],
		["-c", "wt switch -c fix/x"],
		["-c in a cluster", "wt switch -yc fix/x"],
		["--create after a global -C", `wt -C ${primary} switch --create fix/x`],
		["--create past a base with an operand", "wt switch -b origin/main --create fix/x"],
	])("refuses %s", async (_label, command) => {
		const result = await gatePush(seat(task), { command });

		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("generic helper");
		expect(show).not.toHaveBeenCalled();
	});

	test.each([
		["a switch to an existing worktree", "wt switch fix/x"],
		["-c after --, which belongs to --execute", "wt switch fix/x -x sh -- -c 'bun test'"],
		["a base spelled with -c inside its operand", "wt switch --base=-c fix/x"],
		["a list", "wt list --format json"],
	])("allows %s", async (_label, command) => {
		expect(await gatePush(seat(task), { command })).toBeUndefined();
	});

	test.each(["implementer", "architect"])("a %s may create its worktree", async role => {
		expect(await gatePush(seat(task, { role }), { command: "wt switch --create fix/x --base origin/main --no-cd" })).toBeUndefined();
	});
});
