// storage.js — localStorage helpers, namespaced per lane.

const PREFIX = "lol-pool-coverage";

function key(lane, name) {
  return `${PREFIX}:${lane}:${name}`;
}

export function loadState(lane) {
  const raw = localStorage.getItem(key(lane, "state"));
  if (!raw) return null;
  try { return JSON.parse(raw); }
  catch { return null; }
}

export function saveState(lane, state) {
  try {
    localStorage.setItem(key(lane, "state"), JSON.stringify(state));
  } catch (e) {
    console.warn("storage write failed", e);
  }
}

export function loadLane() {
  return localStorage.getItem(`${PREFIX}:lane`) || "top";
}

export function saveLane(lane) {
  localStorage.setItem(`${PREFIX}:lane`, lane);
}

export function loadMode() {
  return localStorage.getItem(`${PREFIX}:mode`) || "analyze";
}

export function saveMode(mode) {
  localStorage.setItem(`${PREFIX}:mode`, mode);
}
