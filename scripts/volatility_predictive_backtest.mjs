import pg from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'trading_journal',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD,
});

function stdevLogReturns(fiveMin) {
  if (fiveMin.length < 3) return null;
  const rets = [];
  for (let i = 1; i < fiveMin.length; i++) {
    const c0 = fiveMin[i - 1].close, c1 = fiveMin[i].close;
    if (c0 > 0 && c1 > 0) rets.push(Math.log(c1 / c0));
  }
  if (rets.length < 2) return null;
  const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
  const variance = rets.reduce((s, x) => s + (x - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance);
}

function fiveMinBars(oneMinBars) {
  const buckets = {};
  for (const b of oneMinBars) {
    const bucket = Math.floor(b.et_min / 5) * 5;
    if (!buckets[bucket]) buckets[bucket] = { et_min: bucket, open: b.open, high: b.high, low: b.low, close: b.close };
    else {
      const x = buckets[bucket];
      x.high = Math.max(x.high, b.high);
      x.low = Math.min(x.low, b.low);
      x.close = b.close;
    }
  }
  return Object.values(buckets).sort((a, b) => a.et_min - b.et_min);
}

function correlation(x, y) {
  const n = x.length;
  const meanX = x.reduce((s, v) => s + v, 0) / n;
  const meanY = y.reduce((s, v) => s + v, 0) / n;
  const num = x.reduce((s, v, i) => s + (v - meanX) * (y[i] - meanY), 0);
  const den = Math.sqrt(x.reduce((s, v) => s + (v - meanX) ** 2, 0) * y.reduce((s, v) => s + (v - meanY) ** 2, 0));
  return den > 0 ? num / den : 0;
}

function tierStats(arr) {
  const n = arr.length;
  return {
    n,
    avgFhRange:   Math.round((arr.reduce((s, x) => s + x.fhRange, 0) / n) * 10) / 10,
    avgDayRange:  Math.round((arr.reduce((s, x) => s + x.dayRange, 0) / n) * 10) / 10,
    breakoutRate: Math.round((arr.filter(x => x.didBreak).length / n) * 1000) / 10,
    avgExpansion: Math.round((arr.reduce((s, x) => s + x.totalExpansion, 0) / n) * 10) / 10,
    volP33: arr[arr.length - 1].fhVol, // max fhVol in this tier = upper boundary
  };
}

function textureStats(arr) {
  const valid = arr.filter(x => x.fhDirection !== 0);
  const n = valid.length;
  return {
    n,
    continuationRate: Math.round((valid.filter(x => x.isContinuation).length / n) * 1000) / 10,
    reversalRate:     Math.round((valid.filter(x => x.isReversal).length / n) * 1000) / 10,
  };
}

async function run() {
  console.log('[vol_backtest] Starting...');

  const barsQ = await pool.query(`
    SELECT DISTINCT ON (ts) ts::date::text as d,
      (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts))::int as et_min,
      open::float, high::float, low::float, close::float
    FROM price_bars
    WHERE symbol='NQ' AND ts::date < CURRENT_DATE
      AND (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts)) BETWEEN 570 AND 959
    ORDER BY ts, id DESC
  `);

  const barsByDate = {};
  for (const b of barsQ.rows) (barsByDate[b.d] ??= []).push(b);

  const sessions = [];

  for (const d of Object.keys(barsByDate).sort()) {
    const dayBars = barsByDate[d].sort((a, b) => a.et_min - b.et_min);
    if (dayBars.length < 200) continue;

    const fh   = dayBars.filter(b => b.et_min <= 630);
    const post = dayBars.filter(b => b.et_min > 630);
    if (fh.length < 15 || post.length < 15) continue;

    const fhOpen  = fh[0].open;
    const fhHigh  = Math.max(...fh.map(b => b.high));
    const fhLow   = Math.min(...fh.map(b => b.low));
    const fhClose = fh[fh.length - 1].close;
    const fhRange = fhHigh - fhLow;

    const fhVol = stdevLogReturns(fiveMinBars(fh));
    if (fhVol == null) continue;

    // Close-to-close Kaufman ER — matches volatilityRegimeService.js so the cutoff is directly comparable
    const fhCloses = fh.map(b => b.close);
    const fhNetMove = Math.abs(fhClose - fhOpen);
    const fhSumMoves = fhCloses.slice(1).reduce((s, c, i) => s + Math.abs(c - fhCloses[i]), 0);
    const fhEfficiency = fhSumMoves > 0 ? fhNetMove / fhSumMoves : 0;

    const dayOpen  = dayBars[0].open;
    const dayHigh  = Math.max(...dayBars.map(b => b.high));
    const dayLow   = Math.min(...dayBars.map(b => b.low));
    const dayClose = dayBars[dayBars.length - 1].close;
    const dayRange = dayHigh - dayLow;

    const postHigh = Math.max(...post.map(b => b.high));
    const postLow  = Math.min(...post.map(b => b.low));
    const didBreak = postHigh > fhHigh || postLow < fhLow;
    const totalExpansion = Math.max(0, postHigh - fhHigh) + Math.max(0, fhLow - postLow);

    const fhDirection  = fhClose > fhOpen ? 1 : fhClose < fhOpen ? -1 : 0;
    const dayDirection = dayClose > dayOpen ? 1 : dayClose < dayOpen ? -1 : 0;

    sessions.push({
      date: d, fhRange, fhVol, fhEfficiency, fhDirection,
      dayRange, didBreak, totalExpansion,
      isContinuation: fhDirection !== 0 && fhDirection === dayDirection,
      isReversal:     fhDirection !== 0 && dayDirection !== 0 && fhDirection !== dayDirection,
    });
  }

  if (sessions.length === 0) {
    console.log('[vol_backtest] No sessions — aborting.');
    await pool.end();
    return;
  }

  // Vol tiers (equal thirds by fhVol)
  sessions.sort((a, b) => a.fhVol - b.fhVol);
  const n = sessions.length;
  const tSize = Math.floor(n / 3);
  const lowVol  = sessions.slice(0, tSize);
  const midVol  = sessions.slice(tSize, tSize * 2);
  const highVol = sessions.slice(tSize * 2);

  // Efficiency split (median)
  const sortedByEff = [...sessions].sort((a, b) => a.fhEfficiency - b.fhEfficiency);
  const lowEff  = sortedByEff.slice(0, Math.floor(n / 2));
  const highEff = sortedByEff.slice(Math.floor(n / 2));

  // Vol percentile cutoffs — used by live card to determine which tier current session is in
  const volP33 = lowVol[lowVol.length - 1].fhVol;   // 33rd percentile upper bound
  const volP66 = midVol[midVol.length - 1].fhVol;   // 66th percentile upper bound
  const effMedian = sortedByEff[Math.floor(n / 2)].fhEfficiency;

  const results = {
    sessionCount: n,
    runAt: new Date().toISOString(),
    volCutoffs: {
      p33: Math.round(volP33 * 1e6) / 1e6,
      p66: Math.round(volP66 * 1e6) / 1e6,
    },
    efficiencyCutoff: Math.round(effMedian * 1e4) / 1e4,
    tiers: {
      low:  tierStats(lowVol),
      mid:  tierStats(midVol),
      high: tierStats(highVol),
    },
    texture: {
      lowEff:  textureStats(lowEff),
      highEff: textureStats(highEff),
    },
    correlations: {
      volToRange:     Math.round(correlation(sessions.map(s => s.fhVol), sessions.map(s => s.dayRange)) * 1000) / 1000,
      volToExpansion: Math.round(correlation(sessions.map(s => s.fhVol), sessions.map(s => s.totalExpansion)) * 1000) / 1000,
    },
  };

  await pool.query(
    `INSERT INTO vol_backtest_cache (session_count, results) VALUES ($1, $2)`,
    [n, JSON.stringify(results)]
  );

  console.log(`[vol_backtest] Done — ${n} sessions. Tiers: low=${lowVol.length}, mid=${midVol.length}, high=${highVol.length}`);
  console.log(`[vol_backtest] Expansion targets: low=${results.tiers.low.avgExpansion}pts, mid=${results.tiers.mid.avgExpansion}pts, high=${results.tiers.high.avgExpansion}pts`);
  console.log(`[vol_backtest] Continuation: lowEff=${results.texture.lowEff.continuationRate}%, highEff=${results.texture.highEff.continuationRate}%`);

  await pool.end();
}

run().catch(e => { console.error('[vol_backtest] Error:', e.message); process.exit(1); });
