// Full-roster test of the user's displacement idea (2026-09-01): instead of a time-based
// refire cooldown, does how FAR price has traveled from a level since it was last visited
// predict whether a re-touch is a legitimate re-test (real displacement, price left and came
// back) vs just chop/clustering around the level (should probably be ignored)? Generalizes the
// single-setup, 12-refire, single-day-dominated exploratory check (too thin to trust) to the
// full real fade roster, matching the same walk-forward discipline already validated for the
// approach-pace test (scripts/backtest_approach_pace_fade_quality.mjs).
//
// Displacement = max |price - levelPrice| excursion between the level's last same-session visit
// (10pt band, matching acd.js's own live minutesSinceVisit convention) and the current touch.
// Trades with no prior same-session visit (first touch) are reported separately -- displacement
// since a visit that never happened isn't a meaningful question for them.
//
// Reuses the level-lookup/session-boundary machinery already validated this session
// (scratch/census_idea_d_cluster_freshness.mjs's loadLevels()/getSessionStartString(), the same
// pattern scripts/backtest_ib_or_volbuild_walkforward_refresh.mjs and
// scripts/backtest_approach_pace_fade_quality.mjs already use) rather than re-deriving it.
import { query } from '../server/db.js';
import { classifyLevelFormation } from '../server/config/setupTypes.js';
import { directionFromType } from '../server/services/maeMfeReplay.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';

const WARMUP_TRADES = 150;
const VISIT_BAND = 10; // matches acd.js's live minutesSinceVisit band exactly

const SAME_DAY_FORMING_MINUTE = {
  OR5_HIGH: 575, OR5_LOW: 575, OR5_MID: 575,
  OR10_HIGH: 580, OR10_LOW: 580, OR10_MID: 580,
  OR30_HIGH: 600, OR30_LOW: 600, OR30_MID: 600,
  IB_HIGH: 630, IB_LOW: 630, IB_MID: 630,
};

function getLevelNameFromSetup(setupType) {
  let stripped = setupType
    .replace(/_FADE_LONG/g, '').replace(/_FADE_SHORT/g, '').replace(/_FADE/g, '')
    .replace(/_TRAIL/g, '').replace(/_GAP_UP/g, '').replace(/_GAP_DOWN/g, '').replace(/_OVERNIGHT/g, '');
  if (stripped === 'IB_MID_SCALP') return 'IB_MID';
  return stripped;
}

function etMinutesOfDay(naiveStr) {
  return parseInt(naiveStr.slice(11, 13), 10) * 60 + parseInt(naiveStr.slice(14, 16), 10);
}

function getSessionStartString(tradeDateStr, setupType, firedAtNaive) {
  const hour = parseInt(firedAtNaive.slice(11, 13), 10);
  let isRth;
  if (setupType.includes('_OVERNIGHT') || setupType.includes('GLOBEX_VWAP') || setupType.includes('ONH') || setupType.includes('ONL')) isRth = false;
  else if (setupType.includes('RTH') || setupType.includes('OR5') || setupType.includes('OR10') || setupType.includes('OR30') || setupType.includes('IB_')) isRth = true;
  else isRth = (hour >= 9 && hour < 16);
  if (isRth) return tradeDateStr + ' 09:30:00';
  const d = new Date(tradeDateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10) + ' 18:00:00';
}

async function loadLevels() {
  const res = await query(`SELECT trade_date::text as trade_date, level_name, price::float FROM level_prices ORDER BY trade_date ASC`);
  const levelsByDate = {};
  let currentTradeDate = null, latestLevels = {};
  for (const row of res.rows) {
    if (row.trade_date !== currentTradeDate) {
      if (currentTradeDate !== null) levelsByDate[currentTradeDate] = { ...latestLevels };
      currentTradeDate = row.trade_date;
    }
    latestLevels[row.level_name] = row.price;
  }
  if (currentTradeDate !== null) levelsByDate[currentTradeDate] = { ...latestLevels };
  const allCalendarDates = await query(`SELECT DISTINCT trade_date::text as d FROM level_prices ORDER BY d ASC`);
  const denseLevelMap = {}; let runningLevels = {}; const checkpointDates = [];
  for (const row of allCalendarDates.rows) {
    const d = row.d;
    if (levelsByDate[d]) runningLevels = { ...runningLevels, ...levelsByDate[d] };
    denseLevelMap[d] = { ...runningLevels };
    checkpointDates.push(d);
  }
  return (td) => {
    let lo = 0, hi = checkpointDates.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (checkpointDates[mid] <= td) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return best === -1 ? null : denseLevelMap[checkpointDates[best]];
  };
}

function auc(scores, outcomes) {
  const valid = scores.map((s, i) => ({ s, o: outcomes[i] })).filter(x => x.s != null);
  const pos = valid.filter(x => x.o === 1), neg = valid.filter(x => x.o === 0);
  if (pos.length === 0 || neg.length === 0) return null;
  let wins = 0, ties = 0;
  for (const p of pos) for (const n of neg) { if (p.s > n.s) wins++; else if (p.s === n.s) ties++; }
  return { auc: (wins + 0.5 * ties) / (pos.length * neg.length), nPos: pos.length, nNeg: neg.length };
}

async function main() {
  const getLevelsForDate = await loadLevels();

  const setupsRes = await query(`
    SELECT id, setup_type, trade_date::text as trade_date, fired_at, actual_pnl::float as pnl
    FROM active_setups
    WHERE origin_status IN ('ACTIVE','SHADOW') AND resolution IN ('STOP_HIT','TARGET_HIT')
      AND actual_pnl IS NOT NULL AND setup_type LIKE '%FADE%' AND fired_at IS NOT NULL
    ORDER BY fired_at ASC
  `);
  console.log(`Real FADE trades: ${setupsRes.rows.length}`);

  const minDate = setupsRes.rows[0].trade_date, maxDate = setupsRes.rows[setupsRes.rows.length - 1].trade_date;
  const barsRes = await query(`
    SELECT ts, close::float, high::float, low::float,
           (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts))::int as mod
    FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1::date - INTERVAL '3 days' AND ts < $2::date + INTERVAL '1 day'
    ORDER BY ts ASC
  `, [minDate, maxDate]);
  const bars = barsRes.rows;
  const tsIndex = new Map();
  for (let i = 0; i < bars.length; i++) tsIndex.set(bars[i].ts.getTime(), i);
  console.log(`Loaded ${bars.length} bars.`);

  const scored = [];
  let noAnchorPrice = 0, noPriorVisit = 0, dropped = 0;
  for (const t of setupsRes.rows) {
    const anchorName = getLevelNameFromSetup(t.setup_type);
    const levelsForDate = getLevelsForDate(t.trade_date);
    const anchorPrice = levelsForDate ? levelsForDate[anchorName] : undefined;
    if (anchorPrice === undefined) { noAnchorPrice++; continue; }

    const flooredFiredAt = new Date(t.fired_at);
    flooredFiredAt.setSeconds(0, 0);
    const touchIdx = tsIndex.get(flooredFiredAt.getTime());
    if (touchIdx === undefined) { dropped++; continue; }
    const firedAtNaive = flooredFiredAt.toISOString().slice(0, 19).replace('T', ' ');
    const firedAtMin = etMinutesOfDay(firedAtNaive);

    const formationMin = SAME_DAY_FORMING_MINUTE[anchorName];
    if (formationMin !== undefined && firedAtMin < formationMin) { dropped++; continue; }

    const sessionStartNaive = getSessionStartString(t.trade_date, t.setup_type, firedAtNaive);
    const sessionStartDate = new Date(sessionStartNaive + 'Z');
    const sessionStartMs = sessionStartDate.getTime();

    // Find the last same-session visit (10pt band) BEFORE the touch, then the max displacement
    // from the last visit through the touch.
    let lastVisitIdx = null;
    for (let i = touchIdx - 1; i >= 0; i--) {
      if (bars[i].ts.getTime() < sessionStartMs) break;
      if (Math.abs(bars[i].close - anchorPrice) <= VISIT_BAND) { lastVisitIdx = i; break; }
    }
    if (lastVisitIdx === null) { noPriorVisit++; continue; }

    let maxDisp = 0;
    for (let i = lastVisitIdx + 1; i < touchIdx; i++) {
      maxDisp = Math.max(maxDisp, Math.abs(bars[i].high - anchorPrice), Math.abs(bars[i].low - anchorPrice));
    }

    scored.push({
      ...t, maxDisp, win: t.pnl > 0 ? 1 : 0,
      isRth: firedAtMin >= 570 && firedAtMin < 960,
      formation: classifyLevelFormation(t.setup_type),
      direction: directionFromType(t.setup_type),
    });
  }
  console.log(`Scoreable (had a prior same-session visit): ${scored.length}`);
  console.log(`Dropped: noAnchorPrice=${noAnchorPrice}, noPriorVisit(first-touch)=${noPriorVisit}, other=${dropped}`);

  const overallAuc = auc(scored.map(s => s.maxDisp), scored.map(s => s.win));
  console.log(`\nPooled AUC: ${overallAuc?.auc.toFixed(3)} (N=${scored.length})`);
  const rthScored = scored.filter(s => s.isRth), gxScored = scored.filter(s => !s.isRth);
  console.log(`RTH AUC: ${auc(rthScored.map(s=>s.maxDisp), rthScored.map(s=>s.win))?.auc.toFixed(3)} (N=${rthScored.length})`);
  console.log(`Globex AUC: ${auc(gxScored.map(s=>s.maxDisp), gxScored.map(s=>s.win))?.auc.toFixed(3)} (N=${gxScored.length})`);

  // Walk-forward quartile breakdown
  const history = [];
  const classified = [];
  for (const s of scored) {
    if (history.length >= WARMUP_TRADES) {
      const sorted = [...history].sort((a, b) => a - b);
      const p25 = sorted[Math.floor(sorted.length * 0.25)], p50 = sorted[Math.floor(sorted.length * 0.50)], p75 = sorted[Math.floor(sorted.length * 0.75)];
      let q;
      if (s.maxDisp <= p25) q = 'Q1'; else if (s.maxDisp <= p50) q = 'Q2'; else if (s.maxDisp <= p75) q = 'Q3'; else q = 'Q4';
      classified.push({ ...s, q });
    }
    history.push(s.maxDisp);
  }
  console.log(`\nWalk-forward classified (after ${WARMUP_TRADES}-trade warmup): ${classified.length}`);

  console.log(`\n--- Walk-forward quartile breakdown (Q1=least displaced/most clustered, Q4=most displaced) ---`);
  const bucketStats = {};
  for (const bucket of ['Q1', 'Q2', 'Q3', 'Q4']) {
    const b = classified.filter(c => c.q === bucket);
    const wr = b.length ? b.filter(x => x.win === 1).length / b.length : null;
    const ev = b.length ? b.reduce((s, x) => s + x.pnl, 0) / b.length : null;
    bucketStats[bucket] = { n: b.length, wr, ev };
    console.log(`${bucket}: N=${b.length}, WR=${wr != null ? (wr * 100).toFixed(1) + '%' : 'n/a'}, EV=${ev != null ? '$' + ev.toFixed(2) : 'n/a'}`);
  }
  const monotonicUp = bucketStats.Q1.ev <= bucketStats.Q2.ev && bucketStats.Q2.ev <= bucketStats.Q3.ev && bucketStats.Q3.ev <= bucketStats.Q4.ev;
  const monotonicDown = bucketStats.Q1.ev >= bucketStats.Q2.ev && bucketStats.Q2.ev >= bucketStats.Q3.ev && bucketStats.Q3.ev >= bucketStats.Q4.ev;
  console.log(`Monotonic increasing (displacement helps): ${monotonicUp}`);
  console.log(`Monotonic decreasing (clustering helps): ${monotonicDown}`);

  const q4Rigor = computeRigor(classified, { dateField: 'trade_date', filterFn: e => e.q === 'Q4', pnlFn: e => e.pnl });
  const q1Rigor = computeRigor(classified, { dateField: 'trade_date', filterFn: e => e.q === 'Q1', pnlFn: e => e.pnl });
  console.log(`\nQ4 rigor: stable=${q4Rigor.stable}, top5DayPct=${q4Rigor.top5DayPct}%, distinctDays=${new Set(classified.filter(c=>c.q==='Q4').map(c=>c.trade_date)).size}`);
  console.log(`Q1 rigor: stable=${q1Rigor.stable}, top5DayPct=${q1Rigor.top5DayPct}%, distinctDays=${new Set(classified.filter(c=>c.q==='Q1').map(c=>c.trade_date)).size}`);

  // Consistency check across family/direction (per this session's own hard-won lesson).
  function breakdown(groupFn, label) {
    const groups = {};
    for (const c of classified) {
      const g = groupFn(c);
      if (!groups[g]) groups[g] = { low: [], high: [] };
      groups[g][(c.q === 'Q1' || c.q === 'Q2') ? 'low' : 'high'].push(c.pnl);
    }
    console.log(`\n--- By ${label} (median split: LOW vs HIGH displacement) ---`);
    for (const [g, v] of Object.entries(groups)) {
      const evLow = v.low.length ? v.low.reduce((a,b)=>a+b,0)/v.low.length : null;
      const evHigh = v.high.length ? v.high.reduce((a,b)=>a+b,0)/v.high.length : null;
      console.log(`  ${g}: LOW-disp N=${v.low.length} EV=$${evLow?.toFixed(2)??'n/a'}, HIGH-disp N=${v.high.length} EV=$${evHigh?.toFixed(2)??'n/a'}`);
    }
  }
  breakdown(c => c.formation, 'formation type');
  breakdown(c => c.direction, 'direction');

  // First-touch (no prior visit) population, for reference -- not part of the primary test.
  console.log(`\n(First-touch-of-session trades, no prior visit to measure displacement from: N=${noPriorVisit} -- not included above)`);

  await recordClaim({
    slug: 'displacement_since_last_visit_fade_quality',
    claimText: `Full-roster test of the user's displacement idea (2026-09-01): instead of a time-based refire cooldown, does how far price has traveled from a level since its last same-session visit predict fade outcome (clustering/chop = bad, real displacement-and-return = legitimate)? Reuses acd.js's live minutesSinceVisit 10pt band and session-boundary conventions. Population: real FADE trades WITH a prior same-session visit (a strict subset of all real fades -- first-touch trades excluded, N=${noPriorVisit} of those), N=${scored.length} across ${new Set(scored.map(s=>s.trade_date)).size} distinct days. Pooled AUC=${overallAuc?.auc.toFixed(3)}, RTH AUC=${auc(rthScored.map(s=>s.maxDisp), rthScored.map(s=>s.win))?.auc.toFixed(3)} (N=${rthScored.length}), Globex AUC=${auc(gxScored.map(s=>s.maxDisp), gxScored.map(s=>s.win))?.auc.toFixed(3)} (N=${gxScored.length}). Walk-forward quartile EV: Q1(most clustered)=$${bucketStats.Q1.ev?.toFixed(2)}, Q2=$${bucketStats.Q2.ev?.toFixed(2)}, Q3=$${bucketStats.Q3.ev?.toFixed(2)}, Q4(most displaced)=$${bucketStats.Q4.ev?.toFixed(2)}. Monotonic increasing (more displacement = better): ${monotonicUp}. Monotonic decreasing (more clustering = better): ${monotonicDown}. Q4 rigor: stable=${q4Rigor.stable}, top5DayPct=${q4Rigor.top5DayPct}%. This directly resolves whether the single-setup exploratory check (12 refires, 11 from one day, showing clustering=better) generalizes -- see console output for the full family/direction consistency breakdown.`,
    sourceFile: 'scripts/backtest_displacement_since_last_visit.mjs',
    sourceDate: '2026-09-01',
    sampleSize: scored.length,
    winRate: bucketStats.Q4.wr,
    evPerTrade: (bucketStats.Q4.ev ?? 0) - (bucketStats.Q1.ev ?? 0),
    rigorStatus: (monotonicUp || monotonicDown) && q4Rigor.stable ? 'monotonic_and_stable' : 'not_decisive',
    status: 'PROVISIONAL',
  });

  console.log('\nDone.');
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
