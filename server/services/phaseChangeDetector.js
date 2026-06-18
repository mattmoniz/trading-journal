import { query } from '../db.js';

const PROXIMITY_POINTS = 20;
const VOLUME_LOOKBACK = 3;
const DELTA_LOOKBACK = 5;
const RANGE_LOOKBACK = 3;
const PROFILE_LOOKBACK = 10;
const MIN_CONDITIONS = 3;
const DEDUPE_WINDOW_MINUTES = 15;
const BARS_NEEDED = Math.max(DELTA_LOOKBACK, PROFILE_LOOKBACK) + 2;

// ── Structural Levels ──────────────────────────────────────────────────────

async function getVolProfileForDate(dateStr) {
  const r = await query(`
    WITH vp AS (
      SELECT ROUND(low/0.25)*0.25 as px, SUM(volume) as vol
      FROM price_bars_primary WHERE symbol='NQ' AND ts::date=$1
        AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
      GROUP BY ROUND(low/0.25)*0.25
    ), total AS (SELECT SUM(vol) as t FROM vp),
    poc_row AS (SELECT px as poc_px FROM vp ORDER BY vol DESC LIMIT 1)
    SELECT p.poc_px::float as poc,
      (SELECT MAX(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px DESC) cv FROM vp WHERE px>=p.poc_px) s WHERE cv<=(SELECT t*0.35 FROM total))::float as vah,
      (SELECT MIN(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px ASC)  cv FROM vp WHERE px<=p.poc_px) s WHERE cv<=(SELECT t*0.35 FROM total))::float as val
    FROM vp, poc_row p GROUP BY p.poc_px LIMIT 1
  `, [dateStr]);
  return r.rows[0] || null;
}

export async function getStructuralLevels(tradeDate) {
  const levels = [];

  // ── Composite VAL/VAH/POC (5-day TPO) ───────────────────────────────────
  try {
    const tpoQ = await query(`
      WITH bars AS (
        SELECT ROUND(low/0.25)*0.25 as lo, ROUND(high/0.25)*0.25 as hi
        FROM price_bars_primary WHERE symbol='NQ'
          AND ts::date >= $1::date - INTERVAL '5 days'
          AND ts::date < $1::date
          AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
      )
      SELECT ROUND((lo + s*0.25)::numeric, 2)::float as px, COUNT(*)::int as tpo
      FROM bars, generate_series(0, ROUND((hi-lo)/0.25)::int) s
      GROUP BY px ORDER BY px ASC
    `, [tradeDate]);

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
      levels.push({ type: 'COMPOSITE_VAH', price: profile[hi].px });
      levels.push({ type: 'COMPOSITE_VAL', price: profile[lo].px });
      levels.push({ type: 'COMPOSITE_POC', price: poc.px });
    }
  } catch (_) {}

  // ── Prior day VAL/VAH/POC ────────────────────────────────────────────────
  try {
    const pdQ = await query(`
      SELECT ts::date::text as date FROM price_bars_primary
      WHERE symbol='NQ' AND ts::date < $1 AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
      ORDER BY ts::date DESC LIMIT 1
    `, [tradeDate]);
    if (pdQ.rows[0]) {
      const pd = await getVolProfileForDate(pdQ.rows[0].date);
      if (pd) {
        if (pd.vah) levels.push({ type: 'PRIOR_DAY_VAH', price: pd.vah });
        if (pd.val) levels.push({ type: 'PRIOR_DAY_VAL', price: pd.val });
        if (pd.poc) levels.push({ type: 'PRIOR_DAY_POC', price: pd.poc });
      }
    }
  } catch (_) {}

  // ── Bracket HIGH/LOW: max VAH / min VAL across last 5 sessions ───────────
  try {
    const last5Q = await query(`
      SELECT DISTINCT ts::date::text as date FROM price_bars_primary
      WHERE symbol='NQ' AND ts::date < $1 AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
      ORDER BY date DESC LIMIT 5
    `, [tradeDate]);
    const profiles = (await Promise.all(last5Q.rows.map(r => getVolProfileForDate(r.date)))).filter(Boolean);
    if (profiles.length >= 2) {
      const bracketHigh = Math.max(...profiles.map(p => p.vah).filter(Boolean));
      const bracketLow  = Math.min(...profiles.map(p => p.val).filter(Boolean));
      if (bracketHigh) levels.push({ type: 'BRACKET_HIGH', price: bracketHigh });
      if (bracketLow)  levels.push({ type: 'BRACKET_LOW',  price: bracketLow });
    }
  } catch (_) {}

  return levels;
}

// Find nearest level to current price
function nearestLevel(currentPrice, levels) {
  let best = null, bestDist = Infinity;
  for (const lv of levels) {
    const dist = Math.abs(currentPrice - lv.price);
    if (dist < bestDist) { bestDist = dist; best = lv; }
  }
  return best ? { level: best, distance: bestDist } : null;
}

// ── Condition Evaluators ───────────────────────────────────────────────────

function evalVolumeDecl(bars) {
  // bars[0] = most recent. Need VOLUME_LOOKBACK bars each lower than prior.
  if (bars.length < VOLUME_LOOKBACK + 1) return false;
  for (let i = 0; i < VOLUME_LOOKBACK; i++) {
    if (bars[i].volume >= bars[i + 1].volume) return false;
  }
  return true;
}

function evalDeltaDiverg(bars) {
  // Compute session delta as running sum of (ask_volume - bid_volume)
  if (bars.length < DELTA_LOOKBACK) return { diverging: false, hasDelta: false };
  const hasDelta = bars.some(b => b.bid_volume != null && b.ask_volume != null);
  if (!hasDelta) return { diverging: false, hasDelta: false };

  // Build running delta sum from oldest to newest in the window
  const window = bars.slice(0, DELTA_LOOKBACK).reverse(); // oldest first
  let runSum = 0;
  const deltas = window.map(b => {
    runSum += ((b.ask_volume || 0) - (b.bid_volume || 0));
    return { close: parseFloat(b.close), delta: runSum };
  });

  // Price making new low but delta making higher low = bearish divergence (exhaustion of down move)
  // Price making new high but delta making lower high = bullish divergence (exhaustion of up move)
  const prices = deltas.map(d => d.close);
  const ds = deltas.map(d => d.delta);
  const priceMin = Math.min(...prices), priceMax = Math.max(...prices);
  const deltaMin = Math.min(...ds), deltaMax = Math.max(...ds);
  const latestPrice = prices[prices.length - 1];
  const latestDelta = ds[ds.length - 1];

  // Bearish divergence: price at new low, delta not at new low (higher low)
  const bearishDiv = (latestPrice <= priceMin * 1.001) && (latestDelta > deltaMin * 0.99);
  // Bullish divergence: price at new high, delta not at new high (lower high)
  const bullishDiv = (latestPrice >= priceMax * 0.999) && (latestDelta < deltaMax * 1.01);

  return { diverging: bearishDiv || bullishDiv, hasDelta: true };
}

function evalRangeCompr(bars) {
  if (bars.length < RANGE_LOOKBACK + 1) return false;
  for (let i = 0; i < RANGE_LOOKBACK; i++) {
    const r0 = parseFloat(bars[i].high) - parseFloat(bars[i].low);
    const r1 = parseFloat(bars[i + 1].high) - parseFloat(bars[i + 1].low);
    if (r0 >= r1) return false;
  }
  return true;
}

function evalProfileStopped(bars) {
  if (bars.length < PROFILE_LOOKBACK + 1) return false;
  const window = bars.slice(0, PROFILE_LOOKBACK + 1);
  // Determine direction from older portion
  const oldClose = parseFloat(window[PROFILE_LOOKBACK].close);
  const newClose = parseFloat(window[0].close);
  const drift = newClose - oldClose;
  if (Math.abs(drift) < 2) return false; // no clear direction

  if (drift > 0) {
    // Uptrend: check if no new high made in last PROFILE_LOOKBACK bars
    const refHigh = parseFloat(window[PROFILE_LOOKBACK].high);
    const recentMax = Math.max(...window.slice(0, PROFILE_LOOKBACK).map(b => parseFloat(b.high)));
    return recentMax <= refHigh;
  } else {
    // Downtrend: check if no new low made in last PROFILE_LOOKBACK bars
    const refLow = parseFloat(window[PROFILE_LOOKBACK].low);
    const recentMin = Math.min(...window.slice(0, PROFILE_LOOKBACK).map(b => parseFloat(b.low)));
    return recentMin >= refLow;
  }
}

function priorDirection(bars) {
  if (bars.length < 10) return { direction: 'BALANCED', barsInMove: 0 };
  const window = bars.slice(0, 10);
  const oldest = parseFloat(window[9].close);
  const newest = parseFloat(window[0].close);
  const diff = newest - oldest;
  let barsInMove = 0;
  const dir = diff > 10 ? 'DRIVE_UP' : diff < -10 ? 'DRIVE_DOWN' : 'BALANCED';
  if (dir !== 'BALANCED') {
    for (let i = 0; i < window.length - 1; i++) {
      if (dir === 'DRIVE_UP' && parseFloat(window[i].close) >= parseFloat(window[i + 1].close)) barsInMove++;
      else if (dir === 'DRIVE_DOWN' && parseFloat(window[i].close) <= parseFloat(window[i + 1].close)) barsInMove++;
      else break;
    }
  }
  return { direction: dir, barsInMove };
}

// ── Duplicate Prevention ───────────────────────────────────────────────────

async function isDuplicate(tradeDate, levelType) {
  const r = await query(`
    SELECT id FROM phase_change_alerts
    WHERE trade_date = $1 AND level_type = $2
      AND alert_time > NOW() - INTERVAL '${DEDUPE_WINDOW_MINUTES} minutes'
    LIMIT 1
  `, [tradeDate, levelType]);
  return r.rows.length > 0;
}

// ── Main Detection ─────────────────────────────────────────────────────────

let _lastState = null; // cached for fallback polling endpoint

export async function detectPhaseChange(io, tradeDate) {
  try {
    // Market hours guard: 9:30–11:00 AM ET strictly
    const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const totalMins = nowET.getHours() * 60 + nowET.getMinutes();
    const openMins = 9 * 60 + 30;
    const closeMins = 11 * 60;
    if (totalMins < openMins || totalMins >= closeMins) {
      const outsideState = { outsideHours: true, conditionsMet: 0 };
      _lastState = outsideState;
      if (io) io.emit('condition-state', outsideState);
      return;
    }

    if (!tradeDate) tradeDate = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

    // Fetch recent bars (most recent first)
    const barsQ = await query(`
      SELECT ts, open::float, high::float, low::float, close::float,
        volume, num_trades, bid_volume, ask_volume
      FROM price_bars_primary
      WHERE symbol='NQ' AND ts::date=$1
        AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
      ORDER BY ts DESC LIMIT $2
    `, [tradeDate, BARS_NEEDED]);

    const bars = barsQ.rows;
    if (bars.length < 3) {
      if (io) io.emit('condition-state', { outsideHours: false, conditionsMet: 0, insufficientData: true });
      return;
    }

    const currentPrice = parseFloat(bars[0].close);
    const barTs = bars[0].ts;

    // Evaluate conditions
    const volumeDeclining = evalVolumeDecl(bars);
    const { diverging: deltaDiverging, hasDelta } = evalDeltaDiverg(bars);
    const rangeCompressing = evalRangeCompr(bars);
    const profileStopped = evalProfileStopped(bars);

    const levels = await getStructuralLevels(tradeDate);
    const nearest = nearestLevel(currentPrice, levels);
    const nearLevel = nearest ? nearest.distance <= PROXIMITY_POINTS : false;
    const distance = nearest ? nearest.distance : null;
    const nearLevelType = nearest?.level?.type || null;
    const nearLevelPrice = nearest?.level?.price || null;

    let conditionsMet = 0;
    if (nearLevel) conditionsMet++;
    if (volumeDeclining) conditionsMet++;
    if (deltaDiverging) conditionsMet++;
    if (rangeCompressing) conditionsMet++;
    if (profileStopped) conditionsMet++;

    const { direction: priorPhaseDir, barsInMove } = priorDirection(bars);

    // Weis effort-vs-result: volume AND bar body declining on last 3 bars while A signal active
    let weisWarning = false;
    try {
      const signalQ = await query(
        `SELECT a_up_fired, a_down_fired FROM acd_daily_log WHERE trade_date=$1`, [tradeDate]
      );
      const hasSignal = signalQ.rows[0] && (signalQ.rows[0].a_up_fired || signalQ.rows[0].a_down_fired);
      if (hasSignal && bars.length >= 3) {
        const b2 = bars[0], b1 = bars[1], b0 = bars[2]; // b2=most recent (bars DESC)
        const vol2 = Number(b2.volume), vol1 = Number(b1.volume), vol0 = Number(b0.volume);
        const body2 = Math.abs(parseFloat(b2.close) - parseFloat(b2.open));
        const body1 = Math.abs(parseFloat(b1.close) - parseFloat(b1.open));
        const body0 = Math.abs(parseFloat(b0.close) - parseFloat(b0.open));
        const volDeclining  = vol2  < vol1  && vol1  < vol0;
        const bodyDeclining = body2 < body1 && body1 < body0;
        weisWarning = volDeclining && bodyDeclining;
      }
    } catch (_) {}

    const state = {
      outsideHours: false,
      timestamp: barTs,
      price: currentPrice,
      nearLevel,
      nearLevelType,
      nearLevelPrice,
      distanceToLevel: distance != null ? Math.round(distance * 4) / 4 : null,
      volumeDeclining,
      deltaDiverging,
      rangeCompressing,
      profileStopped,
      conditionsMet,
      hasDelta,
      priorDirection: priorPhaseDir,
      barsInMove,
      weisWarning,
    };
    _lastState = state;

    // Always broadcast condition state
    if (io) io.emit('condition-state', state);
    // Weis warning as targeted event so frontend can subscribe without processing full condition state
    if (io) io.emit('weis-warning', { active: weisWarning, price: currentPrice });

    // Create alert only if threshold met and near a structural level
    if (conditionsMet >= MIN_CONDITIONS && nearLevel && nearLevelType) {
      const dup = await isDuplicate(tradeDate, nearLevelType);
      if (!dup) {
        const ins = await query(`
          INSERT INTO phase_change_alerts (
            trade_date, alert_time, price_at_alert, structural_level, level_type,
            distance_to_level, near_structural_level, volume_declining, delta_diverging,
            range_compressing, profile_stopped, conditions_met,
            delta_source, prior_phase_direction, bars_in_current_move
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
          RETURNING id
        `, [
          tradeDate, barTs, currentPrice, nearLevelPrice, nearLevelType,
          distance, nearLevel, volumeDeclining, deltaDiverging,
          rangeCompressing, profileStopped, conditionsMet,
          hasDelta ? 'AUTO' : 'UNAVAILABLE',
          priorPhaseDir, barsInMove,
        ]);

        const alertId = ins.rows[0]?.id;

        // Look up historical rate from backtest
        const btQ = await query(`
          SELECT results_by_combo FROM phase_change_backtest_results
          ORDER BY run_date DESC LIMIT 1
        `);
        let historicalRate = null, historicalCount = null;
        if (btQ.rows[0]?.results_by_combo) {
          const combo = btQ.rows[0].results_by_combo;
          const key = `${nearLevelType}_${conditionsMet}`;
          if (combo[key] && combo[key].n >= 10) {
            historicalRate = combo[key].reversalRate;
            historicalCount = combo[key].n;
          }
        }

        if (io) io.emit('phase-change-alert', {
          alertId, conditionsMet, levelType: nearLevelType,
          levelPrice: nearLevelPrice, price: currentPrice,
          historicalRate, historicalCount,
        });
      }
    }
  } catch (err) {
    console.error('[phaseChangeDetector] error:', err.message);
  }
}

export function getLastState() {
  return _lastState;
}
