---
description: "retired WAIT/CLAIM activation grammar reappearing (regression canary)"
condition: "(?:^|[\\n\\s])WAIT(?:\\s|:)(?!ING_HUMAN).{0,80}\\b(?:CLAIM|ACK|ACTIVATE)\\b"
interruptMode: "never"
---

The WAIT/CLAIM two-phase activation is retired. Workers pull their own work with `bd ready ... --claim`; there is nothing to release them with. Human holds use a `WAITING_HUMAN` comment plus a gate bead.
