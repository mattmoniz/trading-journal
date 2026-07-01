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
  console.log('🚀 Starting POC Rate of Change (ROC) Backtest...');

  // 1. Fetch all resolved setups
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
  console.log(`Loaded ${setups.length} setups from database.`);

  if (setups.length === 0) {
    console.log('No setups to backtest.');
    await pool.end();
    return;
  }

  // 2. Fetch all developing value log rows to find the prior day's POC
  const dvQ = await query(`
    SELECT trade_date::text as d, poc::float FROM developing_value_log ORDER BY trade_date
  `);
  const dvRows = dvQ.rows;
  const priorPocMap = {};
  for (let i = 1; i < dvRows.length; i++) {
    priorPocMap[dvRows[i].d] = dvRows[i-1].poc;
  }
  console.log(`Mapped prior day POCs for ${Object.keys(priorPocMap).length} dates.`);

  // 3. Fetch 1-min NQ price bars grouped by date
  const uniqueDates = [...new Set(setups.map(s => s.d))];
  console.log(`Fetching 1-min bars for ${uniqueDates.length} unique days...`);

  // We load price bars in chunks or all at once since the dataset might be large.
  // Querying for all dates present in our setups.
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
  console.log(`Loaded bars for ${Object.keys(barsByDate).length} dates.`);

  // 4. Compute POC ROC for each setup
  const processedSetups = [];
  let noBarsCount = 0;
  let noPriorPocCount = 0;

  for (const s of setups) {
    const priorPoc = priorPocMap[s.d];
    if (priorPoc === undefined) {
      noPriorPocCount++;
      continue;
    }
    const dayBars = barsByDate[s.d] || [];
    if (dayBars.length === 0) {
      noBarsCount++;
      continue;
    }

    // Filter bars up to the fired_min of the setup
    const barsUpToFired = dayBars.filter(b => b.et_min <= s.fired_min);
    if (barsUpToFired.length < 5) {
      continue; // Not enough bars to compute a profile
    }

    // Compute developing POC at the time of the setup
    const profile = computeProfile(barsUpToFired);
    if (!profile || !profile.poc) {
      continue;
    }

    const devPoc = profile.poc;
    const pocShift = devPoc - priorPoc;
    const minsSinceOpen = Math.max(1, s.fired_min - 570);
    const hoursSinceOpen = minsSinceOpen / 60;
    const pocRoc = pocShift / hoursSinceOpen; // points shifted per hour

    processedSetups.push({
      ...s,
      devPoc,
      priorPoc,
      pocShift,
      pocRoc,
      absPocRoc: Math.abs(pocRoc),
    });
  }

  console.log(`Processed ${processedSetups.length} setups. (Skipped: ${noPriorPocCount} due to no prior POC, ${noBarsCount} due to no price bars)`);

  // 5. Run analysis at different POC ROC thresholds (e.g. 10, 20, 30 points/hour)
  const thresholds = [10, 20, 30, 45];
  const setupTypes = [...new Set(processedSetups.map(s => s.type))].sort();

  console.log('\n=== POC ROC Win Rate Shifts By Setup Type ===');

  const reportData = [];

  for (const type of setupTypes) {
    const typeSetups = processedSetups.filter(s => s.type === type);
    if (typeSetups.length < 10) continue; // Skip rare setups for statistics

    const baseWins = typeSetups.filter(s => s.resolution === 'TARGET_HIT').length;
    const baseLosses = typeSetups.filter(s => s.resolution === 'STOP_HIT').length;
    const baseWR = (baseWins / (baseWins + baseLosses)) * 100;
    const basePnl = typeSetups.reduce((sum, s) => sum + s.pnl, 0);
    const baseAvgPnl = basePnl / typeSetups.length;

    const row = {
      type,
      total: typeSetups.length,
      baseWR,
      baseAvgPnl,
      thresholds: {},
    };

    for (const thresh of thresholds) {
      // Low ROC group (Balanced / Stable value)
      const lowRoc = typeSetups.filter(s => s.absPocRoc <= thresh);
      const lowWins = lowRoc.filter(s => s.resolution === 'TARGET_HIT').length;
      const lowLosses = lowRoc.filter(s => s.resolution === 'STOP_HIT').length;
      const lowWR = lowRoc.length > 0 ? (lowWins / (lowWins + lowLosses)) * 100 : null;
      const lowPnl = lowRoc.reduce((sum, s) => sum + s.pnl, 0);
      const lowAvgPnl = lowRoc.length > 0 ? lowPnl / lowRoc.length : null;

      // High ROC group (Trending / Value migrating)
      const highRoc = typeSetups.filter(s => s.absPocRoc > thresh);
      const highWins = highRoc.filter(s => s.resolution === 'TARGET_HIT').length;
      const highLosses = highRoc.filter(s => s.resolution === 'STOP_HIT').length;
      const highWR = highRoc.length > 0 ? (highWins / (highWins + highLosses)) * 100 : null;
      const highPnl = highRoc.reduce((sum, s) => sum + s.pnl, 0);
      const highAvgPnl = highRoc.length > 0 ? highPnl / highRoc.length : null;

      // Aligned vs Counter POC ROC
      // If setup is LONG and POC ROC is positive (+), it is ALIGNED.
      // If setup is SHORT and POC ROC is negative (-), it is ALIGNED.
      // Else it is COUNTER.
      const aligned = typeSetups.filter(s => (s.dir === 'LONG' && s.pocRoc > thresh) || (s.dir === 'SHORT' && s.pocRoc < -thresh));
      const alignedWins = aligned.filter(s => s.resolution === 'TARGET_HIT').length;
      const alignedLosses = aligned.filter(s => s.resolution === 'STOP_HIT').length;
      const alignedWR = aligned.length > 0 ? (alignedWins / (alignedWins + alignedLosses)) * 100 : null;

      const counter = typeSetups.filter(s => (s.dir === 'LONG' && s.pocRoc < -thresh) || (s.dir === 'SHORT' && s.pocRoc > thresh));
      const counterWins = counter.filter(s => s.resolution === 'TARGET_HIT').length;
      const counterLosses = counter.filter(s => s.resolution === 'STOP_HIT').length;
      const counterWR = counter.length > 0 ? (counterWins / (counterWins + counterLosses)) * 100 : null;

      row.thresholds[thresh] = {
        lowN: lowRoc.length,
        lowWR,
        lowAvgPnl,
        highN: highRoc.length,
        highWR,
        highAvgPnl,
        alignedN: aligned.length,
        alignedWR,
        counterN: counter.length,
        counterWR,
      };
    }

    reportData.push(row);
  }

  // 6. Format and display results in Markdown format
  let markdown = '# POC Rate of Change (ROC) Migration Speed Analysis\n\n';
  markdown += 'This report analyzes the impact of the **intraday POC Rate of Change (POC ROC)** on different setup types. POC ROC measures how quickly value is shifting (in points per hour) between the regular trading hours (RTH) developing POC and the prior session\'s final POC:\n';
  markdown += '$$\\text{POC ROC} = \\frac{POC_{\\text{dev}} - POC_{\\text{prior}}}{\\text{hours since 9:30 AM ET}}$$\n\n';
  markdown += 'We group setups into:\n';
  markdown += '1. **Low ROC (Stable/Balanced)**: $|\\text{POC ROC}| \\le \\text{Threshold}$ (Range-bound or steady price consolidation).\n';
  markdown += '2. **High ROC (Value Migrating)**: $|\\text{POC ROC}| > \\text{Threshold}$ (Directional trend expansion or value migration).\n';
  markdown += '3. **Aligned Trend**: Long setups taken when POC is migrating up rapidly, or Short setups taken when POC is migrating down rapidly.\n';
  markdown += '4. **Counter Trend**: Long setups taken when POC is migrating down, or Short setups taken when POC is migrating up.\n\n';

  markdown += '## 📈 Summary of Setup Win Rates by POC ROC Thresholds\n\n';

  for (const row of reportData) {
    markdown += `### 🏷️ Setup: \`${row.type}\` (Total sample: ${row.total}, Baseline WR: ${row.baseWR.toFixed(1)}%, Avg P&L: $${row.baseAvgPnl.toFixed(2)})\n\n`;
    markdown += '| Threshold (pts/hr) | Low ROC N | Low ROC WR% | High ROC N | High ROC WR% | Aligned N | Aligned WR% | Counter N | Counter WR% |\n';
    markdown += '| :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |\n';

    for (const thresh of thresholds) {
      const t = row.thresholds[thresh];
      const lowWRStr = t.lowWR !== null ? `${t.lowWR.toFixed(1)}%` : 'N/A';
      const highWRStr = t.highWR !== null ? `${t.highWR.toFixed(1)}%` : 'N/A';
      const alignedWRStr = t.alignedWR !== null ? `${t.alignedWR.toFixed(1)}%` : 'N/A';
      const counterWRStr = t.counterWR !== null ? `${t.counterWR.toFixed(1)}%` : 'N/A';

      markdown += `| **${thresh} pts/hr** | ${t.lowN} | ${lowWRStr} | ${t.highN} | ${highWRStr} | ${t.alignedN} | ${alignedWRStr} | ${t.counterN} | ${counterWRStr} |\n`;
    }
    markdown += '\n';
  }

  // Write to artifacts
  const artifactPath = '/home/mmoniz/.gemini/antigravity-cli/brain/b1a5a88c-b280-410c-85a7-2921d711bb19/poc_roc_analysis.md';
  const fs = await import('fs');
  fs.writeFileSync(artifactPath, markdown);
  console.log(`Saved analysis to artifact: ${artifactPath}`);

  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
});
