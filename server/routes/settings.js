import express from 'express';
import { query } from '../db.js';
import { computeDLLStatus } from './dll.js';

const router = express.Router();

// ─── Process Schedule Definition ─────────────────────────────────────────────

const PROCESS_SCHEDULE = [
  { name: 'MORNING_BRIEF',       label: 'Morning Brief',            schedule: '7:00 AM ET Mon-Fri',        expectedDays: ['Mon','Tue','Wed','Thu','Fri'], scheduledHour: 7,  maxAgeHours: 25,  critical: true  },
  { name: 'AUTO_IMPORT_4PM',     label: 'Sierra Chart Auto-Import', schedule: '4:00 PM ET Mon-Fri',        expectedDays: ['Mon','Tue','Wed','Thu','Fri'], scheduledHour: 16, maxAgeHours: 25,  critical: true  },
  { name: 'PATTERN_MEMORY',      label: 'Pattern Memory Update',    schedule: '4:05 PM ET Mon-Fri',        expectedDays: ['Mon','Tue','Wed','Thu','Fri'], scheduledHour: 16, maxAgeHours: 25,  critical: true  },
  { name: 'DAILY_COACHING',      label: 'Daily Coaching Review',    schedule: '4:45 PM ET Mon-Fri',        expectedDays: ['Mon','Tue','Wed','Thu','Fri'], scheduledHour: 16, maxAgeHours: 25,  critical: true  },
  { name: 'WEEKLY_REPORT',       label: 'Weekly Report',            schedule: '6:00 PM ET Sunday',         expectedDays: ['Sun'],                         scheduledHour: 18, maxAgeHours: 170, critical: false },
  { name: 'WEEKLY_ASSESSMENT',   label: 'Weekly Assessment',        schedule: '6:05 PM ET Sunday',         expectedDays: ['Sun'],                         scheduledHour: 18, maxAgeHours: 170, critical: false },
  { name: 'MONTHLY_REPORT',      label: 'Monthly Report',           schedule: '7:00 PM ET First Sunday',   expectedDays: ['Sun'],                         scheduledHour: 19, maxAgeHours: 750, critical: false },
  { name: 'BAR_INGEST',          label: 'Sierra Chart Bar Sync',    schedule: 'Continuous during mkt hrs', expectedDays: ['Mon','Tue','Wed','Thu','Fri'], maxAgeMinutes: 5, critical: true,  isLive: true },
  { name: 'SETUP_DETECTION',     label: 'Setup Detection',          schedule: 'On each bar insert',        expectedDays: ['Mon','Tue','Wed','Thu','Fri'], maxAgeMinutes: 5, critical: true,  isLive: true },
];

const DAY_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

function getETNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
}

function statusColor(proc, lastRun, lastStatus, nowET) {
  const todayName = DAY_NAMES[nowET.getDay()];
  const expectedToday = proc.expectedDays.includes(todayName);
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
    const ageHours = (nowET - new Date(lastRun)) / 3600000;
    if (ageHours > (proc.maxAgeHours || 25)) return 'red';
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
    const logsQ = await query(`
      SELECT DISTINCT ON (process_name) process_name, started_at, completed_at, status, records_affected, error_message
      FROM process_log WHERE process_name = ANY($1)
      ORDER BY process_name, started_at DESC
    `, [processNames]);
    const logsByName = Object.fromEntries(logsQ.rows.map(r => [r.process_name, r]));

    // Fetch last 5 runs per process for detail view
    const detailQ = await query(`
      SELECT process_name, started_at, completed_at, status, records_affected, error_message,
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
      `SELECT MAX(ts)::text as last_bar FROM price_bars WHERE symbol='NQ' AND ts::date = $1`, [todayET]
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
        history: proc.isLive ? [] : (detailByName[proc.name] || []).map(r => ({
          startedAt: fmtTime(r.started_at, nowET),
          duration: fmtDuration(r.started_at, r.completed_at),
          status: r.status,
          records: r.records_affected,
          error: r.error_message,
        })),
      };
    });

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
    const barQ = await query(`SELECT MAX(ts)::text as last_bar FROM price_bars WHERE symbol='NQ' AND ts::date = $1`, [todayET]);
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

export default router;
