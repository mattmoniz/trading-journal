// Symmetric causal DAY STATE (workplan items F/G, docs/WORKPLAN_20261109.md; design: Argon round 14 + the 2026-11-09 audits). Answers one question at every closed 1-minute bar:
// is the session in a LIQUIDATION (down) or a MELT-UP (up), or neither? States: WARMUP | NORMAL | DOWN_EARLY | DOWN_CONFIRMED | UP_EARLY | UP_CONFIRMED.
// Pure functions only (no DB, no clock): the live service and the historical replay both call evaluateSession(), so what was replayed is what runs live (hr-022).
// No static market thresholds (hr-003): every cutoff is the Q-quantile of PRIOR sessions' maxima of a z-score that is itself taken against the prior sessions at the SAME minute
// of the session; ranges are in units of the mean range of the prior ATR_N sessions. Design parameters (window sizes, Q) are named constants below, not market numbers.
// Two sessions are evaluated separately (hr-002): RTH (09:30-15:59 ET) and GLOBEX (18:00-09:29 ET, keyed to the CME date = date of ts + 6h). Bars are
// { t: 'YYYY-MM-DD HH:MM' (ET wall time), mod (minutes of day), high, low, close }, chronological.
export const PARAMS = Object.freeze({
  ATR_N: 20,        // prior sessions averaged for the range / initial-balance scale
  Z_N: 60,          // prior sessions in the same-minute z baseline
  Z_MIN: 40,        // minimum prior sessions for a z-score / a cutoff (before that: WARMUP)
  CUT_N: 120,       // the cutoffs use the maxima of the last CUT_N prior sessions (rolling, not expanding: the box/range ratios drift, Argon web critique 2026-11-09)
  Q: 0.97,          // cutoff quantile of prior session maxima (rolling CUT_N window): the ONE free design parameter, set from the replay to an overall alarm rate of ~12% of RTH and ~9% of Globex sessions (an expanding 0.95 gave 14%/10%, a rolling 0.95 gave 18%/14%); chosen by alarm rate, not by any trading result
  IB_END_M: 60,     // initial balance / opening balance = first 60 minutes of the session
  CONFIRM_FROM_M: 64, // D2 (extension past the balance, no re-entry) can fire from here: 5 bars after the balance
  FIRST_M: { RTH: 5, GLOBEX: 30 }, // D1 can fire from here (enough bars for a running extreme to mean something)
  MIN_BARS: { RTH: 200, GLOBEX: 400 }, // a prior session needs this many bars to count as valid
});

export function assignSession(t, mod) {
  if (mod >= 570 && mod <= 959) return { kind: 'RTH', key: t.slice(0, 10), m: mod - 570 };
  if (mod >= 1080 || mod < 570) {
    const d = new Date(t.slice(0, 10) + 'T12:00:00Z');
    if (mod >= 1080) d.setUTCDate(d.getUTCDate() + 1);   // an evening bar belongs to the NEXT calendar date's CME session; a morning bar belongs to its own date
    return { kind: 'GLOBEX', key: d.toISOString().slice(0, 10), m: mod >= 1080 ? mod - 1080 : mod + 360 };
  }
  return null;   // 16:00-17:59 ET: settlement hour and CME halt belong to no session
}
export function buildSessions(bars) {
  const map = new Map();
  for (const b of bars) {
    const a = assignSession(b.t, b.mod); if (!a) continue;
    const id = `${a.kind}|${a.key}`;
    if (!map.has(id)) map.set(id, { kind: a.kind, key: a.key, bars: [] });
    map.get(id).bars.push({ m: a.m, t: b.t, high: b.high, low: b.low, close: b.close });
  }
  const out = [...map.values()];
  for (const s of out) s.bars.sort((x, y) => x.m - y.m);
  return out.sort((x, y) => (x.kind === y.kind ? x.key.localeCompare(y.key) : x.kind.localeCompare(y.kind)));
}
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const quantile = (arr, q) => { const s = [...arr].sort((x, y) => x - y), pos = (s.length - 1) * q, lo = Math.floor(pos), r = pos - lo; return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * r; };
const isValid = (s) => s.bars.length >= PARAMS.MIN_BARS[s.kind];
export const isValidSession = isValid;

/** Raw per-bar series of one session given its scale (atr = mean range of prior sessions, ib20 = mean balance range of prior sessions). */
function rawSeries(sess, atr, ib20) {
  const n = sess.bars.length, dd = new Array(n), ru = new Array(n), s2d = new Array(n).fill(0), s2u = new Array(n).fill(0), ibHs = new Array(n), ibLs = new Array(n);
  let rh = -Infinity, rl = Infinity, ibH = -Infinity, ibL = Infinity;
  for (let i = 0; i < n; i++) {
    const b = sess.bars[i]; rh = Math.max(rh, b.high); rl = Math.min(rl, b.low);
    if (b.m < PARAMS.IB_END_M) { ibH = Math.max(ibH, b.high); ibL = Math.min(ibL, b.low); }
    ibHs[i] = ibH; ibLs[i] = ibL;   // the balance as known AT this bar (running during the first hour, final after it): nothing from a later bar is ever read
    dd[i] = atr ? (rh - b.close) / atr : null; ru[i] = atr ? (b.close - rl) / atr : null;
    if (b.m >= PARAMS.CONFIRM_FROM_M && ib20 && i >= 4 && sess.bars[i - 4].m === b.m - 4) {   // a feed gap inside the 5-bar window disables D2 for that bar instead of stretching the window
      const w = sess.bars.slice(i - 4, i + 1), h5 = Math.max(...w.map((x) => x.high)), l5 = Math.min(...w.map((x) => x.low));
      if (h5 < ibL) s2d[i] = (ibL - b.close) / ib20;
      if (l5 > ibH) s2u[i] = (b.close - ibH) / ib20;
    }
  }
  return { dd, ru, s2d, s2u, ibH, ibL, ibHs, ibLs };
}

/** Evaluate ONE session `s` against `prior` (the earlier sessions of the same kind, chronological, each already passed through evaluateSession so it carries .raw/.rawIdx/.maxima).
 *  Sets s.raw/s.rawIdx/s.maxima (so s can serve as prior for later ones) and returns { kind, key, bars, atr, ib20, cut, states, z1d, z1u, s2d, s2u, ibL, ibH, valid }.
 *  `s` may be a partial live session: its cutoffs come only from `prior` and nothing after its last bar is read. */
export function evaluateSession(s, prior, opts = {}) {
  const kind = s.kind, Q = opts.q ?? PARAMS.Q;
  const priorValid = prior.filter(isValid);
  const atrSessions = priorValid.slice(-PARAMS.ATR_N);
  const full = atrSessions.length >= PARAMS.ATR_N;
  const atr = full ? mean(atrSessions.map((p) => Math.max(...p.bars.map((b) => b.high)) - Math.min(...p.bars.map((b) => b.low)))) : null;
  const ib20 = full ? mean(atrSessions.map((p) => { const ib = p.bars.filter((b) => b.m < PARAMS.IB_END_M); return Math.max(...ib.map((b) => b.high)) - Math.min(...ib.map((b) => b.low)); })) : null;
  const raw = rawSeries(s, atr, ib20);
  const base = priorValid.slice(-PARAMS.Z_N);
  const mu = (arrKey, m) => {
    const v = base.map((p) => { const j = p.rawIdx.get(m); return j === undefined ? null : p.raw[arrKey][j]; }).filter((x) => x != null);
    if (v.length < PARAMS.Z_MIN) return null;
    const m0 = mean(v); return { mu: m0, sd: Math.sqrt(mean(v.map((x) => (x - m0) ** 2))) };
  };
  const z1d = new Array(s.bars.length).fill(null), z1u = new Array(s.bars.length).fill(null);
  if (atr) for (let k = 0; k < s.bars.length; k++) {
    const m = s.bars[k].m; if (m < PARAMS.FIRST_M[kind]) continue;
    const bd = mu('dd', m), bu = mu('ru', m);
    if (bd && bd.sd > 0) z1d[k] = (raw.dd[k] - bd.mu) / bd.sd;
    if (bu && bu.sd > 0) z1u[k] = (raw.ru[k] - bu.mu) / bu.sd;
  }
  s.raw = raw; s.rawIdx = new Map(s.bars.map((b, k) => [b.m, k]));
  const pm = priorValid.slice(-PARAMS.CUT_N).map((p) => p.maxima).filter((x) => x && Number.isFinite(x.z1d) && Number.isFinite(x.z1u));
  const cut = pm.length >= PARAMS.Z_MIN ? { c1d: quantile(pm.map((x) => x.z1d), Q), c1u: quantile(pm.map((x) => x.z1u), Q), c2d: quantile(pm.map((x) => x.s2d), Q), c2u: quantile(pm.map((x) => x.s2u), Q) } : null;
  const mx = (arr) => arr.reduce((a, v) => (v != null && v > a ? v : a), -Infinity);
  s.maxima = isValid(s) && atr ? { z1d: mx(z1d), z1u: mx(z1u), s2d: Math.max(0, ...raw.s2d), s2u: Math.max(0, ...raw.s2u) } : null;
  const states = new Array(s.bars.length).fill('WARMUP'); let st = 'NORMAL', blockedRearm = false, checkedConfirm = false;
  for (let k = 0; k < s.bars.length; k++) {
    if (!cut || !atr || !ib20) { states[k] = 'WARMUP'; continue; }
    const b = s.bars[k], m = b.m, down = st.startsWith('DOWN'), up = st.startsWith('UP'), ibL = raw.ibLs[k], ibH = raw.ibHs[k];
    const d1d = z1d[k] != null && z1d[k] > cut.c1d, d1u = z1u[k] != null && z1u[k] > cut.c1u, d2d = raw.s2d[k] > cut.c2d && raw.s2d[k] > 0, d2u = raw.s2u[k] > cut.c2u && raw.s2u[k] > 0;
    if (st === 'NORMAL') {
      if (m < PARAMS.CONFIRM_FROM_M && !blockedRearm) { if (d1d) st = 'DOWN_EARLY'; else if (d1u) st = 'UP_EARLY'; }
      if (d2d) st = 'DOWN_CONFIRMED'; else if (d2u) st = 'UP_CONFIRMED';
    } else if (down || up) {
      // The opposite side takes over only when the CURRENT alarm has lapsed and the opposite one is on (hysteresis: with both on, or flickering around one cutoff, the state holds, so a sharp bounce
      // cannot flip DOWN / UP every bar). A V-reversal therefore goes straight DOWN -> UP with no NORMAL bar in between.
      const flipUp = down && (m >= PARAMS.CONFIRM_FROM_M ? (d2u && !d2d) : (d1u && !d1d)), flipDown = up && (m >= PARAMS.CONFIRM_FROM_M ? (d2d && !d2u) : (d1d && !d1u));
      if (flipUp) st = m >= PARAMS.CONFIRM_FROM_M ? 'UP_CONFIRMED' : 'UP_EARLY';
      else if (flipDown) st = m >= PARAMS.CONFIRM_FROM_M ? 'DOWN_CONFIRMED' : 'DOWN_EARLY';
      else if (st === 'DOWN_EARLY' && d2d) st = 'DOWN_CONFIRMED';
      else if (st === 'UP_EARLY' && d2u) st = 'UP_CONFIRMED';
      // the early alarm is tentative and is judged ONCE, at the first bar at or after CONFIRM_FROM_M (not on an exact minute that may be missing): if the close has not left the balance, it was false
      else if (m >= PARAMS.CONFIRM_FROM_M && !checkedConfirm && st === 'DOWN_EARLY' && b.close >= ibL) { st = 'NORMAL'; blockedRearm = true; }
      else if (m >= PARAMS.CONFIRM_FROM_M && !checkedConfirm && st === 'UP_EARLY' && b.close <= ibH) { st = 'NORMAL'; blockedRearm = true; }
      // back inside a balance that EXISTS (after the first hour) AND the drawdown / run-up z is below its alarm level. Before minute IB_END_M this test would be a tautology (a close is always >= the running low), which used to cancel the alarm on the first dip.
      else if (m >= PARAMS.IB_END_M && down && b.close >= ibL && !(z1d[k] != null && z1d[k] > cut.c1d)) { st = 'NORMAL'; blockedRearm = true; }
      else if (m >= PARAMS.IB_END_M && up && b.close <= ibH && !(z1u[k] != null && z1u[k] > cut.c1u)) { st = 'NORMAL'; blockedRearm = true; }
    }
    if (m >= PARAMS.CONFIRM_FROM_M) checkedConfirm = true;
    states[k] = st;
  }
  return { kind, key: s.key, bars: s.bars, atr, ib20, cut, states, z1d, z1u, s2d: raw.s2d, s2u: raw.s2u, ibL: raw.ibL, ibH: raw.ibH, valid: isValid(s) };
}

/** Evaluate every session (the replay path): each session sees only the earlier sessions of its own kind. */
export function evaluateDayStates(sessions, opts = {}) {
  const results = [];
  for (const kind of ['RTH', 'GLOBEX']) {
    const list = sessions.filter((s) => s.kind === kind && s.bars.length >= 1);
    for (let i = 0; i < list.length; i++) results.push(evaluateSession(list[i], list.slice(0, i), opts));
  }
  return results;
}
/** First bar at which a session entered any non-NORMAL, non-WARMUP state (the causal activation is the NEXT minute), or null. */
export function firstActive(r) { for (let k = 0; k < r.states.length; k++) if (r.states[k] !== 'NORMAL' && r.states[k] !== 'WARMUP') return { k, t: r.bars[k].t, state: r.states[k] }; return null; }
export const isLiquidationState = (st) => st === 'DOWN_EARLY' || st === 'DOWN_CONFIRMED';
export const isMeltUpState = (st) => st === 'UP_EARLY' || st === 'UP_CONFIRMED';
