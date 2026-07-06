import React, { useState, useEffect } from 'react';
import { confidenceTier } from '../../utils/confidenceTier.js';

const API_URL = '/api';
const fmtP = (n) => n == null ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });

export default function ScalpPlaybookCard({ date }) {
  const [data, setData] = useState(null);
  const [approachData, setApproachData] = useState(null);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    const d = date || new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    fetch(`${API_URL}/morning-brief/scalp-playbook/${d}`).then(r => r.json()).then(setData).catch(() => {});
  }, [date]);

  useEffect(() => {
    fetch(`${API_URL}/level-approach/today`).then(r => r.json()).then(setApproachData).catch(() => {});
  }, []);

  if (!data) return null;
  const ts = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  return (
    <div style={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 8, padding: '12px 16px', marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }} onClick={() => setCollapsed(!collapsed)}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: '#4ade80' }}>Scalp Playbook — {data.dayOfWeek}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 11, color: '#94a3b8' }}>{ts}</span>
          <span style={{ fontSize: 12, color: '#94a3b8' }}>{collapsed ? '▸' : '▾'}</span>
        </div>
      </div>

      {!collapsed && (
        <div style={{ marginTop: 8, fontSize: 12, lineHeight: 1.7, color: '#cbd5e1' }}>
          {data.priorSession && (
            <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 6 }}>
              Prior: {data.priorSession.type} ({data.priorSession.range}pt, closed at {data.priorSession.closePct}%)
              {data.nextDayTendency && <> · After {data.nextDayTendency.afterType}: {data.nextDayTendency.upPct}% up, ~{data.nextDayTendency.avgNextRange}pt range</>}
            </div>
          )}

          {data.topDowCombos?.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#4ade80', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 3 }}>
                {data.dayOfWeek} Best Level Fades
              </div>
              {data.topDowCombos.map((p, i) => {
                const label = p.pattern.slice(p.pattern.indexOf(':') + 1);
                return (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                    <span style={{ fontFamily: 'monospace', fontSize: 11, color: p.wr >= 75 ? '#4ade80' : '#cbd5e1' }}>{label}</span>
                    <span style={{ fontSize: 11 }}>
                      <span style={{ color: p.wr >= 75 ? '#4ade80' : '#fbbf24', fontWeight: 700 }}>{p.wr}%</span> · <span style={{ color: confidenceTier(p.n).color }} title={confidenceTier(p.n).title}>{confidenceTier(p.n).label}</span> · ${p.pnl}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {data.bestHours?.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#818cf8', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 3 }}>
                Best Level × Time Windows
              </div>
              {data.bestHours.slice(0, 5).map((p, i) => {
                const parts = p.pattern.slice(p.pattern.indexOf(':') + 1).split('×');
                return (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                    <span style={{ fontFamily: 'monospace', fontSize: 11 }}>{parts[0]} @ {parts[1]}</span>
                    <span style={{ fontSize: 11 }}>
                      <span style={{ color: p.wr >= 75 ? '#4ade80' : '#fbbf24', fontWeight: 700 }}>{p.wr}%</span> · <span style={{ color: confidenceTier(p.n).color }} title={confidenceTier(p.n).title}>{confidenceTier(p.n).label}</span>
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {approachData?.setups?.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#38bdf8', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 3 }}>
                Setup Anticipation — {approachData.day_type ?? 'ALL'} {approachData.dow}
                <span style={{ fontSize: 11, fontWeight: 400, color: '#94a3b8', marginLeft: 6 }}>fire% · WR · exp$/session</span>
              </div>
              {approachData.setups.slice(0, 10).map((r, i) => {
                const label = r.setup.replace(/_FADE_?(LONG|SHORT)?$/, '').replace(/_/g, ' ') +
                  (r.setup.endsWith('_LONG') || r.setup.includes('_FADE_LONG') ? ' ↑' :
                   r.setup.endsWith('_SHORT') || r.setup.includes('_FADE_SHORT') ? ' ↓' : '');
                const fr = r.fire_rate != null ? (r.fire_rate * 100).toFixed(0) + '%' : '?';
                const wr = r.cond_wr  != null ? (r.cond_wr  * 100).toFixed(0) + '%' : '?';
                const ev = r.expected_ev != null ? '$' + r.expected_ev.toFixed(0) : '';
                const frColor = r.fire_rate >= 0.25 ? '#4ade80' : r.fire_rate >= 0.12 ? '#fbbf24' : '#94a3b8';
                const wrColor = r.cond_wr  >= 0.75 ? '#4ade80' : r.cond_wr  >= 0.60 ? '#fbbf24' : '#f87171';
                return (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                    <span style={{ fontFamily: 'monospace', fontSize: 11, color: '#e2e8f0' }}>{label}</span>
                    <span style={{ fontSize: 11 }}>
                      <span style={{ color: frColor, fontWeight: 700 }}>{fr}</span>
                      <span style={{ color: '#94a3b8' }}> · </span>
                      <span style={{ color: wrColor }}>{wr}</span>
                      {ev && <><span style={{ color: '#94a3b8' }}> · </span><span style={{ color: '#a78bfa', fontWeight: 700 }}>{ev}</span></>}
                      <span style={{ color: '#94a3b8', fontSize: 11, marginLeft: 4 }}>N={r.n}</span>
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {data.pipelineSetups?.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#f472b6', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 3 }}>
                Pipeline Setups to Watch
              </div>
              {data.pipelineSetups.map((s, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                  <span style={{ fontFamily: 'monospace', fontSize: 11 }}>{s.setup.replace(/_/g, ' ')}</span>
                  <span style={{ fontSize: 11, color: '#94a3b8' }}>
                    {s.wr != null ? <><span style={{ color: s.wr >= 60 ? '#4ade80' : s.wr >= 45 ? '#fbbf24' : '#f87171', fontWeight: 700 }}>{s.wr}%</span> <span style={{ color: confidenceTier(s.n).color }} title={confidenceTier(s.n).title}>({confidenceTier(s.n).label})</span></> : `${s.fires} fires`}
                    {s.timeWindow && <> · <span style={{ color: '#94a3b8' }}>{s.timeWindow}</span></>}
                  </span>
                </div>
              ))}
            </div>
          )}

          {data.coilWatch?.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#f97316', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 3 }}>
                Coil Watch — Drought Setups
              </div>
              {data.coilWatch.map((c, i) => (
                <div key={i} style={{ padding: '2px 0', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ fontFamily: 'monospace', fontSize: 11 }}>{c.setup.replace(/_/g, ' ')}</span>
                    <span style={{ fontSize: 11, color: c.currentStreak >= 6 ? '#f97316' : '#fbbf24', fontWeight: 700 }}>{c.currentStreak} consecutive losses</span>
                  </div>
                  {c.coiled && c.coilRatio && (
                    <div style={{ fontSize: 12, color: '#f97316' }}>COILED — next win avg ${c.avgDroughtWin} ({c.coilRatio}x normal). Hold for runner.</div>
                  )}
                </div>
              ))}
            </div>
          )}

          {data.balanceZones?.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#8b5cf6', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 3 }}>
                Active Balance Zones
              </div>
              {data.balanceZones.map((z, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0', fontSize: 11 }}>
                  <span style={{ fontFamily: 'monospace', color: '#c4b5fd' }}>{fmtP(z.low)} — {fmtP(z.high)}</span>
                  <span style={{ color: '#94a3b8' }}>{z.width}pt · edges fade 84%</span>
                </div>
              ))}
            </div>
          )}

          {data.newDiscoveries?.length > 0 && (
            <div style={{ padding: '4px 8px', background: 'rgba(251,191,36,0.1)', borderRadius: 4, border: '1px solid rgba(251,191,36,0.2)', marginBottom: 8 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#fbbf24', textTransform: 'uppercase' }}>New Patterns Detected</div>
              {data.newDiscoveries.map((p, i) => (
                <div key={i} style={{ fontSize: 11, color: '#fbbf24', marginTop: 2 }}>
                  {p.pattern.split(':').pop()} — {p.wr}% WR (N={p.n})
                </div>
              ))}
            </div>
          )}

        </div>
      )}
    </div>
  );
}
