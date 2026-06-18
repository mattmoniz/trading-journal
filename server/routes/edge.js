// Discovery Edge Analysis
// Full implementation extracted from server/index.js lines ~4083-4760

import express from 'express';
import { query } from '../db.js';

const router = express.Router();

router.get('/analysis/edge', async (req, res) => {
  try {
    const barsRes = await query(`
      SELECT date(ts) AS bar_date, ts,
             open::numeric, high::numeric, low::numeric, close::numeric,
             volume::integer, bid_volume::integer, ask_volume::integer
      FROM price_bars_primary
      WHERE symbol = 'NQ'
      ORDER BY ts ASC
    `);

    const byDate = {};
    for (const b of barsRes.rows) {
      const d = b.bar_date;
      if (!byDate[d]) byDate[d] = [];
      byDate[d].push(b);
    }
    const allDates = Object.keys(byDate).sort();

    const rth = bars => bars.filter(b => {
      const h = new Date(b.ts).getUTCHours(), m = new Date(b.ts).getUTCMinutes();
      return (h === 9 && m >= 30) || (h > 9 && h < 16);
    });
    const barMin = b => { const t = new Date(b.ts); return (t.getUTCHours()-9)*60 + t.getUTCMinutes() - 30; };
    const normCDF = z => {
      const a1=0.254829592,a2=-0.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=0.3275911;
      const s=z<0?-1:1,x=Math.abs(z)/Math.SQRT2,t=1/(1+p*x);
      return 0.5*(1+s*(1-(((((a5*t+a4)*t)+a3)*t+a2)*t+a1)*t*Math.exp(-x*x)));
    };
    const pval = (r,b,n) => {
      if (n<10||b<=0||b>=1) return null;
      return +(2*(1-normCDF(Math.abs((r-b)/Math.sqrt(b*(1-b)/n))))).toFixed(4);
    };

    const sessions = [];
    let rollingRanges = [], rollingVols = [];

    for (let di = 0; di < allDates.length; di++) {
      const date = allDates[di];
      const rthB = rth(byDate[date]);
      if (rthB.length < 30) continue;

      const ibB = rthB.filter(b => { const m = barMin(b); return m >= 0 && m < 60; });
      if (!ibB.length) continue;

      const ibH = Math.max(...ibB.map(b => +b.high));
      const ibL = Math.min(...ibB.map(b => +b.low));
      const ibRange = ibH - ibL;
      if (ibRange < 5) continue;

      const open = +rthB[0].open;
      const close = +rthB[rthB.length-1].close;
      const dayHi = Math.max(...rthB.map(b => +b.high));
      const dayLo = Math.min(...rthB.map(b => +b.low));
      const dayRange = dayHi - dayLo;
      const dayVol = rthB.reduce((s, b) => s+(b.volume||0), 0);
      const dayBid = rthB.reduce((s, b) => s+(b.bid_volume||0), 0);
      const dayAsk = rthB.reduce((s, b) => s+(b.ask_volume||0), 0);

      rollingRanges.push(dayRange); if (rollingRanges.length > 20) rollingRanges.shift();
      rollingVols.push(dayVol);     if (rollingVols.length > 20) rollingVols.shift();
      const avgRange = rollingRanges.reduce((a,b)=>a+b,0)/rollingRanges.length;
      const avgVol   = rollingVols.reduce((a,b)=>a+b,0)/rollingVols.length;

      const dow = new Date(date+'T12:00:00').getDay();
      const dayDir = close > open + 5 ? 'up' : close < open - 5 ? 'down' : 'flat';
      const trendDay = dayRange > 0 && (Math.abs(close-open)/dayRange) > 0.55;
      const volRatio = avgVol > 0 ? dayVol/avgVol : 1;
      const rangeRatio = avgRange > 0 ? dayRange/avgRange : 1;

      const SLOTS = 13;
      const slotBars = Array.from({length:SLOTS}, ()=>[]);
      for (const b of rthB) {
        const slot = Math.floor(barMin(b) / 30);
        if (slot >= 0 && slot < SLOTS) slotBars[slot].push(b);
      }
      const slotStats = slotBars.map(bs => {
        if (!bs.length) return null;
        const slotOpen = +bs[0].open;
        const slotClose = +bs[bs.length-1].close;
        const slotHi = Math.max(...bs.map(b=>+b.high));
        const slotLo = Math.min(...bs.map(b=>+b.low));
        const vol = bs.reduce((s,b)=>s+(b.volume||0),0);
        const bid = bs.reduce((s,b)=>s+(b.bid_volume||0),0);
        const ask = bs.reduce((s,b)=>s+(b.ask_volume||0),0);
        return {
          net: slotClose-slotOpen,
          range: slotHi-slotLo,
          vol, bid, ask,
          delta: ask-bid,
          dir: slotClose>slotOpen+2?'up':slotClose<slotOpen-2?'down':'flat'
        };
      });

      const first15 = rthB.filter(b => barMin(b) < 15);
      const drive15 = first15.length ? +first15[first15.length-1].close - open : 0;
      const drive15Dir = drive15 > 5 ? 'up' : drive15 < -5 ? 'down' : 'flat';

      const f30close = slotStats[0] ? open + slotStats[0].net : open;
      const f30dir = f30close > open+5 ? 'up' : f30close < open-5 ? 'down' : 'flat';

      const ibBid = ibB.reduce((s,b)=>s+(b.bid_volume||0),0);
      const ibAsk = ibB.reduce((s,b)=>s+(b.ask_volume||0),0);
      const ibDelta = ibAsk - ibBid;
      const ibDeltaDir = ibDelta > (ibBid+ibAsk)*0.03 ? 'buy' : ibDelta < -(ibBid+ibAsk)*0.03 ? 'sell' : 'neutral';

      const ibClose = ibB.length ? +ibB[ibB.length-1].close : open;
      const ibPriceDir = ibClose > open + 5 ? 'up' : ibClose < open - 5 ? 'down' : 'flat';

      const ibDeltaDivergence =
        (ibPriceDir === 'up'   && ibDeltaDir === 'sell') ? 'bearish_div' :
        (ibPriceDir === 'down' && ibDeltaDir === 'buy')  ? 'bullish_div' :
        (ibPriceDir === 'up'   && ibDeltaDir === 'buy')  ? 'bullish_conf':
        (ibPriceDir === 'down' && ibDeltaDir === 'sell') ? 'bearish_conf':
        'neutral';

      const ibDeltaStrength = (ibBid+ibAsk) > 0 ? Math.abs(ibDelta)/(ibBid+ibAsk) : 0;
      const ibStrongDelta = ibDeltaStrength > 0.08;

      const postIB = rthB.filter(b => barMin(b) >= 60);
      const ibBreakUp = postIB.some(b => +b.close > ibH);
      const ibBreakDn = postIB.some(b => +b.close < ibL);

      const amBars = rthB.filter(b => barMin(b) < 150);
      const pmBars = rthB.filter(b => barMin(b) >= 150);
      const amClose = amBars.length ? +amBars[amBars.length-1].close : open;
      const pmClose = pmBars.length ? +pmBars[pmBars.length-1].close : amClose;
      const amDir = amClose>open+5?'up':amClose<open-5?'down':'flat';
      const pmDir = pmClose>amClose+5?'up':pmClose<amClose-5?'down':'flat';
      const pmContinues = amDir !== 'flat' && pmDir === amDir;
      const pmReverses  = amDir !== 'flat' && pmDir !== 'flat' && pmDir !== amDir;

      const prev = sessions[sessions.length-1];
      const prevDir  = prev?.dayDir  ?? null;
      const prevDir2 = sessions[sessions.length-2]?.dayDir ?? null;
      const prevDir3 = sessions[sessions.length-3]?.dayDir ?? null;
      const prevRange = prev?.dayRange ?? null;
      const prevRangeRatio = prev?.rangeRatio ?? null;
      const prevTrend = prev?.trendDay ?? null;
      const streak = prev ? (
        prev.dayDir === 'up'   ? (sessions[sessions.length-2]?.dayDir === 'up'   ? (sessions[sessions.length-3]?.dayDir === 'up'   ? 3 : 2) : 1) :
        prev.dayDir === 'down' ? (sessions[sessions.length-2]?.dayDir === 'down' ? (sessions[sessions.length-3]?.dayDir === 'down' ? -3 : -2) : -1) : 0
      ) : 0;

      const prevHi = prev?.dayHi ?? null;
      const prevLo = prev?.dayLo ?? null;
      const openVsPriorRange = prevHi && prevLo ? (open - prevLo)/(prevHi - prevLo) : null;

      sessions.push({
        date, dow, dayDir, trendDay, volRatio, rangeRatio, dayRange, dayVol, dayHi, dayLo,
        ibRange, ibH, ibL, open, close, dayBid, dayAsk,
        ibDelta, ibDeltaDir, ibPriceDir, ibDeltaDivergence, ibStrongDelta, ibBreakUp, ibBreakDn,
        drive15, drive15Dir, f30dir, amDir, pmDir, pmContinues, pmReverses,
        slotStats,
        prevDir, prevDir2, prevDir3, prevTrend, prevRangeRatio, streak,
        openVsPriorRange, prevHi, prevLo,
      });
    }

    const N = sessions.length;
    if (N < 50) return res.json({ sections: [], sessions: N });

    const test = (label, category, description, filter, outcome, baseline=0.5) => {
      const cohort = sessions.filter(filter);
      if (cohort.length < 15) return null;
      const hits = cohort.filter(outcome).length;
      const rate = hits/cohort.length;
      const edge = rate-baseline;
      const pv = pval(rate, baseline, cohort.length);
      return { label, category, description, n: cohort.length, hits, rate: +(rate*100).toFixed(1), baseline: +(baseline*100).toFixed(1), edge: +(edge*100).toFixed(1), pValue: pv, sig: pv!=null&&pv<0.05 };
    };

    const all = [
      ...Array.from({length:13}, (_,i) => {
        const h = Math.floor(i/2)+9, m = (i%2)*30;
        const slotLabel = `${h+Math.floor((m+30)/60)}:${((m+30)%60).toString().padStart(2,'0')}`;
        const fullLabel = `${h}:${m.toString().padStart(2,'0')}–${slotLabel} → price moves UP`;
        return test(fullLabel, 'Time of Day',
          `In the ${h}:${m.toString().padStart(2,'0')}–${slotLabel} slot, what % of sessions does price close higher than it opened?`,
          s => s.slotStats[i] != null,
          s => s.slotStats[i]?.dir === 'up',
          0.5);
      }).filter(Boolean),

      test('Opening Drive Up → Day Closes Up', 'Opening Drive', 'When the first 15-min move is upward, does the day close above the open?', s => s.drive15Dir === 'up', s => s.dayDir === 'up'),
      test('Opening Drive Down → Day Closes Down', 'Opening Drive', 'When the first 15-min move is downward, does the day close below the open?', s => s.drive15Dir === 'down', s => s.dayDir === 'down'),
      test('Opening Drive Up → AM Continues Up', 'Opening Drive', 'When the first 15-min is up, does the full AM (9:30-12:00) close above the open?', s => s.drive15Dir === 'up', s => s.amDir === 'up'),
      test('Opening Drive Down → AM Continues Down', 'Opening Drive', 'When the first 15-min is down, does the full AM close below the open?', s => s.drive15Dir === 'down', s => s.amDir === 'down'),
      test('Opening Drive Up → PM Reverses Down', 'Opening Drive', 'When the first 15-min is up, does the PM (12:00-16:00) reverse downward?', s => s.drive15Dir === 'up', s => s.pmReverses),
      test('Opening Drive Down → PM Reverses Up', 'Opening Drive', 'When the first 15-min is down, does the PM reverse upward?', s => s.drive15Dir === 'down', s => s.pmReverses),

      test('AM Direction → PM Continues Same Direction', 'AM/PM Pattern', 'Does the afternoon (12:00-16:00) continue the same direction as the morning (9:30-12:00)?', s => s.amDir !== 'flat', s => s.pmContinues),
      test('AM Up → PM Reverses Down', 'AM/PM Pattern', 'When the morning closes above open, does the afternoon reverse lower?', s => s.amDir === 'up', s => s.pmReverses),
      test('AM Down → PM Reverses Up', 'AM/PM Pattern', 'When the morning closes below open, does the afternoon reverse higher?', s => s.amDir === 'down', s => s.pmReverses),
      test('Strong AM Move (>IB range) → PM Reversal', 'AM/PM Pattern', 'When the AM move exceeds the IB range, does the PM tend to reverse?', s => Math.abs(s.amDir==='up'?+1:-1) > 0 && s.amDir !== 'flat', s => s.pmReverses),

      test('IB Bearish Divergence (price up, sellers dominate) → Day Reverses Down', 'Bid/Ask Delta', 'Price rises in the IB but selling volume exceeds buying — distribution into strength. Does the day close below open?', s => s.ibDeltaDivergence === 'bearish_div', s => s.dayDir === 'down'),
      test('IB Bullish Divergence (price down, buyers dominate) → Day Reverses Up', 'Bid/Ask Delta', 'Price falls in the IB but buying volume exceeds selling — accumulation on weakness. Does the day close above open?', s => s.ibDeltaDivergence === 'bullish_div', s => s.dayDir === 'up'),
      test('IB Bearish Confirmation (price up, buyers dominate) → Day Continues Up', 'Bid/Ask Delta', 'Price rises AND buying volume dominates — genuine demand. Does the day sustain the upside?', s => s.ibDeltaDivergence === 'bullish_conf', s => s.dayDir === 'up'),
      test('IB Bearish Confirmation (price down, sellers dominate) → Day Continues Down', 'Bid/Ask Delta', 'Price falls AND selling volume dominates — genuine supply. Does the day sustain the downside?', s => s.ibDeltaDivergence === 'bearish_conf', s => s.dayDir === 'down'),
      test('Strong Delta Divergence → PM Reversal', 'Bid/Ask Delta', 'When IB order flow strongly contradicts IB price direction (>8% delta imbalance), does the PM reverse the AM?', s => s.ibStrongDelta && (s.ibDeltaDivergence === 'bearish_div' || s.ibDeltaDivergence === 'bullish_div'), s => s.pmReverses),
      test('Strong Delta Confirmation → AM/PM Continuation', 'Bid/Ask Delta', 'When IB order flow strongly agrees with IB price direction, does the AM direction continue through PM?', s => s.ibStrongDelta && (s.ibDeltaDivergence === 'bullish_conf' || s.ibDeltaDivergence === 'bearish_conf'), s => s.pmContinues),

      test('After 1 Up Day → Next Day Up', 'Consecutive Days', 'When yesterday closed up, is today also up?', s => s.prevDir === 'up', s => s.dayDir === 'up'),
      test('After 1 Down Day → Next Day Down', 'Consecutive Days', 'When yesterday closed down, is today also down?', s => s.prevDir === 'down', s => s.dayDir === 'down'),
      test('After 2 Consecutive Up Days → Next Day Down', 'Consecutive Days', 'After 2 straight up days, does the market reverse down?', s => s.streak >= 2, s => s.dayDir === 'down'),
      test('After 2 Consecutive Down Days → Next Day Up', 'Consecutive Days', 'After 2 straight down days, does the market reverse up?', s => s.streak <= -2, s => s.dayDir === 'up'),
      test('After 3 Consecutive Up Days → Next Day Down', 'Consecutive Days', 'After 3 straight up days, does the market reverse down?', s => s.streak >= 3, s => s.dayDir === 'down'),
      test('After 3 Consecutive Down Days → Next Day Up', 'Consecutive Days', 'After 3 straight down days, does the market reverse up?', s => s.streak <= -3, s => s.dayDir === 'up'),
      test('After Trend Day → Next Day is Range Day', 'Consecutive Days', 'The day after a strong trend day tends to be a lower-volatility, range-bound session', s => s.prevTrend === true, s => !s.trendDay),
      test('After Range Day → Next Day is Trend Day', 'Consecutive Days', 'After a tight, range-bound day, does the following session expand into a trend?', s => s.prevTrend === false, s => s.trendDay),

      test('Above Avg Volume → Trend Day', 'Volume', 'When today has more volume than the 20-day average, is it a trend day?', s => s.volRatio > 1.25, s => s.trendDay),
      test('Below Avg Volume → Range Day', 'Volume', 'When today has less volume than the 20-day average, is it a range-bound day?', s => s.volRatio < 0.80, s => !s.trendDay),
      test('High Volume After Down Day → Reversal Up', 'Volume', 'High volume the day after a down day signals institutional accumulation and next-day reversal', s => s.prevDir === 'down' && s.volRatio > 1.25, s => s.dayDir === 'up'),
      test('High Volume After Up Day → Reversal Down', 'Volume', 'High volume the day after an up day may signal distribution and next-day weakness', s => s.prevDir === 'up' && s.volRatio > 1.25, s => s.dayDir === 'down'),
      test('Expanding Range (today > yesterday) → Trend Day', 'Volume', "When today's range exceeds yesterday's, is it a trend day?", s => s.prevRangeRatio != null && s.rangeRatio > s.prevRangeRatio, s => s.trendDay),

      test('Monday → Trend Day', 'Day of Week', 'Mondays have higher or lower trend-day frequency than the baseline', s => s.dow === 1, s => s.trendDay),
      test('Tuesday → Trend Day', 'Day of Week', 'Tuesdays have higher or lower trend-day frequency than the baseline', s => s.dow === 2, s => s.trendDay),
      test('Wednesday → Trend Day', 'Day of Week', 'Wednesdays have higher or lower trend-day frequency than the baseline', s => s.dow === 3, s => s.trendDay),
      test('Thursday → Trend Day', 'Day of Week', 'Thursdays have higher or lower trend-day frequency than the baseline', s => s.dow === 4, s => s.trendDay),
      test('Friday → Trend Day', 'Day of Week', 'Fridays have higher or lower trend-day frequency than the baseline', s => s.dow === 5, s => s.trendDay),
      test('Monday → Closes in Direction of Opening Drive', 'Day of Week', 'On Mondays, does the day close in the same direction as the first 15-min move?', s => s.dow === 1 && s.drive15Dir !== 'flat', s => s.dayDir === s.drive15Dir),
      test('Friday → AM Reverses in PM', 'Day of Week', 'Fridays tend to have PM reversals of the AM direction (profit-taking into weekend)', s => s.dow === 5 && s.amDir !== 'flat', s => s.pmReverses),
      test('Wednesday → AM Continues into PM', 'Day of Week', 'Mid-week sessions tend to continue the AM direction through the close', s => s.dow === 3 && s.amDir !== 'flat', s => s.pmContinues),

      test('Open in Upper 25% of Prior Range → Day Closes Down', 'Open Position', "When today opens in the top quarter of yesterday's range, does it tend to close lower (mean reversion)?", s => s.openVsPriorRange != null && s.openVsPriorRange > 0.75, s => s.dayDir === 'down'),
      test('Open in Lower 25% of Prior Range → Day Closes Up', 'Open Position', "When today opens in the bottom quarter of yesterday's range, does it tend to close higher (mean reversion)?", s => s.openVsPriorRange != null && s.openVsPriorRange < 0.25, s => s.dayDir === 'up'),
      test("Open Near Middle of Prior Range → Range Day", 'Open Position', "Opening in the middle third of the prior day's range — does the day stay range-bound?", s => s.openVsPriorRange != null && s.openVsPriorRange >= 0.33 && s.openVsPriorRange <= 0.67, s => !s.trendDay),

      test('Narrow Range After 2 Narrowing Days → Range Expansion', 'Volatility', 'After 2 consecutive narrowing-range sessions, does range expand significantly next day?', s => s.prevRangeRatio != null && s.rangeRatio < 0.85 && s.prevRangeRatio < 0.85, s => s.rangeRatio > 1.15),
      test('IB Range < 60pts → Day Has High MFE from IB Level', 'Volatility', 'Narrow IBs (<60pts) set up large moves — is the day range much larger than IB range?', s => s.ibRange < 60, s => s.dayRange > s.ibRange * 2.5),

    ].filter(Boolean);

    const catOrder = ['Time of Day','Opening Drive','AM/PM Pattern','Bid/Ask Delta','Consecutive Days','Volume','Day of Week','Open Position','Volatility'];
    const sections = catOrder.map(cat => {
      const items = all.filter(p => p.category === cat).sort((a,b) => Math.abs(b.edge)-Math.abs(a.edge));
      return { category: cat, patterns: items };
    }).filter(s => s.patterns.length > 0);

    const top25 = [...all].sort((a,b) => {
      if (a.sig !== b.sig) return a.sig ? -1 : 1;
      return Math.abs(b.edge) - Math.abs(a.edge);
    }).slice(0, 25);

    res.json({ top25, sections, sessions: N, total: all.length });
  } catch(err) {
    console.error('Edge analysis error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
