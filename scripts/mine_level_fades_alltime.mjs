/**
 * mine_level_fades_alltime.mjs
 *
 * Calls the SAME mineLevelFades() logic patternScannerService.js uses for the nightly
 * rolling-90-day scan, but with windowDays=null (full price_bars_primary history) and
 * windowType='ALL_TIME' / keyPrefix='ALLTIME:' so its discoveries persist to the same
 * pattern_discoveries table without colliding with the rolling scan's pattern_keys.
 *
 * Why this exists (2026-07-16/17, user request): the rolling 90-day scan re-evaluates
 * fresh every night and DEGRADEs anything that doesn't re-qualify in the CURRENT window.
 * That's correct for catching regime change fast, but it structurally cannot accumulate
 * enough N for a genuinely rare, large-magnitude pattern that only occurs a handful of
 * times a year -- 90 days of data just doesn't contain enough occurrences to ever clear
 * N>=20 for something infrequent. This script scans the full available history instead,
 * so rare-but-real patterns get a chance to surface. Independent ACTIVE/DEGRADED
 * lifecycle from the rolling scan (see mineLevelFades()'s window_type-scoped DEGRADE
 * query) -- a pattern only present in recent history won't degrade the all-time version,
 * and vice versa.
 *
 * NOT run nightly. Meaningfully more expensive than the 90-day version (same per-day
 * query cost, ~10x+ more days) -- run manually first to measure actual runtime before
 * deciding a cadence, per this codebase's own "verify actual performance" convention.
 * Intended future home: weekly cron, once measured.
 */
import { mineLevelFades } from '../server/services/patternScannerService.js';

const startedAt = Date.now();
console.log('[mine_level_fades_alltime] starting full-history scan...');

const result = await mineLevelFades({ windowDays: null, windowType: 'ALL_TIME', keyPrefix: 'ALLTIME:' });

const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log(`[mine_level_fades_alltime] done in ${elapsedSec}s`);
console.log(`  totalTrades: ${result.totalTrades}`);
console.log(`  totalDiscoveries: ${result.totalDiscoveries}`);
console.log(`  newDiscoveries: ${result.newDiscoveries.length}`);
console.log('  top patterns:');
for (const p of result.topPatterns.slice(0, 15)) {
  console.log(`    ${p.patternKey}  WR=${p.wr}%  N=${p.n}  netPnl=$${Math.round(p.netPnl)}  stable=${p.rigor?.stable}`);
}

process.exit(0);
