// ui.js — DOM rendering for panels, tables, chips, charts.

import {
  worstMatchups, candidateScores, cutAnalysis,
  blindScores, usageSimulation, draftPicks,
} from "./scoring.js";

const fmt = (x, d = 2) => (x == null ? "—" : Number(x).toFixed(d));
const fmtPct = (x, d = 1) => (x == null ? "—" : `${(x * 100).toFixed(d)}%`);

function d2Cell(v) {
  if (v == null) return `<td class="d2-cell d2-zero">—</td>`;
  const cls = v > 0 ? "d2-pos cell-pos" : v < 0 ? "d2-neg cell-neg" : "d2-zero";
  return `<td class="d2-cell ${cls}">${v > 0 ? "+" : ""}${fmt(v)}</td>`;
}

function champCell(id, ctx) {
  const meta = ctx.champByRiotId(id);
  const name = meta ? meta.name : id;
  const slug = meta ? meta.slug : null;
  const url = slug ? ctx.iconUrl(slug) : "";
  return `<span class="champ-cell"><img src="${url}" alt="" onerror="this.style.visibility='hidden'"/><span>${escapeHtml(name)}</span></span>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------------- Chip inputs ----------------

export function renderChips(container, ids, ctx, { onRemove, mainsSet = new Set() } = {}) {
  container.innerHTML = "";
  for (const id of ids) {
    const meta = ctx.champByRiotId(id);
    const name = meta ? meta.name : id;
    const slug = meta ? meta.slug : null;
    const chip = document.createElement("div");
    chip.className = "chip" + (mainsSet.has(id) ? " main" : "");
    chip.innerHTML = `<img src="${slug ? ctx.iconUrl(slug) : ""}" alt="" onerror="this.style.visibility='hidden'"/><span>${escapeHtml(name)}</span><span class="x">×</span>`;
    chip.title = "Click to remove";
    chip.addEventListener("click", () => onRemove?.(id));
    container.appendChild(chip);
  }
}

export function attachSearch(input, results, ctx, { onPick, filter = () => true }) {
  let activeIdx = -1;
  let items = [];

  function close() { results.classList.remove("open"); results.innerHTML = ""; activeIdx = -1; }
  function render(query) {
    const q = query.trim().toLowerCase();
    if (!q) { close(); return; }
    const all = ctx.allChampions();
    items = all.filter((c) => c.name.toLowerCase().includes(q) && filter(c)).slice(0, 12);
    if (items.length === 0) { close(); return; }
    results.innerHTML = items.map((c, i) => `<li role="option" data-id="${c.riot_id}" class="${i === activeIdx ? "active" : ""}"><img src="${ctx.iconUrl(c.slug)}" alt="" onerror="this.style.visibility='hidden'"/><span>${escapeHtml(c.name)}</span></li>`).join("");
    results.classList.add("open");
    [...results.children].forEach((li) => {
      // mousedown fires before the input's blur (so the dropdown is still open);
      // a click listener covers programmatic clicks and edge cases where mousedown
      // didn't fire. Guard so a real pointer interaction (mousedown -> click) only
      // picks once. onPick is also idempotent on the state side.
      let picked = false;
      const pick = (ev) => {
        ev.preventDefault();
        if (picked) return;
        picked = true;
        onPick?.(li.dataset.id);
        input.value = "";
        close();
      };
      li.addEventListener("mousedown", pick);
      li.addEventListener("click", pick);
    });
  }
  input.addEventListener("input", () => render(input.value));
  input.addEventListener("focus", () => render(input.value));
  input.addEventListener("blur", () => setTimeout(close, 120));
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowDown") { ev.preventDefault(); activeIdx = Math.min(items.length - 1, activeIdx + 1); render(input.value); }
    else if (ev.key === "ArrowUp") { ev.preventDefault(); activeIdx = Math.max(0, activeIdx - 1); render(input.value); }
    else if (ev.key === "Enter" && items[activeIdx]) { ev.preventDefault(); onPick?.(items[activeIdx].riot_id); input.value = ""; close(); }
    else if (ev.key === "Escape") close();
  });
}

// ---------------- Mains toggles ----------------

export function renderMains(container, pool, mainsSet, ctx, onToggle) {
  container.innerHTML = "";
  if (pool.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "Add pool champions first.";
    container.appendChild(empty);
    return;
  }
  for (const id of pool) {
    const meta = ctx.champByRiotId(id);
    const name = meta ? meta.name : id;
    const slug = meta ? meta.slug : null;
    const btn = document.createElement("button");
    btn.className = "toggle" + (mainsSet.has(id) ? " on" : "");
    btn.innerHTML = `<img src="${slug ? ctx.iconUrl(slug) : ""}" alt="" onerror="this.style.visibility='hidden'"/><span>${escapeHtml(name)}</span>`;
    btn.title = mainsSet.has(id) ? "Main (+1) — click to unset" : "Click to mark as main (+1)";
    btn.addEventListener("click", () => onToggle?.(id));
    container.appendChild(btn);
  }
}

// ---------------- Analysis panels ----------------

export function renderWorst(table, data, opts, ctx) {
  const rows = worstMatchups(data, opts).slice(0, 15);
  if (rows.length === 0) {
    table.innerHTML = `<tbody><tr><td class="empty-state">Add pool champions to see worst matchups.</td></tr></tbody>`;
    return;
  }
  const pool = opts.pool;
  let html = `<thead><tr><th title="A popular meta pick in this lane that you draft against.">Counter</th><th class="num" title="Pickrate: how often this champion is played in this lane.">PR%</th><th title="Effective Δ2 — your pool's best answer to this counter, with the +1 buffer applied if that answer is a main. Higher is better.">Eff Δ2</th><th title="Which pool member gives that best answer.">By</th>`;
  for (const p of pool) html += `<th>${champCell(p, ctx)}</th>`;
  html += `</tr></thead><tbody>`;
  for (const r of rows) {
    html += `<tr><td>${champCell(r.counter, ctx)}</td><td class="num">${fmt(r.pr, 2)}</td>${d2Cell(r.value)}<td>${r.by ? champCell(r.by, ctx) : "—"}</td>`;
    const byMap = new Map(r.breakdown.map((b) => [b.p, b]));
    for (const p of pool) {
      const b = byMap.get(p);
      html += d2Cell(b ? b.raw : null);
    }
    html += `</tr>`;
  }
  html += `</tbody>`;
  table.innerHTML = html;
}

export function renderAdds(table, data, opts, ctx, onAdd) {
  const rows = candidateScores(data, opts).slice(0, 25);
  if (rows.length === 0 || rows.every((r) => r.score === 0)) {
    table.innerHTML = `<tbody><tr><td class="empty-state">No candidates score above 0 — either your pool covers everything or there's no data.</td></tr></tbody>`;
    return;
  }
  // How many handles to show per row — driven by opts.topContributors so every
  // row reserves the same number of grid slots and the columns line up.
  const slots = opts.topContributors || 6;
  let html = `<thead><tr><th title="A champion you don't currently play that you could add. Click one to add it to your pool.">Candidate</th><th class="num" title="Best-adds score — how much coverage this champion would add, weighting each newly-answered threat by its pickrate. Higher = bigger upgrade.">Score</th><th title="The top threats this candidate would newly answer for you, with how much each contributes.">Handles (top ${slots})</th></tr></thead><tbody>`;
  for (const r of rows) {
    if (r.score <= 0) continue;
    const meta = ctx.champByRiotId(r.cand);
    const cname = meta ? meta.name : r.cand;
    let cells = r.contributors.map((c) =>
      `<span class="c-item">${champCell(c.counter, ctx)}<span class="c-val">+${fmt(c.contribution, 1)}</span></span>`
    );
    // Pad to a fixed slot count so the grid columns align across every row.
    while (cells.length < slots) cells.push(`<span class="c-item c-empty"></span>`);
    const contribs = cells.join("");
    html += `<tr><td><button type="button" class="add-cand" data-add="${r.cand}" title="Add ${escapeHtml(cname)} to your pool">${champCell(r.cand, ctx)}<span class="add-plus" aria-hidden="true">+</span></button></td><td class="num">${fmt(r.score, 2)}</td><td><div class="contribs" style="--slots:${slots}">${contribs}</div></td></tr>`;
  }
  html += `</tbody>`;
  table.innerHTML = html;
  if (onAdd) {
    table.querySelectorAll(".add-cand").forEach((btn) => {
      btn.addEventListener("click", () => onAdd(btn.dataset.add));
    });
  }
}

export function renderCut(table, hint, data, opts, ctx) {
  const rows = cutAnalysis(data, opts);
  if (rows.length === 0) {
    table.innerHTML = `<tbody><tr><td class="empty-state">Add pool champions to see cut analysis.</td></tr></tbody>`;
    hint.textContent = "";
    return;
  }
  const sortedByUnique = [...rows].sort((a, b) => a.unique - b.unique);
  const mustKeep = [...rows].sort((a, b) => b.unique - a.unique)[0];
  // Your best blind pick (least-negative blind score) is valuable to keep, so
  // avoid flagging it as the safest cut. With 3+ champs there's always another
  // candidate; with only 2 the notion is degenerate, so leave it.
  const bestBlind = [...rows].sort((a, b) => b.blindScore - a.blindScore)[0];
  let safestCut = sortedByUnique[0];
  let avoidedBestBlind = false;
  if (rows.length >= 3 && safestCut === bestBlind) {
    const alt = sortedByUnique.find((r) => r !== bestBlind);
    if (alt) { safestCut = alt; avoidedBestBlind = true; }
  }
  let html = `<thead><tr><th title="A champion in your pool.">Champ</th><th class="num" title="Unique value — how much coverage you'd lose by dropping this champ (the threats only they answer, weighted by pickrate). Lower = safer to cut.">Unique value</th><th class="num" title="How many counters this champ is your single best answer for.">Best for #</th><th class="num" title="Blind score — sum of this champ's losing matchups, weighted by how common they are. Less negative = safer to blind.">Blind</th><th></th></tr></thead><tbody>`;
  for (const r of rows) {
    const tag = r === safestCut && rows.length > 1 ? `<span class="tag cut">safest cut</span>` :
                r === mustKeep && rows.length > 1 ? `<span class="tag keep">must keep</span>` : "";
    html += `<tr><td>${champCell(r.p, ctx)}</td><td class="num">${fmt(r.unique, 2)}</td><td class="num">${r.bestForCount}</td><td class="num">${fmt(r.blindScore, 2)}</td><td>${tag}</td></tr>`;
  }
  html += `</tbody>`;
  table.innerHTML = html;
  if (rows.length > 1) {
    const sCutMeta = ctx.champByRiotId(safestCut.p);
    const mKeepMeta = ctx.champByRiotId(mustKeep.p);
    const bBlindMeta = ctx.champByRiotId(bestBlind.p);
    let note = "";
    if (avoidedBestBlind && bBlindMeta) {
      note = ` · Keeping <strong>${escapeHtml(bBlindMeta.name)}</strong> as your safest blind pick`;
    }
    hint.innerHTML = `Safest cut: <strong>${escapeHtml(sCutMeta ? sCutMeta.name : safestCut.p)}</strong> · Must keep: <strong>${escapeHtml(mKeepMeta ? mKeepMeta.name : mustKeep.p)}</strong>${note}`;
  } else hint.textContent = "";
}

export function renderBlind(table, data, opts, ctx) {
  const rows = blindScores(data, opts);
  if (rows.length === 0) {
    table.innerHTML = `<tbody><tr><td class="empty-state">Add pool champions to see blind safety.</td></tr></tbody>`;
    return;
  }
  let html = `<thead><tr><th title="A champion in your pool.">Champ</th><th class="num" title="Blind score — sum of this champ's losing matchups, each weighted by how common that opponent is. Less negative (closer to 0) = safer to blind-pick.">Blind (raw)</th><th class="num" title="Average Δ2 across every counter you have data for, weighted by pickrate. A normalized read on overall matchup spread.">Avg Δ2 (PR-weighted)</th></tr></thead><tbody>`;
  for (const r of rows) {
    html += `<tr><td>${champCell(r.p, ctx)}</td>${d2Cell(r.blind)}${d2Cell(r.blindWeighted)}</tr>`;
  }
  html += `</tbody>`;
  table.innerHTML = html;
}

export function renderUsage(container, data, opts, ctx) {
  const rows = usageSimulation(data, opts);
  if (rows.length === 0) {
    container.innerHTML = `<div class="empty-state">Add pool champions to see usage simulation.</div>`;
    return;
  }
  const maxU = Math.max(...rows.map((r) => r.usage), 0.001);
  container.innerHTML = rows.map((r) => {
    const meta = ctx.champByRiotId(r.p);
    const name = meta ? meta.name : r.p;
    const slug = meta ? meta.slug : null;
    const widthPct = (r.usage / maxU) * 100;
    const tag = r.isBestBlind ? `<span class="tag main">blind</span>` : "";
    return `<div class="usage-bar">
      <div class="name"><img src="${slug ? ctx.iconUrl(slug) : ""}" alt="" onerror="this.style.visibility='hidden'"/><span>${escapeHtml(name)}</span>${tag}</div>
      <div class="track"><div class="fill" style="width: ${widthPct.toFixed(1)}%"></div></div>
      <div class="pct">${fmtPct(r.usage, 1)}</div>
    </div>`;
  }).join("");
}

// ---------------- Draft assistant (champ-select-style tiles) ----------------

// One large square portrait + name caption, with optional Δ2 badge / ribbons.
// o: { selected, best, nodata, isMain, tag: "best"|"blind", d2: number|null }
export function champTile(id, ctx, o = {}) {
  const meta = ctx.champByRiotId(id);
  const name = meta ? meta.name : id;
  const slug = meta ? meta.slug : null;
  const url = slug ? ctx.iconUrl(slug) : "";
  let cls = "champ-tile";
  if (o.selected) cls += " selected";
  if (o.best) cls += " best";
  if (o.nodata) cls += " nodata";
  let tag = "";
  if (o.tag === "best") tag = `<span class="tile-tag best">Best pick</span>`;
  else if (o.tag === "blind") tag = `<span class="tile-tag blind">Safest blind</span>`;
  let d2badge = "";
  if (Object.prototype.hasOwnProperty.call(o, "d2")) {
    if (o.d2 == null) d2badge = `<span class="tile-d2 na">n/a</span>`;
    else d2badge = `<span class="tile-d2 ${o.d2 >= 0 ? "pos" : "neg"}">${o.d2 >= 0 ? "+" : ""}${Number(o.d2).toFixed(2)}</span>`;
  }
  const star = o.isMain ? ` <span class="star" title="Main (+1 buffer)">★</span>` : "";
  return `<div class="${cls}" data-id="${id}" role="button" tabindex="0" title="${escapeHtml(name)}">${tag}${d2badge}<img src="${url}" alt="" loading="lazy" onerror="this.style.visibility='hidden'"/><span class="tile-name">${escapeHtml(name)}${star}</span></div>`;
}

export function renderEnemyGrid(container, laneChampIds, ctx, selectedId, filterText) {
  const q = (filterText || "").trim().toLowerCase();
  const items = laneChampIds.filter((id) => {
    if (!q) return true;
    const meta = ctx.champByRiotId(id);
    return meta && meta.name.toLowerCase().includes(q);
  });
  if (items.length === 0) {
    container.innerHTML = `<p class="reco-empty">No champion matches “${escapeHtml(filterText)}”.</p>`;
    return;
  }
  container.innerHTML = items.map((id) => champTile(id, ctx, { selected: String(id) === String(selectedId) })).join("");
}

// Render the recommendation column. If enemyId is set → rank pool vs that enemy;
// otherwise → blind-safety ranking. Returns the recommended pick id (or null).
export function renderReco(els, data, opts, ctx, enemyId) {
  const { recoGrid, recoTitle, recoDesc, draftFlag } = els;
  const nameOf = (id) => { const m = ctx.champByRiotId(id); return m ? m.name : id; };
  const mainSet = new Set((opts.mains || []).map(String));
  draftFlag.hidden = true;
  draftFlag.textContent = "";

  if (!enemyId) {
    // Blind state.
    const blinds = blindScores(data, opts);
    recoTitle.textContent = "Your blind pick";
    if (blinds.length === 0) {
      recoDesc.textContent = "Add champions to your pool to get a recommendation.";
      recoGrid.innerHTML = `<p class="reco-empty">No pool yet.</p>`;
      return null;
    }
    recoDesc.innerHTML = `No enemy picked yet — your safest first-pick is <strong>${escapeHtml(nameOf(blinds[0].p))}</strong>. Click the enemy champion on the right to get a counter.`;
    recoGrid.innerHTML = blinds.map((b, i) => champTile(b.p, ctx, {
      tag: i === 0 ? "blind" : undefined,
      best: i === 0,
      isMain: mainSet.has(String(b.p)),
    })).join("");
    return blinds[0].p;
  }

  // Counter state.
  const res = draftPicks(data, opts, enemyId);
  recoTitle.innerHTML = `Best pick vs ${escapeHtml(nameOf(enemyId))}`;
  if (!res.hasData) {
    recoDesc.textContent = "No matchup data between your pool and this champion at the current sample threshold.";
    recoGrid.innerHTML = res.rows.map((r) => champTile(r.p, ctx, { d2: null, nodata: true, isMain: r.isMain })).join("");
    return null;
  }
  const bestName = nameOf(res.best);
  const bestRow = res.rows.find((r) => String(r.p) === String(res.best));
  recoDesc.innerHTML = `Pick <strong>${escapeHtml(bestName)}</strong> — Δ2 ${bestRow.raw >= 0 ? "+" : ""}${bestRow.raw.toFixed(2)} into ${escapeHtml(nameOf(enemyId))}.`;
  recoGrid.innerHTML = res.rows.map((r) => champTile(r.p, ctx, {
    d2: r.raw,
    nodata: r.raw == null,
    best: String(r.p) === String(res.best) && r.raw != null,
    tag: String(r.p) === String(res.best) && r.raw != null ? "best" : undefined,
    isMain: r.isMain,
  })).join("");
  if (res.allLose) {
    draftFlag.hidden = false;
    draftFlag.innerHTML = `⚠ Your whole pool is behind into <strong>${escapeHtml(nameOf(enemyId))}</strong>. <strong>${escapeHtml(bestName)}</strong> is the least-bad at Δ2 ${bestRow.raw.toFixed(2)} — consider a ban or a flex pick.`;
  }
  return res.best;
}
