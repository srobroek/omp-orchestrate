#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

tracked_hooks="$repo_root/.githooks"
tracked_pre_commit="$tracked_hooks/pre-commit"
if [[ ! -x "$tracked_pre_commit" ]]; then
	printf 'agnix hook is missing or not executable: %s\n' "$tracked_pre_commit" >&2
	exit 1
fi

# Worktree config keeps this checkout's generated hook chain separate from
# other worktrees, while retaining every hook from the prior hook directory.
git config extensions.worktreeConfig true
git_dir="$(git rev-parse --git-dir)"
agnix_hooks="$(git config --worktree --get agnix.hooksPath || true)"
if [[ -z "$agnix_hooks" ]]; then
	agnix_hooks="$git_dir/agnix-hooks"
fi
case "$agnix_hooks" in
/*) ;;
*) agnix_hooks="$repo_root/$agnix_hooks" ;;
esac

resolve_hooks_path() {
	local candidate="$1"
	case "$candidate" in
	/*) printf '%s\n' "$candidate" ;;
	*) printf '%s/%s\n' "$repo_root" "$candidate" ;;
	esac
}

current_hooks="$(git config --path --get core.hooksPath || true)"
current_hooks_dir=""
if [[ -n "$current_hooks" ]]; then
	current_hooks_dir="$(resolve_hooks_path "$current_hooks")"
fi
previous_hooks="$(git config --worktree --get agnix.previousHooksPath || true)"
if [[ -n "$previous_hooks" ]]; then
	previous_hooks="$(resolve_hooks_path "$previous_hooks")"
fi

source_hooks=()
if [[ -n "$current_hooks_dir" && "$current_hooks_dir" == "$agnix_hooks" ]]; then
	if [[ -n "$previous_hooks" ]]; then
		source_hooks+=("$previous_hooks")
	else
		source_hooks+=("$(git rev-parse --git-common-dir)/hooks")
	fi
elif [[ -n "$current_hooks_dir" ]]; then
	# Another scanner may have replaced our generated directory. Capture that
	# effective path and rebuild the chain around it.
	previous_hooks="$current_hooks_dir"
	git config --worktree agnix.previousHooksPath "$previous_hooks"
	if [[ "$current_hooks_dir" == "$tracked_hooks" ]]; then
		# The old tracked-only activation had no metadata. Preserve its
		# siblings and the conventional common hooks directory.
		previous_hooks="$(git rev-parse --git-common-dir)/hooks"
		git config --worktree agnix.previousHooksPath "$previous_hooks"
		source_hooks+=("$tracked_hooks")
		source_hooks+=("$previous_hooks")
	else
		source_hooks+=("$previous_hooks")
	fi
else
	# With no configured path Git uses the common hooks directory.
	source_hooks+=("$(git rev-parse --git-common-dir)/hooks")
fi

if [[ -z "$previous_hooks" ]]; then
	git config --worktree --unset agnix.previousHooksPath >/dev/null 2>&1 || true
fi

if [[ -e "$agnix_hooks" && ! -d "$agnix_hooks" ]]; then
	printf 'agnix hook directory is not a directory: %s\n' "$agnix_hooks" >&2
	exit 1
fi
rm -rf -- "$agnix_hooks"
mkdir -p -- "$agnix_hooks"

# The tracked wrapper owns pre-commit. Every other regular hook remains
# reachable through a symlink, including commit-msg and pre-push.
ln -s -- "$tracked_pre_commit" "$agnix_hooks/pre-commit"
for hooks_dir in "${source_hooks[@]}"; do
	[[ -d "$hooks_dir" ]] || continue
	shopt -s nullglob dotglob
	for source_hook in "$hooks_dir"/*; do
		[[ -f "$source_hook" ]] || continue
		hook_name="${source_hook##*/}"
		[[ "$hook_name" == "pre-commit" ]] && continue
		[[ -e "$agnix_hooks/$hook_name" || -L "$agnix_hooks/$hook_name" ]] && continue
		ln -s -- "$source_hook" "$agnix_hooks/$hook_name"
	done
	shopt -u dotglob nullglob
done

git config --worktree agnix.hooksPath "$agnix_hooks"
git config --worktree core.hooksPath "$agnix_hooks"
printf 'agnix staged hook enabled for %s (all existing hooks preserved)\n' "$repo_root"
