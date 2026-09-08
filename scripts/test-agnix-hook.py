#!/usr/bin/env python3
"""Exercise the staged agnix gate against staged and CI-style snapshots."""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
CHECKER = ROOT / "scripts" / "check-agnix-staged.sh"
INSTALLER = ROOT / "scripts" / "install-agnix-hooks.sh"
TRACKED_WRAPPER = ROOT / ".githooks" / "pre-commit"
FIXTURE_ENV = {
    key: value
    for key, value in os.environ.items()
    if not key.startswith(("AGNIX_", "GIT_"))
}
FIXTURE_ENV["GIT_CONFIG_NOSYSTEM"] = "1"


def git(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=repo,
        env=FIXTURE_ENV,
        check=True,
        text=True,
        capture_output=True,
    )
    return result.stdout.strip()


def checker(
    repo: Path,
    *,
    base: str | None = None,
    overrides: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    env = FIXTURE_ENV.copy()
    if base is None:
        env.pop("AGNIX_DIFF_BASE", None)
    else:
        env["AGNIX_DIFF_BASE"] = base
    if overrides:
        env.update(overrides)
    return subprocess.run(
        [str(CHECKER)],
        cwd=repo,
        env=env,
        text=True,
        capture_output=True,
    )


def output(result: subprocess.CompletedProcess[str]) -> str:
    return (result.stdout + result.stderr).strip()


def expect_success(result: subprocess.CompletedProcess[str], case: str) -> None:
    if result.returncode != 0:
        raise AssertionError(f"{case} failed: {output(result)}")


def expect_failure(result: subprocess.CompletedProcess[str], case: str) -> None:
    if result.returncode == 0:
        raise AssertionError(f"{case} unexpectedly passed")


def write_hook(path: Path, label: str) -> None:
    path.write_text(
        "#!/usr/bin/env bash\n"
        "set -euo pipefail\n"
        f'printf "%s\\n" "{label}:$1" >> "$HOOK_LOG"\n'
    )
    path.chmod(0o755)


def run_installer(repo: Path) -> None:
    result = subprocess.run(
        [str(repo / "scripts" / "install-agnix-hooks.sh")],
        cwd=repo,
        env=FIXTURE_ENV,
        text=True,
        capture_output=True,
    )
    expect_success(result, "hook installation")


def run_hook(repo: Path, hook_name: str) -> list[str]:
    hooks_path = Path(git(repo, "config", "--path", "--get", "core.hooksPath"))
    log = repo / "hook.log"
    log.unlink(missing_ok=True)
    env = FIXTURE_ENV.copy()
    env["HOOK_LOG"] = str(log)
    result = subprocess.run(
        [str(hooks_path / hook_name), "sentinel"],
        cwd=repo,
        env=env,
        text=True,
        capture_output=True,
    )
    expect_success(result, f"{hook_name} sentinel")
    return log.read_text().splitlines()


def test_hook_installation() -> None:
    with tempfile.TemporaryDirectory(prefix="agnix-install-test-") as temporary:
        repo = Path(temporary)
        git(repo, "init", "--quiet")
        scripts = repo / "scripts"
        tracked_hooks = repo / ".githooks"
        scripts.mkdir()
        tracked_hooks.mkdir()
        shutil.copy2(INSTALLER, scripts / "install-agnix-hooks.sh")
        shutil.copy2(CHECKER, scripts / "check-agnix-staged.sh")
        shutil.copy2(TRACKED_WRAPPER, tracked_hooks / "pre-commit")
        (scripts / "install-agnix-hooks.sh").chmod(0o755)
        (scripts / "check-agnix-staged.sh").chmod(0o755)
        (tracked_hooks / "pre-commit").chmod(0o755)

        first_hooks = repo / "first-hooks"
        first_hooks.mkdir()
        for hook_name in ("commit-msg", "pre-commit", "pre-push"):
            write_hook(first_hooks / hook_name, f"first-{hook_name}")
        git(repo, "config", "core.hooksPath", str(first_hooks))
        run_installer(repo)

        generated = Path(git(repo, "config", "--path", "--get", "core.hooksPath"))
        if not (generated / "pre-commit").is_symlink():
            raise AssertionError("generated pre-commit is not a symlink")
        for hook_name in ("commit-msg", "pre-push"):
            hook = generated / hook_name
            if not hook.is_symlink() or hook.resolve() != first_hooks / hook_name:
                raise AssertionError(f"{hook_name} was not preserved")
        if run_hook(repo, "commit-msg") != ["first-commit-msg:sentinel"]:
            raise AssertionError("first commit-msg hook did not survive installation")
        if run_hook(repo, "pre-push") != ["first-pre-push:sentinel"]:
            raise AssertionError("first pre-push hook did not survive installation")
        if run_hook(repo, "pre-commit") != ["first-pre-commit:sentinel"]:
            raise AssertionError("first pre-commit chain did not survive installation")

        second_hooks = repo / "second-hooks"
        second_hooks.mkdir()
        for hook_name in ("commit-msg", "pre-commit", "pre-push"):
            write_hook(second_hooks / hook_name, f"second-{hook_name}")
        git(repo, "config", "--worktree", "core.hooksPath", str(second_hooks))
        run_installer(repo)
        previous = git(repo, "config", "--get", "agnix.previousHooksPath")
        if previous != str(second_hooks):
            raise AssertionError(
                f"reinstallation did not record the new hook path: {previous!r}"
            )
        generated = Path(git(repo, "config", "--path", "--get", "core.hooksPath"))
        for hook_name in ("commit-msg", "pre-push"):
            hook = generated / hook_name
            if not hook.is_symlink() or hook.resolve() != second_hooks / hook_name:
                raise AssertionError(f"{hook_name} was not refreshed on reinstall")
        if run_hook(repo, "commit-msg") != ["second-commit-msg:sentinel"]:
            raise AssertionError("reinstalled commit-msg hook did not run")
        if run_hook(repo, "pre-push") != ["second-pre-push:sentinel"]:
            raise AssertionError("reinstalled pre-push hook did not run")
        if run_hook(repo, "pre-commit") != ["second-pre-commit:sentinel"]:
            raise AssertionError("reinstalled pre-commit chain did not run")

        git(repo, "config", "--worktree", "--unset", "core.hooksPath")
        git(repo, "config", "--unset", "core.hooksPath")
        common_git_dir = Path(git(repo, "rev-parse", "--git-common-dir"))
        if not common_git_dir.is_absolute():
            common_git_dir = repo / common_git_dir
        common_hooks = common_git_dir / "hooks"
        common_hooks.mkdir(parents=True, exist_ok=True)
        for hook_name in ("commit-msg", "pre-commit", "pre-push"):
            write_hook(common_hooks / hook_name, f"common-{hook_name}")
        run_installer(repo)
        if git(repo, "config", "--get", "agnix.previousHooksPath") != str(
            common_hooks
        ):
            raise AssertionError("default common hook path was not recorded")
        if run_hook(repo, "commit-msg") != ["common-commit-msg:sentinel"]:
            raise AssertionError("common commit-msg hook did not survive installation")
        if run_hook(repo, "pre-push") != ["common-pre-push:sentinel"]:
            raise AssertionError("common pre-push hook did not survive installation")
        if run_hook(repo, "pre-commit") != ["common-pre-commit:sentinel"]:
            raise AssertionError("common pre-commit chain did not survive installation")


def main() -> None:
    if shutil.which("agnix") is None:
        raise RuntimeError("agnix must be installed before running this regression")
    test_hook_installation()

    valid_skill = (
        "---\n"
        "name: test-skill\n"
        "description: Valid skill used by the agnix hook regression test.\n"
        "---\n"
        "# Valid skill\n"
    )
    with tempfile.TemporaryDirectory(prefix="agnix-hook-test-") as temporary:
        repo = Path(temporary)
        hooks = repo / "hooks"
        hooks.mkdir()
        git(repo, "init", "--quiet")
        git(repo, "config", "core.hooksPath", str(hooks))
        git(repo, "config", "user.name", "agnix-hook-test")
        git(repo, "config", "user.email", "agnix-hook-test@example.invalid")
        (repo / ".agnix.toml").write_text('severity = "Warning"\n')
        (repo / "SKILL.md").write_text(valid_skill)
        git(repo, "add", ".")
        git(repo, "commit", "--quiet", "-m", "base")
        base = git(repo, "rev-parse", "HEAD")

        (repo / "SKILL.md").write_text(valid_skill.replace("# Valid", "# Updated"))
        git(repo, "add", "SKILL.md")
        expect_success(checker(repo), "valid staged input")
        git(repo, "commit", "--quiet", "-m", "valid feature")
        valid_head = git(repo, "rev-parse", "HEAD")
        expect_success(checker(repo, base=base), "valid CI input")

        broken_index = repo / "broken-index"
        broken_index.write_bytes(b"not a git index")
        expect_failure(
            checker(repo, overrides={"GIT_INDEX_FILE": str(broken_index)}),
            "unreadable staged diff",
        )

        (repo / "SKILL.md").write_text(valid_skill.replace("# Valid", "<tool_call>"))
        git(repo, "add", "SKILL.md")
        expect_failure(checker(repo), "malformed staged input")
        git(repo, "commit", "--quiet", "-m", "malformed feature")

        # The CI job's temporary index is HEAD, so only the explicit base makes
        # this committed malformed input part of the staged diff.
        expect_failure(checker(repo, base=valid_head), "malformed CI input")

    print("agnix staged-hook behavior tests passed")


if __name__ == "__main__":
    main()
