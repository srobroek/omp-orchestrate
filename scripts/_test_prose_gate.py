from __future__ import annotations

import json
import string
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
GATE = HERE / "prose-gate.py"


class ProseGateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.root = Path(self.tempdir.name)

    def run_gate(self, text: str) -> tuple[int, list[dict]]:
        path = self.root / "prose.md"
        path.write_text(text, encoding="utf-8")
        result = subprocess.run(
            [sys.executable, str(GATE), str(path), "--profile", "normal", "--format", "json"],
            cwd=self.root,
            text=True,
            capture_output=True,
            timeout=120,
            check=False,
        )
        self.assertIn(result.returncode, (0, 1), (result.stdout, result.stderr))
        report = json.loads(result.stdout)
        self.assertTrue(report["documents"], report)
        for document in report["documents"]:
            self.assertEqual(document["unchecked"], [], document)
        findings = [
            finding
            for document in report["documents"]
            for finding in document["findings"]
        ]
        return result.returncode, findings

    def test_ascii_headings_are_not_emoji(self) -> None:
        headings = "\n\n".join(
            "## " + char + " heading" for char in string.ascii_letters + string.digits
        )
        _, findings = self.run_gate("# Reference\n\n" + headings + "\n")
        self.assertFalse(
            any(f["rule_id"] == "prose-format.emoji-heading" for f in findings),
            findings,
        )

    def test_emoji_heading_ranges_remain_enforced(self) -> None:
        for point in (0x1F300, 0x1F680, 0x1FAFF, 0x2600, 0x2B50):
            with self.subTest(codepoint=f"U+{point:04X}"):
                status, findings = self.run_gate(
                    "# Reference\n\n## " + chr(point) + " Install\n"
                )
                self.assertEqual(status, 1, findings)
                self.assertTrue(
                    any(
                        f["rule_id"] == "prose-format.emoji-heading"
                        and f["severity"] == "error"
                        and chr(point) in f["matched_text"]
                        for f in findings
                    ),
                    findings,
                )

    def test_emoji_list_marker_remains_detected(self) -> None:
        _, findings = self.run_gate("# Reference\n\n- " + chr(0x1F680) + " Install\n")
        self.assertTrue(
            any(
                "emoji" in f["rule_id"] and chr(0x1F680) in f["matched_text"]
                for f in findings
            ),
            findings,
        )


class ProseReportPolicyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.path = Path(self.tempdir.name) / "report.json"
        self.report = {
            "documents": [{"unchecked": []}],
            "summary": {
                "documents": 1,
                "words": 100,
                "findings": 0,
                "errors": 0,
                "warnings": 0,
                "suggestions": 0,
                "score": 100,
            },
        }

    def run_policy(self) -> subprocess.CompletedProcess[str]:
        self.path.write_text(json.dumps(self.report), encoding="utf-8")
        return subprocess.run(
            [sys.executable, str(HERE / "check-prose-report.py"), str(self.path)],
            text=True,
            capture_output=True,
            timeout=10,
            check=False,
        )

    def test_complete_warning_only_report_passes_despite_low_score(self) -> None:
        self.report["summary"].update(warnings=20, findings=20, score=0)
        result = self.run_policy()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_prose_errors_fail(self) -> None:
        self.report["summary"].update(errors=1, findings=1)
        result = self.run_policy()
        self.assertNotEqual(result.returncode, 0, result.stdout)

    def test_missing_or_empty_documents_fail(self) -> None:
        del self.report["documents"]
        self.assertNotEqual(self.run_policy().returncode, 0)
        self.report["documents"] = []
        self.assertNotEqual(self.run_policy().returncode, 0)

    def test_incomplete_rule_coverage_fails(self) -> None:
        for document in ({}, {"unchecked": ["prose-format.emoji-heading"]}):
            with self.subTest(document=document):
                self.report["documents"] = [document]
                self.assertNotEqual(self.run_policy().returncode, 0)

    def test_invalid_summary_counts_fail(self) -> None:
        summary = self.report["summary"]
        for field, invalid in (
            ("errors", False),
            ("errors", "0"),
            ("words", -1),
            ("documents", 1.0),
            ("findings", None),
            ("warnings", []),
            ("suggestions", {}),
        ):
            with self.subTest(field=field, invalid=invalid):
                original = summary[field]
                summary[field] = invalid
                self.assertNotEqual(self.run_policy().returncode, 0)
                summary[field] = original

    def test_inconsistent_document_count_fails(self) -> None:
        self.report["summary"]["documents"] = 0
        self.assertNotEqual(self.run_policy().returncode, 0)

    def test_nonfinite_score_fails(self) -> None:
        self.report["summary"]["score"] = float("nan")
        self.assertNotEqual(self.run_policy().returncode, 0)


if __name__ == "__main__":
    unittest.main()
