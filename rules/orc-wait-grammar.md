---
description: "retired WAIT/CLAIM activation grammar reappearing (regression canary)"
condition: "(?:^|[\\n\\s])WAIT(?:\\s|:).{0,80}\\b(?:CLAIM|ACK|ACTIVATE)\\b"
interruptMode: "never"
---

The WAIT/CLAIM two-phase activation is retired. Workers pull their own work with `bd ready ... --claim`; there is nothing to release them with. Human holds use an `ASK` comment plus a human gate bead; the durable hold is the `state:waiting_human` label, not a comment verb.
