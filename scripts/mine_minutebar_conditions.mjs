/**
 * mine_minutebar_conditions.mjs
 *
 * Extends patternScannerService.js's mineLevelFades() dimensional cross-cut approach (dow,
 * hour, session_type, day_type, range_bucket, overnight_inventory, open_vs_prior_value) to the
 * MOMENTUM_60m/60m and VOLZ_30m/60m bar-window statistical-extreme event families from the
 * 2026-07-14 minute-bar scanner — a structurally different kind of signal (not a level touch),
 * so mineLevelFades() itself can't cover it, but the SAME conditional-pattern-mining idea and
 * the SAME `pattern_discoveries` table apply.
 *
 * Key upgrade vs. the original scanner's own EV check: win/loss here is classified by
 * simulating a REAL stop/target (p75 MAE / p50 MFE, derived from this run's own touches, same
 * convention as scripts/backtest_momentum60_daytype.mjs), not the raw point-value-at-horizon —
 * that raw-value approach turned out to hide 3 of 4 signals being real losers once a real stop
 * was applied (see docs/OPEN_THREADS.md 2026-07-14). Do not regress to raw point value here.
 *
 * Perpetual, not one-off: re-run via run_weekly_backtests.sh. Discoveries persist to
 * pattern_discoveries with the same ACTIVE/DEGRADED lifecycle mineLevelFades() already uses —
 * one shared table, not a second silo.
 *
 * No lookahead: rolling 20-trading-day extreme thresholds (never full-history, never today's
 * own data), fire-once event detection, forward outcome capped at session end. Day-type context
 * only used from bars at/after 10:30 ET (acd_daily_log reclassifies at IB close).
 */
import { query } from '../server/db.js';

const THRESHOLD_WINDOW_DAYS = 20;
const EXTREME_PCTL = 0.20;
const HORIZON_MIN = 60;
const PNL_PER_PT = 2;
const MIN_N = 20; // CLAUDE.md hard floor
const MIN_WR = 0.55; // lower than mineLevelFades' 0.65 — these are thinner-edge signals by nature; net-positive EV is the real gate

const { rows: bars } = await query(`
  WITH raw AS (
    SELECT
      (ts AT TIME ZONE 'America/New_York')::date AS td,
      (EXTRACT(HOUR FROM ts AT TIME ZONE 'America/New_York')*60+EXTRACT(MINUTE FROM ts AT TIME ZONE 'America/New_York'))::int as et_min,
      ts, open::float, high::float, low::float, close::float, volume::float
    FROM price_bars_primary
    WHERE symbol='NQ'
      AND (ts AT TIME ZONE 'America/New_York')::date >= '2023-11-15'
      AND (ts AT TIME ZONE 'America/New_York')::date < CURRENT_DATE
      AND (EXTRACT(hour FROM ts AT TIME ZONE 'America/New_York')*60+EXTRACT(minute FROM ts AT TIME ZONE 'America/New_York')) BETWEEN 570 AND 959
  )
  SELECT td, et_min,
    (array_agg(open ORDER BY ts ASC))[1] as open,
    MAX(high) as high, MIN(low) as low,
    (array_agg(close ORDER BY ts DESC))[1] as close,
    SUM(volume) as volume
  FROM raw GROUP BY td, et_min ORDER BY td, et_min
`);
const days = [...new Set(bars.map(b => String(b.td)))].sort();
const dayStartGi = new Map(), dayEndGi = new Map();
{
  let prevDay = null;
  for (let gi = 0; gi < bars.length; gi++) {
    const d = String(bars[gi].td);
    if (d !== prevDay) { dayStartGi.set(d, gi); prevDay = d; }
    dayEndGi.set(d, gi);
  }
}
console.log(`Loaded ${bars.length} bars, ${days.length} days`);

function momentum(gi, lb) { const gj = gi - lb; if (gj < 0) return null; return bars[gi].close - bars[gj].close; }
function volumeZ(gi, lb) {
  const gj = gi - lb, baseGj = gi - 60;
  if (gj < 0 || baseGj < 0) return null;
  const recentVol = bars.slice(gj, gi + 1).reduce((s, b) => s + b.volume, 0);
  const baseline = bars.slice(baseGj, gi + 1).map(b => b.volume);
  const mean = baseline.reduce((a, b) => a + b, 0) / baseline.length;
  const variance = baseline.reduce((a, b) => a + (b - mean) ** 2, 0) / baseline.length;
  return ((recentVol / (lb + 1)) - mean) / (Math.sqrt(variance) || 1);
}

function thresholdsForDay(vals, dayIdx) {
  if (dayIdx < THRESHOLD_WINDOW_DAYS) return null;
  const collected = [];
  for (let k = dayIdx - THRESHOLD_WINDOW_DAYS; k < dayIdx; k++) {
    const d = days[k];
    for (let gi = dayStartGi.get(d); gi <= dayEndGi.get(d); gi++) { const v = vals[gi]; if (v != null) collected.push(v); }
  }
  if (collected.length < 100) return null;
  collected.sort((a, b) => a - b);
  return { lo: collected[Math.floor(collected.length * EXTREME_PCTL)], hi: collected[Math.floor(collected.length * (1 - EXTREME_PCTL))] };
}

function runTest(vals) {
  const events = [];
  for (let dayIdx = THRESHOLD_WINDOW_DAYS; dayIdx < days.length; dayIdx++) {
    const d = days[dayIdx];
    const th = thresholdsForDay(vals, dayIdx);
    if (!th) continue;
    const startGi = dayStartGi.get(d), endGi = dayEndGi.get(d);
    let wasExtreme = false;
    for (let gi = startGi; gi <= endGi; gi++) {
      const v = vals[gi];
      if (v == null) { wasExtreme = false; continue; }
      const isHigh = v >= th.hi, isLow = v <= th.lo, isExtreme = isHigh || isLow;
      if (isExtreme && !wasExtreme) {
        const fwdGi = gi + HORIZON_MIN;
        if (fwdGi <= endGi) events.push({ gi, endGi, day: d, etMin: bars[gi].et_min, dir: isHigh ? 1 : -1 });
      }
      wasExtreme = isExtreme;
    }
  }
  return events;
}

// ── Context dimensions, same sources as mineLevelFades() in patternScannerService.js ──
const sessionRows = await query(`SELECT trade_date::text as td, session_type, range_pt FROM session_analysis`);
const sessionMap = new Map(sessionRows.rows.map(r => [r.td, r]));
const dayTypeRows = await query(`SELECT trade_date::text as td, day_type FROM acd_daily_log WHERE day_type IS NOT NULL`);
const dayTypeMap = new Map(dayTypeRows.rows.map(r => [r.td, r.day_type]));
const auctionRows = await query(`SELECT trade_date::text as td, overnight_inventory, open_vs_prior_value FROM auction_reads`);
const auctionMap = new Map(auctionRows.rows.map(r => [r.td, r]));
const DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function dowOf(dateStr) { return new Date(dateStr + 'T12:00:00Z').getUTCDay(); }

function annotate(evts) {
  return evts.map(e => {
    const sess = sessionMap.get(e.day);
    const rangeDay = sess?.range_pt || 0;
    return {
      ...e,
      dowName: DOW_NAMES[dowOf(e.day)],
      hour: Math.floor(e.etMin / 60),
      sessionType: sess?.session_type || 'UNKNOWN',
      dayType: dayTypeMap.get(e.day) || 'UNKNOWN',
      rangeBucket: rangeDay < 200 ? 'NARROW' : rangeDay < 400 ? 'NORMAL' : rangeDay < 600 ? 'WIDE' : 'EXTREME',
      overnight: auctionMap.get(e.day)?.overnight_inventory || 'UNKNOWN',
      openVsVal: auctionMap.get(e.day)?.open_vs_prior_value || 'UNKNOWN',
    };
  });
}

// MAE/MFE-derived stop/target (p75 MAE / p50 MFE), same convention as
// scripts/backtest_momentum60_daytype.mjs — never a hardcoded point value.
function maeMfe(evts, tradeDirFn) {
  const maes = [], mfes = [];
  for (const e of evts) {
    const tradeDir = tradeDirFn(e);
    const entry = bars[e.gi].close;
    const windowEnd = Math.min(e.gi + HORIZON_MIN, e.endGi);
    let mae = 0, mfe = 0;
    for (let gi = e.gi + 1; gi <= windowEnd; gi++) {
      const b = bars[gi];
      const favorable = tradeDir === 1 ? b.high - entry : entry - b.low;
      const adverse = tradeDir === 1 ? entry - b.low : b.high - entry;
      if (favorable > mfe) mfe = favorable;
      if (adverse > mae) mae = adverse;
    }
    maes.push(mae); mfes.push(mfe);
  }
  maes.sort((a, b) => a - b); mfes.sort((a, b) => a - b);
  const pct = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];
  return { stop: pct(maes, 0.75), target: pct(mfes, 0.50) };
}

// Simulate as a real trade (first-touched-wins, bar HLC, resolve by window's final bar if
// neither hit) — same convention as backtest_momentum60_daytype.mjs. Returns win/pnl per event.
function simulate(evts, tradeDirFn, stop, target) {
  return evts.map(e => {
    const tradeDir = tradeDirFn(e);
    const entry = bars[e.gi].close;
    const stopPx = tradeDir === 1 ? entry - stop : entry + stop;
    const targetPx = tradeDir === 1 ? entry + target : entry - target;
    const windowEnd = Math.min(e.gi + HORIZON_MIN, e.endGi);
    let resolution = null;
    for (let gi = e.gi + 1; gi <= windowEnd; gi++) {
      const b = bars[gi];
      if (tradeDir === 1) {
        if (b.low <= stopPx) { resolution = 'STOP'; break; }
        if (b.high >= targetPx) { resolution = 'TARGET'; break; }
      } else {
        if (b.high >= stopPx) { resolution = 'STOP'; break; }
        if (b.low <= targetPx) { resolution = 'TARGET'; break; }
      }
    }
    if (!resolution) {
      const finalClose = bars[windowEnd].close;
      const finalMove = tradeDir === 1 ? finalClose - entry : entry - finalClose;
      resolution = finalMove > 0 ? 'TARGET' : 'STOP';
    }
    const win = resolution === 'TARGET';
    return { ...e, win, pnl: (win ? target : -stop) * PNL_PER_PT };
  });
}

const dimensions = [
  { name: 'minutebar_dow', fn: t => t.dowName },
  { name: 'minutebar_hour', fn: t => `${t.hour}:00` },
  { name: 'minutebar_session', fn: t => t.sessionType },
  { name: 'minutebar_daytype', fn: t => t.dayType },
  { name: 'minutebar_range', fn: t => t.rangeBucket },
  { name: 'minutebar_overnight', fn: t => t.overnight },
  { name: 'minutebar_openval', fn: t => t.openVsVal },
  { name: 'minutebar_daytype_x_hour', fn: t => `${t.dayType}×${t.hour}:00` },
];

async function mineFamily(familyName, tradeDirFn, evtsRaw) {
  const evts = annotate(evtsRaw);
  const { stop, target } = maeMfe(evts, tradeDirFn);
  const trades = simulate(evts, tradeDirFn, stop, target);
  console.log(`\n${familyName}: N=${trades.length}, stop=${stop.toFixed(1)}pt, target=${target.toFixed(1)}pt (derived from this run's own MAE/MFE)`);

  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const discoveries = [];
  for (const dim of dimensions) {
    const groups = {};
    for (const t of trades) {
      const key = dim.fn(t);
      if (!groups[key]) groups[key] = { wins: 0, losses: 0, pnl: 0 };
      groups[key][t.win ? 'wins' : 'losses']++;
      groups[key].pnl += t.pnl;
    }
    for (const [key, r] of Object.entries(groups)) {
      const total = r.wins + r.losses;
      if (total < MIN_N) continue;
      const wr = r.wins / total;
      if (wr >= MIN_WR && r.pnl > 0) {
        discoveries.push({ patternKey: `${familyName}:${dim.name}:${key}`, dimension: dim.name, wr, n: total, netPnl: r.pnl });
      }
    }
  }

  for (const disc of discoveries) {
    const existing = await query(`SELECT id, sample_size FROM pattern_discoveries WHERE pattern_key=$1`, [disc.patternKey]);
    const context = JSON.stringify({ family: familyName, stop: +stop.toFixed(1), target: +target.toFixed(1), source: 'mine_minutebar_conditions.mjs' });
    if (existing.rows.length === 0) {
      await query(
        `INSERT INTO pattern_discoveries (pattern_key, dimension, win_rate, sample_size, net_pnl_dollars, first_seen, last_updated, status, context)
         VALUES ($1,$2,$3,$4,$5,$6,$6,'ACTIVE',$7)`,
        [disc.patternKey, disc.dimension, disc.wr, disc.n, disc.netPnl, todayStr, context]);
      console.log(`  NEW  ${disc.patternKey.padEnd(45)} N=${disc.n} WR=${(100*disc.wr).toFixed(1)}% netPnl=$${disc.netPnl.toFixed(0)}`);
    } else {
      await query(
        `UPDATE pattern_discoveries SET win_rate=$2, sample_size=$3, net_pnl_dollars=$4, last_updated=$5, status='ACTIVE', context=$6 WHERE id=$1`,
        [existing.rows[0].id, disc.wr, disc.n, disc.netPnl, todayStr, context]);
    }
  }

  // Mark this family's patterns that fell below threshold as degraded (same lifecycle as mineLevelFades)
  const activeKeys = new Set(discoveries.map(d => d.patternKey));
  const allActive = await query(`SELECT id, pattern_key FROM pattern_discoveries WHERE status='ACTIVE' AND pattern_key LIKE $1`, [`${familyName}:%`]);
  for (const row of allActive.rows) {
    if (!activeKeys.has(row.pattern_key)) {
      await query(`UPDATE pattern_discoveries SET status='DEGRADED', last_updated=$2 WHERE id=$1`, [row.id, todayStr]);
    }
  }
  console.log(`  ${discoveries.length} discoveries (N>=${MIN_N}, WR>=${(100*MIN_WR).toFixed(0)}%, net-positive)`);
  return discoveries;
}

const momVals = new Array(bars.length); for (let gi = 0; gi < bars.length; gi++) momVals[gi] = momentum(gi, 60);
const volzVals = new Array(bars.length); for (let gi = 0; gi < bars.length; gi++) volzVals[gi] = volumeZ(gi, 30);
const momEvts = runTest(momVals);
const volzEvts = runTest(volzVals);

const momDiscoveries = await mineFamily('MOMENTUM_60m_60m', e => e.dir, momEvts);
const volzDiscoveries = await mineFamily('VOLZ_30m_60m', e => -e.dir, volzEvts); // fade direction, matches the base signal's own real-world direction

console.log(`\n[mine_minutebar_conditions] Total: ${momDiscoveries.length + volzDiscoveries.length} discoveries persisted to pattern_discoveries.`);
process.exit(0);
