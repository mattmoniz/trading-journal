// Backtest: Level-based patterns — round trips vs. extensions
// For each key level, detects when price re-tests it AFTER the level is established,
// then tracks which happens FIRST: extension through or retrace away.
// Both 252-day and 30-day rolling windows computed.
// Writes qualifying patterns to performance_audit (signal_type='LEVEL_PATTERN').

import { query } from '../server/db.js';

const MIN_N = 20;
const TOUCH_TOL = 4;   // within 4pt = "touched"
const EXT_PT  = 20;    // 20pt beyond level = extension confirmed
const RET_PT  = 15;    // 15pt away from level = retrace confirmed

// ── Load bars (RTH, rolling 252 days) ────────────────────────────────────────

const { rows: allBars } = await query(`
  SELECT
    (ts AT TIME ZONE 'America/New_York')::date AS td,
    EXTRACT(HOUR FROM ts AT TIME ZONE 'America/New_York')*60 +
    EXTRACT(MINUTE FROM ts AT TIME ZONE 'America/New_York') AS et_min,
    open::float, high::float, low::float, close::float
  FROM price_bars_primary
  WHERE symbol='NQ'
    AND (ts AT TIME ZONE 'America/New_York')::date >= CURRENT_DATE - interval '280 days'
    AND (ts AT TIME ZONE 'America/New_York')::date <  CURRENT_DATE
    AND EXTRACT(HOUR FROM ts AT TIME ZONE 'America/New_York')*60 +
        EXTRACT(MINUTE FROM ts AT TIME ZONE 'America/New_York') BETWEEN 570 AND 960
  ORDER BY td, et_min
`);

// ── Load prior-day values for gap analysis ────────────────────────────────────

const { rows: dayLevels } = await query(`
  WITH daily AS (
    SELECT
      (ts AT TIME ZONE 'America/New_York')::date AS td,
      MAX(CASE WHEN EXTRACT(HOUR FROM ts AT TIME ZONE 'America/New_York')*60+EXTRACT(MINUTE FROM ts AT TIME ZONE 'America/New_York') BETWEEN 570 AND 629 THEN high END)::float AS ib_high,
      MIN(CASE WHEN EXTRACT(HOUR FROM ts AT TIME ZONE 'America/New_York')*60+EXTRACT(MINUTE FROM ts AT TIME ZONE 'America/New_York') BETWEEN 570 AND 629 THEN low  END)::float AS ib_low,
      MAX(CASE WHEN EXTRACT(HOUR FROM ts AT TIME ZONE 'America/New_York')*60+EXTRACT(MINUTE FROM ts AT TIME ZONE 'America/New_York') BETWEEN 570 AND 599 THEN high END)::float AS or_high,
      MIN(CASE WHEN EXTRACT(HOUR FROM ts AT TIME ZONE 'America/New_York')*60+EXTRACT(MINUTE FROM ts AT TIME ZONE 'America/New_York') BETWEEN 570 AND 599 THEN low  END)::float AS or_low,
      MIN(CASE WHEN EXTRACT(HOUR FROM ts AT TIME ZONE 'America/New_York')*60+EXTRACT(MINUTE FROM ts AT TIME ZONE 'America/New_York') = 570 THEN open END)::float AS open_930,
      MAX(CASE WHEN EXTRACT(HOUR FROM ts AT TIME ZONE 'America/New_York')*60+EXTRACT(MINUTE FROM ts AT TIME ZONE 'America/New_York') BETWEEN 959 AND 961 THEN close END)::float AS close_400,
      MAX(CASE WHEN EXTRACT(HOUR FROM ts AT TIME ZONE 'America/New_York')*60+EXTRACT(MINUTE FROM ts AT TIME ZONE 'America/New_York') BETWEEN 570 AND 960 THEN high END)::float AS session_high,
      MIN(CASE WHEN EXTRACT(HOUR FROM ts AT TIME ZONE 'America/New_York')*60+EXTRACT(MINUTE FROM ts AT TIME ZONE 'America/New_York') BETWEEN 570 AND 960 THEN low  END)::float AS session_low
    FROM price_bars_primary
    WHERE symbol='NQ'
      AND (ts AT TIME ZONE 'America/New_York')::date >= CURRENT_DATE - interval '280 days'
      AND (ts AT TIME ZONE 'America/New_York')::date <  CURRENT_DATE
    GROUP BY td
    HAVING MIN(CASE WHEN EXTRACT(HOUR FROM ts AT TIME ZONE 'America/New_York')*60+EXTRACT(MINUTE FROM ts AT TIME ZONE 'America/New_York') = 570 THEN open END) IS NOT NULL
  )
  SELECT
    td::text,
    ib_high, ib_low, or_high, or_low, open_930, close_400, session_high, session_low,
    LAG(session_high) OVER (ORDER BY td) AS prior_high,
    LAG(session_low)  OVER (ORDER BY td) AS prior_low,
    LAG(close_400)    OVER (ORDER BY td) AS prior_close
  FROM daily
  ORDER BY td
`);

// Group bars and levels by day
const barsByDay = new Map();
for (const b of allBars) {
  if (!barsByDay.has(b.td)) barsByDay.set(b.td, []);
  barsByDay.get(b.td).push(b);
}
const levelMap = new Map(dayLevels.map(r => [r.td, r]));
const allDays = dayLevels.filter(r => r.ib_high && r.close_400).map(r => r.td);

console.log(`Loaded ${allDays.length} trading days  (bars: ${allBars.length})\n`);

// ── Core detector ─────────────────────────────────────────────────────────────
// Returns 'extension' | 'retrace' | null for the first event after touchIdx

function firstEvent(bars, touchIdx, dir /* 'UP' | 'DOWN' */, level) {
  for (let i = touchIdx + 1; i < bars.length; i++) {
    const b = bars[i];
    if (dir === 'UP') {
      if (b.high > level + EXT_PT) return { outcome: 'extension', mins: b.et_min - bars[touchIdx].et_min };
      if (b.low  < level - RET_PT) return { outcome: 'retrace',   mins: b.et_min - bars[touchIdx].et_min };
    } else {
      if (b.low  < level - EXT_PT) return { outcome: 'extension', mins: b.et_min - bars[touchIdx].et_min };
      if (b.high > level + RET_PT) return { outcome: 'retrace',   mins: b.et_min - bars[touchIdx].et_min };
    }
  }
  return null;
}

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a,b) => a-b);
  return s[Math.floor(s.length/2)];
}

function fmtMin(m) {
  if (m == null) return '—';
  return `${Math.floor(m/60)}h${String(m%60).padStart(2,'0')}m`;
}

function toET(etMin) {
  if (!etMin || !isFinite(etMin)) return '?';
  const h = Math.floor(etMin/60), m = etMin%60;
  return `${h}:${String(m).padStart(2,'0')} ET`;
}

// ── Pattern definitions ────────────────────────────────────────────────────────

const patterns = [
  {
    id: 'IB_HIGH_RETEST',
    desc: 'Re-tests IB HIGH after 10:31am',
    dir: 'UP',
    getLevel: lv => lv.ib_high,
    touchWindow: [631, 840],
  },
  {
    id: 'IB_LOW_RETEST',
    desc: 'Re-tests IB LOW after 10:31am',
    dir: 'DOWN',
    getLevel: lv => lv.ib_low,
    touchWindow: [631, 840],
  },
  {
    id: 'OR_HIGH_RETEST',
    desc: 'Re-tests OR HIGH after 10:01am',
    dir: 'UP',
    getLevel: lv => lv.or_high,
    touchWindow: [601, 840],
  },
  {
    id: 'OR_LOW_RETEST',
    desc: 'Re-tests OR LOW after 10:01am',
    dir: 'DOWN',
    getLevel: lv => lv.or_low,
    touchWindow: [601, 840],
  },
  {
    id: 'PRIOR_CLOSE_TAG',
    desc: 'First tag of prior day close during RTH',
    dir: null, // dynamic
    getLevel: lv => lv.prior_close,
    touchWindow: [570, 900],
  },
  {
    id: 'PRIOR_HIGH_GAP_UP',
    desc: 'Gap-up open above prior high → fills gap?',
    dir: 'DOWN',
    getLevel: lv => lv.prior_high,
    touchWindow: [570, 960],
    filterFn: lv => lv.prior_high != null && lv.open_930 > lv.prior_high + TOUCH_TOL,
  },
  {
    id: 'PRIOR_LOW_GAP_DOWN',
    desc: 'Gap-down open below prior low → fills gap?',
    dir: 'UP',
    getLevel: lv => lv.prior_low,
    touchWindow: [570, 960],
    filterFn: lv => lv.prior_low != null && lv.open_930 < lv.prior_low - TOUCH_TOL,
  },
];

// ── Run both windows ──────────────────────────────────────────────────────────

function runWindow(days) {
  const patResults = {};
  for (const p of patterns) patResults[p.id] = { n:0, ext:0, ret:0, extMins:[], retMins:[], touchEtMins:[] };

  for (const td of days) {
    const lv = levelMap.get(td);
    const bars = barsByDay.get(td);
    if (!lv || !bars || bars.length < 20) continue;

    for (const p of patterns) {
      if (p.filterFn && !p.filterFn(lv)) continue;
      const level = p.getLevel(lv);
      if (!level) continue;

      const [wStart, wEnd] = p.touchWindow;

      // For PRIOR_CLOSE_TAG, direction is dynamic (up or down from open)
      let dir = p.dir;
      if (p.id === 'PRIOR_CLOSE_TAG') {
        if (!lv.open_930) continue;
        dir = lv.open_930 >= level ? 'DOWN' : 'UP';
      }

      // Find first qualifying touch
      let touchIdx = -1;
      for (let i = 0; i < bars.length; i++) {
        const b = bars[i];
        if (b.et_min < wStart || b.et_min > wEnd) continue;
        const touched = dir === 'UP'
          ? b.high >= level - TOUCH_TOL
          : b.low  <= level + TOUCH_TOL;
        if (touched) { touchIdx = i; break; }
      }
      if (touchIdx < 0) continue;

      const r = patResults[p.id];
      r.n++;
      r.touchEtMins.push(bars[touchIdx].et_min);
      const ev = firstEvent(bars, touchIdx, dir, level);
      if (!ev) continue;
      if (ev.outcome === 'extension') { r.ext++; r.extMins.push(ev.mins); }
      else                            { r.ret++; r.retMins.push(ev.mins); }
    }
  }
  return patResults;
}

// 252-day = all days, 30-day = last 30
const results252 = runWindow(allDays);
const results30  = runWindow(allDays.slice(-30));

// ── Print comparison ──────────────────────────────────────────────────────────

console.log('═'.repeat(100));
console.log('LEVEL PATTERN RESULTS — Extension-first vs Retrace-first (first event wins)');
console.log('═'.repeat(100));
console.log(`${'Pattern'.padEnd(36)} ${'252d N'.padStart(6)} ${'EXT%'.padStart(6)} ${'MedExt'.padStart(8)} ${'RET%'.padStart(6)} ${'MedRet'.padStart(8)} | ${'30d N'.padStart(5)} ${'EXT%'.padStart(6)} ${'RET%'.padStart(6)} ${'DRIFT'.padStart(6)}`);
console.log('─'.repeat(100));

for (const p of patterns) {
  const r252 = results252[p.id];
  const r30  = results30[p.id];
  if (r252.n < MIN_N) continue;

  const e252 = r252.n > 0 ? Math.round(100*r252.ext/r252.n) : 0;
  const rt252 = r252.n > 0 ? Math.round(100*r252.ret/r252.n) : 0;
  const e30  = r30.n  > 0 ? Math.round(100*r30.ext/r30.n)  : null;
  const rt30 = r30.n  > 0 ? Math.round(100*r30.ret/r30.n)  : null;
  const drift = e30 != null ? e30 - e252 : null;
  const flag = Math.abs(drift||0) >= 10 ? ' ◀DRIFT' : '';
  const medExt = fmtMin(median(r252.extMins));
  const medRet = fmtMin(median(r252.retMins));
  const avgTouch = r252.touchEtMins.length ? Math.round(r252.touchEtMins.reduce((a,b)=>a+b,0)/r252.touchEtMins.length) : null;

  console.log(
    `${p.desc.padEnd(36)} ${String(r252.n).padStart(6)} ${(e252+'%').padStart(6)} ${medExt.padStart(8)} ${(rt252+'%').padStart(6)} ${medRet.padStart(8)}` +
    ` | ${r30.n > 0 ? String(r30.n).padStart(5) : '  —  '} ${e30!=null?(e30+'%').padStart(6):'  —   '} ${rt30!=null?(rt30+'%').padStart(6):'  —   '} ${drift!=null?((drift>=0?'+':'')+drift+'%').padStart(6):'  —   '}${flag}`
  );
  if (avgTouch) console.log(`  avg touch time: ${toET(avgTouch)}`);
}

// ── NQStats Validation ────────────────────────────────────────────────────────

console.log('\n' + '═'.repeat(70));
console.log('NQSTATS INDEPENDENT VALIDATION');
console.log('═'.repeat(70));

let ibNoon=0, ibClose=0, oppSide=0, total=0;
for (const td of allDays) {
  const lv = levelMap.get(td);
  const bars = barsByDay.get(td);
  if (!lv?.ib_high || !lv?.ib_low || !bars) continue;
  total++;

  const noonBars  = bars.filter(b => b.et_min <= 720);
  const closeBars = bars;
  if (noonBars.some(b  => b.high > lv.ib_high || b.low < lv.ib_low)) ibNoon++;
  if (closeBars.some(b => b.high > lv.ib_high || b.low < lv.ib_low)) ibClose++;

  const amBars = bars.filter(b => b.et_min < 720);
  const pmBars = bars.filter(b => b.et_min >= 720 && b.et_min < 960);
  if (amBars.length && pmBars.length) {
    const amH = Math.max(...amBars.map(b=>b.high)), amL = Math.min(...amBars.map(b=>b.low));
    const pmH = Math.max(...pmBars.map(b=>b.high)), pmL = Math.min(...pmBars.map(b=>b.low));
    const sH = Math.max(amH,pmH), sL = Math.min(amL,pmL);
    if ((amH >= sH-1 && pmL <= sL+1) || (pmH >= sH-1 && amL <= sL+1)) oppSide++;
  }
}
console.log(`IB breaks by noon:  NQStats=82.5%  Ours=${Math.round(100*ibNoon/total)}%  (N=${total})`);
console.log(`IB breaks by close: NQStats=96.1%  Ours=${Math.round(100*ibClose/total)}%  (N=${total})`);
console.log(`Opposite AM/PM:     NQStats=72.8%  Ours=${Math.round(100*oppSide/total)}%  (N=${total})`);

// ── Session Bias Drift ────────────────────────────────────────────────────────

console.log('\n' + '═'.repeat(70));
console.log('SESSION BIAS STATS — 252-day vs 30-day drift');
console.log('═'.repeat(70));
console.log(`${'Condition'.padEnd(40)} ${'252d'.padStart(8)} ${'30d'.padStart(8)} ${'Drift'.padStart(7)}`);
console.log('─'.repeat(70));

function sbRate(days, filterFn, outcomeFn) {
  const valid = days.filter(td => {
    const lv = levelMap.get(td);
    return lv && lv.open_930 && lv.close_400 && filterFn(lv);
  });
  if (valid.length < 10) return { pct: null, n: valid.length };
  const wins = valid.filter(td => outcomeFn(levelMap.get(td))).length;
  return { pct: Math.round(100*wins/valid.length), n: valid.length };
}

// Need close_1000 and close_1030 — derive from dayLevels
// dayLevels doesn't have these yet — need to add to the query
// For now use open_930 + close_400 for session-level stats
const sbStats = [
  ['Morning UP (>5pt) → session closes long',
    lv => { const bars = barsByDay.get(lv.td); if (!bars) return false; const c10 = bars.find(b=>b.et_min>=599&&b.et_min<=601)?.close; return c10 && c10 - lv.open_930 > 5; },
    lv => lv.close_400 > lv.open_930],
  ['Morning DOWN (>5pt) → session closes short',
    lv => { const bars = barsByDay.get(lv.td); if (!bars) return false; const c10 = bars.find(b=>b.et_min>=599&&b.et_min<=601)?.close; return c10 && lv.open_930 - c10 > 5; },
    lv => lv.close_400 < lv.open_930],
  ['IB broke HIGH (c1030 > ib_high) → session long',
    lv => { const bars = barsByDay.get(lv.td); if (!bars||!lv.ib_high) return false; const c13 = bars.find(b=>b.et_min>=629&&b.et_min<=631)?.close; return c13 && c13 > lv.ib_high; },
    lv => lv.close_400 > lv.open_930],
  ['IB broke LOW (c1030 < ib_low) → session short',
    lv => { const bars = barsByDay.get(lv.td); if (!bars||!lv.ib_low) return false; const c13 = bars.find(b=>b.et_min>=629&&b.et_min<=631)?.close; return c13 && c13 < lv.ib_low; },
    lv => lv.close_400 < lv.open_930],
  ['Gap-up open (above prior high) → fills gap',
    lv => lv.prior_high != null && lv.open_930 > lv.prior_high + TOUCH_TOL,
    lv => lv.session_low <= lv.prior_high + TOUCH_TOL],
  ['Gap-down open (below prior low) → fills gap',
    lv => lv.prior_low != null && lv.open_930 < lv.prior_low - TOUCH_TOL,
    lv => lv.session_high >= lv.prior_low - TOUCH_TOL],
];

for (const [label, filterFn, outcomeFn] of sbStats) {
  // Adapt filterFn to take td (since we need barsByDay)
  const filteredDays = allDays.filter(td => {
    const lv = levelMap.get(td);
    return lv && filterFn({ ...lv, td });
  });
  const filteredDays30 = filteredDays.slice(-Math.min(30, filteredDays.length));

  const winCount = filteredDays.filter(td => outcomeFn(levelMap.get(td))).length;
  const winCount30 = filteredDays30.filter(td => outcomeFn(levelMap.get(td))).length;

  const pct252 = filteredDays.length >= 10 ? Math.round(100*winCount/filteredDays.length) : null;
  const pct30  = filteredDays30.length >= 10 ? Math.round(100*winCount30/filteredDays30.length) : null;
  const drift  = pct252 != null && pct30 != null ? pct30 - pct252 : null;
  const flag   = Math.abs(drift||0) >= 10 ? ' ◀DRIFT' : '';

  console.log(
    `${label.padEnd(40)}` +
    ` ${pct252!=null ? (pct252+'% N='+filteredDays.length).padStart(8) : '    —   '}` +
    ` ${pct30!=null  ? (pct30+'% N='+filteredDays30.length).padStart(8) : '    —   '}` +
    ` ${drift!=null  ? ((drift>=0?'+':'')+drift+'%').padStart(7) : '   —   '}${flag}`
  );
}

// ── Write to performance_audit ────────────────────────────────────────────────

const today = new Date().toISOString().slice(0, 10);
await query(`DELETE FROM performance_audit WHERE signal_type='LEVEL_PATTERN'`);

let written = 0;
for (const p of patterns) {
  const r252 = results252[p.id];
  const r30  = results30[p.id];
  if (r252.n < MIN_N) continue;

  const e252  = Math.round(100*r252.ext/r252.n);
  const rt252 = Math.round(100*r252.ret/r252.n);
  const e30   = r30.n >= 10 ? Math.round(100*r30.ext/r30.n) : null;
  const drift = e30 != null ? e30 - e252 : null;
  const dominant = e252 >= rt252 ? 'extension' : 'retrace';
  const domPct = e252 >= rt252 ? e252 : rt252;
  const medExt = median(r252.extMins);
  const medRet = median(r252.retMins);

  if (domPct < 58) continue; // not strong enough to publish

  await query(`
    INSERT INTO performance_audit (signal_type, signal_name, recommendation, win_rate, sample_size, run_date, window_days, notes)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
  `, [
    'LEVEL_PATTERN', p.id,
    dominant === 'extension' ? 'EXTEND' : 'RETRACE',
    domPct / 100, r252.n, today, 252,
    JSON.stringify({
      desc:       p.desc,
      ext_pct:    e252,
      ret_pct:    rt252,
      ext_med_mins: medExt,
      ret_med_mins: medRet,
      ext_pct_30d:  e30,
      drift_30d:    drift,
      label: dominant === 'extension'
        ? `${p.desc}: ${e252}% extend through (med ${fmtMin(medExt)})`
        : `${p.desc}: ${rt252}% retrace (med ${fmtMin(medRet)})`,
      action: dominant === 'extension'
        ? `${e252}% of re-tests push through the level. Enter in direction of the break, not against it.`
        : `${rt252}% of re-tests pull back. Fade the level on re-test.`,
      drifting: Math.abs(drift||0) >= 10,
    }),
  ]);
  written++;
}

console.log(`\nWrote ${written} LEVEL_PATTERN rows to performance_audit`);
process.exit(0);
