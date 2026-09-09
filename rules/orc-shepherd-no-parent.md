---
description: "merge-bead pull filtered by --parent, which hides every unparented merge bead"
condition: "(?:^|[\\s;|&])bd(?:\\s+(?:-C|--directory)(?:\\s+|=)\\S+)?\\s+ready\\b(?=[^\\n]*--parent)(?=[^\\n]*(?:--metadata-field(?:\\s+|=)role=shepherd\\b|--label\\s+(?:pr:merge|agent:integrator)|-t\\s+merge-request))"
scope: "tool:bash, tool:eval"
interruptMode: "tool-only"
---

Merge beads are deliberately unparented so the repository-global drain sees them across runs. Drop `--parent`; filter with `--metadata-field role=shepherd` and `--label pr:merge`. Advisory reminder, not a gate.
