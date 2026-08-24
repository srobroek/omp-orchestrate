/**
 * Session-scoped record of the claim this session made.
 *
 * Resolving "which bead do I hold" from a cold start is circular: finding the
 * claimed bead needs the actor, and reading the actor off a bead needs the bead.
 * `ExtensionContext` exposes no agent id, so neither end is available.
 *
 * The way out is to watch the claim happen. The claim gate parses every
 * `bd ... --claim` on `bash` anyway, so it records the actor and bead ids here and
 * the worktree gate reads them back.
 *
 * This module-level state is correctly session-scoped without extra work: the
 * extension module is re-imported and its factory re-run per session
 * (`extensibility/plugins/legacy-pi-compat.ts:2811` imports with a fresh `?mtime`
 * tag from a monotonic counter), so one session's actor cannot leak into another's.
 */

/** Actor and beads seen on this session's own `bd --claim`. */
export interface ClaimObservation {
	actor: string;
	beadIds: string[];
}

/**
 * Accessors rather than an exported binding, deliberately: `observed` is mutable
 * session state, and exporting it directly would let any gate reassign it. The
 * read/write/reset trio is the encapsulation boundary, and `forgetClaim` is also
 * the test seam.
 */

let observed: ClaimObservation | undefined;

/**
 * Record a claim this session issued. A later claim replaces an earlier one: a
 * worker holds one bead at a time, and a second claim means the first is done.
 */
export function recordClaim(observation: ClaimObservation): void {
	if (observation.actor.length === 0 || observation.beadIds.length === 0) return;
	observed = observation;
}

/** The claim this session made, or `undefined` when none was seen. */
export function observedClaim(): ClaimObservation | undefined {
	return observed;
}

/** Drop the recorded claim. Test seam; also correct after a bounce releases a bead. */
export function forgetClaim(): void {
	observed = undefined;
}
