// Weekly recheck for LIVE_TIME_WINDOW_OVERRIDE (server/services/setupEligibility.js). For each
// entry, on real (ACTIVE+SHADOW origin, cluster-primary) resolved trades of that setup_type:
// per-trade value of skipping the window = -(actual_pnl of in-window trades), averaged over ALL
// of the setup's trades, with a day-blocked CI -- same quantity the per-setup variant test used,
// but on realized actual_pnl (rows in the window still resolve after being forced SHADOW, so this
// keeps measuring after the change). RETROSPECTIVE = before the override's addedDate
// (informational; it's what the rule was derived from). PROSPECTIVE = on/after addedDate, the only
// independent evidence; pre-registered look once it spans >= 20 distinct days.
import { query } from '../server/db.js';
import { LIVE_TIME_WINDOW_OVERRIDE } from '../server/services/setupEligibility.js';
import { dayBlockedBootstrapCI } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';
import { REAL_TRADE_FILTER } from './backtest_setup_status.mjs';

const RETRO_START = '2026-07-09';
const PROSPECTIVE_MIN_DAYS = 20;

async function main() {
  for (const [setupType, o] of LIVE_TIME_WINDOW_OVERRIDE) {
    const rows = (await query(`
      SELECT trade_date::text d, (EXTRACT(hour FROM fired_at)*60 + EXTRACT(minute FROM fired_at))::int m, actual_pnl::float pnl
      FROM active_setups
      WHERE setup_type = $1 AND trade_date >= $2::date AND actual_pnl IS NOT NULL
        AND ${REAL_TRADE_FILTER} AND resolution IN ('TARGET_HIT','STOP_HIT','TIME_EXPIRED')
        AND (is_cluster_primary IS NULL OR is_cluster_primary = true)
        AND (EXTRACT(hour FROM fired_at)*60 + EXTRACT(minute FROM fired_at)) >= 570
        AND (EXTRACT(hour FROM fired_at)*60 + EXTRACT(minute FROM fired_at)) < 960`, [setupType, RETRO_START])).rows;
    const summarize = (pop, label) => {
      if (!pop.length) return { label, n: 0 };
      const inWin = pop.filter(r => r.m >= o.fromEtMin && r.m < o.toEtMin);
      const deltas = pop.map(r => ({ date: r.d, pnl: (r.m >= o.fromEtMin && r.m < o.toEtMin) ? -r.pnl : 0 }));
      const ci = dayBlockedBootstrapCI(deltas, `ltw_${setupType}_${label}`);
      const ev = a => a.length ? a.reduce((s, r) => s + r.pnl, 0) / a.length : null;
      return { label, n: pop.length, inWinN: inWin.length, inWinDays: new Set(inWin.map(r => r.d)).size,
        inWinEv: ev(inWin), outWinEv: ev(pop.filter(r => !(r.m >= o.fromEtMin && r.m < o.toEtMin))),
        delta: deltas.reduce((s, x) => s + x.pnl, 0) / deltas.length, lo: ci.lo, hi: ci.hi };
    };
    const retro = summarize(rows.filter(r => r.d < o.addedDate), 'RETRO');
    const pro = summarize(rows.filter(r => r.d >= o.addedDate), 'PROSPECTIVE');
    const f = x => x == null ? 'n/a' : `$${x.toFixed(2)}`;
    const verdict = (pro.inWinDays ?? 0) < PROSPECTIVE_MIN_DAYS ? `ACCUMULATING (${pro.inWinDays ?? 0}/${PROSPECTIVE_MIN_DAYS} prospective in-window days)`
      : (pro.lo > 0 ? 'PROSPECTIVE_CONFIRMED' : 'PROSPECTIVE_NOT_CONFIRMED -- remove the override');
    for (const s of [retro, pro]) console.log(`${setupType} ${s.label}: N=${s.n} in-window N=${s.inWinN ?? 0} EV ${f(s.inWinEv)} vs out-of-window ${f(s.outWinEv)}; skip value ${f(s.delta)}/trade CI [${s.lo?.toFixed(2)}, ${s.hi?.toFixed(2)}]`);
    console.log(`  pre-registered look: ${verdict}`);
    await recordClaim({
      slug: `live_time_window_${setupType.toLowerCase()}`,
      claimText: `LIVE_TIME_WINDOW_OVERRIDE ${setupType} (force SHADOW ${Math.floor(o.fromEtMin / 60)}:${String(o.fromEtMin % 60).padStart(2, '0')}-${Math.floor(o.toEtMin / 60)}:00 ET, added ${o.addedDate}), rechecked weekly by scripts/recheck_live_time_window_overrides.mjs on realized actual_pnl (real, cluster-primary). RETROSPECTIVE (${RETRO_START} to ${o.addedDate}): in-window N=${retro.inWinN} EV ${f(retro.inWinEv)} vs out-of-window ${f(retro.outWinEv)}; skipping worth ${f(retro.delta)}/trade over all N=${retro.n}, day-blocked CI [${retro.lo?.toFixed(2)}, ${retro.hi?.toFixed(2)}]. PROSPECTIVE (post-change): in-window N=${pro.inWinN ?? 0} over ${pro.inWinDays ?? 0} days, EV ${f(pro.inWinEv)}. Pre-registered look at >=${PROSPECTIVE_MIN_DAYS} prospective in-window days: ${verdict}.`,
      sourceFile: 'scripts/recheck_live_time_window_overrides.mjs',
      sourceDate: o.addedDate,
      sampleSize: retro.n + (pro.n || 0),
      winRate: null,
      evPerTrade: retro.delta,
      rigorStatus: verdict.startsWith('ACCUMULATING') ? 'accumulating_prospective_days' : verdict.toLowerCase(),
      status: 'PROVISIONAL',
    });
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
