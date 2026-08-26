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

	test("no version is declared in the catalog", () => {
		// The install resolves the version from `.claude-plugin/plugin.json`, so a version here
		// would be a second place to bump and would go stale the first time release-please runs.
		for (const rel of CATALOGS) {
			const catalog = JSON.parse(read(rel));
			expect(catalog.metadata?.version).toBeUndefined();
			for (const entry of catalog.plugins) {
				expect(entry.version).toBeUndefined();
			}
		}
	});

	test("the plugin manifest exists and carries the version", () => {
		// Without this file the plugin lists but fails to install, because Claude installs FROM
		// it at the entry's source path.
		const manifest = JSON.parse(read(".claude-plugin/plugin.json"));
		expect(manifest.name).toBe("orchestrate");
		expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/);
	});

	test("release-please bumps the manifest, and the two versions agree", () => {
		// One file is the version's home. `extra-files` is what keeps it in step with
		// package.json; without that entry the catalog install would report a stale version
		// forever, and nothing would fail.
		const config = JSON.parse(read("release-please-config.json"));
		const extras = config.packages["."]["extra-files"];
		expect(extras).toContainEqual({
			type: "json",
			path: ".claude-plugin/plugin.json",
			jsonpath: "$.version",
		});

		const manifest = JSON.parse(read(".claude-plugin/plugin.json"));
		const pkg = JSON.parse(read("package.json"));
		expect(manifest.version).toBe(pkg.version);
	});

	test("the entry names the extension omp actually loads", () => {
		// Rules and agents load in omp only when package.json carries the `omp` marker, so a
		// catalog entry without a loadable extension installs and does nothing.
		const pkg = JSON.parse(read("package.json"));
		expect(pkg.omp?.extensions).toEqual(["./src/index.ts"]);
		expect(fs.existsSync(path.join(ROOT, "src/index.ts"))).toBe(true);
	});
});
