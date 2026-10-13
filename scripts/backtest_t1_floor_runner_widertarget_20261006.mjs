// Test of the T1-floor runner on the same population as the breakeven composition test
// (2026-10-06). Uses the LIVE walker (server/services/t1FloorRunnerWalker.js stepT1FloorRunner,
// t1FloorPnlFromResolution) rather than a copy. Two arms on the same real bars:
//   A (live today):    stop at its stored level; target = entry +/- wm x |T1 - entry|.
//   C (T1-floor):      identical until a bar reaches T1; from then on T1 is a banked floor
//                      (stop snaps to T1) and the runner rides toward the wider target.
// Stop is checked before T1 within a bar. Delta = C - A, day-blocked bootstrap, random-direction placebo.
// Run: node scripts/backtest_t1_floor_runner_widertarget_20261006.mjs
import fs from 'fs';
import { query } from '../server/db.js';
import { resolveDirection } from '../server/config/setupTypes.js';
import { stepT1FloorRunner, t1FloorPnlFromResolution } from '../server/services/t1FloorRunnerWalker.js';

const SLIP = Number(process.env.SLIP_POINTS || 0);
const FRAC = Number(process.env.FRAC || 1); // floor = entry + FRAC x (T1 - entry); 1 = T1 floor, 0.25 = 25% of the way (2026-10-06) // points a stop/floor fill is worse than its price (2026-10-06)
const DOLLARS_PER_POINT = 2, COMMISSION = 2, N_BOOT = 5000, PLACEBO_DRAWS = Number(process.env.PLACEBO_DRAWS || 30);
let seed = 20261006;
const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

const rows = (await query(`
  SELECT id, setup_type, trade_date::text AS trade_date, fired_at::text AS fired_at, expires_at::text AS expires_at,
    entry_zone_low::float AS elo, entry_zone_high::float AS ehi, stop_level::float AS stop_level, t1_level::float AS t1_level,
    wider_target_mult::float AS wm
  FROM active_setups
  WHERE origin_status IN ('ACTIVE','SHADOW') AND status='RESOLVED' AND actual_pnl IS NOT NULL
    AND wider_target_mult IS NOT NULL AND stop_level IS NOT NULL AND t1_level IS NOT NULL AND expires_at IS NOT NULL
    AND (entry_zone_high IS NOT NULL OR entry_zone_low IS NOT NULL) AND bad_bars_basis IS NOT TRUE
    AND (resolution_method IS NULL OR resolution_method NOT IN ('MARK_TO_MARKET','RECOVERY_MTM'))
  ORDER BY fired_at, id`)).rows.filter(r => !process.env.SETUP_ONLY || r.setup_type === process.env.SETUP_ONLY);
const trades = [];
for (const r of rows) {
  const dir = resolveDirection(r);
  const entry = r.ehi ?? r.elo;
  if (!dir || entry == null) continue;
  trades.push({ ...r, long: dir === 'LONG', entry });
}
console.log(`population: ${rows.length}; scorable ${trades.length}`);

async function barsFor(t) {
  const r = await query(`SELECT ts::text AS ts, high::float AS h, low::float AS l, close::float AS c FROM price_bars_primary
    WHERE symbol='NQ' AND ts >= date_trunc('minute', $1::timestamp) AND ts <= $2::timestamp ORDER BY ts`, [t.fired_at, t.expires_at]);
  return r.rows.map(b => { const m = b.ts.match(/(\d{2}):(\d{2})/); return { ...b, mod: (+m[1]) * 60 + (+m[2]) }; });
}
const firedModOf = t => { const m = t.fired_at.match(/(\d{2}):(\d{2})/); return (+m[1]) * 60 + (+m[2]); };
const rawPnl = (long, entry, px) => ((long ? px - entry : entry - px) * DOLLARS_PER_POINT) - COMMISSION;

// Arm A: stop/target only (today's exit).
function walkA(bars, t) {
  const { long, entry } = t;
  const tgt = long ? entry + Math.abs(t.t1_level - entry) * t.wm : entry - Math.abs(t.t1_level - entry) * t.wm;
  let filled = false;
  for (const b of bars) {
    if (!filled) { if (long ? b.l <= entry : b.h >= entry) filled = true; else continue; }
    if (long ? b.l <= t.stop_level : b.h >= t.stop_level) return rawPnl(long, entry, t.stop_level - (long ? SLIP : -SLIP));
    if (long ? b.h >= tgt : b.l <= tgt) return rawPnl(long, entry, tgt);
  }
  return filled ? rawPnl(long, entry, bars.at(-1).c) : null;
}

// Arm C: stop until T1, then the LIVE T1-floor runner walker.
function walkC(bars, t) {
  const { long, entry } = t;
  const ft = long ? entry + Math.abs(t.t1_level - entry) * t.wm : entry - Math.abs(t.t1_level - entry) * t.wm;
  const firedMod = firedModOf(t);
  const floorPx = long ? entry + FRAC * (t.t1_level - entry) : entry - FRAC * (entry - t.t1_level);
  let filled = false, runnerOn = false, state = {};
  for (const b of bars) {
    if (!filled) { if (long ? b.l <= entry : b.h >= entry) filled = true; else continue; }
    if (!runnerOn) {
      if (long ? b.l <= t.stop_level : b.h >= t.stop_level) return rawPnl(long, entry, t.stop_level - (long ? SLIP : -SLIP));
      if (long ? b.h >= t.t1_level : b.l <= t.t1_level) { runnerOn = true; } // T1 reached: floor banks, runner starts next bar
      continue;
    }
    const { resolution } = stepT1FloorRunner(state, { high: b.h, low: b.l, close: b.c, mod: b.mod }, { t1: floorPx, ft, long, firedMod });
    if (resolution && resolution.method === 'T1_FLOOR_HIT') resolution.priceAtRes = floorPx - (long ? SLIP : -SLIP);
    if (resolution) return t1FloorPnlFromResolution(resolution, { entry, t1: floorPx, long, dollarsPerPoint: DOLLARS_PER_POINT, commission: COMMISSION });
  }
  if (!filled) return null;
  if (runnerOn) return t1FloorPnlFromResolution({ resolution: 'TIME_EXPIRED', method: 'T1_FLOOR_MARK_TO_MARKET', priceAtRes: bars.at(-1).c }, { entry, t1: floorPx, long, dollarsPerPoint: DOLLARS_PER_POINT, commission: COMMISSION });
  return rawPnl(long, entry, bars.at(-1).c);
}

const perTrade = [];
for (const t of trades) {
  const bars = await barsFor(t);
  if (!bars.length) continue;
  const A = walkA(bars, t), C = walkC(bars, t);
  if (A == null || C == null) continue;
  perTrade.push({ day: t.trade_date, bars, t, A, C });
}
console.log(`scored ${perTrade.length}`);

function summarize(list) {
  const byDay = new Map();
  for (const x of list) byDay.set(x.day, (byDay.get(x.day) || 0) + (x.C - x.A));
  const days = [...byDay.values()];
  const mean = list.reduce((s, x) => s + (x.C - x.A), 0) / Math.max(list.length, 1);
  const boots = [];
  for (let i = 0; i < N_BOOT; i++) { let s = 0; for (let j = 0; j < days.length; j++) s += days[Math.floor(rand() * days.length)]; boots.push(s / Math.max(days.length, 1)); }
  boots.sort((p, q) => p - q);
  return { trades: list.length, distinctDays: days.length, meanDeltaPerTrade: +mean.toFixed(2), ci95Day: [+boots[Math.floor(0.025 * N_BOOT)].toFixed(2), +boots[Math.floor(0.975 * N_BOOT)].toFixed(2)] };
}
const real = summarize(perTrade);
console.log(`frac ${FRAC} slippage ${SLIP} pt: REAL direction:`, real);
const placebo = [];
for (let d = 1; d <= PLACEBO_DRAWS; d++) {
  let ps = d * 7919;
  const flipped = perTrade.map(x => {
    ps = (ps * 1664525 + 1013904223) >>> 0;
    const long = ps / 4294967296 < 0.5 ? !x.t.long : x.t.long;
    const tt = { ...x.t, long };
    const A = walkA(x.bars, tt), C = walkC(x.bars, tt);
    return A == null || C == null ? null : { day: x.day, A, C };
  }).filter(Boolean);
  placebo.push(summarize(flipped).meanDeltaPerTrade);
}
placebo.sort((p, q) => p - q);
const share = placebo.filter(v => v >= real.meanDeltaPerTrade).length / placebo.length;
console.log(`placebo (${PLACEBO_DRAWS} draws): median ${placebo[Math.floor(placebo.length / 2)]}, real ${real.meanDeltaPerTrade}, share of placebo >= real: ${share.toFixed(3)}`);
fs.writeFileSync(new URL(`../scratch/t1_floor_runner_widertarget_20261006_frac${FRAC}_slip${SLIP}${process.env.SETUP_ONLY ? '_' + process.env.SETUP_ONLY : ''}.json`, import.meta.url), JSON.stringify({ slipPoints: SLIP, real, placebo, share }, null, 2));
process.exit(0);
