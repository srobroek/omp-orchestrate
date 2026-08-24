#!/usr/bin/env bash
# Reclaim finished Worktrunk checkouts and quarantine broken harness orphans.
#
# Registered worktrees are removed only through `wt remove`. Prune mode scans
# known harness roots and moves broken, unregistered directories to quarantine.
# It never deletes their contents (disk/orphan history: bead astro-plan-ki35).
#
# Usage:
#   worktree-sweep.sh [--discard-branch] <worktree-path>
#   worktree-sweep.sh --prune <repo-path>
# Exit codes: 0 swept/quarantined, 1 dirty (refused), 2 usage/tool/safety error.
set -euo pipefail

die() {
	echo "worktree-sweep: $*" >&2
	exit 2
}

WT_BIN="${WT_BIN:-wt}"
GIT_BIN="${GIT_BIN:-git}"
PYTHON_BIN="${PYTHON_BIN:-python3}"

command -v "$WT_BIN" >/dev/null 2>&1 || die "wt is not available"
command -v "$GIT_BIN" >/dev/null 2>&1 || die "git is not available"
command -v "$PYTHON_BIN" >/dev/null 2>&1 || die "python3 is not available"

read_inventory() {
	local anchor="$1"
	local output
	# Pin the JSON schema so a future Worktrunk default flip cannot change the
	# parsed shape underneath this sweep.
	if ! output="$("$WT_BIN" -C "$anchor" --config-set 'list.json-schema=2' list --format=json 2>/dev/null)"; then
		die "wt list failed for: $anchor"
	fi
	# Flatten the schema-2 envelope to the flat rows the rest of this script reads.
	if ! output="$(printf '%s' "$output" | "$PYTHON_BIN" -c '
import json
import sys

try:
    payload = json.load(sys.stdin)
except (json.JSONDecodeError, TypeError) as error:
    raise SystemExit(f"invalid JSON: {error}")
if isinstance(payload, dict):
    rows = payload.get("items")
    if not isinstance(rows, list):
        raise SystemExit("inventory envelope has no items array")
    flattened = []
    for row in rows:
        if not isinstance(row, dict):
            raise SystemExit("inventory contains a non-object item")
        merged = dict(row)
        worktree = row.get("worktree")
        if isinstance(worktree, dict):
            if "path" in worktree:
                merged["path"] = worktree["path"]
            merged["is_main"] = bool(worktree.get("main"))
        flattened.append(merged)
    rows = flattened
else:
    rows = payload
if not isinstance(rows, list):
    raise SystemExit("inventory is not an array")
for row in rows:
    if not isinstance(row, dict):
        raise SystemExit("inventory contains a non-object item")
    if "path" in row and not isinstance(row["path"], str):
        raise SystemExit("inventory path is not a string")
json.dump(rows, sys.stdout)
')"; then
		die "wt list returned invalid inventory for: $anchor"
	fi
	printf '%s' "$output"
}

classify_path() {
	local inventory="$1"
	local target="$2"
	printf '%s' "$inventory" |
		"$PYTHON_BIN" -c '
import json
import os
import sys

target = os.path.realpath(sys.argv[1])
rows = json.load(sys.stdin)
for row in rows:
    path = row.get("path")
    if path and os.path.realpath(path) == target:
        print("main" if row.get("is_main") else "linked")
        break
' "$target"
}

quarantine_path() {
	local source="$1"
	local tmp_root="$2"
	local quarantine_root="${ORCHESTRATE_ORPHAN_QUARANTINE:-$tmp_root/orchestrate-orphan-quarantine}"
	local stamp destination counter

	mkdir -p "$quarantine_root"
	stamp="$(date -u +%Y%m%dT%H%M%SZ)"
	destination="$quarantine_root/$(basename "$source").$stamp"
	counter=1
	while [ -e "$destination" ]; do
		counter=$((counter + 1))
		destination="$quarantine_root/$(basename "$source").$stamp-$counter"
	done
	mv "$source" "$destination"
	echo "quarantined orphan: $source -> $destination"
}

if [ "${1:-}" = "--prune" ]; then
	[ "$#" -eq 2 ] || die "usage: worktree-sweep.sh --prune <repo-path>"
	repo_path="$2"
	[ -d "$repo_path" ] || die "not a directory: $repo_path"
	repo_path="$(cd "$repo_path" && pwd -P)"
	repo_top="$("$GIT_BIN" -C "$repo_path" rev-parse --show-toplevel)" ||
		die "not a Git repository: $repo_path"
	repo_name="$(basename "$repo_top")"
	list_json="$(read_inventory "$repo_path")"
	tmp_root="$(cd "${TMPDIR:-/tmp}" && pwd -P)"
	roots=(
		"$tmp_root/claude-worktrees/$repo_name"
		"$tmp_root/codex-worktrees/$repo_name"
		"/private/tmp/claude-worktrees/$repo_name"
		"/private/tmp/codex-worktrees/$repo_name"
	)
	if [ -n "${ORCHESTRATE_HARNESS_ROOT:-}" ]; then
		[ -d "$ORCHESTRATE_HARNESS_ROOT" ] ||
			die "not a directory: $ORCHESTRATE_HARNESS_ROOT"
		roots+=("$(cd "$ORCHESTRATE_HARNESS_ROOT" && pwd -P)")
	fi

	quarantined=0
	refused=0
	for harness_root in "${roots[@]}"; do
		[ -d "$harness_root" ] || continue
		harness_root="$(cd "$harness_root" && pwd -P)"
		for raw_candidate in "$harness_root"/*; do
			[ -d "$raw_candidate" ] || continue
			if [ -L "$raw_candidate" ]; then
				echo "worktree-sweep: refusing symlink candidate: $raw_candidate" >&2
				refused=$((refused + 1))
				continue
			fi
			candidate="$(cd "$raw_candidate" && pwd -P)"
			case "$candidate" in
			"$harness_root"/*) ;;
			*)
				echo "worktree-sweep: refusing escaped harness path: $candidate" >&2
				refused=$((refused + 1))
				continue
				;;
			esac

			registration="$(classify_path "$list_json" "$candidate")"
			if [ "$registration" = "main" ]; then
				echo "worktree-sweep: refusing primary worktree: $candidate" >&2
				refused=$((refused + 1))
				continue
			fi
			[ "$registration" != "linked" ] || continue

			if "$GIT_BIN" -C "$candidate" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
				status="$("$GIT_BIN" -C "$candidate" status --porcelain 2>/dev/null || true)"
				if [ -n "$status" ]; then
					echo "worktree-sweep: refusing dirty unregistered worktree: $candidate" >&2
				else
					echo "worktree-sweep: refusing valid unregistered worktree: $candidate" >&2
				fi
				refused=$((refused + 1))
				continue
			fi

			if [ ! -f "$candidate/.git" ]; then
				echo "worktree-sweep: refusing unknown harness directory: $candidate" >&2
				refused=$((refused + 1))
				continue
			fi

			quarantine_path "$candidate" "$tmp_root"
			quarantined=$((quarantined + 1))
		done
	done

	echo "worktree-sweep: quarantined $quarantined orphan(s); refused $refused path(s)"
	[ "$refused" -eq 0 ] || exit 1
	exit 0
fi

discard_branch=0
if [ "${1:-}" = "--discard-branch" ]; then
	discard_branch=1
	shift
fi
[ "$#" -eq 1 ] ||
	die "usage: worktree-sweep.sh [--discard-branch] <worktree-path> | --prune <repo-path>"

wt_path="$1"
[ -d "$wt_path" ] || die "not a directory: $wt_path"
wt_path="$(cd "$wt_path" && pwd -P)"
list_json="$(read_inventory "$wt_path")"
registration="$(classify_path "$list_json" "$wt_path")"
[ "$registration" = "linked" ] || {
	[ "$registration" != "main" ] ||
		die "refusing to remove the primary worktree: $wt_path"
	die "path is not registered with Worktrunk: $wt_path"
}

status="$("$GIT_BIN" -C "$wt_path" status --porcelain)" ||
	die "cannot inspect registered worktree: $wt_path"
if [ -n "$status" ]; then
	echo "worktree-sweep: dirty, refusing: $wt_path" >&2
	exit 1
fi

remove_args=(remove --foreground)
if [ "$discard_branch" -eq 1 ]; then
	remove_args+=(--force-delete)
fi
remove_args+=("$wt_path")
"$WT_BIN" -C "$wt_path" "${remove_args[@]}"
echo "swept: $wt_path"
