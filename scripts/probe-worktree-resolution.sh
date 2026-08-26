#!/bin/sh
# Does a linked git worktree reach the run's database, or report none?
#
# This closes an inference that shipped as a feature and then as a guard. `src/beads-mode.ts`
# once refused in a linked worktree, and `.worktreeinclude` once named `.beads/` so worktrunk
# would copy it, both on the belief that a worktree inherits no database. That belief came
# from listing files -- `.beads/` is gitignored, so a worktree has none -- and never from
# running `bd`.
#
# The copy that belief demanded was itself harmful. `.worktreeinclude` matches top-level
# entries only, measured: `.beads/`, `.beads`, `/.beads/` and `/.beads` each resolve to
# `.beads (dir)` while `.beads/*`, `.beads/*.json` and `.beads/**` match nothing. So the only
# expressible form copies `.beads/dolt/` as well, and a worktree holding that store is exactly
# what would serve it as a second database once the port file went stale.
#
# Worktrees are created through `wt`, never `git worktree add`. This repository enforces that
# policy on the agent, and a script that reached for git directly would pass only because the
# check cannot see inside a file. Creating them the sanctioned way also makes the probe
# faithful: `wt` runs the copy-ignored step, so what it produces is what a real worker gets.
#
# This asserts rather than narrates. The script exits nonzero when any check fails, so
# automation cannot read a disproved assumption as success:
#
#   - the worktree holds no `.beads/dolt/` storage of its own
#   - `bd where` from the worktree names the PRIMARY checkout's database
#   - the worktree reads the same bead count the primary has
#   - a write from the worktree raises the primary's count
#   - none of it needs BEADS_DIR: the environment is explicitly cleared first
#
# The write is deliberately unguarded: a create that fails from the worktree is the finding.
#
# Not part of the suite: it needs `bd` and `wt` on PATH and it starts a Dolt server, none of
# which CI has. Run it by hand when the worktree assumption changes.
#
#   sh scripts/probe-worktree-resolution.sh
#
# Measured with beads 1.1.2 and wt 0.69.2 on darwin/arm64, and in five live worktrees of this
# repository: every one resolved to the primary's database and read all of its beads.
#
# Built under $HOME rather than /tmp. A worktree under /tmp or /private/tmp is invisible
# inside the container git runs in on this host, so this repository forbids creating one there.

set -eu

command -v bd >/dev/null 2>&1 || { echo "bd is not on PATH: nothing to probe"; exit 2; }
command -v wt >/dev/null 2>&1 || { echo "wt is not on PATH: nothing to probe"; exit 2; }

# Cleared, not inherited. The whole point is that resolution needs no override.
unset BEADS_DIR

root=$(mktemp -d "$HOME/.orc-wtprobe-XXXXXX")
primary="$root/primary"
branch="orc-probe-worktree"

# `wt` places worktrees outside the repository, so teardown removes the worktree through wt
# and then the scratch root. Both are best-effort: a failed cleanup must not mask a finding.
cleanup() {
	(cd "$primary" 2>/dev/null && wt remove "$branch" --yes >/dev/null 2>&1) || true
	rm -r -- "$root" >/dev/null 2>&1 || true
}
trap cleanup EXIT

mkdir -p "$primary"
cd "$primary"
git init -q -b main
git config user.email probe@test.local
git config user.name Probe
echo seed > seed
git add seed
git commit -q --no-gpg-sign -m seed

# --skip-hooks because core.hooksPath is owned by git-defender on this host, and bd would
# repoint it. --server because a run requires a per-project Dolt server.
bd init --init-if-missing --skip-hooks --server --non-interactive -q >/dev/null 2>&1
BEADS_ACTOR=probe bd create "primary bead" --type task >/dev/null 2>&1

# --yes pre-approves any project hook; a scratch repo has none, and the flag keeps the probe
# from stalling on a prompt it cannot answer.
wt switch --create "$branch" --yes >/dev/null 2>&1

# Read the path back from git rather than predicting wt's layout. A read cannot create a
# worktree, so it bypasses no policy.
linked=$(git worktree list --porcelain | awk '/^worktree /{p=$2} /^branch refs\/heads\/'"$branch"'$/{print p}')
[ -n "$linked" ] && [ -d "$linked" ] || { echo "wt did not produce a worktree for $branch"; exit 1; }

failures=0
check() {
	if [ "$2" = "$3" ]; then
		printf 'ok    %s\n' "$1"
	else
		printf 'FAIL  %s: expected %s, got %s\n' "$1" "$3" "$2"
		failures=$((failures + 1))
	fi
}

# Storage, not the directory. `wt` may leave a `.beads/` holding only connection files, and
# what must never arrive is `dolt/`: that is the store a worktree could serve as a second
# database once the port file goes stale.
cd "$linked"
check "worktree holds no dolt storage" "$([ -d .beads/dolt ] && echo yes || echo no)" "no"

primary_db=$(cd "$primary" && bd where 2>/dev/null | head -1 | tr -d ' ')
linked_db=$(bd where 2>/dev/null | head -1 | tr -d ' ')
check "bd where names the primary's database" "$linked_db" "$primary_db"

count() { bd list --json 2>/dev/null | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))'; }
primary_count=$(cd "$primary" && count)
check "worktree reads the primary's bead count" "$(count)" "$primary_count"

BEADS_ACTOR=probe bd create "written from the worktree" --type task >/dev/null 2>&1
check "a worktree write reaches the primary" "$(cd "$primary" && count)" "$((primary_count + 1))"

if [ "$failures" -eq 0 ]; then
	echo "PASS: a linked worktree resolves the run's database with no copy and no BEADS_DIR"
else
	echo "$failures assertion(s) failed"
	exit 1
fi
