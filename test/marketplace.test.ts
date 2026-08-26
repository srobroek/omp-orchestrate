import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

/**
 * The catalog is read by three harnesses and normalised before use, so its shape is a
 * contract rather than a preference. Every rule here was probed live rather than read from a
 * schema, and each one has a failure mode that is silent.
 */
const ROOT = path.join(import.meta.dir, "..");
const CATALOGS = [".claude-plugin/marketplace.json", ".omp-plugin/marketplace.json"];

function read(rel: string): string {
	return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

describe("the marketplace catalog", () => {
	test("every copy is byte-identical", () => {
		// Claude reads `.claude-plugin/`, omp prefers `.omp-plugin/` and falls back to the Claude
		// path. Two files that drift make the harnesses disagree about what this repo offers,
		// and nothing reports it.
		const texts = CATALOGS.map(read);
		for (const text of texts.slice(1)) {
			expect(text).toBe(texts[0]);
		}
	});

	test("the plugin source is `./`, never a bare dot", () => {
		// The measured trap: omp's normaliser silently DROPS an entry whose source is ".", so
		// the plugin lists nowhere and `install` then fails with "not found in marketplace".
		// Verified against the normalised snapshot under
		// ~/.omp/plugins/cache/marketplaces/<name>/marketplace.json, which kept this entry.
		for (const rel of CATALOGS) {
			const catalog = JSON.parse(read(rel));
			for (const entry of catalog.plugins) {
				expect(entry.source).toBe("./");
			}
		}
	});

	test("every declared version agrees, across all four files", () => {
		// `omp plugin upgrade` in its all-plugin form compares ONLY catalog entries that declare
		// a version, so an entry without one is invisible to update detection. Declaring it costs
		// a second place to bump, which is why the release-please wiring below is not optional:
		// a catalog frozen at an old version reports no update and nothing fails.
		const versions = new Set<string>();
		for (const rel of CATALOGS) {
			const catalog = JSON.parse(read(rel));
			for (const entry of catalog.plugins) {
				expect(entry.version).toMatch(/^\d+\.\d+\.\d+/);
				versions.add(entry.version);
			}
		}
		versions.add(JSON.parse(read(".claude-plugin/plugin.json")).version);
		versions.add(JSON.parse(read("package.json")).version);
		expect([...versions]).toHaveLength(1);
	});

	test("the plugin manifest exists and carries the version", () => {
		// Without this file the plugin lists but fails to install, because Claude installs FROM
		// it at the entry's source path.
		const manifest = JSON.parse(read(".claude-plugin/plugin.json"));
		expect(manifest.name).toBe("orchestrate");
		expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/);
	});

	test("release-please bumps every file that declares a version", () => {
		// Three files declare it and package.json is the fourth, so three updaters keep them in
		// step. Miss one and that copy freezes: a stale catalog version reports no update to
		// `omp plugin upgrade`, and a stale manifest installs under the wrong version. Neither
		// fails anything, which is why this is asserted rather than trusted.
		const config = JSON.parse(read("release-please-config.json"));
		const extras = config.packages["."]["extra-files"];
		expect(extras).toContainEqual({
			type: "json",
			path: ".claude-plugin/plugin.json",
			jsonpath: "$.version",
		});
		for (const rel of CATALOGS) {
			expect(extras).toContainEqual({ type: "json", path: rel, jsonpath: "$.plugins[0].version" });
		}
	});

	test("the entry names the extension omp actually loads", () => {
		// Rules and agents load in omp only when package.json carries the `omp` marker, so a
		// catalog entry without a loadable extension installs and does nothing.
		const pkg = JSON.parse(read("package.json"));
		expect(pkg.omp?.extensions).toEqual(["./src/index.ts"]);
		expect(fs.existsSync(path.join(ROOT, "src/index.ts"))).toBe(true);
	});

	test("the Status row states no version at all", () => {
		// Four files declare a version and release-please owns every one. A fifth in the README
		// would be owned by nobody: the row read `Prerelease, version 0.1.4` until this test
		// existed, and the next release would have made it wrong while every gate stayed green.
		//
		// The SHAPE is banned here, not this plugin's current version. Comparing against
		// package.json is blind to the case that matters: after a bump to 0.1.5 a README still
		// reading 0.1.4 contains no current version, so such a test passes on exactly the stale
		// state it exists to catch. Mutation-proved below against that post-bump state.
		//
		// Scoped to this row rather than the file, because a version elsewhere can be legitimate:
		// the Requires row names dependencies, and an example may show one. This row describes
		// this artifact, so a version in it is always a second home for a number that already has
		// four.
		const status = read("README.md")
			.split("\n")
			.find(line => line.startsWith("| Status |"));
		expect(status).toBeDefined();
		expect(status).not.toMatch(/\d+\.\d+\.\d+/);
	});
});
