// Composition test (2026-10-06): does moving the stop to ENTRY once T1 is touched improve trades
// that carry a wider target (1.5x T1 distance)? Two arms, same real bars, same fill rule:
//   A (live today): stop stays at its stored level; target = entry +/- wm x |T1 - entry|.
//   B (proposed):   identical, but once a bar reaches T1 the stop moves to entry.
// Stop is checked before target within a bar (conservative). Unresolved trades mark to the last bar.
// Delta = B - A per trade, summed per day, day-blocked bootstrap CI, plus a random-direction placebo.
// Run: node scripts/backtest_breakeven_after_t1_widertarget_20261006.mjs
import fs from 'fs';
import { query } from '../server/db.js';
import { resolveDirection } from '../server/config/setupTypes.js';

const PNL_PER_POINT = 2, COMMISSION_RT = 2, N_BOOT = 5000, PLACEBO_DRAWS = Number(process.env.PLACEBO_DRAWS || 30);
let seed = 20261006;
const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

const popSql = `
  SELECT id, setup_type, trade_date::text AS trade_date, fired_at::text AS fired_at, expires_at::text AS expires_at,
    entry_zone_low::float AS elo, entry_zone_high::float AS ehi, stop_level::float AS stop_level, t1_level::float AS t1_level,
    wider_target_mult::float AS wm, actual_pnl::float AS actual_pnl
  FROM active_setups
  WHERE origin_status IN ('ACTIVE','SHADOW') AND status='RESOLVED' AND actual_pnl IS NOT NULL
    AND wider_target_mult IS NOT NULL AND stop_level IS NOT NULL AND t1_level IS NOT NULL AND expires_at IS NOT NULL
    AND (entry_zone_high IS NOT NULL OR entry_zone_low IS NOT NULL) AND bad_bars_basis IS NOT TRUE
    AND (resolution_method IS NULL OR resolution_method NOT IN ('MARK_TO_MARKET','RECOVERY_MTM'))
  ORDER BY fired_at, id`;
const rows = (await query(popSql)).rows;
const trades = [];
for (const r of rows) {
  const dir = resolveDirection(r);
  const entry = r.ehi ?? r.elo;
  if (!dir || entry == null) continue;
  trades.push({ ...r, long: dir === 'LONG', entry });
}
console.log(`population (wider-target trades): ${rows.length}; scorable ${trades.length}`);

async function barsFor(t) {
  const r = await query(`SELECT ts::text AS ts, high::float AS h, low::float AS l, close::float AS c FROM price_bars_primary
    WHERE symbol='NQ' AND ts >= date_trunc('minute', $1::timestamp) AND ts <= $2::timestamp ORDER BY ts`, [t.fired_at, t.expires_at]);
  return r.rows;
}
const pnlOf = (long, entry, px) => ((long ? px - entry : entry - px) * PNL_PER_POINT) - COMMISSION_RT;

// One walk. useBE=false -> arm A, useBE=true -> arm B. Returns { pnl, beArmed }.
function walk(bars, t, useBE) {
  const { long, entry } = t;
  const dist = Math.abs(t.t1_level - entry) * t.wm;
  const tgt = long ? entry + dist : entry - dist;
  let stop = t.stop_level, t1Hit = false, beArmed = false, filled = false;
  for (const b of bars) {
    if (!filled) {
      if (long ? b.l <= entry : b.h >= entry) filled = true; else continue;
    }
    // stop first (conservative) on this bar
    const stopHit = long ? b.l <= stop : b.h >= stop;
    if (stopHit) return { pnl: pnlOf(long, entry, stop), beArmed };
    const tgtHit = long ? b.h >= tgt : b.l <= tgt;
    if (tgtHit) return { pnl: pnlOf(long, entry, tgt), beArmed };
    if (useBE && !t1Hit && (long ? b.h >= t.t1_level : b.l <= t.t1_level)) {
      t1Hit = true;
      // Only move the stop to entry if it is an improvement (never loosens the stop).
      const improve = long ? entry > stop : entry < stop;
      if (improve) { stop = entry; beArmed = true; }
    }
  }
  if (!filled) return { pnl: null, beArmed };
  return { pnl: pnlOf(long, entry, bars.at(-1).c), beArmed };
}

const perTrade = [];
let noBars = 0;
for (const t of trades) {
  const bars = await barsFor(t);
  if (!bars.length) { noBars++; continue; }
  const a = walk(bars, t, false), b = walk(bars, t, true);
  if (a.pnl == null) continue;
  perTrade.push({ id: t.id, day: t.trade_date, setup: t.setup_type, long: t.long, bars, t, A: a.pnl, B: b.pnl, beArmed: b.beArmed });
}
console.log(`scored ${perTrade.length} (no bars ${noBars}); breakeven actually armed in ${perTrade.filter(x => x.beArmed).length}`);

function summarize(list, label) {
  const deltaByDay = new Map();
  for (const x of list) {
    if (x.B == null) continue;
    deltaByDay.set(x.day, (deltaByDay.get(x.day) || 0) + (x.B - x.A));
  }
  const days = [...deltaByDay.values()];
  const n = list.filter(x => x.B != null).length;
  const meanDelta = list.reduce((s, x) => s + ((x.B ?? x.A) - x.A), 0) / Math.max(n, 1);
  const boots = [];
  for (let i = 0; i < N_BOOT; i++) { let s = 0; for (let j = 0; j < days.length; j++) s += days[Math.floor(rand() * days.length)]; boots.push(s / Math.max(days.length, 1)); }
  boots.sort((p, q) => p - q);
  const ci = [boots[Math.floor(0.025 * N_BOOT)], boots[Math.floor(0.975 * N_BOOT)]];
  return { label, trades: n, distinctDays: days.length, meanDeltaPerTrade: +meanDelta.toFixed(2), ci95Day: [+ci[0].toFixed(2), +ci[1].toFixed(2)], ciExcludesZero: ci[0] > 0 || ci[1] < 0 };
}

const real = summarize(perTrade, 'REAL direction');
console.log(real);

// Placebo: random direction for each trade, both arms recomputed under the flipped direction.
const placeboMeans = [];
for (let d = 1; d <= PLACEBO_DRAWS; d++) {
  let ps = d * 7919;
  const flipped = perTrade.map(x => {
    ps = (ps * 1664525 + 1013904223) >>> 0;
    const long = ps / 4294967296 < 0.5 ? !x.long : x.long;
    const tt = { ...x.t, long, entry: x.t.entry };
    const a = walk(x.bars, tt, false), b = walk(x.bars, tt, true);
    return { day: x.day, A: a.pnl, B: b.pnl };
  }).filter(x => x.A != null);
  placeboMeans.push(summarize(flipped.map(f => ({ ...f, setup: '' })), `placebo ${d}`).meanDeltaPerTrade);
}
placeboMeans.sort((p, q) => p - q);
const pMedian = placeboMeans[Math.floor(placeboMeans.length / 2)];
const share = placeboMeans.filter(v => v >= real.meanDeltaPerTrade).length / placeboMeans.length;
console.log(`placebo (${PLACEBO_DRAWS} draws): median mean delta ${pMedian}, real ${real.meanDeltaPerTrade}, share of placebo >= real: ${share.toFixed(3)}`);

fs.writeFileSync(new URL('../scratch/breakeven_after_t1_widertarget_20261006.json', import.meta.url), JSON.stringify({ real, pMedian, share, placeboMeans }, null, 2));
process.exit(0);
