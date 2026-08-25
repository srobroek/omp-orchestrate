/**
 * TEMPORARY diagnostic. Reports why the patrol fixture's stub `bd` does not run on
 * the CI runner, from the runner itself. Delete once the answer is in hand.
 */

import { expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("why does the stub not execute here", async () => {
	const lines: string[] = [];
	lines.push(`platform=${process.platform} cwd=${process.cwd()} tmpdir=${tmpdir()}`);
	lines.push(`BD_BIN at entry=${JSON.stringify(process.env.BD_BIN)}`);

	for (const [label, base] of [
		["tmp", tmpdir()],
		["repo", process.cwd()],
	] as const) {
		const dir = await mkdtemp(join(base, ".diag-"));
		const log = join(dir, "calls.log");
		const bin = join(dir, "fake-bd");
		await writeFile(bin, `#!/bin/sh\nprintf 'ran\\n' >> ${JSON.stringify(log)}\nprintf '[]'\n`, { mode: 0o755 });

		const info = await stat(bin);
		lines.push(`${label}: mode=${(info.mode & 0o777).toString(8)} dir=${dir}`);

		try {
			const proc = Bun.spawn([bin, "dep", "list"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
			const [out, err, code] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			lines.push(`${label}: spawn code=${code} stdout=${JSON.stringify(out)} stderr=${JSON.stringify(err.slice(0, 200))}`);
		} catch (error) {
			lines.push(`${label}: spawn THREW ${error instanceof Error ? error.message : String(error)}`);
		}

		await rm(dir, { recursive: true, force: true });
	}

	console.log(`---DIAG---\n${lines.join("\n")}\n---END---`);
	expect(true).toBe(true);
});
