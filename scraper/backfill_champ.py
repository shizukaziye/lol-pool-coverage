"""
One-off: backfill ALL patches' matchup data for a single (champ, lane), even
tiny samples.

Niche pool picks (e.g. Lissandra top) sit below the scrape's PR threshold in
most patches, so their build page was never fetched and the aggregate has only
one patch of (noisy, low-sample) matchups. This fetches the champ's build page
for every registered patch (live, cached under /tmp/lolcache), parses all five
role matchup lists, filters opponents to each role's qualified set, and merges
the result into data/snapshots/{patch}/{lane}.json. Re-run aggregate.py after.

Usage:
    python3 backfill_champ.py --slug lissandra --rid 127 --lane top
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from scrape_http import fetch_json, build_url, SNAP_DIR, DATA_DIR  # noqa: E402
from qwik_parser import parse_build_matchups_by_role, ROLE_KEYS  # noqa: E402


def qualified_by_role(patch: str) -> dict[str, set[str]]:
    out: dict[str, set[str]] = {}
    for role in ROLE_KEYS:
        sp = SNAP_DIR / patch / f"{role}.json"
        out[role] = set(json.loads(sp.read_text()).get("tierlist", {}).keys()) if sp.exists() else set()
    return out


def run(slug: str, rid: str, lane: str) -> None:
    reg = json.loads((DATA_DIR / "patches.json").read_text())
    patches = [p["patch"] for p in reg.get("patches", [])]
    total_games = 0
    for patch in patches:
        sp = SNAP_DIR / patch / f"{lane}.json"
        if not sp.exists():
            continue
        blob = fetch_json(build_url(slug, lane, patch), f"build_{lane}_{slug}", patch)
        if blob is None:
            print(f"{patch}: no build data")
            continue
        by_role = parse_build_matchups_by_role(blob)
        if not by_role:
            print(f"{patch}: no matchups parsed")
            continue
        qual = qualified_by_role(patch)
        role_map: dict[str, dict] = {}
        for role, mu_list in by_role.items():
            allowed = qual.get(role, set())
            reduced: dict[str, dict] = {}
            for m in mu_list:
                opp = m["riot_id"]
                if opp not in allowed:
                    continue
                if role == lane and opp == rid:
                    continue
                d2, g = m.get("d2"), m.get("games")
                if d2 is None or g is None or g <= 0:
                    continue
                reduced[opp] = {"d2": round(float(d2), 4), "games": int(g)}
            if reduced:
                role_map[role] = reduced
        snap = json.loads(sp.read_text())
        snap.setdefault("matchups", {})[rid] = role_map
        sp.write_text(json.dumps(snap, indent=2, sort_keys=True))
        nopp = sum(len(v) for v in role_map.values())
        kennen = role_map.get(lane, {}).get("85")
        kg = kennen["games"] if kennen else 0
        total_games += kg
        print(f"{patch}: merged {nopp} matchups / {len(role_map)} roles | same-lane vs Kennen(85): {kennen}")
    print(f"\nDone. (vs-Kennen games summed across patches: {total_games})")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--slug", required=True)
    ap.add_argument("--rid", required=True)
    ap.add_argument("--lane", default="top")
    a = ap.parse_args()
    run(a.slug, a.rid, a.lane)
