import { query } from '../server/db.js';
import { logProcess } from '../server/lib/processLog.js';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

const REPORTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../reports');

function fmt$(n) {
  if (n == null) return 'N/A';
  if (n >= 0) return `+$${n.toFixed(2)}`;
  return `-$${Math.abs(n).toFixed(2)}`;
}

function pct(n, d) {
  if (!d) return 'N/A';
  return `${((n / d) * 100).toFixed(0)}%`;
}

async function getWeekRange(endDate) {
  // endDate = Sunday; startDate = Monday 6 days prior
  const end = new Date(endDate + 'T23:59:59Z');
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 6);
  return {
    start: start.toISOString().slice(0, 10),
    end: endDate,
  };
}

async function getPnlSection(start, end) {
  // CumPL diff method per account per day, then sum.
  // Also detect accounts whose first-day diff uses 0 as baseline (prev_ep missing).
  const res = await query(`
    WITH ep_fills AS (
      SELECT log_date,
        custom_fields->>'account' AS account,
        exit_time,
        CASE WHEN custom_fields->'sierra_data'->>'Cumulative Profit/Loss (C)' ~ '^-?[0-9]+(\\.[0-9]+)?$'
          THEN (custom_fields->'sierra_data'->>'Cumulative Profit/Loss (C)')::numeric
          ELSE NULL END AS cum_pl
      FROM trades
      WHERE custom_fields->'sierra_data'->>'Exit DateTime' LIKE '% EP'
        AND exit_time IS NOT NULL
        AND log_date BETWEEN $1 AND $2
    ),
    last_ep_per_day AS (
      SELECT DISTINCT ON (log_date, account) log_date, account, cum_pl
      FROM ep_fills ORDER BY log_date, account, exit_time DESC
    ),
    prev_ep AS (
      SELECT DISTINCT ON (account) account, cum_pl AS prev_cum_pl
      FROM (
        SELECT custom_fields->>'account' AS account,
          exit_time,
          CASE WHEN custom_fields->'sierra_data'->>'Cumulative Profit/Loss (C)' ~ '^-?[0-9]+(\\.[0-9]+)?$'
            THEN (custom_fields->'sierra_data'->>'Cumulative Profit/Loss (C)')::numeric
            ELSE NULL END AS cum_pl
        FROM trades
        WHERE custom_fields->'sierra_data'->>'Exit DateTime' LIKE '% EP'
          AND log_date < $1
          AND exit_time IS NOT NULL
      ) sub ORDER BY account, exit_time DESC
    ),
    daily_pnl AS (
      SELECT d.log_date, d.account,
        d.cum_pl - COALESCE(LAG(d.cum_pl) OVER (PARTITION BY d.account ORDER BY d.log_date),
          p.prev_cum_pl, 0) AS day_pnl,
        (p.prev_cum_pl IS NULL AND LAG(d.cum_pl) OVER (PARTITION BY d.account ORDER BY d.log_date) IS NULL) AS baseline_missing
      FROM last_ep_per_day d
      LEFT JOIN prev_ep p ON p.account = d.account
    ),
    daily_total AS (
      SELECT log_date, SUM(day_pnl) AS total_pnl,
        bool_or(baseline_missing) AS any_baseline_missing
      FROM daily_pnl GROUP BY log_date
    )
    SELECT log_date, total_pnl, any_baseline_missing FROM daily_total ORDER BY log_date
  `, [start, end]);

  const days = res.rows;
  const hasBaselineMissing = days.some(r => r.any_baseline_missing);
  // Exclude days with missing baselines from aggregate stats to avoid misleading totals
  const reliableDays = days.filter(r => !r.any_baseline_missing);
  const totalPnl = reliableDays.reduce((s, r) => s + parseFloat(r.total_pnl || 0), 0);
  const winDays = reliableDays.filter(r => parseFloat(r.total_pnl) > 0);
  const best = reliableDays.reduce((b, r) => parseFloat(r.total_pnl) > parseFloat(b?.total_pnl || -Infinity) ? r : b, null);
  const worst = reliableDays.reduce((w, r) => parseFloat(r.total_pnl) < parseFloat(w?.total_pnl || Infinity) ? r : w, null);

  let lines = [];
  if (hasBaselineMissing) {
    lines.push(`⚠ BASELINE MISSING — re-import needed for accurate P&L`);
    lines.push(`  (First-day CumPL diff uses 0 as prior balance; days marked * are unreliable)`);
    lines.push('');
  }
  lines.push(
    `Trading days  : ${days.length}`,
    reliableDays.length < days.length
      ? `Total P&L     : ${reliableDays.length ? fmt$(totalPnl) : 'N/A'} (${reliableDays.length}/${days.length} days reliable)`
      : `Total P&L     : ${fmt$(totalPnl)}`,
    `Daily avg     : ${reliableDays.length ? fmt$(totalPnl / reliableDays.length) : 'N/A'}`,
    `Win days      : ${winDays.length} / ${reliableDays.length || days.length} (${pct(winDays.length, reliableDays.length || days.length)})`,
  );
  if (best) lines.push(`Best day      : ${best.log_date}  ${fmt$(parseFloat(best.total_pnl))}`);
  if (worst && worst.log_date !== best?.log_date) lines.push(`Worst day     : ${worst.log_date}  ${fmt$(parseFloat(worst.total_pnl))}`);

  // Day-by-day detail
  lines.push('');
  for (const d of days) {
    const p = parseFloat(d.total_pnl);
    const flag = d.any_baseline_missing ? ' *' : '';
    lines.push(`  ${d.log_date}  ${fmt$(p)}${flag}`);
  }

  return {
    text: lines.join('\n'), days: reliableDays, totalPnl,
    winDays: winDays.length, totalDays: days.length, hasBaselineMissing,
    tradingDays: reliableDays.length,
    winningDays: winDays.length,
    bestDayPnl: best ? parseFloat(best.total_pnl) : null,
    worstDayPnl: worst ? parseFloat(worst.total_pnl) : null,
    totalTrades: 0, // filled in below via separate count if needed
  };
}

async function getSetupSection(start, end) {
  const res = await query(`
    SELECT setup_type, status, resolution, COUNT(*) AS cnt,
      SUM(CASE WHEN resolution='TARGET_HIT' THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN resolution='STOP_HIT' THEN 1 ELSE 0 END) AS losses,
      SUM(CASE WHEN resolution='TIME_EXPIRED' THEN 1 ELSE 0 END) AS expired,
      AVG(CASE WHEN actual_pnl IS NOT NULL THEN actual_pnl ELSE NULL END) AS avg_pnl
    FROM active_setups
    WHERE trade_date BETWEEN $1 AND $2
    GROUP BY setup_type, status, resolution
    ORDER BY setup_type
  `, [start, end]);

  // Aggregate by setup_type
  const byType = {};
  for (const r of res.rows) {
    if (!byType[r.setup_type]) byType[r.setup_type] = { fired: 0, wins: 0, losses: 0, expired: 0, pnlSum: 0, pnlCount: 0 };
    const t = byType[r.setup_type];
    t.fired += parseInt(r.cnt);
    t.wins += parseInt(r.wins);
    t.losses += parseInt(r.losses);
    t.expired += parseInt(r.expired);
    if (r.avg_pnl != null) { t.pnlSum += parseFloat(r.avg_pnl) * parseInt(r.cnt); t.pnlCount += parseInt(r.cnt); }
  }

  if (!Object.keys(byType).length) return { text: 'No setups fired this week.', totalFired: 0, totalWins: 0 };

  const lines = [];
  let totalFired = 0, totalWins = 0;
  for (const [type, t] of Object.entries(byType)) {
    const resolved = t.wins + t.losses;
    const wr = resolved > 0 ? pct(t.wins, resolved) : 'unresolved';
    const avgPnlStr = t.pnlCount > 0 ? ` | avg ${fmt$(t.pnlSum / t.pnlCount)}` : '';
    lines.push(`${type.padEnd(30)} fired: ${t.fired} | wins: ${t.wins} | losses: ${t.losses} | expired: ${t.expired} | wr: ${wr}${avgPnlStr}`);
    totalFired += t.fired;
    totalWins += t.wins;
  }

  return { text: lines.join('\n'), totalFired, totalWins };
}

async function getAcdSection(start, end) {
  const res = await query(`
    SELECT trade_date, a_up_fired, a_down_fired, c_up_confirmed, c_down_confirmed, daily_score, day_type
    FROM acd_daily_log
    WHERE trade_date BETWEEN $1 AND $2
    ORDER BY trade_date
  `, [start, end]);

  if (!res.rows.length) return { text: 'No ACD data this week.', flags: [] };

  const rows = res.rows;
  const aUpDays = rows.filter(r => r.a_up_fired).length;
  const aDownDays = rows.filter(r => r.a_down_fired).length;
  const cUpDays = rows.filter(r => r.c_up_confirmed).length;
  const cDownDays = rows.filter(r => r.c_down_confirmed).length;
  const netScore = rows.reduce((s, r) => s + (parseInt(r.daily_score) || 0), 0);

  const dayTypeCounts = {};
  for (const r of rows) {
    const t = r.day_type || 'Unknown';
    dayTypeCounts[t] = (dayTypeCounts[t] || 0) + 1;
  }

  const lines = [
    `A Up fired    : ${aUpDays} day(s) | C confirm: ${cUpDays} (${pct(cUpDays, aUpDays || 1)})`,
    `A Down fired  : ${aDownDays} day(s) | C confirm: ${cDownDays} (${pct(cDownDays, aDownDays || 1)})`,
    `Net score Δ   : ${netScore >= 0 ? '+' : ''}${netScore}`,
    `Day types     : ${Object.entries(dayTypeCounts).map(([k, v]) => `${k}: ${v}`).join(', ')}`,
  ];

  // Per-day detail
  lines.push('');
  for (const r of rows) {
    const score = parseInt(r.daily_score) || 0;
    const signals = [
      r.a_up_fired ? 'A↑' : null,
      r.a_down_fired ? 'A↓' : null,
      r.c_up_confirmed ? 'C↑' : null,
      r.c_down_confirmed ? 'C↓' : null,
    ].filter(Boolean).join(' ');
    lines.push(`  ${r.trade_date}  score: ${score >= 0 ? '+' : ''}${score}  ${signals || 'no signals'}  [${r.day_type || '?'}]`);
  }

  const flags = [];
  // Flag if C rate is very low
  const totalA = aUpDays + aDownDays;
  const totalC = cUpDays + cDownDays;
  if (totalA >= 3 && totalC / totalA < 0.33) {
    flags.push(`Low C confirmation rate: ${totalC}/${totalA} A signals confirmed (${pct(totalC, totalA)})`);
  }

  return { text: lines.join('\n'), flags };
}

async function getTradeQualitySection(start, end) {
  const res = await query(`
    SELECT setup_type,
      COUNT(*) AS cnt,
      AVG(NULLIF(risk_reward_ratio, 0)) AS avg_rr,
      SUM(pnl) AS sum_pnl,
      SUM(COALESCE(fees, 0)) AS total_fees,
      SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS wins
    FROM trades
    WHERE log_date BETWEEN $1 AND $2
    GROUP BY setup_type
    ORDER BY cnt DESC
  `, [start, end]);

  if (!res.rows.length) return { text: 'No trade data this week.', flags: [] };

  const totalTrades = res.rows.reduce((s, r) => s + parseInt(r.cnt), 0);
  const totalFees = res.rows.reduce((s, r) => s + parseFloat(r.total_fees || 0), 0);
  const avgRR = res.rows.reduce((s, r) => s + parseFloat(r.avg_rr || 0) * parseInt(r.cnt), 0) / (totalTrades || 1);

  const rrDisplay = avgRR > 0
    ? avgRR.toFixed(2)
    : 'not calculated (stop_loss not set on auto-imported trades)';

  const lines = [
    `Total fills   : ${totalTrades}`,
    `Avg R:R       : ${rrDisplay}`,
    `Commissions   : $${totalFees.toFixed(2)}`,
    '',
    'By setup type:',
  ];

  for (const r of res.rows) {
    const wr = pct(parseInt(r.wins), parseInt(r.cnt));
    const avgPnl = parseInt(r.cnt) ? fmt$(parseFloat(r.sum_pnl) / parseInt(r.cnt)) : 'N/A';
    lines.push(`  ${(r.setup_type || 'untagged').padEnd(25)}  fills: ${String(r.cnt).padStart(3)} | wr: ${wr} | avg fill pnl: ${avgPnl}`);
  }

  const flags = [];
  if (totalFees > 500) flags.push(`High commissions this week: $${totalFees.toFixed(2)}`);

  return { text: lines.join('\n'), flags };
}

async function buildFlags(pnlData, setupData, acdData, qualityData) {
  const flags = [];

  // Losing week
  if (pnlData.totalPnl < 0) {
    flags.push(`DOWN WEEK: Net ${fmt$(pnlData.totalPnl)} on ${pnlData.totalDays} trading day(s)`);
  }

  // Win rate below 40%
  if (pnlData.totalDays >= 3 && pnlData.winDays / pnlData.totalDays < 0.4) {
    flags.push(`Low win-day rate: ${pnlData.winDays}/${pnlData.totalDays} (${pct(pnlData.winDays, pnlData.totalDays)})`);
  }

  // Setup expiry rate > 50%
  if (setupData.totalFired >= 4) {
    const expiredRes = await query(
      `SELECT COUNT(*) AS cnt FROM active_setups WHERE trade_date BETWEEN (NOW() AT TIME ZONE 'America/New_York')::date - 6 AND (NOW() AT TIME ZONE 'America/New_York')::date AND resolution='TIME_EXPIRED'`
    );
    const expired = parseInt(expiredRes.rows[0]?.cnt || 0);
    if (expired / setupData.totalFired > 0.5) {
      flags.push(`High setup expiry rate: ${expired}/${setupData.totalFired} setups expired without resolution`);
    }
  }

  // Absorb section-level flags
  flags.push(...acdData.flags, ...qualityData.flags);

  if (!flags.length) flags.push('No notable flags this week.');
  return flags.join('\n');
}

async function interpretFlags(flagsText, weekEnd) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const prompt = `You are a trading performance analyst reviewing weekly flags for an ACD methodology futures trader (NQ/ES). The week ending ${weekEnd} produced these flags:\n\n${flagsText}\n\nIn 3-5 sentences, provide a concise interpretation: what the flags suggest about trading behavior or market conditions, and one specific actionable adjustment for next week. Be direct, no disclaimers.`;

  try {
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    });
    return msg.content[0]?.text || '(no response)';
  } catch (err) {
    return `(Anthropic API error: ${err.message})`;
  }
}

async function generateWeeklyAssessment(start, end, weekEnd, pnlData, setupData) {
  // Pull daily coaching records for the week to extract improvement themes
  const coachingQ = await query(`
    SELECT session_date::text, coaching_text, session_pnl, trades_count
    FROM daily_coaching
    WHERE session_date >= $1 AND session_date <= $2
    ORDER BY session_date
  `, [start, end]).catch(() => ({ rows: [] }));

  const coachingRows = coachingQ.rows;
  const tradingDays = pnlData.tradingDays ?? 0;
  const winningDays = pnlData.winningDays ?? 0;
  const totalPnl    = pnlData.totalPnl    ?? 0;
  const bestDayPnl  = pnlData.bestDayPnl  ?? null;
  const worstDayPnl = pnlData.worstDayPnl ?? null;
  const totalTrades = pnlData.totalTrades  ?? 0;

  // Extract WHAT TO IMPROVE sections from each day's coaching_text
  const dailyImprovements = coachingRows
    .map(r => {
      const match = r.coaching_text?.match(/WHAT TO IMPROVE:\s*([\s\S]*?)(?=\n[A-Z]|$)/i);
      return match ? `  ${r.session_date}: ${match[1].trim()}` : null;
    })
    .filter(Boolean)
    .join('\n');

  const weeklyPrompt = `You are providing a weekly assessment for a NQ/MNQ futures prop firm trader.

WEEK: ${start} to ${end}

PERFORMANCE:
Trading days: ${tradingDays}
Winning days: ${winningDays} | Losing days: ${tradingDays - winningDays}
Total P&L: ${totalPnl >= 0 ? '+$' : '-$'}${Math.abs(totalPnl).toFixed(2)}
Best day: ${bestDayPnl != null ? (bestDayPnl >= 0 ? '+$' : '-$') + Math.abs(bestDayPnl).toFixed(2) : 'N/A'}
Worst day: ${worstDayPnl != null ? (worstDayPnl >= 0 ? '+$' : '-$') + Math.abs(worstDayPnl).toFixed(2) : 'N/A'}
Total trades: ${totalTrades}

DAILY IMPROVEMENT THEMES:
${dailyImprovements || '  (No daily coaching records for this week)'}

Provide weekly assessment in this format:

WEEK SUMMARY:
[2–3 sentences. Reference P&L numbers.]

STRONGEST MOMENT:
[Best decision of the week. Specific. If no data: "Insufficient trade data."]

BIGGEST LEAK:
[Most repeated mistake. How many times? What did it cost?]

PROCESS GRADE: [A/B/C/D/F]
[One sentence explanation. Based on process quality not just P&L.]

FOCUS FOR NEXT WEEK:
[One specific measurable improvement.]

Under 250 words. Direct. Specific numbers.`;

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  let assessmentText;
  try {
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      messages: [{ role: 'user', content: weeklyPrompt }],
    });
    assessmentText = msg.content[0]?.text || '(no response)';
  } catch (err) {
    assessmentText = `(Anthropic API error: ${err.message})`;
  }

  // Parse process grade
  const gradeMatch = assessmentText.match(/PROCESS GRADE:\s*([A-F][+-]?)/);
  const processGrade = gradeMatch ? gradeMatch[1] : null;

  // Upsert to weekly_assessments
  try {
    await query(`
      INSERT INTO weekly_assessments
        (week_start, week_end, total_trades, winning_days, losing_days,
         total_pnl, best_day_pnl, worst_day_pnl, avg_daily_pnl,
         setups_fired, coaching_themes, assessment_text, process_grade,
         days_with_trades)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      ON CONFLICT (week_start) DO UPDATE SET
        week_end = EXCLUDED.week_end,
        total_trades = EXCLUDED.total_trades,
        winning_days = EXCLUDED.winning_days,
        losing_days = EXCLUDED.losing_days,
        total_pnl = EXCLUDED.total_pnl,
        best_day_pnl = EXCLUDED.best_day_pnl,
        worst_day_pnl = EXCLUDED.worst_day_pnl,
        avg_daily_pnl = EXCLUDED.avg_daily_pnl,
        setups_fired = EXCLUDED.setups_fired,
        coaching_themes = EXCLUDED.coaching_themes,
        assessment_text = EXCLUDED.assessment_text,
        process_grade = EXCLUDED.process_grade,
        days_with_trades = EXCLUDED.days_with_trades,
        created_at = NOW()
    `, [
      start, end,
      totalTrades,
      winningDays,
      tradingDays - winningDays,
      totalPnl,
      bestDayPnl,
      worstDayPnl,
      tradingDays > 0 ? totalPnl / tradingDays : null,
      setupData.totalSetups ?? null,
      dailyImprovements || null,
      assessmentText,
      processGrade,
      tradingDays,
    ]);
    console.log(`[weekly_assessment] Saved for week ${start} — grade: ${processGrade || 'N/A'}`);
  } catch (err) {
    console.error('[weekly_assessment] DB upsert failed:', err.message);
  }

  return { assessmentText, processGrade };
}

export async function generateWeeklyReport(weekEnd) {
  // weekEnd defaults to last Sunday (or today if Sunday)
  if (!weekEnd) {
    const now = new Date();
    const day = now.getUTCDay(); // 0=Sun
    const offset = day === 0 ? 0 : day;
    const sunday = new Date(now);
    sunday.setUTCDate(sunday.getUTCDate() - offset);
    weekEnd = sunday.toISOString().slice(0, 10);
  }
  const { start, end } = await getWeekRange(weekEnd);

  const [pnlData, setupData, acdData, qualityData] = await Promise.all([
    getPnlSection(start, end),
    getSetupSection(start, end),
    getAcdSection(start, end),
    getTradeQualitySection(start, end),
  ]);

  const flagsText = await buildFlags(pnlData, setupData, acdData, qualityData);
  const [interpretation, weeklyAssessment] = await Promise.all([
    interpretFlags(flagsText, weekEnd),
    generateWeeklyAssessment(start, end, weekEnd, pnlData, setupData),
  ]);

  const sep = '='.repeat(60);
  const dash = '-'.repeat(40);

  return [
    `TRADING JOURNAL — WEEKLY REPORT`,
    `Week ending : ${weekEnd}  (${start} – ${end})`,
    `Generated   : ${new Date().toISOString()}`,
    sep,
    '',
    'PERFORMANCE SUMMARY',
    dash,
    pnlData.text,
    '',
    'SETUP STATISTICS',
    dash,
    setupData.text,
    '',
    'ACD SIGNAL ACCURACY',
    dash,
    acdData.text,
    '',
    'TRADE QUALITY',
    dash,
    qualityData.text,
    '',
    'FLAGS (auto-detected)',
    dash,
    flagsText,
    '',
    'INTERPRETATION (AI)',
    dash,
    interpretation,
    '',
    'WEEKLY ASSESSMENT',
    dash,
    `Process Grade : ${weeklyAssessment.processGrade || 'N/A'}`,
    '',
    weeklyAssessment.assessmentText,
    '',
    sep,
  ].join('\n');
}

export async function runWeeklyReport(io) {
  const now = new Date();
  const day = now.getUTCDay();
  const offset = day === 0 ? 0 : day;
  const sunday = new Date(now);
  sunday.setUTCDate(sunday.getUTCDate() - offset);
  const weekEnd = sunday.toISOString().slice(0, 10);

  // Log WEEKLY_ASSESSMENT separately (it runs inside generateWeeklyReport)
  await logProcess('WEEKLY_ASSESSMENT', async () => {
    const report = await generateWeeklyReport(weekEnd);
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
    const filename = path.join(REPORTS_DIR, `weekly_${weekEnd}.txt`);
    fs.writeFileSync(filename, report, 'utf8');
    console.log(`[weekly_report] Written: ${filename}`);
    try {
      await query(`UPDATE weekly_assessments SET report_text = $1 WHERE week_end = $2`, [report, weekEnd]);
    } catch (err) { console.error('[weekly_report] report_text save failed:', err.message); }
    if (io) io.emit('weekly-report-ready', { filename: `weekly_${weekEnd}.txt`, weekEnd });
    return { count: 1, weekEnd };
  });

  return { filename: `weekly_${weekEnd}.txt`, weekEnd };
}

// Standalone execution
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const weekEnd = process.argv[2] || undefined;
  logProcess('WEEKLY_REPORT', async () => {
    const report = await generateWeeklyReport(weekEnd);
    const wEnd = weekEnd || (() => {
      const now = new Date(); const d = now.getUTCDay();
      const s = new Date(now); s.setUTCDate(s.getUTCDate() - (d === 0 ? 0 : d));
      return s.toISOString().slice(0, 10);
    })();
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
    const filename = path.join(REPORTS_DIR, `weekly_${wEnd}.txt`);
    fs.writeFileSync(filename, report, 'utf8');
    console.log(`Written: ${filename}`);
    console.log('\n' + report);
    try { await query(`UPDATE weekly_assessments SET report_text = $1 WHERE week_end = $2`, [report, wEnd]); } catch (_) {}
    return { count: 1, weekEnd: wEnd };
  })
    .then(() => process.exit(0))
    .catch(err => { console.error(err); process.exit(1); });
}
