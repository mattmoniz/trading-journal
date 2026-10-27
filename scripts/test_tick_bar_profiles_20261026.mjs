// Checks getBarProfiles against the independent hourly POCs computed straight from the 30-minute files on 2026-10-26 (scratch/morning_look.py): 02:00 POC 29080, 04:00 POC 29179.25, 07:00 POC 29288, 11:00 POC 29540.
import { query } from '../server/db.js';
import { getBarProfiles } from '../server/services/tickVolumeProfile.js';
const bars = await getBarProfiles(query, { startTs: '2026-10-25 18:00', endTs: '2026-10-26 17:00', barMinutes: 60 });
const want = { '2026-10-26 02:00': 29080, '2026-10-26 04:00': 29179.25, '2026-10-26 07:00': 29288, '2026-10-26 11:00': 29540 };
let ok = true; for (const [t, p] of Object.entries(want)) { const b = bars.find((x) => x.start === t); const pass = b && b.poc === p; ok = ok && pass; console.log(pass ? 'ok  ' : 'FAIL', t, 'POC', b && b.poc, 'expected', p); }
const four = await getBarProfiles(query, { startTs: '2026-10-25 18:00', endTs: '2026-10-26 17:00', barMinutes: 240 });
console.log('240-minute bars:', four.map((b) => `${b.start} POC ${b.poc} VA ${b.val}-${b.vah}`).join(' | '));
console.log(ok ? 'all passed' : 'FAILED'); process.exit(ok ? 0 : 1);
