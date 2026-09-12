import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetReadBudget } from "../src/bd";
import { adoptRun, markerPath, renewLeadLease } from "../src/run-state";

/**
 * A `bd` that honours the claim fence, at the `Bun.spawn` seam, so the lead-lease paths
 * are exercised against the semantics measured on bd 1.2.2: `update <id> --actor A --claim`
 * is refused with `issue already claimed by <holder>` while another actor holds the bead,
 * and otherwise applies `--assignee`, `--status` and `--set-metadata` in one step.
 */
interface Epic { id: string; status: string; assignee: string; metadata: Record<string, string>; updated_at: string }

function fakeBd(epic: Epic) {
	const argvs: string[][] = [];
	const answer = (stdout: string, code: number, stderr = "") => ({
		stdout: new Response(stdout).body,
		stderr: new Response(stderr).body,
		exited: Promise.resolve(code),
		kill: () => {},
	}) as unknown as Bun.Subprocess;

	const spawn = spyOn(Bun, "spawn").mockImplementation(((cmd: string[]) => {
		const args = cmd.slice(1);
		argvs.push(args);
		if (args[0] === "show") return answer(JSON.stringify([epic]), 0);
		if (args[0] !== "update" || args[1] !== epic.id) return answer("", 1, `unsupported: ${args.join(" ")}`);
		const actor = args[args.indexOf("--actor") + 1] ?? "";
		if (args.includes("--claim")) {
			if (epic.assignee !== "" && epic.assignee !== actor) {
				return answer("", 1, `Error claiming ${epic.id}: issue already claimed by ${epic.assignee}`);
			}
			epic.assignee = actor;
			epic.status = "in_progress";
		}
		for (let i = 0; i < args.length; i++) {
			if (args[i] === "--assignee") epic.assignee = args[i + 1] ?? "";
			if (args[i] === "--status") epic.status = args[i + 1] ?? epic.status;
			if (args[i] === "--set-metadata") {
				const [key, value] = (args[i + 1] ?? "").split("=", 2);
				if (key) epic.metadata[key] = value ?? "";
			}
		}
		epic.updated_at = new Date().toISOString();
		return answer("", 0);
	}) as unknown as typeof Bun.spawn);
	return { argvs, restore: () => spawn.mockRestore() };
}

let cwd: string;
afterEach(async () => {
	if (cwd) await rm(cwd, { recursive: true, force: true });
});

async function boundRepo(runId: string): Promise<string> {
	cwd = await mkdtemp(join(tmpdir(), "orc-lead-lease-"));
	await mkdir(join(cwd, ".orchestration"), { recursive: true });
	await writeFile(markerPath(cwd), JSON.stringify({ schema_version: 1, run_id: runId }));
	return cwd;
}

const LAPSED = "2020-01-01T00:00:00.000Z";

describe("the lead lease is fenced on the epic's assignee", () => {
	test("two adopters racing a lapsed lease produce exactly one lead", async () => {
		const repo = await boundRepo("orc-7");
		const epic: Epic = { id: "orc-7", status: "in_progress", assignee: "lead:old", metadata: { lease_until: LAPSED }, updated_at: LAPSED };
		const bd = fakeBd(epic);
		try {
			resetReadBudget();
			const outcomes = await Promise.all([adoptRun(repo, "new-1"), adoptRun(repo, "new-2")]);
			const adopted = outcomes.filter(outcome => outcome.kind === "adopted");
			expect(adopted).toHaveLength(1);
			expect(outcomes.filter(outcome => outcome.kind === "held-by-other")).toHaveLength(1);
			expect(epic.assignee).toBe(outcomes[0]?.kind === "adopted" ? "lead:new-1" : "lead:new-2");
			expect(Date.parse(epic.metadata.lease_until ?? "")).toBeGreaterThan(Date.now());
			// Both released as the old lead; only the winner's claim passed the fence.
			expect(bd.argvs.filter(argv => argv.includes("--assignee")).every(argv => argv[argv.indexOf("--actor") + 1] === "lead:old")).toBe(true);
		} finally {
			bd.restore();
		}
	});

	test("adoption is refused while the old lease is live, and renewal by the old lead still passes", async () => {
		const repo = await boundRepo("orc-7");
		const live = new Date(Date.now() + 600_000).toISOString();
		const epic: Epic = { id: "orc-7", status: "in_progress", assignee: "lead:old", metadata: { lease_until: live }, updated_at: new Date().toISOString() };
		const bd = fakeBd(epic);
		try {
			resetReadBudget();
			expect((await adoptRun(repo, "new-1")).kind).toBe("held-by-other");
			expect(epic.assignee).toBe("lead:old");
			expect((await renewLeadLease(repo, "old")).outcome).toBe("renewed");
			expect((await renewLeadLease(repo, "new-1")).outcome).toBe("held-by-other");
			expect(bd.argvs.filter(argv => argv[0] === "update").every(argv => argv.includes("--claim"))).toBe(true);
		} finally {
			bd.restore();
		}
	});

	test("the displaced old lead's next renewal is refused after adoption", async () => {
		const repo = await boundRepo("orc-7");
		const epic: Epic = { id: "orc-7", status: "in_progress", assignee: "lead:old", metadata: { lease_until: LAPSED }, updated_at: LAPSED };
		const bd = fakeBd(epic);
		try {
			resetReadBudget();
			expect((await adoptRun(repo, "new-1")).kind).toBe("adopted");
			expect((await renewLeadLease(repo, "old")).outcome).toBe("held-by-other");
			expect((await adoptRun(repo, "new-1")).kind).toBe("already-lead");
		} finally {
			bd.restore();
		}
	});
});
