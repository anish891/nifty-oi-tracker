const API = '/api/option-chain';

export async function fetchOptionChainData(selectedExpiry = null) {
  const url = selectedExpiry
    ? `${API}?expiry=${encodeURIComponent(selectedExpiry)}`
    : API;

  const r = await fetch(url);
  const json = await r.json();
  if (!json.ok) throw new Error(json.error);
  return json.data;
}

export async function fetchSimilarSessionsData() {
  const r = await fetch('/api/similar-sessions');
  const json = await r.json();
  if (!json.ok || !json.topMatches) return { topMatches: [], reason: json.error };
  return { topMatches: json.topMatches, reason: json.reason };
}

export async function fetchIntradayData(expiry) {
  const r = await fetch(`/api/intraday?expiry=${encodeURIComponent(expiry)}`);
  const json = await r.json();
  if (!json.ok) throw new Error(json.error);
  return json;
}

// Stored snapshots never change once written, so cache them for the life of the page.
const snapshotCache = new Map();

export async function fetchSnapshot(expiry, t) {
  const key = `${expiry}|${t}`;
  if (snapshotCache.has(key)) return snapshotCache.get(key);
  const r = await fetch(`/api/snapshot?expiry=${encodeURIComponent(expiry)}&t=${t}`);
  const json = await r.json();
  if (!json.ok) throw new Error(json.error);
  snapshotCache.set(key, json.strikes);
  if (snapshotCache.size > 120) snapshotCache.delete(snapshotCache.keys().next().value);
  return json.strikes;
}

export async function fetchStrikeHistory(expiry, strike) {
  const r = await fetch(`/api/strike-history?expiry=${encodeURIComponent(expiry)}&strike=${strike}`);
  const json = await r.json();
  if (!json.ok) throw new Error(json.error);
  return json;
}
