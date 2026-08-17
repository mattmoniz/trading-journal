/**
 * Setup Outcome Backtest Service
 *
 * Replays active_setups against price_bars to determine real bracket outcomes:
 * did price hit T1 or stop first after the setup fired?
 *
 * Called by:
 *   POST /api/setups/backtest/run   (API, server/routes/setups.js — not currently
 *     called from any frontend, reachable via curl/admin use only, confirmed 2026-07-16)
 *
 * scripts/backtest_setups.js (the standalone CLI this docstring used to also list) was
 * archived 2026-07-09 (scripts/archive/) -- corrected here 2026-07-16, was stale for a week.
 */
import { LIVE_INSTRUMENT } from '../config/instruments.js';
import { resolveDirection } from '../config/setupTypes.js';

function nearestLevel(entryPrice, acdRow) {
  if (!acdRow) return 'UNKNOWN';
  const levels = [
    { label: 'OR5_HIGH', price: acdRow.or_high },
    { label: 'OR5_LOW',  price: acdRow.or_low  },
    { label: 'A_UP',    price: acdRow.a_up_level   },
    { label: 'A_DOWN',  price: acdRow.a_down_level  },
  ].filter(l => l.price != null);

  if (!levels.length) return 'UNKNOWN';
  let closest = levels[0];
  let minDist  = Math.abs(entryPrice - Number(levels[0].price));
  for (const l of levels.slice(1)) {
    const d = Math.abs(entryPrice - Number(l.price));
    if (d < minDist) { minDist = d; closest = l; }
  }
  return minDist <= 30 ? closest.label : 'OTHER';
}

/**
 * @param {object} db  - object with a .query(sql, params) method (pg Pool or client)
 * @param {object} opts
 * @param {boolean} opts.verbose
 * @param {number[]|null} opts.setupIds  - limit to specific setup IDs (null = all)
 * @returns {{ processed, skipped, errors, rows }}
 */
export async function runSetupBacktest(db, { verbose = false, setupIds = null } = {}) {
  const idFilter = setupIds?.length ? `AND id = ANY($1)` : '';
  const params   = setupIds?.length ? [setupIds] : [];

  const { rows: setups } = await db.query(`
    SELECT id, trade_date, setup_type,
           fired_at::text as fired_at,
           entry_zone_low, entry_zone_high, stop_level, t1_level,
           structural_level_type,
           nl30_at_detection, structural_state_at_detection, confluence_score_at_detection
    FROM active_setups
    ${idFilter}
    ORDER BY fired_at
  `, params);

  let processed = 0, skipped = 0, errors = 0;
  const rows = [];

  for (const setup of setups) {
    try {
      const entry = setup.entry_zone_high != null ? Number(setup.entry_zone_high)
                  : setup.entry_zone_low  != null ? Number(setup.entry_zone_low)
                  : null;
      const stop  = setup.stop_level != null ? Number(setup.stop_level) : null;
      const t1    = setup.t1_level   != null ? Number(setup.t1_level)   : null;

      if (entry == null || stop == null || t1 == null) { skipped++; continue; }

      // resolveDirection() (server/config/setupTypes.js), not a local isLong() substring
      // match -- 2026-08-17, OPEN_DECISION islongsetup_bug_survives_in_3_other_files.
      // Null (name/price disagreement, or a name-directionless type like ZONE_EDGE_FADE
      // whose price levels also don't resolve it) -- exclude, don't guess.
      const direction = resolveDirection(setup);
      if (direction == null) { skipped++; continue; }
      const long = direction === 'LONG';

      // Skip setups where T1 is on the wrong side of entry (data issue)
      if ( long && t1 <= entry) { skipped++; continue; }
      if (!long && t1 >= entry) { skipped++; continue; }

      // ACD daily context
      const { rows: acdRows } = await db.query(
        `SELECT or_high, or_low, a_up_level, a_down_level, day_type
         FROM acd_daily_log WHERE trade_date = $1`,
        [setup.trade_date]
      );
      const acd     = acdRows[0] || null;
      const dayType = acd?.day_type || null;
      const levelLabel = setup.structural_level_type || nearestLevel(entry, acd);

      // Bars from just after fired_at to session end (16:00 ET)
      const sessionEnd = `${setup.trade_date} 16:00:00`;
      const { rows: bars } = await db.query(`
        SELECT open::float, high::float, low::float, close::float
        FROM price_bars_primary
        WHERE ts > $1 AND ts <= $2
        ORDER BY ts
      `, [setup.fired_at, sessionEnd]);

      if (!bars.length) { skipped++; continue; }

      // Walk bars forward
      let hitT1 = false, hitStop = false, barsToRes = null;
      let mfe = 0, mae = 0;

      for (let i = 0; i < bars.length; i++) {
        const bar = bars[i];

        if (long) {
          mfe = Math.max(mfe, bar.high - entry);
          mae = Math.max(mae, entry - bar.low);
          const t1Hit   = bar.high >= t1;
          const stopHit = bar.low  <= stop;
          if (t1Hit || stopHit) {
            barsToRes = i + 1;
            if (t1Hit && stopHit) {
              // Same bar — favor whichever side the bar opened toward
              hitT1   = bar.open > entry;
              hitStop = !hitT1;
            } else {
              hitT1   = t1Hit;
              hitStop = stopHit;
            }
            break;
          }
        } else {
          mfe = Math.max(mfe, entry - bar.low);
          mae = Math.max(mae, bar.high - entry);
          const t1Hit   = bar.low  <= t1;
          const stopHit = bar.high >= stop;
          if (t1Hit || stopHit) {
            barsToRes = i + 1;
            if (t1Hit && stopHit) {
              hitT1   = bar.open < entry;
              hitStop = !hitT1;
            } else {
              hitT1   = t1Hit;
              hitStop = stopHit;
            }
            break;
          }
        }
      }

      const hitT1First = hitT1 && !hitStop;

      // server/config/instruments.js is the single source of truth for this — found
      // 2026-07-16 (SSOT audit) this line hardcoded $5/point + $5 commission, doubly
      // wrong: it's not even real NQ's $20/pt, and this journal trades MNQ ($2/pt) live
      // anyway. Overstated every computed_pnl_1contract row from this pipeline ~2.5x.
      const { dollarsPerPoint: PNL_PER_POINT, commissionPerRoundTrip: COMMISSION } = LIVE_INSTRUMENT;
      let pnl = null;
      if (hitT1First) {
        pnl = (long ? (t1 - entry) : (entry - t1)) * PNL_PER_POINT - COMMISSION;
      } else if (hitStop) {
        pnl = (long ? (stop - entry) : (entry - stop)) * PNL_PER_POINT - COMMISSION;
      }

      await db.query(`
        INSERT INTO setup_outcome_backtest (
          setup_id, trade_date, setup_type, fired_at,
          entry_price, stop_price, t1_price,
          level_at_entry, nl30_at_entry, structural_state, confluence_score, day_type,
          hit_t1, hit_stop, hit_t1_first,
          mfe_points, mae_points, bars_to_resolution, computed_pnl_1contract
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
        ON CONFLICT (setup_id) DO UPDATE SET
          hit_t1=EXCLUDED.hit_t1, hit_stop=EXCLUDED.hit_stop,
          hit_t1_first=EXCLUDED.hit_t1_first,
          mfe_points=EXCLUDED.mfe_points, mae_points=EXCLUDED.mae_points,
          bars_to_resolution=EXCLUDED.bars_to_resolution,
          computed_pnl_1contract=EXCLUDED.computed_pnl_1contract,
          level_at_entry=EXCLUDED.level_at_entry, day_type=EXCLUDED.day_type
      `, [
        setup.id, setup.trade_date, setup.setup_type, setup.fired_at,
        entry, stop, t1,
        levelLabel,
        setup.nl30_at_detection,
        setup.structural_state_at_detection,
        setup.confluence_score_at_detection,
        dayType,
        hitT1, hitStop, hitT1First,
        Number(mfe.toFixed(2)), Number(mae.toFixed(2)),
        barsToRes, pnl
      ]);

      processed++;

      if (verbose) {
        const outcome = hitT1First ? 'T1 HIT' : hitStop ? 'STOP HIT' : 'NO RESOLUTION';
        console.log(
          `  ${setup.setup_type.padEnd(28)} ${setup.trade_date} ` +
          `${(long ? 'LONG' : 'SHORT').padEnd(5)} ` +
          `entry=${entry} stop=${stop} t1=${t1} → ${outcome} ` +
          `MFE=${mfe.toFixed(1)} MAE=${mae.toFixed(1)}` +
          (pnl != null ? ` P&L=$${pnl.toFixed(2)}` : '')
        );
      }

      rows.push({ setup_id: setup.id, setup_type: setup.setup_type, trade_date: setup.trade_date,
                  hit_t1_first: hitT1First, hit_stop: hitStop && !hitT1First,
                  mfe, mae, barsToRes, pnl });

    } catch (err) {
      errors++;
      if (verbose) console.error(`  ERROR setup ${setup.id}:`, err.message);
    }
  }

  return { processed, skipped, errors, rows };
}

/**
 * Query validated edge combinations from setup_outcome_backtest.
 * Returns all groups; front-end / caller decides the minSamples threshold.
 */
export async function getBacktestEdge(db, { minSamples = 1 } = {}) {
  const { rows } = await db.query(`
    SELECT
      setup_type,
      COALESCE(level_at_entry, 'UNKNOWN')    as level_at_entry,
      COALESCE(structural_state, 'UNKNOWN')  as structural_state,
      CASE WHEN nl30_at_entry > 9  THEN 'BULL'
           WHEN nl30_at_entry < -9 THEN 'BEAR'
           ELSE 'NEUTRAL' END                as nl_regime,
      COUNT(*)                               as sample_size,
      ROUND(AVG(CASE WHEN hit_t1_first THEN 1.0 ELSE 0.0 END) * 100, 1) as win_rate_pct,
      ROUND(AVG(mfe_points), 1)              as avg_mfe,
      ROUND(AVG(mae_points), 1)              as avg_mae,
      ROUND(AVG(computed_pnl_1contract), 2)  as avg_pnl,
      COUNT(*) FILTER (WHERE hit_t1_first)   as wins,
      COUNT(*) FILTER (WHERE hit_stop AND NOT COALESCE(hit_t1_first,false)) as losses,
      COUNT(*) FILTER (WHERE NOT COALESCE(hit_t1,false) AND NOT COALESCE(hit_stop,false)) as no_exit
    FROM setup_outcome_backtest
    GROUP BY setup_type, level_at_entry, structural_state, nl_regime
    HAVING COUNT(*) >= $1
    ORDER BY sample_size DESC, win_rate_pct DESC
  `, [minSamples]);

  return rows;
}

// getMeasuredWinRate() removed 2026-07-16 (dead-ends audit) -- exported, zero callers
// anywhere in the repo (grep-verified). git history has it if ever needed again.
