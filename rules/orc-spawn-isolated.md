---
description: "claim-holder worker spawned without isolated: true"
condition: "\"agent\"\\s*:\\s*\"orc-(?:implementer|reviewer|researcher|shepherd)\"(?![^}]*\"isolated\"\\s*:\\s*true)"
scope: "tool:task"
interruptMode: "tool-only"
---

Claim-holder workers run in isolated workspaces: spawn them with `isolated: true` so their commits are captured on `omp/task/<id>` branches. Only the architect stays non-isolated, on its Worktrunk feature worktree.
