// Builds overnight_checkpoint_stats: for each completed Globex night (18:00 ET the evening before the trade date through 09:29), cumulative volume and 65-point rotation legs
// at every 30-minute checkpoint since the open. The tripwire (server/services/overnightTripwire.js) ranks tonight against these. Incremental (only missing dates); run daily.
//   node scripts/build_overnight_checkpoint_stats.mjs [--days 300]
import { query } from '../server/db.js';
import { detectRotationLegs } from '../server/services/rotationDetector.js';
export const CHECKPOINT_STEP = 30, NIGHT_MINUTES = 930;   // 18:00 -> 09:30
const argDays = process.argv.includes('--days') ? +process.argv[process.argv.indexOf('--days') + 1] : 300;
export async function nightCheckpoints(tradeDate) {
  const prev = new Date(tradeDate + 'T00:00:00Z'); prev.setUTCDate(prev.getUTCDate() - 1); const pd = prev.toISOString().slice(0, 10);
  const bars = (await query(`SELECT ts::text t, high::float high, low::float low, volume::float v FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1 AND ts < $2 ORDER BY ts`, [pd + ' 18:00', tradeDate + ' 09:30'])).rows;
  if (bars.length < 600) return null;
  const t0 = Date.parse(pd + 'T18:00:00Z'), out = []; let vi = 0, cum = 0;
  for (let c = CHECKPOINT_STEP; c <= NIGHT_MINUTES; c += CHECKPOINT_STEP) {
    const until = t0 + c * 60000; const slice = [];
    while (vi < bars.length && Date.parse(bars[vi].t.replace(' ', 'T').slice(0, 19) + 'Z') < until) { cum += bars[vi].v || 0; slice.push(bars[vi]); vi++; }
    out.push({ c, volume: Math.round(cum), legs: null, upto: vi });
  }
  for (const o of out) o.legs = detectRotationLegs(bars.slice(0, o.upto)).length;
  return out;
}
async function main() {
  const dates = (await query(`SELECT DISTINCT trade_date::text d FROM level_prices WHERE trade_date >= CURRENT_DATE - $1::int AND trade_date <= CURRENT_DATE AND EXTRACT(dow FROM trade_date) BETWEEN 1 AND 5 ORDER BY 1`, [argDays])).rows.map((r) => r.d);
  const have = new Set((await query(`SELECT DISTINCT trade_date::text d FROM overnight_checkpoint_stats WHERE checkpoint_min = $1`, [NIGHT_MINUTES])).rows.map((r) => r.d));
  let done = 0, skipped = 0;
  for (const d of dates) { if (have.has(d)) continue; const cps = await nightCheckpoints(d); if (!cps) { skipped++; continue; }
    for (const o of cps) await query(`INSERT INTO overnight_checkpoint_stats (trade_date, checkpoint_min, volume, legs) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [d, o.c, o.volume, o.legs]); done++; }
  console.log(`overnight_checkpoint_stats: ${done} nights added, ${skipped} skipped (incomplete bars), ${have.size} already present`);
}
if (import.meta.url === `file://${process.argv[1]}`) main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
