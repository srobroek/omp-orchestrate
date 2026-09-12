import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { createClaimState } from "../src/claim-state";
import { gateClaimEligibility } from "../src/gates/claim";

const claims = createClaimState();

const shepherd = { getSystemPrompt: () => ["ORC-ROLE: shepherd"] } as unknown as ExtensionContext;
const reviewer = { getSystemPrompt: () => ["ORC-ROLE: reviewer"] } as unknown as ExtensionContext;
const architect = { getSystemPrompt: () => ["ORC-ROLE: architect"] } as unknown as ExtensionContext;

describe("shepherd state authorship", () => {
 test.each(["approved", "reported", "changes_requested"])("refuses canonical set-state %s in every assignment position", async state => {
  for (const command of [
   `bd set-state orc-merge state=${state}`,
   `bd set-state orc-merge mode=normal state=${state} health=healthy`,
   `bd --actor shep --db /tmp/beads.db --directory=/repo --dolt-auto-commit off --json set-state --reason 'review result' orc-merge health=healthy state=${state}`,
   `env BEADS_ACTOR=shep timeout -k 2s 5s bd -C /repo set-state orc-merge --reason='review result' state=${state}`,
   `bash -lc 'command bd set-state orc-merge mode=normal --actor shep state=${state}'`,
   `bd set-state orc-merge -- state=${state}`,
   `bd set-state orc-merge --reason state=landed state=${state}`,
  ]) {
   expect((await gateClaimEligibility(claims, shepherd, { command }))?.block).toBe(true);
  }
 });
 test.each([
  "bd set-state orc-merge state=landed",
  "bd set-state orc-merge state=blocked mode=normal",
  "bd set-state orc-merge state=landed --reason 'approved reported changes_requested'",
  "bd set-state orc-merge --reason state=approved state=landed",
  "bd set-state --reason=state=reported orc-merge state=landed",
  "bd set-state orc-merge --reason 'bd set-state orc-merge state=changes_requested' state=landed",
  "bd --actor state=approved set-state orc-merge --db state=reported state=landed",
  "bd set-state orc-merge mode=approved health=reported review=changes_requested",
  "bd set-state orc-merge state=approved_later",
  "bd set-state orc-merge note=state=approved",
  "bd set-state state=approved state=landed",
 ])("allows legitimate set-state transitions and prose: %s", async command => {
  expect(await gateClaimEligibility(claims, shepherd, { command })).toBeUndefined();
 });
 test.each(["approved", "reported", "changes_requested"])("preserves reviewer and architect set-state authority for %s", async state => {
  for (const role of [reviewer, architect]) {
   expect(await gateClaimEligibility(claims, role, { command: `bd set-state orc-merge state=${state}` })).toBeUndefined();
  }
 });
 test.each([
  "bd update orc-merge --add-label state:approved",
  "bd update orc-merge --add-label=state:approved",
  "bd update orc-merge --set-labels 'orc-merge,state:approved'",
  "bd update orc-merge --set-labels=orc-merge --set-labels=state:approved",
  "bd update orc-merge --status approved",
  "bd update orc-merge --status=APPROVED",
  "bd update orc-merge -s approved",
  "bd update orc-merge -s=approved",
  "bd update orc-merge -sapproved",
  "bd label add orc-merge state:approved",
  "bd label add orc-a orc-b state:approved",
  "bd label propagate orc-parent state:approved",
  "bd create fix --labels state:approved",
  "bd new fix --labels=orc-merge,state:approved",
  "bd create fix -l state:approved",
  "bd create fix -lstate:approved",
  "env BEADS_ACTOR=shep timeout 5s bd -C /repo update orc-merge --add-label state:approved",
  "bash -lc 'bd update orc-merge --set-labels=state:approved'",
  "printf ready\n# commentary\nbd update orc-merge --add-label state:approved",
  // bd's documented shorthand for `bd update <id> --add-label <label>`.
  "bd tag orc-merge state:approved",
  "bd tag orc-merge STATE:Approved",
  "bd -C /repo tag orc-merge state:reported",
 ])("refuses shepherd authored approval: %s", async command => {
  expect((await gateClaimEligibility(claims, shepherd, { command }))?.block).toBe(true);
 });
 test.each(["reported", "changes_requested"])("also refuses shepherd authored %s", async state => {
  expect((await gateClaimEligibility(claims, shepherd, { command: `bd update orc-merge --add-label state:${state}` }))?.block).toBe(true);
 });
 test.each([
  "bd list --label state:approved --json",
  "bd label list orc-merge",
  "bd label remove orc-merge state:approved",
  "bd update orc-merge --remove-label state:approved --assignee ''",
  "bd update orc-merge --status open --assignee ''",
  "bd update orc-merge --add-label state:landed",
  "bd tag orc-merge state:landed",
  "bd tag orc-merge needs-review",
  "bd comment orc-merge 'IDLE head_sha=abc123 inherited state:approved'",
  "bd update orc-merge --description '--status' --notes state:approved",
  "bd update orc-merge --notes 'bd update orc-merge --status approved'",
  "bd create 'state:approved' --labels orc-merge",
 ])("does not attribute inherited/read/prose states to shepherd: %s", async command => {
  expect(await gateClaimEligibility(claims, shepherd, { command })).toBeUndefined();
 });
 test("reviewer may author approval", async () => {
  expect(await gateClaimEligibility(claims, reviewer, { command: "bd update orc-merge --add-label state:approved" })).toBeUndefined();
 });
});
