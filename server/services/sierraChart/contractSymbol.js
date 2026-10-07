// Deterministic MNQ front-month contract symbol resolution for real order placement.
//
// DELIBERATELY DOES NOT read price_bars_contract_calendar. That table is (1) NQ-scoped,
// not MNQ (this app's detection/pricing walks NQ bars while modeling MNQ $/pt -- see
// server/config/instruments.js), (2) ranked by SUM(volume), a backtest-continuity
// heuristic that LAGS the real roll -- it only flips once the new contract's ingested bar
// volume exceeds the old, which during the roll-week overlap can point at the expiring,
// illiquid contract for hours, exactly the wrong target for a brand-new real order, and
// (3) only as fresh as the last ingest -- a missing/stale "today" row would otherwise
// need a silent fallback, which a real-order system must never do. Flagged by DeepSeek
// design review, 2026-09-29 (docs/OPEN_THREADS.md's 2026-09-28 Sierra Chart entry).
//
// Instead: a pure, total, date-derived function. MNQ and NQ share the exact same CME
// quarterly (Mar/Jun/Sep/Dec, letters H/M/U/Z) cycle and expiration dates, so this needs
// no live data at all and can never be stale.

import { isInsideNqRollWeek } from '../acdShared.js';

const QUARTERLY_MONTHS = [
  { letter: 'H', month: 2 },  // March
  { letter: 'M', month: 5 },  // June
  { letter: 'U', month: 8 },  // September
  { letter: 'Z', month: 11 }, // December
];

function thirdFridayOfMonth(year, month) {
  const d = new Date(year, month, 1);
  let count = 0;
  while (d.getMonth() === month) {
    if (d.getDay() === 5) { count++; if (count === 3) return d; }
    d.setDate(d.getDate() + 1);
  }
  /* istanbul ignore next -- every calendar month structurally has 3+ Fridays */
  throw new Error(`resolveMnqFrontMonthSymbol: no 3rd Friday found for ${year}-${month} -- should be impossible`);
}

function* quarterlyContractsFrom(startYear) {
  for (let y = startYear; y <= startYear + 1; y++) {
    for (const q of QUARTERLY_MONTHS) yield { letter: q.letter, year: y, expiry: thirdFridayOfMonth(y, q.month) };
  }
}

/**
 * Front-month contract for `dateStr` (YYYY-MM-DD, ET calendar date -- caller's
 * responsibility to pass the real ET "today," matching this codebase's own
 * CURRENT_DATE-not-toISOString convention).
 *
 * Rule: the nearest quarterly contract not yet past its own CME expiration (3rd Friday
 * of the contract month) -- EXCEPT once inside that contract's own roll week
 * (isInsideNqRollWeek(): 2nd Thursday through the Monday before 3rd Friday), where real
 * market liquidity has already migrated to the NEXT quarterly contract, so this function
 * rolls early to match. Total and pure -- always returns a real contract for any valid
 * date, never guesses/defaults on ambiguity (throws on a malformed dateStr instead).
 *
 * Returns { letter, year, yearDigit, contractCode, orderSymbol } where `orderSymbol` is
 * this codebase's one canonical symbol string (e.g. "MNQZ6.CME") -- confirmed 2026-09-28
 * against real resting orders returned by a live OPEN_ORDERS_REQUEST, and used everywhere
 * EXCEPT the actual DTC wire submission: `order_placements.symbol`, broker position/fill
 * matching (extractPositionForSymbol(), checkPositionInvariant()), and all logging/display
 * depend on this exact combined string being the single identity key throughout the app --
 * do not split it before passing it to any of those.
 *
 * CORRECTED 2026-10-07 (previously claimed Sierra Chart's DTC server "embeds the exchange
 * directly into the Symbol field" as a venue convention -- false, confirmed by a live A/B
 * test on one unchanged account: sending this combined string as `Symbol` with `Exchange:
 * ''` does NOT mean "exchange embedded in symbol" -- it means the server fell back to some
 * default/guessed exchange resolution, which silently filled every order at market
 * instantly regardless of price on Sim1, and was rejected outright ("not allowed based on
 * the symbol") on the Trading Evaluator). The real DTC wire protocol wants `Symbol` and
 * `Exchange` as two genuinely separate fields. dtcClient.js's submitOrder()/submitOcoOrder()
 * now split this combined string into the two wire fields automatically, right before
 * sending -- callers keep passing `{ symbol: contract.orderSymbol, exchange: '' }` exactly
 * as before; nothing above the wire-serialization layer needs to change.
 */
export function resolveMnqFrontMonthSymbol(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    throw new Error(`resolveMnqFrontMonthSymbol: dateStr must be YYYY-MM-DD, got "${dateStr}"`);
  }
  const [y, m, d] = dateStr.split('-').map(Number);
  const today = new Date(y, m - 1, d);
  const rollingEarly = isInsideNqRollWeek(dateStr);

  const contracts = [...quarterlyContractsFrom(y - 1)].sort((a, b) => a.expiry - b.expiry);
  const idx = contracts.findIndex((c) => c.expiry >= today);
  if (idx === -1) {
    throw new Error(`resolveMnqFrontMonthSymbol: no unexpired quarterly contract found for ${dateStr} -- should be impossible within the 2-year lookahead window`);
  }
  const chosen = rollingEarly ? contracts[idx + 1] : contracts[idx];
  const yearDigit = String(chosen.year).slice(-1);
  const contractCode = `${chosen.letter}${yearDigit}`;
  return {
    letter: chosen.letter,
    year: chosen.year,
    yearDigit,
    contractCode,
    orderSymbol: `MNQ${contractCode}.CME`,
  };
}
