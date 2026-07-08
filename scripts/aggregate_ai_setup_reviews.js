/**
 * Aggregate AI_SETUP_REVIEW ratings from performance_audit.
 * Computes per-setup avg rating, trend, and flags setups that need recalibration.
 * Writes AI_CALIBRATION_SUMMARY rows to performance_audit.
 *
 * Run: node scripts/aggregate_ai_setup_reviews.js
 * Wired to: Sunday 9:05 PM ET cron in server/index.js
 *
 * N≥20 required before flagging. Below that, reports accumulation progress only.
 * Recalibration threshold: avg_rating < 3.5 (stop or T1 consistently off).
 */

import { query } from '../server/db.js';
import pool from '../server/db.js';

const MIN_N = 20;
const RECAL_THRESHOLD = 3.5; // avg rating below this = NEEDS_ADJUST

async function aggregateSetupReviews() {
  console.log('[aggregate_ai_setup_reviews] Starting...');

  // Pull all AI_SETUP_REVIEW rows (one per setup per day)
  const { rows } = await query(`
    SELECT signal_name, run_date, win_rate, notes, recommendation
    FROM performance_audit
    WHERE signal_type = 'AI_SETUP_REVIEW'
    ORDER BY signal_name, run_date
  `);

  if (!rows.length) {
    console.log('[aggregate_ai_setup_reviews] No AI_SETUP_REVIEW rows yet — nothing to aggregate');
    return;
  }

  // Group by setup_type
  const bySetup = {};
  for (const row of rows) {
    if (!bySetup[row.signal_name]) bySetup[row.signal_name] = [];
    bySetup[row.signal_name].push({
      date: row.run_date,
      rating: parseFloat(row.win_rate) * 5,  // stored as 0-1, convert back to 1-5
      notes: row.notes,
      recommendation: row.recommendation,
    });
  }

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const results = [];

  for (const [setupType, sessions] of Object.entries(bySetup)) {
    const n = sessions.length;
    const avgRating = sessions.reduce((s, r) => s + r.rating, 0) / n;

    // Trend: last 5 vs first (n-5)
    const recent = sessions.slice(-5);
    const recentAvg = recent.reduce((s, r) => s + r.rating, 0) / recent.length;
    const olderSessions = sessions.slice(0, Math.max(0, n - 5));
    const olderAvg = olderSessions.length
      ? olderSessions.reduce((s, r) => s + r.rating, 0) / olderSessions.length
      : null;
    const trend = olderAvg !== null ? recentAvg - olderAvg : null;

    // Count how often stop vs T1 was flagged
    let stopIssues = 0, t1Issues = 0, entryIssues = 0;
    for (const s of sessions) {
      let parsed = null;
      try { parsed = typeof s.notes === 'string' ? JSON.parse(s.notes) : s.notes; } catch {}
      if (parsed?.stop_verdict && parsed.stop_verdict !== 'CALIBRATED') stopIssues++;
      if (parsed?.t1_verdict && parsed.t1_verdict !== 'CALIBRATED') t1Issues++;
      if (parsed?.entry_quality && parsed.entry_quality !== 'GOOD') entryIssues++;
    }

    const hasEnoughData = n >= MIN_N;
    const flag = hasEnoughData ? (avgRating < RECAL_THRESHOLD ? 'NEEDS_ADJUST' : 'CALIBRATED') : 'ACCUMULATING';

    const summary = {
      n,
      avg_rating: Math.round(avgRating * 10) / 10,
      recent_avg: Math.round(recentAvg * 10) / 10,
      trend_delta: trend !== null ? Math.round(trend * 10) / 10 : null,
      stop_issues: stopIssues,
      t1_issues: t1Issues,
      entry_issues: entryIssues,
      flag,
      min_n_required: MIN_N,
    };

    results.push({ setupType, ...summary });

    // Write/update AI_CALIBRATION_SUMMARY row
    await query(`
      INSERT INTO performance_audit
        (run_date, window_days, signal_type, signal_name, sample_size, win_rate, notes, recommendation)
      VALUES ($1, 1, 'AI_SETUP_AGG', $2, $3, $4, $5, $6)
      ON CONFLICT (run_date, window_days, signal_type, signal_name)
        DO UPDATE SET sample_size=$3, win_rate=$4, notes=$5, recommendation=$6
    `, [
      today,
      setupType,
      n,
      avgRating / 5,  // store as 0-1
      JSON.stringify(summary),
      flag,
    ]);

    const trendStr = trend !== null ? ` trend${trend >= 0 ? '+' : ''}${trend.toFixed(1)}` : '';
    const dataStr = hasEnoughData ? `avg=${avgRating.toFixed(1)}⭐${trendStr}` : `N=${n}/${MIN_N} accumulating`;
    console.log(`  ${flag.padEnd(12)} ${setupType.padEnd(30)} ${dataStr}`);
  }

  // Print setups needing adjustment (if any N≥20)
  const needsAdjust = results.filter(r => r.flag === 'NEEDS_ADJUST');
  if (needsAdjust.length) {
    console.log(`\n⚠  ${needsAdjust.length} setup(s) need recalibration (avg < ${RECAL_THRESHOLD}⭐):`);
    for (const r of needsAdjust) {
      console.log(`   ${r.setupType}: avg ${r.avg_rating}⭐ (N=${r.n}, stop_issues=${r.stop_issues}, t1_issues=${r.t1_issues})`);
    }
  }

  const accumulating = results.filter(r => r.flag === 'ACCUMULATING');
  console.log(`\n[aggregate_ai_setup_reviews] Done — ${results.length} setups (${accumulating.length} still accumulating N≥${MIN_N})`);
}

aggregateSetupReviews().catch(e => { console.error(e); process.exit(1); }).finally(() => pool.end());
