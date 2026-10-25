// Roster scoreboard (2026-10-25, docs/ROSTER_SCOREBOARD_PREREG_20261025.md). Pure computation, no DB: compares what the LIVE_ROSTER gate
// actually let through against trading everything, from the first clean day of the gate (2026-10-25 Globex open) forward.
//
// Arms (all primary rows, real fills, no *_basis rows, no 16:00-18:00 ET rows, POC_ROTATION_JOIN reported separately):
//   ROSTER_LIVE         origin_status='ACTIVE' (what actually fired under the gate)
//   ROSTER_WOULD_BE     setup_type was on the roster row IN FORCE at fired_at (ACTIVE + SHADOW origin)
//   TAKE_ALL            every row (the old regime counterfactual)
//   TAKE_ALL_EX_ROSTER  everything not on the roster at fired_at
// Per-trade means are sum/N, never the day-weighted mean (CLAUDE.md 2026-10-12). Day-blocked bootstrap for every interval.
import { dayBlockedBootstrapCI, dayBlockedBootstrapDeltaCI } from './rigorDiagnostics.js';

const WIN_RATE_MIN_N = 20;           // CLAUDE.md: a win rate is reported only at N>=20
const FIRST_LOOK_RECURRENCE_DAYS = 10; // pre-registered: one look at the derived day count, then one per 10 distinct days
const sum = (a) => a.reduce((s, x) => s + x, 0);
const mean = (a) => (a.length ? sum(a) / a.length : null);
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const sd = (a) => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(sum(a.map((x) => (x - m) ** 2)) / (a.length - 1)); };

// history: [{ createdMs, types: Set|Array }] one entry per LIVE_ROSTER row (any order). The roster in force at t is the newest row created at or
// before t -- the same row the live gate (setupEligibility.js, newest row) would have read. Before the first row: no roster (empty set).
export function buildRosterLookup(history) {
  const h = [...history].map((x) => ({ createdMs: x.createdMs, types: new Set(x.types) })).sort((a, b) => a.createdMs - b.createdMs);
  return {
    typesAt(ms) { let cur = null; for (const e of h) { if (e.createdMs <= ms) cur = e; else break; } return cur ? cur.types : new Set(); },
    // start (ms) of the continuous membership of `type` that is in force at `ms`; null if not on the roster at ms
    membershipStartAt(type, ms) {
      let start = null, on = false;
      for (const e of h) { if (e.createdMs > ms) break; if (e.types.has(type)) { if (!on) start = e.createdMs; on = true; } else { on = false; start = null; } }
      return on ? start : null;
    },
    entries: h,
  };
}

// Max drawdown of the resolve-time-ordered running sum (peak-to-trough, positive number; 0 if never below a prior peak).
export function maxDrawdown(rows) {
  const ord = [...rows].sort((a, b) => a.resolvedMs - b.resolvedMs || a.firedMs - b.firedMs);
  let eq = 0, peak = 0, dd = 0;
  for (const r of ord) { eq += r.pnl; if (eq > peak) peak = eq; if (peak - eq > dd) dd = peak - eq; }
  return dd;
}

export function armStats(rows) {
  const pnls = rows.map((r) => r.pnl);
  const byDay = new Map();
  for (const r of rows) byDay.set(r.date, (byDay.get(r.date) || 0) + r.pnl);
  const wins = pnls.filter((p) => p > 0), losses = pnls.filter((p) => p < 0);
  const grossLoss = Math.abs(sum(losses));
  return {
    n: rows.length, days: byDay.size, sum: sum(pnls), perTrade: mean(pnls),
    winRate: rows.length >= WIN_RATE_MIN_N ? wins.length / rows.length : null,
    maxDrawdown: maxDrawdown(rows), worstDay: byDay.size ? Math.min(...byDay.values()) : null,
    profitFactor: grossLoss > 0 ? sum(wins) / grossLoss : null,
  };
}

// rows: [{ id, date, firedMs, resolvedMs, setupType, origin ('ACTIVE'|'SHADOW'), pnl, isRth, clusterId, isPrimary }]
// Rows are expected pre-filtered by SQL for basis flags / NOT_FILLED / null pnl / 16-18h; POC join and the primary flag are handled here so the
// test can prove them.
export function computeScoreboard(rows, rosterHistory, { seedKey = 'ROSTER_SCOREBOARD', iters = 2000 } = {}) {
  const lookup = buildRosterLookup(rosterHistory);
  const poc = rows.filter((r) => r.setupType.startsWith('POC_ROTATION_JOIN'));
  const base = rows.filter((r) => !r.setupType.startsWith('POC_ROTATION_JOIN') && r.isPrimary !== false);
  const tagged = base.map((r) => ({ ...r, onRoster: lookup.typesAt(r.firedMs).has(r.setupType) }));
  const armRows = {
    ROSTER_LIVE: tagged.filter((r) => r.origin === 'ACTIVE'),
    ROSTER_WOULD_BE: tagged.filter((r) => r.onRoster),
    TAKE_ALL: tagged,
    TAKE_ALL_EX_ROSTER: tagged.filter((r) => !r.onRoster),
  };
  const session = (f) => Object.fromEntries(Object.entries(armRows).map(([k, v]) => [k, armStats(v.filter(f))]));
  const arms = { ALL: session(() => true), RTH: session((r) => r.isRth), GLOBEX: session((r) => !r.isRth) };

  // (a) per-day account view: difference of daily sums (WOULD_BE minus TAKE_ALL), one event per day
  const dayKeys = [...new Set(tagged.map((r) => r.date))].sort();
  const dailyDiff = dayKeys.map((d) => {
    const day = tagged.filter((r) => r.date === d);
    return { date: d, pnl: sum(day.filter((r) => r.onRoster).map((r) => r.pnl)) - sum(day.map((r) => r.pnl)) };
  });
  const diffMean = mean(dailyDiff.map((x) => x.pnl));
  const diffCI = dailyDiff.length >= 2 ? dayBlockedBootstrapCI(dailyDiff, `${seedKey}|dailyDiff`, { iters }) : { lo: null, hi: null };
  const mid = Math.floor(dailyDiff.length / 2);
  const half1 = mean(dailyDiff.slice(0, mid).map((x) => x.pnl)), half2 = mean(dailyDiff.slice(mid).map((x) => x.pnl));

  // (b) per-trade: roster trades minus the rest, non-overlapping groups, day-blocked delta CI (resamples days, pools trades per arm)
  const grouped = tagged.map((r) => ({ date: r.date, pnl: r.pnl, group: r.onRoster ? 'ROSTER' : 'REST' }));
  const nRoster = grouped.filter((g) => g.group === 'ROSTER').length, nRest = grouped.length - nRoster;
  const perTradeDelta = nRoster && nRest ? dayBlockedBootstrapDeltaCI(grouped, `${seedKey}|perTrade`, { groupField: 'group', groupA: 'REST', groupB: 'ROSTER', iters }) : { lo: null, hi: null };
  const perTradeDiff = nRoster && nRest ? mean(grouped.filter((g) => g.group === 'ROSTER').map((g) => g.pnl)) - mean(grouped.filter((g) => g.group === 'REST').map((g) => g.pnl)) : null;

  // verdict: pre-registered rule. PASS = daily-diff CI lower > 0 AND both chronological halves positive; FAIL = mirror; else NOT_SHOWN_YET.
  let verdict = 'NOT_SHOWN_YET';
  if (diffCI.lo != null && dailyDiff.length >= 4) {
    if (diffCI.lo > 0 && half1 > 0 && half2 > 0) verdict = 'PASS';
    else if (diffCI.hi < 0 && half1 < 0 && half2 < 0) verdict = 'FAIL';
  }

  // roster churn and promotion-lag: P&L of roster-type trades taken in the first 5 calendar days of that type's current membership
  const LAG_MS = 5 * 86400000;
  const lag = tagged.filter((r) => r.onRoster).map((r) => ({ ...r, ageMs: r.firedMs - lookup.membershipStartAt(r.setupType, r.firedMs) }));
  const churn = lookup.entries.map((e, i) => {
    const prev = i ? lookup.entries[i - 1].types : new Set();
    return { createdMs: e.createdMs, types: [...e.types].sort(), added: [...e.types].filter((t) => !prev.has(t)), dropped: [...prev].filter((t) => !e.types.has(t)) };
  });

  const byType = {};
  for (const r of tagged) { const t = (byType[r.setupType] ||= { rows: [], onRosterRows: 0 }); t.rows.push(r.pnl); if (r.onRoster) t.onRosterRows++; }
  const typeTable = Object.entries(byType).map(([type, v]) => ({ type, n: v.rows.length, sum: sum(v.rows), onRosterRows: v.onRosterRows }))
    .sort((a, b) => a.sum - b.sum);

  return {
    window: { days: dayKeys.length, from: dayKeys[0] || null, to: dayKeys[dayKeys.length - 1] || null },
    arms,
    comparison: {
      dailyDiff: { days: dailyDiff.length, mean: diffMean, ci: diffCI, half1, half2, series: dailyDiff },
      perTrade: { nRoster, nRest, diff: perTradeDiff, ci: perTradeDelta },
      verdict,
    },
    separate: { POC_ROTATION_JOIN: armStats(poc.filter((r) => r.isPrimary !== false)) },
    churn,
    promotionLag: { firstFiveDays: armStats(lag.filter((r) => r.ageMs < LAG_MS)), after: armStats(lag.filter((r) => r.ageMs >= LAG_MS)) },
    worstTypes: typeTable.slice(0, 8), bestTypes: typeTable.slice(-8).reverse(),
  };
}

// First-look day count (pre-registered, derived once from the explore period and then frozen): the number of distinct days at which the
// 95% half-width of the mean daily difference (WOULD_BE minus TAKE_ALL) would equal one typical day of the all-trades arm (median |daily sum|).
export function deriveFirstLookDays(dailyDiffs, dailyTakeAllSums) {
  const s = sd(dailyDiffs), typical = median(dailyTakeAllSums.map(Math.abs));
  if (s == null || !typical) return null;
  return { days: Math.max(2, Math.ceil(((1.96 * s) / typical) ** 2)), sd: s, typical, explore_days: dailyDiffs.length };
}

// Scheduled looks: the derived count, then one per FIRST_LOOK_RECURRENCE_DAYS distinct days after it.
export function lookStatus(distinctDays, firstLookDays) {
  if (!firstLookDays || distinctDays < firstLookDays) return { due: false, nextAt: firstLookDays, lookNumber: 0 };
  const k = 1 + Math.floor((distinctDays - firstLookDays) / FIRST_LOOK_RECURRENCE_DAYS);
  return { due: true, lookNumber: k, thisLookAt: firstLookDays + (k - 1) * FIRST_LOOK_RECURRENCE_DAYS, nextAt: firstLookDays + k * FIRST_LOOK_RECURRENCE_DAYS };
}
