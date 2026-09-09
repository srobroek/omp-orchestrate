import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { BdBead } from "../src/bd";
import * as actualBd from "../src/bd";
import { activateRun, bindRun, readActiveRun } from "../src/run-state";
import { ensurePatrolWisp } from "../src/supervision";

interface Call { args: string[]; cwd: string | undefined }
let calls: Call[] = [];
let linked: BdBead[] | null = [];
let cwd: string;
let createFails = false;
const runSpy = spyOn(actualBd, "bdRun").mockImplementation(async (args, _timeout, directory) => {
 calls.push({ args, cwd: directory });
 if (args[0] === "create" && !createFails) {
  linked = [{ id: args[args.indexOf("--id") + 1]!, status: "open", ephemeral: true, wisp_type: "patrol", metadata: { patrol_epic: "orc-1" } }];
 }
 return { code: createFails ? 1 : 0, stdout: "", stderr: "" };
});
const listSpy = spyOn(actualBd, "bdListChecked").mockImplementation(async (args, _timeout, directory) => {
 calls.push({ args, cwd: directory });
 return linked;
});
afterAll(() => { runSpy.mockRestore(); listSpy.mockRestore(); });
beforeEach(async () => {
 cwd = await mkdtemp(join(tmpdir(), "orc-patrol-"));
 calls = []; linked = []; createFails = false;
 delete process.env.ORCHESTRATE_MARKER_FILE;
});
afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

describe("patrol arming", () => {
 test("bind creates and confirms the deterministic patrol in the run repository", async () => {
  await activateRun(cwd);
  await bindRun(cwd, "orc-1");
  const creates = calls.filter(call => call.args[0] === "create");
  expect(creates).toHaveLength(1);
  expect(creates[0]?.args).toContain("orc-1-patrol");
  expect(creates[0]?.args).toContain("relates-to:orc-1");
  expect(creates[0]?.cwd).toBe(resolve(cwd));
  expect(linked?.[0]?.metadata?.patrol_epic).toBe("orc-1");
 });
 test("concurrent local callers share arming and do not duplicate the patrol", async () => {
  await Promise.all([ensurePatrolWisp("orc-1", cwd), ensurePatrolWisp("orc-1", cwd)]);
  expect(calls.filter(call => call.args[0] === "create")).toHaveLength(1);
 });
 test("an existing linked live patrol is preserved", async () => {
  linked = [{ id: "legacy-wisp", status: "in_progress", ephemeral: true, wisp_type: "patrol" }];
  await ensurePatrolWisp("orc-1", cwd);
  expect(calls.filter(call => call.args[0] === "create")).toEqual([]);
 });
 test("unknown lookup never creates", async () => {
  linked = null;
  await expect(ensurePatrolWisp("orc-1", cwd)).rejects.toThrow(/lookup unknown/);
  expect(calls.filter(call => call.args[0] === "create")).toEqual([]);
 });
 test("a closed deterministic patrol is not overwritten or silently rolled forward", async () => {
  linked = [{ id: "orc-1-patrol", status: "closed", ephemeral: true, wisp_type: "patrol" }];
  await expect(ensurePatrolWisp("orc-1", cwd)).rejects.toThrow(/reconcile/);
  expect(calls.filter(call => call.args[0] === "create")).toEqual([]);
 });
 test("failed creation without positive readback is not armed and can retry", async () => {
  createFails = true;
  await expect(ensurePatrolWisp("orc-1", cwd)).rejects.toThrow(/not confirmed/);
  createFails = false;
  await ensurePatrolWisp("orc-1", cwd);
  expect(linked?.[0]?.id).toBe("orc-1-patrol");
 });
 test("cross-process create conflict accepts only a confirmed patrol for this epic", async () => {
  createFails = true;
  let reads = 0;
  listSpy.mockImplementationOnce(async () => { reads++; return []; });
  listSpy.mockImplementationOnce(async () => { reads++; return [{ id: "orc-1-patrol", status: "open", ephemeral: true, wisp_type: "patrol", metadata: { patrol_epic: "orc-1" } }]; });
  await ensurePatrolWisp("orc-1", cwd);
  expect(reads).toBe(2);
 });
 test("an id collision belonging to a different run cannot establish arming", async () => {
  createFails = true;
  listSpy.mockImplementationOnce(async () => []);
  listSpy.mockImplementationOnce(async () => [{ id: "orc-1-patrol", status: "open", ephemeral: true, wisp_type: "patrol", metadata: { patrol_epic: "other-run" } }]);
  await expect(ensurePatrolWisp("orc-1", cwd)).rejects.toThrow(/not confirmed/);
 });
 test("binding survives unavailable patrol storage", async () => {
  linked = null;
  await activateRun(cwd);
  await bindRun(cwd, "orc-1");
  expect((await readActiveRun(cwd))?.run_id).toBe("orc-1");
  expect(calls.filter(call => call.args[0] === "create")).toEqual([]);
 });
});
