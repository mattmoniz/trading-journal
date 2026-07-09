#!/usr/bin/env node
/**
 * Pattern Scanner — run post-session or retroactively
 *
 * Usage:
 *   node scripts/scan_patterns.js                    # scan today
 *   node scripts/scan_patterns.js 2026-06-23         # scan specific date
 *   node scripts/scan_patterns.js --backfill 90      # scan last 90 trading days
 *   node scripts/scan_patterns.js --mine             # mine cross-day patterns
 */
import pool from '../server/db.js';
import { query } from '../server/db.js';
import { scanSession, persistScan, minePatterns, mineLevelFades } from '../server/services/patternScannerService.js';

const args = process.argv.slice(2);

async function scanDate(date) {
  const result = await scanSession(date);
  if (!result) {
    console.log(`  ${date}: no data`);
    return null;
  }
  const count = await persistScan(date, result);
  const a = result.analysis;
  console.log(`  ${date}: ${a.session_type} | ${a.range_pt}pt | ${a.rotations_65pt} rots | ${result.patterns.length} patterns (${result.patterns.map(p => p.pattern_type).join(', ')})`);
  return result;
}

async function backfill(days) {
  const datesRes = await query(
    `SELECT DISTINCT ts::date as d FROM price_bars_primary
     WHERE symbol='NQ' AND ts::date >= CURRENT_DATE - ($1 || ' days')::interval
     AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
     ORDER BY d`, [days]);

  console.log(`Scanning ${datesRes.rows.length} trading days...\n`);

  let total = 0;
  let totalPatterns = 0;
  for (const row of datesRes.rows) {
    const result = await scanDate(row.d);
    if (result) {
      total++;
      totalPatterns += result.patterns.length;
    }
  }
  console.log(`\nDone: ${total} days scanned, ${totalPatterns} patterns detected`);
}

async function mine() {
  const result = await minePatterns();
  console.log(`\n=== CROSS-DAY PATTERN MINING (${result.days_analyzed} days) ===\n`);

  for (const insight of result.insights) {
    console.log(`--- ${insight.label} ---`);
    if (typeof insight.data === 'string') {
      console.log(insight.data);
    } else {
      for (const [key, val] of Object.entries(insight.data)) {
        if (typeof val === 'object') {
          console.log(`  ${key}: ${JSON.stringify(val)}`);
        } else {
          console.log(`  ${key}: ${val}`);
        }
      }
    }
    console.log();
  }
}

async function mineFades() {
  console.log('\n=== LEVEL FADE CROSS-CUT MINING ===\n');
  const result = await mineLevelFades();
  console.log(`Total level-fade trades: ${result.totalTrades}`);
  console.log(`Active patterns (≥65% WR, N≥8): ${result.totalDiscoveries}`);

  if (result.newDiscoveries.length > 0) {
    console.log(`\n🔔 NEW DISCOVERIES (${result.newDiscoveries.length}):`);
    for (const d of result.newDiscoveries) {
      console.log(`  ${d.strengthened ? 'STRENGTHENED' : 'NEW'}: ${d.patternKey} | ${d.wr}% WR | N=${d.n} | $${d.netPnl}`);
    }
  } else {
    console.log('\nNo new discoveries since last run.');
  }

  console.log(`\nTop 20 patterns by net P&L:`);
  for (const p of result.topPatterns) {
    console.log(`  ${p.patternKey.padEnd(45)} | ${p.wr}% WR | N=${String(p.n).padEnd(3)} | $${p.netPnl}`);
  }
}

async function main() {
  try {
    if (args[0] === '--backfill') {
      const days = parseInt(args[1]) || 90;
      await backfill(days);
      await mine();
      await mineFades();
    } else if (args[0] === '--mine') {
      await mine();
      await mineFades();
    } else {
      const date = args[0] || new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      console.log(`Scanning ${date}...\n`);
      const result = await scanDate(date);
      if (result) {
        console.log(`\nSession: ${result.analysis.session_type}`);
        console.log(`Range: ${result.analysis.range_pt}pt (${result.analysis.atr_ratio}x ATR)`);
        console.log(`Gap: ${result.analysis.gap_pt || 0}pt ${result.analysis.gap_filled ? '(filled)' : '(held)'}`);
        console.log(`Open: ${result.analysis.open_type} | Close: ${result.analysis.close_type}`);
        console.log(`Rotations: ${result.analysis.rotations_65pt} (avg ${result.analysis.avg_rotation_size}pt, ${result.analysis.rotation_trend})`);
        console.log(`VWAP crosses: ${result.analysis.vwap_crosses} | Close vs VWAP: ${result.analysis.close_vs_vwap}pt`);
        console.log(`\nPatterns detected (${result.patterns.length}):`);
        for (const p of result.patterns) {
          console.log(`  ${p.pattern_type} @ ${Math.floor(p.et_minute/60)}:${String(p.et_minute%60).padStart(2,'0')} | ${p.direction} | ${p.magnitude}pt | ${JSON.stringify(p.context)}`);
        }
      }
      // Always mine fades on single-day scan to catch new discoveries
      await mineFades();
    }
  } finally {
    await pool.end();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
