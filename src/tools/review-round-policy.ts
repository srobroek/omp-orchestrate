import type { AgentToolResult, ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export const DEFAULT_BOT_ROUND_LIMIT = 6;
export const DEFAULT_SAME_ISSUE_LIMIT = 3;

export interface ActionableIssueAttempt {
 issueKey: string;
 completedFixes: number;
}

export interface ReviewRoundPolicy {
 decision: "bounce" | "escalate" | "invalid";
 roundsCompleted: number;
 roundLimit: number;
 sameIssueLimit: number;
 nextRound?: number;
 exhaustedBy?: "total_rounds" | "same_issue";
 exhaustedIssues?: string[];
 error?: string;
}

function resolvedLimit(value: number | undefined, fallback: number): number {
 return Number.isInteger(value) && (value ?? 0) > 0 ? value as number : fallback;
}

export function evaluateReviewRound(
 roundsCompleted: number,
 issues: readonly ActionableIssueAttempt[],
 roundLimit?: number,
 sameIssueLimit?: number,
): ReviewRoundPolicy {
 const resolvedRoundLimit = resolvedLimit(roundLimit, DEFAULT_BOT_ROUND_LIMIT);
 const resolvedIssueLimit = resolvedLimit(sameIssueLimit, DEFAULT_SAME_ISSUE_LIMIT);
 const base = {
  roundsCompleted,
  roundLimit: resolvedRoundLimit,
  sameIssueLimit: resolvedIssueLimit,
 };
 if (!Number.isInteger(roundsCompleted) || roundsCompleted < 0) {
  return { ...base, decision: "invalid", error: "rounds_completed must be a non-negative integer" };
 }
 const malformed = issues.find(issue =>
  issue.issueKey.trim() === "" || !Number.isInteger(issue.completedFixes) || issue.completedFixes < 0,
 );
 if (malformed) {
  return { ...base, decision: "invalid", error: "every actionable issue needs a key and a non-negative integer completed-fix count" };
 }
 if (roundsCompleted >= resolvedRoundLimit) {
  return { ...base, decision: "escalate", exhaustedBy: "total_rounds" };
 }
 const exhaustedIssues = issues
  .filter(issue => issue.completedFixes >= resolvedIssueLimit)
  .map(issue => issue.issueKey)
  .sort();
 if (exhaustedIssues.length > 0) {
  return { ...base, decision: "escalate", exhaustedBy: "same_issue", exhaustedIssues };
 }
 return { ...base, decision: "bounce", nextRound: roundsCompleted + 1 };
}

function toolResult(policy: ReviewRoundPolicy): AgentToolResult<ReviewRoundPolicy> {
 const detail = policy.decision === "bounce"
  ? `next_round=${policy.nextRound}`
  : policy.decision === "escalate"
   ? `exhausted_by=${policy.exhaustedBy}${policy.exhaustedIssues?.length ? ` issues=${policy.exhaustedIssues.join(",")}` : ""}`
   : `error=${policy.error}`;
 return {
  content: [{
   type: "text",
   text: `review round: ${policy.decision} completed=${policy.roundsCompleted} limit=${policy.roundLimit} issue_limit=${policy.sameIssueLimit} ${detail}`,
  }],
  details: policy,
  isError: policy.decision === "invalid",
 };
}

export function registerReviewRoundPolicy(pi: ExtensionAPI): void {
 const z = pi.zod;
 const params = z.object({
  rounds_completed: z.number().describe("integrated and pushed bot-fix rounds already completed for this PR"),
  round_limit: z.number().optional().describe(`positive integer; defaults to ${DEFAULT_BOT_ROUND_LIMIT}`),
  same_issue_limit: z.number().optional().describe(`positive integer; defaults to ${DEFAULT_SAME_ISSUE_LIMIT}`),
  actionable_issues: z.array(z.object({
   issue_key: z.string(),
   completed_fixes: z.number(),
  })).describe("only issues actionable in the current exact-head round"),
 });
 pi.registerTool({
  name: "orc_review_round_policy",
  label: "Review round policy",
  description:
   "Decide whether an actionable bot-review round may create one aggregated fix bead. Enforces the total completed-round limit and each current issue's completed-fix limit without off-by-one counting.",
  approval: "read",
  parameters: params,
  async execute(_id, input): Promise<AgentToolResult<ReviewRoundPolicy>> {
   const issues = input.actionable_issues.map(issue => ({
    issueKey: String(issue.issue_key ?? ""),
    completedFixes: Number(issue.completed_fixes),
   }));
   return toolResult(evaluateReviewRound(
    Number(input.rounds_completed),
    issues,
    input.round_limit === undefined ? undefined : Number(input.round_limit),
    input.same_issue_limit === undefined ? undefined : Number(input.same_issue_limit),
   ));
  },
 });
}
