"""
Unit tests for scripts/build.py.

Run with:
    python -m pytest tests/

Tests are split by responsibility — semver helpers, validation, SVG generation,
and payload construction. Each test is self-contained and uses small fixture
dicts rather than the real elements.yml so we can exercise edge cases.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
import yaml

# Add scripts/ to sys.path so we can `import build` without a package layout.
PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "scripts"))

import build  # noqa: E402


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def make_valid_element(key: str, weakness: str, **overrides) -> dict:
    """Build a minimal valid element dict for tests."""
    base = {
        "key": key,
        "name": key.title(),
        "emoji": "❓",
        "color": "#ffffff",
        "color_dark": "#000000",
        "weakness": weakness,
        "specials": ["a", "b", "c", "d"],
        "boss_title": f"Master of {key.title()}",
        "mobs": [{"name": "test mob", "emoji": "👾"}],
    }
    base.update(overrides)
    return base


def make_valid_data() -> dict:
    """Build a minimal valid data dict (paired weaknesses)."""
    pairs = [
        ("fire", "water"),
        ("water", "fire"),
        ("wind", "earth"),
        ("earth", "wind"),
        ("lightning", "dust"),
        ("dust", "lightning"),
        ("ice", "lava"),
        ("lava", "ice"),
    ]
    return {
        "elements": [make_valid_element(k, w) for k, w in pairs],
        "neutral_mobs": [{"name": "Bat", "emoji": "🦇"}],
        "balance": {
            "hero_base_hp": 50, "hero_hp_per_level": 10,
            "hero_base_attack": 8, "hero_attack_per_level": 2,
            "mob_base_hp": 30, "mob_hp_per_level": 7,
            "mob_base_attack": 6, "mob_attack_per_level": 1,
            "boss_hp_multiplier": 2.5, "boss_attack_multiplier": 1.5,
            "super_effective_mob": 1.5, "super_effective_boss": 2.0,
            "special_energy_cost": 30, "special_energy_max": 100,
            "special_energy_per_attack": 20, "special_damage_multiplier": 2.0,
            "defend_damage_reduction": 0.5,
            "neutral_mob_chance": 0.25,
            "neutral_mob_hp_multiplier": 1.2,
            "neutral_mob_attack_multiplier": 1.2,
            "element_unlock_levels": [5, 10, 15],
            "max_elements": 4,
        },
    }


# ---------------------------------------------------------------------------
# parse_semver
# ---------------------------------------------------------------------------


class TestParseSemver:
    def test_valid_versions(self):
        assert build.parse_semver("1.0.0") == (1, 0, 0)
        assert build.parse_semver("0.1.2") == (0, 1, 2)
        assert build.parse_semver("12.34.56") == (12, 34, 56)

    @pytest.mark.parametrize("bad", [
        "1.0",         # too few parts
        "1.0.0.0",     # too many parts
        "v1.0.0",      # leading 'v'
        "1.0.0-alpha", # pre-release
        "a.b.c",       # not numeric
        "",            # empty
        "1..0",        # missing middle
    ])
    def test_invalid_versions(self, bad):
        assert build.parse_semver(bad) is None

    def test_non_string(self):
        assert build.parse_semver(None) is None
        assert build.parse_semver(100) is None
        assert build.parse_semver(["1", "0", "0"]) is None

    def test_negative_numbers_rejected(self):
        # "1.-0.0" parses parts as ints but -0 == 0 so that's allowed;
        # explicit negative should be rejected.
        assert build.parse_semver("1.-1.0") is None


# ---------------------------------------------------------------------------
# is_compatible_save_version
# ---------------------------------------------------------------------------


class TestSaveCompatibility:
    def test_same_major_compatible(self):
        assert build.is_compatible_save_version("1.0.0", "1.0.0") is True
        assert build.is_compatible_save_version("1.2.5", "1.0.0") is True
        assert build.is_compatible_save_version("1.0.0", "1.99.99") is True

    def test_different_major_incompatible(self):
        assert build.is_compatible_save_version("1.0.0", "2.0.0") is False
        assert build.is_compatible_save_version("2.0.0", "1.0.0") is False

    def test_malformed_version_incompatible(self):
        assert build.is_compatible_save_version("garbage", "1.0.0") is False
        assert build.is_compatible_save_version("1.0.0", "garbage") is False
        assert build.is_compatible_save_version(None, "1.0.0") is False


# ---------------------------------------------------------------------------
# validate_elements
# ---------------------------------------------------------------------------


class TestValidateElements:
    def test_valid_data_no_errors(self):
        data = make_valid_data()
        assert build.validate_elements(data["elements"]) == []

    def test_wrong_count(self):
        data = make_valid_data()
        errors = build.validate_elements(data["elements"][:1])
        assert any("Expected at least 2 elements" in e for e in errors)

    def test_missing_required_key(self):
        data = make_valid_data()
        del data["elements"][0]["mobs"]
        errors = build.validate_elements(data["elements"])
        assert any("missing keys" in e and "mobs" in e for e in errors)

    def test_duplicate_element_key(self):
        data = make_valid_data()
        data["elements"][0]["key"] = data["elements"][1]["key"]
        errors = build.validate_elements(data["elements"])
        assert any("duplicate element key" in e for e in errors)

    def test_specials_must_be_four(self):
        data = make_valid_data()
        data["elements"][0]["specials"] = ["only", "three", "specials"]
        errors = build.validate_elements(data["elements"])
        assert any("must have exactly 4 specials" in e for e in errors)

    def test_mobs_must_have_at_least_one(self):
        data = make_valid_data()
        data["elements"][0]["mobs"] = []
        errors = build.validate_elements(data["elements"])
        assert any("at least 1 mob" in e for e in errors)

    def test_mob_must_have_name_and_emoji(self):
        data = make_valid_data()
        data["elements"][0]["mobs"] = [{"name": "no-emoji"}]
        errors = build.validate_elements(data["elements"])
        assert any("missing 'name' or 'emoji'" in e for e in errors)

    def test_unknown_weakness(self):
        data = make_valid_data()
        data["elements"][0]["weakness"] = "nonexistent"
        errors = build.validate_elements(data["elements"])
        assert any("unknown weakness" in e for e in errors)

    def test_asymmetric_weakness(self):
        data = make_valid_data()
        # Make fire weak to wind, but wind still weak to earth -> asymmetric
        data["elements"][0]["weakness"] = "wind"
        errors = build.validate_elements(data["elements"])
        assert any("Asymmetric weakness" in e for e in errors)

    def test_real_data_file_validates(self):
        """The shipped _data/elements.yml itself must validate cleanly."""
        path = PROJECT_ROOT / "_data" / "elements.yml"
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
        assert build.validate_data(data) == []


# ---------------------------------------------------------------------------
# validate_neutral_mobs
# ---------------------------------------------------------------------------


class TestValidateNeutralMobs:
    def test_valid(self):
        assert build.validate_neutral_mobs(
            [{"name": "Bat", "emoji": "🦇"}]
        ) == []

    def test_must_be_list(self):
        errors = build.validate_neutral_mobs("not a list")
        assert errors  # non-empty

    def test_empty_list_rejected(self):
        errors = build.validate_neutral_mobs([])
        assert any("non-empty" in e for e in errors)

    def test_missing_emoji(self):
        errors = build.validate_neutral_mobs([{"name": "Just a name"}])
        assert any("missing 'name' or 'emoji'" in e for e in errors)


# ---------------------------------------------------------------------------
# validate_balance
# ---------------------------------------------------------------------------


class TestValidateBalance:
    def test_valid(self):
        assert build.validate_balance(make_valid_data()["balance"]) == []

    def test_not_a_dict(self):
        assert build.validate_balance(["wrong type"]) == [
            "'balance' must be a mapping"
        ]

    def test_missing_keys_reported(self):
        bal = make_valid_data()["balance"]
        del bal["super_effective_boss"]
        errors = build.validate_balance(bal)
        assert any("super_effective_boss" in e for e in errors)

    def test_neutral_chance_out_of_range(self):
        bal = make_valid_data()["balance"]
        bal["neutral_mob_chance"] = 1.5
        errors = build.validate_balance(bal)
        assert any("between 0 and 1" in e for e in errors)

    def test_neutral_chance_negative(self):
        bal = make_valid_data()["balance"]
        bal["neutral_mob_chance"] = -0.1
        errors = build.validate_balance(bal)
        assert any("between 0 and 1" in e for e in errors)

    def test_max_elements_must_be_positive_int(self):
        bal = make_valid_data()["balance"]
        bal["max_elements"] = 0
        errors = build.validate_balance(bal)
        assert any("max_elements" in e for e in errors)

    def test_unlock_levels_must_be_list_of_positive_ints(self):
        bal = make_valid_data()["balance"]
        bal["element_unlock_levels"] = [5, "ten", 15]
        errors = build.validate_balance(bal)
        assert any("element_unlock_levels" in e for e in errors)


# ---------------------------------------------------------------------------
# build_js_payload
# ---------------------------------------------------------------------------


class TestBuildJsPayload:
    def test_includes_version(self):
        data = make_valid_data()
        payload = build.build_js_payload(data, "1.2.3")
        assert payload["version"] == "1.2.3"

    def test_element_index_lookup(self):
        data = make_valid_data()
        payload = build.build_js_payload(data, "1.0.0")
        assert payload["elementIndex"]["fire"] == 0
        assert payload["elementIndex"]["lava"] == len(data["elements"]) - 1

    def test_weakness_lookup_complete(self):
        data = make_valid_data()
        payload = build.build_js_payload(data, "1.0.0")
        for el in data["elements"]:
            assert payload["weaknessOf"][el["key"]] == el["weakness"]

    def test_payload_includes_neutral_mobs(self):
        data = make_valid_data()
        payload = build.build_js_payload(data, "1.0.0")
        assert "neutralMobs" in payload
        assert payload["neutralMobs"][0]["name"] == "Bat"

    def test_payload_includes_balance_unchanged(self):
        data = make_valid_data()
        payload = build.build_js_payload(data, "1.0.0")
        assert payload["balance"] == data["balance"]


# ---------------------------------------------------------------------------
# svg_for
# ---------------------------------------------------------------------------


class TestSvgFor:
    def test_returns_valid_svg(self):
        el = make_valid_element("fire", "water", name="Fire")
        out = build.svg_for(el)
        assert out.startswith('<?xml version="1.0"')
        assert out.rstrip().endswith("</svg>")

    def test_aria_label_uses_name(self):
        el = make_valid_element("fire", "water", name="Fire")
        out = build.svg_for(el)
        assert 'aria-label="Fire"' in out

    def test_color_in_gradient(self):
        el = make_valid_element("fire", "water",
                                color="#abcdef", color_dark="#012345")
        out = build.svg_for(el)
        assert "#abcdef" in out
        assert "#012345" in out

    def test_unknown_key_raises(self):
        el = make_valid_element("not-a-real-element", "fire")
        with pytest.raises(KeyError):
            build.svg_for(el)

    def test_all_real_elements_render(self):
        path = PROJECT_ROOT / "_data" / "elements.yml"
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
        for el in data["elements"]:
            out = build.svg_for(el)
            assert "<svg" in out
            assert "</svg>" in out


# ---------------------------------------------------------------------------
# read_game_version
# ---------------------------------------------------------------------------


class TestReadGameVersion:
    def test_real_config(self):
        v = build.read_game_version()
        assert build.parse_semver(v) is not None

    def test_missing_key(self, tmp_path):
        cfg = tmp_path / "_config.yml"
        cfg.write_text("title: Game\n", encoding="utf-8")
        with pytest.raises(SystemExit):
            build.read_game_version(cfg)

    def test_empty_file(self, tmp_path):
        cfg = tmp_path / "_config.yml"
        cfg.write_text("", encoding="utf-8")
        with pytest.raises(SystemExit):
            build.read_game_version(cfg)
