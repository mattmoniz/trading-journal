import React, { useState, useEffect } from 'react';

import { API_URL } from '../../constants/api.js';

export default function VolatilityAlertBanner() {
  const [data, setData] = useState(null);
  const [dismissed, setDismissed] = useState(false);

  const fetchData = () =>
    fetch(`${API_URL}/vol-alert`).then(r => r.json()).then(setData).catch(() => {});

  useEffect(() => {
    fetchData();
    // Poll every 30s between 9:30–10:05 ET to catch OR expansion as it forms,
    // then every 5 min for the rest of the session.
    const fastInterval = setInterval(() => {
      const etMin = (() => {
        const now = new Date();
        const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
        return et.getHours() * 60 + et.getMinutes();
      })();
      fetchData();
      if (etMin >= 605) clearInterval(fastInterval); // stop fast-poll after 10:05 ET
    }, 30 * 1000);

    const slowInterval = setInterval(fetchData, 5 * 60 * 1000);
    return () => { clearInterval(fastInterval); clearInterval(slowInterval); };
  }, []);

  if (!data?.alert || dismissed) return null;

  const { sigma, on_range, avg_20d, threshold,
          or_alert, or_sigma, or_range, or_threshold, or_avg_20d,
          double_alert } = data;

  const onAlert = sigma >= 1.0;
  const isExtreme = sigma >= 2.0 || (or_alert && or_sigma >= 2.0);

  const bg     = isExtreme ? 'rgba(239,68,68,0.12)'  : 'rgba(251,146,60,0.10)';
  const border = isExtreme ? 'rgba(239,68,68,0.5)'   : 'rgba(251,146,60,0.45)';
  const color  = isExtreme ? '#ef4444'                : '#fb923c';

  const headline = double_alert
    ? '🚨 DOUBLE ALERT — OVERNIGHT + OR BOTH WIDE'
    : or_alert && !onAlert
    ? 'WIDE OPENING RANGE — HEAD ON A SWIVEL'
    : isExtreme
    ? 'EXTREME OVERNIGHT VOLATILITY'
    : 'ELEVATED OVERNIGHT RANGE — HEAD ON A SWIVEL';

  const body = double_alert
    ? `Overnight range ${on_range}pt (${sigma.toFixed(1)}σ) confirmed by wide OR ${or_range}pt (${or_sigma?.toFixed(1)}σ). ` +
      `Maximum caution: 50% size minimum, wait for OR to confirm direction before any entry.`
    : or_alert && !onAlert
    ? `Opening range ${or_range}pt is ${or_sigma?.toFixed(1)}σ above normal (avg ${or_avg_20d}pt · 1σ threshold ${or_threshold}pt). ` +
      `OR is running wide — 50% size, wait for balance before adding.`
    : isExtreme
    ? `Overnight range ${on_range}pt is ${sigma.toFixed(1)}σ above normal (avg ${avg_20d}pt · 1σ threshold ${threshold}pt). ` +
      `Reduce to 1 contract minimum. High whipsaw risk — wait for OR to confirm direction.`
    : `Overnight range ${on_range}pt is ${sigma.toFixed(1)}σ above normal (avg ${avg_20d}pt · 1σ threshold ${threshold}pt). ` +
      `50% size — wider moves mean bigger damage when stopped. Setups still fire; wait for OR direction first.` +
      (or_alert ? ` OR also wide: ${or_range}pt (${or_sigma?.toFixed(1)}σ).` : '');

  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
      gap: 12, padding: '10px 14px',
      background: bg, border: `1px solid ${border}`,
      borderRadius: 8, marginBottom: 2,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <span style={{ fontSize: '1.1rem', lineHeight: 1.4 }}>⚠️</span>
        <div>
          <div style={{ fontSize: '0.82rem', fontWeight: 700, color, letterSpacing: '0.05em', marginBottom: 2 }}>
            {headline}
          </div>
          <div style={{ fontSize: '0.79rem', color: '#cbd5e1', lineHeight: 1.5 }}>
            {body}
          </div>
        </div>
      </div>
      <button
        onClick={() => setDismissed(true)}
        style={{
          background: 'none', border: 'none', color: '#94a3b8',
          fontSize: '1rem', cursor: 'pointer', padding: '0 4px', lineHeight: 1, flexShrink: 0,
        }}
        title="Dismiss"
      >×</button>
    </div>
  );
}
