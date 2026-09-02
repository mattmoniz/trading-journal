// RTH counterpart to pilot_pd_level_fade_vwap_deviation_filter.mjs (2026-09-02), per CLAUDE.md's
// standing hard rule that any new finding must be evaluated for BOTH RTH and Globex before being
// considered complete -- and per direct user request ("wondering if we can use this rth too").
// Same hypothesis (does |price - VWAP| MAGNITUDE at entry predict a level-fade's outcome), same
// 3-independent-window methodology, same no-lookahead construction, same confound check -- but
// scoped to the broad RTH-native level-fade roster (is_rth=true) with an RTH-anchored VWAP
// (since 9:30am ET open) instead of the Globex-anchored one. Deliberately NOT PD_POC/VAH/VAL-only
// this time -- those setup_types DO fire during RTH too (93 real RTH fires found), but the
// bigger, RTH-native roster (IB_BEARISH/BULLISH, OR5 family, GLOBEX_VWAP_FADE, RTH_VWAP_FADE,
// FLOOR/CAM/PW families, etc.) is the real "does this generalize to RTH" test.

import { query } from '../server/db.js';
import { computeRunningVwapSeries } from '../server/services/developingValueService.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';

const isWin = (t) => t.resolution === 'TARGET_HIT' || (t.resolution === 'TRAIL_EXIT' && t.actual_pnl >= 0);

async function main() {
  const { rows: trades } = await query(`
    SELECT id, trade_date::text as trade_date, setup_type, fired_at::text as fired_at,
           entry_zone_low::float as entry, resolution, actual_pnl::float as actual_pnl
    FROM active_setups
    WHERE is_rth = true
      AND origin_status IN ('ACTIVE','SHADOW')
      AND resolution IN ('TARGET_HIT','STOP_HIT','TRAIL_EXIT')
      AND actual_pnl IS NOT NULL AND entry_zone_low IS NOT NULL
      AND (setup_type LIKE '%FADE%' OR setup_type LIKE 'IB_BEARISH%' OR setup_type LIKE 'IB_BULLISH%')
    ORDER BY fired_at
  `);
  console.log(`Loaded ${trades.length} decisive real RTH level-fade trades.`);
  console.log(`Distinct setup_types: ${new Set(trades.map(t => t.setup_type)).size}, distinct dates: ${new Set(trades.map(t => t.trade_date)).size}\n`);

  for (const t of trades) {
    const rthStart = t.trade_date + ' 09:30:00';
    const { rows: bars } = await query(`
      SELECT ts::text as ts, high::float, low::float, close::float,
             (COALESCE(bid_volume,0)+COALESCE(ask_volume,0))::float as volume
      FROM price_bars_primary
      WHERE symbol='NQ' AND ts >= $1 AND ts <= $2
      ORDER BY ts
    `, [rthStart, t.fired_at]);
    if (bars.length < 5) { t.skip = true; continue; }

    const sessionSeries = computeRunningVwapSeries(bars);
    t.devSession = t.entry - sessionSeries[sessionSeries.length - 1];

    const last60 = bars.slice(-60);
    const series60 = computeRunningVwapSeries(last60);
    t.dev60 = last60.length >= 5 ? t.entry - series60[series60.length - 1] : null;

    const last120 = bars.slice(-120);
    const series120 = computeRunningVwapSeries(last120);
    t.dev120 = last120.length >= 10 ? t.entry - series120[series120.length - 1] : null;

    const startMs = new Date(rthStart.replace(' ', 'T') + 'Z').getTime();
    const firedMs = new Date(t.fired_at.replace(' ', 'T') + 'Z').getTime();
    t.hoursSinceOpen = (firedMs - startMs) / 3600000;
  }
  const usable = trades.filter(t => !t.skip);
  console.log(`${usable.length} trades with enough bar history.\n`);

  function summarize(bucket, label) {
    if (bucket.length === 0) { console.log(`    ${label}: N=0`); return; }
    const wins = bucket.filter(isWin).length;
    const wr = (100 * wins / bucket.length).toFixed(1);
    const ev = (bucket.reduce((s, t) => s + t.actual_pnl, 0) / bucket.length).toFixed(2);
    let rigorStr = bucket.length >= 20
      ? (() => { const r = computeRigor(bucket, { dateField: 'trade_date', pnlFn: t => t.actual_pnl }); return ` | clean=${r?.clean} stable=${r?.stable} top5DayPct=${r?.top5DayPct}% distinctDates=${r?.distinctDates}`; })()
      : ' | N<20, THIN';
    console.log(`    ${label}: N=${bucket.length} WR=${wr}% EV=$${ev}/trade${rigorStr}`);
  }

  for (const [devKey, label] of [['devSession', 'RTH SESSION VWAP (since 9:30am)'], ['dev60', 'ROLLING 60-BAR VWAP'], ['dev120', 'ROLLING 120-BAR VWAP']]) {
    const withDev = usable.filter(t => t[devKey] != null);
    const sorted = [...withDev].sort((a, b) => Math.abs(a[devKey]) - Math.abs(b[devKey]));
    const n = sorted.length;
    const low = sorted.slice(0, Math.floor(n / 3));
    const mid = sorted.slice(Math.floor(n / 3), Math.floor(2 * n / 3));
    const high = sorted.slice(Math.floor(2 * n / 3));
    console.log(`=== ${label} (N=${n}) -- terciles by |deviation| ===`);
    summarize(low, `LOW |dev| (median ${Math.abs(low[Math.floor(low.length / 2)]?.[devKey] ?? 0).toFixed(1)}pt)`);
    summarize(mid, `MID |dev| (median ${Math.abs(mid[Math.floor(mid.length / 2)]?.[devKey] ?? 0).toFixed(1)}pt)`);
    summarize(high, `HIGH |dev| (median ${Math.abs(high[Math.floor(high.length / 2)]?.[devKey] ?? 0).toFixed(1)}pt)`);
    console.log('');
  }

  // Confound check: is HIGH deviation just a proxy for later-in-RTH-session?
  const withDevS = usable.filter(t => t.devSession != null);
  const sortedS = [...withDevS].sort((a, b) => Math.abs(a.devSession) - Math.abs(b.devSession));
  const nS = sortedS.length;
  const lowS = sortedS.slice(0, Math.floor(nS / 3)), midS = sortedS.slice(Math.floor(nS / 3), Math.floor(2 * nS / 3)), highS = sortedS.slice(Math.floor(2 * nS / 3));
  const avgHrs = (arr) => (arr.reduce((s, t) => s + t.hoursSinceOpen, 0) / arr.length).toFixed(2);
  console.log('=== Confound check: avg hoursSinceOpen by tercile (session VWAP) ===');
  console.log(`  LOW=${avgHrs(lowS)} MID=${avgHrs(midS)} HIGH=${avgHrs(highS)}`);
  const xs = withDevS.map(t => t.hoursSinceOpen), ys = withDevS.map(t => Math.abs(t.devSession));
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < xs.length; i++) { cov += (xs[i] - mx) * (ys[i] - my); vx += (xs[i] - mx) ** 2; vy += (ys[i] - my) ** 2; }
  console.log(`  correlation(hoursSinceOpen, |devSession|): ${(cov / Math.sqrt(vx * vy)).toFixed(3)}\n`);

  // Direction split, session VWAP only.
  console.log('=== RTH SESSION VWAP terciles, split by direction ===');
  const buckets = { LOW: lowS, MID: midS, HIGH: highS };
  for (const [bname, bucket] of Object.entries(buckets)) {
    console.log(`  ${bname}:`);
    summarize(bucket.filter(t => t.setup_type.includes('LONG')), 'LONG');
    summarize(bucket.filter(t => t.setup_type.includes('SHORT')), 'SHORT');
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
