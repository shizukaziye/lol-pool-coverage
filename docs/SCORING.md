# Scoring formulas

These are the analyses the webapp surfaces. The same formulas should be implemented in `webapp/app.js` and tested against canonical fixtures.

## Inputs

- `POOL`: set of champion slugs the user owns / plays.
- `MAINS`: subset of POOL that gets a +1 buffer on their Δ2.
- `BANNED`: counters that should be excluded from the counter pool entirely.
- `LANE`: which lane we're analyzing (top / jungle / middle / bottom / support).
- `BLIND_RATE`: fraction of games the user blind-picks (default 0.40).
- `BUF`: buffer magnitude for mains (default 1.0).
- `MIN_GAMES`: sample-size threshold for candidate matchups (default 100, on the weighted `games_total`).
- `COUNTER_POOL`: derived — all champions with PR ≥ 1.5% in this lane, minus `BANNED`, minus `POOL` (pool members are not threats you draft against — mirror cases are handled separately via cut/usage analysis).

## Helper: effective pool Δ2 vs a counter

For each counter `C`, the pool's effective Δ2 is the max over pool members of `(d2 + buf if main else 0)`:

```
pool_d2(C) = max over P in POOL of:
               d2(P, C) + (BUF if P in MAINS else 0)
```

`d2(P, C)` is `weighted.matchups[P][C].d2`. If a (P, C) entry is missing, P is skipped for that counter.

## 1. Worst pool matchups

Sort counters by `pool_d2(C)` ascending. The worst N (default 10–15) are shown with the breakdown of every pool member's Δ2.

## 2. Candidate score (best adds)

For each champion not in `POOL`:

```
score(cand) = sum over C in COUNTER_POOL of:
                pr(C) * max(0, -(d2(C, cand) + pool_d2(C)))
              if d2(C, cand) exists and games >= MIN_GAMES
```

Notes:
- `d2(C, cand)` is the counter's Δ2 against the candidate, i.e. `weighted.matchups[C][cand].d2`. Negative = candidate hard-counters this threat.
- `max(0, ...)` clamps: matchups where the candidate adds no value contribute 0, not a negative number.
- Sort candidates by score descending.

## 3. Cut analysis (per pool member)

For each `P` in `POOL`, the unique value is the score loss if you removed `P`:

```
unique(P) = sum over C in COUNTER_POOL of:
              pr(C) * max(0, current_best(C) - second_best_without_P(C))
            if P is the current best (with main buffer applied)
```

Lower `unique` = safer to cut.

## 4. Blind safety

For each `P` in `POOL`:

```
blind(P) = sum over C in COUNTER_POOL where d2(P, C) < 0 of:
             d2(P, C) * pr(C)
```

Less negative = safer to blind pick. Note: the +1 main buffer is NOT applied here — blind-picking means you commit to that champ regardless of opponent, so raw Δ2 governs.

## 5. Usage simulation

Assumes the user picks the safest blind champ every blind game and the best-Δ2 champ every counter-pick game.

```
best_blind = argmax over P in POOL of blind(P)

For each C in COUNTER_POOL:
  best_counter[C] = argmax over P in POOL of (d2(P, C) + buf_if_main(P))

counter_share[P] = sum over C of (pr(C) / sum_pr) if best_counter[C] == P

usage[P] = BLIND_RATE       * (1 if P == best_blind else 0)
        + (1 - BLIND_RATE)  * counter_share[P]
```

## Cross-role matchups (5v5)

`d2(P, C)` is role-aware: `weighted.matchups[P][role][C].d2`, where `role` is the
**enemy's** role and defaults to `LANE` (the same-lane matchup, so every formula
above is unchanged when cross-role is off). A pool champ also has matchup tables
vs enemies in the four other roles — e.g. a top laner's win-rate delta vs each
enemy jungler.

### Threat pool

`THREAT_POOL` generalizes `COUNTER_POOL`: each threat is `{ id, role, prc }`.
Same-lane threats (role = `LANE`) come from this lane's tierlist; opted-in extra
roles' threats come from `data/rosters.json` (`{ role: { rid: pr } }`). With no
extra roles it is exactly `COUNTER_POOL` tagged with `LANE`. **Pool analysis**
allows at most one extra role (2 total); worst-matchups / best-adds / cut / blind
all iterate `THREAT_POOL`, so the second role's champs become additional threats
weighted by their own pickrate. For best-adds, a cross-role threat isn't a
subject in this lane's file, so the "counter vs candidate" Δ2 is taken from the
candidate's own (inverted) matchup instead.

### Combining roles — the "best overall pick" (draft)

The **draft assistant** lets you fill an enemy per role (up to all five) and ranks
your pool by an effective Δ2 that combines the per-role matchups by **adding
log-odds** (≡ multiplying odds), which is the principled way to fuse independent
probabilistic edges:

```
for each filled enemy role r with your champ P:
    p_r   = clamp(0.5 + d2(P, enemy_r, r) / 100, 0.02, 0.98)   # matchup win prob
L          = sum over r of ln( p_r / (1 - p_r) )               # add log-odds
if P is a main: L += ln( (0.5+BUF/100) / (0.5-BUF/100) )       # buffer = one more edge
winProb    = 1 / (1 + e^(-L))                                  # sigmoid back
eff_d2     = (winProb - 0.5) * 100                             # display, same units
```

Properties (verified in fixtures): even matchups stay even (`50% & 50% → 50%`), a
favored + an equally-unfavored matchup cancel (`40% & 60% → 50%`), advantages
compound but saturate below 100% (`90% & 90% → 98.8%`), and because off-role Δ2
are naturally ~5× smaller than the lane, the lane dominates without any manual
weighting. Pool members with no data vs any filled slot sort last.

### Combination-aware best adds (pickrate simulation)

When you opt a second role into **pool analysis**, "best adds" switches from the
independent coverage sum to a simulation over enemy comps (`comboAdds`):

```
roles = [yourLane, ...extraRoles]
for each enemy comp (one champ per role), weighted by the product of the
champs' pickrates (restricted to PR ≥ minPr — common picks):
    bestBase = max over P in POOL of comboEff(P, comp)        # your best response
    for each candidate C (suggestable, not in pool):
        gain = comboEff(C, comp) − bestBase
        if gain > 0:
            addValue[C]     += weight * gain
            upgradeShare[C] += weight
comboEff(champ, comp) = combineDeltas( d2(champ, comp[role], role) for role in roles
                                       with games ≥ MIN_GAMES ; + buf if main )
```

`addValue` is the expected effective-Δ2 (≈ win%) a candidate adds to your pool,
counting **only** the comps where it would actually be your pick — so a champ
that's strong vs the enemy top but collapses vs a common enemy jungler (Malphite
into Sylas) gets no credit in those comps. The comp space is enumerated exactly
when small (≤ `maxComps`, the deterministic limit of Monte Carlo) and
seeded-sampled otherwise. `baseExpected` is your pool's mean best-response Δ2
across the field.

Each row's "good against" lists (`bestVs`, shown per role — 6 for your lane, 3
for each extra role) reuse the **single-row coverage metric**, not raw Δ2: the
threats ranked by `pr(T) × max(0, −(candVsCounter + pool_d2(T)))` — i.e. how much
the candidate improves on your pool's current best answer to that threat,
weighted by its pickrate.

## Fixtures

The scraper repo should include a tiny golden-data fixture (3 champions, 1 lane, hand-computed expected outputs) that both Python tests and JS tests can run against, to confirm both implementations agree numerically.
