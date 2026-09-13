#!/usr/bin/env python3
"""Exercise the staged agnix gate and its worktree hook installation."""
from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHECKER = ROOT / "scripts" / "check-agnix-staged.py"
INSTALLER = ROOT / "scripts" / "install-agnix-hooks.py"
CONFIG = ROOT / ".agnix.toml"
TRACKED_PRE_COMMIT = ROOT / ".githooks" / "pre-commit"
VALID_SKILL = """---
name: fixture
description: Validate the fixture skill
---

# Fixture

Use the tool.
"""
CHANGED_VALID_SKILL = VALID_SKILL.replace(
    "Validate the fixture skill", "Validate the changed fixture skill"
)
MALFORMED_SKILL = """---
name: fixture
---

# Fixture

Use the tool.
"""


def run(command: list[str], cwd: Path, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, cwd=cwd, env=env, text=True, capture_output=True, check=False)


def git(*args: str, cwd: Path, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    result = run(["git", *args], cwd, env)
    if result.returncode:
        raise RuntimeError(f"git {' '.join(args)} failed:\n{result.stdout}{result.stderr}")
    return result


def expect_status(
    label: str,
    result: subprocess.CompletedProcess[str],
    expected: int,
) -> None:
    if result.returncode == expected:
        return
    output = (result.stdout + result.stderr).strip()
    raise RuntimeError(
        f"{label}: expected exit {expected}, got {result.returncode}\n{output}"
    )


def write_hook(path: Path, label: str) -> None:
    path.write_text(
        "#!/usr/bin/env bash\n"
        "set -eu\n"
        f"printf '%s\\n' '{label}' >> \"$HOOK_LOG\"\n"
    )
    path.chmod(0o755)


def config_value(name: str, cwd: Path, env: dict[str, str]) -> str:
    return git("config", "--worktree", "--get", name, cwd=cwd, env=env).stdout.rstrip("\n")


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="agnix-hook-test-") as temporary:
        worktree = Path(temporary)
        env = os.environ.copy()
        for name in ("AGNIX_DIFF_BASE", "AGNIX_SOURCE_PREFIX", "AGNIX_USE_MISE", "GIT_INDEX_FILE"):
            env.pop(name, None)
        env.update(
            {
                "GIT_CONFIG_GLOBAL": "/dev/null",
                "GIT_CONFIG_NOSYSTEM": "1",
                "MISE_AUTO_INSTALL": "false",
            }
        )

        git("init", "--quiet", cwd=worktree, env=env)
        git("config", "user.email", "agnix-hook-test@example.invalid", cwd=worktree, env=env)
        git("config", "user.name", "agnix-hook-test", cwd=worktree, env=env)
        hooks = (worktree / ".git" / "hooks").resolve()
        hooks.mkdir(exist_ok=True)
        hook_log = worktree / "hook log\n.txt"
        hook_env = dict(env, HOOK_LOG=str(hook_log))
        write_hook(hooks / "pre-commit", "old-pre-commit")
        write_hook(hooks / "commit-msg", "old-commit-msg")
        write_hook(hooks / "pre-push", "old-pre-push")

        (worktree / ".agnix.toml").write_text(CONFIG.read_text())
        skill = worktree / "SKILL.md"
        skill.write_text(VALID_SKILL)
        for source in (CHECKER, INSTALLER, TRACKED_PRE_COMMIT):
            destination = worktree / source.relative_to(ROOT)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
        git(
            "add",
            ".agnix.toml",
            "SKILL.md",
            ".githooks/pre-commit",
            "scripts/check-agnix-staged.py",
            "scripts/install-agnix-hooks.py",
            cwd=worktree,
            env=env,
        )
        git("commit", "--quiet", "--no-verify", "-m", "base", cwd=worktree, env=env)
        base = git("rev-parse", "HEAD", cwd=worktree, env=env).stdout.strip()

        skill.write_text(CHANGED_VALID_SKILL)
        git("add", "SKILL.md", cwd=worktree, env=env)
        expect_status("valid staged input", run([str(CHECKER)], worktree, env), 0)
        git("commit", "--quiet", "--no-verify", "-m", "valid-change", cwd=worktree, env=env)

        newline_skill = worktree / "skills" / "line\nbreak" / "references" / "reference.md"
        newline_skill.parent.mkdir(parents=True, exist_ok=True)
        newline_skill.write_text("Use the tool.\n")
        git("add", "--", "skills/line\nbreak/references/reference.md", cwd=worktree, env=env)
        expect_status("newline path staged input", run([str(CHECKER)], worktree, env), 0)
        git("commit", "--quiet", "--no-verify", "-m", "newline-path", cwd=worktree, env=env)
        git("reset", "--quiet", "--hard", base, cwd=worktree, env=env)

        skill.write_text(MALFORMED_SKILL)
        git("add", "SKILL.md", cwd=worktree, env=env)
        expect_status("malformed staged input", run([str(CHECKER)], worktree, env), 1)
        git("commit", "--quiet", "--no-verify", "-m", "malformed-change", cwd=worktree, env=env)

        ci_index = worktree / "ci-index"
        ci_env = dict(env, GIT_INDEX_FILE=str(ci_index), AGNIX_DIFF_BASE=base)
        git("read-tree", "HEAD", cwd=worktree, env=ci_env)
        expect_status("malformed CI baseline", run([str(CHECKER)], worktree, ci_env), 1)

        skill.write_text(CHANGED_VALID_SKILL)
        git("add", "SKILL.md", cwd=worktree, env=env)
        expect_status("valid repaired staged input", run([str(CHECKER)], worktree, env), 0)
        git("commit", "--quiet", "--no-verify", "-m", "valid-repair", cwd=worktree, env=env)

        installer = worktree / "scripts/install-agnix-hooks.py"
        expect_status("initial hook installation", run([str(installer)], worktree, hook_env), 0)
        managed_hooks = Path(config_value("agnix.hooksPath", worktree, env))
        if config_value("core.hooksPath", worktree, env) != str(managed_hooks):
            raise RuntimeError("installer did not select its private hook directory")
        if config_value("agnix.previousHooksPath", worktree, env) != str(hooks):
            raise RuntimeError("installer did not record the original hook directory")
        for name in ("commit-msg", "pre-push"):
            target = managed_hooks / name
            if not target.is_symlink() or Path(os.readlink(target)) != hooks / name:
                raise RuntimeError(f"installer did not preserve {name}")

        collision_payloads = {
            "pre-commit": "operator-owned pre-commit\n",
            "commit-msg": "operator-owned commit-msg\n",
        }
        for name, payload in collision_payloads.items():
            target = managed_hooks / name
            target.unlink()
            target.write_text(payload)
            collision = run([str(installer)], worktree, hook_env)
            expect_status(f"{name} collision", collision, 1)
            if target.read_text() != payload:
                raise RuntimeError(f"installer changed the {name} collision")
            if f"cannot install agnix hook {name}" not in collision.stderr:
                raise RuntimeError(f"installer did not explain the {name} collision")
            target.unlink()
            replacement = worktree / ".githooks" / "pre-commit" if name == "pre-commit" else hooks / name
            target.symlink_to(replacement)

        git("commit", "--quiet", "--allow-empty", "-m", "hook-chain", cwd=worktree, env=hook_env)
        expect_status("preserved pre-push hook", run([str(managed_hooks / "pre-push")], worktree, hook_env), 0)
        log_lines = hook_log.read_text().splitlines()
        for label in ("old-pre-commit", "old-commit-msg", "old-pre-push"):
            if label not in log_lines:
                raise RuntimeError(f"original {label} hook did not run")

        expect_status("idempotent hook installation", run([str(installer)], worktree, hook_env), 0)
        if config_value("agnix.previousHooksPath", worktree, env) != str(hooks):
            raise RuntimeError("reinstall replaced the original hook directory")

        new_hooks = worktree / "new hooks\nscanner"
        new_hooks.mkdir()
        write_hook(new_hooks / "pre-commit", "new-pre-commit")
        write_hook(new_hooks / "commit-msg", "new-commit-msg")
        write_hook(new_hooks / "pre-push", "new-pre-push")
        git("config", "--worktree", "core.hooksPath", str(new_hooks), cwd=worktree, env=env)
        expect_status("selected scanner installation", run([str(installer)], worktree, hook_env), 0)
        if config_value("agnix.previousHooksPath", worktree, env) != str(new_hooks):
            raise RuntimeError("installer did not capture the newly selected scanner")
        for name in ("commit-msg", "pre-push"):
            target = managed_hooks / name
            if not target.is_symlink() or Path(os.readlink(target)) != new_hooks / name:
                raise RuntimeError(f"installer did not update {name} for the new scanner")

        git("commit", "--quiet", "--allow-empty", "-m", "new-hook-chain", cwd=worktree, env=hook_env)
        expect_status("new pre-push hook", run([str(managed_hooks / "pre-push")], worktree, hook_env), 0)
        log_lines = hook_log.read_text().splitlines()
        for label in ("new-pre-commit", "new-commit-msg", "new-pre-push"):
            if label not in log_lines:
                raise RuntimeError(f"new {label} hook did not run")

    print("agnix staged, CI baseline, newline paths, and all-hook installation checks passed")


if __name__ == "__main__":
    main()
