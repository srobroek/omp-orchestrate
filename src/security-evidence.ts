import { SecurityStore } from "@oh-my-pi/pi-coding-agent/security/store";

/** Validate a published native scan against the immutable store, not reviewer-authored metadata. */
export async function nativeSecurityScanMatches(reference: string, cwd: string, baseRevision: string, headRevision: string): Promise<boolean> {
	const scanId = /^security:\/\/scans\/([^/]+)$/.exec(reference)?.[1];
	if (scanId === undefined) return false;
	try {
		const scan = await (await SecurityStore.openForCwd(cwd)).getScan(scanId);
		return scan?.status === "completed"
			&& scan.producer.kind === "omp-native"
			&& scan.coverage.completeness === "complete"
			&& scan.coverage.mode === "diff"
			&& scan.coverage.inventoryStrategy === "diff"
			&& scan.coverage.includePaths.length === 0
			&& scan.coverage.excludePaths.length === 0
			&& scan.coverage.explicitExclusions.length === 0
			&& scan.coverage.deferred.length === 0
			&& (scan.coverage.openQuestions?.length ?? 0) === 0
			&& scan.target.includePaths.length === 0
			&& scan.target.excludePaths.length === 0
			&& typeof scan.plan?.id === "string"
			&& scan.plan.id.length > 0
			&& typeof scan.plan.fingerprint === "string"
			&& scan.plan.fingerprint.length > 0
			&& scan.target.kind === "ref_diff"
			&& typeof scan.provenance.metadata?.operationId === "string"
			&& scan.provenance.metadata.operationId.length > 0
			&& typeof scan.provenance.metadata.planFingerprint === "string"
			&& scan.provenance.metadata.planFingerprint.length > 0
			&& scan.provenance.metadata.planFingerprint === scan.plan.fingerprint
			&& scan.target.baseRevision === baseRevision
			&& scan.target.headRevision === headRevision;
	} catch {
		return false;
	}
}
