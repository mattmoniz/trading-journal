// Event model for the directional-bias-state study (docs/DIRECTIONAL_BIAS_STATE_SPEC.md section 10/10.1, locked definitions).
// Shared by study_bias_state_l1.mjs (market level) and study_bias_state_l2.mjs (roster level) so the state is defined once.
import { openZonesFast, normRange, median, mean, pctRank } from './biasStateData.mjs';

export const FIT_END = '2026-10-10';
export function makeModel(S, Z) {
  const LOOK = 2, PCT_ON = 80, MIN_BASE = 25, MAX_BASE = 60, DIST_MULT = 2;

// per plan, price at checkpoint and "then" price (same clock, LOOK sessions earlier)
const plans = {
  RTH: { px: (i) => S[i].g[S[i].g.length - 1].c, cpIdx: (i) => i, includeG: true, h1: (i) => S[i].rClose, h2: (i) => (S[i + 1] ? S[i + 1].rClose : null), valid: (i) => i >= LOOK && i + 1 < S.length },
  GLX: { px: (i) => S[i].lastClose, cpIdx: (i) => i + 1, includeG: false, h1: (i) => (S[i + 1] ? S[i + 1].rClose : null), h2: (i) => (S[i + 2] ? S[i + 2].rClose : null), valid: (i) => i >= LOOK && i + 2 < S.length },
};
function cSeries(plan, look = LOOK) { // C_i = (px_i - px_{i-look}) / normRange (as-of)
  const P = plans[plan], out = new Array(S.length).fill(NaN);
  for (let i = look; i < S.length; i++) { const nr = normRange(S, plan === 'GLX' ? i + 1 : i); if (!Number.isFinite(nr)) continue; out[i] = (P.px(i) - P.px(i - look)) / nr; }
  return out;
}
function cPct(C, i) { const base = []; for (let j = Math.max(0, i - MAX_BASE); j < i; j++) if (Number.isFinite(C[j])) base.push(Math.abs(C[j])); return base.length >= MIN_BASE ? pctRank(base, Math.abs(C[i])) : NaN; }
function zoneSizeMedian(i) { const t = Z.filter((z) => z.i >= i - MAX_BASE && z.i < i); const sess = new Set(t.map((z) => z.i)); return sess.size >= 15 ? median(t.map((z) => z.size)) : NaN; }
function stretchOn(i, d, plan) { // descriptive rung: close position in trailing-60 closing range >= .75 (d down) AND 20-session return pct >= 70 vs prior 120
  const P = plans[plan]; if (i < 45) return null;
  const hist = []; for (let j = Math.max(20, i - 120); j < i; j++) hist.push(P.px(j) - P.px(j - 20));
  if (hist.length < 40) return null;
  const closes = []; for (let j = Math.max(0, i - 60); j < i; j++) closes.push(P.px(j)); const lo = Math.min(...closes), hi = Math.max(...closes), px = P.px(i);
  const pos = (px - lo) / (hi - lo || 1), ret = px - P.px(i - 20);
  return d < 0 ? pos >= 0.75 && pctRank(hist, ret) >= 70 : pos <= 0.25 && pctRank(hist.map((x) => -x), -ret) >= 70;
}
function moveFrom(plan, i, which) { const P = plans[plan], h = which === 'h1' ? P.h1(i) : P.h2(i); return h == null ? null : h - P.px(i); }

function events(plan, look = LOOK, fitEnd = FIT_END) {
  const C = cSeries(plan, look), P = plans[plan], ev = []; let prevD = 0;
  for (let i = look; i < S.length; i++) {
    if (S[i].d > fitEnd || !P.valid(i) || S[i].roll) { prevD = 0; continue; }
    const pct = cPct(C, i); const d = Math.sign(C[i]);
    const on = Number.isFinite(pct) && pct >= PCT_ON && d !== 0;
    if (!on) { prevD = 0; continue; }
    if (d === prevD) continue; // same episode continues; only the first checkpoint is the event
    prevD = d;
    const px = P.px(i), nr = normRange(S, plan === 'GLX' ? i + 1 : i), side = d < 0 ? 'BELOW' : 'ABOVE', wantLoc = d < 0 ? 'LOW_TAIL' : 'HIGH_TAIL';
    const zs = zoneSizeMedian(plan === 'GLX' ? i + 1 : i);
    const cands = openZonesFast(S, Z, P.cpIdx(i), P.includeG, px, side).filter((z) => z.loc === wantLoc && z.size >= zs && z.dist <= DIST_MULT * nr);
    const zone = cands[0] || null;
    ev.push({ i, d: S[i].d, dir: d, pct, nr, zone, hasP: !!zone, stretch: stretchOn(i, d, plan),
      m1: moveFrom(plan, i, 'h1'), m2: moveFrom(plan, i, 'h2') });
  }
  return ev;
}
// sign-matched drift control: mean over sessions >= 3 away of dir * (same-clock move over the same horizon)
function control(plan, i, dir, which) { const v = []; for (let j = LOOK; j < S.length; j++) { if (Math.abs(j - i) < 3 || S[j].roll || S[j].d > FIT_END || !plans[plan].valid(j)) continue; const m = moveFrom(plan, j, which); if (m != null) v.push(dir * m); } return mean(v); }
  return { plans, events, control, moveFrom, LOOK, PCT_ON, cSeries, cPct };
}
