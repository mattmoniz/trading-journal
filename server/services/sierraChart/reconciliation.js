// Reconciliation: the broker's own truth about what actually happened to a real order,
// written back into `order_placements` -- never this app's own simulated resolution
// logic (that stays exactly as-is for active_setups; this table is a separate, parallel
// record of what Sierra Chart itself reported).
//
// REWRITTEN 2026-09-29 after a confirmed real bug the first night this system traded for
// real -- see docs/OPEN_THREADS.md's 2026-09-28 Sierra Chart entry ("2026-09-29
// continuation") for the full incident, and the DeepSeek design review that shaped this
// rewrite. Root cause: every setup this app trades submits orders against the exact same
// single instrument, so the broker's `POSITION_UPDATE` (keyed by symbol+account, not by
// setup) reports the ACCOUNT'S NET AGGREGATE position -- it has no concept of "which
// setup does this belong to." The original version of placeExitOrder() asked the broker
// for this aggregate whenever its own filled_quantity record read zero, and attributed
// the result to whichever setup was being checked -- which misattributed another setup's
// real position (confirmed live: a real flatten was submitted for a setup whose own entry
// never filled, using a quantity that belonged to a different setup entirely).
//
// THE FIX, per DeepSeek's review (the aggregate is fine as a GUARD, never as an ORACLE):
// 1. Per-order fill tracking (matching on ClientOrderID, already setup-scoped via the
//    deterministic `E<setupId>`/`X<setupId>-...` ids) is the ONLY attribution source now.
//    The broker aggregate is never read to decide WHICH setup or WHAT quantity/side.
// 2. A DB-enforced singleton "one real position open, account-wide, at a time" invariant
//    (`position_open` + idx_order_placements_one_open_position) makes this safe AND
//    matches the user's own real trading style (exactly 1 MNQ contract at a time).
// 3. `checkPositionInvariant()` uses the aggregate ONLY as a fail-closed cross-check: if
//    the broker's real position ever disagrees with what this app's own fill records
//    expect, HALT and flag loudly -- never guess, never act on the aggregate directly.
// 4. `handleOrderUpdate()` now applies a terminal-state lattice (FILLED is absorbing --
//    nothing can overwrite it, and `filled_quantity` can never decrease) instead of
//    blindly applying whatever message arrived last -- this is what let a real fill get
//    overwritten back to CANCELED by a confusing, later-arriving cancel-rejection message
//    the first night.
// 5. Every real ORDER_UPDATE is now also appended to `order_placements_updates` (a real
//    history), not just overwritten into a single `raw_last_order_update` column -- the
//    old version made a genuine forensic repair of last night's records impossible,
//    because there was no way to see what messages had arrived before the last one.
//
// Idempotency design (unchanged): clientOrderId for an ENTRY is DETERMINISTIC, derived
// only from setupId (`E<setupId>`) -- never a counter or timestamp. The order_placements
// row is INSERTed first (status='PENDING_SUBMIT'), BEFORE the DTC order is actually sent,
// using the table's real UNIQUE index (client_order_id + the partial index on (setup_id)
// WHERE purpose='ENTRY') as the actual guarantee against a double-fire, not application
// logic alone. EXIT orders get a fresh clientOrderId each call (`X<setupId>-<timestamp>`)
// -- a real exit may legitimately need a retry after a terminal ERROR/REJECTED/CANCELED,
// but a WORKING or already-FILLED exit must never get a second one racing it --
// idx_order_placements_one_live_exit_per_setup enforces exactly one live exit per setup
// at the DB level.

import { query, getClient } from '../../db.js';
import { getPriceMultiplier, applyPriceMultiplier, classifyFill, toTickPrice } from './priceMultiplier.js';
import { runSerializedByKey } from './orderUpdateQueue.js';
import { recordBrokerPnlForSetup } from './brokerPnlWriter.js';

export function entryClientOrderId(setupId) { return `E${setupId}`; }
export function exitClientOrderId(setupId) { return `X${setupId}-${Date.now()}`; }
export function stopClientOrderId(setupId) { return `S${setupId}`; }
export function targetClientOrderId(setupId) { return `T${setupId}`; }

// DTC's binary struct uses DBL_MAX as the "field not set" sentinel for double fields.
// JSON encoding is not documented to guarantee omitting these outright (verified via
// Sierra Chart's docs: not stated either way) -- treat any absurdly large value as
// "not really set" too, as a defensive fallback on top of the ordinary undefined/NaN check.
function realNumberOrNull(v) {
  return Number.isFinite(v) && Math.abs(v) < 1e300 ? v : null;
}

const ORDER_STATUS_NAME = {
  1: 'ORDER_SENT', 2: 'PENDING_OPEN', 3: 'PENDING_CHILD', 4: 'OPEN',
  5: 'PENDING_CANCEL_REPLACE', 6: 'PENDING_CANCEL', 7: 'FILLED', 8: 'CANCELED',
  9: 'REJECTED', 10: 'PARTIALLY_FILLED',
};

// Multi-position-stacking build (2026-10-13, DeepSeek-reviewed plan, user cap override to 10 --
// see docs/OPEN_THREADS.md's 2026-10-13 entry for the full design/review). Replaces the prior
// strict 0-or-1-position-ever singleton (the original idx_order_placements_one_open_position)
// with up to MAX_CONCURRENT_POSITIONS real positions open at once, each claiming its own
// numbered "slot" via the new idx_order_placements_position_slot partial unique index (on
// position_slot WHERE purpose='ENTRY' AND position_open=TRUE). Same-direction stacking is
// allowed; opposite-direction is still blocked (checkEntryGates() below). The migration that
// added this column/index (position_slot SMALLINT, backfilling the one real open position at
// the time to slot=1) was run manually by the user after the sandbox's auto-mode classifier
// denied it as a schema-altering Bash action -- verified independently afterward (information_
// schema + a direct read of the open row) before building against it.
export const MAX_CONCURRENT_POSITIONS = 10;

async function insertPendingOrder({ setupId, purpose, clientOrderId, symbol, exchange, side, orderType, quantity, price1, price2, tradeAccount, environmentService }, onConflictDoNothing) {
  const conflictClause = onConflictDoNothing ? 'ON CONFLICT DO NOTHING' : '';
  // position_open is claimed HERE, at insert/submission time, not deferred until a fill
  // confirmation arrives (DeepSeek review, 2026-09-29, finding #2: the singleton index
  // only fires once something SETS position_open=TRUE -- setting it only on FILLED meant
  // two concurrent ENTRY inserts both started life at FALSE and neither ever hit the
  // index, so both could succeed and both could go on to fill for real before anything
  // caught it). Claiming the slot at submission means the index actually blocks a SECOND
  // entry from ever being inserted while the first is still resting/working, not just
  // once both are already filled. A bare ON CONFLICT DO NOTHING (no target) suppresses a
  // violation against ANY unique index on this table, including this new one, matching
  // this codebase's own standing convention for active_setups' touch-instant dedup.
  const positionOpen = purpose === 'ENTRY';
  if (purpose !== 'ENTRY') {
    // Non-ENTRY purposes (STOP/TARGET/EXIT) never claim a position_slot -- position_open is
    // always FALSE for them (the column's value on a non-ENTRY row is never read anywhere),
    // so there's nothing to atomically pick here.
    return query(`
      INSERT INTO order_placements
        (setup_id, purpose, client_order_id, symbol, exchange, side, order_type, quantity, price1, price2, trade_account, environment_service, status, position_open)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'PENDING_SUBMIT',$13)
      ${conflictClause}
      RETURNING id
    `, [setupId, purpose, clientOrderId, symbol, exchange, side, orderType, quantity, price1 ?? null, price2 ?? null, tradeAccount ?? null, environmentService ?? null, positionOpen]);
  }
  // ENTRY: claim the lowest free slot in 1..MAX_CONCURRENT_POSITIONS, AND verify no
  // opposite-direction real position is open, BOTH atomically in the same statement as the
  // insert itself, so there's no separate SELECT-then-INSERT gap for two overlapping polls
  // to race through. If every slot is taken OR a direction conflict exists, the row is
  // filtered out entirely -- zero rows returned, the exact same "nothing inserted"
  // convention this function's callers (placeEntryOrder's own docstring) already treat as a
  // benign idempotency short-circuit, now also covering "at capacity"/"direction conflict"
  // and not just "a duplicate for this exact setup." checkEntryGates() below is the
  // fast-path pre-check callers use to skip with a readable reason before even reaching
  // this point. The CAPACITY half of this is airtight (idx_order_placements_position_slot
  // is a real unique index, so a concurrent writer either wins the slot or loses via ON
  // CONFLICT DO NOTHING -- Q1 of DeepSeek's 2026-10-13 code review). The DIRECTION half is
  // narrowed to this one statement's own snapshot but NOT given an equivalent DB-level
  // backstop (Q3/Gap B of the same review, a genuine finding, not fully closed): unlike the
  // old idx_order_placements_one_open_position (a true table-wide "at most one, ever"
  // index, which made opposite-direction coexistence structurally impossible as a side
  // effect), there is no unique index expressing "every open ENTRY row shares the same
  // side" -- two truly concurrent transactions, each under their own READ COMMITTED
  // snapshot, could in principle both see "no conflict" and both insert. Accepted as a
  // residual, narrowed risk rather than built out further: this app has exactly one process
  // placing real orders, sequentially, from one 15s poll's own await chain (verified no
  // other code path inserts a real ENTRY) -- a genuine two-writer race would need two
  // overlapping poll/escalation cycles, which this architecture doesn't produce today.
  return query(`
    WITH avail AS (
      SELECT MIN(s) AS slot FROM generate_series(1, $13::int) s
      WHERE s NOT IN (
        SELECT position_slot FROM order_placements
        WHERE purpose = 'ENTRY' AND position_open = TRUE AND position_slot IS NOT NULL
      )
    ),
    direction_ok AS (
      SELECT NOT EXISTS (
        SELECT 1 FROM order_placements
        WHERE purpose = 'ENTRY' AND position_open = TRUE AND side != $6
      ) AS ok
    )
    INSERT INTO order_placements
      (setup_id, purpose, client_order_id, symbol, exchange, side, order_type, quantity, price1, price2, trade_account, environment_service, status, position_open, position_slot)
    SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'PENDING_SUBMIT',TRUE, avail.slot
    FROM avail, direction_ok
    WHERE avail.slot IS NOT NULL AND direction_ok.ok
    ${conflictClause}
    RETURNING id
  `, [setupId, purpose, clientOrderId, symbol, exchange, side, orderType, quantity, price1 ?? null, price2 ?? null, tradeAccount ?? null, environmentService ?? null, MAX_CONCURRENT_POSITIONS]);
}

async function submitAndRecord(dtcClient, id, { symbol, exchange, side, orderType, quantity, price1, price2, timeInForce, clientOrderId, freeFormText }) {
  try {
    dtcClient.submitOrder({ symbol, exchange, side, orderType, quantity, price1, price2, timeInForce, clientOrderId, freeFormText });
    await query(`UPDATE order_placements SET status='SUBMITTED', last_update_at = now() WHERE id = $1`, [id]);
  } catch (err) {
    // A submission that never reached the broker must release the singleton slot it
    // claimed at insert time -- position_open only matters for ENTRY rows (the column's
    // value on an EXIT row is never read), so unconditionally clearing it here is safe.
    await query(`UPDATE order_placements SET status='ERROR', reject_reason = $2, position_open = FALSE, last_update_at = now() WHERE id = $1`, [id, err.message]);
    throw err;
  }
}

/**
 * Place a real entry order for a real active_setups row. Submitted as a LIMIT order at
 * the setup's own entry level by default (user decision, 2026-09-28) -- `entryPrice` is
 * required -- this function does not compute or default it.
 *
 * marketEntry (2026-10-13, user decision, overriding DeepSeek's own narrower recommended
 * fix -- see docs/OPEN_THREADS.md's 2026-10-13 "market-entry-order-type" entry for the
 * full design critique this overrides and why): a deliberate, scoped exception to the
 * 2026-09-28 LIMIT-only contract, for setup_types whose entry is a snapshot of a
 * CONTINUOUSLY MOVING reference (a running VWAP, a session median) frozen at detection
 * time -- if the LIMIT doesn't fill quickly, the real reference keeps drifting and the
 * frozen level becomes progressively less representative of where the setup's own thesis
 * actually is. When true, submits MARKET instead -- entryPrice is still required and
 * still used for position_at_detection-style bookkeeping elsewhere in the caller, just
 * not as the order's own limit price. The scoping decision (which setup_types get this)
 * lives at the call site (orderSweep.js's MARKET_ENTRY_SETUP_TYPES), not in this function
 * -- this function only knows how to place either kind of order.
 *
 * DB price1 vs wire Price1 are deliberately DECOUPLED for a MARKET order (DeepSeek code
 * review, 2026-10-13, CORRECTNESS finding -- verified independently before accepting): a
 * first draft stored `price1=0` in both places, matching
 * placeMarketEscalationEntryOrder's own `price1=0` convention -- but that function's
 * price1=0 row is protected from the three downstream "treat price1 as a real limit"
 * consumers (escalateUnfilledEntriesToMarket, resolveSetups.js's chase-abandon check,
 * check_order_lifecycle_health.mjs's checkStuckUnfilled) by its client_order_id's
 * trailing 'M' suffix, which all three explicitly filter on -- a FRESH market entry has
 * no such suffix, so `price1=0` would flow straight into their chase-distance math as if
 * it were a real (wildly wrong) limit price, and -- confirmed directly -- do so
 * ASYMMETRICALLY by side (a BUY reads `current - 0` as "too far to ever chase," a SELL
 * reads `0 - current` as a large NEGATIVE distance that never trips the "too far" guard
 * and proceeds to pointlessly cancel-and-resubmit MARKET every poll). `price1=null` in
 * the DB makes `Number.isFinite(price1)` correctly false for all three, matching
 * fillPriceSanity's own existing null-as-no-constraint convention (priceMultiplier.js:
 * `orderType==='MARKET' || !Number.isFinite(price1)` -> ok). The WIRE still gets a real
 * number (DTC ignores Price1 for MARKET but still requires one on the wire, matching
 * placeMarketEscalationEntryOrder's own precedent) -- these are computed separately
 * below, not derived from one shared value.
 *
 * freeFormText (2026-10-13): optional human-readable label passed through to
 * dtcClient.submitOrder() for identifying the order directly in Sierra Chart's own UI --
 * no effect on fill behavior, price, or order type.
 *
 * Returns { id, clientOrderId } on success, or null if an entry order for this setupId
 * already exists (the idempotency short-circuit -- NOT an error).
 */
export async function placeEntryOrder(dtcClient, { entryPrice, marketEntry = false, freeFormText, ...params }) {
  if (!Number.isFinite(entryPrice)) throw new Error('placeEntryOrder(): entryPrice is required (used for bookkeeping even when marketEntry is true).');
  const clientOrderId = entryClientOrderId(params.setupId);
  const dbPrice1 = marketEntry ? null : entryPrice; // null = "no limit price", never 0 -- see header comment
  const wirePrice1 = marketEntry ? 0 : entryPrice;
  const fullParams = { ...params, orderType: marketEntry ? 'MARKET' : 'LIMIT', price1: dbPrice1, freeFormText };
  const insertQ = await insertPendingOrder({ ...fullParams, purpose: 'ENTRY', clientOrderId }, true);
  if (insertQ.rows.length === 0) return null;
  const id = insertQ.rows[0].id;
  await submitAndRecord(dtcClient, id, { ...fullParams, price1: wirePrice1, clientOrderId });
  return { id, clientOrderId };
}

export function marketEscalationClientOrderId(setupId) { return `E${setupId}M`; }

/**
 * Place a real MARKET entry order for a setup whose original LIMIT entry (placeEntryOrder)
 * was canceled after sitting unfilled past the escalation timeout
 * (orderSweep.js's escalateUnfilledEntriesToMarket, 2026-10-12 -- user decision, reversing
 * placeEntryOrder's own 2026-09-28 "ALWAYS LIMIT, never MARKET" contract specifically for
 * this narrow timeout-escalation case, after a real incident: PD_POC_FADE_SHORT's LIMIT
 * entry sat OPEN/unfilled for 2.5+ hours while quick-check.html showed a live, growing
 * "profit" for a position that never existed, and -- more consequentially -- the resolver
 * had no fill gate for primaries at all, meaning the trade would eventually have resolved a
 * real win/loss from pure simulated price action with zero capital ever at risk).
 *
 * REVISED same night, DeepSeek code review (CRITICAL finding, verified against the live
 * schema before accepting): the first version INSERTed a brand-new ENTRY row with a
 * distinct 'M'-suffixed client_order_id, but idx_order_placements_one_entry_per_setup is
 * UNIQUE(setup_id) WHERE purpose='ENTRY' with NO status filter (unlike the EXIT equivalent,
 * idx_order_placements_one_live_exit_per_setup, which IS status-scoped) -- so that INSERT
 * always collided with the original (by-then-CANCELED) entry row for the same setup_id, the
 * bare ON CONFLICT DO NOTHING silently swallowed it, and the function always returned null.
 * Net effect: Step 1 of escalateUnfilledEntriesToMarket really did cancel a real resting
 * LIMIT, and the market resubmit could NEVER actually happen -- a regression (an order that
 * might well have filled naturally, per live data showing real fills up to 361s/24.5pts off
 * the limit, got canceled with no path back to a live order at all) rather than the intended
 * fix. Changing the unique index itself was considered and rejected as riskier than needed
 * (other code may assume "at most one ENTRY row per setup_id, ever" when querying this
 * table) -- instead this function now REUSES the existing (CANCELED) row in place via
 * UPDATE, submitting against the SAME row id, so "one ENTRY row per setup_id" stays
 * literally true at the DB level and the unique index is never touched or threatened.
 *
 * Also now explicitly checks the real entry gates (checkEntryGates(), 2026-10-13 multi-
 * position-stacking build -- originally isAnotherPositionOpen()) before resubmitting and
 * LOGS LOUDLY if blocked, rather than silently no-op'ing (DeepSeek finding #2):
 * handleOrderUpdate() frees this row's own claimed slot the instant the original LIMIT's
 * cancel confirms, so another setup's entry can legitimately claim a slot (or an opposite-
 * direction conflict can arise) in the gap before this resubmit runs -- a real, expected
 * scenario under the position-gate rules, not a bug, but one that must never fail silently.
 * The UPDATE below re-derives a fresh position_slot atomically (the same lowest-free-slot
 * pick insertPendingOrder() uses) rather than trusting this row's OLD slot value is still
 * free -- it may not be, since it was genuinely released back into the pool on cancel.
 *
 * Deliberately a SEPARATE function from placeEntryOrder, not a parameterized variant of it
 * -- placeEntryOrder's own docstring is an explicit, deliberate contract every OTHER caller
 * still relies on; this is a narrowly-scoped escalation path, not a loosening of that
 * contract.
 *
 * price1=0 (not null) matches dtcClient.submitOrder()'s own destructuring default for a
 * MARKET order, where Price1 is required on the wire but ignored by the exchange --
 * destructuring defaults only apply to `undefined`, not `null`, so passing null here would
 * silently override that default and send a non-numeric Price1 instead.
 *
 * `orderId` is the existing (CANCELED) order_placements row id to reuse (the original
 * LIMIT entry's own id, from escalateUnfilledEntriesToMarket's Step 2 query).
 *
 * Returns { id, clientOrderId } on success, or null if blocked by the position-open
 * invariant (logged loudly, not silent) or if the row is no longer in a reusable state
 * (another poll already claimed it -- a benign race, not an error).
 */
export async function placeMarketEscalationEntryOrder(dtcClient, { orderId, setupId, symbol, exchange, side, quantity, tradeAccount, environmentService }) {
  const gate = await checkEntryGates(side);
  if (gate.blocked) {
    console.log(`[sierraChart.reconciliation] market-escalation resubmit BLOCKED for setup_id=${setupId}: ${gate.reason} (this row's own slot was freed when the original LIMIT's cancel confirmed). Will retry next poll if it frees up again.`);
    return null;
  }
  const clientOrderId = marketEscalationClientOrderId(setupId);
  const fullParams = { symbol, exchange, side, orderType: 'MARKET', quantity, price1: 0, tradeAccount, environmentService };
  // Reuse the existing row (reset to a fresh pending-submit state) instead of inserting a
  // new one -- see this function's own header for why. WHERE status='CANCELED' is the real
  // idempotency guard: if some other path already moved this row again (or it's no longer
  // CANCELED for any reason), this UPDATE matches zero rows and we correctly return null
  // rather than resubmit against a row whose state we no longer understand. avail.slot IS
  // NOT NULL / direction_ok.ok are the SAME capacity + direction checks insertPendingOrder()
  // uses -- if checkEntryGates() above raced against another poll claiming the last slot or
  // opening an opposite-direction position, this UPDATE matches zero rows rather than
  // violate idx_order_placements_position_slot or (per direction_ok, folded in the same way
  // and with the same narrowed-not-eliminated caveat -- see that CTE's own comment in
  // insertPendingOrder() above) silently open two opposing positions.
  //
  // FIXED 2026-10-13 (DeepSeek code review, Q3/Gap A): an UPDATE has no ON CONFLICT clause
  // (unlike insertPendingOrder()'s fresh-INSERT path, which catches the equivalent race via
  // a bare ON CONFLICT DO NOTHING) -- if a concurrent transaction commits a claim on the
  // SAME slot number between this statement's own CTE snapshot and its actual index write,
  // Postgres raises a real duplicate-key exception (23505) here instead of just matching
  // zero rows. Caught explicitly below and treated as the identical benign "lost the race,
  // retry next poll" outcome -- without this, the exact same race this function already
  // tolerates everywhere else would instead surface as a scary, misleading console.error on
  // what's actually expected, harmless behavior (the row stays CANCELED and retries fine).
  let updateQ;
  try {
    updateQ = await query(`
      WITH avail AS (
        SELECT MIN(s) AS slot FROM generate_series(1, $3::int) s
        WHERE s NOT IN (
          SELECT position_slot FROM order_placements
          WHERE purpose = 'ENTRY' AND position_open = TRUE AND position_slot IS NOT NULL
        )
      ),
      direction_ok AS (
        SELECT NOT EXISTS (
          SELECT 1 FROM order_placements
          WHERE purpose = 'ENTRY' AND position_open = TRUE AND side != $4
        ) AS ok
      )
      UPDATE order_placements op
      SET client_order_id = $2, order_type = 'MARKET', price1 = 0, price2 = NULL,
          status = 'PENDING_SUBMIT', position_open = TRUE, position_slot = avail.slot,
          filled_quantity = NULL, avg_fill_price = NULL, server_order_id = NULL, reject_reason = NULL,
          submitted_at = now(), last_update_at = now()
      FROM avail, direction_ok
      WHERE op.id = $1 AND op.purpose = 'ENTRY' AND op.status = 'CANCELED'
        AND avail.slot IS NOT NULL AND direction_ok.ok
      RETURNING op.id
    `, [orderId, clientOrderId, MAX_CONCURRENT_POSITIONS, side]);
  } catch (err) {
    if (err.code === '23505') {
      console.log(`[sierraChart.reconciliation] market-escalation resubmit for setup_id=${setupId}: lost a race for the slot claim against another concurrent order -- will retry next poll.`);
      return null;
    }
    throw err;
  }
  if (updateQ.rows.length === 0) return null;
  await submitAndRecord(dtcClient, orderId, { ...fullParams, clientOrderId });
  return { id: orderId, clientOrderId };
}

const OPPOSITE_SIDE = { BUY: 'SELL', SELL: 'BUY' };

/**
 * Place the real, static, GTC broker-side stop for a setup -- ONLY called from
 * handleOrderUpdate() once the matching ENTRY's own ORDER_UPDATE confirms FILLED, never
 * at entry-submission time (docs/OPEN_THREADS.md's 2026-09-29 "Item 2" spec). Idempotent
 * the same way as placeEntryOrder -- idx_order_placements_one_stop_per_setup is the real
 * guarantee, this is just the fast-path insert attempt. Always GTC (TIME_IN_FORCE.GTC),
 * never the DTC default DAY -- this app trades overnight Globex, and a DAY stop would
 * expire at session close, exactly the hours a host-sleep/crash protection needs to cover.
 *
 * Returns { id, clientOrderId } on success, or null if a STOP order for this setupId
 * already exists (the idempotency short-circuit -- NOT an error).
 */
export async function placeStopOrder(dtcClient, { setupId, stopPrice, entrySide, filledQuantity, symbol, exchange, tradeAccount, environmentService }) {
  if (!Number.isFinite(stopPrice)) throw new Error('placeStopOrder(): stopPrice is required.');
  if (!OPPOSITE_SIDE[entrySide]) throw new Error(`placeStopOrder(): invalid entrySide "${entrySide}"`);
  const clientOrderId = stopClientOrderId(setupId);
  const fullParams = {
    setupId, symbol, exchange, tradeAccount, environmentService,
    side: OPPOSITE_SIDE[entrySide], orderType: 'STOP', quantity: filledQuantity, price1: stopPrice,
  };
  const insertQ = await insertPendingOrder({ ...fullParams, purpose: 'STOP', clientOrderId }, true);
  if (insertQ.rows.length === 0) return null;
  const id = insertQ.rows[0].id;
  await submitAndRecord(dtcClient, id, { ...fullParams, timeInForce: 'GTC', clientOrderId });
  return { id, clientOrderId };
}

/**
 * Place a real native-OCO bracket entry (2026-10-07, OCO build): one parent LIMIT entry plus a
 * stop and a target as a true SUBMIT_NEW_OCO_ORDER pair, linked by the broker itself rather than
 * by this app watching for a fill after the fact -- the broker's own server-side OCO link does the
 * canceling; placeExitOrder's getLegStatus/cancelRestingLeg checks still apply for the case where
 * the app's OWN simulated exit logic closes the position before either native leg fills. Per
 * Sierra's documented bracket procedure (DTC Messages and Procedures doc, verified
 * against DTCProtocol.h): the OCO submission must be the VERY NEXT message after the parent, or
 * the server rejects the parent -- the two dtcClient calls below are made back to back with no
 * `await` between them (submitOrder/submitOcoOrder are synchronous socket writes; only the
 * surrounding DB inserts are async) specifically to guarantee that ordering.
 *
 * UNTESTED against a real fill/cancel round-trip as of this build -- Sim1 fills resting orders at
 * market, so it can confirm the broker ACCEPTS and LINKS the three orders, but not that the
 * server-side cancel-the-sibling-on-fill behavior actually engages. Gated behind
 * SIERRA_USE_OCO_BRACKET (orderSweep.js) -- not the default entry path until that's been proven
 * on a venue that rests orders.
 *
 * Returns { entryId, entryClientOrderId, stopClientOrderId, targetClientOrderId } on success, or
 * null if an ENTRY for this setupId already exists (the idempotency short-circuit -- NOT an error).
 */
export async function placeBracketEntryOrder(dtcClient, { entryPrice, stopPrice, targetPrice, side, quantity, setupId, symbol, exchange, tradeAccount, environmentService }) {
  if (!Number.isFinite(entryPrice)) throw new Error('placeBracketEntryOrder(): entryPrice is required.');
  if (!Number.isFinite(stopPrice)) throw new Error('placeBracketEntryOrder(): stopPrice is required.');
  if (!Number.isFinite(targetPrice)) throw new Error('placeBracketEntryOrder(): targetPrice is required.');
  if (!OPPOSITE_SIDE[side]) throw new Error(`placeBracketEntryOrder(): invalid side "${side}"`);

  const eId = entryClientOrderId(setupId);
  const sId = stopClientOrderId(setupId);
  const tId = targetClientOrderId(setupId);
  const common = { setupId, symbol, exchange, tradeAccount, environmentService };

  const entryInsert = await insertPendingOrder({ ...common, purpose: 'ENTRY', clientOrderId: eId, side, orderType: 'LIMIT', quantity, price1: entryPrice }, true);
  if (entryInsert.rows.length === 0) return null; // idx_order_placements_one_entry_per_setup -- already placed
  const entryId = entryInsert.rows[0].id;

  const childSide = OPPOSITE_SIDE[side];
  const stopInsert = await insertPendingOrder({ ...common, purpose: 'STOP', clientOrderId: sId, side: childSide, orderType: 'STOP', quantity, price1: stopPrice }, true);
  const targetInsert = await insertPendingOrder({ ...common, purpose: 'TARGET', clientOrderId: tId, side: childSide, orderType: 'LIMIT', quantity, price1: targetPrice }, true);
  if (stopInsert.rows.length === 0 || targetInsert.rows.length === 0) {
    // Should be unreachable -- the entry row didn't exist a moment ago, so neither should its
    // children, per idx_order_placements_one_stop_per_setup/idx_order_placements_one_target_per_setup.
    // Fail loud rather than submit a bracket with a missing leg.
    await query(`UPDATE order_placements SET status='ERROR', reject_reason='bracket child row conflict', position_open=FALSE WHERE id=$1`, [entryId]);
    throw new Error(`placeBracketEntryOrder(): setup_id=${setupId}: STOP/TARGET row already existed for a brand-new ENTRY -- refusing to submit a partial bracket.`);
  }

  try {
    dtcClient.submitOrder({ symbol, exchange, side, orderType: 'LIMIT', quantity, price1: entryPrice, timeInForce: 'DAY', clientOrderId: eId, tradeAccount, isParentOrder: true });
    dtcClient.submitOcoOrder({
      symbol, exchange, tradeAccount, parentTriggerClientOrderId: eId, timeInForce: 'GTC',
      leg1: { clientOrderId: sId, orderType: 'STOP', side: childSide, price1: stopPrice, quantity },
      leg2: { clientOrderId: tId, orderType: 'LIMIT', side: childSide, price1: targetPrice, quantity },
    });
  } catch (err) {
    await query(`UPDATE order_placements SET status='ERROR', reject_reason=$2, last_update_at=now() WHERE id = ANY($1)`, [[entryId, stopInsert.rows[0].id, targetInsert.rows[0].id], err.message]);
    await query(`UPDATE order_placements SET position_open=FALSE WHERE id=$1`, [entryId]);
    console.error(`[sierraChart.reconciliation] setup_id=${setupId}: bracket submission failed -- per Sierra's own documented procedure the server should reject the dangling parent since the OCO message never followed, but this has not been verified live. Check Sierra Chart directly:`, err);
    throw err;
  }
  await query(`UPDATE order_placements SET status='SUBMITTED', last_update_at=now() WHERE id = ANY($1)`, [[entryId, stopInsert.rows[0].id, targetInsert.rows[0].id]]);
  return { entryId, entryClientOrderId: eId, stopClientOrderId: sId, targetClientOrderId: tId };
}

/** The setup's own most recent row of one protective-leg purpose ('STOP' or 'TARGET'), or null if
 * none exists. Used by placeExitOrder (recognize an already-closed-by-STOP-or-TARGET setup, and
 * cancel a still-resting leg ahead of a flatten) and cancelUnfilledEntry (defense in depth -- see
 * that function's own comment). Generalized 2026-10-07 (OCO build) from the STOP-only original --
 * callers pass purpose explicitly, no behavior change for existing STOP call sites. */
async function getLegStatus(setupId, purpose) {
  const r = await query(
    `SELECT status, server_order_id, client_order_id FROM order_placements WHERE setup_id = $1 AND purpose = $2 ORDER BY id DESC LIMIT 1`,
    [setupId, purpose]
  );
  return r.rows[0] || null;
}
async function getStopStatus(setupId) { return getLegStatus(setupId, 'STOP'); }

/** Best-effort cancel of a still-resting (non-terminal) protective leg (STOP or TARGET) -- a leg
 * that outlives the position it protected is a naked order waiting to fire later (see file
 * header). Never throws -- a failed cancel is loud-logged, not fatal to the caller's own action.
 * For a native-OCO bracket (submitOcoOrder), the server cancels the sibling leg itself on a fill
 * -- this function's own role there is only the "ahead of a flatten" case below, where the app's
 * OWN simulated resolution logic decided to close a position the broker's bracket hasn't settled
 * yet (e.g. the app's price-walk hit a wider/trailing exit before either native leg filled). */
async function cancelRestingLeg(dtcClient, setupId, legStatus, context) {
  if (!legStatus || TERMINAL_STATUSES.has(legStatus.status) || !legStatus.server_order_id) return false;
  try {
    dtcClient.cancelOrder({ serverOrderId: legStatus.server_order_id, clientOrderId: legStatus.client_order_id });
    console.log(`[sierraChart.reconciliation] setup_id=${setupId}: canceled resting leg ${legStatus.client_order_id} (${context}).`);
    return true;
  } catch (err) {
    console.error(`[sierraChart.reconciliation] setup_id=${setupId}: failed to cancel resting leg ${legStatus.client_order_id} (${context}) -- it may still be live, investigate directly in Sierra Chart:`, err);
    return false;
  }
}
async function cancelRestingStop(dtcClient, setupId, stopStatus, context) { return cancelRestingLeg(dtcClient, setupId, stopStatus, context); }

// A working/pending EXIT order already exists (idempotency guard against a double-flatten
// under two overlapping polls).
const EXIT_LIVE_STATUSES = ['PENDING_SUBMIT', 'SUBMITTED', 'ORDER_SENT', 'PENDING_OPEN', 'OPEN', 'PARTIALLY_FILLED', 'PENDING_CANCEL', 'PENDING_CANCEL_REPLACE', 'FILLED'];

/**
 * Place a real exit (close) order -- ALWAYS on the OPPOSITE side of the real entry fill,
 * using ONLY this app's own per-order fill record (getRealFilledQuantity, matched via
 * ClientOrderID -- setup-scoped by construction). NEVER queries the broker's aggregate
 * position to decide quantity/side/attribution anymore (see this file's header -- that
 * was the actual bug). If this app's own record reads zero fill, the only actions are:
 * cancel the still-resting entry (if one exists) or do nothing -- NEVER guess from the
 * broker's aggregate. A real missed-fill scenario is caught by checkPositionInvariant(),
 * which halts and flags rather than silently attributing a wrong quantity/side.
 *
 * Returns one of:
 *   { action: 'FLATTENED', id, clientOrderId, quantity }
 *   { action: 'ALREADY_CLOSED_BY_STOP' }
 *   { action: 'ALREADY_CLOSED_BY_TARGET' }
 *   { action: 'CANCELED_UNFILLED_ENTRY' }
 *   { action: 'ALREADY_EXITING' }
 *   { action: 'NOTHING_TO_DO' }
 */
export async function placeExitOrder(dtcClient, params) {
  // The real, static broker-side STOP (docs/OPEN_THREADS.md's 2026-09-29 "Item 2") may
  // already have closed this position for real, before this app's own simulated
  // resolution logic even noticed -- checked FIRST, before anything else, since acting
  // past this point would submit a real duplicate/naked order (see file header). If the
  // stop is still resting (not yet filled), cancel it below, ahead of the flatten -- a
  // stop that outlives the position it protected is a naked order waiting to fire later.
  const stopStatus = await getStopStatus(params.setupId);
  if (stopStatus?.status === 'FILLED') return { action: 'ALREADY_CLOSED_BY_STOP' };
  // Same check for a native-OCO TARGET leg (2026-10-07, OCO build) -- a position can now
  // close for real via either protective leg, not just the stop.
  const targetStatus = await getLegStatus(params.setupId, 'TARGET');
  if (targetStatus?.status === 'FILLED') return { action: 'ALREADY_CLOSED_BY_TARGET' };

  const existingExit = await query(
    `SELECT 1 FROM order_placements WHERE setup_id = $1 AND purpose = 'EXIT' AND status = ANY($2) LIMIT 1`,
    [params.setupId, EXIT_LIVE_STATUSES]
  );
  if (existingExit.rows.length > 0) return { action: 'ALREADY_EXITING' };

  await cancelRestingStop(dtcClient, params.setupId, stopStatus, 'ahead of a flatten');
  await cancelRestingLeg(dtcClient, params.setupId, targetStatus, 'ahead of a flatten');

  const { filledQuantity, side } = await getRealFilledQuantity(params.setupId);
  if (!filledQuantity || filledQuantity <= 0) {
    const canceled = await cancelUnfilledEntry(dtcClient, params.setupId);
    if (!canceled) {
      console.error(`[sierraChart.reconciliation] setup_id=${params.setupId}: entry filled_quantity reads 0 and there's nothing left to cancel. If a real fill was actually missed, checkPositionInvariant() will catch the broker/app disagreement on the next check and halt -- this function will never guess.`);
    }
    return { action: canceled ? 'CANCELED_UNFILLED_ENTRY' : 'NOTHING_TO_DO' };
  }
  // Broker-truth check before any flatten (2026-10-07, wiring item 3). The app's own STOP row
  // can read non-terminal while the broker has already closed the position (setup 131237:
  // stop filled 19:19, a second BUY exit still went out at 20:33 and opened a long). The
  // broker's position for this symbol is the only thing that knows, so it must agree with
  // this setup's expected open quantity before a market exit is sent. Used as a fail-closed
  // guard only, never to choose side or quantity (see this file's header).
  const snapshot = await getBrokerSnapshot(dtcClient, { collectWindowMs: 3000 });
  const brokerQty = extractPositionForSymbol(snapshot.positionMessages, params.symbol);
  const guard = brokerExitDecision({ brokerQty, entrySide: side, filledQuantity });
  if (!guard.ok) {
    console.error(`[sierraChart.reconciliation] setup_id=${params.setupId}: REFUSED market exit -- ${guard.reason}. Nothing sent. Check the broker's position and order history directly.`);
    return { action: 'REFUSED_BROKER_MISMATCH', reason: guard.reason, brokerQty };
  }
  const clientOrderId = exitClientOrderId(params.setupId);
  const exitParams = { ...params, side: OPPOSITE_SIDE[side], orderType: 'MARKET', quantity: filledQuantity, price1: null, price2: null };
  // onConflictDoNothing=true: the real guarantee against a double-flatten under two
  // overlapping polls is idx_order_placements_one_live_exit_per_setup, not the
  // application-level existingExit check above (which is just a fast path).
  const insertQ = await insertPendingOrder({ ...exitParams, purpose: 'EXIT', clientOrderId }, true);
  if (insertQ.rows.length === 0) return { action: 'ALREADY_EXITING' }; // DB index won the race
  const id = insertQ.rows[0].id;
  await submitAndRecord(dtcClient, id, { ...exitParams, clientOrderId });
  return { action: 'FLATTENED', id, clientOrderId, quantity: filledQuantity };
}

/**
 * Cancel a still-resting, never-filled entry order. Returns true if a cancel was actually
 * sent, false if there was nothing cancelable (no ServerOrderID assigned yet, or the
 * order already reached a terminal state).
 */
export async function cancelUnfilledEntry(dtcClient, setupId) {
  const r = await query(
    `SELECT client_order_id, server_order_id, status FROM order_placements
     WHERE setup_id = $1 AND purpose = 'ENTRY' ORDER BY id DESC LIMIT 1`,
    [setupId]
  );
  if (r.rows.length === 0) return false;
  const row = r.rows[0];
  // PENDING_CANCEL included (DeepSeek code review, 2026-10-13): a cancel already requested
  // (orderSweep.js's escalateUnfilledEntriesToMarket's own optimistic mark, or any other
  // real cancel in flight) needs no SECOND cancelOrder() call -- not technically a terminal
  // DTC status, but "already being canceled" is the same "nothing more to do here" outcome.
  const terminal = ['FILLED', 'CANCELED', 'REJECTED', 'PENDING_CANCEL'].includes(row.status);
  if (terminal || !row.server_order_id) return false; // nothing live to cancel
  // Defense in depth -- should be structurally impossible. A STOP is only ever placed
  // (placeStopOrder, called from handleOrderUpdate) AFTER the matching ENTRY fills, and
  // this function is only reached when the entry's own real fill record reads zero -- so
  // a STOP can't legitimately exist yet at this point. If one somehow does anyway, cancel
  // it too rather than leave a naked order resting with no real position behind it.
  const stopStatus = await getStopStatus(setupId);
  if (stopStatus && !TERMINAL_STATUSES.has(stopStatus.status)) {
    console.error(`[sierraChart.reconciliation] setup_id=${setupId}: a STOP order exists for an entry whose own fill record reads zero -- should be impossible, canceling it defensively.`);
    await cancelRestingStop(dtcClient, setupId, stopStatus, 'defensive -- unfilled entry should never have a live stop');
  }
  dtcClient.cancelOrder({ serverOrderId: row.server_order_id, clientOrderId: row.client_order_id });
  return true;
}

// ---- Terminal-state lattice (2026-09-29, DeepSeek review) -----------------------------
// FILLED is absorbing: once a row is FILLED, no later message -- regardless of arrival
// order or timestamp -- may change its status. CANCELED/REJECTED are terminal too, but a
// late-arriving FILLED is allowed to CORRECT one of those (exactly the real bug found
// live: a genuine fill confirmed after a confusing cancel-rejection message had already
// been applied). filled_quantity can never decrease once set, independent of status.
const TERMINAL_STATUSES = new Set(['FILLED', 'CANCELED', 'REJECTED']);

// FIXED 2026-09-29 (DeepSeek code-review finding #4): the timestamp guard used to apply
// to the terminal-correction path too, which defeated the whole point -- the exact live
// scenario this exists for is a fill at T2, then a cancel attempt REJECTED at T3>T2
// (because it was already filled), where the REJECTED message can arrive and be applied
// BEFORE the FILLED confirmation itself arrives with its own earlier timestamp T2. A
// strict "reject anything older" rule would then silently drop the correcting FILLED
// forever. The fix: the timestamp is now ONLY consulted for non-terminal (working ->
// working) transitions -- a terminal-state correction (CANCELED/REJECTED -> FILLED) is
// always allowed regardless of timestamp, exactly matching this function's own name.
function shouldApplyStatus(currentStatus, incomingStatus, currentTs, incomingTs) {
  if (!incomingStatus) return false;
  if (currentStatus === 'FILLED') return false; // absorbing -- never overwritten
  if (TERMINAL_STATUSES.has(currentStatus)) return incomingStatus === 'FILLED'; // timestamp-independent correction
  return isNewerOrEqual(currentTs, incomingTs); // timestamp only for working -> working transitions
}

// NEVER compare LatestTransactionDateTime to Date.now() or any wall-clock value -- only
// to another LatestTransactionDateTime (it's a Sierra Chart SCDateTime double, not epoch
// millis).
function isNewerOrEqual(currentTs, incomingTs) {
  if (!Number.isFinite(incomingTs)) return true; // no timestamp info -- don't block solely on this
  if (!Number.isFinite(currentTs)) return true; // nothing stored yet
  return incomingTs >= currentTs;
}

/**
 * Wire this to dtcClient.on('orderUpdate', (msg) => handleOrderUpdate(msg, dtcClient))
 * once, at process startup. `dtcClient` is needed to resolve the real price multiplier
 * for broker-reported fill-price fields (see priceMultiplier.js).
 *
 * Every real message is unconditionally appended to order_placements_updates first (a
 * real history -- see this file's header for why that matters), THEN the main row is
 * updated subject to the terminal-state lattice above. Also maintains `position_open` on
 * the ENTRY row -- the DB-enforced singleton invariant every other safety mechanism in
 * this file now depends on (see checkPositionInvariant()) -- and, once an ENTRY newly
 * fills, places the real broker-side STOP (docs/OPEN_THREADS.md's 2026-09-29 "Item 2").
 *
 * Returns `true` if this update just applied a REAL terminal-state transition (newly
 * FILLED, or newly CANCELED/REJECTED) -- connectionManager.js uses this as the trigger
 * for an event-driven reconciliation check (docs/OPEN_THREADS.md's 2026-09-29
 * "Item 1"), separate from the periodic backstop. `false` for every other update
 * (working-state changes, or a message that didn't apply per the terminal-state lattice).
 */
export function handleOrderUpdate(msg, dtcClient) {
  const key = msg.ClientOrderID;
  if (!key) return Promise.resolve(false); // nothing to reconcile against
  // One update at a time per order -- see orderUpdateQueue.js for the 2026-10-05 race.
  return runSerializedByKey(key, () => applyOrderUpdate(msg, dtcClient));
}

async function applyOrderUpdate(msg, dtcClient) {
  const clientOrderId = msg.ClientOrderID;
  if (!clientOrderId) {
    // Not one of ours (a manual Sierra change, or a broker-side action with no client ID). Stored
    // under an UNOWNED: label so the activity log can show it, filtered apart from our own orders
    // (added 2026-10-06). Nothing else reads these rows, and no trading state changes.
    await query(
      `INSERT INTO order_placements_updates (client_order_id, raw_message) VALUES ($1, $2)`,
      [`UNOWNED:${msg.ServerOrderID ?? 0}`, JSON.stringify(msg)]
    ).catch((err) => console.error('[sierraChart.reconciliation] failed to log unowned order update:', err.message));
    return false;
  }

  await query(
    `INSERT INTO order_placements_updates (client_order_id, raw_message) VALUES ($1, $2)`,
    [clientOrderId, JSON.stringify(msg)]
  ).catch((err) => console.error('[sierraChart.reconciliation] failed to log order update (main row processing continues):', err.message));

  const existingQ = await query(
    `SELECT id, setup_id, purpose, symbol, exchange, side, status, filled_quantity, latest_transaction_time,
       trade_account, environment_service, order_type, price1::float AS price1
     FROM order_placements WHERE client_order_id = $1`,
    [clientOrderId]
  );
  if (existingQ.rows.length === 0) return false; // not one of ours
  const row = existingQ.rows[0];

  const incomingStatus = ORDER_STATUS_NAME[msg.OrderStatus] || null;
  const incomingTs = Number.isFinite(msg.LatestTransactionDateTime) ? msg.LatestTransactionDateTime : null;
  const applyStatus = shouldApplyStatus(row.status, incomingStatus, row.latest_transaction_time, incomingTs);

  const newStatus = applyStatus ? incomingStatus : row.status;
  const incomingFilled = realNumberOrNull(msg.FilledQuantity);
  const roundedIncomingFilled = incomingFilled != null ? Math.round(incomingFilled) : null;
  const newTs = applyStatus && incomingTs != null ? incomingTs : row.latest_transaction_time;
  const rejectReason = applyStatus && incomingStatus === 'REJECTED' ? (msg.InfoText || 'rejected, no reason given') : null;
  // A late FILLED correcting a stale REJECTED/CANCELED must clear the now-wrong reject
  // reason -- otherwise a real fill keeps showing a stale "rejected" explanation forever
  // (DeepSeek review minor finding).
  const clearRejectReason = applyStatus && incomingStatus === 'FILLED';

  let avgFillPrice = null;
  const rawAvgFill = realNumberOrNull(msg.AverageFillPrice);
  if (rawAvgFill != null) {
    const mult = await getPriceMultiplier(dtcClient, row.symbol).catch(() => null);
    if (mult != null) {
      const converted = toTickPrice(applyPriceMultiplier(rawAvgFill, mult));
      // Structural sanity (2026-10-05): refuse to store a fill that violates its own order
      // type's price rule. The raw broker message is still in raw_last_order_update, so
      // nothing is lost; only the converted number is withheld. Status is not changed here.
      const check = classifyFill({ orderType: row.order_type, side: row.side, price1: row.price1, fillPrice: converted, infoText: msg.InfoText });
      if (check.status !== 'REFUSED') {
        avgFillPrice = converted;
        if (check.status === 'MARKET_EXECUTION') console.error(`[sierraChart.reconciliation] FLAG market execution for ${row.purpose} setup_id=${row.setup_id} (${clientOrderId}): ${check.reason}. Stored at the broker's quoted price.`);
        console.log(`[sierraChart.reconciliation] fill ${row.purpose} setup_id=${row.setup_id}: raw=${rawAvgFill} x multiplier=${mult} -> ${converted.toFixed(2)} (${row.order_type} ${row.side} px1=${row.price1})`);
      } else {
        console.error(`[sierraChart.reconciliation] REFUSED avg_fill_price for ${row.purpose} setup_id=${row.setup_id} (${clientOrderId}): ${check.reason}. raw=${rawAvgFill} multiplier=${mult} symbol=${row.symbol}. Stored NULL; raw message kept in raw_last_order_update.`);
      }
    } else {
      console.error(`[sierraChart.reconciliation] no price multiplier known for ${row.symbol} -- avg_fill_price left unset for this update rather than storing a possibly-wrong raw value.`);
    }
  }

  // An ENTRY reaching a truly-never-filled terminal state (CANCELED/REJECTED with zero
  // real fill, checked against both the stored AND incoming filled quantity) releases the
  // singleton slot it claimed at insert time. Folded into the SAME UPDATE below via a
  // CASE expression (DeepSeek review finding #3: this must be atomic with the main
  // status/quantity write, not a separate follow-up query a crash could leave stale).
  const releasesPositionSlot = row.purpose === 'ENTRY' && applyStatus
    && (newStatus === 'CANCELED' || newStatus === 'REJECTED')
    && (row.filled_quantity || 0) <= 0 && (roundedIncomingFilled == null || roundedIncomingFilled <= 0);

  await query(`
    UPDATE order_placements SET
      status = $2,
      server_order_id = COALESCE($3, server_order_id),
      filled_quantity = GREATEST(filled_quantity, COALESCE($4, filled_quantity, 0)),
      avg_fill_price = COALESCE($5, avg_fill_price),
      reject_reason = CASE WHEN $9 THEN NULL ELSE COALESCE($6, reject_reason) END,
      raw_last_order_update = $7,
      latest_transaction_time = $8,
      position_open = CASE WHEN $10 THEN FALSE ELSE position_open END,
      last_update_at = now()
    WHERE id = $1
  `, [row.id, newStatus, msg.ServerOrderID || null, roundedIncomingFilled, avgFillPrice, rejectReason, JSON.stringify(msg), newTs, clearRejectReason, releasesPositionSlot]);

  // Fill verification (2026-10-06, flag-only: never halts). After a real FILLED, compare what we
  // stored against what the broker's own message said, and log the result. A mismatch is logged
  // loudly so it can be reviewed; it does not change trading state.
  if (applyStatus && newStatus === 'FILLED') {
    const verify = await query(`SELECT filled_quantity, avg_fill_price::float AS avg FROM order_placements WHERE id = $1`, [row.id]).catch(() => null);
    const stored = verify?.rows?.[0];
    const brokerQty = roundedIncomingFilled;
    const qtyOk = stored && brokerQty != null && stored.filled_quantity === brokerQty;
    const priceOk = stored && avgFillPrice != null && rawAvgFill != null;
    const verdict = qtyOk && priceOk ? 'MATCH' : 'MISMATCH';
    const line = `[sierraChart.fillVerify] ${verdict} ${row.purpose} setup_id=${row.setup_id} ${clientOrderId}: broker qty=${brokerQty} avg=${avgFillPrice ?? 'NULL(refused)'}; app qty=${stored?.filled_quantity ?? 'n/a'} avg=${stored?.avg ?? 'NULL'}`;
    if (verdict === 'MATCH') console.log(line); else console.error(line);
  }

  // EXIT *or* STOP reaching FILLED clears a DIFFERENT row's (the matching ENTRY's)
  // position_open -- a real cross-row write, wrapped in an explicit transaction
  // (DeepSeek review finding #3) so a crash between two separate queries can never leave
  // a stale TRUE behind and permanently jam the singleton slot. STOP was added to this
  // condition 2026-09-29 (Item 2) -- a filled broker-side stop closes the position just
  // as surely as a filled EXIT does, and without this the singleton slot would stay
  // stuck forever (blocking every future real entry) even though the position was
  // legitimately closed. TARGET added 2026-10-07 (OCO build) for the same reason -- a
  // filled native-OCO target closes the position just as surely as a filled stop does.
  if ((row.purpose === 'EXIT' || row.purpose === 'STOP' || row.purpose === 'TARGET') && applyStatus && newStatus === 'FILLED') {
    // Broker-derived P&L on close (2026-10-06). Writes only when both fills are present; never guesses.
    await recordBrokerPnlForSetup(row.setup_id).catch((err) => console.error(`[sierraChart.reconciliation] broker P&L write failed for setup_id=${row.setup_id}:`, err.message));
    const client = await getClient();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE order_placements SET position_open = FALSE WHERE setup_id = $1 AND purpose = 'ENTRY'`, [row.setup_id]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(`[sierraChart.reconciliation] failed to release position_open for setup_id=${row.setup_id} after ${row.purpose} fill -- the singleton slot may be stuck, investigate directly:`, err.message);
    } finally {
      client.release();
    }
  }

  // Real, static broker-side STOP (docs/OPEN_THREADS.md's 2026-09-29 "Item 2") -- placed
  // ONLY here, once the matching ENTRY's own fill is confirmed, never at entry-submission
  // time (a resting STOP with no filled position behind it would be a naked order that
  // OPENS an unwanted position if price reaches it). `applyStatus && newStatus==='FILLED'`
  // is only ever true on the genuine first transition into FILLED (FILLED is absorbing --
  // see shouldApplyStatus above), so this can't double-fire on a repeated/duplicate
  // FILLED message for an already-filled row.
  if (row.purpose === 'ENTRY' && applyStatus && newStatus === 'FILLED') {
    const effectiveFilledQuantity = Math.max(row.filled_quantity || 0, roundedIncomingFilled || 0);
    try {
      // Skip if this ENTRY was submitted as a native-OCO bracket parent (placeBracketEntryOrder,
      // 2026-10-07 OCO build) -- its STOP/TARGET children were already submitted alongside the
      // parent and are sitting PENDING_CHILD on the broker; the server activates them itself on
      // this fill. Placing a second, standalone STOP here would be a real duplicate order.
      const existingStop = await getStopStatus(row.setup_id);
      if (existingStop) {
        console.log(`[sierraChart.reconciliation] setup_id=${row.setup_id}: ENTRY filled, STOP row already exists (bracket child) -- skipping standalone STOP placement.`);
      } else {
        const stopQ = await query(`SELECT stop_level FROM active_setups WHERE id = $1`, [row.setup_id]);
        const stopLevel = stopQ.rows[0]?.stop_level != null ? Number(stopQ.rows[0].stop_level) : null;
        if (stopLevel == null) {
          console.error(`[sierraChart.reconciliation] setup_id=${row.setup_id}: ENTRY filled but active_setups.stop_level is null -- NO real broker-side stop placed. Position is UNPROTECTED at the broker; this app's own internal exit logic is the only remaining protection. Investigate directly.`);
        } else {
          const stopResult = await placeStopOrder(dtcClient, {
            setupId: row.setup_id, stopPrice: stopLevel, entrySide: row.side,
            filledQuantity: effectiveFilledQuantity, symbol: row.symbol, exchange: row.exchange,
            tradeAccount: row.trade_account, environmentService: row.environment_service,
          });
          if (stopResult) console.log(`[sierraChart.reconciliation] placed real STOP for setup_id=${row.setup_id} at ${stopLevel}: ${JSON.stringify(stopResult)}`);
        }
      }
    } catch (err) {
      console.error(`[sierraChart.reconciliation] setup_id=${row.setup_id}: failed to place real broker-side stop after ENTRY fill -- position may be UNPROTECTED at the broker, investigate directly:`, err);
    }
  }

  return applyStatus && TERMINAL_STATUSES.has(newStatus) && row.status !== newStatus;
}

/** This app's OWN per-order fill record for a setup's entry -- the ONLY attribution
 * source for exit quantity/side. Never the broker's aggregate position (see file header).
 * Matches by (setup_id, purpose='ENTRY'), not directly by ClientOrderID -- equivalent in
 * practice since idx_order_placements_one_entry_per_setup guarantees at most one ENTRY
 * row per setup, but noted precisely per a DeepSeek review comment (2026-09-29) that an
 * earlier version of this doc comment overstated the matching mechanism. */
export async function getRealFilledQuantity(setupId) {
  const r = await query(
    `SELECT filled_quantity, side FROM order_placements WHERE setup_id = $1 AND purpose = 'ENTRY' ORDER BY id DESC LIMIT 1`,
    [setupId]
  );
  if (r.rows.length === 0) return { filledQuantity: 0, side: null };
  return { filledQuantity: r.rows[0].filled_quantity || 0, side: r.rows[0].side };
}

/**
 * App-level fast-path check for the two real order-level entry gates that replaced the old
 * strict singleton (isAnotherPositionOpen, 2026-10-13 multi-position-stacking build):
 *   1. Direction conflict -- a new entry whose side opposes any currently-open real position's
 *      side is blocked. Same-direction stacking is allowed (a real single account can hold
 *      several same-direction positions on this one instrument fine); opposite-direction isn't
 *      (they'd just net against each other, and the existing simulated-layer equivalent,
 *      isOppositeDirectionOpen() in acdRiskGates.js, already encodes the same real-money
 *      reasoning for the ACTIVE/SHADOW decision upstream of this real-order layer -- this is
 *      the real-order-level twin of that rule, reading order_placements.side directly rather
 *      than the simulated active_setups table, since the two can legitimately disagree
 *      whenever something else blocks the simulated layer from acting on its own verdict).
 *   2. Capacity -- at most MAX_CONCURRENT_POSITIONS real positions open at once.
 * Both are just a fast path with a readable skip reason -- the REAL checks happen atomically
 * inside insertPendingOrder()/placeMarketEscalationEntryOrder() above (both the `avail`
 * capacity CTE and, as of DeepSeek's 2026-10-13 code review of this same build, a
 * `direction_ok` CTE folded into that SAME statement), which can never be fooled by a stale
 * read here. CAPACITY is airtight (idx_order_placements_position_slot is a real unique
 * index -- a concurrent writer either wins the slot or loses via ON CONFLICT DO NOTHING).
 * DIRECTION is narrowed to the claiming statement's own snapshot but, UNLIKE capacity, has
 * no equivalent unique-index backstop (there is no DB-level way to express "every open ENTRY
 * row shares one side" as a constraint) -- see insertPendingOrder()'s own comment on
 * direction_ok for the honest residual risk and why it's accepted rather than built out
 * further for this app's actual (single-process, sequential-poll) concurrency model.
 */
export async function checkEntryGates(side) {
  const opposite = side === 'BUY' ? 'SELL' : 'BUY';
  const r = await query(`SELECT side FROM order_placements WHERE purpose = 'ENTRY' AND position_open = TRUE`);
  const openSides = r.rows.map((row) => row.side);
  if (openSides.includes(opposite)) return { blocked: true, reason: 'opposite-direction real position already open' };
  if (openSides.length >= MAX_CONCURRENT_POSITIONS) return { blocked: true, reason: `max concurrent positions reached (${MAX_CONCURRENT_POSITIONS})` };
  return { blocked: false, reason: null };
}

/**
 * ONE broker-truth snapshot -- a single requestOpenOrders() + requestCurrentPositions()
 * round trip, collecting every response that arrives within the window. Both
 * reconcileAgainstBroker() and checkPositionInvariant() build on this now (2026-09-29,
 * "Item 1") -- consolidates what used to be two INDEPENDENT requestCurrentPositions()
 * call sites (this function's own predecessor, plus the old getBrokerPositionForSymbol())
 * into one, closing the 2-snapshot race the connectionManager's logon handler used to
 * have no way to avoid (a real position change landing between the two separate requests
 * could make the reconciliation report and the invariant check disagree with each other,
 * both claiming to describe "right now").
 */
export function getBrokerSnapshot(dtcClient, { collectWindowMs = 4000 } = {}) {
  return new Promise((resolve) => {
    const openOrders = [];
    const positionMessages = [];
    // msg.ServerOrderID must be truthy -- found live 2026-09-29: an OPEN_ORDERS_REQUEST
    // response includes a terminator message (OrderUpdateReason=1, but ServerOrderID=""
    // and every other field blank/default, likely Sierra Chart's own NoOrders-style "end
    // of list" signal, mirroring s_PositionUpdate's NoPositions flag) that otherwise
    // passed this filter and showed up as a phantom unknownToApp entry -- exactly the
    // same "permanently blocks arming" risk as the 8 real stale orders this function was
    // just used to clean up, just from a parsing gap instead of real broker clutter.
    const onOrderUpdate = (msg) => { if (msg.OrderUpdateReason === 1 && msg.ServerOrderID) openOrders.push(msg); };
    const onPositionUpdate = (msg) => { positionMessages.push(msg); };
    dtcClient.on('orderUpdate', onOrderUpdate);
    dtcClient.on('positionUpdate', onPositionUpdate);
    dtcClient.requestOpenOrders();
    dtcClient.requestCurrentPositions();
    setTimeout(() => {
      dtcClient.off('orderUpdate', onOrderUpdate);
      dtcClient.off('positionUpdate', onPositionUpdate);
      resolve({ openOrders, positionMessages });
    }, collectWindowMs);
  });
}

/** Strips a trailing ".EXCHANGE" off this app's combined symbol identity (e.g.
 * "MNQZ26.CME" -> "MNQZ26"), mirroring dtcClient.js's _splitSymbolForWire() split point
 * (last '.'). Matching-only -- never used to rebuild or store a symbol anywhere. */
function _bareSymbol(symbol) {
  if (typeof symbol !== 'string') return symbol;
  const dot = symbol.lastIndexOf('.');
  return dot === -1 ? symbol : symbol.slice(0, dot);
}

/** Extract the broker's reported position for one symbol out of a getBrokerSnapshot()'s
 * `positionMessages` -- null if the broker never mentioned this symbol at all within the
 * collection window (unknown, NOT "flat" -- a real NoPositions message for this symbol is
 * what means flat, and resolves to 0 below).
 *
 * FIXED 2026-10-08: confirmed live that a real DTC POSITION_UPDATE for this account reports
 * Symbol="MNQZ26" with Exchange="" (blank) -- the exchange is NOT embedded in Symbol here,
 * unlike what the pre-2026-10-07 order-SUBMISSION code assumed (see dtcClient.js's
 * _splitSymbolForWire header). This app's own symbol identity everywhere else (DB storage,
 * `params.symbol` passed in here) is the combined "MNQZ26.CME" form, so an exact `p.Symbol
 * === symbol` match silently failed against a REAL, matching position -- REFUSED_BROKER_
 * MISMATCH on a legitimate flatten, and the position-invariant check below reading
 * `checked: false` ("no broker response") even though the broker responded fine. Falls back
 * to a bare-symbol match (exact match tried first, in case some account DOES echo the
 * combined form) -- this does not weaken the guard's intent (still refuses on a genuine
 * quantity/side mismatch), it only fixes which broker message counts as "this symbol". */
function extractPositionForSymbol(positionMessages, symbol) {
  const bare = _bareSymbol(symbol);
  const msg = positionMessages.find((p) => p.Symbol === symbol || p.Symbol === bare);
  if (!msg) return null;
  return msg.NoPositions ? 0 : msg.Quantity;
}

/**
 * Pure guard for placeExitOrder (2026-10-07; RELAXED 2026-10-13 for multi-position-stacking --
 * see docs/OPEN_THREADS.md's 2026-10-13 entry). Originally required the broker's signed
 * position to EXACTLY equal this one setup's own expected open (sign * filledQuantity) --
 * correct under the old 0-or-1-position-ever singleton, where this setup's fill was always
 * the ENTIRE broker position. With same-direction stacking now allowed, the broker's
 * aggregate can legitimately include OTHER same-direction setups' open quantity too -- exact
 * equality would wrongly REFUSE a perfectly valid exit the instant a second same-direction
 * position is also open (N real positions all signed the same way sum to N*quantity, not
 * this one setup's 1*quantity). Relaxed to the two things that must still ALWAYS hold,
 * regardless of how many other same-direction positions are open:
 *   1. SIGN: the broker's position must agree with this setup's own entry direction -- a
 *      flat/zero or WRONG-SIGN broker position is exactly the original misattribution risk
 *      this file exists to prevent (see the file header), unaffected by stacking.
 *   2. MAGNITUDE FLOOR: the broker's |position| must be AT LEAST this setup's own filled
 *      quantity -- every contract this setup itself filled is necessarily still counted in
 *      the broker's aggregate until something closes it, so the broker can never
 *      legitimately report LESS than that (a genuine missed-fill/data-integrity problem,
 *      not "other positions are also open," and still refused here exactly as before).
 * It can legitimately report MORE (other same-direction positions contributing to the same
 * signed aggregate) -- that's the one case this relaxation newly allows through. Exported
 * for the offline test.
 */
export function brokerExitDecision({ brokerQty, entrySide, filledQuantity }) {
  if (brokerQty == null) return { ok: false, reason: 'broker reported no position for this symbol (unknown, not flat)' };
  const sign = entrySide === 'BUY' ? 1 : entrySide === 'SELL' ? -1 : null;
  if (sign == null || !(filledQuantity > 0)) return { ok: false, reason: `invalid entry side "${entrySide}" or quantity ${filledQuantity}` };
  const brokerQtyNum = Number(brokerQty);
  const brokerSign = brokerQtyNum > 0 ? 1 : brokerQtyNum < 0 ? -1 : 0;
  if (brokerSign !== sign) return { ok: false, reason: `broker net position ${brokerQty} sign does not match this setup's entry side ${entrySide}` };
  if (Math.abs(brokerQtyNum) < filledQuantity) return { ok: false, reason: `broker net position ${brokerQty} is smaller in magnitude than this setup's own expected open ${sign * filledQuantity}` };
  return { ok: true, reason: null };
}

// How long to wait before the one retry snapshot in checkPositionInvariant() below -- long
// enough for the broker's own position feed to catch up to an ORDER_UPDATE fill confirmation
// this app already applied, short enough not to meaningfully delay a real halt. Not derived
// from a measured distribution of real propagation delays (no such data exists yet) -- a
// reasonable first guess, flagged clearly here so it's a one-line change if it's not enough
// margin in practice.
const INVARIANT_RETRY_DELAY_MS = 1500;

/**
 * Fail-closed invariant check: does the broker's real aggregate position on `symbol`
 * match what this app's own per-order fill records say it SHOULD be? This is the ONLY
 * legitimate use of the broker's aggregate position in this file -- never to decide WHICH
 * setup owns a position or WHAT to submit (see the file header for why that was the bug).
 * On a mismatch, halts new entries via the passed killSwitch and logs loudly -- it never
 * guesses or auto-corrects. Sign convention (positive=long, negative=short) confirmed
 * correct by DeepSeek code review, 2026-09-29: `s_PositionUpdate` has no separate
 * side/direction field, so `Quantity`'s own sign is structurally the only carrier of
 * direction -- still worth a one-time live confirmation against a real short fill, but
 * a wrong sign here would only cause extra halts, never a wrong trade, since this
 * function never acts on the aggregate beyond halting.
 *
 * `snapshot` is an optional pre-fetched getBrokerSnapshot() result -- pass one when a
 * caller (runReconciliation()) already has one from the same broker round trip, so this
 * function doesn't make its own second, independent requestCurrentPositions() call.
 * Fetches its own if omitted, for any direct caller that just wants this check alone.
 */
export async function checkPositionInvariant(dtcClient, killSwitch, symbol, snapshot) {
  // Only sum rows after the invariant baseline (order_placements_invariant_baseline) --
  // reset 2026-09-29 after a confirmed pre-fix data-corruption incident (see this file's
  // header). Historical rows before the baseline have unreliable status/side data that
  // can't be forensically reconstructed; the account was independently verified flat via
  // a direct broker query before the reset, and the user explicitly chose to start this
  // check clean from that point rather than attempt an unreliable historical repair.
  //
  // FIXED 2026-09-29 (DeepSeek code-review finding #1, CRITICAL): the original version
  // summed ENTRY and EXIT contributions SEPARATELY and then SUBTRACTED them -- but `side`
  // already encodes the correct signed direction for BOTH an entry and an exit (a SELL
  // exit closing a long is -qty, a BUY exit closing a short is +qty), so subtracting the
  // exit sum double-counted it. A completed round trip (entry +1, exit -1) computed as
  // 1 - (-1) = 2 instead of the real 0 -- meaning the fail-closed guard would have
  // spuriously halted the system after every single successfully closed trade. The fix is
  // a single signed sum with no purpose split at all. STOP participates too (2026-09-29,
  // Item 2) -- a filled STOP closes a position exactly like a filled EXIT, no query
  // change needed since this sums by filled_quantity*side with no purpose filter at all.
  //
  // Per-row scope, post-baseline (2026-10-07). An earlier attempt scoped this per SETUP so that
  // pre-baseline entries counted with their post-baseline exits. That was wrong: the pre-baseline
  // shorts for setups 127681/127693 had already closed on the broker before 20:36, so counting them
  // cancels real fills the broker holds. Every order placed after the baseline counts on its own.
  // Manual, non-setup fills (setup_id NULL) count the same way.
  const expectedQ = await query(`
    SELECT COALESCE(SUM(filled_quantity * (CASE WHEN side = 'BUY' THEN 1 ELSE -1 END)), 0) AS expected_net
    FROM order_placements
    WHERE symbol = $1
      AND id > (SELECT COALESCE(MAX(baseline_order_id), 0) FROM order_placements_invariant_baseline)
  `, [symbol]);
  const expectedNet = Number(expectedQ.rows[0].expected_net);

  const { positionMessages } = snapshot || (dtcClient?.isLoggedOn ? await getBrokerSnapshot(dtcClient) : { positionMessages: [] });
  const brokerNet = extractPositionForSymbol(positionMessages, symbol);
  if (brokerNet == null) return { checked: false, reason: 'no broker response' };

  let match = brokerNet === expectedNet;
  let finalBrokerNet = brokerNet;
  if (!match && dtcClient?.isLoggedOn) {
    // RETRY (2026-10-13, found live: a real short closed correctly via a real market exit,
    // but this check ran in the same instant and halted on a false mismatch). A real
    // close/fill can win a race against the broker's OWN position feed by a few hundred ms --
    // this app's own fill confirmation (ORDER_UPDATE) can arrive and update expectedNet
    // before the broker's separate aggregate-position feed (POSITION_UPDATE) reflects the
    // same event. One short, fresh re-snapshot (never reusing the stale `snapshot` param
    // that produced the mismatch) catches exactly this case. A GENUINE mismatch will still
    // disagree on the retry too -- this doesn't weaken the check, it just stops it from
    // firing on a timing artifact that resolves itself within about a second.
    await new Promise(resolve => setTimeout(resolve, INVARIANT_RETRY_DELAY_MS));
    const retrySnapshot = await getBrokerSnapshot(dtcClient);
    const retryBrokerNet = extractPositionForSymbol(retrySnapshot.positionMessages, symbol);
    if (retryBrokerNet === expectedNet) {
      console.log(`[sierraChart.reconciliation] position invariant mismatch on ${symbol} resolved on retry (broker now reports ${retryBrokerNet}, matches expected ${expectedNet}) -- a timing race against the broker's own position feed, not a real mismatch. Not halting.`);
      match = true;
      finalBrokerNet = retryBrokerNet;
    } else if (retryBrokerNet != null) {
      finalBrokerNet = retryBrokerNet; // still mismatched -- use the freshest reading in the halt message
    }
  }

  if (!match) {
    killSwitch.halt(`position invariant mismatch on ${symbol}: broker=${finalBrokerNet}, app-expected=${expectedNet}`, 'system-invariant-check');
    console.error(`[sierraChart.reconciliation] POSITION INVARIANT MISMATCH on ${symbol}: broker reports net ${finalBrokerNet}, this app's own fill records expect ${expectedNet}. Kill switch halted. Investigate directly in Sierra Chart before re-arming.`);
  }
  return { checked: true, match, brokerNet: finalBrokerNet, expectedNet };
}

/**
 * Ask the broker directly "what's actually open right now" (both working orders and
 * positions) and compare it against what order_placements believes. Call this once right
 * after every successful logon (closes the restart/reconnect gap) and it's cheap enough
 * to also call periodically while already connected.
 *
 * This function only REPORTS -- it never takes corrective action (the report's own
 * `unknownToApp` finding is what runReconciliation() below acts on with a halt; this
 * function itself stays a pure read). `snapshot` is optional, same as
 * checkPositionInvariant() above -- pass one to avoid a second broker round trip.
 */
export async function reconcileAgainstBroker(dtcClient, opts) {
  const snapshot = opts?.snapshot || await getBrokerSnapshot(dtcClient, opts);
  return buildReconciliationReport(snapshot.openOrders, snapshot.positionMessages.filter((p) => !p.NoPositions));
}

/**
 * Cancel every order currently in the FRESHLY-refetched unknownToApp list (never a
 * caller-supplied/stale one) -- the dashboard's own remediation action for that finding
 * (found live 2026-09-29: 8 old, unrelated manual/ATM bracket orders on already-expired
 * MNQ contracts on Sim1, predating this app, permanently tripping the reconciliation
 * halt). Safe by construction, not just by inspection: `order_placements` always gets its
 * row via `insertPendingOrder()` BEFORE the order ever reaches the broker (placeEntryOrder/
 * placeStopOrder/placeExitOrder all follow this order), so a genuinely app-placed order can
 * never appear in unknownToApp due to a timing race -- everything this cancels is, by the
 * same logic that flagged it, something this app never placed.
 */
export async function cancelUnknownOrders(dtcClient) {
  const report = await reconcileAgainstBroker(dtcClient);
  const results = [];
  for (const o of report.unknownToApp) {
    try {
      dtcClient.cancelOrder({ serverOrderId: o.ServerOrderID, clientOrderId: o.ClientOrderID || '' });
      results.push({ serverOrderId: o.ServerOrderID, symbol: o.Symbol, sent: true });
    } catch (err) {
      results.push({ serverOrderId: o.ServerOrderID, symbol: o.Symbol, sent: false, error: err.message });
    }
  }
  return { attemptedAt: new Date().toISOString(), count: results.length, results };
}

async function buildReconciliationReport(brokerOpenOrders, brokerPositions) {
  const appOpenEntries = await query(`
    SELECT id, setup_id, client_order_id, server_order_id, status, filled_quantity, symbol, side
    FROM order_placements
    WHERE status IN ('SUBMITTED','ORDER_SENT','PENDING_OPEN','OPEN','PARTIALLY_FILLED')
  `);
  const brokerServerIds = new Set(brokerOpenOrders.map((o) => o.ServerOrderID).filter(Boolean));
  const brokerClientIds = new Set(brokerOpenOrders.map((o) => o.ClientOrderID).filter(Boolean));

  const unknownToApp = brokerOpenOrders.filter(
    (o) => !appOpenEntries.rows.some((r) => r.server_order_id === o.ServerOrderID || r.client_order_id === o.ClientOrderID)
  );
  const staleInApp = appOpenEntries.rows.filter(
    (r) => !brokerServerIds.has(r.server_order_id) && !brokerClientIds.has(r.client_order_id)
  );

  return {
    checkedAt: new Date().toISOString(),
    brokerOpenOrderCount: brokerOpenOrders.length,
    brokerPositionCount: brokerPositions.length,
    brokerPositions,
    unknownToApp,
    staleInApp,
    clean: unknownToApp.length === 0 && staleInApp.length === 0,
  };
}

// Single-flight guard (docs/OPEN_THREADS.md's 2026-09-29 "Item 1" spec: "a reconciliation
// already in progress must not start a second overlapping one") -- module-level, so it
// covers every trigger (logon, a terminal order-status transition, the periodic
// backstop, and the dashboard's on-demand manual check) uniformly, regardless of which
// one calls runReconciliation() first.
let reconciliationInFlight = null;

/**
 * The one real entry point for a full reconciliation pass: ONE broker snapshot feeding
 * BOTH the open-orders/positions report AND the position invariant check (see
 * getBrokerSnapshot() above for why sharing one snapshot matters), persisted to
 * `sierra_chart_reconciliation_log` (an append-only history -- never just the in-memory
 * `lastReconciliationReport`/`lastInvariantCheck` connectionManager.js used to hold,
 * matching this file's own order_placements_updates precedent for why a single
 * overwritten "latest" isn't enough), and, on a real `unknownToApp` finding (a broker
 * order this app doesn't recognize at all -- a materially more serious signal than
 * `staleInApp`, a bookkeeping-drift flag), halts new entries via the kill switch. Only
 * `unknownToApp` and the position invariant itself ever halt -- `staleInApp` is
 * flag-only, surfaced on the dashboard but never actioned here (per the spec's explicit
 * "do NOT auto-flatten on an aggregate mismatch" -- this function only ever halts, it
 * never places or cancels an order on its own).
 *
 * `trigger` is one of 'LOGON' | 'TERMINAL_TRANSITION' | 'PERIODIC' | 'MANUAL' -- recorded
 * on the persisted row so a later read can tell what prompted each check.
 */
export async function runReconciliation(dtcClient, killSwitch, symbol, trigger) {
  if (reconciliationInFlight) return reconciliationInFlight;
  reconciliationInFlight = (async () => {
    const snapshot = await getBrokerSnapshot(dtcClient);
    const reconciliationReport = await reconcileAgainstBroker(dtcClient, { snapshot });
    const invariantCheck = await checkPositionInvariant(dtcClient, killSwitch, symbol, snapshot);

    if (reconciliationReport.unknownToApp.length > 0) {
      killSwitch.halt(
        `reconciliation (${trigger}): ${reconciliationReport.unknownToApp.length} broker order(s) on ${symbol} unknown to this app`,
        'system-reconciliation-check'
      );
      console.error(`[sierraChart.reconciliation] UNKNOWN-TO-APP MISMATCH (${trigger}): ${JSON.stringify(reconciliationReport.unknownToApp)}. Kill switch halted. Investigate directly in Sierra Chart before re-arming.`);
    }

    await persistReconciliationFinding(trigger, reconciliationReport, invariantCheck)
      .catch((err) => console.error('[sierraChart.reconciliation] failed to persist reconciliation finding (in-memory result still returned):', err.message));

    return { reconciliationReport, invariantCheck };
  })();
  try {
    return await reconciliationInFlight;
  } finally {
    reconciliationInFlight = null;
  }
}

async function persistReconciliationFinding(trigger, reconciliationReport, invariantCheck) {
  await query(`
    INSERT INTO sierra_chart_reconciliation_log
      (trigger, reconciliation_clean, unknown_to_app_count, stale_in_app_count,
       invariant_checked, invariant_match, broker_net, expected_net, report)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
  `, [
    trigger,
    reconciliationReport.clean,
    reconciliationReport.unknownToApp.length,
    reconciliationReport.staleInApp.length,
    invariantCheck.checked ?? false,
    invariantCheck.match ?? null,
    invariantCheck.brokerNet ?? null,
    invariantCheck.expectedNet ?? null,
    JSON.stringify({ reconciliationReport, invariantCheck }),
  ]);
}

/**
 * The "Stop" button's real action: halt new entries, then cancel/flatten EVERY position
 * this app itself has open (scoped to this app's own order_placements rows only, never
 * touching other orders on the same account), then verify against confirmed
 * order_placements state before reporting success. Automatically benefits from the
 * placeExitOrder() fix above -- no code change needed here, since it never touched the
 * aggregate directly, it just called the (previously buggy) placeExitOrder().
 */
export async function panicStopAppOrders(dtcClient, killSwitch) {
  killSwitch.halt('manual stop (dashboard)', 'user');

  // purpose IN ('EXIT','STOP','TARGET') below (2026-09-29, Item 2; TARGET added 2026-10-07 OCO
  // build) -- a position can now also be legitimately closed by a real, filled broker-side STOP
  // or TARGET, not just an EXIT; excluding only EXIT here would target a setup whose real
  // position is already flat.
  const liveSetups = await query(`
    SELECT DISTINCT a.id, a.setup_type, e.symbol, e.exchange, e.trade_account, e.environment_service
    FROM active_setups a
    JOIN order_placements e ON e.setup_id = a.id AND e.purpose = 'ENTRY'
    WHERE a.origin_status = 'ACTIVE'
      AND NOT EXISTS (SELECT 1 FROM order_placements x WHERE x.setup_id = a.id AND x.purpose IN ('EXIT','STOP','TARGET') AND x.status = 'FILLED')
  `);

  const actions = [];
  for (const row of liveSetups.rows) {
    try {
      const result = await placeExitOrder(dtcClient, {
        setupId: row.id, symbol: row.symbol, exchange: row.exchange,
        tradeAccount: row.trade_account, environmentService: row.environment_service,
      });
      actions.push({ setupId: row.id, setupType: row.setup_type, result });
    } catch (err) {
      actions.push({ setupId: row.id, setupType: row.setup_type, error: err.message });
    }
  }

  await new Promise((resolve) => setTimeout(resolve, 5000));

  const verifyQ = await query(`
    SELECT a.id, a.setup_type, e.status as entry_status, e.filled_quantity as entry_filled,
      EXISTS (SELECT 1 FROM order_placements x WHERE x.setup_id = a.id AND x.purpose IN ('EXIT','STOP','TARGET') AND x.status = 'FILLED') as closed_for_real
    FROM active_setups a
    JOIN order_placements e ON e.setup_id = a.id AND e.purpose = 'ENTRY'
    WHERE a.id = ANY($1)
  `, [liveSetups.rows.map((r) => r.id)]);

  const stillOpen = verifyQ.rows.filter((r) => {
    const entryNeverFilled = !r.entry_filled || r.entry_filled <= 0;
    if (entryNeverFilled) return r.entry_status !== 'CANCELED';
    return !r.closed_for_real;
  });

  return {
    haltedAt: new Date().toISOString(),
    targetedSetupCount: liveSetups.rows.length,
    actions,
    verified: stillOpen.length === 0,
    stillOpen,
  };
}
