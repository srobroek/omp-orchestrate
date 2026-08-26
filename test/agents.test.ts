import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveExplicitModelRole } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { MODEL_ROLE_IDS } from "@oh-my-pi/pi-coding-agent/config/model-roles";
import { loadBundledAgents, parseAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
import { discoverAgents } from "@oh-my-pi/pi-coding-agent/task/discovery";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { parseFrontmatter } from "@oh-my-pi/pi-utils";
import declared from "./declared-surface.json";

const ROOT = join(import.meta.dir, "..");
const AGENTS_DIR = join(ROOT, "agents");
const CONTRACTS_DIR = join(ROOT, "src", "contracts");
const KNOWN_ROLES = ["architect", "implementer", "reviewer", "researcher", "shepherd"];
const files = readdirSync(AGENTS_DIR).filter(name => name.endsWith(".md"));

const declaredModelRoles: string[] = declared.modelRoles.roles;
const declaredSpawnRoles: string[] = declared.spawnRoles.roles;
const declaredPluginAgents: Record<string, string[]> = declared.pluginAgents.byPackage;

/**
 * Every claim below reads the frontmatter through `parseAgent`, which is the same
 * function `loadAgentsFromDir` calls, so this suite sees exactly what OMP's loader sees:
 * `parseFrontmatter` for the YAML, then `parseAgentFields` for the field semantics.
 *
 * A regex cannot stand in for it. `parseAgentFields` accepts `spawns` as CSV, as a YAML
 * `- item` list and as `"*"`, and it *infers* `spawns: "*"` when an explicit `tools:` list
 * contains `task`. The helper this replaced matched `/^spawns: (.+)$/m`, so converting a
 * grant to list form made it read as no grant at all, and a grant arriving through
 * `tools:` was invisible to it. A check that cannot fail is worse than no check.
 *
 * `parseFrontmatter` is still read directly for one question the parsed form cannot
 * answer: whether the `spawns` key is present. An empty value parses to `undefined`,
 * identical to an absent key, and those two mean opposite things to a reader.
 */
const text = new Map(files.map(file => [file, readFileSync(join(AGENTS_DIR, file), "utf8")]));

const parsed = new Map<string, AgentDefinition>(
	files.map(file => [file, parseAgent(join(AGENTS_DIR, file), text.get(file) ?? "", "project")]),
);

const rawFrontmatter = new Map<string, Record<string, unknown>>(
	files.map(file => [
		file,
		parseFrontmatter(text.get(file) ?? "", { location: file, level: "fatal" }).frontmatter,
	]),
);

/**
 * Names resolvable with no machine state: OMP's bundled agents, taken from
 * `loadBundledAgents` rather than a glob of `src/prompts/agents/`, because that directory
 * holds `frontmatter.md` and `init.md`, which are not agents, and omits `sonic`, which has
 * no file at all. Plus this repo's own five.
 */
const bundled = loadBundledAgents();
const hermetic = new Set([...bundled, ...parsed.values()].map(agent => agent.name));

/**
 * OMP's own resolution across every root it consults, which is what a real spawn hits.
 * Environment-dependent by construction: a box without the sibling plugins installed sees
 * bundled agents only, so the live checks below stand down rather than fail. The hermetic
 * checks carry CI.
 */
const discovered = await discoverAgents(ROOT).catch(() => ({ agents: [] as AgentDefinition[] }));
const resolvedPath = new Map(discovered.agents.map(agent => [agent.name, agent.filePath]));
const hasPluginSurface = discovered.agents.some(agent => agent.source !== "bundled");

/** Every name granted by any allowlist in this repo. A wildcard grants the whole universe. */
const grantOf = (file: string): string[] => {
	const spawns = parsed.get(file)?.spawns;
	if (spawns === undefined) return [];
	return spawns === "*" ? [...new Set([...hermetic, ...resolvedPath.keys()])] : spawns;
};
const granted = [...new Set(files.flatMap(grantOf))].sort();

/**
 * A role claims beads when the exit gate holds a contract for it. `src/contracts/` is that
 * registry, so it is the set, not the `orc-` prefix: a future `orc-operator` helper with no
 * contract claims nothing and must not be forbidden. `generic` is the gate's fallback for a
 * routed bead whose role has none, and `grammar` is the comment-verb list, so neither names
 * a role an agent may declare.
 */
const NON_ROLE_CONTRACTS: Record<string, true> = { generic: true, grammar: true };
const contractRoles = readdirSync(CONTRACTS_DIR)
	.filter(name => name.endsWith(".json"))
	.map(name => name.slice(0, -".json".length))
	.filter(name => NON_ROLE_CONTRACTS[name] !== true);

/**
 * The marker, not the name, decides: `orcRole` reads it from the rendered system prompt to
 * pick a contract, so an agent from any package could carry one. Scanned across the whole
 * resolved universe for that reason.
 */
const ROLE_MARKER = /^ORC-ROLE:[ \t]*([a-z][a-z-]*)[ \t]*$/m;
const claimsBeads = (agent: AgentDefinition): boolean => {
	const role = ROLE_MARKER.exec(agent.systemPrompt)?.[1];
	return role !== undefined && contractRoles.includes(role);
};
const claiming = new Set(
	[...bundled, ...parsed.values(), ...discovered.agents].filter(claimsBeads).map(agent => agent.name),
);

/**
 * The resolver's own `ModelRoleLookup`, fed this repo's declaration in place of the
 * machine's settings. Reading live `modelRoles` would pass on the box that configured them
 * and fail everywhere else, which is the opposite of what a role check is for.
 */
const declaredRoleLookup = {
	getModelRole: (role: string): string | undefined => (declaredModelRoles.includes(role) ? "declared" : undefined),
};
const roleOf = (agent: AgentDefinition | undefined): string | undefined =>
	resolveExplicitModelRole(agent?.model, declaredRoleLookup);

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
		const body = text.get(file) ?? "";
		const role = file.replace(/^orc-|\.md$/g, "");

		describe(file, () => {
			test("declares a marker naming its own known role", () => {
				const match = ROLE_MARKER.exec(parsed.get(file)?.systemPrompt ?? "");
				expect(match?.[1]).toBe(role);
			});

			test("frontmatter names the agent after its role", () => {
				expect(parsed.get(file)?.name).toBe(`orc-${role}`);
			});

			test("declares no thinking-level, since the role carries the tier", () => {
				expect(parsed.get(file)?.thinkingLevel).toBeUndefined();
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
				expect(parsed.get(file)?.systemPrompt).toContain("--unassigned --claim --json");
			});
		});
	}

	/**
	 * A granted name that resolves to nothing is the defect this pair exists for: the
	 * allowlist reads as a capability, the spawn fails, and three prose files can describe
	 * the cheap path while it stays unreachable.
	 *
	 * Split hermetic from live deliberately. Resolution is machine state -- a name provided
	 * by a sibling plugin resolves only where that plugin is installed -- so the hermetic
	 * half compares the unresolved remainder against the declared dependency list, in both
	 * directions. A typo is undeclared and fails. A dependency that is no longer granted is
	 * declared for nothing and fails too.
	 */
	test("every granted name resolves in the hermetic universe or is a declared dependency", () => {
		const needsPlugin = granted.filter(name => !hermetic.has(name));
		expect(needsPlugin).toEqual(Object.values(declaredPluginAgents).flat().sort());
	});

	test.skipIf(!hasPluginSurface)("every declared dependency resolves inside the package that declares it", () => {
		const misplaced = Object.entries(declaredPluginAgents).flatMap(([pkg, names]) => {
			const short = pkg.split("/").at(-1);
			const inPkg = (path: string) => path.includes(`/${short}/`) || path.includes(`___${short}___`);
			// A package with no resolved agent at all is not installed. Its declared names
			// are future prerequisites, tolerated while unresolved -- a spawn before install
			// fails loudly with Unknown agent, so nothing silently degrades. A declared name
			// resolving from some OTHER package is a stale or shadowed declaration and fails.
			const installed = [...resolvedPath.values()].some(path => path !== undefined && inPkg(path));
			return names
				.filter(name => {
					const path = resolvedPath.get(name);
					if (path === undefined) return installed;
					return !inPkg(path);
				})
				.map(name => `${pkg}: ${name} -> ${resolvedPath.get(name) ?? "unresolved"}`);
		});
		expect(misplaced).toEqual([]);
	});

	/**
	 * An alias naming no configured role resolves to `model: undefined`, with no warning,
	 * and the session default is used instead. So `@fast-coder` reads as a tier and buys
	 * nothing. `resolveExplicitModelRole` is the resolver's own alias reader; the lookup it
	 * gets here reports this repo's declaration rather than the machine's settings, so the
	 * answer is the same on every box.
	 */
	test("every model alias resolves to a built-in role or one this repo declares", () => {
		const unresolved = [...parsed.entries()]
			.filter(([, agent]) => roleOf(agent) === undefined)
			.map(([file, agent]) => `${file}: ${JSON.stringify(agent.model)}`);
		expect(unresolved).toEqual([]);
	});

	test("every declared model role is named by an agent and is not already built in", () => {
		const named = new Set([...parsed.values()].map(roleOf));
		expect(declaredModelRoles.filter(role => !named.has(role))).toEqual([]);
		expect(declaredModelRoles.filter(role => (MODEL_ROLE_IDS as string[]).includes(role))).toEqual([]);
	});

	/**
	 * The invariant is not "one file may spawn". It is that only the architect may spawn a
	 * role that CLAIMS a bead, because a claim is what the queue and the exit gate depend
	 * on. A worker may spawn helpers, which claim nothing.
	 */
	test("only the architect may spawn a bead-claiming role", () => {
		// Two independent sources must agree, or this passes by finding nothing to forbid.
		// Comparing `claiming` against the contracts it was derived FROM is vacuous: delete
		// a contract and the role drops out of both sides. The agent files are the third
		// party -- a marker with no contract means the exit gate judges that agent against
		// `generic` and its own completion checks never run.
		const marked = [...parsed.values()].map(agent => ROLE_MARKER.exec(agent.systemPrompt)?.[1]);
		expect(marked.filter(role => role !== undefined && !contractRoles.includes(role))).toEqual([]);
		expect([...claiming].sort()).toEqual(contractRoles.map(role => `orc-${role}`).sort());

		// A wildcard grants every agent OMP can resolve, claiming roles included, so no
		// role holds one -- not even the architect, whose allowlist is enumerated.
		expect(files.filter(file => parsed.get(file)?.spawns === "*")).toEqual([]);

		// The architect must hold the grant, or the ladder has no rung below it.
		expect(grantOf("orc-architect.md").filter(name => claiming.has(name)).length).toBeGreaterThan(0);

		for (const file of files.filter(name => name !== "orc-architect.md")) {
			const held = grantOf(file).filter(name => claiming.has(name));
			expect({ file, claiming: held }).toEqual({ file, claiming: [] });
		}
	});

	/**
	 * An absent key is not a weaker allowlist, it is a denial: the executor normalises an
	 * unset `spawns` to "none" before the spawn policy is consulted, so the permissive
	 * default for an unset value is unreachable. An empty key would be the reverse -- a
	 * file that reads as a grant and denies anyway.
	 *
	 * One assertion covers four regressions: a leaf that grows an allowlist, a leaf that
	 * grows one implicitly by adding `task` to `tools:`, a spawner that loses its key, and
	 * either of them writing the key with nothing after it.
	 */
	test("only the declared spawn roles hold an allowlist, and an absent key is the denial", () => {
		expect(declaredSpawnRoles.filter(role => !files.includes(`orc-${role}.md`))).toEqual([]);

		for (const file of files) {
			const role = file.replace(/^orc-|\.md$/g, "");
			const maySpawn = declaredSpawnRoles.includes(role);
			const spawns = parsed.get(file)?.spawns;
			const declaresKey = Object.hasOwn(rawFrontmatter.get(file) ?? {}, "spawns");
			// `spawns !== undefined`, not a non-empty array: `tools: ..., task` infers the
			// wildcard, which is a grant that no array test would see.
			expect({ file, declaresKey, grants: spawns !== undefined }).toEqual({
				file,
				declaresKey: maySpawn,
				grants: maySpawn,
			});
		}
	});

	test("non-writing roles omit edit and write but keep bash", () => {
		for (const role of ["reviewer", "researcher", "shepherd"]) {
			const tools = parsed.get(`orc-${role}.md`)?.tools ?? [];
			expect(tools.length).toBeGreaterThan(0);
			expect(tools).not.toContain("edit");
			expect(tools).not.toContain("write");
			// bash stays: reading requires bd and git.
			expect(tools).toContain("bash");
		}
	});

	test("writing roles omit tools entirely, taking the full default set", () => {
		for (const role of ["architect", "implementer"]) {
			expect(parsed.get(`orc-${role}.md`)?.tools).toBeUndefined();
		}
	});
});
