/**
 * `orc_doctor` and `/orchestrate-doctor` — the prerequisite report.
 *
 * One pass over everything a run depends on before the first wave, each answered as a
 * row `{ name, status, detail }` with `pass`, `warn`, or `fail`. `fail` means a run
 * started now would break or never land; `warn` means something degrades later (a
 * sweep, a close-out query, a borrowed helper) and the run can still start. `ok` is
 * "no `fail` row".
 *
 * Reads only: version flags, `gh auth status`, `gh repo view`, one GraphQL capability
 * query, `bd where`, the store probe, agent discovery, and the effective settings.
 * Nothing here writes a file, a bead, or a setting. Every subprocess goes through the
 * {@link Exec} seam so the suite drives it from transcripts, and every check catches
 * its own failure into a row: the report is never a throw.
 *
 * The settings rows compare the effective session settings against what the shipped
 * overlay (`config/orchestrate.overlay.yml`) sets, and the repair they name is the
 * overlay's `omp --config` line rather than a table to transcribe.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { type AgentDiscoveryFinding, CORE_AGENT_CONTRACTS, discoverAgentFindings, PLUGIN_AGENTS_BY_PACKAGE } from "../agent-preflight";
import { locateBeadsDir } from "../beads-mode";
import { probeLandingCapabilities } from "../landing";
import { probeStore } from "../store-probe";
import { DECLARED_MODEL_ROLES, OVERLAY_FILE, readSettings, settingsDeviations } from "../watchers";
import { type Exec, spawnExec } from "./bot-review-probe";

export type CheckStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
	name: string;
	status: CheckStatus;
	detail: string;
}

export interface DoctorReport {
	/** No row failed. Warnings do not clear this. */
	ok: boolean;
	checks: DoctorCheck[];
}

/** What the doctor needs from the host: the checkout, and the model registry when one is live. */
export type DoctorContext = Pick<ExtensionContext, "cwd"> & Partial<Pick<ExtensionContext, "models">>;

/** The oldest `bd` whose `--db`, `where --json`, and lease fields the plugin relies on. */
export const MIN_BD_VERSION = { major: 1, minor: 2 } as const;

const VERSION_TIMEOUT_MS = 5_000;
const GH_TIMEOUT_MS = 15_000;

/** A `major.minor[.patch]` triple and the text it was read from. */
export interface ParsedVersion {
	major: number;
	minor: number;
	patch: number;
	text: string;
}

/** The first `major.minor[.patch]` in a version banner, or `undefined`. */
export function parseVersion(text: string): ParsedVersion | undefined {
	const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
	if (match === null) return undefined;
	return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3] ?? 0), text: match[0] };
}

/** The banner's first non-empty line, or `undefined`. */
function firstLine(text: string): string | undefined {
	return text.split("\n").find(line => line.trim().length > 0)?.trim();
}

/**
 * Run `<bin> --version` and describe the answer. `null` from the seam is a missing or
 * unresponsive binary; the two are one row because the operator's repair is the same.
 */
async function version(exec: Exec, bin: string, cwd: string): Promise<{ text: string; parsed: ParsedVersion | undefined } | null> {
	const result = await exec([bin, "--version"], { cwd, timeoutMs: VERSION_TIMEOUT_MS });
	if (result === null || result.code !== 0) return null;
	const banner = firstLine(result.stdout) ?? firstLine(result.stderr) ?? "";
	return { text: banner, parsed: parseVersion(banner) };
}

/** A binary the run cannot start without. */
async function requiredBinary(exec: Exec, bin: string, cwd: string, use: string): Promise<DoctorCheck> {
	const found = await version(exec, bin, cwd);
	if (found === null) return { name: bin, status: "fail", detail: `not found on PATH (or did not answer \`${bin} --version\`); ${use}` };
	return { name: bin, status: "pass", detail: found.parsed?.text ?? found.text };
}

/** A binary only a later step needs; absent, that step fails and the run can still start. */
async function optionalBinary(exec: Exec, bin: string, cwd: string, consumer: string): Promise<DoctorCheck> {
	const found = await version(exec, bin, cwd);
	if (found === null) return { name: bin, status: "warn", detail: `not found on PATH; ${consumer} fails without it` };
	return { name: bin, status: "pass", detail: found.parsed?.text ?? found.text };
}

async function checkBd(exec: Exec, cwd: string): Promise<DoctorCheck> {
	const bin = process.env.BD_BIN ?? "bd";
	const found = await version(exec, bin, cwd);
	if (found === null) return { name: "bd", status: "fail", detail: `${bin} not found on PATH (or did not answer \`--version\`); every claim, queue, and comment goes through it` };
	const need = `${MIN_BD_VERSION.major}.${MIN_BD_VERSION.minor}`;
	if (found.parsed === undefined) return { name: "bd", status: "warn", detail: `answered ${JSON.stringify(found.text)}, which names no version; ${need} or newer is needed` };
	const { major, minor, text } = found.parsed;
	const recent = major > MIN_BD_VERSION.major || (major === MIN_BD_VERSION.major && minor >= MIN_BD_VERSION.minor);
	if (!recent) return { name: "bd", status: "fail", detail: `${text} found; ${need} or newer is needed` };
	return { name: "bd", status: "pass", detail: bin === "bd" ? text : `${text} (${bin})` };
}

async function checkGh(exec: Exec, cwd: string): Promise<DoctorCheck> {
	const found = await version(exec, "gh", cwd);
	if (found === null) return { name: "gh", status: "fail", detail: "not found on PATH (or did not answer `gh --version`); the shepherd lands through it" };
	const label = found.parsed?.text ?? found.text;
	const auth = await exec(["gh", "auth", "status"], { cwd, timeoutMs: GH_TIMEOUT_MS });
	if (auth === null) return { name: "gh", status: "fail", detail: `${label}; \`gh auth status\` did not answer` };
	if (auth.code !== 0) {
		const reason = firstLine(auth.stderr) ?? firstLine(auth.stdout) ?? `exit ${auth.code}`;
		return { name: "gh", status: "fail", detail: `${label}, not authenticated (${reason}); run \`gh auth login\`` };
	}
	return { name: "gh", status: "pass", detail: `${label}, authenticated` };
}

/** Where the effective settings deviate from the overlay, one row; the repair is one command. */
function checkSettings(observed: Record<string, unknown> | null): DoctorCheck {
	const apply = `apply the shipped overlay: omp --config ${OVERLAY_FILE}`;
	if (observed === null) {
		return { name: "settings", status: "warn", detail: `the effective settings could not be read (no settings instance is live); ${apply}` };
	}
	const deviations = settingsDeviations(observed);
	return deviations.length === 0
		? { name: "settings", status: "pass", detail: "every required task and bash setting matches the overlay" }
		: {
			name: "settings",
			status: "fail",
			detail: `${deviations.map(item => `${item.key} is ${JSON.stringify(item.observed)}, needs ${item.want} (${item.consequence})`).join("; ")}; ${apply}`,
		};
}

/**
 * One row per model role the core agents name, in the order the agents declare them:
 * `plan` (architect), `task` (implementer, shepherd), `smol` (researcher), `reviewer`.
 *
 * A role that does not resolve fails the row, because the agent behind it cannot be
 * spawned; the roles in `DECLARED_MODEL_ROLES` are the documented optional ones, and warn
 * instead: the reviewer falls back to the session model. Resolution is asked of the live
 * model registry when the host hands one over; without it, the effective settings decide.
 * The campaign measured the old shape (`scratch/audit/e2e/normal-ts.ledger.md`, D-01/02):
 * a warn row for `reviewer` beside a `FAIL core agents` naming the same alias, and
 * `plan`/`task`/`smol` failing that row with no row of their own.
 */
function checkModelRoles(ctx: DoctorContext, observed: Record<string, unknown> | null): DoctorCheck[] {
	const agentsByRole: Record<string, string[]> = {};
	for (const [name, contract] of Object.entries(CORE_AGENT_CONTRACTS)) {
		const role = contract.modelAlias.slice(1);
		(agentsByRole[role] ??= []).push(name);
	}
	const settings = observed?.modelRoles;
	const resolve = typeof ctx.models?.resolve === "function" ? (spec: string) => ctx.models!.resolve(spec) : undefined;
	return Object.entries(agentsByRole).map(([role, agents]) => {
		const name = `modelRoles.${role}`;
		const unresolved: CheckStatus = DECLARED_MODEL_ROLES.includes(role) ? "warn" : "fail";
		const consequence = unresolved === "fail" ? `${agents.join(", ")} cannot be spawned` : `${agents.join(", ")} falls back to the session model`;
		const configured = typeof settings === "object" && settings !== null && Object.hasOwn(settings, role) ? (settings as Record<string, unknown>)[role] : undefined;
		if (resolve !== undefined) {
			const model = resolve(`@${role}`);
			if (model === undefined) return { name, status: unresolved, detail: `@${role} does not resolve; ${consequence}; set modelRoles.${role} in the overlay or your config` };
			const id = typeof model === "object" && model !== null && "id" in model && typeof model.id === "string" ? model.id : JSON.stringify(model);
			return { name, status: "pass", detail: `@${role} resolves to ${id}` };
		}
		if (configured === undefined) return { name, status: unresolved, detail: `not configured, and no model registry is live to resolve @${role}; ${consequence}; set modelRoles.${role} in the overlay or your config` };
		return { name, status: "pass", detail: typeof configured === "string" ? configured : JSON.stringify(configured) };
	});
}

async function checkOverlay(): Promise<DoctorCheck> {
	try {
		await fs.access(OVERLAY_FILE);
		return { name: "overlay", status: "pass", detail: `omp --config ${OVERLAY_FILE}` };
	} catch {
		return { name: "overlay", status: "fail", detail: `${OVERLAY_FILE} is missing; the installed package is incomplete, reinstall the plugin` };
	}
}

/**
 * Core agents fail the row; each borrowed package is its own warn row. A core agent's
 * model alias not resolving is the alias's row (`checkModelRoles`), not this one, so an
 * optional role stays the warning the README promises.
 */
async function checkAgents(ctx: DoctorContext): Promise<DoctorCheck[]> {
	const borrowed = Object.values(PLUGIN_AGENTS_BY_PACKAGE).flat();
	let findings: AgentDiscoveryFinding[];
	try {
		findings = await discoverAgentFindings(ctx, borrowed);
	} catch (error) {
		return [{ name: "agents", status: "fail", detail: `agent discovery failed: ${error instanceof Error ? error.message : String(error)}` }];
	}
	const byAgent = new Map<string, string[]>();
	for (const finding of findings) {
		if (Object.hasOwn(CORE_AGENT_CONTRACTS, finding.agent) && /^model alias "@[^"]+" does not resolve$/.test(finding.message)) continue;
		const list = byAgent.get(finding.agent) ?? [];
		list.push(finding.path === undefined ? finding.message : `${finding.message} (${finding.path})`);
		byAgent.set(finding.agent, list);
	}
	const core = Object.keys(CORE_AGENT_CONTRACTS).filter(name => byAgent.has(name));
	const rows: DoctorCheck[] = [
		core.length === 0
			? { name: "core agents", status: "pass", detail: `${Object.keys(CORE_AGENT_CONTRACTS).join(", ")} discoverable with their model aliases` }
			: { name: "core agents", status: "fail", detail: core.map(name => `${name}: ${byAgent.get(name)!.join("; ")}`).join(" | ") },
	];
	for (const [pkg, names] of Object.entries(PLUGIN_AGENTS_BY_PACKAGE)) {
		const missing = names.filter(name => byAgent.has(name));
		rows.push(
			missing.length === 0
				? { name: `plugin ${pkg}`, status: "pass", detail: `${names.join(", ")} discoverable` }
				: { name: `plugin ${pkg}`, status: "warn", detail: `${missing.join(", ")} not discoverable; the architect grants the name but a spawn of it fails until the package is installed` },
		);
	}
	return rows;
}

/** The store `bd where` resolves for this checkout, and what the probe says about it. */
async function checkStore(cwd: string): Promise<DoctorCheck> {
	const beads = await locateBeadsDir(cwd);
	if (!beads.ok) return { name: "beads store", status: "fail", detail: `${beads.reason}; \`bd init\` creates one` };
	try {
		const probe = await probeStore(beads.beadsDir);
		switch (probe.state) {
			case "free": return { name: "beads store", status: "pass", detail: `${beads.beadsDir} free (${probe.ms} ms)` };
			case "slow": return { name: "beads store", status: "warn", detail: `${beads.beadsDir} answered in ${probe.ms} ms; claims and sweeps will be slow` };
			case "locked": return { name: "beads store", status: "fail", detail: `${beads.beadsDir} locked by ${probe.holder}` };
			case "corrupted": return { name: "beads store", status: "fail", detail: `${beads.beadsDir} corrupted: ${probe.detail}` };
		}
	} catch (error) {
		return { name: "beads store", status: "fail", detail: error instanceof Error ? error.message : String(error) };
	}
}

/** The repository this checkout answers to, and what GitHub lets the sweep do there. */
async function checkLanding(exec: Exec, cwd: string): Promise<DoctorCheck> {
	const view = await exec(["gh", "repo", "view", "--json", "nameWithOwner,defaultBranchRef"], { cwd, timeoutMs: GH_TIMEOUT_MS });
	if (view === null || view.code !== 0) {
		const reason = view === null ? "gh did not answer" : firstLine(view.stderr) ?? `exit ${view.code}`;
		return { name: "landing", status: "fail", detail: `gh repo view failed (${reason}); the sweep cannot land without a GitHub repository` };
	}
	let repo: string | undefined;
	let base: string | undefined;
	try {
		const parsed: unknown = JSON.parse(view.stdout);
		if (typeof parsed === "object" && parsed !== null) {
			const record = parsed as Record<string, unknown>;
			if (typeof record.nameWithOwner === "string") repo = record.nameWithOwner;
			const ref = record.defaultBranchRef;
			if (typeof ref === "object" && ref !== null && typeof (ref as Record<string, unknown>).name === "string") base = (ref as Record<string, string>).name;
		}
	} catch {
		return { name: "landing", status: "fail", detail: "gh repo view returned no JSON" };
	}
	if (repo === undefined || base === undefined) return { name: "landing", status: "fail", detail: "gh repo view named no repository or default branch" };
	const probe = await probeLandingCapabilities(repo, base, exec, cwd);
	if (!probe.ok) return { name: "landing", status: "fail", detail: `${repo}: ${probe.error}` };
	const { caps } = probe;
	const summary = `${repo} (${base}): mode ${caps.mode}, auto-merge ${caps.auto_merge_allowed ? "on" : "off"}, squash ${caps.squash_allowed ? "on" : "off"}, required checks ${caps.required_checks.length === 0 ? "none" : caps.required_checks.join(", ")}`;
	if (!caps.squash_allowed) return { name: "landing", status: "warn", detail: `${summary}; the sweep will not merge until squash merges are enabled` };
	return { name: "landing", status: "pass", detail: summary };
}

/** The whole report. Independent checks run together; the rows keep a fixed order. */
export async function runDoctor(ctx: DoctorContext, exec: Exec = spawnExec): Promise<DoctorReport> {
	const cwd = ctx.cwd;
	const [bd, wt, git, gh, bun, overlay, agents, store, landing] = await Promise.all([
		checkBd(exec, cwd),
		requiredBinary(exec, "wt", cwd, "every architect and worker tree is a Worktrunk checkout"),
		requiredBinary(exec, "git", cwd, "every capture and integration step is a git operation"),
		checkGh(exec, cwd),
		// `omp` itself runs on bun, but its launcher may reach a bundled copy that is not on PATH.
		optionalBinary(exec, "bun", cwd, "skills/orchestrate/scripts/worktree-sweep.ts at run end"),
		checkOverlay(),
		checkAgents(ctx),
		checkStore(cwd),
		checkLanding(exec, cwd),
	]);
	const observed = readSettings();
	const checks = [bd, wt, git, gh, bun, overlay, checkSettings(observed), ...checkModelRoles(ctx, observed), ...agents, store, landing];
	return { ok: checks.every(check => check.status !== "fail"), checks };
}

/** One line per row, aligned, the verdict first. */
export function renderDoctor(report: DoctorReport): string {
	const width = Math.max(...report.checks.map(check => check.name.length));
	const lines = report.checks.map(check => `${check.status.toUpperCase().padEnd(4)} ${check.name.padEnd(width)}  ${check.detail}`);
	const fails = report.checks.filter(check => check.status === "fail").length;
	const warns = report.checks.filter(check => check.status === "warn").length;
	lines.unshift(report.ok ? `doctor: ok (${warns} warning${warns === 1 ? "" : "s"})` : `doctor: ${fails} failing check${fails === 1 ? "" : "s"}, ${warns} warning${warns === 1 ? "" : "s"}`);
	return lines.join("\n");
}

const DESCRIPTION = [
	"Report the run prerequisites with pass/warn/fail rows: bd (1.2 or newer), wt, git, gh and its",
	"authentication, bun for the worktree sweep, the shipped settings overlay, the required task and",
	"bash settings, one row per model role (plan, task, smol must resolve; reviewer warns), the core and borrowed agents, the beads store probe,",
	"and the repository's landing capabilities. Reads only; never writes a file, a bead, or a",
	"setting. Call it before /orchestrate-start, or when a run misbehaves.",
].join(" ");

/** Register `orc_doctor` and `/orchestrate-doctor`. The orchestrator wires this from `src/index.ts`. */
export function registerDoctor(pi: ExtensionAPI): void {
	// Agent discovery reads the extension roots from the async scope that was live at
	// registration; a command or tool call runs after that scope has ended.
	const runInDiscoveryScope = AsyncLocalStorage.snapshot();
	pi.registerTool({
		name: "orc_doctor",
		label: "Doctor",
		description: DESCRIPTION,
		approval: "read",
		parameters: pi.zod.object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx): Promise<AgentToolResult<DoctorReport>> {
			try {
				const report = await runInDiscoveryScope(() => runDoctor(ctx));
				return { content: [{ type: "text" as const, text: renderDoctor(report) }], details: report, isError: !report.ok };
			} catch (error) {
				const report: DoctorReport = { ok: false, checks: [{ name: "doctor", status: "fail", detail: `the report could not be built: ${String(error)}` }] };
				return { content: [{ type: "text" as const, text: renderDoctor(report) }], details: report, isError: true };
			}
		},
	});
	pi.registerCommand("orchestrate-doctor", {
		description: "Check the run prerequisites: tools, settings, agents, store, landing",
		handler: async (_args, ctx) => {
			const report = await runInDiscoveryScope(() => runDoctor(ctx));
			const level = report.ok ? (report.checks.some(check => check.status === "warn") ? "warning" : "info") : "error";
			ctx.ui.notify(renderDoctor(report), level);
		},
	});
}
