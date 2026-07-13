import React, { useState, useEffect, useMemo, useRef, useCallback, lazy, Suspense } from 'react';
const TearsheetView = lazy(() => import('./views/TearsheetView.jsx'));
const SetupHistoryView = lazy(() => import('./views/SetupHistoryView.jsx'));
const SettingsView = lazy(() => import('./views/SettingsView.jsx'));
const ScenarioTesterView = lazy(() => import('./views/ScenarioTesterView.jsx'));
const AllTradesView = lazy(() => import('./views/AllTradesView.jsx'));
const RiskView = lazy(() => import('./views/RiskView.jsx'));
const LongTermStructurePage = lazy(() => import('./views/LongTermStructureView.jsx'));
const BacktestView = lazy(() => import('./views/BacktestView.jsx'));
import ACDView, { QuickTradeLog, SystemHealthSummary } from './views/ACDView.jsx';
import PlaybookPage, { LevelConfluenceReference, ConditionBacktestInline, PatternStatsPanel } from './views/PlaybookView.jsx';
import { io } from 'socket.io-client';
import './App.css';
import { formatTimestamp, formatFieldTimestamp, isStale, latestOf } from './utils/timestamps.js';
import { TOOLTIPS } from './constants/tooltips.js';
import DashboardView from './components/dashboard/DashboardView.jsx';
import AntigravityEdgesView from './components/dashboard/AntigravityEdgesView.jsx';
import AlphaEngineOverview from './components/dashboard/AlphaEngineOverview.jsx';
import WeeklyReportPanel from './components/dashboard/WeeklyReportPanel.jsx';
import SessionForecastPanel from './components/dashboard/SessionForecastPanel.jsx';
import SessionBiasPanel from './components/dashboard/SessionBiasPanel.jsx';
import PermSlipAndStackBar from './components/dashboard/PermSlipAndStackBar.jsx';
import BalanceZonePanel from './components/dashboard/BalanceZonePanel.jsx';
import TradeCalibrationCard from './components/dashboard/TradeCalibrationCard.jsx';
import DayOfWeekPlaybookCard from './components/dashboard/DayOfWeekPlaybookCard.jsx';
import ScalpPlaybookCard from './components/dashboard/ScalpPlaybookCard.jsx';
import BehavioralPatternsCard from './components/dashboard/BehavioralPatternsCard.jsx';
import PreSessionChecklist from './components/dashboard/PreSessionChecklist.jsx';
import PostLossCooldown from './components/dashboard/PostLossCooldown.jsx';
import { NavUpdateDot, SectionUpdateDot, Dot, useDataUpdateDot, useFieldUpdateDots } from './components/shared/UpdateDot.jsx';
import VolatilityRegimeCard from './components/dashboard/VolatilityRegimeCard.jsx';
import TeleprinterFeed from './components/dashboard/TeleprinterFeed.jsx';
import LiveScriptsCard from './components/dashboard/LiveScriptsCard.jsx';
import SessionPulseCard from './components/dashboard/SessionPulseCard.jsx';
import TradeAlertBanner from './components/dashboard/TradeAlertBanner.jsx';
import VolatilityAlertBanner from './components/dashboard/VolatilityAlertBanner.jsx';
import ApproachingLevelBanner from './components/dashboard/ApproachingLevelBanner.jsx';
import LivePlaybookCard from './components/dashboard/LivePlaybookCard.jsx';
import MarketPulseBar from './components/dashboard/MarketPulseBar.jsx';
import QuickStatsModal from './components/dashboard/QuickStatsModal.jsx';
import ErrorBoundary from './components/shared/ErrorBoundary.jsx';
import InfoTooltip from './components/shared/InfoTooltip.jsx';
import FetchStamp, { fmtFetchStamp } from './components/shared/FetchStamp.jsx';
import CollapsibleSection from './components/shared/CollapsibleSection.jsx';
import AccountSelector from './components/shared/AccountSelector.jsx';
import { formatNumber, fmtP, fmtEtTime } from './utils/format.js';
import { useAcdLive } from './utils/useAcdLive.js';
import WinChip from './components/shared/WinChip.jsx';
import {
  LineChart, Line, AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceLine,
  ComposedChart, Scatter
} from 'recharts';

const API_URL = '/api';
const SOCKET_URL = window.location.origin;



// ==================== PROFIT GIVE-BACK BANNER (full-screen, no override) ====================
function ProfitGivebackBanner({ status, onDismiss }) {
  const fmt$ = (n) => `${n >= 0 ? '+' : ''}$${fmtP(Math.abs(n))}`;
  const gbPct = Math.round((status?.giveBackPct || 0) * 100);
  const peak  = status?.peakPnl || 0;
  const cur   = status?.currentPnl || 0;
  const gb    = status?.giveBack || 0;
  const reason = status?.fireReason === 'floor'
    ? `You fell below the profit floor ($${status?.floorAfterArm}) after being up ${fmt$(peak)}.`
    : `You gave back ${gbPct}% of your peak profit (${fmt$(peak)} → ${fmt$(cur)}).`;

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 99999, background: 'rgba(10,10,15,0.97)', display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(4px)' }}>
      <div style={{ maxWidth: 520, width: '90vw', background: '#0f1520', border: '2px solid #f59e0b', borderRadius: 16, padding: '40px 44px', boxShadow: '0 0 80px rgba(245,158,11,0.2)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 28 }}>
          <div style={{ width: 48, height: 48, borderRadius: '50%', background: 'rgba(245,158,11,0.12)', border: '2px solid #f59e0b', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, flexShrink: 0 }}>⚠</div>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.12em', color: '#f59e0b', textTransform: 'uppercase', marginBottom: 2 }}>Profit Give-Back Guard</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: '#fde68a', letterSpacing: '-0.01em' }}>Stop Trading</div>
          </div>
        </div>
        <div style={{ fontSize: 18, fontWeight: 700, color: '#f8fafc', marginBottom: 10, lineHeight: 1.4 }}>
          You were up {fmt$(peak)}. You are now {fmt$(cur)}.
        </div>
        <div style={{ fontSize: 14, color: '#94a3b8', lineHeight: 1.7, marginBottom: 24 }}>
          {reason} Your 60-day data shows average give-back of $485–663 per day. This is that pattern — right now, live.
        </div>
        <div style={{ display: 'flex', gap: 12, marginBottom: 28 }}>
          <div style={{ flex: 1, background: '#111827', borderRadius: 8, padding: '12px 16px', textAlign: 'center' }}>
            <div style={{ fontSize: 11, color: '#94a3b8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>Peak Today</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: '#22c55e' }}>{fmt$(peak)}</div>
          </div>
          <div style={{ flex: 1, background: '#111827', borderRadius: 8, padding: '12px 16px', textAlign: 'center' }}>
            <div style={{ fontSize: 11, color: '#94a3b8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>Now</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: cur >= 0 ? '#22c55e' : '#ef4444' }}>{fmt$(cur)}</div>
          </div>
          <div style={{ flex: 1, background: '#111827', borderRadius: 8, padding: '12px 16px', textAlign: 'center' }}>
            <div style={{ fontSize: 11, color: '#94a3b8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>Given Back</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: '#f59e0b' }}>-${fmtP(gb)}</div>
          </div>
        </div>
        <div style={{ background: '#1a1200', border: '1px solid rgba(245,158,11,0.4)', borderRadius: 8, padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
          <div style={{ fontSize: 16 }}>🔒</div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#f59e0b', marginBottom: 2 }}>Session locked</div>
            <div style={{ fontSize: 12, color: '#94a3b8' }}>You are done for today.</div>
          </div>
        </div>
        {onDismiss && (
          <button
            onClick={onDismiss}
            style={{ width: '100%', padding: '10px 0', borderRadius: 8, border: '1px solid #334155', background: 'transparent', color: '#64748b', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}
          >
            Dismiss — I know, just working on the app
          </button>
        )}
      </div>
    </div>
  );
}

// ==================== 1PM STOP REMINDER (full-screen, requires acknowledgment) ====================
function OnePMReminderModal({ pnlAtReminder, onAck }) {
  const fmt$ = (n) => `${n >= 0 ? '+' : ''}$${fmtP(Math.abs(n))}`;
  const isGreen = (pnlAtReminder || 0) >= 0;
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 99998, background: 'rgba(10,10,15,0.95)', display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(4px)' }}>
      <div style={{ maxWidth: 520, width: '90vw', background: '#0f1520', border: '2px solid #3b82f6', borderRadius: 16, padding: '40px 44px', boxShadow: '0 0 60px rgba(59,130,246,0.15)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 28 }}>
          <div style={{ width: 48, height: 48, borderRadius: '50%', background: 'rgba(59,130,246,0.12)', border: '2px solid #3b82f6', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, flexShrink: 0 }}>⏰</div>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.12em', color: '#3b82f6', textTransform: 'uppercase', marginBottom: 2 }}>1:00 PM ET</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: '#bfdbfe', letterSpacing: '-0.01em' }}>Your Window Is Over</div>
          </div>
        </div>
        <div style={{ fontSize: 15, color: '#94a3b8', lineHeight: 1.8, marginBottom: 24 }}>
          Your data: <strong style={{ color: '#f8fafc' }}>100% of your losing days were traded past 1 PM.</strong> That is not a coincidence — it is the pattern. The edge disappears after noon.
        </div>
        {pnlAtReminder != null && (
          <div style={{ background: '#111827', borderRadius: 8, padding: '14px 18px', marginBottom: 24, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 13, color: '#94a3b8' }}>P&L right now:</span>
            <span style={{ fontSize: 20, fontWeight: 800, color: isGreen ? '#22c55e' : '#ef4444', fontFamily: 'monospace' }}>{fmt$(pnlAtReminder)}</span>
          </div>
        )}
        <div style={{ display: 'flex', gap: 10 }}>
          <button
            onClick={() => onAck('STOP')}
            style={{ flex: 2, padding: '14px 0', borderRadius: 8, border: 'none', background: '#1d4ed8', color: '#fff', fontWeight: 700, fontSize: 15, cursor: 'pointer' }}
          >
            I'm done — closing out
          </button>
          <button
            onClick={() => onAck('CONTINUE')}
            style={{ flex: 1, padding: '14px 0', borderRadius: 8, border: '1px solid rgba(100,116,139,0.4)', background: 'transparent', color: '#94a3b8', fontWeight: 600, fontSize: 14, cursor: 'pointer' }}
          >
            Continue (logged)
          </button>
        </div>
      </div>
    </div>
  );
}

// ==================== UP-AND-DONE NUDGE (non-blocking, dismissible) ====================
function UpAndDoneNudge({ status, onStop, onDismiss }) {
  const fmt$ = (n) => `${n >= 0 ? '+' : ''}$${fmtP(Math.abs(n))}`;
  const pnl = status?.currentPnl || 0;
  return (
    <div style={{ position: 'fixed', bottom: 24, right: 24, zIndex: 9999, maxWidth: 360, width: 'calc(100vw - 48px)' }}>
      <div style={{ background: '#0f1520', border: '1.5px solid rgba(34,197,94,0.5)', borderRadius: 12, padding: '16px 20px', boxShadow: '0 8px 32px rgba(0,0,0,0.4)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', color: '#22c55e', textTransform: 'uppercase' }}>You're Up {fmt$(pnl)}</div>
          <button onClick={onDismiss} style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: '0 0 0 8px' }}>×</button>
        </div>
        <div style={{ fontSize: 13, color: '#94a3b8', lineHeight: 1.6, marginBottom: 14 }}>
          Your data: average give-back of <strong style={{ color: '#fde68a' }}>$485–663/day</strong>. Every day. Is today worth the risk?
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={onStop}
            style={{ flex: 1, padding: '9px 0', borderRadius: 7, border: '1px solid rgba(34,197,94,0.3)', background: 'rgba(34,197,94,0.15)', color: '#22c55e', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}
          >
            Lock it in
          </button>
          <button
            onClick={onDismiss}
            style={{ flex: 1, padding: '9px 0', borderRadius: 7, border: '1px solid rgba(100,116,139,0.3)', background: 'transparent', color: '#94a3b8', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}
          >
            Keep going
          </button>
        </div>
      </div>
    </div>
  );
}

// ==================== DLL BLOCKING BANNER ====================
function DLLBlockingBanner({ hits, allAccounts, onDismiss }) {
  const shortId = (id) => id.split('-').pop() || id;
  const hitAccount = hits?.[0];
  if (!hitAccount) return null;

  const pnlFmt = (n) => `${n < 0 ? '-' : '+'}$${fmtP(Math.abs(n))}`;
  const dll = hitAccount.daily_loss_limit;
  const pnl = hitAccount.daily_pnl;
  const accountTag = shortId(hitAccount.account_id);

  // Find any other accounts that hit DLL previously (closed accounts as evidence)
  const otherClosed = allAccounts?.filter(a => a.account_id !== hitAccount.account_id && a.near_limit_days > 0) || [];

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 99999,
      background: 'rgba(10,10,15,0.7)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      backdropFilter: 'blur(2px)',
    }}
      // Backdrop click dismisses — this is a stop-trading reminder, not an app lock.
      // Review/journaling/annotations must remain reachable while DLL-locked.
      onClick={onDismiss}
    >
      <div onClick={(e) => e.stopPropagation()} style={{
        position: 'relative',
        maxWidth: 520, width: '90vw',
        background: '#0f1520',
        border: '2px solid #ef4444',
        borderRadius: 16,
        padding: '40px 44px',
        boxShadow: '0 0 80px rgba(239,68,68,0.25)',
      }}>
        <button
          onClick={onDismiss}
          title="Close — review and journaling remain available while locked"
          style={{
            position: 'absolute', top: 14, right: 14,
            background: 'transparent', border: 'none', color: '#94a3b8',
            fontSize: 20, lineHeight: 1, cursor: 'pointer', padding: 4,
          }}
        >×</button>
        {/* Red header stripe */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 28 }}>
          <div style={{
            width: 48, height: 48, borderRadius: '50%',
            background: 'rgba(239,68,68,0.15)',
            border: '2px solid #ef4444',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 22, flexShrink: 0,
          }}>✕</div>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.12em', color: '#ef4444', textTransform: 'uppercase', marginBottom: 2 }}>
              Daily Loss Limit
            </div>
            <div style={{ fontSize: 22, fontWeight: 800, color: '#fca5a5', letterSpacing: '-0.01em' }}>
              {accountTag}
            </div>
          </div>
        </div>

        {/* Core message */}
        <div style={{ fontSize: 18, fontWeight: 700, color: '#f8fafc', marginBottom: 12, lineHeight: 1.4 }}>
          {pnlFmt(pnl)} today on this account.
        </div>
        <div style={{ fontSize: 14, color: '#94a3b8', lineHeight: 1.7, marginBottom: 24 }}>
          The ${dll} limit exists because the trailing drawdown floor is real.
          Removing it costs accounts.
        </div>

        {/* Social proof / consequence */}
        {otherClosed.length > 0 && (
          <div style={{
            background: 'rgba(239,68,68,0.08)',
            border: '1px solid rgba(239,68,68,0.3)',
            borderRadius: 8, padding: '12px 16px', marginBottom: 24,
          }}>
            <div style={{ fontSize: 13, color: '#fca5a5', fontWeight: 600, marginBottom: 4 }}>
              Pattern detected
            </div>
            <div style={{ fontSize: 13, color: '#94a3b8', lineHeight: 1.6 }}>
              {otherClosed.map(a => shortId(a.account_id)).join(', ')} {otherClosed.length === 1 ? 'was' : 'were'} closed after approaching the DLL and continuing to trade.
              This account shows the same pattern.
            </div>
          </div>
        )}

        {/* DLL stats */}
        <div style={{ display: 'flex', gap: 12, marginBottom: 32 }}>
          <div style={{ flex: 1, background: '#111827', borderRadius: 8, padding: '12px 16px', textAlign: 'center' }}>
            <div style={{ fontSize: 11, color: '#94a3b8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>Today</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: '#ef4444' }}>{pnlFmt(pnl)}</div>
          </div>
          <div style={{ flex: 1, background: '#111827', borderRadius: 8, padding: '12px 16px', textAlign: 'center' }}>
            <div style={{ fontSize: 11, color: '#94a3b8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>Limit</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: '#94a3b8' }}>-${dll}</div>
          </div>
          <div style={{ flex: 1, background: '#111827', borderRadius: 8, padding: '12px 16px', textAlign: 'center' }}>
            <div style={{ fontSize: 11, color: '#94a3b8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>Near-Limit Days (All-Time)</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: hitAccount.breach_days > 0 ? '#ef4444' : hitAccount.near_limit_days > 0 ? '#f59e0b' : '#94a3b8' }}>
              {hitAccount.near_limit_days || 0}
            </div>
            {hitAccount.breach_days > 0 && (
              <div style={{ fontSize: 12, color: '#ef4444', marginTop: 2 }}>
                {hitAccount.breach_days} breach{hitAccount.breach_days === 1 ? '' : 'es'}
              </div>
            )}
          </div>
        </div>

        {/* Locked session footer */}
        <div style={{
          background: '#1a0a0a',
          border: '1px solid rgba(239,68,68,0.4)',
          borderRadius: 8, padding: '14px 18px',
          display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16,
        }}>
          <div style={{ fontSize: 16 }}>🔒</div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#ef4444', marginBottom: 2 }}>Session ended for {accountTag}</div>
            <div style={{ fontSize: 12, color: '#94a3b8' }}>No override on trading. Come back tomorrow.</div>
          </div>
        </div>

        <button
          onClick={onDismiss}
          style={{
            width: '100%', padding: '12px 16px',
            background: 'rgba(148,163,184,0.1)', border: '1px solid rgba(148,163,184,0.25)',
            borderRadius: 8, color: '#cbd5e1', fontSize: 13, fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Continue to journal & review →
        </button>
      </div>
    </div>
  );
}

function App() {
  const [currentView, setCurrentView] = useState('acd');
  const [quickStatsOpen, setQuickStatsOpen] = useState(false);
  const [currentDate, setCurrentDate] = useState(new Date().toLocaleDateString('en-CA'));
  const [forecast, setForecast] = useState(null);
  const [stats, setStats] = useState({});

  useEffect(() => {
    fetch(`${API_URL}/morning-brief/forecast/${currentDate}`)
      .then(r => r.json())
      .then(d => setForecast(d))
      .catch(() => {});
  }, [currentDate]);

  useEffect(() => {
    const handler = (e) => {
      if ((e.key === '/' || (e.key === 'k' && (e.ctrlKey || e.metaKey))) &&
          !['INPUT', 'TEXTAREA'].includes(e.target.tagName) && !e.target.isContentEditable) {
        e.preventDefault();
        setQuickStatsOpen(true);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const [accounts, setAccounts] = useState([]);
  const [selectedAccounts, setSelectedAccounts] = useState([]);
  const [toasts, setToasts] = useState([]);
  const toastIdRef = useRef(0);
  const [syncing, setSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState(null);
  const [syncLog, setSyncLog] = useState([]);
  const [priceSyncProgress, setPriceSyncProgress] = useState(null);
  const [processAlertCount, setProcessAlertCount] = useState(0);
  const [dllStatus, setDllStatus] = useState(null);
  const [dllBannerDismissed, setDllBannerDismissed] = useState(false);
  const [profitLockBannerDismissed, setProfitLockBannerDismissed] = useState(false);
  const [profitLockStatus, setProfitLockStatus] = useState(null);
  const [show1PMModal, setShow1PMModal] = useState(false);
  const [onePMChoice, setOnePMChoice] = useState(null);
  const [upAndDoneDismissed, setUpAndDoneDismissed] = useState(false);
  const upAndDoneShownRef = React.useRef(false);
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
    fetch(`${API_URL}/dll/status`).then(r => r.json()).then(d => { if (!d.error) setDllStatus(d); }).catch(() => {});
    fetch(`${API_URL}/profit-lock/status`).then(r => r.json()).then(d => { if (!d.error) setProfitLockStatus(d); }).catch(() => {});

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

    socket.on('process-health-alert', (data) => {
      setProcessAlertCount(data.count || 0);
    });

    socket.on('dll-status', (data) => {
      setDllStatus(prev => {
        // Reset the dismissal once a new day's status comes in
        if (prev?.date !== data?.date) setDllBannerDismissed(false);
        return data;
      });
    });

    socket.on('profit-lock-status', (data) => {
      setProfitLockStatus(data);
      if (data.upAndDoneReady && !upAndDoneShownRef.current) {
        upAndDoneShownRef.current = true;
        setUpAndDoneDismissed(false);
      }
    });

    socket.on('1pm-reminder', (data) => {
      setProfitLockStatus(prev => prev ? { ...prev, _1pmPnl: data.pnlAtReminder } : prev);
      setShow1PMModal(true);
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
      const allRes = await fetch(`${API_URL}/accounts?days=30`);
      const allData = await allRes.json();
      setAccounts(allData);
      if (allData.length === 0) return;

      // Select accounts that traded today; fall back to last trading day
      const todayAccts = await fetch(`${API_URL}/accounts?days=0`).then(r => r.json()).catch(() => []);
      if (Array.isArray(todayAccts) && todayAccts.length > 0) {
        setSelectedAccounts(todayAccts);
        return;
      }
      const lastDay = await fetch(`${API_URL}/accounts/last-day`).then(r => r.json()).catch(() => ({}));
      setSelectedAccounts(lastDay.accounts?.length > 0 ? lastDay.accounts : [allData[0]]);
    } catch (e) { console.error(e); }
  };

  const _nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const _etHour = _nowET.getHours();
  const _todayDateET = _nowET.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const isDLLBannerActive = dllStatus?.anyDllHit && dllStatus?.date === _todayDateET && _etHour < 16 && !dllBannerDismissed;
  const isProfitLockFired = profitLockStatus?.fired && profitLockStatus?.date === _todayDateET && _etHour < 16 && !profitLockBannerDismissed;
  const showUpAndDone = profitLockStatus?.armed && !profitLockStatus?.fired && !upAndDoneDismissed
    && upAndDoneShownRef.current && profitLockStatus?.date === _todayDateET && _etHour < 16;

  const handle1PMAck = async (choice) => {
    setOnePMChoice(choice);
    setShow1PMModal(false);
    try { await fetch(`${API_URL}/profit-lock/1pm-ack`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ choice }) }); } catch (_) {}
  };

  const handleUpAndDoneStop = async () => {
    setUpAndDoneDismissed(true);
    try { await fetch(`${API_URL}/profit-lock/1pm-ack`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ choice: 'STOP_UPANDDONE' }) }); } catch (_) {}
  };

  return (
    <CaseProvider>
    <div className="app-container">
      {isDLLBannerActive && <DLLBlockingBanner hits={dllStatus.hitsAccounts} allAccounts={dllStatus.accounts} onDismiss={() => setDllBannerDismissed(true)} />}
      {isProfitLockFired && !isDLLBannerActive && <ProfitGivebackBanner status={profitLockStatus} onDismiss={() => setProfitLockBannerDismissed(true)} />}
      {show1PMModal && onePMChoice === null && <OnePMReminderModal pnlAtReminder={profitLockStatus?._1pmPnl ?? profitLockStatus?.currentPnl} onAck={handle1PMAck} />}
      {showUpAndDone && <UpAndDoneNudge status={profitLockStatus} onStop={handleUpAndDoneStop} onDismiss={() => setUpAndDoneDismissed(true)} />}
      <Sidebar
        currentView={currentView}
        setCurrentView={setCurrentView}
        processAlertCount={processAlertCount}
        dllWarning={dllStatus?.anyDllWarning || dllStatus?.anyDllHit}
        onOpenQuickStats={() => setQuickStatsOpen(true)}
      />
      <QuickStatsModal open={quickStatsOpen} onClose={() => setQuickStatsOpen(false)} />
      <main className="main-content">
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
        {currentView === 'dashboard' && (
          <ErrorBoundary name="Dashboard">
            <DashboardView accounts={accounts} selectedAccounts={selectedAccounts} setSelectedAccounts={setSelectedAccounts} addToast={addToast} syncing={syncing} syncProgress={syncProgress} syncLog={syncLog} onSyncTrades={() => handleSyncTrades(false)} onDismissSync={() => { setSyncProgress(null); setSyncLog([]); }} />
          </ErrorBoundary>
        )}
        {(currentView === 'all-trades' || currentView === 'calendar') && (
          <ErrorBoundary name="Trades">
            <Suspense fallback={<div style={{ padding: 40, color: 'var(--text-muted)' }}>Loading…</div>}>
              <AllTradesView addToast={addToast} syncing={syncing} onSyncTrades={() => handleSyncTrades(true)}
                accounts={accounts} selectedAccounts={selectedAccounts} setSelectedAccounts={setSelectedAccounts}
                initialTab={currentView === 'calendar' ? 'calendar' : 'trades'}
                setCurrentView={setCurrentView} />
            </Suspense>
          </ErrorBoundary>
        )}
        {currentView === 'scenario' && (
          <ErrorBoundary name="Scenario Tester">
            <Suspense fallback={<div style={{ padding: 40, color: 'var(--text-muted)' }}>Loading…</div>}>
              <ScenarioTesterView />
            </Suspense>
          </ErrorBoundary>
        )}
        {currentView === 'backtest' && (
          <ErrorBoundary name="Backtest">
            <Suspense fallback={<div style={{ padding: 40, color: 'var(--text-muted)' }}>Loading…</div>}>
              <BacktestView accounts={accounts} selectedAccounts={selectedAccounts} setSelectedAccounts={setSelectedAccounts} priceSyncProgress={priceSyncProgress} onDismissPriceSync={() => setPriceSyncProgress(null)} />
            </Suspense>
          </ErrorBoundary>
        )}
        {currentView === 'tearsheet' && (
          <ErrorBoundary name="Tearsheet">
            <Suspense fallback={<div style={{ padding: 40, color: 'var(--text-muted)' }}>Loading…</div>}>
              <TearsheetView accounts={accounts} selectedAccounts={selectedAccounts} setSelectedAccounts={setSelectedAccounts} />
            </Suspense>
          </ErrorBoundary>
        )}
        {currentView === 'settings' && (
          <ErrorBoundary name="Settings">
            <Suspense fallback={<div style={{ padding: 40, color: 'var(--text-muted)' }}>Loading…</div>}>
              <SettingsView />
            </Suspense>
          </ErrorBoundary>
        )}
        {currentView === 'risk' && (
          <ErrorBoundary name="Risk">
            <Suspense fallback={<div style={{ padding: 40, color: 'var(--text-muted)' }}>Loading…</div>}>
              <RiskView accounts={accounts} selectedAccounts={selectedAccounts} setSelectedAccounts={setSelectedAccounts} />
            </Suspense>
          </ErrorBoundary>
        )}
        {currentView === 'acd' && (
          <ErrorBoundary name="Morning Prep">
            <ACDView accounts={accounts} selectedAccounts={selectedAccounts} setSelectedAccounts={setSelectedAccounts} setCurrentView={setCurrentView} />
          </ErrorBoundary>
        )}
        {currentView === 'longterm' && (
          <ErrorBoundary name="Structure">
            <Suspense fallback={<div style={{ padding: 40, color: 'var(--text-muted)' }}>Loading…</div>}>
              <LongTermStructurePage setCurrentView={setCurrentView} />
            </Suspense>
          </ErrorBoundary>
        )}
        {currentView === 'playbook' && (
          <ErrorBoundary name="Playbook">
            <PlaybookPage />
          </ErrorBoundary>
        )}
        {currentView === 'setup-log' && (
          <ErrorBoundary name="Setup Log">
            <Suspense fallback={<div style={{ padding: 40, color: 'var(--text-muted)' }}>Loading…</div>}>
              <SetupHistoryView />
            </Suspense>
          </ErrorBoundary>
        )}
      </main>
    </div>
    </CaseProvider>
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

// ==================== LIVE SESSION PANEL ====================
const SETUP_DISPLAY_LABELS = {
  IB_BULLISH:              'IB Bullish',
  IB_BEARISH:              'IB Bearish',
  BRACKET_BREAKOUT_LONG:   'Bracket Break ↑',
  BRACKET_BREAKOUT_SHORT:  'Bracket Break ↓',
  OPEN_TEST_DRIVE_LONG:    'OTD Long ↑',
  OPEN_TEST_DRIVE_SHORT:   'OTD Short ↓',
  OPEN_DRIVE_LONG:         'Open Drive ↑',
  OPEN_DRIVE_SHORT:        'Open Drive ↓',
  TRT_LONG:                'TRT Long',
  TRT_SHORT:               'TRT Short',
  TRT_LONG_V2:             'TRT V2 Long',
  TRT_SHORT_V2:            'TRT V2 Short',
  TRT_MAH_LONG:            'MAH TRT Long',
  TRT_MAH_SHORT:           'MAH TRT Short',
  FAILED_AUCTION_LONG:     'Failed Auction ↑',
  FAILED_AUCTION_SHORT:    'Failed Auction ↓',
  VALUE_AREA_RESPONSIVE_LONG:  'VA Responsive ↑',
  VALUE_AREA_RESPONSIVE_SHORT: 'VA Responsive ↓',
  GAP_FILL_LONG:           'Gap Fill ↑',
  GAP_FILL_SHORT:          'Gap Fill ↓',
};

// Outcome display for a resolved/expired active_setups row (or a live price-vs-level
// resolution for a card not yet written back to the DB).
const SETUP_RESOLUTION_TEXT = {
  TARGET_HIT:    { label: 'TARGET HIT',    color: '#22c55e', desc: 'Price reached T1 — target achieved. Nothing left to manage.' },
  STOP_HIT:      { label: 'STOP HIT',      color: '#ef4444', desc: 'Price hit the stop — setup is over. Nothing left to manage.' },
  TIME_EXPIRED:  { label: 'EXPIRED',       color: '#94a3b8', desc: 'Setup window closed without resolution.' },
  INVALIDATED:   { label: 'INVALIDATED',   color: '#f59e0b', desc: 'Price structure invalidated this setup before/after it triggered.' },
  SESSION_CLOSED:{ label: 'SESSION CLOSED',color: '#94a3b8', desc: 'Session ended with this setup unresolved.' },
  PREMISE_BROKEN:{ label: 'PREMISE BROKEN',color: '#ef4444', desc: 'Trade premise invalidated — price broke OR Low (for long) or OR High (for short).' },
  JUICE_EXHAUSTED:{ label: 'JUICE EXHAUSTED',color: '#94a3b8', desc: 'Morning drive exhausted — remaining profit potential is too low.' },
};

const SETUP_EVENT_DESCRIPTIONS = {
  'A Up fired':              'Price sustained above the A Up level for 5+ minutes — long entry signal. The sustained close above the A level is the confirmation traders wait for.',
  'A Down fired':            'Price sustained below the A Down level for 5+ minutes — short entry signal. The sustained close confirms sellers are in control.',
  'A Up confirmed':          'A Up fired and follow-through confirmed. Strong continuation long. Price accepted above the A level.',
  'A Down confirmed':        'A Down fired and follow-through confirmed. Strong continuation short. Price accepted below the A level.',
  'Failed A Up':             'Price reached the A Up level but could not hold above OR High. Trapped longs — a short setup triggers as price falls back. Stop above session high.',
  'Failed A Down':           'Price reached A Down but failed to hold below OR Low. Trapped shorts — long setup triggers on recovery. Stop below session low.',
  'C Up (no A)':             'Price closed above OR High with no prior A Up signal. Weaker standalone signal — watch for sustained follow-through before committing.',
  'C Down (no A)':           'Price closed below OR Low with no prior A Down signal. Weaker standalone signal — wait for acceptance.',
  'G-Line lost':             'Price closed below the G-Line (weekly open). Sellers now control the weekly timeframe. Short setups carry structural tailwind.',
  'G-Line reclaimed':        'Price closed back above the G-Line after losing it. Weekly bias shifted bullish. Long setups have structural support.',
  'G-Line tested':           'Price tested the G-Line (weekly open) — key inflection. Watch for acceptance above (bullish) or rejection below (bearish).',
  'PW High broken':          'Price closed above prior week high. Bullish structural shift — value migrating higher. Prior week high flips to support.',
  'PW High tested':          'Prior week high tested but not yet accepted above. Supply zone — watch for close above to confirm breakout.',
  'PW Low broken':           'Price closed below prior week low. Bearish structural shift — value migrating lower. Prior week low flips to resistance.',
  'PW Low tested':           'Prior week low tested but not yet accepted below. Demand zone — watch for close below to confirm breakdown.',
  'PM VAH broken':           'Price accepted above prior month value area high. Long-term buyers establishing higher value.',
  'PM VAH tested':           'Prior month VAH tested. Major structural resistance — watch for acceptance above or rejection.',
  'PM VAL broken':           'Price accepted below prior month value area low. Long-term sellers in control.',
  'PM VAL tested':           'Prior month VAL tested. Major structural support — watch for hold or breakdown.',
  'IB_BULLISH':              'Initial Balance Bullish — price accepted above IB High. OTF buyers establishing higher value. Continuation long favored.',
  'IB_BEARISH':              'Initial Balance Bearish — price accepted below IB Low. OTF sellers in control. Continuation short favored.',
  'BRACKET_BREAKOUT_LONG':   'Bracket breakout long — price closed above multi-session bracket resistance. Value migration confirmed higher. Strong directional bias.',
  'BRACKET_BREAKOUT_SHORT':  'Bracket breakout short — price closed below bracket support. Value migrating lower. High follow-through potential.',
  'OPEN_TEST_DRIVE_LONG':    'Open Test Drive long — price probed lower on the open then reversed through OR High. Initiative buyers dominated the two-way probe.',
  'OPEN_TEST_DRIVE_SHORT':   'Open Test Drive short — price probed higher on the open then reversed through OR Low. Initiative sellers dominated.',
  'OPEN_DRIVE_LONG':         'Open Drive long — price opened and drove straight through OR High without testing lower. Strong directional conviction from the open.',
  'OPEN_DRIVE_SHORT':        'Open Drive short — opened and drove through OR Low without testing higher. Sellers in full control from the open.',
  'TRT_LONG':                'Trapped Shorts long (TRT) — A Down fired but C Down never confirmed. Shorts are trapped; price reversal through OR High triggers long entry.',
  'TRT_SHORT':               'Trapped Longs short (TRT) — A Up fired but C Up never confirmed. Longs are trapped; price reversal through OR Low triggers short entry.',
  'TRT_LONG_V2':             'TRT V2 Long — earlier entry than classic TRT. A Down rejected before C confirmation. Stop below session low.',
  'TRT_SHORT_V2':            'TRT V2 Short — earlier entry. A Up rejected before C confirmation. Stop above session high.',
  'TRT_MAH_LONG':            'MAH TRT Long — extreme NL30 reversal setup. Trapped shorts in an overbought extreme fuel an outsized recovery.',
  'TRT_MAH_SHORT':           'MAH TRT Short — extreme NL30 reversal. Trapped longs in an oversold extreme fuel an outsized decline.',
  'C_STANDALONE_DOWN':       'Standalone C Down — no prior A signal. Price closed below OR Low independently. Watch for sustained follow-through.',
  'C_STANDALONE_UP':         'Standalone C Up — price closed above OR High with no prior A. Watch for sustained follow-through.',
  'FAILED_AUCTION_LONG':     'Failed Auction long — sellers pushed price down, failed to find acceptance, and price reclaimed back into range. Trapped sellers fuel the bounce.',
  'FAILED_AUCTION_SHORT':    'Failed Auction short — buyers pushed price up, failed to find acceptance, and price fell back into range. Trapped buyers fuel the decline.',
  'VALUE_AREA_RESPONSIVE_LONG':  'Value Area Responsive long — price probed below prior value area and responded back inside. Responsive buyers defending value.',
  'VALUE_AREA_RESPONSIVE_SHORT': 'Value Area Responsive short — price probed above prior value area and responded back inside. Responsive sellers defending value.',
  'GAP_FILL_LONG':           'Gap Fill long — price has entered an unfilled down-gap void from a previous session. Speed of travel typically increases inside the void due to lack of historical structure.',
  'GAP_FILL_SHORT':          'Gap Fill short — price has entered an unfilled up-gap void from a previous session. Speed of travel typically increases inside the void due to lack of historical structure.',
};

// ==================== CALENDAR SETUP CONSTANTS ====================
const CAL_SETUP_SHORT_LABELS = {
  BRACKET_BREAKOUT_LONG:        'BB LONG',
  BRACKET_BREAKOUT_SHORT:       'BB SHORT',
  OPEN_TEST_DRIVE_LONG:         'OTD LONG',
  OPEN_TEST_DRIVE_SHORT:        'OTD SHORT',
  OPEN_DRIVE_LONG:              'OD LONG',
  OPEN_DRIVE_SHORT:             'OD SHORT',
  IB_BULLISH:                   'IB BULL',
  IB_BEARISH:                   'IB BEAR',
  TRT_LONG:                     'TRT LONG',
  TRT_SHORT:                    'TRT SHORT',
  TRT_LONG_V2:                  'TRT2 L',
  TRT_SHORT_V2:                 'TRT2 S',
  TRT_MAH_LONG:                 'MAH LONG',
  TRT_MAH_SHORT:                'MAH SHORT',
  C_STANDALONE_UP:              'C UP',
  C_STANDALONE_DOWN:            'C DOWN',
  FAILED_AUCTION_LONG:          'FA LONG',
  FAILED_AUCTION_SHORT:         'FA SHORT',
  VALUE_AREA_RESPONSIVE_LONG:   'VAR LONG',
  VALUE_AREA_RESPONSIVE_SHORT:  'VAR SHORT',
  GAP_FILL_LONG:                'GAP LONG',
  GAP_FILL_SHORT:               'GAP SHORT',
};

function fmtEventTime(t) {
  if (!t) return '';
  const [hStr, mStr] = t.split(':');
  const h = parseInt(hStr, 10), m = parseInt(mStr, 10);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h > 12 ? h - 12 : h === 0 ? 12 : h;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm} ET`;
}

// Honest "data fetched at" stamp — pass the Date when a fetch actually resolved (not render time).
// Converts to ET for display per the app's store-UTC/display-ET convention.
// Dynamically returns detailed, highly articulate execution playbook guidelines for active setups
function getSetupPlaybookNuance(setupType, event) {
  const tu = (setupType || '').toUpperCase();

  if (tu.includes('BRACKET_BREAKOUT_LONG')) {
    return {
      title: "🎯 Nuanced Execution Rules",
      rules: [
        "Do Not Chase the Breakout Bar: Wait for acceptance above the 5-session bracket top (exceeding bracketTop + 5). Look for NQ to build value, print high-volume 1-minute closes, and hold above the bracket top for at least 5 to 10 minutes.",
        "The Bracket Top is the Line in the Sand: The previous 5-session bracket top is now your ultimate invalidation floor. The stop-loss is just below it (bracketTop - 5). If NQ wicks above and then closes back below the bracket top, the breakout has failed, the premise is broken, and you must exit immediately.",
        "If it Fails, it is a Fade Setup: If the bracket breakout is rejected and NQ collapses back inside the bracket, the thesis shifts back to the responsive balance playbook—the failed breakout becomes a high-conviction short fade back to the center of the range."
      ]
    };
  }
  if (tu.includes('BRACKET_BREAKOUT_SHORT')) {
    return {
      title: "🎯 Nuanced Execution Rules",
      rules: [
        "Do Not Chase the Breakout Bar: Wait for acceptance below the 5-session bracket bottom (exceeding bracketBottom - 5). Look for NQ to build value, print high-volume 1-minute closes, and hold below the bracket bottom for at least 5 to 10 minutes.",
        "The Bracket Bottom is the Line in the Sand: The previous 5-session bracket bottom is now your ultimate invalidation floor. The stop-loss is just above it (bracketBottom + 5). If NQ wicks below and then closes back above the bracket bottom, the breakout has failed, the premise is broken, and you must exit immediately.",
        "If it Fails, it is a Fade Setup: If the bracket breakout is rejected and NQ rallies back inside the bracket, the thesis shifts back to the responsive balance playbook—the failed breakout becomes a high-conviction long fade back to the center of the range."
      ]
    };
  }
  if (tu.includes('A_UP') || tu.includes('A UP')) {
    return {
      title: "🎯 Nuanced Execution Rules",
      rules: [
        "Avoid Chasing: Since NQ wicks back inside the IB range 94.2% of the time, entering immediately on the breakout bar carries high stop-out risk. Wait for NQ to re-touch the range boundary or A-Up level to establish your entry.",
        "Opening Range Invalidation: The OR Low is the primary invalidation floor. If NQ wicks or closes below OR Low - 5, the premise is broken, and you should exit the trade immediately.",
        "Verify Bias Confluence: If this A-Up occurs against a bearish day-bias (or A-Down fires), it carries an 87.3% trap rate. Look to fade the breakout rather than buying it."
      ]
    };
  }
  if (tu.includes('A_DOWN') || tu.includes('A DOWN')) {
    return {
      title: "🎯 Nuanced Execution Rules",
      rules: [
        "Avoid Chasing: Since NQ wicks back inside the IB range 94.2% of the time, entering immediately on the breakout bar carries high stop-out risk. Wait for NQ to re-touch the range boundary or A-Down level to establish your entry.",
        "Opening Range Invalidation: The OR High is the primary invalidation floor. If NQ wicks or closes above OR High + 5, the premise is broken, and you should exit the trade immediately.",
        "Verify Bias Confluence: If this A-Down occurs against a bullish day-bias (or A-Up fires), it carries a 100% trap rate. Look to fade the breakout rather than selling it."
      ]
    };
  }
  return null;
}

function SetupEventModal({ event, onClose }) {
  const [stats, setStats] = React.useState(null);

  React.useEffect(() => {
    if (!event) return;
    setStats(null);
    fetch(`${API_URL}/setups/stats?type=${encodeURIComponent(event.setup_type)}`)
      .then(r => r.json())
      .then(d => setStats(d))
      .catch(() => {});
  }, [event?.setup_type]);

  if (!event) return null;

  const type = event.setup_type || '';
  const tu = type.toUpperCase();
  let direction = null;
  if (tu.includes('A UP FIRED') || tu.includes('A UP CONFIRMED') || tu.includes('C UP') || tu.includes('_LONG') || tu.includes('BULLISH') || tu === 'FAILED A DOWN' || tu === 'G-LINE RECLAIMED' || tu === 'PW HIGH BROKEN' || tu === 'PM VAH BROKEN') direction = 'LONG';
  else if (tu.includes('A DOWN FIRED') || tu.includes('A DOWN CONFIRMED') || tu.includes('C DOWN') || tu.includes('_SHORT') || tu.includes('BEARISH') || tu === 'FAILED A UP' || tu === 'G-LINE LOST' || tu === 'PW LOW BROKEN' || tu === 'PM VAL BROKEN') direction = 'SHORT';

  const dirColor = direction === 'LONG' ? '#22c55e' : direction === 'SHORT' ? '#ef4444' : '#94a3b8';
  const borderColor = direction === 'LONG' ? 'rgba(34,197,94,0.4)' : direction === 'SHORT' ? 'rgba(239,68,68,0.4)' : 'rgba(99,102,241,0.4)';
  const bgColor = direction === 'LONG' ? 'rgba(34,197,94,0.06)' : direction === 'SHORT' ? 'rgba(239,68,68,0.06)' : 'rgba(99,102,241,0.06)';

  const starCount = (() => {
    if (['IB_BULLISH','IB_BEARISH','BRACKET_BREAKOUT_LONG','BRACKET_BREAKOUT_SHORT',
         'OPEN_DRIVE_LONG','OPEN_DRIVE_SHORT','TRT_LONG','TRT_SHORT','TRT_LONG_V2','TRT_SHORT_V2',
         'TRT_MAH_LONG','TRT_MAH_SHORT'].includes(type)) return 3;
    if (tu === 'A UP FIRED' || tu === 'A DOWN FIRED' || tu === 'A UP CONFIRMED' || tu === 'A DOWN CONFIRMED' || tu === 'C UP' || tu === 'C DOWN') return 3;
    if (tu.includes('OPEN_TEST_DRIVE') || tu.includes('FAILED')) return 2;
    if (tu.includes('BROKEN')) return 2;
    return 1;
  })();

  const label = SETUP_DISPLAY_LABELS[type] || type.replace(/_/g, ' ');
  const description = SETUP_EVENT_DESCRIPTIONS[type] || 'ACD setup event.';
  const timeStr = fmtEventTime(event.fired_time);
  const price = event.fired_price ? fmtP(parseFloat(event.fired_price), 2) : null;
  const playbook = getSetupPlaybookNuance(type, event);


  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 99998, background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{ background: '#0f172a', border: `1.5px solid ${borderColor}`, borderRadius: 12, padding: '20px 24px', width: '100%', maxWidth: 460, boxShadow: '0 20px 60px rgba(0,0,0,0.8)', position: 'relative' }}
      >
        {/* Close */}
        <button onClick={onClose} style={{ position: 'absolute', top: 12, right: 14, background: 'none', border: 'none', color: '#94a3b8', fontSize: 18, cursor: 'pointer', lineHeight: 1, padding: 2 }}>✕</button>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          {direction && (
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: dirColor, flexShrink: 0 }} />
          )}
          <span style={{ fontSize: 15, fontWeight: 800, color: dirColor, textTransform: 'uppercase', letterSpacing: '0.06em', flex: 1 }}>{label}</span>
          <span style={{ fontSize: 13, letterSpacing: '-1px' }}>
            {[1,2,3].map(n => <span key={n} style={{ color: n <= starCount ? dirColor : '#1e293b' }}>★</span>)}
          </span>
        </div>

        {/* Time + price */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, padding: '8px 12px', background: bgColor, borderRadius: 6, border: `1px solid ${borderColor}` }}>
          <span style={{ fontSize: 14, fontWeight: 700, fontFamily: 'monospace', color: '#e2e8f0' }}>{timeStr}</span>
          {price && <>
            <span style={{ color: '#94a3b8' }}>·</span>
            <span style={{ fontSize: 14, fontWeight: 700, fontFamily: 'monospace', color: dirColor }}>{price}</span>
          </>}
          {direction && (
            <span style={{ marginLeft: 'auto', fontSize: 13, fontWeight: 700, color: dirColor, letterSpacing: '0.05em' }}>
              {direction === 'LONG' ? '↑ LONG' : '↓ SHORT'}
            </span>
          )}
        </div>

        {/* Description */}
        <div style={{ fontSize: 13, color: '#cbd5e1', lineHeight: 1.65, marginBottom: 16, borderLeft: `2px solid ${borderColor}`, paddingLeft: 12 }}>
          {description}
        </div>

        {/* Playbook rules if available */}
        {playbook && (
          <div style={{ marginTop: 14, borderTop: '1px solid rgba(51,65,85,0.6)', paddingTop: 12, marginBottom: 14 }}>
            <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', color: '#a78bfa', letterSpacing: '0.08em', marginBottom: 8 }}>
              {playbook.title}
            </div>
            <ul style={{ paddingLeft: 18, margin: 0, fontSize: 12, color: '#cbd5e1', display: 'flex', flexDirection: 'column', gap: 6 }}>
              {playbook.rules.map((rule, idx) => {
                const parts = rule.split(':');
                if (parts.length > 1) {
                  return (
                    <li key={idx} style={{ lineHeight: 1.5 }}>
                      <strong style={{ color: '#e2e8f0' }}>{parts[0]}:</strong>{parts.slice(1).join(':')}
                    </li>
                  );
                }
                return <li key={idx} style={{ lineHeight: 1.5 }}>{rule}</li>;
              })}
            </ul>
          </div>
        )}

        {/* Win rate */}
        {stats && (stats.allTime || stats.d90 || stats.d30) && (
          <div style={{ borderTop: '1px solid rgba(51,65,85,0.6)', paddingTop: 14 }}>
            <div style={{ fontSize: 12, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>Historical win rate</div>
            <div style={{ display: 'flex', gap: 20, justifyContent: 'center' }}>
              <WinChip label="All time" stat={stats.allTime} />
              <WinChip label="90d" stat={stats.d90} />
              <WinChip label="30d" stat={stats.d30} />
            </div>
          </div>
        )}
        {stats && !stats.allTime && !stats.d90 && !stats.d30 && (
          <div style={{ borderTop: '1px solid rgba(51,65,85,0.6)', paddingTop: 12, fontSize: 12, color: '#94a3b8', textAlign: 'center' }}>
            No trade history recorded for this setup type yet.
          </div>
        )}
      </div>
    </div>
  );
}

function CaseSetupDetailModal({ setup, onClose }) {
  const [stats, setStats] = React.useState(null);
  const [dayType, setDayType] = React.useState(null);

  React.useEffect(() => {
    if (!setup) return;
    setStats(null);
    fetch(`${API_URL}/setups/stats?type=${encodeURIComponent(setup.type || setup.setup_type)}`)
      .then(r => r.json()).then(setStats).catch(() => {});
    // Grab today's day type for contextual WR highlight
    const d = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    fetch(`${API_URL}/acd/setup-detection?date=${d}`)
      .then(r => r.json()).then(d => setDayType(d?.dayType || null)).catch(() => {});
  }, [setup?.type, setup?.setup_type]);

  if (!setup) return null;

  const type = setup.type || setup.setup_type || '';
  const tu = type.toUpperCase();
  const isLong = tu.includes('LONG') || tu.includes('BULLISH');
  const isShort = tu.includes('SHORT') || tu.includes('BEARISH');
  const dirColor = isLong ? '#22c55e' : isShort ? '#ef4444' : '#94a3b8';
  const borderColor = isLong ? 'rgba(34,197,94,0.4)' : isShort ? 'rgba(239,68,68,0.4)' : 'rgba(99,102,241,0.4)';
  const bgColor = isLong ? 'rgba(34,197,94,0.06)' : isShort ? 'rgba(239,68,68,0.06)' : 'rgba(99,102,241,0.06)';
  const label = SETUP_DISPLAY_LABELS[type] || type.replace(/_/g, ' ');
  const description = SETUP_EVENT_DESCRIPTIONS[type] || null;
  const playbook = getSetupPlaybookNuance(type, setup);

  const entry  = setup.entry  != null ? parseFloat(setup.entry)  : null;
  const stop   = setup.stop   != null ? parseFloat(setup.stop)   : null;
  const target = (setup.target || setup._t1) != null ? parseFloat(setup.target || setup._t1) : null;
  const riskPts   = entry != null && stop   != null ? Math.abs(entry - stop)   : null;
  const rewardPts = entry != null && target != null ? Math.abs(target - entry) : null;
  const rr = riskPts && rewardPts && riskPts > 0 ? (rewardPts / riskPts).toFixed(1) : null;
  const riskDollar   = riskPts   != null ? Math.round(riskPts   * 5) : null;
  const rewardDollar = rewardPts != null ? Math.round(rewardPts * 5) : null;

  const resolution = setup.resolution || setup._resolution;
  const resInfo = resolution ? SETUP_RESOLUTION_TEXT[resolution] : null;
  const pnl = setup.pnl || setup._pnl;
  const timeStr = setup.detectedAt || (setup.fired_time ? fmtEventTime(setup.fired_time) : null);


  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 99999, background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#0f172a', border: `1.5px solid ${borderColor}`, borderRadius: 12, padding: '20px 24px', width: '100%', maxWidth: 480, maxHeight: '88vh', overflowY: 'auto', boxShadow: '0 24px 64px rgba(0,0,0,0.85)', position: 'relative' }}>
        <button onClick={onClose} style={{ position: 'absolute', top: 12, right: 14, background: 'none', border: 'none', color: '#94a3b8', fontSize: 18, cursor: 'pointer', lineHeight: 1 }}>✕</button>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <span style={{ width: 9, height: 9, borderRadius: '50%', background: dirColor, flexShrink: 0 }} />
          <span style={{ fontSize: 16, fontWeight: 800, color: dirColor, textTransform: 'uppercase', letterSpacing: '0.06em', flex: 1 }}>{label}</span>
          {(isLong || isShort) && <span style={{ fontSize: 13, fontWeight: 800, color: dirColor, background: `${dirColor}18`, border: `1px solid ${dirColor}40`, borderRadius: 4, padding: '2px 8px', letterSpacing: '0.04em' }}>{isLong ? '↑ LONG' : '↓ SHORT'}</span>}
        </div>
        {timeStr && <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 10, fontFamily: 'monospace' }}>fired {timeStr}</div>}

        {/* Resolution badge if already resolved */}
        {resInfo && (
          <div style={{ marginBottom: 12, padding: '6px 10px', background: `${resInfo.color}15`, border: `1px solid ${resInfo.color}40`, borderRadius: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 800, color: resInfo.color, letterSpacing: '0.06em' }}>{resInfo.label}</span>
            {pnl != null && <span style={{ fontSize: 13, fontWeight: 700, fontFamily: 'monospace', color: pnl >= 0 ? '#22c55e' : '#ef4444', marginLeft: 'auto' }}>{pnl >= 0 ? '+' : ''}${Math.round(pnl)}</span>}
          </div>
        )}

        {/* Entry / Stop / Target grid */}
        {(entry != null || stop != null || target != null) && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 12 }}>
            {entry != null && (
              <div style={{ padding: '8px', background: 'rgba(30,41,59,0.5)', borderRadius: 6, border: '1px solid rgba(51,65,85,0.5)', textAlign: 'center' }}>
                <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 3 }}>ENTRY</div>
                <div style={{ fontSize: 18, fontWeight: 800, fontFamily: 'monospace', color: '#e2e8f0' }}>{Math.round(entry)}</div>
              </div>
            )}
            {stop != null && (
              <div style={{ padding: '8px', background: 'rgba(239,68,68,0.06)', borderRadius: 6, border: '1px solid rgba(239,68,68,0.25)', textAlign: 'center' }}>
                <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 3 }}>STOP</div>
                <div style={{ fontSize: 18, fontWeight: 800, fontFamily: 'monospace', color: '#ef4444' }}>{Math.round(stop)}</div>
                {riskPts != null && <div style={{ fontSize: 11, color: '#ef4444', opacity: 0.7 }}>{Math.round(riskPts)}pt · ${riskDollar}</div>}
              </div>
            )}
            {target != null && (
              <div style={{ padding: '8px', background: 'rgba(34,197,94,0.06)', borderRadius: 6, border: '1px solid rgba(34,197,94,0.25)', textAlign: 'center' }}>
                <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 3 }}>T1</div>
                <div style={{ fontSize: 18, fontWeight: 800, fontFamily: 'monospace', color: '#22c55e' }}>{Math.round(target)}</div>
                {rewardPts != null && <div style={{ fontSize: 11, color: '#22c55e', opacity: 0.7 }}>{Math.round(rewardPts)}pt · ${rewardDollar}</div>}
              </div>
            )}
          </div>
        )}

        {/* R:R summary row */}
        {rr != null && (
          <div style={{ display: 'flex', gap: 12, marginBottom: 14, padding: '8px 12px', background: bgColor, borderRadius: 6, border: `1px solid ${borderColor}`, fontSize: 12 }}>
            <span style={{ color: '#94a3b8' }}>R:R <strong style={{ color: '#cbd5e1', fontFamily: 'monospace' }}>{rr}</strong></span>
            {riskDollar != null && <span style={{ color: '#94a3b8' }}>Risk <strong style={{ color: '#ef4444', fontFamily: 'monospace' }}>${riskDollar}</strong></span>}
            {rewardDollar != null && <span style={{ color: '#94a3b8' }}>Reward <strong style={{ color: '#22c55e', fontFamily: 'monospace' }}>${rewardDollar}</strong></span>}
          </div>
        )}

        {/* Description */}
        {description && (
          <div style={{ fontSize: 13, color: '#cbd5e1', lineHeight: 1.65, marginBottom: 14, borderLeft: `2px solid ${borderColor}`, paddingLeft: 12 }}>
            {description}
          </div>
        )}

        {/* Win rates */}
        {stats && (
          <div style={{ borderTop: '1px solid rgba(51,65,85,0.5)', paddingTop: 14, marginBottom: 14 }}>
            <div style={{ fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>Historical win rate</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
              <WinChip label="All time" stat={stats.allTime} />
              <WinChip label="90d" stat={stats.d90} />
              <WinChip label="30d" stat={stats.d30} />
            </div>
            {/* By day type — highlight current day type */}
            {stats.byDayType && Object.keys(stats.byDayType).filter(k => k !== 'OVERALL').length > 0 && (
              <div>
                <div style={{ fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>By day type {dayType && <span style={{ color: '#818cf8' }}>(today: {dayType})</span>}</div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {['TREND','BALANCE','TURBULENT'].filter(k => stats.byDayType[k]).map(k => (
                    <WinChip key={k} label={k} stat={stats.byDayType[k]} highlight={k === dayType} />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Playbook notes */}
        {playbook && (
          <div style={{ borderTop: '1px solid rgba(51,65,85,0.5)', paddingTop: 12 }}>
            <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', color: '#a78bfa', letterSpacing: '0.08em', marginBottom: 8 }}>{playbook.title}</div>
            <ul style={{ paddingLeft: 18, margin: 0, fontSize: 12, color: '#cbd5e1', display: 'flex', flexDirection: 'column', gap: 6 }}>
              {playbook.rules.map((rule, idx) => {
                const parts = rule.split(':');
                if (parts.length > 1) return <li key={idx} style={{ lineHeight: 1.5 }}><strong style={{ color: '#e2e8f0' }}>{parts[0]}:</strong>{parts.slice(1).join(':')}</li>;
                return <li key={idx} style={{ lineHeight: 1.5 }}>{rule}</li>;
              })}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

function LiveSessionPanel() {
  const [setupCard, setSetupCard]       = React.useState(null);
  const [sessionClosed, setSessionClosed] = React.useState(false);
  const [events, setEvents]             = React.useState([]);
  const [activeSetups, setActiveSetups] = React.useState([]);
  const [evalProgress, setEvalProgress] = React.useState(null);
  const [selectedSignal, setSelectedSignal] = React.useState(null);
  const [selectedCaseSetup, setSelectedCaseSetup] = React.useState(null);
  const [, forceRender]                 = React.useReducer(n => n + 1, 0);

  const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  const loadSetup = React.useCallback(() => {
    fetch(`${API_URL}/acd/setup-detection`)
      .then(r => r.json())
      .then(d => {
        setSetupCard(d.setup || null);
        if (d.sessionClosed) setSessionClosed(true);
      })
      .catch(() => {});
  }, []);

  const loadEvents = React.useCallback(() => {
    fetch(`${API_URL}/acd/setup-events/day?date=${todayET}`)
      .then(r => r.json())
      .then(rows => setEvents(Array.isArray(rows) ? [...rows].reverse() : []))
      .catch(() => {});
  }, [todayET]);

  const loadActiveSetups = React.useCallback(() => {
    fetch(`${API_URL}/setups/today`)
      .then(r => r.json())
      .then(d => setActiveSetups(Array.isArray(d.setups) ? d.setups : []))
      .catch(() => {});
  }, []);

  const loadEval = React.useCallback(() => {
    fetch(`${API_URL}/eval/progress`)
      .then(r => r.json())
      .then(d => { if (!d.error) setEvalProgress(d); })
      .catch(() => {});
  }, []);

  React.useEffect(() => {
    loadSetup();
    loadEvents();
    loadEval();
    loadActiveSetups();
    // 60s fallback poll; primary updates come from socket events
    const iv = setInterval(() => { loadSetup(); loadEvents(); loadEval(); loadActiveSetups(); forceRender(); }, 60000);

    const sock = window._tradingSocket;
    const onDetected  = (d) => { setSetupCard(d); loadEvents(); };
    const onState     = (d) => { setSetupCard(d.setup || null); if (d.sessionClosed) setSessionClosed(true); };
    const onExpired   = () => { setTimeout(loadSetup, 600); setTimeout(loadActiveSetups, 700); };
    const onResolved  = () => { loadSetup(); loadActiveSetups(); };
    // Reload eval after trade import
    const onImport    = () => loadEval();
    if (sock) {
      sock.on('setup-detected',     onDetected);
      sock.on('setup-state',        onState);
      sock.on('setup-expired',      onExpired);
      sock.on('setup-resolved',     onResolved);
      sock.on('auto-import-complete', onImport);
      sock.on('trades-updated',     onImport);
    }
    return () => {
      clearInterval(iv);
      if (sock) {
        sock.off('setup-detected',     onDetected);
        sock.off('setup-state',        onState);
        sock.off('setup-expired',      onExpired);
        sock.off('setup-resolved',     onResolved);
        sock.off('auto-import-complete', onImport);
        sock.off('trades-updated',     onImport);
      }
    };
  }, [loadSetup, loadEvents, loadEval]);

  const nowET  = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const etMin  = nowET.getHours() * 60 + nowET.getMinutes();
  const etHour = nowET.getHours();
  const inGlobex = etHour >= 18 || etMin < 8 * 60 + 30;
  const inRTH = etMin >= 9 * 60 + 30 && etMin < 16 * 60;
  const isOpen = inGlobex || inRTH;
  const inResetGap = etMin >= 17 * 60 && etMin < 18 * 60; // 5–6 PM dead zone
  const isClosed = inResetGap || sessionClosed;

  const active = setupCard && !setupCard.isExpired ? setupCard : null;
  const isLong = active
    ? (active.type?.includes('LONG') || active.type?.includes('BULLISH'))
    : false;
  const borderColor = active ? (isLong ? '#22c55e' : '#ef4444') : '#1e293b';
  const setupBg     = active ? (isLong ? 'rgba(34,197,94,0.07)' : 'rgba(239,68,68,0.07)') : 'rgba(15,23,42,0.4)';

  const entry = active?.entry, stop = active?.stop, target = active?.target;
  const rr = (entry && stop && target && Math.abs(entry - stop) > 0)
    ? (Math.abs(target - entry) / Math.abs(entry - stop)).toFixed(1)
    : null;

  // Session status line
  let sessionLabel, sessionColor;
  if (isClosed) {
    sessionLabel = inResetGap ? 'RESETTING — Globex opens 6 PM ET' : 'SESSION CLOSED';
    sessionColor = '#64748b';
  } else if (inGlobex) {
    const hh = nowET.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false });
    const minsToRTH = etHour >= 18
      ? (24 * 60 - etMin) + (9 * 60 + 30)  // minutes until 9:30 AM next day
      : (9 * 60 + 30) - etMin;
    const gh = Math.floor(minsToRTH / 60), gm = minsToRTH % 60;
    sessionLabel = `GLOBEX  ${hh} ET  RTH in ${gh > 0 ? `${gh}h ` : ''}${gm}m`;
    sessionColor = '#a78bfa';
  } else if (inRTH) {
    const minsLeft = 16 * 60 - etMin;
    const hh = nowET.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false });
    sessionLabel = `LIVE  ${hh} ET  ${minsLeft}m left`;
    sessionColor = '#22c55e';
  } else {
    const minsToOpen = (9 * 60 + 30) - etMin;
    const h = Math.floor(minsToOpen / 60), m = minsToOpen % 60;
    sessionLabel = `Opens in ${h > 0 ? `${h}h ` : ''}${m}m`;
    sessionColor = '#94a3b8';
  }

  return (
    <div style={{ padding: '12px 10px 8px', display: 'flex', flexDirection: 'column', gap: 8, borderTop: '1px solid rgba(51,65,85,0.6)' }}>

      {/* Active Setup Card */}
      <div
        onClick={() => active && setSelectedCaseSetup(active)}
        style={{ border: `1.5px solid ${borderColor}`, borderRadius: 7, padding: '8px 10px', background: setupBg, minHeight: 52, cursor: active ? 'pointer' : 'default', transition: 'border-color 0.15s' }}
        title={active ? 'Click for details' : undefined}
      >
        {active ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 5 }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: isLong ? '#22c55e' : '#ef4444', animation: (active.minsRemaining == null || active.minsRemaining > 0) ? 'pulse 2s infinite' : 'none', flexShrink: 0 }} />
              <span style={{ fontWeight: 700, fontSize: 11, color: isLong ? '#22c55e' : '#ef4444', textTransform: 'uppercase', letterSpacing: '0.07em', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {SETUP_DISPLAY_LABELS[active.type] || active.type}
              </span>
              <span style={{ fontSize: 11, color: '#64748b', flexShrink: 0, fontFamily: 'monospace' }}>fired {active.detectedAt} ET</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1px 6px', fontSize: 12 }}>
              {entry != null && <span style={{ color: '#94a3b8' }}>Entry <strong style={{ color: '#e2e8f0', fontFamily: 'monospace' }}>{Math.round(entry)}</strong></span>}
              {stop  != null && <span style={{ color: '#94a3b8' }}>Stop <strong style={{ color: '#ef4444', fontFamily: 'monospace' }}>{Math.round(stop)}</strong></span>}
              {target != null && <span style={{ color: '#94a3b8' }}>T1 <strong style={{ color: '#22c55e', fontFamily: 'monospace' }}>{Math.round(target)}</strong></span>}
              {rr != null && <span style={{ color: '#94a3b8' }}>R:R <strong style={{ color: '#cbd5e1', fontFamily: 'monospace' }}>{rr}</strong></span>}
            </div>
            {active.minsRemaining != null && (
              <div style={{ fontSize: 12, color: active.minsRemaining < 10 ? '#f59e0b' : '#64748b', marginTop: 3 }}>
                {active.minsRemaining}m remaining
              </div>
            )}
            {active.firedEtHour === 10 && (
              <div
                title="Backtested edge: setups firing in the 10 AM ET hour win at 38.9% vs 29.2% overall — statistically significant +9.7% lift (p=0.002)"
                style={{ marginTop: 5, fontSize: 12, fontWeight: 700, color: '#fbbf24', background: 'rgba(251,191,36,0.12)', border: '1px solid rgba(251,191,36,0.4)', borderRadius: 3, padding: '1px 6px', display: 'inline-block', cursor: 'help' }}
              >
                ⚡ 10 AM EDGE
              </div>
            )}
            {active.firedEtHour === 9 && (
              <div
                title="9 AM ET setups have below-average win rate in backtesting (29.2%). Be selective."
                style={{ marginTop: 5, fontSize: 12, fontWeight: 700, color: '#94a3b8', background: 'rgba(148,163,184,0.08)', border: '1px solid rgba(148,163,184,0.25)', borderRadius: 3, padding: '1px 6px', display: 'inline-block', cursor: 'help' }}
              >
                ⏰ 9 AM
              </div>
            )}
          </>
        ) : (
          <div style={{ fontSize: 12, color: '#94a3b8', display: 'flex', alignItems: 'center', justifyContent: 'center', height: 36 }}>
            {isClosed ? 'Session closed' : isOpen ? 'Watching — no setup' : 'Market closed'}
          </div>
        )}
      </div>

      {/* Today's Signals */}
      {events.length > 0 && (() => {
        const sigColor = (type) => {
          if (!type) return '#94a3b8';
          const t = type.toUpperCase();
          if (t.includes('FAILED') || t.includes('FAIL')) return '#f97316';
          if (t.includes('BULLISH') || t.includes('_LONG') || t === 'IB_BULLISH' || t.includes('C UP') || t.includes('BRACKET_BREAKOUT_LONG') || t.includes('OPEN_DRIVE_LONG') || t.includes('OPEN_TEST_DRIVE_LONG')) return '#4ade80';
          if (t.includes('BEARISH') || t.includes('_SHORT') || t === 'IB_BEARISH' || t.includes('C DOWN') || t.includes('BRACKET_BREAKOUT_SHORT') || t.includes('OPEN_DRIVE_SHORT') || t.includes('OPEN_TEST_DRIVE_SHORT')) return '#f87171';
          if (t.includes('TESTED')) return '#94a3b8';
          if (t.startsWith('A UP') || t.startsWith('A DOWN')) return '#fbbf24';
          if (t.includes('BROKEN') || t.includes('PM VAH') || t.includes('PW HIGH') || t.includes('PW LOW') || t.includes('PM VAL')) return '#a78bfa';
          return '#94a3b8';
        };

        const sigStars = (type) => {
          if (!type) return 1;
          const t = type.toUpperCase();
          if (['IB_BULLISH','IB_BEARISH','BRACKET_BREAKOUT_LONG','BRACKET_BREAKOUT_SHORT',
               'OPEN_DRIVE_LONG','OPEN_DRIVE_SHORT','TRT_LONG','TRT_SHORT',
               'TRT_MAH_LONG','TRT_MAH_SHORT'].includes(t)) return 3;
          if (t === 'A UP FIRED' || t === 'A DOWN FIRED' || t === 'A UP CONFIRMED' || t === 'A DOWN CONFIRMED') return 3;
          if (t === 'C UP' || t === 'C DOWN' || t.includes('C UP CONFIRMED') || t.includes('C DOWN CONFIRMED')) return 3;
          if (t.includes('OPEN_TEST_DRIVE') || t.includes('TRT_')) return 2;
          if (t.includes('FAILED') || t.includes('C UP (NO A)') || t.includes('C DOWN (NO A)')) return 2;
          if (t.includes('BROKEN')) return 2;
          return 1;
        };

        const SKIP_TYPES = new Set(['A Up tested', 'A Down tested', 'PM VAH tested', 'PW High tested', 'PM VAL tested', 'PW Low tested']);
        const CASE_ENGINE_TYPES = new Set(['IB_BULLISH','IB_BEARISH','BRACKET_BREAKOUT_LONG','BRACKET_BREAKOUT_SHORT',
          'OPEN_DRIVE_LONG','OPEN_DRIVE_SHORT','OPEN_TEST_DRIVE_LONG','OPEN_TEST_DRIVE_SHORT',
          'TRT_LONG','TRT_SHORT','TRT_MAH_LONG','TRT_MAH_SHORT']);

        // Build unified timeline: merge acd_setup_events + active_setups
        // active_setups has entry/t1/stop and resolution; acd_setup_events has all level events
        const caseSetupMap = {};
        for (const s of activeSetups) {
          const timeKey = s.fired_at_str ? s.fired_at_str.slice(11, 16) : null;
          if (timeKey) caseSetupMap[s.setup_type + '_' + timeKey] = s;
        }
        // Events: regular level signals (skip tested) + inject case-engine setups in time order
        const regularEvents = events.filter(e => e && !SKIP_TYPES.has(e.setup_type) && !CASE_ENGINE_TYPES.has(e.setup_type));
        // Case-engine setups from active_setups (not in events list)
        const caseEvents = activeSetups.filter(Boolean).map(s => ({
          setup_type: s.setup_type,
          fired_time: s.fired_at_str ? s.fired_at_str.slice(11, 16) : null,
          fired_price: s.entry_zone_low,
          _resolution: s.resolution,
          _status: s.status,
          _t1: s.t1_level,
          _stop: s.stop_level,
          _entry: s.entry_zone_low,
          _pnl: s.actual_pnl,
          _winRate: s.historical_win_rate,
          _sessions: s.historical_sessions,
          _isCaseEngine: true,
        }));
        // Session Timeline: resolved/expired setups only, RTH hours only (no pre/post-market)
        const allEvents = caseEvents
          .filter(e => {
            if (!e.fired_time || e._status === 'SHADOW' || e._status === 'ACTIVE') return false;
            const [h, m] = e.fired_time.split(':').map(Number);
            return (h > 9 || (h === 9 && m >= 30)) && h < 16;
          })
          .sort((a, b) => {
            if (!a.fired_time) return 1;
            if (!b.fired_time) return -1;
            return b.fired_time.localeCompare(a.fired_time); // most recent first
          });
        const sigCount = caseEvents.filter(e => e.fired_time && e._status !== 'SHADOW').length;

        // Calculate running tally stats — RTH only (09:30–16:00 ET), exclude Globex pre-market detections
        const isRTH = (t) => {
          if (!t) return false;
          const [h, m] = t.split(':').map(Number);
          return (h > 9 || (h === 9 && m >= 30)) && h < 16;
        };
        let wins = 0;
        let losses = 0;
        let totalPnl = 0;
        allEvents.forEach(ev => {
          if (ev._isCaseEngine && isRTH(ev.fired_time)) {
            if (ev._resolution === 'TARGET_HIT') wins++;
            if (ev._resolution === 'STOP_HIT') losses++;
            
            let pval = ev._pnl;
            if (pval !== null && pval !== undefined) {
              if (typeof pval === 'string') {
                pval = pval.replace(/[^0-9.-]/g, '');
              }
              const parsedVal = parseFloat(pval);
              if (!isNaN(parsedVal)) {
                totalPnl += parsedVal;
              }
            }
          }
        });

        const outcomeColor = (resolution, status) => {
          if (resolution === 'TARGET_HIT') return '#22c55e';
          if (resolution === 'STOP_HIT') return '#ef4444';
          if (resolution === 'TIME_EXPIRED' || resolution === 'SESSION_CLOSED') return '#94a3b8';
          if (resolution === 'INVALIDATED') return '#f59e0b';
          if (status === 'ACTIVE') return '#fbbf24'; // still live
          return null;
        };
        const outcomeLabel = (resolution, status) => {
          if (resolution === 'TARGET_HIT') return 'T1 ✓';
          if (resolution === 'STOP_HIT') return 'Stop ✗';
          if (resolution === 'TIME_EXPIRED' || resolution === 'SESSION_CLOSED') return 'expired';
          if (resolution === 'INVALIDATED') return 'inv.';
          if (status === 'ACTIVE') return 'live';
          return null;
        };

        return (
          <div style={{ borderTop: '1px solid rgba(51,65,85,0.4)', paddingTop: 10 }}>
            <div style={{ fontSize: 12, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span>Session Timeline <span style={{ color: '#94a3b8', fontWeight: 600, textTransform: 'none', letterSpacing: 0 }}>({sigCount})</span></span>
              <span style={{ fontSize: 12, color: '#94a3b8', textTransform: 'none', letterSpacing: 0 }}>tap to expand</span>
            </div>

            {/* Session Stats Running Tally */}
            {sigCount > 0 && (
              <div style={{ 
                display: 'flex', 
                gap: 8, 
                marginBottom: 10, 
                padding: '6px 10px', 
                background: 'rgba(15,23,42,0.6)', 
                border: '1px solid rgba(51,65,85,0.25)', 
                borderRadius: 6, 
                justifyContent: 'space-between', 
                alignItems: 'center' 
              }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: '#94a3b8' }}>Wins: <span style={{ color: '#22c55e', fontWeight: 700 }}>{wins}</span></div>
                <div style={{ fontSize: 11, fontWeight: 600, color: '#94a3b8' }}>Losses: <span style={{ color: '#ef4444', fontWeight: 700 }}>{losses}</span></div>
                <div style={{ fontSize: 11, fontWeight: 600, color: '#94a3b8' }}>PnL: <span style={{ color: totalPnl >= 0 ? '#22c55e' : '#ef4444', fontWeight: 700 }}>{totalPnl >= 0 ? '+' : ''}${Math.round(totalPnl).toLocaleString()}</span></div>
              </div>
            )}

            <div style={{ maxHeight: 320, overflowY: 'auto', overflowX: 'hidden', paddingRight: 4 }}>
              {allEvents.map((ev, i) => {
                const isCaseEngine = ev._isCaseEngine;
                const color = isCaseEngine
                  ? (ev.setup_type?.includes('LONG') || ev.setup_type?.includes('BULLISH') ? '#4ade80' : '#f87171')
                  : sigColor(ev.setup_type);
                const stars = sigStars(ev.setup_type);
                const label = SETUP_DISPLAY_LABELS[ev.setup_type] || ev.setup_type?.replace(/_/g, ' ') || '';
                const timeDisp = fmtEventTime(ev.fired_time);
                const resColor = isCaseEngine ? outcomeColor(ev._resolution, ev._status) : '#3b82f6';
                const resLabel = isCaseEngine ? outcomeLabel(ev._resolution, ev._status) : null;

                const isWin = ev._resolution === 'TARGET_HIT';
                const isLoss = ev._resolution === 'STOP_HIT';
                const isExpired = ev._resolution === 'TIME_EXPIRED' || ev._resolution === 'SESSION_CLOSED';
                
                const dotColor = isCaseEngine 
                  ? (isWin ? '#22c55e' : isLoss ? '#ef4444' : isExpired ? '#64748b' : '#fbbf24')
                  : color;

                const badgeBg = isWin ? 'rgba(34,197,94,0.12)' : isLoss ? 'rgba(239,68,68,0.12)' : isExpired ? 'rgba(100,116,139,0.12)' : 'rgba(251,191,36,0.12)';
                const badgeBorder = isWin ? 'rgba(34,197,94,0.25)' : isLoss ? 'rgba(239,68,68,0.25)' : isExpired ? 'rgba(100,116,139,0.25)' : 'rgba(251,191,36,0.25)';

                return (
                  <div key={i} style={{ 
                    position: 'relative', 
                    paddingLeft: 18, 
                    paddingBottom: i < allEvents.length - 1 ? 10 : 4,
                  }}>
                    {/* Vertical Track Line */}
                    {i < allEvents.length - 1 && (
                      <div style={{
                        position: 'absolute',
                        left: 4,
                        top: 12,
                        bottom: 0,
                        width: 2,
                        background: 'rgba(51,65,85,0.3)',
                      }} />
                    )}

                    {/* Timeline Dot */}
                    <div style={{
                      position: 'absolute',
                      left: 0,
                      top: 4,
                      width: 10,
                      height: 10,
                      borderRadius: '50%',
                      background: dotColor,
                      boxShadow: `0 0 6px ${dotColor}40`,
                      border: '2px solid #0f172a',
                      zIndex: 2,
                    }} />

                    {/* Card Container */}
                    <div 
                      onClick={() => isCaseEngine
                        ? setSelectedCaseSetup({ type: ev.setup_type, entry: ev._entry, stop: ev._stop, target: ev._t1, fired_time: ev.fired_time, resolution: ev._resolution, status: ev._status, pnl: ev._pnl })
                        : setSelectedSignal(ev)
                      }
                      style={{ 
                        display: 'flex', 
                        flexDirection: 'column', 
                        gap: 2,
                        background: 'rgba(15,23,42,0.4)',
                        border: '1px solid rgba(51,65,85,0.25)',
                        borderRadius: 6,
                        padding: '4px 8px',
                        cursor: 'pointer',
                        transition: 'border-color 0.15s, background 0.15s',
                      }}
                      onMouseEnter={e => {
                        e.currentTarget.style.borderColor = 'rgba(99,102,241,0.35)';
                        e.currentTarget.style.background = 'rgba(15,23,42,0.6)';
                      }}
                      onMouseLeave={e => {
                        e.currentTarget.style.borderColor = 'rgba(51,65,85,0.25)';
                        e.currentTarget.style.background = 'rgba(15,23,42,0.4)';
                      }}
                    >
                      {/* Time & Badges */}
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ fontSize: 12, fontWeight: 600, color: '#cbd5e1', fontFamily: 'monospace' }}>
                            {timeDisp}
                          </span>
                          {ev.fired_time && (() => { const h = parseInt(ev.fired_time.split(':')[0], 10); return (h >= 16 || h < 9 || (h === 9 && parseInt(ev.fired_time.split(':')[1], 10) < 30)); })() && (
                            <span style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', background: 'rgba(148,163,184,0.1)', border: '1px solid rgba(148,163,184,0.2)', borderRadius: 3, padding: '1px 4px', letterSpacing: '0.04em' }}>pre-mkt</span>
                          )}
                          {!isCaseEngine && (
                            <span style={{ fontSize: 11, letterSpacing: '-1px', color: '#cbd5e1' }}>
                              {[1,2,3].map(n => (
                                <span key={n} style={{ color: n <= stars ? color : '#1e293b' }}>★</span>
                              ))}
                            </span>
                          )}
                          {isCaseEngine && ev._winRate != null && ev._sessions >= 20 && (
                            <span style={{ fontSize: 11, fontWeight: 600, color: '#94a3b8' }}>
                              · {Math.round(ev._winRate * 100)}% <span style={{ fontWeight: 400, color: '#94a3b8' }}>N={ev._sessions}</span>
                            </span>
                          )}
                        </div>
                        {resLabel && (
                          <span style={{
                            fontSize: 11,
                            fontWeight: 700,
                            color: resColor,
                            background: badgeBg,
                            border: `1px solid ${badgeBorder}`, 
                            borderRadius: 4, 
                            padding: '1px 4px',
                            letterSpacing: '0.02em'
                          }}>
                            {resLabel}
                          </span>
                        )}
                      </div>

                      {/* Setup Details */}
                      <div style={{ display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', gap: 5 }}>
                        <span style={{ fontSize: 11, fontWeight: 700, color: color, letterSpacing: '0.01em' }}>
                          {label}
                        </span>
                        {isCaseEngine && ev._entry && (
                          <span style={{ fontSize: 12, color: '#cbd5e1', fontFamily: 'monospace' }}>
                            @ {Math.round(parseFloat(ev._entry)).toLocaleString()}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
              {allEvents.length === 0 && (
                <div style={{ fontSize: 12, color: '#94a3b8', fontStyle: 'italic', padding: '4px 0' }}>No signals yet today</div>
              )}
            </div>
          </div>
        );
      })()}

      {/* Signal detail modal */}
      {selectedSignal && <SetupEventModal event={selectedSignal} onClose={() => setSelectedSignal(null)} />}
      {selectedCaseSetup && <CaseSetupDetailModal setup={selectedCaseSetup} onClose={() => setSelectedCaseSetup(null)} />}

      {/* Eval Progress */}
      {evalProgress?.accounts?.length > 0 && (
        <div style={{ borderTop: '1px solid rgba(51,65,85,0.5)', paddingTop: 8 }}>
          <div style={{ fontSize: 12, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>Eval Progress</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {evalProgress.accounts.map(acct => {
              const currentPnl = acct.current_pnl ?? 0;
              const profitNeeded = acct.profit_needed ?? 0;
              const daysTraded = acct.days_traded ?? 0;
              const isNeg = currentPnl < 0;
              const pnlStr = isNeg ? `-$${Math.abs(Math.round(currentPnl))}` : `+$${Math.round(currentPnl)}`;
              const pctDone = Math.max(0, Math.min(100, (currentPnl / 3000) * 100));
              const accent = acct.dll_risk ? '#ef4444' : isNeg ? '#f87171' : acct.on_track ? '#22c55e' : '#f59e0b';
              const cardBg = acct.dll_risk ? 'rgba(239,68,68,0.06)' : 'rgba(30,41,59,0.5)';
              const tagBg  = acct.dll_risk ? 'rgba(239,68,68,0.18)' : isNeg ? 'rgba(248,113,113,0.12)' : 'rgba(245,158,11,0.12)';
              const tagBorder = acct.dll_risk ? 'rgba(239,68,68,0.5)' : isNeg ? 'rgba(248,113,113,0.3)' : 'rgba(245,158,11,0.3)';
              return (
                <div key={acct.account_id} style={{ background: cardBg, border: `1px solid ${acct.dll_risk ? 'rgba(239,68,68,0.25)' : 'rgba(51,65,85,0.4)'}`, borderRadius: 6, padding: '7px 9px' }}>
                  {/* Row 1: account · P&L · tag */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', fontFamily: 'monospace', flex: '0 0 auto' }}>{acct.short_id}</span>
                    <span style={{ fontSize: 12, fontWeight: 800, color: accent, fontFamily: 'monospace', flex: '0 0 auto' }}>{pnlStr}</span>
                    <span style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 700, color: accent, background: tagBg, border: `1px solid ${tagBorder}`, borderRadius: 3, padding: '1px 5px', letterSpacing: '0.04em', whiteSpace: 'nowrap' }}>
                      {acct.trajectory}
                    </span>
                  </div>
                  {/* Row 2: progress bar */}
                  <div style={{ height: 4, background: 'rgba(51,65,85,0.7)', borderRadius: 2, overflow: 'hidden', marginBottom: 4 }}>
                    <div style={{ width: `${pctDone}%`, height: '100%', background: accent, borderRadius: 2, transition: 'width 0.4s', opacity: 0.85 }} />
                  </div>
                  {/* Row 3: needs · days */}
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: 12, color: '#94a3b8' }}>${Math.round(profitNeeded).toLocaleString()} to pass</span>
                    <span style={{ fontSize: 12, color: '#94a3b8' }}>{daysTraded}d traded</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Session Status */}
      <div style={{ fontSize: 11, color: sessionColor, fontWeight: isOpen ? 600 : 400, display: 'flex', alignItems: 'center', gap: 5 }}>
        {isOpen && <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#22c55e', animation: 'pulse 2s infinite', flexShrink: 0 }} />}
        {sessionLabel}
      </div>

    </div>
  );
}

// ==================== LIVE READ PANEL (Phase 2) ====================
// Renders /api/case output. Polls every 10s + socket events.
// Direction: teal = LONG, coral = SHORT. NOT green-for-everything.
const LR_TEAL  = '#2dd4bf';
const LR_CORAL = '#fb923c';
const LR_AMBER = '#f59e0b';
const LR_SLATE = '#94a3b8';

const dirClr = (dir) => dir === 'LONG' ? LR_TEAL : dir === 'SHORT' ? LR_CORAL : dir === 'NO ACD' ? '#fbbf24' : LR_SLATE;
const DT_STYLE = {
  BALANCE:   { color: LR_AMBER,  bg: 'rgba(245,158,11,0.07)',    border: 'rgba(245,158,11,0.35)' },
  TREND:     { color: '#818cf8', bg: 'rgba(129,140,248,0.07)',   border: 'rgba(129,140,248,0.30)' },
  TURBULENT: { color: '#94a3b8', bg: 'rgba(148,163,184,0.06)',   border: 'rgba(148,163,184,0.22)' },
  FORMING:   { color: LR_SLATE,  bg: 'rgba(30,41,59,0.30)',      border: 'rgba(51,65,85,0.40)' },
};

// Live day-type reassessment — shows whether the static (10:05) read has
// since been reassessed, with the evidence that triggered it, framed as
// provisional. Read-only / additive (server/services/dayTypeReassessmentService.js).
function DayTypeReassessmentBanner({ reassessment, compact = false }) {
  if (!reassessment) return null;
  const { reassessments = [], provisional, limitation } = reassessment;
  const latest = reassessments[reassessments.length - 1];

  return (
    <div style={{ marginTop: 8 }}>
      {latest && (
        <div style={{
          fontSize: compact ? 11 : 13, color: '#a5b4fc', lineHeight: 1.45,
          background: 'rgba(129,140,248,0.10)', border: '1px solid rgba(129,140,248,0.30)',
          borderRadius: 5, padding: compact ? '5px 8px' : '7px 10px', marginBottom: 6,
        }}>
          <span style={{ fontWeight: 700, color: '#818cf8' }}>↻ {latest.message}</span>
          {reassessments.length > 1 && (
            <div style={{ marginTop: 3, fontSize: 11, color: '#818cf8', opacity: 0.75 }}>
              ({reassessments.length} reassessments this session: {reassessments.map(r => `${r.from}→${r.to}@${r.time}`).join(', ')})
            </div>
          )}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: compact ? 10 : 11, color: provisional ? LR_AMBER : '#94a3b8' }}>
        <span style={{
          fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase',
          padding: '1px 5px', borderRadius: 3,
          background: provisional ? 'rgba(245,158,11,0.15)' : 'rgba(100,116,139,0.15)',
          border: `1px solid ${provisional ? 'rgba(245,158,11,0.35)' : 'rgba(100,116,139,0.30)'}`,
        }}>
          {provisional ? 'LIVE · PROVISIONAL' : 'FINAL'}
        </span>
        <span>{provisional ? 'Can still change' : 'Final read'}</span>
        {provisional && limitation && <InfoTooltip text={limitation} />}
      </div>
    </div>
  );
}

import { useLiveCase, CaseContext, CaseProvider } from './components/shared/CaseContext.jsx';

// Shared detail content for the Day / Case / Trigger / Levels reads — single
// source of truth so the sidebar (LiveReadPanel) and Morning Prep
// (DashboardCardGrid) modals show identical content derived from one `c`.
const MODAL_TITLES = {
  day: 'The Day', case: 'The Case', trigger: 'The Trigger',
  levels: 'Key Levels', playbooks: 'Regime Playbook Directory', structure: 'Structure',
  trades: 'Trade Timeline', setups: 'Setup Timeline', autocompute: 'Auto-Compute',
};

// ==================== SIDEBAR ====================
function SidebarVerdictChip() {
  const [verdict,    setVerdict]    = React.useState(null);
  const [verdictDir, setVerdictDir] = React.useState(null);
  const [pulse,      setPulse]      = React.useState(null);
  const [open,       setOpen]       = React.useState(false);

  React.useEffect(() => {
    const load = () =>
      fetch(`${API_URL}/market/pulse`).then(r => r.json())
        .then(d => { setVerdict(d.verdict ?? null); setVerdictDir(d.verdictDir ?? null); setPulse(d); })
        .catch(() => {});
    load();
    const iv = setInterval(load, 30000);
    return () => clearInterval(iv);
  }, []);

  if (!verdict) return null;
  const color = verdict === 'ENGAGE' ? '#4ade80' : verdict === 'STAND_ASIDE' ? '#f87171' : '#94a3b8';
  const label = verdict === 'ENGAGE'
    ? `⚡ ENGAGE${verdictDir === 'LONG' ? ' ↑' : verdictDir === 'SHORT' ? ' ↓' : ''}`
    : verdict === 'STAND_ASIDE' ? '⏸ STAND ASIDE' : '◌ WAIT';

  const CONTEXT = {
    ENGAGE: {
      headline: verdictDir === 'LONG' ? 'System GO — lean long' : verdictDir === 'SHORT' ? 'System GO — lean short' : 'System GO — take quality setups',
      body: 'Fires in any direction — long, short, or balance-day flow. Three paths trigger it: (1) a setup is live and active right now; (2) A+C both confirmed with non-quiet delta; (3) no named setup but delta is HIGH and range is expanding. On balance days with no A signal, path 3 is how ENGAGE fires — strong institutional flow is enough.',
      note: 'Reassesses every 30s. Flips to WAIT when the active setup expires or is invalidated. Flips to STAND ASIDE if the cascade breaker trips or after 3:30 PM with nothing live.',
    },
    STAND_ASIDE: {
      headline: 'Stand aside — edge is off',
      body: 'Something broke the system filter: cascade breaker is active (too many levels stopped out in a short window — tape is trending against fades), or it\'s after 3:30 PM with no live setup. Taking fades now means fighting the tape with no system backing.',
      note: 'Reassesses every 30s. Returns to WAIT or ENGAGE when cascade expires or a new setup fires.',
    },
    WAIT: {
      headline: 'Wait — no conviction yet',
      body: 'Monitoring, but no trigger yet. Typical reasons: IB still forming, A signal pending, delta is moderate (not HIGH), or a setup fired and resolved and nothing new has appeared. This is not a "no trade" signal — it means no system-backed edge right now.',
      note: 'Reassesses every 30s. Moves to ENGAGE the moment a setup fires, A+C confirm, or delta becomes HIGH with range expansion.',
    },
  };
  const ctx = CONTEXT[verdict] || CONTEXT.WAIT;

  return (
    <div style={{ position: 'relative' }}>
      <div
        onClick={() => setOpen(o => !o)}
        style={{ padding: '7px 10px', borderRadius: 5, background: `${color}11`, border: `1px solid ${open ? color + '66' : color + '33'}`, display: 'flex', justifyContent: 'center', cursor: 'pointer', transition: 'border-color 0.15s' }}
      >
        <span style={{ fontSize: 13, fontWeight: 800, color, letterSpacing: '0.06em', textTransform: 'uppercase' }}>{label}</span>
      </div>
      {open && (
        <div style={{ marginTop: 4, padding: '10px 12px', background: '#111827', border: `1px solid ${color}33`, borderRadius: 6, fontSize: 12 }}>
          <div style={{ fontWeight: 700, color, marginBottom: 5, fontSize: 13 }}>{ctx.headline}</div>
          <div style={{ color: '#cbd5e1', lineHeight: 1.6, marginBottom: 6 }}>{ctx.body}</div>
          {pulse?.setupCount != null && (
            <div style={{ display: 'flex', gap: 12, marginBottom: 6 }}>
              <span style={{ color: '#94a3b8', fontSize: 11 }}>Active setups: <strong style={{ color: '#e2e8f0' }}>{pulse.setupCount}</strong></span>
              {pulse.cascadeBreaker?.active && <span style={{ color: '#f87171', fontSize: 11, fontWeight: 700 }}>⛔ Cascade active</span>}
            </div>
          )}
          <div style={{ fontSize: 11, color: '#64748b', borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 6, marginTop: 4, lineHeight: 1.5 }}>{ctx.note}</div>
        </div>
      )}
    </div>
  );
}

function Sidebar({ currentView, setCurrentView, processAlertCount = 0, onOpenQuickStats }) {
  return (
    <aside className="sidebar">
      <div className="logo" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div className="logo-icon">📊</div>
          <h1>Trading Journal</h1>
        </div>
        <button
          onClick={onOpenQuickStats}
          title="Quick Stats search (/ or Ctrl+K)"
          style={{
            background: 'rgba(99,102,241,0.12)', border: '1px solid rgba(99,102,241,0.25)',
            borderRadius: 6, color: '#818cf8', fontSize: 13, cursor: 'pointer',
            padding: '4px 8px', lineHeight: 1, flexShrink: 0,
          }}
        >🔍</button>
      </div>

      <PostLossCooldown />
      <SidebarVerdictChip />
      <ErrorBoundary name="Session Pulse" compact>
        <SessionPulseCard />
      </ErrorBoundary>
      <QuickTradeLog />

      <nav className="nav-menu">
        <button
          className={`nav-item ${currentView === 'acd' ? 'active' : ''}`}
          onClick={() => setCurrentView('acd')}
        >
          <span className="nav-icon">☀️</span>
          <span>Morning Prep</span>
          <NavUpdateDot view="acd" />
        </button>

        <button
          className={`nav-item ${currentView === 'dashboard' ? 'active' : ''}`}
          onClick={() => setCurrentView('dashboard')}
        >
          <span className="nav-icon">📈</span>
          <span>Dashboard</span>
          <NavUpdateDot view="dashboard" />
        </button>

        <button
          className={`nav-item ${currentView === 'backtest' ? 'active' : ''}`}
          onClick={() => setCurrentView('backtest')}
        >
          <span className="nav-icon">🔬</span>
          <span>Edge</span>
        </button>

        <button
          className={`nav-item ${currentView === 'all-trades' || currentView === 'calendar' ? 'active' : ''}`}
          onClick={() => setCurrentView('calendar')}
        >
          <span className="nav-icon">📋</span>
          <span>Trades</span>
        </button>

        <button
          className={`nav-item ${currentView === 'settings' ? 'active' : ''}`}
          onClick={() => setCurrentView('settings')}
        >
          <span className="nav-icon">⚙️</span>
          <span>Settings</span>
          {processAlertCount > 0 && (
            <span style={{ marginLeft: 'auto', background: '#ef4444', color: '#fff', borderRadius: 10, padding: '1px 7px', fontSize: 11, fontWeight: 700, lineHeight: 1.4 }}>
              {processAlertCount}
            </span>
          )}
        </button>
      </nav>

      <ErrorBoundary name="Live Session">
        <LiveSessionPanel />
      </ErrorBoundary>
      <SystemHealthSummary onNavigate={setCurrentView} />
    </aside>
  );
}

// ==================== CALENDAR VIEW ====================

// ==================== ANALYSIS VIEW ====================

// ==================== SETTINGS VIEW ====================
// ── Process Health Dashboard ──────────────────────────────────────────────────


export default App;
