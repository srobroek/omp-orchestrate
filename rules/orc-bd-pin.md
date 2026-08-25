---
description: "a bd invocation with no -C, which in an isolated workspace reads and writes a private copy of the database"
condition: "(?:^|[\\s;|&('\"])bd\\s+(?![^\\n]*(?:\\s-C|\\s--directory[\\s=]))(?:ready|update|create|close|comment|comments|label|dep|show|list|blocked|gate|merge-slot|set-state|audit|reopen|unclaim|release|stale|compact)\\b"
scope: "tool:bash, tool:eval"
interruptMode: "tool-only"
---

Aim every `bd` call at the run's repository with `-C <run repo>`, the absolute path the
dispatch contract gave you.

Isolation hands you a copy of the checkout, and `bd` finds its database by walking up from
the working directory. An unpinned call therefore reads and writes the copy inside your own
workspace: your claim never becomes visible to the run, another agent can claim the same
bead, your comments and status changes reach nobody, and the queue you read looks empty
while work waits in it. A bead created in a copied checkout is invisible in the original.

This applies to reads as much as writes. `bd ready` against a private copy is how a queue
reports `NO_WORK` while beads sit in it.
