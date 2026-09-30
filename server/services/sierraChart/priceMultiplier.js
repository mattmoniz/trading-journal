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
