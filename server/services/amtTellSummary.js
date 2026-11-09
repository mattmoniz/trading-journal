// Read-only summary of the live node-ladder tell detector (Stage 1, watch only) for quick-check.html's Tell tab: GET /api/setups/amt-tell?date=YYYY-MM-DD.
// Data: amt_tell_trades / amt_tell_sessions / amt_tell_alarms (scripts/migrate_amt_tell_live_20261028.mjs), written by scripts/amt_tell_live/sidecar.py. Timestamps are naive ET and are returned as
// text, never parsed with JS Date (CLAUDE.md naive-timestamp rule). Per-trade means are sum/N, not day-weighted.
import { query } from '../db.js';
import { cacheGet, cacheSet } from '../lib/cache.js';
import { getTellContextForDate } from './tellContextSummary.js';
import { getTellContextStatus } from './tellContextServiceManager.js';

const BOOKS = ['V1', 'V3', 'V1P'];

function summarize(rows) {
  const out = {};
  for (const book of BOOKS) {
    const b = rows.filter((r) => r.book === book);
    const closed = b.filter((r) => r.status === 'CLOSED');
    const net = closed.reduce((s, r) => s + (r.net_dollars || 0), 0);
    out[book] = {
      n: b.length, longs: b.filter((r) => r.direction === 1).length, shorts: b.filter((r) => r.direction === -1).length, open: b.length - closed.length, closed: closed.length,
      netClosed: Math.round(net * 100) / 100, perTradeClosed: closed.length ? Math.round((net / closed.length) * 100) / 100 : null,
      broke: closed.filter((r) => r.broke).length,
    };
  }
  return out;
}

/** 1-minute NQ bars of the session (18:00 ET the day before through 17:00 ET of the date) for the Tell chart. Bounded on BOTH sides (price_bars_primary is a view). Cached: 60 s for a live session, 6 h for a finished one. */
async function sessionBars(date) {
  if (!date) return [];
  const key = `amtTell:bars:${date}`, hit = cacheGet(key); if (hit) return hit;
  const r = await query(`SELECT to_char(ts, 'YYYY-MM-DD HH24:MI') AS t, close::float AS c, high::float AS h, low::float AS l FROM price_bars_primary
                         WHERE symbol = 'NQ' AND ts >= ($1::date - 1) + time '18:00' AND ts < $1::date + time '17:00' ORDER BY ts`, [date]);
  const live = date >= new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  return cacheSet(key, r.rows, live ? 60_000 : 6 * 3600_000);
}

export async function getAmtTellSummary(date) {
  const dates = (await query(`SELECT d FROM (SELECT trade_date::text AS d FROM amt_tell_trades UNION SELECT trade_date::text FROM amt_tell_sessions) x ORDER BY d DESC LIMIT 25`)).rows.map((r) => r.d);
  const useDate = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : (dates[0] || null);
  let sessions = [], trades = [];
  if (useDate) {
    sessions = (await query(`SELECT bar_rule, contract, state, n_bars, last_tick_at::text AS last_tick_at, n_trades::float AS n_trades, contracts::float AS contracts, rth_contracts::float AS rth_contracts, db_rth_contracts::float AS db_rth_contracts,
                                    vol_diff_pct::float AS vol_diff_pct, baseline_n, tail_backwards, updated_at::text AS updated_at
                             FROM amt_tell_sessions WHERE trade_date = $1 ORDER BY bar_rule`, [useDate])).rows;
    trades = (await query(`SELECT id, bar_rule, book, sig_idx, direction, fired_at::text AS fired_at, entry_idx, entry_at::text AS entry_at, entry_price::float AS entry_price, stop_price::float AS stop_price, risk_points::float AS risk_points,
                                  stop_fallback, details, status, exit_idx, exit_bar_start::text AS exit_bar_start, exit_reason, exit_points::float AS exit_points, net_dollars::float AS net_dollars, broke, mfe_points::float AS mfe_points,
                                  late_min::float AS late_min, detected_at::text AS detected_at, active_setup_id, order_state
                           FROM amt_tell_trades WHERE trade_date = $1 ORDER BY fired_at, book, sig_idx`, [useDate])).rows;
  }
  const alarms = (await query(`SELECT at::text AS at, kind, detail FROM amt_tell_alarms WHERE at > NOW() - interval '48 hours' ORDER BY at DESC LIMIT 12`)).rows;
  const byRule = {};
  for (const rule of ['split', 'whole']) byRule[rule] = summarize(trades.filter((r) => r.bar_rule === rule));
  const ctx = await getTellContextForDate(useDate);          // context of each fire (tell_context_fires); null where the reader has not written one yet
  for (const t of trades) t.context = ctx[String(t.id)] || null;
  return { generatedAt: new Date().toISOString(), date: useDate, dates, sessions, summary: byRule, trades, alarms, bars: await sessionBars(useDate), contextProblem: getTellContextStatus().problem };
}
