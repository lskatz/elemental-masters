#!/usr/bin/env python3
"""
check_size.py — Performance budget enforcer.

Walks the project's static assets (after `build.py` has run) and asserts
that no individual file exceeds its category limit and that the total
transferred bytes stay under a global ceiling.

Categories and limits roughly mirror Lighthouse's "good" thresholds for a
small site, scaled down for this project. Adjust the numbers below as the
project grows. The point isn't to hit an exact target — it's to make
"oh, I added a 500KB image without thinking" impossible to merge silently.

Usage:
    python3 scripts/check_size.py
    python3 scripts/check_size.py --site _site/   # check Jekyll output

Exits non-zero if any limit is exceeded; CI catches the failure.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent

# Per-file category limits (bytes). Tighten or loosen based on what the
# project actually ships. Numbers chosen to leave headroom but flag
# unusual additions.
CATEGORY_LIMITS = {
    "css": 30_000,    # one stylesheet, minified by Jekyll
    "js":  40_000,    # any single .js file
    "svg":  5_000,    # individual SVG icon
    "png": 50_000,    # PWA icons
    "html": 30_000,   # any single HTML page
}

# Total transferred bytes for the whole site. Includes everything Jekyll
# would publish. Generous because Google Fonts are external; this only
# counts what *we* serve.
TOTAL_LIMIT = 250_000

# Files matching these patterns are excluded from the budget — typically
# inputs (vs. compiled outputs) and dev-only files Jekyll won't publish.
EXCLUDE_PATTERNS = [
    ".scss",            # source; the compiled .css is what ships
    "/_site/",
    "/__pycache__/",
    "/.pytest_cache/",
    "/_drafts/",
    "/Gemfile",
    "/.bundle/",
    "/tests/",          # unit tests aren't shipped
    "/scripts/",        # build scripts aren't shipped
    "/.github/",        # workflow files aren't shipped
    "/_layouts/",       # processed by Jekyll, not served as-is
    "/_data/",          # not served
    "/_includes/",
]


def categorize(path: Path) -> str | None:
    """Return the category name for `path`, or None if not budgeted."""
    suffix = path.suffix.lstrip(".").lower()
    if suffix in CATEGORY_LIMITS:
        return suffix
    return None


def is_excluded(path: Path) -> bool:
    s = str(path)
    return any(p in s for p in EXCLUDE_PATTERNS)


def check_directory(root: Path) -> int:
    """Walk `root`, enforce limits, return exit code (0 = pass)."""
    failures: list[str] = []
    total = 0
    counted = 0

    for path in sorted(root.rglob("*")):
        if not path.is_file() or is_excluded(path):
            continue
        category = categorize(path)
        if category is None:
            continue
        size = path.stat().st_size
        total += size
        counted += 1
        limit = CATEGORY_LIMITS[category]
        rel = path.relative_to(root)
        bar = "█" * min(int(size / limit * 20), 20)
        status = "OK" if size <= limit else "FAIL"
        print(f"  {status:4s} {rel}  ({size:,} / {limit:,} B)  {bar}")
        if size > limit:
            failures.append(
                f"{rel}: {size:,} B exceeds {category} limit of {limit:,} B"
            )

    print()
    print(f"  Total budgeted bytes: {total:,} / {TOTAL_LIMIT:,} "
          f"({counted} files)")
    if total > TOTAL_LIMIT:
        failures.append(
            f"total {total:,} B exceeds budget {TOTAL_LIMIT:,} B"
        )

    if failures:
        print("\nPerformance budget violations:", file=sys.stderr)
        for f in failures:
            print(f"  - {f}", file=sys.stderr)
        return 1

    print("\n✓ All within budget.")
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--site",
        type=Path,
        default=None,
        help="Path to Jekyll _site/ output. If omitted, checks the source tree.",
    )
    args = parser.parse_args()

    root = args.site or PROJECT_ROOT
    if not root.exists():
        print(f"Path does not exist: {root}", file=sys.stderr)
        sys.exit(2)

    print(f"Checking {root}/ against performance budget...\n")
    sys.exit(check_directory(root))


if __name__ == "__main__":
    main()
