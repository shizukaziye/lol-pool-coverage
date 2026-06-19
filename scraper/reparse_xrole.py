"""
One-off: re-parse the warm /tmp/lolcache build responses into per-role snapshots.

The original scrape kept only the SAME-lane matchup list per champion. The raw
build responses we cached during the backfill also carry the champion's matchup
tables vs enemies in the four OTHER roles. This script re-reads those cached
responses and rewrites each data/snapshots/{patch}/{lane}.json with the new
nested shape:

    matchups[subject_rid][role][opponent_rid] = { "d2": float, "games": int }

where role in {top, jungle, middle, bottom, support}. The subject's own lane
key reproduces the old same-lane data exactly (verified); the other four are
cross-role. Tierlists are preserved untouched.

Cross-role opponents are filtered to the PR-qualified champ set for the
OPPONENT's role (that role's snapshot tierlist keys), mirroring the original
same-lane `opp in lane_riot_ids` filter. No network — cache only.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

from qwik_parser import ROLE_KEYS, parse_build_matchups_by_role

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = REPO_ROOT / "data"
SNAP_DIR = DATA_DIR / "snapshots"
CACHE_DIR = Path("/tmp/lolcache")

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s")
log = logging.getLogger("reparse")


def load_champions() -> dict:
    c = json.loads((DATA_DIR / "champions.json").read_text())
    return c["by_riot_id"]  # rid -> {slug, name}


def qualified_rids_by_role(patch: str) -> dict[str, set[str]]:
    """For one patch, the PR-qualified rid set per role = that lane snapshot's
    tierlist keys (same set the original scrape used as lane_riot_ids)."""
    out: dict[str, set[str]] = {}
    for role in ROLE_KEYS:
        snap = SNAP_DIR / patch / f"{role}.json"
        if snap.exists():
            out[role] = set(json.loads(snap.read_text()).get("tierlist", {}).keys())
        else:
            out[role] = set()
    return out


def reparse_snapshot(patch: str, lane: str, by_rid: dict, qual: dict[str, set[str]]) -> tuple[int, int, dict]:
    snap_path = SNAP_DIR / patch / f"{lane}.json"
    snap = json.loads(snap_path.read_text())
    tierlist = snap.get("tierlist", {})

    matchups: dict[str, dict] = {}
    missing_cache = 0
    for rid in tierlist:
        meta = by_rid.get(rid)
        if not meta:
            continue
        slug = meta["slug"]
        cache = CACHE_DIR / f"{patch}__build_{lane}_{slug}.json"
        if not cache.exists():
            missing_cache += 1
            continue
        blob = json.loads(cache.read_text())
        by_role = parse_build_matchups_by_role(blob)
        role_map: dict[str, dict] = {}
        for role, mu_list in by_role.items():
            allowed = qual.get(role, set())
            reduced: dict[str, dict] = {}
            for m in mu_list:
                opp = m["riot_id"]
                if opp not in allowed:
                    continue
                if role == lane and opp == rid:  # self in own lane
                    continue
                d2, games = m.get("d2"), m.get("games")
                if d2 is None or games is None or games <= 0:
                    continue
                reduced[opp] = {"d2": round(float(d2), 4), "games": int(games)}
            if reduced:
                role_map[role] = reduced
        matchups[rid] = role_map

    snap["matchups"] = matchups
    snap["schema_version"] = 2  # bumped: matchups are now nested by role
    snap_path.write_text(json.dumps(snap, indent=2, sort_keys=True))
    return len(matchups), missing_cache, snap


def verify_same_lane(old_snap_matchups: dict, new_snap: dict, lane: str) -> tuple[int, int]:
    """Compare a re-parsed same-lane role against the original flat matchups."""
    ok = bad = 0
    for rid, old_map in old_snap_matchups.items():
        new_same = new_snap["matchups"].get(rid, {}).get(lane, {})
        for opp, mu in old_map.items():
            nv = new_same.get(opp)
            if nv and abs(nv["d2"] - mu["d2"]) < 1e-6:
                ok += 1
            else:
                bad += 1
    return ok, bad


def run() -> None:
    by_rid = load_champions()
    patches = sorted(p.name for p in SNAP_DIR.iterdir() if p.is_dir())
    total_subj = total_missing = total_ok = total_bad = 0
    for patch in patches:
        qual = qualified_rids_by_role(patch)
        for lane in ROLE_KEYS:
            snap_path = SNAP_DIR / patch / f"{lane}.json"
            if not snap_path.exists():
                continue
            old_matchups = json.loads(snap_path.read_text()).get("matchups", {})
            n_subj, missing, new_snap = reparse_snapshot(patch, lane, by_rid, qual)
            ok, bad = verify_same_lane(old_matchups, new_snap, lane)
            total_subj += n_subj
            total_missing += missing
            total_ok += ok
            total_bad += bad
            # cross-role coverage: avg roles present per subject
            roles_present = sum(len(m) for m in new_snap["matchups"].values())
            log.info(
                "%s/%s: %d subjects, %d role-tables (avg %.1f roles/subj), same-lane verify ok=%d bad=%d, missing-cache=%d",
                patch, lane, n_subj, roles_present,
                roles_present / max(n_subj, 1), ok, bad, missing,
            )
    log.info(
        "DONE: %d subject-snapshots, same-lane verify ok=%d bad=%d, missing-cache=%d",
        total_subj, total_ok, total_bad, total_missing,
    )
    if total_bad:
        log.error("Same-lane mismatch detected — re-parse is NOT faithful, investigate before aggregating.")


if __name__ == "__main__":
    run()
