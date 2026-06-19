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
});

const els = {
  laneTabs: document.getElementById("lane-tabs"),
  status: document.getElementById("status"),

  poolChips: document.getElementById("pool-chips"),
  poolSearch: document.getElementById("pool-search"),
  poolResults: document.getElementById("pool-results"),

  mainsList: document.getElementById("mains-list"),

  bannedChips: document.getElementById("banned-chips"),
  bannedSearch: document.getElementById("banned-search"),
  bannedResults: document.getElementById("banned-results"),

  blindRate: document.getElementById("blind-rate"),
  blindRateVal: document.getElementById("blind-rate-val"),
  minPr: document.getElementById("min-pr"),
  minPrVal: document.getElementById("min-pr-val"),
  minGames: document.getElementById("min-games"),
  minGamesVal: document.getElementById("min-games-val"),

  worstTable: document.getElementById("worst-table"),
  addsTable: document.getElementById("adds-table"),
  cutTable: document.getElementById("cut-table"),
  cutHint: document.getElementById("cut-hint"),
  blindTable: document.getElementById("blind-table"),
  usageBars: document.getElementById("usage-bars"),
};

// ---------- DDragon ----------

let ddragonVersion = "14.1.1"; // fallback
async function fetchDDragonVersion() {
  try {
    const versions = await fetch("https://ddragon.leagueoflegends.com/api/versions.json").then((r) => r.json());
    if (Array.isArray(versions) && versions[0]) ddragonVersion = versions[0];
  } catch (e) {
    console.warn("DDragon version fetch failed, using fallback", e);
  }
}
function iconUrl(slug) {
  // DDragon uses CapitalCase slugs for some champs (e.g. "MonkeyKing"). Our
  // data uses lowercase slugs, but the typical mapping for the first version
  // is `champion/<Cap>.png`. As a pragmatic default, capitalize first letter.
  const cap = slug.charAt(0).toUpperCase() + slug.slice(1);
  return `https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/champion/${cap}.png`;
}

// ---------- State ----------

let lane = store.loadLane();
if (!LANES.includes(lane)) lane = "top";

let state = store.loadState(lane) || DEFAULT_STATE();
let data = null;            // current weighted/{lane}.json
let champs = null;          // { by_riot_id, by_slug } (synthesized if no champions.json)

function persist() { store.saveState(lane, state); }

// ---------- Data loading ----------

function setStatus(msg, cls = "") {
  els.status.textContent = msg;
  els.status.className = "status " + cls;
}

async function loadChampions() {
  // Try real champions.json; if missing, synthesize from the lane data using slugs
  // = lowercase name (best-effort) — but we'd rather have the real one.
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
    setStatus(`Loaded ${lane} from data/weighted/`, "");
    return await r.json();
  } catch (e) {
    console.warn(`No data/weighted/${lane}.json (${e.message}); trying fixture`);
    try {
      const r = await fetch(fallback);
      if (!r.ok) throw new Error(`${r.status}`);
      setStatus(`Using fixture: ${fallback}`, "warn");
      return await r.json();
    } catch (e2) {
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

function renderAll() {
  if (!data) {
    for (const t of [els.worstTable, els.addsTable, els.cutTable, els.blindTable]) {
      t.innerHTML = `<tbody><tr><td class="empty-state">No data loaded.</td></tr></tbody>`;
    }
    els.usageBars.innerHTML = `<div class="empty-state">No data loaded.</div>`;
    return;
  }
  const c = ctx();
  const mainsSet = new Set(state.mains);
  const opts = {
    pool: state.pool,
    mains: state.mains,
    banned: state.banned,
    buf: 1.0,
    blindRate: state.blindRate,
    minPr: state.minPr,
    minGames: state.minGames,
  };
  ui.renderChips(els.poolChips, state.pool, c, {
    onRemove: (id) => {
      state.pool = state.pool.filter((x) => x !== id);
      state.mains = state.mains.filter((x) => x !== id);
      persist(); renderAll();
    },
    mainsSet,
  });
  ui.renderChips(els.bannedChips, state.banned, c, {
    onRemove: (id) => { state.banned = state.banned.filter((x) => x !== id); persist(); renderAll(); },
  });
  ui.renderMains(els.mainsList, state.pool, mainsSet, c, (id) => {
    if (mainsSet.has(id)) state.mains = state.mains.filter((x) => x !== id);
    else state.mains = [...state.mains, id];
    persist(); renderAll();
  });

  ui.renderWorst(els.worstTable, data, opts, c);
  ui.renderAdds(els.addsTable, data, opts, c);
  ui.renderCut(els.cutTable, els.cutHint, data, opts, c);
  ui.renderBlind(els.blindTable, data, opts, c);
  ui.renderUsage(els.usageBars, data, opts, c);
}

// ---------- Wiring ----------

function wireLaneTabs() {
  for (const btn of els.laneTabs.querySelectorAll(".lane-tab")) {
    btn.classList.toggle("active", btn.dataset.lane === lane);
    btn.addEventListener("click", async () => {
      if (btn.dataset.lane === lane) return;
      lane = btn.dataset.lane;
      store.saveLane(lane);
      for (const b of els.laneTabs.querySelectorAll(".lane-tab")) {
        b.classList.toggle("active", b.dataset.lane === lane);
      }
      state = store.loadState(lane) || DEFAULT_STATE();
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

// ---------- Boot ----------

(async function boot() {
  setStatus("Loading…");
  await fetchDDragonVersion();
  champs = await loadChampions();
  data = await loadLaneData();
  if (data && !champs) champs = synthesizeChampions(data);
  // If we have lane data but champion meta is incomplete, fill from synthesizer.
  if (data && champs) {
    const synth = synthesizeChampions(data);
    for (const id of Object.keys(synth.by_riot_id)) {
      if (!champs.by_riot_id[id]) champs.by_riot_id[id] = synth.by_riot_id[id];
    }
  }
  syncSettingsControls();
  wireLaneTabs();
  wireSettings();
  attachSearches();
  renderAll();
})();
