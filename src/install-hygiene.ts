/**
 * Install-tree hygiene for the plugin's own package directory.
 *
 * OMP's marketplace cache copies a plugin's `source` with `fs.cp(recursive)` and no
 * filter (`extensibility/plugins/marketplace/cache.ts:79`). A GitHub-marketplace install
 * clones the repository, so only tracked files ship. A local-checkout `omp plugin
 * marketplace add <path>` copies the working tree as it stands: the checkout's embedded
 * Dolt store, its backups and interaction log, run state and scratch notes all land in
 * `~/.omp/plugins/cache/plugins/omp-orchestrate___orchestrate___<version>/`, where a
 * stray store confuses every `find -name embeddeddolt` hygiene check and a copy of the
 * project's work store travels with each install.
 *
 * None of those paths is ever valid inside the package, so the plugin removes them from
 * its own install tree at activation. Nothing outside the install root is inspected.
 *
 * The sweep runs only when the install root is a marketplace cache entry, recognised by
 * the cache's `<marketplace>___<plugin>___<version>` directory name. Under `omp plugin
 * link` the install root is the live development checkout, where `.beads/embeddeddolt`
 * is the project's real store and `.orchestration/` a run's marker: deleting them there
 * would destroy work. A linked checkout is left alone.
 */

import fs from "node:fs/promises";
import path from "node:path";

/** Paths, relative to the install root, that a marketplace copy may carry and a package never holds. */
export const STRAY_PATHS: readonly string[] = [
	".beads/embeddeddolt",
	".beads/backups",
	".beads/interactions.jsonl",
	".orchestration",
	"scratch",
];

/** The root of this plugin's package tree: the parent of `src/`. */
export const INSTALL_ROOT = path.resolve(import.meta.dir, "..");

/**
 * The cache layout `cache.ts` documents: two lowercase alnum-and-hyphen name segments and
 * a version of `[a-zA-Z0-9._+-]`, joined by `___`.
 */
const CACHE_ENTRY_RE = /^[a-z0-9-]+___[a-z0-9-]+___[a-zA-Z0-9._+-]+$/;

/** True when `installRoot` is a marketplace cache entry rather than a linked checkout. */
export function isMarketplaceCacheEntry(installRoot: string): boolean {
	return CACHE_ENTRY_RE.test(path.basename(installRoot));
}

/** The subset of the logger the sweep needs; `pi.logger` satisfies it. */
export interface HygieneLog {
	warn(message: string, details?: Record<string, unknown>): void;
}

/**
 * Remove every stray path present under `installRoot`, returning the ones removed
 * (relative, in `STRAY_PATHS` order). A linked checkout returns `[]` untouched. One
 * log line per sweep that removed something; a clean tree is silent.
 */
export async function sweepInstallTree(log: HygieneLog, installRoot = INSTALL_ROOT): Promise<string[]> {
	if (!isMarketplaceCacheEntry(installRoot)) return [];
	const removed: string[] = [];
	for (const relative of STRAY_PATHS) {
		const target = path.join(installRoot, relative);
		try {
			await fs.lstat(target);
		} catch {
			continue;
		}
		await fs.rm(target, { recursive: true, force: true });
		removed.push(relative);
	}
	if (removed.length > 0) {
		log.warn("orchestrate removed stray paths copied into the plugin install", { installRoot, removed });
	}
	return removed;
}
