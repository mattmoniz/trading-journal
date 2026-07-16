// Direct heartbeat for server/index.js's 15s autonomous setup-detection poller.
//
// Built 2026-07-16 (docs/OPEN_THREADS.md, "detection latency" thread) after finding
// /api/settings/process-health's SETUP_DETECTION entry only ever measured bar
// freshness (MAX(ts) FROM price_bars_primary) as a PROXY for "did detection actually
// run" -- it never measured whether the poll's own fetch call succeeded. That proxy
// can't distinguish "detection genuinely stopped" from "bars just haven't ticked yet";
// it's exactly the kind of gap that left the real July 13 ~1-hour detection gap with
// no root cause (no server logs survived the journal rotation, and nothing had
// persisted a durable, direct record of poll success/failure to the DB).
//
// State lives in memory (cheap, no DB write on every 15s poll) but transitions
// (healthy->failing, failing->recovered) get a durable process_log row, so a future
// gap has an actual record to investigate instead of relying on ephemeral logs.
import { query } from '../db.js';

// In-memory JS Date values here are ONLY ever used for in-process duration math
// (comparing two Dates taken from the same process clock) -- never written directly
// into a DB timestamp column. All DB writes use NOW() (evaluated server-side by
// Postgres), matching server/lib/processLog.js's existing convention -- sidesteps
// the documented ET/UTC JS-Date-serialization footgun entirely (CLAUDE.md: "Never
// parse a naive timestamp string with new Date(str).toISOString()") rather than
// risk reproducing a version of it here.
const state = {
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastError: null,
  consecutiveFailures: 0,
  failingSinceMs: null,
  outageLogId: null,
};

export function getDetectionHeartbeat() {
  const { failingSinceMs, outageLogId, ...pub } = state;
  return pub;
}

export async function recordDetectionPollResult(ok, errorMessage) {
  state.lastAttemptAt = Date.now();

  if (ok) {
    if (state.consecutiveFailures > 0) {
      // Recovery -- close out the outage row opened below with the real duration,
      // rather than just noting "it's fine now" with no record of how long it wasn't.
      const outageDurationSec = state.failingSinceMs ? Math.round((Date.now() - state.failingSinceMs) / 1000) : null;
      if (state.outageLogId) {
        await query(`
          UPDATE process_log SET status='RECOVERED', completed_at=NOW(), records_affected=$1, metadata=$2
          WHERE id=$3
        `, [state.consecutiveFailures, JSON.stringify({ outageDurationSec }), state.outageLogId])
          .catch(e => console.error('[detection-heartbeat] failed to log recovery:', e.message));
      }
    }
    state.lastSuccessAt = Date.now();
    state.lastError = null;
    state.consecutiveFailures = 0;
    state.failingSinceMs = null;
    state.outageLogId = null;
    return;
  }

  state.lastError = errorMessage;
  state.consecutiveFailures++;
  if (state.consecutiveFailures === 1) state.failingSinceMs = Date.now();

  // Log at 3 consecutive failures (~45s of real outage, not a single transient blip)
  // and don't spam a new row every poll after that -- one row per outage, opened here,
  // closed by the recovery branch above with the real duration.
  if (state.consecutiveFailures === 3) {
    try {
      const r = await query(`
        INSERT INTO process_log (process_name, started_at, status, error_message, metadata)
        VALUES ('SETUP_DETECTION_POLL', NOW(), 'FAILING', $1, $2) RETURNING id
      `, [errorMessage, JSON.stringify({ consecutiveFailures: state.consecutiveFailures })]);
      state.outageLogId = r.rows[0]?.id ?? null;
    } catch (e) { console.error('[detection-heartbeat] failed to log outage start:', e.message); }
  }
}
