/**
 * Session-scoped record of the claim this session made, and of the claim call it has
 * dispatched but not yet seen the result of.
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

/**
 * The claim call awaiting its result.
 *
 * The host runs every `tool_call` hook of one assistant message before it executes any
 * of them, so two claim calls batched in one turn both find no recorded claim and both
 * pass G5. The first to clear the whole gate chain is marked here; a second claim while
 * the mark stands is refused. The mark is lifted by that call's own `tool_result`, or by
 * `turn_end` when no result ever arrives: a call another extension blocked, or the user
 * denied, produces no result event, and a mark that outlived it would refuse every later
 * claim in the session.
 */
export interface ClaimInFlight {
 /** Mark `toolCallId` as the claim whose result is still to come. */
 begin(toolCallId: string): void;
 /** Whether a claim call is awaiting its result. */
 active(): boolean;
 /** Lift the mark when `toolCallId`'s result arrives; another call's result leaves it. */
 settle(toolCallId: string): void;
 /** Lift the mark unconditionally: the turn ended, so no result is still coming. */
 clear(): void;
}

/** Create the in-flight mark for one extension factory invocation. */
export function createClaimInFlight(): ClaimInFlight {
 let pending: string | undefined;

 return {
  begin(toolCallId: string): void {
   pending = toolCallId;
  },
  active(): boolean {
   return pending !== undefined;
  },
  settle(toolCallId: string): void {
   if (pending === toolCallId) pending = undefined;
  },
  clear(): void {
   pending = undefined;
  },
 };
}
