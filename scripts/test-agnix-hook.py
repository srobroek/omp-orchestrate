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


def checker(repo: Path, *, base: str | None = None) -> subprocess.CompletedProcess[str]:
    env = FIXTURE_ENV.copy()
    if base is None:
        env.pop("AGNIX_DIFF_BASE", None)
    else:
        env["AGNIX_DIFF_BASE"] = base
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


def main() -> None:
    if shutil.which("agnix") is None:
        raise RuntimeError("agnix must be installed before running this regression")

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
