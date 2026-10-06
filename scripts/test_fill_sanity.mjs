// Tests for fillPriceSanity (server/services/sierraChart/priceMultiplier.js).
// Cases are the REAL fills from order_placements on 2026-09-28/29 and 2026-10-05, plus
// the rule edges. Run: node scratch/test_fill_sanity_20261005.mjs
import { fillPriceSanity, applyPriceMultiplier, classifyFill, parseBidAskFromInfo } from '../server/services/sierraChart/priceMultiplier.js';

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

// --- classifyFill: broker's own quote decides market execution (2026-10-06) ---
const cls = (o) => classifyFill(o).status;
expect('parse bid/ask from Sierra fill text', parseBidAskFromInfo('Trade simulation fill. Bid: 31564.75 Ask: 31565.00 Last: 31564.75')?.bid, 31564.75);
expect('SELL limit 31567 filled at bid 31564.75 -> MARKET_EXECUTION (kept, flagged)', cls({ orderType: 'LIMIT', side: 'SELL', price1: 31567, fillPrice: 31564.75, infoText: 'Trade simulation fill. Bid: 31564.75 Ask: 31565.00 Last: 31564.75' }), 'MARKET_EXECUTION');
expect('SELL limit 31567 filled at bid 31559.00 -> MARKET_EXECUTION', cls({ orderType: 'LIMIT', side: 'SELL', price1: 31567, fillPrice: 31559.00, infoText: 'Trade simulation fill. Bid: 31559.00 Ask: 31559.50 Last: 31559.25' }), 'MARKET_EXECUTION');
expect('multiplier error 313.57 matches no quote -> REFUSED', cls({ orderType: 'LIMIT', side: 'SELL', price1: 31352.75, fillPrice: 313.57, infoText: 'Trade simulation fill. Bid: 31357.00 Ask: 31357.75 Last: 31357.50' }), 'REFUSED');
expect('valid limit fill -> OK', cls({ orderType: 'LIMIT', side: 'SELL', price1: 31432.25, fillPrice: 31437.25, infoText: null }), 'OK');
expect('no quote in text, violates rule -> REFUSED', cls({ orderType: 'LIMIT', side: 'SELL', price1: 31567, fillPrice: 31560, infoText: null }), 'REFUSED');

import { toTickPrice } from '../server/services/sierraChart/priceMultiplier.js';
const M = 0.00999999776482582;
expect('raw 3135700 converts and rounds to quoted 31357.00', toTickPrice(3135700 * M), 31357.00);
expect('raw 3156475 converts and rounds to quoted 31564.75', toTickPrice(3156475 * M), 31564.75);
expect('raw 3155900 converts and rounds to quoted 31559.00', toTickPrice(3155900 * M), 31559.00);
expect('non-finite stays null', toTickPrice(NaN), null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
