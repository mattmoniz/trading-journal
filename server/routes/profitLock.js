import express from 'express';
import { query } from '../db.js';

const router = express.Router();

// ── In-memory peak tracker ─────────────────────────────────────────────────────
// Persists within a server session; re-derived from trade sequence on query if empty.
const peakByDate = new Map(); // date -> { peakPnl, armedAt, upAndDoneNotified }

// Compute combined daily P&L from trade fills (sum approach — fast, correct for intraday tracking)
async function getDailyPnl(dateStr) {
  const r = await query(
    `SELECT COALESCE(SUM(pnl), 0)::float as pnl FROM trades WHERE log_date = $1`,
    [dateStr]
  );
  return parseFloat(r.rows[0]?.pnl || 0);
}

// Compute historical peak from fill sequence (used on server restart to recover lost in-memory state)
async function computeHistoricalPeak(dateStr) {
  const r = await query(`
    SELECT pnl FROM trades WHERE log_date = $1 ORDER BY exit_time NULLS LAST
  `, [dateStr]);
  let running = 0, peak = 0;
  for (const row of r.rows) {
    running += parseFloat(row.pnl) || 0;
    if (running > peak) peak = running;
  }
  return peak;
}

export async function computeProfitLockStatus(dateStr = null) {
  const today = dateStr || new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  const [cfgQ, todayFillsQ] = await Promise.all([
    query(`SELECT lock_threshold, giveback_pct, floor_after_arm, upanddone_threshold, enabled FROM profit_lock_config WHERE id=1`),
    getDailyPnl(today),
  ]);

  const cfg = cfgQ.rows[0] || {};
  const lockThreshold    = parseFloat(cfg.lock_threshold    ?? 400);
  const givebackPct      = parseFloat(cfg.giveback_pct      ?? 0.40);
  const floorAfterArm    = parseFloat(cfg.floor_after_arm   ?? 120);
  const upAndDoneThresh  = parseFloat(cfg.upanddone_threshold ?? 400);
  const enabled          = cfg.enabled !== false;

  const currentPnl = todayFillsQ;

  // Recover or update in-memory peak
  if (!peakByDate.has(today)) {
    const histPeak = await computeHistoricalPeak(today);
    peakByDate.set(today, { peakPnl: histPeak, armedAt: null, upAndDoneNotified: false });
    // Purge entries older than today to avoid memory leak
    for (const k of peakByDate.keys()) { if (k < today) peakByDate.delete(k); }
  }
  const state = peakByDate.get(today);
  if (currentPnl > state.peakPnl) state.peakPnl = currentPnl;
  const peakPnl = state.peakPnl;

  // Arm when P&L first reaches threshold
  if (!state.armedAt && peakPnl >= lockThreshold) {
    state.armedAt = new Date().toISOString();
  }

  const armed      = !!state.armedAt;
  const giveBack   = Math.max(0, peakPnl - currentPnl);
  const giveBackPctActual = peakPnl > 0 ? giveBack / peakPnl : 0;

  // Fire when: armed AND (gave back >= givebackPct of peak OR fell below floor)
  const givebackBreached = giveBackPctActual >= givebackPct && peakPnl >= lockThreshold;
  const floorBreached    = armed && currentPnl < floorAfterArm && peakPnl >= lockThreshold;
  const fired = enabled && armed && (givebackBreached || floorBreached);

  // Up-and-done: nudge once when first armed
  const upAndDoneReady = enabled && armed && !state.upAndDoneNotified;
  if (upAndDoneReady) state.upAndDoneNotified = true;

  return {
    date: today,
    enabled,
    currentPnl,
    peakPnl,
    giveBack,
    giveBackPct: giveBackPctActual,
    armed,
    armedAt: state.armedAt,
    fired,
    fireReason: fired ? (floorBreached ? 'floor' : 'giveback') : null,
    upAndDoneReady,
    lockThreshold,
    givebackPct,
    floorAfterArm,
    upAndDoneThresh,
  };
}

// Call after every bar ingest or trade import — emits socket event and logs if newly fired
export async function checkAndEmitProfitLock(io, dateStr = null) {
  try {
    const status = await computeProfitLockStatus(dateStr);
    if (io) io.emit('profit-lock-status', status);

    // Log LOCK_ARMED once per day when first armed
    if (status.armed) {
      const armedToday = await query(
        `SELECT 1 FROM profit_lock_events WHERE event_date=$1 AND event_type='LOCK_ARMED' LIMIT 1`,
        [status.date]
      );
      if (!armedToday.rows.length) {
        await query(
          `INSERT INTO profit_lock_events (event_date, event_type, peak_pnl, current_pnl, threshold)
           VALUES ($1, 'LOCK_ARMED', $2, $3, $4)`,
          [status.date, status.peakPnl, status.currentPnl, status.lockThreshold]
        );
      }
    }

    // Log GIVE_BACK_GUARD once per day when fired
    if (status.fired) {
      const firedToday = await query(
        `SELECT 1 FROM profit_lock_events WHERE event_date=$1 AND event_type='GIVE_BACK_GUARD' LIMIT 1`,
        [status.date]
      );
      if (!firedToday.rows.length) {
        await query(
          `INSERT INTO profit_lock_events (event_date, event_type, peak_pnl, current_pnl, threshold, notes)
           VALUES ($1, 'GIVE_BACK_GUARD', $2, $3, $4, $5)`,
          [status.date, status.peakPnl, status.currentPnl, status.lockThreshold, status.fireReason]
        );
      }
    }

    return status;
  } catch (err) {
    console.error('[profitLock] checkAndEmitProfitLock error:', err.message);
    return null;
  }
}

// ── Routes ─────────────────────────────────────────────────────────────────────

router.get('/profit-lock/status', async (req, res) => {
  try {
    const status = await computeProfitLockStatus(req.query.date);
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/profit-lock/config', async (req, res) => {
  try {
    const r = await query(`SELECT * FROM profit_lock_config WHERE id=1`);
    res.json(r.rows[0] || {});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/profit-lock/config', async (req, res) => {
  try {
    const { lock_threshold, giveback_pct, floor_after_arm, upanddone_threshold, enabled } = req.body;
    await query(`
      UPDATE profit_lock_config SET
        lock_threshold     = COALESCE($1, lock_threshold),
        giveback_pct       = COALESCE($2, giveback_pct),
        floor_after_arm    = COALESCE($3, floor_after_arm),
        upanddone_threshold = COALESCE($4, upanddone_threshold),
        enabled            = COALESCE($5, enabled),
        updated_at         = NOW()
      WHERE id = 1
    `, [lock_threshold ?? null, giveback_pct ?? null, floor_after_arm ?? null, upanddone_threshold ?? null, enabled ?? null]);
    const r = await query(`SELECT * FROM profit_lock_config WHERE id=1`);
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Log 1PM acknowledgment — called from frontend when user clicks through the modal
router.post('/profit-lock/1pm-ack', async (req, res) => {
  try {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const { choice } = req.body; // 'STOP' or 'CONTINUE'
    // Upsert — only one record per day
    const existing = await query(
      `SELECT id FROM profit_lock_events WHERE event_date=$1 AND event_type='1PM_REMINDER' LIMIT 1`,
      [today]
    );
    if (existing.rows.length) {
      await query(
        `UPDATE profit_lock_events SET user_choice=$2 WHERE id=$1`,
        [existing.rows[0].id, choice]
      );
    } else {
      const pnlNow = await getDailyPnl(today);
      await query(
        `INSERT INTO profit_lock_events (event_date, event_type, current_pnl, user_choice)
         VALUES ($1, '1PM_REMINDER', $2, $3)`,
        [today, pnlNow, choice]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/profit-lock/history — last 30 days of events (for settings/review panel)
router.get('/profit-lock/history', async (req, res) => {
  try {
    const r = await query(`
      SELECT event_date::text, event_type, event_at,
             peak_pnl::float, current_pnl::float, threshold::float,
             user_choice, kept_trading, final_pnl::float, notes
      FROM profit_lock_events
      ORDER BY event_at DESC LIMIT 90
    `);
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
