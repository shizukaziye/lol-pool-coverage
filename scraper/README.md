# scraper

Python tooling that pulls champion tier-list and matchup data from
[lolalytics.com](https://lolalytics.com) for all 5 lanes across the last 20
patches and aggregates it into the weighted view the webapp consumes.

Outputs land under `../data/` and conform to `../docs/DATA_FORMAT.md`.

## Setup

```sh
cd scraper
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python -m playwright install chromium
```

## Commands

### Scrape a snapshot

```sh
# Live current patch (uses lolalytics' 14-day rolling window: ?patch=14)
python scrape.py snapshot --patch current --lane all

# A specific historical patch (frozen)
python scrape.py snapshot --patch 15.10 --lane all

# Single lane
python scrape.py snapshot --patch current --lane top

# Lower / raise the PR cutoff (default 0.5%)
python scrape.py snapshot --patch current --lane all --min-pr 1.0

# Headed mode (watch the browser solve Cloudflare — for debugging)
python scrape.py snapshot --patch current --lane top --headed
```

Writes `../data/snapshots/{patch}/{lane}.json` and updates
`../data/champions.json` and `../data/patches.json`. When `--patch current` is
used, the actual live patch string is auto-detected from lolalytics' tier list
metadata and used as the on-disk label (e.g. `data/snapshots/15.11/top.json`).

### Roll the patch registry forward

```sh
python scrape.py promote-finals
```

Checks lolalytics' live patch. If it differs from `data/patches.json`'s
`current_patch`, marks the old current as `is_final: true`, recomputes every
patch's `k_back`, and drops anything that has rolled past `k_back >= 20`.

Run this once at the start of each weekly job, before the snapshot pass.

### Rebuild the weighted aggregate

```sh
python aggregate.py            # all 5 lanes
python aggregate.py --lane top # just one
```

Writes `../data/weighted/{lane}.json` — the only data files the webapp loads.

### Refresh champion metadata standalone

```sh
python update_champions.py
```

Normally a no-op because `scrape.py snapshot` updates `data/champions.json`
inline whenever it fetches a tier list. This standalone CLI exists for
out-of-band refreshes (e.g. a new champion ships mid-patch and you don't want to
re-scrape everything).

## Resumability

Each `(patch, lane)` snapshot is checkpointed to a hidden in-progress file
(`data/snapshots/{patch}/.{lane}.in-progress.json`) after every champion. A
crashed or killed run can be restarted with the same command and will skip the
champions already fetched. The in-progress file is deleted once the final
snapshot is written.

If a snapshot file already exists, the snapshot is skipped (delete it to force a
re-fetch).

## Cloudflare bypass

Lolalytics is fronted by Cloudflare Turnstile. Plain `curl` and `requests` get
403'd. The scraper works around this by:

1. Launching headless Chromium via Playwright with `playwright-stealth` applied
   to defeat the obvious headless fingerprinting.
2. Warming up against `https://lolalytics.com/lol/` (a normal HTML page) so the
   Turnstile challenge runs and drops a `cf_clearance` cookie.
3. Saving the resulting storage state (cookies, localStorage) to
   `scraper/.cf-cookies.json` and reloading it on every subsequent run, so the
   challenge only solves once per `cf_clearance` lifetime.
4. Fetching each `q-data.json` endpoint via `page.evaluate(fetch(...))` so the
   request carries the page's origin and cookies. For champion-build endpoints
   we also navigate to the corresponding HTML page first as a referer; that
   page's full load gives Turnstile another chance to refresh the cookie if
   needed.
5. On 403, re-running the warmup and retrying with exponential backoff. On 429,
   backing off exponentially without re-warmup.

`.cf-cookies.json` is gitignored — it's session-scoped.

If a future Cloudflare update breaks `playwright-stealth`, the next fallback is
to run headed (or in `headless="new"` mode with a real X server / xvfb in CI)
and let the user solve a Turnstile challenge once per cookie lifetime.

## Politeness

- 0.5–1.0s jittered sleep between requests (configurable on `LolalyticsClient`).
- Exponential backoff on 429.
- A full weekly snapshot (all 5 lanes, ~50 champs/lane = ~250 fetches) takes
  roughly 5–10 minutes end-to-end with these defaults.

## Tests

```sh
pytest tests/
```

`tests/test_aggregate.py` validates the weighted-aggregation formula against a
hand-computed fixture under `tests/fixtures/`. The fixture is the canonical
agreement point with the webapp's JS scoring tests — both sides run against the
same numbers (see `docs/SCORING.md`).

## CI integration

A weekly GitHub Actions workflow (in `../.github/`) will run, in order:

```sh
python scrape.py promote-finals
python scrape.py snapshot --patch current --lane all
python aggregate.py
```

then commit the regenerated `data/` directory.
