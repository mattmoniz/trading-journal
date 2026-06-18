import { createReadStream } from 'fs';
import readline from 'readline';
import { query } from '../db.js';

// ── CSV parsing (kept for manual uploads) ────────────────────────────────────

async function parseCSVToSessions(csvPath, startDate, endDate) {
  const bars = [];
  await new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: createReadStream(csvPath), crlfDelay: Infinity });
    let isFirst = true;
    rl.on('line', (line) => {
      line = line.trim();
      if (!line) return;
      if (isFirst) { isFirst = false; return; }
      const cols = line.split(',').map(s => s.trim());
      if (cols.length < 5) return;
      let date, time, open, high, low, close;
      if (cols[0].includes(' ') || (cols[0].includes('-') && !cols[1].match(/^\d{2}:\d{2}/))) {
        const dtParts = cols[0].split(/[ T]/);
        date = dtParts[0]; time = dtParts[1]?.substring(0, 5) || '00:00';
        [open, high, low, close] = cols.slice(1, 5).map(parseFloat);
      } else {
        date = cols[0]; time = cols[1]?.substring(0, 5) || '00:00';
        [open, high, low, close] = cols.slice(2, 6).map(parseFloat);
      }
      if (!date || !time || isNaN(open) || isNaN(high) || isNaN(low) || isNaN(close)) return;
      if (startDate && date < startDate) return;
      if (endDate && date > endDate) return;
      bars.push({ date, time, open, high, low, close });
    });
    rl.on('close', resolve);
    rl.on('error', reject);
  });
  const sessionMap = {};
  for (const bar of bars) {
    if (!sessionMap[bar.date]) sessionMap[bar.date] = [];
    sessionMap[bar.date].push(bar);
  }
  return Object.entries(sessionMap)
    .map(([date, bars]) => ({ date, bars: bars.sort((a, b) => a.time.localeCompare(b.time)) }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ── DB-based session loading ──────────────────────────────────────────────────
// Bars stored with ET face value at UTC (09:30 ET = 09:30Z)

async function loadSessionsFromDB(startDate, endDate) {
  const params = [];
  let where = `symbol = 'NQ' AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16`;
  if (startDate) { params.push(startDate); where += ` AND ts::date >= $${params.length}`; }
  if (endDate)   { params.push(endDate);   where += ` AND ts::date <= $${params.length}`; }

  const res = await query(`
    SELECT
      ts::date::text as date,
      to_char(ts, 'HH24:MI') as time,
      open::float, high::float, low::float, close::float
    FROM price_bars_primary
    WHERE ${where}
    ORDER BY ts ASC
  `, params);

  const sessionMap = {};
  for (const bar of res.rows) {
    if (!sessionMap[bar.date]) sessionMap[bar.date] = [];
    sessionMap[bar.date].push(bar);
  }
  return Object.entries(sessionMap)
    .map(([date, bars]) => ({ date, bars }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ── Time helpers ──────────────────────────────────────────────────────────────

function addMinutes(hhmm, mins) {
  const [h, m] = hhmm.split(':').map(Number);
  const tot = h * 60 + m + mins;
  return `${String(Math.floor(tot / 60)).padStart(2, '0')}:${String(tot % 60).padStart(2, '0')}`;
}

function minutesBetween(t1, t2) {
  const toM = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  return toM(t2) - toM(t1);
}

// ── Core ACD functions ────────────────────────────────────────────────────────

function getOpeningRange(bars, orMinutes) {
  const orEnd = addMinutes('09:30', orMinutes);
  const orBars = bars.filter(b => b.time >= '09:30' && b.time < orEnd);
  if (orBars.length === 0) return null;
  const high = Math.max(...orBars.map(b => b.high));
  const low  = Math.min(...orBars.map(b => b.low));
  if (high === low) return null;
  return { high, low, range: high - low, endTime: orEnd };
}

function detectASignal(bars, or, aUp, aDown, sustainMinutes, scanEndTime = '16:00') {
  let aUpTime = null, aDownTime = null;
  const postOR = bars.filter(b => b.time >= or.endTime && b.time < scanEndTime);
  for (const bar of postOR) {
    if (!aDownTime) {
      if (!aUpTime && bar.high >= aUp) aUpTime = bar.time;
      if (aUpTime) {
        if (bar.low < or.high) { aUpTime = null; }
        else if (minutesBetween(aUpTime, bar.time) >= sustainMinutes) {
          return { type: 'A_UP', time: bar.time, entryPrice: aUp };
        }
      }
    }
    if (!aUpTime) {
      if (!aDownTime && bar.low <= aDown) aDownTime = bar.time;
      if (aDownTime) {
        if (bar.high > or.low) { aDownTime = null; }
        else if (minutesBetween(aDownTime, bar.time) >= sustainMinutes) {
          return { type: 'A_DOWN', time: bar.time, entryPrice: aDown };
        }
      }
    }
  }
  return { type: 'NONE' };
}

function detectCSignal(bars, or, signalType, signalTime) {
  // Scan from the later of: signal time or OR end (handles long ORs naturally)
  const minTime = signalTime && signalTime > or.endTime ? signalTime : or.endTime;
  const lateBars = bars.filter(b => b.time >= minTime);
  for (const bar of lateBars) {
    if (signalType === 'A_UP'   && bar.close > or.high) return true;
    if (signalType === 'A_DOWN' && bar.close < or.low)  return true;
  }
  return false;
}

function scoreDay(signalType, cConfirmed) {
  if (signalType === 'A_UP'   && cConfirmed) return  4;
  if (signalType === 'A_UP')                 return  1;
  if (signalType === 'A_DOWN' && cConfirmed) return -4;
  if (signalType === 'A_DOWN')               return -1;
  return 0;
}

function calculateOutcome(bars, signal, or, holdStrategy) {
  const entry = signal.entryPrice;
  const stop  = signal.type === 'A_UP' ? or.low : or.high;
  const risk  = Math.abs(entry - stop);
  if (risk === 0) return null;

  let mfe = 0, mae = 0, exitPrice = null, exitReason = null;
  const endTime = holdStrategy === 'session_close' ? '16:00' : '23:59';
  const tradeBars = bars.filter(b => b.time >= signal.time);

  for (const bar of tradeBars) {
    const fav = signal.type === 'A_UP' ? bar.high - entry : entry - bar.low;
    const adv = signal.type === 'A_UP' ? entry - bar.low : bar.high - entry;
    mfe = Math.max(mfe, fav); mae = Math.max(mae, adv);
    if (signal.type === 'A_UP'   && bar.low  <= stop) { exitPrice = stop; exitReason = 'STOP'; break; }
    if (signal.type === 'A_DOWN' && bar.high >= stop) { exitPrice = stop; exitReason = 'STOP'; break; }
    if (bar.time >= endTime) { exitPrice = bar.close; exitReason = 'SESSION_CLOSE'; break; }
  }
  if (!exitPrice && tradeBars.length > 0) { exitPrice = tradeBars[tradeBars.length - 1].close; exitReason = 'END_OF_DATA'; }
  if (!exitPrice) return null;

  const pnl  = signal.type === 'A_UP' ? exitPrice - entry : entry - exitPrice;
  const pnlR = pnl / risk;
  return { pnl, pnlR, mfe, mae, exitPrice, exitReason, riskInPoints: risk, stopPrice: stop };
}

// ── Number line ───────────────────────────────────────────────────────────────

class NLTracker {
  constructor() { this.scores = []; }
  add(score) { this.scores.push(score); }
  sum(n = 30) { return this.scores.slice(-n).reduce((s, v) => s + v, 0); }
}

// ── Results analysis ──────────────────────────────────────────────────────────

function analyzeResults(trades) {
  if (trades.length === 0) {
    return { totalSignals: 0, winRate: 0, avgWinR: 0, avgLossR: 0, payoffRatio: 0, evPerTrade: 0, profitFactor: 0, nlAbove9: { count: 0, winRate: null }, nlBelow9: { count: 0, winRate: null }, nlRanging: { count: 0, winRate: null }, trades: [] };
  }
  const winners = trades.filter(t => t.pnlR > 0);
  const losers  = trades.filter(t => t.pnlR <= 0);
  const wr      = winners.length / trades.length;
  const avgW    = winners.length ? winners.reduce((s, t) => s + t.pnlR, 0) / winners.length : 0;
  const avgL    = losers.length  ? Math.abs(losers.reduce((s, t) => s + t.pnlR, 0) / losers.length) : 0;
  const ev      = wr * avgW - (1 - wr) * avgL;
  const pf      = avgL > 0 ? (wr * avgW) / ((1 - wr) * avgL) : 0;
  const safeWR  = arr => arr.length ? arr.filter(t => t.pnlR > 0).length / arr.length : null;
  const nlUp    = trades.filter(t => t.numberLine30 >   9);
  const nlDn    = trades.filter(t => t.numberLine30 <  -9);
  const nlRng   = trades.filter(t => t.numberLine30 >= -9 && t.numberLine30 <= 9);
  return {
    totalSignals: trades.length,
    winRate: wr, avgWinR: avgW, avgLossR: avgL,
    payoffRatio: avgL > 0 ? avgW / avgL : 0,
    evPerTrade: ev, profitFactor: pf,
    nlAbove9:  { count: nlUp.length,  winRate: safeWR(nlUp)  },
    nlBelow9:  { count: nlDn.length,  winRate: safeWR(nlDn)  },
    nlRanging: { count: nlRng.length, winRate: safeWR(nlRng) },
    trades,
  };
}

// ── Core backtest (works from either sessions array or CSV path) ──────────────

async function runBacktestOnSessions(sessions, params) {
  const {
    orMinutes = 5,
    aMultiplier = 0.33,
    sustainMinutes = 3,
    holdStrategy = 'session_close',
    nlAligned = false,        // only trade when signal matches NL direction
    orRangeMax = null,        // skip days where OR range exceeds this (points)
    orRangeMin = null,        // skip days where OR range is below this (points)
    cConfirmedOnly = false,   // only count trades that also get C confirmation
  } = params;

  const nl = new NLTracker();
  const trades = [];

  for (const { date, bars } of sessions) {
    const or = getOpeningRange(bars, orMinutes);
    if (!or) { nl.add(0); continue; }

    // OR range filter
    if (orRangeMax !== null && or.range > orRangeMax) { nl.add(0); continue; }
    if (orRangeMin !== null && or.range < orRangeMin) { nl.add(0); continue; }

    const aUp   = or.high + or.range * aMultiplier;
    const aDown = or.low  - or.range * aMultiplier;
    // For long ORs, scan the rest of RTH for A signal (not just to 11:00)
    const scanEnd = or.endTime > '11:00' ? '16:00' : '16:00';
    const sig   = detectASignal(bars, or, aUp, aDown, sustainMinutes, scanEnd);
    const cConf = sig.type !== 'NONE' ? detectCSignal(bars, or, sig.type, sig.time) : false;
    const score = scoreDay(sig.type, cConf);
    nl.add(score);

    if (sig.type === 'NONE') continue;

    // NL alignment filter: only trade with the trend
    const nl30 = nl.sum(30);
    if (nlAligned) {
      const longBias  = nl30 >= 0;
      const shortBias = nl30 <= 0;
      if (sig.type === 'A_UP'   && !longBias)  continue;
      if (sig.type === 'A_DOWN' && !shortBias) continue;
    }

    // C confirmation filter: only enter after C also confirms
    if (cConfirmedOnly && !cConf) continue;

    const outcome = calculateOutcome(bars, sig, or, holdStrategy);
    if (!outcome) continue;

    trades.push({
      date, orHigh: or.high, orLow: or.low, orRange: or.range,
      aUp, aDown, signalType: sig.type, signalTime: sig.time,
      entryPrice: sig.entryPrice, cConfirmed: cConf,
      dailyScore: score, numberLine30: nl30, numberLine10: nl.sum(10),
      ...outcome,
    });
  }
  return analyzeResults(trades);
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function runACDBacktest(csvPath, params, onProgress) {
  const sessions = await parseCSVToSessions(csvPath, params.startDate, params.endDate);
  return runBacktestOnSessions(sessions, params);
}

export async function runACDBacktestFromDB(params, onProgress) {
  const sessions = await loadSessionsFromDB(params.startDate, params.endDate);
  if (onProgress) onProgress({ done: 0, total: sessions.length, phase: 'loaded' });
  return runBacktestOnSessions(sessions, params);
}

export async function runParameterSearch(csvPath, onProgress, startDate = null) {
  const sessions = csvPath
    ? await parseCSVToSessions(csvPath, startDate)
    : await loadSessionsFromDB(startDate);

  const orOpts      = [5, 10, 15, 30, 60, 240];
  const multOpts    = [0.25, 0.30, 0.33, 0.40, 0.50];
  const sustOpts    = [2, 3, 5];
  const filterOpts  = [
    { nlAligned: false, cConfirmedOnly: false, orRangeMax: null },
    { nlAligned: true,  cConfirmedOnly: false, orRangeMax: null },
    { nlAligned: false, cConfirmedOnly: false, orRangeMax: 80 },
    { nlAligned: true,  cConfirmedOnly: false, orRangeMax: 80 },
  ];
  const total    = orOpts.length * multOpts.length * sustOpts.length * filterOpts.length;
  let done = 0;
  const all = [];

  for (const filters of filterOpts) {
    for (const orMinutes of orOpts) {
      for (const aMultiplier of multOpts) {
        for (const sustainMinutes of sustOpts) {
          const result = await runBacktestOnSessions(sessions, { orMinutes, aMultiplier, sustainMinutes, holdStrategy: 'session_close', ...filters });
          all.push({ params: { orMinutes, aMultiplier, sustainMinutes, ...filters }, ...result });
          done++;
          if (onProgress) onProgress({ done, total, phase: 'grid' });
        }
      }
    }
  }
  return all.sort((a, b) => b.evPerTrade - a.evPerTrade);
}
