import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import { SecurityStore } from "@oh-my-pi/pi-coding-agent/security/store";
import { nativeSecurityScanMatches } from "../src/security-evidence";

interface TestScan {
	status: string;
	producer: { kind: string };
	coverage: { completeness: string; mode: string; inventoryStrategy: string; includePaths: string[]; excludePaths: string[]; explicitExclusions: unknown[]; deferred: unknown[]; openQuestions?: unknown[] };
	plan: { id: string; fingerprint: string };
	provenance: { metadata: { operationId?: string; planFingerprint: string } };
	target: { kind: string; baseRevision: string; headRevision: string; includePaths: string[]; excludePaths: string[] };
}

let scan: TestScan | undefined;
const openSpy = spyOn(SecurityStore, "openForCwd").mockImplementation(async () => ({
	getScan: async () => scan,
}) as unknown as SecurityStore);
afterAll(() => openSpy.mockRestore());

beforeEach(() => {
	scan = {
		status: "completed",
		producer: { kind: "omp-native" },
		coverage: { completeness: "complete", mode: "diff", inventoryStrategy: "diff", includePaths: [], excludePaths: [], explicitExclusions: [], deferred: [] },
		plan: { id: "secplan-1", fingerprint: "plan-fingerprint" },
		provenance: { metadata: { operationId: "secop-1", planFingerprint: "plan-fingerprint" } },
		target: { kind: "ref_diff", baseRevision: "base", headRevision: "head", includePaths: [], excludePaths: [] },
	};
});

test("accepts only a completed native exact-ref scan with operation provenance", async () => {
	expect(await nativeSecurityScanMatches("security://scans/scan-1", "/repo", "base", "head")).toBe(true);
	scan!.target.headRevision = "other";
	expect(await nativeSecurityScanMatches("security://scans/scan-1", "/repo", "base", "head")).toBe(false);
});

test.each([
	["partial coverage", () => { scan!.coverage.completeness = "partial"; }],
	["missing operation", () => { delete scan!.provenance.metadata.operationId; }],
	["foreign producer", () => { scan!.producer.kind = "imported"; }],
	["filtered target", () => { scan!.target.includePaths = ["README.md"]; }],
	["deferred coverage", () => { scan!.coverage.deferred = [{}]; }],
	["empty plan fingerprint", () => { scan!.plan.fingerprint = ""; scan!.provenance.metadata.planFingerprint = ""; }],
])("rejects %s", async (_label, mutate) => {
	mutate();
	expect(await nativeSecurityScanMatches("security://scans/scan-1", "/repo", "base", "head")).toBe(false);
});

test("rejects self-authored URI lookalikes before reading the store", async () => {
	expect(await nativeSecurityScanMatches("security://scan/scan-1", "/repo", "base", "head")).toBe(false);
});
