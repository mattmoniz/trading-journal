// DESCRIPTIVE AUTOPSY of the frozen flush box-width skip study (prereg section "Failure autopsy"; question raised by Argon's web critique 2026-11-09): are the skipped wide-stop events'
// positive medians just an artifact of a far stop against a near fixed target (reward-to-risk << 1)? Uses the study's own rows (scripts/lib/flushBoxWidthRows.mjs). No new counted test;
// the look is logged as tests=0. Explore window only, roll weeks excluded, same events as the study.
import { loadLevels, loadBarsWithVolZ, groupBarsByDate, groupRthByDate, loadFollowingLevels, makeAdrBefore, buildRthBlindEvents, buildGlobexBlindEventsLive, percentile, mean } from './lib/flushStudyLib.mjs';
import { buildGroupRows } from './lib/flushBoxWidthRows.mjs';
import { isInsideNqRollWeek } from '../server/services/acdShared.js';
import { logLook } from './lib/look_ledger.mjs';

const groupOf = (e) => (e.session === 'RTH' ? 'RTH' : e.mode === 'CONTINUATION' ? 'GLOBEX_CONT' : 'GLOBEX_REV');
const f = (v, d = 1) => (v == null || !Number.isFinite(v) ? 'n/a' : v.toFixed(d));
const money = (v) => (v == null || !Number.isFinite(v) ? 'n/a' : `${v < 0 ? '-' : '+'}$${Math.abs(v).toFixed(0)}`);

async function main() {
  const { getLevelsForDate } = await loadLevels();
  const allBars = await loadBarsWithVolZ('1900-01-01');
  const barsByDate = groupBarsByDate(allBars), rthByDate = groupRthByDate(allBars), adrBefore = makeAdrBefore(rthByDate);
  const events = [...buildRthBlindEvents(rthByDate, getLevelsForDate, adrBefore), ...buildGlobexBlindEventsLive(barsByDate, await loadFollowingLevels(), adrBefore)]
    .filter((e) => e.date <= '2025-05-16' && e.adr && !isInsideNqRollWeek(e.date)).sort((a, b) => a.date.localeCompare(b.date) || a.entryTs - b.entryTs);
  await logLook({ family: 'flush_box_width_skip', dataWindow: 'explore <= 2025-05-16, RTH + live-faithful Globex flush events (autopsy of the frozen study)', kind: 'EXPLORE', tests: 0,
    label: 'autopsy: skipped vs kept events, win rate and payoff by stop/target ratio', script: 'scripts/autopsy_flush_box_width_skip_20261109.mjs', prereg: 'docs/FLUSH_BOX_WIDTH_SKIP_PREREG_20261109.md',
    claimSlug: 'flush_box_width_skip_20261109', ref: 'flush_box_width_skip_20261109_autopsy' });
  for (const g of ['RTH', 'GLOBEX_CONT', 'GLOBEX_REV']) {
    const rows = buildGroupRows(events.filter((e) => groupOf(e) === g));
    console.log(`\n${g}: eligible ${rows.length}`);
    for (const [label, sel] of [['skipped (wide)', (r) => r.skip], ['kept', (r) => !r.skip]]) {
      const x = rows.filter(sel);
      console.log(`  ${label.padEnd(15)} N ${String(x.length).padStart(3)} win ${f(100 * x.filter((r) => r.pnl > 0).length / x.length, 0)}% | stop median ${f(percentile(x.map((r) => r.stopDist), 0.5), 0)} pt, target median ${f(percentile(x.map((r) => r.target), 0.5), 0)} pt, stop/target median ${f(percentile(x.map((r) => r.stopDist / r.target), 0.5), 2)} | mean ${money(mean(x.map((r) => r.pnl)))} median ${money(percentile(x.map((r) => r.pnl), 0.5))} | avg win ${money(mean(x.filter((r) => r.pnl > 0).map((r) => r.pnl)))} avg loss ${money(mean(x.filter((r) => r.pnl <= 0).map((r) => r.pnl)))}`);
    }
    const ratio = rows.map((r) => r.stopDist / r.target), c1 = percentile(ratio, 1 / 3), c2 = percentile(ratio, 2 / 3);
    console.log(`  by stop/target ratio tercile over ALL eligible events (cuts ${f(c1, 2)} / ${f(c2, 2)}):`);
    for (const [name, sel] of [['low  (near stop)', (r) => r.stopDist / r.target <= c1], ['mid', (r) => r.stopDist / r.target > c1 && r.stopDist / r.target <= c2], ['high (far stop)', (r) => r.stopDist / r.target > c2]]) {
      const x = rows.filter(sel);
      console.log(`    ${name.padEnd(17)} N ${String(x.length).padStart(3)} win ${f(100 * x.filter((r) => r.pnl > 0).length / x.length, 0)}% mean ${money(mean(x.map((r) => r.pnl)))} median ${money(percentile(x.map((r) => r.pnl), 0.5))}`);
    }
    // is the skipped group different from kept events AFTER matching on the stop/target ratio? compare within the high tercile only
    const hi = rows.filter((r) => r.stopDist / r.target > c2), hiS = hi.filter((r) => r.skip), hiK = hi.filter((r) => !r.skip);
    console.log(`    within the far-stop tercile: skipped N ${hiS.length} mean ${money(mean(hiS.map((r) => r.pnl)))} win ${f(100 * hiS.filter((r) => r.pnl > 0).length / (hiS.length || 1), 0)}% | kept N ${hiK.length} mean ${money(mean(hiK.map((r) => r.pnl)))} win ${f(100 * hiK.filter((r) => r.pnl > 0).length / (hiK.length || 1), 0)}%`);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
