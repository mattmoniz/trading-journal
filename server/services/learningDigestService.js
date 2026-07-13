// =============================================================================
// Learning Digest — surfaces what the system learned/changed since the last run,
// so discoveries and parameter drift don't just sit silently in performance_audit
// and pattern_discoveries. Two halves, per the user's explicit ask (2026-07-13):
//   1. NEW patterns crossing significance (pattern_discoveries newly ACTIVE/DEGRADED)
//   2. Meaningful changes to setups already live (OPTIMAL_STOP/SETUP_STATUS/
//      DAY_TYPE_ALPHA drift since the previous run)
//
// "Meaningful" for numeric drift (stop/target) is derived from each setup_type's
// own p75_mae-p50_mae spread that run, not a flat point value — a 5pt move means
// something different for a type whose natural MAE spread is 10pt vs 80pt.
//
// Writes learning_digest_events, and (when called with an `io` instance from the
// server's cron, not the CLI wrapper) emits a 'learning-digest' socket event.
// Sets pattern_discoveries.notified=true for any discovery included — this is the
// fix for the dead notification path found 2026-07-13 (notified was never set
// anywhere in the server).
//
// Cron: 4:35 PM ET Mon-Fri in server/index.js, after update_optimal_stops.mjs
//   (4:20) and the pattern scanner (4:30) both complete for the day.
// CLI:  node scripts/learning_digest.mjs (no socket emission, DB writes only)
// =============================================================================

import { query } from '../db.js';

const SPREAD_FRACTION = 0.25; // a stop/target change must exceed this fraction of the
                               // type's own (p75_mae - p50_mae) spread to be "meaningful"

async function diffOptimalStop() {
  const datesRes = await query(`SELECT DISTINCT run_date FROM performance_audit WHERE signal_type='OPTIMAL_STOP' ORDER BY run_date DESC LIMIT 2`);
  if (datesRes.rows.length < 2) return [];
  const [today, prev] = datesRes.rows.map(r => r.run_date);

  const curRes = await query(`SELECT signal_name, optimal_stop, optimal_target, p50_mae, p75_mae FROM performance_audit WHERE signal_type='OPTIMAL_STOP' AND run_date=$1`, [today]);
  const prevRes = await query(`SELECT signal_name, optimal_stop, optimal_target FROM performance_audit WHERE signal_type='OPTIMAL_STOP' AND run_date=$1`, [prev]);
  const prevMap = Object.fromEntries(prevRes.rows.map(r => [r.signal_name, r]));

  const events = [];
  for (const cur of curRes.rows) {
    const old = prevMap[cur.signal_name];
    if (!old) continue; // new setup_type, not a change
    const spread = Math.max(1, (parseFloat(cur.p75_mae) || 0) - (parseFloat(cur.p50_mae) || 0));
    const threshold = spread * SPREAD_FRACTION;

    const stopDelta = cur.optimal_stop - old.optimal_stop;
    if (Math.abs(stopDelta) > threshold) {
      events.push({
        event_type: 'STOP_CHANGED', signal_name: cur.signal_name,
        old_value: String(old.optimal_stop), new_value: String(cur.optimal_stop),
        magnitude: Math.abs(stopDelta),
        description: `${cur.signal_name} stop ${old.optimal_stop}pt → ${cur.optimal_stop}pt (${stopDelta > 0 ? 'widened' : 'tightened'} ${Math.abs(stopDelta).toFixed(0)}pt)`,
      });
    }
    const targetDelta = cur.optimal_target - old.optimal_target;
    if (Math.abs(targetDelta) > threshold) {
      events.push({
        event_type: 'TARGET_CHANGED', signal_name: cur.signal_name,
        old_value: String(old.optimal_target), new_value: String(cur.optimal_target),
        magnitude: Math.abs(targetDelta),
        description: `${cur.signal_name} target ${old.optimal_target}pt → ${cur.optimal_target}pt`,
      });
    }
  }
  return events;
}

async function diffRecommendationSignal(signalType, label) {
  const datesRes = await query(`SELECT DISTINCT run_date FROM performance_audit WHERE signal_type=$1 ORDER BY run_date DESC LIMIT 2`, [signalType]);
  if (datesRes.rows.length < 2) return [];
  const [today, prev] = datesRes.rows.map(r => r.run_date);

  const curRes = await query(`SELECT signal_name, recommendation, sample_size, ev_per_trade FROM performance_audit WHERE signal_type=$1 AND run_date=$2`, [signalType, today]);
  const prevRes = await query(`SELECT signal_name, recommendation FROM performance_audit WHERE signal_type=$1 AND run_date=$2`, [signalType, prev]);
  const prevMap = Object.fromEntries(prevRes.rows.map(r => [r.signal_name, r.recommendation]));

  const events = [];
  for (const cur of curRes.rows) {
    const old = prevMap[cur.signal_name];
    if (!old || old === cur.recommendation) continue;
    events.push({
      event_type: `${signalType}_CHANGED`, signal_name: cur.signal_name,
      old_value: old, new_value: cur.recommendation,
      magnitude: null,
      description: `${label} ${cur.signal_name}: ${old} → ${cur.recommendation} (N=${cur.sample_size}, EV=$${Math.round(cur.ev_per_trade ?? 0)})`,
    });
  }
  return events;
}

async function newPatternDiscoveries() {
  const events = [];
  const newActive = await query(`SELECT id, pattern_key, dimension, win_rate, sample_size, net_pnl_dollars FROM pattern_discoveries WHERE status='ACTIVE' AND first_seen = CURRENT_DATE AND NOT notified`);
  for (const p of newActive.rows) {
    events.push({
      event_type: 'NEW_PATTERN', signal_name: p.pattern_key,
      old_value: null, new_value: `${Math.round(p.win_rate * 100)}% WR`,
      magnitude: p.sample_size,
      description: `New pattern: ${p.pattern_key} — ${Math.round(p.win_rate * 100)}% WR (N=${p.sample_size}, net $${Math.round(p.net_pnl_dollars)})`,
      _discoveryId: p.id,
    });
  }
  const newDegraded = await query(`SELECT id, pattern_key, win_rate, sample_size FROM pattern_discoveries WHERE status='DEGRADED' AND last_updated = CURRENT_DATE AND NOT notified`);
  for (const p of newDegraded.rows) {
    events.push({
      event_type: 'PATTERN_DEGRADED', signal_name: p.pattern_key,
      old_value: 'ACTIVE', new_value: 'DEGRADED',
      magnitude: p.sample_size,
      description: `Retired: ${p.pattern_key} no longer clears the bar (was ${Math.round(p.win_rate * 100)}% WR, N=${p.sample_size})`,
      _discoveryId: p.id,
    });
  }
  return events;
}

export async function runLearningDigest(io = null) {
  const [optimalStopEvents, setupStatusEvents, dayTypeEvents, patternEvents] = await Promise.all([
    diffOptimalStop(),
    diffRecommendationSignal('SETUP_STATUS', 'Setup status'),
    diffRecommendationSignal('DAY_TYPE_ALPHA', 'Day-type sizing'),
    newPatternDiscoveries(),
  ]);

  const allEvents = [...patternEvents, ...setupStatusEvents, ...dayTypeEvents, ...optimalStopEvents];

  for (const e of allEvents) {
    await query(
      `INSERT INTO learning_digest_events (event_type, signal_name, old_value, new_value, description, magnitude)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [e.event_type, e.signal_name, e.old_value, e.new_value, e.description, e.magnitude]
    );
  }

  const discoveryIds = allEvents.filter(e => e._discoveryId).map(e => e._discoveryId);
  if (discoveryIds.length > 0) {
    await query(`UPDATE pattern_discoveries SET notified=true WHERE id = ANY($1)`, [discoveryIds]);
  }

  if (io && allEvents.length > 0) {
    io.emit('learning-digest', { count: allEvents.length, events: allEvents.map(({ _discoveryId, ...e }) => e) });
  }

  return { count: allEvents.length, breakdown: { pattern: patternEvents.length, setupStatus: setupStatusEvents.length, dayType: dayTypeEvents.length, stopTarget: optimalStopEvents.length } };
}
