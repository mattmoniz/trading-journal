// Backtests the "Counter-Move Tracker" widget in SessionPulseCard.jsx (Session Pulse
// card, Morning Prep). Found 2026-07-16: the P25/MED/P75 retracement targets used
// hardcoded 0.46/0.68/0.88 multipliers, plus an unsourced "Median counter-move: 374pt,
// 89% had 150pt+ bounce" claim — both introduced in commit 2a69377 with no backtest
// behind either. This script computes the real numbers (Gemini-mined, Claude-audited
// same session — see docs/OPEN_THREADS.md for the audit trail).
//
// Methodology: for each RTH day where price extends >80pt from the open (same trigger
// SessionPulseCard.jsx uses), find the most extreme point reached after that trigger,
// then the largest counter-move (retracement) away from that extreme before the session
// ends. retracementPct = counterMove / peakMove — can exceed 1.0 when price doesn't just
// retrace the move but reverses through the open and keeps going.
//
// Known caveat, not yet resolved: the live card's own `morningDrop` is
// `|closeVsOpen|` at the current live moment (from morningBrief.js), which is not
// necessarily identical to this script's `peakMove` (the single most extreme point
// reached after the initial 80pt trigger) if price is still extending when the card
// reads it. Order-of-magnitude and direction are solid; exact percentile alignment
// against the live field hasn't been re-verified bar-by-bar. Worth tightening in a
// future pass if the live numbers look off after a few days of observation.
import { query } from '../server/db.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';

function percentile(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (s.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

function analyzeBucket(evs) {
  if (evs.length < 5) return { n: evs.length };
  const pcts = evs.map(e => e.retracementPct);
  const pts = evs.map(e => e.maxCounterMove);
  const rigor = computeRigor(evs, { dateField: 'date', pnlFn: e => e.pnl_dummy });
  return {
    n: evs.length,
    retracement_percentiles: {
      p25: percentile(pcts, 25).toFixed(2),
      p50: percentile(pcts, 50).toFixed(2),
      p75: percentile(pcts, 75).toFixed(2),
    },
    median_counter_move_pt: percentile(pts, 50).toFixed(1),
    bounce_150pt_pct: (evs.reduce((s, e) => s + e.bounce150, 0) / evs.length * 100).toFixed(1),
    rigor: {
      distinct_dates: rigor.distinctDates,
      clustered: rigor.clustered,
      stable: rigor.stable,
      clean: rigor.clean,
    },
  };
}

async function run() {
  const barsRes = await query(`
    SELECT ts::date::text as d, (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts))::int as et_min,
           open::float, high::float, low::float, close::float
    FROM price_bars_primary
    WHERE symbol='NQ' AND ts::date >= CURRENT_DATE - 365
      AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
    ORDER BY ts
  `);

  const dayTypesRes = await query(`
    SELECT trade_date::text as d, day_type FROM acd_daily_log WHERE trade_date >= CURRENT_DATE - 365
  `);
  const dtMap = {};
  for (const r of dayTypesRes.rows) dtMap[r.d] = r.day_type;

  const barsByDate = {};
  for (const b of barsRes.rows) {
    if (!barsByDate[b.d]) barsByDate[b.d] = [];
    barsByDate[b.d].push(b);
  }

  const events = [];
  for (const [date, bars] of Object.entries(barsByDate)) {
    if (bars.length < 60) continue;
    const openPrice = bars[0].open;

    let triggerIdx = -1, dir = null;
    for (let i = 0; i < bars.length; i++) {
      if (Math.abs(bars[i].close - openPrice) > 80) {
        triggerIdx = i;
        dir = bars[i].close > openPrice ? 'UP' : 'DOWN';
        break;
      }
    }
    if (triggerIdx === -1) continue;

    const remaining = bars.slice(triggerIdx);
    let extremeVal = dir === 'UP' ? -Infinity : Infinity, extremeIdx = -1;
    for (let i = 0; i < remaining.length; i++) {
      if (dir === 'UP') { if (remaining[i].high > extremeVal) { extremeVal = remaining[i].high; extremeIdx = i; } }
      else { if (remaining[i].low < extremeVal) { extremeVal = remaining[i].low; extremeIdx = i; } }
    }
    const peakMove = Math.abs(extremeVal - openPrice);

    const afterExtreme = remaining.slice(extremeIdx);
    if (!afterExtreme.length) continue;

    let maxCounterMove = 0;
    for (const b of afterExtreme) {
      const retracement = dir === 'UP' ? (extremeVal - b.low) : (b.high - extremeVal);
      if (retracement > maxCounterMove) maxCounterMove = retracement;
    }

    events.push({
      date, day_type: dtMap[date] || 'UNKNOWN', dir, peakMove, maxCounterMove,
      retracementPct: maxCounterMove / peakMove,
      bounce150: maxCounterMove >= 150 ? 1 : 0,
      pnl_dummy: 1, // rigor diagnostic needs a pnlFn; this isn't a $ edge, just a hit/no-hit proxy
    });
  }

  const findings = {
    overall: analyzeBucket(events),
    by_direction: {
      UP: analyzeBucket(events.filter(e => e.dir === 'UP')),
      DOWN: analyzeBucket(events.filter(e => e.dir === 'DOWN')),
    },
    by_day_type: {},
  };
  for (const t of [...new Set(events.map(e => e.day_type))]) {
    findings.by_day_type[t] = analyzeBucket(events.filter(e => e.day_type === t));
  }

  console.log(JSON.stringify(findings, null, 2));
  process.exit(0);
}

run().catch(err => { console.error(err); process.exit(1); });
