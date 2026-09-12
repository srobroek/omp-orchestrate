/**
 * Point an isolated copy at the run's database.
 *
 * OMP's native isolation clones the whole checkout (APFS `clonefile`), `.beads/` and its
 * embedded store included, and detaches the copy's `.git`. `bd` resolves its database by
 * walking up from the working directory to the git root, so inside such a copy every call
 * reads and writes the copied store, and the run never sees a claim or a comment made
 * there. `bd` offers one carrier a copy can hold on disk: `.beads/redirect`, a file naming
 * another `.beads`, followed before the local store is considered. Measured on bd 1.2.2:
 * with the redirect in place, `bd where`, `bd -C <copy>` and `bd` from a subdirectory all
 * resolve the target, and with the copied store removed a wrong target fails closed
 * (`no beads database found`) instead of writing somewhere invisible.
 *
 * The target is the `beads_dir` the run marker recorded at activation. The copy carries the
 * marker too, so adoption needs nothing from the process environment and survives a lead
 * restart. It runs at the worker's first `session_start`, which the executor awaits before
 * the first prompt, and again from every gated `bash` call as a cheap repair: two
 * `realpath`s and one `stat` when there is nothing to do.
 */

import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { getWorktreesDir } from "@oh-my-pi/pi-utils";
import { realpathOrUndefined, within } from "./gates/worktree";
import { type ActiveRun, readActiveRun } from "./run-state";

/** What one adoption attempt found, and did. */
export type Adoption =
	/** `cwd` is not an isolated copy, or the run's database already lives beneath it. */
	| { kind: "primary" }
	/** The copy holds no store of its own: adopted earlier, or never copied one. */
	| { kind: "redirected" }
	| { kind: "adopted"; target: string }
	/** The copy keeps its private store; `reason` says why it could not be redirected. */
	| { kind: "refused"; reason: string };

const STORE = "embeddeddolt";

/**
 * Redirect `cwd/.beads` to `run.beads_dir` when `cwd` is an isolated copy holding a store.
 *
 * The redirect is written first, atomically, and the copied store removed second: `bd`
 * honours the redirect with the store still present, so the order leaves no window in
 * which a call reaches the copy. A missing target refuses before either step, keeping the
 * copy's store intact for the operator to inspect. Idempotent: a copy without a store is
 * left alone.
 */
export async function adoptRunDatabase(cwd: string, run: ActiveRun): Promise<Adoption> {
	const [base, real] = await Promise.all([realpathOrUndefined(getWorktreesDir()), realpathOrUndefined(cwd)]);
	if (base === undefined || real === undefined || real === base || !within(real, base)) return { kind: "primary" };

	const beads = path.join(real, ".beads");
	const store = path.join(beads, STORE);
	if ((await fs.stat(store).catch(() => null)) === null) return { kind: "redirected" };

	if (run.beads_dir === undefined) {
		return {
			kind: "refused",
			reason: "the run marker names no database; re-run /orchestrate-run in the primary checkout to record it",
		};
	}
	const target = run.beads_dir;
	// The marker's database beneath this very tree means this is the primary, whatever the
	// worktrees base says. Redirecting it to itself and deleting the store would be data loss.
	const realTarget = await realpathOrUndefined(target);
	if (realTarget !== undefined && within(realTarget, real)) return { kind: "primary" };
	if ((await fs.stat(path.join(target, STORE)).catch(() => null)) === null) {
		return { kind: "refused", reason: `the run's database at ${target} has no ${STORE} store` };
	}

	const redirect = path.join(beads, "redirect");
	const temporary = `${redirect}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await fs.writeFile(temporary, `${target}\n`, { encoding: "utf8", flag: "wx" });
		await fs.rename(temporary, redirect);
	} catch (error) {
		await fs.rm(temporary, { force: true }).catch(() => {});
		return { kind: "refused", reason: `could not write ${redirect}: ${error instanceof Error ? error.message : String(error)}` };
	}
	await fs.rm(store, { recursive: true, force: true });
	return { kind: "adopted", target };
}

/**
 * Attempts in flight, by cwd. Two gated calls in one turn must not both delete the
 * store: `fs.rm` racing itself over one tree fails on the entries the other removed.
 */
const inFlight = new Map<string, Promise<Adoption | undefined>>();

/**
 * Adopt the run's database for the marker at `cwd`, or return `undefined` when there is
 * no marker to adopt from. Outcomes that changed or failed to change anything are logged;
 * the caller decides whether a refusal also reaches the session.
 */
export function adoptAtCwd(pi: ExtensionAPI, cwd: string): Promise<Adoption | undefined> {
	const pending = inFlight.get(cwd);
	if (pending !== undefined) return pending;
	const attempt = (async () => {
		const run = await readActiveRun(cwd);
		if (run === null) return undefined;
		const adoption = await adoptRunDatabase(cwd, run);
		if (adoption.kind === "adopted") {
			pi.logger.info("orchestrate: isolated copy redirected to the run's database", { cwd, target: adoption.target });
		} else if (adoption.kind === "refused") {
			pi.logger.warn("orchestrate: isolated copy keeps a private beads store", { cwd, cause: adoption.reason });
		}
		return adoption;
	})().finally(() => inFlight.delete(cwd));
	inFlight.set(cwd, attempt);
	return attempt;
}

/** What a worker is told when its copy could not be redirected. */
export function adoptionRefusalNotice(reason: string): string {
	return (
		`This isolated workspace still holds a private copy of the beads store: ${reason}. ` +
		"A bd write from here never reaches the run. Do not claim, comment or close beads; " +
		"yield BLOCKED quoting this notice so the lead can repair the run."
	);
}
