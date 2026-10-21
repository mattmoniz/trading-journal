// Runs docs/ROSTER_SELECTION_AND_ML_SCORECARD_PREREG_20261021.md Part 1 (committed e6c03d5 before any run). Research only; nothing live reads it.
import { query } from '../server/db.js';
import { collapseClusterSiblings, dayBlockedBootstrapCI, mulberry32, hashSeed } from '../server/services/rigorDiagnostics.js';
const LIVE_FROM = '2026-07-09', MIN_N = 20, MIN_DAYS = 10, FIRST_EVAL_WEEK = 4, DRAWS = 2000;
const TRACK = (u) => u === 'IB_HIGH_FADE_SHORT' || /^OR(5|10|15|30)_MID_FADE_/.test(u) || u.startsWith('SWEEP_ONL_') || u.startsWith('SWEEP_ONH_');
const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN, f1 = (x) => Number.isFinite(x) ? (x >= 0 ? '+' : '') + x.toFixed(1) : 'n/a';
const SQL = (where) => `SELECT id, setup_type, trade_date::text d, fired_at::text f, cluster_touch_id, actual_pnl::float p, t1_label FROM active_setups WHERE actual_pnl IS NOT NULL AND resolution IS DISTINCT FROM 'NOT_FILLED' AND ib_window_stale_basis IS NOT TRUE AND stale_entry_price_basis IS NOT TRUE AND late_fill_past_expiry_basis IS NOT TRUE AND bad_bars_basis IS NOT TRUE AND NOT (fired_at::time >= '16:00' AND fired_at::time < '18:00') AND ${where}`;
const norm = { PDL: 'PD_LOW', PDH: 'PD_HIGH' };
const unitsOf = (r) => { const u = [r.setup_type]; if ((r.setup_type.startsWith('STOP_SWEEP') || r.setup_type.startsWith('FAILED_SWEEP_REVERSAL')) && r.f.slice(11, 16) < '16:00' && r.t1_label) { const lv = r.t1_label.split(' ')[0]; u.push(`SWEEP_${norm[lv] || lv}_${r.setup_type.endsWith('LONG') ? 'LONG' : 'SHORT'}`); } return u; };
const monday = (d) => { const t = new Date(d + 'T00:00:00Z'); const k = (t.getUTCDay() + 6) % 7; t.setUTCDate(t.getUTCDate() - k); return t.toISOString().slice(0, 10); };
const live = (await query(SQL(`origin_status IN ('ACTIVE','SHADOW') AND trade_date >= '${LIVE_FROM}'`))).rows, back = (await query(SQL(`origin_status = 'BACKFILL' AND trade_date < '${LIVE_FROM}'`))).rows;
const weeks = [...new Set(live.map((r) => monday(r.d)))].sort(); console.log(`live rows ${live.length} (${new Set(live.map((r) => r.d)).size} days), backfill rows ${back.length}; weeks ${weeks.length}: ${weeks[0]}..${weeks[weeks.length - 1]}; evaluation weeks start ${weeks[FIRST_EVAL_WEEK]}`);
const evOf = (rows) => collapseClusterSiblings(rows.map((r) => ({ date: r.d, pnl: r.p, cluster_touch_id: r.cluster_touch_id })));
function run(includeBackfill, label, verbose) {
  const perWeek = [];
  for (let wi = FIRST_EVAL_WEEK; wi < weeks.length; wi++) { const W = weeks[wi], W2 = weeks[wi + 1] || '9999-12-31';
    const hist = live.filter((r) => r.d < W).concat(includeBackfill ? back : []), fwd = live.filter((r) => r.d >= W && r.d < W2); if (!fwd.length) continue;
    const hu = new Map(); for (const r of hist) for (const u of unitsOf(r)) (hu.get(u) || hu.set(u, []).get(u)).push(r);
    const fu = new Map(); for (const r of fwd) for (const u of unitsOf(r)) (fu.get(u) || fu.set(u, []).get(u)).push(r);
    const eligible = [], selected = [], stats = new Map();
    for (const [u, rows] of hu) { const ev = evOf(rows), days = new Set(ev.map((e) => e.date)).size; if (ev.length < MIN_N || days < MIN_DAYS) continue; eligible.push(u); const ci = dayBlockedBootstrapCI(ev, 'wf' + W + u + includeBackfill), sorted = [...ev].sort((a, b) => a.date < b.date ? -1 : 1), h = Math.floor(sorted.length / 2), m1 = mean(sorted.slice(0, h).map((e) => e.pnl)), m2 = mean(sorted.slice(h).map((e) => e.pnl)), m = mean(ev.map((e) => e.pnl));
      stats.set(u, { n: ev.length, days, m, lo: ci.lo }); if (ci.lo > 0 && m1 > 0 && m2 > 0) selected.push(u); }
    perWeek.push({ W, hu, fu, fwd, eligible, selected, stats }); }
  const pool = (units, fu) => { const seen = new Set(), rows = []; for (const u of units) for (const r of fu.get(u) || []) if (!seen.has(r.id)) { seen.add(r.id); rows.push(r); } return rows; };
  let selRows = [], allRows = []; for (const w of perWeek) { selRows = selRows.concat(pool(w.selected, w.fu)); allRows = allRows.concat(w.fwd); }
  const selEv = evOf(selRows), allEv = evOf(allRows); const days = new Set(allEv.map((e) => e.date)).size;
  console.log(`\n######## ${label}: evaluation weeks ${perWeek.length}, forward days ${days}`);
  if (verbose) for (const w of perWeek) { console.log(`week ${w.W}: eligible ${w.eligible.length}, selected ${w.selected.length}: ${w.selected.map((u) => `${u}(${f1(w.stats.get(u).m)})`).join(', ') || '-'} | forward events of the selected set ${evOf(pool(w.selected, w.fu)).length}`);
    for (const u of [...new Set([...w.hu.keys(), ...w.fu.keys()])].filter(TRACK).sort()) { const s = w.stats.get(u), fr = evOf(w.fu.get(u) || []); if (s || fr.length) console.log(`     [tracked] ${u.padEnd(26)} history ${s ? `n ${s.n}/${s.days}d mean ${f1(s.m)} CI-lo ${f1(s.lo)}` : 'below the floor'} | forward n ${fr.length} mean ${fr.length ? f1(mean(fr.map((e) => e.pnl))) : 'n/a'}`); } }
  if (!selEv.length) { console.log('no unit was ever selected: nothing to evaluate'); return { help: false, label }; }
  const cS = dayBlockedBootstrapCI(selEv, 'sel' + label), cA = dayBlockedBootstrapCI(allEv, 'all' + label);
  const byDay = (ev) => { const m = new Map(); for (const e of ev) (m.get(e.date) || m.set(e.date, []).get(e.date)).push(e.pnl); return m; };
  const dS = byDay(selEv), dA = byDay(allEv), dayList = [...dA.keys()], rng = mulberry32(hashSeed('diff' + label)), diffs = [];
  for (let b = 0; b < 2000; b++) { let ss = 0, ns = 0, sa = 0, na = 0; for (let k = 0; k < dayList.length; k++) { const d = dayList[Math.floor(rng() * dayList.length)]; for (const x of dS.get(d) || []) { ss += x; ns++; } for (const x of dA.get(d) || []) { sa += x; na++; } } if (ns && na) diffs.push(ss / ns - sa / na); } diffs.sort((a, b) => a - b);
  const rp = mulberry32(hashSeed('plc' + label)), drawMeans = []; for (let b = 0; b < DRAWS; b++) { let s = 0, n = 0; for (const w of perWeek) { const k = w.selected.length; if (!k) continue; const pool0 = [...w.eligible]; const pick = []; for (let j = 0; j < k && pool0.length; j++) pick.push(pool0.splice(Math.floor(rp() * pool0.length), 1)[0]); const rows = pool(pick, w.fu); for (const r of rows) { s += r.p; n++; } } if (n) drawMeans.push(s / n); } drawMeans.sort((a, b) => a - b);
  const selMean = mean(selEv.map((e) => e.pnl)), rank = drawMeans.filter((x) => x < selMean).length / drawMeans.length, selDays = new Set(selEv.map((e) => e.date)).size;
  console.log(`selected set forward: ${selEv.length} events on ${selDays} days (${(selEv.length / selDays).toFixed(1)}/day), mean ${f1(selMean)} CI95 [${f1(cS.lo)},${f1(cS.hi)}], total ${f1(selEv.reduce((s, e) => s + e.pnl, 0))}`);
  console.log(`take-all forward: ${allEv.length} events, mean ${f1(mean(allEv.map((e) => e.pnl)))} CI95 [${f1(cA.lo)},${f1(cA.hi)}]; selected minus take-all CI95 [${f1(diffs[50])},${f1(diffs[1949])}] (point ${f1(selMean - mean(allEv.map((e) => e.pnl)))})`);
  console.log(`placebo (random sets of the same size from eligible units, ${drawMeans.length} draws): median ${f1(drawMeans[drawMeans.length >> 1])}, 95th pct ${f1(drawMeans[Math.floor(0.95 * drawMeans.length)])}; real set ranks above ${(rank * 100).toFixed(0)}% of draws`);
  const help = cS.lo > 0 && diffs[50] > 0 && rank >= 0.95 && selEv.length >= 60 && selDays >= 20; console.log(`VERDICT: ${help ? 'SELECTION HELPS' : (selEv.length < 60 || selDays < 20 ? 'UNDERPOWERED (fewer than 60 forward events or 20 days) - not a verdict' : 'NOT SHOWN')}`); return { help, label }; }
run(false, 'PRIMARY arm: history = live rows only', true);
run(true, 'SECONDARY arm (no verdict): history = backfill + live rows', false);
process.exit(0);
