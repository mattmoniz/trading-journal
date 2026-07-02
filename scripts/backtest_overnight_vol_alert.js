// =============================================================================
// Backtest: Overnight Volatility Alert Signal
// Question: On days when overnight range > rolling 1σ above mean, does the
// session behave differently? Are setups less reliable? Should you reduce size?
// =============================================================================
import { query } from '../server/db.js';

const LOOKBACK = 20; // rolling days for avg/std

// Get all trading dates with overnight data
const datesQ = await query(`
  SELECT DISTINCT ts::date::text as d
  FROM price_bars_primary
  WHERE symbol='NQ'
    AND (ts AT TIME ZONE 'America/New_York')::time < '09:30:00'
  ORDER BY d
`);
const allDates = datesQ.rows.map(r => r.d);

// For each date (after first LOOKBACK), compute:
// - Overnight range
// - Rolling 20-day avg/std of prior overnight ranges
// - RTH day range
// - Setup win rate (from active_setups if available)
// - Whether DLL was hit (from trades if available)

const rows = [];
for (let i = LOOKBACK; i < allDates.length; i++) {
  const date = allDates[i];
  const priorDates = allDates.slice(i - LOOKBACK, i);

  // Today's overnight range
  const onQ = await query(`
    SELECT MIN(low)::float as lo, MAX(high)::float as hi, (MAX(high)-MIN(low))::float as rng
    FROM price_bars_primary
    WHERE ts::date=$1 AND symbol='NQ'
      AND (ts AT TIME ZONE 'America/New_York')::time < '09:30:00'
  `, [date]);
  const on = onQ.rows[0];
  if (!on?.rng) continue;

  // Prior N-day overnight stats
  const priorQ = await query(`
    SELECT AVG(rng) as avg_rng, STDDEV(rng) as std_rng FROM (
      SELECT (MAX(high)-MIN(low))::float as rng
      FROM price_bars_primary
      WHERE symbol='NQ' AND ts::date = ANY($1::date[])
        AND (ts AT TIME ZONE 'America/New_York')::time < '09:30:00'
      GROUP BY ts::date
    ) x
  `, [priorDates]);
  const avg = parseFloat(priorQ.rows[0]?.avg_rng) || 0;
  const std = parseFloat(priorQ.rows[0]?.std_rng) || 1;
  const sigma = (on.rng - avg) / std;
  const alert = sigma >= 1.0;

  // RTH day range (9:30–16:00)
  const rthQ = await query(`
    SELECT (MAX(high)-MIN(low))::float as day_range,
           MAX(high)::float as day_high, MIN(low)::float as day_low
    FROM price_bars_primary
    WHERE ts::date=$1 AND symbol='NQ'
      AND (ts AT TIME ZONE 'America/New_York')::time BETWEEN '09:30' AND '16:00'
  `, [date]);
  const dayRange = parseFloat(rthQ.rows[0]?.day_range) || 0;

  // Active setups that fired on this date
  const setupQ = await query(`
    SELECT
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE resolution='TARGET_HIT') as wins
    FROM active_setups
    WHERE trade_date=$1 AND resolution IN ('TARGET_HIT','STOP_HIT')
  `, [date]);
  const totalSetups = parseInt(setupQ.rows[0]?.total) || 0;
  const winSetups   = parseInt(setupQ.rows[0]?.wins) || 0;

  rows.push({
    date, on_range: Math.round(on.rng), sigma: parseFloat(sigma.toFixed(2)),
    alert, avg_20d: Math.round(avg), std_20d: Math.round(std),
    day_range: Math.round(dayRange),
    total_setups: totalSetups, win_setups: winSetups,
    wr: totalSetups > 0 ? winSetups / totalSetups : null,
  });
}

// Split into alert vs normal days
const alertDays  = rows.filter(r => r.alert);
const normalDays = rows.filter(r => !r.alert);

function avg(arr) { return arr.length ? arr.reduce((s,v) => s+v, 0) / arr.length : 0; }
function pct(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a,b)=>a-b);
  const idx = (p/100)*(s.length-1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return lo===hi ? s[lo] : s[lo]+(s[hi]-s[lo])*(idx-lo);
}

const alertDayRanges  = alertDays.map(r => r.day_range);
const normalDayRanges = normalDays.map(r => r.day_range);
const alertSetupDays  = alertDays.filter(r => r.total_setups >= 3);
const normalSetupDays = normalDays.filter(r => r.total_setups >= 3);
const alertWRs  = alertSetupDays.map(r => r.wr);
const normalWRs = normalSetupDays.map(r => r.wr);

// Overnight range ratio (how much bigger than normal)
const alertSigmas  = alertDays.map(r => r.sigma);
const normalSigmas = normalDays.map(r => r.sigma);

console.log(`\n===== OVERNIGHT VOLATILITY ALERT BACKTEST =====`);
console.log(`Total dates analyzed: ${rows.length} | Alert days (≥1σ): ${alertDays.length} | Normal days: ${normalDays.length}`);
console.log(`Alert frequency: ${(alertDays.length/rows.length*100).toFixed(1)}% of sessions`);

console.log(`\n--- OVERNIGHT RANGE ---`);
console.log(`Alert days avg ON range:  ${avg(alertDays.map(r=>r.on_range)).toFixed(0)}pt`);
console.log(`Normal days avg ON range: ${avg(normalDays.map(r=>r.on_range)).toFixed(0)}pt`);
console.log(`Alert days sigma range:   ${avg(alertSigmas).toFixed(2)}σ avg, ${pct(alertSigmas,75)?.toFixed(2)}σ p75`);

console.log(`\n--- RTH DAY RANGE (what actually happened during session) ---`);
console.log(`Alert days  — avg: ${avg(alertDayRanges).toFixed(0)}pt  p50: ${pct(alertDayRanges,50)?.toFixed(0)}pt  p75: ${pct(alertDayRanges,75)?.toFixed(0)}pt  p90: ${pct(alertDayRanges,90)?.toFixed(0)}pt`);
console.log(`Normal days — avg: ${avg(normalDayRanges).toFixed(0)}pt  p50: ${pct(normalDayRanges,50)?.toFixed(0)}pt  p75: ${pct(normalDayRanges,75)?.toFixed(0)}pt  p90: ${pct(normalDayRanges,90)?.toFixed(0)}pt`);
console.log(`Day range multiplier on alert days: ${(avg(alertDayRanges)/avg(normalDayRanges)).toFixed(2)}x`);

console.log(`\n--- SETUP WIN RATES (days with ≥3 setups) ---`);
console.log(`Alert days  — N=${alertSetupDays.length} days, avg WR: ${(avg(alertWRs)*100).toFixed(1)}%`);
console.log(`Normal days — N=${normalSetupDays.length} days, avg WR: ${(avg(normalWRs)*100).toFixed(1)}%`);
console.log(`Win rate delta on alert days: ${((avg(alertWRs)-avg(normalWRs))*100).toFixed(1)} percentage points`);

// Breakdown by sigma bucket
console.log(`\n--- BREAKDOWN BY SIGMA BUCKET ---`);
const buckets = [
  { label: 'Normal  (<1σ)',    min: -99, max: 1   },
  { label: 'Elevated (1–2σ)', min: 1,   max: 2   },
  { label: 'Extreme  (>2σ)',  min: 2,   max: 99  },
];
for (const b of buckets) {
  const days = rows.filter(r => r.sigma >= b.min && r.sigma < b.max);
  const setDays = days.filter(r => r.total_setups >= 3);
  const wr = setDays.length ? avg(setDays.map(r => r.wr)) : null;
  console.log(`${b.label}: N=${days.length} sessions | avg RTH range: ${avg(days.map(r=>r.day_range)).toFixed(0)}pt | setup WR: ${wr != null ? (wr*100).toFixed(1)+'%' : '—'} (N=${setDays.length} days)`);
}

// List all alert days
console.log(`\n--- ALL ALERT DAYS (σ≥1.0) ---`);
console.log(`${'Date'.padEnd(12)}${'ON Rng'.padEnd(10)}${'Sigma'.padEnd(8)}${'RTH Rng'.padEnd(10)}${'Setups'.padEnd(8)}WR`);
for (const r of alertDays.sort((a,b)=>b.sigma-a.sigma)) {
  const wrStr = r.total_setups >= 3 ? `${(r.wr*100).toFixed(0)}%` : '(thin)';
  console.log(`${r.date.padEnd(12)}${r.on_range.toString().padEnd(10)}${r.sigma.toFixed(2).padEnd(8)}${r.day_range.toString().padEnd(10)}${r.total_setups.toString().padEnd(8)}${wrStr}`);
}

process.exit(0);
