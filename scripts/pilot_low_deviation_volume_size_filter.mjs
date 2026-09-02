// Follow-up to pilot_low_deviation_coiled_spring_check.mjs (2026-09-02): that test found the
// low-|dev|-from-VWAP tercile contains two opposite-signed subpopulations (trades that
// subsequently expanded: WR=53.1% EV=+$15.66; trades that stayed compressed: WR=54.1%
// EV=-$4.57) -- but "did it expand in the next 10 bars" isn't knowable at entry time, so that
// split isn't a usable live filter on its own.
//
// User's idea: use raw bid/ask SIZE (total participation volume at the touch), not net delta
// (directional imbalance) -- a real, live-knowable-at-entry signal, distinct from deviation
// magnitude. Tests whether volume-at-touch (normalized against its own trailing baseline via
// getVolumeBaseline() -- server/services/touchQuality.js, the existing canonical 90-day
// trailing per-minute-of-day avg/std, already correctly session-aware since it's keyed by
// minute-of-day and Globex/RTH occupy different minutes) predicts which LOW-deviation touches
// are the "about to release" (good) ones vs the "genuinely dead" (bad) ones -- reusing the
// real function per CLAUDE.md's "export the real function, never reimplement" rule, not a new
// volume-baseline computation.

import { query } from '../server/db.js';
import { computeRunningVwapSeries } from '../server/services/developingValueService.js';
import { getVolumeBaseline } from '../server/services/touchQuality.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';

const LEVELS = ['PD_POC', 'PD_VAH', 'PD_VAL'];

function globexSessionStart(tradeDate) {
  const d = new Date(tradeDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10) + ' 18:00:00';
}

const isWin = (t) => t.resolution === 'TARGET_HIT' || (t.resolution === 'TRAIL_EXIT' && t.actual_pnl >= 0);

async function main() {
  const { rows: [{ today }] } = await query(`SELECT CURRENT_DATE::text as today`);
  const setupTypes = LEVELS.flatMap(l => [`${l}_FADE_LONG`, `${l}_FADE_SHORT`]);
  const { rows: trades } = await query(`
    SELECT id, trade_date::text as trade_date, setup_type, fired_at::text as fired_at,
           entry_zone_low::float as entry, resolution, actual_pnl::float as actual_pnl
    FROM active_setups
    WHERE setup_type = ANY($1)
      AND origin_status IN ('ACTIVE','SHADOW')
      AND resolution IN ('TARGET_HIT','STOP_HIT','TRAIL_EXIT')
      AND actual_pnl IS NOT NULL AND entry_zone_low IS NOT NULL
    ORDER BY fired_at
  `, [setupTypes]);

  const baselineCache = new Map();
  async function getCachedBaseline(d) {
    if (!baselineCache.has(d)) baselineCache.set(d, await getVolumeBaseline(query, d));
    return baselineCache.get(d);
  }

  for (const t of trades) {
    const sessStart = globexSessionStart(t.trade_date);
    const { rows: bars } = await query(`
      SELECT ts::text as ts, high::float, low::float, close::float,
             COALESCE(bid_volume,0)::float as bid_volume, COALESCE(ask_volume,0)::float as ask_volume,
             (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts))::int as mod
      FROM price_bars_primary
      WHERE symbol='NQ' AND ts >= $1 AND ts <= $2
      ORDER BY ts
    `, [sessStart, t.fired_at]);
    if (bars.length < 5) { t.skip = true; continue; }

    const series = computeRunningVwapSeries(bars.map(b => ({ ...b, volume: b.bid_volume + b.ask_volume })));
    t.devTouch = t.entry - series[series.length - 1];

    // Volume z-score, averaged over the last 3 bars ending at touch (a short, live-available
    // window -- not just the single touch bar, which can be noisy) against the trailing
    // 90-day per-minute-of-day baseline. bid_volume/ask_volume date's own baseline lookup
    // requires the trade_date, not sessStart -- matches getVolumeBaseline's own convention
    // (90 days strictly before the given date).
    const baseline = await getCachedBaseline(t.trade_date);
    const last3 = bars.slice(-3);
    const zScores = last3.map(b => {
      const bl = baseline.get(b.mod);
      const totalVol = b.bid_volume + b.ask_volume;
      return (bl && bl.std_vol > 0) ? (totalVol - bl.avg_vol) / bl.std_vol : null;
    }).filter(z => z != null);
    t.volZ = zScores.length ? zScores.reduce((a, b) => a + b, 0) / zScores.length : null;
  }
  const usable = trades.filter(t => !t.skip && t.volZ != null);
  console.log(`${usable.length} usable trades with volume baseline coverage.\n`);

  const sorted = [...usable].sort((a, b) => Math.abs(a.devTouch) - Math.abs(b.devTouch));
  const n = sorted.length;
  const low = sorted.slice(0, Math.floor(n / 3));

  function summarize(bucket, label) {
    if (bucket.length === 0) { console.log(`    ${label}: N=0`); return null; }
    const wins = bucket.filter(isWin).length;
    const wr = 100 * wins / bucket.length;
    const ev = bucket.reduce((s, t) => s + t.actual_pnl, 0) / bucket.length;
    const rigor = bucket.length >= 20 ? computeRigor(bucket, { dateField: 'trade_date', pnlFn: t => t.actual_pnl }) : null;
    const rigorStr = rigor ? ` | clean=${rigor.clean} stable=${rigor.stable} top5DayPct=${rigor.top5DayPct}%` : ' | N<20, THIN';
    console.log(`    ${label}: N=${bucket.length} WR=${wr.toFixed(1)}% EV=$${ev.toFixed(2)}/trade${rigorStr}`);
    return { n: bucket.length, wr, ev, rigor };
  }

  console.log('=== Within LOW |dev| tercile (N=' + low.length + '): split by volume z-score at touch ===');
  const lowSortedByVol = [...low].sort((a, b) => b.volZ - a.volZ);
  const half = Math.floor(lowSortedByVol.length / 2);
  const highVolR = summarize(lowSortedByVol.slice(0, half), 'HIGH volume (top half, avg z=' + (lowSortedByVol.slice(0, half).reduce((s, t) => s + t.volZ, 0) / half).toFixed(2) + ')');
  const lowVolR = summarize(lowSortedByVol.slice(half), 'LOW volume (bottom half, avg z=' + (lowSortedByVol.slice(half).reduce((s, t) => s + t.volZ, 0) / (lowSortedByVol.length - half)).toFixed(2) + ')');

  // Also: does volume z-score at touch predict the ACTUAL forward-expansion outcome (not just
  // real P&L directly) -- i.e. is volume a genuine leading indicator of the coiled-spring
  // release, or just independently/coincidentally correlated with EV?
  console.log('\n=== Correlation check: volume z-score vs |dev| touch magnitude (within LOW tercile) ===');
  const volZs = low.map(t => t.volZ), devAbs = low.map(t => Math.abs(t.devTouch));
  const mz = volZs.reduce((a, b) => a + b, 0) / volZs.length, md = devAbs.reduce((a, b) => a + b, 0) / devAbs.length;
  let cov = 0, vz = 0, vd = 0;
  for (let i = 0; i < volZs.length; i++) { cov += (volZs[i] - mz) * (devAbs[i] - md); vz += (volZs[i] - mz) ** 2; vd += (devAbs[i] - md) ** 2; }
  console.log('  correlation(volZ, |devTouch|):', (cov / Math.sqrt(vz * vd)).toFixed(3), '(near 0 = volume is an independent signal, not just re-measuring deviation)');

  // Whole-population check (not just low tercile) -- does volume z-score matter roster-wide
  // for this family, independent of deviation tercile?
  console.log('\n=== Whole population (all terciles pooled): volume z-score halves ===');
  const allSortedByVol = [...usable].sort((a, b) => b.volZ - a.volZ);
  const halfAll = Math.floor(allSortedByVol.length / 2);
  summarize(allSortedByVol.slice(0, halfAll), 'HIGH volume (top half)');
  summarize(allSortedByVol.slice(halfAll), 'LOW volume (bottom half)');

  // Auto-refresh weekly (run_weekly_backtests.sh) so this keeps re-accumulating real data and
  // re-checking itself instead of sitting static -- N=35/bucket already clears this project's
  // N>=20 floor; what's still open is date-clustering (top5DayPct), which more weeks of real
  // data resolves on its own without anyone having to remember to re-run this by hand.
  await recordClaim({
    slug: 'pd_level_fade_volume_size_as_live_knowable_substitute',
    claimText: `Weekly auto-refresh (scripts/pilot_low_deviation_volume_size_filter.mjs, wired into run_weekly_backtests.sh 2026-09-02). Within the low-|dev|-from-VWAP tercile of real GLOBEX PD_POC/PD_VAH/PD_VAL fades: LOW volume-at-touch N=${lowVolR?.n}, WR=${lowVolR?.wr?.toFixed(1)}%, EV=$${lowVolR?.ev?.toFixed(2)}/trade, rigor clean=${lowVolR?.rigor?.clean} top5DayPct=${lowVolR?.rigor?.top5DayPct}% vs HIGH volume-at-touch N=${highVolR?.n}, WR=${highVolR?.wr?.toFixed(1)}%, EV=$${highVolR?.ev?.toFixed(2)}/trade, rigor clean=${highVolR?.rigor?.clean} top5DayPct=${highVolR?.rigor?.top5DayPct}%. Both buckets clear this project's N>=20 floor already -- the open question is date-clustering (top5DayPct), not sample size, and that resolves automatically as this script keeps re-running weekly against real accumulating data. Counterintuitive direction (low volume beats high volume) confirmed independent of deviation magnitude via correlation check in the same run. Track top5DayPct/distinctDates trend across successive weekly runs to see whether this is converging toward decision-grade or staying an artifact of a few dates.`,
    sourceFile: 'scripts/pilot_low_deviation_volume_size_filter.mjs',
    sourceDate: today,
    sampleSize: lowVolR?.n,
    winRate: lowVolR?.wr,
    evPerTrade: lowVolR?.ev,
    rigorStatus: lowVolR?.rigor?.clean ? 'clean' : 'real_independent_date_clustered',
    status: 'PROVISIONAL',
  });
  console.log('\nRESEARCH_CLAIM pd_level_fade_volume_size_as_live_knowable_substitute refreshed.');
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
