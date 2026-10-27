// LIVE_ROSTER calibration (2026-10-21, user: "live should be gated to the six setups ... shouldn't it be?").
// Design critique: reports/deepseek_live_roster_design_2026-10-21.md (all its priority fixes are applied).
//
// Writes ONE performance_audit row per run: signal_type='LIVE_ROSTER' (its own type, never SETUP_STATUS/OPTIMAL_STOP),
// signal_name='CURRENT'. server/services/setupEligibility.js reads the newest row (DISTINCT ON ... run_date DESC, id DESC)
// and force-SHADOWs every setup_type that is not on it.
//
// RULE (data-derived; floors relaxed 2026-10-25, see MIN_DAYS below; scripts/family_preview_20261021.mjs still prints the old 20/10 version): a type "passes" with >=MIN_DAYS distinct days of cluster-collapsed
// events, a day-blocked bootstrap 95% CI lower bound above 0, and both chronological halves positive.
// Roster = passing types only (the user restricted live to the 3 demonstrated-edge types to start); INCLUDE_OPPOSITE_SIBLINGS=true would add each
// passing type's opposite-direction sibling (LONG<->SHORT at the same level) -- the earlier "whole family survives" directive.
// Promotion hysteresis (DeepSeek C): once a previous roster exists, a type NOT on it must also keep ci.lo > 0 after its single best day is
// dropped (a lucky-streak test derived from the type's own data). Demotion is instant. The FIRST run (no previous roster) seeds from the base rule alone -- applying hysteresis then would have cut IB_LOW_FADE_LONG and OR30_LOW_FADE_LONG, both of which the user named; the day-1 seed is a deliberate, recorded exception. Siblings follow their passing type.
// Population: live-detected ACTIVE+SHADOW rows since 2026-07-09, no *_basis rows, no 16:00-18:00 rows, no NOT_FILLED;
// POC_ROTATION_JOIN is judged separately (CLAUDE.md confound boundary) and is forced SHADOW elsewhere, so it is excluded here.
// This is a negative gate on the candidate pool, not a profitability certificate: SETUP_STATUS / MANUAL_SUPPRESS_OVERRIDE /
// DOW / CAPITAL_EXPOSURE_OVERRIDE still apply on top (live = on roster AND not suppressed by any of those).
import { query } from '../server/db.js';
import { collapseClusterSiblings, dayBlockedBootstrapCI } from '../server/services/rigorDiagnostics.js';

// 2026-10-25 (user: "I just want to get things promoted ... not sure I care if it's 10 or 20 or 30"): the hardcoded 20-events/10-days floors were replaced
// by the interval test doing the work. A what-if (scratch/roster_floor_whatif_20261025.mjs) showed the floors were NOT the binding constraint (20/10 -> 1 type passing,
// 8/4 -> 4 passing), so MIN_DAYS=5 is kept only as a day-clustering guard (a bootstrap over fewer than 5 days is meaningless) and MIN_EVENTS is derived from it
// (each distinct day contributes at least one collapsed event, so events >= days >= MIN_DAYS). No separate event count to argue about.
export const MIN_DAYS = 5, MIN_EVENTS = MIN_DAYS;
// User directive 2026-10-21 (second message): "the gate for live was only supposed to be for these 3 setups to start" -- so opposite-direction
// siblings are OFF for now. Flip to true to restore the family rule (passing type + its opposite-direction sibling); tests cover both.
export const INCLUDE_OPPOSITE_SIBLINGS = false;
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;

export function oppositeOf(t) {
  if (/_LONG(_|$)/.test(t)) return t.replace(/_LONG(?=_|$)/, '_SHORT');
  if (/_SHORT(_|$)/.test(t)) return t.replace(/_SHORT(?=_|$)/, '_LONG');
  return null;
}

// events: [{date, pnl, cluster_touch_id}] already collapsed. Returns stats + pass flags.
export function evaluateType(events, seed) {
  const days = new Set(events.map((e) => e.date)).size;
  if (events.length < MIN_EVENTS || days < MIN_DAYS) return { n: events.length, days, thin: true, pass: false, passLeaveBestDayOut: false };
  const ci = dayBlockedBootstrapCI(events, seed);
  const so = [...events].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)), h = Math.floor(so.length / 2);
  const h1 = mean(so.slice(0, h).map((e) => e.pnl)), h2 = mean(so.slice(h).map((e) => e.pnl));
  const pass = ci.lo > 0 && h1 > 0 && h2 > 0;
  // leave-best-day-out: drop the single day with the largest total pnl, recompute the CI.
  const byDay = new Map(); for (const e of events) byDay.set(e.date, (byDay.get(e.date) || 0) + e.pnl);
  const bestDay = [...byDay].sort((a, b) => b[1] - a[1])[0][0];
  const rest = events.filter((e) => e.date !== bestDay);
  const restDays = new Set(rest.map((e) => e.date)).size;
  const ci2 = restDays >= MIN_DAYS ? dayBlockedBootstrapCI(rest, seed + ':lobd') : null; // needs MIN_DAYS days left after dropping the best one, so a NEW type needs >= MIN_DAYS+1 days (a type at exactly the floor can't be promoted: no more 'exactly 20 can never pass' event-count quirk)
  return { n: events.length, days, mean: mean(events.map((e) => e.pnl)), lo: ci.lo, hi: ci.hi, h1, h2, thin: false, pass,
    passLeaveBestDayOut: !!(pass && ci2 && ci2.lo > 0), bestDay, lobdLo: ci2 ? ci2.lo : null };
}

// passing: Map type -> eval; prevPassing: Set of types that passed on the previous roster; known: Set of real setup_types.
export function buildRoster(evals, prevPassing, known, includeSiblings = INCLUDE_OPPOSITE_SIBLINGS) {
  const roles = new Map(); // type -> {role, from}
  for (const [t, ev] of evals) {
    if (!ev.pass) continue;
    if (prevPassing && !prevPassing.has(t) && !ev.passLeaveBestDayOut) continue; // new promotion must survive leave-best-day-out (prevPassing null = first run, nothing to be a promotion OF)
    roles.set(t, { role: 'passing' });
  }
  if (includeSiblings) for (const [t, r] of [...roles]) {
    const sib = oppositeOf(t);
    if (sib && known.has(sib) && !roles.has(sib)) roles.set(sib, { role: 'sibling', of: t });
  }
  return roles;
}

async function main() {
  const rows = (await query(`SELECT setup_type, trade_date::text d, cluster_touch_id cl, actual_pnl::float p FROM active_setups
    WHERE origin_status IN ('ACTIVE','SHADOW') AND trade_date >= '2026-07-09' AND actual_pnl IS NOT NULL
      AND resolution IS DISTINCT FROM 'NOT_FILLED' AND ib_window_stale_basis IS NOT TRUE AND stale_entry_price_basis IS NOT TRUE
      AND late_fill_past_expiry_basis IS NOT TRUE AND bad_bars_basis IS NOT TRUE AND stale_levels_basis IS NOT TRUE
      AND NOT (fired_at::time >= '16:00' AND fired_at::time < '18:00') AND setup_type NOT LIKE 'POC_ROTATION_JOIN%'`)).rows;
  const by = new Map(); for (const r of rows) (by.get(r.setup_type) || by.set(r.setup_type, []).get(r.setup_type)).push(r);
  const evals = new Map();
  for (const [t, rs] of by) evals.set(t, evaluateType(collapseClusterSiblings(rs.map((r) => ({ date: r.d, pnl: r.p, cluster_touch_id: r.cl }))), t));

  const prev = (await query(`SELECT notes FROM performance_audit WHERE signal_type='LIVE_ROSTER' AND signal_name='CURRENT' AND run_date < CURRENT_DATE ORDER BY run_date DESC, id DESC LIMIT 1`)).rows[0];
  let prevPassing = null;
  if (prev) { const n = typeof prev.notes === 'string' ? JSON.parse(prev.notes) : prev.notes; prevPassing = new Set((n.roster || []).filter((x) => x.role === 'passing').map((x) => x.type)); }
  const known = new Set((await query(`SELECT DISTINCT signal_name FROM performance_audit WHERE signal_type='SETUP_STATUS'`)).rows.map((r) => r.signal_name));
  const roles = buildRoster(evals, prevPassing, known);

  const status = new Map((await query(`SELECT DISTINCT ON (signal_name) signal_name n, recommendation r FROM performance_audit WHERE signal_type='SETUP_STATUS' ORDER BY signal_name, run_date DESC, id DESC`)).rows.map((r) => [r.n, r.r]));
  const roster = [...roles].map(([type, r]) => ({ type, ...r, setup_status: status.get(type) || null, stats: evals.get(type) || null }));
  const held = [...evals].filter(([t, e]) => e.pass && !roles.has(t)).map(([t, e]) => ({ type: t, reason: 'failed_leave_best_day_out', lobdLo: e.lobdLo }));
  const notes = { roster, held_back_promotions: held, rule: { MIN_EVENTS, MIN_DAYS, ci: 'day-blocked bootstrap 95% lower bound > 0', halves: 'both chronological halves positive', hysteresis: 'new promotions must pass leave-best-day-out; demotion instant', siblings: INCLUDE_OPPOSITE_SIBLINGS ? 'opposite-direction sibling of each passing type' : 'off (passing types only)' },
    types_evaluated: evals.size, testable: [...evals.values()].filter((e) => !e.thin).length, previous_passing: prevPassing ? [...prevPassing] : null, seeded_without_hysteresis: !prevPassing, source: 'scripts/calibrate_live_roster.mjs' };
  const WINDOW_DAYS = 0; // unique key (run_date, window_days, signal_type, signal_name): one row per day, rerun overwrites
  await query(`INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, notes) VALUES (CURRENT_DATE, $1, 'LIVE_ROSTER', 'CURRENT', $2, $3)
    ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE SET notes = EXCLUDED.notes, sample_size = EXCLUDED.sample_size`, [WINDOW_DAYS, roster.length, JSON.stringify(notes)]);
  console.log(`LIVE_ROSTER written: ${roster.length} types (${roster.filter((x) => x.role === 'passing').length} passing + ${roster.filter((x) => x.role === 'sibling').length} siblings); ${held.length} held back by leave-best-day-out`);
  for (const x of roster) console.log(`  ${x.type.padEnd(28)} ${x.role.padEnd(8)} SETUP_STATUS=${x.setup_status}${x.stats && !x.stats.thin ? ` n${x.stats.n}/${x.stats.days}d mean ${x.stats.mean.toFixed(1)} CI [${x.stats.lo.toFixed(1)},${x.stats.hi.toFixed(1)}]` : ''}`);
  for (const h of held) console.log(`  HELD BACK ${h.type}: ${h.reason} (CI lo without best day ${h.lobdLo == null ? 'n/a' : h.lobdLo.toFixed(1)})`);
}
if (import.meta.url === `file://${process.argv[1]}`) main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
