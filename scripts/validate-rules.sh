#!/bin/sh
# Validate every TTSR rule against the HOST engine, not Python's `re`.
#
# Python accepting a pattern proves nothing about the engine that evaluates these
# rules: lookbehind support, `\A`/`\Z`, and named-group syntax all differ. Each case
# asserts a positive fires and a negative does not, through `omp ttsr test`.
#
# Local gate, deliberately not in CI: it needs an installed `omp`, which the CI
# runners do not have. Run it after touching any rule frontmatter.
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

# orc-bd-pin: an unpinned bd call reads and writes the copy inside an isolated
# workspace. Every spelling of the pin must suppress it, or the reminder becomes
# noise the moment an agent complies.
check orc-bd-pin.md            fire tool bash 'bd ready --parent orc-1 --label agent:implementer --unassigned --claim --json'
check orc-bd-pin.md            fire tool bash 'bd update orc-1 --claim'
check orc-bd-pin.md            fire tool bash 'cd /repo && bd comment orc-1 "REPORTED done"'
check orc-bd-pin.md            miss tool bash 'bd -C /repo ready --parent orc-1 --claim --json'
check orc-bd-pin.md            miss tool bash 'bd -C=/repo ready --parent orc-1 --claim --json'
check orc-bd-pin.md            miss tool bash 'bd --directory /repo update orc-1 --claim'
check orc-bd-pin.md            miss tool bash 'bd --directory=/repo update orc-1 --claim'
check orc-bd-pin.md            miss tool bash 'bd ready --parent orc-1 --claim -C /repo'
check orc-bd-pin.md            miss tool bash 'bd -C/repo ready --parent orc-1 --claim --json'
check orc-bd-pin.md            miss tool bash 'bd -Crepo/sub update orc-1 --claim'
# Known limitation, encoded rather than left to be discovered: the condition is
# line-scoped, so a pin anywhere on the line suppresses every bd call on it. A
# chain whose SECOND call is pinned hides an unpinned first one. Closing it needs
# per-invocation parsing, which a regex layer cannot do -- the gate layer sees
# these argv properly.
check orc-bd-pin.md            miss tool bash 'bd update orc-1 --claim && bd -C /repo show orc-1'
check orc-bd-pin.md            miss tool bash 'git status'

check orc-comment-verbs.md     fire tool bash 'bd comment orc-1 "finished the thing"'
check orc-comment-verbs.md     miss tool bash 'bd comment orc-1 "REPORTED finished the thing"'

# A bug bead with no parent or no route is unpullable: no queue filter can reach it.
check orc-bug-bead-routing.md  fire tool bash 'bd create "x" --type bug --silent'
check orc-bug-bead-routing.md  fire tool bash 'bd create "x" --type bug --parent orc-1 --silent'
check orc-bug-bead-routing.md  fire tool bash 'bd create "x" --type bug --labels agent:implementer --silent'
check orc-bug-bead-routing.md  miss tool bash 'bd -C /repo create "x" --type bug --parent orc-1 --labels agent:implementer,kind:incidental --silent'
# Ordinary node and epic creation must stay silent.
check orc-bug-bead-routing.md  miss tool bash 'bd create "an epic" --type epic --silent'
check orc-bug-bead-routing.md  miss tool bash 'bd create "a task" --type task --labels agent:implementer --silent'

check orc-spawn-isolated.md    fire tool task '{"agent":"orc-implementer","task":"epic orc-1"}'
check orc-spawn-isolated.md    miss tool task '{"agent":"orc-implementer","task":"epic orc-1","isolated":true}'
check orc-wait-grammar.md      fire text - 'WAIT: then CLAIM the bead'
check orc-wait-grammar.md      miss text - 'WAITING_HUMAN on the gate'

printf '\n%s\n' "$([ "$fail" -eq 0 ] && echo 'ALL HOST-ENGINE CHECKS PASS' || echo "$fail HOST-ENGINE FAILURES")"
exit "$fail"
