import pg from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { computeProfile } from '../server/services/developingValueService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'trading_journal',
  user: process.env.DB_USER || 'trader',
  password: process.env.DB_PASSWORD || 'trader123',
});

const query = (text, params) => pool.query(text, params);

async function main() {
  console.log('🚀 Comparing Intraday POC ROC vs 2-Day POC Streak...');

  // 1. Fetch resolved setups
  const setupsQ = await query(`
    SELECT s.id, s.setup_type as type, s.resolution, s.actual_pnl::float as pnl, s.trade_date::text as d,
      s.entry_zone_low::float as entry, s.stop_level::float as stop, s.t1_level::float as t1,
      CASE WHEN s.setup_type LIKE '%LONG%' OR s.setup_type LIKE '%BULLISH%' OR s.setup_type LIKE '%_UP' THEN 'LONG' ELSE 'SHORT' END as dir,
      (EXTRACT(hour FROM s.fired_at)*60+EXTRACT(minute FROM s.fired_at))::int as fired_min
    FROM active_setups s
    WHERE s.resolution IN ('TARGET_HIT','STOP_HIT') AND s.entry_zone_low IS NOT NULL AND s.fired_at IS NOT NULL
    ORDER BY s.trade_date, s.fired_at
  `);
  const setups = setupsQ.rows;

  // 2. Fetch developing value log rows for history and prior POC
  const dvQ = await query(`
    SELECT trade_date::text as d, poc::float, migration_dir_vs_prior as mig FROM developing_value_log ORDER BY trade_date
  `);
  const dvRows = dvQ.rows;
  
  const priorPocMap = {};
  const twoDayStreakMap = {};

  for (let i = 2; i < dvRows.length; i++) {
    priorPocMap[dvRows[i].d] = dvRows[i-1].poc;
    
    // Calculate 2-Day Streak prior to this day
    const prev1 = dvRows[i-1].mig;
    const prev2 = dvRows[i-2].mig;
    if (prev1 === 'HIGHER' && prev2 === 'HIGHER') {
      twoDayStreakMap[dvRows[i].d] = 'HIGHER';
    } else if (prev1 === 'LOWER' && prev2 === 'LOWER') {
      twoDayStreakMap[dvRows[i].d] = 'LOWER';
    } else {
      twoDayStreakMap[dvRows[i].d] = null;
    }
  }

  // 3. Fetch 1-min NQ price bars
  const uniqueDates = [...new Set(setups.map(s => s.d))];
  const barsQ = await query(`
    SELECT ts::date::text as d, (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts))::int as et_min,
      open::float, high::float, low::float, close::float, volume::float
    FROM price_bars_primary
    WHERE symbol='NQ' AND ts::date = ANY($1)
      AND (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts)) BETWEEN 570 AND 959
    ORDER BY ts
  `, [uniqueDates]);
  
  const barsByDate = {};
  for (const b of barsQ.rows) {
    (barsByDate[b.d] ??= []).push(b);
  }

  // 4. Compute metrics for each setup
  const processedSetups = [];
  for (const s of setups) {
    const priorPoc = priorPocMap[s.d];
    if (priorPoc === undefined) continue;
    const dayBars = barsByDate[s.d] || [];
    if (dayBars.length === 0) continue;

    const barsUpToFired = dayBars.filter(b => b.et_min <= s.fired_min);
    if (barsUpToFired.length < 5) continue;

    const profile = computeProfile(barsUpToFired);
    if (!profile || !profile.poc) continue;

    const devPoc = profile.poc;
    const pocShift = devPoc - priorPoc;
    const minsSinceOpen = Math.max(1, s.fired_min - 570);
    const hoursSinceOpen = minsSinceOpen / 60;
    const pocRoc = pocShift / hoursSinceOpen;

    processedSetups.push({
      ...s,
      pocRoc,
      twoDayStreak: twoDayStreakMap[s.d] || null,
    });
  }

  // 5. Compare setup performance
  const setupTypes = ['C_STANDALONE_DOWN', 'IB_BEARISH', 'IB_BULLISH', 'VALUE_AREA_RESPONSIVE_LONG', 'VALUE_AREA_RESPONSIVE_SHORT'];
  
  let markdown = '# Comparative Analysis: Intraday POC ROC vs 2-Day POC Streak\n\n';
  markdown += 'This analysis evaluates the performance of setups under three filter conditions:\n';
  markdown += '1. **2-Day POC Streak Filter (Historical)**: Aligned with the consecutive direction of the prior 2 completed sessions.\n';
  markdown += '2. **Intraday POC ROC Filter (Live)**: Aligned with today\'s developing value migration speed ($|\\text{POC ROC}| > 15\\text{ pts/hr}$).\n';
  markdown += '3. **Combined Filter**: Aligned with both the 2-day streak and the intraday migration speed.\n\n';

  for (const type of setupTypes) {
    const subset = processedSetups.filter(s => s.type === type);
    if (subset.length === 0) continue;

    const baseWins = subset.filter(s => s.resolution === 'TARGET_HIT').length;
    const baseLosses = subset.filter(s => s.resolution === 'STOP_HIT').length;
    const baseWR = (baseWins / (baseWins + baseLosses)) * 100;

    // A. 2-Day Streak Aligned vs Counter
    const streakAligned = subset.filter(s => (s.dir === 'LONG' && s.twoDayStreak === 'HIGHER') || (s.dir === 'SHORT' && s.twoDayStreak === 'LOWER'));
    const streakAlignedWins = streakAligned.filter(s => s.resolution === 'TARGET_HIT').length;
    const streakAlignedWR = streakAligned.length > 0 ? (streakAlignedWins / streakAligned.length) * 100 : null;

    const streakCounter = subset.filter(s => (s.dir === 'LONG' && s.twoDayStreak === 'LOWER') || (s.dir === 'SHORT' && s.twoDayStreak === 'HIGHER'));
    const streakCounterWins = streakCounter.filter(s => s.resolution === 'TARGET_HIT').length;
    const streakCounterWR = streakCounter.length > 0 ? (streakCounterWins / streakCounter.length) * 100 : null;

    // B. Intraday ROC Aligned vs Counter (using 15 pts/hr as threshold)
    const rocAligned = subset.filter(s => (s.dir === 'LONG' && s.pocRoc > 15) || (s.dir === 'SHORT' && s.pocRoc < -15));
    const rocAlignedWins = rocAligned.filter(s => s.resolution === 'TARGET_HIT').length;
    const rocAlignedWR = rocAligned.length > 0 ? (rocAlignedWins / rocAligned.length) * 100 : null;

    const rocCounter = subset.filter(s => (s.dir === 'LONG' && s.pocRoc < -15) || (s.dir === 'SHORT' && s.pocRoc > 15));
    const rocCounterWins = rocCounter.filter(s => s.resolution === 'TARGET_HIT').length;
    const rocCounterWR = rocCounter.length > 0 ? (rocCounterWins / rocCounter.length) * 100 : null;

    // C. Combined Aligned
    const combinedAligned = subset.filter(s => 
      ((s.dir === 'LONG' && s.twoDayStreak === 'HIGHER' && s.pocRoc > 15) || 
       (s.dir === 'SHORT' && s.twoDayStreak === 'LOWER' && s.pocRoc < -15))
    );
    const combinedAlignedWins = combinedAligned.filter(s => s.resolution === 'TARGET_HIT').length;
    const combinedAlignedWR = combinedAligned.length > 0 ? (combinedAlignedWins / combinedAligned.length) * 100 : null;

    markdown += `### 🏷️ Setup: \`${type}\` (Total: ${subset.length}, Baseline WR: ${baseWR.toFixed(1)}%)\n\n`;
    markdown += '| Filter Regime | Sample (N) | Target Hit | Stop Hit | Win Rate (%) | Shift vs. Baseline |\n';
    markdown += '| :--- | :---: | :---: | :---: | :---: | :---: |\n';
    markdown += `| **Baseline (Unfiltered)** | ${subset.length} | ${baseWins} | ${baseLosses} | **${baseWR.toFixed(1)}%** | - |\n`;
    markdown += `| **2-Day Streak Aligned** | ${streakAligned.length} | ${streakAlignedWins} | ${streakAligned.length - streakAlignedWins} | **${streakAlignedWR !== null ? streakAlignedWR.toFixed(1) + '%' : 'N/A'}** | ${streakAlignedWR !== null ? (streakAlignedWR - baseWR).toFixed(1) + '%' : '-'} |\n`;
    markdown += `| **2-Day Streak Counter (Block)** | ${streakCounter.length} | ${streakCounterWins} | ${streakCounter.length - streakCounterWins} | **${streakCounterWR !== null ? streakCounterWR.toFixed(1) + '%' : 'N/A'}** | ${streakCounterWR !== null ? (streakCounterWR - baseWR).toFixed(1) + '%' : '-'} |\n`;
    markdown += `| **Intraday POC ROC Aligned** | ${rocAligned.length} | ${rocAlignedWins} | ${rocAligned.length - rocAlignedWins} | **${rocAlignedWR !== null ? rocAlignedWR.toFixed(1) + '%' : 'N/A'}** | ${rocAlignedWR !== null ? (rocAlignedWR - baseWR).toFixed(1) + '%' : '-'} |\n`;
    markdown += `| **Intraday POC ROC Counter (Block)** | ${rocCounter.length} | ${rocCounterWins} | ${rocCounter.length - rocCounterWins} | **${rocCounterWR !== null ? rocCounterWR.toFixed(1) + '%' : 'N/A'}** | ${rocCounterWR !== null ? (rocCounterWR - baseWR).toFixed(1) + '%' : '-'} |\n`;
    markdown += `| **Combined (2-Day + Intraday Aligned)** | ${combinedAligned.length} | ${combinedAlignedWins} | ${combinedAligned.length - combinedAlignedWins} | **${combinedAlignedWR !== null ? combinedAlignedWR.toFixed(1) + '%' : 'N/A'}** | ${combinedAlignedWR !== null ? (combinedAlignedWR - baseWR).toFixed(1) + '%' : '-'} |\n\n`;
  }

  const artifactPath = '/home/mmoniz/.gemini/antigravity-cli/brain/b1a5a88c-b280-410c-85a7-2921d711bb19/poc_filter_comparison.md';
  const fs = await import('fs');
  fs.writeFileSync(artifactPath, markdown);
  console.log(`Saved comparison report to: ${artifactPath}`);

  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
});
