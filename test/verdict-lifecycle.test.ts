import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { BdBead } from "../src/bd";
import { edgesOf } from "../src/bd";
import { readyWave } from "../src/dag";
import { applyVerdict } from "../src/verdict";

/**
 * A stateful `bd` double with the semantics the ledger relies on: `ready` lists open,
 * unassigned beads whose non-parent dependencies are all closed; `reopen`, `close`,
 * `update` (status, assignee, claim, metadata), `create`, `dep add`, `comment`, `show`.
 * Drives both `applyVerdict` (as its runner) and `readyWave` (through `Bun.spawn`).
 */
class FakeStore {
	beads = new Map<string, BdBead>();
	comments: string[][] = [];
	private created = 0;

	add(bead: BdBead): BdBead {
		this.beads.set(bead.id, { status: "open", dependencies: [], ...bead });
		return this.beads.get(bead.id) as BdBead;
	}

	under(epic: string): BdBead[] {
		return [...this.beads.values()].filter(bead => edgesOf(bead).some(edge => edge.type === "parent-child" && edge.id === epic));
	}

	private ready(args: readonly string[]): BdBead[] {
		const parent = args[args.indexOf("--parent") + 1] as string;
		const type = args.includes("--type") ? args[args.indexOf("--type") + 1] : undefined;
		return this.under(parent).filter(bead => {
			if (bead.status !== "open" || bead.assignee) return false;
			if (type !== undefined && bead.issue_type !== type) return false;
			return edgesOf(bead).every(edge => edge.type === "parent-child" || this.beads.get(edge.id)?.status === "closed");
		});
	}

	run = async (args: readonly string[]): Promise<unknown> => {
		const [verb, id] = args;
		const bead = () => {
			const found = this.beads.get(id as string);
			if (found === undefined) throw new Error(`no bead ${id}`);
			return found;
		};
		switch (verb) {
			case "ready":
				return this.ready(args);
			case "show":
				return bead();
			case "comment":
				this.comments.push([id as string, args[2] as string]);
				return undefined;
			case "close":
				bead().status = "closed";
				return bead();
			case "reopen":
				bead().status = "open";
				return bead();
			case "dep": {
				// `bd dep add <bead> <depends-on>`
				const target = this.beads.get(args[2] as string);
				if (target === undefined) throw new Error(`no bead ${args[2]}`);
				(target.dependencies as Array<{ id: string; dependency_type: string }>).push({ id: args[3] as string, dependency_type: "blocks" });
				return undefined;
			}
			case "update": {
				const target = bead();
				for (let i = 2; i < args.length; i++) {
					if (args[i] === "--status") target.status = args[++i];
					else if (args[i] === "--assignee") target.assignee = args[++i] || undefined;
					else if (args[i] === "--claim") {
						target.assignee = "worker";
						target.status = "in_progress";
					} else if (args[i] === "--set-metadata") {
						const [key, ...rest] = (args[++i] as string).split("=");
						target.metadata = { ...target.metadata, [key as string]: rest.join("=") };
					}
				}
				return target;
			}
			case "create": {
				const created: BdBead = {
					id: `new-${++this.created}`,
					issue_type: args[args.indexOf("--type") + 1],
					title: args[args.indexOf("--title") + 1],
					metadata: JSON.parse(args[args.indexOf("--metadata") + 1] as string),
					dependencies: args.includes("--parent") ? [{ id: args[args.indexOf("--parent") + 1], dependency_type: "parent-child" }] : [],
				};
				return this.add(created);
			}
			default:
				throw new Error(`fake bd: unhandled ${args.join(" ")}`);
		}
	};

	/** Route `Bun.spawn(["bd", ...])` calls from `readyWave` into this store. */
	spawn() {
		return spyOn(Bun, "spawn").mockImplementation(((cmd: string[]) => {
			const args = cmd.slice(1).filter(arg => arg !== "--json" && arg !== "--limit" && arg !== "0");
			const payload = this.run(args);
			const stream = new ReadableStream<Uint8Array>({
				start: controller => {
					payload.then(value => {
						controller.enqueue(new TextEncoder().encode(JSON.stringify(value ?? null)));
						controller.close();
					});
				},
			});
			return {
				stdout: stream,
				stderr: new Response("").body,
				exited: Promise.resolve(0),
				kill: () => undefined,
			};
		}) as unknown as typeof Bun.spawn);
	}

	async wave(epic: string): Promise<string[]> {
		return (await readyWave(epic, this.under(epic), "/tmp")).map(bead => bead.id);
	}

	verdict(reviewId: string, verdict: "approve" | "fix" | "changes", targets?: string[]) {
		return applyVerdict({ review: this.beads.get(reviewId) as BdBead, verdict, reason: `${verdict} reason`, findings: `${verdict} findings`, targets, bd: this.run, show: async id => this.beads.get(id) as BdBead });
	}

	/** An implementer takes the bead and finishes it. */
	work(id: string) {
		const bead = this.beads.get(id) as BdBead;
		bead.assignee = "impl";
		bead.status = "closed";
	}
}

function reviewedWave(store: FakeStore) {
	store.add({ id: "e", issue_type: "epic" });
	const t1 = store.add({ id: "e.1", issue_type: "task", title: "Add subtract", metadata: { role: "implementer", tier: "basic" }, dependencies: [{ id: "e", dependency_type: "parent-child" }] });
	const t2 = store.add({ id: "e.2", issue_type: "task", title: "Add divide", metadata: { role: "implementer", tier: "max" }, dependencies: [{ id: "e", dependency_type: "parent-child" }] });
	const review = store.add({
		id: "e.9",
		issue_type: "task",
		title: "Review the wave",
		metadata: { role: "reviewer" },
		dependencies: [
			{ id: "e", dependency_type: "parent-child" },
			{ id: "e.1", dependency_type: "blocks" },
			{ id: "e.2", dependency_type: "blocks" },
		],
	});
	store.work(t1.id);
	store.work(t2.id);
	// The reviewer claimed the review bead.
	review.assignee = "reviewer";
	review.status = "in_progress";
	return store;
}

describe("verdict lifecycle against a stateful store", () => {
	afterEach(() => {
		spyOn(Bun, "spawn").mockRestore();
	});

	test("fix: the task is the next wave, then the review re-enters unassigned, then approve empties the wave", async () => {
		const store = reviewedWave(new FakeStore());
		store.spawn();
		expect(await store.wave("e")).toEqual([]);
		await store.verdict("e.9", "fix", ["e.1"]);
		const review = store.beads.get("e.9") as BdBead;
		expect(review.status).toBe("open");
		expect(review.assignee).toBeUndefined();
		expect(await store.wave("e")).toEqual(["e.1"]);
		expect((store.beads.get("e.1") as BdBead).metadata).toMatchObject({ tier: "basic", fix_from: "e.9", fix_round: "1" });
		store.work("e.1");
		expect(await store.wave("e")).toEqual(["e.9"]);
		review.assignee = "reviewer";
		review.status = "in_progress";
		await store.verdict("e.9", "approve");
		expect(await store.wave("e")).toEqual([]);
	});

	test("changes: the fix bead one tier up is the next wave; the review re-enters once it closes", async () => {
		const store = reviewedWave(new FakeStore());
		store.spawn();
		const out = await store.verdict("e.9", "changes", ["e.1"]);
		const fix = out.escalated[0]?.bead as string;
		expect(await store.wave("e")).toEqual([fix]);
		expect((store.beads.get(fix) as BdBead).metadata).toMatchObject({ tier: "deep", escalated_from: "e.1" });
		store.work(fix);
		expect(await store.wave("e")).toEqual(["e.9"]);
	});

	test("changes at max: a planner bead is the next wave; the review re-enters once the decomposition closes", async () => {
		const store = reviewedWave(new FakeStore());
		store.spawn();
		const out = await store.verdict("e.9", "changes", ["e.2"]);
		const decompose = out.planner[0] as string;
		expect(await store.wave("e")).toEqual([decompose]);
		expect((store.beads.get(decompose) as BdBead).metadata).toMatchObject({ role: "planner", decomposes: "e.2" });
		store.work(decompose);
		expect(await store.wave("e")).toEqual(["e.9"]);
	});

	test("DAG review: changes yields a planner revision bead, then the review, then the implementation wave", async () => {
		const store = new FakeStore();
		store.spawn();
		store.add({ id: "e", issue_type: "epic" });
		store.add({ id: "e.1", issue_type: "task", title: "Add subtract", metadata: { role: "implementer" }, dependencies: [{ id: "e", dependency_type: "parent-child" }] });
		const dag = store.add({ id: "e.0", issue_type: "task", title: "Review the DAG", metadata: { role: "dag-reviewer" }, dependencies: [{ id: "e", dependency_type: "parent-child" }] });
		// Open and unclaimed: the review itself is the whole wave, not the task.
		expect(await store.wave("e")).toEqual(["e.0"]);
		dag.assignee = "reviewer";
		dag.status = "in_progress";
		// Claimed: nothing else is dispatchable.
		expect(await store.wave("e")).toEqual([]);
		// An unrelated ready planner bead under the epic is not part of the gate.
		store.add({ id: "e.5", issue_type: "task", title: "Plan something else", metadata: { role: "planner" }, dependencies: [{ id: "e", dependency_type: "parent-child" }] });
		expect(await store.wave("e")).toEqual([]);
		await expect(store.verdict("e.0", "fix")).rejects.toThrow("approve or changes");
		const out = await store.verdict("e.0", "changes");
		const revise = out.planner[0] as string;
		expect(await store.wave("e")).toEqual([revise]);
		store.work(revise);
		expect(await store.wave("e")).toEqual(["e.0"]);
		dag.assignee = "reviewer";
		dag.status = "in_progress";
		await store.verdict("e.0", "approve");
		expect(await store.wave("e")).toEqual(["e.1", "e.5"]);
	});
});
