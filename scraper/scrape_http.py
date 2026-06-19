"""
Plain-HTTP scrape driver — an alternative transport to scrape.py's Playwright
client. lolalytics's q-data.json endpoints serve fine to a normal HTTP client
with a browser User-Agent as long as you pace requests politely; Cloudflare
only challenges aggressive bursts. This driver is what the maintainer runs
locally; the weekly CI job can use either transport (see scraper/README.md).

It produces exactly the same snapshot / registry / champions files as
scrape.py (see docs/DATA_FORMAT.md) and reuses qwik_parser for parsing.

Usage:
    python scraper/scrape_http.py --lane all --min-pr 0.5
    python scraper/aggregate.py        # then rebuild data/weighted/
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from qwik_parser import parse_build_matchups, parse_tierlist  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = REPO_ROOT / "data"
SNAP_DIR = DATA_DIR / "snapshots"
CACHE_DIR = Path("/tmp/lolcache")  # raw-response cache so re-runs are instant/resumable

LANES = ["top", "jungle", "middle", "bottom", "support"]
SCHEMA_VERSION = 1
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
REQUEST_DELAY_S = 0.8
MAX_RETRIES = 4

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s")
log = logging.getLogger("scrape_http")


def now_utc_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _cache_path(key: str) -> Path:
    return CACHE_DIR / f"{key}.json"


def fetch_json(url: str, cache_key: str, patch: str) -> dict | None:
    """Fetch a q-data.json with browser UA, polite pacing, and Cloudflare backoff.
    Caches raw responses under /tmp so re-runs don't refetch."""
    cp = _cache_path(f"{patch}__{cache_key}")
    if cp.exists():
        try:
            return json.loads(cp.read_text())
        except Exception:
            pass

    backoff = 5
    for attempt in range(1, MAX_RETRIES + 1):
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                body = resp.read().decode("utf-8")
            if body.lstrip().startswith("{"):
                CACHE_DIR.mkdir(parents=True, exist_ok=True)
                cp.write_text(body)
                time.sleep(REQUEST_DELAY_S)
                return json.loads(body)
            raise ValueError("non-JSON body (Cloudflare challenge?)")
        except Exception as e:  # noqa: BLE001
            code = getattr(e, "code", None)
            log.warning("fetch %s attempt %d/%d failed: %s (HTTP %s)", cache_key, attempt, MAX_RETRIES, e, code)
            if attempt < MAX_RETRIES:
                time.sleep(backoff)
                backoff *= 2
    log.error("giving up on %s after %d attempts", url, MAX_RETRIES)
    return None


def tierlist_url(lane: str, patch: str) -> str:
    return f"https://lolalytics.com/lol/tierlist/q-data.json?lane={lane}&patch={patch}"


def build_url(slug: str, lane: str, patch: str) -> str:
    return f"https://lolalytics.com/lol/{slug}/build/q-data.json?lane={lane}&patch={patch}"


def detect_patch() -> str:
    """The current patch label is the first _objs entry of any tierlist."""
    url = tierlist_url("top", "30")
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        blob = json.loads(resp.read().decode("utf-8"))
    objs = blob.get("_objs", [])
    if objs and isinstance(objs[0], str):
        return objs[0]
    raise RuntimeError("could not detect current patch from tierlist response")


def scrape_lane(lane: str, patch: str, min_pr: float, champ_accum: dict) -> dict:
    log.info("=== lane %s (patch %s) ===", lane, patch)
    blob = fetch_json(tierlist_url(lane, patch), f"tier_{lane}", patch)
    if blob is None:
        raise RuntimeError(f"failed to fetch tierlist for {lane}")
    parsed = parse_tierlist(blob)

    # Accumulate the full champion registry from this lane's meta.
    for slug, rid, name in zip(parsed["champ_path"], parsed["champ_ids"], parsed["champ_names"]):
        if rid and slug:
            champ_accum[rid] = {"slug": slug, "name": name or slug}

    # PR-filtered tierlist → these are the real lane champions and the counter set.
    tierlist: dict[str, dict] = {}
    fetch_order: list[tuple[str, str]] = []  # (slug, rid)
    for slug, rid, row in zip(parsed["champ_path"], parsed["champ_ids"], parsed["tierlist"]):
        pr = row.get("pr")
        if not rid or pr is None or pr < min_pr:
            continue
        tierlist[rid] = {
            "pr": round(float(pr), 4),
            "wr": round(float(row.get("wr") or 0.0), 4),
            "rank": int(row.get("rank") or 0),
            "tier": int(row.get("tier") or 0),
            "games": int(row.get("games") or 0),
        }
        fetch_order.append((slug, rid))

    lane_riot_ids = set(tierlist.keys())
    log.info("%s: %d champions with pr >= %.2f%%", lane, len(fetch_order), min_pr)

    matchups: dict[str, dict] = {}
    for idx, (slug, rid) in enumerate(fetch_order, 1):
        blob_b = fetch_json(build_url(slug, lane, patch), f"build_{lane}_{slug}", patch)
        if blob_b is None:
            log.warning("  [%d/%d] %s: no build data, skipping", idx, len(fetch_order), slug)
            continue
        mu_list = parse_build_matchups(blob_b, lane_riot_ids)
        reduced: dict[str, dict] = {}
        for m in mu_list:
            opp = m["riot_id"]
            if opp not in lane_riot_ids or opp == rid:
                continue
            d2 = m.get("d2")
            games = m.get("games")
            if d2 is None or games is None or games <= 0:
                continue
            reduced[opp] = {"d2": round(float(d2), 4), "games": int(games)}
        matchups[rid] = reduced
        if idx % 10 == 0 or idx == len(fetch_order):
            log.info("  [%d/%d] %s: %d matchups", idx, len(fetch_order), slug, len(reduced))

    snapshot = {
        "schema_version": SCHEMA_VERSION,
        "patch": patch,
        "lane": lane,
        "scraped_at": now_utc_iso(),
        "tierlist": tierlist,
        "matchups": matchups,
    }
    out_path = SNAP_DIR / patch / f"{lane}.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(snapshot, indent=2, sort_keys=True))
    log.info("wrote %s (%d champs, %d matchup subjects)", out_path, len(tierlist), len(matchups))
    return snapshot


def write_registry(patch: str) -> None:
    reg_path = DATA_DIR / "patches.json"
    reg = {"schema_version": SCHEMA_VERSION, "current_patch": patch, "patches": []}
    if reg_path.exists():
        try:
            reg = json.loads(reg_path.read_text())
        except Exception:
            pass
    reg["current_patch"] = patch
    patches = reg.get("patches", [])
    # Upsert current patch at k_back 0; bump everyone else. A new patch rolling
    # out freezes the previous one (it's no longer re-scraped), so mark all
    # non-current patches is_final — aggregate weights purely on k_back, so this
    # flag is informational, but keeps the registry honest.
    existing = {p["patch"]: p for p in patches}
    if patch not in existing:
        for p in patches:
            p["k_back"] = p.get("k_back", 0) + 1
            p["is_final"] = True
        patches.insert(0, {"patch": patch, "scraped_at": now_utc_iso(), "is_final": False, "k_back": 0})
    else:
        existing[patch]["scraped_at"] = now_utc_iso()
        existing[patch]["k_back"] = 0
    # Re-sort by k_back, drop >= 20.
    patches = [p for p in patches if p.get("k_back", 0) < 20]
    patches.sort(key=lambda p: p.get("k_back", 0))
    reg["patches"] = patches
    reg_path.write_text(json.dumps(reg, indent=2))
    log.info("wrote %s (current_patch=%s, %d patches)", reg_path, patch, len(patches))


def _patch_sort_key(label: str):
    """Sort patches newest-first: (major, minor) descending. '16.10' > '16.9'."""
    try:
        parts = [int(x) for x in str(label).split(".")]
        return parts
    except ValueError:
        return [0]


def rebuild_registry() -> None:
    """Rebuild data/patches.json from every snapshot directory present, ordering
    patches by version so k_back is correct (newest = 0). Used after backfilling
    historical patches. scraped_at is taken from each snapshot; is_final is set on
    every non-current patch. Patches with k_back >= 20 are dropped."""
    reg_path = DATA_DIR / "patches.json"
    if not SNAP_DIR.exists():
        log.error("no snapshots dir at %s", SNAP_DIR); return
    labels = sorted(
        (d.name for d in SNAP_DIR.iterdir() if d.is_dir()),
        key=_patch_sort_key, reverse=True,
    )
    patches = []
    for k, label in enumerate(labels):
        if k >= 20:
            break
        # scraped_at from any lane snapshot for this patch.
        scraped_at = now_utc_iso()
        for lane in LANES:
            sp = SNAP_DIR / label / f"{lane}.json"
            if sp.exists():
                try:
                    scraped_at = json.loads(sp.read_text()).get("scraped_at") or scraped_at
                    break
                except Exception:
                    pass
        patches.append({"patch": label, "scraped_at": scraped_at, "is_final": k != 0, "k_back": k})
    reg = {"schema_version": SCHEMA_VERSION, "current_patch": patches[0]["patch"] if patches else None, "patches": patches}
    reg_path.write_text(json.dumps(reg, indent=2))
    log.info("rebuilt %s (current=%s, %d patches: %s)", reg_path, reg["current_patch"], len(patches),
             ", ".join(f"{p['patch']}(k{p['k_back']})" for p in patches))


def write_champions(champ_accum: dict) -> None:
    # Merge into any existing champions.json so backfilling an OLD patch (with a
    # smaller roster) never drops champions that only newer patches have.
    out_path = DATA_DIR / "champions.json"
    by_riot_id = {}
    by_slug = {}
    if out_path.exists():
        try:
            prev = json.loads(out_path.read_text())
            by_riot_id = dict(prev.get("by_riot_id", {}))
            by_slug = dict(prev.get("by_slug", {}))
        except Exception:
            pass
    for rid, meta in champ_accum.items():
        by_riot_id[rid] = {"slug": meta["slug"], "name": meta["name"]}
        by_slug[meta["slug"]] = {"riot_id": int(rid), "name": meta["name"]}
    out = {"schema_version": SCHEMA_VERSION, "by_riot_id": by_riot_id, "by_slug": by_slug}
    out_path.write_text(json.dumps(out, indent=2, sort_keys=True))
    log.info("champions.json now has %d champions", len(by_riot_id))


def main() -> None:
    ap = argparse.ArgumentParser(description="Plain-HTTP lolalytics scrape driver")
    ap.add_argument("--lane", default="all", help="top/jungle/middle/bottom/support or 'all'")
    ap.add_argument("--min-pr", type=float, default=0.5, help="min lane pick-rate %% to include")
    ap.add_argument("--patch", default=None, help="override patch label (default: auto-detect current)")
    ap.add_argument("--skip-registry", action="store_true",
                    help="don't touch patches.json (use when backfilling a historical patch)")
    ap.add_argument("--rebuild-registry", action="store_true",
                    help="rebuild patches.json from all snapshot dirs and exit (no scraping)")
    args = ap.parse_args()

    if args.rebuild_registry:
        rebuild_registry()
        return

    patch = args.patch or detect_patch()
    log.info("scraping patch: %s", patch)
    lanes = LANES if args.lane == "all" else [args.lane]

    champ_accum: dict = {}
    for lane in lanes:
        scrape_lane(lane, patch, args.min_pr, champ_accum)

    write_champions(champ_accum)
    if args.skip_registry:
        log.info("skipped registry write (--skip-registry)")
    else:
        write_registry(patch)
    log.info("done.")


if __name__ == "__main__":
    main()
