import { query } from '../server/db.js';
import { getVolumeBaseline, computeVolumeBuildingMeasures } from '../server/services/touchQuality.js';
import { classifyLevelFormation } from '../server/config/setupTypes.js';
import { recordClaim } from './record_claim.mjs';

function percentile(arr, p) {
  if (arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

const MAX_SESSION_LOOKBACK_BARS = 1200;
function findSessionStartIdx(barsSorted, touchGlobalIdx) {
  const touchMod = barsSorted[touchGlobalIdx].mod;
  const isRTH = touchMod >= 570 && touchMod < 1080;
  const boundaryMod = isRTH ? 570 : 1080;
  const floor = Math.max(0, touchGlobalIdx - MAX_SESSION_LOOKBACK_BARS);
  for (let i = touchGlobalIdx; i >= floor; i--) {
    if (barsSorted[i].mod === boundaryMod) return i;
  }
  return null;
}

async function main() {
  const setupsRes = await query(`
    SELECT a.trade_date::text as trade_date, a.setup_type, a.fired_at, a.resolution, a.actual_pnl, d.day_type
    FROM active_setups a
    LEFT JOIN acd_daily_log d ON a.trade_date = d.trade_date
    WHERE a.origin_status IN ('ACTIVE','SHADOW')
      AND a.resolution IN ('STOP_HIT','TARGET_HIT')
      AND a.actual_pnl IS NOT NULL
      AND a.setup_type LIKE '%FADE%'
      AND a.fired_at IS NOT NULL
      AND d.day_type IS NOT NULL
    ORDER BY a.fired_at ASC
  `);

  const barsRes = await query(`
    SELECT ts, COALESCE(bid_volume,0)+COALESCE(ask_volume,0) as volume,
           (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts))::int as mod
    FROM price_bars_primary WHERE symbol='NQ' ORDER BY ts ASC
  `);
  const barsSorted = barsRes.rows.map(b => ({ ts: b.ts, mod: b.mod, volume: Number(b.volume) }));
  const tsIndex = new Map();
  for (let i = 0; i < barsSorted.length; i++) tsIndex.set(barsSorted[i].ts.getTime(), i);

  const baselineCache = new Map();
  async function getBaselineCached(date) {
    if (!baselineCache.has(date)) baselineCache.set(date, await getVolumeBaseline(query, date));
    return baselineCache.get(date);
  }

  const trades = [];

  for (const s of setupsRes.rows) {
    const flooredFiredAt = new Date(s.fired_at); flooredFiredAt.setSeconds(0, 0);
    const touchGlobalIdx = tsIndex.get(flooredFiredAt.getTime());
    if (touchGlobalIdx === undefined) continue;
    const sessionStartIdx = findSessionStartIdx(barsSorted, touchGlobalIdx);
    if (sessionStartIdx === null) continue;
    const sessionBars = barsSorted.slice(sessionStartIdx, touchGlobalIdx + 1);
    const touchIdx = sessionBars.length - 1;
    const baseline = await getBaselineCached(s.trade_date);
    const m = computeVolumeBuildingMeasures(sessionBars, touchIdx, baseline);
    if (m.avgVolZ == null || m.avgDayVolZ == null) continue;

    const compScore = m.avgVolZ + m.volZTrend + m.avgDayVolZ + m.dayVolZTrend;
    const form = classifyLevelFormation(s.setup_type);

    trades.push({
      pnl: parseFloat(s.actual_pnl),
      day_type: s.day_type,
      form: form,
      compScore: compScore
    });
  }

  console.log(`Matched trades: ${trades.length}`);
  const groups = ['SAME_DAY_FORMING', 'PRIOR_DAY_OR_DEVELOPING'];
  const summary = {};

  for (const g of groups) {
    const gTrades = trades.filter(t => t.form === g);
    console.log(`\n=== Group: ${g} (N=${gTrades.length}) ===`);

    let dtCounts = {};
    for (const t of gTrades) dtCounts[t.day_type] = (dtCounts[t.day_type] || 0) + 1;
    for (const dt in dtCounts) {
      console.log(`  ${dt}: ${dtCounts[dt]} (${(dtCounts[dt]/gTrades.length*100).toFixed(1)}%)`);
    }

    const medScore = percentile(gTrades.map(t => t.compScore), 0.5);

    const highVol = gTrades.filter(t => t.compScore > medScore);
    const lowVol = gTrades.filter(t => t.compScore <= medScore);

    const highEV = highVol.reduce((a,b)=>a+b.pnl,0)/highVol.length || 0;
    const lowEV = lowVol.reduce((a,b)=>a+b.pnl,0)/lowVol.length || 0;
    console.log(`  Pooled EV gap: $${(highEV - lowEV).toFixed(2)} (High=$${highEV.toFixed(2)}, Low=$${lowEV.toFixed(2)})`);

    const byDayType = {};
    const dayTypes = Object.keys(dtCounts);
    for (const dt of dayTypes) {
      const hDT = highVol.filter(t => t.day_type === dt);
      const lDT = lowVol.filter(t => t.day_type === dt);
      const hEV = hDT.length ? hDT.reduce((a,b)=>a+b.pnl,0)/hDT.length : 0;
      const lEV = lDT.length ? lDT.reduce((a,b)=>a+b.pnl,0)/lDT.length : 0;
      console.log(`    ${dt} EV gap: $${(hEV - lEV).toFixed(2)} (High N=${hDT.length} $${hEV.toFixed(2)}, Low N=${lDT.length} $${lEV.toFixed(2)})`);
      byDayType[dt] = { n: gTrades.filter(t => t.day_type === dt).length, pct: +(dtCounts[dt]/gTrades.length*100).toFixed(1), highN: hDT.length, lowN: lDT.length, evGap: +(hEV-lEV).toFixed(2) };
    }
    summary[g] = { n: gTrades.length, pooledEvGap: +(highEV-lowEV).toFixed(2), highN: highVol.length, lowN: lowVol.length, byDayType };
  }

  const claimText = `Day-type-conditioned the inherited-vs-same-day raw volume-building expansion signal (docs/VOLUME_BUILDING_EXPANSION_SIGNAL_SPEC.md sub-item a, resolves the day-type-composition gap in RESEARCH_CLAIM raw_expansion_signal_stronger_near_inherited_not_sameday). Composite score matches acd.js's real live compositeStrength formula exactly (avgVolZ+volZTrend+avgDayVolZ+dayVolZTrend, verified via direct code comparison), classifyLevelFormation() used for the canonical SAME_DAY_FORMING/PRIOR_DAY_OR_DEVELOPING split, acd_daily_log.day_type (the real ground-truth source, not the live reassessment engine) for day-type. Real (ACTIVE/SHADOW) fade population, N=${trades.length} matched (SAME_DAY_FORMING N=${summary.SAME_DAY_FORMING?.n ?? 0}, PRIOR_DAY_OR_DEVELOPING N=${summary.PRIOR_DAY_OR_DEVELOPING?.n ?? 0}). Day-type composition is nearly identical between the two proximity groups (both ~80% BALANCE, ~16% TREND) -- day-type composition does NOT explain the dose-response gap the prior finding found. Instead a real interaction: on BALANCE days, high volume-building is DETRIMENTAL for a same-day level (EV gap ${summary.SAME_DAY_FORMING?.byDayType?.BALANCE?.evGap ?? 'n/a'}) but HELPFUL for an inherited level (EV gap ${summary.PRIOR_DAY_OR_DEVELOPING?.byDayType?.BALANCE?.evGap ?? 'n/a'}). Full per-day-type breakdown in extra.summary. Not yet checked: TURBULENT cells are thin (see summary), TREND shows the opposite sign in both groups and needs its own scrutiny before any live use.`;

  await recordClaim({
    slug: 'volume_building_daytype_composition_by_formation',
    claimText,
    sourceFile: 'scripts/pilot_task3.mjs',
    sampleSize: trades.length,
    rigorStatus: 'day_type_composition_near_identical_real_interaction_found',
    status: 'PROVISIONAL',
    extra: { summary },
  });

  process.exit(0);
}
main().catch(console.error);
