// Replay ONE recorded pass with NO database and compare its decisions with the recording's. Usage:
//   node scripts/replay/replay_pass.mjs <recording.json> [--route server/routes/acd.js] [--show-writes]
// Exit 0 = identical decisions and no unrecorded read; 1 = a difference (listed); 2 = usage/error. --route lets the SAME recording be replayed against another code version (e.g. a pre-refactor copy).
import path from 'node:path';
import { REPO, freezeClock, makeReplayer, installFetch, runOnePass, settle, decisionsOf, diffDecisions, readJson, ioStub, enc } from './lib.mjs';

const file = process.argv[2];
if (!file) { console.error('usage: replay_pass.mjs <recording.json> [--route path] [--show-writes]'); process.exit(2); }
const rec = readJson(file);
const ri = process.argv.indexOf('--route');
const routeModulePath = path.resolve(REPO, ri > 0 ? process.argv[ri + 1] : 'server/routes/acd.js');
process.env.HA_ALERT_WEBHOOK_URL = '';
freezeClock(rec.t0);
const { setQueryInterceptor } = await import(path.join(REPO, 'server/db.js'));
const rp = makeReplayer(rec);
setQueryInterceptor(rp.interceptor);
const fetches = [];
installFetch('replay', rec, fetches);
const res = await runOnePass({ routeModulePath, ioStub });
const quiet = await settle(rp.idle);
const got = decisionsOf({ ...res, writes: rp.writes, fetches });
const diffs = diffDecisions(rec.decisions, got);
if (process.argv.includes('--show-writes')) for (const w of rp.writes) console.log('WRITE', enc({ sql: w.sql.slice(0, 160), params: w.params }).slice(0, 300));
console.log(`replay ${path.basename(file)} against ${path.relative(REPO, routeModulePath)}: ${rp.writes.length} writes (recorded ${rec.decisions.writes.length}), ${rp.unrecorded.length} unrecorded reads, settled=${quiet}, ${diffs.length} decision differences`);
for (const u of rp.unrecorded.slice(0, 8)) console.log('  UNRECORDED READ:', u.sql);
for (const d of diffs.slice(0, 20)) console.log('  DIFF:', d);
process.exit(diffs.length === 0 && rp.unrecorded.length === 0 ? 0 : 1);
