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

 test("the plugin manifest exists and names the plugin", () => {
  // Without this file the plugin lists but fails to install, because Claude installs FROM
  // it at the entry's source path.
  const manifest = JSON.parse(read(".claude-plugin/plugin.json"));
  expect(manifest.name).toBe("orchestrate");
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

 test("the release PR branch carries the component release-please demands", () => {
  // The measured trap, and the reason v0.1.1 through v0.2.0 were every one cut by hand.
  //
  // release-please only tags a merged release PR when the PR's head branch resolves to the
  // same component the strategy reports. In `buildRelease` (strategies/base.ts) it compares
  // `BranchName.parse(headBranchName).component` against `getBranchComponent()`, and on a
  // mismatch it logs `PR component: undefined does not match configured component: X` and
  // returns no release. The PR still merges, the workflow still reports success, and the
  // version silently never ships.
  //
  // `getBranchComponent()` here can never be empty: it is this `component` key, or failing
  // that the scope-stripped package.json name. So the head branch MUST carry a component.
  // It only does when release-please builds a per-package PR. Leave `separate-pull-requests`
  // false or absent -- false is the DEFAULT, so deleting the key reintroduces the bug -- and
  // the Merge plugin overwrites the branch with a componentless `release-please--branches--
  // main`, the comparison fails, and nothing tags.
  const config = JSON.parse(read("release-please-config.json"));
  const pkgConfig = config.packages["."];
  const branchComponent =
   pkgConfig.component ?? JSON.parse(read("package.json")).name.replace(/^@[\w-]+\//, "");
  expect(branchComponent).not.toBe("");
  expect(config["separate-pull-requests"]).toBe(true);
 });

});
