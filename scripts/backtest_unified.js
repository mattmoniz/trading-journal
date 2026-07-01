// scripts/backtest_unified.js
// ═══════════════════════════════════════════════════════════════════════
// UNIFIED SETUP BACKTEST — bar-by-bar replay across all setup families.
// One canonical source replacing fragmented per-setup scripts.
// Writes to performance_audit with signal_type='UNIFIED_BACKTEST'.
//
// Scope: 405 sessions, 2023-11-16 → present.
// Setups: 9 level fades, IB, C_STANDALONE, OTD, VA_RESP, TRT, BRACKET,
//         VWAP_MAGNET, STOP_SWEEP, COIL_SURGE, RSI_DIV.
// Not included: FAILED_AUCTION (timeline-event dependent),
//               ABSORPTION (bar-pattern + day_type gate; add later),
//               ZONE_EDGE_FADE, C_REVERSAL, C_PAIRED, TRT_MAH (rare).
// ═══════════════════════════════════════════════════════════════════════

import { query } from '../server/db.js';

const PT     = 2;   // $2/pt NQ micro
const COMM   = 1;   // $1 round-trip commission
const DRY_RUN = process.argv.includes('--dry-run');

// ── helpers ──────────────────────────────────────────────────────────────────
const mean = arr => arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : null;
const pct  = (n,d) => d > 0 ? (n/d*100).toFixed(1)+'%' : 'N/A';

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function floorPivots(h, l, c) {
  const pp = (h + l + c) / 3;
  return { FLOOR_PIVOT: pp, FLOOR_R1: 2*pp - l, FLOOR_S1: 2*pp - h };
}

// MAE/MFE stats helper
function mfmaeStats(vals) {
  if (!vals.length) return { p50: null, p75: null, p90: null, avg: null };
  const s = [...vals].sort((a,b)=>a-b);
  return { p50: percentile(s,50), p75: percentile(s,75), p90: percentile(s,90), avg: mean(vals) };
}

// ── Resolution ────────────────────────────────────────────────────────────────
// Walk bars from entryIdx+1. Returns { result, pnl, mae, mfe, barsHeld }.
// Conservative same-bar rule: if stop and target both hit in same bar → STOP_HIT.
function resolve(bars, entryIdx, direction, entry, stop, target, maxBars = 240) {
  let mae = 0, mfe = 0;
  const isLong = direction === 'LONG';
  for (let i = entryIdx + 1; i < bars.length && i <= entryIdx + maxBars; i++) {
    const b = bars[i];
    const excursionAdverse  = isLong ? entry - b.low  : b.high - entry;
    const excursionFavorable = isLong ? b.high - entry : entry - b.low;
    mae = Math.max(mae, excursionAdverse);
    mfe = Math.max(mfe, excursionFavorable);

    const stopHit   = isLong ? b.low  <= stop   : b.high >= stop;
    const targetHit = isLong ? b.high >= target  : b.low  <= target;

    if (stopHit && targetHit) {
      // same-bar: conservative — stop wins
      return { result: 'STOP_HIT', pnl: -(entry - stop) * PT - COMM, mae, mfe, barsHeld: i - entryIdx };
    }
    if (stopHit)   return { result: 'STOP_HIT',   pnl: -(Math.abs(entry - stop))   * PT - COMM, mae, mfe, barsHeld: i - entryIdx };
    if (targetHit) return { result: 'TARGET_HIT', pnl:  (Math.abs(target - entry)) * PT - COMM, mae, mfe, barsHeld: i - entryIdx };
  }
  return { result: 'EXPIRED', pnl: 0, mae, mfe, barsHeld: maxBars };
}

// ── Scale-out resolver: T1 (half off) then runner after stop moves to BE ─────
// Returns combined PnL: T1 half-lot + runner half-lot. Stop = 30pt; T1 = 20pt; runner = custom.
function resolveScaleOut(bars, entryIdx, direction, entry, t1Target, runnerTarget, stop, maxBars = 240) {
  let mae = 0, mfe = 0;
  const isLong = direction === 'LONG';
  let t1Hit = false;
  let beStop = stop; // stop stays original until T1 hit, then moves to entry (BE)
  let halfPnl = 0;
  for (let i = entryIdx + 1; i < bars.length && i <= entryIdx + maxBars; i++) {
    const b = bars[i];
    mae = Math.max(mae, isLong ? entry - b.low : b.high - entry);
    mfe = Math.max(mfe, isLong ? b.high - entry : entry - b.low);
    const stopHit = isLong ? b.low <= beStop : b.high >= beStop;
    if (!t1Hit) {
      const t1Hit_ = isLong ? b.high >= t1Target : b.low <= t1Target;
      if (stopHit && t1Hit_) {
        return { result: 'STOP_HIT', pnl: -(Math.abs(entry - stop)) * PT - COMM, mae, mfe, barsHeld: i - entryIdx };
      }
      if (stopHit) return { result: 'STOP_HIT', pnl: -(Math.abs(entry - stop)) * PT - COMM, mae, mfe, barsHeld: i - entryIdx };
      if (t1Hit_) {
        t1Hit = true;
        halfPnl = Math.abs(t1Target - entry) * PT * 0.5 - COMM * 0.5;
        beStop = entry; // move stop to breakeven on remaining half
      }
    } else {
      const runnerHit = isLong ? b.high >= runnerTarget : b.low <= runnerTarget;
      if (stopHit && runnerHit) {
        // same bar: conservative — stop wins on runner; T1 half already locked
        return { result: 'T1_ONLY', pnl: halfPnl - COMM * 0.5, mae, mfe, barsHeld: i - entryIdx };
      }
      if (stopHit) return { result: 'T1_ONLY', pnl: halfPnl - COMM * 0.5, mae, mfe, barsHeld: i - entryIdx };
      if (runnerHit) return { result: 'TARGET_HIT', pnl: halfPnl + Math.abs(runnerTarget - entry) * PT * 0.5 - COMM * 0.5, mae, mfe, barsHeld: i - entryIdx };
    }
  }
  // Expired: if T1 already hit, lock in T1 half
  if (t1Hit) return { result: 'T1_ONLY', pnl: halfPnl - COMM * 0.5, mae, mfe, barsHeld: maxBars };
  return { result: 'EXPIRED', pnl: 0, mae, mfe, barsHeld: maxBars };
}

// ── Aggregate stats for a set of resolved trades ──────────────────────────────
function aggregate(trades) {
  if (!trades.length) return null;
  const decided = trades.filter(t => t.result !== 'EXPIRED');
  // T1_ONLY = T1 hit, runner stopped at BE — profitable, counts as a win
  const wins    = decided.filter(t => t.result === 'TARGET_HIT' || t.result === 'T1_ONLY');
  const totalPnl = trades.reduce((s,t) => s + t.pnl, 0);
  const maeSorted = [...trades.map(t=>t.mae)].sort((a,b)=>a-b);
  const mfeSorted = [...trades.map(t=>t.mfe)].sort((a,b)=>a-b);
  // Winner-only MAE: how much room did winning trades need before succeeding
  const winMaeSorted = [...wins.map(t=>t.mae)].sort((a,b)=>a-b);
  return {
    n: trades.length,
    decided: decided.length,
    wins: wins.length,
    wr: decided.length ? wins.length / decided.length : null,
    totalPnl,
    evPerTrade: totalPnl / trades.length,
    p50_mae: percentile(maeSorted, 50),
    p75_mae: percentile(maeSorted, 75),
    p90_mae: percentile(maeSorted, 90),
    p80_mae_winners: wins.length >= 5 ? percentile(winMaeSorted, 80) : null,  // stop calibration
    p50_mfe: percentile(mfeSorted, 50),
    p75_mfe: percentile(mfeSorted, 75),
  };
}

// ── Data loading ──────────────────────────────────────────────────────────────
async function loadData() {
  console.log('Loading data...');

  // All RTH bars bulk (the big one)
  const barsRes = await query(`
    SELECT ts::date::text as d,
           EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts)::int as tod,
           open::float, high::float, low::float, close::float,
           COALESCE(volume,0)::int as vol,
           COALESCE(bid_volume,0)::int as bid_vol,
           COALESCE(ask_volume,0)::int as ask_vol
    FROM price_bars_primary
    WHERE symbol='NQ'
      AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
    ORDER BY ts
  `);
  const barsByDate = new Map();
  for (const r of barsRes.rows) {
    if (!barsByDate.has(r.d)) barsByDate.set(r.d, []);
    barsByDate.get(r.d).push(r);
  }
  console.log(`  Bars: ${barsRes.rows.length} across ${barsByDate.size} sessions`);

  // ACD daily log (OR levels, A/C signals, day_type, NL30 score, A levels for TRT stops)
  const acdRes = await query(`
    SELECT trade_date::text as d,
           or_high::float, or_low::float,
           a_up_level::float, a_down_level::float,
           COALESCE(a_up_fired, false) as a_up,
           COALESCE(a_down_fired, false) as a_down,
           COALESCE(c_up_confirmed, false) as c_up,
           COALESCE(c_down_confirmed, false) as c_down,
           day_type,
           COALESCE(daily_score, 0)::int as score,
           SUM(COALESCE(daily_score,0)) OVER (ORDER BY trade_date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) as nl30
    FROM acd_daily_log
    ORDER BY trade_date
  `);
  const acdByDate = new Map();
  for (const r of acdRes.rows) acdByDate.set(r.d, r);
  console.log(`  ACD log: ${acdRes.rows.length} rows`);

  // Developing value log (PD VA/POC — using prior day's values)
  const dvlRes = await query(`
    SELECT trade_date::text as d,
           poc::float, vah::float, val::float,
           session_high::float, session_low::float, session_close::float
    FROM developing_value_log
    ORDER BY trade_date
  `);
  const dvlByDate = new Map();
  for (const r of dvlRes.rows) dvlByDate.set(r.d, r);
  console.log(`  DVL: ${dvlRes.rows.length} rows`);

  // Rolling 30-session VWAP std (close vs RTH VWAP) — σ-based threshold for VWAP_MAGNET
  // Computed from bars directly so backtest coverage matches full bar history
  const vwapStdRes = await query(`
    WITH rth_session AS (
      SELECT ts::date::text as d,
        (array_agg(close ORDER BY ts DESC))[1]::float as session_close,
        SUM((high+low+close)/3.0 * volume) / NULLIF(SUM(volume::float),0) as session_vwap
      FROM price_bars_primary
      WHERE symbol='NQ'
        AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
      GROUP BY ts::date
    )
    SELECT d,
      (session_close - session_vwap)::float as close_vs_vwap,
      STDDEV(session_close - session_vwap) OVER (
        ORDER BY d ROWS BETWEEN 30 PRECEDING AND 1 PRECEDING
      )::float as rolling_std
    FROM rth_session ORDER BY d
  `);
  const vwapStdByDate = new Map();
  for (const r of vwapStdRes.rows) {
    if (r.rolling_std != null) vwapStdByDate.set(r.d, r.rolling_std);
  }
  console.log(`  VWAP std: ${vwapStdByDate.size} sessions with rolling std`);

  // Compute mean of all available rolling stds — used as fallback for early sessions
  const vwapStdVals = [...vwapStdByDate.values()].filter(v => v > 10);
  const vwapStdFallback = vwapStdVals.length >= 10 ? mean(vwapStdVals) : 130;

  // Ordered list of all trading dates with complete data
  const dates = [...barsByDate.keys()]
    .filter(d => acdByDate.has(d))
    .sort();

  console.log(`  Total qualifying dates: ${dates.length} (${dates[0]} → ${dates[dates.length-1]})`);
  return { barsByDate, acdByDate, dvlByDate, dates, vwapStdByDate, vwapStdFallback };
}

// ── 5-day bracket levels ──────────────────────────────────────────────────────
function buildBracketLevels(dates, barsByDate) {
  const bracketByDate = new Map();
  for (let i = 5; i < dates.length; i++) {
    const prior5 = dates.slice(i-5, i);
    let hi = -Infinity, lo = Infinity;
    for (const d of prior5) {
      const bars = barsByDate.get(d) || [];
      for (const b of bars) { hi = Math.max(hi, b.high); lo = Math.min(lo, b.low); }
    }
    if (hi > lo) bracketByDate.set(dates[i], { top: hi, bot: lo });
  }
  return bracketByDate;
}

// ── 5-day rolling OR mid ──────────────────────────────────────────────────────
function buildOrMids(dates, acdByDate) {
  const or5MidByDate = new Map();
  for (let i = 5; i < dates.length; i++) {
    const prior5 = dates.slice(i-5, i).map(d => acdByDate.get(d)).filter(Boolean);
    const orHighs = prior5.map(r=>r.or_high).filter(v=>v!=null);
    const orLows  = prior5.map(r=>r.or_low).filter(v=>v!=null);
    if (orHighs.length >= 3) {
      or5MidByDate.set(dates[i], (Math.max(...orHighs) + Math.min(...orLows)) / 2);
    }
  }
  return or5MidByDate;
}

// ── 10-day rolling IB mid ─────────────────────────────────────────────────────
function buildIbMids(dates, barsByDate) {
  const ib10MidByDate = new Map();
  for (let i = 10; i < dates.length; i++) {
    const prior10 = dates.slice(i-10, i);
    const mids = [];
    for (const d of prior10) {
      const bs = barsByDate.get(d);
      if (!bs) continue;
      const ibBars = bs.filter(b => b.tod >= 570 && b.tod < 630);
      if (ibBars.length < 3) continue;
      const ibH = Math.max(...ibBars.map(b => b.high));
      const ibL = Math.min(...ibBars.map(b => b.low));
      mids.push((ibH + ibL) / 2);
    }
    if (mids.length >= 7) {
      ib10MidByDate.set(dates[i], mids.reduce((a, b) => a + b, 0) / mids.length);
    }
  }
  return ib10MidByDate;
}

// ── Value area from a bag of bars (70% volume) ───────────────────────────────
function computeVA(bars) {
  const vbk = {};
  for (const b of bars) {
    const bk = Math.round(b.close / 25) * 25;
    vbk[bk] = (vbk[bk] || 0) + b.vol;
  }
  const sorted = Object.entries(vbk).sort((a, b) => Number(b[1]) - Number(a[1]));
  const totalV = sorted.reduce((s, [, v]) => s + Number(v), 0);
  if (!totalV) return null;
  let cumV = 0; const levels = [];
  for (const [price, vol] of sorted) {
    cumV += Number(vol); levels.push(parseFloat(price));
    if (cumV >= totalV * 0.7) break;
  }
  if (!levels.length) return null;
  return { vah: Math.max(...levels), val: Math.min(...levels) };
}

// ── Monthly open (first RTH 9:30 bar of the current calendar month) ──────────
function buildMonthlyOpens(dates, barsByDate) {
  const monthOpenByDate = new Map();
  const firstOpenByMonth = new Map();
  for (const d of dates) {
    const month = d.slice(0, 7);
    if (!firstOpenByMonth.has(month)) {
      const bars = barsByDate.get(d) || [];
      // bars are ordered by ts; first bar = open bar of the month's first trading day
      if (bars.length && bars[0].open != null) firstOpenByMonth.set(month, bars[0].open);
    }
  }
  for (const d of dates) {
    const month = d.slice(0, 7);
    const open = firstOpenByMonth.get(month);
    if (open != null) monthOpenByDate.set(d, open);
  }
  console.log(`  Monthly opens: ${firstOpenByMonth.size} months`);
  return monthOpenByDate;
}

// ── Prior calendar month value area ──────────────────────────────────────────
function buildPriorMonthVAs(dates, barsByDate) {
  const barsByMonth = new Map();
  for (const d of dates) {
    const month = d.slice(0, 7);
    if (!barsByMonth.has(month)) barsByMonth.set(month, []);
    for (const b of (barsByDate.get(d) || [])) barsByMonth.get(month).push(b);
  }
  const vaByMonth = new Map();
  for (const [month, bars] of barsByMonth) {
    const va = computeVA(bars);
    if (va) vaByMonth.set(month, va);
  }
  const pmVAByDate = new Map();
  for (const d of dates) {
    const [yr, mo] = d.slice(0, 7).split('-').map(Number);
    const prevMo = mo === 1 ? `${yr-1}-12` : `${yr}-${String(mo-1).padStart(2,'0')}`;
    const va = vaByMonth.get(prevMo);
    if (va) pmVAByDate.set(d, va);
  }
  console.log(`  Prior-month VAs: ${pmVAByDate.size} dates`);
  return pmVAByDate;
}

// ── Rolling 1M and 3M value areas ────────────────────────────────────────────
function buildRollingVAs(dates, barsByDate) {
  const m1VAByDate = new Map();
  const m3VAByDate = new Map();
  const dateMs = new Map(dates.map(d => [d, new Date(d + 'T12:00:00').getTime()]));
  const MS_30D = 30 * 24 * 3600 * 1000;
  const MS_90D = 90 * 24 * 3600 * 1000;

  for (let i = 1; i < dates.length; i++) {
    const d = dates[i];
    const dMs = dateMs.get(d);
    const m1Bars = [], m3Bars = [];
    for (let j = i - 1; j >= 0; j--) {
      const dj = dates[j];
      const diff = dMs - dateMs.get(dj);
      if (diff > MS_90D) break;
      const bs = barsByDate.get(dj) || [];
      m3Bars.push(...bs);
      if (diff <= MS_30D) m1Bars.push(...bs);
    }
    if (m1Bars.length >= 100) { const va = computeVA(m1Bars); if (va) m1VAByDate.set(d, va); }
    if (m3Bars.length >= 100) { const va = computeVA(m3Bars); if (va) m3VAByDate.set(d, va); }
  }
  console.log(`  Rolling VAs: 1M=${m1VAByDate.size} 3M=${m3VAByDate.size} dates`);
  return { m1VAByDate, m3VAByDate };
}

// ── Per-session PD IB mid ─────────────────────────────────────────────────────
function pdIbMid(prevBars) {
  if (!prevBars) return null;
  const ibBars = prevBars.filter(b => b.tod >= 570 && b.tod < 600);
  if (!ibBars.length) return null;
  const ibH = Math.max(...ibBars.map(b=>b.high));
  const ibL = Math.min(...ibBars.map(b=>b.low));
  return (ibH + ibL) / 2;
}

// ── SETUP DETECTION ───────────────────────────────────────────────────────────
// Each detector returns an array of { type, direction, entryIdx, entry, stop, target }
// entryIdx is the bars[] index of the detection bar (resolution starts at entryIdx+1).

// 1. Level Fades — IB-close gate: no touches before 10:30 AM (matching live system's 60-bar minimum)
function detectLevelFades(bars, levels, isMonday) {
  const STOP = isMonday ? 60 : 90, TARGET = isMonday ? 30 : 40;
  const IB_CLOSE = 630; // 10:30 AM ET = 570 + 60 min
  const AM_CUT   = 720; // noon cutoff
  const fires = [];
  const fired = new Set();
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i], prev = bars[i-1];
    if (b.tod < IB_CLOSE) continue; // wait for IB to close
    if (b.tod >= AM_CUT) break;
    for (const [name, lvl] of Object.entries(levels)) {
      if (lvl == null || fired.has(name)) continue;
      const nearNow  = Math.abs(b.close - lvl) <= 10;
      if (!nearNow) continue;
      const fromAbove = prev.close > lvl;
      const dir = fromAbove ? 'SHORT' : 'LONG';
      fires.push({ type: `${name}_${dir}`, direction: dir,
        entryIdx: i, entry: b.close,
        stop: dir === 'LONG' ? b.close - STOP : b.close + STOP,
        target: dir === 'LONG' ? b.close + TARGET : b.close - TARGET });
      fired.add(name);
    }
  }
  return fires;
}

// 2. IB (bearish/bullish) — detected at IB close (first bar at tod >= 600)
function detectIB(bars, orH, orL, pdVAH, pdVAL) {
  const ibBars = bars.filter(b => b.tod >= 570 && b.tod < 600);
  if (ibBars.length < 2) return [];
  const ibH = Math.max(...ibBars.map(b=>b.high));
  const ibL = Math.min(...ibBars.map(b=>b.low));
  const ibMid = (ibH + ibL) / 2;
  const ibClose = ibBars[ibBars.length-1].close;
  const totalAsk = ibBars.reduce((s,b)=>s+b.ask_vol,0);
  const totalBid = ibBars.reduce((s,b)=>s+b.bid_vol,0);
  // Use price direction when no volume data (bid/ask = 0)
  const hasVol = totalAsk + totalBid > 0;
  const isBull = hasVol ? (ibClose > ibMid && totalAsk >= totalBid) : (ibClose > ibMid);
  const isBear = hasVol ? (ibClose < ibMid && totalBid > totalAsk) : (ibClose < ibMid);
  if (!isBull && !isBear) return [];

  // Entry: first post-IB bar where price is on correct side of IB mid
  const postIdx = bars.findIndex(b => b.tod >= 600);
  if (postIdx === -1) return [];
  for (let i = postIdx; i < bars.length && bars[i].tod < 720; i++) {
    const b = bars[i];
    if (isBull && b.close > ibMid) {
      const target = pdVAH && pdVAH > b.close ? pdVAH : ibH + (orH - orL) * 0.5;
      return [{ type: 'IB_BULLISH', direction: 'LONG', entryIdx: i, entry: b.close,
        stop: ibL - 2, target }];
    }
    if (isBear && b.close < ibMid) {
      const ibRange = ibH - ibL;
      const target = pdVAL && pdVAL < b.close ? pdVAL : ibL - (orH - orL) * 0.5;
      return [{ type: 'IB_BEARISH', direction: 'SHORT', entryIdx: i, entry: b.close,
        stop: ibMid + ibRange * 0.46, target }];
    }
  }
  return [];
}

// 3. C_STANDALONE (no A fired, first OR break)
function detectCStandalone(bars, orH, orL, aUp, aDown, pdVAH, pdVAL) {
  if (aUp || aDown) return [];
  const orRange = orH - orL || 60;
  const fires = [];
  let cFired = false;
  for (let i = 0; i < bars.length; i++) {
    if (cFired) break;
    const b = bars[i];
    if (b.close > orH) {
      const target = pdVAH && pdVAH > b.close ? pdVAH : b.close + orRange;
      fires.push({ type: 'C_STANDALONE_UP', direction: 'LONG', entryIdx: i, entry: b.close,
        stop: orL - 4, target });
      cFired = true;
    } else if (b.close < orL) {
      const target = pdVAL && pdVAL < b.close ? pdVAL : b.close - orRange;
      fires.push({ type: 'C_STANDALONE_DOWN', direction: 'SHORT', entryIdx: i, entry: b.close,
        stop: orH + 4, target });
      cFired = true;
    }
  }
  return fires;
}

// 4. OPEN_TEST_DRIVE — probe AND reversal must both complete within the first 15 bars.
// Matches live acd.js: otdBars.some(b => b.close < orL) is checked against the same 15-bar window.
function detectOTD(bars, orH, orL, pdVAH, pdVAL) {
  const first15 = bars.filter(b => b.tod >= 570 && b.tod < 585);
  if (first15.length < 3) return [];
  const openPx   = first15[0].open;
  const probeHi  = Math.max(...first15.map(b=>b.high));
  const probeLo  = Math.min(...first15.map(b=>b.low));
  const upProbe  = probeHi - openPx;
  const dnProbe  = openPx - probeLo;
  const orRange  = orH - orL || 60;

  // Both the probe AND the reversal-through-OR must happen within the first 15 bars
  const shortSignaled = upProbe >= 10 && first15.some(b => b.close < orL);
  const longSignaled  = dnProbe >= 10 && first15.some(b => b.close > orH);

  const fires = [];
  if (shortSignaled) {
    // Entry: first bar after the signal bar where current price is still below orL
    const sigBar = first15.findIndex(b => b.close < orL);
    if (sigBar >= 0) {
      const eb = first15[sigBar];
      const tgtShort = pdVAL && pdVAL < eb.close ? pdVAL : eb.close - orRange * 1.5;
      fires.push({ type: 'OPEN_TEST_DRIVE_SHORT', direction: 'SHORT',
        entryIdx: bars.indexOf(eb),
        entry: eb.close, stop: probeHi + orRange * 0.35, target: tgtShort });
    }
  }
  if (longSignaled) {
    const sigBar = first15.findIndex(b => b.close > orH);
    if (sigBar >= 0) {
      const eb = first15[sigBar];
      const tgtLong = pdVAH && pdVAH > eb.close ? pdVAH : eb.close + orRange * 1.5;
      fires.push({ type: 'OPEN_TEST_DRIVE_LONG', direction: 'LONG',
        entryIdx: bars.indexOf(eb),
        entry: eb.close, stop: probeLo, target: tgtLong });
    }
  }
  return fires;
}

// 5. VALUE_AREA_RESPONSIVE (open inside prior value, price tests VA edge)
function detectVAResp(bars, pdVAH, pdVAL, pdPOC, orH, orL) {
  if (!pdVAH || !pdVAL) return [];
  const openBar = bars[0];
  const insideValue = openBar && openBar.close >= pdVAL && openBar.close <= pdVAH;
  if (!insideValue) return [];
  const orRange = orH - orL || 60;
  const fires = [];

  // SHORT: price approaches pdVAH from below
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].tod >= 720) break;
    if (Math.abs(bars[i].close - pdVAH) <= 20 && bars[i].close <= pdVAH + 20) {
      const target = (pdPOC && pdPOC < bars[i].close) ? pdPOC
                   : (pdVAL && pdVAL < bars[i].close) ? pdVAL
                   : bars[i].close - orRange * 0.5;
      fires.push({ type: 'VALUE_AREA_RESPONSIVE_SHORT', direction: 'SHORT', entryIdx: i,
        entry: bars[i].close, stop: pdVAH + 18, target });
      break;
    }
  }
  // LONG: price approaches pdVAL from above
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].tod >= 720) break;
    if (Math.abs(bars[i].close - pdVAL) <= 20 && bars[i].close >= pdVAL - 20) {
      const target = (pdPOC && pdPOC > bars[i].close) ? pdPOC
                   : (pdVAH && pdVAH > bars[i].close) ? pdVAH
                   : bars[i].close + orRange * 0.5;
      fires.push({ type: 'VALUE_AREA_RESPONSIVE_LONG', direction: 'LONG', entryIdx: i,
        entry: bars[i].close, stop: pdVAL - 8, target });
      break;
    }
  }
  return fires;
}

// 6. TRT (A+C both failed in same direction, price reverses through OR)
// Stop = aLevel ± 12 — matches live acd.js exactly (aDownLevel-12 / aUpLevel+12).
function detectTRT(bars, orH, orL, aUp, aDown, cUp, cDown, pdVAH, pdVAL, aUpLevel, aDownLevel) {
  const orRange = orH - orL || 60;
  const fires = [];

  // TRT_LONG: A_DOWN + C_DOWN both fired, price reclaims above OR High
  if (aDown && cDown && aDownLevel) {
    const stop = +(aDownLevel - 12);
    for (let i = 0; i < bars.length; i++) {
      if (bars[i].tod >= 720) break;
      if (bars[i].close > orH) {
        const target = pdVAH && pdVAH > bars[i].close ? pdVAH : orH + orRange;
        fires.push({ type: 'TRT_LONG', direction: 'LONG', entryIdx: i,
          entry: bars[i].close, stop, target });
        break;
      }
    }
  }

  // TRT_SHORT: A_UP + C_UP both fired, price breaks back below OR Low
  if (aUp && cUp && aUpLevel) {
    const stop = +(aUpLevel + 12);
    for (let i = 0; i < bars.length; i++) {
      if (bars[i].tod >= 720) break;
      if (bars[i].close < orL) {
        const target = pdVAL && pdVAL < bars[i].close ? pdVAL : orL - orRange;
        fires.push({ type: 'TRT_SHORT', direction: 'SHORT', entryIdx: i,
          entry: bars[i].close, stop, target });
        break;
      }
    }
  }
  return fires;
}

// 7. BRACKET_BREAKOUT
function detectBracketBreakout(bars, bracket, orH, orL, nl30, pdVAH, pdVAL) {
  if (!bracket) return [];
  const orRange = orH - orL || 60;
  const nl30Bull = nl30 > 9, nl30Bear = nl30 < -9;
  const fires = [];

  for (let i = 0; i < bars.length; i++) {
    if (bars[i].tod >= 720) break;
    if (nl30Bull && bars[i].close > bracket.top + 5) {
      const vaExt = pdVAH && pdVAL ? pdVAH + (pdVAH - pdVAL) : null;
      const target = (vaExt && vaExt > bars[i].close) ? vaExt
                   : (pdVAH && pdVAH > bars[i].close) ? pdVAH
                   : bars[i].close + orRange;
      fires.push({ type: 'BRACKET_BREAKOUT_LONG', direction: 'LONG', entryIdx: i,
        entry: bars[i].close, stop: bracket.top - orRange * 1.2, target });
      break;
    }
    if (nl30Bear && bars[i].close < bracket.bot - 5) {
      const vaExtS = pdVAH && pdVAL ? pdVAL - (pdVAH - pdVAL) : null;
      const target = (vaExtS && vaExtS < bars[i].close) ? vaExtS
                   : (pdVAL && pdVAL < bars[i].close) ? pdVAL
                   : bars[i].close - orRange;
      fires.push({ type: 'BRACKET_BREAKOUT_SHORT', direction: 'SHORT', entryIdx: i,
        entry: bars[i].close, stop: bracket.bot + 5, target });
      break;
    }
  }
  return fires;
}

// 8. VWAP_MAGNET — σ-based trigger: fires when price is ≥1.5σ from VWAP.
// σ = rolling 30-session std of (session_close - RTH_VWAP), precomputed from bar data.
// Matches live acd.js which uses session_analysis.close_vs_vwap rolling std.
// T1 = 20pt, runner = min(vwapDist*0.5, 100pt) toward VWAP. Stop = 30pt.
function detectVwapMagnet(bars, vwapStd, vwapStdFallback = 130) {
  const SIGMA_TRIGGER = 1.5;
  const effectiveStd = (vwapStd && vwapStd > 10) ? vwapStd : vwapStdFallback;
  const thresh = Math.round(effectiveStd * SIGMA_TRIGGER);

  let pv = 0, tv = 0;
  const fires = [];
  let fired = false;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const tp = (b.high + b.low + b.close) / 3;
    pv += tp * (b.vol || 1); tv += (b.vol || 1);
    const vwap = pv / tv;
    if (i < 20 || fired) continue;
    const dist = b.close - vwap;
    if (Math.abs(dist) >= thresh) {
      const isLong = dist < 0;
      const runnerDist = Math.min(Math.round(Math.abs(dist) * 0.5), 100);
      fires.push({ type: isLong ? 'VWAP_MAGNET_LONG' : 'VWAP_MAGNET_SHORT',
        direction: isLong ? 'LONG' : 'SHORT', entryIdx: i, entry: b.close,
        stop: isLong ? b.close - 30 : b.close + 30,
        t1Target: isLong ? b.close + 20 : b.close - 20,
        target: isLong ? b.close + runnerDist : b.close - runnerDist,
        isScaleOut: true });
      fired = true;
    }
  }
  return fires;
}

// 9. STOP_SWEEP (sweep key level within session range, close back inside + reversal)
function detectStopSweep(bars, levels) {
  const keyLevels = Object.values(levels).filter(v => v != null);
  const fires = [];
  const sweptLevels = new Set();

  for (let i = 2; i < bars.length; i++) {
    const b = bars[i], prev = bars[i-1];
    for (const lvl of keyLevels) {
      if (sweptLevels.has(lvl.toFixed(0))) continue;
      // Sweep: range of bar extends beyond level, but close is back inside
      const swept = (b.low < lvl && b.high > lvl) ||
                    (prev.low < lvl && b.close > lvl && b.close > prev.close) ||
                    (prev.high > lvl && b.close < lvl && b.close < prev.close);
      if (!swept) continue;
      // Check 2-bar reversal confirmation
      const isLong  = b.close > lvl; // bounced above level
      const isShort = b.close < lvl; // rejected below level
      if (!isLong && !isShort) continue;
      sweptLevels.add(lvl.toFixed(0));
      const dir = isLong ? 'LONG' : 'SHORT';
      fires.push({ type: isLong ? 'STOP_SWEEP_LONG' : 'STOP_SWEEP_SHORT',
        direction: dir, entryIdx: i, entry: b.close,
        stop: isLong ? b.close - 15 : b.close + 15,
        target: isLong ? b.close + 30 : b.close - 30 });
    }
  }
  return fires.slice(0, 2); // cap at 2 per session
}

// 10. COIL_SURGE (tight 15-bar range + low vol + volume spike)
function detectCoilSurge(bars) {
  if (bars.length < 60) return [];
  let pv = 0, tv = 0;
  const vwaps = [];
  for (const b of bars) {
    pv += (b.high+b.low+b.close)/3*(b.vol||1); tv += (b.vol||1);
    vwaps.push(tv > 0 ? pv/tv : null);
  }
  const fires = [];
  const cbars = bars;
  const RW=15, RT=40, VR=0.40, BB=20, POP=2.5;

  for (let ci = 50; ci < cbars.length-5; ci++) {
    let hi=-Infinity, lo=Infinity;
    for (let j=ci-RW+1;j<=ci;j++){hi=Math.max(hi,cbars[j].high);lo=Math.min(lo,cbars[j].low);}
    if (hi-lo >= RT) continue;
    const cbs=Math.max(0,ci-RW-BB), cbe=ci-RW;
    if (cbe-cbs<10) continue;
    const baseVol = cbars.slice(cbs,cbe).reduce((s,b)=>s+(b.vol||0),0)/(cbe-cbs);
    if (baseVol <= 0) continue;
    const coilVol = cbars.slice(ci-RW+1,ci+1).reduce((s,b)=>s+(b.vol||0),0)/RW;
    if (coilVol/baseVol >= VR) continue; // coil must be quiet
    // Check if any of the next 5 bars is a surge
    for (let si=ci+1;si<=ci+5 && si<cbars.length;si++) {
      if ((cbars[si].vol||0)/baseVol < POP) continue;
      const vwap = vwaps[si];
      if (!vwap) continue;
      const dist = cbars[si].close - vwap;
      if (Math.abs(dist) < 8) continue;
      const isLong = dist < 0;
      const stopDist = Math.max(15, isLong ? cbars[si].close-(lo-5) : (hi+5)-cbars[si].close);
      fires.push({ type: isLong ? 'COIL_SURGE_LONG' : 'COIL_SURGE_SHORT',
        direction: isLong?'LONG':'SHORT', entryIdx: si, entry: cbars[si].close,
        stop: isLong ? cbars[si].close-stopDist : cbars[si].close+stopDist,
        target: Math.round(vwap) });
      break; // one fire per coil
    }
    if (fires.length) break; // one fire per session
  }
  return fires;
}

// 11. RSI_DIV on 15-min bars
function detectRsiDiv(bars) {
  // Resample to 15-min
  const bk = {};
  for (const b of bars) {
    const k = Math.floor(b.tod/15)*15;
    if (!bk[k]) bk[k]={open:b.open,high:b.high,low:b.low,close:b.close};
    else { bk[k].high=Math.max(bk[k].high,b.high); bk[k].low=Math.min(bk[k].low,b.low); bk[k].close=b.close; }
  }
  const fb = Object.values(bk);
  if (fb.length < 17) return [];
  const fc=fb.map(b=>b.close), fh=fb.map(b=>b.high), fl=fb.map(b=>b.low);
  const rsi=new Array(fc.length).fill(null);
  let ag=0,al=0;
  for(let i=1;i<=14;i++){const d=fc[i]-fc[i-1];ag+=d>0?d:0;al+=d<0?-d:0;}
  ag/=14;al/=14;
  rsi[14]=al===0?100:100-100/(1+ag/al);
  for(let i=15;i<fc.length;i++){const d=fc[i]-fc[i-1];ag=(ag*13+(d>0?d:0))/14;al=(al*13+(d<0?-d:0))/14;rsi[i]=al===0?100:100-100/(1+ag/al);}
  const SW=2;
  const sH=[],sL=[];
  for(let i=SW;i<fc.length-SW;i++){
    let iH=true,iL=true;
    for(let j=1;j<=SW;j++){if(fh[i]<=fh[i-j]||fh[i]<=fh[i+j])iH=false;if(fl[i]>=fl[i-j]||fl[i]>=fl[i+j])iL=false;}
    if(iH)sH.push({idx:i,price:fh[i],rsi:rsi[i]});
    if(iL)sL.push({idx:i,price:fl[i],rsi:rsi[i]});
  }

  const fires = [];
  // Bullish: price lower low + RSI higher low + confirmation
  if (sL.length >= 2) {
    const curr=sL[sL.length-1], prev=sL[sL.length-2];
    if (curr.idx-prev.idx<=12 && curr.price<prev.price && curr.rsi!=null && prev.rsi!=null && curr.rsi>prev.rsi) {
      const last=fc.length-1, confIdx=curr.idx+1;
      if (confIdx<=last && last-confIdx<=2 && fc[confIdx]>fc[curr.idx]) {
        // Map 15-min bar index to minute-of-day (tod)
        const confTod = 570 + confIdx * 15;
        const entryBarIdx = bars.findIndex(b => b.tod >= confTod);
        if (entryBarIdx > 0) {
          const sd = Math.max(20, Math.round((fh[curr.idx]-fl[curr.idx])*1.5));
          const eb = bars[entryBarIdx];
          fires.push({ type:'RSI_DIV_BULLISH', direction:'LONG', entryIdx:entryBarIdx,
            entry:eb.close, stop:eb.close-sd, target:eb.close+sd*2 });
        }
      }
    }
  }
  // Bearish: price higher high + RSI lower high + confirmation
  if (!fires.length && sH.length >= 2) {
    const curr=sH[sH.length-1], prev=sH[sH.length-2];
    if (curr.idx-prev.idx<=12 && curr.price>prev.price && curr.rsi!=null && prev.rsi!=null && curr.rsi<prev.rsi) {
      const last=fc.length-1, confIdx=curr.idx+1;
      if (confIdx<=last && last-confIdx<=2 && fc[confIdx]<fc[curr.idx]) {
        const confTod = 570 + confIdx*15;
        const entryBarIdx = bars.findIndex(b => b.tod >= confTod);
        if (entryBarIdx > 0) {
          const sd = Math.max(20, Math.round((fh[curr.idx]-fl[curr.idx])*1.5));
          const eb = bars[entryBarIdx];
          fires.push({ type:'RSI_DIV_BEARISH', direction:'SHORT', entryIdx:entryBarIdx,
            entry:eb.close, stop:eb.close+sd, target:eb.close-sd*2 });
        }
      }
    }
  }
  return fires;
}

// ── Write results to performance_audit ───────────────────────────────────────
async function writeResults(setupName, stats, windowDays, signalType = 'UNIFIED_BACKTEST', recommendation = null) {
  if (!stats || stats.n === 0) return;
  const wr = stats.decided > 0 ? stats.wr : null;
  const confidence_tier = stats.n < 20 ? 'THIN' : stats.n < 50 ? 'MARGINAL' : 'CONFIDENT';
  const notes = JSON.stringify({
    decided: stats.decided,
    wins: stats.wins,
    confidence_tier,
    p80_mae_winners: stats.p80_mae_winners ?? null,
  });
  await query(`
    INSERT INTO performance_audit
      (run_date, window_days, signal_type, signal_name,
       sample_size, win_rate, ev_per_trade, total_pnl,
       p50_mae, p75_mae, p90_mae, p50_mfe, p75_mfe, notes, recommendation)
    VALUES (CURRENT_DATE,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE SET
      sample_size=EXCLUDED.sample_size, win_rate=EXCLUDED.win_rate,
      ev_per_trade=EXCLUDED.ev_per_trade, total_pnl=EXCLUDED.total_pnl,
      p50_mae=EXCLUDED.p50_mae, p75_mae=EXCLUDED.p75_mae, p90_mae=EXCLUDED.p90_mae,
      p50_mfe=EXCLUDED.p50_mfe, p75_mfe=EXCLUDED.p75_mfe,
      notes=EXCLUDED.notes, recommendation=EXCLUDED.recommendation, created_at=now()
  `, [windowDays, signalType, setupName, stats.n, wr, stats.evPerTrade, stats.totalPnl,
      stats.p50_mae, stats.p75_mae, stats.p90_mae, stats.p50_mfe, stats.p75_mfe,
      notes, recommendation]);
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  const { barsByDate, acdByDate, dvlByDate, dates, vwapStdByDate, vwapStdFallback } = await loadData();
  const bracketByDate   = buildBracketLevels(dates, barsByDate);
  const or5MidByDate    = buildOrMids(dates, acdByDate);
  const ib10MidByDate   = buildIbMids(dates, barsByDate);
  const monthOpenByDate = buildMonthlyOpens(dates, barsByDate);
  const pmVAByDate      = buildPriorMonthVAs(dates, barsByDate);
  const { m1VAByDate, m3VAByDate } = buildRollingVAs(dates, barsByDate);

  // All trades keyed by setup_type: array of resolved trade objects with .date
  const allTrades = new Map();

  console.log('\nRunning detection + resolution...');
  let sessionsDone = 0;

  for (let di = 5; di < dates.length; di++) {
    const date = dates[di];
    const bars  = barsByDate.get(date);
    const acd   = acdByDate.get(date);
    if (!bars || !acd || !bars.length) continue;

    // Prior day data
    const prevDate = dates[di-1];
    const prevDvl  = dvlByDate.get(prevDate);
    const prevBars = barsByDate.get(prevDate);
    const prevAcd  = acdByDate.get(prevDate);

    const pdVAH = prevDvl?.vah ?? null;
    const pdVAL = prevDvl?.val ?? null;
    const pdPOC = prevDvl?.poc ?? null;
    const orH   = acd.or_high, orL = acd.or_low;
    if (!orH || !orL) continue;
    const orRange = orH - orL;

    // Floor pivots from prior session
    let fpLevels = {};
    if (prevDvl?.session_high && prevDvl?.session_low && prevDvl?.session_close) {
      fpLevels = floorPivots(prevDvl.session_high, prevDvl.session_low, prevDvl.session_close);
    }

    // PD IB mid from prior session's bars
    const pdIb = pdIbMid(prevBars);

    // PD OR mid
    const pdOrMid = prevAcd?.or_high && prevAcd?.or_low
      ? (prevAcd.or_high + prevAcd.or_low) / 2 : null;

    // 5D OR mid / 10D IB mid
    const or5Mid  = or5MidByDate.get(date) ?? null;
    const ib10Mid = ib10MidByDate.get(date) ?? null;

    // Level fade levels
    const pmVA = pmVAByDate.get(date);
    const m1VA = m1VAByDate.get(date);
    const m3VA = m3VAByDate.get(date);

    // IB high/low for today (needed for IB_HIGH/IB_LOW fades, valid post-IB)
    const ibBarsToday = bars.filter(b => b.tod >= 570 && b.tod < 630);
    const ibH = ibBarsToday.length >= 3 ? Math.max(...ibBarsToday.map(b => b.high)) : null;
    const ibL = ibBarsToday.length >= 3 ? Math.min(...ibBarsToday.map(b => b.low)) : null;

    const fadeLevels = {
      PD_POC:       pdPOC,
      '5D_OR_MID':  or5Mid,
      '10D_IB_MID': ib10Mid,
      PD_VAL:      pdVAL,
      PD_VAH:      pdVAH,
      PD_IB_MID:   pdIb,
      FLOOR_PIVOT: fpLevels.FLOOR_PIVOT ?? null,
      OR_HIGH:     orH,
      OR_LOW:      orL,
      FLOOR_R1:    fpLevels.FLOOR_R1 ?? null,
      FLOOR_S1:    fpLevels.FLOOR_S1 ?? null,
      IB_HIGH:     ibH,
      IB_LOW:      ibL,
      PD_OR_MID:   pdOrMid,
      MONTH_OPEN:  monthOpenByDate.get(date) ?? null,
      PM_VAH:      pmVA?.vah ?? null,
      PM_VAL:      pmVA?.val ?? null,
      M1_VAH:      m1VA?.vah ?? null,
      M1_VAL:      m1VA?.val ?? null,
      M3_VAH:      m3VA?.vah ?? null,
      M3_VAL:      m3VA?.val ?? null,
    };

    const nl30    = parseInt(acd.nl30) || 0;
    const isMonday = new Date(date + 'T12:00:00').getDay() === 1;

    // Collect all fires for this session
    const fires = [
      ...detectLevelFades(bars, fadeLevels, isMonday),
      ...detectIB(bars, orH, orL, pdVAH, pdVAL),
      ...detectCStandalone(bars, orH, orL, acd.a_up, acd.a_down, pdVAH, pdVAL),
      ...detectOTD(bars, orH, orL, pdVAH, pdVAL),
      ...detectVAResp(bars, pdVAH, pdVAL, pdPOC, orH, orL),
      ...detectTRT(bars, orH, orL, acd.a_up, acd.a_down, acd.c_up, acd.c_down, pdVAH, pdVAL, acd.a_up_level, acd.a_down_level),
      ...detectBracketBreakout(bars, bracketByDate.get(date), orH, orL, nl30, pdVAH, pdVAL),
      ...detectVwapMagnet(bars, vwapStdByDate.get(date), vwapStdFallback),
      ...detectStopSweep(bars, { pdPOC, pdVAH, pdVAL, orH, orL, ...fpLevels }),
      ...detectCoilSurge(bars),
      ...detectRsiDiv(bars),
    ];

    // Resolve each fire
    for (const fire of fires) {
      if (fire.entryIdx == null || fire.entryIdx < 0) continue;
      if (!fire.stop || !fire.target) continue;
      // Validate non-degenerate stop/target
      const isLong = fire.direction === 'LONG';
      if (isLong && (fire.stop >= fire.entry || fire.target <= fire.entry)) continue;
      if (!isLong && (fire.stop <= fire.entry || fire.target >= fire.entry)) continue;

      const res = fire.isScaleOut
        ? resolveScaleOut(bars, fire.entryIdx, fire.direction, fire.entry, fire.t1Target, fire.target, fire.stop)
        : resolve(bars, fire.entryIdx, fire.direction, fire.entry, fire.stop, fire.target);
      const trade = { date, ...fire, ...res };

      if (!allTrades.has(fire.type)) allTrades.set(fire.type, []);
      allTrades.get(fire.type).push(trade);
    }

    sessionsDone++;
    if (sessionsDone % 50 === 0) process.stdout.write(`  ${sessionsDone}/${dates.length - 5} sessions...\r`);
  }

  console.log(`\nDetection complete. ${sessionsDone} sessions processed.`);

  // ── Aggregate and report ────────────────────────────────────────────────────
  // session-based windows defined per-setup in the aggregation loop below
  const allSetupTypes = [...allTrades.keys()].sort();

  console.log('\n── UNIFIED BACKTEST RESULTS ───────────────────────────────────────────');
  console.log(`${'SETUP'.padEnd(35)} ${'N'.padStart(4)} ${'WR'.padStart(7)} ${'EV/trade'.padStart(10)} ${'P50 MAE'.padStart(9)} ${'P50 MFE'.padStart(9)}`);
  console.log('─'.repeat(80));

  const writePromises = [];

  for (const setupType of allSetupTypes) {
    const trades = allTrades.get(setupType);
    // All-time
    const statsAll = aggregate(trades);

    // Session-based windows: last N trading sessions (not calendar days).
    // Much more meaningful than calendar-day cutoffs for infrequent setups.
    const SESSION_WINDOWS = [10, 30, 90, 180]; // trading sessions
    const windowStats = {};
    for (const sw of SESSION_WINDOWS) {
      const cutoffDate = dates.length > sw ? dates[dates.length - sw - 1] : '';
      const recent = cutoffDate ? trades.filter(t => t.date > cutoffDate) : trades;
      windowStats[sw] = aggregate(recent);
    }

    if (statsAll) {
      const wrStr = statsAll.wr != null ? (statsAll.wr*100).toFixed(1)+'%' : 'N/A';
      const evStr = statsAll.evPerTrade != null ? '$'+statsAll.evPerTrade.toFixed(0) : 'N/A';
      const maeStr = statsAll.p50_mae != null ? statsAll.p50_mae.toFixed(0)+'pt' : 'N/A';
      const mfeStr = statsAll.p50_mfe != null ? statsAll.p50_mfe.toFixed(0)+'pt' : 'N/A';
      console.log(`${setupType.padEnd(35)} ${String(statsAll.n).padStart(4)} ${wrStr.padStart(7)} ${evStr.padStart(10)} ${maeStr.padStart(9)} ${mfeStr.padStart(9)}`);
    }

    if (!DRY_RUN) {
      // Write all-time (window_days=9999)
      writePromises.push(writeResults(setupType, statsAll, 9999));
      for (const sw of SESSION_WINDOWS) {
        writePromises.push(writeResults(setupType, windowStats[sw], sw));
      }
    }
  }

  // ── SYSTEM_BACKTEST: direction-aggregated rows (all-time only) ────────────────
  // Combines LONG+SHORT for each level pair into a single non-directional row.
  // Directional rows (UNIFIED_BACKTEST) already have all windows — only write 9999 here.
  const SYSTEM_BACKTEST_PAIRS = {
    'PD_POC':      ['PD_POC_LONG',      'PD_POC_SHORT'],
    '5D_OR_MID':   ['5D_OR_MID_LONG',   '5D_OR_MID_SHORT'],
    '10D_IB_MID':  ['10D_IB_MID_LONG',  '10D_IB_MID_SHORT'],
    'PD_VAL':      ['PD_VAL_LONG',      'PD_VAL_SHORT'],
    'PD_VAH':      ['PD_VAH_LONG',      'PD_VAH_SHORT'],
    'PD_IB_MID':   ['PD_IB_MID_LONG',   'PD_IB_MID_SHORT'],
    'FLOOR_PIVOT':  ['FLOOR_PIVOT_LONG', 'FLOOR_PIVOT_SHORT'],
    'OR_HIGH':     ['OR_HIGH_LONG',     'OR_HIGH_SHORT'],
    'OR_LOW':      ['OR_LOW_LONG',      'OR_LOW_SHORT'],
    'FLOOR_R1':    ['FLOOR_R1_LONG',    'FLOOR_R1_SHORT'],
    'FLOOR_S1':    ['FLOOR_S1_LONG',    'FLOOR_S1_SHORT'],
    'IB_HIGH':     ['IB_HIGH_LONG',     'IB_HIGH_SHORT'],
    'IB_LOW':      ['IB_LOW_LONG',      'IB_LOW_SHORT'],
    'PD_OR_MID':   ['PD_OR_MID_LONG',   'PD_OR_MID_SHORT'],
    'MONTH_OPEN':  ['MONTH_OPEN_LONG',  'MONTH_OPEN_SHORT'],
    'PM_VAH':      ['PM_VAH_LONG',      'PM_VAH_SHORT'],
    'PM_VAL':      ['PM_VAL_LONG',      'PM_VAL_SHORT'],
    'M1_VAH':      ['M1_VAH_LONG',      'M1_VAH_SHORT'],
    'M1_VAL':      ['M1_VAL_LONG',      'M1_VAL_SHORT'],
    'M3_VAH':      ['M3_VAH_LONG',      'M3_VAH_SHORT'],
    'M3_VAL':      ['M3_VAL_LONG',      'M3_VAL_SHORT'],
  };

  const sysBacktestPromises = [];
  if (!DRY_RUN) {
    console.log('\n── SYSTEM_BACKTEST (combined direction) ──────────────────────────────────');
    for (const [baseName, [longKey, shortKey]] of Object.entries(SYSTEM_BACKTEST_PAIRS)) {
      const longTrades  = allTrades.get(longKey)  || [];
      const shortTrades = allTrades.get(shortKey) || [];
      const combined = [...longTrades, ...shortTrades];
      if (!combined.length) continue;
      const statsAll = aggregate(combined);
      if (statsAll) {
        const wrStr = statsAll.wr != null ? (statsAll.wr*100).toFixed(1)+'%' : 'N/A';
        // ACTIVE: N≥20, WR≥65%, positive EV. CONTEXT: N≥20, WR≥55% (or positive EV but WR<65%). null=thin
        const rec = statsAll.n >= 20 && statsAll.wr >= 0.65 && (statsAll.evPerTrade ?? 0) > 0 ? 'ACTIVE'
                  : statsAll.n >= 20 && statsAll.wr >= 0.55 ? 'CONTEXT'
                  : null;
        console.log(`  ${baseName.padEnd(15)} N=${statsAll.n} WR=${wrStr}${rec ? ` [${rec}]` : ' [THIN]'}`);
        sysBacktestPromises.push(writeResults(baseName, statsAll, 9999, 'SYSTEM_BACKTEST', rec));
      }
    }
  }

  // Setups with zero fires
  const allKnownTypes = [
    'C_REVERSAL_LONG','C_REVERSAL_SHORT','ABSORPTION_LONG',
    'ZONE_EDGE_FADE','FAILED_AUCTION_LONG','FAILED_AUCTION_SHORT',
    'A_UP_STRONG','A_DOWN_STRONG','A_UP_WEAK','A_DOWN_WEAK'
  ];
  const zeroFire = allKnownTypes.filter(t => !allTrades.has(t));
  if (zeroFire.length) {
    console.log('\n── ZERO FIRES (conditions too tight or detection not implemented) ─────────');
    for (const t of zeroFire) console.log(`  ${t}`);
  }

  if (!DRY_RUN) {
    await Promise.all([...writePromises, ...sysBacktestPromises]);
    console.log(`\nWrote ${writePromises.length} UNIFIED_BACKTEST rows + ${sysBacktestPromises.length} SYSTEM_BACKTEST rows to performance_audit.`);
  } else {
    console.log('\n[DRY RUN — no DB writes]');
  }

  console.log('\nDone.');
}

main().catch(e => { console.error(e); process.exit(1); });
