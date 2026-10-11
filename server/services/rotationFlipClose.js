// Rotation-flip real position close (2026-10-11) -- user-requested mechanism: when the 65pt
// rotation flips against an already-open REAL position, close it immediately rather than
// letting it ride to its own natural stop/target/timeout resolution. Backtest: RESEARCH_CLAIM
// poc_rotation_opposite_direction_close_and_gate_20261011 (IMMEDIATE trigger, the shape the
// user chose after seeing all 3 tested: n=695 real trades, mean=+$80.17/trade vs letting the
// trade run, day-blocked CI=[$58.60,$101.07], 64 distinct days, top-5-day share only 21.2% and
// EXCLUDING those top 5 days entirely INCREASES the mean -- robust, not a few lucky days).
//
// DELIBERATELY writes NO new order-submission code -- see CLAUDE.md's "share modules when the
// same logic would otherwise be reimplemented" rule, 5th instance (2026-10-11).
// sweepExits()/placeExitOrder() (orderSweep.js/reconciliation.js) already flatten any
// active_setups row marked RESOLVED/EXPIRED with a filled entry and no live exit order,
// complete with the broker-truth guard (brokerExitDecision) and the DB-unique-index-enforced
// double-flatten protection. This function's ONLY job is to transition a still-open row's own
// state early, on the SAME poll, right before sweepRealOrders() picks it up -- see acd.js's
// call site for why this exact slot matters.
//
// DeepSeek design review (2026-10-11, scratch/deepseek_response.md, independently spot-checked
// against the real code before trusting it) before implementation -- all 6 required items here:
//  1. FILLED-ENTRY GUARD (JOIN order_placements, filled_quantity>0). Without this, a resting
//     (not-yet-filled) entry could get marked RESOLVED with a FABRICATED mark-to-market pnl on
//     a position that never existed -- the exact "resting order needs a fill check" shape this
//     codebase's own hard rule names (the 2026-09-25 cluster-sibling phantom-fill incident).
//     The real-order side was always safe either way (sweepExits sees filled_quantity=0 and
//     cancels the resting entry, never flattens a phantom) -- this guard is about not writing
//     a wrong DB row and not yanking a not-yet-entered setup, not about broker safety.
//  2. ATOMIC UPDATE ... WHERE status='ACTIVE' AND resolved_at IS NULL RETURNING *, gated on
//     rows.length. The SELECT-side filter alone is NOT sufficient: server/index.js's own
//     30-min self-healing cron calls expireStaleSetups() independently of this function's own
//     poll cycle, and that function's main UPDATE path has NO status/resolved_at guard
//     (WHERE id=$1 only, setupExpiry.js:100-106) -- a real TOCTOU window across this
//     function's own multi-await getCurrentRotationDirection() call (NOW(), theta, bars,
//     detectSignalEvents -- ~4 round-trips). Losing the race is a correct no-op: whatever
//     terminal state the other writer set wins, matching this codebase's terminal-state-
//     lattice rule.
//  3. SKIP (log, don't write) on null direction/entry -- never write MARK_TO_MARKET with a
//     null actual_pnl, matching resolveSetupsByPrice()'s own contract.
//  4. dropToTimeline(updated.rows[0]) (the post-UPDATE row, not the pre-update SELECT row) +
//     io.emit on the win path, matching every other resolver's convention.
//  5. resolution_method='MARK_TO_MARKET' is CORRECTLY excluded from REAL_TRADE_FILTER (an
//     uncapped MTM close has nothing to do with the setup's own natural stop/target
//     calibration, and folding it in would silently distort real_n/real_ev/promotion
//     decisions) -- this is INTENTIONAL, not a gap. Consequence, stated explicitly per
//     DeepSeek's review: these closes are invisible to the normal dashboard/promotion
//     pipeline by design. Query `active_setups WHERE resolution='ROTATION_FLIP'` directly for
//     live monitoring until a dedicated view exists (not built yet -- flagged as a follow-up,
//     not blocking this mechanism).
//  6. Price source: the latest price_bars_primary close, matching expireStaleSetups()
//     verbatim -- the SAME value feeds both actual_pnl and price_at_resolution, no live-
//     tick-vs-bar-close mismatch.
import { query } from '../db.js';
import { resolveDirection } from '../config/setupTypes.js';
import { LIVE_INSTRUMENT } from '../config/instruments.js';
import { getCurrentRotationDirection } from './rotation65ptGateShadow.js';
import { dropToTimeline } from './acdShared.js';

export async function closeOnRotationFlip(io) {
  try {
    // Filled-entry guard (item 1) -- mirrors sweepExits()'s own JOIN exactly. This app trades
    // exactly 1 MNQ contract, so this is realistically 0-1 rows on any given poll.
    const openQ = await query(`
      SELECT a.id, a.setup_type, a.entry_zone_low, a.entry_zone_high, a.stop_level, a.t1_level
      FROM active_setups a
      JOIN order_placements e ON e.setup_id = a.id AND e.purpose = 'ENTRY'
      WHERE a.origin_status = 'ACTIVE' AND a.status = 'ACTIVE' AND a.resolved_at IS NULL
        AND e.filled_quantity > 0
    `).catch(() => ({ rows: [] }));
    if (!openQ.rows.length) return;

    // No caching (DeepSeek, item in "getCurrentRotationDirection() caching -- answered"):
    // the value flips at bar granularity, and this check runs late in the poll -- an uncached
    // read is the correct, freshest answer, not merely "cheap enough to leave as-is."
    const rotationDir = await getCurrentRotationDirection();
    if (rotationDir == null) return; // no leg formed yet, or the 5-6PM gap -- never guess

    for (const row of openQ.rows) {
      try {
        const direction = resolveDirection(row);
        const entry = row.entry_zone_high ?? row.entry_zone_low;
        if (direction == null || entry == null) {
          console.error(`[rotationFlipClose] setup_id=${row.id}: unresolvable direction/entry, skipping (no write) -- matches resolveSetupsByPrice()'s own contract.`);
          continue;
        }
        const isLong = direction === 'LONG';
        const agree = (rotationDir === 'UP') === isLong;
        if (agree) continue; // still aligned with the current rotation -- let it ride to its own natural resolution

        // Price source (item 6) -- same latest-bar-close convention expireStaleSetups() uses,
        // for both pnl and price_at_resolution.
        const priceQ = await query(`SELECT close::float as close FROM price_bars_primary WHERE symbol='NQ' ORDER BY ts DESC LIMIT 1`);
        const currentPrice = priceQ.rows[0]?.close;
        if (currentPrice == null) {
          console.error(`[rotationFlipClose] setup_id=${row.id}: no current price available this poll, skipping (no write).`);
          continue;
        }
        const pnl = Math.round(((isLong ? (currentPrice - entry) : (entry - currentPrice))
          * LIVE_INSTRUMENT.dollarsPerPoint - LIVE_INSTRUMENT.commissionPerRoundTrip) * 100) / 100;

        // Atomic guard (item 2): WHERE status='ACTIVE' AND resolved_at IS NULL, gated on
        // rows.length -- the lost-race detector, not a redundant re-check of the SELECT filter.
        const upd = await query(`
          UPDATE active_setups
          SET status='RESOLVED', resolution='ROTATION_FLIP', resolution_method='MARK_TO_MARKET',
              actual_outcome='ROTATION_FLIP', actual_pnl=$2, price_at_resolution=$3,
              resolved_at=NOW(), updated_at=NOW()
          WHERE id=$1 AND status='ACTIVE' AND resolved_at IS NULL
          RETURNING *
        `, [row.id, pnl, currentPrice]);

        if (upd.rows[0]) {
          console.log(`[rotationFlipClose] setup_id=${row.id} (${row.setup_type}): closed early on rotation flip (trade direction=${direction}, rotation now ${rotationDir}), pnl=${pnl}`);
          try { await dropToTimeline(upd.rows[0]); } catch (_) {}
          try { io?.emit('setup-resolved', upd.rows[0]); } catch (_) {}
        }
        // else: lost the race to a concurrent resolver (expireStaleSetups' own 30-min cron, or
        // this same poll's resolveSetupsByPrice()/structurallyInvalidateSetups() passes just
        // above this call site) -- correctly a no-op, the terminal state the other writer
        // already set wins, per the terminal-state-lattice rule.
      } catch (err) {
        console.error(`[rotationFlipClose] setup_id=${row.id}: threw, skipping this row:`, err);
      }
    }
  } catch (err) {
    console.error('[rotationFlipClose] top-level error:', err);
  }
}
