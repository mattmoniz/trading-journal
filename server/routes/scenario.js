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

export default router;
