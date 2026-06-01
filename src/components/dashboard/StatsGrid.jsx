import React from 'react';
import { formatNumber } from '../../utils/format.js';

export default function StatsGrid({ stats }) {
  return (
    <div className="stats-grid">
      <div className="stat-card">
        <h3>Total P&L</h3>
        <p className={`big-number ${parseFloat(stats.total_pnl || 0) >= 0 ? 'positive' : 'negative'}`}>
          ${formatNumber(stats.total_pnl)}
        </p>
      </div>

      <div className="stat-card">
        <h3>Win Rate</h3>
        <p className="big-number">{formatNumber(stats.win_rate)}%</p>
        <p className="sub-text">
          {formatNumber(stats.winning_trades || 0, 0)}W / {formatNumber(stats.losing_trades || 0, 0)}L
        </p>
      </div>

      <div className="stat-card">
        <h3>Avg Trade</h3>
        <p className={`big-number ${parseFloat(stats.avg_pnl || 0) >= 0 ? 'positive' : 'negative'}`}>
          ${formatNumber(stats.avg_pnl)}
        </p>
      </div>

      <div className="stat-card">
        <h3>Best Trade</h3>
        <p className="big-number positive">${formatNumber(stats.best_trade)}</p>
      </div>

      <div className="stat-card">
        <h3>Worst Trade</h3>
        <p className="big-number negative">${formatNumber(stats.worst_trade)}</p>
      </div>

      <div className="stat-card">
        <h3>Total Trades</h3>
        <p className="big-number">{formatNumber(stats.total_trades || 0, 0)}</p>
      </div>

      <div className="stat-card">
        <h3>Profit Factor</h3>
        <p className={`big-number ${parseFloat(stats.profit_factor || 0) >= 1 ? 'positive' : 'negative'}`}>
          {formatNumber(stats.profit_factor || 0)}
        </p>
        <p className="sub-text">Gross Profit / Gross Loss</p>
      </div>

      <div className="stat-card">
        <h3>Avg Win / Loss</h3>
        <p className="big-number positive">${formatNumber(stats.avg_win)}</p>
        <p className="big-number negative">${formatNumber(stats.avg_loss)}</p>
      </div>

      <div className="stat-card">
        <h3>Max Drawdown</h3>
        <p className="big-number negative">${formatNumber(stats.max_drawdown)}</p>
        <p className="sub-text">
          Recovery: {stats.recovery_factor ? formatNumber(stats.recovery_factor) : 'N/A'}
        </p>
      </div>

      <div className="stat-card">
        <h3>Win/Loss Streaks</h3>
        <p className="big-number positive">{stats.longest_win_streak || 0}W</p>
        <p className="big-number negative">{stats.longest_loss_streak || 0}L</p>
      </div>
    </div>
  );
}
