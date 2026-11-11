// Refresh ONLY the `capitulationShadow` and `levelConfluence` keys of public/learning_monitor.json (atomic rewrite), so the Monitor & Learning card shows the overlay without waiting for the nightly build. No file => nothing written.
import fs from 'fs';
import { capitulationShadowSummary } from './lib/capitulationShadowSummary.mjs';
import { levelConfluenceSummary } from './lib/levelConfluenceSummary.mjs';
const FILE = new URL('../public/learning_monitor.json', import.meta.url).pathname;
let cur; try { cur = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { console.error('no learning_monitor.json yet:', e.code || e.message); process.exit(0); }
cur.capitulationShadow = await capitulationShadowSummary();
cur.levelConfluence = await levelConfluenceSummary();
fs.writeFileSync(FILE + '.cap.tmp', JSON.stringify(cur)); fs.renameSync(FILE + '.cap.tmp', FILE);
console.log('capitulationShadow refreshed', cur.capitulationShadow.state, JSON.stringify(cur.capitulationShadow.totals || cur.capitulationShadow.error).slice(0, 200)); process.exit(0);
