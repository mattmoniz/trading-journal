// scripts/verify_pd_poc_direction_by_path_20260727.mjs
// Follow-up to OPEN_DECISION level_fade_direction_convention_needs_verification, item (1):
// re-run the Method-3-specific check restricted to genuine PD_POC/Globex-path examples only
// (larger N, not blended with RTH-path setup types). PD_POC_FADE_SHORT/LONG can fire from
// EITHER the RTH nearLevels path (Method 1: 5-bar momentum) OR detectGlobexSetup()'s
// continuous overnight monitor (Method 3: current price vs level, `pocDir = px >= poc ?
// SHORT : LONG`) — split by whether fired_at's ET time-of-day falls in RTH hours (9:30
// AM-4:00 PM) or Globex hours (everything else), then check each population against its
// OWN real formula. fired_at is a naive ET wall-clock timestamp (this codebase's documented
// convention) — parse the HH:MM directly from the text, no timezone conversion needed.
import { query } from '../server/db.js';

function etMinuteOfDay(firedAtStr) {
  const [, timePart] = firedAtStr.split(' ');
  const [h, m] = timePart.split(':').map(Number);
  return h * 60 + m;
}

async function main() {
  const rows = (await query(`
    SELECT id, setup_type, trade_date::text, fired_at::text as fired_at_str,
           entry_zone_low::float, entry_zone_high::float
    FROM active_setups
    WHERE origin_status IN ('ACTIVE','SHADOW')
      AND setup_type IN ('PD_POC_FADE_SHORT','PD_POC_FADE_LONG')
    ORDER BY fired_at
  `)).rows;

  console.log(`Total real PD_POC_FADE rows: ${rows.length}`);

  const rth = [], globex = [];
  for (const row of rows) {
    const mod = etMinuteOfDay(row.fired_at_str);
    (mod >= 570 && mod < 960 ? rth : globex).push(row);
  }
  console.log(`RTH-hours (9:30-16:00 ET): ${rth.length}   Globex-hours (else): ${globex.length}`);

  async function checkRth(pop) {
    let m1Agree = 0, n = 0;
    const details = [];
    for (const row of pop) {
      const recordedDir = row.setup_type.endsWith('_LONG') ? 'LONG' : 'SHORT';
      const barsRes = await query(`
        SELECT ts::text, close::float FROM price_bars_primary
        WHERE symbol='NQ' AND ts <= $1::timestamp
        ORDER BY ts DESC LIMIT 6
      `, [row.fired_at_str]);
      const bars = barsRes.rows.reverse();
      if (bars.length < 6) continue;
      n++;
      const currentPrice = bars[5].close;
      const price5BarsAgo = bars[0].close;
      const method1Dir = (price5BarsAgo < currentPrice ? 'FROM_BELOW' : 'FROM_ABOVE') === 'FROM_ABOVE' ? 'LONG' : 'SHORT';
      const m1Match = method1Dir === recordedDir;
      if (m1Match) m1Agree++;
      details.push({ id: row.id, setup_type: row.setup_type, fired_at: row.fired_at_str, recordedDir, method1Dir, m1Match });
    }
    console.log(`\n== RTH-hours PD_POC_FADE (N=${n}) ==`);
    console.log(`  Method 1 (5-bar momentum) agreement: ${m1Agree}/${n} (${n ? (m1Agree/n*100).toFixed(1) : 'N/A'}%)`);
    for (const d of details) console.log(`    id=${d.id} ${d.setup_type} fired=${d.fired_at} recorded=${d.recordedDir} m1=${d.method1Dir}${d.m1Match?'':' MISS'}`);
  }

  // detectGlobexSetup() sets `entry = px` EXACTLY (confirmed directly against a real row:
  // id=67602's entry_zone_low=28622.5 matches a real bar's close precisely) -- so
  // entry_zone_low IS the real px, no need to re-derive it from bars near fired_at (which
  // was WRONG: fired_at lags px's capture by 1-2+ minutes in practice, confirmed on the
  // same row -- entry matches the bar 2 minutes before fired_at, not the bar at fired_at).
  // Also: active_setups.trade_date for an overnight fire is the NEXT trading day (confirmed:
  // id=67602 fired 2026-07-23 evening, trade_date='2026-07-24') -- joining
  // developing_value_log on trade_date<=row.trade_date was silently using the wrong cutoff.
  // The correct join key is fired_at's OWN calendar date (extracted from fired_at_str).
  async function checkGlobex(pop) {
    let m3Agree = 0, n = 0;
    const details = [];
    for (const row of pop) {
      const recordedDir = row.setup_type.endsWith('_LONG') ? 'LONG' : 'SHORT';
      const px = row.entry_zone_low;
      const firedDate = row.fired_at_str.slice(0, 10);
      // developing_value_log's row for a given date isn't created until that date's own RTH
      // session closes (~16:00 ET) -- for an early-morning fire (before RTH close of its own
      // calendar date), that date's row does not exist yet AT FIRE TIME, even though it exists
      // now (querying historical data long after the fact). Querying trade_date<=firedDate
      // unconditionally is a lookahead bug for these cases -- caught on ids 37887/58638 (both
      // fired 00:xx-03:xx ET) landing on a same-day poc that couldn't have been known yet.
      const firedMod = etMinuteOfDay(row.fired_at_str);
      const pocCutoff = firedMod < 960 ? `trade_date < $1::date` : `trade_date <= $1::date`;
      const pocRes = await query(`
        SELECT trade_date::text, poc::float FROM developing_value_log WHERE ${pocCutoff} ORDER BY trade_date DESC LIMIT 1
      `, [firedDate]);
      const poc = pocRes.rows[0]?.poc;
      if (poc == null) continue;
      n++;
      const method3Dir = px >= poc ? 'SHORT' : 'LONG';
      const m3Match = method3Dir === recordedDir;
      if (m3Match) m3Agree++;
      details.push({ id: row.id, setup_type: row.setup_type, fired_at: row.fired_at_str, recordedDir, method3Dir, m3Match, px, poc, pocDate: pocRes.rows[0].trade_date });
    }
    console.log(`\n== Globex-hours PD_POC_FADE (N=${n}), corrected px + correct POC join ==`);
    console.log(`  Method 3 (current vs level) agreement: ${m3Agree}/${n} (${n ? (m3Agree/n*100).toFixed(1) : 'N/A'}%)`);
    for (const d of details) console.log(`    id=${d.id} ${d.setup_type} fired=${d.fired_at} recorded=${d.recordedDir} m3=${d.method3Dir}${d.m3Match?'':' MISS'} (px=${d.px} poc=${d.poc}@${d.pocDate})`);
  }

  await checkRth(rth);
  await checkGlobex(globex);

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
