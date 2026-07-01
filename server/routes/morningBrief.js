import express from 'express';
import { query } from '../db.js';
import { getSessionForecast } from '../services/sessionForecastService.js';
import { getTrailingVwapStd } from '../services/queries.js';

const router = express.Router();

// ── Rolling distribution helpers (σ-based, no static thresholds) ──────────
function rollingStats(arr) {
  if (!arr.length) return { mean: 0, std: 0 };
  const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
  const std = Math.sqrt(arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length);
  return { mean, std };
}
function zScore(val, arr) {
  const { mean, std } = rollingStats(arr);
  return std > 0 ? (val - mean) / std : 0;
}
const MIN_SAMPLES = 20;

// Fetch trailing daily cumDeltas from price bars (30-day window)
async function getTrailingCumDeltas(date, days = 30) {
  const dailyBars = await query(`
    SELECT ts::date::text as d, open::float, high::float, low::float, close::float, volume::bigint as vol
    FROM price_bars_primary WHERE symbol='NQ'
    AND ts::date >= $1::date - $2::int AND ts::date < $1
    AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
    ORDER BY ts`, [date, days]).catch(() => ({ rows: [] }));
  if (!dailyBars.rows.length) return [];
  // Group by date, compute cumDelta per day
  const byDate = {};
  for (const b of dailyBars.rows) {
    if (!byDate[b.d]) byDate[b.d] = [];
    byDate[b.d].push(b);
  }
  return Object.values(byDate).map(bars => {
    let cd = 0;
    for (const b of bars) {
      const bRange = b.high - b.low;
      const bodyPct = bRange > 0 ? Math.abs(b.close - b.open) / bRange : 0;
      const dir = b.close >= b.open ? 1 : -1;
      cd += dir * Number(b.vol || 0) * Math.max(bodyPct, 0.3);
    }
    return cd;
  });
}

// Fetch trailing 24hr VWAP distances (30-day window)
async function getTrailing24hrVwapDists(date, days = 30) {
  const result = await query(`
    WITH day_list AS (
      SELECT DISTINCT ts::date as d FROM price_bars_primary
      WHERE symbol='NQ' AND ts::date >= $1::date - $2::int AND ts::date < $1
      ORDER BY d
    )
    SELECT d::text, (array_agg(close ORDER BY ts DESC))[1]::float as close_price
    FROM price_bars_primary pb
    JOIN day_list dl ON pb.ts::date = dl.d
    WHERE symbol='NQ' AND EXTRACT(hour FROM pb.ts)*60+EXTRACT(minute FROM pb.ts) BETWEEN 570 AND 959
    GROUP BY d
    ORDER BY d`, [date, days]).catch(() => ({ rows: [] }));
  if (result.rows.length < 5) return [];

  const dists = [];
  for (const row of result.rows) {
    // Compute 24hr VWAP for each day
    const globex = await query(`
      SELECT high::float, low::float, close::float, volume::bigint as vol
      FROM price_bars_primary WHERE symbol='NQ' AND (
        (ts::date = $1::date - 1 AND EXTRACT(hour FROM ts) >= 18) OR
        (ts::date = $1 AND EXTRACT(hour FROM ts) < 17)
      ) ORDER BY ts`, [row.d]).catch(() => ({ rows: [] }));
    if (globex.rows.length > 50) {
      let pv = 0, v = 0;
      for (const b of globex.rows) { pv += (b.high + b.low + b.close) / 3 * Number(b.vol || 1); v += Number(b.vol || 1); }
      const vwap24 = pv / v;
      dists.push(row.close_price - vwap24);
    }
  }
  return dists;
}

// Fetch trailing weekly VWAP distances
async function getTrailingWeeklyVwapDists(date, weeks = 12) {
  const dists = [];
  const d = new Date(date + 'T12:00:00');
  for (let w = 1; w <= weeks; w++) {
    const targetDate = new Date(d.getTime() - w * 7 * 86400000);
    const friday = new Date(targetDate.getTime());
    // Find the Friday of that week
    const dayOfWeek = friday.getDay();
    const daysToFri = dayOfWeek <= 5 ? 5 - dayOfWeek : -2;
    friday.setDate(friday.getDate() + daysToFri);
    const friStr = friday.toISOString().slice(0, 10);
    const monOffset = friday.getDay() === 0 ? 6 : friday.getDay() - 1;
    const monday = new Date(friday.getTime() - monOffset * 86400000);
    const monStr = monday.toISOString().slice(0, 10);

    const wb = await query(`
      SELECT high::float, low::float, close::float, volume::bigint as vol
      FROM price_bars_primary WHERE symbol='NQ'
      AND ts::date >= $1 AND ts::date <= $2
      AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
      ORDER BY ts`, [monStr, friStr]).catch(() => ({ rows: [] }));
    if (wb.rows.length < 50) continue;
    let wPV = 0, wV = 0;
    for (const b of wb.rows) { wPV += (b.high + b.low + b.close) / 3 * Number(b.vol || 1); wV += Number(b.vol || 1); }
    const wVwap = wPV / wV;
    const lastClose = wb.rows[wb.rows.length - 1].close;
    dists.push(lastClose - wVwap);
  }
  return dists;
}

// Fetch trailing rotation counts from session_analysis (90-day window)
async function getTrailingRotations(date, days = 90) {
  const res = await query(
    `SELECT rotations_65pt FROM session_analysis
     WHERE trade_date >= $1::date - $2::int AND trade_date < $1
     AND rotations_65pt IS NOT NULL
     ORDER BY trade_date DESC`, [date, days]).catch(() => ({ rows: [] }));
  return res.rows.map(r => r.rotations_65pt);
}

// Fetch trailing OR widths from acd_daily_log (90-day window)
async function getTrailingORWidths(date, days = 90) {
  const res = await query(
    `SELECT or_high::float - or_low::float as or_width
     FROM acd_daily_log
     WHERE trade_date >= $1::date - $2::int AND trade_date < $1
     AND or_high IS NOT NULL AND or_low IS NOT NULL
     ORDER BY trade_date DESC`, [date, days]).catch(() => ({ rows: [] }));
  return res.rows.map(r => r.or_width).filter(w => w > 0);
}

// Fetch trailing ATR(20) for rotation threshold
async function getTrailingATR(date, days = 20) {
  const res = await query(`
    SELECT (MAX(high) - MIN(low))::float as range
    FROM price_bars_primary
    WHERE symbol='NQ' AND ts::date >= $1::date - $2::int AND ts::date < $1
    AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
    GROUP BY ts::date
    ORDER BY ts::date DESC`, [date, days]).catch(() => ({ rows: [] }));
  if (res.rows.length < 5) return 400; // reasonable NQ default
  return res.rows.reduce((s, r) => s + r.range, 0) / res.rows.length;
}

router.get('/forecast/:date', async (req, res) => {
  try {
    const { date } = req.params;
    const forecast = await getSessionForecast(date);
    res.json(forecast);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/scalp-playbook/:date', async (req, res) => {
  try {
    const { date } = req.params;
    const d = new Date(date + 'T12:00:00');
    const dow = d.getDay();
    const dowName = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dow];
    const tomorrowDow = (dow + 1) % 7;
    const tomorrowName = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][tomorrowDow];

    // Get active pattern discoveries relevant to today's day-of-week
    const todayPatterns = await query(
      `SELECT pattern_key, dimension, win_rate, sample_size, net_pnl_dollars
       FROM pattern_discoveries WHERE status='ACTIVE'
       AND (pattern_key LIKE $1 OR pattern_key LIKE $2 OR dimension IN ('level_x_hour','session_x_hour','level_x_daytype','level_x_session','level_x_overnight','level_x_range','level_x_touch'))
       ORDER BY net_pnl_dollars DESC`,
      [`%×${dowName}%`, `%×${tomorrowName}%`]);

    // Split into today's DOW patterns and general patterns
    const dowPatterns = todayPatterns.rows.filter(p => p.pattern_key.includes(`×${dowName}`));
    const generalPatterns = todayPatterns.rows.filter(p => !p.pattern_key.includes(`×${dowName}`) && !p.pattern_key.includes(`×${tomorrowName}`));

    // Get prior day session type for context
    const priorSession = await query(
      `SELECT session_type, range_pt, close_pct_of_range FROM session_analysis WHERE trade_date < $1 ORDER BY trade_date DESC LIMIT 1`, [date]);
    const prior = priorSession.rows[0];

    // Get overnight read
    const overnightRead = await query(
      `SELECT overnight_inventory, open_vs_prior_value FROM auction_reads WHERE trade_date=$1`, [date]);
    const overnight = overnightRead.rows[0];

    // Get ACD day type if classified
    const dayTypeRes = await query(`SELECT day_type FROM acd_daily_log WHERE trade_date=$1`, [date]);
    const dayType = dayTypeRes.rows[0]?.day_type;

    // Build playbook: top 5 level × time combos for this day
    const topDowCombos = dowPatterns
      .filter(p => p.dimension.includes('dow'))
      .sort((a, b) => b.win_rate - a.win_rate)
      .slice(0, 8);

    // Best hours for today
    const hourPatterns = generalPatterns
      .filter(p => p.dimension === 'level_x_hour')
      .sort((a, b) => b.win_rate - a.win_rate)
      .slice(0, 8);

    // Context-specific (overnight, day type, range)
    const contextPatterns = [];
    if (overnight?.overnight_inventory) {
      const overnightMatches = generalPatterns.filter(p =>
        p.pattern_key.includes(`×${overnight.overnight_inventory}`));
      contextPatterns.push(...overnightMatches.slice(0, 5));
    }
    if (dayType) {
      const dtMatches = generalPatterns.filter(p =>
        p.pattern_key.includes(`×${dayType}`));
      contextPatterns.push(...dtMatches.slice(0, 5));
    }

    // Pipeline setups — fire rate and WR by context for anticipation
    const pipelineSetups = await query(
      `SELECT setup_type, COUNT(*) as fires,
        SUM(CASE WHEN resolution IN ('WIN','TARGET_HIT') THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN resolution IN ('LOSS','STOP_HIT') THEN 1 ELSE 0 END) as losses,
        ROUND(AVG(CASE WHEN resolution IN ('WIN','TARGET_HIT') THEN 1 WHEN resolution IN ('LOSS','STOP_HIT') THEN 0 END)*100) as wr,
        ROUND(AVG(CASE WHEN resolution IN ('WIN','LOSS','TARGET_HIT','STOP_HIT') THEN actual_pnl END)::numeric) as avg_pnl
       FROM active_setups
       WHERE EXTRACT(dow FROM trade_date) = $1
       AND status IN ('ACTIVE','RESOLVED')
       GROUP BY setup_type
       ORDER BY fires DESC`, [dow]);

    // Setup × overnight combos
    const setupOvernightCombos = await query(
      `SELECT s.setup_type, a.overnight_inventory, COUNT(*) as n,
        ROUND(AVG(CASE WHEN s.resolution='WIN' THEN 1 WHEN s.resolution='LOSS' THEN 0 END)*100) as wr
       FROM active_setups s JOIN auction_reads a ON s.trade_date = a.trade_date
       WHERE s.resolution IN ('WIN','LOSS') AND s.status IN ('ACTIVE','RESOLVED')
       AND a.overnight_inventory IS NOT NULL
       GROUP BY s.setup_type, a.overnight_inventory
       HAVING COUNT(*) >= 3
       ORDER BY wr DESC LIMIT 10`);

    // Setup × day type combos
    const setupDayTypeCombos = await query(
      `SELECT s.setup_type, d.day_type, COUNT(*) as n,
        ROUND(AVG(CASE WHEN s.resolution='WIN' THEN 1 WHEN s.resolution='LOSS' THEN 0 END)*100) as wr
       FROM active_setups s JOIN acd_daily_log d ON s.trade_date = d.trade_date
       WHERE s.resolution IN ('WIN','LOSS') AND s.status IN ('ACTIVE','RESOLVED')
       AND d.day_type IS NOT NULL
       GROUP BY s.setup_type, d.day_type
       HAVING COUNT(*) >= 3
       ORDER BY wr DESC LIMIT 10`);

    // Next-day tendency from session_analysis
    const nextDayTendency = await query(
      `SELECT sa2.session_type as next_type, sa2.close_vs_open as next_move, sa2.range_pt as next_range
       FROM session_analysis sa1
       JOIN session_analysis sa2 ON sa2.trade_date = (SELECT MIN(trade_date) FROM session_analysis WHERE trade_date > sa1.trade_date)
       WHERE sa1.session_type = $1
       ORDER BY sa1.trade_date DESC LIMIT 10`,
      [prior?.session_type]);

    const activeSetupTypes = ['VA_RESP_SHORT','OPEN_DRIVE_SHORT','OPEN_DRIVE_LONG','TRT_LONG','IB_BEARISH','C_STANDALONE_DOWN'];

    const allSetupTypes = [...new Set(pipelineSetups.rows.map(r => r.setup_type))];
    const pipelineForToday = pipelineSetups.rows
      .filter(r => parseInt(r.wins || 0) + parseInt(r.losses || 0) >= 1 || parseInt(r.fires) >= 2)
      .map(r => {
        const resolved = parseInt(r.wins || 0) + parseInt(r.losses || 0);
        const timeWindow = r.setup_type.includes('OPEN_DRIVE') ? '9:30-10:00 AM' :
          r.setup_type.includes('IB_') ? 'After 10:30 AM' :
          r.setup_type.includes('TRT') ? 'After 10:30 AM' :
          r.setup_type.includes('VALUE_AREA') ? 'After 10:30 AM' :
          r.setup_type.includes('C_STANDALONE') ? '11:00 AM+' : 'RTH';
        return {
          setup: r.setup_type === 'VALUE_AREA_RESPONSIVE_SHORT' ? 'VA_RESP_SHORT' : r.setup_type,
          fires: parseInt(r.fires),
          wins: parseInt(r.wins || 0),
          losses: parseInt(r.losses || 0),
          wr: resolved >= 3 ? parseInt(r.wr) : null,
          avgPnl: r.avg_pnl ? parseFloat(r.avg_pnl) : null,
          n: resolved,
          timeWindow,
        };
      })
      .sort((a, b) => (b.wr || 0) - (a.wr || 0));

    // Multi-day coil detection: consecutive losses per setup → outsized next win
    const coilSetups = ['VALUE_AREA_RESPONSIVE_SHORT','OPEN_TEST_DRIVE_LONG','C_STANDALONE_UP','IB_BEARISH','OPEN_DRIVE_SHORT','OPEN_DRIVE_LONG','TRT_LONG','C_STANDALONE_DOWN'];
    const coilData = [];
    for (const setupType of coilSetups) {
      const history = await query(
        `SELECT trade_date, resolution, actual_pnl::float as pnl
         FROM active_setups WHERE setup_type=$1 AND resolution IN ('WIN','LOSS','STOP_HIT','TARGET_HIT','EXPIRED')
         AND status IN ('ACTIVE','RESOLVED') ORDER BY trade_date DESC, fired_at DESC`, [setupType]);
      if (history.rows.length < 3) continue;
      let streak = 0;
      let lastWinPnl = null;
      for (const r of history.rows) {
        const won = r.resolution === 'WIN' || r.resolution === 'TARGET_HIT';
        if (won) { lastWinPnl = r.pnl; break; }
        streak++;
      }
      const allWins = history.rows.filter(r => r.resolution === 'WIN' || r.resolution === 'TARGET_HIT');
      const avgWin = allWins.length > 0 ? Math.round(allWins.reduce((s, r) => s + (r.pnl || 0), 0) / allWins.length) : 0;
      const longDroughtWins = [];
      let s2 = 0;
      for (let i = history.rows.length - 1; i >= 0; i--) {
        const won = history.rows[i].resolution === 'WIN' || history.rows[i].resolution === 'TARGET_HIT';
        if (won) { if (s2 >= 6) longDroughtWins.push(history.rows[i].pnl || 0); s2 = 0; }
        else s2++;
      }
      const avgDroughtWin = longDroughtWins.length >= 2 ? Math.round(longDroughtWins.reduce((a, b) => a + b, 0) / longDroughtWins.length) : null;
      const coilRatio = avgDroughtWin && avgWin > 0 ? Math.round(avgDroughtWin / avgWin * 10) / 10 : null;
      coilData.push({
        setup: setupType === 'VALUE_AREA_RESPONSIVE_SHORT' ? 'VA_RESP_SHORT' : setupType,
        currentStreak: streak,
        avgWin,
        avgDroughtWin,
        coilRatio,
        totalFires: history.rows.length,
        coiled: streak >= 5 && coilRatio && coilRatio >= 1.3
      });
    }

    // Overnight volume and balance zone context
    const overnightBars = await query(
      `SELECT open::float, high::float, low::float, close::float, volume::bigint as vol,
        (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts))::int as et_min
       FROM price_bars_primary WHERE symbol='NQ' AND ts::date=$1
       AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) NOT BETWEEN 570 AND 959
       ORDER BY ts`, [date]);
    let overnightProfile = null;
    if (overnightBars.rows.length > 10) {
      const ob = overnightBars.rows;
      const onHigh = Math.max(...ob.map(b => b.high));
      const onLow = Math.min(...ob.map(b => b.low));
      const onClose = ob[ob.length - 1].close;
      const onOpen = ob[0].open;
      const totalVol = ob.reduce((s, b) => s + Number(b.vol || 0), 0);
      const volBk = {};
      for (const b of ob) {
        const bk = Math.round(b.close / 25) * 25;
        volBk[bk] = (volBk[bk] || 0) + Number(b.vol || 0);
      }
      const onPOC = parseInt(Object.entries(volBk).sort((a, b) => b[1] - a[1])[0]?.[0]) || onClose;
      const sorted = Object.entries(volBk).sort((a, b) => b[1] - a[1]);
      const totalVolBk = sorted.reduce((s, [, v]) => s + v, 0);
      let vaVol = 0;
      const vaLevels = [];
      for (const [price, vol] of sorted) {
        vaVol += vol;
        vaLevels.push(parseFloat(price));
        if (vaVol >= totalVolBk * 0.7) break;
      }
      const onVAH = Math.max(...vaLevels);
      const onVAL = Math.min(...vaLevels);
      overnightProfile = {
        high: Math.round(onHigh), low: Math.round(onLow),
        range: Math.round(onHigh - onLow),
        close: Math.round(onClose), open: Math.round(onOpen),
        poc: onPOC, vah: Math.round(onVAH), val: Math.round(onVAL),
        volume: totalVol,
        direction: onClose > onOpen ? 'UP' : 'DOWN',
        closePosition: Math.round((onClose - onLow) / (onHigh - onLow) * 100)
      };
    }

    // Balance zones from developing_value_log (recent VA overlaps)
    const recentVAs = await query(
      `SELECT trade_date, vah::float, val::float, poc::float
       FROM developing_value_log WHERE trade_date >= $1::date - 5 AND trade_date < $1
       ORDER BY trade_date DESC LIMIT 5`, [date]);
    let balanceZones = [];
    if (recentVAs.rows.length >= 2) {
      for (let i = 0; i < recentVAs.rows.length - 1; i++) {
        const a = recentVAs.rows[i], b = recentVAs.rows[i + 1];
        const overlapHi = Math.min(a.vah, b.vah);
        const overlapLo = Math.max(a.val, b.val);
        if (overlapHi > overlapLo) {
          balanceZones.push({ high: Math.round(overlapHi), low: Math.round(overlapLo), width: Math.round(overlapHi - overlapLo), days: `${b.trade_date} — ${a.trade_date}` });
        }
      }
    }

    // New discoveries (last 3 days)
    const newDiscoveries = await query(
      `SELECT pattern_key, dimension, win_rate, sample_size, net_pnl_dollars
       FROM pattern_discoveries WHERE status='ACTIVE' AND first_seen >= CURRENT_DATE - 3
       ORDER BY net_pnl_dollars DESC LIMIT 5`);

    // Degraded patterns (fell below threshold)
    const degraded = await query(
      `SELECT pattern_key, dimension, win_rate, sample_size
       FROM pattern_discoveries WHERE status='DEGRADED' AND last_updated >= CURRENT_DATE - 3
       LIMIT 5`);

    res.json({
      date,
      dayOfWeek: dowName,
      priorSession: prior ? { type: prior.session_type, range: prior.range_pt, closePct: prior.close_pct_of_range } : null,
      overnight: overnight || null,
      dayType,
      topDowCombos: topDowCombos.map(p => ({
        pattern: p.pattern_key, wr: Math.round(p.win_rate * 100), n: p.sample_size, pnl: p.net_pnl_dollars
      })),
      bestHours: hourPatterns.map(p => ({
        pattern: p.pattern_key, wr: Math.round(p.win_rate * 100), n: p.sample_size, pnl: p.net_pnl_dollars
      })),
      contextSpecific: contextPatterns.map(p => ({
        pattern: p.pattern_key, wr: Math.round(p.win_rate * 100), n: p.sample_size, pnl: p.net_pnl_dollars
      })),
      newDiscoveries: newDiscoveries.rows.map(p => ({
        pattern: p.pattern_key, wr: Math.round(p.win_rate * 100), n: p.sample_size, pnl: p.net_pnl_dollars
      })),
      degraded: degraded.rows.map(p => ({
        pattern: p.pattern_key, wr: Math.round(p.win_rate * 100), n: p.sample_size
      })),
      pipelineSetups: pipelineForToday,
      setupContextCombos: [
        ...setupOvernightCombos.rows.map(r => ({
          setup: r.setup_type, context: r.overnight_inventory, wr: parseInt(r.wr), n: parseInt(r.n), dimension: 'overnight'
        })),
        ...setupDayTypeCombos.rows.map(r => ({
          setup: r.setup_type, context: r.day_type, wr: parseInt(r.wr), n: parseInt(r.n), dimension: 'dayType'
        })),
      ],
      coilWatch: coilData.filter(c => c.currentStreak >= 3).sort((a, b) => b.currentStreak - a.currentStreak),
      overnightProfile,
      balanceZones,
      nextDayTendency: nextDayTendency.rows.length > 0 ? {
        afterType: prior?.session_type,
        avgNextRange: Math.round(nextDayTendency.rows.reduce((s, r) => s + r.next_range, 0) / nextDayTendency.rows.length),
        upPct: Math.round(nextDayTendency.rows.filter(r => r.next_move > 0).length / nextDayTendency.rows.length * 100),
        n: nextDayTendency.rows.length
      } : null,
    });
  } catch (err) {
    console.error('[scalp-playbook]', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/scalp-recap/:date', async (req, res) => {
  try {
    const { date } = req.params;

    // 1. Pipeline setups that fired and their outcomes
    const firedSetups = await query(
      `SELECT setup_type, resolution, actual_pnl::float as pnl,
        entry_zone_low::float as entry, t1_level::float as target, stop_level::float as stop,
        fired_at, resolved_at, status,
        CASE WHEN setup_type LIKE '%LONG%' OR setup_type LIKE '%BULLISH%' OR setup_type LIKE '%UP%' THEN 'LONG' ELSE 'SHORT' END as direction
       FROM active_setups WHERE trade_date=$1
       ORDER BY fired_at`, [date]);

    // 2. Level scalps: simulate against today's bars
    const barsRes = await query(
      `SELECT (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts))::int as et_min,
              open::float, high::float, low::float, close::float, volume::bigint as vol
       FROM price_bars_primary WHERE symbol='NQ' AND ts::date=$1
       AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959 ORDER BY ts`, [date]);
    const bars = barsRes.rows;

    const levelScalps = [];
    if (bars.length >= 60) {
      const pdRes = await query(
        `SELECT poc::float, vah::float, val::float, session_high::float as hi, session_low::float as lo, session_close::float as cl
         FROM developing_value_log WHERE trade_date < $1 ORDER BY trade_date DESC LIMIT 1`, [date]);
      const pd = pdRes.rows[0];
      const orBars = bars.filter(b => b.et_min >= 570 && b.et_min < 600);
      const orH = orBars.length ? Math.max(...orBars.map(b => b.high)) : null;
      const orL = orBars.length ? Math.min(...orBars.map(b => b.low)) : null;
      const ibBars = bars.filter(b => b.et_min >= 570 && b.et_min < 630);
      const ibH = ibBars.length ? Math.max(...ibBars.map(b => b.high)) : null;
      const ibL = ibBars.length ? Math.min(...ibBars.map(b => b.low)) : null;
      let floorP = null, floorR1 = null, floorS1 = null;
      if (pd) { floorP = (pd.hi + pd.lo + pd.cl) / 3; floorR1 = 2 * floorP - pd.lo; floorS1 = 2 * floorP - pd.hi; }

      // Rolling 10-day IB MID and 5-day OR MID (top performing composite levels)
      let ib10Mid = null, or5Mid = null;
      try {
        const ib10Res = await query(`
          SELECT MAX(ibh) as hi, MIN(ibl) as lo FROM (
            SELECT ts::date as d, MAX(high)::float as ibh, MIN(low)::float as ibl
            FROM price_bars_primary WHERE symbol='NQ'
            AND ts::date >= $1::date - 14 AND ts::date < $1
            AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 630
            GROUP BY ts::date ORDER BY d DESC LIMIT 10
          ) t`, [date]);
        if (ib10Res.rows[0]?.hi) ib10Mid = (ib10Res.rows[0].hi + ib10Res.rows[0].lo) / 2;

        const or5Res = await query(`
          SELECT MAX(orh) as hi, MIN(orl) as lo FROM (
            SELECT or_high::float as orh, or_low::float as orl
            FROM acd_daily_log WHERE trade_date < $1 AND or_high IS NOT NULL
            ORDER BY trade_date DESC LIMIT 5
          ) t`, [date]);
        if (or5Res.rows[0]?.hi) or5Mid = (or5Res.rows[0].hi + or5Res.rows[0].lo) / 2;
      } catch (_) {}

      const levels = [
        { name: 'PD_POC', price: pd?.poc }, { name: 'PD_VAH', price: pd?.vah }, { name: 'PD_VAL', price: pd?.val },
        { name: 'OR_HIGH', price: orH }, { name: 'OR_LOW', price: orL },
        { name: 'IB_HIGH', price: ibH }, { name: 'IB_LOW', price: ibL },
        { name: 'FLOOR_PIVOT', price: floorP }, { name: 'FLOOR_R1', price: floorR1 }, { name: 'FLOOR_S1', price: floorS1 },
        { name: '10D_IB_MID', price: ib10Mid }, { name: '5D_OR_MID', price: or5Mid },
      ].filter(l => l.price);

      const cfg = { target: 20, stop: 25 };
      for (const level of levels) {
        let lastTrade = -15;
        const startBar = level.name.startsWith('IB') ? 60 : 30;
        for (let i = startBar; i < bars.length; i++) {
          if (i - lastTrade < 15) continue;
          if (Math.abs(bars[i].close - level.price) > 8) continue;
          const lb = bars.slice(Math.max(0, i - 5), i);
          if (lb.length < 3) continue;
          const approach = lb[0].close < level.price ? 'FROM_BELOW' : 'FROM_ABOVE';
          const fadeDir = approach === 'FROM_BELOW' ? 'SHORT' : 'LONG';
          const entry = bars[i].close;
          const hour = Math.floor(bars[i].et_min / 60);
          const min = bars[i].et_min % 60;
          const timeStr = `${hour}:${String(min).padStart(2, '0')}`;

          let result = 'EXPIRED', pnl = 0, mfe = 0;
          for (let j = i + 1; j < Math.min(i + 31, bars.length); j++) {
            const favor = fadeDir === 'SHORT' ? entry - bars[j].low : bars[j].high - entry;
            const adverse = fadeDir === 'SHORT' ? bars[j].high - entry : entry - bars[j].low;
            mfe = Math.max(mfe, favor);
            if (favor >= cfg.target) { result = 'WIN'; pnl = cfg.target; lastTrade = j; break; }
            if (adverse >= cfg.stop) { result = 'LOSS'; pnl = -cfg.stop; lastTrade = j; break; }
          }
          levelScalps.push({
            level: level.name, levelPrice: Math.round(level.price), time: timeStr,
            direction: fadeDir, entry: Math.round(entry), result, pnl, mfe: Math.round(mfe)
          });
          lastTrade = i;
        }
      }
    }

    // 3. VWAP magnet trades — σ-based threshold matching live acd.js (1.5σ trigger)
    const vwapTrades = [];
    if (bars.length >= 60) {
      const recapVwapStd = await getTrailingVwapStd(date, 30);
      const recapThreshold = recapVwapStd.threshold;

      let cumPV = 0, cumV = 0;
      let lastVwapTrade = -30;
      for (let i = 0; i < bars.length; i++) {
        cumPV += (bars[i].high + bars[i].low + bars[i].close) / 3 * Number(bars[i].vol || 1);
        cumV += Number(bars[i].vol || 1);
        const vwap = cumPV / cumV;
        if (i - lastVwapTrade < 30 || i < 60) continue;
        const threshold = recapThreshold;
        const dist = bars[i].close - vwap;
        if (Math.abs(dist) >= threshold) {
          const fadeDir = dist > 0 ? 'SHORT' : 'LONG';
          const entry = bars[i].close;
          const hour = Math.floor(bars[i].et_min / 60);
          const min = bars[i].et_min % 60;
          let result = 'EXPIRED', pnl = 0;
          for (let j = i + 1; j < Math.min(i + 31, bars.length); j++) {
            const favor = fadeDir === 'SHORT' ? entry - bars[j].low : bars[j].high - entry;
            const adverse = fadeDir === 'SHORT' ? bars[j].high - entry : entry - bars[j].low;
            if (favor >= 20) { result = 'WIN'; pnl = 20; lastVwapTrade = j; break; }
            if (adverse >= 30) { result = 'LOSS'; pnl = -30; lastVwapTrade = j; break; }
          }
          vwapTrades.push({
            time: `${hour}:${String(min).padStart(2, '0')}`,
            direction: fadeDir, vwapDist: Math.round(Math.abs(dist)), result, pnl
          });
          lastVwapTrade = i;
        }
      }
    }

    // 4. Session analysis
    const sa = await query(`SELECT * FROM session_analysis WHERE trade_date=$1`, [date]);
    const session = sa.rows[0];

    // 5. Coil outcomes: did any coiled setup fire and win today?
    const coilOutcomes = firedSetups.rows
      .filter(s => s.resolution === 'WIN' || s.resolution === 'TARGET_HIT')
      .map(s => ({ setup: s.setup_type, pnl: s.pnl, direction: s.direction }));

    // Scorecard
    const scalpWins = levelScalps.filter(s => s.result === 'WIN').length;
    const scalpLosses = levelScalps.filter(s => s.result === 'LOSS').length;
    const scalpPnl = levelScalps.reduce((s, t) => s + t.pnl, 0) * 2;
    const vwapWins = vwapTrades.filter(t => t.result === 'WIN').length;
    const vwapLosses = vwapTrades.filter(t => t.result === 'LOSS').length;
    const vwapPnl = vwapTrades.reduce((s, t) => s + t.pnl, 0) * 2;
    const pipelineWins = firedSetups.rows.filter(s => s.resolution === 'WIN' || s.resolution === 'TARGET_HIT').length;
    const pipelineLosses = firedSetups.rows.filter(s => s.resolution === 'LOSS' || s.resolution === 'STOP_HIT').length;
    const pipelinePnl = firedSetups.rows.reduce((s, r) => s + (r.pnl || 0), 0);

    res.json({
      date,
      session: session ? {
        type: session.session_type, range: session.range_pt, rotations: session.rotations_65pt,
        closePct: session.close_pct_of_range, closeVsOpen: session.close_vs_open
      } : null,
      scorecard: {
        scalps: { trades: scalpWins + scalpLosses, wins: scalpWins, losses: scalpLosses, pnl: scalpPnl },
        vwapMagnet: { trades: vwapWins + vwapLosses, wins: vwapWins, losses: vwapLosses, pnl: vwapPnl },
        pipeline: { trades: pipelineWins + pipelineLosses, wins: pipelineWins, losses: pipelineLosses, pnl: Math.round(pipelinePnl) },
        totalPnl: scalpPnl + vwapPnl + Math.round(pipelinePnl)
      },
      levelScalps,
      vwapTrades,
      pipelineSetups: firedSetups.rows.map(s => ({
        setup: s.setup_type, direction: s.direction, resolution: s.resolution || s.status,
        pnl: s.pnl, entry: s.entry, firedAt: s.fired_at
      })),
    });
  } catch (err) {
    console.error('[scalp-recap]', err);
    res.status(500).json({ error: err.message });
  }
});

const vaCache = new Map();

router.get('/live-session-context/:date', async (req, res) => {
  try {
    const { date } = req.params;
    const barsRes = await query(
      `SELECT (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts))::int as et_min,
              open::float, high::float, low::float, close::float, volume::bigint as vol
       FROM price_bars_primary WHERE symbol='NQ' AND ts::date=$1
       AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959 ORDER BY ts`, [date]);
    const bars = barsRes.rows;
    if (bars.length < 10) return res.json({ noData: true });

    const price = bars[bars.length - 1].close;
    const sessHi = Math.max(...bars.map(b => b.high));
    const sessLo = Math.min(...bars.map(b => b.low));
    const range = sessHi - sessLo;
    const openPrice = bars[0].open;
    const closeVsOpen = Math.round(price - openPrice);
    const rangePct = range > 0 ? Math.round((price - sessLo) / range * 100) : 50;
    const etMin = bars[bars.length - 1].et_min;

    // VWAP
    let cumPV = 0, cumV = 0;
    for (const b of bars) { cumPV += (b.high + b.low + b.close) / 3 * Number(b.vol || 1); cumV += Number(b.vol || 1); }
    const vwap = cumV > 0 ? cumPV / cumV : price;

    // Developing POC
    const volBk = {};
    for (const b of bars) { const bk = Math.round(b.close / 25) * 25; volBk[bk] = (volBk[bk] || 0) + Number(b.vol || 0); }
    const poc = parseInt(Object.entries(volBk).sort((a, b) => b[1] - a[1])[0]?.[0]) || price;

    // OR/IB
    const orBars = bars.filter(b => b.et_min >= 570 && b.et_min < 600);
    const orH = orBars.length ? Math.max(...orBars.map(b => b.high)) : null;
    const orL = orBars.length ? Math.min(...orBars.map(b => b.low)) : null;
    const ibBars = bars.filter(b => b.et_min >= 570 && b.et_min < 630);
    const ibH = ibBars.length ? Math.max(...ibBars.map(b => b.high)) : null;
    const ibL = ibBars.length ? Math.min(...ibBars.map(b => b.low)) : null;
    const ibRange = ibH && ibL ? Math.round(ibH - ibL) : null;
    const ibBroken = ibH && ibL ? (price > ibH ? 'ABOVE' : price < ibL ? 'BELOW' : 'INSIDE') : null;

    // Rotations — 5-min close-to-close, ATR-scaled threshold (no static 65pt)
    const atr20 = await getTrailingATR(date, 20);
    const rotThreshold = Math.round(atr20 * 0.15); // ~15% of ATR(20)
    const fiveMapRot = {};
    for (const b of bars) {
      const bk = Math.floor(b.et_min / 5) * 5;
      if (!fiveMapRot[bk]) fiveMapRot[bk] = { close: b.close };
      else fiveMapRot[bk].close = b.close;
    }
    const fbRot = Object.values(fiveMapRot);
    let rots = 0, lastExt = fbRot[0]?.close || 0, lastType = 'LOW';
    for (const b of fbRot) {
      if (b.close > lastExt && lastType === 'LOW' && b.close - lastExt >= rotThreshold) { rots++; lastExt = b.close; lastType = 'HIGH'; }
      if (b.close < lastExt && lastType === 'HIGH' && lastExt - b.close >= rotThreshold) { rots++; lastExt = b.close; lastType = 'LOW'; }
      if (b.close > lastExt && lastType === 'HIGH') lastExt = b.close;
      if (b.close < lastExt && lastType === 'LOW') lastExt = b.close;
    }

    // Micro trend (last 10 five-min bars)
    const fiveMap = {};
    for (const b of bars) { const bk = Math.floor(b.et_min / 5) * 5; if (!fiveMap[bk]) fiveMap[bk] = { high: b.high, low: b.low, close: b.close }; else { fiveMap[bk].high = Math.max(fiveMap[bk].high, b.high); fiveMap[bk].low = Math.min(fiveMap[bk].low, b.low); fiveMap[bk].close = b.close; } }
    const fb = Object.values(fiveMap);
    const last10 = fb.slice(-10);
    let hl = 0, ll = 0;
    for (let i = 1; i < last10.length; i++) { if (last10[i].low > last10[i - 1].low) hl++; else ll++; }
    const microTrend = hl > ll + 2 ? 'HIGHER_LOWS' : ll > hl + 2 ? 'LOWER_LOWS' : 'MIXED';

    // Volume trend
    const half = Math.floor(bars.length / 2);
    const vol1 = bars.slice(0, half).reduce((s, b) => s + Number(b.vol || 0), 0) / (half || 1);
    const vol2 = bars.slice(half).reduce((s, b) => s + Number(b.vol || 0), 0) / ((bars.length - half) || 1);
    const volTrend = vol2 > vol1 * 1.2 ? 'INCREASING' : vol2 < vol1 * 0.8 ? 'DECLINING' : 'STABLE';

    // Session character assessment — σ-based CHOP thresholds from trailing rotation distribution
    const trailingRots = await getTrailingRotations(date, 90);
    const rotStats = trailingRots.length >= MIN_SAMPLES ? rollingStats(trailingRots) : { mean: 10, std: 5 };
    const chopThreshold = Math.round(rotStats.mean + rotStats.std);       // +1σ = CHOP
    const extremeChopThreshold = Math.round(rotStats.mean + 2 * rotStats.std); // +2σ = EXTREME_CHOP
    const rotSigma = rotStats.std > 0 ? Math.round((rots - rotStats.mean) / rotStats.std * 10) / 10 : 0;

    let sessionChar = 'DEVELOPING';
    if (etMin >= 630) {
      if (rots >= extremeChopThreshold) sessionChar = 'EXTREME_CHOP';
      else if (rots >= chopThreshold) sessionChar = 'CHOP';
      else if (Math.abs(closeVsOpen) > range * 0.4 && rangePct > 70) sessionChar = 'TREND_UP';
      else if (Math.abs(closeVsOpen) > range * 0.4 && rangePct < 30) sessionChar = 'TREND_DOWN';
      else if (ibRange && ibRange < 50) sessionChar = 'TIGHT_IB';
      else if (ibRange && ibRange > 100) sessionChar = 'WIDE_IB';
      else sessionChar = 'BALANCE';
    }

    // ACD signals
    const acdRes = await query(`SELECT a_up_fired, a_down_fired, c_up_confirmed, c_down_confirmed FROM acd_daily_log WHERE trade_date=$1`, [date]);
    const acd = acdRes.rows[0] || {};

    // Active setups today
    const setupsRes = await query(`SELECT setup_type, status, resolution, actual_pnl::float as pnl FROM active_setups WHERE trade_date=$1`, [date]);
    const activeSetups = setupsRes.rows.filter(s => s.status === 'ACTIVE');
    const resolvedSetups = setupsRes.rows.filter(s => s.resolution);

    // Level proximity (which levels are near current price)
    const pdRes = await query(`SELECT poc::float, vah::float, val::float FROM developing_value_log WHERE trade_date < $1 ORDER BY trade_date DESC LIMIT 1`, [date]);
    const pd = pdRes.rows[0];
    // 1M/3M value areas
    const computeVAForDate = async (interval) => {
      const cacheKey = `${date}_${interval}`;
      if (vaCache.has(cacheKey)) {
        return vaCache.get(cacheKey);
      }
      const res = await query(
        `SELECT close::float, volume::bigint as vol FROM price_bars_primary
         WHERE symbol='NQ' AND ts::date >= ($1::date - interval '${interval}') AND ts::date < $1
         AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959`, [date]);
      if (res.rows.length < 100) return { vah: null, val: null };
      const vbk = {};
      for (const b of res.rows) { const bk = Math.round(b.close / 25) * 25; vbk[bk] = (vbk[bk] || 0) + Number(b.vol || 0); }
      const sorted = Object.entries(vbk).sort((a, b) => b[1] - a[1]);
      const totalV = sorted.reduce((s, [, v]) => s + v, 0);
      let cumV = 0; const levels = [];
      for (const [price, vol] of sorted) { cumV += vol; levels.push(parseFloat(price)); if (cumV >= totalV * 0.7) break; }
      const vaResult = { vah: Math.max(...levels), val: Math.min(...levels) };
      vaCache.set(cacheKey, vaResult);
      if (vaCache.size > 200) {
        const firstKey = vaCache.keys().next().value;
        vaCache.delete(firstKey);
      }
      return vaResult;
    };
    const m1VA = await computeVAForDate('1 month');
    const m3VA = await computeVAForDate('3 months');

    // Dynamic proximity bands — scale with rolling 10-session median IB range.
    // Tight: intraday + session levels. Medium: prior-day midpoints. Wide: multi-week composites.
    const ibRangeCtx = await query(`
      SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY (ib_high - ib_low)) as median_ib
      FROM (
        SELECT MAX(high)::float as ib_high, MIN(low)::float as ib_low
        FROM price_bars_primary
        WHERE symbol='NQ' AND ts::date < $1
          AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) BETWEEN 570 AND 630
        GROUP BY ts::date ORDER BY ts::date DESC LIMIT 10
      ) t
    `, [date]).catch(() => ({ rows: [{}] }));
    const medianIB = ibRangeCtx.rows[0]?.median_ib ?? 80;
    const nearProxTight = Math.round(Math.max(20, Math.min(55, medianIB * 0.38)));
    const nearProxMed   = Math.round(Math.max(25, Math.min(65, medianIB * 0.46)));
    const nearProxWide  = Math.round(Math.max(30, Math.min(80, medianIB * 0.55)));

    const nearLevels = [];
    if (pd?.poc && Math.abs(price - pd.poc) < nearProxTight) nearLevels.push({ name: '2D POC', price: Math.round(pd.poc), dist: Math.round(price - pd.poc) });
    if (pd?.vah && Math.abs(price - pd.vah) < nearProxTight) nearLevels.push({ name: '2D VAH', price: Math.round(pd.vah), dist: Math.round(price - pd.vah) });
    if (pd?.val && Math.abs(price - pd.val) < nearProxTight) nearLevels.push({ name: '2D VAL', price: Math.round(pd.val), dist: Math.round(price - pd.val) });
    if (orH && Math.abs(price - orH) < nearProxTight) nearLevels.push({ name: 'OR High', price: Math.round(orH), dist: Math.round(price - orH) });
    if (orL && Math.abs(price - orL) < nearProxTight) nearLevels.push({ name: 'OR Low', price: Math.round(orL), dist: Math.round(price - orL) });
    // Today's midpoints (scalp levels)
    const orMid = orH && orL ? Math.round((orH + orL) / 2) : null;
    const ibMid = ibH && ibL ? Math.round((ibH + ibL) / 2) : null;
    if (orMid && Math.abs(price - orMid) < nearProxTight) nearLevels.push({ name: 'OR MID', price: orMid, dist: Math.round(price - orMid), ev: 4 });
    if (ibMid && Math.abs(price - ibMid) < nearProxTight) nearLevels.push({ name: 'IB MID', price: ibMid, dist: Math.round(price - ibMid), ev: 4 });
    // Prior day midpoints (all positive EV from audit)
    const pdIbRes = await query(`
      SELECT MAX(high)::float as ibh, MIN(low)::float as ibl
      FROM price_bars_primary WHERE symbol='NQ' AND ts::date = (
        SELECT MAX(ts::date) FROM price_bars_primary WHERE symbol='NQ' AND ts::date < $1
        AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 630
      ) AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 630`, [date]).catch(() => ({ rows: [{}] }));
    const pdIbMid = pdIbRes.rows[0]?.ibh ? Math.round((pdIbRes.rows[0].ibh + pdIbRes.rows[0].ibl) / 2) : null;
    const pdOrRes = await query(`SELECT or_high::float, or_low::float FROM acd_daily_log WHERE trade_date < $1 ORDER BY trade_date DESC LIMIT 1`, [date]).catch(() => ({ rows: [{}] }));
    const pdOrMid = pdOrRes.rows[0]?.or_high ? Math.round((pdOrRes.rows[0].or_high + pdOrRes.rows[0].or_low) / 2) : null;
    const pdSessMid = pd?.hi && pd?.lo ? Math.round((pd.hi + pd.lo) / 2) : null;
    if (pdIbMid && Math.abs(price - pdIbMid) < nearProxMed) nearLevels.push({ name: 'PD IB MID', price: pdIbMid, dist: Math.round(price - pdIbMid), ev: 18 });
    if (pdOrMid && Math.abs(price - pdOrMid) < nearProxMed) nearLevels.push({ name: 'PD OR MID', price: pdOrMid, dist: Math.round(price - pdOrMid), ev: 19 });
    if (pdSessMid && Math.abs(price - pdSessMid) < nearProxMed) nearLevels.push({ name: 'PD SESSION MID', price: pdSessMid, dist: Math.round(price - pdSessMid), ev: 19 });
    if (m1VA.vah && Math.abs(price - m1VA.vah) < nearProxWide) nearLevels.push({ name: '1M VAH', price: Math.round(m1VA.vah), dist: Math.round(price - m1VA.vah) });
    if (m1VA.val && Math.abs(price - m1VA.val) < nearProxWide) nearLevels.push({ name: '1M VAL', price: Math.round(m1VA.val), dist: Math.round(price - m1VA.val) });
    if (m3VA.vah && Math.abs(price - m3VA.vah) < nearProxWide) nearLevels.push({ name: '3M VAH', price: Math.round(m3VA.vah), dist: Math.round(price - m3VA.vah) });
    if (m3VA.val && Math.abs(price - m3VA.val) < nearProxWide) nearLevels.push({ name: '3M VAL', price: Math.round(m3VA.val), dist: Math.round(price - m3VA.val) });

    // Rolling composite levels (top performers from audit)
    const ib10Ctx = await query(`
      SELECT MAX(ibh) as hi, MIN(ibl) as lo FROM (
        SELECT ts::date as d, MAX(high)::float as ibh, MIN(low)::float as ibl
        FROM price_bars_primary WHERE symbol='NQ'
        AND ts::date >= $1::date - 14 AND ts::date < $1
        AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 630
        GROUP BY ts::date ORDER BY d DESC LIMIT 10
      ) t`, [date]).catch(() => ({ rows: [{}] }));
    const ib10Mid = ib10Ctx.rows[0]?.hi ? Math.round((ib10Ctx.rows[0].hi + ib10Ctx.rows[0].lo) / 2) : null;
    if (ib10Mid && Math.abs(price - ib10Mid) < nearProxWide) nearLevels.push({ name: '10D IB MID', price: ib10Mid, dist: Math.round(price - ib10Mid), ev: 26 });

    const or5Ctx = await query(`
      SELECT MAX(orh) as hi, MIN(orl) as lo FROM (
        SELECT or_high::float as orh, or_low::float as orl
        FROM acd_daily_log WHERE trade_date < $1 AND or_high IS NOT NULL
        ORDER BY trade_date DESC LIMIT 5
      ) t`, [date]).catch(() => ({ rows: [{}] }));
    const or5Mid = or5Ctx.rows[0]?.hi ? Math.round((or5Ctx.rows[0].hi + or5Ctx.rows[0].lo) / 2) : null;
    if (or5Mid && Math.abs(price - or5Mid) < nearProxWide) nearLevels.push({ name: '5D OR MID', price: or5Mid, dist: Math.round(price - or5Mid), ev: 22 });

    // 24hr VWAP (Globex session: 6 PM prior day → 5 PM today)
    const globexStart = `${date}T00:00:00`; // bars stored in ET, midnight is within session
    const allDayBars = await query(
      `SELECT high::float, low::float, close::float, volume::bigint as vol
       FROM price_bars_primary WHERE symbol='NQ' AND (
         (ts::date = $1::date - 1 AND EXTRACT(hour FROM ts) >= 18) OR
         (ts::date = $1 AND EXTRACT(hour FROM ts) < 17)
       ) ORDER BY ts`, [date]).catch(() => ({ rows: [] }));
    let vwap24 = null, vwap24Dist = null, vwap24Sigma = null;
    if (allDayBars.rows.length > 50) {
      let pv24 = 0, v24 = 0;
      for (const b of allDayBars.rows) { pv24 += (b.high + b.low + b.close) / 3 * Number(b.vol || 1); v24 += Number(b.vol || 1); }
      vwap24 = Math.round(pv24 / v24);
      vwap24Dist = Math.round(price - vwap24);
      // Rolling 30-day std of close-vs-24hr-VWAP distances (no static 130pt)
      const trailing24hrDists = await getTrailing24hrVwapDists(date, 30);
      const vwap24Std = trailing24hrDists.length >= MIN_SAMPLES
        ? rollingStats(trailing24hrDists).std
        : 130; // fallback if insufficient data
      vwap24Sigma = vwap24Std > 0 ? Math.round((price - vwap24) / vwap24Std * 10) / 10 : 0;
    }

    // Cumulative delta — estimate buy/sell pressure from bar direction
    let cumDelta = 0;
    let buyVol = 0, sellVol = 0;
    for (const b of bars) {
      const bRange = b.high - b.low;
      const bodyPct = bRange > 0 ? Math.abs(b.close - b.open) / bRange : 0;
      const dir = b.close >= b.open ? 1 : -1;
      const delta = dir * Number(b.vol || 0) * Math.max(bodyPct, 0.3);
      cumDelta += delta;
      if (dir > 0) buyVol += Number(b.vol || 0); else sellVol += Number(b.vol || 0);
    }
    const buySellRatio = sellVol > 0 ? Math.round(buyVol / sellVol * 100) / 100 : 1;
    // Recent delta trend (last 15 bars vs prior 15)
    const recentD = bars.slice(-15);
    const priorD = bars.slice(-30, -15);
    let recentDelta = 0, priorDelta = 0;
    for (const b of recentD) { const r = b.high-b.low; const bp = r>0 ? Math.abs(b.close-b.open)/r : 0; recentDelta += (b.close>=b.open?1:-1)*Number(b.vol||0)*Math.max(bp,0.3); }
    for (const b of priorD) { const r = b.high-b.low; const bp = r>0 ? Math.abs(b.close-b.open)/r : 0; priorDelta += (b.close>=b.open?1:-1)*Number(b.vol||0)*Math.max(bp,0.3); }
    // Threshold from today's own non-overlapping 15-bar window-delta distribution (self-referential, no lookahead)
    const sessionWindowDeltas = [];
    for (let i = 0; i + 15 <= bars.length; i += 15) {
      const w = bars.slice(i, i + 15);
      let wd = 0;
      for (const b of w) { const r = b.high-b.low; const bp = r>0 ? Math.abs(b.close-b.open)/r : 0; wd += (b.close>=b.open?1:-1)*Number(b.vol||0)*Math.max(bp,0.3); }
      sessionWindowDeltas.push(wd);
    }
    const deltaWindowStd = sessionWindowDeltas.length >= 4 ? rollingStats(sessionWindowDeltas).std : null;
    let deltaTrend = 'FLAT';
    if (priorD.length >= 15 && deltaWindowStd > 0) {
      if (recentDelta < -deltaWindowStd) deltaTrend = 'SELLING';
      else if (recentDelta > deltaWindowStd) deltaTrend = 'BUYING';
      else if (recentDelta < priorDelta - deltaWindowStd) deltaTrend = 'WEAKENING';
      else if (recentDelta > priorDelta + deltaWindowStd) deltaTrend = 'STRENGTHENING';
    }

    // Relative volume — cumulative session volume vs time-of-day baseline
    const cumSessionVol = bars.reduce((s, b) => s + Number(b.vol || 0), 0);
    const volBaselineRes = await query(
      `SELECT (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts))::int as et_min,
              AVG(volume::float) as avg_vol, STDDEV(volume::float) as std_vol
       FROM price_bars_primary WHERE symbol='NQ'
       AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND $1
       AND ts::date >= $2::date - 90 AND ts::date < $2
       GROUP BY et_min`, [etMin, date]).catch(() => ({ rows: [] }));
    const expectedCumVol = volBaselineRes.rows.reduce((s, r) => s + r.avg_vol, 0);
    const expectedCumStd = Math.sqrt(volBaselineRes.rows.reduce((s, r) => s + (r.std_vol || 0) ** 2, 0));
    const relVolRatio = expectedCumVol > 0 ? cumSessionVol / expectedCumVol : 1;
    const relVolSigma = expectedCumStd > 0 ? (cumSessionVol - expectedCumVol) / expectedCumStd : 0;

    // Last-bar volume spike (time-of-day adjusted)
    const lastBarVol = Number(bars[bars.length - 1].vol || 0);
    const lastBarBL = volBaselineRes.rows.find(r => r.et_min === etMin);
    const lastBarSigma = lastBarBL && lastBarBL.std_vol > 0 ? (lastBarVol - lastBarBL.avg_vol) / lastBarBL.std_vol : null;
    const lastBarDir = bars[bars.length - 1].close >= bars[bars.length - 1].open ? 'buying' : 'selling';

    // Cumulative delta σ — from trailing 30-day daily cumDelta distribution
    const trailingDeltas = await getTrailingCumDeltas(date, 30);
    const deltaSigma = trailingDeltas.length >= MIN_SAMPLES
      ? Math.round(zScore(cumDelta, trailingDeltas) * 10) / 10
      : null;

    // RVol label from σ (no static 1.6x/1.9x/0.8x thresholds)
    const relVolLabel = relVolSigma >= 2 ? 'Extreme' : relVolSigma >= 1 ? 'Elevated' : relVolSigma <= -1 ? 'Low' : 'Normal';
    // CumDelta label from σ
    const deltaLabel = deltaSigma != null
      ? (Math.abs(deltaSigma) >= 2 ? 'Strong' : Math.abs(deltaSigma) >= 1 ? 'Moderate' : 'Normal')
      : 'Normal';

    res.json({
      price: Math.round(price), openPrice: Math.round(openPrice),
      sessHi: Math.round(sessHi), sessLo: Math.round(sessLo),
      range: Math.round(range), rangePct, closeVsOpen,
      vwap: Math.round(vwap), vwapDist: Math.round(price - vwap),
      vwap24, vwap24Dist, vwap24Sigma,
      poc, pocDist: Math.round(price - poc),
      // Relative volume context — σ from time-of-day baseline
      relVol: { ratio: Math.round(relVolRatio * 100) / 100, sigma: Math.round(relVolSigma * 10) / 10, cumVol: cumSessionVol, expectedVol: Math.round(expectedCumVol), label: relVolLabel },
      lastBarVol: { vol: lastBarVol, sigma: lastBarSigma != null ? Math.round(lastBarSigma * 10) / 10 : null, dir: lastBarDir },
      // Cumulative delta context — σ from trailing 30-day daily distribution
      delta: { cumDelta: Math.round(cumDelta), sigma: deltaSigma, buySellRatio, buyVol: Math.round(buyVol), sellVol: Math.round(sellVol), trend: deltaTrend, label: deltaLabel },
      // Delta flow — 15-min phase breakdown for visual bar chart
      deltaFlow: (() => {
        const phases = [];
        for (let s = 570; s < 960; s += 15) {
          const pb = bars.filter(x => x.et_min >= s && x.et_min < s + 15);
          if (!pb.length) continue;
          let pd = 0;
          for (const bar of pb) {
            const r = bar.high - bar.low;
            const bp = r > 0 ? Math.abs(bar.close - bar.open) / r : 0;
            pd += (bar.close >= bar.open ? 1 : -1) * Number(bar.vol || 0) * Math.max(bp, 0.3);
          }
          const h = Math.floor(s / 60), m = s % 60;
          phases.push({ time: `${h}:${String(m).padStart(2,'0')}`, delta: Math.round(pd), close: Math.round(pb[pb.length-1].close) });
        }
        return phases;
      })(),
      orH: orH ? Math.round(orH) : null, orL: orL ? Math.round(orL) : null,
      ibH: ibH ? Math.round(ibH) : null, ibL: ibL ? Math.round(ibL) : null,
      ibRange, ibBroken,
      rots, rotSigma, rotThreshold, microTrend, volTrend, sessionChar, etMin,
      aUp: acd.a_up_fired, aDown: acd.a_down_fired, cUp: acd.c_up_confirmed, cDown: acd.c_down_confirmed,
      activeSetups: activeSetups.map(s => s.setup_type),
      resolvedSetups: resolvedSetups.map(s => ({ type: s.setup_type, result: s.resolution, pnl: s.pnl })),
      nearLevels,
      barsCount: bars.length,
      // Efficiency Ratio (30-bar rolling)
      efficiencyRatio: (() => {
        if (bars.length < 30) return null;
        const w = bars.slice(-30);
        const netMove = Math.abs(w[w.length-1].close - w[0].close);
        const totalMove = w.reduce((s, b, i) => i === 0 ? 0 : s + Math.abs(b.close - w[i-1].close), 0);
        return totalMove > 0 ? Math.round(netMove / totalMove * 100) / 100 : 0;
      })(),
      // σ bands — use session_analysis close_vs_vwap for rolling 30-day StdDev
      dailyVwapSigma: await (async () => {
        const recent = await query(
          `SELECT close_vs_vwap FROM session_analysis WHERE trade_date >= $1::date - 30 AND trade_date < $1 AND close_vs_vwap IS NOT NULL ORDER BY trade_date DESC`, [date]);
        if (recent.rows.length < 10) return Math.round((price - vwap) / 111 * 10) / 10;
        const dists = recent.rows.map(r => r.close_vs_vwap);
        const mean = dists.reduce((a,b) => a+b, 0) / dists.length;
        const std = Math.sqrt(dists.reduce((s, d) => s + (d - mean) ** 2, 0) / dists.length);
        return std > 0 ? Math.round((price - vwap) / std * 10) / 10 : 0;
      })(),
      weeklyVwap: await (async () => {
        const dow = new Date(date + 'T12:00:00').getDay();
        const mondayOffset = dow === 0 ? 6 : dow - 1;
        const monday = new Date(new Date(date + 'T12:00:00').getTime() - mondayOffset * 86400000).toISOString().slice(0, 10);
        const wb = await query(`SELECT high::float, low::float, close::float, volume::bigint as vol FROM price_bars_primary WHERE symbol='NQ' AND ts::date >= $1 AND ts::date <= $2 AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959 ORDER BY ts`, [monday, date]);
        if (wb.rows.length < 50) return null;
        let wPV=0,wV=0;
        for (const b of wb.rows) { wPV+=(b.high+b.low+b.close)/3*Number(b.vol||1); wV+=Number(b.vol||1); }
        return Math.round(wPV/wV);
      })(),
      weeklyVwapSigma: await (async () => {
        const dow = new Date(date + 'T12:00:00').getDay();
        const mondayOffset = dow === 0 ? 6 : dow - 1;
        const monday = new Date(new Date(date + 'T12:00:00').getTime() - mondayOffset * 86400000).toISOString().slice(0, 10);
        const wb = await query(`SELECT high::float, low::float, close::float, volume::bigint as vol FROM price_bars_primary WHERE symbol='NQ' AND ts::date >= $1 AND ts::date <= $2 AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959 ORDER BY ts`, [monday, date]);
        if (wb.rows.length < 50) return null;
        let wPV=0,wV=0;
        for (const b of wb.rows) { wPV+=(b.high+b.low+b.close)/3*Number(b.vol||1); wV+=Number(b.vol||1); }
        const wVwap = wPV/wV;
        // Rolling weekly VWAP StdDev from trailing 12-week distribution (no static 251pt)
        const trailingWkDists = await getTrailingWeeklyVwapDists(date, 12);
        const wkStd = trailingWkDists.length >= 8
          ? rollingStats(trailingWkDists).std
          : 251; // fallback if insufficient data
        return wkStd > 0 ? Math.round((price - wVwap) / wkStd * 10) / 10 : 0;
      })(),
      weeklyVwapStd: await (async () => {
        const trailingWkDists = await getTrailingWeeklyVwapDists(date, 12);
        return trailingWkDists.length >= 8 ? Math.round(rollingStats(trailingWkDists).std) : 251;
      })(),
    });
  } catch (err) {
    console.error('[live-session-context]', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/trade-alerts/:date', async (req, res) => {
  try {
    const { date } = req.params;
    const barsRes = await query(
      `SELECT (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts))::int as et_min,
              open::float, high::float, low::float, close::float, volume::bigint as vol
       FROM price_bars_primary WHERE symbol='NQ' AND ts::date=$1
       AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959 ORDER BY ts`, [date]);
    const b = barsRes.rows;
    if (b.length < 10) return res.json({ alerts: [] });
    const price = b[b.length - 1].close;

    const pdRes = await query(
      `SELECT poc::float, vah::float, val::float, session_high::float as hi, session_low::float as lo
       FROM developing_value_log WHERE trade_date < $1 ORDER BY trade_date DESC LIMIT 1`, [date]);
    const pd = pdRes.rows[0];

    let cumPV = 0, cumV = 0;
    for (const bar of b) { cumPV += (bar.high + bar.low + bar.close) / 3 * Number(bar.vol || 1); cumV += Number(bar.vol || 1); }
    const vwap = cumPV / cumV;
    const sessHi = Math.max(...b.map(x => x.high)), sessLo = Math.min(...b.map(x => x.low));
    const alertsVwapStd = await getTrailingVwapStd(date, 30);
    const vwapThreshold = alertsVwapStd.threshold;

    const onRes = await query(
      `SELECT MAX(high)::float as hi, MIN(low)::float as lo FROM price_bars_primary
       WHERE symbol='NQ' AND ts::date=$1
       AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) NOT BETWEEN 570 AND 959`, [date]);
    const onLo = onRes.rows[0]?.lo, onHi = onRes.rows[0]?.hi;

    const alerts = [];
    const etMin = b[b.length - 1].et_min;
    const h = Math.floor(etMin / 60), m = etMin % 60;
    const timeStr = `${h}:${String(m).padStart(2, '0')}`;

    if (pd?.poc && Math.abs(price - pd.poc) <= 10) {
      const dir = price > pd.poc ? 'SHORT' : 'LONG';
      alerts.push({ id: 'poc', type: 'POC_MAGNET', msg: `POC MAGNET: ${Math.round(price)} at PD POC ${Math.round(pd.poc)}. Fade ${dir}. 66% WR, 20pt target, 25pt stop. [Backtested N=402, 2022–2026, +10% vs baseline]`, time: timeStr, color: dir === 'LONG' ? '#4ade80' : '#ef4444' });
    }

    // Daily VWAP σ alert
    const dailySigma = await (async () => {
      const recent = await query(`SELECT close_vs_vwap FROM session_analysis WHERE trade_date >= $1::date - 30 AND trade_date < $1 AND close_vs_vwap IS NOT NULL`, [date]).catch(() => ({ rows: [] }));
      if (recent.rows.length < 10) return Math.abs(price - vwap) / 111;
      const dists = recent.rows.map(r => r.close_vs_vwap);
      const mean = dists.reduce((a,b) => a+b, 0) / dists.length;
      const std = Math.sqrt(dists.reduce((s, d) => s + (d - mean) ** 2, 0) / dists.length);
      return std > 0 ? (price - vwap) / std : 0;
    })();
    if (Math.abs(dailySigma) >= 1.5) {
      const dir = dailySigma > 0 ? 'SHORT' : 'LONG';
      alerts.push({ id: 'vwapDaily', type: 'DAILY_VWAP', msg: `DAILY VWAP: ${dailySigma > 0 ? '+' : ''}${dailySigma.toFixed(1)}σ (${Math.round(Math.abs(price - vwap))}pt). Fade ${dir} toward ${Math.round(vwap)}. 62% WR.`, time: timeStr, color: dir === 'LONG' ? '#4ade80' : '#ef4444' });
    }

    // 24hr VWAP σ alert (Globex session)
    const globexBars = await query(
      `SELECT high::float, low::float, close::float, volume::bigint as vol
       FROM price_bars_primary WHERE symbol='NQ' AND (
         (ts::date = $1::date - 1 AND EXTRACT(hour FROM ts) >= 18) OR
         (ts::date = $1 AND EXTRACT(hour FROM ts) < 17)
       ) ORDER BY ts`, [date]).catch(() => ({ rows: [] }));
    if (globexBars.rows.length > 50) {
      let pv24 = 0, v24 = 0;
      for (const gb of globexBars.rows) { pv24 += (gb.high + gb.low + gb.close) / 3 * Number(gb.vol || 1); v24 += Number(gb.vol || 1); }
      const vwap24hr = pv24 / v24;
      // Rolling 30-day std of close-vs-24hr-VWAP distances (no static 130pt)
      const trailing24hrDistsAlerts = await getTrailing24hrVwapDists(date, 30);
      const vwap24StdAlerts = trailing24hrDistsAlerts.length >= MIN_SAMPLES
        ? rollingStats(trailing24hrDistsAlerts).std : 130;
      const sigma24 = vwap24StdAlerts > 0 ? (price - vwap24hr) / vwap24StdAlerts : 0;
      if (Math.abs(sigma24) >= 1.5) {
        const dir = sigma24 > 0 ? 'SHORT' : 'LONG';
        alerts.push({ id: 'vwap24', type: '24HR_VWAP', msg: `24HR VWAP: ${sigma24 > 0 ? '+' : ''}${sigma24.toFixed(1)}σ (${Math.round(Math.abs(price - vwap24hr))}pt). Fade ${dir} toward ${Math.round(vwap24hr)}.`, time: timeStr, color: dir === 'LONG' ? '#4ade80' : '#ef4444' });
      }
    }

    // Weekly VWAP σ alert
    const dow = new Date(date + 'T12:00:00').getDay();
    const mondayOffset = dow === 0 ? 6 : dow - 1;
    const monday = new Date(new Date(date + 'T12:00:00').getTime() - mondayOffset * 86400000).toISOString().slice(0, 10);
    const weekBarsQ = await query(`SELECT high::float, low::float, close::float, volume::bigint as vol FROM price_bars_primary WHERE symbol='NQ' AND ts::date >= $1 AND ts::date <= $2 AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959 ORDER BY ts`, [monday, date]).catch(() => ({ rows: [] }));
    if (weekBarsQ.rows.length > 50) {
      let wPV = 0, wV = 0;
      for (const wb of weekBarsQ.rows) { wPV += (wb.high + wb.low + wb.close) / 3 * Number(wb.vol || 1); wV += Number(wb.vol || 1); }
      const weeklyVwap = wPV / wV;
      // Rolling weekly VWAP StdDev from trailing 12-week distribution (no static 251pt)
      const trailingWkDistsAlerts = await getTrailingWeeklyVwapDists(date, 12);
      const wkStdAlerts = trailingWkDistsAlerts.length >= 8
        ? rollingStats(trailingWkDistsAlerts).std : 251;
      const weeklySigma = wkStdAlerts > 0 ? (price - weeklyVwap) / wkStdAlerts : 0;
      if (Math.abs(weeklySigma) >= 1.5) {
        const dir = weeklySigma > 0 ? 'SHORT' : 'LONG';
        alerts.push({ id: 'vwapWeekly', type: 'WEEKLY_VWAP', msg: `WEEKLY VWAP: ${weeklySigma > 0 ? '+' : ''}${weeklySigma.toFixed(1)}σ (${Math.round(Math.abs(price - weeklyVwap))}pt). ${Math.abs(weeklySigma) >= 2 ? 'Rare event (N<20 in 4yr history) — no verified WR. ' : ''}Structural context: extended from weekly VWAP. Fade ${dir} toward ${Math.round(weeklyVwap)}.`, time: timeStr, color: dir === 'LONG' ? '#4ade80' : '#ef4444' });
      }
    }

    if (pd?.val && price < pd.val - 10) {
      alerts.push({ id: 'valBreak', type: 'VAL_BREAK', msg: `2D VAL BROKEN at ${Math.round(price)}. Next: PD Low ${Math.round(pd.lo)}. Short rallies.`, time: timeStr, color: '#f87171' });
    }

    if (pd?.vah && price > pd.vah + 10) {
      alerts.push({ id: 'vahBreak', type: 'VAH_BREAK', msg: `2D VAH BROKEN at ${Math.round(price)}. Long pullbacks to ${Math.round(pd.vah)}.`, time: timeStr, color: '#4ade80' });
    }

    if (onLo) {
      const recent = b.slice(-8);
      if (recent.some(x => x.low < onLo - 3) && price > onLo + 5) {
        let conf = pd?.val && Math.abs(onLo - pd.val) <= 40 ? ` Conf: 2D VAL ${Math.round(pd.val)}` : '';
        alerts.push({ id: 'onlSweep', type: 'STOP_SWEEP', msg: `ONL SWEPT ${Math.round(Math.min(...recent.map(x => x.low)))}, bounce ${Math.round(price)}. LONG. Stop below sweep.${conf}`, time: timeStr, color: '#22c55e' });
      }
    }

    if (onHi) {
      const recent = b.slice(-8);
      if (recent.some(x => x.high > onHi + 3) && price < onHi - 5) {
        let conf = pd?.vah && Math.abs(onHi - pd.vah) <= 40 ? ` Conf: 2D VAH ${Math.round(pd.vah)}` : '';
        alerts.push({ id: 'onhSweep', type: 'STOP_SWEEP', msg: `ONH SWEPT ${Math.round(Math.max(...recent.map(x => x.high)))}, fading ${Math.round(price)}. SHORT. Stop above sweep.${conf}`, time: timeStr, color: '#ef4444' });
      }
    }

    // Volume spike detection — time-of-day σ baseline
    const orBars = b.filter(x => x.et_min >= 570 && x.et_min < 575);
    const orH = orBars.length ? Math.max(...orBars.map(x => x.high)) : null;
    const orL = orBars.length ? Math.min(...orBars.map(x => x.low)) : null;
    const ibBarsA = b.filter(x => x.et_min >= 570 && x.et_min < 630);
    const ibH = ibBarsA.length ? Math.max(...ibBarsA.map(x => x.high)) : null;
    const ibL = ibBarsA.length ? Math.min(...ibBarsA.map(x => x.low)) : null;

    // Get time-of-day volume baseline for recent bars
    const recentBars = b.slice(-5);
    const todBaselineRes = await query(
      `SELECT (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts))::int as et_min,
              AVG(volume::float) as avg_vol, STDDEV(volume::float) as std_vol
       FROM price_bars_primary WHERE symbol='NQ'
       AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN $1 AND $2
       AND ts::date >= $3::date - 90 AND ts::date < $3
       GROUP BY et_min`, [
      Math.min(...recentBars.map(x => x.et_min)),
      Math.max(...recentBars.map(x => x.et_min)),
      date
    ]).catch(() => ({ rows: [] }));
    const volBaseline = {};
    for (const r of todBaselineRes.rows) volBaseline[r.et_min] = { avg: r.avg_vol, std: r.std_vol };

    // Check last 5 bars for volume spikes vs time-of-day baseline
    let maxSigma = 0, spikeBar = null;
    for (const bar of recentBars) {
      const bl = volBaseline[bar.et_min];
      if (!bl || bl.std <= 0) continue;
      const sigma = (Number(bar.vol) - bl.avg) / bl.std;
      if (sigma > maxSigma) { maxSigma = sigma; spikeBar = bar; }
    }

    if (maxSigma >= 1.0 && spikeBar) {
      const bl = volBaseline[spikeBar.et_min];
      const ratio = Number(spikeBar.vol) / bl.avg;
      const nearLevel = [pd?.poc, pd?.vah, pd?.val, orH, orL, ibH, ibL].filter(Boolean)
        .find(l => Math.abs(price - l) <= 20);
      const levelNote = nearLevel ? ` at ${Math.round(nearLevel)}` : '';
      const sigLabel = maxSigma >= 2.0 ? 'EXTREME' : 'ELEVATED';
      const barDir = spikeBar.close > spikeBar.open ? 'buying' : 'selling';
      alerts.push({
        id: 'volSpike',
        type: 'VOLUME_SPIKE',
        msg: `VOL ${sigLabel}: +${maxSigma.toFixed(1)}σ above normal (${ratio.toFixed(1)}x avg for this time)${levelNote}. ${barDir.toUpperCase()} pressure.`,
        time: timeStr,
        color: barDir === 'buying' ? '#4ade80' : '#ef4444'
      });
    }

    // Level exhaustion/absorption detection — delta divergence at key levels
    // Dynamic proximity: use 5% of developing range (median distance to level ~46pt on 400pt range days)
    // Compute rolling levels for exhaustion detection
    const ib10Alert = await query(`
      SELECT MAX(ibh) as hi, MIN(ibl) as lo FROM (
        SELECT ts::date as d, MAX(high)::float as ibh, MIN(low)::float as ibl
        FROM price_bars_primary WHERE symbol='NQ'
        AND ts::date >= $1::date - 14 AND ts::date < $1
        AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 630
        GROUP BY ts::date ORDER BY d DESC LIMIT 10
      ) t`, [date]).catch(() => ({ rows: [{}] }));
    const ib10MidAlert = ib10Alert.rows[0]?.hi ? (ib10Alert.rows[0].hi + ib10Alert.rows[0].lo) / 2 : null;

    // Midpoint levels (today's OR/IB mid + prior-day OR/IB/session mid)
    const orMid = orH && orL ? (orH + orL) / 2 : null;
    const ibMid = ibH && ibL ? (ibH + ibL) / 2 : null;
    const pdIbResAlert = await query(`
      SELECT MAX(high)::float as ibh, MIN(low)::float as ibl
      FROM price_bars_primary WHERE symbol='NQ' AND ts::date = (
        SELECT MAX(ts::date) FROM price_bars_primary WHERE symbol='NQ' AND ts::date < $1
        AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 630
      ) AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 630`, [date]).catch(() => ({ rows: [{}] }));
    const pdIbMid = pdIbResAlert.rows[0]?.ibh ? (pdIbResAlert.rows[0].ibh + pdIbResAlert.rows[0].ibl) / 2 : null;
    const pdOrResAlert = await query(`SELECT or_high::float, or_low::float FROM acd_daily_log WHERE trade_date < $1 ORDER BY trade_date DESC LIMIT 1`, [date]).catch(() => ({ rows: [{}] }));
    const pdOrMid = pdOrResAlert.rows[0]?.or_high ? (pdOrResAlert.rows[0].or_high + pdOrResAlert.rows[0].or_low) / 2 : null;
    const pdSessMid = pd?.hi && pd?.lo ? (pd.hi + pd.lo) / 2 : null;

    const levelDefs = [
      { name: 'PD POC', val: pd?.poc, fadeDir: null },
      { name: 'PD VAH', val: pd?.vah, fadeDir: 'SHORT' },
      { name: 'PD VAL', val: pd?.val, fadeDir: 'LONG' },
      { name: 'OR High', val: orH, fadeDir: 'SHORT' },
      { name: 'OR Low', val: orL, fadeDir: 'LONG' },
      { name: 'OR MID', val: orMid, fadeDir: null },
      { name: 'IB High', val: ibH, fadeDir: 'SHORT' },
      { name: 'IB Low', val: ibL, fadeDir: 'LONG' },
      { name: 'IB MID', val: ibMid, fadeDir: null },
      { name: 'PD IB MID', val: pdIbMid, fadeDir: null },
      { name: 'PD OR MID', val: pdOrMid, fadeDir: null },
      { name: 'PD SESSION MID', val: pdSessMid, fadeDir: null },
      { name: '10D IB MID', val: ib10MidAlert, fadeDir: null },
    ].filter(l => l.val != null);
    const devRange = sessHi - sessLo;
    const proximityThreshold = Math.max(30, Math.round(devRange * 0.12));

    // Compute divergence stretch: 30-bar price move vs 30-bar delta move
    if (b.length >= 30) {
      const recent30 = b.slice(-30);
      const priceMove30 = recent30[recent30.length-1].close - recent30[0].close;
      let delta30 = 0;
      for (const bar of recent30) {
        const rng = bar.high - bar.low;
        const bp = rng > 0 ? Math.abs(bar.close - bar.open) / rng : 0;
        delta30 += (bar.close >= bar.open ? 1 : -1) * Number(bar.vol || 0) * Math.max(bp, 0.3);
      }
      const stretchPct = devRange > 0 ? Math.abs(priceMove30) / devRange * 100 : 0;
      const priceFalling = priceMove30 < -10;
      const priceRising = priceMove30 > 10;
      const deltaBuying = delta30 > 500;
      const deltaSelling = delta30 < -500;
      const bullishDivergence = priceFalling && deltaBuying;
      const bearishDivergence = priceRising && deltaSelling;

      // Collect nearby levels with divergence, then emit ONE grouped alert
      const nearBull = [], nearBear = [];
      for (const lv of levelDefs) {
        if (Math.abs(price - lv.val) > proximityThreshold) continue;
        if (bullishDivergence && (lv.fadeDir === 'LONG' || lv.fadeDir === null)) nearBull.push(lv);
        if (bearishDivergence && (lv.fadeDir === 'SHORT' || lv.fadeDir === null)) nearBear.push(lv);
      }

      if (nearBull.length > 0) {
        const names = nearBull.map(l => `${l.name} (${Math.round(l.val)})`).join(' + ');
        const isTriple = nearBull.length >= 3;
        const isDouble = nearBull.length >= 2;
        const prefix = isTriple ? 'TRIPLE CONFLUENCE' : isDouble ? 'DOUBLE CONFLUENCE' : (stretchPct >= 10 ? 'STRONG EXHAUSTION' : 'EXHAUSTION');
        const wrNote = isTriple ? '65% WR at triple confluence (N=112)' : stretchPct >= 10 ? '62% WR at this stretch (N=437)' : '59% WR (N=907)';
        alerts.push({
          id: 'exhaust-grouped',
          type: isTriple ? 'TRIPLE_CONFLUENCE' : isDouble ? 'DOUBLE_CONFLUENCE' : 'LEVEL_EXHAUSTION',
          msg: `${prefix}: Sellers exhausting at ${names}. Stretch ${stretchPct.toFixed(0)}% of range. FADE LONG. ${wrNote}.`,
          time: timeStr,
          color: isTriple ? '#22c55e' : '#4ade80',
        });
      }

      if (nearBear.length > 0) {
        const names = nearBear.map(l => `${l.name} (${Math.round(l.val)})`).join(' + ');
        const isTriple = nearBear.length >= 3;
        const isDouble = nearBear.length >= 2;
        const prefix = isTriple ? 'TRIPLE CONFLUENCE' : isDouble ? 'DOUBLE CONFLUENCE' : (stretchPct >= 10 ? 'STRONG ABSORPTION' : 'ABSORPTION');
        const wrNote = isTriple ? '65% WR at triple confluence (N=112)' : stretchPct >= 10 ? '62% WR at this stretch (N=437)' : '59% WR (N=907)';
        alerts.push({
          id: 'absorb-grouped',
          type: isTriple ? 'TRIPLE_CONFLUENCE' : isDouble ? 'DOUBLE_CONFLUENCE' : 'LEVEL_ABSORPTION',
          msg: `${prefix}: Buyers exhausting at ${names}. Stretch ${stretchPct.toFixed(0)}% of range. FADE SHORT. ${wrNote}.`,
          time: timeStr,
          color: isTriple ? '#dc2626' : '#ef4444',
        });
      }

      // Standalone divergence alert — fires when stretch is significant, no level required
      if (stretchPct >= 15 && bullishDivergence) {
        alerts.push({
          id: 'divBullish',
          type: 'DELTA_DIVERGENCE',
          msg: `BUYERS ABSORBING: Price down ${Math.abs(Math.round(priceMove30))}pt but delta rising. Stretch ${stretchPct.toFixed(0)}% of range. Rally losing steam — watch for reversal UP.`,
          time: timeStr,
          color: '#4ade80',
        });
      }
      if (stretchPct >= 15 && bearishDivergence) {
        alerts.push({
          id: 'divBearish',
          type: 'DELTA_DIVERGENCE',
          msg: `SELLERS DISTRIBUTING: Price up ${Math.round(priceMove30)}pt but delta falling. Stretch ${stretchPct.toFixed(0)}% of range. Rally unsupported — watch for reversal DOWN.`,
          time: timeStr,
          color: '#ef4444',
        });
      }
    }

    // 4hr Fisher divergence check
    try {
      const divRes = await new Promise((resolve) => {
        const url = `/morning-brief/divergence-4hr/${date}`;
        // Internal call — reuse the endpoint logic
        const divReq = { params: { date } };
        const divResObj = { json: (data) => resolve(data) };
        // Direct computation instead of HTTP call
        resolve(null); // will be populated below
      });
    } catch (_) {}
    // Inline 4hr divergence check for alerts
    const divBars = await query(
      `SELECT ts::date::text as td, (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts))::int as et_min,
              open::float, high::float, low::float, close::float
       FROM price_bars_primary WHERE symbol='NQ' AND ts::date >= $1::date - 10 AND ts::date <= $1
       ORDER BY ts`, [date]).catch(() => ({ rows: [] }));
    if (divBars.rows.length > 200) {
      const fhb = [];
      const dates = [...new Set(divBars.rows.map(r => r.td))];
      for (const dd of dates) {
        const db = divBars.rows.filter(r => r.td === dd);
        for (const bk of [0, 240, 480, 720, 960, 1200]) {
          const bb = db.filter(x => x.et_min >= bk && x.et_min < bk + 240);
          if (bb.length < 5) continue;
          fhb.push({ close: bb[bb.length-1].close, high: Math.max(...bb.map(x=>x.high)), low: Math.min(...bb.map(x=>x.low)) });
        }
      }
      if (fhb.length >= 20) {
        let pFF = 0, pVV = 0;
        const fArr = [];
        for (let i = 0; i < fhb.length; i++) {
          const hl = (fhb[i].high + fhb[i].low) / 2;
          const ss = Math.max(0, i - 9);
          let hh = -Infinity, ll = Infinity;
          for (let j = ss; j <= i; j++) { const m = (fhb[j].high + fhb[j].low) / 2; hh = Math.max(hh, m); ll = Math.min(ll, m); }
          const rr = hh - ll;
          let vv = rr > 0 ? 0.33 * 2 * ((hl - ll) / rr - 0.5) + 0.67 * pVV : 0;
          vv = Math.max(-0.999, Math.min(0.999, vv));
          const ft = 0.5 * Math.log((1 + vv) / (1 - vv)) + 0.5 * pFF;
          fArr.push(ft);
          pFF = ft; pVV = vv;
        }
        // Check last 3 four-hour bars for divergence (not just the final one)
        for (let ci = Math.max(20, fhb.length - 3); ci < fhb.length; ci++) {
          const rec = fhb.slice(ci - 20, ci + 1).map(x => x.close);
          const rHi = Math.max(...rec), rLo = Math.min(...rec), rR = rHi - rLo;
          if (rR < 50) continue;
          const pp = fhb[ci].close;
          const pcc = (pp - rLo) / rR;
          if (pcc < 0.35 && fArr[ci] < 0) {
            const prLo = Math.min(...rec.slice(0, 15));
            const prIdx = rec.indexOf(prLo);
            const prF = fArr.slice(Math.max(0, ci - 15), ci);
            if (pp <= prLo * 1.015 && fArr[ci] > (prF[prIdx] || 0) + 0.1) {
              alerts.push({ id: 'div4hr', type: '4HR_DIVERGENCE', msg: `4HR BULLISH DIVERGENCE: Fisher ${fArr[ci].toFixed(2)} diverging at ${Math.round(pp)}. 89% bounce 100pt+ (N=91, +10% vs baseline). Wait for intraday confirmation.`, time: timeStr, color: '#4ade80' });
              break;
            }
          }
          if (pcc > 0.65 && fArr[ci] > 0) {
            const prHi = Math.max(...rec.slice(0, 15));
            const prIdx = rec.indexOf(prHi);
            const prF = fArr.slice(Math.max(0, ci - 15), ci);
            if (pp >= prHi * 0.985 && fArr[ci] < (prF[prIdx] || 0) - 0.1) {
              alerts.push({ id: 'div4hr', type: '4HR_DIVERGENCE', msg: `4HR BEARISH DIVERGENCE: Fisher ${fArr[ci].toFixed(2)} diverging at ${Math.round(pp)}. 74.6% drop 100pt+ but baseline is 75% — no directional edge. Structural context only.`, time: timeStr, color: '#ef4444' });
              break;
            }
          }
        }
      }
    }

    // Include fired setups — ACTIVE + recently resolved (within 5 min) so fast setups aren't invisible
    // Consolidate sequential setups (OPEN_DRIVE + IB_BEARISH = confirmation, not separate alerts)
    const setupsRes = await query(
      `SELECT id, setup_type, fired_at, expires_at, status, resolution,
              entry_zone_low::float, stop_level::float, t1_level::float, t1_label,
              historical_win_rate::float, historical_sessions, updated_at
       FROM active_setups WHERE trade_date=$1 AND (
         status='ACTIVE' OR
         (status='RESOLVED' AND updated_at >= NOW() - INTERVAL '5 minutes')
       )
       ORDER BY fired_at`, [date]).catch(() => ({ rows: [] }));
    const activeTypes = setupsRes.rows.map(s => s.setup_type);
    const shortChain = ['OPEN_DRIVE_SHORT', 'OPEN_TEST_DRIVE_SHORT', 'IB_BEARISH'];
    const longChain = ['OPEN_DRIVE_LONG', 'OPEN_TEST_DRIVE_LONG', 'IB_BULLISH', 'TRT_LONG'];
    const firedShorts = shortChain.filter(t => activeTypes.includes(t));
    const firedLongs = longChain.filter(t => activeTypes.includes(t));
    const confirmedSetups = new Set();
    if (firedShorts.length > 1) for (const t of firedShorts.slice(1)) confirmedSetups.add(t);
    if (firedLongs.length > 1) for (const t of firedLongs.slice(1)) confirmedSetups.add(t);

    for (const s of setupsRes.rows) {
      const isLong = s.setup_type.includes('LONG') || s.setup_type.includes('BULLISH');
      const dir = isLong ? 'LONG' : 'SHORT';
      const isConfirmation = confirmedSetups.has(s.setup_type);
      const isResolved = s.status === 'RESOLVED';
      const wr = s.historical_win_rate != null ? `${(s.historical_win_rate * 100).toFixed(0)}% WR` : '';
      const n = s.historical_sessions != null ? `N=${s.historical_sessions}` : '';
      const stats = [wr, n].filter(Boolean).join(', ');
      const entry = s.entry_zone_low != null ? Math.round(s.entry_zone_low) : '?';
      const stop = s.stop_level != null ? Math.round(s.stop_level) : null;
      const t1 = s.t1_level != null ? Math.round(s.t1_level) : null;
      const levels = [`Entry ${entry}`, stop && `Stop ${stop}`, t1 && `T1 ${t1}`].filter(Boolean).join(' · ');
      const firedTime = s.fired_at ? new Date(s.fired_at).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }) : '';
      const prefix = isConfirmation ? 'CONFIRMS: ' : isResolved ? `${s.resolution === 'TARGET_HIT' ? 'WON' : 'LOST'}: ` : '';
      alerts.push({
        id: `setup-${s.setup_type}`,
        type: isResolved ? (s.resolution === 'TARGET_HIT' ? 'SETUP_WON' : 'SETUP_LOST') : isConfirmation ? 'SETUP_CONFIRMED' : 'SETUP_FIRED',
        msg: `${prefix}${s.setup_type.replace(/_/g, ' ')}: ${dir}. ${levels}. ${stats}`,
        time: firedTime,
        color: isResolved ? (s.resolution === 'TARGET_HIT' ? '#4ade80' : '#f87171') : isLong ? '#4ade80' : '#ef4444',
        isSetup: true,
      });
    }

    // Flush risk alert (score >= 3)
    try {
      const flushRes = await fetch(`http://localhost:${process.env.PORT || 3002}/api/morning-brief/flush-risk/${date}`);
      const flush = await flushRes.json();
      if (flush.score >= 3) {
        alerts.push({
          id: 'flushRisk',
          type: 'FLUSH_RISK',
          msg: `FLUSH RISK ${flush.score}/${flush.maxScore} (${flush.label}): ${flush.probability}% chance of 400pt+ move within 48hr. ${flush.triggers.map(t => t.name).join(', ')}.`,
          time: timeStr,
          color: flush.color,
        });
      }
    } catch (_) {}

    res.json({ alerts, price: Math.round(price), time: timeStr });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Flush Risk Score — ALL thresholds are dynamic σ from rolling means. No static numbers.
router.get('/flush-risk/:date', async (req, res) => {
  try {
    const { date } = req.params;
    const LOOKBACK = 90;

    // Get trailing daily OHLC for rolling stats
    const dailyBars = await query(`
      SELECT d, open, high, low, close, range, vol FROM (
        SELECT ts::date::text as d,
               (array_agg(open ORDER BY ts))[1]::float as open,
               MAX(high)::float as high, MIN(low)::float as low,
               (array_agg(close ORDER BY ts DESC))[1]::float as close,
               (MAX(high) - MIN(low))::float as range,
               SUM(volume)::float as vol
        FROM price_bars_primary WHERE symbol='NQ'
        AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
        AND ts::date <= $1::date
        GROUP BY ts::date ORDER BY d DESC LIMIT $2
      ) t ORDER BY d`, [date, LOOKBACK]);
    const days = dailyBars.rows;
    if (days.length < 20) return res.json({ error: 'Not enough data', score: 0, triggers: [] });

    const mean = arr => arr.reduce((s, v) => s + v, 0) / arr.length;
    const std = arr => { const m = mean(arr); return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length); };
    const zScore = (val, arr) => { const s = std(arr); return s > 0 ? (val - mean(arr)) / s : 0; };

    const today = days[days.length - 1];
    const closes = days.map(d => d.close);
    const ranges = days.map(d => d.range);

    // 1. ATR ratio z-score — ATR5/ATR20 vs its own rolling distribution
    const atrRatios = [];
    for (let i = 19; i < days.length; i++) {
      const r5 = days.slice(i - 4, i + 1).reduce((s, d) => s + d.range, 0) / 5;
      const r20 = days.slice(i - 19, i + 1).reduce((s, d) => s + d.range, 0) / 20;
      atrRatios.push(r20 > 0 ? r5 / r20 : 1);
    }
    const atrRatio = atrRatios[atrRatios.length - 1];
    const atrZ = zScore(atrRatio, atrRatios);
    const atrTriggered = atrZ >= 1.0;

    // 2. Range z-score — today's range vs rolling distribution
    const rangeZ = zScore(today.range, ranges);
    const rangeTriggered = rangeZ >= 1.0;

    // 3. NL30 z-score — current NL30 vs its own rolling distribution
    const nlRes = await query(`
      SELECT trade_date::text as d, daily_score FROM acd_daily_log
      WHERE trade_date <= $1 ORDER BY trade_date DESC LIMIT $2`, [date, LOOKBACK]);
    const nlScores = nlRes.rows.reverse();
    const nl30Vals = [];
    for (let i = 29; i < nlScores.length; i++) {
      nl30Vals.push(nlScores.slice(i - 29, i + 1).reduce((s, r) => s + r.daily_score, 0));
    }
    const nl30 = nl30Vals.length ? nl30Vals[nl30Vals.length - 1] : 0;
    const nlZ = nl30Vals.length > 5 ? zScore(Math.abs(nl30), nl30Vals.map(Math.abs)) : 0;
    const nlTriggered = nlZ >= 1.0;

    // 4. Consecutive directional days z-score
    // Compute streak length for each day in the lookback
    const streaks = [];
    for (let i = 1; i < days.length; i++) {
      let streak = 0;
      const dir = days[i].close > days[i - 1].close ? 1 : -1;
      for (let j = i; j >= 1; j--) {
        const d = days[j].close > days[j - 1].close ? 1 : -1;
        if (d === dir) streak++; else break;
      }
      streaks.push(streak);
    }
    const consec = streaks[streaks.length - 1] || 0;
    const consecZ = streaks.length > 5 ? zScore(consec, streaks) : 0;
    const consecTriggered = consecZ >= 1.0;

    // 5. Gap instability z-score — 5-day gap count vs rolling distribution
    const gapCounts = [];
    for (let i = 5; i < days.length; i++) {
      let gc = 0;
      for (let j = i - 4; j <= i; j++) {
        if (j > 0 && Math.abs(days[j].open - days[j - 1].close) > mean(ranges) * 0.1) gc++;
      }
      gapCounts.push(gc);
    }
    const gapCount = gapCounts.length ? gapCounts[gapCounts.length - 1] : 0;
    const gapZ = gapCounts.length > 5 ? zScore(gapCount, gapCounts) : 0;
    const gapTriggered = gapZ >= 1.0;

    // Composite score — each trigger fires at +1σ above its own rolling mean
    const triggers = [];
    if (atrTriggered) triggers.push({ name: 'ATR Expansion', value: `${atrRatio.toFixed(2)} (+${atrZ.toFixed(1)}σ)`, sigma: atrZ, weight: 'PRIMARY' });
    if (rangeTriggered) triggers.push({ name: 'Range Elevated', value: `${Math.round(today.range)}pt (+${rangeZ.toFixed(1)}σ)`, sigma: rangeZ });
    if (nlTriggered) triggers.push({ name: 'NL30 Extended', value: `${nl30} (+${nlZ.toFixed(1)}σ)`, sigma: nlZ });
    if (consecTriggered) triggers.push({ name: 'Directional Streak', value: `${consec}d (+${consecZ.toFixed(1)}σ)`, sigma: consecZ });
    if (gapTriggered) triggers.push({ name: 'Gap Instability', value: `${gapCount}/5d (+${gapZ.toFixed(1)}σ)`, sigma: gapZ });

    const score = triggers.length;

    // Composite sigma — average of triggered sigmas for probability weighting
    const avgSigma = triggers.length > 0 ? triggers.reduce((s, t) => s + t.sigma, 0) / triggers.length : 0;

    // Dynamic probability: use composite sigma to estimate flush risk
    // Base rate ~6%. Each σ of composite roughly doubles the risk.
    const baseProbability = 6;
    const probability = Math.min(95, Math.round(baseProbability * Math.pow(2, avgSigma * score / 3)));

    const label = score >= 5 ? 'EXTREME' : score >= 4 ? 'HIGH' : score >= 3 ? 'MODERATE-HIGH' : score >= 2 ? 'MODERATE' : 'LOW';
    const color = score >= 4 ? '#ef4444' : score >= 3 ? '#fb923c' : score >= 2 ? '#fbbf24' : '#4ade80';

    const notes = [];
    if (atrTriggered) notes.push(`Volatility expanding at +${atrZ.toFixed(1)}σ — recent ranges accelerating above rolling average.`);
    if (gapTriggered) notes.push(`Gap instability at +${gapZ.toFixed(1)}σ — market can't hold value overnight.`);
    if (consecTriggered) notes.push(`${consec}-day directional streak at +${consecZ.toFixed(1)}σ — momentum building toward exhaustion.`);
    if (nlTriggered) notes.push(`NL30 at ${nl30} (+${nlZ.toFixed(1)}σ extended) — directional pressure elevated.`);
    if (rangeTriggered) notes.push(`Today's range ${Math.round(today.range)}pt at +${rangeZ.toFixed(1)}σ — session was unusually wide.`);
    if (score >= 3) notes.push('Multiple σ triggers active. Prepare for directional day — widen stops, don\'t fade the open.');
    if (score < 2) notes.push('All metrics within 1σ of normal. Standard playbook applies.');

    res.json({
      score, maxScore: 5, label, color, probability,
      triggers, notes,
      metrics: {
        atrRatio: Math.round(atrRatio * 100) / 100, atrZ: Math.round(atrZ * 10) / 10,
        rangeZ: Math.round(rangeZ * 10) / 10,
        nl30, nlZ: Math.round(nlZ * 10) / 10,
        consecutiveDays: consec, consecZ: Math.round(consecZ * 10) / 10,
        gapFrequency: gapCount, gapZ: Math.round(gapZ * 10) / 10,
        todayRange: Math.round(today.range),
        atr5: Math.round(ranges.slice(-5).reduce((s,v)=>s+v,0)/5),
        atr20: Math.round(ranges.slice(-20).reduce((s,v)=>s+v,0)/20),
        avgSigma: Math.round(avgSigma * 10) / 10,
        lookback: LOOKBACK,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/dates', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT brief_date::text, created_at FROM morning_briefs ORDER BY brief_date DESC LIMIT 90`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:date?', async (req, res) => {
  try {
    let rows;
    if (req.params.date) {
      ({ rows } = await query(
        `SELECT brief_date::text, brief_text, structural_data, created_at
         FROM morning_briefs WHERE brief_date = $1`,
        [req.params.date]
      ));
    } else {
      ({ rows } = await query(
        `SELECT brief_date::text, brief_text, structural_data, created_at
         FROM morning_briefs ORDER BY brief_date DESC LIMIT 1`
      ));
    }
    res.json(rows[0] || null);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;

router.get('/divergence-4hr/:date', async (req, res) => {
  try {
    const { date } = req.params;
    
    // Build 4hr bars from last 10 days for Fisher computation
    const allBars = await query(
      `SELECT ts::date::text as td, (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts))::int as et_min,
              open::float, high::float, low::float, close::float
       FROM price_bars_primary WHERE symbol='NQ' AND ts::date >= $1::date - 10 AND ts::date <= $1
       ORDER BY ts`, [date]);
    
    if (allBars.rows.length < 200) return res.json({ divergence: null });

    const fourHourBars = [];
    const dates = [...new Set(allBars.rows.map(r => r.td))];
    for (const d of dates) {
      const dayBars = allBars.rows.filter(r => r.td === d);
      for (const bucket of [0, 240, 480, 720, 960, 1200]) {
        const barsInBucket = dayBars.filter(b => b.et_min >= bucket && b.et_min < bucket + 240);
        if (barsInBucket.length < 5) continue;
        fourHourBars.push({
          date: d, bucket,
          open: barsInBucket[0].open,
          high: Math.max(...barsInBucket.map(b => b.high)),
          low: Math.min(...barsInBucket.map(b => b.low)),
          close: barsInBucket[barsInBucket.length - 1].close,
        });
      }
    }

    if (fourHourBars.length < 20) return res.json({ divergence: null });

    // Fisher Transform
    const fp = 10;
    const fisher = [];
    let pF = 0, pV = 0;
    for (let i = 0; i < fourHourBars.length; i++) {
      const hl = (fourHourBars[i].high + fourHourBars[i].low) / 2;
      const s = Math.max(0, i - fp + 1);
      let hi = -Infinity, lo = Infinity;
      for (let j = s; j <= i; j++) { const m = (fourHourBars[j].high + fourHourBars[j].low) / 2; hi = Math.max(hi, m); lo = Math.min(lo, m); }
      const r = hi - lo;
      let v = r > 0 ? 0.33 * 2 * ((hl - lo) / r - 0.5) + 0.67 * pV : 0;
      v = Math.max(-0.999, Math.min(0.999, v));
      const ft = 0.5 * Math.log((1 + v) / (1 - v)) + 0.5 * pF;
      fisher.push({ idx: i, ft, price: fourHourBars[i].close, date: fourHourBars[i].date });
      pF = ft; pV = v;
    }

    // Check last 3 bars for divergence
    const last = fisher.length - 1;
    const recent = fourHourBars.slice(-20).map(b => b.close);
    const rHi = Math.max(...recent), rLo = Math.min(...recent), rR = rHi - rLo;
    if (rR < 50) return res.json({ divergence: null });

    const price = fourHourBars[last].close;
    const pct = (price - rLo) / rR;
    let divergence = null;

    // Bullish check
    if (pct < 0.30 && fisher[last].ft < 0) {
      const priorPrices = recent.slice(0, 12);
      const priorLow = Math.min(...priorPrices);
      const priorIdx = priorPrices.indexOf(priorLow);
      const priorFishers = fisher.slice(last - 12, last).map(f => f.ft);
      const priorFisherAtLow = priorFishers[priorIdx] || 0;
      if (price <= priorLow * 1.01 && fisher[last].ft > priorFisherAtLow + 0.15) {
        // Get nearby levels
        const pdRes = await query(`SELECT poc::float, vah::float, val::float, session_low::float as lo FROM developing_value_log WHERE trade_date <= $1 ORDER BY trade_date DESC LIMIT 1`, [date]);
        const pd = pdRes.rows[0];
        const nearLevels = [];
        if (pd?.val && Math.abs(price - pd.val) <= 60) nearLevels.push(`2D VAL ${Math.round(pd.val)}`);
        if (pd?.poc && Math.abs(price - pd.poc) <= 60) nearLevels.push(`2D POC ${Math.round(pd.poc)}`);
        if (pd?.lo && Math.abs(price - pd.lo) <= 60) nearLevels.push(`PD Low ${Math.round(pd.lo)}`);

        divergence = {
          type: 'BULLISH',
          price: Math.round(price),
          fisher: Math.round(fisher[last].ft * 100) / 100,
          rangePct: Math.round(pct * 100),
          nearLevels,
          stats: '89% bounce 100pt+ within 56hr (14×4hr bars). Control baseline: 79% — signal adds ~+10% edge. Avg MFE 369pt, Avg MAE 378pt. Wait for intraday confirmation. [Backtested N=91, 2022–2026]',
          confirmation: 'Look for: stop sweep + bounce, volume spike at level, micro trend shift to HIGHER_LOWS, or VWAP recapture attempt.',
        };
      }
    }

    // Bearish check
    if (!divergence && pct > 0.70 && fisher[last].ft > 0) {
      const priorPrices = recent.slice(0, 12);
      const priorHigh = Math.max(...priorPrices);
      const priorIdx = priorPrices.indexOf(priorHigh);
      const priorFishers = fisher.slice(last - 12, last).map(f => f.ft);
      const priorFisherAtHigh = priorFishers[priorIdx] || 0;
      if (price >= priorHigh * 0.99 && fisher[last].ft < priorFisherAtHigh - 0.15) {
        const pdRes = await query(`SELECT poc::float, vah::float, val::float, session_high::float as hi FROM developing_value_log WHERE trade_date <= $1 ORDER BY trade_date DESC LIMIT 1`, [date]);
        const pd = pdRes.rows[0];
        const nearLevels = [];
        if (pd?.vah && Math.abs(price - pd.vah) <= 60) nearLevels.push(`2D VAH ${Math.round(pd.vah)}`);
        if (pd?.poc && Math.abs(price - pd.poc) <= 60) nearLevels.push(`2D POC ${Math.round(pd.poc)}`);
        if (pd?.hi && Math.abs(price - pd.hi) <= 60) nearLevels.push(`PD High ${Math.round(pd.hi)}`);

        divergence = {
          type: 'BEARISH',
          price: Math.round(price),
          fisher: Math.round(fisher[last].ft * 100) / 100,
          rangePct: Math.round(pct * 100),
          nearLevels,
          stats: '74.6% drop 100pt+ within 88hr (22×4hr bars). Control baseline: 75% — NO edge over base rate. Bearish signal fires often but does not predict direction. Avg MFE 343pt, Avg MAE 404pt. Structural context only — do not trade directionally. [Backtested N=268, 2022–2026]',
          confirmation: 'Look for: failed breakout above level, volume climax at high, micro trend shift to LOWER_LOWS.',
        };
      }
    }

    res.json({ divergence, fisherValue: Math.round(fisher[last].ft * 100) / 100, price: Math.round(price) });
  } catch (err) {
    console.error('[divergence-4hr]', err);
    res.status(500).json({ error: err.message });
  }
});
