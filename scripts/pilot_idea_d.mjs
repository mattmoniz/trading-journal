import { query } from '../server/db.js';
import { recordClaim } from './record_claim.mjs';

async function main() {
  console.log("Loading trades for Idea D free census...");
  // FIXED (audit finding, 2026-09-01): fired_at was never cast to ::text here, so node-pg
  // returns it as a JS Date object -- passing that object BACK as a query parameter below
  // round-trips it through node-pg's own timestamptz serialization, which Postgres (session
  // TimeZone=America/New_York) then silently reinterprets, shifting the effective time-of-day
  // by the ET/UTC offset. This is exactly this codebase's own documented naive-timestamp
  // footgun. Cast to ::text here and use the text form in every downstream query instead.
  const res = await query(`
    SELECT id, trade_date::text as trade_date_str, fired_at::text as fired_at, setup_type, confluence_levels_at_detection,
           EXTRACT(hour FROM fired_at)*60 + EXTRACT(minute FROM fired_at) as fired_at_min,
           entry_zone_low, entry_zone_high
    FROM active_setups
    WHERE origin_status IN ('ACTIVE','SHADOW')
      AND setup_type LIKE '%_FADE_%'
      AND confluence_levels_at_detection IS NOT NULL
      AND array_length(confluence_levels_at_detection, 1) >= 2
  `);

  console.log(`Evaluating ${res.rows.length} confluence setups to find fresh anchors...`);

  let totalFired = 0;
  let partnersVisited = 0;

  for (let i = 0; i < res.rows.length; i++) {
    const trade = res.rows[i];
    if (i > 0 && i % 200 === 0) console.log(`Processed ${i}/${res.rows.length}...`);

    let levelsToFetch = trade.confluence_levels_at_detection.map(l => l.replace(/_FADE$/, ''));
    if (levelsToFetch.length === 0) continue;

    const lvRes = await query(`
      SELECT level_name, price::float
      FROM level_prices
      WHERE trade_date = $1
        AND level_name = ANY($2)
    `, [trade.trade_date_str, levelsToFetch]);

    if (lvRes.rows.length < 2) continue;
    
    const anchorPrice = (parseFloat(trade.entry_zone_low) + (trade.entry_zone_high !== null ? parseFloat(trade.entry_zone_high) : parseFloat(trade.entry_zone_low))) / 2;

    // FIXED (audit finding, 2026-09-01): the real live minutesSinceVisit (acd.js ~7945-7949)
    // only ever scans allRthBarsRow.rows -- SAME-CALENDAR-DAY RTH bars (9:30am ET through the
    // current moment) -- it structurally cannot see a visit from overnight or a prior day (a
    // documented convention in this codebase). The original version here scanned back to 6pm
    // the PRIOR evening, a much wider window than what "freshness" actually means live -- that
    // would materially undercount "fresh" anchors (a wider lookback finds more prior visits),
    // which could have made idea D look more N-starved than the real minutesSinceVisit===null
    // population actually is. Corrected to same-day RTH-only, matching the live semantics.
    //
    // SECOND FIX (audit finding, 2026-09-01, found on reconciling the 92%/N=12 vs 0.0%/N=766
    // contradiction): this query originally used the SAME parameter ($1) both cast to ::date
    // (for the day boundary) and compared bare against `ts` (a timestamp column). Postgres
    // unifies a parameter's type across every appearance in one query -- the explicit ::date
    // cast made $1 resolve to `date` everywhere, silently truncating the time-of-day off the
    // bare `ts < $1` comparison too (verified directly: `SELECT $1 as raw_param` with a mixed
    // ::date/bare-usage query returned '2026-08-20', not the full timestamp). That collapsed
    // `ts < $1` to `ts < <midnight of that day>`, which can never be true together with
    // `time >= 570` (9:30am) -- so barRes was UNCONDITIONALLY EMPTY for every single row,
    // making both anchorVisited and anyPartnerVisited vacuously false for the entire population.
    // The 0.0%/N=766 result was a pure SQL artifact, not a real negative. Fixed by using two
    // separate parameters: $1 (bare, timestamp comparison) and $2 (the row's own trade_date_str,
    // ::date comparison) -- confirmed this returns real bars again.
    const barRes = await query(`
      SELECT close::float
      FROM price_bars_primary
      WHERE symbol='NQ'
        AND ts::date = $2::date
        AND ts < $1::timestamp
        AND (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts)) >= 570
    `, [trade.fired_at, trade.trade_date_str]);

    // Check anchor freshness
    let anchorVisited = false;
    for (const b of barRes.rows) {
      if (Math.abs(b.close - anchorPrice) <= 10) {
        anchorVisited = true;
        break;
      }
    }

    if (!anchorVisited) {
      // It's a fresh anchor!
      totalFired++;
      
      let anyPartnerVisited = false;
      for (const lv of lvRes.rows) {
        // Exclude the anchor price itself
        if (Math.abs(lv.price - anchorPrice) < 0.1) continue;

        let visited = false;
        for (const b of barRes.rows) {
          if (Math.abs(b.close - lv.price) <= 10) {
            visited = true;
            break;
          }
        }
        if (visited) {
          anyPartnerVisited = true;
          break;
        }
      }

      if (anyPartnerVisited) partnersVisited++;
    }
  }

  const fraction = totalFired > 0 ? (partnersVisited / totalFired * 100).toFixed(1) : 0;
  console.log(`Result: ${partnersVisited} out of ${totalFired} (${fraction}%) had at least one cluster partner already visited.`);

  await recordClaim({
    slug: 'liquidity_zones_idea_d_free_census',
    claimText: `Idea D free census (docs/LIQUIDITY_ZONES_DEFENDED_LEVELS_SPEC.md Step 0): among real fired setups with confluenceCount>=2 and a fresh anchor (reconstructed minutesSinceVisit===null, matching acd.js's real same-day-RTH-only window exactly -- allRthBarsRow.rows, 9:30am ET through touch time, NOT overnight/prior-day bars, a real bug found and fixed on audit before trusting this number), ${partnersVisited} of ${totalFired} (${fraction}%) had at least one cluster partner already visited (query population: setup_type LIKE '%_FADE_%', origin_status IN ACTIVE/SHADOW, confluence_levels_at_detection with >=2 entries).`,
    sourceFile: 'scripts/pilot_idea_d.mjs',
    sampleSize: totalFired,
    rigorStatus: totalFired < 20 ? 'below_n20_floor_directional_only' : 'n_floor_cleared',
    status: 'PROVISIONAL',
  });

  console.log("Done.");
  process.exit(0);
}
main().catch(console.error);
