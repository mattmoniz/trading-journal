#!/usr/bin/env bash
# SessionStart hook — injects startup context and common shortcuts into every new session.

REPO="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0

export WATCHER_STATUS SERVER_STATUS ALERT_COUNT LAST_ALERT
WATCHER_STATUS=$(systemctl --user is-active trading-journal-watcher.service 2>/dev/null || echo "unknown")
SERVER_STATUS=$(systemctl --user is-active trading-journal-server.service 2>/dev/null || echo "unknown")
ALERT_COUNT=0
LAST_ALERT=""
if [ -f "$REPO/scratch/gemini_alerts.txt" ]; then
  ALERT_COUNT=$(grep -c "^\[" "$REPO/scratch/gemini_alerts.txt" 2>/dev/null || echo 0)
  LAST_ALERT=$(tail -1 "$REPO/scratch/gemini_alerts.txt" 2>/dev/null || echo "")
fi

# Check mining script staleness — query performance_audit for last run_date per signal_type
export MINING_STATUS
MINING_STATUS=$(PGPASSWORD=trader123 psql -h localhost -U trader -d trading_journal -t -A -F'|' 2>/dev/null <<'SQLEOF'
SELECT
  signal_type,
  MAX(run_date)::text AS last_run,
  CURRENT_DATE - MAX(run_date) AS days_ago
FROM performance_audit
WHERE signal_type IN (
  'SESSION_BIAS','DAY_TYPE_ALPHA','CONTEXT_ANALYSIS',
  'SETUP_ANTICIPATION','OPTIMAL_STOP','PERMISSION_SLIP',
  'PULSE_SCORE_AUDIT','SETUP_STATUS'
)
GROUP BY signal_type
ORDER BY days_ago DESC;
SQLEOF
)

node - <<'JSEOF'
const s = process.env.SERVER_STATUS || 'unknown';
const w = process.env.WATCHER_STATUS || 'unknown';
const n = process.env.ALERT_COUNT || '0';
const last = process.env.LAST_ALERT || '';
const miningRaw = process.env.MINING_STATUS || '';

// Parse mining staleness rows: "signal_type|last_run|days_ago"
const miningLines = miningRaw.split('\n').filter(Boolean).map(line => {
  const [sig, date, days] = line.split('|');
  const d = parseInt(days, 10);
  const icon = d <= 8 ? '✅' : d <= 14 ? '⚠️ STALE' : '🔴 OVERDUE';
  return `  ${icon.padEnd(12)} ${(sig||'').padEnd(22)} last: ${date||'never'} (${d}d ago)`;
});
const miningStale = miningRaw.split('\n').filter(Boolean).some(line => {
  const days = parseInt(line.split('|')[2], 10);
  return days > 8;
});

const lines = [
  '=== SESSION START PROTOCOL ===',
  '',
  'IMPORTANT: Read CLAUDE.md and docs/OPEN_THREADS.md before doing anything.',
  'OPEN_THREADS.md has pending work, unconfirmed proposals, and stale stats.',
  '',
  '=== SYSTEM STATUS ===',
  `Trading journal server : ${s}`,
  `Error watcher service  : ${w}`,
  `Gemini alert count     : ${n} lines in scratch/gemini_alerts.txt`,
  last ? `Last alert             : ${last}` : '',
  '',
  `=== MINING SCRIPTS STATUS ${miningStale ? '⚠️  (STALE — re-run needed)' : '(all fresh)'}  ===`,
  ...miningLines,
  miningStale ? '\nACTION: Run stale scripts or check cron logs in scratch/session_bias.log / scratch/weekly_backtests.log' : '',
  '',
  '=== COMMON REQUESTS (things you frequently ask for) ===',
  '',
  "1. CHECK TODAY'S FIRED SETUPS",
  "   curl -s http://localhost:3002/api/setups/today | node -e \"const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); (d.setups||[]).forEach(s=>console.log(s.status?.padEnd(10), s.setup_type?.padEnd(30), s.fired_at?.slice(11,16), s.resolution||''));\"",
  '',
  '2. SEND A TASK TO GEMINI',
  '   Write task to scratch/claude_request.md (include AUTONOMOUS header + read docs/ANTIGRAVITY_CONSTRAINTS.md)',
  '   Then run: ./scripts/invoke_gemini.sh          (15min default)',
  '         or: ./scripts/invoke_gemini.sh 30m      (heavy backtests)',
  '   Output: scratch/antigravity_response.md',
  '   Gemini DB: localhost / gemini_readonly / gemini_ro_2026 / trading_journal (read-only)',
  '',
  '3. CHECK GEMINI ERROR ALERTS',
  '   tail -20 scratch/gemini_alerts.txt',
  '',
  '4. RESTART SERVICES',
  '   systemctl --user restart trading-journal-server.service',
  '   systemctl --user restart trading-journal-watcher.service',
  '',
  '5. MC OPTIMIZER (OPEN_THREADS: needs all-account dataset, never PRO-only)',
  '   node scripts/monte_carlo_optimizer.js',
  '   WARNING: Never let Gemini write to scratch/mc_trades.json',
  '',
  '6. RESTART FULL APP (server + frontend)',
  '   ./start.sh',
  '',
  '7. WEEKLY BACKTEST RE-RUN (or manual)',
  '   node scripts/backtest_unified.js && node scripts/level_fade_audit.mjs && node scripts/audit_mae_mfe.mjs && node scripts/backfill_mae_mfe.mjs && node scripts/update_optimal_stops.mjs',
  '',
  '8. COMPUTE LEVELS FOR TODAY',
  '   node scripts/compute_levels.js',
].join('\n');

console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext: lines
  }
}));
JSEOF
