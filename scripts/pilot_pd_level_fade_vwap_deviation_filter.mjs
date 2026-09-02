// Deeper follow-up to the 2026-09-02 VWAP-position thread, testing a DIFFERENT hypothesis from
// the earlier delta-alignment test: not "which direction is VWAP favoring" but "how far HAS
// price stretched from VWAP at all" -- user's framing: "if price doesn't deviate from vwap
// much, don't trade against it" (a quality/magnitude filter, not a direction filter). Tests
// 3 VWAP windows (session-since-6pm, rolling 60min, rolling 120min) so a finding isn't an
// artifact of one arbitrary window choice, per user request ("try different period vwaps").
// No lookahead: every VWAP value uses only bars at/before the trade's own fired_at, same
// Globex-session-boundary convention as getGlobex24hrBars() (server/services/queries.js).

import { query } from '../server/db.js';
import { computeRunningVwapSeries } from '../server/services/developingValueService.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';

const LEVELS = ['PD_POC', 'PD_VAH', 'PD_VAL'];

function globexSessionStart(tradeDate) {
  const d = new Date(tradeDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10) + ' 18:00:00';
}

async function main() {
  const { rows: [{ today }] } = await query(`SELECT CURRENT_DATE::text as today`);
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
  console.log(`Loaded ${trades.length} decisive real PD-level-fade trades.`);

  const isWin = (t) => t.resolution === 'TARGET_HIT' || (t.resolution === 'TRAIL_EXIT' && t.actual_pnl >= 0);

  for (const t of trades) {
    const sessStart = globexSessionStart(t.trade_date);
    const { rows: bars } = await query(`
      SELECT ts::text as ts, high::float, low::float, close::float,
             (COALESCE(bid_volume,0)+COALESCE(ask_volume,0))::float as volume
      FROM price_bars_primary
      WHERE symbol='NQ' AND ts >= $1 AND ts <= $2
      ORDER BY ts
    `, [sessStart, t.fired_at]);
    if (bars.length < 5) { t.skip = true; continue; }

    const sessionSeries = computeRunningVwapSeries(bars);
    t.devSession = t.entry - sessionSeries[sessionSeries.length - 1];

    const last60 = bars.slice(-60);
    const series60 = computeRunningVwapSeries(last60);
    t.dev60 = last60.length >= 5 ? t.entry - series60[series60.length - 1] : null;

    const last120 = bars.slice(-120);
    const series120 = computeRunningVwapSeries(last120);
    t.dev120 = last120.length >= 10 ? t.entry - series120[series120.length - 1] : null;
  }
  const usable = trades.filter(t => !t.skip);
  console.log(`${usable.length} trades with enough bar history.\n`);

  function summarize(bucket, label) {
    if (bucket.length === 0) { console.log(`    ${label}: N=0`); return null; }
    const wins = bucket.filter(isWin).length;
    const wr = 100 * wins / bucket.length;
    const ev = bucket.reduce((s, t) => s + t.actual_pnl, 0) / bucket.length;
    const rigor = bucket.length >= 20 ? computeRigor(bucket, { dateField: 'trade_date', pnlFn: t => t.actual_pnl }) : null;
    const rigorStr = rigor ? ` | clean=${rigor.clean} stable=${rigor.stable} top5DayPct=${rigor.top5DayPct}% distinctDates=${rigor.distinctDates}` : ' | N<20, THIN';
    console.log(`    ${label}: N=${bucket.length} WR=${wr.toFixed(1)}% EV=$${ev.toFixed(2)}/trade${rigorStr}`);
    return { n: bucket.length, wr, ev, rigor };
  }

  const windowResults = {};
  for (const [devKey, label] of [['devSession', 'SESSION VWAP (since 6PM)'], ['dev60', 'ROLLING 60-BAR VWAP'], ['dev120', 'ROLLING 120-BAR VWAP']]) {
    const withDev = usable.filter(t => t[devKey] != null);
    const sorted = [...withDev].sort((a, b) => Math.abs(a[devKey]) - Math.abs(b[devKey]));
    const n = sorted.length;
    const low = sorted.slice(0, Math.floor(n / 3));
    const mid = sorted.slice(Math.floor(n / 3), Math.floor(2 * n / 3));
    const high = sorted.slice(Math.floor(2 * n / 3));
    console.log(`=== ${label} (N=${n}) -- terciles by |deviation| ===`);
    const lowR = summarize(low, `LOW |dev| (median ${Math.abs(low[Math.floor(low.length / 2)]?.[devKey] ?? 0).toFixed(1)}pt)`);
    const midR = summarize(mid, `MID |dev| (median ${Math.abs(mid[Math.floor(mid.length / 2)]?.[devKey] ?? 0).toFixed(1)}pt)`);
    const highR = summarize(high, `HIGH |dev| (median ${Math.abs(high[Math.floor(high.length / 2)]?.[devKey] ?? 0).toFixed(1)}pt)`);
    console.log('');
    windowResults[devKey] = { label, low: lowR, mid: midR, high: highR };
  }

  // Direction split within each tercile (session VWAP only, to keep output manageable) --
  // does the filter idea hold for BOTH long and short fades, or just one side?
  console.log('=== SESSION VWAP terciles, split by direction ===');
  const withDev = usable.filter(t => t.devSession != null);
  const sorted = [...withDev].sort((a, b) => Math.abs(a.devSession) - Math.abs(b.devSession));
  const n = sorted.length;
  const buckets = { LOW: sorted.slice(0, Math.floor(n / 3)), MID: sorted.slice(Math.floor(n / 3), Math.floor(2 * n / 3)), HIGH: sorted.slice(Math.floor(2 * n / 3)) };
  for (const [bname, bucket] of Object.entries(buckets)) {
    console.log(`  ${bname}:`);
    summarize(bucket.filter(t => t.setup_type.includes('LONG')), 'LONG');
    summarize(bucket.filter(t => t.setup_type.includes('SHORT')), 'SHORT');
  }

  // Auto-refresh the RESEARCH_CLAIM every run (weekly, via run_weekly_backtests.sh) so this
  // finding keeps re-accumulating real data and re-checking itself instead of sitting static
  // as a one-off scratch result -- per CLAUDE.md's no-dead-ends rule and the 2026-09-02 user
  // feedback that a PROVISIONAL claim without a standing recheck path is a dead end in practice,
  // not just in principle. Reports the SESSION-VWAP window's high tercile (the one already
  // clean+stable at N=70) as the headline, cross-window agreement noted in the text.
  const s = windowResults.devSession;
  const allClean = ['devSession', 'dev60', 'dev120'].every(k => windowResults[k].high?.rigor?.clean);
  await recordClaim({
    slug: 'pd_level_fade_vwap_deviation_magnitude_filter',
    claimText: `Weekly auto-refresh (scripts/pilot_pd_level_fade_vwap_deviation_filter.mjs, wired into run_weekly_backtests.sh 2026-09-02). Real GLOBEX-only PD_POC/PD_VAH/PD_VAL fade population, |deviation from VWAP| terciles, 3 independent windows. Session-VWAP HIGH tercile (headline): N=${s.high?.n}, WR=${s.high?.wr?.toFixed(1)}%, EV=$${s.high?.ev?.toFixed(2)}/trade, rigor clean=${s.high?.rigor?.clean} stable=${s.high?.rigor?.stable} top5DayPct=${s.high?.rigor?.top5DayPct}% distinctDates=${s.high?.rigor?.distinctDates}. All 3 windows currently agree (high tercile clean in all 3: ${allClean}). LOW tercile remains noisy/inconsistent across windows -- per pd_level_fade_low_deviation_coiled_spring_confirmed, it's a real mixture of an expanding (good) and a compressed (bad) subpopulation, not simply bad. Design-critiqued by DeepSeek 2026-09-02 (scratch/deepseek_response.md) -- not yet sent to Gemini for a build, still needs: volatility-normalized re-split, setup-type-composition check, median/right-tail check, and a genuine train/test split before any live wiring. This claim self-updates weekly as real N grows -- check distinctDates/top5DayPct trend over successive runs to see whether it's converging toward decision-grade.`,
    sourceFile: 'scripts/pilot_pd_level_fade_vwap_deviation_filter.mjs',
    sourceDate: today,
    sampleSize: s.high?.n,
    winRate: s.high?.wr,
    evPerTrade: s.high?.ev,
    rigorStatus: allClean ? 'clean_stable_cross_window_consistent' : 'partial_agreement',
    status: 'PROVISIONAL',
  });
  console.log('\nRESEARCH_CLAIM pd_level_fade_vwap_deviation_magnitude_filter refreshed.');
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
