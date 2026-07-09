import pg from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'trading_journal',
  user: process.env.DB_USER || 'trader',
  password: process.env.DB_PASSWORD || 'trader123',
});

const q = (t, p) => pool.query(t, p);

// Abramowitz & Stegun approximation for standard normal cumulative probability
function cumulativeStdNormalProbability(z) {
  const p = 0.2316419;
  const b1 = 0.319381530;
  const b2 = -0.356563782;
  const b3 = 1.781477937;
  const b4 = -1.821255978;
  const b5 = 1.330274429;
  const t = 1 / (1 + p * z);
  const factor = 1 / Math.sqrt(2 * Math.PI) * Math.exp(-0.5 * z * z);
  return 1 - factor * (b1 * t + b2 * Math.pow(t, 2) + b3 * Math.pow(t, 3) + b4 * Math.pow(t, 4) + b5 * Math.pow(t, 5));
}

function proportionZTest(wins1, n1, wins2, n2) {
  if (n1 === 0 || n2 === 0) return { z: 0, p: 1 };
  const p1 = wins1 / n1;
  const p2 = wins2 / n2;
  const pPool = (wins1 + wins2) / (n1 + n2);
  if (pPool === 0 || pPool === 1) return { z: 0, p: 1 };
  const se = Math.sqrt(pPool * (1 - pPool) * (1 / n1 + 1 / n2));
  const z = (p1 - p2) / se;
  const p = 2 * (1 - cumulativeStdNormalProbability(Math.abs(z)));
  return { z, p };
}

async function main() {
  console.log('=== RUNNING OVERNIGHT EDGE-MINING SEARCH ===\n');

  // 1. Create table for dynamic edges cache if it doesn't exist
  await q(`
    CREATE TABLE IF NOT EXISTS dynamic_edges_mining (
      id SERIAL PRIMARY KEY,
      setup_type TEXT NOT NULL,
      dimension TEXT NOT NULL,
      segment TEXT NOT NULL,
      tested_n INT NOT NULL,
      wins INT NOT NULL,
      win_rate NUMERIC(5,2) NOT NULL,
      baseline_n INT NOT NULL,
      baseline_win_rate NUMERIC(5,2) NOT NULL,
      deviation NUMERIC(5,2) NOT NULL,
      z_score NUMERIC(5,2) NOT NULL,
      p_value NUMERIC(5,4) NOT NULL,
      status TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      CONSTRAINT uniq_edge UNIQUE (setup_type, dimension, segment)
    )
  `);

  // 2. Fetch all setup outcomes and their daily context
  const sql = `
    SELECT s.setup_type, s.trade_date::text as trade_date, s.hit_t1_first,
           EXTRACT(HOUR FROM s.fired_at AT TIME ZONE 'America/New_York')::int as hour_of_day,
           EXTRACT(ISODOW FROM s.trade_date)::int as dow,
           (a.or_high::float - a.or_low::float) as or5_range,
           s.nl30_at_entry
    FROM setup_outcome_backtest s
    LEFT JOIN acd_daily_log a ON s.trade_date = a.trade_date
    WHERE s.hit_t1_first IS NOT NULL
  `;
  const res = await pool.query(sql);
  const rows = res.rows;
  console.log(`Loaded ${rows.length} resolved setup outcomes for evaluation.`);

  // Calculate overall range quartiles
  const ranges = rows.map(r => r.or5_range).filter(r => r != null).sort((a,b)=>a-b);
  const Q1 = ranges.length > 0 ? ranges[Math.floor(ranges.length * 0.25)] : 47.5;
  const Q4 = ranges.length > 0 ? ranges[Math.floor(ranges.length * 0.75)] : 91.5;

  // Group rows by setup_type
  const setupsMap = {};
  for (const r of rows) {
    (setupsMap[r.setup_type] ??= []).push(r);
  }

  const minedEdges = [];

  // For each setup, run combinatorial searches
  for (const [setupType, sRows] of Object.entries(setupsMap)) {
    const baseN = sRows.length;
    const baseW = sRows.filter(x => x.hit_t1_first).length;
    const baseWR = baseW / baseN;

    if (baseN < 15) continue; // Skip setups with thin data

    // Define segments to test
    const dimensions = {
      'DAY_OF_WEEK': [
        { label: 'Monday', filter: r => r.dow === 1 },
        { label: 'Tuesday', filter: r => r.dow === 2 },
        { label: 'Wednesday', filter: r => r.dow === 3 },
        { label: 'Thursday', filter: r => r.dow === 4 },
        { label: 'Friday', filter: r => r.dow === 5 },
      ],
      'TIME_OF_DAY': [
        { label: 'Morning (9:30-11:30)', filter: r => r.hour_of_day < 11 },
        { label: 'Midday (11:30-13:30)', filter: r => r.hour_of_day >= 11 && r.hour_of_day < 13 },
        { label: 'Afternoon (13:30-16:00)', filter: r => r.hour_of_day >= 13 },
      ],
      'OR_SIZE': [
        { label: 'Tight OR', filter: r => r.or5_range != null && r.or5_range < Q1 },
        { label: 'Normal OR', filter: r => r.or5_range != null && r.or5_range >= Q1 && r.or5_range < Q4 },
        { label: 'Wide OR', filter: r => r.or5_range != null && r.or5_range >= Q4 },
      ],
      'TREND_ALIGNMENT': [
        { label: 'Bull Aligned', filter: r => r.nl30_at_entry > 9 },
        { label: 'Bear Aligned', filter: r => r.nl30_at_entry < -9 },
        { label: 'Ranging market', filter: r => r.nl30_at_entry >= -9 && r.nl30_at_entry <= 9 },
      ],
    };

    for (const [dim, segments] of Object.entries(dimensions)) {
      for (const seg of segments) {
        const segRows = sRows.filter(seg.filter);
        const segN = segRows.length;
        const segW = segRows.filter(x => x.hit_t1_first).length;
        const segWR = segN > 0 ? segW / segN : 0;

        if (segN < 10) continue; // Skip thin slices

        // Compare segment against baseline (all OTHER days/times for this setup)
        const otherRows = sRows.filter(r => !seg.filter(r));
        const otherN = otherRows.length;
        const otherW = otherRows.filter(x => x.hit_t1_first).length;

        const { z, p } = proportionZTest(segW, segN, otherW, otherN);
        const deviation = segWR - baseWR;

        // An edge is marked active if:
        // - Win rate deviation is >= 8% in magnitude
        // - Statistical p-value < 0.05 (95% confidence)
        const isSignificant = p < 0.05 && Math.abs(deviation) >= 0.08;
        const status = isSignificant ? (deviation > 0 ? 'POSITIVE_BOOSTER' : 'NEGATIVE_DRAG') : 'NEUTRAL';

        minedEdges.push({
          setupType,
          dimension: dim,
          segment: seg.label,
          n: segN,
          wins: segW,
          winRate: segWR,
          baselineN: baseN,
          baselineWinRate: baseWR,
          deviation,
          zScore: z,
          pValue: p,
          status,
        });
      }
    }
  }

  // 3. Write mined edges to database
  console.log(`Mined ${minedEdges.length} setup segments. Saving to cache table...`);
  for (const e of minedEdges) {
    await q(`
      INSERT INTO dynamic_edges_mining (setup_type, dimension, segment, tested_n, wins, win_rate, baseline_n, baseline_win_rate, deviation, z_score, p_value, status, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
      ON CONFLICT (setup_type, dimension, segment) DO UPDATE SET
        tested_n=EXCLUDED.tested_n, wins=EXCLUDED.wins, win_rate=EXCLUDED.win_rate,
        baseline_n=EXCLUDED.baseline_n, baseline_win_rate=EXCLUDED.baseline_win_rate,
        deviation=EXCLUDED.deviation, z_score=EXCLUDED.z_score, p_value=EXCLUDED.p_value,
        status=EXCLUDED.status, updated_at=NOW()
    `, [
      e.setupType, e.dimension, e.segment, e.n, e.wins, Math.round(e.winRate * 1000) / 10,
      e.baselineN, Math.round(e.baselineWinRate * 1000) / 10, Math.round(e.deviation * 1000) / 10,
      Math.round(e.zScore * 100) / 100, Math.round(e.pValue * 10000) / 10000, e.status
    ]);
  }

  // 4. Output results to console
  const activeBoosters = minedEdges.filter(e => e.status === 'POSITIVE_BOOSTER').sort((a,b)=>b.deviation-a.deviation);
  const activeDrags = minedEdges.filter(e => e.status === 'NEGATIVE_DRAG').sort((a,b)=>a.deviation-b.deviation);

  console.log('\n=== ACTIVE POSITIVE BOOSTERS DISCOVERED ===');
  console.table(activeBoosters.map(e => ({
    'Setup': e.setupType,
    'Dimension': e.dimension,
    'Segment': e.segment,
    'Tested (N)': e.n,
    'Win Rate': (e.winRate * 100).toFixed(1) + '%',
    'Baseline': (e.baselineWinRate * 100).toFixed(1) + '%',
    'Deviation': `+${(e.deviation * 100).toFixed(1)}%`,
    'p-value': e.pValue.toFixed(4)
  })));

  console.log('\n=== ACTIVE NEGATIVE DRAGS DISCOVERED ===');
  console.table(activeDrags.map(e => ({
    'Setup': e.setupType,
    'Dimension': e.dimension,
    'Segment': e.segment,
    'Tested (N)': e.n,
    'Win Rate': (e.winRate * 100).toFixed(1) + '%',
    'Baseline': (e.baselineWinRate * 100).toFixed(1) + '%',
    'Deviation': `${(e.deviation * 100).toFixed(1)}%`,
    'p-value': e.pValue.toFixed(4)
  })));

  generateOvernightReport(activeBoosters, activeDrags);

  await pool.end();
}

function generateOvernightReport(boosters, drags) {
  const reportPath = '/home/mmoniz/.gemini/antigravity-cli/brain/b1a5a88c-b280-410c-85a7-2921d711bb19/overnight_edge_report.md';

  let md = `# Overnight Edge-Mining & Re-Backtesting Report\n\n`;
  md += `This report lists the **statistically significant edge shifts** discovered by the overnight edge-mining sweep. It scans all permutations of setup outcomes across day-of-week, time-of-day, volatility limits, and daily trend alignment.\n\n`;

  md += `## 🚀 Mined Positive Boosters (Size Up / Execute with Confidence)\n\n`;
  md += `| Setup Type | Dimension | Segment | Sample (N) | WR% | Baseline % | Deviation | p-value |\n`;
  md += `| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: |\n`;

  for (const e of boosters) {
    md += `| **${e.setupType}** | ${e.dimension} | ${e.segment} | ${e.n} | ${(e.winRate * 100).toFixed(1)}% | ${(e.baselineWinRate * 100).toFixed(1)}% | **+${(e.deviation * 100).toFixed(1)}%** | ${e.pValue.toFixed(4)} |\n`;
  }

  md += `\n## 🛑 Mined Negative Drags (Size Down / Filter Out)\n\n`;
  md += `| Setup Type | Dimension | Segment | Sample (N) | WR% | Baseline % | Deviation | p-value |\n`;
  md += `| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: |\n`;

  for (const e of drags) {
    md += `| **${e.setupType}** | ${e.dimension} | ${e.segment} | ${e.n} | ${(e.winRate * 100).toFixed(1)}% | ${(e.baselineWinRate * 100).toFixed(1)}% | **${(e.deviation * 100).toFixed(1)}%** | ${e.pValue.toFixed(4)} |\n`;
  }

  md += `\n> [!NOTE]\n`;
  md += `> **Methodology**: Slices are compared against their respective setup baseline using a two-proportion Z-test. Only results with a win rate shift of >= 8% and a p-value < 0.05 (95% statistical confidence) are cached as active boosters or drags.\n`;

  fs.writeFileSync(reportPath, md);
  console.log(`Markdown report written to ${reportPath}`);
}

main().catch(console.error);
