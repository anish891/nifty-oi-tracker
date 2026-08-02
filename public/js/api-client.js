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
  if (!json.ok || !json.topMatches) return [];
  return json.topMatches;
}
