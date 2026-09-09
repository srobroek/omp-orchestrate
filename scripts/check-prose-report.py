"""Apply the PR body's errors-only policy to a complete slopvac JSON report."""

import json
import math
import sys
from pathlib import Path


def main() -> None:
    try:
        report = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
        if not isinstance(report, dict):
            raise ValueError("report must be an object")
        documents = report.get("documents")
        if not isinstance(documents, list) or not documents:
            raise ValueError("report must contain checked documents")
        for document in documents:
            if not isinstance(document, dict) or document.get("unchecked") != []:
                raise ValueError("document has missing or unchecked rule coverage")
        summary = report.get("summary")
        if not isinstance(summary, dict):
            raise ValueError("report must contain a summary")
        for field in ("documents", "words", "findings", "errors", "warnings", "suggestions"):
            value = summary.get(field)
            if type(value) is not int or value < 0:
                raise ValueError(f"summary.{field} must be a nonnegative integer")
        if summary["documents"] != len(documents):
            raise ValueError("summary document count disagrees with checked documents")
        score = summary.get("score")
        if type(score) not in (int, float) or not math.isfinite(score) or not 0 <= score <= 100:
            raise ValueError("summary.score must be a finite number between 0 and 100")
    except (OSError, ValueError) as exc:
        sys.exit(f"prose report invalid: {exc}")

    errors = summary["errors"]
    warnings = summary["warnings"]
    print(f"slopvac score={score} errors={errors} warnings={warnings}")
    if errors:
        sys.exit(f"prose gate failed: {errors} error(s)")
    print("prose gate passed: no errors (warnings do not fail the job)")


if __name__ == "__main__":
    main()
