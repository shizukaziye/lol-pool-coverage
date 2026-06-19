"""
Aggregate snapshots into the weighted view consumed by the webapp.

For each lane, read every `data/snapshots/{patch}/{lane}.json` and combine
them with weights `0.9^k_back` (k_back comes from data/patches.json) per the
formula in docs/DATA_FORMAT.md:

    weighted_d2(C, opp)  = sum_k( d2_k(C,opp) * games_k(C,opp) * w_k )
                         / sum_k( games_k(C,opp) * w_k )

    weighted_pr(C)       = sum_k( pr_k(C)       * lane_games_total_k * w_k )
                         / sum_k( lane_games_total_k * w_k )

    weighted_wr(C)       = sum_k( wr_k(C)       * lane_games_total_k * w_k )
                         / sum_k( lane_games_total_k * w_k )

The sum is taken only over patches that have data for the (C, opp) pair (resp.
the (C, lane) row). `games_total` is the un-weighted sum, used for sample-size
filtering in the UI.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = REPO_ROOT / "data"
SNAP_DIR = DATA_DIR / "snapshots"
WEIGHTED_DIR = DATA_DIR / "weighted"
PATCHES_FILE = DATA_DIR / "patches.json"

LANES = ["top", "jungle", "middle", "bottom", "support"]
SCHEMA_VERSION = 1
WEIGHT_BASE = 0.9
MAX_K_BACK = 20  # exclusive upper bound

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("aggregate")


def now_utc_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def load_patches_registry() -> dict:
    if PATCHES_FILE.exists():
        return json.loads(PATCHES_FILE.read_text())
    return {"schema_version": SCHEMA_VERSION, "current_patch": None, "patches": []}


def weight(k_back: int) -> float:
    return WEIGHT_BASE**k_back


def aggregate_lane(lane: str, patches: list[dict]) -> dict:
    """Aggregate all snapshots for one lane into the weighted view dict.

    `patches` is the list from patches.json (each has patch, k_back).
    """
    # tier-level accumulators per champion
    pr_num: dict[str, float] = {}
    pr_den: dict[str, float] = {}
    wr_num: dict[str, float] = {}
    wr_den: dict[str, float] = {}
    games_total: dict[str, int] = {}

    # matchup-level accumulators
    mu_num: dict[str, dict[str, float]] = {}
    mu_den: dict[str, dict[str, float]] = {}
    mu_games_total: dict[str, dict[str, int]] = {}

    source_patches: list[str] = []

    for entry in patches:
        k = entry["k_back"]
        if k >= MAX_K_BACK:
            continue
        w = weight(k)
        patch_label = entry["patch"]
        snap_path = SNAP_DIR / patch_label / f"{lane}.json"
        if not snap_path.exists():
            log.info("No snapshot for %s/%s — skipping", patch_label, lane)
            continue
        snap = json.loads(snap_path.read_text())
        source_patches.append(patch_label)

        tierlist = snap.get("tierlist", {})
        matchups = snap.get("matchups", {})

        # `lane_games_total_k` per docs/DATA_FORMAT.md: total games played in
        # this lane on this patch — same weight applied to every champion's pr
        # and wr in that snapshot. (Per-champion games would conflate sample
        # size with metagame share.)
        lane_total = sum(int(row.get("games") or 0) for row in tierlist.values())
        lane_total_w = lane_total * w

        for rid, row in tierlist.items():
            pr = row.get("pr")
            wr = row.get("wr")
            games = row.get("games")
            if games is None or games <= 0:
                continue
            if lane_total_w > 0:
                if pr is not None:
                    pr_num[rid] = pr_num.get(rid, 0.0) + pr * lane_total_w
                    pr_den[rid] = pr_den.get(rid, 0.0) + lane_total_w
                if wr is not None:
                    wr_num[rid] = wr_num.get(rid, 0.0) + wr * lane_total_w
                    wr_den[rid] = wr_den.get(rid, 0.0) + lane_total_w
            games_total[rid] = games_total.get(rid, 0) + int(games)

        for subj_rid, opp_map in matchups.items():
            sub_num = mu_num.setdefault(subj_rid, {})
            sub_den = mu_den.setdefault(subj_rid, {})
            sub_gt = mu_games_total.setdefault(subj_rid, {})
            for opp_rid, mu in opp_map.items():
                g = mu.get("games")
                d2 = mu.get("d2")
                if g is None or g <= 0 or d2 is None:
                    continue
                gw = g * w
                sub_num[opp_rid] = sub_num.get(opp_rid, 0.0) + d2 * gw
                sub_den[opp_rid] = sub_den.get(opp_rid, 0.0) + gw
                sub_gt[opp_rid] = sub_gt.get(opp_rid, 0) + int(g)

    # Materialize.
    tier_out: dict[str, dict] = {}
    for rid in pr_den:
        if pr_den[rid] <= 0:
            continue
        tier_out[rid] = {
            "pr": round(pr_num[rid] / pr_den[rid], 4),
            "wr": round(wr_num[rid] / wr_den[rid], 4) if wr_den.get(rid, 0) > 0 else 0.0,
            "games_total": int(games_total.get(rid, 0)),
        }

    mu_out: dict[str, dict[str, dict]] = {}
    for subj_rid, sub_den in mu_den.items():
        for opp_rid, den in sub_den.items():
            if den <= 0:
                continue
            mu_out.setdefault(subj_rid, {})[opp_rid] = {
                "d2": round(mu_num[subj_rid][opp_rid] / den, 4),
                "games_total": int(mu_games_total[subj_rid][opp_rid]),
            }

    return {
        "schema_version": SCHEMA_VERSION,
        "lane": lane,
        "generated_at": now_utc_iso(),
        "source_patches": source_patches,
        "tierlist": tier_out,
        "matchups": mu_out,
    }


def run(lanes: Iterable[str] | None = None) -> None:
    reg = load_patches_registry()
    patches = reg.get("patches", [])
    if not patches:
        log.error("No patches registered in %s — run scrape first.", PATCHES_FILE)
        return

    WEIGHTED_DIR.mkdir(parents=True, exist_ok=True)
    for lane in lanes or LANES:
        out = aggregate_lane(lane, patches)
        out_path = WEIGHTED_DIR / f"{lane}.json"
        out_path.write_text(json.dumps(out, indent=2, sort_keys=True))
        log.info(
            "Wrote %s (%d champs, %d subjects with matchups, %d source patches)",
            out_path,
            len(out["tierlist"]),
            len(out["matchups"]),
            len(out["source_patches"]),
        )


if __name__ == "__main__":
    import argparse

    p = argparse.ArgumentParser(description="Aggregate snapshots into data/weighted/{lane}.json")
    p.add_argument("--lane", default="all", help="One of top/jungle/middle/bottom/support, or 'all'.")
    args = p.parse_args()
    if args.lane == "all":
        run()
    else:
        run([args.lane])
