import React from 'react';
import { BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { formatNumber } from '../../utils/format.js';

export default function BehaviorSection({ behaviorData }) {
  if (!behaviorData) return null;

  const fs = behaviorData.firstSessionStats;

  return (
    <section id="section-behavior" className="behavior-section">
      <h2>Trading Behavior Analysis <span className="sub-text">({behaviorData.totalDays} trading days)</span></h2>

      {/* Intraday Pattern Distribution */}
      <div className="behavior-grid">
        {behaviorData.patterns.map(p => {
          const colorMap = { cleanGreen:'#10b981', comeback:'#f59e0b', partial:'#3b82f6', gaveBack:'#f97316', mixed:'#8b5cf6', straightDown:'#ef4444' };
          const color = colorMap[p.key] || '#64748b';
          return (
            <div key={p.key} className="behavior-pattern-card" style={{ borderTop: `3px solid ${color}` }}>
              <div className="bp-label">{p.label}</div>
              <div className="bp-count">{p.count} <span className="sub-text">days</span></div>
              <div className={`bp-pnl ${p.avgPnl >= 0 ? 'positive' : 'negative'}`}>${formatNumber(p.avgPnl)} avg</div>
              <div className="bp-details">
                <span>Low: <span className="negative">${formatNumber(p.avgLow)}</span></span>
                <span>High: <span className="positive">${formatNumber(p.avgHigh)}</span></span>
                <span>Sess: {p.avgSessions}</span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Pattern bar chart */}
      <div className="behavior-charts-row">
        <div className="behavior-chart-block">
          <h3>Pattern Distribution — Avg Day P&L</h3>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={behaviorData.patterns} layout="vertical" margin={{ left: 120, right: 30 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#2d3354" horizontal={false} />
              <XAxis type="number" stroke="#94a3b8" tick={{fill:'#94a3b8',fontSize:11}} tickFormatter={v=>`$${formatNumber(v,0)}`} />
              <YAxis type="category" dataKey="label" stroke="#94a3b8" tick={{fill:'#94a3b8',fontSize:11}} width={120} />
              <Tooltip contentStyle={{backgroundColor:'#1a1f3a',border:'1px solid #2d3354'}} formatter={v=>[`$${formatNumber(v)}`, 'Avg P&L']} />
              <Bar dataKey="avgPnl" radius={[0,4,4,0]}>
                {behaviorData.patterns.map(p => {
                  const colorMap = { cleanGreen:'#10b981', comeback:'#f59e0b', partial:'#3b82f6', gaveBack:'#f97316', mixed:'#8b5cf6', straightDown:'#ef4444' };
                  return <Cell key={p.key} fill={colorMap[p.key] || '#64748b'} />;
                })}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Session count vs P&L */}
        <div className="behavior-chart-block">
          <h3>Session Count → Day Outcome</h3>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={behaviorData.sessionCounts} margin={{ left: 10, right: 30 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#2d3354" />
              <XAxis dataKey="label" stroke="#94a3b8" tick={{fill:'#94a3b8',fontSize:11}} />
              <YAxis stroke="#94a3b8" tick={{fill:'#94a3b8',fontSize:11}} tickFormatter={v=>`$${formatNumber(v,0)}`} />
              <Tooltip contentStyle={{backgroundColor:'#1a1f3a',border:'1px solid #2d3354'}}
                formatter={(v, name) => [name==='avgPnl' ? `$${formatNumber(v)}` : `${v}%`, name==='avgPnl' ? 'Avg P&L' : 'Win%']} />
              <Bar dataKey="avgPnl" name="avgPnl" radius={[4,4,0,0]}>
                {behaviorData.sessionCounts.map(s => <Cell key={s.bucket} fill={s.avgPnl >= 0 ? '#10b981' : '#ef4444'} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          <div className="session-count-legend">
            {behaviorData.sessionCounts.map(s => (
              <div key={s.bucket} className="sc-item">
                <span className="sc-label">{s.label}</span>
                <span className="sc-days">{s.days}d</span>
                <span className={`sc-wr ${s.winPct >= 50 ? 'positive' : 'negative'}`}>{s.winPct}%</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* First Session Impact */}
      <div className="first-session-section">
        <h3>First Session Impact</h3>
        <div className="first-session-grid">
          <div className="fs-card fs-win">
            <div className="fs-title">First Session WIN ({fs.winDays} days)</div>
            <div className="fs-stat">
              <span className="fs-label">Avg 1st session</span>
              <span className="positive">${formatNumber(fs.winAvgS1)}</span>
            </div>
            <div className="fs-stat">
              <span className="fs-label">Avg 2nd session</span>
              <span className={fs.winAvgS2 >= 0 ? 'positive' : 'negative'}>${formatNumber(fs.winAvgS2)}</span>
            </div>
            <div className="fs-stat">
              <span className="fs-label">Avg 3rd session</span>
              <span className={fs.winAvgS3 >= 0 ? 'positive' : 'negative'}>${formatNumber(fs.winAvgS3)}</span>
            </div>
            <div className="fs-stat fs-final">
              <span className="fs-label">Avg final P&L</span>
              <span className={fs.winAvgFinal >= 0 ? 'positive' : 'negative'}>${formatNumber(fs.winAvgFinal)}</span>
            </div>
            <div className="fs-outcome">
              <span className="positive">{fs.winStayedGreen}</span> / {fs.winDays} days ended green
              <span className="sub-text"> ({Math.round(fs.winStayedGreen/fs.winDays*100)}%)</span>
            </div>
          </div>
          <div className="fs-card fs-loss">
            <div className="fs-title">First Session LOSS ({fs.lossDays} days)</div>
            <div className="fs-stat">
              <span className="fs-label">Avg 1st session</span>
              <span className="negative">${formatNumber(fs.lossAvgS1)}</span>
            </div>
            <div className="fs-stat">
              <span className="fs-label">Avg 2nd session</span>
              <span className={fs.lossAvgS2 >= 0 ? 'positive' : 'negative'}>${formatNumber(fs.lossAvgS2)}</span>
            </div>
            <div className="fs-stat">
              <span className="fs-label">Avg 3rd session</span>
              <span className={fs.lossAvgS3 >= 0 ? 'positive' : 'negative'}>${formatNumber(fs.lossAvgS3)}</span>
            </div>
            <div className="fs-stat fs-final">
              <span className="fs-label">Avg final P&L</span>
              <span className={fs.lossAvgFinal >= 0 ? 'positive' : 'negative'}>${formatNumber(fs.lossAvgFinal)}</span>
            </div>
            <div className="fs-outcome">
              <span className="positive">{fs.lossRecoveredGreen}</span> / {fs.lossDays} days recovered green
              <span className="sub-text"> ({Math.round(fs.lossRecoveredGreen/fs.lossDays*100)}%)</span>
            </div>
          </div>
        </div>
      </div>

      {/* Re-entry Timing */}
      {Object.keys(behaviorData.reentry).length > 0 && (() => {
        const r = behaviorData.reentry;
        const rows = [
          { label: 'After LOSS — re-enter < 1 min', key: 'loss_under1', alert: true },
          { label: 'After LOSS — re-enter 1–5 min', key: 'loss_1to5', alert: false },
          { label: 'After LOSS — re-enter > 5 min', key: 'loss_over5', alert: false },
          { label: 'After WIN — re-enter < 1 min', key: 'win_under1', alert: false },
          { label: 'After WIN — re-enter > 1 min', key: 'win_over1', alert: false },
        ].filter(row => r[row.key]);
        return (
          <div className="reentry-section">
            <h3>Re-entry Timing After Previous Session</h3>
            <p className="sub-text" style={{marginBottom:'12px'}}>How quickly you jump back in after a win or loss, and whether it helps or hurts.</p>
            <table className="behavior-table">
              <thead>
                <tr>
                  <th>Scenario</th>
                  <th>Instances</th>
                  <th>Avg Next Session</th>
                  <th>Win Rate</th>
                  <th>Insight</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(row => {
                  const d = r[row.key];
                  const isGood = d.avgPnl > 0 && d.winPct >= 45;
                  return (
                    <tr key={row.key} className={row.alert ? 'alert-row' : ''}>
                      <td>{row.label}</td>
                      <td>{d.count}</td>
                      <td className={d.avgPnl >= 0 ? 'positive' : 'negative'}>${formatNumber(d.avgPnl)}</td>
                      <td className={d.winPct >= 50 ? 'positive' : 'negative'}>{d.winPct}%</td>
                      <td className="sub-text">{row.alert && d.avgPnl < 0 ? '⚠ Revenge trading risk' : isGood ? '✓ Good discipline' : ''}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
      })()}
    </section>
  );
}
