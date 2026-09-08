"""Run pinned slopvac with its supplementary Unicode range preserved for Vale."""

from importlib.metadata import version

from slopvac import rules
from slopvac.model import Category


_build_category = rules._build_category


def build_category(data: dict, origin: str) -> Category:
    category = _build_category(data, origin)
    for rule in category.rules:
        if rule.pattern:
            # slopvac 1.0.1 forwards Python's \U escapes verbatim to Vale.
            # Use the same literal codepoints, before example checks and cache hashing.
            # https://github.com/srobroek/slopvac/blob/9b0696fd8ca1693f5a6dacb345ccbbb4fc3d3aab/packages/slopvac-lint/src/slopvac/compile_vale.py#L565
            rule.pattern = rule.pattern.replace(
                r"\U0001F300-\U0001FAFF", "\U0001F300-\U0001FAFF"
            )
    return category


if __name__ == "__main__":
    if version("slopvac") != "1.0.1":
        raise SystemExit("prose-gate requires slopvac==1.0.1; review the adapter before upgrading")
    rules._build_category = build_category
    from slopvac.cli import main

    main()
