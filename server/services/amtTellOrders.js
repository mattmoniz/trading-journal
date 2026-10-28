// Stage 2 of the live node-ladder tell detector (docs/AMT_TELL_LIVE_PROJECT_SPEC_20261028.md sections 10-11): turns the detector's V1 virtual trades (amt_tell_trades, bar_rule 'split') into REAL orders on the
// SIMULATED account by writing ordinary active_setups rows -- NO new order-submission code. orderSweep.js sweepEntries() places the MARKET entry (AMT_TELL_ is in MARKET_ENTRY_PREFIXES), reconciliation.js
// places the protective STOP at stop_level after the fill, and when this service marks the row RESOLVED, sweepExits() flattens at market. Design reviewed by DeepSeek 2026-10-28 (scratch/deepseek_response_amt_tell_stage2_design_20261028.md).
//
// Rules (all fixed in writing BEFORE any order, spec section 11): V1 book, split reading, 1 MNQ, RTH 10:00-14:30 only (Globex is NOT active), stop = the book's own LVN stop with no cap and no override, NO profit target
// (t1_level is an unreachable placeholder, never checked, SIERRA_USE_OCO_BRACKET must stay off), exits are the detector's own (tell fades after the range breaks / 120-minute no-break exit / 15:55 flatten) written here as
// resolution rows, or the real broker stop. The generic resolver (resolveSetups.js AMT_TELL_ branch) only walks the stop and backstops at expires_at (15:57 ET); structural invalidation skips these rows.
//
// Safety: ENABLED 2026-10-28 evening (shipped disabled until the DeepSeek code review was fixed and re-tested; AMT_TELL_ORDERS.enabled is the kill switch) and pauses ITSELF in memory (no new entries, exits keep being managed) the moment its own reconciliation finds a misfire (stuck row, double entry, a generic-resolver
// resolution). One position at a time for this setup is enforced HERE (the pipeline allows same-direction stacking). A tell is entered only while it is FRESH on the detector's own bar clock (the entry bar is at most one
// completed bar behind), never on a catch-up/restart replay. All timestamps are naive ET strings straight from the database, never JS Date-parsed.
import { query } from '../db.js';
import { computeFireTags, FIRE_TAG_COLS, fireTagValues } from './fireTags.js';
import { dropToTimeline } from './acdShared.js';
import { getBetClass } from '../config/setupTypes.js';
import { LIVE_INSTRUMENT } from '../config/instruments.js';
import { killSwitch } from './sierraChart/orderEligibility.js';

export const AMT_TELL_ORDERS = { enabled: true, barRule: 'split', book: 'V1', pollMs: 5000, t1PlaceholderDist: 5000, expiresAtET: '15:57:00' };
const SIM_TO_RESOLUTION = {
  STOP: ['STOP_HIT', 'TELL_STOP'], STOP_GAP: ['STOP_HIT', 'TELL_STOP'], FADE: ['TIME_EXPIRED', 'TELL_FADE'], TIMEOUT: ['TIME_EXPIRED', 'TELL_TIMEOUT'], EOD: ['TIME_EXPIRED', 'TELL_EOD'], EOS: ['TIME_EXPIRED', 'TELL_EOD'],
};   // resolution VARCHAR(20), resolution_method VARCHAR(20): every value above is <= 12 chars; none is MARK_TO_MARKET/RECOVERY_MTM (REAL_TRADE_FILTER would drop it from real N/EV)

const state = { lastRunAt: null, lastError: null, selfPaused: null, runs: 0, linked: 0, skipped: 0, resolved: 0, problem: null };
const alarmSeen = new Map();

/** Pure: should this logged tell be ordered? t = amt_tell_trades row; ctx = { nBars (completed bars the detector reports), busy, lastClose }. */
export function decideEntry(t, ctx) {
  const sigMin = etMinOf(t.fired_at);                                                           // independent of the sidecar: the research window is signal bars ending 10:00-14:30 ET (the entry is the next bar's open)
  if (!(sigMin >= 600 && sigMin <= 870)) return { action: 'SKIP', state: 'SKIPPED_WINDOW' };
  if (ctx.armed === false) return { action: 'SKIP', state: 'SKIPPED_DISARMED' };               // kill switch off: no order can be placed, so no ACTIVE row either (a ghost row would block the next tell)
  if (t.status !== 'OPEN') return { action: 'SKIP', state: 'SKIPPED_STALE' };                 // already closed when first considered (late start / catch-up): never entered after the fact
  if (ctx.nBars == null || ctx.nBars - t.entry_idx > 1) return { action: 'SKIP', state: 'SKIPPED_STALE' };   // the entry bar is more than one completed bar old on the detector's own clock
  if (ctx.busy) return { action: 'SKIP', state: 'SKIPPED_BUSY' };                              // one position at a time for this setup
  if (ctx.lastClose != null) {
    const long = Number(t.direction) === 1;
    if (long ? ctx.lastClose <= Number(t.stop_price) : ctx.lastClose >= Number(t.stop_price)) return { action: 'SKIP', state: 'SKIPPED_PRICE' };   // price already through the stop: the order would open at a loss
  }
  return { action: 'INSERT' };
}

/** Pure: how to resolve the active_setups row of a CLOSED tell. orders = { entryFilled, stopFilled } from order_placements (broker truth). */
export function decideExit(t, orders) {
  if (!orders.entryFilled) return { resolution: 'NOT_FILLED', method: 'TELL_NO_FILL', pnl: null };      // the trade never opened: sweepExits cancels any resting entry, no phantom P&L
  let [resolution, method] = SIM_TO_RESOLUTION[t.exit_reason] || ['TIME_EXPIRED', 'TELL_EOD'];
  if (orders.stopFilled) { resolution = 'STOP_HIT'; method = 'TELL_STOP'; }                              // the broker stop got there first: broker truth wins
  // P&L convention of resolveSetups.js (2026-10-12 user decision: "use the actual traded price"): the REAL entry fill replaces the theoretical entry; the exit is the detector's exit price.
  // Falls back to the detector's own net only when no fill price is recorded. broker_pnl (the account's real result) is written separately by brokerPnlResolver.
  let pnl = t.net_dollars == null ? null : Math.round(Number(t.net_dollars) * 100) / 100;
  if (orders.avgFill != null && t.entry_price != null && t.exit_points != null) {
    const dir = Number(t.direction), exitPx = Number(t.entry_price) + dir * Number(t.exit_points);
    pnl = Math.round((((exitPx - Number(orders.avgFill)) * dir) * LIVE_INSTRUMENT.dollarsPerPoint - LIVE_INSTRUMENT.commissionPerRoundTrip) * 100) / 100;
  }
  return { resolution, method, pnl };
}

/** The active_setups INSERT for a tell (exported so scripts/test_amt_tell_orders.mjs can dry-run the exact statement against the real schema in a rolled-back transaction). fireTags = computeFireTags(...) result. */
export function buildInsert(t, fireTags = null) {
  const long = Number(t.direction) === 1, setupType = `AMT_TELL_${long ? 'LONG' : 'SHORT'}`, entryAt = t.entry_at;
  const expiresAt = `${t.trade_date} ${AMT_TELL_ORDERS.expiresAtET}`;
  const t1 = long ? t.entry_price + AMT_TELL_ORDERS.t1PlaceholderDist : t.entry_price - AMT_TELL_ORDERS.t1PlaceholderDist;
  const sql = `
    INSERT INTO active_setups (trade_date, setup_type, fired_at, expires_at, status, origin_status, entry_zone_low, entry_zone_high, stop_level, t1_level, t1_label, price_at_detection, suppression_reason,
                               ${FIRE_TAG_COLS.join(', ')}, bet_class)
    VALUES ($1,$2,$3,$4,'ACTIVE','ACTIVE',$5,$5,$6,$7,$8,$5,NULL, ${FIRE_TAG_COLS.map((_, i) => `$${9 + i}`).join(', ')}, $${9 + FIRE_TAG_COLS.length})
    ON CONFLICT DO NOTHING RETURNING id`;
  const params = [t.trade_date, setupType, entryAt, expiresAt, t.entry_price, t.stop_price, t1, 'NO_TARGET (V1 tell-fade / 120-min / 15:55 exits written by amtTellOrders.js)', ...fireTagValues(fireTags || {}), getBetClass(setupType)];
  return { sql, params, setupType, entryAt, expiresAt, t1 };
}
export const RESOLVE_SQL = `UPDATE active_setups SET status = 'RESOLVED', resolution = $2, resolution_method = $3, actual_pnl = $4, price_at_resolution = $5, resolved_at = $6, updated_at = NOW()
                           WHERE id = $1 AND status = 'ACTIVE' AND resolved_at IS NULL RETURNING id`;

const etMinOf = (ts) => Number(String(ts).slice(11, 13)) * 60 + Number(String(ts).slice(14, 16));

async function sessionNBars(tradeDate) {
  const r = await query(`SELECT n_bars FROM amt_tell_sessions WHERE trade_date = $1 AND bar_rule = $2 AND state IN ('LIVE')`, [tradeDate, AMT_TELL_ORDERS.barRule]);
  return r.rows[0]?.n_bars ?? null;
}
async function isBusy() {
  const a = await query(`SELECT 1 FROM active_setups WHERE setup_type LIKE 'AMT\\_TELL\\_%' AND status = 'ACTIVE' LIMIT 1`);
  if (a.rows.length) return true;
  const o = await query(`SELECT 1 FROM order_placements o JOIN active_setups s ON s.id = o.setup_id WHERE s.setup_type LIKE 'AMT\\_TELL\\_%' AND o.position_open = TRUE LIMIT 1`);   // resolved but the flatten is still in flight
  return o.rows.length > 0;
}
async function lastNqClose() {
  const r = await query(`SELECT close::float AS c FROM price_bars_primary WHERE symbol='NQ' AND ts >= NOW()::timestamp - interval '10 minutes' AND ts <= NOW()::timestamp ORDER BY ts DESC LIMIT 1`);
  return r.rows[0]?.c ?? null;
}

async function raiseAlarm(kind, detail, pause) {
  const key = kind + JSON.stringify(detail);
  if (!alarmSeen.has(key)) {
    alarmSeen.set(key, Date.now());
    console.error(`[amtTellOrders] ALARM ${kind}`, detail);
    await query(`INSERT INTO amt_tell_alarms (at, kind, detail) VALUES (NOW()::timestamp, $1, $2)`, [kind.slice(0, 30), JSON.stringify(detail)]).catch(() => {});
  }
  state.problem = `${kind} ${JSON.stringify(detail)}`;
  if (pause && !state.selfPaused) { state.selfPaused = `${kind} at ${new Date().toISOString()}`; console.error(`[amtTellOrders] SELF-PAUSED (no new entries; exits keep being managed): ${state.selfPaused}`); }
}

async function considerEntries() {
  const rows = (await query(`
    SELECT t.id, t.trade_date::text AS trade_date, t.direction, t.status, t.entry_idx, t.entry_at::text AS entry_at, t.entry_price::float AS entry_price, t.stop_price::float AS stop_price, t.risk_points::float AS risk_points, t.fired_at::text AS fired_at
    FROM amt_tell_trades t JOIN amt_tell_sessions s ON s.trade_date = t.trade_date AND s.bar_rule = t.bar_rule AND s.state = 'LIVE'
    WHERE t.bar_rule = $1 AND t.book = $2 AND t.active_setup_id IS NULL AND t.order_state IS NULL ORDER BY t.fired_at`, [AMT_TELL_ORDERS.barRule, AMT_TELL_ORDERS.book])).rows;
  for (const t of rows) {
    // A crash between the insert and the link leaves an unlinked row: re-link it whatever its age (never duplicate, never orphan).
    const existing = (await query(`SELECT id FROM active_setups WHERE trade_date = $1 AND setup_type = $2 AND fired_at = $3`, [t.trade_date, `AMT_TELL_${Number(t.direction) === 1 ? 'LONG' : 'SHORT'}`, t.entry_at])).rows[0];
    if (existing) { await query(`UPDATE amt_tell_trades SET active_setup_id = $2, order_state = 'LINKED' WHERE id = $1 AND active_setup_id IS NULL`, [t.id, existing.id]); state.linked++; continue; }
    const decision = state.selfPaused || !AMT_TELL_ORDERS.enabled
      ? { action: 'SKIP', state: 'SKIPPED_DISABLED' }
      : decideEntry(t, { nBars: await sessionNBars(t.trade_date), busy: await isBusy(), lastClose: await lastNqClose(), armed: killSwitch.isArmed() });
    if (decision.action === 'SKIP') {
      await query(`UPDATE amt_tell_trades SET order_state = $2 WHERE id = $1 AND order_state IS NULL`, [t.id, decision.state]); state.skipped++; continue;
    }
    const fireTags = await computeFireTags(t.trade_date, 'RTH', etMinOf(t.entry_at));
    const { sql, params, setupType, entryAt, expiresAt, t1 } = buildInsert(t, fireTags);
    const ins = await query(sql, params);
    let id = ins.rows[0]?.id;
    if (!id) id = (await query(`SELECT id FROM active_setups WHERE trade_date = $1 AND setup_type = $2 AND fired_at = $3`, [t.trade_date, setupType, entryAt])).rows[0]?.id;   // a crash between insert and link: re-link, never duplicate
    if (!id) { await query(`UPDATE amt_tell_trades SET order_state = 'SKIPPED_DUP' WHERE id = $1`, [t.id]); continue; }
    await query(`UPDATE amt_tell_trades SET active_setup_id = $2, order_state = 'LINKED' WHERE id = $1 AND active_setup_id IS NULL`, [t.id, id]);
    state.linked++; console.log(`[amtTellOrders] ${setupType} setup_id=${id} entry ${t.entry_price} stop ${t.stop_price} (tell #${t.id}, bar ${t.entry_idx})`);
    try { await dropToTimeline({ id, trade_date: t.trade_date, setup_type: setupType, fired_at: entryAt, entry_zone_low: t.entry_price, stop_level: t.stop_price, t1_level: t1, t1_label: 'NO_TARGET', resolution: null, historical_win_rate: null, historical_sessions: null, expires_at: expiresAt }); } catch (_) { /* display only */ }
  }
}

async function syncExits() {
  const rows = (await query(`
    SELECT t.id, t.exit_reason, t.net_dollars::float AS net_dollars, t.exit_points::float AS exit_points, t.entry_price::float AS entry_price, t.direction, t.exit_bar_start::text AS exit_bar_start, a.id AS setup_id
    FROM amt_tell_trades t JOIN active_setups a ON a.id = t.active_setup_id
    WHERE t.status = 'CLOSED' AND a.status = 'ACTIVE' AND a.resolved_at IS NULL`)).rows;
  for (const t of rows) {
    const o = (await query(`SELECT purpose, status, filled_quantity, avg_fill_price::float AS avg_fill_price FROM order_placements WHERE setup_id = $1 AND purpose IN ('ENTRY','STOP')`, [t.setup_id])).rows;
    const entryRow = o.find(x => x.purpose === 'ENTRY' && Number(x.filled_quantity) > 0);
    const orders = { entryFilled: !!entryRow, avgFill: entryRow?.avg_fill_price ?? null, stopFilled: o.some(x => x.purpose === 'STOP' && x.status === 'FILLED') };
    const d = decideExit(t, orders);
    const priceAtRes = t.exit_points == null ? null : t.entry_price + Number(t.direction) * t.exit_points;
    const r = await query(RESOLVE_SQL, [t.setup_id, d.resolution, d.method, d.pnl, priceAtRes, t.exit_bar_start]);   // TOCTOU-safe: the resolver backstop may have got there first
    if (r.rows.length) { state.resolved++; console.log(`[amtTellOrders] resolved setup_id=${t.setup_id} ${d.resolution}/${d.method} pnl ${d.pnl}`); }
  }
}

async function reconcile() {
  state.problem = null;
  const stuck = (await query(`SELECT a.id FROM active_setups a JOIN amt_tell_trades t ON t.active_setup_id = a.id WHERE a.status = 'ACTIVE' AND t.status = 'CLOSED' AND t.updated_at < NOW()::timestamp - interval '3 minutes'`)).rows;
  for (const r of stuck) await raiseAlarm('AMT_STUCK_ACTIVE', { setup_id: r.id }, true);
  const generic = (await query(`SELECT id, resolution, resolution_method FROM active_setups WHERE setup_type LIKE 'AMT\\_TELL\\_%' AND trade_date >= CURRENT_DATE - 1 AND status IN ('RESOLVED','EXPIRED','INVALIDATED')
                                AND (resolution_method IN ('MARK_TO_MARKET','RECOVERY_MTM') OR resolution = 'INVALIDATED')`)).rows;
  for (const r of generic) await raiseAlarm('AMT_GENERIC_RESOLUTION', { setup_id: r.id, resolution: r.resolution, method: r.resolution_method }, true);
  const unflat = (await query(`SELECT a.id FROM active_setups a JOIN order_placements o ON o.setup_id = a.id AND o.purpose = 'ENTRY' WHERE a.setup_type LIKE 'AMT\\_TELL\\_%' AND a.status IN ('RESOLVED','EXPIRED')
                                AND o.position_open = TRUE AND a.resolved_at < NOW()::timestamp - interval '3 minutes'`)).rows;   // resolved, entry filled, but the broker position is still open: the flatten never went out
  for (const r of unflat) await raiseAlarm('AMT_UNFLATTENED', { setup_id: r.id }, true);
  const act = (await query(`SELECT count(*)::int AS n FROM active_setups WHERE setup_type LIKE 'AMT\\_TELL\\_%' AND status = 'ACTIVE'`)).rows[0].n;
  if (act > 1) await raiseAlarm('AMT_DOUBLE_ENTRY', { active_rows: act }, true);
  if (state.selfPaused && !state.problem) state.problem = `self-paused: ${state.selfPaused}`;
}

// The self-pause survives a restart: any pausing alarm raised today (ET) re-pauses the service until the next trading day (clear it deliberately by deleting today's AMT_* alarm rows).
async function loadPause() {
  if (state.selfPaused) return;
  const r = (await query(`SELECT kind FROM amt_tell_alarms WHERE kind IN ('AMT_STUCK_ACTIVE','AMT_GENERIC_RESOLUTION','AMT_DOUBLE_ENTRY','AMT_UNFLATTENED') AND at >= CURRENT_DATE::timestamp ORDER BY at DESC LIMIT 1`)).rows[0];
  if (r) { state.selfPaused = `${r.kind} (restored from today's alarms)`; console.error(`[amtTellOrders] SELF-PAUSED on start: ${state.selfPaused}`); }
}

let timer = null, running = false;
export async function runAmtTellOrdersOnce() {
  if (running) return; running = true;
  try { await loadPause(); await reconcile(); await syncExits(); await considerEntries(); state.lastError = null; }       // reconcile first: a fresh misfire must pause BEFORE any new entry is considered
  catch (e) { state.lastError = e.message; console.error('[amtTellOrders]', e); }
  finally { running = false; state.lastRunAt = Date.now(); state.runs++; }
}
export function startAmtTellOrders() { if (!timer) timer = setInterval(runAmtTellOrdersOnce, AMT_TELL_ORDERS.pollMs); }
export function stopAmtTellOrders() { if (timer) { clearInterval(timer); timer = null; } }
export function getAmtTellOrdersStatus() {
  return { enabled: !!AMT_TELL_ORDERS.enabled && !state.selfPaused, configuredEnabled: !!AMT_TELL_ORDERS.enabled, selfPaused: state.selfPaused, problem: state.problem || (state.lastError ? `orders service error: ${state.lastError}` : null),
           lastRunAgeSec: state.lastRunAt ? Math.round((Date.now() - state.lastRunAt) / 1000) : null, linked: state.linked, skipped: state.skipped, resolved: state.resolved };
}
