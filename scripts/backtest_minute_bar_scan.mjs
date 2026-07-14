// Persists Claude's independent minute-bar pattern scanner (scratch/claude_minute_bar_scanner.mjs
// and scratch/claude_minute_bar_scanner_original_grid.mjs) into performance_audit so every
// combination — profitable or not — is tracked forward, not just the survivors.
//
// signal_type='MINUTE_BAR_SCAN'. Two rows per combo per run: window_days=0 (all-time) and
// window_days=60 (trailing 60 trading days), so degradation/improvement is visible the same
// way other signal_types in this table already track it. recommendation holds the rigor-bar
// status: PASSES_BAR / BELOW_COST_FLOOR / UNSTABLE_ACROSS_TIME / INSUFFICIENT_N.
//
// Grid here is the UNION of both prior scanner runs' lookback/horizon values, plus MOMENTUM_2m
// (added 2026-07-13 per user request) — a full rectangular grid, not a stitch of the two old
// runs, so every cell is freshly and consistently computed.
//
// No lookahead (see scratch/claude_minute_bar_scanner.mjs header for the full design rationale):
// rolling 20-trading-day extreme thresholds, fire-once event detection, forward outcome capped
// at session end. Day-type conditioning restricted to events at/after 10:30 ET (acd_daily_log
// reclassifies at IB close) — see scratch/claude_minute_bar_conditioning.mjs for the original
// audit that found this restriction was necessary.
import { query } from '../server/db.js';

const COST_FLOOR_PT = 1.0;
const MIN_N = 20;
const THRESHOLD_WINDOW_DAYS = 20;
const EXTREME_PCTL = 0.20;
const RECENT_DAYS = 60;

// Full 1-20m sweep added 2026-07-14 (initial exploration dispatched to Gemini, folded in here
// under this script's own consistent date-window convention rather than mixing two slightly
// different windows in the same table — Gemini's SQL used <= CURRENT_DATE, which pulled in
// today's partial in-progress session; this script uses < CURRENT_DATE, full days only).
const MOMENTUM_LOOKBACKS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 30, 60];
const RANGE_LOOKBACKS = [5, 15, 30, 60];
const VOLZ_LOOKBACKS = [5, 15, 30, 60];
const HORIZONS = [5, 15, 30, 60];

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
const dayStartGi = new Map(), dayEndGi = new Map(), giToDay = new Array(bars.length);
{
  let prevDay = null;
  for (let gi = 0; gi < bars.length; gi++) {
    const d = String(bars[gi].td);
    giToDay[gi] = d;
    if (d !== prevDay) { dayStartGi.set(d, gi); prevDay = d; }
    dayEndGi.set(d, gi);
  }
}
console.log(`Loaded ${bars.length} bars, ${days.length} days (${days[0]} to ${days[days.length - 1]})`);
const recentDaySet = new Set(days.slice(-RECENT_DAYS));

function momentum(gi, lb) { const gj = gi - lb; if (gj < 0) return null; return bars[gi].close - bars[gj].close; }
function range(gi, lb) {
  const gj = gi - lb; if (gj < 0) return null;
  const slice = bars.slice(gj, gi + 1);
  return Math.max(...slice.map(b => b.high)) - Math.min(...slice.map(b => b.low));
}
function volumeZ(gi, lb) {
  const gj = gi - lb, baseGj = gi - 60;
  if (gj < 0 || baseGj < 0) return null;
  const recentVol = bars.slice(gj, gi + 1).reduce((s, b) => s + b.volume, 0);
  const baseline = bars.slice(baseGj, gi + 1).map(b => b.volume);
  const mean = baseline.reduce((a, b) => a + b, 0) / baseline.length;
  const variance = baseline.reduce((a, b) => a + (b - mean) ** 2, 0) / baseline.length;
  return ((recentVol / (lb + 1)) - mean) / (Math.sqrt(variance) || 1);
}
function bodyRatio(gi) { const b = bars[gi]; const rng = b.high - b.low; if (rng < 0.25) return null; return (b.close - b.open) / rng; }
function vwapDist(gi) {
  const startGi = dayStartGi.get(giToDay[gi]);
  let pv = 0, v = 0;
  for (let k = startGi; k <= gi; k++) { pv += bars[k].close * bars[k].volume; v += bars[k].volume; }
  if (v === 0) return null;
  return bars[gi].close - (pv / v);
}

const PREDICTORS = [
  ...MOMENTUM_LOOKBACKS.map(lb => ({ name: `MOMENTUM_${lb}m`, fn: gi => momentum(gi, lb) })),
  ...RANGE_LOOKBACKS.map(lb => ({ name: `RANGE_${lb}m`, fn: gi => range(gi, lb) })),
  ...VOLZ_LOOKBACKS.map(lb => ({ name: `VOLZ_${lb}m`, fn: gi => volumeZ(gi, lb) })),
  { name: 'BODY_RATIO', fn: gi => bodyRatio(gi) },
  { name: 'VWAP_DIST', fn: gi => vwapDist(gi) },
];
console.log(`Predictor variants: ${PREDICTORS.length} | Horizons: ${HORIZONS.join(',')}m | Total combos: ${PREDICTORS.length * HORIZONS.length}`);

const predValues = new Map();
for (const pred of PREDICTORS) {
  const vals = new Array(bars.length);
  for (let gi = 0; gi < bars.length; gi++) vals[gi] = pred.fn(gi);
  predValues.set(pred.name, vals);
}

function thresholdsForDay(predName, dayIdx) {
  if (dayIdx < THRESHOLD_WINDOW_DAYS) return null;
  const vals = predValues.get(predName);
  const collected = [];
  for (let k = dayIdx - THRESHOLD_WINDOW_DAYS; k < dayIdx; k++) {
    const d = days[k];
    for (let gi = dayStartGi.get(d); gi <= dayEndGi.get(d); gi++) { const v = vals[gi]; if (v != null) collected.push(v); }
  }
  if (collected.length < 100) return null;
  collected.sort((a, b) => a - b);
  return { lo: collected[Math.floor(collected.length * EXTREME_PCTL)], hi: collected[Math.floor(collected.length * (1 - EXTREME_PCTL))] };
}

function runTest(predName, horizonMin) {
  const events = [];
  const vals = predValues.get(predName);
  for (let dayIdx = THRESHOLD_WINDOW_DAYS; dayIdx < days.length; dayIdx++) {
    const d = days[dayIdx];
    const th = thresholdsForDay(predName, dayIdx);
    if (!th) continue;
    const startGi = dayStartGi.get(d), endGi = dayEndGi.get(d);
    let wasExtreme = false;
    for (let gi = startGi; gi <= endGi; gi++) {
      const v = vals[gi];
      if (v == null) { wasExtreme = false; continue; }
      const isHigh = v >= th.hi, isLow = v <= th.lo, isExtreme = isHigh || isLow;
      if (isExtreme && !wasExtreme) {
        const fwdGi = gi + horizonMin;
        if (fwdGi <= endGi) {
          const fwdMove = bars[fwdGi].close - bars[gi].close;
          events.push({ day: d, etMin: bars[gi].et_min, dir: isHigh ? 1 : -1, fwdMove });
        }
      }
      wasExtreme = isExtreme;
    }
  }
  return events;
}

function evOf(evts) {
  if (!evts.length) return null;
  return evts.reduce((s, e) => s + (Math.sign(e.fwdMove) === e.dir ? Math.abs(e.fwdMove) : -Math.abs(e.fwdMove)), 0) / evts.length;
}
function wrOf(evts) {
  if (!evts.length) return null;
  return evts.filter(e => Math.sign(e.fwdMove) === e.dir).length / evts.length;
}
function threeWaySplit(evts) {
  const third = Math.floor(evts.length / 3);
  const g1 = evts.slice(0, third), g2 = evts.slice(third, 2 * third), g3 = evts.slice(2 * third);
  return { ev1: evOf(g1), ev2: evOf(g2), ev3: evOf(g3), n1: g1.length, n2: g2.length, n3: g3.length };
}
function statusOf(evts) {
  const n = evts.length;
  if (n < MIN_N) return { status: 'INSUFFICIENT_N', ev: null, wr: null };
  const ev = evOf(evts), wr = wrOf(evts);
  const split = threeWaySplit(evts);
  const allSameSign = [split.ev1, split.ev2, split.ev3].every(v => v != null && Math.sign(v) === Math.sign(ev));
  const stable = allSameSign && split.n1 >= 5 && split.n2 >= 5 && split.n3 >= 5;
  const clearsCost = Math.abs(ev) > COST_FLOOR_PT;
  return { status: (stable && clearsCost) ? 'PASSES_BAR' : (clearsCost ? 'UNSTABLE_ACROSS_TIME' : 'BELOW_COST_FLOOR'), ev, wr };
}

// ── Day-type map for the 2 conditioned variants (only valid at/after 10:30 ET) ──
const dayTypeRows = await query(`SELECT trade_date::text as td, day_type FROM acd_daily_log WHERE day_type IS NOT NULL`);
const dayTypeMap = new Map(dayTypeRows.rows.map(r => [r.td, r.day_type]));

const results = []; // { signalName, allEvts, recentEvts }
for (const pred of PREDICTORS) {
  for (const horizon of HORIZONS) {
    const evts = runTest(pred.name, horizon);
    const signalName = `${pred.name}_${horizon}m`;
    results.push({ signalName, allEvts: evts, recentEvts: evts.filter(e => recentDaySet.has(e.day)) });
  }
}
// The 2 day-type-conditioned variants of MOMENTUM_60m/60m (found stable in scratch/claude_minute_bar_conditioning.mjs)
const momentum6060 = results.find(r => r.signalName === 'MOMENTUM_60m_60m').allEvts;
const trendEvts = momentum6060.filter(e => e.etMin >= 630 && dayTypeMap.get(e.day) === 'TREND');
const balanceEvts = momentum6060.filter(e => e.etMin >= 630 && dayTypeMap.get(e.day) === 'BALANCE');
results.push({ signalName: 'MOMENTUM_60m_60m_TREND', allEvts: trendEvts, recentEvts: trendEvts.filter(e => recentDaySet.has(e.day)) });
results.push({ signalName: 'MOMENTUM_60m_60m_BALANCE_FADE', allEvts: balanceEvts, recentEvts: balanceEvts.filter(e => recentDaySet.has(e.day)) });

console.log(`\nTotal signals (including the 2 day-type-conditioned variants): ${results.length}\n`);

// Use the DB server's own CURRENT_DATE (America/New_York), not JS's UTC toISOString() —
// they can disagree by a day (e.g. 2026-07-14 UTC while still 2026-07-13 ET), which caused a
// real same-run date mismatch against backtest_momentum60_daytype.mjs's SQL-side CURRENT_DATE.
// Caught by Gemini's recalibration audit 2026-07-14.
const { rows: [{ today: runDate }] } = await query(`SELECT CURRENT_DATE::text as today`);
// Idempotent DELETE+INSERT (same pattern as mine_session_bias.mjs) — safe to re-run same-day
// as the grid expands, and this is how the weekly cron re-run replaces the day's numbers.
await query(`DELETE FROM performance_audit WHERE signal_type = 'MINUTE_BAR_SCAN' AND run_date = $1`, [runDate]);
let inserted = 0, passCount = 0;
for (const r of results) {
  const allStat = statusOf(r.allEvts);
  const recentStat = statusOf(r.recentEvts);
  if (allStat.status === 'PASSES_BAR') passCount++;

  await query(`
    INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, win_rate, ev_per_trade, recommendation, notes)
    VALUES ($1, 0, 'MINUTE_BAR_SCAN', $2, $3, $4, $5, $6, $7)
  `, [runDate, r.signalName, r.allEvts.length, allStat.wr, allStat.ev, allStat.status,
      'All-time. Continuation hypothesis (trade WITH the extreme direction) — negative EV means the real edge, if any, is the opposite (fade).']);
  inserted++;

  await query(`
    INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, win_rate, ev_per_trade, recommendation, notes)
    VALUES ($1, 60, 'MINUTE_BAR_SCAN', $2, $3, $4, $5, $6, $7)
  `, [runDate, r.signalName, r.recentEvts.length, recentStat.wr, recentStat.ev, recentStat.status,
      `Trailing ${RECENT_DAYS} trading days, compare against the window_days=0 row for the same signal_name and run_date to check drift.`]);
  inserted++;

  const flag = allStat.status === 'PASSES_BAR' ? '  <-- PASSES_BAR' : '';
  console.log(`  ${r.signalName.padEnd(32)} all-time N=${String(r.allEvts.length).padEnd(6)} EV=${allStat.ev?.toFixed(2) ?? 'n/a'}  |  recent60 N=${String(r.recentEvts.length).padEnd(5)} EV=${recentStat.ev?.toFixed(2) ?? 'n/a'}${flag}`);
}

console.log(`\nWrote ${inserted} rows to performance_audit (signal_type='MINUTE_BAR_SCAN', run_date=${runDate}).`);
console.log(`${passCount}/${results.length} signals pass the full rigor bar (all-time).`);
process.exit(0);
