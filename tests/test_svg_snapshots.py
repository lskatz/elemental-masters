"""
Snapshot regression tests for generated SVGs.

Each element's SVG is rendered to a fixed-size PNG, hashed (SHA-256), and
compared against a baseline hash stored in `tests/snapshots/baseline.json`.
A change to the SVG output flips the hash, failing the test — preventing
visual regressions from sneaking through code review on logic-only PR
diffs.

Updating baselines (after an intentional design change):

    python -m pytest tests/test_svg_snapshots.py --update-snapshots

This script can also be invoked directly:

    python tests/test_svg_snapshots.py --update

Skipped automatically if cairosvg or Pillow aren't installed (e.g., dev
environment without system Cairo libs). CI runs in an environment that
has them.
"""
from __future__ import annotations

import hashlib
import io
import json
import sys
from pathlib import Path

import pytest
import yaml

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "scripts"))

import build  # noqa: E402

SNAPSHOT_FILE = PROJECT_ROOT / "tests" / "snapshots" / "baseline.json"
RENDER_SIZE = 128  # px — bigger than the 64px viewBox to catch sub-pixel changes


def _try_import_renderer():
    """Return (cairosvg, Image) or (None, None) if either is missing."""
    try:
        import cairosvg  # type: ignore
        from PIL import Image  # type: ignore
        return cairosvg, Image
    except ImportError:
        return None, None


def _render_hash(svg_text: str) -> str:
    """Render SVG to PNG and return the SHA-256 of the pixel buffer."""
    cairosvg, Image = _try_import_renderer()
    assert cairosvg and Image  # callers should pre-check
    png_bytes = cairosvg.svg2png(
        bytestring=svg_text.encode("utf-8"),
        output_width=RENDER_SIZE,
        output_height=RENDER_SIZE,
    )
    img = Image.open(io.BytesIO(png_bytes)).convert("RGBA")
    # Hash raw pixel data so trivial PNG metadata diffs (timestamp, etc.)
    # don't cause spurious failures.
    return hashlib.sha256(img.tobytes()).hexdigest()


def _load_baseline() -> dict[str, str]:
    if not SNAPSHOT_FILE.exists():
        return {}
    return json.loads(SNAPSHOT_FILE.read_text(encoding="utf-8"))


def _save_baseline(data: dict[str, str]) -> None:
    SNAPSHOT_FILE.parent.mkdir(parents=True, exist_ok=True)
    SNAPSHOT_FILE.write_text(
        json.dumps(data, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def _all_element_hashes() -> dict[str, str]:
    data = yaml.safe_load(
        (PROJECT_ROOT / "_data" / "elements.yml").read_text(encoding="utf-8")
    )
    return {el["key"]: _render_hash(build.svg_for(el)) for el in data["elements"]}


# ---------------------------------------------------------------------------
# Pytest test
# ---------------------------------------------------------------------------


@pytest.mark.skipif(
    _try_import_renderer()[0] is None,
    reason="cairosvg/Pillow not installed; snapshot test skipped",
)
def test_svg_snapshots_match_baseline():
    """Every element's rendered SVG hash must match the baseline."""
    baseline = _load_baseline()
    if not baseline:
        pytest.fail(
            "No snapshot baseline found. Run "
            "`python tests/test_svg_snapshots.py --update` to create one."
        )

    current = _all_element_hashes()
    diffs = []
    for key, hash_now in current.items():
        if key not in baseline:
            diffs.append(f"new element '{key}' has no baseline")
        elif baseline[key] != hash_now:
            diffs.append(f"'{key}' changed (was {baseline[key][:12]}…, "
                         f"now {hash_now[:12]}…)")
    for key in baseline:
        if key not in current:
            diffs.append(f"baseline element '{key}' is missing")

    if diffs:
        pytest.fail(
            "SVG snapshots changed. If intentional, run "
            "`python tests/test_svg_snapshots.py --update` to refresh.\n"
            + "\n".join("  - " + d for d in diffs)
        )


# ---------------------------------------------------------------------------
# CLI entry point for updating baselines
# ---------------------------------------------------------------------------


def _update_baseline_cli():
    cairosvg, Image = _try_import_renderer()
    if not cairosvg or not Image:
        sys.stderr.write(
            "Cannot update baselines: cairosvg/Pillow not installed.\n"
            "Install with: pip install cairosvg pillow\n"
        )
        sys.exit(1)
    hashes = _all_element_hashes()
    _save_baseline(hashes)
    print(f"Wrote baseline for {len(hashes)} elements to "
          f"{SNAPSHOT_FILE.relative_to(PROJECT_ROOT)}")


if __name__ == "__main__":
    if "--update" in sys.argv or "--update-snapshots" in sys.argv:
        _update_baseline_cli()
    else:
        sys.stderr.write(
            "Usage:\n"
            "  python -m pytest tests/test_svg_snapshots.py    (run test)\n"
            "  python tests/test_svg_snapshots.py --update     (refresh baselines)\n"
        )
        sys.exit(2)
