#!/bin/sh
# Validate every TTSR rule against the HOST engine, not Python's `re`.
#
# Python accepting a pattern proves nothing about the engine that evaluates these
# rules: lookbehind support, `\A`/`\Z`, and named-group syntax all differ. Each case
# asserts a positive fires and a negative does not, through `omp ttsr test`.
#
# Local gate, deliberately not in CI: it needs an installed `omp`, which the CI
# runners do not have. Run it after touching any rule frontmatter.
#
# Five bd rules used to live here -- the -C pin, the actor prefix, the comment verb, the
# bug-bead route and the one-claim count. They are tool_call gates now, because a regex
# cannot see whether a run is active and so nagged every session that mentioned `bd`. The
# pin is retired outright: this project runs a per-project Dolt server. Their corpus moved
# to `test/gate-bd.test.ts` and `test/one-claim.test.ts`, which run in CI. Do not re-add
# them here.
set -u
cd "$(dirname "$0")/.." 2>/dev/null || cd ~/personal/dev/omp-orchestrate || exit 2

fail=0

check() {
	rule="$1"; expect="$2"; src="$3"; tool="$4"; snippet="$5"
	if [ "$src" = "text" ]; then
		out=$(omp ttsr test --rule "rules/$rule" --source text "$snippet" 2>&1)
	else
		out=$(omp ttsr test --rule "rules/$rule" --source tool --tool "$tool" "$snippet" 2>&1)
	fi
	if printf '%s' "$out" | grep -q "No rules triggered"; then got=miss; else got=fire; fi
	if [ "$got" = "$expect" ]; then
		printf 'ok   %-26s %-4s %s\n' "$rule" "$got" "$(printf '%s' "$snippet" | cut -c1-58)"
	else
		printf 'FAIL %-26s want=%s got=%s :: %s\n' "$rule" "$expect" "$got" "$snippet"
		printf '%s\n' "$out" | head -3
		fail=$((fail + 1))
	fi
}

check orc-ready-ephemeral.md   fire tool bash 'bd ready --parent orc-1 --label agent:reviewer --unassigned --claim --json'
check orc-ready-ephemeral.md   miss tool bash 'bd ready --include-ephemeral --parent orc-1 --label agent:reviewer --unassigned --claim --json'
check orc-ready-ephemeral.md   miss tool bash 'bd ready --parent orc-1 --label agent:implementer --unassigned --claim --json'

check orc-shepherd-no-parent.md fire tool bash 'bd ready --parent orc-1 --label agent:integrator --unassigned --claim --json'
check orc-shepherd-no-parent.md miss tool bash 'bd ready --label agent:integrator --unassigned --claim --json'

check orc-spawn-isolated.md    fire tool task '{"agent":"orc-implementer","task":"epic orc-1"}'
check orc-spawn-isolated.md    miss tool task '{"agent":"orc-implementer","task":"epic orc-1","isolated":true}'
check orc-wait-grammar.md      fire text - 'WAIT: then CLAIM the bead'
check orc-wait-grammar.md      miss text - 'WAITING_HUMAN on the gate'

printf '\n%s\n' "$([ "$fail" -eq 0 ] && echo 'ALL HOST-ENGINE CHECKS PASS' || echo "$fail HOST-ENGINE FAILURES")"
exit "$fail"
