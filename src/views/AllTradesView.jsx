import React, { useState, useEffect, useMemo } from 'react';
import { formatNumber } from '../utils/format.js';
import CalendarView from './CalendarView.jsx';

import { API_URL } from '../constants/api.js';

function AllTradesView({ addToast, syncing, onSyncTrades, accounts: calendarAccounts, selectedAccounts: calendarSelectedAccounts, setSelectedAccounts: calendarSetSelectedAccounts, initialTab = 'trades', setCurrentView }) {
  const [tradesTab, setTradesTab] = useState(initialTab);
  const [allTrades, setAllTrades] = useState([]);
  const [filteredTrades, setFilteredTrades] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({
    symbol: '',
    direction: '',
    dateFrom: '',
    dateTo: '',
    minPnl: '',
    maxPnl: '',
    setupType: '',
    account: ''
  });
  const [currentPage, setCurrentPage] = useState(1);
  const [expandedTrade, setExpandedTrade] = useState(null);
  const [viewMode, setViewMode] = useState('net'); // 'fills' | 'net'
  const [expandedGroups, setExpandedGroups] = useState(new Set());
  const tradesPerPage = 50;

  useEffect(() => {
    fetchAllTrades();
  }, []);

  useEffect(() => {
    applyFilters();
  }, [filters, allTrades]);

  const fetchAllTrades = async () => {
    try {
      setLoading(true);
      const response = await fetch(`${API_URL}/trades`);
      const trades = await response.json();
      setAllTrades(trades);
      setFilteredTrades(trades);
    } catch (error) {
      console.error('Error fetching all trades:', error);
    } finally {
      setLoading(false);
    }
  };

  const applyFilters = () => {
    let filtered = [...allTrades];

    if (filters.symbol) {
      filtered = filtered.filter(t =>
        t.symbol?.toLowerCase().includes(filters.symbol.toLowerCase())
      );
    }

    if (filters.direction) {
      filtered = filtered.filter(t => t.direction === filters.direction);
    }

    if (filters.dateFrom) {
      filtered = filtered.filter(t => t.log_date >= filters.dateFrom);
    }

    if (filters.dateTo) {
      filtered = filtered.filter(t => t.log_date <= filters.dateTo);
    }

    if (filters.minPnl !== '') {
      filtered = filtered.filter(t => (t.pnl || 0) >= parseFloat(filters.minPnl));
    }

    if (filters.maxPnl !== '') {
      filtered = filtered.filter(t => (t.pnl || 0) <= parseFloat(filters.maxPnl));
    }

    if (filters.setupType) {
      filtered = filtered.filter(t =>
        t.setup_type?.toLowerCase().includes(filters.setupType.toLowerCase())
      );
    }

    if (filters.account) {
      filtered = filtered.filter(t =>
        t.custom_fields?.account?.toLowerCase().includes(filters.account.toLowerCase())
      );
    }

    setFilteredTrades(filtered);
    setCurrentPage(1); // Reset to first page when filters change
  };

  const handleFilterChange = (field, value) => {
    setFilters(prev => ({ ...prev, [field]: value }));
  };

  const clearFilters = () => {
    setFilters({
      symbol: '',
      direction: '',
      dateFrom: '',
      dateTo: '',
      minPnl: '',
      maxPnl: '',
      setupType: '',
      account: ''
    });
  };

  const computeNetTrades = (trades) => {
    // Deduplicate fills imported from multiple account files.
    // Two fills are the same trade if all key fields match.
    const seen = new Set();
    const uniqueTrades = trades.filter(t => {
      const dedupKey = `${t.entry_time}|${t.exit_time}|${t.symbol}|${t.direction}|${t.quantity}|${t.entry_price}|${t.exit_price}`;
      if (seen.has(dedupKey)) return false;
      seen.add(dedupKey);
      return true;
    });

    // Group by log_date + symbol + direction first, then split into
    // flat-to-flat sessions using the 'F' marker on FlatToFlat P&L.
    // This correctly handles add-ons (multiple entry_times in one trade).
    const dayGroups = new Map();
    uniqueTrades.forEach(trade => {
      const dayKey = `${trade.log_date}|${trade.symbol}|${trade.direction}`;
      if (!dayGroups.has(dayKey)) dayGroups.set(dayKey, []);
      dayGroups.get(dayKey).push(trade);
    });

    const netTrades = [];

    dayGroups.forEach((fills) => {
      // Sort sequentially: entry_time ASC, then sierra_row ASC
      fills.sort((a, b) => {
        const td = new Date(a.entry_time) - new Date(b.entry_time);
        if (td !== 0) return td;
        return (a.custom_fields?.sierra_row ?? 0) - (b.custom_fields?.sierra_row ?? 0);
      });

      // Session boundaries = exit_times of fills whose Exit DateTime ends with 'EP'
      const sessionEndTimes = [...new Set(
        fills
          .filter(f => {
            const exitDT = f.custom_fields?.sierra_data?.['Exit DateTime'] || '';
            return typeof exitDT === 'string' && exitDT.trimEnd().endsWith('EP');
          })
          .map(f => f.exit_time)
      )].sort();

      // Fallback: no F markers found — one big group
      const boundaries = sessionEndTimes.length > 0
        ? sessionEndTimes
        : [fills[fills.length - 1]?.exit_time].filter(Boolean);

      // Assign each fill to the earliest boundary >= its exit_time
      const sessions = new Map();
      boundaries.forEach(b => sessions.set(b, []));

      fills.forEach(fill => {
        const boundary = boundaries.find(b => new Date(b) >= new Date(fill.exit_time));
        const assignTo = boundary ?? boundaries[boundaries.length - 1];
        sessions.get(assignTo)?.push(fill);
      });

      // Build a net trade object for each session
      sessions.forEach((sessionFills) => {
        if (sessionFills.length === 0) return;

        let weightedEntrySum = 0, weightedExitSum = 0, weightedQty = 0;
        let latestExitTime = null, earliestEntryTime = null;

        sessionFills.forEach(fill => {
          const qty = fill.quantity || 0;
          weightedQty += qty;
          weightedEntrySum += qty * (fill.entry_price || 0);
          weightedExitSum += qty * (fill.exit_price || 0);
          if (!latestExitTime || fill.exit_time > latestExitTime) latestExitTime = fill.exit_time;
          if (!earliestEntryTime || fill.entry_time < earliestEntryTime) earliestEntryTime = fill.entry_time;
        });

        // P&L: use EP fill's FlatToFlat Profit/Loss (authoritative session total)
        const epFill = sessionFills.find(f => {
          const exitDT = f.custom_fields?.sierra_data?.['Exit DateTime'] || '';
          return typeof exitDT === 'string' && exitDT.trimEnd().endsWith('EP');
        });
        const flatToFlatRaw = String(
          epFill?.custom_fields?.sierra_data?.['FlatToFlat Profit/Loss (C)'] ||
          epFill?.custom_fields?.flat_to_flat_pl || ''
        ).trim().replace(/\s*F$/i, '');
        const totalPnl = flatToFlatRaw !== ''
          ? parseFloat(flatToFlatRaw)
          : sessionFills.reduce((s, f) => s + (parseFloat(f.pnl) || 0), 0);

        // Quantity: max Max Open Quantity across the session
        const totalQty = sessionFills.reduce((mx, f) => {
          const q = parseFloat(f.custom_fields?.sierra_data?.['Max Open Quantity'] ?? 0);
          return Math.max(mx, q);
        }, 0) || sessionFills[0]?.quantity || 0;

        const first = sessionFills[0];
        const key = `${first.log_date}|${earliestEntryTime}|${first.symbol}|${first.direction}|${latestExitTime}`;

        netTrades.push({
          key,
          log_date: first.log_date,
          symbol: first.symbol,
          direction: first.direction,
          entry_time: earliestEntryTime,
          fills: sessionFills,
          totalQty,
          totalPnl,
          avgEntryPrice: weightedQty > 0 ? weightedEntrySum / weightedQty : 0,
          avgExitPrice: weightedQty > 0 ? weightedExitSum / weightedQty : 0,
          latestExitTime,
        });
      });
    });

    // Second pass: correct per-session P&L using Cumulative P&L diffs.
    // Sierra Chart's Cumulative P&L (C) is a running account total.
    // Diff between consecutive EP fills per account = actual session P&L.
    const lastCumPLByAccount = new Map();
    [...netTrades]
      .sort((a, b) => {
        const accA = a.fills[0]?.custom_fields?.account || '';
        const accB = b.fills[0]?.custom_fields?.account || '';
        if (accA !== accB) return accA.localeCompare(accB);
        return new Date(a.latestExitTime) - new Date(b.latestExitTime);
      })
      .forEach(session => {
        const account = session.fills[0]?.custom_fields?.account || '__default__';
        const epFill = session.fills.find(f => {
          const exitDT = f.custom_fields?.sierra_data?.['Exit DateTime'] || '';
          return typeof exitDT === 'string' && exitDT.trimEnd().endsWith('EP');
        });
        if (!epFill) return;
        const cumPLStr = String(epFill.custom_fields?.sierra_data?.['Cumulative Profit/Loss (C)'] || '').trim();
        const thisCumPL = parseFloat(cumPLStr);
        if (isNaN(thisCumPL)) return;
        const prevCumPL = lastCumPLByAccount.get(account) ?? 0;
        session.totalPnl = thisCumPL - prevCumPL;
        lastCumPLByAccount.set(account, thisCumPL);
      });

    // Sort newest first to match the All Fills order
    netTrades.sort((a, b) => new Date(b.entry_time) - new Date(a.entry_time));
    return netTrades;
  };

  const accounts = useMemo(() => {
    const latestDate = new Map();
    allTrades.forEach(t => {
      const acct = t.custom_fields?.account;
      if (!acct) return;
      if (!latestDate.has(acct) || t.log_date > latestDate.get(acct)) latestDate.set(acct, t.log_date);
    });
    return [...latestDate.keys()].sort((a, b) => latestDate.get(b).localeCompare(latestDate.get(a)));
  }, [allTrades]);

  const toggleGroup = (key) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Pagination
  const netTrades = viewMode === 'net' ? computeNetTrades(filteredTrades) : [];
  const displayItems = viewMode === 'net' ? netTrades : filteredTrades;
  const indexOfLastTrade = currentPage * tradesPerPage;
  const indexOfFirstTrade = indexOfLastTrade - tradesPerPage;
  const currentTrades = displayItems.slice(indexOfFirstTrade, indexOfLastTrade);
  const totalPages = Math.ceil(displayItems.length / tradesPerPage);

  const formatDateTime = (dateTime) => {
    if (!dateTime) return 'N/A';
    return new Date(dateTime).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  const formatCurrency = (value) => {
    if (value === null || value === undefined) return 'N/A';
    return `$${formatNumber(value)}`;
  };

  if (loading) {
    return (
      <div className="all-trades-view">
        <header className="page-header">
          <h1>All Trades</h1>
          <button className="btn btn-primary sync-btn" onClick={onSyncTrades} disabled={syncing}>
            {syncing ? '⏳ Syncing...' : '⬇ Sync Trades'}
          </button>
        </header>
        <div style={{ textAlign: 'center', padding: '40px' }}>Loading trades...</div>
      </div>
    );
  }

  // If on calendar tab, render CalendarView instead
  if (tradesTab === 'calendar') {
    return (
      <div className="all-trades-view">
        <header className="page-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
            <h1>Trades</h1>
            <div style={{ display: 'flex', gap: 4 }}>
              {[['trades','Trades'],['calendar','Calendar']].map(([tab, label]) => (
                <button key={tab} onClick={() => setTradesTab(tab)}
                  style={{ padding: '5px 14px', borderRadius: 6, fontSize: 13, fontWeight: tab === tradesTab ? 700 : 400, cursor: 'pointer',
                    background: tab === tradesTab ? 'rgba(99,102,241,0.2)' : 'transparent',
                    color: tab === tradesTab ? '#818cf8' : 'var(--text-muted)',
                    border: `1px solid ${tab === tradesTab ? '#6366f1' : 'var(--border-color)'}` }}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <button className="btn btn-primary sync-btn" onClick={onSyncTrades} disabled={syncing}>
            {syncing ? '⏳ Syncing...' : '⬇ Sync Trades'}
          </button>
        </header>
        <CalendarView accounts={calendarAccounts} selectedAccounts={calendarSelectedAccounts} setSelectedAccounts={calendarSetSelectedAccounts} />
      </div>
    );
  }

  return (
    <div className="all-trades-view">
      <header className="page-header">
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 20, marginBottom: 4 }}>
            <h1 style={{ margin: 0 }}>Trades</h1>
            <div style={{ display: 'flex', gap: 4 }}>
              {[['trades','Trades'],['calendar','Calendar']].map(([tab, label]) => (
                <button key={tab} onClick={() => setTradesTab(tab)}
                  style={{ padding: '5px 14px', borderRadius: 6, fontSize: 13, fontWeight: tab === tradesTab ? 700 : 400, cursor: 'pointer',
                    background: tab === tradesTab ? 'rgba(99,102,241,0.2)' : 'transparent',
                    color: tab === tradesTab ? '#818cf8' : 'var(--text-muted)',
                    border: `1px solid ${tab === tradesTab ? '#6366f1' : 'var(--border-color)'}` }}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <p style={{ margin: 0 }}>
            {viewMode === 'net'
              ? `${netTrades.length} net trades (${filteredTrades.length} fills)`
              : `${filteredTrades.length} of ${allTrades.length} fills`
            }
          </p>
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <div className="view-mode-toggle">
            <button
              className={`btn ${viewMode === 'net' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => { setViewMode('net'); setCurrentPage(1); }}
            >
              Net Trades
            </button>
            <button
              className={`btn ${viewMode === 'fills' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => { setViewMode('fills'); setCurrentPage(1); }}
            >
              All Fills
            </button>
          </div>
          <button className="btn btn-primary sync-btn" onClick={onSyncTrades} disabled={syncing}>
            {syncing ? '⏳ Syncing...' : '⬇ Sync Trades'}
          </button>
        </div>
      </header>

      {/* Filters Section */}
      <div className="filters-section">
        <h3>Filters</h3>
        <div className="filters-grid">
          <div className="filter-group">
            <label>Symbol</label>
            <input
              type="text"
              placeholder="e.g. NQ, ES"
              value={filters.symbol}
              onChange={(e) => handleFilterChange('symbol', e.target.value)}
            />
          </div>

          <div className="filter-group">
            <label>Direction</label>
            <select
              value={filters.direction}
              onChange={(e) => handleFilterChange('direction', e.target.value)}
            >
              <option value="">All</option>
              <option value="LONG">LONG</option>
              <option value="SHORT">SHORT</option>
            </select>
          </div>

          <div className="filter-group">
            <label>Date From</label>
            <input
              type="date"
              value={filters.dateFrom}
              onChange={(e) => handleFilterChange('dateFrom', e.target.value)}
            />
          </div>

          <div className="filter-group">
            <label>Date To</label>
            <input
              type="date"
              value={filters.dateTo}
              onChange={(e) => handleFilterChange('dateTo', e.target.value)}
            />
          </div>

          <div className="filter-group">
            <label>Min P&L</label>
            <input
              type="number"
              step="0.01"
              placeholder="e.g. -100"
              value={filters.minPnl}
              onChange={(e) => handleFilterChange('minPnl', e.target.value)}
            />
          </div>

          <div className="filter-group">
            <label>Max P&L</label>
            <input
              type="number"
              step="0.01"
              placeholder="e.g. 100"
              value={filters.maxPnl}
              onChange={(e) => handleFilterChange('maxPnl', e.target.value)}
            />
          </div>

          <div className="filter-group">
            <label>Setup Type</label>
            <input
              type="text"
              placeholder="e.g. Breakout"
              value={filters.setupType}
              onChange={(e) => handleFilterChange('setupType', e.target.value)}
            />
          </div>

          <div className="filter-group">
            <label>Account</label>
            <select
              value={filters.account}
              onChange={(e) => handleFilterChange('account', e.target.value)}
            >
              <option value="">All Accounts</option>
              {accounts.map(account => (
                <option key={account} value={account}>{account}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="filter-actions">
          <button className="btn btn-secondary" onClick={clearFilters}>Clear Filters</button>
        </div>
      </div>

      {/* Trades Table */}
      <div className="trades-table-container">
        {viewMode === 'net' ? (
          <table className="trades-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Account</th>
                <th>Symbol</th>
                <th>Direction</th>
                <th>Total Qty</th>
                <th>Avg Entry</th>
                <th>Avg Exit</th>
                <th>Net P&L</th>
                <th>Entry Time</th>
                <th>Last Exit</th>
                <th>Fills</th>
              </tr>
            </thead>
            <tbody>
              {currentTrades.length === 0 ? (
                <tr>
                  <td colSpan="11" style={{ textAlign: 'center', padding: '40px' }}>
                    No trades found matching filters
                  </td>
                </tr>
              ) : (
                currentTrades.map(netTrade => {
                  const isExpanded = expandedGroups.has(netTrade.key);
                  return (
                    <React.Fragment key={netTrade.key}>
                      <tr
                        className={`net-trade-row ${netTrade.totalPnl >= 0 ? 'trade-row-profit' : 'trade-row-loss'}`}
                        onClick={() => toggleGroup(netTrade.key)}
                        style={{ cursor: 'pointer' }}
                      >
                        <td>
                          <span style={{ marginRight: 6, fontSize: '0.8em', opacity: 0.6 }}>
                            {isExpanded ? '▼' : '▶'}
                          </span>
                          {netTrade.log_date}
                        </td>
                        <td style={{ fontSize: '0.8em', opacity: 0.75 }}>
                          {netTrade.fills[0]?.custom_fields?.account || '—'}
                        </td>
                        <td><strong>{netTrade.symbol}</strong></td>
                        <td>
                          <span className={`direction-badge ${netTrade.direction?.toLowerCase()}`}>
                            {netTrade.direction}
                          </span>
                        </td>
                        <td>{formatNumber(netTrade.totalQty, 0)}</td>
                        <td>{formatCurrency(netTrade.avgEntryPrice)}</td>
                        <td>{formatCurrency(netTrade.avgExitPrice)}</td>
                        <td className={netTrade.totalPnl >= 0 ? 'pnl-positive' : 'pnl-negative'}>
                          <strong>{formatCurrency(netTrade.totalPnl)}</strong>
                        </td>
                        <td>{formatDateTime(netTrade.entry_time)}</td>
                        <td>{formatDateTime(netTrade.latestExitTime)}</td>
                        <td>
                          <span className="fills-badge">{netTrade.fills.length}</span>
                        </td>
                      </tr>
                      {isExpanded && (() => {
                          // Sort sequentially: entry_time ASC, then sierra_row ASC (preserves original file order; BP natural first, EP natural last)
                          const sorted = [...netTrade.fills].sort((a, b) => {
                            const td = new Date(a.entry_time) - new Date(b.entry_time);
                            if (td !== 0) return td;
                            return (a.custom_fields?.sierra_row ?? 0) - (b.custom_fields?.sierra_row ?? 0);
                          });

                          // Label fills using BP/EP markers + running position quantity tracker
                          let prevCloseQty = 0;
                          return sorted.map((fill) => {
                            const sd = fill.custom_fields?.sierra_data || {};
                            const isBP = !!sd['Entry DateTime']?.includes('BP');
                            const isEP = !!sd['Exit DateTime']?.includes('EP');
                            const openQty = Math.abs(parseFloat(sd['Open Position Quantity'] ?? 0));
                            const closeQty = Math.abs(parseFloat(sd['Close Position Quantity'] ?? 0));
                            const isAdd = !isBP && prevCloseQty > 0 && openQty > prevCloseQty;
                            prevCloseQty = closeQty;

                            const fillLabel = isBP ? 'Entry' : isEP ? 'Exit' : (isAdd ? 'Add' : 'Partial Exit');
                            const fillClass = isBP ? 'entry' : isEP ? 'full-exit' : (isAdd ? 'add-on' : 'partial-exit');
                            return (
                              <tr key={fill.id} className={`fill-row ${fill.pnl >= 0 ? 'trade-row-profit' : 'trade-row-loss'}`}>
                                <td style={{ paddingLeft: 28 }}>↳</td>
                                <td>{fill.symbol}</td>
                                <td>
                                  <span className={`direction-badge ${fillClass}`}>
                                    {fillLabel}
                                  </span>
                                </td>
                                <td>{formatNumber(fill.quantity, 0)}</td>
                                <td>{formatCurrency(fill.entry_price)}</td>
                                <td>{formatCurrency(fill.exit_price)}</td>
                                <td className={fill.pnl >= 0 ? 'pnl-positive' : 'pnl-negative'}>
                                  {formatCurrency(fill.pnl)}
                                </td>
                                <td>{isAdd ? formatDateTime(fill.entry_time) : ''}</td>
                                <td>{formatDateTime(fill.exit_time)}</td>
                                <td>{fill.setup_type || 'N/A'}</td>
                              </tr>
                            );
                          });
                        })()
                      }
                    </React.Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        ) : (
          <table className="trades-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Account</th>
                <th>Symbol</th>
                <th>Direction</th>
                <th>Qty</th>
                <th>Entry Price</th>
                <th>Exit Price</th>
                <th>P&L</th>
                <th>Entry Time</th>
                <th>Exit Time</th>
                <th>Setup</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {currentTrades.length === 0 ? (
                <tr>
                  <td colSpan="12" style={{ textAlign: 'center', padding: '40px' }}>
                    No trades found matching filters
                  </td>
                </tr>
              ) : (
                currentTrades.map(trade => (
                  <React.Fragment key={trade.id}>
                    <tr className={trade.pnl >= 0 ? 'trade-row-profit' : 'trade-row-loss'}>
                      <td>{trade.log_date}</td>
                      <td style={{ fontSize: '0.8em', opacity: 0.75 }}>{trade.custom_fields?.account || '—'}</td>
                      <td><strong>{trade.symbol}</strong></td>
                      <td>
                        <span className={`direction-badge ${trade.direction?.toLowerCase()}`}>
                          {trade.direction}
                        </span>
                      </td>
                      <td>{formatNumber(trade.quantity, 0)}</td>
                      <td>{formatCurrency(trade.entry_price)}</td>
                      <td>{formatCurrency(trade.exit_price)}</td>
                      <td className={trade.pnl >= 0 ? 'pnl-positive' : 'pnl-negative'}>
                        <strong>{formatCurrency(trade.pnl)}</strong>
                      </td>
                      <td>{formatDateTime(trade.entry_time)}</td>
                      <td>{formatDateTime(trade.exit_time)}</td>
                      <td>{trade.setup_type || 'N/A'}</td>
                      <td>
                        <button
                          className="btn-icon"
                          onClick={() => setExpandedTrade(expandedTrade === trade.id ? null : trade.id)}
                          title="View Details"
                        >
                          {expandedTrade === trade.id ? '▲' : '▼'}
                        </button>
                      </td>
                    </tr>
                    {expandedTrade === trade.id && (
                      <tr className="trade-details-row">
                        <td colSpan="12">
                          <div className="trade-details">
                            <div className="details-grid">
                              <div className="detail-section">
                                <h4>Trade Information</h4>
                                <p><strong>Stop Loss:</strong> {formatCurrency(trade.stop_loss)}</p>
                                <p><strong>Target:</strong> {formatCurrency(trade.target)}</p>
                                <p><strong>Fees:</strong> {formatCurrency(trade.fees)}</p>
                                <p><strong>Risk/Reward:</strong> {trade.risk_reward_ratio || 'N/A'}</p>
                                <p><strong>Emotional State:</strong> {trade.emotional_state || 'N/A'}</p>
                              </div>
                              <div className="detail-section">
                                <h4>Notes</h4>
                                <p><strong>Trade Notes:</strong> {trade.trade_notes || 'None'}</p>
                                <p><strong>Mistakes:</strong> {trade.mistakes || 'None'}</p>
                              </div>
                              {trade.custom_fields && (
                                <div className="detail-section">
                                  <h4>Custom Fields</h4>
                                  {Object.entries(trade.custom_fields).map(([key, value]) => {
                                    if (key === 'sierra_data' && typeof value === 'object') {
                                      return (
                                        <div key={key}>
                                          <p><strong>Sierra Data:</strong></p>
                                          <div style={{ marginLeft: '20px', fontSize: '0.9em' }}>
                                            {Object.entries(value).slice(0, 10).map(([k, v]) => (
                                              <p key={k}><strong>{k}:</strong> {String(v)}</p>
                                            ))}
                                          </div>
                                        </div>
                                      );
                                    }
                                    return (
                                      <p key={key}>
                                        <strong>{key}:</strong> {typeof value === 'object' ? JSON.stringify(value) : String(value)}
                                      </p>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))
              )}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="pagination">
          <button
            className="btn btn-secondary"
            onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
            disabled={currentPage === 1}
          >
            Previous
          </button>
          <span className="page-info">
            Page {currentPage} of {totalPages}
          </span>
          <button
            className="btn btn-secondary"
            onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
            disabled={currentPage === totalPages}
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}

export default AllTradesView;
