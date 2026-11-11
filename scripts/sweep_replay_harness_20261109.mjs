// Replays the live merged sweep rule (evaluateSweepReversal, the real pure function) minute by minute over each session since 2026-10-01 with level_prices levels and compares the hits to the actual FAILED_SWEEP_REVERSAL rows. Built 2026-11-09 night to show the rule still fires ~2/day while the rows stopped after 10-23 (decision rth_shadow_families_silent_since_1023_20261109). Read-only.
import { query } from '../server/db.js';
import { evaluateSweepReversal, SWEEP_LEVEL_PRIORITY } from '../server/services/sweepReversalMerged.js';
import { adr20 } from './lib/levelContext.mjs';
const cut = (await query(`SELECT notes FROM performance_audit WHERE signal_type='SWEEP_DRIVE_CUTOFF' AND signal_name='M60_P80_POOLED' ORDER BY run_date DESC, id DESC LIMIT 1`)).rows[0]; const cutoff = (typeof cut.notes === 'string' ? JSON.parse(cut.notes) : cut.notes).cutoff;
const dates = (await query(`SELECT DISTINCT trade_date::text d FROM active_setups WHERE trade_date >= '2026-10-01' AND origin_status IN ('ACTIVE','SHADOW') ORDER BY 1`)).rows.map((r) => r.d).filter((d) => !['2026-11-07', '2026-11-08'].includes(d));
const actual = Object.fromEntries((await query(`SELECT trade_date::text d, count(*) n FROM active_setups WHERE setup_type ~ '^FAILED_SWEEP_REVERSAL' AND trade_date >= '2026-10-01' AND origin_status IN ('ACTIVE','SHADOW') GROUP BY 1`)).rows.map((r) => [r.d, Number(r.n)]));
let out = [];
for (const d of dates) {
  const atr = await adr20(d); if (!(atr > 0)) continue;
  const lv = Object.fromEntries((await query(`SELECT level_name, price::float p FROM level_prices WHERE trade_date = $1::date AND level_name = ANY($2)`, [d, SWEEP_LEVEL_PRIORITY])).rows.map((r) => [r.level_name, r.p]));
  const bars = (await query(`SELECT to_char(ts,'HH24:MI') t, (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts))::int m, high::float high, low::float low, close::float c FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1::date + interval '7 hours' AND ts < $1::date + interval '16 hours' ORDER BY ts`, [d])).rows;
  const blocked = new Set(), hits = [];
  for (let i = 0; i < bars.length; i++) {
    const etMin = bars[i].m + 1; if (etMin < 600 || etMin > 960) continue;
    const win = bars.filter((b) => b.m >= etMin - 110 && b.m < etMin); if (!win.length) continue;
    const ev = evaluateSweepReversal({ levels: lv, bars: win, price: win[win.length - 1].c, atr20: atr, etMin, blockedDirs: blocked, cutoff, requireTight: true });
    if (ev) { blocked.add(ev.dir); hits.push(`${ev.dir} ${ev.name} @${bars[i].t} drive ${ev.drive.toFixed(2)}`); }
  }
  out.push(`${d}  harness ${hits.length}  actual FSR rows ${actual[d] ?? 0}  ${hits.join(' | ')}`);
}
console.log(`cutoff ${cutoff.toFixed(3)}\n` + out.join('\n')); process.exit(0);
