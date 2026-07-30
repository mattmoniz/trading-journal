// scripts/backtest_globex_vwap_fade.mjs
//
// Historical backfill + calibration for GLOBEX_VWAP_FADE_LONG/SHORT — the Globex sibling
// of RTH_VWAP_FADE_LONG/SHORT (scripts/backtest_rth_vwap_fade.mjs, same session): an
// ordinary close-range (15pt) touch of the running 24hr VWAP, distinct from
// GLOBEX_VWAP_MAGNET's far-away sigma trigger.
//
// Reuses the REAL live math: getGlobex24hrBars (server/services/queries.js),
// computeRunningVwapSeries (developingValueService.js), resolve() (backtest_unified.js).
// Direction is dynamic from current price side relative to VWAP (matches the live
// candidate's globexVwapFadeDir: `px >= vwap24 ? 'SHORT' : 'LONG'`, the same convention
// PD_POC's own pocDir uses for a symmetric central-tendency level with no inherent
// support/resistance bias) -- NOT the 5-bar-approach-trend convention RTH_VWAP_FADE uses,
// since detectGlobexSetup()'s other candidates (PD_POC included) use current-price-side,
// not approach-side, and this setup fires through that same function.
//
// Stop/target match the flatStop/flatTarget fallback detectGlobexSetup() already uses for
// every other wider-window overnight level (60/30pt Monday, 90/40pt otherwise).
//
// SIMPLIFICATION (matches every other Globex-fired level's own backfill convention): first
// touch anywhere in the 24hr window, once per day.
//
// Run: node scripts/backtest_globex_vwap_fade.mjs [--dry-run]

import { query } from '../server/db.js';
import { getTradingDays } from './backtest_confluence.js';
import { resolve } from './backtest_unified.js';
import { computeRunningVwapSeries } from '../server/services/developingValueService.js';
import { getGlobex24hrBars } from '../server/services/queries.js';

const DRY_RUN = process.argv.includes('--dry-run');
const TARGET_TYPES = ['GLOBEX_VWAP_FADE_LONG', 'GLOBEX_VWAP_FADE_SHORT'];

async function run() {
  console.log(`Backfill GLOBEX_VWAP_FADE_LONG/SHORT${DRY_RUN ? ' [DRY RUN]' : ''}`);

  if (!DRY_RUN) {
    await query(`DROP TABLE IF EXISTS active_setups_globex_vwap_fade_backfill_backup_20260728`);
    await query(`
      CREATE TABLE active_setups_globex_vwap_fade_backfill_backup_20260728 AS
      SELECT * FROM active_setups WHERE setup_type = ANY($1) AND resolution_method = 'BACKFILL'
    `, [TARGET_TYPES]);
    const cnt = await query(`SELECT COUNT(*) FROM active_setups_globex_vwap_fade_backfill_backup_20260728`);
    console.log(`Backed up ${cnt.rows[0].count} pre-existing backfill row(s) (expect 0 -- brand new setup)`);
    const del = await query(`DELETE FROM active_setups WHERE setup_type = ANY($1) AND resolution_method = 'BACKFILL'`, [TARGET_TYPES]);
    console.log(`Deleted ${del.rowCount} row(s) before re-running`);
  }

  const days = await getTradingDays();
  console.log(`Processing ${days.length} trading days`);

  let inserted = 0;
  const stats = { GLOBEX_VWAP_FADE_LONG: { n: 0, wins: 0, expired: 0, pnl: 0 }, GLOBEX_VWAP_FADE_SHORT: { n: 0, wins: 0, expired: 0, pnl: 0 } };

  for (const d of days) {
    const bars = await getGlobex24hrBars(d);
    if (bars.length < 60) continue;
    const vwapSeries = computeRunningVwapSeries(bars);
    const sessionIsMonday = new Date(d + 'T12:00:00').getDay() === 1;
    const STOP = sessionIsMonday ? 60 : 90, TARGET = sessionIsMonday ? 30 : 40;

    let fired = false;
    for (let i = 4; i < bars.length && !fired; i++) {
      const vwap = vwapSeries[i];
      if (vwap == null) continue;
      const dist = Math.abs(bars[i].close - vwap);
      if (dist > 15) continue;

      const isLong = bars[i].close < vwap; // matches live: px >= vwap24 ? SHORT : LONG
      const direction = isLong ? 'LONG' : 'SHORT';
      const entry = bars[i].close;
      const stop = isLong ? entry - STOP : entry + STOP;
      const target = isLong ? entry + TARGET : entry - TARGET;
      const setupType = isLong ? 'GLOBEX_VWAP_FADE_LONG' : 'GLOBEX_VWAP_FADE_SHORT';

      const res = resolve(bars, i, direction, entry, stop, target, 1440);
      const resolution = res.result === 'EXPIRED' ? 'TIME_EXPIRED' : res.result;
      const status = resolution === 'TIME_EXPIRED' ? 'EXPIRED' : 'RESOLVED';
      const pnl = res.result === 'EXPIRED' ? 0 : res.pnl;
      const resolvedIdx = Math.min(bars.length - 1, i + Math.max(1, res.barsHeld));
      const resolvedAt = resolution === 'TIME_EXPIRED' ? null : bars[resolvedIdx].ts;

      stats[setupType].n++;
      if (resolution === 'TARGET_HIT') stats[setupType].wins++;
      if (resolution === 'TIME_EXPIRED') stats[setupType].expired++;
      stats[setupType].pnl += pnl;

      if (!DRY_RUN) {
        await query(`
          INSERT INTO active_setups (
            trade_date, setup_type, fired_at, expires_at, resolved_at, status, resolution,
            entry_zone_low, entry_zone_high, stop_level, t1_level, t1_label,
            structural_level_touched, structural_level_type, price_at_detection,
            actual_pnl, resolution_method, origin_status, mae_points, mfe_points, replay_resolution
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
          ON CONFLICT DO NOTHING
        `, [
          d, setupType, bars[i].ts, `${d} 09:30:00`, resolvedAt, status, resolution,
          entry, entry, stop, target, `T1: ${TARGET}pt (Globex VWAP fade)`,
          Math.round(vwap * 100) / 100, 'GLOBEX_VWAP', entry,
          Math.round((pnl ?? 0) * 100) / 100, 'BACKFILL', 'BACKFILL',
          Math.round(res.mae * 100) / 100, Math.round(res.mfe * 100) / 100, resolution,
        ]);
      }
      inserted++;
      fired = true;
    }
  }

  console.log(`\n${DRY_RUN ? 'Would insert' : 'Inserted'}: ${inserted}`);
  for (const [type, s] of Object.entries(stats)) {
    const resolved = s.n - s.expired;
    const wr = resolved > 0 ? (s.wins / resolved * 100).toFixed(1) : 'n/a';
    const ev = s.n > 0 ? (s.pnl / s.n).toFixed(2) : 'n/a';
    console.log(`  ${type}: N=${s.n} (${s.expired} expired) WR=${wr}% EV=$${ev}`);
  }
  console.log(`\nNext: run scripts/backtest_setup_status.mjs and scripts/update_optimal_stops.mjs to calibrate real SETUP_STATUS/OPTIMAL_STOP rows from this data.`);
  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
