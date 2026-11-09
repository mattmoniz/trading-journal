// Forward arms tracker for the overnight order-flow idea (docs/OVN_ORDERFLOW_VARIATIONS_PREREG_20261104.md sections 5-10; key `ovnArms` of GET /api/setups/monitor-summary, Monitor & Learning page). READ-ONLY, computed from the 1-minute bars: no setup type, no detector change,
// no orders. WHY IT EXISTS: the LIVE shadow detector (overnightOrderflowEntryDetector.js) counts rotation legs on closes only with the badge threshold, so it fires about one night in eleven and is not the rule that was researched (high / low legs >= 6). This tracker follows BOTH rules for every
// forward night (trade dates from FORWARD_FROM, the first nights after the calibration window) and four arms on each qualifying night: BASE (flow-sign direction, 400-point stop, exit 14:30), RISK (the same with a 300-point stop), MOM (the direction of the overnight price move) and MIRROR (against the flow).
// Entries mirror the research: the research rule enters at the 00:00 bar open, the live rule at the 00:00 bar close (path from the next bar); fills as in the tell code (a stop beyond the market fills at the bar open, a touched stop at its price minus 1 tick, exit at the 14:30 bar open minus 1 tick), MNQ 2 dollars per point, 2 dollars commission.
// The card carries its own NEXT STEP from the pre-registered forward rules (looks at N = 15 and 30 qualifying nights; FAILED if the BASE mean is below 0 at N >= 20 or the RTH-direction hit rate is 50 percent or less at N >= 30; CONFIRMED at N >= 30 when the bootstrap 95 percent CI of the BASE mean is above 0 and the hit rate is above 55 percent).
// No statistic is typed into this file (hr-019): everything shown is computed here or points to the claim slugs. Parity with the research simulation: scripts/test_ovn_arms.mjs.
import { query } from '../db.js';
import { cacheGet, cacheSet } from '../lib/cache.js';
import { detectRotationLegs } from './rotationDetector.js';

const SLIP = 0.25, DPP = 2, COMM = 2, EXIT_MIN = 14 * 60 + 30, FORWARD_FROM = '2026-11-02', RESEARCH_LEGS = 6, LEG_R = 65, FIRST_LOOK_N = 15, SECOND_LOOK_N = 30, FAIL_MEAN_N = 20, FAIL_HIT_N = 30, CONFIRM_HIT = 0.55;
const STOP_BASE = 400, STOP_RISK = 300;
const netOf = (px, entry, d) => ((px - entry) * d) * DPP - COMM;

/** One arm: bars [{m (minute of day), o, h, l, c}] from the entry bar on (index 0 = the entry bar; the entry bar's own range counts only for the research entry, the caller passes the right slice), direction d, entry price, stop in points (null = none). Same rules as scripts/tell_context/research_20261103/ovn_sim.py. */
export function simArm(bars, d, entry, stopPts, exitMin = EXIT_MIN) {
  if (!bars.length) return null;
  const stop = stopPts == null ? null : entry - d * stopPts;
  for (let j = 0; j < bars.length; j++) {
    const b = bars[j];
    if (b.m >= exitMin) return { net: netOf(b.o - d * SLIP, entry, d), why: 'EXIT' };
    if (stop != null) {
      if (j > 0 && d * (b.o - stop) <= 0) return { net: netOf(b.o - d * SLIP, entry, d), why: 'STOP_GAP' };
      if ((d === 1 && b.l <= stop) || (d === -1 && b.h >= stop)) return { net: netOf(stop - d * SLIP, entry, d), why: 'STOP' };
    }
  }
  return { net: netOf(bars[bars.length - 1].c, entry, d), why: 'EOS' };
}

async function liveThreshold() {
  const r = await query(`SELECT notes FROM performance_audit WHERE signal_type='GLOBEX_ROTATION_BADGE_CALIB' AND signal_name='ALL_SESSIONS' ORDER BY run_date DESC LIMIT 1`);
  try { const n = r.rows[0] ? JSON.parse(r.rows[0].notes) : null; return n?.stage2?.thresholdLegs ?? 6; } catch (_) { return 6; }
}

/** One night (trade date td): the overnight session 18:00 (previous calendar day) to 23:59 and the path 00:00 to 15:59. Returns the qualification under both rules and the four arms under each. */
export async function computeNight(td, liveLegs) {
  const rows = (await query(`SELECT ts::text AS t, open::float AS o, high::float AS h, low::float AS l, close::float AS c, COALESCE(ask_volume,0)::float AS av, COALESCE(bid_volume,0)::float AS bv FROM price_bars_primary WHERE symbol='NQ'
    AND ts >= ($1::date - 1)::timestamp + interval '18 hours' AND ts < $1::date::timestamp + interval '16 hours' ORDER BY ts`, [td])).rows;
  const bars = rows.map((x) => ({ m: Number(x.t.slice(11, 13)) * 60 + Number(x.t.slice(14, 16)), hh: Number(x.t.slice(11, 13)), o: x.o, h: x.h, l: x.l, c: x.c, av: x.av, bv: x.bv }));
  const pre = bars.filter((b) => b.hh >= 18), post = bars.filter((b) => b.hh < 16);
  if (pre.length < 300 || post.length < 100) return { td, ok: false, reason: 'not enough bars' };
  const flowBars = pre.filter((b) => b.m < 21 * 60), ask = flowBars.reduce((s, b) => s + b.av, 0), bid = flowBars.reduce((s, b) => s + b.bv, 0);
  if (ask + bid <= 0 || ask === bid) return { td, ok: false, reason: 'no flow sign' };
  const d = ask > bid ? 1 : -1, legsHl = detectRotationLegs(pre.map((b) => ({ high: b.h, low: b.l })), LEG_R).length, legsClose = detectRotationLegs(pre.map((b) => ({ high: b.c, low: b.c })), LEG_R).length;
  const mom = Math.sign(pre[pre.length - 1].c - pre[0].o) || 1, j0 = Math.max(0, post.findIndex((b) => b.m >= 0)), P0 = post[j0], rth = post.filter((b) => b.m >= 570 && b.m < 960);
  const complete = post.some((b) => b.m >= EXIT_MIN), hit = rth.length > 50 ? (Math.sign(rth[rth.length - 1].c - rth[0].o) === d ? 1 : 0) : null;
  const arms = (style) => {
    const slice = style === 'live' ? post.slice(j0 + 1) : post.slice(j0), px0 = style === 'live' ? P0.c : P0.o, run = (dir, stop) => simArm(slice, dir, px0 + dir * SLIP, stop);
    return complete ? { base: run(d, STOP_BASE), risk: run(d, STOP_RISK), mom: run(mom, STOP_BASE), mirror: run(-d, STOP_BASE) } : null;
  };
  return { td, ok: true, dir: d, flowPct: r1(100 * (ask - bid) / (ask + bid)), legsHl, legsClose, qualifiesResearch: legsHl >= RESEARCH_LEGS, qualifiesLive: legsClose >= liveLegs, hit, complete, momDir: mom, research: arms('research'), live: arms('live') };
}
const r1 = (v) => Math.round(v * 10) / 10;

function bootCI(xs, B = 2000) {
  if (xs.length < 8) return null; let seed = 987654321; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296, means = [];
  for (let b = 0; b < B; b++) { let s = 0; for (let i = 0; i < xs.length; i++) s += xs[Math.floor(rnd() * xs.length)]; means.push(s / xs.length); }
  means.sort((a, b) => a - b); return [means[Math.floor(0.025 * B)], means[Math.floor(0.975 * B)]];
}
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

/** The pre-registered forward rules applied to one rule's nights. */
export function forwardStatus(n, baseNets, hits) {
  const m = mean(baseNets), hr = hits.length ? mean(hits) : null, ci = bootCI(baseNets);
  if (n >= FAIL_MEAN_N && m < 0) return { state: 'FAILED', next: `Failure rule met: the BASE mean is below 0 after ${n} nights. Next: write the autopsy (which part failed: the gate, the flow sign or the hold) and decide with the user whether to retire it or test one named repair.` };
  if (n >= FAIL_HIT_N && hr != null && hr <= 0.5) return { state: 'FAILED', next: `Failure rule met: the RTH-direction hit rate is ${Math.round(100 * hr)} percent after ${n} nights. Next: autopsy as above.` };
  if (n >= SECOND_LOOK_N) {
    if (ci && ci[0] > 0 && hr != null && hr > CONFIRM_HIT) return { state: 'CONFIRMED', next: 'Confirmation rule met. Next: size it by account risk (the 300-point arm is the starting point), pre-register a live-sim test with the user, never the 400-point stop as built.' };
    return { state: 'INCONCLUSIVE', next: `Second look at ${n} nights is neither confirmed nor failed. Next: continue to the pre-registered horizon and write the critique of what is missing (sample, the 2026-only era, or the gate).` };
  }
  if (n >= FIRST_LOOK_N) return { state: 'FIRST LOOK', next: `First look available (${n} nights): record it in the look ledger and compare BASE with MOM and MIRROR; no decision yet.` };
  return { state: 'WATCHING', next: `Collecting: ${n} of ${FIRST_LOOK_N} qualifying nights for the first look (about one qualifying night in 3 for the research rule, about one in 11 for the live rule).` };
}

export async function getOvnArmsBoard() {
  const hit = cacheGet('ovnarms:board'); if (hit != null) return hit;
  const liveLegs = await liveThreshold();
  const c = (await query(`SELECT CURRENT_DATE::text AS cd, EXTRACT(hour FROM now())::int * 60 + EXTRACT(minute FROM now())::int AS nowm`)).rows[0];
  const dates = (await query(`SELECT DISTINCT ts::date::text AS d FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1::date::timestamp AND ts < (CURRENT_DATE + 1)::timestamp AND ts::time >= '09:30' AND ts::time < '10:00' ORDER BY 1`, [FORWARD_FROM])).rows.map((r) => r.d);
  const nights = [];
  for (const td of dates) {
    const complete = td < c.cd || (td === c.cd && c.nowm >= EXIT_MIN + 1), key = `ovnarms:night:${td}:${liveLegs}`; let n = complete ? cacheGet(key) : null;
    if (n == null) { n = await computeNight(td, liveLegs); if (complete && n.ok) cacheSet(key, n, 6 * 3600_000); }
    nights.push(n);
  }
  // the forward night that starts tonight (trade date tomorrow) is not in the RTH date list yet; the shadow rows written by the live detector are listed beside as a cross-check
  const fires = (await query(`SELECT trade_date::text AS d, setup_type, status, resolution, actual_pnl::float AS pnl, stop_level::float AS stop, price_at_detection::float AS p FROM active_setups WHERE setup_type ILIKE 'OVERNIGHT_ORDERFLOW%' ORDER BY trade_date DESC LIMIT 12`)).rows;
  const ruleBoard = (key, label, qual) => {
    const q = nights.filter((n) => n.ok && n[qual]), done = q.filter((n) => n.complete && n[key]), arm = (a) => done.map((n) => n[key][a].net), base = arm('base'), hits = done.map((n) => n.hit).filter((h) => h != null);
    const st = forwardStatus(done.length, base, hits), ci = bootCI(base);
    return { label, qualifyingNights: q.length, completeNights: done.length, inProgress: q.length - done.length, status: st.state, next: st.next, baseMean: r1(mean(base)), baseCI: ci ? [r1(ci[0]), r1(ci[1])] : null, riskMean: r1(mean(arm('risk'))), momMean: r1(mean(arm('mom'))), mirrorMean: r1(mean(arm('mirror'))), winRate: done.length ? Math.round(100 * mean(base.map((x) => (x > 0 ? 1 : 0)))) : null,
      hitRate: hits.length ? Math.round(100 * mean(hits)) : null, worstBase: base.length ? r1(Math.min(...base)) : null, worstRisk: done.length ? r1(Math.min(...arm('risk'))) : null };
  };
  const board = { state: 'OK', forwardFrom: FORWARD_FROM, nightsSeen: nights.filter((n) => n.ok).length, liveLegsThreshold: liveLegs, research: ruleBoard('research', 'Research rule (rotation legs on highs and lows >= 6)', 'qualifiesResearch'), live: ruleBoard('live', `Live detector rule (rotation legs on closes only >= ${liveLegs})`, 'qualifiesLive'),
    nights: nights.filter((n) => n.ok && (n.qualifiesResearch || n.qualifiesLive)).slice(-15).reverse().map((n) => ({ td: n.td, dir: n.dir === 1 ? 'LONG' : 'SHORT', flowPct: n.flowPct, legsHl: n.legsHl, legsClose: n.legsClose, research: n.qualifiesResearch, live: n.qualifiesLive, complete: n.complete, hit: n.hit, base: n.research?.base ? r1(n.research.base.net) : null, risk: n.research?.risk ? r1(n.research.risk.net) : null })), fires,
    notes: ['Read-only, computed from the 1-minute bars; no orders, no setup type. Entries and fills as in the research simulation (scripts/test_ovn_arms.mjs checks the port).', 'Forward rules (docs/OVN_ORDERFLOW_VARIATIONS_PREREG_20261104.md): looks at 15 and 30 qualifying nights; FAILED if the BASE mean is below 0 at 20 nights or the hit rate is 50 percent or less at 30; CONFIRMED at 30 nights when the CI of the BASE mean is above 0 and the hit rate is above 55 percent.', 'Development results and the live-vs-research difference: claims ovn_orderflow_variations_20261104, ovn_orderflow_live_rule_differs_20261104; pending decision ovn_orderflow_detector_alignment_20261104.'] };
  return cacheSet('ovnarms:board', board, 5 * 60_000);
}
