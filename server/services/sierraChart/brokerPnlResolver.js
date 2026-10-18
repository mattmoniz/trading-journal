// Resolves, or at least EXPLAINS, a filled live trade that has no broker_pnl (added 2026-10-18).
//
// Why this exists: recordBrokerPnlForSetup() tries exactly once, from one place, using one source
// (the main order_placements rows). When it fails nothing ever retries and nothing says why, and
// dllGate.js used to turn that single missing number into a day-long entry block (Thu/Fri
// 2026-10-15/16: 67 entries skipped). A missing P&L is a DATA question, not a loss-limit one.
//
// Ladder, cheapest/most certain first. Never writes a guessed number into broker_pnl:
//   1. The normal writer (entry + exit fill prices on the order rows).
//   2. The raw ORDER_UPDATE log (order_placements_updates) -- it keeps every real fill message even
//      when the main row's avg_fill_price was never set (e.g. the 2026-10-06 price-multiplier era).
//   3. Otherwise classify WHY it is unknown from independent evidence and persist that cause
//      (gated_candidates, gate_name 'PNL_UNKNOWN_CAUSE') so it is queryable and shown to the user:
//        - was an exit ever tracked / refused / retired?
//        - what did the broker's position do (sierra_chart_reconciliation_log net readings)?
//        - did any order message for an UNKNOWN client id arrive (a manual Sierra Chart action)?
//        - was the NQ bar feed missing bars around the close (feed stoppage)?
//        - did the server log errors around the close (tech glitch)?
import { readFile } from 'node:fs/promises';
import { query } from '../../db.js';
import { recordBrokerPnlForSetup } from './brokerPnlWriter.js';
import { brokerPnlFromFills } from './brokerPnl.js';

const ERRORS_FILE = new URL('../../../scratch/server_errors.jsonl', import.meta.url);
const RAW_FILLED_STATUS = 7; // DTC OrderStatusEnum ORDER_STATUS_FILLED, as seen in order_placements_updates

// A raw-message fill price may arrive unscaled (e.g. 3156475 for 31564.75, see priceMultiplier.js).
// Pick whichever reading lands within 5% of the setup's own recorded entry level; never guess beyond that.
function sanePrice(value, reference) {
  if (!Number.isFinite(value) || !Number.isFinite(reference) || reference <= 0) return null;
  for (const v of [value, value / 100]) if (Math.abs(v - reference) / reference < 0.05) return v;
  return null;
}

async function rawFillPrice(clientOrderId, reference) {
  const r = await query(
    `SELECT raw_message FROM order_placements_updates WHERE client_order_id = $1 ORDER BY id DESC`, [clientOrderId]);
  for (const row of r.rows) {
    const m = typeof row.raw_message === 'string' ? JSON.parse(row.raw_message) : row.raw_message;
    if (m?.OrderStatus === RAW_FILLED_STATUS) {
      const p = sanePrice(Number(m.AverageFillPrice || m.LastFillPrice), reference);
      if (p != null) return p;
    }
  }
  return null;
}

async function loadSetup(setupId) {
  const s = await query(`
    SELECT a.id, a.setup_type, a.entry_zone_low::float AS entry_level, a.stop_level::float AS stop_level,
           a.resolution, TO_CHAR(a.resolved_at, 'YYYY-MM-DD HH24:MI:SS') AS resolved_at,
           EXTRACT(EPOCH FROM (a.resolved_at AT TIME ZONE 'America/New_York')) * 1000 AS resolved_ms
    FROM active_setups a WHERE a.id = $1`, [setupId]);
  if (!s.rows[0]) return null;
  const legs = await query(`
    SELECT id, purpose, status, side, client_order_id, server_order_id, avg_fill_price::float AS avg,
           TO_CHAR(last_update_at, 'YYYY-MM-DD HH24:MI:SS') AS last_update_at
    FROM order_placements WHERE setup_id = $1 ORDER BY id`, [setupId]);
  return { ...s.rows[0], legs: legs.rows };
}

// Step 2: rebuild entry/exit fill prices from the raw message log and compute P&L the standard way.
async function tryRawMessageFills(setup) {
  const entry = setup.legs.find(l => l.purpose === 'ENTRY' && l.status === 'FILLED');
  const exit = [...setup.legs].reverse().find(l => ['STOP', 'EXIT', 'TARGET'].includes(l.purpose) && l.status === 'FILLED');
  if (!entry || !exit) return null;
  const entryAvg = entry.avg ?? await rawFillPrice(entry.client_order_id, setup.entry_level);
  const exitAvg = exit.avg ?? await rawFillPrice(exit.client_order_id, setup.entry_level);
  const pnl = brokerPnlFromFills({ entrySide: entry.side, entryAvg, exitAvg });
  return pnl == null ? null : { pnl, entryAvg, exitAvg };
}

async function gatherEvidence(setup) {
  const entry = setup.legs.find(l => l.purpose === 'ENTRY' && l.status === 'FILLED');
  const from = entry?.last_update_at ?? setup.resolved_at;
  const out = { feedGapBars: null, unknownOrderMessages: null, serverErrors: null, brokerReadings: [] };

  // Broker position readings the app recorded between the fill and 30min after resolution.
  const rec = await query(`
    SELECT TO_CHAR(checked_at, 'HH24:MI:SS') AS t, broker_net::float AS broker_net, expected_net::float AS expected_net
    FROM sierra_chart_reconciliation_log
    WHERE broker_net IS NOT NULL AND checked_at BETWEEN $1::timestamp AND $2::timestamp + interval '30 minutes'
    ORDER BY checked_at`, [from, setup.resolved_at]);
  out.brokerReadings = rec.rows;

  // Order messages for client ids this app never created (a manual action in Sierra Chart).
  const unk = await query(`
    SELECT COUNT(*)::int AS n FROM order_placements_updates u
    WHERE u.received_at BETWEEN $1::timestamp AND $2::timestamp + interval '10 minutes'
      AND NOT EXISTS (SELECT 1 FROM order_placements o WHERE o.client_order_id = u.client_order_id)`, [from, setup.resolved_at]);
  out.unknownOrderMessages = unk.rows[0].n;

  // Feed stoppage: expected ~10 one-minute NQ bars in +-5min of the close.
  const bars = await query(`
    SELECT COUNT(*)::int AS n FROM price_bars_primary
    WHERE symbol = 'NQ' AND ts BETWEEN $1::timestamp - interval '5 minutes' AND $1::timestamp + interval '5 minutes'`, [setup.resolved_at]);
  out.feedGapBars = Math.max(0, 11 - bars.rows[0].n);

  // Tech glitch: anything the server logged as an error within +-5min of the close.
  try {
    const lines = (await readFile(ERRORS_FILE, 'utf8')).trim().split('\n').slice(-5000);
    let n = 0;
    for (const line of lines) {
      let j; try { j = JSON.parse(line); } catch { continue; }
      if (Math.abs(Date.parse(j.ts) - setup.resolved_ms) <= 5 * 60000) n++;
    }
    out.serverErrors = n;
  } catch { out.serverErrors = null; }
  return out;
}

// Estimated exit-price range for a close the app saw no fill for: NQ bars between the last reading that
// still showed the position and the first that showed it flat. Informational only -- never written to broker_pnl.
async function estimateRange(setup, readings) {
  const open = [...readings].reverse().find(r => r.broker_net !== 0);
  const flat = readings.find(r => r.broker_net === 0 && (!open || r.t > open.t));
  if (!open || !flat) return null;
  const day = setup.resolved_at.slice(0, 10);
  const b = await query(`
    SELECT MIN(low)::float AS lo, MAX(high)::float AS hi FROM price_bars_primary
    WHERE symbol='NQ' AND ts BETWEEN ($1 || ' ' || $2)::timestamp AND ($1 || ' ' || $3)::timestamp`, [day, open.t, flat.t]);
  if (b.rows[0].lo == null) return null;
  return { openAt: open.t, flatAt: flat.t, lo: b.rows[0].lo, hi: b.rows[0].hi };
}

export function classify(setup, ev) {
  const exitLeg = setup.legs.find(l => ['STOP', 'EXIT', 'TARGET'].includes(l.purpose) && l.status === 'FILLED');
  const retired = setup.legs.some(l => l.purpose === 'EXIT' && /^RETIRED-/.test(l.client_order_id || ''));
  const last = ev.brokerReadings[ev.brokerReadings.length - 1];
  const wentFlat = ev.brokerReadings.some(r => r.broker_net === 0);
  if (exitLeg) return 'EXIT_FILLED_PRICE_MISSING';
  if (retired) return 'EXIT_RETIRED_BROKER_FLAT';
  if (wentFlat && ev.unknownOrderMessages === 0) return 'SILENT_CLOSE_NO_ORDER_MESSAGE';
  if (wentFlat) return 'CLOSED_BY_UNTRACKED_ORDER';
  if (last && last.broker_net !== 0) return 'POSITION_MAY_STILL_BE_OPEN';
  return 'UNDETERMINED_NO_BROKER_READING';
}

const CAUSE_TEXT = {
  EXIT_FILLED_PRICE_MISSING: 'an exit fill exists but its price could not be read',
  EXIT_RETIRED_BROKER_FLAT: 'the exit was retired because the broker no longer held the position',
  SILENT_CLOSE_NO_ORDER_MESSAGE: 'the broker went flat with NO order message for it -- consistent with a manual Flatten/Reverse in Sierra Chart or a broker/sim-side close',
  CLOSED_BY_UNTRACKED_ORDER: 'the broker went flat via an order this app did not create (manual action in Sierra Chart)',
  POSITION_MAY_STILL_BE_OPEN: 'the last broker reading still showed an open position -- check Sierra Chart',
  UNDETERMINED_NO_BROKER_READING: 'no broker position reading was recorded around the close',
};

async function persistCause(setupId, setupType, text) {
  await query(`
    INSERT INTO gated_candidates (trade_date, setup_type, gate_name, gate_reason)
    VALUES (CURRENT_DATE, $1::varchar, 'PNL_UNKNOWN_CAUSE', $2::text)`, [setupType, `setup_id=${setupId} ${text}`]);
}

export async function resolveUnknownBrokerPnl(setupId) {
  const first = await recordBrokerPnlForSetup(setupId).catch(() => ({ written: false }));
  if (first.written) return { resolved: true, source: 'order rows', pnl: first.pnl };

  const setup = await loadSetup(setupId);
  if (!setup) return { resolved: false, reason: 'setup not found' };

  const raw = await tryRawMessageFills(setup);
  if (raw) {
    await query(`UPDATE active_setups SET broker_pnl = $2, pnl_source = 'BROKER' WHERE id = $1 AND broker_pnl IS NULL`, [setupId, raw.pnl]);
    await persistCause(setupId, setup.setup_type, `RESOLVED from raw order messages: entry ${raw.entryAvg} exit ${raw.exitAvg} -> broker P&L ${raw.pnl.toFixed(2)}`);
    return { resolved: true, source: 'raw order messages', pnl: raw.pnl };
  }

  const ev = await gatherEvidence(setup);
  const cause = classify(setup, ev);
  const est = await estimateRange(setup, ev.brokerReadings);
  let estText = '';
  const entry = setup.legs.find(l => l.purpose === 'ENTRY' && l.status === 'FILLED');
  if (est && entry && Number.isFinite(entry.avg)) {
    const a = brokerPnlFromFills({ entrySide: entry.side, entryAvg: entry.avg, exitAvg: est.lo });
    const b = brokerPnlFromFills({ entrySide: entry.side, entryAvg: entry.avg, exitAvg: est.hi });
    estText = ` Estimated (NOT written to broker_pnl): position closed between ${est.openAt} and ${est.flatAt}, NQ range ${est.lo}-${est.hi}, P&L somewhere in ${Math.min(a, b).toFixed(0)} to ${Math.max(a, b).toFixed(0)} dollars.`;
  }
  const flags = [
    ev.feedGapBars > 2 ? `price feed missing ${ev.feedGapBars} bars near the close` : 'price feed looked normal',
    ev.serverErrors ? `${ev.serverErrors} server error(s) logged within 5min` : 'no server errors logged within 5min',
    `${ev.unknownOrderMessages ?? '?'} order message(s) for unknown client ids`,
  ].join('; ');
  await persistCause(setupId, setup.setup_type, `${cause}: ${CAUSE_TEXT[cause]}. ${flags}.${estText}`);
  return { resolved: false, cause };
}

// Called from the order sweep. Cheap: one query for candidates; per-row work only for setups not already
// diagnosed in the last 30 minutes.
export async function sweepUnknownPnl() {
  const rows = await query(`
    SELECT a.id FROM active_setups a
    JOIN order_placements e ON e.setup_id = a.id AND e.purpose = 'ENTRY' AND e.status = 'FILLED'
    WHERE a.origin_status = 'ACTIVE' AND a.status IN ('RESOLVED','EXPIRED') AND a.broker_pnl IS NULL
      AND a.resolved_at < NOW() - interval '3 minutes' AND a.trade_date >= CURRENT_DATE - 3
      AND NOT EXISTS (SELECT 1 FROM order_placements x WHERE x.setup_id = a.id AND x.purpose = 'EXIT'
                      AND x.status IN ('PENDING_SUBMIT','SUBMITTED','ORDER_SENT','PENDING_OPEN','OPEN','PARTIALLY_FILLED','PENDING_CANCEL','PENDING_CANCEL_REPLACE'))
      AND NOT EXISTS (SELECT 1 FROM gated_candidates g WHERE g.gate_name = 'PNL_UNKNOWN_CAUSE'
                      AND g.gate_reason LIKE 'setup_id=' || a.id || ' %' AND g.evaluated_at > NOW() - interval '30 minutes')`);
  for (const r of rows.rows) {
    await resolveUnknownBrokerPnl(r.id).catch((err) => console.error(`[sierraChart.pnlResolver] setup_id=${r.id} failed:`, err.message));
  }
}
