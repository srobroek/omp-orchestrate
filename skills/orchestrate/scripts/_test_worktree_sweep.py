from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SWEEP = HERE / "worktree-sweep.sh"


class WorktreeSweepTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name)
        self.bin_dir = self.root / "bin"
        self.bin_dir.mkdir()
        self.log = self.root / "wt.log"

        self.wt_bin = self.bin_dir / "fake-wt"
        self.wt_bin.write_text(
            """#!/usr/bin/env bash
set -eu
if [[ " $* " == *" list --format=json "* ]]; then
  if [[ "${WT_LIST_EXIT:-0}" != 0 ]]; then
    exit "${WT_LIST_EXIT}"
  fi
  printf '%s' "${WT_LIST_JSON:-[]}"
  exit 0
fi
if [[ " $* " == *" remove "* ]]; then
  printf '%s\\n' "$*" >> "$WT_LOG"
  exit 0
fi
exit 2
"""
        )
        self.wt_bin.chmod(0o755)

        self.git_bin = self.bin_dir / "fake-git"
        self.git_bin.write_text(
            """#!/usr/bin/env bash
set -eu
if [[ " $* " == *" status --porcelain "* ]]; then
  printf '%s' "${FAKE_GIT_STATUS:-}"
  exit "${FAKE_GIT_STATUS_EXIT:-0}"
fi
if [[ " $* " == *" rev-parse --is-inside-work-tree "* ]]; then
  exit "${FAKE_GIT_REV_PARSE_EXIT:-0}"
fi
if [[ " $* " == *" rev-parse --show-toplevel "* ]]; then
  printf '%s\\n' "${FAKE_GIT_TOPLEVEL:?}"
  exit 0
fi
exit 2
"""
        )
        self.git_bin.chmod(0o755)

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def run_sweep(
        self,
        target: Path,
        *,
        rows: object,
        extra_args: tuple[str, ...] = (),
        env: dict[str, str] | None = None,
    ) -> subprocess.CompletedProcess[str]:
        command_env = {
            **os.environ,
            "WT_BIN": str(self.wt_bin),
            "GIT_BIN": str(self.git_bin),
            "WT_LIST_JSON": json.dumps(rows),
            "WT_LOG": str(self.log),
            "FAKE_GIT_TOPLEVEL": str(self.root / "repo"),
            **(env or {}),
        }
        return subprocess.run(
            ["bash", str(SWEEP), *extra_args, str(target)],
            capture_output=True,
            text=True,
            env=command_env,
            check=False,
        )

    def test_registered_clean_worktree_uses_wt_remove(self) -> None:
        worktree = self.root / "registered"
        worktree.mkdir()
        result = self.run_sweep(
            worktree,
            rows=[{"path": str(worktree), "is_main": False}],
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("remove --foreground", self.log.read_text())
        self.assertNotIn("--force-delete", self.log.read_text())

    def test_disposable_role_branch_requests_branch_deletion(self) -> None:
        worktree = self.root / "review"
        worktree.mkdir()
        result = self.run_sweep(
            worktree,
            rows=[{"path": str(worktree), "is_main": False}],
            extra_args=("--discard-branch",),
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("--force-delete", self.log.read_text())

    def test_dirty_registered_worktree_is_refused(self) -> None:
        worktree = self.root / "dirty"
        worktree.mkdir()
        result = self.run_sweep(
            worktree,
            rows=[{"path": str(worktree), "is_main": False}],
            env={"FAKE_GIT_STATUS": " M source.rs\n"},
        )
        self.assertEqual(result.returncode, 1)
        self.assertFalse(self.log.exists())
        self.assertTrue(worktree.exists())

    def test_prune_quarantines_broken_harness_orphan(self) -> None:
        repo = self.root / "repo"
        repo.mkdir()
        harness_root = self.root / "harness"
        worktree = harness_root / "worktree-10374"
        worktree.mkdir(parents=True)
        (worktree / ".git").write_text("gitdir: /missing/worktrees/10374\n")
        quarantine = self.root / "quarantine"

        result = self.run_sweep(
            repo,
            rows=[],
            extra_args=("--prune",),
            env={
                "FAKE_GIT_REV_PARSE_EXIT": "1",
                "ORCHESTRATE_HARNESS_ROOT": str(harness_root),
                "ORCHESTRATE_ORPHAN_QUARANTINE": str(quarantine),
            },
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(worktree.exists())
        quarantined = list(quarantine.iterdir())
        self.assertEqual(len(quarantined), 1)
        self.assertTrue((quarantined[0] / ".git").is_file())

    def test_prune_skips_registered_path(self) -> None:
        repo = self.root / "repo"
        repo.mkdir()
        harness_root = self.root / "harness"
        registered = harness_root / "registered"
        orphan = harness_root / "orphan"
        registered.mkdir(parents=True)
        orphan.mkdir()
        (orphan / ".git").write_text("gitdir: /missing/worktrees/orphan\n")
        quarantine = self.root / "quarantine"

        result = self.run_sweep(
            repo,
            rows=[{"path": str(registered), "is_main": False}],
            extra_args=("--prune",),
            env={
                "FAKE_GIT_REV_PARSE_EXIT": "1",
                "ORCHESTRATE_HARNESS_ROOT": str(harness_root),
                "ORCHESTRATE_ORPHAN_QUARANTINE": str(quarantine),
            },
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(registered.exists())
        self.assertFalse(orphan.exists())
        self.assertEqual(len(list(quarantine.iterdir())), 1)

    def test_prune_refuses_valid_but_unregistered_path(self) -> None:
        repo = self.root / "repo"
        repo.mkdir()
        harness_root = self.root / "harness"
        candidate = harness_root / "valid"
        candidate.mkdir(parents=True)
        (candidate / ".git").write_text("gitdir: /still/valid\n")

        result = self.run_sweep(
            repo,
            rows=[],
            extra_args=("--prune",),
            env={
                "FAKE_GIT_REV_PARSE_EXIT": "0",
                "ORCHESTRATE_HARNESS_ROOT": str(harness_root),
            },
        )

        self.assertEqual(result.returncode, 1)
        self.assertIn("valid unregistered worktree", result.stderr)
        self.assertTrue(candidate.exists())

    def test_invalid_inventory_is_fatal(self) -> None:
        """A shape that is neither a schema-1 array nor a schema-2 envelope."""
        worktree = self.root / "registered"
        worktree.mkdir()
        result = self.run_sweep(worktree, rows={"schema": 2})
        self.assertEqual(result.returncode, 2)
        self.assertIn("invalid inventory", result.stderr)

    def test_empty_schema_two_envelope_is_valid_but_unregistered(self) -> None:
        """An envelope with no items is well-formed; the path is just unknown."""
        worktree = self.root / "registered"
        worktree.mkdir()
        result = self.run_sweep(worktree, rows={"schema": 2, "items": []})
        self.assertEqual(result.returncode, 2)
        self.assertIn("not registered with Worktrunk", result.stderr)

    def test_schema_two_envelope_resolves_a_linked_worktree(self) -> None:
        worktree = self.root / "registered"
        worktree.mkdir()
        result = self.run_sweep(
            worktree,
            rows={
                "schema": 2,
                "items": [{"worktree": {"path": str(worktree), "main": False}}],
            },
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_wt_list_failure_is_fatal(self) -> None:
        worktree = self.root / "registered"
        worktree.mkdir()
        result = self.run_sweep(
            worktree,
            rows=[],
            env={"WT_LIST_EXIT": "7"},
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("wt list failed", result.stderr)

    def test_primary_worktree_is_refused(self) -> None:
        worktree = self.root / "primary"
        worktree.mkdir()
        result = self.run_sweep(
            worktree,
            rows=[{"path": str(worktree), "is_main": True}],
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("primary worktree", result.stderr)


if __name__ == "__main__":
    unittest.main()
