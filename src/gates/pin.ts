/**
 * G9 — aim `bd` at the run's database.
 *
 * Isolation hands a worker a filesystem copy of the checkout, and `bd` finds its
 * database by walking up from the working directory. An unpinned call therefore reads
 * and writes the copy inside the worker's own workspace: the claim never becomes
 * visible to the run, another agent can claim the same bead, comments and status
 * changes reach nobody, and `bd ready` reports an empty queue while work waits in it.
 *
 * This replaces the `orc-bd-pin` TTSR rule, which asserted the same thing with a regex
 * and `interruptMode: tool-only`, so an unpinned call was aborted. Two defects, both
 * from matching text rather than parsing it:
 *
 * - It fired 511 times across 4,673 recorded commands. At least 39 of those carried no
 *   `bd` invocation at all and 195 more were pure reads of a subcommand list it
 *   happened to name, so the abort landed on commands that were never unpinned.
 * - Its negative lookahead scanned the whole line, so any later `-C` suppressed it for
 *   an earlier unpinned call. `scripts/validate-rules.sh` asserted exactly that as
 *   expected behaviour: `bd update orc-1 --claim && bd -C /repo show orc-1` was a
 *   documented miss, which is a genuinely unpinned write going unremarked.
 *
 * The replacement neither matches text nor refuses. It supplies the pin, the way
 * `readonly.ts` supplies `BD_READONLY=1`, so a worker cannot forget it and no command
 * is aborted for a mistake the gate can simply fix.
 *
 * `BEADS_DIR` semantics, probed against three scratch repositories at bd 1.1.2:
 *
 * - `BEADS_DIR=<repo>/.beads` overrides the cwd walk-up, for reads and for writes: a
 *   `bd q` issued from the copy created its bead in the run repository, and the copy
 *   stayed untouched.
 * - An explicit `-C` beats `BEADS_DIR`, in both directions, so injecting it cannot
 *   hijack a call that deliberately names another repository.
 * - `BEADS_DIR=<repo>` without the `.beads` suffix is ignored in silence — no error,
 *   no warning, and the walk-up wins. That is why the suffix is appended here rather
 *   than left to the marker's value.
 */

import * as path from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { readActiveRun } from "../run-state";
import { bdInvocations } from "../shell";

/** The database directory `BEADS_DIR` must name, given a repository root. */
const BEADS_SUBDIR = ".beads";

/**
 * `BEADS_DIR` for this call, or nothing when the pin is unnecessary or unresolvable.
 *
 * Returning nothing on an unreadable marker is deliberate. A worker whose marker is
 * missing cannot be aimed anywhere, and refusing its `bd` calls would strand it; the
 * lost guard is the smaller failure.
 */
export async function runPinEnv(
	ctx: ExtensionContext,
	input: Record<string, unknown>,
): Promise<Record<string, string> | undefined> {
	const command = input.command;
	if (typeof command !== "string" || command.length === 0) return undefined;

	// Cheap prefilter before touching the filesystem: most bash calls are not bd.
	if (bdInvocations(command).length === 0) return undefined;

	const cwd = ctx.cwd ?? process.cwd();
	const marker = await readActiveRun(cwd).catch(() => null);
	const root = marker?.repo_root;
	if (root === undefined || root.length === 0) return undefined;

	// Inside the run repository the walk-up already finds the run's database, and
	// naming it again would only add noise to every command the session runs.
	const relative = path.relative(root, cwd);
	const inside = relative.length === 0 || (!relative.startsWith("..") && !path.isAbsolute(relative));
	if (inside) return undefined;

	return { BEADS_DIR: path.join(root, BEADS_SUBDIR) };
}
