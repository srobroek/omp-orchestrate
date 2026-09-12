---
description: "bd ready pulling a reviewer/researcher queue without --include-ephemeral"
condition: "(?:\\b|\\\\[nt])bd(?:\\s+(?:-C|--directory)(?:\\s+|=)\\S+)?\\s+ready\\b(?!(?:\\\\[^n]|[^\"\\\\\\n]){0,300}--include-ephemeral)(?:\\\\[^n]|[^\"\\\\\\n]){0,300}(?:--label\\s+agent:|--metadata-field(?:\\s+|=)role=)(?:reviewer|researcher)\\b"
scope: "tool:bash, tool:eval"
interruptMode: "never"
---

Review and research queues are ephemeral wisps, and `bd ready` hides ephemeral beads by default. Re-run with `--include-ephemeral` or this queue reads empty forever.

Advisory: the command runs and this reminder is folded into its result. The condition is matched against the streamed tool-argument JSON (`{"command":"bd ready …"}`), so `bd` is anchored with `\b` (it follows `"` at column 0) or the two-character `\n`/`\t` escape, and "same line" ends at the next `\n` escape or the closing `"` of the string, never at a raw newline.

The line is read at most 300 characters past `ready`. Each `bd ready` on a line starts its own scan, so an unbounded span cost quadratic time on a line that repeated `bd ready` thousands of times. A flag written further out than that is not seen.
