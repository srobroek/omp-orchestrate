---
description: "bd comment whose first token is not a protocol verb"
condition: "bd\\s+comment\\b[^\\n\\\"']*[\\\"'](?!(?:BLOCKED|ADVICE|REPORTED|REVIEW|FIX|CONFLICT|APPROVE|MERGED|DISMISS|ASK|NO_WORK|FAILED|NOTE|LANDED|BOUNCED|IDLE|RECLAIM|STALL|WARN|GOAL|BOUNCE|BRIEF|WAITING_HUMAN|LOCAL_DECISION)\\b)"
scope: "tool:bash, tool:eval"
interruptMode: "never"
---

Start every bead comment with its protocol verb (the 11-verb set, a disposition, or a supervision verb) so histories read without narration. Free prose belongs after the verb, not instead of it.
