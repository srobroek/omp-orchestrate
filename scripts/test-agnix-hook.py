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


def git(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=repo,
        check=True,
        text=True,
        capture_output=True,
    )
    return result.stdout.strip()


def checker(repo: Path, *, base: str | None = None) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
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


def expect_failure(result: subprocess.CompletedProcess[str], case: str) -> None:
    if result.returncode == 0:
        output = (result.stdout + result.stderr).strip()
        raise AssertionError(f"{case} unexpectedly passed; output={output!r}")


def main() -> None:
    if shutil.which("agnix") is None:
        raise RuntimeError("agnix must be installed before running this regression")

    with tempfile.TemporaryDirectory(prefix="agnix-hook-test-") as temporary:
        repo = Path(temporary)
        git(repo, "init", "--quiet")
        git(repo, "config", "user.name", "agnix-hook-test")
        git(repo, "config", "user.email", "agnix-hook-test@example.invalid")
        (repo / ".agnix.toml").write_text('severity = "Warning"\n')
        (repo / "SKILL.md").write_text("# Valid skill\n")
        git(repo, "add", ".")
        git(repo, "commit", "--quiet", "-m", "base")
        base = git(repo, "rev-parse", "HEAD")

        (repo / "SKILL.md").write_text("# Invalid skill\n\n<tool_call>\n")
        git(repo, "add", "SKILL.md")
        expect_failure(checker(repo), "malformed staged input")
        git(repo, "commit", "--quiet", "-m", "malformed feature")

        # The CI job's temporary index is HEAD, so only the explicit base makes
        # this committed malformed input part of the staged diff.
        expect_failure(checker(repo, base=base), "malformed CI input")

    print("agnix staged-hook behavior tests passed")


if __name__ == "__main__":
    main()
