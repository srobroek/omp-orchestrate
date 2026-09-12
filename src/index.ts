/**
 * omp-orchestrate — Beads-backed multi-agent orchestration for OMP.
 *
 * Registers one `tool_call` handler, the worker-side protocol injection, and two
 * read-only slash commands. Everything else this plugin contributes — the skill, the
 * agents, the formulas — is data OMP discovers from the package tree.
 */

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ToolCallEventResult } from "@oh-my-pi/pi-coding-agent";
import { bdListChecked, bdRun, resetReadBudget } from "./bd";
import { observeClaimResult } from "./claim-observer";
import { createClaimState } from "./claim-state";
import { DISPATCH_CONTRACT } from "./contract";
import { gateBdDiscipline } from "./gates/bd";
import { gateClaimEligibility } from "./gates/claim";
import { createExitGuard } from "./gates/exit";
import { createLeadExitWatch } from "./gates/lead-exit";
import { gateOneClaim } from "./gates/one-claim";
import { beadWriteFreeEnv, pinAddition, pinnedRunActive, rebuildBashInput, reviseBashEnv } from "./gates/readonly";
import { GATED_WRITE_TOOLS, gateWorktreeScope, normalizeRuntimeBeadsDir } from "./gates/worktree";
import { gateWorktrunkOwnership } from "./gates/wt-guard";
import { orcRole, sessionRole } from "./identity";
import { isBoundRunActive, registerRunCommands } from "./run-state";
import { registerSupervision } from "./supervision";
import { registerBotReviewProbe } from "./tools/bot-review-probe";
import { registerBotReviewRequest } from "./tools/bot-review-request";
import { registerConflictProbe } from "./tools/conflict-probe";
import { registerRunStatus } from "./tools/run-status";
import { registerReviewRoundPolicy } from "./tools/review-round-policy";
import { preflightSettings, registerWatchers } from "./watchers";

/** Tools any gate inspects. Everything else returns before doing work. */
const GATED_TOOLS: Record<string, true> = { bash: true, edit: true, write: true, yield: true };

/**
 * Whether this session is under orchestration: it declares an `ORC-ROLE`, or an
 * orchestrate run pins its process and marks its checkout (G1's predicate, shared
 * through `pinnedRunActive`).
 *
 * Every refusing check below hangs off this. Without it the plugin's mere installation
 * refused `git worktree add`, `printenv BEADS_DIR`, and every edit after a hand-closed
 * bead, in repositories no run ever touched. The role check comes first because it
 * costs no read.
 */
async function orchestrated(ctx: ExtensionContext): Promise<boolean> {
 return orcRole(ctx) !== undefined || (await pinnedRunActive(ctx.cwd));
}

export default function ompOrchestrate(pi: ExtensionAPI): void {
 const claims = createClaimState();
 const gateExitContract = createExitGuard(claims);
 const leadExitWatch = createLeadExitWatch(claims, process.cwd(), pi.sendMessage.bind(pi));
 pi.setLabel("Orchestrate");

 // Deterministic surfaces the pull loop and the shepherd call by schema, not prose.
 // Activation is the moment the coordination contract starts to matter, so the
 // settings preflight runs there; a session that never activates hears nothing.
 registerRunCommands(pi, cwd => preflightSettings(pi, cwd));
 registerConflictProbe(pi);
 registerRunStatus(pi);
 registerBotReviewProbe(pi);
 registerBotReviewRequest(pi);
 registerReviewRoundPolicy(pi);
 // S1 reaper + W1-W4 watchers: deterministic supervision on the lifecycle bus.
 registerSupervision(pi, isBoundRunActive);
 registerWatchers(pi, claims);

 // The lead has no `yield` tool, so G4 cannot observe its final turn. Keep this
 // advisory watch on the same claim state and active run binding as the gates.
 pi.on("agent_end", (event, ctx) => leadExitWatch(event, ctx));

 /**
  * One handler for every gate, dispatching on tool name.
  *
  * Blocking gates run before G1's rewrite, because a handler returns a single
  * result: a refusal must win over a revision of an input that will not run.
  *
  * The runtime database check, G3, G6 and G2 run only under orchestration. G5 and
  * G7 scope themselves by the session's role, and G1 by its own pinned-run read.
  *
  * The whole body is wrapped, because a throwing `tool_call` handler blocks the
  * tool it was inspecting (`extensibility/extensions/wrapper.ts:237`). A bug here
  * must degrade to fail-open rather than bricking every tool in the session.
  */
 pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult | undefined> => {
  if (GATED_TOOLS[event.toolName] !== true) return undefined;

  try {
   resetReadBudget();
   let input = event.input as Record<string, unknown>;
   let inputRevised = false;

   if (event.toolName === "yield") return await gateExitContract(ctx, input);

   const scoped = await orchestrated(ctx);

   if (event.toolName === "bash" && scoped) {
    const runtimeDatabase = await normalizeRuntimeBeadsDir(ctx, input);
    if (!runtimeDatabase.ok) return runtimeDatabase.refusal;
    input = runtimeDatabase.input;
    inputRevised = runtimeDatabase.changed;

    const ownership = gateWorktrunkOwnership(input);
    if (ownership) return ownership;
    // G6 before G5: it is a parse plus one marker read where G5 shells out to
    // `bd show` and `bd list`. It takes `pi` because its findings are notices
    // rather than refusals, and a notice leaves through `sendMessage` rather than
    // through the return value.
    const discipline = await gateBdDiscipline(pi, ctx, input, event.toolCallId, claims);
    if (discipline?.block === true) return discipline;
    if (discipline?.input !== undefined) {
     input = discipline.input as Record<string, unknown>;
     inputRevised = true;
    } else if (discipline) {
     return discipline;
    }
   }

   if (event.toolName === "bash") {
    // Also before G5: a refused multi-bead claim must not be recorded, or G2
    // would hold the session to two trees it was never allowed to claim.
    const exclusivity = gateOneClaim(ctx, input);
    if (exclusivity) return exclusivity;

    const eligibility = await gateClaimEligibility(claims, ctx, input);
    if (eligibility) return eligibility;
   }

   if (scoped && GATED_WRITE_TOOLS[event.toolName] === true) {
    // G2 needs the input: its containment check is on the path the tool
    // names, not only on the cwd the session sits in.
    const scope = await gateWorktreeScope(claims, ctx, event.toolName, input);
    if (scope) return scope;
   }

   // Last, and only for `bash`: G1 asynchronously checks the process-local pin and
   // active-run marker before the shared builder adds its environment revision. A
   // missing or invalid marker fails open, while blocking gates above still win.
   if (event.toolName === "bash") {
    const revision = reviseBashEnv(input, { ...pinAddition(input), ...(await beadWriteFreeEnv(pi, ctx)) });
    if (revision) return { input: rebuildBashInput(revision.input as Record<string, unknown>) };
    return inputRevised ? { input: rebuildBashInput(input) } : undefined;
   }

   return undefined;
  } catch (error) {
   pi.logger.error("orchestrate gate failed open", {
    tool: event.toolName,
    error: error instanceof Error ? error.message : String(error),
   });
   return undefined;
  }
 });

 /**
  * Inject the protocol into every worker before its first prompt.
  *
  * `attribution: "user"` is required: any other value normalises to `"agent"`
  * (`session/messages.ts:654`), and the contract must read as authority rather
  * than as something the model said to itself.
  *
  * The run is read for one reason only: it is the run gate. The marker's `repo_root`
  * used to be substituted into the contract for a `bd -C` pin, and both are gone -- the
  * run pins BEADS_DIR once at activation and every child inherits it, so a worker needs
  * no path substituted per call. The same pin is what locates the marker for an
  * isolated worker whose own cwd holds none.
  */
 pi.on("session_start", async (_event, ctx) => {
  if (sessionRole(pi) === "lead" || orcRole(ctx) === undefined) return;
  // No run, no contract. Measured without this guard: a plain subagent spawned in
  // this repository received the protocol, obeyed it over its own brief, pulled an
  // empty queue for a role that does not exist, and yielded NO_WORK -- the injected
  // text outranked the task it was actually given.
  if (!(await pinnedRunActive(ctx.cwd))) return;
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
 // and every check that hangs off the claimed bead went unevaluated. Armed only under
 // orchestration: a plain session that claims by hand is not held to G2, G4 or G5.
 // Awaited: the host holds the result until every handler settles, so a claim resolved
 // from the store is recorded before the next `tool_call` asks about it.
 pi.on("tool_result", async (event, ctx) => {
  if (!(await orchestrated(ctx))) return;
  await observeClaimResult(pi, claims, event);
 });

 pi.registerCommand("orchestrate-status", {
  description: "Run status for the active epic",
  handler: async (args, ctx) => {
   const epic = args.trim();
   const result = await bdRun([
    "list",
    "--type",
    "epic",
    ...(epic.length > 0 ? ["--parent", epic] : []),
    "--json",
   ]);
   if (result === null || result.code !== 0) {
    ctx.ui.notify("bd is unavailable", "warning");
    return;
   }
   // An empty JSON array is a real answer, not a failure: the run has no epics
   // yet. Reporting it as one sent readers looking for a broken bd install.
   const body = result.stdout.trim();
   ctx.ui.notify(body === "[]" || body.length === 0 ? "no epics" : body, "info");
  },
 });

 pi.registerCommand("orchestrate-roster", {
  description: "Pull-queue depth for each role",
  handler: async (_args, ctx) => {
   resetReadBudget();
   const roles = ["architect", "implementer", "reviewer", "researcher", "shepherd"];
   const ready = await Promise.all(roles.map(role =>
    bdListChecked(["ready", "--metadata-field", `role=${role}`, "--unassigned", "--limit", "0", "--json"]),
   ));
   const lines = roles.map((role, index) => {
    const beads = ready[index];
    return `${role}: ${beads == null ? "unavailable" : `${beads.length} ready`}`;
   });
   ctx.ui.notify(lines.join("\n"), ready.some(beads => beads === null) ? "warning" : "info");
  },
 });
}
