import { query } from '../server/db.js';
import { logProcess } from '../server/lib/processLog.js';
import { computeEvalProgress } from '../server/routes/dll.js';
import Anthropic from '@anthropic-ai/sdk';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function fmt(n, decimals = 2) {
  if (n == null) return 'N/A';
  const v = parseFloat(n);
  return isNaN(v) ? 'N/A' : v.toFixed(decimals);
}

function fmtPrice(n) { return fmt(n, 2); }

async function runMorningBrief(targetDate) {
  const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  if (!targetDate) targetDate = nowET.toISOString().slice(0, 10);

  console.log(`[morning_brief] Building brief for ${targetDate}`);

  // Eval progress (non-blocking — doesn't break brief if it fails)
  let evalAccounts = [];
  try { evalAccounts = await computeEvalProgress(); } catch (_) {}

  const [acdQ, prevAcdQ, dplQ, arQ, nl30Q, setupsQ, coachingQ, acdMonthlyQ, importLogQ, gLineQ, gLineWeekQ, onQ, pwPdQ, dynamicEdgesQ] = await Promise.all([
    // Today's ACD
    query(`SELECT trade_date::text, day_type, daily_score, or_high, or_low,
             a_up_fired, a_down_fired, a_up_level, a_down_level,
             c_up_confirmed, c_down_confirmed, session_close
           FROM acd_daily_log WHERE trade_date = $1`, [targetDate]),

    // Prior two sessions for context
    query(`SELECT trade_date::text, daily_score, or_high, or_low,
             a_up_fired, a_down_fired, c_up_confirmed, c_down_confirmed,
             session_close, day_type
           FROM acd_daily_log
           WHERE trade_date < $1
           ORDER BY trade_date DESC LIMIT 2`, [targetDate]),

    // Structural state + confluence
    query(`SELECT structural_state, nl30_at_open, nl10_at_open,
             confluence_score_pre, confluence_score_peak,
             opening_call, a_signal_direction, a_signal_quality, counter_trend
           FROM daily_performance_log
           ORDER BY trade_date DESC LIMIT 1`),

    // Today's auction read
    query(`SELECT opening_call_type, a_signal_override
           FROM auction_reads WHERE trade_date = $1`, [targetDate]),

    // NL30 live
    query(`SELECT
             SUM(daily_score) FILTER (WHERE trade_date > CURRENT_DATE-30 AND trade_date <= CURRENT_DATE) as nl30,
             SUM(daily_score) FILTER (WHERE trade_date > CURRENT_DATE-10 AND trade_date <= CURRENT_DATE) as nl10
           FROM acd_daily_log WHERE daily_score IS NOT NULL`),

    // Active setups today
    query(`SELECT setup_type, status, entry_zone_low, entry_zone_high,
             t1_level, stop_level, historical_win_rate, historical_sessions,
             confluence_score_at_detection, fired_at::text
           FROM active_setups
           WHERE trade_date = $1 AND status = 'ACTIVE'
           ORDER BY fired_at`, [targetDate]),

    // Most recent coaching — extract TOMORROW'S WATCH
    query(`SELECT session_date::text, coaching_text
           FROM daily_coaching ORDER BY session_date DESC LIMIT 1`),

    // ACD monthly pivot
    query(`SELECT month_year, pivot_level, pivot_r1, pivot_s1,
             prior_month_high, prior_month_low
           FROM acd_monthly_pivot
           ORDER BY month_year DESC LIMIT 1`),

    // Most recent auto-import
    query(`SELECT import_time, imported, file_used
           FROM import_log WHERE trigger = 'AUTO_4PM'
           ORDER BY import_time DESC LIMIT 1`),

    // G-Line (CME weekly open — Sunday 18:00 ET first bar)
    query(`
      SELECT (array_agg(open ORDER BY ts ASC))[1]::float as g_line
      FROM price_bars WHERE symbol='NQ'
        AND ts::date = date_trunc('week', ($1::text)::date) - INTERVAL '1 day'
        AND EXTRACT(hour FROM ts) >= 18
    `, [targetDate]),

    // G-Line days held this week (prior sessions only — today not yet closed)
    query(`
      SELECT ts::date as session_date,
             (array_agg(close ORDER BY ts DESC))[1]::float as session_close
      FROM price_bars
      WHERE symbol='NQ'
        AND ts::date >= date_trunc('week', ($1::text)::date)
        AND ts::date < ($1::text)::date
        AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) BETWEEN 570 AND 960
      GROUP BY ts::date ORDER BY ts::date ASC
    `, [targetDate]),

    // Overnight High/Low (prior RTH close → current pre-market)
    query(`
      SELECT MAX(h) as on_high, MIN(l) as on_low FROM (
        SELECT high as h, low as l FROM price_bars WHERE symbol='NQ'
          AND ts::date = ($1::date - INTERVAL '1 day')::date
          AND EXTRACT(HOUR FROM ts)*60+EXTRACT(MINUTE FROM ts) >= 960
        UNION ALL
        SELECT high, low FROM price_bars WHERE symbol='NQ'
          AND ts::date = $1::date
          AND EXTRACT(HOUR FROM ts)*60+EXTRACT(MINUTE FROM ts) < 570
      ) x
    `, [targetDate]),

    // Prior week H/L + prior day bar H/L
    query(`
      SELECT
        MAX(high) FILTER (WHERE ts::date >= DATE_TRUNC('week', $1::date - INTERVAL '7 days')
                           AND ts::date < DATE_TRUNC('week', $1::date)
                           AND EXTRACT(HOUR FROM ts) BETWEEN 9 AND 16) as pw_high,
        MIN(low)  FILTER (WHERE ts::date >= DATE_TRUNC('week', $1::date - INTERVAL '7 days')
                           AND ts::date < DATE_TRUNC('week', $1::date)
                           AND EXTRACT(HOUR FROM ts) BETWEEN 9 AND 16) as pw_low,
        MAX(high) FILTER (WHERE ts::date = (SELECT MAX(ts::date) FROM price_bars WHERE symbol='NQ' AND ts::date < $1)
                           AND EXTRACT(HOUR FROM ts) BETWEEN 9 AND 16) as pd_high_bar,
        MIN(low)  FILTER (WHERE ts::date = (SELECT MAX(ts::date) FROM price_bars WHERE symbol='NQ' AND ts::date < $1)
                           AND EXTRACT(HOUR FROM ts) BETWEEN 9 AND 16) as pd_low_bar
      FROM price_bars WHERE symbol='NQ'
    `, [targetDate]),

    // Active dynamic edges from mining
    query(`SELECT setup_type, dimension, segment, win_rate::float as wr, baseline_win_rate::float as base_wr, deviation::float as deviation, status, p_value::float as p_value
           FROM dynamic_edges_mining
           WHERE status IN ('POSITIVE_BOOSTER', 'NEGATIVE_DRAG')
           ORDER BY status DESC, ABS(deviation) DESC`).catch(() => ({ rows: [] })),
  ]);

  // Structural levels via direct TPO query (same as phaseChangeDetector)
  let structuralLevels = [];
  try {
    const tpoQ = await query(`
      WITH bars AS (
        SELECT ROUND(low/0.25)*0.25 as lo, ROUND(high/0.25)*0.25 as hi
        FROM price_bars WHERE symbol='NQ'
          AND ts::date >= $1::date - INTERVAL '5 days'
          AND ts::date < $1::date
          AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
      )
      SELECT ROUND((lo + s*0.25)::numeric, 2)::float as px, COUNT(*)::int as tpo
      FROM bars, generate_series(0, ROUND((hi-lo)/0.25)::int) s
      GROUP BY px ORDER BY px ASC
    `, [targetDate]);

    if (tpoQ.rows.length > 0) {
      const profile = tpoQ.rows;
      const totalTpo = profile.reduce((s, r) => s + r.tpo, 0);
      const poc = profile.reduce((b, r) => r.tpo > b.tpo ? r : b, profile[0]);
      const pocIdx = profile.findIndex(r => r.px === poc.px);
      const target = totalTpo * 0.70;
      let lo = pocIdx, hi = pocIdx, acc = poc.tpo;
      while (acc < target && (lo > 0 || hi < profile.length - 1)) {
        const addLo = lo > 0 ? profile[lo - 1].tpo : 0;
        const addHi = hi < profile.length - 1 ? profile[hi + 1].tpo : 0;
        if (addLo >= addHi) { lo--; acc += addLo; } else { hi++; acc += addHi; }
      }
      structuralLevels.push({ type: 'COMPOSITE_VAH', price: profile[hi].px });
      structuralLevels.push({ type: 'COMPOSITE_POC', price: poc.px });
      structuralLevels.push({ type: 'COMPOSITE_VAL', price: profile[lo].px });
    }
  } catch (_) {}

  // Prior day VAH/VAL/POC via volume profile query
  try {
    const pdDateQ = await query(`
      SELECT ts::date::text as d FROM price_bars
      WHERE symbol='NQ' AND ts::date < $1 AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
      ORDER BY ts::date DESC LIMIT 1
    `, [targetDate]);
    const pdDate = pdDateQ.rows[0]?.d;
    if (pdDate) {
      const pdQ = await query(`
        WITH bars AS (
          SELECT ROUND(low/0.25)*0.25 as lo, ROUND(high/0.25)*0.25 as hi
          FROM price_bars WHERE symbol='NQ' AND ts::date = $1
            AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
        )
        SELECT ROUND((lo + s*0.25)::numeric, 2)::float as px, COUNT(*)::int as tpo
        FROM bars, generate_series(0, ROUND((hi-lo)/0.25)::int) s
        GROUP BY px ORDER BY px ASC
      `, [pdDate]);
      if (pdQ.rows.length > 0) {
        const profile = pdQ.rows;
        const totalTpo = profile.reduce((s, r) => s + r.tpo, 0);
        const poc = profile.reduce((b, r) => r.tpo > b.tpo ? r : b, profile[0]);
        const pocIdx = profile.findIndex(r => r.px === poc.px);
        const target = totalTpo * 0.70;
        let lo = pocIdx, hi = pocIdx, acc = poc.tpo;
        while (acc < target && (lo > 0 || hi < profile.length - 1)) {
          const addLo = lo > 0 ? profile[lo - 1].tpo : 0;
          const addHi = hi < profile.length - 1 ? profile[hi + 1].tpo : 0;
          if (addLo >= addHi) { lo--; acc += addLo; } else { hi++; acc += addHi; }
        }
        structuralLevels.push({ type: 'PRIOR_DAY_VAH', price: profile[hi].px });
        structuralLevels.push({ type: 'PRIOR_DAY_POC', price: poc.px });
        structuralLevels.push({ type: 'PRIOR_DAY_VAL', price: profile[lo].px });
      }
    }
  } catch (_) {}

  // Assemble context
  const today = acdQ.rows[0] || {};
  const prev = prevAcdQ.rows;
  const dpl = dplQ.rows[0] || {};
  const ar = arQ.rows[0] || {};
  const nl30 = parseInt(nl30Q.rows[0]?.nl30) || 0;
  const nl10 = parseInt(nl30Q.rows[0]?.nl10) || 0;
  const setups = setupsQ.rows;
  const lastCoaching = coachingQ.rows[0];
  const pivot = acdMonthlyQ.rows[0];
  const lastImport = importLogQ.rows[0] || null;

  // G-Line context
  const gLine = gLineQ.rows[0]?.g_line || null;
  let gLineDaysHeld = 0, gLineDirection = 'above';
  if (gLine) {
    let aboveCount = 0;
    for (const s of gLineWeekQ.rows) {
      if (s.session_close > gLine) aboveCount++;
    }
    gLineDaysHeld = aboveCount;
    gLineDirection = aboveCount >= (gLineWeekQ.rows.length - aboveCount) ? 'above' : 'below';
  }
  // Today opens above or below G-Line: use OR low as rough session open reference
  const todayOpen = today.or_low ? parseFloat(today.or_low) : null;
  const todayAboveGLine = gLine && todayOpen ? todayOpen > gLine : null;
  const gLinePts = gLine && todayOpen ? Math.abs(todayOpen - gLine).toFixed(0) : 'N/A';
  const gLineAboveBelow = todayAboveGLine === true ? 'above' : todayAboveGLine === false ? 'below' : 'near';

  // Overnight + prior week levels
  const onHigh    = parseFloat(onQ.rows[0]?.on_high)    || null;
  const onLow     = parseFloat(onQ.rows[0]?.on_low)     || null;
  const pwHigh    = parseFloat(pwPdQ.rows[0]?.pw_high)  || null;
  const pwLow     = parseFloat(pwPdQ.rows[0]?.pw_low)   || null;
  const pdHighBar = parseFloat(pwPdQ.rows[0]?.pd_high_bar) || null;
  const pdLowBar  = parseFloat(pwPdQ.rows[0]?.pd_low_bar)  || null;
  const pdVah = structuralLevels.find(l => l.type === 'PRIOR_DAY_VAH')?.price || null;
  const pdVal = structuralLevels.find(l => l.type === 'PRIOR_DAY_VAL')?.price || null;
  const pdPoc = structuralLevels.find(l => l.type === 'PRIOR_DAY_POC')?.price || null;

  // Level confluence — which pre-market combos are in proximity?
  const levelValues = {
    ON_Hi: onHigh, ON_Lo: onLow,
    PD_Hi: pdHighBar, PD_Lo: pdLowBar,
    PD_VAH: pdVah, PD_VAL: pdVal, PD_POC: pdPoc,
    PW_Hi: pwHigh, PW_Lo: pwLow,
    G_Line: gLine,
  };

  // Load live stats from combo_stats table (updated weekly by combo_backtest.js)
  const comboStatsRows = await query(`SELECT combo_id, avg_pnl, win_rate, n FROM combo_stats`).then(r => r.rows).catch(() => []);
  const comboStatsMap = Object.fromEntries(comboStatsRows.map(r => [r.combo_id, r]));
  const liveStats = (id, fallback) => {
    const s = comboStatsMap[id];
    return s ? { avg: Math.round(parseFloat(s.avg_pnl)), win: Math.round(parseFloat(s.win_rate)), n: parseInt(s.n) } : fallback;
  };

  const PM_COMBOS = [
    { id: 'on_lo_pd_lo',  levels: ['ON_Lo', 'PD_Lo'],  label: 'ON Low + PD Low',
      ...liveStats('on_lo_pd_lo', { avg: 63, win: 61, n: 70 }),
      must: ['Entry above ON Low (support, +$248 vs −$6 below)', 'Wide IB day preferred', 'Open outside PD VA'],
      avoid: ['Inside VA open (−$40)', 'Wednesdays (−$96)'] },
    { id: 'on_lo_pdpoc_vwap', levels: ['ON_Lo', 'PD_POC'], label: 'ON Low + PD POC',
      ...liveStats('on_lo_pdpoc_vwap', { avg: 41, win: 35, n: 97 }),
      must: ['PD POC from below (+$52)', 'Mid-morning or Wed ($+112)'],
      avoid: ['Fridays (0% win rate)', 'Close session (−$126)'] },
    { id: 'pd_lo_pd_val', levels: ['PD_Lo', 'PD_VAL'], label: 'PD Low + PD VAL',
      ...liveStats('pd_lo_pd_val', { avg: 22, win: 44, n: 128 }),
      must: ['Entry above PD VAL (+$108 vs −$16 from below)', 'Mid-morning ($+67)'],
      avoid: ['Below VA open (−$63)', 'Afternoons (−$37)'] },
    { id: 'pd_val_wvwap', levels: ['PD_VAL', 'W_VWAP'], label: 'PD VAL + W-VWAP',
      ...liveStats('pd_val_wvwap', { avg: 60, win: 57, n: 109 }),
      must: ['Entry above PD VAL (+$81)', 'Narrow IB (+$81 vs +$20 wide)'],
      avoid: ['Inside VA open (−$141)', 'Thursdays (−$178)'] },
    { id: 'on_lo_pd_lo',  levels: ['PD_Lo', 'PD_VAL'],  label: 'PD Low + PD VAL',
      ...liveStats('pd_lo_pd_val', { avg: 42, win: 42, n: 50 }),
      must: ['PD POC from below (+$84 vs −$260 from above)', 'Mid-morning ($+96)'],
      avoid: ['Open drive ($+5 only)', 'Thursdays (−$20)'] },
  ];

  const activeCombos = PM_COMBOS.filter(c => {
    const vals = c.levels.map(l => levelValues[l]).filter(v => v != null);
    if (vals.length < c.levels.length) return false;
    return (Math.max(...vals) - Math.min(...vals)) <= 20;
  }).map(c => {
    const vals = c.levels.map(l => levelValues[l]);
    return { ...c, prices: Object.fromEntries(c.levels.map(l => [l, levelValues[l]])),
      spread: +(Math.max(...vals) - Math.min(...vals)).toFixed(2) };
  });

  // Intraday watch: OR-level combos — flag the anchor levels
  const watchLevels = [];
  if (pwHigh != null) watchLevels.push({ level: 'PW Hi', price: pwHigh,
    combos: ['OR_Hi+PW_Hi ($+58, 48% win)', 'OR5Mid+OR_Hi+PW_Hi ($+94, 67% win)'],
    note: 'Open drive only. OR Hi from below. Entry above PW Hi (+$116 vs +$39). Avoid Fridays.' });
  if (onHigh != null) watchLevels.push({ level: 'ON Hi', price: onHigh,
    combos: ['ON_Hi+OR5Mid+OR_Hi ($+45, 57% win)'],
    note: 'If OR prints near ON Hi: mid-morning or open drive, ON Hi from above.' });

  const dow = new Date(targetDate + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long' });

  const confluenceData = { levels: levelValues, activeCombos, watchLevels, dow };

  // Data health: how stale is the last auto-import?
  let importStatus, importStatusLabel;
  if (!lastImport) {
    importStatus = 'RED'; importStatusLabel = 'No auto-import on record';
  } else {
    const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const importET = new Date(lastImport.import_time);
    const ageHours = (nowET - importET) / 3600000;
    if (ageHours < 20) {
      importStatus = 'GREEN';
      importStatusLabel = `${new Date(lastImport.import_time).toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' })} at ${new Date(lastImport.import_time).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' })} ET — ${lastImport.imported} fills added`;
    } else if (ageHours < 52) {
      importStatus = 'AMBER';
      importStatusLabel = `Yesterday — ${lastImport.imported} fills (${Math.round(ageHours)}h ago)`;
    } else {
      importStatus = 'RED';
      importStatusLabel = `${Math.round(ageHours / 24)} days ago — data may be stale`;
    }
  }
  const structState = dpl.structural_state || 'BRACKET';
  const confluenceScore = dpl.confluence_score_pre ?? dpl.confluence_score_peak ?? 0;
  const openingCall = ar.opening_call_type || dpl.opening_call || 'NO_SIGNAL';
  const aSignal = ar.a_signal_override || 'NO_SIGNAL';

  // Extract TOMORROW'S WATCH from last coaching
  let tomorrowWatch = 'No prior coaching available.';
  if (lastCoaching?.coaching_text) {
    const m = lastCoaching.coaching_text.match(/TOMORROW'S WATCH:\s*([\s\S]*?)(?:\n\n|$)/i);
    if (m) tomorrowWatch = `(${lastCoaching.session_date}) ${m[1].trim()}`;
  }

  const orRange = (today.or_high && today.or_low)
    ? `${fmtPrice(today.or_low)}–${fmtPrice(today.or_high)} (${(parseFloat(today.or_high) - parseFloat(today.or_low)).toFixed(2)} pts)`
    : 'Not yet established';

  const aUpLevel = today.a_up_level ? fmtPrice(today.a_up_level) : 'N/A';
  const aDownLevel = today.a_down_level ? fmtPrice(today.a_down_level) : 'N/A';

  const nl30Label = nl30 > 15 ? 'STRONG BULL' : nl30 > 9 ? 'BULL' : nl30 < -15 ? 'STRONG BEAR' : nl30 < -9 ? 'BEAR' : 'RANGING';

  const structLevelLines = structuralLevels.length > 0
    ? structuralLevels
        .sort((a, b) => b.price - a.price)
        .map(l => `  ${l.type.padEnd(18)} ${fmtPrice(l.price)}`)
        .join('\n')
    : '  (No bar data available for structural levels)';

  const setupLines = setups.length > 0
    ? setups.map(s =>
        `  ${s.setup_type.padEnd(30)} EZ: ${fmtPrice(s.entry_zone_low)}–${fmtPrice(s.entry_zone_high)} | T1: ${fmtPrice(s.t1_level)} | Stop: ${fmtPrice(s.stop_level)}` +
        (s.historical_win_rate != null ? ` | Hist WR: ${(parseFloat(s.historical_win_rate)*100).toFixed(0)}% (${s.historical_sessions}s)` : '')
      ).join('\n')
    : '  None fired yet.';

  const prevLines = prev.map(r =>
    `  ${r.trade_date}  score: ${r.daily_score > 0 ? '+' : ''}${r.daily_score}  ` +
    `${r.a_up_fired ? 'A↑' : r.a_down_fired ? 'A↓' : '—'}  ` +
    `${r.c_up_confirmed ? 'C↑' : r.c_down_confirmed ? 'C↓' : ''}  ` +
    `close: ${fmtPrice(r.session_close)}`
  ).join('\n');

  const pivotLines = pivot
    ? `  Monthly pivot: ${fmtPrice(pivot.pivot_level)}  R1: ${fmtPrice(pivot.pivot_r1)}  S1: ${fmtPrice(pivot.pivot_s1)}\n  Prior month H/L: ${fmtPrice(pivot.prior_month_high)} / ${fmtPrice(pivot.prior_month_low)}`
    : '  (no monthly pivot data)';

  // Build eval status lines
  const evalLines = evalAccounts.length > 0
    ? evalAccounts.map(a => {
        const pnlStr = a.current_pnl >= 0 ? `+$${a.current_pnl.toFixed(0)}` : `-$${Math.abs(a.current_pnl).toFixed(0)}`;
        const neededStr = `$${Math.round(a.profit_needed).toLocaleString()} to pass`;
        const rateStr = a.avg_daily_pnl > 0
          ? `avg +$${a.avg_daily_pnl.toFixed(0)}/day over ${a.days_traded}d`
          : a.days_traded > 0
          ? `avg -$${Math.abs(a.avg_daily_pnl).toFixed(0)}/day over ${a.days_traded}d — not on trajectory`
          : 'no trades yet';
        return `  ${a.short_id.padEnd(10)} ${pnlStr.padEnd(10)} needs ${neededStr.padEnd(22)} (${rateStr})`;
      }).join('\n')
    : '  No active evaluation accounts.';

  const evalSummary = (() => {
    const onTrack = evalAccounts.filter(a => a.on_track);
    const offTrack = evalAccounts.filter(a => !a.on_track && a.current_pnl < 3000);
    const lines = [];
    if (offTrack.length > 0) {
      lines.push(`  ${offTrack.map(a => a.short_id).join(', ')} ${offTrack.length === 1 ? 'is' : 'are'} not on a passing trajectory.`);
      lines.push('  A high-conviction session today matters more than a cautious one.');
    }
    if (onTrack.length > 0) {
      lines.push(`  ${onTrack.map(a => `${a.short_id} on track — ${a.trajectory}`).join(', ')}.`);
    }
    return lines.join('\n') || '  All accounts need better performance to reach target.';
  })();

  const dynamicBoosters = (dynamicEdgesQ?.rows || []).filter(e => e.status === 'POSITIVE_BOOSTER');
  const dynamicDrags = (dynamicEdgesQ?.rows || []).filter(e => e.status === 'NEGATIVE_DRAG');

  let dynamicEdgesLines = '  No statistically significant dynamic edges mined yet.';
  if (dynamicBoosters.length > 0 || dynamicDrags.length > 0) {
    const lines = [];
    if (dynamicBoosters.length > 0) {
      lines.push('  🚀 Active Boosters (Size Up / Confirm):');
      for (const e of dynamicBoosters) {
        lines.push(`    · ${e.setup_type.padEnd(28)} | ${e.segment.padEnd(22)} | WR: ${e.wr.toFixed(1)}% vs Base: ${e.base_wr.toFixed(1)}% (+${e.deviation.toFixed(1)}%) (p=${e.p_value.toFixed(4)})`);
      }
    }
    if (dynamicDrags.length > 0) {
      if (lines.length > 0) lines.push('');
      lines.push('  🛑 Active Drags (Size Down / Filter):');
      for (const e of dynamicDrags) {
        lines.push(`    · ${e.setup_type.padEnd(28)} | ${e.segment.padEnd(22)} | WR: ${e.wr.toFixed(1)}% vs Base: ${e.base_wr.toFixed(1)}% (${e.deviation.toFixed(1)}%) (p=${e.p_value.toFixed(4)})`);
      }
    }
    dynamicEdgesLines = lines.join('\n');
  }

  const balanceRegime = Math.abs(nl10) <= 6 ? 'BALANCE (Oscillating/Overlapping)' : 'IMBALANCE (Expansion/Trend)';
  
  let balanceTacticalPlaybook = '';
  if (Math.abs(nl10) <= 6) {
    balanceTacticalPlaybook = [
      `  Balance Character: RANGING`,
      `  Tactical Playbook: BALANCE FADE (Mean Reversion)`,
      `    · Favour fading extremes. Do NOT chase breakouts.`,
      `    · Look to sell near Composite VAH or Bracket High, buy near Composite VAL or Bracket Low.`,
      `    · Target: Composite POC.`
    ].join('\n');
  } else {
    const dir = nl10 > 0 ? 'BULL' : 'BEAR';
    const action = nl10 > 0 ? 'Buy pullbacks to old boundaries / support levels' : 'Sell rallies to old boundaries / resistance levels';
    balanceTacticalPlaybook = [
      `  Balance Character: TRENDING (${dir} EXPANSION)`,
      `  Tactical Playbook: DIRECTIONAL MOMENTUM (Trend Follow)`,
      `    · Value is migrating. Do NOT fade the trend.`,
      `    · Action: ${action}.`,
      `    · Key Retest Level: ${nl10 > 0 ? 'Composite VAH / pd VAH' : 'Composite VAL / pd VAL'}.`
    ].join('\n');
  }

  const sep = '─'.repeat(60);
  const importStatusMark = importStatus === 'GREEN' ? '✓' : importStatus === 'AMBER' ? '⚠' : '✗';
  const gLineLines = gLine
    ? [
        `  G-Line (wkly open): ${fmtPrice(gLine)}`,
        `  Days held ${gLineDirection} this week: ${gLineDaysHeld} session${gLineDaysHeld !== 1 ? 's' : ''}`,
        `  Today opens ${gLineAboveBelow} G-Line by ${gLinePts} pts`,
      ].join('\n')
    : '  G-Line: no Sunday bar data available';

  const briefText = [
    `MORNING BRIEF — ${targetDate}`,
    `Generated: ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET`,
    sep,
    '',
    'DATA HEALTH',
    `  Last auto-import  : [${importStatusMark}] ${importStatusLabel}`,
    '',
    'STRUCTURAL CONTEXT',
    `  State         : ${structState}`,
    `  NL30          : ${nl30} (${nl30Label})  |  NL10: ${nl10}`,
    `  Regime        : ${balanceRegime}`,
    `  Confluence    : ${confluenceScore}/12`,
    `  Opening call  : ${openingCall}`,
    `  A signal      : ${aSignal}`,
    '',
    'BALANCE REGIME PLAYBOOK',
    balanceTacticalPlaybook,
    '',
    "TODAY'S ACD LEVELS",
    `  OR            : ${orRange}`,
    `  A Up level    : ${aUpLevel}  (fired: ${today.a_up_fired ? 'YES' : 'no'})`,
    `  A Down level  : ${aDownLevel}  (fired: ${today.a_down_fired ? 'YES' : 'no'})`,
    `  C Up          : ${today.c_up_confirmed ? 'CONFIRMED' : 'not yet'}`,
    `  C Down        : ${today.c_down_confirmed ? 'CONFIRMED' : 'not yet'}`,
    `  Day score     : ${today.daily_score > 0 ? '+' : ''}${today.daily_score || 0}`,
    '',
    'G-LINE (weekly open)',
    gLineLines,
    '',
    'STRUCTURAL LEVELS (5-day composite + prior day)',
    structLevelLines,
    '',
    'MONTHLY REFERENCE',
    pivotLines,
    '',
    'PRIOR SESSIONS',
    prevLines || '  (none)',
    '',
    'ACTIVE SETUPS',
    setupLines,
    '',
    'DYNAMIC MINED EDGES (Statistical shifts)',
    dynamicEdgesLines,
    '',
    'BEHAVIORAL LEVEL MAP & SESSIONS FORECAST',
    (() => {
      const p = (v) => v != null ? fmtPrice(v) : '—';
      return [
        `  POC Magnet (${p(pdPoc)}) : Expect fast approach (16 pts/bar), touch-and-go (1.3 bar dwell). Target only, no entry.`,
        `  VAH Edge   (${p(pdVah)}) : Expect heavy retests (4.4 avg) & churn (4.8 bar dwell). Let it absorb before fade.`,
        `  VAL Edge   (${p(pdVal)}) : Fast resolution (2.1 bar dwell, 2.3 retests). Support holds or breaks quickly.`,
        `  Balance Excursions   : 83% return within 15 bars (65% in 5). Limit is ~29pt max excursion before snapback.`,
      ].join('\n');
    })(),
    '',
    'LEVEL CONFLUENCE WATCH',
    (() => {
      const p = (v) => v != null ? fmtPrice(v) : '—';
      const lines = [
        '  Pre-market levels:',
        `    ON Hi ${p(onHigh).padStart(10)}   ON Lo  ${p(onLow).padStart(10)}`,
        `    PW Hi ${p(pwHigh).padStart(10)}   PW Lo  ${p(pwLow).padStart(10)}`,
        `    PD Hi ${p(pdHighBar).padStart(10)}   PD Lo  ${p(pdLowBar).padStart(10)}`,
        `    PD VAH ${p(pdVah).padStart(9)}   PD POC ${p(pdPoc).padStart(9)}   PD VAL ${p(pdVal)}`,
        `    G-Line ${p(gLine).padStart(9)}`,
        '',
        `  Day: ${dow}`,
      ];
      if (activeCombos.length === 0) {
        lines.push('  No pre-market combos in proximity (>20pt apart).');
      } else {
        lines.push(`  Active combos (levels within 20pt):`);
        for (const c of activeCombos) {
          const prices = c.levels.map(l => `${l} ${p(c.prices[l])}`).join(' ↔ ');
          lines.push(`    [ACTIVE] ${c.label}  (${c.spread}pt spread)`);
          lines.push(`             $+${c.avg} avg · ${c.win}% win · n=${c.n}`);
          lines.push(`             ${prices}`);
          lines.push(`             Must: ${c.must[0]}`);
          if (c.avoid[0]) lines.push(`             Avoid: ${c.avoid[0]}`);
          lines.push('');
        }
      }
      if (watchLevels.length > 0) {
        lines.push('  Intraday watch (check after 9:35 OR established):');
        for (const w of watchLevels) {
          lines.push(`    ${w.level} @ ${p(w.price)} → ${w.combos[0]}`);
          lines.push(`      ${w.note}`);
        }
        lines.push('');
      }
      lines.push('  Context to check:');
      lines.push(`    9:30 open vs PD VA:  VAL ${p(pdVal)} / VAH ${p(pdVah)}`);
      lines.push('    10:30 IB type: narrow = IB range < 20-day avg (~25pt)');
      return lines.join('\n');
    })(),
    '',
    "YESTERDAY'S WATCH (from coaching)",
    `  ${tomorrowWatch}`,
    '',
    'ACCOUNT STATUS (EVAL)',
    evalLines,
    '',
    evalSummary,
    '',
    sep,
  ].join('\n');

  console.log('\n' + briefText + '\n');

  // AI interpretation (optional — quick 2-sentence read on the setup)
  const client = new Anthropic();
  let aiRead = '';
  try {
    const evalPromptLines = evalAccounts.length > 0
      ? 'ACCOUNT STATUS:\n' + evalAccounts.map(a => {
          const pnlStr = a.current_pnl >= 0 ? `+$${a.current_pnl.toFixed(0)}` : `-$${Math.abs(a.current_pnl).toFixed(0)}`;
          return `${a.short_id}: ${pnlStr} total over ${a.days_traded} days, needs $${Math.round(a.profit_needed)} to pass. ${a.trajectory}.`;
        }).join(' ') + '\n' + evalSummary
      : '';

    const prompt = `NQ futures pre-market snapshot for ${targetDate}. ACD methodology. Trading window 9:30–11:00 ET.

DATE: ${targetDate}
Structural state: ${structState} | NL30: ${nl30} (${nl30Label}) | NL10: ${nl10}
OR: ${orRange} | A Up: ${aUpLevel} (fired: ${today.a_up_fired ? 'yes' : 'no'}) | A Down: ${aDownLevel} (fired: ${today.a_down_fired ? 'yes' : 'no'})
Confluence: ${confluenceScore}/12 | Opening call: ${openingCall} | A signal: ${aSignal}
G-LINE: ${gLine ? fmtPrice(gLine) : 'N/A'} — ${gLineDaysHeld} sessions held ${gLineDirection} this week, today opens ${gLineAboveBelow} by ${gLinePts} pts
Active setups: ${setups.length > 0 ? setups.map(s => s.setup_type).join(', ') : 'none'}
Prior session watch: ${tomorrowWatch}
${evalPromptLines ? '\n' + evalPromptLines : ''}

Write 3–5 short bullets. Each bullet is one concrete point — the bias, the specific price that matters today, or what confirms vs denies a trade. Plain trading language. No headers, no bold, no hedging preamble, no meta-commentary. Hard cap: 80 words total.

Example tone: "- Opened inside value, two-sided. Watch 28781 — accept below = short, reject = balance. NL negative, slight short lean. No edge until OR sets the tone."`;

    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 120,
      messages: [{ role: 'user', content: prompt }],
    });
    aiRead = msg.content[0].text;
  } catch (err) {
    aiRead = `(AI read unavailable: ${err.message})`;
  }

  const fullBriefText = briefText + '\nAI READ\n' + '─'.repeat(60) + '\n' + aiRead + '\n' + '─'.repeat(60) + '\n';

  console.log('AI READ\n' + '─'.repeat(60));
  console.log(aiRead);
  console.log('─'.repeat(60) + '\n');

  // Save to DB
  try {
    const structuralData = {
      nl30, nl10,
      structuralLevels,
      gLine,
      gLineDaysHeld,
      gLineDirection,
      acdToday: {
        or_high: today.or_high,
        or_low: today.or_low,
        a_up_level: today.a_up_level,
        a_down_level: today.a_down_level,
        daily_score: today.daily_score,
      },
      pivot: pivot || null,
      confluence: confluenceData,
    };
    await query(
      `INSERT INTO morning_briefs (brief_date, brief_text, structural_data)
       VALUES ($1, $2, $3)
       ON CONFLICT (brief_date) DO UPDATE SET
         brief_text = EXCLUDED.brief_text,
         structural_data = EXCLUDED.structural_data,
         created_at = NOW()`,
      [targetDate, fullBriefText, JSON.stringify(structuralData)]
    );
  } catch (saveErr) {
    console.error('[morning_brief] DB save failed:', saveErr.message);
  }

  return fullBriefText;
}

export async function runMorningBriefLogged(targetDate) {
  return logProcess('MORNING_BRIEF', async () => {
    const result = await runMorningBrief(targetDate);
    return { count: result ? 1 : 0 };
  });
}

// Standalone
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const targetDate = process.argv[2] || null;
  runMorningBriefLogged(targetDate)
    .then(() => process.exit(0))
    .catch(err => { console.error(err); process.exit(1); });
}

export { runMorningBrief };
