import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { discoverAgents } from "@oh-my-pi/pi-coding-agent/task/discovery";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";

import type { OrcRole } from "./identity";

interface CoreAgentContract {
 role: OrcRole;
 modelAlias: string;
}

export type CoreAgentName = `orc-${OrcRole}`;

/** One authoritative contract for each core agent name. */
export const CORE_AGENT_CONTRACTS: Record<CoreAgentName, CoreAgentContract> = {
 "orc-architect": { role: "architect", modelAlias: "@plan" },
 "orc-implementer": { role: "implementer", modelAlias: "@task" },
 "orc-researcher": { role: "researcher", modelAlias: "@smol" },
 "orc-reviewer": { role: "reviewer", modelAlias: "@reviewer" },
 "orc-shepherd": { role: "shepherd", modelAlias: "@task" },
};

export const ROLE_MARKER = /^ORC-ROLE:[ \t]*([a-z][a-z-]*)[ \t]*$/m;

export interface AgentDiscoveryFinding {
 agent: string;
 message: string;
 path?: string;
}

function selectorSpecs(value: unknown): string[] | undefined {
 const values: string[] =
  typeof value === "string"
   ? [value]
   : Array.isArray(value) && value.every((item): item is string => typeof item === "string")
    ? value
    : [];
 if (values.length === 0) return undefined;

 const specs: string[] = [];
 for (const value of values) {
  for (const raw of value.split(",")) {
   const spec = raw.trim();
   if (spec.length === 0) return undefined;
   specs.push(spec);
  }
 }
 return specs;
}

function modelAlias(model: string): string | undefined {
 return /^(@[^:]+)(?::[^:]+)?$/.exec(model.trim())?.[1];
}

const CORE_THINKING_SUFFIX = /^(?:auto|inherit|in|off|of|minimal|minim|mini|min|mi|low|lo|medium|mediu|medi|med|me|high|hi|xhigh|xhi|xh|max|ma)$/;

function coreModelAlias(model: string): string | undefined {
 const match = /^(@[^:,\s]+)(?::([^:,\s]+))?$/.exec(model.trim());
 if (match === null) return undefined;
 const suffix = match[2];
 return suffix === undefined || CORE_THINKING_SUFFIX.test(suffix) ? match[1] : undefined;
}

export function coreContractForAgent(name: string): CoreAgentContract | undefined {
 return Object.hasOwn(CORE_AGENT_CONTRACTS, name) ? CORE_AGENT_CONTRACTS[name as CoreAgentName] : undefined;
}

export function coreContractForRole(role: string): CoreAgentContract | undefined {
 const contract = coreContractForAgent(`orc-${role}`);
 return contract?.role === role ? contract : undefined;
}

function validateCoreSelector(
 name: string,
 path: string | undefined,
 value: unknown,
 contract: CoreAgentContract,
 findings: AgentDiscoveryFinding[],
 resolveModel: ((spec: string) => unknown) | undefined,
): void {
 const specs = selectorSpecs(value);
 if (specs === undefined) {
  findings.push({ agent: name, message: "effective model selector is missing or malformed", path });
  return;
 }

 const aliases = specs.map(spec => coreModelAlias(spec));
 if (aliases.some(alias => alias !== contract.modelAlias)) {
  findings.push({
   agent: name,
   message: `effective model must use ${contract.modelAlias}; received ${specs.map(spec => JSON.stringify(spec)).join(", ")}`,
   path,
  });
 }

 for (const spec of specs) {
  const alias = modelAlias(spec);
  if (alias !== undefined && resolveModel !== undefined && resolveModel(spec) === undefined) {
   findings.push({ agent: name, message: `model alias ${JSON.stringify(alias)} does not resolve`, path });
  }
 }
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
 const required = new Set([...Object.keys(CORE_AGENT_CONTRACTS), ...requested]);
 for (const name of required) {
  const agent = byName.get(name);
  if (!agent) {
   findings.push({
    agent: name,
    message: requested.includes(name) ? "requested agent is not discoverable" : "core agent is not discoverable",
   });
   continue;
  }

  const contract = coreContractForAgent(name);
  if (contract !== undefined) {
   const actualRole = ROLE_MARKER.exec(agent.systemPrompt)?.[1];
   if (actualRole !== contract.role) {
    findings.push({
     agent: name,
     message: `resolved override declares ORC-ROLE ${actualRole ?? "missing"}; expected ${contract.role}`,
     path: agent.filePath,
    });
   }
  }

  const hasOverride = Object.hasOwn(modelOverrides, name);
  if (contract !== undefined) {
   validateCoreSelector(name, agent.filePath, agent.model, contract, findings, resolveModel);
   if (hasOverride) validateCoreSelector(name, agent.filePath, modelOverrides[name], contract, findings, resolveModel);
   continue;
  }

  const configured = hasOverride ? modelOverrides[name] : agent.model;
  const specs =
   typeof configured === "string"
    ? [configured]
    : Array.isArray(configured)
     ? configured.filter((spec): spec is string => typeof spec === "string")
     : [];
  for (const spec of specs) {
   const alias = modelAlias(spec);
   if (alias !== undefined && resolveModel !== undefined && resolveModel(spec) === undefined) {
    findings.push({ agent: name, message: `model alias ${JSON.stringify(alias)} does not resolve`, path: agent.filePath });
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
