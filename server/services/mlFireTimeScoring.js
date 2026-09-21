// Fire-time ML feature computation + scoring, 2026-09-21 (user: "why isnt ml tagging every
// trade thats gets fired? Isnt that the point? To study it and make decisions?"). Previously
// features (ml_pd_features/ml_intraday_features) only got computed once/day via the batch
// backfill scripts, and scoring only ran once/day tied to the nightly retrain -- meaning a
// brand-new real trade could sit completely unscored for up to 24 hours even though nothing
// about scoring it actually requires waiting. The LABEL genuinely can't exist until real
// future time passes (it's a question about the future); the SCORE only needs features,
// which are lookahead-safe and knowable the instant a trade fires. This module closes that
// gap -- it does NOT touch label computation at all (still correctly nightly-only).
//
// Lives in server/services/ (not scripts/), unlike the rest of the ml_meta_labeling thread
// -- this file is genuinely imported and run by the live app (server/index.js's 60s
// interval, alongside the other isolated own-poller detectors), matching this codebase's
// own "scripts/ live standalone, services/ get imported by the running app" convention. The
// Python pieces it shells out to (score_one.py) correctly stay in scripts/ml_meta_labeling/
// alongside train.py/dataset.py/score.py, which this module never duplicates.
//
// Scoped to recent fires only (default: last 15 minutes), not the whole backlog -- meant to
// run every ~60s as a fast, incremental top-up, not a second copy of the daily backfill's
// full-history sweep. The daily backfill scripts remain the safety net that eventually
// catches anything this incremental pass misses (a restart gap, a slow feature dependency).
//
// Reuses the EXACT SAME functions/query shapes as backfill_ml_pd_features.mjs and
// backfill_ml_intraday_features.mjs (computePriorDayLevelFeatures/
// computeDevelopingValueFeatures) -- never a second hand-rolled copy of that logic, per this
// codebase's own "export the real function" rule.
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { fileURLToPath } from 'url';
import { query } from '../db.js';
import { REAL_TRADE_FILTER } from '../../scripts/backtest_setup_status.mjs';
import { computePriorDayLevelFeatures, computeDevelopingValueFeatures } from './mlFeatureSnapshot.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..', '..');
const SCORE_ONE_PY = path.join(REPO_ROOT, 'scripts', 'ml_meta_labeling', 'score_one.py');
const PYTHON_BIN = path.join(REPO_ROOT, 'venv', 'bin', 'python3');
const RTH_OPEN_MOD = 570;
const GLOBEX_OPEN_MOD = 1080;
const RECENT_MINUTES_DEFAULT = 15;

async function computeMissingFeatures(recentMinutes) {
  const candidates = await query(`
    SELECT id, trade_date::text AS trade_date, fired_at::text AS fired_at, is_rth,
      entry_zone_low::float AS entry_zone_low, entry_zone_high::float AS entry_zone_high
    FROM active_setups
    WHERE ${REAL_TRADE_FILTER}
      AND fired_at >= NOW() - INTERVAL '${recentMinutes} minutes'
      AND (ml_pd_features IS NULL OR ml_intraday_features IS NULL)
      AND (entry_zone_low IS NOT NULL OR entry_zone_high IS NOT NULL)
  `);

  let pdWritten = 0, intradayWritten = 0;
  for (const row of candidates.rows) {
    const entry = row.entry_zone_high ?? row.entry_zone_low;

    const pdQ = await query(`
      SELECT trade_date::text AS trade_date, poc, vah, val, session_high, session_low,
        session_close, poc_delta_vs_prior, migration_dir_vs_prior, va_overlap_pct_vs_prior
      FROM developing_value_log
      WHERE trade_date < $1::date
      ORDER BY trade_date DESC LIMIT 1
    `, [row.trade_date]);
    const pdFeatures = computePriorDayLevelFeatures(entry, pdQ.rows[0] ?? null);
    if (pdFeatures) {
      await query(`UPDATE active_setups SET ml_pd_features=$1 WHERE id=$2 AND ml_pd_features IS NULL`, [JSON.stringify(pdFeatures), row.id]);
      pdWritten++;
    }

    const boundaryMod = row.is_rth ? RTH_OPEN_MOD : GLOBEX_OPEN_MOD;
    const barsQ = await query(`
      SELECT high::float AS high, low::float AS low, close::float AS close,
        bid_volume::float AS bid_volume, ask_volume::float AS ask_volume
      FROM price_bars_primary
      WHERE symbol='NQ' AND ts >= (
        SELECT ts FROM price_bars_primary
        WHERE symbol='NQ' AND (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts))::int = $2
          AND ts < $1::timestamp AND ts >= $1::timestamp - INTERVAL '20 hours'
        ORDER BY ts DESC LIMIT 1
      ) AND ts < $1::timestamp
      ORDER BY ts ASC
    `, [row.fired_at, boundaryMod]);
    const intradayFeatures = computeDevelopingValueFeatures(barsQ.rows, entry);
    if (intradayFeatures) {
      await query(`UPDATE active_setups SET ml_intraday_features=$1 WHERE id=$2 AND ml_intraday_features IS NULL`,
        [JSON.stringify({ ...intradayFeatures, isRth: row.is_rth, boundaryMod }), row.id]);
      intradayWritten++;
    }
  }
  return { candidates: candidates.rows.length, pdWritten, intradayWritten };
}

async function scoreUnscoredRecent(recentMinutes) {
  const model = await query(`SELECT model_version FROM ml_models ORDER BY trained_at DESC LIMIT 1`);
  if (!model.rows.length) return { scored: 0, skipped: 0, reason: 'no trained model yet' };
  const modelVersion = model.rows[0].model_version;

  // REAL_TRADE_FILTER's own column references (origin_status, resolution_method, etc.) are
  // unqualified -- safe here since active_setups is the only table in FROM (no join, no
  // ambiguity), same as every other consumer of this filter in this codebase.
  const toScore = await query(`
    SELECT id FROM active_setups
    WHERE ${REAL_TRADE_FILTER}
      AND fired_at >= NOW() - INTERVAL '${recentMinutes} minutes'
      AND ml_pd_features IS NOT NULL AND ml_intraday_features IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM ml_verdicts v WHERE v.active_setup_id = active_setups.id AND v.model_version = $1)
  `, [modelVersion]);

  let scored = 0, skipped = 0;
  const results = [];
  for (const row of toScore.rows) {
    try {
      const { stdout } = await execFileAsync(PYTHON_BIN, [SCORE_ONE_PY, String(row.id)], { cwd: REPO_ROOT });
      const result = JSON.parse(stdout.trim().split('\n').pop());
      if (result.scored) scored++; else skipped++;
      results.push({ id: row.id, ...result });
    } catch (e) {
      skipped++;
      results.push({ id: row.id, scored: false, reason: e.message });
    }
  }
  return { scored, skipped, modelVersion, results };
}

export async function scoreNewFires(recentMinutes = RECENT_MINUTES_DEFAULT) {
  const featureResult = await computeMissingFeatures(recentMinutes);
  const scoreResult = await scoreUnscoredRecent(recentMinutes);
  return { featureResult, scoreResult };
}
