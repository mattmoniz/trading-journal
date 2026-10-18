// Run: node scripts/test_market_entry_selection.mjs -- checks orderSweep.js's wantsMarketEntry() picks
// price-triggered setups and never a real level fade.
import assert from 'node:assert/strict';
import { wantsMarketEntry } from '../server/services/sierraChart/orderSweep.js';
import { query } from '../server/db.js';
const m = (t, is_rth = null) => wantsMarketEntry({ setup_type: t, is_rth });
for (const t of ['POC_ROTATION_JOIN_LONG', 'STACK_VOL_BREAK_LIVE_SHORT', 'GLOBEX_VWAP_MAGNET_LONG', 'VWAP_MAGNET_SHORT', 'A_UP_STRONG',
  'C_PAIRED_SHORT', 'MAJOR_PIVOT_DEFENDED_BREAK_LONG', 'MOMENTUM_CHASE_MEDIUM_SHORT', 'BRACKET_BREAKOUT_LONG', 'RTH_VWAP_FADE_SHORT']) assert.equal(m(t), true, t);
for (const t of ['CAM_S2_FADE_LONG_OVERNIGHT', 'PD_VAH_FADE_SHORT', 'OR5_LOW_FADE_SHORT', 'FLOOR_S3_FADE_LONG', 'IB_MID_SCALP_FADE_LONG', 'WS1_FADE_LONG']) assert.equal(m(t), false, t);
assert.equal(m('GLOBEX_VWAP_FADE_LONG', true), false); // existing RTH-hours-copy guard unchanged
assert.equal(m('GLOBEX_VWAP_FADE_LONG', false), true);
const all = (await query(`SELECT DISTINCT setup_type FROM active_setups`)).rows.map(r => r.setup_type);
const levelFades = all.filter(t => /_FADE_(LONG|SHORT)(_OVERNIGHT)?$/.test(t) && !/^(GLOBEX|RTH)_VWAP_FADE_/.test(t));
const wrong = levelFades.filter(t => m(t, true));
assert.deepEqual(wrong, [], 'level fades wrongly set to market: ' + wrong.join(', '));
console.log(`ok: ${levelFades.length} level-fade types all stay LIMIT; ${all.filter(t => m(t, false)).length} of ${all.length} total types use MARKET`);
process.exit(0);
