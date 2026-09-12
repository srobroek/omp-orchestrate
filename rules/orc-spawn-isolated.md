---
description: "orc-implementer spawned without isolated: true"
condition: "\\{(?:(?!\"isolated\"\\s*:\\s*true)(?:\"(?:[^\"\\\\]|\\\\.)*\"|[^\"{}]|\\{(?:\"(?:[^\"\\\\]|\\\\.)*\"|[^\"{}]|\\{(?:\"(?:[^\"\\\\]|\\\\.)*\"|[^\"{}]|\\{(?:\"(?:[^\"\\\\]|\\\\.)*\"|[^\"{}]|\\{(?:\"(?:[^\"\\\\]|\\\\.)*\"|[^\"{}])*\\})*\\})*\\})*\\}))*\"agent\"\\s*:\\s*\"orc-implementer\"(?:(?!\"isolated\"\\s*:\\s*true)(?:\"(?:[^\"\\\\]|\\\\.)*\"|[^\"{}]|\\{(?:\"(?:[^\"\\\\]|\\\\.)*\"|[^\"{}]|\\{(?:\"(?:[^\"\\\\]|\\\\.)*\"|[^\"{}]|\\{(?:\"(?:[^\"\\\\]|\\\\.)*\"|[^\"{}]|\\{(?:\"(?:[^\"\\\\]|\\\\.)*\"|[^\"{}])*\\})*\\})*\\})*\\}))*\\}"
scope: "tool:task"
interruptMode: "tool-only"
---

Implementers run in isolated workspaces: spawn `orc-implementer` with `isolated: true` so its commits are captured on `omp/task/<id>` and it never writes the architect's tree. The architect stays non-isolated on its Worktrunk feature worktree; reviewer, researcher and shepherd isolation is a dispatch decision (`roles.md`), not a rule.

Mechanics: the condition runs against the streamed `task` JSON, which the host re-matches on every delta. It fires only once a dispatch object has closed (`{ … }`) that names `orc-implementer` and contains no `isolated: true` at its own level, in any key order, in the flat and batch (`tasks: [...]`) forms. The pattern is `{ SCAN "agent":"orc-implementer" SCAN }`, where SCAN repeats one token (a JSON string, a plain non-brace character, or a nested object up to four levels deep) behind a negative lookahead for `"isolated": true`. JSON strings are skipped, so braces or escaped quotes inside `task` text cannot close the object early; an object nested deeper than four levels (an elaborate `outputSchema`) makes the rule stay quiet for that call. It interrupts (`tool-only`) because the reminder is only useful before the worker runs. A `tool_call` gate on `task`, which sees the parsed arguments, is the sound replacement.
