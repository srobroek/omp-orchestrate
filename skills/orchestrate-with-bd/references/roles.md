# Roles

Six agents ship with the plugin. Every model is a role name OMP resolves through
`modelRoles`; an agent with no `tools:` line inherits the whole inventory, including `task`.

| Agent | Model | `isolated` | Spawns | Claims |
|---|---|---|---|---|
| `orc-lead` | `@plan` | yes | planner, implementer, reviewer, researcher, shepherd, scout, operator | its epic, at bind |
| `orc-planner` | `@plan` | no | none (`spawns: false`) | never |
| `orc-implementer` | `@task` | yes | scout, operator | its task bead |
| `orc-reviewer` | `@reviewer` | no | scout | its review bead |
| `orc-researcher` | `@smol` | no | none | its research bead |
| `orc-shepherd` | `@task` | no | none | its PR bead |

## Enforcement that is not prose

- `orc-lead` omits itself from `spawns:`. OMP preflight refuses any name outside an
  explicit `spawns:` list with `Cannot spawn 'orc-lead'`, so a sub-lead cannot start a
  lead. The root session carries no spawn policy and is the only place epic leads start.
- `orc-planner` has `spawns: false`; it cannot dispatch anything.
- Workers have no `todo` tool: OMP withholds it from every dispatched agent. Their only
  progress record is `orc_finish`.
- A worker with an explicit `tools:` line names `orc_claim` and `orc_finish`; the reviewer,
  researcher, and shepherd do. Extension tools are not inherited past an explicit list.

## Depth

`maxRecursionDepth` counts from the root session at depth 0. Two tiers need 2 (lead →
implementer → scout). Three tiers need 3 (root → epic lead → implementer → scout).

## Helpers

`scout` (ships with OMP) answers one bounded read-only question. `operator` (`build` plugin
in the `srobroek-omp` marketplace) performs one exact mechanical operation in the caller's
checkout. Neither claims a bead, commits, or touches a PR. Before writing where a helper
worked, the caller awaits the helper's terminal result.

## Briefs

A brief names the bead id, the role, and what the bead does not already say. Unless the
agent is `orc-lead`, the brief never contains the word `orchestrate` in lowercase. OMP's own
keyword notice reaches any dispatched agent that has `task` and a brief with that word. The
six roles above are the whole surface. Nothing else in this plugin dispatches, claims, or
reviews.

That is the whole table.
