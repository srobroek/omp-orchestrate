#!/usr/bin/env python3
"""Install the staged agnix check while preserving the existing hook chain."""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path
from typing import NoReturn, Sequence


class InstallerError(Exception):
    """An expected installation failure with a user-facing message."""


def fail(message: str) -> NoReturn:
    raise InstallerError(message)


def git(
    args: Sequence[str],
    *,
    cwd: Path,
    capture: bool = True,
    check: bool = True,
) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=cwd,
        text=True,
        capture_output=capture,
        check=False,
    )
    if check and result.returncode:
        raise subprocess.CalledProcessError(result.returncode, ["git", *args], result.stdout, result.stderr)
    return (result.stdout or "").rstrip("\n")


def optional_git(args: Sequence[str], cwd: Path) -> str:
    result = subprocess.run(
        ["git", *args], cwd=cwd, text=True, capture_output=True, check=False
    )
    return (result.stdout or "").rstrip("\n") if result.returncode == 0 else ""


def absolute_path(repo_root: Path, candidate: str) -> str:
    return candidate if os.path.isabs(candidate) else os.path.join(str(repo_root), candidate)


def executable_hooks(source: str, *, exclude: str) -> list[tuple[str, str]]:
    if not os.path.isdir(source) or source == exclude:
        return []
    hooks: list[tuple[str, str]] = []
    try:
        entries = os.scandir(source)
    except OSError:
        return hooks
    with entries:
        for entry in entries:
            if entry.name == "pre-commit":
                continue
            try:
                if entry.is_file(follow_symlinks=True) and os.access(entry.path, os.X_OK):
                    hooks.append((entry.name, entry.path))
            except OSError:
                continue
    return hooks


def symlink(path: str, target: str) -> None:
    if os.path.lexists(path):
        if not os.path.islink(path):
            fail(f"cannot replace non-symlink at {path}")
        os.unlink(path)
    os.symlink(target, path)


def main() -> int:
    try:
        repo_root = Path(git(["rev-parse", "--show-toplevel"], cwd=Path.cwd())).resolve()
        os.chdir(repo_root)
        tracked_hooks = repo_root / ".githooks"
        tracked_pre_commit = tracked_hooks / "pre-commit"
        if not tracked_pre_commit.is_file() or not os.access(tracked_pre_commit, os.X_OK):
            fail(f"expected executable hook is missing: {tracked_pre_commit}")

        configured_hooks = optional_git(["config", "--path", "--get", "core.hooksPath"], repo_root)
        git(["config", "extensions.worktreeConfig", "true"], cwd=repo_root)
        git_dir = absolute_path(repo_root, git(["rev-parse", "--git-dir"], cwd=repo_root))
        agnix_hooks = os.path.join(git_dir, "agnix-hooks")
        common_hooks = absolute_path(
            repo_root, os.path.join(git(["rev-parse", "--git-common-dir"], cwd=repo_root), "hooks")
        )

        if configured_hooks:
            current_hooks = git(["rev-parse", "--git-path", "hooks"], cwd=repo_root)
        else:
            current_hooks = common_hooks
        current_hooks = absolute_path(repo_root, current_hooks)

        recorded_hooks = optional_git(["config", "--worktree", "--get", "agnix.hooksPath"], repo_root)
        if recorded_hooks:
            recorded_hooks = absolute_path(repo_root, recorded_hooks)
        previous_hooks = optional_git(
            ["config", "--worktree", "--get", "agnix.previousHooksPath"], repo_root
        )
        if previous_hooks:
            previous_hooks = absolute_path(repo_root, previous_hooks)

        managed_paths = {agnix_hooks, str(tracked_hooks)}
        if recorded_hooks:
            managed_paths.add(recorded_hooks)
        if current_hooks in managed_paths:
            if not previous_hooks or previous_hooks in {agnix_hooks, str(tracked_hooks)}:
                source_hooks = common_hooks
                git(["config", "--worktree", "agnix.previousHooksPath", source_hooks], cwd=repo_root)
            else:
                source_hooks = previous_hooks
        else:
            source_hooks = current_hooks
            git(["config", "--worktree", "agnix.previousHooksPath", source_hooks], cwd=repo_root)

        generated = [("pre-commit", str(tracked_pre_commit))]
        generated.extend(executable_hooks(source_hooks, exclude=agnix_hooks))
        os.makedirs(agnix_hooks, exist_ok=True)
        for name, _ in generated:
            target = os.path.join(agnix_hooks, name)
            if os.path.exists(target) and not os.path.islink(target):
                print(
                    f"cannot install agnix hook {name}: non-symlink already exists at {target}",
                    file=sys.stderr,
                )
                return 1

        git(["config", "--worktree", "agnix.hooksInstalled", "true"], cwd=repo_root)
        git(["config", "--worktree", "agnix.hooksPath", agnix_hooks], cwd=repo_root)
        try:
            entries = os.scandir(agnix_hooks)
        except OSError as error:
            fail(f"unable to inspect agnix hooks directory: {error}")
        with entries:
            for entry in entries:
                if entry.is_symlink():
                    os.unlink(entry.path)
        for name, target in generated:
            symlink(os.path.join(agnix_hooks, name), target)
        git(["config", "--worktree", "core.hooksPath", agnix_hooks], cwd=repo_root)
        print("Installed agnix hooks for this worktree; existing hooks remain chained.")
        return 0
    except InstallerError as error:
        print(str(error), file=sys.stderr)
        return 1
    except (OSError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
