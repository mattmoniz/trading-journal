// Record ONE detection pass against the live database with every write suppressed (see lib.mjs). Usage:
//   node scripts/replay/record_pass.mjs <out.json> [--route server/routes/acd.js]
// Safe by construction: reads only; INSERT/UPDATE/DELETE/DDL are captured, not executed; outbound calls other than localhost are blocked; no DTC client exists in this process.
import fs from 'node:fs';
import path from 'node:path';
import { REPO, freezeClock, makeRecorder, installFetch, runOnePass, settle, decisionsOf, enc, ioStub } from './lib.mjs';

const out = process.argv[2];
if (!out) { console.error('usage: record_pass.mjs <out.json> [--route path]'); process.exit(2); }
const ri = process.argv.indexOf('--route');
const routeModulePath = path.resolve(REPO, ri > 0 ? process.argv[ri + 1] : 'server/routes/acd.js');
process.env.HA_ALERT_WEBHOOK_URL = '';
const t0 = Date.now();
freezeClock(t0);
const { setQueryInterceptor } = await import(path.join(REPO, 'server/db.js'));
const rec = makeRecorder();
setQueryInterceptor(rec.interceptor);
const fetches = [];
installFetch('record', null, fetches);
const res = await runOnePass({ routeModulePath, ioStub });
const quiet = await settle(rec.idle);
const decisions = decisionsOf({ ...res, writes: rec.writes, fetches });
const recording = { version: 1, label: path.basename(out), t0, routeModule: path.relative(REPO, routeModulePath), quiet, stats: rec.stats, reads: Object.fromEntries(rec.reads), fetches, decisions };
fs.writeFileSync(out, enc(recording));
console.log(`recorded ${out}: ${rec.stats.reads} reads, ${rec.stats.writes} suppressed writes, ${fetches.length} localhost calls, status ${res.status}, settled=${quiet}, ${Math.round(fs.statSync(out).size / 1024)} KB, setup=${JSON.stringify(res.body?.setup ? { type: res.body.setup.type } : null)}`);
process.exit(0);
