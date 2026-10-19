#!/usr/bin/env node
// Register the effect a change is MEANT to have, before restarting with it:
//   node scripts/perf_expect.mjs <metric> <down|up> "<why>"      e.g.  node scripts/perf_expect.mjs detect_avg_ms down "cache the prior-day IB query"
// metrics: db_time_pct detect_avg_ms loop_p99_ms poll_outages entry_delay_p90_s rss_mb heap_used_mb pool_waiting
// When the post-deploy watch ends, perf_snapshots' VERDICT row says per expectation MET / NOT_MET / NOT_OBSERVED, and a NOT_MET opens an OPEN_DECISION --
// so "did this speed-up actually speed anything up" is answered from data, not assumed.
import { query } from '../server/db.js';
const [metric, direction, ...why] = process.argv.slice(2);
const OK = ['db_time_pct', 'detect_avg_ms', 'loop_p99_ms', 'poll_outages', 'entry_delay_p90_s', 'rss_mb', 'heap_used_mb', 'pool_waiting'];
if (!OK.includes(metric) || !['down', 'up'].includes(direction)) { console.error('usage: perf_expect.mjs <metric> <down|up> "<why>"; metrics: ' + OK.join(' ')); process.exit(1); }
await query(`INSERT INTO perf_snapshots (kind, metrics) VALUES ('EXPECT', $1)`, [JSON.stringify({ metric, direction, why: why.join(' ') })]);
console.log(`registered: expect ${metric} ${direction} -- ${why.join(' ')}`);
process.exit(0);
