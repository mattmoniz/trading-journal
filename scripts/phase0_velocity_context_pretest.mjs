// Phase 0 market-behavior pretest (2026-09-22, user request after the 9/21 400+pt missed-
// rally discussion): "ML buy / ML sell" idea — can velocity + volume context + time-of-day,
// completely independent of the existing fade/level roster, predict favorable continuation?
//
// Per this codebase's own standing rule ("a hypothesis about market behavior gets tested
// against raw bar/price history first"), this is a pure bar-history conditioning test — no
// active_setups, no stop/target simulation, no ML model yet. If this comes back positive,
// THAT is when real trade machinery gets built (per the New Setup Type checklist's own
// item 4a: forward-return pretest before any trade machinery).
//
// Originally dispatched to Gemini (see scratch/claude_request.md) but Gemini's quota was
// exhausted (RESOURCE_EXHAUSTED 429, resets in ~5.5 days) before it produced anything --
// built directly per the standing "don't wait, do the task directly" rule.
//
// Key design point, found by hand before writing this script (see the 2026-09-22 chat
// investigation): a plain trailing-20-bar volume z-score is NOT a good "is this unusual"
// yardstick right around a session open, because bar-to-bar volume is naturally elevated for
// EVERYONE right after the open -- the rolling baseline is itself contaminated. This script
// computes BOTH a trailing-20-bar z-score AND a same-time-of-day baseline (this exact ET
// clock-minute's own trailing 20-trading-day mean/std) and reports which one actually
// separates real signal near the open.
//
// No lookahead: every feature at bar i uses only bars <= i; same-time-of-day baselines use
// only STRICTLY PRIOR calendar days at that same minute; forward outcomes look at bars > i
// (fine for a pretest -- this isn't a live decision, it's asking "would this have mattered").
import { query } from '../server/db.js';
import { isInsideNqRollWeek } from '../server/services/acdShared.js';
import { dayBlockedBootstrapCI, computeRigor } from '../server/services/rigorDiagnostics.js';

const DATA_START = '2025-11-20'; // real continuous 1-min density starts here (checked directly:
  // pre-2025-11 NQ data in this DB is mostly single-digit-thousands-per-month placeholder rows,
  // see docs/KNOWN_ISSUES.md item 17 -- pooling it would corrupt this, not strengthen it.
const ATR_WINDOW = 20;
const SAME_TOD_WINDOW = 20; // trailing 20 prior occurrences of the same clock minute
const VELOCITY_WINDOWS = [1, 2, 3, 5, 10, 15, 30]; // 1-2min added 2026-09-22 (user request:
  // "can we look at 1 minute intervals too" -- the original 15min "primary" pick was a
  // judgment call, never tested against faster windows. Sweep them explicitly below instead
  // of assuming 15min is right.
const PRIMARY_VELOCITY = 15; // used for bucketing/direction -- "a quick period of time"
const HORIZONS = [5, 15, 30, 60];
const LEVEL_PROXIMITY_PTS = 15; // matches acd.js's own live nearLevels convention

const SAME_DAY_FORMING_LEVEL_PREFIXES = [
  'OR5_', 'OR10_', 'OR15_', 'OR30_', 'IB_HIGH', 'IB_LOW', 'IB_MID',
  'PD_OR_MID', '5D_OR_MID', '10D_IB_MID', 'RTH_VWAP', 'DEV_POC', 'MONTHLY_VWAP',
];

function todMinute(tsText) {
  const hh = Number(tsText.slice(11, 13)), mm = Number(tsText.slice(14, 16));
  return hh * 60 + mm;
}
function todLabel(min) {
  if (min >= 570 && min < 630) return 'RTH_OPEN';
  if (min >= 630 && min < 840) return 'RTH_MID';
  if (min >= 840 && min < 960) return 'RTH_CLOSE';
  if (min >= 1080 && min < 1260) return 'GLOBEX_EVE';
  if (min >= 1260 || min < 360) return 'GLOBEX_ON';
  if (min >= 360 && min < 510) return 'GLOBEX_PRE';
  return 'OTHER';
}
function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; }
function std(a, m) { return a.length ? Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length) : null; }
function percentile(sortedArr, p) { const idx = Math.floor(sortedArr.length * p); return sortedArr[Math.min(idx, sortedArr.length - 1)]; }

async function main() {
  console.log('Loading NQ bars from', DATA_START, '...');
  const barsRes = await query(`
    SELECT ts::text as ts_text, close::float as close, high::float as high, low::float as low,
      volume::float as volume, bid_volume::float as bid, ask_volume::float as ask
    FROM price_bars_primary
    WHERE symbol='NQ' AND ts >= $1
    ORDER BY ts ASC
  `, [DATA_START]);
  console.log('Raw bars:', barsRes.rows.length);

  // Filter roll weeks (reuse real, already-validated function -- never reimplement roll-week math)
  const bars = barsRes.rows.filter(b => !isInsideNqRollWeek(b.ts_text.slice(0, 10)));
  console.log('After roll-week exclusion:', bars.length);

  const n = bars.length;
  const tsToIdx = new Map();
  for (let i = 0; i < n; i++) tsToIdx.set(bars[i].ts_text, i);

  function idxAtMinutesAhead(i, mins) {
    const base = new Date(bars[i].ts_text.replace(' ', 'T') + 'Z').getTime();
    const target = new Date(base + mins * 60000).toISOString().replace('T', ' ').slice(0, 19);
    return tsToIdx.has(target) ? tsToIdx.get(target) : null;
  }

  // ATR20 (rolling True Range mean, no lookahead)
  const atr = new Array(n).fill(null);
  const trBuf = [];
  for (let i = 0; i < n; i++) {
    const tr = i === 0 ? bars[i].high - bars[i].low
      : Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - bars[i - 1].close), Math.abs(bars[i].low - bars[i - 1].close));
    trBuf.push(tr);
    if (trBuf.length > ATR_WINDOW) trBuf.shift();
    if (trBuf.length === ATR_WINDOW) atr[i] = mean(trBuf);
  }

  // volZ_trailing20 (existing live convention: this bar's volume vs trailing 20-bar mean/std, EXCLUDING itself)
  const volZTrailing = new Array(n).fill(null);
  {
    const buf = [];
    for (let i = 0; i < n; i++) {
      if (buf.length === ATR_WINDOW) {
        const m = mean(buf), s = std(buf, m);
        volZTrailing[i] = s > 0 ? (bars[i].volume - m) / s : null;
      }
      buf.push(bars[i].volume);
      if (buf.length > ATR_WINDOW) buf.shift();
    }
  }

  // volZ_sameTimeOfDay: this bar's volume vs the same ET clock-minute's own trailing 20 PRIOR
  // calendar days -- built fresh, no existing convention for this. No lookahead: only days
  // strictly before this bar's own date are used.
  const volZSameTod = new Array(n).fill(null);
  {
    const byMinute = new Map(); // minuteOfDay -> array of {date, volume} in chronological order
    for (let i = 0; i < n; i++) {
      const min = todMinute(bars[i].ts_text);
      const date = bars[i].ts_text.slice(0, 10);
      if (!byMinute.has(min)) byMinute.set(min, []);
      const hist = byMinute.get(min);
      // only use entries from a STRICTLY earlier date (a same day can have >1 bar at this
      // exact minute only if data is malformed, but guard anyway)
      const priorVols = hist.filter(h => h.date < date).slice(-SAME_TOD_WINDOW).map(h => h.volume);
      if (priorVols.length === SAME_TOD_WINDOW) {
        const m = mean(priorVols), s = std(priorVols, m);
        volZSameTod[i] = s > 0 ? (bars[i].volume - m) / s : null;
      }
      hist.push({ date, volume: bars[i].volume });
    }
  }

  // Velocity at each window (raw pts + ATR-normalized), no lookahead
  const velocity = {}; // window -> array
  for (const w of VELOCITY_WINDOWS) {
    velocity[w] = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
      const j = idxAtMinutesAhead(i, -w);
      if (j != null && atr[i] > 0) velocity[w][i] = { raw: bars[i].close - bars[j].close, atrNorm: (bars[i].close - bars[j].close) / atr[i] };
    }
  }

  // Forward moves at each horizon
  const forward = {};
  for (const h of HORIZONS) {
    forward[h] = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
      const j = idxAtMinutesAhead(i, h);
      if (j != null) forward[h][i] = bars[j].close - bars[i].close;
    }
  }

  // Level proximity (informational split, not a filter) -- reuse the same pre-fixed level
  // family convention as scripts/backtest_entry_proximity_resimulation.mjs
  console.log('Loading level_prices for proximity split...');
  const levelRes = await query(`SELECT trade_date::text as trade_date, level_name, price::float as price FROM level_prices WHERE price IS NOT NULL`);
  const levelsByDate = new Map();
  for (const r of levelRes.rows) {
    if (SAME_DAY_FORMING_LEVEL_PREFIXES.some(p => r.level_name.startsWith(p))) continue;
    if (!levelsByDate.has(r.trade_date)) levelsByDate.set(r.trade_date, []);
    levelsByDate.get(r.trade_date).push(r.price);
  }
  function nearestLevelDist(i) {
    // trade_date approximation: bars before ~6pm belong to that calendar date's RTH session;
    // bars >=6pm belong to the NEXT calendar date's session (informational split only, doesn't
    // need to be exact to the minute).
    const min = todMinute(bars[i].ts_text);
    let date = bars[i].ts_text.slice(0, 10);
    if (min >= 1080) { const d = new Date(date + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); date = d.toISOString().slice(0, 10); }
    const levels = levelsByDate.get(date);
    if (!levels || !levels.length) return { nearest: null, ahead: null, behind: null };
    const nearest = Math.min(...levels.map(l => Math.abs(bars[i].close - l)));
    return { nearest, levels, date };
  }
  // Direction-aware split, added 2026-09-22 (user: "so catch velocity going into a marked
  // level?") -- the plain nearestLevelDist() above can't tell "fast-moving and about to hit
  // a level AHEAD of it" (a real breakout candidate) from "fast-moving and already past a
  // level BEHIND it" (already extended, nothing left to break). aheadDist/behindDist split
  // levels by whether they sit on the side of price the velocity is actually moving toward.
  function levelAheadBehind(i, dir) {
    const { levels } = nearestLevelDist(i);
    if (!levels || !levels.length) return { aheadDist: null, behindDist: null };
    const px = bars[i].close;
    let aheadDist = null, behindDist = null;
    for (const l of levels) {
      const d = Math.abs(px - l);
      const isAhead = dir > 0 ? l > px : l < px; // level sits in the direction of travel
      if (isAhead) { if (aheadDist == null || d < aheadDist) aheadDist = d; }
      else { if (behindDist == null || d < behindDist) behindDist = d; }
    }
    return { aheadDist, behindDist };
  }

  // ── Build the candidate population: bars with a complete feature set at PRIMARY_VELOCITY ──
  const rows = [];
  for (let i = 0; i < n; i++) {
    const v = velocity[PRIMARY_VELOCITY][i];
    if (!v || v.raw === 0) continue;
    if (volZTrailing[i] == null || volZSameTod[i] == null) continue;
    const label = todLabel(todMinute(bars[i].ts_text));
    if (label === 'OTHER') continue;
    const dir = Math.sign(v.raw);
    const { aheadDist, behindDist } = levelAheadBehind(i, dir);
    rows.push({
      idx: i, date: bars[i].ts_text.slice(0, 10), ts: bars[i].ts_text, todLabel: label,
      todMin: todMinute(bars[i].ts_text), dir,
      velAbs: Math.abs(v.raw), velAtrNorm: Math.abs(v.atrNorm),
      volZTrailing: volZTrailing[i], volZSameTod: volZSameTod[i],
      levelDist: nearestLevelDist(i).nearest,
      aheadDist, behindDist,
      forward: HORIZONS.reduce((o, h) => { o[h] = forward[h][i] != null ? Math.sign(v.raw) * forward[h][i] : null; return o; }, {}),
    });
  }
  console.log('Candidate population (complete features, valid ToD bucket):', rows.length);

  // ── Percentile cutoffs (global, across the whole population) ──
  const velSorted = rows.map(r => r.velAbs).sort((a, b) => a - b);
  const p90vel = percentile(velSorted, 0.90), p75vel = percentile(velSorted, 0.75), p50vel = percentile(velSorted, 0.50);
  console.log(`\nVelocity(${PRIMARY_VELOCITY}min) abs-pts percentiles: p50=${p50vel.toFixed(1)} p75=${p75vel.toFixed(1)} p90=${p90vel.toFixed(1)}`);

  // ── Per-time-of-day-bucket analysis ──
  const byLabel = new Map();
  for (const r of rows) { if (!byLabel.has(r.todLabel)) byLabel.set(r.todLabel, []); byLabel.get(r.todLabel).push(r); }

  console.log('\n=== Per-time-of-day-bucket: top decile velocity vs bucket-own unconditional mean, at each horizon ===');
  const bucketResults = {};
  for (const [label, group] of byLabel) {
    const velSortedG = group.map(r => r.velAbs).sort((a, b) => a - b);
    const cut90 = percentile(velSortedG, 0.90);
    const topDecile = group.filter(r => r.velAbs >= cut90);
    console.log(`\n${label}: N=${group.length}, top-decile-velocity N=${topDecile.length} (cutoff ${cut90.toFixed(1)}pt/${PRIMARY_VELOCITY}min)`);
    const horizonStats = {};
    for (const h of HORIZONS) {
      const uncond = group.map(r => r.forward[h]).filter(x => x != null);
      const top = topDecile.map(r => r.forward[h]).filter(x => x != null);
      const uncondMean = mean(uncond), topMean = mean(top);
      horizonStats[h] = { uncondMean, topMean, uncondN: uncond.length, topN: top.length };
      console.log(`  +${h}min: unconditional mean=${uncondMean?.toFixed(2)} (N=${uncond.length}) | top-decile mean=${topMean?.toFixed(2)} (N=${top.length}) | delta=${(topMean - uncondMean).toFixed(2)}`);
    }
    bucketResults[label] = { n: group.length, topDecileN: topDecile.length, cut90, horizonStats, topDecileRows: topDecile };
  }

  // ── Window-size sweep, RTH_OPEN only (2026-09-22, user: "can we look at 1 minute
  // intervals too" + "so catch velocity going into a marked level?") ──
  // Self-contained per window: each window gets its OWN direction/velocity/forward-move/
  // ahead-behind-level split, rather than reusing PRIMARY_VELOCITY's direction -- a 1min
  // burst and a 15min burst at the same bar can point different ways.
  console.log('\n=== RTH_OPEN: velocity WINDOW SIZE sweep (1-30min) + direction-aware level split ===');
  const rthOpenIdx = [];
  for (let i = 0; i < n; i++) {
    if (todLabel(todMinute(bars[i].ts_text)) === 'RTH_OPEN') rthOpenIdx.push(i);
  }
  for (const w of VELOCITY_WINDOWS) {
    const winRows = [];
    for (const i of rthOpenIdx) {
      const v = velocity[w][i];
      if (!v || v.raw === 0) continue;
      const dir = Math.sign(v.raw);
      const { aheadDist, behindDist } = levelAheadBehind(i, dir);
      winRows.push({
        date: bars[i].ts_text.slice(0, 10), velAbs: Math.abs(v.raw), aheadDist, behindDist,
        forward: HORIZONS.reduce((o, h) => { o[h] = forward[h][i] != null ? dir * forward[h][i] : null; return o; }, {}),
      });
    }
    const sorted = winRows.map(r => r.velAbs).sort((a, b) => a - b);
    const cut90 = percentile(sorted, 0.90);
    const top = winRows.filter(r => r.velAbs >= cut90);
    const d15 = mean(top.map(r => r.forward[15]).filter(x => x != null)) - mean(winRows.map(r => r.forward[15]).filter(x => x != null));
    const d60 = mean(top.map(r => r.forward[60]).filter(x => x != null)) - mean(winRows.map(r => r.forward[60]).filter(x => x != null));
    console.log(`\n  window=${w}min: N=${winRows.length}, top-decile N=${top.length} (cutoff ${cut90.toFixed(1)}pt), delta-vs-unconditional +15min=${d15.toFixed(2)} +60min=${d60.toFixed(2)}`);

    // Direction-aware level split: "approaching a level ahead" (small aheadDist, hasn't broken
    // yet) vs "already past, nothing close ahead" (large/null aheadDist)
    const aheadClose = top.filter(r => r.aheadDist != null && r.aheadDist <= LEVEL_PROXIMITY_PTS);
    const aheadFar = top.filter(r => !(r.aheadDist != null && r.aheadDist <= LEVEL_PROXIMITY_PTS));
    const rig = computeRigor(aheadClose.map(r => ({ date: r.date, pnl: r.forward[60] })).filter(e => e.pnl != null), { dateField: 'date', pnlFn: e => e.pnl });
    console.log(`    approaching-a-level (aheadDist<=${LEVEL_PROXIMITY_PTS}pt, N=${aheadClose.length}): +15min mean=${mean(aheadClose.map(r=>r.forward[15]).filter(x=>x!=null))?.toFixed(2)} +60min mean=${mean(aheadClose.map(r=>r.forward[60]).filter(x=>x!=null))?.toFixed(2)} | distinctDates=${rig.distinctDates} top5DayPct=${rig.top5DayPct}`);
    console.log(`    no-level-ahead-nearby (N=${aheadFar.length}): +15min mean=${mean(aheadFar.map(r=>r.forward[15]).filter(x=>x!=null))?.toFixed(2)} +60min mean=${mean(aheadFar.map(r=>r.forward[60]).filter(x=>x!=null))?.toFixed(2)}`);
    if (aheadClose.length >= 20) {
      const ci = dayBlockedBootstrapCI(aheadClose.map(r => ({ date: r.date, pnl: r.forward[60] })).filter(e => e.pnl != null), `phase0_w${w}_ahead`, { dateField: 'date' });
      console.log(`    approaching-a-level +60min day-blocked bootstrap 95% CI: [${ci.lo.toFixed(2)}, ${ci.hi.toFixed(2)}]`, ci.lo > 0 ? '(excludes zero, positive)' : ci.hi < 0 ? '(excludes zero, negative)' : '(crosses zero)');
    }
  }

  // ── Volume-baseline comparison specifically in RTH_OPEN (the motivating window) ──
  console.log('\n=== RTH_OPEN: does volZ_trailing20 vs volZ_sameTimeOfDay separate real signal? ===');
  const rthOpen = byLabel.get('RTH_OPEN') || [];
  for (const [zKey, zLabel] of [['volZTrailing', 'trailing-20-bar'], ['volZSameTod', 'same-time-of-day']]) {
    const sorted = rthOpen.map(r => r[zKey]).sort((a, b) => a - b);
    const cut = percentile(sorted, 0.75);
    const highVolGroup = rthOpen.filter(r => r[zKey] >= cut && r.velAbs >= percentile(rthOpen.map(x => x.velAbs).sort((a, b) => a - b), 0.75));
    const rest = rthOpen.filter(r => !(r[zKey] >= cut && r.velAbs >= percentile(rthOpen.map(x => x.velAbs).sort((a, b) => a - b), 0.75)));
    for (const h of [15, 60]) {
      const hi = mean(highVolGroup.map(r => r.forward[h]).filter(x => x != null));
      const rst = mean(rest.map(r => r.forward[h]).filter(x => x != null));
      console.log(`  [${zLabel}] high-vol+high-vel (N=${highVolGroup.length}) +${h}min mean=${hi?.toFixed(2)} vs rest (N=${rest.length}) mean=${rst?.toFixed(2)}`);
    }
  }

  // ── Level proximity split within RTH_OPEN top-decile-velocity ──
  console.log('\n=== RTH_OPEN top-decile-velocity: near-level vs no-level-nearby ===');
  const rthTop = bucketResults['RTH_OPEN']?.topDecileRows ?? [];
  const near = rthTop.filter(r => r.levelDist != null && r.levelDist <= LEVEL_PROXIMITY_PTS);
  const far = rthTop.filter(r => r.levelDist == null || r.levelDist > LEVEL_PROXIMITY_PTS);
  for (const h of [15, 60]) {
    console.log(`  near-level (N=${near.length}) +${h}min mean=${mean(near.map(r => r.forward[h]).filter(x => x != null))?.toFixed(2)} | not-near (N=${far.length}) +${h}min mean=${mean(far.map(r => r.forward[h]).filter(x => x != null))?.toFixed(2)}`);
  }

  // ── Rigor on the RTH_OPEN top-decile subgroup (the direct answer to the user's question) ──
  console.log('\n=== Rigor checks: RTH_OPEN top-decile-velocity, +60min forward move ===');
  const rigorEvents = rthTop.map(r => ({ date: r.date, pnl: r.forward[60] })).filter(e => e.pnl != null);
  const rigor = computeRigor(rigorEvents, { dateField: 'date', pnlFn: e => e.pnl });
  const ci = dayBlockedBootstrapCI(rigorEvents, 'phase0_velocity_rth_open', { dateField: 'date' });
  console.log('  N=', rigorEvents.length, 'distinctDates=', rigor.distinctDates, 'top5DayPct=', rigor.top5DayPct, 'clustered=', rigor.clustered, 'stable=', rigor.stable, 'thirds=', JSON.stringify(rigor.thirds));
  console.log('  day-blocked bootstrap 95% CI on mean forward move:', `[${ci.lo.toFixed(2)}, ${ci.hi.toFixed(2)}]`, ci.lo > 0 ? '(excludes zero, positive)' : ci.hi < 0 ? '(excludes zero, negative)' : '(crosses zero)');

  // ── Ground the 2026-09-21 9:24-9:42am example specifically ──
  console.log('\n=== Grounding: 2026-09-21 9:24am-9:42am event ===');
  const exampleRow = rows.find(r => r.ts === '2026-09-21 09:42:00');
  if (exampleRow) {
    const velRank = velSorted.filter(v => v <= exampleRow.velAbs).length / velSorted.length;
    const rthSorted = (byLabel.get('RTH_OPEN') || []).map(r => r.velAbs).sort((a, b) => a - b);
    const velRankInBucket = rthSorted.filter(v => v <= exampleRow.velAbs).length / rthSorted.length;
    console.log('  velocity(15min) at 9:42am:', exampleRow.velAbs.toFixed(1), 'pts -- global percentile:', (velRank * 100).toFixed(1) + '%', '| within RTH_OPEN bucket percentile:', (velRankInBucket * 100).toFixed(1) + '%');
    console.log('  volZ_trailing20:', exampleRow.volZTrailing?.toFixed(2), '| volZ_sameTimeOfDay:', exampleRow.volZSameTod?.toFixed(2));
    console.log('  level distance (nearest, any side):', exampleRow.levelDist != null ? exampleRow.levelDist.toFixed(1) + 'pt' : 'none tracked');
    console.log('  level AHEAD (direction of travel, at 15min window):', exampleRow.aheadDist != null ? exampleRow.aheadDist.toFixed(1) + 'pt' : 'none', '| level BEHIND:', exampleRow.behindDist != null ? exampleRow.behindDist.toFixed(1) + 'pt' : 'none');
    console.log('  actual forward moves (signed with direction):', JSON.stringify(exampleRow.forward));
  } else {
    console.log('  Bar not found in candidate population (missing a feature -- check why).');
  }

  console.log('\n=== DONE — this is a pretest result, not a promoted finding. Claude will audit before any next step. ===');
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
