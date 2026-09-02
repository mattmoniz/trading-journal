// Empirically tests DeepSeek's reversion-trap concern on pd_level_fade_vwap_deviation_magnitude_
// filter (2026-09-02 design critique, scratch/deepseek_response.md item #1): is a low-|dev-from-
// VWAP| touch a "coiled spring" (compressed state that precedes expansion), such that filtering
// it out would suppress the entries right before the best moves rather than the worst ones?
//
// User-added requirement: normalize any "expansion" measure against the session's OWN recent
// volatility, and keep Globex volatility/volume separate from RTH -- the two are not the same
// regime, so a raw point-based expansion number isn't comparable across them. Scoped to the
// Globex-only PD-level-fade population (matching the original finding, which didn't replicate
// to RTH per pilot_rth_level_fade_vwap_deviation_filter.mjs).
//
// Deliberately different from the original filter test's use of bars: forward bars (past the
// touch) are fetched here ONLY to diagnose what actually happened next, never to inform the
// original trade's own entry/eligibility -- this is a post-hoc empirical check, not a live
// signal computation, so looking forward from the touch is legitimate here.

import { query } from '../server/db.js';
import { computeRunningVwapSeries } from '../server/services/developingValueService.js';

const LEVELS = ['PD_POC', 'PD_VAH', 'PD_VAL'];

function globexSessionStart(tradeDate) {
  const d = new Date(tradeDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10) + ' 18:00:00';
}

function computeATR(bars) {
  // Simple average true range over the given bar slice -- same shape as
  // pilot_exits_extended.mjs's computeIntradayATR, Globex-session-scoped bars only (never
  // mixes in RTH bars, since bars passed in are always pre-filtered to one session).
  let sum = 0, count = 0;
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i], prev = bars[i - 1];
    const tr = Math.max(b.high - b.low, Math.abs(b.high - prev.close), Math.abs(b.low - prev.close));
    sum += tr; count++;
  }
  return count > 0 ? sum / count : null;
}

async function main() {
  const setupTypes = LEVELS.flatMap(l => [`${l}_FADE_LONG`, `${l}_FADE_SHORT`]);
  const { rows: trades } = await query(`
    SELECT id, trade_date::text as trade_date, setup_type, fired_at::text as fired_at,
           entry_zone_low::float as entry, resolution, actual_pnl::float as actual_pnl
    FROM active_setups
    WHERE setup_type = ANY($1)
      AND origin_status IN ('ACTIVE','SHADOW')
      AND resolution IN ('TARGET_HIT','STOP_HIT','TRAIL_EXIT')
      AND actual_pnl IS NOT NULL AND entry_zone_low IS NOT NULL
    ORDER BY fired_at
  `, [setupTypes]);

  for (const t of trades) {
    const sessStart = globexSessionStart(t.trade_date);
    // Fetch through touch + 20 bars (forward, diagnostic-only -- see header comment) but never
    // cross into the NEXT Globex session -- cap at 8:30am ET (mod 510) same as this codebase's
    // own Globex/overnight window definition, so the ATR/VWAP normalizer never mixes in RTH bars.
    const { rows: bars } = await query(`
      SELECT ts::text as ts, high::float, low::float, close::float,
             (COALESCE(bid_volume,0)+COALESCE(ask_volume,0))::float as volume,
             (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts))::int as mod
      FROM price_bars_primary
      WHERE symbol='NQ' AND ts >= $1 AND ts <= ($2::timestamp + INTERVAL '20 minutes')
        AND (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts)) NOT BETWEEN 510 AND 569
      ORDER BY ts
    `, [sessStart, t.fired_at]);
    const touchIdx = bars.findIndex(b => b.ts === t.fired_at) !== -1
      ? bars.findIndex(b => b.ts === t.fired_at)
      : bars.filter(b => b.ts <= t.fired_at).length - 1;
    if (touchIdx < 5 || touchIdx >= bars.length) { t.skip = true; continue; }

    const series = computeRunningVwapSeries(bars);
    t.devTouch = t.entry - series[touchIdx];

    // Session-own trailing ATR, last 30 bars ending at touch -- the normalizer, Globex-only.
    const atrWindow = bars.slice(Math.max(0, touchIdx - 30), touchIdx + 1);
    t.atr = computeATR(atrWindow);
    if (!t.atr || t.atr <= 0) { t.skip = true; continue; }

    for (const fwd of [5, 10, 20]) {
      const idx = touchIdx + fwd;
      if (idx < bars.length) {
        const devFwd = bars[idx].close - series[idx];
        t[`devAbsChange${fwd}`] = Math.abs(devFwd) - Math.abs(t.devTouch);
        t[`devAbsChange${fwd}Norm`] = t[`devAbsChange${fwd}`] / t.atr;
      }
    }
  }
  const usable = trades.filter(t => !t.skip);
  console.log(`${usable.length} usable trades (of ${trades.length}).\n`);

  // Terciles by |dev| at touch, same as the original filter test.
  const sorted = [...usable].sort((a, b) => Math.abs(a.devTouch) - Math.abs(b.devTouch));
  const n = sorted.length;
  const low = sorted.slice(0, Math.floor(n / 3));
  const mid = sorted.slice(Math.floor(n / 3), Math.floor(2 * n / 3));
  const high = sorted.slice(Math.floor(2 * n / 3));

  const isWin = (t) => t.resolution === 'TARGET_HIT' || (t.resolution === 'TRAIL_EXIT' && t.actual_pnl >= 0);

  function reportExpansion(bucket, label) {
    console.log(`--- ${label} (N=${bucket.length}) ---`);
    for (const fwd of [5, 10, 20]) {
      const withVal = bucket.filter(t => t[`devAbsChange${fwd}Norm`] != null);
      if (!withVal.length) continue;
      const avgRaw = withVal.reduce((s, t) => s + t[`devAbsChange${fwd}`], 0) / withVal.length;
      const avgNorm = withVal.reduce((s, t) => s + t[`devAbsChange${fwd}Norm`], 0) / withVal.length;
      const expandedFrac = withVal.filter(t => t[`devAbsChange${fwd}Norm`] > 0).length / withVal.length;
      console.log(`  t+${fwd}: avg |dev| change = ${avgRaw.toFixed(2)}pt (${avgNorm.toFixed(2)}x session ATR), ${(100 * expandedFrac).toFixed(0)}% of trades show net expansion`);
    }
  }

  console.log('=== Does |deviation from VWAP| actually EXPAND after the touch, by tercile? (ATR-normalized) ===');
  reportExpansion(low, 'LOW tercile (would be suppressed)');
  reportExpansion(mid, 'MID tercile');
  reportExpansion(high, 'HIGH tercile (already kept)');

  // DeepSeek test #3: does the coherent subset of LOW-tercile trades that DID show real
  // expansion (t+10) have meaningfully better real WR/EV than the ones that stayed compressed?
  // This is the direct test of whether the coiled-spring pattern, even if real, actually
  // translates into better outcomes for THIS system's real fixed-stop/target trades.
  console.log('\n=== Within LOW tercile: did trades that DID expand (t+10) actually perform better? ===');
  const lowWithT10 = low.filter(t => t.devAbsChange10Norm != null);
  const expanded = lowWithT10.filter(t => t.devAbsChange10Norm > 0.5); // expanded more than half an ATR
  const compressed = lowWithT10.filter(t => t.devAbsChange10Norm <= 0.5);
  for (const [label, bucket] of [['EXPANDED (>0.5x ATR)', expanded], ['STAYED COMPRESSED (<=0.5x ATR)', compressed]]) {
    if (!bucket.length) { console.log(`  ${label}: N=0`); continue; }
    const wr = 100 * bucket.filter(isWin).length / bucket.length;
    const ev = bucket.reduce((s, t) => s + t.actual_pnl, 0) / bucket.length;
    console.log(`  ${label}: N=${bucket.length} WR=${wr.toFixed(1)}% EV=$${ev.toFixed(2)}/trade`);
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
