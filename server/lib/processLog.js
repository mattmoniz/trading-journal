import { query } from '../db.js';

export async function logProcess(name, fn) {
  let logId;
  try {
    const r = await query(
      `INSERT INTO process_log (process_name, started_at, status) VALUES ($1, NOW(), 'RUNNING') RETURNING id`,
      [name]
    );
    logId = r.rows[0].id;
  } catch (err) {
    console.error(`[processLog] Failed to create log entry for ${name}:`, err.message);
  }

  try {
    const result = await fn();
    if (logId) {
      await query(
        `UPDATE process_log SET status='SUCCESS', completed_at=NOW(), records_affected=$1, metadata=$2 WHERE id=$3`,
        [result?.count ?? 0, JSON.stringify(result ?? {}), logId]
      ).catch(() => {});
    }
    return result;
  } catch (err) {
    if (logId) {
      await query(
        `UPDATE process_log SET status='FAILED', completed_at=NOW(), error_message=$1 WHERE id=$2`,
        [err.message, logId]
      ).catch(() => {});
    }
    throw err;
  }
}
