# Roles, models, escalation

Five agents ship: `orc-architect`, `orc-implementer`, `orc-reviewer`, `orc-researcher`,
`orc-shepherd`. Each names one OMP model role and sets no thinking level, so the tier
travels with the role rather than the file. Tune them by editing `modelRoles` in your own
configuration, and never write a raw provider selector into an agent.

`orc-reviewer` names `@reviewer`, which OMP does not ship. `@slow` and `@plan` are the
authoring tier, so neither keeps a critic out of the family it judges. Configure
`modelRoles.reviewer` before a run. OMP resolves an unconfigured alias to nothing and falls
back to the session default without warning, so the settings preflight reports an absent
one.

Escalation is per-spawn `effort`, not a second agent. There is no deep variant of any role.

| Role | Agent | Model role | Lifetime | Works in | Claims |
|---|---|---|---|---|---|
| Lead | you (this session) | session model | whole run | the primary checkout | never claims anything |
| Architect | `orc-architect` | `@plan` | long-lived, parked between waves, revivable | its Worktrunk feature worktree; **not** isolated | one epic, pulled |
| Implementer | `orc-implementer` | `@task` | ephemeral, one bead | an isolated copy; commits captured on `omp/task/<id>` | one task bead, pulled |
| Reviewer | `orc-reviewer` | `@task` | ephemeral, one verdict | read-only, no checkout of its own | one review wisp, pulled |
| Researcher | `orc-researcher` | `@smol` | ephemeral, one answer | read-only, no checkout of its own | one escalation wisp or research bead, pulled |
| Shepherd | `orc-shepherd` | `@task` | ephemeral, two phases across the CI gate | no content tree; PR and merge state only | merge beads (label `pr:merge`, metadata `role=shepherd`), pulled |
| Helper | `scout`, or another non-claiming child its spawner's allowlist names | inherited | ephemeral, inside the architect's own await | the architect's checkout | nothing -- traced by a wisp, never claims |

The reviewer is `@task` rather than the cheap tier on purpose: a reviewer cannot be weaker
than the work it is evaluating. The researcher is cheap because its output is a digest with
citations, and its hard cases escalate by `effort`.

"Long-lived" does not mean one never-restarted process. An architect may be replaced
mid-epic; the Worktrunk branch and the bead state are what carry the domain, so the
replacement resumes the same tree.

## What replaced the scribe and the advisor

Neither is an agent. Both duties survive; neither costs a spawn.

- **The scribe's ledger duty** is `orc_run_status` plus `/orchestrate-status`, and the
  provenance half is the extension's passive audit ledger
  (`<artifacts_dir>/audit/<child-id>.bdlog`, one line per child `bd` mutation). There is no
  ledger wisp to drain and no report agent to activate.
- **The advisor is OMP's native watchdog**, bound to the architect by frontmatter
  `advisor: true`. It reviews transcript deltas in band and can never block a call, which is
  exactly the advisory role a spawned advisor approximated at the cost of a session.
- **Escalation that once went to an advisor routes to `role=researcher`.** The researcher's
  contract is a durable `ADVICE` comment on the bead, read-only. Never spawn an advisor, and
  never answer your own escalation.
- **Product intent was never an advisor's to decide.** It is an `ASK` wisp plus a human gate.

## Capabilities and access

| Role | Writes | Spawns | Notes |
|---|---|---|---|
| Lead | run epics, their metadata, wakes | architects | coordination, `bd`, the `orc_*` tools, the slash commands. Never code, never content |
| Architect | its feature tree, commits, draft PR, decomposition beads | exactly the names in its own `spawns:` allowlist | **sole mutator** of its feature worktree; integrates captured task branches by explicit cherry-pick; never merges a PR |
| Implementer | code inside `metadata.scope`, in its isolated copy | nothing today | it declares no `spawns:`, which the runtime reads as spawning disabled. The librarian shortcut below needs `spawns: librarian` declared on the agent before it works at all |
| Reviewer | comments and verdicts | nothing | reads the captured branch or the feature tree; "read-only" is enforced by its agent definition omitting `edit` and `write`, not by sandboxing `bd` -- it must write its own verdict |
| Researcher | comments (`ADVICE`), artifacts under `<artifacts>` | nothing | investigation only; never edits code |
| Shepherd | PR state, `pr` and `merge_sha`, fix beads, merge-slot | nothing | the only role that may merge; never edits or pushes content |
| Helper | files in the architect's checkout | nothing | no bead, no commit, no PR, no worktree. Its outcome is promoted to a comment on the feature bead before its trace wisp can be compacted |

Inside a declared `tools:` list, omitting a tool denies it, which is what the reviewer row
rests on. One exception is silent. The runtime force-adds `hub` to every agent that declares
such a list, so `orc-reviewer` and `orc-shepherd` hold it although neither names it. Every
role can ping, and every role can be pinged. An agent declaring no `tools:` key inherits
everything instead.

A declaration guarantees nothing about which definition answers to a name. Discovery resolves
a bare name in order, and a marketplace plugin claims it before a bundled agent. Bundled
agents load last, and a claimed name is dropped (`@oh-my-pi/pi-coding-agent`,
`src/task/discovery.ts:120-133`). An allowlist entry names a name, not a definition, so an
install can change what it grants with no edit to these files.

Only the architect spawns a role that claims beads. Two independent conditions gate any
spawn, and the allowlist is the binding one:

1. **The agent declares an explicit `spawns:` allowlist.** An agent with no `spawns:` key
   spawns nothing, at any depth. The runtime infers a permissive `*` only for an agent whose
   `tools:` list includes `task`, and an absent key is normalised to "none" before the spawn
   policy is consulted -- so the permissive-looking default for an unset value is
   unreachable, and a missing allowlist reads as a hard refusal rather than as freedom.
2. **The depth ladder allows the child.** `lead(0) → architect(1) → worker(2) → leaf(3)`, so
   a worker's helper needs `task.maxRecursionDepth: 3`. At the default 2 the
   lead-architect-worker chain has already spent the ladder.

Depth alone fixes nothing: raise the ceiling without declaring the allowlist and every
worker spawn is still refused. Declare the allowlist without the ceiling and the child is
refused for depth. A bead-claiming role spawned by a worker stays a design error under both.

## Choosing between a queue and a spawn

| Situation | Do this |
|---|---|
| The work deserves a bead, review, and a captured branch | create the task bead with `role=implementer` and dispatch a wave |
| A read-only sweep or a mechanical rename, too small for a bead's round trip | spawn a helper your own `spawns:` allowlist names -- `scout` for reading -- inside your own await, traced by a `ping` wisp |
| A question about the codebase, not a change to it | route it to `role=researcher` rather than reading it yourself |
| An external library's real behaviour, rather than this codebase's | spawn `librarian` and read its structured return: no bead, no wisp, no consent. Needs `librarian` in the spawning agent's own `spawns:` allowlist |
| A verdict on work that reported | create the review wisp with `role=reviewer`; never review what you wrote |
| A landing unit is approved | create the merge bead and spawn the shepherd |

A read-only node goes to the researcher rather than the architect in the first place. On
pure analysis the reading *is* the reasoning, so a delegating layer only adds a hop and
re-reads context the analyst already holds.

## Research escalation: four hops

A worker cannot spawn a role that claims beads, so a researcher reaches it through its
architect. Four hops, each owned by exactly one actor:

1. **The implementer creates the research wisp** against its own bead and pings its
   architect for consent. The wisp is the brief, so the ping names the wisp id and nothing
   else.
2. **The architect consents and spawns `orc-researcher`.** One call, and its entire
   involvement. It does not read the question, answer it, or wait on it.
3. **The researcher pulls the wisp** (`--include-ephemeral`), writes `ADVICE` on the linked
   node, and repeats the answer on the wisp.
4. **The researcher pings the originating implementer directly**, sibling to sibling. The
   answer never travels back through the architect.

The wisp carries both ids, which is what makes hop 4 addressable with no relay: `assignee`
is the researcher, `metadata.origin_actor` the implementer that asked.

Findings stand on the wisp whether or not the ping lands, so the flow never depends on a
message surviving. The ping is a doorbell over writing that already happened: not retried,
not blocked on, carrying no content.

**The cheap alternative, once it is wired.** `librarian` returns a structured result to its
caller, so the answer arrives as the spawn's return value. There is nothing to route and
nobody to ping, so it needs no wisp, no consent, and no hop 2. For an external-library fact a
worker spawns it and reads what comes back. Keep the four hops for questions about this
repository, this design, or a choice someone must own.

The test for a helper you expect to read: its frontmatter declares an explicit `tools:` list
that omits `write`, `edit` and `task`, so it can neither mutate the checkout nor fan out
further. `librarian` and `scout` pass. `sonic` fails it by declaring no `tools:` at all, which
is why no allowlist names it. Agents that pass may still carry `bash`, `librarian` included,
so the no-write guarantee is their prose rather than their tool list.

A helper whose job is to write fails that test by design. `operator` is the case: no `tools:`
key, and bounded mechanical mutation is the whole point. `designer` fails it the same way, and
inherits `write` and `edit`, which makes it implementer-shaped rather than helper-shaped.

`ui-ux-specialist` is the same implementer-shaped helper for UI work that needs system grounding, parallel critique, or a durable DESIGN.md. A small self-contained UI edit stays with `designer`. It declares no `tools:`, so it inherits write and edit and works in the architect's checkout. It also names `design-critic`, `a11y-auditor`, and `scout` in its own `spawns:`, so its wall time covers that fan-out and it returns reconciled findings rather than raw critique. Brief: the surface to drive (route or URL), the paths holding tokens and primitives, the scope it may touch, the viewport widths, and an explicit instruction not to invent tokens. It ships in `@srobroek/design`; without that package the grant is not spawnable and the bundled `designer` is the fallback. Do not add it to the six-role table: it claims nothing.

Depth closes the fan-out half instead. A worker sits at depth 2, so its helper lands at depth
3, where the executor empties `spawnsEnv`. That helper spawns nothing, whatever its tools say.
Containment is the worktree-confinement gate plus the helper's own prose.

The `hub` exception above reaches `librarian` too, and configured `mcp__*` tools stay
reachable. A probed `librarian` held both while its frontmatter named neither. Read a denial
off frontmatter, never an inventory.

That shortcut needs both conditions above: `spawns: librarian` declared on the worker agent,
and `task.maxRecursionDepth: 3`, because a worker's child sits at depth 3. Until the
allowlist is declared the shortcut is documentation, not behaviour. The four hops need
neither change -- hop 2 is the architect spawning a role its own allowlist already names, at
depth 1 -- and that is precisely why the dance exists.

## Research fan-out / fan-in

The actor that needs the answer owns the decomposition, and it never reads raw sources
itself.

- **Narrow question:** one researcher, one terse digest.
- **Broad question:** fan out several `@smol` gatherers in one `task` batch, each scoped to
  one source, slice, or sub-question, each returning facts plus refs and nothing raw. Then
  fan in: one `effort: "hi"` researcher dedupes, resolves conflicts, and returns a single
  synthesis with citations. Keep the synthesis; the gatherers are done.

Bound the fan-out width to the sources that matter, and record what was skipped. Gatherers
spawn nothing.

## Escalation ladder

1. **The instance, not the role.** A task that failed on reasoning depth is respawned with
   `effort: "hi"`. Name the attempt that failed and say why it was depth rather than missing
   context, a tooling block, or bad scope -- if you cannot, effort is not the answer.
   `effort` requires `task.enableEffort: true`; without it the escalation silently no-ops.
2. **`BLOCKED kind:design|debug`** creates an escalation wisp linked to the bead, carrying a
   `BLOCKED` comment, and the blocked actor yields. An open escalation wisp pauses the
   author's exit contract rather than failing it, so waiting is not punished. A researcher
   pulls the wisp (`--include-ephemeral`) and answers with `ADVICE`. The four hops above
   name who pings whom.
3. **A dispute that durable evidence does not settle** gets one fresh read-only researcher
   at `effort: "hi"` on the escalation wisp. Its `ADVICE` is promoted to a comment before
   anyone acts on it.
4. **Product intent, or anything outside the brief,** becomes an `ASK` wisp plus
   `bd gate create --type=human`. No agent decides it.

Never upgrade a whole role to paper over one hard case, and never wait live on a peer at any
rung: record what you need, yield, and let the run wake you.
