import express from 'express';
import { query } from '../db.js';
import { cacheGet, cacheSet, latestBarDate } from '../lib/cache.js';
import { getGLine } from '../services/queries.js';

const router = express.Router();

// GET /api/auction-read/day-setups?date=YYYY-MM-DD
// Returns only profitable setups from ACD events + key level interactions
router.get('/auction-read/day-setups', async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: 'date required' });

    // Get bars + levels
    const barsR = await query(`
      SELECT ts, open::float, high::float, low::float, close::float, volume::bigint,
             SUM(close::float * volume::bigint) OVER (ORDER BY ts) /
             NULLIF(SUM(volume::bigint) OVER (ORDER BY ts), 0) as vwap_running
      FROM price_bars_primary
      WHERE symbol='NQ' AND ts::date=$1
        AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 960
      ORDER BY ts
    `, [date]);
    const bars = barsR.rows;
    if (!bars.length) return res.json([]);

    // Get key levels from prior day
    const priorR = await query(`
      SELECT MAX(ts::date::text) as prior_date FROM price_bars_primary
      WHERE symbol='NQ' AND ts::date < $1 AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
    `, [date]);
    const priorDate = priorR.rows[0]?.prior_date;

    let pdHigh = null, pdLow = null, pdVAH = null, pdVAL = null, onHigh = null, onLow = null;
    if (priorDate) {
      const pd = await query(`
        SELECT MAX(high)::float as h, MIN(low)::float as l FROM price_bars_primary
        WHERE symbol='NQ' AND ts::date=$1 AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
      `, [priorDate]);
      pdHigh = pd.rows[0]?.h; pdLow = pd.rows[0]?.l;

      // Prior day VA
      const vaR = await query(`
        WITH vp AS (SELECT ROUND(low/0.25)*0.25 as px, SUM(volume) as vol FROM price_bars_primary WHERE symbol='NQ' AND ts::date=$1 AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16 GROUP BY ROUND(low/0.25)*0.25),
        total AS (SELECT SUM(vol) as t FROM vp), poc_row AS (SELECT px FROM vp ORDER BY vol DESC LIMIT 1)
        SELECT p2.px::float as poc,
          (SELECT MAX(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px DESC) as cv FROM vp WHERE px >= p2.px) x WHERE cv <= (SELECT t*0.35 FROM total))::float as vah,
          (SELECT MIN(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px ASC) as cv FROM vp WHERE px <= p2.px) x WHERE cv <= (SELECT t*0.35 FROM total))::float as val
        FROM vp, poc_row p2 GROUP BY p2.px LIMIT 1
      `, [priorDate]);
      pdVAH = vaR.rows[0]?.vah; pdVAL = vaR.rows[0]?.val;

      // Overnight range (bars between 16:00 prior and 09:30 today)
      const onR = await query(`
        SELECT MAX(high)::float as h, MIN(low)::float as l FROM price_bars_primary
        WHERE symbol='NQ' AND ts::date=$1 AND (EXTRACT(hour FROM ts) >= 16 OR EXTRACT(hour FROM ts) < 9)
      `, [priorDate]);
      onHigh = onR.rows[0]?.h; onLow = onR.rows[0]?.l;
    }

    // ACD levels
    const acdR = await query(`SELECT or_high::float, or_low::float FROM acd_daily_log WHERE trade_date=$1`, [date]);
    const ibHigh = acdR.rows[0]?.or_high, ibLow = acdR.rows[0]?.or_low;

    // Key levels to test
    const keyLevels = [
      { key: 'IBH',    price: ibHigh,  type: 'resistance', desc: 'Initial Balance High' },
      { key: 'IBL',    price: ibLow,   type: 'support',    desc: 'Initial Balance Low'  },
      { key: 'PD VAH', price: pdVAH,   type: 'resistance', desc: 'Prior Day Value Area High' },
      { key: 'PD VAL', price: pdVAL,   type: 'support',    desc: 'Prior Day Value Area Low'  },
      { key: 'PD High',price: pdHigh,  type: 'resistance', desc: 'Prior Day High' },
      { key: 'PD Low', price: pdLow,   type: 'support',    desc: 'Prior Day Low'  },
      { key: 'ON High',price: onHigh,  type: 'resistance', desc: 'Overnight High'  },
      { key: 'ON Low', price: onLow,   type: 'support',    desc: 'Overnight Low'   },
    ].filter(l => l.price);

    // For each level, find the first test and measure subsequent move
    const TOUCH_RANGE = 8; // pts to consider "testing" the level
    const MEASURE_BARS = 30; // bars to measure reaction (~30 min)
    const MIN_MOVE = 15; // minimum pts to call "profitable"

    const profitable = [];

    for (const lvl of keyLevels) {
      const p = parseFloat(lvl.price);
      for (let i = 10; i < bars.length - MEASURE_BARS; i++) {
        const bar = bars[i];
        const touched = lvl.type === 'resistance'
          ? bar.high >= p - TOUCH_RANGE && bar.high <= p + TOUCH_RANGE
          : bar.low <= p + TOUCH_RANGE && bar.low >= p - TOUCH_RANGE;
        if (!touched) continue;

        // Measure reaction over next MEASURE_BARS
        const futBars = bars.slice(i + 1, i + MEASURE_BARS + 1);
        const futClose = futBars[futBars.length - 1]?.close;
        if (!futClose) break;

        const move = lvl.type === 'resistance'
          ? bar.high - Math.min(...futBars.map(b => b.low))   // resistance: how far did it drop
          : Math.max(...futBars.map(b => b.high)) - bar.low;  // support: how far did it rise

        if (move >= MIN_MOVE) {
          const time = new Date(bar.ts).toISOString().slice(11, 16);
          profitable.push({
            type: 'KEY_LEVEL',
            setup: lvl.key,
            desc: lvl.desc,
            level_type: lvl.type,
            price: p,
            time,
            move_pts: Math.round(move),
            direction: lvl.type === 'resistance' ? 'SHORT' : 'LONG',
          });
        }
        break; // only count first test
      }
    }

    // ACD setups - check if move was profitable
    const acdEvents = await query(`
      SELECT setup_type, TO_CHAR(fired_time,'HH24:MI') as fired_time, fired_price::float
      FROM acd_setup_events WHERE trade_date=$1 ORDER BY fired_time
    `, [date]);

    for (const ev of acdEvents.rows) {
      const isLong  = ev.setup_type?.includes('A_UP') && !ev.setup_type?.includes('Failed');
      const isShort = ev.setup_type?.includes('A_DOWN') && !ev.setup_type?.includes('Failed') ||
                      ev.setup_type?.includes('Failed_A_Up');
      const isLong2 = ev.setup_type?.includes('Failed_A_Down');
      if (!isLong && !isShort && !isLong2) continue;

      const barIdx = bars.findIndex(b => new Date(b.ts).toISOString().slice(11, 16) === ev.fired_time);
      if (barIdx < 0 || barIdx >= bars.length - MEASURE_BARS) continue;

      const futBars = bars.slice(barIdx + 1, barIdx + MEASURE_BARS + 1);
      if (!futBars.length) continue;

      const entryPrice = parseFloat(ev.fired_price);
      let movePts;
      if (isLong || isLong2) {
        movePts = Math.max(...futBars.map(b => b.high)) - entryPrice;
      } else {
        movePts = entryPrice - Math.min(...futBars.map(b => b.low));
      }

      if (movePts >= MIN_MOVE) {
        profitable.push({
          type: 'ACD',
          setup: ev.setup_type.replace(/_/g, ' '),
          desc: '',
          level_type: (isLong || isLong2) ? 'support' : 'resistance',
          price: entryPrice,
          time: ev.fired_time,
          move_pts: Math.round(movePts),
          direction: (isLong || isLong2) ? 'LONG' : 'SHORT',
        });
      }
    }

    // VWAP interaction setups
    for (let i = 10; i < bars.length - MEASURE_BARS; i++) {
      const bar = bars[i];
      const vwap = bar.vwap_running;
      if (!vwap) continue;
      // Look for VWAP cross/reclaim
      const prev = bars[i - 1];
      if (!prev?.vwap_running) continue;
      const crossUp   = prev.close < prev.vwap_running && bar.close > vwap;
      const crossDown = prev.close > prev.vwap_running && bar.close < vwap;
      if (!crossUp && !crossDown) continue;

      const futBars = bars.slice(i + 1, i + MEASURE_BARS + 1);
      const move = crossUp
        ? Math.max(...futBars.map(b => b.high)) - bar.close
        : bar.close - Math.min(...futBars.map(b => b.low));

      if (move >= MIN_MOVE) {
        const time = new Date(bar.ts).toISOString().slice(11, 16);
        profitable.push({
          type: 'VWAP',
          setup: crossUp ? 'VWAP Reclaim' : 'VWAP Break',
          desc: crossUp ? 'Price crossed above VWAP — buyers taking control' : 'Price crossed below VWAP — sellers taking control',
          level_type: crossUp ? 'support' : 'resistance',
          price: parseFloat(vwap.toFixed(2)),
          time,
          move_pts: Math.round(move),
          direction: crossUp ? 'LONG' : 'SHORT',
        });
        break; // first VWAP cross only
      }
    }

    // Sort by move size descending
    profitable.sort((a, b) => b.move_pts - a.move_pts);
    res.json(profitable);
  } catch(e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// GET /api/composite-profile?days=5 — multi-day TPO composite profile
router.get('/composite-profile', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 5;
    const lbd = await latestBarDate();
    const cacheKey = `composite-tpo-${days}-${lbd}`;
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);

    // Current price for context
    const latestBar = await query(`SELECT close::float as close FROM price_bars_primary WHERE symbol='NQ' ORDER BY ts DESC LIMIT 1`);
    const currentPrice = latestBar.rows[0]?.close || null;

    // Build TPO composite: each 1-min bar contributes 1 count to each price level it spans
    const tpoQ = await query(`
      WITH bars AS (
        SELECT ROUND(low/0.25)*0.25 as lo, ROUND(high/0.25)*0.25 as hi
        FROM price_bars_primary WHERE symbol='NQ'
          AND ts::date >= CURRENT_DATE - ($1 || ' days')::INTERVAL
          AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
      )
      SELECT ROUND((lo + s*0.25)::numeric, 2)::float as px, COUNT(*)::int as tpo
      FROM bars, generate_series(0, ROUND((hi-lo)/0.25)::int) s
      GROUP BY px ORDER BY px ASC
    `, [days]);

    if (!tpoQ.rows.length) return res.json({ available: false });

    const profile = tpoQ.rows; // [{px, tpo}]
    const totalTpo = profile.reduce((s, r) => s + r.tpo, 0);
    const maxTpo   = Math.max(...profile.map(r => r.tpo));

    // POC = most time spent
    const poc = profile.reduce((best, r) => r.tpo > best.tpo ? r : best, profile[0]);

    // Value area (70% of total TPO around POC)
    const target = totalTpo * 0.70;
    const pocIdx = profile.findIndex(r => r.px === poc.px);
    let lo = pocIdx, hi = pocIdx, accumulated = poc.tpo;
    while (accumulated < target && (lo > 0 || hi < profile.length - 1)) {
      const addLo = lo > 0 ? profile[lo - 1].tpo : 0;
      const addHi = hi < profile.length - 1 ? profile[hi + 1].tpo : 0;
      if (addLo >= addHi) { lo--; accumulated += addLo; }
      else { hi++; accumulated += addHi; }
    }
    const vah = profile[hi].px;
    const val = profile[lo].px;

    // HVN: local peaks (tpo > 80% of max and higher than both neighbors)
    const hvn = profile.filter((r, i) =>
      i > 0 && i < profile.length - 1 &&
      r.tpo > maxTpo * 0.65 &&
      r.tpo >= profile[i-1].tpo &&
      r.tpo >= profile[i+1].tpo
    ).map(r => r.px);

    // LVN: local valleys within value area (tpo < 30% of max between two HVNs)
    const lvn = profile.filter((r, i) =>
      i > 0 && i < profile.length - 1 &&
      r.px >= val && r.px <= vah &&
      r.tpo < maxTpo * 0.25 &&
      r.tpo <= profile[i-1].tpo &&
      r.tpo <= profile[i+1].tpo
    ).map(r => r.px);

    // Context: where is current price relative to composite
    let priceContext = null;
    if (currentPrice) {
      if (currentPrice > vah) priceContext = `Price above composite value area — buyers accepting prices above ${days}-session fair value. Initiative territory.`;
      else if (currentPrice < val) priceContext = `Price below composite value area — sellers pushing below ${days}-session fair value. Watch for responsive buyers at VAL (${val}).`;
      else if (Math.abs(currentPrice - poc.px) < 20) priceContext = `Price near composite POC (${poc.px}) — the most accepted price of the last ${days} sessions. Expect two-sided trade here.`;
      else if (currentPrice > poc.px) priceContext = `Price above composite POC (${poc.px}) within value — buyers in control of the ${days}-session range but not yet breaking out.`;
      else priceContext = `Price below composite POC (${poc.px}) within value — sellers in control of the ${days}-session range but not yet breaking down.`;
    }

    const result = {
      available: true, days,
      profile: profile.slice(0, 2000), // cap for response size
      poc: poc.px, pocTpo: poc.tpo,
      vah, val, hvn: hvn.slice(0, 10), lvn: lvn.slice(0, 10),
      totalTpo, maxTpo, currentPrice, priceContext,
      priceVsVA: currentPrice > vah ? 'ABOVE' : currentPrice < val ? 'BELOW' : 'INSIDE',
      priceVsPoc: currentPrice > poc.px ? 'ABOVE' : currentPrice < poc.px ? 'BELOW' : 'AT',
    };
    cacheSet(cacheKey, result, 4 * 60 * 60 * 1000);
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/auction-read/auto — auto-detect Phase 1 + Phase 2 values from bar data
router.get('/auction-read/auto', async (req, res) => {
  try {
    const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

    // Prior day value area — CTE approach (avoids LATERAL+WITH compatibility issue)
    const priorDayQ = await query(`SELECT MAX(ts::date)::text as d FROM price_bars_primary WHERE symbol='NQ' AND ts::date < $1 AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16`, [todayET]);
    const priorDay = priorDayQ.rows[0]?.d;
    const ctx = priorDay ? await query(`
      WITH vp AS (
        SELECT ROUND(low/0.25)*0.25 as px, SUM(volume) as vol
        FROM price_bars_primary WHERE symbol='NQ' AND ts::date=$1 AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
        GROUP BY ROUND(low/0.25)*0.25
      ), total AS (SELECT SUM(vol) as t FROM vp),
      poc_row AS (SELECT px as poc_px FROM vp ORDER BY vol DESC LIMIT 1)
      SELECT p.poc_px::float as poc,
        (SELECT MAX(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px DESC) as cv FROM vp WHERE px >= p.poc_px) x WHERE cv <= (SELECT t*0.35 FROM total))::float as vah,
        (SELECT MIN(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px ASC) as cv FROM vp WHERE px <= p.poc_px) x WHERE cv <= (SELECT t*0.35 FROM total))::float as val
      FROM vp, poc_row p GROUP BY p.poc_px LIMIT 1
    `, [priorDay]) : { rows: [] };

    const va = ctx.rows[0] || {};
    const vah = parseFloat(va.vah), val = parseFloat(va.val), poc = parseFloat(va.poc);

    // Today's OR + current price
    const todayLog = await query(`SELECT or_high, or_low FROM acd_daily_log WHERE trade_date=$1`, [todayET]);
    const latestBar = await query(`SELECT close::float as close FROM price_bars_primary WHERE symbol='NQ' ORDER BY ts DESC LIMIT 1`);
    const nqClose = latestBar.rows[0]?.close || 0;
    const orH = todayLog.rows[0]?.or_high ? parseFloat(todayLog.rows[0].or_high) : null;
    const orL = todayLog.rows[0]?.or_low  ? parseFloat(todayLog.rows[0].or_low)  : null;
    const orRange = orH && orL ? orH - orL : null;
    const orMid = orH && orL ? (orH + orL) / 2 : null;

    // 30-day average OR range
    const avgOR = await query(`
      SELECT ROUND(AVG(or_high - or_low)::numeric, 1) as avg, ROUND(STDDEV(or_high - or_low)::numeric, 1) as sd
      FROM acd_daily_log WHERE or_high IS NOT NULL AND trade_date >= CURRENT_DATE - 30
    `);
    const avgRange = parseFloat(avgOR.rows[0]?.avg) || 85;
    const sdRange  = parseFloat(avgOR.rows[0]?.sd)  || null;

    // Auto-detect: open vs prior value
    const refPrice = orMid || nqClose;
    let open_vs_prior_value = null;
    if (vah && val && refPrice) {
      if (refPrice > vah)      open_vs_prior_value = 'ABOVE_VALUE';
      else if (refPrice < val) open_vs_prior_value = 'BELOW_VALUE';
      else                     open_vs_prior_value = 'INSIDE_VALUE';
    }

    // Auto-detect: overnight inventory
    let overnight_inventory = null;
    if (vah && val && refPrice) {
      if (refPrice > vah)      overnight_inventory = 'SHORT_TRAPPED';   // price above — shorts from prior session trapped
      else if (refPrice < val) overnight_inventory = 'LONG_TRAPPED';    // price below — longs from prior session trapped
      else                     overnight_inventory = 'NEUTRAL';
    }

    // Auto-detect: OR condition
    let or_condition = null;
    if (orRange && avgRange) {
      const ratio = orRange / avgRange;
      if (ratio < 0.5)      or_condition = 'NARROW';
      else if (ratio < 1.5) or_condition = 'NORMAL';
      else if (ratio < 2.5) or_condition = 'WIDE';
      else                  or_condition = 'EMOTIONAL';
    }

    // Auto-detect: prior day profile from yesterday's session range vs IB range
    let prior_day_profile = null;
    const priorDate = (await query(`SELECT MAX(ts::date)::text as d FROM price_bars_primary WHERE symbol='NQ' AND ts::date < $1`, [todayET])).rows[0]?.d;
    if (priorDate) {
      const priorIB = await query(`SELECT or_high::float as ib_high, or_low::float as ib_low FROM acd_daily_log WHERE trade_date=$1`, [priorDate]);
      const priorSess = await query(`SELECT MAX(high)::float as sh, MIN(low)::float as sl FROM price_bars_primary WHERE symbol='NQ' AND ts::date=$1 AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16`, [priorDate]);
      const ib = priorIB.rows[0] || {};
      const sess = priorSess.rows[0] || {};
      const ibR = (ib.ib_high || 0) - (ib.ib_low || 0);
      const sessR = (sess.sh || 0) - (sess.sl || 0);
      if (ibR > 0 && sessR > 0) {
        const ext = sessR / ibR;
        const closePct = sessR > 0 ? ((sess.sc || 0) - sess.sl) / sessR : 0.5;
        prior_day_profile = ext > 2.0 ? 'TREND'
          : ext > 1.5 ? 'NORMAL_VARIATION'
          : ext > 0.9 ? 'NORMAL'
          : (sess.sh > ib.ib_high && sess.sl < ib.ib_low && (closePct > 0.75 || closePct < 0.25)) ? 'RUNNING_PROFILE_NEUTRAL'
          : (sess.sh > ib.ib_high && sess.sl < ib.ib_low) ? 'NEUTRAL'
          : 'NONTREND';
      }
    }

    // Overnight high/low (prior 4 PM to today 9:30) — needed for T1 targets
    const ovnQ = await query(`
      SELECT MAX(high)::float as ovn_high, MIN(low)::float as ovn_low
      FROM price_bars_primary WHERE symbol='NQ'
        AND ts > (SELECT MAX(ts::date)::timestamp FROM price_bars_primary WHERE symbol='NQ' AND ts::date < $1 AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16) + INTERVAL '7 hours'
        AND ts < ($1::text)::date + INTERVAL '9 hours 30 minutes'
    `, [todayET]);
    const ovnHigh = ovnQ.rows[0]?.ovn_high || null;
    const ovnLow  = ovnQ.rows[0]?.ovn_low  || null;

    // IB Low -1x Range (A-down extended target)
    const ibLow1x = orH && orL ? orL - (orH - orL) : null;
    // IB High (= OR High for A-up target)
    const ibHigh  = orH || null;

    // G-Line (weekly open) + prior week high/low — structural reference levels for pre-market
    const gLine = await getGLine(todayET);
    const pwQ = await query(`
      SELECT MAX(high)::float as pw_high, MIN(low)::float as pw_low
      FROM price_bars_primary WHERE symbol='NQ'
        AND ts::date >= date_trunc('week', ($1::text)::date) - INTERVAL '7 days'
        AND ts::date < date_trunc('week', ($1::text)::date)
        AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
    `, [todayET]);
    const pwHigh = pwQ.rows[0]?.pw_high || null;
    const pwLow  = pwQ.rows[0]?.pw_low  || null;

    // Latest price for pre-market display
    const latestClose = latestBar.rows[0]?.close || null;

    res.json({
      open_vs_prior_value, overnight_inventory, or_condition, prior_day_profile,
      prior_day_vah: vah || null, prior_day_val: val || null, prior_day_poc: poc || null,
      avg_or_range: avgRange, today_or_range: orRange, or_range_stddev: sdRange,
      ovn_high: ovnHigh, ovn_low: ovnLow,
      ib_high: ibHigh, ib_low: orL || null, ib_low_1x: ibLow1x,
      g_line: gLine || null, pw_high: pwHigh, pw_low: pwLow,
      latest_close: latestClose,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/auction-read/correlation — serve cached correlation results
router.get('/auction-read/correlation', async (req, res) => {
  try {
    const r = await query(`
      SELECT bias_dir, setup_key, tested, profitable, avg_pts, max_pts,
             ROUND(hit_rate*100,1) as hit_rate_pct, prior_hit_rate,
             prior_avg_pts, changed, computed_at::text
      FROM setup_correlation_cache
      WHERE tested >= 3
      ORDER BY bias_dir, hit_rate DESC, avg_pts DESC
    `);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/auction-read/correlation/compute — run full correlation analysis
router.post('/auction-read/correlation/compute', async (req, res) => {
  try {
    res.json({ ok: true, message: 'Correlation computation started' });
    const TOUCH=8, BARS=30, MIN=15;
    const hist = await query(`SELECT date::text, bias_dir, pts_vs_open FROM auction_history WHERE bias_dir IS NOT NULL ORDER BY date`);
    const acc = {};

    for (const row of hist.rows) {
      const { date, bias_dir } = row;
      const bars = (await query(`
        SELECT ts, high::float h, low::float l, close::float c,
          SUM(close::float*volume::bigint) OVER (ORDER BY ts)/NULLIF(SUM(volume::bigint) OVER (ORDER BY ts),0) vw
        FROM price_bars_primary WHERE symbol='NQ' AND ts::date=$1
          AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 960 ORDER BY ts`, [date])).rows;
      if (bars.length < 50) continue;

      const pdR = await query(`SELECT MAX(ts::date::text) p FROM price_bars_primary WHERE symbol='NQ' AND ts::date<$1 AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16`, [date]);
      const priorDate = pdR.rows[0]?.p;
      if (!priorDate) continue;

      const pd = (await query(`SELECT MAX(high)::float h, MIN(low)::float l FROM price_bars_primary WHERE symbol='NQ' AND ts::date=$1 AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16`, [priorDate])).rows[0];
      const va = (await query(`WITH vp AS (SELECT ROUND(low/0.25)*0.25 px, SUM(volume) vol FROM price_bars_primary WHERE symbol='NQ' AND ts::date=$1 AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16 GROUP BY ROUND(low/0.25)*0.25), t AS (SELECT SUM(vol) t FROM vp), pr AS (SELECT px FROM vp ORDER BY vol DESC LIMIT 1) SELECT p2.px::float poc, (SELECT MAX(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px DESC) cv FROM vp WHERE px>=p2.px) x WHERE cv<=(SELECT t*0.35 FROM t))::float vah, (SELECT MIN(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px ASC) cv FROM vp WHERE px<=p2.px) x WHERE cv<=(SELECT t*0.35 FROM t))::float val FROM vp, pr p2 GROUP BY p2.px LIMIT 1`, [priorDate])).rows[0];
      const acd = (await query(`SELECT or_high::float oh, or_low::float ol FROM acd_daily_log WHERE trade_date=$1`, [date])).rows[0];
      const on = (await query(`SELECT MAX(high)::float h, MIN(low)::float l FROM price_bars_primary WHERE symbol='NQ' AND ts::date=$1 AND (EXTRACT(hour FROM ts) >= 16 OR EXTRACT(hour FROM ts) < 9)`, [priorDate])).rows[0];
      const orMid = (acd?.oh != null && acd?.ol != null) ? (parseFloat(acd.oh) + parseFloat(acd.ol)) / 2 : null;

      const levels = [
        {k:'IBH',p:acd?.oh,t:'resistance'},{k:'IBL',p:acd?.ol,t:'support'},
        {k:'PD VAH',p:va?.vah,t:'resistance'},{k:'PD VAL',p:va?.val,t:'support'},
        {k:'PD High',p:pd?.h,t:'resistance'},{k:'PD Low',p:pd?.l,t:'support'},
        {k:'ON High',p:on?.h,t:'resistance'},{k:'ON Low',p:on?.l,t:'support'},
      ].filter(l=>l.p);

      const bkey = bias_dir || 'NEUTRAL';
      if (!acc[bkey]) acc[bkey] = {};

      for (const lv of levels) {
        const p = parseFloat(lv.p);
        for (let i=10; i<bars.length-BARS; i++) {
          const b=bars[i];
          const hit=lv.t==='resistance'?b.h>=p-TOUCH&&b.h<=p+TOUCH:b.l<=p+TOUCH&&b.l>=p-TOUCH;
          if (!hit) continue;
          const fut=bars.slice(i+1,i+BARS+1);
          const mv=lv.t==='resistance'?p-Math.min(...fut.map(x=>x.l)):Math.max(...fut.map(x=>x.h))-p;
          if (!acc[bkey][lv.k]) acc[bkey][lv.k]={tested:0,profitable:0,pts:[]};
          acc[bkey][lv.k].tested++;
          if (mv>=MIN){acc[bkey][lv.k].profitable++;acc[bkey][lv.k].pts.push(Math.round(mv));}
          break;
        }
      }
      // VWAP
      for (let i=10; i<bars.length-BARS; i++) {
        const prev=bars[i-1],cur=bars[i];
        if (!prev?.vw||!cur?.vw) continue;
        const up=prev.c<prev.vw&&cur.c>cur.vw,dn=prev.c>prev.vw&&cur.c<cur.vw;
        if (!up&&!dn) continue;
        const fut=bars.slice(i+1,i+BARS+1);
        const mv=up?Math.max(...fut.map(x=>x.h))-cur.c:cur.c-Math.min(...fut.map(x=>x.l));
        const k=up?'VWAP Reclaim':'VWAP Break';
        if (!acc[bkey][k]) acc[bkey][k]={tested:0,profitable:0,pts:[]};
        acc[bkey][k].tested++;
        if (mv>=MIN){acc[bkey][k].profitable++;acc[bkey][k].pts.push(Math.round(mv));}
        break;
      }
      // OR Mid — pivot level, no fixed polarity. Type for each touch is determined by the
      // approach direction (price coming from above = test as resistance/support-from-above,
      // i.e. does it hold and reject back the way it came). Same bounce/hold semantics as IBH/IBL.
      if (orMid != null) {
        for (let i=11; i<bars.length-BARS; i++) {
          const b=bars[i], prev=bars[i-1];
          const touched = b.l<=orMid+TOUCH && b.h>=orMid-TOUCH;
          if (!touched) continue;
          const fromAbove = prev.c > orMid;
          const fut=bars.slice(i+1,i+BARS+1);
          const mv = fromAbove ? orMid-Math.min(...fut.map(x=>x.l)) : Math.max(...fut.map(x=>x.h))-orMid;
          if (!acc[bkey]['OR Mid']) acc[bkey]['OR Mid']={tested:0,profitable:0,pts:[]};
          acc[bkey]['OR Mid'].tested++;
          if (mv>=MIN){acc[bkey]['OR Mid'].profitable++;acc[bkey]['OR Mid'].pts.push(Math.round(mv));}
          break;
        }
      }
    }

    // Save to DB with change detection
    for (const [bias, setups] of Object.entries(acc)) {
      for (const [key, v] of Object.entries(setups)) {
        if (v.tested < 3) continue;
        const hitRate = v.profitable / v.tested;
        const avgPts = v.pts.length ? Math.round(v.pts.reduce((s,x)=>s+x,0)/v.pts.length) : 0;
        const maxPts = v.pts.length ? Math.max(...v.pts) : 0;
        const existing = await query(`SELECT hit_rate, avg_pts FROM setup_correlation_cache WHERE bias_dir=$1 AND setup_key=$2`, [bias, key]);
        const prior = existing.rows[0];
        const changed = prior ? (Math.abs(hitRate - parseFloat(prior.hit_rate)) > 0.05 || Math.abs(avgPts - prior.avg_pts) > 10) : false;
        await query(`
          INSERT INTO setup_correlation_cache (bias_dir, setup_key, tested, profitable, avg_pts, max_pts, hit_rate, prior_hit_rate, prior_avg_pts, changed, computed_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
          ON CONFLICT (bias_dir, setup_key) DO UPDATE SET
            tested=$3, profitable=$4, avg_pts=$5, max_pts=$6, hit_rate=$7,
            prior_hit_rate=COALESCE($8, setup_correlation_cache.hit_rate),
            prior_avg_pts=COALESCE($9, setup_correlation_cache.avg_pts),
            changed=$10, computed_at=NOW()
        `, [bias, key, v.tested, v.profitable, avgPts, maxPts, hitRate,
            prior ? parseFloat(prior.hit_rate) : null,
            prior ? prior.avg_pts : null, changed]);
      }
    }
    console.log('Setup correlation computed and cached');
  } catch(e) { console.error('Correlation compute error:', e.message); }
});

// POST /api/auction-read/history/refresh — force recompute all history
router.post('/auction-read/history/refresh', async (req, res) => {
  try {
    await query('DELETE FROM auction_history');
    cacheSet('auction-history-30', null, 1);
    cacheSet('auction-history-60', null, 1);
    cacheSet('auction-history-90', null, 1);
    res.json({ ok: true, message: 'History cleared — will recompute on next load' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/auction-read/history — serve from DB when available, compute missing days
router.get('/auction-read/history', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const cacheKey = `auction-history-${days}`;
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);

    // Check what's already in the DB
    const stored = await query(`
      SELECT *, date::text as date_str FROM auction_history
      WHERE date >= CURRENT_DATE - ($1 || ' days')::INTERVAL
      ORDER BY date DESC
    `, [days * 2]);

    // Serve from DB only when we have enough days AND the most recent record is current
    const mostRecentStored = stored.rows[0]?.date_str;
    const latestBarDate = (await query(`SELECT MAX(ts::date)::text as d FROM price_bars_primary WHERE symbol='NQ' AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16`)).rows[0]?.d;
    const dbIsCurrent = mostRecentStored && latestBarDate && mostRecentStored >= latestBarDate;

    if (stored.rows.length >= days - 5 && dbIsCurrent) {
      const result = stored.rows.map(r => ({
        date: r.date_str, priorDay: r.prior_day, priorProfile: r.prior_profile,
        nlTrend: r.nl_trend, nl30: r.nl30, inv: r.inv, valPos: r.val_pos,
        orCond: r.or_cond, biasDir: r.bias_dir, conflict: r.conflict,
        outcome: r.outcome, actualDir: r.actual_dir, acdScore: r.acd_score,
        ptsVsOpen: r.pts_vs_open, orHigh: r.or_high, orLow: r.or_low,
        aUpLevel: r.a_up_level, aDownLevel: r.a_down_level,
        aUpFired: r.a_up_fired, aDownFired: r.a_down_fired,
        priorVAH: r.prior_vah, priorVAL: r.prior_val, priorPOC: r.prior_poc,
        sessionHigh: r.session_high, sessionLow: r.session_low,
        sessionClose: r.session_close, sessionOpen: r.session_open,
        pivotBias: r.pivot_bias, bars: r.bars || [],
      }));
      cacheSet(cacheKey, result, 4 * 60 * 60 * 1000);
      return res.json(result);
    }
    // DB is stale — fall through to recompute missing days

    // Need to compute — send partial from DB while computing
    const storedDates = new Set(stored.rows.map(r => r.date_str));

    // Trading days with bar data
    // Look back 2x calendar days to ensure we capture enough trading days
    const calendarLookback = days * 2;
    const tradingDays = await query(`
      SELECT DISTINCT ts::date::text as d
      FROM price_bars_primary WHERE symbol='NQ'
        AND ts::date >= CURRENT_DATE - ($1 || ' days')::INTERVAL
        AND ts::date < CURRENT_DATE
        AND EXTRACT(hour FROM ts) BETWEEN 9 AND 10
      ORDER BY d DESC LIMIT $2
    `, [calendarLookback, days + 2]);

    const dayList = tradingDays.rows.map(r => r.d).reverse();
    const avgOrRow = await query(`SELECT ROUND(AVG(or_high-or_low)::numeric,1) as avg FROM acd_daily_log WHERE or_high IS NOT NULL AND trade_date >= CURRENT_DATE-35`);
    const avgOR = parseFloat(avgOrRow.rows[0]?.avg) || 85;
    const pivotRow = await query(`SELECT pivot_level FROM acd_monthly_pivot ORDER BY created_at DESC LIMIT 1`);
    const pivotLevel = pivotRow.rows[0] ? parseFloat(pivotRow.rows[0].pivot_level) : null;

    const results = [];

    for (let i = 1; i < dayList.length; i++) {
      const today = dayList[i];
      const priorDay = dayList[i - 1];

      // Prior day bars + IB
      const pb = await query(`
        SELECT MAX(high)::float as sh, MIN(low)::float as sl,
          (array_agg(close ORDER BY ts DESC))[1]::float as sc,
          MAX(high) FILTER (WHERE EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 630)::float as ib_high,
          MIN(low)  FILTER (WHERE EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 630)::float as ib_low
        FROM price_bars_primary WHERE symbol='NQ' AND ts::date=$1 AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
      `, [priorDay]);
      const p = pb.rows[0];
      if (!p?.sh) continue;

      // Prior day VA
      const vaR = await query(`
        WITH vp AS (SELECT ROUND(low/0.25)*0.25 as px, SUM(volume) as vol FROM price_bars_primary WHERE symbol='NQ' AND ts::date=$1 AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16 GROUP BY ROUND(low/0.25)*0.25),
        total AS (SELECT SUM(vol) as t FROM vp), poc_row AS (SELECT px FROM vp ORDER BY vol DESC LIMIT 1)
        SELECT p2.px::float as poc,
          (SELECT MAX(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px DESC) as cv FROM vp WHERE px >= p2.px) x WHERE cv <= (SELECT t*0.35 FROM total))::float as vah,
          (SELECT MIN(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px ASC) as cv FROM vp WHERE px <= p2.px) x WHERE cv <= (SELECT t*0.35 FROM total))::float as val
        FROM vp, poc_row p2 GROUP BY p2.px LIMIT 1
      `, [priorDay]);
      const va = vaR.rows[0];
      if (!va) continue;

      // Today's ACD + NL
      const acdR = await query(`SELECT or_high::float, or_low::float, daily_score, a_up_fired, a_down_fired, a_up_level::float, a_down_level::float FROM acd_daily_log WHERE trade_date=$1`, [today]);
      const acd = acdR.rows[0];
      if (!acd?.or_high) continue;
      const orMid = (acd.or_high + acd.or_low) / 2;
      const orRange = acd.or_high - acd.or_low;

      const nlR = await query(`SELECT COALESCE(SUM(daily_score),0) as nl30 FROM (SELECT daily_score FROM acd_daily_log WHERE trade_date < $1 ORDER BY trade_date DESC LIMIT 30) s`, [today]);
      const nl30 = parseInt(nlR.rows[0]?.nl30) || 0;
      const nlTrend = nl30 > 9 ? 'TRENDING_UP' : nl30 < -9 ? 'TRENDING_DOWN' : 'RANGING';

      // Today's session
      const sessR = await query(`
        SELECT MAX(high)::float as sh, MIN(low)::float as sl,
          (array_agg(close ORDER BY ts DESC))[1]::float as sc,
          (array_agg(open ORDER BY ts ASC))[1]::float as so
        FROM price_bars_primary WHERE symbol='NQ' AND ts::date=$1 AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
      `, [today]);
      const sess = sessR.rows[0];

      // Hourly bars for mini chart
      const barsR = await query(`
        SELECT to_char(date_trunc('hour',ts),'HH24:MI') as t,
          (array_agg(open ORDER BY ts))[1]::float as o,
          MAX(high)::float as h, MIN(low)::float as l,
          (array_agg(close ORDER BY ts DESC))[1]::float as c
        FROM price_bars_primary WHERE symbol='NQ' AND ts::date=$1
          AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
        GROUP BY date_trunc('hour',ts) ORDER BY 1
      `, [today]);

      // Classify prior day profile
      const ibRange = (p.ib_high||0) - (p.ib_low||0);
      const sessRange = p.sh - p.sl;
      const ext = ibRange > 0 ? sessRange / ibRange : 0;
      const closePct = sessRange > 0 ? (p.sc - p.sl) / sessRange : 0.5;
      const priorProfile = ext > 2.0 ? 'TREND'
        : ext > 1.5 ? 'NORMAL_VARIATION'
        : ext > 0.9 ? 'NORMAL'
        : (p.sh > (p.ib_high||0) && p.sl < (p.ib_low||0) && (closePct > 0.75 || closePct < 0.25)) ? 'RUNNING_PROFILE_NEUTRAL'
        : (p.sh > (p.ib_high||0) && p.sl < (p.ib_low||0)) ? 'NEUTRAL'
        : 'NONTREND';

      // Bias signals
      const inv = orMid > va.vah ? 'SHORT_TRAPPED' : orMid < va.val ? 'LONG_TRAPPED' : 'NEUTRAL';
      const valPos = orMid > va.vah ? 'ABOVE_VALUE' : orMid < va.val ? 'BELOW_VALUE' : 'INSIDE_VALUE';
      const orCond = orRange/avgOR < 0.5 ? 'NARROW' : orRange/avgOR < 1.5 ? 'NORMAL' : orRange/avgOR < 2.5 ? 'WIDE' : 'EMOTIONAL';

      const structureLong  = (inv==='SHORT_TRAPPED'&&valPos!=='BELOW_VALUE')||(inv==='NEUTRAL'&&valPos==='ABOVE_VALUE');
      const structureShort = (inv==='LONG_TRAPPED'&&valPos!=='ABOVE_VALUE')||(inv==='NEUTRAL'&&valPos==='BELOW_VALUE');
      const nlDir = nlTrend==='TRENDING_UP'?'up':nlTrend==='TRENDING_DOWN'?'down':'ranging';
      const conflict = (structureLong&&nlDir==='down')||(structureShort&&nlDir==='up');
      const biasDir = structureLong?'LONG':structureShort?'SHORT':'NEUTRAL';

      // Actual direction
      const ptsVsOpen = sess?.sc && sess?.so ? sess.sc - sess.so : null;
      // Use close-vs-open as primary truth (what price actually did), ACD score as tiebreaker
      const actualDir = ptsVsOpen > 15 ? 'BULLISH' : ptsVsOpen < -15 ? 'BEARISH'
        : acd.daily_score > 0 ? 'BULLISH' : acd.daily_score < 0 ? 'BEARISH'
        : ptsVsOpen > 0 ? 'BULLISH' : ptsVsOpen < 0 ? 'BEARISH' : 'NEUTRAL';
      const outcome = biasDir==='LONG'&&actualDir==='BULLISH'?'CORRECT'
        :biasDir==='SHORT'&&actualDir==='BEARISH'?'CORRECT'
        :biasDir==='LONG'&&actualDir==='BEARISH'?'WRONG'
        :biasDir==='SHORT'&&actualDir==='BULLISH'?'WRONG'
        :'NEUTRAL';

      results.push({
        date: today, priorDay,
        priorProfile, nlTrend, nl30,
        inv, valPos, orCond, biasDir, conflict, outcome,
        actualDir, acdScore: acd.daily_score,
        ptsVsOpen: ptsVsOpen ? Math.round(ptsVsOpen) : null,
        orHigh: acd.or_high, orLow: acd.or_low,
        aUpLevel: acd.a_up_level, aDownLevel: acd.a_down_level,
        aUpFired: acd.a_up_fired, aDownFired: acd.a_down_fired,
        priorVAH: va.vah, priorVAL: va.val, priorPOC: va.poc,
        sessionHigh: sess?.sh, sessionLow: sess?.sl, sessionClose: sess?.sc, sessionOpen: sess?.so,
        pivotBias: pivotLevel ? (sess?.so > pivotLevel ? 'ABOVE' : 'BELOW') : null,
        bars: barsR.rows,
      });
    }

    results.reverse();

    // Save new results to DB for persistence
    for (const r of results) {
      if (storedDates.has(r.date)) continue; // skip already stored
      try {
        await query(`
          INSERT INTO auction_history (date, prior_day, prior_profile, nl_trend, nl30, inv, val_pos, or_cond, bias_dir, conflict, outcome, actual_dir, acd_score, pts_vs_open, or_high, or_low, a_up_level, a_down_level, a_up_fired, a_down_fired, prior_vah, prior_val, prior_poc, session_high, session_low, session_close, session_open, pivot_bias, bars)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29)
          ON CONFLICT (date) DO NOTHING
        `, [r.date, r.priorDay, r.priorProfile, r.nlTrend, r.nl30, r.inv, r.valPos, r.orCond, r.biasDir, r.conflict, r.outcome, r.actualDir, r.acdScore, r.ptsVsOpen, r.orHigh, r.orLow, r.aUpLevel, r.aDownLevel, r.aUpFired, r.aDownFired, r.priorVAH, r.priorVAL, r.priorPOC, r.sessionHigh, r.sessionLow, r.sessionClose, r.sessionOpen, r.pivotBias, JSON.stringify(r.bars)]);

        // Persist engine reads to engine_reads for accuracy tracking
        // PREMARKET_BIAS read + outcome
        await query(`
          INSERT INTO engine_reads (trade_date, read_type, signal_value, nl30, or_cond, predicted_direction, outcome, pts_vs_open, outcome_detail, evaluated_at)
          VALUES ($1,'PREMARKET_BIAS',$2,$3,$4,$5,$6,$7,$8,NOW())
          ON CONFLICT (trade_date, read_type, signal_value) DO UPDATE SET
            outcome=EXCLUDED.outcome, pts_vs_open=EXCLUDED.pts_vs_open,
            outcome_detail=EXCLUDED.outcome_detail, evaluated_at=EXCLUDED.evaluated_at
        `, [r.date, r.biasDir || 'NEUTRAL', r.nl30, r.orCond,
            r.biasDir === 'LONG' ? 'LONG' : r.biasDir === 'SHORT' ? 'SHORT' : 'NEUTRAL',
            r.outcome, r.ptsVsOpen,
            `actual_dir:${r.actualDir} pts_vs_open:${r.ptsVsOpen}`]);

        // A_SIGNAL read + outcome (if fired)
        if (r.aUpFired || r.aDownFired) {
          const sigVal = r.aUpFired ? 'A_UP' : 'A_DOWN';
          const sigDir = r.aUpFired ? 'LONG' : 'SHORT';
          const sigOutcome = r.aUpFired
            ? (r.ptsVsOpen >  15 ? 'CORRECT' : r.ptsVsOpen < -15 ? 'WRONG' : 'NEUTRAL')
            : (r.ptsVsOpen < -15 ? 'CORRECT' : r.ptsVsOpen >  15 ? 'WRONG' : 'NEUTRAL');
          await query(`
            INSERT INTO engine_reads (trade_date, read_type, signal_value, session_bias_context, nl30, or_cond, predicted_direction, outcome, pts_vs_open, outcome_detail, evaluated_at)
            VALUES ($1,'A_SIGNAL',$2,$3,$4,$5,$6,$7,$8,$9,NOW())
            ON CONFLICT (trade_date, read_type, signal_value) DO UPDATE SET
              session_bias_context=EXCLUDED.session_bias_context,
              outcome=EXCLUDED.outcome, pts_vs_open=EXCLUDED.pts_vs_open,
              outcome_detail=EXCLUDED.outcome_detail, evaluated_at=EXCLUDED.evaluated_at
          `, [r.date, sigVal, r.biasDir, r.nl30, r.orCond, sigDir, sigOutcome, r.ptsVsOpen,
              `bias:${r.biasDir} actual_dir:${r.actualDir} pts_vs_open:${r.ptsVsOpen}`]);
        }
      } catch(e) { /* skip individual save errors */ }
    }

    cacheSet(cacheKey, results, 4 * 60 * 60 * 1000);
    res.json(results);
  } catch(e) { console.error(e); res.status(500).json({ error: e.message }); }
});

router.get('/auction-read/today', async (req, res) => {
  try {
    const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const r = await query('SELECT *, trade_date::text FROM auction_reads WHERE trade_date=$1', [todayET]);
    res.json(r.rows[0] || { trade_date: todayET });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/auction-read/today', async (req, res) => {
  try {
    const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const { overnight_inventory, open_vs_prior_value, prior_day_profile, or_condition, opening_call_type, a_signal_override, p3_value_migrating, p3_vwap_holding, p3_delta_confirming, p3_auction_accepted, p3_rotations_increasing } = req.body;
    const r = await query(`
      INSERT INTO auction_reads (trade_date, overnight_inventory, open_vs_prior_value, prior_day_profile, or_condition, opening_call_type, a_signal_override, p3_value_migrating, p3_vwap_holding, p3_delta_confirming, p3_auction_accepted, p3_rotations_increasing, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
      ON CONFLICT (trade_date) DO UPDATE SET
        overnight_inventory=COALESCE($2,auction_reads.overnight_inventory),
        open_vs_prior_value=COALESCE($3,auction_reads.open_vs_prior_value),
        prior_day_profile=COALESCE($4,auction_reads.prior_day_profile),
        or_condition=COALESCE($5,auction_reads.or_condition),
        opening_call_type=COALESCE($6,auction_reads.opening_call_type),
        a_signal_override=COALESCE($7,auction_reads.a_signal_override),
        p3_value_migrating=COALESCE($8,auction_reads.p3_value_migrating),
        p3_vwap_holding=COALESCE($9,auction_reads.p3_vwap_holding),
        p3_delta_confirming=COALESCE($10,auction_reads.p3_delta_confirming),
        p3_auction_accepted=COALESCE($11,auction_reads.p3_auction_accepted),
        p3_rotations_increasing=COALESCE($12,auction_reads.p3_rotations_increasing),
        updated_at=NOW(),
        p1_updated_at=CASE WHEN ($2 IS NOT NULL AND $2 IS DISTINCT FROM auction_reads.overnight_inventory) OR ($3 IS NOT NULL AND $3 IS DISTINCT FROM auction_reads.open_vs_prior_value) OR ($4 IS NOT NULL AND $4 IS DISTINCT FROM auction_reads.prior_day_profile) THEN NOW() ELSE auction_reads.p1_updated_at END,
        p2_updated_at=CASE WHEN ($5 IS NOT NULL AND $5 IS DISTINCT FROM auction_reads.or_condition) OR ($6 IS NOT NULL AND $6 IS DISTINCT FROM auction_reads.opening_call_type) OR ($7 IS NOT NULL AND $7 IS DISTINCT FROM auction_reads.a_signal_override) THEN NOW() ELSE auction_reads.p2_updated_at END,
        p3_updated_at=CASE WHEN ($8 IS NOT NULL AND $8 IS DISTINCT FROM auction_reads.p3_value_migrating) OR ($9 IS NOT NULL AND $9 IS DISTINCT FROM auction_reads.p3_vwap_holding) OR ($10 IS NOT NULL AND $10 IS DISTINCT FROM auction_reads.p3_delta_confirming) OR ($11 IS NOT NULL AND $11 IS DISTINCT FROM auction_reads.p3_auction_accepted) OR ($12 IS NOT NULL AND $12 IS DISTINCT FROM auction_reads.p3_rotations_increasing) THEN NOW() ELSE auction_reads.p3_updated_at END,
        ts_overnight_inventory=CASE WHEN $2 IS NOT NULL AND $2 IS DISTINCT FROM auction_reads.overnight_inventory THEN NOW() ELSE auction_reads.ts_overnight_inventory END,
        ts_open_vs_prior_value=CASE WHEN $3 IS NOT NULL AND $3 IS DISTINCT FROM auction_reads.open_vs_prior_value THEN NOW() ELSE auction_reads.ts_open_vs_prior_value END,
        ts_prior_day_profile=CASE WHEN $4 IS NOT NULL AND $4 IS DISTINCT FROM auction_reads.prior_day_profile THEN NOW() ELSE auction_reads.ts_prior_day_profile END,
        ts_or_condition=CASE WHEN $5 IS NOT NULL AND $5 IS DISTINCT FROM auction_reads.or_condition THEN NOW() ELSE auction_reads.ts_or_condition END,
        ts_opening_call_type=CASE WHEN $6 IS NOT NULL AND $6 IS DISTINCT FROM auction_reads.opening_call_type THEN NOW() ELSE auction_reads.ts_opening_call_type END,
        ts_a_signal_override=CASE WHEN $7 IS NOT NULL AND $7 IS DISTINCT FROM auction_reads.a_signal_override THEN NOW() ELSE auction_reads.ts_a_signal_override END,
        ts_p3_value_migrating=CASE WHEN $8 IS NOT NULL AND $8 IS DISTINCT FROM auction_reads.p3_value_migrating THEN NOW() ELSE auction_reads.ts_p3_value_migrating END,
        ts_p3_vwap_holding=CASE WHEN $9 IS NOT NULL AND $9 IS DISTINCT FROM auction_reads.p3_vwap_holding THEN NOW() ELSE auction_reads.ts_p3_vwap_holding END,
        ts_p3_delta_confirming=CASE WHEN $10 IS NOT NULL AND $10 IS DISTINCT FROM auction_reads.p3_delta_confirming THEN NOW() ELSE auction_reads.ts_p3_delta_confirming END,
        ts_p3_auction_accepted=CASE WHEN $11 IS NOT NULL AND $11 IS DISTINCT FROM auction_reads.p3_auction_accepted THEN NOW() ELSE auction_reads.ts_p3_auction_accepted END,
        ts_p3_rotations_increasing=CASE WHEN $12 IS NOT NULL AND $12 IS DISTINCT FROM auction_reads.p3_rotations_increasing THEN NOW() ELSE auction_reads.ts_p3_rotations_increasing END
      RETURNING *, trade_date::text
    `, [todayET, overnight_inventory, open_vs_prior_value, prior_day_profile, or_condition, opening_call_type, a_signal_override, p3_value_migrating, p3_vwap_holding, p3_delta_confirming, p3_auction_accepted, p3_rotations_increasing]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/auction-read/midday — 1:45 PM mid-session snapshot
router.get('/auction-read/midday', async (req, res) => {
  try {
    const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const nowET   = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const etMin   = nowET.getHours() * 60 + nowET.getMinutes();

    // ACD levels
    const acd = await query(`SELECT or_high::float, or_low::float, a_up_level::float, a_down_level::float, a_up_fired, a_down_fired FROM acd_daily_log WHERE trade_date=$1`, [todayET]);
    const acdRow = acd.rows[0];
    if (!acdRow) return res.json({ available: false, reason: 'No ACD data for today' });

    // Session bars up to now (or up to 13:45 if called later)
    const cutoffMin = Math.min(etMin, 13 * 60 + 45);
    const bars = await query(`
      SELECT high::float, low::float, close::float, open::float, volume::bigint,
             EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) as bm,
             to_char(ts,'HH24:MI') as t
      FROM price_bars_primary WHERE symbol='NQ' AND ts::date=$1
        AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND $2
      ORDER BY ts
    `, [todayET, cutoffMin]);
    if (!bars.rows.length) return res.json({ available: false, reason: 'No bar data yet' });

    const b = bars.rows;
    const sessOpen  = b[0].open;
    const sessClose = b[b.length-1].close; // price at cutoff
    const sessHigh  = Math.max(...b.map(r => r.high));
    const sessLow   = Math.min(...b.map(r => r.low));
    const ptsVsOpen = Math.round((sessClose - sessOpen) * 100) / 100;
    const dir = ptsVsOpen > 10 ? 'BULLISH' : ptsVsOpen < -10 ? 'BEARISH' : 'NEUTRAL';

    // Avg range
    const avgQ = await query(`SELECT AVG(daily_range)::float as avg FROM (SELECT MAX(high)-MIN(low) as daily_range FROM price_bars_primary WHERE symbol='NQ' AND ts::date < $1 AND ts::date >= ($1::text)::date - INTERVAL '30 days' AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16 GROUP BY ts::date) s`, [todayET]);
    const avgRange = avgQ.rows[0]?.avg || 150;
    const sessRange = sessHigh - sessLow;
    const rangeVsAvg = sessRange / avgRange;

    // VWAP
    const totalVol = b.reduce((s, r) => s + (Number(r.volume)||1), 0);
    const vwap = Math.round(b.reduce((s, r) => s + r.close * (Number(r.volume)||1), 0) / totalVol);

    // Morning read
    const ar = await query(`SELECT overnight_inventory, open_vs_prior_value, prior_day_profile, p3_value_migrating, p3_vwap_holding, p3_delta_confirming, p3_auction_accepted, p3_rotations_increasing FROM auction_reads WHERE trade_date=$1`, [todayET]);
    const read = ar.rows[0] || {};
    const inv = read.overnight_inventory, val = read.open_vs_prior_value;
    const strLong  = (inv==='SHORT_TRAPPED'&&val!=='BELOW_VALUE')||(inv==='NEUTRAL'&&val==='ABOVE_VALUE');
    const strShort = (inv==='LONG_TRAPPED'&&val!=='ABOVE_VALUE')||(inv==='NEUTRAL'&&val==='BELOW_VALUE');
    // Pre-market structural bias (from overnight inventory + open vs prior value — set before 9:30)
    const preMktBias = strLong ? 'LONG' : strShort ? 'SHORT' : 'NEUTRAL';
    // Session signal (A signal fired during the session — overrides structural read for direction)
    const sessionSignal = acdRow.a_up_fired ? 'LONG' : acdRow.a_down_fired ? 'SHORT' : null;
    // Effective bias: A signal takes priority when it fires; otherwise use pre-market read
    const mornBias = sessionSignal || preMktBias;
    const biasPlaying  = (mornBias==='LONG'&&dir==='BULLISH') || (mornBias==='SHORT'&&dir==='BEARISH');
    const biasReversed = (mornBias==='LONG'&&dir==='BEARISH') || (mornBias==='SHORT'&&dir==='BULLISH');

    // G-Line and PW levels
    const gLine = await getGLine(todayET);
    const pwQ = await query(`SELECT MAX(high)::float as pwh, MIN(low)::float as pwl FROM price_bars_primary WHERE symbol='NQ' AND ts::date>=date_trunc('week',($1::text)::date)-INTERVAL '7 days' AND ts::date<date_trunc('week',($1::text)::date) AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16`, [todayET]);
    const pwHigh = pwQ.rows[0]?.pwh, pwLow = pwQ.rows[0]?.pwl;

    // P3 score — compute from bar data (same as live endpoint) so it's never 0 due to DB nulls
    const orH2 = acdRow.or_high, orL2 = acdRow.or_low;
    const tvol = b.reduce((s,r)=>s+(Number(r.volume)||1),0);
    const vwapFull = b.reduce((s,r)=>s+r.close*(Number(r.volume)||1),0)/tvol;
    const split2 = Math.max(1, b.length - 20);
    const earlyV = b.slice(0,split2).reduce((s,r)=>s+(Number(r.volume)||1),0);
    const earlyVwap2 = b.slice(0,split2).reduce((s,r)=>s+r.close*(Number(r.volume)||1),0)/earlyV;
    const biasForP3 = mornBias;
    const p3_vwap_holding2 = biasForP3==='LONG' ? sessClose>vwapFull : biasForP3==='SHORT' ? sessClose<vwapFull : false;
    const p3_value_migrating2 = biasForP3==='LONG' ? vwapFull>earlyVwap2 : biasForP3==='SHORT' ? vwapFull<earlyVwap2 : false;
    const last10b = b.slice(-10);
    const avgCP = last10b.reduce((s,r)=>{const rng=r.high-r.low; return s+(rng>0?(r.close-r.low)/rng:0.5);},0)/last10b.length;
    const p3_delta_confirming2 = biasForP3==='LONG' ? avgCP>0.55 : biasForP3==='SHORT' ? avgCP<0.45 : false;
    const last20b = b.slice(-20);
    const acceptCt = last20b.filter(r=>biasForP3==='LONG'?r.close>orH2:biasForP3==='SHORT'?r.close<orL2:false).length;
    const p3_auction_accepted2 = last20b.length>0 && acceptCt/last20b.length>=0.4;
    const last16b = b.slice(-16);
    let p3_rotations_increasing2 = false;
    if (last16b.length>=8){const h=Math.floor(last16b.length/2); const r1=Math.max(...last16b.slice(0,h).map(r=>r.high))-Math.min(...last16b.slice(0,h).map(r=>r.low)); const r2=Math.max(...last16b.slice(h).map(r=>r.high))-Math.min(...last16b.slice(h).map(r=>r.low)); p3_rotations_increasing2=r2>r1*1.15;}
    // Prefer manually saved values from DB if set, fall back to computed
    const p3_vm = read.p3_value_migrating ?? p3_value_migrating2;
    const p3_vh = read.p3_vwap_holding ?? p3_vwap_holding2;
    const p3_dc = read.p3_delta_confirming ?? p3_delta_confirming2;
    const p3_aa = read.p3_auction_accepted ?? p3_auction_accepted2;
    const p3_ri = read.p3_rotations_increasing ?? p3_rotations_increasing2;
    const p3Score = [p3_vm, p3_vh, p3_dc, p3_aa, p3_ri].filter(Boolean).length;
    const p3Source = read.p3_updated_at ? 'manual' : 'auto-computed';

    // Afternoon context: what's the session shaping up to be?
    const morningBars  = b.filter(r => r.bm < 12*60);
    const afternoonBars = b.filter(r => r.bm >= 12*60);
    const morningRange = morningBars.length ? Math.max(...morningBars.map(r=>r.high)) - Math.min(...morningBars.map(r=>r.low)) : 0;
    const pmOpen = afternoonBars.length ? afternoonBars[0].open : sessClose;
    const pmClose = afternoonBars.length ? afternoonBars[afternoonBars.length-1].close : sessClose;

    // Day type developing
    let dayTypeDeveloping;
    if (rangeVsAvg > 1.5 && Math.abs(ptsVsOpen) > avgRange * 0.4) {
      dayTypeDeveloping = 'TREND DAY developing — one-sided move, high range vs avg. Go with direction, do not fade.';
    } else if (rangeVsAvg < 0.6) {
      dayTypeDeveloping = 'BALANCE DAY developing — narrow range vs avg. Responsive strategy, fade extremes. Low follow-through on breakouts.';
    } else if (morningRange > avgRange * 0.8 && afternoonBars.length > 5 && Math.abs(pmClose - pmOpen) < morningRange * 0.3) {
      dayTypeDeveloping = 'NORMAL day — large morning range, afternoon consolidating. Value has been established. Watch for late directional break or rotation back to morning POC.';
    } else {
      dayTypeDeveloping = 'NORMAL VARIATION developing — meaningful range, some directional follow-through. Standard intraday playbook.';
    }

    // What to watch into close
    const watches = [];
    if (gLine) {
      const aboveGLine = sessClose > gLine;
      if (aboveGLine) watches.push(`G-Line (${Math.round(gLine)}) is support — holding above keeps week positive. Watch for a test and hold or break into close.`);
      else watches.push(`G-Line (${Math.round(gLine)}) is resistance — below keeps week negative. Reclaim above = bullish close; failure = continued weekly weakness.`);
    }
    if (acdRow.a_up_fired) watches.push(`A Up confirmed — OR High (${Math.round(acdRow.or_high)}) is now support. Hold above into close = strong continuation signal.`);
    else if (acdRow.a_down_fired) watches.push(`A Down confirmed — OR Low (${Math.round(acdRow.or_low)}) is now resistance. Hold below into close = strong continuation signal.`);
    else watches.push(`No A signal fired — this is a no-signal day. Watch for late-session initiative or range expansion after 2 PM. Without an A signal the close vs OR mid (${Math.round((acdRow.or_high+acdRow.or_low)/2)}) determines the day's bias.`);
    if (p3Score <= 1 && mornBias !== 'NEUTRAL') watches.push(`P3 score ${p3Score}/5 (${p3Source}) — in-session monitor says the ${mornBias} bias is not being confirmed structurally. Caution on afternoon ${mornBias} positions.`);
    else if (p3Score >= 4 && mornBias !== 'NEUTRAL') watches.push(`P3 score ${p3Score}/5 (${p3Source}) — strong structural confirmation of ${mornBias} bias. Structure supports holding ${mornBias} positions into the close.`);
    if (biasReversed) watches.push(`Morning bias (${mornBias}) is NOT playing out — price has moved ${Math.abs(ptsVsOpen).toFixed(0)}pts against it. This is not a reason to reverse — it is a reason to stand aside until a new structural read confirms.`);

    const snap = {
      available: true,
      generatedAt: new Date().toISOString(),
      cutoffTime: `${Math.floor(cutoffMin/60)}:${String(cutoffMin%60).padStart(2,'0')}`,
      preMktBias, sessionSignal, mornBias, biasPlaying, biasReversed,
      sessOpen: Math.round(sessOpen), sessHigh: Math.round(sessHigh), sessLow: Math.round(sessLow),
      currentPrice: Math.round(sessClose), ptsVsOpen, dir,
      sessRange: Math.round(sessRange), rangeVsAvg: Math.round(rangeVsAvg * 100),
      vwap, gLine: gLine ? Math.round(gLine) : null, pwHigh: pwHigh ? Math.round(pwHigh) : null, pwLow: pwLow ? Math.round(pwLow) : null,
      orHigh: Math.round(acdRow.or_high), orLow: Math.round(acdRow.or_low),
      aUpFired: !!acdRow.a_up_fired, aDownFired: !!acdRow.a_down_fired,
      ibHighBroken: sessHigh > acdRow.or_high, ibLowBroken: sessLow < acdRow.or_low,
      p3Score, p3Source, dayTypeDeveloping, watches,
    };
    res.json(snap);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/auction-read/eod — end-of-day debrief for a given date
router.get('/auction-read/eod', async (req, res) => {
  try {
    const dateET = req.query.date || new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

    // Morning read
    const ar = await query(`SELECT * FROM auction_reads WHERE trade_date=$1`, [dateET]);
    const read = ar.rows[0] || {};

    // ACD levels + signals
    const acd = await query(`SELECT or_high::float, or_low::float, a_up_level::float, a_down_level::float, a_up_fired, a_down_fired, or_high::float - or_low::float as or_range FROM acd_daily_log WHERE trade_date=$1`, [dateET]);
    const acdRow = acd.rows[0];
    if (!acdRow) return res.json({ available: false, reason: 'No ACD data for this date' });

    // Full RTH session bars
    const barsQ = await query(`
      SELECT high::float, low::float, close::float, open::float, volume::bigint,
             EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) as bm,
             to_char(ts,'HH24:MI') as t
      FROM price_bars_primary WHERE symbol='NQ' AND ts::date=$1
        AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
      ORDER BY ts
    `, [dateET]);
    const bars = barsQ.rows;
    if (!bars.length) return res.json({ available: false, reason: 'No bar data for this date' });

    // Session stats
    const sessOpen  = bars[0]?.open;
    const sessClose = bars[bars.length-1]?.close;
    const sessHigh  = Math.max(...bars.map(b => b.high));
    const sessLow   = Math.min(...bars.map(b => b.low));
    const sessRange = sessHigh - sessLow;
    const ptsVsOpen = Math.round((sessClose - sessOpen) * 100) / 100;
    const actualDir = ptsVsOpen > 15 ? 'BULLISH' : ptsVsOpen < -15 ? 'BEARISH' : 'NEUTRAL';

    // Avg range (30-day)
    const avgQ = await query(`SELECT AVG(daily_range)::float as avg FROM (SELECT MAX(high)-MIN(low) as daily_range FROM price_bars_primary WHERE symbol='NQ' AND ts::date < $1 AND ts::date >= ($1::text)::date - INTERVAL '30 days' AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16 GROUP BY ts::date) sub`, [dateET]);
    const avgRange = avgQ.rows.length ? avgQ.rows.reduce((s,r)=>s+r.avg,0)/avgQ.rows.length : 150;
    const rangeVsAvg = sessRange / avgRange;

    // Prior week levels
    const pwQ = await query(`SELECT MAX(high)::float as pw_high, MIN(low)::float as pw_low FROM price_bars_primary WHERE symbol='NQ' AND ts::date >= date_trunc('week',($1::text)::date) - INTERVAL '7 days' AND ts::date < date_trunc('week',($1::text)::date) AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16`, [dateET]);
    const pwHigh = pwQ.rows[0]?.pw_high;
    const pwLow  = pwQ.rows[0]?.pw_low;

    // G-Line (weekly open)
    const gLine = await getGLine(dateET);

    // VWAP
    const totalVol = bars.reduce((s,b)=>s+(Number(b.volume)||1),0);
    const vwap = bars.reduce((s,b)=>s+b.close*(Number(b.volume)||1),0)/totalVol;

    // Bias
    const inv  = read.overnight_inventory;
    const val  = read.open_vs_prior_value;
    const strLong  = (inv==='SHORT_TRAPPED'&&val!=='BELOW_VALUE')||(inv==='NEUTRAL'&&val==='ABOVE_VALUE');
    const strShort = (inv==='LONG_TRAPPED'&&val!=='ABOVE_VALUE')||(inv==='NEUTRAL'&&val==='BELOW_VALUE');
    const mornBias = acdRow.a_up_fired ? 'LONG' : acdRow.a_down_fired ? 'SHORT' : strLong ? 'LONG' : strShort ? 'SHORT' : 'NEUTRAL';
    const biasCorrect = (mornBias==='LONG'&&actualDir==='BULLISH')||(mornBias==='SHORT'&&actualDir==='BEARISH');
    const biasWrong   = (mornBias==='LONG'&&actualDir==='BEARISH')||(mornBias==='SHORT'&&actualDir==='BULLISH');

    // Pattern detection
    const patterns = [];

    // V-reversal: big drop then recovery (or vice versa)
    const firstHalfBars = bars.filter(b => b.bm < 12*60);
    const secondHalfBars = bars.filter(b => b.bm >= 12*60);
    const firstHalfLow  = firstHalfBars.length ? Math.min(...firstHalfBars.map(b=>b.low)) : sessLow;
    const firstHalfHigh = firstHalfBars.length ? Math.max(...firstHalfBars.map(b=>b.high)) : sessHigh;
    const dropFromOpen  = sessOpen - firstHalfLow;
    const riseFromLow   = sessClose - sessLow;
    const dropToHigh    = firstHalfHigh - sessOpen;
    const fallFromHigh  = sessHigh - sessClose;
    if (dropFromOpen > avgRange * 0.4 && riseFromLow > dropFromOpen * 0.6) {
      patterns.push({ type: 'V_REVERSAL_UP', label: 'Bullish V-Reversal', detail: `Price sold off ${dropFromOpen.toFixed(0)}pts from the open, then recovered ${riseFromLow.toFixed(0)}pts — a classic spring/trap. The initial breakdown attracted sellers who were squeezed.` });
    } else if (dropToHigh > avgRange * 0.4 && fallFromHigh > dropToHigh * 0.6) {
      patterns.push({ type: 'V_REVERSAL_DOWN', label: 'Bearish V-Reversal', detail: `Price rallied ${dropToHigh.toFixed(0)}pts from the open then collapsed ${fallFromHigh.toFixed(0)}pts — buyers absorbed then reversed.` });
    }

    // Trend day
    if (rangeVsAvg > 1.8 && Math.abs(ptsVsOpen) > avgRange * 0.5) {
      patterns.push({ type: 'TREND_DAY', label: 'Trend Day', detail: `Session range ${sessRange.toFixed(0)}pts (${(rangeVsAvg*100).toFixed(0)}% of avg). Price closed ${ptsVsOpen > 0 ? '+' : ''}${ptsVsOpen}pts from open — one-sided directional day with limited pullbacks.` });
    }

    // Balance/rotation day
    if (rangeVsAvg < 0.7) {
      patterns.push({ type: 'BALANCE_DAY', label: 'Balance/Rotation Day', detail: `Session range ${sessRange.toFixed(0)}pts (only ${(rangeVsAvg*100).toFixed(0)}% of avg). Price rotated inside a tight range — neither side committed. Low-conviction day.` });
    }

    // Failed A signal — absorption (multiple fails before fire or no fire)
    const aUpFailed = !acdRow.a_up_fired && sessHigh >= acdRow.a_up_level;
    const aDownFailed = !acdRow.a_down_fired && sessLow <= acdRow.a_down_level;
    if (aUpFailed) patterns.push({ type: 'FAILED_A_UP', label: 'Failed A Up (Absorption)', detail: `Price reached the A Up level (${acdRow.a_up_level?.toFixed(0)}) but couldn't sustain above OR High. Bulls showed up and were absorbed. This failure was itself the signal.` });
    if (aDownFailed) patterns.push({ type: 'FAILED_A_DOWN', label: 'Failed A Down (Absorption)', detail: `Price reached the A Down level (${acdRow.a_down_level?.toFixed(0)}) but couldn't sustain below OR Low. Bears showed up and were absorbed. Classic spring setup.` });

    // News-driven open (8:30 spike bar)
    const earlyBars = bars.filter(b => b.bm >= 8*60 && b.bm <= 9*60);
    const maxEarlyRange = earlyBars.length ? Math.max(...earlyBars.map(b=>b.high-b.low)) : 0;
    if (maxEarlyRange > avgRange * 0.3) {
      const newsBar = earlyBars.find(b=>(b.high-b.low)===maxEarlyRange);
      patterns.push({ type: 'NEWS_DRIVEN', label: 'News-Driven Open (8:30)', detail: `A ${maxEarlyRange.toFixed(0)}-point bar fired at ${newsBar?.t} ET — characteristic 8:30 economic data spike. These bars often set the day's extremes. Initial reaction direction: ${newsBar && newsBar.close < newsBar.open ? 'DOWN' : 'UP'}.` });
    }

    // G-Line behavior
    const gLost = gLine && sessLow < gLine;
    const gReclaimed = gLost && sessClose > gLine;
    const gNeverLost = gLine && sessLow >= gLine;
    let gNote = null;
    if (gReclaimed) gNote = `G-Line (${gLine?.toFixed(0)}) was lost intraday but reclaimed by close — weekly structure turned negative then recovered. Indecisive week so far.`;
    else if (gLost) gNote = `G-Line (${gLine?.toFixed(0)}) was lost and not reclaimed — week closed negative. Bearish weekly structure heading into tomorrow.`;
    else if (gNeverLost) gNote = `G-Line (${gLine?.toFixed(0)}) held all day — weekly structure remained bullish throughout.`;

    // PW level interaction
    let pwNote = null;
    if (pwHigh && sessHigh >= pwHigh && sessClose < pwHigh) pwNote = `Prior week high (${pwHigh?.toFixed(0)}) was tested but rejected — failed breakout above last week's range. Watch for continuation short or re-test.`;
    else if (pwHigh && sessClose > pwHigh) pwNote = `Price closed above the prior week high (${pwHigh?.toFixed(0)}) — new weekly acceptance. Structurally bullish carry into next session.`;
    else if (pwLow && sessLow <= pwLow && sessClose > pwLow) pwNote = `Prior week low (${pwLow?.toFixed(0)}) was tested but held — successful test of weekly support. Spring-like structure.`;

    // P3 score — compute from full day bars if DB values are null
    const allBars = bars;
    const eodTVol = allBars.reduce((s,r)=>s+(Number(r.volume)||1),0);
    const eodVwap = allBars.reduce((s,r)=>s+r.close*(Number(r.volume)||1),0)/eodTVol;
    const eodSplit = Math.max(1, allBars.length-20);
    const eodEarlyV = allBars.slice(0,eodSplit).reduce((s,r)=>s+(Number(r.volume)||1),0);
    const eodEarlyVwap = allBars.slice(0,eodSplit).reduce((s,r)=>s+r.close*(Number(r.volume)||1),0)/eodEarlyV;
    const eodBiasForP3 = biasCorrect ? (actualDir==='BULLISH'?'LONG':'SHORT') : mornBias;
    const eodP3vm = read.p3_value_migrating ?? (eodBiasForP3==='LONG'?eodVwap>eodEarlyVwap:eodBiasForP3==='SHORT'?eodVwap<eodEarlyVwap:false);
    const eodP3vh = read.p3_vwap_holding ?? (eodBiasForP3==='LONG'?sessClose>eodVwap:eodBiasForP3==='SHORT'?sessClose<eodVwap:false);
    const eodLast10 = allBars.slice(-10);
    const eodAvgCP = eodLast10.reduce((s,r)=>{const rng=r.high-r.low; return s+(rng>0?(r.close-r.low)/rng:0.5);},0)/eodLast10.length;
    const eodP3dc = read.p3_delta_confirming ?? (eodBiasForP3==='LONG'?eodAvgCP>0.55:eodBiasForP3==='SHORT'?eodAvgCP<0.45:false);
    const eodLast20 = allBars.slice(-20);
    const eodAcc = eodLast20.filter(r=>eodBiasForP3==='LONG'?r.close>parseFloat(acdRow.or_high):eodBiasForP3==='SHORT'?r.close<parseFloat(acdRow.or_low):false).length;
    const eodP3aa = read.p3_auction_accepted ?? (eodLast20.length>0&&eodAcc/eodLast20.length>=0.4);
    const eodLast16 = allBars.slice(-16); let eodP3ri = read.p3_rotations_increasing ?? false;
    if (!read.p3_rotations_increasing && eodLast16.length>=8){const h=Math.floor(eodLast16.length/2); const r1=Math.max(...eodLast16.slice(0,h).map(r=>r.high))-Math.min(...eodLast16.slice(0,h).map(r=>r.low)); const r2=Math.max(...eodLast16.slice(h).map(r=>r.high))-Math.min(...eodLast16.slice(h).map(r=>r.low)); eodP3ri=r2>r1*1.15;}
    const p3Score = [eodP3vm,eodP3vh,eodP3dc,eodP3aa,eodP3ri].filter(Boolean).length;
    const p3Source = read.p3_updated_at ? 'manual' : 'auto-computed';

    // Longterm structural context at time of session
    const acdHistQ = await query(`
      SELECT SUM(daily_score) as nl30,
             SUM(CASE WHEN trade_date >= ($1::text)::date - INTERVAL '10 days' THEN daily_score ELSE 0 END) as nl10
      FROM acd_daily_log WHERE trade_date < ($1::text)::date AND trade_date >= ($1::text)::date - INTERVAL '30 days'
    `, [dateET]);
    const ltNL30 = acdHistQ.rows[0]?.nl30 || 0;
    const ltNL10 = acdHistQ.rows[0]?.nl10 || 0;
    const ltNL30trend = ltNL30 > 9 ? 'confirmed uptrend' : ltNL30 < -9 ? 'confirmed downtrend' : 'ranging (no directional edge)';

    // VA migration direction: last 5 days before this session
    const vaHist5Q = await query(`
      WITH days AS (
        SELECT DISTINCT ts::date::text as d FROM price_bars_primary WHERE symbol='NQ'
          AND ts::date < ($1::text)::date AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
        ORDER BY d DESC LIMIT 5
      )
      SELECT d, (SELECT ROUND((array_agg(close ORDER BY ts DESC))[1]/0.25)*0.25 FROM price_bars_primary WHERE symbol='NQ' AND ts::date::text=days.d AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16) as close
      FROM days ORDER BY d ASC
    `, [dateET]);
    const vaClosing = vaHist5Q.rows.map(r => parseFloat(r.close)).filter(Boolean);
    const ltValMigration = vaClosing.length >= 3
      ? (vaClosing[vaClosing.length-1] > vaClosing[0] ? 'migrating higher' : vaClosing[vaClosing.length-1] < vaClosing[0] ? 'migrating lower' : 'overlapping')
      : null;

    // Bracket state from VA overlap over last 10 days
    const vaOverlapQ = await query(`
      SELECT COUNT(*) as overlap_days FROM (
        SELECT d1.d, d2.d as prev,
          LEAST(d1.vah, d2.vah) - GREATEST(d1.val, d2.val) as overlap
        FROM (
          SELECT ts::date::text as d, MAX(high)::float as vah, MIN(low)::float as val
          FROM price_bars_primary WHERE symbol='NQ' AND ts::date < ($1::text)::date
            AND ts::date >= ($1::text)::date - INTERVAL '14 days'
            AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
          GROUP BY ts::date
        ) d1 JOIN (
          SELECT ts::date::text as d, MAX(high)::float as vah, MIN(low)::float as val
          FROM price_bars_primary WHERE symbol='NQ' AND ts::date < ($1::text)::date
            AND ts::date >= ($1::text)::date - INTERVAL '15 days'
            AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
          GROUP BY ts::date
        ) d2 ON d2.d < d1.d
        ORDER BY d1.d DESC LIMIT 9
      ) t WHERE overlap > 0
    `, [dateET]);
    const ltOverlaps = parseInt(vaOverlapQ.rows[0]?.overlap_days) || 0;
    const ltBracket = ltOverlaps >= 7 ? 'BRACKET (high confidence)' : ltOverlaps >= 5 ? 'BRACKET (moderate)' : ltValMigration === 'migrating higher' ? 'TRENDING UP' : ltValMigration === 'migrating lower' ? 'TRENDING DOWN' : 'TRANSITIONAL';

    // Deep narrative generation
    const p = v => v?.toFixed ? v.toFixed(0) : v || '—';
    const invLabels = { SHORT_TRAPPED: 'short sellers trapped above value', LONG_TRAPPED: 'long buyers trapped below value', NEUTRAL: 'neither side trapped — no forced activity expected' };
    const valLabels = { ABOVE_VALUE: 'above prior value area', INSIDE_VALUE: 'inside prior value area', BELOW_VALUE: 'below prior value area' };
    const profileLabels = { TREND: 'Trend day (inefficient — go with range extensions)', NORMAL_VARIATION: 'Normal Variation (go with extensions but expect two-sided rotations)', NORMAL: 'Normal (two-sided, responsive strategies)', NEUTRAL: 'Neutral (balance — fade the extremes)', RUNNING_PROFILE_NEUTRAL: 'Running Neutral (two-sided but closed near an extreme)', NONTREND: 'Nontrend (very efficient — fade everything)' };

    // Pre-market read narrative
    const preNarrative = [];
    if (inv && val) {
      preNarrative.push(`Overnight inventory was ${invLabels[inv] || inv.replace(/_/g,' ')}. Price opened ${valLabels[val] || val.replace(/_/g,' ')}.`);
    }
    if (read.prior_day_profile) {
      const isPriorInefficient = ['TREND','NORMAL_VARIATION'].includes(read.prior_day_profile);
      preNarrative.push(`Prior day classified as ${profileLabels[read.prior_day_profile] || read.prior_day_profile}. Playbook: ${isPriorInefficient ? 'initiative — go with range extensions, do not fade' : 'responsive — fade extremes, buy VAL sell VAH'}.`);
    }
    if (acdRow.or_high && acdRow.or_low) {
      const orRng = (acdRow.or_high - acdRow.or_low).toFixed(0);
      const orVsAvg = avgRange > 0 ? ((acdRow.or_high - acdRow.or_low) / avgRange * 100).toFixed(0) : null;
      preNarrative.push(`OR was ${p(acdRow.or_high)} / ${p(acdRow.or_low)} (${orRng}pts${orVsAvg ? ', ' + orVsAvg + '% of avg' : ''}).`);
    }
    // What the combined read implied
    if (mornBias !== 'NEUTRAL') {
      const conflicted = (inv === 'NEUTRAL' || val === 'INSIDE_VALUE');
      preNarrative.push(`Combined structural read: ${mornBias} bias${conflicted ? ', though with limited structural edge (neutral/inside value position means neither side has forced activity advantage)' : ' with clear structural support'}.`);
    } else {
      preNarrative.push(`Combined structural read: NEUTRAL — overlapping conditions made a directional bias difficult to establish pre-market. Two-sided strategy was appropriate.`);
    }

    // Longer-term structural context
    const ltNL30desc = ltNL30 > 9 ? `NL30 at +${ltNL30} — 30-session uptrend confirmed` : ltNL30 < -9 ? `NL30 at ${ltNL30} — 30-session downtrend confirmed` : `NL30 at ${ltNL30 > 0 ? '+' : ''}${ltNL30} — ranging, no multi-session directional edge`;
    const ltNLalign = (mornBias === 'LONG' && ltNL30 > 9) || (mornBias === 'SHORT' && ltNL30 < -9);
    const ltNLconflict = (mornBias === 'LONG' && ltNL30 < -9) || (mornBias === 'SHORT' && ltNL30 > 9);
    const ltBracketNote = ltBracket.startsWith('TRENDING') ? `market structure was ${ltBracket} — initiative playbook supported intraday signals in the trend direction` : ltBracket.startsWith('BRACKET') ? `market structure was in BRACKET — responsive playbook, range extension signals carry higher failure risk in this environment` : `market structure was TRANSITIONAL — reduced reliability for directional setups`;
    const ltValNote = ltValMigration ? `value was ${ltValMigration} over the prior 5 sessions` : null;

    let ltLine = `Longer-term context: ${ltNL30desc}. ${ltBracketNote}.`;
    if (ltValNote) ltLine += ` ${ltValNote.charAt(0).toUpperCase() + ltValNote.slice(1)}.`;
    if (ltNLalign && mornBias !== 'NEUTRAL') ltLine += ` The 30-session NL trend aligned with today's ${mornBias} structural bias — multi-timeframe confluence.`;
    else if (ltNLconflict && mornBias !== 'NEUTRAL') ltLine += ` Note: the 30-session NL was working against today's ${mornBias} structural bias — counter-trend setup, lower conviction.`;
    preNarrative.push(ltLine);

    // Session narrative — what actually happened
    const sessionNarrative = [];
    if (acdRow.a_up_fired) {
      sessionNarrative.push(`A Up signal confirmed (OR High ${p(acdRow.or_high)}). Price sustained above OR High for 5 minutes — buyers took structural control of the session. This converted the pre-market LONG bias into an active long entry signal.`);
    } else if (acdRow.a_down_fired) {
      sessionNarrative.push(`A Down signal confirmed (OR Low ${p(acdRow.or_low)}). Price sustained below OR Low for 5 minutes — sellers took structural control. This converted the pre-market SHORT bias into an active short entry signal.`);
    } else {
      sessionNarrative.push(`No A signal fired — neither side held beyond their A level for 5 minutes. This is a no-signal day. ${mornBias !== 'NEUTRAL' ? `The pre-market ${mornBias} bias was not confirmed by the ACD framework.` : 'Consistent with the neutral pre-market read.'}`);
    }
    // Range character
    if (rangeVsAvg > 1.5) {
      sessionNarrative.push(`Session range was ${Math.round(sessRange)}pts — ${Math.round(rangeVsAvg * 100)}% of the 30-day average. This was a large-range day, characteristic of OTF (other timeframe) participation. The prior day's TREND classification set up the expectation for above-average range, and it delivered.`);
    } else if (rangeVsAvg < 0.7) {
      sessionNarrative.push(`Session range was ${Math.round(sessRange)}pts — only ${Math.round(rangeVsAvg * 100)}% of the 30-day average. Price stayed compressed. Despite the structural ${mornBias !== 'NEUTRAL' ? mornBias + ' ' : ''}read, this was an efficiency day — neither side committed to significant extension.`);
    } else {
      sessionNarrative.push(`Session range was ${Math.round(sessRange)}pts (${Math.round(rangeVsAvg * 100)}% of avg) — normal participation, consistent with a standard session.`);
    }
    // VWAP context
    const closeVsVwap = sessClose - vwap;
    sessionNarrative.push(`VWAP settled at ${Math.round(vwap)}. Session closed ${Math.abs(closeVsVwap).toFixed(0)}pts ${closeVsVwap > 0 ? 'above' : 'below'} VWAP — ${closeVsVwap > 0 ? 'buyers maintained value acceptance above the session average, confirming structural control' : 'price accepted below the session average, with sellers maintaining structural pressure into the close'}.`);
    // G-Line
    if (gLine) {
      if (sessClose > gLine && sessLow < gLine) sessionNarrative.push(`Weekly G-Line (${Math.round(gLine)}) was tested intraday but reclaimed by the close — the week ended on a positive structural note despite the intraday probe.`);
      else if (sessClose > gLine) sessionNarrative.push(`Price held above the weekly G-Line (${Math.round(gLine)}) throughout — the week maintained a positive structural character.`);
      else sessionNarrative.push(`Price closed below the weekly G-Line (${Math.round(gLine)}) — the week turned structurally negative. This matters going into tomorrow.`);
    }

    // Verdict and what it means
    const verdictNarrative = [];
    if (biasCorrect) {
      if (acdRow.a_up_fired || acdRow.a_down_fired) {
        verdictNarrative.push(`The pre-market structural read (${mornBias}) was validated by the A signal and confirmed by price following through. The three elements aligned: structural bias, ACD signal, and price acceptance. This is the highest-quality setup condition.`);
      } else {
        verdictNarrative.push(`The pre-market structural read (${mornBias}) was directionally correct, though without an A signal the trade was structural rather than signal-confirmed. Price moved in the bias direction, but the ACD framework did not provide a clean entry trigger.`);
      }
      if (ltNLalign) verdictNarrative.push(`The 30-session number line (${ltNL30 > 0 ? '+' : ''}${ltNL30}) was aligned with the ${mornBias} bias — today's intraday read had multi-timeframe structural support. When the NL, bracket state, and daily structure all agree, the setup quality is highest.`);
      else if (ltNL30 > -9 && ltNL30 < 9) verdictNarrative.push(`The 30-session number line was ranging (${ltNL30 > 0 ? '+' : ''}${ltNL30}) — no multi-session trend tailwind. Today's correct call was driven by the intraday structure, not a broader trend edge.`);
      if (p3Score >= 3) verdictNarrative.push(`In-session monitor confirmed throughout (${p3Score}/5) — the structure was observable and real, not just directional luck.`);
    } else if (biasWrong) {
      verdictNarrative.push(`The pre-market read called ${mornBias} but price moved ${actualDir.toLowerCase()}. `);
      if (ltNLconflict) verdictNarrative[verdictNarrative.length-1] += ` Notably, the 30-session number line (${ltNL30 > 0 ? '+' : ''}${ltNL30}) was already working against the ${mornBias} bias — this was a counter-trend intraday read in a ${ltNL30 > 9 ? 'bullish' : 'bearish'} structural environment. Counter-trend setups carry higher failure rates.`;
      if (patterns.some(p => p.type === 'NEWS_DRIVEN')) verdictNarrative[verdictNarrative.length-1] += `The 8:30 data event overrode the structural read — news-driven moves often ignore pre-session structure. This is not a structural failure; it is an external catalyst superseding the auction framework.`;
      else if (patterns.some(p => p.type.includes('REVERSAL'))) verdictNarrative[verdictNarrative.length-1] += `A reversal pattern developed during the session — the market opened in the structural direction then reversed. This is the most costly scenario: the initial read was right but the session character changed mid-day.`;
      else verdictNarrative[verdictNarrative.length-1] += `The structural conditions did not produce the expected directional follow-through. Review whether the prior day profile classification was accurate — if yesterday was mis-classified, the playbook would have been wrong from the start.`;
      if (p3Score <= 1) verdictNarrative.push(`P3 score was ${p3Score}/5 — the in-session monitor was correctly showing that the bias was not being confirmed. This was an available exit signal during the session.`);
    } else {
      verdictNarrative.push(`Neutral outcome — price moved less than 15pts from open to close. The session stayed inside the prior value area and neither side asserted control. The pre-market NEUTRAL read (if that was the call) was accurate. In neutral sessions, the playbook is to fade extremes rather than initiate in either direction.`);
    }
    // Tomorrow
    const tomorrow = [];
    if (biasCorrect && (acdRow.a_up_fired || acdRow.a_down_fired)) {
      tomorrow.push(`Prior day now classified as likely ${rangeVsAvg > 1.5 ? 'TREND' : 'NORMAL_VARIATION'} — tomorrow's playbook: ${rangeVsAvg > 1.5 ? 'initiative, go with range extensions, same side maintained control' : 'two-sided with extensions possible'}.`);
    }
    if (gLine) {
      tomorrow.push(sessClose > gLine ? `G-Line (${Math.round(gLine)}) becomes support going into tomorrow — hold above = week remains structurally positive.` : `G-Line (${Math.round(gLine)}) is now overhead resistance — any rally tomorrow that stalls here is a potential fade.`);
    }

    const narrative = { preMarket: preNarrative, session: sessionNarrative, verdict: verdictNarrative, tomorrow };

    // Build the analysis object
    const analysis = {
      available: true,
      date: dateET,
      // Prediction
      mornBias,
      inv: read.overnight_inventory,
      val: read.open_vs_prior_value,
      priorProfile: read.prior_day_profile,
      orCondition: read.or_condition,
      openingCall: read.opening_call_type,
      // Result
      actualDir,
      ptsVsOpen,
      sessOpen: Math.round(sessOpen),
      sessClose: Math.round(sessClose),
      sessHigh: Math.round(sessHigh),
      sessLow: Math.round(sessLow),
      sessRange: Math.round(sessRange),
      rangeVsAvg: Math.round(rangeVsAvg * 100),
      vwap: Math.round(vwap),
      // Signal
      aUpLevel: acdRow.a_up_level, aDownLevel: acdRow.a_down_level,
      aUpFired: !!acdRow.a_up_fired, aDownFired: !!acdRow.a_down_fired,
      orRange: Math.round(acdRow.or_range),
      // Accuracy
      biasCorrect, biasWrong,
      outcome: biasCorrect ? 'CORRECT' : biasWrong ? 'WRONG' : 'NEUTRAL',
      // Patterns
      patterns,
      // Levels
      gLine: gLine ? Math.round(gLine) : null,
      gNote,
      pwHigh: pwHigh ? Math.round(pwHigh) : null,
      pwLow: pwLow ? Math.round(pwLow) : null,
      pwNote,
      // P3
      p3Score, p3Source,
      // Deep narrative
      narrative,
      // Stable server-side timestamp — set when data is generated, not when page loads
      calculatedAt: new Date().toISOString(),
    };

    res.json(analysis);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

export default router;
