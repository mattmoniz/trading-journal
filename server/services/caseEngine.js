/**
 * Case Engine — single evolving read of the session.
 * computeCase(tradeDate, asOf) returns a structured case object.
 * asOf supports replay: bars, setups, and delta are all filtered to <= asOf.
 *
 * HARD RULE: no single-bar reads. Confirmation windows:
 *   - Delta: 3+ consecutive bars same direction
 *   - Relative volume: 1.5x+ AND sustained 2+ bars
 *   - Level hold: price bases 2+ bars without piercing
 * Anything failing its window is logged as "forming/unconfirmed" and does NOT move conviction.
 */

import { query } from '../db.js';
import { getNL, getPriorWeekRange, getGLine, getConvictionData, computeDynamicConviction } from './queries.js';
import { getStructuralLevels } from './phaseChangeDetector.js';
import { runReassessment, describeLiveReassessment } from './dayTypeReassessmentService.js';

const RTH_START = 570; // 09:30 in minutes from midnight
const REASSESSMENT_CHECKPOINTS = [660, 690, 720, 750, 780, 840, 900, 945]; // 11:00 .. 15:45 ET

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmtNum(n) {
  if (n == null || isNaN(n)) return '—';
  return Math.round(n).toLocaleString('en-US');
}

function resolveAsOf(tradeDate, asOf) {
  if (!asOf) return `${tradeDate} 16:00:00`;
  if (/^\d{2}:\d{2}$/.test(asOf))   return `${tradeDate} ${asOf}:00`;
  if (/^\d{2}:\d{2}:\d{2}$/.test(asOf)) return `${tradeDate} ${asOf}`;
  return asOf; // already full datetime
}

// price_bars.ts is stored as ET naive timestamp; pg reads it as UTC
// Use getUTC* to recover the stored ET value without re-interpreting it
function barMinutes(bar) {
  const ts = new Date(bar.ts);
  return ts.getUTCHours() * 60 + ts.getUTCMinutes();
}

function trailingAvgVol(bars, endIdx, n = 20) {
  const window = bars.slice(Math.max(0, endIdx - n), endIdx);
  if (!window.length) return null;
  return window.reduce((s, b) => s + Number(b.volume), 0) / window.length;
}

// 3+ consecutive bars same delta sign → confirmed direction.
// Scans last `lookback` bars for the most recent completed n-bar streak.
// Returns direction + barsAgo (0 = ends at current bar; persists for a few bars after a streak forms).
function confirmedDeltaDir(bars, n = 3, lookback = 15) {
  const window = bars.slice(Math.max(0, bars.length - lookback));
  if (window.length < n) return null;
  for (let endIdx = window.length - 1; endIdx >= n - 1; endIdx--) {
    const slice  = window.slice(endIdx - n + 1, endIdx + 1);
    const deltas = slice.map(b => Number(b.ask_volume || 0) - Number(b.bid_volume || 0));
    const net    = deltas.reduce((s, d) => s + d, 0);
    const barsAgo = window.length - 1 - endIdx;
    if (deltas.every(d => d > 0)) return { direction: 'LONG',  streak: n, net, barsAgo };
    if (deltas.every(d => d < 0)) return { direction: 'SHORT', streak: n, net, barsAgo };
  }
  return null;
}

// Relative volume 1.5x+ sustained 2+ bars
function confirmedHighVol(bars, threshold = 1.5, n = 2) {
  if (bars.length < n + 5) return { confirmed: false, relVol: null };
  const relVols = [];
  for (let i = bars.length - n; i < bars.length; i++) {
    const avg = trailingAvgVol(bars, i, 20);
    if (!avg) return { confirmed: false, relVol: null };
    relVols.push(Number(bars[i].volume) / avg);
  }
  const confirmed = relVols.every(rv => rv >= threshold);
  return { confirmed, relVol: confirmed ? Math.round(relVols[relVols.length-1] * 10) / 10 : null };
}

// Level holds: price stayed 2+ bars without piercing (for support: low stayed >= level)
function levelHolding(bars, levelPrice, role, proximityPts = 10, n = 2) {
  if (bars.length < n) return false;
  const recent = bars.slice(-n);
  if (role === 'SUPPORT')    return recent.every(b => Number(b.low)  >= levelPrice - proximityPts);
  if (role === 'RESISTANCE') return recent.every(b => Number(b.high) <= levelPrice + proximityPts);
  return false;
}

// Opening type from first 5 bars
export function classifyOpeningType(bars) {
  if (bars.length < 5) return 'FORMING';
  const first5  = bars.slice(0, 5);
  const open    = Number(first5[0].open);
  const close5  = Number(first5[4].close);
  const high5   = Math.max(...first5.map(b => Number(b.high)));
  const low5    = Math.min(...first5.map(b => Number(b.low)));
  const range5  = high5 - low5;
  const drift   = close5 - open;

  // Open Drive: every bar extends same direction, no meaningful retracement
  const driveLong  = drift >  20 && first5.every((b,i) => i === 0 || Number(b.low)  >= Number(first5[i-1].low)  - 3);
  const driveShort = drift < -20 && first5.every((b,i) => i === 0 || Number(b.high) <= Number(first5[i-1].high) + 3);
  if (driveLong)  return 'OPEN_DRIVE_LONG';
  if (driveShort) return 'OPEN_DRIVE_SHORT';

  // Open Auction: closes near open, range tight
  if (Math.abs(drift) < 12 && range5 < 35) return 'OPEN_AUCTION';

  // Open Test Drive: initial probe one way, then reversed
  if (range5 > 18) {
    if (low5 < open - 8  && close5 > open + 8)  return 'OPEN_TEST_DRIVE_LONG';
    if (high5 > open + 8 && close5 < open - 8)  return 'OPEN_TEST_DRIVE_SHORT';
  }

  return 'OPEN_BALANCED';
}

// Live day-type classifier accuracy — computed from daytype_accuracy_log
// (predictions vs confirmed ground truth; see scripts/backfill_accuracy_log.js).
// Cached briefly since the log only gains rows once per session, at EOD.
let _dayTypeAccuracyCache = null;
let _dayTypeAccuracyCachedAt = 0;
const DAYTYPE_ACCURACY_CACHE_MS = 5 * 60 * 1000;

export async function getDayTypeAccuracyStats() {
  const now = Date.now();
  if (_dayTypeAccuracyCache && (now - _dayTypeAccuracyCachedAt) < DAYTYPE_ACCURACY_CACHE_MS) {
    return _dayTypeAccuracyCache;
  }
  const r = await query(`SELECT intraday_call, matched FROM daytype_accuracy_log WHERE intraday_call IS NOT NULL`);
  const rows    = r.rows;
  const total   = rows.length;
  const matches = rows.filter(x => x.matched).length;

  const byType = {};
  for (const t of ['TREND', 'BALANCE', 'TURBULENT']) {
    const predicted = rows.filter(x => x.intraday_call === t);
    const correct   = predicted.filter(x => x.matched).length;
    byType[t] = {
      predicted: predicted.length,
      correct,
      precision: predicted.length > 0 ? (correct / predicted.length * 100) : null,
    };
  }

  const stats = {
    overall: { matches, total, pct: total > 0 ? (matches / total * 100) : null },
    byType,
  };
  _dayTypeAccuracyCache    = stats;
  _dayTypeAccuracyCachedAt = now;
  return stats;
}

// Precision for the predicted type — "when the classifier calls X, how often is X correct".
// This is the trust-relevant figure for a given prediction (recall — how often actual X
// days get caught — is a different question). Shows "measuring" below n=20 per type.
function dayTypeAccuracyNote(type, stats) {
  const t = stats?.byType?.[type];
  if (!t || t.predicted < 20) {
    return `measuring — ${t ? t.predicted : 0} sessions`;
  }
  return `${t.precision.toFixed(0)}% hit rate on ${type} calls (n=${t.predicted} live, see daytype_accuracy_log)`;
}

// Dalton day-type classification (LITERATURE source)
// Confidence and accuracy figures are computed live from daytype_accuracy_log — pass
// accuracyStats (from getDayTypeAccuracyStats) so the returned note reflects real numbers;
// omit it for a conservative "measuring" fallback. lowConfidence stays true while measured
// overall accuracy is below 60%, or while it hasn't been measured yet (n=0).
export function classifyDayType({ openingType, nl30, orWidth, asOfMinutes, accuracyStats = null }) {
  const overallPct    = accuracyStats?.overall?.pct;
  const lowConfidence = overallPct == null || overallPct < 60;

  if (asOfMinutes < RTH_START + 5) {
    return {
      classification: 'FORMING', probability: null, source: 'LITERATURE', sampleSize: 0,
      lowConfidence: true,
      playbook: 'Too early to classify — OR still forming.',
      whatWouldChangeIt: 'OR completes at 10:00 ET',
    };
  }

  const isDrive   = openingType.startsWith('OPEN_DRIVE');
  const isAuction = openingType === 'OPEN_AUCTION';
  const nlBull    = nl30 > 9;
  const nlBear    = nl30 < -9;
  const wideOR    = (orWidth || 0) > 80;
  const narrowOR  = (orWidth || 0) < 40;

  const longDrive = openingType.includes('LONG');
  const shortDrive = openingType.includes('SHORT');
  const alignedTrend = isDrive && wideOR && ((longDrive && nlBull) || (shortDrive && nlBear));

  if (alignedTrend) {
    const long = longDrive;
    return {
      classification: 'TREND', probability: Math.abs(nl30) > 15 ? 75 : 65, source: 'LITERATURE', sampleSize: 0,
      lowConfidence,
      accuracyNote: dayTypeAccuracyNote('TREND', accuracyStats),
      playbook: long
        ? 'Lean long. Add on pullbacks above OR High. 2R+ targets. No fades until late-session volume exhaustion.'
        : 'Lean short. Add on bounces below OR Low. 2R+ targets. No counter-trend until delta divergence.',
      whatWouldChangeIt: long
        ? 'Price fails back below OR High on above-avg volume with 3-bar bearish delta'
        : 'Price reclaims OR Low on above-avg volume with 3-bar bullish delta',
    };
  }

  if (isAuction || (narrowOR && !isDrive)) {
    return {
      classification: 'BALANCE', probability: 70, source: 'LITERATURE', sampleSize: 0,
      lowConfidence,
      accuracyNote: dayTypeAccuracyNote('BALANCE', accuracyStats),
      playbook: 'Fade extremes of developing range. 1–1.5R targets. Reduce size. Stand aside near OR midpoint.',
      whatWouldChangeIt: 'Price breaks IB extension with 2+ bars closing outside on above-avg volume',
    };
  }

  if (wideOR) {
    return {
      classification: 'TURBULENT', probability: 55, source: 'LITERATURE', sampleSize: 0,
      lowConfidence,
      accuracyNote: dayTypeAccuracyNote('TURBULENT', accuracyStats),
      playbook: 'Wide range, no conviction. Reduce size significantly. Wait for structure to form before entries.',
      whatWouldChangeIt: 'Price consolidates 2+ bars at level, then drives with delta confirmation',
    };
  }

  return {
    classification: 'BALANCE', probability: 60, source: 'LITERATURE', sampleSize: 0,
    lowConfidence,
    accuracyNote: dayTypeAccuracyNote('BALANCE', accuracyStats),
    playbook: 'No clear trend signal. Trade responsive — fade range edges. Max 1R risk.',
    whatWouldChangeIt: 'Open-drive behavior or confirmed IB break with volume',
  };
}

// Detect absorption: high volume + small body at a level
function detectAbsorption(bars, levelPrice, proximityPts = 12) {
  if (bars.length < 3) return null;
  const recent = bars.slice(-5);
  for (const bar of recent) {
    const near = Math.min(
      Math.abs(Number(bar.close) - levelPrice),
      Math.abs(Number(bar.low)   - levelPrice),
      Math.abs(Number(bar.high)  - levelPrice),
    ) <= proximityPts;
    if (!near) continue;
    const avg     = trailingAvgVol(bars, bars.indexOf(bar), 20);
    const relVol  = avg ? Number(bar.volume) / avg : null;
    const body    = Math.abs(Number(bar.close) - Number(bar.open));
    const range   = Number(bar.high) - Number(bar.low);
    if (relVol && relVol >= 1.5 && range > 0 && body < range * 0.35) {
      return {
        detected: true,
        bias: Number(bar.close) > levelPrice ? 'bullish_absorption' : 'bearish_absorption',
        relVol: Math.round(relVol * 10) / 10,
        volume: Number(bar.volume),
      };
    }
  }
  return null;
}

// Stacking: levels within 15 pts get extra weight
function applyStacking(levels) {
  return levels.map(lv => {
    const nearby = levels.filter(o => o !== lv && Math.abs(o.price - lv.price) <= 15);
    if (!nearby.length) return { ...lv, stacked: false };
    const tfs = [...new Set([...lv.timeframes, ...nearby.flatMap(n => n.timeframes)])];
    return {
      ...lv, stacked: true,
      timeframes: tfs,
      stars: Math.min(3, lv.stars + (tfs.length > 1 ? 1 : 0)),
    };
  });
}

// Scan all bars in the session to find if the trigger was EVER active.
// Used for latching: once fired it stays ACTIVE_MANAGING until a real resolution.
// Only requires a fresh (barsAgo=0) 3-bar streak at any bar — conservative baseline.
function checkSessionActivation(bars, setup, nl30, levels, dayTypeClass) {
  if (!setup) return false;
  const isLong  = /LONG|UP|BULLISH/.test(setup.setup_type);
  const stop    = Number(setup.stop_level    || 0);
  const t1      = Number(setup.t1_level      || 0);
  const entryPx = Number(setup.entry_zone_high || setup.entry_zone_low || 0);

  let base = 1; // +1 validated setup
  if ((isLong && nl30 > 9) || (!isLong && nl30 < -9)) base += 2;
  const nearLvl = levels.find(l => Math.abs(l.price - entryPx) <= 20);
  if (nearLvl?.stars >= 2) base += 1;
  // Day-type adjustment — halved weights while accuracy is low-confidence (see getDayTypeAccuracyStats)
  if      (dayTypeClass === 'BALANCE')                                  base -= 1;
  else if (dayTypeClass === 'TURBULENT' || dayTypeClass === 'TREND')    base += 1;

  for (let i = 2; i < bars.length; i++) {
    const delta3 = [bars[i-2], bars[i-1], bars[i]].map(
      b => Number(b.ask_volume || 0) - Number(b.bid_volume || 0)
    );
    const dir = delta3.every(d => d > 0) ? 'LONG' : delta3.every(d => d < 0) ? 'SHORT' : null;
    if (!dir || dir !== (isLong ? 'LONG' : 'SHORT')) continue;

    let barImpact = base + 2; // fresh delta +2
    if (stop && t1) {
      const px  = Number(bars[i].close);
      const tgt = Math.abs(t1 - px);
      const rsk = Math.abs(px - stop);
      if (rsk > 0 && tgt / rsk >= 2.0) barImpact += 2;
    }
    if (barImpact >= 6) return true;
  }
  return false;
}

// ── Compression Detection ─────────────────────────────────────────────────────
// NR4/NR7 of opening range + prior day-range narrowing.
// Precursor: high compressionScore → expansion likely → TREND/TURBULENT day probability elevated.
async function computeCompression(tradeDate, orWidth) {
  let score = 0;
  const signals = [];

  if (orWidth && orWidth > 0) {
    const orHistQ = await query(`
      SELECT (or_high - or_low)::float AS orw
      FROM acd_daily_log
      WHERE trade_date < $1 AND or_high IS NOT NULL AND or_low IS NOT NULL
      ORDER BY trade_date DESC LIMIT 6
    `, [tradeDate]);
    const prior = orHistQ.rows.map(r => Number(r.orw)).filter(w => w > 0);

    if (prior.length >= 3) {
      const min3 = Math.min(...prior.slice(0, 3));
      if (orWidth < min3) {
        score += 3;
        signals.push(`NR4 — OR ${Math.round(orWidth)}pts narrower than prior 3 sessions (prior min ${Math.round(min3)}pts)`);
      }
      if (prior.length >= 6) {
        const min6 = Math.min(...prior);
        if (orWidth < min6) {
          score += 2;
          signals.push(`NR7 — OR ${Math.round(orWidth)}pts narrowest in 7 sessions`);
        }
      }
      const avgOR = prior.reduce((a, b) => a + b, 0) / prior.length;
      if (orWidth < avgOR * 0.65) {
        score += 1;
        signals.push(`OR ${Math.round(orWidth)}pts = ${Math.round(orWidth / avgOR * 100)}% of ${Math.round(avgOR)}pt trailing avg (compressed)`);
      }
    }
  }

  // Prior-day RTH H-L ranges narrowing (proxy for value area tightening)
  const dayRngQ = await query(`
    SELECT (MAX(high) - MIN(low))::float AS rng
    FROM price_bars_primary WHERE symbol = 'NQ' AND ts::date < $1
      AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) BETWEEN 570 AND 959
    GROUP BY ts::date ORDER BY ts::date DESC LIMIT 5
  `, [tradeDate]);
  const dayRngs = dayRngQ.rows.map(r => Number(r.rng)).filter(r => r > 0);
  if (dayRngs.length >= 3) {
    const avg5 = dayRngs.reduce((a, b) => a + b, 0) / dayRngs.length;
    const avg2 = (dayRngs[0] + dayRngs[1]) / 2;
    if (avg2 < avg5 * 0.70) {
      score += 2;
      signals.push(`Day ranges narrowing — recent 2d avg ${Math.round(avg2)}pts vs 5d avg ${Math.round(avg5)}pts`);
    }
  }

  const coiled = score >= 4;
  return {
    score: Math.min(10, score),
    coiled,
    signals,
    note: coiled
      ? 'COILED — expansion likely. TREND/TURBULENT day probability elevated.'
      : score >= 2 ? 'Mild compression — monitor for expansion setup' : null,
  };
}

// ── Failed Auction Detection ──────────────────────────────────────────────────
// A probe past a key level that reverses within lookFwd bars = trapped inventory.
// 2+ failed auctions at one extreme → fuel for breakout in the opposite direction.
function detectFailedAuctions(bars, resistancePrices, supportPrices, probePts = 5, lookFwd = 5) {
  let failedAbove = 0; // probes above resistance that reversed → trapped longs → fuel SHORT
  let failedBelow = 0; // probes below support that reversed   → trapped shorts → fuel LONG
  let coolAbove = -1, coolBelow = -1;

  for (let i = 0; i < bars.length - 1; i++) {
    const bar = bars[i];
    if (i > coolAbove) {
      const probedLvl = resistancePrices.find(lvl => Number(bar.high) > lvl + probePts);
      if (probedLvl != null) {
        const fwd = bars.slice(i + 1, i + lookFwd + 1);
        if (fwd.some(b => Number(b.close) < probedLvl - probePts)) {
          failedAbove++;
          coolAbove = i + lookFwd;
        }
      }
    }
    if (i > coolBelow) {
      const probedLvl = supportPrices.find(lvl => Number(bar.low) < lvl - probePts);
      if (probedLvl != null) {
        const fwd = bars.slice(i + 1, i + lookFwd + 1);
        if (fwd.some(b => Number(b.close) > probedLvl + probePts)) {
          failedBelow++;
          coolBelow = i + lookFwd;
        }
      }
    }
  }

  return {
    failedAuctionsAbove: failedAbove,
    failedAuctionsBelow: failedBelow,
    fuelLong:  failedBelow >= 2,
    fuelShort: failedAbove >= 2,
  };
}

// ── Exit Playbook by Day Type ─────────────────────────────────────────────────
// INTERIM weights: TURBULENT n=3, TREND n=1, BALANCE n=7 (provisional backtest).
function buildExitPlaybook(dayTypeClass) {
  if (dayTypeClass === 'TREND') {
    return {
      scheme:    'HOLD_TRAIL',
      target:    'Trail stop after T1. Target 2-3x normal. Do NOT take T1 and quit.',
      rationale: 'TREND days extend far past T1. 2T bracket underperformed (0.2R — T2 never filled May 26). Trailing captures the continuation.',
      trailRule: 'T1 hit → move stop to entry. Trail 25pts behind each new extreme. Exit at trail stop or 15:45 ET.',
      note:      'INTERIM — n=1 TREND day. High MFE/T1 ratio pattern; thesis is holding longer captures the full trend range.',
    };
  }
  if (dayTypeClass === 'TURBULENT') {
    return {
      scheme:    '2T_BRACKET',
      target:    'Half at T1, half at T2 (T2 = T1 + entry-to-T1 distance).',
      rationale: 'TURBULENT: 2T bracket averaged 2.5R on 100% T1 hit rate (n=3, INTERIM). Trend extends past T1 but not indefinitely.',
      trailRule: 'T1 hit → stop to entry. Target T2 or 15:45 ET. Do not hold past T2 on TURBULENT days.',
      note:      'INTERIM — n=3. Small sample but consistent.',
    };
  }
  if (dayTypeClass === 'BALANCE') {
    return {
      scheme:    'SUPPRESSED',
      target:    'No directional trigger — BALANCE day impact penalty applied.',
      rationale: 'BALANCE days: 0% T1 hit rate (n=7, INTERIM). Trade responsive only — fade range edges, max 1R risk.',
      trailRule: null,
      note:      'If trigger fires despite BALANCE (low-conviction exception): reduce size 50%, target 1R only, no trail.',
    };
  }
  return {
    scheme:    'WAIT',
    target:    'Day type still FORMING. Wait for OR completion (10:00 ET) before entry.',
    rationale: 'Cannot classify trend vs balance before the OR is established.',
    trailRule: null,
    note:      null,
  };
}

async function getOpenGaps(tradeDate, currentPrice) {
  try {
    const rangesQ = await query(`
      SELECT d, rth_low, rth_high FROM (
        SELECT ts::date::text as d,
          MIN(low)::float as rth_low,
          MAX(high)::float as rth_high
        FROM price_bars_primary
        WHERE symbol='NQ'
          AND (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts)) BETWEEN 570 AND 959
          AND ts::date <= $1
        GROUP BY ts::date
        ORDER BY ts::date DESC
        LIMIT 40
      ) sub ORDER BY d ASC
    `, [tradeDate]);
    const sessions = rangesQ.rows;
    if (sessions.length < 2) return [];

    const gaps = [];
    for (let i = 1; i < sessions.length; i++) {
      const prev = sessions[i - 1];
      const curr = sessions[i];
      if (curr.rth_low > prev.rth_high) {
        gaps.push({ type: 'up', fromDate: prev.d, toDate: curr.d, gapLow: prev.rth_high, gapHigh: curr.rth_low });
      } else if (curr.rth_high < prev.rth_low) {
        gaps.push({ type: 'down', fromDate: prev.d, toDate: curr.d, gapLow: curr.rth_high, gapHigh: prev.rth_low });
      }
    }

    const openGaps = [];
    for (const gap of gaps) {
      const gapIdx = sessions.findIndex(s => s.d === gap.toDate);
      const gapSize = gap.gapHigh - gap.gapLow;
      let filled = false;
      let partialFillLow = gap.gapHigh;
      let partialFillHigh = gap.gapLow;

      for (let i = gapIdx + 1; i < sessions.length; i++) {
        const s = sessions[i];
        if (gap.type === 'up') {
          partialFillLow = Math.min(partialFillLow, s.rth_low);
          if (s.rth_low <= gap.gapLow) { filled = true; break; }
        } else {
          partialFillHigh = Math.max(partialFillHigh, s.rth_high);
          if (s.rth_high >= gap.gapHigh) { filled = true; break; }
        }
      }

      if (!filled) {
        const priceRelation = currentPrice == null ? null
          : currentPrice >= gap.gapHigh ? 'above'
          : currentPrice <= gap.gapLow ? 'below' : 'inside';

        openGaps.push({ ...gap, gapSize, priceRelation });
      }
    }
    return openGaps;
  } catch (e) {
    console.error('Error fetching open gaps in caseEngine:', e);
    return [];
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────

export async function computeCase(tradeDate, asOf) {
  const asOfFull = resolveAsOf(tradeDate, asOf);

  // 1. Bars up to asOf (RTH only, no lookahead)
  const barsQ = await query(`
    SELECT ts, open::float, high::float, low::float, close::float,
           volume::int, bid_volume::int, ask_volume::int
    FROM price_bars_primary
    WHERE symbol = 'NQ' AND ts::date = $1
      AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) >= ${RTH_START}
      AND ts <= $2
    ORDER BY ts
  `, [tradeDate, asOfFull]);
  const bars = barsQ.rows;

  if (!bars.length) {
    return { error: 'No RTH bar data for this date/time', asOf: asOfFull, tradeDate };
  }

  // 1b. Fetch trailing 5-session average RTH 1-minute bar volume baseline
  const statsVolQ = await query(`
    SELECT AVG(volume)::float as mean_vol
    FROM price_bars_primary
    WHERE symbol = 'NQ'
      AND ts >= ($1::date - INTERVAL '10 days')::timestamp
      AND ts < ($1::date)::timestamp
      AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) BETWEEN 570 AND 959
  `, [tradeDate]);
  const baselineAvgVol = statsVolQ.rows[0]?.mean_vol || 1000;

  const currentPrice  = Number(bars[bars.length - 1].close);
  const currentTs     = bars[bars.length - 1].ts;
  const asOfMinutes   = barMinutes(bars[bars.length - 1]);

  // Fetch open gaps and calculate gap warning
  const openGaps = await getOpenGaps(tradeDate, currentPrice);
  let gapWarning = null;
  if (asOfMinutes < 16 * 60) {
    for (const gap of openGaps) {
      if (gap.priceRelation === 'inside') {
        gapWarning = {
          severity: 'WARNING',
          title: 'Gap Fill in Progress',
          message: `NQ has entered the ${gap.type === 'up' ? 'up' : 'down'}-gap void from ${gap.fromDate} to ${gap.toDate} (${fmtNum(gap.gapLow)}–${fmtNum(gap.gapHigh)}). Expect fast travel toward ${gap.type === 'up' ? fmtNum(gap.gapLow) : fmtNum(gap.gapHigh)} (no structural support/resistance inside the void).`,
          type: 'GAP_VOID'
        };
        break;
      } else {
        const distHigh = Math.abs(currentPrice - gap.gapHigh);
        const distLow = Math.abs(currentPrice - gap.gapLow);
        if (distHigh <= 15 && currentPrice >= gap.gapHigh) {
          gapWarning = {
            severity: 'INFO',
            title: 'Gap Ceiling Proximity',
            message: `NQ is within ${fmtNum(distHigh)} pts of the gap ceiling (${fmtNum(gap.gapHigh)}). Dropping below risks a fast ${fmtNum(gap.gapSize)} pt move to complete the fill.`,
            type: 'GAP_PROXIMITY_CEILING'
          };
          break;
        } else if (distLow <= 15 && currentPrice <= gap.gapLow) {
          gapWarning = {
            severity: 'INFO',
            title: 'Gap Floor Proximity',
            message: `NQ is within ${fmtNum(distLow)} pts of the gap floor (${fmtNum(gap.gapLow)}). Rallies above risk a fast ${fmtNum(gap.gapSize)} pt move to complete the fill.`,
            type: 'GAP_PROXIMITY_FLOOR'
          };
          break;
        }
      }
    }
  }

  // 2. ACD log
  const acdQ = await query(`
    SELECT or_high::float, or_low::float, a_multiplier::float,
           a_up_level::float, a_down_level::float,
           a_up_fired, a_down_fired, c_up_confirmed, c_down_confirmed, daily_score
    FROM acd_daily_log WHERE trade_date = $1
  `, [tradeDate]);
  const acd = acdQ.rows[0] || null;

  // OR = 9:30–10:00 from bars; IB = 9:30–10:30
  const orBars = bars.filter(b => barMinutes(b) <  RTH_START + 30);
  const ibBars = bars.filter(b => barMinutes(b) <  RTH_START + 60);
  const orHigh = acd?.or_high || (orBars.length ? Math.max(...orBars.map(b => Number(b.high))) : null);
  const orLow  = acd?.or_low  || (orBars.length ? Math.min(...orBars.map(b => Number(b.low)))  : null);
  const ibHigh = ibBars.length ? Math.max(...ibBars.map(b => Number(b.high))) : orHigh;
  const ibLow  = ibBars.length ? Math.min(...ibBars.map(b => Number(b.low)))  : orLow;
  const orWidth  = orHigh && orLow ? orHigh - orLow : null;
  const ibWidth  = ibHigh && ibLow ? ibHigh - ibLow : null;
  const aMult    = acd?.a_multiplier ?? 0.33;
  const aUpLevel   = acd?.a_up_level   ?? (orHigh && orWidth ? orHigh + orWidth * aMult : null);
  const aDownLevel = acd?.a_down_level ?? (orLow  && orWidth ? orLow  - orWidth * aMult : null);

  // 2a. Calculate IB breakout warning
  let breakoutWarning = null;
  if (ibHigh && ibLow && asOfMinutes >= RTH_START + 60 && asOfMinutes < 16 * 60) {
    const postIbBars = bars.filter(b => barMinutes(b) >= RTH_START + 60);
    let firstBreak = null;
    for (const b of postIbBars) {
      const bh = Number(b.high);
      const bl = Number(b.low);
      const bc = Number(b.close);
      if (bh > ibHigh && bl < ibLow) {
        const type = bc > (ibHigh + ibLow) / 2 ? 'BULL' : 'BEAR';
        firstBreak = { type, time: barMinutes(b) };
        break;
      } else if (bh > ibHigh) {
        firstBreak = { type: 'BULL', time: barMinutes(b) };
        break;
      } else if (bl < ibLow) {
        firstBreak = { type: 'BEAR', time: barMinutes(b) };
        break;
      }
    }

    if (firstBreak) {
      const isBull = firstBreak.type === 'BULL';

      // Check if breakout has been invalidated (price closed past the IB midpoint since the break)
      const ibMid = (ibHigh + ibLow) / 2;
      const barsAfterBreak = postIbBars.filter(b => barMinutes(b) > firstBreak.time);
      let invalidated = false;
      for (const b of barsAfterBreak) {
        const bc = Number(b.close);
        if (isBull ? (bc < ibMid) : (bc > ibMid)) {
          invalidated = true;
          break;
        }
      }

      if (!invalidated) {
        const isCurrentlyOutside = isBull ? currentPrice > ibHigh : currentPrice < ibLow;

        // Dynamic pullback buffer based on standard deviation of 1-min ranges during IB (9:30-10:30)
        const ibBars = bars.filter(b => {
          const m = barMinutes(b);
          return m >= RTH_START && m < RTH_START + 60;
        });
        let pullbackBuffer = 20; // default fallback
        if (ibBars.length > 0) {
          const ibRanges = ibBars.map(b => Number(b.high) - Number(b.low));
          const avgRange = ibRanges.reduce((sum, r) => sum + r, 0) / ibRanges.length;
          const variance = ibRanges.reduce((sum, r) => sum + (r - avgRange) ** 2, 0) / ibRanges.length;
          const sdRange = Math.sqrt(variance);
          pullbackBuffer = avgRange + sdRange;
        }

        const isWithinPullback = isBull
          ? (currentPrice >= ibHigh - pullbackBuffer && currentPrice <= ibHigh)
          : (currentPrice <= ibLow + pullbackBuffer && currentPrice >= ibLow);

        if (isCurrentlyOutside || isWithinPullback) {
        const breakTimeStr = `${String(Math.floor(firstBreak.time / 60)).padStart(2, '0')}:${String(firstBreak.time % 60).padStart(2, '0')}`;
        const ibMid = Math.round((ibHigh + ibLow) / 2);
        if (isBull) {
          if (acd?.a_down_fired) {
            breakoutWarning = {
              severity: 'WARNING',
              title: 'Counter-ACD Breakout Warning',
              message: `NQ broke IB High (${fmtNum(ibHigh)}) on a bearish A-DOWN day. Historical trap rate: 87.3%. Look to fade.`,
              type: 'BULL_COUNTER_ACD',
              firedTime: breakTimeStr,
              priceFired: Math.round(ibHigh),
              targets: [
                { label: 'T1 (IB Mid)', price: ibMid },
                { label: 'T2 (IB Low)', price: Math.round(ibLow) }
              ],
              stopPrice: 'session high'
            };
          } else {
            breakoutWarning = {
              severity: 'INFO',
              title: 'IB Breakout Active',
              message: `NQ broke IB High (${fmtNum(ibHigh)}). Average pullback rate: 94.2% (91.6% touch re-entry). Wait for a pullback inside the range before entering.`,
              type: 'BULL_NORMAL',
              firedTime: breakTimeStr,
              priceFired: Math.round(ibHigh)
            };
          }
        } else { // BEAR
          if (acd?.a_up_fired) {
            breakoutWarning = {
              severity: 'WARNING',
              title: 'Counter-ACD Breakout Warning',
              message: `NQ broke IB Low (${fmtNum(ibLow)}) on a bullish A-UP day. Historical trap rate: 100.0%. Look to fade.`,
              type: 'BEAR_COUNTER_ACD',
              firedTime: breakTimeStr,
              priceFired: Math.round(ibLow),
              targets: [
                { label: 'T1 (IB Mid)', price: ibMid },
                { label: 'T2 (IB High)', price: Math.round(ibHigh) }
              ],
              stopPrice: 'session low'
            };
          } else {
            breakoutWarning = {
              severity: 'INFO',
              title: 'IB Breakout Active',
              message: `NQ broke IB Low (${fmtNum(ibLow)}). Average pullback rate: 94.2% (96.7% touch re-entry). Wait for a pullback inside the range before entering.`,
              type: 'BEAR_NORMAL',
              firedTime: breakTimeStr,
              priceFired: Math.round(ibLow)
            };
          }
        }
      }
      }
    }
  }

  // 3. Context: NL30, prior week, G-Line
  const [{ nl30, nl10, trend: nlTrend }, { pwHigh, pwLow }, gLine] = await Promise.all([
    getNL({ asOf: tradeDate }),
    getPriorWeekRange(tradeDate),
    getGLine(tradeDate),
  ]);

  let trtWarning = null;
  if (orHigh && orLow && aUpLevel && aDownLevel && asOfMinutes >= RTH_START + 5 && asOfMinutes < 16 * 60) {
    const postOrBars = bars.filter(b => barMinutes(b) >= RTH_START + 5);
    const reachedAUp = postOrBars.some(b => Number(b.high) >= aUpLevel);
    const reachedADown = postOrBars.some(b => Number(b.low) <= aDownLevel);
    const failedAUp = reachedAUp && !acd?.a_up_fired && currentPrice < orHigh;
    const failedADown = reachedADown && !acd?.a_down_fired && currentPrice > orLow;

    const isBullTrend = nl30 > 9;
    const isBearTrend = nl30 < -9;

    const biasDir = acd?.a_up_fired ? 'LONG' : acd?.a_down_fired ? 'SHORT' : isBullTrend ? 'LONG' : isBearTrend ? 'SHORT' : 'NEUTRAL';
    
    const totalVol = postOrBars.reduce((s, b) => s + (Number(b.volume) || 1), 0);
    const vwap = postOrBars.reduce((s, b) => s + Number(b.close) * (Number(b.volume) || 1), 0) / (totalVol || 1);
    const p3_vwap_holding = biasDir === 'LONG' ? currentPrice > vwap
                          : biasDir === 'SHORT' ? currentPrice < vwap : false;

    const split = Math.max(1, postOrBars.length - 20);
    const earlyBars = postOrBars.slice(0, split);
    const earlyVol = earlyBars.reduce((s, b) => s + (Number(b.volume) || 1), 0);
    const earlyVwap = earlyBars.reduce((s, b) => s + Number(b.close) * (Number(b.volume) || 1), 0) / (earlyVol || 1);
    const p3_value_migrating = biasDir === 'LONG' ? vwap > earlyVwap
                             : biasDir === 'SHORT' ? vwap < earlyVwap : false;

    const last10 = postOrBars.slice(-10);
    const avgClosePos = last10.reduce((s, b) => {
      const rng = Number(b.high) - Number(b.low);
      return s + (rng > 0 ? (Number(b.close) - Number(b.low)) / rng : 0.5);
    }, 0) / (last10.length || 1);
    const p3_delta_confirming = biasDir === 'LONG' ? avgClosePos > 0.55
                              : biasDir === 'SHORT' ? avgClosePos < 0.45 : false;

    const last20 = postOrBars.slice(-20);
    const acceptCount = last20.filter(b =>
      biasDir === 'LONG' ? Number(b.close) > orHigh : biasDir === 'SHORT' ? Number(b.close) < orLow : false
    ).length;
    const p3_auction_accepted = last20.length > 0 && acceptCount / last20.length >= 0.4;

    const last16 = postOrBars.slice(-16);
    let p3_rotations_increasing = false;
    if (last16.length >= 8) {
      const half = Math.floor(last16.length / 2);
      const firstHalf = last16.slice(0, half);
      const secondHalf = last16.slice(half);
      const rng1 = Math.max(...firstHalf.map(b => Number(b.high))) - Math.min(...firstHalf.map(b => Number(b.low)));
      const rng2 = Math.max(...secondHalf.map(b => Number(b.high))) - Math.min(...secondHalf.map(b => Number(b.low)));
      p3_rotations_increasing = rng2 > rng1 * 1.15;
    }

    const p3Score = [p3_vwap_holding, p3_value_migrating, p3_delta_confirming, p3_auction_accepted, p3_rotations_increasing].filter(Boolean).length;

    if (failedADown && isBullTrend && !acd?.a_down_fired) {
      trtWarning = {
        severity: p3Score >= 2 ? 'INFO' : 'WARNING',
        title: `Trend Resumption (TRT Long) — P3: ${p3Score}/5`,
        message: `NQ tested A Down level (${fmtNum(aDownLevel)}) but failed to sustain. Structural trend is BULLISH (NL30=${nl30 > 0 ? '+' : ''}${nl30}). Lean Long near OR Low (${fmtNum(orLow)}). Stop below session low. P3 confirmation is ${p3Score >= 3 ? 'STRONG' : p3Score >= 2 ? 'MODERATE' : 'WEAK (STAND ASIDE)'}.`,
        type: 'TRT_LONG',
        p3Score
      };
    } else if (failedAUp && isBearTrend && !acd?.a_up_fired) {
      trtWarning = {
        severity: p3Score >= 2 ? 'INFO' : 'WARNING',
        title: `Trend Resumption (TRT Short) — P3: ${p3Score}/5`,
        message: `NQ tested A Up level (${fmtNum(aUpLevel)}) but failed to sustain. Structural trend is BEARISH (NL30=${nl30 > 0 ? '+' : ''}${nl30}). Lean Short near OR High (${fmtNum(orHigh)}). Stop above session high. P3 confirmation is ${p3Score >= 3 ? 'STRONG' : p3Score >= 2 ? 'MODERATE' : 'WEAK (STAND ASIDE)'}.`,
        type: 'TRT_SHORT',
        p3Score
      };
    }
  }

  // 4. Structural levels (5-day composite VA, bracket, prior-day VA)
  const structLevels = await getStructuralLevels(tradeDate);

  // 5. Overnight range & VWAP
  const onQ = await query(`
    SELECT MAX(high)::float as on_high, MIN(low)::float as on_low,
           SUM(close::float * volume::float) / NULLIF(SUM(volume::float), 0) as on_vwap
    FROM price_bars_primary WHERE symbol='NQ' AND ts::date = $1
      AND (EXTRACT(hour FROM ts) >= 18 OR EXTRACT(hour FROM ts) < 9)
  `, [tradeDate]);
  const onHigh = onQ.rows[0]?.on_high ?? null;
  const onLow  = onQ.rows[0]?.on_low  ?? null;
  const onVwap = onQ.rows[0]?.on_vwap  ?? null;

  // 5a. Compression detection (NR4/NR7 + day-range narrowing)
  const compression = await computeCompression(tradeDate, orWidth);

  // 6. Build levels (multi-timeframe)
  const convData = await getConvictionData();

  const rawLevels = [
    ibHigh   && { price: ibHigh,   label: 'IB High',           timeframes: ['INTRADAY'], role: 'RESISTANCE' },
    ibLow    && { price: ibLow,    label: 'IB Low',            timeframes: ['INTRADAY'], role: 'SUPPORT'    },
    aUpLevel && { price: aUpLevel, label: 'A Up Level',        timeframes: ['INTRADAY'], role: 'RESISTANCE' },
    aDownLevel && { price: aDownLevel, label: 'A Down Level',  timeframes: ['INTRADAY'], role: 'SUPPORT'    },
    onHigh   && { price: onHigh,   label: 'Overnight High',    timeframes: ['INTRADAY'], role: 'RESISTANCE' },
    onLow    && { price: onLow,    label: 'Overnight Low',     timeframes: ['INTRADAY'], role: 'SUPPORT'    },
    onVwap   && { price: onVwap,   label: 'Overnight VWAP',    timeframes: ['INTRADAY'], role: 'PIVOT'      },
    pwHigh   && { price: pwHigh,   label: 'Prior Week High',   timeframes: ['WEEKLY'],   role: 'RESISTANCE' },
    pwLow    && { price: pwLow,    label: 'Prior Week Low',    timeframes: ['WEEKLY'],   role: 'SUPPORT'    },
    gLine    && { price: gLine,    label: 'G-Line (WK Open)',  timeframes: ['WEEKLY'],   role: currentPrice >= gLine ? 'SUPPORT' : 'RESISTANCE' },
    ...structLevels.map(sl => ({
      price: sl.price,
      label: sl.type.replace(/_/g, ' '),
      timeframes: ['DAILY'],
      role: (sl.type.includes('VAH') || sl.type.includes('HIGH') || sl.type.includes('BRACKET_HIGH')) ? 'RESISTANCE' : 'SUPPORT',
    })),
    ...openGaps.flatMap(gap => [
      { price: gap.gapHigh, label: `Gap Ceiling (${gap.toDate})`, timeframes: ['DAILY'], role: gap.type === 'up' ? 'RESISTANCE' : 'SUPPORT' },
      { price: gap.gapLow,  label: `Gap Floor (${gap.toDate})`,  timeframes: ['DAILY'], role: gap.type === 'up' ? 'SUPPORT' : 'RESISTANCE' }
    ])
  ].filter(Boolean);

  // Assign stars via conviction data
  const levelsWithStars = rawLevels.map(lv => {
    const dist     = Math.round((currentPrice - lv.price) * 4) / 4;
    const absDist  = Math.abs(dist);
    // Match label to conviction key
    const cvKeyMap = {
      'IB High': 'ib_high', 'IB Low': 'ib_low',
      'OVERNIGHT HIGH': 'overnight_high',
      'PRIOR WEEK HIGH': 'prior_week_high', 'PRIOR WEEK LOW': 'prior_week_low',
      'COMPOSITE VAH': 'composite_vah', 'COMPOSITE VAL': 'composite_val',
      'BRACKET HIGH': 'bracket_high', 'BRACKET LOW': 'bracket_low',
    };
    const cvKey = cvKeyMap[lv.label.toUpperCase()];
    const cv    = cvKey ? computeDynamicConviction(convData[cvKey], cvKey, { nl30 }) : null;
    const stars = cv?.stars ?? (absDist < 8 ? 3 : absDist < 20 ? 2 : 1);
    return { ...lv, distance: dist, stars };
  });

  const levels = applyStacking(levelsWithStars)
    .sort((a, b) => Math.abs(a.distance) - Math.abs(b.distance))
    .slice(0, 14);

  // Failed auction tracking at key levels
  const resistancePx   = levels.filter(l => l.role === 'RESISTANCE').map(l => l.price);
  const supportPx      = levels.filter(l => l.role === 'SUPPORT').map(l => l.price);
  const failedAuctions = detectFailedAuctions(bars, resistancePx, supportPx);

  // 7. Opening type & day type
  const openingType   = classifyOpeningType(bars);
  const accuracyStats = await getDayTypeAccuracyStats();
  const dayType       = classifyDayType({ openingType, nl30, orWidth, asOfMinutes, accuracyStats });

  // 7a. Live day-type REASSESSMENT (additive, read-only — see dayTypeReassessmentService.js).
  // Catches the static read's blind spot (TREND days called BALANCE at 10:05) using
  // backtest-validated triggers: range expansion >= 30% avg_range_20, confirmed by a
  // vol-jump when present. Runs at checkpoints from 11:00 ET on, no-lookahead.
  let dayTypeReassessment = null;
  if (asOfMinutes >= RTH_START + 60) {
    const avgRange20Q = await query(`
      WITH sessions AS (
        SELECT ts::date AS trade_date, MAX(high)::float AS sess_high, MIN(low)::float AS sess_low
        FROM price_bars_primary
        WHERE symbol = 'NQ'
          AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) BETWEEN ${RTH_START} AND 959
          AND ts::date < $1
        GROUP BY ts::date
        ORDER BY trade_date DESC
        LIMIT 20
      )
      SELECT AVG(sess_high - sess_low)::float AS avg_range_20 FROM sessions
    `, [tradeDate]);
    const avgRange20 = avgRange20Q.rows[0]?.avg_range_20 ?? null;

    if (avgRange20) {
      const reassessBars = bars.map(b => ({ ...b, et_min: barMinutes(b) }));
      const checkpoints = REASSESSMENT_CHECKPOINTS.filter(t => t <= asOfMinutes);
      const reassessResult = runReassessment({
        initialRead: dayType.classification,
        bars: reassessBars,
        sessOpen: Number(bars[0].open),
        avgRange20,
        ibHigh, ibLow,
        checkpoints,
      });
      dayTypeReassessment = {
        ...describeLiveReassessment(reassessResult, asOfMinutes),
        limitation: '~68% accurate end-to-end and recovers ~71% of TREND days the static read misses, but ~20% of BALANCE→TREND reassessments are false positives. Treat a reassessment as a prompt to verify with price action, not a command to switch playbooks.',
      };
    }
  }

  // 8. Volume & delta metrics
  const avgVol     = trailingAvgVol(bars, bars.length, 20) || 1;
  const cumDelta   = bars.reduce((s, b) => s + Number(b.ask_volume||0) - Number(b.bid_volume||0), 0);
  const deltaConf  = confirmedDeltaDir(bars, 3);
  const volConf    = confirmedHighVol(bars, 1.5, 2);

  // 9. Nearest support / resistance for juice
  const nearSupport = levels.filter(l => l.role === 'SUPPORT'    && currentPrice > l.price).sort((a,b) => b.price - a.price)[0] || null;
  const nearResist  = levels.filter(l => l.role === 'RESISTANCE' && currentPrice < l.price).sort((a,b) => a.price - b.price)[0] || null;

  // 10. Build meter + case
  let meter = 0;
  const caseFor     = [];
  const caseAgainst = [];
  const evidenceLog = [];

  // NL30 (context, literature weight)
  if (nl30 > 9) {
    const w = nl30 > 15 ? 15 : 10;
    meter += w;
    caseFor.push({ point: 'NL30 bullish', value: `+${nl30}`, weight: w, confirmed: true });
  } else if (nl30 < -9) {
    const w = nl30 < -15 ? 15 : 10;
    meter -= w;
    caseAgainst.push({ point: 'NL30 bearish', value: `${nl30}`, weight: w, confirmed: true });
  }

  // G-Line
  if (gLine) {
    const gDist = Math.round(currentPrice - gLine);
    if (gDist >= 0) {
      meter += 8;
      caseFor.push({ point: 'Above G-Line (weekly open)', value: `G=${gLine}, +${gDist}pts above`, weight: 8, confirmed: true });
    } else {
      meter -= 8;
      caseAgainst.push({ point: 'Below G-Line (weekly open)', value: `G=${gLine}, ${gDist}pts below`, weight: 8, confirmed: true });
    }
  }

  // Prior week range
  if (pwLow && currentPrice > pwLow) {
    meter += 5;
    caseFor.push({ point: 'Above prior week low', value: `PW Low=${pwLow}, +${Math.round(currentPrice-pwLow)}pts`, weight: 5, confirmed: true });
  }
  if (pwHigh && currentPrice < pwHigh) {
    caseAgainst.push({ point: 'Below prior week high', value: `PW High=${pwHigh}, ${Math.round(currentPrice-pwHigh)}pts`, weight: 5, confirmed: false });
  }

  // Opening type
  if (openingType.startsWith('OPEN_DRIVE')) {
    const isLong = openingType.includes('LONG');
    const w = 20;
    if (isLong) {
      meter += w;
      caseFor.push({ point: `Open Drive (bullish — ${openingType})`, value: `+${Math.round(Number(bars[4]?.close||0) - Number(bars[0]?.open||0))}pts first 5 bars`, weight: w, confirmed: true });
      evidenceLog.push({ time: currentTs, change: '↑', reason: 'Open Drive detected', value: `+${Math.round(Number(bars[4]?.close||0) - Number(bars[0]?.open||0))}` });
    } else {
      meter -= w;
      caseAgainst.push({ point: `Open Drive (bearish — ${openingType})`, value: `${Math.round(Number(bars[4]?.close||0) - Number(bars[0]?.open||0))}pts first 5 bars`, weight: w, confirmed: true });
      evidenceLog.push({ time: currentTs, change: '↓', reason: 'Open Drive detected', value: `${Math.round(Number(bars[4]?.close||0) - Number(bars[0]?.open||0))}` });
    }
  }

  // IB position (only meaningful after IB forms at 10:30)
  if (ibHigh && ibLow && asOfMinutes >= RTH_START + 60) {
    if (currentPrice > ibHigh) {
      meter += 12;
      caseFor.push({ point: 'Price above IB High', value: `IB High=${ibHigh}, +${Math.round(currentPrice-ibHigh)}pts above`, weight: 12, confirmed: true });
    } else if (currentPrice < ibLow) {
      meter -= 12;
      caseAgainst.push({ point: 'Price below IB Low', value: `IB Low=${ibLow}, ${Math.round(currentPrice-ibLow)}pts`, weight: 12, confirmed: true });
    } else {
      const midIB = (ibHigh + ibLow) / 2;
      if (currentPrice > midIB) {
        meter += 4;
        caseFor.push({ point: 'Inside IB, upper half', value: `IB Mid=${Math.round(midIB)}, current=${currentPrice}`, weight: 4, confirmed: false });
      } else {
        meter -= 4;
        caseAgainst.push({ point: 'Inside IB, lower half', value: `IB Mid=${Math.round(midIB)}, current=${currentPrice}`, weight: 4, confirmed: false });
      }
    }
  }

  // PD-2 VA confluence (2-day-prior value area — backtested +20-32% edge boost)
  const pd2vaQ = await query(`
    SELECT vah::float, val::float FROM developing_value_log
    WHERE trade_date < (SELECT MAX(trade_date) FROM developing_value_log WHERE trade_date < $1)
    ORDER BY trade_date DESC LIMIT 1
  `, [tradeDate]).catch(() => ({ rows: [] }));
  const pd2vah = pd2vaQ.rows[0]?.vah, pd2val = pd2vaQ.rows[0]?.val;
  if (pd2vah && pd2val && currentPrice) {
    const nearPD2VAH = Math.abs(currentPrice - pd2vah) <= 25;
    const nearPD2VAL = Math.abs(currentPrice - pd2val) <= 25;
    if (nearPD2VAH || nearPD2VAL) {
      const w = 10;
      const lvl = nearPD2VAH ? `PD-2 VAH (${Math.round(pd2vah)})` : `PD-2 VAL (${Math.round(pd2val)})`;
      const dist = nearPD2VAH ? Math.round(currentPrice - pd2vah) : Math.round(currentPrice - pd2val);
      const entry = { point: `At ${lvl} — high-confluence zone`, value: `${dist > 0 ? '+' : ''}${dist}pt from level`, weight: w, confirmed: true };
      if ((nearPD2VAH && currentPrice < pd2vah) || (nearPD2VAL && currentPrice > pd2val)) {
        meter += w; caseFor.push(entry);
      } else {
        meter -= w; caseAgainst.push(entry);
      }
    }

    // VWAP compression check: is VWAP within 15pt of PD-2 VA?
    // When compressed: 70.4% WR (N=27) vs 46.9% when apart
    let cumPV2 = 0, cumTV2 = 0;
    for (const b of bars) {
      cumPV2 += (Number(b.high) + Number(b.low) + Number(b.close)) / 3 * (Number(b.volume || b.vol) || 1);
      cumTV2 += (Number(b.volume || b.vol) || 1);
    }
    const vwapNow = cumTV2 > 0 ? cumPV2 / cumTV2 : null;
    if (vwapNow) {
      const vwapDist2VAH = pd2vah ? Math.abs(vwapNow - pd2vah) : 999;
      const vwapDist2VAL = pd2val ? Math.abs(vwapNow - pd2val) : 999;
      const compressed = Math.min(vwapDist2VAH, vwapDist2VAL) <= 15;
      if (compressed) {
        const compLvl = vwapDist2VAH < vwapDist2VAL ? `PD-2 VAH (${Math.round(pd2vah)})` : `PD-2 VAL (${Math.round(pd2val)})`;
        const w = 8;
        meter += currentPrice > vwapNow ? -w : w;
        const entry = { point: `VWAP↔PD-2 compressed (${Math.round(Math.min(vwapDist2VAH, vwapDist2VAL))}pt) — 70.4% WR zone`, value: `VWAP=${Math.round(vwapNow)} near ${compLvl}`, weight: w, confirmed: true };
        if (currentPrice < vwapNow) caseFor.push(entry);
        else caseAgainst.push(entry);
      }
    }
  }

  // POC Migration streak (2-day consecutive direction)
  // Aligned with setup: 54.2% WR. Counter: 41.5%. Delta: +12.7%.
  const pocMigQ2 = await query(`
    SELECT migration_dir_vs_prior FROM developing_value_log
    WHERE trade_date < $1 ORDER BY trade_date DESC LIMIT 2
  `, [tradeDate]).catch(() => ({ rows: [] }));
  if (pocMigQ2.rows.length >= 2) {
    const dir1 = pocMigQ2.rows[0].migration_dir_vs_prior;
    const dir2 = pocMigQ2.rows[1].migration_dir_vs_prior;
    if (dir1 === dir2 && (dir1 === 'HIGHER' || dir1 === 'LOWER')) {
      const w = 8;
      const pocLabel = dir1 === 'HIGHER' ? 'POC migrating HIGHER (2-day streak)' : 'POC migrating LOWER (2-day streak)';
      if (dir1 === 'HIGHER') {
        meter += w;
        caseFor.push({ point: pocLabel, value: 'Aligned +12.7% edge when setup matches', weight: w, confirmed: true });
      } else {
        meter -= w;
        caseAgainst.push({ point: pocLabel, value: 'Aligned +12.7% edge when setup matches', weight: w, confirmed: true });
      }
    }
  }

  // Delta (confirmed 3-bar window, scanning last 10 bars)
  if (deltaConf) {
    const w     = 12;
    const label = deltaConf.barsAgo > 0
      ? `Delta confirmed ${deltaConf.direction === 'LONG' ? 'bullish' : 'bearish'} (${deltaConf.streak}-bar, ${deltaConf.barsAgo} bar${deltaConf.barsAgo > 1 ? 's' : ''} ago)`
      : `Delta confirmed ${deltaConf.direction === 'LONG' ? 'bullish' : 'bearish'} (${deltaConf.streak}-bar streak)`;
    if (deltaConf.direction === 'LONG') {
      meter += w;
      caseFor.push({ point: label, value: `net delta=${deltaConf.net}`, weight: w, confirmed: true });
      evidenceLog.push({ time: currentTs, change: '↑', reason: label, value: deltaConf.net });
    } else {
      meter -= w;
      caseAgainst.push({ point: label, value: `net delta=${deltaConf.net}`, weight: w, confirmed: true });
      evidenceLog.push({ time: currentTs, change: '↓', reason: label, value: deltaConf.net });
    }
  } else {
    const last5Delta = bars.slice(-5).reduce((s,b) => s + Number(b.ask_volume||0) - Number(b.bid_volume||0), 0);
    if (Math.abs(last5Delta) > 500) {
      const entry = { point: `Delta ${last5Delta>0?'bullish':'bearish'} (forming — 3-bar window not met)`, value: `${last5Delta} net, last 5 bars`, weight: 0, confirmed: false };
      (last5Delta > 0 ? caseFor : caseAgainst).push(entry);
    }
  }

  // Volume (confirmed 2-bar window)
  if (volConf.confirmed && deltaConf) {
    const w = 8;
    if (deltaConf.direction === 'LONG') { meter += w; caseFor.push({ point: `High rel-vol sustained (${volConf.relVol}x, 2 bars)`, value: `${volConf.relVol}x avg`, weight: w, confirmed: true }); }
    else                               { meter -= w; caseAgainst.push({ point: `High rel-vol sustained (${volConf.relVol}x, 2 bars)`, value: `${volConf.relVol}x avg`, weight: w, confirmed: true }); }
  }

  // Absorption at nearest level
  const absLevel = nearSupport?.price || nearResist?.price;
  if (absLevel) {
    const abs = detectAbsorption(bars, absLevel);
    if (abs?.detected) {
      const w = 6;
      const isBull = abs.bias === 'bullish_absorption';
      if (isBull) { meter += w; caseFor.push({ point: 'Absorption detected at support', value: `${abs.relVol}x vol, small body at ${absLevel}`, weight: w, confirmed: true }); }
      else        { meter -= w; caseAgainst.push({ point: 'Absorption detected at resistance', value: `${abs.relVol}x vol, small body at ${absLevel}`, weight: w, confirmed: true }); }
      evidenceLog.push({ time: currentTs, change: isBull ? '↑' : '↓', reason: `Absorption at ${absLevel}`, value: `${abs.relVol}x vol` });
    }
  }

  // Level-test events: scan bars for first touch of A Down / A Up / IB edges
  // These go into the evidenceLog to show the story evolving across the session
  const lvlTests = [
    aDownLevel && { price: aDownLevel, label: 'A Down Level', probe: 'low',  bullishOnFail: true  },
    aUpLevel   && { price: aUpLevel,   label: 'A Up Level',   probe: 'high', bullishOnFail: false },
    ibHigh     && asOfMinutes >= RTH_START + 60 && { price: ibHigh, label: 'IB High', probe: 'high', bullishOnFail: false },
    ibLow      && asOfMinutes >= RTH_START + 60 && { price: ibLow,  label: 'IB Low',  probe: 'low',  bullishOnFail: true  },
  ].filter(Boolean);

  for (const lvl of lvlTests) {
    const touchBar = bars.find(b =>
      lvl.probe === 'low'
        ? Number(b.low)  <= lvl.price + 8
        : Number(b.high) >= lvl.price - 8
    );
    if (!touchBar) continue;
    const touchIdx = bars.indexOf(touchBar);
    // Did price recover through the level within the next 5 bars?
    const followBars  = bars.slice(touchIdx + 1, touchIdx + 6);
    const recovered   = lvl.probe === 'low'
      ? followBars.some(b => Number(b.close) > lvl.price + 10)
      : followBars.some(b => Number(b.close) < lvl.price - 10);
    const broke       = lvl.probe === 'low'
      ? followBars.some(b => Number(b.close) < lvl.price - 10)
      : followBars.some(b => Number(b.close) > lvl.price + 10);
    const outcome     = recovered ? 'FAILED (rejected)' : broke ? 'BROKE through' : 'holding';
    const isBullish   = recovered === lvl.bullishOnFail;
    evidenceLog.push({
      time: touchBar.ts,
      change: isBullish ? '↑' : '↓',
      reason: `${lvl.label} ${lvl.price} tested → ${outcome}`,
      value:  `low=${Number(touchBar.low)}, close=${Number(touchBar.close)}`,
    });
  }

  // Dynamic Volume Spike Detection (preventing flooding by using peak detection in 5-bar window)
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    const vol = Number(bar.volume || 0);
    if (vol >= baselineAvgVol * 2.5) {
      // Local peak test: is it the highest volume in [i-2, i+2]?
      let isPeak = true;
      for (let j = Math.max(0, i - 2); j <= Math.min(bars.length - 1, i + 2); j++) {
        if (Number(bars[j].volume || 0) > vol) {
          isPeak = false;
          break;
        }
      }
      if (isPeak) {
        const isBull = Number(bar.close) >= Number(bar.open);
        evidenceLog.push({
          time: bar.ts,
          change: isBull ? '↑' : '↓',
          reason: `Vol Spike (${(vol / baselineAvgVol).toFixed(1)}x baseline)`,
          value: `vol=${vol}, price=${Math.round(Number(bar.close))}`,
        });
      }
    }
  }

  meter = Math.max(-100, Math.min(100, Math.round(meter)));
  const bias = meter > 15 ? 'LONG' : meter < -15 ? 'SHORT' : 'NEUTRAL';
  const conviction = Math.min(10, Math.round(Math.abs(meter) / 10 * 10) / 10);

  const whatFlipsIt = bias === 'LONG'
    ? `Price closes below ${ibLow ?? orLow} on above-avg volume with 3-bar bearish delta confirmation`
    : bias === 'SHORT'
    ? `Price closes above ${ibHigh ?? orHigh} on above-avg volume with 3-bar bullish delta confirmation`
    : `Confirmed break of IB High (${ibHigh}) or IB Low (${ibLow}) with volume and delta alignment`;

  // 11. Active setups at asOf (most recent fired, regardless of current status)
  // Restrict to high-probability setups (win_rate >= 50% for today's day type, or overall baseline)
  const currentDayType = dayTypeReassessment?.classification || dayType?.classification || 'OVERALL';
  const setupQ = await query(`
    SELECT a.id, a.setup_type, a.fired_at, a.entry_zone_low, a.entry_zone_high, a.stop_level, a.t1_level,
           a.confluence_score_at_detection, a.structural_level_type, a.nl30_at_detection, a.status
    FROM active_setups a
    LEFT JOIN setup_daytype_winrates w1 ON w1.setup_type = a.setup_type AND w1.day_type = $3 AND w1.computed_date = (SELECT MAX(computed_date) FROM setup_daytype_winrates)
    LEFT JOIN setup_daytype_winrates w2 ON w2.setup_type = a.setup_type AND w2.day_type = 'OVERALL' AND w2.computed_date = (SELECT MAX(computed_date) FROM setup_daytype_winrates)
    WHERE a.trade_date = $1 AND a.fired_at <= $2 AND a.status = 'ACTIVE'
      AND COALESCE(w1.win_rate, w2.win_rate, 0.50) >= 0.50
    ORDER BY a.fired_at DESC LIMIT 1
  `, [tradeDate, asOfFull, currentDayType]);
  const latestSetup = setupQ.rows[0] || null;

  // 12. Juice
  let juice = null;
  if (latestSetup?.t1_level && latestSetup?.stop_level) {
    const entry = Number(latestSetup.entry_zone_high || latestSetup.entry_zone_low || 0);
    const stop  = Number(latestSetup.stop_level);
    const t1    = Number(latestSetup.t1_level);
    const nearestTargetDistance = Math.abs(t1 - currentPrice);
    const riskToStop            = Math.abs(currentPrice - stop);
    const rr = riskToStop > 0 ? Math.round(nearestTargetDistance / riskToStop * 10) / 10 : null;
    juice = { nearestTargetDistance: Math.round(nearestTargetDistance), riskToStop: Math.round(riskToStop), rr, worthIt: rr != null && rr >= 2.0 };
  } else if (nearSupport && nearResist) {
    const tgtDist  = bias === 'LONG'  ? Math.abs(nearResist.price - currentPrice) : Math.abs(currentPrice - nearSupport.price);
    const stopDist = bias === 'LONG'  ? Math.abs(currentPrice - nearSupport.price) : Math.abs(nearResist.price - currentPrice);
    const rr       = stopDist > 0 ? Math.round(tgtDist / stopDist * 10) / 10 : null;
    juice = { nearestTargetDistance: Math.round(tgtDist), riskToStop: Math.round(stopDist), rr, worthIt: rr != null && rr >= 2.0 };
  }

  // 13. Trigger & impact score + state machine
  let trigger = { active: false, state: 'WATCHING', resolvedReason: null, setup: null };
  if (latestSetup) {
    const isLong  = /LONG|UP|BULLISH/.test(latestSetup.setup_type);
    let impact    = 0;
    const impactStack = [];

    if (deltaConf?.direction === (isLong ? 'LONG' : 'SHORT') && (deltaConf.barsAgo ?? 0) <= 8) { impact += 2; impactStack.push(`+2 delta confirmed and aligned (${deltaConf.barsAgo === 0 ? 'current' : deltaConf.barsAgo + ' bars ago'})`); }
    if ((isLong && nl30 > 9) || (!isLong && nl30 < -9))       { impact += 2; impactStack.push(`+2 NL30=${nl30} aligned with setup`); }
    impact += 1; impactStack.push('+1 validated setup type');

    const entryPx    = Number(latestSetup.entry_zone_high || latestSetup.entry_zone_low || 0);
    const nearLvl    = levels.find(l => Math.abs(l.price - entryPx) <= 20);
    if (nearLvl?.stars >= 2) { impact += 1; impactStack.push(`+1 at ${nearLvl.stars}★ level (${nearLvl.label} @ ${nearLvl.price})`); }
    if (juice?.rr >= 2.0)    { impact += 2; impactStack.push(`+2 R:R=${juice.rr}`); }
    if ((isLong && nl30 < -9) || (!isLong && nl30 > 9)) { impact -= 3; impactStack.push(`-3 counter-trend to NL30=${nl30}`); }

    const conf = latestSetup.confluence_score_at_detection;
    if (conf != null && conf < 4) { impact -= 2; impactStack.push(`-2 low confluence score=${conf}`); }

    // Day-type adjustment — weights halved while accuracy is low-confidence (see getDayTypeAccuracyStats)
    // TURBULENT separated from TREND: TURBULENT = "no conviction, wait for structure" → neutral (0), not a boost.
    // Was: BALANCE=-3, TREND/TURBULENT=+1. Halved until measured overall accuracy exceeds 60%.
    const dtConfTag = dayType.lowConfidence ? 'LOW-CONFIDENCE' : 'CONFIRMED';
    if      (dayType.classification === 'BALANCE')   { impact -= 1; impactStack.push(`-1 BALANCE day [${dtConfTag} — ${dayType.accuracyNote} — weight halved from -3]`); }
    else if (dayType.classification === 'TREND')      { impact += 1; impactStack.push(`+1 TREND day [${dtConfTag} — ${dayType.accuracyNote}]`); }
    // TURBULENT: no impact adjustment — wide range but no directional conviction; "wait for structure"

    // Suppress/penalize breakout setups in rotational (BALANCE / TURBULENT) regimes
    const isBreakoutSetup = /BREAKOUT|DRIVE|IB_BULLISH|IB_BEARISH/.test(latestSetup.setup_type);
    if (isBreakoutSetup) {
      if (dayType.classification === 'BALANCE') {
        impact -= 3;
        impactStack.push(`-3 breakout setup in BALANCE regime (high trap rate)`);
      } else if (dayType.classification === 'TURBULENT') {
        impact -= 3;
        impactStack.push(`-3 breakout setup in TURBULENT regime (high whipsaw risk)`);
      }
    }

    // ACD signal integrity penalty: if the intraday A signal was reached but not confirmed
    // (A Up fired but C Up never closed above OR High = A Up was rejected), this is a failed
    // intraday premise and directly undermines directional breakout setups.
    const aUpRejected   = isLong  && acd?.a_up_fired   && !acd?.c_up_confirmed   && currentPrice < (aUpLevel   ?? Infinity) - 5;
    const aDownRejected = !isLong && acd?.a_down_fired  && !acd?.c_down_confirmed && currentPrice > (aDownLevel ?? -Infinity) + 5;
    if (aUpRejected)   { impact -= 2; impactStack.push(`-2 A Up tested but REJECTED (price now below A Up level — intraday premise broken)`); }
    if (aDownRejected) { impact -= 2; impactStack.push(`-2 A Down tested but REJECTED (price now above A Down level — intraday premise broken)`); }

    // Failed auction fuel — trapped inventory at opposite extreme drives breakout (INTERIM)
    // Guard: skip on BALANCE days — range context, not breakout context
    if (dayType.classification !== 'BALANCE') {
      if ( isLong && failedAuctions.fuelLong)  { impact += 1; impactStack.push(`+1 failed-auction fuel LONG — ${failedAuctions.failedAuctionsBelow}x support probed & rejected (trapped shorts)`); }
      if (!isLong && failedAuctions.fuelShort) { impact += 1; impactStack.push(`+1 failed-auction fuel SHORT — ${failedAuctions.failedAuctionsAbove}x resistance probed & rejected (trapped longs)`); }
    }

    const stop    = Number(latestSetup.stop_level || 0);
    const t1      = Number(latestSetup.t1_level   || 0);
    const setupRR = (entryPx && stop && t1) ? Math.round(Math.abs(t1 - entryPx) / Math.abs(entryPx - stop) * 10) / 10 : null;

    // ── Trigger state machine ────────────────────────────────────────────────
    // Resolution conditions (real — not momentary delta gaps)
    const t1Hit        = t1   && (isLong ? currentPrice >= t1   : currentPrice <= t1  );
    const stopHit      = stop && (isLong ? currentPrice <= stop  : currentPrice >= stop);
    const isBracketBreak = latestSetup.setup_type.includes('BRACKET_BREAKOUT');
    const premiseBroken = isBracketBreak
      ? (isLong
          ? (latestSetup.stop_level != null && currentPrice <= latestSetup.stop_level)
          : (latestSetup.stop_level != null && currentPrice >= latestSetup.stop_level))
      : (isLong
          ? (orLow  != null && currentPrice < orLow  - 5)
          : (orHigh != null && currentPrice > orHigh + 5));
    const juiceGone    = juice?.rr != null && juice.rr < 0.5;

    let triggerState   = 'WATCHING';
    let resolvedReason = null;

    if (impact >= 6) {
      triggerState = 'ACTIVE';
    } else if (t1Hit) {
      triggerState = 'RESOLVED'; resolvedReason = 'T1_REACHED';
    } else if (stopHit) {
      triggerState = 'RESOLVED'; resolvedReason = 'STOP_REACHED';
    } else if (premiseBroken) {
      triggerState = 'RESOLVED'; resolvedReason = 'PREMISE_BROKEN';
    } else if (juiceGone) {
      triggerState = 'RESOLVED'; resolvedReason = 'JUICE_EXHAUSTED';
    } else {
      // Latch: was the trigger ever active at any earlier bar this session?
      const wasActive = checkSessionActivation(bars, latestSetup, nl30, levels, dayType.classification);
      if (wasActive) triggerState = 'ACTIVE_MANAGING';
    }

    trigger = {
      active: triggerState === 'ACTIVE' || triggerState === 'ACTIVE_MANAGING',
      state:  triggerState,
      resolvedReason,
      exitPlaybook: buildExitPlaybook(dayType.classification),
      setup: {
        type: latestSetup.setup_type,
        direction: isLong ? 'LONG' : 'SHORT',
        entry: entryPx || null,
        stop:  stop    || null,
        t1:    t1      || null,
        rr:    setupRR,
        stars: nearLvl?.stars ?? null,
        impactScore: impact,
        impactStack,
        firedAt: latestSetup.fired_at,
        rationale: [
          `${latestSetup.setup_type} fired ${new Date(latestSetup.fired_at).toISOString().slice(11,16)} (stored ET)`,
          `entry=${entryPx}, stop=${stop}, T1=${t1}, R:R=${setupRR ?? 'n/a'}`,
          `Delta: ${deltaConf ? deltaConf.direction + ' confirmed (' + deltaConf.streak + '-bar)' : 'unconfirmed'}`,
          `Vol: ${volConf.confirmed ? 'sustained ' + volConf.relVol + 'x' : 'normal'}`,
          `NL30=${nl30} (${nlTrend})`,
        ].join(' | '),
      },
    };
  }

  return {
    asOf: asOfFull,
    tradeDate,
    currentPrice,

    dayType,
    dayTypeReassessment,
    breakoutWarning,
    gapWarning,
    trtWarning,

    read: {
      bias,
      conviction,
      meterPosition: meter,
      confidence: `${Math.abs(meter)}/100 — ${caseFor.length} factors for, ${caseAgainst.length} against. ${deltaConf ? 'Delta confirmed.' : 'Delta unconfirmed.'}`,
      dayTypeEdge: dayType.classification === 'BALANCE'
        ? 'WEAK — BALANCE day (0% T1 in n=7 backtest, INTERIM). Stand light, wait for range to resolve.'
        : (dayType.classification === 'TURBULENT' || dayType.classification === 'TREND')
        ? `FAVORABLE — ${dayType.classification} day (+1 impact, INTERIM n=7). Directional follow-through historically higher.`
        : null,
    },

    caseFor,
    caseAgainst,
    evidenceLog: evidenceLog
      .sort((a, b) => {
        const ta = a.time instanceof Date ? a.time.getTime() : new Date(a.time).getTime();
        const tb = b.time instanceof Date ? b.time.getTime() : new Date(b.time).getTime();
        return ta - tb;
      })
      .slice(-10),

    whatFlipsIt,

    juice,

    levels,

    trigger,

    compression,
    failedAuctions,

    _ctx: {
      nl30, nl10, nlTrend, openingType,
      orHigh, orLow, orWidth: orWidth ? Math.round(orWidth * 4) / 4 : null,
      ibHigh, ibLow, ibWidth: ibWidth ? Math.round(ibWidth * 4) / 4 : null,
      aUpLevel, aDownLevel, gLine, pwHigh, pwLow, onVwap,
      avgVol: Math.round(avgVol), cumDelta, barsLoaded: bars.length,
      deltaConfirmed: !!deltaConf, volConfirmed: volConf.confirmed,
    },
  };
}
