---
description: "bd ready pulling a reviewer/researcher queue without --include-ephemeral"
condition: "(?:\\b|\\\\[nt])bd(?:\\s+(?:-C|--directory)(?:\\s+|=)\\S+)?\\s+ready\\b(?!(?:\\\\[^n]|[^\"\\\\\\n])*--include-ephemeral)(?:\\\\[^n]|[^\"\\\\\\n])*(?:--label\\s+agent:|--metadata-field(?:\\s+|=)role=)(?:reviewer|researcher)\\b"
scope: "tool:bash, tool:eval"
interruptMode: "never"
---

Review and research queues are ephemeral wisps, and `bd ready` hides ephemeral beads by default. Re-run with `--include-ephemeral` or this queue reads empty forever.

Advisory: the command runs and this reminder is folded into its result. The condition is matched against the streamed tool-argument JSON (`{"command":"bd ready …"}`), so `bd` is anchored with `\b` (it follows `"` at column 0) or the two-character `\n`/`\t` escape, and "same line" ends at the next `\n` escape or the closing `"` of the string, never at a raw newline.
