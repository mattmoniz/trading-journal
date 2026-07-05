// Bar-by-bar MAE/MFE replay engine.
// Used by the backfill script and live resolution path so both stay in sync.

function directionFromType(setupType) {
  const u = setupType.toUpperCase();
  if (u.includes('LONG') || u.includes('BULLISH') || u.includes('_UP')) return 'LONG';
  return 'SHORT';
}

/**
 * Replay a single setup against an ordered array of 1-min bars.
 * bars: [{ ts, open, high, low, close }]  — must start at or after entry bar
 * Returns null if levels are inverted or no bars available.
 */
function replayBars(bars, entry, stop, t1, direction) {
  const entryRisk = direction === 'LONG' ? entry - stop  : stop  - entry;
  const reward    = direction === 'LONG' ? t1    - entry : entry - t1;

  if (entryRisk <= 0 || reward <= 0) return null;
  if (!bars || bars.length === 0)    return null;

  let mfe = 0;
  let mae = 0;
  let resolution = 'EXPIRED';
  let resolutionBarTime = null;
  let barsToResolution = 0;

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    barsToResolution = i + 1;

    const favorable = direction === 'LONG' ? bar.high - entry : entry - bar.low;
    const adverse   = direction === 'LONG' ? entry - bar.low  : bar.high - entry;

    const stopHit   = direction === 'LONG' ? bar.low  <= stop : bar.high >= stop;
    const targetHit = direction === 'LONG' ? bar.high >= t1   : bar.low  <= t1;

    mfe = Math.max(mfe, favorable);
    mae = Math.max(mae, adverse);

    if (stopHit && targetHit) {
      // Same-bar conflict: conservative = stop wins
      resolution = 'STOP_HIT';
      resolutionBarTime = bar.ts;
      break;
    } else if (stopHit) {
      resolution = 'STOP_HIT';
      resolutionBarTime = bar.ts;
      break;
    } else if (targetHit) {
      resolution = 'TARGET_HIT';
      resolutionBarTime = bar.ts;
      break;
    }
  }

  if (resolution === 'EXPIRED') {
    resolutionBarTime = bars[bars.length - 1]?.ts ?? null;
    barsToResolution = bars.length;
  }

  return { mfe, mae, barsToResolution, resolutionBarTime, replayResolution: resolution };
}

/**
 * Fetch the 1-min bars for a setup from the DB and run the replay.
 * queryFn: (sql, params) => { rows } — pass server/db.js query
 * Returns same shape as replayBars(), or null on data gaps.
 */
async function computeMaeMfe(queryFn, setupRow) {
  const {
    setup_type,
    entry_zone_low, entry_zone_high,
    stop_level, t1_level,
    fired_at, trade_date,
  } = setupRow;

  const hi    = entry_zone_high != null ? parseFloat(entry_zone_high) : parseFloat(entry_zone_low);
  const entry = (parseFloat(entry_zone_low) + hi) / 2;
  const stop  = parseFloat(stop_level);
  const t1    = parseFloat(t1_level);
  const direction = directionFromType(setup_type);

  // Fetch bars from fired_at to end of RTH session (4PM ET = minute 960)
  const barsResult = await queryFn(`
    SELECT ts, open::float, high::float, low::float, close::float
    FROM price_bars_primary
    WHERE ts::date = $1
      AND ts >= $2
      AND (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts)) <= 960
    ORDER BY ts
  `, [trade_date, fired_at]);

  return replayBars(barsResult.rows, entry, stop, t1, direction);
}

export { directionFromType, replayBars, computeMaeMfe };
