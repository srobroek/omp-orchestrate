/**
 * Session-scoped record of the claim this session made.
 *
 * The extension factory is imported once and reused across sessions, so claim
 * state must be allocated by each factory invocation rather than stored here at
 * module scope. Successful claim reports supply the actor and bead IDs.
 */

/** Actor and beads seen on this session's own `bd --claim`. */
export interface ClaimObservation {
 actor: string;
 beadIds: string[];
}

export interface ClaimState {
 recordClaim(observation: ClaimObservation): void;
 observedClaim(): ClaimObservation | undefined;
 forgetClaim(): void;
}

/** Create private claim state for one extension factory invocation. */
export function createClaimState(): ClaimState {
 let observed: ClaimObservation | undefined;

 return {
  recordClaim(observation: ClaimObservation): void {
   if (observation.actor.length === 0 || observation.beadIds.length === 0) return;
   if (observed === undefined) {
    observed = { actor: observation.actor, beadIds: [...new Set(observation.beadIds)] };
   } else if (observed.actor === observation.actor) {
    observed = { actor: observed.actor, beadIds: [...new Set([...observed.beadIds, ...observation.beadIds])] };
   }
  },
  observedClaim(): ClaimObservation | undefined {
   return observed;
  },
  forgetClaim(): void {
   observed = undefined;
  },
 };
}
