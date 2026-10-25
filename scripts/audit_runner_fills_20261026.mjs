// Runner-mechanism realistic-fill audit: T1-floor runner and step-trail. Prereg (committed first): docs/BREAKEVEN_STOP_FILL_AUDIT_PREREG_20261026.md, Addendum A.
// Calls the REAL walkers (stepT1FloorRunner, stepWiderTarget + stepStepTrail); only the fill rules differ:
//   - the runner's stop is effective from the bar AFTER the target-touch bar; if the touch bar already closed beyond it, exit at the next bar's open (market)
//   - a stop hit fills at min(stop, open) (long) / max(stop, open) (short)
//   - T1-floor: no Math.max(mark-to-market, floor)
//   node scripts/audit_runner_fills_20261026.mjs [--no-record]
import { query } from '../server/db.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import { resolveDirection } from '../server/config/setupTypes.js';
import { isInsideNqRollWeek } from '../server/services/acdShared.js';
import { dayBlockedBootstrapCI } from '../server/services/rigorDiagnostics.js';
import { stepT1FloorRunner, t1FloorPnlFromResolution } from '../server/services/t1FloorRunnerWalker.js';
import { stepWiderTarget, WIDER_TARGET_MULT, MAX_BARS_TO_T1_FOR_WIDER } from '../server/services/widerTargetWalker.js';
import { stepStepTrail } from '../server/services/stepTrailWalker.js';
import { recordClaim } from './record_claim.mjs';

const PPT = LIVE_INSTRUMENT.dollarsPerPoint, COMM = LIVE_INSTRUMENT.commissionPerRoundTrip;
const sum = (a) => a.reduce((s, x) => s + x, 0), mean = (a) => (a.length ? sum(a) / a.length : null);
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const money = (v) => (v == null ? 'n/a' : `${v < 0 ? '-' : '+'}$${Math.abs(v).toFixed(2)}`);
const pnl = (px, entry, long) => (long ? px - entry : entry - px) * PPT - COMM;
const modOf = (ts) => { const m = ts.match(/(\d{2}):(\d{2}):/); return +m[1] * 60 + +m[2]; };
const fillStop = (long, level, open) => (long ? Math.min(level, open) : Math.max(level, open));
const FILTER = `is_cluster_primary IS NOT FALSE AND ib_window_stale_basis IS NOT TRUE AND stale_entry_price_basis IS NOT TRUE AND late_fill_past_expiry_basis IS NOT TRUE AND bad_bars_basis IS NOT TRUE`;

async function bars(sql, params) {
  return (await query(sql, params)).rows.map((b) => ({ ts: b.ts, open: b.open, high: b.high, low: b.low, close: b.close, bid_volume: b.bid_volume, ask_volume: b.ask_volume, mod: modOf(b.ts) }));
}

// ---------- T1-floor runner ----------
async function t1floor() {
  const trades = (await query(`SELECT id, setup_type, trade_date::text d, fired_at::text fa, resolved_at::text ra, is_rth, entry_zone_low::float entry, t1_level::float t1, actual_pnl::float base
    FROM active_setups WHERE origin_status='ACTIVE' AND resolution='TARGET_HIT' AND resolution_method='PRICE_CLEAN' AND actual_pnl IS NOT NULL AND entry_zone_low IS NOT NULL AND t1_level IS NOT NULL
    AND stop_level IS NOT NULL AND wider_target_mult IS NULL AND runner_trail_width IS NULL AND extend_target_level IS NULL AND setup_type <> 'ABSORPTION_LONG' AND resolved_at IS NOT NULL
    AND trade_date >= CURRENT_DATE - INTERVAL '90 days' AND ${FILTER} ORDER BY resolved_at`)).rows.filter((t) => !isInsideNqRollWeek(t.d));
  const out = [];
  for (const t of trades) {
    const long = t.t1 > t.entry, t1Dist = Math.abs(t.t1 - t.entry);
    const ft = long ? t.entry + WIDER_TARGET_MULT * t1Dist : t.entry - WIDER_TARGET_MULT * t1Dist;
    const bs = await bars(`SELECT ts::text ts, open::float open, high::float high, low::float low, close::float close FROM price_bars_primary
      WHERE symbol='NQ' AND ts >= $1::timestamp AND ts::date = $2::date AND (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts)) < 960 ORDER BY ts`, [t.ra, t.d]);
    if (!bs.length || bs[0].ts !== t.ra) continue;
    const touch = bs[0], later = bs.slice(1), firedMod = modOf(t.fa);
    // UNADJUSTED = the original claim's method (floor fills at T1 exactly, touch bar ignored, MTM floored at the banked win)
    let un = null;
    for (const b of later) { const fh = long ? b.low <= t.t1 : b.high >= t.t1, xh = long ? b.high >= ft : b.low <= ft; if (fh) { un = pnl(t.t1, t.entry, long); break; } if (xh) { un = pnl(ft, t.entry, long); break; } }
    if (un == null) { const last = later.length ? later[later.length - 1].close : t.t1; un = Math.max(pnl(last, t.entry, long), pnl(t.t1, t.entry, long)); }
    // REALISTIC
    let re = null, reC = null, how = null, state = {};
    const reversed = long ? touch.close < t.t1 : touch.close > t.t1;
    if (reversed) { re = pnl(later.length ? later[0].open : touch.close, t.entry, long); reC = pnl(touch.close, t.entry, long); how = 'REVERSED_ON_TOUCH_BAR'; }
    else {
      for (const b of later) {
        const s = stepT1FloorRunner(state, { high: b.high, low: b.low, close: b.close, mod: b.mod }, { t1: t.t1, ft, long, firedMod });
        if (s.resolution) {
          const r = s.resolution;
          if (r.method === 'T1_FLOOR_HIT') { re = pnl(fillStop(long, t.t1, b.open), t.entry, long); how = b.open === fillStop(long, t.t1, b.open) && b.open !== t.t1 ? 'FLOOR_GAP' : 'FLOOR'; }
          else if (r.method === 'T1_FLOOR_RUNNER_HIT') { re = pnl(ft, t.entry, long); how = 'RUNNER'; }
          else { re = pnl(r.priceAtRes, t.entry, long); how = 'MTM'; }
          break;
        }
      }
      if (re == null) { re = pnl(later.length ? later[later.length - 1].close : t.t1, t.entry, long); how = 'END'; }
    }
    out.push({ id: t.id, date: t.d, isRth: t.is_rth === true, base: t.base, un, re, reC: reC ?? re, how });
  }
  return out;
}

// ---------- step-trail ----------
async function steptrail() {
  const calib = (await query(`SELECT notes FROM performance_audit WHERE signal_type='STEP_TRAIL_FRACTION' AND signal_name='FRACTION' ORDER BY run_date DESC, id DESC LIMIT 1`)).rows[0];
  const p10 = JSON.parse(calib.notes).p10BaseFloor;
  const pg = (await query(`SELECT notes FROM performance_audit WHERE signal_type='WIDER_TARGET_PRESSURE_GATE' AND signal_name='THRESHOLD' ORDER BY run_date DESC, id DESC LIMIT 1`)).rows[0];
  const pressureThreshold = pg ? JSON.parse(pg.notes).threshold : null;
  const rows = (await query(`SELECT id, setup_type, trade_date::text d, fired_at::text fa, is_rth, entry_zone_low::float elo, entry_zone_high::float ehi, stop_level::float stop, t1_level::float t1, wider_target_mult::float wm, actual_pnl::float actual, step_trail_shadow
    FROM active_setups WHERE step_trail_shadow->>'armed_at' IS NOT NULL AND wider_target_mult IS NOT NULL AND stop_level IS NOT NULL AND t1_level IS NOT NULL AND origin_status IN ('ACTIVE','SHADOW') AND ${FILTER} ORDER BY id`)).rows
    .filter((r) => !isInsideNqRollWeek(r.d));
  const out = []; let armMismatch = 0;
  for (const r of rows) {
    const j = typeof r.step_trail_shadow === 'string' ? JSON.parse(r.step_trail_shadow) : r.step_trail_shadow;
    const dir = resolveDirection({ setup_type: r.setup_type, entry_zone_low: r.elo, entry_zone_high: r.ehi, stop_level: r.stop, t1_level: r.t1 });
    if (dir === null || !j.resolved_at) continue;
    const long = dir === 'LONG', entry = r.ehi ?? r.elo, firedMod = modOf(r.fa);
    const widerTarget = long ? entry + Math.abs(r.t1 - entry) * r.wm : entry - Math.abs(r.t1 - entry) * r.wm;
    const stepSize = j.frac * Math.max(Math.abs(widerTarget - entry), p10);
    const bs = await bars(`SELECT ts::text ts, open::float open, high::float high, low::float low, close::float close, bid_volume, ask_volume FROM price_bars_primary
      WHERE symbol='NQ' AND ts > $1::timestamp AND ts <= ($2::timestamp + interval '5 minutes') ORDER BY ts`, [r.fa, j.resolved_at]);
    let wState = { widening: false }, sState = { inner: { widening: false }, ratcheting: false, currentStop: null, highestMfe: null };
    let armedTs = null, unRes = null, reRes = null, reResC = null, barCount = 0, reHow = null;
    for (let i = 0; i < bs.length; i++) {
      const bar = bs[i]; barCount++;
      const tot = (bar.bid_volume || 0) + (bar.ask_volume || 0);
      const pressureReading = tot > 0 ? ((long ? bar.ask_volume : bar.bid_volume) - (long ? bar.bid_volume : bar.ask_volume)) / tot : null;
      const prm = { entry, stop: r.stop, t1: r.t1, widerTarget, long, barCount, maxBarsToT1: MAX_BARS_TO_T1_FOR_WIDER, firedMod, pressureReading, pressureThreshold };
      wState = stepWiderTarget(wState, bar, prm).state;
      const s = stepStepTrail(sState, bar, { ...prm, stepSize });
      const wasRatcheting = sState.ratcheting; sState = s.state;
      if (sState.ratcheting && !wasRatcheting) {
        armedTs = bar.ts;
        const rev = long ? bar.close < sState.currentStop : bar.close > sState.currentStop;
        if (rev && reRes == null) { reRes = pnl(bs[i + 1] ? bs[i + 1].open : bar.close, entry, long); reResC = pnl(bar.close, entry, long); reHow = 'REVERSED_ON_ARM_BAR'; }
      }
      if (s.resolution) {
        const x = s.resolution; if (unRes == null) unRes = pnl(x.priceAtRes, entry, long);
        if (reRes == null) { reRes = pnl(x.method === 'STEP_TRAIL_STOP_HIT' ? fillStop(long, x.priceAtRes, bar.open) : x.priceAtRes, entry, long); reHow = x.method; }
        break;
      }
    }
    if (armedTs !== j.armed_at || unRes == null) { armMismatch++; continue; }
    out.push({ id: r.id, date: r.d, isRth: r.is_rth === true, base: j.real_pnl, stored: j.hypothetical_pnl, un: unRes, re: reRes ?? unRes, reC: reResC ?? reRes ?? unRes, how: reHow });
  }
  return { out, armMismatch, total: rows.length };
}

function report(label, arr, unKey = 'un') {
  const dRe = (x) => x.re - x.base, dUn = (x) => x[unKey] - x.base;
  const ci = (key, seed) => (arr.length >= 4 ? dayBlockedBootstrapCI(arr.map((x) => ({ date: x.date, pnl: key(x) })), seed, { iters: 3000 }) : { lo: null, hi: null });
  const sorted = [...arr].sort((a, b) => (a.date < b.date ? -1 : 1)), mid = sorted.length >> 1;
  const o = { label, n: arr.length, days: new Set(arr.map((x) => x.date)).size, baseMean: mean(arr.map((x) => x.base)), dUn: mean(arr.map(dUn)), ciUn: ci(dUn, `${label}|un`), dRe: mean(arr.map(dRe)), ciRe: ci(dRe, `${label}|re`), dReC: mean(arr.map((x) => x.reC - x.base)), ciReC: ci((x) => x.reC - x.base, `${label}|reC`), h1: mean(sorted.slice(0, mid).map(dRe)), h2: mean(sorted.slice(mid).map(dRe)) };
  console.log(`${label.padEnd(26)} n=${String(o.n).padStart(3)} days=${String(o.days).padStart(2)} base ${money(o.baseMean)} | UNADJUSTED d ${money(o.dUn)} [${money(o.ciUn.lo)},${money(o.ciUn.hi)}] | REALISTIC d ${money(o.dRe)} [${money(o.ciRe.lo)},${money(o.ciRe.hi)}] closeVariant d ${money(o.dReC)} [${money(o.ciReC.lo)},${money(o.ciReC.hi)}] | halves ${money(o.h1)} / ${money(o.h2)}`);
  return o;
}
const verdict = (o) => (o.ciRe.lo > 0 && o.h1 > 0 && o.h2 > 0 ? 'HELPS' : o.ciRe.hi < 0 && o.h1 < 0 && o.h2 < 0 ? 'HURTS' : 'NOT SHOWN');

async function main() {
  const noRecord = process.argv.includes('--no-record');
  console.log('=== T1-FLOOR RUNNER ===');
  const t = await t1floor();
  const th = report('T1F ALL', t); report('T1F RTH', t.filter((x) => x.isRth)); report('T1F GLOBEX', t.filter((x) => !x.isRth));
  const how = {}; for (const x of t) how[x.how] = (how[x.how] || 0) + 1;
  console.log('realistic exits:', how, '| reversed on touch bar share', (t.filter((x) => x.how === 'REVERSED_ON_TOUCH_BAR').length / t.length).toFixed(3));
  console.log('=== STEP-TRAIL ===');
  const { out: s, armMismatch, total } = await steptrail();
  console.log(`armed rows ${total}; replayed with matching arm bar ${s.length}; arm-bar mismatch/unusable ${armMismatch}`);
  const par = s.filter((x) => x.stored != null);
  console.log(`parity (unadjusted replay vs stored hypothetical): within $1 ${par.filter((x) => Math.abs(x.un - x.stored) <= 1).length}/${par.length}, median abs gap ${median(par.map((x) => Math.abs(x.un - x.stored)))?.toFixed(2)}`);
  const sh = report('STEP ALL', s); report('STEP RTH', s.filter((x) => x.isRth)); report('STEP GLOBEX', s.filter((x) => !x.isRth));
  const how2 = {}; for (const x of s) how2[x.how] = (how2[x.how] || 0) + 1; console.log('realistic exits:', how2);
  const vT = verdict(th), vS = verdict(sh);
  console.log(`\nVERDICTS (frozen rule): T1-floor ${vT}; step-trail ${vS}`);
  if (!noRecord) {
    const txt = (name, o, v, extra) => `${name} realistic-fill audit (prereg Addendum A, docs/BREAKEVEN_STOP_FILL_AUDIT_PREREG_20261026.md). ${o.n} trades over ${o.days} days. Baseline (banked target) ${money(o.baseMean)}/trade. Claimed (unadjusted replay) runner minus banked ${money(o.dUn)} [${money(o.ciUn.lo)}, ${money(o.ciUn.hi)}]; with realistic fills (stop effective from the bar after the touch bar, market exit if already beyond it, gap fills at the open) ${money(o.dRe)} [${money(o.ciRe.lo)}, ${money(o.ciRe.hi)}], halves ${money(o.h1)} / ${money(o.h2)}. Sensitivity, reversing trades exit at the touch-bar close instead of the next open: ${money(o.dReC)} [${money(o.ciReC.lo)}, ${money(o.ciReC.hi)}]. ${extra} VERDICT under the frozen rule: ${v}.`;
    await recordClaim({ slug: 't1floor_runner_realistic_fill_audit_20261026', claimText: txt('T1-floor runner', th, vT, `Reversed on the touch bar: ${(t.filter((x) => x.how === 'REVERSED_ON_TOUCH_BAR').length / t.length * 100).toFixed(0)}% of trades.`), sourceFile: 'scripts/audit_runner_fills_20261026.mjs', sourceDate: '2026-10-26', sampleSize: th.n, evPerTrade: th.dRe, rigorStatus: 'day_blocked_bootstrap_realistic_fills', status: 'PROVISIONAL' });
    await recordClaim({ slug: 'steptrail_realistic_fill_audit_20261026', claimText: txt('Step-trail', sh, vS, `Replay parity vs stored hypothetical: ${par.filter((x) => Math.abs(x.un - x.stored) <= 1).length}/${par.length} within $1; ${armMismatch} of ${total} armed rows excluded (arm bar did not reproduce).`), sourceFile: 'scripts/audit_runner_fills_20261026.mjs', sourceDate: '2026-10-26', sampleSize: sh.n, evPerTrade: sh.dRe, rigorStatus: 'day_blocked_bootstrap_realistic_fills', status: 'PROVISIONAL' });
    console.log('claims recorded');
  }
}
if (import.meta.url === `file://${process.argv[1]}`) main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
