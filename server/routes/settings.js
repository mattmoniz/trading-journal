import express from 'express';
import fs from 'fs';
import { query } from '../db.js';
import { computeDLLStatus } from './dll.js';

const SIERRA_TAL_DIR = '/mnt/c/SierraChart/SavedTradeActivity/';

const router = express.Router();

// ─── Process Schedule Definition ─────────────────────────────────────────────

const PROCESS_SCHEDULE = [
  { name: 'MORNING_BRIEF',       label: 'Morning Brief',            schedule: '7:00 AM ET Mon-Fri',        expectedDays: ['Mon','Tue','Wed','Thu','Fri'], scheduledHour: 7,  maxAgeHours: 25,  critical: true  },
  { name: 'AUTO_IMPORT_4PM',     label: 'Sierra Chart Auto-Import', schedule: '4:00 PM ET Mon-Fri',        expectedDays: ['Mon','Tue','Wed','Thu','Fri'], scheduledHour: 16, maxAgeHours: 25,  critical: true  },
  { name: 'PATTERN_MEMORY',      label: 'Pattern Memory Update',    schedule: '4:05 PM ET Mon-Fri',        expectedDays: ['Mon','Tue','Wed','Thu','Fri'], scheduledHour: 16, maxAgeHours: 25,  critical: true  },
  { name: 'DAILY_COACHING',      label: 'Daily Coaching Review',    schedule: '4:45 PM ET Mon-Fri',        expectedDays: ['Mon','Tue','Wed','Thu','Fri'], scheduledHour: 16, maxAgeHours: 25,  critical: true  },
  { name: 'WEEKLY_REPORT',       label: 'Weekly Report',            schedule: '6:00 PM ET Sunday',         expectedDays: ['Sun'],                         scheduledHour: 18, maxAgeHours: 170, critical: false },
  { name: 'WEEKLY_ASSESSMENT',   label: 'Weekly Assessment',        schedule: '6:05 PM ET Sunday',         expectedDays: ['Sun'],                         scheduledHour: 18, maxAgeHours: 170, critical: false },
  { name: 'COMBO_BACKTEST',      label: 'Combo Level Backtest',     schedule: '6:30 PM ET Sunday',         expectedDays: ['Sun'],                         scheduledHour: 18, maxAgeHours: 170, critical: false },
  { name: 'MONTHLY_REPORT',      label: 'Monthly Report',           schedule: '7:00 PM ET First Sunday',   expectedDays: ['Sun'],                         scheduledHour: 19, maxAgeHours: 750, critical: false, firstSundayOnly: true },
  { name: 'DEVELOPING_VALUE',     label: 'Developing Value Tracker', schedule: '4:05 PM ET Mon-Fri',        expectedDays: ['Mon','Tue','Wed','Thu','Fri'], scheduledHour: 16, maxAgeHours: 25,  critical: true  },
  { name: 'REGIME_LEVELS',       label: 'Regime-Adaptive Levels',   schedule: '5:30 PM ET Mon-Fri',        expectedDays: ['Mon','Tue','Wed','Thu','Fri'], scheduledHour: 17, maxAgeHours: 25,  critical: false },
  { name: 'MAE_MFE_AUDIT',       label: 'MAE/MFE System Audit',     schedule: 'Monthly (1st Sunday)',      expectedDays: ['Sun'],                         scheduledHour: 20, maxAgeHours: 750, critical: false, firstSundayOnly: true },
  { name: 'LEVEL_FADE_AUDIT',    label: 'Level Fade Backtest',      schedule: 'Monthly (1st Sunday)',      expectedDays: ['Sun'],                         scheduledHour: 20, maxAgeHours: 750, critical: false, firstSundayOnly: true },
  { name: 'SYSTEM_BACKTEST',     label: 'Full System Backtest',     schedule: 'Monthly (1st Sunday)',      expectedDays: ['Sun'],                         scheduledHour: 21, maxAgeHours: 750, critical: false, firstSundayOnly: true },
  { name: 'BAR_INGEST',          label: 'Sierra Chart Bar Sync',    schedule: 'Every 60s during RTH',      expectedDays: ['Mon','Tue','Wed','Thu','Fri'], maxAgeMinutes: 5, critical: true,  isLive: true },
  { name: 'SETUP_DETECTION',     label: 'Setup Detection',          schedule: 'On each bar insert',        expectedDays: ['Mon','Tue','Wed','Thu','Fri'], maxAgeMinutes: 5, critical: true,  isLive: true },
];

const DAY_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

function getETNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
}

function statusColor(proc, lastRun, lastStatus, nowET) {
  const todayName = DAY_NAMES[nowET.getDay()];
  const expectedToday = proc.expectedDays.includes(todayName) && (!proc.firstSundayOnly || nowET.getDate() <= 7);
  const etH = nowET.getHours(), etM = nowET.getMinutes();

  if (proc.isLive) {
    if (!expectedToday) return 'gray';
    const duringHours = (etH > 9 || (etH === 9 && etM >= 30)) && etH < 16;
    if (!duringHours) return 'green'; // outside RTH, live checks not required
    if (!lastRun) return 'red';
    const ageMs = nowET - new Date(lastRun);
    const maxMs = (proc.maxAgeMinutes || 5) * 60000;
    if (ageMs > maxMs * 2) return 'red';
    if (ageMs > maxMs) return 'amber';
    return 'green';
  }

  if (!expectedToday) {
    if (!lastRun) return 'gray';
    if (lastStatus === 'FAILED') return 'red';
    // Not expected to run today (e.g. weekend for a Mon-Fri job) — only flag red if
    // the most recent day it WAS expected to run is more recent than the last run.
    for (let i = 1; i <= 7; i++) {
      const d = new Date(nowET);
      d.setDate(d.getDate() - i);
      const dayName = DAY_NAMES[d.getDay()];
      if (!proc.expectedDays.includes(dayName)) continue;
      if (proc.firstSundayOnly && d.getDate() > 7) continue;
      d.setHours(proc.scheduledHour ?? 0, 0, 0, 0);
      return (new Date(lastRun) >= d) ? 'green' : 'red';
    }
    return 'green';
  }

  // Expected today — only flag RED if scheduled time has passed
  const dueTodayPassed = proc.scheduledHour == null || etH >= proc.scheduledHour;

  if (!lastRun) {
    return dueTodayPassed ? 'red' : 'gray'; // not yet due → gray, overdue → red
  }

  if (lastStatus === 'FAILED') return 'red';

  const ageHours = (nowET - new Date(lastRun)) / 3600000;
  if (ageHours > (proc.maxAgeHours || 25)) {
    return dueTodayPassed ? 'red' : 'amber'; // stale but not yet due again → amber
  }
  if (ageHours > (proc.maxAgeHours || 25) * 0.8) return 'amber';
  return 'green';
}

function fmtDuration(startedAt, completedAt) {
  if (!startedAt || !completedAt) return null;
  const ms = new Date(completedAt) - new Date(startedAt);
  if (ms < 0) return null;
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60000)}m`;
}

function fmtTime(ts, nowET) {
  if (!ts) return null;
  const d = new Date(ts);
  const diffH = (nowET - d) / 3600000;
  if (diffH < 24) {
    return d.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }) + ' ET';
  }
  return d.toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' });
}

// ─── GET /api/settings/process-health ────────────────────────────────────────

router.get('/settings/process-health', async (req, res) => {
  try {
    const nowET = getETNow();
    const todayET = nowET.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

    // Fetch latest run for each non-live process
    const processNames = PROCESS_SCHEDULE.filter(p => !p.isLive).map(p => p.name);
    // Cast timestamps to timestamptz so pg parses them correctly regardless of DB timezone
    const logsQ = await query(`
      SELECT DISTINCT ON (process_name) process_name,
        (started_at AT TIME ZONE 'America/New_York')   as started_at,
        (completed_at AT TIME ZONE 'America/New_York') as completed_at,
        status, records_affected, error_message
      FROM process_log WHERE process_name = ANY($1)
      ORDER BY process_name, started_at DESC
    `, [processNames]);
    const logsByName = Object.fromEntries(logsQ.rows.map(r => [r.process_name, r]));

    // Fallback: for manual-script processes (SYSTEM_BACKTEST, MAE_MFE_AUDIT, LEVEL_FADE_AUDIT),
    // if process_log has no row, check performance_audit.run_date directly.
    // Manual node script runs bypass logProcess() so they never write to process_log.
    const manualScriptTypes = { SYSTEM_BACKTEST: 'SYSTEM_BACKTEST', MAE_MFE_AUDIT: 'MAE_MFE_AUDIT', LEVEL_FADE_AUDIT: 'LEVEL_FADE_AUDIT' };
    const paFallbackQ = await query(`
      SELECT signal_type, MAX(run_date)::text as last_run
      FROM performance_audit
      WHERE signal_type = ANY($1)
      GROUP BY signal_type
    `, [Object.values(manualScriptTypes)]).catch(() => ({ rows: [] }));
    const paFallback = Object.fromEntries(paFallbackQ.rows.map(r => [r.signal_type, r.last_run]));

    // Fetch last 5 runs per process for detail view
    const detailQ = await query(`
      SELECT process_name,
        (started_at AT TIME ZONE 'America/New_York')   as started_at,
        (completed_at AT TIME ZONE 'America/New_York') as completed_at,
        status, records_affected, error_message,
        id, ROW_NUMBER() OVER (PARTITION BY process_name ORDER BY started_at DESC) as rn
      FROM process_log WHERE process_name = ANY($1)
    `, [processNames]);
    const detailByName = {};
    for (const r of detailQ.rows) {
      if (r.rn <= 5) {
        if (!detailByName[r.process_name]) detailByName[r.process_name] = [];
        detailByName[r.process_name].push(r);
      }
    }

    // Live process checks — both use MAX(ts) from price_bars
    // SETUP_DETECTION runs on every bar insert, so bar freshness = detection freshness
    const barQ = await query(
      `SELECT MAX(ts)::text as last_bar FROM price_bars_primary WHERE symbol='NQ' AND ts::date = $1`, [todayET]
    );
    const lastBar = barQ.rows[0]?.last_bar || null;

    const liveData = {
      BAR_INGEST:      { lastRun: lastBar, lastStatus: lastBar ? 'SUCCESS' : null },
      SETUP_DETECTION: { lastRun: lastBar, lastStatus: lastBar ? 'SUCCESS' : null },
    };

    const processes = PROCESS_SCHEDULE.map(proc => {
      let lastRun = null, lastStatus = null, lastDuration = null, recordsAffected = null, errorMessage = null;
      if (proc.isLive) {
        const ld = liveData[proc.name] || {};
        lastRun = ld.lastRun; lastStatus = ld.lastStatus;
      } else {
        const row = logsByName[proc.name];
        if (row) {
          lastRun = row.started_at;
          lastStatus = row.status;
          lastDuration = fmtDuration(row.started_at, row.completed_at);
          recordsAffected = row.records_affected;
          errorMessage = row.error_message;
        } else if (manualScriptTypes[proc.name] && paFallback[manualScriptTypes[proc.name]]) {
          // Manual script ran but bypassed process_log — use performance_audit date as evidence of last run
          lastRun = paFallback[manualScriptTypes[proc.name]] + 'T00:00:00';
          lastStatus = 'SUCCESS';
          errorMessage = null;
        }
      }

      return {
        name: proc.name,
        label: proc.label,
        schedule: proc.schedule,
        critical: proc.critical,
        isLive: proc.isLive || false,
        lastRun: lastRun ? fmtTime(lastRun, nowET) : null,
        lastRunRaw: lastRun,
        lastStatus,
        lastDuration,
        recordsAffected,
        errorMessage,
        statusColor: statusColor(proc, lastRun, lastStatus, nowET),
        statusNote: null,
        history: proc.isLive ? [] : (detailByName[proc.name] || []).map(r => ({
          startedAt: fmtTime(r.started_at, nowET),
          duration: fmtDuration(r.started_at, r.completed_at),
          status: r.status,
          records: r.records_affected,
          error: r.error_message,
        })),
      };
    });

    // ── Outcome validation: override statusColor based on actual results ────────

    // Count today's trades in DB
    const todayTradesQ = await query(
      `SELECT COUNT(*) as count FROM trades WHERE log_date = $1`, [todayET]
    );
    const todayTrades = parseInt(todayTradesQ.rows[0]?.count || 0);

    // Check if a TAL file for today exists on disk
    let talForToday = false;
    try {
      const files = fs.readdirSync(SIERRA_TAL_DIR);
      talForToday = files.some(f => f.includes(todayET) && f.endsWith('.txt'));
    } catch (_) {}

    // Get today's coaching record
    const coachQ = await query(
      `SELECT trades_count FROM daily_coaching WHERE session_date = $1`, [todayET]
    );
    const coachRecord = coachQ.rows[0] || null;

    // Helper: did this process run today?
    const ranToday = (name) => {
      const row = logsByName[name];
      if (!row) return false;
      return new Date(row.started_at).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) === todayET;
    };

    // AUTO_IMPORT_4PM outcome
    const importProc = processes.find(p => p.name === 'AUTO_IMPORT_4PM');
    if (importProc && ranToday('AUTO_IMPORT_4PM')) {
      if (!talForToday) {
        importProc.statusColor = 'gray';
        importProc.statusNote = 'waiting — no TAL file exported from Sierra Chart yet';
      } else if (talForToday && todayTrades === 0) {
        importProc.statusColor = 'amber';
        importProc.statusNote = 'ran but imported 0 fills — TAL file exists but no today trades in DB';
      }
    }

    // DAILY_COACHING outcome (depends on import outcome)
    const coachProc = processes.find(p => p.name === 'DAILY_COACHING');
    if (coachProc && ranToday('DAILY_COACHING') && coachRecord) {
      const importWaiting = importProc?.statusColor === 'gray';
      const importStale   = importProc?.statusColor === 'amber';
      if (coachRecord.trades_count === 0) {
        if (importWaiting) {
          coachProc.statusColor = 'gray';
          coachProc.statusNote = 'blocked — import is waiting on TAL file; re-run after import';
        } else if (importStale || todayTrades === 0) {
          coachProc.statusColor = 'amber';
          coachProc.statusNote = 'stale — coached on 0 trades; re-run after import completes';
        }
      }
    }

    const redCount = processes.filter(p => p.statusColor === 'red' && p.critical).length;

    // DLL status
    let dllStatus = null;
    try { dllStatus = await computeDLLStatus(); } catch (_) {}

    res.json({ processes, checkedAt: fmtTime(nowET, nowET) || 'now', redCount, dllStatus });
  } catch (err) {
    console.error('[process-health]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/settings/process-overdue ────────────────────────────────────────

router.get('/settings/process-overdue', async (req, res) => {
  try {
    const nowET = getETNow();
    const todayET = nowET.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const processNames = PROCESS_SCHEDULE.filter(p => !p.isLive).map(p => p.name);
    const logsQ = await query(`
      SELECT DISTINCT ON (process_name) process_name, started_at, status
      FROM process_log WHERE process_name = ANY($1) ORDER BY process_name, started_at DESC
    `, [processNames]);
    const logsByName = Object.fromEntries(logsQ.rows.map(r => [r.process_name, r]));
    const barQ = await query(`SELECT MAX(ts)::text as last_bar FROM price_bars_primary WHERE symbol='NQ' AND ts::date = $1`, [todayET]);
    const lastBar = barQ.rows[0]?.last_bar || null;
    const liveData = {
      BAR_INGEST:      { lastRun: lastBar, lastStatus: lastBar ? 'SUCCESS' : null },
      SETUP_DETECTION: { lastRun: lastBar, lastStatus: lastBar ? 'SUCCESS' : null },
    };

    const overdue = PROCESS_SCHEDULE.filter(proc => {
      if (!proc.critical) return false;
      const lr = proc.isLive ? liveData[proc.name]?.lastRun : logsByName[proc.name]?.started_at;
      const ls = proc.isLive ? liveData[proc.name]?.lastStatus : logsByName[proc.name]?.status;
      return statusColor(proc, lr, ls, nowET) === 'red';
    });
    res.json({ overdue: overdue.map(p => ({ name: p.name, label: p.label })), count: overdue.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== SETTINGS ROUTES ====================

// Get all setup types
router.get('/setup-types', async (req, res) => {
  try {
    const result = await query('SELECT * FROM setup_types WHERE is_active = true ORDER BY name');
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching setup types:', error);
    res.status(500).json({ error: 'Failed to fetch setup types' });
  }
});

// Get custom field definitions
router.get('/custom-fields', async (req, res) => {
  try {
    const { category } = req.query;
    let queryText = 'SELECT * FROM custom_field_definitions';
    const params = [];

    if (category) {
      queryText += ' WHERE field_category = $1';
      params.push(category);
    }

    queryText += ' ORDER BY display_order, field_name';

    const result = await query(queryText, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching custom fields:', error);
    res.status(500).json({ error: 'Failed to fetch custom fields' });
  }
});

// Health check
router.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Get all todos
router.get('/settings/todos', async (req, res) => {
  try {
    const result = await query('SELECT * FROM settings_todos ORDER BY is_custom ASC, priority ASC, id ASC');
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching settings todos:', error);
    res.status(500).json({ error: 'Failed to fetch todo items' });
  }
});

// Create a new custom todo
router.post('/settings/todos', async (req, res) => {
  try {
    const { category, title, impact, description } = req.body;
    
    // Find the next priority for custom items or default to 51+
    const maxRes = await query('SELECT COALESCE(MAX(priority), 50) as max_priority FROM settings_todos WHERE is_custom = false');
    const nextPriority = parseInt(maxRes.rows[0].max_priority || 50) + 1;
    
    const result = await query(
      `INSERT INTO settings_todos (category, priority, title, impact, description, completed, is_custom)
       VALUES ($1, $2, $3, $4, $5, false, true)
       RETURNING *`,
      [category || 'Custom Improvements', nextPriority, title, impact || '', description || '']
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error creating settings todo:', error);
    res.status(500).json({ error: 'Failed to create todo item' });
  }
});

// Update a todo (mark complete, etc)
router.put('/settings/todos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { completed, title, description, category, impact } = req.body;
    
    const result = await query(
      `UPDATE settings_todos 
       SET completed = COALESCE($1, completed),
           title = COALESCE($2, title),
           description = COALESCE($3, description),
           category = COALESCE($4, category),
           impact = COALESCE($5, impact)
       WHERE id = $6
       RETURNING *`,
      [completed, title, description, category, impact, id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Todo not found' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating settings todo:', error);
    res.status(500).json({ error: 'Failed to update todo item' });
  }
});

// Delete a custom todo
router.delete('/settings/todos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await query('DELETE FROM settings_todos WHERE id = $1 AND is_custom = true RETURNING *', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Todo not found or not customizable' });
    }
    res.json({ message: 'Todo deleted successfully' });
  } catch (error) {
    console.error('Error deleting settings todo:', error);
    res.status(500).json({ error: 'Failed to delete todo item' });
  }
});

export default router;
