import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { discoverAgents } from "@oh-my-pi/pi-coding-agent/task/discovery";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";

const CORE_AGENTS = {
 "orc-architect": "architect",
 "orc-implementer": "implementer",
 "orc-researcher": "researcher",
 "orc-reviewer": "reviewer",
 "orc-shepherd": "shepherd",
} as const;

const ROLE_MARKER = /^ORC-ROLE:[ \t]*([a-z][a-z-]*)[ \t]*$/m;

export interface AgentDiscoveryFinding {
 agent: string;
 message: string;
 path?: string;
}

function modelAlias(model: string): string | undefined {
 const match = /^(@[^:]+)(?::[^:]+)?$/.exec(model.trim());
 return match?.[1];
}

/** Requested agent names from either supported task-tool wire shape. */
export function requestedAgentNames(input: unknown): string[] {
 if (input === null || typeof input !== "object") return [];
 const record = input as Record<string, unknown>;
 const names: string[] = [];
 if (typeof record.agent === "string" && record.agent.trim() !== "") names.push(record.agent.trim());
 if (Array.isArray(record.tasks)) {
  for (const item of record.tasks) {
   if (item === null || typeof item !== "object") continue;
   const agent = (item as Record<string, unknown>).agent;
   if (typeof agent === "string" && agent.trim() !== "") names.push(agent.trim());
  }
 }
 return [...new Set(names)];
}

/** Validate the definitions that this run depends on without changing spawn policy. */
export function agentDiscoveryFindings(
 agents: readonly AgentDefinition[],
 requested: readonly string[],
 resolveModel?: (spec: string) => unknown,
 modelOverrides: Readonly<Record<string, unknown>> = {},
): AgentDiscoveryFinding[] {
 const byName = new Map(agents.map(agent => [agent.name, agent]));
 const findings: AgentDiscoveryFinding[] = [];
 const required = new Set([...Object.keys(CORE_AGENTS), ...requested]);

 for (const name of required) {
  const agent = byName.get(name);
  if (!agent) {
   findings.push({
    agent: name,
    message: requested.includes(name) ? "requested agent is not discoverable" : "core agent is not discoverable",
   });
   continue;
  }

  const expectedRole = Object.hasOwn(CORE_AGENTS, name) ? CORE_AGENTS[name as keyof typeof CORE_AGENTS] : undefined;
  if (expectedRole !== undefined) {
   const actualRole = ROLE_MARKER.exec(agent.systemPrompt)?.[1];
   if (actualRole !== expectedRole) {
    findings.push({
     agent: name,
     message: `resolved override declares ORC-ROLE ${actualRole ?? "missing"}; expected ${expectedRole}`,
     path: agent.filePath,
    });
   }
  }
  const configured = modelOverrides[name];
  const specs =
   typeof configured === "string"
    ? [configured]
    : Array.isArray(configured)
      ? configured.filter((spec): spec is string => typeof spec === "string")
      : (agent.model ?? []);
  for (const spec of specs) {
   const alias = modelAlias(spec);
   if (alias !== undefined && resolveModel !== undefined && resolveModel(spec) === undefined) {
    findings.push({
     agent: name,
     message: `model alias ${JSON.stringify(alias)} does not resolve`,
     path: agent.filePath,
    });
   }
  }
 }
 return findings;
}

/** Discover through OMP's loader in the active discovery scope. */
export async function discoverAgentFindings(
 ctx: Pick<ExtensionContext, "cwd"> & Partial<Pick<ExtensionContext, "models">>,
 requested: readonly string[] = [],
 modelOverrides: Readonly<Record<string, unknown>> = {},
): Promise<AgentDiscoveryFinding[]> {
 const { agents } = await discoverAgents(ctx.cwd);
 const resolveModel =
  typeof ctx.models?.resolve === "function" ? (spec: string) => ctx.models!.resolve(spec) : undefined;
 return agentDiscoveryFindings(agents, requested, resolveModel, modelOverrides);
}
