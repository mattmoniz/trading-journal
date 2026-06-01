import express from 'express';
import { query } from '../db.js';

const router = express.Router();

// Compute current daily P&L per account vs DLL config
export async function computeDLLStatus(dateStr = null) {
  const targetDate = dateStr || new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  const [settingsQ, pnlQ, dlrQ] = await Promise.all([
    query('SELECT account_id, daily_loss_limit, dll_removed_count, last_dll_removal FROM account_settings ORDER BY account_id'),
    query(`
      SELECT custom_fields->>'account' as account, SUM(pnl) as daily_pnl, COUNT(*) as trade_count
      FROM trades WHERE log_date = $1
      GROUP BY custom_fields->>'account'
    `, [targetDate]),
    // Check prior day's last EP CumPL for the diff approach (fallback to SUM if unavailable)
    query(`
      SELECT DISTINCT ON (custom_fields->>'account')
        custom_fields->>'account' as account,
        (custom_fields->'sierra_data'->>'Cumulative Profit/Loss (C)')::numeric as cum_pl
      FROM trades
      WHERE log_date < $1
        AND custom_fields->'sierra_data'->>'Exit DateTime' LIKE '% EP'
        AND custom_fields->'sierra_data'->>'Cumulative Profit/Loss (C)' ~ '^-?[0-9]+(\\.[0-9]+)?$'
      ORDER BY custom_fields->>'account', exit_time DESC
    `, [targetDate]),
  ]);

  const pnlByAccount = {};
  for (const row of pnlQ.rows) {
    if (row.account) pnlByAccount[row.account] = { pnl: parseFloat(row.daily_pnl) || 0, trades: parseInt(row.trade_count) || 0 };
  }

  const accounts = settingsQ.rows.map(s => {
    const acct = pnlByAccount[s.account_id] || { pnl: 0, trades: 0 };
    const pnl = acct.pnl;
    const dll = parseFloat(s.daily_loss_limit);
    const pctUsed = dll > 0 ? Math.min(1, Math.max(0, -pnl) / dll) : 0;
    const dllHit = pnl <= -dll;
    const dllWarning = !dllHit && pnl <= -(dll - 50);
    return {
      account_id: s.account_id,
      daily_loss_limit: dll,
      daily_pnl: pnl,
      trade_count: acct.trades,
      pct_used: pctUsed,
      dll_hit: dllHit,
      dll_warning: dllWarning,
      dll_removed_count: s.dll_removed_count || 0,
      last_dll_removal: s.last_dll_removal,
    };
  });

  return {
    date: targetDate,
    accounts,
    anyDllHit: accounts.some(a => a.dll_hit),
    anyDllWarning: accounts.some(a => a.dll_warning),
    hitsAccounts: accounts.filter(a => a.dll_hit),
    warnAccounts: accounts.filter(a => a.dll_warning),
  };
}

// Record a DLL removal attempt for an account (within $50 of limit and still trading)
export async function trackDLLApproach(accountId) {
  const nowET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  // Only count once per day per account
  const existing = await query(
    `SELECT last_dll_removal FROM account_settings WHERE account_id = $1`,
    [accountId]
  );
  if (!existing.rows.length) return;
  const lastRemoval = existing.rows[0].last_dll_removal;
  if (lastRemoval) {
    const lastDate = new Date(lastRemoval).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    if (lastDate === nowET) return; // already logged today
  }
  await query(`
    UPDATE account_settings
    SET dll_removed_count = dll_removed_count + 1, last_dll_removal = NOW(), updated_at = NOW()
    WHERE account_id = $1
  `, [accountId]);
}

// Check DLL after each bar ingest or trade import; emit socket event if needed
export async function checkAndEmitDLL(io, dateStr = null) {
  try {
    const status = await computeDLLStatus(dateStr);
    if (io) io.emit('dll-status', status);

    // Track approach attempts for warning-zone accounts with trades today
    for (const acct of status.warnAccounts) {
      if (acct.trade_count > 0) {
        await trackDLLApproach(acct.account_id);
      }
    }

    return status;
  } catch (err) {
    console.error('[dll] checkAndEmitDLL error:', err.message);
    return null;
  }
}

// GET /api/dll/status
router.get('/dll/status', async (req, res) => {
  try {
    const status = await computeDLLStatus(req.query.date);
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/eval/progress — eval pass probability for active EVALUATION accounts
export async function computeEvalProgress() {
  const PASS_TARGET = 3000;
  const rows = await query(`
    SELECT
      a.account_id,
      a.daily_loss_limit,
      a.account_stage,
      COALESCE(SUM(t.pnl), 0)::numeric as current_pnl,
      COUNT(DISTINCT t.log_date)::int as days_traded,
      MAX(t.log_date) as last_trade_date
    FROM account_settings a
    LEFT JOIN trades t ON t.custom_fields->>'account' = a.account_id
    WHERE a.account_stage = 'EVALUATION'
    GROUP BY a.account_id, a.daily_loss_limit, a.account_stage
    HAVING MAX(t.log_date) >= CURRENT_DATE - INTERVAL '30 days'
       OR COUNT(t.log_date) = 0
    ORDER BY a.account_id
  `);

  return rows.rows.map(r => {
    const pnl = parseFloat(r.current_pnl) || 0;
    const days = r.days_traded || 0;
    const dll = parseFloat(r.daily_loss_limit) || 400;
    const needed = PASS_TARGET - pnl;
    const avgDaily = days > 0 ? pnl / days : 0;
    const daysToTarget = avgDaily > 0 ? Math.round(needed / avgDaily) : null;
    const shortId = r.account_id.split('-').pop() || r.account_id;
    const onTrack = daysToTarget != null && daysToTarget <= 30 && daysToTarget > 0;
    const dllRisk = pnl <= -(dll - 50);

    // Trajectory label
    let trajectory, trajectoryColor;
    if (pnl >= PASS_TARGET) {
      trajectory = 'PASSED'; trajectoryColor = '#22c55e';
    } else if (dllRisk) {
      trajectory = 'DLL RISK'; trajectoryColor = '#ef4444';
    } else if (avgDaily <= 0) {
      trajectory = 'OFF TRACK'; trajectoryColor = '#ef4444';
    } else if (onTrack) {
      trajectory = `~${daysToTarget}d to pass`; trajectoryColor = '#22c55e';
    } else {
      trajectory = `${daysToTarget}d at this rate`; trajectoryColor = '#f59e0b';
    }

    return {
      account_id: r.account_id,
      short_id: shortId,
      current_pnl: pnl,
      profit_needed: needed,
      days_traded: days,
      avg_daily_pnl: Math.round(avgDaily * 100) / 100,
      days_to_target: daysToTarget,
      on_track: onTrack,
      dll_risk: dllRisk,
      trajectory,
      trajectory_color: trajectoryColor,
      last_trade_date: r.last_trade_date,
    };
  });
}

router.get('/eval/progress', async (req, res) => {
  try {
    const accounts = await computeEvalProgress();
    res.json({ accounts, passTarget: 3000 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/dll/weekly-summary
router.get('/dll/weekly-summary', async (req, res) => {
  try {
    const { weekStart } = req.query;
    const rows = await query(`
      SELECT account_id, dll_removed_count, last_dll_removal
      FROM account_settings
      ORDER BY account_id
    `);
    // Count approach attempts this week
    const start = weekStart || new Date(Date.now() - 7 * 86400000).toLocaleDateString('en-CA');
    let weekAttempts = 0;
    for (const r of rows.rows) {
      if (r.last_dll_removal) {
        const lastDate = new Date(r.last_dll_removal).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
        if (lastDate >= start) weekAttempts++;
      }
    }
    res.json({
      accounts: rows.rows,
      weekAttempts,
      totalRemovals: rows.rows.reduce((s, r) => s + (r.dll_removed_count || 0), 0),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
