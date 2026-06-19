"""
Lolalytics scraper — CLI entrypoint.

Commands:
  snapshot         Fetch tier list + matchups for (patch, lane[s]) and write
                   data/snapshots/{patch}/{lane}.json
  promote-finals   Reconcile data/patches.json with the current live patch:
                   - if live patch differs from current_patch, freeze the old one
                     (is_final = true) and bump k_back for all known patches
                   - drop any patches with k_back >= 20

Resumable: each (patch, lane) snapshot is a single JSON file. Within a snapshot,
champion-level fetches are checkpointed in `.in-progress.json` next to the final
file so a crash mid-scrape only loses the in-flight champion. On rerun, already-
fetched champions are skipped.

Politeness: 0.5–1.0s jittered sleep between requests; exponential backoff on 429.
"""

from __future__ import annotations

import asyncio
import json
import logging
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import click

from lolalytics_client import LolalyticsClient, build_html_url, build_url, tierlist_url
from qwik_parser import parse_build_matchups, parse_tierlist

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = REPO_ROOT / "data"
SNAP_DIR = DATA_DIR / "snapshots"
CHAMPIONS_FILE = DATA_DIR / "champions.json"
PATCHES_FILE = DATA_DIR / "patches.json"

LANES = ["top", "jungle", "middle", "bottom", "support"]
SCHEMA_VERSION = 1

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("scrape")


def now_utc_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def patch_param_for(patch: str) -> str:
    """Lolalytics URL convention: '14' means 14-day rolling (live current),
    otherwise the patch string verbatim."""
    return "14" if patch == "current" else patch


def snapshot_path(patch_label: str, lane: str) -> Path:
    return SNAP_DIR / patch_label / f"{lane}.json"


def in_progress_path(patch_label: str, lane: str) -> Path:
    return SNAP_DIR / patch_label / f".{lane}.in-progress.json"


def load_json(p: Path) -> Optional[dict]:
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text())
    except Exception as e:
        log.warning("Failed to load %s: %s", p, e)
        return None


def write_json_atomic(p: Path, obj: dict) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, indent=2, sort_keys=True))
    tmp.replace(p)


# ---------- Champion registry (mirrors update_champions.py) ----------


def update_champions_registry(parsed_tierlist: dict) -> None:
    """Merge new champions from a parsed tier list into data/champions.json."""
    cp = parsed_tierlist["champ_path"]
    cid = parsed_tierlist["champ_ids"]
    cn = parsed_tierlist["champ_names"]
    n = min(len(cp), len(cid), len(cn))

    existing = load_json(CHAMPIONS_FILE) or {
        "schema_version": SCHEMA_VERSION,
        "by_riot_id": {},
        "by_slug": {},
    }
    by_rid = existing.get("by_riot_id", {})
    by_slug = existing.get("by_slug", {})

    changed = False
    for i in range(n):
        slug, rid, name = cp[i], cid[i], cn[i]
        if not slug or not rid:
            continue
        try:
            rid_int = int(rid)
        except ValueError:
            continue
        rid_key = str(rid_int)
        if rid_key not in by_rid or by_rid[rid_key].get("slug") != slug:
            by_rid[rid_key] = {"slug": slug, "name": name}
            changed = True
        if slug not in by_slug or by_slug[slug].get("riot_id") != rid_int:
            by_slug[slug] = {"riot_id": rid_int, "name": name}
            changed = True

    if changed:
        out = {
            "schema_version": SCHEMA_VERSION,
            "by_riot_id": by_rid,
            "by_slug": by_slug,
        }
        write_json_atomic(CHAMPIONS_FILE, out)
        log.info("Updated %s (%d champions known)", CHAMPIONS_FILE, len(by_rid))


# ---------- Snapshot scrape ----------


async def fetch_tierlist(client: LolalyticsClient, lane: str, patch_param: str) -> dict:
    url = tierlist_url(lane, patch_param)
    log.info("GET %s", url)
    blob = await client.fetch_json(url)
    return parse_tierlist(blob)


async def fetch_matchups_for(
    client: LolalyticsClient,
    slug: str,
    lane: str,
    patch_param: str,
    lane_riot_ids: set[str],
) -> list[dict]:
    url = build_url(slug, lane, patch_param)
    referer = build_html_url(slug, lane, patch_param)
    log.info("GET %s", url)
    blob = await client.fetch_json(url, referer_html=referer)
    return parse_build_matchups(blob, lane_riot_ids)


async def scrape_lane(
    client: LolalyticsClient,
    patch: str,
    patch_label: str,
    lane: str,
    min_pr: float,
) -> None:
    """Fetch a (patch, lane) snapshot. Resumable via in-progress file."""
    patch_param = patch_param_for(patch)
    out_path = snapshot_path(patch_label, lane)
    ip_path = in_progress_path(patch_label, lane)

    if out_path.exists():
        log.info("Snapshot already exists: %s — skipping (delete to refetch)", out_path)
        return

    # Resume from in-progress if any.
    progress = load_json(ip_path) or {}
    tierlist_meta = progress.get("tierlist_meta")
    tierlist = progress.get("tierlist")  # riot_id -> {pr,wr,...}
    matchups = progress.get("matchups", {})  # subject_rid -> { opp_rid -> {d2,games} }
    pending_slugs: list[tuple[str, str]] = []  # (slug, riot_id)

    if tierlist is None:
        parsed = await fetch_tierlist(client, lane, patch_param)
        update_champions_registry(parsed)

        # Build the lane tierlist dict — keyed by riot_id.
        tierlist = {}
        slug_by_rid: dict[str, str] = {}
        n = min(len(parsed["champ_path"]), len(parsed["champ_ids"]), len(parsed["tierlist"]))
        for i in range(n):
            rid = parsed["champ_ids"][i]
            slug = parsed["champ_path"][i]
            row = parsed["tierlist"][i]
            pr = row.get("pr")
            if pr is None or pr < min_pr:
                continue
            try:
                rid_key = str(int(rid))
            except ValueError:
                continue
            tierlist[rid_key] = {
                "pr": round(float(pr), 4),
                "wr": round(float(row.get("wr") or 0.0), 4),
                "rank": int(row.get("rank") or 0),
                "tier": int(row.get("tier") or 0),
                "games": int(row.get("games") or 0),
            }
            slug_by_rid[rid_key] = slug

        tierlist_meta = {"slug_by_rid": slug_by_rid}
        progress = {
            "tierlist_meta": tierlist_meta,
            "tierlist": tierlist,
            "matchups": {},
        }
        write_json_atomic(ip_path, progress)
    else:
        slug_by_rid = tierlist_meta["slug_by_rid"]
        log.info(
            "Resuming %s/%s: %d champs in tierlist, %d matchups done",
            patch_label,
            lane,
            len(tierlist),
            len(matchups),
        )

    lane_riot_ids = set(tierlist.keys())
    pending_slugs = [(slug_by_rid[rid], rid) for rid in tierlist if rid not in matchups]

    log.info(
        "Snapshot %s/%s: %d champs in tier list, %d matchups to fetch",
        patch_label,
        lane,
        len(tierlist),
        len(pending_slugs),
    )

    for slug, rid in pending_slugs:
        try:
            mu_list = await fetch_matchups_for(client, slug, lane, patch_param, lane_riot_ids)
        except Exception as e:
            log.error("Failed matchups for %s (%s): %s — skipping", slug, rid, e)
            continue

        # Reduce to {opp_rid: {d2, games}}, keep only opponents in this lane's tier list.
        reduced: dict[str, dict] = {}
        for m in mu_list:
            opp = m["riot_id"]
            if opp not in lane_riot_ids:
                continue
            if opp == rid:
                continue
            d2 = m.get("d2")
            if d2 is None:
                continue
            reduced[opp] = {
                "d2": round(float(d2), 4),
                "games": int(m["games"]),
            }
        matchups[rid] = reduced

        # Checkpoint after every champion.
        progress["matchups"] = matchups
        write_json_atomic(ip_path, progress)

    # Finalize.
    snapshot = {
        "schema_version": SCHEMA_VERSION,
        "patch": patch_label,
        "lane": lane,
        "scraped_at": now_utc_iso(),
        "tierlist": tierlist,
        "matchups": matchups,
    }
    write_json_atomic(out_path, snapshot)
    try:
        ip_path.unlink()
    except FileNotFoundError:
        pass
    log.info("Wrote %s", out_path)


# ---------- patches.json helpers ----------


def load_patches_registry() -> dict:
    return load_json(PATCHES_FILE) or {
        "schema_version": SCHEMA_VERSION,
        "current_patch": None,
        "patches": [],
    }


def upsert_patch(reg: dict, patch_label: str, is_final: bool) -> None:
    plist = reg.get("patches", [])
    for entry in plist:
        if entry["patch"] == patch_label:
            entry["scraped_at"] = now_utc_iso()
            entry["is_final"] = is_final
            return
    plist.append(
        {
            "patch": patch_label,
            "scraped_at": now_utc_iso(),
            "is_final": is_final,
            "k_back": 0,
        }
    )
    reg["patches"] = plist


def renormalize_k_back(reg: dict) -> None:
    """Recompute k_back as index in newest-first order; drop k_back >= 20."""
    plist = reg.get("patches", [])
    # Newest-first: non-final (live current) first, then sort finals by patch desc.
    def sort_key(e):
        # parse patch like "15.11" to (15, 11) for ordering
        try:
            major, minor = e["patch"].split(".")
            return (int(major), int(minor))
        except Exception:
            return (0, 0)

    plist.sort(key=sort_key, reverse=True)
    keep = []
    for i, e in enumerate(plist):
        e["k_back"] = i
        if i < 20:
            keep.append(e)
    reg["patches"] = keep


# ---------- Live-patch detection ----------


async def detect_current_patch(client: LolalyticsClient) -> Optional[str]:
    """Fetch the 14-day rolling tier list and read the live patch string from
    meta. Lolalytics' meta dict carries a 'patch' or similar field; we fall back
    to scanning short version-like strings in _objs if not present."""
    blob = await client.fetch_json(tierlist_url("middle", "14"))
    objs = blob["_objs"]
    from qwik_parser import make_deref

    deref = make_deref(objs)

    # Look for the meta dict.
    for entry in objs:
        if isinstance(entry, dict) and "champPath" in entry:
            for k in ("patch", "currentPatch", "patchVersion"):
                if k in entry:
                    val = entry[k]
                    s = val if isinstance(val, str) else deref(val)
                    if isinstance(s, str) and "." in s:
                        return s

    # Fallback: scan for short version-like strings.
    import re

    pat = re.compile(r"^\d{1,2}\.\d{1,2}$")
    for s in objs:
        if isinstance(s, str) and pat.match(s):
            return s
    return None


# ---------- CLI ----------


@click.group()
def cli():
    """Lolalytics scraper CLI."""


@cli.command()
@click.option("--patch", required=True, help="Patch like '15.11' or 'current' for live (uses ?patch=14).")
@click.option("--lane", default="all", help="One of top/jungle/middle/bottom/support, or 'all'.")
@click.option("--min-pr", default=0.5, type=float, show_default=True, help="Min PR (percent) to include a champion.")
@click.option("--headed", is_flag=True, help="Run browser headed (for debugging Cloudflare).")
def snapshot(patch: str, lane: str, min_pr: float, headed: bool):
    """Scrape tier list + matchups for the given patch and lane(s)."""
    lanes = LANES if lane == "all" else [lane]
    for ln in lanes:
        if ln not in LANES:
            click.echo(f"Unknown lane: {ln}", err=True)
            sys.exit(2)

    async def run():
        async with LolalyticsClient(headless=not headed) as client:
            # Resolve the patch label we store on disk.
            if patch == "current":
                live = await detect_current_patch(client)
                if live is None:
                    log.warning("Could not auto-detect current patch — using label 'current'")
                    patch_label = "current"
                else:
                    patch_label = live
                    log.info("Live patch detected: %s", live)
            else:
                patch_label = patch

            for ln in lanes:
                await scrape_lane(client, patch=patch, patch_label=patch_label, lane=ln, min_pr=min_pr)

            # Register the patch.
            reg = load_patches_registry()
            is_final = patch != "current"
            upsert_patch(reg, patch_label, is_final=is_final)
            if patch == "current":
                reg["current_patch"] = patch_label
            renormalize_k_back(reg)
            write_json_atomic(PATCHES_FILE, reg)

    asyncio.run(run())


@cli.command(name="promote-finals")
@click.option("--headed", is_flag=True)
def promote_finals(headed: bool):
    """Freeze last cycle's current patch as final if lolalytics has rolled to a new one."""

    async def run():
        async with LolalyticsClient(headless=not headed) as client:
            live = await detect_current_patch(client)
            if live is None:
                log.error("Could not detect live patch.")
                sys.exit(1)
            log.info("Live patch: %s", live)

        reg = load_patches_registry()
        old_current = reg.get("current_patch")
        if old_current and old_current != live:
            log.info("Promoting %s to final (live patch is now %s)", old_current, live)
            for entry in reg.get("patches", []):
                if entry["patch"] == old_current:
                    entry["is_final"] = True
                    break
        reg["current_patch"] = live
        renormalize_k_back(reg)
        write_json_atomic(PATCHES_FILE, reg)
        log.info("patches.json updated")

    asyncio.run(run())


if __name__ == "__main__":
    cli()
