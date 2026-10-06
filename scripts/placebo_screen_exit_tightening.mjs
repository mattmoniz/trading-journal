// Placebo screen across EVERY setup_type that clears the N floor in the exit test (2026-10-06).
// The setup list is derived from the real run's perSetup output, never hand-picked, so new
// setups that reach N>=20 are picked up automatically on the next run.
// For each setup x (stop,target) cell: real per-trade delta vs a placebo distribution from
// random direction flips (PLACEBO_DRAWS draws, seeded). This is a SHORTLIST, not a verdict:
// the smallest p-value from D draws is 1/D, and a Bonferroni correction over ~160 cells needs
// roughly 160/0.05 = 3,200 draws to reach p<0.05. Shortlisted cells must be re-run with a much
// larger draw count before any claim. Run: node scripts/placebo_screen_exit_tightening.mjs
import { execFileSync } from 'child_process';
import fs from 'fs';

const DRAWS = Number(process.env.PLACEBO_DRAWS || 30);
const SCRIPT = 'scripts/backtest_exit_tightening_20261005.mjs';
const TAG = `_screen_${Date.now()}`;
const run = (env) => execFileSync('node', [SCRIPT], { env: { ...process.env, ...env, OUT_TAG: env.OUT_TAG }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 600000, maxBuffer: 64 * 1024 * 1024 });
const load = (tag) => JSON.parse(fs.readFileSync(`scratch/exit_tightening_20261005${tag}.json`, 'utf8'));

console.log('real run (all setups)...');
run({ OUT_TAG: `${TAG}_real` });
const real = load(`${TAG}_real`);
const tested = [...new Set(real.perSetup.filter(r => r.trades >= 20).map(r => r.setup))].sort();
const thin = [...new Set(real.perSetup.filter(r => r.trades < 20).map(r => r.setup))].sort();
console.log(`tested setups (N>=20): ${tested.length}; not testable yet (N<20): ${thin.length}`);

const cellKey = r => `${r.stopMult}|${r.targetMult}|${r.tie}`;
const results = [];
for (const setup of tested) {
  const realCells = Object.fromEntries(real.perSetup.filter(r => r.setup === setup && r.trades >= 20).map(r => [cellKey(r), r]));
  const draws = [];
  for (let s = 1; s <= DRAWS; s++) {
    const tag = `${TAG}_${setup}_pl${s}`;
    run({ OUT_TAG: tag, SETUP_ONLY: setup, PLACEBO_SEED: String(s) });
    const d = load(tag);
    draws.push(Object.fromEntries(d.perSetup.filter(r => r.setup === setup).map(r => [cellKey(r), r.meanDeltaPerTrade])));
    fs.unlinkSync(`scratch/exit_tightening_20261005${tag}.json`);
  }
  for (const [k, r] of Object.entries(realCells)) {
    const pl = draws.map(d => d[k]).filter(v => v != null);
    const share = pl.filter(v => v >= r.meanDeltaPerTrade).length / pl.length;
    results.push({ setup, cell: k, trades: r.trades, realDelta: r.meanDeltaPerTrade, placeboMedian: pl.sort((a, b) => a - b)[Math.floor(pl.length / 2)], pShare: share, draws: pl.length });
  }
  console.log(`done ${setup}`);
}
const m = results.length;
for (const r of results) r.pBonferroni = Math.min(1, r.pShare * m);
results.sort((a, b) => a.pShare - b.pShare || b.realDelta - a.realDelta);
const out = { generated: new Date().toISOString(), draws: DRAWS, setupsTested: tested, setupsThin: thin, cellsTested: m, results };
fs.writeFileSync(`scratch/placebo_screen${TAG}.json`, JSON.stringify(out, null, 2));
console.log(`\n${m} cells tested with ${DRAWS} draws each. Shortlist (raw share of placebo >= real is <= 0.05):`);
for (const r of results.filter(x => x.pShare <= 0.05)) console.log(`  ${r.setup} ${r.cell} trades=${r.trades} real=${r.realDelta} placeboMedian=${r.placeboMedian} share=${r.pShare.toFixed(3)}`);
console.log(`Bonferroni-corrected at this draw count: ${results.filter(x => x.pBonferroni < 0.05).length} cells (expected 0 unless draws >= ~3,200).`);
console.log(`wrote scratch/placebo_screen${TAG}.json`);
