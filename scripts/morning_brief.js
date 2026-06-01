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

  const [acdQ, prevAcdQ, dplQ, arQ, nl30Q, setupsQ, coachingQ, acdMonthlyQ, importLogQ, gLineQ, gLineWeekQ] = await Promise.all([
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
    `  Confluence    : ${confluenceScore}/12`,
    `  Opening call  : ${openingCall}`,
    `  A signal      : ${aSignal}`,
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

    const prompt = `You are reviewing pre-market context for a NQ futures prop firm trader using ACD methodology. Trading window 9:30–11:00 AM ET. Max 3 contracts.

DATE: ${targetDate}
Structural state: ${structState} | NL30: ${nl30} (${nl30Label}) | NL10: ${nl10}
OR: ${orRange} | A Up: ${aUpLevel} (fired: ${today.a_up_fired ? 'yes' : 'no'}) | A Down: ${aDownLevel} (fired: ${today.a_down_fired ? 'yes' : 'no'})
Confluence: ${confluenceScore}/12 | Opening call: ${openingCall} | A signal: ${aSignal}
G-LINE (weekly open): ${gLine ? fmtPrice(gLine) : 'N/A'}
Days held ${gLineDirection} this week: ${gLineDaysHeld} | Today opens ${gLineAboveBelow} G-Line by ${gLinePts} pts
Active setups: ${setups.length > 0 ? setups.map(s => s.setup_type).join(', ') : 'none'}
Prior session watch: ${tomorrowWatch}
${evalPromptLines ? '\n' + evalPromptLines : ''}

In 2–3 sentences: what is the key structural decision for today's session? Name the specific price(s) that confirm or deny a trade. Reference the G-Line if it is within 30 pts of a key level — "Week is [positive/negative] — price has held [above/below] the weekly open for [N] consecutive sessions." State the bias direction if one exists, or call it a no-trade day if conditions don't qualify. If account status shows an eval trailing behind, note whether today's setup quality justifies pressing for size. No generic advice.`;

    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 150,
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
