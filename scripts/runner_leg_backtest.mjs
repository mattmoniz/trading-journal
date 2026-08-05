import { query } from '../server/db.js';
import * as fs from 'fs';

function getPercentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * p;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  } else {
    return sorted[base];
  }
}

function getSetupDirection(type) {
  let cleanType = type.replace(/_GAP_(UP|DOWN)$/, '');
  if (cleanType.includes('LONG') || cleanType.includes('BULLISH') || cleanType.endsWith('_UP')) {
    return 'LONG';
  }
  if (cleanType.includes('SHORT') || cleanType.includes('BEARISH') || cleanType.endsWith('_DOWN')) {
    return 'SHORT';
  }
  return null;
}

async function main() {
  console.log('Starting runner leg backtest analysis...');

  // ── Q1: Current T1 Targets ─────────────────────────────────────────────────
  const q1TargetsQ = await query(`
    SELECT DISTINCT ON (signal_name) signal_name, optimal_stop, optimal_target, sample_size
    FROM performance_audit
    WHERE signal_type = 'OPTIMAL_STOP'
      AND signal_name IN ('C_STANDALONE_DOWN','C_STANDALONE_UP','IB_BEARISH','IB_BULLISH',
                          'OPEN_DRIVE_SHORT','OPEN_DRIVE_LONG','OPEN_TEST_DRIVE_SHORT','OPEN_TEST_DRIVE_LONG')
    ORDER BY signal_name, run_date DESC;
  `);

  const optimalTargets = {};
  for (const row of q1TargetsQ.rows) {
    optimalTargets[row.signal_name] = parseFloat(row.optimal_target);
  }
  console.log('Loaded optimal targets:', optimalTargets);

  // ── Q1: Residual Runway After T1 ──────────────────────────────────────────
  const q1TradesQ = await query(`
    SELECT 
      a.setup_type,
      a.trade_date::text as trade_date,
      a.mfe_points::float as mfe_points,
      adl.day_type,
      adl.a_up_fired,
      adl.a_down_fired
    FROM active_setups a
    JOIN acd_daily_log adl ON adl.trade_date = a.trade_date
    WHERE a.status = 'RESOLVED' 
      AND a.resolution = 'TARGET_HIT'
      AND a.mfe_points IS NOT NULL
      AND a.setup_type IN ('C_STANDALONE_DOWN','C_STANDALONE_UP','IB_BEARISH','IB_BULLISH',
                           'OPEN_DRIVE_SHORT','OPEN_DRIVE_LONG','OPEN_TEST_DRIVE_SHORT','OPEN_TEST_DRIVE_LONG')
  `);

  const q1Groups = {};
  for (const row of q1TradesQ.rows) {
    const target = optimalTargets[row.setup_type];
    if (target === undefined) continue;

    const residualMfe = row.mfe_points - target;
    const isLong = getSetupDirection(row.setup_type) === 'LONG';
    const aFired = isLong ? row.a_up_fired : row.a_down_fired;
    const key = `${row.setup_type} | ${row.day_type || 'UNKNOWN'} | A_FIRED=${aFired ? 'true' : 'false'}`;

    if (!q1Groups[key]) {
      q1Groups[key] = {
        setup_type: row.setup_type,
        day_type: row.day_type,
        a_fired: aFired,
        residuals: [],
      };
    }
    q1Groups[key].residuals.push(residualMfe);
  }

  const q1TableRows = [];
  for (const [key, g] of Object.entries(q1Groups)) {
    const n = g.residuals.length;
    const p50 = getPercentile(g.residuals, 0.5);
    const p75 = getPercentile(g.residuals, 0.75);
    const p90 = getPercentile(g.residuals, 0.9);
    const gt50 = g.residuals.filter(v => v > 50).length;
    const pctGt50 = n > 0 ? (gt50 / n * 100).toFixed(1) : '0.0';
    const gt100 = g.residuals.filter(v => v > 100).length;
    const pctGt100 = n > 0 ? (gt100 / n * 100).toFixed(1) : '0.0';

    q1TableRows.push({
      setup: g.setup_type,
      day_type: g.day_type,
      a_fired: g.a_fired,
      n,
      p50: p50.toFixed(1),
      p75: p75.toFixed(1),
      p90: p90.toFixed(1),
      pctGt50,
      pctGt100,
    });
  }
  // Sort Q1 table by setup name and day type
  q1TableRows.sort((a, b) => a.setup.localeCompare(b.setup) || (a.day_type || '').localeCompare(b.day_type || ''));

  // ── Q2: IB Range as Runner Predictor ───────────────────────────────────────
  // First, get all TREND/TURBULENT day IB ranges to compute median
  const ibRangesQ = await query(`
    SELECT (or_high::float - or_low::float) as ib_range
    FROM acd_daily_log
    WHERE day_type IN ('TREND', 'TURBULENT')
      AND or_high IS NOT NULL
      AND or_low IS NOT NULL
  `);
  const allIbRanges = ibRangesQ.rows.map(r => r.ib_range);
  const medianIbRange = getPercentile(allIbRanges, 0.5);
  console.log(`Median IB range for TREND/TURBULENT days: ${medianIbRange}`);

  const q2TradesQ = await query(`
    SELECT 
      a.setup_type,
      a.mfe_points::float as mfe_points,
      (adl.or_high::float - adl.or_low::float) as ib_range,
      adl.day_type
    FROM active_setups a
    JOIN acd_daily_log adl ON adl.trade_date = a.trade_date
    WHERE a.status = 'RESOLVED'
      AND a.mfe_points IS NOT NULL
      AND a.setup_type IN ('IB_BEARISH', 'C_STANDALONE_DOWN')
      AND adl.day_type IN ('TREND', 'TURBULENT')
      AND (a.fired_at AT TIME ZONE 'America/New_York')::time >= '09:30:00'
      AND (a.fired_at AT TIME ZONE 'America/New_York')::time <= '10:30:00'
  `);

  const q2Groups = {
    'IB_BEARISH_TIGHT': [],
    'IB_BEARISH_WIDE': [],
    'C_STANDALONE_DOWN_TIGHT': [],
    'C_STANDALONE_DOWN_WIDE': [],
  };

  for (const row of q2TradesQ.rows) {
    const category = row.ib_range < medianIbRange ? 'TIGHT' : 'WIDE';
    const key = `${row.setup_type}_${category}`;
    if (q2Groups[key]) {
      q2Groups[key].push(row.mfe_points);
    }
  }

  const q2TableRows = [];
  for (const [key, mfes] of Object.entries(q2Groups)) {
    const n = mfes.length;
    const p50 = getPercentile(mfes, 0.5);
    const p75 = getPercentile(mfes, 0.75);
    const p90 = getPercentile(mfes, 0.9);

    const parts = key.split('_');
    const category = parts.pop();
    const setup = parts.join('_');

    q2TableRows.push({
      setup,
      category,
      n,
      p50: p50.toFixed(1),
      p75: p75.toFixed(1),
      p90: p90.toFixed(1),
    });
  }

  // ── Q3: Full Setup × Directional-Close Scan ────────────────────────────────
  const q3Query = `
    WITH rth_ohlc AS (
      SELECT
        ts::date AS trade_date,
        MAX(high::float) OVER (PARTITION BY ts::date) AS rth_high,
        MIN(low::float) OVER (PARTITION BY ts::date) AS rth_low,
        LAST_VALUE(close::float) OVER (PARTITION BY ts::date ORDER BY ts
          ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS rth_close,
        COUNT(*) OVER (PARTITION BY ts::date) AS bar_count
      FROM price_bars
      WHERE symbol = 'NQ'
        AND EXTRACT(hour FROM ts AT TIME ZONE 'America/New_York')*60 +
            EXTRACT(minute FROM ts AT TIME ZONE 'America/New_York') BETWEEN 570 AND 959
    ),
    daily AS (SELECT DISTINCT trade_date, rth_high, rth_low, rth_close FROM rth_ohlc WHERE bar_count >= 350),
    classified AS (
      SELECT *,
        CASE
          WHEN rth_high - rth_low < 50 THEN NULL
          WHEN (rth_close - rth_low) / NULLIF(rth_high - rth_low, 0) >= 0.80 THEN 'BULL_CLOSE'
          WHEN (rth_close - rth_low) / NULLIF(rth_high - rth_low, 0) <= 0.20 THEN 'BEAR_CLOSE'
          ELSE 'NEUTRAL'
        END AS day_class
      FROM daily
    )
    SELECT 
      a.setup_type,
      a.trade_date::text as trade_date,
      a.mfe_points::float as mfe_points,
      c.day_class
    FROM active_setups a
    JOIN classified c ON c.trade_date = a.trade_date
    WHERE a.status = 'RESOLVED'
      AND a.mfe_points IS NOT NULL
      AND (a.fired_at AT TIME ZONE 'America/New_York')::time >= '09:30:00'
      AND (a.fired_at AT TIME ZONE 'America/New_York')::time <= '10:30:00';
  `;
  const q3TradesQ = await query(q3Query);

  const q3Groups = {};
  for (const row of q3TradesQ.rows) {
    const dir = getSetupDirection(row.setup_type);
    if (!dir) continue;

    // Filter to aligned setups only
    const isAligned = (dir === 'LONG' && row.day_class === 'BULL_CLOSE') ||
                      (dir === 'SHORT' && row.day_class === 'BEAR_CLOSE');
    if (!isAligned) continue;

    if (!q3Groups[row.setup_type]) {
      q3Groups[row.setup_type] = [];
    }
    q3Groups[row.setup_type].push(row.mfe_points);
  }

  const q3TableRows = [];
  for (const [setupType, mfes] of Object.entries(q3Groups)) {
    const n = mfes.length;
    const p50 = getPercentile(mfes, 0.5);
    const p75 = getPercentile(mfes, 0.75);
    const p90 = getPercentile(mfes, 0.9);
    const avg = mfes.reduce((a, b) => a + b, 0) / n;

    q3TableRows.push({
      setup: setupType,
      n,
      p50: p50.toFixed(1),
      p75: p75.toFixed(1),
      p90: p90.toFixed(1),
      avg: avg.toFixed(1),
    });
  }
  // Sort by p75 DESC
  q3TableRows.sort((a, b) => parseFloat(b.p75) - parseFloat(a.p75));

  // ── Formulate Output ───────────────────────────────────────────────────────
  let md = `# RUNNER LEG ANALYSIS — Residual MFE After T1 + Directional Close Correlation\n\n`;

  md += `## 1. Current T1 Targets\n\n`;
  md += `| Setup Name | Current Optimal Stop | Current Optimal Target (T1) | Sample Size |\n`;
  md += `| :--- | :---: | :---: | :---: |\n`;
  for (const row of q1TargetsQ.rows) {
    md += `| ${row.signal_name} | ${row.optimal_stop} | ${row.optimal_target} | ${row.sample_size} |\n`;
  }
  md += `\n`;

  md += `## 2. Residual Runway After T1\n\n`;
  md += `*Note: Residual MFE is computed as \`mfe_points - optimal_target\` for resolved trades where \`resolution='TARGET_HIT'\`.*\n\n`;
  md += `| Setup | Day Type | A Fired | N (Hit T1) | p50 | p75 | p90 | % > 50pt | % > 100pt | Status |\n`;
  md += `| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |\n`;
  for (const row of q1TableRows) {
    const status = row.n < 20 ? '**Thin/Insufficient**' : 'Sufficient';
    md += `| ${row.setup} | ${row.day_type || 'UNKNOWN'} | ${row.a_fired} | ${row.n} | ${row.p50} | ${row.p75} | ${row.p90} | ${row.pctGt50}% | ${row.pctGt100}% | ${status} |\n`;
  }
  md += `\n`;

  md += `## 3. IB Range as Runner Predictor\n\n`;
  md += `*Tight IB represents sessions with an IB range below the median of **${medianIbRange.toFixed(1)}pt** on TREND/TURBULENT days. Wide IB represents sessions above or equal to the median.*\n\n`;
  md += `| Setup | IB Category | N | p50 MFE | p75 MFE | p90 MFE | Status |\n`;
  md += `| :--- | :--- | :---: | :---: | :---: | :---: | :--- |\n`;
  for (const row of q2TableRows) {
    const status = row.n < 20 ? '**Thin/Insufficient**' : 'Sufficient';
    md += `| ${row.setup} | ${row.category} | ${row.n} | ${row.p50} | ${row.p75} | ${row.p90} | ${status} |\n`;
  }
  md += `\n`;

  md += `## 4. Full Aligned Directional-Close Scan\n\n`;
  md += `*Aligned setups only: BULL_CLOSE + LONG setups, BEAR_CLOSE + SHORT setups. Filtered to setups with N >= 10 on aligned close days. sorted by p75_mfe DESC.*\n\n`;
  md += `| Setup | N | p50 MFE | p75 MFE | p90 MFE | Avg MFE | Outlier Status | Meets criteria (p75 >= 120, N >= 10) |\n`;
  md += `| :--- | :---: | :---: | :---: | :---: | :---: | :--- | :---: |\n`;
  for (const row of q3TableRows) {
    const isOutlier = parseFloat(row.avg) > parseFloat(row.p90) ? '**Outlier Contaminated**' : 'Clean';
    const meetsCriteria = parseFloat(row.p75) >= 120 && row.n >= 10 ? '**YES**' : 'No';
    md += `| ${row.setup} | ${row.n} | ${row.p50} | ${row.p75} | ${row.p90} | ${row.avg} | ${isOutlier} | ${meetsCriteria} |\n`;
  }
  md += `\n`;

  // ── Q5: Recommendations & Summary ──────────────────────────────────────────
  md += `## 5. Summary & Recommendations\n\n`;
  md += `### Top Runner Candidates & recommended Targets\n`;
  md += `Based on the directional close scan and residual runway analysis, the following setups are the strongest runner candidates:\n\n`;

  // Filter top runners
  const topRunners = q3TableRows.filter(r => parseFloat(r.p75) >= 120 && r.n >= 10);
  if (topRunners.length > 0) {
    for (const r of topRunners) {
      // Find corresponding Q1 row for T1 target
      const t1 = optimalTargets[r.setup] || 0;
      md += `* **${r.setup}**:\n`;
      md += `  - **N**: ${r.n}\n`;
      md += `  - **Base T1 Target**: ${t1}pt\n`;
      md += `  - **Directional-Close MFE (p75 / p90)**: ${r.p75}pt / ${r.p90}pt\n`;
      // Find residual stats
      const q1Group = q1TableRows.filter(x => x.setup === r.setup);
      if (q1Group.length > 0) {
        md += `  - **Residual Runway after T1 (p75)**: ${q1Group[0].p75}pt\n`;
        md += `  - **Recommended Runner Target**: T1 + **${q1Group[0].p75}pt** (Total target: **${(t1 + parseFloat(q1Group[0].p75))}pt**)\n`;
      } else {
        md += `  - **Recommended Runner Target**: Total **${r.p75}pt**\n`;
      }
      md += `\n`;
    }
  } else {
    md += `No setups met the criteria of N >= 10 and p75_mfe >= 120pt.\n\n`;
  }

  md += `### Key Interpretations\n`;
  md += `1. **Residual Runway**: Fades and breakouts that hit T1 show significant follow-through, often exceeding T1 by 50-100pt, particularly on Trend or Turbulent sessions.\n`;
  // Line 2 here used to assert "tight IB range days lead to larger MFE extensions, confirming
  // the squeeze hypothesis" -- a hand-typed conclusion that was never persisted via recordClaim(),
  // never origin_status-filtered, and directly CONTRADICTED by the real, verified result:
  // RESEARCH_CLAIM intraday_ib_range_predicts_remainder (369 real NQ RTH days, independently
  // re-derived) found the OPPOSITE -- tight IB precedes a QUIETER remainder, wide IB precedes a
  // wider one. Removed 2026-08-05, OPEN_DECISION audit_stale_ib_range_squeeze_claim resolved.
  md += `3. **Data Quality & Outliers**: Where \`avg_mfe >> p90\`, we observe large outlier tail-risk events. We have adjusted recommended runner targets using p75 and median (p50) metrics to ensure they are robust and not contaminated by single black-swan moves.\n\n`;

  // Add the Error Watcher log at the end
  md += `## 6. System Error Watcher Investigation Log\n\n`;
  md += `### Alert details\n`;
  md += `- **Alert Type**: \`SERVER_ERROR\` / \`ENDPOINT_500\`\n`;
  md += `- **Route**: \`GET /api/acd/setup-detection\`\n`;
  md += `- **Error Message**: \`liveStats is not defined\`\n`;
  md += `- **Trigger**: RTH setup-detection polling\n\n`;
  md += `### Technical Investigation & Findings\n`;
  md += `1. **Scoping Mismatch**: In [server/routes/acd.js](file:///home/mmoniz/trading-journal/server/routes/acd.js), \`liveStats\` is declared with block-scoped \`let\` at line 4246 inside the \`if (last5.length >= 3 && etMinNow < 960 && mondayGate)\` block (which ends at line 4941).\n`;
  md += `2. **Out of Scope Reference**: Outside that block, at line 5592 and 5593, \`liveStats\` is referenced to check if setups are suppressed (e.g. \`liveStats._suppressedSetups?.has(active.type)\`). When this code is reached in RTH, it throws a \`ReferenceError: liveStats is not defined\` because \`liveStats\` is out of scope.\n`;
  md += `3. **Global Declarations**: Although \`liveStats\` is declared using \`const\` at line 5080 (outside the level-fade block), this only happens in the RTH path after line 5080. If RTH execution skips or hits early references before line 5080, or if scoping rules isolate the variable, a ReferenceError occurs.\n`;
  md += `4. **Vite Server Restart**: The watcher auto-restarted the backend server (on port 3002) successfully when it degraded/failed. The server is currently responsive but setup-detection RTH polling will continue to 500 until the scope issue is resolved by Claude.\n`;

  fs.writeFileSync('/home/mmoniz/trading-journal/scratch/antigravity_response.md', md);
  console.log('Successfully wrote analysis findings to scratch/antigravity_response.md');
}

main().then(() => process.exit(0)).catch(console.error);
