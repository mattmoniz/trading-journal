import express from 'express';
import { query } from '../db.js';
import { ingestBarFile, scanAndIngestNewBarFiles, getBars, parseContractFromFilename } from '../services/priceBarService.js';
import { detectPhaseChange } from '../services/phaseChangeDetector.js';
import { detectAndEmitSetup } from '../services/setupEmitter.js';

const router = express.Router();

const SIERRA_DATA_DIR = process.env.SIERRA_DATA_PATH || '/mnt/c/SierraChart/Data';

// Factory function that needs io for emit calls, and ACD helpers
export default function createPriceBarsRouter(io, getBestACDParams, computeORLevelsOnly, autoComputeTodayACD) {
  // On startup: auto-ingest any new bar files already sitting in the data dir
  setTimeout(async () => {
    try { await scanAndIngestNewBarFiles(SIERRA_DATA_DIR); } catch (e) { console.error('Auto-ingest error:', e.message); }
  }, 5000);

  // Auto-sync bars every 60s during RTH (9:25 AM - 4:05 PM ET Mon-Fri)
  setInterval(async () => {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const h = now.getHours(), m = now.getMinutes(), dow = now.getDay();
    if (dow === 0 || dow === 6) return;
    if (h < 9 || (h === 9 && m < 25) || h > 16 || (h === 16 && m > 5)) return;
    try {
      const results = await scanAndIngestNewBarFiles(SIERRA_DATA_DIR);
      const updated = results.filter(r => !r.error && !r.skipped);
      if (updated.length > 0) {
        const totalBars = updated.reduce((s, r) => s + (r.bars_inserted || 0), 0);
        io.emit('price-sync-progress', { status: 'success', message: `Auto-sync: ${totalBars} bars`, total: updated.length, done: updated.length });
        if (updated.some(r => r.symbol === 'NQ')) setTimeout(autoComputeTodayACD, 1000);
      }
    } catch (e) { /* silent */ }
  }, 60000);

  const router = express.Router();

  // GET /api/price-bars/status
  router.get('/price-bars/status', async (req, res) => {
    try {
      const result = await query(`
        SELECT filename, contract, symbol, bars_inserted, date_from, date_to, ingested_at
        FROM price_bar_ingests ORDER BY symbol, date_from
      `);
      const coverage = await query(`
        SELECT symbol, MIN(ts) as from_ts, MAX(ts) as to_ts, COUNT(*) as total_bars,
          COUNT(DISTINCT contract) as contracts
        FROM price_bars GROUP BY symbol ORDER BY symbol
      `);
      res.json({ ingests: result.rows, coverage: coverage.rows });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // POST /api/price-bars/ingest
  router.post('/price-bars/ingest', async (req, res) => {
    try {
      res.json({ ok: true, message: 'Bar data scan started' });
      io.emit('price-sync-progress', { status: 'running', message: 'Scanning for updated bar files…', total: 0, done: 0 });

      const results = await scanAndIngestNewBarFiles(SIERRA_DATA_DIR);
      const updated = results.filter(r => !r.error && !r.skipped);
      const totalBars = updated.reduce((s, r) => s + (r.bars_inserted || 0), 0);

      if (updated.length === 0) {
        io.emit('price-sync-progress', { status: 'success', message: 'Price data already up to date', total: 0, done: 0 });
      } else {
        const rolloverFiles = results.filter(r => r.rolloverWarning);
        const rolloverMsg = rolloverFiles.length ? ` ⚠️ CONTRACT ROLLOVER: ${rolloverFiles.map(r => r.contract).join(', ')}` : '';
        io.emit('price-sync-progress', { status: 'success', message: `${updated.length} file(s) updated · ${totalBars.toLocaleString()} bars ingested${rolloverMsg}`, total: updated.length, done: updated.length, rollover: rolloverFiles.length > 0 });
        if (updated.some(r => r.symbol === 'NQ')) setTimeout(autoComputeTodayACD, 1000);
        if (updated.some(r => r.symbol === 'NQ')) {
          const todayForDetect = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
          setTimeout(() => detectPhaseChange(io, todayForDetect).catch(() => {}), 1500);
          setTimeout(() => detectAndEmitSetup(io, todayForDetect).catch(() => {}), 2500);
        }
        if (updated.some(r => r.symbol === 'NQ')) {
          const nowET2 = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
          const h2 = nowET2.getHours(), m2 = nowET2.getMinutes();
          if ((h2 === 9 && m2 >= 35) || (h2 === 10)) {
            setTimeout(async () => {
              const todayET2 = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
              const { aMult } = await getBestACDParams();
              const levels = await computeORLevelsOnly(todayET2, aMult);
              if (levels) {
                console.log(`OR levels set after bar sync: A Up ${levels.aUpLevel} / A Down ${levels.aDownLevel}`);
                io.emit('acd-levels-updated', levels);
              }
            }, 2000);
          }
        }
      }
    } catch (err) {
      io.emit('price-sync-progress', { status: 'error', message: err.message });
    }
  });

  // GET /api/price-bars/query
  router.get('/price-bars/query', async (req, res) => {
    try {
      const { symbol, from, to, interval = 1 } = req.query;
      if (!symbol || !from || !to) return res.status(400).json({ error: 'symbol, from, to required' });
      const bars = await getBars(symbol, new Date(from), new Date(to), parseInt(interval));
      res.json(bars);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // GET /api/price-bars/volume-profile
  router.get('/price-bars/volume-profile', async (req, res) => {
    try {
      const { symbol = 'NQ', date, session = 'rth', contract } = req.query;
      if (!date) return res.status(400).json({ error: 'date required (YYYY-MM-DD)' });

      const prevDay = new Date(date + 'T12:00:00Z');
      prevDay.setUTCDate(prevDay.getUTCDate() - 1);
      const prev = prevDay.toISOString().slice(0, 10);

      let fromTs, toTs, sessionLabel;
      if (session === 'overnight') {
        fromTs = `${prev} 16:15:00`; toTs = `${date} 09:29:59`; sessionLabel = 'Overnight';
      } else if (session === 'both') {
        fromTs = `${prev} 16:15:00`; toTs = `${date} 16:14:59`; sessionLabel = 'Full Day';
      } else {
        fromTs = `${date} 09:30:00`; toTs = `${date} 16:14:59`; sessionLabel = 'RTH';
      }

      let contractFilter = contract;
      if (!contractFilter) {
        const r = await query(
          `SELECT contract FROM price_bars WHERE symbol=$1 AND ts::text BETWEEN $2 AND $3
           GROUP BY contract ORDER BY COUNT(*) DESC LIMIT 1`,
          [symbol, fromTs, toTs]
        );
        if (!r.rows.length) return res.status(404).json({ error: 'No bars found for this date' });
        contractFilter = r.rows[0].contract;
      }

      const bars = await query(
        `SELECT open, high, low, close, volume, bid_volume, ask_volume
         FROM price_bars WHERE contract=$1 AND ts::text BETWEEN $2 AND $3 ORDER BY ts`,
        [contractFilter, fromTs, toTs]
      );

      if (!bars.rows.length) return res.status(404).json({ error: 'No bars found' });

      const TICK = 0.25;
      const volByPrice = {};
      const bidByPrice = {};
      const askByPrice = {};

      for (const bar of bars.rows) {
        const lo  = parseFloat(bar.low);
        const hi  = parseFloat(bar.high);
        const vol = parseFloat(bar.volume) || 0;
        const bid = parseFloat(bar.bid_volume) || 0;
        const ask = parseFloat(bar.ask_volume) || 0;
        const ticks = Math.round((hi - lo) / TICK) + 1;
        const vpt = vol / ticks;
        const bpt = bid / ticks;
        const apt = ask / ticks;

        for (let p = lo; p <= hi + 0.001; p += TICK) {
          const key = Math.round(p / TICK) * TICK;
          volByPrice[key] = (volByPrice[key] || 0) + vpt;
          bidByPrice[key] = (bidByPrice[key] || 0) + bpt;
          askByPrice[key] = (askByPrice[key] || 0) + apt;
        }
      }

      const levels = Object.keys(volByPrice)
        .map(k => parseFloat(k))
        .sort((a, b) => a - b);

      let pocPrice = levels[0], pocVol = 0;
      for (const p of levels) {
        if (volByPrice[p] > pocVol) { pocVol = volByPrice[p]; pocPrice = p; }
      }

      const totalVol = Object.values(volByPrice).reduce((s, v) => s + v, 0);
      const vaTarget = totalVol * 0.70;
      const pocIdx = levels.indexOf(pocPrice);
      let vaVol = volByPrice[pocPrice];
      let loIdx = pocIdx, hiIdx = pocIdx;
      while (vaVol < vaTarget && (loIdx > 0 || hiIdx < levels.length - 1)) {
        const addHi = hiIdx < levels.length - 1 ? volByPrice[levels[hiIdx + 1]] : 0;
        const addLo = loIdx > 0 ? volByPrice[levels[loIdx - 1]] : 0;
        if (addHi >= addLo && hiIdx < levels.length - 1) { hiIdx++; vaVol += addHi; }
        else if (loIdx > 0) { loIdx--; vaVol += addLo; }
        else { hiIdx++; vaVol += addHi; }
      }

      const profile = levels.map(p => ({
        price: p,
        volume: Math.round(volByPrice[p]),
        bid:    Math.round(bidByPrice[p]),
        ask:    Math.round(askByPrice[p]),
      }));

      res.json({
        contract: contractFilter,
        date,
        session: sessionLabel,
        fromTs,
        toTs,
        totalBars: bars.rows.length,
        totalVolume: Math.round(totalVol),
        poc: pocPrice,
        vah: levels[hiIdx],
        val: levels[loIdx],
        profile,
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // GET /api/price-bars/available
  router.get('/price-bars/available', async (req, res) => {
    try {
      const result = await query(`
        SELECT symbol, contract, MIN(ts) as from_ts, MAX(ts) as to_ts, COUNT(*) as bars
        FROM price_bars GROUP BY symbol, contract ORDER BY symbol, from_ts
      `);
      res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  return router;
}
