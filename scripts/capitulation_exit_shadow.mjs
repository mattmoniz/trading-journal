#!/usr/bin/env node
// FORWARD SHADOW LOGGER for the capitulation-exit overlay (register row 30; docs/CAPITULATION_EXIT_SHADOW_PREREG_20261109.md). SHADOW ONLY: reads active_setups, vacuum_live_events, price_bars_primary, level_prices; writes ONLY
// capitulation_exit_shadow. It places no order, changes no setup and lives outside server/ (no nodemon restart). Idempotent: tags are written once at the first sight of a row and never revised; the signal/outcome columns are
// recomputed until the setup row is terminal. Usage: node scripts/capitulation_exit_shadow.mjs [--report] [--dry]
//
// FROZEN BEFORE THE FIRST ROW (build-time decisions, 2026-11-09 14:xx ET; none looks at an outcome):
//  * Judged population: origin_status ACTIVE|SHADOW, is_cluster_primary, setup_type not VACUUM_EXP_* (those rows ARE the thrust), direction from the name suffix LONG|SHORT, actual_pnl not null once terminal (NOT_FILLED rows have none).
//  * forward = fired_at >= FORWARD_START; earlier rows (from the vacuum log's start) are stored as descriptive retro rows (forward=false) and never counted toward the floor.
//  * CAPITULATION SIGNAL = a vacuum_live_events onset in the SAME direction as the position, fired strictly after the setup and before its resolution, not in the 18:00-18:30 ET reopen blackout, whose extension
//    E = dir x (signal_close - close 240 minutes earlier) / ADR20 is >= the 2/3 quantile (linear interpolation) of the earlier E values of its track: the research history (scripts/lib/data/context_exit_E_history_20261109.json,
//    built by scripts/vacuum_sim/context_exit_phase1.py through 2026-10-09) plus the live events logged before it. E is undefined (no signal) within the first 240 minutes of the session (previous calendar day 18:00 ET).
//    ADR20 = mean RTH (09:30-16:00) high-low of the 20 latest RTH sessions before the event's trade date. Exit price = the vacuum event's entry_open (the next 500V bar's open).
//  * at_boundary: entry within AT_BOUNDARY_ADR x ADR20 of the prior RTH high/low/VAH/VAL (level_prices PD_*) or the overnight high/low computed from minute bars up to the fire (only fired 02:00-17:00 ET); SHORT fades from the
//    high-side levels (PD_HIGH, PD_VAH, ONH), LONG from the low-side levels (PD_LOW, PD_VAL, ONL).
//  * pivot_live (the user's "previously defended level"): scripts/lib/pivotContext.mjs pivotAt() returns a live, confirmed (>= 30 min) swing pivot of the fade side (HIGH for a short, LOW for a long) whose band (0.02 x ATR) holds the
//    entry; pivot_tests = completed prior tests of that pivot (the stricter module meaning of DEFENDED is pivot_tests >= 1; stored, descriptive).
//  * P&L in dollars per 1 MNQ: side x (exit - entry) x 2 - 2 (the repo's cost model; the actual_pnl of active_setups is on the same basis).
import fs from 'fs';
import { query } from '../server/db.js';
import { fmtUTC, tsMs, adr20, sessionStartMs } from './lib/levelContext.mjs';
import { levelsFor, loadPivotCands, pivotTag } from './lib/entryLocationTags.mjs';
import { flatTime, loadHoldBars, computeArms } from './lib/holdArms.mjs';
const CODE_VERSION = 'cap-v1';
const FORWARD_START = '2026-11-09 14:30:00';          // ET, set at build time; rows fired before it are descriptive
const SEED = JSON.parse(fs.readFileSync(new URL('./lib/data/context_exit_E_history_20261109.json', import.meta.url)));
const args = new Set(process.argv.slice(2)); const DRY = args.has('--dry'); const RECOMPUTE = args.has('--recompute');   // --recompute: refresh signal columns and the secondary wide tag of every row (frozen tags are never touched)
const sideOf = (t) => { const m = /(?:^|_)(LONG|SHORT)(?:_|$)/.exec(t); return m ? (m[1] === 'LONG' ? 1 : -1) : 0; };
const quantile = (sorted, q) => { const p = (sorted.length - 1) * q, lo = Math.floor(p), hi = Math.ceil(p); return sorted[lo] + (sorted[hi] - sorted[lo]) * (p - lo); };
const insertSorted = (a, v) => { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < v) lo = m + 1; else hi = m; } a.splice(lo, 0, v); };
async function closeAtOrBefore(ms) {                           // close of the latest minute bar at or before ms (within 10 minutes)
  const r = await query(`SELECT close::float c FROM price_bars_primary WHERE symbol='NQ' AND ts > $1::timestamp AND ts <= $2::timestamp ORDER BY ts DESC LIMIT 1`, [fmtUTC(ms - 600000), fmtUTC(ms)]); return r.rows[0]?.c ?? null;
}


// every vacuum onset with its extension and top-tercile flag, in time order (cutoffs use only earlier events)
async function loadEvents() {
  const ev = (await query(`SELECT id, trade_date::text td, track, direction, fired_at::text f, signal_close::float sc, entry_open::float eo FROM vacuum_live_events ORDER BY fired_at, id`)).rows;
  const hist = { RTH: [...SEED.RTH].sort((a, b) => a - b), GBX: [...SEED.GBX].sort((a, b) => a - b) }; const out = [];
  for (const e of ev) {
    const ms = tsMs(e.f), adr = await adr20(e.td); let E = null, cut = null, qual = false, cut80 = null, qual80 = false;
    const minOfDay = +e.f.slice(11, 13) * 60 + +e.f.slice(14, 16), reopen = minOfDay >= 1080 && minOfDay < 1110;
    if (ms - 14400000 >= sessionStartMs(e.td) && Number.isFinite(adr) && adr > 0) {
      const ref = await closeAtOrBefore(ms - 14400000);
      if (ref != null) { E = e.direction * (e.sc - ref) / adr; const H = hist[e.track]; if (H) { cut = quantile(H, 2 / 3); qual = !reopen && E >= cut; cut80 = quantile(H, 0.8); qual80 = !reopen && E >= cut80; insertSorted(H, E); } }
    }
    out.push({ id: Number(e.id), ms, fired: e.f, dir: e.direction, track: e.track, eo: e.eo, E, cut, qual, cut80, qual80, reopen });
  }
  return out;
}


async function main() {
  const rows = (await query(`SELECT id, setup_type, fired_at::text f, resolved_at::text rs, trade_date::text td, origin_status, bet_class, COALESCE(price_at_detection, entry_zone_high)::float entry, abs(COALESCE(price_at_detection, entry_zone_high) - stop_level)::float stopw, stop_level::float stop_px, expires_at::text exp, actual_pnl::float pnl, status
    FROM active_setups WHERE fired_at >= '2026-11-08 18:00:00' AND origin_status IN ('ACTIVE','SHADOW') AND is_cluster_primary AND setup_type NOT LIKE 'VACUUM\\_EXP\\_%' ORDER BY fired_at`)).rows;
  const armState = new Map((await query(`SELECT setup_id, c0_state FROM capitulation_exit_shadow`)).rows.map((r) => [r.setup_id, r.c0_state]));   // replace-the-target arms: recompute until C0 is terminal
  const have = new Map((await query(`SELECT setup_id, state, boundary_dist_stopw FROM capitulation_exit_shadow`)).rows.map((r) => [r.setup_id, r.state])); const hasWide = new Map((await query(`SELECT setup_id FROM capitulation_exit_shadow WHERE stop_width IS NOT NULL`)).rows.map((r) => [r.setup_id, true]));
  const todo = rows.filter((r) => RECOMPUTE || !have.has(r.id) || have.get(r.id) === 'OPEN' || (r.rs && have.get(r.id) !== 'SIGNAL' && have.get(r.id) !== 'NO_SIGNAL') || !['STOP', 'EXP'].includes(armState.get(r.id)));
  console.log(`candidate setup rows ${rows.length}; to (re)compute ${todo.length}${DRY ? ' (dry run: nothing written)' : ''}`);
  if (!todo.length) return;
  const events = await loadEvents(); let cands = null; const noDir = [];
  const dates = [...new Set(todo.map((r) => r.f.slice(0, 10)))];
  if (todo.some((r) => !have.has(r.id))) {                       // pivot context only when new rows need tags
    const to = new Date(Date.now() + 86400000).toISOString().slice(0, 10), from = new Date(Date.now() - 140 * 86400000).toISOString().slice(0, 10);
    cands = await loadPivotCands(from, to, dates);
  }
  let ins = 0, upd = 0, sigs = 0, hsigs = 0;
  for (const r of todo) {
    const side = sideOf(r.setup_type); if (!side) { noDir.push(r.setup_type); continue; }
    if (r.pnl == null && r.rs) continue;                          // terminal without a P&L (NOT_FILLED / invalidated): not a position
    const row = { ...r, side, entry: r.entry }; const fMs = tsMs(r.f), rMs = r.rs ? tsMs(r.rs) : null;
    const sig = events.find((e) => e.qual && e.dir === side && e.ms > fMs && (rMs == null || e.ms < rMs) && e.eo != null);
    const sig80 = events.find((e) => e.qual80 && e.dir === side && e.ms > fMs && (rMs == null || e.ms < rMs) && e.eo != null);
    let virt = null, delta = null, virt80 = null, delta80 = null;
    if (sig80 && r.entry != null) { virt80 = side * (sig80.eo - r.entry) * 2 - 2; if (r.pnl != null) delta80 = virt80 - r.pnl; }
    if (sig && r.entry != null) { virt = side * (sig.eo - r.entry) * 2 - 2; if (r.pnl != null) delta = virt - r.pnl; }
    const state = !r.rs ? 'OPEN' : (sig ? 'SIGNAL' : 'NO_SIGNAL'); if (sig) sigs++;
    if (!have.has(r.id)) {
      const adr = await adr20(r.td); const lv = Number.isFinite(adr) ? await levelsFor(row, adr) : { at: null, name: null, distAdr: null };
      const pv = pivotTag(cands, side, r.entry, r.f);
      if (!DRY) await query(`INSERT INTO capitulation_exit_shadow (setup_id, setup_type, side, bet_class, origin_status, session_track, fired_at, resolved_at, entry_px, actual_pnl, forward, at_boundary, boundary_name, boundary_dist_adr, adr20,
        pivot_live, pivot_tests, pivot_dist, sig_event_id, sig_fired_at, sig_ext, sig_cutoff, sig_exit_px, virt_pnl, delta_pnl, state, code_version) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
        ON CONFLICT (setup_id) DO NOTHING`, [r.id, r.setup_type, side, r.bet_class, r.origin_status, (+r.f.slice(11, 13) * 60 + +r.f.slice(14, 16) >= 570 && +r.f.slice(11, 13) < 16) ? 'RTH' : 'GBX', r.f, r.rs, r.entry, r.pnl, r.f >= FORWARD_START,
        lv.at, lv.name, lv.distAdr, Number.isFinite(adr) ? adr : null, pv.live, pv.tests, pv.dist,
        sig?.id ?? null, sig ? fmtUTC(sig.ms) : null, sig?.E ?? null, sig?.cut ?? null, sig?.eo ?? null, virt, delta, state, CODE_VERSION]);
      ins++;
    } else {
      if (!DRY) await query(`UPDATE capitulation_exit_shadow SET resolved_at=$2, actual_pnl=$3, sig_event_id=$4, sig_fired_at=$5, sig_ext=$6, sig_cutoff=$7, sig_exit_px=$8, virt_pnl=$9, delta_pnl=$10, state=$11, computed_at=now() WHERE setup_id=$1`,
        [r.id, r.rs, r.pnl, sig?.id ?? null, sig ? fmtUTC(sig.ms) : null, sig?.E ?? null, sig?.cut ?? null, sig?.eo ?? null, virt, delta, state]); upd++;
    }
    if (!DRY) {                                                  // SECONDARY columns (not counted): strict 80th-percentile signal, and the scale-free wide boundary tag fixed at the first sight of the row
      await query(`UPDATE capitulation_exit_shadow SET sig80_event_id=$2, sig80_fired_at=$3, sig80_ext=$4, sig80_exit_px=$5, sig80_virt_pnl=$6, sig80_delta=$7 WHERE setup_id=$1`, [r.id, sig80?.id ?? null, sig80 ? fmtUTC(sig80.ms) : null, sig80?.E ?? null, sig80?.eo ?? null, virt80, delta80]);
      if (!hasWide.has(r.id) && r.stopw > 0) {
        const adr = await adr20(r.td); const lv = Number.isFinite(adr) ? await levelsFor(row, adr) : null;
        if (lv && lv.dPts != null) await query(`UPDATE capitulation_exit_shadow SET stop_width=$2, boundary_dist_stopw=$3, near_boundary_stopw=$4 WHERE setup_id=$1 AND stop_width IS NULL`, [r.id, r.stopw, lv.dPts / r.stopw, lv.dPts <= 1.0 * r.stopw]);
      }
    }
    if (r.entry != null && r.stop_px != null) {                  // replace-the-target arms C0 / H (A10 / A11): hold with the original stop to expiry, with and without the capitulation exit
      const bars = await loadHoldBars(r.f, r.exp || flatTime(r.f)), a = computeArms({ side, entry: r.entry, stop: r.stop_px, f: r.f, exp: r.exp, events, bars, actualPnl: r.pnl });
      if (!DRY) await query(`UPDATE capitulation_exit_shadow SET stop_px=$2, expires_at=$3, c0_state=$4, c0_exit_at=$5, c0_exit_px=$6, c0_pnl=$7, h_state=$8, h_exit_at=$9, h_exit_px=$10, h_pnl=$11, h_sig_event_id=$12, hc0_delta=$13, ha_delta=$14, hold_arms_at=now() WHERE setup_id=$1`,
        [r.id, r.stop_px, r.exp || flatTime(r.f), a.c0.state, a.c0.ms == null ? null : fmtUTC(a.c0.ms), a.c0.px, a.c0.pnl, a.h.state, a.h.ms == null ? null : fmtUTC(a.h.ms), a.h.px, a.h.pnl, a.h.eventId ?? null, a.hc0, a.ha]);
      if (a.h.state === 'SIGNAL') hsigs++;
    }
  }
  console.log(`inserted ${ins}, updated ${upd}, with a capitulation signal ${sigs}; replace-the-target H exits on a thrust ${hsigs}; rows without a LONG/SHORT name skipped: ${noDir.length}${noDir.length ? ' (' + [...new Set(noDir)].slice(0, 6).join(', ') + ')' : ''}`);
}

// ---- report: the prereg's two counted tests (forward rows only), cluster collapse by signal event, day-blocked bootstrap
function bootstrap(groups, seed = 20261109, B = 4000) {         // groups: [{day, v}] already collapsed; resample whole days
  let s = seed >>> 0; const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const byDay = new Map(); for (const g of groups) (byDay.get(g.day) || byDay.set(g.day, []).get(g.day)).push(g.v); const days = [...byDay.keys()];
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length; const bs = [];
  for (let b = 0; b < B; b++) { const vals = []; for (let i = 0; i < days.length; i++) vals.push(...byDay.get(days[Math.floor(rnd() * days.length)])); bs.push(mean(vals)); }
  bs.sort((a, b) => a - b); return { lo90: bs[Math.floor(B * 0.10)], hi90: bs[Math.floor(B * 0.90)], days: days.length };
}
async function report() {
  const r = (await query(`SELECT * FROM capitulation_exit_shadow ORDER BY fired_at`)).rows;
  const fwd = r.filter((x) => x.forward), sig = fwd.filter((x) => x.state === 'SIGNAL' && x.delta_pnl != null);
  console.log(`rows ${r.length} (forward ${fwd.length}, descriptive retro ${r.length - fwd.length}); forward by state: ${JSON.stringify(fwd.reduce((a, x) => (a[x.state] = (a[x.state] || 0) + 1, a), {}))}; forward signalled with a delta ${sig.length}`);
  for (const [lab, f] of [['C1 at_boundary', (x) => x.at_boundary === true], ['C2 pivot_live', (x) => x.pivot_live === true], ['C3 FAILED_SWEEP_REVERSAL (own family, docs/CAPITULATION_EXIT_SWEEP_FORWARD_PREREG_20261109.md)', (x) => /^FAILED_SWEEP_REVERSAL/.test(x.setup_type)], ['control: NOT at_boundary', (x) => x.at_boundary === false], ['control: NOT pivot_live', (x) => x.pivot_live === false]]) {
    const sel = sig.filter(f); const byEv = new Map(); for (const x of sel) (byEv.get(String(x.sig_event_id)) || byEv.set(String(x.sig_event_id), []).get(String(x.sig_event_id))).push(x);
    const groups = [...byEv.values()].map((a) => ({ day: String(a[0].fired_at).slice(0, 10), v: a.reduce((s, y) => s + Number(y.delta_pnl), 0) / a.length }));
    if (!groups.length) { console.log(`  ${lab}: 0 signalled rows`); continue; }
    const m = groups.reduce((s, g) => s + g.v, 0) / groups.length, bsr = bootstrap(groups), sorted = groups.map((g) => g.v).sort((a, b) => a - b), k = Math.floor(sorted.length * 0.25);
    const trimmed = sorted.slice(k, sorted.length - k).reduce((s, v) => s + v, 0) / Math.max(sorted.length - 2 * k, 1);
    console.log(`  ${lab}: signalled rows ${sel.length}, independent signal events ${groups.length}, days ${bsr.days}; mean delta $${m.toFixed(2)} [90% ${bsr.lo90.toFixed(2)}, ${bsr.hi90.toFixed(2)}], 25% trimmed $${trimmed.toFixed(2)} ${groups.length < 20 || bsr.days < 10 ? '(BELOW the floor of 20 events on 10 days: no verdict)' : ''}`);
  }
}
if (args.has('--report')) await report();
else if (args.has('--events')) { for (const e of await loadEvents()) console.log(`${e.id} ${e.track} ${e.dir > 0 ? 'LONG ' : 'SHORT'} ${e.fired.slice(0, 19)} E=${e.E == null ? 'undef' : e.E.toFixed(3)} cut=${e.cut == null ? '-' : e.cut.toFixed(3)} ${e.qual ? 'QUALIFIES' : (e.reopen ? 'reopen' : '')}`); }
else await main();
process.exit(0);
