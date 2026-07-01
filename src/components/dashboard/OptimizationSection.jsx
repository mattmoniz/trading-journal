const fmtP = (n, d = 0) => n == null ? '—' : Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
import React from 'react';
import { formatNumber } from '../../utils/format.js';
import { confidenceTier } from '../../utils/confidenceTier.js';
import { SectionUpdateDot } from '../shared/UpdateDot.jsx';

function Histogram({ data, color, title, subtitle, markerPct }) {
  const maxPct = Math.max(...data.map(d => d.pct));
  return (
    <div style={{ background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderRadius: 8, padding: 16 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>{title}</div>
      <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>{subtitle}</div>
      {data.map((b, i) => {
        const barW = maxPct > 0 ? b.pct / maxPct * 100 : 0;
        const isMarker = markerPct && i === data.findIndex((_, idx) => {
          const cumPct = data.slice(0, idx + 1).reduce((a, d) => a + d.pct, 0);
          return cumPct >= markerPct;
        });
        return (
          <div key={b.label} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, position: 'relative' }}>
            <div style={{ width: 52, fontSize: 13, color: 'var(--text-muted)', textAlign: 'right', flexShrink: 0 }}>{b.label}</div>
            <div style={{ flex: 1, height: 16, background: 'rgba(255,255,255,0.05)', borderRadius: 3, position: 'relative', overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${barW}%`, background: color, opacity: 0.8, borderRadius: 3, transition: 'width 0.3s' }} />
              {isMarker && (
                <div style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 2, background: 'rgba(255,255,255,0.7)' }} title="75th percentile (suggestion)" />
              )}
            </div>
            <div style={{ width: 38, fontSize: 13, color: 'var(--text-secondary)', textAlign: 'right', flexShrink: 0 }}>{b.count > 0 ? `${b.pct}%` : ''}</div>
          </div>
        );
      })}
    </div>
  );
}

export default function OptimizationSection({ optData, tradeLocData }) {
  if (!optData || !optData.summary) return null;
  const s = optData.summary;

  return (
    <section id="section-optimization" className="behavior-section">
      <h2>Trade Optimization <span style={{ fontSize: 13, fontWeight: 400, color: 'var(--text-muted)' }}>— per individual trade, using 1-min bars</span><SectionUpdateDot id="optimization-stops-2026-06" /></h2>

      {/* Trade range visual */}
      {s.avgMfe != null && (() => {
        const mae   = Math.abs(s.avgMae);
        const mfe   = s.avgMfe;
        const act   = s.avgActualPts;
        const total = mae + mfe;
        const maePct = mae / total * 100;
        const actPct = (mae + Math.max(0, act)) / total * 100;
        return (
          <div style={{ background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderRadius: 8, padding: '16px 20px', marginBottom: 24 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Average Trade Range</div>
            <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>
              Where price typically goes after your entry — red = against you, green = in your favor, white line = where you actually exited
            </div>
            <div style={{ position: 'relative', height: 32, borderRadius: 4, overflow: 'hidden', display: 'flex' }}>
              <div style={{ width: `${maePct}%`, background: 'rgba(239,68,68,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, color: '#fff', fontWeight: 600 }}>
                {mae > 0 ? `−${mae.toFixed(1)} pts` : ''}
              </div>
              <div style={{ flex: 1, background: 'rgba(16,185,129,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, color: '#fff', fontWeight: 600 }}>
                {mfe > 0 ? `+${mfe.toFixed(1)} pts` : ''}
              </div>
              <div style={{ position: 'absolute', left: `${maePct}%`, top: 0, bottom: 0, width: 2, background: '#fff', zIndex: 2 }} title="Entry" />
              {act > 0 && (
                <div style={{ position: 'absolute', left: `${actPct}%`, top: 0, bottom: 0, width: 2, background: '#fbbf24', zIndex: 2 }} title={`Avg exit: +${act} pts`} />
              )}
            </div>
            <div style={{ display: 'flex', gap: 20, marginTop: 8, fontSize: 13, color: 'var(--text-muted)' }}>
              <span><span style={{ color: '#ef4444' }}>■</span> Max against (MAE)</span>
              <span><span style={{ color: '#10b981' }}>■</span> Max in your favor (MFE)</span>
              <span><span style={{ color: '#fff' }}>│</span> Entry</span>
              {act > 0 && <span><span style={{ color: '#fbbf24' }}>│</span> Avg exit: +{act.toFixed(1)} pts | MFE capture (winners): {s.avgMfeCapture}%</span>}
            </div>
          </div>
        );
      })()}

      {/* Histograms + VWAP */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 20, marginBottom: 24 }}>
        <Histogram
          data={optData.mfeDist || []}
          color="#10b981"
          title="MFE Distribution"
          subtitle="How far price moved in your favor (pts)"
          markerPct={75}
        />
        <Histogram
          data={optData.winMaeDist || []}
          color="#ef4444"
          title="MAE Distribution (Winners only)"
          subtitle="How far winners dipped before recovering (pts)"
          markerPct={75}
        />

        {/* VWAP context */}
        <div style={{ background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderRadius: 8, padding: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>VWAP Context at Entry</div>
          <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>RTH VWAP from 9:30 — long above / short below = with trend</div>
          {optData.byVwap && optData.byVwap.length > 0 ? optData.byVwap.map(r => (
            <div key={r.label} style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
                <span>{r.label}</span>
                <span style={{ color: r.avg_pnl >= 0 ? 'var(--accent-green)' : 'var(--accent-red)' }}>${r.avg_pnl} avg</span>
              </div>
              <div style={{ height: 20, background: 'rgba(255,255,255,0.05)', borderRadius: 3, overflow: 'hidden', position: 'relative' }}>
                <div style={{ height: '100%', width: `${r.win_rate}%`, background: r.win_rate >= 50 ? 'rgba(16,185,129,0.7)' : 'rgba(239,68,68,0.7)', borderRadius: 3 }} />
                <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, background: 'rgba(255,255,255,0.3)' }} />
                <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, color: '#fff' }}>
                  {r.win_rate}% win rate ({r.count} trades)
                </div>
              </div>
            </div>
          )) : <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No VWAP data</div>}
        </div>
      </div>

      {/* Volume Profile Location Analysis */}
      {tradeLocData && tradeLocData.byLocation?.length > 0 && (() => {
        const loc = tradeLocData.byLocation;
        const locationDesc = {
          'In LVN':        'Low volume zone — price travels fast, target next HVN',
          'At HVN':        'High volume zone — institutional level, expect stall or reversal',
          'At POC':        'Session fair value — contested, expect two-sided action',
          'At VAH':        'Value area high — resistance zone, long unfavorable',
          'At VAL':        'Value area low — support zone, short unfavorable',
          'Above VAH':     'Above accepted value — breakout or overextended',
          'Below VAL':     'Below accepted value — breakdown or undervalued',
          'In Value Area': 'Between VAL and VAH — inside session fair value range',
        };
        const maxCount = Math.max(...loc.map(r => r.count));
        return (
          <>
            <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12, color: 'var(--text-secondary)' }}>
              Volume Profile Location at Entry <span style={{ fontWeight: 400, fontSize: 13 }}>(RTH profile built to entry time)</span>
            </h3>
            <div style={{ background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderRadius: 8, marginBottom: 24, overflow: 'hidden' }}>
              {loc.map((r, i) => {
                const barW = r.count / maxCount * 100;
                return (
                  <div key={r.location} style={{ display: 'grid', gridTemplateColumns: '140px 1fr 60px 70px 90px', alignItems: 'center', gap: 12, padding: '10px 16px',
                    borderBottom: i < loc.length - 1 ? '1px solid var(--border-color)' : 'none',
                    background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)' }}>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{r.location}</div>
                    <div style={{ position: 'relative' }}>
                      <div style={{ height: 20, background: 'rgba(255,255,255,0.05)', borderRadius: 3, overflow: 'hidden' }}>
                        <div style={{ height: '100%', width: `${barW}%`, borderRadius: 3,
                          background: r.win_rate >= 55 ? 'rgba(16,185,129,0.6)' : r.win_rate < 40 ? 'rgba(239,68,68,0.6)' : 'rgba(139,92,246,0.5)' }} />
                      </div>
                      <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', paddingLeft: 8, fontSize: 13, color: '#fff', textShadow: '0 1px 2px rgba(0,0,0,0.8)', fontWeight: 500 }}>
                        {locationDesc[r.location] || ''}
                      </div>
                    </div>
                    <div style={{ fontSize: 13, color: 'var(--text-secondary)', textAlign: 'right' }}>{r.count} trades</div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: r.win_rate >= 50 ? 'var(--accent-green)' : 'var(--accent-red)', textAlign: 'right' }}>{r.win_rate}% WR</div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: r.avg_pnl >= 0 ? 'var(--accent-green)' : 'var(--accent-red)', textAlign: 'right' }}>${r.avg_pnl} avg</div>
                  </div>
                );
              })}
            </div>
          </>
        );
      })()}

      {/* Per-hour TP/Stop breakdown */}
      {optData.byHour && optData.byHour.length > 0 && (
        <>
          <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12, color: 'var(--text-secondary)' }}>
            Performance by Hour <span style={{ fontWeight: 400, fontSize: 13 }}>(entry hour ET — MFE/MAE/TP targets from bar data)</span>
          </h3>
          <div style={{ background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderRadius: 8, overflow: 'hidden', marginBottom: 24 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-color)', background: 'rgba(255,255,255,0.03)' }}>
                  {['Hour', 'Trades', 'Win Rate', 'Avg P&L', 'Avg MFE', 'Avg MAE', 'TP / Stop (p75 winners)', 'Verdict'].map(h => (
                    <th key={h} style={{ padding: '8px 12px', textAlign: 'left', color: 'var(--text-muted)', fontWeight: 500 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {optData.byHour.map(r => {
                  const good = r.win_rate >= 50 && r.avg_pnl > 0;
                  const bad  = r.win_rate < 40 && r.avg_pnl < 0;
                  return (
                    <tr key={r.hour} style={{ borderBottom: '1px solid var(--border-color)', background: good ? 'rgba(16,185,129,0.05)' : bad ? 'rgba(239,68,68,0.05)' : 'transparent' }}>
                      <td style={{ padding: '10px 12px', fontWeight: 600 }}>{r.hour}:00 – {r.hour}:59</td>
                      <td style={{ padding: '10px 12px' }}>{r.count}</td>
                      <td style={{ padding: '10px 12px', fontWeight: 600 }} title={confidenceTier(r.count).title}><span style={{ color: r.win_rate >= 50 ? 'var(--accent-green)' : 'var(--accent-red)' }}>{r.win_rate}%</span> <span style={{ color: confidenceTier(r.count).color, fontSize: 11, fontWeight: 400 }}>({confidenceTier(r.count).label})</span></td>
                      <td style={{ padding: '10px 12px', color: r.avg_pnl >= 0 ? 'var(--accent-green)' : 'var(--accent-red)', fontWeight: 600 }}>${r.avg_pnl}</td>
                      <td style={{ padding: '10px 12px', color: 'var(--text-secondary)' }}>{r.avg_mfe != null ? `${r.avg_mfe} pts` : '—'}</td>
                      <td style={{ padding: '10px 12px', color: 'var(--text-secondary)' }}>{r.avg_mae != null ? `${Math.abs(r.avg_mae)} pts` : '—'}</td>
                      <td style={{ padding: '10px 12px' }}>
                        {r.mfe_p75 != null
                          ? <span>
                              <span style={{ color: 'var(--accent-green)', fontWeight: 600 }}>+{r.mfe_p75}</span>
                              <span style={{ color: 'var(--text-muted)', margin: '0 4px' }}>/</span>
                              <span style={{ color: 'var(--accent-red)', fontWeight: 600 }}>-{r.mae_p75 ?? '?'}</span>
                              <span style={{ color: 'var(--text-muted)', marginLeft: 4 }}>pts</span>
                            </span>
                          : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                      </td>
                      <td style={{ padding: '10px 12px', fontSize: 13 }}>
                        {good ? <span style={{ color: 'var(--accent-green)' }}>✓ Strong window</span>
                              : bad ? <span style={{ color: 'var(--accent-red)' }}>⚠ Avoid</span>
                              : <span style={{ color: 'var(--text-muted)' }}>Neutral</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Stop Placement — simulated P&L at various stop distances */}
      {optData.stopPlacement && optData.stopPlacement.length > 0 && (
        <>
          <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 6, color: 'var(--text-secondary)' }}>
            Stop Placement Analysis <span style={{ fontWeight: 400, fontSize: 13 }}>(simulated: what if you exited at exactly this stop distance?)</span>
          </h3>
          <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>
            Positive delta = tighter stop would have improved total outcome vs actual. All values in NQ points.
          </div>
          <div style={{ background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderRadius: 8, overflow: 'hidden', marginBottom: 24 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-color)', background: 'rgba(255,255,255,0.03)' }}>
                  {['Stop (pts)', 'Trades Stopped', '% Hit', 'Sim Total (pts)', 'Actual Total (pts)', 'Delta (pts)'].map(h => (
                    <th key={h} style={{ padding: '8px 12px', textAlign: h === 'Stop (pts)' ? 'left' : 'right', color: 'var(--text-muted)', fontWeight: 500 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {optData.stopPlacement.map((r, i) => {
                  const better = r.delta_pts > 0;
                  const neutral = r.pct_stopped === 0;
                  return (
                    <tr key={r.stop_dist} style={{ borderBottom: '1px solid var(--border-color)', background: neutral ? 'rgba(255,255,255,0.02)' : better ? 'rgba(16,185,129,0.05)' : 'transparent' }}>
                      <td style={{ padding: '9px 12px', fontWeight: 700 }}>{r.stop_dist}</td>
                      <td style={{ padding: '9px 12px', textAlign: 'right' }}>{r.stopped_count}</td>
                      <td style={{ padding: '9px 12px', textAlign: 'right', color: r.pct_stopped > 50 ? 'var(--accent-red)' : 'var(--text-secondary)' }}>{r.pct_stopped}%</td>
                      <td style={{ padding: '9px 12px', textAlign: 'right', color: r.sim_pnl_pts >= 0 ? 'var(--accent-green)' : 'var(--accent-red)', fontWeight: 600 }}>{r.sim_pnl_pts > 0 ? '+' : ''}{r.sim_pnl_pts}</td>
                      <td style={{ padding: '9px 12px', textAlign: 'right', color: 'var(--text-muted)' }}>{r.actual_pnl_pts > 0 ? '+' : ''}{r.actual_pnl_pts}</td>
                      <td style={{ padding: '9px 12px', textAlign: 'right', fontWeight: 700, color: better ? 'var(--accent-green)' : neutral ? 'var(--text-muted)' : 'var(--accent-red)' }}>
                        {r.delta_pts > 0 ? '+' : ''}{r.delta_pts}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

    </section>
  );
}
