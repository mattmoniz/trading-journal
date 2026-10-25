// Breakeven-stop realistic-fill audit. Prereg (committed first): docs/BREAKEVEN_STOP_FILL_AUDIT_PREREG_20261026.md
// Question: does the live breakeven stop (arm at entry on an order-flow REWARDED push) still help once the stop is only effective AFTER the
// arming bar closes and fills at market when the market is already beyond it? Compares PLAIN vs REALISTIC_BE vs what was BOOKED.
//   node scripts/audit_breakeven_stop_fills_20261026.mjs [--no-record]
import { query } from '../server/db.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import { resolveDirection } from '../server/config/setupTypes.js';
import { isInsideNqRollWeek } from '../server/services/acdShared.js';
import { dayBlockedBootstrapCI, computeRigor, hashSeed, mulberry32 } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';

const PPT = LIVE_INSTRUMENT.dollarsPerPoint, COMM = LIVE_INSTRUMENT.commissionPerRoundTrip;
const sum = (a) => a.reduce((s, x) => s + x, 0), mean = (a) => (a.length ? sum(a) / a.length : null);
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const money = (v) => (v == null ? 'n/a' : `${v < 0 ? '-' : '+'}$${Math.abs(v).toFixed(2)}`);

const BASE = `origin_status IN ('ACTIVE','SHADOW') AND is_cluster_primary IS NOT FALSE AND actual_pnl IS NOT NULL AND resolution IS DISTINCT FROM 'NOT_FILLED'
  AND ib_window_stale_basis IS NOT TRUE AND stale_entry_price_basis IS NOT TRUE AND late_fill_past_expiry_basis IS NOT TRUE AND bad_bars_basis IS NOT TRUE
  AND setup_type NOT LIKE 'POC_ROTATION_JOIN%' AND NOT (fired_at::time >= '16:00' AND fired_at::time < '18:00') AND expires_at IS NOT NULL`;
const COLS = `id, setup_type, trade_date::text d, fired_at::text fired, expires_at::text expires, entry_zone_low::float elo, entry_zone_high::float ehi, stop_level::float stop, t1_level::float t1,
  actual_pnl::float actual, is_rth, wider_target_mult, runner_trail_width, extend_target_level, breakeven_stop_shadow, breakeven_stop_live, setup_type st`;

const pnlOf = (exit, entry, long) => (long ? exit - entry : entry - exit) * PPT - COMM;

// One simulator for every arm. armIdx = index of the arming bar (null = plain). closeVariant = underwater exit at the arming bar's close instead of the next open.
export function simulate(bars, { entry, stop, t1, long }, armIdx = null, closeVariant = false) {
  const fillStop = (level, b) => (long ? Math.min(level, b.open) : Math.max(level, b.open));
  let be = false;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (be) {
      const stopHit = long ? b.low <= entry : b.high >= entry, tgtHit = long ? b.high >= t1 : b.low <= t1;
      if (stopHit) return { exit: fillStop(entry, b), how: 'BE_STOP', i };
      if (tgtHit) return { exit: t1, how: 'TARGET', i };
      continue;
    }
    const stopHit = long ? b.low <= stop : b.high >= stop, tgtHit = long ? b.high >= t1 : b.low <= t1;
    if (stopHit) return { exit: fillStop(stop, b), how: 'STOP', i };
    if (tgtHit) return { exit: t1, how: 'TARGET', i };
    if (armIdx != null && i === armIdx) {
      // the arming bar's order flow is final only at its close: the breakeven stop is effective from the NEXT bar
      const under = long ? b.close < entry : b.close > entry;
      if (under) {
        if (closeVariant) return { exit: b.close, how: 'BE_MARKET_AT_CLOSE', i };
        if (i + 1 < bars.length) return { exit: bars[i + 1].open, how: 'BE_MARKET_NEXT_OPEN', i: i + 1 };
        return { exit: b.close, how: 'BE_MARKET_AT_CLOSE', i };
      }
      be = true;
    }
  }
  const last = bars[bars.length - 1];
  return { exit: last ? last.close : entry, how: 'MTM', i: bars.length - 1 };
}

async function loadBars(row) {
  const r = await query(`SELECT ts::text ts, open::float open, high::float high, low::float low, close::float close FROM price_bars_primary
    WHERE symbol='NQ' AND ts > $1::timestamp AND ts <= $2::timestamp ORDER BY ts ASC`, [row.fired, row.expires]);
  return r.rows;
}

const parse = (v) => (v == null ? null : typeof v === 'string' ? JSON.parse(v) : v);

async function main() {
  const noRecord = process.argv.includes('--no-record');
  const rows = (await query(`SELECT ${COLS} FROM active_setups WHERE ${BASE} AND trade_date >= '2026-07-09' AND (breakeven_stop_shadow IS NOT NULL OR breakeven_stop_live IS NOT NULL)`)).rows
    .filter((r) => !isInsideNqRollWeek(r.d));
  const armed = [], controls = [];
  for (const r of rows) {
    const sh = parse(r.breakeven_stop_shadow), lv = parse(r.breakeven_stop_live);
    const src = lv ? 'live' : 'shadow', j = lv || sh;
    const cls = j.classification;
    if (cls === 'REWARDED' && j.armed_at) armed.push({ ...r, src, j });
    else if (cls === 'NO_PUSH') controls.push({ ...r, src, j });
  }
  console.log(`rows ${rows.length}; armed REWARDED ${armed.length}; NO_PUSH controls ${controls.length}`);

  const results = [];
  let skipped = 0;
  for (const r of armed) {
    const dir = resolveDirection({ setup_type: r.setup_type, entry_zone_low: r.elo, entry_zone_high: r.ehi, stop_level: r.stop, t1_level: r.t1 });
    if (dir === null || r.stop == null || r.t1 == null) { skipped++; continue; }
    const long = dir === 'LONG', entry = r.ehi ?? r.elo;
    const bars = await loadBars(r);
    const armIdx = bars.findIndex((b) => b.ts === r.j.armed_at);
    if (!bars.length || armIdx < 0) { skipped++; continue; }
    const p = { entry, stop: r.stop, t1: r.t1, long };
    const plain = simulate(bars, p), real = simulate(bars, p, armIdx), realC = simulate(bars, p, armIdx, true);
    const arm = bars[armIdx];
    const booked = r.src === 'live' ? r.actual : r.j.hypothetical_pnl;
    const storedPlain = r.src === 'live' ? r.j.counterfactual_pnl : r.j.real_pnl;
    const otherMech = r.wider_target_mult != null || r.runner_trail_width != null || r.extend_target_level != null;
    results.push({ id: r.id, date: r.d, type: r.setup_type, src: r.src, isRth: r.is_rth === true, long, armIdx, under: long ? arm.close < entry : arm.close > entry,
      plain: pnlOf(plain.exit, entry, long), real: pnlOf(real.exit, entry, long), realC: pnlOf(realC.exit, entry, long), booked, storedPlain, otherMech, how: real.how, plainHow: plain.how });
  }
  console.log(`replayed ${results.length}, skipped ${skipped}`);

  const dBase = results.map((x) => ({ date: x.date, pnl: x.real - x.plain }));
  const stat = (arr, key) => ({ n: arr.length, mean: mean(arr.map((x) => key(x))), sum: sum(arr.map((x) => key(x))) });
  const ci = (arr, key, seed) => (arr.length >= 4 ? dayBlockedBootstrapCI(arr.map((x) => ({ date: x.date, pnl: key(x) })), seed, { iters: 3000 }) : { lo: null, hi: null });
  const report = (label, arr) => {
    if (!arr.length) return null;
    const dReal = (x) => x.real - x.plain, dBooked = (x) => (x.booked == null ? 0 : x.booked) - x.plain;
    const sorted = [...arr].sort((a, b) => (a.date < b.date ? -1 : 1)), mid = sorted.length >> 1;
    const o = {
      label, n: arr.length, days: new Set(arr.map((x) => x.date)).size,
      plainMean: mean(arr.map((x) => x.plain)), realMean: mean(arr.map((x) => x.real)), bookedMean: mean(arr.map((x) => x.booked ?? 0)),
      deltaReal: mean(arr.map(dReal)), deltaRealCI: ci(arr, dReal, `be|${label}|real`), deltaClose: mean(arr.map((x) => x.realC - x.plain)),
      deltaBooked: mean(arr.map(dBooked)), deltaBookedCI: ci(arr, dBooked, `be|${label}|booked`),
      half1: mean(sorted.slice(0, mid).map(dReal)), half2: mean(sorted.slice(mid).map(dReal)),
    };
    console.log(`${label.padEnd(28)} n=${String(o.n).padStart(3)} days=${String(o.days).padStart(2)} plain ${money(o.plainMean)} | booked ${money(o.bookedMean)} (d ${money(o.deltaBooked)} [${money(o.deltaBookedCI.lo)},${money(o.deltaBookedCI.hi)}]) | REALISTIC ${money(o.realMean)} (d ${money(o.deltaReal)} [${money(o.deltaRealCI.lo)},${money(o.deltaRealCI.hi)}]) closeVariant d ${money(o.deltaClose)} | halves ${money(o.half1)} / ${money(o.half2)}`);
    return o;
  };
  console.log('\n--- PARITY: PLAIN replay vs stored plain outcome ---');
  const par = results.filter((x) => x.storedPlain != null);
  const gaps = par.map((x) => Math.abs(x.plain - x.storedPlain));
  const cleanPar = results.filter((x) => x.storedPlain != null && !x.otherMech && Math.abs(x.plain - x.storedPlain) <= 1);
  console.log(`stored plain available ${par.length}; within $1: ${par.filter((x, i) => gaps[i] <= 1).length}; median abs gap ${median(gaps)?.toFixed(2)}; parity-clean subset ${cleanPar.length}`);

  console.log('\n--- HEADLINE AND SPLITS (delta = REALISTIC_BE minus PLAIN, same rows) ---');
  const head = report('ALL armed', results);
  const parts = [report('shadow period', results.filter((x) => x.src === 'shadow')), report('live period', results.filter((x) => x.src === 'live')),
    report('RTH', results.filter((x) => x.isRth)), report('GLOBEX', results.filter((x) => !x.isRth)),
    report('underwater at arm-bar close', results.filter((x) => x.under)), report('in profit at arm-bar close', results.filter((x) => !x.under)),
    report('parity-clean subset', cleanPar)].filter(Boolean);
  const byType = new Map(); for (const x of results) byType.set(x.type, [...(byType.get(x.type) || []), x]);
  for (const [t, a] of [...byType].filter(([, a]) => a.length >= 20).sort((a, b) => b[1].length - a[1].length).slice(0, 6)) report(`type ${t}`, a);
  const how = {}; for (const x of results) how[x.how] = (how[x.how] || 0) + 1;
  console.log('how REALISTIC_BE exits:', how, '| underwater share', (results.filter((x) => x.under).length / results.length).toFixed(3));
  const dayTotals = new Map(); for (const x of dBase) dayTotals.set(x.date, (dayTotals.get(x.date) || 0) + x.pnl);
  const rig = computeRigor(results.map((x) => ({ date: x.date, pnl: x.real - x.plain })), { dateField: 'date', pnlFn: (e) => e.pnl });
  console.log('rigor (delta):', { clustered: rig.clustered, top5DayPct: rig.top5DayPct, distinctDates: rig.distinctDates, stable: rig.stable });

  // PLACEBO: blind "snap the stop to entry at bar k" on trades that never had a push (NO_PUSH), k drawn from the real arming-offset distribution.
  console.log('\n--- PLACEBO: blind breakeven snap on NO_PUSH trades (same offset distribution) ---');
  const offsets = results.map((x) => x.armIdx);
  const rand = mulberry32(hashSeed('be-placebo-20261026'));
  const sample = controls.sort(() => rand() - 0.5).slice(0, 500);
  const plc = [];
  for (const r of sample) {
    const dir = resolveDirection({ setup_type: r.setup_type, entry_zone_low: r.elo, entry_zone_high: r.ehi, stop_level: r.stop, t1_level: r.t1 });
    if (dir === null || r.stop == null || r.t1 == null) continue;
    const long = dir === 'LONG', entry = r.ehi ?? r.elo, bars = await loadBars(r);
    if (bars.length < 3) continue;
    const p = { entry, stop: r.stop, t1: r.t1, long }, plain = simulate(bars, p), ds = [];
    for (let k = 0; k < 10; k++) {
      const idx = offsets[Math.floor(rand() * offsets.length)];
      if (idx >= bars.length - 1 || idx >= plain.i) continue; // blind snap only counts if the trade was still open at that bar
      ds.push(pnlOf(simulate(bars, p, idx).exit, entry, long) - pnlOf(plain.exit, entry, long));
    }
    if (ds.length) plc.push({ date: r.d, pnl: mean(ds) });
  }
  const plcMean = mean(plc.map((x) => x.pnl)), plcCI = plc.length >= 4 ? dayBlockedBootstrapCI(plc, 'be|placebo', { iters: 3000 }) : { lo: null, hi: null };
  console.log(`placebo rows ${plc.length}: mean delta ${money(plcMean)} CI [${money(plcCI.lo)}, ${money(plcCI.hi)}]  vs real armed ${money(head.deltaReal)}`);

  let verdict = 'NOT SHOWN';
  if (head.deltaRealCI.lo > 0 && head.half1 > 0 && head.half2 > 0) verdict = 'HELPS';
  else if (head.deltaRealCI.hi < 0 && head.half1 < 0 && head.half2 < 0) verdict = 'HURTS';
  console.log(`\nVERDICT (frozen rule): ${verdict}`);
  const text = `Breakeven-stop realistic-fill audit (prereg docs/BREAKEVEN_STOP_FILL_AUDIT_PREREG_20261026.md). ${head.n} armed REWARDED trades over ${head.days} days (${parts[0] ? parts[0].n : 0} shadow-period, ${parts[1] ? parts[1].n : 0} live). ` +
    `Mean per trade: plain ${money(head.plainMean)}, as booked by the mechanism ${money(head.bookedMean)} (booked minus plain ${money(head.deltaBooked)}), realistic fills ${money(head.realMean)}. ` +
    `Realistic minus plain ${money(head.deltaReal)}/trade, day-blocked 95% CI [${money(head.deltaRealCI.lo)}, ${money(head.deltaRealCI.hi)}], halves ${money(head.half1)} / ${money(head.half2)}. ` +
    `Placebo (blind snap on no-push trades) ${money(plcMean)} [${money(plcCI.lo)}, ${money(plcCI.hi)}]. Underwater at the arming bar: ${(results.filter((x) => x.under).length / results.length * 100).toFixed(0)}%. VERDICT under the frozen rule: ${verdict}.`;
  console.log('\n' + text);
  if (!noRecord) {
    await recordClaim({ slug: 'breakeven_stop_realistic_fill_audit_20261026', claimText: text, sourceFile: 'scripts/audit_breakeven_stop_fills_20261026.mjs', sourceDate: '2026-10-26',
      sampleSize: head.n, evPerTrade: head.deltaReal, rigorStatus: 'day_blocked_bootstrap_placebo_parity_checked', status: 'PROVISIONAL' });
    console.log('claim recorded');
  }
}
if (import.meta.url === `file://${process.argv[1]}`) main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
