// =============================================================================
// PILOT — 21-bar MA trail, ARMED only once the original fixed target is reached
// (follow-up to pilot_ma21_trail_no_target.mjs, which found an instant-exit
// artifact: a fade entry is often already on the "wrong side" of a
// pre-existing-trend MA right at entry, so an unconditional MA stop mostly just
// re-tested "exit immediately if the trend hasn't turned," not "let a winner
// run further" -- avg bars held was ~2 for 4 of 6 setups.)
//
// This version keeps the REAL, already-recorded outcome for every trade that
// never reached its original target (STOP_HIT / TIME_EXPIRED trades are
// untouched -- nothing about the entry or initial risk changes). Only
// TARGET_HIT trades are re-simulated: once price reaches the ORIGINAL t1_level
// (found by re-walking bars from entry, matching resolve()'s own stop/target
// check order), the fixed-target exit is replaced with "keep riding, exit only
// when price crosses back through the trailing 21-bar MA" -- directly testing
// whether the "money left on the table after target hits" (found earlier,
// 7-15pt per setup) is capturable this way.
// =============================================================================

import { query } from '../server/db.js';
import { directionFromType } from '../server/services/maeMfeReplay.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';

const PNL_PER_POINT = 2, COMMISSION = 1;
const MA_PERIOD = 21;
const RTH_END = 960;
const SETUP_TYPES = ['IB_BULLISH', 'IB_BEARISH', 'PD_VAH_FADE_SHORT', 'PD_VAL_FADE_LONG', 'PD_POC_FADE_SHORT', 'PD_POC_FADE_LONG'];

async function main() {
  const results = [];

  for (const setupType of SETUP_TYPES) {
    const direction = directionFromType(setupType);
    const isLong = direction === 'LONG';
    const setupsRes = await query(`
      SELECT id, trade_date::text as trade_date, fired_at, entry_zone_low::float as entry,
             stop_level::float as stop, t1_level::float as target, resolution, actual_pnl::float as orig_pnl
      FROM active_setups
      WHERE setup_type = $1 AND resolution IN ('TARGET_HIT','STOP_HIT') AND actual_pnl IS NOT NULL
        AND entry_zone_low IS NOT NULL AND stop_level IS NOT NULL AND t1_level IS NOT NULL
        AND mae_points IS NOT NULL AND mfe_points IS NOT NULL AND mae_points <= 300 AND mfe_points <= 300
      ORDER BY trade_date, fired_at
    `, [setupType]);
    const setups = setupsRes.rows;
    if (!setups.length) { console.log(`${setupType}: 0 eligible rows`); continue; }

    const byDate = new Map();
    for (const s of setups) {
      if (!byDate.has(s.trade_date)) byDate.set(s.trade_date, []);
      byDate.get(s.trade_date).push(s);
    }

    const trades = [];
    for (const [date, dateSetups] of byDate) {
      const barsRes = await query(`
        SELECT ts, EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts)::int as tod,
          high::float, low::float, close::float
        FROM price_bars_primary WHERE symbol='NQ' AND ts::date = $1 ORDER BY ts
      `, [date]);
      const bars = barsRes.rows;
      if (bars.length < MA_PERIOD + 1) continue;

      for (const s of dateSetups) {
        let entryIdx = -1;
        for (let i = bars.length - 1; i >= 0; i--) {
          if (bars[i].ts <= s.fired_at) { entryIdx = i; break; }
        }
        if (entryIdx < MA_PERIOD) continue;

        // STOP_HIT trades: untouched, keep the real recorded outcome -- nothing
        // about the path to a stop changes in this variant.
        if (s.resolution === 'STOP_HIT') {
          trades.push({ date, pnl: s.orig_pnl, armed: false, replaced: false });
          continue;
        }

        // TARGET_HIT trades: re-walk from entry to find the ORIGINAL target-hit
        // bar (matching resolve()'s stop-before-target-on-same-bar convention),
        // then switch to MA-only trailing from that point forward.
        let targetHitIdx = null;
        for (let i = entryIdx + 1; i < bars.length; i++) {
          if (bars[i].tod >= RTH_END) break;
          const stopHit = isLong ? bars[i].low <= s.stop : bars[i].high >= s.stop;
          const targetHit = isLong ? bars[i].high >= s.target : bars[i].low <= s.target;
          if (stopHit && targetHit) { targetHitIdx = null; break; } // conservative: stop wins, shouldn't occur (was recorded TARGET_HIT)
          if (stopHit) { targetHitIdx = null; break; }
          if (targetHit) { targetHitIdx = i; break; }
        }
        if (targetHitIdx == null) {
          // Re-walk disagreed with the recorded resolution (shouldn't normally happen) -- keep real outcome, don't guess.
          trades.push({ date, pnl: s.orig_pnl, armed: false, replaced: false });
          continue;
        }

        // Armed: ride from targetHitIdx using ONLY the MA-cross as the exit, no fixed target/stop.
        let exitPrice = bars[targetHitIdx].close; // fallback if loop below never exits before RTH close
        for (let i = targetHitIdx + 1; i < bars.length; i++) {
          if (bars[i].tod >= RTH_END) { exitPrice = bars[i - 1].close; break; }
          const window = bars.slice(i - MA_PERIOD, i);
          const ma = window.reduce((s2, b) => s2 + b.close, 0) / window.length;
          const crossed = isLong ? bars[i].close < ma : bars[i].close > ma;
          if (crossed) { exitPrice = bars[i].close; break; }
          exitPrice = bars[i].close; // keep updating in case we hit RTH close without crossing
        }

        const pnlPts = isLong ? exitPrice - s.entry : s.entry - exitPrice;
        const pnl = pnlPts * PNL_PER_POINT - COMMISSION;
        trades.push({ date, pnl, origPnl: s.orig_pnl, armed: true, replaced: true });
      }
    }

    if (!trades.length) { console.log(`${setupType}: 0 walkable trades`); continue; }

    const n = trades.length;
    const wins = trades.filter(t => t.pnl > 0).length;
    const totalPnl = trades.reduce((a, t) => a + t.pnl, 0);
    const origTotalPnl = trades.reduce((a, t) => a + (t.replaced ? t.origPnl : t.pnl), 0);
    const armedTrades = trades.filter(t => t.replaced);
    const armedDelta = armedTrades.reduce((a, t) => a + (t.pnl - t.origPnl), 0);
    const rigor = n >= 20 ? computeRigor(trades, { dateField: 'date', pnlFn: t => t.pnl }) : null;

    results.push({
      setupType, n, ev: totalPnl / n, origEv: origTotalPnl / n,
      armedN: armedTrades.length, armedAvgDelta: armedTrades.length ? armedDelta / armedTrades.length : 0,
      wr: wins / n, rigor,
    });
  }

  console.log('\n=== 21-BAR MA TRAIL, ARMED ONLY AFTER ORIGINAL TARGET HIT ===\n');
  for (const r of results) {
    const rigorStr = r.rigor ? `stable=${r.rigor.stable} clean=${r.rigor.clean} clustered=${r.rigor.clustered}` : 'N<20';
    console.log(`${r.setupType.padEnd(20)} n=${String(r.n).padStart(4)} New-EV=$${r.ev.toFixed(2).padStart(8)} Orig-EV=$${r.origEv.toFixed(2).padStart(8)} WR=${(r.wr*100).toFixed(1)}%  | armed(target-hit) trades=${r.armedN}, avg extra $/trade among those=$${r.armedAvgDelta.toFixed(2)} | ${rigorStr}`);
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
