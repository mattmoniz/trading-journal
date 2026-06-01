import React from 'react';
import { PieChart, Pie, Cell, ResponsiveContainer } from 'recharts';
import { formatNumber } from '../../utils/format.js';

export default function PerformanceVisuals({ stats, durationStats }) {
  return (
    <section className="analysis-row">
      <div className="analysis-card duration-card">
        <h2>Duration Analysis</h2>
        {durationStats.length > 0 ? (() => {
          const mostProfitable = [...durationStats].sort((a,b) => parseFloat(b.total_pnl) - parseFloat(a.total_pnl))[0];
          const highestWinRate = [...durationStats].sort((a,b) => parseFloat(b.win_rate) - parseFloat(a.win_rate))[0];
          const mostCommon = [...durationStats].sort((a,b) => parseInt(b.trade_count) - parseInt(a.trade_count))[0];
          const bestAvg = [...durationStats].sort((a,b) => parseFloat(b.avg_pnl) - parseFloat(a.avg_pnl))[0];
          return (
            <div className="duration-grid">
              <div className="duration-stat">
                <span className="duration-label">Most Profitable</span>
                <span className="duration-bucket">{mostProfitable.duration_bucket}</span>
                <span className="duration-value positive">${formatNumber(mostProfitable.total_pnl)}</span>
              </div>
              <div className="duration-stat">
                <span className="duration-label">Highest Win Rate</span>
                <span className="duration-bucket">{highestWinRate.duration_bucket}</span>
                <span className="duration-value positive">{formatNumber(highestWinRate.win_rate)}%</span>
              </div>
              <div className="duration-stat">
                <span className="duration-label">Most Common</span>
                <span className="duration-bucket">{mostCommon.duration_bucket}</span>
                <span className="duration-value">{formatNumber(mostCommon.trade_count, 0)} trades</span>
              </div>
              <div className="duration-stat">
                <span className="duration-label">Best Avg P&L</span>
                <span className="duration-bucket">{bestAvg.duration_bucket}</span>
                <span className="duration-value positive">${formatNumber(bestAvg.avg_pnl)}</span>
              </div>
            </div>
          );
        })() : <p className="sub-text">No duration data available</p>}
      </div>

      <div className="analysis-card pf-visual-card">
        <h2>Profit Factor</h2>
        {(() => {
          const pf = parseFloat(stats.profit_factor || 0);
          let label, color;
          if (pf >= 3)       { label = 'Excellent — Top-tier strategy'; color = '#10b981'; }
          else if (pf >= 2)  { label = 'Good';                           color = '#22c55e'; }
          else if (pf >= 1.5){ label = 'Average';                        color = '#f59e0b'; }
          else if (pf >= 1)  { label = 'Below Average';                  color = '#f97316'; }
          else               { label = 'Poor';                           color = '#ef4444'; }
          const pct = Math.min(100, (pf / 4) * 100);
          return (
            <>
              <p className="pf-big" style={{ color }}>{formatNumber(pf)}</p>
              <div className="pf-bar-track">
                <div className="pf-bar-fill" style={{ width: `${pct}%`, background: color }} />
              </div>
              <p className="pf-label" style={{ color }}>{label}</p>
              <div className="pf-gross">
                <div><span className="sub-text">Gross Profit</span><span className="positive"> ${formatNumber(stats.gross_profit)}</span></div>
                <div><span className="sub-text">Gross Loss</span><span className="negative"> ${formatNumber(stats.gross_loss)}</span></div>
              </div>
            </>
          );
        })()}
      </div>

      <div className="analysis-card wr-visual-card">
        <h2>Win Rate</h2>
        <div style={{ position: 'relative', height: '110px' }}>
          <ResponsiveContainer width="100%" height={110}>
            <PieChart>
              <Pie
                data={[
                  { value: parseFloat(stats.win_rate || 0) },
                  { value: Math.max(0, 100 - parseFloat(stats.win_rate || 0)) }
                ]}
                cx="50%" cy="100%"
                startAngle={180} endAngle={0}
                innerRadius={55} outerRadius={80}
                dataKey="value" strokeWidth={0}
              >
                <Cell fill="#10b981" />
                <Cell fill="#2d3354" />
              </Pie>
            </PieChart>
          </ResponsiveContainer>
          <div className="gauge-center-label">{formatNumber(stats.win_rate)}%</div>
        </div>
        <div className="wr-counts">
          <span className="positive">Wins: {formatNumber(stats.winning_trades || 0, 0)}</span>
          <span className="negative">Losses: {formatNumber(stats.losing_trades || 0, 0)}</span>
        </div>
      </div>
    </section>
  );
}
