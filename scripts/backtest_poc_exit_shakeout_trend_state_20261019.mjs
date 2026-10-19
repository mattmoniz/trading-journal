// Do POC_ROTATION_JOIN's two early-exit mechanisms -- the rotation-flip close and the breakeven-hold stop -- quit
// trades early more often when the day is trending, and would disabling them ONLY in that state beat leaving
// them on?  (OPEN_DECISION poc_exit_shakeout_in_trend_test_20261019.)
//
// PRE-REGISTERED (written before any result was seen):
//  Population: every POC_ROTATION_JOIN event from the real exported detectSignalEvents(), same window/session/theta
//    construction as scratch/poc_rotation_breakeven_hold_20261008.mjs, roll weeks and the contaminated Sep28-Nov19 2025 bar
//    window excluded. Upper bound = the DB's own yesterday, fixed for the whole run (no live-table growth confound).
//  Arms (SAME events, SAME bars, so the comparison is PAIRED -- both arms share entry, no entry-price advantage):
//    LIVE      100pt stop, snap to breakeven after 60 bars (the real stepPocBreakevenHold), rotation-flip close, 24h/next-event bound
//    NO_FLIP   LIVE without the rotation-flip close
//    NO_BE     LIVE without the breakeven snap (stop stays 100pt)         [stepPocBreakevenHold with armAtBars=Infinity]
//    NEITHER   neither exit (100pt stop to the bound)
//  State, as-of ENTRY only (no look-ahead, no tunable parameters):
//    RTH entry 10:30-15:59 ET  : TREND = entry price beyond the day's Initial Balance (9:30-10:30 high/low) in the trade direction
//    Globex entry (18:00-09:29): TREND = entry price beyond the PRIOR RTH session's high/low in the trade direction
//    Entries 09:30-10:29 (IB not complete) and Globex entries with no adjacent prior RTH day are EXCLUDED and counted.
//  The decision quantity is the difference-in-differences: DiD = mean(alt-LIVE | TREND) - mean(alt-LIVE | NOT_TREND), alt in
//    {NO_FLIP, NO_BE, NEITHER}. Per-trade means (sum/N), day-blocked bootstrap only for the CI (CLAUDE.md: a day-weighted point
//    estimate is wrong for comparing split arms). RTH and Globex are judged SEPARATELY (never pooled).
//  SUPPORTED only if, within one session type: DiD CI excludes zero; same sign and positive in BOTH chronological halves;
//    still positive after dropping the 5 biggest days; and the label-permutation p < 0.05. Anything else = not supported.
//  Controls: (a) label permutation placebo (anti-conservative: ignores day clustering, reported as such); (b) a second,
//    generic state -- entry beyond the SESSION OPEN price in trade direction -- if the generic state gives the same DiD the
//    finding is "any directional day", not the IB/prior-day-range break.
//  Reproduction check: NO_FLIP - NEITHER should land near the shipped claim poc_rotation_breakeven_hold_100pt_stop_20261008
//    (+$39.13/trade, CI [16.88, 69.28]); a big miss means this harness is not simulating the real exits.
import pool from '../server/db.js';
import { detectSignalEvents } from '../server/services/pocRotationService.js';
import { stepPocBreakevenHold } from '../server/services/pocBreakevenHoldWalker.js';
import { isInsideNqRollWeek } from '../server/services/acdShared.js';
import { dayBlockedBootstrapCI, dayBlockedBootstrapDeltaCI, mulberry32, hashSeed } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';

const WINDOW_START = '2025-06-01';
const BAD_WIN_START = new Date('2025-09-28T18:00:00-04:00');
const BAD_WIN_END = new Date('2025-11-19T16:15:00-04:00');
const STOP = 100, ARM_AT = 60, CAP_HOURS = 24, DPP = 2, COMM = 2;
const ARMS = ['LIVE', 'NO_FLIP', 'NO_BE', 'NEITHER'];

const upper = (await pool.query(`SELECT (CURRENT_DATE - 1)::text AS d, CURRENT_DATE::text AS t`)).rows[0];
const dates = (await pool.query(`SELECT DISTINCT trade_date::text d FROM developing_value_log WHERE trade_date >= $1::date AND trade_date <= $2::date ORDER BY d`,
  [WINDOW_START, upper.d])).rows.map(r => r.d).filter(d => !isInsideNqRollWeek(d));

const hhmm = (ts) => { const h = +ts.slice(11, 13), m = +ts.slice(14, 16); return h * 60 + m; };
async function getSessionBars(d) {
  return (await pool.query(`
    SELECT ts::text ts, open::float, high::float, low::float, close::float FROM price_bars_primary WHERE symbol='NQ' AND (
      (ts::date = $1::date - 1 AND EXTRACT(hour FROM ts) >= 18) OR
      (ts::date = $1::date AND (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts)) < 1020)) ORDER BY ts`, [d])).rows;
}
async function theta(d) {
  const v = (await pool.query(`SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY high - low) m FROM price_bars_primary WHERE symbol='NQ' AND ts < $1::date AND ts >= $1::date - interval '180 days'`, [d])).rows[0]?.m;
  return v ? Math.max(0.25, +v) : 6.75;
}

// ---- build events + per-session direction timelines + IB / prior-RTH ranges --------------------------------
const sessions = new Map(); // trade_date -> { bars, idxByTs, legs(confirmed order), rth:{hi,lo}|null, ib:{hi,lo}|null, open }
const events = [];
for (const d of dates) {
  const bars = await getSessionBars(d);
  if (bars.length < 100) continue;
  if (bars.some(b => { const t = new Date(b.ts.replace(' ', 'T') + '-04:00'); return t >= BAD_WIN_START && t <= BAD_WIN_END; })) continue;
  const { all_signal, all_leg_records } = detectSignalEvents(65, 'standard', await theta(d), [{ t: d, bars }], 'fixed');
  const legs = all_leg_records.filter(l => l.confirmed_idx != null && l.direction).sort((a, b) => a.confirmed_idx - b.confirmed_idx);
  const idxByTs = new Map(bars.map((b, i) => [b.ts, i]));
  const calendar = bars.filter(b => b.ts.slice(0, 10) === d);
  const rthBars = calendar.filter(b => { const m = hhmm(b.ts); return m >= 570 && m < 960; });
  const ibBars = calendar.filter(b => { const m = hhmm(b.ts); return m >= 570 && m < 630; });
  const rng = (arr) => arr.length ? { hi: Math.max(...arr.map(b => b.high)), lo: Math.min(...arr.map(b => b.low)) } : null;
  sessions.set(d, { bars, idxByTs, legs, rth: rng(rthBars), ib: rng(ibBars), open: bars[0].open });
  for (const ev of all_signal) {
    if (ev.entry_idx == null) continue;
    const eb = bars[ev.entry_idx];
    events.push({ trade_date: d, ts: eb.ts, entry: eb.open, long: ev.direction === 'UP', entryIdx: ev.entry_idx });
  }
}
events.sort((a, b) => a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0);
const sessionDates = [...sessions.keys()].sort();
console.log(`window ${WINDOW_START}..${upper.d}: ${sessionDates.length} sessions, ${events.length} events`);

// Direction of the rotation as KNOWN at bar index i of a session (no look-ahead: only legs already confirmed).
function dirAt(d, i) {
  const s = sessions.get(d); if (!s) return null;
  let dir = null;
  for (const l of s.legs) { if (l.confirmed_idx <= i) dir = l.direction; else break; }
  return dir;
}
// Session (trade_date) that a bar timestamp belongs to: 18:00+ belongs to the NEXT calendar day, <17:00 to its own day.
function sessionOf(ts) {
  const m = hhmm(ts);
  if (m >= 1020 && m < 1080) return null; // 17:00-18:00 maintenance gap
  if (m >= 1080) { const dt = new Date(ts.slice(0, 10) + 'T12:00:00Z'); dt.setUTCDate(dt.getUTCDate() + 1); return dt.toISOString().slice(0, 10); }
  return ts.slice(0, 10);
}

// ---- state (as-of entry only) --------------------------------------------------------------------------------
function stateOf(ev) {
  const m = hhmm(ev.ts), s = sessions.get(ev.trade_date);
  const beyond = (rg) => rg ? (ev.long ? ev.entry > rg.hi : ev.entry < rg.lo) : null;
  const generic = ev.long ? ev.entry > s.open : ev.entry < s.open;
  if (m >= 630 && m < 960) { const t = beyond(s.ib); return { type: 'RTH', trend: t, generic }; }
  if (m >= 570 && m < 630) return { type: 'RTH', trend: null, generic };       // IB incomplete -> excluded
  if (m >= 1080 || m < 570) {
    const i = sessionDates.indexOf(ev.trade_date);
    const prev = i > 0 ? sessionDates[i - 1] : null;
    const gap = prev ? (new Date(ev.trade_date) - new Date(prev)) / 86400000 : 99;
    const t = prev && gap <= 4 ? beyond(sessions.get(prev).rth) : null;
    return { type: 'GLOBEX', trend: t, generic };
  }
  return { type: 'GAP', trend: null, generic };
}

// ---- simulation ---------------------------------------------------------------------------------------------
function simulate(ev, fwd, arm) {
  const useFlip = arm === 'LIVE' || arm === 'NO_BE';
  const armAt = (arm === 'LIVE' || arm === 'NO_FLIP') ? ARM_AT : Infinity;
  let st = { barsElapsed: 0, armed: false };
  const pnl = (px) => ((ev.long ? px - ev.entry : ev.entry - px) * DPP) - COMM;
  for (const b of fwd) {
    const r = stepPocBreakevenHold(st, b, { entry: ev.entry, long: ev.long, stop: STOP, armAtBars: armAt });
    if (r.resolution) return { pnl: pnl(r.resolution.priceAtRes), how: r.resolution.method };
    st = r.state;
    if (useFlip) {
      const sd = sessionOf(b.ts);
      const idx = sd ? sessions.get(sd)?.idxByTs.get(b.ts) : null;
      const dir = sd && idx != null ? dirAt(sd, idx) : null;
      if (dir && (dir === 'UP') !== ev.long) return { pnl: pnl(b.close), how: 'ROTATION_FLIP' };
    }
  }
  return { pnl: fwd.length ? pnl(fwd[fwd.length - 1].close) : 0, how: 'BOUND' };
}

const rows = [];
let excluded = { ibIncomplete: 0, noPriorRth: 0, gap: 0 };
for (let i = 0; i < events.length - 1; i++) {
  const ev = events[i];
  const stt = stateOf(ev);
  if (stt.type === 'GAP') { excluded.gap++; continue; }
  if (stt.trend == null) { stt.type === 'RTH' ? excluded.ibIncomplete++ : excluded.noPriorRth++; continue; }
  // Bound = the earlier of the next event (either direction) and entry + 24h, all in naive-ET digits like the live row's own
  // expires_at (the 2026-10-08 script converted the cap through toISOString(), i.e. UTC digits against a naive ET column).
  const capTs = new Date(new Date(ev.ts.replace(' ', 'T') + 'Z').getTime() + CAP_HOURS * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  const nextTs = events[i + 1].ts;
  const boundTs = nextTs < capTs ? nextTs : capTs;
  const fwd = (await pool.query(`SELECT ts::text ts, high::float high, low::float low, close::float close FROM price_bars_primary WHERE symbol='NQ' AND ts > $1::timestamp AND ts <= $2::timestamp ORDER BY ts`, [ev.ts, boundTs])).rows;
  if (fwd.length < 2) continue;
  const res = {}; for (const a of ARMS) res[a] = simulate(ev, fwd, a);
  rows.push({ date: ev.trade_date, ts: ev.ts, type: stt.type, trend: stt.trend ? 'TREND' : 'NOT_TREND', generic: stt.generic ? 'TREND' : 'NOT_TREND', pnl: Object.fromEntries(ARMS.map(a => [a, res[a].pnl])), how: res.LIVE.how });
}
console.log(`paired events: ${rows.length} | excluded: IB incomplete ${excluded.ibIncomplete}, no adjacent prior RTH ${excluded.noPriorRth}, maintenance gap ${excluded.gap}`);

// ---- analysis -----------------------------------------------------------------------------------------------
const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const f = (x) => Number.isFinite(x) ? x.toFixed(2) : 'n/a';
const ci = (ev, key) => ev.length >= 5 ? dayBlockedBootstrapCI(ev, key) : null;
const fmtCi = (c) => c ? `[${f(c.lo)},${f(c.hi)}]` : '[n/a]';
const deltaEv = (arr, alt, stateKey = 'trend') => arr.map(r => ({ date: r.date, group: r[stateKey], pnl: r.pnl[alt] - r.pnl.LIVE }));

console.log('\n== reproduction check: NO_FLIP - NEITHER (shipped claim +39.13, CI [16.88,69.28], day-weighted mean) ==');
{
  const e = rows.map(r => ({ date: r.date, pnl: r.pnl.NO_FLIP - r.pnl.NEITHER }));
  console.log(`n=${e.length} per-trade mean=${f(mean(e.map(x => x.pnl)))} CI${fmtCi(ci(e, 'repro'))}`);
}
console.log('\n== arm levels, all paired events ==');
for (const a of ARMS) console.log(`${a.padEnd(8)} mean=${f(mean(rows.map(r => r.pnl[a])))}`);

const verdicts = [];
for (const type of ['RTH', 'GLOBEX']) {
  const sub = rows.filter(r => r.type === type);
  console.log(`\n================ ${type} (n=${sub.length}, days=${new Set(sub.map(r => r.date)).size}) ================`);
  console.log(`TREND n=${sub.filter(r => r.trend === 'TREND').length}  NOT_TREND n=${sub.filter(r => r.trend === 'NOT_TREND').length}`);
  for (const alt of ['NO_FLIP', 'NO_BE', 'NEITHER']) {
    const d = deltaEv(sub, alt);
    const t = d.filter(x => x.group === 'TREND'), n = d.filter(x => x.group === 'NOT_TREND');
    const did = mean(t.map(x => x.pnl)) - mean(n.map(x => x.pnl));
    const dci = (t.length >= 5 && n.length >= 5) ? dayBlockedBootstrapDeltaCI(d, `shake|${type}|${alt}`, { groupA: 'NOT_TREND', groupB: 'TREND' }) : null;
    // halves
    const days = [...new Set(sub.map(r => r.date))].sort(); const mid = days[Math.floor(days.length / 2)];
    const half = (pred) => { const h = d.filter(x => pred(x.date)); const a = h.filter(x => x.group === 'TREND'), b = h.filter(x => x.group === 'NOT_TREND'); return mean(a.map(x => x.pnl)) - mean(b.map(x => x.pnl)); };
    const h1 = half(x => x < mid), h2 = half(x => x >= mid);
    // drop the 5 biggest days (by |sum of delta|)
    const byDay = new Map(); for (const x of d) byDay.set(x.date, (byDay.get(x.date) || 0) + x.pnl);
    const top5 = new Set([...byDay.entries()].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 5).map(e => e[0]));
    const dd = d.filter(x => !top5.has(x.date));
    const didX = mean(dd.filter(x => x.group === 'TREND').map(x => x.pnl)) - mean(dd.filter(x => x.group === 'NOT_TREND').map(x => x.pnl));
    // label permutation placebo (event-level, anti-conservative)
    const rand = mulberry32(hashSeed(`perm|${type}|${alt}|${d.length}`)); const labels = d.map(x => x.group); let ge = 0; const P = 2000;
    for (let p = 0; p < P; p++) {
      for (let i = labels.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [labels[i], labels[j]] = [labels[j], labels[i]]; }
      let sa = 0, na = 0, sb = 0, nb = 0; for (let i = 0; i < d.length; i++) { if (labels[i] === 'TREND') { sa += d[i].pnl; na++; } else { sb += d[i].pnl; nb++; } }
      if (Math.abs(sa / na - sb / nb) >= Math.abs(did)) ge++;
    }
    const pval = (ge + 1) / (P + 1);
    // generic-state control
    const g = deltaEv(sub, alt, 'generic'); const gdid = mean(g.filter(x => x.group === 'TREND').map(x => x.pnl)) - mean(g.filter(x => x.group === 'NOT_TREND').map(x => x.pnl));
    const supported = dci && dci.lo > 0 && h1 > 0 && h2 > 0 && didX > 0 && pval < 0.05;
    console.log(`${alt.padEnd(8)} mean(alt-LIVE): TREND=${f(mean(t.map(x => x.pnl)))} NOT=${f(mean(n.map(x => x.pnl)))} | DiD=${f(did)} CI${fmtCi(dci)} | halves ${f(h1)}/${f(h2)} | drop-top5 ${f(didX)} | perm p=${pval.toFixed(3)} | generic-state DiD=${f(gdid)} => ${supported ? 'SUPPORTED' : 'not supported'}`);
    verdicts.push({ type, alt, did, ci: dci, h1, h2, didX, pval, gdid, supported, nT: t.length, nN: n.length });
  }
}
const anySupported = verdicts.some(v => v.supported);
console.log(`\nOVERALL: ${anySupported ? 'at least one state-conditional disable is supported' : 'NO state-conditional disable is supported'}`);

await recordClaim({
  slug: 'poc_exit_shakeout_trend_state_20261019',
  claimText: `POC_ROTATION_JOIN exit shakeout by trend state (as-of-entry IB break for RTH, prior-RTH-range break for Globex), paired arms LIVE/NO_FLIP/NO_BE/NEITHER on ${rows.length} events through ${upper.d}. ` +
    verdicts.map(v => `${v.type} ${v.alt}: DiD ${f(v.did)} CI${fmtCi(v.ci)} halves ${f(v.h1)}/${f(v.h2)} p=${v.pval.toFixed(3)} ${v.supported ? 'SUPPORTED' : 'no'} (nTrend ${v.nT}, nNot ${v.nN})`).join('; ') +
    `. Pre-registered rule in scripts/backtest_poc_exit_shakeout_trend_state_20261019.mjs header. ${anySupported ? '' : 'Nothing supported: do not change the live exits.'}`.slice(0, 1800),
  sourceFile: 'scripts/backtest_poc_exit_shakeout_trend_state_20261019.mjs', sourceDate: upper.d,
  sampleSize: rows.length, winRate: null, evPerTrade: null,
  rigorStatus: 'paired, day-blocked CI, halves + top-5 + permutation + generic-state control', status: 'PROVISIONAL',
});
process.exit(0);
