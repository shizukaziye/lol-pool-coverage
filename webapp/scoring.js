// scoring.js — pure functions implementing the formulas in docs/SCORING.md
//
// Conventions:
// - `data` is the parsed weighted/{lane}.json blob.
// - All champion ids are strings (riot ids as strings, matching JSON keys).
// - `pool`, `mains`, `banned` are arrays of riot id strings.
// - All functions are deterministic and side-effect free.

export const DEFAULTS = Object.freeze({
  BUF: 1.0,
  BLIND_RATE: 0.40,
  MIN_PR: 1.5,
  MIN_GAMES: 100,
});

/**
 * d2 lookup: weighted.matchups[subject][opponent].d2, or null if missing.
 */
export function d2(data, subject, opponent) {
  const row = data.matchups[subject];
  if (!row) return null;
  const cell = row[opponent];
  if (!cell) return null;
  return cell.d2;
}

export function games(data, subject, opponent) {
  const row = data.matchups[subject];
  if (!row) return 0;
  const cell = row[opponent];
  if (!cell) return 0;
  return cell.games_total ?? 0;
}

export function pr(data, champ) {
  const t = data.tierlist[champ];
  return t ? t.pr : 0;
}

/**
 * Derive the counter pool: champions in the lane with pr >= minPr, minus banned.
 * Returns an array of riot id strings.
 */
export function counterPool(data, { minPr = DEFAULTS.MIN_PR, banned = [] } = {}) {
  const bannedSet = new Set(banned.map(String));
  const out = [];
  for (const [id, info] of Object.entries(data.tierlist)) {
    if (bannedSet.has(id)) continue;
    if ((info.pr ?? 0) >= minPr) out.push(id);
  }
  return out;
}

/**
 * Effective pool Δ2 vs counter C:
 *   max over P in POOL of d2(P, C) + (BUF if P in MAINS else 0).
 * If no P has a matchup vs C, returns { value: null, by: null, breakdown: [] }.
 *
 * `breakdown` is an array of { p, raw, effective } for every pool member,
 * with raw=null/effective=null if the matchup is missing.
 */
export function poolD2(data, counter, { pool, mains = [], buf = DEFAULTS.BUF }) {
  const mainSet = new Set(mains.map(String));
  let best = null;
  let bestBy = null;
  const breakdown = [];
  for (const p of pool) {
    const raw = d2(data, p, counter);
    if (raw === null) {
      breakdown.push({ p, raw: null, effective: null, isMain: mainSet.has(p) });
      continue;
    }
    const effective = raw + (mainSet.has(p) ? buf : 0);
    breakdown.push({ p, raw, effective, isMain: mainSet.has(p) });
    if (best === null || effective > best) {
      best = effective;
      bestBy = p;
    }
  }
  return { value: best, by: bestBy, breakdown };
}

/**
 * 1. Worst pool matchups.
 * Returns sorted ascending list of { counter, value, by, breakdown, pr }.
 * Counters with no pool data are skipped.
 */
export function worstMatchups(data, opts) {
  const cp = counterPool(data, opts);
  const rows = [];
  for (const c of cp) {
    const r = poolD2(data, c, opts);
    if (r.value === null) continue;
    rows.push({
      counter: c,
      value: r.value,
      by: r.by,
      breakdown: r.breakdown,
      pr: pr(data, c),
    });
  }
  rows.sort((a, b) => a.value - b.value);
  return rows;
}

/**
 * 2. Candidate scores.
 *
 *   score(cand) = sum over C in COUNTER_POOL of
 *                   pr(C) * max(0, -(d2(C, cand) + pool_d2(C)))
 *                 if d2(C, cand) exists and games >= MIN_GAMES
 *
 * For each candidate, also returns the top contributors (the C values
 * that drove the score) so we can show "handles X, Y, Z".
 *
 * Returns sorted descending. Each row:
 *   { cand, score, contributors: [{ counter, contribution, candVsCounter, poolValue }] }
 */
export function candidateScores(data, opts) {
  const { pool, minGames = DEFAULTS.MIN_GAMES, topContributors = 4 } = opts;
  const poolSet = new Set(pool.map(String));
  const cp = counterPool(data, opts);

  // Precompute pool_d2 for every counter in COUNTER_POOL.
  const poolByC = new Map();
  for (const c of cp) {
    const r = poolD2(data, c, opts);
    poolByC.set(c, r.value); // may be null
  }

  // Candidate set: every champion in the tierlist that's not in POOL.
  const cands = [];
  for (const id of Object.keys(data.tierlist)) {
    if (!poolSet.has(id)) cands.push(id);
  }

  const out = [];
  for (const cand of cands) {
    let score = 0;
    const contribs = [];
    for (const c of cp) {
      const poolVal = poolByC.get(c);
      if (poolVal === null || poolVal === undefined) continue;
      const candVsCounter = d2(data, c, cand);
      if (candVsCounter === null) continue;
      if (games(data, c, cand) < minGames) continue;
      const counterPr = pr(data, c);
      const contribution = counterPr * Math.max(0, -(candVsCounter + poolVal));
      if (contribution > 0) {
        contribs.push({ counter: c, contribution, candVsCounter, poolValue: poolVal });
      }
      score += contribution;
    }
    contribs.sort((a, b) => b.contribution - a.contribution);
    out.push({ cand, score, contributors: contribs.slice(0, topContributors) });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

/**
 * 3. Cut analysis. For each P in POOL:
 *   unique(P) = sum over C in COUNTER_POOL of
 *                 pr(C) * max(0, current_best(C) - second_best_without_P(C))
 *               if P is the current best (with main buffer applied)
 *
 * Plus: # matchups they are best for, and their blind score.
 *
 * Returns array, one row per pool member:
 *   { p, unique, bestForCount, blindScore }
 */
export function cutAnalysis(data, opts) {
  const { pool, mains = [], buf = DEFAULTS.BUF } = opts;
  const mainSet = new Set(mains.map(String));
  const cp = counterPool(data, opts);

  // Precompute, for each C: sorted effective values [{ p, effective }] desc.
  const byCounter = new Map();
  for (const c of cp) {
    const arr = [];
    for (const p of pool) {
      const raw = d2(data, p, c);
      if (raw === null) continue;
      const eff = raw + (mainSet.has(p) ? buf : 0);
      arr.push({ p, effective: eff });
    }
    arr.sort((a, b) => b.effective - a.effective);
    byCounter.set(c, arr);
  }

  // Compute unique per pool member.
  const unique = new Map(pool.map((p) => [p, 0]));
  const bestForCount = new Map(pool.map((p) => [p, 0]));
  for (const c of cp) {
    const ranked = byCounter.get(c);
    if (!ranked || ranked.length === 0) continue;
    const top = ranked[0];
    bestForCount.set(top.p, (bestForCount.get(top.p) ?? 0) + 1);
    const second = ranked[1];
    const delta = top.effective - (second ? second.effective : top.effective);
    // If only one pool member covers this counter, second_best is treated as
    // "the value if P were removed" — which is "no coverage." Use top.effective
    // so delta=0 in that case is wrong: cutting them ELIMINATES coverage.
    // We model "no coverage" as -∞ for ranking, but for the unique-value
    // accumulator we use a large penalty proxy = top.effective - (-something).
    // Practical: if only one pool member covers C, the loss is "top.effective
    // minus pool_d2_without_P" — which is undefined. Use top.effective itself
    // (treat second_best as 0 baseline). Sum penalises this strongly.
    let secondVal;
    if (second) secondVal = second.effective;
    else secondVal = top.effective; // matches docs literally: max(0, top - top) = 0.
    const prc = pr(data, c);
    unique.set(top.p, (unique.get(top.p) ?? 0) + prc * Math.max(0, top.effective - secondVal));
  }

  const blinds = blindScores(data, opts);
  const blindMap = new Map(blinds.map((b) => [b.p, b.blind]));

  return pool.map((p) => ({
    p,
    unique: unique.get(p) ?? 0,
    bestForCount: bestForCount.get(p) ?? 0,
    blindScore: blindMap.get(p) ?? 0,
  }));
}

/**
 * 4. Blind safety.
 *
 *   blind(P) = sum over C in COUNTER_POOL where d2(P, C) < 0 of
 *                d2(P, C) * pr(C)
 *
 * Less negative = safer. Main buffer is NOT applied.
 * Returns array { p, blind, blindWeighted } sorted descending (safest first).
 * `blindWeighted` divides by sum of pr(C) where the matchup exists, so it's
 * "average Δ2 across counters you actually lose to", which is more comparable.
 */
export function blindScores(data, opts) {
  const { pool } = opts;
  const cp = counterPool(data, opts);

  const out = pool.map((p) => {
    let blind = 0;
    let weightedNumer = 0;
    let weightedDenom = 0;
    for (const c of cp) {
      const raw = d2(data, p, c);
      if (raw === null) continue;
      const prc = pr(data, c);
      if (raw < 0) blind += raw * prc;
      weightedNumer += raw * prc;
      weightedDenom += prc;
    }
    const blindWeighted = weightedDenom > 0 ? weightedNumer / weightedDenom : 0;
    return { p, blind, blindWeighted };
  });
  out.sort((a, b) => b.blind - a.blind); // less negative first
  return out;
}

/**
 * 5. Usage simulation.
 *
 *   best_blind = argmax over P of blind(P)
 *   For each C, best_counter[C] = argmax over P of (d2(P, C) + buf if main).
 *   counter_share[P] = sum over C of (pr(C) / sum_pr) if best_counter[C] == P
 *   usage[P] = BLIND_RATE * (1 if P == best_blind else 0)
 *           + (1 - BLIND_RATE) * counter_share[P]
 *
 * Returns array { p, usage, counterShare, isBestBlind } sorted by usage desc.
 */
export function usageSimulation(data, opts) {
  const { pool, mains = [], buf = DEFAULTS.BUF, blindRate = DEFAULTS.BLIND_RATE } = opts;
  const mainSet = new Set(mains.map(String));
  const cp = counterPool(data, opts);

  // best_blind
  const blinds = blindScores(data, opts);
  const bestBlind = blinds.length > 0 ? blinds[0].p : null;

  // counter shares
  let sumPr = 0;
  const eligible = []; // [{ c, prc, bestP }]
  for (const c of cp) {
    let best = null;
    let bestP = null;
    for (const p of pool) {
      const raw = d2(data, p, c);
      if (raw === null) continue;
      const eff = raw + (mainSet.has(p) ? buf : 0);
      if (best === null || eff > best) {
        best = eff;
        bestP = p;
      }
    }
    if (bestP === null) continue; // no pool member covers this counter
    const prc = pr(data, c);
    sumPr += prc;
    eligible.push({ c, prc, bestP });
  }

  const counterShare = new Map(pool.map((p) => [p, 0]));
  if (sumPr > 0) {
    for (const e of eligible) {
      counterShare.set(e.bestP, (counterShare.get(e.bestP) ?? 0) + e.prc / sumPr);
    }
  }

  const out = pool.map((p) => {
    const cs = counterShare.get(p) ?? 0;
    const usage = blindRate * (p === bestBlind ? 1 : 0) + (1 - blindRate) * cs;
    return { p, usage, counterShare: cs, isBestBlind: p === bestBlind };
  });
  out.sort((a, b) => b.usage - a.usage);
  return out;
}
