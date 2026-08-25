---
description: "bd create of a bug bead with no --parent or no agent: routing label, which no queue can see"
condition: "(?:^|[\\s;|&('\"])bd\\s+(?:-C[\\s=]?\\S+\\s+|--directory[\\s=]\\S+\\s+)?create\\b(?=(?:[^\\n]|\\\\\\n)*(?:--type[\\s=]|-t\\s+)bug\\b)(?:(?!(?:[^\\n]|\\\\\\n)*\\bagent:)|(?!(?:[^\\n]|\\\\\\n)*--parent[\\s=]))"
scope: "tool:bash, tool:eval"
interruptMode: "tool-only"
---

A bug bead reaches a worker through a parent and a routing label, and through nothing else.
Every queue pulls with `bd ready --parent <epic> --label agent:<role> --unassigned`. A bug bead
missing either one is invisible to all of them.

That invisible bead does not sit quietly. The close-out gate counts it as stranded, and a
stranded bead fails that gate. The filer exits first, so the failure lands on the next session.

A routed bug bead is ready instead, and a ready bead never blocks the gate. Routing it also
stops the architect closing it to make close-out pass.

Parent it to the epic you work under. Label it for the role that would fix it. Leave the
assignee empty, so the next worker claims it atomically. Merge beads are the one deliberate
unparented exception, and a bug bead never copies it. The full shape is in
`references/lifecycle.md`, under "Incidental bug beads".
