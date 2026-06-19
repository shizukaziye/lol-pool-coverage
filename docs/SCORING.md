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
- `COUNTER_POOL`: derived — all champions with PR ≥ 1.5% in this lane, minus `BANNED`.

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

## Fixtures

The scraper repo should include a tiny golden-data fixture (3 champions, 1 lane, hand-computed expected outputs) that both Python tests and JS tests can run against, to confirm both implementations agree numerically.
