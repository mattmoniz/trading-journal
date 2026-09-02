// Verification pass on the 22:00 ET persistence cluster found by the full-day 30-min grid
// (pilot_full_day_momentum_grid.mjs, 2026-09-02) -- same stress test already applied to the
// 03:30 exhaustion pattern (passed) and the 01:00 persistence candidate (FAILED -- 2023 showed
// the opposite sign, zero of 72 rolling windows were independently significant). This cluster
// looks structurally different/stronger: a SMOOTH, coherent positive-correlation shape spanning
// 23:30 through 10:30 next day (not an isolated spike), with two humps (peak near 01:00-02:00,
// second peak near 08:30-10:00) separated by a dip near 03:00-06:00. Reuses pearson()/
// permutationTest() exported from pilot_globex_overnight_momentum_persistence_grid.mjs unchanged.
//
// The 7 Bonferroni-significant pairs from the grid (all N=413-419, all pval<=0.0000 at 500
// draws): 22:00->01:00 (corr=0.197), 22:00->02:00 (corr=0.206, strongest), 22:00->08:30
// (corr=0.182), 22:00->09:00 (corr=0.186), 22:00->09:30 (corr=0.183), 22:00->10:00 (corr=0.174),
// 22:00->10:30 (corr=0.148). Positive correlation = RIDE the move (momentum at 22:00 tends to
// still be the same direction hours later), the opposite shape from 03:30's exhaustion/fade.

import { query } from '../server/db.js';
import { pearson, permutationTest } from './pilot_globex_overnight_momentum_persistence_grid.mjs';
import { recordClaim } from './record_claim.mjs';

const ANCHOR = '22:00';
const CHECKPOINTS = ['01:00', '02:00', '08:30', '09:00', '09:30', '10:00', '10:30'];
const ROLLING_WINDOW = 60;
const ROLLING_STEP = 5;

function timeToMin(t) { const [h, m] = t.split(':').map(Number); return h * 60 + m; }
function minToTime(m) { m = (m + 24 * 60) % (24 * 60); return `${Math.floor(m / 60).toString().padStart(2, '0')}:${(m % 60).toString().padStart(2, '0')}`; }

async function main() {
  const { rows: [{ today }] } = await query(`SELECT CURRENT_DATE::text as today`);

  const r = await query(`
    SELECT ts::date::text as d, EXTRACT(hour FROM ts)::int as hr, EXTRACT(minute FROM ts)::int as min, close::float
    FROM price_bars_primary
    WHERE symbol='NQ'
      AND (EXTRACT(minute FROM ts) = 0 OR EXTRACT(minute FROM ts) = 30)
    ORDER BY ts
  `);
  const bySession = new Map();
  for (const b of r.rows) {
    let sessDate;
    if (b.hr >= 18) {
      const dt = new Date(b.d + 'T12:00:00Z');
      dt.setUTCDate(dt.getUTCDate() + 1);
      sessDate = dt.toISOString().slice(0, 10);
    } else {
      sessDate = b.d;
    }
    if (!bySession.has(sessDate)) bySession.set(sessDate, {});
    const hm = `${b.hr.toString().padStart(2, '0')}:${b.min.toString().padStart(2, '0')}`;
    bySession.get(sessDate)[hm] = b.close;
  }

  const anchorMinus60 = minToTime(timeToMin(ANCHOR) - 60);
  const sortedDates = [...bySession.keys()].sort();
  const sessions = [];
  for (const d of sortedDates) {
    const bars = bySession.get(d);
    if (!bars[anchorMinus60] || !bars[ANCHOR]) continue;
    if (!CHECKPOINTS.every(c => bars[c])) continue;
    const sess = { date: d, mom60: bars[ANCHOR] - bars[anchorMinus60], fwd: {} };
    for (const c of CHECKPOINTS) sess.fwd[c] = bars[c] - bars[ANCHOR];
    sessions.push(sess);
  }
  console.log(`${sessions.length} real sessions with full ${ANCHOR} + ${CHECKPOINTS.join('/')} coverage, ${sortedDates[0]} through ${sortedDates[sortedDates.length - 1]}.\n`);

  // 1. Pooled (sanity check against the grid numbers).
  console.log('=== Pooled (all years) ===');
  const pooled = {};
  for (const c of CHECKPOINTS) {
    const x = sessions.map(s => s.mom60), y = sessions.map(s => s.fwd[c]);
    const corr = pearson(x, y);
    const pval = permutationTest(x, y, corr, 1000);
    pooled[c] = { corr, pval, N: sessions.length };
    console.log(`  ${ANCHOR} -> ${c}: corr=${corr.toFixed(3)} p=${pval.toFixed(3)} N=${sessions.length}`);
  }

  // 2. Per-year isolation -- does the sign reproduce across separate years?
  console.log('\n=== Per-year isolation ===');
  const years = [...new Set(sessions.map(s => s.date.slice(0, 4)))].sort();
  const perYear = {};
  for (const yr of years) {
    const bucket = sessions.filter(s => s.date.startsWith(yr));
    perYear[yr] = {};
    const row = [];
    for (const c of CHECKPOINTS) {
      if (bucket.length < 5) { row.push(`${c}: N=${bucket.length} too thin`); continue; }
      const x = bucket.map(s => s.mom60), y = bucket.map(s => s.fwd[c]);
      const corr = pearson(x, y);
      perYear[yr][c] = { corr, N: bucket.length };
      row.push(`${c}: corr=${corr.toFixed(3)}`);
    }
    console.log(`  ${yr} (N=${bucket.length}): ${row.join(', ')}`);
  }

  // 3. Rolling window on the strongest pair (22:00 -> 02:00).
  const strongestCheckpoint = '02:00';
  console.log(`\n=== Rolling ${ROLLING_WINDOW}-session ${ANCHOR}->${strongestCheckpoint} correlation (step=${ROLLING_STEP}) ===`);
  const rolling = [];
  for (let end = ROLLING_WINDOW; end <= sessions.length; end += ROLLING_STEP) {
    const window = sessions.slice(end - ROLLING_WINDOW, end);
    const x = window.map(s => s.mom60), y = window.map(s => s.fwd[strongestCheckpoint]);
    const corr = pearson(x, y);
    const pval = permutationTest(x, y, corr, 1000);
    rolling.push({ windowEnd: window[window.length - 1].date, corr, pval, N: window.length });
  }
  for (const w of rolling) {
    console.log(`  window ending ${w.windowEnd}: corr=${w.corr.toFixed(3)}${w.pval <= 0.05 ? '*' : ' '} (p=${w.pval.toFixed(3)})`);
  }
  const signFlips = rolling.slice(1).filter((w, i) => Math.sign(w.corr) !== Math.sign(rolling[i].corr) && Math.abs(w.corr) > 0.05 && Math.abs(rolling[i].corr) > 0.05).length;
  const sigCount = rolling.filter(w => w.pval <= 0.05).length;
  console.log(`\nSign flips (>|0.05| both sides): ${signFlips}/${rolling.length} windows. Significant windows: ${sigCount}/${rolling.length}.`);

  // Verdict: does the sign reproduce across years for each checkpoint?
  console.log('\n=== Verdict per checkpoint ===');
  const verdicts = {};
  for (const c of CHECKPOINTS) {
    const yearCorrs = years.map(yr => perYear[yr][c]?.corr).filter(v => v != null);
    const allPositive = yearCorrs.every(v => v > 0);
    const allNegative = yearCorrs.every(v => v < 0);
    const consistent = allPositive || allNegative;
    verdicts[c] = { consistent, yearCorrs };
    console.log(`  ${ANCHOR} -> ${c}: pooled corr=${pooled[c].corr.toFixed(3)}, per-year signs ${consistent ? 'CONSISTENT' : 'MIXED'} (${yearCorrs.map(v => v.toFixed(2)).join(', ')})`);
  }

  const consistentCount = CHECKPOINTS.filter(c => verdicts[c].consistent).length;

  await recordClaim({
    slug: 'globex_2200_persistence_verification',
    claimText: `Verification of the 22:00 ET persistence cluster found by the full-day grid sweep (smooth positive correlation spanning 23:30 through 10:30 next day, opposite shape from the 03:30 exhaustion pattern -- RIDE not fade). Same per-year isolation + rolling-window stress test applied to 03:30 (passed) and 01:00 (failed). Pooled (N=${sessions.length}): ${CHECKPOINTS.map(c => `${ANCHOR}->${c} corr=${pooled[c].corr.toFixed(3)} p=${pooled[c].pval.toFixed(3)}`).join('; ')}. Per-year sign consistency: ${CHECKPOINTS.map(c => `${c} ${verdicts[c].consistent ? 'CONSISTENT' : 'MIXED'} (${verdicts[c].yearCorrs.map(v => v.toFixed(2)).join('/')})`).join('; ')}. ${consistentCount}/${CHECKPOINTS.length} checkpoints show consistent sign across all years. Rolling ${ROLLING_WINDOW}-session window on the strongest pair (${ANCHOR}->${strongestCheckpoint}): ${sigCount}/${rolling.length} windows independently significant, ${signFlips} real sign flips across the full ${sessions.length}-session history. This determines whether the 22:00 cluster is a trustworthy candidate for the user's stated goal (capture a larger overnight move reliably enough to hold through to a later checkpoint), or a pooled-only artifact the way the naive 01:00 read turned out to be.`,
    sourceFile: 'scripts/pilot_globex_2200_persistence_verification.mjs',
    sourceDate: today,
    sampleSize: sessions.length,
    rigorStatus: 'per_year_and_rolling_verified',
    status: 'PROVISIONAL',
  });
  console.log('\nRESEARCH_CLAIM globex_2200_persistence_verification recorded.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}
