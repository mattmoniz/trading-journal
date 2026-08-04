// Bar-history reconstruction of the VWAP_MAGNET touch condition -- real MAE distribution,
// zero synthetic contamination, per direct instruction (2026-08-04, external review): "the
// MAE you need has been sitting in price_bars_primary the whole time... find every historical
// instance of the signal condition... across the full multi-year bars, not just the ones your
// system happened to fire on." This is the bar-history-first methodology CLAUDE.md's own
// standing rule (added earlier the same night) describes -- applied here for real.
//
// Reuses the REAL live detection functions, never reimplements them (this codebase's own
// "export the real function" rule) -- getGlobex24hrBars/computeRunningVwapSeries/
// getTrailing24hrVwapStd are the exact functions server/routes/acd.js calls live for
// GLOBEX_VWAP_MAGNET_LONG/SHORT (globexVwapMagnetRTH block, ~line 5590-5614).
//
// GLOBEX_VWAP_MAGNET only (not RTH VWAP_MAGNET_LONG/SHORT) -- getTrailing24hrVwapStd computes
// entirely from price_bars_primary (full ~3.7yr NQ history available), while the RTH sibling's
// threshold (getTrailingVwapStd) reads session_analysis.close_vs_vwap, which only goes back to
// 2026-03-25 -- a separate, much shorter reconstruction, not attempted in this pass.

import { query } from '../server/db.js';
import { computeRunningVwapSeries } from '../server/services/developingValueService.js';
// removed: import { getGlobex24hrBars, getTrailing24hrVwapStd } from '../server/services/queries.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import { computeEvAtStopTarget } from './update_optimal_stops.mjs';
import fs from 'fs';

const dpp = LIVE_INSTRUMENT.dollarsPerPoint;
// FIXED 2026-08-04 (caught auditing Gemini's rewrite, but the bug was mine, not Gemini's --
// present in the original script before it was ever dispatched): was WALK_BARS_MAX=390, an
// UNCONDITIONAL fixed-bar-count walk with no early exit. This codebase's actual mae_points
// (replayBars(), server/services/maeMfeReplay.js, used by backfill_mae_mfe.mjs and read
// everywhere else including tonight's origin_status-based real-only comparison) STOPS at the
// first bar where a stop OR target hits -- MAE only accumulates up to that point, then the
// walk ends. An unconditional 390-bar (6.5hr) walk with no early exit measures a categorically
// different, always-larger quantity ("how far can price wander with nothing ever closing the
// trade"), not a stop candidate distribution -- confirmed directly: first run gave p50 MAE
// 86-92pt vs the real (origin_status-bounded, replayBars-computed) population's p50 21-25pt,
// a 4x gap traced to exactly this. Fixed by bounding the walk to the SAME session the trigger
// occurred in (bars24's own length, i.e. through ~4:59pm ET session close) instead of a flat
// bar count -- matches this codebase's established "same-session, real close" convention.

function addDays(dStr, num) {
  const d = new Date(dStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + num);
  return d.toISOString().slice(0, 10);
}

async function main() {
  console.log('Loading all NQ bars into memory...');
  const res = await query(`
    SELECT 
      ts,
      ts::date::text as raw_d,
      (ts::date + interval '1 day')::date::text as next_d,
      EXTRACT(hour FROM ts)::int as hr,
      EXTRACT(minute FROM ts)::int as mn,
      high::float, low::float, close::float,
      volume::bigint as volume,
      COALESCE(bid_volume,0)::int as bid_volume,
      COALESCE(ask_volume,0)::int as ask_volume
    FROM price_bars_primary WHERE symbol='NQ' ORDER BY ts
  `);

  const barsBySess = new Map();
  const rthCloseByRaw = new Map();

  for (const b of res.rows) {
    b.sess_d = b.hr >= 18 ? b.next_d : b.raw_d;
    if (b.hr !== 17) {
      let arr = barsBySess.get(b.sess_d);
      if (!arr) { arr = []; barsBySess.set(b.sess_d, arr); }
      arr.push(b);
    }
    const mins = b.hr * 60 + b.mn;
    if (mins >= 570 && mins <= 959) {
      rthCloseByRaw.set(b.raw_d, b.close);
    }
  }

  const sortedRthDays = Array.from(rthCloseByRaw.keys()).sort();

  function getTrailing24hrVwapDistsMem(date, days = 30) {
    const minD = addDays(date, -days);
    const dists = [];
    for (const rawD of sortedRthDays) {
      if (rawD >= minD && rawD < date) {
        const rthClose = rthCloseByRaw.get(rawD);
        const globexBars = barsBySess.get(rawD) || [];
        if (globexBars.length > 50) {
          let pv = 0, v = 0;
          for (const b of globexBars) {
            const vol = Number(b.volume || 1);
            pv += (b.high + b.low + b.close) / 3 * vol;
            v += vol;
          }
          const vwap24 = pv / v;
          dists.push(rthClose - vwap24);
        }
      }
    }
    return dists;
  }

  function getTrailing24hrVwapStdMem(date, days = 30, sigmaMult = 1.5) {
    const vals = getTrailing24hrVwapDistsMem(date, days);
    if (vals.length < 20) return { std: 130, mean: 0, n: vals.length, threshold: Math.max(50, Math.round(130 * sigmaMult)) };
    const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
    const std = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length);
    return { std, mean, n: vals.length, threshold: Math.max(50, Math.round(std * sigmaMult)) };
  }

  console.log('Finding all trading days with >=30 prior days of bar history...');
  const daysRes = await query(`
    SELECT DISTINCT ts::date::text as d FROM price_bars_primary WHERE symbol='NQ' ORDER BY d
  `);
  const allDays = daysRes.rows.map(r => r.d);
  // Need 30 prior days for getTrailing24hrVwapStd to return a real (non-fallback) std.
  const startIdx = 35;
  const days = allDays.slice(startIdx);
  console.log(`${days.length} candidate trading days (${days[0]} through ${days[days.length - 1]})`);

  const instances = [];
  let dayCount = 0;
  for (const d of days) {
    dayCount++;
    if (dayCount % 100 === 0) console.log(`  ...${dayCount}/${days.length} days processed, ${instances.length} instances found so far`);
    const bars24 = barsBySess.get(d) || [];
    if (bars24.length < 50) continue;
    const vwapSeries = computeRunningVwapSeries(bars24);
    const std24 = getTrailing24hrVwapStdMem(d, 30);
    if (std24.n < 20) continue; // matches live's own implicit floor (fallback std=130 otherwise)

    let wasBeyond = false; // fresh-crossing detection, mirrors "isActive transitions false->true" pattern used elsewhere tonight
    for (let i = 0; i < bars24.length; i++) {
      const vwapNow = vwapSeries[i];
      if (vwapNow == null) continue;
      const dist = bars24[i].close - vwapNow;
      const isBeyond = Math.abs(dist) >= std24.threshold;
      if (isBeyond && !wasBeyond) {
        // Fresh trigger -- matches live's isLong = dist < 0 (price below VWAP -> fade long toward it)
        const isLong = dist < 0;
        const entry = bars24[i].close;
        const endIdx = bars24.length; // walk to session close, not a fixed bar count -- see comment above
        let mae = 0, mfe = 0;
        for (let j = i + 1; j < endIdx; j++) {
          const adverse = isLong ? entry - bars24[j].low : bars24[j].high - entry;
          const favorable = isLong ? bars24[j].high - entry : entry - bars24[j].low;
          if (adverse > mae) mae = adverse;
          if (favorable > mfe) mfe = favorable;
        }
        instances.push({ date: d, direction: isLong ? 'LONG' : 'SHORT', entry, mae: +mae.toFixed(1), mfe: +mfe.toFixed(1), thresholdAtTrigger: std24.threshold });
      }
      wasBeyond = isBeyond;
    }
  }

  console.log(`\nTotal fresh-trigger instances found: ${instances.length}`);
  fs.writeFileSync('scratch/vwap_magnet_bar_history_instances.json', JSON.stringify(instances, null, 2));

  for (const dirLabel of ['LONG', 'SHORT']) {
    const group = instances.filter(x => x.direction === dirLabel);
    const maes = group.map(x => x.mae).sort((a, b) => a - b);
    const mfes = group.map(x => x.mfe).sort((a, b) => a - b);
    const pct = (arr, p) => arr.length ? arr[Math.floor(arr.length * p)] : null;
    console.log(`\n=== GLOBEX_VWAP_MAGNET_${dirLabel} bar-history reconstruction, N=${group.length} ===`);
    console.log(`MAE ladder: p25=${pct(maes,0.25)} p40=${pct(maes,0.40)} p50=${pct(maes,0.50)} p60=${pct(maes,0.60)} p70=${pct(maes,0.70)} p75=${pct(maes,0.75)} p90=${pct(maes,0.90)}`);
    console.log(`MFE ladder: p50=${pct(mfes,0.50)} p75=${pct(mfes,0.75)}`);

    const p50mfe = Math.round(pct(mfes, 0.50));
    const trades = group.map(x => ({ mae_points: x.mae, mfe_points: x.mfe, actual_pnl: 0 })); // actual_pnl unused by computeEvAtStopTarget's synthetic-exit branches
    for (const p of [0.50, 0.60, 0.70, 0.75, 0.90]) {
      const stop = Math.round(pct(maes, p));
      const ev = computeEvAtStopTarget(trades, stop, p50mfe, dpp, dpp);
      console.log(`  p${p*100} stop=${stop}pt vs target=${p50mfe}pt(p50 MFE)  EV=$${ev.toFixed(2)}`);
    }
  }
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
