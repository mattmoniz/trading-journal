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
import { evaluateDailyLossLimit } from './dllGate.js';
import { placeEntryOrder, placeBracketEntryOrder, placeExitOrder, placeMarketEscalationEntryOrder, checkEntryGates } from './reconciliation.js';
import { resolveMnqFrontMonthSymbolFromEnv } from './contractSymbol.js';
import { resolveDirection } from '../../config/setupTypes.js';
import { getCurrentPrice } from '../priceRetrieval.js';

const ENTRY_LOOKBACK_MINUTES = 3; // don't backfill an entry for an old row a deploy/restart happens to see fresh
const DIRECTION_TO_SIDE = { LONG: 'BUY', SHORT: 'SELL' };
// Entry fill-timeout escalation (2026-10-12, user decision -- see
// placeMarketEscalationEntryOrder()'s own header in reconciliation.js for the full
// incident/rationale). placeEntryOrder() is still ALWAYS a LIMIT at the setup's own level
// (2026-09-28 decision, unchanged) -- but a LIMIT that never fills means a trade shown live
// never actually happened, and (more consequentially) the resolver had no way to know that,
// so it would silently resolve a phantom win/loss from pure simulated price action with zero
// capital ever at risk (OPEN_DECISION primary_phantom_resolution_no_fill_gate_20261012).
// REVISED 90s, same night (2026-10-13): the original 20s pick predated
// MAX_CHASE_DISTANCE_POINTS below -- once that guard existed as an INDEPENDENT check, the
// timeout's job changed from "bound how far price could move" (the user's original 1-2min
// concern) to purely "how patient are we before giving up on a natural fill," since the
// distance guard now catches the "price moved too far" risk on its own, regardless of how
// long we waited. Real fill-latency data (order_placements, FILLED entries) made 20s look
// too impatient in the OTHER direction: 21/23 real fills land in <1s, but the 2 slower ones
// took 24.4s and 361.1s -- both eventually filled near their own original limit price (the
// 361s one landed just 0.125pt off) -- so a 20s cutoff would have killed a real, good,
// merely-patient fill. 90s comfortably covers the 24s case with margin; the 361s/6min
// outlier is a single data point, deliberately not chased -- waiting multiple minutes on
// every stuck order works against the actual goal (real fills generating real data).
const ENTRY_FILL_TIMEOUT_SECONDS = 90;
// Max-chase distance (2026-10-12, user constraint, same decision as above): don't
// cancel-and-escalate to MARKET if price has already moved further than this many points
// away from the original LIMIT level in the direction that would make a market fill worse
// -- that's no longer "the same trade a few points late," it's giving up a meaningfully
// different, and possibly structurally confounded, price (the user's own example: price
// moving through ANOTHER clustered level on the way is a sign this isn't a normal
// few-point drift). Picked 8 as the midpoint of the user's own stated "5-10pts" range --
// flagged clearly here so it's a one-line change if that's not the right number. A
// still-too-far order is simply left resting on its original LIMIT, unescalated, for a
// later poll to re-check -- it can still fill naturally if price comes back, and
// escalateUnfilledEntriesToMarket() re-evaluates distance fresh every poll, not just once.
// Exported (2026-10-13) so check_order_lifecycle_health.mjs's STUCK_UNFILLED check can
// explain WHY an order is still resting (this guard legitimately blocking escalation, vs a
// genuine malfunction) instead of duplicating this number -- share the constant, not re-guess it.
export const MAX_CHASE_DISTANCE_POINTS = 8;

/**
 * Called once per poll, from runSetupDetection(), after every other lifecycle pass has
 * already run. Never throws -- every failure is caught, logged loudly, and the sweep
 * continues to the next row (a single bad row must never block the rest of the poll, and
 * must never silently disappear either -- see the loud-logging note below).
 */
export async function sweepRealOrders(dtcClient) {
  if (!dtcClient || !dtcClient.isLive()) return; // not connected/logged-on/live -- nothing to do this poll
  await sweepEntries(dtcClient).catch((err) => console.error('[sierraChart.orderSweep] entry sweep failed:', err));
  await escalateUnfilledEntriesToMarket(dtcClient).catch((err) => console.error('[sierraChart.orderSweep] entry fill-timeout escalation failed:', err));
  await sweepExits(dtcClient).catch((err) => console.error('[sierraChart.orderSweep] exit sweep failed:', err));
}

// RTH orders stay on the RTH account; Globex orders go to a separate account so the two sessions keep
// separate P&L (2026-10-06). The stop and exit reuse the account stored on their entry row.
export function selectTradeAccount({ isRth, rthAccount, globexAccount }) {
  return isRth === false ? globexAccount : rthAccount;
}

// Durable record of every entry skip (2026-10-07, item 6). Written to gated_candidates -- the
// existing per-gate audit table -- so a skip is queryable later, not just a console line.
// De-duplicated per setup and reason over 5 minutes, since the sweep re-visits a fresh row on
// every poll inside its lookback window. gate_reason carries setup_id because gated_candidates
// has no setup_id column.
async function recordEntrySkip(row, reason) {
  // Found live 2026-10-13: this silently failed on EVERY call since the day it shipped --
  // "inconsistent types deduced for parameter $1" (detail: "text versus character varying").
  // PG's parser gets confused inferring $1's type across this INSERT...SELECT...WHERE NOT
  // EXISTS shape (no FROM clause on the outer SELECT to anchor it, then a second usage in the
  // correlated subquery) -- explicit casts settle it. Reproduced and confirmed fixed against
  // the real gated_candidates table before shipping, not assumed from reading the error alone.
  // The practical cost: every real skip reason (direction unresolvable, DLL blocked, another
  // position open, etc.) for a real order-eligible candidate was silently lost, never
  // queryable in gated_candidates -- only ever visible by grepping raw journalctl output.
  await query(`
    INSERT INTO gated_candidates (trade_date, setup_type, gate_name, gate_reason)
    SELECT CURRENT_DATE, $1::varchar, 'SIERRA_ENTRY_SKIP', $2::text
    WHERE NOT EXISTS (
      SELECT 1 FROM gated_candidates
      WHERE gate_name = 'SIERRA_ENTRY_SKIP' AND setup_type = $1::varchar AND gate_reason = $2::text
        AND evaluated_at > NOW() - interval '5 minutes'
    )
  `, [row.setup_type, `setup_id=${row.id} ${reason}`]).catch((err) => console.error('[sierraChart.orderSweep] failed to persist skip:', err.message));
}

async function sweepEntries(dtcClient) {
  const rows = await query(`
    SELECT id, setup_type, entry_zone_low, stop_level, t1_level, trade_date, is_rth
    FROM active_setups
    WHERE origin_status = 'ACTIVE' AND status = 'ACTIVE'
      AND fired_at > NOW() - make_interval(mins => $1)
      AND NOT EXISTS (SELECT 1 FROM order_placements WHERE setup_id = active_setups.id AND purpose = 'ENTRY')
  `, [ENTRY_LOOKBACK_MINUTES]);
  for (const row of rows.rows) {
    try {
      const direction = resolveDirection(row);
      const tradeAccount = selectTradeAccount({ isRth: row.is_rth, rthAccount: dtcClient.tradeAccount, globexAccount: process.env.DTC_GLOBEX_TRADE_ACCOUNT || 'Sim2' });
      if (!direction) { console.error(`[sierraChart.orderSweep] setup_id=${row.id} (${row.setup_type}): direction unresolvable (name/price disagreement or missing levels) -- skipping entry, not guessing.`); await recordEntrySkip(row, 'direction unresolvable'); continue; }
      const side = DIRECTION_TO_SIDE[direction]; // computed early -- needed by checkEntryGates() below
      const elig = await isOrderEligible(row.setup_type, row.id);
      if (!elig.eligible) { await recordEntrySkip(row, elig.reason); continue; } // not an error -- most rows will legitimately be ineligible (kill switch off, suppressed, etc.)
      // Daily loss limit (item 7). Fails closed when DTC_DLL_LIMIT_USD is unset.
      const dll = await evaluateDailyLossLimit(tradeAccount);
      if (dll.blocked) { console.log(`[sierraChart.orderSweep] setup_id=${row.id} (${row.setup_type}): entry blocked by daily loss limit -- ${dll.reason}`); await recordEntrySkip(row, `daily loss limit: ${dll.reason}`); continue; }
      // Multi-position-stacking build (2026-10-13, DeepSeek-reviewed, user cap override to 10
      // -- replaces the old strict singleton check, see reconciliation.js's checkEntryGates()
      // header for the full design). This app-level check is just a fast path with a readable
      // skip reason; the real guarantee against overflow is idx_order_placements_position_slot.
      const gate = await checkEntryGates(side);
      if (gate.blocked) { console.log(`[sierraChart.orderSweep] setup_id=${row.id} (${row.setup_type}): entry blocked -- ${gate.reason}.`); await recordEntrySkip(row, gate.reason); continue; }
      if (row.entry_zone_low == null) { console.error(`[sierraChart.orderSweep] setup_id=${row.id}: no entry_zone_low, cannot place LIMIT entry -- skipping.`); await recordEntrySkip(row, 'no entry_zone_low'); continue; }
      const contract = resolveMnqFrontMonthSymbolFromEnv(row.trade_date);
      // Native-OCO bracket (2026-10-07 build): off by default (SIERRA_USE_OCO_BRACKET unset).
      // The stop+target link has not round-tripped a fill against a venue that actually rests
      // orders -- Sim1 fills at market, so it can confirm the broker accepts/links the three
      // orders but not that the server-side cancel-the-sibling-on-fill behavior engages. Flip
      // this on only after a deliberate, deliberately-unfillable bracket test, per the plan
      // discussed 2026-10-07. Falls back to the existing standalone-STOP path (placeEntryOrder,
      // then placeStopOrder on fill confirmation) whenever the flag is off or either level is
      // missing, so this is purely additive -- no change to today's default behavior.
      const useBracket = process.env.SIERRA_USE_OCO_BRACKET === 'true' && Number.isFinite(Number(row.stop_level)) && Number.isFinite(Number(row.t1_level));
      let result;
      if (useBracket) {
        result = await placeBracketEntryOrder(dtcClient, {
          setupId: row.id,
          entryPrice: Number(row.entry_zone_low),
          stopPrice: Number(row.stop_level),
          targetPrice: Number(row.t1_level),
          symbol: contract.orderSymbol,
          exchange: '',
          side,
          quantity: 1,
          tradeAccount,
          environmentService: dtcClient.lastKnownService ?? null,
        });
        if (result) console.log(`[sierraChart.orderSweep] placed BRACKET ENTRY for setup_id=${row.id} (${row.setup_type}): ${JSON.stringify(result)}`);
      } else {
        result = await placeEntryOrder(dtcClient, {
          setupId: row.id,
          entryPrice: Number(row.entry_zone_low),
          symbol: contract.orderSymbol,
          exchange: '', // exchange is embedded in the symbol string -- see contractSymbol.js's doc comment
          side,
          quantity: 1, // this app trades exactly 1 MNQ contract, never more -- see CLAUDE.md's contract_size memory
          tradeAccount,
          environmentService: dtcClient.lastKnownService ?? null,
        });
        if (result) console.log(`[sierraChart.orderSweep] placed ENTRY for setup_id=${row.id} (${row.setup_type}): ${JSON.stringify(result)}`);
      }
    } catch (err) {
      console.error(`[sierraChart.orderSweep] entry placement threw for setup_id=${row.id} (${row.setup_type}):`, err);
    }
  }
}

/**
 * Cancel-then-resubmit-MARKET escalation for an ENTRY LIMIT order that's been resting
 * OPEN past ENTRY_FILL_TIMEOUT_SECONDS. See that constant's own header comment and
 * placeMarketEscalationEntryOrder()'s header (reconciliation.js) for the full incident
 * and design rationale. Two independent, idempotent steps -- never assumes a cancel
 * succeeded just because it was requested; only a real ORDER_UPDATE (handleOrderUpdate(),
 * whose terminal-state lattice already protects FILLED as absorbing even if a fill races
 * a cancel request) ever sets status='CANCELED', and only then does step 2 resubmit.
 */
async function escalateUnfilledEntriesToMarket(dtcClient) {
  // Step 1: cancel the ORIGINAL LIMIT entry (client_order_id has no trailing 'M' -- an
  // already-escalated resubmit's id always ends in 'M', entryClientOrderId()'s never does
  // since setupId is always numeric, so this LIKE pattern cleanly separates the two without
  // an extra join/flag column) once it's been resting OPEN longer than the timeout. Scoped
  // to setups still status='ACTIVE' -- if the setup already resolved/invalidated via some
  // other path first, this escalation leaves its entry alone; that's a different cleanup
  // this function doesn't own.
  const staleQ = await query(`
    SELECT e.id, e.setup_id, e.server_order_id, e.client_order_id, e.side, e.price1::float as price1
    FROM order_placements e
    JOIN active_setups a ON a.id = e.setup_id
    WHERE e.purpose = 'ENTRY' AND e.status = 'OPEN'
      AND e.client_order_id NOT LIKE '%M'
      AND e.submitted_at < NOW() - make_interval(secs => $1)
      AND a.status = 'ACTIVE'
  `, [ENTRY_FILL_TIMEOUT_SECONDS]);
  // Fetched once per poll (not once per stale row) -- every candidate this poll is judged
  // against the same current price, matching every other "one fetch, filter in JS" pattern
  // already used elsewhere in this codebase's poll loops.
  const currentPrice = staleQ.rows.length ? await getCurrentPrice('NQ', 'orderSweep.escalateUnfilledEntriesToMarket') : null;
  for (const row of staleQ.rows) {
    if (!row.server_order_id) continue; // no ORDER_UPDATE has assigned one yet -- cancelOrder() can't target it by ClientOrderID alone; retried next poll once one arrives
    // FAILS CLOSED (DeepSeek review finding, 2026-10-13): a missing/stale price feed must
    // skip escalation, never proceed without a real distance measurement -- the original
    // version here fired on `currentPrice != null` (fail OPEN), meaning a data gap would
    // have escalated blindly, exactly the "blind market-chase" the distance guard exists to
    // prevent. No price to check against is treated the same as "too far to chase."
    if (currentPrice == null || !Number.isFinite(row.price1)) {
      console.log(`[sierraChart.orderSweep] escalation: setup_id=${row.setup_id} skipped -- no current price available to check the chase-distance guard against (failing closed, not escalating blind).`);
      continue;
    }
    // BUY limit stuck unfilled means price moved UP away from it (a fill would have
    // already happened on the way down through price1); SELL limit stuck unfilled means
    // price moved DOWN away from it. Either way, chaseDistance is "how much worse a price
    // a market fill would get right now compared to the original limit" -- always computed
    // as a positive number when price has moved the unfavorable-to-chase direction, never
    // signed/negative (a limit that's favorably placed relative to current price would
    // already have filled, so that case shouldn't persist here).
    const chaseDistance = row.side === 'BUY' ? (currentPrice - row.price1) : (row.price1 - currentPrice);
    if (chaseDistance > MAX_CHASE_DISTANCE_POINTS) {
      console.log(`[sierraChart.orderSweep] escalation: setup_id=${row.setup_id} price has moved ${chaseDistance.toFixed(2)}pts away from the original LIMIT (${row.price1}, current ${currentPrice}) -- too far to chase (cap ${MAX_CHASE_DISTANCE_POINTS}pts), leaving it resting.`);
      continue;
    }
    try {
      dtcClient.cancelOrder({ serverOrderId: row.server_order_id, clientOrderId: row.client_order_id });
      // Optimistic local mark, matching the real DTC PENDING_CANCEL status code (6) rather
      // than an invented value, so the next poll doesn't re-request the same cancel. The
      // REAL confirmation still only ever comes from handleOrderUpdate()'s own terminal-
      // state lattice -- this write can never itself mark something CANCELED.
      await query(`UPDATE order_placements SET status='PENDING_CANCEL', last_update_at=NOW() WHERE id=$1 AND status='OPEN'`, [row.id]);
      console.log(`[sierraChart.orderSweep] escalation: canceling unfilled LIMIT entry for setup_id=${row.setup_id} after ${ENTRY_FILL_TIMEOUT_SECONDS}s -- will resubmit MARKET once confirmed.`);
    } catch (err) {
      console.error(`[sierraChart.orderSweep] escalation cancel failed for setup_id=${row.setup_id}:`, err.message);
    }
  }

  // Step 2: once the cancel is REAL-CONFIRMED (status='CANCELED', set only by
  // handleOrderUpdate() from an actual broker ORDER_UPDATE), resubmit as MARKET.
  // placeMarketEscalationEntryOrder() REUSES this exact row in place (UPDATE, not INSERT --
  // see that function's own header, DeepSeek CRITICAL finding) rather than creating a
  // second ENTRY row, so idempotency here is naturally just "status still says CANCELED" --
  // the instant a resubmit succeeds the row's own status moves on (PENDING_SUBMIT/
  // SUBMITTED/...), and it stops matching this WHERE clause on the next poll. No separate
  // "does an escalated row already exist" check is needed (or possible) now that there's
  // only ever one row per setup_id. Reuses the row's own recorded symbol/exchange/side/
  // quantity/trade_account/environment_service directly (not re-derived from active_setups
  // a second time) -- these were already correctly decided once, at the original
  // submission.
  const readyQ = await query(`
    SELECT e.id, e.setup_id, e.symbol, e.exchange, e.side, e.quantity, e.trade_account, e.environment_service
    FROM order_placements e
    JOIN active_setups a ON a.id = e.setup_id
    WHERE e.purpose = 'ENTRY' AND e.status = 'CANCELED' AND e.client_order_id NOT LIKE '%M'
      AND a.status = 'ACTIVE'
  `);
  for (const row of readyQ.rows) {
    try {
      const result = await placeMarketEscalationEntryOrder(dtcClient, {
        orderId: row.id,
        setupId: row.setup_id,
        symbol: row.symbol,
        exchange: row.exchange,
        side: row.side,
        quantity: row.quantity,
        tradeAccount: row.trade_account,
        environmentService: row.environment_service,
      });
      if (result) console.log(`[sierraChart.orderSweep] escalation: placed MARKET entry for setup_id=${row.setup_id}: ${JSON.stringify(result)}`);
    } catch (err) {
      console.error(`[sierraChart.orderSweep] escalation market resubmit failed for setup_id=${row.setup_id}:`, err.message);
    }
  }
}

async function sweepExits(dtcClient) {
  // Reuse the entry's own recorded symbol/exchange/trade_account/environment_service
  // (FIXED 2026-10-13, DeepSeek code review of the same-day stacking build, Q2): this
  // used to hardcode `tradeAccount: dtcClient.tradeAccount` (the RTH account) and re-derive
  // `symbol` from `row.trade_date` instead, regardless of which account/symbol the entry
  // actually filled on -- selectTradeAccount() routes RTH vs Globex entries to two
  // different accounts specifically so the two sessions keep separate P&L, so a Globex-
  // originated setup's exit was being submitted to the WRONG account entirely. This
  // predates today's stacking build (it was always wrong, just rarely consequential under
  // the old 0-or-1-position-ever singleton, where a Globex-only open position was the
  // uncommon case) -- stacking makes RTH+Globex coexistence routine, turning a latent bug
  // into a live one. Matches placeMarketEscalationEntryOrder()'s own existing precedent
  // (its own header comment: "these were already correctly decided once, at the original
  // submission" -- reuse, don't re-derive).
  const rows = await query(`
    SELECT a.id, a.setup_type, e.symbol, e.exchange, e.trade_account, e.environment_service
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
      const result = await placeExitOrder(dtcClient, {
        setupId: row.id,
        symbol: row.symbol,
        exchange: row.exchange,
        tradeAccount: row.trade_account,
        environmentService: row.environment_service,
      });
      // FLATTENED/CANCELED_UNFILLED_ENTRY/ALREADY_EXITING/NOTHING_TO_DO are all
      // legitimate outcomes -- only a thrown error is worth logging loudly here.
      console.log(`[sierraChart.orderSweep] exit resolution for setup_id=${row.id} (${row.setup_type}): ${JSON.stringify(result)}`);
    } catch (err) {
      console.error(`[sierraChart.orderSweep] exit placement threw for setup_id=${row.id} (${row.setup_type}) -- position may be REAL and UNMANAGED, investigate directly in Sierra Chart:`, err);
    }
  }
}
