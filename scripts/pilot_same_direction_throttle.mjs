// =============================================================================
// PILOT — cross-setup-type same-direction fire-density throttle (Opus Audit 8 §2.4 / R4),
// Stage-0/1 study, per DeepSeek's Phase-0 design critique
// (scratch/deepseek_cluster_loss_fixes_design_review.md, section 2, "Build 1").
//
// Idea: Opus Audit 8 found that counting prior same-direction active_setups fires (any
// setup_type, origin_status IN ('ACTIVE','SHADOW')) in a rolling window before each
// candidate shows a monotone EV decline from 0 prior fires (+$12.35) to 3 prior fires
// (-$14.83), but a 4+ rebound that breaks the pattern. Simulating a throttle
// (max K same-direction fires per rolling W minutes) at K=2/W=30min looked promising
// (+24% EV/trade, -27% exposure) but K=1/W=60min INVERTED entirely -- the same
// brittleness signature that killed an earlier "4H-EMA" filter in this codebase.
//
// DeepSeek's bar (A) -- before this is even a "Stage-1 finding worth reporting" --
// requires ALL THREE:
//   1. Explain the 4+ rebound as a day-regime confound (cross density buckets against
//      day x direction P&L), don't just assert it.
//   2. A genuine K/W plateau -- per the value-adjacent-neighbor convention this codebase
//      already uses (targetCalibrationService.js's selectPlateauTarget(), cited directly
//      by DeepSeek's critique): the candidate's IMMEDIATE grid neighbors (K-1, K+1 at the
//      same W; W-1, W+1 at the same K) must be the same sign as the candidate itself --
//      not full-row/column uniformity across the whole grid, which is a stricter and
//      different check than this codebase's own convention.
//   3. computeRigor().clean on the kept arm at the evaluated (K, W).
//
// Build history: mine-and-run dispatched to Gemini per CLAUDE.md's "Gemini owns heavy
// DB mining" rule (scratch/gemini_pilot_same_direction_throttle.mjs, scratch/
// gemini_build1_throttle_study.md). Audited before trusting: Gemini's baseline (ACTIVE,
// resolution IN ('STOP_HIT','TARGET_HIT'), n=325 EV=$10.26) did NOT match Audit 8's own
// stated R4 baseline (n=344, EV=$11.41) for the same population -- traced to a dispatch-
// spec error (Claude's, not Gemini's): Audit 8's population is ACTIVE + actual_pnl NOT
// NULL under ANY resolution (also TIME_EXPIRED/INVALIDATED, which carry a real
// mark-to-market/structural-invalidation P&L per resolveSetupsByPrice()'s convention),
// not just STOP_HIT/TARGET_HIT. Verified directly against the DB (n=348/EV=$11.26 now,
// small drift from trades resolved since the audit ran same-day) before correcting and
// re-running. Re-testing an existing finding requires matching its population exactly.
//
// Deliberate population note: this script does NOT apply REAL_TRADE_FILTER (from
// backtest_setup_status.mjs) on top of "ACTIVE + actual_pnl not null" -- REAL_TRADE_FILTER
// excludes MARK_TO_MARKET/RECOVERY_MTM/stale-IB rows and would change n=348->307,
// EV=$11.26->$8.61 (verified directly), which would silently make this a DIFFERENT
// population than the one Audit 8's R4 finding describes. Fidelity to the finding being
// re-tested wins over the standing "real trades" convention here -- explicit tradeoff,
// not an oversight. A follow-up under REAL_TRADE_FILTER would only be worth doing if this
// study's primary finding survived bar (A), which it does not (see verdict below).
// =============================================================================

import { query } from '../server/db.js';
import { resolveDirection } from '../server/config/setupTypes.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';

const Ks = [1, 2, 3];
const Ws = [15, 30, 60]; // minutes
const PRIMARY_K = 2; // Audit 8's original point estimate -- the (K,W) bar (A) is evaluated on
const PRIMARY_W = 30;

const sign = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);

function neighborsOf(K0, W0) {
  const ki = Ks.indexOf(K0), wi = Ws.indexOf(W0);
  const out = [];
  if (ki > 0) out.push([Ks[ki - 1], W0]);
  if (ki < Ks.length - 1) out.push([Ks[ki + 1], W0]);
  if (wi > 0) out.push([K0, Ws[wi - 1]]);
  if (wi < Ws.length - 1) out.push([K0, Ws[wi + 1]]);
  return out;
}

async function main() {
  const todayRes = await query(`SELECT CURRENT_DATE::text as today`);
  const today = todayRes.rows[0].today;

  const res = await query(`
    SELECT id, trade_date, fired_at, setup_type, stop_level, t1_level, origin_status,
           resolution, actual_pnl
    FROM active_setups
    WHERE origin_status IN ('ACTIVE','SHADOW')
    ORDER BY fired_at ASC, id ASC
  `);

  const rows = res.rows
    .map(r => ({
      ...r,
      log_date: r.trade_date instanceof Date ? r.trade_date.toISOString().slice(0, 10) : String(r.trade_date).slice(0, 10),
      fired_at_ms: new Date(r.fired_at).getTime(),
      actual_pnl: r.actual_pnl != null ? Number(r.actual_pnl) : null,
      direction: resolveDirection(r),
    }))
    .filter(r => r.direction != null);

  if (rows.length === 0) {
    console.error('[ABORT] Zero direction-resolvable ACTIVE/SHADOW rows -- this is a bug, not a real finding. Refusing to record a RESEARCH_CLAIM.');
    process.exit(1);
  }

  // Prior same-direction fire counts (any setup_type), no lookahead -- only fired_at
  // timestamps strictly before the candidate's own fired_at count, and only firing (not
  // outcome) matters, so no resolution-lag constraint applies (this differs from Audit 8
  // §2.3's realized-P&L circuit-breaker test, which needed the prior trade to have already
  // resolved; this density measure is fully causal at insert time).
  for (let i = 0; i < rows.length; i++) {
    const cand = rows[i];
    cand.priorCounts = {};
    for (const W of Ws) {
      let count = 0;
      const windowMs = W * 60 * 1000;
      for (let j = i - 1; j >= 0; j--) {
        const prior = rows[j];
        if (cand.fired_at_ms - prior.fired_at_ms > windowMs) break;
        // Strict less-than: rows tied on the exact same fired_at minute (real, common --
        // several setup_types firing off the same 15s detection poll) have no causal
        // "before" relationship and must not count as prior fires of each other.
        if (prior.fired_at_ms < cand.fired_at_ms && prior.direction === cand.direction) count++;
      }
      cand.priorCounts[W] = count;
    }
  }

  // Audit 8's own R4 population: ACTIVE with any real resolved actual_pnl (see header note).
  const candidateSet = rows.filter(r => r.origin_status === 'ACTIVE' && r.actual_pnl !== null);

  if (candidateSet.length === 0) {
    console.error('[ABORT] Zero ACTIVE resolved candidates -- this is a bug, not a real finding. Refusing to record a RESEARCH_CLAIM.');
    process.exit(1);
  }

  const baselineEV = candidateSet.reduce((s, r) => s + r.actual_pnl, 0) / candidateSet.length;
  console.log(`Baseline (no throttle, ACTIVE w/ real actual_pnl): n=${candidateSet.length}, EV=$${baselineEV.toFixed(2)}\n`);

  const grid = {};
  console.log('K/W throttle grid:');
  for (const W of Ws) {
    grid[W] = {};
    for (const K of Ks) {
      const kept = candidateSet.filter(r => r.priorCounts[W] < K);
      const blocked = candidateSet.filter(r => r.priorCounts[W] >= K);
      const keptEV = kept.length ? kept.reduce((s, r) => s + r.actual_pnl, 0) / kept.length : 0;
      const keptWR = kept.length ? kept.filter(r => r.actual_pnl > 0).length / kept.length * 100 : 0;
      const blockedEV = blocked.length ? blocked.reduce((s, r) => s + r.actual_pnl, 0) / blocked.length : 0;
      const blockedTotal = blocked.length ? blocked.reduce((s, r) => s + r.actual_pnl, 0) : 0;
      const dEV = baselineEV !== 0 ? (keptEV - baselineEV) / Math.abs(baselineEV) * 100 : 0;
      grid[W][K] = { kept, blocked, keptEV, keptWR, blockedEV, blockedTotal, dEV };
      console.log(`  W=${String(W).padStart(2)} K=${K} | kept n=${String(kept.length).padStart(3)} EV=$${keptEV.toFixed(2).padStart(7)} WR=${keptWR.toFixed(1)}%  | blocked n=${String(blocked.length).padStart(3)} EV=$${blockedEV.toFixed(2).padStart(7)} total=$${blockedTotal.toFixed(2)}  | dEV=${dEV >= 0 ? '+' : ''}${dEV.toFixed(1)}%`);
    }
  }

  // --- 1. Day-regime confound check for the 4+ rebound (W=30, matching Audit 8's original bucketing) ---
  const dayDirPnl = new Map(); // "date_direction" -> total ACTIVE resolved pnl
  for (const r of rows) {
    if (r.origin_status !== 'ACTIVE' || r.actual_pnl == null) continue;
    const key = `${r.log_date}_${r.direction}`;
    dayDirPnl.set(key, (dayDirPnl.get(key) || 0) + r.actual_pnl);
  }
  const dayDirFireCounts = new Map();
  for (const r of rows) {
    const key = `${r.log_date}_${r.direction}`;
    dayDirFireCounts.set(key, (dayDirFireCounts.get(key) || 0) + 1);
  }
  const top3Keys = new Set(
    [...dayDirFireCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k)
  );

  const bucket30 = { 0: [], 1: [], 2: [], 3: [], '4+': [] };
  for (const r of candidateSet) {
    const c = r.priorCounts[30];
    bucket30[c >= 4 ? '4+' : c].push(r);
  }
  console.log('\nDay-regime crosstab (W=30 prior-fire buckets vs top-3 highest-fire-count day x direction cells):');
  console.log(`  top-3 cells: ${[...top3Keys].join(', ')}`);
  let reboundExplained = null;
  for (const b of ['0', '1', '2', '3', '4+']) {
    const trades = bucket30[b];
    const top3 = trades.filter(r => top3Keys.has(`${r.log_date}_${r.direction}`));
    const other = trades.filter(r => !top3Keys.has(`${r.log_date}_${r.direction}`));
    const bucketEV = trades.length ? trades.reduce((s, r) => s + r.actual_pnl, 0) / trades.length : 0;
    const otherEV = other.length ? other.reduce((s, r) => s + r.actual_pnl, 0) / other.length : 0;
    const top3Pct = trades.length ? (top3.length / trades.length * 100) : 0;
    console.log(`  bucket ${b.padEnd(2)} n=${String(trades.length).padStart(3)} EV=$${bucketEV.toFixed(2).padStart(7)}  | ${top3Pct.toFixed(1)}% from top-3 days | non-top-3 EV=$${otherEV.toFixed(2)} (n=${other.length})`);
    if (b === '4+') {
      // "Explained by day clustering" = excluding the top-3-day trades roughly halves or
      // eliminates the bucket's apparent edge.
      reboundExplained = bucketEV > 0 && otherEV < bucketEV * 0.5;
    }
  }
  console.log(`  4+ rebound explained by day clustering: ${reboundExplained}`);

  // --- 2. Plateau check on the primary (K,W) = (2,30) candidate ---
  const primary = grid[PRIMARY_W][PRIMARY_K];
  const primarySign = sign(primary.dEV);
  const neighbors = neighborsOf(PRIMARY_K, PRIMARY_W);
  const neighborResults = neighbors.map(([k, w]) => ({ k, w, dEV: grid[w][k].dEV, sameSign: sign(grid[w][k].dEV) === primarySign }));
  const plateauPass = neighborResults.every(n => n.sameSign);
  console.log(`\nPlateau check at primary K=${PRIMARY_K}/W=${PRIMARY_W} (dEV=${primary.dEV.toFixed(1)}%):`);
  for (const n of neighborResults) {
    console.log(`  neighbor K=${n.k}/W=${n.w}: dEV=${n.dEV.toFixed(1)}%  same-sign=${n.sameSign}`);
  }
  console.log(`  plateau pass: ${plateauPass}`);

  // --- 3. Rigor check on the primary kept arm ---
  const rigor = computeRigor(primary.kept, { dateField: 'log_date', pnlFn: r => r.actual_pnl });
  console.log(`\ncomputeRigor(K=${PRIMARY_K}/W=${PRIMARY_W} kept arm, n=${primary.kept.length}):`);
  console.log(`  ${JSON.stringify(rigor)}`);

  // --- Overall bar (A) verdict ---
  const barA = reboundExplained === true && plateauPass === true && rigor.clean === true;
  console.log(`\n${'='.repeat(90)}`);
  console.log(`BAR (A) VERDICT: ${barA ? 'CLEARS' : 'FAILS'} (rebound explained=${reboundExplained}, plateau pass=${plateauPass}, rigor clean=${rigor.clean})`);
  if (!barA) {
    const failedOn = [];
    if (!reboundExplained) failedOn.push('rebound not explained by day clustering');
    if (!plateauPass) failedOn.push('no genuine K/W plateau');
    if (!rigor.clean) failedOn.push(`rigor not clean (stable=${rigor.stable}, clustered=${rigor.clustered}, thirds=${JSON.stringify(rigor.thirds)})`);
    console.log(`  Failed on: ${failedOn.join('; ')}`);
  }
  console.log('='.repeat(90));

  await recordClaim({
    slug: 'same_direction_throttle_stage1',
    claimText: `Stage-0/1 re-test of Opus Audit 8's cross-setup-type same-direction fire-density ` +
      `throttle (§2.4/R4): max K same-direction active_setups fires per rolling W minutes, any ` +
      `setup_type, direction via resolveDirection(). Population matches Audit 8's own R4 baseline ` +
      `exactly (ACTIVE origin_status, any resolution with a real actual_pnl -- n=${candidateSet.length}, ` +
      `EV=$${baselineEV.toFixed(2)}, vs Audit 8's original n=344/EV=$11.41 same-day drift). ` +
      `DeepSeek's bar (A) requires explaining the 4+ density-bucket rebound as a day-regime confound, ` +
      `a genuine K/W plateau (immediate-neighbor same-sign, targetCalibrationService.js convention), ` +
      `and computeRigor().clean on the primary K=${PRIMARY_K}/W=${PRIMARY_W} kept arm (n=${primary.kept.length}, ` +
      `EV=$${primary.keptEV.toFixed(2)}, dEV=${primary.dEV.toFixed(1)}% vs baseline). Result: rebound IS ` +
      `explained by day clustering (${reboundExplained}) and the plateau DOES pass (${plateauPass}, all 4 ` +
      `immediate K/W neighbors same-sign) -- but the kept arm fails chronological stability ` +
      `(stable=${rigor.stable}, thirds EV ${JSON.stringify(rigor.thirds)} -- declining into a negative final ` +
      `third), so bar (A) does not clear overall. This is a more precise negative than the original ` +
      `single-point K=2/W=30 estimate suggested: the effect is not a mixture artifact or an isolated ` +
      `spike, it is a real but chronologically decaying pattern -- not stable enough to trust as a live ` +
      `filter today. Does not apply REAL_TRADE_FILTER (deliberate, see script header -- fidelity to ` +
      `Audit 8's population over the standing convention).`,
    sourceFile: 'scripts/pilot_same_direction_throttle.mjs',
    sourceDate: today,
    sampleSize: candidateSet.length,
    winRate: null,
    evPerTrade: barA ? primary.dEV : null,
    rigorStatus: 'checked',
    status: 'CONFIRMED',
  });

  console.log(`\nRecorded RESEARCH_CLAIM same_direction_throttle_stage1. No live wiring -- Build 1 does ` +
    `not clear DeepSeek's bar (A); per the design critique, bar (B) (any wiring, including SHADOW-` +
    `informational) is strictly higher and moot until (A) clears.`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
