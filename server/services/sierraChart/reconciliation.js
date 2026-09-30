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
import { getPriceMultiplier, applyPriceMultiplier } from './priceMultiplier.js';

export function entryClientOrderId(setupId) { return `E${setupId}`; }
export function exitClientOrderId(setupId) { return `X${setupId}-${Date.now()}`; }
export function stopClientOrderId(setupId) { return `S${setupId}`; }

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
  return query(`
    INSERT INTO order_placements
      (setup_id, purpose, client_order_id, symbol, exchange, side, order_type, quantity, price1, price2, trade_account, environment_service, status, position_open)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'PENDING_SUBMIT',$13)
    ${conflictClause}
    RETURNING id
  `, [setupId, purpose, clientOrderId, symbol, exchange, side, orderType, quantity, price1 ?? null, price2 ?? null, tradeAccount ?? null, environmentService ?? null, positionOpen]);
}

async function submitAndRecord(dtcClient, id, { symbol, exchange, side, orderType, quantity, price1, price2, timeInForce, clientOrderId }) {
  try {
    dtcClient.submitOrder({ symbol, exchange, side, orderType, quantity, price1, price2, timeInForce, clientOrderId });
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
 * Place a real entry order for a real active_setups row. ALWAYS submitted as a LIMIT
 * order at the setup's own entry level (user decision, 2026-09-28). `entryPrice` is
 * required -- this function does not compute or default it.
 *
 * Returns { id, clientOrderId } on success, or null if an entry order for this setupId
 * already exists (the idempotency short-circuit -- NOT an error).
 */
export async function placeEntryOrder(dtcClient, { entryPrice, ...params }) {
  if (!Number.isFinite(entryPrice)) throw new Error('placeEntryOrder(): entryPrice is required (LIMIT entry at the setup\'s own level, never MARKET).');
  const clientOrderId = entryClientOrderId(params.setupId);
  const fullParams = { ...params, orderType: 'LIMIT', price1: entryPrice };
  const insertQ = await insertPendingOrder({ ...fullParams, purpose: 'ENTRY', clientOrderId }, true);
  if (insertQ.rows.length === 0) return null;
  const id = insertQ.rows[0].id;
  await submitAndRecord(dtcClient, id, { ...fullParams, clientOrderId });
  return { id, clientOrderId };
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

/** The setup's own most recent STOP row, or null if none exists. Used by placeExitOrder
 * (recognize an already-closed-by-stop setup, and cancel a still-resting stop ahead of a
 * flatten) and cancelUnfilledEntry (defense in depth -- see that function's own comment). */
async function getStopStatus(setupId) {
  const r = await query(
    `SELECT status, server_order_id, client_order_id FROM order_placements WHERE setup_id = $1 AND purpose = 'STOP' ORDER BY id DESC LIMIT 1`,
    [setupId]
  );
  return r.rows[0] || null;
}

/** Best-effort cancel of a still-resting (non-terminal) STOP -- a stop that outlives the
 * position it protected is a naked order waiting to fire later (see file header). Never
 * throws -- a failed cancel is loud-logged, not fatal to the caller's own action. */
async function cancelRestingStop(dtcClient, setupId, stopStatus, context) {
  if (!stopStatus || TERMINAL_STATUSES.has(stopStatus.status) || !stopStatus.server_order_id) return false;
  try {
    dtcClient.cancelOrder({ serverOrderId: stopStatus.server_order_id, clientOrderId: stopStatus.client_order_id });
    console.log(`[sierraChart.reconciliation] setup_id=${setupId}: canceled resting STOP (${context}).`);
    return true;
  } catch (err) {
    console.error(`[sierraChart.reconciliation] setup_id=${setupId}: failed to cancel resting STOP (${context}) -- it may still be live, investigate directly in Sierra Chart:`, err);
    return false;
  }
}

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

  const existingExit = await query(
    `SELECT 1 FROM order_placements WHERE setup_id = $1 AND purpose = 'EXIT' AND status = ANY($2) LIMIT 1`,
    [params.setupId, EXIT_LIVE_STATUSES]
  );
  if (existingExit.rows.length > 0) return { action: 'ALREADY_EXITING' };

  await cancelRestingStop(dtcClient, params.setupId, stopStatus, 'ahead of a flatten');

  const { filledQuantity, side } = await getRealFilledQuantity(params.setupId);
  if (!filledQuantity || filledQuantity <= 0) {
    const canceled = await cancelUnfilledEntry(dtcClient, params.setupId);
    if (!canceled) {
      console.error(`[sierraChart.reconciliation] setup_id=${params.setupId}: entry filled_quantity reads 0 and there's nothing left to cancel. If a real fill was actually missed, checkPositionInvariant() will catch the broker/app disagreement on the next check and halt -- this function will never guess.`);
    }
    return { action: canceled ? 'CANCELED_UNFILLED_ENTRY' : 'NOTHING_TO_DO' };
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
  const terminal = ['FILLED', 'CANCELED', 'REJECTED'].includes(row.status);
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
export async function handleOrderUpdate(msg, dtcClient) {
  const clientOrderId = msg.ClientOrderID;
  if (!clientOrderId) return false; // nothing to reconcile against

  await query(
    `INSERT INTO order_placements_updates (client_order_id, raw_message) VALUES ($1, $2)`,
    [clientOrderId, JSON.stringify(msg)]
  ).catch((err) => console.error('[sierraChart.reconciliation] failed to log order update (main row processing continues):', err.message));

  const existingQ = await query(
    `SELECT id, setup_id, purpose, symbol, exchange, side, status, filled_quantity, latest_transaction_time,
       trade_account, environment_service
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
      avgFillPrice = applyPriceMultiplier(rawAvgFill, mult);
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

  // EXIT *or* STOP reaching FILLED clears a DIFFERENT row's (the matching ENTRY's)
  // position_open -- a real cross-row write, wrapped in an explicit transaction
  // (DeepSeek review finding #3) so a crash between two separate queries can never leave
  // a stale TRUE behind and permanently jam the singleton slot. STOP was added to this
  // condition 2026-09-29 (Item 2) -- a filled broker-side stop closes the position just
  // as surely as a filled EXIT does, and without this the singleton slot would stay
  // stuck forever (blocking every future real entry) even though the position was
  // legitimately closed.
  if ((row.purpose === 'EXIT' || row.purpose === 'STOP') && applyStatus && newStatus === 'FILLED') {
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
 * App-level fast-path check for the DB-enforced singleton "one real position open,
 * account-wide, at a time" invariant (idx_order_placements_one_open_position is the real
 * guarantee against a race between two overlapping polls -- this just avoids a wasted
 * insert attempt when it's obviously already taken).
 */
export async function isAnotherPositionOpen(excludeSetupId) {
  const r = await query(
    `SELECT 1 FROM order_placements WHERE purpose = 'ENTRY' AND position_open = TRUE AND setup_id != $1 LIMIT 1`,
    [excludeSetupId]
  );
  return r.rows.length > 0;
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

/** Extract the broker's reported position for one symbol out of a getBrokerSnapshot()'s
 * `positionMessages` -- null if the broker never mentioned this symbol at all within the
 * collection window (unknown, NOT "flat" -- a real NoPositions message for this symbol is
 * what means flat, and resolves to 0 below). Preserves the exact matching semantics of
 * the pre-2026-09-29 getBrokerPositionForSymbol() this replaces. */
function extractPositionForSymbol(positionMessages, symbol) {
  const msg = positionMessages.find((p) => p.Symbol === symbol);
  if (!msg) return null;
  return msg.NoPositions ? 0 : msg.Quantity;
}

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

  const match = brokerNet === expectedNet;
  if (!match) {
    killSwitch.halt(`position invariant mismatch on ${symbol}: broker=${brokerNet}, app-expected=${expectedNet}`, 'system-invariant-check');
    console.error(`[sierraChart.reconciliation] POSITION INVARIANT MISMATCH on ${symbol}: broker reports net ${brokerNet}, this app's own fill records expect ${expectedNet}. Kill switch halted. Investigate directly in Sierra Chart before re-arming.`);
  }
  return { checked: true, match, brokerNet, expectedNet };
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

  // purpose IN ('EXIT','STOP') below (2026-09-29, Item 2) -- a position can now also be
  // legitimately closed by a real, filled broker-side STOP, not just an EXIT; excluding
  // only EXIT here would target a setup whose real position is already flat.
  const liveSetups = await query(`
    SELECT DISTINCT a.id, a.setup_type, e.symbol, e.exchange, e.trade_account, e.environment_service
    FROM active_setups a
    JOIN order_placements e ON e.setup_id = a.id AND e.purpose = 'ENTRY'
    WHERE a.origin_status = 'ACTIVE'
      AND NOT EXISTS (SELECT 1 FROM order_placements x WHERE x.setup_id = a.id AND x.purpose IN ('EXIT','STOP') AND x.status = 'FILLED')
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
      EXISTS (SELECT 1 FROM order_placements x WHERE x.setup_id = a.id AND x.purpose IN ('EXIT','STOP') AND x.status = 'FILLED') as closed_for_real
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
