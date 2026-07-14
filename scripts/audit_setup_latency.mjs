// =============================================================================
// Nightly Setup Latency Audit
//
// For each level-fade setup fired today (or passed date), finds the first
// price bar where price came within PROXIMITY_PT of the entry level, then
// computes the detection lag: fired_at - first_bar_ts.
//
// Classifies each setup as:
//   OK          : lag 0–60s (0–1 min)   — detected within 1 poll cycle
//   SLOW        : lag 61–120s (1–2 min) — entry window narrowing
//   CRITICAL    : lag > 120s (2 min+)   — first-touch fade window likely gone
//   RETROACTIVE : lag > 2700s (45 min)  — early-touch backfill, not live (expected)
//   NEGATIVE    : fired_at < first_bar_ts — detection bug
//
// Writes to performance_audit (signal_type='LATENCY_AUDIT').
// If any CRITICAL or NEGATIVE setups found today, appends a warning to
// scratch/gemini_alerts.txt so the error watcher picks it up.
//
// Run: node scripts/audit_setup_latency.mjs [YYYY-MM-DD]
//   Default: today (ET)
// =============================================================================

import { query } from '../server/db.js';
import fs from 'fs';
import path from 'path';

const PROXIMITY_PT   = 15;   // match live detection window
const SLOW_THRESH_S  = 60;   // 1 min — already a missed poll cycle; entry window narrowing
const CRIT_THRESH_S  = 120;  // 2 min — first-touch fade window likely gone or compromised
const RETRO_THRESH_S = 2700; // 45 min — IB early-touch backfill fires ~60 min after 9:30 first touch

const ALERTS_FILE = path.resolve('scratch/gemini_alerts.txt');

function nowET() {
  return new Date().toLocaleString('en-CA', { timeZone: 'America/New_York' }).replace(',', '');
}

function percentile(arr, p) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

async function run(targetDate) {
  console.log(`\n=== SETUP LATENCY AUDIT — ${targetDate} ===\n`);

  // RTH open = trade_date 09:30:00 (ts is stored as naive ET)
  // For RTH-fired setups, only look at RTH bars (>=09:30) — globex bars near
  // the same price are coincidental and inflate lag numbers.
  // For pre-market setups (fired before 09:30), compare against all bars.
  const res = await query(`
    WITH setups AS (
      SELECT
        s.id,
        s.setup_type,
        s.trade_date,
        s.fired_at,
        s.status,
        s.resolution,
        s.entry_zone_low::numeric AS level_price,
        -- classify RTH vs pre-market
        CASE WHEN s.fired_at >= (s.trade_date + TIME '09:30:00')
             THEN 'RTH' ELSE 'PREMARKET' END AS session,
        -- Formation-gate floor: OR_HIGH_FADE/OR_LOW_FADE use the live 5-min OR
        -- (acdService.js computes or_high/or_low from bars 570-574 et_min, i.e.
        -- closes 9:35 ET); IB_HIGH_FADE/IB_LOW_FADE/IB_MID_SCALP_FADE/
        -- OR_MID_AFTER_IB_FADE all read a level that's explicitly null until
        -- etMinNow >= 630 (10:30 ET) in acd.js. A touch before these times isn't
        -- a detection failure — the level doesn't exist yet. Verified against
        -- acd.js/acdService.js 2026-07-14, do not guess new gates without
        -- checking the actual level source the same way.
        -- NOT included here despite similar naming: PD_IB_HIGH/LOW/MID_FADE and
        -- 10D_IB_MID_FADE use prior-day/historical levels (known before the
        -- open) — a touch-before-fire lag on those IS real and should still count.
        CASE
          WHEN s.setup_type LIKE 'OR_HIGH_FADE%' OR s.setup_type LIKE 'OR_LOW_FADE%'
            THEN s.trade_date + TIME '09:35:00'
          WHEN s.setup_type LIKE 'IB_HIGH_FADE%' OR s.setup_type LIKE 'IB_LOW_FADE%'
            OR s.setup_type LIKE 'IB_MID_SCALP_FADE%' OR s.setup_type LIKE 'OR_MID_AFTER_IB_FADE%'
            THEN s.trade_date + TIME '10:30:00'
          ELSE NULL
        END AS formation_ready_ts
      FROM active_setups s
      WHERE s.trade_date = $1
        AND s.setup_type LIKE '%FADE%'
        AND s.entry_zone_low IS NOT NULL
    ),
    first_bar AS (
      SELECT DISTINCT ON (s.id)
        s.id,
        b.ts                           AS first_bar_ts,
        EXTRACT(epoch FROM (s.fired_at - b.ts))::int AS lag_s
      FROM setups s
      JOIN price_bars_primary b ON
        b.ts::date = s.trade_date
        AND b.high >= s.level_price - $2
        AND b.low  <= s.level_price + $2
        -- RTH setups: only look at RTH bars; pre-market: all bars
        AND (s.session = 'PREMARKET'
             OR b.ts >= (s.trade_date + TIME '09:30:00'))
      ORDER BY s.id, b.ts ASC
    )
    SELECT
      s.id,
      s.setup_type,
      s.trade_date,
      s.fired_at,
      s.status,
      s.resolution,
      s.level_price,
      s.session,
      s.formation_ready_ts,
      fb.first_bar_ts,
      fb.lag_s
    FROM setups s
    LEFT JOIN first_bar fb ON fb.id = s.id
    ORDER BY s.session DESC, s.fired_at
  `, [targetDate, PROXIMITY_PT]);

  const rows = res.rows;
  if (!rows.length) {
    console.log('No FADE setups found for this date.');
    return;
  }

  console.log(`Found ${rows.length} FADE setups.\n`);

  // Classify each row
  const classified = rows.map(r => {
    let lag = r.lag_s != null ? parseInt(r.lag_s) : null;
    let formationAdjusted = false;

    // Formation-gate correction: OR_HIGH_FADE/OR_LOW_FADE/IB_HIGH_FADE/IB_LOW_FADE/
    // IB_MID_SCALP_FADE/OR_MID_AFTER_IB_FADE read a level that doesn't exist until
    // the OR (9:35 ET) or IB (10:30 ET) closes (see formation_ready_ts in the SQL
    // above — verified against acd.js/acdService.js 2026-07-14). A raw touch before
    // that time isn't a real detection delay. Only adjust when fired_at is AT/AFTER
    // formation (a genuine live fire) — early-touch BACKFILL rows intentionally set
    // fired_at to the original pre-formation touch by design (that's what
    // "early-touch backfill" means), and forcing those through this adjustment would
    // produce a nonsensical negative lag. Leave those alone; they're already
    // correctly caught by the RETROACTIVE threshold below.
    if (r.formation_ready_ts != null && r.first_bar_ts != null && lag != null
        && new Date(r.first_bar_ts) < new Date(r.formation_ready_ts)
        && new Date(r.fired_at) >= new Date(r.formation_ready_ts)) {
      lag = Math.round((new Date(r.fired_at) - new Date(r.formation_ready_ts)) / 1000);
      formationAdjusted = true;
    }

    let cls;
    if (r.session === 'PREMARKET') {
      // Pre-market setups: don't classify against RTH latency standards.
      // Higher lag is expected — globex detection cadence is slower.
      cls = lag != null && lag >= 0 ? 'OK' : 'NO_BAR';
    } else if (r.first_bar_ts == null) cls = 'NO_BAR';
    else if (lag == null)          cls = 'NO_BAR';
    else if (lag < 0)              cls = 'NEGATIVE';    // fired before first touch (bug)
    else if (lag > RETRO_THRESH_S) cls = 'RETROACTIVE'; // early-touch backfill
    else if (lag > CRIT_THRESH_S)  cls = 'CRITICAL';
    else if (lag > SLOW_THRESH_S)  cls = 'SLOW';
    else                           cls = 'OK';
    if (formationAdjusted) cls += '*'; // flag: lag measured from formation-ready time, not raw touch
    return { ...r, lag, cls };
  });

  // Print per-setup table
  const colW = 32;
  console.log('setup_type'.padEnd(colW) + 'session'.padEnd(11) + 'status'.padEnd(12) + 'first_bar'.padEnd(12) + 'lag_s'.padEnd(8) + 'class');
  console.log('-'.repeat(colW + 11 + 12 + 12 + 8 + 10));
  for (const r of classified) {
    // ts is naive ET stored in PG; node-postgres returns it as a Date treating it as UTC.
    // Use getUTC* to read back the "stored" ET time without timezone double-conversion.
    const barDt = r.first_bar_ts instanceof Date ? r.first_bar_ts : r.first_bar_ts ? new Date(r.first_bar_ts) : null;
    const bar = barDt ? `${String(barDt.getUTCHours()).padStart(2,'0')}:${String(barDt.getUTCMinutes()).padStart(2,'0')}` : '--:--';
    const lag = r.lag != null ? r.lag : '--';
    console.log(
      r.setup_type.padEnd(colW) +
      (r.session || '').padEnd(11) +
      (r.status || '').padEnd(12) +
      bar.padEnd(12) +
      String(lag).padEnd(8) +
      r.cls
    );
  }
  const rthSetups = classified.filter(r => r.session === 'RTH');
  const preMarket = classified.filter(r => r.session === 'PREMARKET');
  if (preMarket.length) {
    console.log(`\n(Pre-market setups: ${preMarket.length} — globex detection cadence is slower, not included in RTH stats.)`);
  }
  const ibOrCritical = classified.filter(r => r.cls === 'CRITICAL' && /^(IB_|OR_)/.test(r.setup_type));
  if (ibOrCritical.length) {
    console.log(`\nNote: ${ibOrCritical.map(r => r.setup_type).join(', ')} — IB/OR levels emerge during the IB period; lag`);
    console.log(`  may reflect level formation time (not detection failure) if first_bar was before IB established.`);
  }

  // Aggregate stats: RTH setups only for lag distribution (pre-market lags are expected higher)
  const measurable = classified.filter(r => r.session === 'RTH' && r.cls !== 'NO_BAR' && r.cls !== 'RETROACTIVE');
  const lags = measurable.map(r => r.lag).filter(l => l != null && l >= 0);

  const stats = {
    n_total:       rows.length,
    n_measurable:  measurable.length,
    n_ok:          classified.filter(r => r.cls === 'OK').length,
    n_slow:        classified.filter(r => r.cls === 'SLOW').length,
    n_critical:    classified.filter(r => r.cls === 'CRITICAL').length,
    n_retroactive: classified.filter(r => r.cls === 'RETROACTIVE').length,
    n_no_bar:      classified.filter(r => r.cls === 'NO_BAR').length,
    n_negative:    classified.filter(r => r.cls === 'NEGATIVE').length,
    median_lag_s:  Math.round(percentile(lags, 50) ?? 0),
    p90_lag_s:     Math.round(percentile(lags, 90) ?? 0),
    max_lag_s:     lags.length ? Math.max(...lags) : 0,
    critical_setups: classified.filter(r => r.cls === 'CRITICAL' || r.cls === 'NEGATIVE')
      .map(r => ({ setup_type: r.setup_type, lag_s: r.lag, cls: r.cls, resolution: r.resolution })),
  };

  console.log('\n--- Summary ---');
  console.log(`OK: ${stats.n_ok}  SLOW: ${stats.n_slow}  CRITICAL: ${stats.n_critical}  RETROACTIVE: ${stats.n_retroactive}  NO_BAR: ${stats.n_no_bar}  NEGATIVE: ${stats.n_negative}`);
  if (lags.length) {
    console.log(`Median lag: ${stats.median_lag_s}s  P90: ${stats.p90_lag_s}s  Max: ${stats.max_lag_s}s`);
  }

  // Write to performance_audit (one row per date, upsert)
  const today = new Date().toISOString().slice(0, 10);
  await query(`
    INSERT INTO performance_audit
      (run_date, window_days, signal_type, signal_name, sample_size, win_rate, ev_per_trade, recommendation, notes)
    VALUES ($1, 1, 'LATENCY_AUDIT', $2, $3, NULL, NULL, $4, $5)
    ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE SET
      sample_size    = EXCLUDED.sample_size,
      recommendation = EXCLUDED.recommendation,
      notes          = EXCLUDED.notes,
      created_at     = now()
  `, [
    today,
    targetDate,   // signal_name = the date audited
    stats.n_total,
    stats.n_critical > 0 ? 'CRITICAL' : stats.n_slow > 0 ? 'SLOW' : 'OK',
    JSON.stringify({
      median_lag_s:  stats.median_lag_s,
      p90_lag_s:     stats.p90_lag_s,
      max_lag_s:     stats.max_lag_s,
      n_ok:          stats.n_ok,
      n_slow:        stats.n_slow,
      n_critical:    stats.n_critical,
      n_retroactive: stats.n_retroactive,
      n_no_bar:      stats.n_no_bar,
      n_negative:    stats.n_negative,
      critical_setups: stats.critical_setups,
    }),
  ]);
  console.log(`\nWrote LATENCY_AUDIT row to performance_audit (${targetDate}).`);

  // Alert if critical issues found
  const hasCritical = stats.n_critical > 0 || stats.n_negative > 0;
  if (hasCritical) {
    const ts = nowET();
    const setupList = stats.critical_setups.map(s => `${s.setup_type}(${s.lag_s}s,${s.cls})`).join(', ');
    const alertLine = `[${ts} ET] [LATENCY_CRITICAL] ${targetDate}: ${stats.n_critical} critical + ${stats.n_negative} negative lag setups — ${setupList || 'see performance_audit'}\n`;
    fs.appendFileSync(ALERTS_FILE, alertLine);
    console.log('\n⚠ ALERT written to scratch/gemini_alerts.txt');
    console.log(alertLine.trim());
  }

  // Also alert on high SLOW rate (>50% of measurable setups)
  const slowRate = stats.n_measurable > 0 ? stats.n_slow / stats.n_measurable : 0;
  if (slowRate > 0.5 && stats.n_measurable >= 3) {
    const ts = nowET();
    const alertLine = `[${ts} ET] [LATENCY_SLOW] ${targetDate}: ${Math.round(slowRate * 100)}% of setups had lag 5-10min (${stats.n_slow}/${stats.n_measurable}) — median ${stats.median_lag_s}s, p90 ${stats.p90_lag_s}s\n`;
    fs.appendFileSync(ALERTS_FILE, alertLine);
    console.log('\n⚠ SLOW-RATE ALERT written to scratch/gemini_alerts.txt');
    console.log(alertLine.trim());
  }

  return stats;
}

// Main
const arg = process.argv[2];
const targetDate = arg
  ? arg
  : new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

run(targetDate).catch(e => { console.error(e); process.exit(1); });
