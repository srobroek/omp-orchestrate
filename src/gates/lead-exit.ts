import type { AgentEndEvent, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import grammar from "../contracts/grammar.json";
import type { ClaimState } from "../claim-state";
import { orcRole } from "../identity";
import { isBoundRunActive, readActiveRun } from "../run-state";

const MAX_FOLLOW_UPS = 3;
const PENDING_RUN = "pending";
const TERMINAL_VERBS = new Set(
 grammar.verbs.filter(verb => verb.terminal === true).map(verb => verb.verb),
);

export interface LeadExitMessage {
 customType: "orc-lead-exit";
 content: string;
 display: true;
 details: { bead: string; role: string; excerpt: string };
}

export interface LeadExitSender {
 (message: LeadExitMessage, options: { deliverAs: "followUp"; triggerTurn: true }): void;
}


interface ContextWithWorkerProbe extends ExtensionContext {
 hasTool?: (name: string) => boolean;
}

/** Extract the text blocks from the last assistant message in an agent_end event. */
export function lastAssistantText(messages: readonly unknown[]): string | undefined {
 for (let index = messages.length - 1; index >= 0; index--) {
  const message = messages[index];
  if (message === null || typeof message !== "object") continue;
  const candidate = message as { role?: unknown; content?: unknown };
  if (candidate.role !== "assistant") continue;
  if (typeof candidate.content === "string") return candidate.content;
  if (!Array.isArray(candidate.content)) return "";
  return candidate.content
   .filter((block): block is { type?: unknown; text?: unknown } => block !== null && typeof block === "object")
   .filter(block => block.type === "text" && typeof block.text === "string")
   .map(block => block.text as string)
   .join("\n");
 }
 return undefined;
}

/** Whether any line in the final assistant text starts with a terminal protocol verb. */
export function startsWithTerminalVerb(text: string): boolean {
 const lineLeadingToken = /^\s*(\S+)/;
 return text.split("\n").some(line => {
  const token = lineLeadingToken.exec(line)?.[1];
  return token !== undefined && TERMINAL_VERBS.has(token.replace(/[.,;:!?]+$/, ""));
 });
}

export function createLeadExitWatch(claims: ClaimState, cwd: string, sendMessage?: LeadExitSender) {
 let followUps = 0;
 return async (event: AgentEndEvent, ctx: ContextWithWorkerProbe): Promise<void> => {
  try {
   if (event.willContinue) return;
   if (ctx.hasTool?.("yield") === true || orcRole(ctx) !== undefined) return;

   const runCwd = ctx.cwd || cwd;
   const marker = await readActiveRun(runCwd);
   if (marker === null || marker.run_id === PENDING_RUN) return;
   if (!(await isBoundRunActive(runCwd))) return;

   const claim = claims.observedClaim();
   if (claim === undefined || claim.beadIds.length === 0) return;

   const finalText = lastAssistantText(event.messages) ?? "";
   if (startsWithTerminalVerb(finalText) || followUps >= MAX_FOLLOW_UPS || sendMessage === undefined) return;

   const bead = claim.beadIds.join(", ");
   const role = orcRole(ctx) ?? "lead";
   const excerpt = finalText.slice(0, 120);
   followUps += 1;
   sendMessage(
    {
     customType: "orc-lead-exit",
     content:
      `The lead (${role}) still holds bead ${bead}. Finish the held work and end with a terminal verb, or write ESCALATED/BLOCKED with the reason per the grammar. Final text: ${JSON.stringify(excerpt)}`,
     display: true,
     details: { bead, role, excerpt },
    },
    { deliverAs: "followUp", triggerTurn: true },
   );
  } catch {
   // The watch is advisory. An unavailable marker, Beads read, or runtime sender must not
   // turn the end-of-turn lifecycle event into a session failure.
  }
 };
}
