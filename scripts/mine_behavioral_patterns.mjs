/**
 * mine_behavioral_patterns.mjs
 *
 * Multi-dimensional intraday behavioral pattern miner.
 * Conditions on DOW × day_type × a_signal × overnight_inv × open_vs_value × morning_dir × time_window.
 * Emits ALL combinations with N≥20 and directional/continuation rate ≥70%.
 *
 * Runs weekly (added to run_session_bias.sh).
 * Writes signal_type='BEHAVIORAL_PATTERN' to performance_audit.
 *
 * Lookahead gates:
 *   9:30–10am   window: overnight_inv, open_vs_value, dow only (premarket data)
 *   10:00–10:30 window: + morning_dir (available by 10am)
 *   10:30–11am  window: + day_type (IB close finalizes at 10:30)
 *   11am+       window: + a_signal (fired by 11am on most days)
 */

import pg from 'pg';
const { Client } = pg;

const client = new Client({
  host: 'localhost', port: 5432, database: 'trading_journal',
  user: 'trader', password: 'trader123',
});

async function main() {
  await client.connect();

  const dbRes = await client.query(`
    WITH bar_dates AS (
      SELECT DISTINCT ts::date as trade_date
      FROM price_bars_primary
      WHERE symbol = 'NQ' AND ts >= '2022-12-14'
    ),
    rth_first_bars AS (
      SELECT DISTINCT ON (ts::date)
        ts::date as trade_date,
        open as open_930
      FROM price_bars_primary
      WHERE symbol = 'NQ' AND ts >= '2022-12-14'
        AND ts::time >= '09:30:00' AND ts::time <= '09:35:00'
      ORDER BY ts::date, ts ASC
    ),
    rth_1000_bars AS (
      SELECT DISTINCT ON (ts::date)
        ts::date as trade_date,
        open as open_1000
      FROM price_bars_primary
      WHERE symbol = 'NQ' AND ts >= '2022-12-14'
        AND ts::time >= '10:00:00' AND ts::time <= '10:05:00'
      ORDER BY ts::date, ts ASC
    ),
    daily_contexts AS (
      SELECT
        bd.trade_date,
        EXTRACT(DOW FROM bd.trade_date) as dow,
        acd.day_type,
        CASE
          WHEN acd.trade_date IS NULL THEN NULL
          WHEN acd.a_up_fired   THEN 'UP'
          WHEN acd.a_down_fired THEN 'DOWN'
          ELSE 'NONE'
        END as a_signal,
        ar.overnight_inventory as overnight_inv,
        ar.open_vs_prior_value as open_vs_value,
        f.open_930,
        t.open_1000,
        CASE
          WHEN t.open_1000 - f.open_930 > 3.0 THEN 'UP'
          WHEN t.open_1000 - f.open_930 < -3.0 THEN 'DOWN'
          ELSE 'NEUTRAL'
        END as morning_dir
      FROM bar_dates bd
      LEFT JOIN acd_daily_log acd ON acd.trade_date = bd.trade_date
      LEFT JOIN auction_reads  ar  ON ar.trade_date  = bd.trade_date
      LEFT JOIN rth_first_bars f   ON f.trade_date   = bd.trade_date
      LEFT JOIN rth_1000_bars  t   ON t.trade_date   = bd.trade_date
    ),
    bars_with_minutes AS (
      SELECT
        ts::date as trade_date,
        open, close,
        EXTRACT(HOUR FROM ts) * 60 + EXTRACT(MINUTE FROM ts) as et_min
      FROM price_bars_primary
      WHERE symbol = 'NQ' AND ts >= '2022-12-14'
    ),
    windows_def(start_min, end_min) AS (
      VALUES (570,600),(600,630),(630,660),(660,720),(720,780),(780,840),(840,900),(900,960)
    ),
    window_bars AS (
      SELECT
        bm.trade_date, w.start_min, w.end_min,
        bm.open, bm.close,
        ROW_NUMBER() OVER (PARTITION BY bm.trade_date, w.start_min ORDER BY bm.et_min ASC)  as rn_asc,
        ROW_NUMBER() OVER (PARTITION BY bm.trade_date, w.start_min ORDER BY bm.et_min DESC) as rn_desc
      FROM bars_with_minutes bm
      JOIN windows_def w ON bm.et_min >= w.start_min AND bm.et_min < w.end_min
    ),
    window_extremes AS (
      SELECT
        trade_date, start_min, end_min,
        MAX(CASE WHEN rn_asc = 1  THEN open  END) as win_open,
        MAX(CASE WHEN rn_desc = 1 THEN close END) as win_close
      FROM window_bars
      WHERE rn_asc = 1 OR rn_desc = 1
      GROUP BY trade_date, start_min, end_min
    )
    SELECT
      dc.trade_date::text, dc.dow::integer, dc.day_type, dc.a_signal,
      dc.overnight_inv, dc.open_vs_value, dc.morning_dir,
      we.start_min::integer, we.end_min::integer,
      we.win_open::double precision, we.win_close::double precision
    FROM daily_contexts dc
    JOIN window_extremes we ON dc.trade_date = we.trade_date
    ORDER BY dc.trade_date, we.start_min
  `);

  const rows = dbRes.rows;
  console.log(`Loaded ${rows.length} bar-window observations`);

  // Compute win_dir, is_continuation, is_reversal per row
  for (const r of rows) {
    const diff = r.win_close - r.win_open;
    r.win_dir = diff > 3 ? 'UP' : diff < -3 ? 'DOWN' : 'FLAT';
    const m = r.morning_dir;
    r.is_continuation = m !== 'NEUTRAL' && r.win_dir !== 'FLAT' && m === r.win_dir;
    r.is_reversal     = m !== 'NEUTRAL' && r.win_dir !== 'FLAT' && m !== r.win_dir;
  }

  // Allowed condition dimensions per window (lookahead gates)
  const WINDOWS = [
    { start: 570, end: 600, label: '9:30–10:00am',  name: 'OPEN_DRIVE',  dims: ['dow', 'overnight_inv', 'open_vs_value'] },
    { start: 600, end: 630, label: '10:00–10:30am', name: 'POST_OR',      dims: ['dow', 'overnight_inv', 'open_vs_value', 'morning_dir'] },
    { start: 630, end: 660, label: '10:30–11:00am', name: 'IB_CLOSE',     dims: ['dow', 'overnight_inv', 'open_vs_value', 'morning_dir', 'day_type'] },
    { start: 660, end: 720, label: '11:00am–12:00pm',name: 'LATE_MORN',  dims: ['dow', 'overnight_inv', 'open_vs_value', 'morning_dir', 'day_type', 'a_signal'] },
    { start: 720, end: 780, label: '12:00–1:00pm',  name: 'NOON',         dims: ['dow', 'overnight_inv', 'open_vs_value', 'morning_dir', 'day_type', 'a_signal'] },
    { start: 780, end: 840, label: '1:00–2:00pm',   name: 'EARLY_AFT',   dims: ['dow', 'overnight_inv', 'open_vs_value', 'morning_dir', 'day_type', 'a_signal'] },
    { start: 840, end: 900, label: '2:00–3:00pm',   name: 'PRE_CLOSE',    dims: ['dow', 'overnight_inv', 'open_vs_value', 'morning_dir', 'day_type', 'a_signal'] },
    { start: 900, end: 960, label: '3:00–4:00pm',   name: 'LAST_HOUR',    dims: ['dow', 'overnight_inv', 'open_vs_value', 'morning_dir', 'day_type', 'a_signal'] },
  ];

  const allResults = [];

  for (const win of WINDOWS) {
    const { start, end, name: winName, label: winLabel, dims } = win;
    const winRows = rows.filter(r =>
      r.start_min === start && r.dow >= 1 && r.dow <= 5 &&
      r.win_open != null && r.win_close != null
    );
    if (!winRows.length) continue;

    const process = (combo, valObj) => {
      const subset = winRows.filter(r => combo.every(d => r[d] === valObj[d]));
      if (subset.length === 0) return;

      const N = subset.length;
      const upCt   = subset.filter(r => r.win_dir === 'UP').length;
      const downCt = subset.filter(r => r.win_dir === 'DOWN').length;

      if (N >= 30) {
        allResults.push({ start, end, winName, winLabel, conds: valObj, rec: 'LONG',  pct: upCt / N,   N, metric: 'pct_up' });
        allResults.push({ start, end, winName, winLabel, conds: valObj, rec: 'SHORT', pct: downCt / N, N, metric: 'pct_down' });
      }

      if (start >= 600) {
        const morn = subset.filter(r => r.morning_dir !== 'NEUTRAL');
        const Nm = morn.length;
        if (Nm >= 30) {
          const contCt = morn.filter(r => r.is_continuation).length;
          const revCt  = morn.filter(r => r.is_reversal).length;
          allResults.push({ start, end, winName, winLabel, conds: valObj, rec: 'WITH_TREND', pct: contCt / Nm, N: Nm, metric: 'pct_continuation' });
          allResults.push({ start, end, winName, winLabel, conds: valObj, rec: 'REVERSE',    pct: revCt  / Nm, N: Nm, metric: 'pct_reversal' });
        }
      }
    };

    // 1D combos
    for (const combo of getCombinations(dims, 1)) {
      for (const valObj of uniqueValCombos(winRows, combo)) {
        process(combo, valObj);
      }
    }

    // 2D combos only — 3D would collapse N too far
    for (const combo of getCombinations(dims, 2)) {
      for (const valObj of uniqueValCombos(winRows, combo)) {
        process(combo, valObj);
      }
    }
  }

  const qualifying = allResults.filter(r => r.pct >= 0.65); // 65%+ all get stored; win_rate encodes tier
  const borderline = allResults.filter(r => r.pct >= 0.60 && r.pct < 0.65);
  console.log(`Found ${qualifying.length} qualifying (≥65%) and ${borderline.length} near-miss (60-64%) patterns`);

  // Write to performance_audit
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  await client.query('BEGIN');
  try {
    await client.query("DELETE FROM performance_audit WHERE signal_type='BEHAVIORAL_PATTERN'");

    for (const p of qualifying) {
      const sigName = buildName(p);
      const notes = JSON.stringify({
        label:  humanLabel(p),
        action: actionStr(p.rec),
        metric: p.metric,
        pct_252d: Math.round(p.pct * 100),
        n_252d: p.N,
        requires: {
          time_window_start: p.start,
          time_window_end:   p.end,
          time_window_label: p.winLabel,
          ...p.conds,
        },
      });

      await client.query(`
        INSERT INTO performance_audit
          (run_date, window_days, signal_type, signal_name, sample_size, win_rate, ev_per_trade, recommendation, notes)
        VALUES ($1, 0, 'BEHAVIORAL_PATTERN', $2, $3, $4, 0, $5, $6)
      `, [today, sigName, p.N, p.pct, p.rec, notes]);
    }

    await client.query('COMMIT');
    console.log(`Wrote ${qualifying.length} BEHAVIORAL_PATTERN rows for ${today}`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }

  await client.end();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getCombinations(arr, k) {
  const res = [];
  const helper = (start, combo) => {
    if (combo.length === k) { res.push([...combo]); return; }
    for (let i = start; i < arr.length; i++) { combo.push(arr[i]); helper(i + 1, combo); combo.pop(); }
  };
  helper(0, []);
  return res;
}

function uniqueValCombos(rows, dims) {
  const seen = new Set(); const combos = [];
  for (const r of rows) {
    const vals = dims.map(d => r[d]);
    if (vals.some(v => v == null)) continue;
    const key = vals.join('|');
    if (!seen.has(key)) {
      seen.add(key);
      const obj = {}; dims.forEach((d, i) => { obj[d] = vals[i]; });
      combos.push(obj);
    }
  }
  return combos;
}

const DOW_NAMES  = { 1: 'MON', 2: 'TUE', 3: 'WED', 4: 'THU', 5: 'FRI' };
const DOW_FULL   = { 1: 'Monday', 2: 'Tuesday', 3: 'Wednesday', 4: 'Thursday', 5: 'Friday' };
const OVN_SHORT  = { LONG_TRAPPED: 'OVN_LONG', SHORT_TRAPPED: 'OVN_SHORT', NEUTRAL: 'OVN_NEUT' };
const VAL_SHORT  = { ABOVE_VALUE: 'VAL_ABOVE', INSIDE_VALUE: 'VAL_INSIDE', BELOW_VALUE: 'VAL_BELOW' };
const MORN_SHORT = { UP: 'MORN_UP', DOWN: 'MORN_DN', NEUTRAL: 'MORN_NEUT' };
const ASIG_SHORT = { UP: 'A_UP', DOWN: 'A_DN', NONE: 'A_NONE' };
const REC_SHORT  = { WITH_TREND: 'CONTINUE', REVERSE: 'REVERSE', LONG: 'LONG', SHORT: 'SHORT' };

function buildName(p) {
  const parts = [p.winName];
  const c = p.conds;
  if (c.dow != null)         parts.push(DOW_NAMES[c.dow]  || `DOW${c.dow}`);
  if (c.day_type)            parts.push(c.day_type);
  if (c.a_signal)            parts.push(ASIG_SHORT[c.a_signal] || c.a_signal);
  if (c.overnight_inv)       parts.push(OVN_SHORT[c.overnight_inv] || c.overnight_inv);
  if (c.open_vs_value)       parts.push(VAL_SHORT[c.open_vs_value] || c.open_vs_value);
  if (c.morning_dir)         parts.push(MORN_SHORT[c.morning_dir] || c.morning_dir);
  parts.push(REC_SHORT[p.rec] || p.rec);
  return parts.join('_').toUpperCase().replace(/__+/g, '_');
}

function humanLabel(p) {
  const c = p.conds;
  const condParts = [];
  if (c.dow != null)         condParts.push(DOW_FULL[c.dow]);
  if (c.day_type)            condParts.push(c.day_type);
  if (c.a_signal)            condParts.push(`A ${c.a_signal}`);
  if (c.overnight_inv)       condParts.push(`overnight ${c.overnight_inv.replace('_TRAPPED','').toLowerCase()}`);
  if (c.open_vs_value)       condParts.push(`open ${c.open_vs_value.replace('_VALUE','').toLowerCase()}`);
  if (c.morning_dir)         condParts.push(`morning ${c.morning_dir.toLowerCase()}`);
  const pctStr = `${Math.round(p.pct * 100)}%`;
  const cStr = condParts.join(' ');
  if (p.rec === 'LONG')       return `${p.winLabel} ${cStr}: closes UP ${pctStr}`;
  if (p.rec === 'SHORT')      return `${p.winLabel} ${cStr}: closes DOWN ${pctStr}`;
  if (p.rec === 'WITH_TREND') return `${p.winLabel} ${cStr}: continues ${pctStr}`;
  if (p.rec === 'REVERSE')    return `${p.winLabel} ${cStr}: reverses ${pctStr}`;
  return `${p.winLabel} ${cStr}: ${pctStr}`;
}

function actionStr(rec) {
  if (rec === 'LONG')       return 'Favor long entries in this window.';
  if (rec === 'SHORT')      return 'Favor short entries in this window.';
  if (rec === 'WITH_TREND') return 'Trade in the direction of the morning move.';
  if (rec === 'REVERSE')    return 'Fade the morning move — mean reversion window.';
  return '';
}

main().catch(err => { console.error(err); process.exit(1); });
