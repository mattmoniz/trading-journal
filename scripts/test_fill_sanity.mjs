// Tests for fillPriceSanity (server/services/sierraChart/priceMultiplier.js).
// Cases are the REAL fills from order_placements on 2026-09-28/29 and 2026-10-05, plus
// the rule edges. Run: node scratch/test_fill_sanity_20261005.mjs
import { fillPriceSanity, applyPriceMultiplier } from '../server/services/sierraChart/priceMultiplier.js';

let pass = 0, fail = 0;
function expect(name, got, want) {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (got ${got}, want ${want})`);
}
const ok = (o) => fillPriceSanity(o).ok;

// --- real cases ---
expect('131237 SELL LIMIT 31352.75 filled 313.57 (wrong multiplier) -> refused', ok({ orderType: 'LIMIT', side: 'SELL', price1: 31352.75, fillPrice: 313.57 }), false);
expect('127695 SELL LIMIT 30657.5 filled 30652.5 (below limit) -> refused', ok({ orderType: 'LIMIT', side: 'SELL', price1: 30657.5, fillPrice: 30652.5 }), false);
expect('127682 SELL LIMIT 30432.25 filled 30437.25 (at/above limit) -> accepted', ok({ orderType: 'LIMIT', side: 'SELL', price1: 30432.25, fillPrice: 30437.25 }), true);
expect('127681 SELL LIMIT 30436 filled 30437.25 -> accepted', ok({ orderType: 'LIMIT', side: 'SELL', price1: 30436, fillPrice: 30437.25 }), true);
expect('127693 SELL LIMIT 30626.75 filled 30636.75 -> accepted', ok({ orderType: 'LIMIT', side: 'SELL', price1: 30626.75, fillPrice: 30636.75 }), true);
expect('S131237 BUY STOP 31389.75 filled 31357.5 (below trigger) -> refused', ok({ orderType: 'STOP', side: 'BUY', price1: 31389.75, fillPrice: 31357.5 }), false);

// --- rule edges ---
expect('BUY LIMIT fills at limit -> accepted', ok({ orderType: 'LIMIT', side: 'BUY', price1: 100, fillPrice: 100 }), true);
expect('BUY LIMIT fills below limit -> accepted (better price)', ok({ orderType: 'LIMIT', side: 'BUY', price1: 100, fillPrice: 99 }), true);
expect('BUY LIMIT fills above limit -> refused', ok({ orderType: 'LIMIT', side: 'BUY', price1: 100, fillPrice: 101 }), false);
expect('SELL LIMIT fills above limit -> accepted (better price)', ok({ orderType: 'LIMIT', side: 'SELL', price1: 100, fillPrice: 101 }), true);
expect('SELL LIMIT fills below limit -> refused', ok({ orderType: 'LIMIT', side: 'SELL', price1: 100, fillPrice: 99 }), false);
expect('BUY STOP fills above trigger (gap up) -> accepted', ok({ orderType: 'STOP', side: 'BUY', price1: 100, fillPrice: 103 }), true);
expect('SELL STOP fills below trigger (gap down) -> accepted', ok({ orderType: 'STOP', side: 'SELL', price1: 100, fillPrice: 97 }), true);
expect('SELL STOP fills above trigger -> refused', ok({ orderType: 'STOP', side: 'SELL', price1: 100, fillPrice: 101 }), false);
expect('MARKET order: no constraint -> accepted', ok({ orderType: 'MARKET', side: 'SELL', price1: null, fillPrice: 12345 }), true);
expect('non-finite fill -> refused', ok({ orderType: 'LIMIT', side: 'BUY', price1: 100, fillPrice: NaN }), false);
expect('limit with no price1 -> accepted (nothing to compare against)', ok({ orderType: 'LIMIT', side: 'BUY', price1: null, fillPrice: 50 }), true);

// --- conversion: real broker value through the real multiplier (MNQZ6.CME, 0.00999999776482582) ---
const conv = applyPriceMultiplier(3135700, 0.00999999776482582);
expect('broker 3135700 x MNQZ6 multiplier ~ 31357.00', Math.abs(conv - 31357.0) < 0.01, true);
expect('same fill passes sanity after conversion (SELL LIMIT 31352.75)', ok({ orderType: 'LIMIT', side: 'SELL', price1: 31352.75, fillPrice: conv }), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
