/**
 * omp-orchestrate — Beads-backed multi-agent orchestration for OMP.
 *
 * Registers one `tool_call` handler, the worker-side protocol injection, and the
 * slash commands. Everything else this plugin contributes — the skill and the
 * agents — is data OMP discovers from the package tree.
 *
 * Every handler opens with `runScope` (`src/run-scope.ts`). Outside a run scope the plugin
 * spawns no process, writes no file, sends no message and refuses no tool call; the slash
 * commands, the six tools, the agents and the skill are its whole surface there.
 */

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ToolCallEventResult } from "@oh-my-pi/pi-coding-agent";
import { bdListChecked, resetReadBudget } from "./bd";
import { observeClaimResult } from "./claim-observer";
import { createClaimInFlight, createClaimState } from "./claim-state";
import { adoptAtCwd, adoptionRefusalNotice } from "./clone-adopt";
import { DISPATCH_CONTRACT } from "./contract";
import { gateBdDiscipline } from "./gates/bd";
import { gateClaimEligibility } from "./gates/claim";
import { createExitGuard } from "./gates/exit";
import { gateLeadContract } from "./gates/lead";
import { createLeadExitWatch } from "./gates/lead-exit";
import { gateBeadWriteFree, rebuildBashInput } from "./gates/readonly";
import { gateImplementerIsolation } from "./gates/spawn";
import { GATED_WRITE_TOOLS, gateWorktreeScope } from "./gates/worktree";
import { gateWorktrunkOwnership } from "./gates/wt-guard";
import { orcRole, sessionRole } from "./identity";
import { createLeaseRenewer } from "./lease";
import { runScope } from "./run-scope";
import { injectLeadContract, isBoundRunActive, isLeadSession, registerRunCommands, renewLeadLease } from "./run-state";
import { bdInvocations } from "./shell";
import { registerSupervision } from "./supervision";
import { registerBotReviewProbe } from "./tools/bot-review-probe";
import { registerBotReviewRequest } from "./tools/bot-review-request";
import { registerConflictProbe } from "./tools/conflict-probe";
import { registerDoctor } from "./tools/doctor";
import { registerRunStatus } from "./tools/run-status";
import { registerReviewRoundPolicy } from "./tools/review-round-policy";
import { preflightSettings, registerWatchers } from "./watchers";

/** Tools any gate inspects. Everything else returns before doing work. */
const GATED_TOOLS: Record<string, true> = { bash: true, edit: true, write: true, yield: true, task: true };

export default function ompOrchestrate(pi: ExtensionAPI): void {
 const claims = createClaimState();
 const claimInFlight = createClaimInFlight();
 const gateExitContract = createExitGuard(claims);
 const leadExitWatch = createLeadExitWatch(claims, process.cwd(), pi.sendMessage.bind(pi));
 const leases = createLeaseRenewer(pi, claims, renewLeadLease);
 pi.setLabel("Orchestrate");

 // Deterministic surfaces the pull loop and the shepherd call by schema, not prose.
 // Activation is the moment the coordination contract starts to matter, so the
 // settings preflight runs there; a session that never activates hears nothing.
 registerRunCommands(pi, cwd => preflightSettings(pi, cwd));
 registerConflictProbe(pi);
 registerRunStatus(pi);
 registerDoctor(pi);
 registerBotReviewProbe(pi);
 registerBotReviewRequest(pi);
 registerReviewRoundPolicy(pi);
 // S1 reaper + W1-W4 watchers: deterministic supervision on the lifecycle bus. The
 // reaper takes the claim state so a release is attributed to this session's identity.
 registerSupervision(pi, isBoundRunActive, claims);
 registerWatchers(pi, claims, leases);

 // The lead has no `yield` tool, so G4 cannot observe its final turn. Keep this
 // advisory watch on the same claim state and active run binding as the gates.
 pi.on("agent_end", (event, ctx) => leadExitWatch(event, ctx));

 /**
  * One handler for every gate, dispatching on tool name.
  *
  * The run scope is read once, first: with none, no gate runs and nothing is read. Role
  * is not an input; a declared `ORC-ROLE` in a checkout no run has marked is a prompt's
  * claim about itself, not run authority.
  *
  * Blocking gates run before G1's rewrite, because a handler returns a single
  * result: a refusal must win over a revision of an input that will not run.
  *
  * The whole body is wrapped, because a throwing `tool_call` handler blocks the
  * tool it was inspecting (`extensibility/extensions/wrapper.ts:237`). A bug here
  * must degrade to fail-open rather than bricking every tool in the session.
  */
 pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult | undefined> => {
  if (GATED_TOOLS[event.toolName] !== true) return undefined;

  try {
   if ((await runScope(ctx)) === null) return undefined;
   resetReadBudget();
   let input = event.input as Record<string, unknown>;
   let inputRevised = false;

   // G9 first: the lead's refusals are on the act itself, and must win over every rewrite
   // below of an input that will not run. Every other seat passes through untouched.
   const lead = await gateLeadContract(ctx, event.toolName, input);
   if (lead) return lead;

   if (event.toolName === "yield") return await gateExitContract(ctx, input);
   if (event.toolName === "task") return gateImplementerIsolation(input);

   // Whether this call claims a bead, whatever else it does. Read after G6, whose
   // actor prefix moves no `--claim`.
   let claiming = false;

   if (event.toolName === "bash") {
    // An isolated copy whose first session_start predates this plugin, or whose store
    // came back with a Worktrunk hook, is repaired before its bd call runs. While the
    // copy still holds a private store, a bd read there answers from the wrong data and
    // a bd write forks the run, so bd commands are refused; other commands may proceed.
    const adoption = await adoptAtCwd(pi, ctx.cwd);
    if (adoption?.kind === "refused" && typeof input.command === "string" && bdInvocations(input.command).length > 0) {
     return { block: true, reason: adoptionRefusalNotice(adoption.reason) };
    }

    const ownership = gateWorktrunkOwnership(input);
    if (ownership) return ownership;
    // G6 before G5: it is a parse plus one marker read where G5 shells out to
    // `bd show` and `bd list`. It takes `pi` because most of its findings are
    // notices, which leave through `sendMessage`; a refusal (a routed sync from a
    // worker, a named database) comes back as a block, and otherwise the return
    // value carries only the actor-prefixed command.
    const discipline = await gateBdDiscipline(pi, ctx, input, event.toolCallId, claims);
    if (discipline?.block) return discipline;
    if (discipline?.input !== undefined) {
     input = discipline.input as Record<string, unknown>;
     inputRevised = true;
    }

    const command = input.command;
    claiming = typeof command === "string" && command.length > 0 &&
     bdInvocations(command).some(invocation => invocation.hasClaim);
    // Before G5's reads: the second of two claims batched in one turn is refused on
    // the mark alone, without asking the store about beads it will never hold.
    if (claiming && claimInFlight.active()) {
     return { block: true, reason: "a claim is already in flight this turn; wait for its result before claiming again" };
    }

    const eligibility = await gateClaimEligibility(claims, ctx, input);
    if (eligibility) return eligibility;
   }

   if (GATED_WRITE_TOOLS[event.toolName] === true) {
    // G2 needs the input: its containment check is on the path the tool
    // names, not only on the cwd the session sits in.
    const scope = await gateWorktreeScope(claims, ctx, event.toolName, input);
    if (scope) return scope;
   }

   // Last, and only for `bash`: G1. A sandboxed helper whose command edits the sandbox
   // variable is refused; otherwise the call leaves with the readonly flag added, while
   // blocking gates above still win.
   let result: ToolCallEventResult | undefined;
   if (event.toolName === "bash") {
    const sandbox = await gateBeadWriteFree(pi, ctx, input);
    if (sandbox?.block) return sandbox;
    // Marked only now, once every refusal above has had its say: a refused claim runs
    // nothing and would leave a mark no result ever lifts.
    if (claiming) claimInFlight.begin(event.toolCallId);
    result = sandbox ?? (inputRevised ? { input: rebuildBashInput(input) } : undefined);
   }

   // The call is going to run, which is the activity a lease measures: renew what this
   // session holds, at most once per cadence per lease, without waiting for bd. A refused
   // tool renews nothing, so a displaced or idle session lets its lease lapse on its own.
   leases.touch(ctx);
   return result;
  } catch (error) {
   pi.logger.error("orchestrate gate failed open", {
    tool: event.toolName,
    error: error instanceof Error ? error.message : String(error),
   });
   return undefined;
  }
 });

 /**
  * Adopt the run's database, then inject the protocol into every worker before its
  * first prompt. The executor awaits this handler before the first turn, so the copy's
  * `.beads/redirect` exists before the worker's first `bd` call.
  *
  * `attribution: "user"` is required: any other value normalises to `"agent"`
  * (`session/messages.ts:654`), and the contract must read as authority rather
  * than as something the model said to itself.
  *
  * The run scope is the gate for both steps. Measured without it: a plain subagent
  * spawned in this repository received the protocol, obeyed it over its own brief,
  * pulled an empty queue for a role that does not exist, and yielded NO_WORK -- the
  * injected text outranked the task it was actually given. The copy's redirect makes
  * every `bd` call reach the run's database, so a worker needs no path per call.
  *
  * The lead hears its own, shorter contract, and only when the marker names this session:
  * a lead session resumed in a checkout it leads. A fresh session in a marked checkout is
  * an operator who has started or adopted nothing yet, and hears it from
  * `/orchestrate-start` or `/orchestrate-resume` when they succeed.
  */
 pi.on("session_start", async (_event, ctx) => {
  const scope = await runScope(ctx);
  if (scope === null) return;
  if (sessionRole(pi) === "lead") {
   if (await isLeadSession(ctx)) injectLeadContract(pi, scope.runId);
   return;
  }
  const adoption = await adoptAtCwd(pi, ctx.cwd);
  if (adoption?.kind === "refused") {
   pi.sendMessage(
    { customType: "com.srobroek.omp-orchestrate.store", content: adoptionRefusalNotice(adoption.reason), display: false, attribution: "user" },
    { triggerTurn: false },
   );
  }
  if (orcRole(ctx) === undefined) return;
  pi.sendMessage(
   {
    customType: "com.srobroek.omp-orchestrate.contract",
    content: DISPATCH_CONTRACT,
    display: false,
    attribution: "user",
   },
   { triggerTurn: false },
  );
 });

 // A queue claim names no bead, so its id exists only in the result. Without this the
 // exit contract took its no-bead branch for every session that pulled work normally,
 // and every check that hangs off the claimed bead went unevaluated. Armed only inside a
 // run scope: a plain session that claims by hand is not held to G2, G4 or G5.
 // Awaited: the host holds the result until every handler settles, so a claim resolved
 // from the store is recorded before the next `tool_call` asks about it.
 pi.on("tool_result", async (event, ctx) => {
  claimInFlight.settle(event.toolCallId);
  if ((await runScope(ctx)) === null) return;
  await observeClaimResult(pi, claims, event);
 });

 // A claim call that was blocked downstream, or denied at approval, produces no result;
 // the turn's end is the last moment its mark can be lifted.
 pi.on("turn_end", () => claimInFlight.clear());

 pi.registerCommand("orchestrate-roster", {
  description: "Pull-queue depth for each role",
  handler: async (_args, ctx) => {
   resetReadBudget();
   const roles = ["architect", "implementer", "reviewer", "researcher", "shepherd"];
   // Review and research queues are ephemeral wisps, which `bd ready` hides by
   // default; without the flag those two roles always read as empty.
   const ready = await Promise.all(roles.map(role =>
    bdListChecked(["ready", "--metadata-field", `role=${role}`, "--unassigned", "--include-ephemeral", "--limit", "0", "--json"]),
   ));
   const lines = roles.map((role, index) => {
    const beads = ready[index];
    return `${role}: ${beads == null ? "unavailable" : `${beads.length} ready`}`;
   });
   ctx.ui.notify(lines.join("\n"), ready.some(beads => beads === null) ? "warning" : "info");
  },
 });
}
