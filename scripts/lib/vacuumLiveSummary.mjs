// Summary of the LIVE detector of the user's original expansion rule (scripts/vacuum_live/shadow.py) for the Monitor & Learning page (cv-110): key `vacuumLive` of public/learning_monitor.json. Display only; places NO orders.
import { query } from '../../server/db.js';
const FORWARD_FROM = '2026-11-09';
async function health() { try { const r = await fetch('http://127.0.0.1:8906/health', { signal: AbortSignal.timeout(2000) }); return await r.json(); } catch { return null; } }

// Sim1 orders of the expansion rule (server/services/vacuumLiveOrders.js, 2026-11-09): what became a real order on the simulated account. Display only.
async function ordersSummary() {
  const states = (await query(`SELECT track, COALESCE(order_state, 'WAITING') AS st, count(*)::int n FROM vacuum_live_events WHERE taken AND trade_date >= CURRENT_DATE - 1 GROUP BY 1, 2 ORDER BY 1, 2`)).rows;
  const rows = (await query(`SELECT a.id, a.setup_type, a.status, a.resolution, a.resolution_method, to_char(a.fired_at,'MM-DD HH24:MI:SS') AS t, a.stop_level::float AS stop, a.actual_pnl::float AS pnl,
      (SELECT avg_fill_price::float FROM order_placements o WHERE o.setup_id = a.id AND o.purpose = 'ENTRY' AND o.filled_quantity > 0 LIMIT 1) AS fill
    FROM active_setups a WHERE a.setup_type LIKE 'VACUUM\\_EXP\\_%' ORDER BY a.fired_at DESC, a.id DESC LIMIT 8`)).rows;
  return { states, rows };
}

// Session chart data (2026-11-09, user: "I want to see it on globex and rth"): the current trading session's NQ price line (1-min closes, every 3rd minute) from the 18:00 ET open, and every fire of this session with its entry price, taken flag and result. x = minutes since 18:00 ET of the previous day (0..1320 = 18:00..16:00). Bounded on BOTH sides (price_bars_primary is a view, cv-009).
async function sessionChart() {
  const d = (await query(`SELECT (CURRENT_DATE + CASE WHEN LOCALTIME >= time '18:00' THEN 1 ELSE 0 END)::text AS d`)).rows[0].d;
  const bars = (await query(`SELECT (extract(epoch FROM ts - (($1::date - 1) + time '18:00')) / 60)::int AS m, close::float AS c FROM price_bars_primary
    WHERE symbol = 'NQ' AND ts >= ($1::date - 1) + time '18:00' AND ts < $1::date + time '17:00' AND (extract(epoch FROM ts)::bigint / 60) % 3 = 0 ORDER BY ts`, [d])).rows;
  const fires = (await query(`SELECT (extract(epoch FROM fired_at - (($1::date - 1) + time '18:00')) / 60)::float AS m, track, direction, taken, COALESCE(entry_open, signal_close)::float AS px, net_nostop::float AS net, net_stop25::float AS net_stop, outcome_at IS NOT NULL AS done
    FROM vacuum_live_events WHERE trade_date = $1::date ORDER BY fired_at, id`, [d])).rows;
  return { date: d, bars: bars.map((b) => [b.m, b.c]), fires, lastBarMin: bars.length ? bars[bars.length - 1].m : null };
}

// ROC3 forward arm (register row 36, prereg docs/GLOBEX_ROC3_VACUUM_PREREG_20261110.md; table vacuum_roc3_events, written by shadow.py evaluate_roc3). Globex only, log only, NO orders. Forward = late_min < 3 (rows replayed after a restart are backfill and never counted).
// Judged next to the live GBX ROC10 track after >= 30 forward TAKEN events. Display only; absent / failing => the card says so (cv-112).
async function roc3Summary() {
  const fw = (await query(`SELECT count(*)::int n, count(DISTINCT trade_date)::int days, count(*) FILTER (WHERE taken)::int taken, count(*) FILTER (WHERE taken AND outcome_at IS NOT NULL)::int taken_done,
      avg(net_nostop) FILTER (WHERE taken)::float net_nostop, avg(net_stop25) FILTER (WHERE taken)::float net_stop25, sum(net_nostop) FILTER (WHERE taken)::float sum_nostop
    FROM vacuum_roc3_events WHERE COALESCE(late_min, 0) < 3`)).rows[0];
  const backfill = (await query(`SELECT count(*)::int n FROM vacuum_roc3_events WHERE COALESCE(late_min, 0) >= 3`)).rows[0].n;
  const recent = (await query(`SELECT trade_date::text d, to_char(fired_at,'HH24:MI') t, direction, signal_close::float sc, zroc::float z, taken, late_min::float late, net_nostop::float nn, net_stop25::float ns, outcome_at IS NOT NULL AS done
      FROM vacuum_roc3_events ORDER BY fired_at DESC, id DESC LIMIT 8`)).rows;
  const roc10 = (await query(`SELECT count(*) FILTER (WHERE taken)::int taken, avg(net_nostop) FILTER (WHERE taken)::float net_nostop FROM vacuum_live_events WHERE track = 'GBX' AND trade_date >= $1`, [FORWARD_FROM])).rows[0];
  return { forward: fw, backfill, recent, roc10Gbx: roc10, floorTaken: 30,
    rule: 'ROC3 ARM (Globex only, log only, no orders): the same expansion rule as the live Globex track with ONE change, the rate of change is over 3 bars instead of 10 (the Sierra ROC 10 to 3 idea). Explore 2023-25 result: NOT SHOWN (continuation -1.59 pt, reversion -2.41, ROC3 minus ROC10 +0.43, nothing survives Holm; the 2.0 pt cost is the whole gap).',
    next: { review: 'Judge after at least 30 TAKEN forward events (late under 3 min) next to the live Globex ROC10 track: net per trade above the 2.0 pt cost already included, day-blocked interval above zero, no day above 35 percent of the profit.',
      ifConfirmed: 'If it clears, register a Globex-specific order wiring design and ask for the go.', ifFailed: 'If it does not, this is the second registered null for the question; co-025 then allows retiring it (only the user revives). Until then park, never retire on this log.' } };
}
export async function vacuumLiveSummary() {
  try {
    const h = await health();
    const today = (await query(`SELECT max(trade_date)::text d FROM vacuum_live_events`)).rows[0]?.d || null;
    const recent = (await query(`SELECT trade_date::text d, to_char(fired_at,'HH24:MI:SS') t, track, direction, signal_close::float sc, entry_open::float eo, zroc::float z, roc10::float roc, taken, late_min::float late, fwd30::float f30, net_nostop::float nn, net_stop25::float ns
      FROM vacuum_live_events WHERE trade_date >= $1 ORDER BY fired_at DESC, id DESC LIMIT 12`, [FORWARD_FROM])).rows;
    const sess = today ? (await query(`SELECT track, count(*)::int n, sum(taken::int)::int taken, count(outcome_at)::int done FROM vacuum_live_events WHERE trade_date = $1 GROUP BY track`, [today])).rows : [];
    const fw = (await query(`SELECT track, count(*)::int n, count(DISTINCT trade_date)::int days, count(outcome_at)::int done, avg(net_nostop) FILTER (WHERE taken)::float net_nostop, avg(net_stop25) FILTER (WHERE taken)::float net_stop25, avg(-fwd30 - 2.0) FILTER (WHERE taken)::float net_fade, count(*) FILTER (WHERE taken AND outcome_at IS NOT NULL)::int taken_done, count(*) FILTER (WHERE taken)::int taken, avg(fwd30)::float fwd30
      FROM vacuum_live_events WHERE trade_date >= $1 GROUP BY track`, [FORWARD_FROM])).rows;
    const bar6 = (await query(`SELECT track, COALESCE(b6_src, '-') src, b6_status st, count(*)::int n, count(DISTINCT trade_date)::int days, avg(b6_net_a)::float net_a, avg(b6_net_b - b6_net_a)::float b_minus_a, avg(b6_net_c - b6_net_a)::float c_minus_a
      FROM vacuum_live_events WHERE taken AND b6_status IS NOT NULL AND trade_date >= $1 GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`, [FORWARD_FROM])).rows;   // forward bar-6 flag (register row 54), display only
    return { state: 'OK', generatedAt: new Date().toISOString(), forwardFrom: FORWARD_FROM, bar6, daemon: h ? { state: h.state, session: h.session, bars: h.bars, events: h.events, errors: h.errors, loopAgeSec: h.loopAt ? Math.round(Date.now() / 1000 - h.loopAt) : null, lastTick: h.lastTick } : null,
      today, sessionCounts: sess, forward: fw, recent, chart: await sessionChart().catch((e) => ({ error: e.message })), orders: await ordersSummary().catch((e) => ({ error: e.message })), roc3: await roc3Summary().catch((e) => ({ error: e.message })),
      rule: 'LIQUIDITY PULL (formerly the vacuum / expansion rule): ROC10 expansion onset (|Z_ROC10| > 2, SMA50 +-2 SD, direction = the sign of ROC10). BOTH Globex and RTH fire: enter at the next bar open, hold 30 bars (hard flat 09:29:50 Globex, 15:55 RTH), one position at a time per track (taken = yes). In the research Globex expansions continued in 2026 (not significant) and RTH expansions REVERTED, so for RTH the fade-equivalent (trade against the expansion) is shown next to the with-expansion result.',
      next: { review: 'Forward sample only. Judge the Globex candidate after at least 30 TAKEN events: net per trade above 2.0 pt after the 2.0 pt cost, positive at a 3.0 pt cost, day-blocked interval above zero, no day above 35 percent of the profit (prereg A5); the held-back sessions are reserved for one pre-registered look.',
        ifConfirmed: 'If the forward sample clears that bar, write the order wiring design (Sim1) and ask for the go.', ifFailed: 'If it does not, the idea stays parked, never retired on this log alone (CLAUDE.md co-025).' },
      notes: ['The taken fires are REAL ORDERS on the simulated account Sim1 (2026-11-09; server/services/vacuumLiveOrders.js): market entry, broker stop 2.5 x EMA10(TR), exit at 30 bars or the hard flat. The numbers below are the detector\'s own paper outcomes; the order P&L is shown under Orders. Outcomes fill after 30 bars: net of a 2.0 pt cost, with no stop (net_nostop) and with the V0 stop 2.5 x EMA10(TR) (net_stop25).', 'Research (explore, 2026 depth era): Globex no-stop 30-bar hold +4.6 pt per trade [-4.0, +13.3], not significant, worst trade -194 pt; RTH expansions revert about -3.5 pt over 30 bars (with-expansion net about -5.5 after cost).'] };
  } catch (e) { return { state: 'ERROR', error: e.message }; }
}
