import React, { useState, useEffect, useCallback } from 'react';
import SyncProgressPanel from './SyncProgressPanel.jsx';
import DashboardFilters from './DashboardFilters.jsx';
import MarketRecapPanel from './MarketRecapPanel.jsx';
import PerformanceVisuals from './PerformanceVisuals.jsx';
import PnlCharts from './PnlCharts.jsx';
import SetupsTable from './SetupsTable.jsx';
import OptimizationSection from './OptimizationSection.jsx';
import BehaviorSection from './BehaviorSection.jsx';

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
  ChartReviewComponent,
}) {
  const [dailyPerf, setDailyPerf] = useState([]);
  const [setupStats, setSetupStats] = useState([]);
  const [cumulativePnl, setCumulativePnl] = useState([]);
  const [durationStats, setDurationStats] = useState([]);
  const [behaviorData, setBehaviorData] = useState(null);
  const [optData, setOptData] = useState(null);
  const [tradeLocData, setTradeLocData] = useState(null);
  const [keyLevelsData, setKeyLevelsData] = useState(null);
  const [klProximity, setKlProximity] = useState(2.5);
  const [klTimeframe, setKlTimeframe] = useState('all');

  const todayStr = new Date().toLocaleDateString('en-CA');
  const [recapDate, setRecapDate] = useState(todayStr);
  const [recapData, setRecapData] = useState(null);
  const [recapLoading, setRecapLoading] = useState(false);

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

  useEffect(() => {
    if (!recapDate) return;
    setRecapLoading(true);
    setRecapData(null);
    const accts = selectedAccounts.length ? `&account=${selectedAccounts.join(',')}` : '';
    fetch(`${API_URL}/chart/live-day?date=${recapDate}${accts}`)
      .then(r => r.json())
      .then(j => setRecapData(j.error ? null : j))
      .catch(() => {})
      .finally(() => setRecapLoading(false));
  }, [recapDate, selectedAccounts]);

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

      const [dailyRes, setupRes, cumulativeRes, durationRes, behaviorRes, optRes, locRes] = await Promise.all([
        fetch(`${API_URL}/stats/daily${baseQuery}`),
        fetch(`${API_URL}/stats/by-setup${baseQuery}`),
        fetch(`${API_URL}/stats/cumulative-pnl${baseQuery}`),
        fetch(`${API_URL}/stats/by-duration${baseQuery}`),
        fetch(`${API_URL}/stats/behavior${accountOnlyQuery}`),
        fetch(`${API_URL}/stats/optimization${baseQuery}`),
        fetch(`${API_URL}/stats/trade-location${baseQuery}`),
      ]);

      setDailyPerf(await dailyRes.json());
      setSetupStats(await setupRes.json());
      setCumulativePnl(await cumulativeRes.json());
      setDurationStats(await durationRes.json());
      setBehaviorData(await behaviorRes.json());
      setOptData(await optRes.json());
      const locJson = await locRes.json();
      setTradeLocData(locJson.error ? null : locJson);
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

      <MarketRecapPanel
        recapDate={recapDate}
        setRecapDate={setRecapDate}
        dailyPerf={dailyPerf}
        selectedAccounts={selectedAccounts}
        recapData={recapData}
        recapLoading={recapLoading}
        ChartReviewComponent={ChartReviewComponent}
      />

      <PerformanceVisuals durationStats={durationStats} />

      <PnlCharts
        cumulativePnl={cumulativePnl}
        dailyPerf={dailyPerf}
        filters={filters}
      />

      <SetupsTable setupStats={setupStats} />

      <OptimizationSection optData={optData} tradeLocData={tradeLocData} />

      <BehaviorSection behaviorData={behaviorData} />
    </div>
  );
}
