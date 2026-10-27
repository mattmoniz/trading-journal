// Feature engineering for the volume-by-price + stationary-kinematics veto filter (docs/VBP_TREND_FILTER_PREREG_20261027.md).
// All features are evaluated at bar t-1 (t = the fired minute), from the SAME trade date's RTH session only, windows truncated to min(W, bars_elapsed).
export const FEATS = ['dPOC_Migration_30', 'Rolling_POC_Stretch_60', 'Doorstep_HVN_Density', 'Approach_Vol_Taper_Ratio', 'RVWAP_Spread_Against', 'LRMA_Slope_Against', 'R_Squared_20', 'LRMA_Stretch_Against'];
export const GROUP1 = FEATS.slice(0, 4), GROUP2 = FEATS.slice(4);
export const VETO_HI = { dPOC_Migration_30: true, Rolling_POC_Stretch_60: false, Doorstep_HVN_Density: true, Approach_Vol_Taper_Ratio: true, RVWAP_Spread_Against: true, LRMA_Slope_Against: true, R_Squared_20: true, LRMA_Stretch_Against: false }; // true: a HIGH value vetoes
const BIN = 1.0;
// volume profile of bars [a, b] (inclusive global indices): Map(bin -> volume), each bar's volume spread uniformly over the bins from floor(Low) to floor(High)
export function profile(NQ, a, b) {
  const m = new Map();
  for (let i = a; i <= b; i++) { const v = NQ.V[i] || 0; if (!(v > 0)) continue; const lo = Math.floor(NQ.L[i] / BIN), hi = Math.floor(NQ.H[i] / BIN), n = hi - lo + 1, w = v / n; for (let k = lo; k <= hi; k++) m.set(k, (m.get(k) || 0) + w); }
  return m;
}
export function pocOf(m) { let best = null, bv = -1; for (const [k, v] of m) if (v > bv || (v === bv && k < best)) { bv = v; best = k; } return best == null ? NaN : (best + 0.5) * BIN; }
// volume of a profile inside [lo, hi] price range with fractional bin overlap
export function zoneVol(m, lo, hi) { let s = 0; for (const [k, v] of m) { const a = k * BIN, b = a + BIN, ov = Math.min(b, hi) - Math.max(a, lo); if (ov > 0) s += v * (ov / BIN); } return s; }
export function atr14(NQ, s, t) { const a = Math.max(s, t - 14); let sum = 0, n = 0; for (let i = a; i < t; i++) { const pc = i > s ? NQ.C[i - 1] : null; const tr = pc == null ? NQ.H[i] - NQ.L[i] : Math.max(NQ.H[i] - NQ.L[i], Math.abs(NQ.H[i] - pc), Math.abs(NQ.L[i] - pc)); sum += tr; n++; } return Math.max(n ? sum / n : 0, 1e-6); }
export function regression(NQ, a, b) { // OLS of Close on x=0..m-1 over bars a..b
  const m = b - a + 1; let sx = 0, sy = 0; for (let k = 0; k < m; k++) { sx += k; sy += NQ.C[a + k]; } const xm = sx / m, ym = sy / m; let sxy = 0, sxx = 0, syy = 0;
  for (let k = 0; k < m; k++) { const dx = k - xm, dy = NQ.C[a + k] - ym; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  const slope = sxy / sxx, icpt = ym - slope * xm, r2 = syy > 0 ? Math.min(1, Math.max(0, (sxy * sxy) / (sxx * syy))) : 0; return { slope, icpt, r2, end: icpt + slope * (m - 1) };
}
// s = global index of the session's first bar (09:30), t = global index of the trade bar; bars s..t-1 are the information set
export function features(NQ, s, t, L, tradeDir) {
  const n = t - s; if (n < 5) return null; const AS = -tradeDir, ATR = atr14(NQ, s, t), last = t - 1, out = { ATR, n };
  const now = pocOf(profile(NQ, s, last)), lag = Math.min(30, n - 5); out.dPOC_Migration_30 = lag >= 3 ? AS * ((now - pocOf(profile(NQ, s, last - lag))) / ATR) : NaN;
  const W = Math.min(60, n), p60 = profile(NQ, t - W, last), tot = [...p60.values()].reduce((x, y) => x + y, 0);
  out.Rolling_POC_Stretch_60 = AS * ((NQ.C[last] - pocOf(p60)) / ATR);
  out.Doorstep_HVN_Density = tot > 0 ? zoneVol(p60, L - 0.5 * ATR, L + 0.5 * ATR) / tot : NaN;
  const W15 = Math.min(15, n), p15 = profile(NQ, t - W15, last), nearLo = tradeDir < 0 ? L - 0.5 * ATR : L, nearHi = tradeDir < 0 ? L : L + 0.5 * ATR, priLo = tradeDir < 0 ? L - ATR : L + 0.5 * ATR, priHi = tradeDir < 0 ? L - 0.5 * ATR : L + ATR;
  out.Approach_Vol_Taper_Ratio = (zoneVol(p15, nearLo, nearHi) + 1) / (zoneVol(p15, priLo, priHi) + 1);
  const rv = (w) => { const a = t - Math.min(w, n); let pv = 0, vv = 0; for (let i = a; i <= last; i++) { const v = NQ.V[i] || 0; pv += ((NQ.H[i] + NQ.L[i] + NQ.C[i]) / 3) * v; vv += v; } return vv > 0 ? pv / vv : NaN; };
  out.RVWAP_Spread_Against = AS * ((rv(30) - rv(60)) / ATR);
  const R = regression(NQ, t - Math.min(20, n), last); out.LRMA_Slope_Against = AS * (R.slope / ATR); out.R_Squared_20 = R.r2; out.LRMA_Stretch_Against = AS * ((NQ.C[last] - R.end) / ATR);
  return out;
}
// ---- statistics helpers
export const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
export const quant = (a, p) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1) + 1e-9)))] : NaN; };
export function mannWhitneyP(x, y) { // two-sided normal approximation with tie correction
  x = x.filter(Number.isFinite); y = y.filter(Number.isFinite); const n1 = x.length, n2 = y.length; if (n1 < 3 || n2 < 3) return NaN;
  const all = [...x.map((v) => [v, 0]), ...y.map((v) => [v, 1])].sort((a, b) => a[0] - b[0]); let r1 = 0, tie = 0; for (let i = 0; i < all.length;) { let j = i; while (j < all.length && all[j][0] === all[i][0]) j++; const rk = (i + j + 1) / 2, c = j - i; for (let k = i; k < j; k++) if (all[k][1] === 0) r1 += rk; tie += c * c * c - c; i = j; }
  const N = n1 + n2, u = r1 - (n1 * (n1 + 1)) / 2, mu = (n1 * n2) / 2, sd = Math.sqrt(((n1 * n2) / 12) * (N + 1 - tie / (N * (N - 1)))); if (!(sd > 0)) return NaN;
  const z = Math.abs(u - mu) / sd, erfc = (v) => { const t = 1 / (1 + 0.3275911 * v), p = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))); return p * Math.exp(-v * v); }; return erfc(z / Math.SQRT2);
}
export function perf(pnls) { // pnls in chronological order
  const n = pnls.length; if (!n) return { n: 0, wr: NaN, pf: NaN, net: 0, dd: 0, avg: NaN, sharpe: NaN }; let w = 0, gp = 0, gl = 0, cum = 0, pk = 0, dd = 0;
  for (const p of pnls) { if (p > 0) { w++; gp += p; } else gl += -p; cum += p; pk = Math.max(pk, cum); dd = Math.max(dd, pk - cum); }
  const av = cum / n, sd = Math.sqrt(pnls.reduce((s, p) => s + (p - av) ** 2, 0) / Math.max(1, n - 1)); return { n, wr: w / n, pf: gl > 0 ? gp / gl : Infinity, net: cum, dd, avg: av, sharpe: sd > 0 ? av / sd : NaN };
}
