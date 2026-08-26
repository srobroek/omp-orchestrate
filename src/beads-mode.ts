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

/**
 * The modes a run may use, matched positively so an unrecognised value refuses.
 *
 * Both are server-backed, which is the property that matters: `bd` resolves the database
 * over a socket, and a filesystem copy cannot redirect a host and port. `--server` gives
 * one server per project, and `--shared-server` one per machine on a fixed port with a
 * per-project database name, so a copied checkout still reaches the run's data. Measured
 * by `scripts/probe-copied-checkout.sh`: under both modes a checkout copied to a
 * differently named directory resolved to the ORIGINAL's database and its write reached
 * it, because bd reads `dolt_database` from the copied metadata rather than deriving it
 * from the path. `--shared-server` reports `Mode: shared server` on 127.0.0.1:3308.
 *
 * Matching what is allowed rather than excluding `embedded` is deliberate. bd already
 * ships a third mode, and an exclusion would have admitted it silently on the one axis
 * this gate exists to hold.
 */
const SERVER_MODES: readonly string[] = ["per-project", "shared server"];

/**
 * bd's own diagnostic for a workspace with no database, verbatim from `bd info` on stderr
 * with exit 1. Only this text authorises an init: any other failure means a database that
 * exists and does not answer, where creating one is the wrong move even though
 * `--init-if-missing` would decline to.
 */
const NO_DATABASE = /no beads database found/i;

/**
 * bd's refusal when `dolt.auto-start: false` is set, verbatim from a scratch project:
 * `Dolt server auto-start is disabled (dolt.auto-start: false). Start the server manually:
 * bd dolt start`.
 *
 * That setting is what stops an incidental read from minting a server, which makes starting
 * one this function's job rather than a side effect of whoever called bd first.
 */
const AUTOSTART_DISABLED = /auto-start is disabled/i;

/**
 * `bd dolt status` when no pid file names a live server.
 *
 * It is not the same question as "can the database be reached". Measured: with the server
 * alive on 63916 and `.beads/dolt-server.pid` missing, this reported `not running` while
 * `bd list` returned every bead, and writing the pid back flipped it to `running`.
 */
const SERVER_NOT_RUNNING = /Dolt server:\s*not running/i;

/** Starting a server waits on dolt booting, which is slower than a read. */
const START_TIMEOUT_MS = 60_000;

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
		const diagnostic = `${info.stderr}\n${info.stdout}`;
		if (AUTOSTART_DISABLED.test(diagnostic)) {
			// The database is asleep rather than absent, and bd names the remedy in its own
			// refusal. Running it here is the point of disabling auto-start: one deliberate
			// server per run, started by the run, instead of one per call that finds none.
			const start = await bdRun(["dolt", "start"], START_TIMEOUT_MS, cwd);
			if (start === null || start.code !== 0) {
				return {
					ok: false,
					reason: `beads has auto-start disabled and \`bd dolt start\` failed: ${start === null ? "bd could not be run" : firstLine(start.stderr || start.stdout)}`,
				};
			}
			const retry = await bdRun(["info"], undefined, cwd);
			if (retry === null || retry.code !== 0) {
				return {
					ok: false,
					reason: `\`bd dolt start\` reported success and \`bd info\` still failed: ${retry === null ? "bd could not be run" : firstLine(retry.stderr || retry.stdout)}`,
				};
			}
			note = "started the run's dolt server, which auto-start is deliberately not allowed to do";
		} else if (NO_DATABASE.test(diagnostic)) {
			// No worktree branch here. An earlier version refused in a linked worktree, on the
			// belief that an absent `.beads/` meant a copy had failed to arrive and initialising
			// would mint a second database. That belief came from listing files rather than from
			// running `bd`. Measured since, in five linked worktrees of this repository holding no
			// `.beads/` at all: `bd where` reported the PRIMARY checkout's database and `bd list`
			// returned all nine of its beads. bd follows the worktree to its common git dir by
			// itself, so the branch could never fire for the case it was written for, and the
			// `.worktreeinclude` copy it recommended only added Dolt storage a worktree must not
			// serve from. See `test/beads-mode.test.ts` for the real-bd regression test.
			const init = await bdRun(
				["init", "--init-if-missing", "--skip-hooks", "--server", "--non-interactive"],
				INIT_TIMEOUT_MS,
				cwd,
			);
			if (init === null) return { ok: false, reason: "bd init could not be run" };
			if (init.code !== 0)
				return { ok: false, reason: `bd init failed: ${firstLine(init.stderr || init.stdout)}` };
			note = "initialised beads as a server-backed database";
		} else {
			// Only bd's own "no database" diagnostic authorises an init. Any other failure is a
			// database that exists and will not answer -- corrupt, unreachable, permission
			// denied -- and initialising over it would report a fresh start for a broken run.
			return { ok: false, reason: `bd info failed: ${firstLine(info.stderr || info.stdout)}` };
		}
	}

	const mode = await bdRun(["dolt", "show"], undefined, cwd);
	if (mode === null || mode.code !== 0) {
		return { ok: false, reason: "could not read the beads storage mode from `bd dolt show`" };
	}
	const reported = /^\s*Mode:\s*(.+?)\s*$/m.exec(mode.stdout)?.[1];
	if (reported === undefined) {
		return { ok: false, reason: "`bd dolt show` reported no Mode line, so the storage mode is unknown" };
	}
	if (!SERVER_MODES.includes(reported)) {
		// An unrecognised mode refuses with the value quoted, so a bd that grows a fourth
		// one surfaces here instead of passing as a server.
		if (note !== undefined) {
			return {
				ok: false,
				reason: `bd init reported success with \`--server\`, and \`bd dolt show\` then reported mode "${reported}", so this bd does not honour the flag and the run would write to a database it does not control`,
			};
		}
		return {
			ok: false,
			reason: reported.startsWith("embedded")
				? EMBEDDED_REFUSAL
				: `beads reports storage mode "${reported}", which is not a server-backed mode this run recognises (${SERVER_MODES.join(", ")}). A run needs a database a copied checkout cannot fork.`,
		};
	}

	// A server can be running and untracked at the same time, and that state is what leaks
	// servers. bd answers "is one running?" from `.beads/dolt-server.pid`, so with the pid file
	// gone every later call auto-starts a rival, each of which fails on the store's exclusive
	// lock -- nine consecutive refusals in `dolt-server.log` on the host this was found on,
	// which by then carried 28 orphaned `dolt sql-server` processes.
	//
	// `bd info` has already answered above, so a server is demonstrably reachable; a `not
	// running` here therefore means untracked rather than absent. Reconciled with bd's own
	// verbs instead of by writing its state files: `bd dolt killall` is defined as killing
	// servers on this project's data directory that the canonical pid file does not name, and
	// other projects' servers are preserved.
	const status = await bdRun(["dolt", "status"], undefined, cwd);
	if (status !== null && status.code === 0 && SERVER_NOT_RUNNING.test(status.stdout)) {
		const killed = await bdRun(["dolt", "killall"], START_TIMEOUT_MS, cwd);
		const restarted = await bdRun(["dolt", "start"], START_TIMEOUT_MS, cwd);
		if (killed === null || restarted === null || restarted.code !== 0) {
			return {
				ok: false,
				reason:
					"a dolt server is answering but no pid file names it, so bd will keep auto-starting rivals that fail on the store's lock. `bd dolt killall` followed by `bd dolt start` did not repair it here; run both by hand",
			};
		}
		const reconciled = "reconciled an untracked dolt server, which bd would otherwise keep spawning rivals against";
		note = note === undefined ? reconciled : `${note}, and ${reconciled}`;
	}

	return note === undefined ? { ok: true } : { ok: true, note };
}
