import React from 'react';
import {
  LineChart, Line, BarChart, Bar, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts';
import { formatNumber } from '../../utils/format.js';

function getDateRangeTitle(filters) {
  switch (filters.dateRange) {
    case 'today': return 'Today';
    case 'week': return 'Last 7 Days';
    case 'month': return 'Last 30 Days';
    case '3months': return 'Last 90 Days';
    case 'custom':
      if (filters.dateFrom && filters.dateTo) {
        return `${new Date(filters.dateFrom).toLocaleDateString()} - ${new Date(filters.dateTo).toLocaleDateString()}`;
      } else if (filters.dateFrom) {
        return `From ${new Date(filters.dateFrom).toLocaleDateString()}`;
      } else if (filters.dateTo) {
        return `Until ${new Date(filters.dateTo).toLocaleDateString()}`;
      }
      return 'Custom Range';
    default: return 'All Time';
  }
}

export default function PnlCharts({ cumulativePnl, dailyPerf, hourlyStats, dayOfWeekStats, filters }) {
  const title = getDateRangeTitle(filters);

  return (
    <>
      <section id="section-pnl" className="chart-section">
        <h2>Cumulative P&L - {title}</h2>
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={cumulativePnl}>
            <CartesianGrid strokeDasharray="3 3" stroke="#2d3354" />
            <XAxis
              dataKey="log_date"
              stroke="#94a3b8"
              tick={{fill: '#94a3b8', fontSize: 13}}
              minTickGap={['today','week','month','3months'].includes(filters.dateRange) ? 20 : 50}
              tickFormatter={(date) => {
                const d = new Date(date);
                if (['today','week','month','3months'].includes(filters.dateRange)) {
                  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                }
                return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
              }}
            />
            <YAxis
              stroke="#94a3b8"
              tick={{fill: '#94a3b8'}}
              tickFormatter={(value) => `$${formatNumber(value, 0)}`}
            />
            <Tooltip
              contentStyle={{ backgroundColor: '#1a1f3a', border: '1px solid #2d3354', borderRadius: '8px' }}
              labelStyle={{ color: '#e2e8f0' }}
              itemStyle={{ color: '#8b5cf6' }}
              formatter={(value) => [`$${formatNumber(value)}`, 'Cumulative P&L']}
              labelFormatter={(date) => new Date(date).toLocaleDateString()}
            />
            {/* Add reference lines for year boundaries */}
            {cumulativePnl.length > 0 && (() => {
              const years = {};
              cumulativePnl.forEach(entry => {
                const year = new Date(entry.log_date).getFullYear();
                if (!years[year]) {
                  years[year] = entry.log_date;
                }
              });
              return Object.entries(years).map(([year, date]) => (
                <ReferenceLine
                  key={year}
                  x={date}
                  stroke="#64748b"
                  strokeDasharray="3 3"
                  label={{ value: year, position: 'top', fill: '#94a3b8', fontSize: 13 }}
                />
              ));
            })()}
            <Line
              type="monotone"
              dataKey="cumulative_pnl"
              stroke="#8b5cf6"
              strokeWidth={2}
              dot={false}
              name="Cumulative P&L"
            />
          </LineChart>
        </ResponsiveContainer>
      </section>

      <div className="chart-grid-3">
        <section className="chart-section">
          <h2>Daily P&L - {title}</h2>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={dailyPerf}>
              <CartesianGrid strokeDasharray="3 3" stroke="#2d3354" />
              <XAxis
                dataKey="log_date"
                stroke="#94a3b8"
                tick={{fill: '#94a3b8'}}
                tickFormatter={(date) => new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
              />
              <YAxis
                stroke="#94a3b8"
                tick={{fill: '#94a3b8'}}
                tickFormatter={(value) => `$${formatNumber(value, 0)}`}
              />
              <Tooltip
                contentStyle={{ backgroundColor: '#1a1f3a', border: '1px solid #2d3354', borderRadius: '8px' }}
                labelStyle={{ color: '#e2e8f0' }}
                formatter={(value) => `$${formatNumber(value)}`}
                labelFormatter={(date) => new Date(date).toLocaleDateString()}
                cursor={{ fill: 'rgba(255, 255, 255, 0.05)' }}
              />
              <Bar
                dataKey="daily_pnl"
                fill="#8b5cf6"
                name="Daily P&L"
                radius={[4, 4, 0, 0]}
              >
                {dailyPerf.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={parseFloat(entry.daily_pnl) >= 0 ? '#10b981' : '#ef4444'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </section>

        <section id="section-hour" className="chart-section">
          <h2>By Hour of Day - {title}</h2>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={hourlyStats}>
              <CartesianGrid strokeDasharray="3 3" stroke="#2d3354" />
              <XAxis
                dataKey="hour"
                stroke="#94a3b8"
                tick={{fill: '#94a3b8'}}
                label={{ value: 'Hour (ET)', position: 'insideBottom', offset: -5, fill: '#94a3b8' }}
              />
              <YAxis
                stroke="#94a3b8"
                tick={{fill: '#94a3b8'}}
                tickFormatter={(value) => `$${formatNumber(value, 0)}`}
              />
              <Tooltip
                contentStyle={{ backgroundColor: '#1a1f3a', border: '1px solid #2d3354', borderRadius: '8px' }}
                labelStyle={{ color: '#e2e8f0' }}
                formatter={(value, name) => {
                  if (name === 'Total P&L') return [`$${formatNumber(value)}`, name];
                  if (name === 'Avg P&L') return [`$${formatNumber(value)}`, name];
                  if (name === 'Win Rate') return [`${formatNumber(value)}%`, name];
                  if (name === 'Trades') return [formatNumber(value, 0), name];
                  return [value, name];
                }}
                labelFormatter={(hour) => `${hour}:00 - ${hour}:59 ET`}
                cursor={{ fill: 'rgba(255, 255, 255, 0.05)' }}
              />
              <Bar
                dataKey="total_pnl"
                fill="#8b5cf6"
                name="Total P&L"
                radius={[4, 4, 0, 0]}
              >
                {hourlyStats.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={parseFloat(entry.total_pnl) >= 0 ? '#10b981' : '#ef4444'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </section>

        <section id="section-dow" className="chart-section">
          <h2>By Day of Week - {title}</h2>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={dayOfWeekStats}>
              <CartesianGrid strokeDasharray="3 3" stroke="#2d3354" />
              <XAxis
                dataKey="day_name"
                stroke="#94a3b8"
                tick={{fill: '#94a3b8'}}
              />
              <YAxis
                stroke="#94a3b8"
                tick={{fill: '#94a3b8'}}
                tickFormatter={(value) => `$${formatNumber(value, 0)}`}
              />
              <Tooltip
                contentStyle={{ backgroundColor: '#1a1f3a', border: '1px solid #2d3354', borderRadius: '8px' }}
                labelStyle={{ color: '#e2e8f0' }}
                formatter={(value, name) => {
                  if (name === 'Total P&L') return [`$${formatNumber(value)}`, name];
                  if (name === 'Avg P&L') return [`$${formatNumber(value)}`, name];
                  if (name === 'Win Rate') return [`${formatNumber(value)}%`, name];
                  if (name === 'Trades') return [formatNumber(value, 0), name];
                  return [value, name];
                }}
                cursor={{ fill: 'rgba(255, 255, 255, 0.05)' }}
              />
              <Bar
                dataKey="total_pnl"
                fill="#8b5cf6"
                name="Total P&L"
                radius={[4, 4, 0, 0]}
              >
                {dayOfWeekStats.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={parseFloat(entry.total_pnl) >= 0 ? '#10b981' : '#ef4444'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </section>
      </div>
    </>
  );
}
