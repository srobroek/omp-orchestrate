---
description: "bd ready pulling a reviewer/researcher queue without --include-ephemeral"
condition: "(?:^|[\\s;|&])bd\\s+ready\\b(?![^\\n]*--include-ephemeral)[^\\n]*--label\\s+agent:(?:reviewer|researcher)\\b"
scope: "tool:bash, tool:eval"
interruptMode: "tool-only"
---

Review and research queues are ephemeral wisps, and `bd ready` hides ephemeral beads by default. Re-run with `--include-ephemeral` or this queue reads empty forever. Advisory reminder, not a gate.
