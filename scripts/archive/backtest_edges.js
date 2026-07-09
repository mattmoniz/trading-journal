// backtest_edges.js
// Comprehensive back‑test for two hypotheses:
// 1️⃣ Second‑breakout decay (first vs second attempt win‑rate)
// 2️⃣ Time‑of‑day edge (9 AM vs 10 AM win‑rate)

import { query } from '../server/db.js';
import * as ss from 'simple-statistics';

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------
function proportionZTest(a, b) {
  // Guard against empty buckets
  if (a.n === 0 || b.n === 0) {
    return { z: 0, p: 1 };
  }
  const p1 = a.wins / a.n;
  const p2 = b.wins / b.n;
  const pPool = (a.wins + b.wins) / (a.n + b.n);
  const se = Math.sqrt(pPool * (1 - pPool) * (1 / a.n + 1 / b.n));
  const z = (p1 - p2) / se;
  const p = 2 * (1 - ss.cumulativeStdNormalProbability(Math.abs(z)));
  return { z, p };
}

async function fetchResolvedSetups() {
  const sql = `
    SELECT
      setup_type,
      fired_at,
      EXTRACT(HOUR FROM fired_at AT TIME ZONE 'America/New_York')::int AS hour_of_fire,
      CASE WHEN resolution = 'TARGET_HIT' THEN 1 ELSE 0 END AS is_win
    FROM active_setups
    WHERE status IN ('RESOLVED','EXPIRED')
      AND fired_at IS NOT NULL
    ORDER BY setup_type, fired_at;
  `;
  const result = await query(sql);
  return result.rows;
}

/**
 * Compute attempt_number per day for each setup_type.
 * Returns a new array with added fields:
 *   - attempt_number (1,2,3,...)
 *   - fire_date (YYYY‑MM‑DD in ET)
 */
function annotateAttempts(rows) {
  const annotated = [];
  // Group by setup_type + fire_date
  const groups = {};
  for (const r of rows) {
    const fireDate = new Date(r.fired_at).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY‑MM‑DD
    const key = fireDate; // Group by day regardless of setup_type
    if (!groups[key]) groups[key] = [];
    groups[key].push(r);
  }
  // Sort each group by fired_at and assign attempt numbers
  for (const key of Object.keys(groups)) {
    const grp = groups[key].sort((a, b) => new Date(a.fired_at) - new Date(b.fired_at));
    grp.forEach((r, idx) => {
      annotated.push({
        setup_type: r.setup_type,
        hour_of_fire: r.hour_of_fire,
        is_win: r.is_win,
        attempt_number: idx + 1,
        fire_date: key,
      });
    });
  }
  return annotated;
}

function aggregate(data, filterFn) {
  const filtered = data.filter(filterFn);
  const n = filtered.length;
  const wins = filtered.reduce((s, r) => s + r.is_win, 0);
  const winRate = n ? wins / n : 0;
  return { n, wins, winRate };
}

async function run() {
  const rows = await fetchResolvedSetups();
  console.log(`Fetched ${rows.length} resolved setups.`);
  const withAttempts = annotateAttempts(rows);

  // ----------------------
  // 1️⃣ Second‑breakout decay
  // ----------------------
  const first = aggregate(withAttempts, r => r.attempt_number === 1);
  const second = aggregate(withAttempts, r => r.attempt_number === 2);
  console.log('\n=== Second‑breakout decay (first vs second attempt) ===');
  console.table({
    First: { wins: first.wins, total: first.n, winRate: (first.winRate * 100).toFixed(2) + '%' },
    Second: { wins: second.wins, total: second.n, winRate: (second.winRate * 100).toFixed(2) + '%' },
  });
  const { z: z2, p: p2 } = proportionZTest(first, second);
  console.log(`Stat test → z = ${z2.toFixed(3)}, p‑value = ${p2.toFixed(4)}`);
  console.log(`Δ win‑rate (second – first) = ${((second.winRate - first.winRate) * 100).toFixed(2)}%`);

  // ----------------------
  // 2️⃣ Time‑of‑day edge (9 AM vs 10 AM)
  // ----------------------
  const hour9 = aggregate(withAttempts, r => r.hour_of_fire === 9);
  const hour10 = aggregate(withAttempts, r => r.hour_of_fire === 10);
  console.log('\n=== Time‑of‑day edge (9 AM vs 10 AM) ===');
  console.table({
    '9 AM': { wins: hour9.wins, total: hour9.n, winRate: (hour9.winRate * 100).toFixed(2) + '%' },
    '10 AM': { wins: hour10.wins, total: hour10.n, winRate: (hour10.winRate * 100).toFixed(2) + '%' },
  });
  const { z: zTime, p: pTime } = proportionZTest(hour9, hour10);
  console.log(`Stat test → z = ${zTime.toFixed(3)}, p‑value = ${pTime.toFixed(4)}`);
  console.log(`Δ win‑rate (10 AM – 9 AM) = ${((hour10.winRate - hour9.winRate) * 100).toFixed(2)}%`);

  process.exit(0);
}

run().catch(err => {
  console.error('Backtest failed:', err);
  process.exit(1);
});
