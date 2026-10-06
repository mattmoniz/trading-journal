// Per-symbol DisplayPriceMultiplier cache -- the factor broker-originated fill-price
// fields (ORDER_UPDATE's AverageFillPrice/LastFillPrice) need multiplying by to get the
// real float price. Confirmed live 2026-09-29: MNQZ6.CME real fills arrived as e.g.
// `3043725`; a live SECURITY_DEFINITION_FOR_SYMBOL_REQUEST for that exact symbol returned
// DisplayPriceMultiplier=0.00999999776482582, and `3043725 * that = 30437.24...`,
// rounding to the real `30437.25`. `Price1`/`Price2` this app sets when SUBMITTING an
// order are NOT affected by this -- only fields the broker reports back.
//
// Deliberately keyed by the exact symbol string (e.g. "MNQZ6.CME"), not a generic root --
// a contract roll (MNQZ6 -> MNQH7) is a different symbol string and gets its own fresh
// fetch, so this cache is automatically roll-safe without any explicit invalidation logic.
// Process-lifetime cache -- cheap enough (one request per distinct contract this process
// ever trades) that there's no need for a TTL.

const cache = new Map(); // symbol -> multiplier (number) | null (fetch failed/no answer)

/**
 * Returns the real DisplayPriceMultiplier for `symbol`, fetching and caching it via a
 * live DTC request if not already known. Returns null (never guesses/defaults) if the
 * client isn't connected or no response arrives in time -- callers must treat null as
 * "cannot convert this price safely right now," not as "multiplier is 1."
 */
export async function getPriceMultiplier(dtcClient, symbol) {
  if (cache.has(symbol)) return cache.get(symbol);
  if (!dtcClient || !dtcClient.isLoggedOn) return null;

  const multiplier = await new Promise((resolve) => {
    let resolved = false;
    const onSecurityDefinition = (msg) => {
      if (msg.Symbol !== symbol || resolved) return;
      resolved = true;
      dtcClient.off('securityDefinition', onSecurityDefinition);
      resolve(Number.isFinite(msg.DisplayPriceMultiplier) ? msg.DisplayPriceMultiplier : null);
    };
    dtcClient.on('securityDefinition', onSecurityDefinition);
    try { dtcClient.requestSecurityDefinition(symbol); }
    catch { dtcClient.off('securityDefinition', onSecurityDefinition); resolve(null); return; }
    setTimeout(() => {
      if (resolved) return;
      resolved = true;
      dtcClient.off('securityDefinition', onSecurityDefinition);
      resolve(null);
    }, 4000);
  });

  cache.set(symbol, multiplier); // cache the null too -- don't hammer a symbol that never answers
  return multiplier;
}

/** Apply a symbol's real multiplier to a broker-reported price field. Returns null if the
 * multiplier isn't known -- callers must not silently store a possibly-wrong raw value. */
export function applyPriceMultiplier(rawValue, multiplier) {
  if (!Number.isFinite(rawValue) || !Number.isFinite(multiplier)) return null;
  return rawValue * multiplier;
}

/**
 * Structural sanity check on a converted broker fill price (added 2026-10-05). Returns
 * { ok: true } or { ok: false, reason }. Checks only what must hold by order-type rules,
 * never a price threshold:
 *   LIMIT BUY  fills at or below its limit;   LIMIT SELL fills at or above its limit.
 *   STOP  BUY  fills at or above its trigger; STOP  SELL fills at or below its trigger.
 *   MARKET     no price constraint.
 * A violation means the conversion or the attribution is wrong, not that the market moved.
 * Caught live 2026-10-05: a SELL limit at 31352.75 "filled" at 313.57 (wrong multiplier),
 * and a BUY stop at 31389.75 "filled" at 31357.50 (below its trigger).
 */
export function fillPriceSanity({ orderType, side, price1, fillPrice }) {
  if (!Number.isFinite(fillPrice)) return { ok: false, reason: 'fill price is not a finite number' };
  if (orderType === 'MARKET' || !Number.isFinite(price1)) return { ok: true };
  const EPS = 1e-6;
  const isBuy = side === 'BUY';
  if (orderType === 'LIMIT') {
    if (isBuy && fillPrice > price1 + EPS) return { ok: false, reason: `BUY limit ${price1} filled above its limit at ${fillPrice}` };
    if (!isBuy && fillPrice < price1 - EPS) return { ok: false, reason: `SELL limit ${price1} filled below its limit at ${fillPrice}` };
  } else if (orderType === 'STOP') {
    if (isBuy && fillPrice < price1 - EPS) return { ok: false, reason: `BUY stop ${price1} filled below its trigger at ${fillPrice}` };
    if (!isBuy && fillPrice > price1 + EPS) return { ok: false, reason: `SELL stop ${price1} filled above its trigger at ${fillPrice}` };
  }
  return { ok: true };
}
