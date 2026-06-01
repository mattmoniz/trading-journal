// Simple in-memory cache for expensive endpoints (key-levels, etc.)
const _cache = new Map();

export function cacheGet(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.exp) { _cache.delete(key); return null; }
  return entry.val;
}

export function cacheSet(key, val, ttlMs = 120_000) {
  _cache.set(key, { val, exp: Date.now() + ttlMs });
}

export function cacheDelete(key) { _cache.delete(key); }

// Returns 'YYYY-MM-DD' of the most recent price bar — used to key caches so
// they auto-invalidate when new bar data is imported, regardless of TTL.
import { query } from '../db.js';

export async function latestBarDate() {
  try {
    const r = await query(`SELECT MAX(ts::date)::text as d FROM price_bars WHERE symbol='NQ'`);
    return r.rows[0]?.d || 'nodata';
  } catch(e) { return 'nodata'; }
}
