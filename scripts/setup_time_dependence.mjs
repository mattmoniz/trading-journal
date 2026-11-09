// Plain question (user 2026-11-08): do setups perform better at certain times of day, across ALL setups and not a cherry-picked few? One descriptive test, exploratory (ledger look, 0 counted tests).
// For every setup type with at least 2 time blocks holding >= MIN_OBS cluster-collapsed trades: spread = best block mean minus worst block mean. Null: shuffle the time-block labels among that type's own trades (2,000 times)
// and recompute the average spread across types. If real time-of-day dependence exists, the real average spread is larger than the shuffled ones.
// Blocks: RTH open 09:35-10:30, RTH mid 10:30-14:00, RTH late 14:00-16:00, Globex evening 18:30-24:00, Globex night 00:00-09:30.
import { query } from '../server/db.js';
import { logLook } from './lib/look_ledger.mjs';
import { bucketOfMinute, minuteOfText } from '../server/services/bucketRoster.js';
const MIN_OBS = 8, NP = 2000;
let seed = 20261108;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
await logLook({ family: 'setup_time_dependence_20261108', dataWindow: 'explore_2026-07-09_to_today', kind: 'EXPLORE', tests: 0, ref: 'setup_time_dependence_' + new Date().toISOString().slice(0, 10), label: 'Exploratory: per-setup time-of-day spread against a within-type shuffle of time-block labels, all setup types with enough data', script: 'scripts/setup_time_dependence.mjs' });
const rows = (await query(`SELECT setup_type t, fired_at::text fa, cluster_touch_id cl, actual_pnl::float p FROM active_setups
  WHERE origin_status IN ('ACTIVE','SHADOW') AND trade_date >= '2026-07-09' AND actual_pnl IS NOT NULL AND resolution IS DISTINCT FROM 'NOT_FILLED'
    AND ib_window_stale_basis IS NOT TRUE AND stale_entry_price_basis IS NOT TRUE AND late_fill_past_expiry_basis IS NOT TRUE AND bad_bars_basis IS NOT TRUE AND stale_levels_basis IS NOT TRUE
    AND NOT (fired_at::time >= '16:00' AND fired_at::time < '18:00') AND setup_type NOT LIKE 'POC_ROTATION_JOIN%'`)).rows;
const by = new Map();
for (const r of rows) { if (!by.has(r.t)) by.set(r.t, []); by.get(r.t).push(r); }
const types = [];
let single = 0, thin = 0;
for (const [t, rs] of by) {
  const g = new Map();
  for (const r of rs) {
    const b = bucketOfMinute(minuteOfText(r.fa)); if (!b) continue;
    const k = r.cl == null ? 'S' + g.size : String(r.cl);
    if (!g.has(k)) g.set(k, { b, ys: [] });
    g.get(k).ys.push(r.p);
  }
  const obs = [...g.values()].map((x) => ({ b: x.b, y: mean(x.ys) }));
  const cnt = {}; for (const o of obs) cnt[o.b] = (cnt[o.b] || 0) + 1;
  const ok = Object.keys(cnt).filter((b) => cnt[b] >= MIN_OBS);
  if (ok.length >= 2) types.push({ t, obs, ok }); else if (Object.keys(cnt).length <= 1) single++; else thin++;
}
const spread = (obs, ok) => { const m = ok.map((b) => mean(obs.filter((o) => o.b === b).map((o) => o.y))); return Math.max(...m) - Math.min(...m); };
const real = types.map((x) => spread(x.obs, x.ok)), realMean = mean(real);
const nullMeans = [];
for (let k = 0; k < NP; k++) {
  const sp = types.map((x) => {
    const lab = x.obs.map((o) => o.b);
    for (let i = lab.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const tmp = lab[i]; lab[i] = lab[j]; lab[j] = tmp; }
    const sh = x.obs.map((o, i) => ({ b: lab[i], y: o.y }));
    const cnt = {}; for (const o of sh) cnt[o.b] = (cnt[o.b] || 0) + 1;
    const ok = Object.keys(cnt).filter((b) => cnt[b] >= MIN_OBS);
    return ok.length >= 2 ? spread(sh, ok) : 0;
  });
  nullMeans.push(mean(sp));
}
nullMeans.sort((a, b) => a - b);
const p = (nullMeans.filter((x) => x >= realMean).length + 1) / (NP + 1);
console.log(by.size + ' setup types in the data. ' + types.length + ' have at least 2 time blocks with >= ' + MIN_OBS + ' trades each (analyzed); ' + single + ' fire in only ONE time block; ' + thin + ' fire in several blocks but too thinly to compare.');
console.log('Average best-minus-worst block spread across analyzed types: REAL ' + realMean.toFixed(1) + ' dollars per trade; if time of day did not matter (labels shuffled) it would be ' + mean(nullMeans).toFixed(1) + ' (95% range ' + nullMeans[Math.floor(NP * 0.025)].toFixed(1) + ' to ' + nullMeans[Math.floor(NP * 0.975)].toFixed(1) + '). Chance of a spread this big by luck: ' + (100 * p).toFixed(1) + '%');
const ranked = types.map((x, i) => ({ x, s: real[i] })).sort((a, b) => b.s - a.s).slice(0, 10);
console.log('\nLargest spreads (descriptive; thin cells exaggerate spreads, which is what the shuffle above controls for):');
for (const { x, s } of ranked) console.log('  ' + x.t.padEnd(36) + ' spread ' + s.toFixed(0).padStart(4) + '   ' + x.ok.map((b) => { const v = x.obs.filter((o) => o.b === b); return b + ' ' + mean(v.map((o) => o.y)).toFixed(0) + ' (n' + v.length + ')'; }).join('  '));
process.exit(0);
