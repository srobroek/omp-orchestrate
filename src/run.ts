import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * The run locator: which Beads epic this checkout's orchestration run is. It names no
 * store; `bd` resolves the store the way it would for a human in the same directory.
 */
export type Locator = { schema_version: 1; run_id: string };

const LOCATOR_DIR = ".orchestration";
const LOCATOR_FILE = ".active-run";

/** The bound run, or `null` for a missing, unparseable, foreign-version, or empty locator. Never throws. */
export function readLocator(root: string): Locator | null {
	const file = path.join(root, LOCATOR_DIR, LOCATOR_FILE);
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return null;
	}
	if (parsed === null || typeof parsed !== "object") return null;
	const version = "schema_version" in parsed ? parsed.schema_version : undefined;
	if (version !== 1) {
		if (typeof version === "number" && version > 1) {
			console.warn(`${file}: schema_version ${version} is newer than this plugin understands (1); ignoring the locator`);
		}
		return null;
	}
	const runId = "run_id" in parsed ? parsed.run_id : undefined;
	if (typeof runId !== "string" || runId.trim().length === 0) return null;
	return { schema_version: 1, run_id: runId };
}

/** Bind `run_id` for this checkout. Creates `.orchestration/` and, inside `root` only, a `*` gitignore. */
export function writeLocator(root: string, run_id: string): void {
	const dir = path.join(root, LOCATOR_DIR);
	mkdirSync(dir, { recursive: true });
	const ignore = path.join(dir, ".gitignore");
	const realRoot = realpathSync(root);
	const realDir = realpathSync(dir);
	const contained = realDir === realRoot || realDir.startsWith(realRoot + path.sep);
	if (contained && !existsSync(ignore)) writeFileSync(ignore, "*\n");
	const locator: Locator = { schema_version: 1, run_id };
	writeFileSync(path.join(dir, LOCATOR_FILE), `${JSON.stringify(locator)}\n`);
}
