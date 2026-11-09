// Replay of the flat 45pt stop / 90pt target fallback (server/routes/acd.js detectGlobexSetup, `flatStop`/`flatTarget`) that 82% of
// overnight level-fade rows use because their setup_type has no OPTIMAL_STOP row of its own (update_optimal_stops.mjs needs N>=20).
// QUESTION: what would the SAME touches have earned with the system's existing volatility-scaled default (getVolatilityScaledDefault,
// the RTH precedent) instead of the flat literal? One counted test: paired per-row difference (vol-default minus flat), day-blocked CI.
// Method: walk 1-minute NQ bars from the fire minute to expires_at (09:30 ET); stop checked before target on a shared bar (conservative);
// no hit = mark to market at the last bar's close; P&L = points * $2 - $2 (server/config/instruments.js). Entry = price_at_detection for both
// arms. VALIDATION FIRST (hr-047): the flat arm replayed here must reproduce the stored actual_pnl before the other arm is trusted.
// Explore only (SHADOW+ACTIVE since 2026-09-01); nothing here changes anything live.
import { query } from '../server/db.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import { getVolatilityScaledDefault } from '../server/services/acdLiveCalibration.js';
import { dayBlockedBootstrapCI } from '../server/services/rigorDiagnostics.js';
import { logLook } from './lib/look_ledger.mjs';

const DPP = LIVE_INSTRUMENT.dollarsPerPoint, COMM = LIVE_INSTRUMENT.commissionPerRoundTrip;
const FLAT = { stop: 45, target: 90 };
const WINDOW = '2026-09-01..2026-11-09 (SHADOW+ACTIVE, cluster primaries)';

function walk(bars, entry, dir, stop, target) {
  for (const b of bars) {
    const hitStop = dir === 1 ? b.low <= entry - stop : b.high >= entry + stop;
    if (hitStop) return { pts: -stop, how: 'STOP' };
    const hitTgt = dir === 1 ? b.high >= entry + target : b.low <= entry - target;
    if (hitTgt) return { pts: target, how: 'TARGET' };
  }
  const last = bars[bars.length - 1];
  return { pts: (last.close - entry) * dir, how: 'MTM' };
}
const dollars = (pts) => pts * DPP - COMM;

async function main() {
  const vol = await getVolatilityScaledDefault('2026-11-09');
  if (!vol) throw new Error('volatility-scaled default unavailable');
  const rows = (await query(`
    SELECT id, trade_date::text AS d, setup_type, fired_at::text AS fired_at, expires_at::text AS expires_at,
           price_at_detection::float AS entry, stop_level::float AS stop_level, t1_level::float AS t1_level, actual_pnl::float AS actual_pnl
    FROM active_setups
    WHERE setup_type LIKE '%\\_OVERNIGHT' AND origin_status IN ('ACTIVE','SHADOW') AND is_cluster_primary
      AND status = 'RESOLVED' AND actual_pnl IS NOT NULL AND fired_at >= '2026-09-01'
      AND ABS(ABS(price_at_detection - stop_level) - $1) < 0.01 AND ABS(ABS(t1_level - price_at_detection) - $2) < 0.01
    ORDER BY fired_at`, [FLAT.stop, FLAT.target])).rows;

  const events = [];
  let skipped = 0;
  for (const r of rows) {
    const dir = r.setup_type.includes('_LONG') ? 1 : -1;
    const bars = (await query(`
      SELECT high::float AS high, low::float AS low, close::float AS close FROM price_bars_primary
      WHERE symbol = 'NQ' AND ts >= date_trunc('minute', $1::timestamp) AND ts < $2::timestamp ORDER BY ts`, [r.fired_at, r.expires_at])).rows;
    if (!bars.length) { skipped++; continue; }
    const a = walk(bars, r.entry, dir, FLAT.stop, FLAT.target);
    const b = walk(bars, r.entry, dir, vol.stop, vol.target);
    events.push({ id: r.id, date: r.d, type: r.setup_type, stored: r.actual_pnl, flat: dollars(a.pts), flatHow: a.how, vol: dollars(b.pts), volHow: b.how });
  }

  // validation of the replay against the stored outcomes
  const close = events.filter((e) => Math.abs(e.flat - e.stored) <= 4).length;
  const diffs = events.map((e) => ({ date: e.date, pnl: e.vol - e.flat }));
  const ci = dayBlockedBootstrapCI(diffs, 'overnight_flat_fallback_20261109');
  const mean = (xs) => xs.reduce((s, x) => s + x, 0) / (xs.length || 1);
  const how = (k) => events.reduce((m, e) => { m[e[k]] = (m[e[k]] || 0) + 1; return m; }, {});

  // ledger look BEFORE any number is printed (hr-023)
  await logLook({ family: 'overnight_flat_fallback', dataWindow: WINDOW, kind: 'EXPLORE', tests: 1,
    label: 'flat 45/90 vs volatility-scaled default on overnight level fades', script: 'scripts/replay_overnight_flat_fallback_20261109.mjs',
    ref: 'overnight_flat_fallback_20261109', notes: { n: events.length, volDefault: vol } });

  const days = new Set(events.map((e) => e.date)).size;
  console.log(`rows replayed ${events.length} (skipped ${skipped}) over ${days} days; vol default stop ${vol.stop} / target ${vol.target}`);
  console.log(`VALIDATION: flat replay within $4 of stored actual_pnl on ${close}/${events.length} rows (${(100 * close / events.length).toFixed(1)}%)`);
  console.log(`flat    : sum $${events.reduce((s, e) => s + e.flat, 0).toFixed(0)}  mean $${mean(events.map((e) => e.flat)).toFixed(2)}  win ${(100 * events.filter((e) => e.flat > 0).length / events.length).toFixed(1)}%  exits ${JSON.stringify(how('flatHow'))}`);
  console.log(`vol dflt: sum $${events.reduce((s, e) => s + e.vol, 0).toFixed(0)}  mean $${mean(events.map((e) => e.vol)).toFixed(2)}  win ${(100 * events.filter((e) => e.vol > 0).length / events.length).toFixed(1)}%  exits ${JSON.stringify(how('volHow'))}`);
  console.log(`paired (vol - flat) mean $${mean(diffs.map((x) => x.pnl)).toFixed(2)} per row; day-blocked CI ${JSON.stringify(ci)}`);
  const bySide = {};
  for (const e of events) { const s = e.type.includes('_LONG') ? 'LONG' : 'SHORT'; (bySide[s] ||= []).push(e.vol - e.flat); }
  for (const [s, v] of Object.entries(bySide)) console.log(`  ${s}: n=${v.length} paired mean $${mean(v).toFixed(2)}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
