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

# Check pipeline coverage — any setup_type that has resolved trades in the last 30 days
# but NO SETUP_STATUS row dated within 8 days means it was added without running the pipeline.
export UNCOVERED_SETUPS
UNCOVERED_SETUPS=$(PGPASSWORD=trader123 psql -h localhost -U trader -d trading_journal -t -A -F'|' 2>/dev/null <<'SQLEOF'
SELECT a.setup_type
FROM (
  SELECT DISTINCT setup_type
  FROM active_setups
  WHERE trade_date >= CURRENT_DATE - 30
    AND resolution IN ('TARGET_HIT','STOP_HIT')
) a
WHERE NOT EXISTS (
  SELECT 1 FROM performance_audit
  WHERE signal_type = 'SETUP_STATUS'
    AND signal_name = a.setup_type
    AND run_date >= CURRENT_DATE - 8
);
SQLEOF
)

# Check for orphaned git worktrees — isolation:"worktree" Agent dispatches only get
# auto-cleaned by the harness if the agent made NO changes; otherwise a human/session
# has to explicitly resolve (merge/commit or discard) it. Nothing else in this repo's
# workflow surfaces an orphaned one, so it can sit silently for weeks (found 2026-07-16:
# a 2026-07-01 worktree with ~3,100 uncommitted lines went unnoticed until stumbled on
# by accident during an unrelated dead-code check).
export STRAY_WORKTREES
STRAY_WORKTREES=$(git -C "$REPO" worktree list --porcelain 2>/dev/null | awk -v main="$REPO" '
  /^worktree / { path=$2 }
  /^branch / { if (path != main) print path "|" $2 }
')

# Check RESEARCH_CLAIM ledger (scripts/record_claim.mjs) for claims past their
# next_recheck_due date — the same staleness idea as SETUP_STATUS above, but for
# exploratory/research findings instead of setup calibration.
export OVERDUE_CLAIMS
OVERDUE_CLAIMS=$(PGPASSWORD=trader123 psql -h localhost -U trader -d trading_journal -t -A -F'|' 2>/dev/null <<'SQLEOF'
SELECT p.signal_name, (p.notes::json->>'next_recheck_due') as next_recheck_due, (p.notes::json->>'status') as status
FROM performance_audit p
WHERE p.signal_type = 'RESEARCH_CLAIM'
  AND p.run_date = (SELECT MAX(run_date) FROM performance_audit p2 WHERE p2.signal_type='RESEARCH_CLAIM' AND p2.signal_name = p.signal_name)
  AND (p.notes::json->>'next_recheck_due')::date < CURRENT_DATE
ORDER BY (p.notes::json->>'next_recheck_due')::date;
SQLEOF
)

# trade_feedback setup_id coverage — 2026-07-16. The execution-quality audit
# (docs/OPEN_THREADS.md, RESEARCH_CLAIM execution_quality_audit_blocked_on_attribution)
# concluded fill/slippage and stop/target-discipline can't be measured because
# trade_feedback (the table built specifically to link a real trade to a fired setup)
# had 0 rows with setup_id populated -- the UI component to populate it (TradeFeedbackBar)
# existed but was never mounted. Fixed same day (wired into App.jsx's LiveSessionPanel).
# This check is the other half of closing that loop: once real data exists, say so, so a
# future session actually goes back and re-runs the audit instead of the row count sitting
# unnoticed the same way the component itself sat unmounted.
export FEEDBACK_COVERAGE
FEEDBACK_COVERAGE=$(PGPASSWORD=trader123 psql -h localhost -U trader -d trading_journal -t -A -F'|' 2>/dev/null <<'SQLEOF'
SELECT COUNT(*) FILTER (WHERE setup_id IS NOT NULL), COUNT(*) FROM trade_feedback;
SQLEOF
)

# Fragile DAY_TYPE_MANAGED bucket watch — built 2026-07-16 after the IB_BULLISH regression
# (docs/OPEN_THREADS.md): IB_BULLISH silently un-suppressed from SUPPRESS back to a live
# status on 2026-07-15 because ITS OWN TREND bucket ticked from EV=-$16.24 to EV=-$2.94
# (N=33) -- still negative, still thin, but just barely above the -$5 SUPPRESS_MAX_EV bar,
# so the code's own logic correctly (per its threshold) let it through. A pure
# recompute-and-compare consistency check would NOT have caught this -- the stored value
# matched what the code would derive; the code's own bar was just too blunt for a
# borderline bucket. Nobody noticed for two days because nothing surfaced it. This section
# doesn't re-judge SUPPRESS/live status (that stays backtest_setup_status.mjs's job) -- it
# just makes every DAY_TYPE_MANAGED type's bucket breakdown impossible to miss at the start
# of every session, and calls out any bucket that's the ONLY thing keeping the type off
# SUPPRESS while sitting within $10 of the bar or under N=50 -- both signs of "technically
# passing, not actually trustworthy yet."
export DTM_WATCH
DTM_WATCH=$(PGPASSWORD=trader123 psql -h localhost -U trader -d trading_journal -t -A -F'|' 2>/dev/null <<'SQLEOF'
WITH latest AS (
  SELECT DISTINCT ON (signal_name) signal_name, recommendation, ev_per_trade, sample_size, notes::jsonb as notes
  FROM performance_audit
  WHERE signal_type='SETUP_STATUS'
    AND notes ~ '^\{' AND notes ~ '\}$'
    AND notes::jsonb ? 'day_type_breakdown'
    AND recommendation != 'SUPPRESS'
  ORDER BY signal_name, run_date DESC
)
SELECT l.signal_name, l.ev_per_trade, l.sample_size,
  b->>'day_type' as day_type, (b->>'n')::int as n, (b->>'ev')::float as ev
FROM latest l, jsonb_array_elements(l.notes->'day_type_breakdown') b
ORDER BY l.signal_name, (b->>'ev')::float DESC;
SQLEOF
)

node - <<'JSEOF'
const s = process.env.SERVER_STATUS || 'unknown';
const w = process.env.WATCHER_STATUS || 'unknown';
const n = process.env.ALERT_COUNT || '0';
const last = process.env.LAST_ALERT || '';
const miningRaw = process.env.MINING_STATUS || '';
const uncoveredRaw = process.env.UNCOVERED_SETUPS || '';
const overdueClaimsRaw = process.env.OVERDUE_CLAIMS || '';
const strayWorktreesRaw = process.env.STRAY_WORKTREES || '';
const dtmRaw = process.env.DTM_WATCH || '';
const feedbackCoverageRaw = process.env.FEEDBACK_COVERAGE || '0|0';
const [feedbackWithSetupId, feedbackTotal] = feedbackCoverageRaw.split('|').map(n => parseInt(n, 10) || 0);

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

// Pipeline coverage: setup types with no fresh SETUP_STATUS row
const uncovered = uncoveredRaw.split('\n').filter(Boolean);

// RESEARCH_CLAIM ledger: claims past their next_recheck_due date
const overdueClaims = overdueClaimsRaw.split('\n').filter(Boolean).map(line => {
  const [slug, dueDate, status] = line.split('|');
  return `  ${(slug||'').padEnd(35)} due ${dueDate||'?'} (${status||'?'})`;
});

// Orphaned worktrees: any worktree besides the main repo checkout
const strayWorktrees = strayWorktreesRaw.split('\n').filter(Boolean).map(line => {
  const [path, branch] = line.split('|');
  return `  ${path} (${branch||'?'})`;
});

// DAY_TYPE_MANAGED bucket watch: group rows by signal_name, flag any type whose ONLY
// bucket(s) clearing the -$5 bar are fragile (within $10 of the bar, or N<50).
const dtmRowsByType = {};
for (const line of dtmRaw.split('\n').filter(Boolean)) {
  const [type, blendedEv, blendedN, dayType, n, ev] = line.split('|');
  if (!dtmRowsByType[type]) dtmRowsByType[type] = { blendedEv: parseFloat(blendedEv), blendedN: parseInt(blendedN, 10), buckets: [] };
  dtmRowsByType[type].buckets.push({ dayType, n: parseInt(n, 10), ev: parseFloat(ev) });
}
const dtmLines = [];
let dtmFragile = 0;
for (const [type, data] of Object.entries(dtmRowsByType)) {
  const goodBuckets = data.buckets.filter(b => b.ev >= -5);
  const fragileGood = goodBuckets.filter(b => b.ev < 5 || b.n < 50);
  const isFragile = goodBuckets.length > 0 && fragileGood.length === goodBuckets.length;
  if (isFragile) dtmFragile++;
  const bucketStr = data.buckets.map(b => `${b.dayType} N=${b.n} EV=$${b.ev.toFixed(2)}${fragileGood.some(f => f.dayType === b.dayType) ? ' ⚠️' : ''}`).join(', ');
  dtmLines.push(`  ${isFragile ? '⚠️ ' : '   '}${type.padEnd(15)} blended EV=$${data.blendedEv.toFixed(2)} N=${data.blendedN}  [${bucketStr}]`);
}

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
  uncovered.length > 0
    ? `🔴 PIPELINE COVERAGE GAP — setup types with trades in last 30d but NO fresh SETUP_STATUS row:\n  ${uncovered.join(', ')}\n  ACTION: run node scripts/backtest_setup_status.mjs && node scripts/update_optimal_stops.mjs`
    : '✅ Pipeline coverage: all active setup types have fresh SETUP_STATUS rows',
  '',
  overdueClaims.length > 0
    ? `🔴 RESEARCH_CLAIM LEDGER — ${overdueClaims.length} claim(s) past their recheck date:\n${overdueClaims.join('\n')}\n  ACTION: re-verify each against its source, then node scripts/record_claim.mjs --add '{...}' with the refreshed numbers`
    : '✅ RESEARCH_CLAIM ledger: no claims currently overdue for recheck',
  '',
  strayWorktrees.length > 0
    ? `🔴 ORPHANED WORKTREE(S) — ${strayWorktrees.length} besides the main checkout:\n${strayWorktrees.join('\n')}\n  ACTION: investigate (git -C <path> status / git log), then commit+merge or discard — don't let it sit`
    : '✅ No orphaned worktrees',
  '',
  dtmLines.length > 0
    ? `${dtmFragile > 0 ? '⚠️ ' : '✅'} DAY_TYPE_MANAGED WATCH — live per-day-type-carve-out types, not gated by the standard SUPPRESS check:\n${dtmLines.join('\n')}${dtmFragile > 0 ? `\n  ${dtmFragile} type(s) have ⚠️ flagged buckets — only reason not SUPPRESSed is a bucket within $10 of the bar or N<50. Re-read before trusting; this is exactly how IB_BULLISH regressed 2026-07-15 (docs/OPEN_THREADS.md).` : ''}`
    : '',
  '',
  feedbackWithSetupId >= 20
    ? `🟢 TRADE_FEEDBACK COVERAGE — ${feedbackWithSetupId} rows now have setup_id populated (N≥20 floor cleared). ACTION: re-run the execution-quality audit (fill/slippage, stop/target discipline) — was blocked on this exact gap, see RESEARCH_CLAIM execution_quality_audit_blocked_on_attribution.`
    : `📊 trade_feedback setup_id coverage: ${feedbackWithSetupId}/${feedbackTotal} rows linked to a fired setup (N≥20 needed before the execution-quality audit can re-run — see RESEARCH_CLAIM execution_quality_audit_blocked_on_attribution).`,
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
