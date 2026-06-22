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

async function main() {
  console.log('=== RUNNING OR MIDPOINT TOUCH/BOUNCE BACKTEST ===');

  // 1. Load Daily Sessions
  const dailyQ = await q(`
    SELECT trade_date::text, or_high::float as or_high, or_low::float as or_low,
           daily_score::float as daily_score, day_type
    FROM acd_daily_log
    WHERE or_high IS NOT NULL AND or_low IS NOT NULL
    ORDER BY trade_date
  `);
  const sessions = dailyQ.rows;
  console.log(`Loaded ${sessions.length} daily logs.`);

  // 2. Load Developing Value
  const dvQ = await q(`
    SELECT trade_date::text, vah::float as vah, val::float as val, poc::float as poc
    FROM developing_value_log
  `);
  const dvMap = new Map(dvQ.rows.map(r => [r.trade_date, r]));

  // 3. Load Price Bars
  console.log('Loading price bars (RTH)...');
  const minDate = sessions[0].trade_date;
  const maxDate = sessions[sessions.length - 1].trade_date;
  const barsQ = await q(`
    SELECT ts::date::text as d,
           (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts))::int as et_min,
           open::float, high::float, low::float, close::float,
           COALESCE(volume, 0)::int as volume
    FROM price_bars
    WHERE symbol='NQ' AND ts::date BETWEEN $1 AND $2
      AND (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts)) BETWEEN 570 AND 960
    ORDER BY ts
  `, [minDate, maxDate]);

  const barsByDate = {};
  for (const b of barsQ.rows) {
    (barsByDate[b.d] ??= []).push(b);
  }
  console.log(`Loaded bars for ${Object.keys(barsByDate).length} sessions.`);

  const allTrades = [];

  for (const sess of sessions) {
    const d = sess.trade_date;
    const dayBars = barsByDate[d] || [];
    if (dayBars.length < 100) continue;

    const pd1 = dvMap.get(d) || null;
    const pdVAH = pd1?.vah ?? null;
    const pdVAL = pd1?.val ?? null;
    const pdPOC = pd1?.poc ?? null;

    // A. Define OR5 and OR10
    const or5Bars = dayBars.filter(b => b.et_min >= 570 && b.et_min <= 574);
    const or10Bars = dayBars.filter(b => b.et_min >= 570 && b.et_min <= 579);

    if (or5Bars.length < 5 || or10Bars.length < 10) continue;

    const or5H = Math.max(...or5Bars.map(b => b.high));
    const or5L = Math.min(...or5Bars.map(b => b.low));
    const or5Mid = (or5H + or5L) / 2;
    const or5Range = or5H - or5L;

    const or10H = Math.max(...or10Bars.map(b => b.high));
    const or10L = Math.min(...or10Bars.map(b => b.low));
    const or10Mid = (or10H + or10L) / 2;
    const or10Range = or10H - or10L;

    // Running VWAP
    const runningVwap = [];
    let cumPV = 0, cumV = 0;
    for (const b of dayBars) {
      const tp = (b.high + b.low + b.close) / 3;
      cumPV += tp * (b.volume || 1);
      cumV += (b.volume || 1);
      runningVwap.push(cumV > 0 ? cumPV / cumV : null);
    }

    // Proximity to levels helper (within 15 pts)
    const levelNear = (px, lvl) => lvl != null && Math.abs(px - lvl) <= 15;

    // Trade tracking for both midpoint setups
    const setups = [
      { name: 'OR5_MID', mid: or5Mid, startMin: 575, orHigh: or5H, orLow: or5L, orRange: or5Range },
      { name: 'OR10_MID', mid: or10Mid, startMin: 580, orHigh: or10H, orLow: or10L, orRange: or10Range },
    ];

    for (const setup of setups) {
      let triggered = false;
      const targetMid = setup.mid;

      for (let i = 0; i < dayBars.length; i++) {
        const bar = dayBars[i];
        if (bar.et_min < setup.startMin) continue;

        // Check for touch
        const touched = bar.low <= targetMid && bar.high >= targetMid;
        if (touched && !triggered) {
          // Determine approach direction
          let approach = null;
          for (let j = i - 1; j >= 0; j--) {
            if (dayBars[j].close > targetMid + 1) { approach = 'ABOVE'; break; }
            if (dayBars[j].close < targetMid - 1) { approach = 'BELOW'; break; }
          }

          if (approach) {
            triggered = true;
            const direction = approach === 'ABOVE' ? 'LONG' : 'SHORT';
            const entry = targetMid;
            const timeOfDay = bar.et_min < 690 ? 'morning' : bar.et_min < 810 ? 'midday' : 'afternoon';
            const dayOfWeek = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(d + 'T00:00:00Z').getUTCDay()];
            const orRangeType = setup.orRange < 47.5 ? 'TIGHT' : setup.orRange > 91.5 ? 'WIDE' : 'NORMAL';

            // Confluences at entry
            const vwap = runningVwap[i];
            const confluences = [];
            if (levelNear(entry, pdVAH)) confluences.push('PD_VAH');
            if (levelNear(entry, pdVAL)) confluences.push('PD_VAL');
            if (levelNear(entry, pdPOC)) confluences.push('PD_POC');
            if (levelNear(entry, vwap)) confluences.push('VWAP');

            // Bias alignment
            const dailyScore = sess.daily_score != null ? Number(sess.daily_score) : 0;
            const isAlignedWithBias = (direction === 'LONG' && dailyScore > 0) || (direction === 'SHORT' && dailyScore < 0);

            // Simulate the 3 exit configurations
            const remainingBars = dayBars.slice(i + 1);

            const outcomes = {};

            // Config 1: ACD Style (Stop = opposite OR boundary, Target = opposite OR boundary)
            const acdStop = direction === 'LONG' ? setup.orLow : setup.orHigh;
            const acdTarget = direction === 'LONG' ? setup.orHigh : setup.orLow;
            outcomes['ACD_STYLE'] = simulateTrade(entry, acdStop, acdTarget, direction, remainingBars);

            // Config 2: Fixed 20/40 (Stop = 20, Target = 40)
            const f20Stop = direction === 'LONG' ? entry - 20 : entry + 20;
            const f20Target = direction === 'LONG' ? entry + 40 : entry - 40;
            outcomes['FIXED_20_40'] = simulateTrade(entry, f20Stop, f20Target, direction, remainingBars);

            // Config 3: Fixed 30/60 (Stop = 30, Target = 60)
            const f30Stop = direction === 'LONG' ? entry - 30 : entry + 30;
            const f30Target = direction === 'LONG' ? entry + 60 : entry - 60;
            outcomes['FIXED_30_60'] = simulateTrade(entry, f30Stop, f30Target, direction, remainingBars);

            allTrades.push({
              trade_date: d,
              setup_type: setup.name,
              direction,
              entry,
              timeOfDay,
              dayOfWeek,
              dayType: sess.day_type || 'UNKNOWN',
              orRangeType,
              confluences: confluences.length ? confluences.join(',') : 'NONE',
              isAlignedWithBias,
              outcomes,
            });

            break; // Stop scanning bars for this setup today
          }
        }
      }
    }
  }

  // 4. Summarize and Print Results
  printSummary(allTrades);

  await pool.end();
}

function simulateTrade(entry, stop, target, direction, remainingBars) {
  const isLong = direction === 'LONG';
  let resolved = false;
  let pnlPoints = 0;
  let resolution = 'EXPIRED';

  // Guard against non-viable levels
  if (stop == null || target == null || (isLong ? stop >= entry : stop <= entry) || (isLong ? target <= entry : target >= entry)) {
    return { resolution: 'EXPIRED', pnlPoints: 0 };
  }

  for (const b of remainingBars) {
    const stopHit = isLong ? b.low <= stop : b.high >= stop;
    const targetHit = isLong ? b.high >= target : b.low <= target;

    if (stopHit && targetHit) {
      resolution = 'STOP_HIT';
      pnlPoints = isLong ? stop - entry : entry - stop;
      resolved = true;
      break;
    } else if (stopHit) {
      resolution = 'STOP_HIT';
      pnlPoints = isLong ? stop - entry : entry - stop;
      resolved = true;
      break;
    } else if (targetHit) {
      resolution = 'TARGET_HIT';
      pnlPoints = isLong ? target - entry : entry - target;
      resolved = true;
      break;
    }
  }

  if (!resolved) {
    const lastBar = remainingBars[remainingBars.length - 1];
    if (lastBar) {
      resolution = 'EXPIRED';
      pnlPoints = isLong ? lastBar.close - entry : entry - lastBar.close;
    }
  }

  return { resolution, pnlPoints };
}

function printSummary(trades) {
  const setupTypes = ['OR5_MID', 'OR10_MID'];
  const configs = ['ACD_STYLE', 'FIXED_20_40', 'FIXED_30_60'];

  console.log('\n=== OVERALL CONFIGURATION COMPARISON ===');
  const configRows = [];

  for (const setupType of setupTypes) {
    const subTrades = trades.filter(t => t.setup_type === setupType);

    for (const config of configs) {
      let wins = 0;
      let losses = 0;
      let netPts = 0;
      let grossWins = 0;
      let grossLosses = 0;

      for (const t of subTrades) {
        const out = t.outcomes[config];
        netPts += out.pnlPoints;
        if (out.pnlPoints > 0) {
          wins++;
          grossWins += out.pnlPoints;
        } else {
          losses++;
          grossLosses += Math.abs(out.pnlPoints);
        }
      }

      const total = wins + losses;
      const winRate = total > 0 ? (wins / total * 100).toFixed(1) + '%' : '0.0%';
      const pf = grossLosses > 0 ? (grossWins / grossLosses).toFixed(2) : grossWins.toFixed(2);

      configRows.push({
        'Setup': setupType,
        'Config': config,
        'N': total,
        'Win Rate': winRate,
        'Net Pts': netPts.toFixed(1),
        'Profit Factor': pf,
      });
    }
  }
  console.table(configRows);

  const bestSetup = 'OR5_MID';
  const bestConfig = 'FIXED_20_40';
  const targetTrades = trades.filter(t => t.setup_type === bestSetup);

  console.log(`\n=== DETAILED BREAKDOWN FOR ${bestSetup} (${bestConfig}) ===`);

  const printBreakdown = (label, keyGetter) => {
    const groups = {};
    for (const t of targetTrades) {
      const key = keyGetter(t);
      if (!groups[key]) groups[key] = [];
      groups[key].push(t);
    }

    const rows = Object.entries(groups).map(([val, grp]) => {
      let wins = 0, net = 0;
      let gw = 0, gl = 0;
      for (const t of grp) {
        const out = t.outcomes[bestConfig];
        net += out.pnlPoints;
        if (out.pnlPoints > 0) { wins++; gw += out.pnlPoints; }
        else { gl += Math.abs(out.pnlPoints); }
      }
      return {
        [label]: val,
        'N': grp.length,
        'Win Rate': (wins / grp.length * 100).toFixed(1) + '%',
        'Net Pts': net.toFixed(1),
        'Profit Factor': gl > 0 ? (gw / gl).toFixed(2) : gw.toFixed(2),
        'netRaw': net,
      };
    }).sort((a, b) => b.netRaw - a.netRaw);

    console.table(rows.map(({ netRaw, ...r }) => r));
  };

  console.log('\n1. Day of Week:');
  printBreakdown('Day of Week', t => t.dayOfWeek);

  console.log('\n2. Time of Day:');
  printBreakdown('Time of Day', t => t.timeOfDay);

  console.log('\n3. Day Type:');
  printBreakdown('Day Type', t => t.dayType);

  console.log('\n4. Opening Range Size:');
  printBreakdown('OR Range Type', t => t.orRangeType);

  console.log('\n5. Confluence Levels (Near Entry):');
  printBreakdown('Confluences', t => t.confluences !== 'NONE' ? t.confluences : 'Standalone (No Confluence)');

  console.log('\n6. Daily Bias Alignment:');
  printBreakdown('Bias Alignment', t => t.isAlignedWithBias ? 'Aligned with Daily Score' : 'Counter-Bias');

  generateMarkdownReport(trades);
}

function generateMarkdownReport(trades) {
  const setupTypes = ['OR5_MID', 'OR10_MID'];
  const configs = ['ACD_STYLE', 'FIXED_20_40', 'FIXED_30_60'];
  // Save reports to artifacts directory so user can click it
  const reportPath = '/home/mmoniz/.gemini/antigravity-cli/brain/b1a5a88c-b280-410c-85a7-2921d711bb19/or_mid_backtest_report.md';

  let md = `# Opening Range Midpoint (OR Mid) Backtest Report\n\n`;
  md += `This report presents the historical performance of the **5-minute Opening Range Midpoint (OR5_MID)** and **10-minute Opening Range Midpoint (OR10_MID)** setups under three exit configurations across the entire database history.\n\n`;

  md += `## 📊 Configuration Comparison\n\n`;
  md += `| Setup | Exit Configuration | Trades (N) | Win Rate | Net Points | Profit Factor |\n`;
  md += `| :--- | :--- | :---: | :---: | :---: | :---: |\n`;

  for (const setupType of setupTypes) {
    const subTrades = trades.filter(t => t.setup_type === setupType);

    for (const config of configs) {
      let wins = 0, losses = 0, netPts = 0;
      let grossWins = 0, grossLosses = 0;

      for (const t of subTrades) {
        const out = t.outcomes[config];
        netPts += out.pnlPoints;
        if (out.pnlPoints > 0) { wins++; grossWins += out.pnlPoints; }
        else { losses++; grossLosses += Math.abs(out.pnlPoints); }
      }
      const total = wins + losses;
      const winRate = total > 0 ? (wins / total * 100).toFixed(1) + '%' : '0.0%';
      const pf = grossLosses > 0 ? (grossWins / grossLosses).toFixed(2) : grossWins.toFixed(2);
      md += `| **${setupType}** | ${config} | ${total} | ${winRate} | ${netPts.toFixed(1)} | ${pf} |\n`;
    }
  }

  // Generate breakdown for OR5_MID (FIXED_20_40)
  const bestSetup = 'OR5_MID';
  const bestConfig = 'FIXED_20_40';
  const subTrades = trades.filter(t => t.setup_type === bestSetup);

  md += `\n## 🔍 Detailed Breakdown: ${bestSetup} (${bestConfig})\n\n`;

  const addBreakdownSection = (title, keyGetter) => {
    md += `### ${title}\n\n`;
    md += `| Segment | Trades (N) | Win Rate | Net Points | Profit Factor |\n`;
    md += `| :--- | :---: | :---: | :---: | :---: |\n`;

    const groups = {};
    for (const t of subTrades) {
      const key = keyGetter(t);
      if (!groups[key]) groups[key] = [];
      groups[key].push(t);
    }

    const sortedGroups = Object.entries(groups).map(([val, grp]) => {
      let wins = 0, net = 0;
      let gw = 0, gl = 0;
      for (const t of grp) {
        const out = t.outcomes[bestConfig];
        net += out.pnlPoints;
        if (out.pnlPoints > 0) { wins++; gw += out.pnlPoints; }
        else { gl += Math.abs(out.pnlPoints); }
      }
      return { val, n: grp.length, winRate: (wins / grp.length * 100).toFixed(1) + '%', net, pf: gl > 0 ? (gw / gl).toFixed(2) : gw.toFixed(2) };
    }).sort((a, b) => b.net - a.net);

    for (const g of sortedGroups) {
      md += `| ${g.val} | ${g.n} | ${g.winRate} | ${g.net.toFixed(1)} | ${g.pf} |\n`;
    }
    md += `\n`;
  };

  addBreakdownSection('1. Day of Week', t => t.dayOfWeek);
  addBreakdownSection('2. Time of Day', t => t.timeOfDay);
  addBreakdownSection('3. Day Type Performance', t => t.dayType);
  addBreakdownSection('4. Opening Range Size Influence', t => t.orRangeType);
  addBreakdownSection('5. Confluence Levels Alignment', t => t.confluences !== 'NONE' ? t.confluences : 'Standalone (No Confluence)');
  addBreakdownSection('6. Daily Bias Alignment', t => t.isAlignedWithBias ? 'Aligned with Daily Score' : 'Counter-Bias');

  md += `\n> [!NOTE]\n`;
  md += `> This report is generated dynamically based on historical price bar replays. It assumes a tick value of $2 per point for MNQ contract scaling.\n`;

  fs.writeFileSync(reportPath, md);
  console.log(`Markdown report written to ${reportPath}`);
}

main().catch(console.error);
