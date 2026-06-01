import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';
import { query } from '../db.js';
import { runACDBacktest, runACDBacktestFromDB, runParameterSearch } from '../services/acdBacktest.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// Multer for CSV backtest uploads
const csvDataDir = path.join(__dirname, '../data');
import fs from 'fs';
if (!fs.existsSync(csvDataDir)) fs.mkdirSync(csvDataDir, { recursive: true });
const csvUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, csvDataDir),
    filename: (req, file, cb) => cb(null, 'NQ_1min.csv'),
  }),
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/\.(csv|txt)$/i.test(file.originalname)) cb(null, true);
    else cb(new Error('CSV files only'));
  },
});

// ==================== EFFICIENCY ANALYSIS ====================
router.get('/backtest/efficiency', async (req, res) => {
  try {
    const { account, dateFrom, dateTo } = req.query;

    let conditions = [
      `custom_fields->'sierra_data'->>'Exit DateTime' LIKE '% EP'`,
      `custom_fields->'sierra_data'->>'Entry Efficiency' ~ '^-?[0-9]+(\\.[0-9]+)?%$'`,
      `custom_fields->'sierra_data'->>'Exit Efficiency'  ~ '^-?[0-9]+(\\.[0-9]+)?%$'`,
      `custom_fields->'sierra_data'->>'Total Efficiency'  ~ '^-?[0-9]+(\\.[0-9]+)?%$'`
    ];
    let params = [];
    let p = 1;

    if (dateFrom) { conditions.push(`log_date >= $${p++}`); params.push(dateFrom); }
    if (dateTo)   { conditions.push(`log_date <= $${p++}`); params.push(dateTo); }
    if (account) {
      conditions.push(`custom_fields->>'account' = ANY($${p++}::text[])`);
      params.push(account.split(',').filter(Boolean));
    }

    const parseEff = col => `REPLACE(custom_fields->'sierra_data'->>'${col}','%','')::numeric`;
    const parseFtf = `CASE WHEN custom_fields->'sierra_data'->>'FlatToFlat Profit/Loss (C)' ~ '^-?[0-9]+(\\.[0-9]+)?\\s*F$'
      THEN REPLACE(REPLACE(custom_fields->'sierra_data'->>'FlatToFlat Profit/Loss (C)','F',''),' ','')::numeric END`;

    const where = `WHERE ${conditions.join(' AND ')}`;

    const overallRes = await query(`
      SELECT
        COUNT(*) as total_sessions,
        ROUND(AVG(${parseEff('Entry Efficiency')})::numeric, 1) as avg_entry_eff,
        ROUND(AVG(${parseEff('Exit Efficiency')})::numeric,  1) as avg_exit_eff,
        ROUND(AVG(${parseEff('Total Efficiency')})::numeric,  1) as avg_total_eff,
        ROUND(AVG(CASE WHEN ${parseFtf} > 0 THEN ${parseEff('Entry Efficiency')} END)::numeric, 1) as win_entry_eff,
        ROUND(AVG(CASE WHEN ${parseFtf} > 0 THEN ${parseEff('Exit Efficiency')} END)::numeric,  1) as win_exit_eff,
        ROUND(AVG(CASE WHEN ${parseFtf} > 0 THEN ${parseEff('Total Efficiency')} END)::numeric,  1) as win_total_eff,
        ROUND(AVG(CASE WHEN ${parseFtf} < 0 THEN ${parseEff('Entry Efficiency')} END)::numeric, 1) as loss_entry_eff,
        ROUND(AVG(CASE WHEN ${parseFtf} < 0 THEN ${parseEff('Exit Efficiency')} END)::numeric,  1) as loss_exit_eff,
        ROUND(AVG(CASE WHEN ${parseFtf} < 0 THEN ${parseEff('Total Efficiency')} END)::numeric,  1) as loss_total_eff,
        COUNT(CASE WHEN ${parseFtf} > 0 THEN 1 END) as wins,
        COUNT(CASE WHEN ${parseFtf} < 0 THEN 1 END) as losses
      FROM trades ${where}
    `, params);

    const byDateRes = await query(`
      SELECT
        log_date::text,
        COUNT(*) as sessions,
        ROUND(AVG(${parseEff('Entry Efficiency')})::numeric, 1) as entry_eff,
        ROUND(AVG(${parseEff('Exit Efficiency')})::numeric,  1) as exit_eff,
        ROUND(AVG(${parseEff('Total Efficiency')})::numeric,  1) as total_eff,
        ROUND(AVG(${parseFtf})::numeric, 2) as avg_pnl
      FROM trades ${where}
      GROUP BY log_date ORDER BY log_date ASC
    `, params);

    const byDateAllRes = await query(`
      SELECT
        log_date::text,
        ROUND(AVG(${parseEff('Entry Efficiency')})::numeric, 1) as entry_eff,
        ROUND(AVG(${parseEff('Exit Efficiency')})::numeric,  1) as exit_eff,
        ROUND(AVG(${parseEff('Total Efficiency')})::numeric,  1) as total_eff
      FROM trades
      WHERE custom_fields->'sierra_data'->>'Exit DateTime' LIKE '% EP'
        AND custom_fields->'sierra_data'->>'Entry Efficiency' ~ '^-?[0-9]+(\\.[0-9]+)?%$'
        AND custom_fields->'sierra_data'->>'Exit Efficiency'  ~ '^-?[0-9]+(\\.[0-9]+)?%$'
        AND custom_fields->'sierra_data'->>'Total Efficiency'  ~ '^-?[0-9]+(\\.[0-9]+)?%$'
      GROUP BY log_date ORDER BY log_date ASC
    `, []);

    const byHourRes = await query(`
      SELECT
        EXTRACT(HOUR FROM entry_time AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::int as hour,
        COUNT(*) as sessions,
        ROUND(AVG(${parseEff('Entry Efficiency')})::numeric, 1) as entry_eff,
        ROUND(AVG(${parseEff('Exit Efficiency')})::numeric,  1) as exit_eff,
        ROUND(AVG(${parseEff('Total Efficiency')})::numeric,  1) as total_eff
      FROM trades ${where}
      GROUP BY hour ORDER BY hour ASC
    `, params);

    const bySessionRes = await query(`
      WITH ranked AS (
        SELECT
          ${parseEff('Entry Efficiency')} as entry_eff,
          ${parseEff('Exit Efficiency')}  as exit_eff,
          ${parseEff('Total Efficiency')}  as total_eff,
          ${parseFtf} as pnl,
          ROW_NUMBER() OVER (PARTITION BY log_date, custom_fields->>'account' ORDER BY exit_time ASC) as session_num
        FROM trades ${where}
      )
      SELECT
        CASE WHEN session_num >= 4 THEN 4 ELSE session_num END as session_num,
        CASE WHEN session_num >= 4 THEN '4+' ELSE '#' || session_num END as label,
        COUNT(*) as sessions,
        ROUND(AVG(entry_eff)::numeric, 1) as entry_eff,
        ROUND(AVG(exit_eff)::numeric,  1) as exit_eff,
        ROUND(AVG(total_eff)::numeric,  1) as total_eff,
        ROUND(AVG(pnl)::numeric, 2) as avg_pnl
      FROM ranked
      GROUP BY CASE WHEN session_num >= 4 THEN 4 ELSE session_num END,
               CASE WHEN session_num >= 4 THEN '4+' ELSE '#' || session_num END
      ORDER BY session_num ASC
    `, params);

    const scatterRes = await query(`
      SELECT
        ROUND(${parseEff('Total Efficiency')}::numeric, 1) as total_eff,
        ROUND(${parseFtf}::numeric, 2) as pnl,
        log_date::text as date
      FROM trades ${where}
        AND ${parseFtf} IS NOT NULL
      ORDER BY RANDOM() LIMIT 400
    `, params);

    const ftfOnlyConditions = conditions.filter(c =>
      !c.includes('Entry Efficiency') && !c.includes('Exit Efficiency') && !c.includes('Total Efficiency')
    );
    const pnlDistRes = await query(`
      WITH sessions AS (
        SELECT replace(replace(custom_fields->'sierra_data'->>'FlatToFlat Profit/Loss (C)','F',''),' ','')::numeric as ftf
        FROM trades
        WHERE ${ftfOnlyConditions.join(' AND ')}
          AND custom_fields->'sierra_data'->>'Exit DateTime' LIKE '% EP'
          AND custom_fields->'sierra_data'->>'FlatToFlat Profit/Loss (C)' ~ '^-?[0-9]+(\\.[0-9]+)? *F$'
      )
      SELECT
        COUNT(*) FILTER (WHERE ftf > 0) as win_count,
        COUNT(*) FILTER (WHERE ftf < 0) as loss_count,
        ROUND(AVG(ftf) FILTER (WHERE ftf > 0)::numeric, 2) as avg_win,
        ROUND(AVG(ftf) FILTER (WHERE ftf < 0)::numeric, 2) as avg_loss,
        ROUND(PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY ftf) FILTER (WHERE ftf > 0)::numeric, 2) as p25_win,
        ROUND(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY ftf) FILTER (WHERE ftf > 0)::numeric, 2) as p50_win,
        ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY ftf) FILTER (WHERE ftf > 0)::numeric, 2) as p75_win,
        ROUND(PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY ftf) FILTER (WHERE ftf > 0)::numeric, 2) as p90_win,
        ROUND(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY ftf) FILTER (WHERE ftf < 0)::numeric, 2) as p50_loss
      FROM sessions
    `, params);

    const timeSeriesRes = await query(`
      SELECT log_date::text as date,
        replace(replace(custom_fields->'sierra_data'->>'FlatToFlat Profit/Loss (C)','F',''),' ','')::numeric as ftf
      FROM trades
      WHERE custom_fields->'sierra_data'->>'Exit DateTime' LIKE '% EP'
        AND custom_fields->'sierra_data'->>'FlatToFlat Profit/Loss (C)' ~ '^-?[0-9]+(\\.[0-9]+)? *F$'
        ${account ? `AND custom_fields->>'account' = ANY($1::text[])` : ''}
      ORDER BY log_date ASC, exit_time ASC
    `, account ? [account.split(',').filter(Boolean)] : []);

    const last14Params = account ? [account.split(',').filter(Boolean)] : [];
    const last14Res = await query(`
      WITH sessions AS (
        SELECT replace(replace(custom_fields->'sierra_data'->>'FlatToFlat Profit/Loss (C)','F',''),' ','')::numeric as ftf
        FROM trades
        WHERE custom_fields->'sierra_data'->>'Exit DateTime' LIKE '% EP'
          AND custom_fields->'sierra_data'->>'FlatToFlat Profit/Loss (C)' ~ '^-?[0-9]+(\\.[0-9]+)? *F$'
          AND log_date >= CURRENT_DATE - 14
          ${account ? `AND custom_fields->>'account' = ANY($1::text[])` : ''}
      )
      SELECT
        COUNT(*) FILTER (WHERE ftf > 0) as win_count,
        COUNT(*) FILTER (WHERE ftf < 0) as loss_count,
        ROUND(AVG(ftf) FILTER (WHERE ftf > 0)::numeric, 2) as avg_win,
        ROUND(AVG(ftf) FILTER (WHERE ftf < 0)::numeric, 2) as avg_loss,
        ROUND(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY ftf) FILTER (WHERE ftf > 0)::numeric, 2) as p50_win,
        ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY ftf) FILTER (WHERE ftf > 0)::numeric, 2) as p75_win,
        ROUND(PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY ftf) FILTER (WHERE ftf > 0)::numeric, 2) as p90_win,
        ROUND(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY ftf) FILTER (WHERE ftf < 0)::numeric, 2) as p50_loss,
        ROUND(AVG(ftf) FILTER (WHERE ftf < 0)::numeric, 2) as avg_loss2
      FROM sessions
    `, last14Params);

    const o = overallRes.rows[0];
    const pd = pnlDistRes.rows[0];
    const l14 = last14Res.rows[0];
    res.json({
      overall: {
        totalSessions: parseInt(o.total_sessions),
        avgEntryEff:   parseFloat(o.avg_entry_eff),
        avgExitEff:    parseFloat(o.avg_exit_eff),
        avgTotalEff:   parseFloat(o.avg_total_eff),
        wins:          parseInt(o.wins),
        losses:        parseInt(o.losses),
        winBreakdown:  { entry: parseFloat(o.win_entry_eff),  exit: parseFloat(o.win_exit_eff),  total: parseFloat(o.win_total_eff)  },
        lossBreakdown: { entry: parseFloat(o.loss_entry_eff), exit: parseFloat(o.loss_exit_eff), total: parseFloat(o.loss_total_eff) }
      },
      byDate:        byDateRes.rows.map(r => ({ ...r, entry_eff: parseFloat(r.entry_eff), exit_eff: parseFloat(r.exit_eff), total_eff: parseFloat(r.total_eff), avg_pnl: parseFloat(r.avg_pnl) })),
      byDateAllTime: byDateAllRes.rows.map(r => ({ ...r, entry_eff: parseFloat(r.entry_eff), exit_eff: parseFloat(r.exit_eff), total_eff: parseFloat(r.total_eff) })),
      byHour:    byHourRes.rows.map(r => ({ ...r, hour: parseInt(r.hour), label: `${r.hour}:00`, entry_eff: parseFloat(r.entry_eff), exit_eff: parseFloat(r.exit_eff), total_eff: parseFloat(r.total_eff), sessions: parseInt(r.sessions) })),
      bySession: bySessionRes.rows.map(r => ({ ...r, session_num: parseInt(r.session_num), entry_eff: parseFloat(r.entry_eff), exit_eff: parseFloat(r.exit_eff), total_eff: parseFloat(r.total_eff), avg_pnl: parseFloat(r.avg_pnl), sessions: parseInt(r.sessions) })),
      scatter:   scatterRes.rows.map(r => ({ x: parseFloat(r.total_eff), y: parseFloat(r.pnl), date: r.date })),
      sessionPnlDist: pd ? {
        winCount:  parseInt(pd.win_count),
        lossCount: parseInt(pd.loss_count),
        avgWin:    parseFloat(pd.avg_win),
        avgLoss:   parseFloat(pd.avg_loss),
        p25Win:    parseFloat(pd.p25_win),
        p50Win:    parseFloat(pd.p50_win),
        p75Win:    parseFloat(pd.p75_win),
        p90Win:    parseFloat(pd.p90_win),
        p50Loss:   parseFloat(pd.p50_loss),
      } : null,
      pnlTimeSeries: timeSeriesRes.rows.map(r => ({
        date: r.date,
        ftf:  r.ftf != null ? parseFloat(r.ftf) : null,
      })).filter(r => r.ftf != null),
      last14DaysDist: l14 ? {
        winCount:  parseInt(l14.win_count),
        lossCount: parseInt(l14.loss_count),
        avgWin:    parseFloat(l14.avg_win),
        avgLoss:   parseFloat(l14.avg_loss2),
        p50Win:    parseFloat(l14.p50_win),
        p75Win:    parseFloat(l14.p75_win),
        p90Win:    parseFloat(l14.p90_win),
        p50Loss:   parseFloat(l14.p50_loss),
      } : null,
    });

  } catch (error) {
    console.error('Error fetching efficiency data:', error);
    res.status(500).json({ error: 'Failed to fetch efficiency data' });
  }
});

// ==================== BACKTESTING ====================
router.get('/backtest', async (req, res) => {
  try {
    const { account, dateFrom, dateTo, maxDailyLoss, maxDailyProfit, timeCutoff, maxSessions, consecutiveLossStop } = req.query;

    let conditions = [
      `(custom_fields->'sierra_data'->>'Entry DateTime' LIKE '% BP' OR custom_fields->'sierra_data'->>'Exit DateTime' LIKE '% EP')`
    ];
    let params = [];
    let p = 1;

    if (dateFrom) { conditions.push(`log_date >= $${p++}`); params.push(dateFrom); }
    if (dateTo)   { conditions.push(`log_date <= $${p++}`); params.push(dateTo); }
    if (account) {
      conditions.push(`custom_fields->>'account' = ANY($${p++}::text[])`);
      params.push(account.split(',').filter(Boolean));
    }

    const result = await query(`
      SELECT
        log_date::text,
        entry_time,
        exit_time,
        custom_fields->>'account' as account,
        custom_fields->'sierra_data'->>'Entry DateTime' as entry_dt,
        custom_fields->'sierra_data'->>'Exit DateTime' as exit_dt,
        custom_fields->'sierra_data'->>'FlatToFlat Profit/Loss (C)' as ftf_pl
      FROM trades
      WHERE ${conditions.join(' AND ')}
      ORDER BY log_date ASC, exit_time ASC, entry_time ASC
    `, params);

    const sessionMap = new Map();
    for (const fill of result.rows) {
      const exitISO = fill.exit_time instanceof Date ? fill.exit_time.toISOString() : fill.exit_time;
      const key = `${fill.log_date}|${fill.account}|${exitISO}`;
      if (!sessionMap.has(key)) {
        sessionMap.set(key, { date: fill.log_date, account: fill.account, sessionEnd: fill.exit_time, sessionStart: null, pnl: null });
      }
      const session = sessionMap.get(key);
      const entryDT = (fill.entry_dt || '').trim();
      const exitDT  = (fill.exit_dt  || '').trim();

      if (entryDT.endsWith('BP') && !session.sessionStart) {
        session.sessionStart = fill.entry_time;
      }
      if (exitDT.endsWith('EP')) {
        const ftfStr = (fill.ftf_pl || '').trim();
        if (ftfStr.toUpperCase().endsWith('F')) {
          session.pnl = parseFloat(ftfStr.replace(/\s*F$/i, '')) || 0;
        }
      }
    }

    const sessions = Array.from(sessionMap.values()).filter(s => s.pnl !== null);

    const byDate = {};
    for (const s of sessions) {
      if (!byDate[s.date]) byDate[s.date] = [];
      byDate[s.date].push(s);
    }
    for (const date of Object.keys(byDate)) {
      byDate[date].sort((a, b) => new Date(a.sessionStart || a.sessionEnd) - new Date(b.sessionStart || b.sessionEnd));
    }

    const getETMinutes = (ts) => {
      if (!ts) return null;
      const d = new Date(ts);
      const parts = d.toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).split(':');
      return parseInt(parts[0]) * 60 + parseInt(parts[1]);
    };
    const getETHour = (ts) => {
      if (!ts) return null;
      return parseInt(new Date(ts).toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }));
    };

    const ruleMaxLoss   = maxDailyLoss       ? Math.abs(parseFloat(maxDailyLoss))   : null;
    const ruleMaxProfit = maxDailyProfit      ? Math.abs(parseFloat(maxDailyProfit)) : null;
    const ruleCutoff    = timeCutoff ? (() => { const [h, m] = timeCutoff.split(':').map(Number); return h * 60 + (m || 0); })() : null;
    const ruleMaxSess   = maxSessions         ? parseInt(maxSessions)                : null;
    const ruleConsLoss  = consecutiveLossStop ? parseInt(consecutiveLossStop)        : null;
    const hasRules = [ruleMaxLoss, ruleMaxProfit, ruleCutoff, ruleMaxSess, ruleConsLoss].some(r => r !== null);

    const sortedDates = Object.keys(byDate).sort();
    const daily = [];

    for (const date of sortedDates) {
      const daySessions = byDate[date];
      const actualPnl = daySessions.reduce((s, x) => s + x.pnl, 0);
      let simPnl = 0, ruleFired = false, ruleType = null, sessionsTaken = 0, consecutiveLosses = 0;

      for (const session of daySessions) {
        if (ruleCutoff !== null) {
          const mins = getETMinutes(session.sessionStart || session.sessionEnd);
          if (mins !== null && mins >= ruleCutoff) { ruleFired = true; ruleType = 'timeCutoff'; break; }
        }
        if (ruleMaxSess !== null && sessionsTaken >= ruleMaxSess)       { ruleFired = true; ruleType = 'maxSessions';    break; }
        if (ruleMaxLoss !== null && simPnl <= -ruleMaxLoss)             { ruleFired = true; ruleType = 'maxDailyLoss';   break; }
        if (ruleMaxProfit !== null && simPnl >= ruleMaxProfit)          { ruleFired = true; ruleType = 'maxDailyProfit'; break; }
        if (ruleConsLoss !== null && consecutiveLosses >= ruleConsLoss) { ruleFired = true; ruleType = 'consecutiveLoss'; break; }

        simPnl += session.pnl;
        sessionsTaken++;
        consecutiveLosses = session.pnl < 0 ? consecutiveLosses + 1 : 0;
      }

      daily.push({
        date,
        actualPnl:    Math.round(actualPnl * 100) / 100,
        simulatedPnl: hasRules ? Math.round(simPnl * 100) / 100 : Math.round(actualPnl * 100) / 100,
        ruleFired,
        ruleType,
        sessionsActual: daySessions.length,
        sessionsTaken:  hasRules ? sessionsTaken : daySessions.length
      });
    }

    let cumActual = 0, cumSim = 0;
    for (const d of daily) {
      cumActual += d.actualPnl; cumSim += d.simulatedPnl;
      d.cumActual    = Math.round(cumActual * 100) / 100;
      d.cumSimulated = Math.round(cumSim * 100) / 100;
    }

    const totalActual = daily.reduce((s, d) => s + d.actualPnl, 0);
    const totalSim    = daily.reduce((s, d) => s + d.simulatedPnl, 0);

    const snStats = {};
    for (const date of sortedDates) {
      byDate[date].forEach((s, idx) => {
        const num = idx < 3 ? idx + 1 : 4;
        if (!snStats[num]) snStats[num] = { count: 0, wins: 0, pnl: 0 };
        snStats[num].count++;  snStats[num].pnl += s.pnl;
        if (s.pnl > 0) snStats[num].wins++;
      });
    }
    const sessionNumbers = Object.entries(snStats).map(([num, s]) => ({
      label: num === '4' ? '4+' : `#${num}`,
      sessionNum: parseInt(num),
      avgPnl:  Math.round((s.pnl / s.count) * 100) / 100,
      winRate: Math.round((s.wins / s.count) * 100),
      count:   s.count,
      totalPnl: Math.round(s.pnl * 100) / 100
    })).sort((a, b) => a.sessionNum - b.sessionNum);

    const hourStats = {};
    for (const s of sessions) {
      const hour = getETHour(s.sessionStart || s.sessionEnd);
      if (hour === null) continue;
      if (!hourStats[hour]) hourStats[hour] = { count: 0, wins: 0, pnl: 0 };
      hourStats[hour].count++;  hourStats[hour].pnl += s.pnl;
      if (s.pnl > 0) hourStats[hour].wins++;
    }
    const hourlyPerformance = Object.entries(hourStats).map(([h, s]) => ({
      hour: parseInt(h), label: `${h}:00`,
      avgPnl:  Math.round((s.pnl / s.count) * 100) / 100,
      winRate: Math.round((s.wins / s.count) * 100),
      count:   s.count,
      totalPnl: Math.round(s.pnl * 100) / 100
    })).sort((a, b) => a.hour - b.hour);

    let afterLoss = { count: 0, wins: 0, pnl: 0 };
    let afterWin  = { count: 0, wins: 0, pnl: 0 };
    for (const date of sortedDates) {
      const ds = byDate[date];
      for (let i = 1; i < ds.length; i++) {
        const tgt = ds[i - 1].pnl < 0 ? afterLoss : afterWin;
        tgt.count++;  tgt.pnl += ds[i].pnl;
        if (ds[i].pnl > 0) tgt.wins++;
      }
    }

    const dowStats = {};
    const dowNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    for (const date of sortedDates) {
      const dow = new Date(date + 'T12:00:00Z').getDay();
      const dayPnl = byDate[date].reduce((s, x) => s + x.pnl, 0);
      if (!dowStats[dow]) dowStats[dow] = { days: 0, wins: 0, pnl: 0 };
      dowStats[dow].days++;  dowStats[dow].pnl += dayPnl;
      if (dayPnl > 0) dowStats[dow].wins++;
    }
    const dayOfWeek = Object.entries(dowStats).map(([dow, s]) => ({
      dow: parseInt(dow), label: dowNames[parseInt(dow)],
      avgPnl:  Math.round((s.pnl / s.days) * 100) / 100,
      winRate: Math.round((s.wins / s.days) * 100),
      days: s.days,
      totalPnl: Math.round(s.pnl * 100) / 100
    })).sort((a, b) => a.dow - b.dow);

    res.json({
      summary: {
        actualPnl:    Math.round(totalActual * 100) / 100,
        simulatedPnl: Math.round(totalSim * 100) / 100,
        improvement:  Math.round((totalSim - totalActual) * 100) / 100,
        daysTraded:   daily.length,
        daysRuleFired: daily.filter(d => d.ruleFired).length,
        daysImproved:  daily.filter(d => d.simulatedPnl > d.actualPnl).length,
        daysHurt:      daily.filter(d => d.simulatedPnl < d.actualPnl).length,
        hasRules
      },
      daily,
      patterns: {
        sessionNumbers,
        hourlyPerformance,
        dayOfWeek,
        afterLoss: {
          count: afterLoss.count,
          winRate: afterLoss.count > 0 ? Math.round((afterLoss.wins / afterLoss.count) * 100) : 0,
          avgPnl:  afterLoss.count > 0 ? Math.round((afterLoss.pnl  / afterLoss.count) * 100) / 100 : 0
        },
        afterWin: {
          count: afterWin.count,
          winRate: afterWin.count > 0 ? Math.round((afterWin.wins / afterWin.count) * 100) : 0,
          avgPnl:  afterWin.count > 0 ? Math.round((afterWin.pnl  / afterWin.count) * 100) / 100 : 0
        }
      }
    });

  } catch (error) {
    console.error('Error running backtest:', error);
    res.status(500).json({ error: 'Failed to run backtest' });
  }
});

// GET /api/backtest/conditions — (line ~7535 in original)
router.get('/backtest/conditions', async (req, res) => {
  try {
    const tradingDays = parseInt(req.query.days) || 90;
    const rows = await query(`
      SELECT date::text, prior_vah::float, prior_val::float, prior_poc::float,
             session_open::float, session_close::float, session_high::float, session_low::float,
             a_up_fired, a_down_fired, pts_vs_open::float, nl30::int, bias_dir, prior_profile,
             or_high::float, or_low::float
      FROM auction_history
      WHERE session_open IS NOT NULL AND session_close IS NOT NULL
        AND prior_vah IS NOT NULL AND prior_val IS NOT NULL
      ORDER BY date DESC
      LIMIT $1
    `, [tradingDays + 10]);
    rows.rows.reverse();

    const data = rows.rows;
    if (data.length < 6) return res.json({ available: false, reason: 'Insufficient history' });

    function overlapCheck(days5) {
      let count = 0;
      for (let i = 1; i < days5.length; i++) {
        const prev = days5[i-1], curr = days5[i];
        if (!prev.prior_vah || !curr.prior_vah) continue;
        const lo = Math.max(prev.prior_val, curr.prior_val);
        const hi = Math.min(prev.prior_vah, curr.prior_vah);
        if (hi > lo) count++;
      }
      return count;
    }
    function migrationDir(days5) {
      if (days5.length < 3) return 'OVERLAPPING';
      let up = 0, down = 0;
      for (let i = 1; i < days5.length; i++) {
        if (days5[i].prior_poc > days5[i-1].prior_poc) up++;
        else if (days5[i].prior_poc < days5[i-1].prior_poc) down++;
      }
      const t = days5.length - 1;
      if (up / t >= 0.65) return 'HIGHER';
      if (down / t >= 0.65) return 'LOWER';
      return 'OVERLAPPING';
    }

    const results = [];
    for (let i = 5; i < data.length; i++) {
      const d     = data[i];
      const prior = data.slice(Math.max(0, i-5), i);
      const overlaps = overlapCheck(prior);
      const dir5     = migrationDir(prior);
      const nlState  = d.nl30 > 9 ? 'BULLISH' : d.nl30 < -9 ? 'BEARISH' : 'RANGING';

      let structure;
      if (overlaps >= 4)      structure = 'BRACKET';
      else if (overlaps >= 3) structure = dir5 === 'HIGHER' ? 'BRACKET_TILTING_UP' : dir5 === 'LOWER' ? 'BRACKET_TILTING_DOWN' : 'BRACKET';
      else if (dir5 === 'HIGHER') structure = 'TRENDING_UP';
      else if (dir5 === 'LOWER')  structure = 'TRENDING_DOWN';
      else                        structure = 'TRANSITIONAL';

      const vah = d.prior_vah, val = d.prior_val, poc = d.prior_poc;
      const open = d.session_open, close = d.session_close;
      const high = d.session_high, low = d.session_low;
      const orRange = (d.or_high && d.or_low) ? d.or_high - d.or_low : 80;
      const nearThresh = orRange * 0.5;

      const trades = [];

      if (structure.startsWith('BRACKET')) {
        if (open >= vah - nearThresh) {
          const target = poc;
          const success = close < vah;
          const ptsGained = vah - close;
          const hitTarget = low <= target;
          trades.push({ type: 'FADE_VAH', structure, success, ptsGained: Math.round(ptsGained), hitTarget, nl: nlState, date: d.date });
        }
        if (open <= val + nearThresh) {
          const target = poc;
          const success = close > val;
          const ptsGained = close - val;
          const hitTarget = high >= target;
          trades.push({ type: 'FADE_VAL', structure, success, ptsGained: Math.round(ptsGained), hitTarget, nl: nlState, date: d.date });
        }
      }

      if (structure === 'TRENDING_UP' && d.a_up_fired) {
        const success = (d.pts_vs_open || 0) > 0;
        trades.push({ type: 'TREND_A_UP', structure, success, ptsGained: Math.round(d.pts_vs_open || 0), nl: nlState, date: d.date });
      }
      if (structure === 'TRENDING_DOWN' && d.a_down_fired) {
        const success = (d.pts_vs_open || 0) < 0;
        trades.push({ type: 'TREND_A_DOWN', structure, success, ptsGained: Math.round(-(d.pts_vs_open || 0)), nl: nlState, date: d.date });
      }

      if (d.a_up_fired) {
        const success = (d.pts_vs_open || 0) > 0;
        trades.push({ type: 'A_UP_BY_NL', structure, success, ptsGained: Math.round(d.pts_vs_open || 0), nl: nlState, date: d.date, nlNum: d.nl30 });
      }
      if (d.a_down_fired) {
        const success = (d.pts_vs_open || 0) < 0;
        trades.push({ type: 'A_DOWN_BY_NL', structure, success, ptsGained: Math.round(-(d.pts_vs_open || 0)), nl: nlState, date: d.date, nlNum: d.nl30 });
      }

      results.push(...trades);
    }

    function agg(trades) {
      const n = trades.length;
      if (!n) return null;
      const wins = trades.filter(t => t.success).length;
      const pts  = trades.reduce((s, t) => s + t.ptsGained, 0);
      return {
        n,
        winRate: Math.round(wins / n * 100),
        avgPts: Math.round(pts / n),
        totalPts: pts,
        wins,
        sample: trades.slice(-5).map(t => ({ date: t.date, success: t.success, pts: t.ptsGained })),
      };
    }

    const fadeVAH        = agg(results.filter(t => t.type === 'FADE_VAH'));
    const fadeVAHBracket = agg(results.filter(t => t.type === 'FADE_VAH' && t.structure === 'BRACKET'));
    const fadeVAHTilting = agg(results.filter(t => t.type === 'FADE_VAH' && t.structure.includes('TILTING')));
    const fadeVAL        = agg(results.filter(t => t.type === 'FADE_VAL'));
    const fadeVALBracket = agg(results.filter(t => t.type === 'FADE_VAL' && t.structure === 'BRACKET'));
    const fadeVALTilting = agg(results.filter(t => t.type === 'FADE_VAL' && t.structure.includes('TILTING')));

    const aUpBullish  = agg(results.filter(t => t.type === 'A_UP_BY_NL'  && t.nl === 'BULLISH'));
    const aUpRanging  = agg(results.filter(t => t.type === 'A_UP_BY_NL'  && t.nl === 'RANGING'));
    const aUpBearish  = agg(results.filter(t => t.type === 'A_UP_BY_NL'  && t.nl === 'BEARISH'));
    const aDownBearish= agg(results.filter(t => t.type === 'A_DOWN_BY_NL'&& t.nl === 'BEARISH'));
    const aDownRanging= agg(results.filter(t => t.type === 'A_DOWN_BY_NL'&& t.nl === 'RANGING'));
    const aDownBullish= agg(results.filter(t => t.type === 'A_DOWN_BY_NL'&& t.nl === 'BULLISH'));

    const trendUp   = agg(results.filter(t => t.type === 'TREND_A_UP'));
    const trendDown = agg(results.filter(t => t.type === 'TREND_A_DOWN'));

    const byStructure = {};
    for (const s of ['BRACKET','BRACKET_TILTING_UP','BRACKET_TILTING_DOWN','TRENDING_UP','TRENDING_DOWN','TRANSITIONAL']) {
      const days = [...new Set(results.filter(t => t.structure === s).map(t => t.date))];
      byStructure[s] = { days: days.length };
    }

    const dailyLog = [];
    for (let i = 5; i < data.length; i++) {
      const d     = data[i];
      const prior = data.slice(Math.max(0, i-5), i);
      const overlaps = overlapCheck(prior);
      const dir5     = migrationDir(prior);
      const nlState  = d.nl30 > 9 ? 'BULLISH' : d.nl30 < -9 ? 'BEARISH' : 'RANGING';

      let structure;
      if (overlaps >= 4)      structure = dir5 === 'HIGHER' ? 'BRACKET_TILTING_UP' : dir5 === 'LOWER' ? 'BRACKET_TILTING_DOWN' : 'BRACKET';
      else if (overlaps >= 3) structure = dir5 === 'HIGHER' ? 'BRACKET_TILTING_UP' : dir5 === 'LOWER' ? 'BRACKET_TILTING_DOWN' : 'BRACKET';
      else if (dir5 === 'HIGHER') structure = 'TRENDING_UP';
      else if (dir5 === 'LOWER')  structure = 'TRENDING_DOWN';
      else                        structure = 'TRANSITIONAL';

      const vah = d.prior_vah, val = d.prior_val, poc = d.prior_poc;
      const open = d.session_open, close = d.session_close;
      const pts = d.pts_vs_open || 0;
      const aUp = d.a_up_fired, aDown = d.a_down_fired;

      let suggestedEdge, edgeResult, edgeWorked;

      if (structure === 'BRACKET' || structure === 'BRACKET_TILTING_UP' || structure === 'BRACKET_TILTING_DOWN') {
        const tiltUp   = structure === 'BRACKET_TILTING_UP';
        const tiltDown = structure === 'BRACKET_TILTING_DOWN';
        if (tiltUp) {
          suggestedEdge = 'CAUTION: Do not fade VAH. Buy near VAL only. Wait for confirmed VAH break.';
          edgeResult = open <= val + 50 ? (close > val ? `+${Math.round(close-val)}pts` : `${Math.round(close-val)}pts`) : 'No edge setup (opened inside value)';
          edgeWorked = open <= val + 50 ? close > val : null;
        } else if (tiltDown) {
          suggestedEdge = 'CAUTION: Do not fade VAL. Sell near VAH only. Wait for confirmed VAL break.';
          edgeResult = open >= vah - 50 ? (close < vah ? `+${Math.round(vah-close)}pts` : `${Math.round(vah-close)}pts`) : 'No edge setup';
          edgeWorked = open >= vah - 50 ? close < vah : null;
        } else {
          suggestedEdge = 'Fade VAH short → POC, or fade VAL long → POC';
          if (open >= vah - 50) {
            edgeResult = close < vah ? `Fade VAH worked +${Math.round(vah-close)}pts` : `Fade VAH failed ${Math.round(vah-close)}pts`;
            edgeWorked = close < vah;
          } else if (open <= val + 50) {
            edgeResult = close > val ? `Fade VAL worked +${Math.round(close-val)}pts` : `Fade VAL failed ${Math.round(close-val)}pts`;
            edgeWorked = close > val;
          } else {
            edgeResult = 'Opened inside value — no edge at extremes';
            edgeWorked = null;
          }
        }
      } else if (structure === 'TRENDING_UP') {
        suggestedEdge = nlState === 'BULLISH' ? 'Follow A Up signal, trail to prior VAH (NL30 aligned ✓)' : 'Follow A Up if fires — reduced conviction (NL30 ranging)';
        if (aUp) {
          edgeResult = pts > 0 ? `A Up followed, closed +${Math.round(pts)}pts` : `A Up followed, closed ${Math.round(pts)}pts`;
          edgeWorked = pts > 0;
        } else {
          edgeResult = 'No A Up fired — no initiative entry signal';
          edgeWorked = null;
        }
      } else if (structure === 'TRENDING_DOWN') {
        suggestedEdge = nlState === 'BEARISH' ? 'Follow A Down signal, trail to prior VAL (NL30 aligned ✓)' : 'Follow A Down if fires — reduced conviction';
        if (aDown) {
          edgeResult = pts < 0 ? `A Down followed, closed ${Math.round(pts)}pts` : `A Down followed, closed +${Math.round(pts)}pts (failed)`;
          edgeWorked = pts < 0;
        } else {
          edgeResult = 'No A Down fired — no initiative entry signal';
          edgeWorked = null;
        }
      } else {
        suggestedEdge = 'Reduce size 50%+. Wait for first confirmed VA migration day before entering.';
        edgeResult = `Session moved ${pts > 0 ? '+' : ''}${Math.round(pts)}pts — ${Math.abs(pts) < 30 ? 'rotational' : pts > 0 ? 'bullish breakout attempt' : 'bearish breakdown attempt'}`;
        edgeWorked = null;
      }

      const actualChar = aUp && pts > 0 ? 'A Up + closed up ✓' :
                         aDown && pts < 0 ? 'A Down + closed down ✓' :
                         aUp && pts < 0 ? 'A Up but closed down ✗' :
                         aDown && pts > 0 ? 'A Down but closed up ✗' :
                         pts > 30 ? 'No signal, closed up' :
                         pts < -30 ? 'No signal, closed down' : 'Rotational/neutral';

      dailyLog.push({
        date: d.date,
        structure,
        nlState,
        nl30: d.nl30,
        dir5,
        overlaps,
        priorVAH: Math.round(vah || 0),
        priorVAL: Math.round(val || 0),
        priorPOC: Math.round(poc || 0),
        sessionOpen: Math.round(open),
        sessionClose: Math.round(close),
        ptsVsOpen: Math.round(pts),
        aUpFired: !!aUp,
        aDownFired: !!aDown,
        suggestedEdge,
        edgeResult,
        edgeWorked,
        actualChar,
      });
    }

    res.json({
      available: true, totalDays: data.length - 5, days: tradingDays,
      fades: { vah: fadeVAH, vahBracket: fadeVAHBracket, vahTilting: fadeVAHTilting, val: fadeVAL, valBracket: fadeVALBracket, valTilting: fadeVALTilting },
      aSignals: { aUpBullish, aUpRanging, aUpBearish, aDownBearish, aDownRanging, aDownBullish },
      trends: { up: trendUp, down: trendDown },
      byStructure, rawCount: results.length,
      dailyLog: dailyLog.reverse(),
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

export default router;
