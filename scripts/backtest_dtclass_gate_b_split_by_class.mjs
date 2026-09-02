/**
 * OR-Expansion Bonus (acd.js sizeMultiplier IIFE, ~line 8285) — split by day-type class.
 *
 * Follow-up to scripts/backtest_dtclass_sizing_standdown_gates.mjs's Gate B (2026-09-01,
 * RESEARCH_CLAIM dtclass_gate_b), which tested the live-read OR-expansion bonus BLENDED
 * across `finalRead === 'BALANCE' || finalRead === 'TURBULENT'` (matching the live code's
 * actual condition) and found it inconclusive (+$125.90 but 98% day-clustered).
 *
 * docs/DTCLASS_LIVE_READ_WIRING_AND_REGIME_SPEC.md's central finding (queried directly
 * against daytype_accuracy_log) is that the live day-type read's real accuracy is sharply
 * class-conditional: BALANCE 65.0% (N=266) vs TURBULENT 17.8% (N=118, near coin-flip against
 * TURBULENT's ~29% base rate). A blended test of a factor keyed on BOTH classes can hide a
 * real BALANCE-only signal inside TURBULENT-branch noise. This script re-runs Gate B split
 * into two independent sub-gates (BALANCE-only, TURBULENT-only) on the exact same population
 * and methodology as the original Gate B, changing only the split.
 *
 * Methodology reused verbatim from backtest_dtclass_sizing_standdown_gates.mjs (already
 * audited 2026-09-01, one real lookahead bug found and fixed there): same candidate
 * population (real ACTIVE/SHADOW fade touches, MTM-origin excluded), same getOrExpanded()
 * (a_up_time/a_down_time from acd_daily_log, the exact same signal _lfOrExpanded reads live),
 * same computeCase()-based live day-type replay, same delta-as-fraction-of-actual_pnl proxy
 * for the sizeMultiplier bump (+0.10 mult ~ +10% position size ~ +10% of realized P&L on that
 * trade -- an approximation, not exact, but the same one the already-accepted Gate A/B/C
 * findings used).
 *
 * No lookahead: computeCase(tradeDate, firedAt) bounds all bar/level data to `ts <= firedAt`.
 *
 * Run: node scripts/backtest_dtclass_gate_b_split_by_class.mjs
 */

import { query } from '../server/db.js';
import pool from '../server/db.js';
import { computeCase } from '../server/services/caseEngine.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';

const SIGNAL_TYPE = 'DTCLASS_GATE_B_SPLIT';

const orExpandedCache = new Map();
async function getOrExpanded(tradeDate, firedAt) {
  if (!orExpandedCache.has(tradeDate)) {
    const { rows } = await query(`SELECT a_up_time, a_down_time FROM acd_daily_log WHERE trade_date=$1`, [tradeDate]);
    orExpandedCache.set(tradeDate, rows[0] || { a_up_time: null, a_down_time: null });
  }
  const log = orExpandedCache.get(tradeDate);
  const getMins = t => {
    if (!t) return null;
    const [h, m] = t.split(':');
    return parseInt(h) * 60 + parseInt(m);
  };
  const upMins = getMins(log.a_up_time);
  const downMins = getMins(log.a_down_time);

  const fDate = new Date(firedAt);
  const firedMins = fDate.getHours() * 60 + fDate.getMinutes();

  return (upMins && upMins <= firedMins) || (downMins && downMins <= firedMins);
}

async function getCaseForMoment(cache, tradeDate, firedAtText) {
  const key = `${tradeDate}|${firedAtText}`;
  if (cache.has(key)) return cache.get(key);
  const result = await computeCase(tradeDate, firedAtText);
  cache.set(key, result);
  return result;
}

async function run() {
  console.log(`[backtest_dtclass_gate_b_split] Building candidate population (same as Gate B)...`);
  const { rows: candidates } = await query(`
    SELECT id, trade_date::text as trade_date, setup_type,
           fired_at::text as fired_at, actual_pnl::float as actual_pnl,
           size_multiplier::float as size_multiplier
    FROM active_setups
    WHERE setup_type LIKE '%_FADE_%'
      AND origin_status IN ('ACTIVE','SHADOW')
      AND resolution IN ('TARGET_HIT','STOP_HIT','TIME_EXPIRED')
      AND actual_pnl IS NOT NULL
      AND (resolution_method IS NULL OR resolution_method NOT IN ('MARK_TO_MARKET','RECOVERY_MTM'))
    ORDER BY fired_at
  `);
  console.log(`[backtest_dtclass_gate_b_split] N=${candidates.length} candidates`);

  const caseCache = new Map();
  const results = [];

  for (const c of candidates) {
    let finalRead = null;
    try {
      const caseResult = await getCaseForMoment(caseCache, c.trade_date, c.fired_at);
      finalRead = caseResult?.dayTypeReassessment?.read ?? caseResult?.dayType?.classification ?? null;
    } catch (e) {
      console.error(`computeCase failed for ${c.trade_date} ${c.fired_at}: ${e.message}`);
      continue;
    }
    if (!finalRead) continue;

    const orExpanded = await getOrExpanded(c.trade_date, c.fired_at);
    results.push({ ...c, finalRead, orExpanded });
  }
  console.log(`[backtest_dtclass_gate_b_split] Replayed ${results.length}/${candidates.length}`);

  function evalSubGate(label, classFilter) {
    const events = results
      .filter(r => !r.orExpanded && r.finalRead === classFilter)
      .map(r => ({ date: r.trade_date, contribution: 0.10 * r.actual_pnl, actual_pnl: r.actual_pnl }));
    const rigor = computeRigor(events, { dateField: 'date', pnlFn: e => e.contribution });
    const total = events.reduce((s, e) => s + e.contribution, 0);
    const wins = events.filter(e => e.actual_pnl > 0).length;
    const wr = events.length ? wins / events.length : null;
    console.log(`\n=== ${label} (finalRead==='${classFilter}' && !orExpanded) ===`);
    console.log(`N=${events.length} WR=${wr != null ? (wr * 100).toFixed(1) + '%' : 'n/a'} Net Delta (proxy): $${total.toFixed(2)} EV/trade: $${events.length ? (total / events.length).toFixed(2) : 'n/a'}`);
    console.log(`Rigor:`, JSON.stringify(rigor));
    return { events, rigor, total, wr };
  }

  const balance = evalSubGate('BALANCE-ONLY', 'BALANCE');
  const turbulent = evalSubGate('TURBULENT-ONLY', 'TURBULENT');

  // Also compute the un-bonused baseline WR/EV for each class (no-OR-expansion population,
  // regardless of the +0.10 bump) so the "is this class actually worth sizing up" question is
  // answered directly, not just via the pnl-scaled proxy.
  function baselineForClass(classFilter) {
    const rows = results.filter(r => !r.orExpanded && r.finalRead === classFilter);
    const n = rows.length;
    const totalPnl = rows.reduce((s, r) => s + r.actual_pnl, 0);
    const wins = rows.filter(r => r.actual_pnl > 0).length;
    return { n, wr: n ? wins / n : null, ev: n ? totalPnl / n : null, totalPnl };
  }
  const balanceBaseline = baselineForClass('BALANCE');
  const turbulentBaseline = baselineForClass('TURBULENT');
  console.log(`\n=== RAW POPULATION (no-OR-expansion subset, unscaled) ===`);
  console.log(`BALANCE:   N=${balanceBaseline.n} WR=${balanceBaseline.wr != null ? (balanceBaseline.wr * 100).toFixed(1) + '%' : 'n/a'} EV/trade=$${balanceBaseline.ev != null ? balanceBaseline.ev.toFixed(2) : 'n/a'} total=$${balanceBaseline.totalPnl.toFixed(2)}`);
  console.log(`TURBULENT: N=${turbulentBaseline.n} WR=${turbulentBaseline.wr != null ? (turbulentBaseline.wr * 100).toFixed(1) + '%' : 'n/a'} EV/trade=$${turbulentBaseline.ev != null ? turbulentBaseline.ev.toFixed(2) : 'n/a'} total=$${turbulentBaseline.totalPnl.toFixed(2)}`);

  const runDate = (await query(`SELECT CURRENT_DATE::text as today`)).rows[0].today;

  async function persist(label, gate) {
    let verdict = 'NEGATIVE_OR_ZERO';
    if (gate.events.length < 10) verdict = 'TOO_THIN_TO_CONCLUDE';
    else if (gate.total > 0 && gate.rigor.clean) verdict = 'POSITIVE_CLEAN';
    else if (gate.total > 0) verdict = 'POSITIVE_UNSTABLE';

    const rigorStatus = gate.rigor.clean === true ? 'clean' : gate.rigor.clean === false ? 'unstable_or_clustered' : 'too_thin';

    await recordClaim({
      slug: `dtclass_gate_b_${label.toLowerCase()}`,
      claimText: `Split of dtclass_gate_b (the blended BALANCE-or-TURBULENT OR-expansion +0.10 sizeMultiplier bonus at acd.js ~8285, originally tested 2026-09-01 as inconclusive/98%-day-clustered) into a ${label}-only sub-gate, per docs/DTCLASS_LIVE_READ_WIRING_AND_REGIME_SPEC.md's finding that the live day-type read's real accuracy (daytype_accuracy_log) is sharply class-conditional (BALANCE 65.0% vs TURBULENT 17.8%). Same population/methodology as the original Gate B (real ACTIVE/SHADOW fade touches, MTM-origin excluded, computeCase() live-replayed no-lookahead). ${label}-only, no-OR-expansion subset: N=${gate.events.length}, raw WR=${gate.wr != null ? (gate.wr * 100).toFixed(1) + '%' : 'n/a'}, net delta (proxy, +10% of actual_pnl per flagged trade) = $${gate.total.toFixed(2)}, EV/trade=$${gate.events.length ? (gate.total / gate.events.length).toFixed(2) : 'n/a'}. Rigor: ${JSON.stringify(gate.rigor)}. Verdict: ${verdict}.`,
      sourceFile: 'scripts/backtest_dtclass_gate_b_split_by_class.mjs',
      sourceDate: runDate,
      sampleSize: gate.events.length,
      winRate: gate.wr,
      evPerTrade: gate.events.length ? gate.total / gate.events.length : null,
      rigorStatus,
      status: 'PROVISIONAL',
    });

    await query(`
      INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, win_rate, ev_per_trade, total_pnl, recommendation, notes)
      VALUES ($1, 9999, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE
        SET sample_size=EXCLUDED.sample_size, win_rate=EXCLUDED.win_rate, ev_per_trade=EXCLUDED.ev_per_trade,
            total_pnl=EXCLUDED.total_pnl, recommendation=EXCLUDED.recommendation, notes=EXCLUDED.notes
    `, [runDate, SIGNAL_TYPE, label, gate.events.length, gate.wr, gate.events.length ? gate.total / gate.events.length : null, gate.total, verdict, JSON.stringify({ rigor: gate.rigor })]);

    console.log(`[persist] ${label}: verdict=${verdict}`);
    return verdict;
  }

  const balanceVerdict = await persist('BALANCE', balance);
  const turbulentVerdict = await persist('TURBULENT', turbulent);

  console.log(`\n=== SUMMARY ===`);
  console.log(`BALANCE-only:   ${balanceVerdict}`);
  console.log(`TURBULENT-only: ${turbulentVerdict}`);
  console.log(`(Original blended Gate B: POSITIVE_UNSTABLE, +$125.90, 98% day-clustered)`);

  await pool.end();
}

run().catch(e => { console.error('[backtest_dtclass_gate_b_split] ERROR:', e.message, e.stack); process.exit(1); });
