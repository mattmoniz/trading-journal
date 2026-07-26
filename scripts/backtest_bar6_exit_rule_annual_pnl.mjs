// Direct answer to the user's question (2026-07-26): "can we test the total annual
// backtested pnl of getting out early like this vs staying in the trade?" -- applies the
// frozen target-distance-fraction<0.873 exit rule (recovering_exit_predictor_target_distance_confirmatory_pass)
// to EVERY RECOVERING bar-6 touch in the trailing 365 days (not roster-restricted like the
// earlier prop-challenge overlay -- this is the full population's annual dollar impact, not
// "what the currently-tradeable subset would have done").
//
// Reuses computeBar6Checkpoint() (server/services/maeMfeReplay.js, extracted this session
// after this exact logic had been rewritten independently 4+ times) rather than a 5th copy.

import { query } from '../server/db.js';
import { directionFromType, computeBar6Checkpoint } from '../server/services/maeMfeReplay.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import fs from 'fs';

const PNL_PER_POINT = LIVE_INSTRUMENT.dollarsPerPoint;
const COMMISSION = LIVE_INSTRUMENT.commissionPerRoundTrip;

function summarize(rows, field) {
  const n = rows.length;
  if (n === 0) return { n: 0, wr: '0.0', total: '0.00', ev: '0.00', avgWin: 'n/a', avgLoss: 'n/a' };
  const wins = rows.filter(r => r[field] > 0);
  const losses = rows.filter(r => r[field] <= 0);
  const total = rows.reduce((s, r) => s + r[field], 0);
  return {
    n, wr: (wins.length / n * 100).toFixed(1), total: total.toFixed(2), ev: (total / n).toFixed(2),
    avgWin: wins.length ? (wins.reduce((s, r) => s + r[field], 0) / wins.length).toFixed(2) : 'n/a',
    avgLoss: losses.length ? (losses.reduce((s, r) => s + r[field], 0) / losses.length).toFixed(2) : 'n/a',
  };
}

async function main() {
  const maxDateRow = await query(`SELECT MAX(trade_date)::text as max_date FROM active_setups`);
  const maxDate = maxDateRow.rows[0].max_date;

  console.log('Loading trailing-365-day trades with bar-level fields...');
  const tradesQ = await query(`
    SELECT trade_date::text as trade_date, fired_at, setup_type, origin_status,
           actual_pnl::float as actual_pnl,
           entry_zone_low::float, entry_zone_high::float, stop_level::float, t1_level::float
    FROM active_setups
    WHERE trade_date >= $1::date - interval '365 days' AND trade_date <= $1::date
      AND actual_pnl IS NOT NULL AND resolution IN ('TARGET_HIT', 'STOP_HIT', 'TIME_EXPIRED')
      AND (mae_points IS NULL OR mae_points::float <= 300) AND (mfe_points IS NULL OR mfe_points::float <= 300)
      AND entry_zone_low IS NOT NULL AND stop_level IS NOT NULL AND t1_level IS NOT NULL
    ORDER BY trade_date ASC, fired_at ASC
  `, [maxDate]);
  const trades = tradesQ.rows;
  console.log(`${trades.length} trades in trailing 365 days with required fields.`);

  console.log('Loading bars...');
  const barsRes = await query(`
    SELECT ts, ts::date::text as d, high::float as high, low::float as low, close::float as close
    FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1::date - interval '366 days'
    ORDER BY ts ASC
  `, [maxDate]);
  const barsByDate = new Map();
  for (const b of barsRes.rows) {
    if (!barsByDate.has(b.d)) barsByDate.set(b.d, []);
    barsByDate.get(b.d).push({ ...b, ts: new Date(b.ts).getTime() });
  }

  const recovering = [];
  const deteriorating = [];
  let tooShort = 0, noDirection = 0;
  for (const t of trades) {
    const direction = directionFromType(t.setup_type);
    if (!direction) { noDirection++; continue; }
    const dayBars = barsByDate.get(t.trade_date);
    if (!dayBars || dayBars.length < 25) { tooShort++; continue; }
    const firedAtMs = new Date(t.fired_at).getTime();
    let entryIdx = -1;
    for (let i = dayBars.length - 1; i >= 0; i--) { if (dayBars[i].ts <= firedAtMs) { entryIdx = i; break; } }
    if (entryIdx < 0) continue;
    const forwardBars = dayBars.slice(entryIdx);

    // Only reached if this touch was genuinely still undecided at bar 6 (matches the live
    // resolveSetupsByPrice() gate exactly: a fast STOP_HIT/TARGET_HIT before bar 6 never
    // gets a checkpoint at all).
    let resolutionBarIdx = -1;
    for (let i = 0; i < forwardBars.length; i++) {
      const bar = forwardBars[i];
      const stopHit = direction === 'LONG' ? bar.low <= t.stop_level : bar.high >= t.stop_level;
      const targetHit = direction === 'LONG' ? bar.high >= t.t1_level : bar.low <= t.t1_level;
      if (stopHit || targetHit) { resolutionBarIdx = i; break; }
    }
    if (resolutionBarIdx !== -1 && resolutionBarIdx < 6) continue;

    const hi = t.entry_zone_high != null ? t.entry_zone_high : t.entry_zone_low;
    const entry = (t.entry_zone_low + hi) / 2;
    const cp = computeBar6Checkpoint(forwardBars, entry, t.stop_level, t.t1_level, direction, PNL_PER_POINT, COMMISSION);
    if (!cp) { tooShort++; continue; }

    const row = { ...t, pnlA: t.actual_pnl, pnlB: cp.ruleSaysExit ? cp.pnlAtBar6 : t.actual_pnl };
    (cp.status === 'RECOVERING' ? recovering : deteriorating).push(row);
  }

  console.log(`RECOVERING: ${recovering.length}, DETERIORATING: ${deteriorating.length} (${tooShort} skipped thin bars, ${noDirection} no direction)`);

  const md = [];
  md.push('# Bar-6 Exit Rule — Trailing 365-Day Annual PnL Impact (Full Population, Not Roster-Restricted)\n');
  md.push(`Window: trailing 365 days ending ${maxDate}\n`);

  md.push('## RECOVERING touches (the only population the exit rule applies to)');
  const recBaseline = summarize(recovering, 'pnlA');
  const recGated = summarize(recovering, 'pnlB');
  md.push(`- Baseline (hold to original stop/target): N=${recBaseline.n}, WR=${recBaseline.wr}%, Total=$${recBaseline.total}, EV/trade=$${recBaseline.ev}, avgWin=$${recBaseline.avgWin}, avgLoss=$${recBaseline.avgLoss}`);
  md.push(`- Gated (exit rule applied): N=${recGated.n}, WR=${recGated.wr}%, Total=$${recGated.total}, EV/trade=$${recGated.ev}, avgWin=$${recGated.avgWin}, avgLoss=$${recGated.avgLoss}`);
  const annualImpact = Number(recGated.total) - Number(recBaseline.total);
  md.push(`- **Annual $ impact: $${annualImpact.toFixed(2)}** over ${recovering.length} touches ($${(annualImpact / recovering.length).toFixed(2)}/touch avg)`);
  md.push('');

  md.push('## Origin-status breakdown (how much of this is real vs backfilled)');
  for (const origin of ['ACTIVE', 'SHADOW', 'BACKFILL', 'UNKNOWN']) {
    const subset = recovering.filter(r => r.origin_status === origin);
    if (subset.length === 0) continue;
    const base = summarize(subset, 'pnlA');
    const gated = summarize(subset, 'pnlB');
    md.push(`- **${origin}**: N=${subset.length}, baseline total=$${base.total}, gated total=$${gated.total}, diff=$${(Number(gated.total) - Number(base.total)).toFixed(2)}`);
  }
  md.push('');

  md.push('## DETERIORATING touches (rule does NOT apply -- shown for context only)');
  const detBaseline = summarize(deteriorating, 'pnlA');
  md.push(`- Baseline: N=${detBaseline.n}, WR=${detBaseline.wr}%, Total=$${detBaseline.total}, EV/trade=$${detBaseline.ev}`);

  const report = md.join('\n');
  fs.writeFileSync('scratch/bar6_exit_rule_annual_pnl_RESULTS.md', report);
  console.log(report);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
