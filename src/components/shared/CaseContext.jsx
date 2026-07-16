import React from 'react';

import { API_URL } from '../../constants/api.js';

export function useLiveCase() {
  const [caseData, setCaseData] = React.useState(null);
  const [loading, setLoading]   = React.useState(true);
  const [error, setError]       = React.useState(null);

  const todayET = React.useMemo(
    () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }),
    []
  );

  const load = React.useCallback(() => {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const hh  = String(now.getHours()).padStart(2, '0');
    const mm  = String(now.getMinutes()).padStart(2, '0');
    fetch(`${API_URL}/case?date=${todayET}&asOf=${hh}:${mm}`)
      .then(r => r.json())
      .then(d => {
        if (!d.error) { setCaseData(d); setError(null); }
        // noData/isWeekend are expected non-error states, not a broken endpoint —
        // matches the filter TradeAlertBanner's health check used to apply itself.
        else setError(!d.noData && !d.isWeekend ? d.error : null);
      })
      .catch(() => setError('unreachable'))
      .finally(() => setLoading(false));
  }, [todayET]);

  React.useEffect(() => {
    load();
    const iv   = setInterval(load, 10000);
    const sock = window._tradingSocket;
    if (sock) {
      sock.on('price-sync-progress', load);
      sock.on('setup-detected',      load);
      sock.on('setup-state',         load);
    }
    return () => {
      clearInterval(iv);
      if (sock) {
        sock.off('price-sync-progress', load);
        sock.off('setup-detected',      load);
        sock.off('setup-state',         load);
      }
    };
  }, [load]);

  return { caseData, loading, error };
}

export const CaseContext = React.createContext({ caseData: null, loading: true, error: null });

export function CaseProvider({ children }) {
  const value = useLiveCase();
  return <CaseContext.Provider value={value}>{children}</CaseContext.Provider>;
}
