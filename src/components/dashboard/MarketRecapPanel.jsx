import React, { useState } from 'react';
import RecapDatePicker from './RecapDatePicker.jsx';
import { useRecapObservations } from '../../hooks/useRecapObservations.js';

export default function MarketRecapPanel({
  recapDate,
  setRecapDate,
  dailyPerf,
  selectedAccounts,
  recapData,
  recapLoading,
  ChartReviewComponent,
}) {
  const [setupChartModal, setSetupChartModal] = useState(null); // { date, levelKey }
  const recapObs = useRecapObservations(recapData);

  return (
    <>
      <div style={{ marginBottom: 24, padding: '14px 18px', background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderRadius: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: recapObs.length ? 12 : 0 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>Market Recap</span>
          <RecapDatePicker value={recapDate} onChange={setRecapDate} dailyPerf={dailyPerf} />
          {recapLoading && <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>Loading…</span>}
          {!recapLoading && !recapData && recapDate && <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>No price bar data for this date</span>}
        </div>
        {recapObs.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {recapObs.map((o, i) => {
              if (o.type === 'setups') {
                const { setupHits, bestSetup } = o;
                return (
                  <div key={i} style={{ marginTop: 6, paddingTop: 10, borderTop: '1px solid var(--border-color)' }}>
                    {/* Trade of the Day */}
                    {bestSetup && (
                      <div
                        onClick={() => bestSetup.date && setSetupChartModal({ date: bestSetup.date, levelKey: bestSetup.key })}
                        style={{ marginBottom: 12, padding: '12px 16px', borderRadius: 8, background: 'rgba(139,92,246,0.08)', border: '1px solid rgba(139,92,246,0.3)', cursor: bestSetup.date ? 'pointer' : 'default', transition: 'background 0.1s' }}
                        onMouseEnter={e => { if (bestSetup.date) e.currentTarget.style.background = 'rgba(139,92,246,0.15)'; }}
                        onMouseLeave={e => { e.currentTarget.style.background = 'rgba(139,92,246,0.08)'; }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--accent-purple)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>★ Trade of the Day</span>
                          {bestSetup.isConfluence && (
                            <span style={{ fontSize: 13, padding: '1px 7px', borderRadius: 10, background: 'rgba(251,191,36,0.15)', color: '#fbbf24', border: '1px solid rgba(251,191,36,0.3)', fontWeight: 600 }}>
                              confluence
                            </span>
                          )}
                          <span style={{ marginLeft: 'auto', fontSize: 13, color: 'var(--text-muted)' }}>click to view chart</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>{bestSetup.names}</span>
                          <span style={{ fontSize: 13, color: 'var(--text-muted)', fontFamily: 'monospace' }}>{bestSetup.price.toFixed(2)}</span>
                          <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>@ {bestSetup.timeStr}</span>
                          <span style={{ fontSize: 13, fontWeight: 600, padding: '2px 8px', borderRadius: 4,
                            color: bestSetup.side === 'support' ? '#34d399' : '#f87171',
                            background: bestSetup.side === 'support' ? 'rgba(52,211,153,0.1)' : 'rgba(248,113,113,0.1)',
                            border: `1px solid ${bestSetup.side === 'support' ? 'rgba(52,211,153,0.3)' : 'rgba(248,113,113,0.3)'}` }}>
                            {bestSetup.side === 'support' ? '↓ support' : '↑ resistance'}
                          </span>
                          <span style={{ fontSize: 13, fontWeight: 700, color: bestSetup.outcomeType === 'held' ? 'var(--accent-green)' : 'var(--accent-red)' }}>
                            {bestSetup.outcomeType === 'held' ? '✓' : '✗'} {bestSetup.outcome}
                          </span>
                          <span style={{ fontSize: 13, color: '#a78bfa', fontWeight: 700 }}>→ {bestSetup.mfe}pt</span>
                        </div>
                        {bestSetup.isConfluence && (
                          <div style={{ marginTop: 5, fontSize: 13, color: 'var(--text-muted)' }}>
                            Multiple levels aligned at the same zone — {bestSetup.setups.map(s => s.name).join(', ')}
                          </div>
                        )}
                      </div>
                    )}
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 7 }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                        Formal Setups Within ±20 pts
                      </span>
                      <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>— levels price made a directional approach to; excludes levels price opened near</span>
                    </div>
                    {setupHits.length === 0 ? (
                      <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>No formal setups came within range today</span>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {setupHits.map((s, j) => {
                          const held = s.outcomeType === 'held';
                          const isSupport = s.side === 'support';
                          const outcomeColor = held ? 'var(--accent-green)' : 'var(--accent-red)';
                          const sideColor = isSupport ? '#34d399' : '#f87171';
                          const isBest = bestSetup && s.name === bestSetup.name && s.timeStr === bestSetup.timeStr && s.side === bestSetup.side;
                          return (
                            <div key={j}
                              onClick={() => s.date && setSetupChartModal({ date: s.date, levelKey: s.key })}
                              style={{
                                display: 'grid',
                                gridTemplateColumns: '56px 130px 80px 62px 110px 1fr auto',
                                alignItems: 'center',
                                gap: 10,
                                padding: '7px 12px',
                                borderRadius: 7,
                                background: isBest ? 'rgba(139,92,246,0.06)' : 'rgba(255,255,255,0.03)',
                                border: isBest ? '1px solid rgba(139,92,246,0.35)' : `1px solid ${held ? 'rgba(52,211,153,0.12)' : 'rgba(248,113,113,0.12)'}`,
                                fontSize: 13,
                                cursor: s.date ? 'pointer' : 'default',
                                transition: 'background 0.1s',
                              }}
                              onMouseEnter={e => { if (s.date) e.currentTarget.style.background = 'rgba(139,92,246,0.08)'; }}
                              onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.03)'; }}>
                              <span style={{ fontSize: 13, padding: '2px 7px', borderRadius: 8, textAlign: 'center',
                                background: 'rgba(139,92,246,0.12)', color: 'var(--accent-purple)',
                                border: '1px solid rgba(139,92,246,0.25)', fontWeight: 600, whiteSpace: 'nowrap' }}>{s.category}</span>
                              <span style={{ color: 'var(--text-primary)', fontWeight: 700 }}>{s.name}</span>
                              <span style={{ color: 'var(--text-muted)', fontFamily: 'monospace', fontSize: 13 }}>{s.price.toFixed(2)}</span>
                              <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>@ {s.timeStr}</span>
                              <span style={{ color: sideColor, fontSize: 13, fontWeight: 600, padding: '2px 8px', borderRadius: 4, textAlign: 'center',
                                background: isSupport ? 'rgba(52,211,153,0.08)' : 'rgba(248,113,113,0.08)',
                                border: `1px solid ${isSupport ? 'rgba(52,211,153,0.2)' : 'rgba(248,113,113,0.2)'}` }}>
                                {isSupport ? '↓ support' : '↑ resistance'}
                              </span>
                              <span style={{ color: outcomeColor, fontSize: 13, fontWeight: 700 }}>
                                {held ? '✓' : '✗'} {s.outcome}
                              </span>
                              <span style={{ color: '#a78bfa', fontSize: 13, textAlign: 'right', whiteSpace: 'nowrap' }}>
                                {s.mfe > 0 ? `${s.mfe}pt` : ''}
                                {isBest && <span style={{ marginLeft: 6, fontSize: 13, color: 'var(--accent-purple)', fontWeight: 700 }}>★ best</span>}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              }
              return (
                <div key={i} style={{ display: 'flex', alignItems: 'baseline', gap: 9, fontSize: 13, lineHeight: 1.5 }}>
                  <span style={{
                    flexShrink: 0, width: 20, textAlign: 'center', fontWeight: 700, fontSize: 13,
                    color: o.type === 'green' ? 'var(--accent-green)' : o.type === 'red' ? 'var(--accent-red)' : o.type === 'info' ? 'var(--accent-purple)' : 'var(--text-muted)'
                  }}>{o.icon}</span>
                  <span style={{ color: o.type === 'neutral' ? 'var(--text-muted)' : 'var(--text-secondary)' }}>{o.text}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Setup chart modal */}
      {setupChartModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 20000, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '40px 60px' }}
          onClick={e => { if (e.target === e.currentTarget) setSetupChartModal(null); }}>
          <div style={{ background: '#0d1117', border: '1px solid var(--border-color)', borderRadius: 10, display: 'flex', flexDirection: 'column', overflow: 'hidden', width: '100%', maxWidth: 1100, maxHeight: 'calc(100vh - 80px)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderBottom: '1px solid var(--border-color)', flexShrink: 0 }}>
              <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--text-primary)' }}>
                {new Date(setupChartModal.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}
              </span>
              <button onClick={() => setSetupChartModal(null)} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 18, cursor: 'pointer', padding: '2px 6px', lineHeight: 1 }}>✕</button>
            </div>
            <div style={{ overflow: 'auto', flex: 1 }}>
              <ChartReviewComponent selectedAccounts={selectedAccounts} initialDate={setupChartModal.date} initialLevelKey={setupChartModal.levelKey} />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
