import { query } from '../db.js';

export async function logCost({ callType, model, inputTokens, outputTokens, costUsd, sessionDate, referenceId }) {
  await query(
    `INSERT INTO ai_cost_log (call_type, model, input_tokens, output_tokens, cost_usd, session_date, reference_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [callType, model, inputTokens ?? null, outputTokens ?? null, costUsd, sessionDate ?? null, referenceId ?? null]
  );
}

export async function checkAlertThreshold({ io, costUsdJustAdded }) {
  const { rows } = await query(
    `SELECT COALESCE(SUM(cost_usd), 0)::float AS month_total
     FROM ai_cost_log
     WHERE logged_at >= date_trunc('month', NOW())`
  );
  const monthTotal = parseFloat(rows[0].month_total);
  const priorTotal = monthTotal - costUsdJustAdded;
  if (Math.floor(monthTotal / 5) > Math.floor(Math.max(priorTotal, 0) / 5)) {
    const threshold = Math.ceil(monthTotal / 5) * 5;
    io?.emit('ai-cost-alert', {
      threshold,
      month_total: monthTotal,
      message: `AI spend crossed $${threshold} this month ($${monthTotal.toFixed(3)} total)`
    });
  }
}

export async function getMonthlySummary() {
  const { rows } = await query(`
    SELECT
      COALESCE(SUM(CASE WHEN logged_at >= date_trunc('month', NOW()) THEN cost_usd END), 0)::float AS month_total,
      COALESCE(COUNT(CASE WHEN logged_at >= date_trunc('month', NOW()) THEN 1 END), 0)::int         AS month_calls,
      COALESCE(SUM(CASE WHEN logged_at >= NOW() - INTERVAL '7 days' THEN cost_usd END), 0)::float   AS week_total,
      COALESCE(SUM(cost_usd), 0)::float                                                             AS all_time_total
    FROM ai_cost_log
  `);
  const r = rows[0];
  return {
    month_total_usd:   r.month_total,
    month_calls:       r.month_calls,
    this_week_usd:     r.week_total,
    all_time_usd:      r.all_time_total,
    next_alert_at_usd: Math.ceil((r.month_total + 0.001) / 5) * 5,
  };
}
