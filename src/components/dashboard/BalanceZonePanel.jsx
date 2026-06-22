import React, { useState, useEffect } from 'react';

const API_URL = '/api';
const fmtP = (n) => n == null ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });

export default function BalanceZonePanel() {
  const [zone, setZone] = useState(null);
  const [edgeData, setEdgeData] = useState(null);
  const [price, setPrice] = useState(null);
  const [loaded, setLoaded] = useState(false);

  // Fetch zone + edge data ONCE on mount
  useEffect(() => {
    const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    Promise.all([
      fetch(`${API_URL}/morning-brief/forecast/${todayET}`).then(r => r.json()).catch(() => null),
      fetch(`${API_URL}/antigravity/edges-context`).then(r => r.json()).catch(() => null),
    ]).then(([fc, ed]) => {
      setZone(fc?.balanceZone || null);
      setEdgeData(ed);
      setPrice(ed?.liveStatus?.currentPrice || null);
      setLoaded(true);
    });
  }, []);

  // Poll only the live price every 60 seconds
  useEffect(() => {
    const fetchPrice = () => {
      fetch(`${API_URL}/acd/gap-context`).then(r => r.json()).then(d => {
        if (d.currentPrice) setPrice(d.currentPrice);
      }).catch(() => {});
    };
    const iv = setInterval(fetchPrice, 60000);
    return () => clearInterval(iv);
  }, []);

  if (!loaded || !price) return null;

  const bz = zone;
  const cl = edgeData?.confluenceLevels;
  const poc = cl?.pd1?.poc;

  const hasZone = bz?.active;
  const isInside = hasZone && price >= bz.low && price <= bz.high;
  const isAbove = hasZone && price > bz.high;
  const isBelow = hasZone && price < bz.low;
  const excursion = isAbove ? price - bz.high : isBelow ? bz.low - price : 0;

  const magnets = [];
  if (poc) magnets.push({ name: 'POC', price: poc, dist: Math.abs(price - poc) });
  if (cl?.pd1?.vah) magnets.push({ name: 'VAH', price: cl.pd1.vah, dist: Math.abs(price - cl.pd1.vah) });
  if (cl?.pd1?.val) magnets.push({ name: 'VAL', price: cl.pd1.val, dist: Math.abs(price - cl.pd1.val) });
  if (hasZone) {
    magnets.push({ name: 'Zone Hi', price: bz.high, dist: Math.abs(price - bz.high) });
    magnets.push({ name: 'Zone Lo', price: bz.low, dist: Math.abs(price - bz.low) });
  }
  magnets.sort((a, b) => a.dist - b.dist);
  const nearest = magnets[0];

  let statusColor, statusText, contextText;
  if (!hasZone) {
    statusColor = '#f59e0b';
    statusText = 'NO BALANCE ZONE';
    contextText = 'Value migrating — directional day possible. Go with momentum, don\'t fade.';
  } else if (isInside) {
    statusColor = '#22c55e';
    statusText = 'INSIDE ZONE';
    const pctPos = ((price - bz.low) / (bz.high - bz.low) * 100).toFixed(0);
    contextText = `${pctPos}% up in zone. ${Math.round(bz.high - price)}pt to ceiling, ${Math.round(price - bz.low)}pt to floor. Fade the edges.`;
  } else if (isAbove) {
    statusColor = excursion > 29 ? '#ef4444' : '#f59e0b';
    statusText = `ABOVE ZONE (+${Math.round(excursion)}pt)`;
    contextText = excursion > 29 ? 'Past avg excursion (29pt). If 15+ bars outside → breakout is real.' : 'Within normal excursion range. 65% return within 5 bars.';
  } else {
    statusColor = excursion > 29 ? '#ef4444' : '#f59e0b';
    statusText = `BELOW ZONE (-${Math.round(excursion)}pt)`;
    contextText = excursion > 29 ? 'Past avg excursion (29pt). If 15+ bars outside → breakout is real.' : 'Within normal excursion range. 65% return within 5 bars.';
  }

  return (
    <div style={{ padding: '8px 14px', background: 'rgba(15,23,42,0.5)', border: `1px solid ${statusColor}30`, borderLeft: `3px solid ${statusColor}`, borderRadius: 6, marginBottom: 10, fontSize: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 9, fontWeight: 800, color: statusColor, background: `${statusColor}18`, padding: '2px 6px', borderRadius: 3, letterSpacing: '0.04em' }}>{statusText}</span>
          {hasZone && <span style={{ fontFamily: 'monospace', fontWeight: 700, color: '#cbd5e1' }}>{fmtP(bz.low)} — {fmtP(bz.high)}</span>}
          {hasZone && <span style={{ color: '#64748b', fontSize: 11 }}>{bz.age}d · {Math.round(bz.high - bz.low)}pt</span>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ color: '#94a3b8', fontSize: 11 }}>NQ: <strong style={{ color: '#e2e8f0', fontFamily: 'monospace' }}>{fmtP(price)}</strong></span>
          {nearest && <span style={{ color: '#64748b', fontSize: 10 }}>→ {nearest.name} {fmtP(nearest.price)} ({Math.round(nearest.dist)}pt)</span>}
        </div>
      </div>
      <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>{contextText}</div>
    </div>
  );
}
