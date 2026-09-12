---
description: "merge-bead pull filtered by --parent, which hides every unparented merge bead"
condition: "(?:\\b|\\\\[nt])bd(?:\\s+(?:-C|--directory)(?:\\s+|=)\\S+)?\\s+ready\\b(?=(?:\\\\[^n]|[^\"\\\\\\n])*--parent)(?=(?:\\\\[^n]|[^\"\\\\\\n])*(?:--metadata-field(?:\\s+|=)role=shepherd\\b|--label\\s+(?:pr:merge|agent:integrator)|-t\\s+merge-request))"
scope: "tool:bash, tool:eval"
interruptMode: "never"
---

Merge beads are deliberately unparented so the repository-global drain sees them across runs. Drop `--parent`; filter with `--metadata-field role=shepherd` and `--label pr:merge`.

Advisory: the command runs and this reminder is folded into its result. The condition is matched against the streamed tool-argument JSON (`{"command":"bd ready …"}`), so `bd` is anchored with `\b` (it follows `"` at column 0) or the two-character `\n`/`\t` escape, and "same line" ends at the next `\n` escape or the closing `"` of the string, never at a raw newline.
