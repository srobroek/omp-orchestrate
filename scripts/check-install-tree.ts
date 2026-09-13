#!/usr/bin/env bun
/**
 * What a marketplace install ships: `git clone --depth 1` of this checkout into a temp
 * directory, so only tracked files are present, the way OMP's GitHub-marketplace fetcher
 * builds a plugin (`extensibility/plugins/marketplace/fetcher.ts`). The clone must carry
 * none of the paths a local-checkout `marketplace add` copies by accident, and every
 * directory the plugin's surface is discovered from.
 *
 * Usage: `bun scripts/check-install-tree.ts [checkout]` (default: this repository).
 * Exit 1 lists each failing path.
 */

import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { STRAY_PATHS } from "../src/install-hygiene";

/** Package files and directories a marketplace install must contain to load. */
const REQUIRED = [
	"package.json",
	"config/orchestrate.overlay.yml",
	"agents",
	"skills",
	"src",
];

/** Beside the runtime sweep's list: installed dependencies never belong in a clone either. */
const FORBIDDEN = [...STRAY_PATHS, "node_modules"];

const checkout = path.resolve(process.argv[2] ?? path.resolve(import.meta.dir, ".."));
const tmp = await mkdtemp(path.join(tmpdir(), "orc-install-tree-"));
const clone = path.join(tmp, "clone");

try {
	// `file://` makes the shallow clone real: a bare local path takes the hardlink path,
	// where git ignores `--depth`.
	const git = Bun.spawnSync(["git", "clone", "--quiet", "--depth", "1", `file://${checkout}`, clone]);
	if (git.exitCode !== 0) {
		console.error(git.stderr.toString());
		process.exit(1);
	}

	const failures: string[] = [];
	for (const relative of FORBIDDEN) {
		if (await stat(path.join(clone, relative)).then(() => true, () => false)) failures.push(`present, must not ship: ${relative}`);
	}
	for (const relative of REQUIRED) {
		if (!(await stat(path.join(clone, relative)).then(() => true, () => false))) failures.push(`missing, install cannot load: ${relative}`);
	}

	if (failures.length > 0) {
		for (const failure of failures) console.error(failure);
		process.exit(1);
	}
	console.log(`install tree ok: ${FORBIDDEN.length} stray paths absent, ${REQUIRED.length} required paths present`);
} finally {
	await rm(tmp, { recursive: true, force: true });
}
