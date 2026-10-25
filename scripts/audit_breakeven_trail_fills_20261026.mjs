// Breakeven-then-trail realistic-fill audit. Prereg (committed first): docs/BREAKEVEN_STOP_FILL_AUDIT_PREREG_20261026.md, Addendum B.
//   node scripts/audit_breakeven_trail_fills_20261026.mjs [--no-record]
import { query } from '../server/db.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import { resolveDirection } from '../server/config/setupTypes.js';
import { isInsideNqRollWeek } from '../server/services/acdShared.js';
import { dayBlockedBootstrapCI } from '../server/services/rigorDiagnostics.js';
import { stepBreakevenTrail } from '../server/services/breakevenTrailWalker.js';
import { recordClaim } from './record_claim.mjs';

const PPT = LIVE_INSTRUMENT.dollarsPerPoint, COMM = LIVE_INSTRUMENT.commissionPerRoundTrip;
const sum = (a) => a.reduce((s, x) => s + x, 0), mean = (a) => (a.length ? sum(a) / a.length : null);
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const money = (v) => (v == null ? 'n/a' : `${v < 0 ? '-' : '+'}$${Math.abs(v).toFixed(2)}`);
const pnl = (px, entry, long) => (long ? px - entry : entry - px) * PPT - COMM;
const modOf = (ts) => { const m = ts.match(/(\d{2}):(\d{2}):/); return +m[1] * 60 + +m[2]; };
const fillStop = (long, level, open) => (long ? Math.min(level, open) : Math.max(level, open));

async function main() {
  const noRecord = process.argv.includes('--no-record');
  const rows = (await query(`SELECT id, setup_type, trade_date::text d, fired_at::text fa, COALESCE(resolved_at, expires_at)::text endts, is_rth, entry_zone_low::float elo, entry_zone_high::float ehi, stop_level::float stop, t1_level::float t1,
      runner_trail_width::float tw, actual_pnl::float actual FROM active_setups
    WHERE runner_trail_width IS NOT NULL AND breakeven_armed_at IS NOT NULL AND actual_pnl IS NOT NULL AND origin_status IN ('ACTIVE','SHADOW') AND is_cluster_primary IS NOT FALSE
      AND ib_window_stale_basis IS NOT TRUE AND stale_entry_price_basis IS NOT TRUE AND late_fill_past_expiry_basis IS NOT TRUE AND bad_bars_basis IS NOT TRUE ORDER BY id`)).rows.filter((r) => !isInsideNqRollWeek(r.d));
  const out = []; let unusable = 0;
  for (const r of rows) {
    const dir = resolveDirection({ setup_type: r.setup_type, entry_zone_low: r.elo, entry_zone_high: r.ehi, stop_level: r.stop, t1_level: r.t1 });
    if (dir === null) { unusable++; continue; }
    const long = dir === 'LONG', entry = r.ehi ?? r.elo, firedMod = modOf(r.fa);
    const bars = (await query(`SELECT ts::text ts, open::float open, high::float high, low::float low, close::float close FROM price_bars_primary
      WHERE symbol='NQ' AND ts > $1::timestamp AND ts <= ($2::timestamp + interval '10 minutes') ORDER BY ts`, [r.fa, r.endts])).rows.map((b) => ({ ...b, mod: modOf(b.ts) }));
    const p = { entry, stop: r.stop, t1: r.t1, trailWidth: r.tw, long, firedMod };
    // UNADJUSTED and REALISTIC walks
    let st = {}, un = null, tTouch = null;
    for (const b of bars) { const s = stepBreakevenTrail(st, b, p); st = s.state; if (s.resolution) { un = pnl(s.resolution.priceAtRes, entry, long); break; } }
    st = {}; let re = null, i = 0;
    for (; i < bars.length; i++) {
      const b = bars[i];
      if (st.armedAt == null) {
        const s = stepBreakevenTrail(st, b, p);
        if (s.resolution && s.resolution.method === 'SAME_BAR_ARM_STOP') {
          // realistic: the stop cannot exist before this bar closes; keep the armed state and apply the touch-bar-close check
          st = s.state; tTouch = b.ts;
          const rev = long ? b.close < st.trailStopPrice : b.close > st.trailStopPrice;
          if (rev) { re = pnl(bars[i + 1] ? bars[i + 1].open : b.close, entry, long); break; }
          continue;
        }
        const wasUnarmed = st.armedAt == null; st = s.state;
        if (wasUnarmed && st.armedAt != null) {
          tTouch = b.ts;
          const rev = long ? b.close < st.trailStopPrice : b.close > st.trailStopPrice;
          if (rev) { re = pnl(bars[i + 1] ? bars[i + 1].open : b.close, entry, long); break; }
        }
        if (s.resolution) { re = pnl(s.resolution.priceAtRes, entry, long); break; }
      } else {
        const s = stepBreakevenTrail(st, b, p);
        const stopBefore = st.trailStopPrice; st = s.state;
        if (s.resolution) { re = pnl(s.resolution.method === 'BREAKEVEN_TRAIL_HIT' ? fillStop(long, stopBefore > 0 ? s.resolution.priceAtRes : stopBefore, b.open) : s.resolution.priceAtRes, entry, long); break; }
      }
    }
    if (un == null || re == null || tTouch == null) { unusable++; continue; }
    out.push({ id: r.id, date: r.d, isRth: r.is_rth === true, base: pnl(r.t1, entry, long), booked: r.actual, un, re });
  }
  console.log(`armed rows ${rows.length}; replayed ${out.length}; unusable ${unusable}`);
  const gaps = out.map((x) => Math.abs(x.un - x.booked));
  console.log(`parity (UNADJUSTED vs stored actual_pnl): within $1 ${gaps.filter((g) => g <= 1).length}/${out.length}, median abs gap ${median(gaps)?.toFixed(2)}`);
  const ci = (arr, key, seed) => (arr.length >= 4 ? dayBlockedBootstrapCI(arr.map((x) => ({ date: x.date, pnl: key(x) })), seed, { iters: 3000 }) : { lo: null, hi: null });
  const rep = (label, arr) => {
    const sorted = [...arr].sort((a, b) => (a.date < b.date ? -1 : 1)), mid = sorted.length >> 1;
    const o = { label, n: arr.length, days: new Set(arr.map((x) => x.date)).size, base: mean(arr.map((x) => x.base)), dUn: mean(arr.map((x) => x.un - x.base)), ciUn: ci(arr, (x) => x.un - x.base, `${label}|un`),
      dRe: mean(arr.map((x) => x.re - x.base)), ciRe: ci(arr, (x) => x.re - x.base, `${label}|re`), h1: mean(sorted.slice(0, mid).map((x) => x.re - x.base)), h2: mean(sorted.slice(mid).map((x) => x.re - x.base)) };
    console.log(`${label.padEnd(10)} n=${o.n} days=${o.days} banked ${money(o.base)} | UNADJUSTED d ${money(o.dUn)} [${money(o.ciUn.lo)},${money(o.ciUn.hi)}] | REALISTIC d ${money(o.dRe)} [${money(o.ciRe.lo)},${money(o.ciRe.hi)}] halves ${money(o.h1)} / ${money(o.h2)}`);
    return o;
  };
  const h = rep('ALL', out); rep('RTH', out.filter((x) => x.isRth)); rep('GLOBEX', out.filter((x) => !x.isRth));
  const v = h.ciRe.lo > 0 && h.h1 > 0 && h.h2 > 0 ? 'HELPS' : h.ciRe.hi < 0 && h.h1 < 0 && h.h2 < 0 ? 'HURTS' : 'NOT SHOWN';
  console.log(`VERDICT (frozen rule): ${v}`);
  if (!noRecord) {
    await recordClaim({ slug: 'breakeven_trail_realistic_fill_audit_20261026', sourceFile: 'scripts/audit_breakeven_trail_fills_20261026.mjs', sourceDate: '2026-10-26', sampleSize: h.n, evPerTrade: h.dRe, rigorStatus: 'day_blocked_bootstrap_realistic_fills', status: 'PROVISIONAL',
      claimText: `Breakeven-then-trail realistic-fill audit (prereg Addendum B). ${h.n} armed trades over ${h.days} days, all PD_POC_FADE_SHORT family (underpowered, family-specific). Banked-at-T1 baseline ${money(h.base)}/trade. Walker as written minus banked ${money(h.dUn)} [${money(h.ciUn.lo)}, ${money(h.ciUn.hi)}]; realistic fills (stop effective from the bar after the touch bar, gap fills at the open, no same-bar stop-out) ${money(h.dRe)} [${money(h.ciRe.lo)}, ${money(h.ciRe.hi)}], halves ${money(h.h1)} / ${money(h.h2)}. Parity vs stored actual_pnl: ${gaps.filter((g) => g <= 1).length}/${out.length} within $1. VERDICT under the frozen rule: ${v}.` });
    console.log('claim recorded');
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
