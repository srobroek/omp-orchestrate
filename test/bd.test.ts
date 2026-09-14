import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { asBead, bdList, bdShow, metadataRecord, parsePayload } from "../src/bd";

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
