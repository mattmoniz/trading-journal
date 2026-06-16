import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server as SocketIO } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import multer from 'multer';
dotenv.config();

// Route imports
import dailyLogsRouter from './routes/dailyLogs.js';
import tradesRouter from './routes/trades.js';
import statsRouter from './routes/stats.js';
import settingsRouter from './routes/settings.js';
import createSierraRouter from './routes/sierra.js';
import behaviorRouter from './routes/behavior.js';
import backtestRouter from './routes/backtest.js';
import createPriceBarsRouter from './routes/priceBars.js';
import tearsheetRouter from './routes/tearsheet.js';
import keyLevelsRouter from './routes/keyLevels.js';
import edgeRouter from './routes/edge.js';
import confluenceRouter from './routes/confluence.js';
import longtermRouter from './routes/longterm.js';
import patternRouter from './routes/pattern.js';
import auctionReadRouter from './routes/auctionRead.js';
import wyckoffRouter from './routes/wyckoff.js';
import weeklyRouter from './routes/weekly.js';
import createACDRouter, { expireStaleSetups } from './routes/acd.js';
import setupsRouter from './routes/setups.js';
import phaseChangeRouter from './routes/phaseChange.js';
import calendarRouter from './routes/calendar.js';
import ruleOverridesRouter from './routes/ruleOverrides.js';
import { detectPhaseChange } from './services/phaseChangeDetector.js';
import { manualImportFromFile } from './services/tradeImportService.js';
import dllRouter, { checkAndEmitDLL } from './routes/dll.js';
import profitLockRouter, { checkAndEmitProfitLock } from './routes/profitLock.js';
import morningBriefRouter from './routes/morningBrief.js';
import caseRouter from './routes/case.js';
import scenarioRouter from './routes/scenario.js';
import cooldownRouter from './routes/cooldown.js';
import premarketWalkthroughRouter from './routes/premarketWalkthrough.js';
import annotationsRouter from './routes/annotations.js';
import developingValueRouter from './routes/developingValue.js';
import antigravityEdgesRouter from './routes/antigravityEdges.js';
import { computeAndPersistSession } from './services/developingValueService.js';
import cron from 'node-cron';
import { runMorningBriefLogged } from '../scripts/morning_brief.js';
import { runWeeklyReport } from '../scripts/weekly_report.js';
import { run as runMonthlyReport } from '../scripts/monthly_report.js';
import { runDailyCoaching } from '../scripts/daily_coaching.js';

import { query } from './db.js';
import { logProcess } from './lib/processLog.js';
import { computeACDFromBars, getBestACDParams, scanAndSaveSetupEvents, computeORLevelsOnly } from './services/acdService.js';
import { scanAndIngestNewBarFiles } from './services/priceBarService.js';
import { runNightlyUpdate } from './services/patternMemoryUpdate.js';
import SierraWatcher from './watchers/sierraWatcher.js';

const app = express();
const httpServer = createServer(app);
const io = new SocketIO(httpServer, { cors: { origin: '*', methods: ['GET', 'POST'] } });

app.set('io', io); // makes io available in route handlers via req.app.get('io')

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Static files for uploaded screenshots
const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
app.use('/uploads', express.static(join(__dirname, 'uploads')));

// ── Startup helper functions ──────────────────────────────────────────────────

const SIERRA_DATA_DIR   = process.env.SIERRA_DATA_PATH   || '/mnt/c/SierraChart/Data';
const SIERRA_IMAGES_DIR = process.env.SIERRA_IMAGES_PATH || '/mnt/c/SierraChart/Images';

// Auto-compute today's ACD from bars (called after bar ingest)
async function autoComputeTodayACD() {
  try {
    const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const hourET = nowET.getHours();
    const minET  = nowET.getMinutes();

    // Early: 9:35+ — just compute OR and A levels so they show during the session
    if (hourET === 9 && minET >= 35) {
      const { aMult } = await getBestACDParams();
      const levels = await computeORLevelsOnly(todayET, aMult);
      if (levels) console.log(`OR levels pre-computed: A Up ${levels.aUpLevel} / A Down ${levels.aDownLevel}`);
      return;
    }
    if (hourET < 11) return;
    const { orMins, aMult, sustainMins } = await getBestACDParams();
    const result = await computeACDFromBars(todayET, orMins, aMult, sustainMins);
    if (!result) return;
    await query(`
      INSERT INTO acd_daily_log (trade_date, or_high, or_low, a_multiplier, a_up_level, a_down_level, a_up_fired, a_down_fired, c_up_confirmed, c_down_confirmed, daily_score, session_close)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (trade_date) DO UPDATE SET
        or_high=$2, or_low=$3, a_multiplier=$4, a_up_level=$5, a_down_level=$6,
        a_up_fired=$7, a_down_fired=$8, c_up_confirmed=$9, c_down_confirmed=$10,
        daily_score=$11, session_close=$12
    `, [todayET, result.orHigh, result.orLow, aMult, result.aUpLevel, result.aDownLevel, result.aUpFired, result.aDownFired, result.cUpConfirmed, result.cDownConfirmed, result.score, result.sessionClose]);
    console.log(`ACD auto-logged: ${todayET} — score ${result.score > 0 ? '+' : ''}${result.score} (${result.aUpFired ? 'A Up' : result.aDownFired ? 'A Down' : 'No signal'})`);
    // Save setup events for pattern tracking
    setTimeout(() => scanAndSaveSetupEvents(todayET), 2000);
  } catch(e) { /* silent — bars may not be loaded yet */ }
}

// Auto-bulk-backfill ACD if the daily log is empty
async function autoBulkBackfillIfEmpty() {
  try {
    const count = await query('SELECT COUNT(*) as n FROM acd_daily_log');
    if (parseInt(count.rows[0].n) >= 10) return;
    console.log('ACD daily log empty — starting automatic backfill from price bars...');
    const datesRes = await query(`
      SELECT DISTINCT ts::date::text as d FROM price_bars
      WHERE symbol = 'NQ' AND EXTRACT(hour FROM ts) = 9 AND EXTRACT(minute FROM ts) = 30
      ORDER BY d
    `);
    const dates = datesRes.rows.map(r => r.d);
    let done = 0;
    for (const d of dates) {
      try {
        const { orMins: bfOrMins, aMult: bfAMult, sustainMins: bfSustain } = await getBestACDParams();
        const result = await computeACDFromBars(d, bfOrMins, bfAMult, bfSustain);
        if (result) {
          await query(`
            INSERT INTO acd_daily_log (trade_date, or_high, or_low, a_multiplier, a_up_level, a_down_level, a_up_fired, a_down_fired, c_up_confirmed, c_down_confirmed, daily_score, session_close)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
            ON CONFLICT (trade_date) DO NOTHING
          `, [d, result.orHigh, result.orLow, 0.33, result.aUpLevel, result.aDownLevel, result.aUpFired, result.aDownFired, result.cUpConfirmed, result.cDownConfirmed, result.score, result.sessionClose]);
        }
      } catch(e) {}
      done++;
      if (done % 50 === 0) console.log(`ACD backfill: ${done}/${dates.length}`);
    }
    console.log(`ACD backfill complete: ${done} days`);
    // Also auto-compute monthly pivot
    try {
      const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const priorMonth = nowET.getMonth() === 0 ? 12 : nowET.getMonth();
      const priorYear  = nowET.getMonth() === 0 ? nowET.getFullYear() - 1 : nowET.getFullYear();
      const priorFrom  = `${priorYear}-${String(priorMonth).padStart(2,'0')}-01`;
      const priorTo    = `${nowET.getFullYear()}-${String(nowET.getMonth()+1).padStart(2,'0')}-01`;
      const monthYear  = `${nowET.getFullYear()}-${String(nowET.getMonth()+1).padStart(2,'0')}`;
      const pr = await query(`SELECT MAX(high) as h, MIN(low) as l, (SELECT close FROM price_bars WHERE symbol='NQ' AND ts >= $1::date AND ts < $2::date AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16 ORDER BY ts DESC LIMIT 1) as c FROM price_bars WHERE symbol='NQ' AND ts >= $1::date AND ts < $2::date AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16`, [priorFrom, priorTo]);
      const { h: ph, l: pl, c: pc } = pr.rows[0];
      if (ph && pl && pc) {
        const piv = (parseFloat(ph) + parseFloat(pl) + parseFloat(pc)) / 3;
        await query(`INSERT INTO acd_monthly_pivot (month_year, prior_month_high, prior_month_low, prior_month_close, pivot_level, pivot_r1, pivot_s1) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (month_year) DO NOTHING`, [monthYear, ph, pl, pc, piv, 2*piv-parseFloat(pl), 2*piv-parseFloat(ph)]);
        console.log(`Monthly pivot auto-set: ${monthYear} -> ${piv.toFixed(2)}`);
      }
    } catch(e) {}
  } catch(e) { console.error('ACD auto-backfill error:', e.message); }
}

// Watch Sierra Chart Images folder for auto-exported chart images
const seenChartImages = new Map(); // filename -> { mtime, size }

async function ingestChartImage(filePath) {
  // Import tearsheet handler from the tearsheet route (already handles uploads)
  // For now: copy to uploads/charts/ if not already there
  try {
    const key = path.basename(filePath);
    const stat = fs.statSync(filePath);
    const prev = seenChartImages.get(key);
    if (prev && prev.mtime === stat.mtimeMs && prev.size === stat.size) return; // unchanged
    seenChartImages.set(key, { mtime: stat.mtimeMs, size: stat.size });
    const dest = join(__dirname, 'uploads', 'charts', key);
    if (!fs.existsSync(join(__dirname, 'uploads', 'charts'))) {
      fs.mkdirSync(join(__dirname, 'uploads', 'charts'), { recursive: true });
    }
    fs.copyFileSync(filePath, dest);
    console.log(`Chart image ingested: ${key}`);
  } catch(e) { /* silent */ }
}

function startChartImageWatcher() {
  if (!fs.existsSync(SIERRA_IMAGES_DIR)) {
    console.log(`Chart image watcher: directory not found (${SIERRA_IMAGES_DIR}) — will retry`);
    setTimeout(startChartImageWatcher, 30000);
    return;
  }
  console.log(`Watching for chart images: ${SIERRA_IMAGES_DIR}`);

  // Snapshot existing files so we don't import old ones on startup
  try {
    const existing = fs.readdirSync(SIERRA_IMAGES_DIR);
    for (const f of existing) {
      const fp = path.join(SIERRA_IMAGES_DIR, f);
      try {
        const stat = fs.statSync(fp);
        seenChartImages.set(f, { mtime: stat.mtimeMs, size: stat.size });
      } catch(_) {}
    }
  } catch(_) {}

  setInterval(async () => {
    try {
      if (!fs.existsSync(SIERRA_IMAGES_DIR)) return;
      const files = fs.readdirSync(SIERRA_IMAGES_DIR)
        .filter(f => /\.(png|jpg|jpeg|bmp)$/i.test(f));
      for (const f of files) {
        const fp = path.join(SIERRA_IMAGES_DIR, f);
        try { await ingestChartImage(fp); } catch(_) {}
      }
    } catch(_) {}
  }, 5 * 60 * 1000); // 5 minutes
}

// Mount routes
app.use('/api', dailyLogsRouter);
app.use('/api', tradesRouter);
app.use('/api', statsRouter);
app.use('/api', settingsRouter);
app.use('/api', behaviorRouter);
app.use('/api', backtestRouter);
app.use('/api', tearsheetRouter);
app.use('/api', keyLevelsRouter);
app.use('/api', edgeRouter);
app.use('/api', confluenceRouter);
app.use('/api', longtermRouter);
app.use('/api', patternRouter);
app.use('/api', auctionReadRouter);
app.use('/api', wyckoffRouter);
app.use('/api', weeklyRouter);

// Factory routers that need io or helper functions
const sierraWatcher = new SierraWatcher(SIERRA_DATA_DIR);
app.use('/api', createSierraRouter(io, sierraWatcher));
app.use('/api', createPriceBarsRouter(io, getBestACDParams, computeORLevelsOnly, autoComputeTodayACD));
app.use('/api', createACDRouter(io));
app.use('/api', phaseChangeRouter);
app.use('/api', setupsRouter);
app.use('/api', calendarRouter);
app.use('/api', ruleOverridesRouter);
app.use('/api', dllRouter);
app.use('/api', profitLockRouter);
app.use('/api/morning-brief', morningBriefRouter);
app.use('/api', caseRouter);
app.use('/api', scenarioRouter);
app.use('/api', cooldownRouter);
app.use('/api', premarketWalkthroughRouter);
app.use('/api', annotationsRouter);
app.use('/api', developingValueRouter);
app.use('/api', antigravityEdgesRouter);

// Admin trigger endpoints
app.post('/api/admin/run-coaching', async (req, res) => {
  try {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const text = await runDailyCoaching(today, io);
    await logProcess('DAILY_COACHING', async () => ({ count: text ? 1 : 0 }));
    res.json({ ok: true, date: today });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Data Health endpoint
app.get('/api/health/data', async (req, res) => {
  try {
    const todayET = `(NOW() AT TIME ZONE 'America/New_York')::date`;
    const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const todayStr = nowET.toISOString().slice(0, 10);
    const yesterdayStr = new Date(nowET.getTime() - 86400000).toISOString().slice(0, 10);
    const hourET = nowET.getHours() + nowET.getMinutes() / 60;
    const isPastElevenET = hourET >= 11;

    const [lastImport, todayFills, missingCumpl, orphanedSetups, timelineToday, lastBars, dayTypeCheck,
           lastPatternMemory, lastPcBacktest, lastBarToday] = await Promise.all([
      query(`SELECT MAX(created_at) AS ts, MAX(log_date) AS trade_date FROM trades`),
      query(`SELECT COUNT(*) AS cnt FROM trades WHERE log_date = ${todayET}`),
      query(`SELECT COUNT(*) AS cnt FROM trades WHERE custom_fields->'sierra_data'->>'Exit DateTime' LIKE '% EP' AND (custom_fields->'sierra_data'->>'Cumulative Profit/Loss (C)' IS NULL OR custom_fields->'sierra_data'->>'Cumulative Profit/Loss (C)' = '')`),
      query(`SELECT COUNT(*) AS cnt FROM active_setups WHERE status='ACTIVE' AND trade_date < ${todayET}`),
      query(`SELECT COUNT(*) AS cnt FROM trade_timeline_events WHERE trade_date = ${todayET}`),
      query(`SELECT MAX(date_to) AS last_date, MAX(ingested_at) AS ingested_at FROM price_bar_ingests`),
      query(`SELECT id, day_type FROM acd_daily_log WHERE trade_date = ${todayET} LIMIT 1`),
      query(`SELECT MAX(updated_at) AS ts FROM daily_performance_log`),
      query(`SELECT run_date FROM phase_change_backtest_results ORDER BY id DESC LIMIT 1`),
      query(`SELECT MAX(ts) AS ts FROM price_bars WHERE ts::date = ${todayET}`),
    ]);

    const lastImportDate = lastImport.rows[0]?.trade_date;
    let importStatus, importMsg;
    if (lastImportDate === todayStr) { importStatus = 'green'; importMsg = `Today (${lastImportDate})`; }
    else if (lastImportDate === yesterdayStr) { importStatus = 'amber'; importMsg = `Yesterday (${lastImportDate})`; }
    else { importStatus = 'red'; importMsg = lastImportDate ? `${lastImportDate} — stale` : 'No data'; }

    const barsDate = lastBars.rows[0]?.last_date;
    let barsStatus, barsMsg;
    if (barsDate === todayStr) { barsStatus = 'green'; barsMsg = `Today (${barsDate})`; }
    else if (barsDate === yesterdayStr) { barsStatus = 'amber'; barsMsg = `Yesterday (${barsDate})`; }
    else { barsStatus = 'red'; barsMsg = barsDate ? `${barsDate} — stale` : 'No bars'; }

    const orphaned = parseInt(orphanedSetups.rows[0]?.cnt || 0);
    const missing = parseInt(missingCumpl.rows[0]?.cnt || 0);
    const tlCount = parseInt(timelineToday.rows[0]?.cnt || 0);
    const todayCount = parseInt(todayFills.rows[0]?.cnt || 0);

    const dayTypeRow = dayTypeCheck.rows[0];
    let dayTypeStatus, dayTypeValue;
    if (!dayTypeRow) {
      dayTypeStatus = 'amber'; dayTypeValue = 'No log entry for today';
    } else if (!dayTypeRow.day_type && isPastElevenET) {
      dayTypeStatus = 'amber'; dayTypeValue = 'Day type not logged — complete the daily log to improve report accuracy';
    } else if (!dayTypeRow.day_type) {
      dayTypeStatus = 'amber'; dayTypeValue = 'Day type not yet logged';
    } else {
      dayTypeStatus = 'green'; dayTypeValue = dayTypeRow.day_type;
    }

    // ── Process timestamps ────────────────────────────────────────────────────
    const fmtEt = (ts) => {
      if (!ts) return null;
      return new Date(ts).toLocaleString('en-US', {
        timeZone: 'America/New_York', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit', hour12: false
      }) + ' ET';
    };
    const ageStatus = (ts) => {
      if (!ts) return 'red';
      const ageMs = Date.now() - new Date(ts).getTime();
      if (ageMs < 86400000) return 'green';        // within 24h
      if (ageMs < 7 * 86400000) return 'amber';    // within 7 days
      return 'red';
    };

    // Pattern memory
    const pmTs = lastPatternMemory.rows[0]?.ts;
    const pmStatus = ageStatus(pmTs);
    const pmValue = pmTs ? fmtEt(pmTs) : 'Never run';

    // Weekly report — find most recent file
    let weeklyTs = null;
    try {
      const reportsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'reports');
      const files = fs.readdirSync(reportsDir).filter(f => f.startsWith('weekly_') && f.endsWith('.txt'));
      if (files.length > 0) {
        files.sort();
        const newest = files[files.length - 1];
        weeklyTs = fs.statSync(join(reportsDir, newest)).mtime;
      }
    } catch (_) {}
    const weeklyStatus = ageStatus(weeklyTs);
    const weeklyValue = weeklyTs ? fmtEt(weeklyTs) : 'No report file found';

    // Phase change backtest
    const pcTs = lastPcBacktest.rows[0]?.run_date;
    const pcStatus = ageStatus(pcTs);
    const pcValue = pcTs ? fmtEt(pcTs) : 'Never run';

    // Last bar today
    const barTodayTs = lastBarToday.rows[0]?.ts;
    const barTodayStatus = barTodayTs ? 'green' : 'amber';
    const barTodayValue = barTodayTs
      ? new Date(barTodayTs).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }) + ' ET'
      : 'No bars ingested today';

    res.json({
      lastImport: { status: importStatus, label: 'Last Trade Import', value: importMsg },
      todayFills: { status: todayCount > 0 ? 'green' : 'amber', label: "Today's Fills", value: `${todayCount} fills` },
      missingCumpl: { status: missing === 0 ? 'green' : missing < 10 ? 'amber' : 'red', label: 'Missing CumPL', value: missing === 0 ? 'None' : `${missing} EP fills missing CumPL` },
      orphanedSetups: { status: orphaned === 0 ? 'green' : 'red', label: 'Orphaned Setups', value: orphaned === 0 ? 'None' : `${orphaned} ACTIVE setup(s) from prior day(s)` },
      timelineToday: { status: tlCount > 0 ? 'green' : 'amber', label: "Today's Timeline Events", value: `${tlCount} event(s)` },
      priceBars: { status: barsStatus, label: 'Price Bars', value: barsMsg },
      dayType: { status: dayTypeStatus, label: 'Day Type Logged', value: dayTypeValue },
      lastPatternMemory: { status: pmStatus, label: 'Last Pattern Memory Update', value: pmValue },
      lastWeeklyReport: { status: weeklyStatus, label: 'Last Weekly Report', value: weeklyValue },
      lastPcBacktest: { status: pcStatus, label: 'Last Phase Change Backtest', value: pcValue },
      lastBarToday: { status: barTodayStatus, label: 'Last Bar Ingested Today', value: barTodayValue },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Socket.IO
io.on('connection', (socket) => {
  console.log('Dashboard connected:', socket.id);
  socket.on('disconnect', () => console.log('Dashboard disconnected:', socket.id));
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);

  // ── Scheduled jobs (node-cron v3, fires within the matching minute) ──────────

  // Morning Brief — 8:30 AM ET Mon–Fri
  cron.schedule('30 8 * * 1-5', async () => {
    try { await runMorningBriefLogged(); }
    catch (err) { console.error('[morning_brief] Cron error:', err.message); }
  }, { timezone: 'America/New_York' });

  // Auto-Import — 4:00 PM ET Mon–Fri (replaces setInterval below)
  cron.schedule('0 16 * * 1-5', async () => {
    try {
      const sierraDir = '/mnt/c/SierraChart/SavedTradeActivity/';
      const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      const todayFile = path.join(sierraDir, `TradeActivityLogExport_${todayET}.txt`);
      if (!fs.existsSync(todayFile)) {
        console.log(`[auto-import 4PM] No TAL file for today (${todayET}) — skipping`);
        await logProcess('AUTO_IMPORT_4PM', async () => ({ count: 0, imported: 0, skipped: 0, file: null, note: 'no TAL file for today' }));
        return;
      }
      console.log(`[auto-import 4PM] Importing TradeActivityLogExport_${todayET}.txt`);
      const result = await logProcess('AUTO_IMPORT_4PM', async () => {
        const r = await manualImportFromFile(todayFile, 'AUTO_4PM');
        return { count: r.imported, imported: r.imported, skipped: r.skipped, file: `TradeActivityLogExport_${todayET}.txt` };
      });
      console.log(`[auto-import 4PM] Done — imported: ${result?.imported}, skipped: ${result?.skipped}`);
      if (io) io.emit('auto-import-complete', { trigger: 'AUTO_4PM', file: `TradeActivityLogExport_${todayET}.txt`, imported: result?.imported, skipped: result?.skipped, time: new Date().toISOString() });
      checkAndEmitDLL(io).catch(() => {});
      checkAndEmitProfitLock(io).catch(() => {});
    } catch (e) { console.error('[auto-import 4PM] Error:', e.message); }
  }, { timezone: 'America/New_York' });

  // 1PM Stop reminder — Mon–Fri
  cron.schedule('0 13 * * 1-5', async () => {
    try {
      const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const today = nowET.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      const pnlNow = (await query(`SELECT COALESCE(SUM(pnl),0)::float as pnl FROM trades WHERE log_date=$1`, [today])).rows[0]?.pnl || 0;
      // Upsert 1PM event log (reminder is always sent, user_choice set when acknowledged)
      await query(
        `INSERT INTO profit_lock_events (event_date, event_type, current_pnl)
         VALUES ($1, '1PM_REMINDER', $2)
         ON CONFLICT DO NOTHING`,
        [today, pnlNow]
      ).catch(() => {});
      if (io) io.emit('1pm-reminder', { pnlAtReminder: pnlNow, time: new Date().toISOString() });
      console.log(`[1PM-stop] Reminder fired — P&L at 1PM: $${pnlNow >= 0 ? '+' : ''}${pnlNow.toFixed(0)}`);
    } catch (e) { console.error('[1PM-stop] Error:', e.message); }
  }, { timezone: 'America/New_York' });

  // Pattern Memory — 4:05 PM ET Mon–Fri
  cron.schedule('5 16 * * 1-5', async () => {
    try { await logProcess('PATTERN_MEMORY', runNightlyUpdate); }
    catch (err) { console.error('[pattern_memory] Cron error:', err.message); }
  }, { timezone: 'America/New_York' });

  // Developing Value Tracker — persist today's session profile, 4:05 PM ET Mon-Fri
  cron.schedule('5 16 * * 1-5', async () => {
    try {
      const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      await logProcess('DEVELOPING_VALUE', async () => {
        const r = await computeAndPersistSession(todayET);
        return { count: r ? 1 : 0 };
      });
    } catch (err) { console.error('[developing_value] Cron error:', err.message); }
  }, { timezone: 'America/New_York' });

  // Daily Coaching — 4:45 PM ET Mon–Fri
  cron.schedule('45 16 * * 1-5', async () => {
    try {
      await logProcess('DAILY_COACHING', async () => {
        const text = await runDailyCoaching(null, io);
        return { count: text ? 1 : 0 };
      });
    } catch (err) { console.error('[daily_coaching] Cron error:', err.message); }
  }, { timezone: 'America/New_York' });

  // Weekly Report — 6:00 PM ET Sunday
  cron.schedule('0 18 * * 0', async () => {
    try {
      await logProcess('WEEKLY_REPORT', async () => {
        const r = await runWeeklyReport(io);
        return { count: 1, weekEnd: r.weekEnd };
      });
    } catch (err) { console.error('[weekly_report] Cron error:', err.message); }
  }, { timezone: 'America/New_York' });

  // Combo backtest — every Sunday 6:30 PM ET (after weekly report)
  cron.schedule('30 18 * * 0', async () => {
    try {
      const { spawn } = await import('child_process');
      const child = spawn('node', ['scripts/combo_backtest.js'], {
        cwd: process.cwd(), detached: true, stdio: 'ignore',
      });
      child.unref();
      console.log('[combo_backtest] Weekly re-run started');
    } catch (err) { console.error('[combo_backtest] Cron error:', err.message); }
  }, { timezone: 'America/New_York' });

  // Monthly Report — 7:00 PM ET first Sunday of month
  cron.schedule('0 19 * * 0', async () => {
    try {
      const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
      if (d.getDate() > 7) return;
      await logProcess('MONTHLY_REPORT', async () => {
        await runMonthlyReport(io);
        return { count: 1 };
      });
    } catch (err) { console.error('[monthly_report] Cron error:', err.message); }
  }, { timezone: 'America/New_York' });

  // Self-healing catch-up — every 30 min, fires any overdue job that hasn't completed
  cron.schedule('*/30 * * * *', async () => {
    try {
      const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const day = nowET.getDay();
      const hour = nowET.getHours();
      const today = nowET.toLocaleDateString('en-CA'); // YYYY-MM-DD

      // Weekly report — due Sunday 6 PM; catch up Sunday after 6 PM or all Monday
      // Anchor to last Sunday: CURRENT_DATE minus its DOW offset (DOW=0 Sun, 1 Mon, ...)
      if ((day === 0 && hour >= 18) || day === 1) {
        const { rows } = await query(`
          SELECT 1 FROM process_log
          WHERE process_name = 'WEEKLY_REPORT' AND status = 'SUCCESS'
            AND started_at::date >= (CURRENT_DATE - EXTRACT(DOW FROM CURRENT_DATE)::int)::date
          LIMIT 1
        `);
        if (rows.length === 0) {
          console.log('[catch-up] Weekly report overdue — running now');
          await logProcess('WEEKLY_REPORT', async () => {
            const r = await runWeeklyReport(io);
            return { count: 1, weekEnd: r.weekEnd };
          });
        }
      }

      // Auto-import catch-up — after 4 PM Mon–Fri, if today's TAL exists but 0 fills in DB
      if (day >= 1 && day <= 5 && hour >= 16) {
        const sierraDir = '/mnt/c/SierraChart/SavedTradeActivity/';
        const todayFile = path.join(sierraDir, `TradeActivityLogExport_${today}.txt`);
        if (fs.existsSync(todayFile)) {
          const { rows: fillRows } = await query(
            `SELECT COUNT(*) as count FROM trades WHERE log_date = $1`, [today]
          );
          if (parseInt(fillRows[0]?.count || 0) === 0) {
            console.log('[catch-up] TAL file exists but 0 fills in DB — re-running import');
            await logProcess('AUTO_IMPORT_4PM', async () => {
              const r = await manualImportFromFile(todayFile, 'AUTO_CATCHUP');
              return { count: r.imported, imported: r.imported, skipped: r.skipped, file: `TradeActivityLogExport_${today}.txt` };
            });
            // Immediately run coaching now that fills are in — don't wait for next tick
            const { rows: postImportFills } = await query(
              `SELECT COUNT(*) as count FROM trades WHERE log_date = $1`, [today]
            );
            if (parseInt(postImportFills[0]?.count || 0) > 0 && hour >= 16) {
              console.log('[catch-up] Running coaching immediately after late import');
              await logProcess('DAILY_COACHING', async () => {
                const text = await runDailyCoaching(today, io);
                return { count: text ? 1 : 0 };
              });
            }
          }
        }
      }

      // Daily coaching — due 4:45 PM Mon–Fri; catch up after 5 PM
      // Also re-run if coaching ran but on 0 trades (import came in late)
      if (day >= 1 && day <= 5 && hour >= 17) {
        const [coachRows, fillRows] = await Promise.all([
          query(`SELECT trades_count FROM daily_coaching WHERE session_date = $1 LIMIT 1`, [today]),
          query(`SELECT COUNT(*) as count FROM trades WHERE log_date = $1`, [today]),
        ]);
        const coached = coachRows.rows[0];
        const fillCount = parseInt(fillRows.rows[0]?.count || 0);
        const needsCoaching = !coached || (coached.trades_count === 0 && fillCount > 0);
        if (needsCoaching) {
          console.log(`[catch-up] Daily coaching ${!coached ? 'overdue' : 'stale (0 trades coached, ' + fillCount + ' fills now in DB)'} — running now`);
          await logProcess('DAILY_COACHING', async () => {
            const text = await runDailyCoaching(null, io);
            return { count: text ? 1 : 0 };
          });
        }
      }

      // Prior trading day coaching catch-up — runs any day/time, no day/hour guard.
      // Handles: server was down at 4:45 PM, trades imported manually, server restarted next day.
      // "Prior trading day" = Mon→Fri, otherwise the closest prior weekday.
      {
        const d = new Date(nowET);
        d.setDate(d.getDate() - 1);
        while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
        const prevDay = d.toLocaleDateString('en-CA');
        const [prevCoachRows, prevFillRows] = await Promise.all([
          query(`SELECT trades_count FROM daily_coaching WHERE session_date = $1 LIMIT 1`, [prevDay]),
          query(`SELECT COUNT(*) as count FROM trades WHERE log_date = $1`, [prevDay]),
        ]);
        const prevCoached = prevCoachRows.rows[0];
        const prevFillCount = parseInt(prevFillRows.rows[0]?.count || 0);
        const prevNeedsCoaching = prevFillCount > 0 && (!prevCoached || (prevCoached.trades_count === 0 && prevFillCount > 0));
        if (prevNeedsCoaching) {
          console.log(`[catch-up] Prior day coaching missing for ${prevDay} (${prevFillCount} fills in DB) — running now`);
          await logProcess('DAILY_COACHING', async () => {
            const text = await runDailyCoaching(prevDay, io);
            return { count: text ? 1 : 0 };
          });
        }
      }

      // Morning brief — due 8:30 AM Mon–Fri; catch up 9 AM–1 PM
      if (day >= 1 && day <= 5 && hour >= 9 && hour < 13) {
        const { rows } = await query(
          `SELECT 1 FROM morning_briefs WHERE brief_date = $1 LIMIT 1`, [today]
        );
        if (rows.length === 0) {
          console.log('[catch-up] Morning brief overdue — running now');
          await runMorningBriefLogged();
        }
      }

      // Combo backtest — due Sunday 6:30 PM; catch up Sunday after 6:30 PM if it hasn't run today
      if (day === 0 && hour >= 18) {
        const { rows } = await query(
          `SELECT 1 FROM process_log WHERE process_name = 'COMBO_BACKTEST' AND started_at::date = CURRENT_DATE LIMIT 1`
        );
        if (rows.length === 0) {
          console.log('[catch-up] Combo backtest overdue — running now');
          const { spawn } = await import('child_process');
          const child = spawn('node', ['scripts/combo_backtest.js'], {
            cwd: process.cwd(), detached: true, stdio: 'ignore',
          });
          child.unref();
        }
      }

      // Monthly report — due 7 PM ET first Sunday of month; catch up any time in first week
      // if no successful run has happened yet this month
      if (nowET.getDate() <= 7 && !(day === 0 && hour < 19)) {
        const { rows } = await query(`
          SELECT 1 FROM process_log
          WHERE process_name = 'MONTHLY_REPORT' AND status = 'SUCCESS'
            AND started_at >= date_trunc('month', CURRENT_DATE)
          LIMIT 1
        `);
        if (rows.length === 0) {
          console.log('[catch-up] Monthly report overdue — running now');
          await logProcess('MONTHLY_REPORT', async () => {
            await runMonthlyReport(io);
            return { count: 1 };
          });
        }
      }
    } catch (err) {
      console.error('[catch-up] Error:', err.message);
    }
  }, { timezone: 'America/New_York' });

  console.log('[cron] Registered: Morning Brief 8:30AM, Auto-Import 4PM, Pattern Memory 4:05PM, Daily Coaching 4:45PM ET Mon-Fri | Weekly Report 6PM, Monthly Report 7PM ET Sun | Catch-up every 30min');

  // Hourly overdue process check (9 AM–5 PM ET Mon–Fri)
  setInterval(async () => {
    try {
      const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const h = nowET.getHours(), day = nowET.getDay();
      if (day === 0 || day === 6) return;
      if (h < 9 || h > 17) return;
      const r = await fetch(`http://localhost:${PORT}/api/settings/process-overdue`);
      if (!r.ok) return;
      const d = await r.json();
      if (d.count > 0) {
        io.emit('process-health-alert', { overdue: d.overdue.map(p => p.label), count: d.count });
        console.log('[process-health] OVERDUE:', d.overdue.map(p => p.name).join(', '));
      }
    } catch (_) {}
  }, 3600000); // every hour

  // Auto-backfill ACD history from price bars if the log is empty
  setTimeout(autoBulkBackfillIfEmpty, 3000);

  // Backfill setup events for all historical dates that don't have them yet
  setTimeout(async () => {
    try {
      const dates = await query(`
        SELECT d.trade_date::text as d FROM acd_daily_log d
        WHERE d.or_high IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM acd_setup_events e WHERE e.trade_date = d.trade_date)
        ORDER BY d.trade_date
      `);
      if (dates.rows.length > 0) {
        console.log(`Backfilling setup events for ${dates.rows.length} dates...`);
        for (const { d } of dates.rows) {
          await scanAndSaveSetupEvents(d);
        }
        console.log('Setup event backfill complete');
      }
    } catch(e) { console.error('Setup event backfill error:', e.message); }
  }, 10000);

  // Auto-log today's ACD if past session end
  setTimeout(autoComputeTodayACD, 5000);

  // Auto-compute monthly pivot if not set for this month
  setTimeout(async () => {
    try {
      const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const monthYear = `${nowET.getFullYear()}-${String(nowET.getMonth()+1).padStart(2,'0')}`;
      const existing = await query('SELECT id FROM acd_monthly_pivot WHERE month_year=$1', [monthYear]);
      if (existing.rows.length > 0) return; // already set for this month
      // Compute from prior month's bars
      const priorMonth = nowET.getMonth() === 0 ? 12 : nowET.getMonth();
      const priorYear  = nowET.getMonth() === 0 ? nowET.getFullYear()-1 : nowET.getFullYear();
      const priorFrom  = `${priorYear}-${String(priorMonth).padStart(2,'0')}-01`;
      const priorTo    = `${nowET.getFullYear()}-${String(nowET.getMonth()+1).padStart(2,'0')}-01`;
      const pr = await query(`
        SELECT MAX(high) as h, MIN(low) as l,
          (SELECT close FROM price_bars WHERE symbol='NQ' AND ts >= $1::date AND ts < $2::date
           AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16 ORDER BY ts DESC LIMIT 1) as c
        FROM price_bars WHERE symbol='NQ' AND ts >= $1::date AND ts < $2::date
        AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
      `, [priorFrom, priorTo]);
      const { h, l, c } = pr.rows[0];
      if (!h || !l || !c) return;
      const piv = (parseFloat(h)+parseFloat(l)+parseFloat(c))/3;
      await query(`INSERT INTO acd_monthly_pivot (month_year,prior_month_high,prior_month_low,prior_month_close,pivot_level,pivot_r1,pivot_s1) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (month_year) DO NOTHING`,
        [monthYear, h, l, c, piv, 2*piv-parseFloat(l), 2*piv-parseFloat(h)]);
      console.log(`Monthly pivot auto-set for ${monthYear}: ${piv.toFixed(2)}`);
    } catch(e) { console.error('Auto pivot error:', e.message); }
  }, 6000);

  // Watch Sierra Chart Images folder for auto-exported chart images
  startChartImageWatcher();

  // Auto-poll bar file every 60 seconds and ingest if updated
  setInterval(async () => {
    try {
      // Expire any active setups past their window
      await expireStaleSetups(io);

      const results = await scanAndIngestNewBarFiles(SIERRA_DATA_DIR);
      const updated = results.filter(r => !r.error && !r.skipped && r.symbol === 'NQ');
      if (updated.length > 0) {
        const totalBars = updated.reduce((s, r) => s + (r.bars_inserted || 0), 0);
        if (totalBars > 0) {
          io.emit('price-sync-progress', { status: 'success', message: `Auto-sync: ${totalBars.toLocaleString()} new bars`, total: 1, done: 1 });
          setTimeout(autoComputeTodayACD, 1000);
        }
      }
      // DLL + profit-lock check on every bar cycle
      checkAndEmitDLL(io).catch(() => {});
      checkAndEmitProfitLock(io).catch(() => {});
    } catch(e) { /* silent */ }
  }, 60000);

  // Auto-Import at 4PM moved to cron.schedule above

  // Intraday auto-import — every 30 min during market hours (9:30 AM–1:00 PM ET Mon–Fri)
  let lastIntradaySlot = null;
  setInterval(async () => {
    try {
      const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const h = nowET.getHours(), m = nowET.getMinutes(), day = nowET.getDay();
      if (day === 0 || day === 6) return;
      // Fire at :00 and :30 of hours 9–13, but skip 9:00 (pre-open)
      const atHalfHour = m < 2; // within first 2 minutes of the slot
      const atHour = h >= 9 && h <= 13;
      if (!atHour || !atHalfHour) return;
      if (h === 9 && m < 30) return; // skip 9:00 AM, wait for 9:30
      const todayStr = nowET.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      const slot = `${todayStr}-${h}-${m < 30 ? '00' : '30'}`;
      if (lastIntradaySlot === slot) return; // already ran this slot
      lastIntradaySlot = slot;

      const sierraDir = '/mnt/c/SierraChart/SavedTradeActivity/';
      if (!fs.existsSync(sierraDir)) return;
      const todayFile = path.join(sierraDir, `TradeActivityLogExport_${todayStr}.txt`);
      if (!fs.existsSync(todayFile)) return; // no file for today yet — skip silently
      console.log(`[auto-import intraday ${h}:${String(m).padStart(2,'0')}] Importing TradeActivityLogExport_${todayStr}.txt`);
      const result = await manualImportFromFile(todayFile, 'AUTO_INTRADAY');
      console.log(`[auto-import intraday] Done — imported: ${result?.imported}, skipped: ${result?.skipped}`);

      if (io && result?.imported > 0) {
        io.emit('auto-import-complete', {
          trigger: 'AUTO_INTRADAY',
          file: target.name,
          imported: result?.imported,
          skipped: result?.skipped,
          time: new Date().toISOString(),
        });
      }
      checkAndEmitDLL(io).catch(() => {});
      checkAndEmitProfitLock(io).catch(() => {});
    } catch (e) {
      console.error('[auto-import intraday] Error:', e.message);
    }
  }, 60000);

  // Pattern memory nightly job — fires at 4:05 PM ET on trading days
  setInterval(async () => {
    try {
      const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const h = nowET.getHours(), m = nowET.getMinutes(), day = nowET.getDay();
      if (day === 0 || day === 6) return; // skip weekends
      if (h !== 16 || m < 5 || m > 10) return; // only fire between 4:05-4:10 PM ET
      const tradeDate = nowET.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      console.log(`[pattern] Nightly job triggered for ${tradeDate}`);
      await runNightlyUpdate(tradeDate, io);
    } catch(e) { console.error('[pattern] Nightly job error:', e.message); }
  }, 60000); // check every minute

  // Auto-backfill weekly ACD if empty
  setTimeout(async () => {
    try {
      const n = await query('SELECT COUNT(*) as n FROM acd_weekly_log');
      if (parseInt(n.rows[0].n) < 5) {
        console.log('Weekly ACD log empty — starting backfill...');
        // computeWeeklyACD and saveWeeklyACD are defined inside createACDRouter in acd.js.
        // For a full extraction, move those functions to acdService.js and import here.
        // For now, the ACD router handles weekly computation via its own routes.
        console.log('Weekly ACD backfill: trigger via POST /api/acd/weekly/bulk-backfill');
      }
    } catch(e) { console.error('Weekly ACD startup error:', e.message); }
  }, 8000);
});

export { io };
