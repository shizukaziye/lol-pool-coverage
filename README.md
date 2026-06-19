# lol-pool-coverage

[![scrape](https://github.com/Shizukaziye/lol-pool-coverage/actions/workflows/scrape.yml/badge.svg)](https://github.com/Shizukaziye/lol-pool-coverage/actions/workflows/scrape.yml)
[![deploy](https://github.com/Shizukaziye/lol-pool-coverage/actions/workflows/deploy.yml/badge.svg)](https://github.com/Shizukaziye/lol-pool-coverage/actions/workflows/deploy.yml)
[![last data refresh](https://img.shields.io/github/last-commit/Shizukaziye/lol-pool-coverage/main?path=data&label=last%20data%20refresh)](https://github.com/Shizukaziye/lol-pool-coverage/commits/main/data)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

<!-- TODO: replace badge owner/repo once the actual GitHub repo slug is known. -->

Webapp to analyze League of Legends champion pool coverage against the current meta. Pick a lane, list the champs you play, and see:

- Which matchups your pool struggles against
- Which candidates would most improve your coverage if added
- Which pool member is safest to cut
- Which member is the safest blind pick
- How often each champion would actually get used (split between blind picks and counter-picks)

Data comes from lolalytics, scraped weekly. The current and previous 19 patches are kept and weighted by `0.9^k` where `k` is patches-since-current.

<!-- TODO: add docs/screenshot.png once the webapp ships. -->
![screenshot](docs/screenshot.png)

## Quick start

Use the deployed site — no install needed:

<!-- TODO: replace with the real Pages URL once the repo is published. -->
**[https://shizukaziye.github.io/lol-pool-coverage/](https://shizukaziye.github.io/lol-pool-coverage/)**

The root URL redirects to `/webapp/`, where you pick a lane, type your champion pool, mark mains, and read the four analysis panels. Data refreshes automatically every Monday — no action required.

## Layout

```
scraper/  — Python scraper (Playwright) and aggregation job. See scraper/README.md.
webapp/   — Static HTML/CSS/JS frontend. See webapp/README.md.
data/     — Patch snapshots and the weighted aggregate the frontend reads.
            See docs/DATA_FORMAT.md for the JSON contract.
docs/     — DATA_FORMAT.md and SCORING.md — the shared contracts between
            scraper and webapp. Both implementations must agree.
.github/  — Weekly scrape workflow and GitHub Pages deployment.
```

## Status

- [x] Data contract defined (`docs/DATA_FORMAT.md`)
- [x] Scoring contract defined (`docs/SCORING.md`)
- [ ] Scraper implemented
- [ ] Webapp implemented
- [x] CI/CD configured
- [ ] First real data snapshot committed
- [ ] Pages deployed

## Development

Clone and set up a Python environment for the scraper:

```sh
git clone https://github.com/Shizukaziye/lol-pool-coverage.git
cd lol-pool-coverage

python3.11 -m venv .venv
source .venv/bin/activate
pip install -r scraper/requirements.txt
python -m playwright install chromium
```

Run the scraper locally (mirrors what the weekly workflow does):

```sh
# Promote the previous patch to is_final if a new patch rolled out.
python scraper/scrape.py promote-finals

# Fetch the current patch for every lane.
python scraper/scrape.py snapshot --patch current --lane all

# Rebuild data/weighted/{lane}.json from all snapshots.
python scraper/aggregate.py
```

Serve the frontend against your local `data/`:

```sh
# From the repo root so relative fetches (../data/...) resolve correctly.
python -m http.server 8000
# Open http://localhost:8000/webapp/
```

The webapp is plain HTML/CSS/JS — no bundler, no install step.

## Data refresh cadence

Data is refreshed automatically by [`.github/workflows/scrape.yml`](.github/workflows/scrape.yml) on the following schedule:

- **Cron:** Mondays at 08:00 UTC.
- **Manual:** any maintainer can trigger the workflow from the Actions tab.

Each run:

1. Promotes the previous patch's snapshot to `is_final: true` if a new patch has rolled out (it's then frozen and never re-scraped).
2. Scrapes the current patch for all five lanes from lolalytics.
3. Rebuilds the weighted aggregate in `data/weighted/`.
4. Commits the diff under `data/` as `chore: data refresh YYYY-MM-DD` and pushes to `main`.

The aggregator keeps the current and previous 19 patches, weighted as `0.9^k` where `k = 0` is the current patch. That means patch 0 contributes 1.00, patch 5 contributes ~0.59, and patch 19 contributes ~0.14 — a soft fade rather than a hard cutoff. Patches with `k_back >= 20` are dropped.

A data-only push to `main` triggers the [`deploy.yml`](.github/workflows/deploy.yml) workflow, so the public site is usually live within a few minutes of the Monday scrape finishing.

## License

MIT — see [LICENSE](LICENSE).
