import React from 'react';
import { formatNumber } from '../../utils/format.js';

export default function PerformanceVisuals({ durationStats }) {
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
    </section>
  );
}
