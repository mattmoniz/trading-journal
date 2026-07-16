import { useState, useEffect } from 'react';

// Like usePollData, but multiple components requesting the SAME url share one
// underlying fetch+poll cycle instead of each firing its own independent request.
// Found 2026-07-15: /api/antigravity/edges-context was being fetched 4 separate
// times on every Morning Prep load (PermSlipAndStackBar, LivePlaybookCard,
// OvernightContextStrip, EdgeSectionsPanel), each with its own useEffect+setInterval
// — real duplicate server work with no benefit, since all 4 want the same response.
//
// If subscribers ask for different poll intervals on the same url, the fastest one
// wins (matches the most demanding subscriber's freshness need; the others get data
// at least as fresh as they asked for, for free).
const _cache = new Map(); // url -> { data, error, subscribers: Set<setter>, intervalId, intervalMs, loading }

function load(url) {
  const entry = _cache.get(url);
  if (!entry || entry.loading) return; // in-flight guard — see subscribe() below
  entry.loading = true;
  fetch(url)
    .then(r => r.json())
    .then(d => {
      entry.loading = false;
      entry.data = d;
      entry.error = null;
      entry.subscribers.forEach(fn => fn(d, null));
    })
    .catch(e => {
      entry.loading = false;
      entry.error = e.message;
      entry.subscribers.forEach(fn => fn(entry.data, e.message));
    });
}

function subscribe(url, intervalMs, setter) {
  let entry = _cache.get(url);
  if (!entry) {
    entry = { data: null, error: null, subscribers: new Set(), intervalId: null, intervalMs, loading: false };
    _cache.set(url, entry);
  }
  entry.subscribers.add(setter);
  if (intervalMs < entry.intervalMs || !entry.intervalId) {
    entry.intervalMs = Math.min(entry.intervalMs, intervalMs);
    if (entry.intervalId) clearInterval(entry.intervalId);
    entry.intervalId = setInterval(() => load(url), entry.intervalMs);
  }
  else load(url);
  // ^ Real bug fixed 2026-07-15: every subscriber mounting before the first fetch
  // resolved saw entry.data still null and called load() itself here, firing N
  // redundant requests for the same url in the same tick (measured: 8 real
  // subscribers x React StrictMode's 2x dev-mode effect invocation = 16 requests
  // for one URL on a single page load). load() now no-ops while already in
  // flight (see its own `entry.loading` guard above), so this call site didn't
  // need to change — any subscriber can safely call load(), and the eventual
  // response still reaches every subscriber in entry.subscribers, including ones
  // that joined after the fetch started.

  return () => {
    entry.subscribers.delete(setter);
    if (entry.subscribers.size === 0) {
      clearInterval(entry.intervalId);
      _cache.delete(url);
    }
  };
}

/**
 * Shared-subscription polling hook. Fetches `url` immediately, then every
 * `intervalMs` — but if another mounted component is already polling the same
 * `url`, this instance subscribes to that existing poll instead of starting a
 * second one. Returns `[data, error]`: `data` is null until the first response
 * (or immediate if another subscriber already has cached data); `error` is the
 * last fetch error's message, or null.
 */
export function useSharedPollData(url, intervalMs = 60000) {
  const [state, setState] = useState(() => {
    const entry = _cache.get(url);
    return { data: entry?.data ?? null, error: entry?.error ?? null };
  });
  useEffect(() => {
    if (!url) return;
    return subscribe(url, intervalMs, (data, error) => setState({ data, error }));
  }, [url, intervalMs]);
  return [state.data, state.error];
}

// For socket-driven "refresh now" call sites (e.g. a setup-detected event)
// that used to fire their own imperative fetch instead of waiting out the
// poll interval. Only refreshes an already-subscribed url — no-ops otherwise,
// since firing a fetch nobody is listening to would just be a wasted request.
export function refreshSharedPollData(url) {
  if (_cache.has(url)) load(url);
}
