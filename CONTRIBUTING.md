# Contributing

This repo is split into three independent areas, each owned by a separate
subagent (or maintainer) and developed in parallel. The contracts between
them are versioned files in `docs/`.

## Areas

- **`scraper/`** — Python + Playwright. Fetches lolalytics data, writes
  `data/snapshots/{patch}/{lane}.json`, and rebuilds
  `data/weighted/{lane}.json`. Owns the CLI invoked by the weekly workflow.
- **`webapp/`** — Static HTML/CSS/JS. Reads only `data/weighted/{lane}.json`
  and `data/champions.json`. No build step.
- **`.github/`** — CI/CD. Weekly cron refresh (`scrape.yml`) and Pages
  deploy (`deploy.yml`). Plus the root `LICENSE`, `README.md`, this file,
  and the root `index.html` redirect.

## Contracts

Before changing anything that crosses an area boundary, read:

- [`docs/DATA_FORMAT.md`](docs/DATA_FORMAT.md) — JSON shape produced by the
  scraper and consumed by the webapp. Both sides must conform.
- [`docs/SCORING.md`](docs/SCORING.md) — analysis formulas. Must be
  implemented identically in `webapp/app.js` and (for tests) in Python.

Schema-breaking changes bump `schema_version` in the affected file and
require coordinated PRs across the touched areas.

## Workflows

- `scrape.yml` runs Mondays at 08:00 UTC and on manual dispatch. It calls
  the scraper CLI; if you rename a command, update the workflow.
- `deploy.yml` runs on pushes that touch `webapp/**`, `data/**`, or the
  workflow itself. It stages `webapp/` and `data/` as siblings under the
  Pages root, with a redirect at `/`.

## Local dev

See the **Development** section of the top-level [`README.md`](README.md).
