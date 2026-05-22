// Pattern Memory Update Service
// Nightly job that populates daily_performance_log, condition_memory, pattern_stats
// Column mapping notes:
//   structural_state   — derived from NL30 + VA overlap/migration (same logic as longterm/summary)
//   opening_call       — from auction_reads.opening_call_type
//   a_signal           — from auction_reads.a_signal_override (parsed for direction + quality)
//   nl30/nl10          — rolling sum of acd_daily_log.daily_score
//   phase_change cols  — placeholder 0 until STEP2 is built
//   cum_delta          — bid_volume - ask_volume per bar (not stored; computed when needed)

import { query } from '../db.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

function getNL30Bucket(nl30) {
  if (nl30 == null) return 'RANGING';
  if (nl30 > 15)  return 'STRONG_BULL';
  if (nl30 > 9)   return 'BULL';
  if (nl30 < -15) return 'STRONG_BEAR';
  if (nl30 < -9)  return 'BEAR';
  return 'RANGING';
}

function getConfluenceBucket(score) {
  if (score == null) return 'WEAK';
  if (score >= 10) return 'HIGH';
  if (score >= 7)  return 'MODERATE';
  if (score >= 4)  return 'LOW';
  return 'WEAK';
}

// Derive structural state from NL30 + VA overlap + migration
// Reuses same derivation logic as longterm/summary endpoint
async function deriveStructuralState(tradeDate) {
  // Get prior 5 sessions' POC values to compute migration direction
  const pocQ = await query(`
    WITH days AS (
      SELECT DISTINCT ts::date::text as d
      FROM price_bars WHERE symbol='NQ'
        AND ts::date < ($1::text)::date
        AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
      ORDER BY d DESC LIMIT 5
    )
    SELECT d, (
      WITH vp AS (SELECT ROUND(low/0.25)*0.25 as px, SUM(volume) as vol
        FROM price_bars WHERE symbol='NQ' AND ts::date::text=days.d
          AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16 GROUP BY ROUND(low/0.25)*0.25),
      poc_row AS (SELECT px as poc_px FROM vp ORDER BY vol DESC LIMIT 1)
      SELECT poc_row.poc_px FROM poc_row LIMIT 1
    ) as poc
    FROM days ORDER BY d DESC
  `, [tradeDate]);

  const pocValues = pocQ.rows.map(r => parseFloat(r.poc)).filter(Boolean);

  // Overlap count from last 5 day pairs using session high/low as VA proxy
  const vaQ = await query(`
    SELECT ts::date::text as d,
      MAX(high)::float as day_high, MIN(low)::float as day_low
    FROM price_bars WHERE symbol='NQ'
      AND ts::date < ($1::text)::date
      AND ts::date >= ($1::text)::date - INTERVAL '7 days'
      AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
    GROUP BY ts::date ORDER BY ts::date DESC LIMIT 5
  `, [tradeDate]);

  const vaDays = vaQ.rows;
  let overlapCount = 0;
  for (let i = 1; i < vaDays.length; i++) {
    const prev = vaDays[i], curr = vaDays[i-1];
    const lo = Math.max(prev.day_low, curr.day_low);
    const hi = Math.min(prev.day_high, curr.day_high);
    if (hi > lo) overlapCount++;
  }

  // Migration direction from POC sequence
  let up = 0, down = 0;
  for (let i = 1; i < pocValues.length; i++) {
    if (pocValues[i-1] > pocValues[i]) up++;
    else if (pocValues[i-1] < pocValues[i]) down++;
  }
  const total = pocValues.length - 1 || 1;
  const dir5 = up / total >= 0.65 ? 'HIGHER' : down / total >= 0.65 ? 'LOWER' : 'OVERLAPPING';

  // NL30 for this date
  const nlQ = await query(`
    SELECT SUM(daily_score) FILTER (WHERE trade_date > ($1::text)::date - INTERVAL '30 days' AND trade_date <= ($1::text)::date) as nl30
    FROM acd_daily_log WHERE daily_score IS NOT NULL
  `, [tradeDate]);
  const nl30 = nlQ.rows[0]?.nl30 || 0;

  // Apply same classification as longterm/summary
  if (overlapCount >= 4 && dir5 === 'HIGHER') return 'BRACKET_TILTING_UP';
  if (overlapCount >= 4 && dir5 === 'LOWER')  return 'BRACKET_TILTING_DOWN';
  if (overlapCount >= 3 && dir5 === 'HIGHER') return 'BRACKET_TILTING_UP';
  if (overlapCount >= 3 && dir5 === 'LOWER')  return 'BRACKET_TILTING_DOWN';
  if (overlapCount >= 3)                      return 'BRACKET';
  if (dir5 === 'HIGHER' && nl30 > 0)          return 'TRENDING_UP';
  if (dir5 === 'LOWER'  && nl30 < 0)          return 'TRENDING_DOWN';
  if (overlapCount >= 2)                      return 'BRACKET';
  return 'TRANSITIONAL';
}

// Compute T1 level for the session — same logic as confluence endpoint
function computeT1(orHigh, orLow, aSignalDir, ctTargets) {
  if (!orHigh || !orLow) return null;
  const orRange = orHigh - orLow;
  if (ctTargets?.length) return ctTargets[0].price; // counter-trend: nearest structural support
  return aSignalDir === 'A_UP' ? Math.round(orHigh + orRange) : Math.round(orLow - orRange);
}

// ── STEP 1: Populate daily_performance_log ─────────────────────────────────────

export async function populateDailyLog(tradeDate, io = null) {
  // Auction read for this date
  const arQ = await query(`
    SELECT opening_call_type, a_signal_override,
           prior_day_profile, overnight_inventory, open_vs_prior_value
    FROM auction_reads WHERE trade_date = $1
  `, [tradeDate]);
  const ar = arQ.rows[0]; // may be null — that's ok

  // NL30 + NL10 anchored to tradeDate — not CURRENT_DATE
  const nlQ = await query(`
    SELECT
      SUM(daily_score) FILTER (WHERE trade_date > ($1::text)::date - INTERVAL '30 days' AND trade_date <= ($1::text)::date) as nl30,
      SUM(daily_score) FILTER (WHERE trade_date > ($1::text)::date - INTERVAL '10 days' AND trade_date <= ($1::text)::date) as nl10
    FROM acd_daily_log WHERE daily_score IS NOT NULL
  `, [tradeDate]);
  const nl30 = parseInt(nlQ.rows[0]?.nl30) || 0;
  const nl10 = parseInt(nlQ.rows[0]?.nl10) || 0;

  // Trade outcomes — note: trades use log_date not trade_date
  const tradesQ = await query(`
    SELECT
      COUNT(*) as total_trades,
      COUNT(*) FILTER (WHERE pnl > 0) as winners,
      COUNT(*) FILTER (WHERE pnl < 0) as losers,
      COUNT(*) FILTER (WHERE pnl = 0) as breakeven,
      SUM(pnl) as session_pnl,
      MAX((custom_fields->>'max_open_profit')::numeric) as max_favorable,
      MIN((custom_fields->>'max_open_loss')::numeric) as max_adverse
    FROM trades
    WHERE log_date = $1 AND pnl IS NOT NULL
  `, [tradeDate]);
  const t = tradesQ.rows[0];
  const totalTrades = parseInt(t.total_trades) || 0;

  // Need at least trades to log — auction_reads optional but flagged
  if (totalTrades === 0) {
    console.log(`[pattern] ${tradeDate}: no trades — skipping`);
    return null;
  }

  // Parse A signal from a_signal_override
  const aOvr = ar?.a_signal_override || null;
  const aSignalDirection = aOvr?.startsWith('A_UP') ? 'A_UP'
    : aOvr?.startsWith('A_DOWN') ? 'A_DOWN' : 'NO_SIGNAL';
  const aSignalQuality = aOvr?.endsWith('_STRONG') ? 'STRONG'
    : aOvr?.endsWith('_WEAK') ? 'WEAK'
    : aOvr?.endsWith('_FAILED') ? 'FAILED' : 'NO_SIGNAL';

  // Structural state
  const structuralState = await deriveStructuralState(tradeDate);

  // Counter-trend: A signal direction vs NL30 direction
  const nl30Bull = nl30 > 9, nl30Bear = nl30 < -9;
  const counterTrend =
    (nl30Bull && aSignalDirection === 'A_DOWN') ||
    (nl30Bear && aSignalDirection === 'A_UP');

  // Confluence pre-market score (c1-c7 only — structural)
  // Re-query the same way as confluence/today for this date
  const confQ = await query(`
    SELECT
      SUM(daily_score) FILTER (WHERE trade_date > ($1::text)::date - 30 AND trade_date <= ($1::text)::date) as nl30
    FROM acd_daily_log WHERE daily_score IS NOT NULL
  `, [tradeDate]);
  // Simple pre-market score: count structural conditions met
  // c1: NL30 confirmed, c2: NL10 aligned, c6: monthly pivot (approx)
  let confluenceScorePre = 0;
  if (Math.abs(nl30) > 9) confluenceScorePre++; // c1
  if ((nl30 > 9 && nl10 > 0) || (nl30 < -9 && nl10 < 0)) confluenceScorePre++; // c2
  if (ar?.open_vs_prior_value === 'ABOVE_VALUE' && nl30 > 0) confluenceScorePre++; // c3 proxy
  if (ar?.overnight_inventory === 'SHORT_TRAPPED' && nl30 > 0) confluenceScorePre++; // c4 proxy
  if (ar?.prior_day_profile && ['TREND','NORMAL_VARIATION'].includes(ar.prior_day_profile)) confluenceScorePre++; // c5 proxy

  // Session high/low for close position and T1 hit check
  const sessQ = await query(`
    SELECT MAX(high)::float as sess_high, MIN(low)::float as sess_low,
           (array_agg(close ORDER BY ts DESC))[1]::float as sess_close
    FROM price_bars WHERE symbol='NQ' AND ts::date = ($1::text)::date
      AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
  `, [tradeDate]);
  const sess = sessQ.rows[0] || {};

  // OR levels for T1 calculation
  const orQ = await query(`SELECT or_high::float, or_low::float FROM acd_daily_log WHERE trade_date = $1`, [tradeDate]);
  const orH = orQ.rows[0]?.or_high, orL = orQ.rows[0]?.or_low;
  const t1Level = computeT1(orH, orL, aSignalDirection, null);

  // T1 hit: did session high/low reach T1?
  let t1Hit = null;
  if (t1Level && sess.sess_high && sess.sess_low) {
    t1Hit = aSignalDirection === 'A_UP'
      ? sess.sess_high >= t1Level
      : aSignalDirection === 'A_DOWN'
      ? sess.sess_low <= t1Level
      : null;
  }

  // Stop hit: did any trade have a loss worse than -50% of session range?
  // Simple proxy: any trade with pnl worse than -$100
  const stoppedOutQ = await query(`
    SELECT COUNT(*) as cnt FROM trades WHERE log_date = $1 AND pnl < -100
  `, [tradeDate]);
  const stoppedOut = parseInt(stoppedOutQ.rows[0]?.cnt) > 0;

  // Close position (top/mid/bottom third of day's range)
  let closePosition = null;
  if (sess.sess_close && sess.sess_high && sess.sess_low) {
    const range = sess.sess_high - sess.sess_low;
    if (range > 0) {
      const pos = (sess.sess_close - sess.sess_low) / range;
      closePosition = pos > 0.67 ? 'HIGH' : pos < 0.33 ? 'LOW' : 'MID';
    }
  }

  // Value migrated vs prior day VA
  const priorVaQ = await query(`
    WITH vp AS (SELECT ROUND(low/0.25)*0.25 as px, SUM(volume) as vol
      FROM price_bars WHERE symbol='NQ'
        AND ts::date=(SELECT MAX(ts::date) FROM price_bars WHERE symbol='NQ' AND ts::date<($1::text)::date AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16)
        AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16 GROUP BY ROUND(low/0.25)*0.25),
    total AS (SELECT SUM(vol) as t FROM vp),
    poc_row AS (SELECT px as poc_px FROM vp ORDER BY vol DESC LIMIT 1)
    SELECT p.poc_px::float as poc,
      (SELECT MAX(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px DESC) cv FROM vp WHERE px>=p.poc_px) x WHERE cv<=(SELECT t*0.35 FROM total))::float as vah,
      (SELECT MIN(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px ASC) cv FROM vp WHERE px<=p.poc_px) x WHERE cv<=(SELECT t*0.35 FROM total))::float as val
    FROM vp, poc_row p GROUP BY p.poc_px LIMIT 1
  `, [tradeDate]);
  const todayVaQ = await query(`
    WITH vp AS (SELECT ROUND(low/0.25)*0.25 as px, SUM(volume) as vol
      FROM price_bars WHERE symbol='NQ' AND ts::date=($1::text)::date
        AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16 GROUP BY ROUND(low/0.25)*0.25),
    total AS (SELECT SUM(vol) as t FROM vp),
    poc_row AS (SELECT px as poc_px FROM vp ORDER BY vol DESC LIMIT 1)
    SELECT p.poc_px::float as poc FROM vp, poc_row p GROUP BY p.poc_px LIMIT 1
  `, [tradeDate]);
  let valueMigrated = null;
  const priorPoc = priorVaQ.rows[0]?.poc, todayPoc = todayVaQ.rows[0]?.poc;
  if (priorPoc && todayPoc) {
    valueMigrated = todayPoc > priorPoc + 10 ? 'HIGHER' : todayPoc < priorPoc - 10 ? 'LOWER' : 'OVERLAPPING';
  }

  const winRate = totalTrades > 0 ? (parseInt(t.winners) || 0) / totalTrades : null;
  // sufficient_session_data: true whenever trades were recorded.
  // auction_reads data is optional — sessions without it get opening_call='NO_SIGNAL'
  // which is itself a valid and trackable condition combination.
  const sufficientData = totalTrades > 0;

  // Upsert
  await query(`
    INSERT INTO daily_performance_log (
      trade_date, structural_state, nl30_at_open, nl10_at_open,
      opening_call, a_signal_direction, a_signal_quality,
      confluence_score_pre, confluence_score_peak, counter_trend,
      total_trades, winners, losers, breakeven, session_pnl, win_rate,
      t1_hit, stopped_out, max_favorable, max_adverse,
      phase_change_alerts_count, phase_change_reversed,
      close_position, value_migrated, sufficient_session_data
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
      $11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
      0,0,$21,$22,$23
    )
    ON CONFLICT (trade_date) DO UPDATE SET
      structural_state=EXCLUDED.structural_state,
      nl30_at_open=EXCLUDED.nl30_at_open,
      nl10_at_open=EXCLUDED.nl10_at_open,
      opening_call=EXCLUDED.opening_call,
      a_signal_direction=EXCLUDED.a_signal_direction,
      a_signal_quality=EXCLUDED.a_signal_quality,
      confluence_score_pre=EXCLUDED.confluence_score_pre,
      confluence_score_peak=EXCLUDED.confluence_score_peak,
      counter_trend=EXCLUDED.counter_trend,
      total_trades=EXCLUDED.total_trades,
      winners=EXCLUDED.winners,
      losers=EXCLUDED.losers,
      breakeven=EXCLUDED.breakeven,
      session_pnl=EXCLUDED.session_pnl,
      win_rate=EXCLUDED.win_rate,
      t1_hit=EXCLUDED.t1_hit,
      stopped_out=EXCLUDED.stopped_out,
      max_favorable=EXCLUDED.max_favorable,
      max_adverse=EXCLUDED.max_adverse,
      close_position=EXCLUDED.close_position,
      value_migrated=EXCLUDED.value_migrated,
      sufficient_session_data=EXCLUDED.sufficient_session_data,
      updated_at=NOW()
  `, [
    tradeDate, structuralState, nl30, nl10,
    ar?.opening_call_type || 'NO_SIGNAL',
    aSignalDirection, aSignalQuality,
    confluenceScorePre, null, // confluence_score_peak: filled post-session
    counterTrend,
    totalTrades, parseInt(t.winners)||0, parseInt(t.losers)||0, parseInt(t.breakeven)||0,
    parseFloat(t.session_pnl)||0, winRate,
    t1Hit, stoppedOut,
    parseFloat(t.max_favorable)||null, parseFloat(t.max_adverse)||null,
    closePosition, valueMigrated, sufficientData
  ]);

  console.log(`[pattern] ${tradeDate}: logged — ${structuralState} NL30:${nl30} ${aSignalDirection} ${totalTrades} trades PnL:${parseFloat(t.session_pnl)||0}`);
  return { tradeDate, structuralState, nl30, aSignalDirection, totalTrades, sessionPnl: parseFloat(t.session_pnl)||0 };
}

// ── STEP 2: Update condition_memory ────────────────────────────────────────────

export async function updateConditionMemory(tradeDate) {
  const logQ = await query(`
    SELECT * FROM daily_performance_log
    WHERE trade_date = $1 AND sufficient_session_data = true
  `, [tradeDate]);
  if (!logQ.rows[0]) {
    console.log(`[pattern] ${tradeDate}: no sufficient data for condition_memory`);
    return;
  }
  const d = logQ.rows[0];

  const nl30Bucket = getNL30Bucket(d.nl30_at_open);
  const confluenceBucket = getConfluenceBucket(d.confluence_score_peak ?? d.confluence_score_pre);
  const isWin = (parseFloat(d.session_pnl) || 0) > 0;
  const isLoss = (parseFloat(d.session_pnl) || 0) < 0;

  const thirtyDaysAgo = new Date(tradeDate);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const thirtyDaysAgoStr = thirtyDaysAgo.toISOString().split('T')[0];

  // Last 30 days stats for this structural state
  const l30Q = await query(`
    SELECT COUNT(*) as count,
      SUM(CASE WHEN session_pnl > 0 THEN 1 ELSE 0 END) as wins,
      AVG(session_pnl) as avg_pnl
    FROM daily_performance_log
    WHERE trade_date >= $1 AND trade_date <= $2
      AND structural_state = $3 AND sufficient_session_data = true
  `, [thirtyDaysAgoStr, tradeDate, d.structural_state]);
  const l30 = l30Q.rows[0];

  const existingQ = await query(`
    SELECT * FROM condition_memory
    WHERE structural_state=$1 AND nl30_bucket=$2 AND opening_call=$3
      AND a_signal_quality=$4 AND confluence_bucket=$5 AND counter_trend=$6
  `, [d.structural_state, nl30Bucket, d.opening_call||'NO_SIGNAL',
      d.a_signal_quality||'NO_SIGNAL', confluenceBucket, d.counter_trend||false]);

  if (existingQ.rows[0]) {
    const row = existingQ.rows[0];
    const n = row.occurrences + 1;
    const wins = row.wins + (isWin ? 1 : 0);
    const losses = row.losses + (isLoss ? 1 : 0);
    const t1Hits = row.t1_hits + (d.t1_hit ? 1 : 0);
    const stops = row.stops + (d.stopped_out ? 1 : 0);
    const totalPnl = parseFloat(row.total_pnl||0) + parseFloat(d.session_pnl||0);
    const winRate = wins / n;
    const winRate30 = l30.count > 0 ? l30.wins / l30.count : null;
    const trend = winRate30 != null && n >= 10
      ? (winRate30 - winRate > 0.05 ? 'IMPROVING' : winRate30 - winRate < -0.05 ? 'DEGRADING' : 'STABLE')
      : null;

    await query(`
      UPDATE condition_memory SET
        occurrences=$1, wins=$2, losses=$3, t1_hits=$4, stops=$5, total_pnl=$6,
        win_rate=$7, t1_hit_rate=$8, avg_pnl=$9,
        occurrences_last30=$10, wins_last30=$11, win_rate_last30=$12, avg_pnl_last30=$13,
        win_rate_trend=$14, sufficient_data=$15, last_seen=$16, updated_at=NOW()
      WHERE id=$17
    `, [n, wins, losses, t1Hits, stops, totalPnl,
        winRate, t1Hits/n, totalPnl/n,
        parseInt(l30.count)||0, parseInt(l30.wins)||0,
        winRate30, parseFloat(l30.avg_pnl)||null,
        trend, n >= 20, tradeDate, row.id]);
  } else {
    const winsNew = isWin ? 1 : 0;
    const lossesNew = isLoss ? 1 : 0;
    const pnlNew = parseFloat(d.session_pnl) || 0;
    await query(`
      INSERT INTO condition_memory (
        structural_state, nl30_bucket, opening_call, a_signal_quality, confluence_bucket, counter_trend,
        occurrences, wins, losses, t1_hits, stops, total_pnl,
        win_rate, t1_hit_rate, avg_pnl,
        occurrences_last30, wins_last30, win_rate_last30, avg_pnl_last30,
        sufficient_data, first_seen, last_seen
      ) VALUES ($1,$2,$3,$4,$5,$6, 1,$7,$8,$9,$10,$11, $12,$13,$14, 1,$7,$12,$14, false,$15,$15)
    `, [d.structural_state, nl30Bucket, d.opening_call||'NO_SIGNAL',
        d.a_signal_quality||'NO_SIGNAL', confluenceBucket, d.counter_trend||false,
        winsNew, lossesNew,
        d.t1_hit ? 1 : 0, d.stopped_out ? 1 : 0,
        pnlNew,
        winsNew,          // win_rate = wins/1 = wins for first occurrence
        d.t1_hit ? 1 : 0, // t1_hit_rate
        pnlNew,           // avg_pnl = pnl/1 for first occurrence
        tradeDate]);
  }
  console.log(`[pattern] ${tradeDate}: condition_memory updated — ${d.structural_state}/${nl30Bucket}/${confluenceBucket}`);
}

// ── STEP 3: Recalculate pattern_stats ──────────────────────────────────────────

export async function recalculatePatternStats(tradeDate) {
  for (const days of [30, 60, 90]) {
    const windowStart = new Date(tradeDate);
    windowStart.setDate(windowStart.getDate() - days);
    const windowStartStr = windowStart.toISOString().split('T')[0];
    const priorStart = new Date(windowStart);
    priorStart.setDate(priorStart.getDate() - days);
    const priorStartStr = priorStart.toISOString().split('T')[0];

    const statesQ = await query(`
      SELECT DISTINCT structural_state FROM daily_performance_log
      WHERE trade_date >= $1 AND trade_date <= $2 AND sufficient_session_data = true
    `, [windowStartStr, tradeDate]);

    for (const { structural_state } of statesQ.rows) {
      const cur = await query(`
        SELECT COUNT(*) as sessions, AVG(win_rate) as avg_wr,
          AVG(session_pnl) as avg_pnl,
          AVG(CASE WHEN t1_hit THEN 1.0 ELSE 0.0 END) as t1_rate,
          AVG(CASE WHEN stopped_out THEN 1.0 ELSE 0.0 END) as stop_rate,
          SUM(session_pnl) as total_pnl
        FROM daily_performance_log
        WHERE trade_date >= $1 AND trade_date <= $2
          AND structural_state = $3 AND sufficient_session_data = true
      `, [windowStartStr, tradeDate, structural_state]);

      const prior = await query(`
        SELECT AVG(win_rate) as avg_wr FROM daily_performance_log
        WHERE trade_date >= $1 AND trade_date < $2
          AND structural_state = $3 AND sufficient_session_data = true
      `, [priorStartStr, windowStartStr, structural_state]);

      const c = cur.rows[0], p = prior.rows[0];
      const curWr = parseFloat(c.avg_wr), prWr = parseFloat(p.avg_wr);
      const diff = !isNaN(curWr) && !isNaN(prWr) ? curWr - prWr : null;
      const trend = diff != null ? (diff > 0.10 ? 'IMPROVING' : diff < -0.10 ? 'DEGRADING' : 'STABLE') : null;
      const degrading = trend === 'DEGRADING';

      await query(`
        INSERT INTO pattern_stats (
          calculated_date, lookback_days, structural_state,
          total_sessions, avg_win_rate, avg_pnl_per_session,
          t1_hit_rate, stop_rate, total_pnl,
          win_rate_prior_window, win_rate_trend, degrading_alert
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT (calculated_date, lookback_days, structural_state) DO UPDATE SET
          total_sessions=EXCLUDED.total_sessions, avg_win_rate=EXCLUDED.avg_win_rate,
          avg_pnl_per_session=EXCLUDED.avg_pnl_per_session, t1_hit_rate=EXCLUDED.t1_hit_rate,
          stop_rate=EXCLUDED.stop_rate, total_pnl=EXCLUDED.total_pnl,
          win_rate_prior_window=EXCLUDED.win_rate_prior_window,
          win_rate_trend=EXCLUDED.win_rate_trend, degrading_alert=EXCLUDED.degrading_alert
      `, [tradeDate, days, structural_state,
          parseInt(c.sessions)||0, isNaN(curWr)?null:curWr,
          parseFloat(c.avg_pnl)||null, parseFloat(c.t1_rate)||null,
          parseFloat(c.stop_rate)||null, parseFloat(c.total_pnl)||null,
          isNaN(prWr)?null:prWr, trend, degrading]);
    }
  }
  console.log(`[pattern] ${tradeDate}: pattern_stats recalculated`);
}

// ── Main nightly runner ────────────────────────────────────────────────────────

export async function runNightlyUpdate(tradeDate, io = null) {
  console.log(`[pattern] Starting nightly update for ${tradeDate}`);
  try {
    const logResult = await populateDailyLog(tradeDate, io);
    if (!logResult) return { skipped: true };

    await updateConditionMemory(tradeDate);
    await recalculatePatternStats(tradeDate);

    const degradingQ = await query(`
      SELECT structural_state FROM pattern_stats
      WHERE calculated_date = $1 AND lookback_days = 30 AND degrading_alert = true
    `, [tradeDate]);
    const degradingStates = degradingQ.rows.map(r => r.structural_state);

    const cmCountQ = await query(`SELECT COUNT(*) as n FROM condition_memory`);
    const combinationsUpdated = parseInt(cmCountQ.rows[0]?.n) || 0;

    if (io) {
      io.emit('pattern-memory-updated', { date: tradeDate, degradingAlerts: degradingStates, combinationsUpdated });
    }
    console.log(`[pattern] Nightly update complete for ${tradeDate}`);
    return { success: true, tradeDate, degradingAlerts: degradingStates, combinationsUpdated };
  } catch (err) {
    console.error(`[pattern] Nightly update failed for ${tradeDate}:`, err.message);
    return { error: err.message };
  }
}
