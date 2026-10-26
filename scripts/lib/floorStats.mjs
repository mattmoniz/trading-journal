// Shared statistics for the floor/entry/context studies (extracted 2026-10-26 from study_floor_context_narrowing_20261026.mjs so the studies stop carrying private copies).
import { hashSeed, mulberry32 } from '../../server/services/rigorDiagnostics.js';
import { mean } from './floorEngine.mjs';
export const ITERS = 2000, MIN_DAYS = 20, MIN_DIS = 30;
export const f3 = (x) => (x == null || Number.isNaN(x) ? '  n/a ' : (x >= 0 ? '+' : '') + x.toFixed(3));
export const qnt = (a, q) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.floor(q * s.length)))] : NaN; };
// strata-weighted (by not-flagged count) mean difference between flagged and unflagged within strata
export function strat(items, flag, val) { const S = new Map(); for (const x of items) { (S.get(x.stratum) || S.set(x.stratum, { a: [], d: [] }).get(x.stratum))[flag(x) ? 'a' : 'd'].push(val(x)); } let num = 0, den = 0; for (const s of S.values()) if (s.a.length >= 2 && s.d.length >= 2) { num += s.d.length * (mean(s.a) - mean(s.d)); den += s.d.length; } return den ? num / den : NaN; }
export function blockBoot(items, stat, keyFn, seed) { const grp = new Map(); for (const x of items) { const k = keyFn(x); (grp.get(k) || grp.set(k, []).get(k)).push(x); } const keys = [...grp.keys()], rng = mulberry32(hashSeed(seed)), d = []; for (let it = 0; it < ITERS; it++) { const pool = []; for (let k = 0; k < keys.length; k++) pool.push(...grp.get(keys[Math.floor(rng() * keys.length)])); const v = stat(pool); if (Number.isFinite(v)) d.push(v); } return { lo: qnt(d, 0.025), hi: qnt(d, 0.975) }; }
export const dcount = (x) => new Set(x.map((e) => e.day)).size;
export const ex = (e) => (e.ret[60] != null && e.ctl && e.ctl[60] != null ? e.ret[60] - e.ctl[60] : null);
