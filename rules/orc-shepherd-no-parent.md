---
description: "merge-bead pull filtered by --parent, which hides every unparented merge bead"
condition: "(?:^|[\\s;|&])bd\\s+ready\\b(?=[^\\n]*--parent)(?=[^\\n]*(?:--label\\s+(?:pr:merge|agent:integrator)|-t\\s+merge-request))"
scope: "tool:bash, tool:eval"
interruptMode: "tool-only"
---

Merge beads are deliberately unparented so the repository-global drain sees them across runs. Drop `--parent`; filter with `--label agent:integrator` (and `pr:merge`) only. Advisory reminder, not a gate.
