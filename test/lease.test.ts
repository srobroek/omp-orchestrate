import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import * as bd from "../src/bd";
import type { BdResult } from "../src/bd";
import { createClaimState } from "../src/claim-state";
import {
	createLeaseRenewer,
	type LeadLeaseRenew,
	type LeadLeaseRenewal,
	leaseDeadline,
	leaseExpired,
	type ParkedRegistry,
	releaseDeadClaim,
	renewLease,
} from "../src/lease";
import { markerPath, renewLeadLease } from "../src/run-state";

let ran: string[][] = [];
let refuse: string | undefined;
let unavailable = false;
const runSpy = spyOn(bd, "bdRun").mockImplementation(async (args): Promise<BdResult | null> => {
	ran.push(args);
	if (unavailable) return null;
	return refuse === undefined ? { code: 0, stdout: "", stderr: "" } : { code: 1, stdout: "", stderr: refuse };
});
afterAll(() => runSpy.mockRestore());

beforeEach(() => {
	ran = [];
	refuse = undefined;
	unavailable = false;
});
afterEach(() => {
	delete process.env.ORC_LEASE_TTL_MS;
	delete process.env.ORC_LEASE_RENEW_MS;
});

const T0 = Date.parse("2026-09-12T09:00:00.000Z");
const MINUTE = 60_000;

/** Settle the fire-and-forget renewals the renewer started. */
const settle = () => setImmediate();

describe("renewLease", () => {
	test("is one fenced write with auto-commit off, extending to now + TTL", async () => {
		expect(await renewLease("orc-1", "impl-7", T0)).toBe("renewed");
		expect(ran).toEqual([[
			"update", "orc-1", "--actor", "impl-7", "--claim",
			"--set-metadata", "lease_until=2026-09-12T09:15:00.000Z",
			"--dolt-auto-commit", "off",
		]]);
	});

	test("reads the fence as displacement and everything else as failure", async () => {
		refuse = "Error claiming orc-1: issue already claimed by impl-9";
		expect(await renewLease("orc-1", "impl-7", T0)).toBe("held-by-other");
		refuse = "Error claiming orc-1: issue not claimable: status blocked";
		expect(await renewLease("orc-1", "impl-7", T0)).toBe("failed");
		unavailable = true;
		expect(await renewLease("orc-1", "impl-7", T0)).toBe("failed");
	});
});

describe("releaseDeadClaim", () => {
	const evidence = { cause: "child exited (aborted)", recoveredBy: "lead:s1", branch: "omp/task/impl-7", observations: ["captured branch observed: omp/task/impl-7"] };

	test("releases under the fence, then records RECOVERED as the recovering identity", async () => {
		expect(await releaseDeadClaim("orc-1", "impl-7", evidence)).toBe("released");
		expect(ran[0]).toEqual([
			"update", "orc-1", "--actor", "impl-7", "--claim", "--assignee", "", "--status", "open",
			"--set-metadata", "recovered_by=lead:s1", "--set-metadata", "recovered_branch=omp/task/impl-7",
			"--dolt-auto-commit", "off",
		]);
		expect(ran[1]).toEqual(["comment", "orc-1", "RECOVERED impl-7 child exited (aborted); captured branch observed: omp/task/impl-7", "--actor", "lead:s1"]);
	});

	test("a refused fence writes no comment and names the successor's win", async () => {
		refuse = "Error claiming orc-1: issue already claimed by impl-9";
		expect(await releaseDeadClaim("orc-1", "impl-7", evidence)).toBe("held-by-other");
		expect(ran).toHaveLength(1);
	});

	test("an unanswering store is failed, not refused", async () => {
		unavailable = true;
		expect(await releaseDeadClaim("orc-1", "impl-7", evidence)).toBe("failed");
	});

	describe("without a caller's observations, the release reads the holder's capture itself", () => {
		let repo: string;
		const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
		beforeEach(async () => {
			repo = await mkdtemp(join(tmpdir(), "orc-lease-capture-"));
			git("init", "-q", "-b", "trunk");
			git("-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "base");
		});
		afterEach(() => rm(repo, { recursive: true, force: true }));

		test("a captured branch is stamped and observed with its tip's date, as the reaper's release is", async () => {
			git("branch", "omp/task/impl-7");
			expect(await releaseDeadClaim("orc-1", "impl-7", { cause: "lease lapsed", recoveredBy: "lead:s2" }, repo)).toBe("released");
			expect(ran[0]).toEqual([
				"update", "orc-1", "--actor", "impl-7", "--claim", "--assignee", "", "--status", "open",
				"--set-metadata", "recovered_by=lead:s2", "--set-metadata", "recovered_branch=omp/task/impl-7",
				"--dolt-auto-commit", "off",
			]);
			expect(ran[1]?.[2]).toMatch(/^RECOVERED impl-7 lease lapsed; captured branch observed: omp\/task\/impl-7 \(tip committed \d{4}-\d\d-\d\dT[^)]+; verify it postdates this claim\)$/);
		});

		test("no branch stamps nothing and says so without claiming no work was done", async () => {
			expect(await releaseDeadClaim("orc-1", "impl-7", { cause: "lease lapsed", recoveredBy: "lead:s2" }, repo)).toBe("released");
			expect(ran[0]).not.toContain("recovered_branch=omp/task/impl-7");
			expect(ran[1]?.[2]).toBe("RECOVERED impl-7 lease lapsed; no captured branch observed (not proof of no work)");
		});
	});
});

describe("lease expiry", () => {
	const iso = (ms: number) => new Date(ms).toISOString();

	test("takes the later of lease_until and updated_at + TTL, and never lapses on nothing", () => {
		expect(leaseExpired({ id: "orc-1" }, T0)).toBe(false);
		expect(leaseDeadline({ id: "orc-1", updated_at: iso(T0 - 20 * MINUTE) })).toBe(T0 - 5 * MINUTE);
		expect(leaseExpired({ id: "orc-1", updated_at: iso(T0 - 20 * MINUTE), metadata: { lease_until: iso(T0 + MINUTE) } }, T0)).toBe(false);
		expect(leaseExpired({ id: "orc-1", updated_at: iso(T0 - MINUTE), metadata: { lease_until: iso(T0 - 20 * MINUTE) } }, T0)).toBe(false);
		expect(leaseExpired({ id: "orc-1", updated_at: iso(T0 - 20 * MINUTE), metadata: { lease_until: iso(T0 - MINUTE) } }, T0)).toBe(true);
		expect(leaseExpired({ id: "orc-1", metadata: { lease_until: "garbage" } }, T0)).toBe(false);
	});

	test("honours ORC_LEASE_TTL_MS", () => {
		process.env.ORC_LEASE_TTL_MS = String(MINUTE);
		expect(leaseExpired({ id: "orc-1", updated_at: iso(T0 - 2 * MINUTE) }, T0)).toBe(true);
	});
});

describe("createLeaseRenewer", () => {
	function rig(role: "lead" | "worker", options: { renewLead?: LeadLeaseRenew; registry?: ParkedRegistry } = {}) {
		const messages: string[] = [];
		const leadRenewals: number[] = [];
		let leadOutcome: LeadLeaseRenewal["outcome"] = "renewed";
		const pi = {
			getAllTools: () => (role === "worker" ? [{ name: "yield" }] : []),
			logger: { warn: () => {}, info: () => {}, error: () => {} },
			sendMessage: (message: { content: string }) => { messages.push(message.content); },
		} as unknown as ExtensionAPI;
		const ctx = { cwd: "/repo", sessionManager: { getSessionId: () => "s1" } } as unknown as ExtensionContext;
		const claims = createClaimState();
		const renewLead: LeadLeaseRenew = options.renewLead ?? (async (_cwd, _session, now) => {
			leadRenewals.push(now);
			return { outcome: leadOutcome, actor: "lead:s1", run: "orc-epic" };
		});
		const renewer = createLeaseRenewer(pi, claims, renewLead, options.registry ?? { list: () => [] });
		return { renewer, ctx, claims, messages, leadRenewals, setLeadOutcome: (outcome: LeadLeaseRenewal["outcome"]) => { leadOutcome = outcome; } };
	}

	test("renews each held bead once per cadence however many tools run", async () => {
		const { renewer, ctx, claims } = rig("worker");
		claims.recordClaim({ actor: "impl-7", beadIds: ["orc-1", "orc-2"] });
		renewer.touch(ctx, T0);
		renewer.touch(ctx, T0 + MINUTE);
		renewer.touch(ctx, T0 + 4 * MINUTE);
		await settle();
		expect(ran.map(argv => argv[1])).toEqual(["orc-1", "orc-2"]);
		renewer.touch(ctx, T0 + 5 * MINUTE);
		await settle();
		expect(ran.map(argv => argv[1])).toEqual(["orc-1", "orc-2", "orc-1", "orc-2"]);
	});

	test("a session holding nothing renews nothing, and a worker never renews the lead lease", async () => {
		const { renewer, ctx, leadRenewals } = rig("worker");
		renewer.touch(ctx, T0);
		await settle();
		expect(ran).toEqual([]);
		expect(leadRenewals).toEqual([]);
	});

	test("the lead renews the run lease on the same cadence and is told when displaced", async () => {
		const { renewer, ctx, leadRenewals, messages, setLeadOutcome } = rig("lead");
		renewer.touch(ctx, T0);
		renewer.touch(ctx, T0 + MINUTE);
		await settle();
		expect(leadRenewals).toEqual([T0]);
		expect(messages).toEqual([]);
		setLeadOutcome("held-by-other");
		renewer.touch(ctx, T0 + 6 * MINUTE);
		await settle();
		expect(leadRenewals).toEqual([T0, T0 + 6 * MINUTE]);
		expect(messages[0]).toContain("orc-epic is leased to another lead session");
	});

	test("a displaced worker is told once its renewal is refused, and its claim state is left to G2", async () => {
		const { renewer, ctx, claims, messages } = rig("worker");
		claims.recordClaim({ actor: "impl-7", beadIds: ["orc-1"] });
		refuse = "Error claiming orc-1: issue already claimed by impl-9";
		renewer.touch(ctx, T0);
		await settle();
		expect(messages[0]).toContain("Your claim on orc-1 is now held by another actor");
		expect(claims.observedClaim()?.beadIds).toEqual(["orc-1"]);
	});

	test("honours ORC_LEASE_RENEW_MS", async () => {
		process.env.ORC_LEASE_RENEW_MS = String(MINUTE);
		const { renewer, ctx, claims } = rig("worker");
		claims.recordClaim({ actor: "impl-7", beadIds: ["orc-1"] });
		renewer.touch(ctx, T0);
		renewer.touch(ctx, T0 + MINUTE);
		await settle();
		expect(ran).toHaveLength(2);
	});

	describe("on the clock", () => {
		let repo: string;
		beforeEach(async () => {
			repo = await mkdtemp(join(tmpdir(), "orc-lease-tick-"));
			await mkdir(join(repo, ".orchestration"), { recursive: true });
			await writeFile(markerPath(repo), JSON.stringify({ schema_version: 1, run_id: "orc-run" }));
		});
		afterEach(() => rm(repo, { recursive: true, force: true }));

		test("a lead in one 20-minute tool call keeps its lease: the minute timer renews with no touch", async () => {
			const { renewer, ctx } = rig("lead", { renewLead: renewLeadLease });
			const bound = { ...ctx, cwd: repo } as ExtensionContext;
			for (let minute = 0; minute <= 20; minute++) {
				expect(await renewer.tick(bound, T0 + minute * MINUTE)).toEqual({ leadsRun: true });
			}
			expect(ran.every(argv => argv[0] === "update" && argv[1] === "orc-run" && argv[3] === "lead:s1" && argv[4] === "--claim")).toBe(true);
			expect(ran.map(argv => argv[argv.indexOf("--set-metadata") + 1])).toEqual(
				[0, 5, 10, 15, 20].map(minute => `lease_until=${new Date(T0 + (minute + 15) * MINUTE).toISOString()}`),
			);
		});

		test("a displaced lead's tick reports it no longer leads the run", async () => {
			const { renewer, ctx, setLeadOutcome } = rig("lead");
			expect(await renewer.tick(ctx, T0)).toEqual({ leadsRun: true });
			setLeadOutcome("held-by-other");
			expect(await renewer.tick(ctx, T0 + 5 * MINUTE)).toEqual({ leadsRun: false });
		});

		test("the lead's timer renews a parked child's claims under the child's actor, once per cadence", async () => {
			const listed: string[][] = [];
			const listSpy = spyOn(bd, "bdListChecked").mockImplementation(async (args) => {
				listed.push(args);
				return [{ id: "orc-3" }, { id: "orc-4" }];
			});
			try {
				const registry: ParkedRegistry = { list: () => [
					{ id: "parked-9", kind: "sub", status: "parked" },
					{ id: "idle-2", kind: "sub", status: "idle" },
					{ id: "Main", kind: "main", status: "running" },
				] };
				const { renewer, ctx } = rig("lead", { registry });
				await renewer.tick(ctx, T0);
				await renewer.tick(ctx, T0 + MINUTE);
				expect(listed).toEqual([["list", "--include-infra", "--assignee", "parked-9", "--status", "in_progress", "--limit", "0", "--json"]]);
				expect(ran.filter(argv => argv[0] === "update").map(argv => [argv[1], argv[3]])).toEqual([["orc-3", "parked-9"], ["orc-4", "parked-9"]]);
			} finally {
				listSpy.mockRestore();
			}
		});

		test("a worker's tick never reads the registry or the lead lease", async () => {
			const registry: ParkedRegistry = { list: () => { throw new Error("read"); } };
			const { renewer, ctx, claims, leadRenewals } = rig("worker", { registry });
			claims.recordClaim({ actor: "impl-7", beadIds: ["orc-1"] });
			expect(await renewer.tick(ctx, T0)).toEqual({ leadsRun: false });
			expect(ran.map(argv => argv[1])).toEqual(["orc-1"]);
			expect(leadRenewals).toEqual([]);
		});
	});
});
