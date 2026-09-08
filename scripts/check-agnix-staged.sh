#!/usr/bin/env bash
# Validate only agentic files that are in the Git index.
#
# The hook materializes staged blobs in a temporary tree before invoking agnix. This
# prevents an unstaged repair in the worktree from changing what the commit
# gate examines, and keeps project-level checks rooted at the staged snapshot.
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

is_ignored_path() {
	case "/$1/" in
	*/.git/* | */node_modules/* | */dist/* | */target/* | */.apm/* | */.agents/* | */.dogfood-cleanroom/* | */evals/* | */tests/fixtures/*)
		return 0
		;;
	esac
	return 1
}

is_agentic_path() {
	if [[ -n "${AGNIX_SOURCE_PREFIX:-}" && "$1" != ".agnix.toml" && "$1" != "${AGNIX_SOURCE_PREFIX:-}"* ]]; then
		return 1
	fi
	case "$1" in
	.agnix.toml | AGENTS.md | */AGENTS.md | CLAUDE.md | */CLAUDE.md | SKILL.md | */SKILL.md | agents/*.md | */agents/*.md | rules/*.md | */rules/*.md | skills/*/references/*.md | */skills/*/references/*.md | skills/*/templates/*.md | */skills/*/templates/*.md | .claude-plugin/plugin.json | */.claude-plugin/plugin.json | .codex-plugin/plugin.json | */.codex-plugin/plugin.json | .claude/*.json | */.claude/*.json | .codex/*.toml | */.codex/*.toml | .codex/*.json | */.codex/*.json | .mcp.json | */.mcp.json | *.mcp.json)
		return 0
		;;
	esac
	return 1
}

staged_paths=()
config_changed=0
while IFS= read -r -d '' status && IFS= read -r -d '' path; do
	is_ignored_path "$path" && continue
	is_agentic_path "$path" || continue
	if [[ "$path" == ".agnix.toml" || "$status" == "D" ]]; then
		config_changed=1
		continue
	fi
	staged_paths+=("$path")
done < <(git diff --cached --name-status -z --no-renames --diff-filter=ACMDT --)

if ((config_changed)); then
	staged_paths=()
	while IFS= read -r -d '' path; do
		is_ignored_path "$path" && continue
		is_agentic_path "$path" || continue
		staged_paths+=("$path")
	done < <(git ls-files -z --cached --)
	((${#staged_paths[@]} > 0)) || staged_paths=(.agnix.toml)
fi

# Unrelated commits do not require agnix to be installed or runnable.
if ((${#staged_paths[@]} == 0)); then
	exit 0
fi

export MISE_AUTO_INSTALL=false
agnix_command=(agnix)
if [[ "${AGNIX_USE_MISE:-0}" == "1" ]]; then
	if ! command -v mise >/dev/null 2>&1; then
		printf 'mise is required for the pinned agnix pre-commit check.\n' >&2
		exit 1
	fi
	agnix_command=(mise exec --no-deps -- agnix)
elif ! command -v agnix >/dev/null 2>&1; then
	printf 'agnix is required for the pre-commit agentic check.\n' >&2
	printf 'Install the expected tool before committing: cargo install agnix-cli --version 0.52.2\n' >&2
	exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
	printf 'python3 is required to build the staged snapshot.\n' >&2
	exit 1
fi

if ! version="$("${agnix_command[@]}" --version 2>&1)"; then
	printf 'agnix is unavailable; prepare the toolchain before committing.\n%s\n' "$version" >&2
	exit 1
fi
if [[ "$version" != "agnix 0.52.2" ]]; then
	printf 'warning: this config was reviewed against agnix 0.52.2; found %s\n' "${version:-an unknown version}" >&2
fi

if [[ "${AGNIX_USE_MISE:-0}" == "1" ]]; then
	agnix_binary="$(mise which agnix)"
	if [[ "$agnix_binary" != /* || ! -x "$agnix_binary" ]]; then
		printf 'mise did not resolve an executable agnix binary.\n' >&2
		exit 1
	fi
	agnix_command=("$agnix_binary")
fi

staged_root="$(mktemp -d "${TMPDIR:-/tmp}/agnix-staged.XXXXXX")"
trap 'rm -rf "$staged_root"' EXIT

python3 - "$staged_root" <<'PY'
import os
import subprocess
import sys
from pathlib import Path, PurePosixPath

root = Path(sys.argv[1]).resolve()
env = dict(os.environ, GIT_NO_LAZY_FETCH="1", GIT_NO_REPLACE_OBJECTS="1")
entries = subprocess.check_output(["git", "ls-files", "--stage", "-z"], env=env)
links = []
with subprocess.Popen(
    ["git", "cat-file", "--batch"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=env
) as git:
    for entry in entries.split(b"\0"):
        if not entry:
            continue
        metadata, raw_path = entry.split(b"\t", 1)
        mode, oid, stage = metadata.split()
        relative = PurePosixPath(os.fsdecode(raw_path))
        if stage != b"0" or relative.is_absolute() or ".." in relative.parts:
            sys.exit(f"invalid staged entry: {str(relative)!r}")
        path = root / relative
        if mode == b"160000":
            path.mkdir(parents=True, exist_ok=True)
            continue
        if mode not in (b"100644", b"100755", b"120000"):
            sys.exit(f"unsupported staged mode: {str(relative)!r}")
        git.stdin.write(oid + b"\n")
        git.stdin.flush()
        header = git.stdout.readline().split()
        if len(header) != 3 or header[1] != b"blob":
            sys.exit(f"staged blob unavailable locally: {str(relative)!r}")
        remaining = int(header[2])
        path.parent.mkdir(parents=True, exist_ok=True)
        if mode == b"120000":
            if remaining > 4096:
                sys.exit(f"staged symlink target is too long: {str(relative)!r}")
            links.append((path, os.fsdecode(git.stdout.read(remaining))))
        else:
            with path.open("wb") as output:
                while remaining:
                    chunk = git.stdout.read(min(remaining, 65536))
                    if not chunk:
                        sys.exit(f"incomplete staged blob: {str(relative)!r}")
                    output.write(chunk)
                    remaining -= len(chunk)
            path.chmod(0o755 if mode == b"100755" else 0o644)
        if git.stdout.read(1) != b"\n":
            sys.exit("invalid git cat-file response")
    git.stdin.close()
    if git.wait() != 0:
        sys.exit("git cat-file failed")

for path, target in links:
    path.symlink_to(target)
for path, _ in links:
    try:
        target = path.resolve(strict=True)
    except (OSError, RuntimeError):
        sys.exit(f"unresolvable staged symlink: {str(path.relative_to(root))!r}")
    if not target.is_relative_to(root):
        sys.exit(f"staged symlink escapes the index snapshot: {str(path.relative_to(root))!r}")
PY

if [[ ! -f "$staged_root/.agnix.toml" ]]; then
	printf 'agnix pre-commit check requires a staged .agnix.toml; stage that config first.\n' >&2
	exit 1
fi

for path in "${staged_paths[@]}"; do
	if [[ ! -e "$staged_root/$path" && ! -L "$staged_root/$path" ]]; then
		printf 'staged path disappeared from the index snapshot: %s\n' "$path" >&2
		exit 1
	fi
done

(
	cd "$staged_root"
	exec "${agnix_command[@]}" --config .agnix.toml --format text -- "${staged_paths[@]}"
)
