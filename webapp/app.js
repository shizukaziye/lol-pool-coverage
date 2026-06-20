// app.js — bootstrap: load data, wire DOM, react to input changes.

import * as ui from "./ui.js";
import * as store from "./storage.js";

const LANES = ["top", "jungle", "middle", "bottom", "support"];
const DEFAULT_STATE = () => ({
  pool: [],
  mains: [],
  banned: [],
  blindRate: 0.40,
  minPr: 1.5,
  minGames: 100,
  mainBuf: 1.0,
  extraRole: null,    // pool analysis: one extra enemy role to weigh (2 roles max)
  draftEnemies: {},   // draft mode: { role: enemy riot id } across up to 5 roles
});

const els = {
  laneTabs: document.getElementById("lane-tabs"),
  status: document.getElementById("status"),
  dataNotice: document.getElementById("data-notice"),

  poolChips: document.getElementById("pool-chips"),
  poolSearch: document.getElementById("pool-search"),
  poolResults: document.getElementById("pool-results"),

  bannedChips: document.getElementById("banned-chips"),
  bannedSearch: document.getElementById("banned-search"),
  bannedResults: document.getElementById("banned-results"),

  blindRate: document.getElementById("blind-rate"),
  blindRateVal: document.getElementById("blind-rate-val"),
  minPr: document.getElementById("min-pr"),
  minPrVal: document.getElementById("min-pr-val"),
  minGames: document.getElementById("min-games"),
  minGamesVal: document.getElementById("min-games-val"),
  mainBuf: document.getElementById("main-buf"),
  mainBufVal: document.getElementById("main-buf-val"),

  xroleBar: document.getElementById("xrole-bar"),
  xroleOpts: document.getElementById("xrole-opts"),

  worstTable: document.getElementById("worst-table"),
  addsTable: document.getElementById("adds-table"),
  addsTitle: document.getElementById("adds-title"),
  addsDesc: document.getElementById("adds-desc"),
  cutTable: document.getElementById("cut-table"),
  cutHint: document.getElementById("cut-hint"),
  blindTable: document.getElementById("blind-table"),
  blindPicksTable: document.getElementById("blindpicks-table"),
  usageBars: document.getElementById("usage-bars"),

  poolCta: document.getElementById("pool-cta"),
  loadExample: document.getElementById("load-example"),
  clearPool: document.getElementById("clear-pool"),
  footerFreshness: document.getElementById("footer-freshness"),
  patchBlend: document.getElementById("patch-blend"),
  patchBlendList: document.getElementById("patch-blend-list"),

  modeSwitch: document.querySelector(".mode-switch"),
  analyzeView: document.getElementById("analyze-view"),
  draftView: document.getElementById("draft-view"),
  draftEmpty: document.getElementById("draft-empty"),
  draftCols: document.getElementById("draft-cols"),
  enemySlots: document.getElementById("enemy-slots"),
  enemyPickerLabel: document.getElementById("enemy-picker-label"),
  enemySearch: document.getElementById("enemy-search"),
  enemyClear: document.getElementById("enemy-clear"),
  enemyGrid: document.getElementById("enemy-grid"),
  recoGrid: document.getElementById("reco-grid"),
  recoTitle: document.getElementById("reco-title"),
  recoDesc: document.getElementById("reco-desc"),
  draftFlag: document.getElementById("draft-flag"),
};

// ---------- DDragon ----------

// DDragon is Riot's official static-data CDN. We use it for two things:
//  - the version-agnostic riot_id ↔ slug ↔ name mapping (data/champion.json)
//  - champion portrait images (img/champion/{slug}.png, where slug is e.g.
//    "Aatrox", "MonkeyKing" — DDragon's `id` field, not the lowercase form)
//
// Caching: name+slug lookups rarely change, so we stash the map in
// localStorage and refresh once a day.

let ddragonVersion = "15.10.1"; // fallback if /api/versions.json fails
let ddragonChamps = {};         // riot_id (string) -> { slug, name }

async function fetchDDragonVersion() {
  try {
    const versions = await fetch("https://ddragon.leagueoflegends.com/api/versions.json").then((r) => r.json());
    if (Array.isArray(versions) && versions[0]) ddragonVersion = versions[0];
  } catch (e) {
    console.warn("DDragon version fetch failed, using fallback", e);
  }
}

const CHAMP_CACHE_KEY = "ddragon-champs-v1";
const CHAMP_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

async function fetchDDragonChampions() {
  // Hit localStorage first.
  try {
    const raw = localStorage.getItem(CHAMP_CACHE_KEY);
    if (raw) {
      const cached = JSON.parse(raw);
      if (cached.version === ddragonVersion && (Date.now() - cached.at) < CHAMP_CACHE_TTL_MS) {
        ddragonChamps = cached.map;
        return;
      }
    }
  } catch { /* fall through */ }

  try {
    const url = `https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/data/en_US/champion.json`;
    const d = await fetch(url).then((r) => r.json());
    // DDragon: { data: { Aatrox: { id: "Aatrox", key: "266", name: "Aatrox", ... }, ... } }
    const out = {};
    for (const slug of Object.keys(d.data || {})) {
      const entry = d.data[slug];
      out[String(entry.key)] = { slug: entry.id, name: entry.name };
    }
    ddragonChamps = out;
    try {
      localStorage.setItem(CHAMP_CACHE_KEY, JSON.stringify({ version: ddragonVersion, at: Date.now(), map: out }));
    } catch { /* quota; ignore */ }
  } catch (e) {
    console.warn("DDragon champion.json fetch failed", e);
  }
}

function iconUrl(slug) {
  if (!slug) return "";
  return `https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/champion/${slug}.png`;
}

// ---------- State ----------

let lane = store.loadLane();
if (!LANES.includes(lane)) lane = "top";

// Fill in fields added after a user's saved state was written (and migrate the
// old single-enemy draft field into the per-role map).
function normalizeState(s) {
  if (!s || typeof s !== "object") return DEFAULT_STATE();
  if (!s.draftEnemies || typeof s.draftEnemies !== "object") s.draftEnemies = {};
  if (s.draftEnemy) { s.draftEnemies[lane] = s.draftEnemy; delete s.draftEnemy; }
  if (s.extraRole === undefined) s.extraRole = null;
  return s;
}

let state = normalizeState(store.loadState(lane)) || DEFAULT_STATE();
let data = null;            // current weighted/{lane}.json
let rosters = null;         // data/rosters.json: { role: { rid: pr } } for all lanes
// Which enemy role's picker is shown in Draft mode (defaults to your lane).
// Not persisted — purely a UI focus.
let focusedRole = lane;
let dataSource = "none";    // "weighted" | "fixture" | "none" — drives empty-state copy
let patchesReg = null;      // parsed data/patches.json (patch registry w/ k_back)
let mode = "analyze";       // "analyze" | "draft"
let champs = null;          // { by_riot_id, by_slug } (synthesized if no champions.json)

function persist() { store.saveState(lane, state); }

// ---------- Data loading ----------

function setStatus(msg, cls = "") {
  els.status.textContent = msg;
  els.status.className = "status " + cls;
}

async function loadChampions() {
  // DDragon is the source of truth for riot_id ↔ slug ↔ display name.
  // Build a champs object in the same shape the rest of the app expects.
  if (Object.keys(ddragonChamps).length > 0) {
    const by_riot_id = {};
    const by_slug = {};
    for (const [rid, meta] of Object.entries(ddragonChamps)) {
      by_riot_id[rid] = { slug: meta.slug, name: meta.name };
      by_slug[meta.slug] = { riot_id: Number(rid), name: meta.name };
    }
    return { schema_version: 1, source: "ddragon", by_riot_id, by_slug };
  }
  // Optional override: a scraped champions.json (mostly useful offline).
  try {
    const c = await fetch("../data/champions.json").then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });
    return c;
  } catch {
    return null;
  }
}

function synthesizeChampions(laneData) {
  // Best-effort fallback: riot id -> { slug: "champ<id>", name: "Champion <id>" }
  // Only used if neither champions.json nor a known catalog is present.
  const by_riot_id = {};
  const by_slug = {};
  for (const id of Object.keys(laneData.tierlist || {})) {
    const slug = `champ${id}`;
    const name = `Champ ${id}`;
    by_riot_id[id] = { slug, name };
    by_slug[slug] = { riot_id: Number(id), name };
  }
  return { schema_version: 1, by_riot_id, by_slug };
}

async function loadLaneData() {
  const primary = `../data/weighted/${lane}.json`;
  const fallback = `./tests/fixtures/sample-${lane}.json`;
  try {
    const r = await fetch(primary);
    if (!r.ok) throw new Error(`${r.status}`);
    const j = await r.json();
    dataSource = "weighted";
    const p = j.source_patches && j.source_patches[0];
    setStatus(p ? `Patch ${p} · live data` : "Live data", "ok");
    return j;
  } catch (e) {
    console.warn(`No data/weighted/${lane}.json (${e.message}); trying fixture`);
    try {
      const r = await fetch(fallback);
      if (!r.ok) throw new Error(`${r.status}`);
      dataSource = "fixture";
      setStatus(`Sample data — weekly scrape hasn't run for ${lane}`, "warn");
      return await r.json();
    } catch (e2) {
      dataSource = "none";
      setStatus(`No data for ${lane}. Run the scraper or add a fixture.`, "bad");
      return null;
    }
  }
}

// ---------- Render ----------

function ctx() {
  const lookupByRiot = (id) => {
    if (champs?.by_riot_id?.[id]) return champs.by_riot_id[id];
    return null;
  };
  return {
    champByRiotId: lookupByRiot,
    iconUrl,
    allChampions: () => {
      // Champions available in this lane, sorted by PR desc, that have any data.
      if (!data) return [];
      const out = [];
      for (const id of Object.keys(data.tierlist)) {
        const meta = lookupByRiot(id) || { slug: `champ${id}`, name: `Champ ${id}` };
        out.push({ riot_id: id, slug: meta.slug, name: meta.name, pr: data.tierlist[id].pr ?? 0 });
      }
      out.sort((a, b) => b.pr - a.pr);
      return out;
    },
  };
}

function renderDataNotice() {
  if (!els.dataNotice) return;
  if (dataSource === "fixture") {
    els.dataNotice.className = "data-notice warn";
    els.dataNotice.innerHTML = `<strong>Showing sample data.</strong> The weekly meta scrape hasn't produced <code>data/weighted/${lane}.json</code> yet — numbers below come from a small built-in fixture, not live patch data.`;
    els.dataNotice.hidden = false;
  } else if (dataSource === "none") {
    els.dataNotice.className = "data-notice bad";
    els.dataNotice.innerHTML = `<strong>No data loaded.</strong> Neither live data (<code>data/weighted/${lane}.json</code>) nor a fixture was found for this lane. Run the scraper to populate it.`;
    els.dataNotice.hidden = false;
  } else {
    els.dataNotice.hidden = true;
    els.dataNotice.innerHTML = "";
  }
}

function renderPoolControls() {
  const empty = state.pool.length === 0;
  // Offer the example pool only when we actually have data to seed from.
  if (els.poolCta) els.poolCta.hidden = !(empty && !!data);
  if (els.clearPool) els.clearPool.hidden = empty;
}

function buildOpts() {
  return {
    pool: state.pool,
    mains: state.mains,
    banned: state.banned,
    buf: state.mainBuf ?? 1.0,
    blindRate: state.blindRate,
    minPr: state.minPr,
    minGames: state.minGames,
    // Pool analysis: at most one extra enemy role (2 roles total). Only honor it
    // when we actually have that role's roster loaded.
    extraRoles: state.extraRole && rosters?.rosters?.[state.extraRole] ? [state.extraRole] : [],
  };
}

// rosters.json gives every lane's champ list (rid -> pr) for the cross-role
// enemy pickers and threat weighting. Optional — cross-role just stays off if
// it's missing.
async function loadRosters() {
  try {
    const r = await fetch("../data/rosters.json");
    if (!r.ok) throw new Error(String(r.status));
    rosters = await r.json();
  } catch (e) {
    console.warn("rosters.json fetch failed; cross-role disabled", e);
    rosters = null;
  }
}

function rostersByRole() { return rosters?.rosters || null; }

function renderAll() {
  renderDataNotice();
  renderPoolControls();
  renderPatchBlend();
  const c = ctx();
  const opts = buildOpts();
  if (!data) {
    const msg = `<strong>No meta data yet.</strong> The weekly scrape hasn't run for this lane, and no fixture was found. Run the scraper to populate <code>data/weighted/${lane}.json</code>.`;
    for (const t of [els.worstTable, els.addsTable, els.cutTable, els.blindTable, els.blindPicksTable]) {
      t.innerHTML = `<tbody><tr><td class="empty-state no-data">${msg}</td></tr></tbody>`;
    }
    els.usageBars.innerHTML = `<div class="empty-state no-data">${msg}</div>`;
    els.cutHint.textContent = "";
    renderDraft(c, opts);
    return;
  }
  const mainsSet = new Set(state.mains);
  ui.renderChips(els.poolChips, state.pool, c, {
    onRemove: (id) => {
      state.pool = state.pool.filter((x) => x !== id);
      state.mains = state.mains.filter((x) => x !== id);
      persist(); renderAll();
    },
    onToggleMain: (id) => {
      if (mainsSet.has(id)) state.mains = state.mains.filter((x) => x !== id);
      else state.mains = [...state.mains, id];
      persist(); renderAll();
    },
    mainsSet,
    showMain: true,
  });
  ui.renderChips(els.bannedChips, state.banned, c, {
    onRemove: (id) => { state.banned = state.banned.filter((x) => x !== id); persist(); renderAll(); },
  });

  renderXroleBar();
  const rb = rostersByRole();
  ui.renderWorst(els.worstTable, data, opts, c, rb);
  const onAddCand = (id) => {
    if (!state.pool.includes(String(id))) state.pool = [...state.pool, String(id)];
    persist(); renderAll();
  };
  // With an extra enemy role enabled, "Best adds" becomes a pickrate-weighted
  // simulation over enemy comps (combinations matter); otherwise the standard
  // coverage ranking.
  if (state.extraRole && rb && rb[state.extraRole]) {
    const res = ui.renderComboAdds(els.addsTable, data, opts, c, onAddCand, rb);
    if (els.addsTitle) els.addsTitle.textContent = "Best adds — simulated vs the field";
    if (els.addsDesc) {
      const wr = (50 + (res?.baseExpected ?? 0)).toFixed(1);
      const roleNames = (res?.roles || []).map((r) => ROLE_LABEL[r] || r).join(" + ");
      els.addsDesc.innerHTML = `Over <strong>${(res?.comps ?? 0).toLocaleString()}</strong> pickrate-weighted enemy comps (${roleNames})${res && !res.exact ? " sampled" : ""}, ranked by how much each champ raises your best-pick win rate — counting only the comps where it'd actually be your pick. Your pool currently averages <strong>~${wr}%</strong> vs the field.`;
    }
  } else {
    ui.renderAdds(els.addsTable, data, opts, c, onAddCand, rb);
    if (els.addsTitle) els.addsTitle.textContent = "Best adds";
    if (els.addsDesc) els.addsDesc.textContent = "Champions that would most improve your coverage if you learned them.";
  }
  ui.renderCut(els.cutTable, els.cutHint, data, opts, c, rb);
  ui.renderBlind(els.blindTable, data, opts, c, rb);
  ui.renderBlindPicks(els.blindPicksTable, data, opts, c, (id) => {
    if (!state.pool.includes(String(id))) state.pool = [...state.pool, String(id)];
    persist(); renderAll();
  }, rb);
  ui.renderUsage(els.usageBars, data, opts, c, rb);
  renderDraft(c, opts);
}

// Cross-role control bar (pool analysis): your lane is always on; the user may
// add ONE other role, whose meta champs then join the threat lists. Rendered
// here (not static HTML) because the four options depend on the current lane.
const ROLE_LABEL = { top: "Top", jungle: "Jungle", middle: "Mid", bottom: "Bot", support: "Support" };
function renderXroleBar() {
  if (!els.xroleOpts) return;
  const haveRosters = !!rostersByRole();
  if (els.xroleBar) els.xroleBar.hidden = !haveRosters;
  if (!haveRosters) return;
  const others = LANES.filter((r) => r !== lane);
  els.xroleOpts.innerHTML = others
    .map((r) => `<button type="button" class="xrole-opt${state.extraRole === r ? " on" : ""}" data-role="${r}" aria-pressed="${state.extraRole === r}">+ ${ROLE_LABEL[r]}</button>`)
    .join("");
}

// ---------- Draft assistant ----------

function setMode(newMode) {
  mode = newMode === "draft" ? "draft" : "analyze";
  store.saveMode(mode);
  if (els.modeSwitch) {
    for (const b of els.modeSwitch.querySelectorAll(".mode-btn")) {
      const on = b.dataset.mode === mode;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    }
  }
  if (els.analyzeView) els.analyzeView.hidden = mode !== "analyze";
  if (els.draftView) els.draftView.hidden = mode !== "draft";
}

// Champ ids to offer in the picker for a given enemy role: your own lane comes
// from this lane's tierlist (full data); other roles come from rosters[role].
function roleChampions(role) {
  if (role === lane) return ctx().allChampions().map((x) => x.riot_id);
  const roster = rostersByRole()?.[role] || {};
  return Object.entries(roster).sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

function renderDraft(c, opts) {
  if (!els.draftView) return;
  const poolEmpty = !data || state.pool.length === 0;
  if (els.draftEmpty) els.draftEmpty.hidden = !poolEmpty;
  if (els.draftCols) els.draftCols.hidden = poolEmpty;
  if (poolEmpty) return;
  ui.renderEnemySlots(els.enemySlots, state.draftEnemies, focusedRole, lane, c, ROLE_LABEL);
  if (els.enemyPickerLabel) els.enemyPickerLabel.textContent = ROLE_LABEL[focusedRole] || focusedRole;
  ui.renderEnemyGrid(els.enemyGrid, roleChampions(focusedRole), c, state.draftEnemies[focusedRole], els.enemySearch ? els.enemySearch.value : "");
  if (els.enemyClear) els.enemyClear.hidden = !state.draftEnemies[focusedRole];
  ui.renderReco(els, data, opts, c, state.draftEnemies, rostersByRole());
}

function refreshDraft() { renderDraft(ctx(), buildOpts()); }

function wireDraft() {
  els.modeSwitch?.addEventListener("click", (e) => {
    const btn = e.target.closest(".mode-btn");
    if (!btn) return;
    setMode(btn.dataset.mode);
    if (mode === "draft") refreshDraft();
  });
  els.enemySearch?.addEventListener("input", () => {
    ui.renderEnemyGrid(els.enemyGrid, roleChampions(focusedRole), ctx(), state.draftEnemies[focusedRole], els.enemySearch.value);
  });
  // Enemy-team slots: click a slot to focus its role's picker; the × clears it.
  els.enemySlots?.addEventListener("click", (e) => {
    const clear = e.target.closest(".slot-clear");
    if (clear) {
      const role = clear.closest(".enemy-slot")?.dataset.role;
      if (role) { delete state.draftEnemies[role]; persist(); refreshDraft(); }
      return;
    }
    const slot = e.target.closest(".enemy-slot");
    if (slot && slot.dataset.role) {
      focusedRole = slot.dataset.role;
      if (els.enemySearch) els.enemySearch.value = "";
      refreshDraft();
    }
  });
  const pickEnemy = (tile) => {
    if (!tile) return;
    state.draftEnemies[focusedRole] = tile.dataset.id;
    persist();
    refreshDraft();
  };
  els.enemyGrid?.addEventListener("click", (e) => pickEnemy(e.target.closest(".champ-tile")));
  els.enemyGrid?.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    pickEnemy(e.target.closest(".champ-tile"));
  });
  els.enemyClear?.addEventListener("click", () => {
    delete state.draftEnemies[focusedRole]; persist(); refreshDraft();
  });
}

function wireXroleBar() {
  els.xroleOpts?.addEventListener("click", (e) => {
    const btn = e.target.closest(".xrole-opt");
    if (!btn) return;
    const role = btn.dataset.role;
    state.extraRole = state.extraRole === role ? null : role;
    persist(); renderAll();
  });
}

// ---------- Wiring ----------

function setActiveTab(activeLane) {
  for (const b of els.laneTabs.querySelectorAll(".lane-tab")) {
    const isActive = b.dataset.lane === activeLane;
    b.classList.toggle("active", isActive);
    b.setAttribute("aria-selected", isActive ? "true" : "false");
  }
}

function wireLaneTabs() {
  setActiveTab(lane);
  for (const btn of els.laneTabs.querySelectorAll(".lane-tab")) {
    btn.addEventListener("click", async () => {
      if (btn.dataset.lane === lane) return;
      lane = btn.dataset.lane;
      store.saveLane(lane);
      setActiveTab(lane);
      state = normalizeState(store.loadState(lane)) || DEFAULT_STATE();
      if (state.extraRole === lane) state.extraRole = null;
      focusedRole = lane;
      syncSettingsControls();
      data = await loadLaneData();
      attachSearches();
      renderAll();
    });
  }
}

function syncSettingsControls() {
  els.blindRate.value = Math.round(state.blindRate * 100);
  els.blindRateVal.textContent = `${els.blindRate.value}%`;
  els.minPr.value = state.minPr;
  els.minPrVal.textContent = Number(state.minPr).toFixed(1);
  els.minGames.value = state.minGames;
  els.minGamesVal.textContent = state.minGames;
  const buf = state.mainBuf ?? 1.0;
  if (els.mainBuf) els.mainBuf.value = buf;
  if (els.mainBufVal) els.mainBufVal.textContent = Number(buf).toFixed(1);
}

function wireSettings() {
  els.blindRate.addEventListener("input", () => {
    state.blindRate = Number(els.blindRate.value) / 100;
    els.blindRateVal.textContent = `${els.blindRate.value}%`;
    persist(); renderAll();
  });
  els.minPr.addEventListener("input", () => {
    state.minPr = Number(els.minPr.value);
    els.minPrVal.textContent = state.minPr.toFixed(1);
    persist(); renderAll();
  });
  els.minGames.addEventListener("input", () => {
    state.minGames = Number(els.minGames.value);
    els.minGamesVal.textContent = state.minGames;
    persist(); renderAll();
  });
  els.mainBuf?.addEventListener("input", () => {
    state.mainBuf = Number(els.mainBuf.value);
    els.mainBufVal.textContent = state.mainBuf.toFixed(1);
    persist(); renderAll();
  });
}

function examplePoolIds(n = 3) {
  // Top-N champions by pickrate in the current lane — guaranteed present in
  // this lane's data, so the example always works regardless of lane.
  if (!data || !data.tierlist) return [];
  return Object.entries(data.tierlist)
    .map(([id, info]) => ({ id, pr: info?.pr ?? 0 }))
    .sort((a, b) => b.pr - a.pr)
    .slice(0, n)
    .map((x) => x.id);
}

function wirePoolControls() {
  els.loadExample?.addEventListener("click", () => {
    const ids = examplePoolIds(3);
    if (ids.length === 0) return;
    // Merge into the pool through the same path add/remove uses, idempotently.
    const set = new Set(state.pool);
    for (const id of ids) set.add(String(id));
    state.pool = [...set];
    persist();
    renderAll();
  });
  els.clearPool?.addEventListener("click", () => {
    state.pool = [];
    state.mains = [];
    persist();
    renderAll();
  });
}

function attachSearches() {
  const c = ctx();
  // Pool search: only champs not already in pool.
  ui.attachSearch(els.poolSearch, els.poolResults, c, {
    onPick: (id) => {
      if (!state.pool.includes(id)) state.pool = [...state.pool, id];
      persist(); renderAll();
    },
    filter: (champ) => !state.pool.includes(String(champ.riot_id)),
  });
  ui.attachSearch(els.bannedSearch, els.bannedResults, c, {
    onPick: (id) => {
      if (!state.banned.includes(id)) state.banned = [...state.banned, id];
      persist(); renderAll();
    },
    filter: (champ) => !state.banned.includes(String(champ.riot_id)),
  });
}

// ---------- Patch registry, footer freshness, and patch blend ----------

async function loadPatchesRegistry() {
  try {
    patchesReg = await fetch("../data/patches.json").then((r) => {
      if (!r.ok) throw new Error(String(r.status));
      return r.json();
    });
  } catch (e) {
    console.warn("patches.json fetch failed", e);
    patchesReg = null;
  }
}

function renderFooterFreshness() {
  if (!els.footerFreshness) return;
  const reg = patchesReg;
  if (!reg) { els.footerFreshness.textContent = ""; return; }
  const current = reg.current_patch;
  const entry = Array.isArray(reg.patches)
    ? reg.patches.find((p) => p.patch === current) || reg.patches[0]
    : null;
  const parts = [];
  if (current) parts.push(`Patch ${current}`);
  const iso = entry?.scraped_at;
  if (iso) {
    const d = new Date(iso);
    if (!Number.isNaN(d.getTime())) parts.push(`data updated ${d.toISOString().slice(0, 10)}`);
  }
  els.footerFreshness.textContent = parts.join(" · ");
}

// Show which patches feed the current lane's blend and their 0.9^k weights.
// `data.source_patches` lists the patches that actually had data for this lane;
// k_back (and thus the weight) comes from the registry.
function renderPatchBlend() {
  if (!els.patchBlend || !els.patchBlendList) return;
  const sources = (data && Array.isArray(data.source_patches)) ? data.source_patches : [];
  if (sources.length === 0) { els.patchBlend.hidden = true; els.patchBlendList.innerHTML = ""; return; }
  const kByPatch = new Map();
  if (patchesReg && Array.isArray(patchesReg.patches)) {
    for (const p of patchesReg.patches) kByPatch.set(p.patch, p.k_back ?? 0);
  }
  // Order by k_back ascending (newest first); fall back to source order.
  const items = sources
    .map((patch, i) => ({ patch, k: kByPatch.has(patch) ? kByPatch.get(patch) : i }))
    .sort((a, b) => a.k - b.k)
    .map(({ patch, k }) => {
      const weightPct = Math.round(Math.pow(0.85, k) * 100);
      return `<span class="patch-chip" title="${k === 0 ? "Current patch — full weight" : `${k} patch${k === 1 ? "" : "es"} old — weighted 0.85^${k}`}"><strong>${patch}</strong> ${weightPct}%</span>`;
    });
  els.patchBlendList.innerHTML = items.join("");
  els.patchBlend.hidden = false;
}

// ---------- Boot ----------

(async function boot() {
  setStatus("Loading…");
  await fetchDDragonVersion();
  await fetchDDragonChampions();
  champs = await loadChampions();
  await loadPatchesRegistry();
  await loadRosters();
  data = await loadLaneData();
  if (data && !champs) champs = synthesizeChampions(data);
  // If we have lane data but champion meta is incomplete, fill from synthesizer.
  if (data && champs) {
    const synth = synthesizeChampions(data);
    for (const id of Object.keys(synth.by_riot_id)) {
      if (!champs.by_riot_id[id]) champs.by_riot_id[id] = synth.by_riot_id[id];
    }
  }
  mode = store.loadMode();
  syncSettingsControls();
  wireLaneTabs();
  wireSettings();
  wirePoolControls();
  wireDraft();
  wireXroleBar();
  attachSearches();
  setMode(mode);        // apply initial view visibility
  renderAll();
  renderFooterFreshness();
})();
