// Rolling-window follow-up to pilot_globex_seasonality_breakdown.mjs's Finding 1 (2026-09-02,
// user-requested: "even rolling time of year"). The discrete month/year bucketing there showed
// the 03:30 ET momentum-exhaustion pattern is heavily concentrated in May/June and in 2026 --
// but calendar-month/year boundaries are arbitrary cut points that can make a genuinely smooth
// drift look like a sharp on/off pattern, or vice versa. This computes a trailing rolling-window
// correlation over calendar time instead, so the actual SHAPE of how the pattern strengthens/
// weakens/flips is visible rather than inferred from a handful of discrete buckets.
//
// Reuses pearson()/permutationTest() exported from pilot_globex_overnight_momentum_persistence_
// grid.mjs unchanged -- same math as every other Finding-1-derived script this session.

import { query } from '../server/db.js';
import { pearson, permutationTest } from './pilot_globex_overnight_momentum_persistence_grid.mjs';
import { recordClaim } from './record_claim.mjs';

const WINDOW = 60; // trailing sessions per rolling estimate (~3 months of real trading days)
const STEP = 5; // slide the window forward this many sessions between estimates

function timeToMin(t) { const [h, m] = t.split(':').map(Number); return h * 60 + m; }
function minToTime(m) { m = (m + 24 * 60) % (24 * 60); return `${Math.floor(m / 60).toString().padStart(2, '0')}:${(m % 60).toString().padStart(2, '0')}`; }

async function main() {
  const { rows: [{ today }] } = await query(`SELECT CURRENT_DATE::text as today`);

  const r = await query(`
    SELECT ts::date::text as d, EXTRACT(hour FROM ts)::int as hr, EXTRACT(minute FROM ts)::int as min, close::float
    FROM price_bars_primary
    WHERE symbol='NQ'
      AND ((EXTRACT(hour FROM ts) >= 18) OR (EXTRACT(hour FROM ts) <= 8))
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

  const anchor = '03:30';
  const checkpoint = '05:30'; // the single strongest cell from the pooled grid (corr=-0.167)
  const anchorMinus60 = minToTime(timeToMin(anchor) - 60);

  const sortedDates = [...bySession.keys()].sort();
  const sessions = [];
  for (const d of sortedDates) {
    const bars = bySession.get(d);
    if (bars[anchorMinus60] && bars[anchor] && bars[checkpoint]) {
      sessions.push({
        date: d,
        mom60: bars[anchor] - bars[anchorMinus60],
        fwd: bars[checkpoint] - bars[anchor],
      });
    }
  }
  console.log(`${sessions.length} real sessions with full ${anchor}->${checkpoint} coverage, ${sortedDates[0]} through ${sortedDates[sortedDates.length - 1]}.`);

  const rolling = [];
  for (let end = WINDOW; end <= sessions.length; end += STEP) {
    const window = sessions.slice(end - WINDOW, end);
    const x = window.map(s => s.mom60), y = window.map(s => s.fwd);
    const corr = pearson(x, y);
    const pval = permutationTest(x, y, corr, 1000);
    rolling.push({
      windowEnd: window[window.length - 1].date,
      windowStart: window[0].date,
      N: window.length,
      corr,
      pval,
    });
  }

  console.log(`\n=== Rolling ${WINDOW}-session ${anchor}->${checkpoint} correlation (step=${STEP}) ===`);
  for (const r of rolling) {
    const sig = r.pval <= 0.05 ? '*' : ' ';
    console.log(`  window ending ${r.windowEnd}: corr=${r.corr.toFixed(3)}${sig} (p=${r.pval.toFixed(3)}, N=${r.N})`);
  }

  // Characterize the shape: is this a smooth drift, a sharp regime change, or noisy/unstable?
  const corrs = rolling.map(r => r.corr);
  const signFlips = corrs.slice(1).filter((c, i) => Math.sign(c) !== Math.sign(corrs[i]) && Math.abs(c) > 0.05 && Math.abs(corrs[i]) > 0.05).length;
  const strongestNeg = rolling.reduce((best, r) => r.corr < best.corr ? r : best, rolling[0]);
  const strongestPos = rolling.reduce((best, r) => r.corr > best.corr ? r : best, rolling[0]);
  const sigCount = rolling.filter(r => r.pval <= 0.05).length;

  console.log(`\nSign flips (>|0.05| both sides): ${signFlips} across ${rolling.length} windows.`);
  console.log(`Strongest negative: window ending ${strongestNeg.windowEnd}, corr=${strongestNeg.corr.toFixed(3)}`);
  console.log(`Strongest positive: window ending ${strongestPos.windowEnd}, corr=${strongestPos.corr.toFixed(3)}`);
  console.log(`Significant windows: ${sigCount}/${rolling.length}`);

  await recordClaim({
    slug: 'globex_0330_rolling_seasonality',
    claimText: `Rolling ${WINDOW}-session (step=${STEP}) trailing-60min-momentum correlation, 03:30 ET anchor vs 05:30 ET checkpoint (the single strongest cell from the pooled grid). Total ${rolling.length} rolling windows across ${sessions.length} real sessions (${sortedDates[0]} to ${sortedDates[sortedDates.length - 1]}). ${sigCount}/${rolling.length} windows independently permutation-significant. Strongest negative (exhaustion) window ends ${strongestNeg.windowEnd} (corr=${strongestNeg.corr.toFixed(3)}); strongest positive (persistence) window ends ${strongestPos.windowEnd} (corr=${strongestPos.corr.toFixed(3)}). ${signFlips} real sign flips (>0.05 magnitude both sides) across the rolling series -- see the printed series for the actual shape (smooth drift vs abrupt regime change vs noisy oscillation). This is the continuous-time complement to the discrete month/year breakdown in globex_0330_seasonality_breakdown, which found May/June exhaustion and an August sign flip -- check whether the rolling series shows a gradual transition through that period or a sharp break, which the discrete month bins can't distinguish.`,
    sourceFile: 'scripts/pilot_globex_0330_rolling_seasonality.mjs',
    sourceDate: today,
    sampleSize: sessions.length,
    rigorStatus: 'rolling_window_tested',
    status: 'PROVISIONAL',
  });
  console.log('\nRESEARCH_CLAIM globex_0330_rolling_seasonality recorded.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}
