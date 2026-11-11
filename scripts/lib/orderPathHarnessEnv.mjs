// Isolation for order-path tests (Fable audit, 2026-11-10). Import this FIRST, before anything under server/.
//  * database: every statement runs with search_path=harness (a scratch schema inside trading_journal holding copies of only the order-path
//    tables; created by scripts/setup_order_path_harness.sh). Unqualified table names cannot reach the live public schema.
//  * kill switch: the singleton's state file is cwd-relative (scratch/sierra_chart_kill_switch.json), so the process moves into a temp dir.
//  * phone alerts: HA_ALERT_WEBHOOK_URL is blanked so sendAlert() only logs.
//  * broker: the tests only ever hand the code a FakeDtc; nothing here opens a socket.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
export const SANDBOX_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'order-path-harness-'));
fs.mkdirSync(path.join(SANDBOX_DIR, 'scratch'), { recursive: true });
process.chdir(SANDBOX_DIR);
process.env.PGOPTIONS = '-c search_path=harness';
process.env.HA_ALERT_WEBHOOK_URL = '';
for (const k of Object.keys(process.env)) if (k.startsWith('DTC_') && k !== 'DTC_AUTO_REARM_SAFE') delete process.env[k];

export async function assertIsolated() {
  const { query } = await import(path.join(REPO, 'server/db.js'));
  const s = (await query(`SELECT current_schema() AS s, current_setting('search_path') AS sp`)).rows[0];
  if (s.s !== 'harness' || s.sp !== 'harness') throw new Error(`ISOLATION FAILED: current_schema=${s.s} search_path=${s.sp}; refusing to run`);
  const { KILL_SWITCH_STATE_PATH } = await import(path.join(REPO, 'server/services/sierraChart/orderEligibility.js'));
  if (!KILL_SWITCH_STATE_PATH.startsWith(SANDBOX_DIR)) throw new Error(`ISOLATION FAILED: kill switch path ${KILL_SWITCH_STATE_PATH} is outside the sandbox`);
  return { query, KILL_SWITCH_STATE_PATH };
}

export async function resetHarnessTables(query) {
  await query(`TRUNCATE harness.order_placements, harness.order_placements_updates, harness.order_placements_invariant_baseline, harness.gated_candidates, harness.sierra_chart_reconciliation_log, harness.active_setups RESTART IDENTITY CASCADE`);
}
