import { afterEach, describe, expect, test } from "bun:test";
import { observeClaimResult } from "../src/claim-observer";
import { forgetClaim, observedClaim } from "../src/claim-state";

/**
 * A claim report as beads 1.1.2 prints it on success, trimmed to the fields read.
 * Measured: a losing claim prints NO stdout and puts `Error claiming <id>: issue already
 * claimed by <actor>` on stderr, so the absence of this shape is the failure signal.
 */
function report(fields: Record<string, unknown>): { text: string }[] {
	return [{ text: JSON.stringify([{ id: "orc-1", status: "in_progress", assignee: "impl-1", ...fields }]) }];
}

const QUEUE_CLAIM = "bd ready --parent orc-epic --metadata-field role=implementer --unassigned --claim --json";

function observe(event: Record<string, unknown>): void {
	observeClaimResult({ toolName: "bash", input: { command: QUEUE_CLAIM }, content: report({}), ...event });
}

afterEach(() => {
	forgetClaim();
});

describe("observeClaimResult", () => {
	test("records the bead a queue claim returned", () => {
		observe({});
		expect(observedClaim()).toEqual({ actor: "impl-1", beadIds: ["orc-1"] });
	});

	test("records a named claim from its report, not from the command", () => {
		// The id in the command is irrelevant: the report is what proves acquisition.
		observe({ input: { command: "BEADS_ACTOR=impl-1 bd update orc-1 --claim --json" } });
		expect(observedClaim()).toEqual({ actor: "impl-1", beadIds: ["orc-1"] });
	});

	test("a successful result carries no exitCode, so its absence must not reject", () => {
		// `tools/bash.ts:720-722` sets details.exitCode only on a failing exit. An earlier
		// draft tested `exitCode === 0` and would have recorded nothing, ever.
		observe({ details: { timeoutSeconds: 120, wallTimeMs: 40 } });
		expect(observedClaim()?.beadIds).toEqual(["orc-1"]);
	});

	test("a present exitCode means failure and is rejected", () => {
		observe({ details: { exitCode: 1 } });
		expect(observedClaim()).toBeUndefined();
	});

	test("an error result is rejected", () => {
		observe({ isError: true });
		expect(observedClaim()).toBeUndefined();
	});

	test("a timed-out result is rejected", () => {
		observe({ details: { timedOut: true } });
		expect(observedClaim()).toBeUndefined();
	});

	test("an async result is rejected: it describes a job started, not a claim completed", () => {
		observe({ details: { async: true } });
		expect(observedClaim()).toBeUndefined();
	});

	test("a trailing command cannot launder a failed claim", async () => {
		// The laundering shape: the claim failed, a trailing `true` makes the shell exit 0,
		// and a valid-looking report is on stdout from something else in the chain. The
		// payload alone cannot distinguish this, so the segment count must.
		observeClaimResult({
			toolName: "bash",
			input: { command: "BEADS_ACTOR=x bd update victim-1 --claim --json; true" },
			content: [{ text: JSON.stringify([{ id: "victim-1", status: "in_progress", assignee: "x" }]) }],
		});
		expect(observedClaim()).toBeUndefined();
	});

	test("prose naming a bead records nothing", () => {
		observe({ content: [{ text: "claimed orc-1 successfully, status in_progress" }] });
		expect(observedClaim()).toBeUndefined();
	});

	test("an echoed lookalike object records nothing", () => {
		// No id scavenging: this is valid JSON in the right shape but not a claim report,
		// because a claim report is an array.
		observe({ content: [{ text: '{"id":"orc-9","status":"in_progress","assignee":"impl-1"}' }] });
		expect(observedClaim()).toBeUndefined();
	});

	test("a two-bead claim records both, so the worktree gate is armed for each", () => {
		// `bd update <a> <b> --claim` claims both, and G2 scopes across every held bead.
		// Recording only one would leave a legitimate claim half observed.
		observe({
			input: { command: "BEADS_ACTOR=impl-1 bd update orc-1 orc-2 --claim --json" },
			content: [
				{
					text: JSON.stringify([
						{ id: "orc-1", status: "in_progress", assignee: "impl-1" },
						{ id: "orc-2", status: "in_progress", assignee: "impl-1" },
					]),
				},
			],
		});
		expect(observedClaim()).toEqual({ actor: "impl-1", beadIds: ["orc-1", "orc-2"] });
	});

	test("records nothing when the report mixes assignees", () => {
		// One actor issued the call, so two assignees mean this is not its claim report.
		observe({
			content: [
				{
					text: JSON.stringify([
						{ id: "orc-1", status: "in_progress", assignee: "impl-1" },
						{ id: "orc-2", status: "in_progress", assignee: "impl-9" },
					]),
				},
			],
		});
		expect(observedClaim()).toBeUndefined();
	});

	test("records nothing when one record in the report is unclaimed", () => {
		observe({
			content: [
				{
					text: JSON.stringify([
						{ id: "orc-1", status: "in_progress", assignee: "impl-1" },
						{ id: "orc-2", status: "open", assignee: "" },
					]),
				},
			],
		});
		expect(observedClaim()).toBeUndefined();
	});

	test("a read of an open bead records nothing", () => {
		observe({ content: report({ status: "open", assignee: "" }) });
		expect(observedClaim()).toBeUndefined();
	});

	test("an in-progress bead with no assignee records nothing", () => {
		observe({ content: report({ assignee: "" }) });
		expect(observedClaim()).toBeUndefined();
	});

	test("a non-claiming command records nothing", () => {
		observe({ input: { command: "bd ready --metadata-field role=implementer --unassigned --json" } });
		expect(observedClaim()).toBeUndefined();
	});

	test("a non-bash tool records nothing", () => {
		observe({ toolName: "read" });
		expect(observedClaim()).toBeUndefined();
	});

	test("malformed JSON records nothing", () => {
		observe({ content: [{ text: "[{" }] });
		expect(observedClaim()).toBeUndefined();
	});
});
