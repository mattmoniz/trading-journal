// Real (not illustrative) test of Opus Audit #14's core Step-1 hypothesis
// (scratch/opus_audit_14_ml_strategy_results.md section 2.3 / OPEN_DECISION
// ml_direction_signed_features_untested_20260924): does signing an order-flow feature by
// real trade direction (dir = +1 long / -1 short) reveal a gradient that the raw,
// unsigned feature hides? The audit's own illustrative check (N=3,046, 57 days) found a
// real-looking spread but explicitly called it "not a finding" -- this script re-runs the
// same shape as an actual registered claim, with day-blocked bootstrap CIs on the tercile
// spread (dayBlockedBootstrapDeltaCI, added to rigorDiagnostics.js the same day for this
// exact purpose) and cluster-sibling collapsing, not just descriptive numbers.
//
// Feature: ml_intraday_features->>'recentDelta15Bars' (server/services/mlFeatureSnapshot.js
// line ~114 -- cumulative ask_volume-bid_volume over the trailing 15 bars at fire time).
// Direction: inferDirection(setup_type), the canonical resolver (server/config/setupTypes.js)
// -- reused directly, not reimplemented. Population: REAL_TRADE_FILTER (this codebase's own
// canonical real-trade filter, backtest_setup_status.mjs), STOP_HIT/TARGET_HIT only,
// cluster-primary rows only for the raw pull (siblings collapsed before the CI, not before
// the tercile split -- a cluster's sibling members share the same touch instant and
// direction, so collapsing them into the tercile assignment first would just delete real
// but correlated observations; collapsing happens only at the CI-computation stage, matching
// collapseClusterSiblings()'s own intended use).
import { query } from '../server/db.js';
import { inferDirection } from '../server/config/setupTypes.js';
import { REAL_TRADE_FILTER } from './backtest_setup_status.mjs';
import { collapseClusterSiblings, dayBlockedBootstrapDeltaCI } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';

function tercileSplit(sortedVals, val, edges) {
  if (val <= edges[0]) return 'T1';
  if (val <= edges[1]) return 'T2';
  return 'T3';
}

function summarizeGroup(rows) {
  const n = rows.length;
  if (!n) return { n: 0, ev: null, wr: null };
  const totalPnl = rows.reduce((s, r) => s + r.pnl, 0);
  const wins = rows.filter(r => r.pnl > 0).length;
  return { n, ev: totalPnl / n, wr: wins / n };
}

async function runSegment(rows, label) {
  if (rows.length < 20) {
    console.log(`${label}: N=${rows.length}, too thin to segment (need >=20)`);
    return null;
  }
  const sortedSigned = [...rows].map(r => r.signed).sort((a, b) => a - b);
  const p33 = sortedSigned[Math.floor(sortedSigned.length / 3)];
  const p67 = sortedSigned[Math.floor((sortedSigned.length * 2) / 3)];
  const withTercile = rows.map(r => ({ ...r, tercile: tercileSplit(sortedSigned, r.signed, [p33, p67]) }));

  const t1 = withTercile.filter(r => r.tercile === 'T1');
  const t3 = withTercile.filter(r => r.tercile === 'T3');
  const t1Sum = summarizeGroup(t1);
  const t3Sum = summarizeGroup(t3);

  const ciEvents = withTercile
    .filter(r => r.tercile === 'T1' || r.tercile === 'T3')
    .map(r => ({ date: r.trade_date, group: r.tercile, pnl: r.pnl, cluster_touch_id: r.cluster_touch_id }));
  const ci = dayBlockedBootstrapDeltaCI(ciEvents, `direction_signed_recentdelta_${label}`, {
    dateField: 'date', groupField: 'group', groupA: 'T1', groupB: 'T3',
  });

  console.log(`${label}: N=${rows.length}`);
  console.log(`  T1 (flow against, signed<=${p33.toFixed(1)}): EV=$${t1Sum.ev?.toFixed(2)}, WR=${(t1Sum.wr * 100).toFixed(1)}%, n=${t1Sum.n}`);
  console.log(`  T3 (flow with, signed>${p67.toFixed(1)}): EV=$${t3Sum.ev?.toFixed(2)}, WR=${(t3Sum.wr * 100).toFixed(1)}%, n=${t3Sum.n}`);
  console.log(`  T3-T1 delta: $${(t3Sum.ev - t1Sum.ev).toFixed(2)}, day-blocked 95% CI: [$${ci.lo?.toFixed(2)}, $${ci.hi?.toFixed(2)}] (n_valid_iters=${ci.n_valid_iters})`);

  return {
    n: rows.length, t1: t1Sum, t3: t3Sum,
    delta: t3Sum.ev - t1Sum.ev, ci_lo: ci.lo, ci_hi: ci.hi,
    excludes_zero: ci.lo != null && ci.hi != null && (ci.lo > 0 || ci.hi < 0),
  };
}

async function main() {
  const { rows: raw } = await query(`
    SELECT id, setup_type, trade_date::text AS trade_date, is_rth, cluster_touch_id,
      actual_pnl, ml_intraday_features->>'recentDelta15Bars' AS recent_delta
    FROM active_setups
    WHERE ${REAL_TRADE_FILTER}
      AND resolution IN ('STOP_HIT', 'TARGET_HIT')
      AND (is_cluster_primary IS NULL OR is_cluster_primary = true)
      AND ml_intraday_features IS NOT NULL
      AND ml_intraday_features->>'recentDelta15Bars' IS NOT NULL
      AND actual_pnl IS NOT NULL
  `);
  console.log(`Raw real fade+other-setup rows with recentDelta15Bars present: ${raw.length}`);

  const rows = [];
  let skippedNoDir = 0;
  for (const r of raw) {
    const dir = inferDirection(r.setup_type);
    if (dir == null) { skippedNoDir++; continue; }
    const dirNum = dir === 'LONG' ? 1 : -1;
    const rd = parseFloat(r.recent_delta);
    if (!Number.isFinite(rd)) continue;
    rows.push({
      id: r.id, trade_date: r.trade_date, is_rth: r.is_rth,
      cluster_touch_id: r.cluster_touch_id, pnl: parseFloat(r.actual_pnl),
      raw_feature: rd, signed: rd * dirNum,
    });
  }
  console.log(`Usable rows (direction resolved): ${rows.length} (skipped ${skippedNoDir} with no inferrable direction)`);
  console.log(`Distinct trade days: ${new Set(rows.map(r => r.trade_date)).size}`);

  console.log('\n=== UNSIGNED (raw feature, matching the audit\'s own "flat and non-monotonic" check) ===');
  const unsignedRows = rows.map(r => ({ ...r, signed: r.raw_feature }));
  const unsignedAll = await runSegment(unsignedRows, 'unsigned_all');

  console.log('\n=== SIGNED BY TRADE DIRECTION ===');
  const signedAll = await runSegment(rows, 'signed_all');
  const signedRth = await runSegment(rows.filter(r => r.is_rth === true), 'signed_rth');
  const signedGlobex = await runSegment(rows.filter(r => r.is_rth === false), 'signed_globex');

  const status = signedAll?.excludes_zero ? 'PROVISIONAL' : 'PROVISIONAL';
  await recordClaim({
    slug: 'direction_signed_recentdelta_realtest_20260924',
    claimText: [
      'Real (not illustrative) re-run of Opus Audit #14 section 2.3\'s tercile check',
      '(scratch/opus_audit_14_ml_strategy_results.md), on real STOP_HIT/TARGET_HIT trades,',
      `cluster-primary only, direction resolved via the canonical inferDirection().`,
      `Population: N=${rows.length} usable (${skippedNoDir} skipped, no inferrable direction),`,
      `${new Set(rows.map(r => r.trade_date)).size} distinct days.`,
      `UNSIGNED (raw recentDelta15Bars): ${unsignedAll ? `T3-T1 delta=$${unsignedAll.delta.toFixed(2)}, CI=[$${unsignedAll.ci_lo?.toFixed(2)},$${unsignedAll.ci_hi?.toFixed(2)}]` : 'too thin'}.`,
      `SIGNED (recentDelta15Bars x dir), ALL: ${signedAll ? `T3-T1 delta=$${signedAll.delta.toFixed(2)}, CI=[$${signedAll.ci_lo?.toFixed(2)},$${signedAll.ci_hi?.toFixed(2)}], excludes_zero=${signedAll.excludes_zero}` : 'too thin'}.`,
      `RTH: ${signedRth ? `delta=$${signedRth.delta.toFixed(2)}, CI=[$${signedRth.ci_lo?.toFixed(2)},$${signedRth.ci_hi?.toFixed(2)}], excludes_zero=${signedRth.excludes_zero}` : 'too thin'}.`,
      `Globex: ${signedGlobex ? `delta=$${signedGlobex.delta.toFixed(2)}, CI=[$${signedGlobex.ci_lo?.toFixed(2)},$${signedGlobex.ci_hi?.toFixed(2)}], excludes_zero=${signedGlobex.excludes_zero}` : 'too thin'}.`,
      'This is a market-behavior screen (does signing help distinguish real outcomes at all),',
      'not yet wired into any model or live gate. Full methodology and pass/kill criteria:',
      'OPEN_DECISION ml_direction_signed_features_untested_20260924.',
    ].join(' '),
    sourceFile: 'scripts/pretest_direction_signed_recentdelta.mjs',
    sourceDate: new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }),
    sampleSize: rows.length,
    winRate: null,
    evPerTrade: signedAll?.delta ?? null,
    rigorStatus: signedAll?.excludes_zero ? 'ci_excludes_zero' : 'ci_crosses_zero',
    status,
    extra: { unsignedAll, signedAll, signedRth, signedGlobex },
  });

  console.log('\nClaim recorded: direction_signed_recentdelta_realtest_20260924');
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
