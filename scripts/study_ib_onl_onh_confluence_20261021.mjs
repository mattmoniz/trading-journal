// IB_LOW_FADE_* vs ONL and IB_HIGH_FADE_* vs ONH: does the fade do differently when the two levels sit close together?
// Distance is in ATR20 units (scale-free); "near" = bottom third of the pooled distance distribution (data-derived, no typed cutoff).
// Also shows the existing 15pt confluence-cluster radius as a plain reference split. Live-detected rows only, siblings collapsed.
import { query } from '../server/db.js';
import { getRollingRthRange } from '../server/services/dailyRthStats.js';
import { collapseClusterSiblings, mulberry32, hashSeed } from '../server/services/rigorDiagnostics.js';
const f = (x) => (x >= 0 ? '+' : '') + x.toFixed(1), mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const today = (await query(`SELECT CURRENT_DATE::text d`)).rows[0].d;
const rows = (await query(`SELECT id, setup_type t, trade_date::text d, cluster_touch_id cl, actual_pnl::float p FROM active_setups WHERE setup_type IN ('IB_LOW_FADE_LONG','IB_LOW_FADE_SHORT','IB_HIGH_FADE_LONG','IB_HIGH_FADE_SHORT') AND origin_status IN ('ACTIVE','SHADOW') AND trade_date >= '2026-07-09' AND trade_date < $1 AND actual_pnl IS NOT NULL AND resolution IS DISTINCT FROM 'NOT_FILLED' AND ib_window_stale_basis IS NOT TRUE AND stale_entry_price_basis IS NOT TRUE AND late_fill_past_expiry_basis IS NOT TRUE AND bad_bars_basis IS NOT TRUE AND NOT (fired_at::time >= '16:00' AND fired_at::time < '18:00') AND fired_at::time >= '10:31'`, [today])).rows;
const dates = [...new Set(rows.map((r) => r.d))].sort(); const lv = {};
for (const d of dates) {
  const on = (await query(`SELECT MIN(low)::float lo, MAX(high)::float hi FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1::date AND ts < $1::date + interval '9 hours 30 minutes'`, [d])).rows[0];
  const ib = (await query(`SELECT MIN(low)::float lo, MAX(high)::float hi FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1::date + interval '9 hours 30 minutes' AND ts < $1::date + interval '10 hours 30 minutes'`, [d])).rows[0];
  const atr = (await getRollingRthRange({ beforeDate: d }))?.atr;
  if (on?.lo != null && ib?.lo != null && atr > 0) lv[d] = { onl: on.lo, onh: on.hi, ibl: ib.lo, ibh: ib.hi, atr };
}
for (const r of rows) { const L = lv[r.d]; if (!L) continue; const low = r.t.startsWith('IB_LOW'); r.dist = Math.abs(low ? L.ibl - L.onl : L.ibh - L.onh); r.distAtr = r.dist / L.atr; }
const ok = rows.filter((r) => r.distAtr != null);
function ci(A, B, seed) { const days = [...new Set([...A, ...B].map((e) => e.date))]; const g = (X) => { const m = new Map(); for (const e of X) (m.get(e.date) || m.set(e.date, []).get(e.date)).push(e.pnl); return m; }; const ga = g(A), gb = g(B); const rnd = mulberry32(hashSeed(seed)); const ds = []; for (let i = 0; i < 2000; i++) { let sa = 0, na = 0, sb = 0, nb = 0; for (let k = 0; k < days.length; k++) { const d = days[Math.floor(rnd() * days.length)]; for (const x of ga.get(d) || []) { sa += x; na++; } for (const x of gb.get(d) || []) { sb += x; nb++; } } if (na && nb) ds.push(sa / na - sb / nb); } ds.sort((a, b) => a - b); return [ds[Math.floor(0.025 * ds.length)], ds[Math.floor(0.975 * ds.length)]]; }
const col = (rs) => collapseClusterSiblings(rs.map((r) => ({ date: r.d, pnl: r.p, cluster_touch_id: r.cl })));
function split(label, rs, cutFn) {
  const near = col(rs.filter((r) => cutFn(r))), far = col(rs.filter((r) => !cutFn(r)));
  const dn = new Set(near.map((e) => e.date)).size, df = new Set(far.map((e) => e.date)).size;
  if (near.length < 8 || far.length < 8) { console.log(label.padEnd(34), `NEAR n${near.length}/${dn}d  FAR n${far.length}/${df}d  too thin`); return; }
  const [lo, hi] = ci(near, far, label); console.log(label.padEnd(34), `NEAR n${near.length}/${dn}d ${f(mean(near.map((e) => e.pnl)))} | FAR n${far.length}/${df}d ${f(mean(far.map((e) => e.pnl)))} | near-far ${f(mean(near.map((e) => e.pnl)) - mean(far.map((e) => e.pnl)))} CI [${f(lo)},${f(hi)}]`);
}
const sorted = ok.map((r) => r.distAtr).sort((a, b) => a - b); const p33 = sorted[Math.floor(sorted.length / 3)];
console.log(`rows with levels: ${ok.length} of ${rows.length}; dates ${Object.keys(lv).length}; near cutoff = bottom third = ${p33.toFixed(3)} ATR20 (median level gap ${sorted[Math.floor(sorted.length / 2)].toFixed(2)} ATR20)`);
const groups = { 'IB low (LONG+SHORT) vs ONL': ok.filter((r) => r.t.startsWith('IB_LOW')), 'IB high (LONG+SHORT) vs ONH': ok.filter((r) => r.t.startsWith('IB_HIGH')), IB_LOW_FADE_LONG: ok.filter((r) => r.t === 'IB_LOW_FADE_LONG'), IB_HIGH_FADE_SHORT: ok.filter((r) => r.t === 'IB_HIGH_FADE_SHORT'), IB_LOW_FADE_SHORT: ok.filter((r) => r.t === 'IB_LOW_FADE_SHORT'), IB_HIGH_FADE_LONG: ok.filter((r) => r.t === 'IB_HIGH_FADE_LONG') };
for (const [k, v] of Object.entries(groups)) { split(k + ' | third', v, (r) => r.distAtr <= p33); }
console.log('--- reference: existing 15pt cluster radius ---');
for (const [k, v] of Object.entries(groups)) { split(k + ' | within 15pt', v, (r) => r.dist <= 15); }
console.log('--- per-day check: is the near group concentrated on a few days? ---');
const nearRows = ok.filter((r) => r.distAtr <= p33); const byDay = {}; for (const r of nearRows) byDay[r.d] = (byDay[r.d] || 0) + 1; const top = Object.entries(byDay).sort((a, b) => b[1] - a[1]).slice(0, 5); console.log('near rows', nearRows.length, 'days', Object.keys(byDay).length, 'top5 days share', (top.reduce((s, x) => s + x[1], 0) / nearRows.length * 100).toFixed(0) + '%');
process.exit(0);
