// Full-roster walk-forward test of the approach-pace fade-quality lead found 2026-09-01
// (RESEARCH_CLAIM approach_pace_discriminates_globex_refire_setups, first-pass N=58, AUC=0.776,
// but dominated by PD_VAH_FADE_SHORT and only N=2/direction for GLOBEX_VWAP_MAGNET). User asked
// to scope and build the proper version on the full real fade roster, not just the 3
// refire-prone setup_types the lead was found on.
//
// Approach pace: absolute points traveled per bar over the 15 bars immediately before the touch
// (a fast, sharp move into the level vs a slow grind). Direction-agnostic, matching the
// exploratory methodology exactly -- not re-tuned here, since re-optimizing the window size on
// the same pass that's supposed to validate the finding would be circular.
//
// Walk-forward discipline (matching this session's own corrected convention): AUC is computed
// once over the full population (a legitimate global measure, not a live decision rule, so no
// lookahead concern) -- but the human-readable quartile breakdown uses an EXPANDING WINDOW
// (150-trade warmup, matching scratch/test_momentum_context_walkforward.mjs's own convention)
// so the bucket cutoffs a live system could actually have known at the time are what's reported.
import { query } from '../server/db.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';

const APPROACH_BARS = 15;
const WARMUP_TRADES = 150;

function auc(scores, outcomes) {
  const valid = scores.map((s, i) => ({ s, o: outcomes[i] })).filter(x => x.s != null);
  const pos = valid.filter(x => x.o === 1), neg = valid.filter(x => x.o === 0);
  if (pos.length === 0 || neg.length === 0) return null;
  let wins = 0, ties = 0;
  for (const p of pos) for (const n of neg) { if (p.s > n.s) wins++; else if (p.s === n.s) ties++; }
  return { auc: (wins + 0.5 * ties) / (pos.length * neg.length), nPos: pos.length, nNeg: neg.length };
}

async function main() {
  const setupsRes = await query(`
    SELECT id, setup_type, trade_date::text as trade_date, fired_at::text as fired_at, actual_pnl::float as pnl,
           (EXTRACT(hour FROM fired_at)*60 + EXTRACT(minute FROM fired_at))::int as fired_min
    FROM active_setups
    WHERE origin_status IN ('ACTIVE','SHADOW') AND resolution IN ('STOP_HIT','TARGET_HIT')
      AND actual_pnl IS NOT NULL AND setup_type LIKE '%FADE%' AND fired_at IS NOT NULL
    ORDER BY fired_at ASC
  `);
  console.log(`Real FADE trades: ${setupsRes.rows.length}`);

  const minDate = setupsRes.rows[0].trade_date, maxDate = setupsRes.rows[setupsRes.rows.length - 1].trade_date;
  const barsRes = await query(`
    SELECT ts, close::float FROM price_bars_primary
    WHERE symbol='NQ' AND ts >= $1::date - INTERVAL '3 days' AND ts < $2::date + INTERVAL '1 day'
    ORDER BY ts ASC
  `, [minDate, maxDate]);
  const bars = barsRes.rows.map(b => ({ ts: b.ts.getTime(), close: b.close }));
  const tsIndex = new Map();
  for (let i = 0; i < bars.length; i++) tsIndex.set(bars[i].ts, i);
  console.log(`Loaded ${bars.length} bars.`);

  const scored = [];
  for (const t of setupsRes.rows) {
    const flooredFiredAt = new Date(t.fired_at);
    flooredFiredAt.setSeconds(0, 0);
    const touchIdx = tsIndex.get(flooredFiredAt.getTime());
    if (touchIdx === undefined || touchIdx < APPROACH_BARS) continue;
    const pace = Math.abs(bars[touchIdx].close - bars[touchIdx - APPROACH_BARS].close) / APPROACH_BARS;
    const isRth = t.fired_min >= 570 && t.fired_min < 960;
    scored.push({ ...t, pace, isRth, win: t.pnl > 0 ? 1 : 0 });
  }
  console.log(`Scoreable (enough bar history): ${scored.length}`);

  // Global AUC -- pooled, then RTH/Globex split (this codebase's own hard rule: check both).
  const paces = scored.map(s => s.pace), wins = scored.map(s => s.win);
  const overallAuc = auc(paces, wins);
  console.log(`\nPooled AUC: ${overallAuc?.auc.toFixed(3)} (N=${scored.length}, wins=${overallAuc?.nPos}, losses=${overallAuc?.nNeg})`);

  const rthScored = scored.filter(s => s.isRth), gxScored = scored.filter(s => !s.isRth);
  const rthAuc = auc(rthScored.map(s => s.pace), rthScored.map(s => s.win));
  const gxAuc = auc(gxScored.map(s => s.pace), gxScored.map(s => s.win));
  console.log(`RTH AUC: ${rthAuc?.auc.toFixed(3)} (N=${rthScored.length})`);
  console.log(`Globex AUC: ${gxAuc?.auc.toFixed(3)} (N=${gxScored.length})`);

  // Walk-forward quartile breakdown (expanding window, no lookahead).
  const history = [];
  const classified = [];
  for (const s of scored) {
    if (history.length >= WARMUP_TRADES) {
      const sorted = [...history].sort((a, b) => a - b);
      const p25 = sorted[Math.floor(sorted.length * 0.25)];
      const p50 = sorted[Math.floor(sorted.length * 0.50)];
      const p75 = sorted[Math.floor(sorted.length * 0.75)];
      let q;
      if (s.pace <= p25) q = 'Q1'; else if (s.pace <= p50) q = 'Q2'; else if (s.pace <= p75) q = 'Q3'; else q = 'Q4';
      classified.push({ ...s, q });
    }
    history.push(s.pace);
  }
  console.log(`\nWalk-forward classified (after ${WARMUP_TRADES}-trade warmup): ${classified.length}`);

  console.log(`\n--- Walk-forward quartile breakdown (pooled) ---`);
  const bucketStats = {};
  for (const bucket of ['Q1', 'Q2', 'Q3', 'Q4']) {
    const b = classified.filter(c => c.q === bucket);
    const wr = b.length ? b.filter(x => x.win === 1).length / b.length : null;
    const ev = b.length ? b.reduce((s, x) => s + x.pnl, 0) / b.length : null;
    bucketStats[bucket] = { n: b.length, wr, ev };
    console.log(`${bucket}: N=${b.length}, WR=${wr != null ? (wr * 100).toFixed(1) + '%' : 'n/a'}, EV=${ev != null ? '$' + ev.toFixed(2) : 'n/a'}`);
  }
  const monotonic = bucketStats.Q1.ev <= bucketStats.Q2.ev && bucketStats.Q2.ev <= bucketStats.Q3.ev && bucketStats.Q3.ev <= bucketStats.Q4.ev;
  console.log(`Monotonic Q1<=Q2<=Q3<=Q4: ${monotonic}`);

  // Stability + day-clustering on Q4 (fast approach, the promising bucket).
  const q4Rigor = computeRigor(classified, { dateField: 'trade_date', filterFn: e => e.q === 'Q4', pnlFn: e => e.pnl });
  const q4Only = classified.filter(c => c.q === 'Q4');
  const q4ThirdSize = Math.ceil(q4Only.length / 3);
  const q4Thirds = [0, 1, 2].map(i => q4Only.slice(i * q4ThirdSize, (i + 1) * q4ThirdSize));
  const q4ThirdEvs = q4Thirds.map(t => t.length ? t.reduce((s, x) => s + x.pnl, 0) / t.length : null);
  console.log(`\nQ4 rigor: stable=${q4Rigor.stable}, top5DayPct=${q4Rigor.top5DayPct}%, distinctDays=${new Set(q4Only.map(c => c.trade_date)).size}`);
  console.log(`Q4 EV by chronological third: ${q4ThirdEvs.map(e => e != null ? '$' + e.toFixed(2) : 'n/a').join(' -> ')}`);

  // Setup-type concentration check within Q4 -- is this broad, or a repeat of the PD_VAH_
  // FADE_SHORT-dominance surprise from the exploratory pass?
  const bySetup = {};
  for (const x of q4Only) {
    if (!bySetup[x.setup_type]) bySetup[x.setup_type] = [];
    bySetup[x.setup_type].push(x.pnl);
  }
  const setupBreakdown = Object.entries(bySetup)
    .map(([k, v]) => ({ type: k, n: v.length, wr: v.filter(p => p > 0).length / v.length, ev: v.reduce((a, b) => a + b, 0) / v.length }))
    .sort((a, b) => b.n - a.n);
  console.log(`\nQ4 setup_type concentration (top 10 by N):`);
  for (const s of setupBreakdown.slice(0, 10)) {
    console.log(`  ${s.type}: N=${s.n}, WR=${(s.wr * 100).toFixed(1)}%, EV=$${s.ev.toFixed(2)}`);
  }
  const distinctTypesInQ4 = setupBreakdown.length;
  const topTypeShare = q4Only.length > 0 ? setupBreakdown[0].n / q4Only.length : null;
  console.log(`Distinct setup_types in Q4: ${distinctTypesInQ4}, top type share: ${topTypeShare != null ? (topTypeShare * 100).toFixed(1) + '%' : 'n/a'}`);

  await recordClaim({
    slug: 'approach_pace_fade_quality_full_roster',
    claimText: `Full-roster walk-forward test of the approach-pace lead (RESEARCH_CLAIM approach_pace_discriminates_globex_refire_setups, N=58 exploratory), built at user request ("scope and start that"). Population: all real (origin_status ACTIVE/SHADOW) FADE trades, N=${scored.length} across ${new Set(scored.map(s=>s.trade_date)).size} distinct days -- not just the 3 refire-prone setup_types the lead was found on. Pace = |points traveled| / bar over the 15 bars into the touch (matches the exploratory methodology exactly, not re-tuned). Pooled AUC=${overallAuc?.auc.toFixed(3)}, RTH AUC=${rthAuc?.auc.toFixed(3)} (N=${rthScored.length}), Globex AUC=${gxAuc?.auc.toFixed(3)} (N=${gxScored.length}). Walk-forward quartile breakdown (150-trade warmup, no lookahead): Q1 N=${bucketStats.Q1.n} EV=$${bucketStats.Q1.ev?.toFixed(2)}, Q2 N=${bucketStats.Q2.n} EV=$${bucketStats.Q2.ev?.toFixed(2)}, Q3 N=${bucketStats.Q3.n} EV=$${bucketStats.Q3.ev?.toFixed(2)}, Q4 N=${bucketStats.Q4.n} EV=$${bucketStats.Q4.ev?.toFixed(2)}. Monotonic: ${monotonic}. Q4 rigor: stable=${q4Rigor.stable}, top5DayPct=${q4Rigor.top5DayPct}%, distinctDays=${new Set(q4Only.map(c=>c.trade_date)).size}, chronological thirds: ${q4ThirdEvs.map(e => e != null ? '$' + e.toFixed(2) : 'n/a').join(' -> ')}. Setup-type concentration in Q4: ${distinctTypesInQ4} distinct types, top type (${setupBreakdown[0]?.type}) is ${topTypeShare != null ? (topTypeShare*100).toFixed(1) : 'n/a'}% of Q4 -- ${topTypeShare != null && topTypeShare < 0.4 ? 'broad, not a single-setup artifact' : 'concentrated, treat with caution'}.`,
    sourceFile: 'scripts/backtest_approach_pace_fade_quality.mjs',
    sourceDate: '2026-09-01',
    sampleSize: scored.length,
    winRate: bucketStats.Q4.wr,
    evPerTrade: bucketStats.Q4.ev,
    rigorStatus: monotonic && q4Rigor.stable ? 'monotonic_and_stable' : 'not_yet_decisive',
    status: 'PROVISIONAL',
  });

  console.log('\nDone.');
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
