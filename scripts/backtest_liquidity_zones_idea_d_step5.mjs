// Idea D full build (docs/LIQUIDITY_ZONES_DEFENDED_LEVELS_SPEC.md, Step 5, section 3.4/section 2
// "Idea D"). Extends the now-validated rigorous Step 0 census (scratch/census_idea_d_cluster_freshness.mjs,
// RESEARCH_CLAIM liquidity_zones_idea_d_free_census_rigorous_construction, CONFIRMED N=20/90%) with:
//   - clusterFreshFrac = clusterFreshCount / confluenceCount, per the spec's construction (section 2,
//     "Idea D"), reusing the exact same anchor/partner freshness reconstruction as the validated census.
//   - clusterMaxAccepted = max(acceptedTimeFrac) across cluster members, reusing idea C's exact formula
//     from scratch/pilot_liquidity_zones_idea_c_a.mjs lines 311-346 verbatim (not reinvented), applied
//     per member instead of anchor-only.
// Control per the spec: 2x2 of confluenceCount bucket x clusterFreshFrac bucket, restricted to
// minutesSinceVisit===null anchors (already true of this population by construction).
//
// KNOWN LANDMINE (found + fixed 2026-09-01 in scripts/pilot_idea_d.mjs, documented in
// docs/LIQUIDITY_ZONES_DEFENDED_LEVELS_SPEC.md sec 4.23): never mix a bare $N parameter with an
// explicit $N::date cast on the SAME parameter in one query -- Postgres unifies the parameter's type
// across all its appearances, silently truncating the bare usage to midnight. This script uses two
// separate parameters for date-boundary vs timestamp comparisons throughout.

import pool from '../server/db.js';
import { directionFromType } from '../server/services/maeMfeReplay.js';
import { recordClaim } from './record_claim.mjs';

const SAME_DAY_FORMING_MINUTE = {
  OR5_HIGH: 575, OR5_LOW: 575, OR5_MID: 575,
  OR10_HIGH: 580, OR10_LOW: 580, OR10_MID: 580,
  OR30_HIGH: 600, OR30_LOW: 600, OR30_MID: 600,
  IB_HIGH: 630, IB_LOW: 630, IB_MID: 630,
};

function etMinutesOfDay(firedAtNaive) {
  const hour = parseInt(firedAtNaive.slice(11, 13), 10);
  const min = parseInt(firedAtNaive.slice(14, 16), 10);
  return hour * 60 + min;
}

function getLevelNameFromSetup(setupType) {
  let stripped = setupType
    .replace(/_FADE_LONG/g, '')
    .replace(/_FADE_SHORT/g, '')
    .replace(/_FADE/g, '')
    .replace(/_TRAIL/g, '')
    .replace(/_GAP_UP/g, '')
    .replace(/_GAP_DOWN/g, '')
    .replace(/_OVERNIGHT/g, '');
  if (stripped === 'IB_MID_SCALP') return 'IB_MID';
  return stripped;
}

function getSessionStartString(trade_date_str, setup_type, fired_at_naive) {
  const hour = parseInt(fired_at_naive.slice(11, 13), 10);
  let isRth;
  if (setup_type.includes('_OVERNIGHT') || setup_type.includes('GLOBEX_VWAP') || setup_type.includes('ONH') || setup_type.includes('ONL')) {
    isRth = false;
  } else if (setup_type.includes('RTH') || setup_type.includes('OR5') || setup_type.includes('OR10') || setup_type.includes('OR30') || setup_type.includes('IB_')) {
    isRth = true;
  } else {
    isRth = (hour >= 9 && hour < 16);
  }
  if (isRth) return trade_date_str + ' 09:30:00';
  const d = new Date(trade_date_str + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10) + ' 18:00:00';
}

async function loadLevels() {
  const res = await pool.query(`
    SELECT trade_date::text as trade_date, level_name, price::float
    FROM level_prices ORDER BY trade_date ASC
  `);
  const levelsByDate = {};
  let currentTradeDate = null, latestLevels = {};
  for (const row of res.rows) {
    if (row.trade_date !== currentTradeDate) {
      if (currentTradeDate !== null) levelsByDate[currentTradeDate] = { ...latestLevels };
      currentTradeDate = row.trade_date;
    }
    latestLevels[row.level_name] = row.price;
  }
  if (currentTradeDate !== null) levelsByDate[currentTradeDate] = { ...latestLevels };

  const allCalendarDates = await pool.query(`SELECT DISTINCT trade_date::text as d FROM level_prices ORDER BY d ASC`);
  const denseLevelMap = {}; let runningLevels = {}; const checkpointDates = [];
  for (const row of allCalendarDates.rows) {
    const d = row.d;
    if (levelsByDate[d]) runningLevels = { ...runningLevels, ...levelsByDate[d] };
    denseLevelMap[d] = { ...runningLevels };
    checkpointDates.push(d);
  }
  const getLevelsForDate = (td) => {
    let lo = 0, hi = checkpointDates.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (checkpointDates[mid] <= td) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return best === -1 ? null : denseLevelMap[checkpointDates[best]];
  };
  return { getLevelsForDate };
}

// Idea C, verbatim formula (pilot_liquidity_zones_idea_c_a.mjs:311-346), generalized to any member
// level (not just the anchor).
function computeAcceptedTimeFrac(sessionBars, levelPrice, direction) {
  if (sessionBars.length === 0) return null;
  let acceptedBars = 0;
  for (const b of sessionBars) {
    if (direction === 'LONG') {
      if (b.close < levelPrice) acceptedBars++;
    } else {
      if (b.close > levelPrice) acceptedBars++;
    }
  }
  return acceptedBars / sessionBars.length;
}

async function main() {
  console.log('Loading levels...');
  const { getLevelsForDate } = await loadLevels();

  // NOTE: fired_at is deliberately NOT cast to ::text here -- node-pg's native parsing of a raw
  // `timestamp without time zone` column round-trips through new Date(...).toISOString() UNCHANGED
  // (verified directly: DB value '2026-08-19 10:53:00' -> Date -> toISOString() = the same
  // '2026-08-19T10:53:00.000Z', no shift). Casting to ::text and re-parsing that STRING via
  // `new Date(str)` instead hits a DIFFERENT, real bug than the one documented in the file header:
  // a non-ISO space-separated string gets parsed by V8 as LOCAL time (this process's TZ,
  // America/New_York), while node-pg's own timestamp parsing treats the naive value as UTC-labeled
  // -- the two disagree by the ET/UTC offset. Found live during this script's own first run (row
  // 99970: fired_at '10:53:00' round-tripped through ::text + new Date(str) as '14:53:00', a 4hr
  // shift that silently widened every bar-window query and inflated anchorAlreadyVisited from
  // 563->581 vs the validated census script). Keep fired_at as the raw Date object end to end.
  const query = `
    SELECT id, setup_type, trade_date::text as trade_date_str, fired_at,
           confluence_score_at_detection, confluence_levels_at_detection,
           resolution, actual_pnl::float as actual_pnl
    FROM active_setups
    WHERE origin_status IN ('ACTIVE','SHADOW')
      AND confluence_score_at_detection >= 2
      AND confluence_levels_at_detection IS NOT NULL
      AND fired_at IS NOT NULL
  `;
  const { rows } = await pool.query(query);
  console.log(`Found ${rows.length} raw rows.`);

  const results = [];
  let dropReasons = { noPartners: 0, noPricesForDate: 0, noAnchorPrice: 0, anchorNotFormed: 0, anchorAlreadyVisited: 0, allPartnersWithoutPrice: 0 };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const anchorName = getLevelNameFromSetup(row.setup_type);
    const direction = directionFromType(row.setup_type);

    let partners = (row.confluence_levels_at_detection || []).filter(p => p !== anchorName);
    if (partners.length === 0) { dropReasons.noPartners++; continue; }

    const levelsForDate = getLevelsForDate(row.trade_date_str);
    if (!levelsForDate) { dropReasons.noPricesForDate++; continue; }

    const anchorPrice = levelsForDate[anchorName];
    if (anchorPrice === undefined) { dropReasons.noAnchorPrice++; continue; }

    const flooredFiredAt = new Date(row.fired_at);
    flooredFiredAt.setSeconds(0, 0);
    const firedAtNaive = flooredFiredAt.toISOString().slice(0, 19).replace('T', ' ');
    const firedAtMin = etMinutesOfDay(firedAtNaive);
    const sessionStartNaive = getSessionStartString(row.trade_date_str, row.setup_type, firedAtNaive);

    const anchorFormationMin = SAME_DAY_FORMING_MINUTE[anchorName];
    if (anchorFormationMin !== undefined && firedAtMin < anchorFormationMin) { dropReasons.anchorNotFormed++; continue; }

    let partnerObjects = [];
    for (const p of partners) {
      const price = levelsForDate[p];
      if (price === undefined) continue;
      const formationMin = SAME_DAY_FORMING_MINUTE[p];
      const gated = formationMin !== undefined && firedAtMin < formationMin;
      partnerObjects.push({ name: p, price, gated });
    }
    if (partnerObjects.length === 0) { dropReasons.allPartnersWithoutPrice++; continue; }

    // Two separate params: $1 bare timestamp, $2 date boundary -- never mix a cast/bare use of the
    // same param (2026-09-01 landmine, see file header).
    const barRes = await pool.query(`
      SELECT close::float, ts::text
      FROM price_bars_primary
      WHERE symbol='NQ' AND ts >= $1::timestamp AND ts < $2::timestamp
      ORDER BY ts ASC
    `, [sessionStartNaive, firedAtNaive]);
    const sessionBars = barRes.rows;

    let anchorVisited = false;
    for (const bar of sessionBars) {
      if (Math.abs(bar.close - anchorPrice) <= 10) { anchorVisited = true; break; }
    }
    if (anchorVisited) { dropReasons.anchorAlreadyVisited++; continue; }

    // clusterFreshFrac construction (spec section 2, Idea D)
    const nonGatedPartners = partnerObjects.filter(p => !p.gated);
    let freshCount = 1; // the anchor itself, always fresh by construction of this population
    let visitedPartners = [];
    for (const p of nonGatedPartners) {
      let visited = false;
      for (const bar of sessionBars) {
        if (Math.abs(bar.close - p.price) <= 10) { visited = true; break; }
      }
      if (visited) visitedPartners.push(p); else freshCount++;
    }
    const confluenceCount = 1 + nonGatedPartners.length; // anchor + formed, price-known partners
    const clusterFreshFrac = confluenceCount > 0 ? freshCount / confluenceCount : null;

    // clusterMaxAccepted (idea C applied per cluster member, anchor + all non-gated partners)
    const allMemberPrices = [anchorPrice, ...nonGatedPartners.map(p => p.price)];
    let clusterMaxAccepted = null;
    for (const lp of allMemberPrices) {
      const frac = computeAcceptedTimeFrac(sessionBars, lp, direction);
      if (frac !== null && (clusterMaxAccepted === null || frac > clusterMaxAccepted)) clusterMaxAccepted = frac;
    }

    results.push({
      id: row.id,
      setup_type: row.setup_type,
      trade_date: row.trade_date_str,
      confluenceCount,
      clusterFreshFrac,
      clusterMaxAccepted,
      hadVisitedPartner: visitedPartners.length > 0,
      resolution: row.resolution,
      actual_pnl: row.actual_pnl,
    });
  }

  console.log('Drop reasons:', dropReasons);
  console.log(`Fresh-anchor population: ${results.length}`);

  const withPnl = results.filter(r => r.actual_pnl !== null && ['STOP_HIT', 'TARGET_HIT'].includes(r.resolution));
  console.log(`Of those, resolved with real actual_pnl: ${withPnl.length}`);

  console.log('\nFull population (for inspection):');
  for (const r of results) {
    console.log(`  ${r.trade_date} ${r.setup_type} confl=${r.confluenceCount} freshFrac=${r.clusterFreshFrac?.toFixed(2)} maxAccepted=${r.clusterMaxAccepted?.toFixed(2)} visitedPartner=${r.hadVisitedPartner} resolution=${r.resolution} pnl=${r.actual_pnl}`);
  }

  // 2x2 control: confluenceCount bucket (2 vs 3+) x clusterFreshFrac bucket (median split),
  // restricted to rows with real P&L.
  if (withPnl.length >= 8) {
    const freshFracs = withPnl.map(r => r.clusterFreshFrac).filter(f => f !== null).sort((a, b) => a - b);
    const median = freshFracs[Math.floor(freshFracs.length / 2)];
    const buckets = { '2_low': [], '2_high': [], '3plus_low': [], '3plus_high': [] };
    for (const r of withPnl) {
      if (r.clusterFreshFrac === null) continue;
      const confBucket = r.confluenceCount >= 3 ? '3plus' : '2';
      const freshBucket = r.clusterFreshFrac <= median ? 'low' : 'high';
      buckets[`${confBucket}_${freshBucket}`].push(r);
    }
    console.log('\n2x2 control (confluenceCount x clusterFreshFrac, median split at', median, '):');
    for (const [k, v] of Object.entries(buckets)) {
      const wins = v.filter(r => r.actual_pnl > 0).length;
      const ev = v.length > 0 ? v.reduce((s, r) => s + r.actual_pnl, 0) / v.length : null;
      console.log(`  ${k}: N=${v.length} WR=${v.length ? (wins / v.length * 100).toFixed(1) + '%' : 'n/a'} EV=${ev !== null ? '$' + ev.toFixed(2) : 'n/a'}`);
    }
  } else {
    console.log('\nToo thin for a 2x2 EV/WR split (N<8 with real P&L). Reporting descriptive numbers only.');
  }

  const rigorStatus = withPnl.length >= 20 ? 'n20_floor_cleared' : 'below_n20_floor_directional_only';
  await recordClaim({
    slug: 'liquidity_zones_idea_d_step5_full_build',
    claimText: `Idea D Step 5 full build (docs/LIQUIDITY_ZONES_DEFENDED_LEVELS_SPEC.md section 3.4/section 2): extended the validated rigorous Step 0 census (RESEARCH_CLAIM liquidity_zones_idea_d_free_census_rigorous_construction) with clusterFreshFrac and clusterMaxAccepted (idea C acceptedTimeFrac applied per cluster member, not just the anchor). Fresh-anchor population: ${results.length} (of ${rows.length} raw confluence>=2 rows). Of those, ${withPnl.length} have a real resolved actual_pnl (STOP_HIT/TARGET_HIT) usable for an EV/WR comparison. ${withPnl.length < 20 ? 'This is below this codebase N>=20 decisive floor for an EV comparison -- the descriptive census (N=20) does not translate into a decisive EV-tested population, because most fresh-anchor confluence touches either never resolve with a clean STOP_HIT/TARGET_HIT or the population itself is simply too young. Recommend a SHADOW-tagging-first path (persist clusterFreshFrac/clusterMaxAccepted at detection time going forward, informational only) to accumulate real N, matching this codebase existing convention (e.g. regime_pos_Nd, confluence_score_at_detection) rather than forcing a live wire on a sub-N20 population.' : 'See the 2x2 control breakdown in scripts/backtest_liquidity_zones_idea_d_step5.mjs output for per-bucket WR/EV.'}`,
    sourceFile: 'scripts/backtest_liquidity_zones_idea_d_step5.mjs',
    sourceDate: '2026-09-01',
    sampleSize: withPnl.length,
    rigorStatus,
    status: 'PROVISIONAL',
  });

  console.log('\nDone.');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
