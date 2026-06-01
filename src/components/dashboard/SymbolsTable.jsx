import React from 'react';
import { formatNumber } from '../../utils/format.js';

export default function SymbolsTable({ topSymbols }) {
  return (
    <section id="section-symbols" className="setup-stats-section">
      <h2>Top Performing Symbols</h2>
      <div className="setup-stats-table">
        <table>
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Trades</th>
              <th>Win Rate</th>
              <th>Avg P&L</th>
              <th>Total P&L</th>
            </tr>
          </thead>
          <tbody>
            {topSymbols.map(symbol => (
              <tr key={symbol.symbol}>
                <td><strong>{symbol.symbol}</strong></td>
                <td>{formatNumber(symbol.trade_count, 0)}</td>
                <td>{formatNumber(symbol.win_rate)}%</td>
                <td className={parseFloat(symbol.avg_pnl) >= 0 ? 'positive' : 'negative'}>
                  ${formatNumber(symbol.avg_pnl)}
                </td>
                <td className={parseFloat(symbol.total_pnl) >= 0 ? 'positive' : 'negative'}>
                  ${formatNumber(symbol.total_pnl)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
