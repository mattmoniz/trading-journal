import express from 'express';
import { query } from '../db.js';

const router = express.Router();

// Helper to build WHERE clause (reused across tearsheet endpoints)
function buildWhere(queryParams = {}) {
  const { dateFrom, dateTo, account } = queryParams;
  const conds = ['exit_time IS NOT NULL'];
  const params = [];
  let p = 1;
  if (dateFrom) { conds.push(`log_date >= $${p++}`); params.push(dateFrom); }
  if (dateTo)   { conds.push(`log_date <= $${p++}`); params.push(dateTo); }
  if (account)  { conds.push(`custom_fields->>'account' = ANY($${p++}::text[])`); params.push(account.split(',').filter(Boolean)); }
  return { where: conds.join(' AND '), params };
}

// Extended overview: Sharpe, Sortino, SQN, Kelly, Calmar, Omega, duration stats, long/short
router.get('/stats/tearsheet-overview', async (req, res) => {
  try {
    const { where, params } = buildWhere(req.query);

    const tradesRes = await query(`
      SELECT pnl, log_date, direction,
        EXTRACT(EPOCH FROM (exit_time - entry_time)) as duration_secs
      FROM trades WHERE ${where} ORDER BY entry_time ASC
    `, params);
    const trades = tradesRes.rows;
    if (!trades.length) return res.json({});

    const pnls = trades.map(t => parseFloat(t.pnl));
    const n = pnls.length;
    const wins = pnls.filter(p => p > 0);
    const losses = pnls.filter(p => p < 0);
    const totalPnl = pnls.reduce((a, b) => a + b, 0);
    const grossProfit = wins.reduce((a, b) => a + b, 0);
    const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
    const avgWin = wins.length ? grossProfit / wins.length : 0;
    const avgLoss = losses.length ? grossLoss / losses.length : 0;
    const winRate = wins.length / n;
    const payoffRatio = avgLoss > 0 ? avgWin / avgLoss : null;
    const expectancy = totalPnl / n;
    const kelly = payoffRatio ? winRate - (1 - winRate) / payoffRatio : null;
    const breakevenWR = payoffRatio ? 1 / (1 + payoffRatio) : null;

    const mean = totalPnl / n;
    const variance = pnls.reduce((s, p) => s + (p - mean) ** 2, 0) / n;
    const stdDev = Math.sqrt(variance);
    const sqn = stdDev > 0 ? (expectancy / stdDev) * Math.sqrt(n) : null;

    let peak = 0, trough = 0, cum = 0, maxDD = 0, maxRunup = 0, runupBase = 0;
    let ddStart = null, ddEpisodes = [], currentDDStart = null;
    trades.forEach((t, i) => {
      const p = parseFloat(t.pnl);
      cum += p;
      if (cum > peak) {
        if (currentDDStart !== null) {
          ddEpisodes.push({ start: currentDDStart, end: i, depth: peak - trough });
          currentDDStart = null;
        }
        const runup = cum - runupBase;
        if (runup > maxRunup) maxRunup = runup;
        peak = cum;
        trough = cum;
      }
      if (cum < trough) {
        trough = cum;
        if (currentDDStart === null) currentDDStart = i;
      }
      const dd = peak - cum;
      if (dd > maxDD) maxDD = dd;
    });
    const calmar = maxDD > 0 ? totalPnl / maxDD : null;
    const recoveryFactor = maxDD > 0 ? totalPnl / maxDD : null;
    const omega = grossLoss > 0 ? grossProfit / grossLoss : null;

    const dailyRes = await query(`
      WITH ep_fills AS (
        SELECT log_date, custom_fields->>'account' as account, exit_time,
          CASE WHEN custom_fields->'sierra_data'->>'Cumulative Profit/Loss (C)' ~ '^-?[0-9]+(\\.[0-9]+)?$'
          THEN (custom_fields->'sierra_data'->>'Cumulative Profit/Loss (C)')::numeric ELSE NULL END as cum_pl
        FROM trades WHERE ${where} AND custom_fields->'sierra_data'->>'Exit DateTime' LIKE '% EP'
      ),
      last_ep AS (SELECT DISTINCT ON (log_date, account) log_date, account, cum_pl FROM ep_fills ORDER BY log_date, account, exit_time DESC),
      daily_pa AS (SELECT log_date, cum_pl - COALESCE(LAG(cum_pl) OVER (PARTITION BY account ORDER BY log_date), 0) as d_pnl FROM last_ep WHERE cum_pl IS NOT NULL),
      daily AS (SELECT log_date, SUM(d_pnl) as daily_pnl FROM daily_pa GROUP BY log_date ORDER BY log_date)
      SELECT daily_pnl FROM daily
    `, params);
    const dailyPnls = dailyRes.rows.map(r => parseFloat(r.daily_pnl));
    let sharpe = null, sortino = null, ulcer = null;
    if (dailyPnls.length > 1) {
      const dm = dailyPnls.reduce((a, b) => a + b, 0) / dailyPnls.length;
      const dv = dailyPnls.reduce((s, p) => s + (p - dm) ** 2, 0) / dailyPnls.length;
      const ds = Math.sqrt(dv);
      if (ds > 0) sharpe = (dm / ds) * Math.sqrt(252);
      const downside = dailyPnls.filter(p => p < 0);
      const dDown = downside.length ? Math.sqrt(downside.reduce((s, p) => s + p ** 2, 0) / dailyPnls.length) : 0;
      if (dDown > 0) sortino = (dm / dDown) * Math.sqrt(252);
      let peak2 = 0, cumD = 0;
      const ddPcts = dailyPnls.map(p => { cumD += p; if (cumD > peak2) peak2 = cumD; return peak2 > 0 ? ((cumD - peak2) / peak2 * 100) ** 2 : 0; });
      ulcer = Math.sqrt(ddPcts.reduce((a, b) => a + b, 0) / ddPcts.length);
    }

    const durs = trades.map(t => parseFloat(t.duration_secs)).filter(d => d > 0 && isFinite(d));
    const winDurs = trades.filter(t => parseFloat(t.pnl) > 0).map(t => parseFloat(t.duration_secs)).filter(d => d > 0 && isFinite(d));
    const lossDurs = trades.filter(t => parseFloat(t.pnl) < 0).map(t => parseFloat(t.duration_secs)).filter(d => d > 0 && isFinite(d));
    const avgDur = durs.length ? durs.reduce((a, b) => a + b, 0) / durs.length : null;
    const avgWinDur = winDurs.length ? winDurs.reduce((a, b) => a + b, 0) / winDurs.length : null;
    const avgLossDur = lossDurs.length ? lossDurs.reduce((a, b) => a + b, 0) / lossDurs.length : null;
    const minDur = durs.length ? Math.min(...durs) : null;
    const maxDur = durs.length ? Math.max(...durs) : null;

    const longs = trades.filter(t => t.direction === 'Long');
    const shorts = trades.filter(t => t.direction === 'Short');
    const longWins = longs.filter(t => parseFloat(t.pnl) > 0);
    const shortWins = shorts.filter(t => parseFloat(t.pnl) > 0);

    const sortedWins = [...wins].sort((a, b) => b - a);
    const top1share = grossProfit > 0 ? sortedWins[0] / grossProfit : null;
    const top5share = grossProfit > 0 ? sortedWins.slice(0, 5).reduce((a, b) => a + b, 0) / grossProfit : null;
    const top10share = grossProfit > 0 ? sortedWins.slice(0, 10).reduce((a, b) => a + b, 0) / grossProfit : null;

    const allDailyRes = await query(`
      WITH ep_fills AS (
        SELECT log_date, custom_fields->>'account' as account, exit_time,
          CASE WHEN custom_fields->'sierra_data'->>'Cumulative Profit/Loss (C)' ~ '^-?[0-9]+(\\.[0-9]+)?$'
          THEN (custom_fields->'sierra_data'->>'Cumulative Profit/Loss (C)')::numeric ELSE NULL END as cum_pl
        FROM trades WHERE ${where} AND custom_fields->'sierra_data'->>'Exit DateTime' LIKE '% EP'
      ),
      last_ep AS (SELECT DISTINCT ON (log_date, account) log_date, account, cum_pl FROM ep_fills ORDER BY log_date, account, exit_time DESC),
      daily_pa AS (SELECT log_date, cum_pl - COALESCE(LAG(cum_pl) OVER (PARTITION BY account ORDER BY log_date), 0) as d_pnl FROM last_ep WHERE cum_pl IS NOT NULL),
      daily AS (SELECT log_date, SUM(d_pnl) as daily_pnl FROM daily_pa GROUP BY log_date)
      SELECT log_date, daily_pnl FROM daily ORDER BY log_date
    `, params);
    const allDaily = allDailyRes.rows;
    const winDays = allDaily.filter(d => parseFloat(d.daily_pnl) > 0).length;
    const lossDays = allDaily.filter(d => parseFloat(d.daily_pnl) < 0).length;
    const avgWinDay = winDays ? allDaily.filter(d => parseFloat(d.daily_pnl) > 0).reduce((s, d) => s + parseFloat(d.daily_pnl), 0) / winDays : 0;
    const avgLossDay = lossDays ? allDaily.filter(d => parseFloat(d.daily_pnl) < 0).reduce((s, d) => s + parseFloat(d.daily_pnl), 0) / lossDays : 0;

    const weekMap = {}, monthMap = {};
    allDaily.forEach(d => {
      const date = new Date(d.date || d.log_date);
      const yr = date.getFullYear();
      const wk = `${yr}-W${String(Math.ceil(((date - new Date(yr,0,1))/86400000+1)/7)).padStart(2,'0')}`;
      const mo = d.log_date.slice(0, 7);
      if (!weekMap[wk]) weekMap[wk] = 0;
      if (!monthMap[mo]) monthMap[mo] = 0;
      weekMap[wk] += parseFloat(d.daily_pnl);
      monthMap[mo] += parseFloat(d.daily_pnl);
    });
    const weeks = Object.values(weekMap);
    const months = Object.values(monthMap);
    const pctProfWeeks = weeks.length ? weeks.filter(v => v > 0).length / weeks.length * 100 : null;
    const pctProfMonths = months.length ? months.filter(v => v > 0).length / months.length * 100 : null;

    res.json({
      sharpe: sharpe ? +sharpe.toFixed(3) : null,
      sortino: sortino ? +sortino.toFixed(3) : null,
      ulcer_index: ulcer ? +ulcer.toFixed(3) : null,
      calmar: calmar ? +calmar.toFixed(3) : null,
      omega: omega ? +omega.toFixed(3) : null,
      sqn: sqn ? +sqn.toFixed(3) : null,
      expectancy: +expectancy.toFixed(2),
      payoff_ratio: payoffRatio ? +payoffRatio.toFixed(3) : null,
      kelly: kelly ? +(kelly * 100).toFixed(1) : null,
      breakeven_wr: breakevenWR ? +(breakevenWR * 100).toFixed(1) : null,
      recovery_factor: recoveryFactor ? +recoveryFactor.toFixed(3) : null,
      max_runup: +maxRunup.toFixed(2),
      avg_duration_secs: avgDur ? +avgDur.toFixed(0) : null,
      avg_win_duration_secs: avgWinDur ? +avgWinDur.toFixed(0) : null,
      avg_loss_duration_secs: avgLossDur ? +avgLossDur.toFixed(0) : null,
      min_duration_secs: minDur,
      max_duration_secs: maxDur,
      long_count: longs.length, short_count: shorts.length,
      long_win_rate: longs.length ? +(longWins.length / longs.length * 100).toFixed(1) : null,
      short_win_rate: shorts.length ? +(shortWins.length / shorts.length * 100).toFixed(1) : null,
      long_pnl: +longs.reduce((s, t) => s + parseFloat(t.pnl), 0).toFixed(2),
      short_pnl: +shorts.reduce((s, t) => s + parseFloat(t.pnl), 0).toFixed(2),
      top1_profit_share: top1share ? +(top1share * 100).toFixed(1) : null,
      top5_profit_share: top5share ? +(top5share * 100).toFixed(1) : null,
      top10_profit_share: top10share ? +(top10share * 100).toFixed(1) : null,
      win_days: winDays, loss_days: lossDays,
      avg_win_day: +avgWinDay.toFixed(2), avg_loss_day: +avgLossDay.toFixed(2),
      pct_profitable_weeks: pctProfWeeks ? +pctProfWeeks.toFixed(1) : null,
      pct_profitable_months: pctProfMonths ? +pctProfMonths.toFixed(1) : null,
    });
  } catch (err) {
    console.error('tearsheet-overview error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Trade P&L distribution (histogram buckets)
router.get('/stats/pnl-distribution', async (req, res) => {
  try {
    const { where, params } = buildWhere(req.query);
    const result = await query(`SELECT pnl FROM trades WHERE ${where} AND pnl IS NOT NULL ORDER BY pnl`, params);
    const pnls = result.rows.map(r => parseFloat(r.pnl)).filter(v => isFinite(v));
    if (!pnls.length) return res.json({ buckets: [], mean: null, median: null });
    const min = Math.floor(Math.min(...pnls) / 50) * 50;
    const max = Math.ceil(Math.max(...pnls) / 50) * 50;
    const bucketSize = Math.max(50, Math.round((max - min) / 30 / 50) * 50);
    const buckets = {};
    for (let b = min; b <= max; b += bucketSize) buckets[b] = 0;
    pnls.forEach(p => {
      const b = Math.floor(p / bucketSize) * bucketSize;
      buckets[b] = (buckets[b] || 0) + 1;
    });
    const mean = pnls.reduce((a, b) => a + b, 0) / pnls.length;
    const median = pnls[Math.floor(pnls.length / 2)];
    res.json({ buckets: Object.entries(buckets).map(([k, v]) => ({ range: +k, count: v })), mean: +mean.toFixed(2), median: +median.toFixed(2) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POLICY: entry_time and exit_time are stored as ET wall-clock (normalized 2026-06-08).
// Do NOT apply AT TIME ZONE conversion — they are already ET. Double-shifting will corrupt
// time-bucketed displays (By Hour, By DOW, Timing Heatmap). Use EXTRACT directly.

// Timing heatmap: weekday × hour average P&L
router.get('/stats/timing-heatmap', async (req, res) => {
  try {
    const { where, params } = buildWhere(req.query);
    const result = await query(`
      SELECT
        EXTRACT(DOW FROM exit_time) as dow,
        EXTRACT(HOUR FROM exit_time) as hour,
        ROUND(AVG(pnl)::numeric, 2) as avg_pnl,
        COUNT(*) as trade_count,
        ROUND(SUM(pnl)::numeric, 2) as total_pnl
      FROM trades WHERE ${where}
      GROUP BY dow, hour ORDER BY dow, hour
    `, params);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Rolling 20-trade metrics
router.get('/stats/rolling', async (req, res) => {
  try {
    const { where, params } = buildWhere(req.query);
    const result = await query(`SELECT pnl, entry_time FROM trades WHERE ${where} ORDER BY entry_time ASC`, params);
    const trades = result.rows;
    const window = 20;
    const rolling = [];
    for (let i = window - 1; i < trades.length; i++) {
      const slice = trades.slice(i - window + 1, i + 1).map(t => parseFloat(t.pnl));
      const wins = slice.filter(p => p > 0);
      const losses = slice.filter(p => p < 0);
      const exp = slice.reduce((a, b) => a + b, 0) / window;
      const wr = wins.length / window * 100;
      const pf = losses.length ? wins.reduce((a, b) => a + b, 0) / Math.abs(losses.reduce((a, b) => a + b, 0)) : null;
      rolling.push({ index: i, date: trades[i].entry_time, expectancy: +exp.toFixed(2), win_rate: +wr.toFixed(1), profit_factor: pf ? +pf.toFixed(2) : null });
    }
    res.json(rolling);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Monthly return heatmap (year × month)
router.get('/stats/monthly-heatmap', async (req, res) => {
  try {
    const { where, params } = buildWhere(req.query);
    const result = await query(`
      WITH ep_fills AS (
        SELECT log_date, custom_fields->>'account' as account, exit_time,
          CASE WHEN custom_fields->'sierra_data'->>'Cumulative Profit/Loss (C)' ~ '^-?[0-9]+(\\.[0-9]+)?$'
          THEN (custom_fields->'sierra_data'->>'Cumulative Profit/Loss (C)')::numeric ELSE NULL END as cum_pl
        FROM trades WHERE ${where} AND custom_fields->'sierra_data'->>'Exit DateTime' LIKE '% EP'
      ),
      last_ep AS (SELECT DISTINCT ON (log_date, account) log_date, account, cum_pl FROM ep_fills ORDER BY log_date, account, exit_time DESC),
      daily_pa AS (SELECT log_date, cum_pl - COALESCE(LAG(cum_pl) OVER (PARTITION BY account ORDER BY log_date), 0) as d_pnl FROM last_ep WHERE cum_pl IS NOT NULL),
      daily AS (SELECT log_date, SUM(d_pnl) as daily_pnl FROM daily_pa GROUP BY log_date)
      SELECT
        EXTRACT(YEAR FROM log_date)::int as year,
        EXTRACT(MONTH FROM log_date)::int as month,
        ROUND(SUM(daily_pnl)::numeric, 2) as pnl,
        COUNT(*) as trading_days,
        SUM(CASE WHEN daily_pnl > 0 THEN 1 ELSE 0 END) as win_days
      FROM daily GROUP BY year, month ORDER BY year, month
    `, params);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// MFE/MAE and execution efficiency stats
router.get('/stats/excursion', async (req, res) => {
  try {
    const { where, params } = buildWhere(req.query);
    const result = await query(`
      SELECT
        pnl,
        NULLIF(REGEXP_REPLACE(custom_fields->>'max_open_profit', '[^0-9.\\-]','','g'), '')::numeric AS mfe,
        NULLIF(REGEXP_REPLACE(custom_fields->>'max_open_loss',   '[^0-9.\\-]','','g'), '')::numeric AS mae,
        NULLIF(REGEXP_REPLACE(REPLACE(custom_fields->>'entry_efficiency','%',''), '[^0-9.\\-]','','g'), '')::numeric AS entry_eff,
        NULLIF(REGEXP_REPLACE(REPLACE(custom_fields->>'exit_efficiency', '%',''), '[^0-9.\\-]','','g'), '')::numeric AS exit_eff,
        NULLIF(REGEXP_REPLACE(REPLACE(custom_fields->>'total_efficiency','%',''), '[^0-9.\\-]','','g'), '')::numeric AS total_eff
      FROM trades
      WHERE ${where}
        AND custom_fields->>'max_open_profit' IS NOT NULL
        AND custom_fields->>'max_open_profit' != ''
    `, params);

    const rows = result.rows.filter(r => r.mfe !== null);
    if (!rows.length) return res.json({ summary: {}, scatter: [] });

    const mfes = rows.map(r => parseFloat(r.mfe)).filter(v => isFinite(v));
    const maes = rows.map(r => parseFloat(r.mae)).filter(v => isFinite(v));
    const entryEffs = rows.map(r => parseFloat(r.entry_eff)).filter(v => isFinite(v) && v >= 0);
    const exitEffs  = rows.map(r => parseFloat(r.exit_eff)).filter(v => isFinite(v) && v >= 0);
    const totalEffs = rows.map(r => parseFloat(r.total_eff)).filter(v => isFinite(v) && v >= 0);

    const pct = (arr, p) => {
      const s = [...arr].sort((a, b) => a - b);
      return s[Math.floor(s.length * p / 100)] ?? null;
    };
    const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;

    // Winners only: losers have negative pnl/mfe ratios that drag the average into nonsense territory
    const captureRows = rows.filter(r => parseFloat(r.mfe) > 0 && parseFloat(r.pnl) > 0);
    const mfeCaptures = captureRows.map(r => parseFloat(r.pnl) / parseFloat(r.mfe) * 100);

    const step = Math.max(1, Math.floor(rows.length / 500));
    const scatter = rows.filter((_, i) => i % step === 0).map(r => ({
      mfe: parseFloat(r.mfe),
      mae: Math.abs(parseFloat(r.mae)),
      pnl: parseFloat(r.pnl),
    }));

    res.json({
      summary: {
        avg_mfe: avg(mfes) ? +avg(mfes).toFixed(2) : null,
        avg_mae: avg(maes) ? +avg(maes).toFixed(2) : null,
        avg_entry_eff: avg(entryEffs) ? +avg(entryEffs).toFixed(1) : null,
        avg_exit_eff:  avg(exitEffs)  ? +avg(exitEffs).toFixed(1)  : null,
        avg_total_eff: avg(totalEffs) ? +avg(totalEffs).toFixed(1) : null,
        avg_mfe_capture: avg(mfeCaptures) ? +avg(mfeCaptures).toFixed(1) : null,
        mfe_p50: pct(mfes, 50) ? +pct(mfes, 50).toFixed(2) : null,
        mfe_p75: pct(mfes, 75) ? +pct(mfes, 75).toFixed(2) : null,
        mfe_p90: pct(mfes, 90) ? +pct(mfes, 90).toFixed(2) : null,
        mae_p50: pct(maes, 50) ? +pct(maes, 50).toFixed(2) : null,
        mae_p75: pct(maes, 75) ? +pct(maes, 75).toFixed(2) : null,
        mae_p90: pct(maes, 90) ? +pct(maes, 90).toFixed(2) : null,
        n: rows.length,
      },
      scatter,
      entry_eff_dist: (() => {
        const buckets = Array.from({length: 11}, (_, i) => ({ range: i*10, count: 0 }));
        entryEffs.forEach(v => { const b = Math.min(10, Math.floor(v/10)); buckets[b].count++; });
        return buckets;
      })(),
      exit_eff_dist: (() => {
        const buckets = Array.from({length: 11}, (_, i) => ({ range: i*10, count: 0 }));
        exitEffs.forEach(v => { const b = Math.min(10, Math.floor(v/10)); buckets[b].count++; });
        return buckets;
      })(),
    });
  } catch (err) {
    console.error('excursion error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
