import React from 'react';
import { formatNumber } from '../../utils/format.js';

export default function SetupsTable({ setupStats }) {
  return (
    <section id="section-setups" className="setup-stats-section">
      <h2>Performance by Setup</h2>
      <div className="setup-stats-table">
        <table>
          <thead>
            <tr>
              <th>Setup Type</th>
              <th>Trades</th>
              <th>Win Rate</th>
              <th>Avg P&L</th>
              <th>Total P&L</th>
            </tr>
          </thead>
          <tbody>
            {setupStats.map(setup => (
              <tr key={setup.setup_type}>
                <td>{setup.setup_type}</td>
                <td>{formatNumber(setup.trade_count, 0)}</td>
                <td>{formatNumber(setup.win_rate)}%</td>
                <td className={parseFloat(setup.avg_pnl) >= 0 ? 'positive' : 'negative'}>
                  ${formatNumber(setup.avg_pnl)}
                </td>
                <td className={parseFloat(setup.total_pnl) >= 0 ? 'positive' : 'negative'}>
                  ${formatNumber(setup.total_pnl)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
