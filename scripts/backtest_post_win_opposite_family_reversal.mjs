// Tests the user's rule, spotted live on quick-check.html: when a same-family setup hits T1
// (a win -- SHADOW or ACTIVE, since the user watches both on the same timeline and made this
// explicit after a first, wrongly-narrowed pass), does the family's next OPPOSITE-direction
// fire -- AFTER the win actually resolves, not just while it's still open -- underperform that
// setup_type's own baseline? Proposed rule: block that opposite-direction sibling until a
// DIFFERENT family fires; the original winning direction stays free to keep firing.
//
// CORRECTED 2026-09-02, two rounds:
// Round 1 (DeepSeek design critique) found the original version compared trades by fired_at
// instead of resolved_at -- 85 of its 104 "flagged" trades actually fired while the winner was
// STILL OPEN, which is the already-live (currently no-op) CROSS_DIRECTION_FAST_FLIP gate's own
// phenomenon, not this one. Fixed to scan for the next trade with fired_at > A.resolved_at.
// Round 2 (user pushback, "something is missing," found independently after DeepSeek's
// ACTIVE-only-arming suggestion also cut the sample to a meaningless N=3): the setup_type
// filter (`LIKE '%_LONG' OR '%_SHORT'`) silently excluded 557 real decisive trades with a
// _TRAIL/_GAP_UP/_GAP_DOWN/_OVERNIGHT suffix (e.g. CAM_S2_FADE_LONG_TRAIL, PD_POC_FADE_LONG_
// TRAIL) -- real siblings of families already in scope, dropped from both arming and flagging.
// Fixed with a suffix-stripping family/direction resolver. User explicitly confirmed SHADOW
// wins DO count as arming events (same timeline they're watching, no visual ACTIVE/SHADOW
// distinction) -- kept origin_status IN ('ACTIVE','SHADOW') for both arming and flagged legs.
//
// Method: walk the full real chronological trade timeline once (ALL setup_types, not just ones
// with a bare _LONG/_SHORT suffix). For every TARGET_HIT ("win") trade A of family X direction
// D, scan forward among trades that fired AFTER A resolved, skipping same-family-same-direction
// re-fires and non-directional types (context reads like IB_BULLISH/ZONE_EDGE_FADE that have no
// paired sibling). If a DIFFERENT family fires first, no flag. If family X's OPPOSITE direction
// fires first, that trade is FLAGGED -- the reversal the proposed rule would block.
//
// Confound-checklist control: flagged vs that SAME setup_type's own baseline (all its real
// trades, flagged instances included) -- not the whole roster.
//
// No lookahead: only fired_at/resolved_at ordering and each trade's own already-known
// resolution are used; nothing about a later trade informs an earlier decision.
//
// Run: node scripts/backtest_post_win_opposite_family_reversal.mjs

import { query } from '../server/db.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';

function familyOf(setupType) {
  return setupType.replace(/_(TRAIL|GAP_UP|GAP_DOWN|OVERNIGHT)$/, '').replace(/_(LONG|SHORT)$/, '');
}
function dirOf(setupType) {
  const stripped = setupType.replace(/_(TRAIL|GAP_UP|GAP_DOWN|OVERNIGHT)$/, '');
  if (stripped.endsWith('_LONG')) return 'LONG';
  if (stripped.endsWith('_SHORT')) return 'SHORT';
  return null; // non-directional type (IB_BULLISH, ZONE_EDGE_FADE, etc) -- no paired sibling
}

async function main() {
  const { rows: [{ today }] } = await query(`SELECT CURRENT_DATE::text as today`);

  const { rows: allTrades } = await query(`
    SELECT id, trade_date::text as trade_date, setup_type, fired_at::text as fired_at,
           resolved_at::text as resolved_at, resolution, actual_pnl::float as actual_pnl,
           origin_status
    FROM active_setups
    WHERE origin_status IN ('ACTIVE','SHADOW')
      AND resolution IN ('TARGET_HIT','STOP_HIT','TIME_EXPIRED','TRAIL_EXIT')
      AND actual_pnl IS NOT NULL AND fired_at IS NOT NULL
    ORDER BY fired_at
  `);
  console.log(`[post_win_reversal] N=${allTrades.length} real decisive trades (all types, chronological)`);

  const flaggedIds = new Set();
  for (let i = 0; i < allTrades.length; i++) {
    const a = allTrades[i];
    if (a.resolution !== 'TARGET_HIT' || !a.resolved_at) continue;
    const dirA = dirOf(a.setup_type);
    if (!dirA) continue;
    const famA = familyOf(a.setup_type);
    // Scan trades that fired strictly AFTER A actually resolved (not just after A fired).
    const candidates = allTrades.filter(t => t.fired_at > a.resolved_at).sort((x, y) => x.fired_at.localeCompare(y.fired_at));
    for (const b of candidates) {
      const dirB = dirOf(b.setup_type);
      if (!dirB) continue; // non-directional: skip past, doesn't reset or flag
      const famB = familyOf(b.setup_type);
      if (famB !== famA) break; // a different family fired first -- no flag for this A
      if (dirB === dirA) continue; // same-family same-direction re-fire: allowed, keep scanning
      flaggedIds.add(b.id); // same family, opposite direction, after resolution -- flagged
      break;
    }
  }
  console.log(`[post_win_reversal] Flagged ${flaggedIds.size} same-family opposite-direction reversals-after-resolution`);

  const flaggedTrades = allTrades.filter(t => flaggedIds.has(t.id));
  const flaggedTotal = flaggedTrades.reduce((s, t) => s + t.actual_pnl, 0);
  const flaggedWins = flaggedTrades.filter(t => t.actual_pnl > 0).length;
  const flaggedWr = flaggedTrades.length ? flaggedWins / flaggedTrades.length : null;
  const flaggedEv = flaggedTrades.length ? flaggedTotal / flaggedTrades.length : null;

  const flaggedTypes = new Set(flaggedTrades.map(t => t.setup_type));
  const baselineTrades = allTrades.filter(t => flaggedTypes.has(t.setup_type));
  const baselineTotal = baselineTrades.reduce((s, t) => s + t.actual_pnl, 0);
  const baselineWins = baselineTrades.filter(t => t.actual_pnl > 0).length;
  const baselineWr = baselineTrades.length ? baselineWins / baselineTrades.length : null;
  const baselineEv = baselineTrades.length ? baselineTotal / baselineTrades.length : null;

  console.log(`\n=== FLAGGED (same-family opposite-dir reversal after resolution) ===`);
  console.log(`N=${flaggedTrades.length} WR=${flaggedWr != null ? (flaggedWr * 100).toFixed(1) + '%' : 'n/a'} EV/trade=$${flaggedEv?.toFixed(2)} total=$${flaggedTotal.toFixed(2)}`);
  console.log(`\n=== BASELINE (same setup_types, all real trades) ===`);
  console.log(`N=${baselineTrades.length} WR=${baselineWr != null ? (baselineWr * 100).toFixed(1) + '%' : 'n/a'} EV/trade=$${baselineEv?.toFixed(2)}`);

  const delta = flaggedEv != null && baselineEv != null ? flaggedEv - baselineEv : null;
  console.log(`\nDELTA (flagged - baseline): $${delta?.toFixed(2)}/trade`);

  console.log(`\n=== PER-FAMILY ===`);
  const flaggedByFamily = new Map();
  for (const t of flaggedTrades) {
    const fam = familyOf(t.setup_type);
    if (!flaggedByFamily.has(fam)) flaggedByFamily.set(fam, []);
    flaggedByFamily.get(fam).push(t);
  }
  for (const [fam, trades] of [...flaggedByFamily.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const total = trades.reduce((s, t) => s + t.actual_pnl, 0);
    console.log(`  ${fam.padEnd(24)} N=${trades.length} total=$${total.toFixed(2)}`);
  }

  const rigor = flaggedTrades.length >= 10
    ? computeRigor(flaggedTrades, { dateField: 'trade_date', pnlFn: t => t.actual_pnl })
    : null;
  console.log(`\n=== RIGOR ON FLAGGED (N=${flaggedTrades.length}) ===`);
  console.log(JSON.stringify(rigor, null, 2));

  const tooThin = flaggedTrades.length < 20;
  let verdict;
  if (tooThin) verdict = 'TOO_THIN_TO_CONCLUDE';
  else if (delta != null && delta < 0 && rigor?.clean) verdict = 'CONFIRMED_WORSE';
  else if (delta != null && delta < 0) verdict = 'WORSE_UNSTABLE';
  else verdict = 'NOT_WORSE';

  console.log(`\n=== VERDICT: ${verdict} ===`);

  await query(`
    INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, win_rate, ev_per_trade, total_pnl, recommendation, notes)
    VALUES ($1, 9999, 'POST_WIN_OPP_FAMILY_REV', 'ALL', $2, $3, $4, $5, $6, $7)
    ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE
      SET sample_size=EXCLUDED.sample_size, win_rate=EXCLUDED.win_rate, ev_per_trade=EXCLUDED.ev_per_trade,
          total_pnl=EXCLUDED.total_pnl, recommendation=EXCLUDED.recommendation, notes=EXCLUDED.notes
  `, [today, flaggedTrades.length, flaggedWr, flaggedEv, flaggedTotal, verdict, JSON.stringify({
    method: 'resolved-order arming (not fired-order), SHADOW+ACTIVE arming (user-confirmed), full family coverage incl TRAIL/GAP/OVERNIGHT suffixes -- corrects the 2026-09-02 fired-order/LONG-SHORT-only version',
    flagged: { n: flaggedTrades.length, wr: flaggedWr, ev: flaggedEv, total: flaggedTotal },
    baseline: { n: baselineTrades.length, wr: baselineWr, ev: baselineEv, total: baselineTotal },
    delta, rigor,
    byFamily: [...flaggedByFamily.entries()].map(([fam, trades]) => ({
      family: fam, n: trades.length, total: trades.reduce((s, t) => s + t.actual_pnl, 0),
    })),
  })]);

  await recordClaim({
    slug: 'post_win_opposite_family_reversal',
    claimText: `CORRECTED 2026-09-02 (two rounds -- DeepSeek caught fired-vs-resolved-order timing, user pushback caught a TRAIL/GAP/OVERNIGHT suffix population gap): for every real TARGET_HIT trade (origin_status ACTIVE or SHADOW -- user confirmed SHADOW counts, since it's the same timeline they watch), does the family's next opposite-direction fire AFTER resolution (not just after firing), across the FULL real setup_type roster (not just bare _LONG/_SHORT), underperform that setup_type's own baseline? Flagged N=${flaggedTrades.length}: WR=${flaggedWr != null ? (flaggedWr * 100).toFixed(1) + '%' : 'n/a'}, EV/trade=$${flaggedEv?.toFixed(2)}, total=$${flaggedTotal.toFixed(2)}. Baseline N=${baselineTrades.length}: EV/trade=$${baselineEv?.toFixed(2)}. Delta=$${delta?.toFixed(2)}/trade. Rigor: ${JSON.stringify(rigor)}. Verdict: ${verdict}.`,
    sourceFile: 'scripts/backtest_post_win_opposite_family_reversal.mjs',
    sourceDate: today,
    sampleSize: flaggedTrades.length,
    winRate: flaggedWr,
    evPerTrade: delta,
    rigorStatus: rigor?.clean === true ? 'clean' : rigor?.clean === false ? 'unstable_or_clustered' : 'too_thin',
    status: 'PROVISIONAL',
  });

  console.log(`\n[post_win_reversal] Persisted corrected performance_audit + RESEARCH_CLAIM post_win_opposite_family_reversal`);
}

main().then(() => process.exit(0)).catch(e => { console.error('[post_win_reversal] ERROR:', e.message, e.stack); process.exit(1); });
