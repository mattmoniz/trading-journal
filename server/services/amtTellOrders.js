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
import { getTellContextStatus } from './tellContextServiceManager.js';
import { getRthLiquidation, startDayStateRefresher } from './dayStateService.js';

// override (2026-11-03, docs/TELL_OVERRIDE_LIVE_DESIGN_20261103.md): for fires the context overlay marks AGAINST the order goes the OTHER way (book C: flipped direction, stop just beyond the value edge it defends);
// edgeStop (book B, same direction with the value-edge stop) is built but OFF. enabled:false restores the pure tell. Fail-closed to the TELL, never to a skip: if the context is not ready while the fire is still fresh the tell's
// own order goes out. maxFlipsPerDay and the parity check are automatic stops; the first 5 live flips are a checkpoint for the user (docs/OPEN_THREADS.md).
export const AMT_TELL_ORDERS = { enabled: true, barRule: 'split', book: 'V1', pollMs: 5000, t1PlaceholderDist: 5000, expiresAtET: '15:57:00',
  override: { enabled: true, flip: true, edgeStop: false, waitMs: 20000, maxFlipsPerDay: 2 },
  // Day-state gate (2026-11-09, user: yes to option A; docs/WORKPLAN_20261109.md items F/G): no LONG order while the RTH day state is a LIQUIDATION (dayState.js, replayed over 2023-2026). The
  // skipped tell keeps its virtual result in amt_tell_trades with order_state SKIPPED_LIQ, so the would-have-been trade is scored. Unknown / stale / warm-up state = no gate (fail open to the tell). Longs only (shorts and melt-ups are untouched).
  dayStateGate: { enabled: true } };
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
  if (ctx.dayGate && ctx.dayGate.known && ctx.dayGate.liquidation && Number(t.direction) === 1) return { action: 'SKIP', state: 'SKIPPED_LIQ' };   // LAST on purpose: SKIPPED_LIQ then marks only tells that would otherwise have been ordered, so the ledger measures exactly what this gate changed
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

/** Pure: which book should this fire's order follow? ov = { label, B, C } from tell_context_fires and the shadow books (null while the context row does not exist yet); info = { nBars, ageMs, flipsToday, parityBad }.
 *  Returns { book: 'A' | 'B' | 'C' | 'WAIT' | 'SKIP', eff?, reason?, state? }. A = the tell as it fires. WAIT only while the entry bar has not completed and the fire is younger than cfg.waitMs (so a wait can never
 *  cross decideEntry's freshness gate); after that the TELL's own order goes out (fail to the tell, never to a skip). */
export function chooseBook(t, ov, info, cfg = AMT_TELL_ORDERS.override) {
  if (!cfg || !cfg.enabled) return { book: 'A', reason: 'override off' };
  if (info.parityBad) return { book: 'A', reason: 'a shadow parity failure today: the override is off for the day' };
  const wantsFlip = !!cfg.flip && ov?.label === 'AGAINST';
  const wantsEdge = !wantsFlip && !!cfg.edgeStop && ov != null && ov.label !== 'UNKNOWN';
  const missing = !ov || (wantsFlip && !ov.C) || (wantsEdge && !ov.B);
  if (missing) {
    const forming = info.nBars != null && info.nBars - Number(t.entry_idx) <= 0;
    if (forming && info.ageMs < cfg.waitMs) return { book: 'WAIT' };
    return { book: 'A', reason: 'context not ready while the fire was fresh: the tell as it fires' };
  }
  const pick = (row, book) => {
    if (row.followed_a) return { book: 'A', reason: `book ${book} follows the tell on this fire` };
    if (row.status !== 'OPEN') return { book: 'SKIP', state: 'SKIPPED_BOOKDONE', reason: `book ${book} already closed` };      // the override trade is already over: never ordered after the fact
    return { book, eff: { direction: Number(row.direction), stop_price: Number(row.stop_price), entry_price: Number(row.entry_price) } };
  };
  if (wantsFlip) { if (info.flipsToday >= cfg.maxFlipsPerDay) return { book: 'A', reason: 'daily flip cap reached' }; return pick(ov.C, 'C'); }
  if (wantsEdge) return pick(ov.B, 'B');
  return { book: 'A' };
}
/** Pure: the trade object the order is built from: the tell's row, or the chosen book's direction, stop and entry. */
export function effectiveTrade(t, choice) {
  if (!choice || !choice.eff) return t;
  return { ...t, direction: choice.eff.direction, stop_price: choice.eff.stop_price, entry_price: choice.eff.entry_price, risk_points: Math.abs(choice.eff.entry_price - choice.eff.stop_price) };
}
export const orderStateOf = (book) => (book === 'C' ? 'LINKED_C' : book === 'B' ? 'LINKED_B' : 'LINKED');

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

async function loadOverride(t) {
  const c = (await query(`SELECT label FROM tell_context_fires WHERE tell_trade_id = $1`, [t.id])).rows[0];
  if (!c) return null;
  const s = (await query(`SELECT book, direction, stop_price::float AS stop_price, entry_price::float AS entry_price, status, followed_a FROM tell_shadow_trades WHERE tell_trade_id = $1 AND book IN ('B', 'C')`, [t.id])).rows;
  return { label: c.label, B: s.find((x) => x.book === 'B') || null, C: s.find((x) => x.book === 'C') || null };
}
async function flipsToday(tradeDate) { return (await query(`SELECT count(*)::int AS n FROM amt_tell_trades WHERE trade_date = $1 AND order_state = 'LINKED_C'`, [tradeDate])).rows[0].n; }
async function parityBad(tradeDate) { return (await query(`SELECT count(*)::int AS n FROM tell_shadow_trades WHERE trade_date = $1 AND book = 'A' AND parity_ok = false`, [tradeDate])).rows[0].n > 0; }

async function considerEntries() {
  const rows = (await query(`
    SELECT t.id, t.trade_date::text AS trade_date, t.direction, t.status, t.entry_idx, t.entry_at::text AS entry_at, t.entry_price::float AS entry_price, t.stop_price::float AS stop_price, t.risk_points::float AS risk_points, t.fired_at::text AS fired_at, (EXTRACT(EPOCH FROM (localtimestamp - t.fired_at)) * 1000)::float AS age_ms
    FROM amt_tell_trades t JOIN amt_tell_sessions s ON s.trade_date = t.trade_date AND s.bar_rule = t.bar_rule AND s.state = 'LIVE'
    WHERE t.bar_rule = $1 AND t.book = $2 AND t.active_setup_id IS NULL AND t.order_state IS NULL ORDER BY t.fired_at`, [AMT_TELL_ORDERS.barRule, AMT_TELL_ORDERS.book])).rows;
  for (const t of rows) {
    // A crash between the insert and the link leaves an unlinked row: re-link it whatever its age (never duplicate, never orphan).
    const existing = (await query(`SELECT id, setup_type, stop_level::float AS stop_level FROM active_setups WHERE trade_date = $1 AND fired_at = $2 AND setup_type IN ('AMT_TELL_LONG', 'AMT_TELL_SHORT')`, [t.trade_date, t.entry_at])).rows[0];   // either direction: an overridden order is named for ITS direction
    if (existing) {
      const flipped = (existing.setup_type === 'AMT_TELL_LONG') !== (Number(t.direction) === 1), edge = !flipped && Math.abs(existing.stop_level - t.stop_price) > 0.01;
      await query(`UPDATE amt_tell_trades SET active_setup_id = $2, order_state = $3 WHERE id = $1 AND active_setup_id IS NULL`, [t.id, existing.id, flipped ? 'LINKED_C' : edge ? 'LINKED_B' : 'LINKED']); state.linked++; continue;
    }
    const ov = AMT_TELL_ORDERS.override?.enabled ? await loadOverride(t) : null;
    const info = { nBars: await sessionNBars(t.trade_date), ageMs: t.age_ms, flipsToday: await flipsToday(t.trade_date), parityBad: await parityBad(t.trade_date) };
    const choice = (state.selfPaused || !AMT_TELL_ORDERS.enabled) ? { book: 'A' } : chooseBook(t, ov, info);
    if (choice.book === 'WAIT') continue;                                          // leave order_state NULL: the next poll considers it again, bounded by the entry bar completing
    if (choice.book === 'SKIP') { await query(`UPDATE amt_tell_trades SET order_state = $2 WHERE id = $1 AND order_state IS NULL`, [t.id, choice.state]); state.skipped++; continue; }
    if (choice.reason && choice.book === 'A' && ov?.label === 'AGAINST') console.log(`[amtTellOrders] tell #${t.id} is AGAINST but not overridden: ${choice.reason}`);
    const eff = effectiveTrade(t, choice);
    const decision = state.selfPaused || !AMT_TELL_ORDERS.enabled
      ? { action: 'SKIP', state: 'SKIPPED_DISABLED' }
      : decideEntry(eff, { nBars: info.nBars, busy: await isBusy(), lastClose: await lastNqClose(), armed: killSwitch.isArmed(), dayGate: AMT_TELL_ORDERS.dayStateGate?.enabled ? await getRthLiquidation().catch(() => null) : null });
    if (decision.action === 'SKIP') {
      await query(`UPDATE amt_tell_trades SET order_state = $2 WHERE id = $1 AND order_state IS NULL`, [t.id, decision.state]); state.skipped++; continue;
    }
    const fireTags = await computeFireTags(t.trade_date, 'RTH', etMinOf(t.entry_at));
    const { sql, params, setupType, entryAt, expiresAt, t1 } = buildInsert(eff, fireTags);
    const ins = await query(sql, params);
    let id = ins.rows[0]?.id;
    if (!id) id = (await query(`SELECT id FROM active_setups WHERE trade_date = $1 AND setup_type = $2 AND fired_at = $3`, [t.trade_date, setupType, entryAt])).rows[0]?.id;   // a crash between insert and link: re-link, never duplicate
    if (!id) { await query(`UPDATE amt_tell_trades SET order_state = 'SKIPPED_DUP' WHERE id = $1`, [t.id]); continue; }
    await query(`UPDATE amt_tell_trades SET active_setup_id = $2, order_state = $3 WHERE id = $1 AND active_setup_id IS NULL`, [t.id, id, orderStateOf(choice.book)]);
    state.linked++; console.log(`[amtTellOrders] ${setupType} setup_id=${id} entry ${eff.entry_price} stop ${eff.stop_price} (tell #${t.id}, bar ${t.entry_idx}, book ${choice.book}${choice.book === 'A' ? '' : ' OVERRIDE'})`);
    try { await dropToTimeline({ id, trade_date: t.trade_date, setup_type: setupType, fired_at: entryAt, entry_zone_low: eff.entry_price, stop_level: eff.stop_price, t1_level: t1, t1_label: 'NO_TARGET', resolution: null, historical_win_rate: null, historical_sessions: null, expires_at: expiresAt }); } catch (_) { /* display only */ }
  }
}

async function syncExits() {
  // Every ACTIVE tell-family setup that is linked to a tell row. The exit follows the BOOK the order followed: the tell's own closed row (LINKED), or the closed shadow row of book B / C (LINKED_B / LINKED_C).
  const rows = (await query(`
    SELECT t.id, t.order_state, t.status AS tell_status, t.exit_reason, t.net_dollars::float AS net_dollars, t.exit_points::float AS exit_points, t.entry_price::float AS entry_price, t.direction, t.exit_bar_start::text AS exit_bar_start, a.id AS setup_id
    FROM amt_tell_trades t JOIN active_setups a ON a.id = t.active_setup_id
    WHERE a.status = 'ACTIVE' AND a.resolved_at IS NULL`)).rows;
  for (let t of rows) {
    const book = t.order_state === 'LINKED_C' ? 'C' : t.order_state === 'LINKED_B' ? 'B' : 'A';
    if (book === 'A') { if (t.tell_status !== 'CLOSED') continue; }
    else {
      const sh = (await query(`SELECT status, exit_reason, net_dollars::float AS net_dollars, exit_points::float AS exit_points, entry_price::float AS entry_price, direction, updated_at::text AS updated_at FROM tell_shadow_trades WHERE tell_trade_id = $1 AND book = $2`, [t.id, book])).rows[0];
      if (!sh || sh.status !== 'CLOSED') continue;
      t = { ...t, exit_reason: sh.exit_reason, net_dollars: sh.net_dollars, exit_points: sh.exit_points, entry_price: sh.entry_price, direction: sh.direction, exit_bar_start: sh.updated_at };   // the shadow row carries its own direction and fills
    }
    const o = (await query(`SELECT purpose, status, filled_quantity, avg_fill_price::float AS avg_fill_price FROM order_placements WHERE setup_id = $1 AND purpose IN ('ENTRY','STOP')`, [t.setup_id])).rows;
    const entryRow = o.find(x => x.purpose === 'ENTRY' && Number(x.filled_quantity) > 0);
    const orders = { entryFilled: !!entryRow, avgFill: entryRow?.avg_fill_price ?? null, stopFilled: o.some(x => x.purpose === 'STOP' && x.status === 'FILLED') };
    const d = decideExit(t, orders);
    const priceAtRes = t.exit_points == null ? null : t.entry_price + Number(t.direction) * t.exit_points;
    const r = await query(RESOLVE_SQL, [t.setup_id, d.resolution, d.method, d.pnl, priceAtRes, t.exit_bar_start]);   // TOCTOU-safe: the resolver backstop may have got there first
    if (r.rows.length) { state.resolved++; console.log(`[amtTellOrders] resolved setup_id=${t.setup_id} (book ${book}) ${d.resolution}/${d.method} pnl ${d.pnl}`); }
  }
}

async function reconcile() {
  state.problem = null;
  const stuck = (await query(`SELECT a.id FROM active_setups a JOIN amt_tell_trades t ON t.active_setup_id = a.id WHERE a.status = 'ACTIVE' AND t.status = 'CLOSED' AND t.updated_at < NOW()::timestamp - interval '3 minutes'
                              AND (t.order_state IS NULL OR t.order_state = 'LINKED')`)).rows;   // tell-driven orders only: an overridden order follows its shadow book, not the tell's row
  for (const r of stuck) await raiseAlarm('AMT_STUCK_ACTIVE', { setup_id: r.id }, true);
  // An overridden order follows a SHADOW book written once per completed bar by the context reader. Stale = the reader is not healthy while the book is still OPEN, the book row is MISSING, or the book is CLOSED but the order
  // was not resolved within 3 minutes. Judged on the reader's health, not on row age: a quiet market can legitimately take minutes to complete a 500-contract bar. The broker stop and the 15:57 backstop protect the position meanwhile.
  const rd = getTellContextStatus(), readerBad = !rd.childAlive || rd.healthy === false || (rd.loopAgeSec != null && rd.loopAgeSec > 180);
  const ovRows = (await query(`SELECT a.id, s.status AS sstatus, (s.updated_at < localtimestamp - interval '3 minutes') AS sold FROM active_setups a JOIN amt_tell_trades t ON t.active_setup_id = a.id
                               LEFT JOIN tell_shadow_trades s ON s.tell_trade_id = t.id AND s.book = CASE t.order_state WHEN 'LINKED_C' THEN 'C' ELSE 'B' END
                               WHERE a.status = 'ACTIVE' AND t.order_state IN ('LINKED_B', 'LINKED_C')`)).rows;
  for (const r of ovRows) {
    if (r.sstatus == null) await raiseAlarm('AMT_OVERRIDE_STALE', { setup_id: r.id, why: 'no shadow book row' }, true);
    else if (r.sstatus === 'CLOSED' && r.sold) await raiseAlarm('AMT_OVERRIDE_STALE', { setup_id: r.id, why: 'book closed but the order was not resolved' }, true);
    else if (r.sstatus === 'OPEN' && readerBad) await raiseAlarm('AMT_OVERRIDE_STALE', { setup_id: r.id, why: 'context reader not healthy' }, true);
  }
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
  const r = (await query(`SELECT kind FROM amt_tell_alarms WHERE kind IN ('AMT_STUCK_ACTIVE','AMT_GENERIC_RESOLUTION','AMT_DOUBLE_ENTRY','AMT_UNFLATTENED','AMT_OVERRIDE_STALE') AND at >= CURRENT_DATE::timestamp ORDER BY at DESC LIMIT 1`)).rows[0];
  if (r) { state.selfPaused = `${r.kind} (restored from today's alarms)`; console.error(`[amtTellOrders] SELF-PAUSED on start: ${state.selfPaused}`); }
}

let timer = null, running = false;
export async function runAmtTellOrdersOnce() {
  if (running) return; running = true;
  try { await loadPause(); await reconcile(); await syncExits(); await considerEntries(); state.lastError = null; }       // reconcile first: a fresh misfire must pause BEFORE any new entry is considered
  catch (e) { state.lastError = e.message; console.error('[amtTellOrders]', e); }
  finally { running = false; state.lastRunAt = Date.now(); state.runs++; }
}
export function startAmtTellOrders() { if (!timer) { timer = setInterval(runAmtTellOrdersOnce, AMT_TELL_ORDERS.pollMs); if (AMT_TELL_ORDERS.dayStateGate?.enabled) startDayStateRefresher(); } }
export function stopAmtTellOrders() { if (timer) { clearInterval(timer); timer = null; } }
export function getAmtTellOrdersStatus() {
  return { enabled: !!AMT_TELL_ORDERS.enabled && !state.selfPaused, configuredEnabled: !!AMT_TELL_ORDERS.enabled, override: AMT_TELL_ORDERS.override, selfPaused: state.selfPaused, problem: state.problem || (state.lastError ? `orders service error: ${state.lastError}` : null),
           lastRunAgeSec: state.lastRunAt ? Math.round((Date.now() - state.lastRunAt) / 1000) : null, linked: state.linked, skipped: state.skipped, resolved: state.resolved };
}
