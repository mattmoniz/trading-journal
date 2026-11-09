// Session x time-block PROMOTION model (partial pooling), SHADOW only. Pre-registration: docs/BUCKET_ROSTER_PREREG_20261108.md. Pure functions (no database, no clock): the walk-forward script and the nightly shadow job feed it rows.
// Idea (user 2026-11-08, Opus review item 8): a setup may be good in one part of the day and bad in another; estimate each (setup_type, bucket) cell but SHRINK it toward what the setup does overall and what the bucket does overall,
// with the shrinkage estimated from the data (DerSimonian-Laird variance components), so a cell with 2 days of its own data inherits the pooled evidence instead of being decided on 2 days.
export const Z80 = 0.8416212335729143;                       // one-sided 80 percent bound, fixed in the pre-registration, not tuned
export const BUCKETS = [
  { id: 'RTH_OPEN', from: 575, to: 630 }, { id: 'RTH_MID', from: 630, to: 840 }, { id: 'RTH_LATE', from: 840, to: 960 },
  { id: 'GLOBEX_EVE', from: 1110, to: 1440 }, { id: 'GLOBEX_NIGHT', from: 0, to: 570 },
];
/** minute of the ET clock day from a naive timestamp text 'YYYY-MM-DD HH:MM:SS...' (never parsed as a Date, cv-074) */
export function minuteOfText(ts) { const m = /(\d{2}):(\d{2})/.exec(String(ts).slice(11)); return m ? Number(m[1]) * 60 + Number(m[2]) : null; }
/** bucket id for a minute of day, or null inside a hard-excluded zone (09:30-09:35, 16:00-18:30) */
export function bucketOfMinute(min) { if (min == null) return null; for (const b of BUCKETS) if (min >= b.from && min < b.to) return b.id; return null; }
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const sum = (a) => a.reduce((s, x) => s + x, 0);

/** rows: [{type, date, minute, pnl, cluster_touch_id}] -> cell-day observations [{t, k, d, y}] (cluster-collapsed per type, then the mean per type/bucket/day) */
export function cellDayObservations(rows) {
  const g = new Map();
  for (const r of rows) {
    const k = bucketOfMinute(r.minute); if (!k) continue;
    const key = r.cluster_touch_id == null ? null : `${r.type}|${r.cluster_touch_id}`;
    if (key == null) { g.set(`S${g.size}|${r.type}`, { t: r.type, k, d: r.date, ys: [r.pnl] }); continue; }
    if (!g.has(key)) g.set(key, { t: r.type, k, d: r.date, ys: [] }); g.get(key).ys.push(r.pnl);
  }
  const cd = new Map();
  for (const e of g.values()) { const key = `${e.t}|${e.k}|${e.d}`; if (!cd.has(key)) cd.set(key, { t: e.t, k: e.k, d: e.d, ys: [] }); cd.get(key).ys.push(mean(e.ys)); }
  return [...cd.values()].map((x) => ({ t: x.t, k: x.k, d: x.d, y: mean(x.ys) }));
}

// DerSimonian-Laird between-group variance for group means ybar_g with weights w_g = n_g / s2 around prior means m_g.
function dlTau2(groups) {                                    // groups: [{n, ybar, m}] ; s2 passed in via w
  const K = groups.length; if (K < 2) return 0;
  const W = sum(groups.map((g) => g.w)), Q = sum(groups.map((g) => g.w * (g.ybar - g.m) ** 2)), den = W - sum(groups.map((g) => g.w * g.w)) / W;
  return den > 0 ? Math.max(0, (Q - (K - 1)) / den) : 0;
}
function shrink(groups, mu, s2) {                            // groups: Map id -> {n, ybar}; returns Map id -> {est, var}
  const arr = [...groups].map(([id, g]) => ({ id, n: g.n, ybar: g.ybar, m: mu, w: g.n / s2 })); const tau2 = dlTau2(arr), out = new Map();
  for (const g of arr) { const B = tau2 > 0 ? tau2 / (tau2 + s2 / g.n) : 0; out.set(g.id, { est: mu + B * (g.ybar - mu), var: B * s2 / g.n, n: g.n, ybar: g.ybar }); }
  return { out, tau2 };
}

/** fit the two-stage empirical-Bayes model on cell-day observations; returns a model object usable by cellDecision() */
export function fitBucketModel(obs) {
  if (obs.length < 3) return { empty: true, mu: 0, obsN: obs.length };
  const mu = mean(obs.map((o) => o.y));
  const byCell = new Map(); for (const o of obs) { const key = `${o.t}|${o.k}`; if (!byCell.has(key)) byCell.set(key, []); byCell.get(key).push(o); }
  let ss = 0, df = 0; for (const c of byCell.values()) if (c.length > 1) { const m = mean(c.map((o) => o.y)); ss += sum(c.map((o) => (o.y - m) ** 2)); df += c.length - 1; }
  let s2 = df > 0 ? ss / df : 0; const overall = sum(obs.map((o) => (o.y - mu) ** 2)) / Math.max(1, obs.length - 1); if (!(s2 > 0)) s2 = overall; if (!(s2 > 0)) s2 = 1;
  const grp = (keyFn) => { const m = new Map(); for (const o of obs) { const k = keyFn(o); if (!m.has(k)) m.set(k, { days: new Set(), ys: [] }); m.get(k).days.add(o.d); m.get(k).ys.push(o.y); } return new Map([...m].map(([k, v]) => [k, { n: v.days.size, ybar: mean(v.ys) }])); };
  const typeS = shrink(grp((o) => o.t), mu, s2), bucketS = shrink(grp((o) => o.k), mu, s2);                  // stage A: effective n = distinct days (cell-days within a day are correlated)
  const cells = new Map();
  for (const [key, c] of byCell) { const [t, k] = key.split('|'); const ty = typeS.out.get(t), bk = bucketS.out.get(k); cells.set(key, { t, k, n: new Set(c.map((o) => o.d)).size, ybar: mean(c.map((o) => o.y)), m: ty.est + bk.est - mu, vm: ty.var + bk.var }); }
  const arr = [...cells.values()].map((c) => ({ ...c, w: c.n / s2 })); const tauC2 = dlTau2(arr);
  for (const c of cells.values()) { const B = tauC2 > 0 ? tauC2 / (tauC2 + s2 / c.n) : 0; c.theta = c.m + B * (c.ybar - c.m); c.sd = Math.sqrt(B * s2 / c.n + c.vm); c.lb = c.theta - Z80 * c.sd; }
  return { empty: false, mu, s2, tauT2: typeS.tau2, tauB2: bucketS.tau2, tauC2, typeS: typeS.out, bucketS: bucketS.out, cells, obsN: obs.length };
}

/** decision for ANY (type, bucket). A cell with NO data of its own is never promoted (pre-registration amendment A1: an untested part of the day is not assumed to behave like the tested ones, hr-002 / hr-039); its inherited estimate is still returned for display. */
export function cellDecision(model, type, bucket, z = Z80) {
  if (!model || model.empty) return { pass: false, reason: 'no_model' };
  const c = model.cells.get(`${type}|${bucket}`); if (c) return { pass: c.theta - z * c.sd > 0, theta: c.theta, sd: c.sd, n: c.n, own: true };
  const ty = model.typeS.get(type), bk = model.bucketS.get(bucket); if (!ty || !bk) return { pass: false, reason: 'unseen_type_or_bucket', theta: model.mu, sd: Infinity, n: 0, own: false };
  const theta = ty.est + bk.est - model.mu, sd = Math.sqrt(model.tauC2 + ty.var + bk.var); return { pass: false, reason: 'no_own_data', theta, sd, n: 0, own: false, wouldPass: theta - z * sd > 0 };
}
