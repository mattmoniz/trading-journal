import React, { useState, useEffect, useCallback } from 'react';
import { BarChart, Bar, ComposedChart, Line, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, ResponsiveContainer } from 'recharts';
import SyncProgressPanel from './SyncProgressPanel.jsx';
import DashboardFilters from './DashboardFilters.jsx';
import PnlCharts from './PnlCharts.jsx';
import DevelopingValueCard from './DevelopingValueCard.jsx';
import LevelMonitorPanel from './LevelMonitorPanel.jsx';

const API_URL = '/api';

export default function DashboardView({
  accounts,
  selectedAccounts,
  setSelectedAccounts,
  addToast,
  syncing,
  syncProgress,
  syncLog = [],
  onSyncTrades,
  onDismissSync,
}) {
  const [dailyPerf, setDailyPerf] = useState([]);
  const [cumulativePnl, setCumulativePnl] = useState([]);
  const [keyLevelsData, setKeyLevelsData] = useState(null);
  const [klProximity, setKlProximity] = useState(2.5);
  const [klTimeframe, setKlTimeframe] = useState('all');
  const [riskStats, setRiskStats] = useState(null);     // Sharpe/Sortino/Kelly from tearsheet-overview
  const [rolling, setRolling] = useState([]);            // rolling 20-trade expectancy
  const [pnlDist, setPnlDist] = useState(null);          // trade P&L distribution

  const todayStr = new Date().toLocaleDateString('en-CA');
  const [recapDate, setRecapDate] = useState(todayStr);

  const [filters, setFilters] = useState({
    dateRange: 'today',
    dateFrom: '',
    dateTo: '',
  });

  // On mount: if no trades today, switch date filter to the last trading day
  useEffect(() => {
    const todayStr = new Date().toLocaleDateString('en-CA');
    fetch(`${API_URL}/accounts?days=0`)
      .then(r => r.json())
      .then(todayAccts => {
        if (Array.isArray(todayAccts) && todayAccts.length > 0) return null; // trades today — keep 'today' filter
        return fetch(`${API_URL}/accounts/last-day`).then(r => r.json());
      })
      .then(lastDay => {
        if (lastDay?.accounts?.length > 0) {
          setFilters(f => ({ ...f, dateRange: 'week' }));
        }
      })
      .catch(() => {});
  }, []);


  const fetchKeyLevels = useCallback(async (baseParams) => {
    try {
      const today = new Date();
      const todayStr = today.toISOString().split('T')[0];
      const year = today.getFullYear();
      const qs = new URLSearchParams(baseParams || '');
      qs.set('prox', klProximity);

      if (klTimeframe !== 'all') {
        let dateFrom, dateTo = todayStr;
        const sub = (months) => { const d = new Date(today); d.setMonth(d.getMonth() - months); return d.toISOString().split('T')[0]; };
        if (klTimeframe === '1w')  dateFrom = new Date(today - 7*86400000).toISOString().split('T')[0];
        else if (klTimeframe === '1m')  dateFrom = sub(1);
        else if (klTimeframe === '3m')  dateFrom = sub(3);
        else if (klTimeframe === '6m')  dateFrom = sub(6);
        else if (klTimeframe === '1y')  dateFrom = sub(12);
        else if (klTimeframe === 'q1')  { dateFrom = `${year}-01-01`; dateTo = `${year}-03-31`; }
        else if (klTimeframe === 'q2')  { dateFrom = `${year}-04-01`; dateTo = `${year}-06-30`; }
        else if (klTimeframe === 'q3')  { dateFrom = `${year}-07-01`; dateTo = `${year}-09-30`; }
        else if (klTimeframe === 'q4')  { dateFrom = `${year}-10-01`; dateTo = `${year}-12-31`; }
        if (dateFrom) qs.set('dateFrom', dateFrom);
        if (dateTo)   qs.set('dateTo', dateTo);
        if (selectedAccounts.length) qs.set('account', selectedAccounts.join(','));
      }

      const r = await fetch(`${API_URL}/stats/key-levels?${qs.toString()}`);
      const j = await r.json();
      setKeyLevelsData(j.error ? null : j);
    } catch (_) {}
  }, [klTimeframe, klProximity, selectedAccounts]);

  const fetchAllStats = async () => {
    try {
      const params = new URLSearchParams();

      if (filters.dateRange !== 'all') {
        const today = new Date();
        let dateFrom = null;

        switch (filters.dateRange) {
          case 'today':
            dateFrom = today.toISOString().split('T')[0];
            params.append('dateFrom', dateFrom);
            params.append('dateTo', dateFrom);
            break;
          case 'week':
            dateFrom = new Date(today.setDate(today.getDate() - 7)).toISOString().split('T')[0];
            params.append('dateFrom', dateFrom);
            break;
          case 'month':
            dateFrom = new Date(today.setMonth(today.getMonth() - 1)).toISOString().split('T')[0];
            params.append('dateFrom', dateFrom);
            break;
          case '3months':
            dateFrom = new Date(today.setMonth(today.getMonth() - 3)).toISOString().split('T')[0];
            params.append('dateFrom', dateFrom);
            break;
          case 'custom':
            if (filters.dateFrom) params.append('dateFrom', filters.dateFrom);
            if (filters.dateTo) params.append('dateTo', filters.dateTo);
            break;
        }
      }

      if (selectedAccounts.length > 0) {
        params.append('account', selectedAccounts.join(','));
      }

      const queryString = params.toString();
      const baseQuery = queryString ? `?${queryString}` : '';

      // Behavioral stats are structural truths — always all-time, never date-filtered.
      // Only the account filter applies so multi-account setups still scope correctly.
      const accountOnlyQuery = selectedAccounts.length > 0
        ? `?account=${selectedAccounts.join(',')}`
        : '';

      const [dailyRes, cumulativeRes, riskRes, rollingRes, distRes] = await Promise.all([
        fetch(`${API_URL}/stats/daily${baseQuery}`),
        fetch(`${API_URL}/stats/cumulative-pnl${baseQuery}`),
        fetch(`${API_URL}/stats/tearsheet-overview${accountOnlyQuery}`),
        fetch(`${API_URL}/stats/rolling${accountOnlyQuery}`),
        fetch(`${API_URL}/stats/pnl-distribution${accountOnlyQuery}`),
      ]);

      setDailyPerf(await dailyRes.json());
      setCumulativePnl(await cumulativeRes.json());
      const riskJson = await riskRes.json();
      setRiskStats(riskJson.sharpe != null ? riskJson : null);
      const rollingJson = await rollingRes.json();
      setRolling(Array.isArray(rollingJson) ? rollingJson : []);
      const distJson = await distRes.json();
      setPnlDist(distJson?.buckets ? distJson : null);
      fetchKeyLevels(queryString);
    } catch (error) {
      console.error('Error fetching stats:', error);
    }
  };

  useEffect(() => {
    fetchAllStats();
  }, [filters, selectedAccounts]);

  useEffect(() => {
    if (klTimeframe !== 'all') fetchKeyLevels();
  }, [klTimeframe, klProximity, selectedAccounts]);

  const handleDateRangeChange = (range) => setFilters({ ...filters, dateRange: range });
  const handleCustomDateChange = (field, value) => setFilters({ ...filters, [field]: value });

  return (
    <div className="dashboard-view">
      <header className="page-header">
        <h1>Performance Dashboard</h1>
        <button className="btn btn-primary sync-btn" onClick={onSyncTrades} disabled={syncing}>
          {syncing ? '⏳ Syncing...' : '⬇ Sync Trades'}
        </button>
      </header>

      {(syncProgress || syncLog.length > 0) && (
        <SyncProgressPanel
          syncProgress={syncProgress}
          syncLog={syncLog}
          onDismissSync={onDismissSync}
        />
      )}

      <DashboardFilters
        accounts={accounts}
        selectedAccounts={selectedAccounts}
        setSelectedAccounts={setSelectedAccounts}
        filters={filters}
        onDateRangeChange={handleDateRangeChange}
        onCustomDateChange={handleCustomDateChange}
      />

      <LevelMonitorPanel date={recapDate} />

      <DevelopingValueCard date={recapDate} title="Developing Value — Today's Session" windows={[5, 10, 20]} />


      <PnlCharts
        cumulativePnl={cumulativePnl}
        dailyPerf={dailyPerf}
        filters={filters}
      />


      {/* ── Risk-Adjusted Performance ── */}
      {riskStats && (
        <div className="dashboard-card" style={{ padding: '16px 20px' }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>
            Risk-Adjusted Performance
          </h3>
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
            {[
              { label: 'Sharpe Ratio',  value: riskStats.sharpe },
              { label: 'Sortino Ratio', value: riskStats.sortino },
              { label: 'Expectancy',    value: riskStats.expectancy != null ? `$${parseFloat(riskStats.expectancy).toFixed(2)}` : null },
              { label: 'Kelly %',       value: riskStats.kelly != null ? `${riskStats.kelly}%` : null },
            ].map(({ label, value }) => value != null && (
              <div key={label} style={{ textAlign: 'center', minWidth: 90 }}>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>{label}</div>
                <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-primary)' }}>{value}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Rolling 20-Trade Expectancy ── */}
      {rolling.length > 0 && (
        <div className="dashboard-card" style={{ padding: '16px 20px' }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>
            Rolling 20-Trade Expectancy &amp; Win Rate
          </h3>
          <ResponsiveContainer width="100%" height={180}>
            <ComposedChart data={rolling} margin={{ top: 4, right: 40, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis dataKey="index" tick={{ fontSize: 12, fill: 'var(--text-muted)' }} tickFormatter={v => `T${v}`} />
              <YAxis yAxisId="exp" tick={{ fontSize: 12, fill: 'var(--text-muted)' }} tickFormatter={v => `$${v}`} width={52} />
              <YAxis yAxisId="wr" orientation="right" tick={{ fontSize: 12, fill: 'var(--text-muted)' }} tickFormatter={v => `${v}%`} width={38} domain={[0, 100]} />
              <Tooltip
                contentStyle={{ background: 'var(--card-bg)', border: '1px solid var(--border-color)', fontSize: 12 }}
                formatter={(v, n) => n === 'win_rate' ? [`${v}%`, 'Win Rate'] : [`$${parseFloat(v).toFixed(2)}`, 'Expectancy']}
              />
              <ReferenceLine yAxisId="exp" y={0} stroke="rgba(255,255,255,0.2)" />
              <Bar yAxisId="exp" dataKey="expectancy" radius={[1, 1, 0, 0]}>
                {rolling.map((e, i) => <Cell key={i} fill={e.expectancy >= 0 ? 'rgba(99,102,241,0.6)' : 'rgba(239,68,68,0.6)'} />)}
              </Bar>
              <Line yAxisId="wr" type="monotone" dataKey="win_rate" stroke="#f59e0b" strokeWidth={2} dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* ── Trade P&L Distribution ── */}
      {pnlDist && (
        <div className="dashboard-card" style={{ padding: '16px 20px' }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
            Trade P&amp;L Distribution
          </h3>
          <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 8 }}>
            Mean: <span style={{ color: parseFloat(pnlDist.mean) >= 0 ? '#10b981' : '#ef4444' }}>${parseFloat(pnlDist.mean).toFixed(2)}</span>
            &nbsp;&nbsp;Median: <span style={{ color: parseFloat(pnlDist.median) >= 0 ? '#10b981' : '#ef4444' }}>${parseFloat(pnlDist.median).toFixed(2)}</span>
          </div>
          <ResponsiveContainer width="100%" height={140}>
            <BarChart data={pnlDist.buckets} margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis dataKey="range" tick={{ fontSize: 12, fill: 'var(--text-muted)' }} tickFormatter={v => `$${v}`} />
              <YAxis tick={{ fontSize: 12, fill: 'var(--text-muted)' }} allowDecimals={false} width={32} />
              <Tooltip
                contentStyle={{ background: 'var(--card-bg)', border: '1px solid var(--border-color)', fontSize: 12 }}
                formatter={(v) => [v, 'Trades']}
                labelFormatter={v => `$${v} to $${+v + 50}`}
              />
              <Bar dataKey="count" radius={[2, 2, 0, 0]}>
                {pnlDist.buckets.map((e, i) => <Cell key={i} fill={e.range >= 0 ? '#10b981' : '#ef4444'} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
