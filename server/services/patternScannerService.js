import { query } from '../db.js';

// ─── PATTERN DETECTORS ──────────────────────────────────────────────
// Each detector receives the full day's 1-min bars and returns pattern instances

function detectCompressionExpansion(bars, fiveBars) {
  const patterns = [];
  if (fiveBars.length < 10) return patterns;

  const sessionRange = Math.max(...bars.map(b => b.high)) - Math.min(...bars.map(b => b.low));
  if (sessionRange < 50) return patterns;

  let inCompression = false;
  let compressionStart = null;
  let compressionLow = null;

  for (let i = 6; i < fiveBars.length; i++) {
    const window = fiveBars.slice(i - 6, i);
    const wHi = Math.max(...window.map(b => b.high));
    const wLo = Math.min(...window.map(b => b.low));
    const wRange = wHi - wLo;
    const rangeRatio = wRange / sessionRange;

    if (!inCompression && rangeRatio < 0.15) {
      inCompression = true;
      compressionStart = fiveBars[i - 6].et_min;
      compressionLow = wLo;
    } else if (inCompression && rangeRatio > 0.25) {
      const expansionBar = fiveBars[i - 1];
      const direction = expansionBar.close > (wHi + compressionLow) / 2 ? 'UP' : 'DOWN';
      const magnitude = direction === 'UP'
        ? Math.max(...fiveBars.slice(i - 1, Math.min(i + 3, fiveBars.length)).map(b => b.high)) - compressionLow
        : wHi - Math.min(...fiveBars.slice(i - 1, Math.min(i + 3, fiveBars.length)).map(b => b.low));

      patterns.push({
        pattern_type: 'COMPRESSION_EXPANSION',
        et_minute: compressionStart,
        duration_min: fiveBars[i - 1].et_min - compressionStart,
        direction,
        magnitude: Math.round(magnitude),
        context: {
          compression_range: Math.round(wRange),
          ratio_at_trigger: Math.round(rangeRatio * 100) / 100,
          session_range_at_time: Math.round(sessionRange)
        }
      });
      inCompression = false;
    }
  }
  return patterns;
}

function detectVolumeClimax(bars, fiveBars) {
  const patterns = [];
  if (fiveBars.length < 25) return patterns;

  for (let i = 20; i < fiveBars.length; i++) {
    const bar = fiveBars[i];
    const lookback = fiveBars.slice(i - 20, i);
    const avgVol = lookback.reduce((s, b) => s + b.vol, 0) / lookback.length;

    if (bar.vol > avgVol * 2.5 && avgVol > 0) {
      const sessHi = Math.max(...bars.filter(b => b.et_min <= bar.et_min).map(b => b.high));
      const sessLo = Math.min(...bars.filter(b => b.et_min <= bar.et_min).map(b => b.low));
      const sessRange = sessHi - sessLo;

      let location = 'MID';
      if (sessRange > 30) {
        const pct = (bar.close - sessLo) / sessRange;
        if (pct > 0.85) location = 'AT_HIGH';
        else if (pct < 0.15) location = 'AT_LOW';
      }

      const nextBars = fiveBars.slice(i + 1, i + 7);
      let reversal = false;
      if (nextBars.length >= 3) {
        if (location === 'AT_HIGH' && nextBars[2].close < bar.close - 20) reversal = true;
        if (location === 'AT_LOW' && nextBars[2].close > bar.close + 20) reversal = true;
      }

      patterns.push({
        pattern_type: 'VOLUME_CLIMAX',
        et_minute: bar.et_min,
        duration_min: 5,
        direction: location === 'AT_HIGH' ? 'DOWN' : location === 'AT_LOW' ? 'UP' : 'NEUTRAL',
        magnitude: Math.round(bar.vol / avgVol * 100) / 100,
        context: { location, vol_ratio: Math.round(bar.vol / avgVol * 10) / 10, reversal }
      });
    }
  }
  return patterns;
}

function detectFailedBreakouts(bars, orHigh, orLow, ibHigh, ibLow) {
  const patterns = [];
  const levels = [];
  if (orHigh && orLow) {
    levels.push({ name: 'OR_HIGH', price: orHigh, dir: 'UP' });
    levels.push({ name: 'OR_LOW', price: orLow, dir: 'DOWN' });
  }
  if (ibHigh && ibLow) {
    levels.push({ name: 'IB_HIGH', price: ibHigh, dir: 'UP' });
    levels.push({ name: 'IB_LOW', price: ibLow, dir: 'DOWN' });
  }

  for (const level of levels) {
    let broke = false;
    let brokeAt = null;
    let brokeMin = null;
    let maxExtension = 0;

    for (const bar of bars) {
      if (bar.et_min < 630) continue; // skip IB period for IB levels

      if (!broke) {
        if (level.dir === 'UP' && bar.high > level.price + 5) {
          broke = true;
          brokeAt = bar.high;
          brokeMin = bar.et_min;
          maxExtension = bar.high - level.price;
        } else if (level.dir === 'DOWN' && bar.low < level.price - 5) {
          broke = true;
          brokeAt = bar.low;
          brokeMin = bar.et_min;
          maxExtension = level.price - bar.low;
        }
      } else {
        if (level.dir === 'UP') {
          maxExtension = Math.max(maxExtension, bar.high - level.price);
          if (bar.close < level.price - 10 && bar.et_min - brokeMin >= 5) {
            patterns.push({
              pattern_type: 'FAILED_BREAKOUT',
              et_minute: brokeMin,
              duration_min: bar.et_min - brokeMin,
              direction: level.dir === 'UP' ? 'DOWN' : 'UP',
              magnitude: Math.round(maxExtension),
              context: { level: level.name, level_price: level.price, max_extension: Math.round(maxExtension) }
            });
            broke = false;
          }
        } else {
          maxExtension = Math.max(maxExtension, level.price - bar.low);
          if (bar.close > level.price + 10 && bar.et_min - brokeMin >= 5) {
            patterns.push({
              pattern_type: 'FAILED_BREAKOUT',
              et_minute: brokeMin,
              duration_min: bar.et_min - brokeMin,
              direction: 'UP',
              magnitude: Math.round(maxExtension),
              context: { level: level.name, level_price: level.price, max_extension: Math.round(maxExtension) }
            });
            broke = false;
          }
        }
      }
    }
  }
  return patterns;
}

function detectStopSweeps(bars) {
  const patterns = [];

  for (let i = 30; i < bars.length; i++) {
    const priorBars = bars.slice(0, i);
    const sessHi = Math.max(...priorBars.map(b => b.high));
    const sessLo = Math.min(...priorBars.map(b => b.low));
    const bar = bars[i];

    // Sweep below session low
    if (bar.low < sessLo - 3) {
      const extension = sessLo - bar.low;
      const nextBars = bars.slice(i + 1, i + 16);
      if (nextBars.length >= 5) {
        const maxBounce = Math.max(...nextBars.map(b => b.high)) - bar.low;
        if (maxBounce > extension * 2 && maxBounce > 40) {
          patterns.push({
            pattern_type: 'STOP_SWEEP',
            et_minute: bar.et_min,
            duration_min: 15,
            direction: 'UP',
            magnitude: Math.round(maxBounce),
            context: { side: 'LOW', extension: Math.round(extension), bounce: Math.round(maxBounce) }
          });
        }
      }
    }

    // Sweep above session high
    if (bar.high > sessHi + 3) {
      const extension = bar.high - sessHi;
      const nextBars = bars.slice(i + 1, i + 16);
      if (nextBars.length >= 5) {
        const maxDrop = bar.high - Math.min(...nextBars.map(b => b.low));
        if (maxDrop > extension * 2 && maxDrop > 40) {
          patterns.push({
            pattern_type: 'STOP_SWEEP',
            et_minute: bar.et_min,
            duration_min: 15,
            direction: 'DOWN',
            magnitude: Math.round(maxDrop),
            context: { side: 'HIGH', extension: Math.round(extension), drop: Math.round(maxDrop) }
          });
        }
      }
    }
  }

  // Deduplicate (keep first per side)
  const seen = {};
  return patterns.filter(p => {
    const key = `${p.context.side}_${Math.floor(p.et_minute / 30)}`;
    if (seen[key]) return false;
    seen[key] = true;
    return true;
  });
}

function detectRotationProfile(bars) {
  const rotations = [];
  let lastExt = bars[0]?.close || 0;
  let lastType = 'LOW';
  let rotStart = bars[0]?.et_min || 570;

  for (const bar of bars) {
    if (bar.high > lastExt && lastType === 'LOW' && bar.high - lastExt >= 65) {
      rotations.push({ et_min: rotStart, end_min: bar.et_min, dir: 'UP', size: Math.round(bar.high - lastExt) });
      lastExt = bar.high;
      lastType = 'HIGH';
      rotStart = bar.et_min;
    }
    if (bar.low < lastExt && lastType === 'HIGH' && lastExt - bar.low >= 65) {
      rotations.push({ et_min: rotStart, end_min: bar.et_min, dir: 'DOWN', size: Math.round(lastExt - bar.low) });
      lastExt = bar.low;
      lastType = 'LOW';
      rotStart = bar.et_min;
    }
    if (bar.high > lastExt && lastType === 'HIGH') lastExt = bar.high;
    if (bar.low < lastExt && lastType === 'LOW') lastExt = bar.low;
  }

  if (rotations.length < 2) return { rotations, patterns: [] };

  const patterns = [];
  const sizes = rotations.map(r => r.size);
  const avgSize = sizes.reduce((a, b) => a + b, 0) / sizes.length;
  const maxSize = Math.max(...sizes);

  // Rotation trend: are they getting bigger or smaller?
  const firstHalf = sizes.slice(0, Math.floor(sizes.length / 2));
  const secondHalf = sizes.slice(Math.floor(sizes.length / 2));
  const avgFirst = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
  const avgSecond = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;
  const trend = avgSecond > avgFirst * 1.2 ? 'EXPANDING' : avgSecond < avgFirst * 0.8 ? 'CONTRACTING' : 'STABLE';

  // Detect rotation clusters (3+ rotations within 30 min)
  for (let i = 0; i < rotations.length - 2; i++) {
    const window = rotations.slice(i, i + 3);
    const span = window[2].end_min - window[0].et_min;
    if (span <= 30) {
      patterns.push({
        pattern_type: 'ROTATION_CLUSTER',
        et_minute: window[0].et_min,
        duration_min: span,
        direction: 'NEUTRAL',
        magnitude: Math.round(window.reduce((s, r) => s + r.size, 0) / 3),
        context: { count_in_window: 3, avg_size: Math.round(window.reduce((s, r) => s + r.size, 0) / 3) }
      });
    }
  }

  // Deduplicate clusters (keep one per 30-min window)
  const seenClusters = {};
  const dedupedPatterns = patterns.filter(p => {
    const key = Math.floor(p.et_minute / 30);
    if (seenClusters[key]) return false;
    seenClusters[key] = true;
    return true;
  });

  return {
    rotations,
    count: rotations.length,
    avgSize: Math.round(avgSize),
    maxSize,
    trend,
    patterns: dedupedPatterns
  };
}

function detectOpenDrive(bars) {
  const patterns = [];
  const first15 = bars.filter(b => b.et_min >= 570 && b.et_min < 585);
  if (first15.length < 5) return patterns;

  const openPrice = first15[0].open;
  const hi15 = Math.max(...first15.map(b => b.high));
  const lo15 = Math.min(...first15.map(b => b.low));
  const close15 = first15[first15.length - 1].close;
  const range15 = hi15 - lo15;

  // Strong open drive: price moves 30+ pt in one direction in first 15 min
  // and closes near the extreme
  if (range15 > 30) {
    const upDrive = close15 > openPrice + 25 && (close15 - lo15) / range15 > 0.7;
    const downDrive = close15 < openPrice - 25 && (hi15 - close15) / range15 > 0.7;

    if (upDrive || downDrive) {
      // Check if drive continued or failed in next 30 min
      const next30 = bars.filter(b => b.et_min >= 585 && b.et_min < 615);
      let continued = false;
      if (next30.length > 0) {
        if (upDrive && Math.max(...next30.map(b => b.high)) > hi15 + 10) continued = true;
        if (downDrive && Math.min(...next30.map(b => b.low)) < lo15 - 10) continued = true;
      }

      patterns.push({
        pattern_type: continued ? 'OPEN_DRIVE' : 'OPEN_DRIVE_FAIL',
        et_minute: 570,
        duration_min: 15,
        direction: upDrive ? 'UP' : 'DOWN',
        magnitude: Math.round(Math.abs(close15 - openPrice)),
        context: { range_15min: Math.round(range15), continued }
      });
    }
  }
  return patterns;
}

function detectCloseDrive(bars) {
  const patterns = [];
  const last30 = bars.filter(b => b.et_min >= 930);
  if (last30.length < 10) return patterns;

  const startPrice = last30[0].open;
  const endPrice = last30[last30.length - 1].close;
  const move = endPrice - startPrice;

  if (Math.abs(move) > 30) {
    patterns.push({
      pattern_type: 'CLOSE_DRIVE',
      et_minute: 930,
      duration_min: 30,
      direction: move > 0 ? 'UP' : 'DOWN',
      magnitude: Math.round(Math.abs(move)),
      context: { start: Math.round(startPrice), end: Math.round(endPrice) }
    });
  }
  return patterns;
}

function detectPOCMagnet(bars) {
  const patterns = [];

  // Build running POC
  const volByPrice = {};
  let maxExcursion = 0;
  let excursionStart = null;

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    const bk = Math.round(bar.close / 25) * 25;
    volByPrice[bk] = (volByPrice[bk] || 0) + Number(bar.vol || 0);

    const poc = parseInt(Object.entries(volByPrice).sort((a, b) => b[1] - a[1])[0]?.[0]) || bar.close;
    const dist = Math.abs(bar.close - poc);

    if (dist > 80 && !excursionStart) {
      excursionStart = bar.et_min;
      maxExcursion = dist;
    } else if (excursionStart && dist > maxExcursion) {
      maxExcursion = dist;
    } else if (excursionStart && dist < 15) {
      patterns.push({
        pattern_type: 'POC_MAGNET',
        et_minute: excursionStart,
        duration_min: bar.et_min - excursionStart,
        direction: bar.close > poc ? 'DOWN' : 'UP',
        magnitude: Math.round(maxExcursion),
        context: { poc: Math.round(poc), max_excursion: Math.round(maxExcursion), return_time_min: bar.et_min - excursionStart }
      });
      excursionStart = null;
      maxExcursion = 0;
    }
  }

  return patterns;
}

function detectGapBehavior(bars, priorClose) {
  const patterns = [];
  if (!priorClose) return patterns;

  const openPrice = bars[0]?.open;
  if (!openPrice) return patterns;

  const gap = openPrice - priorClose;
  if (Math.abs(gap) < 30) return patterns;

  // Check if gap filled (price returns to prior close)
  let filled = false;
  let fillMin = null;
  for (const bar of bars) {
    if (gap > 0 && bar.low <= priorClose) { filled = true; fillMin = bar.et_min; break; }
    if (gap < 0 && bar.high >= priorClose) { filled = true; fillMin = bar.et_min; break; }
  }

  patterns.push({
    pattern_type: filled ? 'GAP_FILL' : 'GAP_HOLD',
    et_minute: 570,
    duration_min: filled ? fillMin - 570 : 390,
    direction: gap > 0 ? 'UP' : 'DOWN',
    magnitude: Math.round(Math.abs(gap)),
    context: { gap_pt: Math.round(gap), filled, fill_time_min: filled ? fillMin - 570 : null }
  });

  return patterns;
}

function detectVWAPCrosses(bars) {
  let cumPV = 0, cumV = 0;
  let crosses = 0;
  let lastSide = null;

  for (const bar of bars) {
    cumPV += (bar.high + bar.low + bar.close) / 3 * Number(bar.vol || 1);
    cumV += Number(bar.vol || 1);
    const vwap = cumPV / cumV;
    const side = bar.close > vwap ? 'ABOVE' : 'BELOW';
    if (lastSide && side !== lastSide) crosses++;
    lastSide = side;
  }

  return { crosses, finalVwap: cumV > 0 ? cumPV / cumV : null };
}

// ─── SESSION CLASSIFIER ─────────────────────────────────────────────

function classifySession(bars, rotCount, closePct) {
  const openPrice = bars[0]?.open;
  const closePrice = bars[bars.length - 1]?.close;
  const sessHi = Math.max(...bars.map(b => b.high));
  const sessLo = Math.min(...bars.map(b => b.low));
  const range = sessHi - sessLo;
  const move = closePrice - openPrice;

  if (range < 80) return 'NARROW_RANGE';
  if (rotCount >= 25) return 'EXTREME_CHOP';
  if (rotCount >= 15) return 'CHOP';
  if (Math.abs(move) > range * 0.5 && closePct > 75) return 'TREND_UP';
  if (Math.abs(move) > range * 0.5 && closePct < 25) return 'TREND_DOWN';
  if (closePct > 40 && closePct < 60) return 'BALANCE';
  if (closePct > 60) return 'DRIFT_UP';
  if (closePct < 40) return 'DRIFT_DOWN';
  return 'MIXED';
}

function classifyOpen(bars) {
  const first15 = bars.filter(b => b.et_min >= 570 && b.et_min < 585);
  if (first15.length < 3) return 'UNKNOWN';
  const open = first15[0].open;
  const close15 = first15[first15.length - 1].close;
  const move = close15 - open;
  if (move > 30) return 'DRIVE_UP';
  if (move < -30) return 'DRIVE_DOWN';
  return 'CHOP';
}

function classifyClose(bars) {
  const last30 = bars.filter(b => b.et_min >= 930);
  if (last30.length < 5) return 'UNKNOWN';
  const start = last30[0].open;
  const end = last30[last30.length - 1].close;
  const sessHi = Math.max(...bars.map(b => b.high));
  const sessLo = Math.min(...bars.map(b => b.low));
  const range = sessHi - sessLo;
  const closePct = range > 0 ? Math.round((end - sessLo) / range * 100) : 50;

  if (end - start > 30) return 'DRIVE_UP';
  if (start - end > 30) return 'DRIVE_DOWN';
  if (closePct > 75) return 'CLOSE_HIGH';
  if (closePct < 25) return 'CLOSE_LOW';
  return 'CLOSE_MID';
}

// ─── MAIN SCANNER ───────────────────────────────────────────────────

export async function scanSession(tradeDate) {
  const barsRes = await query(
    `SELECT (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts))::int as et_min,
            open::float, high::float, low::float, close::float, volume::bigint as vol
     FROM price_bars_primary WHERE symbol='NQ' AND ts::date=$1
     AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
     ORDER BY ts`, [tradeDate]);

  const bars = barsRes.rows;
  if (bars.length < 30) return null;

  // Build 5-min bars
  const fiveMinMap = {};
  for (const bar of bars) {
    const bk = Math.floor(bar.et_min / 5) * 5;
    if (!fiveMinMap[bk]) fiveMinMap[bk] = { et_min: bk, open: bar.open, high: bar.high, low: bar.low, close: bar.close, vol: Number(bar.vol || 0) };
    else {
      fiveMinMap[bk].high = Math.max(fiveMinMap[bk].high, bar.high);
      fiveMinMap[bk].low = Math.min(fiveMinMap[bk].low, bar.low);
      fiveMinMap[bk].close = bar.close;
      fiveMinMap[bk].vol += Number(bar.vol || 0);
    }
  }
  const fiveBars = Object.values(fiveMinMap).sort((a, b) => a.et_min - b.et_min);

  // Get OR/IB from ACD
  const acdRes = await query(`SELECT or_high::float, or_low::float FROM acd_daily_log WHERE trade_date=$1`, [tradeDate]);
  const acd = acdRes.rows[0] || {};

  // IB from bars
  const ibBars = bars.filter(b => b.et_min >= 570 && b.et_min < 630);
  const ibHigh = ibBars.length ? Math.max(...ibBars.map(b => b.high)) : null;
  const ibLow = ibBars.length ? Math.min(...ibBars.map(b => b.low)) : null;

  // Prior day close
  const priorRes = await query(
    `SELECT close::float FROM price_bars_primary WHERE symbol='NQ' AND ts::date < $1
     AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
     ORDER BY ts DESC LIMIT 1`, [tradeDate]);
  const priorClose = priorRes.rows[0]?.close;

  // Core metrics
  const openPrice = bars[0].open;
  const closePrice = bars[bars.length - 1].close;
  const sessHi = Math.max(...bars.map(b => b.high));
  const sessLo = Math.min(...bars.map(b => b.low));
  const range = sessHi - sessLo;
  const closePct = range > 0 ? Math.round((closePrice - sessLo) / range * 100) : 50;

  // POC
  const volBk = {};
  for (const bar of bars) {
    const bk = Math.round(bar.close / 25) * 25;
    volBk[bk] = (volBk[bk] || 0) + Number(bar.vol || 0);
  }
  const poc = parseInt(Object.entries(volBk).sort((a, b) => b[1] - a[1])[0]?.[0]);

  // VWAP
  const { crosses: vwapCrosses, finalVwap } = detectVWAPCrosses(bars);

  // 14-day ATR
  const atrRes = await query(
    `SELECT ROUND(AVG(range)::numeric) as atr FROM (
      SELECT ts::date, MAX(high)-MIN(low) as range FROM price_bars_primary
      WHERE symbol='NQ' AND ts::date < $1
      AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
      GROUP BY ts::date ORDER BY ts::date DESC LIMIT 14
    ) x`, [tradeDate]);
  const atr = parseFloat(atrRes.rows[0]?.atr) || range;

  // Run all detectors
  const rotProfile = detectRotationProfile(bars);
  const allPatterns = [
    ...detectCompressionExpansion(bars, fiveBars),
    ...detectVolumeClimax(bars, fiveBars),
    ...detectFailedBreakouts(bars, acd.or_high, acd.or_low, ibHigh, ibLow),
    ...detectStopSweeps(bars),
    ...rotProfile.patterns,
    ...detectOpenDrive(bars),
    ...detectCloseDrive(bars),
    ...detectPOCMagnet(bars),
    ...detectGapBehavior(bars, priorClose),
  ];

  // Classify session
  const sessionType = classifySession(bars, rotProfile.count, closePct);
  const openType = classifyOpen(bars);
  const closeType = classifyClose(bars);

  // Build analysis record
  const analysis = {
    trade_date: tradeDate,
    session_type: sessionType,
    open_type: openType,
    close_type: closeType,
    open_price: Math.round(openPrice * 100) / 100,
    close_price: Math.round(closePrice * 100) / 100,
    session_high: Math.round(sessHi * 100) / 100,
    session_low: Math.round(sessLo * 100) / 100,
    range_pt: Math.round(range),
    atr_ratio: Math.round(range / atr * 100) / 100,
    gap_pt: priorClose ? Math.round(openPrice - priorClose) : null,
    gap_filled: allPatterns.some(p => p.pattern_type === 'GAP_FILL'),
    close_vs_open: Math.round(closePrice - openPrice),
    close_pct_of_range: closePct,
    vwap: Math.round(finalVwap),
    close_vs_vwap: Math.round(closePrice - finalVwap),
    poc,
    close_vs_poc: Math.round(closePrice - poc),
    rotations_65pt: rotProfile.count,
    avg_rotation_size: rotProfile.avgSize || 0,
    max_rotation_size: rotProfile.maxSize || 0,
    rotation_trend: rotProfile.trend || 'NONE',
    compressions: allPatterns.filter(p => p.pattern_type === 'COMPRESSION_EXPANSION').length,
    volume_climaxes: allPatterns.filter(p => p.pattern_type === 'VOLUME_CLIMAX').length,
    failed_breakouts: allPatterns.filter(p => p.pattern_type === 'FAILED_BREAKOUT').length,
    stop_sweeps: allPatterns.filter(p => p.pattern_type === 'STOP_SWEEP').length,
    vwap_crosses: vwapCrosses,
    patterns: JSON.stringify(allPatterns.map(p => p.pattern_type)),
    metrics: JSON.stringify({
      ib_range: ibHigh && ibLow ? Math.round(ibHigh - ibLow) : null,
      or_range: acd.or_high && acd.or_low ? Math.round(acd.or_high - acd.or_low) : null,
      rotation_trend: rotProfile.trend,
    }),
  };

  return { analysis, patterns: allPatterns };
}

// ─── PERSIST RESULTS ────────────────────────────────────────────────

export async function persistScan(tradeDate, result) {
  if (!result) return;
  const { analysis: a, patterns } = result;

  await query(`DELETE FROM session_analysis WHERE trade_date=$1`, [tradeDate]);
  await query(`DELETE FROM session_patterns WHERE trade_date=$1`, [tradeDate]);

  await query(
    `INSERT INTO session_analysis (trade_date, session_type, open_type, close_type,
      open_price, close_price, session_high, session_low, range_pt, atr_ratio,
      gap_pt, gap_filled, close_vs_open, close_pct_of_range, vwap, close_vs_vwap,
      poc, close_vs_poc, rotations_65pt, avg_rotation_size, max_rotation_size,
      rotation_trend, compressions, volume_climaxes, failed_breakouts, stop_sweeps,
      vwap_crosses, patterns, metrics)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29)`,
    [a.trade_date, a.session_type, a.open_type, a.close_type,
     a.open_price, a.close_price, a.session_high, a.session_low, a.range_pt, a.atr_ratio,
     a.gap_pt, a.gap_filled, a.close_vs_open, a.close_pct_of_range, a.vwap, a.close_vs_vwap,
     a.poc, a.close_vs_poc, a.rotations_65pt, a.avg_rotation_size, a.max_rotation_size,
     a.rotation_trend, a.compressions, a.volume_climaxes, a.failed_breakouts, a.stop_sweeps,
     a.vwap_crosses, a.patterns, a.metrics]);

  for (const p of patterns) {
    await query(
      `INSERT INTO session_patterns (trade_date, pattern_type, et_minute, duration_min, direction, magnitude, context)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [tradeDate, p.pattern_type, p.et_minute, p.duration_min, p.direction, p.magnitude, JSON.stringify(p.context)]);
  }

  return patterns.length;
}

// ─── CROSS-DAY PATTERN MINING ───────────────────────────────────────

export async function minePatterns() {
  const days = await query(`SELECT * FROM session_analysis ORDER BY trade_date`);
  if (days.rows.length < 10) return { insights: ['Not enough data yet — need 10+ days'] };

  const insights = [];
  const d = days.rows;

  // 1. Session type distribution
  const typeCounts = {};
  d.forEach(r => { typeCounts[r.session_type] = (typeCounts[r.session_type] || 0) + 1; });
  insights.push({ type: 'DISTRIBUTION', label: 'Session types', data: typeCounts });

  // 2. Next-day tendencies after each session type
  const nextDay = {};
  for (let i = 0; i < d.length - 1; i++) {
    const today = d[i].session_type;
    const tomorrow = d[i + 1];
    if (!nextDay[today]) nextDay[today] = { up: 0, down: 0, total: 0, avg_range: 0 };
    nextDay[today].total++;
    nextDay[today].avg_range += tomorrow.range_pt;
    if (tomorrow.close_vs_open > 0) nextDay[today].up++;
    else nextDay[today].down++;
  }
  for (const [type, data] of Object.entries(nextDay)) {
    data.avg_range = Math.round(data.avg_range / data.total);
    data.up_pct = Math.round(data.up / data.total * 100);
  }
  insights.push({ type: 'NEXT_DAY', label: 'Next-day after session type', data: nextDay });

  // 3. Gap behavior stats
  const gapDays = d.filter(r => r.gap_pt && Math.abs(r.gap_pt) > 30);
  if (gapDays.length > 5) {
    const gapFillRate = Math.round(gapDays.filter(r => r.gap_filled).length / gapDays.length * 100);
    const avgGap = Math.round(gapDays.reduce((s, r) => s + Math.abs(r.gap_pt), 0) / gapDays.length);
    insights.push({ type: 'GAP_STATS', label: 'Gap behavior (>30pt)', data: { fill_rate: gapFillRate, avg_gap: avgGap, count: gapDays.length } });
  }

  // 4. Rotation count vs next-day behavior
  const highRot = d.filter(r => r.rotations_65pt >= 15);
  if (highRot.length >= 3) {
    const nextAfterHighRot = [];
    for (const hr of highRot) {
      const idx = d.findIndex(r => r.trade_date === hr.trade_date);
      if (idx >= 0 && idx < d.length - 1) nextAfterHighRot.push(d[idx + 1]);
    }
    if (nextAfterHighRot.length > 0) {
      const avgNextRange = Math.round(nextAfterHighRot.reduce((s, r) => s + r.range_pt, 0) / nextAfterHighRot.length);
      const avgNextMove = Math.round(nextAfterHighRot.reduce((s, r) => s + Math.abs(r.close_vs_open), 0) / nextAfterHighRot.length);
      insights.push({ type: 'HIGH_ROT_FOLLOW', label: 'After high-rotation days (15+)', data: { count: highRot.length, avg_next_range: avgNextRange, avg_next_move: avgNextMove } });
    }
  }

  // 5. Close position predicts next day
  const closeHigh = d.filter(r => r.close_pct_of_range > 75);
  const closeLow = d.filter(r => r.close_pct_of_range < 25);
  const afterCloseHigh = [];
  const afterCloseLow = [];
  for (const ch of closeHigh) {
    const idx = d.findIndex(r => r.trade_date === ch.trade_date);
    if (idx >= 0 && idx < d.length - 1) afterCloseHigh.push(d[idx + 1]);
  }
  for (const cl of closeLow) {
    const idx = d.findIndex(r => r.trade_date === cl.trade_date);
    if (idx >= 0 && idx < d.length - 1) afterCloseLow.push(d[idx + 1]);
  }
  if (afterCloseHigh.length >= 3) {
    const upPct = Math.round(afterCloseHigh.filter(r => r.close_vs_open > 0).length / afterCloseHigh.length * 100);
    insights.push({ type: 'CLOSE_HIGH_FOLLOW', label: 'After close in top 25%', data: { n: closeHigh.length, next_up_pct: upPct } });
  }
  if (afterCloseLow.length >= 3) {
    const upPct = Math.round(afterCloseLow.filter(r => r.close_vs_open > 0).length / afterCloseLow.length * 100);
    insights.push({ type: 'CLOSE_LOW_FOLLOW', label: 'After close in bottom 25%', data: { n: closeLow.length, next_up_pct: upPct } });
  }

  // 6. Pattern frequency
  const patternCounts = {};
  const allPats = await query(`SELECT pattern_type, COUNT(*) as n, ROUND(AVG(magnitude)::numeric) as avg_mag FROM session_patterns GROUP BY pattern_type ORDER BY n DESC`);
  for (const p of allPats.rows) patternCounts[p.pattern_type] = { count: parseInt(p.n), avg_magnitude: parseFloat(p.avg_mag) };
  insights.push({ type: 'PATTERN_FREQ', label: 'Pattern frequency', data: patternCounts });

  return { insights, days_analyzed: d.length };
}

// ─── LEVEL FADE CROSS-CUT MINING ────────────────────────────────────
// Runs every level × every dimension, finds combos above threshold,
// persists discoveries, returns newly significant patterns.

export async function mineLevelFades() {
  const days = await query(
    `SELECT DISTINCT ts::date as d FROM price_bars_primary
     WHERE symbol='NQ' AND ts::date >= CURRENT_DATE - '90 days'::interval
     AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959 ORDER BY d`);

  const cfg = { target: 20, stop: 25 };
  const levelNames = ['PD_POC','PD_VAH','PD_VAL','OR_HIGH','OR_LOW','IB_HIGH','IB_LOW','FLOOR_PIVOT','FLOOR_R1','FLOOR_S1','PW_HIGH','PW_LOW','PW_VAH','PW_VAL','1M_VAH','1M_VAL','3M_VAH','3M_VAL'];
  const allTrades = [];

  for (const dayRow of days.rows) {
    const d = dayRow.d;
    const barsRes = await query(
      `SELECT (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts))::int as et_min,
              open::float, high::float, low::float, close::float, volume::bigint as vol
       FROM price_bars_primary WHERE symbol='NQ' AND ts::date=$1
       AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959 ORDER BY ts`, [d]);
    const bars = barsRes.rows;
    if (bars.length < 60) continue;

    const dow = new Date(d + 'T12:00:00').getDay();
    const dowName = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dow];
    const saRes = await query(`SELECT session_type, range_pt FROM session_analysis WHERE trade_date=$1`, [d]);
    const sessionType = saRes.rows[0]?.session_type || 'UNKNOWN';
    const rangeDay = saRes.rows[0]?.range_pt || 0;
    const dtRes = await query(`SELECT day_type FROM acd_daily_log WHERE trade_date=$1`, [d]);
    const dayType = dtRes.rows[0]?.day_type || 'UNKNOWN';
    const arRes = await query(`SELECT overnight_inventory, open_vs_prior_value FROM auction_reads WHERE trade_date=$1`, [d]);
    const overnight = arRes.rows[0]?.overnight_inventory || 'UNKNOWN';
    const openVsVal = arRes.rows[0]?.open_vs_prior_value || 'UNKNOWN';

    const pdRes = await query(
      `SELECT poc::float, vah::float, val::float, session_high::float as hi, session_low::float as lo, session_close::float as cl
       FROM developing_value_log WHERE trade_date < $1 ORDER BY trade_date DESC LIMIT 1`, [d]);
    const pd = pdRes.rows[0];
    const orBars = bars.filter(b => b.et_min >= 570 && b.et_min < 600);
    const orH = orBars.length ? Math.max(...orBars.map(b => b.high)) : null;
    const orL = orBars.length ? Math.min(...orBars.map(b => b.low)) : null;
    const ibBars = bars.filter(b => b.et_min >= 570 && b.et_min < 630);
    const ibH = ibBars.length ? Math.max(...ibBars.map(b => b.high)) : null;
    const ibL = ibBars.length ? Math.min(...ibBars.map(b => b.low)) : null;
    let floorP = null, floorR1 = null, floorS1 = null;
    if (pd) { floorP = (pd.hi + pd.lo + pd.cl) / 3; floorR1 = 2 * floorP - pd.lo; floorS1 = 2 * floorP - pd.hi; }

    // Prior week high/low
    const pwRes = await query(
      `SELECT MAX(high)::float as hi, MIN(low)::float as lo FROM price_bars_primary
       WHERE symbol='NQ' AND ts::date >= ($1::date - interval '7 days') AND ts::date < $1
       AND EXTRACT(dow FROM ts::date) BETWEEN 1 AND 5
       AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959`, [d]);
    const pwHigh = pwRes.rows[0]?.hi;
    const pwLow = pwRes.rows[0]?.lo;

    // Composite value area helper
    const computeVA = async (interval) => {
      const res = await query(
        `SELECT close::float, volume::bigint as vol FROM price_bars_primary
         WHERE symbol='NQ' AND ts::date >= ($1::date - interval '${interval}') AND ts::date < $1
         AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959`, [d]);
      if (res.rows.length < 100) return { vah: null, val: null };
      const vbk = {};
      for (const b of res.rows) { const bk = Math.round(b.close / 25) * 25; vbk[bk] = (vbk[bk] || 0) + Number(b.vol || 0); }
      const sorted = Object.entries(vbk).sort((a, b) => b[1] - a[1]);
      const totalV = sorted.reduce((s, [, v]) => s + v, 0);
      let cumV = 0; const levels = [];
      for (const [price, vol] of sorted) { cumV += vol; levels.push(parseFloat(price)); if (cumV >= totalV * 0.7) break; }
      return { vah: Math.max(...levels), val: Math.min(...levels) };
    };
    const pwVA = await computeVA('7 days');
    const m1VA = await computeVA('1 month');
    const m3VA = await computeVA('3 months');

    const getLevel = (name) => {
      switch (name) {
        case 'PD_VAH': return pd?.vah; case 'PD_VAL': return pd?.val; case 'PD_POC': return pd?.poc;
        case 'OR_HIGH': return orH; case 'OR_LOW': return orL;
        case 'IB_HIGH': return ibH; case 'IB_LOW': return ibL;
        case 'FLOOR_PIVOT': return floorP; case 'FLOOR_R1': return floorR1; case 'FLOOR_S1': return floorS1;
        case 'PW_HIGH': return pwHigh; case 'PW_LOW': return pwLow;
        case 'PW_VAH': return pwVA.vah; case 'PW_VAL': return pwVA.val;
        case '1M_VAH': return m1VA.vah; case '1M_VAL': return m1VA.val;
        case '3M_VAH': return m3VA.vah; case '3M_VAL': return m3VA.val;
      }
    };

    for (const levelName of levelNames) {
      let lastTrade = -15;
      const level = getLevel(levelName);
      if (!level) continue;
      for (let i = (levelName.startsWith('IB') ? 60 : 30); i < bars.length; i++) {
        if (i - lastTrade < 15) continue;
        if (Math.abs(bars[i].close - level) > 8) continue;
        const lb = bars.slice(Math.max(0, i - 5), i);
        if (lb.length < 3) continue;
        const approach = lb[0].close < level ? 'FROM_BELOW' : 'FROM_ABOVE';
        const fadeDir = approach === 'FROM_BELOW' ? 'SHORT' : 'LONG';
        const entry = bars[i].close;
        const hour = Math.floor(bars[i].et_min / 60);
        let touchNum = 0;
        for (let k = 30; k < i; k++) { if (Math.abs(bars[k].close - level) <= 8) touchNum++; }
        const firstTouch = touchNum <= 5;

        for (let j = i + 1; j < Math.min(i + 31, bars.length); j++) {
          let won = false, lost = false;
          if (fadeDir === 'SHORT') {
            if (entry - bars[j].low >= cfg.target) won = true;
            if (bars[j].high - entry >= cfg.stop) lost = true;
          } else {
            if (bars[j].high - entry >= cfg.target) won = true;
            if (entry - bars[j].low >= cfg.stop) lost = true;
          }
          if (won || lost) {
            const rangeBucket = rangeDay < 200 ? 'NARROW' : rangeDay < 400 ? 'NORMAL' : rangeDay < 600 ? 'WIDE' : 'EXTREME';
            allTrades.push({
              date: d, level: levelName, won, fadeDir, hour, dow, dowName,
              sessionType, dayType, rangeBucket, overnight, openVsVal, firstTouch
            });
            lastTrade = j;
            break;
          }
        }
        lastTrade = i;
      }
    }
  }

  // Slice every dimension combination
  const dimensions = [
    { name: 'level_x_dow', fn: t => `${t.level}×${t.dowName}` },
    { name: 'level_x_session', fn: t => `${t.level}×${t.sessionType}` },
    { name: 'level_x_hour', fn: t => `${t.level}×${t.hour}:00` },
    { name: 'level_x_daytype', fn: t => `${t.level}×${t.dayType}` },
    { name: 'level_x_range', fn: t => `${t.level}×${t.rangeBucket}` },
    { name: 'level_x_overnight', fn: t => `${t.level}×${t.overnight}` },
    { name: 'level_x_openval', fn: t => `${t.level}×${t.openVsVal}` },
    { name: 'level_x_touch', fn: t => `${t.level}×${t.firstTouch ? 'FIRST_TOUCH' : 'RETEST'}` },
    { name: 'dir_x_session', fn: t => `${t.fadeDir}×${t.sessionType}` },
    { name: 'dow_x_hour', fn: t => `${t.dowName}×${t.hour}:00` },
    { name: 'session_x_hour', fn: t => `${t.sessionType}×${t.hour}:00` },
    { name: 'level_x_dow_x_hour', fn: t => `${t.level}×${t.dowName}×${t.hour}:00` },
    { name: 'level_x_session_x_hour', fn: t => `${t.level}×${t.sessionType}×${t.hour}:00` },
    { name: 'level_x_overnight_x_dir', fn: t => `${t.level}×${t.overnight}×${t.fadeDir}` },
  ];

  const MIN_N = 8;
  const MIN_WR = 0.65;
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const discoveries = [];

  for (const dim of dimensions) {
    const groups = {};
    for (const t of allTrades) {
      const key = dim.fn(t);
      if (!groups[key]) groups[key] = { wins: 0, losses: 0 };
      groups[key][t.won ? 'wins' : 'losses']++;
    }

    for (const [key, r] of Object.entries(groups)) {
      const total = r.wins + r.losses;
      if (total < MIN_N) continue;
      const wr = r.wins / total;
      const netPnl = (r.wins * cfg.target - r.losses * cfg.stop) * 2;
      if (wr >= MIN_WR && netPnl > 0) {
        const patternKey = `${dim.name}:${key}`;
        discoveries.push({ patternKey, dimension: dim.name, wr: Math.round(wr * 100), n: total, netPnl });
      }
    }
  }

  // Persist discoveries and detect NEW ones
  const newDiscoveries = [];
  for (const disc of discoveries) {
    const existing = await query(`SELECT id, win_rate, sample_size, notified FROM pattern_discoveries WHERE pattern_key=$1`, [disc.patternKey]);
    if (existing.rows.length === 0) {
      await query(
        `INSERT INTO pattern_discoveries (pattern_key, dimension, win_rate, sample_size, net_pnl_dollars, first_seen, last_updated)
         VALUES ($1,$2,$3,$4,$5,$6,$6)`,
        [disc.patternKey, disc.dimension, disc.wr / 100, disc.n, disc.netPnl, todayStr]);
      newDiscoveries.push(disc);
    } else {
      const prev = existing.rows[0];
      await query(
        `UPDATE pattern_discoveries SET win_rate=$2, sample_size=$3, net_pnl_dollars=$4, last_updated=$5 WHERE id=$1`,
        [prev.id, disc.wr / 100, disc.n, disc.netPnl, todayStr]);
      if (disc.n > prev.sample_size + 3 && !prev.notified) {
        newDiscoveries.push({ ...disc, strengthened: true });
      }
    }
  }

  // Mark patterns that fell below threshold as degraded
  const allActive = await query(`SELECT id, pattern_key FROM pattern_discoveries WHERE status='ACTIVE'`);
  const activeKeys = new Set(discoveries.map(d => d.patternKey));
  for (const row of allActive.rows) {
    if (!activeKeys.has(row.pattern_key)) {
      await query(`UPDATE pattern_discoveries SET status='DEGRADED', last_updated=$2 WHERE id=$1`, [row.id, todayStr]);
    }
  }

  return {
    totalTrades: allTrades.length,
    totalDiscoveries: discoveries.length,
    newDiscoveries,
    topPatterns: discoveries.sort((a, b) => b.netPnl - a.netPnl).slice(0, 20)
  };
}
