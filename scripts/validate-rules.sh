#!/bin/sh
# Validate every TTSR rule against the HOST engine, not Python's `re`.
#
# Python accepting a pattern proves nothing about the engine that evaluates these
# rules: lookbehind support, `\A`/`\Z`, and named-group syntax all differ. Each case
# asserts a positive fires and a negative does not, through `omp ttsr test`.
#
# The host matches a rule against the tool call's streamed argument JSON, not the
# command text: for `bash` the buffer is `{"command":"…"}` where a shell newline is
# the two characters `\n` and a quote is `\"`. check() wraps every bash snippet in
# that envelope, so bash snippets below are written as the JSON string body the model
# streams (`\n` for a newline, `\t` for a tab, `\"` for a quote). `task` and `hub`
# snippets are the argument object itself. `text` snippets are raw prose.
#
# Local gate, deliberately not in CI: it needs an installed `omp`, which the CI
# runners do not have. Run it after touching any rule frontmatter.
#
# Seven rules used to live here -- the -C pin, the actor prefix, the comment verb, the
# bug-bead route, the one-claim count, the implementer spawn shape and the shell half of
# the nested-omp rule. They are tool_call gates now, because a regex cannot see whether a
# run is active and so nagged every session that mentioned `bd` or ran an `omp -p` probe,
# and a regex over streamed JSON cannot see a parsed argument. The retired WAIT/CLAIM
# grammar canary is gone too: it matched ordinary prose. Their corpus moved to
# `test/gate-bd.test.ts`, `test/claim.test.ts` and `test/wiring.test.ts`, which run in
# CI. Do not re-add them here.
set -u
cd "$(dirname "$0")/.." 2>/dev/null || exit 2

fail=0

# check <rule> <fire|miss> <kind> <snippet>
#   bash       snippet is the command text as streamed inside `{"command":"…"}`
#   bash-json  snippet is a complete bash argument object (to test other fields)
#   task|hub   snippet is the tool's argument object
#   text       snippet is prose
check() {
	rule="$1"
	expect="$2"
	kind="$3"
	snippet="$4"
	case "$kind" in
	text) out=$(omp ttsr test --rule "rules/$rule" --source text "$snippet" 2>&1) ;;
	bash) out=$(omp ttsr test --rule "rules/$rule" --source tool --tool bash "{\"command\":\"$snippet\"}" 2>&1) ;;
	bash-json) out=$(omp ttsr test --rule "rules/$rule" --source tool --tool bash "$snippet" 2>&1) ;;
	*) out=$(omp ttsr test --rule "rules/$rule" --source tool --tool "$kind" "$snippet" 2>&1) ;;
	esac
	status=$?
	case "$status:$out" in
	1:*"No rules triggered."*) got=miss ;;
	0:*) got=fire ;;
	*)
		printf 'FAIL %-26s engine exit=%s :: %s\n' "$rule" "$status" "$out"
		fail=$((fail + 1))
		return
		;;
	esac
	if [ "$got" = "$expect" ]; then
		printf 'ok   %-26s %-4s %s\n' "$rule" "$got" "$(printf '%s' "$snippet" | cut -c1-58)"
	else
		printf 'FAIL %-26s want=%s got=%s :: %s\n' "$rule" "$expect" "$got" "$snippet"
		printf '%s\n' "$out" | head -3
		fail=$((fail + 1))
	fi
}

# orc-ready-ephemeral: column-0 `bd` follows the envelope's opening quote.
check orc-ready-ephemeral.md fire bash 'bd ready --parent orc-1 --label agent:reviewer --unassigned --claim --json'
check orc-ready-ephemeral.md miss bash 'bd ready --include-ephemeral --parent orc-1 --label agent:reviewer --unassigned --claim --json'
check orc-ready-ephemeral.md miss bash 'bd ready --parent orc-1 --label agent:implementer --unassigned --claim --json'
check orc-ready-ephemeral.md fire bash 'bd ready --parent orc-1 --metadata-field role=reviewer --unassigned --claim --json'
check orc-ready-ephemeral.md fire bash 'bd -C /repo ready --metadata-field=role=researcher --claim --json'
check orc-ready-ephemeral.md miss bash 'bd ready --metadata-field role=reviewer --include-ephemeral --claim --json'
check orc-ready-ephemeral.md miss bash 'bd ready --metadata-field role=implementer --claim --json'
check orc-ready-ephemeral.md fire bash 'cd /repo && bd ready --label agent:reviewer --claim --json'
check orc-ready-ephemeral.md fire bash 'BEADS_ACTOR=x bd ready --label agent:reviewer --claim --json'
check orc-ready-ephemeral.md fire bash 'bd list --json\nbd ready --label agent:reviewer --claim --json'
check orc-ready-ephemeral.md fire bash 'if true; then\n\tbd ready --label agent:reviewer --claim --json\nfi'
check orc-ready-ephemeral.md fire bash 'bd ready --label agent:reviewer --claim --json\nbd ready --include-ephemeral --label agent:reviewer'
check orc-ready-ephemeral.md miss bash 'bd ready --claim --json\nbd list --label agent:reviewer'
check orc-ready-ephemeral.md miss bash 'sbd ready --label agent:reviewer --claim --json'
# --include-ephemeral in another field of the same call must not silence the rule.
check orc-ready-ephemeral.md fire bash-json '{"command":"bd ready --label agent:reviewer --claim --json","description":"with --include-ephemeral"}'

# orc-shepherd-no-parent
check orc-shepherd-no-parent.md fire bash 'bd ready --parent orc-1 --label agent:integrator --unassigned --claim --json'
check orc-shepherd-no-parent.md miss bash 'bd ready --label agent:integrator --unassigned --claim --json'
check orc-shepherd-no-parent.md fire bash 'bd ready --parent orc-1 --metadata-field role=shepherd --label pr:merge --claim --json'
check orc-shepherd-no-parent.md fire bash 'bd -C /repo ready --metadata-field=role=shepherd --parent orc-1 --claim --json'
check orc-shepherd-no-parent.md miss bash 'bd ready --metadata-field role=shepherd --label pr:merge --claim --json'
check orc-shepherd-no-parent.md miss bash 'bd ready --parent orc-1 --metadata-field role=implementer --claim --json'
check orc-shepherd-no-parent.md fire bash 'cd /x && bd ready --parent orc-1 --label pr:merge --claim --json'
check orc-shepherd-no-parent.md miss bash 'bd ready --parent orc-1 --json\nbd ready --label pr:merge --json'

# orc-no-nested-omp: both conditions read hub start. The bash shape is G6's notice.
check orc-no-nested-omp.md fire hub '{"op":"start","name":"arch","application":"omp","args":["-p","hi"]}'
check orc-no-nested-omp.md fire hub '{"op":"start","name":"arch","application":"sh","args":["-c","omp -p hi"]}'
check orc-no-nested-omp.md miss hub '{"op":"start","name":"web","application":"bun","args":["run","dev"]}'
check orc-no-nested-omp.md miss bash 'omp -p \"hi\"'

printf '\n%s\n' "$([ "$fail" -eq 0 ] && echo 'ALL HOST-ENGINE CHECKS PASS' || echo "$fail HOST-ENGINE FAILURES")"
exit "$fail"
