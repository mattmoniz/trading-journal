// pilot_touch_defense_prereg_20261007.mjs -- single run of the pre-registered touch/defense
// test. See docs/PREREG_TOUCH_DEFENSE_20261007.md for the committed definition, fixed
// parameters, and kill criterion -- written BEFORE this script ran. Do not re-tune parameters
// here after seeing the result; that defeats the point of pre-registering.

import { query } from '../server/db.js';
import { dayBlockedBootstrapCI } from '../server/services/rigorDiagnostics.js';
import fs from 'fs';

const PROXIMITY_PCT = 0.0015; // 0.15% of price
const LOOKBACK_DAYS = 30;
const REJECTION_ATR_MULT = 1.0;
const MIN_PRIOR_TOUCHES_FOR_DEFENDED = 2;

async function main() {
  console.log('=== Pre-registered touch/defense test (single run, no iteration) ===\n');

  const evCsv = fs.readFileSync('scratch/ml_cluster_confluence_ev_20261007.csv', 'utf8');
  const lines = evCsv.trim().split('\n').slice(1);
  const evById = new Map();
  for (const line of lines) {
    const [id, date, , , , ev08, ev10, ev12, ev14] = line.split(',');
    evById.set(Number(id), { date, diff: parseFloat(ev14) - parseFloat(ev08) });
  }
  console.log(`Loaded ${evById.size} trades with real EV-at-multiplier ground truth.`);

  const ids = [...evById.keys()];
  const tradesRes = await query(`
    SELECT id, fired_at, entry_zone_low::float, entry_zone_high::float
    FROM active_setups WHERE id = ANY($1::int[]) ORDER BY fired_at ASC
  `, [ids]);
  console.log(`Fetched ${tradesRes.rows.length} trade levels.`);

  const barsRes = await query(`SELECT ts, high::float as high, low::float as low, close::float as close FROM price_bars_primary WHERE symbol='NQ' ORDER BY ts ASC`);
  const allBars = barsRes.rows.map(b => ({ ts: new Date(b.ts).getTime(), high: b.high, low: b.low, close: b.close }));
  console.log(`${allBars.length} NQ bars loaded.\n`);

  // ATR20 precomputed once, aligned to allBars.
  const atr20 = new Array(allBars.length).fill(null);
  for (let i = 20; i < allBars.length; i++) {
    let sum = 0;
    for (let j = i - 19; j <= i; j++) {
      const prevClose = allBars[j - 1]?.close ?? allBars[j].close;
      const tr = Math.max(allBars[j].high - allBars[j].low, Math.abs(allBars[j].high - prevClose), Math.abs(allBars[j].low - prevClose));
      sum += tr;
    }
    atr20[i] = sum / 20;
  }

  function firstIndexAfter(t) {
    let lo = 0, hi = allBars.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (allBars[mid].ts <= t) lo = mid + 1; else hi = mid; }
    return lo;
  }

  const events = []; // { date, group: 'DEFENDED'|'NOT_DEFENDED', diff }
  let skippedNoLevel = 0, skippedNoAtr = 0;

  for (const t of tradesRes.rows) {
    const level = t.entry_zone_high ?? t.entry_zone_low;
    if (level == null) { skippedNoLevel++; continue; }
    const touchTs = new Date(t.fired_at).getTime();
    const touchIdx = firstIndexAfter(touchTs) - 1;
    if (touchIdx < 20 || atr20[touchIdx] == null) { skippedNoAtr++; continue; }

    const lookbackStart = touchTs - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
    const startIdx = Math.max(20, firstIndexAfter(lookbackStart));

    const band = level * PROXIMITY_PCT;
    let priorTouches = 0;
    let hasRejection = false;
    let inTouch = false; // track contiguous touch episodes, not every bar inside one

    for (let i = startIdx; i < touchIdx; i++) {
      const b = allBars[i];
      const near = b.low <= level + band && b.high >= level - band;
      if (near && !inTouch) {
        priorTouches++;
        inTouch = true;
        // Check rejection: does price move away >= REJECTION_ATR_MULT*ATR from the level
        // within the next few bars without closing back through it? Look ahead a bounded
        // window (20 bars) within the lookback, causal relative to the touch being tested.
        const atrAtThatTouch = atr20[i] ?? atr20[touchIdx];
        const rejectDist = atrAtThatTouch * REJECTION_ATR_MULT;
        let maxExcursion = 0;
        let closedThrough = false;
        for (let k = i; k < Math.min(i + 20, touchIdx); k++) {
          const bk = allBars[k];
          const excursion = Math.max(level - bk.low, bk.high - level, 0);
          if (excursion > maxExcursion) maxExcursion = excursion;
          // "closed through" = a close on the far side beyond the band, in either direction
          if (Math.abs(bk.close - level) > band && ((bk.close - level) * (b.close - level) < 0)) {
            closedThrough = true;
          }
        }
        if (maxExcursion >= rejectDist && !closedThrough) hasRejection = true;
      } else if (!near) {
        inTouch = false;
      }
    }

    const defended = priorTouches >= MIN_PRIOR_TOUCHES_FOR_DEFENDED && hasRejection;
    const ev = evById.get(t.id);
    events.push({ date: ev.date, group: defended ? 'DEFENDED' : 'NOT_DEFENDED', diff: ev.diff });
  }

  console.log(`Skipped: ${skippedNoLevel} no-level, ${skippedNoAtr} no-ATR-coverage`);
  console.log(`Classified: ${events.length}\n`);

  const defended = events.filter(e => e.group === 'DEFENDED');
  const notDefended = events.filter(e => e.group === 'NOT_DEFENDED');
  console.log(`DEFENDED: N=${defended.length}, mean diff=$${(defended.reduce((a, b) => a + b.diff, 0) / defended.length).toFixed(2)}`);
  console.log(`NOT_DEFENDED: N=${notDefended.length}, mean diff=$${(notDefended.reduce((a, b) => a + b.diff, 0) / notDefended.length).toFixed(2)}`);

  // Day-blocked bootstrap CI on the DIFFERENCE between the two groups' mean diff.
  // Build paired-by-day resampling manually since this is a two-group (not paired) comparison.
  const byDateDefended = new Map(), byDateNotDefended = new Map();
  for (const e of defended) { if (!byDateDefended.has(e.date)) byDateDefended.set(e.date, []); byDateDefended.get(e.date).push(e.diff); }
  for (const e of notDefended) { if (!byDateNotDefended.has(e.date)) byDateNotDefended.set(e.date, []); byDateNotDefended.get(e.date).push(e.diff); }
  const allDates = [...new Set([...byDateDefended.keys(), ...byDateNotDefended.keys()])];

  function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  function hashSeed(s) { let h = 0; for (let i = 0; i < s.length; i++) { h = (Math.imul(31, h) + s.charCodeAt(i)) | 0; } return h; }
  const rand = mulberry32(hashSeed('touch_defense_prereg_20261007'));
  const deltas = [];
  for (let iter = 0; iter < 2000; iter++) {
    const dVals = [], nVals = [];
    for (let k = 0; k < allDates.length; k++) {
      const d = allDates[Math.floor(rand() * allDates.length)];
      if (byDateDefended.has(d)) dVals.push(...byDateDefended.get(d));
      if (byDateNotDefended.has(d)) nVals.push(...byDateNotDefended.get(d));
    }
    if (dVals.length === 0 || nVals.length === 0) continue;
    const dMean = dVals.reduce((a, b) => a + b, 0) / dVals.length;
    const nMean = nVals.reduce((a, b) => a + b, 0) / nVals.length;
    deltas.push(dMean - nMean);
  }
  deltas.sort((a, b) => a - b);
  const lo = deltas[Math.floor(deltas.length * 0.025)];
  const hi = deltas[Math.floor(deltas.length * 0.975)];
  const excludesZero = lo > 0 || hi < 0;

  console.log(`\nDay-blocked bootstrap 95% CI on (DEFENDED - NOT_DEFENDED) diff: [$${lo.toFixed(2)}, $${hi.toFixed(2)}]${excludesZero ? '  <<< excludes zero' : ''}`);

  console.log('\n=== VERDICT (per pre-registered kill criterion, no iteration) ===');
  if (excludesZero) {
    console.log('CI excludes zero: a real, pre-registered positive result. Report honestly, whichever direction.');
  } else {
    console.log('CI crosses zero: dead, per the kill criterion fixed in docs/PREREG_TOUCH_DEFENSE_20261007.md.');
    console.log('This specific operationalization is closed. Do not re-tune parameters and re-run.');
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
