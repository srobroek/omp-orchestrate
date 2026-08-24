import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const AGENTS_DIR = join(import.meta.dir, "..", "agents");
const KNOWN_ROLES = ["architect", "implementer", "reviewer", "researcher", "shepherd"];
const files = readdirSync(AGENTS_DIR).filter(name => name.endsWith(".md"));

/**
 * The role marker is load-bearing, not documentation: `orcRole` reads it to decide
 * which contract binds a session, and an agent missing one is treated as a
 * contract-free helper — which means G1 imposes BD_READONLY and every bead write it
 * attempts fails. Catch that here rather than at run time.
 */
describe("agent definitions", () => {
	test("all five roles are present and no extras", () => {
		expect(files.sort()).toEqual(KNOWN_ROLES.map(role => `orc-${role}.md`).sort());
	});

	for (const file of files) {
		const body = readFileSync(join(AGENTS_DIR, file), "utf8");
		const role = file.replace(/^orc-|\.md$/g, "");

		describe(file, () => {
			test("declares a marker naming its own known role", () => {
				const match = /^ORC-ROLE:[ \t]*([a-z][a-z-]*)[ \t]*$/m.exec(body);
				expect(match?.[1]).toBe(role);
			});

			test("frontmatter names the agent and binds one built-in model role", () => {
				expect(body).toMatch(new RegExp(`^name: orc-${role}$`, "m"));
				expect(body).toMatch(/^model: "@(plan|task|smol|slow)"$/m);
			});

			test("declares no thinking-level, since the role carries the tier", () => {
				expect(body).not.toMatch(/^thinking-level:/m);
			});

			test("carries no Claude or Codex harness residue", () => {
				for (const pattern of [
					/SubagentStart/,
					/SubagentStop/,
					/UserPromptSubmit/,
					/PreToolUse/,
					/SendMessage/,
					/\$CLAUDE_PROJECT_DIR/,
					/permissionMode/,
					/worktrunk-writer/,
				]) {
					expect(body).not.toMatch(pattern);
				}
			});

			test("tells the agent to pull its own work", () => {
				expect(body).toContain("--unassigned --claim --json");
			});
		});
	}

	test("only the architect may spawn", () => {
		for (const file of files) {
			const body = readFileSync(join(AGENTS_DIR, file), "utf8");
			expect(/^spawns:/m.test(body)).toBe(file === "orc-architect.md");
		}
	});

	test("non-writing roles omit edit and write but keep bash", () => {
		for (const role of ["reviewer", "researcher", "shepherd"]) {
			const body = readFileSync(join(AGENTS_DIR, `orc-${role}.md`), "utf8");
			const tools = /^tools: (.+)$/m.exec(body)?.[1] ?? "";
			expect(tools.length).toBeGreaterThan(0);
			expect(tools.split(/,\s*/)).not.toContain("edit");
			expect(tools.split(/,\s*/)).not.toContain("write");
			// bash stays: reading requires bd and git.
			expect(tools.split(/,\s*/)).toContain("bash");
		}
	});

	test("writing roles omit tools entirely, taking the full default set", () => {
		for (const role of ["architect", "implementer"]) {
			const body = readFileSync(join(AGENTS_DIR, `orc-${role}.md`), "utf8");
			expect(body).not.toMatch(/^tools:/m);
		}
	});
});
