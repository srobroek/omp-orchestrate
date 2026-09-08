/**
 * Session-scoped record of the claim this session made.
 *
 * Resolving "which bead do I hold" from a cold start is circular: finding the
 * claimed bead needs the actor, and reading the actor off a bead needs the bead.
 * `ExtensionContext` exposes no agent id, so neither end is available.
 *
 * Successful claim reports supply the actor and bead IDs. Acquisition gates refresh
 * previous ownership before clearing this observation for a new claim, and work
 * gates enforce the observed claim's boundaries.
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

/** Preserve every observed acquisition until ownership refresh confirms release. */
export function recordClaim(observation: ClaimObservation): void {
 if (observation.actor.length === 0 || observation.beadIds.length === 0) return;
 if (observed === undefined) {
  observed = { actor: observation.actor, beadIds: [...new Set(observation.beadIds)] };
 } else if (observed.actor === observation.actor) {
  observed = { actor: observed.actor, beadIds: [...new Set([...observed.beadIds, ...observation.beadIds])] };
 }
}

/** The claim this session made, or `undefined` when none was seen. */
export function observedClaim(): ClaimObservation | undefined {
 return observed;
}
/** Drop the recorded claim after verified release, or reset a test session. */
export function forgetClaim(): void {
 observed = undefined;
}
