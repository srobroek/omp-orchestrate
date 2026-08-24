---
description: "mutating bd command without the BEADS_ACTOR/BD_ACTOR identity prefix"
condition: "(?:^|[;|&]\\s*)(?:(?!(?:BEADS_ACTOR|BD_ACTOR)=)\\w+=\\S+\\s+)*bd\\s+(?:create|update|close|comment|dep|label|gate|merge-slot|set-state|audit)\\b"
scope: "tool:bash, tool:eval"
interruptMode: "never"
---

Prefix every mutating `bd` command with `BEADS_ACTOR` and `BD_ACTOR` set to the claimed bead's `metadata.actor`, so the audit trail records who acted. Reads (`bd ready`, `bd show`, `bd list`) need no prefix.
