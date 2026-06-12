import { query } from '../server/db.js';
import { logProcess } from '../server/lib/processLog.js';
import { classifyOpeningType, classifyDayType } from '../server/services/caseEngine.js';
import { getAllHitRates, formatHitRate, formatLevelTouchRate, formatComboRate } from '../server/services/engineReadHitRates.js';
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

const DLL_THRESHOLD = -250;

async function buildCoachingContext(targetDate) {
  const [
    tradesQ, acdQ, arQ, dplQ, setupsQ, missedQ, nl30Q,
    accountSummaryQ, accountCurveQ,
    annotationsQ, todayReadsQ, allHitRates,
  ] = await Promise.all([
    query(`
      SELECT
        id,
        entry_time AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York' as entry_time,
        exit_time AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York' as exit_time,
        pnl,
        custom_fields->>'max_open_profit' as mfe,
        custom_fields->>'max_open_loss' as mae,
        custom_fields->>'account' as account,
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

    // Per-account totals
    query(`
      SELECT
        custom_fields->>'account' as account,
        COUNT(*) as fills,
        (MIN(entry_time) AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::time as first_trade,
        (MAX(entry_time) AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::time as last_trade,
        ROUND(SUM(pnl)::numeric, 2) as net_pnl,
        ROUND(SUM(pnl) FILTER (WHERE pnl > 0)::numeric, 2) as gross_wins,
        ROUND(SUM(pnl) FILTER (WHERE pnl < 0)::numeric, 2) as gross_losses
      FROM trades
      WHERE log_date = $1
        AND custom_fields->>'account' IN (${LIVE_PLACEHOLDERS})
      GROUP BY custom_fields->>'account'
      ORDER BY MIN(entry_time)
    `, [targetDate, ...LIVE_ACCOUNTS]),

    // Per-account intraday equity curve
    query(`
      SELECT
        custom_fields->>'account' as account,
        (entry_time AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::time as time,
        ROUND(pnl::numeric, 2) as pnl,
        ROUND(SUM(pnl) OVER (
          PARTITION BY custom_fields->>'account'
          ORDER BY entry_time, id
        )::numeric, 2) as running_pnl
      FROM trades
      WHERE log_date = $1
        AND custom_fields->>'account' IN (${LIVE_PLACEHOLDERS})
      ORDER BY custom_fields->>'account', entry_time, id
    `, [targetDate, ...LIVE_ACCOUNTS]),

    // NEW: annotations with linked fills
    query(`
      SELECT
        a.id,
        a.trade_ids,
        a.annotation_text,
        a.context_marker,
        a.setup_type,
        json_agg(json_build_object(
          'id', t.id, 'pnl', t.pnl::float, 'direction', t.direction, 'quantity', t.quantity,
          'entry_et', (t.entry_time AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::text
        ) ORDER BY t.entry_time, t.id) AS fills,
        ROUND(SUM(t.pnl)::numeric, 2) AS annotation_pnl
      FROM trade_annotations a
      JOIN trades t ON t.id = ANY(a.trade_ids)
      WHERE a.trade_date = $1
      GROUP BY a.id, a.trade_ids, a.annotation_text, a.context_marker, a.setup_type
      ORDER BY MIN(t.entry_time)
    `, [targetDate]),

    // NEW: today's engine reads if available
    query(`
      SELECT read_type, signal_value, session_bias_context, outcome, pts_vs_open
      FROM engine_reads WHERE trade_date = $1
    `, [targetDate]),

    // NEW: unified hit-rate lookup — engine_reads (A signals/bias), setup_correlation_cache
    // (level-touch reversal rates: IBH/IBL/PD levels/VWAP), and combo_stats (level-confluence combos)
    getAllHitRates(),
  ]);

  const trades = tradesQ.rows;
  const acd    = acdQ.rows[0] || {};
  const ar     = arQ.rows[0] || {};
  const dpl    = dplQ.rows[0] || {};
  const setups = setupsQ.rows;
  const largestMissed = parseFloat(missedQ.rows[0]?.largest_missed) || 0;
  const nl30          = parseInt(nl30Q.rows[0]?.nl30) || 0;

  // Session P&L
  const winners    = trades.filter(t => parseFloat(t.pnl) > 0).length;
  const losers     = trades.filter(t => parseFloat(t.pnl) < 0).length;
  const sessionPnl = trades.reduce((s, t) => s + (parseFloat(t.pnl) || 0), 0);

  // Per-account stats
  const accountStats = {};
  for (const row of accountSummaryQ.rows) {
    const shortName = row.account.split('-').pop();
    accountStats[row.account] = {
      shortName, fills: parseInt(row.fills),
      netPnl: parseFloat(row.net_pnl) || 0,
      grossWins: parseFloat(row.gross_wins) || 0,
      grossLosses: parseFloat(row.gross_losses) || 0,
      firstTrade: row.first_trade, lastTrade: row.last_trade,
      peakPnl: 0, peakTime: null, giveBack: 0, dllHit: false, dllTime: null,
    };
  }
  for (const row of accountCurveQ.rows) {
    const s = accountStats[row.account];
    if (!s) continue;
    const running = parseFloat(row.running_pnl);
    if (running > s.peakPnl) { s.peakPnl = running; s.peakTime = row.time; }
    if (!s.dllHit && running <= DLL_THRESHOLD) { s.dllHit = true; s.dllTime = row.time; }
  }
  for (const s of Object.values(accountStats)) {
    s.giveBack = Math.max(0, s.peakPnl - s.netPnl);
  }

  // Blended peak/give-back
  let running = 0, peakPnl = 0;
  const allFillsSorted = [...trades].sort((a, b) => new Date(a.entry_time) - new Date(b.entry_time));
  for (const t of allFillsSorted) {
    running += parseFloat(t.pnl) || 0;
    if (running > peakPnl) peakPnl = running;
  }
  const giveBack = Math.max(0, peakPnl - sessionPnl);

  const accountKeys = Object.keys(accountStats);
  let perAccountSummary = '';
  if (accountKeys.length > 1) {
    perAccountSummary = accountKeys.map(acct => {
      const s = accountStats[acct];
      const dll  = s.dllHit  ? ` | DLL HIT at ${s.dllTime}` : '';
      const peak = s.peakPnl > 0 ? ` | Peak: +$${s.peakPnl.toFixed(0)} at ${s.peakTime}` : '';
      const gb   = s.giveBack > 0 ? ` | Give-back: -$${s.giveBack.toFixed(0)} (${Math.round(s.giveBack / Math.max(s.peakPnl, 1) * 100)}% of peak)` : '';
      return `  ${s.shortName}: Net ${fmt$(s.netPnl)} | ${s.fills} fills | ${s.firstTrade}–${s.lastTrade}${dll}${peak}${gb}`;
    }).join('\n');
  }

  // ── Hit rate lookup (pre-computed, never touched by Claude's arithmetic) ────
  const { engineReads: hitRateLookup, levelTouches: levelTouchLookup, combos: comboLookup } = allHitRates;

  // Determine today's signal + bias context
  const aUpFired   = !!acd.a_up_fired;
  const aDownFired = !!acd.a_down_fired;
  const todayBias  = todayReadsQ.rows.find(r => r.read_type === 'PREMARKET_BIAS')?.signal_value
    || (ar.opening_call_type === 'LONG' ? 'LONG' : ar.opening_call_type === 'SHORT' ? 'SHORT' : 'NEUTRAL');

  const todaySigKey    = aUpFired ? 'A_UP' : aDownFired ? 'A_DOWN' : null;
  const todaySigRate   = todaySigKey ? formatHitRate(hitRateLookup, todaySigKey, todayBias) : null;
  const todaySigEntry  = todaySigKey ? (hitRateLookup[todaySigKey]?.byBias?.[todayBias]?.confident ? hitRateLookup[todaySigKey].byBias[todayBias] : hitRateLookup[todaySigKey]?.overall) : null;
  const todayBiasRate  = formatHitRate(hitRateLookup, 'BIAS_' + todayBias, null);
  const todaySigOutcome = todayReadsQ.rows.find(r => r.read_type === 'A_SIGNAL')?.outcome || 'pending';
  const todayBiasOutcome = todayReadsQ.rows.find(r => r.read_type === 'PREMARKET_BIAS')?.outcome || 'pending';

  // ── Signal-vs-trade direction alignment ─────────────────────────────────────
  // A_UP fires LONG-ward, A_DOWN fires SHORT-ward — compare against trader's net contract direction
  const longQty  = trades.filter(t => t.direction === 'LONG').reduce((s, t) => s + (parseInt(t.quantity) || 0), 0);
  const shortQty = trades.filter(t => t.direction === 'SHORT').reduce((s, t) => s + (parseInt(t.quantity) || 0), 0);
  const netDirection = longQty === shortQty ? (longQty === 0 ? null : 'MIXED') : (longQty > shortQty ? 'LONG' : 'SHORT');
  const signalDirection = aUpFired ? 'LONG' : aDownFired ? 'SHORT' : null;

  let signalAlignment = null;
  if (signalDirection && netDirection && netDirection !== 'MIXED') {
    signalAlignment = netDirection === signalDirection ? 'ALIGNED' : 'AGAINST';
  }

  // ── Signal validity at resolution ───────────────────────────────────────────
  // A signal that fired but never confirmed (C_UP/C_DOWN) and was resolved opposite
  // by the close was INVALIDATED — trading with that resolution is not "fading a
  // live signal." All fields here come from acd_daily_log, so they're same-scale
  // (no mixing with price_bars, which uses a different price reference).
  // 'VALID' = signal confirmed or resolution still consistent with it.
  // 'INVALIDATED' = never confirmed AND close resolved opposite the signal.
  // 'UNKNOWN' = can't determine from today's data.
  let signalValidity = 'UNKNOWN';
  if (todaySigOutcome === 'CORRECT') {
    signalValidity = 'VALID';
  } else if (todaySigOutcome === 'WRONG') {
    signalValidity = 'INVALIDATED';
  } else if (todaySigKey === 'A_UP' && acd.session_close != null && acd.or_low != null) {
    signalValidity = acd.c_up_confirmed ? 'VALID'
      : (parseFloat(acd.session_close) < parseFloat(acd.or_low) ? 'INVALIDATED' : 'UNKNOWN');
  } else if (todaySigKey === 'A_DOWN' && acd.session_close != null && acd.or_high != null) {
    signalValidity = acd.c_down_confirmed ? 'VALID'
      : (parseFloat(acd.session_close) > parseFloat(acd.or_high) ? 'INVALIDATED' : 'UNKNOWN');
  }
  const failureDirection = signalDirection === 'LONG' ? 'SHORT' : signalDirection === 'SHORT' ? 'LONG' : null;

  // Pre-compute the alignment framing sentence so Claude doesn't have to reason about probability itself
  let alignmentNote = null;
  if (signalAlignment === 'AGAINST' && signalValidity === 'INVALIDATED' && netDirection === failureDirection) {
    // Trader traded WITH the direction the signal failed toward — this is reading a
    // failed/invalidated signal correctly, NOT fading a live confident one. Do not
    // cite the historical hit rate as if they fought the odds.
    const confirmField = todaySigKey === 'A_UP' ? acd.c_up_confirmed : acd.c_down_confirmed;
    const orRef = todaySigKey === 'A_UP'
      ? `session closed at ${acd.session_close} below the OR low (${acd.or_low})`
      : `session closed at ${acd.session_close} above the OR high (${acd.or_high})`;
    alignmentNote = `${todaySigKey} fired but ${confirmField ? 'was later invalidated' : 'never gained C confirmation'} — ${orRef}, meaning the signal failed toward ${failureDirection}. The trader's net ${netDirection} direction traded WITH that resolution, not against a live signal. Do NOT cite the ${todaySigKey} hit rate as a "fade" or "beating the odds" — the relevant point is whether the trader correctly read the breakdown/failure of ${todaySigKey}, not probability framing.`;
  } else if (signalAlignment === 'AGAINST' && signalValidity === 'VALID' && todaySigEntry?.confident) {
    const rate = todaySigEntry.hitRate;
    alignmentNote = `Trader's net direction (${netDirection}) was AGAINST the ${todaySigKey} signal (${signalDirection}-ward), which has a ${rate}% historical hit rate (n=${todaySigEntry.decisive}) and remained valid/confirmed today. Fading a ${rate}%-confident, still-valid signal means betting on the ${100 - rate}% case. ${sessionPnl >= 0 ? 'The fade won today — note the win came on the statistically less likely outcome, not because the signal is unreliable.' : 'The fade lost today — consistent with the signal\'s high historical reliability.'}`;
  } else if (signalAlignment === 'AGAINST' && signalValidity === 'VALID' && todaySigEntry && !todaySigEntry.confident) {
    alignmentNote = `Trader's net direction (${netDirection}) was AGAINST the ${todaySigKey} signal, which remained valid/confirmed today, but its hit rate is a limited sample (n=${todaySigEntry.decisive}) — too thin to use for probability framing.`;
  } else if (signalAlignment === 'AGAINST' && signalValidity === 'UNKNOWN') {
    alignmentNote = `Trader's net direction (${netDirection}) was AGAINST the ${todaySigKey} signal, but whether ${todaySigKey} was still valid or already invalidated by the time of the trade can't be determined from today's data — do not cite the historical hit rate as a fade/challenge framing.`;
  } else if (signalAlignment === 'ALIGNED' && todaySigEntry?.confident) {
    const rate = todaySigEntry.hitRate;
    alignmentNote = `Trader's net direction (${netDirection}) was ALIGNED with the ${todaySigKey} signal (${signalDirection}-ward), which has a ${rate}% historical hit rate (n=${todaySigEntry.decisive}). ${sessionPnl >= 0 && rate < 55 ? 'Note this signal is only marginally reliable — the win was on a lower-probability setup than it may feel.' : ''}`;
  } else if (signalAlignment === 'ALIGNED' && todaySigEntry && !todaySigEntry.confident) {
    alignmentNote = `Trader's net direction (${netDirection}) was ALIGNED with the ${todaySigKey} signal, but its hit rate is a limited sample (n=${todaySigEntry.decisive}) — too thin to use for probability framing.`;
  }

  // ── Level-touch track record (setup_correlation_cache) ──────────────────────
  // IB_BEARISH/IB_BULLISH setups correspond to IBL/IBH touches in setup_correlation_cache.
  // hit_rate there = reversal/bounce rate off the level within 30 bars, NOT a
  // breakout-continuation rate — formatLevelTouchRate() carries that framing.
  const levelTouchKeyMap = { IB_BEARISH: 'IBL', IB_BULLISH: 'IBH' };
  const levelTouchEvents = setups
    .filter(s => levelTouchKeyMap[s.setup_type])
    .map(s => {
      const levelKey = levelTouchKeyMap[s.setup_type];
      const rate = formatLevelTouchRate(levelTouchLookup, levelKey, todayBias);
      const time = s.fired_at ? String(s.fired_at).slice(11, 16) : '?';
      return `  ${s.setup_type} (${levelKey} touch, fired ${time} ET, resolution ${s.resolution || 'pending'}) — ${rate || 'no data'}`;
    });
  const levelTouchSummary = levelTouchEvents.length ? levelTouchEvents.join('\n') : null;

  // ── Combo track record (combo_stats) ─────────────────────────────────────────
  // Reference table of all level-confluence combos. Cite only when directly
  // relevant to today's annotated reasoning or detected setups/levels.
  const comboSummary = Object.keys(comboLookup)
    .map(id => '  ' + formatComboRate(comboLookup, id))
    .join('\n');

  // ── Annotation processing ────────────────────────────────────────────────────
  const annotatedFillIds = new Set(annotationsQ.rows.flatMap(a => a.trade_ids));
  const unannotatedFills = trades.filter(t => !annotatedFillIds.has(t.id));

  const annotationsSummary = annotationsQ.rows.length === 0
    ? 'None — trader added no notes for this session.'
    : annotationsQ.rows.map((a, i) => {
        const fills    = a.fills || [];
        const totalPnl = parseFloat(a.annotation_pnl) || 0;
        const dirs     = [...new Set(fills.map(f => f.direction))].join('/');
        const fillLine = fills.map(f => `${f.direction} ×${f.quantity} P&L ${fmt$(f.pnl)}`).join(', ');
        const ctxLabel = a.context_marker === 'planned' ? 'PLANNED' : a.context_marker === 'reaction' ? 'REACTION' : (a.context_marker || 'UNSET').toUpperCase();
        return `[Note ${i + 1} — ${ctxLabel} | Net ${fmt$(totalPnl)} | ${dirs}]\n  Fills: ${fillLine}\n  Reasoning: "${a.annotation_text?.trim()}"`;
      }).join('\n\n');

  const unannotatedSummary = unannotatedFills.length === 0
    ? 'All fills have notes.'
    : unannotatedFills.map(t =>
        `  Fill #${t.id}: ${t.direction} ×${t.quantity} ${t.symbol || 'NQ'} @ ${String(t.entry_time).slice(11, 19)} ET — P&L ${fmt$(t.pnl)}`
      ).join('\n');

  const openingCall    = ar.opening_call_type || 'NO_SIGNAL';
  const aSignal        = ar.a_signal_override || 'NO_SIGNAL';
  const structuralState = dpl.structural_state || 'BRACKET';
  const confluenceScore = dpl.confluence_score_pre || dpl.confluence_score_peak || 0;

  const tradesSummary = trades.length === 0
    ? 'No trades recorded for live accounts.'
    : trades.map(t =>
        `  #${t.id} ${t.symbol} ${t.direction} ×${t.quantity} ${String(t.entry_time).slice(11,16)} ET | P&L: ${fmt$(t.pnl)}` +
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
    targetDate, trades, totalTrades: trades.length, winners, losers, sessionPnl,
    peakPnl, giveBack, largestMissed, structuralState, nl30,
    openingCall, aSignal, confluenceScore, orRange,
    aUpFired, aDownFired, dayType: acd.day_type || 'N/A',
    tradesSummary, setupsSummary, accountStats, perAccountSummary,
    multipleAccounts: accountKeys.length > 1,
    // Hit rate context
    todaySigKey, todaySigRate, todayBias, todayBiasRate, todaySigOutcome, todayBiasOutcome,
    hitRateLookup, levelTouchLookup, comboLookup,
    // Level-touch (IB break) and combo track records
    levelTouchSummary, comboSummary,
    // Signal-vs-trade alignment
    netDirection, signalDirection, signalAlignment, alignmentNote,
    // Annotation context
    annotationsSummary, unannotatedSummary, annotatedCount: annotationsQ.rows.length,
    unannotatedCount: unannotatedFills.length,
    rawContext: { acd, ar, dpl, setups, nl30 },
  };
}

function buildSystemPrompt() {
  return `You are the daily coaching voice for a prop firm evaluation trader. You review their NQ/MNQ futures trading using ONLY the data provided — never fabricate.

HARD RULES — NEVER VIOLATE:
1. Every percentage you write must come verbatim from the PRE-COMPUTED HIT RATES section. Never calculate rates yourself. Never estimate.
2. If hit rate data says "limited sample (n=X)", write "limited sample (n=X)", never a percentage.
3. CHALLENGE wins that came on weak-signal or against-signal setups: "you made money, but the engine signal that day plays out X% historically — process was lower-probability than the result suggests." Only say this when the data actually supports it.
4. AFFIRM good process: when the trader played a planned setup with clear reasoning and the hit rate supports it, say so explicitly. Affirmation must trace to data or annotation.
4a. WHAT WORKED MUST ADD SOMETHING THE TRADER DID NOT WRITE. Never restate or rephrase the trader's own annotation as the substance of the affirmation — they already wrote it, repeating it back adds zero value. The substance of WHAT WORKED must be an OBJECTIVE execution/outcome fact the trader did not state themselves, e.g.:
   - P&L captured vs peak intraday P&L (give-back/capture quality) — especially if it counters a documented give-back leak
   - MFE capture ratio (P&L vs max open profit on that fill)
   - time-in-trade, position sizing relative to conviction, whether a cooldown/spiral was avoided
   - the signal hit-rate data — e.g., "you took a short — short reads are historically weaker (X%, n=Y) — but it was backed by [brief reference to their reasoning], AND you captured $A of $B peak (near-zero give-back)."
   You MAY briefly reference the trader's reasoning to connect the affirmation to it, but that reference must not BE the affirmation. If you have no objective fact to add for a trade, do not pad with paraphrase — write a short, honest line ("clean execution, near-zero give-back on fill #X") or say plainly that nothing further stands out.
5. For every unannotated fill listed, write exactly: "no note on fill #[ID] — add your read so I can assess the reasoning."
6. When referencing annotation reasoning: summarize the trader's own words BRIEFLY only as a connector, then assess it with new information — don't invent what they were thinking, and don't let the summary itself be the point.
7. context_marker PLANNED = pre-planned setup (affirm discipline); REACTION = reactive trade (assess whether structure supported it).
8. SIGNAL ALIGNMENT: if a SIGNAL ALIGNMENT note is provided, it tells you whether the trader's net position direction matched, fought, or traded the resolution of a failed/invalidated version of the day's A signal — and gives you the pre-computed framing for that. Use it verbatim — do not recompute or restate any percentage differently, and do not invent your own "fade"/"beat the odds" framing if the note says the signal was invalidated or its validity is unknown. If the note says the trader fought a still-VALID confident signal and won, that is the clearest "challenge" case: explicitly say the win was on the statistically less likely side. If the note says the signal was INVALIDATED and the trader traded with the resolution, frame it as correctly reading the failed signal/breakdown — never as "fading" or "beating the odds."
9. Under 230 words total. No generic platitudes. Every sentence must reference a specific number, fill, or annotation from today.
10. LEVEL TOUCH TRACK RECORD entries (IB high/low touches) measure how often price REVERSED/BOUNCED off that level within 30 minutes — they are NOT breakout-continuation rates. If the trader's setup involved breaking through that level for continuation (e.g. shorting an IB-low breakdown), a HIGH reversal/bounce rate means their continuation trade caught the statistically LESS common outcome — frame it that way (challenge if it won "on the less likely case", note if it lost "consistent with the level usually holding"). Use the percentage and "(n=X)" verbatim from the data, and use the exact reversal/bounce wording given — never relabel it as a breakout or continuation stat. COMBO TRACK RECORD entries are background reference only — mention one only if it maps directly to a level/setup the trader actually traded or annotated today; otherwise don't mention combos at all.`;
}

function buildPrompt(ctx) {
  const noTrades = ctx.trades.length === 0;

  const perAccountBlock = ctx.multipleAccounts
    ? `\nPER-ACCOUNT BREAKDOWN:\n${ctx.perAccountSummary}\n`
    : '';

  const signalBlock = ctx.todaySigKey
    ? `Signal fired: ${ctx.todaySigKey} (historical rate: ${ctx.todaySigRate || 'no data'} | today's outcome: ${ctx.todaySigOutcome})`
    : 'No A signal fired today.';

  const biasBlock = `Pre-market bias: ${ctx.todayBias} (historical rate: ${ctx.todayBiasRate || 'no data'} | today's outcome: ${ctx.todayBiasOutcome})`;

  const alignmentBlock = ctx.alignmentNote
    ? `\nSIGNAL ALIGNMENT: ${ctx.alignmentNote}\n`
    : (ctx.netDirection && ctx.netDirection !== 'MIXED' ? `\nSIGNAL ALIGNMENT: Trader's net direction was ${ctx.netDirection}. No A signal fired today, so no alignment comparison applies.\n` : '');

  const levelTouchBlock = ctx.levelTouchSummary
    ? `\nLEVEL TOUCH TRACK RECORD (reversal/bounce rate off the level — NOT a breakout-continuation rate):\n${ctx.levelTouchSummary}\n`
    : '';

  const comboBlock = `\nCOMBO TRACK RECORD (level-confluence combos — cite ONLY if directly relevant to today's setups/annotations, otherwise ignore):\n${ctx.comboSummary}\n`;

  return `DATE: ${ctx.targetDate}

SESSION CONTEXT:
Structural state: ${ctx.structuralState}
NL30: ${ctx.nl30} | Day type: ${ctx.dayType}
Opening call: ${ctx.openingCall} | Confluence: ${ctx.confluenceScore}/12
${ctx.orRange}
${biasBlock}
${signalBlock}
Session close: ${ctx.rawContext?.acd?.session_close || 'N/A'}
${alignmentBlock}${levelTouchBlock}${comboBlock}
DATA STATUS: ${ctx.importNote}

SETUPS DETECTED:
${ctx.setupsSummary}

${noTrades ? 'NO TRADES: Live accounts had no recorded fills for this session.\n' : `TRADES (${ctx.totalTrades} fills):
${ctx.tradesSummary}
${perAccountBlock}
SESSION RESULT:
Winners: ${ctx.winners} | Losers: ${ctx.losers}
Session P&L: ${fmt$(ctx.sessionPnl)}
Peak intraday P&L: ${ctx.peakPnl > 0 ? '+$' + ctx.peakPnl.toFixed(0) : '$0'}
Give-back: ${ctx.giveBack > 0 ? '-$' + ctx.giveBack.toFixed(0) : 'none'}
Largest profit seen on a losing trade: ${ctx.largestMissed > 0 ? '+$' + ctx.largestMissed.toFixed(0) : 'none'}
`}TRADER ANNOTATIONS (${ctx.annotatedCount} of ${ctx.totalTrades} fills annotated):
${ctx.annotationsSummary}

${ctx.unannotatedCount > 0 ? `UNANNOTATED FILLS:\n${ctx.unannotatedSummary}\n\n` : ''}${ctx.multipleAccounts ? 'IMPORTANT: Multiple accounts traded today. Address each account separately.\n\n' : ''}Respond in exactly this format:

WHAT HAPPENED:
[2–3 sentences on today's price action, ACD context, and signal outcome. Reference the OR range, signal, and session close.]

WHAT WORKED:
[What the trader did right — but the substance must be an OBJECTIVE execution/outcome fact (give-back/capture vs peak, MFE capture, sizing, hit-rate context) that the trader did NOT already say in their own annotation. Reference their reasoning only briefly to connect to it. If there's nothing objective to add, keep it short and honest rather than padding with paraphrase. If nothing worked, say so plainly.]

WHAT TO IMPROVE:
[The single most useful observation. Challenge/affirm based on hit rates and annotations. If any fill is unannotated: "no note on fill #ID — add your read so I can assess the reasoning."]

TOMORROW'S WATCH:
[One specific level or condition based on today's close and structure.]`;
}

export async function runDailyCoaching(targetDate, io) {
  if (!targetDate) {
    const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    targetDate = nowET.toISOString().slice(0, 10);
  }

  console.log(`[daily_coaching] Running for ${targetDate}`);

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
      max_tokens: 500,
      system: buildSystemPrompt(),
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
        (session_date, trades_count, session_pnl, largest_missed_profit, peak_pnl, give_back, raw_context, coaching_text)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (session_date) DO UPDATE SET
        trades_count = EXCLUDED.trades_count,
        session_pnl = EXCLUDED.session_pnl,
        largest_missed_profit = EXCLUDED.largest_missed_profit,
        peak_pnl = EXCLUDED.peak_pnl,
        give_back = EXCLUDED.give_back,
        coaching_text = EXCLUDED.coaching_text,
        raw_context = EXCLUDED.raw_context,
        created_at = NOW()
    `, [
      targetDate,
      ctx.totalTrades,
      ctx.sessionPnl,
      ctx.largestMissed || null,
      ctx.peakPnl || null,
      ctx.giveBack || null,
      JSON.stringify(ctx.rawContext),
      coachingText,
    ]);

    // Day-type accuracy log
    try {
      const barsQ = await query(`
        SELECT close::float, high::float, low::float, open::float,
          EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) as et_min
        FROM price_bars WHERE symbol='NQ' AND ts::date = $1
          AND EXTRACT(hour FROM ts) BETWEEN 9 AND 15
        ORDER BY ts
      `, [targetDate]);
      if (barsQ.rows.length >= 50) {
        const rthBars   = barsQ.rows.filter(b => b.et_min >= 570 && b.et_min <= 959);
        const sessHigh  = Math.max(...rthBars.map(b => b.high));
        const sessLow   = Math.min(...rthBars.map(b => b.low));
        const sessRange = sessHigh - sessLow;
        const sessOpen  = rthBars[0]?.open;
        const sessClose = rthBars[rthBars.length - 1]?.close;
        const closePct  = sessRange > 0 ? (sessClose - sessLow) / sessRange : 0.5;
        const trendStr  = sessRange > 0 ? Math.abs(sessClose - sessOpen) / sessRange : 0;

        const acdRow = await query(`SELECT or_high::float, or_low::float FROM acd_daily_log WHERE trade_date=$1`, [targetDate]);
        const orW = acdRow.rows[0] ? acdRow.rows[0].or_high - acdRow.rows[0].or_low : null;

        let intradayCall = null;
        if (orW != null) {
          const first5 = rthBars.filter(b => b.et_min >= 570 && b.et_min <= 574).slice(0, 5);
          if (first5.length >= 5) {
            const nl30Q = await query(`
              SELECT COALESCE(SUM(daily_score), 0)::int AS nl30
              FROM acd_daily_log
              WHERE trade_date >= $1::date - INTERVAL '30 days'
                AND trade_date < $1::date
                AND daily_score IS NOT NULL
            `, [targetDate]);
            const sessionNl30 = nl30Q.rows[0]?.nl30 ?? 0;
            const openingType = classifyOpeningType(first5);
            intradayCall = classifyDayType({ openingType, nl30: sessionNl30, orWidth: orW, asOfMinutes: 605 }).classification;
          }
        }

        const avg20Q = await query(`
          SELECT AVG(sess_range)::float AS avg_range_20
          FROM (
            SELECT MAX(high) - MIN(low) AS sess_range
            FROM price_bars
            WHERE symbol = 'NQ' AND ts::date < $1
              AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) BETWEEN 570 AND 959
            GROUP BY ts::date HAVING COUNT(*) >= 200
            ORDER BY ts::date DESC LIMIT 20
          ) recent
        `, [targetDate]);
        const avgRange20 = avg20Q.rows[0]?.avg_range_20;
        const rangeRatio = avgRange20 ? sessRange / avgRange20 : null;

        const ibBars = rthBars.filter(b => b.et_min < 630);
        const ibHigh = ibBars.length ? Math.max(...ibBars.map(b => b.high)) : null;
        const ibLow  = ibBars.length ? Math.min(...ibBars.map(b => b.low))  : null;
        const closeOutsideIb = ibHigh != null && ibLow != null
          ? (sessClose > ibHigh || sessClose < ibLow) : false;

        let eodTruth = 'BALANCE';
        if (rangeRatio != null) {
          if ((closePct >= 0.80 || closePct <= 0.20) && trendStr >= 0.50 && rangeRatio >= 0.75 && closeOutsideIb) {
            eodTruth = 'TREND';
          } else if (rangeRatio >= 1.25) {
            eodTruth = 'TURBULENT';
          }
        }

        await query(`
          INSERT INTO daytype_accuracy_log (trade_date, intraday_call, eod_truth, matched, session_range, close_pct, trend_strength, or_width, nl30)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (trade_date) DO UPDATE SET
            intraday_call=$2, eod_truth=$3, matched=$4, session_range=$5, close_pct=$6, trend_strength=$7, or_width=$8, nl30=$9, logged_at=NOW()
        `, [targetDate, intradayCall, eodTruth, intradayCall === eodTruth, Math.round(sessRange), Math.round(closePct * 100), Math.round(trendStr * 100), orW ? Math.round(orW) : null, ctx.nl30]);
        console.log(`[daily_coaching] EOD truth logged: intraday=${intradayCall} → truth=${eodTruth} (${intradayCall === eodTruth ? 'MATCH' : 'MISS'})`);
      }
    } catch (dtErr) { console.error('[daily_coaching] daytype truth log failed:', dtErr.message); }

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
