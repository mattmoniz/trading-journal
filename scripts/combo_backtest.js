/**
 * combo_backtest.js — Level Confluence Combo Stats
 *
 * For each session in acd_daily_log, computes all key price levels from DB,
 * checks which level combos had all levels within PROX_THRESHOLD proximity,
 * and records the NQ session directional move (open→close × $20/pt) as outcome.
 *
 * Using NQ price-based outcome instead of account P&L keeps stats independent
 * of which accounts were active and normalizes across sim/live periods.
 *
 * Single-level combos (PM_VAL) use price-touch detection instead of proximity.
 *
 * Outputs to combo_stats table. Run weekly: node scripts/combo_backtest.js
 * Usage: node scripts/combo_backtest.js [--prox=20] [--dry-run]
 */

import { query } from '../server/db.js';
import pool from '../server/db.js';

const PROX_THRESHOLD = (() => {
  const arg = process.argv.find(a => a.startsWith('--prox='));
  return arg ? parseFloat(arg.split('=')[1]) : 20;
})();
const DRY_RUN = process.argv.includes('--dry-run');

// ── Combo definitions ────────────────────────────────────────────────────────
// Each combo defines a set of level keys. A session "hits" the combo when ALL
// levels in the combo are within PROX_THRESHOLD points of each other.
// Level keys must match the computed levels object below.
const COMBOS = [
  { id: 'or_mid_hi_wvwap',  label: 'OR Mid + OR High + W-VWAP',   cat: 'or',  levels: ['OR5Mid','OR_Hi','W_VWAP'],   tier: 1 },
  { id: 'or_mid_hi_pwhi',   label: 'OR Mid + OR High + PW High',   cat: 'or',  levels: ['OR5Mid','OR_Hi','PW_Hi'],    tier: 1 },
  { id: 'or_hi_pwhi',       label: 'OR High + PW High',             cat: 'or',  levels: ['OR_Hi','PW_Hi'],             tier: 1 },
  { id: 'or_lo_pwlo',       label: 'OR Low + PW Low',               cat: 'or',  levels: ['OR_Lo','PW_Lo'],             tier: 1 },
  { id: 'or_mid_lo_pwlo',   label: 'OR Mid + OR Low + PW Low',      cat: 'or',  levels: ['OR5Mid','OR_Lo','PW_Lo'],    tier: 1 },
  { id: 'on_lo_pd_lo',      label: 'ON Low + PD Low',               cat: 'on',  levels: ['ON_Lo','PD_Lo'],             tier: 1 },
  { id: 'on_lo_pdpoc_vwap', label: 'ON Low + PD POC + VWAP',       cat: 'on',  levels: ['ON_Lo','PD_POC','VWAP'],     tier: 1 },
  { id: 'a_dn_wvwap',       label: 'A Down + W-VWAP',               cat: 'acd', levels: ['A_Dn','W_VWAP'],             tier: 2 },
  { id: 'a_dn_vwap_wvwap',  label: 'A Down + VWAP + W-VWAP',       cat: 'acd', levels: ['A_Dn','VWAP','W_VWAP'],      tier: 2 },
  { id: 'pd_val_wvwap',     label: 'PD VAL + W-VWAP',               cat: 'pd',  levels: ['PD_VAL','W_VWAP'],           tier: 2 },
  { id: 'pd_lo_pd_val',     label: 'PD Low + PD VAL',               cat: 'pd',  levels: ['PD_Lo','PD_VAL'],            tier: 2 },
  { id: 'pm_val_solo',      label: 'PM VAL (solo)',                  cat: 'pd',  levels: ['PM_VAL'],                    tier: 2 },
];

// ── DB setup ─────────────────────────────────────────────────────────────────
async function ensureTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS combo_stats (
      combo_id    TEXT PRIMARY KEY,
      label       TEXT NOT NULL,
      category    TEXT,
      tier        INT,
      levels      TEXT[],
      n           INT,
      win_count   INT,
      avg_pnl     NUMERIC(10,2),
      win_rate    NUMERIC(5,2),
      prox_pts    NUMERIC(6,2),
      session_range_start DATE,
      session_range_end   DATE,
      last_analyzed TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

// ── NQ session data (open, close, hi, lo per RTH session) ────────────────────
// Outcome = (close - open) × $20/pt — normalized, independent of account
async function getSessionData() {
  const r = await query(`
    SELECT ts::date::text as d,
      (array_agg(open ORDER BY ts ASC))[1]::float   as rth_open,
      (array_agg(close ORDER BY ts DESC))[1]::float  as rth_close,
      MAX(high)::float as rth_hi, MIN(low)::float as rth_lo
    FROM price_bars WHERE symbol='NQ'
      AND EXTRACT(HOUR FROM ts)*60 + EXTRACT(MINUTE FROM ts) >= 570
      AND EXTRACT(HOUR FROM ts)*60 + EXTRACT(MINUTE FROM ts) < 975
    GROUP BY ts::date
    ORDER BY ts::date
  `);
  const map = {};
  for (const row of r.rows) {
    const move = (parseFloat(row.rth_close) - parseFloat(row.rth_open)) * 20; // 1 full-size NQ contract
    map[row.d] = {
      pnl: Math.round(move * 100) / 100,
      hi:  parseFloat(row.rth_hi),
      lo:  parseFloat(row.rth_lo),
      open: parseFloat(row.rth_open),
      close: parseFloat(row.rth_close),
    };
  }
  return map;
}

// ── ACD levels ────────────────────────────────────────────────────────────────
async function getAcdLevels() {
  const r = await query(`
    SELECT trade_date::text as d, or_high, or_low, a_up_level, a_down_level
    FROM acd_daily_log ORDER BY trade_date
  `);
  const map = {};
  for (const row of r.rows) {
    const orHi = parseFloat(row.or_high);
    const orLo = parseFloat(row.or_low);
    map[row.d] = {
      OR_Hi:  orHi,
      OR_Lo:  orLo,
      OR5Mid: (orHi + orLo) / 2 + (orHi - orLo) * 0.15,
      A_Up:   parseFloat(row.a_up_level),
      A_Dn:   parseFloat(row.a_down_level),
    };
  }
  return map;
}

// ── Price bar range queries ───────────────────────────────────────────────────
// ts is stored in ET local time (Sierra Chart native)
// RTH = 09:30–16:15, Overnight = 16:00 prev to 09:30 current, PW = prior Mon–Fri RTH

async function getBulkBarLevels(dates) {
  // Fetch all needed bar data in a single query per level type, then join in JS
  const minDate = dates[0];
  const maxDate = dates[dates.length - 1];

  // RTH bars for each session (for VWAP and context)
  const rthQ = await query(`
    SELECT ts::date::text as d,
      SUM(close * volume::numeric) / NULLIF(SUM(volume::numeric), 0) as vwap
    FROM price_bars
    WHERE symbol='NQ'
      AND ts::date >= $1::date AND ts::date <= $2::date
      AND EXTRACT(HOUR FROM ts)*60 + EXTRACT(MINUTE FROM ts) >= 570
      AND EXTRACT(HOUR FROM ts)*60 + EXTRACT(MINUTE FROM ts) < 975
    GROUP BY ts::date
  `, [minDate, maxDate]);

  // ON (overnight) — bars from 16:00 prev day to 09:30 today
  const onQ = await query(`
    SELECT base_date::text as d, MAX(high) as on_hi, MIN(low) as on_lo
    FROM (
      SELECT (ts::date + INTERVAL '1 day')::date as base_date, high, low
      FROM price_bars WHERE symbol='NQ'
        AND ts::date >= $1::date - INTERVAL '1 day'
        AND ts::date <= $2::date
        AND EXTRACT(HOUR FROM ts)*60 + EXTRACT(MINUTE FROM ts) >= 960
      UNION ALL
      SELECT ts::date as base_date, high, low
      FROM price_bars WHERE symbol='NQ'
        AND ts::date >= $1::date AND ts::date <= $2::date
        AND EXTRACT(HOUR FROM ts)*60 + EXTRACT(MINUTE FROM ts) < 570
    ) x
    WHERE base_date >= $1::date AND base_date <= $2::date
    GROUP BY base_date
  `, [minDate, maxDate]);

  // PD Hi/Lo (prior trading day RTH) — join each session with the previous trading day
  const pdQ = await query(`
    WITH rth_days AS (
      SELECT ts::date as d, MAX(high) as hi, MIN(low) as lo,
        SUM(close * volume::numeric) / NULLIF(SUM(volume::numeric), 0) as vwap
      FROM price_bars WHERE symbol='NQ'
        AND EXTRACT(HOUR FROM ts)*60 + EXTRACT(MINUTE FROM ts) >= 570
        AND EXTRACT(HOUR FROM ts)*60 + EXTRACT(MINUTE FROM ts) < 975
        AND ts::date >= $1::date - INTERVAL '5 days'
        AND ts::date <= $2::date
      GROUP BY ts::date
    )
    SELECT r1.d::text, r2.hi as pd_hi, r2.lo as pd_lo, r2.vwap as pd_vwap
    FROM rth_days r1
    JOIN LATERAL (
      SELECT hi, lo, vwap FROM rth_days r2
      WHERE r2.d < r1.d ORDER BY r2.d DESC LIMIT 1
    ) r2 ON true
    WHERE r1.d >= $1::date AND r1.d <= $2::date
  `, [minDate, maxDate]);

  // PW Hi/Lo (prior full week Mon–Fri RTH)
  const pwQ = await query(`
    WITH week_bars AS (
      SELECT date_trunc('week', ts::date) as wk,
        MAX(high) as hi, MIN(low) as lo
      FROM price_bars WHERE symbol='NQ'
        AND EXTRACT(ISODOW FROM ts) BETWEEN 1 AND 5
        AND EXTRACT(HOUR FROM ts)*60 + EXTRACT(MINUTE FROM ts) >= 570
        AND EXTRACT(HOUR FROM ts)*60 + EXTRACT(MINUTE FROM ts) < 975
        AND ts::date >= $1::date - INTERVAL '14 days'
        AND ts::date <= $2::date
      GROUP BY date_trunc('week', ts::date)
    )
    SELECT ts::date::text as d, w.hi as pw_hi, w.lo as pw_lo
    FROM price_bars pb
    JOIN week_bars w ON w.wk = date_trunc('week', pb.ts::date) - INTERVAL '7 days'
    WHERE pb.symbol='NQ'
      AND pb.ts::date >= $1::date AND pb.ts::date <= $2::date
    GROUP BY ts::date, w.hi, w.lo
  `, [minDate, maxDate]);

  // W-VWAP (current week Mon–current day)
  const wvwapQ = await query(`
    SELECT ts::date::text as d,
      SUM(SUM(close * volume::numeric)) OVER (
        PARTITION BY date_trunc('week', ts::date)
        ORDER BY ts::date
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
      ) /
      NULLIF(SUM(SUM(volume::numeric)) OVER (
        PARTITION BY date_trunc('week', ts::date)
        ORDER BY ts::date
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
      ), 0) as w_vwap
    FROM price_bars
    WHERE symbol='NQ'
      AND EXTRACT(HOUR FROM ts)*60 + EXTRACT(MINUTE FROM ts) >= 570
      AND EXTRACT(HOUR FROM ts)*60 + EXTRACT(MINUTE FROM ts) < 975
      AND ts::date >= $1::date AND ts::date <= $2::date
    GROUP BY ts::date, date_trunc('week', ts::date)
    ORDER BY ts::date
  `, [minDate, maxDate]);

  // G-Line (weekly open: first bar of Sunday 18:00 ET)
  const glineQ = await query(`
    WITH week_opens AS (
      SELECT date_trunc('week', ts::date) + INTERVAL '7 days' as wk_start,
        (array_agg(open ORDER BY ts ASC))[1] as g_line
      FROM price_bars WHERE symbol='NQ'
        AND EXTRACT(ISODOW FROM ts) = 7
        AND EXTRACT(HOUR FROM ts) >= 18
        AND ts::date >= $1::date - INTERVAL '14 days'
        AND ts::date <= $2::date
      GROUP BY date_trunc('week', ts::date)
    )
    SELECT ts::date::text as d, g.g_line::float
    FROM price_bars pb
    JOIN week_opens g ON g.wk_start = date_trunc('week', pb.ts::date + INTERVAL '1 day')
    WHERE pb.symbol='NQ'
      AND pb.ts::date >= $1::date AND pb.ts::date <= $2::date
    GROUP BY ts::date, g.g_line
  `, [minDate, maxDate]);

  // Build lookup maps
  const vwap = {}, onLevels = {}, pdLevels = {}, pwLevels = {}, wvwap = {}, gline = {};
  for (const r of rthQ.rows)   vwap[r.d]     = parseFloat(r.vwap);
  for (const r of onQ.rows)    onLevels[r.d]  = { ON_Hi: parseFloat(r.on_hi), ON_Lo: parseFloat(r.on_lo) };
  for (const r of pdQ.rows)    pdLevels[r.d]  = { PD_Hi: parseFloat(r.pd_hi), PD_Lo: parseFloat(r.pd_lo) };
  for (const r of pwQ.rows)    pwLevels[r.d]  = { PW_Hi: parseFloat(r.pw_hi), PW_Lo: parseFloat(r.pw_lo) };
  for (const r of wvwapQ.rows) wvwap[r.d]     = parseFloat(r.w_vwap);
  for (const r of glineQ.rows) gline[r.d]     = parseFloat(r.g_line);

  return { vwap, onLevels, pdLevels, pwLevels, wvwap, gline };
}

// ── Volume profile (PD POC/VAH/VAL) ──────────────────────────────────────────
// Batch query all prior-day volume profiles in JS
async function getBulkPdProfiles(dates) {
  const minDate = dates[0];
  const maxDate = dates[dates.length - 1];
  const TICK = 0.25;

  // Get prior RTH bars for all sessions at once
  const r = await query(`
    WITH rth_session AS (
      SELECT ts::date as session_date,
        ROUND(((low + high) / 2 / $3)::numeric) * $3 as px_mid,
        volume::numeric as vol
      FROM price_bars WHERE symbol='NQ'
        AND EXTRACT(HOUR FROM ts)*60 + EXTRACT(MINUTE FROM ts) >= 570
        AND EXTRACT(HOUR FROM ts)*60 + EXTRACT(MINUTE FROM ts) < 975
        AND ts::date >= $1::date - INTERVAL '3 days'
        AND ts::date <= $2::date - INTERVAL '1 day'
    )
    SELECT session_date::text as sd, px_mid, SUM(vol) as vol
    FROM rth_session GROUP BY session_date, px_mid ORDER BY session_date, px_mid
  `, [minDate, maxDate, TICK]);

  // Group by session date
  const byDate = {};
  for (const row of r.rows) {
    const d = row.sd;
    if (!byDate[d]) byDate[d] = [];
    byDate[d].push({ px: parseFloat(row.px_mid), vol: parseFloat(row.vol) });
  }

  // Build a sorted list of trading dates to map each date to its prior date
  const sessionDates = [...new Set(r.rows.map(r => r.sd))].sort();

  // For each session in dates, find the prior trading date's profile
  const result = {};
  for (const d of dates) {
    const priorDate = sessionDates.filter(sd => sd < d).pop();
    if (!priorDate || !byDate[priorDate]) continue;

    const bars = byDate[priorDate];
    const levels = bars.map(b => b.px).sort((a,b) => a-b);
    const volMap = {};
    for (const b of bars) volMap[b.px] = b.vol;

    if (!levels.length) continue;
    const poc = levels.reduce((best, p) => volMap[p] > (volMap[best]||0) ? p : best, levels[0]);
    const pocIdx = levels.indexOf(poc);
    const totalVol = Object.values(volMap).reduce((s,v) => s+v, 0);
    const target = totalVol * 0.70;
    let vaVol = volMap[poc] || 0, lo = pocIdx, hi = pocIdx;
    while (vaVol < target) {
      const upVol = hi + 1 < levels.length ? (volMap[levels[hi+1]] || 0) : 0;
      const dnVol = lo - 1 >= 0 ? (volMap[levels[lo-1]] || 0) : 0;
      if (upVol >= dnVol && hi + 1 < levels.length) { hi++; vaVol += upVol; }
      else if (lo - 1 >= 0) { lo--; vaVol += dnVol; }
      else break;
    }
    result[d] = { PD_POC: poc, PD_VAH: levels[hi], PD_VAL: levels[lo] };
  }
  return result;
}

// ── Prior Month VAL ───────────────────────────────────────────────────────────
async function getBulkPmProfiles(dates) {
  const TICK = 0.25;
  const r = await query(`
    WITH monthly AS (
      SELECT DATE_TRUNC('month', ts::date) as mo,
        ROUND(((low + high) / 2 / $1)::numeric) * $1 as px_mid,
        volume::numeric as vol
      FROM price_bars WHERE symbol='NQ'
        AND EXTRACT(HOUR FROM ts)*60 + EXTRACT(MINUTE FROM ts) >= 570
        AND EXTRACT(HOUR FROM ts)*60 + EXTRACT(MINUTE FROM ts) < 975
        AND ts::date >= '2022-01-01'
    )
    SELECT mo::text as mo, px_mid, SUM(vol) as vol
    FROM monthly GROUP BY mo, px_mid ORDER BY mo, px_mid
  `, [TICK]);

  // Volume profile per month
  const byMonth = {};
  for (const row of r.rows) {
    const m = row.mo;
    if (!byMonth[m]) byMonth[m] = [];
    byMonth[m].push({ px: parseFloat(row.px_mid), vol: parseFloat(row.vol) });
  }

  // For each date, find the prior month's VAL
  const monthKeys = Object.keys(byMonth).sort();
  const result = {};
  for (const d of dates) {
    const mo = d.slice(0, 7) + '-01';
    const priorMo = monthKeys.filter(m => m < mo).pop();
    if (!priorMo || !byMonth[priorMo]) continue;
    const bars = byMonth[priorMo];
    const levels = bars.map(b => b.px).sort((a,b) => a-b);
    const volMap = {};
    for (const b of bars) volMap[b.px] = b.vol;
    const poc = levels.reduce((best, p) => volMap[p] > (volMap[best]||0) ? p : best, levels[0]);
    const pocIdx = levels.indexOf(poc);
    const totalVol = Object.values(volMap).reduce((s,v) => s+v, 0);
    const target = totalVol * 0.70;
    let vaVol = volMap[poc] || 0, lo = pocIdx, hi = pocIdx;
    while (vaVol < target) {
      const upVol = hi+1<levels.length ? (volMap[levels[hi+1]]||0) : 0;
      const dnVol = lo-1>=0 ? (volMap[levels[lo-1]]||0) : 0;
      if (upVol >= dnVol && hi+1<levels.length) { hi++; vaVol += upVol; }
      else if (lo-1>=0) { lo--; vaVol += dnVol; }
      else break;
    }
    result[d] = { PM_VAL: levels[lo], PM_VAH: levels[hi], PM_POC: poc };
  }
  return result;
}

// ── Combo proximity / touch check ────────────────────────────────────────────
function levelsInProximity(levels, sessionLevels, threshold, sessionData) {
  if (levels.length === 1) {
    // Single-level combo: check if session price range came within threshold of this level
    const price = sessionLevels[levels[0]];
    if (price == null || isNaN(price) || !isFinite(price)) return false;
    if (!sessionData) return false;
    const touchDist = Math.min(Math.abs(sessionData.hi - price), Math.abs(sessionData.lo - price));
    return touchDist <= threshold;
  }
  const prices = levels.map(k => sessionLevels[k]).filter(v => v != null && !isNaN(v) && isFinite(v));
  if (prices.length < levels.length) return false;
  const max = Math.max(...prices);
  const min = Math.min(...prices);
  return (max - min) <= threshold;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n── Level Confluence Combo Backtest ──`);
  console.log(`Proximity threshold: ${PROX_THRESHOLD} pts  |  Dry run: ${DRY_RUN}\n`);

  await ensureTable();

  let logId = null;
  if (!DRY_RUN) {
    try {
      const lr = await query(`INSERT INTO process_log (process_name, started_at, status) VALUES ('COMBO_BACKTEST', NOW(), 'RUNNING') RETURNING id`);
      logId = lr.rows[0].id;
    } catch (_) {}
  }

  try {

  // 1. Get NQ session data (open/close/hi/lo + derived pnl = move × $20/contract)
  process.stdout.write('Fetching NQ session data... ');
  const sessionMap = await getSessionData();
  // Restrict to days where acd_daily_log has data (we need OR/A levels)
  const acdCheck = await getAcdLevels();
  const dates = Object.keys(sessionMap).filter(d => acdCheck[d]).sort();
  console.log(`${dates.length} sessions (${dates[0]} → ${dates[dates.length-1]})`);

  const acdMap = acdCheck;
  console.log(`${dates.length} sessions with both NQ bars + ACD data (${dates[0]} → ${dates[dates.length-1]})`);
  console.log(`  (Using NQ open→close × $20/pt as outcome — normalized, sim/live-agnostic)`);

  // 3. Bulk bar level data
  process.stdout.write('Computing bar levels (ON/PD/PW/VWAP/W-VWAP/G-Line)... ');
  const { vwap, onLevels, pdLevels, pwLevels, wvwap, gline } = await getBulkBarLevels(dates);
  console.log('done');

  // 4. PD volume profiles (POC/VAH/VAL)
  process.stdout.write('Computing PD value areas... ');
  const pdProfiles = await getBulkPdProfiles(dates);
  console.log(`${Object.keys(pdProfiles).length} profiles`);

  // 5. PM (prior month) VAL
  process.stdout.write('Computing prior-month value areas... ');
  const pmProfiles = await getBulkPmProfiles(dates);
  console.log(`${Object.keys(pmProfiles).length} months`);

  // 6. Merge all levels per session
  const comboHits = {};
  for (const c of COMBOS) comboHits[c.id] = { n: 0, wins: 0, pnls: [] };

  let sessionsCounted = 0;
  for (const d of dates) {
    const sess = sessionMap[d];
    const acd  = acdMap[d];
    if (!sess || !acd) continue;
    const pnl = sess.pnl;

    const on  = onLevels[d]  || {};
    const pd  = pdLevels[d]  || {};
    const pw  = pwLevels[d]  || {};
    const pdp = pdProfiles[d] || {};
    const pmp = pmProfiles[d] || {};

    const sessionLevels = {
      OR_Hi:  acd.OR_Hi,
      OR_Lo:  acd.OR_Lo,
      OR5Mid: acd.OR5Mid,
      A_Up:   acd.A_Up,
      A_Dn:   acd.A_Dn,
      ON_Hi:  on.ON_Hi,
      ON_Lo:  on.ON_Lo,
      PD_Hi:  pd.PD_Hi,
      PD_Lo:  pd.PD_Lo,
      PW_Hi:  pw.PW_Hi,
      PW_Lo:  pw.PW_Lo,
      PD_POC: pdp.PD_POC,
      PD_VAH: pdp.PD_VAH,
      PD_VAL: pdp.PD_VAL,
      PM_VAL: pmp.PM_VAL,
      VWAP:   vwap[d],
      W_VWAP: wvwap[d],
      G_Line: gline[d],
    };

    for (const combo of COMBOS) {
      if (levelsInProximity(combo.levels, sessionLevels, PROX_THRESHOLD, sess)) {
        comboHits[combo.id].n++;
        comboHits[combo.id].pnls.push(pnl);
        if (pnl > 0) comboHits[combo.id].wins++;
      }
    }
    sessionsCounted++;
  }

  console.log(`\nAnalyzed ${sessionsCounted} sessions:\n`);
  console.log(`${'Combo'.padEnd(30)} ${'N'.padStart(5)} ${'Win%'.padStart(6)} ${'AvgPnL'.padStart(8)}`);
  console.log('─'.repeat(55));

  const statsToSave = [];
  for (const combo of COMBOS) {
    const { n, wins, pnls } = comboHits[combo.id];
    if (n === 0) {
      console.log(`${combo.label.padEnd(30)} ${'0'.padStart(5)} ${'—'.padStart(6)} ${'—'.padStart(8)}`);
      continue;
    }
    const avgPnl = pnls.reduce((s, v) => s + v, 0) / n;
    const winRate = (wins / n) * 100;
    console.log(`${combo.label.padEnd(30)} ${n.toString().padStart(5)} ${winRate.toFixed(1).padStart(5)}% ${('$'+Math.round(avgPnl)).padStart(8)}`);
    statsToSave.push({
      combo_id: combo.id, label: combo.label, category: combo.cat, tier: combo.tier,
      levels: combo.levels, n, win_count: wins,
      avg_pnl: Math.round(avgPnl * 100) / 100,
      win_rate: Math.round(winRate * 10) / 10,
      prox_pts: PROX_THRESHOLD,
      range_start: dates[0], range_end: dates[dates.length - 1],
    });
  }

  if (DRY_RUN) {
    console.log('\n[Dry run — no DB write]');
  } else {
    process.stdout.write('\nSaving to combo_stats... ');
    for (const s of statsToSave) {
      await query(`
        INSERT INTO combo_stats (combo_id, label, category, tier, levels, n, win_count, avg_pnl, win_rate, prox_pts, session_range_start, session_range_end, last_analyzed)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
        ON CONFLICT (combo_id) DO UPDATE SET
          label=$2, category=$3, tier=$4, levels=$5, n=$6, win_count=$7,
          avg_pnl=$8, win_rate=$9, prox_pts=$10,
          session_range_start=$11, session_range_end=$12, last_analyzed=NOW()
      `, [s.combo_id, s.label, s.category, s.tier, s.levels, s.n, s.win_count,
          s.avg_pnl, s.win_rate, s.prox_pts, s.range_start, s.range_end]);
    }
    console.log(`${statsToSave.length} combos saved.`);
  }

    if (logId) {
      await query(`UPDATE process_log SET status='SUCCESS', completed_at=NOW(), records_affected=$1 WHERE id=$2`,
        [statsToSave.length, logId]);
    }
    console.log('\n── Done ──');
    await pool.end();
  } catch (e) {
    if (logId) {
      try { await query(`UPDATE process_log SET status='FAILED', completed_at=NOW(), error_message=$1 WHERE id=$2`, [e.message, logId]); } catch (_) {}
    }
    console.error(e);
    try { await pool.end(); } catch (_) {}
    process.exit(1);
  }
}

main();
