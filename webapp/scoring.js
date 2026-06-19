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
  // A champion is only SUGGESTED (best adds / best blind picks) if it's a common
  // pick with plenty of data — guards against thin-sample champs (e.g. Skarner at
  // <1% PR) whose matchups read a noisy ±10. The user's own pool champs bypass
  // this entirely; they're never auto-suggested. PR is the primary filter
  // (≥MIN_PR champs all carry 100k+ games); the games floor is a backstop for
  // when MIN_PR is dragged low.
  MIN_CAND_GAMES: 20000,
});

/**
 * Is `id` eligible to be SUGGESTED to the user (best adds / best blind picks)?
 * Requires a common pick (PR ≥ minPr) with plenty of data (games_total floor).
 * Does NOT apply to champions the user explicitly put in their pool.
 */
export function isSuggestable(data, id, { minPr = DEFAULTS.MIN_PR } = {}) {
  const t = data.tierlist[id];
  if (!t) return false;
  return (t.pr ?? 0) >= minPr && (t.games_total ?? 0) >= DEFAULTS.MIN_CAND_GAMES;
}

/**
 * d2 lookup: weighted.matchups[subject][role][opponent].d2, or null if missing.
 * `role` is the ENEMY's role and defaults to the subject's own lane (same-lane
 * matchup), so every same-lane caller works unchanged. Cross-role lookups pass
 * an explicit role, e.g. d2(data, myTop, enemyJungler, "jungle").
 */
export function d2(data, subject, opponent, role = data.lane) {
  const byRole = data.matchups[subject];
  if (!byRole) return null;
  const cells = byRole[role];
  if (!cells) return null;
  const cell = cells[opponent];
  return cell ? cell.d2 : null;
}

export function games(data, subject, opponent, role = data.lane) {
  const byRole = data.matchups[subject];
  if (!byRole) return 0;
  const cells = byRole[role];
  if (!cells) return 0;
  const cell = cells[opponent];
  return cell ? (cell.games_total ?? 0) : 0;
}

/**
 * Combine independent per-matchup Δ2 values (win-rate points) into one
 * effective Δ2 + win probability, by adding log-odds (≡ multiplying odds).
 *
 * Each Δ2 → matchup win prob p = 0.5 + Δ2/100 (clamped); sum the logits; the
 * sigmoid gives the combined win prob. Properties: even matchups stay even,
 * a favored + an equally-unfavored matchup cancel, advantages compound but
 * saturate below 100%, and because off-role Δ2 are naturally small the lane
 * dominates on its own. See docs/SCORING.md.
 *
 * Returns { winProb, eff } where eff = (winProb − 0.5) × 100. Empty → 50%/0.
 */
const COMBINE_EPS = 0.02;
export function combineDeltas(deltas) {
  let logit = 0;
  for (const d of deltas) {
    let p = 0.5 + d / 100;
    if (p < COMBINE_EPS) p = COMBINE_EPS;
    else if (p > 1 - COMBINE_EPS) p = 1 - COMBINE_EPS;
    logit += Math.log(p / (1 - p));
  }
  const winProb = 1 / (1 + Math.exp(-logit));
  return { winProb, eff: (winProb - 0.5) * 100 };
}

export function pr(data, champ) {
  const t = data.tierlist[champ];
  return t ? t.pr : 0;
}

/**
 * Derive the counter pool: champions in the lane with pr >= minPr, minus banned.
 * Returns an array of riot id strings.
 */
export function counterPool(data, { minPr = DEFAULTS.MIN_PR, banned = [], pool = [] } = {}) {
  const bannedSet = new Set(banned.map(String));
  const poolSet = new Set(pool.map(String));
  const out = [];
  for (const [id, info] of Object.entries(data.tierlist)) {
    if (bannedSet.has(id) || poolSet.has(id)) continue;
    if ((info.pr ?? 0) >= minPr) out.push(id);
  }
  return out;
}

/**
 * Role-tagged threat pool. Same-lane threats (your role) come from data.tierlist;
 * any `extraRoles` threats come from `rosters[role]` (rid -> pr). Each threat is
 * { id, role, prc }. With no extraRoles this is exactly counterPool, tagged with
 * the lane — so every analysis below is unchanged when cross-role is off.
 *
 * `rosters` is data/rosters.json: { role: { rid: pr } } for all five lanes.
 * Bans and your pool only filter same-lane threats (cross-role enemies aren't
 * yours to ban or play).
 */
export function threatPool(data, rosters, { minPr = DEFAULTS.MIN_PR, banned = [], pool = [], extraRoles = [] } = {}) {
  const lane = data.lane;
  const bannedSet = new Set(banned.map(String));
  const poolSet = new Set(pool.map(String));
  const out = [];
  for (const [id, info] of Object.entries(data.tierlist)) {
    if (bannedSet.has(id) || poolSet.has(id)) continue;
    if ((info.pr ?? 0) >= minPr) out.push({ id, role: lane, prc: info.pr });
  }
  for (const role of extraRoles) {
    if (role === lane) continue;
    const roster = (rosters && rosters[role]) || {};
    for (const [id, prc] of Object.entries(roster)) {
      if ((prc ?? 0) >= minPr) out.push({ id, role, prc });
    }
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
export function poolD2(data, counter, { pool, mains = [], buf = DEFAULTS.BUF }, role = data.lane) {
  const mainSet = new Set(mains.map(String));
  let best = null;
  let bestBy = null;
  const breakdown = [];
  for (const p of pool) {
    const raw = d2(data, p, counter, role);
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
export function worstMatchups(data, opts, rosters = null) {
  const threats = threatPool(data, rosters, opts);
  const rows = [];
  for (const t of threats) {
    const r = poolD2(data, t.id, opts, t.role);
    if (r.value === null) continue;
    rows.push({
      counter: t.id,
      role: t.role,
      value: r.value,
      by: r.by,
      breakdown: r.breakdown,
      pr: t.prc,
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
export function candidateScores(data, opts, rosters = null) {
  const { pool, minGames = DEFAULTS.MIN_GAMES, topContributors = 4 } = opts;
  const poolSet = new Set(pool.map(String));
  const threats = threatPool(data, rosters, opts);

  // Precompute pool_d2 for every threat (role-aware).
  const poolByThreat = threats.map((t) => ({ t, poolVal: poolD2(data, t.id, opts, t.role).value }));

  // Candidate set: champs in YOUR lane that you don't play, restricted to
  // common, well-sampled picks (no thin-data noise like Skarner). Your own pool
  // champs are excluded here anyway — they're never auto-suggested.
  const cands = [];
  for (const id of Object.keys(data.tierlist)) {
    if (!poolSet.has(id) && isSuggestable(data, id, opts)) cands.push(id);
  }

  const out = [];
  for (const cand of cands) {
    let score = 0;
    const contribs = [];
    for (const { t, poolVal } of poolByThreat) {
      if (poolVal === null || poolVal === undefined) continue;
      // candVsCounter = the threat's Δ2 vs the candidate (positive = threat
      // beats candidate). Same-lane: read it directly (threat is a subject).
      // Cross-role: the enemy isn't a subject in this lane's file, so invert the
      // candidate's own Δ2 vs the threat.
      const direct = d2(data, t.id, cand, t.role);
      let candVsCounter, g;
      if (direct !== null) {
        candVsCounter = direct;
        g = games(data, t.id, cand, t.role);
      } else {
        const inv = d2(data, cand, t.id, t.role);
        if (inv === null) continue;
        candVsCounter = -inv;
        g = games(data, cand, t.id, t.role);
      }
      if (g < minGames) continue;
      const contribution = t.prc * Math.max(0, -(candVsCounter + poolVal));
      if (contribution > 0) {
        // candD2: candidate's own Δ2 vs this threat (positive = candidate favored).
        const fwd = d2(data, cand, t.id, t.role);
        const candD2 = fwd !== null ? fwd : -candVsCounter;
        contribs.push({ counter: t.id, role: t.role, contribution, candVsCounter, candD2, counterPr: t.prc, poolValue: poolVal });
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
export function cutAnalysis(data, opts, rosters = null) {
  const { pool, mains = [], buf = DEFAULTS.BUF } = opts;
  const mainSet = new Set(mains.map(String));
  const threats = threatPool(data, rosters, opts);

  // Precompute, for each threat: sorted effective values [{ p, effective }] desc.
  const byCounter = new Map();
  for (const t of threats) {
    const arr = [];
    for (const p of pool) {
      const raw = d2(data, p, t.id, t.role);
      if (raw === null) continue;
      const eff = raw + (mainSet.has(p) ? buf : 0);
      arr.push({ p, effective: eff });
    }
    arr.sort((a, b) => b.effective - a.effective);
    byCounter.set(t, arr);
  }

  // Compute unique per pool member.
  const unique = new Map(pool.map((p) => [p, 0]));
  const bestForCount = new Map(pool.map((p) => [p, 0]));
  for (const t of threats) {
    const ranked = byCounter.get(t);
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
    const prc = t.prc;
    unique.set(top.p, (unique.get(top.p) ?? 0) + prc * Math.max(0, top.effective - secondVal));
  }

  const blinds = blindScores(data, opts, rosters);
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
export function blindScores(data, opts, rosters = null) {
  const { pool } = opts;
  const threats = threatPool(data, rosters, opts);

  const out = pool.map((p) => {
    let blind = 0;
    let weightedNumer = 0;
    let weightedDenom = 0;
    for (const t of threats) {
      const raw = d2(data, p, t.id, t.role);
      if (raw === null) continue;
      const prc = t.prc;
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
 * 4b. Best blind picks — the safest first-picks in the LANE that you don't
 * already play, so you can find one to add. Same blind metric as blindScores
 * but computed for every champion in the counter pool (PR ≥ minPr, not banned,
 * not in your pool), ranked safest (least-negative) first.
 *
 * Returns array { champ, blind, blindWeighted, pr, lossCount } sorted desc.
 */
export function blindCandidates(data, opts, rosters = null) {
  // Only suggest common, well-sampled first-picks (no thin-data noise).
  const cands = counterPool(data, opts).filter((id) => isSuggestable(data, id, opts));
  const threats = threatPool(data, rosters, opts);
  const out = [];
  for (const champ of cands) {
    let blind = 0;
    let num = 0;
    let den = 0;
    let lossCount = 0;
    let dataCount = 0;
    for (const t of threats) {
      if (t.id === champ && t.role === data.lane) continue; // skip self (same lane)
      const raw = d2(data, champ, t.id, t.role);
      if (raw === null) continue;
      const prc = t.prc;
      dataCount++;
      if (raw < 0) { blind += raw * prc; lossCount++; }
      num += raw * prc;
      den += prc;
    }
    if (dataCount === 0) continue;
    out.push({
      champ,
      blind,
      blindWeighted: den > 0 ? num / den : 0,
      pr: pr(data, champ),
      lossCount,
    });
  }
  out.sort((a, b) => b.blind - a.blind);
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
export function usageSimulation(data, opts, rosters = null) {
  const { pool, mains = [], buf = DEFAULTS.BUF, blindRate = DEFAULTS.BLIND_RATE } = opts;
  const mainSet = new Set(mains.map(String));
  const threats = threatPool(data, rosters, opts);

  // best_blind
  const blinds = blindScores(data, opts, rosters);
  const bestBlind = blinds.length > 0 ? blinds[0].p : null;

  // counter shares
  let sumPr = 0;
  const eligible = []; // [{ prc, bestP }]
  for (const t of threats) {
    let best = null;
    let bestP = null;
    for (const p of pool) {
      const raw = d2(data, p, t.id, t.role);
      if (raw === null) continue;
      const eff = raw + (mainSet.has(p) ? buf : 0);
      if (best === null || eff > best) {
        best = eff;
        bestP = p;
      }
    }
    if (bestP === null) continue; // no pool member covers this threat
    const prc = t.prc;
    sumPr += prc;
    eligible.push({ prc, bestP });
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

/**
 * 6. Draft pick — given a specific enemy laner, rank YOUR pool by the matchup.
 *
 *   For each pool member P: raw = d2(P, enemy) (your champ's Δ2 vs the enemy,
 *   your perspective; positive = you're favored). eff adds the +1 main buffer
 *   if P is a main. Sorted best-first; members with no matchup data sort last.
 *
 * Returns { rows: [{ p, raw, eff, isMain, games }], hasData, allLose, best }.
 *   - hasData: at least one pool member has a Δ2 vs this enemy.
 *   - allLose: every pool member with data has eff < 0.
 *   - best: the top pool member id (your recommended pick), or null.
 */
export function draftPicks(data, opts, enemies) {
  const { pool = [], mains = [], buf = DEFAULTS.BUF, minGames = 0 } = opts;
  const mainSet = new Set(mains.map(String));
  // Accept a bare enemy id (same-lane, back-compat) or a { role: rid } map.
  const enemyMap =
    typeof enemies === "string" || typeof enemies === "number"
      ? { [data.lane]: String(enemies) }
      : Object.fromEntries(
          Object.entries(enemies || {})
            .filter(([, v]) => v)
            .map(([k, v]) => [k, String(v)])
        );
  const roles = Object.keys(enemyMap);

  const rows = pool.map((p) => {
    const ps = String(p);
    const isMain = mainSet.has(ps);
    // Per-role Δ2 vs each filled enemy slot (your champ's perspective).
    const perRole = [];
    for (const role of roles) {
      const opp = enemyMap[role];
      const raw = d2(data, ps, opp, role);
      const g = games(data, ps, opp, role);
      if (raw !== null && g >= minGames) perRole.push({ role, opp, d2: raw, games: g });
    }
    if (perRole.length === 0) {
      return { p: ps, perRole, eff: null, winProb: null, isMain };
    }
    // Combine the per-role deltas via log-odds. The main buffer is folded in as
    // one extra small favorable edge (a flat "you play this better" bonus).
    const deltas = perRole.map((x) => x.d2);
    if (isMain) deltas.push(buf);
    const { winProb, eff } = combineDeltas(deltas);
    return { p: ps, perRole, eff, winProb, isMain };
  });
  rows.sort((a, b) => {
    if (a.eff === null && b.eff === null) return 0;
    if (a.eff === null) return 1;
    if (b.eff === null) return -1;
    return b.eff - a.eff;
  });
  const withData = rows.filter((r) => r.eff !== null);
  return {
    rows,
    hasData: withData.length > 0,
    allLose: withData.length > 0 && withData.every((r) => r.eff < 0),
    best: withData.length > 0 ? withData[0].p : null,
    rolesUsed: roles,
  };
}
