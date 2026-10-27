// The 5,324-trade RTH level-fade baseline set used by the VbP veto-filter study (docs/VBP_TREND_FILTER_PREREG_20261027.md), extracted so the
// post-entry study (docs/POST_ENTRY_DEDUP_BAILOUT_PREREG_20261027.md) uses EXACTLY the same trades. Selection code is copied verbatim from
// scripts/study_vbp_trend_filter_20261027.mjs; extra columns (resolved_at, resolution_bar_time) are only added, never used to filter.
import { query } from '../../server/db.js';
import { isInsideNqRollWeek } from '../../server/services/acdShared.js';
import { resolveDirection } from '../../server/config/setupTypes.js';
import { loadBars, prep, indexBars, emOf, SPARSE } from './floorEngine.mjs';
import { features } from './vbpTrendFilter.mjs';
const REAL_FLAGS = `ib_window_stale_basis IS NOT TRUE AND stale_entry_price_basis IS NOT TRUE AND late_fill_past_expiry_basis IS NOT TRUE AND bad_bars_basis IS NOT TRUE AND stale_levels_basis IS NOT TRUE`;
export async function loadTradeSet() {
  const raw = (await query(`SELECT id, setup_type, trade_date::text td, fired_at::text fa, resolved_at::text ra, expires_at::text ea, resolution_bar_time::text rbt, bars_to_resolution btr, entry_zone_low::float entry, stop_level::float stop, t1_level::float t1, structural_level_touched::float lvl, mfe_points::float mfe, mae_points::float mae, actual_pnl::float pnl, resolution
  FROM active_setups WHERE origin_status='BACKFILL' AND is_rth AND setup_type LIKE '%FADE%' AND setup_type NOT LIKE '%OVERNIGHT%' AND structural_level_touched IS NOT NULL AND (is_cluster_primary IS NULL OR is_cluster_primary)
   AND ${REAL_FLAGS} AND resolution IN ('TARGET_HIT','STOP_HIT','TIME_EXPIRED') AND actual_pnl IS NOT NULL AND fired_at::time >= '09:35' AND fired_at::time < '16:00' ORDER BY fired_at, id`)).rows;
  const minTd = raw[0].td, maxTd = raw[raw.length - 1].td;
  const NQ = indexBars(prep(await loadBars('price_bars_primary', `symbol='NQ'`, minTd.slice(0, 8) + '01', maxTd)));
  const sessStart = new Map(), sessEnd = new Map();
  for (let i = 0; i < NQ.n; i++) { const c = +NQ.T[i].slice(11, 13) * 60 + +NQ.T[i].slice(14, 16); if (NQ.T[i].slice(0, 10) !== NQ.TD[i]) continue; if (c >= 570 && c < 960) { if (!sessStart.has(NQ.TD[i])) sessStart.set(NQ.TD[i], i); sessEnd.set(NQ.TD[i], i); } }
  const drop = { roll: 0, sparse: 0, noDir: 0, noBar: 0, entryMismatch: 0, gap: 0, noFeat: 0 }, T = [];
  for (const r of raw) {
    if (isInsideNqRollWeek(r.td)) { drop.roll++; continue; } if (SPARSE(r.td)) { drop.sparse++; continue; }
    const dir = resolveDirection({ setup_type: r.setup_type, stop_level: r.stop, t1_level: r.t1 }); if (!dir) { drop.noDir++; continue; } const tradeDir = dir === 'LONG' ? 1 : -1;
    const t = NQ.byEm.get(emOf(r.fa.slice(0, 16) + ':00')), s = sessStart.get(r.td); if (t === undefined || s === undefined) { drop.noBar++; continue; }
    if (NQ.EM[t] - NQ.EM[s] !== t - s) { drop.gap++; continue; }
    if (!(r.entry >= NQ.L[t] - 0.5 && r.entry <= NQ.H[t] + 0.5)) { drop.entryMismatch++; continue; }
    const F = features(NQ, s, t, r.lvl, tradeDir); if (!F) { drop.noFeat++; continue; }
    const stopDist = Math.abs(r.entry - r.stop), bucket = r.pnl > 0 ? 'A' : r.resolution !== 'STOP_HIT' ? 'FLAT' : r.mfe >= 0.5 * stopDist ? 'B' : 'C';
    // realized exit bar: the stored resolution minute; TIME_EXPIRED rows without one use expires_at; capped at the session's last RTH bar (15:59)
    const endI = sessEnd.get(r.td), rawExit = r.ra || r.ea; let te = rawExit ? NQ.byEm.get(emOf(rawExit.slice(0, 16) + ':00')) : undefined; if (te === undefined) te = endI; te = Math.min(te, endI); if (te < t) { drop.exitBeforeEntry = (drop.exitBeforeEntry || 0) + 1; continue; }
    T.push({ ...r, t, te, s, tradeDir, F, ATR: F.ATR, stopDist, bucket, clk: +r.fa.slice(11, 13) * 60 + +r.fa.slice(14, 16) });
  }
  const dates = [...new Set(T.map((x) => x.td))].sort(), cutDate = dates[Math.floor(0.6 * dates.length) - 1];
  return { NQ, T, drop, sessStart, sessEnd, dates, cutDate };
}
