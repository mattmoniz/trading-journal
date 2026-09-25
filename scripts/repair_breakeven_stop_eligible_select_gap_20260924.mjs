// Repair for a real bug found 2026-09-24: resolveSetupsByPrice()'s main row-fetching
// SELECT (server/services/resolveSetups.js, the `active` query) never included
// breakeven_stop_eligible in its column list, even though the 2026-09-21 promotion commit
// (c5a0458) added `row.breakeven_stop_eligible === true` as the live gate for the whole
// mechanism. Since the field was never selected, `row.breakeven_stop_eligible` was always
// `undefined`, and `undefined === true` is always false -- the BE mechanism has been
// completely inert since promotion (real N=0 for the live walker, despite 189 real
// eligible+resolved trades in the 3 days since). Fixed by adding the column to the SELECT.
//
// This script backfills `breakeven_stop_live` ONLY (an observation/counterfactual payload)
// for every real trade that resolved during the gap -- it does NOT touch resolution,
// actual_pnl, or price_at_resolution, since those real outcomes already happened correctly
// against the trade's ORIGINAL stop (the bug meant BE never actually modified any real
// stop -- every affected trade's real P&L is exactly what it would have been regardless).
// This backfill exists purely so the retrospective REWARDED/REJECTED/NO_PUSH classification
// and counterfactual comparison -- the entire analytical point of this mechanism -- isn't
// permanently blank for real trades that happened during the gap.
import { query } from '../server/db.js';
import { stepBreakevenStop } from '../server/services/breakevenStopWalker.js';
import { getTouchQualityBaseline } from '../server/services/acdShared.js';

const PROMOTION_DATE = '2026-09-21';
const PNL_PER_POINT = 2;
const COMMISSION = 2;

async function main() {
  const { rows } = await query(`
    SELECT id, trade_date::text AS trade_date, fired_at::text AS fired_at,
      resolved_at::text AS resolved_at, entry_zone_low, entry_zone_high, stop_level, t1_level,
      resolution_method
    FROM active_setups
    WHERE breakeven_stop_eligible = true
      AND runner_trail_width IS NULL AND extend_target_level IS NULL AND wider_target_mult IS NULL
      AND status = 'RESOLVED' AND breakeven_stop_live IS NULL
      AND trade_date >= $1
    ORDER BY fired_at
  `, [PROMOTION_DATE]);
  console.log(`Rows to backfill: ${rows.length}`);

  let repaired = 0, skipped = 0;
  for (const row of rows) {
    const entry = (parseFloat(row.entry_zone_low) + parseFloat(row.entry_zone_high)) / 2;
    const stop = parseFloat(row.stop_level);
    const t1 = row.t1_level != null ? parseFloat(row.t1_level) : null;
    const long = entry > stop;

    let beBaseline = null, beDisabled = false;
    try {
      beBaseline = await getTouchQualityBaseline(row.trade_date);
      if (!beBaseline) beDisabled = true;
    } catch (e) {
      beDisabled = true;
    }

    const barsRes = await query(`
      SELECT ts::text as ts, high::float, low::float, close::float
      FROM price_bars_primary WHERE symbol='NQ' AND ts > $1::timestamp AND ts <= $2::timestamp ORDER BY ts ASC
    `, [row.fired_at, row.resolved_at]);
    if (barsRes.rows.length === 0) { skipped++; continue; }

    let beState = { pendingPush: null, armed: false, armedAtTs: null, breakevenStop: null, sawRejection: false, pushEvaluated: false };
    let beCounterfactualResolution = null;
    let barCount = 0;
    let method = null, priceAtRes = null;

    for (const bar of barsRes.rows) {
      barCount++;
      try {
        const step = stepBreakevenStop(beState, bar, {
          entry, stop, t1, long, baseline: beBaseline,
          barsRemainingAfter: barsRes.rows.length - barCount,
        });
        beState = step.state;
        if (step.resolution) { method = step.resolution.method; priceAtRes = step.resolution.priceAtRes; }
        const cfStopHit = long ? bar.low <= stop : bar.high >= stop;
        const cfTargetHit = t1 != null && (long ? bar.high >= t1 : bar.low <= t1);
        if (!beCounterfactualResolution) {
          if (cfStopHit) beCounterfactualResolution = { resolution: 'STOP_HIT', priceAtRes: stop };
          else if (cfTargetHit) beCounterfactualResolution = { resolution: 'TARGET_HIT', priceAtRes: t1 };
        }
        if (step.resolution) break;
      } catch (e) {
        beDisabled = true;
        break;
      }
    }

    if (priceAtRes == null) { skipped++; continue; } // never actually resolved within the walked window -- leave for manual review

    const pnl = (long ? (priceAtRes - entry) : (entry - priceAtRes)) * PNL_PER_POINT - COMMISSION;
    const cf = beCounterfactualResolution;
    let counterfactualPnl = null;
    if (cf) {
      const cfPts = long ? cf.priceAtRes - entry : entry - cf.priceAtRes;
      counterfactualPnl = Math.round((cfPts * PNL_PER_POINT - COMMISSION) * 100) / 100;
    }
    const realPnlRounded = Math.round(pnl * 100) / 100;
    const payload = JSON.stringify({
      eligible: true,
      disabled: beDisabled,
      classification: beDisabled ? null : (beState.armed ? 'REWARDED' : (beState.sawRejection ? 'REJECTED' : 'NO_PUSH')),
      armed_at: beState.armedAtTs,
      live_active: beState.armed && cf != null && cf.priceAtRes !== priceAtRes,
      real_resolution_method: method,
      real_pnl: realPnlRounded,
      counterfactual_resolution: cf?.resolution ?? null,
      counterfactual_pnl: counterfactualPnl,
      delta: counterfactualPnl != null ? Math.round((realPnlRounded - counterfactualPnl) * 100) / 100 : null,
      backfilled: true,
      backfill_note: 'row.breakeven_stop_eligible was missing from resolveSetupsByPrice()\'s SELECT until 2026-09-24; this payload is reconstructed retroactively from real bar data, not written live at resolution time.',
    });

    await query(`UPDATE active_setups SET breakeven_stop_live = $2::jsonb WHERE id = $1`, [row.id, payload]);
    repaired++;
    if (repaired % 20 === 0) console.log(`  ...${repaired} repaired`);
  }

  console.log(`\nRepaired: ${repaired}, skipped (no bars / never resolved within window): ${skipped}`);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
