// gateMonitorStatus.js -- read-only status of the rotation-gate FORWARD monitor for the quick-check POC Gate tab strip (2026-10-20).
// The nightly/weekly scripts/monitor_rotation_gate_forward.mjs saves its latest tally into the RESEARCH_CLAIM `rotation_gate_forward_monitor_20261020`
// (notes.monitor). This only reads that row -- latest row per signal_name with the id tiebreak (the performance_audit append-only dedup rule).
import { query } from '../db.js';
export const GATE_MONITOR_SLUG = 'rotation_gate_forward_monitor_20261020', GATE_MONITOR_START = '2026-10-21';
export async function getGateMonitorStatus() {
  const r = await query(`SELECT run_date::text d, notes FROM performance_audit WHERE signal_type='RESEARCH_CLAIM' AND signal_name=$1 ORDER BY run_date DESC, id DESC LIMIT 1`, [GATE_MONITOR_SLUG]);
  if (!r.rows.length) return { state: 'NOT_STARTED', forwardStart: GATE_MONITOR_START, note: 'No nightly run has saved a tally yet; the forward window starts ' + GATE_MONITOR_START + '.' };
  let n = r.rows[0].notes; try { if (typeof n === 'string') n = JSON.parse(n); } catch (_) { n = {}; }
  const m = n?.monitor; if (!m) return { state: 'NO_TALLY', forwardStart: GATE_MONITOR_START, savedOn: r.rows[0].d };
  const anyReady = m.rules.some(x => x.ready);
  return { state: anyReady ? 'FIRST_LOOK_REACHED' : 'COLLECTING', savedOn: r.rows[0].d, ...m, daysLeft: Math.max(0, m.minDates - (m.dates || 0)) };
}
