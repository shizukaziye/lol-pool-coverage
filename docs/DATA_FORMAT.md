# Data format contract

This document defines the JSON shape that the scraper produces and the webapp consumes. Both sides must conform.

## Directory layout

```
data/
├── patches.json                          # patch registry
├── champions.json                        # static champion metadata (id, slug, display name)
├── snapshots/{patch}/{lane}.json         # one snapshot per (patch, lane) — raw scraped data
└── weighted/{lane}.json                  # aggregated view used by the webapp (regenerated weekly)
```

- `patch` is the lolalytics patch string, e.g. `"15.10"`, `"15.11"`. Stored verbatim.
- `lane` is one of: `top`, `jungle`, `middle`, `bottom`, `support`.

## `data/patches.json`

```json
{
  "schema_version": 1,
  "current_patch": "15.11",
  "patches": [
    { "patch": "15.11", "scraped_at": "2026-06-19T08:00:00Z", "is_final": false, "k_back": 0 },
    { "patch": "15.10", "scraped_at": "2026-06-12T08:00:00Z", "is_final": true,  "k_back": 1 },
    { "patch": "15.9",  "scraped_at": "2026-05-29T08:00:00Z", "is_final": true,  "k_back": 2 }
  ]
}
```

- `is_final`: `false` while the patch is live (gets re-scraped weekly); flipped to `true` when a new patch starts, after which the snapshot is frozen.
- `k_back`: how many patches behind current. 0 = current. Used for the 0.85^k weighting.
- The list is kept sorted by recency (newest first). Patches with `k_back >= 20` are deleted.

## `data/champions.json`

```json
{
  "schema_version": 1,
  "by_riot_id": {
    "266": { "slug": "aatrox", "name": "Aatrox" },
    "103": { "slug": "ahri",   "name": "Ahri"   }
  },
  "by_slug": {
    "aatrox": { "riot_id": 266, "name": "Aatrox" },
    "ahri":   { "riot_id": 103, "name": "Ahri"   }
  }
}
```

Refreshed by the scraper whenever a new champion ships.

## `data/snapshots/{patch}/{lane}.json`

One file per patch + lane. Contains the tier list AND the matchup table for every champion that appears in that lane with PR ≥ threshold (default 0.5%, low to be inclusive).

```json
{
  "schema_version": 1,
  "patch": "15.11",
  "lane": "top",
  "scraped_at": "2026-06-19T08:00:00Z",
  "tierlist": {
    "266": { "pr": 5.95, "wr": 50.91, "rank": 20, "tier": 5, "games": 134567 },
    "86":  { "pr": 7.07, "wr": 52.38, "rank": 15, "tier": 4, "games": 156890 }
  },
  "matchups": {
    "266": {
      "top":    { "86": { "d2": -0.45, "games": 1074 }, "17": { "d2": 2.21, "games": 1584 } },
      "jungle": { "64": { "d2":  0.30, "games": 1402 } },
      "middle": { "103": { "d2": -0.10, "games": 1310 } },
      "bottom": { "235": { "d2": 0.05, "games": 2100 } },
      "support":{ "412": { "d2": -0.22, "games": 1750 } }
    }
  }
}
```

- `schema_version` is `2` for the per-role matchup shape below (v1 was a flat
  `matchups[subject][opponent]` with same-lane data only).
- `tierlist[riot_id]`: champion's lane-level stats. PR is percentage (0–100), WR is percentage, `games` is total games in that lane.
- `matchups[subject_riot_id][enemy_role][opponent_riot_id]`: the subject's Δ2
  against an opponent **in that enemy role**. `enemy_role` is one of
  `top/jungle/middle/bottom/support`. The subject's own lane key holds the
  same-lane matchups (identical to the old v1 data); the other four are
  cross-role (e.g. a top laner's win-rate delta vs each enemy jungler).
  - `d2`: delta2 value from subject's perspective (positive = subject is favored).
  - `games`: sample size of this specific matchup.
- Cross-role opponents are filtered to the PR-qualified champ set of the
  **opponent's** role (that lane snapshot's tierlist keys). Matchups with games
  below the threshold are omitted, not zeroed.

## `data/weighted/{lane}.json`

Aggregated weighted view across the last 20 patches. Regenerated whenever a new snapshot lands. The webapp loads ONLY these files.

```json
{
  "schema_version": 1,
  "lane": "top",
  "generated_at": "2026-06-19T08:30:00Z",
  "source_patches": ["15.11", "15.10", "15.9", "..."],
  "tierlist": {
    "266": { "pr": 5.84, "wr": 51.20, "games_total": 1234567 }
  },
  "matchups": {
    "266": {
      "top":    { "86": { "d2": -0.32, "games_total": 12450 } },
      "jungle": { "64": { "d2":  0.18, "games_total": 30210 } }
    }
  }
}
```

Same nesting as the snapshots: `matchups[subject][enemy_role][opponent]`.

Weighted aggregation formula (applied per `(subject, enemy_role, opponent)`):

```
weight(patch k_back) = 0.85 ** k_back   for k_back in 0..19

weighted_d2(C, role, opp) = sum_k ( d2_k(C, role, opp) * games_k(C, role, opp) * weight_k )
                          / sum_k ( games_k(C, role, opp) * weight_k )

weighted_pr(C) = sum_k ( pr_k(C) * games_k_lane_total * weight_k )
               / sum_k ( games_k_lane_total * weight_k )
```

Where the sum is taken only over patches that have data for that (C, opp) pair.

`games_total` is the un-weighted sum of games for transparency / sample-size filtering in the UI.

## Lane availability

A champion appears in `weighted/{lane}.json` iff they have data in at least one snapshot for that lane. So the UI can flip a champion between lanes if they're played in multiple. The pool builder offers all champions with non-trivial PR in the selected lane (suggested threshold: 0.5% or 1.0%).
