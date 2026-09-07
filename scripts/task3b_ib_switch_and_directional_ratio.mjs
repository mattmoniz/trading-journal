// Extension of scripts/task3_ib_boundary_switch_count.mjs: adds the up/down event-count
// RATIO as a second dimension alongside switch-count, per the user's own refinement (plain
// switch-count treats "9 up-events, 1 down-event" identically to "1 up, 1 down" -- both are
// "1 switch" -- but these are structurally very different formations). Tests both the
// original VALUE_FADE roster (baseline, matches the already-run task3 script) AND the newer
// FAILED_SWEEP_REVERSAL breakout/continuation-style bet class (real N=110 now, was ~0 when
// last scoped) against BOTH metrics, real ACTIVE+SHADOW trades only, full history.
import { query } from '../server/db.js';
import { getBetClass } from '../server/config/setupTypes.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import { computeReplication } from '../server/services/rigorDiagnostics.js';

async function run() {
  const barsRes = await query(`
    SELECT ts::date::text as trade_date,
      (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts))::int as et_min,
      high, low
    FROM price_bars_primary
    WHERE symbol = 'NQ' AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) BETWEEN 570 AND 629
    ORDER BY ts ASC
  `);

  const barsByDate = {};
  for (const b of barsRes.rows) {
    if (!barsByDate[b.trade_date]) barsByDate[b.trade_date] = [];
    barsByDate[b.trade_date].push({ h: parseFloat(b.high), l: parseFloat(b.low) });
  }

  const dayStats = {};
  for (const d of Object.keys(barsByDate)) {
    const bars = barsByDate[d];
    if (bars.length < 50) continue;

    let runningHigh = bars[0].h, runningLow = bars[0].l;
    let lastEventDir = null;
    let switchCount = 0, upEvents = 0, downEvents = 0;

    for (let i = 1; i < bars.length; i++) {
      const b = bars[i];
      let newHigh = false, newLow = false;
      if (b.h > runningHigh) { runningHigh = b.h; newHigh = true; }
      if (b.l < runningLow) { runningLow = b.l; newLow = true; }

      if (newHigh && newLow) {
        // Bar expanded both sides -- count as one event each way, no switch attributed
        // (ambiguous which came first within the bar).
        upEvents++; downEvents++;
      } else if (newHigh) {
        if (lastEventDir === 'DOWN') switchCount++;
        lastEventDir = 'UP'; upEvents++;
      } else if (newLow) {
        if (lastEventDir === 'UP') switchCount++;
        lastEventDir = 'DOWN'; downEvents++;
      }
    }

    const totalEvents = upEvents + downEvents;
    // Directional ratio: 0.5 = perfectly balanced, 1.0 or 0.0 = fully one-sided.
    const dirRatio = totalEvents > 0 ? Math.max(upEvents, downEvents) / totalEvents : 0.5;

    dayStats[d] = { switches: switchCount, dirRatio, range: runningHigh - runningLow, upEvents, downEvents };
  }

  const validDates = Object.keys(dayStats).sort();
  console.log(`Total days with valid IB-window coverage: ${validDates.length}`);

  // Rolling 180-day percentiles for range/switches/dirRatio -- no lookahead.
  const dayMetrics = {};
  for (let i = 0; i < validDates.length; i++) {
    const d = validDates[i];
    const stat = dayStats[d];
    const start = Math.max(0, i - 180);
    const window = validDates.slice(start, i).map(dt => dayStats[dt]);
    if (window.length === 0) continue;

    const pct = (arr, val) => arr.filter(x => x <= val).length / arr.length;
    const ranges = window.map(x => x.range);
    const switches = window.map(x => x.switches);
    const dirRatios = window.map(x => x.dirRatio);

    dayMetrics[d] = {
      rangePct: pct(ranges, stat.range),
      switchPct: pct(switches, stat.switches),
      dirRatioPct: pct(dirRatios, stat.dirRatio),
      switches: stat.switches,
      dirRatio: stat.dirRatio,
    };
  }

  // === Test 1: market behavior -- does the 2D signature separate real day-types
  // among WIDE-IB days better than switch-count alone did? ===
  const dtRows = await query(`SELECT trade_date::text as trade_date, day_type FROM acd_daily_log WHERE day_type IN ('TREND','TURBULENT','BALANCE')`);
  const realDayTypes = {};
  for (const r of dtRows.rows) realDayTypes[r.trade_date] = r.day_type;

  const buckets = { cleanLeg: [], churnLopsided: [], balanced: [] };
  // cleanLeg = low switches + lopsided ratio (a real drive)
  // churnLopsided = high switches + lopsided ratio (grinding trend)
  // balanced = high switches + balanced ratio (genuine two-sided) OR low switches + balanced ratio (thrust-then-reversal)
  for (const d of Object.keys(dayMetrics)) {
    const dm = dayMetrics[d];
    const rt = realDayTypes[d];
    if (!rt || dm.rangePct < 0.666) continue; // wide-IB days only, matching the original test's scope
    const lowSwitch = dm.switchPct <= 0.333;
    const lopsided = dm.dirRatioPct >= 0.666; // top-tercile one-sidedness
    if (lowSwitch && lopsided) buckets.cleanLeg.push(rt);
    else if (!lowSwitch && lopsided) buckets.churnLopsided.push(rt);
    else buckets.balanced.push(rt);
  }

  const counts = (arr) => ({
    TREND: arr.filter(x => x === 'TREND').length,
    TURBULENT: arr.filter(x => x === 'TURBULENT').length,
    BALANCE: arr.filter(x => x === 'BALANCE').length,
    TOTAL: arr.length,
  });

  console.log('\n--- Test 1: Wide-IB days, split by 2D signature (switch-count x directional ratio) ---');
  console.log('Clean Leg (low switch + lopsided):', JSON.stringify(counts(buckets.cleanLeg)));
  console.log('Churn/Grind (high switch + lopsided):', JSON.stringify(counts(buckets.churnLopsided)));
  console.log('Balanced (everything else -- high-switch-balanced OR low-switch-balanced/thrust-reversal):', JSON.stringify(counts(buckets.balanced)));

  // === Test 2: real setup performance, VALUE_FADE (baseline) + FAILED_SWEEP_REVERSAL (new) ===
  const { rows: setups } = await query(`
    SELECT trade_date::text as trade_date, setup_type, actual_pnl
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
    console.log(`\n--- Test 2 (${label}): real N=${roster.length} ---`);
    if (roster.length === 0) { console.log('No real data yet.'); return; }

    const cleanLeg = [], churnLopsided = [], balancedBucket = [];
    for (const s of roster) {
      const dm = dayMetrics[s.trade_date];
      if (!dm) continue;
      const lowSwitch = dm.switchPct <= 0.333;
      const lopsided = dm.dirRatioPct >= 0.666;
      if (lowSwitch && lopsided) cleanLeg.push(s);
      else if (!lowSwitch && lopsided) churnLopsided.push(s);
      else balancedBucket.push(s);
    }
    const cl = getStats(cleanLeg), ch = getStats(churnLopsided), bl = getStats(balancedBucket);
    console.log(`Clean Leg    : N=${cl.n}, WR=${cl.wr}%, EV=$${cl.ev}`);
    console.log(`Churn/Grind  : N=${ch.n}, WR=${ch.wr}%, EV=$${ch.ev}`);
    console.log(`Balanced/Rev : N=${bl.n}, WR=${bl.wr}%, EV=$${bl.ev}`);

    // Replication check: Clean Leg vs everything else, real N-floor on per-type selection.
    const types = [...new Set(roster.map(r => r.setup_type))];
    const metricFn = (type) => {
      const subset = roster.filter(r => r.setup_type === type);
      const cl2 = [], other = [];
      for (const s of subset) {
        const dm = dayMetrics[s.trade_date];
        if (!dm) continue;
        const lowSwitch = dm.switchPct <= 0.333, lopsided = dm.dirRatioPct >= 0.666;
        if (lowSwitch && lopsided) cl2.push(s); else other.push(s);
      }
      if (cl2.length < 10 || other.length < 10) return null;
      const clStats = getStats(cl2), othStats = getStats(other);
      return { n: cl2.length + other.length, value: clStats.ev - othStats.ev };
    };
    const scored = types.map(t => ({ type: t, metric: metricFn(t) })).filter(x => x.metric).sort((a, b) => b.metric.value - a.metric.value);
    if (scored.length >= 3) {
      const selectedIds = scored.slice(0, Math.max(1, Math.floor(scored.length * 0.2))).map(x => x.type);
      const rep = computeReplication(types, { idFn: u => u, metricFn, selectedIds });
      console.log(`computeReplication (top ${selectedIds.length} by Clean-Leg EV advantage, N-floored):`, JSON.stringify(rep));
    } else {
      console.log(`Only ${scored.length} setup_types cleared the N>=10-per-bucket floor -- too few for a replication check.`);
    }
  }

  testRoster('VALUE_FADE (baseline)', s => getBetClass(s.setup_type) === 'VALUE_FADE');
  testRoster('FAILED_SWEEP_REVERSAL (breakout/continuation)', s => getBetClass(s.setup_type) === 'FAILED_SWEEP_REVERSAL');

  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
