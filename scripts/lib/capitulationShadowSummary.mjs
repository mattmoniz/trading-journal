// Summary of the capitulation-exit overlay FORWARD SHADOW (register row 30, docs/CAPITULATION_EXIT_SHADOW_PREREG_20261109.md; logger scripts/capitulation_exit_shadow.mjs) for the Monitor & Learning page (cv-110):
// key `capitulationShadow` of public/learning_monitor.json. Display only; it places no order and changes no setup. Counts progress toward the prereg floor (20 independent signalled events on 10 days per test); it never states a verdict below it.
import { query } from '../../server/db.js';
const FLOOR_EVENTS = 20, FLOOR_DAYS = 10;
async function progress(cond) {
  const r = (await query(`SELECT count(DISTINCT sig_event_id)::int ev, count(DISTINCT fired_at::date)::int days, count(*)::int rows, avg(delta_pnl)::float mean_delta FROM capitulation_exit_shadow WHERE forward AND state = 'SIGNAL' AND delta_pnl IS NOT NULL AND ${cond}`)).rows[0];
  return { events: r.ev, days: r.days, rows: r.rows, meanDelta: r.mean_delta, floorEvents: FLOOR_EVENTS, floorDays: FLOOR_DAYS, atFloor: r.ev >= FLOOR_EVENTS && r.days >= FLOOR_DAYS };
}
async function progressF1() {          // F1 (docs/CAPITULATION_REPLACE_TARGET_FORWARD_PREREG_20261109.md): forward RTH boundary rows, H minus C0, once C0 is terminal
  const r = (await query(`SELECT count(DISTINCT h_sig_event_id)::int ev, count(DISTINCT fired_at::date)::int days, count(*)::int rows, avg(hc0_delta)::float mean_delta FROM capitulation_exit_shadow WHERE forward AND session_track = 'RTH' AND at_boundary AND h_state = 'SIGNAL' AND hc0_delta IS NOT NULL`)).rows[0];
  const w = (await query(`SELECT count(*)::int n FROM capitulation_exit_shadow WHERE forward AND session_track = 'RTH' AND at_boundary AND h_state = 'SIGNAL' AND hc0_delta IS NULL`)).rows[0].n;
  return { events: r.ev, days: r.days, rows: r.rows, meanDelta: r.mean_delta, waitingForC0: w, floorEvents: FLOOR_EVENTS, floorDays: FLOOR_DAYS, atFloor: r.ev >= FLOOR_EVENTS && r.days >= FLOOR_DAYS };
}
export async function capitulationShadowSummary() {
  try {
    const t = (await query(`SELECT count(*)::int n, count(*) FILTER (WHERE forward)::int fwd, count(*) FILTER (WHERE forward AND state = 'OPEN')::int open_fwd, count(*) FILTER (WHERE forward AND at_boundary)::int atb, count(*) FILTER (WHERE forward AND pivot_live)::int piv,
      count(*) FILTER (WHERE forward AND near_boundary_stopw)::int near, count(*) FILTER (WHERE forward AND sig_event_id IS NOT NULL)::int sig, count(*) FILTER (WHERE forward AND sig80_event_id IS NOT NULL)::int sig80,
      count(*) FILTER (WHERE NOT forward)::int retro, count(*) FILTER (WHERE NOT forward AND sig_event_id IS NOT NULL)::int retro_sig, extract(epoch FROM (now() - max(computed_at)))::int age_sec, min(fired_at) FILTER (WHERE forward)::text first_fwd FROM capitulation_exit_shadow`)).rows[0];
    const recent = (await query(`SELECT setup_id, setup_type, side, to_char(fired_at, 'MM-DD HH24:MI') t, forward, at_boundary, pivot_live, state, round(sig_ext::numeric, 2)::float ext, actual_pnl::float actual, virt_pnl::float virt, delta_pnl::float delta
      FROM capitulation_exit_shadow WHERE sig_event_id IS NOT NULL ORDER BY fired_at DESC LIMIT 6`)).rows;
    return { state: 'OK', generatedAt: new Date().toISOString(), forwardFrom: '2026-11-09 14:30 ET', totals: t,
      c1: await progress('at_boundary'), c2: await progress('pivot_live'), c3: await progress("setup_type LIKE 'FAILED_SWEEP_REVERSAL%'"), c4: await progressF1(), strict: await progress('sig80_event_id IS NOT NULL AND TRUE'), recent,
      rule: 'Shadow only. For each open setup row, a same-direction expansion thrust after an extended move (top tercile of the 240-minute displacement, in ADR20 units) is a virtual exit at the next bar open; the row\'s own exit is untouched. The question: does that virtual exit beat what the setup actually did, on setups entered at a boundary or a defended pivot?',
      next: { review: 'Judge only at the floor: 20 independent signalled events on 10 days for each of the two counted tests (entered at a prior-RTH/overnight boundary; entered at a defended pivot). Expected in months, not days.',
        ifConfirmed: 'Lower 90% bound of (virtual minus actual) above zero, trimmed mean above zero, survives dropping the best day, and beats the untagged rows: write a Sim1 early-close arm through the existing flatten path and ask for the go.',
        ifFailed: 'Upper bound below zero for both: park it (never retired on this log alone, CLAUDE.md co-025), write the autopsy by bet class, tag and timing.' },
      notes: [`Rows logged ${t.n} (forward ${t.fwd}, descriptive retro ${t.retro}); the strict (80th percentile) signal and the wide stop-width tag are secondary and uncounted.`, 'The wick and one-bar-stall variants are registered but not built: they need the signal bar high/low in the vacuum event log.', 'F1 (replace-the-target, A11): the same rows are also scored holding with the original stop and NO target to the row\'s expiry (C0), and the same plus an exit at the capitulation thrust (H); F1 counts RTH boundary rows only, H minus C0, floor 20 events on 10 days (docs/CAPITULATION_REPLACE_TARGET_FORWARD_PREREG_20261109.md).'] };
  } catch (e) { return { state: 'ERROR', error: e.message }; }
}
