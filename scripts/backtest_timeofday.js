// backtest_timeofday.js
import { query } from '../server/db.js';
import * as ss from 'simple-statistics';

/** Fetch all resolved setups with hour‑of‑day and win flag */
async function fetchActiveSetups() {
  const sql = `
    SELECT
      setup_type,
      EXTRACT(HOUR FROM fired_at AT TIME ZONE 'America/New_York')::int AS hour_of_fire,
      CASE WHEN resolution = 'TARGET_HIT' THEN 1 ELSE 0 END AS is_win
    FROM active_setups
    WHERE status IN ('RESOLVED','EXPIRED')
      AND fired_at IS NOT NULL
    ORDER BY fired_at;   -- chronological order for proper train/validation split
  `;
  const result = await query(sql);
  return result.rows;
}

/** Split array chronologically (70 % train, 30 % validation) */
function chronologicalSplit(arr, trainPct = 0.7) {
  const splitIdx = Math.floor(arr.length * trainPct);
  return { train: arr.slice(0, splitIdx), test: arr.slice(splitIdx) };
}

/** Aggregate win‑rate for rows that satisfy an hour predicate */
function aggregate(data, hourPredicate) {
  const filtered = data.filter(r => hourPredicate(r.hour_of_fire));
  const n = filtered.length;
  const wins = filtered.reduce((s, r) => s + r.is_win, 0);
  const winRate = n ? wins / n : 0;
  return { n, wins, winRate };
}

/** Two‑sample proportion Z‑test (returns {z, p}) */
function proportionZTest(a, b) {
  // If either bucket has no observations, return neutral result
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

async function run() {
  const rows = await fetchActiveSetups();
  console.log(`Fetched ${rows.length} resolved setups.`);
  const { train, test } = chronologicalSplit(rows);
  console.log(`Train: ${train.length} rows, Validation: ${test.length} rows`);

  // Define early/late windows (you can tweak these thresholds)
  const earlyHours = h => h <= 11; // 9:30‑11:00 ET (early session)
  const lateHours  = h => h >= 13; // 13:00‑15:30 ET (late session)

  // Validation‑set aggregates
  const earlyTest = aggregate(test, earlyHours);
  const lateTest  = aggregate(test, lateHours);

  console.log('\n=== Validation (out‑of‑sample) results ===');
  console.table({
    Early: { wins: earlyTest.wins, total: earlyTest.n, winRate: (earlyTest.winRate * 100).toFixed(2) + '%' },
    Late:  { wins: lateTest.wins,  total: lateTest.n,  winRate: (lateTest.winRate * 100).toFixed(2) + '%' },
  });

  const { z, p } = proportionZTest(earlyTest, lateTest);
  const delta = (earlyTest.winRate - lateTest.winRate) * 100;
  console.log(`\nStat test → z = ${z.toFixed(3)}, p‑value = ${p.toFixed(4)}`);
  console.log(`Δ win‑rate (early – late) = ${delta.toFixed(2)} %`);

  // Optional per‑setup‑type breakdown (only when each bucket has >=30 samples)
  console.log('\n=== Per‑setup‑type early vs. late (≥30 obs each) ===');
  const types = [...new Set(rows.map(r => r.setup_type))];
  for (const type of types) {
    const typeRows = test.filter(r => r.setup_type === type);
    const early = aggregate(typeRows, earlyHours);
    const late = aggregate(typeRows, lateHours);
    if (early.n >= 30 && late.n >= 30) {
      const { p: ptype } = proportionZTest(early, late);
      const deltaT = (early.winRate - late.winRate) * 100;
      console.log(`${type.padEnd(30)} early:${early.winRate.toFixed(2)} (${early.n})  late:${late.winRate.toFixed(2)} (${late.n})  Δ=${deltaT.toFixed(1)}%  p=${ptype.toFixed(3)}`);
    }
  }
  process.exit(0);
}

run().catch(err => {
  console.error('Backtest failed:', err);
  process.exit(1);
});
