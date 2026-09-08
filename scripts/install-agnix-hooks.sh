#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

hook_path=".githooks"
hook="$repo_root/$hook_path/pre-commit"
if [[ ! -x "$hook" ]]; then
	printf 'agnix hook is missing or not executable: %s\n' "$hook" >&2
	exit 1
fi

# Worktree config keeps this checkout's hook chain separate from other worktrees.
git config extensions.worktreeConfig true

current_hooks="$(git config --path --get core.hooksPath || true)"

is_agnix_hooks() {
	local candidate="$1"
	local candidate_hook
	if [[ "$candidate" == /* ]]; then
		candidate_hook="$candidate/pre-commit"
	else
		candidate_hook="$repo_root/$candidate/pre-commit"
	fi
	[[ "$candidate_hook" == "$hook" ]] && return 0
	[[ -f "$candidate_hook" && -f "$hook" ]] && cmp -s -- "$candidate_hook" "$hook"
}

if ! is_agnix_hooks "$current_hooks"; then
	# Record the current effective hook path, replacing a stale path from an
	# earlier installation when another scanner was configured in between.
	if [[ -n "$current_hooks" ]]; then
		git config --worktree agnix.previousHooksPath "$current_hooks"
	else
		git config --worktree --unset agnix.previousHooksPath >/dev/null 2>&1 || true
	fi
fi

git config --worktree core.hooksPath "$hook_path"
printf 'agnix staged hook enabled for %s (existing hook path preserved)\n' "$repo_root"
