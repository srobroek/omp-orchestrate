import type { AgentToolResult, ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { zod } from "@oh-my-pi/pi-coding-agent";
import { describe, expect, test } from "bun:test";
import {
 DEFAULT_BOT_ROUND_LIMIT,
 DEFAULT_SAME_ISSUE_LIMIT,
 evaluateReviewRound,
 registerReviewRoundPolicy,
 type ReviewRoundPolicy,
} from "../src/tools/review-round-policy";

describe("evaluateReviewRound", () => {
 test("allows exactly six completed remediation rounds by default", () => {
  for (let completed = 0; completed < DEFAULT_BOT_ROUND_LIMIT; completed++) {
   expect(evaluateReviewRound(completed, [{ issueKey: `issue-${completed}`, completedFixes: 0 }])).toMatchObject({
    decision: "bounce",
    nextRound: completed + 1,
    roundLimit: DEFAULT_BOT_ROUND_LIMIT,
   });
  }
  expect(evaluateReviewRound(DEFAULT_BOT_ROUND_LIMIT, [{ issueKey: "new-issue", completedFixes: 0 }])).toMatchObject({
   decision: "escalate",
   exhaustedBy: "total_rounds",
  });
 });

 test("keeps the same-issue boundary independent from the total-round boundary", () => {
  expect(evaluateReviewRound(2, [{ issueKey: "thread-1", completedFixes: DEFAULT_SAME_ISSUE_LIMIT - 1 }])).toMatchObject({
   decision: "bounce",
   nextRound: 3,
  });
  expect(evaluateReviewRound(2, [{ issueKey: "thread-1", completedFixes: DEFAULT_SAME_ISSUE_LIMIT }])).toMatchObject({
   decision: "escalate",
   exhaustedBy: "same_issue",
   exhaustedIssues: ["thread-1"],
  });
 });

 test("considers only issue attempts supplied for the current actionable round", () => {
  expect(evaluateReviewRound(4, [{ issueKey: "new-issue", completedFixes: 0 }])).toMatchObject({
   decision: "bounce",
   nextRound: 5,
  });
 });

 test("honours positive configured limits and defaults invalid limits", () => {
  expect(evaluateReviewRound(1, [], 1, 8)).toMatchObject({ decision: "escalate", exhaustedBy: "total_rounds", roundLimit: 1 });
  expect(evaluateReviewRound(0, [], 0, -1)).toMatchObject({
   decision: "bounce",
   roundLimit: DEFAULT_BOT_ROUND_LIMIT,
   sameIssueLimit: DEFAULT_SAME_ISSUE_LIMIT,
  });
 });

 test("refuses malformed counters instead of guessing", () => {
  expect(evaluateReviewRound(-1, [])).toMatchObject({ decision: "invalid" });
  expect(evaluateReviewRound(0, [{ issueKey: "thread", completedFixes: 1.5 }])).toMatchObject({ decision: "invalid" });
  expect(evaluateReviewRound(0, [{ issueKey: "", completedFixes: 0 }])).toMatchObject({ decision: "invalid" });
 });
});

interface RegisteredTool {
 name: string;
 approval?: string;
 execute: (
  id: string,
  input: {
   rounds_completed: number;
   round_limit?: number;
   same_issue_limit?: number;
   actionable_issues: { issue_key: string; completed_fixes: number }[];
  },
 ) => Promise<AgentToolResult<ReviewRoundPolicy>>;
}

function registered(): RegisteredTool {
 const tools: unknown[] = [];
 const pi = { zod, registerTool: (tool: unknown) => tools.push(tool) } as unknown as ExtensionAPI;
 registerReviewRoundPolicy(pi);
 expect(tools).toHaveLength(1);
 return tools[0] as RegisteredTool;
}

describe("registerReviewRoundPolicy", () => {
 test("registers a read-only deterministic policy tool", async () => {
  const tool = registered();
  expect(tool.name).toBe("orc_review_round_policy");
  expect(tool.approval).toBe("read");
  const result = await tool.execute("id", {
   rounds_completed: 6,
   actionable_issues: [{ issue_key: "thread-1", completed_fixes: 0 }],
  });
  expect(result.isError).toBeFalsy();
  expect(result.details).toMatchObject({ decision: "escalate", exhaustedBy: "total_rounds" });
 });
});
