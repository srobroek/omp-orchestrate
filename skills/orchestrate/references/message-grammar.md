# Message grammar: the protocol verb set

`src/contracts/grammar.json` leads. This table restates it for humans and is written by
hand, not generated; `src/gates/bd.ts` enforces the same set in code, by calling
`commentVerb` rather than re-encoding it, and the `Verbs you may write` sentence of the
dispatch contract lists the agent-writable subset. `test/grammar-parity.test.ts` fails when
the grammar, the gate's set, the contract's list or this table diverge in either direction,
so edit the JSON first and let the test name what else moves.

## One carrier per fact

A bead's `status`, `assignee` and labels hold its state. One comment verb records each
transition. Nothing else is written for a transition: there is no audit-record double write
and no `state:` label. A reader who needs the phase derives it from those fields plus the
last verb, per the phase table in `references/beads-store.md`.

## What counts as a verb

`commentVerb` in `src/bd.ts` normalises before it matches: it strips a leading run of
bullet, blockquote, emphasis, tick and strikethrough markers, takes the first
whitespace-delimited token, strips trailing emphasis, ticks and sentence punctuation, then
uppercases. So `**REVIEW**`, `- REVIEW`, `` `REVIEW` ``, `REVIEW,`, `> REVIEW` and
`review` all parse as `REVIEW`. Write it however your prose reads.

`src/gates/bd.ts` warns when that parse yields a non-verb, so the nag arrives while you
write rather than as an unexplained contract failure on exit. It warns rather than refuses,
and only inside an active run: outside one it is silent, so a plain session in this
repository is never nagged.

GOTCHA: only the first token is read. A verb later in the sentence is prose: `the REVIEW
passed` parses as `THE`. Lead with the verb.

`NO_WORK` is not a comment verb. It is the yield-payload token an empty pull reports, and
`src/gates/exit.ts` matches it literally there; an empty queue leaves no bead to comment on.
The same first-token rule applies to it: `NO WORK` is neither the token nor a verb.

## The verbs

| Verb | Meaning | Who may write it |
|---|---|---|
| `REPORTED` | Evidence delivered, next role's label added, assignee cleared -- the node's exit contract is met. | `architect`, `implementer`, `researcher`, `unlisted` -- any claimant with no per-role contract |
| `BLOCKED` | Work cannot proceed. A worker writes it on an escalation wisp linked to its node; a shepherd writes it on the merge bead, naming the gate, provider or slot the landing waits on. Never stored as a bead state. | `*` -- every claiming role |
| `FAILED` | Unrecoverable failure. A valid exit paired with status `blocked`, never a faked success. | `*` -- every claiming role |
| `REVIEW` | One reviewer's verdict, written on the node its review wisp links to: `verdict=approve|changes` at a named head and round. The review outcome a reader needs is this comment. | `reviewer` |
| `LANDED` | The merge bead's branch is merged and `metadata.merge_sha` is stamped. | `shepherd` |
| `BOUNCED` | The merge attempt is refused back to its origin as a fix bead: bot findings, scope drift, or a branch that no longer merges into its base. A `reason=` token says which. | `shepherd` |
| `ESCALATED` | A repeated review issue exhausted its fix-attempt limit. The merge bead is held for a human: status `blocked`, and this comment carries the `ASK` fields. | `shepherd` |
| `ASK` | A product-intent question only a human can settle. The hold is status `blocked` plus this comment; a bead not yet started also gets a human gate. | `*` -- every claiming role |
| `NOTE` | A durable observation without a state transition: a discovered bead's id, a bead-local default and its revisit trigger, a researcher's answer on the linked node, the reaper's record of a claim it preserved and why. | `*` -- every claiming role; the extension's reaper |
| `RECOVERED` | The extension released a dead holder's claim under the lease: the holder's terminal frame, or registry `aborted` plus a lapsed lease, fenced by `--claim`. The bead is open and unassigned again; requeue is implicit. | `extension` -- this plugin's own code |
| `STALL` | A claimed child went silent past its threshold. No kill -- the spawner decides. | `extension` -- this plugin's own code |
| `WARN` | A degraded preflight or a settings deviation the run should see but not stop for. | `extension` -- this plugin's own code |
| `GOAL` | The run objective and its status, stamped on every epic each time it changes. | `extension` -- this plugin's own code |

The first nine are the agent-writable set, and the dispatch contract lists exactly those.
The last four are the extension's voice: an agent never writes them, and a role contract
never requires them.

## Adding a verb

DEFAULT a role contract in `src/contracts/` should require the verb. A verb only prose
mentions has no enforcement, and its writer set stays `inferred` until a contract or the
extension names it. Add the entry to `grammar.json`, add it to the contract's `Verbs you
may write` sentence when an agent writes it, then add the row above by hand -- the parity
test tells you if you missed one.
