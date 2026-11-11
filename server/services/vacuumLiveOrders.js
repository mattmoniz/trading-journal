// Sim1 order wiring of the user's ORIGINAL expansion rule (2026-11-09, user: "why do you resist to wire them live"). Rule: scripts/vacuum_live/shadow.py logs ROC10 expansion onsets to vacuum_live_events (both Globex and RTH);
// the events it marks `taken` (one position per track at a time) become REAL orders on the SIMULATED account by writing ordinary active_setups rows -- NO new order-submission code, exactly like amtTellOrders.js:
// orderSweep.js sweepEntries() places the MARKET entry (VACUUM_EXP_ is in MARKET_ENTRY_PREFIXES), reconciliation.js places the protective STOP at stop_level after the fill, and when this service marks the row RESOLVED
// sweepExits() flattens at market. The generic resolver (resolveSetups.js VACUUM_EXP_ branch) walks the stop and backstops at expires_at (the hard flat); structural invalidation skips these rows.
//
// Rules (fixed in writing before any order): 1 MNQ, both tracks (Globex entries until 09:25, RTH 09:35-15:50, set by the detector), entry = next bar open ~ the fire (market), stop = signal close -/+ 2.5 x EMA10(TR) (the
// spec's V0 stop; the detector's `etr`), NO profit target (t1_level is an unreachable placeholder, SIERRA_USE_OCO_BRACKET must stay off), exit = 30 bars after the entry bar (the detector writes outcome_at when that bar exists)
// or the hard flat (09:29:50 Globex, 15:55 RTH, 13:10 on early closes) via expires_at, or the broker stop. SIM ONLY: the type is exempt from the roster gate only while DTC_AUTO_REARM_SAFE=true (setupTypes.js).
// NOT a validated edge: the research has no significant result; this is a forward test the user asked to see live.
//
// Safety: VACUUM_EXP_ORDERS.enabled is the kill switch; the service pauses ITSELF in memory (and for the day, via amt_tell_alarms kinds VAC_*) on any misfire (stuck ACTIVE row, generic mark-to-market resolution, double entry,
// unflattened position). An event is entered only while FRESH (age since the signal bar closed <= maxAgeSec), never on a restart/catch-up replay. Naive ET timestamp strings straight from the database, never JS Date-parsed.
import { FIRE_TAG_COLS, fireTagValues } from './fireTags.js';
import { createStrategyService, isBusyAcrossFamilies, RESOLVE_SQL } from './strategyOrderCore.js';
import { getBetClass } from '../config/setupTypes.js';
import { LIVE_INSTRUMENT } from '../config/instruments.js';
import { getEarlyCloseMinute } from './marketCalendar.js';

export const VACUUM_EXP_ORDERS = { enabled: true, pollMs: 5000, stopMult: 2.5, t1PlaceholderDist: 5000, maxAgeSec: 150, tracks: { GBX: true, RTH: true } };

/** Pure: the protective stop of an event: the signal close -/+ stopMult x EMA10(TR) (the detector's V0 stop, measured from the entry, which is the next open ~ the signal close). */
export const stopOf = (e, mult = VACUUM_EXP_ORDERS.stopMult) => Number(e.signal_close) - Number(e.direction) * mult * Number(e.etr);

/** Pure: should this logged event be ordered? e = vacuum_live_events row; ctx = { ageSec, busy, lastClose, armed }. */
export function decideEntry(e, ctx, cfg = VACUUM_EXP_ORDERS) {
  const dir = Number(e.direction);
  if (!(dir === 1 || dir === -1) || !(Number(e.etr) > 0) || !Number.isFinite(Number(e.signal_close))) return { action: 'SKIP', state: 'SKIPPED_NOSTOP' };
  if (!cfg.tracks[e.track]) return { action: 'SKIP', state: 'SKIPPED_TRACK' };
  if (!e.taken) return { action: 'SKIP', state: 'SKIPPED_NOTTAKEN' };
  if (ctx.armed === false) return { action: 'SKIP', state: 'SKIPPED_DISARMED' };                // kill switch off: no order can be placed, so no ACTIVE row either (a ghost row would block the next event)
  if (e.outcome_at != null || ctx.ageSec == null || ctx.ageSec > cfg.maxAgeSec) return { action: 'SKIP', state: 'SKIPPED_STALE' };   // already finished or a catch-up/restart replay: never entered after the fact
  if (ctx.busy) return { action: 'SKIP', state: 'SKIPPED_BUSY' };                              // one position at a time (any open order position, any setup)
  if (ctx.lastClose != null) {
    const stop = stopOf(e);
    if (dir === 1 ? ctx.lastClose <= stop : ctx.lastClose >= stop) return { action: 'SKIP', state: 'SKIPPED_PRICE' };   // price already through the stop: the order would open at a loss
  }
  return { action: 'INSERT' };
}

/** Pure: the hard-flat clock of the row (naive ET string). Globex ends 09:29:50; RTH 15:55, or 13:10 on an early close. */
export function expiresAtOf(e) {
  const hhmmss = e.track === 'GBX' ? '09:29:50' : (getEarlyCloseMinute(e.trade_date) != null ? '13:10:00' : '15:55:00');
  return `${e.trade_date} ${hhmmss}`;
}

/** The active_setups INSERT (exported so scripts/test_vacuum_live_orders.mjs can dry-run the exact statement against the real schema in a rolled-back transaction). */
export function buildInsert(e, fireTags = null, cfg = VACUUM_EXP_ORDERS) {
  const dir = Number(e.direction), setupType = `VACUUM_EXP_${dir === 1 ? 'LONG' : 'SHORT'}`, entry = Number(e.signal_close), stop = Math.round(stopOf(e, cfg.stopMult) * 100) / 100;
  const expiresAt = expiresAtOf(e), t1 = dir === 1 ? entry + cfg.t1PlaceholderDist : entry - cfg.t1PlaceholderDist;
  const sql = `
    INSERT INTO active_setups (trade_date, setup_type, fired_at, expires_at, status, origin_status, entry_zone_low, entry_zone_high, stop_level, t1_level, t1_label, price_at_detection, suppression_reason,
                               ${FIRE_TAG_COLS.join(', ')}, bet_class)
    VALUES ($1,$2,$3,$4,'ACTIVE','ACTIVE',$5,$5,$6,$7,$8,$5,NULL, ${FIRE_TAG_COLS.map((_, i) => `$${9 + i}`).join(', ')}, $${9 + FIRE_TAG_COLS.length})
    ON CONFLICT DO NOTHING RETURNING id`;
  const params = [e.trade_date, setupType, e.fired_at, expiresAt, entry, stop, t1, 'NO_TARGET (30-bar hold / hard flat written by vacuumLiveOrders.js)', ...fireTagValues(fireTags || {}), getBetClass(setupType)];
  return { sql, params, setupType, entryAt: e.fired_at, expiresAt, t1, stop };
}
export { RESOLVE_SQL };   // shared (strategyOrderCore.js)

/** Pure: how to resolve the row of a finished event. orders = { entryFilled, avgFill, stopFilled } from order_placements (broker truth). Values fit resolution VARCHAR(20) / resolution_method VARCHAR(20); none is MARK_TO_MARKET. */
export function decideExit(e, orders) {
  if (!orders.entryFilled) return { resolution: 'NOT_FILLED', method: 'VAC_NO_FILL', pnl: null, exitPx: null };
  const dir = Number(e.direction), entry = Number(e.entry_open);
  const stopped = String(e.exit_note || '').includes('+stop') || orders.stopFilled;
  const flat = String(e.exit_note || '').includes('flat-clamped');
  // detector exit price: the 30-bar close (fwd30 is the dir-signed move from the entry open), or the stop (net_stop25 = signed move - 2.0 cost)
  const exitPx = stopped && e.net_stop25 != null ? entry + dir * (Number(e.net_stop25) + 2.0) : entry + dir * Number(e.fwd30);
  let pnl = null;
  if (orders.avgFill != null && Number.isFinite(exitPx)) pnl = Math.round((((exitPx - Number(orders.avgFill)) * dir) * LIVE_INSTRUMENT.dollarsPerPoint - LIVE_INSTRUMENT.commissionPerRoundTrip) * 100) / 100;   // real entry fill replaces the theoretical entry (resolveSetups.js convention)
  else if (e.net_nostop != null) pnl = Math.round(Number(stopped ? e.net_stop25 : e.net_nostop) * LIVE_INSTRUMENT.dollarsPerPoint * 100) / 100;   // no fill price recorded: the detector's own net (points, cost included) in dollars
  return { resolution: stopped ? 'STOP_HIT' : 'TIME_EXPIRED', method: stopped ? 'VAC_STOP' : (flat ? 'VAC_FLAT' : 'VAC_HOLD30'), pnl, exitPx: Number.isFinite(exitPx) ? exitPx : null };
}

const svc = createStrategyService({ logName: 'vacuumLiveOrders', cfg: VACUUM_EXP_ORDERS, pauseKindSql: "kind LIKE 'VAC\\_%'", statusExtra: () => ({ tracks: VACUUM_EXP_ORDERS.tracks }) });

// Fable audit F26 (2026-11-11): the state/alarm/pause/runner/status skeleton and the event-table entry and exit loops live in strategyOrderCore.js; only the strategy stays here.
async function considerEntries() { return svc.considerEventEntries({ eventTable: 'vacuum_live_events', extraWhere: "", setupTypes: ['VACUUM_EXP_LONG', 'VACUUM_EXP_SHORT'], decideEntry, buildInsert, isBusy: isBusyAcrossFamilies }); }
async function syncExits() { return svc.syncEventExits('vacuum_live_events', decideExit); }

async function reconcile() {
  svc.state.problem = null;
  await svc.checkStuckActive('vacuum_live_events', 'VAC_STUCK_ACTIVE');
  await svc.checkGenericResolution('VACUUM\\_EXP\\_%', 'VAC_GENERIC_RESOLUTION');
  await svc.checkUnflattened('VACUUM\\_EXP\\_%', 'VAC_UNFLATTENED');
  await svc.checkDoubleEntry('VACUUM\\_EXP\\_%', 'VAC_DOUBLE_ENTRY');
  if (svc.state.selfPaused && !svc.state.problem) svc.state.problem = `self-paused: ${svc.state.selfPaused}`;
}

export async function runVacuumLiveOrdersOnce() { return svc.runOnce({ reconcile, syncExits, considerEntries }); }
export function startVacuumLiveOrders() { svc.start(runVacuumLiveOrdersOnce); }
export function stopVacuumLiveOrders() { svc.stop(); }
export function getVacuumLiveOrdersStatus() { return svc.status(); }
