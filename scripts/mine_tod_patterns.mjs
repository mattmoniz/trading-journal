/**
 * mine_tod_patterns.mjs
 *
 * Mines time-of-day price behavior patterns from price_bars_primary.
 * For each (time_window × day_type) bucket with N≥20:
 *   - computes directional rate (% of days price closes window above window_open)
 *   - computes reversal rate (% of days window direction OPPOSES morning direction)
 *   - writes signal_type='TOD_PATTERN' rows to performance_audit where edge ≥10% from 50%
 *
 * Time windows (ET minutes):
 *   570-600  = 9:30–10:00 AM  (opening drive)
 *   600-660  = 10:00–11:00 AM (post-IB formation)
 *   660-720  = 11:00–12:00 PM (late morning)
 *   720-780  = 12:00–1:00 PM  (noon/lunch reversal window)
 *   780-840  = 1:00–2:00 PM   (early afternoon)
 *   840-900  = 2:00–3:00 PM   (pre-close positioning)
 *   900-960  = 3:00–4:00 PM   (last hour / power hour)
 *
 * Runs weekly Sunday 9:20 AM via run_session_bias.sh
 */

import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  host: 'localhost', port: 5432, database: 'trading_journal',
  user: 'trader', password: 'trader123',
});

const query = (sql, params) => pool.query(sql, params);

const WINDOWS = [
  { start: 600, end: 660,  label: '10–11am',     name: 'POST_IB_WINDOW' },
  { start: 660, end: 720,  label: '11am–12pm',   name: 'LATE_MORNING_WINDOW' },
  { start: 720, end: 780,  label: '12–1pm',      name: 'NOON_WINDOW' },
  { start: 780, end: 840,  label: '1–2pm',       name: 'EARLY_AFT_WINDOW' },
  { start: 840, end: 900,  label: '2–3pm',       name: 'PRE_CLOSE_WINDOW' },
  { start: 900, end: 960,  label: '3–4pm',       name: 'LAST_HOUR_WINDOW' },
];

const DAY_TYPES = ['BALANCE', 'TREND', 'TURBULENT', null]; // null = all days

// Fetch all RTH bar data joined with day_type
const barsQ = await query(`
  WITH rth AS (
    SELECT
      TO_CHAR(ts AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') AS trade_date,
      EXTRACT(HOUR FROM ts AT TIME ZONE 'America/New_York') * 60
        + EXTRACT(MINUTE FROM ts AT TIME ZONE 'America/New_York') AS et_min,
      open::float  AS bar_open,
      close::float AS bar_close
    FROM price_bars_primary
    WHERE symbol = 'NQ'
      AND EXTRACT(HOUR FROM ts AT TIME ZONE 'America/New_York') * 60
        + EXTRACT(MINUTE FROM ts AT TIME ZONE 'America/New_York') BETWEEN 570 AND 959
  )
  SELECT r.trade_date, r.et_min, r.bar_open, r.bar_close,
    dl.day_type
  FROM rth r
  JOIN acd_daily_log dl ON dl.trade_date::text = r.trade_date
  WHERE dl.day_type IS NOT NULL
    AND r.trade_date >= '2024-01-01'
  ORDER BY r.trade_date, r.et_min
`, []);

console.log(`Loaded ${barsQ.rows.length} bars across ${new Set(barsQ.rows.map(r => r.trade_date)).size} days`);

// Group bars by trade_date
const byDate = {};
for (const row of barsQ.rows) {
  const d = row.trade_date instanceof Date ? row.trade_date.toISOString().slice(0, 10) : String(row.trade_date);
  if (!byDate[d]) byDate[d] = { day_type: row.day_type, bars: [] };
  byDate[d].bars.push({ et_min: Number(row.et_min), open: row.bar_open, close: row.bar_close });
}

// For each day: compute session open (first bar at 9:30) and per-window stats
const dayStats = [];
for (const [date, { day_type, bars }] of Object.entries(byDate)) {
  const sessionOpenBar = bars.find(b => b.et_min === 570);
  if (!sessionOpenBar) continue;
  const sessionOpen = sessionOpenBar.open;

  for (const win of WINDOWS) {
    const winBars = bars.filter(b => b.et_min >= win.start && b.et_min < win.end);
    if (winBars.length < 3) continue; // need at least 3 bars in window
    const winOpen  = winBars[0].open;
    const winClose = winBars[winBars.length - 1].close;
    const winDir   = winClose > winOpen + 2 ? 'UP' : winClose < winOpen - 2 ? 'DOWN' : 'FLAT';
    const mornDir  = winOpen > sessionOpen + 2 ? 'UP' : winOpen < sessionOpen - 2 ? 'DOWN' : 'FLAT';
    const isReversal = mornDir !== 'FLAT' && winDir !== 'FLAT' && mornDir !== winDir;
    const isContinuation = mornDir !== 'FLAT' && winDir !== 'FLAT' && mornDir === winDir;

    dayStats.push({
      date, day_type, window: win.name, win_start: win.start, win_end: win.end, win_label: win.label,
      win_dir: winDir, morn_dir: mornDir, is_reversal: isReversal, is_continuation: isContinuation,
      win_move: winClose - winOpen,
    });
  }
}

console.log(`Computed ${dayStats.length} window observations`);

// Mine patterns: for each (window × day_type) bucket
const patterns = [];
for (const win of WINDOWS) {
  for (const dt of DAY_TYPES) {
    const rows = dayStats.filter(r =>
      r.window === win.name && (dt === null || r.day_type === dt)
    );
    if (rows.length < 20) continue;

    const dtLabel = dt || 'ALL';
    const n = rows.length;

    // Directional bias: % closing window above open
    const upCount  = rows.filter(r => r.win_dir === 'UP').length;
    const downCount= rows.filter(r => r.win_dir === 'DOWN').length;
    const upPct    = Math.round(100 * upCount / n);
    const downPct  = Math.round(100 * downCount / n);

    // Reversal rate (only for windows after 10am where morning direction is established)
    const withDir  = rows.filter(r => r.morn_dir !== 'FLAT');
    const revPct   = withDir.length >= 20
      ? Math.round(100 * withDir.filter(r => r.is_reversal).length / withDir.length)
      : null;
    const contPct  = withDir.length >= 20
      ? Math.round(100 * withDir.filter(r => r.is_continuation).length / withDir.length)
      : null;

    // Only record directional if rate in that direction ≥60%; reversal/continuation ≥60%
    const signals = [];

    if (upPct >= 60) {
      signals.push({
        name: `${win.name}_${dtLabel}_DIRECTIONAL`,
        metric: 'pct_up',
        pct: upPct, n,
        label: `${win.label}${dt ? ' · ' + dt : ''}: closes UP ${upPct}% of days`,
        action: `Favor LONG entries in this window`,
        recommendation: 'LONG',
      });
    } else if (downPct >= 60) {
      signals.push({
        name: `${win.name}_${dtLabel}_DIRECTIONAL`,
        metric: 'pct_down',
        pct: downPct, n,
        label: `${win.label}${dt ? ' · ' + dt : ''}: closes DOWN ${downPct}% of days`,
        action: `Fade rallies — bearish pressure in this window`,
        recommendation: 'SHORT',
      });
    }

    if (win.start >= 660 && revPct != null && revPct >= 60) {
      signals.push({
        name: `${win.name}_${dtLabel}_REVERSAL`,
        metric: 'pct_reversal',
        pct: revPct, n: withDir.length,
        label: `${win.label}${dt ? ' · ' + dt : ''}: reverses morning ${revPct}% of days`,
        action: `Fade the morning trend — mean reversion window`,
        recommendation: 'REVERSE',
      });
    }

    if (win.start >= 660 && contPct != null && contPct >= 60) {
      signals.push({
        name: `${win.name}_${dtLabel}_CONTINUATION`,
        metric: 'pct_continuation',
        pct: contPct, n: withDir.length,
        label: `${win.label}${dt ? ' · ' + dt : ''}: continues morning move ${contPct}% of days`,
        action: `Ride the trend — continuation window`,
        recommendation: 'WITH_TREND',
      });
    }

    for (const sig of signals) {
      patterns.push({ win, dt: dtLabel, ...sig });
    }
  }
}

console.log(`Found ${patterns.length} TOD patterns with N≥20 and edge ≥10%`);
if (patterns.length === 0) {
  console.log('No qualifying patterns found — nothing to write');
  await pool.end();
  process.exit(0);
}

// Write to performance_audit — delete old rows first, then insert fresh
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

await query(`DELETE FROM performance_audit WHERE signal_type = 'TOD_PATTERN'`);
console.log('Deleted old TOD_PATTERN rows');

for (const p of patterns) {
  const notes = {
    label: p.label,
    action: p.action,
    metric: p.metric,
    pct_252d: p.pct,
    n_252d: p.n,
    requires: {
      ...(p.dt !== 'ALL' ? { day_type: p.dt } : {}),
      time_window_start: p.win.start,
      time_window_end: p.win.end,
      time_window_label: p.win.label,
    },
  };

  await query(`
    INSERT INTO performance_audit
      (run_date, window_days, signal_type, signal_name, sample_size, win_rate, ev_per_trade, recommendation, notes)
    VALUES ($1, 0, 'TOD_PATTERN', $2, $3, $4, 0, $5, $6)
  `, [today, p.name, p.n, p.pct / 100, p.recommendation, JSON.stringify(notes)]);

  console.log(`  ${p.recommendation.padEnd(12)} ${p.name.padEnd(45)} ${p.pct}% N=${p.n}`);
}

console.log(`\nWrote ${patterns.length} TOD_PATTERN rows for ${today}`);
await pool.end();
