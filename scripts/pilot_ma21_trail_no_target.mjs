// =============================================================================
// PILOT — 21-period (1-min bar) moving-average trailing stop, NO fixed target,
// on the 6 real setup_types just discussed (IB_BULLISH, IB_BEARISH,
// PD_VAH_FADE_SHORT, PD_VAL_FADE_LONG, PD_POC_FADE_SHORT, PD_POC_FADE_LONG).
// User request 2026-07-22, follow-up to the MFE "left on the table" finding --
// same real entries, same real fired_at/entry price, but the exit becomes purely
// "close crosses back through the trailing 21-bar MA," no stop, no target.
//
// Mechanics:
//   - MA = simple mean of the last 21 CLOSED bars' close price, recomputed every
//     bar as the trade develops (no lookahead -- MA at bar i only uses bars
//     strictly before i, i.e. the bars array up to and including i-1).
//   - LONG exits the first bar whose CLOSE < MA. SHORT exits the first bar whose
//     CLOSE > MA.
//   - No hard stop, no target -- this can carry more single-trade risk than the
//     original fixed stop; MAE (max adverse excursion before exit) is reported
//     explicitly, including the worst single trade, so that risk isn't hidden.
//   - Session-bound: exits are capped at RTH close (960 min) for RTH-origin
//     setups, matching every other backtest in this codebase's convention (no
//     open-ended overnight carry for RTH setups).
// =============================================================================

import { query } from '../server/db.js';
import { directionFromType } from '../server/services/maeMfeReplay.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';

const PNL_PER_POINT = 2, COMMISSION = 1;
const MA_PERIOD = 21;
const RTH_END = 960;
const SETUP_TYPES = ['IB_BULLISH', 'IB_BEARISH', 'PD_VAH_FADE_SHORT', 'PD_VAL_FADE_LONG', 'PD_POC_FADE_SHORT', 'PD_POC_FADE_LONG'];

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

async function main() {
  const results = [];

  for (const setupType of SETUP_TYPES) {
    const direction = directionFromType(setupType);
    const setupsRes = await query(`
      SELECT id, trade_date::text as trade_date, fired_at, entry_zone_low::float as entry,
             actual_pnl::float as orig_pnl, stop_level::float as orig_stop, t1_level::float as orig_target
      FROM active_setups
      WHERE setup_type = $1 AND resolution IN ('TARGET_HIT','STOP_HIT') AND actual_pnl IS NOT NULL
        AND entry_zone_low IS NOT NULL AND mae_points IS NOT NULL AND mfe_points IS NOT NULL
        AND mae_points <= 300 AND mfe_points <= 300
      ORDER BY trade_date, fired_at
    `, [setupType]);
    const setups = setupsRes.rows;
    if (!setups.length) { console.log(`${setupType}: 0 eligible rows, skipping`); continue; }

    const byDate = new Map();
    for (const s of setups) {
      if (!byDate.has(s.trade_date)) byDate.set(s.trade_date, []);
      byDate.get(s.trade_date).push(s);
    }

    const trades = [];
    for (const [date, dateSetups] of byDate) {
      const barsRes = await query(`
        SELECT ts, EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts)::int as tod, close::float
        FROM price_bars_primary WHERE symbol='NQ' AND ts::date = $1 ORDER BY ts
      `, [date]);
      const bars = barsRes.rows;
      if (bars.length < MA_PERIOD + 1) continue;

      for (const s of dateSetups) {
        // Locate entry bar index (last bar at or before fired_at).
        let entryIdx = -1;
        for (let i = bars.length - 1; i >= 0; i--) {
          if (bars[i].ts <= s.fired_at) { entryIdx = i; break; }
        }
        if (entryIdx < MA_PERIOD) continue; // need MA_PERIOD prior bars to seed the MA

        const isLong = direction === 'LONG';
        const entry = s.entry;
        let mae = 0, exitPrice = null, exitIdx = null, barsHeld = 0;

        for (let i = entryIdx + 1; i < bars.length; i++) {
          if (bars[i].tod >= RTH_END) { exitPrice = bars[i - 1]?.close ?? entry; exitIdx = i - 1; break; }
          // MA computed from the MA_PERIOD bars strictly before i (no lookahead into bar i itself).
          const window = bars.slice(i - MA_PERIOD, i);
          const ma = window.reduce((s2, b) => s2 + b.close, 0) / window.length;
          const adverse = isLong ? entry - bars[i].close : bars[i].close - entry;
          mae = Math.max(mae, adverse);
          const crossed = isLong ? bars[i].close < ma : bars[i].close > ma;
          if (crossed) { exitPrice = bars[i].close; exitIdx = i; barsHeld = i - entryIdx; break; }
        }
        if (exitPrice == null) { exitPrice = bars[bars.length - 1].close; exitIdx = bars.length - 1; barsHeld = exitIdx - entryIdx; }

        const pnlPts = isLong ? exitPrice - entry : entry - exitPrice;
        const pnl = pnlPts * PNL_PER_POINT - COMMISSION;
        trades.push({ date, pnl, maePts: mae, origPnl: s.orig_pnl, barsHeld });
      }
    }

    if (!trades.length) { console.log(`${setupType}: 0 walkable trades, skipping`); continue; }

    const n = trades.length;
    const wins = trades.filter(t => t.pnl > 0).length;
    const totalPnl = trades.reduce((a, t) => a + t.pnl, 0);
    const origTotalPnl = trades.reduce((a, t) => a + t.origPnl, 0);
    const maeSorted = [...trades.map(t => t.maePts)].sort((a, b) => a - b);
    const worstTrade = Math.min(...trades.map(t => t.pnl));
    const rigor = n >= 20 ? computeRigor(trades, { dateField: 'date', pnlFn: t => t.pnl }) : null;

    results.push({
      setupType, n, wr: wins / n, ev: totalPnl / n, origEv: origTotalPnl / n,
      maeP50: percentile(maeSorted, 0.5), maeP90: percentile(maeSorted, 0.9),
      worstTrade, avgBarsHeld: trades.reduce((a, t) => a + t.barsHeld, 0) / n,
      rigor,
    });
  }

  console.log('\n=== 21-BAR MA TRAIL, NO TARGET vs CURRENT FIXED STOP/TARGET ===\n');
  console.log('setup_type | N | MA-trail EV | Current EV | WR | MAE p50/p90 | Worst trade | Avg bars held | Rigor');
  for (const r of results) {
    const rigorStr = r.rigor ? `stable=${r.rigor.stable} clean=${r.rigor.clean} clustered=${r.rigor.clustered}` : 'N<20';
    console.log(`${r.setupType.padEnd(20)} n=${String(r.n).padStart(4)} MA-EV=$${r.ev.toFixed(2).padStart(8)} origEV=$${r.origEv.toFixed(2).padStart(8)} WR=${(r.wr*100).toFixed(1)}% MAE(p50/p90)=${r.maeP50.toFixed(1)}/${r.maeP90.toFixed(1)} worst=$${r.worstTrade.toFixed(2)} avgBars=${r.avgBarsHeld.toFixed(0)} ${rigorStr}`);
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
