import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { asBead, bdList, bdShow, metadataRecord, parsePayload } from "../src/bd";
import { readyWave } from "../src/dag";

describe("parsePayload", () => {
	test("skips a warning line printed before the payload", () => {
		expect(parsePayload('Warning: cold server\n{"id":"a"}')).toEqual({ id: "a" });
	});

	test("unwraps the schema_version envelope and accepts a bare value", () => {
		expect(parsePayload('{"schema_version":1,"data":[{"id":"a"}]}')).toEqual([{ id: "a" }]);
		expect(parsePayload('[{"id":"a"}]')).toEqual([{ id: "a" }]);
	});

	test("folds null, an empty envelope, and non-JSON into undefined", () => {
		expect(parsePayload("null")).toBeUndefined();
		expect(parsePayload('{"schema_version":1,"data":null}')).toBeUndefined();
		expect(parsePayload("no json here")).toBeUndefined();
		expect(parsePayload("{not json")).toBeUndefined();
	});
});

describe("metadataRecord and asBead", () => {
	test("stringified metadata is parsed onto the bead", () => {
		const bead = asBead({ id: "x", metadata: JSON.stringify({ role: "implementer" }) });
		expect(bead?.metadata).toEqual({ role: "implementer" });
		expect(metadataRecord("[1]")).toBeUndefined();
	});

	test("a value without a string id is not a bead", () => {
		expect(asBead({ status: "open" })).toBeNull();
		expect(asBead(null)).toBeNull();
		expect(asBead({ id: 7 })).toBeNull();
	});
});

describe("bdShow", () => {
	const spawn = spyOn(Bun, "spawn");
	afterEach(() => spawn.mockReset());

	function answer(stdout: string): void {
		spawn.mockImplementation(
			(() => ({
				stdout: new Response(stdout).body,
				stderr: new Response("").body,
				exited: Promise.resolve(0),
				kill: () => undefined,
			})) as unknown as typeof Bun.spawn,
		);
	}

	test("accepts an object or a one-element array", async () => {
		answer('{"id":"a","status":"open"}');
		expect((await bdShow("a", "/tmp")).status).toBe("open");
		answer('[{"id":"a","status":"closed"}]');
		expect((await bdShow("a", "/tmp")).status).toBe("closed");
	});

	test("throws when the payload yields no bead", async () => {
		answer("[]");
		expect(bdShow("a", "/tmp")).rejects.toThrow("returned no bead");
	});
});

describe("readyWave", () => {
	const spawn = spyOn(Bun, "spawn");
	afterEach(() => spawn.mockReset());

	test("three-tier: ready child epics, minus those whose open tasks are all gated", async () => {
		const argvs: string[][] = [];
		spawn.mockImplementation(((argv: string[]) => {
			argvs.push(argv);
			const args = argv.slice(1).join(" ");
			let body = "[]";
			// Epic tier: bd says R.1, R.2 and R.4 are unblocked (R.3 is blocked by R.1; a bound
			// epic would be in_progress and absent). Task tier: R.1 has a ready task; R.2's only
			// task waits on an open decision; R.4 has no tasks at all.
			if (args.startsWith("ready --type epic")) body = '[{"id":"R.1","issue_type":"epic","status":"open"},{"id":"R.2","issue_type":"epic","status":"open"},{"id":"R.4","issue_type":"epic","status":"open"},{"id":"R.1.9","issue_type":"epic","status":"open"}]';
			else if (args.startsWith("ready --parent R.1 ")) body = '[{"id":"R.1.1","issue_type":"task","status":"open"}]';
			return { stdout: new Response(body).body, stderr: new Response("").body, exited: Promise.resolve(0), kill: () => undefined };
		}) as unknown as typeof Bun.spawn);
		const child = (id: string, parent: string, type = "epic", status = "open") => ({ id, issue_type: type, status, dependencies: [{ depends_on_id: parent, type: "parent-child" }] });
		const beads = [child("R.1", "R"), child("R.2", "R"), child("R.3", "R"), child("R.4", "R"), child("R.1.1", "R.1", "task"), child("R.2.1", "R.2", "task"), child("R.3.1", "R.3", "task")];
		const wave = await readyWave("R", beads, "/tmp");
		expect(wave.map(bead => bead.id)).toEqual(["R.1", "R.4"]);
		expect(argvs[0]?.slice(1)).toEqual(["ready", "--type", "epic", "--parent", "R", "--unassigned", "--limit", "0", "--json"]);
		// The task-tier check ran for the two epics with open tasks and not for the empty one.
		expect(argvs.slice(1).map(a => a[3])).toEqual(["R.1", "R.2"]);
	});

	test("two-tier: asks bd ready for unassigned descendants and drops epics", async () => {
		const argvs: string[][] = [];
		spawn.mockImplementation(((argv: string[]) => {
			argvs.push(argv);
			return {
				stdout: new Response('[{"id":"e-1","issue_type":"task","title":"a"},{"id":"e-2","issue_type":"epic","title":"child"},{"id":"e-3","issue_type":"task","title":"c"}]').body,
				stderr: new Response("").body,
				exited: Promise.resolve(0),
				kill: () => undefined,
			};
		}) as unknown as typeof Bun.spawn);
		const wave = await readyWave("e", [], "/tmp");
		expect(argvs[0]?.slice(1)).toEqual(["ready", "--parent", "e", "--unassigned", "--limit", "0", "--json"]);
		expect(wave.map(bead => bead.id)).toEqual(["e-1", "e-3"]);
	});
});

describe("bdList", () => {
	const spawn = spyOn(Bun, "spawn");
	afterEach(() => spawn.mockReset());

	function answer(stdout: string): void {
		spawn.mockImplementation(
			(() => ({
				stdout: new Response(stdout).body,
				stderr: new Response("").body,
				exited: Promise.resolve(0),
				kill: () => undefined,
			})) as unknown as typeof Bun.spawn,
		);
	}

	test("an explicit empty array is the only empty list", async () => {
		answer("[]");
		expect(await bdList(["--parent", "x"], "/tmp")).toEqual([]);
		answer('{"id":"only"}');
		expect((await bdList([], "/tmp")).map(bead => bead.id)).toEqual(["only"]);
	});

	test("no payload, a truncated payload, or a row without an id throws", async () => {
		answer("");
		expect(bdList([], "/tmp")).rejects.toThrow("no JSON array");
		answer('[{"id":"a"},{"id":"b"');
		expect(bdList([], "/tmp")).rejects.toThrow("no JSON array");
		answer('[{"id":"a"},{"title":"no id"}]');
		expect(bdList([], "/tmp")).rejects.toThrow("without an id");
	});
});
