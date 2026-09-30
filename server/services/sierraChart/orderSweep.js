// The real order-placement sweep -- the ONE place this app's real order-placement side
// effects get wired to the existing (unchanged) simulated detection/resolution logic.
//
// WHY A CENTRALIZED SWEEP, NOT A HOOK AT EACH INSERT/RESOLUTION SITE (DeepSeek design
// review, 2026-09-29): `active_setups` has 6+ real-ACTIVE-capable INSERT sites inside
// acd.js plus 10 standalone detector service files, and `resolveSetups.js` alone has
// ~15-20 separate `UPDATE ... status='RESOLVED'/'EXPIRED'` writers across multiple files
// (resolveSetups.js, setupExpiry.js, shadowCompletion.js, breakevenStopShadow.js, the
// 5-6PM hard-close in acd.js). This codebase's own CLAUDE.md hard rule already names
// this exact failure mode ("grep every function that can independently write
// resolution/actual_pnl... a resolution-lifecycle bug can hide in a second writer nobody
// remembered existed") -- hooking each site individually for REAL orders means a single
// missed/future writer leaves a real position open with the app having "moved on," no
// close order ever sent. A sweep that asks "does a real ACTIVE row exist with no
// matching order_placements row yet" can never miss a branch, because it doesn't care
// which branch produced the row -- it only reads the OUTCOME, already true of this
// codebase's own reconcileAgainstBroker() philosophy.
//
// LATENCY: called synchronously as the LAST lifecycle pass inside runSetupDetection(),
// right after resolveSetupsByPrice()/expireStaleSetups()/structurallyInvalidateSetups()
// return -- so a fresh ACTIVE entry or a fresh resolution is acted on in the SAME poll,
// zero added delay beyond the 15s granularity every other decision in this app already
// has.

import { query } from '../../db.js';
import { isOrderEligible } from './orderEligibility.js';
import { placeEntryOrder, placeExitOrder, isAnotherPositionOpen } from './reconciliation.js';
import { resolveMnqFrontMonthSymbol } from './contractSymbol.js';
import { resolveDirection } from '../../config/setupTypes.js';

const ENTRY_LOOKBACK_MINUTES = 3; // don't backfill an entry for an old row a deploy/restart happens to see fresh
const DIRECTION_TO_SIDE = { LONG: 'BUY', SHORT: 'SELL' };

/**
 * Called once per poll, from runSetupDetection(), after every other lifecycle pass has
 * already run. Never throws -- every failure is caught, logged loudly, and the sweep
 * continues to the next row (a single bad row must never block the rest of the poll, and
 * must never silently disappear either -- see the loud-logging note below).
 */
export async function sweepRealOrders(dtcClient) {
  if (!dtcClient || !dtcClient.isLive()) return; // not connected/logged-on/live -- nothing to do this poll
  await sweepEntries(dtcClient).catch((err) => console.error('[sierraChart.orderSweep] entry sweep failed:', err));
  await sweepExits(dtcClient).catch((err) => console.error('[sierraChart.orderSweep] exit sweep failed:', err));
}

async function sweepEntries(dtcClient) {
  const rows = await query(`
    SELECT id, setup_type, entry_zone_low, stop_level, t1_level, trade_date
    FROM active_setups
    WHERE origin_status = 'ACTIVE' AND status = 'ACTIVE'
      AND fired_at > NOW() - make_interval(mins => $1)
      AND NOT EXISTS (SELECT 1 FROM order_placements WHERE setup_id = active_setups.id AND purpose = 'ENTRY')
  `, [ENTRY_LOOKBACK_MINUTES]);
  for (const row of rows.rows) {
    try {
      const direction = resolveDirection(row);
      if (!direction) { console.error(`[sierraChart.orderSweep] setup_id=${row.id} (${row.setup_type}): direction unresolvable (name/price disagreement or missing levels) -- skipping entry, not guessing.`); continue; }
      const elig = await isOrderEligible(row.setup_type, row.id);
      if (!elig.eligible) continue; // not an error -- most rows will legitimately be ineligible (kill switch off, suppressed, etc.)
      // Single-position-at-a-time invariant (2026-09-29, DeepSeek review after a real
      // misattribution bug -- see reconciliation.js's header). This app-level check is
      // just a fast path; the real guarantee is idx_order_placements_one_open_position.
      if (await isAnotherPositionOpen(row.id)) { console.log(`[sierraChart.orderSweep] setup_id=${row.id} (${row.setup_type}): another real position is already open -- skipping entry (one position at a time).`); continue; }
      if (row.entry_zone_low == null) { console.error(`[sierraChart.orderSweep] setup_id=${row.id}: no entry_zone_low, cannot place LIMIT entry -- skipping.`); continue; }
      const contract = resolveMnqFrontMonthSymbol(row.trade_date);
      const result = await placeEntryOrder(dtcClient, {
        setupId: row.id,
        entryPrice: Number(row.entry_zone_low),
        symbol: contract.orderSymbol,
        exchange: '', // exchange is embedded in the symbol string -- see contractSymbol.js's doc comment
        side: DIRECTION_TO_SIDE[direction],
        quantity: 1, // this app trades exactly 1 MNQ contract, never more -- see CLAUDE.md's contract_size memory
        tradeAccount: dtcClient.tradeAccount,
        environmentService: dtcClient.lastKnownService ?? null,
      });
      if (result) console.log(`[sierraChart.orderSweep] placed ENTRY for setup_id=${row.id} (${row.setup_type}): ${JSON.stringify(result)}`);
    } catch (err) {
      console.error(`[sierraChart.orderSweep] entry placement threw for setup_id=${row.id} (${row.setup_type}):`, err);
    }
  }
}

async function sweepExits(dtcClient) {
  const rows = await query(`
    SELECT a.id, a.setup_type, a.trade_date
    FROM active_setups a
    JOIN order_placements e ON e.setup_id = a.id AND e.purpose = 'ENTRY'
    WHERE a.origin_status = 'ACTIVE' AND a.status IN ('RESOLVED','EXPIRED')
      AND NOT EXISTS (
        SELECT 1 FROM order_placements x
        WHERE x.setup_id = a.id AND x.purpose = 'EXIT'
          AND x.status IN ('PENDING_SUBMIT','SUBMITTED','ORDER_SENT','PENDING_OPEN','OPEN','PARTIALLY_FILLED','PENDING_CANCEL','PENDING_CANCEL_REPLACE','FILLED')
      )
  `);
  for (const row of rows.rows) {
    try {
      const contract = resolveMnqFrontMonthSymbol(row.trade_date);
      const result = await placeExitOrder(dtcClient, {
        setupId: row.id,
        symbol: contract.orderSymbol,
        exchange: '',
        tradeAccount: dtcClient.tradeAccount,
        environmentService: dtcClient.lastKnownService ?? null,
      });
      // FLATTENED/CANCELED_UNFILLED_ENTRY/ALREADY_EXITING/NOTHING_TO_DO are all
      // legitimate outcomes -- only a thrown error is worth logging loudly here.
      console.log(`[sierraChart.orderSweep] exit resolution for setup_id=${row.id} (${row.setup_type}): ${JSON.stringify(result)}`);
    } catch (err) {
      console.error(`[sierraChart.orderSweep] exit placement threw for setup_id=${row.id} (${row.setup_type}) -- position may be REAL and UNMANAGED, investigate directly in Sierra Chart:`, err);
    }
  }
}
