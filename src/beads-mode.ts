import { bdRun } from "./bd";

/**
 * The run's beads database must be a per-project Dolt server.
 *
 * Embedded mode is dangerous precisely because it does not fail. `bd` keeps answering
 * and routes every write into `.beads/embeddeddolt`, a database it resolves by walking
 * up from the working directory. A harness that isolates a worker by copying the
 * checkout hands that worker a second writable copy, so its claims, comments and
 * closures land where the run never reads. Measured: a copied 54-bead database accepted
 * `create` and `--claim` with none of it reaching the original. A server resolves by
 * host and port from `.beads/dolt-server.port`, which a filesystem copy cannot redirect.
 *
 * Every question here is put to `bd` rather than to the filesystem, so the answer comes
 * from the tool that owns the format.
 */
export type BeadsReadiness = { ok: true; note?: string } | { ok: false; reason: string };

/** `bd init` clones or creates a database, which is slower than a read. */
const INIT_TIMEOUT_MS = 120_000;

/**
 * Why conversion is refused rather than performed.
 *
 * Writing `dolt_mode: "server"` into `.beads/metadata.json` looks like the fix and is
 * not. Measured on an embedded project holding zero beads: bd started a server and then
 * failed with `database "<name>" not found on Dolt server at 127.0.0.1:<port>`, because
 * the two modes read different directories and the server's database was never created.
 * `bd bootstrap`, whose own help offers to repair a broken database configuration, then
 * failed on that state with `dolt commit: Error 1105: nothing to commit`. A flag flip
 * therefore trades a silent wrong database for a broken one, so this refuses instead and
 * names bd's own health command.
 */
const EMBEDDED_REFUSAL =
	"beads is running embedded, a per-checkout database. bd will keep working and route every write into `.beads/embeddeddolt`, so an isolated worker mutates a copy and its claims, comments and closures never reach this run. A run requires a per-project Dolt server. Setting `dolt_mode` by hand does not convert it: the two modes read different directories, and the server's database would not exist. Run `bd doctor` to inspect, and see `bd backup --help` and `bd bootstrap --help` for carrying existing beads across.";

function firstLine(text: string | undefined): string {
	const line = (text ?? "").split("\n").find(entry => entry.trim().length > 0);
	return line === undefined ? "no output" : line.trim();
}

/**
 * Ensure the working directory holds an initialised, server-mode beads database.
 *
 * Initialising is safe to do for the caller: `--init-if-missing` no-ops against an
 * existing database, so a failure to read one cannot turn into a second one. Converting
 * is not safe, so an embedded project is reported rather than changed.
 *
 * The server process itself is bd's business. Verified: with the server stopped, a plain
 * `bd list` succeeded and left a new server running on a new port, so nothing here
 * starts or reloads anything.
 */
export async function ensureBeadsServer(cwd: string): Promise<BeadsReadiness> {
	const info = await bdRun(["info"], undefined, cwd);
	if (info === null) {
		return { ok: false, reason: "bd could not be run, so the run's database cannot be verified" };
	}

	// A fresh init is reported only after the mode probe below confirms what it produced.
	// Announcing "server" because `--server` was passed would make the note a claim about
	// an argument rather than a measurement of the database.
	let note: string | undefined;
	if (info.code !== 0) {
		const init = await bdRun(
			["init", "--init-if-missing", "--skip-hooks", "--server", "--non-interactive"],
			INIT_TIMEOUT_MS,
			cwd,
		);
		if (init === null) return { ok: false, reason: "bd init could not be run" };
		if (init.code !== 0) return { ok: false, reason: `bd init failed: ${firstLine(init.stderr || init.stdout)}` };
		note = "initialised beads as a per-project Dolt server";
	}

	// `bd dolt show` is the mode's own reporter: `per-project` for a server, and
	// `embedded (in-process Dolt engine)` otherwise. Matching the leading word keeps a
	// future suffix from reading as server mode.
	const mode = await bdRun(["dolt", "show"], undefined, cwd);
	if (mode === null || mode.code !== 0) {
		return { ok: false, reason: "could not read the beads storage mode from `bd dolt show`" };
	}
	if (/^\s*Mode:\s*embedded\b/m.test(mode.stdout)) {
		// Separated from the pre-existing case on purpose: init having just succeeded with
		// `--server` while the database reports embedded is a bd contract change, and
		// sending someone down a data migration for a tooling bug would waste the run.
		return {
			ok: false,
			reason:
				note === undefined
					? EMBEDDED_REFUSAL
					: "bd init reported success with `--server`, but `bd dolt show` still reports embedded mode, so this bd does not honour the flag and the run would write to a per-checkout database",
		};
	}
	return note === undefined ? { ok: true } : { ok: true, note };
}
