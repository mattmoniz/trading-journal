/**
 * Aggregate behavioral theme frequencies from daily_coaching text.
 * Uses BEHAVIOR_THEMES keyword matching (same as daily_coaching.js).
 * Writes BEHAVIORAL_STATS rows to performance_audit — one per theme.
 *
 * Run: node scripts/aggregate_behavioral_stats.js
 * Wired to: Sunday 9:05 PM ET cron in server/index.js (same run as aggregate_ai_setup_reviews.js)
 *
 * Output shape per theme:
 *   signal_name = theme label (e.g. 'annotation_gaps')
 *   sample_size = total sessions analyzed
 *   win_rate = frequency (sessions with theme / total sessions)
 *   notes = JSON with weekly_counts[], rolling_30d, rolling_10d, rolling_trend
 */

import { query } from '../server/db.js';
import pool from '../server/db.js';

const BEHAVIOR_THEMES = [
  ['annotation_gaps',         'annotation', 'unannotated', 'no note', 'no fill id', 'add your read'],
  ['overtrading_after_11am',  'after 11', 'post-11', 'overtrade', 'overtraded', 'too many fills', 'late session'],
  ['late_entries_chasing',    'late entr', 'chased', 'chasing', 'between levels', 'no level'],
  ['fading_valid_signal',     'fading a valid', 'against the signal', 'fought the signal', 'against a live'],
  ['annotation_quality',      'gut_read', 'gut read', 'no level price', 'unverifiable'],
  ['missed_setups',           'no fills captured', 'sat out', 'setups resolved with no fill', 'stayed out'],
  ['give_back_pattern',       'give-back', 'gave back', 'peak intraday', 'peak pnl'],
];

function matchesTheme(text, keywords) {
  const lower = text.toLowerCase();
  return keywords.some(kw => lower.includes(kw));
}

function getWeekLabel(dateStr) {
  // Week starting Monday: round down to Monday
  const d = new Date(dateStr + 'T12:00:00Z');
  const day = d.getUTCDay(); // 0=Sun
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() - (day === 0 ? 6 : day - 1));
  return monday.toISOString().slice(0, 10);
}

async function aggregateBehavioralStats() {
  console.log('[aggregate_behavioral_stats] Starting...');

  const { rows } = await query(`
    SELECT session_date::text as session_date, coaching_text
    FROM daily_coaching
    WHERE coaching_text IS NOT NULL
      AND length(coaching_text) > 50
      AND coaching_text NOT ILIKE '%unavailable%'
    ORDER BY session_date
  `);

  if (rows.length < 5) {
    console.log(`[aggregate_behavioral_stats] Only ${rows.length} sessions — not enough to trend yet`);
    return;
  }

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const totalSessions = rows.length;

  for (const [themeLabel, ...keywords] of BEHAVIOR_THEMES) {
    // Per-session boolean
    const sessionHits = rows.map(r => ({
      date: r.session_date,
      week: getWeekLabel(r.session_date),
      hit: matchesTheme(r.coaching_text, keywords),
    }));

    // Weekly counts
    const weekMap = {};
    for (const s of sessionHits) {
      if (!weekMap[s.week]) weekMap[s.week] = { total: 0, hits: 0 };
      weekMap[s.week].total++;
      if (s.hit) weekMap[s.week].hits++;
    }
    const weeklyCounts = Object.entries(weekMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([week, { total, hits }]) => ({ week, sessions: total, occurrences: hits, rate: Math.round(hits / total * 100) / 100 }));

    // Rolling windows
    const last30 = sessionHits.slice(-30);
    const last10 = sessionHits.slice(-10);
    const rolling30 = last30.filter(s => s.hit).length / last30.length;
    const rolling10 = last10.filter(s => s.hit).length / last10.length;
    const allTime = sessionHits.filter(s => s.hit).length / totalSessions;

    // Trend: is the last 10 sessions worse than prior 20?
    const prior20 = sessionHits.slice(-30, -10);
    const prior20Rate = prior20.length ? prior20.filter(s => s.hit).length / prior20.length : null;
    const trend = prior20Rate !== null ? rolling10 - prior20Rate : null;
    const trendLabel = trend === null ? 'insufficient_data'
      : trend > 0.10 ? 'WORSENING'
      : trend < -0.10 ? 'IMPROVING'
      : 'STABLE';

    const notes = {
      rolling_10d: Math.round(rolling10 * 100) / 100,
      rolling_30d: Math.round(rolling30 * 100) / 100,
      all_time: Math.round(allTime * 100) / 100,
      trend: trendLabel,
      trend_delta: trend !== null ? Math.round(trend * 100) / 100 : null,
      total_sessions: totalSessions,
      weekly_counts: weeklyCounts.slice(-12),  // last 12 weeks
    };

    await query(`
      INSERT INTO performance_audit
        (run_date, window_days, signal_type, signal_name, sample_size, win_rate, notes, recommendation)
      VALUES ($1, 30, 'BEHAVIORAL_STATS', $2, $3, $4, $5, $6)
      ON CONFLICT (run_date, window_days, signal_type, signal_name)
        DO UPDATE SET sample_size=$3, win_rate=$4, notes=$5, recommendation=$6
    `, [
      today,
      themeLabel,
      totalSessions,
      allTime,
      JSON.stringify(notes),
      trendLabel,
    ]);

    const pct = Math.round(allTime * 100);
    const trend10Pct = Math.round(rolling10 * 100);
    console.log(`  ${trendLabel.padEnd(12)} ${themeLabel.padEnd(28)} all=${pct}%  last10=${trend10Pct}%  (N=${totalSessions})`);
  }

  console.log(`[aggregate_behavioral_stats] Done — ${BEHAVIOR_THEMES.length} themes written for ${totalSessions} sessions`);
}

aggregateBehavioralStats().catch(e => { console.error(e); process.exit(1); }).finally(() => pool.end());
