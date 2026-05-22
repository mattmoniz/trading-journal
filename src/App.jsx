import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { io } from 'socket.io-client';
import './App.css';
import { formatTimestamp, formatFieldTimestamp, isStale, latestOf } from './utils/timestamps.js';
import { TOOLTIPS } from './constants/tooltips.js';
import {
  LineChart, Line, AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceLine,
  ComposedChart, Scatter
} from 'recharts';

const API_URL = '/api';
const SOCKET_URL = window.location.origin;

// Helper function to format numbers with commas and 2 decimal places
const formatNumber = (num, decimals = 2) => {
  const number = parseFloat(num || 0);
  return number.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });
};

// InfoTooltip accepts either:
//   text="plain string"                         (existing usage — unchanged)
//   tooltip={{ text, source, example }}         (new structured usage from tooltips.js)
function InfoTooltip({ text, tooltip }) {
  const [visible, setVisible] = React.useState(false);
  const [pos, setPos] = React.useState({ top: 0, left: 0 });
  const ref = React.useRef(null);

  // Support both calling styles
  const content = tooltip || (text ? { text } : null);
  if (!content) return null;

  const handleMouseEnter = () => {
    if (ref.current) {
      const rect = ref.current.getBoundingClientRect();
      const tooltipWidth = 320;
      const left = Math.min(
        Math.max(tooltipWidth / 2 + 8, rect.left + rect.width / 2),
        window.innerWidth - tooltipWidth / 2 - 8
      );
      setPos({ top: rect.top - 8, left });
    }
    setVisible(true);
  };

  return (
    <span ref={ref} style={{ display: 'inline-block', marginLeft: 4, verticalAlign: 'middle', flexShrink: 0 }}
      onMouseEnter={handleMouseEnter} onMouseLeave={() => setVisible(false)}
      onClick={() => setVisible(v => !v)}>
      <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 14, height: 14, borderRadius: '50%', fontSize: 9, fontWeight: 700,
        background: 'rgba(100,116,139,0.2)', color: 'var(--text-muted)',
        border: '1px solid rgba(100,116,139,0.35)', cursor: 'help', lineHeight: 1 }}>i</span>
      {visible && (
        <div style={{
          position: 'fixed', top: pos.top, left: pos.left,
          transform: 'translate(-50%, -100%)', marginTop: -6,
          width: 320, padding: '10px 13px', background: '#1a2535',
          border: '1px solid rgba(100,116,139,0.5)', borderRadius: 8, fontSize: 11,
          color: '#94a3b8', boxShadow: '0 6px 20px rgba(0,0,0,0.7)',
          zIndex: 99999, pointerEvents: 'none', lineHeight: 1.7, whiteSpace: 'pre-line' }}>
          <div style={{ color: '#cbd5e1' }}>{content.text}</div>
          {content.source && (
            <div style={{ marginTop: 6, fontSize: 10, color: '#475569', borderTop: '1px solid rgba(100,116,139,0.2)', paddingTop: 5 }}>
              Source: {content.source}
            </div>
          )}
          {content.example && (
            <div style={{ marginTop: 4, fontSize: 10, color: '#64748b', fontStyle: 'italic' }}>
              Example: {content.example}
            </div>
          )}
        </div>
      )}
    </span>
  );
}

function App() {
  const [currentView, setCurrentView] = useState('acd');
  const [currentDate, setCurrentDate] = useState(new Date().toLocaleDateString('en-CA'));
  const [stats, setStats] = useState({});
  const [accounts, setAccounts] = useState([]);
  const [selectedAccounts, setSelectedAccounts] = useState([]);
  const [toasts, setToasts] = useState([]);
  const toastIdRef = useRef(0);
  const [syncing, setSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState(null);
  const [syncLog, setSyncLog] = useState([]);
  const [priceSyncProgress, setPriceSyncProgress] = useState(null);
  const syncTimeoutRef = React.useRef(null);

  const addToast = useCallback((message, type = 'info', duration = 5000) => {
    const id = ++toastIdRef.current;
    setToasts(prev => [...prev, { id, message, type }]);
    if (duration !== null) {
      setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), duration);
    }
  }, []);

  const dismissToast = useCallback((id) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  useEffect(() => {
    fetchStats();
    fetchAccounts();

    const socket = io(SOCKET_URL);
    window._tradingSocket = socket;

    socket.on('import-started', ({ file }) => {
      addToast(`Importing ${file}...`, 'info', 10000);
    });

    socket.on('import-rejected', ({ file }) => {
      addToast(`⚠️ Rejected: "${file}" is a Trade Activity fills log — nothing imported. Fix: Sierra Chart → Trade → Trade Activity Log → select account → Export. The correct file has columns "Entry DateTime", "Exit DateTime", "FlatToFlat Profit/Loss (C)".`, 'error', null);
    });

    socket.on('trades-updated', ({ file, imported, skipped }) => {
      if (imported > 0) {
        addToast(`${file}: ${imported} new trade${imported !== 1 ? 's' : ''} imported`, 'success');
      } else {
        addToast(`${file}: no new trades (${skipped} already up to date)`, 'neutral');
      }
    });

    socket.on('import-error', ({ file, error }) => {
      addToast(`Import failed for ${file}: ${error}`, 'error', 8000);
    });

    socket.on('sync-progress', (data) => {
      setSyncProgress(data);
      setSyncLog(prev => [...prev, { ts: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' }), msg: data.message, status: data.status }]);
      // Reset the stuck-detection timeout on each event
      if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current);
      if (data.status === 'success') {
        setTimeout(() => { setSyncing(false); setSyncProgress(null); }, 4000);
        fetchStats();
      } else if (data.status === 'error') {
        setSyncing(false);
      } else {
        // 90-second timeout — if no new event arrives, declare it stuck
        syncTimeoutRef.current = setTimeout(() => {
          setSyncProgress({ step: -1, message: 'No response from Sierra Chart for 90 seconds. Try syncing again or export manually from Sierra Chart → Trade → Trade Activity Log → File → Export.', status: 'error' });
          setSyncing(false);
        }, 90000);
      }
    });

    socket.on('price-sync-progress', (data) => {
      setPriceSyncProgress(data);
      if (data.status === 'success') {
        setTimeout(() => setPriceSyncProgress(null), 3000);
      }
    });

    return () => socket.disconnect();
  }, []);

  const handleSyncTrades = async (navigateToDashboard = false) => {
    setSyncing(true);
    setSyncLog([]);
    setSyncProgress({ step: 0, message: 'Connecting to Sierra Chart…', status: 'running' });
    setSyncLog([{ ts: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' }), msg: 'Starting sync — sending command to Sierra Chart…', status: 'running' }]);
    if (navigateToDashboard) setCurrentView('dashboard');
    // 90-second initial timeout in case socket never connects
    syncTimeoutRef.current = setTimeout(() => {
      setSyncProgress({ step: -1, message: 'No response from Sierra Chart. Check that Sierra Chart is running, then try again.', status: 'error' });
      setSyncing(false);
    }, 90000);
    try {
      const res = await fetch(`${API_URL}/trigger-export`, { method: 'POST' });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);
      setSyncLog(prev => [...prev, { ts: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' }), msg: 'Command sent — running PowerShell export script…', status: 'running' }]);
    } catch (err) {
      if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current);
      setSyncProgress({ step: -1, message: err.message, status: 'error' });
      setSyncing(false);
    }
  };

  const fetchStats = async () => {
    try {
      const response = await fetch(`${API_URL}/stats/overview`);
      const data = await response.json();
      setStats(data);
    } catch (error) {
      console.error('Error fetching stats:', error);
    }
  };

  const fetchAccounts = async () => {
    try {
      const res = await fetch(`${API_URL}/accounts?days=30`);
      const data = await res.json();
      setAccounts(data);
      if (data.length > 0) setSelectedAccounts([data[0]]);
    } catch (e) { console.error(e); }
  };

  return (
    <div className="app-container">
      <Sidebar
        currentView={currentView}
        setCurrentView={setCurrentView}
        stats={stats}
      />
      <main className="main-content">
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
        {currentView === 'dashboard' && (
          <DashboardView accounts={accounts} selectedAccounts={selectedAccounts} setSelectedAccounts={setSelectedAccounts} addToast={addToast} syncing={syncing} syncProgress={syncProgress} syncLog={syncLog} onSyncTrades={() => handleSyncTrades(false)} onDismissSync={() => { setSyncProgress(null); setSyncLog([]); }} />
        )}
        {(currentView === 'all-trades' || currentView === 'calendar') && (
          <AllTradesView addToast={addToast} syncing={syncing} onSyncTrades={() => handleSyncTrades(true)}
            accounts={accounts} selectedAccounts={selectedAccounts} setSelectedAccounts={setSelectedAccounts}
            initialTab={currentView === 'calendar' ? 'calendar' : 'trades'}
            setCurrentView={setCurrentView} />
        )}
        {currentView === 'backtest' && (
          <BacktestView accounts={accounts} selectedAccounts={selectedAccounts} setSelectedAccounts={setSelectedAccounts} priceSyncProgress={priceSyncProgress} onDismissPriceSync={() => setPriceSyncProgress(null)} />
        )}
        {currentView === 'tearsheet' && (
          <TearsheetView accounts={accounts} selectedAccounts={selectedAccounts} setSelectedAccounts={setSelectedAccounts} />
        )}
        {currentView === 'settings' && (
          <SettingsView />
        )}
        {currentView === 'risk' && (
          <RiskView accounts={accounts} selectedAccounts={selectedAccounts} setSelectedAccounts={setSelectedAccounts} />
        )}
        {currentView === 'acd' && (
          <ACDView accounts={accounts} selectedAccounts={selectedAccounts} setSelectedAccounts={setSelectedAccounts} setCurrentView={setCurrentView} />
        )}
        {currentView === 'longterm' && (
          <LongTermStructurePage setCurrentView={setCurrentView} />
        )}
        {currentView === 'playbook' && (
          <PlaybookPage />
        )}
      </main>
    </div>
  );
}

// ==================== TOAST NOTIFICATIONS ====================
function ToastContainer({ toasts, onDismiss }) {
  if (toasts.length === 0) return null;
  return (
    <div className="toast-container">
      {toasts.map(toast => (
        <div key={toast.id} className={`toast toast-${toast.type}`}>
          <span className="toast-message">{toast.message}</span>
          <button className="toast-close" onClick={() => onDismiss(toast.id)}>×</button>
        </div>
      ))}
    </div>
  );
}

// ==================== SIDEBAR ====================
function Sidebar({ currentView, setCurrentView, stats }) {
  return (
    <aside className="sidebar">
      <div className="logo">
        <div className="logo-icon">📊</div>
        <h1>Trading Journal</h1>
      </div>

      <nav className="nav-menu">
        <button
          className={`nav-item ${currentView === 'acd' ? 'active' : ''}`}
          onClick={() => setCurrentView('acd')}
        >
          <span className="nav-icon">☀️</span>
          <span>Morning Prep</span>
        </button>

        <button
          className={`nav-item ${currentView === 'longterm' ? 'active' : ''}`}
          onClick={() => setCurrentView('longterm')}
        >
          <span className="nav-icon">🏗️</span>
          <span>Structure</span>
        </button>

        <button
          className={`nav-item ${currentView === 'playbook' ? 'active' : ''}`}
          onClick={() => setCurrentView('playbook')}
        >
          <span className="nav-icon">📖</span>
          <span>Playbook</span>
        </button>


        <button
          className={`nav-item ${currentView === 'dashboard' ? 'active' : ''}`}
          onClick={() => setCurrentView('dashboard')}
        >
          <span className="nav-icon">📈</span>
          <span>Dashboard</span>
        </button>

        <button
          className={`nav-item ${currentView === 'backtest' ? 'active' : ''}`}
          onClick={() => setCurrentView('backtest')}
          style={{ paddingLeft: 28 }}
        >
          <span className="nav-icon">🔬</span>
          <span>Backtest</span>
        </button>

        <button
          className={`nav-item ${currentView === 'all-trades' || currentView === 'calendar' ? 'active' : ''}`}
          onClick={() => setCurrentView('all-trades')}
        >
          <span className="nav-icon">📋</span>
          <span>Trades</span>
        </button>

        <button
          className={`nav-item ${currentView === 'tearsheet' ? 'active' : ''}`}
          onClick={() => setCurrentView('tearsheet')}
        >
          <span className="nav-icon">📄</span>
          <span>Tearsheet</span>
        </button>

        <button
          className={`nav-item ${currentView === 'risk' ? 'active' : ''}`}
          onClick={() => setCurrentView('risk')}
        >
          <span className="nav-icon">🛡️</span>
          <span>Risk</span>
        </button>

        <button
          className={`nav-item ${currentView === 'settings' ? 'active' : ''}`}
          onClick={() => setCurrentView('settings')}
        >
          <span className="nav-icon">⚙️</span>
          <span>Settings</span>
        </button>
      </nav>

      <div className="stats-summary">
        <h3>Quick Stats</h3>
        <div className="stat-item">
          <span className="stat-label">Total P&L</span>
          <span className={`stat-value ${parseFloat(stats.total_pnl || 0) >= 0 ? 'positive' : 'negative'}`}>
            ${formatNumber(stats.total_pnl)}
          </span>
        </div>
        <div className="stat-item">
          <span className="stat-label">Win Rate</span>
          <span className="stat-value">{formatNumber(stats.win_rate)}%</span>
        </div>
        <div className="stat-item">
          <span className="stat-label">Total Trades</span>
          <span className="stat-value">{formatNumber(stats.total_trades || 0, 0)}</span>
        </div>
      </div>
    </aside>
  );
}

// ==================== TODAY'S LOG VIEW ====================
function TodayView({ currentDate, setCurrentDate, refreshStats }) {
  const [dailyLog, setDailyLog] = useState(null);
  const [trades, setTrades] = useState([]);
  const [showTradeForm, setShowTradeForm] = useState(false);
  const [editingTrade, setEditingTrade] = useState(null);

  useEffect(() => {
    fetchDailyLog();
    fetchTrades();
  }, [currentDate]);

  const fetchDailyLog = async () => {
    try {
      const response = await fetch(`${API_URL}/daily-logs/${currentDate}`);
      const data = await response.json();
      setDailyLog(data);
    } catch (error) {
      console.error('Error fetching daily log:', error);
    }
  };

  const fetchTrades = async () => {
    try {
      const response = await fetch(`${API_URL}/trades/${currentDate}`);
      const data = await response.json();
      setTrades(data);
    } catch (error) {
      console.error('Error fetching trades:', error);
    }
  };

  const updateDailyLog = async (updates) => {
    try {
      await fetch(`${API_URL}/daily-logs/${currentDate}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates)
      });
      fetchDailyLog();
    } catch (error) {
      console.error('Error updating daily log:', error);
    }
  };

  const handleTradeSubmit = async (tradeData) => {
    try {
      if (editingTrade) {
        await fetch(`${API_URL}/trades/${editingTrade.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(tradeData)
        });
      } else {
        await fetch(`${API_URL}/trades`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...tradeData, log_date: currentDate })
        });
      }
      fetchTrades();
      refreshStats();
      setShowTradeForm(false);
      setEditingTrade(null);
    } catch (error) {
      console.error('Error saving trade:', error);
    }
  };

  const handleDeleteTrade = async (tradeId) => {
    if (!confirm('Are you sure you want to delete this trade?')) return;
    
    try {
      await fetch(`${API_URL}/trades/${tradeId}`, { method: 'DELETE' });
      fetchTrades();
      refreshStats();
    } catch (error) {
      console.error('Error deleting trade:', error);
    }
  };

  const todayPnL = trades
    .filter(t => t.exit_time)
    .reduce((sum, t) => sum + parseFloat(t.pnl || 0), 0);

  return (
    <div className="today-view">
      <header className="page-header">
        <div>
          <h1>Trading Log</h1>
          <input 
            type="date" 
            value={currentDate}
            onChange={(e) => setCurrentDate(e.target.value)}
            className="date-picker"
          />
        </div>
        <div className="header-stats">
          <div className="stat-chip">
            <span className="label">Today's P&L:</span>
            <span className={`value ${todayPnL >= 0 ? 'positive' : 'negative'}`}>
              ${formatNumber(todayPnL)}
            </span>
          </div>
          <div className="stat-chip">
            <span className="label">Trades:</span>
            <span className="value">{formatNumber(trades.length, 0)}</span>
          </div>
        </div>
      </header>

      {dailyLog && (
        <section className="daily-log-section">
          <h2>Daily Notes</h2>
          <div className="log-grid">
            <div className="form-group">
              <label>Sleep Quality</label>
              <select 
                value={dailyLog.sleep_quality || ''}
                onChange={(e) => updateDailyLog({ ...dailyLog, sleep_quality: e.target.value })}
              >
                <option value="">Select...</option>
                <option value="Poor">Poor</option>
                <option value="Fair">Fair</option>
                <option value="Good">Good</option>
                <option value="Excellent">Excellent</option>
              </select>
            </div>

            <div className="form-group">
              <label>Mood</label>
              <select 
                value={dailyLog.mood || ''}
                onChange={(e) => updateDailyLog({ ...dailyLog, mood: e.target.value })}
              >
                <option value="">Select...</option>
                <option value="Anxious">Anxious</option>
                <option value="Calm">Calm</option>
                <option value="Focused">Focused</option>
                <option value="Tired">Tired</option>
                <option value="Energetic">Energetic</option>
              </select>
            </div>

            <div className="form-group">
              <label>Market Condition</label>
              <select 
                value={dailyLog.market_condition || ''}
                onChange={(e) => updateDailyLog({ ...dailyLog, market_condition: e.target.value })}
              >
                <option value="">Select...</option>
                <option value="Trending">Trending</option>
                <option value="Choppy">Choppy</option>
                <option value="Ranging">Ranging</option>
                <option value="Volatile">Volatile</option>
              </select>
            </div>
          </div>

          <div className="form-group">
            <label>Pre-Market Notes</label>
            <textarea 
              value={dailyLog.pre_market_notes || ''}
              onChange={(e) => updateDailyLog({ ...dailyLog, pre_market_notes: e.target.value })}
              placeholder="What's your plan for today? Key levels to watch?"
              rows="3"
            />
          </div>

          <div className="form-group">
            <label>Post-Market Review</label>
            <textarea 
              value={dailyLog.post_market_notes || ''}
              onChange={(e) => updateDailyLog({ ...dailyLog, post_market_notes: e.target.value })}
              placeholder="How did the session go? What happened?"
              rows="3"
            />
          </div>

          <div className="form-group">
            <label>Lessons Learned</label>
            <textarea 
              value={dailyLog.lessons_learned || ''}
              onChange={(e) => updateDailyLog({ ...dailyLog, lessons_learned: e.target.value })}
              placeholder="What did you learn today?"
              rows="3"
            />
          </div>
        </section>
      )}

      <section className="trades-section">
        <div className="section-header">
          <h2>Trades</h2>
          <button 
            className="btn btn-primary"
            onClick={() => {
              setShowTradeForm(true);
              setEditingTrade(null);
            }}
          >
            + Add Trade
          </button>
        </div>

        {showTradeForm && (
          <TradeForm
            trade={editingTrade}
            onSubmit={handleTradeSubmit}
            dailyTradeCount={trades.length}
            onCancel={() => {
              setShowTradeForm(false);
              setEditingTrade(null);
            }}
          />
        )}

        <div className="trades-list">
          {trades.map(trade => (
            <TradeCard 
              key={trade.id} 
              trade={trade}
              onEdit={() => {
                setEditingTrade(trade);
                setShowTradeForm(true);
              }}
              onDelete={() => handleDeleteTrade(trade.id)}
            />
          ))}
          {trades.length === 0 && !showTradeForm && (
            <div className="empty-state">
              <p>No trades recorded yet</p>
              <button className="btn btn-secondary" onClick={() => setShowTradeForm(true)}>
                Add Your First Trade
              </button>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

// ==================== TRADE FORM ====================
function TradeForm({ trade, onSubmit, onCancel, dailyTradeCount = 0 }) {
  const [setupTypes, setSetupTypes] = useState([]);
  const [sizeConfirmed, setSizeConfirmed] = useState(false);
  const [countConfirmed, setCountConfirmed] = useState(false);
  const [formData, setFormData] = useState({
    entry_time: trade?.entry_time?.slice(0, 16) || new Date().toISOString().slice(0, 16),
    exit_time: trade?.exit_time?.slice(0, 16) || '',
    symbol: trade?.symbol || 'NQ',
    direction: trade?.direction || 'LONG',
    quantity: trade?.quantity || 1,
    entry_price: trade?.entry_price || '',
    exit_price: trade?.exit_price || '',
    stop_loss: trade?.stop_loss || '',
    target: trade?.target || '',
    pnl: trade?.pnl || '',
    fees: trade?.fees || 0,
    setup_type: trade?.setup_type || '',
    trade_notes: trade?.trade_notes || '',
    mistakes: trade?.mistakes || '',
    emotional_state: trade?.emotional_state || '',
  });

  useEffect(() => {
    fetch(`${API_URL}/setup-types`)
      .then(res => res.json())
      .then(data => setSetupTypes(data));
  }, []);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
    if (name === 'quantity' && parseInt(value) <= 1) setSizeConfirmed(false);
  };

  // ── Hard rules derived from actual trade data ────────────────────────────────
  const entryTime = formData.entry_time ? new Date(formData.entry_time) : null;
  const entryHour = entryTime ? entryTime.getHours() : null;
  const entryMin  = entryTime ? entryTime.getMinutes() : null;
  const blockedByTime = entryHour !== null && (
    (entryHour === 9  && entryMin < 33) ||
    (entryHour === 10 && entryMin >= 0 && entryMin <= 2)
  );
  const timeBlockMsg = entryHour === 9 && entryMin < 33
    ? 'Data shows negative EV in first 3 minutes. Wait for 9:33.'
    : 'Data shows negative EV between 10:00–10:02. Wait for 10:03.';

  const qty = parseInt(formData.quantity) || 1;
  const sizeWarning = !trade && qty > 1 && !sizeConfirmed;

  const countWarning = !trade && dailyTradeCount >= 15;
  const countBlocked = !trade && dailyTradeCount >= 20 && !countConfirmed;

  const handleSubmit = (e) => {
    e.preventDefault();
    if (blockedByTime) return;
    if (sizeWarning) return;
    if (countBlocked) return;
    onSubmit(formData);
  };

  const bannerBase = {
    padding: '12px 16px', borderRadius: 8, marginBottom: 12,
    fontSize: 13, lineHeight: 1.5, fontWeight: 600,
  };

  return (
    <div className="trade-form-card">
      <h3>{trade ? 'Edit Trade' : 'New Trade'}</h3>

      {/* Rule 3 — Early session gate */}
      {blockedByTime && (
        <div style={{ ...bannerBase, background: 'rgba(239,68,68,0.15)', border: '2px solid #ef4444', color: '#ef4444' }}>
          BLOCKED: {timeBlockMsg}
        </div>
      )}

      {/* Rule 2 — Trade count warning */}
      {countBlocked && (
        <div style={{ ...bannerBase, background: 'rgba(239,68,68,0.15)', border: '2px solid #ef4444', color: '#ef4444' }}>
          20 TRADE LIMIT REACHED — Your data shows catastrophic losses begin here.
          <div style={{ marginTop: 8 }}>
            <button type="button" onClick={() => setCountConfirmed(true)}
              style={{ padding: '4px 12px', background: '#ef4444', border: 'none', borderRadius: 5, color: '#fff', fontSize: 12, cursor: 'pointer', fontWeight: 700, marginRight: 8 }}>
              Override anyway
            </button>
            <button type="button" onClick={onCancel}
              style={{ padding: '4px 12px', background: 'transparent', border: '1px solid #ef4444', borderRadius: 5, color: '#ef4444', fontSize: 12, cursor: 'pointer' }}>
              Stop trading
            </button>
          </div>
        </div>
      )}
      {!countBlocked && countWarning && (
        <div style={{ ...bannerBase, background: 'rgba(251,191,36,0.12)', border: '1px solid #fbbf24', color: '#fbbf24' }}>
          ⚠ {dailyTradeCount} trades today — approaching 20-trade limit where losses historically spike.
        </div>
      )}

      {/* Rule 1 — Position size warning */}
      {sizeWarning && (
        <div style={{ ...bannerBase, background: 'rgba(239,68,68,0.15)', border: '2px solid #ef4444', color: '#ef4444' }}>
          DATA SHOWS: Win rate drops from 48% → 38% at 2+ contracts. Avg PnL drops from +$0.64 → −$14.80. Are you sure?
          <div style={{ marginTop: 8 }}>
            <button type="button" onClick={() => setSizeConfirmed(true)}
              style={{ padding: '4px 12px', background: '#ef4444', border: 'none', borderRadius: 5, color: '#fff', fontSize: 12, cursor: 'pointer', fontWeight: 700, marginRight: 8 }}>
              Yes, trade {qty} contracts
            </button>
            <button type="button" onClick={() => setFormData(p => ({ ...p, quantity: 1 }))}
              style={{ padding: '4px 12px', background: 'transparent', border: '1px solid #ef4444', borderRadius: 5, color: '#ef4444', fontSize: 12, cursor: 'pointer' }}>
              Back to 1 contract
            </button>
          </div>
        </div>
      )}

      <form onSubmit={handleSubmit}>
        <div className="form-grid">
          <div className="form-group">
            <label>Entry Time *</label>
            <input 
              type="datetime-local" 
              name="entry_time"
              value={formData.entry_time}
              onChange={handleChange}
              required
            />
          </div>

          <div className="form-group">
            <label>Exit Time</label>
            <input 
              type="datetime-local" 
              name="exit_time"
              value={formData.exit_time}
              onChange={handleChange}
            />
          </div>

          <div className="form-group">
            <label>Symbol *</label>
            <input 
              type="text" 
              name="symbol"
              value={formData.symbol}
              onChange={handleChange}
              required
            />
          </div>

          <div className="form-group">
            <label>Direction *</label>
            <select name="direction" value={formData.direction} onChange={handleChange} required>
              <option value="LONG">Long</option>
              <option value="SHORT">Short</option>
            </select>
          </div>

          <div className="form-group">
            <label>Quantity *</label>
            <input 
              type="number" 
              name="quantity"
              value={formData.quantity}
              onChange={handleChange}
              min="1"
              required
            />
          </div>

          <div className="form-group">
            <label>Entry Price *</label>
            <input 
              type="number" 
              name="entry_price"
              value={formData.entry_price}
              onChange={handleChange}
              step="0.01"
              required
            />
          </div>

          <div className="form-group">
            <label>Exit Price</label>
            <input 
              type="number" 
              name="exit_price"
              value={formData.exit_price}
              onChange={handleChange}
              step="0.01"
            />
          </div>

          <div className="form-group">
            <label>Stop Loss</label>
            <input 
              type="number" 
              name="stop_loss"
              value={formData.stop_loss}
              onChange={handleChange}
              step="0.01"
            />
          </div>

          <div className="form-group">
            <label>Target</label>
            <input 
              type="number" 
              name="target"
              value={formData.target}
              onChange={handleChange}
              step="0.01"
            />
          </div>

          <div className="form-group">
            <label>P&L</label>
            <input 
              type="number" 
              name="pnl"
              value={formData.pnl}
              onChange={handleChange}
              step="0.01"
            />
          </div>

          <div className="form-group">
            <label>Fees</label>
            <input 
              type="number" 
              name="fees"
              value={formData.fees}
              onChange={handleChange}
              step="0.01"
            />
          </div>

          <div className="form-group">
            <label>Setup Type</label>
            <select name="setup_type" value={formData.setup_type} onChange={handleChange}>
              <option value="">Select...</option>
              {setupTypes.map(st => (
                <option key={st.id} value={st.name}>{st.name}</option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label>Emotional State</label>
            <select name="emotional_state" value={formData.emotional_state} onChange={handleChange}>
              <option value="">Select...</option>
              <option value="Calm">Calm</option>
              <option value="Confident">Confident</option>
              <option value="Anxious">Anxious</option>
              <option value="Frustrated">Frustrated</option>
              <option value="Revenge">Revenge Trading</option>
            </select>
          </div>
        </div>

        <div className="form-group">
          <label>Trade Notes</label>
          <textarea
            name="trade_notes"
            value={formData.trade_notes}
            onChange={handleChange}
            rows="3"
            placeholder="What was your reasoning? How did the trade develop?"
          />
        </div>


        <div className="form-group">
          <label>Mistakes Made</label>
          <textarea 
            name="mistakes"
            value={formData.mistakes}
            onChange={handleChange}
            rows="2"
            placeholder="Did you make any mistakes? What could you have done better?"
          />
        </div>

        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={onCancel}>Cancel</button>
          <button type="submit" className="btn btn-primary">
            {trade ? 'Update Trade' : 'Add Trade'}
          </button>
        </div>
      </form>
    </div>
  );
}

// ==================== TRADE CARD ====================
function TradeCard({ trade, onEdit, onDelete }) {
  const formatTime = (datetime) => {
    if (!datetime) return '-';
    return new Date(datetime).toLocaleTimeString('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const pnl = parseFloat(trade.pnl || 0);
  const isProfitable = pnl > 0;

  return (
    <div className={`trade-card ${isProfitable ? 'profitable' : 'loss'}`}>
      <div className="trade-header">
        <div className="trade-symbol">
          <span className={`direction-badge ${trade.direction.toLowerCase()}`}>
            {trade.direction}
          </span>
          <strong>{trade.symbol}</strong>
          <span className="quantity">x{formatNumber(trade.quantity, 0)}</span>
        </div>
        <div className="trade-pnl">
          <span className={`pnl-value ${isProfitable ? 'positive' : 'negative'}`}>
            {pnl >= 0 ? '+' : ''}{formatNumber(pnl)}
          </span>
        </div>
      </div>

      <div className="trade-details">
        <div className="detail-row">
          <span className="label">Entry:</span>
          <span>{formatTime(trade.entry_time)} @ ${formatNumber(trade.entry_price)}</span>
        </div>
        {trade.exit_time && (
          <div className="detail-row">
            <span className="label">Exit:</span>
            <span>{formatTime(trade.exit_time)} @ ${formatNumber(trade.exit_price)}</span>
          </div>
        )}
        {trade.setup_type && (
          <div className="detail-row">
            <span className="label">Setup:</span>
            <span>{trade.setup_type}</span>
          </div>
        )}
        {trade.emotional_state && (
          <div className="detail-row">
            <span className="label">State:</span>
            <span>{trade.emotional_state}</span>
          </div>
        )}
      </div>

      {trade.trade_notes && (
        <div className="trade-notes">
          <p>{trade.trade_notes}</p>
        </div>
      )}

      {trade.mistakes && (
        <div className="trade-mistakes">
          <strong>Mistakes:</strong> {trade.mistakes}
        </div>
      )}

      <div className="trade-actions">
        <button className="btn-icon" onClick={onEdit} title="Edit">✏️</button>
        <button className="btn-icon" onClick={onDelete} title="Delete">🗑️</button>
      </div>
    </div>
  );
}

// ==================== CALENDAR VIEW ====================
function CalendarView({ accounts, selectedAccounts, setSelectedAccounts }) {
  const [dailyLogs, setDailyLogs] = useState([]);
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [selectedDay, setSelectedDay] = useState(null);
  const [modalTrades, setModalTrades] = useState([]);
  const [modalLoading, setModalLoading] = useState(false);
  const [accountDropdownOpen, setAccountDropdownOpen] = useState(false);
  const [accountsExpanded, setAccountsExpanded] = useState(false);
  const [chartDate, setChartDate] = useState(null); // date string for chart modal
  const [chartDates, setChartDates] = useState(new Map()); // dates that already have a chart
  const [chartZoomed, setChartZoomed] = useState(false);

  const refreshChartDates = () => {
    fetch(`${API_URL}/charts/dates`)
      .then(r => r.json())
      .then(items => setChartDates(new Map(items.map(i => [i.date, i.analyzed]))))
      .catch(() => {});
  };

  useEffect(() => { refreshChartDates(); }, []);

  useEffect(() => {
    const qs = selectedAccounts.length > 0
      ? `?accounts=${selectedAccounts.map(encodeURIComponent).join(',')}`
      : '';
    fetch(`${API_URL}/daily-logs${qs}`)
      .then(r => r.json())
      .then(setDailyLogs)
      .catch(console.error);
  }, [selectedAccounts]);

  useEffect(() => {
    if (!accountDropdownOpen) return;
    const close = (e) => { if (!e.target.closest('.account-dropdown')) setAccountDropdownOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [accountDropdownOpen]);

  const toggleAccount = (account) => {
    setSelectedAccounts(prev =>
      prev.includes(account) ? prev.filter(a => a !== account) : [...prev, account]
    );
  };

  const handleDayClick = async (dateStr, log) => {
    if (!log) return;
    setSelectedDay({ dateStr, log });
    setModalTrades([]);
    setModalLoading(true);
    try {
      const res = await fetch(`${API_URL}/trades/${dateStr}`);
      setModalTrades(await res.json());
    } catch (e) { console.error(e); }
    finally { setModalLoading(false); }
  };

  const year = currentMonth.getFullYear();
  const month = currentMonth.getMonth();
  const firstDow = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const logsByDate = {};
  dailyLogs.forEach(log => {
    const d = new Date(log.log_date);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
    logsByDate[key] = log;
  });

  const cells = Array.from({ length: 42 }, (_, i) => {
    const dayNum = i - firstDow + 1;
    if (dayNum < 1 || dayNum > daysInMonth) return null;
    const dateStr = `${year}-${String(month+1).padStart(2,'0')}-${String(dayNum).padStart(2,'0')}`;
    return { dayNum, dateStr, log: logsByDate[dateStr] || null };
  });

  const todayStr = new Date().toLocaleDateString('en-CA');
  const monthLabel = currentMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  return (
    <div className="calendar-view">
      <header className="page-header"><h1>Trading Calendar</h1></header>

      <div className="cal-toolbar">
        <div className="cal-nav">
          <button className="cal-nav-btn" onClick={() => setCurrentMonth(new Date(year, month - 1, 1))}>‹</button>
          <span className="cal-month-label">{monthLabel}</span>
          <button className="cal-nav-btn" onClick={() => setCurrentMonth(new Date(year, month + 1, 1))}>›</button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div className="account-dropdown">
            <button className="account-dropdown-trigger" onClick={() => setAccountDropdownOpen(o => !o)}>
              {selectedAccounts.length === 0 || selectedAccounts.length === accounts.length
                ? 'All Accounts'
                : selectedAccounts.length === 1
                  ? selectedAccounts[0]
                  : `${selectedAccounts.length} accounts`}
              <span style={{ marginLeft: 6 }}>▾</span>
            </button>
            {accountDropdownOpen && (
              <div className="account-dropdown-menu">
                <label className="account-option">
                  <input type="checkbox"
                    checked={accounts.length > 0 && accounts.every(a => selectedAccounts.includes(a))}
                    onChange={() => setSelectedAccounts(s => accounts.every(a => s.includes(a)) ? [] : [...accounts])}
                  />
                  All Accounts
                </label>
                {(() => {
                  const isLiveAcct = a => !a.includes('TEST') && !a.includes('PRACTICE') && !a.includes('TFDRA') && !a.includes('BX') && !a.includes('S1');
                  const live = accounts.filter(isLiveAcct);
                  const sim  = accounts.filter(a => !isLiveAcct(a));
                  return (
                    <>
                      {live.length > 0 && <div style={{ fontSize: 10, color: 'var(--text-muted)', padding: '6px 12px 2px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Live</div>}
                      {live.map(a => (
                        <label key={a} className="account-option" style={{ color: 'var(--accent-green)' }}>
                          <input type="checkbox" checked={selectedAccounts.includes(a)} onChange={() => toggleAccount(a)} />
                          {a}
                        </label>
                      ))}
                      {sim.length > 0 && <div style={{ fontSize: 10, color: 'var(--text-muted)', padding: '6px 12px 2px', textTransform: 'uppercase', letterSpacing: '0.06em', borderTop: '1px solid var(--border-color)', marginTop: 4 }}>Evaluation / Sim</div>}
                      {sim.map(a => (
                        <label key={a} className="account-option">
                          <input type="checkbox" checked={selectedAccounts.includes(a)} onChange={() => toggleAccount(a)} />
                          {a}
                        </label>
                      ))}
                    </>
                  );
                })()}
              </div>
            )}
          </div>
          {selectedAccounts.length > 0 && selectedAccounts.length < accounts.length && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600, flexWrap: 'wrap' }}>
              <span>{selectedAccounts[0]}</span>
              {selectedAccounts.length > 1 && (
                <>
                  {accountsExpanded && selectedAccounts.slice(1).map(a => (
                    <React.Fragment key={a}>
                      <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>|</span>
                      <span>{a}</span>
                    </React.Fragment>
                  ))}
                  <button
                    onClick={() => setAccountsExpanded(e => !e)}
                    style={{ fontSize: 12, fontWeight: 400, color: 'var(--accent-purple)', background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px' }}
                  >
                    {accountsExpanded ? '▲ less' : `▼ +${selectedAccounts.length - 1} more`}
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="cal-grid">
        {['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d => (
          <div key={d} className="cal-dow">{d}</div>
        ))}
        {cells.map((cell, i) => {
          if (!cell) return <div key={`empty-${i}`} className="cal-cell cal-empty" />;
          const { dayNum, dateStr, log } = cell;
          const hasActivity = log && parseInt(log.trade_count) > 0;
          const pnl = hasActivity ? parseFloat(log.daily_pnl || 0) : null;
          const cls = ['cal-cell',
            hasActivity ? (pnl > 0 ? 'cal-win' : pnl < 0 ? 'cal-loss' : 'cal-flat') : '',
            dateStr === todayStr ? 'cal-today' : '',
            hasActivity ? 'cal-clickable' : '',
          ].join(' ');
          return (
            <div key={dateStr} className={cls} onClick={() => hasActivity && handleDayClick(dateStr, log)}>
              <span className="cal-day-num">{dayNum}</span>
              {hasActivity && (
                <>
                  <span className={`cal-day-pnl ${pnl >= 0 ? 'positive' : 'negative'}`}>
                    {pnl >= 0 ? '+' : ''}${formatNumber(pnl, 0)}
                  </span>
                  <span className="cal-trade-count">{log.trade_count}t</span>
                </>
              )}
              <button
                className={`cal-chart-btn${chartDates.has(dateStr) ? ' has-chart' : ''}${chartDates.get(dateStr) ? ' analyzed' : ''}`}
                title={chartDates.get(dateStr) ? 'Chart + analysis' : chartDates.has(dateStr) ? 'View chart' : 'Add chart'}
                onClick={e => { e.stopPropagation(); setChartDate(dateStr); }}
              >{chartDates.get(dateStr) ? '✅' : chartDates.has(dateStr) ? '📸' : '📸+'}</button>
            </div>
          );
        })}
      </div>

      {selectedDay && (
        <DayModal
          day={selectedDay}
          trades={modalTrades}
          loading={modalLoading}
          selectedAccounts={selectedAccounts}
          onClose={() => setSelectedDay(null)}
        />
      )}

      {chartDate && (
        <div className={`day-modal-overlay${chartZoomed ? ' day-modal-overlay-fullscreen' : ''}`} onClick={() => { setChartDate(null); setChartZoomed(false); }}>
          <div className={`chart-date-modal${chartZoomed ? ' chart-date-modal-wide' : ''}`} onClick={e => e.stopPropagation()}>
            <div className="chart-date-modal-header">
              <span>📸 Price Action — {new Date(chartDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}</span>
              {chartZoomed && <button className="btn btn-secondary" style={{fontSize:11,padding:'2px 10px'}} onClick={() => setChartZoomed(false)}>Collapse</button>}
              <button className="day-modal-close" onClick={() => { setChartDate(null); setChartZoomed(false); }}>✕</button>
            </div>
            <div className={chartZoomed ? 'chart-date-modal-split' : 'chart-date-modal-body'}>
              <ChartUploadSection
                dateStr={chartDate}
                accounts={selectedAccounts}
                zoomed={chartZoomed}
                onZoom={setChartZoomed}
                onChartChange={refreshChartDates}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const AXIS_ZOOM = 5;

function ChartWithCrosshair({ src, onClick }) {
  const canvasRef = useRef();
  const imgRef = useRef();

  const draw = (e) => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return;
    const rect = img.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;

    // Size canvas at full device resolution for sharp rendering
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    const parentRect = canvas.parentElement.getBoundingClientRect();
    canvas.style.left = (rect.left - parentRect.left) + 'px';
    canvas.style.top = (rect.top - parentRect.top) + 'px';

    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr); // all coords in CSS pixels from here

    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const scaleX = img.naturalWidth / rect.width;
    const scaleY = img.naturalHeight / rect.height;

    ctx.clearRect(0, 0, rect.width, rect.height);

    // Crosshair lines
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(rect.width, y); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, rect.height); ctx.stroke();
    ctx.setLineDash([]);

    const drawStrip = (srcX, srcY, srcW, srcH, destX, destY, destW, destH) => {
      ctx.save();
      ctx.beginPath();
      ctx.rect(destX, destY, destW, destH);
      ctx.clip();
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, srcX, srcY, srcW, srcH, destX, destY, destW, destH);
      ctx.restore();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
      ctx.lineWidth = 1;
      ctx.strokeRect(destX, destY, destW, destH);
    };

    // ── X-AXIS STRIP: inset from bottom, follows cursor x ──
    const xsW = 300, xsH = 64;
    const xInset = 70; // gap from bottom edge
    const xSrcW = (xsW / AXIS_ZOOM) * scaleX;
    const xSrcH = img.naturalHeight * 0.05;
    const xSrcX = Math.max(0, Math.min(img.naturalWidth - xSrcW, x * scaleX - xSrcW / 2));
    const xSrcY = img.naturalHeight - xSrcH;
    const xDestX = Math.max(0, Math.min(rect.width - xsW, x - xsW / 2));
    const xDestY = rect.height - xsH - xInset;
    drawStrip(xSrcX, xSrcY, xSrcW, xSrcH, xDestX, xDestY, xsW, xsH);
    // Vertical crosshair line through the box
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(x, xDestY); ctx.lineTo(x, rect.height); ctx.stroke();
    ctx.setLineDash([]);

    // ── Y-AXIS STRIP: inset from right, follows cursor y ──
    const ysW = 130, ysH = 64;
    const yInset = 70; // gap from right edge
    const ySrcH = (ysH / AXIS_ZOOM) * scaleY;
    const ySrcW = img.naturalWidth * 0.07;
    const ySrcX = img.naturalWidth - ySrcW;
    const ySrcY = Math.max(0, Math.min(img.naturalHeight - ySrcH, y * scaleY - ySrcH / 2));
    const yDestX = rect.width - ysW - yInset;
    const yDestY = Math.max(0, Math.min(rect.height - ysH, y - ysH / 2));
    drawStrip(ySrcX, ySrcY, ySrcW, ySrcH, yDestX, yDestY, ysW, ysH);
    // Horizontal crosshair line through the box
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(yDestX, y); ctx.lineTo(rect.width, y); ctx.stroke();
    ctx.setLineDash([]);
  };

  const clear = () => {
    const canvas = canvasRef.current;
    if (canvas) canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
  };

  return (
    <div className="chart-crosshair-wrap" onClick={onClick} title="Click to collapse"
      onMouseMove={draw} onMouseLeave={clear}>
      <img ref={imgRef} src={src} alt="Price action chart" className="chart-screenshot-large" />
      <canvas ref={canvasRef} className="chart-crosshair-canvas" />
    </div>
  );
}

function ChartUploadSection({ dateStr, accounts = [], zoomed = false, onZoom, onChartChange }) {
  const [chartInfo, setChartInfo] = useState(undefined); // undefined=loading, null=none
  const [uploading, setUploading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [splitRatio, setSplitRatio] = useState(0.28); // fraction of width for analysis panel
  const splitContainerRef = useRef(null);
  const isDragging = useRef(false);

  const onDividerMouseDown = (e) => {
    e.preventDefault();
    isDragging.current = true;
    const onMove = (ev) => {
      if (!isDragging.current || !splitContainerRef.current) return;
      const rect = splitContainerRef.current.getBoundingClientRect();
      const ratio = Math.min(0.7, Math.max(0.15, (ev.clientX - rect.left) / rect.width));
      setSplitRatio(ratio);
    };
    const onUp = () => {
      isDragging.current = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };
  const [chartType, setChartType] = useState('daily');
  const fileRef = useRef();

  useEffect(() => {
    fetch(`${API_URL}/charts/${dateStr}`)
      .then(r => r.json())
      .then(d => { setChartInfo(d); if (d) setExpanded(true); })
      .catch(() => setChartInfo(null));
  }, [dateStr]);

  const handleUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setUploading(true);
    const fd = new FormData();
    fd.append('chart', file);
    fd.append('chart_type', chartType);
    try {
      const res = await fetch(`${API_URL}/charts/${dateStr}/upload`, { method: 'POST', body: fd });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setChartInfo({ image_url: data.image_url, analysis: null, chart_type: chartType });
      setExpanded(true);
      onChartChange?.();
    } catch(err) { alert(err.message); }
    finally { setUploading(false); e.target.value = ''; }
  };

  const handleAnalyze = async () => {
    setAnalyzing(true);
    try {
      const res = await fetch(`${API_URL}/charts/${dateStr}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chart_type: chartInfo?.chart_type || chartType, accounts })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setChartInfo(prev => ({ ...prev, analysis: data.analysis, analyzed_at: data.analyzed_at, chart_start: data.chart_start, chart_end: data.chart_end, chart_price_low: data.chart_price_low, chart_price_high: data.chart_price_high }));
      onChartChange?.();
    } catch(err) { alert(err.message); }
    finally { setAnalyzing(false); }
  };

  const handleDelete = async () => {
    if (!confirm('Remove this chart?')) return;
    await fetch(`${API_URL}/charts/${dateStr}`, { method: 'DELETE' });
    setChartInfo(null);
    setExpanded(false);
    onChartChange?.();
  };

  if (chartInfo === undefined) return null;

  return (
    <div className="chart-upload-section">
      <div className="chart-upload-header" onClick={() => setExpanded(e => !e)}>
        <span className="chart-upload-title">
          {chartInfo ? '📸 Price Action Chart' : '📸 Add Price Action Chart'}
        </span>
        {chartInfo && <span className="sub-text" style={{ fontSize: 11 }}>{chartInfo.chart_type === 'weekly' ? 'Weekly Prep' : 'Daily'}</span>}
        <span className="chart-upload-toggle">{expanded ? '▲' : '▼'}</span>
      </div>

      {expanded && (
        <div className="chart-upload-body">
          {!chartInfo ? (
            <div className="chart-upload-empty">
              <div className="chart-type-row">
                <label className="chart-type-label">Type:</label>
                {['daily','weekly'].map(t => (
                  <button key={t} className={`traj-dow-pill${chartType === t ? ' active' : ''}`} onClick={() => setChartType(t)}>
                    {t === 'daily' ? 'Daily' : 'Weekly Prep'}
                  </button>
                ))}
              </div>
              <button className="btn btn-secondary chart-upload-btn" onClick={() => fileRef.current.click()} disabled={uploading}>
                {uploading ? 'Uploading...' : 'Upload Screenshot'}
              </button>
              <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleUpload} />
            </div>
          ) : zoomed ? (
            <div className="chart-split-layout" ref={splitContainerRef}>
              <div className="chart-split-analysis" style={{ width: `${splitRatio * 100}%` }}>
                <div className="chart-upload-actions" style={{ marginBottom: 12 }}>
                  <button className="btn btn-primary" onClick={handleAnalyze} disabled={analyzing}>
                    {analyzing ? 'Analyzing...' : chartInfo.analysis ? 'Re-analyze' : 'Analyze with Claude'}
                  </button>
                  <button className="btn btn-secondary" onClick={() => fileRef.current.click()} disabled={uploading}>
                    {uploading ? 'Uploading...' : 'Replace'}
                  </button>
                  <button className="btn btn-danger" onClick={handleDelete}>Remove</button>
                  <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleUpload} />
                </div>
                {chartInfo.analysis && (
                  <div className="chart-analysis">
                    <div className="chart-analysis-label">Claude Analysis</div>
                    <div className="chart-analysis-text">{chartInfo.analysis}</div>
                    {chartInfo.analyzed_at && (
                      <div className="sub-text" style={{ fontSize: 11, marginTop: 6 }}>
                        Analyzed {new Date(chartInfo.analyzed_at).toLocaleString()}
                      </div>
                    )}
                  </div>
                )}
              </div>
              <div className="chart-split-divider" onMouseDown={onDividerMouseDown} />
              <div className="chart-split-image" style={{ width: `${(1 - splitRatio) * 100}%` }}>
                <ChartWithCrosshair
                  src={chartInfo.image_url}
                  onClick={() => onZoom?.(false)}
                />
              </div>
            </div>
          ) : (
            <div className="chart-upload-content">
              <img src={chartInfo.image_url} alt="Price action chart" className="chart-screenshot" onClick={() => onZoom?.(true)} />
              <div className="chart-upload-actions">
                <button className="btn btn-primary" onClick={handleAnalyze} disabled={analyzing}>
                  {analyzing ? 'Analyzing...' : chartInfo.analysis ? 'Re-analyze' : 'Analyze with Claude'}
                </button>
                <button className="btn btn-secondary" onClick={() => fileRef.current.click()} disabled={uploading}>
                  {uploading ? 'Uploading...' : 'Replace'}
                </button>
                <button className="btn btn-danger" onClick={handleDelete}>Remove</button>
                <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleUpload} />
              </div>
              {chartInfo.analysis && (
                <div className="chart-analysis">
                  <div className="chart-analysis-label">Claude Analysis</div>
                  <div className="chart-analysis-text">{chartInfo.analysis}</div>
                  {chartInfo.analyzed_at && (
                    <div className="sub-text" style={{ fontSize: 11, marginTop: 6 }}>
                      Analyzed {new Date(chartInfo.analyzed_at).toLocaleString()}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DayModal({ day, trades, loading, selectedAccounts, onClose }) {
  const { dateStr, log } = day;
  const [highlightedGroup, setHighlightedGroup] = useState(null);
  const rowRefs = useRef({});
  const [localLog, setLocalLog] = useState({
    pre_market_notes: log?.pre_market_notes || '',
    post_market_notes: log?.post_market_notes || '',
    lessons_learned: log?.lessons_learned || '',
    sleep_quality: log?.sleep_quality || '',
    mood: log?.mood || '',
    market_condition: log?.market_condition || '',
  });
  const [localTagEdits, setLocalTagEdits] = useState(new Map());
  const [tagInputValues, setTagInputValues] = useState({});
  const [activeTagGroup, setActiveTagGroup] = useState(null);
  const [crosshair, setCrosshair] = useState(null); // { pixelY, yValue, xValue (timestamp) }
  const [accountsExpanded, setAccountsExpanded] = useState(false);

  const saveLogField = async (field, value) => {
    try {
      await fetch(`${API_URL}/daily-logs/${dateStr}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: value }),
      });
    } catch (e) { console.error(e); }
  };

  // Filter by selected accounts, then deduplicate
  const accountFiltered = selectedAccounts.length === 0
    ? trades
    : trades.filter(t => selectedAccounts.includes(t.custom_fields?.account));

  // No client-side dedup — the import service already prevents DB duplicates via count-based dedup.
  // Client-side dedup was silently dropping valid EP fills that shared prices/times with
  // non-EP fills in the same session (common with scaling positions).
  const fills = [...accountFiltered].sort((a, b) => {
    const timeDiff = new Date(a.entry_time) - new Date(b.entry_time);
    if (timeDiff !== 0) return timeDiff;
    return (a.custom_fields?.sierra_row ?? 0) - (b.custom_fields?.sierra_row ?? 0);
  });

  // Map each fill.id → flat-to-flat group key using EP in Exit DateTime as boundary
  const fillGroupMap = useMemo(() => {
    const map = new Map();
    const bySymDir = new Map();
    fills.forEach(f => {
      const k = `${f.symbol}|${f.direction}`;
      if (!bySymDir.has(k)) bySymDir.set(k, []);
      bySymDir.get(k).push(f);
    });
    bySymDir.forEach((group, symDir) => {
      const sorted = [...group].sort((a, b) => {
        const td = new Date(a.entry_time) - new Date(b.entry_time);
        if (td !== 0) return td;
        return (a.custom_fields?.sierra_row ?? 0) - (b.custom_fields?.sierra_row ?? 0);
      });
      const sessionEndTimes = [...new Set(
        sorted
          .filter(f => {
            const exitDT = f.custom_fields?.sierra_data?.['Exit DateTime'] || '';
            return typeof exitDT === 'string' && exitDT.trimEnd().endsWith('EP');
          })
          .map(f => f.exit_time)
      )].sort();
      const boundaries = sessionEndTimes.length > 0
        ? sessionEndTimes
        : [sorted[sorted.length - 1]?.exit_time].filter(Boolean);
      sorted.forEach(fill => {
        const boundary = boundaries.find(b => new Date(b) >= new Date(fill.exit_time));
        const assignTo = boundary ?? boundaries[boundaries.length - 1];
        map.set(fill.id, `${symDir}|${assignTo}`);
      });
    });
    return map;
  }, [fills]);

  // Map each fill.id → fill label (Entry / Add / Partial Exit / Exit) using BP/EP markers
  const fillLabelMap = useMemo(() => {
    const map = new Map();
    const byGroup = new Map();
    fills.forEach(f => {
      const k = fillGroupMap.get(f.id);
      if (!k) return;
      if (!byGroup.has(k)) byGroup.set(k, []);
      byGroup.get(k).push(f);
    });
    byGroup.forEach(group => {
      const sorted = [...group].sort((a, b) => {
        const td = new Date(a.entry_time) - new Date(b.entry_time);
        if (td !== 0) return td;
        return (a.custom_fields?.sierra_row ?? 0) - (b.custom_fields?.sierra_row ?? 0);
      });
      const hasBPEP = sorted.some(f => {
        const sd = f.custom_fields?.sierra_data || {};
        return sd['Entry DateTime']?.includes('BP') || sd['Exit DateTime']?.includes('EP');
      });
      if (hasBPEP) {
        // TAL format: use BP/EP markers + position qty tracking
        let prevCloseQty = 0;
        sorted.forEach(fill => {
          const sd = fill.custom_fields?.sierra_data || {};
          const isBP = !!sd['Entry DateTime']?.includes('BP');
          const isEP = !!sd['Exit DateTime']?.includes('EP');
          const openQty = Math.abs(parseFloat(sd['Open Position Quantity'] ?? 0));
          const closeQty = Math.abs(parseFloat(sd['Close Position Quantity'] ?? 0));
          const isAdd = !isBP && prevCloseQty > 0 && openQty > prevCloseQty;
          prevCloseQty = closeQty;
          map.set(fill.id, isBP ? 'Entry' : isEP ? 'Exit' : (isAdd ? 'Add' : 'Partial Exit'));
        });
      } else {
        // Activity Log format: use OpenClose + position tracking to label fills
        let position = 0;
        sorted.forEach(fill => {
          const openClose = fill.custom_fields?.open_close || fill.custom_fields?.sierra_data?.OpenClose || '';
          const buySell = fill.custom_fields?.buy_sell || fill.custom_fields?.sierra_data?.BuySell || '';
          const qty = fill.quantity || 0;
          const isOpen = openClose === 'Open';
          const isBuy = buySell === 'Buy';
          const posBefore = position;
          position += isBuy ? qty : -qty;
          const posAfter = position;
          let label;
          if (isOpen) {
            label = posBefore === 0 ? 'Entry' : 'Add';
          } else {
            label = posAfter === 0 ? 'Exit' : 'Partial Exit';
          }
          map.set(fill.id, label);
        });
      }
    });
    return map;
  }, [fills, fillGroupMap]);

  // Tags derived from EP fill's tags field per group
  const derivedGroupTags = useMemo(() => {
    const map = new Map();
    fills.forEach(f => {
      const group = fillGroupMap.get(f.id);
      if (!group || map.has(group)) return;
      const exitDT = f.custom_fields?.sierra_data?.['Exit DateTime'] || '';
      if (!exitDT.trimEnd().endsWith('EP')) return;
      const raw = f.tags;
      if (!raw) return;
      const tags = Array.isArray(raw) ? raw : (typeof raw === 'string' ? raw.split(',').filter(Boolean) : []);
      if (tags.length > 0) map.set(group, tags);
    });
    return map;
  }, [fills, fillGroupMap]);

  const getGroupTags = (group) =>
    localTagEdits.has(group) ? localTagEdits.get(group) : (derivedGroupTags.get(group) || []);

  const saveGroupTags = async (group, tags) => {
    setLocalTagEdits(prev => new Map(prev).set(group, tags));
    const epFill = fills.find(f => {
      const exitDT = f.custom_fields?.sierra_data?.['Exit DateTime'] || '';
      return fillGroupMap.get(f.id) === group && exitDT.trimEnd().endsWith('EP');
    });
    if (!epFill) return;
    try {
      await fetch(`${API_URL}/trades/${epFill.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags: JSON.stringify(tags) }),
      });
    } catch (e) { console.error(e); }
  };

  const addTag = (group, tag) => {
    const current = getGroupTags(group);
    if (!current.includes(tag)) saveGroupTags(group, [...current, tag]);
  };

  const removeTag = (group, tag) => {
    saveGroupTags(group, getGroupTags(group).filter(t => t !== tag));
  };

  // startBalance: 0 for TAL format (chart shows relative intraday P&L)
  const firstFill = fills[0];
  const firstFillBalance = parseFloat(
    firstFill?.custom_fields?.account_balance ||
    firstFill?.custom_fields?.sierra_data?.AccountBalance || 0
  );
  const firstFillPnl = parseFloat(firstFill?.pnl) || 0;
  const startBalance = firstFillBalance > 0 ? firstFillBalance - firstFillPnl : 0;

  // Build LINE data using Cumulative P&L (CumPL) diff — the same source the calendar backend uses.
  // FlatToFlat and SUM(f.pnl) are unreliable across sessions; CumPL is the ground truth.
  // Strategy:
  //   startCumPL = firstEP.CumPL − firstEP.FlatToFlat  (the CumPL before today's trading)
  //   intradayCumPnl at each EP = startBalance + (EP.CumPL − startCumPL)
  // FlatToFlat Profit/Loss (C) accumulates within a session.
  // Only the EP row gets the "F" suffix, marking the FINAL session P&L.
  // Sum those "F" values in time order → intraday cumulative P&L (verified = -$652).
  const getFtfStr = f => String(
    f.custom_fields?.sierra_data?.['FlatToFlat Profit/Loss (C)'] ||
    f.custom_fields?.flat_to_flat_pl || ''
  ).trim();
  const isFinalFill = f => getFtfStr(f).toUpperCase().endsWith('F');
  const parseFtf = f => parseFloat(getFtfStr(f).replace(/\s*F$/i, '')) || 0;

  const epFillsSorted = fills
    .filter(isFinalFill)
    .sort((a, b) => new Date(a.exit_time) - new Date(b.exit_time));

  const exitPoints = [];
  const epSessionPnlMap = new Map(); // epFill.id → session P&L

  // Helper to read Cumulative P&L from a fill
  const parseCumPL = f => {
    const v = f.custom_fields?.sierra_data?.['Cumulative Profit/Loss (C)'] ||
      f.custom_fields?.cumulative_pl;
    if (v == null || v === '') return null;
    const n = parseFloat(v);
    return isNaN(n) ? null : n;
  };

  if (epFillsSorted.length > 0) {
    // Build epSessionPnlMap from "F" fills (accurate per-session P&L for dots/tooltips)
    epFillsSorted.forEach(f => epSessionPnlMap.set(f.id, parseFtf(f)));

    // Anchor: derive the account CumPL before today started
    // startCumPL = firstEP.CumPL − firstEP.FlatToFlat  (first session P&L)
    const firstEPCumPL = parseCumPL(epFillsSorted[0]);
    const startCumPL = firstEPCumPL != null
      ? firstEPCumPL - parseFtf(epFillsSorted[0])
      : null;

    if (startCumPL != null) {
      // Use ALL fills' CumPL for the line — shows adds and partial exits within each session.
      // Each fill's intradayCumPnl = startBalance + (fill.CumPL − startCumPL)
      [...fills]
        .sort((a, b) => new Date(a.exit_time) - new Date(b.exit_time))
        .forEach(f => {
          const cumPL = parseCumPL(f);
          if (cumPL == null) return;
          exitPoints.push({
            time: new Date(f.exit_time).getTime(),
            cumPnl: startBalance + (cumPL - startCumPL),
            isEntry: false,
            trade: f,
          });
        });
    } else {
      // CumPL not available — fall back to EP-only steps
      let running = startBalance;
      epFillsSorted.forEach(f => {
        running += parseFtf(f);
        exitPoints.push({ time: new Date(f.exit_time).getTime(), cumPnl: running, isEntry: false, trade: f });
      });
    }
  } else {
    // Fallback for non-TAL format (no F marker): sum all fill pnls
    let running = startBalance;
    fills.forEach(f => {
      running += parseFloat(f.pnl) || 0;
      exitPoints.push({ time: new Date(f.exit_time).getTime(), cumPnl: running, isEntry: false, trade: f });
    });
  }

  // totalPnl: sum of all "F" FlatToFlat values (matches calendar); fallback to SUM(pnl)
  const totalPnl = epFillsSorted.length > 0
    ? epFillsSorted.reduce((s, f) => s + parseFtf(f), 0)
    : fills.reduce((s, f) => s + (parseFloat(f.pnl) || 0), 0);

  // Build SESSION dot data: one dot per flat-to-flat group placed at the BP entry time.
  // Dots sit at the P&L level BEFORE the session, colored by session result.
  // Colored line segments (green/red) are overlaid on a dim base line.
  const seenGroupDots = new Set();
  const entryPoints = [];
  const sessionSegs = []; // { entryTs, exitTs, color, key }

  fills.forEach(f => {
    const groupKey = fillGroupMap.get(f.id);
    if (!groupKey || seenGroupDots.has(groupKey)) return;
    const label = fillLabelMap.get(f.id);
    const groupFills = fills.filter(gf => fillGroupMap.get(gf.id) === groupKey);
    const hasBP = groupFills.some(gf => fillLabelMap.get(gf.id) === 'Entry');
    // Trigger once per group via the BP fill (or first fill if no BP)
    if (hasBP && label !== 'Entry') return;
    if (!hasBP && f !== groupFills[0]) return;
    seenGroupDots.add(groupKey);

    // P&L: CumPL diff from epSessionPnlMap (same source as calendar). Fallback to FlatToFlat.
    const epFill = groupFills.find(gf => fillLabelMap.get(gf.id) === 'Exit');
    let groupPnl;
    if (epFill && epSessionPnlMap.has(epFill.id)) {
      groupPnl = epSessionPnlMap.get(epFill.id);
    } else {
      const flatToFlatRaw = String(
        epFill?.custom_fields?.sierra_data?.['FlatToFlat Profit/Loss (C)'] ||
        epFill?.custom_fields?.flat_to_flat_pl || ''
      ).trim().replace(/\s*F$/i, '');
      groupPnl = flatToFlatRaw !== ''
        ? parseFloat(flatToFlatRaw)
        : groupFills.reduce((s, gf) => s + (parseFloat(gf.pnl) || 0), 0);
    }

    // Max Open Quantity: max across all fills in the group
    const maxOpenQty = groupFills.reduce((mx, gf) => {
      const q = parseFloat(gf.custom_fields?.sierra_data?.['Max Open Quantity'] ?? 0);
      return Math.max(mx, q);
    }, 0) || f.quantity;

    // Place dot at BP entry time (start of session)
    const entryTs = new Date(f.entry_time).getTime();
    const exitTs = epFill ? new Date(epFill.exit_time).getTime() : new Date(f.exit_time).getTime();

    // cumPnl just before this session (last exitPoint at or before entryTs)
    let cumBefore = startBalance;
    for (const ep of exitPoints) {
      if (ep.time <= entryTs) cumBefore = ep.cumPnl;
      else break;
    }

    // Register colored segment for this session
    sessionSegs.push({
      entryTs, exitTs,
      color: groupPnl >= 0 ? '#22c55e' : '#ef4444',
      key: `seg${sessionSegs.length}`
    });

    entryPoints.push({
      time: entryTs,
      cumPnl: cumBefore,
      isEntry: true,
      trade: { ...f, pnl: groupPnl, quantity: maxOpenQty, exit_time: epFill?.exit_time || f.exit_time }
    });
  });

  const earliestTime = fills.length > 0
    ? Math.min(...fills.map(f => new Date(f.entry_time).getTime()))
    : 0;

  // Merge all raw points; at the same timestamp, entry dot wins
  const rawPoints = fills.length === 0 ? [] : [
    { time: earliestTime - 120000, cumPnl: startBalance, isEntry: false, trade: null },
    ...exitPoints.map(ep => ({ ...ep, isEntry: false, trade: null })),
    ...entryPoints,
  ].sort((a, b) => a.time - b.time || (a.isEntry ? 1 : -1));

  const timeMap = new Map();
  for (const pt of rawPoints) {
    if (!timeMap.has(pt.time) || pt.isEntry) timeMap.set(pt.time, pt);
  }

  // Build a lookup: entryTs → entry point (for tooltip persistence)
  const entryByTs = new Map(entryPoints.map(ep => [ep.time, ep]));

  const chartData = [...timeMap.values()].sort((a, b) => a.time - b.time).map(pt => {
    const row = { time: pt.time, cumPnl: pt.cumPnl, isEntry: pt.isEntry, trade: pt.trade };
    sessionSegs.forEach(seg => {
      row[seg.key] = (pt.time >= seg.entryTs && pt.time <= seg.exitTs) ? pt.cumPnl : null;
    });
    // For non-entry points within a session, attach session info so the tooltip persists
    if (!pt.isEntry) {
      const seg = sessionSegs.find(s => pt.time > s.entryTs && pt.time <= s.exitTs);
      if (seg) {
        const ep = entryByTs.get(seg.entryTs);
        if (ep) { row.sessionTrade = ep.trade; row.sessionCumBefore = ep.cumPnl; }
      }
    }
    return row;
  });

  const dateLabel = new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
  });

  const fmtTime = ts => new Date(ts).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const fmtElapsed = (entry, exit) => {
    const s = Math.floor((new Date(exit) - new Date(entry)) / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60), rs = s % 60;
    if (m < 60) return `${m}m ${rs}s`;
    return `${Math.floor(m/60)}h ${m%60}m`;
  };

  // Y reference line: at startBalance (0 intraday P&L mark)
  const refY = startBalance;

  const handleDotClick = (trade) => {
    if (!trade) return;
    const group = fillGroupMap.get(trade.id);
    setHighlightedGroup(prev => prev === group ? null : group);
    // Scroll to the first fill in the group
    const firstInGroup = fills.find(f => fillGroupMap.get(f.id) === group);
    if (firstInGroup) {
      const el = rowRefs.current[firstInGroup.id];
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  };

  const DotRenderer = (props) => {
    const { cx, cy, payload } = props;
    if (!payload.isEntry || cx == null || cy == null) return <g />;
    const isHighlighted = highlightedGroup && fillGroupMap.get(payload.trade?.id) === highlightedGroup;
    const color = (parseFloat(payload.trade?.pnl) || 0) >= 0 ? '#22c55e' : '#ef4444';
    return (
      <circle
        cx={cx} cy={cy}
        r={isHighlighted ? 7 : 5}
        fill={color}
        stroke={isHighlighted ? '#fff' : '#0f0f1a'}
        strokeWidth={isHighlighted ? 2.5 : 2}
        style={{ cursor: 'pointer' }}
        onClick={() => handleDotClick(payload.trade)}
      />
    );
  };

  const CustomTooltip = ({ active, payload }) => {
    if (!active || !payload?.[0]) return null;
    const d = payload[0].payload;
    const t = d.isEntry ? d.trade : d.sessionTrade;
    if (!t) return null;
    const cumBefore = d.isEntry ? d.cumPnl : (d.sessionCumBefore ?? d.cumPnl);
    const group = fillGroupMap.get(t.id);
    const tags = group ? getGroupTags(group) : [];
    const cum = cumBefore + (parseFloat(t.pnl) || 0);
    return (
      <div className="day-modal-tooltip">
        <div><strong>{t.symbol}</strong> &nbsp;<span className={`direction-badge ${t.direction?.toLowerCase()}`}>{t.direction}</span></div>
        <div>Qty: {t.quantity} &nbsp;·&nbsp; {fmtTime(t.entry_time)}</div>
        <div className={(parseFloat(t.pnl) || 0) >= 0 ? 'positive' : 'negative'}><strong>P&L: ${formatNumber(t.pnl)}</strong></div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          Cumulative: <span className={cum >= 0 ? 'positive' : 'negative'}><strong>${formatNumber(cum)}</strong></span>
        </div>
        <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>Duration: {fmtElapsed(t.entry_time, t.exit_time)}</div>
        {tags.length > 0 && (
          <div className="tooltip-tags">
            {tags.map(tag => <span key={tag} className="tag-chip small">{tag}</span>)}
          </div>
        )}
      </div>
    );
  };

  const pnlPositive = totalPnl >= 0;

  return (
    <div className="day-modal-overlay" onClick={onClose}>
      <div className="day-modal" onClick={e => e.stopPropagation()}>
        <div className="day-modal-header">
          <div>
            <h2>{dateLabel}</h2>
            {selectedAccounts.length > 0 && (
              <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span>{selectedAccounts[0]}</span>
                {selectedAccounts.length > 1 && (
                  <>
                    {accountsExpanded && selectedAccounts.slice(1).map(a => (
                      <React.Fragment key={a}>
                        <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>|</span>
                        <span>{a}</span>
                      </React.Fragment>
                    ))}
                    <button
                      onClick={() => setAccountsExpanded(e => !e)}
                      style={{ fontSize: 12, fontWeight: 400, color: 'var(--accent-purple)', background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px' }}
                    >
                      {accountsExpanded ? '▲ less' : `▼ +${selectedAccounts.length - 1} more`}
                    </button>
                  </>
                )}
              </div>
            )}
            <span className={`day-modal-pnl ${pnlPositive ? 'positive' : 'negative'}`}>
              {pnlPositive ? '+' : ''}${formatNumber(totalPnl)} &nbsp;·&nbsp; {fills.length} fills &nbsp;·&nbsp;
              <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>
                ${formatNumber(fills.reduce((s, f) => s + (parseFloat(f.quantity) || 0), 0) * 0.50 * 2)} paid in commissions
              </span>
            </span>
          </div>
          <button className="day-modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="day-modal-dropdowns">
          <div className="notes-field">
            <label>Sleep Quality</label>
            <select
              value={localLog.sleep_quality}
              onChange={e => { setLocalLog(p => ({ ...p, sleep_quality: e.target.value })); saveLogField('sleep_quality', e.target.value); }}
            >
              <option value="">Select...</option>
              <option value="Poor">Poor</option>
              <option value="Fair">Fair</option>
              <option value="Good">Good</option>
              <option value="Excellent">Excellent</option>
            </select>
          </div>
          <div className="notes-field">
            <label>Mood</label>
            <select
              value={localLog.mood}
              onChange={e => { setLocalLog(p => ({ ...p, mood: e.target.value })); saveLogField('mood', e.target.value); }}
            >
              <option value="">Select...</option>
              <option value="Anxious">Anxious</option>
              <option value="Calm">Calm</option>
              <option value="Focused">Focused</option>
              <option value="Tired">Tired</option>
              <option value="Energetic">Energetic</option>
            </select>
          </div>
          <div className="notes-field">
            <label>Market Condition</label>
            <select
              value={localLog.market_condition}
              onChange={e => { setLocalLog(p => ({ ...p, market_condition: e.target.value })); saveLogField('market_condition', e.target.value); }}
            >
              <option value="">Select...</option>
              <option value="Trending">Trending</option>
              <option value="Choppy">Choppy</option>
              <option value="Ranging">Ranging</option>
              <option value="Volatile">Volatile</option>
            </select>
          </div>
        </div>

        <div className="day-modal-notes">
          <div className="notes-field">
            <label>Pre-Market</label>
            <textarea
              value={localLog.pre_market_notes}
              placeholder="Pre-market notes..."
              onChange={e => setLocalLog(p => ({ ...p, pre_market_notes: e.target.value }))}
              onBlur={e => saveLogField('pre_market_notes', e.target.value)}
              rows={4}
            />
          </div>
          <div className="notes-field">
            <label>Post-Market</label>
            <textarea
              value={localLog.post_market_notes}
              placeholder="Post-market notes..."
              onChange={e => setLocalLog(p => ({ ...p, post_market_notes: e.target.value }))}
              onBlur={e => saveLogField('post_market_notes', e.target.value)}
              rows={4}
            />
          </div>
          <div className="notes-field">
            <label>Lessons</label>
            <textarea
              value={localLog.lessons_learned}
              placeholder="Lessons learned..."
              onChange={e => setLocalLog(p => ({ ...p, lessons_learned: e.target.value }))}
              onBlur={e => saveLogField('lessons_learned', e.target.value)}
              rows={4}
            />
          </div>
        </div>

        {loading ? (
          <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-secondary)' }}>Loading...</div>
        ) : chartData.length < 2 ? (
          <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-secondary)' }}>No trade data for selected account</div>
        ) : (
          <div className="day-modal-chart">
            {crosshair && (
              <div
                className="chart-yaxis-label"
                style={{ top: crosshair.pixelY + 20 }}
              >
                ${formatNumber(crosshair.yValue, 0)}
              </div>
            )}
            {crosshair && (
              <div
                className="chart-xaxis-label"
                style={{ left: crosshair.pixelX + 10 }}
              >
                {new Date(crosshair.xValue).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </div>
            )}
            <ResponsiveContainer width="100%" height={380}>
              <LineChart
                data={chartData}
                margin={{ top: 20, right: 24, left: 10, bottom: 8 }}
                onMouseMove={e => {
                  if (e?.activeCoordinate && e?.activePayload?.length) {
                    setCrosshair({
                      pixelY: e.activeCoordinate.y,
                      pixelX: e.activeCoordinate.x,
                      yValue: e.activePayload[0].value,
                      xValue: e.activeLabel,
                    });
                  }
                }}
                onMouseLeave={() => setCrosshair(null)}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                <XAxis
                  dataKey="time" type="number" scale="time" domain={['dataMin', 'dataMax']}
                  tickFormatter={ts => new Date(ts).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' })}
                  tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
                />
                <YAxis
                  tickFormatter={v => `$${formatNumber(v, 0)}`}
                  tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
                  width={80}
                />
                <ReferenceLine y={refY} stroke="rgba(255,255,255,0.2)" strokeDasharray="4 4" />
                <Tooltip
                  content={<CustomTooltip />}
                  cursor={{ stroke: 'rgba(255,255,255,0.25)', strokeWidth: 1 }}
                />
                <Line
                  type="stepAfter"
                  dataKey="cumPnl"
                  stroke="rgba(255,255,255,0.15)"
                  strokeWidth={1.5}
                  dot={<DotRenderer />}
                  activeDot={{ r: 0 }}
                  isAnimationActive={false}
                />
                {sessionSegs.map(seg => (
                  <Line
                    key={seg.key}
                    type="stepAfter"
                    dataKey={seg.key}
                    stroke={seg.color}
                    strokeWidth={2.5}
                    dot={false}
                    activeDot={{ r: 0 }}
                    isAnimationActive={false}
                    connectNulls={false}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}

        {!loading && exitPoints.length > 0 && (
          <details style={{ margin: '0 24px 12px', fontSize: 11, color: 'var(--text-muted)' }}>
            <summary style={{ cursor: 'pointer', marginBottom: 6 }}>
              📊 Chart data ({exitPoints.length} points, total: ${exitPoints.length > 0 ? (exitPoints[exitPoints.length-1].cumPnl - startBalance).toFixed(2) : 0})
            </summary>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 10 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
                  <th style={{ textAlign: 'left', padding: '2px 6px' }}>#</th>
                  <th style={{ textAlign: 'left', padding: '2px 6px' }}>EP Exit Time</th>
                  <th style={{ textAlign: 'right', padding: '2px 6px' }}>FlatToFlat raw</th>
                  <th style={{ textAlign: 'right', padding: '2px 6px' }}>Session P&L</th>
                  <th style={{ textAlign: 'right', padding: '2px 6px' }}>Cumulative</th>
                </tr>
              </thead>
              <tbody>
                {exitPoints.map((ep, i) => {
                  const ftfRaw = getFtfStr(ep.trade);
                  const sessionPnl = epSessionPnlMap.get(ep.trade?.id);
                  return (
                    <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                      <td style={{ padding: '2px 6px' }}>{i + 1}</td>
                      <td style={{ padding: '2px 6px' }}>{new Date(ep.time).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit' })}</td>
                      <td style={{ padding: '2px 6px', textAlign: 'right', fontFamily: 'monospace' }}>{ftfRaw}</td>
                      <td style={{ padding: '2px 6px', textAlign: 'right', color: sessionPnl >= 0 ? '#22c55e' : '#ef4444' }}>${sessionPnl?.toFixed(2)}</td>
                      <td style={{ padding: '2px 6px', textAlign: 'right', color: ep.cumPnl >= startBalance ? '#22c55e' : '#ef4444' }}>${(ep.cumPnl - startBalance).toFixed(2)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </details>
        )}

        {!loading && fills.length > 0 && (
          <div className="day-modal-trade-list">
            {fills.map((t, i) => {
              const group = fillGroupMap.get(t.id);
              const prevGroup = i > 0 ? fillGroupMap.get(fills[i - 1].id) : null;
              const isGroupStart = group !== prevGroup;
              return (
                <React.Fragment key={t.id}>
                  {isGroupStart && i > 0 && <div className="day-modal-group-divider" />}
                  {isGroupStart && (() => {
                    const allTags = getGroupTags(group);
                    const qualityTag = allTags.find(t => /^Q:[123]$/.test(t));
                    const currentQuality = qualityTag ? parseInt(qualityTag[2]) : null;
                    const displayTags = allTags.filter(t => !/^Q:[123]$/.test(t));
                    const MGI_PRESETS = ['POC','VAH','VAL','HVN','LVN','Open Drive','Balance','Imbalance','Gap Fill','Excess','Poor High','Poor Low'];

                    const setQuality = (q) => {
                      const withoutQ = allTags.filter(t => !/^Q:[123]$/.test(t));
                      saveGroupTags(group, currentQuality === q ? withoutQ : [...withoutQ, `Q:${q}`]);
                    };

                    return (
                      <div className="group-tags-row">
                        {/* Entry quality rating */}
                        <div className="quality-rating">
                          <span className="quality-label">Setup:</span>
                          {[1,2,3].map(q => (
                            <button
                              key={q}
                              className={`quality-btn q${q}${currentQuality === q ? ' active' : ''}`}
                              onClick={() => setQuality(q)}
                              title={q === 1 ? 'A — High conviction' : q === 2 ? 'B — Decent setup' : 'C — Low conviction'}
                            >{q === 1 ? 'A' : q === 2 ? 'B' : 'C'}</button>
                          ))}
                        </div>

                        <div className="tags-divider" />

                        {/* MGI/custom tags */}
                        <div className="tags-area">
                          {displayTags.map(tag => (
                            <span key={tag} className="tag-chip">
                              {tag}
                              <button className="tag-remove" onClick={() => removeTag(group, tag)}>×</button>
                            </span>
                          ))}

                          {/* MGI preset quick-add */}
                          {activeTagGroup === group ? (
                            <>
                              <div className="mgi-presets">
                                {MGI_PRESETS.filter(p => !displayTags.includes(p)).map(p => (
                                  <button key={p} className="mgi-preset-btn"
                                    onMouseDown={e => { e.preventDefault(); addTag(group, p); }}>
                                    {p}
                                  </button>
                                ))}
                              </div>
                              <input
                                autoFocus
                                className="tag-input"
                                value={tagInputValues[group] || ''}
                                placeholder="type MGI tag + Enter..."
                                onChange={e => setTagInputValues(p => ({ ...p, [group]: e.target.value }))}
                                onKeyDown={e => {
                                  if (e.key === 'Enter' && e.target.value.trim()) {
                                    addTag(group, e.target.value.trim());
                                    setTagInputValues(p => ({ ...p, [group]: '' }));
                                  }
                                  if (e.key === 'Escape') {
                                    setTagInputValues(p => ({ ...p, [group]: '' }));
                                    setActiveTagGroup(null);
                                  }
                                }}
                                onBlur={() => {
                                  if (tagInputValues[group]?.trim()) addTag(group, tagInputValues[group].trim());
                                  setTagInputValues(p => ({ ...p, [group]: '' }));
                                  setActiveTagGroup(null);
                                }}
                              />
                              <button className="tag-add-btn" style={{ opacity: 0.5 }} onClick={() => setActiveTagGroup(null)}>done</button>
                            </>
                          ) : (
                            <button className="tag-add-btn" onClick={() => setActiveTagGroup(group)}>+ MGI tag</button>
                          )}
                        </div>
                      </div>
                    );
                  })()}
                  <div
                    ref={el => { rowRefs.current[t.id] = el; }}
                    className={`day-modal-trade-row ${(parseFloat(t.pnl) || 0) >= 0 ? 'win' : 'loss'}${highlightedGroup && group === highlightedGroup ? ' highlighted' : ''}`}
                    onClick={() => setHighlightedGroup(prev => prev === group ? null : group)}
                  >
                    {(() => {
                      const lbl = fillLabelMap.get(t.id);
                      const cls = lbl === 'Entry' ? 'entry' : lbl === 'Exit' ? 'full-exit' : lbl === 'Add' ? 'add-on' : lbl === 'Partial Exit' ? 'partial-exit' : t.direction?.toLowerCase();
                      return <span className={`direction-badge ${cls}`}>{lbl || t.direction}</span>;
                    })()}
                    <span>{t.symbol}</span>
                    <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>×{t.quantity}</span>
                    <span style={{ flex: 1 }} />
                    <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{fmtTime(t.entry_time)}</span>
                    <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{fmtElapsed(t.entry_time, t.exit_time)}</span>
                    <span className={(parseFloat(t.pnl) || 0) >= 0 ? 'pnl-positive' : 'pnl-negative'}>{(parseFloat(t.pnl) || 0) >= 0 ? '+' : ''}${formatNumber(t.pnl)}</span>
                  </div>
                </React.Fragment>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ==================== DASHBOARD VIEW ====================
function RecapDatePicker({ value, onChange, dailyPerf }) {
  const [open, setOpen] = React.useState(false);
  const [viewDate, setViewDate] = React.useState(() => {
    const d = value ? new Date(value + 'T12:00:00') : new Date();
    return { year: d.getFullYear(), month: d.getMonth() };
  });
  const ref = React.useRef(null);

  // Build a map of date → pnl from dailyPerf
  const pnlMap = React.useMemo(() => {
    const m = {};
    (dailyPerf || []).forEach(d => { if (d.log_date) m[d.log_date] = parseFloat(d.daily_pnl || d.pnl || 0); });
    return m;
  }, [dailyPerf]);

  React.useEffect(() => {
    if (!open) return;
    const close = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  React.useEffect(() => {
    if (value) {
      const d = new Date(value + 'T12:00:00');
      setViewDate({ year: d.getFullYear(), month: d.getMonth() });
    }
  }, [value]);

  const { year, month } = viewDate;
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const monthLabel = new Date(year, month, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const pad = n => String(n).padStart(2, '0');
  const today = new Date().toLocaleDateString('en-CA');

  const cells = [];
  for (let i = 0; i < firstDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(`${year}-${pad(month + 1)}-${pad(d)}`);

  const displayLabel = value
    ? new Date(value + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : 'Select date';

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <button onClick={() => setOpen(o => !o)}
        style={{ fontSize: 12, padding: '3px 10px', borderRadius: 5, border: '1px solid var(--border-color)', background: '#0d1117', color: 'var(--text-secondary)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
        {displayLabel} <span style={{ fontSize: 10 }}>▾</span>
      </button>
      {open && (
        <div style={{ position: 'absolute', top: '100%', left: 0, marginTop: 4, zIndex: 1000, background: '#0f1724', border: '1px solid var(--border-color)', borderRadius: 10, padding: 12, boxShadow: '0 8px 32px rgba(0,0,0,0.5)', minWidth: 220 }}>
          {/* Month nav */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <button onClick={() => setViewDate(v => { const d = new Date(v.year, v.month - 1); return { year: d.getFullYear(), month: d.getMonth() }; })}
              style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 14, padding: '2px 6px' }}>‹</button>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>{monthLabel}</span>
            <button onClick={() => setViewDate(v => { const d = new Date(v.year, v.month + 1); return { year: d.getFullYear(), month: d.getMonth() }; })}
              style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 14, padding: '2px 6px' }}>›</button>
          </div>
          {/* Day headers */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 2, marginBottom: 4 }}>
            {['Su','Mo','Tu','We','Th','Fr','Sa'].map(d => (
              <div key={d} style={{ textAlign: 'center', fontSize: 9, color: 'var(--text-muted)', fontWeight: 600 }}>{d}</div>
            ))}
          </div>
          {/* Day cells */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 2 }}>
            {cells.map((dateStr, i) => {
              if (!dateStr) return <div key={`e${i}`} />;
              const pnl = pnlMap[dateStr];
              const hasTrade = pnl !== undefined;
              const isSelected = dateStr === value;
              const isToday = dateStr === today;
              const bg = isSelected ? 'var(--accent-purple)'
                : hasTrade && pnl > 0 ? 'rgba(16,185,129,0.18)'
                : hasTrade && pnl < 0 ? 'rgba(239,68,68,0.18)'
                : hasTrade ? 'rgba(100,116,139,0.15)'
                : 'transparent';
              const border = isSelected ? '1px solid var(--accent-purple)'
                : isToday ? '1px solid rgba(139,92,246,0.5)'
                : hasTrade && pnl > 0 ? '1px solid rgba(16,185,129,0.3)'
                : hasTrade && pnl < 0 ? '1px solid rgba(239,68,68,0.3)'
                : '1px solid transparent';
              return (
                <div key={dateStr} onClick={() => { onChange(dateStr); setOpen(false); }}
                  title={hasTrade ? `${pnl >= 0 ? '+' : ''}$${pnl.toFixed(0)}` : ''}
                  style={{ textAlign: 'center', padding: '4px 2px', borderRadius: 4, cursor: 'pointer', fontSize: 11,
                    background: bg, border, color: isSelected ? '#fff' : hasTrade ? 'var(--text-primary)' : 'var(--text-muted)',
                    fontWeight: isSelected || hasTrade ? 600 : 400 }}>
                  {parseInt(dateStr.split('-')[2])}
                </div>
              );
            })}
          </div>
          {/* Today button */}
          <div style={{ marginTop: 8, textAlign: 'center' }}>
            <button onClick={() => { onChange(today); setViewDate({ year: new Date().getFullYear(), month: new Date().getMonth() }); setOpen(false); }}
              style={{ fontSize: 10, background: 'none', border: '1px solid var(--border-color)', borderRadius: 4, color: 'var(--text-muted)', cursor: 'pointer', padding: '2px 10px' }}>Today</button>
          </div>
        </div>
      )}
    </div>
  );
}

function DashboardView({ accounts, selectedAccounts, setSelectedAccounts, addToast, syncing, syncProgress, syncLog = [], onSyncTrades, onDismissSync }) {
  const [stats, setStats] = useState({});
  const [dailyPerf, setDailyPerf] = useState([]);
  const [setupStats, setSetupStats] = useState([]);
  const [topSymbols, setTopSymbols] = useState([]);
  const [cumulativePnl, setCumulativePnl] = useState([]);
  const [hourlyStats, setHourlyStats] = useState([]);
  const [dayOfWeekStats, setDayOfWeekStats] = useState([]);
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

  const recapObs = useMemo(() => {
    if (!recapData) return [];
    const { bars = [], levels = {}, vwap: vwapSeries = [], trades = [], vpStats } = recapData;
    if (!bars.length) return [];
    const rth = bars.filter(b => { const h = new Date(b.ts).getUTCHours(), m = new Date(b.ts).getUTCMinutes(); return (h === 9 && m >= 30) || (h > 9 && h < 16); });
    if (!rth.length) return [];
    const fmtTime = ts => { const t = new Date(ts); return `${t.getUTCHours()}:${String(t.getUTCMinutes()).padStart(2,'0')}`; };
    const obs = [];

    // Gap
    if (levels.pdClose != null) {
      const gapPts = +rth[0].open - levels.pdClose;
      const absPts = Math.abs(gapPts).toFixed(2);
      const dir = gapPts > 0.5 ? 'up' : gapPts < -0.5 ? 'down' : null;
      if (dir) {
        const filled = dir === 'up' ? rth.some(b => +b.low <= levels.pdClose) : rth.some(b => +b.high >= levels.pdClose);
        obs.push({ type: dir === 'up' ? 'green' : 'red', icon: dir === 'up' ? '↑' : '↓', text: `Gap ${dir} ${absPts} pts — ${filled ? 'filled' : 'unfilled'}` });
      } else {
        obs.push({ type: 'neutral', icon: '─', text: 'Flat open (no significant gap)' });
      }
    }

    // IB break
    if (levels.ibHigh != null && levels.ibLow != null) {
      const ibRange = (levels.ibHigh - levels.ibLow).toFixed(2);
      const postIB = rth.filter(b => { const h = new Date(b.ts).getUTCHours(), m = new Date(b.ts).getUTCMinutes(); return h > 10 || (h === 10 && m >= 30); });
      const upBreak = postIB.find(b => +b.high > levels.ibHigh + 0.25);
      const dnBreak = postIB.find(b => +b.low  < levels.ibLow  - 0.25);
      const firstBreak = (!upBreak && !dnBreak) ? null
        : (!dnBreak || (upBreak && new Date(upBreak.ts) < new Date(dnBreak.ts))) ? { dir: 'up', bar: upBreak }
        : { dir: 'down', bar: dnBreak };
      if (firstBreak) {
        const ext1Up = levels.ibHigh + (levels.ibHigh - levels.ibLow);
        const ext1Dn = levels.ibLow  - (levels.ibHigh - levels.ibLow);
        const hitExt = firstBreak.dir === 'up' ? postIB.some(b => +b.high >= ext1Up - 0.5) : postIB.some(b => +b.low <= ext1Dn + 0.5);
        obs.push({ type: firstBreak.dir === 'up' ? 'green' : 'red', icon: firstBreak.dir === 'up' ? '▲' : '▼',
          text: `IB (${ibRange} pts) — broke ${firstBreak.dir === 'up' ? 'upside' : 'downside'} at ${fmtTime(firstBreak.bar.ts)}${hitExt ? ', extended to ±1× target' : ''}` });
      } else {
        obs.push({ type: 'neutral', icon: '↔', text: `IB (${ibRange} pts) — no clean breakout (inside day)` });
      }
    }

    // VWAP position at close
    if (vwapSeries.length) {
      const lastVwap = [...vwapSeries].reverse().find(v => v.vwap != null);
      const lastBar  = rth[rth.length - 1];
      if (lastVwap && lastBar) {
        const diff = +lastBar.close - lastVwap.vwap;
        obs.push({ type: diff > 0 ? 'green' : 'red', icon: '~',
          text: `Closed ${Math.abs(diff).toFixed(2)} pts ${diff > 0 ? 'above' : 'below'} VWAP (${lastVwap.vwap?.toFixed(2)})` });
      }
    }

    // VP close position
    if (vpStats && rth.length) {
      const lastClose = +rth[rth.length - 1].close;
      const inVa = lastClose >= vpStats.val && lastClose <= vpStats.vah;
      obs.push({ type: inVa ? 'green' : 'neutral', icon: '▦',
        text: `Closed ${inVa ? 'inside' : 'outside'} Value Area (VAH ${vpStats.vah?.toFixed(2)} · POC ${vpStats.poc?.toFixed(2)} · VAL ${vpStats.val?.toFixed(2)})` });
    }

    // Trade summary
    if (trades.length) {
      const won = trades.filter(t => +t.pnl > 0).length;
      const totalPnl = trades.reduce((s, t) => s + +t.pnl, 0);
      obs.push({ type: totalPnl >= 0 ? 'green' : 'red', icon: '$',
        text: `${trades.length} trade${trades.length !== 1 ? 's' : ''} · ${won}W / ${trades.length - won}L · ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}` });
    }

    // ── Formal setups within ±20 pts ──────────────────────────────────────────
    // Tracks every distinct directional approach to each key level (not just the first).
    // Proximity scales with IB range: wider IB = wider zone needed to catch approaches.
    // Clamped between 10 and 30 pts so it stays practical.
    const ibRange = levels.ibHigh != null && levels.ibLow != null ? levels.ibHigh - levels.ibLow : 80;
    const SETUP_PROX = Math.max(10, Math.min(30, Math.round(ibRange * 0.18)));
    const openPrice = +rth[0].open;

    const SETUPS = [
      { key: 'ibHigh',    name: 'IB High',           category: 'IB' },
      { key: 'ibLow',     name: 'IB Low',            category: 'IB' },
      { key: 'ibExt1Up',  name: 'IB +1× Ext',        category: 'IB' },
      { key: 'ibExt1Dn',  name: 'IB −1× Ext',        category: 'IB' },
      { key: 'open5Mid',  name: 'OR Mid',             category: 'OR' },
      { key: 'pdVAH',     name: 'PD Value Area High', category: 'PD VA' },
      { key: 'pdVAL',     name: 'PD Value Area Low',  category: 'PD VA' },
      { key: 'pdPOC',     name: 'PD POC',             category: 'PD VA' },
      { key: 'pdVwap',    name: 'PD VWAP',            category: 'PD' },
      { key: 'pdHigh',    name: 'PD High',            category: 'PD' },
      { key: 'pdLow',     name: 'PD Low',             category: 'PD' },
      { key: 'onHigh',    name: 'Overnight High',     category: 'ON' },
      { key: 'onLow',     name: 'Overnight Low',      category: 'ON' },
      { key: 'pwHigh',    name: 'Prior Week High',    category: 'PW' },
      { key: 'pwLow',     name: 'Prior Week Low',     category: 'PW' },
      { key: 'pwVAH',     name: 'Prior Week VAH',     category: 'PW' },
      { key: 'pwVAL',     name: 'Prior Week VAL',     category: 'PW' },
    ];

    const setupHits = [];
    for (const s of SETUPS) {
      const price = levels[s.key]; if (price == null) continue;
      if (Math.abs(openPrice - price) <= SETUP_PROX) continue; // opened on this level

      let inZone = false;
      let cleared = Math.abs(openPrice - price) > SETUP_PROX;
      let lastSide = openPrice > price ? 'above' : 'below';
      let barsOutside = cleared ? 99 : 0; // bars consecutively outside the zone
      const BARS_TO_CLEAR = 3; // must be outside zone for 3 consecutive bars to count as a clean approach

      for (let i = 0; i < rth.length; i++) {
        const b = rth[i];
        const hi = +b.high, lo = +b.low;
        const barInZone = lo <= price + SETUP_PROX && hi >= price - SETUP_PROX;

        if (!barInZone) {
          if (inZone) { inZone = false; barsOutside = 0; }
          barsOutside++;
          // Track side and only mark cleared after 3 consecutive bars outside zone
          if (lo > price + SETUP_PROX) lastSide = 'above';
          else if (hi < price - SETUP_PROX) lastSide = 'below';
          if (barsOutside >= BARS_TO_CLEAR) cleared = true;
          continue;
        }

        if (inZone) continue; // already in zone, no new entry
        inZone = true;

        if (!cleared || !lastSide) continue; // no clean prior position, skip

        const fromAbove = lastSide === 'above';
        cleared = false; // needs to clear again before next approach counts

        // Outcome: scan forward until price definitively exits the zone (close clears the edge
        // by 5+ pts). No fixed time limit — could be 1 bar or 20+.
        // If price stays choppy inside the zone and never exits cleanly → skip.
        const EXIT_CONFIRM = 5; // pts beyond zone edge to confirm definitive move
        const MAX_SCAN = 30;    // give up after 30 bars (30 min) — stuck/choppy
        let outcome, outcomeType;
        let zoneExit = null;
        for (let k = i + 1; k <= i + MAX_SCAN && k < rth.length; k++) {
          const kb = rth[k];
          const cls = +kb.close;
          if (cls > price + SETUP_PROX + EXIT_CONFIRM) { zoneExit = 'up';   break; }
          if (cls < price - SETUP_PROX - EXIT_CONFIRM) { zoneExit = 'down'; break; }
        }
        if (!zoneExit) continue; // never made a definitive exit — choppy/stuck in zone

        if (fromAbove) {
          outcome = zoneExit === 'up' ? 'support held' : 'support broke';
          outcomeType = zoneExit === 'up' ? 'held' : 'broke';
        } else {
          outcome = zoneExit === 'down' ? 'resistance held' : 'resistance broke';
          outcomeType = zoneExit === 'down' ? 'held' : 'broke';
        }

        // Measure how far price moved in the favorable direction over next 45 bars
        // For held: favorable = direction price bounced away from level
        // For broke: favorable = direction price continued through level
        const MFE_SCAN = 45;
        let mfe = 0;
        const favorableDir = (fromAbove && outcomeType === 'held') || (!fromAbove && outcomeType === 'broke') ? 'up' : 'down';
        for (let k = i + 1; k < Math.min(i + MFE_SCAN + 1, rth.length); k++) {
          const cls = +rth[k].close;
          const move = favorableDir === 'up' ? cls - price : price - cls;
          if (move > mfe) mfe = move;
        }

        setupHits.push({ name: s.name, category: s.category, key: s.key, price, timeStr: fmtTime(b.ts),
          side: fromAbove ? 'support' : 'resistance', outcome, outcomeType,
          mfe: +mfe.toFixed(2), date: recapData?.date });
      }
    }

    // VWAP setups — dynamic level, recalculated each bar (skip first 5 bars to let it settle)
    if (vwapSeries.length > 5) {
      let vwapInZone = false, vwapCleared = true, vwapLastSide = null, vwapBarsOut = 99;
      for (let i = 5; i < rth.length; i++) {
        const vwap = vwapSeries[i]; if (vwap == null) continue;
        const b = rth[i], hi = +b.high, lo = +b.low;
        const barInZone = lo <= vwap + SETUP_PROX && hi >= vwap - SETUP_PROX;

        if (!barInZone) {
          if (vwapInZone) { vwapInZone = false; vwapBarsOut = 0; }
          vwapBarsOut++;
          if (lo > vwap + SETUP_PROX) vwapLastSide = 'above';
          else if (hi < vwap - SETUP_PROX) vwapLastSide = 'below';
          if (vwapBarsOut >= 3) vwapCleared = true;
          continue;
        }
        if (vwapInZone) continue;
        vwapInZone = true;
        if (!vwapCleared || !vwapLastSide) continue;
        vwapCleared = false;

        const fromAbove = vwapLastSide === 'above';
        const EXIT_CONFIRM = 5, MAX_SCAN = 30;
        let zoneExit = null;
        for (let k = i + 1; k <= i + MAX_SCAN && k < rth.length; k++) {
          const vj = vwapSeries[k] ?? vwap;
          const cls = +rth[k].close;
          if (cls > vj + SETUP_PROX + EXIT_CONFIRM) { zoneExit = 'up'; break; }
          if (cls < vj - SETUP_PROX - EXIT_CONFIRM) { zoneExit = 'down'; break; }
        }
        if (!zoneExit) continue;

        const outcomeType = (fromAbove && zoneExit === 'up') || (!fromAbove && zoneExit === 'down') ? 'held' : 'broke';
        const outcome = fromAbove
          ? (outcomeType === 'held' ? 'support held' : 'support broke')
          : (outcomeType === 'held' ? 'resistance held' : 'resistance broke');

        let mfe = 0;
        const favorableDir = (fromAbove && outcomeType === 'held') || (!fromAbove && outcomeType === 'broke') ? 'up' : 'down';
        for (let k = i + 1; k < Math.min(i + 46, rth.length); k++) {
          const cls = +rth[k].close;
          const move = favorableDir === 'up' ? cls - vwap : vwap - cls;
          if (move > mfe) mfe = move;
        }

        setupHits.push({ name: 'VWAP', category: 'VWAP', key: 'vwap', price: +vwap.toFixed(2),
          timeStr: fmtTime(b.ts), side: fromAbove ? 'support' : 'resistance',
          outcome, outcomeType, mfe: +mfe.toFixed(2), date: recapData?.date });
      }
    }

    // Sort chronologically
    setupHits.sort((a, b) => a.timeStr.localeCompare(b.timeStr));

    // Confluence detection: group setups within 15 pts of each other AND within 15 min of each other
    // A confluence = multiple levels acting as one zone — stronger signal
    const CONFLUENCE_PRICE = 15; // pts
    const CONFLUENCE_TIME  = 15; // minutes apart
    const timeToMins = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

    const confluenceGroups = [];
    const grouped = new Set();
    for (let a = 0; a < setupHits.length; a++) {
      if (grouped.has(a)) continue;
      const grp = [setupHits[a]];
      grouped.add(a);
      for (let b = a + 1; b < setupHits.length; b++) {
        if (grouped.has(b)) continue;
        const sa = setupHits[a], sb = setupHits[b];
        const priceDiff = Math.abs(sa.price - sb.price);
        const timeDiff = Math.abs(timeToMins(sa.timeStr) - timeToMins(sb.timeStr));
        if (priceDiff <= CONFLUENCE_PRICE && timeDiff <= CONFLUENCE_TIME && sa.side === sb.side) {
          grp.push(sb);
          grouped.add(b);
        }
      }
      const bestMfe = Math.max(...grp.map(s => s.mfe));
      const names = [...new Set(grp.map(s => s.name))].join(' + ');
      const key = grp[0].key; // use first for chart link
      confluenceGroups.push({
        setups: grp,
        names,
        key,
        price: grp[0].price,
        timeStr: grp[0].timeStr,
        side: grp[0].side,
        outcome: grp[0].outcome,
        outcomeType: grp[0].outcomeType,
        mfe: bestMfe,
        date: grp[0].date,
        isConfluence: grp.length > 1,
      });
    }

    // Trade of the day: confluence group with highest MFE
    const bestSetup = confluenceGroups.length > 0
      ? [...confluenceGroups].sort((a, b) => b.mfe - a.mfe)[0]
      : null;

    obs.push({ type: 'setups', setupHits, bestSetup });

    return obs;
  }, [recapData]);

  const [setupChartModal, setSetupChartModal] = useState(null); // { date, levelKey }
  const [accountDropdownOpen, setAccountDropdownOpen] = useState(false);
  const [accountsExpanded, setAccountsExpanded] = useState(false);
  const [filters, setFilters] = useState({
    dateRange: 'all', // all, today, week, month, 3months, custom
    dateFrom: '',
    dateTo: '',
  });

  useEffect(() => {
    fetchAllStats();
  }, [filters, selectedAccounts]);

  useEffect(() => {
    if (!accountDropdownOpen) return;
    const close = (e) => {
      if (!e.target.closest('.account-dropdown')) setAccountDropdownOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [accountDropdownOpen]);

  const fetchAllStats = async () => {
    try {
      // Build query params based on filters
      const params = new URLSearchParams();

      // Handle date range
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

      // Handle account filter
      if (selectedAccounts.length > 0) {
        params.append('account', selectedAccounts.join(','));
      }

      const queryString = params.toString();
      const baseQuery = queryString ? `?${queryString}` : '';

      const [overviewRes, dailyRes, setupRes, symbolsRes, cumulativeRes, hourlyRes, dayOfWeekRes, durationRes, behaviorRes, optRes, locRes] = await Promise.all([
        fetch(`${API_URL}/stats/overview${baseQuery}`),
        fetch(`${API_URL}/stats/daily${baseQuery}`),
        fetch(`${API_URL}/stats/by-setup${baseQuery}`),
        fetch(`${API_URL}/stats/top-symbols${baseQuery}`),
        fetch(`${API_URL}/stats/cumulative-pnl${baseQuery}`),
        fetch(`${API_URL}/stats/by-hour${baseQuery}`),
        fetch(`${API_URL}/stats/by-day-of-week${baseQuery}`),
        fetch(`${API_URL}/stats/by-duration${baseQuery}`),
        fetch(`${API_URL}/stats/behavior${baseQuery}`),
        fetch(`${API_URL}/stats/optimization${baseQuery}`),
        fetch(`${API_URL}/stats/trade-location${baseQuery}`),
      ]);

      setStats(await overviewRes.json());
      setDailyPerf(await dailyRes.json());
      setSetupStats(await setupRes.json());
      setTopSymbols(await symbolsRes.json());
      setCumulativePnl(await cumulativeRes.json());
      setHourlyStats(await hourlyRes.json());
      setDayOfWeekStats(await dayOfWeekRes.json());
      setDurationStats(await durationRes.json());
      setBehaviorData(await behaviorRes.json());
      setOptData(await optRes.json());
      const locJson = await locRes.json();
      setTradeLocData(locJson.error ? null : locJson);
      // Key levels has its own timeframe override; pass baseQuery for the 'all' case
      fetchKeyLevels(queryString);
    } catch (error) {
      console.error('Error fetching stats:', error);
    }
  };

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

  useEffect(() => {
    if (klTimeframe !== 'all') fetchKeyLevels();
  }, [klTimeframe, klProximity, selectedAccounts]);


  const handleDateRangeChange = (range) => {
    setFilters({ ...filters, dateRange: range });
  };

  const toggleAccount = (account) => {
    setSelectedAccounts(prev =>
      prev.includes(account) ? prev.filter(a => a !== account) : [...prev, account]
    );
  };

  const handleCustomDateChange = (field, value) => {
    setFilters({ ...filters, [field]: value });
  };

  const getDateRangeTitle = () => {
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
  };

  const SYNC_STEPS = ['Find SC', 'Open TAL', 'File > Export', 'Saving', 'Done'];
  const syncPct = syncProgress
    ? syncProgress.status === 'success' ? 100
    : syncProgress.status === 'error' ? null
    : Math.round((Math.min(syncProgress.step, 8) / 8) * 100)
    : 0;

  return (
    <div className="dashboard-view">
      <header className="page-header">
        <h1>Performance Dashboard</h1>
        <button className="btn btn-primary sync-btn" onClick={onSyncTrades} disabled={syncing}>
          {syncing ? '⏳ Syncing...' : '⬇ Sync Trades'}
        </button>
      </header>

      {(syncProgress || syncLog.length > 0) && (
        <div style={{ margin: '0 0 16px 0', background: 'var(--card-bg)', border: `1px solid ${syncProgress?.status === 'error' ? '#ef4444' : syncProgress?.status === 'success' ? '#22c55e' : '#3b82f6'}`, borderRadius: 10, padding: '14px 18px', fontFamily: 'Arial, sans-serif' }}>
          {/* Header */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 14, fontWeight: 700, color: syncProgress?.status === 'error' ? '#ef4444' : syncProgress?.status === 'success' ? '#22c55e' : '#3b82f6' }}>
                {syncProgress?.status === 'error' ? '✕ Sync Failed' : syncProgress?.status === 'success' ? '✓ Sync Complete' : '⏳ Syncing with Sierra Chart…'}
              </span>
              {syncProgress?.status === 'running' && (
                <span style={{ fontSize: 12, color: '#64748b' }}>Progress updates appear below in real time</span>
              )}
            </div>
            {syncProgress?.status !== 'running' && (
              <button onClick={onDismissSync} style={{ background: 'transparent', border: '1px solid var(--border-color)', borderRadius: 5, color: '#94a3b8', cursor: 'pointer', padding: '2px 10px', fontSize: 12 }}>Dismiss</button>
            )}
          </div>
          {/* Progress bar */}
          {syncProgress?.status === 'running' && (
            <div style={{ height: 4, background: 'rgba(59,130,246,0.15)', borderRadius: 2, marginBottom: 12, overflow: 'hidden' }}>
              <div style={{ height: '100%', background: '#3b82f6', borderRadius: 2, width: `${syncPct || 5}%`, transition: 'width 0.4s ease' }} />
            </div>
          )}
          {/* Message log */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 220, overflowY: 'auto' }}>
            {syncLog.map((entry, i) => (
              <div key={i} style={{ display: 'flex', gap: 10, fontSize: 13, lineHeight: 1.5 }}>
                <span style={{ color: '#475569', flexShrink: 0, fontFamily: 'monospace', fontSize: 11 }}>{entry.ts}</span>
                <span style={{ color: entry.status === 'error' ? '#ef4444' : entry.status === 'success' ? '#22c55e' : '#94a3b8' }}>{entry.msg}</span>
              </div>
            ))}
            {syncProgress?.status === 'running' && (
              <div style={{ fontSize: 12, color: '#475569', marginTop: 4 }}>
                {syncProgress.message}
              </div>
            )}
          </div>
          {/* Error detail */}
          {syncProgress?.status === 'error' && (
            <div style={{ marginTop: 10, padding: '10px 14px', background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 6, fontSize: 13, color: '#94a3b8', lineHeight: 1.9 }}>
              {syncLog.some(e => e.msg?.includes('Trade Activity Log is not open')) ? (<>
                <strong style={{ color: '#fbbf24', display: 'block', marginBottom: 6 }}>⚠ Trade Activity Log must be open before syncing</strong>
                1. In Sierra Chart, open the <strong style={{ color: '#e2e8f0' }}>Trade Activity Log</strong> (Trade menu → Trade Activity Log)<br/>
                2. Make sure your account is selected and data is visible<br/>
                3. Click <strong style={{ color: '#e2e8f0' }}>Sync Trades</strong> again
              </>) : (<>
                <strong style={{ color: '#ef4444' }}>Manual export: </strong>
                Sierra Chart → TAL → <strong style={{ color: '#e2e8f0' }}>File → Export</strong> → save to <code style={{ color: '#fbbf24', fontSize: 12 }}>C:\SierraChart\SavedTradeActivity\</code>
                <br/><span style={{ fontSize: 12, color: '#64748b' }}>The watcher will auto-import it when the file appears.</span>
              </>)}
            </div>
          )}
        </div>
      )}

      {/* Filters Section */}
      <div className="dashboard-filters">
        <div className="filter-group">
          <label>Date Range:</label>
          <div className="date-range-buttons">
            <button
              className={filters.dateRange === 'all' ? 'active' : ''}
              onClick={() => handleDateRangeChange('all')}
            >
              All Time
            </button>
            <button
              className={filters.dateRange === 'today' ? 'active' : ''}
              onClick={() => handleDateRangeChange('today')}
            >
              Today
            </button>
            <button
              className={filters.dateRange === 'week' ? 'active' : ''}
              onClick={() => handleDateRangeChange('week')}
            >
              Last Week
            </button>
            <button
              className={filters.dateRange === 'month' ? 'active' : ''}
              onClick={() => handleDateRangeChange('month')}
            >
              Last Month
            </button>
            <button
              className={filters.dateRange === '3months' ? 'active' : ''}
              onClick={() => handleDateRangeChange('3months')}
            >
              Last 3 Months
            </button>
            <button
              className={filters.dateRange === 'custom' ? 'active' : ''}
              onClick={() => handleDateRangeChange('custom')}
            >
              Custom Range
            </button>
          </div>

          {filters.dateRange === 'custom' && (
            <div className="custom-date-inputs">
              <div>
                <label>From:</label>
                <input
                  type="date"
                  value={filters.dateFrom}
                  onChange={(e) => handleCustomDateChange('dateFrom', e.target.value)}
                />
              </div>
              <div>
                <label>To:</label>
                <input
                  type="date"
                  value={filters.dateTo}
                  onChange={(e) => handleCustomDateChange('dateTo', e.target.value)}
                />
              </div>
            </div>
          )}
        </div>

        <div className="filter-group account-filter-group">
          <label>Account:</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <div className="account-dropdown">
              <button
                className="account-dropdown-trigger"
                onClick={() => setAccountDropdownOpen(o => !o)}
              >
                {selectedAccounts.length === 0 || selectedAccounts.length === accounts.length
                  ? 'All Accounts'
                  : selectedAccounts.length === 1
                    ? selectedAccounts[0]
                    : `${selectedAccounts.length} accounts`}
                <span style={{ marginLeft: 6 }}>▾</span>
              </button>
              {accountDropdownOpen && (
                <div className="account-dropdown-menu">
                  <label className="account-option">
                    <input
                      type="checkbox"
                      checked={selectedAccounts.length === 0 || selectedAccounts.length === accounts.length}
                      onChange={() => setSelectedAccounts(selectedAccounts.length === accounts.length ? [] : [...accounts])}
                    />
                    All Accounts
                  </label>
                  {accounts.map(account => (
                    <label key={account} className="account-option">
                      <input
                        type="checkbox"
                        checked={selectedAccounts.includes(account)}
                        onChange={() => toggleAccount(account)}
                      />
                      {account}
                    </label>
                  ))}
                </div>
              )}
            </div>
            {selectedAccounts.length > 0 && selectedAccounts.length < accounts.length && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600, flexWrap: 'wrap' }}>
                <span>{selectedAccounts[0]}</span>
                {selectedAccounts.length > 1 && (
                  <>
                    {accountsExpanded && selectedAccounts.slice(1).map(a => (
                      <React.Fragment key={a}>
                        <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>|</span>
                        <span>{a}</span>
                      </React.Fragment>
                    ))}
                    <button
                      onClick={() => setAccountsExpanded(e => !e)}
                      style={{ fontSize: 12, fontWeight: 400, color: 'var(--accent-purple)', background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px' }}
                    >
                      {accountsExpanded ? '▲ less' : `▼ +${selectedAccounts.length - 1} more`}
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Quick nav */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, margin: '12px 0 20px', borderBottom: '1px solid var(--border-color)', paddingBottom: 14 }}>
        {[
          { label: 'P&L Charts', id: 'section-pnl' },
          { label: 'By Hour', id: 'section-hour' },
          { label: 'By Day', id: 'section-dow' },
          { label: 'Symbols', id: 'section-symbols' },
          { label: 'Setups', id: 'section-setups' },
          { label: 'Optimization', id: 'section-optimization' },
          { label: 'Behavior', id: 'section-behavior' },
        ].map(({ label, id }) => (
          <button key={id} onClick={() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
            style={{ fontSize: 12, padding: '4px 12px', borderRadius: 20, cursor: 'pointer', border: '1px solid var(--border-color)',
              background: 'var(--card-bg)', color: 'var(--text-secondary)', transition: 'all 0.15s' }}
            onMouseEnter={e => { e.target.style.borderColor = 'var(--accent-purple)'; e.target.style.color = 'var(--accent-purple)'; }}
            onMouseLeave={e => { e.target.style.borderColor = 'var(--border-color)'; e.target.style.color = 'var(--text-secondary)'; }}>
            {label}
          </button>
        ))}
      </div>

      {/* Market Recap */}
      <div style={{ marginBottom: 24, padding: '14px 18px', background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderRadius: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: recapObs.length ? 12 : 0 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>Market Recap</span>
          <RecapDatePicker value={recapDate} onChange={setRecapDate} dailyPerf={dailyPerf} />
          {recapLoading && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Loading…</span>}
          {!recapLoading && !recapData && recapDate && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>No price bar data for this date</span>}
        </div>
        {recapObs.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {recapObs.map((o, i) => {
              if (o.type === 'setups') {
                const { setupHits, bestSetup } = o;
                return (
                  <div key={i} style={{ marginTop: 6, paddingTop: 10, borderTop: '1px solid var(--border-color)' }}>
                    {/* Trade of the Day */}
                    {bestSetup && (
                      <div
                        onClick={() => bestSetup.date && setSetupChartModal({ date: bestSetup.date, levelKey: bestSetup.key })}
                        style={{ marginBottom: 12, padding: '12px 16px', borderRadius: 8, background: 'rgba(139,92,246,0.08)', border: '1px solid rgba(139,92,246,0.3)', cursor: bestSetup.date ? 'pointer' : 'default', transition: 'background 0.1s' }}
                        onMouseEnter={e => { if (bestSetup.date) e.currentTarget.style.background = 'rgba(139,92,246,0.15)'; }}
                        onMouseLeave={e => { e.currentTarget.style.background = 'rgba(139,92,246,0.08)'; }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                          <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--accent-purple)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>★ Trade of the Day</span>
                          {bestSetup.isConfluence && (
                            <span style={{ fontSize: 10, padding: '1px 7px', borderRadius: 10, background: 'rgba(251,191,36,0.15)', color: '#fbbf24', border: '1px solid rgba(251,191,36,0.3)', fontWeight: 600 }}>
                              confluence
                            </span>
                          )}
                          <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text-muted)' }}>click to view chart</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>{bestSetup.names}</span>
                          <span style={{ fontSize: 12, color: 'var(--text-muted)', fontFamily: 'monospace' }}>{bestSetup.price.toFixed(2)}</span>
                          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>@ {bestSetup.timeStr}</span>
                          <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 4,
                            color: bestSetup.side === 'support' ? '#34d399' : '#f87171',
                            background: bestSetup.side === 'support' ? 'rgba(52,211,153,0.1)' : 'rgba(248,113,113,0.1)',
                            border: `1px solid ${bestSetup.side === 'support' ? 'rgba(52,211,153,0.3)' : 'rgba(248,113,113,0.3)'}` }}>
                            {bestSetup.side === 'support' ? '↓ support' : '↑ resistance'}
                          </span>
                          <span style={{ fontSize: 12, fontWeight: 700, color: bestSetup.outcomeType === 'held' ? 'var(--accent-green)' : 'var(--accent-red)' }}>
                            {bestSetup.outcomeType === 'held' ? '✓' : '✗'} {bestSetup.outcome}
                          </span>
                          <span style={{ fontSize: 13, color: '#a78bfa', fontWeight: 700 }}>→ {bestSetup.mfe}pt</span>
                        </div>
                        {bestSetup.isConfluence && (
                          <div style={{ marginTop: 5, fontSize: 11, color: 'var(--text-muted)' }}>
                            Multiple levels aligned at the same zone — {bestSetup.setups.map(s => s.name).join(', ')}
                          </div>
                        )}
                      </div>
                    )}
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 7 }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                        Formal Setups Within ±20 pts
                      </span>
                      <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>— levels price made a directional approach to; excludes levels price opened near</span>
                    </div>
                    {setupHits.length === 0 ? (
                      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>No formal setups came within range today</span>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {setupHits.map((s, j) => {
                          const held = s.outcomeType === 'held';
                          const isSupport = s.side === 'support';
                          const outcomeColor = held ? 'var(--accent-green)' : 'var(--accent-red)';
                          const sideColor = isSupport ? '#34d399' : '#f87171';
                          const isBest = bestSetup && s.name === bestSetup.name && s.timeStr === bestSetup.timeStr && s.side === bestSetup.side;
                          return (
                            <div key={j}
                              onClick={() => s.date && setSetupChartModal({ date: s.date, levelKey: s.key })}
                              style={{
                                display: 'grid',
                                gridTemplateColumns: '56px 130px 80px 62px 110px 1fr auto',
                                alignItems: 'center',
                                gap: 10,
                                padding: '7px 12px',
                                borderRadius: 7,
                                background: isBest ? 'rgba(139,92,246,0.06)' : 'rgba(255,255,255,0.03)',
                                border: isBest ? '1px solid rgba(139,92,246,0.35)' : `1px solid ${held ? 'rgba(52,211,153,0.12)' : 'rgba(248,113,113,0.12)'}`,
                                fontSize: 12,
                                cursor: s.date ? 'pointer' : 'default',
                                transition: 'background 0.1s',
                              }}
                              onMouseEnter={e => { if (s.date) e.currentTarget.style.background = 'rgba(139,92,246,0.08)'; }}
                              onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.03)'; }}>
                              <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 8, textAlign: 'center',
                                background: 'rgba(139,92,246,0.12)', color: 'var(--accent-purple)',
                                border: '1px solid rgba(139,92,246,0.25)', fontWeight: 600, whiteSpace: 'nowrap' }}>{s.category}</span>
                              <span style={{ color: 'var(--text-primary)', fontWeight: 700 }}>{s.name}</span>
                              <span style={{ color: 'var(--text-muted)', fontFamily: 'monospace', fontSize: 11 }}>{s.price.toFixed(2)}</span>
                              <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>@ {s.timeStr}</span>
                              <span style={{ color: sideColor, fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 4, textAlign: 'center',
                                background: isSupport ? 'rgba(52,211,153,0.08)' : 'rgba(248,113,113,0.08)',
                                border: `1px solid ${isSupport ? 'rgba(52,211,153,0.2)' : 'rgba(248,113,113,0.2)'}` }}>
                                {isSupport ? '↓ support' : '↑ resistance'}
                              </span>
                              <span style={{ color: outcomeColor, fontSize: 12, fontWeight: 700 }}>
                                {held ? '✓' : '✗'} {s.outcome}
                              </span>
                              <span style={{ color: '#a78bfa', fontSize: 11, textAlign: 'right', whiteSpace: 'nowrap' }}>
                                {s.mfe > 0 ? `${s.mfe}pt` : ''}
                                {isBest && <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--accent-purple)', fontWeight: 700 }}>★ best</span>}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              }
              return (
                <div key={i} style={{ display: 'flex', alignItems: 'baseline', gap: 9, fontSize: 12, lineHeight: 1.5 }}>
                  <span style={{
                    flexShrink: 0, width: 20, textAlign: 'center', fontWeight: 700, fontSize: 13,
                    color: o.type === 'green' ? 'var(--accent-green)' : o.type === 'red' ? 'var(--accent-red)' : o.type === 'info' ? 'var(--accent-purple)' : 'var(--text-muted)'
                  }}>{o.icon}</span>
                  <span style={{ color: o.type === 'neutral' ? 'var(--text-muted)' : 'var(--text-secondary)' }}>{o.text}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Setup chart modal */}
      {setupChartModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 20000, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '40px 60px' }}
          onClick={e => { if (e.target === e.currentTarget) setSetupChartModal(null); }}>
          <div style={{ background: '#0d1117', border: '1px solid var(--border-color)', borderRadius: 10, display: 'flex', flexDirection: 'column', overflow: 'hidden', width: '100%', maxWidth: 1100, maxHeight: 'calc(100vh - 80px)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderBottom: '1px solid var(--border-color)', flexShrink: 0 }}>
              <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--text-primary)' }}>
                {new Date(setupChartModal.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}
              </span>
              <button onClick={() => setSetupChartModal(null)} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 18, cursor: 'pointer', padding: '2px 6px', lineHeight: 1 }}>✕</button>
            </div>
            <div style={{ overflow: 'auto', flex: 1 }}>
              <ChartReviewSection selectedAccounts={selectedAccounts} initialDate={setupChartModal.date} initialLevelKey={setupChartModal.levelKey} />
            </div>
          </div>
        </div>
      )}

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

      {/* Duration Analysis */}
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

      <section id="section-pnl" className="chart-section">
        <h2>Cumulative P&L - {getDateRangeTitle()}</h2>
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={cumulativePnl}>
            <CartesianGrid strokeDasharray="3 3" stroke="#2d3354" />
            <XAxis
              dataKey="log_date"
              stroke="#94a3b8"
              tick={{fill: '#94a3b8', fontSize: 12}}
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
                  label={{ value: year, position: 'top', fill: '#94a3b8', fontSize: 11 }}
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
        <h2>Daily P&L - {getDateRangeTitle()}</h2>
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
        <h2>By Hour of Day - {getDateRangeTitle()}</h2>
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
        <h2>By Day of Week - {getDateRangeTitle()}</h2>
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
      </div>{/* end chart-grid-3 */}

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

      {/* ==================== OPTIMIZATION ==================== */}
      {optData && optData.summary && (() => {
        const s = optData.summary;

        // Reusable histogram component
        const Histogram = ({ data, color, title, subtitle, markerPct }) => {
          const maxPct = Math.max(...data.map(d => d.pct));
          return (
            <div style={{ background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderRadius: 8, padding: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>{title}</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12 }}>{subtitle}</div>
              {data.map((b, i) => {
                const barW = maxPct > 0 ? b.pct / maxPct * 100 : 0;
                const isMarker = markerPct && i === data.findIndex((_, idx) => {
                  const cumPct = data.slice(0, idx + 1).reduce((a, d) => a + d.pct, 0);
                  return cumPct >= markerPct;
                });
                return (
                  <div key={b.label} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, position: 'relative' }}>
                    <div style={{ width: 52, fontSize: 11, color: 'var(--text-muted)', textAlign: 'right', flexShrink: 0 }}>{b.label}</div>
                    <div style={{ flex: 1, height: 16, background: 'rgba(255,255,255,0.05)', borderRadius: 3, position: 'relative', overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${barW}%`, background: color, opacity: 0.8, borderRadius: 3, transition: 'width 0.3s' }} />
                      {isMarker && (
                        <div style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 2, background: 'rgba(255,255,255,0.7)' }} title="75th percentile (suggestion)" />
                      )}
                    </div>
                    <div style={{ width: 38, fontSize: 11, color: 'var(--text-secondary)', textAlign: 'right', flexShrink: 0 }}>{b.count > 0 ? `${b.pct}%` : ''}</div>
                  </div>
                );
              })}
            </div>
          );
        };

        return (
        <section id="section-optimization" className="behavior-section">
          <h2>Trade Optimization <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--text-muted)' }}>— per individual trade, using 1-min bars</span></h2>

          {/* Trade range visual — avg MAE | entry | actual exit | avg MFE on one axis */}
          {s.avgMfe != null && (() => {
            const mae  = Math.abs(s.avgMae);
            const mfe  = s.avgMfe;
            const act  = s.avgActualPts;
            const total = mae + mfe;
            const maePct = mae / total * 100;
            const actPct = (mae + Math.max(0, act)) / total * 100;
            const mfePct = 100;
            return (
              <div style={{ background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderRadius: 8, padding: '16px 20px', marginBottom: 24 }}>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Average Trade Range</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 16 }}>
                  Where price typically goes after your entry — red = against you, green = in your favor, white line = where you actually exited
                </div>
                <div style={{ position: 'relative', height: 32, borderRadius: 4, overflow: 'hidden', display: 'flex' }}>
                  {/* Adverse side (red, left) */}
                  <div style={{ width: `${maePct}%`, background: 'rgba(239,68,68,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, color: '#fff', fontWeight: 600 }}>
                    {mae > 0 ? `−${mae.toFixed(1)} pts` : ''}
                  </div>
                  {/* Favorable side (green, right) */}
                  <div style={{ flex: 1, background: 'rgba(16,185,129,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, color: '#fff', fontWeight: 600 }}>
                    {mfe > 0 ? `+${mfe.toFixed(1)} pts` : ''}
                  </div>
                  {/* Entry line */}
                  <div style={{ position: 'absolute', left: `${maePct}%`, top: 0, bottom: 0, width: 2, background: '#fff', zIndex: 2 }} title="Entry" />
                  {/* Actual exit line */}
                  {act > 0 && (
                    <div style={{ position: 'absolute', left: `${actPct}%`, top: 0, bottom: 0, width: 2, background: '#fbbf24', zIndex: 2 }} title={`Avg exit: +${act} pts`} />
                  )}
                </div>
                <div style={{ display: 'flex', gap: 20, marginTop: 8, fontSize: 11, color: 'var(--text-muted)' }}>
                  <span><span style={{ color: '#ef4444' }}>■</span> Max against (MAE)</span>
                  <span><span style={{ color: '#10b981' }}>■</span> Max in your favor (MFE)</span>
                  <span><span style={{ color: '#fff' }}>│</span> Entry</span>
                  {act > 0 && <span><span style={{ color: '#fbbf24' }}>│</span> Avg exit (+{act.toFixed(1)} pts = {s.avgMfeCapture}% of MFE)</span>}
                </div>
              </div>
            );
          })()}

          {/* Summary cards */}
          <div className="backtest-summary-cards" style={{ marginBottom: 24 }}>
            {[
              { label: 'Median MFE', value: s.mfe_p50 != null ? `${s.mfe_p50} pts` : '—', sub: 'Half your trades move this far in your favor', color: 'var(--accent-green)' },
              { label: 'Median MAE (winners)', value: s.winMae_p50 != null ? `${s.winMae_p50} pts` : '—', sub: 'Winners dip this far before recovering', color: 'var(--accent-red)' },
              { label: 'MFE Capture Rate', value: s.avgMfeCapture != null ? `${s.avgMfeCapture}%` : '—', sub: 'How much of the move you actually kept', color: 'var(--accent-purple)' },
              { label: 'Suggested TP / Stop', value: s.suggestedTp != null ? `${s.suggestedTp} / ${s.suggestedStop} pts` : '—', sub: '75th pct MFE / 75th pct MAE of winners', color: 'var(--text-primary)' },
            ].map(c => (
              <div key={c.label} className="backtest-summary-card">
                <div className="backtest-summary-label">{c.label}</div>
                <div className="backtest-summary-value" style={{ color: c.color, fontSize: 15 }}>{c.value}</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{c.sub}</div>
              </div>
            ))}
          </div>

          {/* Histograms + VWAP */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 20, marginBottom: 24 }}>
            <Histogram
              data={optData.mfeDist || []}
              color="#10b981"
              title="MFE Distribution"
              subtitle="How far price moved in your favor (pts)"
              markerPct={75}
            />
            <Histogram
              data={optData.winMaeDist || []}
              color="#ef4444"
              title="MAE Distribution (Winners only)"
              subtitle="How far winners dipped before recovering (pts)"
              markerPct={75}
            />

            {/* VWAP context */}
            <div style={{ background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderRadius: 8, padding: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>VWAP Context at Entry</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12 }}>RTH VWAP from 9:30 — long above / short below = with trend</div>
              {optData.byVwap && optData.byVwap.length > 0 ? optData.byVwap.map(r => (
                <div key={r.label} style={{ marginBottom: 16 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
                    <span>{r.label}</span>
                    <span style={{ color: r.avg_pnl >= 0 ? 'var(--accent-green)' : 'var(--accent-red)' }}>${r.avg_pnl} avg</span>
                  </div>
                  <div style={{ height: 20, background: 'rgba(255,255,255,0.05)', borderRadius: 3, overflow: 'hidden', position: 'relative' }}>
                    <div style={{ height: '100%', width: `${r.win_rate}%`, background: r.win_rate >= 50 ? 'rgba(16,185,129,0.7)' : 'rgba(239,68,68,0.7)', borderRadius: 3 }} />
                    <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, background: 'rgba(255,255,255,0.3)' }} />
                    <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: '#fff' }}>
                      {r.win_rate}% win rate ({r.count} trades)
                    </div>
                  </div>
                </div>
              )) : <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No VWAP data</div>}
            </div>
          </div>

          {/* Volume Profile Location Analysis */}
          {tradeLocData && tradeLocData.byLocation?.length > 0 && (() => {
            const loc = tradeLocData.byLocation;
            const qualityColor = { good: 'var(--accent-green)', poor: 'var(--accent-red)', neutral: 'var(--text-muted)' };
            const locationDesc = {
              'In LVN':       'Low volume zone — price travels fast, target next HVN',
              'At HVN':       'High volume zone — institutional level, expect stall or reversal',
              'At POC':       'Session fair value — contested, expect two-sided action',
              'At VAH':       'Value area high — resistance zone, long unfavorable',
              'At VAL':       'Value area low — support zone, short unfavorable',
              'Above VAH':    'Above accepted value — breakout or overextended',
              'Below VAL':    'Below accepted value — breakdown or undervalued',
              'In Value Area':'Between VAL and VAH — inside session fair value range',
            };
            const maxCount = Math.max(...loc.map(r => r.count));
            return (
              <>
              <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12, color: 'var(--text-secondary)' }}>
                Volume Profile Location at Entry <span style={{ fontWeight: 400, fontSize: 12 }}>(RTH profile built to entry time)</span>
              </h3>
              <div style={{ background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderRadius: 8, marginBottom: 24, overflow: 'hidden' }}>
                {loc.map((r, i) => {
                  const barW = r.count / maxCount * 100;
                  const qColor = qualityColor[r.quality] || 'var(--text-muted)';
                  return (
                    <div key={r.location} style={{ display: 'grid', gridTemplateColumns: '140px 1fr 60px 70px 90px', alignItems: 'center', gap: 12, padding: '10px 16px',
                      borderBottom: i < loc.length - 1 ? '1px solid var(--border-color)' : 'none',
                      background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)' }}>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>{r.location}</div>
                      <div style={{ position: 'relative' }}>
                        <div style={{ height: 20, background: 'rgba(255,255,255,0.05)', borderRadius: 3, overflow: 'hidden' }}>
                          <div style={{ height: '100%', width: `${barW}%`, borderRadius: 3,
                            background: r.win_rate >= 55 ? 'rgba(16,185,129,0.6)' : r.win_rate < 40 ? 'rgba(239,68,68,0.6)' : 'rgba(139,92,246,0.5)' }} />
                        </div>
                        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', paddingLeft: 8, fontSize: 11, color: '#fff', textShadow: '0 1px 2px rgba(0,0,0,0.8)', fontWeight: 500 }}>
                          {locationDesc[r.location] || ''}
                        </div>
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--text-secondary)', textAlign: 'right' }}>{r.count} trades</div>
                      <div style={{ fontSize: 13, fontWeight: 700, color: r.win_rate >= 50 ? 'var(--accent-green)' : 'var(--accent-red)', textAlign: 'right' }}>{r.win_rate}% WR</div>
                      <div style={{ fontSize: 13, fontWeight: 700, color: r.avg_pnl >= 0 ? 'var(--accent-green)' : 'var(--accent-red)', textAlign: 'right' }}>${r.avg_pnl} avg</div>
                    </div>
                  );
                })}
              </div>
              </>
            );
          })()}

          {/* Time-of-day breakdown */}
          <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12, color: 'var(--text-secondary)' }}>Performance by Time of Day <span style={{ fontWeight: 400, fontSize: 12 }}>(entry hour, EST)</span></h3>
          <div style={{ background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderRadius: 8, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-color)', background: 'rgba(255,255,255,0.03)' }}>
                  {['Hour (EST)', 'Trades', 'Win Rate', 'Avg P&L', 'Avg MFE', 'Avg MAE', 'Suggested TP / Stop', 'Verdict'].map(h => (
                    <th key={h} style={{ padding: '8px 12px', textAlign: 'left', color: 'var(--text-muted)', fontWeight: 500 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(optData.byHour || []).map(r => {
                  const good = r.win_rate >= 50 && r.avg_pnl > 0;
                  const bad  = r.win_rate < 40 && r.avg_pnl < 0;
                  return (
                    <tr key={r.hour} style={{ borderBottom: '1px solid var(--border-color)', background: good ? 'rgba(16,185,129,0.05)' : bad ? 'rgba(239,68,68,0.05)' : 'transparent' }}>
                      <td style={{ padding: '10px 12px', fontWeight: 600 }}>{r.hour}:00 – {r.hour}:59</td>
                      <td style={{ padding: '10px 12px' }}>{r.count}</td>
                      <td style={{ padding: '10px 12px', color: r.win_rate >= 50 ? 'var(--accent-green)' : 'var(--accent-red)', fontWeight: 600 }}>{r.win_rate}%</td>
                      <td style={{ padding: '10px 12px', color: r.avg_pnl >= 0 ? 'var(--accent-green)' : 'var(--accent-red)', fontWeight: 600 }}>${r.avg_pnl}</td>
                      <td style={{ padding: '10px 12px', color: 'var(--text-secondary)' }}>{r.avg_mfe != null ? `${r.avg_mfe} pts` : '—'}</td>
                      <td style={{ padding: '10px 12px', color: 'var(--text-secondary)' }}>{r.avg_mae != null ? `${Math.abs(r.avg_mae)} pts` : '—'}</td>
                      <td style={{ padding: '10px 12px' }}>
                        {r.mfe_p75 != null
                          ? <span style={{ fontSize: 12 }}>
                              <span style={{ color: 'var(--accent-green)', fontWeight: 600 }}>+{r.mfe_p75}</span>
                              <span style={{ color: 'var(--text-muted)', margin: '0 4px' }}>/</span>
                              <span style={{ color: 'var(--accent-red)', fontWeight: 600 }}>-{r.mae_p75 ?? '?'}</span>
                              <span style={{ color: 'var(--text-muted)', fontSize: 10, marginLeft: 4 }}>pts (p75 winners)</span>
                            </span>
                          : <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>—</span>}
                      </td>
                      <td style={{ padding: '10px 12px', fontSize: 11 }}>
                        {good ? <span style={{ color: 'var(--accent-green)' }}>✓ Strong window</span>
                              : bad ? <span style={{ color: 'var(--accent-red)' }}>⚠ Avoid</span>
                              : <span style={{ color: 'var(--text-muted)' }}>Neutral</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
        );
      })()}

      {/* KEY LEVEL ANALYSIS moved to Backtest → Key Level Analysis tab */}
      {false && keyLevelsData && keyLevelsData.byLevel?.length > 0 && (() => {
        const rows = keyLevelsData.byLevel;
        const LEVEL_GROUPS = [
          { label: 'Initial Balance', keys: ['ibh','ibl','ibhExt','iblExt'] },
          { label: 'Opening Reference', keys: ['open5'] },
          { label: 'Prior Day Value Area', keys: ['pdvah','pdval','pdpoc'] },
          { label: 'Prior Week Value Area', keys: ['pwvah','pwval'] },
          { label: 'RTH VWAP', keys: ['vwap'] },
        ];
        return (
          <section id="section-keylevels" style={{ marginBottom: 32 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 16 }}>
              <div>
                <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 4 }}>Key Level Analysis</h2>
                <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>
                  How often does price respect these levels, and how do your trades perform when entering near them?
                  A <b>touch</b> is each distinct entry into the ±proximity zone. <b>Respected</b> = no close broke through the zone within 15 bars <i>and</i> price bounced at least the proximity distance in the right direction. Each level is benchmarked against 20 randomly-placed levels per day — only levels that beat the random baseline with p &lt; 0.05 are statistically meaningful.
                </p>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderRadius: 8, padding: '8px 14px' }}>
                <span style={{ fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>Timeframe</span>
                <select value={klTimeframe} onChange={e => setKlTimeframe(e.target.value)}
                  style={{ fontSize: 12, padding: '3px 8px', borderRadius: 6, border: '1px solid var(--border-color)', background: 'var(--input-bg, #1e2a3a)', color: 'var(--text-primary)', cursor: 'pointer' }}>
                  <option value="all">All (global filter)</option>
                  <option value="1w">1 Week</option>
                  <option value="1m">1 Month</option>
                  <option value="3m">3 Months</option>
                  <option value="6m">6 Months</option>
                  <option value="1y">1 Year</option>
                  <option value="q1">Q1 (Jan–Mar)</option>
                  <option value="q2">Q2 (Apr–Jun)</option>
                  <option value="q3">Q3 (Jul–Sep)</option>
                  <option value="q4">Q4 (Oct–Dec)</option>
                </select>
                <span style={{ fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap', marginLeft: 6 }}>Proximity ±</span>
                <input type="range" min={0.5} max={30} step={0.5} value={klProximity}
                  onChange={e => setKlProximity(parseFloat(e.target.value))}
                  style={{ width: 100, accentColor: 'var(--accent-purple)' }} />
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--accent-purple)', minWidth: 36 }}>{klProximity} pts</span>
                <button onClick={() => klTimeframe === 'all' ? fetchAllStats() : fetchKeyLevels()} style={{ fontSize: 11, padding: '4px 10px', borderRadius: 6, cursor: 'pointer', border: '1px solid var(--accent-purple)', background: 'transparent', color: 'var(--accent-purple)' }}>Apply</button>
              </div>
            </div>

            {LEVEL_GROUPS.map(grp => {
              const grpRows = rows.filter(r => grp.keys.includes(r.key));
              if (!grpRows.length) return null;
              return (
                <div key={grp.label} style={{ marginBottom: 20 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>{grp.label}</div>
                  <div style={{ background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderRadius: 8, overflow: 'hidden' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                      <thead>
                        <tr style={{ borderBottom: '1px solid var(--border-color)', background: 'rgba(255,255,255,0.03)' }}>
                          {[
                            { label: 'Level / Role', tip: 'The price level and whether price is testing it from above (as a floor/support) or below (as a ceiling/resistance). Each level gets two rows — one per direction.' },
                            { label: 'Touches', tip: `How many distinct times price entered the ±${klProximity}pt zone around this level. Counted fresh each time price fully exits and re-enters the zone. More touches = more data, but also means the level is in an active price area.` },
                            { label: 'Respect Rate', tip: 'How often the level held after a touch: price did NOT close through it by more than the proximity distance within 15 bars, AND bounced at least the proximity distance in the right direction. This filters out "hovering" — price must actually react. 50% is the random baseline floor.' },
                            { label: 'vs. Random', tip: `Respect rate for 20 randomly-placed price levels per day using identical rules. This is your statistical control group. If a real level scores 60% but random levels average 55%, the edge is only 5 points — likely noise. A meaningful level should beat random by 8–10+ points consistently.` },
                            { label: 'Sig.', tip: 'Statistical significance vs. the random baseline (binomial z-test). ★★★ = p < 0.001 (very strong), ★★ = p < 0.01, ★ = p < 0.05, "ns" = not significant. Only trade levels rated ★ or better — anything "ns" may just be random market noise.' },
                            { label: 'Your Trades', tip: `How many of your entries fell within ±${klProximity}pts of this level while approaching it from this direction. Low counts mean the statistics are unreliable — you need at least 20–30 trades to draw conclusions.` },
                            { label: 'Win Rate', tip: 'Your win rate on trades entered near this level from this direction. Compare against your overall win rate. If your overall is 55% but this level shows 35%, you consistently lose when trading near it — that\'s actionable: avoid or flip your bias.' },
                            { label: 'Avg P&L', tip: 'Average dollar P&L for your trades near this level. A high win rate with low avg P&L means you\'re cutting winners short near these levels. A low win rate with high avg P&L means big wins offset many small losses.' },
                          ].map(({ label, tip }) => (
                            <th key={label} style={{ padding: '8px 12px', textAlign: 'left', color: 'var(--text-muted)', fontWeight: 500, whiteSpace: 'nowrap' }}>
                              {label}<InfoTooltip text={tip} />
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {grpRows.map(r => {
                          const renderSideRow = (side, sideData, isLast) => {
                            const { touches, respects, respectRate, randomRate, pValue, tradeCount, tradeWinRate, tradeAvgPnl } = sideData;
                            const edge = respectRate != null && randomRate != null ? respectRate - randomRate : null;
                            const rrColor = edge == null ? 'var(--text-muted)'
                              : edge >= 10 ? 'var(--accent-green)'
                              : edge >= 4  ? '#f59e0b'
                              : 'var(--accent-red)';
                            const wrColor = tradeWinRate == null ? 'var(--text-muted)' : tradeWinRate >= 55 ? 'var(--accent-green)' : tradeWinRate < 40 ? 'var(--accent-red)' : '#f59e0b';
                            const sig = pValue == null ? null : pValue < 0.001 ? '★★★' : pValue < 0.01 ? '★★' : pValue < 0.05 ? '★' : 'ns';
                            const sigColor = sig === '★★★' ? '#10b981' : sig === '★★' ? '#34d399' : sig === '★' ? '#f59e0b' : '#64748b';
                            const label = side === 'support'
                              ? <span style={{ color: 'var(--accent-green)', fontSize: 11 }}>↓ as Support</span>
                              : <span style={{ color: 'var(--accent-red)', fontSize: 11 }}>↑ as Resistance</span>;
                            const bg = side === 'support' ? 'rgba(16,185,129,0.04)' : 'rgba(239,68,68,0.04)';
                            return (
                              <tr key={`${r.key}-${side}`} style={{ borderBottom: isLast ? '1px solid var(--border-color)' : '1px solid rgba(255,255,255,0.04)', background: bg }}>
                                <td style={{ padding: '8px 12px 8px 20px' }}>{label}</td>
                                <td style={{ padding: '8px 12px', color: 'var(--text-secondary)', fontSize: 12 }}>
                                  {touches > 0 ? `${touches}` : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                                </td>
                                <td style={{ padding: '8px 12px' }}>
                                  {respectRate != null ? (
                                    <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                                      <span style={{ color: rrColor, fontWeight: 700, fontSize: 13 }}>{respectRate}%</span>
                                      <span style={{ display: 'inline-block', width: 48, height: 4, borderRadius: 2, background: 'var(--border-color)', flexShrink: 0 }}>
                                        <span style={{ display: 'block', width: `${Math.min(respectRate, 100)}%`, height: '100%', borderRadius: 2, background: rrColor }} />
                                      </span>
                                    </span>
                                  ) : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                                </td>
                                <td style={{ padding: '8px 12px', fontSize: 12 }}>
                                  {randomRate != null ? (
                                    <span>
                                      <span style={{ color: edge != null && edge >= 4 ? '#f59e0b' : 'var(--text-muted)', fontWeight: edge != null && edge >= 4 ? 600 : 400 }}>{randomRate}%</span>
                                      {edge != null && <span style={{ fontSize: 10, marginLeft: 4, color: edge >= 4 ? rrColor : '#64748b' }}>({edge >= 0 ? '+' : ''}{edge.toFixed(1)})</span>}
                                    </span>
                                  ) : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                                </td>
                                <td style={{ padding: '8px 12px', fontSize: 12 }}>
                                  {sig ? <span style={{ color: sigColor, fontWeight: 700, letterSpacing: sig === 'ns' ? 0 : '0.05em' }}>{sig}</span> : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                                </td>
                                <td style={{ padding: '8px 12px', color: 'var(--text-secondary)', fontSize: 12 }}>
                                  {tradeCount > 0 ? `${tradeCount}` : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                                </td>
                                <td style={{ padding: '8px 12px' }}>
                                  {tradeWinRate != null ? <span style={{ color: wrColor, fontWeight: 600 }}>{tradeWinRate}%</span> : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                                </td>
                                <td style={{ padding: '8px 12px' }}>
                                  {tradeAvgPnl != null ? <span style={{ color: tradeAvgPnl >= 0 ? 'var(--accent-green)' : 'var(--accent-red)', fontWeight: 600 }}>${tradeAvgPnl >= 0 ? '+' : ''}{tradeAvgPnl}</span> : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                                </td>
                              </tr>
                            );
                          };
                          return (
                            <React.Fragment key={r.key}>
                              <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', background: 'rgba(255,255,255,0.02)' }}>
                                <td colSpan={8} style={{ padding: '7px 12px', fontWeight: 700, fontSize: 12, color: 'var(--text-primary)', letterSpacing: '0.03em' }}>{r.label}</td>
                              </tr>
                              {renderSideRow('support', r.support, false)}
                              {renderSideRow('resistance', r.resistance, true)}
                            </React.Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })}

            {/* Legend + assumptions note */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, fontSize: 11, color: 'var(--text-muted)', marginTop: 10, alignItems: 'flex-start' }}>
              <div style={{ display: 'flex', gap: 16 }}>
                <span><span style={{ color: 'var(--accent-green)' }}>●</span> Respect ≥65% — strong level</span>
                <span><span style={{ color: '#f59e0b' }}>●</span> 50–64% — moderate</span>
                <span><span style={{ color: 'var(--accent-red)' }}>●</span> &lt;50% — often breaks through</span>
              </div>
              <div style={{ borderLeft: '1px solid var(--border-color)', paddingLeft: 16, lineHeight: 1.6, maxWidth: 560 }}>
                <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>How to read this:</span>{' '}
                <span style={{ color: 'var(--accent-green)' }}>↓ Support</span> = price tested the level from above (level as a floor).{' '}
                <span style={{ color: 'var(--accent-red)' }}>↑ Resistance</span> = price tested from below (level as a ceiling).
                Respect rate = how often the market honored the level (each distinct revisit counted separately). Win rate = your trades entered within ±{klProximity}pts on that side.
                High resistance respect + low WR = you're entering longs into a ceiling. High support respect + low WR = entering shorts into a floor.
              </div>
            </div>
          </section>
        );
      })()}

      {/* ==================== TRADING BEHAVIOR ==================== */}
      {behaviorData && (
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
          {(() => {
            const fs = behaviorData.firstSessionStats;
            return (
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
            );
          })()}

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
      )}

    </div>

  );
}

// ==================== ALL TRADES VIEW ====================
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

// ==================== ANALYSIS VIEW ====================

// ==================== SETTINGS VIEW ====================
function SettingsView() {
  return (
    <div className="settings-view">
      <header className="page-header">
        <h1>Settings</h1>
      </header>

      <div className="settings-card">
        <h2>Database Configuration</h2>
        <p>Your trading data is stored in PostgreSQL.</p>
        <p>Check your .env file to configure database connection.</p>
      </div>

      <div className="settings-card">
        <h2>Custom Fields</h2>
        <p>Custom fields feature coming soon...</p>
        <p>You'll be able to add your own trade attributes here.</p>
      </div>

      <div className="settings-card">
        <h2>Export Data</h2>
        <button className="btn btn-secondary">Export to CSV</button>
        <button className="btn btn-secondary">Backup Database</button>
      </div>
    </div>
  );
}

// ==================== KEY LEVEL BACKTEST MULTI-TIMEFRAME VIEW ====================

const KL_LEVEL_GROUPS = [
  { label: 'Initial Balance', keys: ['ibh', 'ibl', 'ibhExt', 'iblExt'] },
  { label: 'Opening Reference', keys: ['open5'] },
  { label: 'Prior Day Value Area', keys: ['pdvah', 'pdval', 'pdpoc', 'pdvwap'] },
  { label: 'Prior Week', keys: ['pwvah', 'pwval', 'pwhigh', 'pwlow'] },
  { label: 'Overnight', keys: ['onhigh', 'onlow'] },
  { label: 'RTH VWAP', keys: ['vwap'] },
];

const KL_TIMEFRAMES = [
  { id: '1w',  label: '1 Week'   },
  { id: '1m',  label: '1 Month'  },
  { id: '3m',  label: '3 Months' },
  { id: '6m',  label: '6 Months' },
  { id: '1y',  label: '1 Year'   },
];

function buildKlDateParams(tfId) {
  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];
  if (tfId === 'all') return {};
  if (tfId === '1w') {
    return { dateFrom: new Date(today - 7 * 86400000).toISOString().split('T')[0], dateTo: todayStr };
  }
  const months = { '1m': 1, '3m': 3, '6m': 6, '1y': 12 }[tfId];
  const from = new Date(today); from.setMonth(from.getMonth() - months);
  return { dateFrom: from.toISOString().split('T')[0], dateTo: todayStr };
}

function KlSigBadge({ pValue }) {
  if (pValue == null) return null;
  const sig = pValue < 0.001 ? '★★★' : pValue < 0.01 ? '★★' : pValue < 0.05 ? '★' : 'ns';
  const c = pValue < 0.001 ? '#10b981' : pValue < 0.01 ? '#34d399' : pValue < 0.05 ? '#f59e0b' : '#475569';
  return <span style={{ fontSize: 9, color: c, marginLeft: 3, letterSpacing: '0.05em' }}>{sig}</span>;
}

function KlMfeBar({ mfe, mae, tradeAvgPnl, tradeMfeAvailP50 }) {
  if (!mfe) return null;
  const max = Math.max(mfe.p90 || 0, 40);
  const pctW = v => v != null ? `${Math.min(100, (v / max) * 100).toFixed(1)}%` : '0%';
  return (
    <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--border-color)' }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 8 }}>Bounce Distribution (MFE)</div>
      {/* MFE bar */}
      <div style={{ position: 'relative', height: 20, background: 'rgba(255,255,255,0.05)', borderRadius: 4, marginBottom: 4, overflow: 'hidden' }}>
        <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: pctW(mfe.p90), background: 'rgba(99,102,241,0.15)', borderRadius: 4 }} />
        <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: pctW(mfe.p75), background: 'rgba(99,102,241,0.25)', borderRadius: 4 }} />
        <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: pctW(mfe.p50), background: 'rgba(99,102,241,0.5)', borderRadius: 4 }} />
        <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: pctW(mfe.p25), background: 'rgba(99,102,241,0.8)', borderRadius: 4 }} />
        {tradeAvgPnl != null && (
          <div style={{ position: 'absolute', top: 0, bottom: 0, width: 2, background: '#f59e0b', left: pctW(Math.max(0, tradeAvgPnl)) }} title={`Your avg exit: ${tradeAvgPnl}pt`} />
        )}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: 'var(--text-muted)', marginBottom: 8 }}>
        <span style={{ color: 'rgba(99,102,241,0.9)' }}>P25 <b style={{ color: 'var(--text-secondary)' }}>{mfe.p25}pt</b></span>
        <span>P50 <b style={{ color: '#a78bfa', fontSize: 11 }}>{mfe.p50}pt</b></span>
        <span>P75 <b style={{ color: 'var(--text-secondary)' }}>{mfe.p75}pt</b></span>
        <span>P90 <b style={{ color: 'var(--text-secondary)' }}>{mfe.p90}pt</b></span>
        {tradeAvgPnl != null && <span style={{ color: '#f59e0b' }}>Your avg <b>{tradeAvgPnl}pt</b></span>}
      </div>
      {mae && (
        <>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4, marginTop: 4 }}>Adverse Excursion (MAE — stop guidance)</div>
          <div style={{ display: 'flex', gap: 16, fontSize: 10, color: 'var(--text-muted)' }}>
            <span>P25 <b style={{ color: 'var(--accent-red)' }}>{mae.p25}pt</b></span>
            <span>P50 <b style={{ color: 'var(--accent-red)' }}>{mae.p50}pt</b></span>
            <span>P75 <b style={{ color: 'var(--accent-red)' }}>{mae.p75}pt</b></span>
            {tradeMfeAvailP50 != null && tradeAvgPnl != null && (
              <span style={{ marginLeft: 'auto', color: tradeMfeAvailP50 > tradeAvgPnl + 2 ? '#f59e0b' : 'var(--accent-green)' }}>
                Available P50 {tradeMfeAvailP50}pt vs captured {tradeAvgPnl}pt
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function KlHourBreakdown({ byHour }) {
  if (!byHour?.length) return null;
  const maxTouches = Math.max(...byHour.map(h => h.touches), 1);
  return (
    <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--border-color)' }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 8 }}>Touches by Hour</div>
      <div style={{ display: 'flex', gap: 3, alignItems: 'flex-end', height: 50 }}>
        {byHour.map(h => {
          const barH = Math.max(4, (h.touches / maxTouches) * 44);
          const rr = h.respectRate;
          const col = rr == null ? '#475569' : rr >= 65 ? 'var(--accent-green)' : rr >= 45 ? '#f59e0b' : 'var(--accent-red)';
          return (
            <div key={h.hour} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}
              title={`${h.label} — ${h.touches} touches, ${rr ?? '—'}% resp, MFE P50 ${h.mfe_p50 ?? '—'}pt`}>
              <div style={{ width: '100%', height: barH, background: col, opacity: 0.7, borderRadius: '2px 2px 0 0', minHeight: 4 }} />
              <div style={{ fontSize: 8, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{h.label.replace(':00','')}</div>
            </div>
          );
        })}
      </div>
      <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 4 }}>Bar height = touch count · color = respect rate</div>
    </div>
  );
}

function KlDetailPanel({ details, onClose, levelLabel, side, tf, onOpenChart, sideData }) {
  if (!details || !details.length) return null;
  const sorted = [...details].sort((a, b) => b.date.localeCompare(a.date));
  return (
    <div style={{ position: 'fixed', top: 0, right: 0, bottom: 0, width: 420, background: '#0f1724', borderLeft: '1px solid var(--border-color)', zIndex: 10000, display: 'flex', flexDirection: 'column', boxShadow: '-8px 0 32px rgba(0,0,0,0.6)' }}>
      <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-primary)' }}>{levelLabel}</div>
          <div style={{ fontSize: 11, color: side === 'support' ? 'var(--accent-green)' : 'var(--accent-red)', marginTop: 2 }}>
            {side === 'support' ? '↓ as Support' : '↑ as Resistance'} · {tf}
          </div>
        </div>
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 18, cursor: 'pointer', padding: '4px 8px', lineHeight: 1 }}>✕</button>
      </div>
      {/* MFE/MAE distribution */}
      <KlMfeBar
        mfe={sideData?.mfe}
        mae={sideData?.mae}
        tradeAvgPnl={sideData?.tradeAvgPnl}
        tradeMfeAvailP50={sideData?.tradeMfeAvailP50}
      />
      {/* Time of day breakdown */}
      <KlHourBreakdown byHour={sideData?.byHour} />
      <div style={{ padding: '8px 18px', borderBottom: '1px solid var(--border-color)', fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>
        {sorted.length} days · <span style={{ color: 'var(--accent-purple)' }}>click a date</span> to view chart
        {sideData?.timeToPeak?.p50 != null && (
          <span style={{ marginLeft: 12, color: 'var(--text-secondary)' }}>
            Typical peak: <b style={{ color: '#a78bfa' }}>{sideData.timeToPeak.p50} bars</b> ({sideData.timeToPeak.p25}–{sideData.timeToPeak.p75})
          </span>
        )}
      </div>
      <div style={{ overflowY: 'auto', flex: 1 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead style={{ position: 'sticky', top: 0, background: '#0f1724', zIndex: 1 }}>
            <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
              <th style={{ padding: '7px 12px', textAlign: 'left', color: 'var(--text-muted)', fontWeight: 500 }}>Date</th>
              <th style={{ padding: '7px 8px', textAlign: 'center', color: 'var(--text-muted)', fontWeight: 500 }}>Level</th>
              <th style={{ padding: '7px 8px', textAlign: 'center', color: 'var(--text-muted)', fontWeight: 500 }}>T</th>
              <th style={{ padding: '7px 8px', textAlign: 'center', color: 'var(--text-muted)', fontWeight: 500 }}>R</th>
              <th style={{ padding: '7px 8px', textAlign: 'center', color: 'var(--text-muted)', fontWeight: 500 }}>Rate</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((d, i) => {
              const rate = d.touches > 0 ? d.respects / d.touches : 0;
              const rateCol = rate >= 0.65 ? 'var(--accent-green)' : rate >= 0.45 ? '#f59e0b' : 'var(--accent-red)';
              return (
                <tr key={d.date} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)' }}>
                  <td style={{ padding: '6px 12px', fontWeight: 500 }}>
                    <span onClick={() => onOpenChart?.(d.date)}
                      style={{ color: 'var(--accent-purple)', cursor: 'pointer', textDecoration: 'underline dotted' }}>
                      {new Date(d.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })}
                    </span>
                  </td>
                  <td style={{ padding: '6px 8px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 11 }}>{d.levelPrice ?? '—'}</td>
                  <td style={{ padding: '6px 8px', textAlign: 'center', color: 'var(--text-secondary)' }}>{d.touches}</td>
                  <td style={{ padding: '6px 8px', textAlign: 'center', color: d.respects > 0 ? 'var(--accent-green)' : 'var(--accent-red)' }}>{d.respects}</td>
                  <td style={{ padding: '6px 8px', textAlign: 'center' }}>
                    <span style={{ color: rateCol, fontWeight: 700 }}>{d.touches > 0 ? Math.round(rate * 100) + '%' : '—'}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function KlRateCell({ sideData, isFocus, onClickDetail }) {
  if (!sideData || sideData.touches === 0) return (
    <td style={{ padding: '5px 8px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 11 }}>—</td>
  );
  const { respectRate, randomRate, pValue, touches, mfe } = sideData;
  const edge = respectRate != null && randomRate != null ? respectRate - randomRate : null;
  const col = edge == null ? 'var(--text-secondary)'
    : edge >= 10 ? 'var(--accent-green)'
    : edge >= 4  ? '#f59e0b'
    : 'var(--accent-red)';
  return (
    <td style={{ padding: '5px 8px', textAlign: 'center' }}>
      {respectRate != null ? (
        <span>
          <span style={{ color: col, fontWeight: 700, fontSize: 12 }}>{respectRate}%</span>
          <KlSigBadge pValue={pValue} />
          {mfe?.p50 != null && (
            <span style={{ display: 'block', fontSize: 9, color: '#a78bfa', marginTop: 1 }}>
              ↑{mfe.p50}pt med
            </span>
          )}
          <div
            onClick={onClickDetail}
            title="Click to see detail"
            style={{ fontSize: 9, color: 'var(--accent-purple)', cursor: 'pointer', textDecoration: 'underline dotted', display: 'inline-block', marginTop: 1 }}>
            {touches}t
          </div>
        </span>
      ) : <span style={{ color: 'var(--text-muted)' }}>—</span>}
    </td>
  );
}

// The 6 significant levels for the condition breakdown matrix
const KL_SIG_LEVELS = [
  { key: 'ibh',    side: 'resistance', label: 'IB High',        shortLabel: 'IB High R' },
  { key: 'pdvah',  side: 'resistance', label: 'PD VAH',         shortLabel: 'PD VAH R' },
  { key: 'iblExt', side: 'support',    label: 'IB Low −1×',     shortLabel: 'IB Low−1× S' },
  { key: 'onhigh', side: 'resistance', label: 'ON High',         shortLabel: 'ON High R' },
  { key: 'pdpoc',  side: 'support',    label: 'PD POC',          shortLabel: 'PD POC S' },
  { key: 'pdvah',  side: 'support',    label: 'PD VAH',          shortLabel: 'PD VAH S' },
];

const KL_CONDITION_DIMS = [
  { key: 'byNL30',            label: 'NL30 State',        hint: 'Rolling 30-day ACD score at session open. BULLISH >+9, RANGING −9 to +9, BEARISH <−9.' },
  { key: 'byOpeningCall',     label: 'Opening Call',      hint: 'First 15-min open type from auction_reads.' },
  { key: 'bySessionDirection',label: 'Session Direction', hint: 'Session closed up (>+20pts) / down (<−20pts) / flat vs open. Proxy for approach direction.' },
  { key: 'byTouchTime',       label: 'Time of Touch',     hint: 'Bar index within RTH session. Early = first 30 bars (9:35–10:05), Mid = bars 30–50, Late = after bar 50.' },
];

// Condition breakdown matrix: rows = condition groups, columns = 6 significant levels
function KlConditionMatrix({ byLevel }) {
  const [dim, setDim] = useState('byNL30');

  const dimConfig = KL_CONDITION_DIMS.find(d => d.key === dim);

  // Collect all condition group keys across all 6 levels for the selected dim
  const allGroups = [...new Set(
    KL_SIG_LEVELS.flatMap(lv => {
      const lvData = byLevel.find(l => l.key === lv.key);
      const cd = lvData?.[lv.side]?.conditionBreakdown?.[dim] || {};
      return Object.keys(cd);
    })
  )].sort();

  const rateColor = (rr) => rr >= 55 ? '#22c55e' : rr >= 47 ? '#f59e0b' : rr < 38 ? '#ef4444' : '#94a3b8';

  const formatLabel = (g) => g.replace(/_/g, ' ').replace(/^(\w)/, c => c.toUpperCase());

  return (
    <div style={{ marginTop: 16, background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderRadius: 10, overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Condition Breakdown — 6 Significant Levels
        </span>
        <div style={{ display: 'flex', gap: 6, marginLeft: 8 }}>
          {KL_CONDITION_DIMS.map(d => (
            <button key={d.key} onClick={() => setDim(d.key)}
              style={{ fontSize: 11, padding: '3px 10px', borderRadius: 5, cursor: 'pointer',
                border: `1px solid ${dim === d.key ? '#a78bfa' : 'var(--border-color)'}`,
                background: dim === d.key ? 'rgba(167,139,250,0.15)' : 'transparent',
                color: dim === d.key ? '#a78bfa' : 'var(--text-muted)', fontWeight: dim === d.key ? 700 : 400 }}>
              {d.label}
            </button>
          ))}
        </div>
        <span style={{ fontSize: 10, color: '#475569', marginLeft: 4 }}>{dimConfig?.hint}</span>
      </div>

      {/* Matrix table */}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ background: 'rgba(255,255,255,0.04)', borderBottom: '1px solid var(--border-color)' }}>
              <th style={{ padding: '8px 12px', textAlign: 'left', color: 'var(--text-muted)', fontWeight: 600, whiteSpace: 'nowrap', width: 160 }}>Condition</th>
              {KL_SIG_LEVELS.map(lv => {
                const lvData = byLevel.find(l => l.key === lv.key);
                const sd = lvData?.[lv.side];
                return (
                  <th key={`${lv.key}-${lv.side}`} style={{ padding: '8px 8px', textAlign: 'center', color: 'var(--text-secondary)', fontWeight: 600, whiteSpace: 'nowrap', fontSize: 11 }}>
                    <div>{lv.shortLabel}</div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 400 }}>
                      {sd?.touches ?? '—'} total · {sd?.respectRate ?? '—'}%
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {allGroups.length === 0 ? (
              <tr><td colSpan={7} style={{ padding: 16, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>No data for this dimension</td></tr>
            ) : allGroups.map((group, gi) => (
              <tr key={group} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', background: gi % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)' }}>
                <td style={{ padding: '9px 12px', color: 'var(--text-primary)', fontWeight: 600, whiteSpace: 'nowrap' }}>
                  {formatLabel(group)}
                </td>
                {KL_SIG_LEVELS.map(lv => {
                  const lvData = byLevel.find(l => l.key === lv.key);
                  const v = lvData?.[lv.side]?.conditionBreakdown?.[dim]?.[group];
                  if (!v || v.touches < 3) {
                    return <td key={`${lv.key}-${lv.side}`} style={{ padding: '9px 8px', textAlign: 'center', color: '#334155' }}>—</td>;
                  }
                  const rr = v.respectRate ?? 0;
                  const col = rateColor(rr);
                  const limited = v.touches < 20;
                  const sig = v.pValue != null && v.pValue < 0.05;
                  return (
                    <td key={`${lv.key}-${lv.side}`} style={{ padding: '9px 8px', textAlign: 'center' }}>
                      <div style={{ fontWeight: 700, color: col, fontSize: 13 }}>{rr}%</div>
                      <div style={{ fontSize: 10, color: limited ? '#fbbf24' : '#475569' }}>
                        n={v.touches}{sig ? ' ✓' : ''}{limited ? '*' : ''}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ padding: '6px 12px', fontSize: 10, color: '#334155', borderTop: '1px solid var(--border-color)' }}>
        Green ≥55% · Amber 47–55% · Red &lt;38% · ✓ p&lt;0.05 vs random baseline · * fewer than 20 touches
      </div>
    </div>
  );
}

// Expandable condition breakdown panel for a single level+side (kept for row-expand in main table)
function KlCondBreakdown({ sideData, levelLabel, side }) {
  const cd = sideData?.conditionBreakdown;
  if (!cd) return <div style={{ color: 'var(--text-muted)', fontSize: 11, padding: 8 }}>No condition data</div>;
  const baseRate = sideData.randomRate ?? 37;
  const dims = [
    { title: 'NL30 State', key: 'byNL30' }, { title: 'Opening Call', key: 'byOpeningCall' },
    { title: 'Approach Direction', key: 'bySessionDirection' }, { title: 'Time of Touch', key: 'byTouchTime' },
  ];
  const rateColor = (rr) => rr >= 55 ? '#22c55e' : rr >= 47 ? '#f59e0b' : rr < 38 ? '#ef4444' : '#94a3b8';
  return (
    <div style={{ padding: '12px 16px', background: 'rgba(10,15,30,0.9)', borderTop: '1px solid var(--border-color)' }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 10 }}>
        {levelLabel} — {side === 'support' ? 'Support' : 'Resistance'} · Condition Breakdown
        <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 8, fontWeight: 400 }}>baseline ~{baseRate}%</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        {dims.map(({ title, key }) => {
          const entries = Object.entries(cd[key] || {}).filter(([, v]) => v.touches >= 3);
          if (!entries.length) return null;
          return (
            <div key={key}>
              <div style={{ fontSize: 10, fontWeight: 700, color: '#64748b', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{title}</div>
              {entries.sort((a, b) => (b[1].respectRate ?? 0) - (a[1].respectRate ?? 0)).map(([cond, v]) => {
                const rr = v.respectRate ?? 0;
                return (
                  <div key={cond} style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0', fontSize: 11, borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                    <span style={{ color: '#94a3b8' }}>{cond.replace(/_/g, ' ').replace(/^(\w)/, c => c.toUpperCase())}</span>
                    <span>
                      <span style={{ fontWeight: 700, color: rateColor(rr), marginRight: 6 }}>{rr}%</span>
                      <span style={{ color: v.touches < 20 ? '#fbbf24' : '#475569', fontSize: 10 }}>n={v.touches}</span>
                    </span>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function KeyLevelBT({ selectedAccounts, onJumpToChart }) {
  const [prox, setProx] = useState(10);
  const [tf, setTf] = useState('1y');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [detailPanel, setDetailPanel] = useState(null);
  const [chartModal, setChartModal] = useState(null);
  const [expandedCond, setExpandedCond] = useState(null); // `${key}-${side}` for expanded condition row
  const [showCombinedConf, setShowCombinedConf] = useState(false);
  // Filter state
  const [filterNL30, setFilterNL30]       = useState('');
  const [filterOpenCall, setFilterOpenCall] = useState('');
  const [filterSessDir, setFilterSessDir]   = useState('');
  const [filterOpen, setFilterOpen]         = useState(false);

  const fetchData = useCallback(async (tfId, proxVal, overrideFilters) => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ prox: String(proxVal ?? prox) });
      if (selectedAccounts.length) qs.set('account', selectedAccounts.join(','));
      const dp = buildKlDateParams(tfId ?? tf);
      if (dp.dateFrom) qs.set('dateFrom', dp.dateFrom);
      if (dp.dateTo)   qs.set('dateTo',   dp.dateTo);
      // Apply filters
      const f = overrideFilters ?? { nl30: filterNL30, openCall: filterOpenCall, sessDir: filterSessDir };
      if (f.nl30)     qs.set('nl30State', f.nl30);
      if (f.openCall) qs.set('openingCall', f.openCall);
      if (f.sessDir)  qs.set('sessionDirection', f.sessDir);
      const r = await fetch(`${API_URL}/stats/key-levels?${qs}`);
      const j = await r.json();
      setData(j.error ? null : j);
    } catch (e) { console.error(e); }
    setLoading(false);
  }, [prox, tf, selectedAccounts, filterNL30, filterOpenCall, filterSessDir]);

  useEffect(() => { fetchData(); }, [selectedAccounts]);

  const [sortCol, setSortCol] = useState('respectRate');
  const [sortDir, setSortDir] = useState('desc');

  const tfLabel = KL_TIMEFRAMES.find(t => t.id === tf)?.label ?? tf;
  const byLevel = data?.byLevel ?? [];

  const openDetail = (levelKey, levelLabel, side, sideData) => {
    if (!sideData?.details?.length) return;
    setDetailPanel({ details: sideData.details, levelLabel, side, tf: tfLabel, key: levelKey, sideData });
  };

  // Flatten all level+side combos into rows for sorting
  const groupLabel = key => KL_LEVEL_GROUPS.find(g => g.keys.includes(key))?.label ?? '';
  const tableRows = byLevel.flatMap(row =>
    ['support', 'resistance'].map(side => {
      const sd = row[side];
      if (!sd || sd.touches === 0) return null;
      return { key: row.key, label: row.label, group: groupLabel(row.key), side, sd };
    }).filter(Boolean)
  );

  const sortVal = r => {
    if (sortCol === 'respectRate') return r.sd.respectRate ?? -1;
    if (sortCol === 'touches')     return r.sd.touches ?? 0;
    if (sortCol === 'mfe')         return r.sd.mfe?.p50 ?? -1;
    if (sortCol === 'mae')         return r.sd.mae?.p50 ?? 999;
    if (sortCol === 'tradeAvgPnl') return r.sd.tradeAvgPnl ?? -9999;
    if (sortCol === 'gap')         return (r.sd.tradeMfeAvailP50 ?? 0) - (r.sd.tradeAvgPnl ?? 0);
    return 0;
  };
  const sorted = [...tableRows].sort((a, b) => sortDir === 'desc' ? sortVal(b) - sortVal(a) : sortVal(a) - sortVal(b));

  const handleSort = col => {
    if (sortCol === col) setSortDir(d => d === 'desc' ? 'asc' : 'desc');
    else { setSortCol(col); setSortDir('desc'); }
  };
  const SortHd = ({ col, children }) => (
    <th onClick={() => handleSort(col)} style={{ padding: '8px 10px', textAlign: col === 'label' || col === 'side' ? 'left' : 'right', color: sortCol === col ? 'var(--accent-purple)' : 'var(--text-secondary)', fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap', userSelect: 'none', fontSize: 11, letterSpacing: '0.02em' }}>
      {children}{sortCol === col ? (sortDir === 'desc' ? ' ↓' : ' ↑') : ''}
    </th>
  );

  return (
    <div style={{ padding: '20px 0' }}>
      {/* Controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: 'var(--text-muted)', marginRight: 4 }}>Timeframe</span>
        {[...KL_TIMEFRAMES, { id: 'all', label: 'All Time' }].map(t => (
          <button key={t.id} onClick={() => { setTf(t.id); fetchData(t.id, prox); }}
            style={{ fontSize: 12, padding: '4px 12px', borderRadius: 6, cursor: 'pointer',
              border: `1px solid ${tf === t.id ? 'var(--accent-purple)' : 'var(--border-color)'}`,
              background: tf === t.id ? 'rgba(139,92,246,0.15)' : 'transparent',
              color: tf === t.id ? 'var(--accent-purple)' : 'var(--text-secondary)',
              fontWeight: tf === t.id ? 700 : 400 }}>
            {t.label}
          </button>
        ))}
        <span style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 12, marginRight: 4 }}>Zone ±</span>
        {[5, 10, 15, 20].map(p => (
          <button key={p} onClick={() => { setProx(p); fetchData(tf, p); }}
            style={{ fontSize: 12, padding: '4px 10px', borderRadius: 6, cursor: 'pointer',
              border: `1px solid ${prox === p ? '#6366f1' : 'var(--border-color)'}`,
              background: prox === p ? 'rgba(99,102,241,0.12)' : 'transparent',
              color: prox === p ? '#a78bfa' : 'var(--text-secondary)',
              fontWeight: prox === p ? 700 : 400 }}>
            {p}pt
          </button>
        ))}
        {loading && <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 8 }}>Loading…</span>}

        {/* Filter toggle */}
        <button onClick={() => setFilterOpen(o => !o)}
          style={{ marginLeft: 'auto', fontSize: 12, padding: '4px 12px', borderRadius: 6, cursor: 'pointer',
            border: `1px solid ${(filterNL30||filterOpenCall||filterSessDir) ? '#f97316' : 'var(--border-color)'}`,
            background: (filterNL30||filterOpenCall||filterSessDir) ? 'rgba(249,115,22,0.1)' : 'transparent',
            color: (filterNL30||filterOpenCall||filterSessDir) ? '#f97316' : 'var(--text-muted)' }}>
          {filterOpen ? '▲' : '▼'} Filter {(filterNL30||filterOpenCall||filterSessDir) ? '●' : ''}
        </button>
      </div>

      {/* Filter panel */}
      {filterOpen && (
        <div style={{ padding: '12px 16px', background: 'rgba(249,115,22,0.05)', border: '1px solid rgba(249,115,22,0.25)', borderRadius: 8, marginBottom: 12, fontFamily: 'Arial, sans-serif' }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#f97316', marginBottom: 10 }}>
            Filter touches by session conditions — find your actual edge when the setup is used correctly
          </div>
          <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div>
              <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 4 }}>NL30 at time of touch</div>
              <select value={filterNL30} onChange={e => setFilterNL30(e.target.value)}
                style={{ background: 'var(--input-bg)', border: '1px solid var(--border-color)', borderRadius: 5, color: 'var(--text-primary)', fontSize: 12, padding: '4px 8px' }}>
                <option value="">All NL30 states</option>
                <option value="BULLISH">Bullish (NL30 &gt; +9)</option>
                <option value="RANGING">Ranging (-9 to +9)</option>
                <option value="BEARISH">Bearish (NL30 &lt; -9)</option>
              </select>
            </div>
            <div>
              <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 4 }}>Opening call that session</div>
              <select value={filterOpenCall} onChange={e => setFilterOpenCall(e.target.value)}
                style={{ background: 'var(--input-bg)', border: '1px solid var(--border-color)', borderRadius: 5, color: 'var(--text-primary)', fontSize: 12, padding: '4px 8px' }}>
                <option value="">All opening calls</option>
                <option value="OPEN_DRIVE">Open Drive</option>
                <option value="OPEN_TEST_DRIVE">Open Test Drive</option>
                <option value="OPEN_REJECTION_REVERSE">ORR</option>
                <option value="OPEN_AUCTION">Open Auction</option>
              </select>
            </div>
            <div>
              <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 4 }}>Session direction</div>
              <select value={filterSessDir} onChange={e => setFilterSessDir(e.target.value)}
                style={{ background: 'var(--input-bg)', border: '1px solid var(--border-color)', borderRadius: 5, color: 'var(--text-primary)', fontSize: 12, padding: '4px 8px' }}>
                <option value="">All session directions</option>
                <option value="UP">Up day (&gt;+20pts)</option>
                <option value="DOWN">Down day (&lt;-20pts)</option>
                <option value="RANGE">Range day</option>
              </select>
            </div>
            <button onClick={() => fetchData(tf, prox, { nl30: filterNL30, openCall: filterOpenCall, sessDir: filterSessDir })}
              style={{ padding: '5px 16px', fontSize: 12, borderRadius: 5, cursor: 'pointer', border: '1px solid #f97316', background: 'rgba(249,115,22,0.15)', color: '#f97316', fontWeight: 700 }}>
              Apply filters
            </button>
            {(filterNL30||filterOpenCall||filterSessDir) && (
              <button onClick={() => { setFilterNL30(''); setFilterOpenCall(''); setFilterSessDir(''); fetchData(tf, prox, { nl30:'', openCall:'', sessDir:'' }); }}
                style={{ padding: '5px 12px', fontSize: 12, borderRadius: 5, cursor: 'pointer', border: '1px solid var(--border-color)', background: 'transparent', color: 'var(--text-muted)' }}>
                Clear
              </button>
            )}
          </div>
          <div style={{ marginTop: 8, fontSize: 11, color: '#64748b', fontStyle: 'italic' }}>
            Goal: find conditions where IB High resistance exceeds 60% (vs 44.5% unfiltered). Filtered sets will have fewer touches — flag shown when N &lt; 30.
          </div>
        </div>
      )}

      {!loading && data && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12 }}>
          {tfLabel} · ±{prox}pt zone · {sorted.length} setups · {data.tradeCount ?? 0} trades matched · click column headers to sort
          {(filterNL30||filterOpenCall||filterSessDir) && (
            <span style={{ color: '#f97316', marginLeft: 8, fontWeight: 700 }}>● filtered</span>
          )}
        </div>
      )}

      {/* Single flat sortable table */}
      {sorted.length > 0 && (
        <div style={{ background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderRadius: 10, overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ background: 'rgba(255,255,255,0.06)', borderBottom: '2px solid var(--border-color)' }}>
                  <SortHd col="label">Level</SortHd>
                  <SortHd col="side">Side</SortHd>
                  <th style={{ padding: '8px 10px', textAlign: 'left', color: 'var(--text-secondary)', fontWeight: 600, fontSize: 11 }}>Group</th>
                  <SortHd col="respectRate">Respect %</SortHd>
                  <SortHd col="touches">Touches</SortHd>
                  <SortHd col="mfe"><span title="Max Favorable Excursion — median points the move went in your favor over the next 60 bars after touching the level. Use as a guide for take profit placement.">MFE P50 ⓘ</span></SortHd>
                  <th style={{ padding: '8px 10px', textAlign: 'right', color: 'var(--text-muted)', fontWeight: 500, fontSize: 11, whiteSpace: 'nowrap' }} title="75% of touches saw at least this much favorable move — a conservative take profit target.">MFE P75 ⓘ</th>
                  <SortHd col="mae"><span title="Max Adverse Excursion — median points price moved against you within the same 60-bar window. Use as a guide for stop placement — your stop should absorb at least this much heat.">MAE P50 ⓘ</span></SortHd>
                  <th style={{ padding: '8px 10px', textAlign: 'right', color: 'var(--text-muted)', fontWeight: 500, fontSize: 11 }}>Trades</th>
                  <SortHd col="tradeAvgPnl"><span title="Your average P&L on trades entered within the proximity zone of this level.">Avg P&L ⓘ</span></SortHd>
                  <SortHd col="gap"><span title="MFE P50 minus your avg P&L — how many points were available vs what you actually captured. Positive = you're leaving money on the table.">Left on table ⓘ</span></SortHd>
                </tr>
              </thead>
              <tbody>
                {sorted.flatMap((r, i) => {
                  const sd = r.sd;
                  const condKey = `${r.key}-${r.side}`;
                  const isExpanded = expandedCond === condKey;
                  const edge = sd.respectRate != null && sd.randomRate != null ? sd.respectRate - sd.randomRate : null;
                  const edgeCol = edge == null ? 'var(--text-secondary)' : edge >= 10 ? 'var(--accent-green)' : edge >= 4 ? '#f59e0b' : 'var(--accent-red)';
                  const isSupport = r.side === 'support';
                  const captureGap = sd.tradeMfeAvailP50 != null && sd.tradeAvgPnl != null ? +(sd.tradeMfeAvailP50 - sd.tradeAvgPnl).toFixed(1) : null;
                  const clickable = sd.details?.length > 0;
                  const hasCond = !!(sd.conditionBreakdown);
                  const rows = [
                    <tr key={`${r.key}-${r.side}`}
                      style={{ borderBottom: isExpanded ? 'none' : '1px solid rgba(255,255,255,0.04)', background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)' }}>
                      <td style={{ padding: '8px 10px', fontWeight: 600, color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>
                        {hasCond && (
                          <button onClick={() => setExpandedCond(isExpanded ? null : condKey)}
                            style={{ marginRight: 6, background: 'none', border: 'none', cursor: 'pointer', color: isExpanded ? '#a78bfa' : '#475569', fontSize: 10, padding: '1px 3px', lineHeight: 1 }}
                            title="Show condition breakdown">
                            {isExpanded ? '▼' : '▶'}
                          </button>
                        )}
                        <span onClick={() => clickable && openDetail(r.key, r.label, r.side, sd)} style={{ cursor: clickable ? 'pointer' : 'default' }}>{r.label}</span>
                      </td>
                      <td style={{ padding: '8px 10px', color: isSupport ? 'var(--accent-green)' : 'var(--accent-red)', fontWeight: 600, whiteSpace: 'nowrap' }}>
                        {isSupport ? '↓ Support' : '↑ Resistance'}
                      </td>
                      <td style={{ padding: '8px 10px', color: 'var(--text-muted)', fontSize: 11 }}>{r.group}</td>
                      <td style={{ padding: '8px 10px', textAlign: 'right' }}>
                        <span style={{ color: edgeCol, fontWeight: 700 }}>{sd.respectRate}%</span>
                        <KlSigBadge pValue={sd.pValue} />
                      </td>
                      <td style={{ padding: '8px 10px', textAlign: 'right', color: sd.touches < 30 && (filterNL30||filterOpenCall||filterSessDir) ? '#fbbf24' : 'var(--text-secondary)' }}>
                        {sd.touches}{sd.touches < 30 && (filterNL30||filterOpenCall||filterSessDir) && <span style={{ fontSize: 9, color: '#fbbf24', marginLeft: 3 }}>limited</span>}
                      </td>
                      <td style={{ padding: '8px 10px', textAlign: 'right', color: '#a78bfa', fontWeight: 600 }}>{sd.mfe?.p50 ?? '—'}</td>
                      <td style={{ padding: '8px 10px', textAlign: 'right', color: 'var(--text-secondary)' }}>{sd.mfe?.p75 ?? '—'}</td>
                      <td style={{ padding: '8px 10px', textAlign: 'right', color: '#f87171' }}>{sd.mae?.p50 ?? '—'}</td>
                      <td style={{ padding: '8px 10px', textAlign: 'right', color: 'var(--text-muted)' }}>{sd.tradeCount > 0 ? sd.tradeCount : '—'}</td>
                      <td style={{ padding: '8px 10px', textAlign: 'right' }}>
                        {sd.tradeAvgPnl != null
                          ? <span style={{ color: sd.tradeAvgPnl >= 0 ? 'var(--accent-green)' : 'var(--accent-red)', fontWeight: 600 }}>{sd.tradeAvgPnl >= 0 ? '+' : ''}{sd.tradeAvgPnl}pt</span>
                          : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                      </td>
                      <td style={{ padding: '8px 10px', textAlign: 'right' }}>
                        {captureGap != null
                          ? <span style={{ color: captureGap > 5 ? '#f59e0b' : captureGap > 0 ? 'var(--text-muted)' : 'var(--accent-green)' }}>{captureGap > 0 ? `+${captureGap}pt` : 'on track'}</span>
                          : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                      </td>
                    </tr>
                  ];
                  if (isExpanded && hasCond) {
                    rows.push(
                      <tr key={`${condKey}-cond`} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                        <td colSpan={11} style={{ padding: 0 }}>
                          <KlCondBreakdown sideData={sd} levelLabel={r.label} side={r.side} />
                        </td>
                      </tr>
                    );
                  }
                  return rows;
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!loading && sorted.length === 0 && (
        <div style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 40, textAlign: 'center' }}>No data. Try a wider timeframe or check price bars are imported.</div>
      )}

      {/* Task 1: Condition breakdown matrix for 6 significant levels */}
      {!loading && data?.byLevel?.length > 0 && (
        <KlConditionMatrix byLevel={data.byLevel} />
      )}

      {/* Task 2: Confluence Score Validation */}
      {!loading && data?.combinedConfluenceBreakdown && (
        <div style={{ marginTop: 16, background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderRadius: 10, overflow: 'hidden' }}>
          <button onClick={() => setShowCombinedConf(o => !o)}
            style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', background: 'transparent', border: 'none', cursor: 'pointer', fontFamily: 'Arial, sans-serif' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: '0.05em', textTransform: 'uppercase' }}>Confluence Score Validation</span>
              <span style={{ fontSize: 10, color: '#64748b' }}>— does higher confluence predict better level respect? (6 primary levels combined)</span>
            </div>
            <span style={{ color: '#64748b', fontSize: 11 }}>{showCombinedConf ? '▲' : '▼'}</span>
          </button>
          {showCombinedConf && (
            <div style={{ padding: '0 14px 14px' }}>
              <div style={{ fontSize: 11, color: '#64748b', marginBottom: 10, lineHeight: 1.5 }}>
                Source: <code>daily_performance_log.confluence_score_pre</code> (0–3 scale) matched by session date.
                If higher scores predict stronger level respect, the framework is validated. If flat, confluence needs recalibration.
                Note: only sessions since Nov 2024 have scores — earlier touches show as no-data.
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ borderBottom: '2px solid var(--border-color)' }}>
                    <th style={{ textAlign: 'left', padding: '6px 8px', color: 'var(--text-muted)', fontWeight: 600 }}>Score</th>
                    <th style={{ textAlign: 'right', padding: '6px 8px', color: 'var(--text-muted)', fontWeight: 600 }}>Touches</th>
                    <th style={{ textAlign: 'right', padding: '6px 8px', color: 'var(--text-muted)', fontWeight: 600 }}>Respect %</th>
                    <th style={{ textAlign: 'right', padding: '6px 8px', color: 'var(--text-muted)', fontWeight: 600 }}>MFE P50</th>
                    <th style={{ textAlign: 'right', padding: '6px 8px', color: 'var(--text-muted)', fontWeight: 600 }}>p-value</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(data.combinedConfluenceBreakdown)
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([band, v]) => {
                      const rr = v.respectRate ?? 0;
                      const col = rr >= 55 ? '#22c55e' : rr >= 47 ? '#f59e0b' : rr < 38 ? '#ef4444' : '#94a3b8';
                      return (
                        <tr key={band} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                          <td style={{ padding: '8px 8px', fontWeight: 700, color: 'var(--text-primary)' }}>{band}</td>
                          <td style={{ padding: '8px 8px', textAlign: 'right', color: 'var(--text-secondary)' }}>{v.touches}</td>
                          <td style={{ padding: '8px 8px', textAlign: 'right', fontWeight: 700, color: col }}>{v.respectRate}%</td>
                          <td style={{ padding: '8px 8px', textAlign: 'right', color: '#a78bfa' }}>{v.mfe_p50 ?? '—'}</td>
                          <td style={{ padding: '8px 8px', textAlign: 'right', color: v.pValue != null && v.pValue < 0.05 ? '#22c55e' : 'var(--text-muted)', fontFamily: 'monospace' }}>
                            {v.pValue != null ? (v.pValue < 0.001 ? '<0.001' : v.pValue.toFixed(3)) : '—'}
                          </td>
                        </tr>
                      );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {detailPanel && (
        <KlDetailPanel
          details={detailPanel.details}
          levelLabel={detailPanel.levelLabel}
          side={detailPanel.side}
          tf={detailPanel.tf}
          sideData={detailPanel.sideData}
          onClose={() => setDetailPanel(null)}
          onOpenChart={(date) => {
            const dates = [...(detailPanel?.details || [])].sort((a, b) => b.date.localeCompare(a.date)).map(d => d.date);
            // Map KL level key → chart LEVEL_CONFIG key so chart auto-selects it
            const KL_TO_CHART = {
              ibh:'ibHigh', ibl:'ibLow', ibhExt:'ibExt1Up', iblExt:'ibExt1Dn',
              open5:'open5Mid', pdvah:'pdVAH', pdval:'pdVAL', pdpoc:'pdPOC',
              pdvwap:'pdVwap', pwvah:'pwVAH', pwval:'pwVAL', pwhigh:'pwHigh', pwlow:'pwLow',
              onhigh:'onHigh', onlow:'onLow', vwap:'vwap',
            };
            const levelKey = detailPanel?.key ? (KL_TO_CHART[detailPanel.key] ?? null) : null;
            setChartModal({ date, dates, levelKey });
          }}
        />
      )}
      {/* Chart modal overlay */}
      {chartModal && (() => {
        const { date, dates } = chartModal;
        const idx = dates.indexOf(date);
        const hasPrev = idx < dates.length - 1; // dates sorted newest-first, so prev = older = higher idx
        const hasNext = idx > 0;
        return (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 20000, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '40px 60px' }}
            onClick={e => { if (e.target === e.currentTarget) setChartModal(null); }}>
            <div style={{ background: '#0d1117', border: '1px solid var(--border-color)', borderRadius: 10, display: 'flex', flexDirection: 'column', overflow: 'hidden', width: '100%', maxWidth: 1100, maxHeight: 'calc(100vh - 80px)' }}>
              {/* Modal header */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', borderBottom: '1px solid var(--border-color)', flexShrink: 0 }}>
                <button onClick={() => hasPrev && setChartModal(prev => ({ ...prev, date: dates[idx + 1] }))}
                  disabled={!hasPrev}
                  style={{ padding: '2px 9px', borderRadius: 5, border: '1px solid var(--border-color)', background: 'var(--card-bg)', color: hasPrev ? 'var(--text-secondary)' : 'var(--text-muted)', cursor: hasPrev ? 'pointer' : 'default', fontSize: 14, opacity: hasPrev ? 1 : 0.35 }}>‹</button>
                <button onClick={() => hasNext && setChartModal(prev => ({ ...prev, date: dates[idx - 1] }))}
                  disabled={!hasNext}
                  style={{ padding: '2px 9px', borderRadius: 5, border: '1px solid var(--border-color)', background: 'var(--card-bg)', color: hasNext ? 'var(--text-secondary)' : 'var(--text-muted)', cursor: hasNext ? 'pointer' : 'default', fontSize: 14, opacity: hasNext ? 1 : 0.35 }}>›</button>
                <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--text-primary)' }}>
                  {new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}
                </span>
                <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 2 }}>{idx + 1} / {dates.length}</span>
                <button onClick={() => setChartModal(null)} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 18, cursor: 'pointer', padding: '2px 6px', lineHeight: 1 }}>✕</button>
              </div>
              <div style={{ overflow: 'auto', flex: 1 }}>
                <ChartReviewSection selectedAccounts={selectedAccounts} initialDate={date} initialLevelKey={chartModal.levelKey} />
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

// ==================== CHART REVIEW SECTION ====================
function ChartReviewSection({ selectedAccounts, initialDate, initialLevelKey }) {
  const [chartDate, setChartDate] = useState(initialDate || '');
  const [chartDayData, setChartDayData] = useState(null);
  const [chartLoading, setChartLoading] = useState(false);
  const [chartTimeRange, setChartTimeRange] = useState('full');
  const [chartHover, setChartHover] = useState(null);
  const [chartVisibleLevels, setChartVisibleLevels] = useState({
    ibHigh: true, ibLow: true, ibExt1Up: true, ibExt1Dn: true,
    pdVAH: true, pdVAL: true, pdPOC: false, pdVwap: false,
    pdHigh: false, pdLow: false, pdClose: false,
    open5High: false, open5Low: false, open5Mid: false,
    pwVAH: false, pwVAL: false, pwHigh: false, pwLow: false,
    onHigh: false, onLow: false,
    vwap: true,
  });
  const chartSvgRef = useRef(null);
  const [chartZoomRange, setChartZoomRange] = useState(null);
  const [chartDragState, setChartDragState] = useState(null);
  const [chartYOffset, setChartYOffset] = useState(0);
  const [hoveredTradeId, setHoveredTradeId] = useState(null);
  const _chartBarsRef = useRef([]);
  const _chartZoomRef = useRef(null);
  const [tradingDates, setTradingDates] = useState([]);

  // Sync initialDate prop -> chartDate when parent injects a jump date
  useEffect(() => {
    if (initialDate) { setChartDate(initialDate); setChartZoomRange(null); setChartYOffset(0); }
  }, [initialDate]);

  // Auto-enable the level that was selected in KL panel
  useEffect(() => {
    if (initialLevelKey) {
      setChartVisibleLevels(prev => ({ ...prev, [initialLevelKey]: true }));
    }
  }, [initialLevelKey]);

  // Fetch trading dates for prev/next nav
  useEffect(() => {
    const accts = selectedAccounts.length ? `?account=${selectedAccounts.join(',')}` : '';
    fetch(`${API_URL}/stats/daily${accts}`)
      .then(r => r.json())
      .then(j => setTradingDates((j || []).map(d => d.date || d.log_date).filter(Boolean).sort()))
      .catch(() => {});
  }, [selectedAccounts]);

  // Non-passive wheel zoom on the chart SVG
  useEffect(() => {
    const el = chartSvgRef.current;
    if (!el) return;
    const ML = 68, MR = 110, SVG_W_C = 1060;
    const IW = SVG_W_C - ML - MR;
    const handler = (e) => {
      const bars = _chartBarsRef.current;
      if (!bars.length) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const svgX = (e.clientX - rect.left) * (SVG_W_C / rect.width) - ML;
      const frac = Math.max(0, Math.min(1, svgX / IW));
      const cur = _chartZoomRef.current || { start: 0, end: bars.length };
      const len = cur.end - cur.start;
      const factor = e.deltaY < 0 ? 0.7 : 1 / 0.7;
      const newLen = Math.max(10, Math.min(bars.length, Math.round(len * factor)));
      const pivot = cur.start + frac * len;
      let ns = Math.max(0, Math.round(pivot - frac * newLen));
      let ne = Math.min(bars.length, ns + newLen);
      if (ne - ns < newLen) ns = Math.max(0, ne - newLen);
      const nr = ne - ns >= bars.length ? null : { start: ns, end: ne };
      _chartZoomRef.current = nr;
      setChartZoomRange(nr);
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, [chartDayData]);

  // End drag on mouseup anywhere
  useEffect(() => {
    const up = () => setChartDragState(null);
    document.addEventListener('mouseup', up);
    return () => document.removeEventListener('mouseup', up);
  }, []);

  const fetchChartDay = useCallback(async (date) => {
    if (!date) return;
    setChartLoading(true);
    setChartDayData(null);
    try {
      const accts = selectedAccounts.length ? `&account=${selectedAccounts.join(',')}` : '';
      const r = await fetch(`${API_URL}/chart/live-day?date=${date}${accts}`);
      const j = await r.json();
      setChartDayData(j.error ? null : j);
    } catch (_) {}
    setChartLoading(false);
  }, [selectedAccounts]);

  useEffect(() => { if (chartDate) { fetchChartDay(chartDate); setChartZoomRange(null); setChartYOffset(0); } }, [chartDate, fetchChartDay]);

  return (() => {
  const SVG_W = 1060, SVG_H = 430;
  const M = { t: 18, r: 110, b: 34, l: 68 };
  const iW = SVG_W - M.l - M.r, iH = SVG_H - M.t - M.b;

  const timeRanges = [
    { id: 'full', label: 'Full Day' },
    { id: 'ib',   label: 'IB (9:30–10:30)' },
    { id: 'am',   label: 'AM (9:30–12:00)' },
    { id: 'pm',   label: 'PM (12:00–16:00)' },
  ];

  const LEVEL_CONFIG = {
    ibHigh:   { color: '#3b82f6', dash: '',      label: 'IBH',      group: 'IB' },
    ibLow:    { color: '#3b82f6', dash: '',      label: 'IBL',      group: 'IB' },
    ibExt1Up: { color: '#60a5fa', dash: '4,2',  label: 'IB+1x',    group: 'IB' },
    ibExt1Dn: { color: '#60a5fa', dash: '4,2',  label: 'IB-1x',    group: 'IB' },
    open5High: { color: '#eab308', dash: '2,2',  label: 'OR High',  group: 'OR' },
    open5Low:  { color: '#eab308', dash: '2,2',  label: 'OR Low',   group: 'OR' },
    open5Mid:  { color: '#eab308', dash: '4,3',  label: 'OR Mid',   group: 'OR' },
    pdVAH:    { color: '#f97316', dash: '',      label: 'pdVAH',    group: 'PD VA' },
    pdVAL:    { color: '#f97316', dash: '',      label: 'pdVAL',    group: 'PD VA' },
    pdPOC:    { color: '#f97316', dash: '4,2',  label: 'pdPOC',    group: 'PD VA' },
    pdVwap:   { color: '#fbbf24', dash: '5,3',  label: 'pdVWAP',   group: 'PD VA' },
    pdHigh:   { color: '#fb923c', dash: '2,2',  label: 'PDH',      group: 'PD HL' },
    pdLow:    { color: '#fb923c', dash: '2,2',  label: 'PDL',      group: 'PD HL' },
    pdClose:  { color: '#fb923c', dash: '5,2',  label: 'PDC',      group: 'PD HL' },
    onHigh:   { color: '#a78bfa', dash: '3,2',  label: 'ONH',      group: 'ON' },
    onLow:    { color: '#a78bfa', dash: '3,2',  label: 'ONL',      group: 'ON' },
    pwVAH:    { color: '#8b5cf6', dash: '',      label: 'pwVAH',    group: 'PW VA' },
    pwVAL:    { color: '#8b5cf6', dash: '',      label: 'pwVAL',    group: 'PW VA' },
    pwHigh:   { color: '#c084fc', dash: '2,2',  label: 'PWH',      group: 'PW HL' },
    pwLow:    { color: '#c084fc', dash: '2,2',  label: 'PWL',      group: 'PW HL' },
  };
  const LEVEL_GROUPS_CHART = ['IB','OR','PD VA','PD HL','ON','PW VA','PW HL'];

  const filterBars = (bars) => {
    if (!bars?.length) return [];
    return bars.filter(b => {
      const ts = new Date(b.ts), m = ts.getUTCHours() * 60 + ts.getUTCMinutes();
      if (chartTimeRange === 'ib') return m >= 570 && m < 630;
      if (chartTimeRange === 'am') return m >= 570 && m < 720;
      if (chartTimeRange === 'pm') return m >= 720 && m < 960;
      return m >= 570 && m < 960;
    });
  };

  const bars = chartDayData ? filterBars(chartDayData.bars) : [];
  const lvl  = chartDayData?.levels ?? {};
  const vwapData = chartDayData?.vwap ?? [];
  const dayTrades = chartDayData?.trades ?? [];
  const vpHistogram = chartDayData?.vpHistogram ?? [];
  const vpStats = chartDayData?.vpStats ?? null;

  // Sync refs for non-passive wheel handler
  _chartBarsRef.current = bars;
  _chartZoomRef.current = chartZoomRange;

  // Apply zoom: slice bars to visible window
  const zr = chartZoomRange && bars.length
    ? { start: Math.max(0, chartZoomRange.start), end: Math.min(bars.length, chartZoomRange.end) }
    : null;
  const visibleBars = zr ? bars.slice(zr.start, zr.end) : bars;
  const barOffset = zr?.start ?? 0; // index offset into full bars array

  // Y scale uses only visible bar prices — levels outside range are off-screen (pan to reach them)
  let yMin = Infinity, yMax = -Infinity;
  visibleBars.forEach(b => { yMin = Math.min(yMin, +b.low); yMax = Math.max(yMax, +b.high); });
  const yPad = (yMax - yMin) * 0.04 || 5;
  yMin -= yPad; yMax += yPad;
  // Apply vertical pan (positive = shift view down to see lower prices)
  yMin += chartYOffset; yMax += chartYOffset;
  const yScale = p => iH - (p - yMin) / (yMax - yMin) * iH;
  const barSlotW = visibleBars.length ? iW / visibleBars.length : iW;
  const barBodyW = Math.max(1.5, Math.min(10, barSlotW * 0.75));
  const xScale = i => (i + 0.5) * barSlotW; // i = index into visibleBars

  // Y-axis ticks
  const yRange = yMax - yMin;
  const rawStep = yRange / 8;
  const tickSteps = [2, 5, 10, 25, 50, 100];
  const tickStep = tickSteps.find(s => s >= rawStep) || 100;
  const yTicks = [];
  for (let p = Math.ceil(yMin / tickStep) * tickStep; p <= yMax; p += tickStep) yTicks.push(p);

  // X-axis labels — auto-interval based on bar density
  const barsPerHour = 60;
  const labelIntv = visibleBars.length <= 60 ? 10 : visibleBars.length <= 150 ? 15 : 30;
  const xLabels = [];
  visibleBars.forEach((b, i) => {
    const ts = new Date(b.ts), h = ts.getUTCHours(), m = ts.getUTCMinutes();
    if (m % labelIntv === 0) xLabels.push({ x: xScale(i), label: `${h}:${String(m).padStart(2,'0')}` });
  });

  // VWAP points clipped to visible bars
  const vwapPoints = (() => {
    if (!chartVisibleLevels.vwap) return '';
    const pts = vwapData.map(v => {
      const idx = bars.findIndex(b => b.ts === v.ts);
      const visIdx = idx - barOffset;
      if (idx < 0 || visIdx < 0 || visIdx >= visibleBars.length || v.vwap == null) return null;
      return `${xScale(visIdx).toFixed(1)},${yScale(v.vwap).toFixed(1)}`;
    }).filter(Boolean);
    return pts.join(' ');
  })();

  // Trade markers — match by closest bar timestamp (robust against fractional-second diffs)
  const findClosestBar = (targetTs) => {
    if (!bars.length || !targetTs) return -1;
    const tMs = new Date(targetTs).getTime();
    let best = -1, bestDiff = 90 * 1000; // 90-second tolerance
    for (let i = 0; i < bars.length; i++) {
      const diff = Math.abs(new Date(bars[i].ts).getTime() - tMs);
      if (diff < bestDiff) { bestDiff = diff; best = i; }
    }
    return best;
  };

  const tradeMarkers = dayTrades.map(t => {
    const fullIdx = findClosestBar(t.entry_time);
    if (fullIdx < 0) return null;
    const visIdx = fullIdx - barOffset;
    const isOffLeft  = visIdx < 0;
    const isOffRight = visIdx >= visibleBars.length;
    const clampedVI  = Math.max(0, Math.min(visibleBars.length - 1, visIdx));

    const exitFullIdx = findClosestBar(t.exit_time);
    const exitVisIdx  = exitFullIdx >= 0 ? exitFullIdx - barOffset : -2;
    const exitInView  = exitVisIdx >= 0 && exitVisIdx < visibleBars.length;
    const isLong = t.direction?.toUpperCase() === 'LONG', isWin = +t.pnl > 0;
    return {
      id: t.id, isLong, isWin, isOffLeft, isOffRight,
      entryX: xScale(clampedVI), entryY: yScale(+t.entry_price),
      exitX: exitInView ? xScale(exitVisIdx) : null,
      exitY: exitInView ? yScale(+t.exit_price) : null,
      pnl: +t.pnl, entryPrice: +t.entry_price, exitPrice: +t.exit_price,
    };
  }).filter(Boolean);

  // Hover bar (index into visibleBars)
  const hoverBar = chartHover != null && visibleBars[chartHover] ? visibleBars[chartHover] : null;

  const handleSvgMove = (e) => {
    const el = chartSvgRef.current;
    if (!el || !visibleBars.length) return;
    const rect = el.getBoundingClientRect();
    const svgX = (e.clientX - rect.left) * (SVG_W / rect.width) - M.l;
    const idx = Math.floor(svgX / barSlotW);
    setChartHover(idx >= 0 && idx < visibleBars.length ? idx : null);
    // Drag-to-pan
    if (chartDragState) {
      const ds = chartDragState;
      // Vertical pan — convert pixel delta to price units
      const priceRange = ds.origYMax - ds.origYMin;
      const pxPerPrice = iH / priceRange;
      const svgY = (e.clientY - chartSvgRef.current.getBoundingClientRect().top) * (SVG_H / chartSvgRef.current.getBoundingClientRect().height) - M.t;
      const yShift = -(svgY - ds.svgY0) / pxPerPrice;
      setChartYOffset(ds.origYOffset + yShift);
      // Horizontal pan (only when zoomed)
      if (ds.rangeLen != null) {
        const bpp = ds.rangeLen / iW;
        const shift = Math.round(-(svgX - ds.svgX0) * bpp);
        const rLen = ds.rangeLen;
        const ns = Math.max(0, Math.min(bars.length - rLen, ds.origStart + shift));
        const nr = { start: ns, end: ns + rLen };
        _chartZoomRef.current = nr;
        setChartZoomRange(nr);
      }
    }
  };

  const handleSvgDown = (e) => {
    const el = chartSvgRef.current;
    const rect = el.getBoundingClientRect();
    const svgX = (e.clientX - rect.left) * (SVG_W / rect.width) - M.l;
    const svgY = (e.clientY - rect.top) * (SVG_H / rect.height) - M.t;
    setChartDragState({
      svgX0: svgX, svgY0: svgY,
      origStart: zr ? zr.start : null,
      rangeLen: zr ? zr.end - zr.start : null,
      origYOffset: chartYOffset,
      origYMin: yMin, origYMax: yMax,
    });
  };

  // Get trading dates from dailyPerf for navigation

  return (
    <section id="section-chart-bt" style={{ marginBottom: 32 }}>
      <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 12 }}>Session Chart Review</h2>

      {/* Controls row */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: 12 }}>
        {/* Date nav */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button onClick={() => {
            const i = tradingDates.indexOf(chartDate);
            if (i > 0) setChartDate(tradingDates[i - 1]);
            else if (!chartDate && tradingDates.length) setChartDate(tradingDates[tradingDates.length - 1]);
          }} style={{ padding: '4px 10px', borderRadius: 6, cursor: 'pointer', border: '1px solid var(--border-color)', background: 'var(--card-bg)', color: 'var(--text-secondary)' }}>‹</button>
          <input type="date" value={chartDate}
            onChange={e => setChartDate(e.target.value)}
            style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border-color)', background: 'var(--card-bg)', color: 'var(--text-primary)', fontSize: 13 }} />
          <button onClick={() => {
            const i = tradingDates.indexOf(chartDate);
            if (i >= 0 && i < tradingDates.length - 1) setChartDate(tradingDates[i + 1]);
          }} style={{ padding: '4px 10px', borderRadius: 6, cursor: 'pointer', border: '1px solid var(--border-color)', background: 'var(--card-bg)', color: 'var(--text-secondary)' }}>›</button>
        </div>

        {/* Time range */}
        <div style={{ display: 'flex', gap: 4 }}>
          {timeRanges.map(tr => (
            <button key={tr.id} onClick={() => { setChartTimeRange(tr.id); setChartZoomRange(null); setChartYOffset(0); }}
              style={{ fontSize: 11, padding: '4px 10px', borderRadius: 6, cursor: 'pointer',
                border: `1px solid ${chartTimeRange === tr.id ? 'var(--accent-purple)' : 'var(--border-color)'}`,
                background: chartTimeRange === tr.id ? 'rgba(139,92,246,0.15)' : 'var(--card-bg)',
                color: chartTimeRange === tr.id ? 'var(--accent-purple)' : 'var(--text-secondary)' }}>
              {tr.label}
            </button>
          ))}
        </div>

        {chartZoomRange && (
          <button onClick={() => setChartZoomRange(null)}
            style={{ fontSize: 11, padding: '4px 10px', borderRadius: 6, cursor: 'pointer',
              border: '1px solid var(--accent-purple)', background: 'rgba(139,92,246,0.15)',
              color: 'var(--accent-purple)' }}>
            Reset Zoom
          </button>
        )}

        {/* Level toggles by group */}
        {LEVEL_GROUPS_CHART.map(grp => {
          const grpKeys = Object.entries(LEVEL_CONFIG).filter(([, c]) => c.group === grp).map(([k]) => k);
          const allOn = grpKeys.every(k => chartVisibleLevels[k]);
          return (
            <label key={grp} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, cursor: 'pointer' }}>
              <input type="checkbox" checked={allOn} onChange={e => setChartVisibleLevels(prev => {
                const next = { ...prev };
                grpKeys.forEach(k => { next[k] = e.target.checked; });
                return next;
              })} style={{ accentColor: Object.values(LEVEL_CONFIG).find(c => c.group === grp)?.color }} />
              <span style={{ color: Object.values(LEVEL_CONFIG).find(c => c.group === grp)?.color }}>{grp}</span>
            </label>
          );
        })}
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, cursor: 'pointer' }}>
          <input type="checkbox" checked={chartVisibleLevels.vwap} onChange={e => setChartVisibleLevels(prev => ({ ...prev, vwap: e.target.checked }))} style={{ accentColor: '#eab308' }} />
          <span style={{ color: '#eab308' }}>VWAP</span>
        </label>
      </div>

      {/* Chart */}
      <div style={{ background: '#0d1117', borderRadius: 8, border: '1px solid var(--border-color)', overflow: 'hidden', position: 'relative' }}>
        {chartLoading && <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.5)', zIndex: 10, color: 'var(--text-muted)', fontSize: 13 }}>Loading chart…</div>}
        {!chartDate && <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 13 }}>Select a date above to view the session chart</div>}
        {chartDate && !chartLoading && !bars.length && <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 13 }}>No bar data available for {chartDate}</div>}
        {bars.length > 0 && (
          <svg ref={chartSvgRef} width="100%" viewBox={`0 0 ${SVG_W} ${SVG_H}`}
            preserveAspectRatio="xMidYMid meet"
            style={{ display: 'block', cursor: chartDragState ? 'grabbing' : 'grab', userSelect: 'none' }}
            onMouseMove={handleSvgMove}
            onMouseDown={handleSvgDown}
            onMouseLeave={() => setChartHover(null)}>
            <g transform={`translate(${M.l},${M.t})`}>

              {/* Grid + Y axis */}
              {yTicks.map(p => (
                <g key={p}>
                  <line x1={0} x2={iW} y1={yScale(p)} y2={yScale(p)} stroke="#1e2a3a" strokeWidth={1} />
                  <text x={-6} y={yScale(p) + 4} textAnchor="end" fill="#475569" fontSize={10}>{p}</text>
                </g>
              ))}

              {/* X axis labels */}
              {xLabels.map(({ x, label }, i) => (
                <text key={i} x={x} y={iH + 22} textAnchor="middle" fill="#475569" fontSize={10}>{label}</text>
              ))}

              {/* Level reference lines */}
              {Object.entries(chartVisibleLevels).filter(([k, on]) => on && k !== 'vwap' && LEVEL_CONFIG[k]).map(([k]) => {
                const price = lvl[k]; if (price == null) return null;
                const y = yScale(price); if (y < -15 || y > iH + 15) return null;
                const cfg = LEVEL_CONFIG[k];
                return (
                  <g key={k}>
                    <line x1={0} x2={iW} y1={y} y2={y} stroke={cfg.color} strokeWidth={1} strokeDasharray={cfg.dash || '0'} opacity={0.85} />
                    <text x={iW + 6} y={y - 1} fill={cfg.color} fontSize={10} fontWeight="600">{cfg.label}</text>
                    <text x={iW + 6} y={y + 10} fill={cfg.color} fontSize={9} opacity={0.7}>{price?.toFixed(2)}</text>
                  </g>
                );
              })}

              {/* VP Histogram overlay — left-anchored, semi-transparent */}
              {vpHistogram.length > 0 && (() => {
                const VP_MAX_W = iW * 0.14;
                const sorted = [...vpHistogram].sort((a, b) => a.price - b.price);
                const bucketH = sorted.length > 1 ? sorted[1].price - sorted[0].price : 0.25;
                return sorted.map((entry, i) => {
                  const y = yScale(entry.price + bucketH / 2);
                  const yBot = yScale(entry.price - bucketH / 2);
                  const bH = Math.max(1, yBot - y);
                  const barW = entry.pct * VP_MAX_W;
                  const isPoc = vpStats && Math.abs(entry.price - vpStats.poc) < bucketH / 2;
                  const isVa = vpStats && entry.price >= vpStats.val && entry.price <= vpStats.vah;
                  return (
                    <rect key={i} x={0} y={y} width={barW} height={bH}
                      fill={isPoc ? '#f59e0b' : isVa ? '#6366f1' : '#64748b'}
                      opacity={isPoc ? 0.55 : isVa ? 0.3 : 0.2} />
                  );
                });
              })()}

              {/* Candlesticks — iterate visibleBars so zoom/pan shows the correct region */}
              {visibleBars.map((b, i) => {
                const open = +b.open, close = +b.close, high = +b.high, low = +b.low;
                const isUp = close >= open, color = isUp ? '#10b981' : '#ef4444';
                const bTop = yScale(Math.max(open, close)), bBot = yScale(Math.min(open, close));
                const bH = Math.max(1, bBot - bTop), cx = xScale(i);
                return (
                  <g key={barOffset + i}>
                    <line x1={cx} x2={cx} y1={yScale(high)} y2={yScale(low)} stroke={color} strokeWidth={0.8} />
                    <rect x={cx - barBodyW/2} y={bTop} width={barBodyW} height={bH} fill={color} />
                  </g>
                );
              })}

              {/* VWAP */}
              {vwapPoints && <polyline points={vwapPoints} fill="none" stroke="#eab308" strokeWidth={1.5} opacity={0.9} />}

              {/* Entry→Exit lines (in-view trades only) */}
              {tradeMarkers.filter(t => !t.isOffLeft && !t.isOffRight && t.exitX != null).map(t => (
                <line key={`tl-${t.id}`} x1={t.entryX} y1={t.entryY} x2={t.exitX} y2={t.exitY}
                  stroke={t.isWin ? '#10b981' : '#ef4444'} strokeWidth={1} strokeDasharray="3,2" opacity={0.4} />
              ))}

              {/* Exit circles (in-view trades only) */}
              {tradeMarkers.filter(t => !t.isOffLeft && !t.isOffRight && t.exitX != null).map(t => (
                <circle key={`te-${t.id}`} cx={t.exitX} cy={t.exitY}
                  r={hoveredTradeId === t.id ? 6 : 4}
                  fill={t.isWin ? '#10b981' : '#ef4444'}
                  stroke={hoveredTradeId === t.id ? '#fff' : '#0d1117'} strokeWidth={1.5}
                  style={{ cursor: 'pointer' }}
                  onMouseEnter={() => setHoveredTradeId(t.id)}
                  onMouseLeave={() => setHoveredTradeId(null)} />
              ))}

              {/* Entry triangles */}
              {tradeMarkers.map(t => {
                const col = t.isLong ? '#10b981' : '#ef4444';
                const isHov = hoveredTradeId === t.id;
                if (t.isOffLeft || t.isOffRight) {
                  const ex = t.isOffLeft ? 6 : iW - 6;
                  const ey = Math.max(8, Math.min(iH - 8, t.entryY));
                  const pts = t.isOffLeft
                    ? `${ex+10},${ey-5} ${ex},${ey} ${ex+10},${ey+5}`
                    : `${ex-10},${ey-5} ${ex},${ey} ${ex-10},${ey+5}`;
                  return (
                    <g key={`tm-${t.id}`} opacity={isHov ? 1 : 0.65} style={{ cursor: 'pointer' }}
                      onMouseEnter={() => setHoveredTradeId(t.id)}
                      onMouseLeave={() => setHoveredTradeId(null)}>
                      <polygon points={pts} fill={col} stroke={isHov ? '#fff' : '#0d1117'} strokeWidth={isHov ? 1.5 : 1} />
                      <text x={t.isOffLeft ? ex+14 : ex-14} y={ey+4}
                        textAnchor={t.isOffLeft ? 'start' : 'end'}
                        fill={col} fontSize={8}>{t.entryPrice.toFixed(0)}</text>
                    </g>
                  );
                }
                const s = isHov ? 9 : 7, x = t.entryX, y = t.entryY;
                const pts = t.isLong
                  ? `${x},${y} ${x-s*0.8},${y+s*1.4} ${x+s*0.8},${y+s*1.4}`
                  : `${x},${y} ${x-s*0.8},${y-s*1.4} ${x+s*0.8},${y-s*1.4}`;
                return (
                  <polygon key={`tm-${t.id}`} points={pts}
                    fill={col} stroke={isHov ? '#fff' : '#0d1117'} strokeWidth={isHov ? 2 : 1.5}
                    style={{ cursor: 'pointer' }}
                    onMouseEnter={() => setHoveredTradeId(t.id)}
                    onMouseLeave={() => setHoveredTradeId(null)} />
                );
              })}

              {/* Marker hover tooltip */}
              {(() => {
                const ht = hoveredTradeId ? tradeMarkers.find(m => m.id === hoveredTradeId) : null;
                const htTrade = hoveredTradeId ? dayTrades.find(t => t.id === hoveredTradeId) : null;
                if (!ht || !htTrade) return null;
                const acctShort = htTrade.account ? htTrade.account.split('-').pop() : '—';
                const isLive = htTrade.account && !htTrade.account.includes('TEST') && !htTrade.account.includes('PRACTICE');
                const pnlStr = `${ht.pnl >= 0 ? '+' : ''}$${ht.pnl.toFixed(2)}`;
                const tx = ht.isOffLeft ? 20 : ht.isOffRight ? iW - 20 : Math.min(iW - 80, Math.max(0, ht.entryX - 40));
                const ty = Math.max(0, ht.entryY - 38);
                const ttW = 90, ttH = 28;
                return (
                  <g transform={`translate(${tx}, ${ty})`} style={{ pointerEvents: 'none' }}>
                    <rect x={0} y={0} width={ttW} height={ttH} rx={4}
                      fill="rgba(13,17,23,0.95)" stroke={isLive ? 'rgba(16,185,129,0.5)' : 'rgba(100,116,139,0.4)'} strokeWidth={1} />
                    <text x={6} y={11} fill={isLive ? '#10b981' : '#94a3b8'} fontSize={9} fontWeight="700">{acctShort}</text>
                    <text x={6} y={23} fill={ht.pnl >= 0 ? '#10b981' : '#ef4444'} fontSize={10} fontWeight="600">{pnlStr}</text>
                  </g>
                );
              })()}

              {/* Trade marker legend */}
              {tradeMarkers.length > 0 && (
                <g transform={`translate(4, ${iH - 52})`}>
                  <rect x={0} y={0} width={152} height={50} fill="rgba(13,17,23,0.82)" rx={4} stroke="#1e2a3a" strokeWidth={1} />
                  <polygon points="10,6 6,18 14,18" fill="#10b981" stroke="#0d1117" strokeWidth={1} />
                  <text x={20} y={15} fill="#94a3b8" fontSize={10}>▲ Long entry (tip = price)</text>
                  <polygon points="10,30 6,18 14,18" fill="#ef4444" stroke="#0d1117" strokeWidth={1} />
                  <text x={20} y={29} fill="#94a3b8" fontSize={10}>▽ Short entry (tip = price)</text>
                  <circle cx={10} cy={42} r={4} fill="#10b981" stroke="#0d1117" strokeWidth={1} />
                  <text x={20} y={46} fill="#94a3b8" fontSize={10}>● Win exit  ● Loss exit</text>
                  <circle cx={78} cy={42} r={4} fill="#ef4444" stroke="#0d1117" strokeWidth={1} />
                </g>
              )}

              {/* Hover crosshair */}
              {hoverBar && (
                <line x1={xScale(chartHover)} x2={xScale(chartHover)} y1={0} y2={iH}
                  stroke="#475569" strokeWidth={0.75} />
              )}

              {/* Hover OHLCV info box */}
              {hoverBar && (() => {
                const ts = new Date(hoverBar.ts);
                const timeStr = `${String(ts.getUTCHours()).padStart(2,'0')}:${String(ts.getUTCMinutes()).padStart(2,'0')}`;
                const isUp = +hoverBar.close >= +hoverBar.open;
                const col = isUp ? '#10b981' : '#ef4444';
                const bx = xScale(chartHover) > iW * 0.6 ? 4 : iW - 185;
                return (
                  <g>
                    <rect x={bx} y={4} width={182} height={58} fill="rgba(13,17,23,0.92)" rx={5} stroke="#1e2a3a" strokeWidth={1} />
                    <text x={bx+8} y={20} fill="#94a3b8" fontSize={11} fontWeight="600">{timeStr} EST</text>
                    <text x={bx+8} y={35} fill={col} fontSize={10}>O {(+hoverBar.open).toFixed(2)}  H {(+hoverBar.high).toFixed(2)}  L {(+hoverBar.low).toFixed(2)}  C {(+hoverBar.close).toFixed(2)}</text>
                    <text x={bx+8} y={50} fill="#64748b" fontSize={9}>Vol {hoverBar.volume?.toLocaleString()}</text>
                  </g>
                );
              })()}
            </g>
          </svg>
        )}
      </div>

      {/* Gap info banner */}
      {chartDayData?.levels && (() => {
        const l = chartDayData.levels;
        const ibType = l.ibRange != null ? (l.ibRange < 25 ? 'Narrow IB — likely range day' : l.ibRange > 60 ? 'Wide IB — likely trend day' : 'Normal IB') : null;
        const gapStr = l.gap != null ? (Math.abs(l.gap) < 3 ? 'Flat open' : l.gap > 0 ? `Gap Up +${l.gap} pts` : `Gap Down ${l.gap} pts`) : null;
        return (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 8 }}>
            {ibType && <span style={{ fontSize: 11, padding: '3px 10px', borderRadius: 20, background: 'var(--card-bg)', border: '1px solid var(--border-color)', color: 'var(--text-secondary)' }}>IB Range: {l.ibRange?.toFixed(0)} pts — {ibType}</span>}
            {gapStr && <span style={{ fontSize: 11, padding: '3px 10px', borderRadius: 20, background: 'var(--card-bg)', border: '1px solid var(--border-color)', color: l.gap > 3 ? 'var(--accent-green)' : l.gap < -3 ? 'var(--accent-red)' : 'var(--text-secondary)' }}>{gapStr} from prior close</span>}
            {l.pdClose != null && <span style={{ fontSize: 11, padding: '3px 10px', borderRadius: 20, background: 'var(--card-bg)', border: '1px solid var(--border-color)', color: 'var(--text-muted)' }}>Prior Close: {l.pdClose?.toFixed(2)}</span>}
          </div>
        );
      })()}

      {/* Trade list for day */}
      {dayTrades.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 600, marginBottom: 6 }}>{dayTrades.length} TRADES — {chartDate}</div>
          <div style={{ background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderRadius: 8, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-color)', background: 'rgba(255,255,255,0.03)' }}>
                  {['Dir','Account','Entry','Exit','P&L','Near Levels'].map(h => (
                    <th key={h} style={{ padding: '6px 10px', textAlign: 'left', color: 'var(--text-muted)', fontWeight: 500 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {dayTrades.map(t => {
                  const isLong = t.direction?.toUpperCase() === 'LONG', pnl = +t.pnl, ep = +t.entry_price, xp = +t.exit_price;
                  const PROX_CHART = 2.5;
                  const nearLvls = Object.entries(LEVEL_CONFIG).filter(([k]) => lvl[k] != null && Math.abs(ep - lvl[k]) <= PROX_CHART).map(([k]) => LEVEL_CONFIG[k].label);
                  const entryTs = new Date(t.entry_time);
                  const timeStr = `${String(entryTs.getUTCHours()).padStart(2,'0')}:${String(entryTs.getUTCMinutes()).padStart(2,'0')}`;
                  const rowHov = hoveredTradeId === t.id;
                  const acctShort = t.account ? t.account.split('-').pop() : '—';
                  const isLive = t.account && !t.account.includes('TEST') && !t.account.includes('PRACTICE');
                  return (
                    <tr key={t.id}
                      style={{ borderBottom: '1px solid var(--border-color)', background: rowHov ? 'rgba(139,92,246,0.12)' : 'transparent', cursor: 'default', transition: 'background 0.1s' }}
                      onMouseEnter={() => setHoveredTradeId(t.id)}
                      onMouseLeave={() => setHoveredTradeId(null)}>
                      <td style={{ padding: '6px 10px', color: isLong ? 'var(--accent-green)' : 'var(--accent-red)', fontWeight: 600 }}>{isLong ? '▲ L' : '▼ S'}</td>
                      <td style={{ padding: '6px 10px' }}>
                        <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 10, fontWeight: 600, letterSpacing: '0.02em',
                          background: isLive ? 'rgba(16,185,129,0.12)' : 'rgba(100,116,139,0.15)',
                          color: isLive ? 'var(--accent-green)' : 'var(--text-muted)',
                          border: `1px solid ${isLive ? 'rgba(16,185,129,0.3)' : 'rgba(100,116,139,0.3)'}` }}>
                          {acctShort}
                        </span>
                      </td>
                      <td style={{ padding: '6px 10px' }}>{timeStr} @ {ep?.toFixed(2)}</td>
                      <td style={{ padding: '6px 10px', color: 'var(--text-muted)' }}>{xp?.toFixed(2)}</td>
                      <td style={{ padding: '6px 10px', color: pnl >= 0 ? 'var(--accent-green)' : 'var(--accent-red)', fontWeight: 600 }}>${pnl >= 0 ? '+' : ''}{pnl?.toFixed(2)}</td>
                      <td style={{ padding: '6px 10px' }}>
                        {nearLvls.length ? nearLvls.map(l => (
                          <span key={l} style={{ fontSize: 10, padding: '1px 6px', borderRadius: 10, marginRight: 4, background: 'rgba(139,92,246,0.15)', color: 'var(--accent-purple)', border: '1px solid rgba(139,92,246,0.3)' }}>{l}</span>
                        )) : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
  })();
}

// ==================== BACKTEST VIEW ====================
function EdgePatternTable({ patterns }) {
  const [sortCol, setSortCol] = useState('edge_abs');
  const [sigOnly, setSigOnly] = useState(false);

  const rows = (sigOnly ? patterns.filter(p => p.sig) : patterns)
    .sort((a, b) => {
      if (sortCol === 'edge_abs') return Math.abs(b.edge) - Math.abs(a.edge);
      if (sortCol === 'rate') return b.rate - a.rate;
      if (sortCol === 'n') return b.n - a.n;
      if (sortCol === 'pval') return (a.pValue ?? 1) - (b.pValue ?? 1);
      return 0;
    });

  const SH = ({ col, children }) => (
    <th onClick={() => setSortCol(col)} style={{ padding: '7px 10px', textAlign: col === 'label' ? 'left' : 'right', color: sortCol === col ? 'var(--accent-purple)' : 'var(--text-secondary)', fontWeight: 600, cursor: 'pointer', fontSize: 11, whiteSpace: 'nowrap', userSelect: 'none' }}>
      {children}{sortCol === col ? ' ↓' : ''}
    </th>
  );

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--text-muted)', cursor: 'pointer' }}>
          <input type="checkbox" checked={sigOnly} onChange={e => setSigOnly(e.target.checked)} />
          Significant only (p&lt;0.05)
        </label>
        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{rows.length} patterns</span>
      </div>
      <div style={{ background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderRadius: 8, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: 'rgba(255,255,255,0.04)', borderBottom: '2px solid var(--border-color)' }}>
                <SH col="label">Pattern</SH>
                <SH col="n">n</SH>
                <SH col="rate">Rate</SH>
                <th style={{ padding: '7px 8px', textAlign: 'right', color: 'var(--text-secondary)', fontWeight: 600, fontSize: 11 }}>Base</th>
                <SH col="edge_abs">Edge</SH>
                <SH col="pval">Sig</SH>
                <th style={{ padding: '7px 10px', textAlign: 'left', color: 'var(--text-secondary)', fontWeight: 600, fontSize: 11 }}>What it means</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p, i) => {
                const e = p.edge;
                const ec = Math.abs(e) >= 20 ? (e > 0 ? 'var(--accent-green)' : 'var(--accent-red)') : Math.abs(e) >= 10 ? '#f59e0b' : 'var(--text-muted)';
                const sb = p.pValue == null ? null : p.pValue < 0.001 ? ['★★★','#10b981'] : p.pValue < 0.01 ? ['★★','#34d399'] : p.pValue < 0.05 ? ['★','#f59e0b'] : ['ns','#475569'];
                return (
                  <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', background: i%2===0?'transparent':'rgba(255,255,255,0.01)' }}>
                    <td style={{ padding: '8px 10px', fontWeight: 600, color: 'var(--text-primary)' }}>{p.label}</td>
                    <td style={{ padding: '8px 8px', textAlign: 'right', color: 'var(--text-muted)' }}>{p.n}</td>
                    <td style={{ padding: '8px 8px', textAlign: 'right', fontWeight: 700, color: e > 0 ? 'var(--accent-green)' : 'var(--accent-red)' }}>{p.rate}%</td>
                    <td style={{ padding: '8px 8px', textAlign: 'right', color: 'var(--text-muted)' }}>{p.baseline}%</td>
                    <td style={{ padding: '8px 8px', textAlign: 'right', fontWeight: 700, color: ec }}>{e > 0 ? '+' : ''}{e}%</td>
                    <td style={{ padding: '8px 8px', textAlign: 'right' }}>
                      {sb && <span style={{ color: sb[1], fontWeight: 600, fontSize: 11 }}>{sb[0]}</span>}
                    </td>
                    <td style={{ padding: '8px 10px', color: 'var(--text-muted)', fontSize: 11 }}>{p.description}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function EdgeAnalysisView() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [ran, setRan] = useState(false);
  const [view, setView] = useState('top'); // 'top' | category name

  const run = async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API_URL}/analysis/edge`);
      setData(await r.json());
      setRan(true);
    } catch(e) { console.error(e); }
    setLoading(false);
  };

  const categories = data?.sections?.map(s => s.category) ?? [];
  const activePatterns = view === 'top'
    ? (data?.top25 ?? [])
    : (data?.sections?.find(s => s.category === view)?.patterns ?? []);

  return (
    <div style={{ padding: '20px 0' }}>
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12, lineHeight: 1.7 }}>
          Scans all NQ bar history across <b style={{ color: 'var(--text-primary)' }}>{data?.total ?? '60+'}</b> hypotheses you may not have consciously tracked —
          time-of-day directional bias per 30-min slot, bid/ask pressure in the IB, opening drive follow-through,
          AM/PM continuation vs reversal, consecutive day sequences, volume vs range expansion, and open position within prior day range.
          Each result is statistically tested against a 50% baseline.
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button onClick={run} disabled={loading}
            style={{ padding: '8px 20px', borderRadius: 7, background: 'var(--accent-purple)', color: '#fff', border: 'none', cursor: loading ? 'default' : 'pointer', fontWeight: 600, fontSize: 13, opacity: loading ? 0.6 : 1 }}>
            {loading ? '⏳ Analyzing all sessions…' : ran ? '↺ Re-run' : '▶ Run Discovery Analysis'}
          </button>
          {ran && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{data?.sessions} sessions · {data?.total} patterns tested</span>}
        </div>
      </div>

      {ran && data && (
        <>
          {/* Category tabs */}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
            {['top', ...categories].map(cat => (
              <button key={cat} onClick={() => setView(cat)}
                style={{ fontSize: 11, padding: '4px 12px', borderRadius: 20, border: `1px solid ${view === cat ? 'var(--accent-purple)' : 'var(--border-color)'}`,
                  background: view === cat ? 'rgba(139,92,246,0.15)' : 'transparent',
                  color: view === cat ? 'var(--accent-purple)' : 'var(--text-secondary)',
                  cursor: 'pointer', fontWeight: view === cat ? 700 : 400 }}>
                {cat === 'top' ? '⭐ Top 25' : cat}
              </button>
            ))}
          </div>
          <EdgePatternTable patterns={activePatterns} />

          {/* Legend */}
          <div style={{ marginTop: 16, fontSize: 10, color: 'var(--text-muted)', display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <span><span style={{ color: '#10b981' }}>★★★</span> p&lt;0.001 (very strong)</span>
            <span><span style={{ color: '#34d399' }}>★★</span> p&lt;0.01 (strong)</span>
            <span><span style={{ color: '#f59e0b' }}>★</span> p&lt;0.05 (significant)</span>
            <span><span style={{ color: '#475569' }}>ns</span> not significant</span>
            <span style={{ marginLeft: 8 }}>Edge = actual rate minus 50% baseline. Green = bullish/confirmatory, Red = bearish/counter.</span>
          </div>
        </>
      )}

      {!ran && !loading && (
        <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-muted)', fontSize: 13 }}>
          Click "Run Discovery Analysis" to scan all your NQ bar history.<br /><br />
          <span style={{ fontSize: 11 }}>
            Covers: time-of-day slot bias · opening drive continuation · AM/PM reversal · bid/ask delta ·
            consecutive day sequences · volume patterns · day-of-week tendencies · open position in prior range · volatility expansion cycles
          </span>
        </div>
      )}
    </div>
  );
}

function BacktestView({ accounts, selectedAccounts, setSelectedAccounts, priceSyncProgress, onDismissPriceSync }) {
  const [rules, setRules] = useState({
    maxDailyLoss: '',
    maxDailyProfit: '',
    timeCutoff: '',
    maxSessions: '',
    consecutiveLossStop: '',
  });
  const [dateRange, setDateRange] = useState('all');
  const [data, setData] = useState(null);
  const [effData, setEffData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [ran, setRan] = useState(false);
  const [activeSection, setActiveSection] = useState('rules'); // 'rules' | 'efficiency' | 'volume' | 'keylevels' | 'chartreview'
  const [chartReviewDate, setChartReviewDate] = useState('');
  const [vpDate, setVpDate] = useState('');
  const [vpSession, setVpSession] = useState('rth');
  const [vpData, setVpData] = useState(null);
  const [vpLoading, setVpLoading] = useState(false);
  const [vpHover, setVpHover] = useState(null);
  const [vpZoom, setVpZoom] = useState(null); // { minPrice, maxPrice } or null = full range
  const [lastBarDate, setLastBarDate] = useState(null);

  const fetchLastBarDate = () => {
    fetch(`${API_URL}/price-bars/status`)
      .then(r => r.json())
      .then(j => {
        const nq = (j.coverage || []).find(c => c.symbol === 'NQ');
        if (nq?.to_ts) setLastBarDate(new Date(nq.to_ts));
      })
      .catch(() => {});
  };

  useEffect(() => { fetchLastBarDate(); }, []);

  useEffect(() => {
    if (priceSyncProgress?.status === 'success') fetchLastBarDate();
  }, [priceSyncProgress?.status]);
  const [vpDrag, setVpDrag] = useState(null); // { startY, startMin, startMax }

  const getDateParams = () => {
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const fmt = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
    if (dateRange === 'week') {
      const from = new Date(now); from.setDate(now.getDate() - 7);
      return { dateFrom: fmt(from), dateTo: fmt(now) };
    }
    if (dateRange === 'month') {
      const from = new Date(now); from.setMonth(now.getMonth() - 1);
      return { dateFrom: fmt(from), dateTo: fmt(now) };
    }
    if (dateRange === '3months') {
      const from = new Date(now); from.setMonth(now.getMonth() - 3);
      return { dateFrom: fmt(from), dateTo: fmt(now) };
    }
    if (dateRange === '6months') {
      const from = new Date(now); from.setMonth(now.getMonth() - 6);
      return { dateFrom: fmt(from), dateTo: fmt(now) };
    }
    return {};
  };

  const runBacktest = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (selectedAccounts.length > 0) params.set('account', selectedAccounts.join(','));
      const { dateFrom, dateTo } = getDateParams();
      if (dateFrom) params.set('dateFrom', dateFrom);
      if (dateTo)   params.set('dateTo', dateTo);
      if (rules.maxDailyLoss)       params.set('maxDailyLoss', rules.maxDailyLoss);
      if (rules.maxDailyProfit)     params.set('maxDailyProfit', rules.maxDailyProfit);
      if (rules.timeCutoff)         params.set('timeCutoff', rules.timeCutoff);
      if (rules.maxSessions)        params.set('maxSessions', rules.maxSessions);
      if (rules.consecutiveLossStop) params.set('consecutiveLossStop', rules.consecutiveLossStop);

      const res = await fetch(`${API_URL}/backtest?${params}`);
      const json = await res.json();
      setData(json);
      setRan(true);
    } catch (e) {
      console.error(e);
    }
    setLoading(false);
  };

  // Efficiency-specific timeframe and accounts (independent of global selection)
  const [effTf, setEffTf] = useState('all');
  const [effAccounts, setEffAccounts] = useState([]); // empty = all accounts
  const [hoveredEffPoint, setHoveredEffPoint] = useState(null); // { log_date, entry_eff, exit_eff, total_eff }

  // Stable keys to avoid array reference churn in useEffect deps
  const accountKey    = selectedAccounts.join(',');
  const effAccountKey = effAccounts.join(',');

  // Single effect drives all efficiency data — cleanup cancels stale fetches
  useEffect(() => {
    let cancelled = false;
    setEffData(null);
    const params = new URLSearchParams();
    // Use effAccounts if set, otherwise fall back to global selectedAccounts
    const accts = effAccounts.length > 0 ? effAccounts : selectedAccounts;
    if (accts.length > 0) params.set('account', accts.join(','));
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const fmtDate = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
    const sub = m => { const d = new Date(now); d.setMonth(d.getMonth() - m); return fmtDate(d); };
    if (effTf === 'week')         { params.set('dateFrom', fmtDate(new Date(now - 7*86400000))); params.set('dateTo', fmtDate(now)); }
    else if (effTf === 'month')   { params.set('dateFrom', sub(1));  params.set('dateTo', fmtDate(now)); }
    else if (effTf === '3months') { params.set('dateFrom', sub(3));  params.set('dateTo', fmtDate(now)); }
    else if (effTf === '6months') { params.set('dateFrom', sub(6));  params.set('dateTo', fmtDate(now)); }
    else if (effTf === '1y')      { params.set('dateFrom', sub(12)); params.set('dateTo', fmtDate(now)); }
    fetch(`${API_URL}/backtest/efficiency?${params}`)
      .then(r => r.json())
      .then(d => { if (!cancelled) setEffData(d); })
      .catch(e => { if (!cancelled) console.error(e); });
    return () => { cancelled = true; };
  }, [effTf, effAccountKey, accountKey]);

  // Auto-run backtest on mount/account change
  useEffect(() => {
    runBacktest();
    setRan(true);
  }, [selectedAccounts]);

  const pnlColor = v => v >= 0 ? 'var(--accent-green)' : 'var(--accent-red)';
  const fmt = (n, d=2) => {
    const sign = n >= 0 ? '+' : '';
    return `${sign}$${formatNumber(Math.abs(n), d)}`;
  };

  // Generate human-readable insights from the data
  const insights = useMemo(() => {
    if (!data) return [];
    const { patterns, summary, daily } = data;
    const list = [];

    // Best/worst hours
    const hours = [...patterns.hourlyPerformance].filter(h => h.count >= 3);
    if (hours.length > 0) {
      const best  = hours.reduce((a, b) => a.avgPnl > b.avgPnl ? a : b);
      const worst = hours.reduce((a, b) => a.avgPnl < b.avgPnl ? a : b);
      list.push({ type: 'positive', text: `Best hour: ${best.label} ET — avg ${fmt(best.avgPnl)} per session (${best.winRate}% win rate, ${best.count} sessions)` });
      if (worst.avgPnl < 0) {
        list.push({ type: 'negative', text: `Worst hour: ${worst.label} ET — avg ${fmt(worst.avgPnl)} per session (${worst.winRate}% win rate, ${worst.count} sessions)` });
      }
    }

    // Late-day fade (sessions after 12 PM ET)
    const lateHours = patterns.hourlyPerformance.filter(h => h.hour >= 12 && h.count >= 2);
    if (lateHours.length > 0) {
      const latePnl = lateHours.reduce((s, h) => s + h.totalPnl, 0);
      if (latePnl < 0) {
        list.push({ type: 'warning', text: `Sessions starting after 12:00 PM ET have cost you $${formatNumber(Math.abs(latePnl))} total. Consider a noon cutoff.` });
      }
    }

    // Session number performance
    const sn = patterns.sessionNumbers;
    if (sn.length >= 2) {
      const first = sn.find(s => s.sessionNum === 1);
      const later = sn.filter(s => s.sessionNum >= 3);
      if (first && later.length > 0) {
        const laterAvg = later.reduce((s, x) => s + x.avgPnl * x.count, 0) / later.reduce((s, x) => s + x.count, 0);
        if (first.avgPnl > 0 && laterAvg < first.avgPnl * 0.5) {
          list.push({ type: 'warning', text: `Your 1st session averages ${fmt(first.avgPnl)} but sessions 3+ average ${fmt(Math.round(laterAvg*100)/100)}. Your edge weakens as the day goes on.` });
        }
      }
    }

    // After-loss behavior
    const { afterLoss, afterWin } = patterns;
    if (afterLoss.count >= 5) {
      if (afterLoss.avgPnl < 0) {
        list.push({ type: 'negative', text: `After a losing session, your next session averages ${fmt(afterLoss.avgPnl)} (${afterLoss.winRate}% win rate). Revenge trading may be a factor.` });
      } else {
        list.push({ type: 'positive', text: `After a losing session, your next session averages ${fmt(afterLoss.avgPnl)} (${afterLoss.winRate}% win rate). You bounce back well.` });
      }
    }

    // Rule impact
    if (summary.hasRules && summary.daysRuleFired > 0) {
      const impact = summary.improvement;
      if (impact > 0) {
        list.push({ type: 'positive', text: `These rules would have fired on ${summary.daysRuleFired} of ${summary.daysTraded} trading days, improving your P&L by ${fmt(impact)} total (${fmt(impact/summary.daysRuleFired)} avg on days they fired).` });
      } else {
        list.push({ type: 'warning', text: `These rules would have fired on ${summary.daysRuleFired} days but cost you ${fmt(Math.abs(impact))} — they cut gains more often than they saved losses. Consider adjusting thresholds.` });
      }
    }

    // Best day of week
    const dow = patterns.dayOfWeek.filter(d => d.days >= 3);
    if (dow.length > 0) {
      const bestDow = dow.reduce((a, b) => a.avgPnl > b.avgPnl ? a : b);
      const worstDow = dow.reduce((a, b) => a.avgPnl < b.avgPnl ? a : b);
      list.push({ type: 'neutral', text: `Best day: ${bestDow.label} (avg ${fmt(bestDow.avgPnl)}, ${bestDow.winRate}% win). Worst day: ${worstDow.label} (avg ${fmt(worstDow.avgPnl)}, ${worstDow.winRate}% win).` });
    }

    // Max drawdown days
    const worstDays = [...daily].sort((a, b) => a.actualPnl - b.actualPnl).slice(0, 3);
    const worstTotal = worstDays.reduce((s, d) => s + d.actualPnl, 0);
    if (worstDays.length > 0 && worstDays[0].actualPnl < -500) {
      list.push({ type: 'negative', text: `Your 3 worst days totaled ${fmt(worstTotal)}: ${worstDays.map(d => `${d.date} (${fmt(d.actualPnl)})`).join(', ')}. A daily loss limit would have capped these.` });
    }

    return list;
  }, [data]);

  const ruleLabel = { maxDailyLoss: 'Max Loss', maxDailyProfit: 'Max Profit', timeCutoff: 'Time Cutoff', maxSessions: 'Max Sessions', consecutiveLoss: 'Consec. Losses' };

  const effInsights = useMemo(() => {
    if (!effData) return [];
    const { overall, byHour, bySession } = effData;
    const list = [];
    const gap = overall.avgEntryEff - overall.avgExitEff;
    if (gap > 15) {
      list.push({ type: 'negative', text: `Your entry efficiency (${overall.avgEntryEff}%) is ${gap.toFixed(0)}% higher than your exit efficiency (${overall.avgExitEff}%). You're entering well but exiting poorly — likely cutting winners too early or holding through reversals.` });
    }
    if (overall.avgExitEff < 35) {
      list.push({ type: 'warning', text: `Exit efficiency of ${overall.avgExitEff}% is well below average. Focus on letting winners run longer before exiting, or use a trailing stop to capture more of the move.` });
    }
    const { winBreakdown: w, lossBreakdown: l } = overall;
    if (!isNaN(w.exit) && !isNaN(l.exit)) {
      const exitGap = w.exit - l.exit;
      if (Math.abs(exitGap) > 8) {
        list.push({ type: exitGap > 0 ? 'positive' : 'warning', text: `On winning sessions your exit efficiency is ${w.exit}% vs ${l.exit}% on losing sessions. ${exitGap > 0 ? 'You exit better when you\'re right — trust that instinct more.' : 'You exit losing trades better than winning ones — you may be cutting wins but holding losses.'}` });
      }
      const entryGap = w.entry - l.entry;
      if (Math.abs(entryGap) > 10) {
        list.push({ type: entryGap > 0 ? 'positive' : 'warning', text: `Entry efficiency on winning sessions is ${w.entry}% vs ${l.entry}% on losing sessions. ${entryGap > 0 ? 'Better entries lead to better outcomes — your entry timing matters.' : 'You sometimes enter at better prices on trades that don\'t work out — your entry alone doesn\'t determine outcome.'}` });
      }
    }
    const lateHours = byHour.filter(h => h.hour >= 13 && h.sessions >= 5);
    if (lateHours.length > 0) {
      const lateExitAvg = lateHours.reduce((s, h) => s + h.exit_eff * h.sessions, 0) / lateHours.reduce((s, h) => s + h.sessions, 0);
      const earlyHours = byHour.filter(h => h.hour >= 9 && h.hour <= 11 && h.sessions >= 5);
      if (earlyHours.length > 0) {
        const earlyExitAvg = earlyHours.reduce((s, h) => s + h.exit_eff * h.sessions, 0) / earlyHours.reduce((s, h) => s + h.sessions, 0);
        if (earlyExitAvg - lateExitAvg > 5) {
          list.push({ type: 'warning', text: `Exit efficiency drops from ${earlyExitAvg.toFixed(0)}% in early session (9–11 AM) to ${lateExitAvg.toFixed(0)}% in afternoon (1–3 PM). Your decision-making on exits deteriorates as the day goes on.` });
        }
      }
    }
    const sess = bySession;
    if (sess.length >= 2) {
      const first = sess.find(s => s.session_num === 1);
      const third = sess.find(s => s.session_num >= 3);
      if (first && third && first.exit_eff - third.exit_eff > 8) {
        list.push({ type: 'warning', text: `Exit efficiency on your 1st session (${first.exit_eff}%) is meaningfully better than later sessions (${third.exit_eff}% for session 3+). Your exits get worse as you take more trades — fatigue or overtrading may be a factor.` });
      }
    }
    if (list.length === 0) {
      list.push({ type: 'neutral', text: `Overall efficiency looks consistent across hours and session counts. The main area to improve remains exit execution — capturing more of the available move before the market reverses.` });
    }
    return list;
  }, [effData]);

  const fetchVolumeProfile = async () => {
    if (!vpDate) return;
    setVpLoading(true);
    try {
      const params = new URLSearchParams({ symbol: 'NQ', date: vpDate, session: vpSession });
      const res = await fetch(`${API_URL}/price-bars/volume-profile?${params}`);
      const json = await res.json();
      setVpData(json.error ? null : json);
      setVpZoom(null);
    } catch (e) { setVpData(null); }
    setVpLoading(false);
  };

  return (
    <div className="backtest-view">
      <header className="page-header">
        <h1>Backtest</h1>
      </header>

      {priceSyncProgress && (
        <div className={`sync-progress-bar-wrap ${priceSyncProgress.status}`}>
          <div className="sync-progress-bar-header">
            <span className="sync-progress-label">
              {priceSyncProgress.status === 'error' ? '✕ Sync Failed' : priceSyncProgress.status === 'success' ? '✓ Sync Complete' : '⏳ Syncing...'}
            </span>
            <span className="sync-progress-msg">{priceSyncProgress.message}</span>
            {priceSyncProgress.status !== 'running' && (
              <button className="sync-dismiss" onClick={onDismissPriceSync}>×</button>
            )}
          </div>
          {priceSyncProgress.status !== 'error' && (
            <div className="sync-progress-track">
              <div className="sync-progress-fill" style={{ width: priceSyncProgress.status === 'success' ? '100%' : priceSyncProgress.total > 0 ? `${Math.round((priceSyncProgress.done / priceSyncProgress.total) * 100)}%` : '10%' }} />
            </div>
          )}
        </div>
      )}

      {/* Section Tabs */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, borderBottom: '1px solid var(--border-color)', paddingBottom: 0 }}>
        {[['rules', 'Rule Simulator'], ['efficiency', 'Efficiency Analysis'], ['volume', 'Volume Profile'], ['keylevels', 'Key Level Analysis'], ['edge', 'Edge Analysis'], ['chartreview', 'Chart Review']].map(([v, l]) => (
          <button key={v} onClick={() => setActiveSection(v)}
            style={{
              background: 'none', border: 'none', cursor: 'pointer', padding: '10px 20px',
              fontSize: 14, fontWeight: 600,
              color: activeSection === v ? 'var(--accent-purple)' : 'var(--text-secondary)',
              borderBottom: activeSection === v ? '2px solid var(--accent-purple)' : '2px solid transparent',
              transition: 'all 0.15s', marginBottom: -1
            }}>{l}</button>
        ))}
        {lastBarDate && (
          <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap', paddingBottom: 4 }}>
            NQ price data through{' '}
            <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>
              {lastBarDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}
            </span>
          </span>
        )}
      </div>

      {activeSection === 'rules' && <div className="backtest-config-panel">
        {/* Account selector */}
        <div className="backtest-config-section">
          <h3>Accounts</h3>
          {(() => {
            const isLiveAcct = a => !a.includes('TEST') && !a.includes('PRACTICE') && !a.includes('TFDRA') && !a.includes('BX') && !a.toLowerCase().startsWith('s1');
            const live = accounts.filter(isLiveAcct);
            const sim  = accounts.filter(a => !isLiveAcct(a));
            const toggle = a => setSelectedAccounts(prev => prev.includes(a) ? prev.filter(x => x !== a) : [...prev, a]);
            return (
              <>
                <div style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Live</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    <button className={`tag-btn ${accounts.every(a => selectedAccounts.includes(a)) ? 'active' : ''}`}
                      onClick={() => setSelectedAccounts(s => accounts.every(a => s.includes(a)) ? [] : [...accounts])}>All</button>
                    <button className={`tag-btn ${live.length > 0 && live.every(a => selectedAccounts.includes(a)) && !accounts.filter(a => !live.includes(a)).some(a => selectedAccounts.includes(a)) ? 'active' : ''}`}
                      onClick={() => setSelectedAccounts([...live])}>All Live</button>
                    {live.map(a => (
                      <button key={a} className={`tag-btn ${selectedAccounts.includes(a) ? 'active' : ''}`} onClick={() => toggle(a)}
                        style={{ color: selectedAccounts.includes(a) ? undefined : 'var(--accent-green)' }}>
                        {a.split('-').slice(-1)[0]}
                      </button>
                    ))}
                  </div>
                </div>
                {sim.length > 0 && (
                  <div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Evaluation / Sim</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, maxHeight: 80, overflowY: 'auto' }}>
                      {sim.map(a => (
                        <button key={a} className={`tag-btn ${selectedAccounts.includes(a) ? 'active' : ''}`} onClick={() => toggle(a)}>
                          {a.split('-').slice(-1)[0]}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </>
            );
          })()}
        </div>

        {/* Date range */}
        <div className="backtest-config-section">
          <h3>Date Range</h3>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {[['all','All Time'],['6months','6 Mo'],['3months','3 Mo'],['month','1 Mo'],['week','1 Wk']].map(([v,l]) => (
              <button key={v} className={`tag-btn ${dateRange === v ? 'active' : ''}`} onClick={() => setDateRange(v)}>{l}</button>
            ))}
          </div>
        </div>

        {/* Rules */}
        <div className="backtest-config-section">
          <h3>Rules <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--text-muted)' }}>(leave blank to skip)</span></h3>
          <div className="backtest-rules-grid">
            <div className="rule-input-group">
              <label>Max Daily Loss ($)</label>
              <input type="number" min="0" placeholder="e.g. 500"
                value={rules.maxDailyLoss}
                onChange={e => setRules(r => ({ ...r, maxDailyLoss: e.target.value }))} />
              <span className="rule-hint">Stop trading once down this amount</span>
            </div>
            <div className="rule-input-group">
              <label>Max Daily Profit ($)</label>
              <input type="number" min="0" placeholder="e.g. 1000"
                value={rules.maxDailyProfit}
                onChange={e => setRules(r => ({ ...r, maxDailyProfit: e.target.value }))} />
              <span className="rule-hint">Lock gains and stop once up this amount</span>
            </div>
            <div className="rule-input-group">
              <label>Time Cutoff (ET)</label>
              <input type="time" value={rules.timeCutoff}
                onChange={e => setRules(r => ({ ...r, timeCutoff: e.target.value }))} />
              <span className="rule-hint">No new sessions after this time</span>
            </div>
            <div className="rule-input-group">
              <label>Max Sessions / Day</label>
              <input type="number" min="1" placeholder="e.g. 3"
                value={rules.maxSessions}
                onChange={e => setRules(r => ({ ...r, maxSessions: e.target.value }))} />
              <span className="rule-hint">Stop after N completed sessions</span>
            </div>
            <div className="rule-input-group">
              <label>Consecutive Loss Stop</label>
              <input type="number" min="1" placeholder="e.g. 2"
                value={rules.consecutiveLossStop}
                onChange={e => setRules(r => ({ ...r, consecutiveLossStop: e.target.value }))} />
              <span className="rule-hint">Stop after N losses in a row</span>
            </div>
          </div>
        </div>

        <button className="btn btn-primary backtest-run-btn" onClick={runBacktest} disabled={loading}>
          {loading ? 'Running...' : 'Run Backtest'}
        </button>
      </div>}

      {activeSection === 'rules' && data && (
        <>
          {/* Summary Cards */}
          <div className="backtest-summary-cards">
            <div className="bt-card">
              <div className="bt-card-label">Actual P&L</div>
              <div className="bt-card-value" style={{ color: pnlColor(data.summary.actualPnl) }}>
                {fmt(data.summary.actualPnl)}
              </div>
              <div className="bt-card-sub">{data.summary.daysTraded} trading days</div>
            </div>
            {data.summary.hasRules && (
              <>
                <div className="bt-card">
                  <div className="bt-card-label">With Rules P&L</div>
                  <div className="bt-card-value" style={{ color: pnlColor(data.summary.simulatedPnl) }}>
                    {fmt(data.summary.simulatedPnl)}
                  </div>
                  <div className="bt-card-sub">Simulated result</div>
                </div>
                <div className="bt-card">
                  <div className="bt-card-label">Net Impact</div>
                  <div className="bt-card-value" style={{ color: pnlColor(data.summary.improvement) }}>
                    {fmt(data.summary.improvement)}
                  </div>
                  <div className="bt-card-sub">{data.summary.improvement >= 0 ? 'Improvement' : 'Cost'}</div>
                </div>
                <div className="bt-card">
                  <div className="bt-card-label">Rules Fired</div>
                  <div className="bt-card-value" style={{ color: 'var(--accent-blue)' }}>
                    {data.summary.daysRuleFired}
                  </div>
                  <div className="bt-card-sub">
                    {data.summary.daysImproved} saved · {data.summary.daysHurt} cut gains
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Cumulative P&L Chart */}
          <div className="backtest-chart-card">
            <h2>Cumulative P&L{data.summary.hasRules ? ' — Actual vs With Rules' : ''}</h2>
            <ResponsiveContainer width="100%" height={280}>
              <LineChart data={data.daily} margin={{ top: 10, right: 20, left: 10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                <XAxis dataKey="date" stroke="#94a3b8" tick={{ fontSize: 11 }}
                  tickFormatter={d => { const dt = new Date(d+'T12:00:00Z'); return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); }}
                  minTickGap={40} />
                <YAxis stroke="#94a3b8" tick={{ fontSize: 11 }}
                  tickFormatter={v => `$${formatNumber(v, 0)}`} width={75} />
                <Tooltip
                  contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 8 }}
                  formatter={(v, name) => [`$${formatNumber(v)}`, name === 'cumActual' ? 'Actual' : 'With Rules']}
                  labelFormatter={d => new Date(d+'T12:00:00Z').toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' })}
                />
                <ReferenceLine y={0} stroke="rgba(255,255,255,0.2)" />
                <Line type="monotone" dataKey="cumActual" stroke="#8b5cf6" strokeWidth={2} dot={false} name="cumActual" />
                {data.summary.hasRules && (
                  <Line type="monotone" dataKey="cumSimulated" stroke="#10b981" strokeWidth={2} dot={false} name="cumSimulated" strokeDasharray="5 3" />
                )}
                {data.summary.hasRules && <Legend formatter={v => v === 'cumActual' ? 'Actual' : 'With Rules'} />}
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Daily P&L Comparison */}
          {data.summary.hasRules && (
            <div className="backtest-chart-card">
              <h2>Daily P&L — Actual vs With Rules</h2>
              <ResponsiveContainer width="100%" height={240}>
                <ComposedChart data={data.daily} margin={{ top: 10, right: 20, left: 10, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                  <XAxis dataKey="date" stroke="#94a3b8" tick={{ fontSize: 10 }}
                    tickFormatter={d => new Date(d+'T12:00:00Z').toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' })}
                    minTickGap={40} />
                  <YAxis stroke="#94a3b8" tick={{ fontSize: 11 }} tickFormatter={v => `$${formatNumber(v,0)}`} width={75} />
                  <Tooltip
                    contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 8 }}
                    formatter={(v, name) => [`$${formatNumber(v)}`, name === 'actualPnl' ? 'Actual' : 'With Rules']}
                    labelFormatter={d => {
                      const day = data.daily.find(x => x.date === d);
                      return `${new Date(d+'T12:00:00Z').toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' })}${day?.ruleFired ? ` — rule: ${day.ruleType}` : ''}`;
                    }}
                  />
                  <ReferenceLine y={0} stroke="rgba(255,255,255,0.2)" />
                  <Bar dataKey="actualPnl" name="actualPnl" opacity={0.6}
                    fill="#8b5cf6"
                    label={false} />
                  <Scatter dataKey="simulatedPnl" name="simulatedPnl" fill="#10b981" line={false} />
                  <Legend formatter={v => v === 'actualPnl' ? 'Actual' : 'With Rules'} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Pattern Analysis Grid */}
          <div className="backtest-patterns-grid">

            {/* Session Number Performance */}
            <div className="backtest-chart-card">
              <h2>Performance by Session # (Intraday)</h2>
              <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
                Which trade of the day performs best?
              </p>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={data.patterns.sessionNumbers} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                  <XAxis dataKey="label" stroke="#94a3b8" tick={{ fontSize: 12 }} />
                  <YAxis stroke="#94a3b8" tick={{ fontSize: 11 }} tickFormatter={v => `$${formatNumber(v,0)}`} width={70} />
                  <Tooltip
                    contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 8 }}
                    formatter={(v, name) => name === 'avgPnl' ? [`$${formatNumber(v)}`, 'Avg P&L'] : [`${v}%`, 'Win Rate']}
                  />
                  <Bar dataKey="avgPnl" name="avgPnl" radius={[4,4,0,0]}
                    fill="#8b5cf6"
                    label={{ position: 'top', fontSize: 10, fill: '#94a3b8', formatter: v => `$${formatNumber(v,0)}` }}>
                    {data.patterns.sessionNumbers.map((s, i) => (
                      <Cell key={i} fill={s.avgPnl >= 0 ? '#10b981' : '#ef4444'} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
              <div style={{ display: 'flex', gap: 16, marginTop: 8, flexWrap: 'wrap' }}>
                {data.patterns.sessionNumbers.map(s => (
                  <div key={s.label} style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                    <b>{s.label}</b>: {s.winRate}% WR · {s.count} sessions
                  </div>
                ))}
              </div>
            </div>

            {/* Hourly Performance */}
            <div className="backtest-chart-card">
              <h2>Performance by Hour (ET)</h2>
              <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
                Avg P&L per completed session by start hour
              </p>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={data.patterns.hourlyPerformance} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                  <XAxis dataKey="label" stroke="#94a3b8" tick={{ fontSize: 11 }} />
                  <YAxis stroke="#94a3b8" tick={{ fontSize: 11 }} tickFormatter={v => `$${formatNumber(v,0)}`} width={70} />
                  <Tooltip
                    contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 8 }}
                    formatter={(v, name) => [`$${formatNumber(v)}`, name === 'avgPnl' ? 'Avg P&L' : 'Total P&L']}
                    labelFormatter={l => `Hour: ${l} ET`}
                  />
                  <Bar dataKey="avgPnl" name="avgPnl" radius={[4,4,0,0]}>
                    {data.patterns.hourlyPerformance.map((h, i) => (
                      <Cell key={i} fill={h.avgPnl >= 0 ? '#10b981' : '#ef4444'} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
              <div style={{ display: 'flex', gap: 12, marginTop: 8, flexWrap: 'wrap' }}>
                {data.patterns.hourlyPerformance.map(h => (
                  <div key={h.hour} style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                    <b>{h.label}</b>: {h.winRate}% WR · {h.count} sess
                  </div>
                ))}
              </div>
            </div>

            {/* Day of Week */}
            <div className="backtest-chart-card">
              <h2>Performance by Day of Week</h2>
              <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
                Avg daily P&L and win rate by weekday
              </p>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={data.patterns.dayOfWeek} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                  <XAxis dataKey="label" stroke="#94a3b8" tick={{ fontSize: 12 }} />
                  <YAxis stroke="#94a3b8" tick={{ fontSize: 11 }} tickFormatter={v => `$${formatNumber(v,0)}`} width={70} />
                  <Tooltip
                    contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 8 }}
                    formatter={(v) => [`$${formatNumber(v)}`, 'Avg P&L']}
                    labelFormatter={(l, payload) => {
                      const d = payload?.[0]?.payload;
                      return d ? `${l} — ${d.winRate}% win rate (${d.days} days)` : l;
                    }}
                  />
                  <Bar dataKey="avgPnl" name="avgPnl" radius={[4,4,0,0]}>
                    {data.patterns.dayOfWeek.map((d, i) => (
                      <Cell key={i} fill={d.avgPnl >= 0 ? '#10b981' : '#ef4444'} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
              <div style={{ display: 'flex', gap: 16, marginTop: 8, flexWrap: 'wrap' }}>
                {data.patterns.dayOfWeek.map(d => (
                  <div key={d.label} style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                    <b>{d.label}</b>: {d.winRate}% WR · {d.days} days
                  </div>
                ))}
              </div>
            </div>

            {/* After-Loss Behavior */}
            <div className="backtest-chart-card">
              <h2>Next Session After Win vs Loss</h2>
              <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
                How do you perform in the session immediately following a win or loss?
              </p>
              <div className="after-loss-grid">
                {[
                  { label: 'After a Loss', color: '#ef4444', stats: data.patterns.afterLoss },
                  { label: 'After a Win',  color: '#10b981', stats: data.patterns.afterWin  }
                ].map(({ label, color, stats }) => (
                  <div key={label} className="after-loss-card" style={{ borderColor: color }}>
                    <div className="al-label">{label}</div>
                    <div className="al-value" style={{ color: pnlColor(stats.avgPnl) }}>
                      {fmt(stats.avgPnl)} avg
                    </div>
                    <div className="al-detail">{stats.winRate}% win rate</div>
                    <div className="al-detail">{stats.count} instances</div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Insights */}
          {insights.length > 0 && (
            <div className="backtest-chart-card backtest-insights">
              <h2>Analysis</h2>
              <div className="insights-list">
                {insights.map((ins, i) => (
                  <div key={i} className={`insight-item insight-${ins.type}`}>
                    <span className="insight-icon">
                      {ins.type === 'positive' ? '✓' : ins.type === 'negative' ? '!' : ins.type === 'warning' ? '⚠' : 'i'}
                    </span>
                    <p>{ins.text}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Day-by-Day Table */}
          {data.summary.hasRules && (
            <div className="backtest-chart-card">
              <h2>Day-by-Day Breakdown</h2>
              <div style={{ overflowX: 'auto' }}>
                <table className="backtest-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Day</th>
                      <th style={{ textAlign: 'right' }}>Actual P&L</th>
                      <th style={{ textAlign: 'right' }}>With Rules</th>
                      <th style={{ textAlign: 'right' }}>Impact</th>
                      <th>Sessions</th>
                      <th>Rule Fired</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...data.daily].sort((a, b) => b.date.localeCompare(a.date)).map(d => {
                      const impact = d.simulatedPnl - d.actualPnl;
                      return (
                        <tr key={d.date} className={d.ruleFired ? 'rule-fired-row' : ''}>
                          <td>{d.date}</td>
                          <td style={{ color: 'var(--text-secondary)' }}>
                            {new Date(d.date+'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short' })}
                          </td>
                          <td style={{ textAlign: 'right', color: pnlColor(d.actualPnl), fontWeight: 600 }}>
                            {fmt(d.actualPnl)}
                          </td>
                          <td style={{ textAlign: 'right', color: pnlColor(d.simulatedPnl), fontWeight: 600 }}>
                            {fmt(d.simulatedPnl)}
                          </td>
                          <td style={{ textAlign: 'right', color: pnlColor(impact) }}>
                            {impact === 0 ? '—' : fmt(impact)}
                          </td>
                          <td style={{ color: 'var(--text-secondary)', fontSize: 12 }}>
                            {d.sessionsTaken}/{d.sessionsActual} taken
                          </td>
                          <td style={{ fontSize: 12, color: d.ruleFired ? 'var(--accent-blue)' : 'var(--text-muted)' }}>
                            {d.ruleFired ? (ruleLabel[d.ruleType] || d.ruleType) : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {activeSection === 'rules' && loading && !data && (
        <div style={{ textAlign: 'center', color: 'var(--text-muted)', marginTop: 60, fontSize: 16 }}>
          Running analysis...
        </div>
      )}

      {/* Efficiency tab controls — timeframe + per-tab account selector */}
      {activeSection === 'efficiency' && (() => {
        const EFF_TFS = [['all','All Time'],['1y','1 Year'],['6months','6 Mo'],['3months','3 Mo'],['month','1 Mo'],['week','1 Wk']];
        const activeAccts = effAccounts.length > 0 ? effAccounts : selectedAccounts;
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
            {/* Row 1: Timeframe + session count */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, color: 'var(--text-muted)', minWidth: 76 }}>Timeframe</span>
              {EFF_TFS.map(([v, l]) => (
                <button key={v} className={`tag-btn ${effTf === v ? 'active' : ''}`} onClick={() => setEffTf(v)}>{l}</button>
              ))}
              {effData && <span style={{ fontSize: 13, color: 'var(--text-muted)', marginLeft: 4 }}>{effData.overall?.totalSessions} sessions</span>}
              {!effData && <span style={{ fontSize: 13, color: 'var(--text-muted)', marginLeft: 4 }}>Loading…</span>}
            </div>
            {/* Row 2: Account selector — independent of global selection */}
            {accounts.length > 1 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13, color: 'var(--text-muted)', minWidth: 76 }}>Accounts</span>
                <button
                  onClick={() => setEffAccounts([])}
                  style={{ padding: '3px 10px', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer',
                    background: effAccounts.length === 0 ? '#3b82f6' : 'var(--card-bg)',
                    color: effAccounts.length === 0 ? '#fff' : 'var(--text-muted)',
                    border: `1px solid ${effAccounts.length === 0 ? '#3b82f6' : 'var(--border-color)'}` }}>
                  All
                </button>
                {accounts.map(acct => {
                  const active = effAccounts.includes(acct);
                  return (
                    <button key={acct}
                      onClick={() => setEffAccounts(prev =>
                        active ? (prev.length > 1 ? prev.filter(a => a !== acct) : prev) : [...prev, acct]
                      )}
                      style={{ padding: '3px 10px', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer',
                        background: active ? '#3b82f6' : 'var(--card-bg)',
                        color: active ? '#fff' : 'var(--text-muted)',
                        border: `1px solid ${active ? '#3b82f6' : 'var(--border-color)'}` }}>
                      {acct.slice(-8)}
                    </button>
                  );
                })}
                {effAccounts.length > 0 && (
                  <span style={{ fontSize: 13, color: '#3b82f6', marginLeft: 4 }}>
                    ● custom selection
                  </span>
                )}
              </div>
            )}
          </div>
        );
      })()}

      {activeSection === 'efficiency' && !effData && (
        <div style={{ textAlign: 'center', color: 'var(--text-muted)', marginTop: 60, fontSize: 16 }}>Loading efficiency data…</div>
      )}

      {/* ==================== EFFICIENCY SECTION ==================== */}
      {activeSection === 'efficiency' && effData && (() => {
        const { overall, byDate, byDateAllTime, byHour, bySession, scatter, sessionPnlDist: sp, last14DaysDist: l14 } = effData;
        const effColor = v => v >= 50 ? 'var(--accent-green)' : v >= 30 ? '#f59e0b' : 'var(--accent-red)';
        return (
          <>
            {/* Overall Efficiency Cards */}
            <div className="backtest-summary-cards">
              {[
                { label: 'Entry Efficiency', value: overall.avgEntryEff, sub: `${overall.totalSessions} sessions` },
                { label: 'Exit Efficiency',  value: overall.avgExitEff,  sub: 'Capturing the move' },
                { label: 'Total Efficiency', value: overall.avgTotalEff, sub: 'Combined score' },
              ].map(c => (
                <div key={c.label} className="bt-card">
                  <div className="bt-card-label">{c.label}</div>
                  <div className="bt-card-value" style={{ color: effColor(c.value) }}>{c.value}%</div>
                  <div className="bt-card-sub">{c.sub}</div>
                </div>
              ))}
            </div>

            {/* Realistic Session Expectation — chart left (all time), boxes right (last 14 days or selected period) */}
            <div className="backtest-chart-card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
                <h2>Realistic Session Expectation</h2>
                <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                  Chart: all-time · Boxes: {l14?.winCount || l14?.lossCount ? 'last 14 days' : 'selected period'}
                </span>
              </div>
              {/* Two-column layout: chart left, boxes right */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 220px', gap: 20, alignItems: 'start' }}>
                {/* Left: all-time efficiency trend — always rendered */}
                <div>
                  {(() => {
                    const chartData = byDateAllTime?.length ? byDateAllTime : byDate;
                    const display = hoveredEffPoint || (chartData?.length ? chartData[chartData.length - 1] : null);
                    // Find the first date in the dataset that falls on or after Jan 1 of each year
                    const yearMarkers = [];
                    if (chartData?.length) {
                      const years = [...new Set(chartData.map(d => d.log_date.slice(0, 4)))];
                      years.forEach(yr => {
                        // Use the first date in chartData that belongs to this year
                        const first = chartData.find(d => d.log_date.startsWith(yr));
                        if (first) yearMarkers.push({ date: first.log_date, year: yr });
                      });
                    }
                    return (
                      <>
                      {/* Stats bar — shows hovered point values, falls back to latest */}
                      <div style={{ display: 'flex', gap: 20, marginBottom: 8, padding: '6px 10px', background: 'rgba(0,0,0,0.15)', borderRadius: 6, alignItems: 'center' }}>
                        {display ? (
                          <>
                            <span style={{ fontSize: 12, color: '#475569', fontFamily: 'monospace', minWidth: 90 }}>
                              {display.log_date ? new Date(display.log_date + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}
                              {hoveredEffPoint ? '' : ' (latest)'}
                            </span>
                            {[
                              { label: 'Entry', value: display.entry_eff, color: '#3b82f6' },
                              { label: 'Exit',  value: display.exit_eff,  color: '#10b981' },
                              { label: 'Total', value: display.total_eff, color: '#8b5cf6' },
                            ].map(({ label, value, color }) => (
                              <span key={label} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                                <span style={{ fontSize: 12, color: '#64748b' }}>{label}</span>
                                <span style={{ fontSize: 15, fontWeight: 700, color, fontFamily: 'monospace' }}>
                                  {value != null ? `${value}%` : '—'}
                                </span>
                              </span>
                            ))}
                          </>
                        ) : <span style={{ fontSize: 12, color: '#475569' }}>Hover the chart to see values</span>}
                      </div>
                      <ResponsiveContainer width="100%" height={200}>
                        <LineChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}
                          onMouseMove={e => { if (e?.activePayload?.[0]) setHoveredEffPoint(e.activePayload[0].payload); }}
                          onMouseLeave={() => setHoveredEffPoint(null)}>
                          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                          <XAxis dataKey="log_date" stroke="#94a3b8" tick={{ fontSize: 11 }}
                            tickFormatter={d => new Date(d+'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                            minTickGap={60} />
                          <YAxis stroke="#94a3b8" tick={{ fontSize: 11 }} tickFormatter={v => `${v}%`} width={42} domain={[-40, 100]} />
                          <Tooltip content={() => null} />
                          <ReferenceLine y={0} stroke="rgba(255,255,255,0.2)" />
                          {yearMarkers.map(({ date, year }) => (
                            <ReferenceLine key={year} x={date}
                              stroke="rgba(255,255,255,0.35)" strokeWidth={1} strokeDasharray="6 3"
                              label={{ value: year, position: 'insideTopLeft', fill: '#94a3b8', fontSize: 11, fontWeight: 700 }} />
                          ))}
                          <Line type="monotone" dataKey="entry_eff" stroke="#3b82f6" strokeWidth={2} dot={false} name="entry_eff" />
                          <Line type="monotone" dataKey="exit_eff"  stroke="#10b981" strokeWidth={2} dot={false} name="exit_eff" />
                          <Line type="monotone" dataKey="total_eff" stroke="#8b5cf6" strokeWidth={1.5} dot={false} name="total_eff" strokeDasharray="4 2" />
                          <Legend iconSize={10} wrapperStyle={{ fontSize: 12, marginTop: 4 }}
                            formatter={v => v === 'entry_eff' ? 'Entry' : v === 'exit_eff' ? 'Exit' : 'Total'} />
                        </LineChart>
                      </ResponsiveContainer>
                      </>
                    );
                  })()}
                </div>

                {/* Right: 4 stacked boxes — use last14 if available, else fall back to selected period */}
                {(() => {
                  const d = (l14?.p50Win != null) ? l14 : sp;
                  if (!d) return null;
                  // MNQ = $2/point. Convert session P&L to points for 1 MNQ contract.
                  const toMnqPts = v => v != null ? +(Math.abs(v) / 2).toFixed(2) : null;
                  return (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <div style={{ fontSize: 11, color: '#64748b', textAlign: 'right', marginBottom: 2 }}>
                        {d === l14 ? `Last 14 days · ${(l14.winCount || 0) + (l14.lossCount || 0)} sessions` : `${(sp.winCount || 0) + (sp.lossCount || 0)} sessions`}
                      </div>
                      {[
                        { label: '50% of winners', value: d.p50Win, color: '#22c55e', sub: 'TP1 — 1 MNQ' },
                        { label: '75% of winners', value: d.p75Win, color: '#22c55e', sub: 'TP2 — 1 MNQ' },
                        { label: "Don't plan >", value: d.p75Win, color: '#f59e0b', sub: `90th: ${toMnqPts(d.p90Win)} pts` },
                        { label: 'Median loss', value: d.p50Loss, color: '#ef4444', sub: `avg: ${toMnqPts(d.avgLoss)} pts`, neg: true },
                      ].map((box, i) => {
                        const pts = toMnqPts(box.value);
                        return (
                          <div key={i} style={{ padding: '10px 14px', background: 'rgba(0,0,0,0.15)', borderRadius: 8, border: `1px solid ${box.color}25` }}>
                            <div style={{ fontSize: 11, color: '#64748b', marginBottom: 2, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{box.label}</div>
                            <div style={{ fontSize: 20, fontWeight: 800, color: box.color, fontFamily: 'monospace', lineHeight: 1.2 }}>
                              {box.neg ? '-' : ''}{pts ?? '—'} <span style={{ fontSize: 13, fontWeight: 600 }}>pts</span>
                            </div>
                            <div style={{ fontSize: 11, color: '#475569', marginTop: 1 }}>{box.sub}</div>
                          </div>
                        );
                      })}
                      {d.p50Win != null && d.p50Loss != null && (
                        <div style={{ padding: '8px 14px', background: 'rgba(0,0,0,0.1)', borderRadius: 6, textAlign: 'center' }}>
                          <span style={{ fontSize: 11, color: '#64748b' }}>R:R (1 MNQ)  </span>
                          <span style={{ fontWeight: 700, fontFamily: 'monospace', fontSize: 13 }}>
                            <span style={{ color: '#22c55e' }}>{toMnqPts(d.p50Win)}pts</span>
                            <span style={{ color: '#475569', margin: '0 4px' }}>vs</span>
                            <span style={{ color: '#ef4444' }}>{toMnqPts(d.p50Loss)}pts</span>
                            <span style={{ color: '#64748b', marginLeft: 6 }}>
                              = {(d.p50Win / Math.abs(d.p50Loss || 1)).toFixed(2)}:1
                            </span>
                          </span>
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>
            </div>

            {/* Win vs Loss Efficiency Breakdown */}
            <div className="backtest-chart-card">
              <h2>Efficiency: Winning vs Losing Sessions</h2>
              <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 16 }}>
                Do you execute better on trades that work out?
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                {[
                  { label: `Winning Sessions (${overall.wins})`, color: 'var(--accent-green)', d: overall.winBreakdown },
                  { label: `Losing Sessions (${overall.losses})`, color: 'var(--accent-red)',   d: overall.lossBreakdown }
                ].map(({ label, color, d }) => (
                  <div key={label} style={{ background: 'var(--bg-secondary)', borderRadius: 10, padding: 20, border: `1px solid ${color}33` }}>
                    <div style={{ fontWeight: 600, color, marginBottom: 14, fontSize: 14 }}>{label}</div>
                    {[['Entry', d.entry], ['Exit', d.exit], ['Total', d.total]].map(([name, val]) => (
                      <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
                        <span style={{ width: 40, fontSize: 12, color: 'var(--text-muted)' }}>{name}</span>
                        <div style={{ flex: 1, background: 'var(--bg-card)', borderRadius: 4, height: 8, overflow: 'hidden' }}>
                          <div style={{ width: `${Math.max(0, Math.min(100, val))}%`, height: '100%', background: effColor(val), borderRadius: 4, transition: 'width 0.5s' }} />
                        </div>
                        <span style={{ width: 42, textAlign: 'right', fontWeight: 600, fontSize: 13, color: effColor(val) }}>{isNaN(val) ? '—' : `${val}%`}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>

            {/* Efficiency by Hour + Session # side by side */}
            <div className="backtest-patterns-grid">
              <div className="backtest-chart-card">
                <h2>Efficiency by Hour (ET)</h2>
                <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
                  Entry vs exit efficiency by time of day
                </p>
                <ResponsiveContainer width="100%" height={240}>
                  <BarChart data={byHour.filter(h => h.hour >= 8 && h.hour <= 16)} margin={{ top: 5, right: 10, left: 5, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                    <XAxis dataKey="label" stroke="#94a3b8" tick={{ fontSize: 11 }} />
                    <YAxis stroke="#94a3b8" tick={{ fontSize: 11 }} tickFormatter={v => `${v}%`} width={42} />
                    <Tooltip
                      contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 8 }}
                      formatter={(v, name) => [`${v}%`, name === 'entry_eff' ? 'Entry Eff' : 'Exit Eff']}
                      labelFormatter={(l, p) => { const d = p?.[0]?.payload; return d ? `${l} ET · ${d.sessions} sessions` : l; }}
                    />
                    <Bar dataKey="entry_eff" name="entry_eff" fill="#3b82f6" opacity={0.8} radius={[3,3,0,0]} />
                    <Bar dataKey="exit_eff"  name="exit_eff"  fill="#10b981" opacity={0.8} radius={[3,3,0,0]} />
                    <Legend formatter={v => v === 'entry_eff' ? 'Entry' : 'Exit'} />
                  </BarChart>
                </ResponsiveContainer>
              </div>

              <div className="backtest-chart-card">
                <h2>Efficiency by Session # (Intraday)</h2>
                <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
                  Does execution quality drop with more trades?
                </p>
                <ResponsiveContainer width="100%" height={240}>
                  <BarChart data={bySession} margin={{ top: 5, right: 10, left: 5, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                    <XAxis dataKey="label" stroke="#94a3b8" tick={{ fontSize: 12 }} />
                    <YAxis stroke="#94a3b8" tick={{ fontSize: 11 }} tickFormatter={v => `${v}%`} width={42} />
                    <Tooltip
                      contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 8 }}
                      formatter={(v, name) => [`${v}%`, name === 'entry_eff' ? 'Entry Eff' : 'Exit Eff']}
                      labelFormatter={(l, p) => { const d = p?.[0]?.payload; return d ? `Session ${l} · ${d.sessions} instances` : l; }}
                    />
                    <Bar dataKey="entry_eff" name="entry_eff" fill="#3b82f6" opacity={0.8} radius={[3,3,0,0]} />
                    <Bar dataKey="exit_eff"  name="exit_eff"  fill="#10b981" opacity={0.8} radius={[3,3,0,0]} />
                    <Legend formatter={v => v === 'entry_eff' ? 'Entry' : 'Exit'} />
                  </BarChart>
                </ResponsiveContainer>
                <div style={{ display: 'flex', gap: 16, marginTop: 8, flexWrap: 'wrap' }}>
                  {bySession.map(s => (
                    <div key={s.label} style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                      <b>{s.label}</b>: avg {s.avg_pnl >= 0 ? '+' : ''}${formatNumber(s.avg_pnl)} · {s.sessions} sessions
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Scatter: Total Efficiency vs P&L */}
            <div className="backtest-chart-card">
              <h2>Total Efficiency vs Session P&L</h2>
              <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
                Does higher efficiency predict better outcomes? Each dot = one session. ({scatter.length} sampled)
              </p>
              <ResponsiveContainer width="100%" height={280}>
                <ComposedChart margin={{ top: 10, right: 20, left: 10, bottom: 10 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                  <XAxis type="number" dataKey="x" stroke="#94a3b8" tick={{ fontSize: 11 }}
                    label={{ value: 'Total Efficiency %', position: 'insideBottom', offset: -5, fill: '#64748b', fontSize: 11 }}
                    tickFormatter={v => `${v}%`} domain={[-100, 100]} />
                  <YAxis type="number" dataKey="y" stroke="#94a3b8" tick={{ fontSize: 11 }}
                    tickFormatter={v => `$${formatNumber(v, 0)}`} width={70} />
                  <Tooltip
                    contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 8 }}
                    formatter={(v, name) => name === 'x' ? [`${v}%`, 'Efficiency'] : [`$${formatNumber(v)}`, 'P&L']}
                    labelFormatter={() => ''}
                    content={({ active, payload }) => {
                      if (!active || !payload?.length) return null;
                      const d = payload[0]?.payload;
                      return (
                        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 8, padding: '8px 12px', fontSize: 12 }}>
                          <div>Efficiency: <b>{d?.x}%</b></div>
                          <div>P&L: <b style={{ color: d?.y >= 0 ? 'var(--accent-green)' : 'var(--accent-red)' }}>${formatNumber(d?.y)}</b></div>
                          {d?.date && <div style={{ color: 'var(--text-muted)' }}>{d.date}</div>}
                        </div>
                      );
                    }}
                  />
                  <ReferenceLine x={0} stroke="rgba(255,255,255,0.15)" />
                  <ReferenceLine y={0} stroke="rgba(255,255,255,0.15)" />
                  <Scatter data={scatter} fill="#8b5cf6" opacity={0.5} r={3} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            {/* Efficiency Insights */}
            {effInsights.length > 0 && (
              <div className="backtest-chart-card backtest-insights">
                <h2>Analysis</h2>
                <div className="insights-list">
                  {effInsights.map((ins, i) => (
                    <div key={i} className={`insight-item insight-${ins.type}`}>
                      <span className="insight-icon">
                        {ins.type === 'positive' ? '✓' : ins.type === 'negative' ? '!' : ins.type === 'warning' ? '⚠' : 'i'}
                      </span>
                      <p>{ins.text}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        );
      })()}

      {activeSection === 'efficiency' && !effData && (
        <div style={{ textAlign: 'center', color: 'var(--text-muted)', marginTop: 60, fontSize: 16 }}>
          Loading efficiency data...
        </div>
      )}

      {/* ==================== VOLUME PROFILE SECTION ==================== */}
      {activeSection === 'volume' && (
        <div style={{ padding: '24px 0' }}>
          {/* Controls */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24, flexWrap: 'wrap' }}>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>Date</label>
              <input type="date" value={vpDate} onChange={e => setVpDate(e.target.value)}
                style={{ background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderRadius: 6,
                  color: 'var(--text-primary)', padding: '6px 10px', fontSize: 13 }} />
            </div>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>Session (EST)</label>
              <div style={{ display: 'flex', gap: 6 }}>
                {[['rth', 'RTH', '9:30–16:14'], ['overnight', 'Overnight', '16:15–9:29'], ['both', 'Both', 'Full Day']].map(([v, l, sub]) => (
                  <button key={v} onClick={() => setVpSession(v)}
                    style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid var(--border-color)',
                      background: vpSession === v ? 'var(--accent-purple)' : 'var(--card-bg)',
                      color: vpSession === v ? '#fff' : 'var(--text-secondary)',
                      cursor: 'pointer', fontSize: 13, fontWeight: vpSession === v ? 600 : 400 }}>
                    {l}<br/><span style={{ fontSize: 10, opacity: 0.8 }}>{sub}</span>
                  </button>
                ))}
              </div>
            </div>
            <button onClick={fetchVolumeProfile} disabled={!vpDate || vpLoading}
              style={{ alignSelf: 'flex-end', padding: '7px 20px', borderRadius: 6, border: 'none',
                background: 'var(--accent-purple)', color: '#fff', fontWeight: 600, fontSize: 13,
                cursor: vpDate ? 'pointer' : 'not-allowed', opacity: vpDate ? 1 : 0.5 }}>
              {vpLoading ? 'Loading…' : 'Generate'}
            </button>
            {vpData && (
              <div style={{ alignSelf: 'flex-end', fontSize: 12, color: 'var(--text-secondary)' }}>
                {vpData.contract} · {vpData.session} · {vpData.totalBars} bars · {vpData.totalVolume.toLocaleString()} contracts
              </div>
            )}
          </div>

          {vpData && (() => {
            const { profile, poc, vah, val } = vpData;
            const allDisplay = [...profile].reverse();
            const display = vpZoom
              ? allDisplay.filter(r => r.price >= vpZoom.minPrice && r.price <= vpZoom.maxPrice)
              : allDisplay;
            const maxVol = Math.max(...display.map(p => p.volume));
            const n = display.length;

            return (
              <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start' }}>
                <div style={{ flex: '1 1 500px', minWidth: 300 }}>
                  {(() => {
                    const allPrices = allDisplay.map(r => r.price);
                    const fullRange = allPrices[0] - allPrices[allPrices.length - 1];
                    const applyZoom = (factor) => {
                      const curMin = vpZoom ? vpZoom.minPrice : allPrices[allPrices.length - 1];
                      const curMax = vpZoom ? vpZoom.maxPrice : allPrices[0];
                      const center = vpHover ? vpHover.price : (curMin + curMax) / 2;
                      const newRange = Math.max(10, Math.min((curMax - curMin) * factor, fullRange));
                      const newMin = Math.max(allPrices[allPrices.length - 1], center - newRange / 2);
                      const newMax = Math.min(allPrices[0], newMin + newRange);
                      if (newMax - newMin >= fullRange - 0.01) setVpZoom(null);
                      else setVpZoom({ minPrice: newMin, maxPrice: newMax });
                    };
                    const btnStyle = { fontSize: 16, fontWeight: 700, width: 28, height: 28, borderRadius: 4, cursor: 'pointer',
                      background: 'var(--card-bg)', border: '1px solid var(--border-color)', color: 'var(--text-primary)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 };
                    return (
                  <div style={{ fontSize: 13, marginBottom: 10, display: 'flex', gap: 12, alignItems: 'center' }}>
                    <span style={{ color: 'var(--accent-purple)', fontWeight: 700 }}>POC {poc.toFixed(2)}</span>
                    <span style={{ color: 'var(--accent-green)' }}>VAH {vah.toFixed(2)}</span>
                    <span style={{ color: 'var(--accent-red)' }}>VAL {val.toFixed(2)}</span>
                    <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
                      <button style={btnStyle} onClick={() => applyZoom(0.6)}>+</button>
                      <button style={btnStyle} onClick={() => applyZoom(1.67)}>−</button>
                      {vpZoom && (
                        <button onClick={() => setVpZoom(null)}
                          style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, cursor: 'pointer',
                            background: 'var(--card-bg)', border: '1px solid var(--border-color)', color: 'var(--text-secondary)' }}>
                          Reset
                        </button>
                      )}
                    </div>
                  </div>
                    );
                  })()}
                  <div style={{ height: 580, display: 'flex', flexDirection: 'column', position: 'relative', overflow: 'hidden' }}
                    onMouseLeave={() => { setVpHover(null); setVpDrag(null); }}
                    onMouseMove={(e) => {
                      const rect = e.currentTarget.getBoundingClientRect();
                      const y = e.clientY - rect.top;
                      const idx = Math.min(Math.floor(Math.max(0, y) / rect.height * n), n - 1);
                      if (!vpDrag) setVpHover({ price: display[idx].price, y });
                      if (vpDrag) {
                        // pan: drag down → lower prices, drag up → higher prices
                        const allPrices = allDisplay.map(r => r.price);
                        const range = vpDrag.startMax - vpDrag.startMin;
                        const pricePerPx = range / rect.height;
                        const delta = (e.clientY - vpDrag.startY) * pricePerPx;
                        let newMin = vpDrag.startMin - delta;
                        let newMax = vpDrag.startMax - delta;
                        if (newMin < allPrices[allPrices.length - 1]) { newMin = allPrices[allPrices.length - 1]; newMax = newMin + range; }
                        if (newMax > allPrices[0]) { newMax = allPrices[0]; newMin = newMax - range; }
                        setVpZoom({ minPrice: newMin, maxPrice: newMax });
                      }
                    }}
                    onMouseDown={(e) => {
                      if (vpZoom) setVpDrag({ startY: e.clientY, startMin: vpZoom.minPrice, startMax: vpZoom.maxPrice });
                    }}
                    onMouseUp={() => setVpDrag(null)}>

                    {/* Price axis labels — absolutely positioned so they're always readable */}
                    {(() => {
                      const priceMin = display[display.length - 1].price;
                      const priceMax = display[0].price;
                      const visibleRange = priceMax - priceMin;
                      const labelIncrement = visibleRange > 200 ? 50 : visibleRange > 80 ? 25 : visibleRange > 30 ? 10 : 5;
                      const labels = [];
                      const start = Math.ceil(priceMin / labelIncrement) * labelIncrement;
                      for (let p = start; p <= priceMax; p += labelIncrement) {
                        const topPct = (1 - (p - priceMin) / visibleRange) * 100;
                        labels.push(
                          <div key={p} style={{ position: 'absolute', right: 4, pointerEvents: 'none', zIndex: 5,
                            top: `${topPct}%`, transform: 'translateY(-50%)',
                            fontSize: 14, fontWeight: 600, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                            {p.toFixed(0)}
                          </div>
                        );
                      }
                      return labels;
                    })()}

                    {/* Crosshair overlay */}
                    {vpHover !== null && (
                      <div style={{ position: 'absolute', left: 0, right: 0, pointerEvents: 'none', zIndex: 10,
                        top: vpHover.y, height: 1,
                        background: 'rgba(255,255,255,0.5)', borderTop: '1px dashed rgba(255,255,255,0.6)',
                        display: 'flex', alignItems: 'center', justifyContent: 'flex-end', paddingRight: 4 }}>
                        <span style={{ background: 'var(--card-bg)', border: '1px solid var(--border-color)',
                          fontSize: 12, fontWeight: 700, color: 'var(--text-primary)',
                          padding: '1px 6px', borderRadius: 3, whiteSpace: 'nowrap', transform: 'translateY(-50%)' }}>
                          {vpHover.price.toFixed(2)}
                        </span>
                      </div>
                    )}

                    {display.map(({ price, volume }) => {
                      const pct = volume / maxVol;
                      return (
                        <div key={price} style={{ flex: '1 1 0', display: 'flex', alignItems: 'stretch',
                          cursor: vpDrag ? 'grabbing' : vpZoom ? 'grab' : 'crosshair' }}>
                          {/* Bar area — fills available width, bar grows right→left */}
                          <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
                            <div style={{ position: 'absolute', right: 0, top: 0, bottom: 0,
                              width: `${pct * 100}%`, background: 'var(--accent-purple)', opacity: 0.75 }} />
                          </div>
                          {/* Spacer matching label overlay width */}
                          <div style={{ width: 64, flexShrink: 0 }} />
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Stats */}
                <div style={{ flex: '0 0 160px' }}>
                  <div className="backtest-summary-card" style={{ padding: '12px 16px', marginBottom: 12 }}>
                    <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4 }}>Total Volume</div>
                    <div style={{ fontSize: 20, fontWeight: 700 }}>{vpData.totalVolume.toLocaleString()}</div>
                  </div>
                </div>
              </div>
            );
          })()}

          {!vpData && !vpLoading && (
            <div style={{ textAlign: 'center', color: 'var(--text-muted)', marginTop: 60, fontSize: 15 }}>
              Select a date and click Generate to build a volume profile
            </div>
          )}
        </div>
      )}

      {/* ==================== KEY LEVEL ANALYSIS SECTION ==================== */}
      {activeSection === 'keylevels' && (
        <KeyLevelBT selectedAccounts={selectedAccounts} onJumpToChart={(date) => { setChartReviewDate(date); setActiveSection('chartreview'); }} />
      )}
      {activeSection === 'edge' && <EdgeAnalysisView />}
      {activeSection === 'chartreview' && (
        <ChartReviewSection selectedAccounts={selectedAccounts} initialDate={chartReviewDate} initialLevelKey={null} />
      )}
    </div>
  );
}

// ==================== TEARSHEET VIEW ====================
function fmtDur(secs) {
  if (!secs) return '—';
  if (secs < 60) return `${Math.round(secs)}s`;
  if (secs < 3600) return `${Math.round(secs/60)}m`;
  return `${(secs/3600).toFixed(1)}h`;
}

function TearsheetView({ accounts, selectedAccounts, setSelectedAccounts }) {
  const [overview, setOverview] = useState(null);
  const [ext, setExt] = useState(null); // extended tearsheet metrics
  const [daily, setDaily] = useState([]);
  const [cumPnl, setCumPnl] = useState([]);
  const [byHour, setByHour] = useState([]);
  const [byDay, setByDay] = useState([]);
  const [bySetup, setBySetup] = useState([]);
  const [topSymbols, setTopSymbols] = useState([]);
  const [dist, setDist] = useState(null);
  const [heatmap, setHeatmap] = useState([]);
  const [rolling, setRolling] = useState([]);
  const [monthlyHeatmap, setMonthlyHeatmap] = useState([]);
  const [excursion, setExcursion] = useState(null);
  const [loading, setLoading] = useState(true);

  const account = selectedAccounts?.[0] || '';
  const accountParam = account ? `?account=${encodeURIComponent(account)}` : '';

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const [ov, ex, d, cp, h, dw, s, sym, di, hm, ro, mh, exc] = await Promise.all([
          fetch(`${API_URL}/stats/overview${accountParam}`).then(r => r.json()),
          fetch(`${API_URL}/stats/tearsheet-overview${accountParam}`).then(r => r.json()),
          fetch(`${API_URL}/stats/daily${accountParam}`).then(r => r.json()),
          fetch(`${API_URL}/stats/cumulative-pnl${accountParam}`).then(r => r.json()),
          fetch(`${API_URL}/stats/by-hour${accountParam}`).then(r => r.json()),
          fetch(`${API_URL}/stats/by-day-of-week${accountParam}`).then(r => r.json()),
          fetch(`${API_URL}/stats/by-setup${accountParam}`).then(r => r.json()),
          fetch(`${API_URL}/stats/top-symbols?limit=20${account ? '&account='+encodeURIComponent(account) : ''}`).then(r => r.json()),
          fetch(`${API_URL}/stats/pnl-distribution${accountParam}`).then(r => r.json()),
          fetch(`${API_URL}/stats/timing-heatmap${accountParam}`).then(r => r.json()),
          fetch(`${API_URL}/stats/rolling${accountParam}`).then(r => r.json()),
          fetch(`${API_URL}/stats/monthly-heatmap${accountParam}`).then(r => r.json()),
          fetch(`${API_URL}/stats/excursion${accountParam}`).then(r => r.json()),
        ]);
        setOverview(ov); setExt(ex);
        setDaily(Array.isArray(d) ? d : []);
        setCumPnl(Array.isArray(cp) ? cp : []);
        setByHour(Array.isArray(h) ? h : []);
        setByDay(Array.isArray(dw) ? dw : []);
        setBySetup(Array.isArray(s) ? s : []);
        setTopSymbols(Array.isArray(sym) ? sym : []);
        setDist(di?.buckets ? di : null);
        setHeatmap(Array.isArray(hm) ? hm : []);
        setRolling(Array.isArray(ro) ? ro : []);
        setMonthlyHeatmap(Array.isArray(mh) ? mh : []);
        setExcursion(exc?.summary ? exc : null);
      } catch (e) { console.error(e); }
      setLoading(false);
    };
    load();
  }, [account]);

  const bestDay = daily.length ? Math.max(...daily.map(d => parseFloat(d.pnl))) : 0;
  const worstDay = daily.length ? Math.min(...daily.map(d => parseFloat(d.pnl))) : 0;

  const pnlColor = (v) => parseFloat(v) >= 0 ? '#10b981' : '#ef4444';

  // Monthly heatmap grid
  const mhYears = useMemo(() => [...new Set(monthlyHeatmap.map(r => r.year))].sort(), [monthlyHeatmap]);
  const mhByKey = useMemo(() => {
    const m = {};
    monthlyHeatmap.forEach(r => { m[`${r.year}-${r.month}`] = r; });
    return m;
  }, [monthlyHeatmap]);
  const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  // Timing heatmap grid
  const hmByKey = useMemo(() => {
    const m = {};
    heatmap.forEach(r => { m[`${r.dow}-${r.hour}`] = r; });
    return m;
  }, [heatmap]);
  const hmMaxAbs = useMemo(() => Math.max(...heatmap.map(r => Math.abs(parseFloat(r.avg_pnl || 0))), 1), [heatmap]);
  const DOW_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const HOURS = Array.from({length: 14}, (_, i) => i + 7); // 7am-8pm ET covers RTH

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>Loading tearsheet...</div>;

  const tooltipStyle = { background: 'var(--card-bg)', border: '1px solid var(--border-color)', fontSize: 12 };

  return (
    <div className="tearsheet-view">
      <header className="page-header">
        <h1>Tearsheet</h1>
        {accounts.length > 1 && (
          <select className="account-select" value={account} onChange={e => setSelectedAccounts([e.target.value])}>
            {accounts.map(a => <option key={a} value={a}>{a.split('-').pop()}</option>)}
          </select>
        )}
      </header>

      {/* ── Section 1: P&L Summary ── */}
      <div className="tearsheet-section-label">P&L Summary</div>
      <div className="tearsheet-kpi-grid">
        {[
          { label: 'Total P&L', value: `$${formatNumber(overview?.total_pnl)}`, color: pnlColor(overview?.total_pnl) },
          { label: 'Gross Profit', value: `$${formatNumber(overview?.gross_profit)}`, color: '#10b981' },
          { label: 'Gross Loss', value: `-$${formatNumber(overview?.gross_loss)}`, color: '#ef4444' },
          { label: 'Best Trade', value: `$${formatNumber(overview?.best_trade)}`, color: '#10b981' },
          { label: 'Worst Trade', value: `$${formatNumber(overview?.worst_trade)}`, color: '#ef4444' },
          { label: 'Avg P&L/Trade', value: `$${formatNumber(overview?.avg_pnl)}`, color: pnlColor(overview?.avg_pnl) },
          { label: 'Avg Win', value: `$${formatNumber(overview?.avg_win)}`, color: '#10b981' },
          { label: 'Avg Loss', value: `$${formatNumber(overview?.avg_loss)}`, color: '#ef4444' },
          { label: 'Best Day', value: `$${formatNumber(bestDay)}`, color: '#10b981' },
          { label: 'Worst Day', value: `$${formatNumber(worstDay)}`, color: '#ef4444' },
          { label: 'Avg Win Day', value: ext ? `$${formatNumber(ext.avg_win_day)}` : '—', color: '#10b981' },
          { label: 'Avg Loss Day', value: ext ? `$${formatNumber(ext.avg_loss_day)}` : '—', color: '#ef4444' },
          { label: 'Max Runup', value: ext ? `$${formatNumber(ext.max_runup)}` : '—', color: '#10b981' },
        ].map(({ label, value, color }) => (
          <div key={label} className="tearsheet-kpi">
            <div className="tearsheet-kpi-label">{label}</div>
            <div className="tearsheet-kpi-value" style={color ? { color } : {}}>{value ?? '—'}</div>
          </div>
        ))}
      </div>

      {/* ── Section 2: Win/Loss Stats ── */}
      <div className="tearsheet-section-label">Win / Loss Statistics</div>
      <div className="tearsheet-kpi-grid">
        {[
          { label: 'Total Trades', value: overview?.total_trades ?? '—' },
          { label: 'Winning Trades', value: overview?.winning_trades ?? '—', color: '#10b981' },
          { label: 'Losing Trades', value: overview?.losing_trades ?? '—', color: '#ef4444' },
          { label: 'Win Rate', value: `${formatNumber(overview?.win_rate)}%` },
          { label: 'Breakeven WR', value: ext?.breakeven_wr ? `${ext.breakeven_wr}%` : '—' },
          { label: 'Profit Factor', value: formatNumber(overview?.profit_factor) },
          { label: 'Payoff Ratio', value: ext?.payoff_ratio ? formatNumber(ext.payoff_ratio, 3) : '—' },
          { label: 'Expectancy', value: ext ? `$${formatNumber(ext.expectancy)}` : '—' },
          { label: 'Win Days', value: ext?.win_days ?? '—', color: '#10b981' },
          { label: 'Loss Days', value: ext?.loss_days ?? '—', color: '#ef4444' },
          { label: '% Profitable Weeks', value: ext?.pct_profitable_weeks ? `${ext.pct_profitable_weeks}%` : '—' },
          { label: '% Profitable Months', value: ext?.pct_profitable_months ? `${ext.pct_profitable_months}%` : '—' },
          { label: 'Trading Days', value: daily.length },
          { label: 'Max Win Streak', value: overview?.longest_win_streak ?? '—', color: '#10b981' },
          { label: 'Max Loss Streak', value: overview?.longest_loss_streak ?? '—', color: '#ef4444' },
        ].map(({ label, value, color }) => (
          <div key={label} className="tearsheet-kpi">
            <div className="tearsheet-kpi-label">{label}</div>
            <div className="tearsheet-kpi-value" style={color ? { color } : {}}>{value ?? '—'}</div>
          </div>
        ))}
      </div>

      {/* ── Section 3: Risk-Adjusted Metrics ── */}
      <div className="tearsheet-section-label">Risk-Adjusted Performance</div>
      <div className="tearsheet-kpi-grid">
        {[
          { label: 'Sharpe Ratio', value: ext?.sharpe ?? '—' },
          { label: 'Sortino Ratio', value: ext?.sortino ?? '—' },
          { label: 'Calmar Ratio', value: ext?.calmar ?? '—' },
          { label: 'Omega Ratio', value: ext?.omega ?? '—' },
          { label: 'Recovery Factor', value: ext?.recovery_factor ?? '—' },
          { label: 'Ulcer Index', value: ext?.ulcer_index ?? '—' },
          { label: 'Max Drawdown', value: `$${formatNumber(overview?.max_drawdown)}`, color: '#ef4444' },
          { label: 'SQN', value: ext?.sqn ?? '—' },
          { label: 'Kelly %', value: ext?.kelly ? `${ext.kelly}%` : '—' },
        ].map(({ label, value, color }) => (
          <div key={label} className="tearsheet-kpi">
            <div className="tearsheet-kpi-label">{label}</div>
            <div className="tearsheet-kpi-value" style={color ? { color } : {}}>{value ?? '—'}</div>
          </div>
        ))}
      </div>

      {/* ── Section 4: Duration & Direction ── */}
      <div className="tearsheet-section-label">Duration &amp; Direction</div>
      <div className="tearsheet-kpi-grid">
        {[
          { label: 'Avg Duration', value: fmtDur(ext?.avg_duration_secs) },
          { label: 'Avg Win Duration', value: fmtDur(ext?.avg_win_duration_secs), color: '#10b981' },
          { label: 'Avg Loss Duration', value: fmtDur(ext?.avg_loss_duration_secs), color: '#ef4444' },
          { label: 'Shortest Trade', value: fmtDur(ext?.min_duration_secs) },
          { label: 'Longest Trade', value: fmtDur(ext?.max_duration_secs) },
          { label: 'Long Trades', value: ext?.long_count ?? '—' },
          { label: 'Short Trades', value: ext?.short_count ?? '—' },
          { label: 'Long Win Rate', value: ext?.long_win_rate ? `${ext.long_win_rate}%` : '—', color: '#10b981' },
          { label: 'Short Win Rate', value: ext?.short_win_rate ? `${ext.short_win_rate}%` : '—', color: '#10b981' },
          { label: 'Long P&L', value: ext ? `$${formatNumber(ext.long_pnl)}` : '—', color: pnlColor(ext?.long_pnl) },
          { label: 'Short P&L', value: ext ? `$${formatNumber(ext.short_pnl)}` : '—', color: pnlColor(ext?.short_pnl) },
        ].map(({ label, value, color }) => (
          <div key={label} className="tearsheet-kpi">
            <div className="tearsheet-kpi-label">{label}</div>
            <div className="tearsheet-kpi-value" style={color ? { color } : {}}>{value ?? '—'}</div>
          </div>
        ))}
      </div>

      {/* ── Section 5: Profit Concentration ── */}
      <div className="tearsheet-section-label">Profit Concentration</div>
      <div className="tearsheet-kpi-grid">
        {[
          { label: 'Top-1 Win Share', value: ext?.top1_profit_share ? `${ext.top1_profit_share}%` : '—' },
          { label: 'Top-5 Win Share', value: ext?.top5_profit_share ? `${ext.top5_profit_share}%` : '—' },
          { label: 'Top-10 Win Share', value: ext?.top10_profit_share ? `${ext.top10_profit_share}%` : '—' },
        ].map(({ label, value }) => (
          <div key={label} className="tearsheet-kpi">
            <div className="tearsheet-kpi-label">{label}</div>
            <div className="tearsheet-kpi-value">{value}</div>
          </div>
        ))}
      </div>

      {/* ── Equity Curve ── */}
      {cumPnl.length > 0 && (
        <div className="tearsheet-card">
          <h3>Equity Curve</h3>
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={cumPnl} margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis dataKey="date" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} tickFormatter={d => d?.slice(5)} />
              <YAxis tick={{ fontSize: 11, fill: 'var(--text-muted)' }} tickFormatter={v => `$${(v/1000).toFixed(1)}k`} width={58} />
              <Tooltip formatter={(v) => [`$${formatNumber(v)}`, 'Cum P&L']} contentStyle={tooltipStyle} />
              <ReferenceLine y={0} stroke="rgba(255,255,255,0.2)" />
              <Line type="monotone" dataKey="cumulative_pnl" stroke="#6366f1" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* ── Daily P&L ── */}
      {daily.length > 0 && (
        <div className="tearsheet-card">
          <h3>Daily P&L</h3>
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={daily} margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} tickFormatter={d => d?.slice(5)} />
              <YAxis tick={{ fontSize: 11, fill: 'var(--text-muted)' }} tickFormatter={v => `$${(v/1000).toFixed(1)}k`} width={58} />
              <Tooltip formatter={(v) => [`$${formatNumber(v)}`, 'P&L']} contentStyle={tooltipStyle} />
              <ReferenceLine y={0} stroke="rgba(255,255,255,0.2)" />
              <Bar dataKey="pnl" radius={[2, 2, 0, 0]}>
                {daily.map((entry, i) => <Cell key={i} fill={parseFloat(entry.pnl) >= 0 ? '#10b981' : '#ef4444'} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* ── Trade P&L Distribution ── */}
      {dist && (
        <div className="tearsheet-card">
          <h3>Trade P&L Distribution</h3>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
            Mean: <span style={{ color: pnlColor(dist.mean) }}>${formatNumber(dist.mean)}</span>
            &nbsp;&nbsp;Median: <span style={{ color: pnlColor(dist.median) }}>${formatNumber(dist.median)}</span>
          </div>
          <ResponsiveContainer width="100%" height={160}>
            <BarChart data={dist.buckets} margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis dataKey="range" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} tickFormatter={v => `$${v}`} />
              <YAxis tick={{ fontSize: 10, fill: 'var(--text-muted)' }} allowDecimals={false} width={32} />
              <Tooltip formatter={(v, n, p) => [v, 'Trades']} labelFormatter={v => `$${v} to $${+v+50}`} contentStyle={tooltipStyle} />
              <Bar dataKey="count" radius={[2, 2, 0, 0]}>
                {dist.buckets.map((e, i) => <Cell key={i} fill={e.range >= 0 ? '#10b981' : '#ef4444'} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* ── Rolling 20-Trade Metrics ── */}
      {rolling.length > 0 && (
        <div className="tearsheet-card">
          <h3>Rolling 20-Trade Expectancy &amp; Win Rate</h3>
          <ResponsiveContainer width="100%" height={180}>
            <ComposedChart data={rolling} margin={{ top: 4, right: 40, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis dataKey="index" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} tickFormatter={v => `T${v}`} />
              <YAxis yAxisId="exp" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} tickFormatter={v => `$${v}`} width={52} />
              <YAxis yAxisId="wr" orientation="right" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} tickFormatter={v => `${v}%`} width={38} domain={[0,100]} />
              <Tooltip contentStyle={tooltipStyle} formatter={(v, n) => n === 'win_rate' ? [`${v}%`, 'Win Rate'] : [`$${formatNumber(v)}`, 'Expectancy']} />
              <ReferenceLine yAxisId="exp" y={0} stroke="rgba(255,255,255,0.2)" />
              <Bar yAxisId="exp" dataKey="expectancy" radius={[1,1,0,0]}>
                {rolling.map((e, i) => <Cell key={i} fill={e.expectancy >= 0 ? 'rgba(99,102,241,0.6)' : 'rgba(239,68,68,0.6)'} />)}
              </Bar>
              <Line yAxisId="wr" type="monotone" dataKey="win_rate" stroke="#f59e0b" strokeWidth={2} dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* ── Monthly Heatmap ── */}
      {monthlyHeatmap.length > 0 && (
        <div className="tearsheet-card">
          <h3>Monthly Return Heatmap</h3>
          <div className="tearsheet-heatmap-scroll">
            <table className="tearsheet-heatmap-table">
              <thead>
                <tr>
                  <th>Year</th>
                  {MONTH_NAMES.map(m => <th key={m}>{m}</th>)}
                  <th>Total</th>
                </tr>
              </thead>
              <tbody>
                {mhYears.map(yr => {
                  const yearTotal = MONTH_NAMES.reduce((s, _, i) => {
                    const cell = mhByKey[`${yr}-${i+1}`];
                    return s + (cell ? parseFloat(cell.pnl) : 0);
                  }, 0);
                  return (
                    <tr key={yr}>
                      <td style={{ fontWeight: 600, color: 'var(--text-muted)', fontSize: 12 }}>{yr}</td>
                      {MONTH_NAMES.map((_, i) => {
                        const cell = mhByKey[`${yr}-${i+1}`];
                        const v = cell ? parseFloat(cell.pnl) : null;
                        const bg = v === null ? 'transparent' : v > 0 ? `rgba(16,185,129,${Math.min(0.9, 0.15 + Math.abs(v)/2000)})` : `rgba(239,68,68,${Math.min(0.9, 0.15 + Math.abs(v)/2000)})`;
                        return (
                          <td key={i} style={{ background: bg, textAlign: 'right', fontSize: 12, padding: '4px 8px' }}
                            title={cell ? `${cell.trading_days}d, ${cell.win_days}W` : ''}>
                            {v !== null ? `$${(v/1000).toFixed(1)}k` : ''}
                          </td>
                        );
                      })}
                      <td style={{ fontWeight: 700, textAlign: 'right', fontSize: 12, color: pnlColor(yearTotal) }}>
                        ${(yearTotal/1000).toFixed(1)}k
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Timing Heatmap ── */}
      {heatmap.length > 0 && (
        <div className="tearsheet-card">
          <h3>Timing Heatmap — Avg P&L by Day &amp; Hour (ET)</h3>
          <div className="tearsheet-heatmap-scroll">
            <table className="tearsheet-heatmap-table">
              <thead>
                <tr>
                  <th></th>
                  {HOURS.map(h => <th key={h} style={{ fontSize: 10 }}>{h}:00</th>)}
                </tr>
              </thead>
              <tbody>
                {[1,2,3,4,5].map(dow => (
                  <tr key={dow}>
                    <td style={{ fontWeight: 600, color: 'var(--text-muted)', fontSize: 12 }}>{DOW_NAMES[dow]}</td>
                    {HOURS.map(h => {
                      const cell = hmByKey[`${dow}-${h}`];
                      const v = cell ? parseFloat(cell.avg_pnl) : null;
                      const intensity = v !== null ? Math.min(0.9, 0.15 + Math.abs(v) / hmMaxAbs * 0.75) : 0;
                      const bg = v === null ? 'transparent' : v > 0 ? `rgba(16,185,129,${intensity})` : `rgba(239,68,68,${intensity})`;
                      return (
                        <td key={h} style={{ background: bg, textAlign: 'right', fontSize: 11, padding: '4px 6px' }}
                          title={cell ? `${cell.trade_count} trades, total $${formatNumber(cell.total_pnl)}` : 'No trades'}>
                          {v !== null ? `$${formatNumber(v, 0)}` : ''}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="tearsheet-row">
        {/* By Hour */}
        {byHour.length > 0 && (
          <div className="tearsheet-card" style={{ flex: 1 }}>
            <h3>Total P&L by Hour (ET)</h3>
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={byHour} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                <XAxis dataKey="hour" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} tickFormatter={h => `${h}:00`} />
                <YAxis tick={{ fontSize: 10, fill: 'var(--text-muted)' }} tickFormatter={v => `$${(v/1000).toFixed(1)}k`} width={48} />
                <Tooltip formatter={(v) => [`$${formatNumber(v)}`, 'P&L']} contentStyle={tooltipStyle} />
                <ReferenceLine y={0} stroke="rgba(255,255,255,0.2)" />
                <Bar dataKey="total_pnl" radius={[2, 2, 0, 0]}>
                  {byHour.map((e, i) => <Cell key={i} fill={parseFloat(e.total_pnl) >= 0 ? '#10b981' : '#ef4444'} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* By Day of Week */}
        {byDay.length > 0 && (
          <div className="tearsheet-card" style={{ flex: 1 }}>
            <h3>P&L by Day of Week</h3>
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={byDay} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                <XAxis dataKey="day_name" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
                <YAxis tick={{ fontSize: 10, fill: 'var(--text-muted)' }} tickFormatter={v => `$${(v/1000).toFixed(1)}k`} width={48} />
                <Tooltip formatter={(v) => [`$${formatNumber(v)}`, 'P&L']} contentStyle={tooltipStyle} />
                <ReferenceLine y={0} stroke="rgba(255,255,255,0.2)" />
                <Bar dataKey="total_pnl" radius={[2, 2, 0, 0]}>
                  {byDay.map((e, i) => <Cell key={i} fill={parseFloat(e.total_pnl) >= 0 ? '#10b981' : '#ef4444'} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* ── MFE / MAE / Execution Efficiency ── */}
      {excursion && (
        <>
          <div className="tearsheet-section-label">Excursion &amp; Execution Efficiency
            <span style={{ fontWeight: 400, textTransform: 'none', marginLeft: 8, fontSize: 10 }}>
              (per-fill — reflects individual fill excursions; multi-contract scaling uses fill-level MFE/MAE)
            </span>
          </div>
          <div className="tearsheet-kpi-grid">
            {[
              { label: 'Avg MFE', value: `$${formatNumber(excursion.summary.avg_mfe)}`, color: '#10b981' },
              { label: 'MFE P50', value: `$${formatNumber(excursion.summary.mfe_p50)}`, color: '#10b981' },
              { label: 'MFE P75', value: `$${formatNumber(excursion.summary.mfe_p75)}`, color: '#10b981' },
              { label: 'MFE P90', value: `$${formatNumber(excursion.summary.mfe_p90)}`, color: '#10b981' },
              { label: 'MFE Capture %', value: excursion.summary.avg_mfe_capture ? `${excursion.summary.avg_mfe_capture}%` : '—' },
              { label: 'Avg MAE', value: `$${formatNumber(excursion.summary.avg_mae)}`, color: '#ef4444' },
              { label: 'MAE P50', value: `$${formatNumber(excursion.summary.mae_p50)}`, color: '#ef4444' },
              { label: 'MAE P75', value: `$${formatNumber(excursion.summary.mae_p75)}`, color: '#ef4444' },
              { label: 'MAE P90', value: `$${formatNumber(excursion.summary.mae_p90)}`, color: '#ef4444' },
              { label: 'Avg Entry Efficiency', value: excursion.summary.avg_entry_eff ? `${excursion.summary.avg_entry_eff}%` : '—' },
              { label: 'Avg Exit Efficiency', value: excursion.summary.avg_exit_eff ? `${excursion.summary.avg_exit_eff}%` : '—' },
              { label: 'Avg Total Efficiency', value: excursion.summary.avg_total_eff ? `${excursion.summary.avg_total_eff}%` : '—' },
              { label: 'Fills with Data', value: excursion.summary.n },
            ].map(({ label, value, color }) => (
              <div key={label} className="tearsheet-kpi">
                <div className="tearsheet-kpi-label">{label}</div>
                <div className="tearsheet-kpi-value" style={color ? { color } : {}}>{value ?? '—'}</div>
              </div>
            ))}
          </div>

          <div className="tearsheet-row">
            {/* MFE vs MAE scatter */}
            {excursion.scatter.length > 0 && (
              <div className="tearsheet-card" style={{ flex: 2 }}>
                <h3>MFE vs MAE Scatter (colored by P&L)</h3>
                <ResponsiveContainer width="100%" height={220}>
                  <ComposedChart margin={{ top: 8, right: 16, bottom: 20, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                    <XAxis dataKey="mfe" name="MFE" type="number" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} label={{ value: 'MFE ($)', position: 'insideBottom', offset: -8, fontSize: 11, fill: 'var(--text-muted)' }} />
                    <YAxis dataKey="mae" name="MAE" type="number" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} label={{ value: 'MAE ($)', angle: -90, position: 'insideLeft', fontSize: 11, fill: 'var(--text-muted)' }} width={52} />
                    <Tooltip contentStyle={{ background: 'var(--card-bg)', border: '1px solid var(--border-color)', fontSize: 12 }}
                      formatter={(v, n) => [`$${formatNumber(v)}`, n === 'mfe' ? 'MFE' : n === 'mae' ? 'MAE' : 'P&L']} />
                    <Scatter data={excursion.scatter} fill="#6366f1">
                      {excursion.scatter.map((e, i) => <Cell key={i} fill={e.pnl >= 0 ? 'rgba(16,185,129,0.6)' : 'rgba(239,68,68,0.6)'} />)}
                    </Scatter>
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Entry efficiency distribution */}
            {excursion.entry_eff_dist && (
              <div className="tearsheet-card" style={{ flex: 1 }}>
                <h3>Entry Efficiency Distribution</h3>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={excursion.entry_eff_dist} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                    <XAxis dataKey="range" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} tickFormatter={v => `${v}%`} />
                    <YAxis tick={{ fontSize: 10, fill: 'var(--text-muted)' }} allowDecimals={false} width={32} />
                    <Tooltip contentStyle={{ background: 'var(--card-bg)', border: '1px solid var(--border-color)', fontSize: 12 }}
                      formatter={(v) => [v, 'Trades']} labelFormatter={v => `${v}–${+v+10}%`} />
                    <Bar dataKey="count" fill="#6366f1" radius={[2,2,0,0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Exit efficiency distribution */}
            {excursion.exit_eff_dist && (
              <div className="tearsheet-card" style={{ flex: 1 }}>
                <h3>Exit Efficiency Distribution</h3>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={excursion.exit_eff_dist} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                    <XAxis dataKey="range" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} tickFormatter={v => `${v}%`} />
                    <YAxis tick={{ fontSize: 10, fill: 'var(--text-muted)' }} allowDecimals={false} width={32} />
                    <Tooltip contentStyle={{ background: 'var(--card-bg)', border: '1px solid var(--border-color)', fontSize: 12 }}
                      formatter={(v) => [v, 'Trades']} labelFormatter={v => `${v}–${+v+10}%`} />
                    <Bar dataKey="count" fill="#f59e0b" radius={[2,2,0,0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>
        </>
      )}

      {/* ── Monthly Breakdown Table ── */}
      {monthlyHeatmap.length > 0 && (
        <div className="tearsheet-card">
          <h3>Monthly Breakdown</h3>
          <table className="tearsheet-table">
            <thead>
              <tr><th>Month</th><th>P&L</th><th>Trading Days</th><th>Win Days</th><th>Day Win%</th></tr>
            </thead>
            <tbody>
              {monthlyHeatmap.map(m => (
                <tr key={`${m.year}-${m.month}`}>
                  <td>{MONTH_NAMES[m.month-1]} {m.year}</td>
                  <td style={{ color: pnlColor(m.pnl), fontWeight: 600 }}>${formatNumber(m.pnl)}</td>
                  <td>{m.trading_days}</td>
                  <td>{m.win_days}</td>
                  <td>{m.trading_days > 0 ? formatNumber(m.win_days / m.trading_days * 100, 0) : 0}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="tearsheet-row">
        {/* Top Symbols */}
        {topSymbols.length > 0 && (
          <div className="tearsheet-card" style={{ flex: 1 }}>
            <h3>By Symbol</h3>
            <table className="tearsheet-table">
              <thead><tr><th>Symbol</th><th>P&L</th><th>Trades</th><th>Win%</th><th>Avg P&L</th></tr></thead>
              <tbody>
                {topSymbols.map(s => (
                  <tr key={s.symbol}>
                    <td><strong>{s.symbol}</strong></td>
                    <td style={{ color: pnlColor(s.total_pnl), fontWeight: 600 }}>${formatNumber(s.total_pnl)}</td>
                    <td>{s.trade_count}</td>
                    <td>{formatNumber(s.win_rate)}%</td>
                    <td style={{ color: pnlColor(s.avg_pnl) }}>${formatNumber(s.avg_pnl)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* By Setup */}
        {bySetup.length > 0 && (
          <div className="tearsheet-card" style={{ flex: 1 }}>
            <h3>By Setup</h3>
            <table className="tearsheet-table">
              <thead><tr><th>Setup</th><th>P&L</th><th>Trades</th><th>Win%</th><th>Avg P&L</th></tr></thead>
              <tbody>
                {bySetup.map(s => (
                  <tr key={s.setup_type || 'None'}>
                    <td>{s.setup_type || <em style={{ color: 'var(--text-muted)' }}>None</em>}</td>
                    <td style={{ color: pnlColor(s.total_pnl), fontWeight: 600 }}>${formatNumber(s.total_pnl)}</td>
                    <td>{s.trade_count}</td>
                    <td>{formatNumber(s.win_rate)}%</td>
                    <td style={{ color: pnlColor(s.avg_pnl) }}>${formatNumber(s.avg_pnl)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ==================== ACD COMPONENTS ====================

const NL_TREND_COLOR = { TRENDING_UP: '#22c55e', TRENDING_DOWN: '#ef4444', RANGING: '#fbbf24' };
const NL_TREND_LABEL = { TRENDING_UP: 'TRENDING UP', TRENDING_DOWN: 'TRENDING DOWN', RANGING: 'RANGING' };
const NL_BIAS_TEXT   = { TRENDING_UP: 'LONG — go with A Up signals', TRENDING_DOWN: 'SHORT — go with A Down signals', RANGING: 'Day trade only, no overnight holds' };

function ACDNumberLineWidget({ nl }) {
  if (!nl) return null;
  const { sum30, sum10, trend, quality, momentumWarning, history } = nl;
  const color = NL_TREND_COLOR[trend] || '#94a3b8';
  const barPct30 = Math.min(100, Math.abs(sum30) / 20 * 100);
  const barPct10 = Math.min(100, Math.abs(sum10) / 10 * 100);
  const barColor30 = sum30 > 0 ? '#22c55e' : sum30 < 0 ? '#ef4444' : '#94a3b8';
  const barColor10 = sum10 > 0 ? '#22c55e' : sum10 < 0 ? '#ef4444' : '#94a3b8';

  // MAH/MAL: Monthly A High/Low condition — NL30 at or beyond ±20 (extreme, fade signals)
  const mahActive = Math.abs(sum30) >= 20;
  const mahLabel  = sum30 >= 20 ? 'MAH — extreme long, fade breakouts' : 'MAL — extreme short, fade breakdowns';

  const scoreColor = (s) => s > 0 ? '#22c55e' : s < 0 ? '#ef4444' : '#475569';
  const scoreLabel = (s) => { if (s === 4) return '+4'; if (s === 1) return '+1'; if (s === 0) return '0'; if (s === -1) return '-1'; return '-4'; };

  return (
    <div style={{ background: 'var(--card-bg)', border: `2px solid ${color}`, borderRadius: 12, padding: '20px 24px', minWidth: 300, flex: 1 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 14, letterSpacing: '0.05em', textTransform: 'uppercase' }}>ACD Number Line</div>

      <div style={{ marginBottom: mahActive ? 4 : 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}>
          <span style={{ color: 'var(--text-muted)' }}>30-Day Sum</span>
          <span style={{ fontFamily: 'monospace', fontWeight: 700, color: mahActive ? '#f59e0b' : barColor30 }}>{sum30 > 0 ? '+' : ''}{sum30}</span>
        </div>
        {/* Bar with amber overlay when MAH/MAL active */}
        <div style={{ position: 'relative', height: 8, background: 'var(--border-color)', borderRadius: 4, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${barPct30}%`, background: mahActive ? '#f59e0b' : barColor30, borderRadius: 4 }} />
          {/* MAH threshold tick at 100% position */}
          {mahActive && <div style={{ position: 'absolute', right: 0, top: 0, width: 2, height: '100%', background: '#f59e0b' }} />}
        </div>
        {/* MAH/MAL amber annotation line */}
        {mahActive && (
          <div style={{ marginTop: 4, marginBottom: 6, fontSize: 11, color: '#f59e0b', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4 }}>
            <div style={{ width: 16, height: 2, background: '#f59e0b', borderRadius: 1, flexShrink: 0 }} />
            {mahLabel}
          </div>
        )}
      </div>

      <div style={{ marginBottom: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}>
          <span style={{ color: 'var(--text-muted)' }}>10-Day Sum</span>
          <span style={{ fontFamily: 'monospace', fontWeight: 700, color: barColor10 }}>{sum10 > 0 ? '+' : ''}{sum10}</span>
        </div>
        <div style={{ height: 6, background: 'var(--border-color)', borderRadius: 4, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${barPct10}%`, background: barColor10, borderRadius: 4 }} />
        </div>
      </div>

      <div style={{ marginBottom: 8 }}>
        <div style={{ fontWeight: 700, fontSize: 15, color }}>{NL_TREND_LABEL[trend]}</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{NL_BIAS_TEXT[trend]}</div>
      </div>

      {momentumWarning && (
        <div style={{ padding: '6px 10px', background: 'rgba(251,191,36,0.1)', border: '1px solid #fbbf24', borderRadius: 6, fontSize: 12, color: '#fbbf24', marginBottom: 10 }}>
          {momentumWarning}
        </div>
      )}

      {history?.length > 0 && (
        <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border-color)' }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>Last {Math.min(10, history.length)} days</div>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {history.slice(-10).map((d, i) => (
              <div key={i} style={{ textAlign: 'center', minWidth: 26 }}>
                <div style={{ fontSize: 11, fontWeight: 700, fontFamily: 'monospace', color: scoreColor(d.daily_score) }}>{scoreLabel(d.daily_score)}</div>
                <div style={{ width: 22, height: Math.abs(d.daily_score) * 5 + 4, background: scoreColor(d.daily_score), borderRadius: 2, margin: '2px auto', opacity: 0.8 }} />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ACDSessionState({ todayData, nl, pivot }) {
  const [orHigh, setOrHigh] = React.useState('');
  const [orLow, setOrLow] = React.useState('');
  const [nqLive, setNqLive] = React.useState(null);
  const [context, setContext] = React.useState(null);
  const [liveSetup, setLiveSetup] = React.useState(null);

  React.useEffect(() => {
    if (todayData?.today?.or_high) setOrHigh(String(todayData.today.or_high));
    if (todayData?.today?.or_low)  setOrLow(String(todayData.today.or_low));
  }, [todayData]);

  React.useEffect(() => {
    const load = () => fetch(`${API_URL}/acd/nq/latest`).then(r => r.json()).then(setNqLive).catch(() => {});
    load();
    const iv = setInterval(load, 60000);
    return () => clearInterval(iv);
  }, []);

  React.useEffect(() => {
    fetch(`${API_URL}/acd/context`)
      .then(r => r.json())
      .then(d => { if (d && d.vah) setContext(d); })
      .catch(() => {});
  }, []);

  React.useEffect(() => {
    const load = () => fetch(`${API_URL}/acd/live`)
      .then(r => r.json())
      .then(d => { if (d && !d.error) setLiveSetup(d); })
      .catch(() => {});
    load();
    const iv = setInterval(load, 30000); // refresh every 30 seconds
    return () => clearInterval(iv);
  }, []);

  if (!todayData) return null;
  const { today, aMultiplier, systemFailureWarning } = todayData;

  const orRange  = orHigh && orLow ? parseFloat(orHigh) - parseFloat(orLow) : null;
  const aUpCalc  = orRange ? (parseFloat(orHigh) + orRange * aMultiplier).toFixed(2) : '—';
  const aDownCalc = orRange ? (parseFloat(orLow)  - orRange * aMultiplier).toFixed(2) : '—';

  const trend = nl?.trend || 'RANGING';
  const pivotBias = pivot ? '(pivot not set)' : null;

  // Confluence determination
  let confluenceLevel = null;
  let confluenceColor = '#94a3b8';
  if (today?.a_up_fired && trend === 'TRENDING_UP') {
    confluenceLevel = 'FULL CONFLUENCE — A Up + Trending + Above Pivot';
    confluenceColor = '#22c55e';
  } else if (today?.a_up_fired && trend === 'RANGING') {
    confluenceLevel = 'A Up fired — number line RANGING, day trade only';
    confluenceColor = '#fbbf24';
  } else if (today?.a_up_fired && trend === 'TRENDING_DOWN') {
    confluenceLevel = 'A Up fired COUNTER to number line — low conviction, caution';
    confluenceColor = '#ef4444';
  } else if (today?.a_down_fired && trend === 'TRENDING_DOWN') {
    confluenceLevel = 'FULL CONFLUENCE — A Down + Trending Down + Below Pivot';
    confluenceColor = '#22c55e';
  } else if (today?.a_down_fired) {
    confluenceLevel = `A Down fired — number line ${NL_TREND_LABEL[trend]}, ${trend === 'RANGING' ? 'day trade only' : 'counter-trend, caution'}`;
    confluenceColor = trend === 'RANGING' ? '#fbbf24' : '#ef4444';
  }

  return (
    <div style={{ background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderRadius: 12, padding: '20px 24px', flex: 1 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 14, letterSpacing: '0.05em', textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: 4 }}>
        ACD Session State
        <InfoTooltip text="This is your pre-session preparation card — Sierra Chart is your execution tool.&#10;&#10;Night before / pre-market: Check the NL bias and pivot position to frame the session mentally.&#10;&#10;9:30–9:35: OR levels auto-fill from your bar data. Write down the A Up and A Down levels — these are the only two prices that matter for the next 90 minutes.&#10;&#10;9:35–10:15: Watch Sierra Chart, not this card. Wait for price to touch and sustain the A level for 5 minutes. That is your entry signal.&#10;&#10;After 11 AM: The confluence banner confirms whether today's signal had full conviction or was counter-trend.&#10;&#10;System failure warning: If an A signal from 2–3 days ago never got C confirmation, exit immediately regardless of your stop." />
      </div>

      {/* Live setup banner — refreshes every 30 seconds */}
      {liveSetup && liveSetup.setup && (
        <div style={{ marginBottom: 12, padding: '10px 14px', background: `${liveSetup.color}18`, border: `2px solid ${liveSetup.color}`, borderRadius: 9 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <span style={{ fontWeight: 700, fontSize: 14, color: liveSetup.color }}>
              {(() => {
                const s = liveSetup.setup;
                const tl = liveSetup.timeline || [];
                const hasFailedUp   = tl.some(e => e.event?.startsWith('Failed A Up'));
                const hasFailedDown = tl.some(e => e.event?.startsWith('Failed A Down'));
                if (s === 'C Up (no A)')   return hasFailedDown ? 'C Reversal (long)' : 'C Standalone (long)';
                if (s === 'C Down (no A)') return hasFailedUp   ? 'C Reversal (short)' : 'C Standalone (short)';
                return s;
              })()}
            </span>
            <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'monospace' }}>
              {liveSetup.currentPrice?.toFixed(2)} · updated {liveSetup.barTime} ET
              {(() => { const f = liveSetup.timeline?.find(e => e.event === 'A Up fired' || e.event === 'A Down fired'); return f ? ` · signal fired ${f.time} ET` : ''; })()}
            </span>
          </div>
          <div style={{ fontSize: 12, color: '#e2e8f0', lineHeight: 1.5 }}>{liveSetup.description}</div>
          {liveSetup.setup !== 'No signal' && (
            <div style={{ display: 'flex', gap: 12, marginTop: 8, fontSize: 11, color: 'var(--text-muted)' }}>
              <span>Session H: <strong style={{ color: '#22c55e', fontFamily: 'monospace' }}>{liveSetup.sessionHigh?.toFixed(2)}</strong></span>
              <span>Session L: <strong style={{ color: '#ef4444', fontFamily: 'monospace' }}>{liveSetup.sessionLow?.toFixed(2)}</strong></span>
              <span>{liveSetup.barsAnalyzed} bars analyzed</span>
            </div>
          )}
        </div>
      )}

      <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>OR High</div>
          <input type="number" value={orHigh} onChange={e => setOrHigh(e.target.value)} placeholder="OR High"
            style={{ background: 'var(--input-bg)', border: '1px solid var(--border-color)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 13, padding: '5px 10px', width: 100 }} />
        </div>
        <div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>OR Low</div>
          <input type="number" value={orLow} onChange={e => setOrLow(e.target.value)} placeholder="OR Low"
            style={{ background: 'var(--input-bg)', border: '1px solid var(--border-color)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 13, padding: '5px 10px', width: 100 }} />
        </div>
      </div>

      <div style={{ display: 'flex', gap: 12, marginBottom: 14, padding: '10px 14px', background: 'rgba(59,130,246,0.08)', borderRadius: 8, border: '1px solid rgba(59,130,246,0.2)', flexWrap: 'wrap', alignItems: 'flex-start' }}>
        {/* A levels */}
        <div style={{ textAlign: 'center', minWidth: 70 }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>A Up Level</div>
          <div style={{ fontSize: 18, fontWeight: 700, fontFamily: 'monospace', color: '#22c55e' }}>{aUpCalc}</div>
        </div>
        <div style={{ textAlign: 'center', minWidth: 70 }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>A Down Level</div>
          <div style={{ fontSize: 18, fontWeight: 700, fontFamily: 'monospace', color: '#ef4444' }}>{aDownCalc}</div>
        </div>
        {orRange && (
          <div style={{ textAlign: 'center', minWidth: 50 }}>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>OR Range</div>
            <div style={{ fontSize: 18, fontWeight: 700, fontFamily: 'monospace', color: '#94a3b8' }}>{orRange.toFixed(0)}</div>
          </div>
        )}
        {/* Divider */}
        {context && <div style={{ width: 1, background: 'rgba(100,116,139,0.3)', alignSelf: 'stretch', margin: '0 4px' }} />}
        {/* Prior day value area inline */}
        {context && [['VAH', context.vah, '#22c55e'], ['POC', context.poc, '#94a3b8'], ['VAL', context.val, '#ef4444']].map(([label, price, color]) => {
              const aUp = orHigh && orLow ? parseFloat(orHigh) + (parseFloat(orHigh) - parseFloat(orLow)) * (aMultiplier || 0.33) : null;
              const nqPrice = nqLive?.close;
              return (
                <div key={label} style={{ textAlign: 'center', minWidth: 65 }}>
                  <div style={{ fontSize: 11, color, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3 }}>
                    {label}
                    {label === 'VAH' && <InfoTooltip text="Prior day's RTH value area — where 70% of yesterday's volume traded.&#10;&#10;VAH: Value Area High — NQ above = above accepted value&#10;POC: Point of Control — highest volume price, key magnet&#10;VAL: Value Area Low — NQ below = below accepted value&#10;&#10;A Up above VAH = breaking out of accepted value (stronger signal). A Up inside VA = weaker signal." />}
                  </div>
                  <div style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: 15, color }}>{price ? parseFloat(price).toFixed(2) : '—'}</div>
                  {nqPrice && label === 'VAH' && price && (
                    <div style={{ fontSize: 9, color: parseFloat(nqPrice) > parseFloat(price) ? '#22c55e' : '#94a3b8', marginTop: 1 }}>
                      {parseFloat(nqPrice) > parseFloat(price) ? 'NQ above ▲' : 'NQ below ▼'}
                    </div>
                  )}
                  {aUp && label === 'VAH' && price && (
                    <div style={{ fontSize: 9, color: aUp > parseFloat(price) ? '#3b82f6' : '#fbbf24', marginTop: 1 }}>
                      {aUp > parseFloat(price) ? 'A Up above ✓' : 'A Up inside VA'}
                    </div>
                  )}
                </div>
              );
            })}
      </div>

      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Number Line: <span style={{ color: NL_TREND_COLOR[trend], fontWeight: 700 }}>{NL_TREND_LABEL[trend]}</span></div>
        {nqLive && (
          <div style={{ display: 'flex', gap: 14, marginTop: 6, padding: '8px 12px', background: 'rgba(59,130,246,0.07)', borderRadius: 7, border: '1px solid rgba(59,130,246,0.15)' }}>
            <div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>NQ Last</div>
              <div style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: 16, color: 'var(--text-primary)' }}>{parseFloat(nqLive.close).toFixed(2)}</div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{nqLive.barAgeMinutes}m ago</div>
            </div>
            {nqLive.pivot && (() => {
              const px   = parseFloat(nqLive.close);
              const pvt  = parseFloat(nqLive.pivot.pivot_level);
              const r1   = parseFloat(nqLive.pivot.pivot_r1);
              const s1   = parseFloat(nqLive.pivot.pivot_s1);
              // Zone: ABOVE_R1 / INSIDE (between S1 and R1) / BELOW_S1
              const zone = px >= r1 ? 'ABOVE_R1' : px <= s1 ? 'BELOW_S1' : 'INSIDE';
              const zoneLabel = zone === 'ABOVE_R1' ? 'ABOVE R1' : zone === 'BELOW_S1' ? 'BELOW S1' : 'INSIDE ZONE';
              const zoneColor = zone === 'ABOVE_R1' ? '#22c55e' : zone === 'BELOW_S1' ? '#ef4444' : '#f59e0b';
              const zoneBg    = zone === 'ABOVE_R1' ? 'rgba(34,197,94,0.1)' : zone === 'BELOW_S1' ? 'rgba(239,68,68,0.1)' : 'rgba(245,158,11,0.1)';
              return (
                <>
                  <div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>Pivot / R1 / S1</div>
                    <div style={{ fontFamily: 'monospace', fontWeight: 600, fontSize: 12, color: '#22c55e' }}>{r1.toFixed(0)}</div>
                    <div style={{ fontFamily: 'monospace', fontWeight: 600, fontSize: 11, color: 'var(--text-muted)' }}>{pvt.toFixed(0)}</div>
                    <div style={{ fontFamily: 'monospace', fontWeight: 600, fontSize: 12, color: '#ef4444' }}>{s1.toFixed(0)}</div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center' }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: zoneColor, padding: '3px 8px', borderRadius: 5, background: zoneBg }}>
                      {zoneLabel}
                    </span>
                  </div>
                </>
              );
            })()}
          </div>
        )}
      </div>

      {confluenceLevel && (
        <div style={{ padding: '8px 12px', background: `${confluenceColor}20`, border: `1px solid ${confluenceColor}`, borderRadius: 7, fontSize: 13, fontWeight: 700, color: confluenceColor }}>
          {confluenceLevel}
        </div>
      )}

      {systemFailureWarning && (
        <div style={{ marginTop: 10, padding: '8px 12px', background: 'rgba(249,115,22,0.1)', border: '1px solid #f97316', borderRadius: 7, fontSize: 12, color: '#f97316' }}>
          {systemFailureWarning}
        </div>
      )}
    </div>
  );
}

function ACDDailyInput({ onSaved, defaultDate }) {
  const today = defaultDate || new Date().toLocaleDateString('en-CA');
  const [form, setForm] = React.useState({
    trade_date: today, or_high: '', or_low: '', a_multiplier: 0.33,
    signal: '0', session_close: '', notes: '', profile_shape: null,
  });
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const handleSave = async () => {
    setSaving(true);
    const signalMap = { '4': [true, false, true, false], '1': [true, false, false, false], '0': [false, false, false, false], '-1': [false, true, false, false], '-4': [false, true, false, true] };
    const [a_up, a_down, c_up, c_down] = signalMap[form.signal] || [false, false, false, false];
    try {
      await fetch(`${API_URL}/acd/daily`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trade_date: form.trade_date, or_high: form.or_high || null, or_low: form.or_low || null, a_multiplier: form.a_multiplier, a_up_fired: a_up, a_down_fired: a_down, c_up_confirmed: c_up, c_down_confirmed: c_down, session_close: form.session_close || null, notes: form.notes, profile_shape: form.profile_shape || null }),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
      if (onSaved) onSaved();
    } catch(e) { console.error(e); }
    setSaving(false);
  };

  const inputStyle = { background: 'var(--input-bg)', border: '1px solid var(--border-color)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 13, padding: '6px 10px' };

  return (
    <div style={{ background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderRadius: 12, padding: '20px 24px' }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 14, letterSpacing: '0.05em', textTransform: 'uppercase' }}>Log Today's ACD</div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        <div><div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 3 }}>Date</div>
          <input type="date" value={form.trade_date} onChange={e => set('trade_date', e.target.value)} style={{ ...inputStyle, width: 140 }} />
        </div>
        <div><div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 3 }}>OR High</div>
          <input type="number" value={form.or_high} onChange={e => set('or_high', e.target.value)} placeholder="OR High" style={{ ...inputStyle, width: 90 }} />
        </div>
        <div><div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 3 }}>OR Low</div>
          <input type="number" value={form.or_low} onChange={e => set('or_low', e.target.value)} placeholder="OR Low" style={{ ...inputStyle, width: 90 }} />
        </div>
        <div><div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 3 }}>A Multiplier</div>
          <input type="number" step="0.01" value={form.a_multiplier} onChange={e => set('a_multiplier', parseFloat(e.target.value))} style={{ ...inputStyle, width: 80 }} />
        </div>
        <div><div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 3 }}>Session Close</div>
          <input type="number" value={form.session_close} onChange={e => set('session_close', e.target.value)} placeholder="Close" style={{ ...inputStyle, width: 90 }} />
        </div>
      </div>

      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>What happened today?</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {[['4', '+4  A Up + C Up confirmed'], ['1', '+1  A Up only'], ['0', ' 0  No signal'], ['-1', '-1  A Down only'], ['-4', '-4  A Down + C Down']].map(([val, label]) => (
            <label key={val} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, color: form.signal === val ? 'var(--text-primary)' : 'var(--text-muted)' }}>
              <input type="radio" name="acd_signal" value={val} checked={form.signal === val} onChange={() => set('signal', val)} />
              <span style={{ fontFamily: 'monospace' }}>{label}</span>
            </label>
          ))}
        </div>
      </div>

      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>Profile Shape <span style={{ color: '#475569' }}>(tap after session — leave blank if unsure)</span></div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {[['ELONGATED','Elongated','#f97316'],['FAT','Fat / Balanced','#3b82f6'],['SQUAT','Squat','#fbbf24'],['NONSYMMETRIC_TOP','Top Heavy','#a78bfa'],['NONSYMMETRIC_BOTTOM','Bottom Heavy','#ec4899']].map(([val, label, color]) => (
            <button key={val} onClick={() => set('profile_shape', form.profile_shape === val ? null : val)}
              style={{ padding: '4px 10px', fontSize: 11, borderRadius: 5, cursor: 'pointer', fontWeight: 600, border: `1px solid ${form.profile_shape === val ? color : 'var(--border-color)'}`, background: form.profile_shape === val ? `${color}20` : 'var(--input-bg)', color: form.profile_shape === val ? color : 'var(--text-muted)' }}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 3 }}>Notes</div>
        <textarea value={form.notes} onChange={e => set('notes', e.target.value)} rows={2} placeholder="Optional notes..."
          style={{ ...inputStyle, width: '100%', resize: 'vertical', fontFamily: 'inherit' }} />
      </div>

      <button onClick={handleSave} disabled={saving}
        style={{ width: '100%', padding: '9px', background: saved ? '#22c55e' : '#3b82f6', border: 'none', borderRadius: 7, color: '#fff', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
        {saved ? 'Saved!' : saving ? 'Saving…' : 'Log Today\'s ACD'}
      </button>
    </div>
  );
}

function ACDDailyLogTable({ logs }) {
  if (!logs?.length) return <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: 16 }}>No ACD logs yet. Use the form above to start logging.</div>;
  const scoreColor = s => s > 0 ? '#22c55e' : s < 0 ? '#ef4444' : '#475569';
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ borderBottom: '2px solid var(--border-color)' }}>
            {['Date', 'OR High', 'OR Low', 'A Up', 'A Down', 'Signal', 'Score', 'Close', 'Notes'].map(h => (
              <th key={h} style={{ padding: '8px 10px', textAlign: 'left', color: 'var(--text-muted)', fontWeight: 600, fontSize: 12 }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {logs.map(d => {
            const signal = d.a_up_fired && d.c_up_confirmed ? 'A Up + C' : d.a_up_fired ? 'A Up' : d.a_down_fired && d.c_down_confirmed ? 'A Dn + C' : d.a_down_fired ? 'A Down' : '—';
            const sigColor = d.a_up_fired ? '#22c55e' : d.a_down_fired ? '#ef4444' : '#475569';
            return (
              <tr key={d.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                <td style={{ padding: '7px 10px', fontFamily: 'monospace', fontSize: 12 }}>{d.trade_date?.toString().slice(0, 10)}</td>
                <td style={{ padding: '7px 10px', fontFamily: 'monospace' }}>{d.or_high ? parseFloat(d.or_high).toFixed(2) : '—'}</td>
                <td style={{ padding: '7px 10px', fontFamily: 'monospace' }}>{d.or_low ? parseFloat(d.or_low).toFixed(2) : '—'}</td>
                <td style={{ padding: '7px 10px', fontFamily: 'monospace', color: '#22c55e' }}>{d.a_up_level ? parseFloat(d.a_up_level).toFixed(2) : '—'}</td>
                <td style={{ padding: '7px 10px', fontFamily: 'monospace', color: '#ef4444' }}>{d.a_down_level ? parseFloat(d.a_down_level).toFixed(2) : '—'}</td>
                <td style={{ padding: '7px 10px', fontWeight: 600, color: sigColor }}>{signal}</td>
                <td style={{ padding: '7px 10px', fontFamily: 'monospace', fontWeight: 700, color: scoreColor(d.daily_score) }}>
                  {d.daily_score > 0 ? '+' : ''}{d.daily_score}
                </td>
                <td style={{ padding: '7px 10px', fontFamily: 'monospace' }}>{d.session_close ? parseFloat(d.session_close).toFixed(2) : '—'}</td>
                <td style={{ padding: '7px 10px', color: 'var(--text-muted)', fontSize: 11, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.notes || ''}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ACDPivotInput({ pivot, onSaved }) {
  const now = new Date();
  const monthYear = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const [form, setForm] = React.useState({ month_year: monthYear, prior_month_high: '', prior_month_low: '', prior_month_close: '' });
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (pivot) {
      setForm(f => ({ ...f, prior_month_high: pivot.prior_month_high || '', prior_month_low: pivot.prior_month_low || '', prior_month_close: pivot.prior_month_close || '' }));
    }
  }, [pivot]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await fetch(`${API_URL}/acd/pivot`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) });
      if (onSaved) onSaved();
    } catch(e) { console.error(e); }
    setSaving(false);
  };

  const inputStyle = { background: 'var(--input-bg)', border: '1px solid var(--border-color)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 13, padding: '6px 10px', width: 100 };
  const pivotCalc = form.prior_month_high && form.prior_month_low && form.prior_month_close
    ? ((parseFloat(form.prior_month_high) + parseFloat(form.prior_month_low) + parseFloat(form.prior_month_close)) / 3).toFixed(2)
    : null;

  return (
    <div style={{ background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderRadius: 12, padding: '20px 24px' }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 12, letterSpacing: '0.05em', textTransform: 'uppercase' }}>Monthly Pivot — {monthYear}</div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        {[['prior_month_high', 'Prior Month High'], ['prior_month_low', 'Prior Month Low'], ['prior_month_close', 'Prior Month Close']].map(([k, label]) => (
          <div key={k}><div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 3 }}>{label}</div>
            <input type="number" value={form[k]} onChange={e => setForm(f => ({ ...f, [k]: e.target.value }))} style={inputStyle} />
          </div>
        ))}
        {pivotCalc && (
          <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 3 }}>Pivot Level</div>
            <div style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: 18, color: '#3b82f6', padding: '4px 0' }}>{pivotCalc}</div>
          </div>
        )}
      </div>
      <button onClick={handleSave} disabled={saving}
        style={{ padding: '7px 18px', background: '#3b82f6', border: 'none', borderRadius: 7, color: '#fff', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
        {saving ? 'Saving…' : 'Save Pivot'}
      </button>
    </div>
  );
}

function ACDCorrelationReport({ accounts, selectedAccounts }) {
  const [data, setData] = React.useState(null);
  const acctParam = selectedAccounts?.length > 0 ? `?accounts=${selectedAccounts.join(',')}` : '';

  React.useEffect(() => {
    fetch(`${API_URL}/acd/correlation${acctParam}`)
      .then(r => r.json())
      .then(setData)
      .catch(console.error);
  }, [acctParam]);

  if (!data) return <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: 16 }}>Loading correlation…</div>;
  if (data.acdLogDays === 0) return (
    <div style={{ padding: 20, color: 'var(--text-muted)', fontSize: 13 }}>
      No ACD log entries yet. Log at least one day's ACD data using the Daily Log tab to see trade correlation.
    </div>
  );

  const pct = v => v !== null && v !== undefined ? `${(parseFloat(v) * 100).toFixed(1)}%` : '—';
  const pnlFmt = v => v !== null && v !== undefined ? `${parseFloat(v) >= 0 ? '+' : ''}$${parseFloat(v).toFixed(0)}` : '—';
  const pnlColor = v => v === null ? 'var(--text-muted)' : v >= 0 ? '#22c55e' : '#ef4444';

  const rows = [
    ['ACD Signal Day (A Up or Down)', data.withSignal],
    ['No ACD Signal Day', data.noSignal],
    ['A Up Days', data.aUp],
    ['A Down Days', data.aDown],
    ['C Confirmed Days', data.confirmed],
  ];

  const bestRow = rows.filter(([, d]) => d.count > 0).sort((a, b) => (b[1].winRate || 0) - (a[1].winRate || 0))[0];
  const worstRow = rows.filter(([, d]) => d.count > 0).sort((a, b) => (a[1].winRate || 0) - (b[1].winRate || 0))[0];

  return (
    <div style={{ background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderRadius: 12, padding: '20px 24px' }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 16, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
        Trade Correlation — ACD Signal Days
        <span style={{ marginLeft: 10, fontWeight: 400, textTransform: 'none', fontSize: 12 }}>
          {data.acdLogDays} days logged · {data.totalTrades} trades
          {data.untagged > 0 && <span style={{ color: '#f97316' }}> · {data.untagged} trades outside logged dates</span>}
        </span>
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: 16 }}>
        <thead>
          <tr style={{ borderBottom: '2px solid var(--border-color)' }}>
            {['Context', 'Trades', 'Win Rate', 'Avg P&L'].map(h => (
              <th key={h} style={{ padding: '8px 12px', textAlign: 'left', color: 'var(--text-muted)', fontWeight: 600, fontSize: 12 }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, d]) => (
            <tr key={label} style={{ borderBottom: '1px solid var(--border-color)' }}>
              <td style={{ padding: '8px 12px' }}>{label}</td>
              <td style={{ padding: '8px 12px', fontFamily: 'monospace' }}>{d.count}</td>
              <td style={{ padding: '8px 12px', fontFamily: 'monospace', fontWeight: 600, color: d.winRate >= 0.55 ? '#22c55e' : d.winRate >= 0.45 ? '#fbbf24' : '#ef4444' }}>{pct(d.winRate)}</td>
              <td style={{ padding: '8px 12px', fontFamily: 'monospace', color: pnlColor(d.avgPnl) }}>{pnlFmt(d.avgPnl)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {bestRow && data.withSignal.count > 0 && data.noSignal.count > 0 && (
        <div style={{ padding: '10px 14px', background: 'rgba(59,130,246,0.08)', borderRadius: 8, fontSize: 13, border: '1px solid rgba(59,130,246,0.2)' }}>
          Your trades on ACD signal days win <strong style={{ color: '#22c55e' }}>{pct(data.withSignal.winRate)}</strong> vs <strong style={{ color: pnlColor(data.noSignal.winRate - 0.5) }}>{pct(data.noSignal.winRate)}</strong> on non-signal days.
          {data.confirmed.count > 0 && <> Confirmed (A+C) days: <strong style={{ color: '#22c55e' }}>{pct(data.confirmed.winRate)}</strong>.</>}
        </div>
      )}
    </div>
  );
}

function ACDBacktestRunner() {
  const [job, setJob] = React.useState({ status: 'idle' });
  const [results, setResults] = React.useState([]);
  const [csvFile, setCsvFile] = React.useState(null);
  const [activePeriod, setActivePeriod] = React.useState('last-30d');
  const [lastRun, setLastRun] = React.useState(null);
  const pollRef = React.useRef(null);

  const loadResults = (period) => {
    const p = period || activePeriod;
    fetch(`${API_URL}/acd/backtest/results?period=${p}`)
      .then(r => r.json())
      .then(d => {
        const rows = d.results || d || [];
        // If no results for this period, try falling back to any available period
        if (rows.length === 0 && p === 'all-time') {
          loadResults('last-30d');
          return;
        }
        setResults(rows);
        if (d.lastRun) setLastRun(new Date(d.lastRun).toLocaleString());
      })
      .catch(console.error);
  };

  React.useEffect(() => {
    loadResults(activePeriod);
    fetch(`${API_URL}/acd/backtest/status`).then(r => r.json()).then(setJob).catch(console.error);
  }, []);

  const startPoll = () => {
    if (pollRef.current) return;
    pollRef.current = setInterval(async () => {
      try {
        const s = await fetch(`${API_URL}/acd/backtest/status`).then(r => r.json());
        setJob(s);
        if (s.status === 'complete' || s.status === 'error') {
          clearInterval(pollRef.current);
          pollRef.current = null;
          if (s.status === 'complete') loadResults();
        }
      } catch(e) {}
    }, 2000);
  };

  const handleRun = async (days = null) => {
    const formData = new FormData();
    if (csvFile) formData.append('csv', csvFile);
    if (days) formData.append('days', String(days));
    try {
      await fetch(`${API_URL}/acd/backtest/run`, { method: 'POST', body: formData });
      const period = days ? `last-${days}d` : 'all-time';
      setActivePeriod(period);
      setJob({ status: 'running', progress: { done: 0, total: 360 } });
      startPoll();
    } catch(e) { console.error(e); }
  };

  const pct = v => v !== null && v !== undefined ? `${(parseFloat(v) * 100).toFixed(1)}%` : '—';
  const ev  = v => v !== null && v !== undefined ? `${parseFloat(v) >= 0 ? '+' : ''}${parseFloat(v).toFixed(3)}R` : '—';

  return (
    <div>
      <div style={{ background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderRadius: 12, padding: '20px 24px', marginBottom: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 12, letterSpacing: '0.05em', textTransform: 'uppercase' }}>ACD Parameter Search</div>
        <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 14, lineHeight: 1.6 }}>
          Tests 180 combinations: OR duration (5/10/15 min) × A multiplier (0.25–0.50) × sustain (2/3/5 min) × 4 filter sets (baseline, NL-aligned, OR-range capped, both).
          Runs directly from your existing price bar database — no CSV export needed.
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', background: 'var(--input-bg)', border: '1px solid var(--border-color)', borderRadius: 7, cursor: 'pointer', fontSize: 13, color: 'var(--text-muted)' }}>
            <input type="file" accept=".csv,.txt" onChange={e => setCsvFile(e.target.files[0])} style={{ display: 'none' }} />
            {csvFile ? csvFile.name : 'Choose NQ_1min.csv…'}
          </label>
          <button onClick={() => handleRun(null)} disabled={job.status === 'running'}
            style={{ padding: '8px 16px', background: job.status === 'running' ? '#475569' : '#3b82f6', border: 'none', borderRadius: 7, color: '#fff', fontWeight: 600, fontSize: 13, cursor: job.status === 'running' ? 'not-allowed' : 'pointer' }}>
            {job.status === 'running' && !job.progress?.days ? 'Running…' : 'All History'}
          </button>
          <button onClick={() => handleRun(30)} disabled={job.status === 'running'}
            style={{ padding: '8px 16px', background: job.status === 'running' ? '#475569' : '#8b5cf6', border: 'none', borderRadius: 7, color: '#fff', fontWeight: 600, fontSize: 13, cursor: job.status === 'running' ? 'not-allowed' : 'pointer' }}>
            {job.status === 'running' && job.progress?.days === 30 ? 'Running…' : 'Last 30 Days'}
          </button>
          <button onClick={() => handleRun(60)} disabled={job.status === 'running'}
            style={{ padding: '8px 16px', background: job.status === 'running' ? '#475569' : '#06b6d4', border: 'none', borderRadius: 7, color: '#fff', fontWeight: 600, fontSize: 13, cursor: job.status === 'running' ? 'not-allowed' : 'pointer' }}>
            {job.status === 'running' && job.progress?.days === 60 ? 'Running…' : 'Last 60 Days'}
          </button>
          {job.status === 'running' && job.progress && (
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{job.progress.done} / {job.progress.total} combinations</span>
          )}
          {job.status === 'running' && job.progress && (
            <div style={{ width: 160, height: 6, background: 'var(--border-color)', borderRadius: 3, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${job.progress.done / job.progress.total * 100}%`, background: '#3b82f6', borderRadius: 3, transition: 'width 0.3s' }} />
            </div>
          )}
          {job.status === 'error' && <span style={{ fontSize: 12, color: '#ef4444' }}>{job.error}</span>}
          {job.status === 'complete' && <span style={{ fontSize: 12, color: '#22c55e' }}>Complete — results saved</span>}
        </div>
      </div>

      {results.length > 0 && (
        <div style={{ background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderRadius: 12, padding: '20px 24px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <div>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-muted)', letterSpacing: '0.05em', textTransform: 'uppercase' }}>
                Results (ranked by EV/signal)
              </span>
              {lastRun && (
                <span style={{ marginLeft: 12, fontSize: 11, color: 'var(--text-muted)' }}>
                  Last run: {lastRun}
                </span>
              )}
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              {[['all-time', 'All History'], ['last-30d', 'Last 30 Days'], ['last-60d', 'Last 60 Days']].map(([p, label]) => (
                <button key={p} onClick={() => { setActivePeriod(p); loadResults(p); }}
                  style={{ padding: '3px 10px', fontSize: 11, borderRadius: 5, cursor: 'pointer', border: '1px solid var(--border-color)',
                    background: activePeriod === p ? '#3b82f6' : 'var(--input-bg)',
                    color: activePeriod === p ? '#fff' : 'var(--text-muted)' }}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: '2px solid var(--border-color)' }}>
                  {[
                    ['Filters', 'Which trading rules were applied.\n\nbaseline = trade every signal, no filter\nNL-aligned = only trade when signal direction matches the number line (A Up when NL positive, A Down when NL negative)\nOR<80 = skip days where the opening range is wider than 80 points — chaotic opens where signals are unreliable\nNL-aligned+OR<80 = both filters combined'],
                    ['OR Min', 'Opening range duration in minutes. The high/low of these first bars forms the OR. 5 min = 9:30–9:35 AM.'],
                    ['A Mult', 'A level multiplier. The A Up level = OR High + (OR Range × this number). 0.25 puts the level 25% of the range above OR High. Lower = closer to OR, fires more often.'],
                    ['Sustain', 'Minutes price must hold above the A level without pulling back inside the OR before the signal counts. Filters false breakouts.'],
                    ['Signals', 'Number of trades that fired across all 286 days of bar history. Fewer signals = more selective filter.'],
                    ['Win%', 'Percentage of signals that were profitable (closed above entry for A Up, below for A Down).'],
                    ['Avg Win R', 'Average winning trade size in R multiples (R = distance from entry to stop). Higher is better.'],
                    ['Avg Loss R', 'Average losing trade size in R multiples. Lower is better.'],
                    ['Payoff', 'Avg Win R ÷ Avg Loss R. Above 1.0 means winners are larger than losers on average.'],
                    ['EV/Signal', 'Expected value per signal in R. The most important column. Positive = profitable edge over time. (Win% × Avg Win R) − (Loss% × Avg Loss R).'],
                    ['PF', 'Profit Factor. Total gross profit ÷ total gross loss. Above 1.0 = profitable. Above 1.5 = solid edge.'],
                    ['WR NL>9', 'Win rate on signals that fired when the weekly number line was above +9 (confirmed uptrend). Higher than baseline WR = NL filter adds value.'],
                    ['WR NL<-9', 'Win rate on signals that fired when the weekly number line was below -9 (confirmed downtrend).'],
                    ['WR Ranging', 'Win rate on signals that fired when the weekly number line was between -9 and +9 (no confirmed trend).'],
                  ].map(([h, tip]) => (
                    <th key={h} style={{ padding: '7px 8px', textAlign: 'left', color: 'var(--text-muted)', fontWeight: 600, whiteSpace: 'nowrap' }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>{h}<InfoTooltip text={tip} /></span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {results.slice(0, 20).map((r, i) => {
                  const filterTips = {
                    'baseline': 'No filters — trade every A signal regardless of number line state or OR size. Highest signal count, most noise.',
                    'NL-aligned': 'Only trade when the signal matches the number line direction. A Up only when daily NL ≥ 0, A Down only when daily NL ≤ 0. Eliminates counter-trend trades.',
                    'OR<80': 'Skip days where the opening range exceeds 80 points. Wide ORs usually mean a news-driven open or overnight gap — the A level fires on momentum, not genuine breakout conviction.',
                    'NL-aligned+OR<80': 'Both filters combined — trade only with the trend AND only on days with a contained opening range. Most selective, fewest signals, highest quality.',
                  };
                  return (
                  <tr key={r.id} style={{ borderBottom: '1px solid var(--border-color)', background: i === 0 ? 'rgba(34,197,94,0.05)' : 'transparent' }}>
                    <td style={{ padding: '6px 8px', fontSize: 11, whiteSpace: 'nowrap' }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 3, color: r.filter_label === 'baseline' ? 'var(--text-muted)' : '#f59e0b' }}>
                        {r.filter_label || 'baseline'}
                        <InfoTooltip text={filterTips[r.filter_label] || filterTips['baseline']} />
                      </span>
                    </td>
                    <td style={{ padding: '6px 8px', fontFamily: 'monospace' }}>{r.or_minutes}</td>
                    <td style={{ padding: '6px 8px', fontFamily: 'monospace' }}>{parseFloat(r.a_multiplier).toFixed(2)}</td>
                    <td style={{ padding: '6px 8px', fontFamily: 'monospace' }}>{r.sustain_minutes}</td>
                    <td style={{ padding: '6px 8px', fontFamily: 'monospace' }}>{r.total_signals}</td>
                    <td style={{ padding: '6px 8px', fontFamily: 'monospace', color: parseFloat(r.win_rate) >= 0.55 ? '#22c55e' : parseFloat(r.win_rate) >= 0.45 ? '#fbbf24' : '#ef4444' }}>{pct(r.win_rate)}</td>
                    <td style={{ padding: '6px 8px', fontFamily: 'monospace', color: '#22c55e' }}>{r.avg_win_r ? parseFloat(r.avg_win_r).toFixed(2) + 'R' : '—'}</td>
                    <td style={{ padding: '6px 8px', fontFamily: 'monospace', color: '#ef4444' }}>{r.avg_loss_r ? parseFloat(r.avg_loss_r).toFixed(2) + 'R' : '—'}</td>
                    <td style={{ padding: '6px 8px', fontFamily: 'monospace' }}>{r.payoff_ratio ? parseFloat(r.payoff_ratio).toFixed(2) : '—'}</td>
                    <td style={{ padding: '6px 8px', fontFamily: 'monospace', fontWeight: i < 3 ? 700 : 400, color: parseFloat(r.ev_per_signal) >= 0 ? '#22c55e' : '#ef4444' }}>{ev(r.ev_per_signal)}</td>
                    <td style={{ padding: '6px 8px', fontFamily: 'monospace' }}>{r.profit_factor ? parseFloat(r.profit_factor).toFixed(2) : '—'}</td>
                    <td style={{ padding: '6px 8px', fontFamily: 'monospace', color: parseFloat(r.win_rate_nl_above_9) >= 0.6 ? '#22c55e' : 'var(--text-primary)' }}>{pct(r.win_rate_nl_above_9)}</td>
                    <td style={{ padding: '6px 8px', fontFamily: 'monospace', color: parseFloat(r.win_rate_nl_below_9) >= 0.6 ? '#22c55e' : 'var(--text-primary)' }}>{pct(r.win_rate_nl_below_9)}</td>
                    <td style={{ padding: '6px 8px', fontFamily: 'monospace' }}>{pct(r.win_rate_nl_ranging)}</td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {results[0] && (
            <div style={{ marginTop: 14, padding: '10px 14px', background: 'rgba(34,197,94,0.08)', borderRadius: 8, fontSize: 13, border: '1px solid rgba(34,197,94,0.2)' }}>
              Best parameters: <strong>OR {results[0].or_minutes} min · A multiplier {parseFloat(results[0].a_multiplier).toFixed(2)} · Sustain {results[0].sustain_minutes} min</strong>
              {' — '}{pct(results[0].win_rate)} WR, {ev(results[0].ev_per_signal)} EV/signal
              {results[0].win_rate_nl_above_9 && ` · Win rate when NL > +9: ${pct(results[0].win_rate_nl_above_9)}`}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function NumberLineChart() {
  const [data, setData] = React.useState([]);
  const [range, setRange] = React.useState(180);
  const [hovered, setHovered] = React.useState(null);
  const hoveredRef = React.useRef(null);

  React.useEffect(() => {
    fetch(`${API_URL}/acd/numberline/history`)
      .then(r => r.json())
      .then(d => setData(d))
      .catch(console.error);
  }, []);

  const tooltipCapture = React.useCallback(({ active, payload }) => {
    hoveredRef.current = (active && payload?.length) ? payload[0].payload : null;
    return null;
  }, []);

  const visible = data.slice(-range);
  if (visible.length === 0) return null;

  const latest = visible[visible.length - 1];
  const trend = latest?.nl30 > 9 ? 'TRENDING_UP' : latest?.nl30 < -9 ? 'TRENDING_DOWN' : 'RANGING';

  const CustomDot = ({ cx, cy, payload }) => {
    if (!payload) return null;
    const color = payload.nl30 > 9 ? '#22c55e' : payload.nl30 < -9 ? '#ef4444' : '#fbbf24';
    return <circle cx={cx} cy={cy} r={2} fill={color} />;
  };

  const getRead = (nl30v, nl10v) => {
    const trendLabel = nl30v > 9 ? 'UPTREND CONFIRMED' : nl30v < -9 ? 'DOWNTREND CONFIRMED' : 'RANGING';
    const trendColor = nl30v > 9 ? '#22c55e' : nl30v < -9 ? '#ef4444' : '#fbbf24';
    let momentum = '';
    if (nl30v > 9 && nl10v > 0) momentum = nl10v > nl30v * 0.6 ? 'Momentum building — strong conviction.' : 'Uptrend intact, momentum holding.';
    else if (nl30v > 9) momentum = 'Warning: uptrend confirmed but daily momentum weakening. Shorten holds.';
    else if (nl30v < -9 && nl10v < 0) momentum = nl10v < nl30v * 0.6 ? 'Downtrend deepening.' : 'Downtrend intact, momentum holding.';
    else if (nl30v < -9) momentum = 'Warning: downtrend confirmed but momentum recovering.';
    else momentum = 'No confirmed trend — day trade only, no overnight holds.';
    const holdRec = nl30v > 9 && nl10v > 0 ? 'Multi-day hold OK' : nl30v > 9 ? 'Shorten hold — exit same day' : nl30v < -9 && nl10v < 0 ? 'Multi-day short hold OK' : 'Day trade only — no overnight';
    return { trendLabel, trendColor, momentum, holdRec };
  };

  const rangeOpts = [
    { value: 60, label: '60 days' },
    { value: 120, label: '120 days' },
    { value: 180, label: '6 months' },
    { value: 365, label: '1 year' },
    { value: 9999, label: 'All time' },
  ];

  return (
    <div style={{ background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderRadius: 12, padding: '20px 24px', marginBottom: 16 }}
      onMouseMove={() => { const p = hoveredRef.current; if (p !== hovered) setHovered(p); }}
      onMouseLeave={() => setHovered(null)}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <div>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-muted)', letterSpacing: '0.05em', textTransform: 'uppercase' }}>30-Day Number Line History</span>
          <span style={{ marginLeft: 12, fontSize: 13, fontWeight: 700, color: NL_TREND_COLOR[trend] }}> {NL_TREND_LABEL[trend]}</span>
          {latest && <span style={{ marginLeft: 10, fontFamily: 'monospace', fontSize: 13, color: latest.nl30 > 0 ? '#22c55e' : '#ef4444' }}>NL30: {latest.nl30 > 0 ? '+' : ''}{latest.nl30}</span>}
        </div>
        {/* Custom dropdown to avoid native styling issues */}
        <div style={{ display: 'flex', gap: 4 }}>
          {rangeOpts.map(opt => (
            <button key={opt.value} onClick={() => setRange(opt.value)}
              style={{ padding: '3px 8px', fontSize: 11, borderRadius: 5, cursor: 'pointer', border: '1px solid var(--border-color)',
                background: range === opt.value ? '#3b82f6' : 'var(--input-bg)',
                color: range === opt.value ? '#fff' : 'var(--text-muted)' }}>
              {opt.label}
            </button>
          ))}
        </div>
      </div>
      <ResponsiveContainer width="100%" height={200}>
        <ComposedChart data={visible} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
          <XAxis dataKey="date" tick={{ fontSize: 9, fill: 'var(--text-muted)' }} tickFormatter={d => d.slice(5)} interval={Math.floor(visible.length / 8)} />
          <YAxis tick={{ fontSize: 9, fill: 'var(--text-muted)' }} domain={['auto', 'auto']} />
          <Tooltip content={tooltipCapture} />
          <ReferenceLine y={9}  stroke="#22c55e" strokeDasharray="4 4" strokeWidth={1} label={{ value: '+9', fill: '#22c55e', fontSize: 10, position: 'right' }} />
          <ReferenceLine y={-9} stroke="#ef4444" strokeDasharray="4 4" strokeWidth={1} label={{ value: '-9', fill: '#ef4444', fontSize: 10, position: 'right' }} />
          <ReferenceLine y={0}  stroke="rgba(255,255,255,0.15)" strokeWidth={1} />
          <Bar dataKey="score" fill="rgba(100,116,139,0.4)" radius={[1,1,0,0]} maxBarSize={8} isAnimationActive={false} />
          <Line type="monotone" dataKey="nl10" stroke="#f59e0b" strokeWidth={1} dot={false} strokeOpacity={0.7} isAnimationActive={false} />
          <Line type="monotone" dataKey="nl30" stroke="#3b82f6" strokeWidth={2} dot={<CustomDot />} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
      <div style={{ display: 'flex', gap: 20, marginTop: 8, fontSize: 11, color: 'var(--text-muted)' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ width: 20, height: 2, background: '#3b82f6', display: 'inline-block' }} /> NL30 (30-day rolling sum)</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ width: 20, height: 2, background: '#f59e0b', display: 'inline-block' }} /> NL10 (10-day momentum)</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ width: 8, height: 8, background: 'rgba(100,116,139,0.5)', display: 'inline-block' }} /> Daily score</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ width: 20, height: 2, background: '#22c55e', display: 'inline-block', borderTop: '2px dashed #22c55e' }} /> ±9 thresholds</span>
      </div>

      {hovered ? (() => {
        const { trendLabel, trendColor, momentum, holdRec } = getRead(hovered.nl30, hovered.nl10);
        return (
          <div style={{ marginTop: 10, padding: '10px 14px', background: 'rgba(0,0,0,0.3)', border: `1px solid ${trendColor}`, borderRadius: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              <span style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{hovered.date}</span>
              <span style={{ fontWeight: 700, color: trendColor, fontSize: 13 }}>{trendLabel}</span>
              <span style={{ color: '#3b82f6', fontSize: 12 }}>NL30: <strong>{hovered.nl30 > 0 ? '+' : ''}{hovered.nl30}</strong></span>
              <span style={{ color: '#f59e0b', fontSize: 12 }}>NL10: <strong>{hovered.nl10 > 0 ? '+' : ''}{hovered.nl10}</strong></span>
              <span style={{ fontSize: 12, color: '#e2e8f0', flex: 1 }}>{momentum}</span>
              <span style={{ fontSize: 12, fontWeight: 700, color: trendColor, whiteSpace: 'nowrap' }}>{holdRec}</span>
            </div>
          </div>
        );
      })() : (
        <div style={{ marginTop: 10, padding: '8px 14px', background: 'rgba(0,0,0,0.15)', borderRadius: 8, fontSize: 11, color: 'var(--text-muted)', textAlign: 'center' }}>
          Hover over the chart to see the read for that day
        </div>
      )}
    </div>
  );
}

function AcdCorrelationInsights({ onComplete }) {
  const [data, setData] = React.useState(null);
  const load = () => fetch(`${API_URL}/acd/confluence`).then(r => r.json()).then(setData).catch(console.error);
  React.useEffect(() => { load(); const iv = setInterval(load, 60000); return () => clearInterval(iv); }, []);

  if (!data) return null;

  const { score, maxScore, holdRec, holdColor, dailyNL30, weeklyNL30, pivotLevel, nqClose, details, dailyTrend, weeklyTrend, pivotBias, todaySignal } = data;

  const trendLabel = t => t === 'up' ? 'UP ▲' : t === 'down' ? 'DOWN ▼' : 'RANGING';
  const trendColor = t => t === 'up' ? '#22c55e' : t === 'down' ? '#ef4444' : '#fbbf24';

  return (
    <div style={{ background: 'var(--card-bg)', border: `2px solid ${holdColor}`, borderRadius: 12, padding: '20px 24px', minWidth: 280, flex: 1 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 14, letterSpacing: '0.05em', textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: 4 }}>
        Timeframe Confluence
        <InfoTooltip text="Confluence tells you how long to hold — the A level tells you when to enter.&#10;&#10;3/3 → hold past 11 AM, potentially overnight or longer&#10;2/3 → hold through the session, exit before close&#10;1/3 → exit before 11 AM regardless of where it is&#10;0/3 → skip the signal entirely even if A Up fires" />
      </div>

      {/* Score */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 6 }}>
        <div style={{ fontSize: 52, fontWeight: 800, fontFamily: 'monospace', color: holdColor, lineHeight: 1 }}>{score}/{maxScore}</div>
        <div>
          <div style={{ fontWeight: 700, fontSize: 15, color: holdColor }}>{holdRec}</div>
          {todaySignal && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
              Today: <span style={{ color: todaySignal === 'A_UP' ? '#22c55e' : '#ef4444', fontWeight: 600 }}>{todaySignal === 'A_UP' ? 'A Up ▲' : 'A Down ▼'}</span>
            </div>
          )}
        </div>
      </div>

      {/* Layer breakdown */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border-color)' }}>
        {details.map(d => (
          <div key={d.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{d.label}</span>
            <span style={{ fontSize: 13, fontWeight: 700, color: d.state ? trendColor(d.state) : '#475569' }}>
              {d.state ? trendLabel(d.state) : '—'}
              {d.aligned !== undefined && d.state && d.state !== 'ranging' && (
                <span style={{ fontSize: 11, marginLeft: 5, color: d.aligned ? '#22c55e' : '#ef4444' }}>
                  {d.aligned ? '✓' : '✗'}
                </span>
              )}
            </span>
          </div>
        ))}
        {pivotLevel && (
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-muted)', paddingTop: 4 }}>
            <span>NQ {nqClose?.toFixed(0)} vs pivot {parseFloat(pivotLevel).toFixed(0)}</span>
            <span style={{ color: pivotBias === 'ABOVE_R1' ? '#22c55e' : pivotBias === 'BELOW_S1' ? '#ef4444' : '#f59e0b' }}>
              {pivotBias === 'ABOVE_R1' ? 'above R1' : pivotBias === 'BELOW_S1' ? 'below S1' : 'inside zone'}
            </span>
          </div>
        )}
      </div>

      {/* NL numbers */}
      <div style={{ display: 'flex', gap: 16, marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border-color)' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 18, fontWeight: 700, fontFamily: 'monospace', color: trendColor(dailyTrend) }}>{dailyNL30 > 0 ? '+' : ''}{dailyNL30}</div>
          <div style={{ fontSize: 11, color: '#94a3b8' }}>Daily NL30</div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 18, fontWeight: 700, fontFamily: 'monospace', color: trendColor(weeklyTrend) }}>{weeklyNL30 > 0 ? '+' : ''}{weeklyNL30}</div>
          <div style={{ fontSize: 11, color: '#94a3b8' }}>Weekly NL30</div>
        </div>
        {pivotLevel && (
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 18, fontWeight: 700, fontFamily: 'monospace', color: pivotBias === 'ABOVE_R1' ? '#22c55e' : pivotBias === 'BELOW_S1' ? '#ef4444' : '#f59e0b' }}>{parseFloat(pivotLevel).toFixed(0)}</div>
            <div style={{ fontSize: 11, color: '#94a3b8' }}>
              {pivotBias === 'ABOVE_R1' ? 'Above R1' : pivotBias === 'BELOW_S1' ? 'Below S1' : 'Inside Zone'}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function WeeklyNumberLineChart() {
  const [data, setData] = React.useState(null);
  const [hovered, setHovered] = React.useState(null);
  const hoveredRef = React.useRef(null);
  React.useEffect(() => {
    fetch(`${API_URL}/acd/weekly/numberline`).then(r => r.json()).then(setData).catch(console.error);
  }, []);

  const tooltipCapture = React.useCallback(({ active, payload }) => {
    hoveredRef.current = (active && payload?.length) ? payload[0].payload : null;
    return null;
  }, []);

  if (!data || !data.history?.length) return null;

  const { nl30, nl10, trend, history } = data;
  const color = NL_TREND_COLOR[trend] || '#94a3b8';

  const getRead = (nl30v, nl10v, scorev) => {
    const trendLabel = nl30v > 9 ? 'UPTREND CONFIRMED' : nl30v < -9 ? 'DOWNTREND CONFIRMED' : 'RANGING';
    const trendColor = nl30v > 9 ? '#22c55e' : nl30v < -9 ? '#ef4444' : '#fbbf24';
    let momentum = '';
    if (nl30v > 9 && nl10v > 0) momentum = nl10v > nl30v * 0.6 ? 'Momentum building — strong conviction.' : 'Uptrend intact, momentum holding.';
    else if (nl30v > 9) momentum = 'Warning: uptrend confirmed but momentum weakening. Shorten holds, watch for reversal.';
    else if (nl30v < -9 && nl10v < 0) momentum = nl10v < nl30v * 0.6 ? 'Downtrend deepening — strong conviction.' : 'Downtrend intact, momentum holding.';
    else if (nl30v < -9) momentum = 'Warning: downtrend confirmed but momentum recovering.';
    else momentum = 'No confirmed trend — day trade only, no overnight holds.';
    const holdRec = nl30v > 9 && nl10v > 0 ? 'Multi-day hold OK' : nl30v > 9 ? 'Shorten hold — exit same day' : nl30v < -9 && nl10v < 0 ? 'Multi-day short hold OK' : 'Day trade only — no overnight';
    const scoreLabel = scorev === 4 ? 'A Up + C (+4)' : scorev === 1 ? 'A Up only (+1)' : scorev === -1 ? 'A Down only (-1)' : scorev === -4 ? 'A Down + C (-4)' : 'No signal (0)';
    return { trendLabel, trendColor, momentum, holdRec, scoreLabel };
  };

  const CustomDot = ({ cx, cy, payload }) => {
    if (!payload) return null;
    const c = payload.nl30 > 9 ? '#22c55e' : payload.nl30 < -9 ? '#ef4444' : '#fbbf24';
    return <circle cx={cx} cy={cy} r={3} fill={c} />;
  };

  return (
    <div style={{ background: 'var(--card-bg)', border: `1px solid var(--border-color)`, borderRadius: 12, padding: '20px 24px', flex: 1 }}
      onMouseMove={() => { const p = hoveredRef.current; if (p !== hovered) setHovered(p); }}
      onMouseLeave={() => setHovered(null)}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-muted)', letterSpacing: '0.05em', textTransform: 'uppercase' }}>Weekly Number Line</span>
          <InfoTooltip text={
            `Current read: WNL30 ${nl30 > 0 ? '+' : ''}${nl30} (${NL_TREND_LABEL[trend]}), WNL10 ${nl10 > 0 ? '+' : ''}${nl10}\n\n` +
            (nl30 > 9 && nl10 > nl30 * 0.5 ? 'Momentum building — weekly trend has conviction.\n\n' :
             nl30 > 9 && nl10 < 5 ? 'Warning: WNL30 above +9 but WNL10 weakening. Weekly trend losing steam — treat daily signals with more caution.\n\n' :
             nl30 < -9 && nl10 < nl30 * 0.5 ? 'Downtrend momentum building.\n\n' :
             nl30 < -9 && nl10 > -5 ? 'Warning: WNL30 below -9 but WNL10 recovering. Downtrend may be losing steam.\n\n' : '') +
            'Purple line (WNL30) — 30-week rolling sum. Above +9 = weekly uptrend. Below -9 = downtrend. Between = ranging.\n\n' +
            'Amber line (WNL10) — 10-week momentum. If WNL30 is above +9 but WNL10 is dropping toward zero, the trend is losing steam.\n\n' +
            'Gray bars — each week\'s score (+4, +1, 0, -1, -4).\n\n' +
            'Dashed lines — the +9 and -9 thresholds.'
          } />
          <span style={{ marginLeft: 8, fontWeight: 700, color }}>{NL_TREND_LABEL[trend]}</span>
          <span style={{ marginLeft: 6, fontFamily: 'monospace', fontSize: 13, color: nl30 > 0 ? '#22c55e' : '#ef4444' }}>NL30: {nl30 > 0 ? '+' : ''}{nl30}</span>
        </div>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{history.length} weeks</span>
      </div>
      <ResponsiveContainer width="100%" height={180}>
        <ComposedChart data={history} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
          <XAxis dataKey="date" tick={{ fontSize: 9, fill: 'var(--text-muted)' }}
            tickFormatter={d => { const [yr, mo] = d.split('-'); return mo === '01' ? yr : d.slice(5); }}
            interval={Math.floor(history.length / 10)}
          />
          <YAxis tick={{ fontSize: 9, fill: 'var(--text-muted)' }} domain={['auto', 'auto']} />
          <Tooltip content={tooltipCapture} />
          <ReferenceLine y={9}  stroke="#22c55e" strokeDasharray="4 4" strokeWidth={1} />
          <ReferenceLine y={-9} stroke="#ef4444" strokeDasharray="4 4" strokeWidth={1} />
          <ReferenceLine y={0}  stroke="rgba(255,255,255,0.15)" strokeWidth={1} />
          {/* Year boundary lines — find first data point of each year */}
          {[2024, 2025, 2026].map(yr => {
            const firstOfYear = history.find(d => d.date.startsWith(String(yr)));
            if (!firstOfYear) return null;
            return (
              <ReferenceLine key={yr} x={firstOfYear.date} stroke="rgba(255,255,255,0.25)" strokeWidth={1}
                strokeDasharray="2 2"
                label={{ value: String(yr), position: 'insideTopLeft', fontSize: 9, fill: 'rgba(255,255,255,0.5)', offset: 4 }} />
            );
          })}
          <Bar dataKey="score" fill="rgba(100,116,139,0.4)" radius={[1,1,0,0]} maxBarSize={10} isAnimationActive={false} />
          <Line type="monotone" dataKey="nl10" stroke="#f59e0b" strokeWidth={1} dot={false} strokeOpacity={0.7} isAnimationActive={false} />
          <Line type="monotone" dataKey="nl30" stroke="#8b5cf6" strokeWidth={2} dot={<CustomDot />} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
      <div style={{ display: 'flex', gap: 20, marginTop: 8, fontSize: 11, color: 'var(--text-muted)', alignItems: 'center' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ display: 'inline-block', width: 20, height: 2, background: '#8b5cf6', verticalAlign: 'middle' }} />
          WNL30
          <InfoTooltip text="30-week rolling sum of weekly A/C scores. Above +9 = confirmed weekly uptrend. Below -9 = confirmed downtrend. Between = ranging — no multi-week bias." />
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ display: 'inline-block', width: 20, height: 2, background: '#f59e0b', verticalAlign: 'middle' }} />
          WNL10
          <InfoTooltip text="10-week momentum. Compare to WNL30: if WNL30 is above +9 but WNL10 is dropping toward zero, the weekly trend is losing conviction — a warning sign even if the daily still looks bullish." />
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ display: 'inline-block', width: 12, height: 10, background: 'rgba(100,116,139,0.4)', verticalAlign: 'middle' }} />
          Weekly score
          <InfoTooltip text="+4 = A Up + C confirmed. +1 = A Up only. 0 = no signal. -1 = A Down only. -4 = A Down + C confirmed. Each bar is one week." />
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ display: 'flex', gap: 3 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#22c55e', display: 'inline-block' }} />
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#fbbf24', display: 'inline-block' }} />
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#ef4444', display: 'inline-block' }} />
          </span>
          NL30 dots
          <InfoTooltip text="Each dot shows the trend state at that week.&#10;&#10;Green = NL30 above +9 (uptrend confirmed)&#10;Yellow = NL30 between -9 and +9 (ranging — no bias)&#10;Red = NL30 below -9 (downtrend confirmed)" />
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ display: 'inline-block', width: 20, height: 0, borderTop: '2px dashed #22c55e', verticalAlign: 'middle' }} />
          ±9 thresholds
          <InfoTooltip text="The +9 and -9 lines are Fisher's confirmation thresholds. WNL30 must cross these to confirm a weekly trend — not just touch them." />
        </span>
      </div>

      {/* Hover interpretation panel — shows below chart, never covers it */}
      {hovered ? (() => {
        const { trendLabel, trendColor, momentum, holdRec, scoreLabel } = getRead(hovered.nl30, hovered.nl10, hovered.score);
        return (
          <div style={{ marginTop: 10, padding: '10px 14px', background: 'rgba(0,0,0,0.3)', border: `1px solid ${trendColor}`, borderRadius: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Week of {hovered.date}</span>
              <span style={{ fontSize: 11, color: '#94a3b8' }}>{scoreLabel}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              <span style={{ fontWeight: 700, color: trendColor, fontSize: 13 }}>{trendLabel}</span>
              <span style={{ color: '#8b5cf6', fontSize: 12 }}>NL30: <strong>{hovered.nl30 > 0 ? '+' : ''}{hovered.nl30}</strong></span>
              <span style={{ color: '#f59e0b', fontSize: 12 }}>NL10: <strong>{hovered.nl10 > 0 ? '+' : ''}{hovered.nl10}</strong></span>
              <span style={{ fontSize: 12, color: '#e2e8f0', flex: 1 }}>{momentum}</span>
              <span style={{ fontSize: 12, fontWeight: 700, color: trendColor, whiteSpace: 'nowrap' }}>{holdRec}</span>
            </div>
          </div>
        );
      })() : (
        <div style={{ marginTop: 10, padding: '8px 14px', background: 'rgba(0,0,0,0.15)', borderRadius: 8, fontSize: 11, color: 'var(--text-muted)', textAlign: 'center' }}>
          Hover over the chart to see the read for that week
        </div>
      )}
    </div>
  );
}

function ACDSessionTimeline() {
  const [live, setLive] = React.useState(null);

  React.useEffect(() => {
    const load = () => fetch(`${API_URL}/acd/live`)
      .then(r => r.json())
      .then(d => { if (d && !d.error) setLive(d); })
      .catch(() => {});
    load();
    const iv = setInterval(load, 30000);
    return () => clearInterval(iv);
  }, []);

  const SETUP_DEFINITIONS = {
    'A Up fired':          'Price touched the A Up level (OR High + range × multiplier) AND held above OR High for 5 consecutive minutes without pulling back inside the OR.\n\nThis is the primary long signal. Entry at A Up level, stop at OR Low.\n\nRequires: price ≥ A Up level AND close above OR High for 5 min.',
    'A Up + C Confirmed':  'A Up fired earlier in the session AND a subsequent bar closed above OR High.\n\nC confirmation strengthens the signal — price is being accepted above the OR. Continuation long.\n\nRequires: A Up fired + any bar closes above OR High.',
    'Failed A Up':         'Price reached the A Up level but fell back below OR High before sustaining 5 minutes.\n\nThe bulls showed up, tried to hold the breakout, and failed. That failure is a short signal — the rejection is the edge.\n\nEntry: near OR High on the way back down. Stop: above the session high.',
    'A Down fired':        'Price touched the A Down level (OR Low − range × multiplier) AND held below OR Low for 5 consecutive minutes without pulling back inside the OR.\n\nThis is the primary short signal. Entry at A Down level, stop at OR High.\n\nRequires: price ≤ A Down level AND close below OR Low for 5 min.',
    'A Down + C Confirmed':'A Down fired earlier in the session AND a subsequent bar closed below OR Low.\n\nC confirmation strengthens the signal — price is being accepted below the OR. Continuation short.\n\nRequires: A Down fired + any bar closes below OR Low.',
    'Failed A Down':       'Price reached the A Down level but rose back above OR Low before sustaining 5 minutes.\n\nThe bears showed up, tried to hold the breakdown, and failed. Long signal.\n\nEntry: near OR Low on the bounce. Stop: below the session low.',
    'A Up tested':         'Price touched the A Up level but the 5-minute sustain hasn\'t been confirmed yet.\n\nWatching: if price holds above OR High for 5 minutes → A Up fires (long). If price falls back inside OR → Failed A Up (short).',
    'A Down tested':       'Price touched the A Down level but the 5-minute sustain hasn\'t been confirmed yet.\n\nWatching: if price holds below OR Low for 5 minutes → A Down fires (short). If price rises back inside OR → Failed A Down (long).',
    'C Up (no A)':         'A bar closed above OR High but A Up never fired — price never reached the A Up level with sustained conviction.\n\nWeaker signal: price visited above OR High briefly but lacked the breakout conviction the A signal requires. Can still act as a directional lean but lower confidence.',
    'C Down (no A)':       'A bar closed below OR Low but A Down never fired — price never reached the A Down level with sustained conviction.\n\nWeaker signal: price dipped below OR Low but couldn\'t commit to the breakdown. Lower confidence.',
    'G-Line tested':       'Price touched the G-Line — the weekly open (Monday\'s first RTH bar open).\n\nAbove G-Line = week is positive, buyers in control. Below = week is negative, sellers in control. This first test is the key tell: does the weekly open hold or break?',
    'G-Line lost':         'Price closed below the G-Line (weekly open) — the week has turned negative.\n\nSellers now control the weekly timeframe. A Down signals and short setups carry structural weekly tailwind until the G-Line is reclaimed.',
    'G-Line reclaimed':    'Price closed back above the G-Line after losing it — the week has turned positive again.\n\nBullish recovery of the weekly open. A Up signals now carry structural weekly tailwind.',
    'PM VAH tested':       'Price touched the prior month value area high — the top of where 70% of last month\'s volume was transacted.\n\nThis is a major multi-timeframe reference. Above PM VAH = initiative territory on the monthly timeframe. The market is accepting prices beyond last month\'s accepted range.\nBelow PM VAH = still within or below monthly value — responsive territory.',
    'PM VAH broken':       'A bar closed above the prior month VAH — price accepted above the monthly value area. Multi-timeframe bullish structural shift. PM VAH flips to support. Strongest structural confirmation for long bias.',
    'PM VAL tested':       'Price touched the prior month value area low — the bottom of where 70% of last month\'s volume was transacted.\n\nBelow PM VAL = initiative territory to the downside on the monthly timeframe. The market is accepting prices below last month\'s accepted range.',
    'PM VAL broken':       'A bar closed below the prior month VAL — price accepted below the monthly value area. Multi-timeframe bearish structural shift. PM VAL flips to resistance.',
    'PW High tested':      'Price touched the prior week high — the highest RTH price from last week\'s session.\n\nThis is a major structural reference. Buyers who held longs all week are now breakeven. A close above = new weekly acceptance. Rejection here = short lean back into the week\'s range.',
    'PW High broken':      'A bar closed above the prior week high — price is being accepted above last week\'s entire range.\n\nBullish structural shift. Dalton: new value being established higher. Prior week high flips to support. A Up signals above this level have higher conviction.',
    'PW Low tested':       'Price touched the prior week low — the lowest RTH price from last week\'s session.\n\nKey support reference. Sellers from last week are now at breakeven. A close below = new weekly acceptance lower. Bounce here = long lean back into the prior range.',
    'PW Low broken':       'A bar closed below the prior week low — price accepted below last week\'s entire range.\n\nBearish structural shift. Dalton: new value being established lower. Prior week low flips to resistance. A Down signals below this level have higher conviction.',
  };

  if (!live || !live.timeline) return null;

  const { timeline, narrative, orHigh, orLow, aUpLevel, aDownLevel, gLine, pwHigh, pwLow, pmVAH, pmVAL, pmPOC, sessionHigh, sessionLow, currentPrice, barTime, barsAnalyzed } = live;

  return (
    <div style={{ background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderRadius: 12, padding: '20px 24px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-muted)', letterSpacing: '0.05em', textTransform: 'uppercase' }}>
          Today's Setup Timeline
          <InfoTooltip text="A running log of every ACD setup event that fired today, in order. Multiple setups can occur — for example, A Up can test and fail in the morning, then A Down can fire in the afternoon. Refreshes every 30 seconds." />
        </div>
        <div style={{ display: 'flex', gap: 16, fontSize: 11, color: 'var(--text-muted)', fontFamily: 'monospace' }}>
          <span>OR {orHigh?.toFixed(0)} / {orLow?.toFixed(0)}</span>
          <span style={{ color: '#22c55e' }}>A Up {aUpLevel?.toFixed(0)}</span>
          <span style={{ color: '#ef4444' }}>A Down {aDownLevel?.toFixed(0)}</span>
          {gLine  && <span style={{ color: '#f59e0b' }}>G-Line {gLine?.toFixed(0)}</span>}
          {pwHigh && <span style={{ color: '#c084fc' }}>PW Hi {pwHigh?.toFixed(0)}</span>}
          {pwLow  && <span style={{ color: '#c084fc' }}>PW Lo {pwLow?.toFixed(0)}</span>}
          {pmVAH  && <span style={{ color: '#10b981' }}>PM VAH {pmVAH?.toFixed(0)}</span>}
          {pmVAL  && <span style={{ color: '#10b981' }}>PM VAL {pmVAL?.toFixed(0)}</span>}
          <span>H {sessionHigh?.toFixed(0)} · L {sessionLow?.toFixed(0)}</span>
          <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>Now: {currentPrice?.toFixed(2)}</span>
          <span style={{ color: '#a0aec0', fontSize: 13 }}>updated {barTime} ET</span>
        </div>
      </div>

      {timeline.length === 0 ? (
        <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '12px 0', textAlign: 'center' }}>
          No setups have fired yet today. Watching for price to test A Up ({aUpLevel?.toFixed(2)}) or A Down ({aDownLevel?.toFixed(2)}).
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {[...timeline].reverse().map((event, i) => {
              // Determine C signal variant: Standalone (no prior A) vs Reversal (follows a Failed A in opposite direction)
              const orderedTimeline = timeline; // chronological order
              const eventIdx = orderedTimeline.indexOf(event);
              const priorEvents = orderedTimeline.slice(0, eventIdx);
              const hasPriorFailedAUp   = priorEvents.some(e => e.event?.startsWith('Failed A Up'));
              const hasPriorFailedADown = priorEvents.some(e => e.event?.startsWith('Failed A Down'));

              // C Reversal: C fires in the direction that confirms the prior Failed A
              // Failed A Up → bears won → C Down confirms the short case = C Reversal (short)
              // Failed A Down → bulls won → C Up confirms the long case = C Reversal (long)
              const isCUpReversal   = event.event === 'C Up (no A)'   && hasPriorFailedADown;
              const isCDownReversal = event.event === 'C Down (no A)' && hasPriorFailedAUp;

              const cVariantLabel = isCUpReversal ? 'C Reversal ↑' : isCDownReversal ? 'C Reversal ↓' :
                event.event === 'C Up (no A)' ? 'C Standalone ↑' : event.event === 'C Down (no A)' ? 'C Standalone ↓' : null;

              const dirMap = {
                'A Up fired': { label: 'BUY', color: '#22c55e' },
                'A Up + C Confirmed': { label: 'BUY', color: '#22c55e' },
                'Failed A Up': { label: 'SELL', color: '#f97316' },
                'A Down fired': { label: 'SELL', color: '#ef4444' },
                'A Down + C Confirmed': { label: 'SELL', color: '#ef4444' },
                'Failed A Down': { label: 'BUY', color: '#a78bfa' },
                'A Up tested': { label: 'WATCH', color: '#fbbf24' },
                'A Down tested': { label: 'WATCH', color: '#fbbf24' },
                'C Up (no A)': { label: isCUpReversal ? 'C REVERSAL' : 'C STANDALONE', color: isCUpReversal ? '#22c55e' : '#6ee7b7' },
                'C Down (no A)': { label: isCDownReversal ? 'C REVERSAL' : 'C STANDALONE', color: isCDownReversal ? '#ef4444' : '#fda4af' },
                'C Up confirmed': { label: 'BUY', color: '#22c55e' },
                'C Down confirmed': { label: 'SELL', color: '#ef4444' },
                'G-Line tested':   { label: 'WATCH',    color: '#f59e0b' },
                'G-Line lost':     { label: 'BEARISH',  color: '#f59e0b' },
                'G-Line reclaimed':{ label: 'BULLISH',  color: '#f59e0b' },
                'PM VAH tested':  { label: 'WATCH',    color: '#10b981' },
                'PM VAH broken':  { label: 'BULLISH',  color: '#10b981' },
                'PM VAL tested':  { label: 'WATCH',    color: '#10b981' },
                'PM VAL broken':  { label: 'BEARISH',  color: '#10b981' },
                'PW High tested': { label: 'WATCH', color: '#c084fc' },
                'PW High broken': { label: 'BULLISH', color: '#c084fc' },
                'PW Low tested':  { label: 'WATCH', color: '#c084fc' },
                'PW Low broken':  { label: 'BEARISH', color: '#c084fc' },
              };
              const baseEvent = event.event.replace(/ \(attempt \d+\)$/, '');
              const dir = dirMap[baseEvent] || dirMap[event.event];
              return (
            <div key={i} style={{ padding: '10px 14px', background: `${event.color}12`, border: `1px solid ${event.color}50`, borderLeft: `3px solid ${event.color}`, borderRadius: 8 }}>
              {/* Header */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                <span style={{ fontWeight: 700, fontSize: 14, color: event.color }}>
                  {cVariantLabel ?? event.event}
                </span>
                {SETUP_DEFINITIONS[baseEvent] && <InfoTooltip text={SETUP_DEFINITIONS[baseEvent]} />}
                <span style={{ fontFamily: 'monospace', fontSize: 13, color: event.color, opacity: 0.85 }}>
                  {event.price?.toFixed(2)}
                </span>
                <span style={{ fontFamily: 'monospace', fontSize: 12, color: '#94a3b8' }}>
                  {event.time} ET
                </span>
                {dir && (
                  <span style={{ marginLeft: 'auto', fontWeight: 900, fontSize: 18, color: dir.color, letterSpacing: '0.05em' }}>
                    {dir.label}
                  </span>
                )}
              </div>
              {/* Body */}
              <div style={{ fontSize: 13, color: '#cbd5e1', lineHeight: 1.6 }}>{event.note}</div>
              {/* Footer */}
              <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-muted)', display: 'flex', gap: 16 }}>
                <span>Session H: <strong style={{ color: '#22c55e', fontFamily: 'monospace' }}>{live.sessionHigh?.toFixed(2)}</strong></span>
                <span>Session L: <strong style={{ color: '#ef4444', fontFamily: 'monospace' }}>{live.sessionLow?.toFixed(2)}</strong></span>
                <span>{live.barsAnalyzed} bars analyzed</span>
              </div>
            </div>
              );
            })}
        </div>
      )}
    </div>
  );
}

function ACDSetupReference() {
  const setups = [
    { name: 'A Up', color: '#22c55e', dir: 'Long', strength: 'Primary',
      requires: 'Price ≥ A Up level (OR High + range × mult) AND holds above OR High for 5 min without pulling back inside OR.',
      action: 'Long at A Up level. Stop at OR Low.' },
    { name: 'A Up + C Confirmed', color: '#22c55e', dir: 'Long', strength: 'Strongest',
      requires: 'A Up fired earlier in session AND any subsequent bar closes above OR High.',
      action: 'Hold long. C confirmation means price is being accepted above OR — continuation more likely.' },
    { name: 'Failed A Up', color: '#f97316', dir: 'Short', strength: 'High',
      requires: 'Price reached A Up level but fell back below OR High before sustaining 5 min. Bulls tried and failed.',
      action: 'Short near OR High on the reversal. Stop above session high.' },
    { name: 'A Down', color: '#ef4444', dir: 'Short', strength: 'Primary',
      requires: 'Price ≤ A Down level (OR Low − range × mult) AND holds below OR Low for 5 min without pulling back inside OR.',
      action: 'Short at A Down level. Stop at OR High.' },
    { name: 'A Down + C Confirmed', color: '#ef4444', dir: 'Short', strength: 'Strongest',
      requires: 'A Down fired earlier in session AND any subsequent bar closes below OR Low.',
      action: 'Hold short. C confirmation means price accepted below OR — continuation more likely.' },
    { name: 'Failed A Down', color: '#a78bfa', dir: 'Long', strength: 'High',
      requires: 'Price reached A Down level but rose back above OR Low before sustaining 5 min. Bears tried and failed.',
      action: 'Long near OR Low on the bounce. Stop below session low.' },
    { name: 'C Up (no A)', color: '#6ee7b7', dir: 'Weak Long', strength: 'Low',
      requires: 'Any bar closes above OR High, but A Up never fired (price never reached A Up level with conviction).',
      action: 'Lower confidence. Price explored above OR but lacked breakout conviction. Use with caution.' },
    { name: 'C Down (no A)', color: '#fda4af', dir: 'Weak Short', strength: 'Low',
      requires: 'Any bar closes below OR Low, but A Down never fired.',
      action: 'Lower confidence. Price dipped below OR but couldn\'t commit to the breakdown.' },
  ];

  const [expanded, setExpanded] = React.useState(false);

  return (
    <div style={{ background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderRadius: 12, padding: '16px 24px', marginTop: 16 }}>
      <button onClick={() => setExpanded(e => !e)}
        style={{ width: '100%', background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 0 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-muted)', letterSpacing: '0.05em', textTransform: 'uppercase' }}>
          ACD Setup Reference — All 8 Setups
        </span>
        <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{expanded ? '▲ collapse' : '▼ expand'}</span>
      </button>

      {expanded && (
        <div style={{ marginTop: 14 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: '2px solid var(--border-color)' }}>
                {['Setup', 'Direction', 'Strength', 'Requires', 'Action'].map(h => (
                  <th key={h} style={{ padding: '7px 10px', textAlign: 'left', color: 'var(--text-muted)', fontWeight: 600, fontSize: 11 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {setups.map(s => (
                <tr key={s.name} style={{ borderBottom: '1px solid var(--border-color)', verticalAlign: 'top' }}>
                  <td style={{ padding: '8px 10px', fontWeight: 700, color: s.color, whiteSpace: 'nowrap' }}>{s.name}</td>
                  <td style={{ padding: '8px 10px', color: s.dir.includes('Long') ? '#22c55e' : s.dir.includes('Short') ? '#ef4444' : '#94a3b8', fontWeight: 600, whiteSpace: 'nowrap' }}>{s.dir}</td>
                  <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>
                    <span style={{ padding: '2px 7px', borderRadius: 4, fontSize: 11, fontWeight: 700,
                      background: s.strength === 'Strongest' ? 'rgba(34,197,94,0.15)' : s.strength === 'Primary' ? 'rgba(59,130,246,0.15)' : s.strength === 'High' ? 'rgba(249,115,22,0.15)' : 'rgba(100,116,139,0.15)',
                      color: s.strength === 'Strongest' ? '#22c55e' : s.strength === 'Primary' ? '#3b82f6' : s.strength === 'High' ? '#f97316' : '#94a3b8' }}>
                      {s.strength}
                    </span>
                  </td>
                  <td style={{ padding: '8px 10px', color: '#94a3b8', lineHeight: 1.5, maxWidth: 300 }}>{s.requires}</td>
                  <td style={{ padding: '8px 10px', color: '#cbd5e1', lineHeight: 1.5, maxWidth: 220 }}>{s.action}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Auction History View ───────────────────────────────────────────────────────

function CorrelationSummary() {
  const [data, setData] = React.useState([]);
  const [computing, setComputing] = React.useState(false);
  const [lastRun, setLastRun] = React.useState(null);

  const load = () => {
    fetch(`${API_URL}/auction-read/correlation`)
      .then(r => r.json())
      .then(d => {
        setData(d || []);
        if (d?.length) setLastRun(d[0]?.computed_at?.slice(0, 16).replace('T',' '));
      }).catch(() => {});
  };

  React.useEffect(() => { load(); }, []);

  const compute = async () => {
    setComputing(true);
    await fetch(`${API_URL}/auction-read/correlation/compute`, { method: 'POST' });
    setTimeout(() => { load(); setComputing(false); }, 90000);
  };

  // Build insight sentences from data
  const byBias = {};
  data.forEach(r => {
    if (!byBias[r.bias_dir]) byBias[r.bias_dir] = [];
    byBias[r.bias_dir].push(r);
  });

  const insights = [];
  for (const [bias, rows] of Object.entries(byBias)) {
    const top = rows.filter(r => parseFloat(r.hit_rate_pct) >= 80 && r.tested >= 4).slice(0, 3);
    const changed = rows.filter(r => r.changed);
    if (top.length) {
      insights.push({ bias, top, changed });
    }
  }

  const biasColor = { LONG: '#22c55e', SHORT: '#ef4444', NEUTRAL: '#94a3b8' };

  if (!data.length) {
    return (
      <div style={{ padding: '12px 16px', background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.2)', borderRadius: 10, marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Setup correlation not yet computed</span>
          <button onClick={compute} disabled={computing}
            style={{ padding: '4px 14px', fontSize: 11, borderRadius: 5, cursor: 'pointer', border: '1px solid #3b82f6', background: 'rgba(59,130,246,0.15)', color: '#3b82f6', fontWeight: 600 }}>
            {computing ? 'Computing (~90s)…' : 'Compute Insights'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: '14px 16px', background: 'rgba(15,23,42,0.8)', border: '1px solid rgba(100,116,139,0.25)', borderRadius: 10, marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: '#94a3b8', letterSpacing: '0.07em', textTransform: 'uppercase' }}>
          Setup Correlation Insights
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {lastRun && <span style={{ fontSize: 11, color: '#94a3b8', fontFamily: 'Arial, sans-serif' }}>computed {lastRun}</span>}
          <button onClick={compute} disabled={computing}
            style={{ padding: '2px 10px', fontSize: 11, borderRadius: 4, cursor: 'pointer', border: '1px solid var(--border-color)', background: 'var(--input-bg)', color: 'var(--text-muted)', fontWeight: 600 }}>
            {computing ? 'Running…' : '↺ Recompute'}
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {insights.map(({ bias, top, changed }) => (
          <div key={bias}>
            <div style={{ fontSize: 11, fontWeight: 700, color: biasColor[bias], marginBottom: 5, display: 'flex', alignItems: 'center', gap: 8 }}>
              {bias} MORNINGS
              {changed.length > 0 && (
                <span style={{ fontSize: 11, background: 'rgba(251,191,36,0.2)', color: '#fbbf24', border: '1px solid rgba(251,191,36,0.4)', borderRadius: 3, padding: '1px 6px' }}>
                  ⚡ {changed.length} setup{changed.length > 1 ? 's' : ''} changed
                </span>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {top.map(r => {
                const isChanged = r.changed;
                const pctNum = parseFloat(r.hit_rate_pct);
                const pctColor = pctNum === 100 ? '#22c55e' : pctNum >= 85 ? '#86efac' : '#fbbf24';
                const priorPct = r.prior_hit_rate ? (parseFloat(r.prior_hit_rate) * 100).toFixed(0) : null;
                const pctDiff = priorPct ? (pctNum - parseFloat(priorPct)).toFixed(0) : null;
                return (
                  <div key={r.setup_key} style={{ padding: '6px 12px', background: isChanged ? 'rgba(251,191,36,0.08)' : 'rgba(0,0,0,0.3)', border: `1px solid ${isChanged ? 'rgba(251,191,36,0.4)' : 'rgba(100,116,139,0.2)'}`, borderRadius: 7, minWidth: 130 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 }}>
                      <span style={{ fontSize: 12, fontWeight: 700, color: '#e2e8f0' }}>{r.setup_key}</span>
                      <span style={{ fontSize: 13, fontWeight: 800, color: pctColor, fontFamily: 'monospace' }}>{r.hit_rate_pct}%</span>
                    </div>
                    <div style={{ fontSize: 11, color: '#94a3b8', display: 'flex', gap: 8 }}>
                      <span>{r.tested} tested</span>
                      <span>avg {r.avg_pts}pts</span>
                      <span>max {r.max_pts}pts</span>
                    </div>
                    {isChanged && priorPct && (
                      <div style={{ fontSize: 11, color: '#fbbf24', marginTop: 3 }}>
                        ⚡ was {priorPct}% ({pctDiff > 0 ? '+' : ''}{pctDiff}% change)
                        {r.prior_avg_pts && ` · avg was ${r.prior_avg_pts}pts`}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {/* Key insight sentence */}
            {top[0] && (
              <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 5, fontStyle: 'italic' }}>
                {bias === 'LONG' && `On ${bias.toLowerCase()} mornings, ${top[0].setup_key} holds ${top[0].hit_rate_pct}% of the time (${top[0].tested} tests, avg ${top[0].avg_pts}pts move). ${top.filter(t=>parseFloat(t.hit_rate_pct)===100).length > 1 ? `${top.filter(t=>parseFloat(t.hit_rate_pct)===100).map(t=>t.setup_key).join(' and ')} are both 100%.` : ''}`}
                {bias === 'SHORT' && `On ${bias.toLowerCase()} mornings, ${top.filter(t=>parseFloat(t.hit_rate_pct)===100).map(t=>t.setup_key).join(', ')} hit at 100%. ${top[0].setup_key} averages ${top[0].avg_pts}pts with a ${top[0].max_pts}pt max.`}
                {bias === 'NEUTRAL' && `Even on neutral mornings, ${top[0].setup_key} (${top[0].hit_rate_pct}%) and ${top[1]?.setup_key || ''} (${top[1]?.hit_rate_pct || ''}%) are consistently profitable. Key levels work regardless of morning bias.`}
              </div>
            )}
          </div>
        ))}
      </div>

      {data.some(r => r.changed) && (
        <div style={{ marginTop: 10, padding: '8px 12px', background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.3)', borderRadius: 7, fontSize: 11, color: '#fbbf24' }}>
          ⚡ Note: Some setups have changed hit rates since the last computation. This may reflect new bar data or market regime changes. Setups marked with ⚡ have moved more than 5% in hit rate or 10pts in average move.
        </div>
      )}
    </div>
  );
}

function AuctionHistoryView() {
  const [history, setHistory] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [expanded, setExpanded] = React.useState(null);
  const [days, setDays] = React.useState(90);
  const [refreshing, setRefreshing] = React.useState(false);

  const numFields = ['orHigh','orLow','aUpLevel','aDownLevel','priorVAH','priorVAL','priorPOC','sessionHigh','sessionLow','sessionClose','sessionOpen'];
  const normalise = row => {
    const r = { ...row };
    numFields.forEach(k => { if (r[k] != null) r[k] = parseFloat(r[k]) || null; });
    return r;
  };

  const load = React.useCallback((d) => {
    setLoading(true);
    fetch(`${API_URL}/auction-read/history?days=${d}`)
      .then(r => r.json())
      .then(data => {
        const rows = (data || []).map(normalise);
        setHistory(rows);
        setExpanded(null); // all collapsed by default
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  React.useEffect(() => { load(days); }, [days]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await fetch(`${API_URL}/auction-read/history/refresh`, { method: 'POST' });
    setRefreshing(false);
    load(days);
  };

  if (loading) return <div style={{ padding: 40, color: 'var(--text-muted)' }}>Loading {days}-day history…</div>;

  const correct = history.filter(d => d.outcome === 'CORRECT').length;
  const wrong   = history.filter(d => d.outcome === 'WRONG').length;
  const total   = correct + wrong;
  const acc     = total ? (correct / total * 100).toFixed(0) : 0;

  const outcomeColor = { CORRECT: '#22c55e', WRONG: '#ef4444', NEUTRAL: '#64748b' };
  const biasColor    = { LONG: '#22c55e', SHORT: '#ef4444', NEUTRAL: '#64748b' };
  const profileShort = { TREND: 'T', NORMAL_VARIATION: 'NV', NORMAL: 'N', NEUTRAL: 'Nt', RUNNING_PROFILE_NEUTRAL: 'RN', NONTREND: 'NT', UNKNOWN: '?' };

  return (
    <div style={{ padding: '0 4px', fontFamily: 'Arial, sans-serif', fontSize: 11, color: '#94a3b8' }}>
      {/* Controls */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center' }}>
        {[30, 60, 90].map(d => (
          <button key={d} onClick={() => setDays(d)}
            style={{ padding: '4px 14px', fontSize: 12, borderRadius: 5, cursor: 'pointer', border: '1px solid var(--border-color)', fontWeight: 600,
              background: days === d ? '#3b82f6' : 'var(--input-bg)',
              color: days === d ? '#fff' : 'var(--text-muted)' }}>
            {d} days
          </button>
        ))}
        <button onClick={handleRefresh} disabled={refreshing}
          style={{ marginLeft: 8, padding: '4px 14px', fontSize: 12, borderRadius: 5, cursor: 'pointer', border: '1px solid var(--border-color)', background: 'var(--input-bg)', color: 'var(--text-muted)', fontWeight: 600 }}>
          {refreshing ? 'Refreshing…' : '↺ Recompute'}
        </button>
        <span style={{ fontSize: 11, color: '#94a3b8', marginLeft: 4 }}>Results cached — recompute only when you add new bar data</span>
      </div>

      {/* Summary bar */}
      <div style={{ display: 'flex', gap: 24, padding: '12px 0', marginBottom: 16, borderBottom: '1px solid var(--border-color)', flexWrap: 'wrap' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 28, fontWeight: 800, fontFamily: 'monospace', color: parseInt(acc) >= 60 ? '#22c55e' : parseInt(acc) >= 50 ? '#fbbf24' : '#ef4444' }}>{acc}%</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>accuracy</div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 28, fontWeight: 800, fontFamily: 'monospace', color: '#22c55e' }}>{correct}</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>correct</div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 28, fontWeight: 800, fontFamily: 'monospace', color: '#ef4444' }}>{wrong}</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>wrong</div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 28, fontWeight: 800, fontFamily: 'monospace', color: '#64748b' }}>{history.length - total}</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>neutral</div>
        </div>
        {(() => {
          const longs = history.filter(d => d.biasDir === 'LONG');
          const shorts = history.filter(d => d.biasDir === 'SHORT');
          const longAcc = longs.length ? (longs.filter(d => d.outcome === 'CORRECT').length / longs.filter(d => d.outcome !== 'NEUTRAL').length * 100).toFixed(0) : 0;
          const shortAcc = shorts.length ? (shorts.filter(d => d.outcome === 'CORRECT').length / shorts.filter(d => d.outcome !== 'NEUTRAL').length * 100).toFixed(0) : 0;
          return (
            <>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 20, fontWeight: 700, fontFamily: 'monospace', color: '#22c55e' }}>{longAcc}%</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>LONG accuracy</div>
              </div>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 20, fontWeight: 700, fontFamily: 'monospace', color: '#ef4444' }}>{shortAcc}%</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>SHORT accuracy</div>
              </div>
            </>
          );
        })()}
      </div>

      <CorrelationSummary />

      {/* Day cards — most recent first, inline accordion */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {history.map(day => {
          const isOpen = expanded === day.date;
          const oc = outcomeColor[day.outcome] || '#64748b';
          const bc = biasColor[day.biasDir] || '#64748b';

          return (
            <div key={day.date}
              style={{ background: 'var(--card-bg)', border: `1px solid ${oc}40`, borderLeft: `4px solid ${oc}`, borderRadius: 10, overflow: 'hidden' }}>

              {/* Header row — click to toggle */}
              <div
                style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px', flexWrap: 'wrap', cursor: 'pointer', userSelect: 'none' }}
                onClick={() => setExpanded(isOpen ? null : day.date)}>

                <span style={{ fontFamily: 'monospace', fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', minWidth: 90 }}>{day.date}</span>

                <span style={{ padding: '2px 10px', borderRadius: 4, fontSize: 12, fontWeight: 700, background: `${bc}20`, color: bc, border: `1px solid ${bc}50` }}>
                  {day.biasDir}
                  {day.conflict && <span style={{ fontSize: 11, marginLeft: 4, color: '#fbbf24' }}>⚡</span>}
                </span>

                <span style={{ padding: '2px 10px', borderRadius: 4, fontSize: 12, fontWeight: 700, background: `${oc}15`, color: oc }}>
                  {day.outcome === 'CORRECT' ? '✓ CORRECT' : day.outcome === 'WRONG' ? '✗ WRONG' : '— NEUTRAL'}
                </span>

                <span style={{ fontSize: 11, color: '#94a3b8' }}>
                  {day.inv?.replace('_TRAPPED','').replace('_',' ')} · {day.valPos?.replace('_VALUE','').replace('_',' ')}
                </span>

                <span style={{ fontSize: 11, color: '#94a3b8' }}>
                  Prior: <strong style={{ color: '#e2e8f0' }}>{profileShort[day.priorProfile] || day.priorProfile}</strong>
                </span>

                <span style={{ fontSize: 11, color: '#94a3b8' }}>
                  NL: <strong style={{ color: day.nl30 > 9 ? '#22c55e' : day.nl30 < -9 ? '#ef4444' : '#fbbf24', fontFamily: 'monospace' }}>{day.nl30 > 0 ? '+' : ''}{day.nl30}</strong>
                </span>

                <div style={{ marginLeft: 'auto', display: 'flex', gap: 16, alignItems: 'center' }}>
                  <span style={{ fontSize: 11, color: '#94a3b8' }}>
                    Score: <strong style={{ color: day.acdScore > 0 ? '#22c55e' : day.acdScore < 0 ? '#ef4444' : '#64748b', fontFamily: 'monospace' }}>{day.acdScore > 0 ? '+' : ''}{day.acdScore}</strong>
                  </span>
                  {day.ptsVsOpen !== null && (
                    <span style={{ fontSize: 11, color: '#94a3b8' }}>
                      <strong style={{ color: day.ptsVsOpen > 0 ? '#22c55e' : '#ef4444', fontFamily: 'monospace' }}>{day.ptsVsOpen > 0 ? '+' : ''}{day.ptsVsOpen}pts</strong>
                    </span>
                  )}
                  <span style={{ fontSize: 11, color: '#94a3b8' }}>{isOpen ? '▲' : '▼'}</span>
                </div>
              </div>

              {/* Inline expanded content */}
              {isOpen && (
                <div style={{ borderTop: `1px solid ${oc}30`, display: 'flex', overflow: 'hidden' }}>
                  <div style={{ flex: 1, padding: '16px', minWidth: 0 }}>
                    <AuctionDayChart day={day} fullSize />
                  </div>
                  <div style={{ width: 260, flexShrink: 0, borderLeft: '1px solid var(--border-color)', padding: '16px', overflowY: 'auto' }}>
                    <div style={{ fontWeight: 700, color: bc, fontSize: 13, marginBottom: 10 }}>
                      MORNING READ: {day.biasDir}
                      {day.conflict && <div style={{ fontSize: 11, color: '#fbbf24', fontWeight: 400, marginTop: 2 }}>⚡ Structure vs NL conflict</div>}
                    </div>
                    {[
                      ['Overnight inventory', day.inv?.replace(/_/g,' ')],
                      ['Open vs prior value', day.valPos?.replace(/_/g,' ')],
                      ['Prior day profile', day.priorProfile?.replace(/_/g,' ')],
                      ['ACD NL30', `${day.nl30 > 0 ? '+' : ''}${day.nl30} (${day.nlTrend?.replace(/_/g,' ')})`],
                      ['OR condition', day.orCond],
                      ['Pivot bias', day.pivotBias || '—'],
                      ['Prior VAH', day.priorVAH?.toFixed(2)],
                      ['Prior VAL', day.priorVAL?.toFixed(2)],
                      ['OR High', day.orHigh?.toFixed(2)],
                      ['OR Low',  day.orLow?.toFixed(2)],
                      ['A signal', day.aUpFired ? 'A UP fired' : day.aDownFired ? 'A DOWN fired' : 'No signal'],
                    ].map(([label, value]) => (
                      <div key={label} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid rgba(100,116,139,0.1)' }}>
                        <span style={{ color: '#94a3b8', fontSize: 11 }}>{label}</span>
                        <span style={{ color: '#e2e8f0', fontFamily: 'monospace', fontSize: 11 }}>{value || '—'}</span>
                      </div>
                    ))}
                    <div style={{ marginTop: 10, padding: '8px 10px', background: `${oc}12`, border: `1px solid ${oc}40`, borderRadius: 6 }}>
                      <div style={{ fontWeight: 700, color: oc, fontSize: 12, marginBottom: 3 }}>ACTUAL: {day.actualDir}</div>
                      <div style={{ color: '#94a3b8', fontSize: 11 }}>
                        ACD score: {day.acdScore > 0 ? '+' : ''}{day.acdScore}
                        {day.ptsVsOpen !== null && ` · ${day.ptsVsOpen > 0 ? '+' : ''}${day.ptsVsOpen}pts`}
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AuctionDayChart({ day, fullSize = false }) {
  const [chartData, setChartData] = React.useState(null);
  const [setupEvents, setSetupEvents] = React.useState([]);
  const [winningTrades, setWinningTrades] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [hover, setHover] = React.useState(null);

  React.useEffect(() => {
    setLoading(true);
    Promise.all([
      fetch(`${API_URL}/chart/live-day?date=${day.date}`).then(r => r.json()),
      fetch(`${API_URL}/auction-read/day-setups?date=${day.date}`).then(r => r.json()),
      fetch(`${API_URL}/trades/${day.date}`).then(r => r.json()),
    ]).then(([cd, se, trades]) => {
      setChartData(cd);
      setSetupEvents(se || []);
      // Only keep profitable trades with entry data
      setWinningTrades((trades || []).filter(t => parseFloat(t.pnl) > 0 && t.entry_time && t.entry_price));
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [day.date]);

  if (loading) return <div style={{ height: 340, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 13 }}>Loading chart…</div>;
  if (!chartData?.bars?.length) return <div style={{ height: 340, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 13 }}>No bar data for {day.date}</div>;

  // Use RTH bars only (9:30–16:00)
  const bars = chartData.bars.filter(b => {
    const t = new Date(b.ts); const h = t.getUTCHours(), m = t.getUTCMinutes();
    return (h === 9 && m >= 30) || (h > 9 && h < 16) || (h === 16 && m === 0);
  });
  if (!bars.length) return null;

  // SVG dimensions
  const SVG_W = 900, SVG_H = fullSize ? 480 : 340;
  const M = { t: 8, r: 64, b: 22, l: 8 };

  // Levels from winning trades' setup types
  const SETUP_LEVEL_MAP = {
    'pdvah': chartData?.levels?.pdVAH, 'pd vah': chartData?.levels?.pdVAH,
    'pdval': chartData?.levels?.pdVAL, 'pd val': chartData?.levels?.pdVAL,
    'pd high': chartData?.levels?.pdHigh, 'pdhl': chartData?.levels?.pdHigh,
    'pd low':  chartData?.levels?.pdLow,
    'on high': chartData?.levels?.onHigh, 'onhigh': chartData?.levels?.onHigh,
    'on low':  chartData?.levels?.onLow,  'onlow':  chartData?.levels?.onLow,
    'ibh': chartData?.levels?.ibHigh, 'ib high': chartData?.levels?.ibHigh,
    'ibl': chartData?.levels?.ibLow,  'ib low':  chartData?.levels?.ibLow,
    'vwap': null, // handled separately
  };
  const tradeSetupLevels = [];
  winningTrades.forEach(t => {
    const st = (t.setup_type || '').toLowerCase();
    for (const [key, price] of Object.entries(SETUP_LEVEL_MAP)) {
      if (st.includes(key) && price && !tradeSetupLevels.find(l => Math.abs(l.price - price) < 1)) {
        tradeSetupLevels.push({ price: parseFloat(price), label: key.toUpperCase(), color: '#f59e0b' });
      }
    }
  });
  const VP_W = 70; // volume profile width
  const iW = SVG_W - M.l - M.r - VP_W;
  const iH = SVG_H - M.t - M.b;

  // Price domain
  const highs = bars.map(b => parseFloat(b.high)), lows = bars.map(b => parseFloat(b.low));
  const levels = [day.orHigh, day.orLow, day.priorVAH, day.priorVAL, day.aUpLevel, day.aDownLevel].filter(Boolean).map(Number);
  const allPrices = [...highs, ...lows, ...levels].filter(v => v > 1000);
  const rawMin = Math.min(...allPrices), rawMax = Math.max(...allPrices);
  const pad = (rawMax - rawMin) * 0.04;
  const yMin = rawMin - pad, yMax = rawMax + pad;
  const yScale = p => M.t + iH * (1 - (p - yMin) / (yMax - yMin));

  // X scale
  const xScale = i => M.l + VP_W + (i + 0.5) * (iW / bars.length);
  const barW = Math.max(1, iW / bars.length * 0.7);

  // VWAP series aligned to bars
  const vwapMap = {};
  (chartData.vwap || []).forEach(v => { vwapMap[v.ts] = v.vwap; });

  // Volume profile
  const vp = chartData.vpHistogram || [];
  const vpMax = vp.length ? Math.max(...vp.map(v => v.pct)) : 1;
  const vpStats = chartData.vpStats;

  // Setup event markers on chart
  const setupMap = {};
  setupEvents.forEach(e => { setupMap[e.fired_time] = e; });

  // Level config
  const levelLines = [
    { price: day.orHigh,   color: '#60a5fa', dash: '',    label: `IBH ${day.orHigh?.toFixed(0)}`,    width: 1.5 },
    { price: day.orLow,    color: '#60a5fa', dash: '',    label: `IBL ${day.orLow?.toFixed(0)}`,     width: 1.5 },
    { price: day.priorVAH, color: '#22c55e', dash: '4 3', label: `PD VAH ${day.priorVAH?.toFixed(0)}`, width: 1 },
    { price: day.priorVAL, color: '#ef4444', dash: '4 3', label: `PD VAL ${day.priorVAL?.toFixed(0)}`, width: 1 },
    { price: day.aUpLevel && day.aUpFired ? day.aUpLevel : null,   color: '#22c55e', dash: '', label: `A Up ${day.aUpLevel?.toFixed(0)}`,   width: 1.5 },
    { price: day.aDownLevel && day.aDownFired ? day.aDownLevel : null, color: '#ef4444', dash: '', label: `A Dn ${day.aDownLevel?.toFixed(0)}`, width: 1.5 },
  ].filter(l => l.price && parseFloat(l.price) > yMin && parseFloat(l.price) < yMax);

  // Top setups that paid
  const paidSetups = setupEvents.filter(e =>
    ['A Up fired','A Down fired','Failed A Up','Failed A Down','A Up + C Confirmed','A Down + C Confirmed'].some(k => e.setup_type?.includes(k.replace(/ /g,'_').replace(/\+/g,'').replace(/__/g,'_')))
  ).slice(0, 3);

  const setupColor = { 'A Up fired': '#22c55e', 'A Down fired': '#ef4444', 'Failed A Up': '#f97316', 'Failed A Down': '#a78bfa', 'C Up confirmed': '#86efac', 'C Down confirmed': '#fca5a5' };

  return (
    <div>
      {/* SVG Chart */}
      <div style={{ background: '#0d1117', borderRadius: 8, border: '1px solid var(--border-color)', overflow: 'hidden', position: 'relative' }}>
        <svg width="100%" viewBox={`0 0 ${SVG_W} ${SVG_H}`} preserveAspectRatio="xMidYMid meet"
          style={{ display: 'block' }}
          onMouseMove={e => {
            const rect = e.currentTarget.getBoundingClientRect();
            const svgX = (e.clientX - rect.left) / rect.width * SVG_W - M.l - VP_W;
            const idx = Math.round(svgX / (iW / bars.length) - 0.5);
            if (idx >= 0 && idx < bars.length) setHover(idx);
          }}
          onMouseLeave={() => setHover(null)}>

          {/* Background */}
          <rect width={SVG_W} height={SVG_H} fill="#0d1117" />

          {/* Grid lines */}
          {[0.25, 0.5, 0.75].map(pct => {
            const y = M.t + iH * pct;
            const price = yMax - (yMax - yMin) * pct;
            return <g key={pct}>
              <line x1={M.l + VP_W} x2={SVG_W - M.r} y1={y} y2={y} stroke="rgba(255,255,255,0.06)" strokeWidth={1} />
              <text x={SVG_W - M.r + 4} y={y + 4} fill="#475569" fontSize={9}>{price.toFixed(0)}</text>
            </g>;
          })}

          {/* Volume profile */}
          <g transform={`translate(${M.l},${M.t})`}>
            {vp.map((entry, i) => {
              const bucketH = 0.25;
              const y = yScale(entry.price + bucketH) - M.t;
              const yBot = yScale(entry.price) - M.t;
              const bH = Math.max(1, yBot - y);
              const barWvp = (entry.pct / vpMax) * (VP_W - 4);
              const isPoc = vpStats && Math.abs(entry.price - vpStats.poc) < 0.2;
              const isVA = vpStats && entry.price >= vpStats.val && entry.price <= vpStats.vah;
              return <rect key={i} x={0} y={y} width={Math.max(1, barWvp)} height={bH}
                fill={isPoc ? '#f0abfc' : isVA ? 'rgba(139,92,246,0.55)' : 'rgba(100,116,139,0.25)'} />;
            })}
          </g>

          {/* Level lines */}
          {levelLines.map(l => {
            const y = yScale(parseFloat(l.price));
            return <g key={l.label}>
              <line x1={M.l + VP_W} x2={SVG_W - M.r} y1={y} y2={y} stroke={l.color} strokeWidth={l.width} strokeDasharray={l.dash} opacity={0.85} />
              <text x={SVG_W - M.r + 3} y={y - 2} fill={l.color} fontSize={9} fontWeight="600">{l.label}</text>
            </g>;
          })}

          {/* VWAP */}
          {bars.map((b, i) => {
            const vw = vwapMap[b.ts];
            if (!vw || !bars[i + 1]) return null;
            const vwNext = vwapMap[bars[i + 1].ts];
            if (!vwNext) return null;
            return <line key={i} x1={xScale(i)} y1={yScale(parseFloat(vw))} x2={xScale(i + 1)} y2={yScale(parseFloat(vwNext))} stroke="#eab308" strokeWidth={1.5} opacity={0.9} />;
          })}

          {/* Candlesticks */}
          {bars.map((b, i) => {
            const o = parseFloat(b.open), h = parseFloat(b.high), l = parseFloat(b.low), c = parseFloat(b.close);
            const x = xScale(i);
            const yH = yScale(h), yL = yScale(l), yO = yScale(o), yC = yScale(c);
            const bull = c >= o;
            const color = bull ? '#26a69a' : '#ef5350';
            const bodyTop = Math.min(yO, yC), bodyH = Math.max(1, Math.abs(yO - yC));
            return <g key={i}>
              <line x1={x} x2={x} y1={yH} y2={yL} stroke={color} strokeWidth={0.8} opacity={0.9} />
              <rect x={x - barW / 2} y={bodyTop} width={barW} height={bodyH} fill={color} opacity={0.9} />
            </g>;
          })}

          {/* Trade setup extra levels */}
          {tradeSetupLevels.map((l, i) => {
            if (l.price < yMin || l.price > yMax) return null;
            const y = yScale(l.price);
            return <g key={`tsl-${i}`}>
              <line x1={M.l + VP_W} x2={SVG_W - M.r} y1={y} y2={y} stroke={l.color} strokeWidth={1} strokeDasharray="6 3" opacity={0.7} />
              <text x={SVG_W - M.r + 3} y={y - 2} fill={l.color} fontSize={8}>{l.label}</text>
            </g>;
          })}

          {/* Winning trade entries removed — timestamps were off */}

          {/* ACD Setup event markers */}
          {setupEvents.map((e, i) => {
            const barIdx = bars.findIndex(b => new Date(b.ts).toISOString().slice(11, 16) === e.fired_time);
            if (barIdx < 0) return null;
            const x = xScale(barIdx);
            const y = yScale(parseFloat(e.fired_price));
            const isLong = e.setup_type?.includes('A_UP') || e.setup_type?.includes('Failed_A_Down');
            const color = isLong ? '#22c55e' : '#ef4444';
            return <g key={`se-${i}`}>
              <polygon points={isLong ? `${x},${y + 10} ${x - 5},${y + 18} ${x + 5},${y + 18}` : `${x},${y - 10} ${x - 5},${y - 18} ${x + 5},${y - 18}`} fill={color} opacity={0.9} />
            </g>;
          })}

          {/* Hover crosshair — price + time only */}
          {hover !== null && hover < bars.length && (() => {
            const b = bars[hover];
            const x = xScale(hover);
            const c = parseFloat(b.close);
            const yC = yScale(c);
            return <g>
              <line x1={M.l + VP_W} x2={SVG_W - M.r} y1={yC} y2={yC} stroke="rgba(255,255,255,0.15)" strokeWidth={1} strokeDasharray="2 4" />
              <line x1={x} x2={x} y1={M.t} y2={SVG_H - M.b} stroke="rgba(255,255,255,0.15)" strokeWidth={1} strokeDasharray="2 4" />
              <rect x={SVG_W - M.r + 2} y={yC - 8} width={58} height={16} rx={3} fill="#1e293b" stroke="rgba(100,116,139,0.6)" strokeWidth={1} />
              <text x={SVG_W - M.r + 6} y={yC + 4} fill="#e2e8f0" fontSize={9} fontFamily="monospace">{c.toFixed(2)}</text>
              <rect x={x - 20} y={SVG_H - M.b + 2} width={40} height={14} rx={3} fill="#1e293b" stroke="rgba(100,116,139,0.6)" strokeWidth={1} />
              <text x={x} y={SVG_H - M.b + 12} fill="#94a3b8" fontSize={8} textAnchor="middle">{new Date(b.ts).toISOString().slice(11, 16)}</text>
            </g>;
          })()}

          {/* X-axis time labels */}
          {bars.map((b, i) => {
            const t = new Date(b.ts).toISOString().slice(11, 16);
            if (!t.endsWith(':00') && !t.endsWith(':30')) return null;
            const x = xScale(i);
            return <text key={i} x={x} y={SVG_H - 6} fill="#475569" fontSize={8} textAnchor="middle">{t.slice(0, 5)}</text>;
          })}

          {/* IB range label */}
          {day.orHigh && day.orLow && (
            <text x={M.l + VP_W + 4} y={M.t + 12} fill="#60a5fa" fontSize={9} opacity={0.7}>
              IB {(day.orHigh - day.orLow).toFixed(0)}pts
            </text>
          )}
        </svg>
      </div>

      {/* Profitable setups */}
      <div style={{ marginTop: 10 }}>
        <div style={{ fontSize: 11, color: '#475569', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          Profitable setups — minimum 15pt move
        </div>
        {setupEvents.length === 0 ? (
          <div style={{ fontSize: 11, color: '#475569' }}>No setups met the 15pt threshold this session.</div>
        ) : (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {setupEvents.map((e, i) => {
              const color = e.direction === 'LONG' ? '#22c55e' : '#ef4444';
              const typeColor = e.type === 'ACD' ? '#3b82f6' : e.type === 'VWAP' ? '#eab308' : '#94a3b8';
              return (
                <div key={i} style={{ padding: '7px 12px', background: `${color}10`, border: `1px solid ${color}40`, borderRadius: 7, fontSize: 11, minWidth: 140 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: typeColor, background: `${typeColor}20`, padding: '1px 5px', borderRadius: 3 }}>{e.type}</span>
                    <span style={{ fontWeight: 700, color }}>{e.direction}</span>
                    <span style={{ fontWeight: 800, color, marginLeft: 'auto', fontFamily: 'monospace' }}>+{e.move_pts}pts</span>
                  </div>
                  <div style={{ fontWeight: 600, color: '#e2e8f0', fontSize: 12 }}>{e.setup}</div>
                  <div style={{ color: '#64748b', marginTop: 2, display: 'flex', gap: 8 }}>
                    <span style={{ fontFamily: 'monospace' }}>{e.price?.toFixed(2)}</span>
                    <span>{e.time} ET</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Auction Read Card ──────────────────────────────────────────────────────────

function generatePreMarketBias(inv, val, nlTrend, pivotBias, profile, ltCtx) {
  if (!inv || !val) return null;
  const nlDir = nlTrend === 'TRENDING_UP' ? 'up' : nlTrend === 'TRENDING_DOWN' ? 'down' : 'ranging';

  // Price structure (inventory + value position) determines TODAY's directional bias.
  // NL provides multi-session context — it can conflict with today's structure.
  const structureLong  = (inv === 'SHORT_TRAPPED' && val !== 'BELOW_VALUE') ||
                         (inv === 'NEUTRAL'        && val === 'ABOVE_VALUE');
  const structureShort = (inv === 'LONG_TRAPPED'  && val !== 'ABOVE_VALUE') ||
                         (inv === 'NEUTRAL'        && val === 'BELOW_VALUE');
  const structureNeutral = inv === 'NEUTRAL' && val === 'INSIDE_VALUE';

  const structureDir = structureLong ? 'LONG' : structureShort ? 'SHORT' : 'NEUTRAL';
  const nlConflicts = (structureLong && nlDir === 'down') || (structureShort && nlDir === 'up');

  if (structureNeutral) {
    return { direction: 'NEUTRAL', text: 'Neutral inventory + inside value — balanced day expected. Neither buyers nor sellers have structural advantage. Fade the extremes, responsive playbook. Wait for OR to break with commitment.' };
  }

  if (structureLong && !nlConflicts) {
    const strong = inv === 'SHORT_TRAPPED' && val === 'ABOVE_VALUE';
    return {
      direction: 'LONG',
      text: strong
        ? 'Short inventory + above value — strong long bias. Short sellers are trapped and price is above accepted value. Short covering can drive a fast upside move. Go with A Up.'
        : `${inv === 'SHORT_TRAPPED' ? 'Short inventory' : 'Neutral inventory'} + ${val === 'ABOVE_VALUE' ? 'above value' : 'inside value'} — long lean. Buyers have the structural advantage${nlDir === 'up' ? ' and the NL confirms uptrend' : ''}. Watch for OR to accept above value.`
    };
  }

  if (structureShort && !nlConflicts) {
    const strong = inv === 'LONG_TRAPPED' && val === 'BELOW_VALUE';
    return {
      direction: 'SHORT',
      text: strong
        ? 'Long inventory + below value — strong short bias. Buyers are trapped and price is below accepted value. Failed recovery attempts are selling opportunities. Go with A Down.'
        : `${inv === 'LONG_TRAPPED' ? 'Long inventory' : 'Neutral inventory'} + ${val === 'BELOW_VALUE' ? 'below value' : 'inside value'} — short lean. Sellers have the structural advantage${nlDir === 'down' ? ' and the NL confirms downtrend' : ''}. Watch for OR to reject below value.`
    };
  }

  // Structure and NL conflict — the most important case to handle correctly
  if (nlConflicts) {
    if (structureShort && nlDir === 'up') {
      return {
        direction: 'SHORT',
        text: `Price structure says SHORT (${inv === 'LONG_TRAPPED' ? 'long inventory trapped' : 'neutral'} + below value) but NL is trending up — the multi-session trend is bullish. Today's setup is a PULLBACK within an uptrend. Lean short for the session, but do not hold overnight. Exit if price recovers above value.`
      };
    }
    if (structureLong && nlDir === 'down') {
      return {
        direction: 'LONG',
        text: `Price structure says LONG (${inv === 'SHORT_TRAPPED' ? 'short inventory trapped' : 'neutral'} + above value) but NL is trending down — the multi-session trend is bearish. Today's setup is a BOUNCE within a downtrend. Lean long for the session only. Do not hold overnight. Exit if price loses value.`
      };
    }
  }

  return { direction: 'NEUTRAL', text: 'Mixed signals — use opening behavior to determine direction.' };
}

function buildLtContextSentence(ltCtx) {
  if (!ltCtx) return null;
  const { bracketState, nl30, nl10, valueMigration, weekType } = ltCtx;
  const parts = [];

  if (nl30 != null) {
    if (nl30 > 9) parts.push(`NL30 +${nl30} (confirmed uptrend — structural tailwind for longs)`);
    else if (nl30 < -9) parts.push(`NL30 ${nl30} (confirmed downtrend — structural tailwind for shorts)`);
    else parts.push(`NL30 ${nl30 > 0 ? '+' : ''}${nl30} (ranging — no multi-session directional edge)`);
    if (nl10 != null && nl30 > 9 && nl10 < 0) parts.push(`10-day NL diverging negative — shorter-term momentum weakening despite 30-day uptrend`);
    else if (nl10 != null && nl30 < -9 && nl10 > 0) parts.push(`10-day NL diverging positive — shorter-term momentum weakening despite 30-day downtrend`);
  }
  if (bracketState) {
    if (bracketState === 'TRENDING_UP') parts.push(`market structure: TRENDING UP — initiative playbook, go with extensions`);
    else if (bracketState === 'TRENDING_DOWN') parts.push(`market structure: TRENDING DOWN — initiative playbook, go with extensions`);
    else if (bracketState === 'TRANSITIONAL') parts.push(`market structure: TRANSITIONAL — reduce size, 5-day and 10-day structure disagree`);
    else parts.push(`market structure: BRACKET — responsive playbook, fade extremes`);
  }
  if (valueMigration === 'HIGHER') parts.push(`value migrating higher (${3} consecutive days)`);
  else if (valueMigration === 'LOWER') parts.push(`value migrating lower`);
  else if (valueMigration === 'OVERLAPPING') parts.push(`value areas overlapping — balance`);
  if (weekType) parts.push(`${weekType.replace('_',' ')} week developing`);

  return parts.length ? parts.join(' · ') : null;
}

function generateSessionBias(p1Direction, orCondition, openingCall, aSignal) {
  if (!p1Direction || !openingCall) return null;
  const longBias  = p1Direction === 'LONG';
  const shortBias = p1Direction === 'SHORT';
  const callLong  = openingCall === 'OPEN_DRIVE_UP' || openingCall === 'OPEN_TEST_DRIVE_UP';
  const callShort = openingCall === 'OPEN_DRIVE_DOWN' || openingCall === 'OPEN_TEST_DRIVE_DOWN';
  const callLong2 = openingCall === 'OPEN_DRIVE' || openingCall === 'OPEN_TEST_DRIVE';
  const aLong  = aSignal && (aSignal.includes('A_UP_') || aSignal === 'A_UP');
  const aShort = aSignal && (aSignal.includes('A_DOWN_') || aSignal === 'A_DOWN');
  const aFailed= aSignal && aSignal.includes('FAILED');

  const allAligned = (longBias && (callLong || callLong2) && aLong) || (shortBias && callShort && aShort);
  const conflicting = (longBias && aShort) || (shortBias && aLong) || (longBias && callShort) || (shortBias && (callLong || callLong2));

  if (allAligned) return { level: 'GREEN', text: `All signals aligned ${longBias ? 'long' : 'short'} — pre-market bias, opening call, and A signal confirm. High conviction.` };
  if (conflicting) return { level: 'RED',   text: `Conflicting signals — pre-market says ${longBias ? 'long' : 'short'} but opening behavior disagrees. Stand aside until clarity.` };
  return { level: 'AMBER', text: `Mixed signals — pre-market ${longBias ? 'long' : 'short'} bias with unclear opening confirmation. Reduce size, wait for A signal.` };
}

function buildAuctionExplanations(ctx) {
  const { orHigh, orLow, priorVAH, priorVAL, priorPOC, nqPrice, aUpLevel, aDownLevel,
          avgOrRange, orRange, timeline = [], sessionHigh, sessionLow } = ctx || {};

  const p  = v => v ? parseFloat(v).toFixed(2) : '—';
  const pts = (a, b) => (a && b) ? Math.abs(parseFloat(a) - parseFloat(b)).toFixed(0) + 'pts' : '';

  // Timeline helpers
  const find = (evt) => timeline.find(e => e.event?.includes(evt));
  const aUpTest   = find('A Up tested');
  const failedAUp = find('Failed A Up');
  const aDownFire = find('A Down fired');
  const aDownTest = find('A Down tested');

  return {
    overnight_inventory: {
      SHORT_TRAPPED: `Short sellers from the prior session are trapped above current price — they sold and price moved against them. Their pain creates a forced-buy trigger: if price surges above their entries, they cover (buy) to stop losses.\n\nPrior day VAH (top of value): ${p(priorVAH)}. NQ at ${p(nqPrice)} — ${priorVAH && nqPrice ? pts(priorVAH, nqPrice) + ' ' + (parseFloat(nqPrice) > parseFloat(priorVAH) ? 'above' : 'below') + ' prior VAH.' : ''}. Short covering pressure builds if price reclaims ${p(priorVAH)}.`,
      LONG_TRAPPED:  `Buyers from the prior session are trapped below current price — they bought and price moved against them. Every rally attempt gets sold into by trapped longs trying to exit flat. Their exits create natural overhead resistance.\n\nPrior day VAL (bottom of value): ${p(priorVAL)}. NQ at ${p(nqPrice)} — ${priorVAL && nqPrice ? pts(priorVAL, nqPrice) + ' ' + (parseFloat(nqPrice) < parseFloat(priorVAL) ? 'below' : 'above') + ' prior VAL' : ''}. Trapped longs become sellers if price cannot recover above ${p(priorVAL)}.`,
      NEUTRAL:       `Neither buyers nor sellers are significantly offside from the prior session. No forced activity expected. Prior day value area: ${p(priorVAL)} – ${p(priorVAH)}, POC ${p(priorPOC)}. NQ at ${p(nqPrice)}. Direction will be determined by which side commits first at the open.`,
    },
    open_vs_prior_value: {
      ABOVE_VALUE:  `Price opened above yesterday's accepted range (VAH: ${p(priorVAH)}). Buyers are willing to transact at a premium — bullish conviction. Sellers who held from yesterday are already losing from the open.\n\nOpening reference: OR High ${p(orHigh)}, OR Low ${p(orLow)}. Prior VAH ${p(priorVAH)} is now support. If price holds above it, buyers remain in control.`,
      BELOW_VALUE:  `Price opened below yesterday's value area (VAL: ${p(priorVAL)}). Sellers are in structural control. Buyers from yesterday are already underwater.\n\nOR: ${p(orHigh)} / ${p(orLow)}. Prior VAL ${p(priorVAL)} is now resistance. If price cannot recover above ${p(priorVAL)}, sellers gain confidence and the downside extends toward prior POC ${p(priorPOC)}.`,
      INSIDE_VALUE: `Price opened within yesterday's value area (${p(priorVAL)} – ${p(priorVAH)}, POC ${p(priorPOC)}). Both sides see current prices as fair — two-sided trade expected.\n\nOR: ${p(orHigh)} / ${p(orLow)}. A break above ${p(priorVAH)} with buyers committing = bullish. A break below ${p(priorVAL)} with sellers committing = bearish.`,
    },
    prior_day_profile: {
      TREND:                   `Yesterday's dominant side had complete control — no meaningful pushback from the other side. Today the same dominant side likely maintains the edge. Do not fade.\n\nOR today: ${p(orHigh)} / ${p(orLow)} (${orRange ? orRange.toFixed(0) + 'pts' : ''}). If the trend continues, watch for a break of OR High ${p(orHigh)} (long) or OR Low ${p(orLow)} (short) with sustained commitment.`,
      NORMAL_VARIATION:        `Yesterday extended beyond the opening range but not dramatically — some directional conviction but both sides participated. Today similar range expected.\n\nOR today: ${p(orHigh)} / ${p(orLow)}. Normal Variation extension target: approximately ${orHigh && orLow && orRange ? (parseFloat(orHigh) + orRange * 0.5).toFixed(0) + ' (up) / ' + (parseFloat(orLow) - orRange * 0.5).toFixed(0) + ' (down)' : '—'}.`,
      NORMAL:                  `Yesterday buyers and sellers reached fair agreement — balanced near the opening range. EFFICIENT market: responsive strategy today.\n\nOR today: ${p(orHigh)} / ${p(orLow)}. Sell near OR High ${p(orHigh)}, buy near OR Low ${p(orLow)}. Neither side has dominance until one breaks the OR with volume.`,
      NEUTRAL:                 `Buyers and sellers tested both sides and found balance at the middle. Today likely two-sided. Fade both extremes.\n\nOR today: ${p(orHigh)} / ${p(orLow)}. Prior day POC: ${p(priorPOC)} — this is the gravitational center. Price tends to rotate back here.`,
      RUNNING_PROFILE_NEUTRAL: `Neutral structure but closed near one extreme. The dominant side showed conviction late. Today expect follow-through in that direction.\n\nOR today: ${p(orHigh)} / ${p(orLow)}. Prior VAH: ${p(priorVAH)}, VAL: ${p(priorVAL)}. The trapped side will fuel the move if price breaks their level.`,
      NONTREND:                `Extremely tight range — perfect balance between buyers and sellers yesterday. Today one side breaks and moves sharply.\n\nOR today: ${p(orHigh)} / ${p(orLow)} (${orRange ? orRange.toFixed(0) + 'pts' : ''}). The first sustained directional move sets the tone. High-quality setup when it comes — wait for OR to break with commitment.`,
    },
    or_condition: {
      NARROW:    `Tight OR — buyers and sellers found quick agreement. One side will get frustrated and break out.\n\nToday's OR: ${p(orHigh)} / ${p(orLow)} = ${orRange ? orRange.toFixed(0) : '—'}pts (30-day avg: ${avgOrRange ? avgOrRange.toFixed(0) : '—'}pts). Extensions beyond ${p(orHigh)} (long) or ${p(orLow)} (short) have stronger follow-through on narrow ORs.`,
      NORMAL:    `Standard OR — buyers and sellers found initial balance within the normal window.\n\nToday's OR: ${p(orHigh)} / ${p(orLow)} = ${orRange ? orRange.toFixed(0) : '—'}pts (avg: ${avgOrRange ? avgOrRange.toFixed(0) : '—'}pts). A Up level: ${p(aUpLevel)} — buyers must hold above here. A Down level: ${p(aDownLevel)} — sellers must hold below.`,
      WIDE:      `Wide OR — aggressive fight between buyers and sellers in the opening minutes.\n\nToday's OR: ${p(orHigh)} / ${p(orLow)} = ${orRange ? orRange.toFixed(0) : '—'}pts (${avgOrRange && orRange ? ((orRange / avgOrRange) * 100).toFixed(0) + '% of avg' : ''}). Wide ORs often see the initial extreme fail. The A levels (${p(aUpLevel)} / ${p(aDownLevel)}) are well outside — respect them if tested.`,
      EMOTIONAL: `Extreme opening volatility. Panic activity dominated.\n\nToday's OR: ${p(orHigh)} / ${p(orLow)} = ${orRange ? orRange.toFixed(0) : '—'}pts (${avgOrRange && orRange ? ((orRange / avgOrRange) * 100).toFixed(0) + '% of avg' : ''}). These extremes almost always fail. Session high so far: ${p(sessionHigh)}, low: ${p(sessionLow)}. Fade the initial extreme once volume dries up.`,
    },
    opening_call_type: {
      OPEN_DRIVE:             `Buyers (up) or sellers (down) committed immediately with no pullback. High directional conviction.\n\nOR: ${p(orHigh)} / ${p(orLow)}. ${aUpTest ? `A Up tested ${aUpTest.time} at ${p(aUpTest.price)}.` : ''} ${aDownFire ? `A Down fired ${aDownFire.time} at ${p(aDownFire.price)}.` : ''} Trade with the drive.`,
      OPEN_TEST_DRIVE:        `The dominant side tested prior levels first, found no opposition, then drove directionally.\n\nOR: ${p(orHigh)} / ${p(orLow)}. ${aUpTest ? `A Up tested ${aUpTest.time} at ${p(aUpTest.price)}.` : ''} ${aDownFire ? `A Down fired ${aDownFire.time} at ${p(aDownFire.price)}.` : ''} More selective than Open Drive — equal commitment once confirmed.`,
      OPEN_REJECTION_REVERSE: `The market tested a key level, found aggressive opposition, and reversed hard.\n\n${failedAUp ? `A Up level (${p(aUpLevel)}) tested at ${aUpTest?.time || '—'} and rejected at ${failedAUp.time} — price: ${p(failedAUp.price)}.` : `OR High ${p(orHigh)} tested and rejected.`} ${aDownFire ? `A Down fired at ${aDownFire.time} (${p(aDownFire.price)}) — sellers took structural control.` : ''} Current price ${p(nqPrice)} is ${orLow && nqPrice ? pts(orLow, nqPrice) : '—'} ${nqPrice && orLow && parseFloat(nqPrice) < parseFloat(orLow) ? 'below OR Low' : 'from OR Low'}.`,
      OPEN_AUCTION:           `Neither buyers nor sellers committed directionally. Both sides exploring, rotating back and forth.\n\nOR: ${p(orHigh)} / ${p(orLow)}. No directional trade until one side breaks with real commitment. False breakouts common. A Up ${p(aUpLevel)}, A Down ${p(aDownLevel)} are the commitment levels to watch.`,
    },
  };
}

const P3_EXPLANATIONS = {
  p3_value_migrating:      'YES = the value area is shifting in your bias direction — buyers accepted higher (longs) or sellers accepted lower (shorts). The market is building NEW fair value in your direction. Strongest continuation signal.\nNO = value area holding or moving against you — the market is rejecting the move. Reversal risk rising.',
  p3_vwap_holding:         'YES = price staying above VWAP (long bias) or below VWAP (short bias). The dominant side — buyers (longs) or sellers (shorts) — is defending the mean. Structural support for the trend.\nNO = price crossed VWAP. The other side is gaining control. The move is losing structural backing.',
  p3_delta_confirming:     'YES = buy/sell volume imbalance confirms the price direction. Real buyers are pushing price up (longs) or real sellers pushing down (shorts). Sustainable move.\nNO = price moving on thin volume or against delta — the move is unsustainable. High reversal risk when delta diverges from price.',
  p3_auction_accepted:     'YES = price has spent multiple time periods at the new level. Buyers (longs) or sellers (shorts) are comfortable transacting there. The move has acceptance, not just a spike — other participants are joining.\nNO = price visited briefly then returned. Not accepted. High probability of rotating back to prior value.',
  p3_rotations_increasing: 'YES = distance between successive swing highs and lows is growing. Both buyers and sellers are becoming equally aggressive — balance is forming. The trending move is exhausting. Tighten stops, no new entries.\nNO = rotations small and directional. Trend still intact, dominant side still in control. Stay in.',
};

const SESSION_EXPECTATION_TFS = [
  { id: 30,  label: '30d' },
  { id: 60,  label: '60d' },
  { id: 90,  label: '90d' },
  { id: 0,   label: 'All' },
];

function ThisSetupHistorically() {
  const [match, setMatch] = React.useState(undefined); // undefined=loading, null=no match
  const [ctx, setCtx]     = React.useState(null);
  const [days, setDays]   = React.useState(30); // default 30 days

  React.useEffect(() => {
    setMatch(undefined); // show loading on tf change
    fetch(`${API_URL}/pattern/today-combination?days=${days}`)
      .then(r => r.json())
      .then(d => { setMatch(d.match || null); setCtx(d.context); })
      .catch(() => setMatch(null));
  }, [days]);

  if (match === undefined) return null; // still loading — silent

  const trendColor = { IMPROVING: '#22c55e', STABLE: '#94a3b8', DEGRADING: '#ef4444' };
  const trendIcon  = { IMPROVING: '↑', STABLE: '→', DEGRADING: '↓' };

  return (
    <div style={{ margin: '8px 0', padding: '10px 14px', background: 'rgba(0,0,0,0.15)', border: '1px solid rgba(100,116,139,0.2)', borderRadius: 8, fontFamily: 'Arial, sans-serif' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, flexWrap: 'wrap', gap: 6 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: '#94a3b8', letterSpacing: '0.07em', textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: 4 }}>
          Session Expectation
          <InfoTooltip tooltip={{
            text: 'Shows performance in sessions with the same combination of structural state, NL30 level, opening call type, and A signal quality. Updated nightly after each session.',
            source: 'Based on your logged sessions — not theoretical price data backtests'
          }} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {ctx && <div style={{ fontSize: 13, color: '#94a3b8', fontFamily: 'monospace' }}>{ctx.structState} · {ctx.nl30Bucket}</div>}
          <div style={{ display: 'flex', gap: 3 }}>
            {SESSION_EXPECTATION_TFS.map(tf => (
              <button key={tf.id} onClick={() => setDays(tf.id)}
                style={{ fontSize: 13, padding: '2px 9px', borderRadius: 5, cursor: 'pointer',
                  border: `1px solid ${days === tf.id ? '#6366f1' : 'var(--border-color)'}`,
                  background: days === tf.id ? 'rgba(99,102,241,0.2)' : 'transparent',
                  color: days === tf.id ? '#818cf8' : '#94a3b8',
                  fontWeight: days === tf.id ? 700 : 400 }}>
                {tf.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {match === undefined ? (
        <div style={{ fontSize: 13, color: '#94a3b8' }}>Loading…</div>
      ) : !match ? (
        <div style={{ fontSize: 13, color: '#94a3b8' }}>
          No matching sessions in {days > 0 ? `last ${days} days` : 'history'} — try a wider window.
        </div>
      ) : !match.sufficient_data ? (
        <div style={{ fontSize: 13, color: '#a0aec0', lineHeight: 1.7 }}>
          <span style={{ color: '#fbbf24', fontWeight: 700 }}>{match.occurrences} matching sessions</span> in {days > 0 ? `last ${days} days` : 'all time'} — building data
          {match.win_rate != null && <span> · Win rate so far: <strong style={{ color: '#fbbf24' }}>{(match.win_rate * 100).toFixed(0)}%</strong></span>}
          <span style={{ color: '#94a3b8' }}> (need 10+ sessions for reliability)</span>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 13, color: '#94a3b8' }}>
              {match.occurrences} sessions
              {match.total_occurrences && match.total_occurrences !== match.occurrences
                ? <span style={{ color: '#64748b' }}> of {match.total_occurrences} total</span>
                : null}
            </div>
            <div style={{ fontSize: 15, fontWeight: 800, color: trendColor[match.win_rate_trend] || '#a0aec0', fontFamily: 'monospace' }}>
              {match.win_rate != null ? (match.win_rate * 100).toFixed(1) : '—'}%
              {match.win_rate_trend && <span style={{ fontSize: 13, marginLeft: 4 }}>{trendIcon[match.win_rate_trend]} {match.win_rate_trend}</span>}
            </div>
            <div style={{ fontSize: 13, color: '#94a3b8' }}>win rate</div>
          </div>
          {match.avg_pnl != null && (
            <div>
              <div style={{ fontSize: 13, color: '#94a3b8' }}>avg P&L</div>
              <div style={{ fontSize: 15, fontWeight: 800, color: match.avg_pnl > 0 ? '#22c55e' : '#ef4444', fontFamily: 'monospace' }}>
                {match.avg_pnl > 0 ? '+' : ''}{Number(match.avg_pnl).toFixed(0)}
              </div>
            </div>
          )}
          {match.t1_hit_rate != null && (
            <div>
              <div style={{ fontSize: 13, color: '#94a3b8' }}>T1 hit rate</div>
              <div style={{ fontSize: 15, fontWeight: 800, color: '#a0aec0', fontFamily: 'monospace' }}>{(match.t1_hit_rate * 100).toFixed(0)}%</div>
            </div>
          )}
          <div style={{ marginLeft: 'auto', fontSize: 13, color: '#94a3b8', textAlign: 'right', lineHeight: 1.6 }}>
            {match.first_seen && <span>First: {match.first_seen}<br/></span>}
            {match.last_seen  && <span>Last: {match.last_seen}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

function AuctionReadCard({ nl, todayData }) {
  const [read, setRead] = React.useState({});
  const [openPhases, setOpenPhases] = React.useState(new Set([]));
  const [expandedRows, setExpandedRows] = React.useState(new Set());
  const [saving, setSaving] = React.useState(false);
  const [nqLive, setNqLive] = React.useState(null);
  const [autoDetected, setAutoDetected] = React.useState({});
  const [liveCtx, setLiveCtx] = React.useState(null);
  const [ltSummary, setLtSummary] = React.useState(null);
  const [confluenceData, setConfluenceData] = React.useState(null);

  React.useEffect(() => {
    fetch(`${API_URL}/acd/nq/latest`).then(r => r.json()).then(setNqLive).catch(() => {});
    fetch(`${API_URL}/auction-read/auto`).then(r => r.json()).then(setAutoDetected).catch(() => {});
    fetch(`${API_URL}/longterm/summary`).then(r => r.json()).then(d => { if (!d.error) setLtSummary(d); }).catch(() => {});
    const loadConf = () => fetch(`${API_URL}/confluence/today`).then(r => r.json()).then(d => { if (!d.error) setConfluenceData(d); }).catch(() => {});
    loadConf();
    const confIv = setInterval(loadConf, 5 * 60 * 1000);
    const loadLive = () => fetch(`${API_URL}/acd/live`).then(r => r.json()).then(setLiveCtx).catch(() => {});
    loadLive();
    const iv = setInterval(loadLive, 60000);
    return () => { clearInterval(iv); clearInterval(confIv); };
  }, []);

  // ET time for phase locking
  const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const etMin  = nowET.getHours() * 60 + nowET.getMinutes();
  const phase1Locked = etMin >= 9 * 60 + 30;
  const phase2Locked = etMin >= 9 * 60 + 45;
  const inSession    = etMin >= 9 * 60 + 45 && etMin < 11 * 60;

  React.useEffect(() => {
    fetch(`${API_URL}/auction-read/today`).then(r => r.json()).then(d => {
      const stored = d || {};
      // Pre-fill auto-detected P1 values for fields not yet set by user.
      // For P3: use prev state (which may have been auto-filled from liveCtx) when DB has null —
      // this prevents the ...stored spread from wiping out live-computed P3 values.
      setRead({
        overnight_inventory: stored.overnight_inventory || autoDetected.overnight_inventory,
        open_vs_prior_value: stored.open_vs_prior_value || autoDetected.open_vs_prior_value,
        or_condition:        stored.or_condition        || autoDetected.or_condition,
        prior_day_profile:   stored.prior_day_profile   || autoDetected.prior_day_profile,
        opening_call_type:   stored.opening_call_type   || liveCtx?.opening_call_type,
        ...stored,
      });
    }).catch(() => {});
  }, [autoDetected]);

  const save = async (updates) => {
    const merged = { ...read, ...updates };
    setRead(merged);
    setSaving(true);
    try {
      await fetch(`${API_URL}/auction-read/today`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(merged) });
    } catch(e) {}
    setSaving(false);
  };

  const set = (key, val) => save({ [key]: val });
  const toggle = (key) => save({ [key]: !read[key] });

  const p3Keys = ['p3_value_migrating','p3_vwap_holding','p3_delta_confirming','p3_auction_accepted','p3_rotations_increasing'];

  // Derived display-only values
  const nlTrend   = nl?.trend || 'RANGING';
  const nlNum     = nl?.sum30 ?? nl?.nl30 ?? 0;
  const nlLabel   = nlTrend === 'TRENDING_UP' ? 'TRENDING UP' : nlTrend === 'TRENDING_DOWN' ? 'TRENDING DOWN' : 'RANGING';
  const nlColor   = NL_TREND_COLOR[nlTrend] || '#fbbf24';
  const pivotBias = nqLive?.pivotBias?.includes('ABOVE') ? 'up' : nqLive?.pivotBias?.includes('BELOW') ? 'down' : null;
  const pivotLabel = nqLive?.pivotBias?.includes('ABOVE') ? 'ABOVE PIVOT' : nqLive?.pivotBias?.includes('BELOW') ? 'BELOW PIVOT' : '—';
  const pivotColor = pivotBias === 'up' ? '#22c55e' : pivotBias === 'down' ? '#ef4444' : '#94a3b8';
  const marketState = getEfficiencyLabel(read.prior_day_profile);

  // Auto-detect A signal: prefer logged daily data, fall back to live bar analysis
  const liveSignal = todayData?.today;
  const autoASignal = liveSignal?.a_up_fired   ? 'A_UP'
                    : liveSignal?.a_down_fired  ? 'A_DOWN'
                    : liveCtx?.aUpFired         ? 'A_UP'
                    : liveCtx?.aDownFired        ? 'A_DOWN'
                    : null;
  // Auto-detect opening call from live bar analysis
  const autoOpeningCall = liveCtx?.opening_call_type || null;
  const aSignal = read.a_signal_override || autoASignal;

  const ltCtx = ltSummary ? {
    bracketState: ltSummary.bracketState?.state,
    nl30: ltSummary.acd?.nl30,
    nl10: ltSummary.acd?.nl10,
    valueMigration: ltSummary.valueMigration?.direction,
    weekType: ltSummary.weeklyStructure?.weekType,
  } : null;
  const ltSentence = buildLtContextSentence(ltCtx);
  const p1Bias = generatePreMarketBias(read.overnight_inventory, read.open_vs_prior_value, nlTrend, pivotBias, read.prior_day_profile, ltCtx);
  const p1Direction = p1Bias?.direction;
  const sessionBias = generateSessionBias(p1Direction, read.or_condition, read.opening_call_type, aSignal);
  const biasColor = { GREEN: '#22c55e', AMBER: '#fbbf24', RED: '#ef4444' };


  // Selectors
  const Selector = ({ field, options, locked }) => {
    const isAuto = autoDetected[field] && autoDetected[field] === read[field];
    return (
      <div>
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
          {options.map(([val, label]) => {
            const isSelected = read[field] === val;
            const isAutoThis = isSelected && autoDetected[field] === val;
            return (
              <button key={val} disabled={locked} onClick={() => !locked && set(field, val)}
                style={{ padding: '5px 12px', fontSize: 12, borderRadius: 5, cursor: locked ? 'default' : 'pointer',
                  border: `1px solid ${isSelected ? '#3b82f6' : 'var(--border-color)'}`,
                  fontWeight: isSelected ? 700 : 500,
                  background: isSelected ? '#3b82f6' : 'var(--input-bg)',
                  color: isSelected ? '#fff' : '#94a3b8',
                  opacity: locked && !isSelected ? 0.45 : 1 }}>
                {label}
                {isAutoThis && <span style={{ fontSize: 9, marginLeft: 4, opacity: 0.8 }}>●</span>}
              </button>
            );
          })}
        </div>
        {isAuto && <div style={{ fontSize: 11, color: '#3b82f6', marginTop: 3 }}>● auto-detected — tap to override</div>}
      </div>
    );
  };

  const togglePhase = (num) => setOpenPhases(prev => {
    const next = new Set(prev);
    next.has(num) ? next.delete(num) : next.add(num);
    return next;
  });

  // Use shared utilities — fmtTs wraps formatTimestamp for null→null behaviour
  // (components that check "if (fmtTs(x))" still work)
  const fmtTs = (ts) => ts ? formatTimestamp(ts) : null;
  const latestTs = (...tss) => latestOf(...tss);

  const PhaseHeader = ({ num, title, locked, timeLabel }) => {
    // Phase-level manual timestamp
    const manualTs = num === 1 ? read.p1_updated_at : read.p2_updated_at;

    // Field-level timestamps per phase — catches auto-detected values that were saved
    const p1FieldTs = latestTs(read.ts_overnight_inventory, read.ts_open_vs_prior_value, read.ts_prior_day_profile);
    const p2FieldTs = latestTs(read.ts_or_condition, read.ts_opening_call_type, read.ts_a_signal_override);
    const fieldTs   = num === 1 ? p1FieldTs : p2FieldTs;

    // Effective timestamp = latest of manual or field-level
    const effectiveTs = latestTs(manualTs, fieldTs);
    const isManual = manualTs && (!fieldTs || manualTs >= fieldTs);

    // Auto-detection state per phase
    const p1HasAuto = !!(read.overnight_inventory || read.open_vs_prior_value || read.prior_day_profile);
    const p2HasAuto = !!(read.or_condition || liveCtx?.aUpFired || liveCtx?.aDownFired);
    const hasAuto   = num === 1 ? p1HasAuto : p2HasAuto;

    const tsStr = fmtTs(effectiveTs);

    // What to show
    let statusEl;
    if (tsStr && isManual) {
      statusEl = <span style={{ fontSize: 12, color: '#22c55e', fontFamily: 'Arial, sans-serif', fontWeight: 600 }}>✓ manually set {tsStr}</span>;
    } else if (tsStr) {
      statusEl = <span style={{ fontSize: 12, color: '#22c55e', fontFamily: 'Arial, sans-serif', fontWeight: 600 }}>✓ saved {tsStr}</span>;
    } else if (hasAuto) {
      statusEl = <span style={{ fontSize: 12, color: '#3b82f6', fontFamily: 'Arial, sans-serif' }}>● auto-detected — not yet saved</span>;
    } else {
      statusEl = <span style={{ fontSize: 12, color: '#475569', fontFamily: 'Arial, sans-serif' }}>not yet set today</span>;
    }

    return (
    <button onClick={() => togglePhase(num)}
      style={{ width: '100%', background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: openPhases.has(num) ? '1px solid var(--border-color)' : 'none' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: '#3b82f6', letterSpacing: '0.08em' }}>PHASE {num}</span>
        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{title}</span>
        {locked && <span style={{ fontSize: 11, color: '#ef4444', fontWeight: 700, padding: '2px 6px', background: 'rgba(239,68,68,0.15)', borderRadius: 3 }}>LOCKED</span>}
        {timeLabel && !locked && <span style={{ fontSize: 13, color: '#94a3b8', fontFamily: 'Arial, sans-serif' }}>{timeLabel}</span>}
        {statusEl}
      </div>
      <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{openPhases.has(num) ? '▲' : '▼'}</span>
    </button>
    );
  };

  const toggleRow = (key) => setExpandedRows(prev => {
    const next = new Set(prev); next.has(key) ? next.delete(key) : next.add(key); return next;
  });

  // row with field-aware dynamic explanation from lookup
  // Build contextual explanations with real prices/times
  const explCtx = {
    orHigh: liveCtx?.orHigh || todayData?.today?.or_high,
    orLow:  liveCtx?.orLow  || todayData?.today?.or_low,
    orRange: autoDetected?.today_or_range,
    avgOrRange: autoDetected?.avg_or_range,
    priorVAH: autoDetected?.prior_day_vah,
    priorVAL: autoDetected?.prior_day_val,
    priorPOC: autoDetected?.prior_day_poc,
    nqPrice: liveCtx?.currentPrice || nqLive?.close,
    aUpLevel:  liveCtx?.aUpLevel  || todayData?.today?.a_up_level,
    aDownLevel: liveCtx?.aDownLevel || todayData?.today?.a_down_level,
    sessionHigh: liveCtx?.sessionHigh,
    sessionLow:  liveCtx?.sessionLow,
    timeline: liveCtx?.timeline || [],
  };
  const ctxExplanations = buildAuctionExplanations(explCtx);

  const row = (label, children, tip, field) => {
    const dynamicTip = field && read[field] && ctxExplanations[field]?.[read[field]];
    const explanation = dynamicTip || tip;
    const rowKey = field || label;
    const isExpanded = expandedRows.has(rowKey);
    const tsKey = field ? `ts_${field}` : null;
    const fieldTs = tsKey ? fmtTs(read[tsKey]) : null;
    return (
      <div style={{ padding: '8px 0', borderBottom: '1px solid var(--border-color)' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ fontSize: 13, color: '#94a3b8', fontFamily: 'Arial, sans-serif', minWidth: 150, paddingTop: 5, flexShrink: 0 }}>{label}</div>
          <div style={{ flex: 1 }}>{children}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, paddingTop: 4 }}>
            {fieldTs && <span style={{ fontSize: 12, color: '#94a3b8', fontFamily: 'Arial, sans-serif' }}>{fieldTs}</span>}
            {explanation && (
              <button onClick={() => toggleRow(rowKey)}
                style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: isExpanded ? '#3b82f6' : '#94a3b8',
                  fontSize: 12, fontWeight: 600 }}>
                {isExpanded ? '▲ hide' : '▼ why'}
              </button>
            )}
          </div>
        </div>
        {isExpanded && explanation && (
          <div style={{ margin: '8px 0 4px 152px', padding: '10px 14px', background: 'rgba(59,130,246,0.06)', borderLeft: '2px solid #3b82f6', borderRadius: '0 6px 6px 0' }}>
            <div style={{ fontSize: 13, color: '#e2e8f0', lineHeight: 1.7, whiteSpace: 'pre-line' }}>{explanation}</div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={{ background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderRadius: 12, padding: '16px 20px', marginBottom: 16, fontFamily: 'Arial, sans-serif', fontSize: 13, color: '#94a3b8' }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: '#3b82f6', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        Auction Read
        {saving && <span style={{ fontSize: 12, color: '#94a3b8' }}>saving…</span>}
      </div>

      {/* ── PHASE 1 ── */}
      <PhaseHeader num={1} title="Pre-Market" locked={phase1Locked} timeLabel="Fill before 9:30" />
      {openPhases.has(1) && (
        <div style={{ padding: '12px 0' }}>
          {row('Overnight inventory', <Selector field="overnight_inventory" locked={phase1Locked}
            options={[['SHORT_TRAPPED','Short Trapped'],['LONG_TRAPPED','Long Trapped'],['NEUTRAL','Neutral']]} />,
            TOOLTIPS.OVERNIGHT_INVENTORY.text + (TOOLTIPS.OVERNIGHT_INVENTORY.source ? `\n\nSource: ${TOOLTIPS.OVERNIGHT_INVENTORY.source}` : ''), 'overnight_inventory')}
          {row('Open vs prior value', <Selector field="open_vs_prior_value" locked={phase1Locked}
            options={[['ABOVE_VALUE','Above Value'],['INSIDE_VALUE','Inside Value'],['BELOW_VALUE','Below Value']]} />,
            TOOLTIPS.OPEN_VS_PRIOR_VALUE.text + (TOOLTIPS.OPEN_VS_PRIOR_VALUE.source ? `\n\nSource: ${TOOLTIPS.OPEN_VS_PRIOR_VALUE.source}` : ''), 'open_vs_prior_value')}
          {row('Prior day profile', <Selector field="prior_day_profile" locked={phase1Locked}
            options={[['TREND','Trend'],['NORMAL_VARIATION','Norm Var'],['NORMAL','Normal'],['NEUTRAL','Neutral'],['RUNNING_PROFILE_NEUTRAL','Running Neutral'],['NONTREND','Nontrend']]} />,
            TOOLTIPS.PRIOR_DAY_PROFILE.text + (TOOLTIPS.PRIOR_DAY_PROFILE.source ? `\n\nSource: ${TOOLTIPS.PRIOR_DAY_PROFILE.source}` : ''), 'prior_day_profile')}
          {row('Market state', (
            <span style={{ fontSize: 13, fontWeight: 700, color: marketState?.color || '#64748b' }}>
              {marketState?.label || '— select day type'}{marketState?.label && (' — ' + marketState.playbook)}
            </span>
          ), 'Auto-derived from prior day profile. Efficient = buyers and sellers in balance — fade extremes. Inefficient = one side dominant — go with breakouts, do not fade.')}
          {row('ACD number line', (
            <span style={{ fontSize: 13, fontWeight: 700, color: nlColor, fontFamily: 'monospace' }}>
              {nlNum > 0 ? '+' : ''}{nlNum} &nbsp; {nlLabel}
            </span>
          ), nlTrend === 'TRENDING_UP'   ? 'Buyers have dominated the last 30 sessions — more A Up confirms than A Down. Structural edge favors longs. A Down signals in this environment have lower conviction and higher failure rate.'
           : nlTrend === 'TRENDING_DOWN' ? 'Sellers have dominated the last 30 sessions. Structural edge favors shorts. A Up signals are fighting the trend — lower conviction, higher failure rate.'
           : 'Buyers and sellers have been roughly equal over 30 sessions. No structural edge in either direction. Both setups valid — reduce size on overnight holds, no directional bias.')}
          {row('Monthly pivot', (
            <span style={{ fontSize: 13, fontWeight: 700, color: pivotColor }}>{pivotLabel}</span>
          ), pivotBias === 'up'   ? 'Price is above the monthly floor pivot where month participants have transacted. Buyers hold the dominant structural position for the month. Pullbacks to pivot level are buying opportunities until proven otherwise.'
           : pivotBias === 'down' ? 'Price is below the monthly pivot — sellers have controlled the month. Rallies to pivot are selling opportunities. Structural edge favors shorts for the remainder of the month.'
           : 'Price is near the monthly pivot — neither buyers nor sellers have established monthly dominance. Two-sided structure, no macro bias.')}
          {p1Bias && (
            <div style={{ marginTop: 10, padding: '10px 14px', background: p1Direction === 'LONG' ? 'rgba(34,197,94,0.08)' : p1Direction === 'SHORT' ? 'rgba(239,68,68,0.08)' : 'rgba(100,116,139,0.08)', border: `1px solid ${p1Direction === 'LONG' ? '#22c55e' : p1Direction === 'SHORT' ? '#ef4444' : '#475569'}40`, borderRadius: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: p1Direction === 'LONG' ? '#22c55e' : p1Direction === 'SHORT' ? '#ef4444' : '#94a3b8' }}>
                  PRE-MARKET BIAS: {p1Direction}
                </div>
                <div style={{ fontSize: 11, color: '#94a3b8', fontFamily: 'Arial, sans-serif' }}>
                  {fmtTs(read.p1_updated_at) || ''}
                </div>
              </div>
              <div style={{ fontSize: 13, color: '#e2e8f0', lineHeight: 1.7 }}>{p1Bias.text}</div>
              {ltSentence && (
                <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid rgba(100,116,139,0.2)', fontSize: 12, color: '#94a3b8', lineHeight: 1.6, fontFamily: 'Arial, sans-serif' }}>
                  <span style={{ color: '#64748b', fontWeight: 700 }}>Structural context: </span>{ltSentence}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── PHASE 2 ── */}
      <PhaseHeader num={2} title="Opening Read" locked={phase2Locked} timeLabel="Fill 9:30–9:45" />
      {openPhases.has(2) && (
        <div style={{ padding: '12px 0' }}>
          {row('OR condition', <Selector field="or_condition" locked={phase2Locked}
            options={[['NARROW','Narrow'],['NORMAL','Normal'],['WIDE','Wide'],['EMOTIONAL','Emotional']]} />,
            null, 'or_condition')}
          {/* OR volatility advisory — one line based on condition + actual range vs avg */}
          {(read.or_condition || autoDetected?.or_condition) && (() => {
            const cond = read.or_condition || autoDetected?.or_condition;
            const rng  = autoDetected?.today_or_range;
            const avg  = autoDetected?.avg_or_range;
            const pct  = rng && avg ? Math.round((rng / avg) * 100) : null;
            const rec = cond === 'NARROW'
              ? `Narrow OR (${rng ? rng.toFixed(0) : '—'}pts${pct ? ', ' + pct + '% of avg' : ''}): A levels are close — smaller position, honor first touch of A level as entry.`
              : cond === 'WIDE'
              ? `Wide OR (${rng ? rng.toFixed(0) : '—'}pts${pct ? ', ' + pct + '% of avg' : ''}): A levels are far out — reduce size 50%, wait for 5-min sustain before entry.`
              : cond === 'EMOTIONAL'
              ? `Extreme OR (${rng ? rng.toFixed(0) : '—'}pts${pct ? ', ' + pct + '% of avg' : ''}): Avoid A signals — fade the initial extreme only after volume confirms exhaustion.`
              : null; // NORMAL — no advisory needed
            return rec ? (
              <div style={{ marginLeft: 8, marginBottom: 6, padding: '5px 10px', background: 'rgba(245,158,11,0.07)', borderLeft: '2px solid #f59e0b', borderRadius: '0 4px 4px 0', fontSize: 11, color: '#fcd34d', lineHeight: 1.5 }}>
                {rec}
              </div>
            ) : null;
          })()}
          {row('Opening call', (
            <div>
              {autoOpeningCall && !read.opening_call_type && (
                <div style={{ fontSize: 11, color: '#3b82f6', marginBottom: 4 }}>
                  ● auto-detected: <strong>{autoOpeningCall.replace(/_/g,' ')}</strong> — tap to override
                </div>
              )}
              <Selector field="opening_call_type" locked={phase2Locked}
                options={[['OPEN_DRIVE','Open Drive'],['OPEN_TEST_DRIVE','OTD'],['OPEN_REJECTION_REVERSE','ORR'],['OPEN_AUCTION','Open Auction']]}
                autoOverride={autoOpeningCall} />
            </div>
          ), null, 'opening_call_type')}
          {row('A signal', (
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>
                Auto-detected: <strong style={{ color: autoASignal ? '#22c55e' : '#94a3b8' }}>{autoASignal?.replace(/_/g,' ') || 'No signal yet'}</strong>
                {read.a_signal_override && <span style={{ color: '#f59e0b' }}> (overridden)</span>}
              </div>
              <Selector field="a_signal_override" locked={phase2Locked}
                options={[['A_UP_STRONG','A Up Strong'],['A_UP_WEAK','A Up Weak'],['A_UP_FAILED','A Up Failed'],['A_DOWN_STRONG','A Dn Strong'],['A_DOWN_WEAK','A Dn Weak'],['A_DOWN_FAILED','A Dn Failed'],['NO_SIGNAL','No Signal']]} />
            </div>
          ), 'Auto-detects from bar data. A signal confirms which side — buyers or sellers — has taken structural control of the session.')}
          {sessionBias && (
            <div style={{ marginTop: 10, padding: '10px 14px', background: `${biasColor[sessionBias.level]}12`, border: `2px solid ${biasColor[sessionBias.level]}`, borderRadius: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: biasColor[sessionBias.level] }}>SESSION BIAS: {sessionBias.level}</div>
                <div style={{ fontSize: 11, color: '#64748b', fontFamily: 'Arial, sans-serif' }}>
                  {fmtTs(latestTs(read.p2_updated_at, read.ts_or_condition, read.ts_opening_call_type, read.ts_a_signal_override))
                    || (liveCtx?.barTime ? `${liveCtx.barTime} ET` : null)
                    || 'not yet set'}
                </div>
              </div>
              <div style={{ fontSize: 12, color: '#e2e8f0', lineHeight: 1.6, marginBottom: (sessionBias.level === 'GREEN' || sessionBias.level === 'AMBER') ? 8 : 0 }}>{sessionBias.text}</div>
              {(sessionBias.level === 'GREEN' || sessionBias.level === 'AMBER') && todayData?.today?.or_high && (() => {
                const orH = parseFloat(todayData.today.or_high), orL = parseFloat(todayData.today.or_low);
                const orRange = orH - orL;
                const isLong  = p1Direction === 'LONG';
                const isCounterTrend = confluenceData?.alignment === 'COUNTER_TREND';
                const ct = confluenceData?.counterTrendData;
                const t1 = isCounterTrend && ct?.t1
                  ? ct.t1
                  : isLong ? (orH + orRange).toFixed(2) : (orL - orRange).toFixed(2);
                const t1Label = isCounterTrend && ct
                  ? `${ct.nearestTarget?.label || 'structural support'}`
                  : 'OR measured move';
                const stopStrong = isLong ? orL.toFixed(2) : orH.toFixed(2);
                const stopAggr   = ((orH + orL) / 2).toFixed(2);
                return (
                  <div style={{ padding: '8px 10px', background: isCounterTrend ? 'rgba(251,191,36,0.06)' : 'rgba(0,0,0,0.2)', borderRadius: 6, fontSize: 11, color: '#94a3b8', border: isCounterTrend ? '1px solid rgba(251,191,36,0.3)' : 'none' }}>
                    {isCounterTrend && (
                      <div style={{ fontSize: 11, color: '#fbbf24', fontWeight: 700, marginBottom: 5 }}>
                        ⚡ Counter-trend — {ct?.nearestHeadwind ? `${ct.nearestHeadwind.label} (${ct.nearestHeadwind.price}) overhead` : 'structural resistance overhead'}
                      </div>
                    )}
                    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                      <span>Stop (strong): <strong style={{ fontFamily: 'monospace', color: '#ef4444' }}>{stopStrong}</strong> (OR {isLong ? 'low' : 'high'})</span>
                      <span>Stop (aggressive): <strong style={{ fontFamily: 'monospace', color: '#f97316' }}>{stopAggr}</strong> (OR mid)</span>
                      <span>T1: <strong style={{ fontFamily: 'monospace', color: isCounterTrend ? '#fbbf24' : '#22c55e' }}>{t1}</strong>
                        <span style={{ color: '#475569' }}> {t1Label}</span>
                      </span>
                      {!isCounterTrend && <span>T2: prior session hi/lo</span>}
                      <span style={{ color: '#ef4444', fontWeight: 700 }}>Max: 1 CONTRACT</span>
                    </div>
                  </div>
                );
              })()}
            </div>
          )}
        </div>
      )}

      {/* ── MID-DAY ── */}
      <MidDaySection />

      {/* ── PHASE 4 ── */}
      <EODReadSection />
    </div>
  );
}

function MidDaySection() {
  const [snap, setSnap] = React.useState(null);
  const [open, setOpen] = React.useState(false);

  const nowET  = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const etMin  = nowET.getHours() * 60 + nowET.getMinutes();
  const isAfter145 = etMin >= 13 * 60 + 45;
  const isBefore4  = etMin < 16 * 60;
  const isActive   = isAfter145 && isBefore4;

  const load = React.useCallback(() => {
    fetch(`${API_URL}/auction-read/midday`).then(r => r.json()).then(setSnap).catch(() => {});
  }, []);

  React.useEffect(() => {
    if (!isAfter145) return;
    load();
    // Refresh every 15 min from 1:45 until 4 PM
    if (isBefore4) {
      const iv = setInterval(load, 15 * 60 * 1000);
      return () => clearInterval(iv);
    }
  }, [isAfter145]);

  const biasColor = { LONG: '#22c55e', SHORT: '#ef4444', NEUTRAL: '#94a3b8' };
  const dirColor  = { BULLISH: '#22c55e', BEARISH: '#ef4444', NEUTRAL: '#94a3b8' };
  const genTime   = snap?.generatedAt ? formatTimestamp(snap.generatedAt) : null;

  return (
    <div style={{ marginTop: 8 }}>
      <button onClick={() => setOpen(o => !o)}
        style={{ width: '100%', background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: open ? '1px solid var(--border-color)' : 'none' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: '#3b82f6', letterSpacing: '0.08em' }}>MID-DAY</span>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>1:45 PM Read</span>
          {!isAfter145 && <span style={{ fontSize: 13, color: '#94a3b8', fontFamily: 'Arial, sans-serif' }}>Available after 1:45 PM ET</span>}
          {genTime
            ? <span style={{ fontSize: 13, color: '#22c55e', fontFamily: 'Arial, sans-serif', fontWeight: 600 }}>✓ updated {genTime} ET</span>
            : isAfter145 && <span style={{ fontSize: 13, color: '#475569', fontFamily: 'Arial, sans-serif' }}>loading…</span>}
        </div>
        <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div style={{ padding: '12px 0' }}>
          {!isAfter145 ? (
            <div style={{ padding: '16px 0', textAlign: 'center', color: '#94a3b8', fontSize: 12 }}>
              Mid-day read populates at 1:45 PM ET — a check-in on whether the morning bias is playing out and what to watch into the close.
            </div>
          ) : !snap?.available ? (
            <div style={{ padding: '16px 0', textAlign: 'center', color: '#94a3b8', fontSize: 12 }}>{snap?.reason || 'Loading…'}</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, fontFamily: 'Arial, sans-serif', fontSize: 13, color: '#94a3b8' }}>

              {/* Status strip */}
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>

                {/* Pre-market bias box — always from structural read (inventory + value position) */}
                <div style={{ padding: '8px 14px', background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border-color)', borderRadius: 7, flex: 1, minWidth: 130 }}>
                  <div style={{ fontSize: 12, color: '#64748b', marginBottom: 3 }}>Pre-market structural bias</div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: biasColor[snap.preMktBias] || '#94a3b8' }}>{snap.preMktBias || 'NEUTRAL'}</div>
                  <div style={{ fontSize: 11, color: '#475569', marginTop: 2 }}>from inventory + value position (before 9:30)</div>
                </div>

                {/* Session signal box — only shows when A signal fired */}
                <div style={{ padding: '8px 14px', background: snap.sessionSignal ? `${biasColor[snap.sessionSignal]}10` : 'rgba(0,0,0,0.2)', border: `1px solid ${snap.sessionSignal ? biasColor[snap.sessionSignal]+'40' : 'var(--border-color)'}`, borderRadius: 7, flex: 1, minWidth: 130 }}>
                  <div style={{ fontSize: 12, color: '#64748b', marginBottom: 3 }}>Session signal (A signal)</div>
                  {snap.sessionSignal ? (
                    <>
                      <div style={{ fontSize: 15, fontWeight: 700, color: biasColor[snap.sessionSignal] }}>{snap.sessionSignal}</div>
                      <div style={{ fontSize: 11, color: '#475569', marginTop: 2 }}>
                        {snap.aDownFired ? 'A Down fired — short signal active' : 'A Up fired — long signal active'}
                      </div>
                    </>
                  ) : (
                    <>
                      <div style={{ fontSize: 14, fontWeight: 700, color: '#64748b' }}>No signal yet</div>
                      <div style={{ fontSize: 11, color: '#475569', marginTop: 2 }}>no A signal — structural bias drives</div>
                    </>
                  )}
                </div>

                {/* Price result */}
                <div style={{ padding: '8px 14px', background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border-color)', borderRadius: 7, flex: 1, minWidth: 130 }}>
                  <div style={{ fontSize: 12, color: '#64748b', marginBottom: 3 }}>Price vs open (as of {snap.cutoffTime})</div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: dirColor[snap.dir] }}>{snap.ptsVsOpen > 0 ? '+' : ''}{snap.ptsVsOpen}pts</div>
                  <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2 }}>{snap.dir}</div>
                </div>

                {/* Bias outcome */}
                <div style={{ padding: '8px 14px', background: snap.biasPlaying ? 'rgba(34,197,94,0.08)' : snap.biasReversed ? 'rgba(239,68,68,0.08)' : 'rgba(0,0,0,0.2)', border: `1px solid ${snap.biasPlaying ? '#22c55e40' : snap.biasReversed ? '#ef444440' : 'var(--border-color)'}`, borderRadius: 7, flex: 1, minWidth: 130 }}>
                  <div style={{ fontSize: 12, color: '#64748b', marginBottom: 3 }}>Bias outcome</div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: snap.biasPlaying ? '#22c55e' : snap.biasReversed ? '#ef4444' : '#94a3b8' }}>
                    {snap.biasPlaying ? '✓ Playing out' : snap.biasReversed ? '✗ Not playing out' : '— Neutral'}
                  </div>
                  <div style={{ fontSize: 11, color: '#475569', marginTop: 2 }}>{snap.sessionSignal ? 'based on A signal direction' : 'based on pre-market read'}</div>
                </div>

                {/* Session range */}
                <div style={{ padding: '8px 14px', background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border-color)', borderRadius: 7, flex: 1, minWidth: 130 }}>
                  <div style={{ fontSize: 12, color: '#64748b', marginBottom: 3 }}>Session range</div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: '#e2e8f0' }}>H {snap.sessHigh} · L {snap.sessLow}</div>
                  <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2 }}>{snap.sessRange}pts ({snap.rangeVsAvg}% avg)</div>
                </div>
              </div>

              {/* Key levels */}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {[
                  ['Now', snap.currentPrice, '#e2e8f0'],
                  ['VWAP', snap.vwap, snap.currentPrice > snap.vwap ? '#22c55e' : '#ef4444'],
                  ['OR Hi', snap.orHigh, '#94a3b8'],
                  ['OR Lo', snap.orLow, '#94a3b8'],
                  snap.gLine && ['G-Line', snap.gLine, '#f59e0b'],
                  snap.aUpFired && ['A Up', '✓ fired', '#22c55e'],
                  snap.aDownFired && ['A Down', '✓ fired', '#ef4444'],
                  [`P3 (${snap.p3Source || 'auto'})`, `${snap.p3Score}/5`, snap.p3Score >= 3 ? '#22c55e' : snap.p3Score >= 2 ? '#fbbf24' : '#ef4444'],
                ].filter(Boolean).map(([label, val, color]) => (
                  <div key={label} style={{ padding: '5px 12px', background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border-color)', borderRadius: 5 }}>
                    <span style={{ color: '#64748b' }}>{label} </span>
                    <span style={{ color, fontWeight: 700 }}>{val}</span>
                  </div>
                ))}
              </div>

              {/* Day type */}
              <div style={{ padding: '10px 14px', background: 'rgba(59,130,246,0.06)', borderLeft: '3px solid #3b82f6', borderRadius: '0 6px 6px 0', lineHeight: 1.7 }}>
                <span style={{ color: '#3b82f6', fontWeight: 700 }}>SESSION SHAPE  </span>
                {snap.dayTypeDeveloping}
              </div>

              {/* Watch list */}
              {snap.watches?.length > 0 && (
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#94a3b8', marginBottom: 6, letterSpacing: '0.05em' }}>WATCH INTO CLOSE</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {snap.watches.map((w, i) => (
                      <div key={i} style={{ padding: '8px 14px', background: 'rgba(0,0,0,0.15)', borderLeft: '2px solid #3b82f6', borderRadius: '0 6px 6px 0', lineHeight: 1.7 }}>
                        {w}
                      </div>
                    ))}
                  </div>
                </div>
              )}

            </div>
          )}
        </div>
      )}
    </div>
  );
}

function EODReadSection() {
  const [eod, setEod] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const [generatedAt, setGeneratedAt] = React.useState(null);
  const [open, setOpen] = React.useState(false);

  const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const etMin = nowET.getHours() * 60 + nowET.getMinutes();
  const isAfter4pm = etMin >= 16 * 60;

  const load = React.useCallback(() => {
    setLoading(true);
    fetch(`${API_URL}/auction-read/eod`)
      .then(r => r.json())
      .then(d => { setEod(d); setGeneratedAt(new Date()); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  // Auto-load once after 4 PM, refresh every 15 min until close
  React.useEffect(() => {
    if (!isAfter4pm) return;
    load();
    const iv = setInterval(load, 15 * 60 * 1000);
    return () => clearInterval(iv);
  }, [isAfter4pm]);

  const outcomeColor = { CORRECT: '#22c55e', WRONG: '#ef4444', NEUTRAL: '#94a3b8' };
  const outcomeIcon  = { CORRECT: '✓', WRONG: '✗', NEUTRAL: '—' };
  const patternColor = { V_REVERSAL_UP: '#22c55e', V_REVERSAL_DOWN: '#ef4444', TREND_DAY: '#f97316', BALANCE_DAY: '#64748b', FAILED_A_UP: '#f97316', FAILED_A_DOWN: '#a78bfa', NEWS_DRIVEN: '#fbbf24' };

  return (
    <div style={{ marginTop: 8 }}>
      <button onClick={() => setOpen(o => !o)}
        style={{ width: '100%', background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: open ? '1px solid var(--border-color)' : 'none' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: '#3b82f6', letterSpacing: '0.08em' }}>PHASE 4</span>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>End of Day Read</span>
          {!isAfter4pm && <span style={{ fontSize: 11, color: '#94a3b8' }}>Available after 4:00 PM ET</span>}
          {generatedAt && <span style={{ fontSize: 11, color: '#94a3b8', fontFamily: 'Arial, sans-serif' }}>generated {formatTimestamp(generatedAt)}</span>}
        </div>
        <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div style={{ padding: '12px 0' }}>
          {!isAfter4pm ? (
            <div style={{ padding: '20px 0', textAlign: 'center', color: '#94a3b8', fontSize: 12 }}>
              End of day debrief populates after 4:00 PM ET when the full session is complete.
            </div>
          ) : loading && !eod ? (
            <div style={{ padding: '20px 0', textAlign: 'center', color: '#94a3b8', fontSize: 12 }}>Loading EOD analysis…</div>
          ) : !eod?.available ? (
            <div style={{ padding: '20px 0', textAlign: 'center', color: '#94a3b8', fontSize: 12 }}>{eod?.reason || 'No data available.'}</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14, fontFamily: 'Arial, sans-serif', fontSize: 13, color: '#94a3b8' }}>

              {/* Outcome banner */}
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 160, padding: '12px 16px', background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border-color)', borderRadius: 8 }}>
                  <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4, fontWeight: 700, letterSpacing: '0.06em' }}>PRE-MARKET CALL</div>
                  <div style={{ fontSize: 16, fontWeight: 800, color: eod.mornBias === 'LONG' ? '#22c55e' : eod.mornBias === 'SHORT' ? '#ef4444' : '#94a3b8' }}>{eod.mornBias}</div>
                  <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 3 }}>{eod.inv?.replace(/_/g,' ')} · {eod.val?.replace(/_/g,' ')}</div>
                  <div style={{ fontSize: 12, color: '#94a3b8' }}>{eod.priorProfile?.replace(/_/g,' ')} prior day</div>
                  {eod.aUpFired && <div style={{ fontSize: 12, color: '#22c55e', marginTop: 3, fontWeight: 700 }}>A Up fired</div>}
                  {eod.aDownFired && <div style={{ fontSize: 12, color: '#ef4444', marginTop: 3, fontWeight: 700 }}>A Down fired</div>}
                  {!eod.aUpFired && !eod.aDownFired && <div style={{ fontSize: 12, color: '#64748b', marginTop: 3 }}>No A signal</div>}
                </div>
                <div style={{ flex: 1, minWidth: 160, padding: '12px 16px', background: `${outcomeColor[eod.outcome]}10`, border: `1px solid ${outcomeColor[eod.outcome]}40`, borderRadius: 8 }}>
                  <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4, fontWeight: 700, letterSpacing: '0.06em' }}>SESSION RESULT</div>
                  <div style={{ fontSize: 16, fontWeight: 800, color: outcomeColor[eod.outcome] }}>{outcomeIcon[eod.outcome]} {eod.outcome}</div>
                  <div style={{ fontSize: 13, color: eod.ptsVsOpen > 0 ? '#22c55e' : eod.ptsVsOpen < 0 ? '#ef4444' : '#94a3b8', fontWeight: 700, fontFamily: 'monospace', marginTop: 3 }}>{eod.ptsVsOpen > 0 ? '+' : ''}{eod.ptsVsOpen}pts</div>
                  <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2 }}>Range {eod.sessRange}pts ({eod.rangeVsAvg}% avg) · VWAP {eod.vwap}</div>
                  <div style={{ fontSize: 12, color: '#94a3b8' }}>Open {eod.sessOpen} → Close {eod.sessClose}</div>
                </div>
                <div style={{ flex: '0 0 auto', padding: '12px 16px', background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border-color)', borderRadius: 8, minWidth: 100, textAlign: 'center' }}>
                  <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4, fontWeight: 700, letterSpacing: '0.06em' }}>P3 SCORE</div>
                  <div style={{ fontSize: 24, fontWeight: 800, color: eod.p3Score >= 3 ? '#22c55e' : eod.p3Score >= 2 ? '#fbbf24' : '#ef4444', fontFamily: 'monospace' }}>{eod.p3Score}/5</div>
                  <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>{eod.p3Source || 'auto'}</div>
                </div>
              </div>

              {/* Pre-market narrative */}
              {eod.narrative?.preMarket?.length > 0 && (
                <div style={{ borderLeft: '3px solid #3b82f6', padding: '10px 14px', background: 'rgba(59,130,246,0.05)', borderRadius: '0 8px 8px 0' }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: '#3b82f6', marginBottom: 8, letterSpacing: '0.06em' }}>PRE-MARKET READ</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {eod.narrative.preMarket.map((line, i) => (
                      <div key={i} style={{ fontSize: 13, color: '#cbd5e1', lineHeight: 1.7 }}>{line}</div>
                    ))}
                  </div>
                </div>
              )}

              {/* Session narrative */}
              {eod.narrative?.session?.length > 0 && (
                <div style={{ borderLeft: `3px solid ${outcomeColor[eod.outcome]}`, padding: '10px 14px', background: `${outcomeColor[eod.outcome]}06`, borderRadius: '0 8px 8px 0' }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: outcomeColor[eod.outcome], marginBottom: 8, letterSpacing: '0.06em' }}>WHAT HAPPENED</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {eod.narrative.session.map((line, i) => (
                      <div key={i} style={{ fontSize: 13, color: '#cbd5e1', lineHeight: 1.7 }}>{line}</div>
                    ))}
                  </div>
                </div>
              )}

              {/* Patterns */}
              {eod.patterns?.length > 0 && (
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: '#94a3b8', marginBottom: 8, letterSpacing: '0.06em' }}>PATTERNS DETECTED</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {eod.patterns.map(p => (
                      <div key={p.type} style={{ padding: '8px 14px', background: `${patternColor[p.type] || '#94a3b8'}10`, borderLeft: `3px solid ${patternColor[p.type] || '#94a3b8'}`, borderRadius: '0 6px 6px 0' }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: patternColor[p.type] || '#94a3b8', marginBottom: 4 }}>{p.label}</div>
                        <div style={{ fontSize: 13, color: '#cbd5e1', lineHeight: 1.7 }}>{p.detail}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Verdict */}
              {eod.narrative?.verdict?.length > 0 && (
                <div style={{ borderLeft: `3px solid ${outcomeColor[eod.outcome]}`, padding: '10px 14px', background: `${outcomeColor[eod.outcome]}08`, borderRadius: '0 8px 8px 0' }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: outcomeColor[eod.outcome], marginBottom: 8, letterSpacing: '0.06em' }}>THE VERDICT</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {eod.narrative.verdict.map((line, i) => (
                      <div key={i} style={{ fontSize: 13, color: '#cbd5e1', lineHeight: 1.7 }}>{line}</div>
                    ))}
                  </div>
                </div>
              )}

              {/* Level notes */}
              {(eod.gNote || eod.pwNote) && (
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: '#94a3b8', marginBottom: 6, letterSpacing: '0.06em' }}>KEY LEVEL INTERACTIONS</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                    {eod.gNote && <div style={{ padding: '8px 14px', background: 'rgba(245,158,11,0.08)', borderLeft: '3px solid #f59e0b', borderRadius: '0 6px 6px 0', fontSize: 13, color: '#cbd5e1', lineHeight: 1.7 }}><span style={{ color: '#f59e0b', fontWeight: 700 }}>G-Line  </span>{eod.gNote}</div>}
                    {eod.pwNote && <div style={{ padding: '8px 14px', background: 'rgba(192,132,252,0.08)', borderLeft: '3px solid #c084fc', borderRadius: '0 6px 6px 0', fontSize: 13, color: '#cbd5e1', lineHeight: 1.7 }}><span style={{ color: '#c084fc', fontWeight: 700 }}>PW Level  </span>{eod.pwNote}</div>}
                  </div>
                </div>
              )}

              {/* Tomorrow */}
              {eod.narrative?.tomorrow?.length > 0 && (
                <div style={{ padding: '10px 14px', background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.2)', borderRadius: 8 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: '#3b82f6', marginBottom: 8, letterSpacing: '0.06em' }}>GOING INTO TOMORROW</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                    {eod.narrative.tomorrow.map((line, i) => (
                      <div key={i} style={{ fontSize: 13, color: '#94a3b8', lineHeight: 1.7 }}>→ {line}</div>
                    ))}
                  </div>
                </div>
              )}

            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Long-Term Market Structure ────────────────────────────────────────────────

const TRADING_GUIDANCE = {
  BRACKET: {
    headline: 'Responsive strategy — fade the extremes',
    anchor: 'bracket',
    danger: 'Bracket kills trend traders. You see price hitting a new high, it looks like a breakout, you buy it — the bracket snaps it back. You try again at the next push. Same result. Three stops, same mistake. The trap is that each breakout LOOKS real because price is genuinely moving. But 75% of them fail. If you are using trend-following strategies (buying breakouts, adding to winners, holding overnight) in a confirmed bracket, you will consistently lose money until the bracket breaks.',
    green: 'Brackets are clean and profitable when traded correctly. The edge: you know where buyers step in (VAL) and where sellers step in (VAH). Buy near VAL with a stop below it, target the POC. Sell near VAH with a stop above it, target the POC. These are the highest-probability setups in any market condition — they just require patience to wait for price to reach the edge rather than chasing the middle.',
    bullets: [
      'Buy near composite VAL and bracket low, sell near composite VAH and bracket high',
      'Do NOT hold breakouts — 75% of breakout attempts fail in a bracket and snap back',
      'A signals have lower follow-through inside a bracket — reduce size on every entry',
      'Target the bracket midpoint or the opposite edge, not open-ended extension',
      'If the bracket has been narrowing (value areas contracting), a breakout is approaching — be ready but do not predict direction',
    ]
  },
  BRACKET_TILTING_UP: {
    headline: '⚠ BRACKET — structure looks bullish but the trend has NOT confirmed',
    danger: 'This environment blows out trend traders. NL30 is green, value is migrating higher, the week looks like a trend — so you buy the breakout above VAH with full size because everything tells you it should work. The bracket snaps it back. You try again. It snaps back again. By the third time you\'ve given up three full stops chasing a move that never confirmed. Dalton calls this the most costly condition in market profile trading: the bracket that looks like it should break but doesn\'t, repeatedly.',
    green: 'The opportunity: if a VAH break holds for a full session and next day\'s value opens entirely above prior VAH — you\'re one of the first to see the trend starting. That early-trend entry comes before the momentum crowd arrives. The wait for one session of acceptance above VAH is the protection that makes this trade worth taking.',
    anchor: 'transitional',
    bullets: [
      'The bracket has NOT broken into a trend. 75% of pushes above VAH will fail and return to value. Do not size up on breakouts.',
      'Responsive strategy applies — buy near VAL, sell near VAH. Bias toward longs but DO NOT chase extensions.',
      'The confirmation you need before going initiative: A Up fires, closes above OR High, AND the next session\'s value area opens entirely above prior VAH. That is a trend starting. Not before.',
      'Until confirmed: target the composite POC from the breakout entry, not open-ended extension. Take partial profits at midpoint.',
      'Your stops must be tighter in this environment — if the breakout fails and price comes back inside OR, exit immediately. Do not hold through a snap-back.',
    ]
  },
  BRACKET_TILTING_DOWN: {
    headline: '⚠ BRACKET — structure looks bearish but the breakdown has NOT confirmed',
    danger: 'This environment blows out short sellers. NL30 is negative, value is migrating lower, everything looks like a downtrend — so you short the breakdown below VAL. The bracket bounces it back. You try again. Same result. Each stop hurts more because the structural story still sounds right. The bracket punishes people who use initiative strategy before the trend is confirmed.',
    green: 'The opportunity: if a VAL break holds for a full session and next day\'s value opens entirely below prior VAL — that is the early-trend short entry before the sellers pile in. One session of acceptance below VAL is all you need to confirm the regime change.',
    anchor: 'transitional',
    bullets: [
      'The bracket has NOT broken into a downtrend. 75% of pushes below VAL will fail and return to value.',
      'Responsive strategy applies — sell near VAH, buy near VAL. Bias toward shorts but DO NOT chase extensions downward.',
      'Confirmation needed: A Down fires, closes below OR Low, AND next session\'s value opens entirely below prior VAL.',
      'Until confirmed: target the composite POC, take partials at midpoint, do not hold through snap-backs.',
      'If breakdown fails and price comes back inside OR — exit immediately.',
    ]
  },
  TRENDING_UP: {
    headline: 'Initiative strategy — go with extensions',
    anchor: 'trending-up',
    danger: 'Trending environments destroy countertrend traders and overconfident trend traders equally. The countertrend mistake: you see price at a new high, it looks extended, you short expecting a pullback — the trend absorbs your short and keeps going. You try again at the next high. Same result. Every short is a loss because you are fighting OTF buyers who have a structural thesis and unlimited capital. The trend trader mistake: you hold past the first absorption signal, miss the stop, and give back all your gains in one reversal session.',
    green: 'This is the best environment for trend-following strategies. When NL30 > +9, value is migrating higher, AND an A Up fires with C confirmation — every element of the ACD framework is aligned. These are the days where you can hold past initial targets, trail stops to prior VAH, and let the trade run. The trend does the work. Your job is to get in at the right level (pullback to prior VAH) and not take profits too early.',
    bullets: [
      'Buy pullbacks to the prior day\'s VAH — prior resistance flips to support in a trend',
      'Do NOT short into structural strength — countertrend setups get destroyed',
      'A Down signals in a bullish NL30 environment have high failure rate — skip them or reduce to 1 contract',
      'Hold A Up signals longer than usual — structure supports continuation past initial targets',
      'If A Up fires and C confirms, the trade has the highest possible conviction',
    ]
  },
  TRENDING_DOWN: {
    headline: 'Initiative strategy — go with extensions downward',
    anchor: 'trending-down',
    danger: 'Downtrends destroy "buy the dip" traders. Every pullback looks like a bottom — the market is down big, it seems cheap, you buy expecting a bounce. The trend continues lower. The psychological trap is that buying feels safer than shorting, so traders keep adding to losing longs on every dip, averaging down into a structural downtrend. The market does not know or care what you paid. Price can always go lower when value is migrating lower.',
    green: 'When NL30 < -9, value migrating lower, AND A Down fires with C confirmation — short the VAL break and hold. Sell rallies back to prior VAL (now resistance). These are clean, high-conviction short setups with structural support. The trend is doing the work — ride it.',
    bullets: [
      'Sell rallies to the prior day\'s VAL — prior support flips to resistance in a downtrend',
      'Do NOT buy dips expecting a bounce — structural edge is with sellers',
      'A Up signals in a bearish NL30 environment have high failure rate — skip or reduce size',
      'Hold A Down signals longer — structure supports continuation',
      'Failed A Down signals are stronger than usual in a downtrend — the bears keep coming back',
    ]
  },
  TRANSITIONAL: {
    headline: 'Reduce size 50%+ — only the most obvious setups',
    anchor: 'transitional',
    danger: 'Transitional environments cause the largest losses because both strategies fail at the same time. Trend traders get faded because the old regime is ending. Bracket traders get run over because the new regime is starting. You get whipsawed — you fade the extension (correct bracket strategy) and it breaks out. You buy the breakout (correct trend strategy) and it snaps back. This is the market changing gears and neither playbook works until one side confirms. The damage is amplified because traders keep trying to "figure it out" with full size.',
    green: 'The edge in transitional conditions is patience. If the bracket is breaking into a trend, the FIRST confirmed VA migration day is a high-quality entry — it is the earliest signal that the new trend is real. You get in before the trend-followers pile in. If the trend is exhausting, the FIRST day that fails to make a new extreme and closes inside the prior range is the signal to stop adding. Patience here has a specific payoff.',
    bullets: [
      'Both strategies fail here — breakout traders get faded, fade traders get run over',
      'If bracket → trend: wait for the FIRST confirmed VA migration day before entering. Do not buy the breakout — buy the first pullback to the new VAH after value migrates',
      'If trend → bracket: stop adding to trend positions. Look for failed A signals as confirmation the regime has changed',
      'Opening Auction (ORR) opens are most common — the market is genuinely trying to find where new value is',
      'Wait for the 10:00–10:30 window. If no A signal by then, the day is likely going rotational. Reduce expectations',
      'NL30 alignment is your best guide: if NL30 >+9 and bracket is breaking up, the trend has structural backing',
    ]
  },
};

const COND_TOOLTIPS = {
  c1: TOOLTIPS.C1_NL30, c2: TOOLTIPS.C2_NL10, c3: TOOLTIPS.C3_OPEN_VS_VALUE,
  c4: TOOLTIPS.C4_OVERNIGHT_INVENTORY, c5: TOOLTIPS.C5_MARKET_STATE,
  c6: TOOLTIPS.C6_MONTHLY_PIVOT, c7: TOOLTIPS.C7_VALUE_MIGRATION,
  c8: TOOLTIPS.C8_OR_CONDITION, c9: TOOLTIPS.C9_OPENING_CALL,
  c10: TOOLTIPS.C10_A_SIGNAL_ALIGNED, c11: TOOLTIPS.C11_A_SIGNAL_QUALITY,
  c12: TOOLTIPS.C12_C_SIGNAL,
};

function ConditionRow({ c }) {
  const mark   = !c.available ? '─' : c.met ? '✓' : '✗';
  const mColor = !c.available ? '#64748b' : c.met ? '#22c55e' : '#ef4444';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', borderBottom: '1px solid rgba(100,116,139,0.06)' }}>
      <span style={{ width: 14, textAlign: 'center', fontWeight: 700, color: mColor, fontSize: 13, flexShrink: 0 }}>{mark}</span>
      <span style={{ fontSize: 12, color: c.available ? (c.met ? '#cbd5e1' : '#94a3b8') : '#94a3b8', flex: 1, fontFamily: 'Arial, sans-serif' }}>
        {c.label}{COND_TOOLTIPS[c.id] && <InfoTooltip tooltip={COND_TOOLTIPS[c.id]} />}
      </span>
      {c.value && <span style={{ fontSize: 11, color: mColor, fontFamily: 'monospace', flexShrink: 0 }}>{c.value}</span>}
      {c.reason && !c.met && c.available && <span style={{ fontSize: 11, color: '#94a3b8', flexShrink: 0, maxWidth: 160, textAlign: 'right' }}>{c.reason}</span>}
    </div>
  );
}

function ConfluenceScore() {
  const [data, setData]   = React.useState(null);
  const [openS, setOpenS] = React.useState(true);   // structural expanded
  const [openSess, setOpenSess] = React.useState(false); // session expanded

  React.useEffect(() => {
    const load = () => fetch(`${API_URL}/confluence/today`).then(r => r.json()).then(d => { if (!d.error) setData(d); }).catch(() => {});
    load();
    const iv = setInterval(load, 5 * 60 * 1000);
    return () => clearInterval(iv);
  }, []);

  if (!data) return null;

  const { structural, session, alignment, alignColor, alignNote, counterTrendData, missing, maxPossible, calculatedAt, neutral } = data;
  const nowET    = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const etMin    = nowET.getHours() * 60 + nowET.getMinutes();
  const isLocked = etMin >= 11 * 60;

  return (
    <div style={{ marginBottom: 16, fontFamily: 'Arial, sans-serif', display: 'flex', flexDirection: 'column', gap: 8 }}>

      {/* ── ALIGNMENT BANNER — always visible ── */}
      <div style={{ padding: '10px 16px', background: `${alignColor}12`, border: `2px solid ${alignColor}`, borderRadius: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: '#3b82f6', letterSpacing: '0.08em' }}>CONFLUENCE</span>
          <span style={{ fontSize: 16, fontWeight: 800, color: alignColor, letterSpacing: '0.06em' }}>
            {alignment === 'COUNTER_TREND' ? '⚡ COUNTER-TREND' : alignment === 'ALIGNED' ? '✓ ALIGNED' : '─ NEUTRAL'}
          </span>
          <InfoTooltip tooltip={TOOLTIPS.CONFLUENCE_SCORE} />
          {isLocked && <span style={{ fontSize: 11, color: '#94a3b8', padding: '2px 6px', border: '1px solid #64748b', borderRadius: 3 }}>session closed</span>}
        </div>
        <div style={{ fontSize: 11, color: '#64748b', textAlign: 'right' }}>{formatTimestamp(calculatedAt)}</div>
      </div>

      {alignment === 'COUNTER_TREND' && (
        <div style={{ padding: '8px 14px', background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.3)', borderRadius: 8, fontSize: 12, color: '#fbbf24', lineHeight: 1.7 }}>
          {alignNote}
        </div>
      )}

      {/* ── TWO SCORE CARDS side by side ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>

        {/* STRUCTURAL (always visible per spec: "must always be visible") */}
        <div style={{ background: 'var(--card-bg)', border: `1px solid ${structural.color}40`, borderRadius: 10, overflow: 'hidden' }}>
          <button onClick={() => setOpenS(o => !o)}
            style={{ width: '100%', background: `${structural.color}08`, border: 'none', cursor: 'pointer', padding: '10px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, color: '#64748b', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                Structural — The Gravitational Field
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 2 }}>
                <span style={{ fontSize: 24, fontWeight: 900, color: structural.color, fontFamily: 'monospace' }}>{structural.score}</span>
                <span style={{ fontSize: 13, color: '#64748b', fontFamily: 'monospace' }}>/7</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: structural.color }}>{structural.label}</span>
              </div>
              <div style={{ fontSize: 12, color: structural.color, fontWeight: 600, marginTop: 2 }}>{structural.dir}</div>
            </div>
            <span style={{ color: '#64748b', fontSize: 11 }}>{openS ? '▲' : '▼'}</span>
          </button>
          {openS && (
            <div style={{ padding: '8px 14px 10px' }}>
              <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 4, fontFamily: 'Arial, sans-serif' }}>NL30 direction · c1-c7 · pre-market</div>
              {structural.conditions.map(c => <ConditionRow key={c.id} c={c} />)}
            </div>
          )}
        </div>

        {/* SESSION (intraday weather) */}
        <div style={{ background: 'var(--card-bg)', border: `1px solid ${session.dir ? session.color + '40' : 'var(--border-color)'}`, borderRadius: 10, overflow: 'hidden' }}>
          <button onClick={() => setOpenSess(o => !o)}
            style={{ width: '100%', background: session.dir ? `${session.color}08` : 'transparent', border: 'none', cursor: 'pointer', padding: '10px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, color: '#64748b', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                Session — Intraday Weather
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 2 }}>
                <span style={{ fontSize: 24, fontWeight: 900, color: session.dir ? session.color : '#94a3b8', fontFamily: 'monospace' }}>{session.score}</span>
                <span style={{ fontSize: 13, color: '#94a3b8', fontFamily: 'monospace' }}>/5</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: session.dir ? session.color : '#94a3b8' }}>{session.label}</span>
              </div>
              <div style={{ fontSize: 12, color: session.dir ? session.color : '#94a3b8', fontWeight: 600, marginTop: 2 }}>{session.dir || 'No signal yet'}</div>
            </div>
            <span style={{ color: '#64748b', fontSize: 11 }}>{openSess ? '▲' : '▼'}</span>
          </button>
          {openSess && (
            <div style={{ padding: '8px 14px 10px' }}>
              <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 4, fontFamily: 'Arial, sans-serif' }}>A signal direction · c8-c12 · session</div>
              {session.conditions.map(c => <ConditionRow key={c.id} c={c} />)}
            </div>
          )}
        </div>
      </div>

      {/* ── COUNTER-TREND TRADE PANEL ── */}
      {counterTrendData && <CounterTrendPanel ct={counterTrendData} />}

      {/* ── Max possible footer ── */}
      <div style={{ padding: '6px 12px', background: 'rgba(0,0,0,0.1)', borderRadius: 6, display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#64748b' }}>
        <span>Max possible today: <strong style={{ color: '#94a3b8' }}>{maxPossible}/12</strong></span>
        {missing?.length > 0 && (
          <span style={{ color: '#f97316' }}>
            Unmet: {missing.slice(0,2).join(' · ')}{missing.length > 2 ? ` +${missing.length-2}` : ''}
          </span>
        )}
      </div>
    </div>
  );
}

function CounterTrendPanel({ ct }) {
  const isShort = ct.direction === 'BEARISH';
  const dirColor = isShort ? '#ef4444' : '#22c55e';
  const dirLabel = isShort ? '↓ SHORT (counter-trend)' : '↑ LONG (counter-trend)';

  return (
    <div style={{ background: 'var(--card-bg)', border: '2px solid rgba(251,191,36,0.5)', borderRadius: 10, padding: '14px 16px', fontFamily: 'Arial, sans-serif' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#fbbf24', letterSpacing: '0.06em', marginBottom: 2 }}>⚡ COUNTER-TREND TRADE MANAGEMENT</div>
          <div style={{ fontSize: 14, fontWeight: 700, color: dirColor }}>{dirLabel}</div>
          <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>Against {ct.structuralBias.toLowerCase()} structural backdrop</div>
        </div>
        {ct.t1 && (
          <div style={{ textAlign: 'right', padding: '8px 14px', background: `${dirColor}15`, border: `1px solid ${dirColor}40`, borderRadius: 7 }}>
            <div style={{ fontSize: 10, color: '#64748b' }}>T1</div>
            <div style={{ fontSize: 18, fontWeight: 800, color: dirColor, fontFamily: 'monospace' }}>{ct.t1}</div>
            <div style={{ fontSize: 10, color: '#94a3b8', maxWidth: 160 }}>({ct.nearestTarget?.label})</div>
          </div>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
        {/* Targets */}
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: dirColor, marginBottom: 6, letterSpacing: '0.05em' }}>
            {isShort ? '↓ TARGETS (supports below)' : '↑ TARGETS (resistance above)'}
          </div>
          {ct.targets.slice(0,4).map((t,i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', borderBottom: '1px solid rgba(100,116,139,0.08)', fontSize: 12 }}>
              <span style={{ color: '#94a3b8' }}>{t.label}</span>
              <span style={{ color: dirColor, fontFamily: 'monospace', fontWeight: 600 }}>{t.price}</span>
            </div>
          ))}
          {ct.targets.length === 0 && <div style={{ fontSize: 11, color: '#475569' }}>No structural targets below</div>}
        </div>
        {/* Headwinds */}
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#ef4444', marginBottom: 6, letterSpacing: '0.05em' }}>
            {isShort ? '↑ HEADWINDS (resistance above)' : '↓ HEADWINDS (supports below)'}
          </div>
          {ct.headwinds.slice(0,4).map((h,i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', borderBottom: '1px solid rgba(100,116,139,0.08)', fontSize: 12 }}>
              <span style={{ color: '#94a3b8' }}>{h.label}</span>
              <span style={{ color: '#ef4444', fontFamily: 'monospace', fontWeight: 600 }}>{h.price}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Management rule */}
      <div style={{ padding: '8px 12px', background: 'rgba(251,191,36,0.07)', border: '1px solid rgba(251,191,36,0.25)', borderRadius: 6, fontSize: 12, color: '#fbbf24', lineHeight: 1.7 }}>
        <strong>Rule: </strong>{ct.mgmtRule}
      </div>
    </div>
  );
}

function BigPictureSnapshot({ setCurrentView }) {
  const [lt, setLt] = React.useState(null);
  const [tpo, setTpo] = React.useState(null);
  const [open, setOpen] = React.useState(true);

  React.useEffect(() => {
    const load = () => {
      fetch(`${API_URL}/longterm/summary`).then(r => r.json()).then(d => { if (!d.error) setLt(d); }).catch(() => {});
      fetch(`${API_URL}/composite-profile?days=5`).then(r => r.json()).then(setTpo).catch(() => {});
    };
    load();
    const iv = setInterval(load, 5 * 60 * 1000);
    return () => clearInterval(iv);
  }, []);

  if (!lt && !tpo) return null;

  const stateColor = { TRENDING_UP: '#22c55e', TRENDING_DOWN: '#ef4444', TRANSITIONAL: '#fbbf24', BRACKET: '#3b82f6' };
  const nlColor = n => n > 9 ? '#22c55e' : n < -9 ? '#ef4444' : '#fbbf24';

  const bracketState = lt?.bracketState;
  const acd = lt?.acd;
  const wk = lt?.weeklyStructure;
  const va = lt?.valueMigration;

  return (
    <div style={{ background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderRadius: 12, padding: '14px 20px', marginBottom: 16, fontFamily: 'Arial, sans-serif' }}>
      <button onClick={() => setOpen(o => !o)}
        style={{ width: '100%', background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 0, marginBottom: open ? 12 : 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: '#3b82f6', letterSpacing: '0.08em' }}>BIG PICTURE</span>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>Structural Context — Today's Snapshot</span>
          {bracketState && (() => {
            const isTiltUp   = bracketState.transitionalNote?.includes('BULLISH');
            const isTiltDown = bracketState.transitionalNote?.includes('BEARISH');
            if (bracketState.state === 'TRENDING_UP')   return <span style={{ fontSize: 12, fontWeight: 700, color: '#22c55e', padding: '2px 8px', background: 'rgba(34,197,94,0.15)', borderRadius: 4 }}>↑ TRENDING UP</span>;
            if (bracketState.state === 'TRENDING_DOWN') return <span style={{ fontSize: 12, fontWeight: 700, color: '#ef4444', padding: '2px 8px', background: 'rgba(239,68,68,0.15)', borderRadius: 4 }}>↓ TRENDING DOWN</span>;
            if (bracketState.state === 'TRANSITIONAL')  return <span style={{ fontSize: 12, fontWeight: 700, color: '#fbbf24', padding: '2px 8px', background: 'rgba(251,191,36,0.15)', borderRadius: 4 }}>⚡ TRANSITIONAL</span>;
            if (isTiltUp)   return <><span style={{ fontSize: 12, fontWeight: 700, color: '#3b82f6', padding: '2px 8px', background: 'rgba(59,130,246,0.15)', borderRadius: 4 }}>↔ BRACKET</span><span style={{ fontSize: 12, fontWeight: 700, color: '#fbbf24', padding: '2px 8px', background: 'rgba(251,191,36,0.12)', borderRadius: 4 }}>⚠ tilting up — breakouts unconfirmed</span></>;
            if (isTiltDown) return <><span style={{ fontSize: 12, fontWeight: 700, color: '#3b82f6', padding: '2px 8px', background: 'rgba(59,130,246,0.15)', borderRadius: 4 }}>↔ BRACKET</span><span style={{ fontSize: 12, fontWeight: 700, color: '#fbbf24', padding: '2px 8px', background: 'rgba(251,191,36,0.12)', borderRadius: 4 }}>⚠ tilting down — breakouts unconfirmed</span></>;
            return <span style={{ fontSize: 12, fontWeight: 700, color: '#3b82f6', padding: '2px 8px', background: 'rgba(59,130,246,0.15)', borderRadius: 4 }}>↔ BRACKET</span>;
          })()}
        </div>
        <span style={{ color: '#94a3b8', fontSize: 12 }}>{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {/* Row 1: key structural numbers */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {acd && (
              <div style={{ padding: '8px 14px', background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border-color)', borderRadius: 7, minWidth: 90 }}>
                <div style={{ fontSize: 11, color: '#64748b', marginBottom: 2, display: 'flex', alignItems: 'center', gap: 3 }}>NL30 <InfoTooltip text="30-session rolling ACD score. Above +9 = confirmed uptrend (OTF buyers consistently in control). Below -9 = confirmed downtrend. Between = ranging — no multi-session directional edge.\n\nFisher: use this as your trend filter. A Up signals in a +9 environment have higher conviction than in a ranging one." /></div>
                <div style={{ fontSize: 18, fontWeight: 800, color: nlColor(acd.nl30), fontFamily: 'monospace' }}>{acd.nl30 > 0 ? '+' : ''}{acd.nl30}</div>
                <div style={{ fontSize: 11, color: nlColor(acd.nl30) }}>{acd.nl30trend}</div>
              </div>
            )}
            {acd && (
              <div style={{ padding: '8px 14px', background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border-color)', borderRadius: 7, minWidth: 80 }}>
                <div style={{ fontSize: 11, color: '#64748b', marginBottom: 2, display: 'flex', alignItems: 'center', gap: 3 }}>NL10 <InfoTooltip text="10-session rolling ACD score. Tracks shorter-term momentum within the 30-day trend.\n\nWhen NL30 is bullish (+9) but NL10 is falling or negative — momentum is weakening. Reduce size on longs. This divergence often precedes a pause or pullback, not necessarily a reversal." /></div>
                <div style={{ fontSize: 15, fontWeight: 800, color: nlColor(acd.nl10), fontFamily: 'monospace' }}>{acd.nl10 > 0 ? '+' : ''}{acd.nl10}</div>
                {acd.nlDiverging && <div style={{ fontSize: 11, color: '#fbbf24' }}>⚠ diverging</div>}
              </div>
            )}
            {bracketState && (
              <div style={{ padding: '8px 14px', background: `${stateColor[bracketState.state] || '#475569'}10`, border: `1px solid ${stateColor[bracketState.state] || '#475569'}30`, borderRadius: 7, flex: 1, minWidth: 160 }}>
                <div style={{ fontSize: 11, color: '#64748b', marginBottom: 2, display: 'flex', alignItems: 'center', gap: 3 }}>Market structure <InfoTooltip text="Based on 5-day value area overlap and migration direction.\n\nBRACKET: value areas overlapping — 75% of market time. Fade extremes, buy VAL, sell VAH, expect mean reversion. Breakouts fail most of the time.\n\nTRENDING: value migrating consistently one direction. Go with extensions, do not fade. Buy pullbacks to prior VAH (up) or sell rallies to prior VAL (down).\n\nTRANSITIONAL: 5-day and 10-day disagree. Most dangerous. Neither strategy works cleanly. Reduce size significantly — wait for confirmation." /></div>
                <div style={{ fontSize: 14, fontWeight: 700, color: stateColor[bracketState.state] || '#94a3b8' }}>
                  {bracketState.state === 'TRENDING_UP' ? '↑ Trending Up' : bracketState.state === 'TRENDING_DOWN' ? '↓ Trending Down' : bracketState.state === 'TRANSITIONAL' ? '⚡ Transitional' : '↔ Bracket'}
                </div>
                {bracketState.transitionalNote
                  ? <div style={{ fontSize: 12, color: '#fbbf24', marginTop: 3, fontWeight: 600 }}>⚠ {bracketState.transitionalNote?.includes('BULLISH') ? 'tilting up — breakouts unconfirmed' : bracketState.transitionalNote?.includes('BEARISH') ? 'tilting down — breakouts unconfirmed' : 'transitional'}</div>
                  : <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2 }}>{bracketState.playbook?.split(' — ')[0]}</div>
                }
              </div>
            )}
            {va && (
              <div style={{ padding: '8px 14px', background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border-color)', borderRadius: 7, minWidth: 110 }}>
                <div style={{ fontSize: 11, color: '#64748b', marginBottom: 2, display: 'flex', alignItems: 'center', gap: 3 }}>Value migration <InfoTooltip text="Direction of daily value area (VAH/POC/VAL) movement over the last 5 sessions.\n\nHIGHER: consecutive days accepting higher prices — buyers in structural control. Dalton: real uptrend = value migrating, not just price moving.\n\nLOWER: consecutive days accepting lower prices — sellers in control.\n\nOVERLAPPING: value areas share significant price range — balanced market, neither side committing. Responsive strategy dominates." /></div>
                <div style={{ fontSize: 14, fontWeight: 700, color: va.direction === 'HIGHER' ? '#22c55e' : va.direction === 'LOWER' ? '#ef4444' : '#94a3b8' }}>
                  {va.direction === 'HIGHER' ? '↑ Higher' : va.direction === 'LOWER' ? '↓ Lower' : '↔ Overlapping'}
                </div>
                <div style={{ fontSize: 11, color: '#64748b' }}>last 5 sessions</div>
              </div>
            )}
            {wk?.weekType && (
              <div style={{ padding: '8px 14px', background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border-color)', borderRadius: 7, minWidth: 110 }}>
                <div style={{ fontSize: 11, color: '#64748b', marginBottom: 2, display: 'flex', alignItems: 'center', gap: 3 }}>This week <InfoTooltip text="Steidlmayer: Monday's range = weekly IB. How far the week extends beyond it reveals OTF conviction.\n\nNORMAL: extends 50% beyond Monday's IB — moderate participation\nNORMAL VARIATION: doubles Monday's IB — meaningful OTF participation\nTREND: closes near extreme, directional throughout — strongest conviction\n\nWeek type can change day by day. A TREND week Monday can become NORMAL by Friday." /></div>
                <div style={{ fontSize: 14, fontWeight: 700, color: wk.weekType === 'TREND' ? '#f97316' : wk.weekType === 'NORMAL_VARIATION' ? '#fbbf24' : '#64748b' }}>
                  {wk.weekType?.replace('_',' ')}
                </div>
                <div style={{ fontSize: 11, color: '#64748b' }}>{wk.weekRange?.toFixed(0)}pt range</div>
              </div>
            )}
            {tpo?.available && (
              <div style={{ padding: '8px 14px', background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border-color)', borderRadius: 7, minWidth: 130 }}>
                <div style={{ fontSize: 11, color: '#64748b', marginBottom: 2, display: 'flex', alignItems: 'center', gap: 3 }}>5-day composite POC <InfoTooltip text="Point of Control from the last 5 sessions — the price where the market has spent the most TIME. This is the strongest magnet price.\n\nAbove composite VA: buyers accepting prices above multi-session fair value — initiative territory.\nBelow composite VA: sellers pushing below multi-session fair value.\nInside composite VA: market rotating within accepted range — responsive strategies.\n\nPrice consistently returns to the composite POC. It is the center of gravity for the multi-day auction." /></div>
                <div style={{ fontSize: 15, fontWeight: 700, color: '#e879f9', fontFamily: 'monospace' }}>{tpo.poc?.toFixed(0)}</div>
                <div style={{ fontSize: 11, color: tpo.priceVsVA === 'ABOVE' ? '#22c55e' : tpo.priceVsVA === 'BELOW' ? '#ef4444' : '#fbbf24' }}>
                  price {tpo.priceVsVA?.toLowerCase()} VA ({tpo.val?.toFixed(0)}–{tpo.vah?.toFixed(0)})
                </div>
              </div>
            )}
          </div>

          {/* Row 2: plain-English implication */}
          {lt?.summary && (
            <div style={{ padding: '8px 14px', background: `${stateColor[bracketState?.state] || '#475569'}08`, borderLeft: `3px solid ${stateColor[bracketState?.state] || '#475569'}`, borderRadius: '0 6px 6px 0', fontSize: 13, color: '#94a3b8', lineHeight: 1.7 }}>
              <span style={{ color: stateColor[bracketState?.state] || '#94a3b8', fontWeight: 700 }}>Structure says: </span>
              {lt.summary.text}
              {tpo?.priceContext && <><br /><span style={{ color: '#e879f9', fontWeight: 700 }}>Composite profile: </span>{tpo.priceContext}</>}
            </div>
          )}

          {/* Row 3: How to trade this environment */}
          {bracketState && (() => {
            const tiltKey = bracketState.transitionalNote?.includes('BULLISH') ? 'BRACKET_TILTING_UP'
                          : bracketState.transitionalNote?.includes('BEARISH') ? 'BRACKET_TILTING_DOWN'
                          : null;
            const g = TRADING_GUIDANCE[tiltKey] || TRADING_GUIDANCE[bracketState.state];
            if (!g) return null;
            const col = stateColor[bracketState.state] || '#94a3b8';
            return (
              <div style={{ padding: '10px 14px', background: 'rgba(0,0,0,0.15)', border: `1px solid ${col}25`, borderRadius: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: col, letterSpacing: '0.05em' }}>
                    HOW TO TRADE THIS ENVIRONMENT
                  </div>
                  {setCurrentView && (
                    <button onClick={() => setCurrentView('playbook')}
                      style={{ fontSize: 11, color: '#3b82f6', background: 'transparent', border: '1px solid rgba(59,130,246,0.3)', borderRadius: 4, padding: '2px 8px', cursor: 'pointer', fontFamily: 'Arial, sans-serif' }}>
                      Full playbook →
                    </button>
                  )}
                </div>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#e2e8f0', marginBottom: 8 }}>{g.headline}</div>
                {g.danger && (
                  <div style={{ marginBottom: 8, padding: '10px 14px', background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.35)', borderRadius: 6 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: '#ef4444', marginBottom: 4, letterSpacing: '0.05em' }}>⛔ WHY TRADERS GET BLOWN OUT HERE</div>
                    <div style={{ fontSize: 12, color: '#fca5a5', lineHeight: 1.7, fontFamily: 'Arial, sans-serif' }}>{g.danger}</div>
                  </div>
                )}
                {g.green && (
                  <div style={{ marginBottom: 8, padding: '10px 14px', background: 'rgba(34,197,94,0.06)', border: '1px solid rgba(34,197,94,0.3)', borderRadius: 6 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: '#22c55e', marginBottom: 4, letterSpacing: '0.05em' }}>✓ THE EDGE IN THIS ENVIRONMENT</div>
                    <div style={{ fontSize: 12, color: '#86efac', lineHeight: 1.7, fontFamily: 'Arial, sans-serif' }}>{g.green}</div>
                  </div>
                )}
                <ul style={{ margin: 0, paddingLeft: 16, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {g.bullets.map((b, i) => (
                    <li key={i} style={{ fontSize: 12, color: '#94a3b8', lineHeight: 1.6, fontFamily: 'Arial, sans-serif' }}>{b}</li>
                  ))}
                </ul>
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}

function CompositeProfileCard() {
  const [tpo, setTpo] = React.useState(null);
  const [days, setDays] = React.useState(5);

  React.useEffect(() => {
    setTpo(null);
    fetch(`${API_URL}/composite-profile?days=${days}`).then(r => r.json()).then(setTpo).catch(() => {});
  }, [days]);

  if (!tpo) return <div style={{ color: '#94a3b8', fontSize: 13, fontFamily: 'Arial, sans-serif', padding: '20px 0' }}>Loading composite profile…</div>;
  if (!tpo.available) return <div style={{ color: '#94a3b8', fontSize: 13 }}>No bar data available.</div>;

  const { profile, poc, vah, val, hvn, lvn, currentPrice, priceContext, priceVsVA, priceVsPoc, maxTpo } = tpo;

  // Clip profile to visible range (within ±200pts of POC for readability)
  const visMin = Math.max(Math.min(...profile.map(r => r.px)), poc - 400);
  const visMax = Math.min(Math.max(...profile.map(r => r.px)), poc + 400);
  const vis = profile.filter(r => r.px >= visMin && r.px <= visMax);

  // Show every 4th level (1-pt increments = 0.25 * 4 = 1pt spacing for display)
  const step = Math.max(1, Math.floor(vis.length / 80));
  const displayed = vis.filter((_, i) => i % step === 0);

  const barMaxW = 180; // max bar width px
  const priceColor = priceVsVA === 'ABOVE' ? '#22c55e' : priceVsVA === 'BELOW' ? '#ef4444' : '#fbbf24';

  return (
    <div style={{ fontFamily: 'Arial, sans-serif', fontSize: 13, color: '#94a3b8' }}>
      {/* Day selector */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        {[5, 10, 20].map(d => (
          <button key={d} onClick={() => setDays(d)}
            style={{ padding: '3px 12px', fontSize: 12, borderRadius: 4, cursor: 'pointer', border: `1px solid ${days === d ? '#3b82f6' : 'var(--border-color)'}`, background: days === d ? '#3b82f6' : 'var(--input-bg)', color: days === d ? '#fff' : '#94a3b8', fontFamily: 'Arial, sans-serif' }}>
            {d}d
          </button>
        ))}
        <span style={{ marginLeft: 8, fontSize: 12, color: '#64748b', alignSelf: 'center' }}>Composite TPO — where price spent the most time</span>
      </div>

      {/* Key levels summary */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        {[
          ['Composite POC', poc?.toFixed(0), '#e879f9', 'Most time spent — strongest magnet'],
          ['Composite VAH', vah?.toFixed(0), '#22c55e', '70% value area high'],
          ['Composite VAL', val?.toFixed(0), '#ef4444', '70% value area low'],
          ['Current', currentPrice?.toFixed(0), priceColor, priceVsVA + ' value area'],
        ].map(([label, val2, color, sub]) => (
          <div key={label} style={{ padding: '6px 12px', background: 'rgba(0,0,0,0.2)', border: `1px solid ${color}30`, borderRadius: 6, minWidth: 100 }}>
            <div style={{ fontSize: 11, color: '#64748b', marginBottom: 2 }}>{label}</div>
            <div style={{ fontSize: 15, fontWeight: 700, color, fontFamily: 'monospace' }}>{val2 || '—'}</div>
            <div style={{ fontSize: 11, color: '#475569' }}>{sub}</div>
          </div>
        ))}
      </div>

      {/* Horizontal profile bars — price on left, bar extending right */}
      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ flex: 1 }}>
          {displayed.slice().reverse().map(row => {
            const isPoc  = Math.abs(row.px - poc) < 0.13;
            const isVah  = Math.abs(row.px - vah) < 0.13;
            const isVal  = Math.abs(row.px - val) < 0.13;
            const isHvn  = hvn.some(h => Math.abs(h - row.px) < 0.13);
            const isLvn  = lvn.some(l => Math.abs(l - row.px) < 0.13);
            const isCur  = currentPrice && Math.abs(row.px - currentPrice) < 2;
            const inVA   = row.px >= val && row.px <= vah;
            const barW   = Math.round((row.tpo / maxTpo) * barMaxW);
            const barColor = isPoc ? '#e879f9' : isHvn ? '#fbbf24' : inVA ? '#3b82f680' : '#47556960';

            return (
              <div key={row.px} style={{ display: 'flex', alignItems: 'center', gap: 4, height: 10, marginBottom: 1 }}>
                <div style={{ width: 52, textAlign: 'right', fontSize: 9, color: isPoc ? '#e879f9' : isVah ? '#22c55e' : isVal ? '#ef4444' : isCur ? priceColor : '#374151', fontWeight: (isPoc || isVah || isVal || isCur) ? 700 : 400, flexShrink: 0, fontFamily: 'monospace' }}>
                  {(isPoc || isVah || isVal || isCur) ? row.px.toFixed(0) : ''}
                </div>
                <div style={{ width: barW, height: 8, background: barColor, borderRadius: 1, flexShrink: 0, minWidth: 1 }} />
                {isCur && <div style={{ width: 2, height: 12, background: priceColor, flexShrink: 0, marginLeft: -2 }} />}
                {(isPoc || isHvn || isLvn) && (
                  <div style={{ fontSize: 9, color: isPoc ? '#e879f9' : isHvn ? '#fbbf24' : '#ef4444', flexShrink: 0 }}>
                    {isPoc ? 'POC' : isHvn ? 'HVN' : 'LVN'}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Context sentence */}
      {priceContext && (
        <div style={{ marginTop: 10, padding: '8px 12px', background: `${priceColor}08`, borderLeft: `3px solid ${priceColor}`, borderRadius: '0 6px 6px 0', fontSize: 13, color: '#cbd5e1', lineHeight: 1.7 }}>
          {priceContext}
        </div>
      )}

      {/* HVN/LVN list */}
      {(hvn.length > 0 || lvn.length > 0) && (
        <div style={{ marginTop: 10, display: 'flex', gap: 16, fontSize: 12, flexWrap: 'wrap' }}>
          {hvn.length > 0 && <div><span style={{ color: '#fbbf24', fontWeight: 700 }}>HVN </span><span style={{ color: '#94a3b8', fontFamily: 'monospace' }}>{hvn.slice(0,5).map(h=>h.toFixed(0)).join(' · ')}</span></div>}
          {lvn.length > 0 && <div><span style={{ color: '#ef4444', fontWeight: 700 }}>LVN </span><span style={{ color: '#94a3b8', fontFamily: 'monospace' }}>{lvn.slice(0,5).map(l=>l.toFixed(0)).join(' · ')}</span></div>}
        </div>
      )}

      <div style={{ marginTop: 8, fontSize: 11, color: '#475569' }}>
        HVN = high time node (price slows here) · LVN = low time node (price moves fast through) · POC = point of control (most time spent)
      </div>
    </div>
  );
}

// ── Playbook Reference Page ────────────────────────────────────────────────────

const PLAYBOOK_SECTIONS = [
  {
    id: 'bracket',
    title: 'Bracket Environment',
    color: '#3b82f6',
    tag: 'BRACKET',
    tagColor: '#3b82f6',
    subtitle: 'Responsive strategy — fade the extremes',
    source: 'Dalton (Markets in Profile) + Steidlmayer',
    context: 'A bracket forms when the market has found accepted value and is rotating between a defined high and low. Value areas overlap day after day. This is the dominant market condition — roughly 75% of all trading time. Neither buyers nor sellers are committing directionally.',
    rules: [
      { rule: 'Buy near VAL, sell near VAH', detail: 'The bracket edges are your targets AND your entry zones. VAL (value area low) is where buyers have stepped in historically — that is where responsive buyers enter. VAH (value area high) is where sellers have stepped in. Trade toward the opposite edge, not beyond it.' },
      { rule: 'Do NOT hold breakouts', detail: '75% of breakout attempts in a bracket fail and snap back. When price breaks above VAH, the most likely scenario is a return to VAH or below. The breakout traders get faded by responsive sellers. Wait for confirmation before treating a breakout as real.' },
      { rule: 'Reduce size on A signals', detail: 'An A Up signal inside a bracket has significantly lower follow-through than an A Up in a trending environment. The bracket\'s structural resistance dampens the move. Trade A signals with 50-75% of normal size until the bracket confirms a break.' },
      { rule: 'Target the midpoint', detail: 'If you buy VAL, target the POC (point of control) first, then the VAH. Do not expect a full bracket range move in one session. The POC is the gravitational center — price rotates around it and often stalls there.' },
      { rule: 'Watch for bracket compression', detail: 'If value areas are getting narrower each day (VAH-VAL spread shrinking), the market is compressing energy. A significant breakout is building. Do not predict the direction but prepare to act fast when it comes.' },
    ],
    warning: 'The most dangerous bracket condition: when NL30 is bullish AND value is migrating higher AND the week looks like a trend — but the bracket has not confirmed. This is where trend traders get blown out. Everything tells you to buy the breakout. The bracket snaps it back. You try again. Same result. Three stops later the structural story still sounds right but your account is down. Dalton specifically calls this out: the bracket that looks like it should break but doesn\'t is the most consistently costly condition in market profile trading.',
    setup: 'Best setup: fade the first extension beyond VAH or VAL in the first 30 minutes if the OR is narrow (NORMAL or NARROW condition). The first push is often the entry point.',
  },
  {
    id: 'trending-up',
    title: 'Trending Up Environment',
    color: '#22c55e',
    tag: 'TRENDING UP',
    tagColor: '#22c55e',
    subtitle: 'Initiative strategy — go with extensions',
    source: 'Dalton + Fisher (The Logical Trader)',
    context: 'Value areas are migrating higher consistently — the market is accepting higher prices. OTF (other timeframe) buyers are in control and are consistently willing to transact at elevated levels. NL30 above +9 confirms multi-session structural support for longs.',
    rules: [
      { rule: 'Buy pullbacks to prior day VAH', detail: 'In a trend, prior resistance becomes support. Yesterday\'s VAH is today\'s buy zone. Price pulls back to it, finds buyers, and extends higher. This is the highest-quality entry in a trending environment — you have structure behind you and a defined stop level.' },
      { rule: 'Do NOT short into strength', detail: 'Countertrend fades in a trend get destroyed. Every time price makes a new high and you short, you are fighting OTF buyers who have unlimited capital and a structural thesis. Your structural edge is zero on the short side. Reserve shorts for when the trend breaks.' },
      { rule: 'A Down signals have high failure rate', detail: 'In a bullish NL30 (+9) environment, A Down signals fail significantly more often than in neutral conditions. Sellers try, fail, and price recovers. If you trade A Downs in a bull trend, use minimal size and exit quickly on any stall.' },
      { rule: 'Hold A Up signals longer', detail: 'In a trending environment, A Up + C confirmation is the highest-conviction setup available. The structure is aligned — pre-market bias, number line, and value migration all support the move. Hold these past initial targets. Trail stops to prior session VAH.' },
      { rule: 'NL30 alignment is the multiplier', detail: 'When NL30 > +9 AND value is migrating higher AND you have an A Up signal, all three timeframes agree. Fisher: this is the condition where the trade is most likely to exceed its initial target. Size up to normal (not more — structure supports but does not guarantee).' },
    ],
    warning: 'The biggest trap in a trend: giving back gains by over-staying. A trend that is showing absorption (heavy volume, narrow range, close off the high) is warning you. The first profile shape that goes FAT after a series of elongated ones is the earliest sign the trend is slowing.',
    setup: 'Best setup: Open Drive in the trend direction + A signal confirmation within the first hour. The OD tells you OTF is committed from the open; the A signal gives you the structural entry level with a defined stop.',
  },
  {
    id: 'trending-down',
    title: 'Trending Down Environment',
    color: '#ef4444',
    tag: 'TRENDING DOWN',
    tagColor: '#ef4444',
    subtitle: 'Initiative strategy — go with extensions downward',
    source: 'Dalton + Fisher (The Logical Trader)',
    context: 'Value areas are migrating lower. OTF sellers are in control. NL30 below -9 confirms multi-session structural support for shorts. The same principles as trending up apply in reverse.',
    rules: [
      { rule: 'Sell rallies to prior day VAL', detail: 'Prior support flips to resistance in a downtrend. Yesterday\'s VAL is today\'s sell zone. Price rallies into it, finds sellers, and extends lower. This is your structural entry with a defined stop above the VAL.' },
      { rule: 'Do NOT buy dips expecting a bounce', detail: 'Countertrend longs in a downtrend lose money systematically. OTF sellers will press every rally. Your structural edge is zero on the long side during a confirmed downtrend.' },
      { rule: 'A Up signals have high failure rate', detail: 'In a bearish NL30 environment, A Up signals fail significantly more often. Buyers try, get absorbed, and price reverses lower. Skip or trade with minimal size.' },
      { rule: 'Failed A Down signals are extra powerful', detail: 'In a downtrend, when price reaches A Down and then reverses up — that failed A Down often leads to a quick recovery that gets sold again. Sellers come back. The failure does not mean the trend changed.' },
      { rule: 'Hold A Down + C confirmation', detail: 'A Down fired + C Down confirmed in a bearish NL30 environment is the highest-conviction short setup. Trail stops to prior session VAL on the way down.' },
    ],
    warning: 'Catching falling knives: the most common mistake is buying into a downtrend looking for "cheap" prices. Dalton specifically addresses this — price can always go lower and value can always migrate lower. There is no objective "oversold" in a trending market.',
    setup: 'Best setup: gap below prior VAL on the open (Open Drive lower) + A Down signal within the first hour. The gap tells you overnight sellers committed; the A signal gives you the structural entry.',
  },
  {
    id: 'transitional',
    title: 'Transitional Environment',
    color: '#fbbf24',
    tag: 'TRANSITIONAL',
    tagColor: '#fbbf24',
    subtitle: 'Reduce size 50%+ — only the most obvious setups',
    source: 'Dalton + Steidlmayer (Mind Over Markets)',
    context: 'The 5-day and 10-day structure disagree. Either a bracket is breaking into a trend, or a trend is exhausting into a bracket. Neither strategy works cleanly. This is the most dangerous condition — strategies that worked in the prior regime stop working before the new direction confirms.',
    rules: [
      { rule: 'Bracket → Trend: wait for confirmed VA migration', detail: 'When a bracket breaks, the temptation is to chase the breakout. Do not. Wait for the first day where value MIGRATES (VAH-POC-VAL all establish above/below prior day). That is the first confirmed step of a new trend. Then buy the pullback to the new VAH — not the breakout.' },
      { rule: 'Bracket → Trend: use NL30 as the deciding vote', detail: 'If NL30 is above +9 and a bullish breakout is developing, the trend has multi-session structural backing — higher conviction. If NL30 is ranging and the bracket breaks, the move is less reliable. The A signal in the breakout direction is your entry confirmation.' },
      { rule: 'Trend → Bracket: stop adding to trend positions', detail: 'The first sign of regime change is the trend\'s reliable setups starting to fail. If A signals in the trend direction are failing 2-3 consecutive times, the trend is exhausting. Stop adding. Tighten stops on existing positions. Do not add contracts.' },
      { rule: 'Trend → Bracket: look for failed A signals as confirmation', detail: 'Failed A signals are the first technical confirmation that the trend is shifting to balance. When the trend\'s entry signal (A Up in an uptrend, A Down in a downtrend) starts failing consistently, the regime has changed. Shift to responsive strategy.' },
      { rule: 'Wait for the 10:00-10:30 window', detail: 'In transitional conditions, the opening often does not give clear direction. The 10:00-10:30 window is when the session\'s character becomes clearer. If no A signal has fired by 10:30, the day is likely going auction/rotational — set tighter targets and reduce size further.' },
    ],
    warning: 'The most costly losses in transitional environments come from traders who see a bullish structural backdrop (NL30 green, value migrating up, trend week) and size up like it\'s a clean trend — when it\'s actually a bracket in transition. The bracket punishes breakout buyers repeatedly because the structural story always feels right. Each failed breakout costs a full stop. The confirmation requirement — value migrating above prior VAH for a full session — is the only protection against this trap.',
    setup: 'Best setup in transitional conditions: wait for the Opening Range to form. An ORR (Open Rejection Reverse) opening is most common in transitional states — it tests one direction, finds rejection, and reverses. The reversal direction often indicates which regime is winning.',
  },
  {
    id: 'opening-types',
    title: 'Opening Call Types',
    color: '#a78bfa',
    tag: 'OPENING READS',
    tagColor: '#a78bfa',
    subtitle: 'Reading the first 15 minutes',
    source: 'Steidlmayer (Market Profile Handbook)',
    context: 'The opening call classifies the first 15 minutes of the session. It tells you how OTF participants are positioning at the open and sets the tone for the entire session.',
    rules: [
      { rule: 'Open Drive (OD)', detail: 'Price immediately extends one direction from the open with no pullback. High directional conviction. OTF is committed from the start. Trade with the drive — do not fade. An A signal in the drive direction is high conviction. This is the most powerful opening type.' },
      { rule: 'Open Test Drive (OTD)', detail: 'Price tests one side of the OR (or prior VA), finds no acceptance, then drives hard the other direction. The initial test is the "tell" — that side had no conviction. The drive after the test is the real direction. Trade the drive side.' },
      { rule: 'Open Rejection Reverse (ORR)', detail: 'Price opens, extends beyond one edge of prior value, gets rejected, and reverses back inside value. The rejection confirms that side (above VAH or below VAL) had no acceptance. Fade the initial extension back toward the POC or opposite edge. Responsive play.' },
      { rule: 'Open Auction (OA)', detail: 'Price rotates within or near the OR, testing both sides without committing. Neither buyers nor sellers have conviction at the open. Two-sided, rotational day likely. Set tight targets, expect price to keep rotating. Wait for an A signal before taking directional risk.' },
    ],
    warning: 'Opening type is a condition, not a signal by itself. An Open Drive is only a trade if combined with structural alignment (pre-market bias, NL30, A signal). The opening call CONFIRMS or CONTRADICTS your pre-market read — it does not replace it.',
    setup: '',
  },
  {
    id: 'acd-by-nl',
    title: 'ACD Signals by NL30 State',
    color: '#06b6d4',
    tag: 'ACD CONTEXT',
    tagColor: '#06b6d4',
    subtitle: 'Signal quality changes with the trend',
    source: 'Fisher (The Logical Trader)',
    context: 'The same A signal has different quality depending on the NL30 state. Fisher explicitly showed this: an A Up in a +12 NL30 environment is fundamentally different from an A Up in a -6 NL30 environment.',
    rules: [
      { rule: 'NL30 > +9: A Up is high conviction', detail: 'The 30-session trend is confirmed bullish. OTF buyers have been reliably showing up for a month. An A Up in this environment has structural multi-timeframe support. Hold longer, use normal size, target above initial OR extension targets.' },
      { rule: 'NL30 > +9: A Down is low conviction', detail: 'Selling against a confirmed bullish trend. Sellers have been losing the monthly battle. A Down signals fail frequently — the buyers absorb the initial breakdown. If you trade A Downs here, use 25-50% of normal size and exit on any stall.' },
      { rule: 'NL30 ranging (-9 to +9): trade both but reduce size', detail: 'No multi-session directional edge. Both A Up and A Down signals are lower conviction than in a trending NL30 environment. Day-trade only — do not hold overnight based on ACD alone. Size down 25-50%.' },
      { rule: 'NL30 < -9: A Down is high conviction', detail: 'Confirmed bearish trend. Sellers have dominated 30 sessions. A Down + C confirmation has the highest structural support. Hold longer, target below initial levels.' },
      { rule: 'NL10 diverging from NL30: early warning', detail: 'When NL30 is bullish (+9) but NL10 is negative, shorter-term momentum is working against the trend. This is not a reversal signal — it is a reason to reduce size on longs and tighten stops. Do not add contracts when NL10 diverges negatively.' },
    ],
    warning: 'The NL30 is only as good as the data feeding it. If you have missed logging A and C signals for multiple sessions, the number will be inaccurate. Check data quality (logged days count) before trusting the reading.',
    setup: '',
  },
];

function PlaybookPage() {
  const [activeSection, setActiveSection] = React.useState(null);

  React.useEffect(() => {
    const hash = window.location.hash?.slice(1);
    if (hash) {
      setActiveSection(hash);
      setTimeout(() => {
        const el = document.getElementById(hash);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 100);
    }
  }, []);

  const Section = ({ s }) => {
    const isOpen = activeSection === s.id || activeSection === null;
    return (
      <div id={s.id} style={{ background: 'var(--card-bg)', border: `1px solid ${s.color}30`, borderLeft: `4px solid ${s.color}`, borderRadius: 10, marginBottom: 16, overflow: 'hidden', fontFamily: 'Arial, sans-serif' }}>
        <button onClick={() => setActiveSection(activeSection === s.id ? null : s.id)}
          style={{ width: '100%', background: 'transparent', border: 'none', cursor: 'pointer', padding: '14px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', textAlign: 'left' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ padding: '2px 8px', background: `${s.tagColor}20`, color: s.tagColor, borderRadius: 4, fontSize: 11, fontWeight: 700, letterSpacing: '0.06em' }}>{s.tag}</span>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>{s.title}</div>
              <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 1 }}>{s.subtitle}</div>
            </div>
          </div>
          <span style={{ color: '#64748b', fontSize: 12 }}>{activeSection === s.id ? '▲' : '▼'}</span>
        </button>

        {activeSection === s.id && (
          <div style={{ padding: '0 20px 20px', borderTop: `1px solid ${s.color}20` }}>
            {/* Source */}
            <div style={{ fontSize: 11, color: '#475569', fontStyle: 'italic', margin: '12px 0 10px', fontFamily: 'Arial, sans-serif' }}>Source: {s.source}</div>

            {/* Context */}
            <div style={{ fontSize: 13, color: '#94a3b8', lineHeight: 1.8, marginBottom: 16, padding: '10px 14px', background: 'rgba(0,0,0,0.15)', borderRadius: 6, fontFamily: 'Arial, sans-serif' }}>
              {s.context}
            </div>

            {/* Rules */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: s.warning ? 14 : 0 }}>
              {s.rules.map((r, i) => (
                <div key={i} style={{ padding: '10px 14px', background: `${s.color}06`, borderLeft: `2px solid ${s.color}50`, borderRadius: '0 6px 6px 0' }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: s.color, marginBottom: 4 }}>{r.rule}</div>
                  <div style={{ fontSize: 13, color: '#cbd5e1', lineHeight: 1.7, fontFamily: 'Arial, sans-serif' }}>{r.detail}</div>
                </div>
              ))}
            </div>

            {/* Danger */}
            {s.warning && (
              <div style={{ marginTop: 14, padding: '12px 16px', background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.35)', borderRadius: 8 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#ef4444', marginBottom: 6, letterSpacing: '0.05em' }}>⛔ WHY TRADERS GET BLOWN OUT HERE</div>
                <div style={{ fontSize: 13, color: '#fca5a5', lineHeight: 1.8, fontFamily: 'Arial, sans-serif' }}>{s.warning}</div>
              </div>
            )}

            {/* Green light */}
            {s.setup && (
              <div style={{ marginTop: 10, padding: '12px 16px', background: 'rgba(34,197,94,0.06)', border: '1px solid rgba(34,197,94,0.3)', borderRadius: 8 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#22c55e', marginBottom: 6, letterSpacing: '0.05em' }}>✓ THE EDGE IN THIS ENVIRONMENT</div>
                <div style={{ fontSize: 13, color: '#86efac', lineHeight: 1.8, fontFamily: 'Arial, sans-serif' }}>{s.setup}</div>
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={{ padding: '24px 28px', maxWidth: 900, margin: '0 auto', fontFamily: 'Arial, sans-serif' }}>
      <div style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 22, fontWeight: 700, margin: '0 0 6px' }}>Trading Playbook</h2>
        <div style={{ fontSize: 13, color: '#64748b', lineHeight: 1.6 }}>
          Static reference — how to trade each market environment and condition. Based on Dalton, Steidlmayer, Fisher, and Weis.<br/>
          <span style={{ color: '#475569' }}>Click any section to expand. These are conditions and playbooks — not signals. Your A signal and opening read provide the actual entry trigger.</span>
        </div>
      </div>

      {/* Quick reference table */}
      <div style={{ background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderRadius: 10, padding: '16px 20px', marginBottom: 20 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: '#94a3b8', letterSpacing: '0.07em', textTransform: 'uppercase', marginBottom: 12, fontFamily: 'Arial, sans-serif' }}>
          Quick Reference — Every Condition at a Glance
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, fontFamily: 'Arial, sans-serif' }}>
          <thead>
            <tr style={{ borderBottom: '2px solid var(--border-color)' }}>
              {['Condition', 'Blown out by', 'The edge'].map(h => (
                <th key={h} style={{ padding: '6px 12px', textAlign: 'left', color: '#64748b', fontWeight: 700, fontSize: 11, letterSpacing: '0.05em', textTransform: 'uppercase' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[
              { state: 'BRACKET',             color: '#3b82f6', label: '↔ Bracket',             blown: 'Chasing breakouts that snap back repeatedly',                         edge: 'Fade VAH/VAL edges — defined targets, responsive strategy' },
              { state: 'BRACKET_TILTING_UP',  color: '#fbbf24', label: '↔ Bracket tilting up',  blown: 'Buying every VAH push thinking it\'s the breakout — 3 stops later',   edge: 'Wait for one full session of value above prior VAH, then shift' },
              { state: 'BRACKET_TILTING_DOWN',color: '#fbbf24', label: '↔ Bracket tilting down',blown: 'Shorting every VAL break that bounces back into value',                edge: 'Wait for one full session of value below prior VAL, then shift' },
              { state: 'TRENDING_UP',         color: '#22c55e', label: '↑ Trending Up',          blown: 'Shorting into strength + overstaying trend past absorption signals',    edge: 'A Up + C confirm + NL30 >+9 — hold past initial targets, trail to prior VAH' },
              { state: 'TRENDING_DOWN',       color: '#ef4444', label: '↓ Trending Down',        blown: 'Buying dips ("it\'s cheap") / averaging into a structural downtrend',   edge: 'A Down + C confirm + NL30 <-9 — trail stops to prior VAL' },
              { state: 'TRANSITIONAL',        color: '#fbbf24', label: '⚡ Transitional',        blown: 'Using either strategy with full size before the new regime confirms',   edge: 'Patience — first confirmed VA migration = early-trend entry, not the breakout itself' },
            ].map((row, i) => (
              <tr key={row.state} style={{ borderBottom: '1px solid var(--border-color)', background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)' }}>
                <td style={{ padding: '9px 12px', whiteSpace: 'nowrap' }}>
                  <span style={{ color: row.color, fontWeight: 700 }}>{row.label}</span>
                </td>
                <td style={{ padding: '9px 12px', color: '#fca5a5', lineHeight: 1.5 }}>{row.blown}</td>
                <td style={{ padding: '9px 12px', color: '#86efac', lineHeight: 1.5 }}>{row.edge}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Quick nav */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 20 }}>
        <button onClick={() => setActiveSection(null)}
          style={{ padding: '4px 12px', fontSize: 11, borderRadius: 4, cursor: 'pointer', border: '1px solid var(--border-color)', background: activeSection === null ? '#3b82f6' : 'var(--input-bg)', color: activeSection === null ? '#fff' : '#94a3b8', fontFamily: 'Arial, sans-serif' }}>
          All open
        </button>
        {PLAYBOOK_SECTIONS.map(s => (
          <button key={s.id} onClick={() => { setActiveSection(s.id); setTimeout(() => document.getElementById(s.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50); }}
            style={{ padding: '4px 12px', fontSize: 11, borderRadius: 4, cursor: 'pointer', border: `1px solid ${s.color}40`, background: activeSection === s.id ? `${s.color}20` : 'var(--input-bg)', color: activeSection === s.id ? s.color : '#94a3b8', fontFamily: 'Arial, sans-serif', fontWeight: activeSection === s.id ? 700 : 400 }}>
            {s.tag}
          </button>
        ))}
      </div>

      {PLAYBOOK_SECTIONS.map(s => <Section key={s.id} s={s} />)}

      {/* Backtest Results */}
      <ConditionBacktest />
    </div>
  );
}

function PatternStatsPanel() {
  const [stats, setStats]   = React.useState([]);
  const [lookback, setLookback] = React.useState(30);
  const [loading, setLoading]   = React.useState(true);

  React.useEffect(() => {
    setLoading(true);
    fetch(`${API_URL}/pattern/stats?lookback=${lookback}`)
      .then(r => r.json()).then(d => { setStats(Array.isArray(d) ? d : []); setLoading(false); })
      .catch(() => setLoading(false));
  }, [lookback]);

  const trendColor = { IMPROVING: '#22c55e', STABLE: '#64748b', DEGRADING: '#ef4444' };
  const trendIcon  = { IMPROVING: '↑ IMPROVING', STABLE: '→ STABLE', DEGRADING: '↓ DEGRADING' };
  const stateLabel = { BRACKET: '↔ Bracket', BRACKET_TILTING_UP: '↔ Bracket ↑', BRACKET_TILTING_DOWN: '↔ Bracket ↓', TRENDING_UP: '↑ Trend Up', TRENDING_DOWN: '↓ Trend Down', TRANSITIONAL: '⚡ Transitional' };

  const degrading = stats.filter(s => s.degrading_alert);

  return (
    <div style={{ background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderRadius: 12, padding: '18px 22px', marginBottom: 20, fontFamily: 'Arial, sans-serif' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>Pattern Stats — Rolling Performance by Structural State</div>
          <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>
            Based on your logged sessions with sufficient data (auction_reads + trades recorded)
            <InfoTooltip tooltip={{ text: 'Performance metrics grouped by structural state (Bracket, Trend, Transitional). Shows how your actual trading has performed in each environment. Updated nightly. Minimum sessions for meaningful stats: 5.', source: 'Based on your logged sessions — not theoretical backtests' }} />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {[30, 60, 90].map(d => (
            <button key={d} onClick={() => setLookback(d)}
              style={{ padding: '4px 12px', fontSize: 12, borderRadius: 4, cursor: 'pointer', border: `1px solid ${lookback===d ? '#3b82f6' : 'var(--border-color)'}`, background: lookback===d ? '#3b82f6' : 'var(--input-bg)', color: lookback===d ? '#fff' : '#94a3b8', fontFamily: 'Arial, sans-serif' }}>
              {d}d
            </button>
          ))}
        </div>
      </div>

      {degrading.length > 0 && (
        <div style={{ padding: '8px 12px', background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 6, marginBottom: 12, fontSize: 12, color: '#fca5a5', lineHeight: 1.7 }}>
          <strong style={{ color: '#ef4444' }}>⚠ DEGRADING conditions detected:</strong>{' '}
          {degrading.map(s => `${stateLabel[s.structural_state] || s.structural_state}: win rate dropped vs prior ${lookback}-day window`).join(' · ')}
          <br/><span style={{ color: '#475569' }}>Review your approach in these environments.</span>
        </div>
      )}

      {loading ? (
        <div style={{ color: '#64748b', fontSize: 13 }}>Loading pattern stats…</div>
      ) : stats.length === 0 ? (
        <div style={{ color: '#64748b', fontSize: 13 }}>No pattern stats yet — runs nightly after 4 PM ET. Use the backfill to populate historical data.</div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: 'Arial, sans-serif' }}>
          <thead>
            <tr style={{ borderBottom: '2px solid var(--border-color)' }}>
              {['Structural State', 'Sessions', 'Win %', 'Avg P&L', 'T1 Hit %', 'Trend'].map(h => (
                <th key={h} style={{ padding: '6px 10px', textAlign: 'left', color: '#64748b', fontSize: 11, fontWeight: 700, letterSpacing: '0.04em' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {stats.map((s, i) => {
              const isDegrad = s.degrading_alert;
              const isImprove = s.win_rate_trend === 'IMPROVING';
              const rowBg = isDegrad ? 'rgba(239,68,68,0.05)' : isImprove ? 'rgba(34,197,94,0.04)' : 'transparent';
              return (
                <tr key={s.structural_state} style={{ borderBottom: '1px solid rgba(100,116,139,0.1)', background: rowBg }}>
                  <td style={{ padding: '8px 10px', color: '#94a3b8', fontWeight: 600 }}>{stateLabel[s.structural_state] || s.structural_state}</td>
                  <td style={{ padding: '8px 10px', color: '#94a3b8', fontFamily: 'monospace' }}>{s.total_sessions}</td>
                  <td style={{ padding: '8px 10px', fontFamily: 'monospace', color: s.avg_win_rate >= 0.6 ? '#22c55e' : s.avg_win_rate >= 0.45 ? '#fbbf24' : '#ef4444', fontWeight: 700 }}>
                    {s.avg_win_rate != null ? (s.avg_win_rate * 100).toFixed(1) + '%' : '—'}
                  </td>
                  <td style={{ padding: '8px 10px', fontFamily: 'monospace', color: s.avg_pnl_per_session > 0 ? '#22c55e' : '#ef4444' }}>
                    {s.avg_pnl_per_session != null ? (s.avg_pnl_per_session > 0 ? '+' : '') + Number(s.avg_pnl_per_session).toFixed(0) : '—'}
                  </td>
                  <td style={{ padding: '8px 10px', color: '#94a3b8', fontFamily: 'monospace' }}>
                    {s.t1_hit_rate != null ? (s.t1_hit_rate * 100).toFixed(0) + '%' : '—'}
                  </td>
                  <td style={{ padding: '8px 10px', color: trendColor[s.win_rate_trend] || '#475569', fontWeight: s.win_rate_trend ? 700 : 400 }}>
                    {s.win_rate_trend ? trendIcon[s.win_rate_trend] : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function ConditionBacktestInline() {
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [expanded, setExpanded] = React.useState(false);

  React.useEffect(() => {
    fetch(`${API_URL}/backtest/conditions`)
      .then(r => r.json()).then(d => { setData(d); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  if (loading) return <div style={{ padding: 16, color: '#94a3b8', fontFamily: 'Arial, sans-serif', fontSize: 13 }}>Running condition backtest…</div>;
  if (!data?.available) return null;

  const f = data.fades; const a = data.aSignals;
  const log = data.dailyLog || [];

  const structureColor = { BRACKET: '#3b82f6', BRACKET_TILTING_UP: '#fbbf24', BRACKET_TILTING_DOWN: '#fbbf24', TRENDING_UP: '#22c55e', TRENDING_DOWN: '#ef4444', TRANSITIONAL: '#fbbf24' };
  const structureShort = { BRACKET: '↔ Bracket', BRACKET_TILTING_UP: '↔ Tilt ↑', BRACKET_TILTING_DOWN: '↔ Tilt ↓', TRENDING_UP: '↑ Trend', TRENDING_DOWN: '↓ Trend', TRANSITIONAL: '⚡ Trans.' };

  const KEY_FINDINGS = [
    { label: 'Fade VAH — clean bracket', stat: f.vahBracket, note: 'Confirmed bracket (≥4 overlapping days)' },
    { label: 'Fade VAH — bracket tilting up ⚠', stat: f.vahTilting, note: 'Value migrating higher — the trap' },
    { label: 'A Up — NL30 bullish', stat: a.aUpBullish, note: 'Signal with multi-session tailwind' },
    { label: 'A Down — NL30 bullish ⚠', stat: a.aDownBullish, note: 'Counter-trend short in bull environment' },
    { label: 'A Down — NL30 ranging', stat: a.aDownRanging, note: 'Short signal, no trend context' },
  ].filter(x => x.stat);

  return (
    <div style={{ background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderRadius: 12, padding: '18px 22px', marginBottom: 20, fontFamily: 'Arial, sans-serif' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>Market Structure Backtest — {data.totalDays} Trading Days</div>
          <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>How well did the playbook's suggested edge actually work per condition?</div>
        </div>
        <button onClick={() => setExpanded(e => !e)}
          style={{ padding: '5px 14px', fontSize: 12, borderRadius: 5, cursor: 'pointer', border: '1px solid var(--border-color)', background: 'var(--input-bg)', color: '#94a3b8', fontFamily: 'Arial, sans-serif' }}>
          {expanded ? 'Hide day log' : 'Show day log'}
        </button>
      </div>

      {/* Key findings */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 8, marginBottom: 14 }}>
        {KEY_FINDINGS.map(({ label, stat, note }) => {
          const color = stat.winRate >= 60 ? '#22c55e' : stat.winRate >= 45 ? '#fbbf24' : '#ef4444';
          const ptsColor = stat.avgPts > 0 ? '#22c55e' : '#ef4444';
          return (
            <div key={label} style={{ padding: '10px 12px', background: `${color}08`, border: `1px solid ${color}30`, borderRadius: 7 }}>
              <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>{label}</div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span style={{ fontSize: 22, fontWeight: 800, color, fontFamily: 'monospace' }}>{stat.winRate}%</span>
                <span style={{ fontSize: 12, color: ptsColor, fontFamily: 'monospace' }}>{stat.avgPts > 0 ? '+' : ''}{stat.avgPts}pts avg</span>
              </div>
              <div style={{ fontSize: 11, color: '#475569', marginTop: 2 }}>{stat.wins}/{stat.n} sessions · {note}</div>
            </div>
          );
        })}
      </div>

      {/* Critical alerts */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: expanded ? 14 : 0 }}>
        {f.vahTilting && f.vahTilting.n >= 3 && f.vahTilting.winRate <= 20 && (
          <div style={{ padding: '8px 12px', background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 6, fontSize: 12, color: '#fca5a5', lineHeight: 1.6 }}>
            ⛔ <strong>Fading VAH in a tilting bracket: {f.vahTilting.winRate}% win rate</strong> over {f.vahTilting.n} sessions (avg {f.vahTilting.avgPts}pts). This is the condition that blew you out. The data confirms it — do not fade VAH when value is migrating higher.
          </div>
        )}
        {a.aDownBullish && a.aDownBullish.n >= 3 && a.aDownBullish.avgPts < 0 && (
          <div style={{ padding: '8px 12px', background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 6, fontSize: 12, color: '#fca5a5', lineHeight: 1.6 }}>
            ⛔ <strong>A Down when NL30 bullish: {a.aDownBullish.winRate}% win rate</strong> over {a.aDownBullish.n} sessions (avg {a.aDownBullish.avgPts}pts). Counter-trend shorts in a bull environment have negative expectancy in your data.
          </div>
        )}
      </div>

      {/* Day-by-day log */}
      {expanded && (
        <div style={{ overflowX: 'auto', borderTop: '1px solid var(--border-color)', paddingTop: 12 }}>
          <div style={{ fontSize: 11, color: '#64748b', marginBottom: 8 }}>
            Green = edge worked · Red = edge failed · Gray = no directional bet recommended for that day
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: 'Arial, sans-serif' }}>
            <thead>
              <tr style={{ borderBottom: '2px solid var(--border-color)' }}>
                {['Date','Structure','NL30','Suggested edge','Pts','Outcome'].map(h => (
                  <th key={h} style={{ padding: '6px 10px', textAlign: 'left', color: '#64748b', fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {log.map((row, i) => (
                <tr key={row.date} style={{ borderBottom: '1px solid rgba(100,116,139,0.1)', background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)' }}>
                  <td style={{ padding: '7px 10px', color: '#94a3b8', fontFamily: 'monospace', fontSize: 11, whiteSpace: 'nowrap' }}>{row.date}</td>
                  <td style={{ padding: '7px 10px', whiteSpace: 'nowrap' }}>
                    <span style={{ color: structureColor[row.structure] || '#94a3b8', fontWeight: 600, fontSize: 11 }}>{structureShort[row.structure] || row.structure}</span>
                  </td>
                  <td style={{ padding: '7px 10px', whiteSpace: 'nowrap' }}>
                    <span style={{ color: row.nl30 > 9 ? '#22c55e' : row.nl30 < -9 ? '#ef4444' : '#fbbf24', fontFamily: 'monospace', fontSize: 12, fontWeight: 600 }}>
                      {row.nl30 > 0 ? '+' : ''}{row.nl30}
                    </span>
                  </td>
                  <td style={{ padding: '7px 10px', color: '#94a3b8', maxWidth: 280, lineHeight: 1.4, fontSize: 12 }}>{row.suggestedEdge}</td>
                  <td style={{ padding: '7px 10px', fontFamily: 'monospace', fontWeight: 700, whiteSpace: 'nowrap', color: row.ptsVsOpen > 0 ? '#22c55e' : row.ptsVsOpen < 0 ? '#ef4444' : '#94a3b8' }}>
                    {row.ptsVsOpen > 0 ? '+' : ''}{row.ptsVsOpen}
                  </td>
                  <td style={{ padding: '7px 10px', whiteSpace: 'nowrap' }}>
                    {row.edgeWorked === true  && <span style={{ color: '#22c55e', fontWeight: 700 }}>✓ Worked</span>}
                    {row.edgeWorked === false && <span style={{ color: '#ef4444', fontWeight: 700 }}>✗ Failed</span>}
                    {row.edgeWorked === null  && <span style={{ color: '#475569' }}>— No bet</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ConditionBacktest() {
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    fetch(`${API_URL}/backtest/conditions`)
      .then(r => r.json()).then(d => { setData(d); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  const [view, setView] = React.useState('daily'); // 'daily' | 'summary'

  if (loading) return <div style={{ padding: 20, color: '#94a3b8', fontFamily: 'Arial, sans-serif' }}>Running condition backtest…</div>;
  if (!data?.available) return null;

  const structureColor = { BRACKET: '#3b82f6', BRACKET_TILTING_UP: '#fbbf24', BRACKET_TILTING_DOWN: '#fbbf24', TRENDING_UP: '#22c55e', TRENDING_DOWN: '#ef4444', TRANSITIONAL: '#fbbf24' };
  const structureLabel = { BRACKET: '↔ Bracket', BRACKET_TILTING_UP: '↔ Bracket ↑tilt', BRACKET_TILTING_DOWN: '↔ Bracket ↓tilt', TRENDING_UP: '↑ Trending Up', TRENDING_DOWN: '↓ Trending Down', TRANSITIONAL: '⚡ Transitional' };
  const nlColor = n => n === 'BULLISH' ? '#22c55e' : n === 'BEARISH' ? '#ef4444' : '#fbbf24';

  const Stat = ({ label, result, invert = false, note }) => {
    if (!result) return null;
    const wr = result.winRate;
    const color = wr >= 65 ? '#22c55e' : wr >= 50 ? '#fbbf24' : wr >= 35 ? '#f97316' : '#ef4444';
    const ptsColor = result.avgPts > 0 ? '#22c55e' : '#ef4444';
    return (
      <div style={{ padding: '10px 14px', background: 'rgba(0,0,0,0.2)', border: `1px solid ${color}30`, borderRadius: 7 }}>
        <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4, fontFamily: 'Arial, sans-serif' }}>{label}</div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontSize: 20, fontWeight: 800, color, fontFamily: 'monospace' }}>{wr}%</span>
          <span style={{ fontSize: 12, color: ptsColor, fontFamily: 'monospace' }}>{result.avgPts > 0 ? '+' : ''}{result.avgPts}pts avg</span>
          <span style={{ fontSize: 11, color: '#475569' }}>{result.wins}/{result.n} trades</span>
        </div>
        {note && <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4, lineHeight: 1.5, fontFamily: 'Arial, sans-serif' }}>{note}</div>}
      </div>
    );
  };

  const f = data.fades;
  const a = data.aSignals;

  return (
    <div style={{ background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderRadius: 10, padding: '18px 20px', marginTop: 16, fontFamily: 'Arial, sans-serif' }}>
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 }}>
          Backtest: Edge Trades vs Market Conditions
        </div>
        <div style={{ fontSize: 12, color: '#64748b' }}>
          Last {data.totalDays} sessions · Win rate = session closed in the intended direction · Avg pts = daily close vs entry level
        </div>
      </div>

      {/* View toggle */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
        {[['daily','Day-by-Day Log'],['summary','Aggregate Stats']].map(([v,l]) => (
          <button key={v} onClick={() => setView(v)}
            style={{ padding: '5px 14px', fontSize: 12, borderRadius: 5, cursor: 'pointer', border: `1px solid ${view===v ? '#3b82f6' : 'var(--border-color)'}`, background: view===v ? '#3b82f6' : 'var(--input-bg)', color: view===v ? '#fff' : '#94a3b8', fontFamily: 'Arial, sans-serif', fontWeight: view===v ? 600 : 400 }}>
            {l}
          </button>
        ))}
      </div>

      {/* Daily log */}
      {view === 'daily' && data.dailyLog && (
        <div>
          <div style={{ fontSize: 11, color: '#64748b', marginBottom: 10, fontFamily: 'Arial, sans-serif' }}>
            Each row: what the Big Picture said that morning, the suggested edge, and what actually happened. Green = edge worked · Red = edge failed · Gray = no directional bet recommended.
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: 'Arial, sans-serif' }}>
              <thead>
                <tr style={{ borderBottom: '2px solid var(--border-color)' }}>
                  {['Date','Structure','NL30','Suggested edge','Actual result','Outcome'].map(h => (
                    <th key={h} style={{ padding: '6px 10px', textAlign: 'left', color: '#64748b', fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.dailyLog.map((row, i) => (
                  <tr key={row.date} style={{ borderBottom: '1px solid rgba(100,116,139,0.12)', background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)' }}>
                    <td style={{ padding: '8px 10px', color: '#94a3b8', whiteSpace: 'nowrap', fontFamily: 'monospace', fontSize: 11 }}>{row.date}</td>
                    <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>
                      <span style={{ color: structureColor[row.structure] || '#94a3b8', fontWeight: 600 }}>{structureLabel[row.structure] || row.structure}</span>
                      <div style={{ fontSize: 10, color: '#475569' }}>VA {row.dir5?.toLowerCase()} · {row.overlaps}/4 overlap</div>
                    </td>
                    <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>
                      <span style={{ color: nlColor(row.nlState), fontWeight: 600, fontSize: 12 }}>{row.nl30 > 0 ? '+' : ''}{row.nl30}</span>
                      <div style={{ fontSize: 10, color: '#475569' }}>{row.nlState}</div>
                    </td>
                    <td style={{ padding: '8px 10px', color: '#94a3b8', maxWidth: 260, lineHeight: 1.5 }}>{row.suggestedEdge}</td>
                    <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>
                      <div style={{ color: row.ptsVsOpen > 0 ? '#22c55e' : row.ptsVsOpen < 0 ? '#ef4444' : '#94a3b8', fontWeight: 600, fontFamily: 'monospace' }}>
                        {row.ptsVsOpen > 0 ? '+' : ''}{row.ptsVsOpen}pts
                      </div>
                      <div style={{ fontSize: 10, color: '#64748b' }}>{row.actualChar}</div>
                    </td>
                    <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>
                      {row.edgeWorked === true  && <span style={{ color: '#22c55e', fontWeight: 700 }}>✓ Worked</span>}
                      {row.edgeWorked === false && <span style={{ color: '#ef4444', fontWeight: 700 }}>✗ Failed</span>}
                      {row.edgeWorked === null  && <span style={{ color: '#475569' }}>— No bet</span>}
                      {row.edgeResult && <div style={{ fontSize: 10, color: '#64748b', maxWidth: 140, lineHeight: 1.4, marginTop: 2 }}>{row.edgeResult.slice(0, 50)}{row.edgeResult.length > 50 ? '…' : ''}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* VAH/VAL FADE RESULTS */}
      {view === 'summary' && (
        <div>
          {/* VAH/VAL Fade Trades */}
          <div style={{ marginBottom: 18 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#94a3b8', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 10 }}>VAH/VAL Fade Trades</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 8 }}>
              <Stat label="Fade VAH — any bracket" result={f.vah} note="Overall: fade from prior VAH when session opens near it" />
              <Stat label="Fade VAH — confirmed bracket" result={f.vahBracket} note="Clean bracket (≥4 overlapping day-pairs)" />
              <Stat label="Fade VAH — bracket tilting up ⚠" result={f.vahTilting} note="Bracket where value is migrating higher — the danger zone" />
              <Stat label="Fade VAL — any bracket" result={f.val} note="Overall: fade from prior VAL when session opens near it" />
              <Stat label="Fade VAL — confirmed bracket" result={f.valBracket} note="Clean bracket" />
            </div>
            {f.vahTilting && f.vahTilting.winRate === 0 && (
              <div style={{ marginTop: 10, padding: '8px 12px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.35)', borderRadius: 6, fontSize: 13, color: '#fca5a5', lineHeight: 1.6 }}>
                ⛔ VAH fade in a tilting bracket: <strong>{f.vahTilting.winRate}% win rate</strong> ({f.vahTilting.n} trades, avg {f.vahTilting.avgPts}pts). Data confirms: do not fade VAH when value is migrating higher.
              </div>
            )}
          </div>

          {/* A Signal Quality */}
          <div style={{ marginBottom: 18 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#94a3b8', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 10 }}>A Signal Quality by NL30 State</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 8 }}>
              <Stat label="A Up — NL30 bullish (+9)" result={a.aUpBullish} note="A Up when 30-session trend is confirmed up" />
              <Stat label="A Up — NL30 ranging" result={a.aUpRanging} note="A Up with no trend tailwind" />
              <Stat label="A Up — NL30 bearish ⚠" result={a.aUpBearish} note="A Up counter-trend to 30-session downtrend" />
              <Stat label="A Down — NL30 bearish" result={a.aDownBearish} note="A Down when 30-session trend is confirmed down" />
              <Stat label="A Down — NL30 ranging" result={a.aDownRanging} note="A Down with no trend tailwind" />
              <Stat label="A Down — NL30 bullish ⚠" result={a.aDownBullish} note="A Down counter-trend in a bull environment" />
            </div>
            {a.aDownBullish && a.aDownBullish.n >= 2 && (
              <div style={{ marginTop: 10, padding: '8px 12px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.35)', borderRadius: 6, fontSize: 13, color: '#fca5a5', lineHeight: 1.6 }}>
                ⛔ A Down when NL30 bullish: <strong>{a.aDownBullish.winRate}% win rate</strong> ({a.aDownBullish.n} trades, avg {a.aDownBullish.avgPts}pts). The single most costly mistake in the data.
              </div>
            )}
          </div>

          <div style={{ fontSize: 11, color: '#475569', borderTop: '1px solid var(--border-color)', paddingTop: 10, lineHeight: 1.7 }}>
            Methodology: Structure classified daily using prior 5 sessions' VA overlap and POC migration. Fade success = session closed inside prior value area. A signal success = session closed in signal direction. All data from your actual trading history.
          </div>
        </div>
      )}
    </div>
  );
}

function LongTermStructurePage({ setCurrentView }) {
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [howToOpen, setHowToOpen] = React.useState(false);

  const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const etMin = nowET.getHours() * 60 + nowET.getMinutes();
  const inSession = etMin >= 9*60+30 && etMin < 16*60;

  React.useEffect(() => {
    const load = () => {
      setLoading(prev => prev === true); // only show spinner on first load
      fetch(`${API_URL}/longterm/summary`).then(r => r.json()).then(d => { setData(d); setLoading(false); }).catch(() => setLoading(false));
    };
    load();
    const iv = setInterval(load, 5 * 60 * 1000); // refresh every 5 min
    return () => clearInterval(iv);
  }, []);

  if (loading) return <div style={{ padding: 40, color: 'var(--text-muted)', fontFamily: 'Arial, sans-serif' }}>Loading market structure…</div>;
  if (!data || data.error) return <div style={{ padding: 40, color: '#ef4444' }}>Error loading structure data.</div>;

  const { summary, valueMigration, acd, effortResult, bracketState, profileShapes, weeklyStructure } = data;

  const summaryColor = { BULLISH: '#22c55e', BEARISH: '#ef4444', TRANSITIONAL: '#fbbf24', NEUTRAL: '#94a3b8' };
  const stateColor   = { TRENDING_UP: '#22c55e', TRENDING_DOWN: '#ef4444', TRANSITIONAL: '#fbbf24', BRACKET: '#3b82f6' };
  const shapeColor   = { ELONGATED: '#f97316', FAT: '#3b82f6', SQUAT: '#fbbf24', NONSYMMETRIC_TOP: '#a78bfa', NONSYMMETRIC_BOTTOM: '#ec4899' };
  const shapeIcon    = { ELONGATED: '▌', FAT: '▬', SQUAT: '▀', NONSYMMETRIC_TOP: '▲', NONSYMMETRIC_BOTTOM: '▼' };

  const card = (children, style = {}) => (
    <div style={{ background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderRadius: 10, padding: '16px 18px', ...style }}>
      {children}
    </div>
  );

  const sectionLabel = (text, tip) => (
    <div style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', fontFamily: 'Arial, sans-serif', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
      {text}{tip && <InfoTooltip text={tip} />}
    </div>
  );

  // VA Migration Stack — horizontal bars with price axis + hover tooltips
  const VAStack = () => {
    const [hovered, setHovered] = React.useState(null);
    const days = (valueMigration.last10 || []).filter(d => d.vah && d.val);
    if (!days.length) return <div style={{ color: '#94a3b8', fontSize: 11 }}>No value area data — compute from price bars in settings.</div>;

    const pad = 50; // price padding either side
    const allPrices = days.flatMap(d => [d.vah, d.val]);
    const minP = Math.min(...allPrices) - pad;
    const maxP = Math.max(...allPrices) + pad;
    const priceRange = maxP - minP || 1;

    // 4 price axis labels
    const axisPrices = [0, 1, 2, 3].map(i => Math.round((minP + (priceRange * i / 3)) / 25) * 25);

    const pct = p => ((p - minP) / priceRange * 100).toFixed(2);

    return (
      <div style={{ fontFamily: 'Arial, sans-serif' }}>
        {/* Price axis */}
        <div style={{ display: 'flex', marginLeft: 44, marginBottom: 4, position: 'relative', height: 14 }}>
          {axisPrices.map(p => (
            <div key={p} style={{ position: 'absolute', left: `${pct(p)}%`, transform: 'translateX(-50%)', fontSize: 10, color: '#475569' }}>{p.toLocaleString()}</div>
          ))}
        </div>

        {/* Bars */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {days.map((d, i) => {
            const prev = days[i - 1];
            let color = '#475569';
            if (prev) {
              const overlap = Math.min(d.vah, prev.vah) - Math.max(d.val, prev.val);
              if (d.poc > prev.poc && overlap < (d.vah - d.val) * 0.5) color = '#22c55e';
              else if (d.poc < prev.poc && overlap < (d.vah - d.val) * 0.5) color = '#ef4444';
            }
            const isHov = hovered === d.date;
            return (
              <div key={d.date} style={{ display: 'flex', alignItems: 'center', gap: 4, position: 'relative' }}
                onMouseEnter={() => setHovered(d.date)} onMouseLeave={() => setHovered(null)}>
                <div style={{ fontSize: 11, color: isHov ? '#94a3b8' : '#64748b', width: 40, textAlign: 'right', flexShrink: 0, fontFamily: 'Arial, sans-serif' }}>{d.date?.slice(5)}</div>
                <div style={{ flex: 1, position: 'relative', height: 20, background: 'rgba(255,255,255,0.02)', borderRadius: 2, cursor: 'default' }}>
                  {/* VA bar */}
                  <div style={{ position: 'absolute', left: `${pct(d.val)}%`, width: `${((d.vah - d.val) / priceRange * 100).toFixed(2)}%`, height: '100%', background: `${color}35`, border: `1px solid ${color}70`, borderRadius: 2 }} />
                  {/* POC tick */}
                  <div style={{ position: 'absolute', left: `${pct(d.poc)}%`, top: 0, width: 2, height: '100%', background: '#e879f9', borderRadius: 1 }} />
                  {/* VAH / VAL labels on hover */}
                  {isHov && <>
                    <div style={{ position: 'absolute', left: `${pct(d.val)}%`, top: '50%', transform: 'translate(-100%,-50%)', fontSize: 9, color: '#94a3b8', whiteSpace: 'nowrap', paddingRight: 3 }}>{Math.round(d.val)}</div>
                    <div style={{ position: 'absolute', left: `${pct(d.vah)}%`, top: '50%', transform: 'translateY(-50%)', fontSize: 9, color: '#94a3b8', whiteSpace: 'nowrap', paddingLeft: 3 }}>{Math.round(d.vah)}</div>
                  </>}
                </div>
                {/* Hover tooltip */}
                {isHov && (
                  <div style={{ position: 'absolute', left: '50%', top: -70, transform: 'translateX(-50%)', background: '#1a2535', border: '1px solid rgba(100,116,139,0.5)', borderRadius: 6, padding: '6px 10px', fontSize: 11, color: '#94a3b8', zIndex: 10, whiteSpace: 'nowrap', pointerEvents: 'none' }}>
                    <div style={{ color: '#e2e8f0', fontWeight: 700, marginBottom: 3 }}>{d.date}</div>
                    <div style={{ color: '#22c55e' }}>VAH {d.vah?.toFixed(0)}</div>
                    <div style={{ color: '#e879f9' }}>POC {d.poc?.toFixed(0)}</div>
                    <div style={{ color: '#ef4444' }}>VAL {d.val?.toFixed(0)}</div>
                    <div style={{ color: '#64748b', marginTop: 2, fontSize: 10 }}>Range {(d.vah - d.val)?.toFixed(0)} pts</div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* POC migration line */}
        <svg style={{ position: 'absolute', top: 0, left: 44, right: 0, bottom: 0, pointerEvents: 'none', overflow: 'visible' }} />

        <div style={{ display: 'flex', gap: 14, marginTop: 10, fontSize: 11, color: '#94a3b8', fontFamily: 'Arial, sans-serif' }}>
          <span style={{ color: '#22c55e' }}>■ migrating higher</span>
          <span style={{ color: '#ef4444' }}>■ migrating lower</span>
          <span style={{ color: '#475569' }}>■ overlapping</span>
          <span style={{ color: '#e879f9' }}>| POC</span>
        </div>
        <div style={{ fontSize: 11, color: '#64748b', marginTop: 6, fontFamily: 'Arial, sans-serif' }}>
          Each bar = one day's value area (70% of volume). Hover for exact levels. Left edge = VAL, right edge = VAH, pink tick = POC.
        </div>
      </div>
    );
  };

  // ACD sparkline
  const ACDSparkline = () => {
    const pts = (acd.sparkline || []).slice(-30);
    if (!pts.length) return null;
    const W = 280, H = 50;
    const maxS = Math.max(...pts.map(p => Math.abs(p.score)), 4);
    const mid = H / 2;
    const step = W / (pts.length - 1 || 1);
    const pathPts = pts.map((p, i) => `${i * step},${mid - (p.score / maxS) * (mid - 4)}`).join(' ');
    return (
      <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} style={{ display: 'block' }}>
        <line x1={0} y1={mid} x2={W} y2={mid} stroke="#2d3748" strokeWidth={1} />
        <polyline points={pathPts} fill="none" stroke="#3b82f6" strokeWidth={1.5} />
        {pts.map((p, i) => p.score !== 0 && (
          <circle key={i} cx={i * step} cy={mid - (p.score / maxS) * (mid - 4)} r={2}
            fill={p.score > 0 ? '#22c55e' : '#ef4444'} />
        ))}
      </svg>
    );
  };

  return (
    <div style={{ padding: '24px 28px', maxWidth: 1200, margin: '0 auto', fontFamily: 'Arial, sans-serif', fontSize: 11, color: '#94a3b8' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h2 style={{ fontSize: 20, fontWeight: 700, margin: 0, color: 'var(--text-primary)' }}>Long-Term Market Structure</h2>
          <div style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>
            {data.generatedAt && `Updated ${formatTimestamp(data.generatedAt)}`}
            {data.generatedAt && isStale(data.generatedAt, 26) && (
              <span style={{ color: '#fbbf24', marginLeft: 8 }}>⚠ data may not reflect today's session</span>
            )}
            {' · '}
            {data.dataQuality === 'GOOD' ? <span style={{ color: '#22c55e' }}>● {data.loggedDays} days logged — good data quality</span>
              : data.dataQuality === 'LIMITED' ? <span style={{ color: '#fbbf24' }}>⚠ {data.loggedDays} days logged — limited data, readings may not be representative</span>
              : <span style={{ color: '#ef4444' }}>⚠ {data.loggedDays} days logged — insufficient data</span>}
          </div>
        </div>
        {inSession && <div style={{ fontSize: 11, color: '#fbbf24', padding: '4px 10px', background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.3)', borderRadius: 5 }}>Read-only during session</div>}
      </div>

      {/* 1. Structural Summary */}
      <div style={{ padding: '14px 18px', background: `${summaryColor[summary.level]}10`, border: `2px solid ${summaryColor[summary.level]}50`, borderRadius: 10, marginBottom: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 800, color: summaryColor[summary.level], marginBottom: 6, letterSpacing: '0.06em' }}>
              {summary.level} STRUCTURE
              <span style={{ fontSize: 10, fontWeight: 400, color: '#64748b', marginLeft: 10 }}>Structural context only — not a trade signal.</span>
            </div>
            <div style={{ fontSize: 12, color: '#cbd5e1', lineHeight: 1.7 }}>{summary.text}</div>
          </div>
          <div style={{ flexShrink: 0, display: 'flex', gap: 12, fontSize: 11 }}>
            <div style={{ textAlign: 'center' }}><div style={{ fontSize: 18, fontWeight: 800, color: '#22c55e' }}>{summary.bull}</div><div style={{ color: '#64748b' }}>bullish</div></div>
            <div style={{ textAlign: 'center' }}><div style={{ fontSize: 18, fontWeight: 800, color: '#ef4444' }}>{summary.bear}</div><div style={{ color: '#64748b' }}>bearish</div></div>
            <div style={{ textAlign: 'center' }}><div style={{ fontSize: 18, fontWeight: 800, color: '#64748b' }}>{summary.neutral}</div><div style={{ color: '#64748b' }}>neutral</div></div>
          </div>
        </div>
      </div>

      {/* 2×2 grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>

        {/* Value Area Migration Stack */}
        {card(<>
          {sectionLabel('Value Area Migration — Last 10 Sessions', 'Dalton (Markets in Profile): the value area is the price range containing ~70% of all trading activity for a session.\n\nWhen consecutive days\' value areas migrate consistently in one direction, the market is accepting higher or lower prices. When they overlap, the market is in balance.\n\nGREEN bar: value area migrated higher vs prior day — buyers accepting higher prices.\nRED bar: value area migrated lower — sellers accepting lower prices.\nGRAY bar: value area overlaps prior day — balanced, two-sided.\n\nPOC (pink tick): point of control — the most-traded price of the session, the gravitational center.\n\nHover over any bar to see exact VAH / POC / VAL levels.')}
          <VAStack />
        </>)}

        {/* ACD Number Line */}
        {card(<>
          {sectionLabel('ACD Number Line', 'Fisher (The Logical Trader): a rolling sum of daily ACD scores over 30 sessions. Each day scores +4 (A Up + C confirmed), +1 (A Up only), 0 (no signal), -1 (A Down only), -4 (A Down + C confirmed).\n\nAbove +9 = confirmed uptrend — OTF buyers have been consistently in control for a month.\nBelow -9 = confirmed downtrend.\nBetween = ranging — day-trade only, no overnight bias.\n\n10-day tracks shorter-term momentum within the 30-day trend. When they diverge, the trend is weakening.')}
          <div style={{ display: 'flex', gap: 24, marginBottom: 12 }}>
            <div>
              <div style={{ fontSize: 11, color: '#94a3b8', fontFamily: 'Arial, sans-serif', marginBottom: 2 }}>30-day</div>
              <div style={{ fontSize: 32, fontWeight: 800, fontFamily: 'monospace', color: acd.nl30 > 9 ? '#22c55e' : acd.nl30 < -9 ? '#ef4444' : '#fbbf24' }}>
                {acd.nl30 > 0 ? '+' : ''}{acd.nl30}
              </div>
              <div style={{ fontSize: 10, color: acd.nl30 > 9 ? '#22c55e' : acd.nl30 < -9 ? '#ef4444' : '#fbbf24', fontWeight: 700 }}>{acd.nl30trend}</div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: '#94a3b8', fontFamily: 'Arial, sans-serif', marginBottom: 2 }}>10-day</div>
              <div style={{ fontSize: 24, fontWeight: 800, fontFamily: 'monospace', color: acd.nl10 > 9 ? '#22c55e' : acd.nl10 < -9 ? '#ef4444' : '#fbbf24' }}>
                {acd.nl10 > 0 ? '+' : ''}{acd.nl10}
              </div>
              <div style={{ fontSize: 10, color: acd.nl10 > 9 ? '#22c55e' : acd.nl10 < -9 ? '#ef4444' : '#fbbf24', fontWeight: 700 }}>{acd.nl10trend}</div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: '#94a3b8', fontFamily: 'Arial, sans-serif', marginBottom: 2 }}>5-day</div>
              <div style={{ fontSize: 18, fontWeight: 800, fontFamily: 'monospace', color: acd.nl5 > 0 ? '#22c55e' : acd.nl5 < 0 ? '#ef4444' : '#94a3b8' }}>
                {acd.nl5 > 0 ? '+' : ''}{acd.nl5}
              </div>
            </div>
          </div>
          {acd.nlDiverging && (
            <div style={{ padding: '6px 10px', background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.3)', borderRadius: 5, fontSize: 11, color: '#fbbf24', marginBottom: 8 }}>
              ⚠ Momentum divergence — 30-day trend intact but 10-day is pulling in the opposite direction. Fisher: reduce size and tighten stops.
            </div>
          )}
          {acd.nlWeakening && !acd.nlDiverging && (
            <div style={{ padding: '6px 10px', background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.2)', borderRadius: 5, fontSize: 11, color: '#fbbf24', marginBottom: 8 }}>
              Momentum weakening — 10-day significantly below 30-day pace. Early warning. Not a reversal signal.
            </div>
          )}
          <ACDSparkline />
          <div style={{ fontSize: 11, color: '#94a3b8', fontFamily: 'Arial, sans-serif', marginTop: 4 }}>Daily scores: last 30 sessions · above zero line = bullish day</div>
        </>)}

        {/* Volume Effort vs Result */}
        {card(<>
          {sectionLabel('Volume Effort vs Result — Last 10 Sessions', 'Weis (Trades About to Happen): every session tells a story through volume (effort) vs price range (result).\n\nABSORPTION (amber): heavy volume, narrow range. Someone is absorbing every push. In an uptrend = distribution (selling into rallies). In a downtrend = accumulation. 2+ consecutive absorption sessions = structural warning — stop adding to the trend.\n\nEASE OF MOVEMENT (blue): low volume, wide range. No resistance — price moving with conviction and little pushback. Confirms the current directional bias.\n\nNORMAL: proportionate effort and result. No signal.')}
          {effortResult.consecutiveAbsorption >= 3 && (
            <div style={{ padding: '6px 10px', background: 'rgba(251,191,36,0.12)', border: '1px solid #fbbf24', borderRadius: 5, fontSize: 11, color: '#fbbf24', marginBottom: 8, fontWeight: 600 }}>
              ⚠ {effortResult.consecutiveAbsorption} consecutive ABSORPTION sessions — Weis: stop adding to the trend, reduce size. Prior directional pressure being absorbed.
            </div>
          )}
          {effortResult.consecutiveAbsorption === 2 && (
            <div style={{ padding: '6px 10px', background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.4)', borderRadius: 5, fontSize: 11, color: '#fbbf24', marginBottom: 8 }}>
              2 consecutive ABSORPTION sessions — elevated attention. Monitor whether pattern continues.
            </div>
          )}
          <div style={{ display: 'flex', flex: 1, gap: 3, alignItems: 'flex-end', height: 80 }}>
            {effortResult.sessions.map(s => {
              const h = Math.min(parseFloat(s.vol_ratio) * 30, 80);
              const col = s.flag === 'ABSORPTION' ? '#fbbf24' : s.flag === 'EASE_OF_MOVEMENT' ? '#3b82f6' : '#475569';
              return (
                <div key={s.session_date || s.d} title={`${s.session_date || s.d}: vol ${s.vol_ratio}× range ${s.rng_ratio}× — ${s.flag}`}
                  style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                  <div style={{ width: '100%', height: h, background: col, borderRadius: '2px 2px 0 0', opacity: 0.85 }} />
                  <div style={{ fontSize: 11, color: col, fontWeight: 700, fontFamily: 'Arial, sans-serif' }}>{s.flag === 'ABSORPTION' ? 'A' : s.flag === 'EASE_OF_MOVEMENT' ? 'E' : '·'}</div>
                  <div style={{ fontSize: 11, color: '#94a3b8', fontFamily: 'Arial, sans-serif' }}>{(s.session_date || s.d)?.slice(5)}</div>
                </div>
              );
            })}
          </div>
          <div style={{ display: 'flex', gap: 16, marginTop: 8, fontSize: 11, color: '#94a3b8', fontFamily: 'Arial, sans-serif' }}>
            <span style={{ color: '#fbbf24' }}>■ A=Absorption</span>
            <span style={{ color: '#3b82f6' }}>■ E=Ease of Movement</span>
            <span style={{ color: '#475569' }}>■ Normal</span>
          </div>
        </>)}

        {/* Bracket / Trend State */}
        {card(<>
          {sectionLabel('Bracket / Trend State', 'Dalton + Steidlmayer: markets are in balance (bracket) roughly 75% of the time. Trending conditions are the exception.\n\nBRACKET: value areas overlapping — fade the extremes, buy VAL sell VAH, do not expect breakouts to follow through.\n\nTRENDING: value migrating consistently — go with range extensions, buy pullbacks to prior VAH (up) or sell rallies to prior VAL (down). Do not fade.\n\nTRANSITIONAL: 5-day and 10-day pictures disagree. Most dangerous condition. Reduce size significantly, favor responsive setups only, do not add contracts.')}
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 22, fontWeight: 800, color: stateColor[bracketState.state] || '#94a3b8', marginBottom: 4 }}>
              {bracketState.state === 'TRENDING_UP' ? '↑ TRENDING UP' : bracketState.state === 'TRENDING_DOWN' ? '↓ TRENDING DOWN' : bracketState.state === 'TRANSITIONAL' ? '⚡ TRANSITIONAL' : '↔ BRACKET'}
            </div>
            <div style={{ fontSize: 11, color: '#94a3b8', fontFamily: 'Arial, sans-serif', marginBottom: 8 }}>
              Confidence: {bracketState.confidence} · {bracketState.overlaps5 ?? bracketState.overlaps10}/4 of last 5 day-pairs overlapping
            </div>
            <div style={{ fontSize: 12, color: '#cbd5e1', lineHeight: 1.6, padding: '8px 10px', background: `${stateColor[bracketState.state] || '#475569'}10`, borderRadius: 6, borderLeft: `3px solid ${stateColor[bracketState.state] || '#475569'}` }}>
              {bracketState.playbook}
            </div>
            {bracketState.transitionalNote && (
              <div style={{ marginTop: 8, padding: '7px 10px', background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.35)', borderRadius: 6, fontSize: 12, color: '#fbbf24', lineHeight: 1.6 }}>
                ⚡ {bracketState.transitionalNote}
              </div>
            )}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 8 }}>
            <div style={{ padding: '6px 10px', background: 'rgba(0,0,0,0.2)', borderRadius: 6, border: '1px solid rgba(100,116,139,0.2)' }}>
              <div style={{ fontSize: 11, color: '#94a3b8', fontFamily: 'Arial, sans-serif' }}>5-day VA (primary)</div>
              <div style={{ fontSize: 13, fontWeight: 700, color: bracketState.dir5 === 'HIGHER' ? '#22c55e' : bracketState.dir5 === 'LOWER' ? '#ef4444' : '#94a3b8' }}>{bracketState.dir5}</div>
            </div>
            <div style={{ padding: '6px 10px', background: 'rgba(0,0,0,0.2)', borderRadius: 6, border: '1px solid rgba(100,116,139,0.2)' }}>
              <div style={{ fontSize: 11, color: '#64748b', fontFamily: 'Arial, sans-serif' }}>10-day VA (context)</div>
              <div style={{ fontSize: 13, fontWeight: 700, color: bracketState.dir10 === 'HIGHER' ? '#22c55e' : bracketState.dir10 === 'LOWER' ? '#ef4444' : '#94a3b8' }}>{bracketState.dir10}</div>
            </div>
          </div>
        </>)}
      </div>

      {/* Composite TPO Profile — full width */}
      <div style={{ marginBottom: 16 }}>
        {card(<>
          {sectionLabel('Composite TPO Profile — Where Price Has Spent the Most Time',
            'A composite profile counts every 1-minute bar\'s contribution to each price level across multiple sessions. Unlike volume profiles, this is purely time-based — it shows where the market has spent the most time, independent of volume spikes.\n\nPOC (Point of Control): the price with the most time spent across all sessions — the strongest magnet. Price consistently returns here.\n\nValue Area (70%): the price range containing 70% of all time spent — the "fair value" zone. Opens above = buyers have structural advantage. Opens below = sellers do. Responsive strategies work inside this zone.\n\nHVN (High Volume Node): local peaks in the distribution. Price slows and rotates here — strong support and resistance.\n\nLVN (Low Volume Node): thin areas where price barely spent time. Price moves fast through these — expect breakouts and quick moves, not consolidation.')}
          <CompositeProfileCard />
        </>)}
      </div>

      {/* Bottom row: Weekly Structure + Profile Shapes */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>

        {/* Weekly Structure */}
        {card(<>
          {sectionLabel('Weekly Structure Tracker', 'Steidlmayer: Monday\'s range is the weekly Initial Balance (IB). How far the week extends beyond Monday\'s range reveals the degree of weekly OTF participation.\n\nNormal week: extends 50% beyond Monday\'s IB — moderate participation\nNormal Variation: doubles Monday\'s IB — meaningful OTF participation confirmed\nTrend week: closes near extreme, directional integrity throughout — strongest OTF conviction\n\nNW ±50% and NV ±100% are the target levels to watch for the current week.\n\nWeek type can change: a trend week Monday–Wednesday can become normal by Friday. Classification updates daily.')}
          {weeklyStructure.weekType ? (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
                <div style={{ fontSize: 18, fontWeight: 800, color: weeklyStructure.weekType === 'TREND' ? '#f97316' : weeklyStructure.weekType === 'NORMAL_VARIATION' ? '#fbbf24' : '#64748b' }}>
                  {weeklyStructure.weekType?.replace('_', ' ')}
                </div>
                <div style={{ fontSize: 11, color: '#94a3b8', fontFamily: 'Arial, sans-serif' }}>week of {weeklyStructure.weekStart}</div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                {[
                  ['Mon IB High', weeklyStructure.monIBHigh?.toFixed(0)],
                  ['Mon IB Low', weeklyStructure.monIBLow?.toFixed(0)],
                  ['Week High', weeklyStructure.weekHigh?.toFixed(0)],
                  ['Week Low', weeklyStructure.weekLow?.toFixed(0)],
                  ['IB Range', weeklyStructure.monIBRange?.toFixed(0) + ' pts'],
                  ['Week Range', weeklyStructure.weekRange?.toFixed(0) + ' pts'],
                  ['NW ±50%', weeklyStructure.monIBHigh && weeklyStructure.monIBRange ? (weeklyStructure.monIBHigh + weeklyStructure.monIBRange * 0.5).toFixed(0) + ' / ' + (weeklyStructure.monIBLow - weeklyStructure.monIBRange * 0.5).toFixed(0) : '—'],
                  ['NV ±100%', weeklyStructure.monIBHigh && weeklyStructure.monIBRange ? (weeklyStructure.monIBHigh + weeklyStructure.monIBRange).toFixed(0) + ' / ' + (weeklyStructure.monIBLow - weeklyStructure.monIBRange).toFixed(0) : '—'],
                ].map(([label, val]) => (
                  <div key={label} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', borderBottom: '1px solid rgba(100,116,139,0.1)' }}>
                    <span style={{ color: '#94a3b8', fontFamily: 'Arial, sans-serif' }}>{label}</span>
                    <span style={{ color: '#e2e8f0', fontFamily: 'monospace' }}>{val || '—'}</span>
                  </div>
                ))}
              </div>
            </>
          ) : <div style={{ color: '#64748b', fontSize: 11 }}>No weekly bar data available.</div>}
        </>)}

        {/* Profile Shape Progression */}
        {card(<>
          {sectionLabel('Profile Shape Progression — Last 7 Sessions', 'Dalton (Markets in Profile): profile shape is the visual expression of market efficiency.\n\nELONGATED (▌ orange): tall, narrow profile. Directional conviction — price visiting many levels. OTF in control. Trend day type. A series = trend intact.\n\nFAT/BALANCED (▬ blue): wide horizontal profile, bell-curve shape. Market found value, two-sided trade. Normal or neutral day. A series = bracket forming or deepening.\n\nSQUAT (▀ amber): wide AND short. Auction compressing. Energy building. Precedes expansion in either direction — do not predict which way.\n\nNONSYMMETRIC TOP (▲ purple): more activity in upper half. Short covering or weak demand — often a fade opportunity at the upper boundary.\n\nNONSYMMETRIC BOTTOM (▼ pink): more activity in lower half. Long liquidation or weak supply — fade opportunity at lower boundary.\n\nKEY TRANSITION: elongated → fat series = trend slowing, balance forming. Reduce size.')}
          {profileShapes.shapes?.length ? (
            <>
              <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
                {profileShapes.shapes.slice(-7).map(s => (
                  <div key={s.date} style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: 20, color: shapeColor[s.profile_shape] || '#475569' }}>{shapeIcon[s.profile_shape] || '?'}</div>
                    <div style={{ fontSize: 11, color: shapeColor[s.profile_shape] || '#475569', fontWeight: 700, fontFamily: 'Arial, sans-serif' }}>
                      {s.profile_shape === 'NONSYMMETRIC_TOP' ? 'Top↑' : s.profile_shape === 'NONSYMMETRIC_BOTTOM' ? 'Bot↓' : s.profile_shape || '—'}
                    </div>
                    <div style={{ fontSize: 11, color: '#94a3b8', fontFamily: 'Arial, sans-serif' }}>{s.date?.slice(5)}</div>
                  </div>
                ))}
              </div>
              {profileShapes.shapeTransition && (
                <div style={{ padding: '6px 10px', background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.3)', borderRadius: 5, fontSize: 11, color: '#fbbf24', marginBottom: 8 }}>
                  {profileShapes.shapeTransition === 'ELONGATED_TO_FAT' && '⚡ Transition: profiles getting fatter after elongated series — trend conviction fading. Dalton: balance is forming. Reduce size.'}
                  {profileShapes.shapeTransition === 'ELONGATED_TO_SQUAT' && '⚡ Transition: squat profile after elongated series — energy compressing. Breakout possible in either direction.'}
                  {profileShapes.shapeTransition === 'FAT_TO_SQUAT' && '⚡ Transition: squat profile after balance period — bracket may be ending. Watch for directional confirmation.'}
                </div>
              )}
              <div style={{ display: 'flex', gap: 12, fontSize: 11, flexWrap: 'wrap', fontFamily: 'Arial, sans-serif' }}>
                {[['ELONGATED','▌','#f97316'],['FAT','▬','#3b82f6'],['SQUAT','▀','#fbbf24'],['Top Heavy','▲','#a78bfa'],['Bot Heavy','▼','#ec4899']].map(([l,i,c]) => (
                  <span key={l} style={{ color: c }}>{i} {l}</span>
                ))}
              </div>
            </>
          ) : (
            <div style={{ color: '#64748b', fontSize: 11, lineHeight: 1.7 }}>
              No profile shapes logged yet.<br />
              Log today's profile shape in <strong>Morning Prep → Daily Log</strong> after each session. Takes 10 seconds.
            </div>
          )}
        </>)}
      </div>

      {/* How to Read This Tab */}
      <div style={{ background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderRadius: 10 }}>
        <button onClick={() => setHowToOpen(o => !o)}
          style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 18px', background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-primary)' }}>
          <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.06em', color: '#64748b', textTransform: 'uppercase' }}>How to Read This Tab</span>
          <span style={{ color: '#64748b', fontSize: 11 }}>{howToOpen ? '▲ collapse' : '▼ expand'}</span>
        </button>
        {howToOpen && (
          <div style={{ padding: '0 18px 18px', display: 'flex', flexDirection: 'column', gap: 16 }}>
            {[
              ['The Purpose of This Tab', 'This tab shows you the bigger structural picture before your morning session. It does NOT predict price. It does NOT tell you a move is imminent. It tells you the current condition of the market across multiple timeframes so your intraday decisions have structural context.'],
              ['The Most Important Thing to Understand', 'No single component here is a signal. They are all conditions. The difference is important.\n\nA condition tells you what kind of environment you are in. A signal tells you to act.\n\nExample: ACD number line at +12 is a condition — it means the 30-day trend is bullish. It does NOT mean buy right now. Combined with value migrating higher and a trend week developing, the structural case for long bias is strengthening. But the intraday execution — the actual trade — still comes from your opening read, your ACD A signal, and your session structure confirmation.'],
              ['How to Use This Tab Without Getting Trapped', 'The most dangerous use of this tab is seeing strong bullish readings and using them to justify adding contracts or holding losing longs.\n\nStrong structural readings mean:\n• Long setups have more structural support\n• Short setups carry more counter-trend risk\n• Trend day probability is elevated\n\nStrong structural readings do NOT mean:\n• Today will be an up day\n• Any specific long trade will work\n• You should override your stop loss\n• You should add contracts'],
              ['When the Components Conflict', 'When components disagree — for example ACD number line is bullish but value migration is overlapping and effort vs result shows absorption — that conflict is important information. The market is in transition.\n\nIn a transitional reading: reduce size, favor responsive setups, do not hold trades into the next session, do not add contracts.'],
              ['The Balance to Imbalance Cycle', 'Markets alternate between balance (bracket) and imbalance (trend). A strong trend eventually slows, rotates, forms balance, then breaks into a new trend. This tab tracks where in that cycle the market is.\n\nSigns the current trend is weakening:\n• Profile shapes getting fatter after a series of elongated ones\n• Value migration slowing or stopping\n• Absorption sessions increasing\n• ACD 10-day diverging from 30-day\n• Weekly structure shifting from trend to normal variation\n\nWhen several of these align, the transition risk is elevated. This is not a reason to reverse direction immediately — it is a reason to stop adding to the trend and to use tighter stops.'],
              ['How Long Before a Breakout Should I Watch?', 'Compression and balance periods can last days, weeks, or months. Do not watch the compression and assume a breakout is imminent. A narrow bracket can stay narrow for a long time. The breakout will confirm itself — you do not need to predict it. Let the ACD A signal and value migration direction tell you which way it broke after the fact, then participate in the continuation.'],
            ].map(([title, body]) => (
              <div key={title}>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#94a3b8', marginBottom: 5 }}>{title}</div>
                <div style={{ fontSize: 11, color: '#94a3b8', lineHeight: 1.8, whiteSpace: 'pre-line' }}>{body}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ACDAutoPanel({ onComplete }) {
  const [params, setParams] = React.useState({ or_minutes: 5, a_multiplier: 0.25, sustain_minutes: 5 });
  const [bestInfo, setBestInfo] = React.useState(null);

  React.useEffect(() => {
    fetch(`${API_URL}/risk/settings`)
      .then(r => r.json())
      .then(s => {
        if (s.acd_a_multiplier) {
          setParams({ or_minutes: s.acd_or_minutes || 5, a_multiplier: parseFloat(s.acd_a_multiplier) || 0.25, sustain_minutes: s.acd_sustain_minutes || 5 });
          setBestInfo({ period: s.acd_best_params_period, ev: s.acd_best_params_ev });
        }
      }).catch(() => {});
  }, []);
  const [todayStatus, setTodayStatus] = React.useState(null);
  const [pivotStatus, setPivotStatus] = React.useState(null);
  const [bulkJob, setBulkJob] = React.useState({ status: 'idle', done: 0, total: 0 });
  const pollRef = React.useRef(null);

  const autoToday = async () => {
    setTodayStatus('running');
    try {
      const r = await fetch(`${API_URL}/acd/autocompute`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) });
      const d = await r.json();
      if (d.error) { setTodayStatus(`error: ${d.error}`); return; }
      const sig = d.aUpFired ? (d.cUpConfirmed ? 'A Up + C (+4)' : 'A Up (+1)') : d.aDownFired ? (d.cDownConfirmed ? 'A Down + C (-4)' : 'A Down (-1)') : 'No signal (0)';
      setTodayStatus(`done: OR ${parseFloat(d.orHigh).toFixed(0)}–${parseFloat(d.orLow).toFixed(0)}, ${sig}`);
      if (onComplete) onComplete();
    } catch(e) { setTodayStatus(`error: ${e.message}`); }
  };

  const autoPivot = async () => {
    setPivotStatus('running');
    try {
      const r = await fetch(`${API_URL}/acd/pivot/autocompute`, { method: 'POST' });
      const d = await r.json();
      if (d.error) { setPivotStatus(`error: ${d.error}`); return; }
      setPivotStatus(`done: pivot ${parseFloat(d.pivot_level).toFixed(2)}, R1 ${parseFloat(d.pivot_r1).toFixed(2)}, S1 ${parseFloat(d.pivot_s1).toFixed(2)}`);
      if (onComplete) onComplete();
    } catch(e) { setPivotStatus(`error: ${e.message}`); }
  };

  const startBulk = async () => {
    setBulkJob({ status: 'running', done: 0, total: 0 });
    try {
      await fetch(`${API_URL}/acd/autocompute/bulk`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) });
      pollRef.current = setInterval(async () => {
        try {
          const s = await fetch(`${API_URL}/acd/autocompute/bulk/status`).then(r => r.json());
          setBulkJob(s);
          if (s.status === 'complete' || s.status === 'error') {
            clearInterval(pollRef.current); pollRef.current = null;
            if (s.status === 'complete' && onComplete) onComplete();
          }
        } catch(e) {}
      }, 1500);
    } catch(e) { setBulkJob({ status: 'error', error: e.message }); }
  };

  React.useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const inputStyle = { background: 'var(--input-bg)', border: '1px solid var(--border-color)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 13, padding: '5px 8px' };
  const btnStyle = (color) => ({ padding: '7px 16px', background: color, border: 'none', borderRadius: 7, color: '#fff', fontWeight: 600, fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap' });

  return (
    <div style={{ background: 'var(--card-bg)', border: '1px solid #3b82f6', borderRadius: 12, padding: '16px 20px', marginBottom: 16 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: '#3b82f6', marginBottom: 12 }}>Auto-Compute from Price Bars</div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 14, alignItems: 'flex-end' }}>
        {[['or_minutes', 'OR Min', 'number', '1', '15'], ['a_multiplier', 'A Mult', 'number', '0.01', '1'], ['sustain_minutes', 'Sustain Min', 'number', '1', '10']].map(([k, label, type, min, max]) => (
          <div key={k}><div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 3 }}>{label}</div>
            <input type={type} step={k === 'a_multiplier' ? 0.01 : 1} min={min} max={max} value={params[k]}
              onChange={e => setParams(p => ({ ...p, [k]: k === 'a_multiplier' ? parseFloat(e.target.value) : parseInt(e.target.value) }))}
              style={{ ...inputStyle, width: 70 }} />
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <button onClick={autoToday} disabled={todayStatus === 'running'} style={btnStyle('#22c55e')}>
          Auto-log Today
        </button>
        {todayStatus && todayStatus !== 'running' && (
          <span style={{ fontSize: 12, color: todayStatus.startsWith('error') ? '#ef4444' : '#22c55e' }}>{todayStatus}</span>
        )}

        <button onClick={autoPivot} disabled={pivotStatus === 'running'} style={btnStyle('#3b82f6')}>
          Auto Monthly Pivot
        </button>
        {pivotStatus && pivotStatus !== 'running' && (
          <span style={{ fontSize: 12, color: pivotStatus.startsWith('error') ? '#ef4444' : '#22c55e' }}>{pivotStatus}</span>
        )}

        <button onClick={startBulk} disabled={bulkJob.status === 'running'} style={btnStyle('#8b5cf6')}>
          {bulkJob.status === 'running' ? `Backfilling… ${bulkJob.done}/${bulkJob.total}` : 'Backfill All History'}
        </button>
        {bulkJob.status === 'running' && bulkJob.total > 0 && (
          <div style={{ width: 160, height: 6, background: 'var(--border-color)', borderRadius: 3, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${bulkJob.done / bulkJob.total * 100}%`, background: '#8b5cf6', borderRadius: 3, transition: 'width 0.4s' }} />
          </div>
        )}
        {bulkJob.status === 'complete' && (
          <span style={{ fontSize: 12, color: '#22c55e' }}>Backfilled {bulkJob.total} days</span>
        )}
        {bulkJob.status === 'error' && (
          <span style={{ fontSize: 12, color: '#ef4444' }}>{bulkJob.error}</span>
        )}
      </div>

      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 10 }}>
        Parameters auto-set from backtest best EV.
        {bestInfo && (
          <span style={{ color: '#22c55e', marginLeft: 6 }}>
            Best from {bestInfo.period}: EV {parseFloat(bestInfo.ev) >= 0 ? '+' : ''}{parseFloat(bestInfo.ev).toFixed(3)}R
          </span>
        )}
        {' · '}Backfill regenerates all history with these parameters.
      </div>
    </div>
  );
}

// ── Session Status Bar — "what do I do right now?" ────────────────────────────

// Wrapper that owns shared confluence state — avoids double-fetching
function DashboardWithStatusBar({ nl, todayData, setCurrentView }) {
  const [conf, setConf] = React.useState(null);
  React.useEffect(() => {
    const load = () => fetch(`${API_URL}/confluence/today`).then(r => r.json()).then(d => { if (!d.error) setConf(d); }).catch(() => {});
    load();
    const iv = setInterval(load, 5 * 60 * 1000);
    return () => clearInterval(iv);
  }, []);
  return (
    <>
      <SessionStatusBar conf={conf} />
      <DashboardPanels nl={nl} todayData={todayData} setCurrentView={setCurrentView} conf={conf} />
    </>
  );
}

function SessionStatusBar({ conf }) {
  // conf is passed from DashboardWithStatusBar — no duplicate fetch needed here
  const [live, setLive] = React.useState(null);
  const [auto, setAuto] = React.useState(null); // prior-day VA
  const [proximity, setProximity] = React.useState(null); // nearby level confidence
  const [setupCard, setSetupCard] = React.useState(null); // auto-detected setup card

  React.useEffect(() => {
    const loadLive = () => fetch(`${API_URL}/acd/live`).then(r => r.json()).then(d => { if (!d.error) setLive(d); }).catch(() => {});
    const loadAuto = () => fetch(`${API_URL}/auction-read/auto`).then(r => r.json()).then(setAuto).catch(() => {});
    const loadProximity = () => fetch(`${API_URL}/acd/level-confidence`).then(r => r.json()).then(d => { if (!d.error) setProximity(d); }).catch(() => {});
    const loadSetupCard = () => fetch(`${API_URL}/acd/setup-detection`).then(r => r.json()).then(d => { setSetupCard(d.setup || null); }).catch(() => {});
    loadLive(); loadAuto(); loadProximity(); loadSetupCard();
    const iv = setInterval(() => { loadLive(); loadProximity(); loadSetupCard(); }, 60000);
    return () => clearInterval(iv);
  }, []);

  const nowET  = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const etMin  = nowET.getHours() * 60 + nowET.getMinutes();
  const isOpen = etMin >= 9 * 60 + 30 && etMin < 16 * 60;
  const isClosed = etMin >= 16 * 60;

  // Determine state
  const aUpFired   = live?.aUpFired;
  const aDownFired = live?.aDownFired;
  const signalActive = (aUpFired || aDownFired) && live?.setup !== 'No signal';
  const isCounterTrend = conf?.alignment === 'COUNTER_TREND';
  const ct = conf?.counterTrendData;

  // TRT: Trend Resumption Trade — a Failed A that is WITH the structural trend.
  // Failed A Up + structural trend is DOWN (short TRT): bears rejected the A Up; fade back to short.
  // Failed A Down + structural trend is UP (long TRT): bulls rejected A Down; fade back to long.
  const timeline = live?.timeline || [];
  const hasFailedAUp   = timeline.some(e => e.event?.startsWith('Failed A Up'));
  const hasFailedADown = timeline.some(e => e.event?.startsWith('Failed A Down'));
  const structDir = conf?.structural?.dir; // 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  const trtLong  = hasFailedADown && structDir === 'BULLISH' && !aDownFired; // failed breakdown in bull structure
  const trtShort = hasFailedAUp   && structDir === 'BEARISH' && !aUpFired;  // failed breakout in bear structure
  const trtActive = trtLong || trtShort;
  const isTRT = trtActive && !signalActive;

  let state = 'NO_SETUP';
  if (isClosed) state = 'CLOSED';
  else if (signalActive) state = 'SIGNAL_ACTIVE';
  else if (isTRT) state = 'TRT';
  else if (setupCard) state = 'SETUP_CARD';

  // Derive stop and level-based T1
  const orH = live?.orHigh, orL = live?.orLow;
  const orRange = orH && orL ? orH - orL : null;
  const isLong = aUpFired;
  const stop     = isLong ? orL?.toFixed(0) : orH?.toFixed(0);
  const stopType = isLong ? 'OR Low' : 'OR High';

  // Level-priority T1 from backtest data
  // A DOWN (short): target supports below, priority: IB Low -1x > PD VAL > PD POC > OR Low
  // A UP (long):    target resistance above, priority: IB High > PD VAH > Overnight High
  const pdVAH2 = auto?.prior_day_vah, pdVAL2 = auto?.prior_day_val, pdPOC2 = auto?.prior_day_poc;
  const ibLow1x = auto?.ib_low_1x, ibHigh = auto?.ib_high, ovnHigh = auto?.ovn_high;
  const entry = isLong ? live?.aUpLevel : live?.aDownLevel; // approximate entry near A level

  function pickT1(isLongSide, entryPx) {
    if (!entryPx) return { price: null, label: null };
    const RANGE = 80; // within 80pts to use a structural level as T1
    if (isLongSide) {
      // A UP — nearest resistance above entry, priority: IB High → PD VAH → ON High → OR High
      if (ibHigh && ibHigh > entryPx && ibHigh - entryPx <= RANGE)
        return { price: Math.round(ibHigh), label: 'IB High — median 34pts' };
      if (pdVAH2 && pdVAH2 > entryPx && pdVAH2 - entryPx <= RANGE)
        return { price: Math.round(pdVAH2), label: 'Prior Day VAH — median 33pts' };
      if (ovnHigh && ovnHigh > entryPx && ovnHigh - entryPx <= RANGE)
        return { price: Math.round(ovnHigh), label: 'Overnight High — median 48pts' };
      return { price: orH ? Math.round(orH) : null, label: 'OR High' };
    } else {
      // A DOWN — nearest support below entry, priority: IB Low−1× → PD POC → PD VAL → OR Low
      if (ibLow1x && ibLow1x < entryPx && entryPx - ibLow1x <= RANGE)
        return { price: Math.round(ibLow1x), label: 'IB Low −1× Range — median 60pts' };
      if (pdPOC2 && pdPOC2 < entryPx)
        return { price: Math.round(pdPOC2), label: 'Prior Day POC — median 37pts' };
      if (pdVAL2 && pdVAL2 < entryPx)
        return { price: Math.round(pdVAL2), label: 'Prior Day VAL' };
      return { price: orL ? Math.round(orL) : null, label: 'OR Low' };
    }
  }

  const t1Result = isCounterTrend && ct?.t1
    ? { price: ct.t1, label: ct?.nearestTarget?.label || 'structural level' }
    : pickT1(isLong, entry);
  const t1 = t1Result.price;
  const t1Label = t1Result.label;

  // 50-bar expiration: find A signal fire bar from timeline
  const aFireEvent = live?.timeline?.find(e => e.event === 'A Up fired' || e.event === 'A Down fired');
  const barsAnalyzed = live?.barsAnalyzed || 0;
  let barsElapsed = null;
  if (aFireEvent && live?.timeline) {
    // Estimate bars elapsed: barsAnalyzed - index of fire event in timeline (rough approximation)
    // More precise: compare fire time to current bar time
    const fireTime = aFireEvent.time; // "HH:MM"
    const barTime  = live?.barTime;   // "HH:MM"
    if (fireTime && barTime) {
      const toMins = t => { const [h,m] = t.split(':').map(Number); return h*60+m; };
      barsElapsed = toMins(barTime) - toMins(fireTime); // 1 bar = 1 minute
    }
  }
  const edgeExpired = barsElapsed != null && barsElapsed >= 50;

  // Nearest levels for NO_SETUP — use prior DAY VA (much more relevant than prior month)
  const pdVAH = auto?.prior_day_vah, pdVAL = auto?.prior_day_val, pdPOC = auto?.prior_day_poc;
  const currentPx = live?.currentPrice;

  // Colors per state
  const stateColors = {
    NO_SETUP:      { bg: 'rgba(30,41,59,0.8)', border: '#334155', label: '#64748b', accent: '#94a3b8' },
    SIGNAL_ACTIVE: { bg: isCounterTrend ? 'rgba(251,191,36,0.08)' : isLong ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)',
                     border: isCounterTrend ? '#fbbf24' : isLong ? '#22c55e' : '#ef4444',
                     label: isCounterTrend ? '#fbbf24' : isLong ? '#22c55e' : '#ef4444',
                     accent: isCounterTrend ? '#fbbf24' : isLong ? '#22c55e' : '#ef4444' },
    TRT:           { bg: 'rgba(245,158,11,0.06)', border: '#f59e0b', label: '#f59e0b', accent: '#f59e0b' },
    SETUP_CARD:    { bg: 'rgba(99,102,241,0.06)', border: '#6366f1', label: '#818cf8', accent: '#818cf8' },
    CLOSED:        { bg: 'rgba(15,23,42,0.6)', border: '#334155', label: '#64748b', accent: '#94a3b8' },
  };
  const sc = stateColors[state] ?? stateColors.NO_SETUP;

  return (
    <div style={{ padding: '16px 20px', background: sc.bg, border: `2px solid ${sc.border}`, borderRadius: 12, marginBottom: 12, fontFamily: 'Arial, sans-serif' }}>
      {/* Last-updated badge — always shown so staleness is obvious */}
      {live?.barTime && (
        <div style={{ float: 'right', fontSize: 13, color: '#a0aec0', fontFamily: 'monospace', marginBottom: 4 }}>
          data as of {live.barTime} ET
        </div>
      )}
      {state === 'NO_SETUP' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 11, color: '#475569', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 2 }}>No setup</div>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#64748b' }}>
              {!isOpen ? 'Market not open — prep only' : 'No A signal. Watch A levels.'}
            </div>
          </div>
          {live?.aUpLevel && live?.aDownLevel && (
            <div style={{ display: 'flex', gap: 16 }}>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 11, color: '#64748b' }}>A Up</div>
                <div style={{ fontSize: 17, fontWeight: 800, color: '#22c55e', fontFamily: 'monospace' }}>{live.aUpLevel?.toFixed(0)}</div>
              </div>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 11, color: '#64748b' }}>A Down</div>
                <div style={{ fontSize: 17, fontWeight: 800, color: '#ef4444', fontFamily: 'monospace' }}>{live.aDownLevel?.toFixed(0)}</div>
              </div>
            </div>
          )}
          {pdVAL && pdVAH && (
            <div style={{ display: 'flex', gap: 16, borderLeft: '1px solid #1e293b', paddingLeft: 20 }}>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 11, color: '#64748b' }}>Prior Day VAH</div>
                <div style={{ fontSize: 15, fontWeight: 700, color: '#22c55e', fontFamily: 'monospace' }}>{Math.round(pdVAH)}</div>
              </div>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 11, color: '#64748b' }}>POC</div>
                <div style={{ fontSize: 15, fontWeight: 700, color: '#e879f9', fontFamily: 'monospace' }}>{Math.round(pdPOC)}</div>
              </div>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 11, color: '#64748b' }}>Prior Day VAL</div>
                <div style={{ fontSize: 15, fontWeight: 700, color: '#ef4444', fontFamily: 'monospace' }}>{Math.round(pdVAL)}</div>
              </div>
            </div>
          )}
          {currentPx && <div style={{ marginLeft: 'auto', fontSize: 13, color: '#64748b', fontFamily: 'monospace' }}>Now: {currentPx?.toFixed(0)}</div>}
        </div>
      )}

      {/* TRT — Trend Resumption Trade state */}
      {state === 'TRT' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 13, color: '#f59e0b', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 2, fontWeight: 700 }}>TRT — Trend Resumption</div>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#f59e0b' }}>
              {trtLong ? 'A Down failed — buyers absorbed. Long lean with trend.' : 'A Up failed — sellers absorbed. Short lean with trend.'}
            </div>
            <div style={{ fontSize: 13, color: '#a0aec0', marginTop: 3 }}>
              {trtLong ? 'Entry near OR Low on bounce. Stop below session low.' : 'Entry near OR High on reversal. Stop above session high.'}
            </div>
          </div>
          {live?.aUpLevel && live?.aDownLevel && (
            <div style={{ display: 'flex', gap: 14, borderLeft: '1px solid #334155', paddingLeft: 16 }}>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 13, color: '#94a3b8' }}>{trtLong ? 'Entry zone' : 'A Up (rejected)'}</div>
                <div style={{ fontSize: 16, fontWeight: 800, color: trtLong ? '#22c55e' : '#f97316', fontFamily: 'monospace' }}>
                  {trtLong ? live.orLow?.toFixed(0) : live.aUpLevel?.toFixed(0)}
                </div>
              </div>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 13, color: '#94a3b8' }}>{trtLong ? 'A Down (rejected)' : 'Entry zone'}</div>
                <div style={{ fontSize: 16, fontWeight: 800, color: trtLong ? '#f97316' : '#ef4444', fontFamily: 'monospace' }}>
                  {trtLong ? live.aDownLevel?.toFixed(0) : live.orHigh?.toFixed(0)}
                </div>
              </div>
            </div>
          )}
          {currentPx && <div style={{ marginLeft: 'auto', fontSize: 13, color: '#94a3b8', fontFamily: 'monospace' }}>Now: {currentPx?.toFixed(0)}</div>}
        </div>
      )}

      {/* Setup Card — auto-detected secondary setup (lower priority than A/TRT signals) */}
      {state === 'SETUP_CARD' && setupCard && (() => {
        const sc2 = setupCard;
        // Use server-provided lifecycle data (Bug 1: detectedAt comes from DB, not render time)
        const isExpired = sc2.isExpired;
        const minsRemaining = sc2.minsRemaining ?? 0;
        const windowAmber = minsRemaining > 0 && minsRemaining < 10;
        // EXPIRED: gray card, auto-hides after 5 min (minsRemaining = 0 and still showing)
        if (isExpired) {
          // Brief expired notice — show for up to 5 min past expiry, then hide entirely
          return (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ fontSize: 13, color: '#475569', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                EXPIRED — {sc2.label.split('(')[0].trim()}
              </div>
              <div style={{ fontSize: 13, color: '#475569' }}>Window closed — setup no longer valid for this session.</div>
            </div>
          );
        }

        const isLong2 = sc2.direction === 'LONG';
        const c2 = isLong2 ? '#22c55e' : '#ef4444';
        const dirLabel = isLong2 ? '↑ LONG' : '↓ SHORT';

        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
              {/* Direction + label + stable fire time from DB */}
              <div style={{ minWidth: 160 }}>
                <div style={{ fontSize: 13, color: '#818cf8', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 2, fontWeight: 700 }}>
                  {sc2.label.split('(')[0].trim()}
                </div>
                <div style={{ fontSize: 20, fontWeight: 900, color: c2, letterSpacing: '0.04em' }}>{dirLabel}</div>
                {sc2.detectedAt && (
                  <div style={{ fontSize: 13, color: '#818cf8', opacity: 0.8, marginTop: 2, fontFamily: 'monospace' }}>detected {sc2.detectedAt} ET</div>
                )}
                {sc2.keyLevelLabel && (
                  <div style={{ fontSize: 13, color: '#94a3b8', marginTop: 1 }}>
                    {sc2.keyLevelLabel}{sc2.keyLevel ? ` ${sc2.keyLevel}` : ''}
                  </div>
                )}
              </div>

              <div style={{ width: 1, background: '#6366f1', alignSelf: 'stretch', opacity: 0.4 }} />

              {/* Entry / Stop / Target */}
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 13, color: '#94a3b8' }}>Entry zone</div>
                <div style={{ fontSize: 18, fontWeight: 800, color: c2, fontFamily: 'monospace' }}>{sc2.entry}</div>
              </div>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 13, color: '#94a3b8' }}>Stop</div>
                <div style={{ fontSize: 18, fontWeight: 800, color: '#ef4444', fontFamily: 'monospace' }}>{sc2.stop}</div>
              </div>
              {sc2.target && (
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 13, color: '#94a3b8' }}>T1</div>
                  <div style={{ fontSize: 18, fontWeight: 800, color: '#818cf8', fontFamily: 'monospace' }}>{sc2.target}</div>
                  {sc2.targetLabel && <div style={{ fontSize: 13, color: '#94a3b8' }}>{sc2.targetLabel}</div>}
                </div>
              )}

              <div style={{ width: 1, background: '#6366f1', alignSelf: 'stretch', opacity: 0.4 }} />

              {/* Window countdown — amber when under 10 min */}
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 13, color: '#94a3b8' }}>Window</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: windowAmber ? '#f59e0b' : '#818cf8', fontFamily: 'monospace' }}>
                  {minsRemaining}m
                </div>
                <div style={{ fontSize: 13, color: windowAmber ? '#f59e0b' : '#64748b' }}>remaining</div>
              </div>

              {/* Historical stats from condition_memory */}
              {sc2.history && sc2.history.winRate != null && (
                <>
                  <div style={{ width: 1, background: '#6366f1', alignSelf: 'stretch', opacity: 0.4 }} />
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: 13, color: '#94a3b8' }}>Win rate</div>
                    <div style={{ fontSize: 16, fontWeight: 700, fontFamily: 'monospace',
                      color: sc2.history.winRate >= 0.55 ? '#22c55e' : sc2.history.winRate >= 0.45 ? '#f59e0b' : '#ef4444' }}>
                      {(sc2.history.winRate * 100).toFixed(0)}%
                    </div>
                    <div style={{ fontSize: 13, color: '#94a3b8' }}>{sc2.history.occurrences} sessions</div>
                  </div>
                </>
              )}

              {currentPx && <div style={{ marginLeft: 'auto', fontSize: 13, color: '#94a3b8', fontFamily: 'monospace' }}>Now: {currentPx?.toFixed(0)}</div>}
            </div>
            {/* Plain-English description */}
            <div style={{ fontSize: 13, color: '#cbd5e1', lineHeight: 1.6, padding: '6px 0', borderTop: '1px solid rgba(99,102,241,0.2)' }}>
              {sc2.description}
            </div>
          </div>
        );
      })()}

      {/* Proximity confidence banner — shown when any key level is within 25 pts */}
      {proximity?.nearLevels?.length > 0 && (
        <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {proximity.nearLevels.slice(0, 4).map(nl => {
            const rr = nl.nl30Filtered?.rate ?? nl.respectRate;
            const conf = rr >= 55 ? { color: '#22c55e', label: 'strong' } : rr >= 45 ? { color: '#f59e0b', label: 'moderate' } : { color: '#64748b', label: 'weak' };
            const condTouches = nl.nl30Filtered?.touches;
            const isUnfiltered = !nl.nl30Filtered;
            return (
              <div key={`${nl.key}-${nl.side}`}
                style={{ padding: '6px 10px', background: 'rgba(15,23,42,0.8)', border: `1px solid ${conf.color}40`, borderLeft: `3px solid ${conf.color}`, borderRadius: 6, fontSize: 13, fontFamily: 'monospace' }}>
                <div style={{ color: nl.side === 'resistance' ? '#ef4444' : '#22c55e', fontWeight: 700 }}>
                  Approaching {nl.label} {nl.price?.toFixed(0)} — {nl.dist}pts away
                </div>
                <div style={{ color: conf.color, marginTop: 2 }}>
                  Respect rate ({proximity.nl30State}): <strong>{rr ?? '—'}%</strong>
                  {isUnfiltered && <span style={{ color: '#94a3b8', marginLeft: 4 }}>(unfiltered)</span>}
                  {condTouches < 20 && !isUnfiltered && <span style={{ color: '#fbbf24', marginLeft: 4 }}>({condTouches} touches — limited)</span>}
                </div>
                {nl.openCallFiltered && (
                  <div style={{ color: '#a0aec0', marginTop: 1 }}>
                    {proximity.openingCall?.replace(/_/g, ' ')}: {nl.openCallFiltered.rate}% ({nl.openCallFiltered.touches} touches)
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {state === 'SIGNAL_ACTIVE' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {/* 50-bar expiration warning — shown above everything when expired */}
          {edgeExpired && (
            <div style={{ padding: '8px 14px', background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.4)', borderRadius: 6, fontSize: 13, color: '#fbbf24', fontWeight: 700 }}>
              ⏱ Edge window expired ({barsElapsed} bars since A signal) — consider exit. Median move resolves within 50 bars.
            </div>
          )}

          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
            {/* Direction */}
            <div style={{ minWidth: 120 }}>
              <div style={{ fontSize: 13, color: '#94a3b8', marginBottom: 2, fontWeight: 600 }}>{isCounterTrend ? '⚡ COUNTER-TREND' : 'SIGNAL ACTIVE'}</div>
              <div style={{ fontSize: 22, fontWeight: 900, color: sc.accent, letterSpacing: '0.04em' }}>
                {isLong ? '↑ A UP' : '↓ A DOWN'}
              </div>
              {aFireEvent?.time && (
                <div style={{ fontSize: 13, color: sc.accent, marginTop: 2, fontFamily: 'monospace' }}>fired {aFireEvent.time} ET</div>
              )}
              {barsElapsed != null && !edgeExpired && (
                <div style={{ fontSize: 13, color: '#94a3b8', marginTop: 1 }}>{barsElapsed}/{50} bars elapsed</div>
              )}
            </div>

            <div style={{ width: 1, background: sc.border, alignSelf: 'stretch', opacity: 0.4 }} />

            {/* Stop */}
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 13, color: '#94a3b8' }}>Stop ({stopType})</div>
              <div style={{ fontSize: 20, fontWeight: 800, color: '#ef4444', fontFamily: 'monospace' }}>{stop}</div>
            </div>

            <div style={{ width: 1, background: sc.border, alignSelf: 'stretch', opacity: 0.4 }} />

            {/* T1 — level-based */}
            <div>
              <div style={{ fontSize: 13, color: '#94a3b8', marginBottom: 2 }}>T1</div>
              <div style={{ fontSize: 20, fontWeight: 800, color: sc.accent, fontFamily: 'monospace' }}>{t1 || '—'}</div>
              {t1Label && <div style={{ fontSize: 13, color: '#94a3b8', maxWidth: 220, lineHeight: 1.4 }}>({t1Label})</div>}
            </div>

            <div style={{ width: 1, background: sc.border, alignSelf: 'stretch', opacity: 0.4 }} />

            {/* Size */}
            <div style={{ textAlign: 'center', padding: '4px 16px', background: `${sc.accent}20`, border: `1px solid ${sc.accent}50`, borderRadius: 7 }}>
              <div style={{ fontSize: 13, color: '#94a3b8' }}>Max size</div>
              <div style={{ fontSize: 18, fontWeight: 900, color: sc.accent }}>1 CONTRACT</div>
            </div>

            <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
              {conf && (
                <div style={{ marginBottom: 4 }}>
                  <div style={{ fontSize: 11, color: '#64748b' }}>Confluence</div>
                  <div style={{ fontFamily: 'monospace', fontWeight: 800, color: conf.color, fontSize: 15 }}>
                    {conf.structural?.score}/{conf.structural?.max} · {conf.session?.score}/{conf.session?.max}
                  </div>
                  <div style={{ fontSize: 11, color: conf.color }}>{conf.structural?.label} · {conf.session?.label}</div>
                </div>
              )}
              <div style={{ fontSize: 12, color: '#64748b', fontFamily: 'monospace' }}>Now: {currentPx?.toFixed(0)}</div>
            </div>
          </div>
        </div>
      )}

      {state === 'CLOSED' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 11, color: '#475569', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 2 }}>Session closed</div>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#64748b' }}>Review EOD read below ↓</div>
          </div>
          {live?.sessionHigh && live?.sessionLow && (
            <div style={{ display: 'flex', gap: 16 }}>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 11, color: '#475569' }}>Session High</div>
                <div style={{ fontSize: 15, fontWeight: 700, color: '#22c55e', fontFamily: 'monospace' }}>{live.sessionHigh?.toFixed(0)}</div>
              </div>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 11, color: '#475569' }}>Session Low</div>
                <div style={{ fontSize: 15, fontWeight: 700, color: '#ef4444', fontFamily: 'monospace' }}>{live.sessionLow?.toFixed(0)}</div>
              </div>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 11, color: '#475569' }}>Range</div>
                <div style={{ fontSize: 15, fontWeight: 700, color: '#94a3b8', fontFamily: 'monospace' }}>
                  {live.sessionHigh && live.sessionLow ? Math.round(live.sessionHigh - live.sessionLow) : '—'}pts
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Collapsible panel group for all analysis sections ─────────────────────────

// updatedAt: string timestamp (e.g. "13:36 ET"). Badge shows when collapsed + unseen.
// Badge disappears permanently after the user opens then closes the section with that updatedAt.
// Reappears if updatedAt changes (new data arrives).
function CollapsibleSection({ title, defaultOpen = false, children, badge, updatedAt }) {
  const [open, setOpen] = React.useState(defaultOpen);
  const lastSeenAt = React.useRef(defaultOpen ? updatedAt : null); // pre-seen if starts open
  const openedWithNew = React.useRef(false);

  // Badge is visible when there's an updatedAt we haven't marked as seen yet
  const showUpdated = !open && !!updatedAt && updatedAt !== lastSeenAt.current;

  const handleToggle = () => {
    if (!open) {
      // Opening — note if there's a new update badge showing
      if (updatedAt && updatedAt !== lastSeenAt.current) openedWithNew.current = true;
    } else {
      // Closing — if they saw new data, mark it as seen
      if (openedWithNew.current) {
        lastSeenAt.current = updatedAt;
        openedWithNew.current = false;
      }
    }
    setOpen(o => !o);
  };

  return (
    <div style={{ marginBottom: 8 }}>
      <button onClick={handleToggle}
        style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '10px 16px', background: open ? 'var(--card-bg)' : 'rgba(15,23,42,0.4)',
          border: `1px solid ${showUpdated ? 'rgba(99,102,241,0.45)' : 'var(--border-color)'}`,
          borderRadius: open ? '8px 8px 0 0' : 8,
          cursor: 'pointer', fontFamily: 'Arial, sans-serif' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: open ? '#94a3b8' : '#64748b', letterSpacing: '0.05em', textTransform: 'uppercase' }}>{title}</span>
          {badge && <span style={{ fontSize: 11, padding: '1px 7px', borderRadius: 4, background: badge.bg, color: badge.color, fontWeight: 700 }}>{badge.text}</span>}
          {showUpdated && (
            <span style={{ fontSize: 13, padding: '1px 7px', borderRadius: 4, background: 'rgba(99,102,241,0.15)', color: '#818cf8', fontWeight: 600, fontFamily: 'monospace' }}>
              updated {updatedAt}
            </span>
          )}
        </div>
        <span style={{ color: '#94a3b8', fontSize: 13 }}>{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div style={{ border: '1px solid var(--border-color)', borderTop: 'none', borderRadius: '0 0 8px 8px', padding: '12px 0 4px' }}>
          {children}
        </div>
      )}
    </div>
  );
}

function DashboardPanels({ nl, todayData, setCurrentView, conf }) {
  // conf passed from parent — no duplicate fetch needed
  // Lightweight poll for barTime to drive "updated" badges on collapsible sections
  const [barTime, setBarTime] = React.useState(null);
  React.useEffect(() => {
    const load = () => fetch(`${API_URL}/acd/live`)
      .then(r => r.json())
      .then(d => { if (d?.barTime) setBarTime(d.barTime + ' ET'); })
      .catch(() => {});
    load();
    const iv = setInterval(load, 30000);
    return () => clearInterval(iv);
  }, []);

  const isCounterTrend = conf?.alignment === 'COUNTER_TREND';
  const alignBadge = conf?.alignment === 'COUNTER_TREND'
    ? { text: '⚡ COUNTER-TREND', bg: 'rgba(251,191,36,0.15)', color: '#fbbf24' }
    : conf?.alignment === 'ALIGNED'
    ? { text: '✓ ALIGNED', bg: 'rgba(34,197,94,0.12)', color: '#22c55e' }
    : null;

  // Confluence calculatedAt — strip seconds, add ET suffix
  const confUpdatedAt = conf?.calculatedAt
    ? new Date(conf.calculatedAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/New_York' }) + ' ET'
    : null;

  return (
    <div style={{ fontFamily: 'Arial, sans-serif' }}>
      {/* This Setup Historically — always visible, not collapsed */}
      <ThisSetupHistorically />

      <CollapsibleSection title="Big Picture — Structural Context" defaultOpen={false}>
        <div style={{ padding: '0 4px' }}><BigPictureSnapshot setCurrentView={setCurrentView} /></div>
      </CollapsibleSection>

      <CollapsibleSection title="Confluence Score" badge={alignBadge} defaultOpen={false} updatedAt={confUpdatedAt}>
        <div style={{ padding: '0 4px' }}><ConfluenceScore /></div>
      </CollapsibleSection>

      <CollapsibleSection title="Auction Read — Phases 1 · 2 · Mid-Day · EOD" defaultOpen={false} updatedAt={barTime}>
        <div style={{ padding: '0 4px' }}><AuctionReadCard nl={nl} todayData={todayData} /></div>
      </CollapsibleSection>

      {/* Counter-trend auto-expands when active */}
      {isCounterTrend && conf?.counterTrendData && (
        <CollapsibleSection title="Counter-Trend Trade Management" defaultOpen={true}
          badge={{ text: '⚡ ACTIVE', bg: 'rgba(251,191,36,0.15)', color: '#fbbf24' }}>
          <div style={{ padding: '8px 16px' }}><CounterTrendPanel ct={conf.counterTrendData} /></div>
        </CollapsibleSection>
      )}

      <CollapsibleSection title="Today's Setup Timeline" defaultOpen={false} updatedAt={barTime}>
        <div style={{ padding: '0 4px' }}><ACDSessionTimeline /></div>
      </CollapsibleSection>

      <CollapsibleSection title="ACD Setup Reference" defaultOpen={false}>
        <div style={{ padding: '0 4px' }}><ACDSetupReference /></div>
      </CollapsibleSection>
    </div>
  );
}

function ACDView({ accounts, selectedAccounts, setSelectedAccounts, setCurrentView }) {
  const [tab, setTab] = React.useState('dashboard');
  const [todayData, setTodayData] = React.useState(null);
  const [nl, setNl] = React.useState(null);
  const [logs, setLogs] = React.useState([]);
  const [pivot, setPivot] = React.useState(null);

  const loadAll = React.useCallback(() => {
    fetch(`${API_URL}/acd/today`).then(r => r.json()).then(setTodayData).catch(console.error);
    fetch(`${API_URL}/acd/numberline`).then(r => r.json()).then(setNl).catch(console.error);
    fetch(`${API_URL}/acd/daily?days=60`).then(r => r.json()).then(setLogs).catch(console.error);
    fetch(`${API_URL}/acd/pivot/current`).then(r => r.json()).then(setPivot).catch(console.error);
  }, []);

  React.useEffect(() => { loadAll(); }, [loadAll]);

  const tabStyle = (t) => ({
    padding: '7px 18px', border: 'none', borderRadius: '6px 6px 0 0', cursor: 'pointer', fontSize: 13, fontWeight: 600,
    background: tab === t ? 'var(--card-bg)' : 'transparent',
    color: tab === t ? 'var(--text-primary)' : 'var(--text-muted)',
    borderBottom: tab === t ? '2px solid #3b82f6' : '2px solid transparent',
  });

  return (
    <div style={{ padding: '24px 28px', maxWidth: 1200, margin: '0 auto', fontFamily: 'Arial, sans-serif', fontSize: 11, color: '#94a3b8' }}>
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Morning Prep</h2>
      </div>

      <div style={{ display: 'flex', gap: 2, marginBottom: 0, borderBottom: '1px solid var(--border-color)' }}>
        {[['dashboard', 'Dashboard'], ['history', 'History'], ['chart', 'NL Chart'], ['log', 'Daily Log'], ['backtest', 'Backtest'], ['correlation', 'Correlation']].map(([t, label]) => (
          <button key={t} onClick={() => setTab(t)} style={tabStyle(t)}>{label}</button>
        ))}
      </div>

      <div style={{ paddingTop: 20 }}>
        {tab === 'dashboard' && (
          <>
            <ACDAutoPanel onComplete={loadAll} />
            <DashboardWithStatusBar nl={nl} todayData={todayData} setCurrentView={setCurrentView} />
          </>
        )}
        {tab === 'chart' && (
          <div>
            <NumberLineChart />
            <div style={{ marginBottom: 16 }}>
              <WeeklyNumberLineChart />
            </div>
            <ACDDailyLogTable logs={logs} />
          </div>
        )}
        {tab === 'log' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <ACDAutoPanel onComplete={loadAll} />
            <ACDDailyInput onSaved={loadAll} />
            <div style={{ background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderRadius: 12, padding: '20px 24px' }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 14, letterSpacing: '0.05em', textTransform: 'uppercase' }}>Last 60 Trading Days</div>
              <ACDDailyLogTable logs={logs} />
            </div>
          </div>
        )}
        {tab === 'backtest' && (
          <>
            <ConditionBacktestInline />
            <PatternStatsPanel />
            <ACDBacktestRunner />
          </>
        )}
        {tab === 'history' && <AuctionHistoryView />}
        {tab === 'correlation' && (
          <div>
            {accounts?.length > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Filter by account:</span>
                <AccountSelector accounts={accounts} selectedAccounts={selectedAccounts} setSelectedAccounts={setSelectedAccounts} />
              </div>
            )}
            <ACDCorrelationReport accounts={accounts} selectedAccounts={selectedAccounts} />
          </div>
        )}
      </div>
    </div>
  );
}



const DAY_TYPES = [
  { value: 'NONTREND', label: 'Nontrend', efficiency: 'EFFICIENT' },
  { value: 'NORMAL', label: 'Normal', efficiency: 'EFFICIENT' },
  { value: 'NEUTRAL', label: 'Neutral', efficiency: 'EFFICIENT' },
  { value: 'NORMAL_VARIATION', label: 'Normal Variation', efficiency: 'INEFFICIENT' },
  { value: 'TREND', label: 'Trend', efficiency: 'INEFFICIENT' },
  { value: 'RUNNING_PROFILE_NEUTRAL', label: 'Running Profile Neutral', efficiency: 'TRANSITIONING' },
];

function getEfficiencyLabel(dayType) {
  const map = {
    TREND: { label: 'INEFFICIENT', color: '#f97316', playbook: 'Go with range extensions — do not fade' },
    NORMAL_VARIATION: { label: 'INEFFICIENT', color: '#fbbf24', playbook: 'Moderate inefficiency — breakouts likely' },
    NONTREND: { label: 'EFFICIENT', color: '#22c55e', playbook: 'Fade extremes — responsive playbook' },
    NORMAL: { label: 'EFFICIENT', color: '#22c55e', playbook: 'Fade extremes — responsive playbook' },
    NEUTRAL: { label: 'EFFICIENT', color: '#22c55e', playbook: 'Fade extremes — responsive playbook' },
    RUNNING_PROFILE_NEUTRAL: { label: 'TRANSITIONING', color: '#38bdf8', playbook: 'Watch close direction — trend continuation likely next session' },
  };
  return map[dayType] || { label: 'UNCLASSIFIED', color: '#94a3b8', playbook: 'Select a day type above' };
}

// ==================== RISK MANAGEMENT COMPONENTS ====================

function useRiskSettings() {
  const [settings, setSettings] = React.useState(null);
  const load = async () => {
    try {
      const r = await fetch(`${API_URL}/risk/settings`);
      const d = await r.json();
      setSettings(d);
    } catch(e) { console.error(e); }
  };
  React.useEffect(() => { load(); }, []);
  const save = async (updates) => {
    try {
      const merged = { ...settings, ...updates };
      const r = await fetch(`${API_URL}/risk/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(merged),
      });
      const d = await r.json();
      setSettings(d);
      return d;
    } catch(e) { console.error(e); }
  };
  return { settings, setSettings, save, reload: load };
}

function RollingStatsBar({ stats, lookback, setLookback }) {
  if (!stats) return <div style={{ padding: '12px 0', color: 'var(--text-muted)', fontSize: 13 }}>Loading stats...</div>;

  const ev = stats.ev;
  const wr = (stats.winRate * 100).toFixed(1);
  const pf = stats.profitFactor?.toFixed(2) || '—';
  const streak = stats.currentStreak;

  const statCell = (label, value, color) => (
    <div style={{ textAlign: 'center', minWidth: 100 }}>
      <div style={{ fontSize: 18, fontWeight: 700, fontFamily: 'monospace', color: color || 'var(--text-primary)' }}>{value}</div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{label}</div>
    </div>
  );

  return (
    <div style={{ background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderRadius: 10, padding: '14px 20px', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <div style={{ display: 'flex', gap: 28, flex: 1, flexWrap: 'wrap' }}>
        {statCell('Win Rate', `${wr}%`, parseFloat(wr) >= 50 ? '#22c55e' : '#f97316')}
        {statCell('Payoff Ratio', `${stats.payoffRatio?.toFixed(2) || '—'}R`, '#94a3b8')}
        {statCell('Profit Factor', pf, parseFloat(pf) >= 1.5 ? '#22c55e' : parseFloat(pf) >= 1 ? '#fbbf24' : '#ef4444')}
        {statCell('EV/Trade', `${ev >= 0 ? '+' : ''}${ev?.toFixed(3) || '—'}R`, ev >= 0 ? '#22c55e' : '#ef4444')}
        {statCell('Streak', streak === 0 ? '—' : streak > 0 ? `+${streak} W` : `${streak} L`, streak > 0 ? '#22c55e' : streak < 0 ? '#ef4444' : '#94a3b8')}
        {statCell('Trades', `${stats.totalTrades}`, '#94a3b8')}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Lookback:</span>
        <select value={lookback} onChange={e => setLookback(parseInt(e.target.value))}
          style={{ background: 'var(--input-bg)', border: '1px solid var(--border-color)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 12, padding: '4px 8px' }}>
          <option value={30}>30 days</option>
          <option value={60}>60 days</option>
          <option value={90}>90 days</option>
          <option value={365}>All time</option>
        </select>
      </div>
    </div>
  );
}

function RiskOfRuinWidget({ stats, settings, lookback }) {
  const [rorData, setRorData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [q1WinRate, setQ1WinRate] = React.useState(null);

  React.useEffect(() => {
    fetch(`${API_URL}/stats/overview?dateFrom=${new Date(Date.now()-30*86400000).toISOString().split('T')[0]}`)
      .then(r => r.json())
      .then(() => {}) // handled below via direct query
      .catch(() => {});
    // Dedicated qty=1 30-day win rate
    fetch(`${API_URL}/risk/q1-winrate`)
      .then(r => r.json())
      .then(d => setQ1WinRate(d))
      .catch(() => {});
  }, []);

  React.useEffect(() => {
    if (!stats) return;
    const riskPct = settings?.risk_pct_per_trade || 2;
    const accts = '';
    setLoading(true);
    Promise.all([
      fetch(`${API_URL}/risk/ruin?riskPct=${riskPct}&days=${lookback}${accts}`).then(r => r.json()),
      fetch(`${API_URL}/risk/ruin/compare?days=${lookback}${accts}`).then(r => r.json()),
    ]).then(([ruin, compare]) => {
      setRorData({ ruin, compare });
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [stats, settings?.risk_pct_per_trade, lookback]);

  const rorColor = (ror) => {
    if (ror === null || ror === undefined) return '#94a3b8';
    if (ror < 0.05) return '#22c55e';
    if (ror < 0.15) return '#86efac';
    if (ror < 0.30) return '#fbbf24';
    if (ror < 0.55) return '#f97316';
    return '#ef4444';
  };
  const rorLabel = (ror) => {
    if (ror === null || ror === undefined) return '—';
    if (ror < 0.05) return 'SAFE';
    if (ror < 0.15) return 'LOW RISK';
    if (ror < 0.30) return 'CAUTION';
    if (ror < 0.55) return 'WARNING';
    return 'DANGER';
  };

  const ror = rorData?.ruin?.ror;
  const riskPct = settings?.risk_pct_per_trade || 2;
  const color = rorColor(ror);

  return (
    <div style={{ background: 'var(--card-bg)', border: `2px solid ${ror !== undefined ? color : 'var(--border-color)'}`, borderRadius: 12, padding: '24px 28px', minWidth: 280, flex: 1 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 12, letterSpacing: '0.05em', textTransform: 'uppercase' }}>Risk of Ruin</div>
      {loading ? (
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Simulating…</div>
      ) : ror === null ? (
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Insufficient data</div>
      ) : (
        <>
          {q1WinRate?.trades > 0 && (() => {
            const wr = parseFloat(q1WinRate.win_rate) * 100;
            const wrColor = wr >= 55 ? '#22c55e' : wr >= 50 ? '#fbbf24' : '#ef4444';
            return (
              <div style={{ marginBottom: 12, paddingBottom: 10, borderBottom: '1px solid var(--border-color)' }}>
                <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>30-day win rate (1 contract):&nbsp;</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: wrColor, fontFamily: 'monospace' }}>{wr.toFixed(1)}%</span>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}> — {q1WinRate.trades} trades</span>
              </div>
            );
          })()}
          <div style={{ fontSize: 56, fontWeight: 800, color, lineHeight: 1, fontFamily: 'monospace' }}>
            {(ror * 100).toFixed(1)}%
          </div>
          <div style={{ fontSize: 14, fontWeight: 700, color, marginTop: 4, letterSpacing: '0.08em' }}>{rorLabel(ror)}</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>
            at {riskPct}% risk per trade · last {lookback} days
          </div>
          {rorData?.compare && (
            <div style={{ display: 'flex', gap: 16, marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--border-color)' }}>
              {[{ pct: 1, val: rorData.compare.at1pct }, { pct: 2, val: rorData.compare.at2pct }, { pct: 3, val: rorData.compare.at3pct }].map(({ pct, val }) => (
                <div key={pct} style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 16, fontWeight: 700, fontFamily: 'monospace', color: rorColor(val) }}>{val !== null ? (val * 100).toFixed(1) + '%' : '—'}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>at {pct}%</div>
                </div>
              ))}
            </div>
          )}
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 12 }}>
            {(stats?.winRate * 100).toFixed(1)}% WR · {stats?.payoffRatio?.toFixed(2)}R payoff · {stats?.totalTrades} trades
          </div>
        </>
      )}
    </div>
  );
}

function PositionSizingPanel({ stats, settings, onSaveSettings }) {
  const accountSize = parseFloat(settings?.account_size) || 50000;
  const [localRiskPct, setLocalRiskPct] = React.useState(parseFloat(settings?.risk_pct_per_trade) || 2);
  const [instrument, setInstrument] = React.useState(settings?.instrument || 'MNQ');
  const [stopPoints, setStopPoints] = React.useState(20);

  React.useEffect(() => {
    if (settings) {
      setLocalRiskPct(parseFloat(settings.risk_pct_per_trade) || 2);
      setInstrument(settings.instrument || 'MNQ');
    }
  }, [settings]);

  const p = stats?.winRate || 0;
  const b = stats?.payoffRatio || 0;
  const kelly = b > 0 ? Math.max(0, (p * b - (1 - p)) / b) : 0;
  const halfKelly = kelly / 2;

  const pointValue = instrument === 'NQ' ? 20 : 2;
  const dollarRisk = accountSize * (localRiskPct / 100);
  const contracts = Math.max(1, Math.floor(dollarRisk / (stopPoints * pointValue)));
  const halfKellyContracts = halfKelly > 0 ? Math.max(1, Math.floor(accountSize * halfKelly / (stopPoints * pointValue))) : 1;

  const aboveHalfKelly = localRiskPct / 100 > halfKelly && halfKelly > 0;

  const handleSave = () => onSaveSettings({ risk_pct_per_trade: localRiskPct, instrument });

  return (
    <div style={{ background: 'var(--card-bg)', border: `1px solid ${aboveHalfKelly ? '#f97316' : 'var(--border-color)'}`, borderRadius: 12, padding: '20px 24px', flex: 1 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 14, letterSpacing: '0.05em', textTransform: 'uppercase' }}>Position Sizing</div>

      <div style={{ display: 'flex', gap: 12, marginBottom: 14, alignItems: 'center' }}>
        <div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Instrument</div>
          <select value={instrument} onChange={e => setInstrument(e.target.value)}
            style={{ background: 'var(--input-bg)', border: '1px solid var(--border-color)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 13, padding: '5px 10px' }}>
            <option value="MNQ">MNQ ($2/pt)</option>
            <option value="NQ">NQ ($20/pt)</option>
          </select>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Stop (points)</div>
          <input type="number" value={stopPoints} onChange={e => setStopPoints(parseFloat(e.target.value) || 20)} min={1} max={200}
            style={{ background: 'var(--input-bg)', border: '1px solid var(--border-color)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 13, padding: '5px 10px', width: 80 }} />
        </div>
      </div>

      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
          Risk per trade: <strong style={{ color: 'var(--text-primary)' }}>{localRiskPct.toFixed(2)}%</strong>
        </div>
        <input type="range" min={0.25} max={5} step={0.25} value={localRiskPct}
          onChange={e => setLocalRiskPct(parseFloat(e.target.value))}
          style={{ width: '100%', accentColor: aboveHalfKelly ? '#f97316' : '#3b82f6' }} />
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-muted)' }}>
          <span>0.25%</span><span>5%</span>
        </div>
      </div>

      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <tbody>
          {[
            ['Kelly Fraction', kelly > 0 ? `${(kelly * 100).toFixed(1)}%` : '—', '#94a3b8'],
            ['Half Kelly (ceiling)', halfKelly > 0 ? `${(halfKelly * 100).toFixed(1)}%` : '—', '#86efac'],
            ['Your risk %', `${localRiskPct.toFixed(2)}%  ${aboveHalfKelly ? '⚠ Above Kelly' : '✓ Within Kelly'}`, aboveHalfKelly ? '#f97316' : '#22c55e'],
            ['Dollar risk/trade', `$${dollarRisk.toFixed(0)}`, 'var(--text-primary)'],
            ['Contracts @ risk %', `${contracts}`, 'var(--text-primary)'],
            ['Contracts @ Half Kelly', halfKelly > 0 ? `${halfKellyContracts}` : '—', '#86efac'],
          ].map(([label, val, color]) => (
            <tr key={label} style={{ borderBottom: '1px solid var(--border-color)' }}>
              <td style={{ padding: '7px 0', color: 'var(--text-muted)' }}>{label}</td>
              <td style={{ padding: '7px 0', fontWeight: 600, color, textAlign: 'right', fontFamily: 'monospace' }}>{val}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {aboveHalfKelly && (
        <div style={{ marginTop: 12, padding: '8px 12px', background: 'rgba(249,115,22,0.1)', border: '1px solid #f97316', borderRadius: 7, fontSize: 12, color: '#f97316' }}>
          Current risk exceeds Half Kelly ceiling. Risk of ruin increases significantly above this level.
        </div>
      )}

      <button onClick={handleSave} style={{ marginTop: 14, width: '100%', padding: '8px', background: '#3b82f6', border: 'none', borderRadius: 7, color: '#fff', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
        Save Settings
      </button>
    </div>
  );
}

function TradeMathPanel({ stats }) {
  const [openSection, setOpenSection] = React.useState('ev');
  const p = stats?.winRate || 0;
  const b = stats?.payoffRatio || 0;
  const ev = p * b - (1 - p);

  const toggle = (s) => setOpenSection(prev => prev === s ? null : s);

  const sectionHeader = (key, label) => (
    <button onClick={() => toggle(key)}
      style={{ width: '100%', textAlign: 'left', background: 'transparent', border: 'none', borderBottom: '1px solid var(--border-color)', padding: '10px 0', color: 'var(--text-primary)', fontWeight: 600, fontSize: 13, cursor: 'pointer', display: 'flex', justifyContent: 'space-between' }}>
      {label}<span style={{ color: 'var(--text-muted)' }}>{openSection === key ? '▲' : '▼'}</span>
    </button>
  );

  return (
    <div style={{ background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderRadius: 12, padding: '20px 24px', flex: 1 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 14, letterSpacing: '0.05em', textTransform: 'uppercase' }}>Trade Math</div>

      {/* Expected Value */}
      {sectionHeader('ev', 'Expected Value')}
      {openSection === 'ev' && (
        <div style={{ padding: '12px 0' }}>
          <div style={{ marginBottom: 10 }}>
            {[['per $1 risked', 1], ['per $100 risked', 100], ['per $1,000 risked', 1000]].map(([label, mult]) => (
              <div key={label} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>{label}</span>
                <span style={{ fontFamily: 'monospace', fontWeight: 700, color: ev >= 0 ? '#22c55e' : '#ef4444' }}>
                  {ev >= 0 ? '+' : ''}{(ev * mult).toFixed(2)}
                </span>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
            EV = (WR × Payoff) − (1 − WR) = {ev >= 0 ? '+' : ''}{ev.toFixed(3)}R
          </div>
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>Sensitivity (WR ± 10%)</div>
            <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
              <thead><tr><th style={{ color: 'var(--text-muted)', textAlign: 'left', fontWeight: 400, paddingBottom: 4 }}>WR</th><th style={{ color: 'var(--text-muted)', textAlign: 'right', fontWeight: 400 }}>EV</th></tr></thead>
              <tbody>
                {[-0.10, -0.05, 0, 0.05, 0.10].map(delta => {
                  const wr2 = Math.max(0, Math.min(1, p + delta));
                  const ev2 = wr2 * b - (1 - wr2);
                  return (
                    <tr key={delta} style={{ fontWeight: delta === 0 ? 700 : 400 }}>
                      <td style={{ padding: '3px 0' }}>{(wr2 * 100).toFixed(0)}%{delta === 0 ? ' ◄' : ''}</td>
                      <td style={{ textAlign: 'right', color: ev2 >= 0 ? '#22c55e' : '#ef4444', fontFamily: 'monospace' }}>{ev2 >= 0 ? '+' : ''}{ev2.toFixed(3)}R</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Consecutive Loss Probability */}
      {sectionHeader('streak', 'Loss Streak Probability')}
      {openSection === 'streak' && (
        <div style={{ padding: '12px 0' }}>
          {[2, 3, 4, 5, 6, 7].map(n => {
            const prob = Math.pow(1 - p, n);
            const every = prob > 0 ? Math.round(1 / prob) : 0;
            return (
              <div key={n} style={{ marginBottom: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 3 }}>
                  <span style={{ color: 'var(--text-muted)' }}>{n} losses in a row</span>
                  <span style={{ fontFamily: 'monospace', fontWeight: 600, color: 'var(--text-primary)' }}>{(prob * 100).toFixed(1)}%</span>
                </div>
                <div style={{ height: 6, background: 'var(--border-color)', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${Math.min(100, prob * 100 * 5)}%`, background: `hsl(${Math.max(0, 120 - n * 20)}, 70%, 50%)`, borderRadius: 3 }} />
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
                  Expected every ~{every} trades
                </div>
              </div>
            );
          })}
          <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>
            This is expected variance, not evidence of a broken edge.
          </div>
        </div>
      )}

      {/* Drawdown Recovery */}
      {sectionHeader('drawdown', 'Drawdown Recovery')}
      {openSection === 'drawdown' && (
        <div style={{ padding: '12px 0' }}>
          <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ color: 'var(--text-muted)', textAlign: 'left', fontWeight: 400, paddingBottom: 6 }}>Drawdown</th>
                <th style={{ color: 'var(--text-muted)', textAlign: 'right', fontWeight: 400 }}>Recovery Needed</th>
              </tr>
            </thead>
            <tbody>
              {[5, 10, 15, 20, 25, 30, 40, 50].map(dd => {
                const recovery = (1 / (1 - dd / 100) - 1) * 100;
                const severity = dd / 50;
                const r = Math.round(255 * severity);
                const g = Math.round(200 * (1 - severity));
                return (
                  <tr key={dd} style={{ borderBottom: '1px solid var(--border-color)' }}>
                    <td style={{ padding: '6px 0', color: `rgb(${r},${g},80)`, fontWeight: 600 }}>−{dd}%</td>
                    <td style={{ padding: '6px 0', textAlign: 'right', fontFamily: 'monospace', fontWeight: 700, color: `rgb(${r},${g},80)` }}>+{recovery.toFixed(1)}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-muted)' }}>
            A 50% loss requires 100% gain to recover. Protect capital first.
          </div>
        </div>
      )}
    </div>
  );
}

function SessionRiskGate({ settings }) {
  const [session, setSession] = React.useState(null);
  const [overrideInput, setOverrideInput] = React.useState('');

  const load = async () => {
    try {
      const r = await fetch(`${API_URL}/sessions/current`);
      const d = await r.json();
      setSession(d);
    } catch(e) {}
  };

  React.useEffect(() => {
    load();
    const interval = setInterval(load, 30000);
    return () => clearInterval(interval);
  }, [settings]);

  if (!session) return null;

  const { phase, sessionPnl, dailyLimitDollars, pctUsed, limitHit, minutesToOpen, currentTime, accountSize } = session;
  const limitPct = parseFloat(settings?.daily_loss_limit_pct) || 2;

  const barColor = pctUsed < 50 ? '#22c55e' : pctUsed < 75 ? '#fbbf24' : '#ef4444';

  const phaseColors = { pre: '#64748b', active: '#22c55e', limit_hit: '#ef4444', closed: '#64748b' };
  const borderColor = phaseColors[phase] || '#64748b';

  return (
    <div style={{ background: 'var(--card-bg)', border: `2px solid ${borderColor}`, borderRadius: 10, padding: '12px 20px', marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ width: 10, height: 10, borderRadius: '50%', background: borderColor, boxShadow: phase === 'active' ? `0 0 8px ${borderColor}` : 'none' }} />
          <span style={{ fontWeight: 700, fontSize: 13, color: borderColor, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            {phase === 'pre' && 'Pre-Market'}
            {phase === 'active' && 'Session Active'}
            {phase === 'limit_hit' && 'Daily Limit Hit'}
            {phase === 'closed' && 'Session Closed'}
          </span>
        </div>

        {phase === 'pre' && (
          <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
            Opens in {minutesToOpen}m · Limit: ${dailyLimitDollars?.toFixed(0)} ({limitPct}%)
          </span>
        )}

        {(phase === 'active' || phase === 'limit_hit') && (
          <>
            <span style={{ fontSize: 13, fontFamily: 'monospace', color: sessionPnl >= 0 ? '#22c55e' : '#ef4444', fontWeight: 700 }}>
              {sessionPnl >= 0 ? '+' : ''}${sessionPnl?.toFixed(2)}
            </span>
            <div style={{ flex: 1, minWidth: 120 }}>
              <div style={{ height: 8, background: 'var(--border-color)', borderRadius: 4, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${Math.min(100, pctUsed)}%`, background: barColor, borderRadius: 4, transition: 'width 0.5s' }} />
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
                {pctUsed?.toFixed(0)}% of daily limit (${dailyLimitDollars?.toFixed(0)})
                {pctUsed >= 50 && pctUsed < 75 && ' · Caution'}
                {pctUsed >= 75 && pctUsed < 100 && ' · Consider reducing size'}
                {pctUsed >= 100 && ' · LIMIT HIT'}
              </div>
            </div>
          </>
        )}

        {phase === 'limit_hit' && (
          <div style={{ padding: '6px 12px', background: 'rgba(239,68,68,0.15)', border: '1px solid #ef4444', borderRadius: 7, fontSize: 12, color: '#ef4444', fontWeight: 600 }}>
            No new positions. Edge protection, not punishment.
          </div>
        )}

        {phase === 'closed' && (
          <>
            <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>Morning session closed</span>
            <span style={{ fontSize: 13, fontFamily: 'monospace', fontWeight: 700, color: sessionPnl >= 0 ? '#22c55e' : '#ef4444' }}>
              Final: {sessionPnl >= 0 ? '+' : ''}${sessionPnl?.toFixed(2)}
            </span>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input placeholder="Type OVERRIDE to trade" value={overrideInput} onChange={e => setOverrideInput(e.target.value)}
                style={{ background: 'var(--input-bg)', border: '1px solid var(--border-color)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 12, padding: '4px 8px', width: 180 }} />
              {overrideInput === 'OVERRIDE' && (
                <span style={{ fontSize: 12, color: '#fbbf24' }}>Override active — trade with caution</span>
              )}
            </div>
          </>
        )}

        <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 'auto' }}>{currentTime} ET</span>
      </div>
    </div>
  );
}

function RiskView({ accounts, selectedAccounts, setSelectedAccounts }) {
  const [lookback, setLookback] = React.useState(60);
  const [stats, setStats] = React.useState(null);
  const { settings, save: saveSettings, reload: reloadSettings } = useRiskSettings();

  const acctParam = selectedAccounts?.length > 0 ? `&accounts=${selectedAccounts.join(',')}` : '';

  const loadStats = React.useCallback(() => {
    fetch(`${API_URL}/risk/stats?days=${lookback}${acctParam}`)
      .then(r => r.json())
      .then(setStats)
      .catch(console.error);
  }, [lookback, acctParam]);

  React.useEffect(() => { loadStats(); }, [loadStats]);

  const handleSaveSettings = async (updates) => {
    await saveSettings(updates);
    await reloadSettings();
  };

  return (
    <div style={{ padding: '24px 28px', maxWidth: 1200, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <h2 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Risk Management</h2>
        {accounts?.length > 0 && (
          <AccountSelector accounts={accounts} selectedAccounts={selectedAccounts} setSelectedAccounts={setSelectedAccounts} />
        )}
      </div>

      <SessionRiskGate settings={settings} />

      <div style={{ marginBottom: 16 }}>
        <RollingStatsBar stats={stats} lookback={lookback} setLookback={setLookback} />
      </div>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 16 }}>
        <RiskOfRuinWidget stats={stats} settings={settings} lookback={lookback} />
        <PositionSizingPanel stats={stats} settings={settings} onSaveSettings={handleSaveSettings} />
      </div>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 16 }}>
        <TradeMathPanel stats={stats} />
        <BalsaraReferenceCard />
      </div>
    </div>
  );
}

function BalsaraReferenceCard() {
  return (
    <div style={{ background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderRadius: 12, padding: '20px 24px', flex: 1, minWidth: 260 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 12, letterSpacing: '0.05em', textTransform: 'uppercase' }}>Balsara Reference</div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.7 }}>
        {[
          'At 52% WR, 1.67R payoff → EV = +0.19R/trade',
          '2% risk at these stats → well within Half Kelly',
          '4 losses in a row at 52% WR → 5.5% chance (every ~18 trades)',
          '5 losses in a row → 2.6% chance (every ~38 trades)',
          'Down 25% requires +33.3% to recover',
          'Down 33% requires +50% to recover',
          'Down 50% requires +100% to recover',
          'At 10% risk/trade → ruin near-certain regardless of edge',
          'At 1–2% risk → ruin collapses to near zero',
          'Half Kelly ≈ 75% of growth rate, far less drawdown',
        ].map((line, i) => (
          <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
            <span style={{ color: '#3b82f6', flexShrink: 0 }}>·</span>
            <span>{line}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// AccountSelector used by RiskView (reuses pattern from other views)
function AccountSelector({ accounts, selectedAccounts, setSelectedAccounts }) {
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {accounts.map(acct => (
        <button key={acct}
          onClick={() => {
            if (selectedAccounts.includes(acct)) {
              if (selectedAccounts.length > 1) setSelectedAccounts(prev => prev.filter(a => a !== acct));
            } else {
              setSelectedAccounts(prev => [...prev, acct]);
            }
          }}
          style={{
            padding: '4px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: 'pointer',
            background: selectedAccounts.includes(acct) ? '#3b82f6' : 'var(--card-bg)',
            color: selectedAccounts.includes(acct) ? '#fff' : 'var(--text-muted)',
            border: `1px solid ${selectedAccounts.includes(acct) ? '#3b82f6' : 'var(--border-color)'}`,
          }}>
          {acct.slice(-8)}
        </button>
      ))}
    </div>
  );
}

export default App;
