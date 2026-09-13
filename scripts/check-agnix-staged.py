#!/usr/bin/env python3
"""Validate only agentic files present in the staged Git index."""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path, PurePosixPath
from typing import NoReturn, Sequence

EXPECTED_VERSION = "agnix 0.52.2"


class CheckerError(Exception):
    """An expected pre-commit failure with a user-facing message."""


def fail(message: str) -> NoReturn:
    raise CheckerError(message)


def git_command(
    args: Sequence[str],
    *,
    cwd: Path,
    env: dict[str, str],
    capture: bool = True,
    check: bool = False,
) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        ["git", *args],
        cwd=cwd,
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
        check=check,
    )


def is_ignored_path(path: str) -> bool:
    return any(
        part in f"/{path}/"
        for part in (
            "/.git/",
            "/node_modules/",
            "/dist/",
            "/target/",
            "/.apm/",
            "/.agents/",
            "/.dogfood-cleanroom/",
            "/evals/",
            "/tests/fixtures/",
        )
    )


def is_agentic_path(path: str) -> bool:
    prefix = os.environ.get("AGNIX_SOURCE_PREFIX", "")
    if prefix and path != ".agnix.toml" and not path.startswith(prefix):
        return False
    if path in {
        ".agnix.toml",
        "AGENTS.md",
        "CLAUDE.md",
        "SKILL.md",
        ".claude-plugin/plugin.json",
        ".codex-plugin/plugin.json",
        ".mcp.json",
    }:
        return True
    if path.endswith("/AGENTS.md") or path.endswith("/CLAUDE.md") or path.endswith("/SKILL.md"):
        return True
    if path.startswith("agents/") or "/agents/" in path:
        return path.endswith(".md")
    if path.startswith("rules/") or "/rules/" in path:
        return path.endswith(".md")
    if path.startswith("skills/") or "/skills/" in path:
        return "/references/" in path or "/templates/" in path
    if path.startswith(".claude/") or "/.claude/" in path:
        return path.endswith(".json")
    if path.startswith(".codex/") or "/.codex/" in path:
        return path.endswith(".toml") or path.endswith(".json")
    return path.endswith(".mcp.json")


def parse_nul_paths(data: bytes) -> list[str]:
    return [os.fsdecode(item) for item in data.split(b"\0") if item]


def staged_inputs(root: Path, env: dict[str, str]) -> tuple[list[str], bool]:
    args = ["diff", "--cached", "--name-status", "-z", "--no-renames", "--diff-filter=ACMDT"]
    base = os.environ.get("AGNIX_DIFF_BASE", "")
    if base:
        resolved = git_command(["rev-parse", "--verify", f"{base}^{{commit}}"], cwd=root, env=env)
        if resolved.returncode:
            fail(f"AGNIX_DIFF_BASE does not name a commit: {base}")
        args.append(resolved.stdout.decode().strip())
    args.append("--")
    result = git_command(args, cwd=root, env=env)
    if result.returncode:
        fail("unable to read the staged diff; refusing to skip agnix validation.")
    fields = result.stdout.split(b"\0")
    staged: list[str] = []
    config_changed = False
    for index in range(0, len(fields) - 1, 2):
        status = fields[index].decode("ascii")
        path = os.fsdecode(fields[index + 1])
        if status == "D":
            # A deleted dependency can invalidate a surviving agentic file.
            config_changed = True
            continue
        if is_ignored_path(path) or not is_agentic_path(path):
            continue
        if path == ".agnix.toml":
            config_changed = True
            continue
        staged.append(path)
    if not config_changed:
        return staged, False

    listed = git_command(["ls-files", "-z", "--cached", "--"], cwd=root, env=env)
    if listed.returncode:
        fail("unable to read staged paths; refusing to skip agnix validation.")
    staged = [
        path
        for path in parse_nul_paths(listed.stdout)
        if not is_ignored_path(path) and is_agentic_path(path)
    ]
    if not staged:
        staged = [".agnix.toml"]
    return staged, True


def materialize_index(root: Path, destination: Path, env: dict[str, str]) -> None:
    index = git_command(["ls-files", "--stage", "-z"], cwd=root, env=env)
    if index.returncode:
        fail("unable to read the staged index; refusing to skip agnix validation.")
    links: list[tuple[Path, str]] = []
    batch_env = dict(env, GIT_NO_LAZY_FETCH="1", GIT_NO_REPLACE_OBJECTS="1")
    try:
        process = subprocess.Popen(
            ["git", "cat-file", "--batch"],
            cwd=root,
            env=batch_env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except OSError as error:
        fail(f"unable to start git cat-file: {error}")
    assert process.stdin is not None and process.stdout is not None
    try:
        for entry in index.stdout.split(b"\0"):
            if not entry:
                continue
            try:
                metadata, raw_path = entry.split(b"\t", 1)
                mode, oid, stage = metadata.split()
            except ValueError:
                fail("invalid staged index entry")
            relative = PurePosixPath(os.fsdecode(raw_path))
            if stage != b"0" or relative.is_absolute() or ".." in relative.parts:
                fail(f"invalid staged entry: {str(relative)!r}")
            path = destination.joinpath(*relative.parts)
            if mode == b"160000":
                path.mkdir(parents=True, exist_ok=True)
                continue
            if mode not in (b"100644", b"100755", b"120000"):
                fail(f"unsupported staged mode: {str(relative)!r}")
            try:
                process.stdin.write(oid + b"\n")
                process.stdin.flush()
                header = process.stdout.readline().split()
            except (BrokenPipeError, OSError) as error:
                fail(f"git cat-file failed: {error}")
            if len(header) != 3 or header[1] != b"blob":
                fail(f"staged blob unavailable locally: {str(relative)!r}")
            try:
                remaining = int(header[2])
            except ValueError:
                fail("invalid git cat-file response")
            path.parent.mkdir(parents=True, exist_ok=True)
            if mode == b"120000":
                if remaining > 4096:
                    fail(f"staged symlink target is too long: {str(relative)!r}")
                target = process.stdout.read(remaining)
                if len(target) != remaining:
                    fail(f"incomplete staged blob: {str(relative)!r}")
                links.append((path, os.fsdecode(target)))
            else:
                with path.open("wb") as output:
                    while remaining:
                        chunk = process.stdout.read(min(remaining, 65536))
                        if not chunk:
                            fail(f"incomplete staged blob: {str(relative)!r}")
                        output.write(chunk)
                        remaining -= len(chunk)
                path.chmod(0o755 if mode == b"100755" else 0o644)
            if process.stdout.read(1) != b"\n":
                fail("invalid git cat-file response")
        process.stdin.close()
        if process.wait() != 0:
            fail("git cat-file failed")
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
    for path, target in links:
        path.symlink_to(target)
    for path, _ in links:
        try:
            target = path.resolve(strict=True)
        except (OSError, RuntimeError):
            fail(f"unresolvable staged symlink: {str(path.relative_to(destination))!r}")
        if not target.is_relative_to(destination):
            fail(f"staged symlink escapes the index snapshot: {str(path.relative_to(destination))!r}")


def agnix_command() -> list[str]:
    os.environ["MISE_AUTO_INSTALL"] = "false"
    use_mise = os.environ.get("AGNIX_USE_MISE", "0") == "1"
    if use_mise:
        if shutil.which("mise") is None:
            fail("mise is required for the pinned agnix pre-commit check.")
        command = ["mise", "exec", "--no-deps", "--", "agnix"]
    else:
        if shutil.which("agnix") is None:
            fail("agnix is required for the pre-commit agentic check.\nInstall the expected tool before committing: cargo install agnix-cli --version 0.52.2")
        command = ["agnix"]
    version = subprocess.run(command + ["--version"], text=True, capture_output=True, check=False)
    if version.returncode:
        fail(f"agnix is unavailable; prepare the toolchain before committing.\n{version.stdout}{version.stderr}")
    reported = (version.stdout + version.stderr).strip()
    if reported != EXPECTED_VERSION:
        print(
            f"warning: this config was reviewed against {EXPECTED_VERSION}; found {reported or 'an unknown version'}",
            file=sys.stderr,
        )
    if use_mise:
        resolved = subprocess.run(["mise", "which", "agnix"], text=True, capture_output=True, check=False)
        binary = resolved.stdout.strip()
        if resolved.returncode or not os.path.isabs(binary) or not os.access(binary, os.X_OK):
            fail("mise did not resolve an executable agnix binary.")
        command = [binary]
    return command


def main() -> int:
    try:
        root_result = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            text=True,
            capture_output=True,
            check=False,
        )
        if root_result.returncode:
            print(root_result.stderr, file=sys.stderr, end="")
            return root_result.returncode
        root = Path(root_result.stdout.strip()).resolve()
        os.chdir(root)
        if shutil.which("python3") is None:
            fail("python3 is required to build the staged snapshot.")
        env = dict(os.environ, GIT_NO_LAZY_FETCH="1", GIT_NO_REPLACE_OBJECTS="1")
        paths, _ = staged_inputs(root, env)
        if not paths:
            return 0
        command = agnix_command()
        with tempfile.TemporaryDirectory(prefix="agnix-staged.", dir=os.environ.get("TMPDIR")) as temporary:
            staged_root = Path(temporary)
            materialize_index(root, staged_root, env)
            config = staged_root / ".agnix.toml"
            if not config.is_file():
                fail("agnix pre-commit check requires a staged .agnix.toml; stage that config first.")
            for path in paths:
                staged_path = staged_root / path
                if not staged_path.exists() and not staged_path.is_symlink():
                    fail(f"staged path disappeared from the index snapshot: {path}")
            result = subprocess.run(
                command + ["--config", ".agnix.toml", "--format", "text", "--", *paths],
                cwd=staged_root,
                check=False,
            )
            return result.returncode
    except CheckerError as error:
        print(str(error), file=sys.stderr)
        return 1
    except OSError as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
