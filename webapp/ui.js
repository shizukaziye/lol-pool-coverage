// ui.js — DOM rendering for panels, tables, chips, charts.

import {
  worstMatchups, candidateScores, cutAnalysis,
  blindScores, usageSimulation,
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
      li.addEventListener("mousedown", (ev) => { ev.preventDefault(); onPick?.(li.dataset.id); input.value = ""; close(); });
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
  let html = `<thead><tr><th>Counter</th><th class="num">PR%</th><th>Eff Δ2</th><th>By</th>`;
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

export function renderAdds(table, data, opts, ctx) {
  const rows = candidateScores(data, opts).slice(0, 25);
  if (rows.length === 0 || rows.every((r) => r.score === 0)) {
    table.innerHTML = `<tbody><tr><td class="empty-state">No candidates score above 0 — either your pool covers everything or there's no data.</td></tr></tbody>`;
    return;
  }
  let html = `<thead><tr><th>Candidate</th><th class="num">Score</th><th>Handles (top 4)</th></tr></thead><tbody>`;
  for (const r of rows) {
    if (r.score <= 0) continue;
    const contribs = r.contributors.map((c) => `<span class="c-item">${champCell(c.counter, ctx)} <span class="d2-neg">${fmt(c.contribution, 2)}</span></span>`).join("");
    html += `<tr><td>${champCell(r.cand, ctx)}</td><td class="num">${fmt(r.score, 2)}</td><td class="contribs">${contribs}</td></tr>`;
  }
  html += `</tbody>`;
  table.innerHTML = html;
}

export function renderCut(table, hint, data, opts, ctx) {
  const rows = cutAnalysis(data, opts);
  if (rows.length === 0) {
    table.innerHTML = `<tbody><tr><td class="empty-state">Add pool champions to see cut analysis.</td></tr></tbody>`;
    hint.textContent = "";
    return;
  }
  const sortedByUnique = [...rows].sort((a, b) => a.unique - b.unique);
  const safestCut = sortedByUnique[0];
  const mustKeep = [...rows].sort((a, b) => b.unique - a.unique)[0];
  let html = `<thead><tr><th>Champ</th><th class="num">Unique value</th><th class="num">Best for #</th><th class="num">Blind</th><th></th></tr></thead><tbody>`;
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
    hint.innerHTML = `Safest cut: <strong>${escapeHtml(sCutMeta ? sCutMeta.name : safestCut.p)}</strong> · Must keep: <strong>${escapeHtml(mKeepMeta ? mKeepMeta.name : mustKeep.p)}</strong>`;
  } else hint.textContent = "";
}

export function renderBlind(table, data, opts, ctx) {
  const rows = blindScores(data, opts);
  if (rows.length === 0) {
    table.innerHTML = `<tbody><tr><td class="empty-state">Add pool champions to see blind safety.</td></tr></tbody>`;
    return;
  }
  let html = `<thead><tr><th>Champ</th><th class="num">Blind (raw)</th><th class="num">Avg Δ2 (PR-weighted)</th></tr></thead><tbody>`;
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
