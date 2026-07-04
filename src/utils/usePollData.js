import { useState, useEffect } from 'react';

/**
 * Generic polling hook. Fetches `url` immediately, then every `intervalMs`.
 * Handles cleanup (cancelled flag + clearInterval) automatically.
 * Returns null until the first successful response.
 */
export function usePollData(url, intervalMs = 60000) {
  const [data, setData] = useState(null);
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    const load = () => fetch(url)
      .then(r => r.json())
      .then(d => { if (!cancelled) setData(d); })
      .catch(() => {});
    load();
    const iv = setInterval(load, intervalMs);
    return () => { cancelled = true; clearInterval(iv); };
  }, [url, intervalMs]);
  return data;
}
