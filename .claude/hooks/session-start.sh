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

node - <<'JSEOF'
const s = process.env.SERVER_STATUS || 'unknown';
const w = process.env.WATCHER_STATUS || 'unknown';
const n = process.env.ALERT_COUNT || '0';
const last = process.env.LAST_ALERT || '';

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
  '   node scripts/backtest_unified.js && node scripts/level_fade_audit.mjs && node scripts/audit_mae_mfe.mjs',
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
