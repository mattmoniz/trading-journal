#!/usr/bin/env node
// Self-recalibrating research claim for whether the ML meta-labeling gate is genuinely
// discriminating WITHIN Globex, not just within RTH (2026-09-21, user: "Globex is killing
// me every which way... make a distinction between time of day/Globex... which trades to
// fire"). Adding an explicit is_rth feature (dataset.py) flipped the Globex TAKE bucket's
// avg P&L from +$42.19 (N=15) to -$35.50 (N=14) in one retrain -- a sign flip at N<20 on
// both sides is the signature of noise, not a real effect, so neither reading was trusted.
// This script tracks the Globex-specific TAKE-vs-VETO split daily with a real day-blocked
// bootstrap CI (never a hand-typed number) so the next read is trustworthy instead of
// another single noisy snapshot.
import { query } from '../server/db.js';
import { getLatestModel, ML_CLAIM_DISTINCT_DATES_FLOOR } from '../server/services/mlSiloService.js';
import { dayBlockedBootstrapCI, collapseClusterSiblings } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';

async function main() {
  const { rows: [{ today }] } = await query('SELECT CURRENT_DATE::text as today');
  const model = await getLatestModel();
  if (!model) { console.log('No trained model yet -- skipping.'); process.exit(0); }

  const r = await query(`
    SELECT a.is_rth, v.verdict, a.actual_pnl::float AS pnl, a.trade_date::text AS trade_date, a.cluster_touch_id
    FROM ml_verdicts v
    JOIN active_setups a ON a.id = v.active_setup_id
    WHERE v.model_version = $1 AND a.fired_at >= $2::timestamp AND a.actual_pnl IS NOT NULL
  `, [model.model_version, model.test_start_at]);
  const rows = r.rows;

  const results = {};
  for (const isRth of [true, false]) {
    const label = isRth ? 'RTH' : 'GLOBEX';
    const seg = rows.filter(x => x.is_rth === isRth);
    const take = seg.filter(x => x.verdict === 'TAKE');
    const veto = seg.filter(x => x.verdict === 'VETO');
    const sum = arr => arr.reduce((s, x) => s + x.pnl, 0);
    const wr = arr => arr.length ? 100 * arr.filter(x => x.pnl > 0).length / arr.length : null;
    let ci = null;
    if (take.length >= 5) {
      // Collapse correlated cluster siblings to one representative event each BEFORE the
      // bootstrap runs (2026-09-22, OPEN_DECISION ml_silo_deepseek_followup_review_parked_20260921
      // -- siblings still fire/score individually everywhere else, per the user's explicit
      // "I like the pnl when siblings fire separately"; this ONLY affects how confident this
      // CI claims to be).
      const takeEvents = collapseClusterSiblings(
        take.map(x => ({ date: x.trade_date, pnl: x.pnl, cluster_touch_id: x.cluster_touch_id })),
      );
      ci = dayBlockedBootstrapCI(takeEvents, `ml_${label}_take`, { dateField: 'date', iters: 5000 });
    }
    const distinctDates = new Set(take.map(x => x.trade_date)).size;
    results[label] = {
      allN: seg.length, allPnl: +sum(seg).toFixed(2), allWr: wr(seg),
      takeN: take.length, takePnl: +sum(take).toFixed(2), takeAvg: take.length ? +(sum(take) / take.length).toFixed(2) : null, takeWr: wr(take), takeDistinctDates: distinctDates,
      vetoN: veto.length, vetoAvg: veto.length ? +(sum(veto) / veto.length).toFixed(2) : null,
      ci,
    };
    console.log(`${label}: ALL N=${seg.length} P&L=$${sum(seg).toFixed(2)} | TAKE N=${take.length} avg=$${results[label].takeAvg} distinctDates=${distinctDates}`
      + (ci ? ` CI=[$${ci.lo.toFixed(2)},$${ci.hi.toFixed(2)}]` : ' (too thin for CI)')
      + ` | VETO N=${veto.length} avg=$${results[label].vetoAvg}`);
  }

  const g = results.GLOBEX;
  if (g.takeN < 20) {
    console.log(`Globex TAKE N=${g.takeN} still below the N>=20 floor -- recording as PROVISIONAL/thin, not claiming a direction.`);
  }
  const globexExcludesZero = g.ci && (g.ci.lo > 0 || g.ci.hi < 0);
  // FIXED 2026-09-22 (OPEN_DECISION ml_thread_ci_gate_and_cleanup_backlog_20260921, F2):
  // excludesZero alone doesn't rule out a thin/day-clustered population producing a false
  // CONFIRMED -- require real day-spread too, not just N.
  const status = (g.takeN >= 20 && globexExcludesZero && g.takeDistinctDates >= ML_CLAIM_DISTINCT_DATES_FLOOR) ? 'CONFIRMED' : 'PROVISIONAL';

  const claimText = `Self-recalibrating check (scripts/recalibrate_ml_globex_split.mjs, daily) of whether the `
    + `ML meta-labeling gate genuinely discriminates WITHIN Globex specifically, not just within RTH -- `
    + `user request 2026-09-21 ("Globex is killing me every which way... which trades to fire"). `
    + `RTH: ALL N=${results.RTH.allN} P&L=$${results.RTH.allPnl} WR=${results.RTH.allWr?.toFixed(1)}pct, `
    + `TAKE N=${results.RTH.takeN} avg=$${results.RTH.takeAvg} vs VETO avg=$${results.RTH.vetoAvg}. `
    + `GLOBEX: ALL N=${g.allN} P&L=$${g.allPnl} WR=${g.allWr?.toFixed(1)}pct (a real, confirmed-losing population), `
    + `TAKE N=${g.takeN} avg=$${g.takeAvg} vs VETO avg=$${g.vetoAvg}, distinctDates=${g.takeDistinctDates}` +
    (g.ci ? `, day-blocked bootstrap 95pct CI on TAKE mean [$${g.ci.lo.toFixed(2)},$${g.ci.hi.toFixed(2)}], excludesZero=${globexExcludesZero}` : ', too thin for a bootstrap CI yet')
    + `. Adding an explicit is_rth feature to the model (dataset.py, same day) flipped the Globex TAKE `
    + `bucket's sign in one retrain (was +$42.19/N=15, now the number above) -- a flip at N<20 either side `
    + `is itself evidence of noise, not a real improvement or regression. Genuinely open question, not yet `
    + `answerable at current real N.`;

  await recordClaim({
    slug: 'ml_metalabel_globex_specific_discrimination',
    claimText,
    sourceFile: 'scripts/recalibrate_ml_globex_split.mjs',
    sourceDate: today,
    sampleSize: g.takeN,
    winRate: g.takeWr,
    evPerTrade: g.takeAvg,
    rigorStatus: g.takeN < 20 ? `thin_N_${g.takeN}_distinctDates_${g.takeDistinctDates}` : (globexExcludesZero ? 'CI_excludes_zero' : 'CI_crosses_zero'),
    status,
    unblockCondition: 'Recheck daily as real Globex-fired, ML-scored N grows -- need TAKE N>=20 with a '
      + 'day-blocked bootstrap CI that excludes zero before trusting either direction for Globex specifically.',
  });
  console.log(`Claim recorded (status=${status}).`);
}

main().then(() => process.exit(0));
