// Supporting artifact for the 2026-08-05 Opus audit export: one row per setup_type covering
// live status, real vs total N, calibrated stop/target, current EV, and origin_status mix --
// everything needed to judge whether a setup_type's calibration rests on real or synthetic data
// without re-deriving it from scratch.
import fs from 'fs';
import { query } from '../server/db.js';

const OUT_DIR = 'scratch/opus_registry_export';

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const statusQ = await query(`
    SELECT DISTINCT ON (signal_name) signal_name as setup_type, recommendation, sample_size, win_rate, ev_per_trade
    FROM performance_audit WHERE signal_type = 'SETUP_STATUS'
    ORDER BY signal_name, run_date DESC
  `);
  const statusMap = new Map(statusQ.rows.map(r => [r.setup_type, r]));

  const optQ = await query(`
    SELECT DISTINCT ON (signal_name) signal_name as setup_type, optimal_stop, optimal_target, notes
    FROM performance_audit WHERE signal_type = 'OPTIMAL_STOP'
    ORDER BY signal_name, run_date DESC
  `);
  const optMap = new Map(optQ.rows.map(r => [r.setup_type, r]));

  const originQ = await query(`
    SELECT setup_type, origin_status, COUNT(*) as n
    FROM active_setups
    GROUP BY setup_type, origin_status
  `);
  const originMap = new Map(); // setup_type -> { ACTIVE, SHADOW, BACKFILL, UNKNOWN, total }
  for (const r of originQ.rows) {
    if (!originMap.has(r.setup_type)) originMap.set(r.setup_type, { ACTIVE: 0, SHADOW: 0, BACKFILL: 0, UNKNOWN: 0, total: 0 });
    const e = originMap.get(r.setup_type);
    e[r.origin_status] = (e[r.origin_status] || 0) + Number(r.n);
    e.total += Number(r.n);
  }

  const allTypes = new Set([...statusMap.keys(), ...optMap.keys(), ...originMap.keys()]);
  const rows = [];
  for (const st of allTypes) {
    const s = statusMap.get(st);
    const o = optMap.get(st);
    const origin = originMap.get(st) || { ACTIVE: 0, SHADOW: 0, BACKFILL: 0, UNKNOWN: 0, total: 0 };
    const nReal = origin.ACTIVE + origin.SHADOW;
    const nTotal = origin.total;
    const realPct = nTotal > 0 ? +(100 * nReal / nTotal).toFixed(1) : null;
    const isLive = s && !['SUPPRESS', 'THIN_N'].includes(s.recommendation);
    rows.push({
      setup_type: st,
      recommendation: s?.recommendation ?? null,
      isLive: !!isLive,
      blended_sample_size: s?.sample_size ?? null,
      blended_win_rate: s?.win_rate != null ? +Number(s.win_rate).toFixed(3) : null,
      blended_ev_per_trade: s?.ev_per_trade != null ? +Number(s.ev_per_trade).toFixed(2) : null,
      optimal_stop: o?.optimal_stop != null ? +Number(o.optimal_stop).toFixed(1) : null,
      optimal_target: o?.optimal_target != null ? +Number(o.optimal_target).toFixed(1) : null,
      target_method: (() => { try { return JSON.parse(o?.notes || '{}').method ?? null; } catch { return null; } })(),
      n_active: origin.ACTIVE, n_shadow: origin.SHADOW, n_backfill: origin.BACKFILL, n_unknown: origin.UNKNOWN,
      n_real: nReal, n_total: nTotal, real_pct: realPct,
    });
  }
  rows.sort((a, b) => (b.isLive - a.isLive) || (b.n_total - a.n_total));

  fs.writeFileSync(`${OUT_DIR}/setup_types_table.json`, JSON.stringify(rows, null, 2));

  let md = `# Setup Types Table\n\nGenerated ${new Date().toISOString()}. ${rows.length} distinct setup_types (union of SETUP_STATUS, OPTIMAL_STOP, and active_setups rows). Sorted live-first, then by total N descending.\n\n`;
  md += `"Live" = SETUP_STATUS recommendation not in (SUPPRESS, THIN_N). \`n_real\` = ACTIVE+SHADOW origin_status rows (genuinely fired, not backfilled). \`real_pct\` = n_real / n_total.\n\n`;
  md += `| setup_type | live? | recommendation | stop | target | method | EV (blended) | WR (blended) | N (blended) | N real | N total | real% | ACTIVE | SHADOW | BACKFILL | UNKNOWN |\n`;
  md += `|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n`;
  for (const r of rows) {
    md += `| ${r.setup_type} | ${r.isLive ? 'YES' : ''} | ${r.recommendation ?? ''} | ${r.optimal_stop ?? ''} | ${r.optimal_target ?? ''} | ${r.target_method ?? ''} | ${r.blended_ev_per_trade ?? ''} | ${r.blended_win_rate ?? ''} | ${r.blended_sample_size ?? ''} | ${r.n_real} | ${r.n_total} | ${r.real_pct ?? ''} | ${r.n_active} | ${r.n_shadow} | ${r.n_backfill} | ${r.n_unknown} |\n`;
  }
  fs.writeFileSync(`${OUT_DIR}/setup_types_table.md`, md);
  console.log(`Wrote ${OUT_DIR}/setup_types_table.md and .json -- ${rows.length} setup_types, ${rows.filter(r => r.isLive).length} live.`);
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
