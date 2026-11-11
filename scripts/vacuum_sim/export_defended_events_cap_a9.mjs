// Read-only export of the explore DEFENDED-LEVEL events (MAJOR and MINOR live rules, their REAL functions, window 2023-04-01..2025-05-17 exclusive) with their own live-config simulated exits, for capitulation_replay_a9.py
// (docs/CAPITULATION_EXIT_DEFENDED_PREREG_20261109.md). OUTCOME-BEARING (pnl): read only by the --go replay. Naive ET strings by arithmetic (cv-074).
import fs from 'fs';
import { query } from '../../server/db.js';
import { computeDefendedBreaks, MAJOR_PIVOT_CONFIG, majorPivotIsGlobexMod, majorPivotPlus5m } from '../../server/services/majorPivotDefendedBreakDetector.js';
import { computeMinorDefendedLevelSignals, MINOR_DEFENDED_CONFIG, MINOR_DEFENDED_MIN_STOP_ATR_FRAC } from '../../server/services/minorDefendedLevelDetector.js';
import { isInNewEntryDeadZone, isInRthOpenDeadZone } from '../../server/services/acdShared.js';
const WINDOW = { from: '2023-04-01', to: '2025-05-17' };
const ms = (s) => { const t = s.slice(0, 19); return Date.UTC(+t.slice(0, 4), +t.slice(5, 7) - 1, +t.slice(8, 10), +t.slice(11, 13), +t.slice(14, 16), +t.slice(17, 19) || 0); };
const fmt = (m) => new Date(m).toISOString().slice(0, 19).replace('T', ' ');
const modOf = (s) => +s.slice(11, 13) * 60 + +s.slice(14, 16);
// minute bars of the window, by month, into flat arrays
const T = [], O = [], H = [], Lw = [], Cl = [];
for (let d = new Date(WINDOW.from + 'T00:00:00Z'); d < new Date(WINDOW.to + 'T00:00:00Z'); d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) {
  const a = d.toISOString().slice(0, 10), nx = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)), b = (nx.toISOString().slice(0, 10) > WINDOW.to ? WINDOW.to : nx.toISOString().slice(0, 10));
  const r = await query(`SELECT to_char(ts,'YYYY-MM-DD HH24:MI:SS') t, open::float o, high::float h, low::float l, close::float c FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1::date AND ts < $2::date ORDER BY ts`, [a, b]);
  for (const x of r.rows) { T.push(ms(x.t)); O.push(x.o); H.push(x.h); Lw.push(x.l); Cl.push(x.c); }
}
console.log('minute bars', T.length, fmt(T[0]), '..', fmt(T[T.length - 1]));
function lowerBound(t) { let lo = 0, hi = T.length; while (lo < hi) { const m = (lo + hi) >> 1; if (T[m] < t) lo = m + 1; else hi = m; } return lo; }
function sim(entryMs, entry, sign, stopPx, tgtPx, holdMin) {
  const end = entryMs + holdMin * 60000; let i = lowerBound(entryMs);
  for (; i < T.length; i++) {
    if (T[i] >= end) return { exit: O[i], rsMs: T[i], kind: 'HOLD' };
    const stopHit = sign === 1 ? Lw[i] <= stopPx : H[i] >= stopPx, tgtHit = sign === 1 ? H[i] >= tgtPx : Lw[i] <= tgtPx;
    if (stopHit) return { exit: sign === 1 ? Math.min(stopPx, O[i]) : Math.max(stopPx, O[i]), rsMs: T[i], kind: 'STOP' };
    if (tgtHit) return { exit: sign === 1 ? Math.max(tgtPx, O[i]) : Math.min(tgtPx, O[i]), rsMs: T[i], kind: 'TARGET' };
  }
  return null;                                                // censored: the hold would run past the window end
}
const out = []; let id = 910000000; const cens = { MAJOR: 0, MINOR: 0 }, skipDZ = { MAJOR: 0, MINOR: 0 };
const push = (rule, grp, setup, sign, entryMs, entry, s, atr, extra) => {
  const f = fmt(entryMs), rs = fmt(s.rsMs); out.push({ id: ++id, rule, grp, setup_type: setup, side: sign, td: new Date(entryMs + 6 * 3600000).toISOString().slice(0, 10), f, rs, p0: entry, pnl: sign * (s.exit - entry) * 2 - 2, kind: s.kind, atr, ...extra });
};
const breaks = await computeDefendedBreaks(1.5, null, WINDOW);
console.log('major breaks (defended, window)', breaks.length);
for (const b of breaks) {
  const sign = b.direction === 'LONG' ? 1 : -1, closeMod = modOf(b.closeTsStr), session = majorPivotIsGlobexMod(modOf(b.entryTsStr)) ? 'GLOBEX' : 'RTH', cfg = MAJOR_PIVOT_CONFIG[session];
  if (session === 'RTH' && (isInNewEntryDeadZone(closeMod) || isInRthOpenDeadZone(closeMod))) { skipDZ.MAJOR++; continue; }
  const stopDist = Math.abs(b.entryPrice - b.stopPrice) * cfg.stopMult, stopPx = b.entryPrice - sign * stopDist, tgtPx = b.entryPrice + sign * cfg.targetMult * b.atr, entryMs = ms(b.closeTsStr);
  const s = sim(entryMs, b.entryPrice, sign, stopPx, tgtPx, cfg.holdMin); if (!s) { cens.MAJOR++; continue; }
  push('MAJOR', 'MAJOR_' + session, `MAJOR_PIVOT_DEFENDED_BREAK_${b.direction}`, sign, entryMs, b.entryPrice, s, b.atr, { streak: b.streak, target: Math.abs(tgtPx - b.entryPrice) });
}
const sigs = await computeMinorDefendedLevelSignals(WINDOW);
console.log('minor signals (window)', sigs.length);
for (const q of sigs) {
  if (isInNewEntryDeadZone(q.mod) || isInRthOpenDeadZone(q.mod)) { skipDZ.MINOR++; continue; }
  const sign = q.direction === 'LONG' ? 1 : -1, stopDist = Math.max(Math.abs(q.entryPrice - q.actualExtreme) * MINOR_DEFENDED_CONFIG.stopMult, q.atr * MINOR_DEFENDED_MIN_STOP_ATR_FRAC);
  const stopPx = q.entryPrice - sign * stopDist, tgtPx = q.entryPrice + sign * MINOR_DEFENDED_CONFIG.targetMult * q.atr, entryMs = ms(q.entryTsStr) + 60000;   // the signal minute's close = its start + 1 min
  const s = sim(entryMs, q.entryPrice, sign, stopPx, tgtPx, MINOR_DEFENDED_CONFIG.holdMin); if (!s) { cens.MINOR++; continue; }
  push('MINOR', 'MINOR', `MINOR_DEFENDED_LEVEL_${q.direction}`, sign, entryMs, q.entryPrice, s, q.atr, { target: Math.abs(tgtPx - q.entryPrice) });
}
fs.writeFileSync('scratch/capitulation_replay_20261109/a9_defended_rows.json', JSON.stringify(out));
const cnt = (g) => out.filter((x) => x.grp === g).length;
console.log('rows', out.length, { MAJOR_RTH: cnt('MAJOR_RTH'), MAJOR_GLOBEX: cnt('MAJOR_GLOBEX'), MINOR: cnt('MINOR') }, 'censored', cens, 'dead-zone skipped', skipDZ); process.exit(0);
