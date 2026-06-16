// REPORT ONLY. Tests the "cushion = permission to press" hypothesis:
// after running intraday P&L crosses +$500 / +$800, does trade SIZE jump,
// do those up-money trades disproportionately turn green days red, and is
// the give-back typically one acute oversized trade vs a slow grind?
//
// Reconstruction mirrors computeNetTrades() in src/App.jsx (flat-to-flat
// sessions via EP markers, CumPL-diff correction for per-session P&L) but
// keys everything by account explicitly (this analysis is account-scoped,
// so cross-account collisions on the same day/symbol/direction must not merge).

import pg from 'pg';
const pool = new pg.Pool({ host: 'localhost', port: 5432, database: 'trading_journal', user: 'trader', password: 'trader123' });
const q = (t, p) => pool.query(t, p);

const isFunded = (acct) => /PRO\d|DIRECT\d/.test(acct || '');

// ── 1. Load raw fills ────────────────────────────────────────────────────────
const rowsQ = await q(`
  SELECT log_date::text, entry_time, exit_time, symbol, direction, quantity,
         entry_price::float, exit_price::float, pnl::float,
         custom_fields->>'account' as account,
         custom_fields->'sierra_data'->>'Exit DateTime' as exit_dt,
         custom_fields->'sierra_data'->>'FlatToFlat Profit/Loss (C)' as ftf,
         custom_fields->'sierra_data'->>'Cumulative Profit/Loss (C)' as cumpl,
         custom_fields->'sierra_data'->>'Max Open Quantity' as max_open_qty,
         custom_fields->'sierra_data'->>'sierra_row' as sierra_row_a,
         custom_fields->>'sierra_row' as sierra_row_b
  FROM trades
  WHERE entry_time IS NOT NULL AND exit_time IS NOT NULL AND custom_fields->>'account' IS NOT NULL
  ORDER BY entry_time
`);
// account column doesn't exist directly; fix: account is in custom_fields only
const rows = rowsQ.rows.map(r => ({
  ...r,
  sierra_row: r.sierra_row_a ?? r.sierra_row_b ?? 0,
}));

// ── 2. Dedup (account-aware) ────────────────────────────────────────────────
const seen = new Set();
const fills = rows.filter(r => {
  const key = `${r.account}|${r.entry_time}|${r.exit_time}|${r.symbol}|${r.direction}|${r.quantity}|${r.entry_price}|${r.exit_price}`;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});

// ── 3. Group into flat-to-flat net trades (account + log_date + symbol + direction) ──
const dayGroups = new Map();
for (const f of fills) {
  const key = `${f.account}|${f.log_date}|${f.symbol}|${f.direction}`;
  (dayGroups.get(key) ?? dayGroups.set(key, []).get(key)).push(f);
}

const netTrades = [];
for (const [, groupFills] of dayGroups) {
  groupFills.sort((a, b) => {
    const td = new Date(a.entry_time) - new Date(b.entry_time);
    if (td !== 0) return td;
    return (parseFloat(a.sierra_row) || 0) - (parseFloat(b.sierra_row) || 0);
  });

  const isEP = (f) => typeof f.exit_dt === 'string' && f.exit_dt.trimEnd().endsWith('EP');
  const sessionEndTimes = [...new Set(groupFills.filter(isEP).map(f => f.exit_time))].sort();
  const boundaries = sessionEndTimes.length > 0
    ? sessionEndTimes
    : [groupFills[groupFills.length - 1]?.exit_time].filter(Boolean);

  const sessions = new Map();
  for (const b of boundaries) sessions.set(b, []);
  for (const f of groupFills) {
    const boundary = boundaries.find(b => new Date(b) >= new Date(f.exit_time));
    const assignTo = boundary ?? boundaries[boundaries.length - 1];
    sessions.get(assignTo)?.push(f);
  }

  for (const sessionFills of sessions.values()) {
    if (!sessionFills.length) continue;
    let latestExitTime = null, earliestEntryTime = null;
    for (const f of sessionFills) {
      if (!latestExitTime || f.exit_time > latestExitTime) latestExitTime = f.exit_time;
      if (!earliestEntryTime || f.entry_time < earliestEntryTime) earliestEntryTime = f.entry_time;
    }
    const epFill = sessionFills.find(isEP);
    const ftfRaw = String(epFill?.ftf || '').trim().replace(/\s*F$/i, '');
    const totalPnl = ftfRaw !== '' ? parseFloat(ftfRaw) : sessionFills.reduce((s, f) => s + (f.pnl || 0), 0);
    const totalQty = sessionFills.reduce((mx, f) => Math.max(mx, parseFloat(f.max_open_qty) || 0), 0) || sessionFills[0]?.quantity || 0;

    netTrades.push({
      account: sessionFills[0].account,
      log_date: sessionFills[0].log_date,
      symbol: sessionFills[0].symbol,
      direction: sessionFills[0].direction,
      entry_time: earliestEntryTime,
      latestExitTime,
      totalQty,
      totalPnl,
      epFill,
    });
  }
}

// ── 4. CumPL-diff correction (per account, chronological) ───────────────────
const lastCumPLByAccount = new Map();
[...netTrades]
  .sort((a, b) => {
    if (a.account !== b.account) return a.account.localeCompare(b.account);
    return new Date(a.latestExitTime) - new Date(b.latestExitTime);
  })
  .forEach(session => {
    const epFill = session.epFill;
    if (!epFill) return;
    const cumPLStr = String(epFill.cumpl || '').trim();
    const thisCumPL = parseFloat(cumPLStr);
    if (isNaN(thisCumPL)) return;
    const prev = lastCumPLByAccount.get(session.account) ?? 0;
    session.totalPnl = thisCumPL - prev;
    lastCumPLByAccount.set(session.account, thisCumPL);
  });

// ── 5. Group into (account, log_date) trading sessions, chronological ──────
const sessionGroups = new Map();
for (const t of netTrades) {
  const key = `${t.account}|${t.log_date}`;
  (sessionGroups.get(key) ?? sessionGroups.set(key, []).get(key)).push(t);
}

const sessions = [];
for (const [key, trades] of sessionGroups) {
  const [account, log_date] = key.split('|');
  trades.sort((a, b) => new Date(a.latestExitTime) - new Date(b.latestExitTime));
  if (trades.length < 2) continue; // need at least 2 trades for "after being up" to mean anything

  // running P&L BEFORE each trade (cushion available when the trade was taken)
  let running = 0;
  let peak = 0;
  for (const t of trades) {
    t.runningBefore = running;
    running += t.totalPnl;
    t.runningAfter = running;
    peak = Math.max(peak, running);
  }
  sessions.push({ account, log_date, funded: isFunded(account), trades, finalPnl: running, peak });
}

console.log(`Total (account, day) sessions with >=2 net trades: ${sessions.length}`);

// Overall baseline size (all trades, all sessions)
const allSizes = sessions.flatMap(s => s.trades.map(t => t.totalQty));
const overallAvgSize = allSizes.reduce((a, b) => a + b, 0) / allSizes.length;
console.log(`Overall average trade size (all trades, all sessions): ${overallAvgSize.toFixed(2)} contracts (n=${allSizes.length})`);

// ════════════════════════════════════════════════════════════════════════════
function analyzeThreshold(THRESH) {
  console.log(`\n\n========== THRESHOLD: running peak >= +$${THRESH} ==========`);

  const upSessions = sessions.filter(s => s.peak >= THRESH);
  console.log(`Sessions reaching running peak >= +$${THRESH}: ${upSessions.length} of ${sessions.length}`);
  if (upSessions.length < 20) console.log(`  [LIMITED SAMPLE n<20]`);

  // ── 1. Size behavior: before vs after crossing threshold ──────────────────
  const beforeSizes = [];
  const afterSizes = [];
  const afterTrades = [];
  const beforeTrades = [];

  for (const s of upSessions) {
    for (const t of s.trades) {
      if (t.runningBefore >= THRESH) {
        afterSizes.push(t.totalQty);
        afterTrades.push({ ...t, session: s });
      } else {
        beforeSizes.push(t.totalQty);
        beforeTrades.push({ ...t, session: s });
      }
    }
  }

  const avg = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
  const beforeAvg = avg(beforeSizes);
  const afterAvg = avg(afterSizes);

  console.log(`\n--- STEP 1: Size before vs after crossing +$${THRESH} (within up-sessions) ---`);
  console.log(`  Before-crossing trades: n=${beforeSizes.length}, avg size=${beforeAvg?.toFixed(2) ?? 'n/a'}`);
  console.log(`  After-crossing trades:  n=${afterSizes.length}, avg size=${afterAvg?.toFixed(2) ?? 'n/a'}${afterSizes.length < 20 ? '  [LIMITED SAMPLE n<20]' : ''}`);
  if (beforeAvg && afterAvg) {
    console.log(`  Ratio (after/before): ${(afterAvg / beforeAvg).toFixed(2)}x`);
  }
  console.log(`  vs overall baseline (${overallAvgSize.toFixed(2)}): after/overall = ${afterAvg ? (afterAvg / overallAvgSize).toFixed(2) : 'n/a'}x`);

  // Oversized outliers: after-crossing trades >= 2x the SESSION's own before-crossing avg
  // (fallback to overall baseline if a session has zero before-crossing trades)
  const oversized = [];
  for (const s of upSessions) {
    const sessBefore = s.trades.filter(t => t.runningBefore < THRESH).map(t => t.totalQty);
    const sessBaseline = sessBefore.length ? avg(sessBefore) : overallAvgSize;
    for (const t of s.trades) {
      if (t.runningBefore >= THRESH && t.totalQty >= 2 * sessBaseline) {
        oversized.push({ ...t, session: s, sessBaseline });
      }
    }
  }
  console.log(`\n  Oversized after-up trades (>=2x that session's pre-cushion avg size): n=${oversized.length}`);
  for (const o of oversized.slice(0, 15)) {
    console.log(`    ${o.session.log_date} ${o.account.slice(-8)} size=${o.totalQty} (baseline=${o.sessBaseline.toFixed(1)}) pnl=$${o.totalPnl.toFixed(2)} runningBefore=$${o.runningBefore.toFixed(2)} runningAfter=$${o.runningAfter.toFixed(2)}`);
  }
  if (oversized.length > 15) console.log(`    ... and ${oversized.length - 15} more`);

  // ── 2. Outcome of up-money trades ──────────────────────────────────────────
  console.log(`\n--- STEP 2: Outcome of after-crossing (+$${THRESH}) trades ---`);
  const afterWins = afterTrades.filter(t => t.totalPnl > 0).length;
  const afterDecided = afterTrades.filter(t => t.totalPnl !== 0).length;
  const afterAvgPnl = avg(afterTrades.map(t => t.totalPnl));
  console.log(`  n=${afterTrades.length}, win rate=${afterDecided ? (afterWins / afterDecided * 100).toFixed(1) : 'n/a'}% (decided n=${afterDecided})${afterDecided < 20 ? '  [LIMITED SAMPLE n<20]' : ''}, avg P&L=$${afterAvgPnl?.toFixed(2) ?? 'n/a'}`);

  const endedGreen = upSessions.filter(s => s.finalPnl > 0).length;
  const endedRed = upSessions.filter(s => s.finalPnl <= 0).length;
  console.log(`\n  Of ${upSessions.length} sessions that reached +$${THRESH}+ at peak:`);
  console.log(`    Ended GREEN (final P&L > 0): ${endedGreen} (${(endedGreen / upSessions.length * 100).toFixed(1)}%)`);
  console.log(`    Ended RED/flat (final P&L <= 0): ${endedRed} (${(endedRed / upSessions.length * 100).toFixed(1)}%)`);

  // Of the red sessions, was there an oversized after-up trade?
  const redSessions = upSessions.filter(s => s.finalPnl <= 0);
  let redWithOversized = 0;
  console.log(`\n  Of ${redSessions.length} sessions that hit +$${THRESH}+ but ended <= 0:`);
  for (const s of redSessions) {
    const sessBefore = s.trades.filter(t => t.runningBefore < THRESH).map(t => t.totalQty);
    const sessBaseline = sessBefore.length ? avg(sessBefore) : overallAvgSize;
    const afterUp = s.trades.filter(t => t.runningBefore >= THRESH);
    const oversizedInSession = afterUp.filter(t => t.totalQty >= 2 * sessBaseline);
    const hasOversized = oversizedInSession.length > 0;
    if (hasOversized) redWithOversized++;
    const giveback = s.peak - s.finalPnl;
    console.log(`    ${s.log_date} ${s.account.slice(-8)}: peak=$${s.peak.toFixed(2)} final=$${s.finalPnl.toFixed(2)} giveback=$${giveback.toFixed(2)} oversizedAfterUp=${hasOversized ? oversizedInSession.map(t=>`size${t.totalQty}(pnl$${t.totalPnl.toFixed(0)})`).join(',') : 'no'}`);
  }
  console.log(`\n  ${redWithOversized} of ${redSessions.length} red sessions had an oversized (>=2x baseline) trade after crossing +$${THRESH}${redSessions.length < 20 ? '  [LIMITED SAMPLE n<20]' : ''}`);

  // ── 3. Give-back shape ────────────────────────────────────────────────────
  console.log(`\n--- STEP 3: Give-back shape (sessions ending below peak) ---`);
  const givebackSessions = upSessions.filter(s => s.finalPnl < s.peak);
  let acuteCount = 0, grindCount = 0;
  for (const s of givebackSessions) {
    const giveback = s.peak - s.finalPnl;
    if (giveback <= 0) continue;
    // trades after the peak was reached
    const peakIdx = s.trades.findIndex(t => t.runningAfter === s.peak);
    const afterPeakTrades = s.trades.slice(peakIdx + 1);
    const losses = afterPeakTrades.map(t => -t.totalPnl).filter(x => x > 0); // positive = loss magnitude
    const maxSingleLoss = losses.length ? Math.max(...losses) : 0;
    const isAcute = maxSingleLoss >= 0.5 * giveback;
    if (isAcute) acuteCount++; else grindCount++;
  }
  console.log(`  Sessions with giveback > 0: ${givebackSessions.length}`);
  console.log(`    ACUTE (single trade >=50% of giveback): ${acuteCount}${givebackSessions.length < 20 ? '  [LIMITED SAMPLE n<20]' : ''}`);
  console.log(`    SLOW GRIND (no single dominant trade): ${grindCount}${givebackSessions.length < 20 ? '  [LIMITED SAMPLE n<20]' : ''}`);

  return { upSessions, afterTrades, beforeAvg, afterAvg };
}

const r500 = analyzeThreshold(500);
const r800 = analyzeThreshold(800);

// ── 4. Size vs cushion correlation (across ALL sessions, not just up-sessions) ──
console.log(`\n\n========== STEP 4: SIZE vs RUNNING-P&L-AT-TIME-OF-TRADE (all sessions) ==========`);
const pairs = [];
for (const s of sessions) {
  for (const t of s.trades) pairs.push({ running: t.runningBefore, size: t.totalQty });
}
const n = pairs.length;
const meanRunning = pairs.reduce((a, p) => a + p.running, 0) / n;
const meanSize = pairs.reduce((a, p) => a + p.size, 0) / n;
let cov = 0, varRunning = 0, varSize = 0;
for (const p of pairs) {
  cov += (p.running - meanRunning) * (p.size - meanSize);
  varRunning += (p.running - meanRunning) ** 2;
  varSize += (p.size - meanSize) ** 2;
}
const corr = cov / Math.sqrt(varRunning * varSize);
console.log(`  n=${n}, Pearson correlation(runningP&L-before-trade, size) = ${corr.toFixed(4)}`);

// Bucket by cushion range
const buckets = [
  { label: '< -$500', test: p => p.running < -500 },
  { label: '-$500 to $0', test: p => p.running >= -500 && p.running < 0 },
  { label: '$0 to +$500', test: p => p.running >= 0 && p.running < 500 },
  { label: '+$500 to +$800', test: p => p.running >= 500 && p.running < 800 },
  { label: '+$800 to +$1500', test: p => p.running >= 800 && p.running < 1500 },
  { label: '>= +$1500', test: p => p.running >= 1500 },
];
for (const b of buckets) {
  const subset = pairs.filter(b.test);
  const avgSize = subset.length ? subset.reduce((a, p) => a + p.size, 0) / subset.length : null;
  console.log(`  ${b.label.padEnd(18)} n=${String(subset.length).padEnd(5)} avg size=${avgSize?.toFixed(2) ?? 'n/a'}${subset.length < 20 ? '  [LIMITED SAMPLE n<20]' : ''}`);
}

// ── 5. Account type split (FUNDED vs SIM) for the +$500 and +$800 thresholds ──
console.log(`\n\n========== STEP 5: FUNDED vs SIM account split ==========`);
for (const THRESH of [500, 800]) {
  console.log(`\n--- Threshold +$${THRESH} ---`);
  for (const fundedFlag of [true, false]) {
    const label = fundedFlag ? 'FUNDED/LIVE (PRO*/DIRECT*)' : 'SIM/EVAL (TEST*/other)';
    const subset = sessions.filter(s => s.funded === fundedFlag && s.peak >= THRESH);
    if (!subset.length) { console.log(`  ${label}: 0 sessions reached +$${THRESH}`); continue; }
    const green = subset.filter(s => s.finalPnl > 0).length;
    const red = subset.filter(s => s.finalPnl <= 0).length;

    // oversized after-up rate
    let withOversized = 0;
    for (const s of subset) {
      const sessBefore = s.trades.filter(t => t.runningBefore < THRESH).map(t => t.totalQty);
      const sessBaseline = sessBefore.length ? avg2(sessBefore) : overallAvgSize;
      const afterUp = s.trades.filter(t => t.runningBefore >= THRESH);
      if (afterUp.some(t => t.totalQty >= 2 * sessBaseline)) withOversized++;
    }

    console.log(`  ${label}: n=${subset.length}${subset.length < 20 ? ' [LIMITED SAMPLE n<20]' : ''}  green=${green} (${(green/subset.length*100).toFixed(1)}%)  red=${red} (${(red/subset.length*100).toFixed(1)}%)  sessionsWithOversizedAfterUp=${withOversized} (${(withOversized/subset.length*100).toFixed(1)}%)`);
  }
}
function avg2(arr) { return arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0; }

await pool.end();
