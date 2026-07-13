import React from 'react';

const API_URL = '/api';

export function useLiveCase() {
  const [caseData, setCaseData] = React.useState(null);
  const [loading, setLoading]   = React.useState(true);

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
      .then(d => { if (!d.error) setCaseData(d); })
      .catch(() => {})
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

  return { caseData, loading };
}

export const CaseContext = React.createContext({ caseData: null, loading: true });

export function CaseProvider({ children }) {
  const value = useLiveCase();
  return <CaseContext.Provider value={value}>{children}</CaseContext.Provider>;
}
