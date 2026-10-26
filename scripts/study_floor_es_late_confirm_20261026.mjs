// Pre-registered in docs/FLOOR_ES_LATE_CONFIRM_PREREG_20261026.md + Amendment 1 (committed before this ran). NQ turns first (the parent fire bar), the queue waits for ES to confirm
// (ES close >= 0.25 x A15_ES above its own lowest low since the episode start), FIRE at ES's confirmation. L1 = ret60 from that entry minus the ret60 of NQ-conditioned controls
// entered at the same elapsed time after the NQ fire on events whose ES had NOT yet confirmed.
import fs from 'fs';
import { mean, loadBars, prep, neg, findEvents, loadLevels, FAMS, indexBars, fwdRet } from './lib/floorEngine.mjs';
import { MIN_DAYS, f3, qnt, blockBoot, dcount } from './lib/floorStats.mjs';
import { hashSeed, mulberry32 } from '../server/services/rigorDiagnostics.js';

const M = 0.25, W = 50;
async function main() {
  const dump = JSON.parse(fs.readFileSync(new URL('../scratch/floor_entry_events_20261026_m0.25.json', import.meta.url)));
  const NQ = indexBars(prep(await loadBars('price_bars_primary', `symbol='NQ'`, '2023-03-06', dump.endRow))), ES = indexBars(prep(await loadBars('price_bars_es_front', '1=1', '2023-03-06', dump.endRow)));
  const NQn = indexBars(neg(NQ)), ESn = indexBars(neg(ES)); NQn.A15 = NQ.A15; NQn.TD = NQ.TD; NQn.days = NQ.days; ESn.A15 = ES.A15; ESn.TD = ES.TD;
  const lv = await loadLevels(), emap = new Map(NQ.T.map((t, i) => [t, i])), out = { sides: {} };
  for (const side of ['long', 'mirror']) {
    const B = side === 'long' ? NQ : NQn, X = side === 'long' ? ES : ESn, mirror = side === 'mirror';
    const info = new Map(); for (const f of FAMS) for (const e of findEvents(B, f, lv(f, mirror), 1, 1)) info.set(`${f}|${e.i}|${e.arm}`, e);
    const rows = []; for (const e of dump[side]) { const ev = info.get(`${e.fam}|${e.i}|${e.arm}`), j = emap.get(e.fireTs); if (!ev || j === undefined || e.ret[60] == null) continue; rows.push({ ...e, ev, j, a: ev.a }); }
    // classify ES: first bar b >= episode start where ES has turned (and the episode is still alive)
    for (const e of rows) {
      const { ev } = e; let xMin = Infinity, cls = 'NEVER', b = null, alive = true;
      for (let k = ev.i; k < B.n - 1 && B.EM[k] - B.EM[ev.i] <= W; k++) {
        if (B.L[k] > ev.val + 2 * ev.a || B.C[k] <= ev.val - ev.a || B.H[k] >= ev.poc) { alive = false; if (k <= e.j) break; }   // episode ended/broke
        const xi = X.byEm.get(B.EM[k]); if (xi === undefined) continue; xMin = Math.min(xMin, X.L[xi]);
        if (X.C[xi] - xMin >= M * X.A15[X.TD[xi]]) { b = k; cls = k <= e.j ? 'SAME_OR_EARLIER' : (alive ? 'LATE' : 'NEVER'); break; }
      }
      e.cls = cls; e.b = b; e.dl = b != null ? B.EM[b] - B.EM[e.j] : null;
    }
    const cnt = (c) => rows.filter((e) => e.cls === c).length; const lateDl = rows.filter((e) => e.cls === 'LATE').map((e) => e.dl);
    console.log(`\n##### ${side.toUpperCase()}: fired ${rows.length} events: SAME_OR_EARLIER ${cnt('SAME_OR_EARLIER')}, LATE ${cnt('LATE')}, NEVER inside ${W} min ${cnt('NEVER')}; LATE wait (minutes after the NQ fire, censored at the window, NEVER excluded): quartiles ${[0.25, 0.5, 0.75].map((q) => qnt(lateDl, q)).join(' / ')}`);
    const days = [...new Set(rows.map((e) => e.day))].sort(), cut = days[Math.floor(days.length * 0.6) - 1], half = (e) => (e.day <= cut ? 0 : 1);
    // LATE entries and their NQ-conditioned (ES not yet confirmed) controls at the same elapsed time
    const rng = mulberry32(hashSeed('late' + side)), late = rows.filter((e) => e.cls === 'LATE'), res = []; let dropped = 0;
    const byGrp = new Map(); for (const e of rows) { const k = `${e.fam}|${e.arm}|${e.day.slice(0, 4)}|${half(e)}`; (byGrp.get(k) || byGrp.set(k, []).get(k)).push(e); }
    for (const A of late) {
      const i0 = A.b + 1, retA = fwdRet(B, i0, 60, A.a); if (retA == null) { dropped++; continue; }
      const pool = (byGrp.get(`${A.fam}|${A.arm}|${A.day.slice(0, 4)}|${half(A)}`) || []).filter((C) => C.seq !== A.seq && (C.b == null || C.b > C.j + 0 && B.EM[C.b] - B.EM[C.j] > A.dl || C.cls === 'NEVER'));
      const ctl = []; for (let t = 0; t < 40 && ctl.length < 10 && pool.length; t++) {
        const C = pool[Math.floor(rng() * pool.length)], jm = B.byEm.get(B.EM[C.j] + A.dl); if (jm === undefined || jm + 1 >= B.n) continue;
        let ok = true; for (let k = C.ev.i; k <= jm; k++) if (B.L[k] > C.ev.val + 2 * C.ev.a || B.C[k] <= C.ev.val - C.ev.a || B.H[k] >= C.ev.poc) { ok = false; break; }
        if (!ok || Math.abs((B.EM[jm + 1] % 1440) - (B.EM[i0] % 1440)) > 30) continue;
        const r = fwdRet(B, jm + 1, 60, C.a); if (r != null) ctl.push(r);
      }
      if (!ctl.length) { dropped++; continue; }
      res.push({ day: A.day, seq: A.seq, half: half(A), ex: retA - mean(ctl), retA, ctl: mean(ctl), fire: A.ret[60], nctl: ctl.length });
    }
    const st = (z) => mean(z.map((x) => x.ex)), d = dcount(res), o = { n: res.length, days: d, dropped };
    console.log(`  LATE events ${late.length}; usable with a matched NQ-conditioned control ${res.length} on ${d} days (dropped ${dropped}); mean control draws ${f3(mean(res.map((x) => x.nctl)))}`);
    if (res.length >= 20 && d >= MIN_DAYS) {
      o.est = st(res); o.seq = blockBoot(res, st, (x) => x.seq, side + 'L1seq'); o.day = blockBoot(res, st, (x) => x.day, side + 'L1day'); o.h = [st(res.filter((x) => x.half === 0)), st(res.filter((x) => x.half === 1))]; o.hn = [res.filter((x) => x.half === 0).length, res.filter((x) => x.half === 1).length];
      o.halfWidth = (o.seq.hi - o.seq.lo) / 2; o.shown = o.seq.lo > 0 && o.day.lo > 0 && o.h.every((x) => x > 0);
      console.log(`  L1 (ES-confirm entry minus matched NQ-conditioned control, ret60 A15): ${f3(o.est)} seqCI [${f3(o.seq.lo)},${f3(o.seq.hi)}] dayCI [${f3(o.day.lo)},${f3(o.day.hi)}] halves ${o.h.map(f3)} (n ${o.hn}) smallest detectable about +/-${o.halfWidth.toFixed(3)} A15 => ${o.shown ? 'SHOWN' : 'NOT SHOWN (unresolved below the resolution bar)'}`);
    } else { o.under = true; console.log('  L1 UNDERPOWERED'); }
    o.desc = { rawPairedVsNQfire: mean(res.map((x) => x.retA - x.fire)), controlMinusNQfire: mean(res.map((x) => x.ctl - x.fire)), lateRetFromES: mean(res.map((x) => x.retA)), controlRet: mean(res.map((x) => x.ctl)) };
    console.log(`  [descriptive] mean ret60: ES-confirm entry ${f3(o.desc.lateRetFromES)} | matched NQ-conditioned control ${f3(o.desc.controlRet)} | same events from the NQ fire bar ${f3(mean(res.map((x) => x.fire)))}`);
    for (const c of ['SAME_OR_EARLIER', 'LATE', 'NEVER']) { const r = rows.filter((e) => e.cls === c); console.log(`  [descriptive, survivorship-confounded, not a result] class ${c}: n=${r.length}/${dcount(r)}d mean ret60 from the NQ fire ${f3(mean(r.map((e) => e.ret[60])))}`); }
    out.sides[side] = { counts: { fired: rows.length, same: cnt('SAME_OR_EARLIER'), late: cnt('LATE'), never: cnt('NEVER') }, L1: o };
  }
  const L = out.sides.long.L1, Mi = out.sides.mirror.L1; console.log(`\nVERDICT long ${L.shown ? 'SHOWN' : L.under ? 'UNDERPOWERED' : 'NOT SHOWN'}; mirror ${Mi.shown ? 'SHOWN' : Mi.under ? 'UNDERPOWERED' : 'NOT SHOWN'}${L.shown && !Mi.shown ? ' (long SHOWN but the mirror does not agree: not forward-worthy on its own)' : ''}`);
  fs.writeFileSync('scratch/floor_es_late_confirm_20261026.json', JSON.stringify(out, null, 1));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
