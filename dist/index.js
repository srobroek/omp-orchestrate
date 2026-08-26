// @bun
// src/bd.ts
var BD_ENV = {
  BD_JSON_ENVELOPE: "1",
  BD_NO_PAGER: "1",
  BD_NON_INTERACTIVE: "1"
};
var DEFAULT_TIMEOUT_MS = 1e4;
var READ_BUDGET = 12;
var readsUsed = 0;
function resetReadBudget() {
  readsUsed = 0;
}
async function bdRun(args, timeoutMs = DEFAULT_TIMEOUT_MS, cwd) {
  const bin = process.env.BD_BIN ?? "bd";
  try {
    const proc = Bun.spawn([bin, ...args], {
      ...cwd === undefined ? {} : { cwd },
      env: { ...process.env, ...BD_ENV },
      stdout: "pipe",
      stderr: "pipe"
    });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited
      ]);
      return { code, stdout, stderr };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}
function parsePayload(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    if (parsed !== null && typeof parsed === "object" && "schema_version" in parsed && "data" in parsed) {
      return parsed.data;
    }
    return parsed;
  } catch {
    return;
  }
}
async function readJson(args, timeoutMs = DEFAULT_TIMEOUT_MS, cwd) {
  if (readsUsed >= READ_BUDGET)
    return;
  readsUsed += 1;
  const result = await bdRun(args, timeoutMs, cwd);
  if (!result || result.code !== 0)
    return;
  return parsePayload(result.stdout);
}
function asBead(value) {
  if (value === null || typeof value !== "object")
    return null;
  if (!("id" in value) || typeof value.id !== "string")
    return null;
  const bead = value;
  return bead;
}
async function bdShow(id, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const payload = await readJson(["show", id, "--json"], timeoutMs);
  if (Array.isArray(payload))
    return asBead(payload[0]);
  return asBead(payload);
}
async function bdList(args, timeoutMs = DEFAULT_TIMEOUT_MS, cwd) {
  const payload = await readJson(args, timeoutMs, cwd);
  if (!Array.isArray(payload))
    return [];
  const beads = [];
  for (const entry of payload) {
    const bead = asBead(entry);
    if (bead)
      beads.push(bead);
  }
  return beads;
}
async function bdComments(id, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const payload = await readJson(["comments", id, "--json"], timeoutMs);
  if (!Array.isArray(payload))
    return [];
  const comments = [];
  for (const entry of payload) {
    if (entry === null || typeof entry !== "object")
      continue;
    let text;
    if ("text" in entry)
      text = entry.text;
    else if ("body" in entry)
      text = entry.body;
    else if ("comment" in entry)
      text = entry.comment;
    if (typeof text !== "string")
      continue;
    const author = "author" in entry && typeof entry.author === "string" ? entry.author : undefined;
    comments.push(author === undefined ? { text } : { text, author });
  }
  return comments;
}
async function bdLinked(id, type, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const payload = await readJson(["dep", "list", id, "--direction=up", "--type", type, "--json"], timeoutMs);
  if (!Array.isArray(payload))
    return [];
  const linked = [];
  for (const entry of payload) {
    if (entry === null || typeof entry !== "object")
      continue;
    for (const value of Object.values(entry)) {
      if (typeof value !== "string" || value === id || value === type)
        continue;
      if (/^[A-Za-z0-9][A-Za-z0-9._]*-[A-Za-z0-9][A-Za-z0-9._]*$/.test(value) && !linked.includes(value)) {
        linked.push(value);
      }
    }
  }
  return linked;
}
async function claimedBead(actor, timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (actor.length === 0)
    return null;
  const candidates = await bdList(["list", "--include-infra", "--assignee", actor, "--status", "open,in_progress,blocked", "--json"], timeoutMs);
  let best = null;
  for (const bead of candidates) {
    if (!best) {
      best = bead;
      continue;
    }
    const a = `${bead.updated_at ?? ""}\x00${bead.id}`;
    const b = `${best.updated_at ?? ""}\x00${best.id}`;
    if (a > b)
      best = bead;
  }
  return best;
}
function metadataString(bead, key) {
  const value = bead?.metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function commentVerb(text) {
  const token = /^[\s\-*+>`_~]*(\S*)/.exec(text)?.[1] ?? "";
  return token.replace(/[*_`~:,.;!?]+$/, "").toUpperCase();
}

// src/contract.ts
var DISPATCH_CONTRACT = `ORCHESTRATION PROTOCOL \u2014 active run. Follow exactly.

Work is pulled, not handed to you. Your first act is to claim the next bead matching
your domain:

    bd ready --parent <epic> --metadata-field role=<your-role> --unassigned --claim --json

Three outcomes, not two. Read the result before you decide.

Empty result -- there is no work for you: report NO_WORK and yield immediately. Never
invent work, and never claim a bead routed to another role, which is refused.

Claim error naming a serialization or transaction conflict -- contention, not absence:

    {"error":"dolt commit: Error 1213 (40001): serialization failure: this transaction conflicts with ..."}

Match on Error 1213, 40001, or serialization failure. Prose alone misses it. The loser of
a simultaneous claim receives that error and nothing else, even when a second unclaimed
bead still matches its filter. Retry the identical pull, at most three times, waiting 2s,
then 5s, then 10s. A retry cannot double-claim: the claim is mutually exclusive, and
measured contention never assigned one bead twice. Yielding NO_WORK here is wrong. It
abandons ready work and reports an empty queue that is not empty. If all three retries
lose, leave a BLOCKED comment quoting the error, and quote it in your yield payload too.
The exit gate discriminates on the error signature, not on the verb. It admits a
claimless exit carrying Error 1213, 40001, or serialization failure, and refuses a bare
BLOCKED without saying which half was missing. That check is a floor, not a proof: it
cannot tell your real error from this example copied out of the contract. It widens
nothing, because NO_WORK is admitted on a bare token with no evidence at all.

Any other error -- report it verbatim and stop. Never invent a retry for an error you
cannot name.

The run's beads database is a per-project Dolt server, resolved by host and port from
.beads/dolt-server.port, which travels with a copied checkout -- so your calls reach the
run's database from an isolated workspace without any flag. A claim is atomic across
processes: two workers never hold one bead, which is why the retry above is safe.

The bead is your brief, not your instructions. Read its description, metadata,
comments, and linked wisps before acting. Verify any file:line it cites against the
code and report drift rather than working around it. Task detail carried in a prompt
is advisory; the bead is authority.

Scope. Own only the globs in metadata.scope. Work inside the worktree named by
metadata.worktree, or inside the isolated copy you were given. Writing outside the
tree your claimed bead names is refused.

Evidence. Every factual claim carries a file:line, a command result, a bead id, or the
literal word untested. Cite prior facts by reference; never paste them into a message.

Verbs you may write (13): REPORTED BLOCKED FAILED REVIEW ADVICE LANDED BOUNCED CONFLICT
IDLE NO_WORK ASK NOTE LOCAL_DECISION. One verb plus a resource id per message. The full
set of 18 lives in src/contracts/grammar.json, which leads every copy. The other five are
the extension's voice, never yours. Your role contract narrows this list further.

GOTCHA: decoration is normalised for you. Bold, bulleted, blockquoted, backticked and
comma-tailed verbs all parse, and case is free. One trap survives: the first whitespace
token is the whole signal, so NO WORK parses as NO and the rulebook flags it. Spell a
multi-word verb with its underscore, then write the prose.

Mirror every material outcome to the affected bead as a comment, under the acting
identity. Set BEADS_ACTOR and BD_ACTOR to metadata.actor on every mutating bd process.

Exit. Your role contract is checked when you yield, and an incomplete exit is refused
with the unmet checks named. Satisfy it before yielding: deliver the evidence your
bead's execution_kind requires, add the next role's handoff label, clear your assignee,
and leave a REPORTED comment. A genuine failure is a valid exit -- set status blocked
and leave a FAILED or BLOCKED comment rather than faking success.

Handoff is a label. Add agent:<next-role>. Routing is different: metadata.role carries
it, the architect that decomposed the epic writes it, and no other role may rewrite it.

Blocked. Design or debug uncertainty creates an escalation wisp linked to your bead,
carrying a BLOCKED comment. Product intent creates an ASK wisp and a human gate. Never
wait live on a peer: record what you need, yield, and let the run wake you.

Spawning. An architect spawns roles that claim beads, and contract-free helpers that
edit files in its own checkout and report back. No other role spawns either of those. A
helper never claims a bead, never commits, and never manages worktrees. Claiming is the
line that matters: the queue and the exit gate both depend on it.

One exception for every other role. Read it off the agent's own frontmatter: an explicit
tools: list that omits write, edit and task cannot mutate your checkout and cannot spawn
further. Librarian is the case in point. Spawn one for an external-library fact. Its
structured result carries the answer back, so it needs no wisp. This needs
task.maxRecursionDepth 3.

Two cautions. Several such agents hold bash, librarian included, so prose confines their
writes rather than the tool list: librarian's body limits them to /tmp/librarian-*. And
an agent declaring no tools: list at all inherits write and task, which is why sonic is
never a helper.
`;
// src/contracts/grammar.json
var grammar_default = {
  _comment: "The protocol verb set, and the source of truth for it. src/gates/bd.ts ENFORCES this set, by calling `commentVerb` and comparing against these entries -- one implementation, so the guard and the parser cannot disagree. skills/orchestrate/references/message-grammar.md restates it for humans and is written by hand; test/grammar-parity.test.ts fails when the gate's set or that reference diverges from this file, in either direction, so edit here first and let the test name what else must move. A verb is what `commentVerb` in src/bd.ts yields: strip a leading run of bullet, blockquote, emphasis, tick and strikethrough markers, take the first whitespace token, strip trailing emphasis, ticks and sentence punctuation, uppercase. Case and ordinary markdown are therefore free; only the first token counts, and a multi-word verb needs its underscore. Nothing else in a comment is protocol. A non-verb is warned, not refused, and only inside an active run. Adding a verb here without a writer and a source is how a vocabulary rots: an entry sourced `inferred` is a judgement call recorded as one, not a constraint the code enforces.",
  _vocabulary: {
    writers: {
      "*": "every claiming role, backed by a clause present in all six role contracts (generic.json included)",
      unlisted: "generic.json's `agent: *` fallback: any claimant with no per-role contract",
      "architect|implementer|researcher|reviewer|shepherd": "that role only",
      extension: "this plugin's own code, not an agent. Named by `source.where`"
    },
    source: {
      contract: "migrated exactly from the named role-contract predicate. Machine-enforced on yield",
      code: "the named src file writes or parses this verb. Machine-observable, not contract-enforced",
      inferred: "no contract or code constrains the writer. `where` cites the prose the narrowest defensible set was read from -- a reviewer may disagree with the set without disagreeing with the verb"
    },
    terminal: "true when writing the verb ends the attempt it describes: the writer yields, or its claim is released. A non-terminal verb annotates work that continues"
  },
  verbs: [
    {
      verb: "REPORTED",
      meaning: "Evidence delivered, next role's label added, assignee cleared -- the node's exit contract is met.",
      writers: ["architect", "implementer", "researcher", "unlisted"],
      terminal: true,
      source: { kind: "contract", where: "architect.json, implementer.json, researcher.json, generic.json: completion.reported" }
    },
    {
      verb: "BLOCKED",
      meaning: "Work cannot proceed. Written on an escalation wisp linked to the node, never stored as a bead state.",
      writers: ["*"],
      terminal: true,
      source: { kind: "contract", where: "all six: escape.require. Also reviewer.json completion.verdict, researcher.json completion.answer, shepherd.json completion.disposition" }
    },
    {
      verb: "FAILED",
      meaning: "Unrecoverable failure. A valid exit paired with status blocked, never a faked success.",
      writers: ["*"],
      terminal: true,
      source: { kind: "contract", where: "all six: escape.require" }
    },
    {
      verb: "REVIEW",
      meaning: "One reviewer's verdict, written on the node its review wisp links to.",
      writers: ["reviewer"],
      terminal: true,
      source: { kind: "contract", where: "reviewer.json: completion.verdict" }
    },
    {
      verb: "ADVICE",
      meaning: "A researcher's durable answer to an escalation wisp, promoted to the linked node.",
      writers: ["researcher"],
      terminal: true,
      source: { kind: "contract", where: "researcher.json: completion.answer" }
    },
    {
      verb: "LANDED",
      meaning: "The merge bead's branch is merged and metadata.merge_sha is stamped.",
      writers: ["shepherd"],
      terminal: true,
      source: { kind: "contract", where: "shepherd.json: completion.disposition" }
    },
    {
      verb: "BOUNCED",
      meaning: "The merge attempt is refused back to its origin as a fix bead.",
      writers: ["shepherd"],
      terminal: true,
      source: { kind: "contract", where: "shepherd.json: completion.disposition" }
    },
    {
      verb: "CONFLICT",
      meaning: "The branch does not merge into its base. The node returns to working for a rebase; the shepherd never resolves it.",
      writers: ["shepherd"],
      terminal: true,
      source: { kind: "contract", where: "shepherd.json: completion.disposition" }
    },
    {
      verb: "IDLE",
      meaning: "Nothing was landable this transaction. The merge slot is released and the waiter queue outlives the exit.",
      writers: ["shepherd"],
      terminal: true,
      source: { kind: "contract", where: "shepherd.json: completion.disposition" }
    },
    {
      verb: "NO_WORK",
      meaning: "The role's queue is empty. Yield rather than widen the filter or invent work.",
      writers: ["*"],
      terminal: true,
      source: { kind: "code", where: "src/gates/exit.ts:230 -- the unclaimed-exit gate matches this literal to allow a claimless exit" }
    },
    {
      verb: "ASK",
      meaning: "A product-intent question only a human can settle. Pairs with a human gate on the held bead.",
      writers: ["*"],
      terminal: true,
      source: { kind: "inferred", where: "src/contract.ts DISPATCH_CONTRACT, Blocked clause -- injected into every worker, so narrowing below `*` is indefensible; references/lifecycle.md waiting_human row" }
    },
    {
      verb: "NOTE",
      meaning: "A durable observation with no protocol consequence, such as the id of a bead discovered mid-run.",
      writers: ["*"],
      terminal: false,
      source: { kind: "inferred", where: "references/lifecycle.md:343 (discovered bead); references/beads-store.md:273 lists note as a material verb for any acting agent" }
    },
    {
      verb: "LOCAL_DECISION",
      meaning: "A reversible bead-local default, provisional or accepted, carrying an objective revisit trigger.",
      writers: ["architect", "implementer"],
      terminal: false,
      source: { kind: "inferred", where: "agents/orc-architect.md:121; references/beads-store.md:44 comment contract; references/lifecycle.md:267. Narrowed to the two roles that apply implementation defaults -- a reviewer writes verdicts, a researcher writes ADVICE, a shepherd may not judge merits" }
    },
    {
      verb: "BOUNCE",
      meaning: "The exit contract force-allowed after the bounce budget. This attempt is invalidated; repair the envelope, never continue the session.",
      writers: ["extension"],
      terminal: true,
      source: { kind: "code", where: "src/gates/exit.ts:327" }
    },
    {
      verb: "RECLAIM",
      meaning: "A stranded claim was released and its bead reopened, with any surviving branch stamped.",
      writers: ["extension"],
      terminal: true,
      source: { kind: "code", where: "src/supervision.ts:201, src/supervision.ts:213" }
    },
    {
      verb: "STALL",
      meaning: "A claimed child went silent past its threshold. No kill -- the spawner decides.",
      writers: ["extension"],
      terminal: false,
      source: { kind: "code", where: "src/watchers.ts:206" }
    },
    {
      verb: "WARN",
      meaning: "A degraded preflight or a settings deviation the run should see but not stop for.",
      writers: ["extension"],
      terminal: false,
      source: { kind: "code", where: "src/watchers.ts:506, src/watchers.ts:822" }
    },
    {
      verb: "GOAL",
      meaning: "The run objective and its status, stamped on every epic each time it changes.",
      writers: ["extension"],
      terminal: false,
      source: { kind: "code", where: "src/watchers.ts:568" }
    }
  ]
};

// src/identity.ts
var ORC_ROLES = {
  architect: true,
  implementer: true,
  reviewer: true,
  researcher: true,
  shepherd: true
};
var ROLE_MARKER = /^ORC-ROLE:[ \t]*([a-z][a-z-]*)[ \t]*$/m;
function sessionRole(pi) {
  return pi.getAllTools().some((tool) => tool.name === "yield") ? "worker" : "lead";
}
function orcRole(ctx) {
  const match = ROLE_MARKER.exec(ctx.getSystemPrompt().join(`
`));
  const declared = match?.[1];
  return declared !== undefined && ORC_ROLES[declared] === true ? declared : undefined;
}
function isBeadWriteFree(pi, ctx) {
  return sessionRole(pi) === "worker" && orcRole(ctx) === undefined;
}
var ROUTING_KEY = "role";
var LEGACY_ROLE_LABEL = "agent:";
var LEGACY_LABEL_ROLES = {
  architect: "architect",
  implementer: "implementer",
  reviewer: "reviewer",
  researcher: "researcher",
  shepherd: "shepherd",
  integrator: "shepherd"
};
function legacyRoleFromLabel(label) {
  if (!label.startsWith(LEGACY_ROLE_LABEL))
    return;
  const suffix = label.slice(LEGACY_ROLE_LABEL.length);
  return Object.hasOwn(LEGACY_LABEL_ROLES, suffix) ? LEGACY_LABEL_ROLES[suffix] : undefined;
}
function routingValue(metadata) {
  let record;
  if (typeof metadata === "string") {
    try {
      const parsed = JSON.parse(metadata);
      if (parsed === null || typeof parsed !== "object")
        return;
      record = parsed;
    } catch {
      return;
    }
  } else if (metadata === undefined || metadata === null) {
    return;
  } else {
    record = metadata;
  }
  if (!Object.hasOwn(record, ROUTING_KEY))
    return;
  const value = record[ROUTING_KEY];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function beadRouting(bead) {
  const declared = routingValue(bead?.metadata);
  if (declared !== undefined && ORC_ROLES[declared] === true) {
    return { role: declared, from: "metadata", spelling: `${ROUTING_KEY}=${declared}` };
  }
  for (const label of bead?.labels ?? []) {
    const role = legacyRoleFromLabel(label);
    if (role !== undefined)
      return { role, from: "legacy-label", spelling: label };
  }
  return;
}

// src/run-state.ts
import fs from "fs/promises";
import path2 from "path";

// src/beads-mode.ts
var INIT_TIMEOUT_MS = 120000;
var EMBEDDED_REFUSAL = "beads is running embedded, a per-checkout database. bd will keep working and route every write into `.beads/embeddeddolt`, so an isolated worker mutates a copy and its claims, comments and closures never reach this run. A run requires a per-project Dolt server. Setting `dolt_mode` by hand does not convert it: the two modes read different directories, and the server's database would not exist. Run `bd doctor` to inspect, and see `bd backup --help` and `bd bootstrap --help` for carrying existing beads across.";
function firstLine(text) {
  const line = (text ?? "").split(`
`).find((entry) => entry.trim().length > 0);
  return line === undefined ? "no output" : line.trim();
}
async function ensureBeadsServer(cwd) {
  const info = await bdRun(["info"], undefined, cwd);
  if (info === null) {
    return { ok: false, reason: "bd could not be run, so the run's database cannot be verified" };
  }
  let note;
  if (info.code !== 0) {
    const init = await bdRun(["init", "--init-if-missing", "--skip-hooks", "--server", "--non-interactive"], INIT_TIMEOUT_MS, cwd);
    if (init === null)
      return { ok: false, reason: "bd init could not be run" };
    if (init.code !== 0)
      return { ok: false, reason: `bd init failed: ${firstLine(init.stderr || init.stdout)}` };
    note = "initialised beads as a per-project Dolt server";
  }
  const mode = await bdRun(["dolt", "show"], undefined, cwd);
  if (mode === null || mode.code !== 0) {
    return { ok: false, reason: "could not read the beads storage mode from `bd dolt show`" };
  }
  if (/^\s*Mode:\s*embedded\b/m.test(mode.stdout)) {
    return {
      ok: false,
      reason: note === undefined ? EMBEDDED_REFUSAL : "bd init reported success with `--server`, but `bd dolt show` still reports embedded mode, so this bd does not honour the flag and the run would write to a per-checkout database"
    };
  }
  return note === undefined ? { ok: true } : { ok: true, note };
}
// src/contracts/architect.json
var architect_default = {
  agent: "architect",
  tier: "T1",
  _comment: "Single source of truth for the SubagentStop evaluator AND the generated 'Your bead contract' block in the agent definition (compile-time). Do not hand-edit the generated block. Lifecycle phases (reported/in_review/approved/...) are NOT bd statuses; they derive from status + labels + gates + review-wisp closure. A specialist never CLOSES its own node, so `closed` is the forbidden built-in status. ROUTING: the architect is the one role that MAY write metadata.role, because it decomposes its epic and routes each node. deny_metadata cannot express that, being a presence test on the claimed bead rather than an authorship test. G5 grants it at the write seam (ROUTING_WRITERS in src/gates/claim.ts). The `handoff` check stays on the `agent:reviewer` LABEL, which is a ready-for-review signal and routes nothing now that metadata.role is authoritative.",
  completion: [
    {
      check: "branch",
      require: "metadata.branch",
      when: "git"
    },
    {
      check: "push",
      require: "metadata.push",
      when: "git"
    },
    {
      check: "output_ref",
      require: "metadata.output_ref",
      when: "artifact"
    },
    {
      check: "artifact_path",
      require: "artifact.output_ref contained",
      when: "artifact"
    },
    {
      check: "handoff",
      require: "label ~ ^agent:reviewer$",
      when: "git"
    },
    {
      check: "unclaimed",
      require: "assignee cleared",
      when: "git"
    },
    {
      check: "reported",
      require: "comment.verb in [REPORTED]"
    }
  ],
  authority: {
    deny_states: [
      "closed"
    ],
    deny_metadata: [
      "merge_sha",
      "pr"
    ]
  },
  escape: {
    state: "blocked",
    require: "comment.verb in [FAILED, BLOCKED]"
  },
  pause: [
    "open-escalation-wisp-linked-to-node"
  ],
  bounce: {
    max_attempts: 3
  }
};
// src/contracts/generic.json
var generic_default = {
  agent: "*",
  tier: "generic-fallback",
  _comment: "Applied by the matcher-less SubagentStop hook to ANY agent that holds a claim but has no per-agent rules file (unlisted/ad-hoc agents, T3 conditional binding). Minimal contract: report before stopping, never close a node you didn't own, failure is a valid exit. This is the claim<->contract net for the whole fleet. ROUTING: metadata.role is deliberately absent from deny_metadata. That list is a presence test read as authorship, sound only for outcome fields no dispatcher stamps. Routing must be stamped or the bead reaches no queue, so a denial here would fault every worker on every bead. G5 enforces it at the write seam instead, where only the architect may re-point a route. An unlisted role reaches this file and is therefore denied routing writes, which is the fail-closed direction.",
  completion: [
    { check: "reported", require: "comment.verb in [REPORTED]" }
  ],
  authority: {
    deny_states: ["closed"],
    deny_metadata: ["merge_sha", "pr"]
  },
  escape: {
    state: "blocked",
    require: "comment.verb in [FAILED, BLOCKED]"
  },
  bounce: { max_attempts: 3 }
};
// src/contracts/implementer.json
var implementer_default = {
  agent: "implementer",
  tier: "T1",
  _comment: "Derived from architect.json: the same writer exit contract for a single node. Git evidence under apply=false is the captured branch plus the final commit sha (`metadata.branch`, `metadata.head_sha`) \u2014 the implementer never pushes; the architect integrates and pushes. Keeps `pause` so a worker waiting on an open escalation wisp is not bounced for the delay. It does NOT own decomposition, so it never creates feature beads; that is prose in the agent body, not a contract predicate. Like the architect it may never CLOSE its own node, and never writes merge_sha or pr \u2014 those belong to the shepherd. ROUTING: metadata.role is deliberately absent from deny_metadata. That list is a presence test read as authorship, sound only for outcome fields no dispatcher stamps. Routing must be stamped or the bead reaches no queue, so a denial here would fault every worker on every bead. G5 enforces it at the write seam instead, where only the architect may re-point a route. `bd create` stays exempt, so a routable bug bead can still be filed. The `handoff` check therefore stays on the `agent:reviewer` LABEL: a signal the implementer writes, not a route.",
  completion: [
    {
      check: "branch",
      require: "metadata.branch",
      when: "git"
    },
    {
      check: "delivery",
      require: "metadata.head_sha",
      when: "git"
    },
    {
      check: "output_ref",
      require: "metadata.output_ref",
      when: "artifact"
    },
    {
      check: "artifact_path",
      require: "artifact.output_ref contained",
      when: "artifact"
    },
    {
      check: "handoff",
      require: "label ~ ^agent:reviewer$",
      when: "git"
    },
    {
      check: "unclaimed",
      require: "assignee cleared",
      when: "git"
    },
    {
      check: "reported",
      require: "comment.verb in [REPORTED]"
    }
  ],
  authority: {
    deny_states: [
      "closed"
    ],
    deny_metadata: [
      "merge_sha",
      "pr"
    ]
  },
  escape: {
    state: "blocked",
    require: "comment.verb in [FAILED, BLOCKED]"
  },
  pause: [
    "open-escalation-wisp-linked-to-node"
  ],
  bounce: {
    max_attempts: 3
  }
};
// src/contracts/researcher.json
var researcher_default = {
  agent: "researcher",
  tier: "T1",
  _comment: "Research nodes produce durable evidence and hand off. Escalation wisps promote one ADVICE or BLOCKED summary to the linked node. ROUTING: metadata.role is deliberately absent from deny_metadata. That list is a presence test read as authorship, sound only for outcome fields no dispatcher stamps. Routing must be stamped or the bead reaches no queue, so a denial here would fault every worker on every bead. G5 enforces it at the write seam instead, where only the architect may re-point a route. `bd create` stays exempt, so a routable bug bead can still be filed. The `handoff` check therefore stays on the `agent:reviewer` LABEL: a signal the researcher writes, not a route.",
  completion: [
    {
      check: "output_ref",
      require: "metadata.output_ref",
      when: [
        "artifact",
        "comment"
      ]
    },
    {
      check: "artifact_path",
      require: "artifact.output_ref contained",
      when: "artifact"
    },
    {
      check: "handoff",
      require: "label ~ ^agent:reviewer$",
      when: [
        "artifact",
        "comment"
      ]
    },
    {
      check: "unclaimed",
      require: "assignee cleared",
      when: [
        "artifact",
        "comment"
      ]
    },
    {
      check: "reported",
      require: "comment.verb in [REPORTED]",
      when: [
        "artifact",
        "comment"
      ]
    },
    {
      check: "answer",
      require: "linked.comment.verb in [ADVICE, BLOCKED]",
      when: "escalation"
    }
  ],
  authority: {
    deny_states: [
      "merged",
      "approved"
    ],
    deny_metadata: [
      "push",
      "merge_sha",
      "pr"
    ]
  },
  escape: {
    state: "blocked",
    require: "comment.verb in [FAILED, BLOCKED]"
  },
  bounce: {
    max_attempts: 3
  }
};
// src/contracts/reviewer.json
var reviewer_default = {
  agent: "reviewer",
  tier: "T1",
  _comment: "Claims a review wisp and writes the REVIEW verdict on its linked node. Approval closes the wisp; changes release it open for the next round. It claims the WISP, never the node, so a handed-off node never has to enter this role's queue. ROUTING: metadata.role is deliberately absent from deny_metadata. That list is a presence test read as authorship, sound only for outcome fields no dispatcher stamps. Routing must be stamped or the bead reaches no queue, so a denial here would fault every worker on every bead. G5 enforces it at the write seam instead, where only the architect may re-point a route. `bd create` stays exempt, so a routable bug bead can still be filed.",
  completion: [
    { check: "verdict", require: "linked.comment.verb in [REVIEW, BLOCKED]" }
  ],
  authority: {
    deny_states: ["merged"],
    deny_metadata: ["push", "merge_sha", "pr"]
  },
  escape: {
    state: "blocked",
    require: "comment.verb in [FAILED, BLOCKED]"
  },
  bounce: { max_attempts: 3 }
};
// src/contracts/shepherd.json
var shepherd_default = {
  agent: "shepherd",
  tier: "T2",
  _comment: "In-run merge shepherd (distinct from the standalone pr-shepherd daemon). Per-transaction authority: claims one merge bead, lands or bounces, releases. It legitimately writes merge_sha/pr and closes merge beads. deny_states blocks review verdicts. deny_metadata omits branch/base_sha because those are pre-existing merge-bead anchors and the evaluator cannot attribute field authorship. The bounce-route check (a bounced fix must carry metadata.stage=fix and metadata.origin_bead) and the landed check (metadata.merge_sha when merged) are NOT here: both are conditional on which disposition was written, and the predicate grammar has no verb-conditional form. Until it does, shepherd.md prose owns them. CONFLICT is a disposition, not a failure. This role detects the unmergeable branch (orc_conflict_probe guards every integration) and is forbidden from resolving one, so the conflict is reported rather than fixed. references/lifecycle.md routes it to `working (rebase)`, which is neither a land nor a fix bounce, and escape is reserved for status=blocked. Without it a conflicted transaction had to mislabel itself BOUNCED to satisfy this check. ROUTING: a merge bead carries the `pr:merge` LABEL for classification plus metadata.role=shepherd for routing; the dead `agent:integrator` suffix routed to no role at all. metadata.role is deliberately absent from deny_metadata. That list is a presence test read as authorship, sound only for outcome fields no dispatcher stamps. Routing must be stamped or the bead reaches no queue, so a denial here would fault every worker on every bead. G5 enforces it at the write seam instead, where only the architect may re-point a route. A BOUNCED disposition reopens the existing bead, whose route is already stamped, so this role needs no routing write.",
  completion: [
    { check: "disposition", require: "comment.verb in [LANDED, BOUNCED, CONFLICT, IDLE, BLOCKED]" }
  ],
  authority: {
    deny_states: [
      "approved",
      "changes_requested",
      "reported"
    ],
    deny_metadata: [
      "output_ref"
    ]
  },
  escape: {
    state: "blocked",
    require: "comment.verb in [FAILED, BLOCKED]"
  },
  bounce: {
    max_attempts: 3
  }
};

// src/gates/exit.ts
import path from "path";

// src/claim-state.ts
var observed;
function recordClaim(observation) {
  if (observation.actor.length === 0 || observation.beadIds.length === 0)
    return;
  observed = observation;
}
function observedClaim() {
  return observed;
}

// src/gates/exit.ts
var CONTRACTS = {
  architect: architect_default,
  implementer: implementer_default,
  researcher: researcher_default,
  reviewer: reviewer_default,
  shepherd: shepherd_default,
  generic: generic_default
};
var ORCHESTRATOR_ANCHORS = {
  actor: true,
  artifacts_dir: true,
  base_ref: true,
  base_sha: true,
  branch: true,
  complexity_tier: true,
  execution_agent: true,
  execution_dispatch: true,
  execution_kind: true,
  execution_task_kind: true,
  lease_token: true,
  origin: true,
  origin_actor: true,
  origin_bead: true,
  run_epic: true,
  runtime_context: true,
  runtime_handle: true,
  scope: true,
  worktree: true
};
function resourceKind(bead) {
  const declared = metadataString(bead, "execution_kind");
  if (declared !== undefined)
    return declared;
  if (metadataString(bead, "worktree") !== undefined)
    return "git";
  if (metadataString(bead, "artifacts_dir") !== undefined)
    return "artifact";
  return;
}
function applies(check, kind) {
  if (check.when === undefined)
    return true;
  const wanted = Array.isArray(check.when) ? check.when : [check.when];
  return kind !== undefined && wanted.includes(kind);
}
function satisfies(predicate, evidence) {
  const { bead, verbs, linkedVerbs } = evidence;
  const trimmed = predicate.trim();
  const metadataKey = /^metadata\.([A-Za-z0-9_]+)$/.exec(trimmed);
  if (metadataKey?.[1] !== undefined)
    return metadataString(bead, metadataKey[1]) !== undefined;
  if (trimmed === "assignee cleared") {
    return bead.assignee === undefined || bead.assignee === null || bead.assignee === "";
  }
  if (trimmed === "artifact.output_ref contained") {
    const output = metadataString(bead, "output_ref");
    const artifacts = metadataString(bead, "artifacts_dir");
    if (output === undefined || artifacts === undefined)
      return false;
    if (!path.isAbsolute(output) || !path.isAbsolute(artifacts))
      return false;
    const inside = output.startsWith(`${artifacts}${path.sep}`);
    const worktree = metadataString(bead, "worktree");
    const underWorktree = worktree !== undefined && output.startsWith(`${worktree}${path.sep}`);
    return inside && output !== artifacts && !underWorktree;
  }
  const labelMatch = /^label\s*~\s*(.+)$/.exec(trimmed);
  if (labelMatch?.[1] !== undefined) {
    let pattern;
    try {
      pattern = new RegExp(labelMatch[1].replace(/^["']|["']$/g, ""));
    } catch {
      return false;
    }
    return (bead.labels ?? []).some((label) => pattern.test(label));
  }
  const verbMatch = /^(linked\.)?comment\.verb\s+in\s*\[([^\]]*)\]$/.exec(trimmed);
  if (verbMatch !== null) {
    const wanted = (verbMatch[2] ?? "").split(",").map((entry) => entry.trim().toUpperCase()).filter((entry) => entry.length > 0);
    const pool = verbMatch[1] === undefined ? verbs : linkedVerbs;
    return pool.some((verb) => wanted.includes(verb));
  }
  return true;
}
async function collectEvidence(bead) {
  const verbs = (await bdComments(bead.id)).map((comment) => commentVerb(comment.text));
  const linkedVerbs = [];
  for (const type of ["relates-to", "replies-to"]) {
    for (const linkedId of await bdLinked(bead.id, type)) {
      for (const comment of await bdComments(linkedId)) {
        linkedVerbs.push(commentVerb(comment.text));
      }
    }
  }
  return { bead, verbs, linkedVerbs };
}
var unclaimedReminded = false;
var CONTENTION_EVIDENCE = /error\s*1213|40001|serialization failure/i;
async function gateUnclaimedExit(ctx, input) {
  if (orcRole(ctx) === undefined)
    return;
  if (unclaimedReminded)
    return;
  const payload = input === undefined ? "" : JSON.stringify(input);
  if (payload.includes("NO_WORK"))
    return;
  if (CONTENTION_EVIDENCE.test(payload))
    return;
  unclaimedReminded = true;
  return {
    block: true,
    reason: "You are exiting without ever claiming a bead. Work is pulled, not invented: run your role's `bd ready ... --claim` and deliver the bead you get. Two exits need no claim, and the pull result decides which. Empty result -- report NO_WORK. Claim error naming Error 1213, 40001, or serialization failure -- retry the identical pull, at most three times. Then quote that error here. Never report NO_WORK for a race you lost: the queue was not empty. Uncommitted work under no claim reaches no branch and no bead."
  };
}
async function gateExitContract(ctx, input) {
  const claim = observedClaim();
  const beadId = claim?.beadIds[0];
  if (beadId === undefined)
    return await gateUnclaimedExit(ctx, input);
  const bead = await bdShow(beadId);
  if (bead === null)
    return;
  const routing = beadRouting(bead);
  const role = orcRole(ctx) ?? routing?.role ?? "generic";
  const contract = (Object.hasOwn(CONTRACTS, role) ? CONTRACTS[role] : undefined) ?? CONTRACTS.generic;
  if (contract === undefined)
    return;
  const evidence = await collectEvidence(bead);
  const status = (bead.status ?? "").toLowerCase();
  if (contract.escape?.state !== undefined && status === contract.escape.state) {
    if (contract.escape.require === undefined || satisfies(contract.escape.require, evidence)) {
      return;
    }
  }
  const kind = resourceKind(bead);
  const failures = [];
  for (const check of contract.completion ?? []) {
    if (!applies(check, kind))
      continue;
    if (!satisfies(check.require, evidence)) {
      failures.push({ check: check.check, detail: `unsatisfied: ${check.require}` });
    }
  }
  const stateLabels = (bead.labels ?? []).filter((label) => label.startsWith("state:")).map((label) => label.slice("state:".length).toLowerCase());
  for (const denied of contract.authority?.deny_states ?? []) {
    if (status === denied || stateLabels.includes(denied)) {
      failures.push({ check: "state-authority", detail: `status=${denied} set by a role forbidden to set it` });
    }
  }
  for (const denied of contract.authority?.deny_metadata ?? []) {
    if (ORCHESTRATOR_ANCHORS[denied] === true)
      continue;
    if (metadataString(bead, denied) !== undefined) {
      failures.push({
        check: "metadata-authority",
        detail: `metadata.${denied} is set and this role may not own it; unset it or escalate`
      });
    }
  }
  if (failures.length === 0)
    return;
  const attempts = Number(metadataString(bead, "stop_attempts") ?? "0") + 1;
  const maxAttempts = contract.bounce?.max_attempts ?? 3;
  if (attempts >= maxAttempts) {
    await bdRun(["comment", beadId, `BOUNCE agent=${role} attempt=${attempts}`]);
    if (status === "closed")
      await bdRun(["reopen", beadId, "--reason", "contract bounce"]);
    await bdRun([
      "update",
      beadId,
      "--assignee",
      "",
      "--status",
      "open",
      "--metadata",
      JSON.stringify({ stop_attempts: 0, review_round: 0 })
    ]);
    return;
  }
  await bdRun(["update", beadId, "--metadata", JSON.stringify({ stop_attempts: attempts })]);
  return {
    block: true,
    reason: JSON.stringify({
      bead: beadId,
      agent: role,
      attempt: attempts,
      ...routing?.from === "legacy-label" ? { routing: routing.spelling } : {},
      failed_checks: failures
    })
  };
}

// src/supervision.ts
var TERMINAL = { aborted: true, completed: true, failed: true };
var TIMEOUT_MS = 15000;
var spawnExec = async (argv, cwd) => {
  const [bin, ...args] = argv;
  if (bin === undefined)
    return null;
  try {
    const proc = Bun.spawn([bin, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill(), TIMEOUT_MS);
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited
      ]);
      return { code, stdout, stderr };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
};
function lines(stdout) {
  const out = [];
  for (const raw of stdout.split(`
`)) {
    const line = raw.trim();
    if (line !== "")
      out.push(line);
  }
  return out;
}
async function reapChild(child, options) {
  const outcome = { child: child.id, reaped: [] };
  if (TERMINAL[child.status] !== true)
    return outcome;
  resetReadBudget();
  const candidates = await candidateBeads(child);
  if (candidates.length === 0)
    return outcome;
  const branch = await capturedBranch(child.id, options);
  if (branch !== undefined)
    outcome.branch = branch;
  for (const bead of candidates) {
    outcome.reaped.push(await reapBead(bead, child, branch));
  }
  return outcome;
}
async function candidateBeads(child) {
  const claimed = await bdList(["list", "--assignee", child.id, "--status", "in_progress", "--json"]);
  if (claimed.length > 0)
    return claimed;
  if (child.status !== "completed")
    return [];
  const stamped = await bdList([
    "list",
    "--metadata-field",
    `actor=${child.id}`,
    "--status",
    "open,in_progress",
    "--json"
  ]);
  const mine = [];
  for (const bead of stamped) {
    const assignee = typeof bead.assignee === "string" ? bead.assignee : "";
    if (assignee === "" || assignee === child.id)
      mine.push(bead);
  }
  return mine;
}
async function reapBead(bead, child, branch) {
  if (child.status !== "completed") {
    const evidence = branch === undefined ? "no captured branch, nothing to recover" : `commits preserved on ${branch}`;
    await reclaim(bead, `RECLAIM child ${child.id} died (${child.status}); ${evidence}`, branch);
    return { bead: bead.id, case: branch === undefined ? "died-without-work" : "died-with-work", failures: [] };
  }
  const failures = await contractFailures(bead);
  const claimHeld = typeof bead.assignee === "string" && bead.assignee !== "";
  if (failures.length === 0 && !claimHeld) {
    await stampBranch(bead, branch);
    return { bead: bead.id, case: "clean", failures: [] };
  }
  const why = failures.length > 0 ? failures.join(", ") : "claim still held";
  const routing = beadRouting(bead);
  const carrier = routing?.from === "legacy-label" ? ` (contract from legacy ${routing.spelling}; stamp metadata.role)` : "";
  await reclaim(bead, `RECLAIM child ${child.id} exited without completing: ${why}${carrier}`, branch);
  return { bead: bead.id, case: "incomplete", failures };
}
async function reclaim(bead, reason, branch) {
  await bdRun(["comment", bead.id, reason]);
  const argv = ["update", bead.id, "--assignee", "", "--status", "open"];
  if (branch !== undefined)
    argv.push("--set-metadata", `recovered_branch=${branch}`);
  await bdRun(argv);
}
async function stampBranch(bead, branch) {
  if (branch === undefined)
    return;
  if (metadataString(bead, "branch") !== undefined)
    return;
  await bdRun(["update", bead.id, "--set-metadata", `branch=${branch}`]);
}
async function capturedBranch(id, options) {
  const exec = options.exec ?? spawnExec;
  const wanted = `omp/task/${id}`;
  const result = await exec(["git", "branch", "--list", `${wanted}*`], options.cwd);
  if (result === null || result.code !== 0)
    return;
  for (const line of lines(result.stdout)) {
    if (line.replace(/^[*+]\s*/, "") === wanted)
      return wanted;
  }
  return;
}
var CONTRACTS2 = {
  architect: architect_default,
  implementer: implementer_default,
  researcher: researcher_default,
  reviewer: reviewer_default,
  shepherd: shepherd_default,
  generic: generic_default
};
async function contractFailures(bead) {
  const role = beadRouting(bead)?.role ?? "generic";
  const contract = Object.hasOwn(CONTRACTS2, role) ? CONTRACTS2[role] ?? generic_default : generic_default;
  const evidence = await collectEvidence2(bead);
  const status = (bead.status ?? "").toLowerCase();
  if (contract.escape?.state === status) {
    if (contract.escape.require === undefined || satisfies(contract.escape.require, evidence))
      return [];
  }
  const kind = resourceKind(bead);
  const failures = [];
  for (const check of contract.completion ?? []) {
    if (applies(check, kind) && !satisfies(check.require, evidence))
      failures.push(check.check);
  }
  return failures;
}
async function collectEvidence2(bead) {
  const verbs = (await bdComments(bead.id)).map((comment) => commentVerb(comment.text));
  const linkedVerbs = [];
  for (const type of ["relates-to", "replies-to"]) {
    for (const linkedId of await bdLinked(bead.id, type)) {
      for (const comment of await bdComments(linkedId))
        linkedVerbs.push(commentVerb(comment.text));
    }
  }
  return { bead, verbs, linkedVerbs };
}
async function ensurePatrolWisp(epicId, cwd) {
  const linked = await bdList(["dep", "list", epicId, "--direction=up", "--type", "relates-to", "--json"], undefined, cwd);
  for (const bead of linked) {
    const wispType = typeof bead.wisp_type === "string" ? bead.wisp_type : "";
    if (wispType === "patrol" && (bead.status ?? "").toLowerCase() !== "closed")
      return;
  }
  await bdRun([
    "create",
    `patrol: ${epicId} claim reconciliation`,
    "--ephemeral",
    "--wisp-type",
    "patrol",
    "--deps",
    `relates-to:${epicId}`,
    "--silent"
  ], undefined, cwd);
}
function registerSupervision(pi) {
  let subscribed = false;
  pi.on("session_start", (_event, ctx) => {
    if (subscribed)
      return;
    subscribed = true;
    pi.events.on("task:subagent:lifecycle", (data) => handleLifecycle(pi, data, ctx.cwd));
  });
}
async function handleLifecycle(pi, data, cwd) {
  const child = asLifecycle(data);
  if (child === null)
    return;
  try {
    const outcome = await reapChild(child, { cwd });
    for (const reaped of outcome.reaped) {
      pi.logger.info("orchestrate reaper", {
        child: child.id,
        bead: reaped.bead,
        case: reaped.case,
        branch: outcome.branch,
        failures: reaped.failures
      });
    }
  } catch (error) {
    pi.logger.error("orchestrate reaper failed open", {
      child: child.id,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}
function asLifecycle(data) {
  if (data === null || typeof data !== "object")
    return null;
  if (!("id" in data) || typeof data.id !== "string" || data.id.length === 0)
    return null;
  if (!("status" in data) || typeof data.status !== "string")
    return null;
  return { id: data.id, status: data.status };
}

// src/run-state.ts
var PENDING = "pending";
var RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
function markerPath(cwd) {
  const configured = process.env.ORCHESTRATE_MARKER_FILE;
  if (configured !== undefined && configured.length > 0)
    return path2.resolve(cwd, configured);
  return path2.join(cwd, ".orchestration", ".active-run");
}
async function readActiveRun(cwd) {
  let raw;
  try {
    raw = (await fs.readFile(markerPath(cwd), "utf8")).trim();
  } catch {
    return null;
  }
  if (raw.length === 0)
    return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { schema_version: 1, run_id: raw };
  }
  return asActiveRun(parsed);
}
function asActiveRun(value) {
  if (typeof value === "string")
    return value.length > 0 ? { schema_version: 1, run_id: value } : null;
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  const record = value;
  const runId = typeof record.run_id === "string" && record.run_id.length > 0 ? record.run_id : PENDING;
  const sessionId = typeof record.session_id === "string" && record.session_id.length > 0 ? record.session_id : undefined;
  const state = { schema_version: 1, run_id: runId };
  if (sessionId !== undefined)
    state.session_id = sessionId;
  return state;
}
async function writeMarker(target, state) {
  await fs.mkdir(path2.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(state, Object.keys(state).sort())}
`, "utf8");
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}
async function activateRun(cwd, sessionId) {
  const existing = await readActiveRun(cwd);
  const session = sessionId ?? existing?.session_id;
  const state = { schema_version: 1, run_id: existing?.run_id ?? PENDING };
  if (session !== undefined)
    state.session_id = session;
  await writeMarker(markerPath(cwd), state);
  return state;
}
async function bindRun(cwd, runId) {
  if (!RUN_ID_RE.test(runId))
    throw new Error(`run id must be a Beads identifier, got ${JSON.stringify(runId)}`);
  const existing = await readActiveRun(cwd);
  if (existing === null)
    throw new Error("no active-run marker to bind; run /orchestrate-run first");
  if (existing.run_id !== PENDING && existing.run_id !== runId) {
    throw new Error(`active-run marker is already bound to ${existing.run_id}`);
  }
  await writeMarker(markerPath(cwd), { ...existing, run_id: runId });
  resetReadBudget();
  await ensurePatrolWisp(runId, cwd).catch(() => {});
}
function registerRunCommands(pi) {
  pi.registerCommand("orchestrate-run", {
    description: "Activate orchestrate run enforcement in this repository",
    handler: async (_args, ctx) => {
      const cwd = ctx.sessionManager.getCwd();
      const beads = await ensureBeadsServer(cwd);
      if (!beads.ok) {
        ctx.ui.notify(`orchestrate run NOT activated: ${beads.reason}`, "error");
        return;
      }
      if (beads.note !== undefined)
        ctx.ui.notify(beads.note, "info");
      try {
        const state = await activateRun(cwd, ctx.sessionManager.getSessionId());
        ctx.ui.notify(state.run_id === PENDING ? "orchestrate run active, awaiting a run epic (/orchestrate-bind <run-id>)" : `orchestrate run active, bound to ${state.run_id}`, "info");
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`could not activate orchestrate run: ${reason}`, "error");
      }
    }
  });
  pi.registerCommand("orchestrate-bind", {
    description: "Bind the active orchestrate run to a run epic id",
    handler: async (args, ctx) => {
      const runId = args.trim();
      try {
        await bindRun(ctx.sessionManager.getCwd(), runId);
        ctx.ui.notify(`orchestrate run bound to ${runId}`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    }
  });
}

// src/shell.ts
var VALUE_FLAGS = {
  "-C": true,
  "--actor": true,
  "--db": true,
  "--directory": true,
  "--dolt-auto-commit": true
};
var ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
var OPERATOR_CHARS = { ";": true, "&": true, "|": true };
var GROUPING = { ")": true, "}": true };
function tokenize(line) {
  const tokens = [];
  let current = "";
  let started = false;
  let quote;
  const flush = () => {
    if (started) {
      tokens.push(current);
      current = "";
      started = false;
    }
  };
  for (let i = 0;i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) {
        quote = undefined;
      } else if (ch === "\\" && quote === '"' && i + 1 < line.length) {
        current += line[++i];
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === "\\") {
      if (i + 1 < line.length) {
        current += line[++i];
        started = true;
      }
      continue;
    }
    if (ch === " " || ch === "\t") {
      flush();
      continue;
    }
    if (OPERATOR_CHARS[ch]) {
      flush();
      let op = ch;
      while (i + 1 < line.length && OPERATOR_CHARS[line[i + 1]]) {
        op += line[++i];
      }
      tokens.push(op);
      continue;
    }
    current += ch;
    started = true;
  }
  if (quote)
    return tokens;
  flush();
  return tokens;
}
function splitSegments(command) {
  const segments = [];
  const normalized = command.replaceAll("\\\n", " ");
  const lines2 = normalized.split(`
`);
  for (const line of lines2) {
    const tokens = tokenize(line);
    let current = [];
    for (const token of tokens) {
      const isOperator = token.length > 0 && [...token].every((c) => OPERATOR_CHARS[c] === true);
      if (isOperator) {
        if (current.length > 0) {
          segments.push(current);
          current = [];
        }
        continue;
      }
      current.push(token);
    }
    if (current.length > 0)
      segments.push(current);
  }
  return segments;
}
var DURATION = /^\d+(?:\.\d+)?[smhd]?$/;
var TRANSPARENT_PREFIXES = {
  command: { takesDuration: false },
  builtin: { takesDuration: false },
  exec: { takesDuration: false },
  nohup: { takesDuration: false },
  time: { takesDuration: false },
  timeout: { takesDuration: true },
  stdbuf: { takesDuration: false }
};
var WRAPPER_SHELLS = { sh: true, bash: true, zsh: true, dash: true, ksh: true };
function skipTransparentPrefix(segment, from) {
  let index = from;
  while (index < segment.length) {
    const token = segment[index];
    if (token === "(" || token === "{" || token === "!") {
      index += 1;
      continue;
    }
    const prefix = Object.hasOwn(TRANSPARENT_PREFIXES, token) ? TRANSPARENT_PREFIXES[token] : undefined;
    if (prefix === undefined)
      break;
    index += 1;
    while (index < segment.length) {
      const next = segment[index];
      if (next.startsWith("-")) {
        index += 1;
        continue;
      }
      if (prefix.takesDuration && DURATION.test(next)) {
        index += 1;
        continue;
      }
      break;
    }
  }
  return index;
}
var MAX_WRAPPER_DEPTH = 4;
function effectiveSegments(command, depth = 0) {
  const expanded = [];
  for (const segment of splitSegments(command)) {
    expanded.push(segment);
    if (depth >= MAX_WRAPPER_DEPTH)
      continue;
    const head = skipTransparentPrefix(segment, 0);
    const program = segment[head];
    if (program === undefined)
      continue;
    if (basename(program) === "eval") {
      const payload2 = segment.slice(head + 1).join(" ");
      if (payload2.length > 0)
        expanded.push(...effectiveSegments(payload2, depth + 1));
      continue;
    }
    if (WRAPPER_SHELLS[basename(program)] !== true)
      continue;
    const flagIndex = segment.findIndex((token, at) => at > head && /^-[a-z]*c$/.test(token));
    if (flagIndex === -1)
      continue;
    const payload = segment[flagIndex + 1];
    if (payload !== undefined)
      expanded.push(...effectiveSegments(payload, depth + 1));
  }
  return expanded;
}
function basename(p) {
  const cut = p.lastIndexOf("/");
  return cut === -1 ? p : p.slice(cut + 1);
}
var BEAD_ID = /^[a-z][a-z0-9]*(?:-[A-Za-z0-9._]+)+$/;
function stripGroupClose(token) {
  let end = token.length;
  for (;; ) {
    const last = token[end - 1];
    if (last !== ")" && last !== "}")
      break;
    const open = last === ")" ? "(" : "{";
    const body = token.slice(0, end);
    let depth = 0;
    for (const char of body) {
      if (char === open)
        depth += 1;
      else if (char === last)
        depth -= 1;
    }
    if (depth >= 0)
      break;
    end -= 1;
  }
  return token.slice(0, end);
}
function parseBdInvocation(segment) {
  const assignments = new Map;
  let index = 0;
  while (index < segment.length && ASSIGNMENT.test(segment[index])) {
    const [key, ...value] = segment[index].split("=");
    assignments.set(key, value.join("="));
    index += 1;
  }
  if (segment[index] === "env") {
    index += 1;
    while (index < segment.length) {
      const token = segment[index];
      if (ASSIGNMENT.test(token)) {
        const [key, ...value] = token.split("=");
        assignments.set(key, value.join("="));
      } else if (!token.startsWith("-")) {
        break;
      }
      index += 1;
    }
  }
  index = skipTransparentPrefix(segment, index);
  const head = segment[index]?.replace(/^[({]+/, "");
  if (head === undefined || head.length === 0 || basename(head) !== "bd")
    return null;
  const rest = segment.slice(index + 1).map((token) => ({ token, stripped: stripGroupClose(token) })).filter(({ token, stripped }) => stripped.length > 0 || token.length === 0).map(({ stripped }) => stripped);
  const positionals = [];
  let skip = false;
  for (const token of rest) {
    if (skip) {
      skip = false;
      continue;
    }
    if (VALUE_FLAGS[token] === true) {
      skip = true;
      continue;
    }
    if (token.startsWith("-") || GROUPING[token] === true)
      continue;
    positionals.push(token);
  }
  return {
    assignments,
    subcommand: positionals[0] ?? "",
    positionals: positionals.slice(1),
    rest,
    hasClaim: rest.includes("--claim")
  };
}
function bdInvocations(command) {
  const found = [];
  for (const segment of effectiveSegments(command)) {
    const parsed = parseBdInvocation(segment);
    if (parsed)
      found.push(parsed);
  }
  return found;
}
var SEPARATE_OPERAND_FLAGS = {
  "-C": true,
  "-c": true,
  "--git-dir": true,
  "--work-tree": true,
  "--namespace": true,
  "--exec-path": true,
  "--config-env": true,
  "-R": true,
  "--repo": true
};
function invokesCommand(command, argv) {
  if (argv.length === 0)
    return false;
  for (const segment of effectiveSegments(command)) {
    let index = 0;
    while (index < segment.length && ASSIGNMENT.test(segment[index]))
      index += 1;
    if (segment[index] === "env") {
      index += 1;
      while (index < segment.length) {
        const token = segment[index];
        if (ASSIGNMENT.test(token))
          index += 1;
        else if (token.startsWith("-"))
          index += 1;
        else
          break;
      }
    }
    index = skipTransparentPrefix(segment, index);
    const head = segment[index];
    if (head === undefined || basename(head) !== argv[0])
      continue;
    if (argv.length === 1)
      return true;
    let cursor = index + 1;
    let matched = 1;
    while (cursor < segment.length && matched < argv.length) {
      const token = segment[cursor];
      if (token === argv[matched]) {
        matched += 1;
        cursor += 1;
        continue;
      }
      if (!token.startsWith("-"))
        break;
      cursor += 1;
      if (SEPARATE_OPERAND_FLAGS[token] === true)
        cursor += 1;
    }
    if (matched === argv.length)
      return true;
  }
  return false;
}

// src/gates/bd.ts
var BD_NOTICE_MESSAGE = "com.srobroek.omp-orchestrate.bd-notice";
var DECLARED_VERBS = Object.fromEntries(grammar_default.verbs.map((entry) => [entry.verb, true]));
var VERB_LIST = grammar_default.verbs.map((entry) => entry.verb).join(" ");
function splitFlag(token) {
  if (!token.startsWith("-"))
    return { flag: token };
  const cut = token.indexOf("=");
  if (cut === -1)
    return { flag: token };
  return { flag: token.slice(0, cut), inline: token.slice(cut + 1) };
}
function flagOperands(rest, names) {
  const found = [];
  for (let index = 0;index < rest.length; index++) {
    const { flag, inline } = splitFlag(rest[index]);
    if (names[flag] !== true)
      continue;
    const value = inline ?? rest[index + 1];
    if (typeof value !== "string" || value.length === 0)
      continue;
    if (inline === undefined && value.startsWith("-"))
      continue;
    found.push({ flag, value });
  }
  return found;
}
function operation(invocation) {
  if (invocation.subcommand === "comments" && invocation.positionals[0] === "add") {
    return { name: "comment", operands: invocation.positionals.slice(1) };
  }
  return { name: invocation.subcommand, operands: invocation.positionals };
}
var READ_SUBCOMMANDS = {
  blocked: true,
  children: true,
  comments: true,
  context: true,
  count: true,
  doctor: true,
  export: true,
  graph: true,
  history: true,
  info: true,
  lint: true,
  list: true,
  memories: true,
  ping: true,
  preflight: true,
  prime: true,
  query: true,
  ready: true,
  recall: true,
  search: true,
  show: true,
  stale: true,
  status: true,
  statuses: true,
  types: true,
  version: true,
  where: true
};
var ADMIN_SUBCOMMANDS = {
  admin: true,
  backup: true,
  bootstrap: true,
  "codex-hook": true,
  compact: true,
  completion: true,
  config: true,
  dolt: true,
  flatten: true,
  gc: true,
  help: true,
  hooks: true,
  human: true,
  init: true,
  migrate: true,
  onboard: true,
  prune: true,
  purge: true,
  quickstart: true,
  "recompute-blocked": true,
  "rename-prefix": true,
  restore: true,
  setup: true,
  sql: true,
  upgrade: true,
  vc: true,
  worktree: true
};
var SUBCOMMAND = /^[a-z][a-z0-9-]*$/;
var READ_ACTIONS = {
  get: true,
  list: true,
  show: true,
  status: true,
  tree: true
};
var WRITE_ACTIONS = {
  add: true,
  append: true,
  claim: true,
  close: true,
  create: true,
  delete: true,
  edit: true,
  release: true,
  remove: true,
  resolve: true,
  rm: true,
  set: true,
  update: true
};
var ACTOR_VARS = ["BEADS_ACTOR", "BD_ACTOR"];
function writesBeads(invocation) {
  if (invocation.hasClaim)
    return invocation.subcommand !== "ready";
  const { subcommand } = invocation;
  if (!SUBCOMMAND.test(subcommand))
    return false;
  if (ADMIN_SUBCOMMANDS[subcommand] === true)
    return false;
  const action = invocation.positionals[0] ?? "";
  if (WRITE_ACTIONS[action] === true)
    return true;
  if (READ_ACTIONS[action] === true)
    return false;
  return READ_SUBCOMMANDS[subcommand] !== true;
}
function envCarriesActor(env) {
  if (env === null || typeof env !== "object")
    return false;
  const record = env;
  return ACTOR_VARS.some((variable) => {
    const value = record[variable];
    return typeof value === "string" && value.length > 0;
  });
}
var actorNotice = (invocation, env) => {
  if (!writesBeads(invocation))
    return;
  if (ACTOR_VARS.some((variable) => (invocation.assignments.get(variable) ?? "").length > 0))
    return;
  if (envCarriesActor(env))
    return;
  const { name } = operation(invocation);
  const written = invocation.hasClaim ? `${name} --claim` : name;
  return `WARN bd identity: 'bd ${written}' carries neither BEADS_ACTOR nor BD_ACTOR, so the write lands ` + `attributed to nobody. Prefix the command with both, set to the claimed bead's metadata.actor: ` + `'BEADS_ACTOR=<actor> BD_ACTOR=<actor> bd ${name} ...'.`;
};
var REDIRECTION = /^\d*(?:>>?|<)/;
var BODY_FLAG = /^--?[A-Za-z]\S*$/;
var EXPANSION = /[$`]/;
var SUBSTITUTION = /^`[^`]*`$/;
function commentBody(invocation) {
  const operands = invocation.positionals;
  let next = 0;
  for (let index = 0;index < invocation.rest.length; index++) {
    const token = invocation.rest[index];
    if (next >= operands.length || token !== operands[next])
      continue;
    next += 1;
    if (!BEAD_ID.test(token))
      continue;
    const text = invocation.rest[index + 1];
    if (text === undefined || BODY_FLAG.test(text) || REDIRECTION.test(text))
      return;
    return { id: token, text };
  }
  return;
}
var commentVerbNotice = (invocation) => {
  if (operation(invocation).name !== "comment")
    return;
  const body = commentBody(invocation);
  if (body === undefined || SUBSTITUTION.test(body.text.trim()))
    return;
  const verb = commentVerb(body.text);
  if (DECLARED_VERBS[verb] === true)
    return;
  if (EXPANSION.test(verb))
    return;
  return `WARN comment verb: 'bd comment ${body.id}' leads with '${verb}', which no protocol verb ` + `matches, so supervision reads your contract as unsatisfied and bounces you at exit over something ` + `this comment never showed you. Rewrite it now, leading with one of: ${VERB_LIST}. Case is free and ` + `decoration is normalised, but the first whitespace token is the whole signal, so 'NO WORK' parses ` + `as 'NO' and the underscored NO_WORK is the verb.`;
};
var TYPE_FLAGS = { "--type": true, "-t": true };
var PARENT_FLAGS = { "--parent": true };
var METADATA_FLAGS = { "--metadata": true, "--set-metadata": true };
var LABEL_FLAGS = { "--labels": true, "-l": true };
function jsonCarriesRole(value) {
  if (!value.trimStart().startsWith("{"))
    return false;
  try {
    const parsed = JSON.parse(value);
    if (parsed === null || typeof parsed !== "object" || !Object.hasOwn(parsed, ROUTING_KEY))
      return false;
    const role = parsed[ROUTING_KEY];
    return typeof role === "string" && role.length > 0;
  } catch {
    return false;
  }
}
function routesToRole(rest) {
  for (const { value } of flagOperands(rest, METADATA_FLAGS)) {
    if (value.startsWith("@"))
      return;
    const cut = value.indexOf("=");
    if (cut !== -1 && value.slice(0, cut) === ROUTING_KEY && value.length > cut + 1)
      return true;
    if (jsonCarriesRole(value))
      return true;
  }
  for (const { value } of flagOperands(rest, LABEL_FLAGS)) {
    if (value.split(",").some((label) => legacyRoleFromLabel(label.trim()) !== undefined))
      return true;
  }
  return false;
}
var bugRouteNotice = (invocation) => {
  if (operation(invocation).name !== "create")
    return;
  const type = flagOperands(invocation.rest, TYPE_FLAGS)[0];
  if (type?.value !== "bug")
    return;
  const parented = flagOperands(invocation.rest, PARENT_FLAGS).length > 0;
  const routed = routesToRole(invocation.rest);
  if (routed === undefined)
    return;
  if (parented && routed)
    return;
  const missing = [
    parented ? undefined : "--parent <epic>",
    routed ? undefined : `--metadata '{"${ROUTING_KEY}":"<role>"}'`
  ].filter((flag) => flag !== undefined);
  return `WARN bug bead: '${type.flag} ${type.value}' with no ${missing.join(" and no ")}, so the bead lands ` + `where no queue can reach it -- 'bd ready --parent <epic> --metadata-field ${ROUTING_KEY}=<role> ` + `--unassigned' is how a worker finds it, and the close-out gate faults it as stranded on a later ` + `session rather than on yours. Add ${missing.join(" and ")}: the epic you work under, and the role ` + `that would fix it, with the assignee left empty.`;
};
var NOTICES = [actorNotice, commentVerbNotice, bugRouteNotice];
async function gateBdDiscipline(pi, ctx, input) {
  const command = input.command;
  if (typeof command !== "string" || command.length === 0)
    return;
  const invocations = bdInvocations(command);
  if (invocations.length === 0)
    return;
  const run = await readActiveRun(ctx.cwd).catch(() => null);
  if (run === null)
    return;
  const notices = [];
  for (const invocation of invocations) {
    for (const notice of NOTICES) {
      const text = notice(invocation, input.env);
      if (text !== undefined && !notices.includes(text))
        notices.push(text);
    }
  }
  if (notices.length > 0) {
    pi.sendMessage({
      customType: BD_NOTICE_MESSAGE,
      content: notices.join(`
`),
      display: true,
      attribution: "user"
    }, { deliverAs: "steer" });
  }
  return;
}

// src/scope.ts
function compile(pattern) {
  const steps = [];
  for (let index = 0;index < pattern.length; index++) {
    const char = pattern[index];
    if (char === "*") {
      if (steps[steps.length - 1]?.kind !== "star")
        steps.push({ kind: "star" });
      continue;
    }
    if (char === "?") {
      steps.push({ kind: "any" });
      continue;
    }
    if (char !== "[") {
      steps.push({ kind: "literal", char });
      continue;
    }
    const close = pattern.indexOf("]", index + 1);
    if (close === -1) {
      steps.push({ kind: "literal", char });
      continue;
    }
    const group = pattern.slice(index + 1, close);
    index = close;
    const body = group.startsWith("!") ? `^${group.slice(1)}` : group;
    try {
      steps.push({ kind: "class", member: new RegExp(`^[${body}]$`, "s") });
    } catch {
      return null;
    }
  }
  return steps;
}
function matchSteps(text, steps) {
  let at = 0;
  let step = 0;
  let lastStar = -1;
  let resume = 0;
  while (at < text.length) {
    const current = steps[step];
    if (current?.kind === "star") {
      lastStar = step;
      step += 1;
      resume = at;
      continue;
    }
    const char = text[at];
    const hit = current !== undefined && (current.kind === "any" || (current.kind === "literal" ? current.char === char : current.member.test(char)));
    if (hit) {
      step += 1;
      at += 1;
      continue;
    }
    if (lastStar === -1)
      return false;
    step = lastStar + 1;
    resume += 1;
    at = resume;
  }
  while (steps[step]?.kind === "star")
    step += 1;
  return step === steps.length;
}
var MAX_GLOB_LENGTH = 1024;
function fnmatch(text, pattern) {
  if (text.length > MAX_GLOB_LENGTH || pattern.length > MAX_GLOB_LENGTH)
    return true;
  const steps = compile(pattern);
  if (steps === null)
    return true;
  return matchSteps(text, steps);
}
function deepWildcard(glob) {
  const cut = glob.lastIndexOf("/");
  return (cut === -1 ? "" : glob.slice(0, cut)).includes("*");
}
function literalPrefix(glob) {
  const star = glob.indexOf("*");
  const head = star === -1 ? glob : glob.slice(0, star);
  return head.replace(/\/+$/, "");
}
function scopesOverlap(a, b) {
  for (const globA of a) {
    const prefixA = literalPrefix(globA);
    for (const globB of b) {
      const prefixB = literalPrefix(globB);
      if (prefixA.length === 0 || prefixB.length === 0)
        return true;
      if (prefixA.startsWith(`${prefixB}/`) || prefixB.startsWith(`${prefixA}/`))
        return true;
      if (prefixA === prefixB) {
        if (!globA.includes("*") || !globB.includes("*"))
          return true;
        if (deepWildcard(globA) || deepWildcard(globB))
          return true;
        if (fnmatch(globA, globB) || fnmatch(globB, globA))
          return true;
        continue;
      }
      if (fnmatch(prefixA, globB) || fnmatch(prefixB, globA))
        return true;
      if (prefixA.startsWith(prefixB) && deepWildcard(globB) || prefixB.startsWith(prefixA) && deepWildcard(globA)) {
        return true;
      }
    }
  }
  return false;
}
function scopeOf(metadata) {
  const raw = metadata?.scope;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed))
        return parsed.filter((entry) => typeof entry === "string");
    } catch {
      return [raw];
    }
    return [raw];
  }
  if (Array.isArray(raw))
    return raw.filter((entry) => typeof entry === "string");
  return [];
}

// src/gates/claim.ts
function splitFlag2(token) {
  if (!token.startsWith("-"))
    return { flag: token };
  const cut = token.indexOf("=");
  if (cut === -1)
    return { flag: token };
  return { flag: token.slice(0, cut), inline: token.slice(cut + 1) };
}
var QUEUE_METADATA_FLAGS = { "--metadata-field": true };
var QUEUE_LABEL_FLAGS = { "--label": true, "-l": true, "--label-any": true };
function readyQueueRoles(rest) {
  const filters = [];
  for (let index = 0;index < rest.length; index++) {
    const { flag, inline } = splitFlag2(rest[index]);
    const value = inline ?? rest[index + 1];
    if (typeof value !== "string")
      continue;
    if (QUEUE_METADATA_FLAGS[flag] === true) {
      const cut = value.indexOf("=");
      if (cut === -1 || value.slice(0, cut) !== ROUTING_KEY)
        continue;
      filters.push({ role: value.slice(cut + 1), spelling: value });
      continue;
    }
    if (QUEUE_LABEL_FLAGS[flag] === true) {
      const role = legacyRoleFromLabel(value);
      if (role !== undefined)
        filters.push({ role, spelling: value });
    }
  }
  return filters;
}
var ROUTING_WRITERS = { architect: true };
var METADATA_WRITE_FLAGS = {
  "--metadata": true,
  "--set-metadata": true,
  "--unset-metadata": true
};
var ROUTING_WRITE_EXEMPT = { create: true };
function jsonCarriesRouting(value) {
  if (!value.trimStart().startsWith("{"))
    return false;
  try {
    const parsed = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && Object.hasOwn(parsed, ROUTING_KEY);
  } catch {
    return false;
  }
}
function routingMetadataWrite(invocation) {
  if (ROUTING_WRITE_EXEMPT[invocation.subcommand] === true)
    return;
  for (let index = 0;index < invocation.rest.length; index++) {
    const { flag, inline } = splitFlag2(invocation.rest[index]);
    if (METADATA_WRITE_FLAGS[flag] !== true)
      continue;
    const value = inline ?? invocation.rest[index + 1];
    if (typeof value !== "string")
      continue;
    if (flag === "--unset-metadata") {
      if (value.split(",").some((key) => key.trim() === ROUTING_KEY))
        return `${flag} ${ROUTING_KEY}`;
      continue;
    }
    const cut = value.indexOf("=");
    if (cut !== -1 && value.slice(0, cut) === ROUTING_KEY)
      return `${flag} ${value}`;
    if (jsonCarriesRouting(value))
      return `${flag} ${value}`;
  }
  return;
}
function routingWriteDenial(invocation, sessionRoleName) {
  if (sessionRoleName === undefined)
    return;
  if (ROUTING_WRITERS[sessionRoleName] === true)
    return;
  const written = routingMetadataWrite(invocation);
  if (written === undefined)
    return;
  return {
    block: true,
    reason: `'${written}' rewrites metadata.${ROUTING_KEY}, which is what routes the bead, and ${sessionRoleName} ` + `may not re-point work. Routing is assigned by the architect that decomposed the epic. Hand off with ` + `the next role's agent: label instead -- that is a signal, not a route -- and if the bead is genuinely ` + `misrouted, say so on an escalation wisp rather than re-routing it yourself. Filing new work routed is ` + `allowed: bd create carries ${ROUTING_KEY} freely.`
  };
}
function metadataRecord(bead) {
  const raw = bead?.metadata;
  if (raw && typeof raw === "object")
    return raw;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object")
        return parsed;
    } catch {
      return;
    }
  }
  return;
}
async function scopeConflict(bead) {
  if (!bead)
    return;
  const candidate = scopeOf(metadataRecord(bead));
  if (candidate.length === 0)
    return;
  const inFlight = await bdList(["list", "--label", "orc-node", "--status", "in_progress", "--json"]);
  for (const other of inFlight) {
    if (other.id === bead.id)
      continue;
    const otherScope = scopeOf(metadataRecord(other));
    if (otherScope.length === 0)
      continue;
    if (scopesOverlap(candidate, otherScope)) {
      return {
        block: true,
        reason: `scope conflict (friction guard): '${bead.id}' [${candidate.join(", ")}] overlaps in-flight ` + `'${other.id}' [${otherScope.join(", ")}]. Two agents must not share a file; wait for ` + `'${other.id}' to report, or re-scope one of the beads.`
      };
    }
  }
  return;
}
async function gateClaimEligibility(ctx, input) {
  const command = input.command;
  if (typeof command !== "string" || command.length === 0)
    return;
  const invocations = bdInvocations(command);
  if (invocations.length === 0)
    return;
  const sessionRoleName = orcRole(ctx);
  for (const invocation of invocations) {
    const denial = routingWriteDenial(invocation, sessionRoleName);
    if (denial)
      return denial;
  }
  const claims = invocations.filter((invocation) => invocation.hasClaim);
  if (claims.length === 0)
    return;
  for (const claim of claims) {
    const actor = claim.assignments.get("BEADS_ACTOR") ?? claim.assignments.get("BD_ACTOR") ?? "";
    if (claim.subcommand === "ready") {
      for (const filter of readyQueueRoles(claim.rest)) {
        if (sessionRoleName !== undefined && filter.role !== sessionRoleName) {
          return {
            block: true,
            reason: `queue '${filter.spelling}' does not match this session's role '${sessionRoleName}'; pull from your own queue`
          };
        }
      }
      if (actor.length > 0)
        recordClaim({ actor, beadIds: [] });
      continue;
    }
    for (const beadId of claim.positionals) {
      const bead = await bdShow(beadId);
      const routing = beadRouting(bead);
      if (routing !== undefined && sessionRoleName !== undefined && routing.role !== sessionRoleName) {
        return {
          block: true,
          reason: `bead '${beadId}' is routed to ${routing.spelling}; this session is ${sessionRoleName} and may not claim it`
        };
      }
      const conflict = await scopeConflict(bead);
      if (conflict)
        return conflict;
    }
    if (actor.length > 0)
      recordClaim({ actor, beadIds: claim.positionals });
  }
  return;
}

// src/gates/one-claim.ts
function claimedBeadIds(invocation) {
  const operands = invocation.positionals;
  let next = 0;
  let run = [];
  let longest = [];
  for (const token of invocation.rest) {
    if (next < operands.length && token === operands[next]) {
      next += 1;
      if (BEAD_ID.test(token) && !run.includes(token))
        run.push(token);
      continue;
    }
    if (run.length > longest.length)
      longest = run;
    run = [];
  }
  return run.length > longest.length ? run : longest;
}
function gateOneClaim(ctx, input) {
  const command = input.command;
  if (typeof command !== "string" || command.length === 0)
    return;
  if (orcRole(ctx) === undefined)
    return;
  for (const invocation of bdInvocations(command)) {
    if (!invocation.hasClaim)
      continue;
    if (invocation.subcommand === "ready")
      continue;
    const beadIds = claimedBeadIds(invocation);
    if (beadIds.length < 2)
      continue;
    return {
      block: true,
      reason: `'bd ${invocation.subcommand} --claim' names ${beadIds.length} beads (${beadIds.join(", ")}); one activation owns at most one bead. Claim '${beadIds[0]}', finish or release it, then claim the next \u2014 parallel work belongs to parallel agents, not parallel claims.`
    };
  }
  return;
}

// src/gates/readonly.ts
var BASH_PARAMS = ["command", "cwd", "env", "i", "pty", "timeout", "async"];
function beadWriteFreeEnv(pi, ctx) {
  return isBeadWriteFree(pi, ctx) ? { BD_READONLY: "1" } : undefined;
}
function reviseBashEnv(input, additions) {
  const existing = input.env;
  const env = existing !== null && typeof existing === "object" ? { ...existing } : {};
  let changed = false;
  for (const [key, value] of Object.entries(additions)) {
    if (env[key] === value)
      continue;
    env[key] = value;
    changed = true;
  }
  if (!changed)
    return;
  const revised = {};
  for (const key of BASH_PARAMS) {
    if (key in input)
      revised[key] = input[key];
  }
  revised.env = env;
  return { input: revised };
}

// src/gates/worktree.ts
import path3 from "path";
import fs2 from "fs/promises";
var GATED_WRITE_TOOLS = { bash: true, edit: true, write: true };
async function realpathOrUndefined(target) {
  try {
    return await fs2.realpath(target);
  } catch {
    return;
  }
}
function within(child, parent) {
  return child === parent || child.startsWith(`${parent}${path3.sep}`);
}
function isolationBase() {
  const configured = process.env.OMP_WORKTREE_DIR;
  if (configured !== undefined && configured.length > 0)
    return configured;
  return path3.join(process.env.HOME ?? "", ".omp", "wt");
}
var MAX_HOPS = 32;
var URI_TARGET = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;
async function resolveTarget(cwd, declared) {
  if (declared.includes("\x00") || URI_TARGET.test(declared))
    return;
  const absolute = path3.isAbsolute(declared);
  const { root } = path3.parse(declared);
  let resolved = absolute ? root : cwd;
  const pending = (absolute ? declared.slice(root.length) : declared).split(path3.sep).reverse();
  let hops = 0;
  while (pending.length > 0) {
    const segment = pending.pop();
    if (segment.length === 0 || segment === ".")
      continue;
    if (segment === "..") {
      resolved = path3.dirname(resolved);
      continue;
    }
    const candidate = path3.join(resolved, segment);
    let link;
    try {
      link = await fs2.readlink(candidate);
    } catch {}
    if (link === undefined) {
      resolved = candidate;
      continue;
    }
    if (++hops > MAX_HOPS)
      return;
    const linkRoot = path3.parse(link).root;
    if (linkRoot.length > 0)
      resolved = linkRoot;
    pending.push(...link.slice(linkRoot.length).split(path3.sep).reverse());
  }
  return resolved;
}
var SECTION_HEADER = /^\[(.+)#[0-9A-Fa-f]{4}\]\s*$/;
var MOVE_OP = /^MV\s+(?:"([^"]*)"|'([^']*)'|(\S.*?))\s*$/;
function hashlineTargets(raw) {
  if (typeof raw !== "string")
    return [];
  const targets = [];
  for (const line of raw.split(`
`)) {
    const section = SECTION_HEADER.exec(line);
    if (section?.[1] !== undefined) {
      targets.push(section[1]);
      continue;
    }
    const move = MOVE_OP.exec(line);
    const destination = move?.[1] ?? move?.[2] ?? move?.[3];
    if (destination !== undefined && destination.length > 0)
      targets.push(destination);
  }
  return targets;
}
function declaredTargets(toolName, input) {
  if (toolName === "write") {
    const target = input.path;
    return typeof target === "string" && target.length > 0 ? [target] : [];
  }
  if (toolName === "edit")
    return hashlineTargets(input.input);
  return [];
}
function names(relative, glob) {
  const trimmed = glob.replace(/^\.?\/+/, "").replace(/\/+$/, "");
  if (trimmed.length === 0)
    return true;
  return fnmatch(relative, trimmed) || fnmatch(relative, `${trimmed}/*`);
}
async function gateWorktreeScope(ctx, toolName, input) {
  const claim = observedClaim();
  if (!claim || claim.beadIds.length === 0)
    return;
  const cwd = await realpathOrUndefined(ctx.cwd);
  if (cwd === undefined)
    return;
  const base = await realpathOrUndefined(isolationBase());
  if (base !== undefined && within(cwd, base))
    return;
  const targets = [];
  for (const declared of declaredTargets(toolName, input)) {
    const resolved = await resolveTarget(cwd, declared);
    if (resolved !== undefined)
      targets.push({ declared, resolved });
  }
  const scoped = [];
  for (const beadId of claim.beadIds) {
    const bead = await bdShow(beadId);
    const declaredTree = metadataString(bead, "worktree");
    if (declaredTree === undefined)
      continue;
    const worktree = await realpathOrUndefined(declaredTree);
    if (worktree === undefined)
      continue;
    if (!within(cwd, worktree)) {
      return {
        block: true,
        reason: `this session's cwd does not match metadata.worktree on claimed bead '${beadId}'; another actor owns that tree`
      };
    }
    for (const target of targets) {
      if (within(target.resolved, worktree))
        continue;
      return {
        block: true,
        reason: `'${target.declared}' resolves to '${target.resolved}', outside metadata.worktree on claimed bead '${beadId}'; another actor owns that tree`
      };
    }
    const globs = scopeOf(bead?.metadata);
    if (globs.length > 0)
      scoped.push({ beadId, worktree, globs });
  }
  if (scoped.length === 0)
    return;
  for (const target of targets) {
    const named = scoped.some(({ worktree, globs }) => {
      const relative = path3.relative(worktree, target.resolved).split(path3.sep).join("/");
      if (relative.length === 0)
        return true;
      return globs.some((glob) => names(relative, glob));
    });
    if (named)
      continue;
    return {
      block: true,
      reason: `'${target.declared}' is named by no claimed bead's metadata.scope \u2014 ${scoped.map(({ beadId, globs }) => `${beadId} (${globs.join(", ")})`).join(", ")}`
    };
  }
  return;
}

// src/gates/wt-guard.ts
var FORBIDDEN = [
  {
    argv: ["git", "worktree"],
    reason: "worktrees are managed by wt; use 'wt switch --create <branch>' rather than 'git worktree'"
  },
  {
    argv: ["gh", "pr", "checkout"],
    reason: "use 'wt switch' rather than 'gh pr checkout'; the checkout must stay bound to its bead"
  }
];
function gateWorktrunkOwnership(input) {
  const command = input.command;
  if (typeof command !== "string" || command.length === 0)
    return;
  for (const forbidden of FORBIDDEN) {
    if (invokesCommand(command, forbidden.argv)) {
      return { block: true, reason: forbidden.reason };
    }
  }
  return;
}

// src/tools/bot-review-probe.ts
var EXIT_UNKNOWN = 2;
var EXIT_WAITING = 10;
var EXIT_STALE = 11;
var EXIT_ACTIONABLE = 12;
var EXIT_DECLINED = 13;
var DEFAULT_BOTS = "coderabbitai";
var MIN_SLUG_MATCH = 4;
var DECLINE_INDICATORS = /limit\s+(?:is\s+)?(?:currently\s+)?reached|fair\s+usage|rate[-\s]?limit|quota|usage\s+limit|review\s+skipped/i;
var WAIT_FIGURE = /(\d+)\s*\**\s*(minute|hour)s?/i;
function indicatesDecline(body) {
  return DECLINE_INDICATORS.test(body ?? "");
}
var ADAPTERS = {
  coderabbitai: {
    slug: "coderabbitai",
    count: (body) => {
      const digits = /actionable comments posted:\s*(?<n>\d+)/i.exec(body ?? "")?.groups?.n;
      if (digits === undefined)
        return null;
      const parsed = Number.parseInt(digits, 10);
      return Number.isSafeInteger(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
    },
    note: 'CodeRabbit summary line "Actionable comments posted: N"',
    declined: indicatesDecline
  }
};
var GENERIC_NOTE = "no adapter: review state only";
function adapterFor(slug) {
  const exact = Object.hasOwn(ADAPTERS, slug) ? ADAPTERS[slug] : undefined;
  if (exact)
    return exact;
  for (const known of Object.keys(ADAPTERS)) {
    if (related(normalize(slug), normalize(known)))
      return ADAPTERS[known];
  }
  return { slug, count: () => null, note: GENERIC_NOTE, declined: indicatesDecline };
}
function adapterNote(slug) {
  return adapterFor(slug).note;
}
function truthy(value) {
  if (value === undefined || value === null || value === false || value === "")
    return false;
  if (typeof value === "number")
    return value !== 0;
  if (Array.isArray(value))
    return value.length > 0;
  if (typeof value === "object")
    return Object.keys(value).length > 0;
  return true;
}
function str(value) {
  if (!truthy(value))
    return "";
  if (typeof value === "string")
    return value;
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function nested(row, outer, inner) {
  const value = row[outer];
  return isObject(value) ? str(value[inner]) : "";
}
function compare(left, right) {
  if (left < right)
    return -1;
  return left > right ? 1 : 0;
}
function normalize(value) {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}
function related(left, right) {
  if (left.length < MIN_SLUG_MATCH || right.length < MIN_SLUG_MATCH)
    return false;
  return left.includes(right) || right.includes(left);
}
function configuredSlugs(raw, env = process.env) {
  const source = raw ?? env.PR_REVIEW_BOTS ?? DEFAULT_BOTS;
  const slugs = [];
  for (const part of source.split(",")) {
    const slug = part.trim();
    if (slug !== "")
      slugs.push(slug.toLowerCase());
  }
  return slugs;
}
function isBotCheck(check, slugs) {
  const name = normalize(str(check.name));
  const url = normalize(str(check.detailsUrl));
  return slugs.some((slug) => related(name, normalize(slug)) || related(url, normalize(slug)));
}
function loginSlug(login, slugs) {
  const actual = (login ?? "").toLowerCase();
  for (const slug of slugs) {
    if (actual === slug || actual === `${slug}[bot]`)
      return slug;
  }
  return null;
}
var STATUS_API_TERMINAL = { success: true, failure: true, error: true };
function checkState(check) {
  const status = str(check.status).toLowerCase();
  if (status !== "")
    return status;
  const state = str(check.state).toLowerCase();
  return STATUS_API_TERMINAL[state] === true ? "completed" : state;
}
function waitMinutes(body) {
  const match = WAIT_FIGURE.exec(body ?? "");
  if (!match)
    return null;
  const value = Number.parseInt(match[1], 10);
  return match[2].toLowerCase() === "hour" ? value * 60 : value;
}
var ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?(?:(Z|z)|([+-])(\d{2}):?(\d{2}))?$/;
function parseInstant(at) {
  const match = ISO_INSTANT.exec(at ?? "");
  if (!match)
    return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  const fraction = match[7] === undefined ? 0 : Math.floor(Number(`0.${match[7]}`) * 1000);
  if (month < 1 || month > 12 || day < 1 || day > 31)
    return null;
  if (hour > 23 || minute > 59 || second > 59)
    return null;
  const stamp = Date.UTC(year, month - 1, day, hour, minute, second, fraction);
  const probe = new Date(stamp);
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    return null;
  }
  if (match[9] === undefined)
    return probe;
  const offsetHours = Number(match[10]);
  const offsetMinutes = Number(match[11]);
  if (offsetHours > 23 || offsetMinutes > 59)
    return null;
  const offset = (offsetHours * 60 + offsetMinutes) * 60000;
  return new Date(match[9] === "-" ? stamp + offset : stamp - offset);
}
function isoUtc(at) {
  const pad = (value, width = 2) => String(value).padStart(width, "0");
  const ms = at.getUTCMilliseconds();
  const fraction = ms === 0 ? "" : `.${pad(ms, 3)}000`;
  return `${pad(at.getUTCFullYear(), 4)}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}` + `T${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}:${pad(at.getUTCSeconds())}${fraction}+00:00`;
}
function reopenInstant(at, minutes) {
  const posted = parseInstant(at);
  if (posted === null)
    return null;
  const bounded = Math.max(0, Math.min(minutes, 7 * 24 * 60));
  return new Date(posted.getTime() + bounded * 60000);
}
function declines(notices, slugs, now) {
  const found = [];
  for (const notice of notices) {
    if (!isObject(notice))
      return "malformed";
    const slug = loginSlug(str(notice.login), slugs);
    const body2 = str(notice.body);
    if (slug === null || !adapterFor(slug).declined(body2))
      continue;
    found.push([str(notice.at), body2]);
  }
  const newest = found[0];
  if (newest === undefined)
    return null;
  let best = newest;
  for (const candidate of found) {
    const byTime = compare(candidate[0], best[0]);
    if (byTime > 0 || byTime === 0 && compare(candidate[1], best[1]) > 0)
      best = candidate;
  }
  const [at, body] = best;
  const minutes = waitMinutes(body);
  if (minutes === null) {
    return { wait: "UNKNOWN", detail: "bot declined the round; re-check before re-trigger" };
  }
  const reopen = reopenInstant(at, minutes);
  if (reopen === null) {
    return {
      wait: `${minutes}m`,
      detail: `bot declined the round for ${minutes}m from an unreadable timestamp; re-check before re-trigger`
    };
  }
  const stamp = isoUtc(reopen);
  if (reopen.getTime() <= now.getTime()) {
    return { wait: stamp, detail: `bot declined the round; window reopened at ${stamp}, re-trigger` };
  }
  return { wait: stamp, detail: `bot declined the round; retry after ${stamp}` };
}
function arrayField(value) {
  if (!truthy(value))
    return [];
  return Array.isArray(value) ? value : null;
}
function verdictOf(findings, verdict, code, detail) {
  return { code, verdict, findings: { ...findings, detail } };
}
function classifyBotReviews(payload, opts) {
  const { slugs, head } = opts;
  const now = opts.now ?? new Date;
  const findings = {
    head,
    bots: slugs.join(","),
    check: "none",
    actionable: 0,
    changesRequested: 0,
    summary: "none",
    wait: "none",
    detail: "",
    files: []
  };
  const unknown = (detail) => verdictOf(findings, "unknown", EXIT_UNKNOWN, detail);
  if ((head ?? "").trim() === "")
    return unknown("no head SHA to classify a round against");
  if (!isObject(payload))
    return unknown("payload must be a JSON object");
  const checks = arrayField(payload.checks);
  const reviews = arrayField(payload.reviews);
  const comments = arrayField(payload.comments);
  const notices = arrayField(payload.notices);
  if (checks === null || reviews === null || comments === null || notices === null) {
    return unknown("checks, reviews, comments, and notices must be arrays");
  }
  const botChecks = [];
  for (const check of checks) {
    if (isObject(check) && isBotCheck(check, slugs))
      botChecks.push(check);
  }
  const botReviews = [];
  const refusals = [...notices];
  for (const review of reviews) {
    if (!isObject(review))
      return unknown("each review must be an object");
    const slug = loginSlug(str(review.login), slugs);
    if (slug === null)
      continue;
    if (adapterFor(slug).declined(str(review.body)))
      refusals.push(review);
    else
      botReviews.push([slug, review]);
  }
  findings.check = botChecks.map((check) => `${str(check.name) || "?"}/${checkState(check) || "?"}`).join(",") || "none";
  const decline = declines(refusals, slugs, now);
  if (decline === "malformed")
    return unknown("each notice must be an object");
  if (botChecks.length === 0 && botReviews.length === 0 && decline === null) {
    return verdictOf(findings, "absent", 0, "no configured review bot on this PR");
  }
  if (botChecks.some((check) => checkState(check) !== "completed")) {
    return verdictOf(findings, "pending", EXIT_WAITING, "bot check still running");
  }
  const atHead = botReviews.filter(([, review]) => str(review.commit) === head);
  atHead.sort((left, right) => compare(str(left[1].at), str(right[1].at)));
  const newest = atHead[atHead.length - 1];
  if (newest === undefined) {
    if (botReviews.length === 0) {
      if (decline !== null) {
        return {
          code: EXIT_DECLINED,
          verdict: "declined",
          findings: { ...findings, wait: decline.wait, detail: decline.detail }
        };
      }
      return verdictOf(findings, "pending", EXIT_WAITING, "bot check complete, no review posted yet");
    }
    return verdictOf(findings, "stale", EXIT_STALE, "bot reviewed an older head only");
  }
  const latest = {
    actionable: adapterFor(newest[0]).count(str(newest[1].body)),
    changesRequested: str(newest[1].state) === "CHANGES_REQUESTED",
    url: str(newest[1].url)
  };
  const changes = latest.changesRequested ? 1 : 0;
  findings.changesRequested = changes;
  findings.summary = latest.url || "none";
  findings.files = [];
  for (const entry of comments) {
    if (!isObject(entry))
      continue;
    if (loginSlug(str(entry.login), slugs) === null || str(entry.commit) !== head)
      continue;
    const line = truthy(entry.line) ? str(entry.line) : truthy(entry.original_line) ? str(entry.original_line) : "0";
    findings.files.push(`${str(entry.path) || "?"}:${line} ${str(entry.url)}`.trim());
  }
  findings.files.sort(compare);
  if (latest.actionable === null) {
    if (changes) {
      return verdictOf(findings, "actionable", EXIT_ACTIONABLE, "changes requested without a summary count");
    }
    return verdictOf(findings, "pending", EXIT_WAITING, "no actionable-comment summary at head yet");
  }
  findings.actionable = latest.actionable;
  if (changes || latest.actionable > 0) {
    return verdictOf(findings, "actionable", EXIT_ACTIONABLE, `${latest.actionable} actionable comment(s)`);
  }
  return verdictOf(findings, "clean", 0, "0 actionable comments");
}
function renderBotReview(result) {
  const f = result.findings;
  const lines2 = [
    `BOT_REVIEW ${result.verdict} bots=${f.bots} head=${f.head} check=${f.check} ` + `actionable=${f.actionable} changes_requested=${f.changesRequested} ` + `summary=${f.summary} wait=${f.wait} detail="${f.detail}"`
  ];
  for (const entry of f.files)
    lines2.push(`COMMENT ${entry}`);
  return lines2.join(`
`);
}
function ghTimeoutMs(env = process.env) {
  const seconds = Number.parseInt(env.PR_SHEPHERD_GH_TIMEOUT ?? "", 10);
  return (Number.isFinite(seconds) && seconds > 0 ? seconds : 5) * 1000;
}
var spawnExec2 = async (argv, opts) => {
  const [bin, ...args] = argv;
  if (bin === undefined)
    return null;
  try {
    const proc = Bun.spawn([bin, ...args], { cwd: opts.cwd, stdout: "pipe", stderr: "pipe" });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, opts.timeoutMs ?? ghTimeoutMs());
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited
      ]);
      return timedOut ? null : { code, stdout, stderr };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
};
function prViewArgv(repo, pr) {
  return ["gh", "pr", "view", pr, "--repo", repo, "--json", "headRefOid,statusCheckRollup"];
}
function ghApiArgv(path4) {
  return ["gh", "api", "--paginate", "--slurp", path4];
}
async function ghJson(argv, exec, opts) {
  const label = argv.slice(1).join(" ");
  const result = await exec(argv, opts);
  if (result === null) {
    const seconds = (opts.timeoutMs ?? ghTimeoutMs()) / 1000;
    return { ok: false, error: `gh ${label} did not answer: gh is missing, or it exceeded ${seconds}s` };
  }
  if (result.code !== 0)
    return { ok: false, error: `gh ${label} failed: ${result.stderr.trim()}` };
  if (result.stdout.trim() === "") {
    return { ok: false, error: `gh ${label} exited 0 with empty output; refusing to read silence as an answer` };
  }
  try {
    return { ok: true, value: JSON.parse(result.stdout) };
  } catch (error) {
    return { ok: false, error: `gh ${label} returned unreadable JSON: ${String(error)}` };
  }
}
async function ghPaginatedJson(path4, exec, opts) {
  const read = await ghJson(ghApiArgv(path4), exec, opts);
  if (!read.ok)
    return read;
  if (!Array.isArray(read.value))
    return { ok: false, error: "paginated gh response must be an array of pages" };
  const rows = [];
  for (const page of read.value) {
    if (!Array.isArray(page))
      return { ok: false, error: "paginated gh response contains a malformed page" };
    for (const row of page) {
      if (!isObject(row))
        return { ok: false, error: "paginated gh response contains a malformed page" };
      rows.push(row);
    }
  }
  return { ok: true, value: rows };
}
async function fetchBotReviewEvidence(repo, pr, opts = {}) {
  const exec = opts.exec ?? spawnExec2;
  const run = { cwd: opts.cwd, timeoutMs: opts.timeoutMs ?? ghTimeoutMs() };
  const view = await ghJson(prViewArgv(repo, pr), exec, run);
  if (!view.ok)
    return { ok: false, error: view.error };
  const head = isObject(view.value) ? str(view.value.headRefOid) : "";
  if (head === "") {
    return {
      ok: false,
      error: `gh pr view ${pr} returned no headRefOid; refusing to treat an unanswered read as ` + "an absent review"
    };
  }
  const rollup = isObject(view.value) ? view.value.statusCheckRollup : undefined;
  const reviews = await ghPaginatedJson(`repos/${repo}/pulls/${pr}/reviews`, exec, run);
  if (!reviews.ok)
    return { ok: false, error: reviews.error };
  const comments = await ghPaginatedJson(`repos/${repo}/pulls/${pr}/comments`, exec, run);
  if (!comments.ok)
    return { ok: false, error: comments.error };
  const notices = await ghPaginatedJson(`repos/${repo}/issues/${pr}/comments`, exec, run);
  if (!notices.ok)
    return { ok: false, error: notices.error };
  return {
    ok: true,
    payload: {
      head,
      checks: truthy(rollup) ? rollup : [],
      reviews: reviews.value.map((r) => ({
        login: nested(r, "user", "login"),
        state: str(r.state),
        body: str(r.body),
        commit: str(r.commit_id),
        url: str(r.html_url),
        at: str(r.submitted_at)
      })),
      comments: comments.value.map((c) => ({
        login: nested(c, "user", "login"),
        path: str(c.path),
        line: truthy(c.line) ? c.line : truthy(c.original_line) ? c.original_line : 0,
        commit: str(c.commit_id),
        url: str(c.html_url)
      })),
      notices: notices.value.map((n) => ({
        login: nested(n, "user", "login"),
        body: str(n.body),
        at: str(n.created_at)
      }))
    }
  };
}
var PR_URL = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/;
var PR_QUALIFIED = /^([^/\s]+)\/([^/\s]+)[#/](\d+)$/;
var PR_NUMBER = /^#?(\d+)$/;
function parsePrRef(pr, repo) {
  const text = pr.trim();
  const url = PR_URL.exec(text);
  if (url?.[1] && url[2] && url[3])
    return { repo: `${url[1]}/${url[2]}`, number: url[3] };
  const qualified = PR_QUALIFIED.exec(text);
  if (qualified?.[1] && qualified[2] && qualified[3]) {
    return { repo: `${qualified[1]}/${qualified[2]}`, number: qualified[3] };
  }
  const bare = PR_NUMBER.exec(text);
  const owner = repo?.trim();
  if (bare?.[1] && owner)
    return { repo: owner, number: bare[1] };
  return null;
}
var NEVER_CLEAN = "unknown (2) and declined (13) are never to be treated as clean: unknown means the evidence could not " + "be read, declined means the bot refused the round and must be re-triggered.";
function unreadable(text, error) {
  return {
    content: [{ type: "text", text: `verdict: unknown (exit ${EXIT_UNKNOWN}) \u2014 ${text}
${NEVER_CLEAN}` }],
    details: { code: EXIT_UNKNOWN, verdict: "unknown", error },
    isError: true
  };
}
function registerBotReviewProbe(pi, exec = spawnExec2) {
  const z = pi.zod;
  const probeParams = z.object({
    pr: z.string().describe("PR reference: a github.com pull URL, `owner/repo#123`, or a number with `repo`"),
    repo: z.string().optional().describe("`owner/repo`, required when `pr` is a bare number"),
    bots: z.string().optional().describe("comma-separated bot slugs; defaults to $PR_REVIEW_BOTS"),
    cwd: z.string().optional().describe("working directory for the gh reads")
  });
  pi.registerTool({
    name: "orc_bot_review_probe",
    label: "Bot review probe",
    description: "Classify a PR's review-bot round (CodeRabbit, Copilot review, ...) at its exact head SHA. Reads the " + "PR with `gh` \u2014 `pr view` for the head and check rollup, then the reviews, review comments and issue " + "comments \u2014 and grades the latest round at that head. Verdicts: clean (0), absent (0), pending (10), " + `stale (11), actionable (12), declined (13), unknown (2). ${NEVER_CLEAN}`,
    parameters: probeParams,
    approval: "read",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const ref = parsePrRef(String(params.pr ?? ""), params.repo === undefined ? undefined : String(params.repo));
        if (!ref) {
          return unreadable(`cannot read a repository from pr=${JSON.stringify(params.pr)}. Pass a github.com pull URL, ` + "`owner/repo#123`, or a bare number together with `repo`.", "unreadable pr reference");
        }
        const fetched = await fetchBotReviewEvidence(ref.repo, ref.number, {
          exec,
          cwd: params.cwd ?? ctx.cwd
        });
        if (!fetched.ok) {
          return unreadable(`the PR read failed, so no round was classified.
${fetched.error}`, fetched.error);
        }
        const slugs = configuredSlugs(params.bots ? params.bots : undefined);
        const result = classifyBotReviews(fetched.payload, { head: fetched.payload.head, slugs });
        const adapters = slugs.map((slug) => `${slug}=${adapterNote(slug)}`).join("; ");
        const text = [
          `verdict: ${result.verdict} (exit ${result.code}) at head ${result.findings.head}`,
          renderBotReview(result),
          adapters === "" ? "" : `adapters: ${adapters}`,
          NEVER_CLEAN
        ].filter(Boolean).join(`
`);
        return {
          content: [{ type: "text", text }],
          details: {
            code: result.code,
            verdict: result.verdict,
            head: result.findings.head,
            actionable: result.findings.actionable,
            changesRequested: result.findings.changesRequested,
            wait: result.findings.wait,
            files: result.findings.files
          },
          isError: result.verdict === "unknown"
        };
      } catch (error) {
        return unreadable(`the probe failed: ${String(error)}`, "probe failed");
      }
    }
  });
}

// src/tools/conflict-probe.ts
var TIMEOUT_MS2 = 30000;
var OID = /^[0-9a-f]{40,64}$/i;
function revParseArgv(ref) {
  return ["git", "rev-parse", "--verify", `${ref}^{commit}`];
}
function mergeTreeArgv(base, branch) {
  return ["git", "merge-tree", "--write-tree", "--name-only", base, branch];
}
function mergeBaseArgv(base, branch) {
  return ["git", "merge-base", base, branch];
}
function diffNamesArgv(from, to) {
  return ["git", "diff", "--name-only", from, to];
}
function ghChecksArgv(pr) {
  return ["gh", "pr", "checks", pr];
}
function parseMergeTreeOutput(stdout) {
  const lines2 = stdout.split(`
`);
  const head = (lines2[0] ?? "").trim();
  if (!OID.test(head))
    return { clean: false, paths: [] };
  const seen = new Set;
  for (const raw of lines2.slice(1)) {
    const line = raw.trim();
    if (line === "")
      break;
    seen.add(line);
  }
  const paths = [...seen].sort();
  return { clean: paths.length === 0, paths };
}
function intersectPaths(a, b) {
  const right = new Set(b);
  const both = new Set;
  for (const path4 of a) {
    if (right.has(path4))
      both.add(path4);
  }
  return [...both].sort();
}
function lines2(stdout) {
  const out = [];
  for (const raw of stdout.split(`
`)) {
    const line = raw.trim();
    if (line !== "")
      out.push(line);
  }
  return out;
}
async function run(argv, cwd) {
  const [bin, ...args] = argv;
  if (bin === undefined)
    return null;
  try {
    const proc = Bun.spawn([bin, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill(), TIMEOUT_MS2);
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited
      ]);
      return { code, stdout, stderr };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}
function ok(text, details) {
  return { content: [{ type: "text", text }], details };
}
function fail(text, details) {
  return { content: [{ type: "text", text: `conflict-probe: ${text}` }], details, isError: true };
}
function missing(argv, mode) {
  const bin = argv[0] ?? "git";
  return fail(`${bin} not found (or failed to run)`, { mode, error: `${bin} not found` });
}
async function probeConflicts(base, branch, cwd) {
  const mode = "conflicts";
  const baseArgv = revParseArgv(base);
  const baseRev = await run(baseArgv, cwd);
  if (!baseRev)
    return missing(baseArgv, mode);
  if (baseRev.code !== 0)
    return fail(`bad base ${base}`, { mode, error: "bad ref" });
  const branchArgv = revParseArgv(branch);
  const branchRev = await run(branchArgv, cwd);
  if (!branchRev)
    return missing(branchArgv, mode);
  if (branchRev.code !== 0)
    return fail(`bad branch ${branch}`, { mode, error: "bad ref" });
  const baseSha = baseRev.stdout.trim();
  const branchSha = branchRev.stdout.trim();
  const argv = mergeTreeArgv(baseSha, branchSha);
  const merge = await run(argv, cwd);
  if (!merge)
    return missing(argv, mode);
  if (merge.code === 0)
    return ok("clean", { mode, clean: true, paths: [] });
  const { paths } = parseMergeTreeOutput(merge.stdout);
  if (paths.length === 0) {
    return fail(`merge-tree could not classify ${base} and ${branch}`, { mode, error: "unclassified" });
  }
  return ok(paths.join(`
`), { mode, clean: false, paths });
}
async function probePairwise(base, branch, branchB, cwd) {
  const mode = "pairwise";
  const sides = [];
  for (const side of [branch, branchB]) {
    const mergeBaseArgs = mergeBaseArgv(base, side);
    const mergeBase = await run(mergeBaseArgs, cwd);
    if (!mergeBase)
      return missing(mergeBaseArgs, mode);
    if (mergeBase.code !== 0)
      return fail(`cannot find merge base for ${base} and ${side}`, { mode, error: "no merge base" });
    const diffArgs = diffNamesArgv(mergeBase.stdout.trim(), side);
    const diff = await run(diffArgs, cwd);
    if (!diff)
      return missing(diffArgs, mode);
    if (diff.code !== 0)
      return fail(`cannot diff ${side}`, { mode, error: "diff failed" });
    sides.push(diff.stdout);
  }
  const overlap = intersectPaths(lines2(sides[0] ?? ""), lines2(sides[1] ?? ""));
  if (overlap.length === 0)
    return ok("disjoint", { mode, clean: true, overlap: [] });
  return ok(`overlap:
${overlap.join(`
`)}`, { mode, clean: false, overlap });
}
async function probeCi(pr, cwd) {
  const mode = "ci";
  const argv = ghChecksArgv(pr);
  const checks = await run(argv, cwd);
  if (!checks)
    return missing(argv, mode);
  const text = checks.stdout.trim() !== "" ? checks.stdout : checks.stderr;
  return ok(text.trim() === "" ? `gh pr checks exited ${checks.code} with no output` : text, {
    mode,
    exitCode: checks.code
  });
}
function registerConflictProbe(pi) {
  const z = pi.zod;
  pi.registerTool({
    name: "orc_conflict_probe",
    label: "Conflict Probe",
    description: "Predict merge conflicts and read CI without touching any tree. " + "`conflicts`: does <branch> merge cleanly into <base>? " + "`pairwise`: do <branch> and <branchB> touch the same files since <base>? " + "`ci`: what does `gh pr checks <pr>` say?",
    approval: "read",
    parameters: z.object({
      mode: z.enum(["conflicts", "pairwise", "ci"]).describe("conflicts: base vs branch merge prediction; pairwise: file overlap of two branches; ci: gh pr checks"),
      base: z.string().optional().describe("Base ref for `conflicts` and `pairwise` (required for both)"),
      branch: z.string().optional().describe("Branch ref to probe (required for `conflicts` and `pairwise`)"),
      branchB: z.string().optional().describe("Second branch ref, `pairwise` only"),
      pr: z.string().optional().describe("PR number or branch, `ci` only"),
      cwd: z.string().optional().describe("Repository directory to probe in; defaults to the session cwd")
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const cwd = params.cwd ?? ctx.cwd;
      try {
        switch (params.mode) {
          case "conflicts": {
            if (!params.base || !params.branch) {
              return fail("conflicts needs base and branch", { mode: "conflicts", error: "missing arguments" });
            }
            return await probeConflicts(params.base, params.branch, cwd);
          }
          case "pairwise": {
            if (!params.base || !params.branch || !params.branchB) {
              return fail("pairwise needs base, branch and branchB", { mode: "pairwise", error: "missing arguments" });
            }
            return await probePairwise(params.base, params.branch, params.branchB, cwd);
          }
          case "ci": {
            if (!params.pr)
              return fail("ci needs pr", { mode: "ci", error: "missing arguments" });
            return await probeCi(params.pr, cwd);
          }
        }
      } catch (err) {
        return fail(String(err), { mode: params.mode, error: "probe failed" });
      }
    }
  });
}

// src/tools/resolve-queue-dispatch.ts
import path4 from "path";
var REPOSITORY_RE = /^[^/\s]+\/[^/\s]+$/;
var HEAD_SHA_RE = /^[0-9a-fA-F]{7,64}$/;
var REQUIRED_PULL_REQUEST_FIELDS = [
  "repository",
  "number",
  "title",
  "headSha",
  "baseRef",
  "labels",
  "priority",
  "draft",
  "mergeable",
  "checks",
  "createdAt",
  "updatedAt",
  "state",
  "activeSince"
];
var LIFECYCLE_TRANSITIONS = {
  opened: true,
  updated: true,
  failed: true,
  merged: true,
  closed: true
};
var LIFECYCLE_SOURCES = { webhook: true, reconciliation: true };
var CHECK_STATES = { pass: true, pending: true, fail: true };
var QUEUE_STATES = { active: true, queued: true, blocked: true, closed: true };
var TERMINAL_TRANSITIONS = { failed: true, merged: true, closed: true };

class ContractError extends Error {
  name = "ContractError";
}

class ResolutionError extends Error {
  name = "ResolutionError";
}

class UnmatchedError extends ResolutionError {
  name = "UnmatchedError";
}
function isObject2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}
function isInt(value) {
  return typeof value === "number" && Number.isInteger(value);
}
function pyList(values) {
  return `[${Object.keys(values).sort().map((value) => `'${value}'`).join(", ")}]`;
}
function pyInt(value) {
  if (typeof value === "number")
    return Number.isFinite(value) ? Math.trunc(value) : null;
  if (typeof value === "string") {
    const text = value.trim();
    if (!/^[+-]?\d+(?:_\d+)*$/.test(text))
      return null;
    return Number(text.replace(/_/g, ""));
  }
  return null;
}
function labelSet(node) {
  const labels = node.labels;
  if (labels === undefined)
    return new Set;
  if (Array.isArray(labels))
    return new Set(labels.filter((label) => typeof label === "string"));
  if (typeof labels === "string")
    return new Set(labels);
  if (isObject2(labels))
    return new Set(Object.keys(labels));
  throw new ContractError("node labels must be an array of strings");
}
function liveNode(entry) {
  if (!isObject2(entry) || entry.status !== "in_progress")
    return null;
  return isObject2(entry.metadata) ? { node: entry, metadata: entry.metadata } : null;
}
function nodePr(metadata) {
  if (typeof metadata.pr === "boolean")
    return null;
  return pyInt(metadata.pr);
}
function validateRecord(record) {
  if (!isObject2(record))
    throw new ContractError("watcher record must be a JSON object");
  if (record.type !== "dispatch")
    return null;
  const pullRequest = record.pullRequest;
  if (!isObject2(pullRequest))
    throw new ContractError("dispatch.pullRequest must be a JSON object");
  const missing2 = REQUIRED_PULL_REQUEST_FIELDS.filter((field) => !(field in pullRequest)).sort();
  if (missing2.length > 0) {
    throw new ContractError(`dispatch.pullRequest missing fields: ${missing2.join(", ")}`);
  }
  const { repository, number, headSha, priority, labels } = pullRequest;
  if (typeof repository !== "string" || !REPOSITORY_RE.test(repository)) {
    throw new ContractError("repository must be OWNER/REPO");
  }
  if (!isInt(number) || number < 1)
    throw new ContractError("number must be a positive integer");
  if (typeof headSha !== "string" || !HEAD_SHA_RE.test(headSha)) {
    throw new ContractError("headSha must be a hexadecimal Git object id");
  }
  if (!isInt(priority) || priority < 0 || priority > 4) {
    throw new ContractError("priority must be an integer from 0 through 4");
  }
  if (!Array.isArray(labels) || !labels.every((label) => typeof label === "string")) {
    throw new ContractError("labels must be an array of strings");
  }
  for (const field of ["title", "baseRef", "createdAt", "updatedAt", "activeSince"]) {
    if (!isNonEmptyString(pullRequest[field]))
      throw new ContractError(`${field} must be a non-empty string`);
  }
  if (pullRequest.draft !== false)
    throw new ContractError("dispatch must describe a non-draft pull request");
  if (pullRequest.mergeable !== true)
    throw new ContractError("dispatch must describe a mergeable pull request");
  if (pullRequest.checks !== "pass")
    throw new ContractError("dispatch checks must be pass");
  if (pullRequest.state !== "active")
    throw new ContractError("dispatch state must be active");
  return pullRequest;
}
function validateLifecycleRecord(record) {
  if (!isObject2(record))
    throw new ContractError("watcher record must be a JSON object");
  if (record.type !== "pr-lifecycle")
    return null;
  const { transition, source, lifecycleKey } = record;
  if (typeof transition !== "string" || LIFECYCLE_TRANSITIONS[transition] !== true) {
    throw new ContractError(`transition must be one of ${pyList(LIFECYCLE_TRANSITIONS)}`);
  }
  if (typeof source !== "string" || LIFECYCLE_SOURCES[source] !== true) {
    throw new ContractError(`source must be one of ${pyList(LIFECYCLE_SOURCES)}`);
  }
  if (!isNonEmptyString(lifecycleKey))
    throw new ContractError("lifecycleKey must be a non-empty string");
  const pullRequest = record.pullRequest;
  if (!isObject2(pullRequest))
    throw new ContractError("pr-lifecycle.pullRequest must be a JSON object");
  const missing2 = REQUIRED_PULL_REQUEST_FIELDS.filter((field) => !(field in pullRequest)).sort();
  if (missing2.length > 0) {
    throw new ContractError(`pr-lifecycle.pullRequest missing fields: ${missing2.join(", ")}`);
  }
  const { repository, number, headSha, checks, state, activeSince } = pullRequest;
  if (typeof repository !== "string" || !REPOSITORY_RE.test(repository)) {
    throw new ContractError("repository must be OWNER/REPO");
  }
  if (!isInt(number) || number < 1)
    throw new ContractError("number must be a positive integer");
  if (typeof headSha !== "string" || !HEAD_SHA_RE.test(headSha)) {
    throw new ContractError("headSha must be a hexadecimal Git object id");
  }
  const priority = pullRequest.priority;
  if (!isInt(priority) || priority < 0 || priority > 4) {
    throw new ContractError("priority must be an integer from 0 through 4");
  }
  if (!Array.isArray(pullRequest.labels) || !pullRequest.labels.every((label) => typeof label === "string")) {
    throw new ContractError("labels must be an array of strings");
  }
  for (const field of ["title", "baseRef", "createdAt", "updatedAt"]) {
    if (!isNonEmptyString(pullRequest[field]))
      throw new ContractError(`${field} must be a non-empty string`);
  }
  if (typeof pullRequest.draft !== "boolean")
    throw new ContractError("draft must be a boolean");
  if (pullRequest.mergeable !== null && typeof pullRequest.mergeable !== "boolean") {
    throw new ContractError("mergeable must be a boolean or null");
  }
  if (typeof checks !== "string" || CHECK_STATES[checks] !== true) {
    throw new ContractError(`checks must be one of ${pyList(CHECK_STATES)}`);
  }
  if (typeof state !== "string" || QUEUE_STATES[state] !== true) {
    throw new ContractError(`state must be one of ${pyList(QUEUE_STATES)}`);
  }
  if (activeSince !== null && !isNonEmptyString(activeSince)) {
    throw new ContractError("activeSince must be a non-empty string or null");
  }
  if (transition === "failed" && checks !== "fail")
    throw new ContractError("failed lifecycle checks must be fail");
  if ((transition === "merged" || transition === "closed") && state !== "closed") {
    throw new ContractError("terminal lifecycle pullRequest.state must be closed");
  }
  if (source === "webhook") {
    for (const field of ["deliveryId", "webhookAction"]) {
      if (!isNonEmptyString(record[field])) {
        throw new ContractError(`webhook lifecycle ${field} must be a non-empty string`);
      }
    }
  }
  return { transition, source, lifecycleKey, pullRequest };
}
function deliveryState(metadata, prefix, eventKey) {
  if (metadata[`${prefix}_ack`] === eventKey)
    return "ack";
  if (metadata[`${prefix}_sent`] === eventKey)
    return "sent";
  if (metadata[`${prefix}_pending`] === eventKey)
    return "pending";
  return "untracked";
}
function validateReceiptLineage(metadata, prefix, eventKey) {
  const currentKey = metadata[prefix];
  const acknowledgedKey = metadata[`${prefix}_ack`];
  const receipts = [
    [`${prefix}_pending`, metadata[`${prefix}_pending`]],
    [`${prefix}_sent`, metadata[`${prefix}_sent`]],
    [`${prefix}_ack`, acknowledgedKey]
  ];
  for (const [field, value] of receipts) {
    if (value !== undefined && value !== null && !isNonEmptyString(value)) {
      throw new ResolutionError(`${field} must be a non-empty string`);
    }
  }
  if (currentKey === eventKey) {
    const completedPriorKey = typeof acknowledgedKey === "string" && acknowledgedKey !== eventKey ? acknowledgedKey : null;
    const mismatched = receipts.filter(([, value]) => value !== undefined && value !== null).filter(([, value]) => value !== eventKey && value !== completedPriorKey).map(([field]) => field);
    if (mismatched.length > 0) {
      throw new ResolutionError(`${prefix} receipt mismatch in ${mismatched.join(", ")}`);
    }
    return;
  }
  const matching = receipts.filter(([, value]) => value === eventKey).map(([field]) => field);
  if (matching.length > 0) {
    throw new ResolutionError(`${prefix} does not match receipts in ${matching.join(", ")}`);
  }
  if (isNonEmptyString(currentKey) && acknowledgedKey !== currentKey) {
    throw new ResolutionError(`cannot replace unacknowledged ${prefix} ${currentKey}`);
  }
}
function ensureUniqueNodeOwnership(nodes) {
  const owners = new Map;
  for (const entry of nodes) {
    const live = liveNode(entry);
    if (!live || !labelSet(live.node).has("orc-node"))
      continue;
    const number = nodePr(live.metadata);
    if (number === null)
      continue;
    const repository = live.metadata.repo;
    if (typeof repository !== "string" || !REPOSITORY_RE.test(repository))
      continue;
    const identity = `${repository}\x00${number}`;
    const existing = owners.get(identity);
    const owner = String(live.node.id);
    if (existing !== undefined) {
      throw new ResolutionError(`duplicate orchestrate node ownership for ${repository}#${number}: ${existing} and ${owner}`);
    }
    owners.set(identity, owner);
  }
}
function handoffResult(node, metadata, repository, number, headSha, dispatchKey, status, priority) {
  if (!isNonEmptyString(node.id))
    throw new ResolutionError("approved node is missing its id");
  for (const field of ["branch", "base_sha"]) {
    if (!isNonEmptyString(metadata[field]))
      throw new ResolutionError(`approved node is missing metadata.${field}`);
  }
  let state = deliveryState(metadata, "queue_dispatch", dispatchKey);
  let requiredMetadata = {};
  if (status === "resolved") {
    state = null;
    requiredMetadata = { queue_dispatch: dispatchKey, queue_dispatch_pending: dispatchKey };
  } else if (status === "replay" && state === "untracked") {
    requiredMetadata = { queue_dispatch_pending: dispatchKey };
  }
  const result = {
    status,
    deliveryState: state,
    requiredMetadata,
    node: node.id,
    dispatchKey,
    repository,
    number,
    headSha,
    branch: metadata.branch,
    baseSha: metadata.base_sha
  };
  if (priority !== undefined)
    result.priority = priority;
  return result;
}
function lifecycleResult(node, metadata, lifecycle, status) {
  const identifier = node.id;
  if (!isNonEmptyString(identifier))
    throw new ResolutionError("orchestrate node is missing its id");
  const { pullRequest, lifecycleKey, transition } = lifecycle;
  const wakeShepherd = labelSet(node).has("state:approved") || TERMINAL_TRANSITIONS[transition] === true;
  if (wakeShepherd) {
    for (const field of ["branch", "base_sha"]) {
      if (!isNonEmptyString(metadata[field])) {
        throw new ResolutionError(`orchestrate node is missing metadata.${field}`);
      }
    }
  }
  let state = deliveryState(metadata, "queue_lifecycle", lifecycleKey);
  let requiredMetadata = {};
  if (status === "resolved") {
    state = null;
    requiredMetadata = {
      queue_lifecycle: lifecycleKey,
      queue_lifecycle_head: pullRequest.headSha,
      queue_lifecycle_transition: transition
    };
    requiredMetadata[wakeShepherd ? "queue_lifecycle_pending" : "queue_lifecycle_ack"] = lifecycleKey;
  } else if (status === "replay" && state === "untracked") {
    requiredMetadata = { [wakeShepherd ? "queue_lifecycle_pending" : "queue_lifecycle_ack"]: lifecycleKey };
  }
  const anchoredHead = metadata.head_sha;
  const result = {
    status,
    eventType: "pr-lifecycle",
    deliveryState: state,
    requiredMetadata,
    node: identifier,
    lifecycleKey,
    transition,
    source: lifecycle.source,
    wakeShepherd,
    repository: pullRequest.repository,
    number: pullRequest.number,
    headSha: pullRequest.headSha,
    headChanged: typeof anchoredHead === "string" && anchoredHead !== pullRequest.headSha
  };
  if (wakeShepherd) {
    result.branch = metadata.branch;
    result.baseSha = metadata.base_sha;
  }
  return result;
}
function nodeList(nodesValue) {
  const nodes = isObject2(nodesValue) && "data" in nodesValue && "schema_version" in nodesValue ? nodesValue.data : nodesValue;
  if (!Array.isArray(nodes))
    throw new ContractError("nodes snapshot must be a JSON array");
  return nodes;
}
function resolveLifecycle(lifecycle, nodesValue) {
  const nodes = nodeList(nodesValue);
  const pullRequest = lifecycle.pullRequest;
  const candidates = [];
  for (const entry of nodes) {
    const live = liveNode(entry);
    if (!live || !labelSet(live.node).has("orc-node"))
      continue;
    const number = nodePr(live.metadata);
    if (number === null)
      continue;
    if (live.metadata.repo === pullRequest.repository && number === pullRequest.number)
      candidates.push(live);
  }
  const reference = `${String(pullRequest.repository)}#${String(pullRequest.number)}`;
  if (candidates.length === 0)
    throw new UnmatchedError(`no orchestrate node for ${reference}`);
  if (candidates.length !== 1) {
    throw new ResolutionError(`expected one orchestrate node for ${reference}, found ${candidates.length}`);
  }
  const { node, metadata } = candidates[0];
  const lifecycleKey = lifecycle.lifecycleKey;
  validateReceiptLineage(metadata, "queue_lifecycle", lifecycleKey);
  const status = metadata.queue_lifecycle_ack === lifecycleKey ? "duplicate" : metadata.queue_lifecycle === lifecycleKey ? "replay" : "resolved";
  return lifecycleResult(node, metadata, lifecycle, status);
}
function resolve(record, nodesValue) {
  if (isObject2(record) && (record.type === "webhook-error" || record.type === "reconcile-error")) {
    const message = record.message;
    if (!isNonEmptyString(message))
      throw new ContractError("watcher error message must be a non-empty string");
    const repository2 = record.repository;
    if (repository2 !== undefined && repository2 !== null && (typeof repository2 !== "string" || !REPOSITORY_RE.test(repository2))) {
      throw new ContractError("watcher error repository must be OWNER/REPO");
    }
    return {
      status: "fallback",
      recordType: record.type,
      action: "gate-check-and-pass",
      message,
      repository: repository2 ?? null
    };
  }
  const lifecycle = validateLifecycleRecord(record);
  if (lifecycle !== null)
    return resolveLifecycle(lifecycle, nodesValue);
  const pullRequest = validateRecord(record);
  if (pullRequest === null) {
    return { status: "ignored", recordType: isObject2(record) ? record.type ?? null : null };
  }
  const nodes = nodeList(nodesValue);
  const repository = pullRequest.repository;
  const number = pullRequest.number;
  const headSha = pullRequest.headSha;
  const candidates = [];
  for (const entry of nodes) {
    const live = liveNode(entry);
    if (!live || !labelSet(live.node).has("state:approved"))
      continue;
    const nodeNumber = nodePr(live.metadata);
    if (nodeNumber === null)
      continue;
    const { repo, head_sha } = live.metadata;
    if (repo === repository && nodeNumber === number && head_sha === headSha)
      candidates.push(live);
  }
  const key = `${repository}#${number}@${headSha}`;
  if (candidates.length === 0)
    throw new UnmatchedError(`no approved node for ${key}`);
  if (candidates.length !== 1) {
    throw new ResolutionError(`expected one approved node for ${key}, found ${candidates.length}`);
  }
  const { node, metadata } = candidates[0];
  validateReceiptLineage(metadata, "queue_dispatch", key);
  const status = metadata.queue_dispatch_ack === key ? "duplicate" : metadata.queue_dispatch === key ? "replay" : "resolved";
  return handoffResult(node, metadata, repository, number, headSha, key, status, pullRequest.priority);
}
var byNodeId = (a, b) => a.node < b.node ? -1 : a.node > b.node ? 1 : 0;
function replayUnacknowledged(nodesValue) {
  const nodes = nodeList(nodesValue);
  ensureUniqueNodeOwnership(nodes);
  const handoffs = [];
  for (const entry of nodes) {
    const live = liveNode(entry);
    if (!live || !labelSet(live.node).has("state:approved"))
      continue;
    const { node, metadata } = live;
    const dispatchKey = metadata.queue_dispatch;
    if (!isNonEmptyString(dispatchKey))
      continue;
    validateReceiptLineage(metadata, "queue_dispatch", dispatchKey);
    if (metadata.queue_dispatch_ack === dispatchKey)
      continue;
    const { repo, head_sha } = metadata;
    const number = nodePr(metadata);
    if (number === null || number < 1)
      throw new ResolutionError("queued node has invalid metadata.pr");
    if (typeof repo !== "string" || !REPOSITORY_RE.test(repo)) {
      throw new ResolutionError("queued node has invalid metadata.repo");
    }
    if (typeof head_sha !== "string" || !HEAD_SHA_RE.test(head_sha)) {
      throw new ResolutionError("queued node has invalid metadata.head_sha");
    }
    if (dispatchKey !== `${repo}#${number}@${head_sha}`) {
      throw new ResolutionError("queued node dispatch key does not match its identity");
    }
    handoffs.push(handoffResult(node, metadata, repo, number, head_sha, dispatchKey, "replay"));
  }
  return handoffs.sort(byNodeId);
}
function replayUnacknowledgedLifecycles(nodesValue) {
  const nodes = nodeList(nodesValue);
  ensureUniqueNodeOwnership(nodes);
  const handoffs = [];
  for (const entry of nodes) {
    const live = liveNode(entry);
    if (!live || !labelSet(live.node).has("orc-node"))
      continue;
    const { node, metadata } = live;
    const lifecycleKey = metadata.queue_lifecycle;
    if (!isNonEmptyString(lifecycleKey))
      continue;
    validateReceiptLineage(metadata, "queue_lifecycle", lifecycleKey);
    if (metadata.queue_lifecycle_ack === lifecycleKey)
      continue;
    const transition = metadata.queue_lifecycle_transition;
    const headSha = metadata.queue_lifecycle_head;
    const repository = metadata.repo;
    const number = nodePr(metadata);
    if (number === null)
      throw new ResolutionError("queued node has invalid metadata.pr");
    if (typeof transition !== "string" || LIFECYCLE_TRANSITIONS[transition] !== true) {
      throw new ResolutionError("queued node has invalid lifecycle transition");
    }
    if (typeof repository !== "string" || !REPOSITORY_RE.test(repository)) {
      throw new ResolutionError("queued node has invalid metadata.repo");
    }
    if (number < 1)
      throw new ResolutionError("queued node has invalid metadata.pr");
    if (typeof headSha !== "string" || !HEAD_SHA_RE.test(headSha)) {
      throw new ResolutionError("queued node has invalid lifecycle head");
    }
    const lifecycle = {
      transition,
      source: "replay",
      lifecycleKey,
      pullRequest: { repository, number, headSha }
    };
    handoffs.push(lifecycleResult(node, metadata, lifecycle, "replay"));
  }
  return handoffs.sort(byNodeId);
}
function dispatchMeaning(code) {
  switch (code) {
    case 0:
      return "resolved/replay/duplicate/control record";
    case 1:
      return "invalid input";
    case 2:
      return "no orchestrate owner: safe to route once to pr-shepherd resolve-queue-event";
    case 3:
      return "ambiguous or invalid orchestrate ownership: do not reroute";
    default:
      return "unrecognised exit code: treat as unresolved and do not reroute";
  }
}
function actionsFor(result) {
  const owed = "dispatches" in result ? [...result.dispatches, ...result.lifecycles] : ("requiredMetadata" in result) ? [result] : [];
  const actions = [];
  for (const item of owed) {
    if (Object.keys(item.requiredMetadata).length > 0) {
      actions.push({ node: item.node, metadata: item.requiredMetadata });
    }
  }
  return actions;
}
function failed(code, error) {
  return { code, meaning: dispatchMeaning(code), result: null, actions: [], error };
}
function message(error) {
  return error instanceof Error ? error.message : String(error);
}
function resolveQueueDispatch(record, nodes, opts = {}) {
  try {
    const result = opts.replayUnacknowledged === true ? {
      status: "replay",
      dispatches: replayUnacknowledged(nodes),
      lifecycles: replayUnacknowledgedLifecycles(nodes)
    } : resolve(record, nodes);
    return { code: 0, meaning: dispatchMeaning(0), result, actions: actionsFor(result), error: null };
  } catch (error) {
    if (error instanceof ContractError)
      return failed(1, `invalid watcher record: ${message(error)}`);
    if (error instanceof UnmatchedError)
      return failed(2, `unmatched watcher record: ${message(error)}`);
    if (error instanceof ResolutionError)
      return failed(3, `unresolved watcher record: ${message(error)}`);
    return failed(1, `resolve-queue-dispatch failed: ${message(error)}`);
  }
}
function canonicalJson(value) {
  return JSON.stringify(sortKeys(value)).replace(/[\u0080-\uffff]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
function sortKeys(value) {
  if (Array.isArray(value))
    return value.map(sortKeys);
  if (!isObject2(value))
    return value;
  const sorted = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined)
      sorted[key] = sortKeys(value[key]);
  }
  return sorted;
}
var readSnapshotFile = (file) => Bun.file(file).text();
var DESCRIPTION = [
  "Resolve one release-queue-watch JSON record to an orchestrate node, read-only.",
  "Matches a dispatch to the approved node at that exact head, matches a pr-lifecycle record",
  "to the PR's owner, and reconciles crash-replay receipts. Codes: 0 resolved/replay/duplicate/",
  "control, 1 invalid input, 2 no orchestrate owner (safe to route once to pr-shepherd",
  "resolve-queue-event), 3 ambiguous or invalid ownership (do not reroute).",
  "Never mutates a bead: apply `actions` yourself once delivery is arranged."
].join(" ");
function report(outcome) {
  const text = [
    `exit ${outcome.code}: ${outcome.meaning}`,
    outcome.result === null ? "" : canonicalJson(outcome.result),
    outcome.error ?? ""
  ].filter(Boolean).join(`
`);
  const details = { code: outcome.code, meaning: outcome.meaning };
  if (outcome.result !== null)
    details.status = outcome.result.status;
  if (outcome.actions.length > 0)
    details.actions = outcome.actions;
  if (outcome.error !== null)
    details.error = outcome.error;
  return { content: [{ type: "text", text }], details, isError: outcome.code !== 0 };
}
function registerResolveQueueDispatch(pi, read = readSnapshotFile) {
  const z = pi.zod;
  const dispatchParams = z.object({
    record: z.string().optional().describe("the watcher record JSON; omit only with replayUnacknowledged"),
    nodesFile: z.string().optional().describe("path to a `bd list --json` snapshot; a bd envelope is unwrapped"),
    nodes: z.string().optional().describe("the snapshot inline as a JSON array; takes precedence over nodesFile"),
    replayUnacknowledged: z.boolean().optional().describe("emit approved dispatches and lifecycles lacking a matching ack; reads no record"),
    cwd: z.string().optional().describe("directory a relative nodesFile is resolved against")
  });
  pi.registerTool({
    name: "orc_resolve_queue_dispatch",
    label: "Resolve queue dispatch",
    description: DESCRIPTION,
    parameters: dispatchParams,
    approval: "read",
    async execute(_id, params) {
      const replay = params.replayUnacknowledged === true;
      let nodes;
      if (params.nodes !== undefined) {
        try {
          nodes = JSON.parse(params.nodes);
        } catch (error) {
          return report(failed(1, `invalid watcher record: nodes is not JSON: ${message(error)}`));
        }
      } else if (params.nodesFile !== undefined) {
        const file = params.cwd === undefined ? params.nodesFile : path4.resolve(params.cwd, params.nodesFile);
        try {
          nodes = JSON.parse(await read(file));
        } catch (error) {
          return report(failed(1, `invalid watcher record: cannot read JSON from ${file}: ${message(error)}`));
        }
      } else {
        return report(failed(1, "invalid watcher record: pass `nodes` or `nodesFile`; neither was given"));
      }
      let record;
      if (!replay) {
        if (params.record === undefined || params.record === "") {
          return report(failed(1, "invalid watcher JSON: no record was given; pass `record`, or set " + "`replayUnacknowledged` to scan the snapshot instead"));
        }
        try {
          record = JSON.parse(params.record);
        } catch (error) {
          return report(failed(1, `invalid watcher JSON: ${message(error)}`));
        }
      }
      return report(resolveQueueDispatch(record, nodes, { replayUnacknowledged: replay }));
    }
  });
}

// src/tools/run-status.ts
var TYPE_ORDER = { epic: 0, feature: 1, task: 2, bug: 3, decision: 4, chore: 5 };
var STATE_MARK = {
  closed: "\u25CF",
  active: "\u25D0",
  claimed: "\u25D1",
  blocked: "\u25CC",
  deferred: "\u25C7",
  ready: "\u25CB"
};
function field(bead, key) {
  const value = bead[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function metaString(bead, key) {
  const direct = metadataString(bead, key);
  if (direct !== undefined)
    return direct;
  const raw = bead.metadata;
  if (typeof raw !== "string")
    return;
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object")
      return;
    const value = parsed[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  } catch {
    return;
  }
}
function deriveState(bead, blocked = new Set) {
  const status = bead.status ?? "";
  if (status === "closed")
    return "closed";
  if (status === "deferred")
    return "deferred";
  for (const label of bead.labels ?? []) {
    if (label.startsWith("state:")) {
      const phase = label.slice("state:".length);
      if (phase.length > 0)
        return phase;
    }
  }
  if (status === "blocked" || blocked.has(bead.id))
    return "blocked";
  if (status === "in_progress")
    return "active";
  if (status === "open")
    return bead.assignee ? "claimed" : "ready";
  return status.length > 0 ? status : "unknown";
}
function toNode(bead, blocked) {
  const node = {
    id: bead.id,
    title: field(bead, "title") ?? "",
    type: field(bead, "issue_type") ?? "",
    state: deriveState(bead, blocked),
    blocked: blocked.has(bead.id)
  };
  const assignee = bead.assignee;
  if (typeof assignee === "string" && assignee.length > 0)
    node.assignee = assignee;
  const role = metaString(bead, "role");
  if (role !== undefined)
    node.role = role;
  const runEpic = metaString(bead, "run_epic");
  if (runEpic !== undefined)
    node.run_epic = runEpic;
  const originActor = metaString(bead, "origin_actor");
  if (originActor !== undefined)
    node.origin_actor = originActor;
  const originBead = metaString(bead, "origin_bead");
  if (originBead !== undefined)
    node.origin_bead = originBead;
  const origin = metaString(bead, "origin");
  if (origin !== undefined)
    node.origin = origin;
  const parent = field(bead, "parent");
  if (parent !== undefined)
    node.parent = parent;
  return node;
}
function tally(nodes) {
  const counts = {};
  for (const node of nodes)
    counts[node.state] = (counts[node.state] ?? 0) + 1;
  return counts;
}
function epicNodes(epic) {
  const nodes = [];
  for (const feature of epic.features) {
    nodes.push(feature, ...feature.tasks);
  }
  nodes.push(...epic.tasks);
  return nodes;
}
function progress(counts) {
  let all = 0;
  for (const count of Object.values(counts))
    all += count;
  if (all === 0)
    return "no children";
  const done = counts.closed ?? 0;
  return `${done}/${all} closed (${Math.round(100 * done / all)}%)`;
}
function buildStatusTree(beads, blockedIds) {
  const blocked = new Set(blockedIds);
  const known = new Set(beads.map((bead) => bead.id));
  const childrenOf = new Map;
  for (const bead of beads) {
    const parent = field(bead, "parent");
    if (parent === undefined)
      continue;
    const siblings = childrenOf.get(parent);
    if (siblings)
      siblings.push(bead);
    else
      childrenOf.set(parent, [bead]);
  }
  const rank = (bead) => TYPE_ORDER[field(bead, "issue_type") ?? ""] ?? 9;
  for (const siblings of childrenOf.values()) {
    siblings.sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
  }
  const placed = new Set;
  const descendants = (root) => {
    const out = [];
    const walk = (id) => {
      for (const kid of childrenOf.get(id) ?? []) {
        if (placed.has(kid.id))
          continue;
        placed.add(kid.id);
        out.push(kid);
        walk(kid.id);
      }
    };
    walk(root);
    return out;
  };
  const roots = beads.filter((bead) => {
    if (field(bead, "issue_type") !== "epic")
      return false;
    const parent = field(bead, "parent");
    return parent === undefined || !known.has(parent);
  }).sort((a, b) => a.id.localeCompare(b.id));
  const epics = [];
  for (const root of roots) {
    placed.add(root.id);
    const features = [];
    const tasks = [];
    for (const child of childrenOf.get(root.id) ?? []) {
      if (placed.has(child.id))
        continue;
      placed.add(child.id);
      const kin = descendants(child.id).map((bead) => toNode(bead, blocked));
      if (field(child, "issue_type") === "feature") {
        features.push({ ...toNode(child, blocked), tasks: kin, counts: tally(kin) });
      } else {
        tasks.push(toNode(child, blocked), ...kin);
      }
    }
    const epic = { ...toNode(root, blocked), features, tasks, counts: {} };
    epic.counts = tally(epicNodes(epic));
    epics.push(epic);
  }
  const orphans = beads.filter((bead) => !placed.has(bead.id)).sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id)).map((bead) => toNode(bead, blocked));
  return { epics, orphans, blocked: retainedBlocked({ epics, orphans, blocked: [] }) };
}
function retainedBlocked(tree) {
  const ids = [];
  for (const epic of tree.epics) {
    for (const node of [epic, ...epicNodes(epic)]) {
      if (node.blocked)
        ids.push(node.id);
    }
  }
  for (const node of tree.orphans) {
    if (node.blocked)
      ids.push(node.id);
  }
  return ids;
}
function heldBy(node, actor) {
  return node.assignee === actor || node.role === actor;
}
function filterTree(tree, filter) {
  const { epic: wantEpic, feature: wantFeature, actor } = filter;
  if (wantEpic === undefined && wantFeature === undefined && actor === undefined)
    return tree;
  const epics = [];
  for (const epic of tree.epics) {
    if (wantEpic !== undefined && epic.id !== wantEpic)
      continue;
    let features = wantFeature === undefined ? epic.features : epic.features.filter((f) => f.id === wantFeature);
    let tasks = wantFeature === undefined ? epic.tasks : [];
    if (actor !== undefined) {
      features = features.map((feature) => {
        const kept = feature.tasks.filter((task) => heldBy(task, actor));
        return { ...feature, tasks: kept, counts: tally(kept) };
      }).filter((feature) => feature.tasks.length > 0 || heldBy(feature, actor));
      tasks = tasks.filter((task) => heldBy(task, actor));
    }
    if (wantFeature !== undefined && features.length === 0)
      continue;
    if (actor !== undefined && features.length === 0 && tasks.length === 0 && !heldBy(epic, actor))
      continue;
    const next = { ...epic, features, tasks, counts: {} };
    next.counts = tally(epicNodes(next));
    epics.push(next);
  }
  let orphans = wantEpic === undefined && wantFeature === undefined ? tree.orphans : [];
  if (actor !== undefined)
    orphans = orphans.filter((node) => heldBy(node, actor));
  const filtered = { epics, orphans, blocked: [] };
  filtered.blocked = retainedBlocked(filtered);
  return filtered;
}
function statusSummaryLine(tree) {
  const features = tree.epics.reduce((sum, epic) => sum + epic.features.length, 0);
  const tasks = tree.epics.reduce((sum, epic) => sum + epic.tasks.length + epic.features.reduce((n, f) => n + f.tasks.length, 0), 0);
  const bits = [
    `${tree.epics.length} epics`,
    `${features} features`,
    `${tasks} tasks`,
    `${tree.blocked.length} blocked`
  ];
  if (tree.orphans.length > 0)
    bits.push(`${tree.orphans.length} unparented`);
  return bits.join(" \xB7 ");
}
function nodeLine(node, indent) {
  const bits = [];
  if (node.assignee)
    bits.push(`@${node.assignee}`);
  else if (node.role)
    bits.push(`role=${node.role}`);
  if (node.blocked)
    bits.push("blocked");
  if (node.run_epic)
    bits.push(`run_epic=${node.run_epic}`);
  if (node.origin_actor)
    bits.push(`origin_actor=${node.origin_actor}`);
  if (node.origin_bead)
    bits.push(`origin_bead=${node.origin_bead}`);
  if (node.origin)
    bits.push(`origin=${node.origin}`);
  const tail = bits.length > 0 ? `  [${bits.join(" ")}]` : "";
  return `${indent}${STATE_MARK[node.state] ?? "?"} ${node.id.padEnd(12)} ${node.state.padEnd(11)} ${node.title}${tail}`;
}
function countsLine(counts) {
  const parts = Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)).map(([state, count]) => `${state} ${count}`);
  return parts.length > 0 ? parts.join("  ") : "no children";
}
function renderStatus(tree, opts = {}) {
  const lines3 = [statusSummaryLine(tree)];
  const filter = opts.filter ?? {};
  const named = [
    filter.epic !== undefined ? `epic=${filter.epic}` : "",
    filter.feature !== undefined ? `feature=${filter.feature}` : "",
    filter.actor !== undefined ? `actor=${filter.actor}` : ""
  ].filter((bit) => bit.length > 0);
  if (named.length > 0)
    lines3.push(`filter: ${named.join(" ")}`);
  if (tree.epics.length === 0 && tree.orphans.length === 0) {
    lines3.push("", "no matching epic, feature, or bead");
    return lines3.join(`
`);
  }
  for (const epic of tree.epics) {
    lines3.push("", `EPIC  ${epic.id}  ${epic.title}  [${epic.state}]`);
    lines3.push(`  ${progress(epic.counts)}   ${countsLine(epic.counts)}`);
    for (const feature of epic.features) {
      lines3.push(nodeLine(feature, "  "));
      lines3.push(`      ${progress(feature.counts)}`);
      if (opts.full) {
        for (const task of feature.tasks)
          lines3.push(nodeLine(task, "      "));
      }
    }
    if (epic.tasks.length > 0) {
      lines3.push(`  direct tasks (${epic.tasks.length}): ${countsLine(tally(epic.tasks))}`);
      if (opts.full) {
        for (const task of epic.tasks)
          lines3.push(nodeLine(task, "  "));
      }
    }
    const blocked = epicNodes(epic).filter((node) => node.blocked);
    if (blocked.length > 0)
      lines3.push(`  BLOCKED (${blocked.length}): ${blocked.map((n) => n.id).join(", ")}`);
  }
  if (tree.orphans.length > 0) {
    lines3.push("", `UNPARENTED (${tree.orphans.length}): ${countsLine(tally(tree.orphans))}`);
    if (opts.full) {
      for (const node of tree.orphans)
        lines3.push(nodeLine(node, "  "));
    }
  }
  return lines3.join(`
`);
}
function parseBlockedIds(stdout) {
  const brace = stdout.indexOf("{");
  const bracket = stdout.indexOf("[");
  const candidates = [brace, bracket].filter((index) => index !== -1);
  if (candidates.length === 0)
    return [];
  let payload;
  try {
    payload = JSON.parse(stdout.slice(Math.min(...candidates)));
  } catch {
    return [];
  }
  if (payload !== null && typeof payload === "object" && !Array.isArray(payload) && "data" in payload) {
    payload = payload.data;
  }
  const entries = Array.isArray(payload) ? payload : [payload];
  const ids = [];
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object")
      continue;
    const id = entry.id;
    if (typeof id === "string" && id.length > 0)
      ids.push(id);
  }
  return ids;
}
var DESCRIPTION2 = [
  "Standardised beads run status: rolls each epic up through its features to their tasks,",
  "deriving per-bead state from status, `state:` labels, and assignee, and marking what",
  "`bd blocked` reports as blocked. Reads only; never mutates a bead.",
  "Use this instead of hand-assembling a summary from `bd list`, which loses blockers and",
  "the feature rollup."
].join(" ");
function registerRunStatus(pi) {
  const z = pi.zod;
  pi.registerTool({
    name: "orc_run_status",
    label: "Run status",
    description: DESCRIPTION2,
    approval: "read",
    parameters: z.object({
      epic: z.string().optional().describe("Report only this epic, by bead id."),
      feature: z.string().optional().describe("Report only this feature (one architect domain), by bead id."),
      actor: z.string().optional().describe("Report only what this actor holds, by assignee or metadata.role."),
      full: z.boolean().optional().describe("Include one line per bead. Off, only rollups and counts.")
    }),
    async execute(_toolCallId, params) {
      try {
        const [beads, blockedResult] = await Promise.all([
          bdList(["list", "--status", "all", "--json"]),
          bdRun(["blocked", "--json"])
        ]);
        if (beads.length === 0) {
          const unreachable = blockedResult === null;
          const text = unreachable ? "bd is unavailable (binary missing, or the read timed out); no run status could be read." : "no beads found (is this a beads workspace?)";
          return {
            content: [{ type: "text", text }],
            details: { epics: [], orphans: [], blocked: [] },
            isError: unreachable
          };
        }
        const blockedIds = blockedResult !== null && blockedResult.code === 0 ? parseBlockedIds(blockedResult.stdout) : [];
        const filter = {};
        if (params.epic !== undefined)
          filter.epic = params.epic;
        if (params.feature !== undefined)
          filter.feature = params.feature;
        if (params.actor !== undefined)
          filter.actor = params.actor;
        const tree = filterTree(buildStatusTree(beads, blockedIds), filter);
        return {
          content: [{ type: "text", text: renderStatus(tree, { full: params.full === true, filter }) }],
          details: tree
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `run status could not be built: ${String(error)}` }],
          details: { epics: [], orphans: [], blocked: [] },
          isError: true
        };
      }
    }
  });
}

// src/watchers.ts
import fs3 from "fs/promises";
import path5 from "path";
var PROGRESS_CHANNEL = "task:subagent:progress";
var SUBAGENT_EVENT_CHANNEL = "task:subagent:event";
var MCP_STATUS_CHANNEL = "mcp:connection-status";
var LSP_STARTUP_CHANNEL = "lsp:startup";
var GOAL_RELAY_MESSAGE = "com.srobroek.omp-orchestrate.goal-relay";
var SETTINGS_PREFLIGHT_MESSAGE = "com.srobroek.omp-orchestrate.settings-preflight";
var DECLARED_MODEL_ROLES = ["reviewer"];
var PENDING_RUN = "pending";
function logFailure(pi, watcher, error) {
  pi.logger.error(`orchestrate ${watcher} failed`, {
    error: error instanceof Error ? error.message : String(error)
  });
}
async function boundEpic(cwd) {
  const run2 = await readActiveRun(cwd);
  if (run2 === null || run2.run_id === PENDING_RUN)
    return;
  return run2.run_id;
}
var SWEEP_MS = 60000;
var DEFAULT_STALL_MINUTES = 10;
function stallMinutes() {
  const configured = Number(process.env.ORC_STALL_MINUTES);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_STALL_MINUTES;
}
function progressSample(data) {
  if (data === null || typeof data !== "object" || !("progress" in data))
    return;
  const progress2 = data.progress;
  if (progress2 === null || typeof progress2 !== "object")
    return;
  if (!("id" in progress2) || typeof progress2.id !== "string" || progress2.id.length === 0)
    return;
  const tokens = "tokens" in progress2 && typeof progress2.tokens === "number" ? progress2.tokens : 0;
  const lines3 = "recentOutput" in progress2 && Array.isArray(progress2.recentOutput) ? progress2.recentOutput.filter((line) => typeof line === "string") : [];
  const status = "status" in progress2 ? progress2.status : undefined;
  return {
    child: progress2.id,
    tokens,
    output: lines3.join(`
`),
    terminal: status === "completed" || status === "failed" || status === "aborted"
  };
}
var activity = new Map;
function noteProgress(sample, atMs) {
  if (sample.terminal) {
    activity.delete(sample.child);
    return;
  }
  const seen = activity.get(sample.child);
  if (seen === undefined) {
    activity.set(sample.child, {
      tokens: sample.tokens,
      output: sample.output,
      changedMs: atMs,
      flagged: false
    });
    return;
  }
  if (seen.tokens === sample.tokens && seen.output === sample.output)
    return;
  seen.tokens = sample.tokens;
  seen.output = sample.output;
  seen.changedMs = atMs;
}
function sweepStalls(atMs, thresholdMs) {
  const flagged = [];
  for (const [child, state] of activity) {
    if (state.flagged)
      continue;
    const silentMs = atMs - state.changedMs;
    if (silentMs < thresholdMs)
      continue;
    state.flagged = true;
    flagged.push({ child, silentMinutes: Math.round(silentMs / 60000) });
  }
  return flagged;
}
async function reportStall(flag) {
  const bead = await claimedBead(flag.child);
  if (bead === null)
    return;
  const notice = `STALL child ${flag.child} silent ${flag.silentMinutes}m on ${bead.id}`;
  await bdRun(["comment", bead.id, notice]);
  await bdRun([
    "create",
    notice,
    "--ephemeral",
    "--wisp-type",
    "error",
    "--deps",
    `relates-to:${bead.id}`,
    "--silent"
  ]);
}
async function sweep(pi) {
  const flagged = sweepStalls(Date.now(), stallMinutes() * 60000);
  if (flagged.length === 0)
    return;
  resetReadBudget();
  for (const flag of flagged) {
    try {
      await reportStall(flag);
    } catch (error) {
      logFailure(pi, "stall report", error);
    }
  }
}
var MUTATING_SUBCOMMANDS = {
  update: true,
  close: true,
  create: true,
  comment: true,
  label: true,
  dep: true,
  reopen: true,
  "set-state": true
};
function bdMutation(command) {
  for (const invocation of bdInvocations(command)) {
    if (MUTATING_SUBCOMMANDS[invocation.subcommand] === true)
      return invocation.subcommand;
  }
  return;
}
var configuredAuditDir;
function auditDir(cwd) {
  return configuredAuditDir ?? path5.join(cwd, ".orchestration", "audit");
}
var MAX_AUDIT_STEM = 200;
function auditFileName(child) {
  const safe = child.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
  if (safe.length === 0)
    return;
  return `${safe.slice(0, MAX_AUDIT_STEM)}.bdlog`;
}
async function appendAudit(dir, entry) {
  const name = auditFileName(entry.child);
  if (name === undefined)
    return;
  await fs3.mkdir(dir, { recursive: true });
  await fs3.appendFile(path5.join(dir, name), `${JSON.stringify(entry)}
`, "utf8");
}
function exitCodeOf(result, isError) {
  if (result !== null && typeof result === "object" && "details" in result) {
    const details = result.details;
    if (details !== null && typeof details === "object" && "exitCode" in details) {
      if (typeof details.exitCode === "number")
        return details.exitCode;
    }
  }
  return isError ? 1 : 0;
}
var pendingBd = new Map;
var PENDING_LIMIT = 256;
function childOf(data) {
  if (data === null || typeof data !== "object")
    return;
  if (!("id" in data) || typeof data.id !== "string" || data.id.length === 0)
    return;
  return data.id;
}
function bdMutationEvent(data) {
  const child = childOf(data);
  if (child === undefined || data === null || typeof data !== "object" || !("event" in data))
    return;
  const event = data.event;
  if (event === null || typeof event !== "object" || !("type" in event))
    return;
  if (!("toolName" in event) || event.toolName !== "bash")
    return;
  if (!("toolCallId" in event) || typeof event.toolCallId !== "string")
    return;
  const key = `${child}\x00${event.toolCallId}`;
  if (event.type === "tool_execution_start") {
    if (!("args" in event) || event.args === null || typeof event.args !== "object")
      return;
    const args = event.args;
    if (!("command" in args) || typeof args.command !== "string")
      return;
    if (bdMutation(args.command) === undefined)
      return;
    if (pendingBd.size >= PENDING_LIMIT) {
      const oldest = pendingBd.keys().next();
      if (!oldest.done)
        pendingBd.delete(oldest.value);
    }
    pendingBd.set(key, { child, command: args.command });
    return;
  }
  if (event.type !== "tool_execution_end")
    return;
  const pending = pendingBd.get(key);
  pendingBd.delete(key);
  const result = "result" in event ? event.result : undefined;
  const isError = "isError" in event && event.isError === true;
  const exitCode = exitCodeOf(result, isError);
  const own = "args" in event && event.args !== null && typeof event.args === "object" ? event.args : undefined;
  if (own !== undefined && "command" in own && typeof own.command === "string") {
    if (bdMutation(own.command) === undefined)
      return;
    return { child, command: own.command, exitCode };
  }
  if (pending === undefined)
    return;
  return { child: pending.child, command: pending.command, exitCode };
}
var degraded = new Set;
function degradedSet() {
  return [...degraded].sort();
}
function noteMcpStatus(data) {
  if (data === null || typeof data !== "object" || !("type" in data))
    return;
  if (!("serverName" in data) || typeof data.serverName !== "string")
    return;
  const item = `mcp:${data.serverName}`;
  if (data.type === "failed")
    degraded.add(item);
  else if (data.type === "connected")
    degraded.delete(item);
}
function noteLspStartup(data) {
  if (data === null || typeof data !== "object" || !("type" in data))
    return;
  if (data.type === "failed") {
    degraded.add("lsp:startup");
    return;
  }
  if (data.type !== "completed")
    return;
  if (!("servers" in data))
    return;
  const servers = data.servers;
  if (!Array.isArray(servers))
    return;
  for (const server of servers) {
    if (server === null || typeof server !== "object")
      continue;
    if (!("name" in server) || typeof server.name !== "string")
      continue;
    const item = `lsp:${server.name}`;
    if ("status" in server && server.status === "error")
      degraded.add(item);
    else
      degraded.delete(item);
  }
}
var PREFLIGHT_INTERVAL_MS = 10 * 60000;
var lastPreflightMs = Number.NEGATIVE_INFINITY;
async function warnPreflight(cwd, atMs) {
  const items = degradedSet();
  if (items.length === 0)
    return;
  if (atMs - lastPreflightMs < PREFLIGHT_INTERVAL_MS)
    return;
  const epic = await boundEpic(cwd);
  if (epic === undefined)
    return;
  lastPreflightMs = atMs;
  await bdRun(["comment", epic, `WARN preflight: ${items.join(", ")} degraded`]);
}
var relayedGoal;
function runEpics(epics, runId) {
  if (runId === undefined)
    return [...epics];
  return epics.filter((epic) => epic.id === runId || epic.parent === runId || metadataString(epic, "run_epic") === runId || metadataString(epic, "origin") === runId);
}
async function relayGoal(pi, cwd, goal) {
  const key = `${goal.id}\x00${goal.status}\x00${goal.objective}`;
  if (key === relayedGoal)
    return;
  relayedGoal = key;
  resetReadBudget();
  const open = await bdList(["list", "--type", "epic", "--status", "open,in_progress", "--json"]);
  const targets = runEpics(open, await boundEpic(cwd));
  if (targets.length === 0)
    return;
  for (const epic of targets) {
    await bdRun(["comment", epic.id, `GOAL ${goal.status}: ${goal.objective}`]);
  }
  pi.sendMessage({
    customType: GOAL_RELAY_MESSAGE,
    content: `GOAL ${goal.status} stamped on ${targets.map((epic) => epic.id).join(", ")}`,
    display: true
  }, { triggerTurn: false });
}
var REQUIRED_SETTINGS = [
  {
    key: "task.isolation.mode",
    want: "anything but none",
    satisfied: (value) => typeof value === "string" && value !== "none",
    consequence: "workers share the architect's tree, so two claims can edit one file"
  },
  {
    key: "task.isolation.merge",
    want: "branch",
    satisfied: (value) => value === "branch",
    consequence: "commits are replayed as a patch instead of captured as a branch, so no omp/task/<id> branch survives to integrate or to recover after a crash"
  },
  {
    key: "task.isolation.apply",
    want: "false",
    satisfied: (value) => value === false,
    consequence: "child work is merged into the spawning tree automatically, so the architect never owns integration"
  },
  {
    key: "task.enableEffort",
    want: "true",
    satisfied: (value) => value === true,
    consequence: "the per-spawn effort is silently ignored, so every agent runs at the session default"
  },
  {
    key: "task.maxRecursionDepth",
    want: "3 or more",
    satisfied: (value) => typeof value === "number" && value >= 3,
    consequence: "a worker's helper sits at depth 3, so at the default 2 no worker can spawn librarian, scout, or operator"
  }
];
function settingsDeviations(observed2) {
  const found = [];
  for (const requirement of REQUIRED_SETTINGS) {
    if (!(requirement.key in observed2))
      continue;
    const value = observed2[requirement.key];
    if (requirement.satisfied(value))
      continue;
    found.push({
      key: requirement.key,
      observed: value,
      want: requirement.want,
      consequence: requirement.consequence
    });
  }
  return found;
}
async function readSetting(key, cwd) {
  const bin = process.env.OMP_BIN ?? "omp";
  try {
    const proc = Bun.spawn([bin, "config", "get", key, "--json"], {
      cwd,
      stdout: "pipe",
      stderr: "pipe"
    });
    const timer = setTimeout(() => proc.kill(), 1e4);
    try {
      const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      if (code !== 0)
        return;
      const parsed = JSON.parse(stdout);
      if (parsed === null || typeof parsed !== "object" || !("value" in parsed))
        return;
      return parsed.value;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return;
  }
}
var settingsChecked = false;
async function sharedBeadsDatabase(cwd) {
  if (process.env.BEADS_DOLT_SHARED_SERVER === "1")
    return true;
  const config = await fs3.readFile(path5.join(cwd, ".beads", "config.yaml"), "utf8").catch(() => "");
  if (/^[^#\n]*\bshared-server:\s*true/m.test(config))
    return true;
  const metadata = await fs3.readFile(path5.join(cwd, ".beads", "metadata.json"), "utf8").catch(() => "");
  try {
    const parsed = JSON.parse(metadata);
    if (parsed !== null && typeof parsed === "object" && "dolt_mode" in parsed) {
      return parsed.dolt_mode === "server";
    }
  } catch {}
  return false;
}
var OWNABLE_VALUES = {
  "task.isolation.mode": "auto",
  "task.isolation.merge": "branch",
  "task.isolation.apply": false,
  "task.enableEffort": true,
  "task.maxRecursionDepth": 3
};
function renderYaml(node, indent = "") {
  let out = "";
  for (const [key, value] of Object.entries(node)) {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      out += `${indent}${key}:
${renderYaml(value, `${indent}  `)}`;
    } else {
      out += `${indent}${key}: ${JSON.stringify(value)}
`;
    }
  }
  return out;
}
async function ensureProjectSettings(cwd, keys) {
  const ownable = keys.filter((key) => (key in OWNABLE_VALUES));
  if (ownable.length === 0)
    return;
  const file = path5.join(cwd, ".omp", "config.yml");
  let root = {};
  const existing = await fs3.readFile(file, "utf8").catch(() => {
    return;
  });
  if (existing !== undefined && existing.trim().length > 0) {
    try {
      const parsed = Bun.YAML.parse(existing);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
        return;
      root = structuredClone(parsed);
    } catch {
      return;
    }
  }
  for (const key of ownable) {
    const segments = key.split(".");
    let node = root;
    for (const segment of segments.slice(0, -1)) {
      const next = node[segment];
      if (next === null || typeof next !== "object" || Array.isArray(next))
        node[segment] = {};
      node = node[segment];
    }
    node[segments[segments.length - 1]] = OWNABLE_VALUES[key];
  }
  try {
    await fs3.mkdir(path5.dirname(file), { recursive: true });
    await fs3.writeFile(file, renderYaml(root));
    return file;
  } catch {
    return;
  }
}
async function preflightSettings(pi, cwd) {
  if (settingsChecked)
    return [];
  settingsChecked = true;
  const observed2 = {};
  for (const { key } of REQUIRED_SETTINGS) {
    const value = await readSetting(key, cwd);
    if (value !== undefined)
      observed2[key] = value;
  }
  const deviations = settingsDeviations(observed2);
  const lines3 = deviations.map((deviation) => `${deviation.key} is ${JSON.stringify(deviation.observed)}, needs ${deviation.want} -- ${deviation.consequence}`);
  const mode = observed2["task.isolation.mode"];
  const isolating = typeof mode === "string" && mode !== "none";
  const tracked = await fs3.stat(path5.join(cwd, ".beads")).then((entry) => entry.isDirectory()).catch(() => false);
  if (tracked && isolating && !await sharedBeadsDatabase(cwd)) {
    lines3.push(`beads is running embedded, a per-checkout database, and isolation is on -- an isolated worker mutates the copy inside its own clone, so its claims, comments and statuses never reach this run, and two workers can hold one bead. This project requires a per-project Dolt server. On a NEW project: \`bd init --server\`. On THIS project, migrate: \`bd backup init <path>\`, \`bd backup sync\`, re-init in server mode, then \`bd backup restore --force <path>\` -- server mode reads a different data directory, so it starts empty otherwise`);
  }
  const roles = await readSetting("modelRoles", cwd);
  if (typeof roles === "object" && roles !== null) {
    for (const role of DECLARED_MODEL_ROLES) {
      if (Object.hasOwn(roles, role))
        continue;
      lines3.push(`modelRoles.${role} is not configured, so \`@${role}\` resolves to nothing and the agent naming it silently runs the session default -- add it, or accept that a critic shares the family it judges`);
    }
  }
  if (lines3.length === 0)
    return deviations;
  const written = await ensureProjectSettings(cwd, deviations.map((deviation) => deviation.key));
  const tail = written === undefined ? "Fix and restart the run, or accept that captured branches, deliberate integration, and cross-worker claim exclusion are unavailable." : `The project-ownable settings above were written to ${written} (existing keys kept, comments not preserved). Restart the run to load them; the rest need your hands.`;
  pi.sendMessage({
    customType: SETTINGS_PREFLIGHT_MESSAGE,
    content: [
      "WARN settings: this run's coordination contract is not fully in force.",
      ...lines3.map((line) => `- ${line}`),
      tail
    ].join(`
`),
    display: true
  });
  const epic = await boundEpic(cwd);
  if (epic !== undefined) {
    await bdRun(["comment", epic, `WARN settings: ${lines3.join("; ")}`], undefined, cwd);
  }
  return deviations;
}
function registerWatchers(pi) {
  pi.on("session_start", async (_event, ctx) => {
    const cwd = ctx.cwd;
    pi.events.on(PROGRESS_CHANNEL, (data) => {
      const sample = progressSample(data);
      if (sample !== undefined)
        noteProgress(sample, Date.now());
    });
    ctx.setInterval(() => sweep(pi), SWEEP_MS);
    if (sessionRole(pi) === "lead") {
      preflightSettings(pi, cwd).catch((error) => logFailure(pi, "settings preflight", error));
    }
    pi.events.on(SUBAGENT_EVENT_CHANNEL, async (data) => {
      const mutation = bdMutationEvent(data);
      if (mutation === undefined)
        return;
      try {
        await appendAudit(auditDir(cwd), {
          ts: new Date().toISOString(),
          child: mutation.child,
          argv: mutation.command,
          exitCode: mutation.exitCode
        });
      } catch (error) {
        logFailure(pi, "audit ledger", error);
      }
    });
    pi.events.on(MCP_STATUS_CHANNEL, noteMcpStatus);
    pi.events.on(LSP_STARTUP_CHANNEL, noteLspStartup);
  });
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "task")
      return;
    try {
      resetReadBudget();
      await warnPreflight(ctx.cwd, Date.now());
    } catch (error) {
      logFailure(pi, "preflight warning", error);
    }
    return;
  });
  pi.on("goal_updated", async (event, ctx) => {
    if (sessionRole(pi) !== "lead")
      return;
    const goal = event.goal;
    if (goal === null)
      return;
    try {
      await relayGoal(pi, ctx.cwd, goal);
    } catch (error) {
      logFailure(pi, "goal relay", error);
    }
  });
}

// src/index.ts
var GATED_TOOLS = { bash: true, edit: true, write: true, yield: true };
function ompOrchestrate(pi) {
  pi.setLabel("Orchestrate");
  registerRunCommands(pi);
  registerConflictProbe(pi);
  registerRunStatus(pi);
  registerResolveQueueDispatch(pi);
  registerBotReviewProbe(pi);
  registerSupervision(pi);
  registerWatchers(pi);
  pi.on("tool_call", async (event, ctx) => {
    if (GATED_TOOLS[event.toolName] !== true)
      return;
    try {
      resetReadBudget();
      const input = event.input;
      if (event.toolName === "yield")
        return await gateExitContract(ctx, input);
      if (event.toolName === "bash") {
        const ownership = gateWorktrunkOwnership(input);
        if (ownership)
          return ownership;
        const discipline = await gateBdDiscipline(pi, ctx, input);
        if (discipline)
          return discipline;
        const exclusivity = gateOneClaim(ctx, input);
        if (exclusivity)
          return exclusivity;
        const eligibility = await gateClaimEligibility(ctx, input);
        if (eligibility)
          return eligibility;
      }
      if (GATED_WRITE_TOOLS[event.toolName] === true) {
        const scope = await gateWorktreeScope(ctx, event.toolName, input);
        if (scope)
          return scope;
      }
      if (event.toolName === "bash")
        return reviseBashEnv(input, { ...beadWriteFreeEnv(pi, ctx) });
      return;
    } catch (error) {
      pi.logger.error("orchestrate gate failed open", {
        tool: event.toolName,
        error: error instanceof Error ? error.message : String(error)
      });
      return;
    }
  });
  pi.on("session_start", async (_event, ctx) => {
    if (sessionRole(pi) === "lead")
      return;
    const marker = await readActiveRun(ctx.cwd).catch(() => null);
    if (marker === null)
      return;
    pi.sendMessage({
      customType: "com.srobroek.omp-orchestrate.contract",
      content: DISPATCH_CONTRACT,
      display: false,
      attribution: "user"
    }, { triggerTurn: false });
  });
  pi.registerCommand("orchestrate-status", {
    description: "Run status for the active epic",
    handler: async (args, ctx) => {
      const epic = args.trim();
      const result = await bdRun([
        "list",
        "--type",
        "epic",
        ...epic.length > 0 ? ["--parent", epic] : [],
        "--json"
      ]);
      if (result === null || result.code !== 0) {
        ctx.ui.notify("bd is unavailable", "warning");
        return;
      }
      const body = result.stdout.trim();
      ctx.ui.notify(body === "[]" || body.length === 0 ? "no epics" : body, "info");
    }
  });
  pi.registerCommand("orchestrate-roster", {
    description: "Pull-queue depth for each role",
    handler: async (_args, ctx) => {
      resetReadBudget();
      const lines3 = [];
      for (const role of ["architect", "implementer", "reviewer", "researcher", "shepherd"]) {
        const ready = await bdList(["ready", "--metadata-field", `role=${role}`, "--unassigned", "--json"]);
        lines3.push(`${role}: ${ready.length} ready`);
      }
      ctx.ui.notify(lines3.join(`
`), "info");
    }
  });
}
export {
  ompOrchestrate as default
};
