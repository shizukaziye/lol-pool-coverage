# data/

The weekly scraper workflow fills this directory. Until then, it's empty
and the webapp falls back to its test fixture (see `webapp/app.js`).

- `data/patches.json` — patch registry maintained by `scraper/scrape.py`
- `data/champions.json` — champion riot_id ↔ slug ↔ display name registry
- `data/snapshots/{patch}/{lane}.json` — raw per-patch tier list + matchup tables
- `data/weighted/{lane}.json` — aggregated weighted view consumed by the webapp

See `docs/DATA_FORMAT.md` for the JSON contract.
