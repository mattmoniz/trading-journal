// Progress-triggered breakeven test. Prereg (committed first): docs/PROGRESS_BREAKEVEN_PREREG_20261026.md
//   node scripts/audit_progress_breakeven_20261026.mjs [--no-record]
import { query } from '../server/db.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import { resolveDirection, usesLevelAnchoredExit } from '../server/config/setupTypes.js';
import { isInsideNqRollWeek } from '../server/services/acdShared.js';
import { dayBlockedBootstrapCI, hashSeed, mulberry32 } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';

const PPT = LIVE_INSTRUMENT.dollarsPerPoint, COMM = LIVE_INSTRUMENT.commissionPerRoundTrip;
const XS = [0.5, 0.75, 0.9], PLACEBO_DRAWS = 10;
const sum = (a) => a.reduce((s, x) => s + x, 0), mean = (a) => (a.length ? sum(a) / a.length : null);
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const money = (v) => (v == null ? 'n/a' : `${v < 0 ? '-' : '+'}$${Math.abs(v).toFixed(2)}`);
const pnl = (px, entry, long) => (long ? px - entry : entry - px) * PPT - COMM;
const fillStop = (long, level, open) => (long ? Math.min(level, open) : Math.max(level, open));

// X = null -> PLAIN. One simulator for every arm; returns exit price.
export function sim(bars, { entry, stop, t1, long }, X) {
  const dist = Math.abs(t1 - entry), level = long ? entry + X * dist : entry - X * dist;
  let be = false;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (be) {
      if (long ? b.low <= entry : b.high >= entry) return fillStop(long, entry, b.open);
      if (long ? b.high >= t1 : b.low <= t1) return t1;
      continue;
    }
    if (long ? b.low <= stop : b.high >= stop) return fillStop(long, stop, b.open);
    if (long ? b.high >= t1 : b.low <= t1) return t1;
    if (X != null && (long ? b.high >= level : b.low <= level)) {
      // armed on this bar's information -> effective from the next bar
      if (long ? b.close < entry : b.close > entry) return bars[i + 1] ? bars[i + 1].open : b.close;
      be = true;
    }
  }
  return bars.length ? bars[bars.length - 1].close : entry;
}

async function main() {
  const noRecord = process.argv.includes('--no-record');
  const rows = (await query(`SELECT id, setup_type, trade_date::text d, fired_at::text fa, expires_at::text ex, is_rth, entry_zone_low::float elo, entry_zone_high::float ehi, stop_level::float stop, t1_level::float t1,
      actual_pnl::float actual, resolution_method rm FROM active_setups
    WHERE origin_status IN ('ACTIVE','SHADOW') AND is_cluster_primary IS NOT FALSE AND actual_pnl IS NOT NULL AND resolution IS DISTINCT FROM 'NOT_FILLED' AND trade_date >= '2026-07-09'
      AND wider_target_mult IS NULL AND runner_trail_width IS NULL AND extend_target_level IS NULL AND stop_level IS NOT NULL AND t1_level IS NOT NULL AND expires_at IS NOT NULL
      AND ib_window_stale_basis IS NOT TRUE AND stale_entry_price_basis IS NOT TRUE AND late_fill_past_expiry_basis IS NOT TRUE AND bad_bars_basis IS NOT TRUE
      AND setup_type NOT LIKE 'POC_ROTATION_JOIN%' AND NOT (fired_at::time >= '16:00' AND fired_at::time < '18:00') ORDER BY id`)).rows.filter((r) => !isInsideNqRollWeek(r.d));
  console.log(`candidate rows ${rows.length}`);
  const trades = [];
  for (const r of rows) {
    const dir = resolveDirection({ setup_type: r.setup_type, entry_zone_low: r.elo, entry_zone_high: r.ehi, stop_level: r.stop, t1_level: r.t1 });
    if (dir === null) continue;
    const entry = r.ehi ?? r.elo; if (entry == null || Math.abs(r.t1 - entry) === 0) continue;
    const bars = (await query(`SELECT open::float open, high::float high, low::float low, close::float close FROM price_bars_primary
      WHERE symbol='NQ' AND ts > $1::timestamp AND ts <= $2::timestamp ORDER BY ts`, [r.fa, r.ex])).rows;
    if (bars.length < 2) continue;
    trades.push({ r, long: dir === 'LONG', entry, bars, anchored: usesLevelAnchoredExit(r.setup_type) });
  }
  console.log(`replayable trades ${trades.length}`);
  const P = (t, X, flip = false) => {
    const long = flip ? !t.long : t.long, stop = flip ? 2 * t.entry - t.r.stop : t.r.stop, t1 = flip ? 2 * t.entry - t.r.t1 : t.r.t1;
    return pnl(sim(t.bars, { entry: t.entry, stop, t1, long }, X), t.entry, long);
  };
  // parity: PLAIN replay vs stored actual_pnl on clean price exits
  const par = trades.filter((t) => ['PRICE_CLEAN', 'SAME_BAR_STOP_FIRST'].includes(t.r.rm)).map((t) => Math.abs(P(t, null) - t.r.actual));
  console.log(`parity (PLAIN replay vs stored actual_pnl, clean price exits): ${par.filter((g) => g <= 1).length}/${par.length} within $1, median gap ${median(par)?.toFixed(2)}`);
  const plain = trades.map((t) => P(t, null));
  console.log(`PLAIN mean per trade ${money(mean(plain))} over ${trades.length} trades`);

  const summary = {};
  for (const X of XS) {
    const be = trades.map((t) => P(t, X));
    const ev = trades.map((t, i) => ({ date: t.r.d, pnl: be[i] - plain[i], anchored: t.anchored, isRth: t.r.is_rth === true, type: t.r.setup_type, plain: plain[i], be: be[i] }));
    const ci = (arr, seed) => (arr.length >= 4 ? dayBlockedBootstrapCI(arr, seed, { iters: 3000 }) : { lo: null, hi: null });
    const sorted = [...ev].sort((a, b) => (a.date < b.date ? -1 : 1)), mid = sorted.length >> 1;
    const head = { n: ev.length, days: new Set(ev.map((e) => e.date)).size, delta: mean(ev.map((e) => e.pnl)), ci: ci(ev, `pbe|${X}`), h1: mean(sorted.slice(0, mid).map((e) => e.pnl)), h2: mean(sorted.slice(mid).map((e) => e.pnl)) };
    const saved = ev.filter((e) => e.plain < 0 && e.be > e.plain), clipped = ev.filter((e) => e.plain > 0 && e.be < e.plain);
    head.saved = { n: saved.length, d: sum(saved.map((e) => e.pnl)) }; head.clipped = { n: clipped.length, d: sum(clipped.map((e) => e.pnl)) };
    // placebo
    const pl = [];
    for (let k = 0; k < PLACEBO_DRAWS; k++) {
      const rand = mulberry32(hashSeed(`pbe-placebo|${X}|${k}`)); let s = 0;
      for (const t of trades) { const flip = rand() < 0.5; s += P(t, X, flip) - P(t, null, flip); }
      pl.push(s / trades.length);
    }
    head.placeboMax = Math.max(...pl); head.placeboMed = median(pl);
    const split = (label, f) => { const a = ev.filter(f); if (a.length < 20) return null; const c = ci(a, `pbe|${X}|${label}`); return { label, n: a.length, delta: mean(a.map((e) => e.pnl)), lo: c.lo, hi: c.hi }; };
    head.splits = [split('RTH', (e) => e.isRth), split('GLOBEX', (e) => !e.isRth), split('level-anchored', (e) => e.anchored), split('calibrated exit', (e) => !e.anchored)].filter(Boolean);
    const byType = new Map(); for (const e of ev) byType.set(e.type, [...(byType.get(e.type) || []), e]);
    head.types = [...byType].filter(([, a]) => a.length >= 20).map(([t, a]) => ({ t, n: a.length, delta: mean(a.map((e) => e.pnl)) })).sort((a, b) => a.delta - b.delta);
    head.verdict = head.ci.lo > 0 && head.h1 > 0 && head.h2 > 0 && head.delta > head.placeboMax ? 'HELPS' : head.ci.hi < 0 && head.h1 < 0 && head.h2 < 0 ? 'HURTS' : 'NOT SHOWN';
    summary[X] = head;
    console.log(`\nBE at ${X * 100}% of the way: n=${head.n} days=${head.days} delta ${money(head.delta)}/trade CI [${money(head.ci.lo)}, ${money(head.ci.hi)}] halves ${money(head.h1)} / ${money(head.h2)} | placebo median ${money(head.placeboMed)} max ${money(head.placeboMax)} | VERDICT ${head.verdict}`);
    console.log(`  saved from stop-outs: ${head.saved.n} trades ${money(head.saved.d)}; winners scratched: ${head.clipped.n} trades ${money(head.clipped.d)}`);
    for (const s of head.splits) console.log(`  ${s.label.padEnd(16)} n=${s.n} delta ${money(s.delta)} [${money(s.lo)}, ${money(s.hi)}]`);
    const neg = head.types.slice(0, 3), pos = head.types.slice(-3).reverse();
    console.log('  worst types:', neg.map((x) => `${x.t} ${money(x.delta)} (n${x.n})`).join('; '), '| best:', pos.map((x) => `${x.t} ${money(x.delta)} (n${x.n})`).join('; '));
    const signs = new Set(head.types.map((x) => Math.sign(x.delta))); if (signs.size > 1) console.log(`  opposite-signed setup types present (${head.types.filter((x) => x.delta > 0).length} up / ${head.types.filter((x) => x.delta < 0).length} down of ${head.types.length})`);
  }
  if (!noRecord) {
    const best = XS.map((X) => summary[X]);
    const txt = `Progress-triggered breakeven (prereg docs/PROGRESS_BREAKEVEN_PREREG_20261026.md), plain stop/target trades, realistic fills (stop effective from the bar after arming, market exit if already beyond entry, gap fills at the open). ${best[0].n} trades over ${best[0].days} days; PLAIN replay matches stored outcomes on ${par.filter((g) => g <= 1).length}/${par.length} clean exits. ` +
      XS.map((X, i) => `BE at ${X * 100}% progress: ${money(best[i].delta)}/trade, 95% CI [${money(best[i].ci.lo)}, ${money(best[i].ci.hi)}], halves ${money(best[i].h1)}/${money(best[i].h2)}, placebo max ${money(best[i].placeboMax)}, saved ${best[i].saved.n} stop-outs (${money(best[i].saved.d)}) vs scratched ${best[i].clipped.n} winners (${money(best[i].clipped.d)}), verdict ${best[i].verdict}`).join('; ') + '.';
    await recordClaim({ slug: 'progress_breakeven_realistic_fills_20261026', claimText: txt, sourceFile: 'scripts/audit_progress_breakeven_20261026.mjs', sourceDate: '2026-10-26', sampleSize: best[0].n, evPerTrade: best[1].delta, rigorStatus: 'day_blocked_bootstrap_placebo_realistic_fills', status: 'PROVISIONAL' });
    console.log('\nclaim recorded');
  }
}
if (import.meta.url === `file://${process.argv[1]}`) main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
