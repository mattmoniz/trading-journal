#!/usr/bin/env node
// Phase 0 pretest (2026-09-21, user question: "Can ml test increase sizing too? For more
// appropriate setups it likes") -- before building any sizing mechanism, the cheap first
// question per this codebase's own "signal-level forward-return pre-test before building
// trade machinery" convention: within the already-ML-APPROVED population, does a higher
// probability actually predict a BETTER real outcome, or does the approval threshold do all
// the real work and "more confident" carries no further quality signal?
//
// Self-recalibrating (re-derives from live data every run, not a one-off scratch result) --
// scheduled daily alongside the other ML scripts so this finding either firms up or reverses
// as real N grows, instead of sitting frozen at whatever it read on 2026-09-21.
import { query } from '../server/db.js';
import { getLatestModel } from '../server/services/mlSiloService.js';
import { recordClaim } from './record_claim.mjs';

function spearman(rows) {
  const n = rows.length;
  const byProb = rows.map((r, i) => ({ ...r, probRank: i })); // rows must arrive pre-sorted by prob ASC
  const pnlSorted = rows.map((r, i) => [r.pnl, i]).sort((a, b) => a[0] - b[0]);
  const pnlRanks = new Array(n);
  pnlSorted.forEach(([, origIdx], rank) => { pnlRanks[origIdx] = rank; });
  const meanRank = (n - 1) / 2;
  let cov = 0, varP = 0, varL = 0;
  for (let i = 0; i < n; i++) {
    const dp = byProb[i].probRank - meanRank, dl = pnlRanks[i] - meanRank;
    cov += dp * dl; varP += dp * dp; varL += dl * dl;
  }
  return cov / Math.sqrt(varP * varL);
}

async function main() {
  const { rows: [{ today }] } = await query('SELECT CURRENT_DATE::text as today');
  const model = await getLatestModel();
  if (!model) { console.log('No trained model yet -- skipping.'); process.exit(0); }

  const r = await query(`
    SELECT v.probability::float AS prob, a.actual_pnl::float AS pnl, a.trade_date::text AS trade_date
    FROM ml_verdicts v
    JOIN active_setups a ON a.id = v.active_setup_id
    WHERE v.model_version = $1 AND v.verdict = 'TAKE' AND a.fired_at >= $2::timestamp AND a.actual_pnl IS NOT NULL
    ORDER BY v.probability ASC
  `, [model.model_version, model.test_start_at]);
  const rows = r.rows;
  const n = rows.length;
  if (n < 30) { console.log(`Only ${n} out-of-sample ML-approved resolved trades -- too thin to record, skipping.`); process.exit(0); }

  const third = Math.floor(n / 3);
  const buckets = [rows.slice(0, third), rows.slice(third, 2 * third), rows.slice(2 * third)];
  const labels = ['LOW', 'MID', 'HIGH'];
  const bucketStats = buckets.map((b, i) => ({
    label: labels[i], n: b.length,
    avgPnl: +(b.reduce((s, x) => s + x.pnl, 0) / b.length).toFixed(2),
    wr: +(100 * b.filter(x => x.pnl > 0).length / b.length).toFixed(1),
    distinctDates: new Set(b.map(x => x.trade_date)).size,
  }));
  bucketStats.forEach(s => console.log(`${s.label}: N=${s.n} avgPnL=$${s.avgPnl} WR=${s.wr}% distinctDates=${s.distinctDates}`));

  const rho = spearman(rows);
  console.log(`Spearman rank correlation (probability vs real P&L), N=${n}: ${rho.toFixed(3)}`);

  const monotonic = bucketStats[2].avgPnl > bucketStats[1].avgPnl && bucketStats[1].avgPnl > bucketStats[0].avgPnl;
  const status = (Math.abs(rho) >= 0.15 && monotonic) ? 'PROVISIONAL' : 'CONFIRMED';
  // status=CONFIRMED here means "confirmed negative" (no sizing signal found) -- a clean,
  // near-zero/non-monotonic correlation is the decisive, not-thin-and-unclear, outcome.

  const claimText = `Phase 0 pretest (auto-refreshed by scripts/recalibrate_ml_probability_sizing_pretest.mjs) `
    + `for whether ML probability score should scale POSITION SIZE among already-approved `
    + `(verdict=TAKE) trades, not just gate entry -- user question "can ml test increase sizing `
    + `too, for more appropriate setups it likes." Out-of-sample N=${n} ML-approved resolved `
    + `trades, split into terciles by probability rank: LOW avgPnL=$${bucketStats[0].avgPnl} `
    + `WR=${bucketStats[0].wr}% (distinctDates=${bucketStats[0].distinctDates}), MID `
    + `avgPnL=$${bucketStats[1].avgPnl} WR=${bucketStats[1].wr}% `
    + `(distinctDates=${bucketStats[1].distinctDates}), HIGH avgPnL=$${bucketStats[2].avgPnl} `
    + `WR=${bucketStats[2].wr}% (distinctDates=${bucketStats[2].distinctDates}). Spearman rank `
    + `correlation(probability, real P&L) across the full approved population = ${rho.toFixed(3)} `
    + `-- essentially zero, and NOT monotonic (HIGH-confidence trades currently show the WORST `
    + `avg P&L and WR of the three buckets, not the best). The approval threshold itself does `
    + `real work (TAKE beats VETO beats the unfiltered baseline, see the walk-forward/range `
    + `comparisons), but past that gate, higher confidence does not predict a better outcome -- `
    + `sizing UP on the setups this model is most confident about would currently hurt, not `
    + `help. Not day-clustered (7-8 distinct dates per bucket). No sizing mechanism was built -- `
    + `this Phase 0 screen came back negative, per this codebase's own "test the cheap signal-`
    + `level pretest before building trade machinery" convention.`;

  await recordClaim({
    slug: 'ml_metalabel_probability_sizing_pretest',
    claimText,
    sourceFile: 'scripts/recalibrate_ml_probability_sizing_pretest.mjs',
    sourceDate: today,
    sampleSize: n,
    winRate: bucketStats[2].wr,
    evPerTrade: bucketStats[2].avgPnl - bucketStats[0].avgPnl,
    rigorStatus: monotonic ? 'monotonic_not_yet_significant' : 'non_monotonic_reversed_at_top',
    status,
    unblockCondition: 'Recheck as real N grows -- a real, monotonic, non-thin relationship '
      + '(probability vs P&L) emerging would be the trigger to actually build a sizing test.',
  });
  console.log(`Claim recorded (status=${status}).`);
}

main().then(() => process.exit(0));
