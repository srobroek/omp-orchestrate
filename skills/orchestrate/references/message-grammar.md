# Message grammar: the protocol verb set

`src/contracts/grammar.json` leads. This table restates it for humans and is written by
hand, not generated; `src/gates/bd.ts` enforces the same set in code, by calling
`commentVerb` rather than re-encoding it. `test/grammar-parity.test.ts` fails when the
grammar, the gate's set or this table diverge in either direction, so edit the JSON first
and let the test name what else moves.

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

GOTCHA: only the first token is read, so `NO WORK` parses as `NO`. Spell a multi-word verb
with its underscore -- `NO_WORK`, `LOCAL_DECISION`. A verb later in the sentence is prose:
`the REVIEW passed` parses as `THE`.

## The verbs

`(inferred)` marks a writer set no contract or code enforces: it was read from prose and
narrowed here, so a reviewer may argue with the set without arguing with the verb.

| Verb | Meaning | Who may write it |
|---|---|---|
| `REPORTED` | Evidence delivered, next role's label added, assignee cleared -- the node's exit contract is met. | `architect`, `implementer`, `researcher`, `unlisted` -- any claimant with no per-role contract |
| `BLOCKED` | Work cannot proceed. Written on an escalation wisp linked to the node, never stored as a bead state. | `*` -- every claiming role |
| `FAILED` | Unrecoverable failure. A valid exit paired with status blocked, never a faked success. | `*` -- every claiming role |
| `REVIEW` | One reviewer's verdict, written on the node its review wisp links to. | `reviewer` |
| `ADVICE` | A researcher's durable answer to an escalation wisp, promoted to the linked node. | `researcher` |
| `LANDED` | The merge bead's branch is merged and metadata.merge_sha is stamped. | `shepherd` |
| `BOUNCED` | The merge attempt is refused back to its origin as a fix bead. | `shepherd` |
| `CONFLICT` | The branch does not merge into its base. The node returns to working for a rebase; the shepherd never resolves it. | `shepherd` |
| `IDLE` | Nothing was landable this transaction. The merge slot is released and the waiter queue outlives the exit. | `shepherd` |
| `NO_WORK` | The role's queue is empty. Yield rather than widen the filter or invent work. | `*` -- every claiming role |
| `ASK` | A product-intent question only a human can settle. Pairs with a human gate on the held bead. | `*` -- every claiming role (inferred) |
| `NOTE` | Durable observation without a state transition, including the reaper's recovery-needed evidence. | acting roles; extension observer |
| `LOCAL_DECISION` | A reversible bead-local default, provisional or accepted, carrying an objective revisit trigger. | `architect`, `implementer` (inferred) |
| `BOUNCE` | Reserved extension verb for attempt invalidation; the current local exit escape does not emit it or mutate the bead. | `extension` |
| `RECLAIM` | Reserved for completed claim recovery, never an observation or intent. The current reaper emits `NOTE` instead. | `extension` |
| `STALL` | A claimed child went silent past its threshold. No kill -- the spawner decides. | `extension` -- this plugin's own code |
| `WARN` | A degraded preflight or a settings deviation the run should see but not stop for. | `extension` -- this plugin's own code |
| `GOAL` | The run objective and its status, stamped on every epic each time it changes. | `extension` -- this plugin's own code |

## The confusable pair

`BOUNCED` is a shepherd disposition: this merge attempt is refused back to its origin.
`BOUNCE` is reserved for extension attempt invalidation; current budget escape is not a
bead mutation or a `BOUNCE` comment. Neither is interchangeable with a merge disposition.

## Adding a verb

DEFAULT a role contract in `src/contracts/` should require the verb. A verb only prose
mentions has no enforcement, and its writer set stays `inferred` until a contract or the
extension names it. Add the entry to `grammar.json`, add it to the rule's alternation, then
add the row above by hand -- the parity test tells you if you missed one.
