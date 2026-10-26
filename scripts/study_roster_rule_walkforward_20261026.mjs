// Pre-registered in docs/ROSTER_RULE_WALKFORWARD_PREREG_20261026.md (committed before this ran).
// Replays the REAL LIVE_ROSTER rule (evaluateType/buildRoster from calibrate_live_roster.mjs) day by day with only data
// dated <= t, applies R_t to the events of the next trading date, and compares with other testable types and a random-pick placebo.
import { query } from '../server/db.js';
import { collapseClusterSiblings, hashSeed, mulberry32 } from '../server/services/rigorDiagnostics.js';
import { evaluateType, buildRoster, MIN_DAYS } from './calibrate_live_roster.mjs';
import { recordClaim } from './record_claim.mjs';

const ITERS = 2000;
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

async function loadEvents() {
  const rows = (await query(`SELECT setup_type, trade_date::text d, cluster_touch_id cl, actual_pnl::float p, resolved_at::text ra FROM active_setups
    WHERE origin_status IN ('ACTIVE','SHADOW') AND trade_date >= '2026-07-09' AND trade_date < CURRENT_DATE AND actual_pnl IS NOT NULL
      AND resolved_at IS NOT NULL AND resolution IS DISTINCT FROM 'NOT_FILLED' AND ib_window_stale_basis IS NOT TRUE AND stale_entry_price_basis IS NOT TRUE
      AND late_fill_past_expiry_basis IS NOT TRUE AND bad_bars_basis IS NOT TRUE
      AND NOT (fired_at::time >= '16:00' AND fired_at::time < '18:00') AND setup_type NOT LIKE 'POC_ROTATION_JOIN%'`)).rows;
  const by = new Map(); for (const r of rows) (by.get(r.setup_type) || by.set(r.setup_type, []).get(r.setup_type)).push(r);
  return by; // type -> raw rows; collapsed per snapshot so each build only sees what was resolved by the 20:23 ET cron
}
const CRON = '20:23:00';
const collapse = (rs) => collapseClusterSiblings(rs.map((r) => ({ date: r.d, pnl: r.p, cluster_touch_id: r.cl })));
const histAt = (rs, t) => collapse(rs.filter((r) => r.ra <= `${t} ${CRON}`)); // Amendment 1 item 2: no same-day lookahead
const fwdOn = (rs, d) => collapse(rs.filter((r) => r.d === d));

// floors: {days, events}; wrapper over the real evaluateType (its own thin test is lower, so a pre-filter is exact)
function evalWith(floors, events, seed) {
  const days = new Set(events.map((e) => e.date)).size;
  if (events.length < floors.events || days < floors.days) return { n: events.length, days, thin: true, pass: false, passLeaveBestDayOut: false };
  return evaluateType(events, seed);
}

function replay(ev, dates, floors) {
  const known = new Set(ev.keys());
  let prev = null; const out = []; // Amendment 1 item 4: null until a roster first exists, then the real previous set
  for (let i = 0; i < dates.length - 1; i++) {
    const t = dates[i], next = dates[i + 1];
    const evals = new Map(), testable = [];
    for (const [type, es] of ev) {
      const hist = histAt(es, t);
      const e = evalWith(floors, hist, type);
      evals.set(type, e);
      if (!e.thin) testable.push(type);
    }
    const roles = buildRoster(evals, prev, known, false);
    const roster = new Set([...roles].filter(([, r]) => r.role === 'passing').map(([k]) => k));
    out.push({ t, next, roster, testable: new Set(testable), evals });
    if (prev !== null || roster.size > 0) prev = roster;
  }
  return out;
}

function forwardPools(ev, steps) {
  // per step: forward events by arm
  return steps.map((s) => {
    const roster = [], other = [], byType = new Map();
    for (const [type, es] of ev) {
      const f = fwdOn(es, s.next);
      if (!f.length) continue;
      byType.set(type, f);
      if (s.roster.has(type)) roster.push(...f); else if (s.testable.has(type)) other.push(...f);
    }
    return { ...s, rosterFwd: roster, otherFwd: other, byType };
  });
}

const perTrade = (a) => (a.length ? a.reduce((s, x) => s + x.pnl, 0) / a.length : NaN);

function dayBlockedDiff(pools, seedKey) {
  const rng = mulberry32(hashSeed(seedKey));
  const idx = pools.map((_, i) => i);
  const diffs = [];
  for (let it = 0; it < ITERS; it++) {
    let rs = 0, rn = 0, os = 0, on = 0;
    for (let k = 0; k < idx.length; k++) {
      const p = pools[idx[Math.floor(rng() * idx.length)]];
      for (const e of p.rosterFwd) { rs += e.pnl; rn++; }
      for (const e of p.otherFwd) { os += e.pnl; on++; }
    }
    if (rn && on) diffs.push(rs / rn - os / on);
  }
  return { lo: pct(diffs, 0.025), hi: pct(diffs, 0.975), valid: diffs.length };
}

function placebo(pools, seedKey, halfIdx) {
  const rng = mulberry32(hashSeed(seedKey)); const all = [], h1 = [], h2 = [];
  const cand = pools.map((p) => [...p.testable]);
  for (let it = 0; it < ITERS; it++) {
    let s = 0, n = 0, s1 = 0, n1 = 0, s2 = 0, n2 = 0;
    for (let i = 0; i < pools.length; i++) {
      const k = pools[i].roster.size; if (!k) continue;
      const pool = cand[i].slice();
      for (let j = 0; j < k && pool.length; j++) {
        const x = Math.floor(rng() * pool.length); const type = pool.splice(x, 1)[0];
        for (const e of pools[i].byType.get(type) || []) { s += e.pnl; n++; if (i < halfIdx) { s1 += e.pnl; n1++; } else { s2 += e.pnl; n2++; } }
      }
    }
    if (n) all.push(s / n); if (n1) h1.push(s1 / n1); if (n2) h2.push(s2 / n2);
  }
  return { all, h1, h2 };
}

function summarize(label, ev, dates, floors) {
  const steps = replay(ev, dates, floors);
  const pools = forwardPools(ev, steps);
  const used = pools.filter((p) => p.roster.size > 0);
  const all = pools.filter((p) => p.rosterFwd.length || p.otherFwd.length);
  const rosterEvents = pools.flatMap((p) => p.rosterFwd), otherEvents = pools.flatMap((p) => p.otherFwd);
  const res = { label, floors, dates: dates.length, daysWithRoster: used.length, daysWithRosterEvents: pools.filter((p) => p.rosterFwd.length).length,
    rosterN: rosterEvents.length, rosterMean: perTrade(rosterEvents), otherN: otherEvents.length, otherMean: perTrade(otherEvents),
    allMean: perTrade([...rosterEvents, ...otherEvents]) };
  res.diff = res.rosterMean - res.otherMean;
  if (rosterEvents.length) {
    res.ci = dayBlockedDiff(all, label + ':diff');
    // halves are over ALL forward days (pools), split at the median forward day with any events
    const evDays = pools.map((p, i) => (p.rosterFwd.length || p.otherFwd.length ? i : -1)).filter((i) => i >= 0);
    const halfIdx = evDays[Math.floor(evDays.length / 2)];
    const pb = placebo(pools, label + ':placebo', halfIdx); res.placeboN = pb.all.length; res.placebo = { p2_5: pct(pb.all, 0.025), p50: pct(pb.all, 0.5), p97_5: pct(pb.all, 0.975) };
    res.rosterPctile = pb.all.length ? pb.all.filter((x) => x < res.rosterMean).length / pb.all.length : null;
    const r1 = perTrade(pools.slice(0, halfIdx).flatMap((p) => p.rosterFwd)), r2 = perTrade(pools.slice(halfIdx).flatMap((p) => p.rosterFwd));
    res.halves = { roster: [r1, r2], placeboMedian: [pb.h1.length ? pct(pb.h1, 0.5) : null, pb.h2.length ? pct(pb.h2, 0.5) : null],
      rosterN: [pools.slice(0, halfIdx).flatMap((p) => p.rosterFwd).length, pools.slice(halfIdx).flatMap((p) => p.rosterFwd).length] };
    res.shown = res.rosterMean > res.placebo.p97_5 && r1 > res.halves.placeboMedian[0] && r2 > res.halves.placeboMedian[1];
  }
  // secondary: first-pass table
  const first = new Map(), churn = { promotions: 0, demotions: 0 };
  let prevR = new Set();
  for (const s of steps) {
    for (const t of s.roster) if (!prevR.has(t)) { churn.promotions++; if (!first.has(t)) first.set(t, { date: s.t, ...s.evals.get(t) }); }
    for (const t of prevR) if (!s.roster.has(t)) churn.demotions++;
    prevR = s.roster;
  }
  res.churn = churn;
  res.testableEver = new Set(steps.flatMap((s) => [...s.testable])).size;
  res.firstPass = [...first].map(([type, f]) => {
    const es = collapse(ev.get(type)), firstEvent = es.map((e) => e.date).sort()[0];
    const fwd = pools.filter((p) => p.roster.has(type)).flatMap((p) => p.byType.get(type) || []);
    const daysSinceFirst = dates.filter((d) => d >= firstEvent && d <= f.date).length;
    return { type, firstPassDate: f.date, histDays: f.days, histEvents: f.n, tradingDaysSinceFirstEvent: daysSinceFirst, inSampleMean: f.mean, ciLo: f.lo,
      fwdN: fwd.length, fwdMean: fwd.length ? perTrade(fwd) : null };
  });
  return res;
}

function impliedSpeed(ev) {
  const rows = [];
  for (const [type, raw] of ev) {
    const es = collapse(raw);
    const byDay = new Map(); for (const e of es) byDay.set(e.date, (byDay.get(e.date) || 0) + e.pnl);
    const d = [...byDay.values()]; if (d.length < MIN_DAYS) continue;
    const m = mean(d), sd = Math.sqrt(d.reduce((s, x) => s + (x - m) ** 2, 0) / (d.length - 1));
    rows.push({ type, activeDays: d.length, meanDay: m, sdDay: sd, daysIfTrue: m > 0 ? (1.96 * sd / m) ** 2 : null });
  }
  return rows.sort((a, b) => (a.daysIfTrue ?? 1e9) - (b.daysIfTrue ?? 1e9));
}

async function main() {
  const ev = await loadEvents();
  const dates = [...new Set([...ev.values()].flatMap((es) => es.map((e) => e.d)))].sort();
  console.log(`types ${ev.size}, trading dates ${dates.length}, ${dates[0]}..${dates[dates.length - 1]}`);
  const A = summarize('LIVE_FLOORS_5d', ev, dates, { days: MIN_DAYS, events: MIN_DAYS });
  const B = summarize('OLD_FLOORS_10d_20ev', ev, dates, { days: 10, events: 20 });
  const speed = impliedSpeed(ev);
  const out = { upperDate: dates[dates.length - 1], A, B, speedTop: speed.slice(0, 15), speedMedianSdDay: pct(speed.map((r) => r.sdDay), 0.5) };
  const fs = await import('node:fs'); fs.writeFileSync('scratch/roster_rule_walkforward_20261026.json', JSON.stringify(out, null, 1));
  for (const R of [A, B]) {
    console.log(`\n== ${R.label}: dates ${R.dates}, days with a roster ${R.daysWithRoster}, days with roster events ${R.daysWithRosterEvents}`);
    console.log(`roster fwd N=${R.rosterN} mean ${R.rosterMean?.toFixed(2)} | other testable N=${R.otherN} mean ${R.otherMean?.toFixed(2)} | diff ${R.diff?.toFixed(2)}`);
    if (R.ci) {
      console.log(`PRIMARY placebo 2.5/50/97.5 = ${R.placebo.p2_5.toFixed(2)}/${R.placebo.p50.toFixed(2)}/${R.placebo.p97_5.toFixed(2)}; roster pctile ${R.rosterPctile?.toFixed(3)}; halves roster ${R.halves.roster.map((x) => x?.toFixed(2))} (N ${R.halves.rosterN}) vs placebo median ${R.halves.placeboMedian.map((x) => x?.toFixed(2))} => ${R.shown ? 'SHOWN' : 'INCONCLUSIVE'} (rule constants fit on the full window)`);
      console.log(`descriptive roster-minus-other CI [${R.ci.lo.toFixed(2)}, ${R.ci.hi.toFixed(2)}] half-width ${((R.ci.hi - R.ci.lo) / 2).toFixed(2)}, placebo 95% spread width ${(R.placebo.p97_5 - R.placebo.p2_5).toFixed(2)}`);
    }
    console.log(`churn ${JSON.stringify(R.churn)}, testable ever ${R.testableEver}, ever promoted ${R.firstPass.length}`);
    for (const f of R.firstPass) console.log(`  ${f.type.padEnd(30)} first ${f.firstPassDate} hist ${f.histEvents}ev/${f.histDays}d (${f.tradingDaysSinceFirstEvent} tdays since first event) inSample ${f.inSampleMean.toFixed(1)} CIlo ${f.ciLo.toFixed(1)} | fwd N=${f.fwdN} mean ${f.fwdMean == null ? 'n/a' : f.fwdMean.toFixed(1)}`);
  }
  console.log('\nimplied days-to-significance if observed mean were true (fastest 15):');
  for (const r of speed.slice(0, 15)) console.log(`  ${r.type.padEnd(30)} activeDays ${r.activeDays} mean/day ${r.meanDay.toFixed(1)} sd/day ${r.sdDay.toFixed(1)} -> ${r.daysIfTrue == null ? 'n/a' : r.daysIfTrue.toFixed(0)} days`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
