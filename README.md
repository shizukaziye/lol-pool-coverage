# lol-pool-coverage

Webapp to analyze League of Legends champion pool coverage against the current meta. Pick a lane, list the champs you play, and see:

- Which matchups your pool struggles against
- Which candidates would most improve your coverage if added
- Which pool member is safest to cut
- Which member is the safest blind pick
- How often each champion would actually get used (split between blind picks and counter-picks)

Data comes from lolalytics, scraped weekly. The current and previous 19 patches are kept and weighted by `0.9^k` where `k` is patches-since-current.

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
- [ ] CI/CD configured
- [ ] First real data snapshot committed
- [ ] Pages deployed

## Local dev

Once everything is wired up:

```sh
# Refresh data
cd scraper && python scrape.py --patch current --lane all
python aggregate.py        # rebuilds data/weighted/

# Serve frontend
cd webapp && python -m http.server 8000
# open http://localhost:8000
```

## License

MIT (see LICENSE)
