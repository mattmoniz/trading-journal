import { query } from '../server/db.js';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

const REPORTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../reports');
const IB_BASELINE = { winRate: 0.875, sessions: 32 };
const OPEN_DRIVE_BASELINE = { winRate: 0.701, sessions: 167 };

function fmt$(n) {
  if (n == null) return 'N/A';
  if (n >= 0) return `+$${n.toFixed(2)}`;
  return `-$${Math.abs(n).toFixed(2)}`;
}
function pct(n, d) {
  if (!d) return 'N/A';
  return `${((n / d) * 100).toFixed(1)}%`;
}

function getMonthRange(monthYear) {
  // monthYear = 'YYYY-MM'
  const [y, m] = monthYear.split('-').map(Number);
  const start = `${monthYear}-01`;
  const lastDay = new Date(y, m, 0).getDate();
  const end = `${monthYear}-${String(lastDay).padStart(2, '0')}`;
  return { start, end };
}

async function getPnlSection(start, end) {
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
        SELECT custom_fields->>'account' AS account, exit_time,
          CASE WHEN custom_fields->'sierra_data'->>'Cumulative Profit/Loss (C)' ~ '^-?[0-9]+(\\.[0-9]+)?$'
            THEN (custom_fields->'sierra_data'->>'Cumulative Profit/Loss (C)')::numeric
            ELSE NULL END AS cum_pl
        FROM trades
        WHERE custom_fields->'sierra_data'->>'Exit DateTime' LIKE '% EP'
          AND log_date < $1 AND exit_time IS NOT NULL
      ) sub ORDER BY account, exit_time DESC
    ),
    daily_pnl AS (
      SELECT d.log_date, d.account,
        d.cum_pl - COALESCE(LAG(d.cum_pl) OVER (PARTITION BY d.account ORDER BY d.log_date),
          p.prev_cum_pl, 0) AS day_pnl
      FROM last_ep_per_day d LEFT JOIN prev_ep p ON p.account = d.account
    ),
    daily_total AS (SELECT log_date, SUM(day_pnl) AS total_pnl FROM daily_pnl GROUP BY log_date)
    SELECT log_date, total_pnl FROM daily_total ORDER BY log_date
  `, [start, end]);

  const days = res.rows;
  const totalPnl = days.reduce((s, r) => s + parseFloat(r.total_pnl || 0), 0);
  const winDays = days.filter(r => parseFloat(r.total_pnl) > 0).length;
  const best = days.reduce((b, r) => !b || parseFloat(r.total_pnl) > parseFloat(b.total_pnl) ? r : b, null);
  const worst = days.reduce((w, r) => !w || parseFloat(r.total_pnl) < parseFloat(w.total_pnl) ? r : w, null);
  const pnlValues = days.map(r => parseFloat(r.total_pnl));
  const avgPnl = days.length ? totalPnl / days.length : 0;
  const stddev = days.length > 1
    ? Math.sqrt(pnlValues.reduce((s, v) => s + Math.pow(v - avgPnl, 2), 0) / days.length)
    : 0;

  const lines = [
    `Trading days  : ${days.length}`,
    `Total P&L     : ${fmt$(totalPnl)}`,
    `Daily avg     : ${fmt$(avgPnl)}`,
    `Daily σ       : $${stddev.toFixed(2)}`,
    `Win days      : ${winDays} / ${days.length} (${pct(winDays, days.length)})`,
    best ? `Best day      : ${best.log_date}  ${fmt$(parseFloat(best.total_pnl))}` : '',
    worst && worst.log_date !== best?.log_date ? `Worst day     : ${worst.log_date}  ${fmt$(parseFloat(worst.total_pnl))}` : '',
  ].filter(Boolean);

  return { text: lines.join('\n'), days, totalPnl, winDays, totalDays: days.length };
}

async function getSetupSection(start, end) {
  const res = await query(`
    SELECT setup_type, COUNT(*) AS fired,
      SUM(CASE WHEN resolution='TARGET_HIT' THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN resolution='STOP_HIT' THEN 1 ELSE 0 END) AS losses,
      SUM(CASE WHEN resolution='TIME_EXPIRED' THEN 1 ELSE 0 END) AS expired,
      AVG(NULLIF(actual_pnl, 0)) AS avg_pnl,
      AVG(NULLIF(confluence_score_at_detection, 0)) AS avg_conf
    FROM active_setups WHERE trade_date BETWEEN $1 AND $2
    GROUP BY setup_type ORDER BY fired DESC
  `, [start, end]);

  if (!res.rows.length) return { text: 'No setups this month.', rows: [] };

  const lines = [];
  for (const r of res.rows) {
    const resolved = parseInt(r.wins) + parseInt(r.losses);
    const wr = resolved > 0 ? pct(parseInt(r.wins), resolved) : 'unresolved';
    const conf = r.avg_conf ? ` | avg conf: ${parseFloat(r.avg_conf).toFixed(1)}` : '';
    const avgPnlStr = r.avg_pnl ? ` | avg pnl: ${fmt$(parseFloat(r.avg_pnl))}` : '';
    lines.push(`${r.setup_type.padEnd(30)} fired: ${r.fired} | wins: ${r.wins} | losses: ${r.losses} | expired: ${r.expired} | wr: ${wr}${avgPnlStr}${conf}`);
  }

  return { text: lines.join('\n'), rows: res.rows };
}

async function getAcdSection(start, end) {
  const res = await query(`
    SELECT COUNT(*) AS days,
      SUM(CASE WHEN a_up_fired THEN 1 ELSE 0 END) AS a_up,
      SUM(CASE WHEN a_down_fired THEN 1 ELSE 0 END) AS a_down,
      SUM(CASE WHEN c_up_confirmed THEN 1 ELSE 0 END) AS c_up,
      SUM(CASE WHEN c_down_confirmed THEN 1 ELSE 0 END) AS c_down,
      SUM(COALESCE(daily_score, 0)) AS net_score,
      AVG(COALESCE(daily_score, 0)) AS avg_score,
      SUM(CASE WHEN day_type='Trend' THEN 1 ELSE 0 END) AS trend_days,
      SUM(CASE WHEN day_type='Normal' THEN 1 ELSE 0 END) AS normal_days,
      SUM(CASE WHEN day_type='Neutral' THEN 1 ELSE 0 END) AS neutral_days
    FROM acd_daily_log WHERE trade_date BETWEEN $1 AND $2
  `, [start, end]);

  const r = res.rows[0];
  if (!r || !parseInt(r.days)) return { text: 'No ACD data this month.' };

  const lines = [
    `Sessions      : ${r.days}`,
    `A Up fired    : ${r.a_up} | C confirmed: ${r.c_up} (${pct(parseInt(r.c_up), parseInt(r.a_up) || 1)})`,
    `A Down fired  : ${r.a_down} | C confirmed: ${r.c_down} (${pct(parseInt(r.c_down), parseInt(r.a_down) || 1)})`,
    `Net score     : ${parseInt(r.net_score) >= 0 ? '+' : ''}${r.net_score}  (avg ${parseFloat(r.avg_score).toFixed(2)}/session)`,
    `Day types     : Trend ${r.trend_days} / Normal ${r.normal_days} / Neutral ${r.neutral_days}`,
  ];

  return { text: lines.join('\n') };
}

async function getEdgeValidationSection(start, end) {
  // Confluence score buckets vs P&L outcome
  const res = await query(`
    SELECT
      CASE WHEN confluence_score_at_detection IS NULL THEN 'no_score'
           WHEN confluence_score_at_detection <= 2 THEN '0-2'
           WHEN confluence_score_at_detection <= 5 THEN '3-5'
           ELSE '6+' END AS bucket,
      COUNT(*) AS cnt,
      SUM(CASE WHEN resolution='TARGET_HIT' THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN resolution='STOP_HIT' THEN 1 ELSE 0 END) AS losses,
      AVG(NULLIF(actual_pnl, 0)) AS avg_pnl
    FROM active_setups
    WHERE trade_date BETWEEN $1 AND $2
      AND status != 'ACTIVE'
    GROUP BY bucket ORDER BY bucket
  `, [start, end]);

  if (!res.rows.length) return 'No resolved setups for edge validation.';

  const lines = ['Confluence bucket | Fired | W | L | Win% | Avg P&L'];
  lines.push('-'.repeat(60));
  for (const r of res.rows) {
    const wr = pct(parseInt(r.wins), parseInt(r.wins) + parseInt(r.losses));
    const avgPnl = r.avg_pnl ? fmt$(parseFloat(r.avg_pnl)) : 'N/A';
    lines.push(`${r.bucket.padEnd(18)}| ${String(r.cnt).padEnd(6)}| ${String(r.wins).padEnd(2)}| ${String(r.losses).padEnd(2)}| ${wr.padEnd(6)}| ${avgPnl}`);
  }

  return lines.join('\n');
}

async function getBacktestDriftSection(start, end) {
  // Compare live data against static baselines
  const res = await query(`
    SELECT setup_type,
      COUNT(*) FILTER (WHERE status != 'ACTIVE') AS resolved,
      SUM(CASE WHEN resolution='TARGET_HIT' THEN 1 ELSE 0 END) AS wins
    FROM active_setups
    WHERE trade_date BETWEEN $1 AND $2
    GROUP BY setup_type
  `, [start, end]);

  const lines = [];
  const MIN_SAMPLE = 5;

  for (const r of res.rows) {
    const n = parseInt(r.resolved || 0);
    if (n < MIN_SAMPLE) continue;
    const wins = parseInt(r.wins || 0);
    const liveWr = wins / n;

    let baseline = null;
    if (r.setup_type?.includes('IB')) baseline = IB_BASELINE;
    else if (r.setup_type?.includes('OPEN_DRIVE') || r.setup_type?.includes('OpenDrive')) baseline = OPEN_DRIVE_BASELINE;

    if (!baseline) continue;

    const drift = liveWr - baseline.winRate;
    const driftStr = `${drift >= 0 ? '+' : ''}${(drift * 100).toFixed(1)}pp`;
    const flag = Math.abs(drift) >= 0.10 ? ' ⚠ SIGNIFICANT DRIFT' : '';
    lines.push(`${r.setup_type.padEnd(30)} live: ${pct(wins, n)} (n=${n}) vs baseline ${(baseline.winRate * 100).toFixed(1)}% (n=${baseline.sessions}) | drift: ${driftStr}${flag}`);
  }

  if (!lines.length) return `Insufficient resolved setups (min ${MIN_SAMPLE}) for drift analysis this month.`;
  return lines.join('\n');
}

async function buildFlags(pnlData, setupData) {
  const flags = [];

  if (pnlData.totalPnl < 0) flags.push(`DOWN MONTH: Net ${fmt$(pnlData.totalPnl)}`);
  if (pnlData.totalDays >= 10 && pnlData.winDays / pnlData.totalDays < 0.45) {
    flags.push(`Win-day rate below 45%: ${pct(pnlData.winDays, pnlData.totalDays)}`);
  }

  // Setup expiry rate
  const totalFired = setupData.rows.reduce((s, r) => s + parseInt(r.fired), 0);
  const totalExpired = setupData.rows.reduce((s, r) => s + parseInt(r.expired), 0);
  if (totalFired >= 10 && totalExpired / totalFired > 0.5) {
    flags.push(`High setup expiry rate: ${totalExpired}/${totalFired} (${pct(totalExpired, totalFired)}) — entries may be too conservative`);
  }

  // Best setup type
  const bestSetup = setupData.rows.reduce((b, r) => {
    const resolved = parseInt(r.wins) + parseInt(r.losses);
    if (resolved < 3) return b;
    const wr = parseInt(r.wins) / resolved;
    return !b || wr > b.wr ? { type: r.setup_type, wr, n: resolved } : b;
  }, null);
  if (bestSetup && bestSetup.wr >= 0.7) {
    flags.push(`Top setup: ${bestSetup.type} at ${(bestSetup.wr * 100).toFixed(0)}% win rate (n=${bestSetup.n})`);
  }

  if (!flags.length) flags.push('No notable flags this month.');
  return flags.join('\n');
}

async function interpretReport(fullReport, monthYear) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const prompt = `You are a trading performance analyst reviewing a monthly report for an ACD methodology futures trader (NQ/ES). Month: ${monthYear}.\n\n${fullReport}\n\nProvide a 5-7 sentence analysis: summarize the month's edge consistency, identify the most important trend in the data (positive or negative), flag any setup or confluence patterns worth attention, and give two specific actionable adjustments for next month. Be direct and specific. No disclaimers.`;

  try {
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }],
    });
    return msg.content[0]?.text || '(no response)';
  } catch (err) {
    return `(Anthropic API error: ${err.message})`;
  }
}

export async function generateMonthlyReport(monthYear) {
  if (!monthYear) {
    const now = new Date();
    monthYear = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }
  const { start, end } = getMonthRange(monthYear);

  const [pnlData, setupData, acdData, edgeText, driftText] = await Promise.all([
    getPnlSection(start, end),
    getSetupSection(start, end),
    getAcdSection(start, end),
    getEdgeValidationSection(start, end),
    getBacktestDriftSection(start, end),
  ]);

  const flagsText = await buildFlags(pnlData, setupData);

  const sep = '='.repeat(60);
  const dash = '-'.repeat(40);

  // Build report without interpretation first (pass to AI)
  const reportBody = [
    `TRADING JOURNAL — MONTHLY REPORT`,
    `Month         : ${monthYear}  (${start} – ${end})`,
    `Generated     : ${new Date().toISOString()}`,
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
    'EDGE VALIDATION (confluence buckets)',
    dash,
    edgeText,
    '',
    'BACKTEST DRIFT',
    dash,
    driftText,
    '',
    'FLAGS (auto-detected)',
    dash,
    flagsText,
  ].join('\n');

  const interpretation = await interpretReport(reportBody, monthYear);

  return [
    reportBody,
    '',
    'INTERPRETATION (AI)',
    dash,
    interpretation,
    '',
    sep,
  ].join('\n');
}

export async function run(io) {
  const now = new Date();
  const monthYear = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  const report = await generateMonthlyReport(monthYear);

  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const filename = path.join(REPORTS_DIR, `monthly_${monthYear}.txt`);
  fs.writeFileSync(filename, report, 'utf8');
  console.log(`[monthly_report] Written: ${filename}`);

  if (io) io.emit('monthly-report-ready', { filename: `monthly_${monthYear}.txt`, monthYear });
  return { filename, monthYear };
}

// Standalone execution
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const monthYear = process.argv[2] || undefined;
  generateMonthlyReport(monthYear)
    .then(report => {
      const my = monthYear || (() => {
        const now = new Date();
        return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      })();
      fs.mkdirSync(REPORTS_DIR, { recursive: true });
      const filename = path.join(REPORTS_DIR, `monthly_${my}.txt`);
      fs.writeFileSync(filename, report, 'utf8');
      console.log(`Written: ${filename}`);
      console.log('\n' + report);
      process.exit(0);
    })
    .catch(err => { console.error(err); process.exit(1); });
}
