/**
 * Session-scoped record of the claim this session made, and of the claim call it has
 * dispatched but not yet seen the result of.
 *
 * The extension factory is imported once and reused across sessions, so claim
 * state must be allocated by each factory invocation rather than stored here at
 * module scope. Successful claim reports supply the actor and bead IDs.
 *
 * Two views of one record. `observedClaim` is the claim as G2 and G5 track it: it ends when
 * a read shows the bead released, or a new claim supersedes it. `heldClaim` is the claim
 * the exit gate is bound to: the same beads, kept through every forget, and replaced only
 * by the next claim this activation records. The exit contract hangs off the claim, not
 * off its bookkeeping: a reviewer that closed its wisp and did some unrelated work still
 * owes the wisp's evidence when it yields. Measured escape (omp-orchestrate-cdo): the
 * forgotten claim sent the yield to the never-claimed reminder, and the yield after that
 * was accepted with the verdict check never run.
 */

/** Actor and beads seen on this session's own `bd --claim`. */
export interface ClaimObservation {
 actor: string;
 beadIds: string[];
}

export interface ClaimState {
 recordClaim(observation: ClaimObservation): void;
 /** The claim G2 and G5 currently track; `undefined` once forgotten. */
 observedClaim(): ClaimObservation | undefined;
 /** The claim the exit gate judges: the observed one, kept through a forget until the next claim replaces it. */
 heldClaim(): ClaimObservation | undefined;
 forgetClaim(): void;
}

/** Create private claim state for one extension factory invocation. */
export function createClaimState(): ClaimState {
 let observed: ClaimObservation | undefined;
 let held: ClaimObservation | undefined;

 return {
  recordClaim(observation: ClaimObservation): void {
   if (observation.actor.length === 0 || observation.beadIds.length === 0) return;
   if (observed === undefined) {
    // A claim after a forget is new work; the forgotten one is the reaper's to judge.
    observed = { actor: observation.actor, beadIds: [...new Set(observation.beadIds)] };
    held = observed;
   } else if (observed.actor === observation.actor) {
    // One session has one identity: a second actor's claim is ignored.
    observed = { actor: observed.actor, beadIds: [...new Set([...observed.beadIds, ...observation.beadIds])] };
    held = observed;
   }
  },
  observedClaim(): ClaimObservation | undefined {
   return observed;
  },
  heldClaim(): ClaimObservation | undefined {
   return held;
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
