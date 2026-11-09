// Read-only summary of the tell CONTEXT log (tell_context_fires, written by scripts/tell_context/reader.py; docs/TELL_CONTEXT_OVERLAY_SCOPE_20261103.md). Two consumers:
//   getTellContextForDate(date)  -> per-fire context keyed by amt_tell_trades.id, merged into the Tell tab's trade rows (getAmtTellSummary)
//   getTellContextBoard()        -> forward scorecard by label for the Monitor & Learning page (key `tellContext` of GET /api/setups/monitor-summary)
// The label (AGREES / AGAINST / NEUTRAL / UNKNOWN) is a display and learning value. It is NOT VALIDATED, gates nothing and sizes nothing. All P&L here is the tell's MODEL P&L per fire (amt_tell_trades.net_dollars,
// commission included, no slippage), V1 book, split bar rule; means are sum/N, never day-weighted; N below 20 is never called a result (CLAUDE.md hr-008). Timestamps are returned as text (naive ET).
import { query } from '../db.js';
import { cacheGet, cacheSet } from '../lib/cache.js';
import { getTellContextStatus } from './tellContextServiceManager.js';
import { getRotationAtFires } from './rotationGuide.js';
import { FORWARD_FLOORS } from '../config/forwardFloors.js';

const MIN_N = 20;
const LABELS = ['AGREES', 'AGAINST', 'NEUTRAL', 'UNKNOWN'];

export async function getTellContextForDate(date) {
  if (!date) return {};
  const r = await query(`SELECT tell_trade_id::text AS id, label, reason, rth_minutes, val::float AS val, poc::float AS poc, vah::float AS vah, location::float AS location, tail, near_edge, shape_letter, multi_hump, humps,
                                up_broken, down_broken, opposite_broken, nearest_lvn, lvns_within_near, code_version, late_min::float AS late_min,
                                (SELECT fired_at::text FROM amt_tell_trades t WHERE t.id = c.tell_trade_id) AS fired_at,
                                (SELECT watcher_state FROM tell_shadow_trades s WHERE s.tell_trade_id = c.tell_trade_id AND s.book = 'A') AS watcher_state,
                                (SELECT json_object_agg(s.book, json_build_object('dir', s.direction, 'stop', s.stop_price::float, 'net', s.net_dollars::float, 'status', s.status, 'reason', s.exit_reason, 'followed', s.followed_a, 'guard', s.guard))
                                   FROM tell_shadow_trades s WHERE s.tell_trade_id = c.tell_trade_id) AS shadow
                         FROM tell_context_fires c WHERE c.trade_date = $1`, [date]);
  let rot = {}; try { rot = await getRotationAtFires(date, r.rows.map((x) => ({ id: x.id, firedAt: x.fired_at }))); } catch { /* the rotation guide never breaks the per-fire context */ }
  return Object.fromEntries(r.rows.map((x) => [x.id, { ...x, rotation: rot[x.id] ?? null }]));
}


const median = (a) => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y), m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);

/** Watcher: today's (latest session's) state changes, the current state, and the flip-flop count per day (the stability gauge). */
async function watcherBoard() {
  const days = (await query(`SELECT trade_date::text AS d, count(*)::int AS changes FROM tell_watcher_states GROUP BY trade_date ORDER BY trade_date DESC LIMIT 6`)).rows;
  const last = days[0]?.d || null;
  const timeline = last ? (await query(`SELECT to_char(bar_end_et, 'HH24:MI') AS t, state, prev_state, evidence FROM tell_watcher_states WHERE trade_date = $1 ORDER BY bar_idx`, [last])).rows : [];
  const reader = getTellContextStatus();
  return { date: last, current: timeline.length ? timeline[timeline.length - 1].state : null, timeline, perDay: days, flipsPerDay: days.length ? r2(mean(days.map((x) => Math.max(0, x.changes - 1)))) : null, readerState: reader.state };
}

/** Shadow books: per book B and C, over CLOSED fires. A is the tell re-simulated through its own code (control). Dollars are never summed across books; each book is compared with A on the SAME fires. N is counted in fires and in days. */
async function shadowBoard() {
  const rows = (await query(`SELECT b.tell_trade_id::text AS id, b.book, b.trade_date::text AS d, b.net_dollars::float AS bnet, a.net_dollars::float AS anet, b.followed_a, b.label, b.watcher_state, b.guard, a.parity_ok
                             FROM tell_shadow_trades b JOIN tell_shadow_trades a ON a.tell_trade_id = b.tell_trade_id AND a.book = 'A'
                             WHERE b.book IN ('B', 'C', 'D', 'E', 'F') AND b.status = 'CLOSED' AND a.status = 'CLOSED'`)).rows;
  const aRows = (await query(`SELECT net_dollars::float AS net, trade_date::text AS d FROM tell_shadow_trades WHERE book = 'A' AND status = 'CLOSED'`)).rows;
  const parityBad = (await query(`SELECT count(*)::int AS n FROM tell_shadow_trades WHERE book = 'A' AND parity_ok = false`)).rows[0].n;
  const states = (await query(`SELECT COALESCE(watcher_state, 'none') AS state, count(*)::int AS n FROM tell_shadow_trades WHERE book = 'A' GROUP BY 1 ORDER BY 2 DESC`)).rows;
  // LIVE override ledger: the real orders (sim account) that followed book B or C instead of the tell, with the real P&L and the tell's own simulated result on the SAME fire, so the override is never pooled with the tell's results.
  const live = (await query(`SELECT a.id AS setup_id, t.id AS tell_id, t.trade_date::text AS d, t.order_state, a.setup_type, a.status, a.actual_pnl::float AS pnl, a.broker_pnl::float AS broker_pnl, s.net_dollars::float AS tell_sim_net, s.status AS tell_sim_status
                            FROM amt_tell_trades t JOIN active_setups a ON a.id = t.active_setup_id LEFT JOIN tell_shadow_trades s ON s.tell_trade_id = t.id AND s.book = 'A'
                            WHERE t.order_state IN ('LINKED_B', 'LINKED_C') ORDER BY a.fired_at DESC LIMIT 20`)).rows;
  const book = (k, floor = MIN_N, floorDates = 0) => {
    const all = rows.filter((x) => x.book === k), ch = all.filter((x) => !x.followed_a), diffs = ch.map((x) => x.bnet - x.anet);
    return { fires: all.length, changed: ch.length, days: new Set(ch.map((x) => x.d)).size, meanNet: r2(mean(ch.map((x) => x.bnet))), medianNet: r2(median(ch.map((x) => x.bnet))), meanA: r2(mean(ch.map((x) => x.anet))), medianA: r2(median(ch.map((x) => x.anet))),
      meanDiff: r2(mean(diffs)), medianDiff: r2(median(diffs)), better: diffs.filter((v) => v > 0).length, worse: diffs.filter((v) => v < 0).length, same: diffs.filter((v) => v === 0).length, belowFloor: ch.length < floor || new Set(all.map((x) => x.d)).size < floorDates, floor, floorDates };
  };
  // The forward stop books (D, E, F) show COUNTS ONLY until their floor (fires AND dates): a running mean would invite optional stopping and picking the best of three (prereg section 7).
  const stopBook = (k) => { const b = book(k, FORWARD_FLOORS.tellTrades, FORWARD_FLOORS.tellDates); return b.belowFloor ? { ...b, meanNet: null, medianNet: null, meanA: null, medianA: null, meanDiff: null, medianDiff: null, better: null, worse: null, same: null } : b; };
  return { minN: MIN_N, control: { fires: aRows.length, days: new Set(aRows.map((x) => x.d)).size, mean: r2(mean(aRows.map((x) => x.net))), median: r2(median(aRows.map((x) => x.net))) }, parityFailures: parityBad, books: { B: book('B'), C: book('C'), D: stopBook('D'), E: stopBook('E'), F: stopBook('F') }, live, states,
    notes: ['Each book is the tell fire re-simulated with the tell\'s own exit code on the same bars; only the stop (B: just beyond the value edge, 1 typical range of buffer) or the direction and stop (C: flip AGAINST fires, stop beyond the edge it defends) changes. Differs counts fires where the book changed the stop or the direction; some of those still end with the same result (the better / worse / same split shows it). Fires left as the tell are not counted.',
            'Paired difference = the book minus the tell on the SAME fires; dollars are never summed across books. Model P&L per fire with the tell\'s fills (next bar open plus a tick, commission included). NOT VALIDATED, nothing is gated.',
            'Stop-placement books (forward only, from the first fire after the restart that deployed them; docs/TELL_STOP_PLACEMENT_ARMS_PREREG_20261104.md): D = stop behind the 4th node, E = the tell\'s rule on 1-point (Sierra-style) nodes, F = beyond the running RTH extreme. Same entry and exit as the tell, only the stop differs; wider stops win more often and risk more. A lead from explore, NOT a result: judged once at the floor of the tell itself (150 fires on 60 dates).',
            `Below ${MIN_N} changed fires nothing here is a result (D, E and F: below their own floor of ${FORWARD_FLOORS.tellTrades}).`] };
}

async function board() {
  const per = (await query(`SELECT c.label, count(*)::int AS n, count(*) FILTER (WHERE t.status = 'CLOSED')::int AS closed,
                                   count(*) FILTER (WHERE t.status = 'CLOSED' AND t.net_dollars > 0)::int AS wins, count(*) FILTER (WHERE t.status = 'CLOSED' AND t.broke)::int AS broke,
                                   COALESCE(sum(t.net_dollars) FILTER (WHERE t.status = 'CLOSED'), 0)::float AS net, count(DISTINCT c.trade_date)::int AS days
                            FROM tell_context_fires c JOIN amt_tell_trades t ON t.id = c.tell_trade_id WHERE c.book = 'V1' GROUP BY c.label`)).rows;
  const byLabel = Object.fromEntries(LABELS.map((l) => {
    const x = per.find((p) => p.label === l) || { n: 0, closed: 0, wins: 0, broke: 0, net: 0, days: 0 };
    return [l, { ...x, perTrade: x.closed ? Math.round((x.net / x.closed) * 100) / 100 : null, belowFloor: x.closed < MIN_N }];
  }));
  const span = (await query(`SELECT min(trade_date)::text AS first, max(trade_date)::text AS last, count(DISTINCT trade_date)::int AS days, count(*)::int AS rows,
                                    count(*) FILTER (WHERE late_min > 5)::int AS backfilled FROM tell_context_fires WHERE book = 'V1'`)).rows[0];
  // fires of the last 7 days since the reader first wrote a row (V1, split reading; earlier days predate the reader and are expected to be empty) that have NO context row: a reader that was down across a restart or a session change leaves these, and a silent gap is not allowed (hr-001).
  // Recover one session with: venv/bin/python scripts/tell_context/reader.py --once-date YYYY-MM-DD
  const missing = (await query(`SELECT t.trade_date::text AS d, count(*)::int AS n FROM amt_tell_trades t
                                WHERE t.book = 'V1' AND t.bar_rule = 'split' AND t.trade_date >= CURRENT_DATE - 7 AND t.trade_date >= (SELECT min(trade_date) FROM tell_context_fires) AND NOT EXISTS (SELECT 1 FROM tell_context_fires c WHERE c.tell_trade_id = t.id)
                                GROUP BY t.trade_date ORDER BY t.trade_date DESC`)).rows;
  const missingShadow = (await query(`SELECT t.trade_date::text AS d, count(*)::int AS n FROM amt_tell_trades t JOIN tell_context_fires c ON c.tell_trade_id = t.id
                                      WHERE t.book = 'V1' AND t.bar_rule = 'split' AND t.fired_at < localtimestamp - interval '10 minutes' AND NOT EXISTS (SELECT 1 FROM tell_shadow_trades s WHERE s.tell_trade_id = t.id)
                                        AND t.trade_date >= (SELECT min(trade_date) FROM tell_shadow_trades) GROUP BY t.trade_date ORDER BY t.trade_date DESC`)).rows;
  const recent = (await query(`SELECT c.tell_trade_id::text AS id, c.trade_date::text AS d, c.fired_at::text AS fired_at, c.direction, c.entry_price::float AS entry, c.label, c.tail, c.near_edge, c.location::float AS location, c.shape_letter, c.multi_hump,
                                      t.status, t.net_dollars::float AS net, c.late_min::float AS late_min
                               FROM tell_context_fires c JOIN amt_tell_trades t ON t.id = c.tell_trade_id WHERE c.book = 'V1' ORDER BY c.fired_at DESC LIMIT 12`)).rows;
  const [watcher, shadow] = await Promise.all([watcherBoard(), shadowBoard()]);
  return { state: 'OK', minN: MIN_N, span, byLabel, recent, missing, missingShadow, watcher, shadow, reader: getTellContextStatus(),
    notes: ['Labels are NOT VALIDATED and gate nothing. They are the tell fire read against the developing RTH value area (above VAH or near the top: shorts agree; below VAL or near the bottom: longs agree).',
            'Fires before 60 RTH minutes read UNKNOWN (the value area is too young). Rows computed long after the fire (backfill) are counted in span.backfilled; their context uses only the bars through the fire.',
            'BALANCE_CONFIRMED is not built yet: inside a trending drive (a fire that fades a completed break is flagged) AGREES / AGAINST is not meaningful. A narrow value area where both edges are near reads NEUTRAL with that reason.',
            `Model P&L per closed V1 fire, no slippage. A label with fewer than ${MIN_N} closed fires is not a result.`] };
}

export async function getTellContextBoard() {
  const hit = cacheGet('tellContext:board'); if (hit != null) return hit;
  const v = await board();
  return cacheSet('tellContext:board', v, 30_000);
}
