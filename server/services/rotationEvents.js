// rotationEvents.js -- builds ONE ROW PER CONFIRMED ROTATION PIVOT (every swing high/low) with the context around it and what came next.
// Built 2026-10-19 (user: "watchers watching every time the market reaches a high or low rotation ... records what it sees ... helps dial in setups and calibrations").
// Pure function over a session's 1-minute bars: reuses rotationDetector.detectRotationLegs() (the same validated 65pt reversal rule POC_ROTATION_JOIN and the Globex rotation badge use) -- never a
// reimplementation, so history and the live recorder agree by construction. Used by scripts/backfill_rotation_events_20261019.mjs (3.5y backfill, table rotation_events) and, later, a live recorder.
//
// Row meaning: leg k of the session starts at a PIVOT (anchorIdx: the swing low for an UP leg, the swing high for a DOWN leg) and is CONFIRMED R points later (idx). Feature columns use only bars up to the
// pivot bar (known by the time of confirmation); every column prefixed out_ looks AT/AFTER the confirmation bar and is an OUTCOME, never a feature (no lookahead into features).
import { detectRotationLegs, ROTATION_LEG_THRESHOLD } from './rotationDetector.js';

export const HORIZONS = [15, 30, 60, 120, 240];
export const VOL_WINDOW = 12;
const NEAR_ATR = 0.25;                        // a level counts as "at" a pivot within this many ATR20
const LONG_TERM = /^(PW_|PM_|PY_|3M_|10D_|5D_|WEEKLY_|MONTHLY_|WPP|WR\d|WS\d|MPP|MR\d|MS\d)/;
const sum = (b, from, to, key) => { let s = 0; for (let i = Math.max(0, from); i <= to; i++) s += b[i][key] || 0; return s; };
const ratio = (b, from, to) => { const a = sum(b, from, to, 'ask_volume'), d = sum(b, from, to, 'bid_volume'); return a + d > 0 ? (a - d) / (a + d) : null; };   // + = net buying
const minsBetween = (t1, t2) => Math.round((Date.parse(String(t2).replace(' ', 'T') + 'Z') - Date.parse(String(t1).replace(' ', 'T') + 'Z')) / 60000);   // both naive-as-UTC, so only the DIFFERENCE is meaningful

// bars: [{ts:'YYYY-MM-DD HH:MM:SS' naive ET, high, low, close, volume, bid_volume, ask_volume}] ordered ascending.
// ctx: { atr (ATR20 of the trade date), levels:[{n, p}] prior-period levels, volRef:{mean,std} | null  (12-bar volume-sum distribution of the trailing 20 same-type sessions) }
export function buildRotationEvents(bars, ctx, R = ROTATION_LEG_THRESHOLD) {
  const legs = detectRotationLegs(bars, R), out = [], atr = ctx.atr;
  let cumPV = 0, cumV = 0; const vwapAt = bars.map(b => { cumPV += b.close * (b.volume || 0); cumV += (b.volume || 0); return cumV > 0 ? cumPV / cumV : b.close; });
  const pivotPrice = (leg) => leg.dir === 'UP' ? bars[leg.anchorIdx].low : bars[leg.anchorIdx].high;
  legs.forEach((leg, k) => {
    const pIdx = leg.anchorIdx, cIdx = leg.idx, up = leg.dir === 'UP', dirNew = up ? 1 : -1, pp = pivotPrice(leg), cp = bars[cIdx].close;
    const prev = k > 0 ? legs[k - 1] : null, next = k + 1 < legs.length ? legs[k + 1] : null;
    const volSum = sum(bars, pIdx - VOL_WINDOW + 1, pIdx, 'volume');
    const near = (ctx.levels || []).map(l => ({ name: l.n, dist_atr: +((l.p - pp) / atr).toFixed(3) })).filter(x => Math.abs(x.dist_atr) <= NEAR_ATR).sort((a, b) => Math.abs(a.dist_atr) - Math.abs(b.dist_atr));
    const ret = {}; for (const h of HORIZONS) ret['out_ret_' + h] = cIdx + h < bars.length ? +(dirNew * (bars[cIdx + h].close - cp) / atr).toFixed(4) : null;
    let mfe = 0, mae = 0; const endIdx = Math.min(bars.length - 1, cIdx + 240); for (let i = cIdx + 1; i <= endIdx; i++) { mfe = Math.max(mfe, dirNew * ((up ? bars[i].high : bars[i].low) - cp)); mae = Math.max(mae, dirNew * (cp - (up ? bars[i].low : bars[i].high))); }
    out.push({
      leg_no: k + 1, pivot_type: up ? 'LOW' : 'HIGH', pivot_ts: bars[pIdx].ts, confirm_ts: bars[cIdx].ts, pivot_price: pp, confirm_price: cp, minutes_to_confirm: minsBetween(bars[pIdx].ts, bars[cIdx].ts), atr20: atr,
      prior_leg_pts: prev ? Math.abs(pp - pivotPrice(prev)) : null, prior_leg_minutes: prev ? minsBetween(bars[prev.anchorIdx].ts, bars[pIdx].ts) : null,
      vol_win_sum: volSum, vol_z: ctx.volRef && ctx.volRef.std > 0 ? +((volSum - ctx.volRef.mean) / ctx.volRef.std).toFixed(3) : null,
      flow12: ratio(bars, pIdx - VOL_WINDOW + 1, pIdx), prior_leg_flow: prev ? ratio(bars, prev.anchorIdx, pIdx) : null,
      vwap_dist_atr: +((pp - vwapAt[pIdx]) / atr).toFixed(3), stack_n: near.length, stack_long: near.filter(x => LONG_TERM.test(x.name)).length, near_levels: near.slice(0, 6),
      ...ret, out_mfe_240: +(mfe / atr).toFixed(4), out_mae_240: +(mae / atr).toFixed(4), out_full_240: cIdx + 240 < bars.length,
      out_leg_pts: next ? Math.abs(pivotPrice(next) - pp) : null, out_leg_minutes: next ? minsBetween(bars[pIdx].ts, bars[next.anchorIdx].ts) : null, out_leg_complete: !!next,
    });
  });
  return out;
}
