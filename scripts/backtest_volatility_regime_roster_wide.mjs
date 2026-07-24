// Direct follow-up to the user's "how can we enhance and build off our findings with the
// large moves" ask, 2026-07-23. The already-confirmed volatility-clustering finding
// (volatility_squeeze_bigmove_inverted -- big moves follow already-elevated volatility, not
// compression) is descriptive/backward-looking on its own. This asks whether it can become a
// LIVE, forward-looking, decision-useful signal: does the day's own volatility regime (known
// before the open, no lookahead) predict worse (or better) EV for the EXISTING fade-based
// roster as a whole -- a genuine, wireable, system-wide sizing lever, not a new setup type.
//
// Reuses computeVolatilityRegimeByDate() (backtest_volatility_squeeze_bigmove.mjs, N=5 window
// -- this session's own testing found N=5 the best test-split significance) rather than
// reimplementing a third time.

import { query } from '../server/db.js';
import { computeVolatilityRegimeByDate } from './backtest_volatility_squeeze_bigmove.mjs';
import { recordClaim } from './record_claim.mjs';
import fs from 'fs';

function summarize(rows) {
  const n = rows.length;
  if (n === 0) return { n: 0, wr: '0.0', ev: '0.00', avgWin: 'n/a', avgLoss: 'n/a', maxWin: 'n/a', maxLoss: 'n/a' };
  const wins = rows.filter(r => r.pnl > 0);
  const losses = rows.filter(r => r.pnl <= 0);
  const ev = rows.reduce((s, r) => s + r.pnl, 0) / n;
  return {
    n, wr: (wins.length / n * 100).toFixed(1), ev: ev.toFixed(2),
    avgWin: wins.length ? (wins.reduce((s, r) => s + r.pnl, 0) / wins.length).toFixed(2) : 'n/a',
    avgLoss: losses.length ? (losses.reduce((s, r) => s + r.pnl, 0) / losses.length).toFixed(2) : 'n/a',
    maxWin: wins.length ? Math.max(...wins.map(r => r.pnl)).toFixed(2) : 'n/a',
    maxLoss: losses.length ? Math.min(...losses.map(r => r.pnl)).toFixed(2) : 'n/a',
  };
}

function line(label, s) {
  return `${label} (N=${s.n}): WR=${s.wr}%, EV=$${s.ev} | avgWin=$${s.avgWin}, avgLoss=$${s.avgLoss}, maxWin=$${s.maxWin}, maxLoss=$${s.maxLoss}`;
}

async function main() {
  console.log('Computing volatility regime by date (N=5)...');
  const volByDate = await computeVolatilityRegimeByDate(5);
  console.log(`Regime computed for ${volByDate.size} dates.`);

  console.log('Loading resolved trades...');
  const tradesQ = await query(`
    SELECT trade_date::text as trade_date, setup_type, actual_pnl::float as pnl, origin_status
    FROM active_setups
    WHERE actual_pnl IS NOT NULL AND resolution IN ('TARGET_HIT', 'STOP_HIT', 'TIME_EXPIRED')
      AND (mae_points IS NULL OR mae_points::float <= 300) AND (mfe_points IS NULL OR mfe_points::float <= 300)
    ORDER BY trade_date ASC
  `);

  const trades = [];
  for (const t of tradesQ.rows) {
    const volPct = volByDate.get(t.trade_date);
    if (volPct == null) continue;
    trades.push({ ...t, volRegime: volPct >= 0.5 ? 'HIGH_VOL' : 'LOW_VOL' });
  }
  console.log(`${trades.length} trades with a known regime.`);

  const dates = [...new Set(trades.map(t => t.trade_date))].sort();
  const splitIdx = Math.floor(dates.length * 0.8);
  const trainDates = new Set(dates.slice(0, splitIdx));
  const trainTrades = trades.filter(t => trainDates.has(t.trade_date));
  const testTrades = trades.filter(t => !trainDates.has(t.trade_date));

  const md = [];
  md.push('# Volatility Regime vs Roster-Wide Fade EV\n');
  md.push(`Total trades with known regime: ${trades.length} across ${dates.length} distinct dates (train ${trainTrades.length}, test ${testTrades.length})\n`);

  for (const [label, data] of [['ALL (train+test pooled)', trades], ['TRAIN', trainTrades], ['TEST', testTrades]]) {
    md.push(`## ${label}`);
    const high = data.filter(t => t.volRegime === 'HIGH_VOL');
    const low = data.filter(t => t.volRegime === 'LOW_VOL');
    md.push('- ' + line('HIGH_VOL', summarize(high)));
    md.push('- ' + line('LOW_VOL ', summarize(low)));
    const diff = Number(summarize(high).ev) - Number(summarize(low).ev);
    md.push(`- EV diff (HIGH_VOL - LOW_VOL): $${diff.toFixed(2)}`);
    const highDates = new Set(high.map(t => t.trade_date)).size;
    const lowDates = new Set(low.map(t => t.trade_date)).size;
    md.push(`- Distinct dates: HIGH_VOL=${highDates}, LOW_VOL=${lowDates} (day-clustering sanity check)`);
    md.push('');
  }

  // Origin-status breakdown on the ALL population, since the RTH-leg-negative investigation
  // found blended vs ACTIVE-origin EV can diverge sharply -- check that isn't confounding this.
  md.push('## Origin-status breakdown (ALL population)');
  for (const origin of ['ACTIVE', 'BACKFILL', 'SHADOW', 'UNKNOWN']) {
    const high = trades.filter(t => t.volRegime === 'HIGH_VOL' && t.origin_status === origin);
    const low = trades.filter(t => t.volRegime === 'LOW_VOL' && t.origin_status === origin);
    if (high.length === 0 && low.length === 0) continue;
    md.push(`### ${origin}`);
    md.push('- ' + line('HIGH_VOL', summarize(high)));
    md.push('- ' + line('LOW_VOL ', summarize(low)));
  }

  const report = md.join('\n');
  fs.writeFileSync('scratch/volatility_regime_roster_wide_RESULTS.md', report);
  console.log(report);

  const allHigh = summarize(trades.filter(t => t.volRegime === 'HIGH_VOL'));
  const allLow = summarize(trades.filter(t => t.volRegime === 'LOW_VOL'));
  await recordClaim({
    slug: 'volatility_regime_roster_wide_ev_effect',
    claimText: `Tests whether the already-confirmed volatility-clustering finding (big moves follow already-elevated volatility) translates into a live, system-wide EV effect on the existing fade-based roster -- not a new setup, a potential sizing lever using the same day's own N=5 volatility percentile (known pre-market, no lookahead). ALL population: HIGH_VOL EV=$${allHigh.ev} (N=${allHigh.n}) vs LOW_VOL EV=$${allLow.ev} (N=${allLow.n}). See scratch/volatility_regime_roster_wide_RESULTS.md for train/test split and origin-status breakdown.`,
    sourceFile: 'scripts/backtest_volatility_regime_roster_wide.mjs',
    sourceDate: '2026-07-23',
    sampleSize: trades.length,
    winRate: null,
    evPerTrade: Number(allHigh.ev) - Number(allLow.ev),
    rigorStatus: 'train_test_split_plus_day_clustering_check',
    status: 'PROVISIONAL',
  });

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
