/**
 * swatted_level_backtest.js
 *
 * REPORT ONLY — build nothing, no live logic changed.
 *
 * Tests the "swatted-away level" hypothesis: a value-area edge (VAH/VAL)
 * that gets APPROACHED and REJECTED across multiple subsequent sessions
 * without breaking-and-holding — when it FINALLY breaks and holds, does it
 * produce MORE follow-through than an ordinary break (0-1 prior rejections)?
 *
 * Data source: developing_value_log (already persisted, OHLC-derived
 * spread-volume approximation — same method as acceptance_engine_backtest.js).
 *
 * DEFINITIONS:
 * - Candidate level: each session i's VAH (resistance, breakout=UP) and VAL
 *   (support, breakout=DOWN).
 * - Tolerance ("approached"): within 0.5 * (VAH_i - VAL_i) of the level —
 *   scaled to that level's own value-area width (self-consistent, since vol
 *   regime varies a lot across the 1.5y dataset).
 * - "Rejected": session j's range approaches the level but session j's
 *   CLOSE does not get beyond it.
 * - "Break": session j's close gets beyond the level.
 * - "Hold": the session AFTER the break (j+1) also closes beyond the level
 *   (not just a 1-session poke).
 * - rejectionCount = number of approach-but-no-break sessions between
 *   formation (i) and the eventual break (j), exclusive. Sessions that don't
 *   even approach the level don't count and don't reset the count.
 * - Lookahead cap: 20 sessions. If no break within 20 sessions, the level is
 *   dropped (still "pending", not scored).
 * - Follow-through: (close_{j+K} - close_j) * direction, K in {3,5,10}
 *   sessions after the break, also reported normalized by the level's VA
 *   width (vaWidth_i) for cross-vol-regime comparability.
 */

import { query } from '../server/db.js';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

const LOOKAHEAD_CAP = 20;
const FT_HORIZONS = [3, 5, 10];

function mean(arr) { return arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : null; }
function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a,b)=>a-b);
  const mid = Math.floor(s.length/2);
  return s.length % 2 ? s[mid] : (s[mid-1]+s[mid])/2;
}

async function main() {
  console.log('[swatted_level_backtest] REPORT ONLY — no writes, no live logic changed.\n');
  console.log('Levels = VAH/VAL from developing_value_log (OHLC-derived spread-volume approximation).');
  console.log(`Tolerance = 0.5 * value-area width of the forming session. Lookahead cap = ${LOOKAHEAD_CAP} sessions.\n`);

  const rowsQ = await query(`
    SELECT trade_date::text, poc::float, vah::float, val::float, session_high::float, session_low::float, session_close::float
    FROM developing_value_log ORDER BY trade_date
  `);
  const rows = rowsQ.rows;
  console.log(`Sessions: ${rows.length}\n`);

  const events = [];
  let pending = 0, total = 0;

  for (let i = 0; i < rows.length; i++) {
    for (const levelType of ['VAH', 'VAL']) {
      const ri = rows[i];
      const L = levelType === 'VAH' ? ri.vah : ri.val;
      const vaWidth = ri.vah - ri.val;
      if (!(vaWidth > 0)) continue;
      const tolerance = 0.5 * vaWidth;
      const dir = levelType === 'VAH' ? 1 : -1;

      let rejectionCount = 0;
      let breakIdx = null;
      const cap = Math.min(i + LOOKAHEAD_CAP, rows.length - 1);
      for (let j = i + 1; j <= cap; j++) {
        const rj = rows[j];
        let approached, broke;
        if (dir === 1) {
          approached = rj.session_high >= L - tolerance;
          broke = rj.session_close > L;
        } else {
          approached = rj.session_low <= L + tolerance;
          broke = rj.session_close < L;
        }
        if (broke) { breakIdx = j; break; }
        if (approached) rejectionCount++;
      }

      total++;
      if (breakIdx == null) { pending++; continue; }

      // hold check: session after the break also closes beyond L
      let holdConfirmed = null;
      if (breakIdx + 1 < rows.length) {
        const rNext = rows[breakIdx+1];
        holdConfirmed = dir === 1 ? rNext.session_close > L : rNext.session_close < L;
      }

      const breakClose = rows[breakIdx].session_close;
      const ft = {};
      for (const K of FT_HORIZONS) {
        const idx = breakIdx + K;
        ft[K] = idx < rows.length ? (rows[idx].session_close - breakClose) * dir : null;
      }

      events.push({
        formDate: ri.trade_date, levelType, level: L, vaWidth,
        breakDate: rows[breakIdx].trade_date, rejectionCount, holdConfirmed, ft,
      });
    }
  }

  console.log(`Total candidate levels: ${total}   Broke within ${LOOKAHEAD_CAP} sessions: ${events.length}   Still pending (no break): ${pending}\n`);

  // ─────────────────────────────────────────────────────────────────────
  function summarize(label, evs) {
    const n = evs.length;
    if (n === 0) { console.log(`  ${label}: N=0`); return; }
    const holdN = evs.filter(e => e.holdConfirmed === true).length;
    const holdEligible = evs.filter(e => e.holdConfirmed !== null).length;
    console.log(`  ${label}: N=${n}${n<20?' (N<20 — THIN)':''}   hold-confirmed: ${holdN}/${holdEligible} (${holdEligible?(holdN/holdEligible*100).toFixed(1):'n/a'}%)`);
    for (const K of FT_HORIZONS) {
      const raws = evs.map(e=>e.ft[K]).filter(v=>v!=null);
      const norms = evs.filter(e=>e.ft[K]!=null).map(e=>e.ft[K]/e.vaWidth);
      console.log(`    FT${K}: N=${raws.length}${raws.length<20?' (N<20)':''}  mean=${mean(raws)?.toFixed(2)}  median=${median(raws)?.toFixed(2)}  mean(norm by vaWidth)=${mean(norms)?.toFixed(2)}`);
    }
  }

  console.log('═'.repeat(78));
  console.log('THRESHOLD N>=2 — repeated (rejectionCount>=2) vs ordinary (rejectionCount<2)');
  console.log('═'.repeat(78));
  summarize('ORDINARY (0-1 rejections)', events.filter(e=>e.rejectionCount < 2));
  summarize('REPEATED (>=2 rejections)', events.filter(e=>e.rejectionCount >= 2));
  console.log('');

  console.log('═'.repeat(78));
  console.log('THRESHOLD N>=3 — repeated (rejectionCount>=3) vs ordinary (rejectionCount<3)');
  console.log('═'.repeat(78));
  summarize('ORDINARY (0-2 rejections)', events.filter(e=>e.rejectionCount < 3));
  summarize('REPEATED (>=3 rejections)', events.filter(e=>e.rejectionCount >= 3));
  console.log('');

  console.log('═'.repeat(78));
  console.log('BREAK-AND-HOLD vs BREAK-THEN-FAIL (for REPEATED >=2 levels) — follow-through');
  console.log('═'.repeat(78));
  const repeated2 = events.filter(e=>e.rejectionCount >= 2 && e.holdConfirmed !== null);
  summarize('  Held (confirmed next session)', repeated2.filter(e=>e.holdConfirmed === true));
  summarize('  Failed (faded back next session)', repeated2.filter(e=>e.holdConfirmed === false));
  console.log('');
  // Also for ordinary levels, fail rate for comparison
  const ordinary2 = events.filter(e=>e.rejectionCount < 2 && e.holdConfirmed !== null);
  const ordHoldRate = ordinary2.length ? (ordinary2.filter(e=>e.holdConfirmed).length/ordinary2.length*100) : null;
  const repHoldRate = repeated2.length ? (repeated2.filter(e=>e.holdConfirmed).length/repeated2.length*100) : null;
  console.log(`  Hold rate — ORDINARY: ${ordHoldRate?.toFixed(1)}% (N=${ordinary2.length})   REPEATED>=2: ${repHoldRate?.toFixed(1)}% (N=${repeated2.length})`);
  console.log('');

  console.log('═'.repeat(78));
  console.log('DOSE-RESPONSE — follow-through (FT5, normalized by vaWidth) by exact rejectionCount');
  console.log('═'.repeat(78));
  const maxRC = 6;
  for (let rc = 0; rc <= maxRC; rc++) {
    const evs = rc === maxRC ? events.filter(e=>e.rejectionCount >= rc) : events.filter(e=>e.rejectionCount === rc);
    const label = rc === maxRC ? `rejectionCount>=${rc}` : `rejectionCount==${rc}`;
    const norms = evs.map(e=>e.ft[5]).filter(v=>v!=null).map((v,idx)=>v/evs.filter(e=>e.ft[5]!=null)[idx].vaWidth);
    const n = evs.filter(e=>e.ft[5]!=null).length;
    console.log(`  ${label.padEnd(20)} N=${String(n).padStart(4)}${n<20?' (N<20)':'        '}  mean FT5(norm)=${mean(norms)?.toFixed(2) ?? 'n/a'}`);
  }
  console.log('');

  // Breakdown by level type (VAH resistance breaks vs VAL support breaks)
  console.log('═'.repeat(78));
  console.log('BY LEVEL TYPE (VAH=resistance break up, VAL=support break down) — REPEATED>=2');
  console.log('═'.repeat(78));
  summarize('  VAH (>=2 rejections)', events.filter(e=>e.levelType==='VAH' && e.rejectionCount>=2));
  summarize('  VAL (>=2 rejections)', events.filter(e=>e.levelType==='VAL' && e.rejectionCount>=2));
  console.log('');
  console.log('  -- For comparison, ORDINARY (0-1 rejections) by level type --');
  summarize('  VAH (0-1 rejections)', events.filter(e=>e.levelType==='VAH' && e.rejectionCount<2));
  summarize('  VAL (0-1 rejections)', events.filter(e=>e.levelType==='VAL' && e.rejectionCount<2));

  console.log('\n[swatted_level_backtest] Done. No writes performed.\n');
}

main().then(()=>process.exit(0)).catch(err=>{console.error(err); process.exit(1);});
