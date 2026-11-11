// Dumps the repo's NQ roll-week dates (server/services/acdShared.js getNqRollWeekDates, the rule every other study uses) for 2023-2026 to scratch/capitulation_replay_20261109/roll_week_dates.json
import fs from 'fs';
import { getNqRollWeekDates } from '../../server/services/acdShared.js';
const out = []; for (const y of [2023, 2024, 2025, 2026]) for (const d of [...getNqRollWeekDates(y)].sort()) out.push(d);
fs.writeFileSync('scratch/capitulation_replay_20261109/roll_week_dates.json', JSON.stringify(out)); console.log(out.length, 'roll-week dates:', out.join(' ')); process.exit(0);
