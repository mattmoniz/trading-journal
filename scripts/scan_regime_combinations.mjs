// Closes the loop on the value-area regime measurement layer (2026-08-01/02,
// docs/OPEN_THREADS.md) -- built after a direct user challenge: "what's the point of
// tracking and tagging if it never gets noticed." The tagging layer (regime_pos_Nd/
// regime_label_Nd on active_setups) was deliberately built as pure storage, no gating,
// specifically to avoid repeating the exact cherry-picking failure that killed the
// Regime Intelligence Spec's gating engine and the confluence/day-type tests the same
// night. This script is the other half: it actually looks at what's accumulated, on a
// schedule, applying the SAME rigor gauntlet used everywhere else in this codebase
// (real N>=20, computeRigor for stability, computeReplication for cross-setup
// cherry-picking) before anything gets treated as real.
//
// Every real (N>=20) cell tested gets recorded via recordClaim() -- positive or negative,
// matching this codebase's "every tested claim gets recorded" standing rule. Anything that
// clears ALL THREE bars (real N>=20, rigor-clean, replicates, positive EV) additionally
// gets flagDecision()'d -- this is the actual "into live" path the user asked for: it does
// NOT get auto-wired (this codebase's own hard-won lesson tonight is not to do that), but
// it DOES get forced into the OPEN_DECISION queue that resurfaces every session until a
// human explicitly decides, so a real finding can never just sit unnoticed the way plain
// tagging alone would let it.
//
// Single-lookback only for now (setup_type x one of the 7 lookbacks x Mid/Edge) --
// deliberately NOT the full 2-lookback combinatorial search yet. Real N per setup_type is
// currently in the single digits system-wide (2 total real regime-tagged resolved rows as
// of 2026-08-02) -- a 2D search would multiply the comparison count ~7x per setup for data
// that can't support it, exactly the "candidate finer than what the data can resolve"
// mistake this codebase's own trailing-stop-granularity lesson already documents. Revisit
// once single-lookback N is consistently clearing the floor for multiple setup_types.
import { query } from '../server/db.js';
import { computeRigor, computeReplication } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';
import { flagDecision } from './flag_decision.mjs';

const LOOKBACKS = [10, 20, 30, 45, 60, 90, 180];
const MIN_REAL_N = 20;

async function run() {
  const { today } = (await query(`SELECT CURRENT_DATE::text as today`)).rows[0];
  console.log('[scan_regime_combinations] Loading real, regime-tagged, resolved touches...');
  const rows = (await query(`
    SELECT setup_type, trade_date::text as date, actual_pnl::float as pnl,
      regime_label_10d, regime_label_20d, regime_label_30d, regime_label_45d,
      regime_label_60d, regime_label_90d, regime_label_180d
    FROM active_setups
    WHERE origin_status IN ('ACTIVE','SHADOW')
      AND resolution IN ('TARGET_HIT','STOP_HIT')
      AND actual_pnl IS NOT NULL
  `)).rows;
  console.log(`${rows.length} real resolved touches with regime columns present (label may still be null per-lookback if a snapshot wasn't available that day)`);

  if (rows.length === 0) {
    console.log('[scan_regime_combinations] Nothing to scan yet. Exiting cleanly.');
    return;
  }

  const bySetup = {};
  for (const r of rows) (bySetup[r.setup_type] ??= []).push(r);

  let cellsTested = 0, claimsRecorded = 0, decisionsFlagged = 0;

  for (const [setupType, setupRows] of Object.entries(bySetup)) {
    for (const L of LOOKBACKS) {
      const col = `regime_label_${L}d`;
      const mid = setupRows.filter(r => r[col] === 'Mid');
      const edge = setupRows.filter(r => r[col] === 'Edge');

      for (const [label, subset] of [['Mid', mid], ['Edge', edge]]) {
        if (subset.length < MIN_REAL_N) continue;
        cellsTested++;

        const ev = subset.reduce((s, r) => s + r.pnl, 0) / subset.length;
        const wr = subset.filter(r => r.pnl > 0).length / subset.length;
        const rigor = computeRigor(subset, { dateField: 'date', pnlFn: r => r.pnl });

        // Replication: does this setup_type's effect at this (lookback,label) cell
        // generalize, or is it an outlier vs every OTHER setup_type's same cell?
        const allAtThisCell = [];
        for (const [otherType, otherRows] of Object.entries(bySetup)) {
          const otherSubset = otherRows.filter(r => r[col] === label);
          if (otherSubset.length > 0) {
            allAtThisCell.push({
              type: otherType,
              value: otherSubset.reduce((s, r) => s + r.pnl, 0) / otherSubset.length,
              n: otherSubset.length,
            });
          }
        }
        let replicates = null, heldOutFrac = null;
        if (allAtThisCell.length >= 4) {
          const repl = computeReplication(allAtThisCell, {
            idFn: u => u.type, metricFn: u => ({ value: u.value, n: u.n }), selectedIds: [setupType],
          });
          replicates = repl.replicates;
          heldOutFrac = repl.heldOutFavorableFrac;
        }

        const slug = `regime_scan_${setupType}_${L}d_${label}`.toLowerCase().slice(0, 60);
        await recordClaim({
          slug,
          claimText: `Real ${setupType} touches (origin_status IN ACTIVE/SHADOW) where regime_label_${L}d='${label}': N=${subset.length}, EV=$${ev.toFixed(2)}, WR=${(wr * 100).toFixed(1)}%. Rigor: clean=${rigor.clean} stable=${rigor.stable} clustered=${rigor.clustered} top5DayPct=${rigor.top5DayPct}. Cross-setup replication at this (lookback,label) cell: replicates=${replicates} heldOutFavorableFrac=${heldOutFrac}. Auto-scanned by scripts/scan_regime_combinations.mjs -- single-lookback only, not a 2D combination search yet.`,
          sourceFile: 'scripts/scan_regime_combinations.mjs',
          sourceDate: today,
          sampleSize: subset.length,
          winRate: wr,
          evPerTrade: ev,
          rigorStatus: rigor.clean && rigor.stable ? 'checked_clean' : 'checked_failed',
          status: (rigor.clean && rigor.stable && replicates && ev > 0) ? 'PROVISIONAL' : 'PROVISIONAL',
        });
        claimsRecorded++;

        // The actual "into live" path: only for cells that clear EVERY bar.
        if (rigor.clean && rigor.stable && !rigor.clustered && replicates === true && ev > 0) {
          await flagDecision({
            slug: `wire_${slug}`.slice(0, 60),
            decisionText: `Auto-flagged by scripts/scan_regime_combinations.mjs (${today}): ${setupType} at regime_label_${L}d='${label}' cleared the FULL rigor gate on real data -- N=${subset.length} (real, origin_status IN ACTIVE/SHADOW only), EV=$${ev.toFixed(2)}/trade, WR=${(wr * 100).toFixed(1)}%, computeRigor clean+stable+not-clustered, AND computeReplication shows this generalizes across the setup roster (heldOutFavorableFrac=${heldOutFrac}), not just this one setup_type. This is a real, tested candidate for actually gating/sizing off regime_label_${L}d for ${setupType} -- decide whether to wire it (e.g. a sizeMultiplier factor or a SETUP_STATUS-style per-regime split) or explicitly pass on it. Full numbers in the paired RESEARCH_CLAIM ${slug}.`,
            sourceFile: 'scripts/scan_regime_combinations.mjs',
            sourceDate: today,
            priority: 'MEDIUM',
          });
          decisionsFlagged++;
          console.log(`  >>> CLEARED FULL RIGOR GATE: ${setupType} @ ${L}d ${label} (N=${subset.length}, EV=$${ev.toFixed(2)}) -- OPEN_DECISION flagged`);
        }
      }
    }
  }

  console.log(`[scan_regime_combinations] Done. ${cellsTested} real cells tested (N>=${MIN_REAL_N}), ${claimsRecorded} RESEARCH_CLAIM rows recorded, ${decisionsFlagged} cleared the full bar and got flagged as OPEN_DECISIONs.`);
}

run().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
