// Exports every real (origin_status='ACTIVE') live-fired setup for the user's own audit --
// direct answer to "give me a file output with dates/times/levels of entries and exits, plus
// daily/weekly summaries." Deliberately scoped to active_setups (the system's own tracked
// setups), not the trades table (the user's personal discretionary executions) -- the whole
// conversation this export follows from is about auditing the SYSTEM's signals
// (bar6_checkpoint, the exit rule, etc.), not cross-referencing against real trading behavior,
// which CLAUDE.md's own hard rule says never to do without an explicit, separate ask.
//
// Timestamps use TO_CHAR (raw ET wall-clock text), never a JS Date round-trip on fired_at/
// resolved_at -- this codebase has a documented hard rule about exactly this class of bug
// (naive-timestamp reinterpretation shifting times by the ET/UTC offset).

import { query } from '../server/db.js';
import fs from 'fs';

function fmtMoney(v) {
  if (v == null) return '';
  return v.toFixed(2);
}

async function main() {
  const { rows } = await query(`
    SELECT id, trade_date::text as trade_date, setup_type,
      TO_CHAR(fired_at, 'YYYY-MM-DD HH24:MI:SS') as entry_time,
      entry_zone_low::float, entry_zone_high::float,
      stop_level::float, t1_level::float,
      resolution,
      TO_CHAR(resolved_at, 'YYYY-MM-DD HH24:MI:SS') as exit_time,
      price_at_resolution::float, actual_pnl::float, bar6_checkpoint,
      EXTRACT(EPOCH FROM (resolved_at - fired_at)) as resolved_after_fired_secs
    FROM active_setups
    WHERE origin_status = 'ACTIVE' AND resolution IS NOT NULL
    ORDER BY fired_at ASC
  `);
  console.log(`${rows.length} real (ACTIVE-origin) resolved trades found.`);

  // AUDIT FINDING 2026-07-26: 38 of these 150 rows have an exit_time that is mathematically
  // impossible -- resolved_at BEFORE fired_at, off by ~4 hours (matching the EDT/UTC offset),
  // with exact :00-second precision (a live NOW() call always carries microseconds; these
  // don't -- they were not set by a live resolution at all). This is the same "JS Date
  // round-trip through the wrong timezone" bug class already documented and fixed once in
  // resolveSetupsByPrice() for fired_at (found 2026-06-30) -- recurring here in whatever
  // backfill/repair path set resolved_at for these specific rows. NOT investigated/fixed in
  // this pass (out of scope for an audit-file request) -- flagged via OPEN_DECISION
  // active_setups_resolved_at_timezone_bug instead. The exit TIME is flagged unreliable for
  // these rows; entry_time/levels/pnl are unaffected (independently verified -- e.g. target-hit
  // prices land exactly on t1_level, confirming the PRICE data is fine, only the timestamp is
  // wrong).
  for (const r of rows) {
    r.exitTimeReliable = r.resolved_after_fired_secs == null ? null : Number(r.resolved_after_fired_secs) >= 0;
  }
  const unreliableCount = rows.filter(r => r.exitTimeReliable === false).length;
  console.log(`${unreliableCount} rows have a mathematically-impossible exit_time (resolved before fired) -- flagged, not silently trusted.`);

  // --- Line-by-line CSV ---
  const csvHeader = ['id','trade_date','setup_type','direction','entry_time','entry_level','stop_level','target_level','resolution','exit_time','exit_time_reliable','exit_level','pnl','bar6_checkpoint'];
  const csvLines = [csvHeader.join(',')];
  for (const r of rows) {
    const direction = r.setup_type.includes('LONG') || r.setup_type.includes('BULLISH') || r.setup_type.includes('_UP') ? 'LONG' : 'SHORT';
    const entryLevel = r.entry_zone_high != null && r.entry_zone_high !== r.entry_zone_low
      ? (r.entry_zone_low + r.entry_zone_high) / 2 : r.entry_zone_low;
    const exitLevel = r.price_at_resolution;
    const row = [
      r.id, r.trade_date, r.setup_type, direction, r.entry_time,
      entryLevel != null ? entryLevel.toFixed(2) : '',
      r.stop_level != null ? r.stop_level.toFixed(2) : '',
      r.t1_level != null ? r.t1_level.toFixed(2) : '',
      r.resolution, r.exit_time || '',
      r.exitTimeReliable === false ? 'NO -- see audit summary' : (r.exitTimeReliable === true ? 'yes' : ''),
      exitLevel != null ? exitLevel.toFixed(2) : '',
      fmtMoney(r.actual_pnl),
      r.bar6_checkpoint || '',
    ];
    csvLines.push(row.map(v => String(v).includes(',') ? `"${v}"` : v).join(','));
  }
  fs.writeFileSync('scratch/active_setups_audit_trades.csv', csvLines.join('\n'));
  console.log('Wrote scratch/active_setups_audit_trades.csv');

  // --- Daily summary ---
  const byDay = new Map();
  for (const r of rows) {
    if (!byDay.has(r.trade_date)) byDay.set(r.trade_date, []);
    byDay.get(r.trade_date).push(r);
  }
  function summarize(list) {
    const n = list.length;
    const withPnl = list.filter(r => r.actual_pnl != null);
    const wins = withPnl.filter(r => r.actual_pnl > 0);
    const losses = withPnl.filter(r => r.actual_pnl <= 0);
    const total = withPnl.reduce((s, r) => s + r.actual_pnl, 0);
    const noPnl = n - withPnl.length;
    return {
      n, withPnlN: withPnl.length, noPnl,
      wr: withPnl.length ? (wins.length / withPnl.length * 100).toFixed(1) : 'n/a',
      total: total.toFixed(2),
      avgWin: wins.length ? (wins.reduce((s, r) => s + r.actual_pnl, 0) / wins.length).toFixed(2) : 'n/a',
      avgLoss: losses.length ? (losses.reduce((s, r) => s + r.actual_pnl, 0) / losses.length).toFixed(2) : 'n/a',
    };
  }

  function isoWeek(dateStr) {
    const d = new Date(dateStr + 'T12:00:00Z'); // noon UTC avoids DST-edge date-shift issues for a pure calendar-week grouping
    const day = (d.getUTCDay() + 6) % 7; // Mon=0..Sun=6
    const monday = new Date(d);
    monday.setUTCDate(d.getUTCDate() - day);
    return monday.toISOString().slice(0, 10);
  }

  const byWeek = new Map();
  for (const r of rows) {
    const wk = isoWeek(r.trade_date);
    if (!byWeek.has(wk)) byWeek.set(wk, []);
    byWeek.get(wk).push(r);
  }

  const md = [];
  md.push('# Active Setups Audit — Real (ACTIVE-origin) Trades Only\n');
  md.push(`Total: ${rows.length} trades, ${rows[0]?.trade_date} to ${rows[rows.length - 1]?.trade_date}\n`);
  md.push('Scope note: this covers the SYSTEM\'s own live-fired setups (active_setups, origin_status=ACTIVE) -- not your personal discretionary trades table. Ask if you wanted that instead.\n');

  if (unreliableCount > 0) {
    md.push('## ⚠️ Data quality finding from this export -- read before trusting exit_time');
    md.push(`${unreliableCount} of ${rows.length} rows have a mathematically impossible exit_time (resolved_at BEFORE fired_at, off by roughly 4 hours -- consistent with an ET/UTC timezone mixup). All show resolution_method='PRICE_CLEAN' (same as genuinely live-resolved trades) but their exit_time has exact :00 seconds precision -- a live resolution always carries microseconds, so these were NOT set by a real-time resolution at all, likely a backfill/repair script that round-tripped a bar timestamp through a JS Date object incorrectly (the same bug class already fixed once elsewhere in this codebase for a different field, 2026-06-30).`);
    md.push('**What is and is not affected**: entry_time, entry/stop/target levels, exit price (price_at_resolution), and pnl all check out independently (e.g. target-hit exit prices land exactly on the target level) -- only the exit TIMESTAMP itself is wrong for these rows. The `exit_time_reliable` column in the CSV flags exactly which rows this affects. Not investigated/fixed in this pass -- flagged as `OPEN_DECISION` `active_setups_resolved_at_timezone_bug` for a proper follow-up.\n');
  }

  const overall = summarize(rows);
  md.push('## Overall');
  md.push(`- N=${overall.n} (${overall.withPnlN} with a computed PnL, ${overall.noPnl} without -- e.g. SESSION_CLOSED trades that never got a mark-to-market)`);
  md.push(`- WR=${overall.wr}%, Total PnL=$${overall.total}, avgWin=$${overall.avgWin}, avgLoss=$${overall.avgLoss}\n`);

  md.push('## Daily Summary');
  md.push('| Date | N | WR | Total $ | Avg Win | Avg Loss | No-PnL |');
  md.push('|---|---|---|---|---|---|---|');
  for (const d of [...byDay.keys()].sort()) {
    const s = summarize(byDay.get(d));
    md.push(`| ${d} | ${s.n} | ${s.wr}% | $${s.total} | $${s.avgWin} | $${s.avgLoss} | ${s.noPnl} |`);
  }
  md.push('');

  md.push('## Weekly Summary (week starting Monday)');
  md.push('| Week Of | N | WR | Total $ | Avg Win | Avg Loss | No-PnL |');
  md.push('|---|---|---|---|---|---|---|');
  for (const w of [...byWeek.keys()].sort()) {
    const s = summarize(byWeek.get(w));
    md.push(`| ${w} | ${s.n} | ${s.wr}% | $${s.total} | $${s.avgWin} | $${s.avgLoss} | ${s.noPnl} |`);
  }
  md.push('');

  md.push('## Other Pertinent Info');
  const bySetupType = new Map();
  for (const r of rows) {
    if (!bySetupType.has(r.setup_type)) bySetupType.set(r.setup_type, []);
    bySetupType.get(r.setup_type).push(r);
  }
  md.push('### By setup_type');
  md.push('| setup_type | N | WR | Total $ |');
  md.push('|---|---|---|---|');
  for (const [st, list] of [...bySetupType.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const s = summarize(list);
    md.push(`| ${st} | ${s.n} | ${s.wr}% | $${s.total} |`);
  }
  md.push('');

  const bar6Counts = { RECOVERING: 0, DETERIORATING: 0, none: 0 };
  for (const r of rows) {
    if (r.bar6_checkpoint === 'RECOVERING') bar6Counts.RECOVERING++;
    else if (r.bar6_checkpoint === 'DETERIORATING') bar6Counts.DETERIORATING++;
    else bar6Counts.none++;
  }
  md.push(`### bar6_checkpoint distribution`);
  md.push(`- RECOVERING: ${bar6Counts.RECOVERING}, DETERIORATING: ${bar6Counts.DETERIORATING}, not reached bar 6 / resolved early: ${bar6Counts.none}\n`);

  const withPnl = rows.filter(r => r.actual_pnl != null);
  if (withPnl.length) {
    const best = withPnl.reduce((a, b) => (a.actual_pnl > b.actual_pnl ? a : b));
    const worst = withPnl.reduce((a, b) => (a.actual_pnl < b.actual_pnl ? a : b));
    md.push('### Notable outliers');
    md.push(`- Best trade: ${best.setup_type} on ${best.trade_date} (${best.entry_time}), +$${best.actual_pnl.toFixed(2)}`);
    md.push(`- Worst trade: ${worst.setup_type} on ${worst.trade_date} (${worst.entry_time}), $${worst.actual_pnl.toFixed(2)}`);
  }

  const noPnlRows = rows.filter(r => r.actual_pnl == null);
  if (noPnlRows.length) {
    md.push(`\n### Trades with no computed PnL (${noPnlRows.length})`);
    md.push('These resolved via a path that does not currently compute a mark-to-market PnL (mostly `SESSION_CLOSED` -- a known, documented gap, see CLAUDE.md `invalidated_session_closed_setups_never_get_actual_pnl`). Listed here so nothing is silently missing from the audit:');
    for (const r of noPnlRows) md.push(`- ${r.trade_date} ${r.entry_time} — ${r.setup_type} (${r.resolution})`);
  }

  fs.writeFileSync('scratch/active_setups_audit_summary.md', md.join('\n'));
  console.log('Wrote scratch/active_setups_audit_summary.md');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
