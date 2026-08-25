---
description: "bd update --claim naming more than one bead id"
condition: "(?:^|[\\s;|&('\"])bd\\s+update\\b(?=[^\\n]*--claim)(?=[^\\n]*\\s[A-Za-z][A-Za-z0-9_-]*-\\d+\\s+[A-Za-z][A-Za-z0-9_-]*-\\d+)"
scope: "tool:bash, tool:eval"
interruptMode: "tool-only"
---

One activation owns at most one bead. Claim a single id, finish or release it, then claim the next. Parallel work belongs to parallel agents, not parallel claims.
