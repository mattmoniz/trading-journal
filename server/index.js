import express from 'express';
import cors from 'cors';
import compression from 'compression';
import { createServer } from 'http';
import { Server as SocketIO } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import multer from 'multer';
dotenv.config();

// Fail-fast TZ guard (2026-08-19, resolves OPEN_DECISION
// naive_timestamp_epoch_mixing_systematic_audit_needed): this codebase has TWO parallel,
// individually-safe conventions for handling naive `timestamp without time zone` columns
// (which this DB's server-level TimeZone=America/New_York setting means store ET wall-clock,
// not UTC -- see server/db.js's corrected comment) -- (1) the pg type-1114 parser's
// digit-preservation Z-append trick (safe for display via UTC getters, regardless of this
// process's own ambient timezone) and (2) a `::text`-cast-then-bare-`new Date()`-reparse
// convention used throughout server/routes/acd.js and many scripts/ for genuine elapsed-time
// math (e.g. GET /api/setups/active's minsRemaining) -- correct ONLY because this reparse
// relies on JS's local-time-string interpretation, which is only right if this PROCESS's own
// ambient timezone happens to equal America/New_York. That was never asserted anywhere, just
// true by accident of this machine's OS-level TZ setting (confirmed via `timedatectl`) --
// silently deploying this app to any container/VM with a different system TZ would make every
// one of those call sites wrong by the ET/UTC offset, with no error, just a wrong number
// (exactly the bug class that already invalidated one real backtest -- see the decision's
// resolution). Converting that implicit, unenforced assumption into an explicit, fail-fast one
// costs nothing on a correctly-configured machine and prevents an entire silent bug class on
// a misconfigured one.
{
  const procTZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (procTZ !== 'America/New_York') {
    console.error(`FATAL: process timezone is '${procTZ}', expected 'America/New_York'. This app's naive-timestamp handling (server/db.js, and elapsed-time math throughout server/routes/acd.js) silently depends on the process's ambient timezone matching the DB server's TimeZone=America/New_York config. Set TZ=America/New_York in the environment before starting this process.`);
    process.exit(1);
  }
}

// Route imports
import dailyLogsRouter from './routes/dailyLogs.js';
import tradesRouter from './routes/trades.js';
import statsRouter from './routes/stats.js';
import settingsRouter from './routes/settings.js';
import createSierraRouter from './routes/sierra.js';
import backtestRouter from './routes/backtest.js';
import createPriceBarsRouter from './routes/priceBars.js';
import tearsheetRouter from './routes/tearsheet.js';
import keyLevelsRouter from './routes/keyLevels.js';
import edgeRouter from './routes/edge.js';
import confluenceRouter from './routes/confluence.js';
import longtermRouter from './routes/longterm.js';
import patternRouter from './routes/pattern.js';
import auctionReadRouter from './routes/auctionRead.js';
import weeklyRouter from './routes/weekly.js';
import createACDRouter, { expireStaleSetups, nextTradingDay, isGlobexWeekClosed } from './routes/acd.js';
import setupsRouter from './routes/setups.js';
import phaseChangeRouter from './routes/phaseChange.js';
import calendarRouter from './routes/calendar.js';
import { detectPhaseChange } from './services/phaseChangeDetector.js';
import { detectMomentum60Trend } from './services/minuteBarSignalDetector.js';
import { detectRthFlush } from './services/rthFlushDetector.js';
import { detectGlobexFlush } from './services/globexFlushDetector.js';
import { detectPocRotationJoin } from './services/pocRotationJoinDetector.js';
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
import playbookRouter from './routes/playbook.js';
import performanceAuditRouter from './routes/performanceAudit.js';
import researchRouter from './routes/research.js';
import { computeAndPersistSession } from './services/developingValueService.js';
import cron from 'node-cron';
import { runMorningBriefLogged } from '../scripts/morning_brief.js';
import { runWeeklyReport } from '../scripts/weekly_report.js';
import { run as runMonthlyReport } from '../scripts/monthly_report.js';
import { runDailyCoaching } from '../scripts/daily_coaching.js';

import { query } from './db.js';
import { logProcess } from './lib/processLog.js';
import { recordDetectionPollResult } from './services/detectionHeartbeat.js';
import { computeACDFromBars, getBestACDParams, scanAndSaveSetupEvents, computeORLevelsOnly } from './services/acdService.js';
import { scanAndIngestNewBarFiles } from './services/priceBarService.js';
import { runNightlyUpdate } from './services/patternMemoryUpdate.js';
import { scanSession, persistScan, mineLevelFades } from './services/patternScannerService.js';
import { runLearningDigest } from './services/learningDigestService.js';
import SierraWatcher from './watchers/sierraWatcher.js';

const app = express();
const httpServer = createServer(app);
const io = new SocketIO(httpServer, { cors: { origin: '*', methods: ['GET', 'POST'] } });

app.set('io', io); // makes io available in route handlers via req.app.get('io')

// In-memory ring buffer for errors visible to the Gemini watcher
const recentErrors = [];
const MAX_ERRORS = 50;
function recordError(type, message, detail) {
  recentErrors.unshift({ ts: new Date().toISOString(), type, message, detail: detail?.slice?.(0, 500) });
  if (recentErrors.length > MAX_ERRORS) recentErrors.pop();

  try {
    const filePath = path.join(__dirname, '../scratch/server_errors.jsonl');
    fs.appendFileSync(
      filePath,
      JSON.stringify({ ts: new Date().toISOString(), type, message, detail: detail?.slice?.(0, 300) }) + '\n'
    );
    
    // Trim to 500 lines to avoid infinite growth
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath, 'utf8');
      const lines = data.trim().split('\n');
      if (lines.length > 500) {
        fs.writeFileSync(filePath, lines.slice(lines.length - 500).join('\n') + '\n');
      }
    }
  } catch (_) {}
}

app.use(cors());
// Found 2026-07-15: /api/trades (unbounded "All Trades" list, 40k+ rows) was returning
// a 51MB uncompressed JSON response on every load — no compression middleware existed
// at all (confirmed: no Content-Encoding header on any response before this). gzip on
// JSON text typically compresses 5-10x; this is a pure transport-layer win, zero
// behavior change for any route. See docs/OPEN_THREADS.md.
app.use(compression());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Centralized response interceptor middleware to log all status 500 responses
app.use((req, res, next) => {
  const originalJson = res.json;
  res.json = function (body) {
    if (res.statusCode === 500) {
      const msg = `${req.method} ${req.originalUrl || req.path} — ${body?.error || 'Unknown Error'}`;
      recordError('SERVER_ERROR', msg, new Error().stack);
    }
    return originalJson.apply(this, arguments);
  };
  next();
});

// Static files for uploaded screenshots
const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
app.use('/uploads', express.static(join(__dirname, 'uploads')));

// Standalone read-only quick-check page — market pulse + active setup + session
// timeline in one lightweight static page, no React/build step needed. Meant to be
// viewed directly (bookmarked, behind the Cloudflare Access login on the tunnel),
// not embedded elsewhere.
app.get('/quick-check', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'quick-check.html'));
});

// Setup-performance page (2026-08-29, direct user request): per-setup real N/WR/EV table +
// a day-by-day cumulative P&L chart, linked from quick-check.html's nav. Same standalone
// static-page pattern as quick-check.html above -- explicit route, not generic static
// serving, since the Cloudflare Tunnel's ingress only allow-lists exact paths (see the
// comment on the redirect below) -- this path must ALSO be added to
// ~/.cloudflared/config.yml's ingress rules (outside this repo) or it 404s through the
// tunnel even though it works locally.
app.get('/setup-performance', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'setup-performance.html'));
});

// Bare-root redirect — found 2026-07-30: the Cloudflare Tunnel's ingress only
// allow-lists exact paths (see ~/.cloudflared/config.yml), so hitting the tunnel
// hostname's root with no path (e.g. a bookmark saved as just the domain) fell
// through to the tunnel's own catch-all 404 before ever reaching this server.
// Fixed at both layers: this redirect, plus a matching `^/$` ingress rule added
// the same session so root requests actually reach here instead of dying at the
// edge. Root itself has no real content of its own — /quick-check is the intended
// landing page.
app.get('/', (req, res) => {
  res.redirect('/quick-check');
});

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
      INSERT INTO acd_daily_log (trade_date, or_high, or_low, a_multiplier, a_up_level, a_down_level, a_up_fired, a_down_fired, a_up_time, a_down_time, c_up_confirmed, c_down_confirmed, daily_score, session_close)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      ON CONFLICT (trade_date) DO UPDATE SET
        or_high=$2, or_low=$3, a_multiplier=$4, a_up_level=$5, a_down_level=$6,
        a_up_fired=$7, a_down_fired=$8, a_up_time=$9, a_down_time=$10,
        c_up_confirmed=$11, c_down_confirmed=$12, daily_score=$13, session_close=$14
    `, [todayET, result.orHigh, result.orLow, aMult, result.aUpLevel, result.aDownLevel, result.aUpFired, result.aDownFired, result.aUpTime, result.aDownTime, result.cUpConfirmed, result.cDownConfirmed, result.score, result.sessionClose]);
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
            INSERT INTO acd_daily_log (trade_date, or_high, or_low, a_multiplier, a_up_level, a_down_level, a_up_fired, a_down_fired, a_up_time, a_down_time, c_up_confirmed, c_down_confirmed, daily_score, session_close)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
            ON CONFLICT (trade_date) DO NOTHING
          `, [d, result.orHigh, result.orLow, 0.33, result.aUpLevel, result.aDownLevel, result.aUpFired, result.aDownFired, result.aUpTime, result.aDownTime, result.cUpConfirmed, result.cDownConfirmed, result.score, result.sessionClose]);
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
      const pr = await query(`SELECT MAX(high) as h, MIN(low) as l, (SELECT close FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1::date AND ts < $2::date AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16 ORDER BY ts DESC LIMIT 1) as c FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1::date AND ts < $2::date AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16`, [priorFrom, priorTo]);
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
app.use('/api', backtestRouter);
app.use('/api', tearsheetRouter);
app.use('/api', keyLevelsRouter);
app.use('/api', edgeRouter);
app.use('/api', confluenceRouter);
app.use('/api', longtermRouter);
app.use('/api', patternRouter);
app.use('/api', auctionReadRouter);
app.use('/api', weeklyRouter);

// Factory routers that need io or helper functions
const sierraWatcher = new SierraWatcher(SIERRA_DATA_DIR);
app.use('/api', createSierraRouter(io, sierraWatcher));
app.use('/api', createPriceBarsRouter(io, getBestACDParams, computeORLevelsOnly, autoComputeTodayACD));
app.use('/api', createACDRouter(io));
app.use('/api', phaseChangeRouter);
app.use('/api', setupsRouter);
app.use('/api', calendarRouter);
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
app.use('/api/playbook', playbookRouter);
app.use('/api', performanceAuditRouter);
app.use('/api', researchRouter);

// Client-side error reporting — catches React render crashes via ErrorBoundary

app.post('/api/client-error', (req, res) => {
  const { component, message, stack } = req.body || {};
  console.error(`[CLIENT ERROR] ${component}: ${message}\n${stack || ''}`);
  recordError('CLIENT_ERROR', `${component}: ${message}`, stack);
  res.json({ ok: true });
});

// Gemini watcher polls this to detect errors without log scraping
app.get('/api/errors/recent', (req, res) => {
  const since = req.query.since ? new Date(req.query.since) : null;
  const errors = since ? recentErrors.filter(e => new Date(e.ts) > since) : recentErrors.slice(0, 20);
  res.json({ errors, serverTime: new Date().toISOString() });
});

// Overnight volatility alert — used by pre-session banner
// Returns overnight range, rolling 20-day avg/std, σ level, and alert flag
app.get('/api/vol-alert', async (req, res) => {
  try {
    const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const r = await query(`
      WITH today_on AS (
        SELECT
          MIN(low)::float as on_low, MAX(high)::float as on_high,
          (MAX(high)-MIN(low))::float as on_range
        FROM price_bars_primary
        WHERE ts::date = $1 AND symbol='NQ'
          AND (ts AT TIME ZONE 'America/New_York')::time < '09:30:00'
      ),
      prior_on AS (
        SELECT ts::date, (MAX(high)-MIN(low))::float as rng
        FROM price_bars_primary
        WHERE symbol='NQ'
          AND ts::date IN (
            SELECT DISTINCT ts::date FROM price_bars_primary
            WHERE symbol='NQ' AND ts::date < $1
            ORDER BY ts::date DESC LIMIT 20
          )
          AND (ts AT TIME ZONE 'America/New_York')::time < '09:30:00'
        GROUP BY ts::date
      ),
      on_stats AS (
        SELECT AVG(rng) as avg_rng, STDDEV(rng) as std_rng FROM prior_on
      ),
      today_or AS (
        SELECT (MAX(high)-MIN(low))::float as or_range, COUNT(*) as bar_count
        FROM price_bars_primary
        WHERE ts::date = $1 AND symbol='NQ'
          AND (ts AT TIME ZONE 'America/New_York')::time BETWEEN '09:30:00' AND '10:00:00'
      ),
      prior_or AS (
        SELECT ts::date, (MAX(high)-MIN(low))::float as rng
        FROM price_bars_primary
        WHERE symbol='NQ'
          AND ts::date IN (
            SELECT DISTINCT ts::date FROM price_bars_primary
            WHERE symbol='NQ' AND ts::date < $1
            ORDER BY ts::date DESC LIMIT 20
          )
          AND (ts AT TIME ZONE 'America/New_York')::time BETWEEN '09:30:00' AND '10:00:00'
        GROUP BY ts::date
      ),
      or_stats AS (
        SELECT AVG(rng) as avg_rng, STDDEV(rng) as std_rng FROM prior_or
      )
      SELECT
        t.on_low, t.on_high, t.on_range,
        ROUND(s.avg_rng::numeric, 1) as on_avg_20d,
        ROUND(s.std_rng::numeric, 1) as on_std_20d,
        ROUND(((t.on_range - s.avg_rng) / NULLIF(s.std_rng, 0))::numeric, 2) as on_sigma,
        tor.or_range, tor.bar_count as or_bar_count,
        ROUND(os.avg_rng::numeric, 1) as or_avg_20d,
        ROUND(os.std_rng::numeric, 1) as or_std_20d,
        ROUND(((tor.or_range - os.avg_rng) / NULLIF(os.std_rng, 0))::numeric, 2) as or_sigma
      FROM today_on t, on_stats s, today_or tor, or_stats os
    `, [todayET]);
    const row = r.rows[0];
    if (!row) return res.json({ alert: false });
    const onSigma = parseFloat(row.on_sigma) || 0;
    const orSigma = row.or_bar_count > 0 ? (parseFloat(row.or_sigma) || 0) : null;
    const orAlert = orSigma !== null && orSigma >= 1.0;
    const both = onSigma >= 1.0 && orAlert;
    res.json({
      alert: onSigma >= 1.0 || orAlert,
      // Overnight
      sigma: parseFloat(onSigma.toFixed(2)),
      on_range: Math.round(row.on_range),
      on_low: row.on_low,
      on_high: row.on_high,
      avg_20d: parseFloat(row.on_avg_20d),
      std_20d: parseFloat(row.on_std_20d),
      threshold: Math.round(parseFloat(row.on_avg_20d) + parseFloat(row.on_std_20d)),
      // Opening range (null before 9:35 ET)
      or_alert: orAlert,
      or_sigma: orSigma !== null ? parseFloat(orSigma.toFixed(2)) : null,
      or_range: row.or_bar_count > 0 ? Math.round(row.or_range) : null,
      or_avg_20d: parseFloat(row.or_avg_20d),
      or_std_20d: parseFloat(row.or_std_20d),
      or_threshold: Math.round(parseFloat(row.or_avg_20d) + parseFloat(row.or_std_20d)),
      // Combined flag
      double_alert: both,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

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

// Global Express error middleware — catches any thrown errors from route handlers
// and records them to the in-memory buffer so the Gemini watcher can detect them
app.use((err, req, res, next) => {
  const msg = `${req.method} ${req.path} — ${err.message}`;
  console.error('[SERVER ERROR]', msg, err.stack || '');
  recordError('SERVER_ERROR', msg, err.stack);
  if (!res.headersSent) res.status(500).json({ error: err.message });
});

// Socket.IO
io.on('connection', (socket) => {
  console.log('Dashboard connected:', socket.id);
  socket.on('disconnect', () => console.log('Dashboard disconnected:', socket.id));
});

// Diagnostic instrumentation added 2026-07-17 (overnight_globex_fix_never_ran_uninterrupted
// OPEN_DECISION): the systemd-managed server unit was bounced ~7 times overnight with no
// crash/exception in the logs and no evidence of any known trigger (not the watchdog --
// no WatchdogSec is set --, not gemini_error_watcher.mjs -- its restarts always log a
// SERVER_DOWN alert first and none appeared --, not a cron/OOM/session event). The restart
// signature (clean Stopping->Stopped->Started, no failure code) matches an external
// `systemctl restart`, not Restart=on-failure reacting to a crash -- but nothing pinned down
// WHO issued it. This logs unambiguously so the next occurrence is diagnosable instead of
// another forensic dead end: a real SIGTERM (systemd stopping the unit) is now distinguished
// from an uncaught exception/crash.
async function logShutdown(reason, extra = {}) {
  console.log(`[shutdown] ${reason}`, extra);
  try {
    await query(
      `INSERT INTO process_log (process_name, started_at, status, metadata) VALUES ($1, NOW(), $2, $3)`,
      ['SERVER_SHUTDOWN', reason, JSON.stringify({ uptimeSec: Math.round(process.uptime()), pid: process.pid, ...extra })]
    );
  } catch (e) {
    console.error('[shutdown] failed to log to process_log:', e.message);
  }
}
process.on('SIGTERM', async () => { await logShutdown('SIGTERM'); process.exit(0); });
process.on('SIGINT', async () => { await logShutdown('SIGINT'); process.exit(0); });
process.on('uncaughtException', async (err) => { await logShutdown('UNCAUGHT_EXCEPTION', { error: err.message, stack: err.stack?.slice(0, 2000) }); process.exit(1); });
process.on('unhandledRejection', async (reason) => { await logShutdown('UNHANDLED_REJECTION', { error: String(reason) }); });

const PORT = process.env.PORT || 3001;

// EADDRINUSE retry — a nodemon restart can race the old process's port release, throwing
// EADDRINUSE, which was previously uncaught -> uncaughtException -> exit(1) -> nodemon
// respawns right back into the same race, producing a crash loop (found 2026-08-16, see
// OPEN_DECISION pattern_memory_dev_value_missing_catchup_and_listen_race). This retries a
// handful of times to let the old socket close, then gives up and lets a REAL port conflict
// crash + log normally via the existing uncaughtException -> logShutdown path.
let serverListening = false;
let listenRetryCount = 0;
const LISTEN_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 8000];
httpServer.on('error', (err) => {
  if (serverListening) throw err; // post-bind error, not a listen race — crash normally
  if (err.code === 'EADDRINUSE' && listenRetryCount < LISTEN_RETRY_DELAYS_MS.length) {
    const delay = LISTEN_RETRY_DELAYS_MS[listenRetryCount];
    listenRetryCount++;
    console.warn(`[listen] Port ${PORT} in use (EADDRINUSE) — retry ${listenRetryCount}/${LISTEN_RETRY_DELAYS_MS.length} in ${delay}ms`);
    setTimeout(() => httpServer.listen(PORT), delay);
    return;
  }
  console.error(`[listen] Giving up binding port ${PORT} after ${listenRetryCount} retries:`, err.message);
  throw err; // uncaught -> existing uncaughtException handler -> logShutdown -> exit(1)
});

httpServer.listen(PORT, () => {
  serverListening = true;
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
      // Recompute MGI levels for today after import so level_proximity tags are current
      import('./services/levelProximityService.js').then(({ tagTradesForDate }) => tagTradesForDate(todayET)).catch(() => {});
      // Recompute open_vs_prior_value + overnight_inventory for today (price-data-derived, no manual entry needed)
      try {
        const { execSync } = await import('child_process');
        execSync(`node scripts/backfill_auction_reads.js ${todayET}`, { cwd: process.cwd(), timeout: 30000 });
      } catch (auErr) { console.warn('[auto-import] auction_reads update failed:', auErr.message); }
    } catch (e) { console.error('[auto-import 4PM] Error:', e.message); }
  }, { timezone: 'America/New_York' });

  // Pattern Memory — 4:05 PM ET Mon–Fri
  // NOTE: runNightlyUpdate self-logs via its own logProcess('PATTERN_MEMORY', ...) call — do NOT
  // wrap it in another logProcess here. The prior version passed runNightlyUpdate as a bare
  // function reference to logProcess, which invoked it with ZERO arguments, so tradeDate was
  // always undefined -> NULL, which made populateDailyLog's trade lookup match 0 rows every
  // time and silently no-op (SUCCESS, {skipped:true}) since 2026-06-01 (commit c242c243) — the
  // real cron-triggered update never wrote real data. Fixed 2026-08-19, see OPEN_DECISION
  // pattern_memory_dev_value_missing_catchup_and_listen_race.
  cron.schedule('5 16 * * 1-5', async () => {
    try {
      const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      await runNightlyUpdate(todayET, io);
    } catch (err) { console.error('[pattern_memory] Cron error:', err.message); }
  }, { timezone: 'America/New_York' });

  // Volatility regime history — 4:10 PM ET Mon-Fri. Decided 2026-07-17 (OPEN_DECISION
  // vol_regime_history_cron_undecided) that VOL_REGIME_HIST is an ongoing table, not a
  // one-time snapshot: it exists so future backtests never have to reimplement
  // classifyRegime() by hand (see the script's own header), which only holds if it keeps
  // growing. Incremental by default (skips already-classified days), so this is a
  // sub-second no-op most nights except for classifying the day that just closed.
  cron.schedule('10 16 * * 1-5', async () => {
    try {
      const { execSync } = await import('child_process');
      await logProcess('VOL_REGIME_HIST', async () => {
        execSync('node scripts/backfill_volatility_regime_history.mjs', { cwd: process.cwd(), timeout: 60000 });
        return { count: 1 };
      });
    } catch (err) { console.error('[vol_regime_history] Cron error:', err.message); }
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

  // Pattern Scanner — 4:30 PM ET Mon–Fri (scan today's session + mine level fades)
  cron.schedule('30 16 * * 1-5', async () => {
    try {
      await logProcess('PATTERN_SCAN', async () => {
        const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
        const result = await scanSession(todayET);
        let count = 0;
        if (result) {
          count = await persistScan(todayET, result);
          await mineLevelFades();
        }
        return { count };
      });
    } catch (err) { console.error('[pattern_scan] Cron error:', err.message); }
  }, { timezone: 'America/New_York' });

  // Learning Digest — 4:35 PM ET Mon–Fri (after OPTIMAL_STOP recompute at 4:20 and the
  // pattern scanner at 4:30 both complete) — surfaces new pattern discoveries and
  // meaningful stop/target/status drift since the previous run, pushed live via socket.
  cron.schedule('35 16 * * 1-5', async () => {
    try {
      await logProcess('LEARNING_DIGEST', async () => {
        const result = await runLearningDigest(io);
        return { count: result.count };
      });
    } catch (err) { console.error('[learning_digest] Cron error:', err.message); }
  }, { timezone: 'America/New_York' });

  // Daily Coaching — 4:30 PM ET Mon–Fri (runs after trades are imported at 4:00 PM)
  cron.schedule('30 16 * * 1-5', async () => {
    try {
      await logProcess('DAILY_COACHING', async () => {
        const text = await runDailyCoaching(null, io);
        return { count: text ? 1 : 0 };
      });
    } catch (err) { console.error('[daily_coaching] Cron error:', err.message); }
  }, { timezone: 'America/New_York' });

  // AI Daily Setup Review — 4:35 PM ET Mon–Fri (after coaching + trades imported)
  cron.schedule('35 16 * * 1-5', async () => {
    try {
      await logProcess('AI_DAILY_REVIEW', async () => {
        const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
        // Skip if review already exists for today
        const existing = (await query(`SELECT id FROM daily_ai_reviews WHERE review_date = $1`, [todayET])).rows;
        if (existing.length) { console.log(`[ai_daily_review] Already exists for ${todayET} — skipping`); return { count: 0, skipped: true }; }
        // Skip if no setups fired today
        const setups = (await query(`SELECT id FROM active_setups WHERE trade_date = $1 AND status IN ('RESOLVED','EXPIRED') AND resolution IS NOT NULL`, [todayET])).rows;
        if (!setups.length) { console.log(`[ai_daily_review] No resolved setups for ${todayET} — skipping`); return { count: 0, skipped: true }; }
        // Call our own endpoint (avoids importing Anthropic logic into index.js)
        const port = process.env.PORT || 3002;
        const res = await fetch(`http://localhost:${port}/api/playbook/daily-review/${todayET}/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirmed: true }),
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        console.log(`[ai_daily_review] Generated for ${todayET} — ${(data.stop_target_analysis || []).length} setup ratings`);
        if (io) io.emit('ai-review-ready', { date: todayET, setupCount: (data.stop_target_analysis || []).length });
        return { count: 1 };
      });
    } catch (err) { console.error('[ai_daily_review] Cron error:', err.message); }
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

  // Vol predictive backtest — every Sunday 7:15 PM ET (after combo backtest)
  cron.schedule('15 19 * * 0', async () => {
    try {
      const { spawn } = await import('child_process');
      const child = spawn('node', ['scripts/volatility_predictive_backtest.mjs'], {
        cwd: process.cwd(), detached: true, stdio: 'ignore',
      });
      child.unref();
      console.log('[vol_backtest] Weekly re-run started');
    } catch (err) { console.error('[vol_backtest] Cron error:', err.message); }
  }, { timezone: 'America/New_York' });

  // Weekly recalibration — every Sunday evening ET
  // 7:30 PM: level fade audit (LEVEL_FADE_AUDIT rows — audit table CONTEXT entries)
  // 8:00 PM: MAE/MFE audit (refreshes p75_mae, p50_mfe on all audit rows — powers live alert stops/targets)
  // 9:00 PM: unified backtest (UNIFIED_BACKTEST rows — powers liveStats for live alerts)
  cron.schedule('30 19 * * 0', async () => {
    try {
      const { execSync } = await import('child_process');
      await logProcess('LEVEL_FADE_AUDIT', async () => {
        execSync('node scripts/level_fade_audit.mjs', { cwd: process.cwd(), timeout: 300000 });
        return { count: 1 };
      });
    } catch (err) { console.error('[level_fade_audit] Cron error:', err.message); }
  }, { timezone: 'America/New_York' });

  cron.schedule('0 20 * * 0', async () => {
    try {
      const { execSync } = await import('child_process');
      await logProcess('MAE_MFE_AUDIT', async () => {
        execSync('node scripts/audit_mae_mfe.mjs', { cwd: process.cwd(), timeout: 300000 });
        return { count: 1 };
      });
    } catch (err) { console.error('[mae_mfe_audit] Cron error:', err.message); }
  }, { timezone: 'America/New_York' });

  cron.schedule('0 21 * * 0', async () => {
    try {
      const { execSync } = await import('child_process');
      await logProcess('SYSTEM_BACKTEST', async () => {
        execSync('node scripts/backtest_unified.js', { cwd: process.cwd(), timeout: 600000 });
        return { count: 1 };
      });
    } catch (err) { console.error('[system_backtest] Cron error:', err.message); }
  }, { timezone: 'America/New_York' });

  // 9:10 PM Sunday: day-type × setup_type significance matrix (DAY_TYPE_ALPHA rows)
  // 5:15 PM ET nightly (Mon–Fri): setup latency audit for today's fades.
  // Flags CRITICAL (>10min lag) and RETROACTIVE (early-touch backfill) setups.
  // Writes LATENCY_AUDIT row to performance_audit; appends to scratch/gemini_alerts.txt on critical.
  cron.schedule('15 17 * * 1-5', async () => {
    try {
      const { execSync } = await import('child_process');
      await logProcess('LATENCY_AUDIT', async () => {
        const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
        execSync(`node scripts/audit_setup_latency.mjs ${todayET}`, { cwd: process.cwd(), timeout: 60000 });
        return { count: 1 };
      });
    } catch (err) { console.error('[latency_audit] Cron error:', err.message); }
  }, { timezone: 'America/New_York' });

  // Runs after backtest_unified (9:00 PM) so any new resolved trades are included.
  cron.schedule('10 21 * * 0', async () => {
    try {
      const { execSync } = await import('child_process');
      await logProcess('DAY_TYPE_ALPHA', async () => {
        execSync('node scripts/backtest_day_type_alpha.js', { cwd: process.cwd(), timeout: 120000 });
        return { count: 1 };
      });
    } catch (err) { console.error('[day_type_alpha] Cron error:', err.message); }
  }, { timezone: 'America/New_York' });

  // 9:13 PM Sunday: optimal stops/targets — derives p75 MAE stop and p50 MFE target
  // per setup_type from active_setups MAE/MFE backfill. Feeds liveStats._opt in acd.js.
  cron.schedule('13 21 * * 0', async () => {
    try {
      const { execSync } = await import('child_process');
      await logProcess('OPTIMAL_STOP', async () => {
        execSync('node scripts/update_optimal_stops.mjs', { cwd: process.cwd(), timeout: 120000 });
        return { count: 1 };
      });
    } catch (err) { console.error('[optimal_stop] Cron error:', err.message); }
  }, { timezone: 'America/New_York' });

  // 9:15 PM Sunday: pulse score backtest — validates MC-calibrated session-state conditions
  // against resolved setups. Writes PULSE_SCORE_AUDIT rows (16: 4 day_types × 4 score buckets).
  cron.schedule('15 21 * * 0', async () => {
    try {
      const { execSync } = await import('child_process');
      await logProcess('PULSE_SCORE_AUDIT', async () => {
        execSync('node scripts/backtest_pulse_score.mjs', { cwd: process.cwd(), timeout: 180000 });
        return { count: 1 };
      });
    } catch (err) { console.error('[pulse_score] Cron error:', err.message); }
  }, { timezone: 'America/New_York' });

  // 9:17 PM Sunday: auto-suppress/promote engine — computes per-setup WR/EV/N all-time,
  // SUPPRESS at N≥50+WR<48%+EV<-$5, PROMOTE when recent-90d WR≥52%+EV>$0+N≥15.
  // Writes SETUP_STATUS rows and directly flips open active_setups rows.
  // THIS IS THE SAFETY NET — if this stops running, losing setups accumulate silently.
  cron.schedule('17 21 * * 0', async () => {
    try {
      const { execSync } = await import('child_process');
      await logProcess('SETUP_STATUS', async () => {
        execSync('node scripts/backtest_setup_status.mjs', { cwd: process.cwd(), timeout: 120000 });
        return { count: 1 };
      });
    } catch (err) { console.error('[setup_status] Cron error:', err.message); }
  }, { timezone: 'America/New_York' });

  // 9:20 PM Sunday: permission slip mining — discovers ACD signal combinations that
  // reliably bias session direction. Writes PERMISSION_SLIP rows to performance_audit.
  // Runs after DAY_TYPE_ALPHA (9:10 PM). API reads these instead of hardcoded stats.
  cron.schedule('20 21 * * 0', async () => {
    try {
      const { execSync } = await import('child_process');
      await logProcess('PERMISSION_SLIP', async () => {
        execSync('node scripts/backtest_permission_slips.mjs', { cwd: process.cwd(), timeout: 60000 });
        return { count: 1 };
      });
    } catch (err) { console.error('[permission_slip] Cron error:', err.message); }
  }, { timezone: 'America/New_York' });

  // 9:05 PM Sunday: AI review aggregation — aggregate AI_SETUP_REVIEW ratings per setup_type
  // and behavioral theme frequencies from coaching text. Writes AI_SETUP_AGG + BEHAVIORAL_STATS rows.
  cron.schedule('5 21 * * 0', async () => {
    try {
      const { execSync } = await import('child_process');
      await logProcess('AI_SETUP_AGG', async () => {
        execSync('node scripts/aggregate_ai_setup_reviews.js', { cwd: process.cwd(), timeout: 60000 });
        execSync('node scripts/aggregate_behavioral_stats.js', { cwd: process.cwd(), timeout: 60000 });
        return { count: 1 };
      });
    } catch (err) { console.error('[ai_setup_agg] Cron error:', err.message); }
  }, { timezone: 'America/New_York' });

  // 9:25 PM Sunday: session bias mining — discovers simple 1-2-variable stats
  // (morning dir, IB break, day type, DOW, etc.) → writes SESSION_BIAS rows to performance_audit
  cron.schedule('25 21 * * 0', async () => {
    try {
      const { execSync } = await import('child_process');
      await logProcess('SESSION_BIAS', async () => {
        execSync('node scripts/mine_session_bias.mjs', { cwd: process.cwd(), timeout: 120000 });
        return { count: 1 };
      });
    } catch (err) { console.error('[session_bias] Cron error:', err.message); }
  }, { timezone: 'America/New_York' });

  // 6:00 AM Sunday: context edge analysis + confluence pair backtest (writes CONTEXT_ANALYSIS to performance_audit + confluence_pairs_latest.json)
  cron.schedule('0 6 * * 0', async () => {
    try {
      const { execSync } = await import('child_process');
      await logProcess('CONTEXT_ANALYSIS', async () => {
        execSync('node scripts/context_analysis.js', { cwd: process.cwd(), timeout: 300000, maxBuffer: 50 * 1024 * 1024 });
        return { count: 1 };
      });
    } catch (err) { console.error('[context_analysis] Cron error:', err.message); }
  }, { timezone: 'America/New_York' });

  // 8:30 PM Sunday: setup anticipation recalibration (writes SETUP_ANTICIPATION to performance_audit)
  cron.schedule('30 20 * * 0', async () => {
    try {
      const { execSync } = await import('child_process');
      await logProcess('SETUP_ANTICIPATION', async () => {
        execSync('node scripts/backtest_level_approach.js', { cwd: process.cwd(), timeout: 300000 });
        return { count: 1 };
      });
    } catch (err) { console.error('[setup_anticipation] Cron error:', err.message); }
  }, { timezone: 'America/New_York' });

  // 9:07 PM Sunday: MAE/MFE backfill — fills any missing bars for today's resolved setups
  // Must run before optimal stops (9:13 PM) so new data is included in stop computation.
  cron.schedule('7 21 * * 0', async () => {
    try {
      const { execSync } = await import('child_process');
      await logProcess('MAE_MFE_BACKFILL', async () => {
        execSync('node scripts/backfill_mae_mfe.mjs', { cwd: process.cwd(), timeout: 300000 });
        return { count: 1 };
      });
    } catch (err) { console.error('[mae_mfe_backfill] Cron error:', err.message); }
  }, { timezone: 'America/New_York' });

  // 9:22 PM Sunday: level fade audit — per-level EV/WR/N for all 50+ tracked levels
  cron.schedule('22 21 * * 0', async () => {
    try {
      const { execSync } = await import('child_process');
      await logProcess('LEVEL_FADE_AUDIT', async () => {
        execSync('node scripts/level_fade_audit.mjs', { cwd: process.cwd(), timeout: 300000 });
        return { count: 1 };
      });
    } catch (err) { console.error('[level_fade_audit] Cron error:', err.message); }
  }, { timezone: 'America/New_York' });

  // 9:30 PM Sunday: compute MGI levels for the upcoming Monday session and tag any new BP fills
  // Resolves OPEN_DECISION sunday_compute_levels_cron_date_semantics_unclear (2026-08-19):
  // this cron used to write level_prices keyed to Sunday's OWN calendar date, but
  // compute_levels.js computes a row to SERVE the given date's live trading session (OR/IB
  // levels for that session, PRIOR_DAY levels relative to it, etc) -- Sunday itself is not a
  // real trading day, so that row was never read live by anything. Every other Sunday-evening
  // Globex fire already stamps active_setups.trade_date as the upcoming Monday (confirmed
  // live) via the same nextTradingDay() logic used here -- this cron now matches that
  // convention, so level_prices has a fresh Monday row available for the whole Sunday
  // 6PM-Monday 8AM Globex window, not just from the separate 8AM Mon-Fri cron onward.
  // tagTradesForDate() is a different concern (retroactively tags real `trades` journal rows
  // by their own log_date) and deliberately keeps using Sunday's own calendar date.
  cron.schedule('30 21 * * 0', async () => {
    try {
      const { execSync } = await import('child_process');
      await logProcess('COMPUTE_LEVELS', async () => {
        const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
        const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
        const sessionDate = nextTradingDay(nowET);
        execSync(`node scripts/compute_levels.js ${sessionDate}`, { cwd: process.cwd(), timeout: 60000 });
        const { tagTradesForDate } = await import('./services/levelProximityService.js');
        const tagged = await tagTradesForDate(today);
        return { count: tagged };
      });
    } catch (err) { console.error('[compute_levels] Cron error:', err.message); }
  }, { timezone: 'America/New_York' });

  // 8:00 AM ET Mon-Fri: compute today's level_prices row. Found 2026-07-27: this cron
  // block above was the ONLY automated writer of level_prices anywhere in this codebase
  // (confirmed via grep -- no other cron, no other INSERT/UPDATE against the table), and
  // it only fires on SUNDAY, writing a row keyed to Sunday's own calendar date. Every
  // Mon-Fri weekday had ZERO automated refresh -- live acd.js's `WHERE trade_date=$1`
  // level_prices query (exact match, no fallback, ~line 4948) would return empty on any
  // day this hadn't been run, and the level-fade candidates array would silently miss
  // every static level (PD/PW/PM/3M/PY/camarilla/floor-pivot/WEEKLY_OPEN/etc; only
  // real-time-computed OR/IB levels still worked). Confirmed live-impacting: caught
  // because 2026-07-27 (today, a Monday) had zero rows until run manually mid-session --
  // WEEKLY_OPEN/PW_VAH were 28500/29355.5 once freshly computed, meaningfully different
  // from the stale week-old 28747.75/29884.5 the live system had been serving all
  // morning. Deliberately a SEPARATE cron rather than widening the Sunday one's day-of-week
  // field -- the Sunday run's own semantics (does it correctly represent the *coming*
  // Monday's session, or literally Sunday's calendar date?) is a separate, not-yet-
  // resolved question (see OPEN_DECISION level_prices_missing_for_current_trade_date /
  // its Sunday-cron-date-semantics follow-up) and changing it without more certainty
  // risks corrupting the one case that WAS working. This new block only fixes the
  // unambiguous Mon-Fri gap, where "today's calendar date" and "today's trade_date" are
  // the same value with no ambiguity. Runs before the 8:30 AM Morning Brief cron so any
  // level_prices reads there also get fresh data.
  cron.schedule('0 8 * * 1-5', async () => {
    try {
      const { execSync } = await import('child_process');
      await logProcess('COMPUTE_LEVELS_WEEKDAY', async () => {
        const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
        execSync(`node scripts/compute_levels.js ${today}`, { cwd: process.cwd(), timeout: 60000 });
        return { count: 1 };
      });
    } catch (err) { console.error('[compute_levels_weekday] Cron error:', err.message); }
  }, { timezone: 'America/New_York' });

  // 11:00 AM ET Mon-Fri: re-run compute_levels.js for TODAY, after Initial Balance closes.
  // Found 2026-08-26 (auditing a liquidity-zones census dispatch): both automated
  // compute_levels.js crons (the Sunday-9:30PM one above and the 8AM Mon-Fri one directly
  // above) run BEFORE the trading day's own RTH session opens, so `computeLevelsForDate()`'s
  // CURRENT-category same-day-forming levels (OR5/OR10/OR15/OR30_HIGH/LOW/MID,
  // IB_HIGH/LOW/MID) can never satisfy their own `or_?.orh`/`ib?.h` guards at either cron's
  // fire time -- that day's OR/IB literally hasn't formed yet. Confirmed via `acd_daily_log`/
  // `price_bars_primary` both having correct data for every affected date, and a manual
  // `node scripts/compute_levels.js <past-date>` immediately producing correct values --
  // the function is fine, only the timing of the two existing crons is wrong for this one
  // category. Silently produced a real ~2-week data gap (level_prices frozen at its
  // 2026-08-12 value for OR5/IB, and OR10/15/30 stuck at their single one-time backfill row)
  // that only affects historical/research reads of level_prices (`getLevelsForDate()`-style
  // lookups in backtest/pilot scripts) -- NOT live trading, which computes OR/IB live from
  // `acd_daily_log`/bars directly, never from this table. This cron does not replace either
  // existing one (PD_*/PW_*/PY_*/VWAP-to-date etc. are still best refreshed pre-market) --
  // it only exists to give the CURRENT-category levels one more pass once they can actually
  // be computed for the day in progress. IB is the latest-forming of the six (10:30 AM
  // close), so 11:00 AM leaves comfortable margin without waiting long into the session.
  cron.schedule('0 11 * * 1-5', async () => {
    try {
      const { execSync } = await import('child_process');
      await logProcess('COMPUTE_LEVELS_POST_IB', async () => {
        const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
        // --category=CURRENT (2026-08-31, OPEN_DECISION
        // compute_levels_11am_cron_overwrites_full_session_levels): this cron exists ONLY to
        // give the same-day-forming OR/IB levels a pass once they can actually be computed --
        // without this flag it re-upserts EVERY category, including RTH_VWAP, which at 11am
        // is still only a partial (9:30-11:00) average and would freeze that partial value
        // into the same column a full-session read later expects.
        execSync(`node scripts/compute_levels.js ${today} --category=CURRENT`, { cwd: process.cwd(), timeout: 60000 });
        return { count: 1 };
      });
    } catch (err) { console.error('[compute_levels_post_ib] Cron error:', err.message); }
  }, { timezone: 'America/New_York' });

  // Value-area regime measurement layer (2026-07-31) — see docs/OPEN_THREADS.md's
  // 2026-07-31 entry. Pure tagging, no gating: computes today's true volume-weighted
  // value area at 7 lookbacks (into value_area_regime_snapshots) so every setup fired
  // today can be stamped with its position against them. Runs after compute_levels
  // (needs no dependency on it, just avoiding concurrent heavy queries) and before
  // market open.
  cron.schedule('5 8 * * 1-5', async () => {
    try {
      const { execSync } = await import('child_process');
      await logProcess('VALUE_AREA_REGIME_SNAPSHOT', async () => {
        const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
        execSync(`node scripts/compute_value_area_regime_snapshots.mjs ${today}`, { cwd: process.cwd(), timeout: 60000 });
        return { count: 1 };
      });
    } catch (err) { console.error('[value_area_regime_snapshot] Cron error:', err.message); }
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
              // Also run AI setup review now that fills are in
              const portNum = process.env.PORT || 3002;
              const existingReview = (await query(`SELECT id FROM daily_ai_reviews WHERE review_date = $1`, [today])).rows;
              if (!existingReview.length) {
                const resolvedSetups = (await query(`SELECT id FROM active_setups WHERE trade_date = $1 AND status IN ('RESOLVED','EXPIRED') AND resolution IS NOT NULL LIMIT 1`, [today])).rows;
                if (resolvedSetups.length) {
                  await logProcess('AI_DAILY_REVIEW', async () => {
                    const res = await fetch(`http://localhost:${portNum}/api/playbook/daily-review/${today}/generate`, {
                      method: 'POST', headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ confirmed: true }),
                    });
                    const d = await res.json();
                    return { count: d.error ? 0 : 1 };
                  });
                }
              }
            }
          }
        }
      }

      // Developing Value Tracker catch-up — due 4:05 PM Mon–Fri; catch up after 5 PM.
      // computeAndPersistSession() has no "silently skipped but reported SUCCESS" ambiguity
      // (unlike Pattern Memory below), so a plain process_log SUCCESS check is sufficient here,
      // matching the convention the other catch-up branches already use.
      if (day >= 1 && day <= 5 && hour >= 17) {
        const { rows } = await query(
          `SELECT 1 FROM process_log WHERE process_name = 'DEVELOPING_VALUE' AND status = 'SUCCESS' AND started_at::date = CURRENT_DATE LIMIT 1`
        );
        if (rows.length === 0) {
          console.log('[catch-up] Developing Value Tracker overdue — running now');
          await logProcess('DEVELOPING_VALUE', async () => {
            const r = await computeAndPersistSession(today);
            return { count: r ? 1 : 0 };
          });
        }
      }

      // Pattern Memory catch-up — due 4:05 PM Mon–Fri; catch up after 5 PM. Deliberately does
      // NOT check process_log SUCCESS: a genuinely-skipped day (0 trades) also logs SUCCESS
      // with {skipped:true}, so that alone can't distinguish "ran fine, nothing to log" from
      // "never really ran." Guard on the real signal instead — trades exist for today but
      // daily_performance_log has no row yet. runNightlyUpdate self-logs; do not wrap it here
      // (see the cron.schedule('5 16 * * 1-5', ...) block's comment above for why).
      if (day >= 1 && day <= 5 && hour >= 17) {
        const [tradeRows, dplRows] = await Promise.all([
          query(`SELECT 1 FROM trades WHERE log_date = $1 AND pnl IS NOT NULL LIMIT 1`, [today]),
          query(`SELECT 1 FROM daily_performance_log WHERE trade_date = $1 LIMIT 1`, [today]),
        ]);
        if (tradeRows.rows.length > 0 && dplRows.rows.length === 0) {
          console.log('[catch-up] Pattern Memory overdue (trades exist, no daily_performance_log row) — running now');
          await runNightlyUpdate(today, io);
        }
      }

      // Pattern Memory HISTORICAL catch-up (2026-08-31, OPEN_DECISION
      // condition_memory_needs_rebuild_not_backfill) -- the same-day check above only ever
      // looks at `today`, so a trade whose data lands AFTER its own calendar day has already
      // passed (a late Sierra Chart import, a manual reconciliation, or the server being down
      // during that evening's catch-up window) permanently never gets a daily_performance_log
      // row -- nothing else in this codebase ever re-scans the past for this gap. Confirmed
      // live: 2026-08-03 and 2026-08-12 trades were both imported in a single batch on
      // 2026-08-12 20:52 ET (9 days late for the 08-03 rows), by which point `today` had moved
      // on and neither date was ever re-checked -- daily_performance_log stalled at 2026-07-31
      // for a month with zero errors logged anywhere. Runs every tick (not hour/day-gated,
      // since it's catching up PAST dates, not today), bounded to a 90-day lookback and capped
      // at 5 dates per tick to avoid a large backlog hammering the DB in one go.
      const missingDplRows = await query(`
        SELECT DISTINCT t.log_date::text as trade_date
        FROM trades t
        WHERE t.pnl IS NOT NULL
          AND t.log_date >= (CURRENT_DATE - INTERVAL '90 days')
          AND t.log_date < CURRENT_DATE
          AND NOT EXISTS (SELECT 1 FROM daily_performance_log d WHERE d.trade_date = t.log_date)
        ORDER BY t.log_date ASC
        LIMIT 5
      `);
      for (const row of missingDplRows.rows) {
        console.log(`[catch-up] Pattern Memory historical gap found for ${row.trade_date} (trades exist, no daily_performance_log row, not today) — running now`);
        await runNightlyUpdate(row.trade_date, io);
      }

      // Daily coaching — due 4:30 PM Mon–Fri; catch up after 5 PM
      // Re-run only if coaching has never run OR it ran with 0 live-account trades but live fills now exist.
      // Uses LIKE '%-PRO%' to match live accounts — avoids infinite loop when sim-only fills exist.
      if (day >= 1 && day <= 5 && hour >= 17) {
        const [coachRows, liveFillRows] = await Promise.all([
          query(`SELECT trades_count FROM daily_coaching WHERE session_date = $1 LIMIT 1`, [today]),
          query(`SELECT COUNT(*) as count FROM trades WHERE log_date = $1 AND custom_fields->>'account' LIKE '%-PRO%'`, [today]),
        ]);
        const coached = coachRows.rows[0];
        const liveFillCount = parseInt(liveFillRows.rows[0]?.count || 0);
        const needsCoaching = !coached || (coached.trades_count === 0 && liveFillCount > 0);
        if (needsCoaching) {
          console.log(`[catch-up] Daily coaching ${!coached ? 'overdue' : `stale (0 live trades coached, ${liveFillCount} live fills now in DB)`} — running now`);
          await logProcess('DAILY_COACHING', async () => {
            const text = await runDailyCoaching(null, io);
            return { count: text ? 1 : 0 };
          });
        }
      }

      // AI daily setup review — due 4:35 PM Mon–Fri; catch up after 5 PM
      if (day >= 1 && day <= 5 && hour >= 17) {
        const [reviewRows, setupRows] = await Promise.all([
          query(`SELECT id FROM daily_ai_reviews WHERE review_date = $1 LIMIT 1`, [today]),
          query(`SELECT id FROM active_setups WHERE trade_date = $1 AND status IN ('RESOLVED','EXPIRED') AND resolution IS NOT NULL LIMIT 1`, [today]),
        ]);
        if (!reviewRows.rows.length && setupRows.rows.length) {
          console.log('[catch-up] AI daily setup review overdue — running now');
          const port = process.env.PORT || 3002;
          await logProcess('AI_DAILY_REVIEW', async () => {
            const res = await fetch(`http://localhost:${port}/api/playbook/daily-review/${today}/generate`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ confirmed: true }),
            });
            const d = await res.json();
            if (d.error) throw new Error(d.error);
            return { count: 1 };
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
        const [prevCoachRows, prevLiveFillRows] = await Promise.all([
          query(`SELECT trades_count FROM daily_coaching WHERE session_date = $1 LIMIT 1`, [prevDay]),
          query(`SELECT COUNT(*) as count FROM trades WHERE log_date = $1 AND custom_fields->>'account' LIKE '%-PRO%'`, [prevDay]),
        ]);
        const prevCoached = prevCoachRows.rows[0];
        const prevLiveFillCount = parseInt(prevLiveFillRows.rows[0]?.count || 0);
        const prevNeedsCoaching = prevLiveFillCount > 0 && (!prevCoached || (prevCoached.trades_count === 0 && prevLiveFillCount > 0));
        if (prevNeedsCoaching) {
          console.log(`[catch-up] Prior day coaching missing for ${prevDay} (${prevLiveFillCount} live fills in DB) — running now`);
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

  console.log('[cron] Registered: Morning Brief 8:30AM, Auto-Import 4PM, Pattern Memory 4:05PM, Pattern Scan 4:30PM, Daily Coaching 4:30PM, AI Setup Review 4:35PM ET Mon-Fri | Weekly Report 6PM, Monthly Report 7PM, LevelFadeAudit 7:30PM, MAE/MFE Audit 8PM, UnifiedBacktest 9PM, ComputeLevels 9:30PM ET Sun | Catch-up every 30min');

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

  // Server-autonomous detection: poll /api/acd/setup-detection every 15s across real CME
  // Globex hours (Sun 6PM ET -> Fri 5PM ET, with the daily 5-6PM ET maintenance break),
  // not just RTH. Extended 2026-07-16 per user request — level types that only make sense
  // during RTH (OR/IB-dependent ones) self-gate on their own etMin checks inside acd.js's
  // candidates array and simply return a null level outside RTH (filtered out before
  // insert); level types anchored to prior-day/week/month reference points or overnight
  // levels (ONH/ONL) are legitimately checkable at any hour. This is the correct endpoint —
  // it runs the full level-fade detection and INSERTs to active_setups (idempotent — ON
  // CONFLICT DO NOTHING). Polling at 15s instead of 60s cuts the detection window from up
  // to 60s to at most 15s, closing the gap for static levels that should fire within one cycle.
  setInterval(async () => {
    try {
      const etNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
      // FIXED 2026-08-20: was 4 predicates hand-rolled inline here, now diverged from an
      // identical copy in acd.js's own inGlobex gate (fixed same session,
      // detector_fires_during_weekend_globex_closure) -- both now call the single shared
      // isGlobexWeekClosed(), extracted to acd.js so it's importable here without a cycle.
      if (isGlobexWeekClosed(etNow)) return;
      const res = await fetch(`http://localhost:${PORT}/api/acd/setup-detection`, { signal: AbortSignal.timeout(14000) });
      if (!res.ok) {
        console.error(`[detection-poll] ${res.status} from /api/acd/setup-detection`);
        await recordDetectionPollResult(false, `HTTP ${res.status}`);
      } else {
        await res.text(); // drain body
        await recordDetectionPollResult(true, null);
      }
    } catch (err) {
      if (err.name !== 'TimeoutError') console.error('[detection-poll] Error:', err.message);
      // Direct heartbeat, not a proxy — added 2026-07-16 (docs/OPEN_THREADS.md) after
      // finding /api/settings/process-health's SETUP_DETECTION entry only ever inferred
      // health from bar freshness, which can't tell "detection stopped" from "no new bar
      // yet" apart. This records the poll's own actual success/failure, durably, so a
      // future gap like the unexplained 2026-07-13 ~1-hour one has a real record instead
      // of relying on journal logs that didn't survive.
      await recordDetectionPollResult(false, err.message).catch(() => {});
    }
  }, 15000);

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
          (SELECT close FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1::date AND ts < $2::date
           AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16 ORDER BY ts DESC LIMIT 1) as c
        FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1::date AND ts < $2::date
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
      // MOMENTUM_60m_60m_TREND — see server/services/minuteBarSignalDetector.js header for why
      // this needed its own poller rather than the level-fade candidates array in acd.js
      detectMomentum60Trend(io).catch(() => {});
      // RTH_FLUSH / GLOBEX_FLUSH — docs/LIQUIDITY_ZONES_DEFENDED_LEVELS_SPEC.md sec 4.4-4.14.
      // Own pollers for the same reason as MOMENTUM_60m_60m_TREND: a whole-session structural-
      // break-then-consolidation pattern, not a price touching a fixed level.
      detectRthFlush(io).catch(() => {});
      detectGlobexFlush(io).catch(() => {});
      // POC_ROTATION_JOIN_LONG/SHORT — OPEN_DECISION poc_rotation_join_build_live_detector
      // (2026-09-01). Own poller for the same reason as the flush detectors above: a
      // whole-session leg/pivot-tracking pattern, not a price touching a fixed level.
      detectPocRotationJoin(io).catch(() => {});
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
          file: `TradeActivityLogExport_${todayStr}.txt`,
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

  // Pattern memory nightly job: REMOVED 2026-08-19 (was a redundant second scheduler,
  // present since 2026-05-22/de8860f, firing runNightlyUpdate every minute from 4:05-4:10 PM
  // ET -- up to 6x/day). updateConditionMemory() has no per-trade_date idempotency guard, so
  // this was silently inflating condition_memory's occurrences/wins/losses/total_pnl by up to
  // 6x every trading day. The cron.schedule('5 16 * * 1-5', ...) block above (fixed the same
  // session, see its comment) plus the catch-up branch in the */30 self-healing block now
  // fully replace this. See OPEN_DECISION pattern_memory_dev_value_missing_catchup_and_listen_race.

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
