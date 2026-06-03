import { Router } from 'express';
import { query } from '../db.js';

const router = Router();

function applyDayFilters(dayTrades, { maxTradesPerDay, stopAfterLosses, profitLock, dll }) {
  const included = [];
  let runningPnl = 0;
  let consecutiveLosses = 0;

  for (const trade of dayTrades) {
    if (maxTradesPerDay != null && included.length >= maxTradesPerDay) break;
    if (dll != null && runningPnl <= -dll) break;
    if (profitLock != null && runningPnl >= profitLock) break;

    const pnl = parseFloat(trade.pnl) || 0;
    included.push(trade);
    runningPnl += pnl;

    if (pnl < 0) consecutiveLosses++;
    else if (pnl > 0) consecutiveLosses = 0;

    if (stopAfterLosses != null && consecutiveLosses >= stopAfterLosses) break;
    if (dll != null && runningPnl <= -dll) break;
    if (profitLock != null && runningPnl >= profitLock) break;
  }

  return included;
}

async function fetchBaseData(params) {
  const {
    startDate, endDate, accounts, daysOfWeek, dayTypes,
  } = params;

  const end   = endDate   || new Date().toISOString().slice(0, 10);
  const start = startDate || (() => { const d = new Date(); d.setDate(d.getDate() - 60); return d.toISOString().slice(0, 10); })();

  const conds  = ["t.entry_time IS NOT NULL", "t.pnl IS NOT NULL", 't.log_date >= $1', 't.log_date <= $2'];
  const qp     = [start, end];

  if (accounts?.length) {
    const ph = accounts.map((_, i) => `$${qp.length + i + 1}`).join(',');
    qp.push(...accounts);
    conds.push(`t.custom_fields->>'account' IN (${ph})`);
  }
  if (daysOfWeek?.length > 0 && daysOfWeek.length < 7) {
    const ph = daysOfWeek.map((_, i) => `$${qp.length + i + 1}`).join(',');
    qp.push(...daysOfWeek);
    conds.push(`EXTRACT(dow FROM t.log_date) IN (${ph})`);
  }

  let dayTypeJoin = 'LEFT JOIN acd_daily_log adl ON adl.trade_date = t.log_date';
  if (dayTypes?.length > 0 && dayTypes.length < 3) {
    const ph = dayTypes.map((_, i) => `$${qp.length + i + 1}`).join(',');
    qp.push(...dayTypes);
    conds.push(`(adl.day_type IN (${ph}) OR adl.day_type IS NULL)`);
  }

  const r = await query(`
    SELECT t.id, t.log_date::text, t.entry_time::text, t.pnl::numeric as pnl,
      t.custom_fields->>'account' as account,
      EXTRACT(dow FROM t.log_date)::int as dow,
      adl.day_type, t.setup_type
    FROM trades t ${dayTypeJoin}
    WHERE ${conds.join(' AND ')}
    ORDER BY t.log_date, t.entry_time
  `, qp);

  return { rows: r.rows, start, end };
}

function groupByDay(rows) {
  const byDay = {};
  for (const t of rows) {
    if (!byDay[t.log_date]) byDay[t.log_date] = [];
    byDay[t.log_date].push(t);
  }
  return byDay;
}

function applyTimeFilter(trades, timeFrom, timeTo) {
  if (!timeFrom && !timeTo) return trades;
  return trades.filter(t => {
    const tTime = t.entry_time ? t.entry_time.slice(11, 16) : null;
    if (!tTime) return false;
    if (timeFrom && tTime < timeFrom) return false;
    if (timeTo   && tTime > timeTo)   return false;
    return true;
  });
}

function computeStats(includedTrades, equityCurve, actualPnl) {
  const netPnl   = includedTrades.reduce((s, t) => s + parseFloat(t.pnl), 0);
  const winners  = includedTrades.filter(t => parseFloat(t.pnl) > 0).length;
  const losers   = includedTrades.filter(t => parseFloat(t.pnl) < 0).length;
  const winDays  = equityCurve.filter(e => e.pnl > 0).length;
  const lossDays = equityCurve.filter(e => e.pnl < 0).length;
  let peakEq = 0;
  for (const p of equityCurve) if (p.equity > peakEq) peakEq = p.equity;
  const finalEq = equityCurve.length ? equityCurve[equityCurve.length - 1].equity : 0;

  return {
    netPnl:      parseFloat(netPnl.toFixed(2)),
    delta:       parseFloat((netPnl - actualPnl).toFixed(2)),
    tradeCount:  includedTrades.length,
    dayCount:    equityCurve.length,
    winners,
    losers,
    winRate:     includedTrades.length ? parseFloat((winners / includedTrades.length * 100).toFixed(1)) : 0,
    winDays,
    lossDays,
    winDayRate:  equityCurve.length ? parseFloat((winDays / equityCurve.length * 100).toFixed(1)) : 0,
    avgPerTrade: includedTrades.length ? parseFloat((netPnl / includedTrades.length).toFixed(2)) : 0,
    avgPerDay:   equityCurve.length   ? parseFloat((netPnl / equityCurve.length).toFixed(2))   : 0,
    giveBack:    parseFloat(Math.max(0, peakEq - finalEq).toFixed(2)),
    equityCurve,
  };
}

// POST /api/scenario
router.post('/scenario', async (req, res) => {
  try {
    const { timeFrom, timeTo, maxTradesPerDay, stopAfterLosses, profitLock, dll, ...baseParams } = req.body;
    const { rows, start, end } = await fetchBaseData(baseParams);
    const byDay = groupByDay(rows);
    const sortedDays = Object.keys(byDay).sort();

    const included = [];
    const equityCurve = [];
    let runningEq = 0;
    let actualRunningEq = 0;
    const actualEquityCurve = [];

    for (const day of sortedDays) {
      const allDay = byDay[day];
      const eligible = applyTimeFilter(allDay, timeFrom, timeTo);
      const inDay = applyDayFilters(eligible, { maxTradesPerDay, stopAfterLosses, profitLock, dll });
      included.push(...inDay);
      const dayPnl = inDay.reduce((s, t) => s + parseFloat(t.pnl), 0);
      runningEq += dayPnl;
      equityCurve.push({ date: day, pnl: parseFloat(dayPnl.toFixed(2)), equity: parseFloat(runningEq.toFixed(2)) });

      const actualDayPnl = allDay.reduce((s, t) => s + parseFloat(t.pnl), 0);
      actualRunningEq += actualDayPnl;
      actualEquityCurve.push({ date: day, pnl: parseFloat(actualDayPnl.toFixed(2)), equity: parseFloat(actualRunningEq.toFixed(2)) });
    }

    const actualPnl = rows.reduce((s, t) => s + parseFloat(t.pnl), 0);

    res.json({
      scenario: computeStats(included, equityCurve, actualPnl),
      actual: {
        netPnl:     parseFloat(actualPnl.toFixed(2)),
        tradeCount: rows.length,
        dayCount:   sortedDays.length,
        equityCurve: actualEquityCurve,
      },
      meta: { start, end },
    });
  } catch(e) {
    console.error('[scenario]', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/scenario/dll-compare  — run multiple DLL levels side-by-side
router.post('/scenario/dll-compare', async (req, res) => {
  try {
    const { dllLevels = [200, 300, 400, 500], ...baseParams } = req.body;
    const { rows } = await fetchBaseData(baseParams);
    const byDay = groupByDay(rows);
    const sortedDays = Object.keys(byDay).sort();
    const actualPnl = rows.reduce((s, t) => s + parseFloat(t.pnl), 0);

    // Build per-day actual P&Ls for recovery analysis
    const dayActual = {};
    for (const [day, trades] of Object.entries(byDay)) {
      dayActual[day] = trades.reduce((s, t) => s + parseFloat(t.pnl), 0);
    }

    const results = dllLevels.map(dll => {
      const included = [];
      const equityCurve = [];
      let runningEq = 0;
      let dllHitDays = 0;
      let savedDays  = 0;
      let cutTooEarlyDays = 0;
      let savedTotal = 0;
      let cutTooEarlyTotal = 0;
      let dllHitDayPnlSum = 0;
      let dllHitActualPnlSum = 0;

      for (const day of sortedDays) {
        const dayTrades = byDay[day];
        const inDay = dll != null
          ? applyDayFilters(dayTrades, { dll })
          : dayTrades;

        included.push(...inDay);
        const dayPnl = inDay.reduce((s, t) => s + parseFloat(t.pnl), 0);
        runningEq += dayPnl;
        equityCurve.push({ date: day, pnl: parseFloat(dayPnl.toFixed(2)), equity: parseFloat(runningEq.toFixed(2)) });

        // DLL analysis: was it hit this day?
        const dllHit = dll != null && inDay.length < dayTrades.length;
        if (dllHit) {
          dllHitDays++;
          const actual = dayActual[day];
          dllHitDayPnlSum += dayPnl;
          dllHitActualPnlSum += actual;
          const wouldHaveBeen = actual;
          if (wouldHaveBeen <= dayPnl) {
            // actual was worse than DLL stop — DLL saved us
            savedDays++;
            savedTotal += dayPnl - wouldHaveBeen;
          } else {
            // actual was better — DLL cut too early
            cutTooEarlyDays++;
            cutTooEarlyTotal += wouldHaveBeen - dayPnl;
          }
        }
      }

      const netPnl = included.reduce((s, t) => s + parseFloat(t.pnl), 0);
      return {
        dll,
        netPnl:             parseFloat(netPnl.toFixed(2)),
        delta:              parseFloat((netPnl - actualPnl).toFixed(2)),
        tradeCount:         included.length,
        dllHitDays,
        savedDays,
        savedTotal:         parseFloat(savedTotal.toFixed(2)),
        cutTooEarlyDays,
        cutTooEarlyTotal:   parseFloat(cutTooEarlyTotal.toFixed(2)),
        avgDllDayPnl:       dllHitDays ? parseFloat((dllHitDayPnlSum / dllHitDays).toFixed(2)) : null,
        avgDllActualDayPnl: dllHitDays ? parseFloat((dllHitActualPnlSum / dllHitDays).toFixed(2)) : null,
        equityCurve,
      };
    });

    // Also no-DLL baseline
    const noDll = {
      dll: null,
      netPnl: parseFloat(actualPnl.toFixed(2)),
      delta: 0,
      tradeCount: rows.length,
      dllHitDays: 0,
      savedDays: 0, savedTotal: 0, cutTooEarlyDays: 0, cutTooEarlyTotal: 0,
      avgDllDayPnl: null, avgDllActualDayPnl: null,
    };

    res.json({ levels: [...results, noDll], actualPnl: parseFloat(actualPnl.toFixed(2)) });
  } catch(e) {
    console.error('[scenario/dll-compare]', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/scenario/accounts — list distinct accounts in trades
router.get('/scenario/accounts', async (req, res) => {
  try {
    const r = await query(`
      SELECT DISTINCT custom_fields->>'account' as account, MAX(log_date) as last_active
      FROM trades WHERE custom_fields->>'account' IS NOT NULL
      GROUP BY 1 ORDER BY last_active DESC
    `);
    res.json(r.rows.map(r => r.account));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Shared helper: run scenario simulation on pre-fetched data ──────────────
function runScenarioOnData(byDay, sortedDays, params) {
  const { timeFrom, timeTo, maxTradesPerDay, stopAfterLosses, profitLock, dll } = params;
  let scenarioPnl = 0, actualPnl = 0, tradeCount = 0, winners = 0, winDays = 0;
  let peak = 0, maxDD = 0, runningEq = 0;

  for (const day of sortedDays) {
    const allDay = byDay[day];
    actualPnl += allDay.reduce((s, t) => s + parseFloat(t.pnl), 0);

    const eligible = applyTimeFilter(allDay, timeFrom, timeTo);
    const inDay    = applyDayFilters(eligible, { maxTradesPerDay, stopAfterLosses, profitLock, dll });
    const dayPnl   = inDay.reduce((s, t) => s + parseFloat(t.pnl), 0);

    scenarioPnl += dayPnl;
    tradeCount  += inDay.length;
    winners     += inDay.filter(t => parseFloat(t.pnl) > 0).length;
    if (dayPnl > 0) winDays++;

    runningEq += dayPnl;
    if (runningEq > peak) peak = runningEq;
    const dd = peak - runningEq;
    if (dd > maxDD) maxDD = dd;
  }

  return {
    scenarioPnl: parseFloat(scenarioPnl.toFixed(2)),
    actualPnl:   parseFloat(actualPnl.toFixed(2)),
    delta:       parseFloat((scenarioPnl - actualPnl).toFixed(2)),
    tradeCount,
    dayCount:    sortedDays.length,
    winRate:     tradeCount ? parseFloat((winners / tradeCount * 100).toFixed(1)) : 0,
    winDayRate:  sortedDays.length ? parseFloat((winDays / sortedDays.length * 100).toFixed(1)) : 0,
    maxDrawdown: parseFloat(maxDD.toFixed(2)),
  };
}

// POST /api/scenario/patterns — pattern analysis (hourly, DOW, sequence, after-win/loss)
// Respects date range + account + dayType/DOW filters but NOT sequential rules.
router.post('/scenario/patterns', async (req, res) => {
  try {
    const { startDate, endDate, accounts, daysOfWeek, dayTypes } = req.body;
    const { rows } = await fetchBaseData({ startDate, endDate, accounts, daysOfWeek, dayTypes });
    const byDay = groupByDay(rows);
    const sortedDays = Object.keys(byDay).sort();

    const hourMap = {}, dowMap = {}, seqMap = {};
    let afterLoss = { count: 0, wins: 0, pnl: 0 };
    let afterWin  = { count: 0, wins: 0, pnl: 0 };

    for (const day of sortedDays) {
      const fills = byDay[day];
      const dow   = new Date(day + 'T12:00:00Z').getDay();
      const dayPnl = fills.reduce((s, t) => s + parseFloat(t.pnl), 0);

      if (!dowMap[dow]) dowMap[dow] = { days: 0, wins: 0, pnl: 0 };
      dowMap[dow].days++;
      dowMap[dow].pnl += dayPnl;
      if (dayPnl > 0) dowMap[dow].wins++;

      for (let i = 0; i < fills.length; i++) {
        const fill = fills[i];
        const pnl  = parseFloat(fill.pnl);
        const hour = fill.entry_time ? parseInt(fill.entry_time.slice(11, 13)) : null;

        if (hour !== null) {
          if (!hourMap[hour]) hourMap[hour] = { count: 0, wins: 0, pnl: 0 };
          hourMap[hour].count++;
          hourMap[hour].pnl += pnl;
          if (pnl > 0) hourMap[hour].wins++;
        }

        const seq      = Math.min(i + 1, 4);
        const seqLabel = seq < 4 ? `#${seq}` : '4+';
        if (!seqMap[seq]) seqMap[seq] = { count: 0, wins: 0, pnl: 0, label: seqLabel };
        seqMap[seq].count++;
        seqMap[seq].pnl += pnl;
        if (pnl > 0) seqMap[seq].wins++;

        if (i > 0) {
          const prevPnl = parseFloat(fills[i - 1].pnl);
          const tgt = prevPnl < 0 ? afterLoss : afterWin;
          tgt.count++;
          tgt.pnl += pnl;
          if (pnl > 0) tgt.wins++;
        }
      }
    }

    const DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    res.json({
      hourly: Object.entries(hourMap).map(([h, s]) => ({
        hour: parseInt(h), label: `${h}:00`,
        count: s.count,
        totalPnl: parseFloat(s.pnl.toFixed(2)),
        avgPnl:   parseFloat((s.pnl / s.count).toFixed(2)),
        winRate:  parseFloat((s.wins / s.count * 100).toFixed(1)),
      })).sort((a, b) => a.hour - b.hour),

      dayOfWeek: Object.entries(dowMap).map(([dow, s]) => ({
        dow: parseInt(dow), label: DOW_NAMES[parseInt(dow)],
        days: s.days,
        totalPnl: parseFloat(s.pnl.toFixed(2)),
        avgPnl:   parseFloat((s.pnl / s.days).toFixed(2)),
        winRate:  parseFloat((s.wins / s.days * 100).toFixed(1)),
      })).sort((a, b) => a.dow - b.dow),

      sessionSequence: Object.entries(seqMap).map(([seq, s]) => ({
        seq: parseInt(seq), label: s.label,
        count: s.count,
        totalPnl: parseFloat(s.pnl.toFixed(2)),
        avgPnl:   parseFloat((s.pnl / s.count).toFixed(2)),
        winRate:  parseFloat((s.wins / s.count * 100).toFixed(1)),
      })).sort((a, b) => a.seq - b.seq),

      afterWinLoss: {
        afterLoss: {
          count:    afterLoss.count,
          avgPnl:   afterLoss.count ? parseFloat((afterLoss.pnl / afterLoss.count).toFixed(2)) : 0,
          winRate:  afterLoss.count ? parseFloat((afterLoss.wins / afterLoss.count * 100).toFixed(1)) : 0,
          totalPnl: parseFloat(afterLoss.pnl.toFixed(2)),
        },
        afterWin: {
          count:    afterWin.count,
          avgPnl:   afterWin.count ? parseFloat((afterWin.pnl / afterWin.count).toFixed(2)) : 0,
          winRate:  afterWin.count ? parseFloat((afterWin.wins / afterWin.count * 100).toFixed(1)) : 0,
          totalPnl: parseFloat(afterWin.pnl.toFixed(2)),
        },
      },
    });
  } catch (e) {
    console.error('[scenario/patterns]', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/scenario/optimize — grid search with in-sample / out-of-sample split + plateau check
router.post('/scenario/optimize', async (req, res) => {
  try {
    const { gridParams = {}, topN = 10, ...baseParams } = req.body;

    const grid = {
      dll:             gridParams.dll             ?? [null, 100, 150, 200, 250, 300, 400, 500, 600],
      timeTo:          gridParams.timeTo          ?? [null, '11:00', '11:30', '12:00', '12:30', '13:00', '14:00'],
      maxTradesPerDay: gridParams.maxTradesPerDay ?? [null, 2, 3, 4, 5],
      stopAfterLosses: gridParams.stopAfterLosses ?? [null],
      profitLock:      gridParams.profitLock      ?? [null],
    };

    const totalCombos = grid.dll.length * grid.timeTo.length * grid.maxTradesPerDay.length *
                        grid.stopAfterLosses.length * grid.profitLock.length;
    if (totalCombos > 3000) {
      return res.status(400).json({ error: `${totalCombos} combinations exceeds cap of 3000. Reduce ranges.` });
    }

    const { rows } = await fetchBaseData(baseParams);
    const byDay      = groupByDay(rows);
    const sortedDays = Object.keys(byDay).sort();

    if (sortedDays.length < 4) {
      return res.status(400).json({ error: 'Need at least 4 trading days to split in-sample / out-of-sample.' });
    }

    const mid      = Math.floor(sortedDays.length / 2);
    const isDays   = sortedDays.slice(0, mid);
    const oosDays  = sortedDays.slice(mid);
    const isByDay  = Object.fromEntries(isDays.map(d => [d, byDay[d]]));
    const oosByDay = Object.fromEntries(oosDays.map(d => [d, byDay[d]]));

    const results = [];
    for (const dll of grid.dll)
      for (const timeTo of grid.timeTo)
        for (const maxTradesPerDay of grid.maxTradesPerDay)
          for (const stopAfterLosses of grid.stopAfterLosses)
            for (const profitLock of grid.profitLock) {
              const params   = { dll, timeTo, maxTradesPerDay, stopAfterLosses, profitLock };
              const isStats  = runScenarioOnData(isByDay, isDays, params);
              results.push({ params, isStats });
            }

    results.sort((a, b) => b.isStats.delta - a.isStats.delta);
    const topCombos = results.slice(0, topN);

    const PARAM_KEYS = ['dll', 'timeTo', 'maxTradesPerDay', 'stopAfterLosses', 'profitLock'];

    const enriched = topCombos.map(({ params, isStats }) => {
      const oosStats = runScenarioOnData(oosByDay, oosDays, params);

      // Plateau: vary each param by ±1 step — count how many neighbors also improve on IS
      let neighborCount = 0, neighborGood = 0;
      for (const key of PARAM_KEYS) {
        const arr = grid[key];
        const idx = arr.indexOf(params[key]);
        if (idx === -1) continue;
        for (const di of [-1, 1]) {
          const ni = idx + di;
          if (ni < 0 || ni >= arr.length) continue;
          neighborCount++;
          const nStats = runScenarioOnData(isByDay, isDays, { ...params, [key]: arr[ni] });
          if (nStats.delta > 0) neighborGood++;
        }
      }
      const plateauRatio = neighborCount > 0 ? neighborGood / neighborCount : 0;
      const isRobust     = oosStats.delta > 0 && plateauRatio >= 0.5;

      return {
        params,
        isStats,
        oosStats,
        plateauRatio: parseFloat(plateauRatio.toFixed(2)),
        robust: isRobust,
        label: isRobust
          ? 'ROBUST'
          : oosStats.delta <= 0
            ? 'OVERFIT (OOS fails)'
            : 'FRAGILE (isolated spike)',
      };
    });

    const actualPnl = rows.reduce((s, t) => s + parseFloat(t.pnl), 0);
    res.json({
      topCombos: enriched,
      totalCombos,
      meta: {
        isSplit:  { start: isDays[0],  end: isDays[isDays.length - 1],   days: isDays.length },
        oosSplit: { start: oosDays[0], end: oosDays[oosDays.length - 1], days: oosDays.length },
        actualPnl: parseFloat(actualPnl.toFixed(2)),
      },
    });
  } catch (e) {
    console.error('[scenario/optimize]', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/scenario/monte-carlo — resample daily P&L distribution N times
router.post('/scenario/monte-carlo', async (req, res) => {
  try {
    const { iterations = 5000, scenarioParams = {}, ...baseParams } = req.body;
    const { timeFrom, timeTo, maxTradesPerDay, stopAfterLosses, profitLock, dll } = scenarioParams;

    const { rows } = await fetchBaseData(baseParams);
    const byDay      = groupByDay(rows);
    const sortedDays = Object.keys(byDay).sort();

    const dailyPnls = [];
    for (const day of sortedDays) {
      const eligible = applyTimeFilter(byDay[day], timeFrom, timeTo);
      const inDay    = applyDayFilters(eligible, { maxTradesPerDay, stopAfterLosses, profitLock, dll });
      dailyPnls.push(parseFloat(inDay.reduce((s, t) => s + parseFloat(t.pnl), 0).toFixed(2)));
    }

    if (dailyPnls.length === 0) return res.json({ error: 'No data for this scenario' });

    const n = dailyPnls.length;
    const finalPnls = [], maxDrawdowns = [];

    for (let iter = 0; iter < iterations; iter++) {
      let cum = 0, peak = 0, maxDD = 0;
      for (let i = 0; i < n; i++) {
        cum += dailyPnls[Math.floor(Math.random() * n)];
        if (cum > peak) peak = cum;
        const dd = peak - cum;
        if (dd > maxDD) maxDD = dd;
      }
      finalPnls.push(parseFloat(cum.toFixed(2)));
      maxDrawdowns.push(parseFloat(maxDD.toFixed(2)));
    }

    finalPnls.sort((a, b) => a - b);
    maxDrawdowns.sort((a, b) => a - b);
    const p = (arr, pct) => arr[Math.min(Math.floor(arr.length * pct), arr.length - 1)];

    const minV = finalPnls[0], maxV = finalPnls[finalPnls.length - 1];
    const binCount = 40;
    const binSize  = (maxV - minV) / binCount || 1;
    const bins = Array.from({ length: binCount }, (_, i) => ({
      label: parseFloat((minV + (i + 0.5) * binSize).toFixed(0)),
      from:  parseFloat((minV + i * binSize).toFixed(0)),
      to:    parseFloat((minV + (i + 1) * binSize).toFixed(0)),
      count: 0,
    }));
    for (const v of finalPnls) {
      const idx = Math.min(Math.floor((v - minV) / binSize), binCount - 1);
      bins[idx].count++;
    }

    const scenarioNetPnl = dailyPnls.reduce((s, x) => s + x, 0);
    const actualNetPnl   = rows.reduce((s, t) => s + parseFloat(t.pnl), 0);

    res.json({
      iterations,
      scenarioNetPnl: parseFloat(scenarioNetPnl.toFixed(2)),
      actualNetPnl:   parseFloat(actualNetPnl.toFixed(2)),
      dailyPnls,
      distribution: {
        p5:            p(finalPnls, 0.05),
        p25:           p(finalPnls, 0.25),
        median:        p(finalPnls, 0.50),
        p75:           p(finalPnls, 0.75),
        p95:           p(finalPnls, 0.95),
        probProfitable: parseFloat((finalPnls.filter(v => v > 0).length / iterations * 100).toFixed(1)),
        bins,
      },
      drawdown: {
        p50: p(maxDrawdowns, 0.50),
        p75: p(maxDrawdowns, 0.75),
        p95: p(maxDrawdowns, 0.95),
      },
    });
  } catch (e) {
    console.error('[scenario/monte-carlo]', e);
    res.status(500).json({ error: e.message });
  }
});

export default router;
