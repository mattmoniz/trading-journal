import express from 'express';
import { query } from '../db.js';

const router = express.Router();

// ==================== TRADING BEHAVIOR / INTRADAY PATTERNS ====================
router.get('/stats/behavior', async (req, res) => {
  try {
    const { account, dateFrom, dateTo } = req.query;
    let conditions = [
      `custom_fields->'sierra_data'->>'Exit DateTime' LIKE '% EP'`,
      `custom_fields->'sierra_data'->>'FlatToFlat Profit/Loss (C)' ~ '^-?[0-9]+(\\.[0-9]+)? *F$'`
    ];
    let params = []; let p = 1;
    if (dateFrom) { conditions.push(`log_date >= $${p++}`); params.push(dateFrom); }
    else           { conditions.push(`log_date >= CURRENT_DATE - INTERVAL '90 days'`); }
    if (dateTo)  { conditions.push(`log_date <= $${p++}`); params.push(dateTo); }
    if (account) { conditions.push(`custom_fields->>'account' = ANY($${p++}::text[])`); params.push(account.split(',').filter(Boolean)); }
    const where = `WHERE ${conditions.join(' AND ')}`;
    const parsePnl = `replace(replace(custom_fields->'sierra_data'->>'FlatToFlat Profit/Loss (C)','F',''),' ','')::numeric`;

    // Aggregate all accounts per exit_time slot to get combined session P&L
    const raw = await query(`
      SELECT log_date::text, exit_time, SUM(${parsePnl}) as pnl
      FROM trades ${where}
      GROUP BY log_date, exit_time ORDER BY log_date, exit_time
    `, params);

    const byDate = {};
    for (const r of raw.rows) {
      if (!byDate[r.log_date]) byDate[r.log_date] = [];
      byDate[r.log_date].push(parseFloat(r.pnl));
    }

    const days = [];
    for (const [date, sessions] of Object.entries(byDate).sort()) {
      let running = 0, low = 0, high = 0;
      sessions.forEach(pnl => { running += pnl; if (running < low) low = running; if (running > high) high = running; });
      const s1 = sessions[0] ?? 0;
      const s2 = sessions[1] ?? null;
      const s3 = sessions[2] ?? null;
      const finalPnl = running;
      let pattern;
      if      (low < -200 && finalPnl > 0)               pattern = 'comeback';
      else if (low < -200 && finalPnl > low*0.5)         pattern = 'partial';
      else if (high > 300 && finalPnl < high*0.5)        pattern = 'gaveBack';
      else if (low < -200)                                pattern = 'straightDown';
      else if (finalPnl > 0 && low > -100)               pattern = 'cleanGreen';
      else                                                pattern = 'mixed';
      days.push({ date, sessions: sessions.length, s1, s2, s3, finalPnl, low, high, pattern });
    }

    const patternLabels = { comeback:'Hole → Comeback', partial:'Hole → Partial', gaveBack:'Gave Back Gains', straightDown:'Straight Down', cleanGreen:'Clean Green', mixed:'Mixed' };
    const ps = {};
    for (const d of days) {
      if (!ps[d.pattern]) ps[d.pattern] = { count:0, pnl:0, low:0, high:0, sess:0 };
      ps[d.pattern].count++; ps[d.pattern].pnl += d.finalPnl; ps[d.pattern].low += d.low; ps[d.pattern].high += d.high; ps[d.pattern].sess += d.sessions;
    }
    const patterns = Object.entries(ps).map(([k, s]) => ({
      key: k, label: patternLabels[k], count: s.count,
      avgPnl: Math.round(s.pnl/s.count), avgLow: Math.round(s.low/s.count),
      avgHigh: Math.round(s.high/s.count), avgSessions: Math.round(s.sess/s.count*10)/10
    })).sort((a,b) => b.avgPnl - a.avgPnl);

    const avgArr = arr => arr.length ? Math.round(arr.reduce((s,v)=>s+v,0)/arr.length) : 0;
    const fw = days.filter(d=>d.s1>0), fl = days.filter(d=>d.s1<0);
    const firstSessionStats = {
      winDays: fw.length, lossDays: fl.length,
      winAvgS1: avgArr(fw.map(d=>d.s1)), lossAvgS1: avgArr(fl.map(d=>d.s1)),
      winAvgFinal: avgArr(fw.map(d=>d.finalPnl)), lossAvgFinal: avgArr(fl.map(d=>d.finalPnl)),
      winStayedGreen: fw.filter(d=>d.finalPnl>0).length,
      lossRecoveredGreen: fl.filter(d=>d.finalPnl>0).length,
      winAvgS2: avgArr(fw.filter(d=>d.s2!==null).map(d=>d.s2||0)),
      lossAvgS2: avgArr(fl.filter(d=>d.s2!==null).map(d=>d.s2||0)),
      winAvgS3: avgArr(fw.filter(d=>d.s3!==null).map(d=>d.s3||0)),
      lossAvgS3: avgArr(fl.filter(d=>d.s3!==null).map(d=>d.s3||0))
    };

    const reentryRaw = await query(`
      WITH ep AS (
        SELECT log_date, exit_time, MIN(entry_time) as entry_time, SUM(${parsePnl}) as pnl
        FROM trades ${where} GROUP BY log_date, exit_time
      ),
      gapped AS (
        SELECT pnl,
          LAG(pnl) OVER (PARTITION BY log_date ORDER BY exit_time) as prev_pnl,
          EXTRACT(EPOCH FROM (entry_time - LAG(exit_time) OVER (PARTITION BY log_date ORDER BY exit_time))) as gap_sec
        FROM ep
      )
      SELECT
        CASE
          WHEN prev_pnl<0 AND gap_sec<60   THEN 'loss_under1'
          WHEN prev_pnl<0 AND gap_sec<300  THEN 'loss_1to5'
          WHEN prev_pnl<0 AND gap_sec>=300 THEN 'loss_over5'
          WHEN prev_pnl>0 AND gap_sec<60   THEN 'win_under1'
          WHEN prev_pnl>0 AND gap_sec>=60  THEN 'win_over1'
        END as bucket,
        COUNT(*) as cnt,
        ROUND(AVG(pnl)::numeric,2) as avg_pnl,
        ROUND(AVG(CASE WHEN pnl>0 THEN 1.0 ELSE 0.0 END)*100,1) as win_pct
      FROM gapped WHERE prev_pnl IS NOT NULL AND gap_sec >= 0
      GROUP BY bucket
    `, params);
    const reentry = {};
    for (const r of reentryRaw.rows) if (r.bucket) reentry[r.bucket] = { count: parseInt(r.cnt), avgPnl: parseFloat(r.avg_pnl), winPct: parseFloat(r.win_pct) };

    const scb = {};
    for (const d of days) {
      const k = d.sessions<=1?'1':d.sessions<=2?'2':d.sessions<=3?'3':d.sessions<=5?'4-5':d.sessions<=8?'6-8':'9+';
      if (!scb[k]) scb[k]={count:0,pnl:0,wins:0};
      scb[k].count++; scb[k].pnl+=d.finalPnl; if(d.finalPnl>0) scb[k].wins++;
    }
    const sessionCounts = ['1','2','3','4-5','6-8','9+'].filter(k=>scb[k]).map(k=>({
      label: k==='1'?'1 session':`${k} sessions`, bucket:k,
      days: scb[k].count, avgPnl: Math.round(scb[k].pnl/scb[k].count),
      winPct: Math.round(scb[k].wins/scb[k].count*100)
    }));

    res.json({
      patterns, firstSessionStats, reentry, sessionCounts,
      totalDays: days.length,
      days: days.map(d=>({ date:d.date, finalPnl:Math.round(d.finalPnl), low:Math.round(d.low), high:Math.round(d.high), sessions:d.sessions, pattern:d.pattern, s1:Math.round(d.s1) }))
    });
  } catch(err) {
    console.error('Behavior stats error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
