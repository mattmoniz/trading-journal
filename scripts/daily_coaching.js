import { query } from '../server/db.js';
import { logProcess } from '../server/lib/processLog.js';
import Anthropic from '@anthropic-ai/sdk';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

const LIVE_ACCOUNTS = [
  'LFE050-573N6QJT-TEST005',
  'LFE050-6S7UV87R-TEST007',
  'LFE050-CFB210Y9-TEST006',
  'LFE050-0J003ABA-TEST008',
  'LTF050-8QA00U6B-PRO009',
  'LTF050-MHF7U342-PRO007',
  'LTF050-OS753S7J-PRO008',
];
const LIVE_PLACEHOLDERS = LIVE_ACCOUNTS.map((_, i) => `$${i + 2}`).join(', ');

function fmt$(n) {
  if (n == null) return 'N/A';
  const abs = Math.abs(parseFloat(n));
  return (parseFloat(n) >= 0 ? '+$' : '-$') + abs.toFixed(2);
}

async function buildCoachingContext(targetDate) {
  const [tradesQ, acdQ, arQ, dplQ, setupsQ, missedQ, nl30Q] = await Promise.all([
    query(`
      SELECT entry_time, exit_time, pnl,
        custom_fields->>'max_open_profit' as mfe,
        custom_fields->>'max_open_loss' as mae,
        setup_type, direction, symbol, quantity
      FROM trades
      WHERE log_date = $1
        AND custom_fields->>'account' IN (${LIVE_PLACEHOLDERS})
      ORDER BY entry_time
    `, [targetDate, ...LIVE_ACCOUNTS]),

    query(`
      SELECT trade_date, day_type, daily_score, or_high, or_low,
        a_up_fired, a_down_fired, a_up_level, a_down_level,
        c_up_confirmed, c_down_confirmed, session_close
      FROM acd_daily_log WHERE trade_date = $1
    `, [targetDate]),

    query(`
      SELECT opening_call_type, a_signal_override
      FROM auction_reads WHERE trade_date = $1
    `, [targetDate]),

    query(`
      SELECT structural_state, confluence_score_pre, confluence_score_peak,
        nl30_at_open
      FROM daily_performance_log WHERE trade_date = $1
    `, [targetDate]),

    query(`
      SELECT setup_type, status, resolution, fired_at::text,
        t1_level, entry_zone_low, entry_zone_high, stop_level,
        historical_win_rate
      FROM active_setups WHERE trade_date = $1
      ORDER BY fired_at
    `, [targetDate]),

    query(`
      SELECT MAX((custom_fields->>'max_open_profit')::numeric) as largest_missed
      FROM trades
      WHERE log_date = $1
        AND pnl < 0
        AND custom_fields->>'account' IN (${LIVE_PLACEHOLDERS})
        AND (custom_fields->>'max_open_profit') ~ '^[0-9]+(\\.[0-9]+)?$'
        AND (custom_fields->>'max_open_profit')::numeric > 0
    `, [targetDate, ...LIVE_ACCOUNTS]),

    query(`
      SELECT SUM(daily_score) FILTER (
        WHERE trade_date > (CURRENT_DATE - INTERVAL '30 days')
          AND trade_date <= CURRENT_DATE
      ) as nl30
      FROM acd_daily_log WHERE daily_score IS NOT NULL
    `),
  ]);

  const trades = tradesQ.rows;
  const acd = acdQ.rows[0] || {};
  const ar = arQ.rows[0] || {};
  const dpl = dplQ.rows[0] || {};
  const setups = setupsQ.rows;
  const largestMissed = parseFloat(missedQ.rows[0]?.largest_missed) || 0;
  const nl30 = parseInt(nl30Q.rows[0]?.nl30) || 0;

  // Session P&L from FlatToFlat EP fills
  const winners = trades.filter(t => parseFloat(t.pnl) > 0).length;
  const losers  = trades.filter(t => parseFloat(t.pnl) < 0).length;
  const sessionPnl = trades.reduce((s, t) => s + (parseFloat(t.pnl) || 0), 0);

  const openingCall = ar.opening_call_type || 'NO_SIGNAL';
  const aSignal = ar.a_signal_override || 'NO_SIGNAL';
  const structuralState = dpl.structural_state || 'BRACKET';
  const confluenceScore = dpl.confluence_score_pre || dpl.confluence_score_peak || 0;

  const tradesSummary = trades.length === 0
    ? 'No trades recorded for live accounts.'
    : trades.map(t =>
        `  ${t.symbol} ${t.direction} ×${t.quantity} | P&L: ${fmt$(t.pnl)}` +
        (t.mfe && parseFloat(t.mfe) > 0 ? ` | MFE: +$${parseFloat(t.mfe).toFixed(0)}` : '') +
        (t.setup_type ? ` | Setup: ${t.setup_type}` : '')
      ).join('\n');

  const setupsSummary = setups.length === 0
    ? 'None detected.'
    : setups.map(s =>
        `  ${s.setup_type} — ${s.status}${s.resolution ? '/' + s.resolution : ''}` +
        (s.historical_win_rate != null ? ` (hist win rate: ${(parseFloat(s.historical_win_rate)*100).toFixed(0)}%)` : '')
      ).join('\n');

  const orRange = (acd.or_high && acd.or_low)
    ? `OR ${parseFloat(acd.or_low).toFixed(2)}–${parseFloat(acd.or_high).toFixed(2)} (${(parseFloat(acd.or_high) - parseFloat(acd.or_low)).toFixed(2)} pts)`
    : 'OR unavailable';

  return {
    targetDate,
    trades,
    totalTrades: trades.length,
    winners,
    losers,
    sessionPnl,
    largestMissed,
    structuralState,
    nl30,
    openingCall,
    aSignal,
    confluenceScore,
    orRange,
    aUpFired: acd.a_up_fired,
    aDownFired: acd.a_down_fired,
    dayType: acd.day_type || 'N/A',
    tradesSummary,
    setupsSummary,
    rawContext: { acd, ar, dpl, setups, nl30 },
  };
}

function buildPrompt(ctx) {
  const noTrades = ctx.trades.length === 0;

  return `You are reviewing a day of NQ/MNQ futures trading for a prop firm evaluation trader. Trading window 9:30–11:00 AM ET. 1–3 contracts based on conviction.

DATE: ${ctx.targetDate}

SESSION CONTEXT:
Structural state: ${ctx.structuralState}
NL30: ${ctx.nl30}
Day type: ${ctx.dayType}
Opening call: ${ctx.openingCall}
A signal: ${ctx.aSignal}
A Up fired: ${ctx.aUpFired ? 'YES' : 'NO'} | A Down fired: ${ctx.aDownFired ? 'YES' : 'NO'}
${ctx.orRange}
Confluence score: ${ctx.confluenceScore}/12

DATA STATUS: ${ctx.importNote}

SETUPS DETECTED:
${ctx.setupsSummary}

${noTrades ? 'NO TRADES: Live accounts had no recorded fills for this session.\n' : `TRADES:
${ctx.tradesSummary}

SESSION RESULT:
Total fills: ${ctx.totalTrades}
Winners: ${ctx.winners} | Losers: ${ctx.losers}
Session P&L: ${fmt$(ctx.sessionPnl)}
Largest profit seen on a losing trade: ${ctx.largestMissed > 0 ? '+$' + ctx.largestMissed.toFixed(0) : 'none'}
`}
Provide coaching in exactly this format:

WHAT HAPPENED:
[2–3 sentences on today's price action and structural context. Specific prices.]

WHAT WORKED:
[Specific correct decisions. If no trades or no positives: "No clear positives today."]

WHAT TO IMPROVE:
[Single most important thing. Direct. Reference actual numbers from today.]

TOMORROW'S WATCH:
[One specific level or condition to watch based on today's close and structure.]

Under 200 words. No generic advice.`;
}

export async function runDailyCoaching(targetDate, io) {
  if (!targetDate) {
    const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    targetDate = nowET.toISOString().slice(0, 10);
  }

  console.log(`[daily_coaching] Running for ${targetDate}`);

  // Check whether today's 4 PM auto-import ran
  let importNote = 'No auto-import record found — trade data may be incomplete.';
  try {
    const importCheck = await query(`
      SELECT imported, skipped, file_used, import_time
      FROM import_log
      WHERE import_time::date = $1 AND trigger = 'AUTO_4PM'
      ORDER BY import_time DESC LIMIT 1
    `, [targetDate]);
    if (importCheck.rows.length > 0) {
      const r = importCheck.rows[0];
      importNote = `Auto-import ran at ${new Date(r.import_time).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' })} ET — ${r.imported} new fills added from ${r.file_used}.`;
    }
  } catch (_) {}

  let ctx;
  try {
    ctx = await buildCoachingContext(targetDate);
    ctx.importNote = importNote;
  } catch (err) {
    console.error('[daily_coaching] Context build failed:', err.message);
    return;
  }

  let coachingText;
  try {
    const client = new Anthropic();
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      messages: [{ role: 'user', content: buildPrompt(ctx) }],
    });
    coachingText = response.content[0].text;
    console.log(`[daily_coaching] Generated ${coachingText.length} chars for ${targetDate}`);
  } catch (err) {
    console.error('[daily_coaching] API error:', err.message);
    coachingText = 'Review unavailable for this session.';
  }

  try {
    await query(`
      INSERT INTO daily_coaching
        (session_date, trades_count, session_pnl, largest_missed_profit, raw_context, coaching_text)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (session_date) DO UPDATE SET
        trades_count = EXCLUDED.trades_count,
        session_pnl = EXCLUDED.session_pnl,
        largest_missed_profit = EXCLUDED.largest_missed_profit,
        coaching_text = EXCLUDED.coaching_text,
        raw_context = EXCLUDED.raw_context,
        created_at = NOW()
    `, [
      targetDate,
      ctx.totalTrades,
      ctx.sessionPnl,
      ctx.largestMissed || null,
      JSON.stringify(ctx.rawContext),
      coachingText,
    ]);
    console.log(`[daily_coaching] Saved to DB for ${targetDate}`);
  } catch (err) {
    console.error('[daily_coaching] DB upsert failed:', err.message);
  }

  if (io) io.emit('coaching-ready', { date: targetDate });
  return coachingText;
}

// Standalone execution
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const targetDate = process.argv[2] || null;
  logProcess('DAILY_COACHING', async () => {
    const text = await runDailyCoaching(targetDate);
    if (text) { console.log('\n--- COACHING TEXT ---\n'); console.log(text); }
    return { count: text ? 1 : 0 };
  })
    .then(() => process.exit(0))
    .catch(err => { console.error(err); process.exit(1); });
}
