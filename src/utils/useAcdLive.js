import { useState, useEffect } from 'react';

import { API_URL } from '../constants/api.js';

/**
 * Polls /api/acd/live every `intervalMs` ms.
 * Filters out error responses — only updates state on clean data.
 */
export function useAcdLive(intervalMs = 30000) {
  const [data, setData] = useState(null);
  useEffect(() => {
    let cancelled = false;
    const load = () => fetch(`${API_URL}/acd/live`)
      .then(r => r.json())
      .then(d => { if (!cancelled && d && !d.error) setData(d); })
      .catch(() => {});
    load();
    const iv = setInterval(load, intervalMs);
    return () => { cancelled = true; clearInterval(iv); };
  }, [intervalMs]);
  return data;
}
