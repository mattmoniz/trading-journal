// Descriptive audit after Argon's web critique (workplan item K prep). Reads NO setup outcome except to name the 5 worst long days (already known from round 13);
// concurrency uses only fired_at/resolved_at. Part 1: simultaneous open positions on the worst long days. Part 2: Globex departure-time buckets (outcome-blind).
// Part 3: drift of (stop-50)/ADR20 over time. Part 4: how often a dollar stop cap would bind (explore vs live period).
import { query } from '../server/db.js';
import { loadLevels, loadBarsWithVolZ, groupBarsByDate, groupRthByDate, loadFollowingLevels, makeAdrBefore, buildRthBlindEvents, buildGlobexBlindEventsLive, findGlobexEventsLive, percentile } from './lib/flushStudyLib.mjs';

function maxConcurrent(rows) {
  const ev = [];
  for (const r of rows) { ev.push([+new Date(r.f), 1]); ev.push([+new Date(r.r), -1]); }
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let c = 0, m = 0;
  for (const [, d] of ev) { c += d; m = Math.max(m, c); }
  return m;
}

async function main() {
  console.log('PART 1: simultaneous LONG positions on the 5 worst long days (cluster primaries; resolved rows)');
  const worst = (await query(`SELECT trade_date::text d FROM active_setups WHERE fired_at>='2026-09-01' AND origin_status IN ('ACTIVE','SHADOW') AND is_cluster_primary AND status='RESOLVED' AND actual_pnl IS NOT NULL AND setup_type ~ '_LONG($|_)' GROUP BY 1 ORDER BY SUM(actual_pnl) LIMIT 5`)).rows.map((r) => r.d);
  for (const d of worst) {
    const rows = (await query(`SELECT origin_status o, setup_type, fired_at::text f, COALESCE(resolved_at, expires_at)::text r FROM active_setups WHERE trade_date=$1 AND origin_status IN ('ACTIVE','SHADOW') AND is_cluster_primary AND status='RESOLVED' AND setup_type ~ '_LONG($|_)'`, [d])).rows;
    const act = rows.filter((r) => r.o === 'ACTIVE');
    console.log(`  ${d}: long rows ${rows.length} (ACTIVE ${act.length}); max simultaneously open: all ${maxConcurrent(rows)}, ACTIVE only ${maxConcurrent(act)}; distinct long setup types ${new Set(rows.map((r) => r.setup_type)).size}`);
  }
  const allAct = (await query(`SELECT trade_date::text d, fired_at::text f, COALESCE(resolved_at, expires_at)::text r, setup_type FROM active_setups WHERE fired_at>='2026-09-01' AND origin_status='ACTIVE' AND status='RESOLVED' AND setup_type ~ '_(LONG|SHORT)($|_)'`)).rows;
  const byDay = {};
  for (const r of allAct) (byDay[r.d] ||= []).push(r);
  const mc = Object.values(byDay).map(maxConcurrent);
  console.log(`  ALL ACTIVE rows since 9/1: ${Object.keys(byDay).length} days; days with >= 2 positions open at once: ${mc.filter((x) => x >= 2).length}; >= 3: ${mc.filter((x) => x >= 3).length}; max ${Math.max(...mc)}`);

  const { getLevelsForDate } = await loadLevels();
  const followingLevel = await loadFollowingLevels();
  const allBars = await loadBarsWithVolZ('1900-01-01');
  const barsByDate = groupBarsByDate(allBars);
  const rthByDate = groupRthByDate(allBars);
  const adrBefore = makeAdrBefore(rthByDate);
  const raw = findGlobexEventsLive(barsByDate, followingLevel).filter((e) => e.D <= '2025-05-16');
  const dow = (D) => new Date(D + 'T12:00:00Z').getUTCDay();
  const bucket = (e) => (dow(e.D) === 0 ? 'B2 Sunday session' : e.depBar.mod >= 959 && e.depBar.mod <= 989 ? 'B1 original 15:59-16:29' : 'B3 later overnight (16:30-09:29)');
  console.log('\nPART 2: explore Globex events by departure-time bucket x mode (outcome-blind)');
  for (const b of ['B1 original 15:59-16:29', 'B2 Sunday session', 'B3 later overnight (16:30-09:29)']) {
    const ev = raw.filter((e) => bucket(e) === b);
    console.log(`  ${b.padEnd(36)} N ${String(ev.length).padStart(3)}  CONT ${ev.filter((e) => e.mode === 'CONTINUATION').length} REV ${ev.filter((e) => e.mode === 'REVERSAL').length}  LONG ${ev.filter((e) => e.dir === 'LONG').length} SHORT ${ev.filter((e) => e.dir === 'SHORT').length}`);
  }
  const b1 = raw.filter((e) => bucket(e).startsWith('B1'));
  console.log(`  inside B1: departure bar at 15:59 ${b1.filter((e) => e.depBar.mod === 959).length}, at 16:00 ${b1.filter((e) => e.depBar.mod === 960).length}, at 16:01-16:29 ${b1.filter((e) => e.depBar.mod > 960).length}`);

  const ev = [...buildRthBlindEvents(rthByDate, getLevelsForDate, adrBefore), ...buildGlobexBlindEventsLive(barsByDate, followingLevel, adrBefore)];
  console.log('\nPART 3: drift of Sp=(stop-50)/ADR20 by year (explore only): median, and share above the POOLED explore p80');
  for (const g of ['RTH', 'GLOBEX']) {
    const ex = ev.filter((e) => e.session === g && e.date <= '2025-05-16' && e.adr);
    const p80 = percentile(ex.map((e) => (e.stopDist - 50) / e.adr), 0.8);
    const parts = ['2023', '2024', '2025'].map((y) => {
      const s = ex.filter((e) => e.date.startsWith(y)).map((e) => (e.stopDist - 50) / e.adr);
      return `${y} n ${s.length} median ${s.length ? percentile(s, 0.5).toFixed(2) : 'n/a'} above pooled-p80 ${s.length ? (100 * s.filter((x) => x > p80).length / s.length).toFixed(0) + '%' : 'n/a'}`;
    });
    console.log('  ' + g + ': ' + parts.join(' | '));
  }
  console.log('\nPART 4: share of flush events whose stop distance exceeds a cap (points x $2): explore vs live period (2026-09-01 on, geometry only)');
  const a = ev.filter((e) => e.date <= '2025-05-16');
  const b = ev.filter((e) => e.date >= '2026-09-01');
  for (const cap of [200, 250, 300, 400, 500]) {
    console.log(`  stop > ${cap} pts ($${cap * 2}): explore ${(100 * a.filter((e) => e.stopDist > cap).length / a.length).toFixed(1)}% of ${a.length}; live period ${(100 * b.filter((e) => e.stopDist > cap).length / b.length).toFixed(1)}% of ${b.length}`);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
