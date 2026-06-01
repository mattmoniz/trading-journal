import { query } from '../db.js';
import { getStructuralLevels } from './phaseChangeDetector.js';

const MIN_SAMPLE = 10;

function volDeclForBars(bars, lookback) {
  if (bars.length < lookback + 1) return false;
  for (let i = 0; i < lookback; i++) {
    if (bars[i].volume >= bars[i + 1].volume) return false;
  }
  return true;
}

function deltaForBars(bars, lookback) {
  if (bars.length < lookback) return { diverging: false, hasDelta: false };
  const hasDelta = bars.some(b => b.bid_volume != null && b.ask_volume != null);
  if (!hasDelta) return { diverging: false, hasDelta: false };
  const window = bars.slice(0, lookback).reverse();
  let runSum = 0;
  const deltas = window.map(b => {
    runSum += ((b.ask_volume || 0) - (b.bid_volume || 0));
    return { close: parseFloat(b.close), delta: runSum };
  });
  const prices = deltas.map(d => d.close);
  const ds = deltas.map(d => d.delta);
  const priceMin = Math.min(...prices), priceMax = Math.max(...prices);
  const deltaMin = Math.min(...ds), deltaMax = Math.max(...ds);
  const latestPrice = prices[prices.length - 1];
  const latestDelta = ds[ds.length - 1];
  const bearish = (latestPrice <= priceMin * 1.001) && (latestDelta > deltaMin * 0.99);
  const bullish = (latestPrice >= priceMax * 0.999) && (latestDelta < deltaMax * 1.01);
  return { diverging: bearish || bullish, hasDelta: true };
}

function rangeComprForBars(bars, lookback) {
  if (bars.length < lookback + 1) return false;
  for (let i = 0; i < lookback; i++) {
    const r0 = parseFloat(bars[i].high) - parseFloat(bars[i].low);
    const r1 = parseFloat(bars[i + 1].high) - parseFloat(bars[i + 1].low);
    if (r0 >= r1) return false;
  }
  return true;
}

function profileStopForBars(bars, lookback) {
  if (bars.length < lookback + 1) return false;
  const window = bars.slice(0, lookback + 1);
  const oldClose = parseFloat(window[lookback].close);
  const newClose = parseFloat(window[0].close);
  const drift = newClose - oldClose;
  if (Math.abs(drift) < 2) return false;
  if (drift > 0) {
    const refHigh = parseFloat(window[lookback].high);
    return Math.max(...window.slice(0, lookback).map(b => parseFloat(b.high))) <= refHigh;
  } else {
    const refLow = parseFloat(window[lookback].low);
    return Math.min(...window.slice(0, lookback).map(b => parseFloat(b.low))) >= refLow;
  }
}

function priorDir5(bars) {
  if (bars.length < 5) return 'BALANCED';
  const diff = parseFloat(bars[0].close) - parseFloat(bars[4].close);
  return diff > 10 ? 'DRIVE_UP' : diff < -10 ? 'DRIVE_DOWN' : 'BALANCED';
}

export async function runPhaseChangeBacktest(params, onProgress) {
  const {
    proximityPoints = 20, minConditions = 3,
    volumeLookback = 3, deltaLookback = 5, rangeLookback = 3,
    profileLookback = 10, forwardWindowMinutes = 30,
    reversalThresholdPoints = 15, startDate = null, endDate = null,
  } = params;

  const startMs = Date.now();

  // Get sessions with price bars
  const sessQ = await query(`
    SELECT DISTINCT ts::date::text as date FROM price_bars WHERE symbol='NQ'
      AND EXTRACT(hour FROM ts) BETWEEN 9 AND 11
      ${startDate ? `AND ts::date >= '${startDate}'` : ''}
      ${endDate ? `AND ts::date <= '${endDate}'` : ''}
    ORDER BY date ASC
  `);
  const sessions = sessQ.rows.map(r => r.date);

  const BARSNEEDED = Math.max(deltaLookback, profileLookback) + forwardWindowMinutes + 5;
  let totalBars = 0;
  const events = [];
  const dedupeSet = new Set(); // date|levelType|barIndex

  for (let si = 0; si < sessions.length; si++) {
    const date = sessions[si];
    onProgress(Math.round((si / sessions.length) * 85));

    const levels = await getStructuralLevels(date);
    if (!levels.length) continue;

    const barsQ = await query(`
      SELECT ts, open::float, high::float, low::float, close::float,
        volume, num_trades, bid_volume, ask_volume
      FROM price_bars
      WHERE symbol='NQ' AND ts::date=$1
        AND EXTRACT(hour FROM ts) BETWEEN 9 AND 11
      ORDER BY ts ASC
    `, [date]);

    const allBars = barsQ.rows;
    totalBars += allBars.length;
    if (allBars.length < BARSNEEDED) continue;

    // Scan each bar (most recent first in rolling window)
    for (let i = allBars.length - 1; i >= profileLookback + 1; i--) {
      const current = allBars[i];
      const price = parseFloat(current.close);
      // rolling window bars[0]=current, bars[1]=prev, etc.
      const window = allBars.slice(Math.max(0, i - BARSNEEDED + 1), i + 1).reverse();

      // Proximity check
      let nearLevel = null, nearDist = Infinity;
      for (const lv of levels) {
        const d = Math.abs(price - lv.price);
        if (d < nearDist) { nearDist = d; nearLevel = lv; }
      }
      if (nearDist > proximityPoints) continue;

      const dedupeKey = `${date}|${nearLevel.type}|${Math.floor(i / 15)}`;
      if (dedupeSet.has(dedupeKey)) continue;

      // Count conditions
      const volDecl = volDeclForBars(window, volumeLookback);
      const { diverging: deltaDiv } = deltaForBars(window, deltaLookback);
      const rangeCompr = rangeComprForBars(window, rangeLookback);
      const profStop = profileStopForBars(window, profileLookback);
      const condsMet = [true, volDecl, deltaDiv, rangeCompr, profStop].filter(Boolean).length;

      if (condsMet < minConditions) continue;

      // Measure forward outcome
      const fwdBars = allBars.slice(i + 1, i + 1 + forwardWindowMinutes);
      if (fwdBars.length < Math.min(forwardWindowMinutes, 5)) continue;

      const lastFwd = fwdBars[fwdBars.length - 1];
      const fwdMove = parseFloat(lastFwd.close) - price;
      const prior = priorDir5(window);
      const reversed = prior === 'DRIVE_UP' ? fwdMove <= -reversalThresholdPoints
        : prior === 'DRIVE_DOWN' ? fwdMove >= reversalThresholdPoints
        : Math.abs(fwdMove) >= reversalThresholdPoints;

      dedupeSet.add(dedupeKey);
      events.push({
        date, condsMet, levelType: nearLevel.type,
        reversed, magnitude: Math.abs(fwdMove),
      });
    }
  }

  // Aggregate
  function agg(subset) {
    if (subset.length < MIN_SAMPLE) return { n: subset.length, reversalRate: null, avgMag: null };
    const rev = subset.filter(e => e.reversed).length;
    return {
      n: subset.length,
      reversalRate: rev / subset.length,
      avgMag: subset.reduce((s, e) => s + e.magnitude, 0) / subset.length,
    };
  }

  const ev3 = events.filter(e => e.condsMet >= 3);
  const ev4 = events.filter(e => e.condsMet >= 4);
  const ev5 = events.filter(e => e.condsMet === 5);
  const a3 = agg(ev3), a4 = agg(ev4), a5 = agg(ev5);

  // By level type
  const levelTypes = [...new Set(events.map(e => e.levelType))];
  const byLevel = {};
  for (const lt of levelTypes) {
    const sub = ev3.filter(e => e.levelType === lt);
    byLevel[lt] = agg(sub);
  }

  // By combo (levelType + conditionCount)
  const byCombo = {};
  for (const e of events) {
    const key = `${e.levelType}_${e.condsMet}`;
    if (!byCombo[key]) byCombo[key] = [];
    byCombo[key].push(e);
  }
  const byComboAgg = {};
  for (const [k, v] of Object.entries(byCombo)) {
    byComboAgg[k] = agg(v);
  }

  // Best level
  let bestLevel = null, bestRate = 0, bestCount = 0, bestMag = 0;
  for (const [lt, a] of Object.entries(byLevel)) {
    if (a.n >= MIN_SAMPLE && a.reversalRate > bestRate) {
      bestLevel = lt; bestRate = a.reversalRate; bestCount = a.n; bestMag = a.avgMag;
    }
  }

  const elapsed = Math.round((Date.now() - startMs) / 1000);

  await query(`
    INSERT INTO phase_change_backtest_results (
      proximity_points, min_conditions, volume_lookback_bars, delta_lookback_bars,
      range_lookback_bars, profile_lookback_bars, forward_window_minutes,
      reversal_threshold_points, sessions_analyzed, total_bars_scanned,
      date_range_start, date_range_end,
      total_events, events_3_conditions, events_4_conditions, events_5_conditions,
      reversal_rate_3, reversal_rate_4, reversal_rate_5,
      avg_reversal_magnitude_3, avg_reversal_magnitude_4, avg_reversal_magnitude_5,
      best_level, best_level_reversal_rate, best_level_avg_magnitude, best_level_event_count,
      results_by_level, results_by_combo, run_duration_seconds
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
      $13,$14,$15,$16,$17,$18,$19,$20,$21,$22,
      $23,$24,$25,$26,$27,$28,$29
    )
  `, [
    proximityPoints, minConditions, volumeLookback, deltaLookback,
    rangeLookback, profileLookback, forwardWindowMinutes,
    reversalThresholdPoints, sessions.length, totalBars,
    sessions[0] || null, sessions[sessions.length - 1] || null,
    events.length, ev3.length, ev4.length, ev5.length,
    a3.reversalRate, a4.reversalRate, a5.reversalRate,
    a3.avgMag, a4.avgMag, a5.avgMag,
    bestLevel, bestRate || null, bestMag || null, bestCount || null,
    JSON.stringify(byLevel), JSON.stringify(byComboAgg), elapsed,
  ]);

  onProgress(100);
  return { events: events.length, sessions: sessions.length };
}
