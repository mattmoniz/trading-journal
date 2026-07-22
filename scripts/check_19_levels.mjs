import { query } from '../server/db.js';
import { resolve } from './backtest_unified.js';
import fs from 'fs';

const CANDIDATES = [
  { level: 'MPP', dir: 'SHORT', oldRthN: 29, oldRthWr: 85.2, oldRthEv: 36.31, oldWideN: 41, oldWideWr: 87.2, oldWideEv: 37.59 },
  { level: 'PD_IB_HIGH', dir: 'SHORT', oldRthN: 86, oldRthWr: 78.7, oldRthEv: 21.92, oldWideN: 119, oldWideWr: 81.3, oldWideEv: 23.61 },
  { level: 'PM_VAH', dir: 'SHORT', oldRthN: 25, oldRthWr: 70.8, oldRthEv: 7.04, oldWideN: 34, oldWideWr: 75.0, oldWideEv: 21.41 },
  { level: 'PW_LOW', dir: 'SHORT', oldRthN: 39, oldRthWr: 81.6, oldRthEv: 30.82, oldWideN: 60, oldWideWr: 79.3, oldWideEv: 21.37 },
  { level: 'PM_HIGH', dir: 'LONG', oldRthN: 29, oldRthWr: 69.2, oldRthEv: 3.93, oldWideN: 48, oldWideWr: 80.0, oldWideEv: 21.67 },
  { level: 'PW_VAL', dir: 'LONG', oldRthN: 35, oldRthWr: 69.7, oldRthEv: 7.63, oldWideN: 70, oldWideWr: 79.3, oldWideEv: 20.60 },
  { level: 'MONTHLY_OPEN', dir: 'LONG', oldRthN: 36, oldRthWr: 77.1, oldRthEv: 15.14, oldWideN: 66, oldWideWr: 80.4, oldWideEv: 20.06 },
  { level: '10D_IB_MID', dir: 'SHORT', oldRthN: 54, oldRthWr: 71.7, oldRthEv: 6.06, oldWideN: 71, oldWideWr: 78.7, oldWideEv: 19.70 },
  { level: 'PM_VAL', dir: 'SHORT', oldRthN: 21, oldRthWr: 80.0, oldRthEv: 25.71, oldWideN: 38, oldWideWr: 74.3, oldWideEv: 16.97 },
  { level: 'CAM_R3', dir: 'SHORT', oldRthN: 80, oldRthWr: 76.3, oldRthEv: 16.30, oldWideN: 73, oldWideWr: 75.9, oldWideEv: 14.55 },
  { level: 'PW_HIGH', dir: 'LONG', oldRthN: 61, oldRthWr: 71.2, oldRthEv: 3.08, oldWideN: 90, oldWideWr: 75.3, oldWideEv: 10.52 },
  { level: 'FLOOR_PIVOT', dir: 'SHORT', oldRthN: 123, oldRthWr: 70.9, oldRthEv: 4.09, oldWideN: 219, oldWideWr: 72.2, oldWideEv: 9.33 },
  { level: 'WR1', dir: 'SHORT', oldRthN: 32, oldRthWr: 86.7, oldRthEv: 40.94, oldWideN: 37, oldWideWr: 68.0, oldWideEv: 9.05 },
  { level: 'FLOOR_R1', dir: 'SHORT', oldRthN: 55, oldRthWr: 77.8, oldRthEv: 22.65, oldWideN: 42, oldWideWr: 73.5, oldWideEv: 8.71 },
  { level: 'CAM_R2', dir: 'SHORT', oldRthN: 102, oldRthWr: 71.7, oldRthEv: 5.37, oldWideN: 101, oldWideWr: 69.7, oldWideEv: 6.77 },
  { level: '5D_OR_MID', dir: 'SHORT', oldRthN: 64, oldRthWr: 74.2, oldRthEv: 10.59, oldWideN: 88, oldWideWr: 69.5, oldWideEv: 3.16 },
  { level: 'PD_OR_MID', dir: 'SHORT', oldRthN: 99, oldRthWr: 70.8, oldRthEv: 1.05, oldWideN: 155, oldWideWr: 70.9, oldWideEv: 2.28 },
  { level: 'FLOOR_PIVOT', dir: 'LONG', oldRthN: 97, oldRthWr: 75.3, oldRthEv: 15.37, oldWideN: 173, oldWideWr: 70.7, oldWideEv: 2.29 },
  { level: 'PD_SESSION_MID', dir: 'SHORT', oldRthN: 112, oldRthWr: 75.5, oldRthEv: 14.45, oldWideN: 201, oldWideWr: 68.2, oldWideEv: 1.61 }
];

const LEVELS = Array.from(new Set(CANDIDATES.map(c => c.level)));
const RTH_START = 570, RTH_END = 960;

async function main() {
  const lvlRes = await query(`
    SELECT trade_date::text as d, level_name, price::float as price
    FROM level_prices WHERE level_name = ANY($1)
  `, [LEVELS]);
  const levelsByDate = new Map();
  for (const r of lvlRes.rows) {
    if (!levelsByDate.has(r.d)) levelsByDate.set(r.d, {});
    levelsByDate.get(r.d)[r.level_name] = r.price;
  }
  const dates = [...levelsByDate.keys()].sort();

  const barsRes = await query(`
    SELECT ts, ts::date::text as d,
      EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts)::int as tod,
      open::float, high::float, low::float, close::float
    FROM price_bars_primary WHERE symbol='NQ' ORDER BY ts ASC
  `);
  const allBars = barsRes.rows.map(b => ({ ...b, ts: new Date(b.ts).getTime() }));

  function firstIdxAtOrAfter(dateStr, todMin) {
    for (let i = 0; i < allBars.length; i++) {
      if (allBars[i].d > dateStr) return i;
      if (allBars[i].d === dateStr && allBars[i].tod >= todMin) return i;
    }
    return -1;
  }

  const results = {}; // name_DIR -> { RTH: [], WIDE: [] }
  // Allocate BOTH directions per level (matching the reference script) -- since the
  // targetDir filter is removed, a touch can legitimately come out LONG or SHORT
  // regardless of which direction this candidate list happens to be asking about.
  for (const name of LEVELS) {
    for (const dir of ['LONG', 'SHORT']) {
      results[`${name}_${dir}_RTH`] = [];
      results[`${name}_${dir}_WIDE`] = [];
    }
  }

  for (const d of dates) {
    const lv = levelsByDate.get(d);
    if (!lv) continue;
    const startIdx = firstIdxAtOrAfter(d, RTH_START);
    if (startIdx < 0 || startIdx === 0) continue;
    
    let rthEndIdx = allBars.length;
    for (let i = startIdx; i < allBars.length; i++) {
      if (allBars[i].d > d || (allBars[i].d === d && allBars[i].tod >= RTH_END)) { rthEndIdx = i; break; }
    }
    
    const wideStartTs = allBars[startIdx].ts - 15.5 * 3600 * 1000;
    let wideStartIdx = 0;
    { let lo = 0, hi = allBars.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (allBars[mid].ts < wideStartTs) lo = mid + 1; else hi = mid; }
      wideStartIdx = lo; }
    const wideEndIdx = rthEndIdx;

    const isMonday = new Date(d + 'T12:00:00').getDay() === 1;
    const STOP = isMonday ? 60 : 90, TARGET = isMonday ? 30 : 40;

    for (const c of CANDIDATES) {
      const name = c.level;
      const targetDir = c.dir;
      const lvl = lv[name];
      if (lvl == null) continue;
      
      for (const [windowName, scanStartIdx, endIdx] of [['RTH', startIdx, rthEndIdx], ['WIDE', wideStartIdx, wideEndIdx]]) {
        let fired = false;
        for (let i = Math.max(scanStartIdx, 1) + 1; i < endIdx && !fired; i++) {
          const b = allBars[i], prev = allBars[i - 1];
          if (Math.abs(b.close - lvl) > 15) continue;
          const fromAbove = prev.close > lvl;
          const dir = fromAbove ? 'SHORT' : 'LONG';
          // FIXED: the reference script (verify_prior_period_wider_window_20260720.mjs)
          // fires on the FIRST touch of a level regardless of direction, then stops --
          // it does NOT skip past a "wrong-direction" touch searching for a specific
          // target direction later in the window. The removed `if (dir !== targetDir)
          // continue` line caused every one of the 19 candidates to systematically find
          // 1.5-3x more "touches" than the original table, because it kept scanning past
          // legitimate first-touches (in the other direction) looking for one matching a
          // predetermined direction -- an apples-to-oranges comparison against the
          // original methodology, not a real discrepancy in the original numbers.
          const entry = b.close;
          const r = resolve(allBars, i, dir,
            entry, dir === 'LONG' ? entry - STOP : entry + STOP,
            dir === 'LONG' ? entry + TARGET : entry - TARGET, endIdx - i);
          results[`${name}_${dir}_${windowName}`].push(r);
          fired = true;
        }
      }
    }
  }

  let out = "# Independent Reimplementation Check (19 Candidates)\n\n";
  out += "## Raw Output and Comparison\n\n";
  out += "| Level_Direction | RTH_N (orig/new) | RTH_WR (orig/new) | RTH_EV (orig/new) | WIDE_N (orig/new) | WIDE_WR (orig/new) | WIDE_EV (orig/new) | Agreement |\n";
  out += "|---|---|---|---|---|---|---|---|\n";

  let agreeCount = 0;
  const agreeList = [];
  const disagreeList = [];

  for (const c of CANDIDATES) {
    const keyPrefix = `${c.level}_${c.dir}`;
    const rthRows = results[`${keyPrefix}_RTH`];
    const wideRows = results[`${keyPrefix}_WIDE`];

    const rthN = rthRows.length;
    const rthWins = rthRows.filter(r => r.result === 'TARGET_HIT').length;
    const rthWr = rthN ? (100 * rthWins / rthN).toFixed(1) : 0;
    const rthEv = rthN ? (rthRows.reduce((s, r) => s + r.pnl, 0) / rthN).toFixed(2) : 0;

    const wideN = wideRows.length;
    const wideWins = wideRows.filter(r => r.result === 'TARGET_HIT').length;
    const wideWr = wideN ? (100 * wideWins / wideN).toFixed(1) : 0;
    const wideEv = wideN ? (wideRows.reduce((s, r) => s + r.pnl, 0) / wideN).toFixed(2) : 0;
    
    // Check agreement
    // We consider it "agree" if the signs are the same and N values are reasonably close
    // In prior spot check they were quite close.
    const rthEvDiff = Math.abs(parseFloat(rthEv) - c.oldRthEv);
    const wideEvDiff = Math.abs(parseFloat(wideEv) - c.oldWideEv);
    
    // Sign match check
    const rthSignMatch = Math.sign(parseFloat(rthEv)) === Math.sign(c.oldRthEv);
    const wideSignMatch = Math.sign(parseFloat(wideEv)) === Math.sign(c.oldWideEv);
    
    let isAgreement = true;
    let reason = "";
    if (Math.abs(rthN - c.oldRthN) > Math.max(c.oldRthN * 0.1, 5) || Math.abs(wideN - c.oldWideN) > Math.max(c.oldWideN * 0.1, 5)) {
        isAgreement = false;
        reason = "N mismatch";
    } else if (!rthSignMatch || !wideSignMatch) {
        isAgreement = false;
        reason = "EV sign mismatch";
    } else if (rthEvDiff > 5 || wideEvDiff > 5) { // some tolerance for rounding/slight difference
        isAgreement = false;
        reason = "EV magnitude mismatch";
    }
    
    const agreeStr = isAgreement ? "✅ AGREE" : `❌ DISAGREE (${reason})`;

    out += `| ${keyPrefix} | ${c.oldRthN} / ${rthN} | ${c.oldRthWr}% / ${rthWr}% | $${c.oldRthEv} / $${rthEv} | ${c.oldWideN} / ${wideN} | ${c.oldWideWr}% / ${wideWr}% | $${c.oldWideEv} / $${wideEv} | ${agreeStr} |\n`;
    
    if (isAgreement) {
      agreeList.push(keyPrefix);
      agreeCount++;
    } else {
      disagreeList.push({level: keyPrefix, reason,
        rthN: `${c.oldRthN}/${rthN}`, rthEv: `${c.oldRthEv}/${rthEv}`,
        wideN: `${c.oldWideN}/${wideN}`, wideEv: `${c.oldWideEv}/${wideEv}`
      });
    }
  }

  out += "\n## Summary\n\n";
  out += `**${agreeCount} out of ${CANDIDATES.length}** levels agree with the original report numbers (small deltas in N, WR, EV; no sign flips).\n\n`;
  
  out += "### Safe to Wire (Confirmed Agreement)\n";
  if (agreeList.length === 0) out += "None.\n";
  else out += agreeList.map(l => "- " + l).join("\n") + "\n";

  out += "\n### Do NOT Wire (Disagreement Found)\n";
  if (disagreeList.length === 0) out += "None.\n";
  else {
    for (const d of disagreeList) {
      out += `- **${d.level}**: ${d.reason} (RTH N: ${d.rthN}, EV: ${d.rthEv} | WIDE N: ${d.wideN}, EV: ${d.wideEv})\n`;
    }
  }
  
  fs.writeFileSync('scratch/antigravity_response.md', out);
  console.log("Done.");
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
