"""
Refresh data/champions.json from a lolalytics tier list response.

Standalone CLI in case we want to rebuild the registry without doing a full
snapshot pass. The same logic is also called inline by scrape.py whenever a tier
list is fetched (so a normal `snapshot` already keeps the registry fresh).
"""

from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path

import click

from lolalytics_client import LolalyticsClient, tierlist_url
from qwik_parser import parse_tierlist

REPO_ROOT = Path(__file__).resolve().parent.parent
CHAMPIONS_FILE = REPO_ROOT / "data" / "champions.json"

SCHEMA_VERSION = 1
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("update_champions")


def merge_parsed_into_registry(parsed: dict) -> dict:
    cp = parsed["champ_path"]
    cid = parsed["champ_ids"]
    cn = parsed["champ_names"]
    n = min(len(cp), len(cid), len(cn))

    existing = {"schema_version": SCHEMA_VERSION, "by_riot_id": {}, "by_slug": {}}
    if CHAMPIONS_FILE.exists():
        try:
            existing = json.loads(CHAMPIONS_FILE.read_text())
        except Exception as e:
            log.warning("Failed to read existing %s: %s", CHAMPIONS_FILE, e)

    by_rid = existing.get("by_riot_id", {})
    by_slug = existing.get("by_slug", {})

    for i in range(n):
        slug, rid, name = cp[i], cid[i], cn[i]
        if not slug or not rid:
            continue
        try:
            rid_int = int(rid)
        except ValueError:
            continue
        rid_key = str(rid_int)
        by_rid[rid_key] = {"slug": slug, "name": name}
        by_slug[slug] = {"riot_id": rid_int, "name": name}

    return {
        "schema_version": SCHEMA_VERSION,
        "by_riot_id": by_rid,
        "by_slug": by_slug,
    }


@click.command()
@click.option("--lane", default="middle", help="Lane to pull the tier list from (just for fetching meta).")
@click.option("--patch", default="current", help="Patch ('current' for the 14-day rolling window).")
def main(lane: str, patch: str):
    """Fetch a tier list, parse champion metadata, write data/champions.json."""

    async def run():
        async with LolalyticsClient() as client:
            patch_param = "14" if patch == "current" else patch
            url = tierlist_url(lane, patch_param)
            log.info("GET %s", url)
            blob = await client.fetch_json(url)
            parsed = parse_tierlist(blob)
            out = merge_parsed_into_registry(parsed)
            CHAMPIONS_FILE.parent.mkdir(parents=True, exist_ok=True)
            CHAMPIONS_FILE.write_text(json.dumps(out, indent=2, sort_keys=True))
            log.info("Wrote %s (%d champions)", CHAMPIONS_FILE, len(out["by_riot_id"]))

    asyncio.run(run())


if __name__ == "__main__":
    main()
