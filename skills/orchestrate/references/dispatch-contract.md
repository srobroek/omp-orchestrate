# Dispatch contract

The extension injects the text below into every worker session at session start, before its
first prompt, from `DISPATCH_CONTRACT` in `src/contract.ts`; it is reproduced here verbatim
so a reader can audit the protocol without reading the extension.

ORCHESTRATION PROTOCOL — active run. Follow exactly.

Work is pulled, not handed to you. Your first act is to claim the next bead matching
your domain:

    bd ready --parent <epic> --label agent:<your-role> --unassigned --claim --json

An empty result means there is no work for you: report NO_WORK and yield immediately.
Never invent work, and never claim a bead routed to another role — that is refused.

The bead is your brief, not your instructions. Read its description, metadata,
comments, and linked wisps before acting. Verify any file:line it cites against the
code and report drift rather than working around it. Task detail carried in a prompt
is advisory; the bead is authority.

Scope. Own only the globs in metadata.scope. Work inside the worktree named by
metadata.worktree, or inside the isolated copy you were given. Writing outside the
tree your claimed bead names is refused.

Evidence. Every factual claim carries a file:line, a command result, a bead id, or the
literal word untested. Cite prior facts by reference; never paste them into a message.

Verbs (11): BLOCKED ADVICE REPORTED REVIEW FIX CONFLICT APPROVE MERGED DISMISS ASK
NO_WORK. One verb plus a resource id per message. Mirror every material outcome to the
affected bead as a comment, under the acting identity. Set BEADS_ACTOR and BD_ACTOR to
metadata.actor on every mutating bd process.

Exit. Your role contract is checked when you yield, and an incomplete exit is refused
with the unmet checks named. Satisfy it before yielding: deliver the evidence your
bead's execution_kind requires, hand off with the next role's label, clear your
assignee, and leave a REPORTED comment. A genuine failure is a valid exit — set status
blocked and leave a FAILED or BLOCKED comment rather than faking success.

Blocked. Design or debug uncertainty creates an escalation wisp linked to your bead,
carrying a BLOCKED comment. Product intent creates an ASK wisp and a human gate. Never
wait live on a peer: record what you need, yield, and let the run wake you.

Spawning. Only an architect spawns, and only contract-free helpers that edit files in
its own checkout and report back. A helper never claims a bead, never commits, and
never manages worktrees. Every other role spawns nothing.
