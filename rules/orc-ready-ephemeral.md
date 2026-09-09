---
description: "bd ready pulling a reviewer/researcher queue without --include-ephemeral"
condition: "(?:^|[\\s;|&])bd(?:\\s+(?:-C|--directory)(?:\\s+|=)\\S+)?\\s+ready\\b(?![^\\n]*--include-ephemeral)[^\\n]*(?:--label\\s+agent:|--metadata-field(?:\\s+|=)role=)(?:reviewer|researcher)\\b"
scope: "tool:bash, tool:eval"
interruptMode: "tool-only"
---

Review and research queues are ephemeral wisps, and `bd ready` hides ephemeral beads by default. Re-run with `--include-ephemeral` or this queue reads empty forever. Advisory reminder, not a gate.
