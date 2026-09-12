/**
 * The one place that shells out to `bd`.
 *
 * Gates never assemble `bd` argv themselves, so the JSON-envelope handling, the
 * timeout, the per-dispatch read budget, and the read cache live in exactly one file.
 *
 * **Nothing here throws.** A throw inside a `tool_call` handler blocks the tool it
 * was inspecting (`extensibility/extensions/wrapper.ts:237` turns any handler
 * exception into a block), so a missing `bd` binary or a malformed payload would
 * brick every tool in the session rather than degrading. Every failure resolves to
 * `null` or an empty list, and each gate decides what an unknown answer means --
 * uniformly, fail open. What the gate cannot see from `null` alone is *why*, so the
 * kind of the failure is recorded alongside ({@link lastBdFailure}) for the refusal
 * or log line that names it.
 *
 * **The read cache.** Every `bd` spawn costs 0.4-1.2 s of engine bootstrap whatever it
 * asks, so reads are served from a process-wide cache validated by a token derived from
 * the store itself ({@link storeToken}): the embedded Dolt journal's inode and size, and
 * the manifest's lock and root hashes. Every mutation appends to the journal and moves
 * the root before the writing `bd` exits; no read moves either. The token therefore
 * changes on every write by anyone -- this process, a worker, a human shell, a `wt`
 * hook -- and on nothing else, and a cached answer is served only while the token it
 * was read under still holds. The invariants, stated so a change can be checked against
 * them:
 *
 * - I1, write visibility: a mutation changes the token before the mutating `bd` exits.
 * - I2, read silence: no read-only `bd` command changes the token.
 * - I3, validity: an entry is served only if the token captured before its spawn began
 *   equals the token now; then no write completed in between, so the entry is as fresh
 *   as a spawn issued now.
 * - I4, capture order: the token is read before the spawn, never after; this process's
 *   own writes through {@link bdRun} also drop the cache outright.
 * - I5, equality, not order: any difference invalidates, including a smaller journal, a
 *   new inode, or a rewritten manifest lock (GC, conjoin, journal repair, `bd dolt pull`).
 * - I6, scope: the store is the one the active-run marker names; no marker, a
 *   non-embedded store, or unreadable files means nothing is cached.
 * - I7, no negative caching: failures, non-zero exits, and empty answers are never stored.
 *
 * There is no time-based expiry anywhere. A cached value is shared by every reader and
 * must be treated as immutable; {@link asBead} is the one normaliser and is idempotent.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { markerPath } from "./run-state";

/** A bead as the gates need it. Extra fields pass through untouched. */
export interface BdBead {
 id: string;
 status?: string;
 assignee?: string;
 labels?: string[];
 metadata?: Record<string, unknown>;
 spec_id?: string;
 updated_at?: string;
 [key: string]: unknown;
}

export interface BdComment {
 text: string;
 author?: string;
}

export interface BdResult {
 code: number;
 stdout: string;
 stderr: string;
}

/** Env every invocation sets, so output is parseable and never blocks on a pager. */
const BD_ENV: Record<string, string> = {
 BD_JSON_ENVELOPE: "1",
 BD_NO_PAGER: "1",
 BD_NON_INTERACTIVE: "1",
};

const DEFAULT_TIMEOUT_MS = 10_000;
const OPERATION_TIMEOUT_MS = 20_000;

/**
 * Spawned reads allowed per dispatch, mirroring `rules-eval.py`'s `BD_READ_BUDGET = 12`.
 *
 * A gate chain hydrates a bead, its lineage, and the in-flight list on every gated
 * tool call, so an unbounded chain can issue dozens of subprocess calls while the
 * model waits. The budget caps that; exhausting it degrades to fail open, which is
 * the same outcome as `bd` being unavailable -- and is recorded as `"budget"` so the
 * caller can tell the two apart. Cache hits spend nothing, so the cap is a ceiling on
 * miss storms rather than the cost of a call.
 */
const READ_BUDGET = 12;

/**
 * Why the most recent `bd` call in this dispatch answered nothing.
 *
 * - `unavailable`: `bd` could not be spawned (missing binary, spawn failure).
 * - `timeout`: killed at its own timeout or the dispatch deadline, or skipped because
 *   an earlier call in the dispatch already timed out.
 * - `budget`: refused because the dispatch's read cap is spent.
 * - `missing`: `bd` exited 0 but the payload carried no usable answer -- no such
 *   bead, or a shape the reader does not accept.
 * - `exit`: `bd` ran and exited non-zero.
 */
export type BdFailure = "unavailable" | "timeout" | "budget" | "missing" | "exit";

interface ReadBudget {
 readsUsed: number;
 /** Reads this dispatch may spend before further reads are refused. */
 reads: number;
 timedOut: boolean;
 deadline: number;
 /** Set once a read has been refused for the cap. */
 exhausted: boolean;
 /** Cleared at the start of every call, so it describes the most recent one. */
 lastFailure: BdFailure | undefined;
}

const readBudget = new AsyncLocalStorage<ReadBudget>();

/**
 * Start a fresh budget for this async operation and its descendants.
 *
 * `reads` is the count cap; the 20 s deadline applies regardless. The default is the
 * per-tool-call cap; a dispatch that runs once per session rather than once per tool
 * call may pass a larger one.
 */
export function resetReadBudget(reads = READ_BUDGET): void {
 readBudget.enterWith({
  readsUsed: 0,
  reads,
  timedOut: false,
  deadline: performance.now() + OPERATION_TIMEOUT_MS,
  exhausted: false,
  lastFailure: undefined,
 });
}

/** Why the most recent `bd` call in this dispatch failed; `undefined` when it succeeded, or no budget is active. */
export function lastBdFailure(): BdFailure | undefined {
 return readBudget.getStore()?.lastFailure;
}

/** Whether this dispatch has refused a read for exceeding its cap. */
export function readBudgetExhausted(): boolean {
 return readBudget.getStore()?.exhausted === true;
}

const FAILURE_TEXT: Record<BdFailure, string> = {
 unavailable: "bd could not be run",
 timeout: "the beads database did not answer in time; retry",
 budget: "this call's bd read budget is spent; retry",
 missing: "bd returned no such bead",
 exit: "bd exited with an error",
};

/** The failure kind as the prose a refusal quotes. */
export function bdFailureText(kind: BdFailure | undefined): string {
 return kind === undefined ? "the bead could not be read" : FAILURE_TEXT[kind];
}

/** Record why a call answered nothing, and hand back that nothing. */
function fail<T>(kind: BdFailure, value: T): T {
 const budget = readBudget.getStore();
 if (budget) budget.lastFailure = kind;
 return value;
}

/** A hit is a successful read: it clears the failure the previous call may have left. */
function succeed(): void {
 const budget = readBudget.getStore();
 if (budget) budget.lastFailure = undefined;
}

// ============================================================================
// The store token and the cache it validates
// ============================================================================

/** Dolt's constant chunk-journal file name (`journalAddr`, `go/store/nbs/journal.go`). */
const JOURNAL_FILE = "vvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv";

/**
 * The token of an embedded store: `<journal ino>:<journal size>|<manifest lock>:<manifest root>`.
 *
 * `beadsDir` is the `.beads` directory; its `metadata.json` names the mode and the
 * database, and the journal and manifest sit under
 * `embeddeddolt/<database>/.dolt/noms/`. The journal gains a root-hash record on every
 * mutation and the manifest's `lock:root` fields (the third and fourth colon-separated
 * fields of a version-5 manifest) move with it, while `bd`'s reads leave the journal's
 * size and the manifest's text alone: they rewrite the manifest file (new inode, same
 * bytes) and touch mtimes, which is why neither inode nor mtime of the manifest is read.
 *
 * `undefined` for a non-embedded store, a store without a journal, or any read error;
 * the caller caches nothing then. Costs three system calls, roughly 0.1 ms.
 */
export function storeToken(beadsDir: string): string | undefined {
 try {
  const metadata = metadataRecord(JSON.parse(readFileSync(path.join(beadsDir, "metadata.json"), "utf8")));
  if (metadata?.dolt_mode !== "embedded") return undefined;
  const database = metadata.dolt_database;
  if (typeof database !== "string" || database.length === 0) return undefined;
  const noms = path.join(beadsDir, "embeddeddolt", database, ".dolt", "noms");
  const { ino, size } = statSync(path.join(noms, JOURNAL_FILE));
  const manifest = readFileSync(path.join(noms, "manifest"), "utf8").split(":");
  if (manifest.length < 4) return undefined;
  return `${ino}:${size}|${manifest[2]}:${manifest[3]}`;
 } catch {
  return undefined;
 }
}

/**
 * The `.beads` directory the active-run marker at `cwd` names, or `undefined`.
 *
 * The marker is the product's declaration of the run's store: activation writes its
 * canonical path as `beads_dir`, every worker clone carries a copy, and the clone's
 * `.beads/redirect` makes `bd` resolve the same store from any directory of the run. A
 * marker without the field -- written before the field existed, or a bare run id --
 * means the store is not known here, and nothing is cached. Read synchronously so a
 * lookup adds no turn to the spawn it may save.
 */
function runStoreDir(cwd: string | undefined): string | undefined {
 let marker: unknown;
 try {
  marker = JSON.parse(readFileSync(markerPath(cwd ?? process.cwd()), "utf8"));
 } catch {
  return undefined;
 }
 const dir = metadataRecord(marker)?.beads_dir;
 return typeof dir === "string" && path.isAbsolute(dir) ? dir : undefined;
}

/**
 * Everything cached under one token. `payloads` is keyed by argv; `beads` by id, fed by
 * `show` and `list --id` alike so either read serves the other.
 */
interface Generation {
 dir: string;
 token: string;
 payloads: Map<string, unknown>;
 beads: Map<string, BdBead>;
}

/**
 * The one live generation. A process talks to one store, so one generation bounds the
 * cache to a snapshot's worth of payloads; a different store or a moved token replaces
 * it wholesale.
 */
let live: Generation | undefined;

/** The generation reads at `cwd` may use, or `undefined` when nothing may be cached (I6). */
function generationFor(cwd: string | undefined): Generation | undefined {
 const dir = runStoreDir(cwd);
 if (dir === undefined) return undefined;
 const token = storeToken(dir);
 if (token === undefined) return undefined;
 if (live === undefined || live.dir !== dir || live.token !== token) {
  live = { dir, token, payloads: new Map(), beads: new Map() };
 }
 return live;
}

// ============================================================================
// Spawning
// ============================================================================

/**
 * Run `bd` and capture its result, or `null` when it could not run at all.
 *
 * `cwd` defaults to the process's, which is the session's repository for every
 * in-session caller. It is explicit for callers that already hold a repository
 * path and may not be running inside it: `bd` resolves its database by walking up
 * from the working directory, so an inherited cwd silently writes to a different
 * run's beads.
 *
 * Every call through here may write, so it drops the read cache first (I4). Reads take
 * {@link readJson}, which keeps it.
 */
export async function bdRun(
 args: string[],
 timeoutMs = DEFAULT_TIMEOUT_MS,
 cwd?: string,
): Promise<BdResult | null> {
 live = undefined;
 return await spawnBd(args, timeoutMs, cwd);
}

async function spawnBd(args: string[], timeoutMs: number, cwd: string | undefined): Promise<BdResult | null> {
 // An earlier call in this dispatch already waited out the full timeout. What is
 // unresponsive is the database, not the argv, so this call would spend the same wait to
 // learn the same thing -- and the caller already treats an unknown answer as permission
 // to proceed.
 const budget = readBudget.getStore();
 if (budget) budget.lastFailure = undefined;
 if (budget?.timedOut) return fail("timeout", null);
 const remainingMs = budget ? budget.deadline - performance.now() : timeoutMs;
 if (remainingMs <= 0) return fail("timeout", null);
 const bin = process.env.BD_BIN ?? "bd";
 try {
  const proc = Bun.spawn([bin, ...args], {
   ...(cwd === undefined ? {} : { cwd }),
   env: { ...process.env, ...BD_ENV },
   stdout: "pipe",
   stderr: "pipe",
  });

  let killed = false;
  const timer = setTimeout(() => {
   killed = true;
   if (budget) budget.timedOut = true;
   proc.kill();
  }, Math.min(timeoutMs, remainingMs));
  try {
   const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
   ]);
   // A killed process still resolves, carrying whatever the kill left behind. Handing
   // that back would let a gate read a truncated stdout or a signal's exit code as
   // bd's answer, so a timeout reports the unknown it actually is.
   if (killed || (budget && performance.now() >= budget.deadline)) return fail("timeout", null);
   return { code, stdout, stderr };
  } finally {
   clearTimeout(timer);
  }
 } catch {
  // Missing binary or spawn failure. The caller treats an unknown answer as
  // permission to proceed.
  return fail("unavailable", null);
 }
}

/**
 * Parse a `bd --json` payload, unwrapping the `{ schema_version, data }` envelope
 * when present. `BD_JSON_ENVELOPE=1` asks for the envelope, but fixtures and older
 * subcommands emit a bare value, so both shapes are accepted.
 *
 * `bd` may print a warning line before the payload (a cold server, a redirect target it
 * could not follow), so parsing starts at the first brace or bracket rather than byte 0.
 * `undefined` when there is no JSON value there; a bare `null` is folded into that,
 * because no read answers `null` and means something by it.
 */
function parsePayload(stdout: string): unknown {
 const starts = [stdout.indexOf("{"), stdout.indexOf("[")].filter(index => index !== -1);
 if (starts.length === 0) return undefined;
 try {
  const parsed: unknown = JSON.parse(stdout.slice(Math.min(...starts)));
  if (parsed !== null && typeof parsed === "object" && "schema_version" in parsed && "data" in parsed) {
   return parsed.data ?? undefined;
  }
  return parsed ?? undefined;
 } catch {
  return undefined;
 }
}

/**
 * Run a read and return its parsed payload, from the cache when the token holds.
 *
 * A hit spends no budget and clears the recorded failure. A miss spawns, and a payload
 * that parsed from a zero exit is stored under the generation the caller resolved
 * before the spawn began (I4); a generation replaced meanwhile is simply garbage.
 * Nothing else is stored (I7).
 */
async function readJson(
 args: string[],
 timeoutMs: number,
 cwd: string | undefined,
 generation: Generation | undefined,
): Promise<unknown> {
 const key = args.join("\u0000");
 const hit = generation?.payloads.get(key);
 if (hit !== undefined) {
  succeed();
  return hit;
 }
 const budget = readBudget.getStore();
 if (budget && budget.readsUsed++ >= budget.reads) {
  budget.exhausted = true;
  return fail("budget", undefined);
 }
 const result = await spawnBd(args, timeoutMs, cwd);
 if (!result) return undefined;
 if (result.code !== 0) return fail("exit", undefined);
 const payload = parsePayload(result.stdout);
 if (payload === undefined) return fail("missing", undefined);
 generation?.payloads.set(key, payload);
 return payload;
}

export function metadataRecord(raw: unknown): Record<string, unknown> | undefined {
 if (typeof raw === "string") {
  try {
   raw = JSON.parse(raw);
  } catch {
   return undefined;
  }
 }
 return raw !== null && typeof raw === "object" && !Array.isArray(raw)
  ? raw as Record<string, unknown>
  : undefined;
}

function asBead(value: unknown): BdBead | null {
 if (value === null || typeof value !== "object") return null;
 if (!("id" in value) || typeof value.id !== "string") return null;
 // Checked above: `value` is an object whose `id` is a string, which is the only
 // field the gates require. Every other field stays optional on BdBead.
 const bead = value as BdBead;
 if ("metadata" in bead) {
  const metadata = metadataRecord(bead.metadata);
  if (metadata === undefined) delete bead.metadata;
  else bead.metadata = metadata;
 }
 return bead;
}

/** Read options. `fresh` bypasses the cache in both directions: nothing served, nothing stored. */
export interface BdReadOptions {
 fresh?: boolean;
}

/**
 * One bead by id, or `null` when it does not exist or could not be read.
 *
 * `bd show --json` returns a single-element array, so both an array and a bare
 * object are accepted. Answered from the live generation when any read under the
 * current token already carried the bead; see {@link Generation.beads}.
 *
 * A `fresh` read spawns unconditionally and stores nothing. The token already makes a
 * cached bead as current as a spawn issued now (I3); the lease-expiry decision in
 * `src/lease.ts` asks for a spawn regardless, so that a release is never argued from a
 * cached snapshot whatever the token says about it. One spawn per dead child.
 */
export async function bdShow(id: string, timeoutMs = DEFAULT_TIMEOUT_MS, cwd?: string, options: BdReadOptions = {}): Promise<BdBead | null> {
 const generation = options.fresh ? undefined : generationFor(cwd);
 const known = generation?.beads.get(id);
 if (known !== undefined) {
  succeed();
  return known;
 }
 const payload = await readJson(["show", id, "--json"], timeoutMs, cwd, generation);
 if (payload === undefined) return null;
 const bead = asBead(Array.isArray(payload) ? payload[0] : payload);
 if (bead === null) return fail("missing", null);
 generation?.beads.set(id, bead);
 return bead;
}

/**
 * Several beads by id in one read, keyed by id, or `null` when the read failed.
 *
 * `bd list --id` takes the ids comma-joined; `--status all` keeps closed beads and
 * `--include-infra` keeps ephemeral wisps, both of which plain `bd list` hides
 * (measured on bd 1.2.2). Ids the live generation already holds are served from it and
 * left out of the query; every bead read is kept for later `show`s under the same
 * token. An id absent from the result is absent from the map: the caller decides what
 * an unresolvable link means.
 */
export async function bdShowMany(ids: readonly string[], timeoutMs = DEFAULT_TIMEOUT_MS, cwd?: string): Promise<Map<string, BdBead> | null> {
 const generation = generationFor(cwd);
 const beads = new Map<string, BdBead>();
 const unread: string[] = [];
 for (const id of ids) {
  const known = generation?.beads.get(id);
  if (known !== undefined) beads.set(id, known);
  else if (!unread.includes(id)) unread.push(id);
 }
 if (unread.length === 0) {
  succeed();
  return beads;
 }
 const rows = await listChecked(
  ["list", "--id", unread.join(","), "--status", "all", "--include-infra", "--include-gates", "--limit", "0", "--json"],
  timeoutMs,
  cwd,
  generation,
 );
 if (rows === null) return null;
 for (const row of rows) {
  beads.set(row.id, row);
  generation?.beads.set(row.id, row);
 }
 return beads;
}

/** Beads matching a caller-supplied query. The caller passes its own `--json`. */
export async function bdList(args: string[], timeoutMs = DEFAULT_TIMEOUT_MS, cwd?: string): Promise<BdBead[]> {
 return (await bdListChecked(args, timeoutMs, cwd)) ?? [];
}

function asBeadArray(payload: unknown): BdBead[] | null {
 if (!Array.isArray(payload)) return null;
 const beads: BdBead[] = [];
 for (const entry of payload) {
  const bead = asBead(entry);
  if (!bead) return null;
  beads.push(bead);
 }
 return beads;
}

export async function bdListChecked(args: string[], timeoutMs = DEFAULT_TIMEOUT_MS, cwd?: string): Promise<BdBead[] | null> {
 return await listChecked(args, timeoutMs, cwd, generationFor(cwd));
}

async function listChecked(args: string[], timeoutMs: number, cwd: string | undefined, generation: Generation | undefined): Promise<BdBead[] | null> {
 const payload = await readJson(args, timeoutMs, cwd, generation);
 if (payload === undefined) return null;
 const beads = asBeadArray(payload);
 return beads === null ? fail("missing", null) : beads;
}

/**
 * Ids `bd blocked --json` reports, or `null` when the read failed or the payload was
 * malformed. An empty list is a real answer: nothing is blocked. `bd` emits one object
 * per blocked bead, each carrying `id`; a lone object is accepted as a list of one.
 */
export async function bdBlockedChecked(timeoutMs = DEFAULT_TIMEOUT_MS, cwd?: string): Promise<string[] | null> {
 const payload = await readJson(["blocked", "--json"], timeoutMs, cwd, generationFor(cwd));
 if (payload === undefined) return null;
 const ids: string[] = [];
 for (const entry of Array.isArray(payload) ? payload : [payload]) {
  if (entry === null || typeof entry !== "object") return fail("missing", null);
  const id = (entry as Record<string, unknown>).id;
  if (typeof id !== "string" || id.length === 0) return fail("missing", null);
  ids.push(id);
 }
 return ids;
}

/**
 * The cycles `bd dep cycles --json` reports, each as the ids it visits in edge order, or
 * `null` when the read failed or the payload was malformed. An empty list is a real
 * answer: the blocking graph is acyclic. bd 1.2 prints each cycle as an array of the
 * beads on it; later builds print `{ members: [{ id, issue? }], partial }` so a member
 * with no row keeps its place. Both shapes are read.
 */
export async function bdCyclesChecked(timeoutMs = DEFAULT_TIMEOUT_MS, cwd?: string): Promise<string[][] | null> {
 const payload = await readJson(["dep", "cycles", "--json"], timeoutMs, cwd, generationFor(cwd));
 if (payload === undefined) return null;
 if (!Array.isArray(payload)) return fail("missing", null);
 const cycles: string[][] = [];
 for (const cycle of payload) {
  const members: unknown = Array.isArray(cycle) ? cycle : cycle !== null && typeof cycle === "object" && "members" in cycle ? cycle.members : undefined;
  if (!Array.isArray(members)) return fail("missing", null);
  const ids: string[] = [];
  for (const member of members) {
   if (member === null || typeof member !== "object" || !("id" in member) || typeof member.id !== "string" || member.id.length === 0) {
    return fail("missing", null);
   }
   ids.push(member.id);
  }
  cycles.push(ids);
 }
 return cycles;
}

/** Comments on a bead, oldest first as `bd` returns them. */
export async function bdComments(id: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<BdComment[]> {
 return (await bdCommentsChecked(id, timeoutMs)) ?? [];
}

export async function bdCommentsChecked(id: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<BdComment[] | null> {
 const payload = await readJson(["comments", id, "--json"], timeoutMs, undefined, generationFor(undefined));
 if (payload === undefined) return null;
 if (!Array.isArray(payload)) return fail("missing", null);
 const comments: BdComment[] = [];
 for (const entry of payload) {
  if (entry === null || typeof entry !== "object") return fail("missing", null);
  // `text` is the documented field; `body` and `comment` appear in older
  // payloads and fixtures, so accept any of them rather than silently
  // evaluating a contract against zero comments.
  let text: unknown;
  if ("text" in entry) text = entry.text;
  else if ("body" in entry) text = entry.body;
  else if ("comment" in entry) text = entry.comment;
  if (typeof text !== "string") return fail("missing", null);
  const author = "author" in entry && typeof entry.author === "string" ? entry.author : undefined;
  comments.push(author === undefined ? { text } : { text, author });
 }
 return comments;
}

/** Linked dependents of a node. */
export async function bdLinked(id: string, type: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string[]> {
 return (await bdLinkedChecked(id, type, timeoutMs)) ?? [];
}

export async function bdLinkedChecked(
 id: string,
 type: string,
 timeoutMs = DEFAULT_TIMEOUT_MS,
 direction: "up" | "down" = "up",
): Promise<string[] | null> {
 const payload = await readJson(["dep", "list", id, `--direction=${direction}`, "--type", type, "--json"], timeoutMs, undefined, generationFor(undefined));
 if (payload === undefined) return null;
 if (!Array.isArray(payload)) return fail("missing", null);
 const linked: string[] = [];
 for (const entry of payload) {
  if (entry === null || typeof entry !== "object") return fail("missing", null);
  let endpoint: unknown;
  if ("issue_id" in entry || "depends_on_id" in entry) {
   const source = "issue_id" in entry ? entry.issue_id : undefined;
   const target = "depends_on_id" in entry ? entry.depends_on_id : undefined;
   if ((direction === "up" ? target : source) !== id) return fail("missing", null);
   endpoint = direction === "up" ? source : target;
  } else {
   endpoint = "id" in entry ? entry.id : undefined;
  }
  if (typeof endpoint !== "string" || endpoint.length === 0 || /\s/.test(endpoint) || endpoint === id) return fail("missing", null);
  if (!linked.includes(endpoint)) linked.push(endpoint);
 }
 return linked;
}

/**
 * The bead this actor currently holds, or `null` when it holds none.
 *
 * Picks the most recently updated candidate, matching `rules-eval.py`'s
 * `max((updated_at, id))` tie-break, so a stale claim never shadows a live one.
 */
export async function claimedBead(actor: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<BdBead | null> {
 if (actor.length === 0) return null;
 const candidates = await bdList(
  ["list", "--include-infra", "--assignee", actor, "--status", "open,in_progress,blocked", "--json"],
  timeoutMs,
 );
 let best: BdBead | null = null;
 for (const bead of candidates) {
  if (!best) {
   best = bead;
   continue;
  }
  const a = `${bead.updated_at ?? ""}\u0000${bead.id}`;
  const b = `${best.updated_at ?? ""}\u0000${best.id}`;
  if (a > b) best = bead;
 }
 return best;
}

/** A metadata value as a string, or `undefined` when absent or not a string. */
export function metadataString(bead: { metadata?: unknown } | null, key: string): string | undefined {
 const metadata = metadataRecord(bead?.metadata);
 const value = metadata && Object.hasOwn(metadata, key) ? metadata[key] : undefined;
 return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The leading verb of a comment, normalised so an honest comment in ordinary
 * markdown parses.
 *
 * Four steps, in order. One: strip a leading run of whitespace and of bullet,
 * blockquote, emphasis, tick and strikethrough characters. Two: take the first
 * whitespace-delimited token. Three: strip trailing emphasis, ticks and sentence
 * punctuation. Four: uppercase. So `**REVIEW**`, `- REVIEW`, `REVIEW,` and `> review`
 * all yield `REVIEW`.
 *
 * Step one cannot cross a word, because every verb and every word starts outside that
 * run. The first token therefore stays the whole signal: `the REVIEW is done` yields
 * `THE`, never `REVIEW`. That is what lets supervision tell an absent verb from a
 * malformed one instead of harvesting verbs out of prose.
 *
 * `NO WORK` yields `NO`, deliberately. Reading two tokens would make this the only
 * verb assembled from two, and `src/gates/exit.ts` already gates a claimless exit on
 * the literal `NO_WORK`, so leniency here would only move the divergence. The writer
 * is told instead: `commentVerbNotice` (`src/gates/bd.ts`) nags exactly the forms this
 * function rejects, and nothing else. Guard and parser share one normalisation.
 *
 * Diverges from `rules-eval.py`, which took the raw first token minus one trailing
 * colon. That parse read `**REVIEW**` as a non-verb and failed the contract in
 * silence, and the Python is no longer in this repository to mirror.
 */
export function commentVerb(text: string): string {
 const token = /^[\s\-*+>`_~]*(\S*)/.exec(text)?.[1] ?? "";
 return token.replace(/[*_`~:,.;!?]+$/, "").toUpperCase();
}
