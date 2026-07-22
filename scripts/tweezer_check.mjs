import { query } from './server/db.js';
import { getBarShapeBaseline, classifyReversalPattern } from './server/services/candlePatternQuality.js';
import { directionFromType } from './server/services/maeMfeReplay.js';

async function run() {
  const setupsRes = await query(`
    SELECT id, setup_type, trade_date, fired_at, entry_zone_low, entry_zone_high
    FROM active_setups 
    WHERE resolution_method = 'BACKFILL' 
      AND resolution IN ('STOP_HIT','TARGET_HIT') 
    LIMIT 3000
  `);
  let samples = 0;
  for (const s of setupsRes.rows) {
    if(samples >= 20) break;
    const direction = directionFromType(s.setup_type);
    const dateStr = typeof s.trade_date === 'string' ? s.trade_date.slice(0, 10) : s.trade_date.toISOString().slice(0, 10);
    const barsRes = await query(`SELECT ts, open::float, high::float, low::float, close::float FROM price_bars_primary WHERE symbol='NQ' AND ts::date = $1 AND ts > $2 ORDER BY ts LIMIT 10`, [dateStr, s.fired_at]);
    if (barsRes.rows.length < 2) continue;
    const baseline = await getBarShapeBaseline(query, dateStr, 'NQ', 90);
    const match = classifyReversalPattern({ windowBars: barsRes.rows, direction, baseline });
    if (match && match.pattern.startsWith('TWEEZER')) {
      console.log(`Sample ${samples+1} (${s.setup_type}): ${JSON.stringify(barsRes.rows.slice(0, 3).map(b=>({o:b.open, h:b.high, l:b.low, c:b.close})))}`);
      samples++;
    }
  }
}
run().catch(console.error);
