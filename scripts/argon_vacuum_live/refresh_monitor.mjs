// Refresh ONLY the `argonShadow` key of public/learning_monitor.json (atomic rewrite) so the Monitor & Learning page shows the live shadow without waiting for the nightly build.
// Called by scripts/argon_vacuum_live/shadow.py after a new setup trigger and every few minutes. The nightly scripts/learning_monitor_build.mjs includes the same key. No file => nothing written.
import fs from 'fs';
import { argonShadowSummary } from '../lib/argonShadowSummary.mjs';
import { vacuumLiveSummary } from '../lib/vacuumLiveSummary.mjs';
const FILE = new URL('../../public/learning_monitor.json', import.meta.url).pathname;
let cur; try { cur = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { console.error('no learning_monitor.json yet:', e.code || e.message); process.exit(0); }
cur.argonShadow = await argonShadowSummary(); cur.vacuumLive = await vacuumLiveSummary();
fs.writeFileSync(FILE + '.argon.tmp', JSON.stringify(cur)); fs.renameSync(FILE + '.argon.tmp', FILE);
console.log('argonShadow refreshed', cur.argonShadow.state); process.exit(0);
