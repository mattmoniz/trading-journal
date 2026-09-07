// Does va_overlap_streak (extended value-area overlap = entrenched balance, confirmed 2026-09-06
// bar-level: predicts a real lift toward TREND days) actually change real setup performance?
// Tests the full real roster (all bet_classes with adequate N), not just fades, since the
// market-level hypothesis implies fades should do WORSE and continuation-style setups should
// do BETTER on a LONG streak. Reuses the exact streak-computation logic from
// scripts/test_va_overlap_streak_breakout.mjs verbatim.
import { query } from '../server/db.js';
import { computeProfile } from '../server/services/developingValueService.js';
import { getBetClass } from '../server/config/setupTypes.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import { computeReplication } from '../server/services/rigorDiagnostics.js';

const RTH_START = 570, RTH_END = 960, TRAILING_WINDOW = 60;
function vaOverlap(a, b) { return a.val <= b.vah && a.vah >= b.val; }

async function run() {
  const barsQ = await query(`
    SELECT ts::date::text as d, high::float as high, low::float as low, volume::float as volume
    FROM price_bars_primary
    WHERE symbol='NQ' AND (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts)) BETWEEN ${RTH_START} AND ${RTH_END - 1}
    ORDER BY ts ASC
  `);
  const barsByDay = new Map();
  for (const b of barsQ.rows) { if (!barsByDay.has(b.d)) barsByDay.set(b.d, []); barsByDay.get(b.d).push(b); }
  const tradingDays = [...barsByDay.keys()].sort();

  const profileByDay = new Map();
  for (const d of tradingDays) {
    const bars = barsByDay.get(d);
    if (bars.length < 10) continue;
    const p = computeProfile(bars);
    if (p) profileByDay.set(d, p);
  }

  const streakByDay = new Map();
  for (let idx = 0; idx < tradingDays.length; idx++) {
    const d = tradingDays[idx];
    let streak = 0;
    let prev = idx - 1 >= 0 ? profileByDay.get(tradingDays[idx - 1]) : null;
    if (prev) {
      for (let back = 2; back <= TRAILING_WINDOW + 1 && idx - back >= 0; back++) {
        const cur = profileByDay.get(tradingDays[idx - back]);
        if (!cur || !vaOverlap(prev, cur)) break;
        streak++; prev = cur;
      }
    }
    streakByDay.set(d, streak);
  }
  const bucketOf = (d) => {
    const s = streakByDay.get(d);
    if (s == null) return null;
    if (s === 0) return 'NONE';
    if (s <= 2) return 'SHORT';
    return 'LONG';
  };

  const { rows: setups } = await query(`
    SELECT trade_date::text as trade_date, setup_type, actual_pnl, origin_status
    FROM active_setups
    WHERE origin_status IN ('ACTIVE','SHADOW') AND actual_pnl IS NOT NULL
  `);
  for (const s of setups) s.actual_pnl = parseFloat(s.actual_pnl);

  const getStats = (arr) => {
    if (arr.length === 0) return { n: 0, wr: 0, ev: 0 };
    const n = arr.length;
    const wins = arr.filter(x => x.actual_pnl > 0).length;
    const totalPnl = arr.reduce((s, x) => s + x.actual_pnl, 0);
    return { n, wr: +(wins / n * 100).toFixed(1), ev: +(totalPnl * LIVE_INSTRUMENT.dollarsPerPoint / n).toFixed(2) };
  };

  function testRoster(label, predicate) {
    const roster = setups.filter(predicate);
    console.log(`\n=== ${label}: real N=${roster.length} ===`);
    if (roster.length === 0) { console.log('No real data.'); return; }

    const buckets = { NONE: [], SHORT: [], LONG: [] };
    for (const s of roster) {
      const b = bucketOf(s.trade_date);
      if (b) buckets[b].push(s);
    }
    for (const b of ['NONE', 'SHORT', 'LONG']) {
      const st = getStats(buckets[b]);
      console.log(`  ${b.padEnd(5)}: N=${st.n.toString().padStart(4)}  WR=${st.wr}%  EV=$${st.ev}`);
    }

    // NONE vs LONG direct comparison + per-setup-type replication check (N-floored, aggImpact-ranked).
    const types = [...new Set(roster.map(r => r.setup_type))];
    const metricFn = (type) => {
      const subset = roster.filter(r => r.setup_type === type);
      const none = [], long = [];
      for (const s of subset) {
        const b = bucketOf(s.trade_date);
        if (b === 'NONE') none.push(s); else if (b === 'LONG') long.push(s);
      }
      if (none.length < 10 || long.length < 10) return null;
      const noneStats = getStats(none), longStats = getStats(long);
      const diff = longStats.ev - noneStats.ev;
      return { n: none.length + long.length, value: diff, aggImpact: (none.length + long.length) * diff, noneN: none.length, longN: long.length };
    };
    const scored = types.map(t => ({ type: t, metric: metricFn(t) })).filter(x => x.metric).sort((a, b) => b.metric.aggImpact - a.metric.aggImpact);
    console.log(`  Setup types clearing N>=10-per-bucket floor (NONE vs LONG): ${scored.length}`);
    if (scored.length >= 3) {
      const selectedIds = scored.slice(0, Math.max(1, Math.ceil(scored.length * 0.2))).map(x => x.type);
      const rep = computeReplication(types, { idFn: u => u, metricFn, selectedIds });
      console.log(`  Top contributors (by aggImpact): ${selectedIds.join(', ')}`);
      console.log(`  computeReplication (LONG favors these vs rest):`, JSON.stringify(rep));
    } else if (scored.length > 0) {
      scored.forEach(x => console.log(`    ${x.type}: NONE_N=${x.metric.noneN} LONG_N=${x.metric.longN} diff=$${x.metric.value.toFixed(2)}`));
    }
  }

  testRoster('ALL real setups (every bet_class pooled)', () => true);
  testRoster('VALUE_FADE (mean-reversion roster)', s => getBetClass(s.setup_type) === 'VALUE_FADE');
  testRoster('FAILED_SWEEP_REVERSAL (breakout/continuation roster)', s => getBetClass(s.setup_type) === 'FAILED_SWEEP_REVERSAL');
  testRoster('CONTINUATION_LEGACY', s => getBetClass(s.setup_type) === 'CONTINUATION_LEGACY');
  testRoster('GLOBEX_LEVEL', s => getBetClass(s.setup_type) === 'GLOBEX_LEVEL');

  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
