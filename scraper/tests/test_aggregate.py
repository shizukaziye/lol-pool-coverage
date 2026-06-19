"""
Pytest suite for the weighted aggregation formula.

The fixture under tests/fixtures/ contains 2 patches × 2 champions × 1 lane × 1
matchup (Aatrox 266 vs Garen 86, top lane) with hand-computed expected outputs
in weighted_expected/top.json. The webapp JS scoring tests will validate the
same fixture, so this is the canonical agreement point between scraper and
frontend (per docs/SCORING.md).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).parent
FIXTURE_DIR = HERE / "fixtures"

# Ensure the scraper package is importable.
sys.path.insert(0, str(HERE.parent))

import aggregate  # noqa: E402


@pytest.fixture
def patched_paths(monkeypatch, tmp_path):
    """Point aggregate at the test fixtures, write outputs to tmp."""
    # Mirror the directory layout aggregate.py expects: SNAP_DIR sibling of
    # WEIGHTED_DIR; PATCHES_FILE alongside. We just monkeypatch the module
    # constants directly.
    snap = FIXTURE_DIR / "snapshots"
    weighted = tmp_path / "weighted"
    weighted.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(aggregate, "SNAP_DIR", snap)
    monkeypatch.setattr(aggregate, "WEIGHTED_DIR", weighted)
    monkeypatch.setattr(aggregate, "PATCHES_FILE", FIXTURE_DIR / "patches.json")
    return weighted


def test_aggregate_matches_hand_computed_fixture(patched_paths):
    weighted_dir = patched_paths
    aggregate.run(["top"])
    out = json.loads((weighted_dir / "top.json").read_text())

    expected = json.loads((FIXTURE_DIR / "weighted_expected" / "top.json").read_text())

    # Schema sanity.
    assert out["schema_version"] == 1
    assert out["lane"] == "top"
    assert out["source_patches"] == expected["source_patches"]
    assert "generated_at" in out

    # Tier list.
    for rid, exp in expected["tierlist"].items():
        actual = out["tierlist"][rid]
        assert actual["pr"] == pytest.approx(exp["pr"], abs=1e-4), f"pr({rid})"
        assert actual["wr"] == pytest.approx(exp["wr"], abs=1e-4), f"wr({rid})"
        assert actual["games_total"] == exp["games_total"], f"games_total({rid})"
        # Also check unrounded equivalence (within float epsilon).
        assert actual["pr"] == pytest.approx(exp["pr_unrounded"], abs=5e-5)
        assert actual["wr"] == pytest.approx(exp["wr_unrounded"], abs=5e-5)

    # Matchups.
    actual_mu = out["matchups"]["266"]["86"]
    exp_mu = expected["matchups"]["266"]["86"]
    assert actual_mu["d2"] == pytest.approx(exp_mu["d2"], abs=1e-4)
    assert actual_mu["d2"] == pytest.approx(exp_mu["d2_unrounded"], abs=5e-5)
    assert actual_mu["games_total"] == exp_mu["games_total"]

    # Garen has no matchups in our fixture.
    assert "86" not in out["matchups"]


def test_missing_snapshot_is_skipped_not_zeroed(patched_paths, monkeypatch):
    """If a patch in patches.json has no snapshot file, it's silently skipped
    and the remaining patches still aggregate correctly (sum only over present
    data, per DATA_FORMAT.md)."""
    weighted_dir = patched_paths

    # Pretend there's a 3rd patch with no snapshot file.
    bogus_patches = {
        "schema_version": 1,
        "current_patch": "15.11",
        "patches": [
            {"patch": "15.11", "scraped_at": "2026-06-19T08:00:00Z", "is_final": False, "k_back": 0},
            {"patch": "15.10", "scraped_at": "2026-06-12T08:00:00Z", "is_final": True, "k_back": 1},
            {"patch": "15.9", "scraped_at": "2026-05-29T08:00:00Z", "is_final": True, "k_back": 2},
        ],
    }
    patches_path = FIXTURE_DIR / "_bogus_patches.json"
    patches_path.write_text(json.dumps(bogus_patches))
    monkeypatch.setattr(aggregate, "PATCHES_FILE", patches_path)
    try:
        aggregate.run(["top"])
        out = json.loads((weighted_dir / "top.json").read_text())
        # Missing 15.9 must not appear in source_patches.
        assert "15.9" not in out["source_patches"]
        # The d2 must still equal the 2-patch hand-computed value.
        assert out["matchups"]["266"]["86"]["d2"] == pytest.approx(-0.5038, abs=1e-4)
    finally:
        patches_path.unlink(missing_ok=True)


def test_k_back_20_is_dropped(patched_paths, monkeypatch):
    """Patches with k_back >= 20 must be excluded from the aggregate."""
    weighted_dir = patched_paths
    bogus = {
        "schema_version": 1,
        "current_patch": "15.11",
        "patches": [
            {"patch": "15.11", "scraped_at": "x", "is_final": False, "k_back": 0},
            {"patch": "15.10", "scraped_at": "x", "is_final": True, "k_back": 20},
        ],
    }
    p = FIXTURE_DIR / "_kback_patches.json"
    p.write_text(json.dumps(bogus))
    monkeypatch.setattr(aggregate, "PATCHES_FILE", p)
    try:
        aggregate.run(["top"])
        out = json.loads((weighted_dir / "top.json").read_text())
        # Only 15.11 should have contributed; matchup d2 should equal the
        # patch-15.11 raw value (-0.40 from our fixture).
        assert out["source_patches"] == ["15.11"]
        assert out["matchups"]["266"]["86"]["d2"] == pytest.approx(-0.40, abs=1e-4)
    finally:
        p.unlink(missing_ok=True)
