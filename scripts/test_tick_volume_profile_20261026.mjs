// Checks the tick-volume profile service against the user's Sierra Chart readings (2026-10-26 screenshots) and prints the stored levels next to it.
import { query } from '../server/db.js';
import { getPeriodProfile } from '../server/services/tickVolumeProfile.js';
const f = (p) => p && `VAL ${p.val} POC ${p.poc} VAH ${p.vah} (days ${p.daysLoaded})`;
console.log('user Sierra, current 3M block (Oct 1 session on): POC 29779.75, VAH label 30925.5, VAL ~28970-29000; previous block POC ~29513');
console.log('current 3M block, all sessions :', f(await getPeriodProfile(query, { startDate: '2026-10-01', endDate: '2026-10-26' })));
console.log('previous 3M block (Jul 1-Sep 30):', f(await getPeriodProfile(query, { startDate: '2026-07-01', endDate: '2026-09-30' })), '(2026-09-14 missing: roll day not reconcilable)');
console.log('current block RTH only        :', f(await getPeriodProfile(query, { startDate: '2026-10-01', endDate: '2026-10-26', session: 'rth' })));
console.log('current block Globex only     :', f(await getPeriodProfile(query, { startDate: '2026-10-01', endDate: '2026-10-26', session: 'globex' })));
const st = (await query(`SELECT level_name, price::float p FROM level_prices WHERE trade_date='2026-10-26' AND level_name IN ('3M_VAH','3M_VAL','3M_POC','PM_VAH','PM_VAL','PM_POC','PW_VAH','PW_VAL','PW_POC') ORDER BY 1`)).rows;
console.log('stored level_prices 2026-10-26 (bar-spread, RTH):', st.map((x) => `${x.level_name} ${x.p}`).join(' | '));
console.log('tick RTH, stored definitions  :');
console.log('  PM (Sep 1-30)  ', f(await getPeriodProfile(query, { startDate: '2026-09-01', endDate: '2026-09-30', session: 'rth' })));
console.log('  PW (Oct 12-16) ', f(await getPeriodProfile(query, { startDate: '2026-10-12', endDate: '2026-10-16', session: 'rth' })), ' <- check the stored PW week definition before comparing');
console.log('  3M rolling (stored def: 2026-07-26..2026-10-25) ', f(await getPeriodProfile(query, { startDate: '2026-07-26', endDate: '2026-10-25', session: 'rth' })));
process.exit(0);
