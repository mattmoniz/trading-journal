// Opus Audit #14 (2026-09-24) section 3.2 / OPEN_DECISION
// trade_forward_path_table_and_policy_evaluator_20260924. Builds an UNCENSORED forward
// bar-by-bar path for every real fade-setup trade: unlike active_setups.mae_points/
// mfe_points (which stop at the trade's OWN real resolution), this walk continues to
// H bars regardless of when/whether the real stop or target was hit, so a battery of
// exit policies can be evaluated retroactively against the SAME underlying path data
// (evaluate_exit_policies.mjs) instead of each policy needing its own bespoke backtest
// script -- the "40+ independent exit-mechanism scripts" problem the audit names.
//
// First version: RTH fade trades only (Globex needs its own H per the audit -- deferred,
// same as the audit's own §3.2 note). Stored as a scratch JSON artifact, not a new live DB
// table -- this is research infrastructure, not yet a production pipeline; promoting it to
// a real table is real DB-migration work (schema.sql regen, ARCHITECTURE.md entry, backup
// catalog) left for if/when this becomes load-bearing, matching how Track B's own dataset
// has stayed a scratch CSV through this same research phase.
import { query } from '../server/db.js';
import { inferDirection } from '../server/config/setupTypes.js';
import { REAL_TRADE_FILTER } from './backtest_setup_status.mjs';
import fs from 'fs';

const H_BARS_RTH = 240; // Opus Audit #14 section 3.2: "H ~= 240 1-minute bars for RTH"
const OUT_PATH = '/home/mmoniz/trading-journal/scratch/trade_forward_path.json';

async function main() {
  const { rows: fires } = await query(`
    SELECT id, setup_type, fired_at::text AS fired_at, trade_date::text AS trade_date,
      is_rth, entry_zone_low, entry_zone_high, stop_level, t1_level, resolution,
      actual_pnl, cluster_touch_id
    FROM active_setups
    WHERE ${REAL_TRADE_FILTER}
      AND setup_type LIKE '%_FADE_%'
      AND resolution IN ('STOP_HIT', 'TARGET_HIT')
      AND is_rth = true
      AND (is_cluster_primary IS NULL OR is_cluster_primary = true)
      AND stop_level IS NOT NULL AND entry_zone_low IS NOT NULL
    ORDER BY fired_at
  `);
  console.log(`Real RTH fade fires eligible for forward-path walk: ${fires.length}`);

  const paths = [];
  let nGapThrough = 0;
  let nInsufficientBars = 0;

  for (const f of fires) {
    const direction = inferDirection(f.setup_type);
    if (direction == null) continue;
    const dirNum = direction === 'LONG' ? 1 : -1;
    const entry = (parseFloat(f.entry_zone_low) + parseFloat(f.entry_zone_high)) / 2;
    const stop = parseFloat(f.stop_level);
    const R = Math.abs(entry - stop);
    if (!(R > 0)) continue;

    // Bar immediately before fired_at -- per the OVERNIGHT MFE gap-artifact convention,
    // if this is far from entry, the "path" starts with an untradeable gap, not a
    // continuous walk. Flagged, not excluded (the audit's own gap-through flag).
    const { rows: preBar } = await query(`
      SELECT close FROM price_bars_primary
      WHERE symbol = 'NQ' AND ts < $1::timestamp ORDER BY ts DESC LIMIT 1
    `, [f.fired_at]);
    const gapThrough = preBar.length > 0 && Math.abs(parseFloat(preBar[0].close) - entry) > 3 * R;
    if (gapThrough) nGapThrough++;

    const { rows: bars } = await query(`
      SELECT ts::text AS ts, high, low, close FROM price_bars_primary
      WHERE symbol = 'NQ' AND ts >= $1::timestamp
      ORDER BY ts ASC LIMIT $2
    `, [f.fired_at, H_BARS_RTH]);
    if (bars.length < 5) { nInsufficientBars++; continue; }

    // Uncensored walk: keep going past the real stop/target -- record running max-
    // favorable and max-adverse excursion in R at EVERY bar, plus close-in-R, plus the
    // first bar index (if any) where the ORIGINAL stop and ORIGINAL target were each
    // touched (stop-first on a same-bar tie, matching every existing walker).
    let maxFavR = 0, maxAdvR = 0;
    let stopHitBar = null, targetHitBar = null;
    const targetLevel = f.t1_level != null ? parseFloat(f.t1_level) : null;
    const path = [];
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      const hi = parseFloat(b.high), lo = parseFloat(b.low), close = parseFloat(b.close);
      // Favorable/adverse excursion is direction-relative: for LONG, favorable = high
      // above entry, adverse = low below entry; for SHORT, mirrored.
      const favExcursion = dirNum === 1 ? (hi - entry) : (entry - lo);
      const advExcursion = dirNum === 1 ? (entry - lo) : (hi - entry);
      maxFavR = Math.max(maxFavR, favExcursion / R);
      maxAdvR = Math.max(maxAdvR, advExcursion / R);
      const closeR = dirNum === 1 ? (close - entry) / R : (entry - close) / R;
      // Per-bar high/low in R units (direction-relative: "high_r" always means the more
      // FAVORABLE side for this trade's direction) -- needed by any policy that checks a
      // target/trail level touch beyond the aggregate max_fav_r/max_adv_r summary above,
      // e.g. WIDER_1_5X checking "did price actually touch 1.5x target on some bar."
      const highR = dirNum === 1 ? (hi - entry) / R : (entry - lo) / R;
      const lowR = dirNum === 1 ? (lo - entry) / R : (entry - hi) / R;

      if (stopHitBar === null) {
        const stopTouched = dirNum === 1 ? lo <= stop : hi >= stop;
        if (stopTouched) stopHitBar = i; // stop-first on same-bar tie: checked before target below
      }
      if (targetHitBar === null && targetLevel != null) {
        const targetTouched = dirNum === 1 ? hi >= targetLevel : lo <= targetLevel;
        if (targetTouched && stopHitBar !== i) targetHitBar = i;
      }
      path.push({
        i, close_r: Number(closeR.toFixed(3)),
        high_r: Number(highR.toFixed(3)), low_r: Number(lowR.toFixed(3)),
      });
    }

    paths.push({
      id: f.id, setup_type: f.setup_type, fired_at: f.fired_at, trade_date: f.trade_date,
      dir: dirNum, R: Number(R.toFixed(3)), entry, stop, target: targetLevel,
      real_resolution: f.resolution, real_actual_pnl: f.actual_pnl != null ? parseFloat(f.actual_pnl) : null,
      cluster_touch_id: f.cluster_touch_id, gap_through: gapThrough,
      n_bars_walked: bars.length, hit_h_cap: bars.length >= H_BARS_RTH,
      stop_hit_bar: stopHitBar, target_hit_bar: targetHitBar,
      max_fav_r: Number(maxFavR.toFixed(3)), max_adv_r: Number(maxAdvR.toFixed(3)),
      close_r_path: path.map(p => p.close_r),
      high_r_path: path.map(p => p.high_r),
      low_r_path: path.map(p => p.low_r),
    });

    if (paths.length % 200 === 0) console.log(`  ...${paths.length}/${fires.length} paths built`);
  }

  fs.writeFileSync(OUT_PATH, JSON.stringify(paths));
  console.log(`Wrote ${paths.length} forward paths to ${OUT_PATH}`);
  console.log(`Gap-through: ${nGapThrough}, insufficient bars (excluded): ${nInsufficientBars}`);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
