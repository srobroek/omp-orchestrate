/**
 * Test preload: keep every test run out of any real run marker.
 *
 * `src/bd.ts` resolves the store token from the marker at `process.cwd()`, and a `bun
 * test` started inside a checkout with an active run would let every `Bun.spawn` fake
 * cache under the real store's token, leaking payloads across test files. Moving the
 * process into an empty directory makes the default scope "no run" for every call that
 * falls back to the process cwd, while each suite's own fixture directory still resolves
 * its marker at the default relative location. Suites locate the repository through
 * `import.meta.dir`, never through the process cwd.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.chdir(mkdtempSync(join(tmpdir(), "orc-test-cwd-")));
