// Mines setup-outcome win-rate deviations across DAY_OF_WEEK/TIME_OF_DAY/OR_SIZE/
// TREND_ALIGNMENT segments, writes to dynamic_edges_mining. Read live by
// server/routes/antigravityEdges.js (the `dynamicEdges` mechanism) to size up/down
// "Today's Actionable Setups" — the only significance-gated adjustment for that panel
// as of 2026-07-13 after SETUP_CONTEXT's hardcoded per-setup adjustment table was
// removed (that table applied static literals to conditions this script's own
// significance test mostly found NEUTRAL — i.e. was treating noise as signal on top of
// a mechanism that already does this correctly).
//
// Found 2026-07-13: this script was swept into scripts/archive/ during the 2026-07-09
// "archive 87 orphaned scripts" pipeline consolidation (commit de3e407) because nothing
// directly *called* it — but antigravityEdges.js still reads dynamic_edges_mining
// downstream, so the table went stale (10 days, frozen at 2026-07-03) while still being
// presented live. Restored to scripts/ and wired into run_weekly_backtests.sh.
//
// MIN_N raised from the original 10/15 to this codebase's standard N>=20 hard floor
// (CLAUDE.md: "Never fabricate a stat... N≥20 before it's reported as decisive") —
// several previously-"significant" rows (e.g. TRT_SHORT|DAY_OF_WEEK|Thursday, N=10,
// p=0.04) were below that floor. A p<0.05 result on N=10, with dozens of segments
// tested per setup and no multiple-comparison correction, is exactly the shape of
// result likely to be noise rather than real edge.

import { query } from '../server/db.js';
import fs from 'fs';

const MIN_N = 20;

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
  console.log('=== EDGE-MINING SEARCH (DAY_OF_WEEK / TIME_OF_DAY / OR_SIZE / TREND_ALIGNMENT) ===\n');

  await query(`
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
  const { rows } = await query(sql);
  console.log(`Loaded ${rows.length} resolved setup outcomes for evaluation.`);

  const ranges = rows.map(r => r.or5_range).filter(r => r != null).sort((a, b) => a - b);
  const Q1 = ranges.length > 0 ? ranges[Math.floor(ranges.length * 0.25)] : 47.5;
  const Q4 = ranges.length > 0 ? ranges[Math.floor(ranges.length * 0.75)] : 91.5;

  const setupsMap = {};
  for (const r of rows) {
    (setupsMap[r.setup_type] ??= []).push(r);
  }

  const minedEdges = [];

  for (const [setupType, sRows] of Object.entries(setupsMap)) {
    const baseN = sRows.length;
    const baseW = sRows.filter(x => x.hit_t1_first).length;
    const baseWR = baseW / baseN;

    if (baseN < MIN_N) continue;

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

        if (segN < MIN_N) continue;

        const otherRows = sRows.filter(r => !seg.filter(r));
        const otherN = otherRows.length;
        const otherW = otherRows.filter(x => x.hit_t1_first).length;

        const { z, p } = proportionZTest(segW, segN, otherW, otherN);
        const deviation = segWR - baseWR;

        const isSignificant = p < 0.05 && Math.abs(deviation) >= 0.08;
        const status = isSignificant ? (deviation > 0 ? 'POSITIVE_BOOSTER' : 'NEGATIVE_DRAG') : 'NEUTRAL';

        minedEdges.push({
          setupType, dimension: dim, segment: seg.label,
          n: segN, wins: segW, winRate: segWR,
          baselineN: baseN, baselineWinRate: baseWR,
          deviation, zScore: z, pValue: p, status,
        });
      }
    }
  }

  console.log(`Mined ${minedEdges.length} setup segments (N>=${MIN_N} both baseline and slice). Saving to cache table...`);

  await query('DELETE FROM dynamic_edges_mining');
  for (const e of minedEdges) {
    await query(`
      INSERT INTO dynamic_edges_mining (setup_type, dimension, segment, tested_n, wins, win_rate, baseline_n, baseline_win_rate, deviation, z_score, p_value, status, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
    `, [
      e.setupType, e.dimension, e.segment, e.n, e.wins, Math.round(e.winRate * 1000) / 10,
      e.baselineN, Math.round(e.baselineWinRate * 1000) / 10, Math.round(e.deviation * 1000) / 10,
      Math.round(e.zScore * 100) / 100, Math.round(e.pValue * 10000) / 10000, e.status
    ]);
  }

  const activeBoosters = minedEdges.filter(e => e.status === 'POSITIVE_BOOSTER').sort((a, b) => b.deviation - a.deviation);
  const activeDrags = minedEdges.filter(e => e.status === 'NEGATIVE_DRAG').sort((a, b) => a.deviation - b.deviation);

  console.log(`\nPOSITIVE_BOOSTER: ${activeBoosters.length}`);
  for (const e of activeBoosters) {
    console.log(`  ${e.setupType.padEnd(28)} ${e.dimension.padEnd(16)} ${e.segment.padEnd(20)} N=${e.n} WR=${(e.winRate*100).toFixed(1)}% base=${(e.baselineWinRate*100).toFixed(1)}% dev=+${(e.deviation*100).toFixed(1)}% p=${e.pValue.toFixed(4)}`);
  }
  console.log(`\nNEGATIVE_DRAG: ${activeDrags.length}`);
  for (const e of activeDrags) {
    console.log(`  ${e.setupType.padEnd(28)} ${e.dimension.padEnd(16)} ${e.segment.padEnd(20)} N=${e.n} WR=${(e.winRate*100).toFixed(1)}% base=${(e.baselineWinRate*100).toFixed(1)}% dev=${(e.deviation*100).toFixed(1)}% p=${e.pValue.toFixed(4)}`);
  }

  let md = `# Edge-Mining Report (${new Date().toISOString().slice(0, 10)})\n\n`;
  md += `Statistically significant edge shifts (N>=${MIN_N} both baseline and slice, p<0.05, |deviation|>=8%) across DAY_OF_WEEK/TIME_OF_DAY/OR_SIZE/TREND_ALIGNMENT.\n\n`;
  md += `## Positive Boosters\n\n| Setup | Dimension | Segment | N | WR% | Baseline % | Deviation | p-value |\n| :-- | :-- | :-- | --: | --: | --: | --: | --: |\n`;
  for (const e of activeBoosters) md += `| ${e.setupType} | ${e.dimension} | ${e.segment} | ${e.n} | ${(e.winRate*100).toFixed(1)}% | ${(e.baselineWinRate*100).toFixed(1)}% | +${(e.deviation*100).toFixed(1)}% | ${e.pValue.toFixed(4)} |\n`;
  md += `\n## Negative Drags\n\n| Setup | Dimension | Segment | N | WR% | Baseline % | Deviation | p-value |\n| :-- | :-- | :-- | --: | --: | --: | --: | --: |\n`;
  for (const e of activeDrags) md += `| ${e.setupType} | ${e.dimension} | ${e.segment} | ${e.n} | ${(e.winRate*100).toFixed(1)}% | ${(e.baselineWinRate*100).toFixed(1)}% | ${(e.deviation*100).toFixed(1)}% | ${e.pValue.toFixed(4)} |\n`;
  fs.writeFileSync('scratch/edge_miner_report.md', md);
  console.log('\nReport written to scratch/edge_miner_report.md');

  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
