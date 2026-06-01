import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';
import Anthropic from '@anthropic-ai/sdk';
import { query } from '../db.js';
import { manualImportFromFile, getImportHistory } from '../services/tradeImportService.js';
import { checkAndEmitDLL } from './dll.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Anthropic client
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Chart upload multer
const chartsDir = path.join(__dirname, '../uploads/charts');
const chartStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, chartsDir),
  filename: (req, file, cb) => cb(null, `${req.params.date}${path.extname(file.originalname).toLowerCase()}`)
});
const chartUpload = multer({
  storage: chartStorage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/jpeg|jpg|png|gif|webp/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Images only'));
  }
});

// Factory function: returns router with io and sierraWatcher injected
export default function createSierraRouter(io, sierraWatcher) {
  const router = express.Router();

  // ===== SIERRA CHART API =====
  router.get('/sierra/status', (req, res) => {
    res.json(sierraWatcher.getStatus());
  });

  router.post('/sierra/import', async (req, res) => {
    const { filePath } = req.body;
    if (!filePath) return res.status(400).json({ error: 'filePath required' });

    try {
      const result = await manualImportFromFile(filePath);
      io.emit('trades-updated', { ...result, timestamp: new Date() });
      checkAndEmitDLL(io).catch(() => {});
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.get('/sierra/history', async (req, res) => {
    try {
      const history = await getImportHistory(parseInt(req.query.limit) || 50);
      res.json(history);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // ==================== SIERRA CHART SYNC TRIGGER ====================
  router.post('/trigger-export', async (req, res) => {
    res.json({ ok: true, message: 'Export started' });

    const emitProgress = (step, message, status = 'running') => {
      io.emit('sync-progress', { step, message, status, timestamp: new Date() });
    };

    try {
      const { spawn } = await import('child_process');
      emitProgress(1, 'Launching export script...', 'running');

      await new Promise((resolve, reject) => {
        const proc = spawn('powershell.exe', [
          '-ExecutionPolicy', 'Bypass',
          '-NonInteractive',
          '-File', 'C:\\SierraChart\\export_tal.ps1'
        ], { timeout: 60000 });

        let out = '';
        let step = 1;
        proc.stdout.on('data', d => {
          const text = d.toString();
          out += text;
          text.split('\n').forEach(line => {
            line = line.trim();
            if (!line || line.startsWith('#')) return;
            let msg = line, status = 'running';
            if (line === 'NEED_TAL_OPEN')                       { step = 2; msg = '⚠ Trade Activity Log is not open in Sierra Chart'; status = 'need_tal'; }
            else if (line.startsWith('Found:'))                { step = 2; msg = `✓ ${line}`; }
            else if (line.includes('Checking if TAL'))         { step = 2; msg = '⏳ Checking if Trade Activity Log is open…'; }
            else if (line.includes('Looking for Trade'))       { step = 2; msg = '⏳ Looking for Trade Activity Log…'; }
            else if (line.includes('TAL not open'))            { step = 2; msg = '⏳ TAL not open — trying to open it…'; }
            else if (line.includes('TAL focused') || line.includes('TAL opened'))  { step = 3; msg = `✓ ${line}`; }
            else if (line.includes('Triggering File'))         { step = 4; msg = '⏳ Triggering File → Export…'; }
            else if (line.includes('Setting save path'))       { step = 5; msg = '⏳ Setting save path and confirming…'; }
            else if (line.includes('Waiting for file'))        { step = 5; msg = `⏳ ${line} — waiting for file…`; }
            else if (line.includes('Detected:'))               { step = 6; msg = `✓ ${line}`; }
            else if (line.includes('Renaming'))                { step = 7; msg = `✓ ${line}`; }
            else if (line.startsWith('SUCCESS'))               { step = 8; msg = `✓ ${line}`; status = 'success'; }
            else if (line.startsWith('NEED_TAL') || line.startsWith('ERROR') || line.includes('ERROR:')) { status = 'error'; }
            emitProgress(step, msg, status);
          });
        });
        proc.stderr.on('data', d => {
          const text = d.toString().trim();
          out += text;
          if (text) {
            const clean = text.replace(/.*At .*\.ps1:\d+.*\n?/g, '').replace(/^\s*\+.*\n?/gm, '').trim();
            if (clean) emitProgress(step, `✕ ${clean}`, 'error');
          }
        });
        proc.on('close', code => {
          if (code !== 0 && !out.includes('SUCCESS')) reject(new Error(out.trim() || `Exit code ${code}`));
          else resolve(out);
        });
        proc.on('error', reject);
      });

      emitProgress(8, 'Export complete — importing trades...', 'success');
    } catch (err) {
      console.error('Export trigger error:', err.message);
      io.emit('sync-progress', { step: -1, message: err.message, status: 'error', timestamp: new Date() });
    }
  });

  // ==================== CHART UPLOAD & AI ANALYSIS ====================

  // GET all dates that have uploaded charts
  router.get('/charts/dates', async (req, res) => {
    try {
      const result = await query(`SELECT log_date, analysis IS NOT NULL as analyzed FROM daily_charts ORDER BY log_date`);
      res.json(result.rows.map(r => ({ date: r.log_date, analyzed: r.analyzed })));
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET chart info for a date
  router.get('/charts/:date', async (req, res) => {
    try {
      const { date } = req.params;
      const result = await query(`SELECT * FROM daily_charts WHERE log_date = $1`, [date]);
      if (!result.rows.length) return res.json(null);
      const row = result.rows[0];
      res.json({ ...row, image_url: `/uploads/charts/${path.basename(row.image_path)}` });
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST upload chart image for a date
  router.post('/charts/:date/upload', chartUpload.single('chart'), async (req, res) => {
    try {
      const { date } = req.params;
      const { chart_type = 'daily' } = req.body;
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

      const existing = await query(`SELECT image_path FROM daily_charts WHERE log_date = $1`, [date]);
      if (existing.rows.length && existing.rows[0].image_path !== req.file.path) {
        try { fs.unlinkSync(existing.rows[0].image_path); } catch(_) {}
      }

      await query(`
        INSERT INTO daily_charts (log_date, image_path, chart_type)
        VALUES ($1, $2, $3)
        ON CONFLICT (log_date) DO UPDATE SET image_path = $2, chart_type = $3, analysis = NULL, analyzed_at = NULL
      `, [date, req.file.path, chart_type]);

      res.json({ image_url: `/uploads/charts/${req.file.filename}`, chart_type });
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST analyze chart with Claude
  router.post('/charts/:date/analyze', async (req, res) => {
    try {
      const { date } = req.params;
      const { chart_type = 'daily', accounts = [] } = req.body;

      if (!process.env.ANTHROPIC_API_KEY) return res.status(400).json({ error: 'ANTHROPIC_API_KEY not set in .env' });

      const MAX_CALLS = parseInt(process.env.MAX_MONTHLY_ANALYSES || '50');
      const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0,0,0,0);
      const callsThisMonth = await query(
        `SELECT COALESCE(SUM(api_calls),0) as total FROM daily_charts WHERE analyzed_at >= $1`, [monthStart]
      );
      if (parseInt(callsThisMonth.rows[0].total) >= MAX_CALLS) {
        return res.status(429).json({ error: `Monthly analysis limit (${MAX_CALLS}) reached. Increase MAX_MONTHLY_ANALYSES in .env to continue.` });
      }

      const chartRow = await query(`SELECT * FROM daily_charts WHERE log_date = $1`, [date]);
      if (!chartRow.rows.length) return res.status(404).json({ error: 'No chart uploaded for this date' });
      const imagePath = chartRow.rows[0].image_path;
      if (!fs.existsSync(imagePath)) return res.status(404).json({ error: 'Image file not found on disk' });

      const imageData = fs.readFileSync(imagePath);
      const base64Image = imageData.toString('base64');
      const ext = path.extname(imagePath).toLowerCase().replace('.', '');
      const mediaType = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;

      let prompt;

      if (chart_type === 'weekly') {
        prompt = `You are helping a futures trader prepare for the upcoming trading week. They trade NQ (Nasdaq futures) micro contracts.

Attached is a longer-timeframe chart for weekly preparation. Please:
1. Identify key levels visible (support, resistance, value areas if volume profile is shown, POC, VAH, VAL)
2. Describe the current market structure (trending up/down, ranging, at key decision level, etc.)
3. Suggest 2-3 specific scenarios to watch for the coming week (e.g. "if price holds above X, look for Y")
4. Note any high-volume nodes or gaps that could act as magnets
Keep it focused and actionable — this is a pre-market planning tool, not a general market recap.`;
      } else {
        const parsePnl = `replace(replace(custom_fields->'sierra_data'->>'FlatToFlat Profit/Loss (C)','F',''),' ','')::numeric`;
        const byAccount = await query(`
          SELECT
            custom_fields->>'account' as account,
            entry_time,
            exit_time as exit_et,
            symbol,
            direction,
            custom_fields->'sierra_data'->>'Max Open Quantity' as max_qty,
            SUM(${parsePnl}) as trade_pnl
          FROM trades
          WHERE log_date = $1
            AND custom_fields->'sierra_data'->>'Exit DateTime' LIKE '% EP'
            AND custom_fields->'sierra_data'->>'FlatToFlat Profit/Loss (C)' ~ '^-?[0-9]+(\\.[0-9]+)? *F$'
          GROUP BY custom_fields->>'account', entry_time, exit_time, symbol, direction, custom_fields->'sierra_data'->>'Max Open Quantity'
          ORDER BY custom_fields->>'account', exit_time
        `, [date]);

        const accountMap = {};
        for (const row of byAccount.rows) {
          if (!accountMap[row.account]) accountMap[row.account] = [];
          accountMap[row.account].push(row);
        }

        const fmt = (dt) => new Date(dt).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: true });

        const accountBlocks = Object.entries(accountMap).map(([acct, trades]) => {
          const total = trades.reduce((s, r) => s + parseFloat(r.trade_pnl), 0);
          const lines = trades.map((r, i) => {
            const pnl = parseFloat(r.trade_pnl);
            const dir = (r.direction || '').charAt(0).toUpperCase() + (r.direction || '').slice(1).toLowerCase();
            const qty = r.max_qty || r.quantity || '?';
            const entry = fmt(r.entry_time);
            const exit = fmt(r.exit_et);
            return `    Trade ${i+1}: ${entry}–${exit} ET | ${r.symbol} ${dir} qty:${qty} | ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`;
          }).join('\n');
          return `  Account ${acct} — Total: ${total >= 0 ? '+' : ''}$${total.toFixed(2)}\n${lines}`;
        }).join('\n\n');

        const grandTotal = byAccount.rows.reduce((s, r) => s + parseFloat(r.trade_pnl), 0);

        const priorAnalyses = await query(`
          SELECT log_date::text, LEFT(analysis, 300) as summary
          FROM daily_charts
          WHERE log_date < $1 AND analysis IS NOT NULL
          ORDER BY log_date DESC LIMIT 4
        `, [date]);

        const priorContext = priorAnalyses.rows.length
          ? '\n\nRecent prior day notes:\n' + priorAnalyses.rows.map(r => `${r.log_date}: ${r.summary}`).join('\n')
          : '';

        prompt = `You are reviewing a NQ (Nasdaq futures) trader's performance for ${date}.
Grand total P&L across all accounts: ${grandTotal >= 0 ? '+' : ''}$${grandTotal.toFixed(2)}

Trades by account (each trade is a flat-to-flat round trip, chronological):
${accountBlocks}
${priorContext}

Attached is the price action chart for this day. Begin your response with these two lines first, before any analysis. Use exactly this format, no extra words:
CHART_RANGE: 9:45 AM - 11:30 AM
PRICE_RANGE: 24800 - 25200

Then structure the rest as follows:

**Per-Account Review**
For each account, write a short section. If two or more accounts have identical exit times and matching P&Ls, note "Copytraded" and skip the individual breakdown — just say how the copytrade performed overall. Otherwise, group the account's trades into time clusters (trades within ~10 min of each other) and comment on what price was doing at that time on the chart, whether the trades made structural sense, and what went right or wrong.

**Overall Analysis**
Cover as many themes as you observe — patterns across accounts, whether the trader was on the right side of the market, where they left money on the table, or where they traded well. Be as detailed as the day warrants. Specific and chart-grounded only — no generic advice.

**Chart Verdict**
Step back and describe what kind of day this was from a pure price action perspective — was it trending, choppy, range-bound, news-driven, did it have a clear directional bias or fake both ways? Given how the chart actually played out, what was the highest-probability approach for this specific day (e.g. fade the open, buy the first pullback, stay flat until a level broke)? Then assess: did the trades taken align with that, and if not, what one adjustment would have made the biggest difference?

Be specific to what you see on the chart. Do not give generic trading advice.`;
      }

      const message = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 3000,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Image } },
            { type: 'text', text: prompt }
          ]
        }]
      });

      const raw = message.content[0].text;

      const chartRangeMatch = raw.match(/^CHART_RANGE:\s*(.+)$/m);
      const priceRangeMatch = raw.match(/^PRICE_RANGE:\s*(.+)$/m);
      const analysis = raw.replace(/^CHART_RANGE:.*$/m, '').replace(/^PRICE_RANGE:.*$/m, '').trim();

      let chartStart = null, chartEnd = null, priceLow = null, priceHigh = null;
      if (chartRangeMatch) {
        const times = [...chartRangeMatch[1].matchAll(/\b(\d{1,2}:\d{2}\s*(?:AM|PM))\b/gi)];
        if (times.length >= 2) { chartStart = times[0][1].trim(); chartEnd = times[times.length - 1][1].trim(); }
        else if (times.length === 1) { chartStart = times[0][1].trim(); }
      }
      if (priceRangeMatch) {
        const nums = [...priceRangeMatch[1].matchAll(/[\d,]+/g)].map(m => parseFloat(m[0].replace(/,/g, '')));
        if (nums.length >= 2) { priceLow = Math.min(...nums); priceHigh = Math.max(...nums); }
      }

      await query(`
        UPDATE daily_charts SET analysis = $1, analyzed_at = NOW(), api_calls = api_calls + 1,
          chart_start = $3, chart_end = $4, chart_price_low = $5, chart_price_high = $6
        WHERE log_date = $2
      `, [analysis, date, chartStart, chartEnd, priceLow, priceHigh]);

      res.json({ analysis, analyzed_at: new Date(), chart_start: chartStart, chart_end: chartEnd, chart_price_low: priceLow, chart_price_high: priceHigh });
    } catch(e) {
      console.error('Chart analysis error:', e);
      res.status(500).json({ error: e.message });
    }
  });

  // DELETE chart for a date
  router.delete('/charts/:date', async (req, res) => {
    try {
      const { date } = req.params;
      const existing = await query(`SELECT image_path FROM daily_charts WHERE log_date = $1`, [date]);
      if (existing.rows.length) {
        try { fs.unlinkSync(existing.rows[0].image_path); } catch(_) {}
        await query(`DELETE FROM daily_charts WHERE log_date = $1`, [date]);
      }
      res.json({ ok: true });
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}
