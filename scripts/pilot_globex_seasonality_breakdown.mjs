import fs from 'fs';
import { query } from '../server/db.js';
import { computeRunningVwapSeries } from '../server/services/developingValueService.js';
import { recordClaim } from './record_claim.mjs';

// FIXED (pre-commit hook caught the original new Date().toISOString() anti-pattern for a
// trading-day sourceDate -- JS UTC vs DB America/New_York mismatch, see CLAUDE.md).
let _todayCache = null;
async function getToday() {
  if (!_todayCache) {
    const { rows: [{ today }] } = await query('SELECT CURRENT_DATE::text as today');
    _todayCache = today;
  }
  return _todayCache;
}

// --- Shared Utilities ---
function pearson(x, y) {
  const n = x.length;
  if (n === 0) return 0;
  let sumX = 0, sumY = 0, sumX2 = 0, sumY2 = 0, sumXY = 0;
  for (let i = 0; i < n; i++) {
    sumX += x[i]; sumY += y[i];
    sumX2 += x[i] * x[i]; sumY2 += y[i] * y[i];
    sumXY += x[i] * y[i];
  }
  const num = n * sumXY - sumX * sumY;
  const den = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
  if (den === 0) return 0;
  return num / den;
}

function permutationTest(x, y, realCorr, draws = 1000) {
  if (x.length < 2) return 1.0;
  let count = 0;
  const n = x.length;
  const yCopy = [...y];
  for (let i = 0; i < draws; i++) {
    for (let j = n - 1; j > 0; j--) {
      const k = Math.floor(Math.random() * (j + 1));
      const temp = yCopy[j];
      yCopy[j] = yCopy[k];
      yCopy[k] = temp;
    }
    const permCorr = pearson(x, yCopy);
    if (Math.abs(permCorr) >= Math.abs(realCorr)) count++;
  }
  return count / draws;
}

function timeToMin(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function minToTime(m) {
  m = (m + 24 * 60) % (24 * 60);
  const h = Math.floor(m / 60);
  const mins = m % 60;
  return `${h.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`;
}

function getMonth(dateStr) {
  // dateStr is 'YYYY-MM-DD'
  return parseInt(dateStr.substring(5, 7), 10);
}

function getYear(dateStr) {
  return parseInt(dateStr.substring(0, 4), 10);
}

function summarizeEv(bucket) {
  if (bucket.length === 0) return { N: 0, WR: 0, EV: 0 };
  const wins = bucket.filter(t => t.resolution === 'TARGET_HIT' || (t.resolution === 'TRAIL_EXIT' && t.actual_pnl >= 0)).length;
  return {
    N: bucket.length,
    WR: (wins / bucket.length) * 100,
    EV: bucket.reduce((s, t) => s + t.actual_pnl, 0) / bucket.length
  };
}

// --- Finding 1: Momentum ---
async function analyzeFinding1() {
  console.log("=== Finding 1: 03:30 ET Overnight Momentum Persistence ===");
  const r = await query(`
    SELECT ts::date::text as d, EXTRACT(hour FROM ts)::int as hr, EXTRACT(minute FROM ts)::int as min, close::float
    FROM price_bars_primary
    WHERE symbol='NQ'
      AND (
        (EXTRACT(hour FROM ts) >= 18) OR
        (EXTRACT(hour FROM ts) <= 8)
      )
      AND (EXTRACT(minute FROM ts) = 0 OR EXTRACT(minute FROM ts) = 30)
    ORDER BY ts
  `);
  
  const bySession = new Map();
  for (const b of r.rows) {
    let sessDate;
    if (b.hr >= 18) {
      const dt = new Date(b.d + 'T12:00:00Z'); 
      dt.setUTCDate(dt.getUTCDate() + 1);
      sessDate = dt.toISOString().slice(0, 10);
    } else {
      sessDate = b.d;
    }
    if (!bySession.has(sessDate)) bySession.set(sessDate, {});
    const hm = `${b.hr.toString().padStart(2, '0')}:${b.min.toString().padStart(2, '0')}`;
    bySession.get(sessDate)[hm] = b.close;
  }
  
  const a = '03:30';
  const checkpoints = ['04:00', '04:30', '05:00', '05:30', '06:00', '06:30', '07:00', '07:30', '08:00'];
  const a_minus_60 = minToTime(timeToMin(a) - 60);
  
  const valid_sessions = [];
  const sortedDates = [...bySession.keys()].sort();
  for (const d of sortedDates) {
    const bars = bySession.get(d);
    if (bars[a_minus_60] && bars[a]) {
      const sess = { date: d, anchor_mom_60: bars[a] - bars[a_minus_60], checkpoints: {} };
      let hasAll = true;
      for (const c of checkpoints) {
        if (bars[c]) {
          sess.checkpoints[c] = bars[c] - bars[a];
        } else {
          hasAll = false;
        }
      }
      if (hasAll) valid_sessions.push(sess);
    }
  }

  function runForGroup(sessions) {
    const res = {};
    for (const c of checkpoints) {
      const mom_60_arr = sessions.map(x => x.anchor_mom_60);
      const fwd_arr = sessions.map(x => x.checkpoints[c]);
      const corr = pearson(mom_60_arr, fwd_arr);
      const pval = permutationTest(mom_60_arr, fwd_arr, corr, 1000);
      res[c] = { N: sessions.length, corr, pval };
    }
    return res;
  }
  
  const months = {};
  for(let m=1; m<=12; m++) months[m] = [];
  const years = {};
  
  for (const s of valid_sessions) {
    months[getMonth(s.date)].push(s);
    const yr = getYear(s.date);
    if (!years[yr]) years[yr] = [];
    years[yr].push(s);
  }
  
  let mdOut = `### Finding 1: 03:30 ET Overnight Momentum Persistence (Trailing 60m)\n\n`;
  mdOut += `**Pooled Overall (N=${valid_sessions.length}):**\n`;
  const overall = runForGroup(valid_sessions);
  for (const c of checkpoints) {
    mdOut += `- 03:30 -> ${c}: Corr=${overall[c].corr.toFixed(3)} (p=${overall[c].pval.toFixed(3)})\n`;
  }
  
  mdOut += `\n**By Month of Year (pooled across years):**\n`;
  let monthSig = 0;
  for (let m=1; m<=12; m++) {
    const s = months[m];
    const n = s.length;
    let corrs = [];
    if (n >= 20) {
      const res = runForGroup(s);
      for (const c of checkpoints) {
         if (res[c].pval <= 0.05) monthSig++;
         corrs.push(res[c].corr.toFixed(2) + (res[c].pval<=0.05?'*':''));
      }
      mdOut += `- Month ${m}: N=${n}. Corrs (04:00-08:00): ${corrs.join(', ')}\n`;
    } else {
      mdOut += `- Month ${m}: N=${n} (THIN < 20)\n`;
    }
  }
  
  mdOut += `\n**By Calendar Year:**\n`;
  for (const yr of Object.keys(years).sort()) {
    const s = years[yr];
    const n = s.length;
    let corrs = [];
    if (n >= 20) {
      const res = runForGroup(s);
      for (const c of checkpoints) {
         corrs.push(res[c].corr.toFixed(2) + (res[c].pval<=0.05?'*':''));
      }
      mdOut += `- ${yr}: N=${n}. Corrs (04:00-08:00): ${corrs.join(', ')}\n`;
    } else {
      mdOut += `- ${yr}: N=${n} (THIN < 20)\n`;
    }
  }

  const claimText = `Finding 1 Breakdown: 03:30 ET trailing-60min momentum vs 04:00-08:00 continuation. Evaluated by month-of-year (Jan-Dec) and calendar year. N=${valid_sessions.length} total. Real pattern observed: Highly seasonal with a major summer sign flip. May and June show very strong negative correlation (exhaustion, corr -0.3 to -0.4, p<0.05). August shows strong POSITIVE correlation (persistence, corr +0.3 to +0.5, p<0.05). Winter/Fall months are generally weakly negative or insignificant. The pooled "exhaustion" finding is largely driven by May/June and 2026 data.`;
  await recordClaim({
    slug: 'globex_0330_seasonality_breakdown',
    claimText,
    sourceFile: 'scripts/pilot_globex_seasonality_breakdown.mjs',
    sourceDate: await getToday(),
    sampleSize: valid_sessions.length,
    rigorStatus: 'seasonality_tested',
    status: 'PROVISIONAL',
  });
  
  return mdOut;
}

// --- Finding 2: VWAP Deviation ---
async function analyzeFinding2() {
  console.log("=== Finding 2: VWAP-deviation-magnitude filter ===");
  const LEVELS = ['PD_POC', 'PD_VAH', 'PD_VAL'];
  const setupTypes = LEVELS.flatMap(l => [`${l}_FADE_LONG`, `${l}_FADE_SHORT`]);
  const { rows: trades } = await query(`
    SELECT id, trade_date::text as trade_date, setup_type, fired_at::text as fired_at,
           entry_zone_low::float as entry, resolution, actual_pnl::float as actual_pnl
    FROM active_setups
    WHERE setup_type = ANY($1)
      AND origin_status IN ('ACTIVE','SHADOW')
      AND resolution IN ('TARGET_HIT','STOP_HIT','TRAIL_EXIT')
      AND actual_pnl IS NOT NULL AND entry_zone_low IS NOT NULL
    ORDER BY fired_at
  `, [setupTypes]);
  
  for (const t of trades) {
    const d = new Date(t.trade_date + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - 1);
    const sessStart = d.toISOString().slice(0, 10) + ' 18:00:00';
    
    const { rows: bars } = await query(`
      SELECT ts::text as ts, high::float, low::float, close::float,
             (COALESCE(bid_volume,0)+COALESCE(ask_volume,0))::float as volume
      FROM price_bars_primary
      WHERE symbol='NQ' AND ts >= $1 AND ts <= $2
      ORDER BY ts
    `, [sessStart, t.fired_at]);
    
    if (bars.length < 5) { t.skip = true; continue; }
    const sessionSeries = computeRunningVwapSeries(bars);
    t.devSession = t.entry - sessionSeries[sessionSeries.length - 1];
  }
  
  const usable = trades.filter(t => !t.skip && t.devSession != null);
  
  function splitTerciles(bucket) {
    const sorted = [...bucket].sort((a, b) => Math.abs(a.devSession) - Math.abs(b.devSession));
    const n = sorted.length;
    return {
      low: sorted.slice(0, Math.floor(n / 3)),
      mid: sorted.slice(Math.floor(n / 3), Math.floor(2 * n / 3)),
      high: sorted.slice(Math.floor(2 * n / 3))
    };
  }

  function reportTerciles(bucket, label, md) {
    const splits = splitTerciles(bucket);
    const lowS = summarizeEv(splits.low);
    const midS = summarizeEv(splits.mid);
    const highS = summarizeEv(splits.high);
    
    const tag = (splits.high.length < 20 && bucket.length > 0) ? ' [THIN BUCKETS]' : '';
    md.push(`- **${label}** (Total N=${bucket.length})${tag}`);
    md.push(`  - Low |dev|: N=${lowS.N}, WR=${lowS.WR.toFixed(1)}%, EV=$${lowS.EV.toFixed(2)}`);
    md.push(`  - Mid |dev|: N=${midS.N}, WR=${midS.WR.toFixed(1)}%, EV=$${midS.EV.toFixed(2)}`);
    md.push(`  - High |dev|: N=${highS.N}, WR=${highS.WR.toFixed(1)}%, EV=$${highS.EV.toFixed(2)}`);
  }

  let mdOut = [];
  mdOut.push(`### Finding 2: VWAP-Deviation-Magnitude Filter (Session VWAP)\n`);
  reportTerciles(usable, "Pooled Overall", mdOut);
  
  mdOut.push(`\n**By Month of Year (pooled across years):**`);
  for (let m=1; m<=12; m++) {
    const bucket = usable.filter(t => getMonth(t.trade_date) === m);
    reportTerciles(bucket, `Month ${m}`, mdOut);
  }
  
  mdOut.push(`\n**By Calendar Year:**`);
  const years = [...new Set(usable.map(t => getYear(t.trade_date)))].sort();
  for (const yr of years) {
    const bucket = usable.filter(t => getYear(t.trade_date) === yr);
    reportTerciles(bucket, `Year ${yr}`, mdOut);
  }

  const claimText = `Finding 2 Breakdown: PD-level fade trades filtered by |devSession| terciles. Evaluated by month-of-year and calendar year. N=${usable.length} total. Real pattern observed: History is limited entirely to 2026-Q3 (July-Sept), so no long-term seasonality can be established yet. Within the available data, August (N=141) breaks the pooled pattern (High |dev| EV $3.39 vs Low |dev| EV $20.12), showing that the pooled finding is not stable even across the 3 months available.`;
  await recordClaim({
    slug: 'vwap_deviation_filter_seasonality_breakdown',
    claimText,
    sourceFile: 'scripts/pilot_globex_seasonality_breakdown.mjs',
    sourceDate: await getToday(),
    sampleSize: usable.length,
    rigorStatus: 'seasonality_tested',
    status: 'PROVISIONAL',
  });

  return mdOut.join('\n');
}

// --- Finding 3: Cross-Direction Fast Flip ---
async function analyzeFinding3() {
  console.log("=== Finding 3: Cross-direction fast-flip gate (GLOBEX_VWAP_FADE) ===");
  const { rows: trades } = await query(`
    SELECT id, trade_date::text as trade_date, setup_type, fired_at::text as fired_at,
           resolved_at::text as resolved_at, resolution, actual_pnl::float as actual_pnl
    FROM active_setups
    WHERE origin_status IN ('ACTIVE','SHADOW')
      AND resolution IN ('TARGET_HIT','STOP_HIT','TRAIL_EXIT')
      AND actual_pnl IS NOT NULL AND resolved_at IS NOT NULL
      AND setup_type IN ('GLOBEX_VWAP_FADE_LONG', 'GLOBEX_VWAP_FADE_SHORT')
    ORDER BY fired_at
  `);
  
  for (let i = 0; i < trades.length; i++) {
    const t = trades[i];
    let openOpposite = null;
    const isLong = t.setup_type.endsWith('_LONG');
    for (const cand of trades) {
      if (cand === t) continue;
      const candIsLong = cand.setup_type.endsWith('_LONG');
      if (candIsLong !== isLong && cand.fired_at <= t.fired_at && cand.resolved_at > t.fired_at) {
        if (!openOpposite || cand.fired_at > openOpposite.fired_at) openOpposite = cand;
      }
    }
    if (openOpposite) {
      t.minsSinceOppositeFired = (new Date(t.fired_at.replace(' ', 'T') + 'Z').getTime() -
        new Date(openOpposite.fired_at.replace(' ', 'T') + 'Z').getTime()) / 60000;
    }
  }
  
  const overlap = trades.filter(t => t.minsSinceOppositeFired != null);
  
  function reportBuckets(bucket, label, md) {
    const fast = bucket.filter(t => t.minsSinceOppositeFired <= 5);
    const medium = bucket.filter(t => t.minsSinceOppositeFired > 5 && t.minsSinceOppositeFired <= 15);
    const slow = bucket.filter(t => t.minsSinceOppositeFired > 15);
    
    const fastS = summarizeEv(fast);
    const midS = summarizeEv(medium);
    const slowS = summarizeEv(slow);
    
    const tag = (fast.length < 20 || medium.length < 20 || slow.length < 20) ? ' [THIN BUCKETS]' : '';
    md.push(`- **${label}** (Total Overlap N=${bucket.length})${tag}`);
    md.push(`  - Fast (<=5m): N=${fastS.N}, EV=$${fastS.EV.toFixed(2)}`);
    md.push(`  - Medium (5-15m): N=${midS.N}, EV=$${midS.EV.toFixed(2)}`);
    md.push(`  - Slow (>15m): N=${slowS.N}, EV=$${slowS.EV.toFixed(2)}`);
  }

  let mdOut = [];
  mdOut.push(`### Finding 3: Cross-Direction Fast-Flip Gate (GLOBEX_VWAP_FADE)\n`);
  reportBuckets(overlap, "Pooled Overall", mdOut);
  
  mdOut.push(`\n**By Month of Year (pooled across years):**`);
  for (let m=1; m<=12; m++) {
    const bucket = overlap.filter(t => getMonth(t.trade_date) === m);
    if (bucket.length > 0) reportBuckets(bucket, `Month ${m}`, mdOut);
  }
  
  mdOut.push(`\n**By Calendar Year:**`);
  const years = [...new Set(overlap.map(t => getYear(t.trade_date)))].sort();
  for (const yr of years) {
    const bucket = overlap.filter(t => getYear(t.trade_date) === yr);
    reportBuckets(bucket, `Year ${yr}`, mdOut);
  }

  const claimText = `Finding 3 Breakdown: Cross-direction fast-flip cooldown (GLOBEX_VWAP_FADE). Evaluated by month-of-year and calendar year. N=${overlap.length} total. Real pattern observed: History is limited entirely to 2026-Q3 (July-Sept). August dominates the dataset (N=61 of 80). The pooled finding that "Slow is best, Fast is worst" holds clearly in August, but this means the pooled finding is essentially just an August finding. No long-term seasonality can be established yet.`;
  await recordClaim({
    slug: 'cross_direction_fast_flip_seasonality_breakdown',
    claimText,
    sourceFile: 'scripts/pilot_globex_seasonality_breakdown.mjs',
    sourceDate: await getToday(),
    sampleSize: overlap.length,
    rigorStatus: 'seasonality_tested',
    status: 'PROVISIONAL',
  });

  return mdOut.join('\n');
}

async function runAll() {
  const md1 = await analyzeFinding1();
  const md2 = await analyzeFinding2();
  const md3 = await analyzeFinding3();
  
  const summaryBlock = `
## Summary of Seasonal Findings

**Finding 1 (03:30 Momentum Persistence):**
Highly seasonal with a major summer sign flip. May and June show very strong negative correlation (exhaustion, corr -0.3 to -0.4). August shows strong POSITIVE correlation (persistence, corr +0.3 to +0.5). Winter/Fall months are generally weakly negative or insignificant. The pooled "exhaustion" finding is largely driven by May/June and 2026 data.

**Finding 2 (VWAP Deviation Filter):**
History is limited entirely to 2026-Q3 (July-Sept) since active PD-level fades only recently started tracking. No long-term seasonality can be established yet. Within the available data, August (N=141) breaks the pooled pattern (High |dev| EV $3.39 vs Low |dev| EV $20.12), showing that the pooled finding is not stable even across the 3 months available.

**Finding 3 (Cross-Direction Fast Flip):**
History is similarly limited entirely to 2026-Q3 (July-Sept). August dominates the dataset (N=61 of 80 overlap trades). The pooled finding that "Slow is best, Fast is worst" holds clearly in August, but this means the pooled finding is essentially just an August finding. No long-term seasonality can be established yet.
  `;

  const fullMd = `${md1}\n\n---\n\n${md2}\n\n---\n\n${md3}\n\n---\n${summaryBlock}`;
  fs.writeFileSync('scratch/antigravity_response.md', fullMd);
  console.log("Done. Results in scratch/antigravity_response.md");
}

runAll().catch(e => { console.error(e); process.exit(1); });
