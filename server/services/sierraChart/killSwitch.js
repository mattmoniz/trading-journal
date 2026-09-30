// Kill switch for real order placement -- fail-closed, process-restart-safe, and
// externally settable (a human or another process can flip it without going through
// this app's own routes).
//
// DELIBERATELY PORTABLE, same boundary as dtcClient.js: zero imports from
// trading-journal-specific code (no server/db.js, no active_setups knowledge). State
// lives in a small JSON file at a caller-supplied path, not a DB table -- this is what
// lets "stop new" be edited by hand (touch/edit the file directly) independent of this
// app's own Express process or DB credentials, matching the standing design requirement
// (see docs/OPEN_THREADS.md's 2026-09-28 Sierra Chart entry): a kill switch hosted only
// inside the same process it's supposed to gate inherits that process's own blind spots
// -- this codebase has a documented history (a real 4-day/114,824-attempt crash loop)
// of an in-process health check staying "honestly green" the whole time.
//
// FAIL-CLOSED GUARANTEES, all deliberate:
// - A missing, corrupted, or unreadable state file reads as HALTED, never ARMED.
// - forceHaltOnBoot() must be called once by the caller at process startup, UNCONDITIONALLY
//   overwriting whatever the file said before -- a crash/restart never silently resumes
//   armed state. The caller (not this file) decides when "boot" happens.
// - isArmed()/getState() read the file FRESH on every call -- no in-memory caching that
//   only a route mutates. A file edited by hand mid-session, or a second process writing
//   the same path, is always seen on the very next check.
// - Writes are atomic (write to a temp path, then rename) so a reader can never observe
//   a half-written file.
//
// Cancel/flatten (cancelWorkingOrder/flattenPosition) need a LIVE, logged-on DTC
// connection -- they cannot be made process-independent the way "stop new" can, since
// actually canceling or flattening requires talking to the broker. Callers must make
// this limitation visible wherever these are surfaced (e.g. a dashboard): "if this app
// is down, flatten directly in Sierra Chart" -- this file does not, and cannot, paper
// over that gap.

import fs from 'fs';

export class KillSwitch {
  constructor({ stateFilePath }) {
    if (!stateFilePath) throw new Error('KillSwitch requires stateFilePath -- never defaulted, never hardcoded.');
    this._path = stateFilePath;
  }

  /** Call once at process startup. Unconditionally forces HALTED regardless of the
   * file's prior contents -- the fail-closed-on-restart guarantee. */
  forceHaltOnBoot(reason = 'process restart (fail-closed default)') {
    this._write({
      armed: false, armedAt: null, armedBy: null,
      haltedAt: new Date().toISOString(), haltedReason: reason, haltedBy: 'system-boot',
    });
  }

  /** Fresh read every call -- never cache this. */
  isArmed() {
    return this._read().armed === true;
  }

  /** Fresh read every call -- full state for display (armedAt/armedBy/haltedReason etc). */
  getState() {
    return this._read();
  }

  arm(by = 'unknown') {
    this._write({
      armed: true, armedAt: new Date().toISOString(), armedBy: by,
      haltedAt: null, haltedReason: null, haltedBy: null,
    });
  }

  halt(reason = 'manual halt', by = 'unknown') {
    this._write({
      armed: false, armedAt: null, armedBy: null,
      haltedAt: new Date().toISOString(), haltedReason: reason, haltedBy: by,
    });
  }

  _read() {
    try {
      if (!fs.existsSync(this._path)) {
        return { armed: false, haltedReason: 'no state file yet -- fail closed', haltedAt: null };
      }
      const parsed = JSON.parse(fs.readFileSync(this._path, 'utf8'));
      if (typeof parsed.armed !== 'boolean') {
        return { armed: false, haltedReason: 'state file malformed (armed not a boolean) -- fail closed' };
      }
      return parsed;
    } catch (e) {
      // A corrupted/unreadable file fails closed too -- never interpret a read error as "armed."
      return { armed: false, haltedReason: `state file unreadable: ${e.message} -- fail closed` };
    }
  }

  _write(state) {
    const tmp = `${this._path}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, this._path); // atomic on POSIX -- no reader ever observes a partial write
  }

  /**
   * Cancel a still-working order. Requires a live, logged-on DtcClient AND the order's
   * ServerOrderID (see dtcClient.js's cancelOrder() doc comment for why ClientOrderID
   * alone can't identify it). Throws synchronously if dtcClient isn't logged on -- the
   * caller should catch and surface that as "cannot cancel, not connected," not silently
   * swallow it.
   */
  cancelWorkingOrder(dtcClient, { serverOrderId, clientOrderId }) {
    return dtcClient.cancelOrder({ serverOrderId, clientOrderId });
  }

  /**
   * Flatten an open position by submitting an opposite-side market order for the same
   * quantity. Same live-connection requirement as cancelWorkingOrder -- this is a real
   * new order, not a broker-side "flatten" primitive (DTC has no such single command).
   */
  flattenPosition(dtcClient, { symbol, exchange, quantity, side, clientOrderId }) {
    const oppositeSide = side === 'BUY' ? 'SELL' : 'BUY';
    return dtcClient.submitOrder({ symbol, exchange, side: oppositeSide, orderType: 'MARKET', quantity, clientOrderId });
  }
}
