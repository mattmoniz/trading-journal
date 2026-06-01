import express from 'express';
import { query } from '../db.js';
import { cacheGet, cacheSet, cacheDelete, latestBarDate } from '../lib/cache.js';

const router = express.Router();

// GET /api/longterm/summary
router.get('/longterm/summary', async (req, res) => {
  try {
    const lbd = await latestBarDate();
    const cached = cacheGet(`longterm-summary-${lbd}`);
    if (cached) return res.json(cached);

    const tradingDays = await query(`
      SELECT DISTINCT ts::date::text as date
      FROM price_bars WHERE symbol='NQ' AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
      ORDER BY date DESC LIMIT 30
    `);

    const vaRows = [];
    for (const { date } of tradingDays.rows) {
      try {
        const r = await query(`
          WITH vp AS (
            SELECT ROUND(low/0.25)*0.25 as px, SUM(volume) as vol
            FROM price_bars WHERE symbol='NQ' AND ts::date=$1 AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
            GROUP BY ROUND(low/0.25)*0.25
          ), total AS (SELECT SUM(vol) as t FROM vp),
          poc_row AS (SELECT px as poc_px FROM vp ORDER BY vol DESC LIMIT 1)
          SELECT p.poc_px::float as poc,
            (SELECT MAX(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px DESC) cv FROM vp WHERE px>=p.poc_px) s WHERE cv<=(SELECT t*0.35 FROM total))::float as vah,
            (SELECT MIN(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px ASC)  cv FROM vp WHERE px<=p.poc_px) s WHERE cv<=(SELECT t*0.35 FROM total))::float as val,
            MAX(vp.px)::float as day_high, MIN(vp.px)::float as day_low,
            (SELECT (array_agg(close ORDER BY ts DESC))[1]::float FROM price_bars WHERE symbol='NQ' AND ts::date=$1 AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16) as day_close
          FROM vp, poc_row p GROUP BY p.poc_px LIMIT 1
        `, [date]);
        const sh = await query(`SELECT l.profile_shape FROM acd_daily_log l WHERE l.trade_date=$1`, [date]);
        if (r.rows[0]?.vah) vaRows.push({ date, ...r.rows[0], profile_shape: sh.rows[0]?.profile_shape || null });
      } catch(e) {}
    }
    vaRows.reverse();

    const last10va = vaRows.slice(-10);
    const last5va  = vaRows.slice(-5);

    function overlapCount(days) {
      let count = 0;
      for (let i = 1; i < days.length; i++) {
        const prev = days[i-1], curr = days[i];
        if (!prev || !curr) continue;
        const overlapLow  = Math.max(prev.val, curr.val);
        const overlapHigh = Math.min(prev.vah, curr.vah);
        if (overlapHigh > overlapLow) count++;
      }
      return count;
    }

    function migrationDir(days) {
      if (days.length < 3) return 'OVERLAPPING';
      let up = 0, down = 0;
      for (let i = 1; i < days.length; i++) {
        if (!days[i-1] || !days[i]) continue;
        if (days[i].poc > days[i-1].poc) up++;
        else if (days[i].poc < days[i-1].poc) down++;
      }
      const total = days.length - 1;
      if (up / total >= 0.65) return 'HIGHER';
      if (down / total >= 0.65) return 'LOWER';
      return 'OVERLAPPING';
    }

    const overlaps10 = overlapCount(last10va);
    const overlaps5  = overlapCount(last5va);
    const dir10 = migrationDir(last10va);
    const dir5  = migrationDir(last5va);

    let bracketState, bracketConfidence, bracketPlaybook, transitionalNote;
    if (overlaps5 >= 4) {
      bracketState = 'BRACKET'; bracketConfidence = 'HIGH';
      bracketPlaybook = 'RESPONSIVE — fade VAH/VAL, buy VAL sell VAH, expect mean reversion.';
      if (dir5 === 'HIGHER') transitionalNote = `Bracket tilting BULLISH — value migrating higher within the balance zone.`;
      else if (dir5 === 'LOWER') transitionalNote = `Bracket tilting BEARISH — value migrating lower within the balance zone.`;
      else if (dir10 !== 'OVERLAPPING' && dir10 !== dir5) transitionalNote = `5-day is in balance but 10-day was ${dir10.toLowerCase()} — bracket may be forming after a prior trend.`;
    } else if (overlaps5 >= 3) {
      bracketState = 'BRACKET'; bracketConfidence = 'MODERATE';
      bracketPlaybook = 'RESPONSIVE — bracket edges are key levels but breakout risk elevated.';
      if (dir5 === 'HIGHER') transitionalNote = `Bracket tilting BULLISH with moderate confidence.`;
      else if (dir5 === 'LOWER') transitionalNote = `Bracket tilting BEARISH with moderate confidence.`;
      else if (dir5 !== 'OVERLAPPING' && dir10 !== 'OVERLAPPING' && dir5 !== dir10) transitionalNote = `5-day and 10-day migration disagree (5d: ${dir5}, 10d: ${dir10}) — reduce size.`;
    } else if (dir5 === 'HIGHER' && dir10 === 'HIGHER') {
      bracketState = 'TRENDING_UP'; bracketConfidence = 'HIGH';
      bracketPlaybook = 'INITIATIVE — buy pullbacks to prior VAH, do not fade range extensions upward.';
    } else if (dir5 === 'LOWER' && dir10 === 'LOWER') {
      bracketState = 'TRENDING_DOWN'; bracketConfidence = 'HIGH';
      bracketPlaybook = 'INITIATIVE — sell rallies to prior VAL, do not fade range extensions downward.';
    } else if (dir5 !== dir10) {
      bracketState = 'TRANSITIONAL'; bracketConfidence = 'HIGH';
      bracketPlaybook = 'REDUCE SIZE — 5-day and 10-day structure disagree.';
      transitionalNote = `5-day value moving ${dir5.toLowerCase()}, 10-day moving ${dir10.toLowerCase()}.`;
    } else {
      bracketState = 'BRACKET'; bracketConfidence = 'LOW';
      bracketPlaybook = 'RESPONSIVE — insufficient data for high-confidence classification.';
    }

    const valueMigration = dir5;

    const acdQ = await query(`
      SELECT trade_date::text, daily_score, a_up_fired, a_down_fired
      FROM acd_daily_log WHERE trade_date >= CURRENT_DATE - INTERVAL '30 days'
      ORDER BY trade_date DESC
    `);
    const acdRows = acdQ.rows;
    const nl30 = acdRows.reduce((s, r) => s + (r.daily_score || 0), 0);
    const nl10 = acdRows.slice(0, 10).reduce((s, r) => s + (r.daily_score || 0), 0);
    const nl5  = acdRows.slice(0, 5).reduce((s, r) => s + (r.daily_score || 0), 0);
    const nlPrev7 = acdRows.slice(5, 12).reduce((s, r) => s + (r.daily_score || 0), 0);
    const nlSparkline = acdRows.slice(0, 30).map(r => ({ date: r.trade_date, score: r.daily_score || 0 })).reverse();
    const loggedDays = acdRows.length;
    const nl30trend = nl30 > 9 ? 'BULLISH' : nl30 < -9 ? 'BEARISH' : 'RANGING';
    const nl10trend = nl10 > 9 ? 'BULLISH' : nl10 < -9 ? 'BEARISH' : 'RANGING';
    const nlDiverging = (nl30trend === 'BULLISH' && nl10 < 0) || (nl30trend === 'BEARISH' && nl10 > 0);
    const nlWeakening = (nl30trend === 'BULLISH' && nl10 < nl30 * 0.3) || (nl30trend === 'BEARISH' && nl10 > nl30 * 0.3);

    const efQ = await query(`
      WITH daily AS (
        SELECT ts::date as d, MAX(high)-MIN(low) as rng, SUM(volume) as vol,
          (array_agg(close ORDER BY ts DESC))[1]-(array_agg(open ORDER BY ts ASC))[1] as chg
        FROM price_bars WHERE symbol='NQ' AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
        GROUP BY ts::date HAVING COUNT(*)>100 ORDER BY d DESC LIMIT 10
      ), stats AS (
        SELECT AVG(rng) as ar, AVG(vol) as av FROM (
          SELECT MAX(high)-MIN(low) as rng, SUM(volume) as vol FROM price_bars
          WHERE symbol='NQ' AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
          GROUP BY ts::date HAVING COUNT(*)>100 ORDER BY MAX(ts) DESC LIMIT 30
        ) s
      )
      SELECT d::text, ROUND((vol/NULLIF(av,0))::numeric,2) as vol_ratio,
        ROUND((rng/NULLIF(ar,0))::numeric,2) as rng_ratio, ROUND(chg::numeric,1) as chg,
        CASE WHEN vol/NULLIF(av,0)>1.5 AND rng/NULLIF(ar,0)<0.7 THEN 'ABSORPTION'
             WHEN vol/NULLIF(av,0)<0.8 AND rng/NULLIF(ar,0)>1.3 THEN 'EASE_OF_MOVEMENT'
             ELSE 'NORMAL' END as flag
      FROM daily, stats ORDER BY d ASC
    `);
    const efRows = efQ.rows;
    const absorptionCount = efRows.filter(r => r.flag === 'ABSORPTION').length;
    const lastFlag = efRows[efRows.length-1]?.flag;
    const consecutiveAbsorption = (() => {
      let count = 0;
      for (let i = efRows.length-1; i >= 0; i--) {
        if (efRows[i].flag === 'ABSORPTION') count++; else break;
      }
      return count;
    })();

    const psQ = await query(`
      SELECT trade_date::text as date, profile_shape
      FROM acd_daily_log WHERE trade_date >= CURRENT_DATE - INTERVAL '14 days'
        AND profile_shape IS NOT NULL
      ORDER BY trade_date DESC LIMIT 10
    `);
    const profileShapes = psQ.rows.reverse();
    const loggedShapes = profileShapes.length;
    const recentShapes = profileShapes.slice(-3).map(r => r.profile_shape);
    const olderShapes  = profileShapes.slice(0, -3).map(r => r.profile_shape);
    const elongatedRecent = recentShapes.filter(s => s === 'ELONGATED').length;
    const fatRecent = recentShapes.filter(s => s === 'FAT').length;
    const squatRecent = recentShapes.filter(s => s === 'SQUAT').length;
    let shapeTransition = null;
    if (olderShapes.length >= 3) {
      const wasElongated = olderShapes.filter(s => s === 'ELONGATED').length >= Math.ceil(olderShapes.length * 0.6);
      if (wasElongated && fatRecent >= 2) shapeTransition = 'ELONGATED_TO_FAT';
      if (wasElongated && squatRecent >= 1) shapeTransition = 'ELONGATED_TO_SQUAT';
      const wasFat = olderShapes.filter(s => s === 'FAT').length >= Math.ceil(olderShapes.length * 0.6);
      if (wasFat && squatRecent >= 2) shapeTransition = 'FAT_TO_SQUAT';
    }

    const weekStart = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
    const weekStartStr = weekStart.toISOString().split('T')[0];
    const wQ = await query(`
      SELECT MAX(high)::float as wh, MIN(low)::float as wl,
        (array_agg(high ORDER BY ts))[1]::float as mon_open
      FROM price_bars WHERE symbol='NQ' AND ts::date>=$1 AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
    `, [weekStartStr]);
    const monIBQ = await query(`
      SELECT MAX(high)::float as h, MIN(low)::float as l
      FROM price_bars WHERE symbol='NQ' AND ts::date=$1
        AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 630
    `, [weekStartStr]);
    const wRow = wQ.rows[0], monIB = monIBQ.rows[0];
    const monIBRange = monIB?.h && monIB?.l ? monIB.h - monIB.l : null;
    const weekRange = wRow?.wh && wRow?.wl ? wRow.wh - wRow.wl : null;
    let weekType = null;
    if (monIBRange && weekRange) weekType = weekRange > monIBRange * 2 ? 'TREND' : weekRange > monIBRange * 1.5 ? 'NORMAL_VARIATION' : 'NORMAL';

    let bull = 0, bear = 0, neutral = 0;
    if (valueMigration === 'HIGHER') bull++; else if (valueMigration === 'LOWER') bear++; else neutral++;
    if (nl30 > 9) bull++; else if (nl30 < -9) bear++; else neutral++;
    if (nl10 > 0) bull++; else if (nl10 < 0) bear++; else neutral++;
    if (bracketState === 'TRENDING_UP') bull++; else if (bracketState === 'TRENDING_DOWN') bear++; else neutral++;
    if (lastFlag === 'EASE_OF_MOVEMENT') bull++; else if (lastFlag === 'ABSORPTION') neutral++; else neutral++;
    if (weekType === 'TREND') { if (wRow?.wh > wRow?.wl) bull++; } else neutral++;

    let summaryLevel, summaryText;
    if (bull >= 4 && bear === 0) { summaryLevel = 'BULLISH'; summaryText = `Strong bullish structure — ${bull} of ${bull+bear+neutral} components aligned higher.`; }
    else if (bear >= 4 && bull === 0) { summaryLevel = 'BEARISH'; summaryText = `Strong bearish structure — ${bear} of ${bull+bear+neutral} components aligned lower.`; }
    else if (bull >= 3 && bear <= 1) { summaryLevel = 'BULLISH'; summaryText = `Bullish structural lean — ${bull} components aligned higher with ${bear} conflicting.`; }
    else if (bear >= 3 && bull <= 1) { summaryLevel = 'BEARISH'; summaryText = `Bearish structural lean — ${bear} components aligned lower with ${bull} conflicting.`; }
    else if (bracketState === 'TRANSITIONAL') { summaryLevel = 'TRANSITIONAL'; summaryText = `Transitional — 5-day and 10-day structures disagree. Reduce size significantly.`; }
    else { summaryLevel = 'NEUTRAL'; summaryText = `Balanced structure — ${neutral} components neutral, ${bull} bullish, ${bear} bearish.`; }

    const result = {
      generatedAt: new Date().toISOString(),
      loggedDays,
      dataQuality: loggedDays >= 20 ? 'GOOD' : loggedDays >= 10 ? 'LIMITED' : 'INSUFFICIENT',
      summary: { level: summaryLevel, text: summaryText, bull, bear, neutral },
      valueMigration: { direction: valueMigration, days: vaRows, last10: last10va, last5: last5va, overlapCount5: overlaps5, overlapCount10: overlaps10 },
      acd: { nl30, nl10, nl5, nlPrev7, nl30trend, nl10trend, nlDiverging, nlWeakening, sparkline: nlSparkline, loggedDays },
      effortResult: { sessions: efRows, absorptionCount, consecutiveAbsorption, lastFlag },
      bracketState: { state: bracketState, confidence: bracketConfidence, playbook: bracketPlaybook, dir5, dir10, overlaps5, overlaps10, transitionalNote },
      profileShapes: { shapes: profileShapes, loggedShapes, shapeTransition, recentShapes, olderShapes },
      weeklyStructure: { weekStart: weekStartStr, weekHigh: wRow?.wh, weekLow: wRow?.wl, monIBHigh: monIB?.h, monIBLow: monIB?.l, monIBRange, weekRange, weekType },
    };

    cacheSet(`longterm-summary-${lbd}`, result, 2 * 60 * 60 * 1000);
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/longterm/profile-shape/:date', async (req, res) => {
  try {
    const r = await query(`SELECT profile_shape FROM acd_daily_log WHERE trade_date=$1`, [req.params.date]);
    res.json({ profile_shape: r.rows[0]?.profile_shape || null });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/longterm/profile-shape', async (req, res) => {
  try {
    const { date, profile_shape } = req.body;
    await query(`UPDATE acd_daily_log SET profile_shape=$1 WHERE trade_date=$2`, [profile_shape, date]);
    cacheDelete('longterm-summary');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

export default router;
