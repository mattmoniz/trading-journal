/**
 * acceptance_engine_backtest.js
 *
 * REPORT ONLY — no writes, no live logic changes.
 *
 * Tests whether an intraday "developing value / acceptance" read (Market
 * Profile style: developing POC/VA migration, acceptance vs rejection,
 * profile shape, opening context, overnight inventory) predicts the day's
 * outcome, and from what checkpoint it's reliable. Also tests whether it
 * adds information beyond the existing range-expansion reassessment engine
 * and vol-regime signal, and whether confluence improves accuracy.
 *
 * PROFILE METHOD (consistent throughout, OHLC-DERIVED APPROXIMATION):
 * tearsheet.js-style — each 1-min bar's volume is spread evenly across its
 * high-low tick range (0.25 NQ ticks) into a volume-at-price histogram.
 * POC = price with max accumulated volume. VA = smallest contiguous range
 * around POC covering >=70% of total volume (expand toward larger side).
 * This is NOT a tick-true profile — flagged honestly in the final report.
 */

import { query } from '../server/db.js';
import { classifyOpeningType, classifyDayType } from '../server/services/caseEngine.js';
import { runReassessment } from '../server/services/dayTypeReassessmentService.js';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

const RTH_START = 570; // 9:30 ET
const RTH_END   = 960; // 16:00 ET
const IB_END    = 630; // 10:30 ET
const TICK = 0.25;
const round = p => Math.round(p / TICK) * TICK;

const CHECKPOINTS = [600, 630, 660, 690, 720, 780, 840, 900]; // 10:00..15:00 ET
const REASSESS_CHECKPOINTS = CHECKPOINTS.filter(t => t >= 660);
const fmtT = m => `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;

// ── Profile computation (tearsheet.js-style spread-volume approximation) ───
function computeProfile(bars) {
  if (!bars.length) return null;
  const volMap = {};
  for (const b of bars) {
    const h = b.high, l = b.low, v = b.volume;
    if (!(h >= l)) continue;
    const levels = Math.max(1, Math.round((h - l) / TICK) + 1);
    const vpl = v / levels;
    for (let p = l; p <= h + TICK / 2; p += TICK) {
      const lvl = round(p);
      volMap[lvl] = (volMap[lvl] || 0) + vpl;
    }
  }
  const entries = Object.entries(volMap).map(([p, v]) => ({ price: parseFloat(p), volume: v })).sort((a,b)=>a.price-b.price);
  if (entries.length < 3) return null;
  const totalVol = entries.reduce((s,l)=>s+l.volume,0);
  const maxVol = Math.max(...entries.map(l=>l.volume));
  const pocIdx = entries.findIndex(l => l.volume === maxVol);
  let vaVol = entries[pocIdx].volume;
  let upI = pocIdx + 1, dnI = pocIdx - 1;
  while (vaVol < totalVol * 0.70 && (upI < entries.length || dnI >= 0)) {
    const upAdd = upI < entries.length ? entries[upI].volume : 0;
    const dnAdd = dnI >= 0 ? entries[dnI].volume : 0;
    if (upAdd >= dnAdd && upI < entries.length) { vaVol += upAdd; upI++; }
    else if (dnI >= 0) { vaVol += dnAdd; dnI--; }
    else { vaVol += upAdd; upI++; }
  }
  const vah = entries[upI-1]?.price ?? entries[pocIdx].price;
  const val = entries[dnI+1]?.price ?? entries[pocIdx].price;
  return { poc: entries[pocIdx].price, vah, val, maxVol, totalVol, entries };
}

function stdevLogReturns(closes) {
  if (closes.length < 3) return null;
  const rets = [];
  for (let i=1;i<closes.length;i++){ const c0=closes[i-1],c1=closes[i]; if(c0>0&&c1>0) rets.push(Math.log(c1/c0)); }
  if (rets.length < 2) return null;
  const mean = rets.reduce((s,x)=>s+x,0)/rets.length;
  const variance = rets.reduce((s,x)=>s+(x-mean)**2,0)/(rets.length-1);
  return Math.sqrt(variance);
}
function fiveMinCloses(bars) {
  const buckets = {};
  for (const b of bars) buckets[Math.floor(b.et_min/5)*5] = b.close;
  return Object.keys(buckets).sort((a,b)=>a-b).map(k=>buckets[k]);
}

async function main() {
  console.log('[acceptance_engine_backtest] REPORT ONLY — no writes, no live logic changed.\n');
  console.log('All VAH/VAL/POC values are OHLC-derived approximations (volume spread across each');
  console.log('bar\'s high-low tick range), not tick-true Market Profile. Same method throughout.\n');

  // ── Session universe (same as prior backtests) ──────────────────────────
  const sessQ = await query(`
    WITH sessions AS (
      SELECT ts::date AS trade_date,
        (array_agg(open ORDER BY ts))[1]::float AS sess_open,
        (array_agg(close ORDER BY ts))[1]::float AS sess_open_close,
        MAX(high)::float AS sess_high, MIN(low)::float AS sess_low, COUNT(*) AS bars
      FROM price_bars
      WHERE symbol='NQ' AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN ${RTH_START} AND ${RTH_END-1}
        AND ts::date < CURRENT_DATE
      GROUP BY ts::date HAVING COUNT(*) >= 200
    ), with_avg AS (
      SELECT *, AVG(sess_high - sess_low) OVER (ORDER BY trade_date ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING) AS avg_range_20
      FROM sessions
    )
    SELECT trade_date::text, sess_open, sess_high, sess_low, avg_range_20
    FROM with_avg WHERE avg_range_20 IS NOT NULL ORDER BY trade_date
  `);

  const truthQ = await query(`
    SELECT trade_date::text, day_type, (or_high - or_low)::float as or_width,
      COALESCE((SELECT SUM(a2.daily_score) FROM acd_daily_log a2
        WHERE a2.trade_date >= a.trade_date - INTERVAL '30 days' AND a2.trade_date < a.trade_date AND a2.daily_score IS NOT NULL), 0)::int AS nl30
    FROM acd_daily_log a WHERE day_type IS NOT NULL
  `);
  const truthByDate = {};
  for (const r of truthQ.rows) truthByDate[r.trade_date] = r;

  const sessions = sessQ.rows.filter(s => truthByDate[s.trade_date] && truthByDate[s.trade_date].or_width != null);
  console.log(`Session universe: ${sessions.length}\n`);

  // ── Bulk fetch full-day (0:00-23:59) bars for all needed dates + 1 day prior ──
  const allDates = sessions.map(s => s.trade_date);
  const barsQ = await query(`
    SELECT ts::date::text AS d, ts, open::float, high::float, low::float, close::float, volume::float,
      (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts))::int AS et_min
    FROM price_bars
    WHERE symbol='NQ' AND (ts::date = ANY($1::date[]) OR (ts::date + INTERVAL '1 day')::date = ANY($1::date[]))
    ORDER BY ts
  `, [allDates]);
  const barsByDate = {};
  for (const b of barsQ.rows) (barsByDate[b.d] ??= []).push(b);

  // ── Per-session reconstruction ──────────────────────────────────────────
  const sessionResults = [];
  let skipped = 0;
  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    const truth = truthByDate[s.trade_date];
    const dayBars = (barsByDate[s.trade_date] || []).slice().sort((a,b)=>a.et_min-b.et_min);
    const rthBars = dayBars.filter(b => b.et_min >= RTH_START && b.et_min < RTH_END);
    if (rthBars.length < 200) { skipped++; continue; }

    // Prior trading day = previous session in the sorted list (handles weekends/holidays)
    const prior = sessions[i-1];
    if (!prior) { skipped++; continue; }
    const priorDayBars = (barsByDate[prior.trade_date] || []).filter(b => b.et_min >= RTH_START && b.et_min < RTH_END).sort((a,b)=>a.et_min-b.et_min);
    const pdProfile = computeProfile(priorDayBars);
    if (!pdProfile) { skipped++; continue; }

    // Overnight bars: prior date hour>=18, plus current date pre-RTH (et_min < 570)
    const priorFullDay = (barsByDate[prior.trade_date] || []);
    const onBars = [
      ...priorFullDay.filter(b => b.et_min >= 18*60),
      ...dayBars.filter(b => b.et_min < RTH_START),
    ].sort((a,b)=> a.ts < b.ts ? -1 : 1);

    const sessOpen = rthBars[0].open;
    const sessClose = rthBars[rthBars.length-1].close;
    const sessHigh = Math.max(...rthBars.map(b=>b.high));
    const sessLow  = Math.min(...rthBars.map(b=>b.low));
    const actualCloseDir = sessClose > sessOpen ? 'UP' : 'DOWN';
    const dayType = truth.day_type;

    const ibBars = rthBars.filter(b => b.et_min < IB_END);
    const ibHigh = ibBars.length ? Math.max(...ibBars.map(b=>b.high)) : null;
    const ibLow  = ibBars.length ? Math.min(...ibBars.map(b=>b.low)) : null;

    // Opening context vs prior-day VA
    let openContext = 'INSIDE';
    if (sessOpen > pdProfile.vah) openContext = 'ABOVE';
    else if (sessOpen < pdProfile.val) openContext = 'BELOW';

    // Overnight inventory vs prior-day VA
    let onContext = 'NONE';
    if (onBars.length >= 5) {
      const onHigh = Math.max(...onBars.map(b=>b.high));
      const onLow  = Math.min(...onBars.map(b=>b.low));
      if (onLow >= pdProfile.val && onHigh <= pdProfile.vah) onContext = 'INSIDE';
      else if (onLow > pdProfile.vah) onContext = 'ABOVE';
      else if (onHigh < pdProfile.val) onContext = 'BELOW';
      else onContext = 'STRADDLING';
    }

    // Static initial day-type read (10:05) for reassessment engine
    const first5 = rthBars.filter(b => b.et_min < RTH_START+5);
    const openingType = first5.length >= 5 ? classifyOpeningType(first5) : 'FORMING';
    const staticRead = classifyDayType({ openingType, nl30: truth.nl30, orWidth: truth.or_width, asOfMinutes: 605 }).classification;
    const reassess = runReassessment({
      initialRead: staticRead, bars: rthBars, sessOpen, avgRange20: s.avg_range_20,
      ibHigh, ibLow, checkpoints: REASSESS_CHECKPOINTS,
    });

    // ── Per-checkpoint developing-profile metrics ─────────────────────────
    const checkpointData = {};
    let prevProfile = null, prevVA = null;
    for (const T of CHECKPOINTS) {
      const upTo = rthBars.filter(b => b.et_min <= T);
      if (upTo.length < 10) { checkpointData[T] = null; continue; }
      const profile = computeProfile(upTo);
      if (!profile) { checkpointData[T] = null; continue; }

      const currentHigh = Math.max(...upTo.map(b=>b.high));
      const currentLow  = Math.min(...upTo.map(b=>b.low));
      const currentClose = upTo[upTo.length-1].close;
      const partialRange = currentHigh - currentLow;

      // 2. Migration vs prior checkpoint
      let migrationDir = 'FIRST';
      let pocDelta = null, vaOverlapPct = null;
      const migThresh = 0.05 * s.avg_range_20;
      if (prevProfile) {
        pocDelta = profile.poc - prevProfile.poc;
        migrationDir = Math.abs(pocDelta) < migThresh ? 'HOLDING' : (pocDelta > 0 ? 'HIGHER' : 'LOWER');
        const overlapLo = Math.max(profile.val, prevVA.val);
        const overlapHi = Math.min(profile.vah, prevVA.vah);
        const overlap = Math.max(0, overlapHi - overlapLo);
        const unionWidth = Math.max(profile.vah, prevVA.vah) - Math.min(profile.val, prevVA.val);
        vaOverlapPct = unionWidth > 0 ? overlap / unionWidth : 1;
      }

      // 2b. Migration vs yesterday's VA
      let vsYesterday;
      if (profile.poc > pdProfile.vah) vsYesterday = 'HIGHER';
      else if (profile.poc < pdProfile.val) vsYesterday = 'LOWER';
      else vsYesterday = 'INSIDE';

      // 3. Acceptance vs rejection (only meaningful if migrating vs prior checkpoint)
      let acceptance = 'N/A';
      if (migrationDir === 'HIGHER') acceptance = currentClose > prevVA.vah ? 'ACCEPTED' : 'REJECTED';
      else if (migrationDir === 'LOWER') acceptance = currentClose < prevVA.val ? 'ACCEPTED' : 'REJECTED';

      // 4. Profile shape: VA-width / total-range-so-far
      const vaWidth = profile.vah - profile.val;
      const shapeRatio = partialRange > 0 ? vaWidth / partialRange : null;
      const shape = shapeRatio == null ? null : (shapeRatio >= 0.6 ? 'FATTENING' : 'ELONGATING');

      checkpointData[T] = {
        poc: profile.poc, vah: profile.vah, val: profile.val,
        migrationDir, pocDelta, vaOverlapPct, vsYesterday, acceptance,
        shapeRatio, shape,
      };
      prevProfile = profile; prevVA = profile;
    }

    sessionResults.push({
      date: s.trade_date, dayType, actualCloseDir, openContext, onContext,
      staticRead, reassessFinal: reassess.finalRead, readAtCheckpoint: reassess.readAtCheckpoint,
      checkpointData, avgRange20: s.avg_range_20,
      rthBars,
    });
  }
  console.log(`Scored: ${sessionResults.length}   Skipped: ${skipped}\n`);

  const total = sessionResults.length;

  // ════════════════════════════════════════════════════════════════════════
  // PART 1: Methodology summary (counts of opening/overnight contexts)
  // ════════════════════════════════════════════════════════════════════════
  console.log('═'.repeat(78));
  console.log('PART 1 — METHODOLOGY CHECK: opening / overnight context distribution');
  console.log('═'.repeat(78));
  const ctxCounts = {};
  for (const r of sessionResults) ctxCounts[r.openContext] = (ctxCounts[r.openContext]||0)+1;
  console.log('Opening context (open vs prior-day developing VA):', JSON.stringify(ctxCounts));
  const onCounts = {};
  for (const r of sessionResults) onCounts[r.onContext] = (onCounts[r.onContext]||0)+1;
  console.log('Overnight inventory vs prior-day VA:', JSON.stringify(onCounts));
  console.log('');

  // ════════════════════════════════════════════════════════════════════════
  // PART 2.6 — Acceptance direction (POC migration vs prior checkpoint) vs
  // actual close direction
  // ════════════════════════════════════════════════════════════════════════
  console.log('═'.repeat(78));
  console.log('PART 2.6 — ACCEPTANCE DIRECTION (POC migration vs prior checkpoint) vs ACTUAL CLOSE DIRECTION');
  console.log('═'.repeat(78));
  console.log('  Time   |   N(dir) | match% (dir->close) | N(HOLDING) | HOLDING %');
  console.log('  -------+----------+----------------------+------------+-----------');
  for (const T of CHECKPOINTS) {
    let nDir=0, nMatch=0, nHold=0, nTotal=0;
    for (const r of sessionResults) {
      const cd = r.checkpointData[T];
      if (!cd || cd.migrationDir === 'FIRST') continue;
      nTotal++;
      if (cd.migrationDir === 'HOLDING') { nHold++; continue; }
      nDir++;
      const predicted = cd.migrationDir === 'HIGHER' ? 'UP' : 'DOWN';
      if (predicted === r.actualCloseDir) nMatch++;
    }
    const matchPct = nDir ? (nMatch/nDir*100) : null;
    const holdPct = nTotal ? (nHold/nTotal*100) : null;
    console.log(`  ${fmtT(T)}  | ${String(nDir).padStart(8)} | ${(matchPct==null?'  n/a   ':matchPct.toFixed(1).padStart(6)+'%')}${nDir<20?' (N<20)':'       '} | ${String(nHold).padStart(10)} | ${holdPct==null?'n/a':holdPct.toFixed(1)+'%'}`);
  }
  console.log('');

  // ════════════════════════════════════════════════════════════════════════
  // PART 2.6b — Acceptance direction vs ground-truth day_type
  // ════════════════════════════════════════════════════════════════════════
  console.log('  ACCEPTANCE "migrating" (non-HOLDING) vs ground-truth day_type != BALANCE:');
  console.log('  Time   |  N(migrating) | match% (migrating -> non-BALANCE) | N(holding) | match% (holding -> BALANCE)');
  console.log('  -------+---------------+-------------------------------------+------------+------------------------------');
  for (const T of CHECKPOINTS) {
    let nMig=0, nMigMatch=0, nHold=0, nHoldMatch=0;
    for (const r of sessionResults) {
      const cd = r.checkpointData[T];
      if (!cd || cd.migrationDir === 'FIRST') continue;
      const nonBalance = r.dayType !== 'BALANCE';
      if (cd.migrationDir === 'HOLDING') { nHold++; if (!nonBalance) nHoldMatch++; }
      else { nMig++; if (nonBalance) nMigMatch++; }
    }
    const migPct = nMig ? (nMigMatch/nMig*100) : null;
    const holdPct = nHold ? (nHoldMatch/nHold*100) : null;
    console.log(`  ${fmtT(T)}  | ${String(nMig).padStart(13)} | ${(migPct==null?'n/a':migPct.toFixed(1)+'%').padStart(8)}${nMig<20?' (N<20)':'        '}                     | ${String(nHold).padStart(10)} | ${(holdPct==null?'n/a':holdPct.toFixed(1)+'%').padStart(8)}${nHold<20?' (N<20)':''}`);
  }
  console.log('');

  // ════════════════════════════════════════════════════════════════════════
  // PART 2.3 — Acceptance vs Rejection: does ACCEPTED migration predict the
  // close-direction match better than REJECTED migration?
  // ════════════════════════════════════════════════════════════════════════
  console.log('═'.repeat(78));
  console.log('PART 2.3 — ACCEPTED vs REJECTED migration -> close-direction match rate');
  console.log('═'.repeat(78));
  console.log('  Time   | N(ACCEPTED) | close-dir match% | N(REJECTED) | close-dir match%');
  console.log('  -------+-------------+-------------------+-------------+-------------------');
  for (const T of CHECKPOINTS) {
    let accN=0,accMatch=0,rejN=0,rejMatch=0;
    for (const r of sessionResults) {
      const cd = r.checkpointData[T];
      if (!cd || cd.acceptance === 'N/A') continue;
      const predicted = cd.migrationDir === 'HIGHER' ? 'UP' : 'DOWN';
      const isMatch = predicted === r.actualCloseDir;
      if (cd.acceptance === 'ACCEPTED') { accN++; if (isMatch) accMatch++; }
      else { rejN++; if (isMatch) rejMatch++; }
    }
    const accPct = accN ? (accMatch/accN*100) : null;
    const rejPct = rejN ? (rejMatch/rejN*100) : null;
    console.log(`  ${fmtT(T)}  | ${String(accN).padStart(11)} | ${(accPct==null?'n/a':accPct.toFixed(1)+'%').padStart(9)}${accN<20?' (N<20)':'       '} | ${String(rejN).padStart(11)} | ${(rejPct==null?'n/a':rejPct.toFixed(1)+'%').padStart(9)}${rejN<20?' (N<20)':''}`);
  }
  console.log('');

  // ════════════════════════════════════════════════════════════════════════
  // PART 2.7 — Profile shape (FATTENING vs ELONGATING) vs day_type
  // ════════════════════════════════════════════════════════════════════════
  console.log('═'.repeat(78));
  console.log('PART 2.7 — PROFILE SHAPE (VA-width / range-so-far) vs ground-truth day_type');
  console.log('  ELONGATING (ratio<0.6) predicts TREND/TURBULENT; FATTENING (>=0.6) predicts BALANCE');
  console.log('═'.repeat(78));
  console.log('  Time   | N(ELONG) | match% (->non-BAL) | N(FATTEN) | match% (->BAL) | avg ratio');
  console.log('  -------+----------+--------------------+-----------+----------------+----------');
  for (const T of CHECKPOINTS) {
    let elN=0,elMatch=0,faN=0,faMatch=0,ratioSum=0,ratioN=0;
    for (const r of sessionResults) {
      const cd = r.checkpointData[T];
      if (!cd || cd.shape == null) continue;
      const nonBalance = r.dayType !== 'BALANCE';
      ratioSum += cd.shapeRatio; ratioN++;
      if (cd.shape === 'ELONGATING') { elN++; if (nonBalance) elMatch++; }
      else { faN++; if (!nonBalance) faMatch++; }
    }
    const elPct = elN ? (elMatch/elN*100) : null;
    const faPct = faN ? (faMatch/faN*100) : null;
    const avgRatio = ratioN ? (ratioSum/ratioN) : null;
    console.log(`  ${fmtT(T)}  | ${String(elN).padStart(8)} | ${(elPct==null?'n/a':elPct.toFixed(1)+'%').padStart(7)}${elN<20?' (N<20)':'        '} | ${String(faN).padStart(9)} | ${(faPct==null?'n/a':faPct.toFixed(1)+'%').padStart(7)}${faN<20?' (N<20)':'        '} | ${avgRatio==null?'n/a':avgRatio.toFixed(2)}`);
  }
  console.log('');

  // ════════════════════════════════════════════════════════════════════════
  // PART 2.2b — Acceptance direction vs YESTERDAY's VA, vs day_type
  // ════════════════════════════════════════════════════════════════════════
  console.log('═'.repeat(78));
  console.log('PART 2.2b — Developing POC position vs YESTERDAY\'S VA (HIGHER/LOWER/INSIDE) vs day_type');
  console.log('═'.repeat(78));
  console.log('  Time   | HIGHER(N, %nonBAL) | LOWER(N, %nonBAL) | INSIDE(N, %BAL)');
  console.log('  -------+--------------------+--------------------+-----------------');
  for (const T of CHECKPOINTS) {
    const groups = { HIGHER: [0,0], LOWER: [0,0], INSIDE: [0,0] };
    for (const r of sessionResults) {
      const cd = r.checkpointData[T];
      if (!cd) continue;
      const g = groups[cd.vsYesterday];
      g[0]++;
      if (cd.vsYesterday === 'INSIDE') { if (r.dayType === 'BALANCE') g[1]++; }
      else { if (r.dayType !== 'BALANCE') g[1]++; }
    }
    const fmt = (g) => `${g[0]} (${g[0]?(g[1]/g[0]*100).toFixed(1):'n/a'}%)${g[0]<20?'*':' '}`;
    console.log(`  ${fmtT(T)}  | ${fmt(groups.HIGHER).padEnd(18)} | ${fmt(groups.LOWER).padEnd(18)} | ${fmt(groups.INSIDE)}`);
  }
  console.log('  (* = N<20, thin)\n');

  // ════════════════════════════════════════════════════════════════════════
  // PART 2.8 — Opening context (vs prior-day VA) vs day_type, and overnight
  // ════════════════════════════════════════════════════════════════════════
  console.log('═'.repeat(78));
  console.log('PART 2.8 — OPENING CONTEXT (open vs prior-day VA) -> day_type (Dalton hypothesis: inside=balance, outside=trend)');
  console.log('═'.repeat(78));
  for (const ctx of ['INSIDE','ABOVE','BELOW']) {
    const subset = sessionResults.filter(r => r.openContext === ctx);
    const n = subset.length;
    if (n === 0) continue;
    const predBalance = ctx === 'INSIDE';
    const matchN = subset.filter(r => (r.dayType === 'BALANCE') === predBalance).length;
    const dtCounts = {};
    for (const r of subset) dtCounts[r.dayType] = (dtCounts[r.dayType]||0)+1;
    console.log(`  ${ctx.padEnd(7)} N=${n}${n<20?' (N<20)':'      '}  predicts ${predBalance?'BALANCE':'non-BALANCE'} -> match ${(matchN/n*100).toFixed(1)}%   breakdown=${JSON.stringify(dtCounts)}`);
  }
  console.log('');
  console.log('  OVERNIGHT INVENTORY (vs prior-day VA) -> day_type:');
  for (const ctx of ['INSIDE','ABOVE','BELOW','STRADDLING']) {
    const subset = sessionResults.filter(r => r.onContext === ctx);
    const n = subset.length;
    if (n === 0) continue;
    const predBalance = ctx === 'INSIDE';
    const matchN = subset.filter(r => (r.dayType === 'BALANCE') === predBalance).length;
    const dtCounts = {};
    for (const r of subset) dtCounts[r.dayType] = (dtCounts[r.dayType]||0)+1;
    console.log(`  ${ctx.padEnd(11)} N=${n}${n<20?' (N<20)':'      '}  predicts ${predBalance?'BALANCE':'non-BALANCE'} -> match ${(matchN/n*100).toFixed(1)}%   breakdown=${JSON.stringify(dtCounts)}`);
  }
  console.log('');

  // ════════════════════════════════════════════════════════════════════════
  // PART 3.10/11 — Cross-tab acceptance vs reassessment-engine vs vol-regime,
  // confluence test
  // ════════════════════════════════════════════════════════════════════════
  console.log('═'.repeat(78));
  console.log('PART 3 — ACCEPTANCE vs REASSESSMENT-ENGINE vs VOL-REGIME: independence + confluence');
  console.log('  Each signal predicts "non-BALANCE" (TREND or TURBULENT). Ground truth = day_type.');
  console.log('═'.repeat(78));
  console.log('  Time   | sigA(accept) acc% N | sigB(reassess) acc% N | sigC(volJump) acc% N | 0sig acc% N | 1sig acc% N | 2-3sig acc% N');
  console.log('  -------+---------------------+-----------------------+----------------------+-------------+-------------+----------------');
  for (const T of REASSESS_CHECKPOINTS) {
    let a={n:0,c:0}, b={n:0,c:0}, cc={n:0,c:0};
    const conf = { 0:{n:0,c:0}, 1:{n:0,c:0}, 2:{n:0,c:0} };
    for (const r of sessionResults) {
      const cd = r.checkpointData[T];
      if (!cd) continue;
      const nonBalance = r.dayType !== 'BALANCE';
      const sigA = cd.migrationDir !== 'HOLDING' && cd.migrationDir !== 'FIRST'; // acceptance migrating
      const sigB = r.readAtCheckpoint[T] != null && r.readAtCheckpoint[T] !== 'BALANCE'; // reassessment

      // vol jump: post-IB vs pre-IB 5-min stdev ratio >= 1.5
      const upTo = r.rthBars.filter(x=>x.et_min<=T);
      const preBars = upTo.filter(x=>x.et_min<=IB_END);
      const postBars = upTo.filter(x=>x.et_min>IB_END);
      const preVol = stdevLogReturns(fiveMinCloses(preBars));
      const postVol = stdevLogReturns(fiveMinCloses(postBars));
      const sigC = (preVol!=null && postVol!=null && preVol>0) ? (postVol/preVol >= 1.5) : false;

      a.n++; if (sigA===nonBalance) a.c++;
      b.n++; if (sigB===nonBalance) b.c++;
      cc.n++; if (sigC===nonBalance) cc.c++;

      const agreeCount = [sigA,sigB,sigC].filter(Boolean).length;
      const bucket = agreeCount === 0 ? 0 : (agreeCount === 1 ? 1 : 2);
      conf[bucket].n++; if ((bucket>=1) === nonBalance || (bucket===0 && !nonBalance)) {
        // predicted non-balance iff bucket>=1; correct if matches nonBalance
      }
      const predicted = bucket >= 1;
      if (predicted === nonBalance) conf[bucket].c++;
    }
    const pct = x => x.n ? (x.c/x.n*100).toFixed(1)+`% N=${x.n}` : 'n/a';
    console.log(`  ${fmtT(T)}  | ${pct(a).padEnd(19)} | ${pct(b).padEnd(21)} | ${pct(cc).padEnd(20)} | ${pct(conf[0]).padEnd(11)} | ${pct(conf[1]).padEnd(11)} | ${pct(conf[2])}`);
  }
  console.log('');

  // Overlap matrix at 13:00 (mid-session) — does sigA agree with sigB?
  const T13 = 780;
  let both=0, aOnly=0, bOnly=0, neither=0;
  let bothCorrect=0, aOnlyCorrect=0, bOnlyCorrect=0, neitherCorrect=0;
  for (const r of sessionResults) {
    const cd = r.checkpointData[T13];
    if (!cd) continue;
    const nonBalance = r.dayType !== 'BALANCE';
    const sigA = cd.migrationDir !== 'HOLDING' && cd.migrationDir !== 'FIRST';
    const sigB = r.readAtCheckpoint[T13] != null && r.readAtCheckpoint[T13] !== 'BALANCE';
    if (sigA && sigB) { both++; if (nonBalance) bothCorrect++; }
    else if (sigA && !sigB) { aOnly++; if (nonBalance) aOnlyCorrect++; }
    else if (!sigA && sigB) { bOnly++; if (nonBalance) bOnlyCorrect++; }
    else { neither++; if (!nonBalance) neitherCorrect++; }
  }
  console.log(`  At 13:00 ET — overlap between sigA (acceptance migrating) and sigB (reassessment non-BALANCE):`);
  console.log(`    Both fire:        N=${both}  (${both?(bothCorrect/both*100).toFixed(1):'n/a'}% correctly predict non-BALANCE)`);
  console.log(`    sigA only:        N=${aOnly}  (${aOnly?(aOnlyCorrect/aOnly*100).toFixed(1):'n/a'}% correctly predict non-BALANCE)`);
  console.log(`    sigB only:        N=${bOnly}  (${bOnly?(bOnlyCorrect/bOnly*100).toFixed(1):'n/a'}% correctly predict non-BALANCE)`);
  console.log(`    Neither fires:    N=${neither}  (${neither?(neitherCorrect/neither*100).toFixed(1):'n/a'}% correctly predict BALANCE)`);
  console.log('');

  // ════════════════════════════════════════════════════════════════════════
  // PART 4 — Setup outcomes by acceptance context
  // ════════════════════════════════════════════════════════════════════════
  console.log('═'.repeat(78));
  console.log('PART 4 — SETUP WIN RATES BY ACCEPTANCE CONTEXT (setup_outcome_backtest)');
  console.log('═'.repeat(78));
  const setupsQ = await query(`
    SELECT trade_date::text, setup_type, fired_at, hit_t1, hit_stop, hit_t1_first
    FROM setup_outcome_backtest ORDER BY trade_date, fired_at
  `);
  console.log(`  Total setup_outcome_backtest rows: ${setupsQ.rows.length}`);
  if (setupsQ.rows.length < 40) {
    console.log('  Insufficient data for Part 4 entirely.');
  } else {
    const resultsByDate = {};
    for (const r of sessionResults) resultsByDate[r.date] = r;

    const buckets = { 'ACCEPTING_WITH_DIR': {n:0, t1:0}, 'AGAINST_OR_CHOPPY': {n:0, t1:0} };
    let unmatched = 0;
    for (const s of setupsQ.rows) {
      const sr = resultsByDate[s.trade_date];
      if (!sr) { unmatched++; continue; }
      const firedDate = new Date(s.fired_at);
      const etMin = (firedDate.getUTCHours()*60 + firedDate.getUTCMinutes());
      // nearest checkpoint <= fired time
      const cpT = [...CHECKPOINTS].reverse().find(t => t <= etMin);
      const cd = cpT ? sr.checkpointData[cpT] : null;
      if (!cd || cd.migrationDir === 'FIRST') { unmatched++; continue; }

      const isLong = /LONG|BULLISH|_UP/i.test(s.setup_type);
      const dirMatches = (isLong && cd.migrationDir === 'HIGHER') || (!isLong && cd.migrationDir === 'LOWER');
      const accepting = dirMatches && cd.acceptance === 'ACCEPTED';
      const bucket = accepting ? 'ACCEPTING_WITH_DIR' : 'AGAINST_OR_CHOPPY';
      buckets[bucket].n++;
      if (s.hit_t1) buckets[bucket].t1++;
    }
    console.log(`  Unmatched (no checkpoint data / FIRST checkpoint): ${unmatched}\n`);
    for (const [k,v] of Object.entries(buckets)) {
      console.log(`  ${k.padEnd(20)} N=${v.n}${v.n<20?' (N<20 — THIN, not reliable)':''}   T1 hit rate=${v.n?(v.t1/v.n*100).toFixed(1):'n/a'}%`);
    }
  }

  console.log('\n[acceptance_engine_backtest] Done. No writes performed.\n');
}

main().then(()=>process.exit(0)).catch(err=>{console.error(err); process.exit(1);});
