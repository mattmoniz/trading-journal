// Tiny response cache + request coalescing for polled, read-only GET endpoints (2026-10-19, request profiler).
//
// Why: several open tabs/devices (quick-check on a phone, the HA page, the React app) each poll the same heavy endpoint every ~20 s, and
// each poll recomputes it from scratch (market/pulse ~3 s, live-session-context ~3.7 s of DB time per call). Within `ttlMs` every caller
// gets the SAME answer, and callers arriving while one computation is running share it instead of starting another.
//
// Safe only for endpoints whose body depends on the URL (path + query) and database state alone -- never on the caller. Only a 200 JSON
// body is cached; errors are never cached. The cache is per-process memory (a restart empties it) and bounded.
const store = new Map();   // url -> { exp, body }
const inFlight = new Map(); // url -> Promise<{status, body}>
const MAX_ENTRIES = 200;

export function microCache(ttlMs) {
  return async function microCacheMiddleware(req, res, next) {
    const key = req.originalUrl;
    const hit = store.get(key);
    if (hit && hit.exp > Date.now()) return res.json(hit.body);
    const pending = inFlight.get(key);
    if (pending) {
      const r = await pending.catch(() => null);
      if (r && r.status === 200) return res.status(200).json(r.body);
      return next(); // the leader failed or errored: compute on our own rather than inherit its error
    }
    let settle;
    inFlight.set(key, new Promise((resolve) => { settle = resolve; }));
    let status = 200;
    const origStatus = res.status.bind(res);
    res.status = (code) => { status = code; return origStatus(code); };
    const origJson = res.json.bind(res);
    res.json = (body) => {
      if (status === 200) {
        if (store.size >= MAX_ENTRIES) store.delete(store.keys().next().value);
        store.set(key, { exp: Date.now() + ttlMs, body });
      }
      inFlight.delete(key);
      settle({ status, body });
      return origJson(body);
    };
    res.on('close', () => { if (inFlight.has(key)) { inFlight.delete(key); settle(null); } }); // handler threw / connection dropped
    next();
  };
}
