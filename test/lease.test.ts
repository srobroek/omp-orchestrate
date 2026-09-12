import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { setImmediate } from "node:timers/promises";
import * as bd from "../src/bd";
import type { BdResult } from "../src/bd";
import { createClaimState } from "../src/claim-state";
import { createLeaseRenewer, type LeadLeaseRenewal, leaseDeadline, leaseExpired, releaseDeadClaim, renewLease } from "../src/lease";

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
	function rig(role: "lead" | "worker") {
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
		const renewer = createLeaseRenewer(pi, claims, async (_cwd, _session, now) => {
			leadRenewals.push(now);
			return { outcome: leadOutcome, actor: "lead:s1", run: "orc-epic" };
		});
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
});
