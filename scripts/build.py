#!/usr/bin/env python3
"""
build.py — Pre-build step for Elemental Masters.

Reads _data/elements.yml (single source of truth) and generates:
  - assets/svg/elements/<key>.svg   (one stylized icon per element)
  - assets/js/generated-data.js     (data module consumed by the game)

Run before `bundle exec jekyll serve` or `jekyll build`. Outputs are listed
in .gitignore so they're always regenerated from source.

Usage:
    python3 scripts/build.py

Most non-IO logic in this module is split into pure functions that take
their inputs and return their outputs without touching the filesystem.
This keeps the module unit-testable from `tests/test_build.py`.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

try:
    import yaml
except ImportError:
    sys.stderr.write(
        "ERROR: PyYAML is required. Install with: pip install pyyaml\n"
    )
    sys.exit(1)


# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATA_FILE = PROJECT_ROOT / "_data" / "elements.yml"
SVG_OUT_DIR = PROJECT_ROOT / "assets" / "svg" / "elements"
ICONS_OUT_DIR = PROJECT_ROOT / "assets" / "icons"
JS_OUT_FILE = PROJECT_ROOT / "assets" / "js" / "generated-data.js"
CONFIG_FILE = PROJECT_ROOT / "_config.yml"


# ---------------------------------------------------------------------------
# Semver helpers (pure)
# ---------------------------------------------------------------------------

def parse_semver(version: str) -> tuple[int, int, int] | None:
    """Parse a 'MAJOR.MINOR.PATCH' string. Return None if malformed.

    Accepts only strict three-part semver (no pre-release / build metadata
    is needed for this project).
    """
    if not isinstance(version, str):
        return None
    parts = version.split(".")
    if len(parts) != 3:
        return None
    try:
        major, minor, patch = (int(p) for p in parts)
    except ValueError:
        return None
    if major < 0 or minor < 0 or patch < 0:
        return None
    return (major, minor, patch)


def is_compatible_save_version(save_version: str, game_version: str) -> bool:
    """Same-major-version saves are considered compatible.

    Mirrors the JS logic in save.js so behaviour stays in sync if anyone
    changes one without the other (the test suite checks both).
    """
    s = parse_semver(save_version)
    g = parse_semver(game_version)
    if s is None or g is None:
        return False
    return s[0] == g[0]


# ---------------------------------------------------------------------------
# SVG generation (pure: returns string given dict)
# ---------------------------------------------------------------------------
#
# Each element gets a 64x64 viewBox icon built from simple shapes. All icons
# share the same size and a color gradient derived from the element's
# `color` (light) and `color_dark` (dark) values.
#
# These are intentionally simple, vectorial, and bandwidth-friendly —
# typically <1KB each. The emoji in the data is what carries most of the
# visual weight in the UI; SVGs are decorative accents.

SVG_TEMPLATE_HEADER = '''<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" aria-label="{name}">
  <defs>
    <linearGradient id="g-{key}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="{color}"/>
      <stop offset="100%" stop-color="{color_dark}"/>
    </linearGradient>
  </defs>
'''

SVG_TEMPLATE_FOOTER = "</svg>\n"


def svg_for(element: dict) -> str:
    """Return a hand-tuned SVG body for the given element."""
    key = element["key"]
    fill = f'url(#g-{key})'
    stroke = element["color_dark"]

    # Pick a shape per element. Each path/group is sized for the 64x64 box.
    body_by_key = {
        "fire": (
            f'<path d="M32 6 C 38 18, 50 24, 46 40 C 44 50, 36 58, 32 58 '
            f'C 28 58, 20 50, 18 40 C 14 24, 26 18, 32 6 Z" '
            f'fill="{fill}" stroke="{stroke}" stroke-width="2"/>'
            f'<path d="M32 24 C 36 32, 40 36, 38 44 C 36 50, 32 52, 32 52 '
            f'C 32 52, 28 50, 26 44 C 24 36, 28 32, 32 24 Z" '
            f'fill="#fff8d6" opacity="0.55"/>'
        ),
        "water": (
            f'<path d="M32 6 C 22 22, 14 32, 14 42 A 18 18 0 0 0 50 42 '
            f'C 50 32, 42 22, 32 6 Z" '
            f'fill="{fill}" stroke="{stroke}" stroke-width="2"/>'
            f'<ellipse cx="26" cy="36" rx="5" ry="8" fill="#ffffff" opacity="0.45"/>'
        ),
        "wind": (
            f'<g fill="none" stroke="{fill}" stroke-width="5" '
            f'stroke-linecap="round">'
            f'<path d="M10 22 H 40 A 6 6 0 1 0 34 16"/>'
            f'<path d="M8 34 H 50 A 7 7 0 1 0 42 27"/>'
            f'<path d="M14 46 H 36 A 5 5 0 1 0 30 41"/>'
            f'</g>'
        ),
        "earth": (
            f'<path d="M6 50 L 22 28 L 32 38 L 44 18 L 58 50 Z" '
            f'fill="{fill}" stroke="{stroke}" stroke-width="2" stroke-linejoin="round"/>'
            f'<path d="M22 28 L 32 38 L 44 18 L 38 18 L 32 30 L 24 26 Z" '
            f'fill="#ffffff" opacity="0.25"/>'
        ),
        "lightning": (
            f'<path d="M36 4 L 14 36 H 28 L 22 60 L 50 26 H 34 Z" '
            f'fill="{fill}" stroke="{stroke}" stroke-width="2" stroke-linejoin="round"/>'
        ),
        "dust": (
            f'<g fill="{fill}" stroke="{stroke}" stroke-width="1.5">'
            f'<circle cx="20" cy="40" r="10"/>'
            f'<circle cx="34" cy="34" r="13"/>'
            f'<circle cx="48" cy="42" r="9"/>'
            f'<circle cx="28" cy="48" r="6"/>'
            f'<circle cx="42" cy="50" r="5"/>'
            f'</g>'
            f'<g fill="{stroke}" opacity="0.5">'
            f'<circle cx="22" cy="20" r="2"/>'
            f'<circle cx="44" cy="16" r="1.5"/>'
            f'<circle cx="34" cy="12" r="1.5"/>'
            f'</g>'
        ),
        "ice": (
            # Six-armed snowflake with branched tips. Center at (32,32).
            # Three axes: vertical, +30deg, -30deg → six arms total.
            f'<g stroke="{fill}" stroke-width="3.5" stroke-linecap="round" fill="none">'
            f'<line x1="32" y1="6"  x2="32" y2="58"/>'
            f'<line x1="9.5" y1="19" x2="54.5" y2="45"/>'
            f'<line x1="9.5" y1="45" x2="54.5" y2="19"/>'
            f'<path d="M32 12 L 27 7  M32 12 L 37 7"/>'
            f'<path d="M32 52 L 27 57 M32 52 L 37 57"/>'
            f'<path d="M48 22 L 50 16  M48 22 L 54 22"/>'
            f'<path d="M16 42 L 14 48  M16 42 L 10 42"/>'
            f'<path d="M16 22 L 10 22  M16 22 L 14 16"/>'
            f'<path d="M48 42 L 54 42  M48 42 L 50 48"/>'
            f'</g>'
            f'<circle cx="32" cy="32" r="3.5" fill="{fill}"/>'
        ),
        "lava": (
            f'<path d="M6 54 L 14 42 L 24 48 L 32 36 L 42 46 L 52 38 L 58 54 Z" '
            f'fill="{stroke}" stroke="{stroke}" stroke-width="1"/>'
            f'<path d="M22 38 C 26 28, 22 22, 28 14 C 28 22, 34 22, 32 30 '
            f'C 38 26, 36 18, 42 12 C 42 22, 48 26, 44 36 Z" '
            f'fill="{fill}" stroke="{stroke}" stroke-width="1.5"/>'
            f'<circle cx="14" cy="50" r="2" fill="{fill}"/>'
            f'<circle cx="50" cy="50" r="2" fill="{fill}"/>'
        ),
    }

    if key not in body_by_key:
        raise KeyError(f"No SVG body defined for element key '{key}'")

    body = body_by_key[key]
    header = SVG_TEMPLATE_HEADER.format(
        key=key,
        name=element["name"],
        color=element["color"],
        color_dark=element["color_dark"],
    )
    return header + "  " + body + "\n" + SVG_TEMPLATE_FOOTER


# ---------------------------------------------------------------------------
# Validation (pure: returns list of error messages, never raises)
# ---------------------------------------------------------------------------

REQUIRED_ELEMENT_KEYS = {
    "key", "name", "emoji", "color", "color_dark",
    "weakness", "specials", "boss_title", "mobs",
}

REQUIRED_BALANCE_KEYS = {
    "hero_base_hp", "hero_hp_per_level", "hero_base_attack", "hero_attack_per_level",
    "mob_base_hp", "mob_hp_per_level", "mob_base_attack", "mob_attack_per_level",
    "boss_hp_multiplier", "boss_attack_multiplier",
    "super_effective_mob", "super_effective_boss",
    "special_energy_cost", "special_energy_max", "special_energy_per_attack",
    "special_damage_multiplier", "defend_damage_reduction",
    "neutral_mob_chance", "neutral_mob_hp_multiplier", "neutral_mob_attack_multiplier",
    "element_unlock_levels", "max_elements",
}


def validate_elements(elements: list[dict]) -> list[str]:
    """Return a list of human-readable validation errors. Empty list = OK."""
    errors: list[str] = []

    if not isinstance(elements, list):
        return ["'elements' must be a list"]
    if len(elements) != 8:
        errors.append(f"Expected 8 elements, got {len(elements)}")

    keys = set()
    for i, el in enumerate(elements):
        if not isinstance(el, dict):
            errors.append(f"element[{i}] is not a dict")
            continue
        missing = REQUIRED_ELEMENT_KEYS - el.keys()
        if missing:
            errors.append(
                f"element[{i}] ({el.get('key', '?')}) missing keys: "
                f"{sorted(missing)}"
            )
            continue
        if el["key"] in keys:
            errors.append(f"duplicate element key: {el['key']}")
        keys.add(el["key"])

        if not isinstance(el["specials"], list) or len(el["specials"]) != 4:
            errors.append(
                f"{el['key']}: must have exactly 4 specials "
                f"(got {len(el.get('specials', []))})"
            )

        mobs = el.get("mobs", [])
        if not isinstance(mobs, list) or len(mobs) < 1:
            errors.append(f"{el['key']}: must have at least 1 mob")
        else:
            for j, mob in enumerate(mobs):
                if not isinstance(mob, dict) or "name" not in mob or "emoji" not in mob:
                    errors.append(
                        f"{el['key']}.mobs[{j}] missing 'name' or 'emoji'"
                    )

    # Symmetric weakness check (only after we know keys)
    for el in elements:
        if not isinstance(el, dict):
            continue
        w = el.get("weakness")
        if w not in keys:
            errors.append(f"{el.get('key', '?')}: unknown weakness '{w}'")
            continue
        partner = next((e for e in elements if e.get("key") == w), None)
        if partner is None:
            continue
        if partner.get("weakness") != el["key"]:
            errors.append(
                f"Asymmetric weakness: {el['key']}<->{w} not paired correctly"
            )

    return errors


def validate_neutral_mobs(neutrals: Any) -> list[str]:
    """Validate the neutral_mobs list."""
    if not isinstance(neutrals, list) or len(neutrals) < 1:
        return ["'neutral_mobs' must be a non-empty list"]
    errors = []
    for i, mob in enumerate(neutrals):
        if not isinstance(mob, dict) or "name" not in mob or "emoji" not in mob:
            errors.append(f"neutral_mobs[{i}] missing 'name' or 'emoji'")
    return errors


def validate_balance(balance: Any) -> list[str]:
    """Validate balance constants are present and numeric where expected."""
    if not isinstance(balance, dict):
        return ["'balance' must be a mapping"]
    errors = []
    missing = REQUIRED_BALANCE_KEYS - balance.keys()
    if missing:
        errors.append(f"balance missing keys: {sorted(missing)}")

    # Sanity-check a few specific values
    chance = balance.get("neutral_mob_chance")
    if chance is not None and not (isinstance(chance, (int, float)) and 0 <= chance <= 1):
        errors.append(
            f"neutral_mob_chance must be between 0 and 1, got {chance!r}"
        )
    max_el = balance.get("max_elements")
    if max_el is not None and not (isinstance(max_el, int) and max_el >= 1):
        errors.append(f"max_elements must be a positive integer, got {max_el!r}")
    unlock = balance.get("element_unlock_levels")
    if unlock is not None:
        if not isinstance(unlock, list) or not all(isinstance(n, int) and n > 0 for n in unlock):
            errors.append("element_unlock_levels must be a list of positive ints")
    return errors


def validate_data(data: dict) -> list[str]:
    """Top-level validator combining all sub-validators."""
    if not isinstance(data, dict):
        return ["data root must be a mapping"]
    return (
        validate_elements(data.get("elements", []))
        + validate_neutral_mobs(data.get("neutral_mobs"))
        + validate_balance(data.get("balance"))
    )


# ---------------------------------------------------------------------------
# Data payload (pure: builds the JS payload dict)
# ---------------------------------------------------------------------------


def build_js_payload(data: dict, game_version: str) -> dict:
    """Construct the dict that will be JSON-serialized into the game data file."""
    return {
        "version": game_version,
        "elements": data["elements"],
        "neutralMobs": data["neutral_mobs"],
        "balance": data["balance"],
        # Convenience lookup: element key -> index in the elements array.
        "elementIndex": {el["key"]: i for i, el in enumerate(data["elements"])},
        # Convenience lookup: element key -> weakness key.
        "weaknessOf": {el["key"]: el["weakness"] for el in data["elements"]},
    }


# ---------------------------------------------------------------------------
# IO wrappers
# ---------------------------------------------------------------------------


def write_svgs(elements: list[dict]) -> None:
    SVG_OUT_DIR.mkdir(parents=True, exist_ok=True)
    for el in elements:
        path = SVG_OUT_DIR / f"{el['key']}.svg"
        path.write_text(svg_for(el), encoding="utf-8")
        print(f"  wrote {path.relative_to(PROJECT_ROOT)}")


# ---------------------------------------------------------------------------
# PWA icon generation
# ---------------------------------------------------------------------------
#
# Generates 192px and 512px PNG app icons for the web manifest. Without
# these, "Add to Home Screen" on phones falls back to a screenshot.
#
# Icons are rendered programmatically rather than checked in as binaries so
# the build is fully reproducible — change the design here, rebuild, deploy.
# Pillow is the only image dep and is widely available.

def write_pwa_icons(sizes: tuple[int, ...] = (192, 512)) -> bool:
    """Write PWA icons. Returns True on success, False if Pillow is missing.

    The icons are intentionally generated rather than stored: this keeps
    the icon design in source code and avoids checking in binary blobs.
    Skipped silently if Pillow isn't installed — local dev still works,
    but the manifest will 404 on the icons until someone runs the build
    in an environment that has Pillow (CI does).
    """
    try:
        from PIL import Image, ImageDraw, ImageFilter
    except ImportError:
        print("  (skipping PWA icons: Pillow not installed)")
        return False

    ICONS_OUT_DIR.mkdir(parents=True, exist_ok=True)

    BG_TOP = (42, 26, 82)        # deep purple
    BG_BOTTOM = (14, 8, 34)      # near-black
    GLOW = (255, 210, 63, 80)    # gold glow, partially transparent
    FLAME_OUTER = (255, 90, 31)  # fire orange
    FLAME_INNER = (255, 248, 214)  # near-white

    for size in sizes:
        img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        draw = ImageDraw.Draw(img)

        # Vertical gradient background, drawn line by line. Cheap and looks
        # better than a flat fill for an app icon.
        for y in range(size):
            t = y / max(size - 1, 1)
            r = int(BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * t)
            g = int(BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * t)
            b = int(BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * t)
            draw.line([(0, y), (size, y)], fill=(r, g, b, 255))

        # Soft glow behind the flame.
        glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        glow_draw = ImageDraw.Draw(glow)
        cx, cy = size // 2, int(size * 0.55)
        rg = int(size * 0.40)
        glow_draw.ellipse((cx - rg, cy - rg, cx + rg, cy + rg), fill=GLOW)
        glow = glow.filter(ImageFilter.GaussianBlur(radius=size // 14))
        img = Image.alpha_composite(img, glow)
        draw = ImageDraw.Draw(img)

        # Flame: a stylized teardrop. Coordinates are normalized to size.
        s = size
        outer = [
            (0.50 * s, 0.10 * s),
            (0.62 * s, 0.30 * s),
            (0.78 * s, 0.42 * s),
            (0.72 * s, 0.65 * s),
            (0.65 * s, 0.82 * s),
            (0.50 * s, 0.90 * s),
            (0.35 * s, 0.82 * s),
            (0.28 * s, 0.65 * s),
            (0.22 * s, 0.42 * s),
            (0.38 * s, 0.30 * s),
        ]
        draw.polygon(outer, fill=FLAME_OUTER)

        inner = [
            (0.50 * s, 0.32 * s),
            (0.58 * s, 0.50 * s),
            (0.60 * s, 0.65 * s),
            (0.50 * s, 0.78 * s),
            (0.40 * s, 0.65 * s),
            (0.42 * s, 0.50 * s),
        ]
        draw.polygon(inner, fill=FLAME_INNER)

        path = ICONS_OUT_DIR / f"icon-{size}.png"
        img.save(path, "PNG", optimize=True)
        print(f"  wrote {path.relative_to(PROJECT_ROOT)}")

    return True


JS_HEADER = """\
/*
 * generated-data.js — DO NOT EDIT BY HAND
 * Generated by scripts/build.py from _data/elements.yml.
 *
 * Exposes a single global, GameData, used by the rest of the game JS.
 */
"""


def write_js_data(data: dict, game_version: str) -> None:
    payload = build_js_payload(data, game_version)
    js = JS_HEADER + "window.GameData = " + json.dumps(payload, indent=2) + ";\n"
    JS_OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    JS_OUT_FILE.write_text(js, encoding="utf-8")
    print(f"  wrote {JS_OUT_FILE.relative_to(PROJECT_ROOT)}")


def read_game_version(config_path: Path = CONFIG_FILE) -> str:
    """Pull game_version from _config.yml so semver lives in one place."""
    cfg = yaml.safe_load(config_path.read_text(encoding="utf-8"))
    version = cfg.get("game_version") if isinstance(cfg, dict) else None
    if not version:
        raise SystemExit(f"{config_path} is missing 'game_version'")
    return version


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main() -> None:
    print("Building Elemental Masters assets...")
    data = yaml.safe_load(DATA_FILE.read_text(encoding="utf-8"))
    errors = validate_data(data)
    if errors:
        sys.stderr.write("Validation failed:\n")
        for err in errors:
            sys.stderr.write(f"  - {err}\n")
        sys.exit(1)
    version = read_game_version()
    print(f"  game version: {version}")
    write_svgs(data["elements"])
    write_pwa_icons()
    write_js_data(data, version)
    print("Done.")


if __name__ == "__main__":
    main()
