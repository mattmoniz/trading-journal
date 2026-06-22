import { query } from '../db.js';

/**
 * Calculates the active balance zone using developing_value_log.
 * Logic:
 * - A balance zone starts when 2 consecutive days have overlapping value areas (VA).
 * - A value area overlap exists if: max(val_1, val_2) <= min(vah_1, vah_2).
 * - Once started, the balance area expands as subsequent days' VAs overlap with the active balance range.
 * - Peak & Fail Exception: If a day's VA does not overlap with the balance, check if the NEXT day's VA returns to the balance.
 *   If it does, the breakout day is ignored, and the balance remains intact.
 *   If it does not return (i.e. 2 days outside), the balance is broken and terminated.
 */
export async function getActiveBalanceZone(targetDate) {
  // Query trailing 30 completed sessions before the targetDate
  const res = await query(`
    SELECT trade_date::text as date, val::float, vah::float, poc::float
    FROM developing_value_log
    WHERE trade_date <= $1
    ORDER BY trade_date ASC
  `, [targetDate]);
  
  const rows = res.rows;
  if (rows.length < 2) return null;

  let activeBalance = null; // { low, high, days: [] }
  let balanceHistory = [];

  for (let i = 0; i < rows.length; i++) {
    const day = rows[i];
    
    if (!activeBalance) {
      if (i < rows.length - 1) {
        const nextDay = rows[i + 1];
        const overlapLo = Math.max(day.val, nextDay.val);
        const overlapHi = Math.min(day.vah, nextDay.vah);
        if (overlapLo <= overlapHi) {
          activeBalance = {
            low: Math.min(day.val, nextDay.val),
            high: Math.max(day.vah, nextDay.vah),
            days: [day.date, nextDay.date]
          };
          i++; // skip next day as it is consumed
        }
      }
    } else {
      const overlapLo = Math.max(day.val, activeBalance.low);
      const overlapHi = Math.min(day.vah, activeBalance.high);
      
      if (overlapLo <= overlapHi) {
        // Expand boundaries
        activeBalance.low = Math.min(activeBalance.low, day.val);
        activeBalance.high = Math.max(activeBalance.high, day.vah);
        activeBalance.days.push(day.date);
      } else {
        // Breakout or Peak & Fail Check
        let isPeakAndFail = false;
        if (i < rows.length - 1) {
          const nextDay = rows[i + 1];
          const returnLo = Math.max(nextDay.val, activeBalance.low);
          const returnHi = Math.min(nextDay.vah, activeBalance.high);
          if (returnLo <= returnHi) {
            isPeakAndFail = true;
          }
        }

        if (isPeakAndFail) {
          // Peak & Fail day range is ignored; balance area continues
          activeBalance.days.push(day.date);
          i++;
          if (rows[i]) activeBalance.days.push(rows[i].date);
        } else {
          // Breakout confirmed; terminate current balance
          balanceHistory.push(activeBalance);
          activeBalance = null;
          
          // Re-evaluate if this day starts a new balance with next day
          if (i < rows.length - 1) {
            const nextDay = rows[i + 1];
            const newOverlapLo = Math.max(day.val, nextDay.val);
            const newOverlapHi = Math.min(day.vah, nextDay.vah);
            if (newOverlapLo <= newOverlapHi) {
              activeBalance = {
                low: Math.min(day.val, nextDay.val),
                high: Math.max(day.vah, nextDay.vah),
                days: [day.date, nextDay.date]
              };
              i++;
            }
          }
        }
      }
    }
  }

  // If there's an active balance including the target date or prior day, return it
  if (activeBalance && (activeBalance.days.includes(targetDate) || activeBalance.days.slice(-1)[0] >= targetDate)) {
    return activeBalance;
  }
  return balanceHistory.pop() || null;
}

/**
 * Calculates 14-day RTH Average True Range (ATR)
 */
export async function get14DayRthAtr(targetDate) {
  try {
    const res = await query(`
      WITH daily_ranges AS (
        SELECT ts::date as session_date, MAX(high) - MIN(low) as session_range
        FROM price_bars
        WHERE symbol='NQ'
          AND ts::date < $1
          AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) BETWEEN 570 AND 959
        GROUP BY ts::date
        ORDER BY ts::date DESC
        LIMIT 14
      )
      SELECT AVG(session_range)::float as atr_14d FROM daily_ranges;
    `, [targetDate]);
    return res.rows[0]?.atr_14d || 150.0; // fallback to 150 pts
  } catch (err) {
    console.error('Error calculating ATR:', err);
    return 150.0;
  }
}

/**
 * Generates the complete Session Forecast
 */
export async function getSessionForecast(targetDate) {
  // 1. Get ATR
  const atr = await get14DayRthAtr(targetDate);

  // 2. Get Balance Zone
  const balanceZone = await getActiveBalanceZone(targetDate);

  // 3. Get Macro Events for today
  const macroQ = await query(`
    SELECT event_type, event_time::text, impact_level, notes
    FROM macro_events
    WHERE event_date = $1 AND impact_level = 'HIGH'
  `, [targetDate]);
  const macroEvents = macroQ.rows;
  const isMacroDay = macroEvents.length > 0;

  // 4. Get prior day's High, Low, Close for Floor Pivots
  const priorOHLCQ = await query(`
    SELECT MAX(high)::float as h, MIN(low)::float as l, (array_agg(close ORDER BY ts DESC))[1]::float as c
    FROM price_bars
    WHERE symbol='NQ'
      AND ts::date = (
        SELECT MAX(ts::date) FROM price_bars_primary WHERE symbol='NQ' AND ts::date < $1
      )
      AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) BETWEEN 570 AND 959
  `, [targetDate]);
  
  const prior = priorOHLCQ.rows[0] || {};
  let floorPivots = null;
  if (prior.h != null && prior.l != null && prior.c != null) {
    const pp = (prior.h + prior.l + prior.c) / 3;
    const r1 = 2 * pp - prior.l;
    const s1 = 2 * pp - prior.h;
    const r2 = pp + (prior.h - prior.l);
    const s2 = pp - (prior.h - prior.l);
    const r3 = prior.h + 2 * (pp - prior.l);
    const s3 = prior.l - 2 * (prior.h - pp);
    floorPivots = { pp, r1, s1, r2, s2, r3, s3 };
  }

  // 5. Get prior day VAH, VAL, POC from developing_value_log
  const priorValueQ = await query(`
    SELECT val::float as val, vah::float as vah, poc::float as poc
    FROM developing_value_log
    WHERE trade_date < $1
    ORDER BY trade_date DESC LIMIT 1
  `, [targetDate]);
  const priorValue = priorValueQ.rows[0] || null;

  // 6. Get G-Line (Weekly Open)
  const gLineQ = await query(`
    SELECT (array_agg(open ORDER BY ts ASC))[1]::float as g_line
    FROM price_bars_primary WHERE symbol='NQ'
      AND ts::date = date_trunc('week', ($1::text)::date) - INTERVAL '1 day'
      AND EXTRACT(hour FROM ts) >= 18
  `, [targetDate]);
  const gLine = gLineQ.rows[0]?.g_line || null;

  // 7. Get Monthly Pivot
  const monthlyQ = await query(`
    SELECT pivot_level::float as pivot, pivot_r1::float as r1, pivot_s1::float as s1, prior_month_high::float as pm_high, prior_month_low::float as pm_low
    FROM acd_monthly_pivot
    ORDER BY month_year DESC LIMIT 1
  `);
  const monthly = monthlyQ.rows[0] || null;

  // 8. Overnight High/Low & Inventory
  const onQ = await query(`
    SELECT MAX(high) as on_high, MIN(low) as on_low FROM (
      SELECT high, low FROM price_bars_primary WHERE symbol='NQ'
        AND ts::date = ($1::date - INTERVAL '1 day')::date
        AND EXTRACT(HOUR FROM ts)*60+EXTRACT(MINUTE FROM ts) >= 960
      UNION ALL
      SELECT high, low FROM price_bars_primary WHERE symbol='NQ'
        AND ts::date = $1::date
        AND EXTRACT(HOUR FROM ts)*60+EXTRACT(MINUTE FROM ts) < 570
    ) x
  `, [targetDate]);
  const onHigh = onQ.rows[0]?.on_high || null;
  const onLow = onQ.rows[0]?.on_low || null;
  const onMid = onHigh && onLow ? (onHigh + onLow) / 2 : null;

  // Reference for distance sorting (overnight mid or prior day close)
  const referencePrice = onMid || prior.c || 30000;

  // Assemble and sort all active levels
  const rawLevels = [
    { type: 'PRIOR VAL', val: priorValue?.val, desc: 'VAL. Fast resolution (2.1 bar dwell, 2.3 retests). Support holds or breaks quickly.' },
    { type: 'PRIOR POC', val: priorValue?.poc, desc: 'POC Magnet. Expect fast approach (16 pts/bar), touch-and-go (1.3 bar dwell). Target only.' },
    { type: 'PRIOR VAH', val: priorValue?.vah, desc: 'VAH. Expect heavy retests (4.4 avg) & churn (4.8 bar dwell). Let it absorb before fade.' },
    { type: 'G-LINE', val: gLine, desc: 'Weekly open pivot. Macro directional filter.' },
  ];

  if (floorPivots) {
    rawLevels.push(
      { type: 'FLOOR PP', val: floorPivots.pp, desc: 'Floor Pivot PP. Inter session neutral line.' },
      { type: 'FLOOR R1', val: floorPivots.r1, desc: 'Floor Pivot R1. Standard resistance.' },
      { type: 'FLOOR S1', val: floorPivots.s1, desc: 'Floor Pivot S1. Standard support.' },
      { type: 'FLOOR R2', val: floorPivots.r2, desc: 'Floor Pivot R2. Volatility resistance.' },
      { type: 'FLOOR S2', val: floorPivots.s2, desc: 'Floor Pivot S2. Volatility support.' },
      { type: 'FLOOR R3', val: floorPivots.r3, desc: 'Floor Pivot R3 (Exhaustion). Expect strong reaction / reversal.' },
      { type: 'FLOOR S3', val: floorPivots.s3, desc: 'Floor Pivot S3 (Exhaustion). Expect strong reaction / reversal.' }
    );
  }

  if (monthly) {
    rawLevels.push(
      { type: 'MONTHLY PIVOT', val: monthly.pivot, desc: 'Monthly Pivot. Core higher timeframe direction.' },
      { type: 'MONTHLY R1', val: monthly.r1, desc: 'Monthly R1. Macro resistance.' },
      { type: 'MONTHLY S1', val: monthly.s1, desc: 'Monthly S1. Macro support.' },
      { type: 'PM HIGH', val: monthly.pm_high, desc: 'Prior Month High. Major overhead level.' },
      { type: 'PM LOW', val: monthly.pm_low, desc: 'Prior Month Low. Major macro support.' }
    );
  }

  if (balanceZone) {
    rawLevels.push(
      { type: 'BALANCE LOW', val: balanceZone.low, desc: `Balance Zone Floor. Excursions snap back 83% of times within 15 bars.` },
      { type: 'BALANCE HIGH', val: balanceZone.high, desc: `Balance Zone Ceiling. Excursions snap back 83% of times within 15 bars.` }
    );
  }

  // Filter valid levels, calculate distance, and sort
  const levels = rawLevels
    .filter(l => l.val != null)
    .map(l => ({
      type: l.type,
      price: l.val,
      distance: Math.abs(l.val - referencePrice),
      desc: l.desc
    }))
    .sort((a, b) => a.distance - b.distance);

  // Multi-timeframe range position (5, 10, 20 day)
  const rangePositions = {};
  const qStats = { TOP: { upPct: 59, avgMove: 28, avgRange: 278 }, UPPER: { upPct: 55, avgMove: 3, avgRange: 323 }, MIDDLE: { upPct: 58, avgMove: 63, avgRange: 312 }, LOWER: { upPct: 44, avgMove: -52, avgRange: 473 }, BOTTOM: { upPct: 71, avgMove: 170, avgRange: 474 } };
  for (const n of [5, 10, 20]) {
    const rQ = await query(`
      SELECT MAX(h) as hi, MIN(l) as lo FROM (
        SELECT MAX(high)::float as h, MIN(low)::float as l
        FROM price_bars_primary WHERE symbol='NQ'
        AND ts::date BETWEEN ($1::date - ${n}) AND ($1::date - 1)
        AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
        GROUP BY ts::date
      ) x
    `, [targetDate]).catch(() => ({ rows: [] }));
    const r = rQ.rows[0];
    if (r?.hi && r?.lo && referencePrice) {
      const range = r.hi - r.lo;
      const pct = range > 0 ? (referencePrice - r.lo) / range : 0.5;
      const quintile = pct >= 0.80 ? 'TOP' : pct >= 0.60 ? 'UPPER' : pct >= 0.40 ? 'MIDDLE' : pct >= 0.20 ? 'LOWER' : 'BOTTOM';
      rangePositions[`d${n}`] = { hi: r.hi, lo: r.lo, range, pct: Math.round(pct * 100), quintile, ...qStats[quintile] };
    }
  }

  // Bracket age: how many consecutive days has price stayed inside the 20-day range?
  let bracketAge = 0;
  if (rangePositions.d20) {
    const recentQ = await query(`
      SELECT ts::date::text as d, MAX(high)::float as h, MIN(low)::float as l
      FROM price_bars_primary WHERE symbol='NQ'
      AND ts::date BETWEEN ($1::date - 30) AND ($1::date - 1)
      AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
      GROUP BY ts::date ORDER BY ts::date DESC
    `, [targetDate]).catch(() => ({ rows: [] }));
    for (const day of recentQ.rows) {
      if (day.h <= rangePositions.d20.hi && day.l >= rangePositions.d20.lo) bracketAge++;
      else break;
    }
  }

  const rangePosition = rangePositions.d20 || null;

  return {
    date: targetDate,
    atr14: atr,
    balanceZone: balanceZone ? {
      active: true,
      low: balanceZone.low,
      high: balanceZone.high,
      age: balanceZone.days.length,
      days: balanceZone.days
    } : { active: false },
    isMacroDay,
    macroEvents,
    floorPivots,
    levels,
    overnight: {
      high: onHigh,
      low: onLow,
      mid: onMid
    },
    rangePosition,
    rangePositions,
    bracketAge,
  };
}
