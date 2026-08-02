export function fmt(n) {
  if (n === undefined || n === null || isNaN(n)) return '—';
  return n.toLocaleString('en-IN');
}

export function fmtK(n) {
  if (!n && n !== 0) return '—';
  if (Math.abs(n) >= 100000) return (n / 100000).toFixed(2) + 'L';
  if (Math.abs(n) >= 1000) return (n / 1000).toFixed(1) + 'K';
  return n.toLocaleString('en-IN');
}

export function fmtChg(v) {
  if (v === undefined || v === null || isNaN(v)) return '—';
  return (v > 0 ? '+' : '') + fmtK(v);
}

export function pct(v, max) {
  return max > 0 ? Math.min(100, Math.round(Math.abs(v) / max * 100)) : 0;
}

export function timeStr(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// Ring buffer for strike tick history (last 8 ticks)
const tickHistory = {
  CE: {},
  PE: {}
};

export function updateTickHistory(strike, oi, price, isCall) {
  const targetMap = isCall ? tickHistory.CE : tickHistory.PE;
  if (!targetMap[strike]) targetMap[strike] = [];
  const history = targetMap[strike];

  history.push({ oi, price, ts: Date.now() });
  if (history.length > 8) history.shift();
}

export function buildupSingle(chgOI, chgPrice, isCall) {
  const oiUp = chgOI >= 0;
  const priceUp = isCall ? chgPrice >= 0 : chgPrice < 0;
  if (oiUp) return priceUp ? { label: 'LONG BUILD', cls: 'bd-lb' } : { label: 'SHORT BUILD', cls: 'bd-sb' };
  return priceUp ? { label: 'SHORT COV', cls: 'bd-sc' } : { label: 'LONG UNWD', cls: 'bd-lu' };
}

export function getSmoothedBuildup(strike, currentOI, currentPrice, isCall) {
  updateTickHistory(strike, currentOI, currentPrice, isCall);

  const history = isCall ? tickHistory.CE[strike] : tickHistory.PE[strike];
  if (!history || history.length < 2) {
    return buildupSingle(currentOI, 0, isCall);
  }

  const oldest = history[0];
  const newest = history[history.length - 1];

  const netOIChange = newest.oi - oldest.oi;
  const netPriceChange = newest.price - oldest.price;

  const oiTrend = netOIChange !== 0 ? netOIChange : (currentOI - (history[history.length - 2]?.oi || currentOI));
  const priceTrend = netPriceChange !== 0 ? netPriceChange : (currentPrice - (history[history.length - 2]?.price || currentPrice));

  return buildupSingle(oiTrend, priceTrend, isCall);
}
