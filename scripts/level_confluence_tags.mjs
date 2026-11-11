#!/usr/bin/env node
// LEVEL-CONFLUENCE TAG LOGGER (register row 33; docs/LEVEL_CONFLUENCE_TAGS_PREREG_20261109.md). Tags every fire of the market setups (AMT tell V1 split, vacuum onsets taken or not, turn-signal ignitions) with the nearest Tier-1 levels at fire time.
// Reads fire tables, level_prices, price_bars_primary; writes only level_confluence_tags. Places no order, changes nothing, lives outside server/ (no restart). Append-only: a tag is written once at first sight and never revised.
// Usage: node scripts/level_confluence_tags.mjs [--dry] [--report]
// FROZEN BEFORE THE FIRST ROW: Tier-1 levels = PD_HIGH PD_LOW PD_VAH PD_VAL PW_HIGH PW_LOW (level_prices, known before the open), ONH ONL (causal from minute bars, only for fires 02:00-17:00 ET, as the capitulation logger), IB_HIGH IB_LOW (only for fires 10:30-16:00 ET,
// when the IB is final). Distances in ADR20 units (same ADR20 as the capitulation logger). No threshold is stored: the binary tags are derived later from the logged distribution (prereg), never here (hr-003).
import { query } from '../server/db.js';
import { emOf } from './lib/floorEngine.mjs';
import { load5m, pivotTimeline, indexByDate, pivotAt } from './lib/pivotContext.mjs';
import { fmtUTC, tsMs, adr20, overnightExtremes } from './lib/levelContext.mjs';
const CODE_VERSION = 'lct-v1';
const args = new Set(process.argv.slice(2)); const DRY = args.has('--dry');
const LEVELS_STATIC = ['PD_HIGH', 'PD_LOW', 'PD_VAH', 'PD_VAL', 'PW_HIGH', 'PW_LOW'];
const minOfDay = (s) => +s.slice(11, 13) * 60 + +s.slice(14, 16);
async function fires() {
  const tell = (await query(`SELECT 'TELL' setup, id, trade_date::text td, direction::int d, fired_at::text f, entry_price::float px, NULL::text track, '{}'::jsonb extra FROM amt_tell_trades WHERE bar_rule='split' AND book='V1' AND entry_price IS NOT NULL`)).rows;
  const vac = (await query(`SELECT 'VACUUM' setup, id, trade_date::text td, direction::int d, fired_at::text f, COALESCE(entry_open, signal_close)::float px, track, jsonb_build_object('taken', taken) extra FROM vacuum_live_events`)).rows;
  const turn = (await query(`SELECT 'TURN' setup, id, trade_date::text td, direction::int d, fired_at::text f, COALESCE(entry_open, signal_close)::float px, track, jsonb_build_object('qualified', qualified, 'taken', taken, 'kind', kind) extra FROM turn_signal_events WHERE kind = 'S2_IGNITION'`)).rows;
  return [...tell, ...vac, ...turn];
}
async function levelsFor(td, f) {
  const L = {}; const pd = (await query(`SELECT level_name, price::float p FROM level_prices WHERE trade_date = $1::date AND level_name = ANY($2)`, [td, [...LEVELS_STATIC, 'IB_HIGH', 'IB_LOW']])).rows;
  if (!pd.some((x) => LEVELS_STATIC.includes(x.level_name))) return null;      // the day's level_prices rows are not written yet (a new Globex session): DEFER, never store an empty tag (append-only)
  for (const x of pd) L[x.level_name] = x.p;
  const m = minOfDay(f); if (m < 630 || m >= 960) { delete L.IB_HIGH; delete L.IB_LOW; }          // IB is final only after 10:30 ET; not an RTH-session level outside RTH
  if (m >= 120 && m < 1020) { const on = await overnightExtremes(td, tsMs(f)); if (on) Object.assign(L, on); }
  return Object.entries(L).filter(([, p]) => Number.isFinite(p)).map(([name, price]) => ({ name, price }));
}
async function main() {
  const all = await fires(); const have = new Set((await query(`SELECT setup || ':' || source_id k FROM level_confluence_tags`)).rows.map((r) => r.k));
  const todo = all.filter((r) => !have.has(`${r.setup}:${r.id}`));
  console.log(`fires ${all.length} (tell ${all.filter((x) => x.setup === 'TELL').length}, vacuum ${all.filter((x) => x.setup === 'VACUUM').length}, turn ${all.filter((x) => x.setup === 'TURN').length}); to tag ${todo.length}${DRY ? ' (dry run)' : ''}`);
  if (!todo.length) return;
  const to = new Date(Date.now() + 86400000).toISOString().slice(0, 10), from = new Date(Date.now() - 140 * 86400000).toISOString().slice(0, 10);
  const b = await load5m(from, to); const tl = await pivotTimeline(b.bars5m, b.atr); const cands = indexByDate(tl.piv, [...new Set(todo.map((r) => r.f.slice(0, 10)))]);
  let ins = 0, noadr = 0, deferred = 0;
  for (const r of todo) {
    const adr = await adr20(r.td); if (!Number.isFinite(adr) || adr <= 0) { noadr++; continue; }
    const levels = await levelsFor(r.td, r.f); if (!levels) { deferred++; continue; }
    const px = r.px, d = r.d, T = emOf(r.f.slice(0, 19)), pc = cands.get(r.f.slice(0, 10)) || [];
    const sd = levels.map((l) => ({ ...l, sgn: (l.price - px) * d, dist: Math.abs(l.price - px) / adr }));
    const ahead = sd.filter((l) => l.sgn > 0).sort((a, c) => a.dist - c.dist)[0] || null, behind = sd.filter((l) => l.sgn <= 0).sort((a, c) => a.dist - c.dist)[0] || null, any = [...sd].sort((a, c) => a.dist - c.dist)[0] || null;
    let crossMin = null;                                         // minutes since a minute bar closed on the FAR side of the nearest level behind (a recent break of that level)
    if (behind) {
      const fMs = tsMs(r.f), bars = (await query(`SELECT ts::text t, close::float c FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1::timestamp AND ts < $2::timestamp ORDER BY ts DESC`, [fmtUTC(fMs - 30 * 60000), fmtUTC(fMs)])).rows;
      const far = bars.find((x) => (x.c - behind.price) * d < 0); if (far) crossMin = (fMs - tsMs(far.t)) / 60000;
    }
    const upType = (l) => (l.price > px ? 'HIGH' : 'LOW');
    const row = [r.setup, r.id, r.f, r.td, r.track, d, px, adr, levels.length, ahead?.name ?? null, ahead?.price ?? null, ahead?.dist ?? null, ahead ? pivotAt(pc, d > 0 ? 'HIGH' : 'LOW', ahead.price, T) != null : null,
      behind?.name ?? null, behind?.price ?? null, behind?.dist ?? null, crossMin, any?.name ?? null, any?.price ?? null, any?.dist ?? null, any ? (any.price > px ? 1 : -1) : null, any ? pivotAt(pc, upType(any), any.price, T) != null : null,
      pivotAt(pc, 'HIGH', px, T) != null, pivotAt(pc, 'LOW', px, T) != null, JSON.stringify(r.extra), CODE_VERSION];
    if (!DRY) await query(`INSERT INTO level_confluence_tags (setup, source_id, fired_at, trade_date, track, direction, price, adr20, n_levels, ahead_name, ahead_price, ahead_dist_adr, ahead_defended, behind_name, behind_price, behind_dist_adr, behind_cross_min,
      any_name, any_price, any_dist_adr, any_side, any_defended, pivot_hi_live, pivot_lo_live, extra, code_version) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25::jsonb,$26) ON CONFLICT (setup, source_id) DO NOTHING`, row);
    ins++;
  }
  console.log(`tagged ${ins}; skipped for no ADR20 ${noadr}; deferred (level_prices for the trade date not written yet, retried next run) ${deferred}`);
}
async function report() {
  const r = (await query(`SELECT setup, count(*)::int n, count(DISTINCT trade_date)::int days, count(*) FILTER (WHERE ahead_name IS NULL)::int no_ahead,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY ahead_dist_adr)::numeric(7,3) ahead_med, percentile_cont(0.5) WITHIN GROUP (ORDER BY any_dist_adr)::numeric(7,3) any_med,
    count(*) FILTER (WHERE any_defended)::int any_def, count(*) FILTER (WHERE pivot_hi_live OR pivot_lo_live)::int at_pivot, count(*) FILTER (WHERE behind_cross_min IS NOT NULL AND behind_cross_min <= 3)::int fresh_break FROM level_confluence_tags GROUP BY 1 ORDER BY 1`)).rows;
  console.table(r);
}
if (args.has('--report')) await report(); else { await main(); }
process.exit(0);
