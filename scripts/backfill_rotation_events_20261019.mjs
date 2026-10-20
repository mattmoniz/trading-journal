// backfill_rotation_events_20261019.mjs -- fills rotation_events (one row per confirmed 65pt rotation pivot, RTH and GLOBEX sessions separately) over 3.5 years via
// server/services/rotationEvents.js (the SAME pure function a live recorder will use). Insert-only (ON CONFLICT DO NOTHING). Dry-run unless --write.
// Sessions: RTH = 09:30-15:59 of trade date D; GLOBEX = 18:00 ET previous calendar evening .. 09:29 D (>=90% of 930 minutes). Needs 20 prior RTH sessions for ATR20 and 20 prior same-type sessions for the volume reference.
// roll_gap_day = PD_CLOSE disagrees with the prior session's last close by >0.1 ATR20 (quarterly roll): kept but flagged, consumers should exclude.
// Run: node scripts/backfill_rotation_events_20261019.mjs [from] [to] [--write]
import { query } from '../server/db.js';
import { buildRotationEvents, VOL_WINDOW } from '../server/services/rotationEvents.js';
const WRITE = process.argv.includes('--write'), args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const FROM = args[0] || '2023-03-06', TO = args[1] || '2026-10-16';
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length; const addDay = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const USE = /^(PD_|PW_|PM_|PY_|3M_|10D_|5D_|CAM_|FLOOR_|ONH$|ONL$|WPP|WR\d|WS\d|MPP|MR\d|MS\d|WEEKLY_OPEN|MONTHLY_OPEN|WEEKLY_VWAP|MONTHLY_VWAP)/;
const eve = new Map(), mor = new Map(), rth = new Map();
let cur = new Date(FROM + 'T00:00:00Z'); cur.setUTCDate(cur.getUTCDate() - 45); const end = new Date(TO + 'T00:00:00Z'); end.setUTCDate(end.getUTCDate() + 1);
while (cur < end) { const nxt = new Date(cur); nxt.setUTCDate(nxt.getUTCDate() + 31);
  for (const x of (await query(`SELECT ts::date::text d, ts::text ts, (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts))::int m, high::float high, low::float low, close::float close, COALESCE(volume,0)::float volume, COALESCE(bid_volume,0)::float bid_volume, COALESCE(ask_volume,0)::float ask_volume FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1::date AND ts < $2::date ORDER BY ts`, [cur.toISOString().slice(0, 10), nxt.toISOString().slice(0, 10)])).rows) {
    const t = x.m >= 1080 ? eve : x.m < 570 ? mor : x.m < 960 ? rth : null; if (!t) continue; (t.get(x.d) || t.set(x.d, []).get(x.d)).push(x); } cur = nxt; }
const rthDates = [...rth.keys()].filter(d => rth.get(d).length > 60).sort();
const atrOf = new Map(); { const rng = []; for (const d of rthDates) { if (rng.length >= 20) atrOf.set(d, mean(rng.slice(-20))); const b = rth.get(d); rng.push(Math.max(...b.map(x => x.high)) - Math.min(...b.map(x => x.low))); } }
const lv = new Map(); for (const r of (await query(`SELECT trade_date::text d, level_name n, price::float p FROM level_prices WHERE trade_date BETWEEN $1::date AND $2::date AND price IS NOT NULL`, [FROM, TO])).rows) (lv.get(r.d) || lv.set(r.d, []).get(r.d)).push(r);
const sums12 = (b) => { const out = []; for (let i = VOL_WINDOW - 1; i < b.length; i++) { let v = 0; for (let k = i - VOL_WINDOW + 1; k <= i; k++) v += b[k].volume; out.push(v); } return out; };
const ref = { RTH: [], GLOBEX: [] }; const rows = []; const stats = { RTH: 0, GLOBEX: 0, sparse: 0, roll: 0, noAtr: 0 };
for (let di = 0; di < rthDates.length; di++) {
  const D = rthDates[di], atr = atrOf.get(D), L = lv.get(D) || [], prevD = rthDates[di - 1], pdc = L.find(x => x.n === 'PD_CLOSE');
  const rollGap = !!(pdc && prevD && atr && Math.abs(pdc.p - rth.get(prevD)[rth.get(prevD).length - 1].close) > 0.1 * atr);
  const dow = new Date(D + 'T12:00:00Z').getUTCDay();
  for (const type of ['RTH', 'GLOBEX']) {
    const b = type === 'RTH' ? (rth.get(D) || []) : [...(eve.get(addDay(D, -1)) || []), ...(mor.get(D) || [])], r = ref[type];
    if (D >= FROM && D <= TO && b.length >= VOL_WINDOW + 5 && !(type === 'GLOBEX' && b.length < 0.9 * 930) && !(type === 'GLOBEX' && false)) {
      if (!atr || r.length < 20) stats.noAtr++;
      else { stats[type]++; if (rollGap) stats.roll++;
        const allV = r.slice(-20).flat(), vm = mean(allV), vsd = Math.sqrt(mean(allV.map(x => (x - vm) ** 2)));
        for (const e of buildRotationEvents(b, { atr, levels: L.filter(x => USE.test(x.n)).map(x => ({ n: x.n, p: x.p })), volRef: { mean: vm, std: vsd } }))
          rows.push({ ...e, session: type, trade_date: D, dow, roll_gap_day: rollGap, tod_min: +e.pivot_ts.slice(11, 13) * 60 + +e.pivot_ts.slice(14, 16) }); }
    } else if (type === 'GLOBEX' && b.length && b.length < 0.9 * 930) stats.sparse++;
    if (b.length >= VOL_WINDOW + 5) { r.push(sums12(b)); if (r.length > 25) r.shift(); }
  }
}
console.log(`Sessions built RTH ${stats.RTH}, GLOBEX ${stats.GLOBEX} (sparse Globex ${stats.sparse}, skipped no-ATR/ref ${stats.noAtr}, roll-gap sessions flagged ${stats.roll}). Events ${rows.length} (RTH ${rows.filter(r => r.session === 'RTH').length}, GLOBEX ${rows.filter(r => r.session === 'GLOBEX').length}).`);
console.log('events per session median:', (() => { const c = {}; for (const r of rows) { const k = r.session + r.trade_date; c[k] = (c[k] || 0) + 1; } const v = Object.values(c).sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; })());
if (!WRITE) { console.log('DRY RUN (no --write): nothing inserted.'); process.exit(0); }
const cols = ['session', 'trade_date', 'leg_no', 'pivot_type', 'pivot_ts', 'confirm_ts', 'pivot_price', 'confirm_price', 'minutes_to_confirm', 'atr20', 'tod_min', 'dow', 'roll_gap_day', 'prior_leg_pts', 'prior_leg_minutes', 'vol_win_sum', 'vol_z', 'flow12', 'prior_leg_flow', 'vwap_dist_atr', 'stack_n', 'stack_long', 'near_levels', 'out_ret_15', 'out_ret_30', 'out_ret_60', 'out_ret_120', 'out_ret_240', 'out_mfe_240', 'out_mae_240', 'out_full_240', 'out_leg_pts', 'out_leg_minutes', 'out_leg_complete'];
let ins = 0; for (let i = 0; i < rows.length; i += 200) { const chunk = rows.slice(i, i + 200), params = [], ph = chunk.map(r => '(' + cols.map(c => { params.push(c === 'near_levels' ? JSON.stringify(r[c]) : r[c]); return '$' + params.length + (c === 'near_levels' ? '::jsonb' : ''); }).join(',') + ')');
  const res = await query(`INSERT INTO rotation_events (${cols.join(',')}) VALUES ${ph.join(',')} ON CONFLICT DO NOTHING`, params); ins += res.rowCount; }
console.log('inserted', ins); process.exit(0);
