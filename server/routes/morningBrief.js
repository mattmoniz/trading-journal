import express from 'express';
import { query } from '../db.js';
import { getSessionForecast } from '../services/sessionForecastService.js';

const router = express.Router();

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

      const levels = [
        { name: 'PD_POC', price: pd?.poc }, { name: 'PD_VAH', price: pd?.vah }, { name: 'PD_VAL', price: pd?.val },
        { name: 'OR_HIGH', price: orH }, { name: 'OR_LOW', price: orL },
        { name: 'IB_HIGH', price: ibH }, { name: 'IB_LOW', price: ibL },
        { name: 'FLOOR_PIVOT', price: floorP }, { name: 'FLOOR_R1', price: floorR1 }, { name: 'FLOOR_S1', price: floorS1 },
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

    // 3. VWAP magnet trades (range-scaled: 25% of developing range, 30-bar cooldown)
    const vwapTrades = [];
    if (bars.length >= 60) {
      let cumPV = 0, cumV = 0;
      let lastVwapTrade = -30;
      let sessHi = bars[0].high, sessLo = bars[0].low;
      for (let i = 0; i < bars.length; i++) {
        cumPV += (bars[i].high + bars[i].low + bars[i].close) / 3 * Number(bars[i].vol || 1);
        cumV += Number(bars[i].vol || 1);
        sessHi = Math.max(sessHi, bars[i].high);
        sessLo = Math.min(sessLo, bars[i].low);
        const vwap = cumPV / cumV;
        if (i - lastVwapTrade < 30 || i < 60) continue;
        const devRange = sessHi - sessLo;
        const threshold = Math.max(50, Math.round(devRange * 0.25));
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

    // Rotations — 5-min close-to-close for meaningful swings
    const fiveMapRot = {};
    for (const b of bars) {
      const bk = Math.floor(b.et_min / 5) * 5;
      if (!fiveMapRot[bk]) fiveMapRot[bk] = { close: b.close };
      else fiveMapRot[bk].close = b.close;
    }
    const fbRot = Object.values(fiveMapRot);
    let rots = 0, lastExt = fbRot[0]?.close || 0, lastType = 'LOW';
    for (const b of fbRot) {
      if (b.close > lastExt && lastType === 'LOW' && b.close - lastExt >= 65) { rots++; lastExt = b.close; lastType = 'HIGH'; }
      if (b.close < lastExt && lastType === 'HIGH' && lastExt - b.close >= 65) { rots++; lastExt = b.close; lastType = 'LOW'; }
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

    // Session character assessment
    let sessionChar = 'DEVELOPING';
    if (etMin >= 630) {
      if (rots >= 20) sessionChar = 'CHOP';
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

    const nearLevels = [];
    if (pd?.poc && Math.abs(price - pd.poc) < 40) nearLevels.push({ name: '2D POC', price: Math.round(pd.poc), dist: Math.round(price - pd.poc) });
    if (pd?.vah && Math.abs(price - pd.vah) < 40) nearLevels.push({ name: '2D VAH', price: Math.round(pd.vah), dist: Math.round(price - pd.vah) });
    if (pd?.val && Math.abs(price - pd.val) < 40) nearLevels.push({ name: '2D VAL', price: Math.round(pd.val), dist: Math.round(price - pd.val) });
    if (orH && Math.abs(price - orH) < 40) nearLevels.push({ name: 'OR High', price: Math.round(orH), dist: Math.round(price - orH) });
    if (orL && Math.abs(price - orL) < 40) nearLevels.push({ name: 'OR Low', price: Math.round(orL), dist: Math.round(price - orL) });
    if (m1VA.vah && Math.abs(price - m1VA.vah) < 60) nearLevels.push({ name: '1M VAH', price: Math.round(m1VA.vah), dist: Math.round(price - m1VA.vah) });
    if (m1VA.val && Math.abs(price - m1VA.val) < 60) nearLevels.push({ name: '1M VAL', price: Math.round(m1VA.val), dist: Math.round(price - m1VA.val) });
    if (m3VA.vah && Math.abs(price - m3VA.vah) < 60) nearLevels.push({ name: '3M VAH', price: Math.round(m3VA.vah), dist: Math.round(price - m3VA.vah) });
    if (m3VA.val && Math.abs(price - m3VA.val) < 60) nearLevels.push({ name: '3M VAL', price: Math.round(m3VA.val), dist: Math.round(price - m3VA.val) });

    res.json({
      price: Math.round(price), openPrice: Math.round(openPrice),
      sessHi: Math.round(sessHi), sessLo: Math.round(sessLo),
      range: Math.round(range), rangePct, closeVsOpen,
      vwap: Math.round(vwap), vwapDist: Math.round(price - vwap),
      poc, pocDist: Math.round(price - poc),
      orH: orH ? Math.round(orH) : null, orL: orL ? Math.round(orL) : null,
      ibH: ibH ? Math.round(ibH) : null, ibL: ibL ? Math.round(ibL) : null,
      ibRange, ibBroken,
      rots, microTrend, volTrend, sessionChar, etMin,
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
        // Rolling 30-day weekly VWAP StdDev (fallback to fixed 251)
        return Math.round((price - wVwap) / 251 * 10) / 10;
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
    const vwapThreshold = Math.max(50, Math.round((sessHi - sessLo) * 0.25));

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
      alerts.push({ id: 'poc', type: 'POC_MAGNET', msg: `POC MAGNET: ${Math.round(price)} at PD POC ${Math.round(pd.poc)}. Fade ${dir}. 64% WR, 20pt target, 25pt stop.`, time: timeStr, color: '#a78bfa' });
    }

    if (Math.abs(price - vwap) >= vwapThreshold) {
      const dir = price > vwap ? 'SHORT' : 'LONG';
      alerts.push({ id: 'vwap', type: 'VWAP_MAGNET', msg: `VWAP MAGNET: ${Math.round(Math.abs(price - vwap))}pt extended. Fade ${dir} toward ${Math.round(vwap)}. 62% WR, 20T/30S.`, time: timeStr, color: '#818cf8' });
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

    // Volume spike detection at key levels
    const last20 = b.slice(-20);
    const avgVol = last20.reduce((s, bar) => s + Number(bar.vol || 0), 0) / last20.length;
    const lastBar = b[b.length - 1];
    const lastVol = Number(lastBar.vol || 0);
    const volRatio = avgVol > 0 ? lastVol / avgVol : 0;

    if (volRatio >= 2.5) {
      const nearLevel = [pd?.poc, pd?.vah, pd?.val, orH, orL, ibH, ibL].filter(Boolean)
        .find(l => Math.abs(price - l) <= 15);
      if (nearLevel) {
        alerts.push({
          id: 'volSpike',
          type: 'VOLUME_SPIKE',
          msg: `VOL SPIKE ${volRatio.toFixed(1)}x avg at ${Math.round(nearLevel)}. ${price > nearLevel ? 'Testing from above' : 'Testing from below'}. Watch for reversal or breakout confirmation.`,
          time: timeStr,
          color: '#f59e0b'
        });
      }
    }

    res.json({ alerts, price: Math.round(price), time: timeStr });
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
