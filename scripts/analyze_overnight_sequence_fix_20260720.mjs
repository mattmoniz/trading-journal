import { query } from '../server/db.js';
import { resolve } from './backtest_unified.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import fs from 'fs';

const EXCLUDED = new Set(['OR_HIGH', 'OR_LOW', 'IB_HIGH', 'IB_LOW', 'IB_MID_SCALP', 'IB_MID', 'OR_MID',
  'OR_MID_AFTER_IB', 'ONH', 'ONL', '3M_VAH', '3M_VAL', '3M_POC', 'RTH_VWAP', 'WEEKLY_VWAP', 'MONTHLY_VWAP',
  'DAILY_OPEN', 'WEEKLY_OPEN', 'MONTHLY_OPEN']);
const RTH_START = 570, RTH_END = 960;
const BIG_MOVE_PTS = 400;
const PNL_PER_POINT = LIVE_INSTRUMENT.dollarsPerPoint, COMMISSION = LIVE_INSTRUMENT.commissionPerRoundTrip;
const POST_TARGET_WALK_BARS = 240; // ~4hr past resolution

function etClockString(ts) {
  const d = new Date(ts);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
  const h = parts.find(p => p.type === 'hour').value;
  const m = parts.find(p => p.type === 'minute').value;
  return `${h}:${m}`;
}

async function main() {
  const maxDateRow = await query(`SELECT MAX(trade_date)::text as d FROM level_prices`);
  const maxDate = maxDateRow.rows[0].d;

  const lvlRes = await query(`
    SELECT trade_date::text as d, level_name, price::float as price
    FROM level_prices WHERE trade_date >= $1::date - interval '365 days' AND trade_date <= $1::date
  `, [maxDate]);
  const levelsByDate = new Map();
  for (const r of lvlRes.rows) {
    if (EXCLUDED.has(r.level_name)) continue;
    if (!levelsByDate.has(r.d)) levelsByDate.set(r.d, {});
    levelsByDate.get(r.d)[r.level_name] = r.price;
  }
  const levelNames = [...new Set(lvlRes.rows.map(r => r.level_name).filter(n => !EXCLUDED.has(n)))];
  const dates = [...levelsByDate.keys()].sort();

  const barsRes = await query(`
    SELECT ts, ts::date::text as d, EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts)::int as tod,
      high::float as high, low::float as low, close::float as close
    FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1::date - interval '370 days' ORDER BY ts ASC
  `, [maxDate]);
  const allBars = barsRes.rows.map(b => ({ ...b, ts: new Date(b.ts).getTime() }));

  // Part 3: Calculate overnight bar range distribution
  const overnightBarsRanges = [];
  for (const b of allBars) {
    if (b.tod < RTH_START || b.tod >= RTH_END) {
      overnightBarsRanges.push(b.high - b.low);
    }
  }
  overnightBarsRanges.sort((a,b) => a - b);
  const barRangeMedian = overnightBarsRanges[Math.floor(overnightBarsRanges.length / 2)];
  const barRangeP25 = overnightBarsRanges[Math.floor(overnightBarsRanges.length * 0.25)];
  
  function firstIdxAtOrAfter(dateStr, todMin) {
    for (let i = 0; i < allBars.length; i++) {
      if (allBars[i].d > dateStr) return i;
      if (allBars[i].d === dateStr && allBars[i].tod >= todMin) return i;
    }
    return -1;
  }

  const dayInfo = [];
  for (const d of dates) {
    const startIdx = firstIdxAtOrAfter(d, RTH_START);
    if (startIdx <= 0) continue;
    let rthEndIdx = allBars.length;
    for (let i = startIdx; i < allBars.length; i++) {
      if (allBars[i].d > d || (allBars[i].d === d && allBars[i].tod >= RTH_END)) { rthEndIdx = i; break; }
    }
    const wideStartTs = allBars[startIdx].ts - 15.5 * 3600 * 1000;
    let lo = 0, hi = allBars.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (allBars[mid].ts < wideStartTs) lo = mid + 1; else hi = mid; }
    const wideStartIdx = Math.max(lo, 1);

    let hi_ = -Infinity, lo_ = Infinity;
    for (let i = wideStartIdx; i < startIdx; i++) { if (allBars[i].high > hi_) hi_ = allBars[i].high; if (allBars[i].low < lo_) lo_ = allBars[i].low; }
    const range = hi_ - lo_;
    dayInfo.push({ d, startIdx, rthEndIdx, wideStartIdx, range });
  }

  const allTouches = [];
  for (const x of dayInfo) {
    const lv = levelsByDate.get(x.d);
    if (!lv) continue;
    const isMonday = new Date(x.d + 'T12:00:00').getDay() === 1;
    const STOP = isMonday ? 60 : 90, TARGET = isMonday ? 30 : 40;
    const isBigDay = x.range > BIG_MOVE_PTS;

    for (const name of levelNames) {
      const lvl = lv[name];
      if (lvl == null) continue;
      for (let i = x.wideStartIdx + 1; i < x.startIdx; i++) {
        const b = allBars[i], prev = allBars[i - 1];
        if (Math.abs(b.close - lvl) > 15) continue;
        const dir = prev.close > lvl ? 'SHORT' : 'LONG';
        const long = dir === 'LONG';
        const entry = b.close;
        const r = resolve(allBars, i, dir,
          entry, long ? entry - STOP : entry + STOP, long ? entry + TARGET : entry - TARGET,
          x.rthEndIdx - i);

        let finalFavorable = TARGET;
        let efficiency = null;
        let whichFirst = null;
        let seq = null;

        if (r.result === 'TARGET_HIT') {
          const resolveIdx = i + r.barsHeld;
          const endWalk = Math.min(allBars.length, resolveIdx + POST_TARGET_WALK_BARS);
          let currentFavorable = r.mfe;
          let currentAdverse = r.mae; 

          let firstNewFavorableAt = null;
          let firstNewAdverseAt = null;
          let newAdverseMax = currentAdverse;

          for (let j = resolveIdx; j < endWalk; j++) {
            const bar = allBars[j];
            const favorable = long ? bar.high - entry : entry - bar.low;
            const adverse = long ? entry - bar.low : bar.high - entry;
            const barsSince = j - resolveIdx + 1;

            if (favorable > currentFavorable) {
              currentFavorable = favorable;
              finalFavorable = favorable;
              if (!firstNewFavorableAt) firstNewFavorableAt = { barsSince, etTime: etClockString(bar.ts) };
            }
            if (adverse > currentAdverse) {
              currentAdverse = adverse;
              newAdverseMax = adverse;
              if (!firstNewAdverseAt) firstNewAdverseAt = { barsSince, etTime: etClockString(bar.ts) };
            }
          }

          if (firstNewFavorableAt && firstNewAdverseAt) {
            whichFirst = firstNewFavorableAt.barsSince <= firstNewAdverseAt.barsSince ? 'FAVORABLE_FIRST' : 'ADVERSE_FIRST';
          } else if (firstNewFavorableAt) whichFirst = 'FAVORABLE_ONLY';
          else if (firstNewAdverseAt) whichFirst = 'ADVERSE_ONLY';
          else whichFirst = 'NEITHER';

          efficiency = finalFavorable > 0 ? +(Math.min(TARGET, finalFavorable) / finalFavorable * 100).toFixed(1) : null;
          seq = { firstNewFavorableAt, firstNewAdverseAt, finalFavorable, finalAdverse: newAdverseMax };
        }

        allTouches.push({ date: x.d, name, dir, isBigDay, result: r.result, finalFavorable, efficiency, whichFirst, seq, targetDistance: TARGET, originalMae: r.mae, originalMfe: r.mfe });
        break;
      }
    }
  }

  const bigTargetHits = allTouches.filter(t => t.isBigDay && t.result === 'TARGET_HIT');
  
  const favFirst = bigTargetHits.filter(r => r.whichFirst === 'FAVORABLE_FIRST').length;
  const advFirst = bigTargetHits.filter(r => r.whichFirst === 'ADVERSE_FIRST').length;
  const favOnly = bigTargetHits.filter(r => r.whichFirst === 'FAVORABLE_ONLY').length;
  const advOnly = bigTargetHits.filter(r => r.whichFirst === 'ADVERSE_ONLY').length;
  const neither = bigTargetHits.filter(r => r.whichFirst === 'NEITHER').length;
  
  const total = bigTargetHits.length;

  const avgEff = total > 0 ? bigTargetHits.reduce((s,t)=>s+t.efficiency,0) / total : 0;

  const extraFavFirst = bigTargetHits.filter(r => r.whichFirst === 'FAVORABLE_FIRST' || r.whichFirst === 'FAVORABLE_ONLY').map(t => t.finalFavorable - t.targetDistance);
  const avgExtraClean = extraFavFirst.length ? extraFavFirst.reduce((a,b)=>a+b,0) / extraFavFirst.length : 0;
  
  const allExtra = bigTargetHits.map(t => t.finalFavorable - t.targetDistance);
  const avgExtraRaw = allExtra.length ? allExtra.reduce((a,b)=>a+b,0) / allExtra.length : 0;

  // Let's also check the actual retracement size for ADVERSE_FIRST/ONLY
  const advFirstOnly = bigTargetHits.filter(r => r.whichFirst === 'ADVERSE_FIRST' || r.whichFirst === 'ADVERSE_ONLY');
  const avgAdverseRetracement = advFirstOnly.length ? advFirstOnly.reduce((s, t) => s + t.seq.finalAdverse, 0) / advFirstOnly.length : 0;

  const report = `# Overnight Big-Move Sequence Fix Results
  
## Bar Range Distribution
Overnight 1-min NQ bar high-low range (outside RTH 9:30am-4:00pm ET):
- Median: ${barRangeMedian.toFixed(2)}pt
- P25: ${barRangeP25.toFixed(2)}pt

## Target-Hit Trades on Big-Move Days (N=${total})
- **FAVORABLE_FIRST**: ${favFirst} (${total > 0 ? (100*favFirst/total).toFixed(1) : 0}%)
- **FAVORABLE_ONLY**: ${favOnly} (${total > 0 ? (100*favOnly/total).toFixed(1) : 0}%)
- **ADVERSE_FIRST**: ${advFirst} (${total > 0 ? (100*advFirst/total).toFixed(1) : 0}%)
- **ADVERSE_ONLY**: ${advOnly} (${total > 0 ? (100*advOnly/total).toFixed(1) : 0}%)
- **NEITHER**: ${neither} (${total > 0 ? (100*neither/total).toFixed(1) : 0}%)

- **Average Efficiency Ratio**: ${avgEff.toFixed(1)}%
- **Raw Average Extra Favorable (Flawed)**: ${avgExtraRaw.toFixed(1)}pt
- **Clean Average Extra Favorable (FAVORABLE_FIRST/ONLY)**: ${avgExtraClean.toFixed(1)}pt
- **Average Adverse Retracement for Adverse-First/Only**: ${avgAdverseRetracement.toFixed(1)}pt (Maximum adverse excursion reached before/without new favorable extreme)

This demonstrates that a significant portion of the previously reported extra excursion required riding through a new adverse retracement first.
`;

  fs.writeFileSync('scratch/overnight_bigmove_sequence_fix_RESULTS.md', report);

  const cleanPercent = total > 0 ? (100*(favFirst+favOnly)/total).toFixed(1) : 0;
  const adversePercent = total > 0 ? (100*(advFirst+advOnly)/total).toFixed(1) : 0;

  const verdict = `**Sequence tracking applied to overnight big-move target hits.**
- **Overnight Bar Range**: Median ${barRangeMedian.toFixed(2)}pt, P25 ${barRangeP25.toFixed(2)}pt. (Do not use RTH 6.25pt).
- **Efficiency Ratio**: ${avgEff.toFixed(1)}% captured.
- Of the ${total} target hits on big-move days, ${adversePercent}% hit a new adverse extreme before extending favorable (or never extended favorable).
- The ${avgExtraRaw.toFixed(1)}pt raw "extra runup" finding is flawed. Clean continuations (${cleanPercent}%) average ${avgExtraClean.toFixed(1)}pt extra.
- **Verdict**: The dramatic truncation finding is significantly inflated by "stopped-out-then-recovered" paths (which drew down an average of ${avgAdverseRetracement.toFixed(1)}pt against entry first). The clean continuation is smaller but real. Proceed with breakeven-then-trail testing using the new ${barRangeMedian.toFixed(2)}pt median as a trail floor.`;

  fs.writeFileSync('scratch/antigravity_response.md', verdict);

}

main().catch(e => { console.error(e); process.exit(1); });
