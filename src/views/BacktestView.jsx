import React, { useState, useEffect, useMemo, useRef, useCallback, Suspense, lazy } from 'react';
import { formatNumber, fmtP } from '../utils/format.js';
import { PlaybookWeeklyPatternsSection, ImprovementsBacklogSection, default as PlaybookPage } from './PlaybookView.jsx';
import SetupHistoryView from './SetupHistoryView.jsx';
import AlphaEngineOverview from '../components/dashboard/AlphaEngineOverview.jsx';
import SetupReferenceView from '../components/dashboard/SetupReferenceView.jsx';
import ResearchLedgerView from '../components/dashboard/ResearchLedgerView.jsx';
import ScenarioTesterView from './ScenarioTesterView.jsx';
const RiskView = lazy(() => import('./RiskView.jsx'));
import {
  LineChart, Line, BarChart, Bar, AreaChart, Area, ComposedChart, Scatter,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceLine,
} from 'recharts';

import { API_URL } from '../constants/api.js';

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
  const c = pValue < 0.001 ? '#10b981' : pValue < 0.01 ? '#34d399' : pValue < 0.05 ? '#f59e0b' : '#64748b';
  return <span style={{ fontSize: 11, color: c, marginLeft: 3, letterSpacing: '0.05em' }}>{sig}</span>;
}

function KlMfeBar({ mfe, mae, tradeAvgPnl, tradeMfeAvailP50 }) {
  if (!mfe) return null;
  const max = Math.max(mfe.p90 || 0, 40);
  const pctW = v => v != null ? `${Math.min(100, (v / max) * 100).toFixed(1)}%` : '0%';
  return (
    <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--border-color)' }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 8 }}>Bounce Distribution (MFE)</div>
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
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
        <span style={{ color: 'rgba(99,102,241,0.9)' }}>P25 <b style={{ color: 'var(--text-secondary)' }}>{mfe.p25}pt</b></span>
        <span>P50 <b style={{ color: '#a78bfa', fontSize: 13 }}>{mfe.p50}pt</b></span>
        <span>P75 <b style={{ color: 'var(--text-secondary)' }}>{mfe.p75}pt</b></span>
        <span>P90 <b style={{ color: 'var(--text-secondary)' }}>{mfe.p90}pt</b></span>
        {tradeAvgPnl != null && <span style={{ color: '#f59e0b' }}>Your avg <b>{tradeAvgPnl}pt</b></span>}
      </div>
      {mae && (
        <>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4, marginTop: 4 }}>Adverse Excursion (MAE — stop guidance)</div>
          <div style={{ display: 'flex', gap: 16, fontSize: 13, color: 'var(--text-muted)' }}>
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
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 8 }}>Touches by Hour</div>
      <div style={{ display: 'flex', gap: 3, alignItems: 'flex-end', height: 50 }}>
        {byHour.map(h => {
          const barH = Math.max(4, (h.touches / maxTouches) * 44);
          const rr = h.respectRate;
          const col = rr == null ? '#64748b' : rr >= 65 ? 'var(--accent-green)' : rr >= 45 ? '#f59e0b' : 'var(--accent-red)';
          return (
            <div key={h.hour} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}
              title={`${h.label} — ${h.touches} touches, ${rr ?? '—'}% resp, MFE P50 ${h.mfe_p50 ?? '—'}pt`}>
              <div style={{ width: '100%', height: barH, background: col, opacity: 0.7, borderRadius: '2px 2px 0 0', minHeight: 4 }} />
              <div style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{h.label.replace(':00','')}</div>
            </div>
          );
        })}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>Bar height = touch count · color = respect rate</div>
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
          <div style={{ fontSize: 13, color: side === 'support' ? 'var(--accent-green)' : 'var(--accent-red)', marginTop: 2 }}>
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
      <div style={{ padding: '8px 18px', borderBottom: '1px solid var(--border-color)', fontSize: 13, color: 'var(--text-muted)', flexShrink: 0 }}>
        {sorted.length} days · <span style={{ color: 'var(--accent-purple)' }}>click a date</span> to view chart
        {sideData?.timeToPeak?.p50 != null && (
          <span style={{ marginLeft: 12, color: 'var(--text-secondary)' }}>
            Typical peak: <b style={{ color: '#a78bfa' }}>{sideData.timeToPeak.p50} bars</b> ({sideData.timeToPeak.p25}–{sideData.timeToPeak.p75})
          </span>
        )}
      </div>
      <div style={{ overflowY: 'auto', flex: 1 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
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
                  <td style={{ padding: '6px 8px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>{d.levelPrice ?? '—'}</td>
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
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Condition Breakdown — 6 Significant Levels
        </span>
        <div style={{ display: 'flex', gap: 6, marginLeft: 8 }}>
          {KL_CONDITION_DIMS.map(d => (
            <button key={d.key} onClick={() => setDim(d.key)}
              style={{ fontSize: 13, padding: '3px 10px', borderRadius: 5, cursor: 'pointer',
                border: `1px solid ${dim === d.key ? '#a78bfa' : 'var(--border-color)'}`,
                background: dim === d.key ? 'rgba(167,139,250,0.15)' : 'transparent',
                color: dim === d.key ? '#a78bfa' : 'var(--text-muted)', fontWeight: dim === d.key ? 700 : 400 }}>
              {d.label}
            </button>
          ))}
        </div>
        <span style={{ fontSize: 13, color: '#94a3b8', marginLeft: 4 }}>{dimConfig?.hint}</span>
      </div>

      {/* Matrix table */}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: 'rgba(255,255,255,0.04)', borderBottom: '1px solid var(--border-color)' }}>
              <th style={{ padding: '8px 12px', textAlign: 'left', color: 'var(--text-muted)', fontWeight: 600, whiteSpace: 'nowrap', width: 160 }}>Condition</th>
              {KL_SIG_LEVELS.map(lv => {
                const lvData = byLevel.find(l => l.key === lv.key);
                const sd = lvData?.[lv.side];
                return (
                  <th key={`${lv.key}-${lv.side}`} style={{ padding: '8px 8px', textAlign: 'center', color: 'var(--text-secondary)', fontWeight: 600, whiteSpace: 'nowrap', fontSize: 13 }}>
                    <div>{lv.shortLabel}</div>
                    <div style={{ fontSize: 13, color: 'var(--text-muted)', fontWeight: 400 }}>
                      {sd?.touches ?? '—'} total · {sd?.respectRate ?? '—'}%
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {allGroups.length === 0 ? (
              <tr><td colSpan={7} style={{ padding: 16, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>No data for this dimension</td></tr>
            ) : allGroups.map((group, gi) => (
              <tr key={group} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', background: gi % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)' }}>
                <td style={{ padding: '9px 12px', color: 'var(--text-primary)', fontWeight: 600, whiteSpace: 'nowrap' }}>
                  {formatLabel(group)}
                </td>
                {KL_SIG_LEVELS.map(lv => {
                  const lvData = byLevel.find(l => l.key === lv.key);
                  const v = lvData?.[lv.side]?.conditionBreakdown?.[dim]?.[group];
                  if (!v || v.touches < 3) {
                    return <td key={`${lv.key}-${lv.side}`} style={{ padding: '9px 8px', textAlign: 'center', color: '#94a3b8' }}>—</td>;
                  }
                  const rr = v.respectRate ?? 0;
                  const col = rateColor(rr);
                  const limited = v.touches < 20;
                  const sig = v.pValue != null && v.pValue < 0.05;
                  return (
                    <td key={`${lv.key}-${lv.side}`} style={{ padding: '9px 8px', textAlign: 'center' }}>
                      <div style={{ fontWeight: 700, color: col, fontSize: 13 }}>{rr}%</div>
                      <div style={{ fontSize: 13, color: limited ? '#fbbf24' : '#64748b' }}>
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
      <div style={{ padding: '6px 12px', fontSize: 13, color: '#94a3b8', borderTop: '1px solid var(--border-color)' }}>
        Green ≥55% · Amber 47–55% · Red &lt;38% · ✓ p&lt;0.05 vs random baseline · * fewer than 20 touches
      </div>
    </div>
  );
}

// Expandable condition breakdown panel for a single level+side (kept for row-expand in main table)
function KlCondBreakdown({ sideData, levelLabel, side }) {
  const cd = sideData?.conditionBreakdown;
  if (!cd) return <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: 8 }}>No condition data</div>;
  const baseRate = sideData.randomRate ?? 37;
  const dims = [
    { title: 'NL30 State', key: 'byNL30' }, { title: 'Opening Call', key: 'byOpeningCall' },
    { title: 'Approach Direction', key: 'bySessionDirection' }, { title: 'Time of Touch', key: 'byTouchTime' },
  ];
  const rateColor = (rr) => rr >= 55 ? '#22c55e' : rr >= 47 ? '#f59e0b' : rr < 38 ? '#ef4444' : '#94a3b8';
  return (
    <div style={{ padding: '12px 16px', background: 'rgba(10,15,30,0.9)', borderTop: '1px solid var(--border-color)' }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 10 }}>
        {levelLabel} — {side === 'support' ? 'Support' : 'Resistance'} · Condition Breakdown
        <span style={{ fontSize: 13, color: 'var(--text-muted)', marginLeft: 8, fontWeight: 400 }}>baseline ~{baseRate}%</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        {dims.map(({ title, key }) => {
          const entries = Object.entries(cd[key] || {}).filter(([, v]) => v.touches >= 3);
          if (!entries.length) return null;
          return (
            <div key={key}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#94a3b8', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{title}</div>
              {entries.sort((a, b) => (b[1].respectRate ?? 0) - (a[1].respectRate ?? 0)).map(([cond, v]) => {
                const rr = v.respectRate ?? 0;
                return (
                  <div key={cond} style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0', fontSize: 13, borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                    <span style={{ color: '#94a3b8' }}>{cond.replace(/_/g, ' ').replace(/^(\w)/, c => c.toUpperCase())}</span>
                    <span>
                      <span style={{ fontWeight: 700, color: rateColor(rr), marginRight: 6 }}>{rr}%</span>
                      <span style={{ color: v.touches < 20 ? '#fbbf24' : '#64748b', fontSize: 13 }}>n={v.touches}</span>
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
    <th onClick={() => handleSort(col)} style={{ padding: '8px 10px', textAlign: col === 'label' || col === 'side' ? 'left' : 'right', color: sortCol === col ? 'var(--accent-purple)' : 'var(--text-secondary)', fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap', userSelect: 'none', fontSize: 13, letterSpacing: '0.02em' }}>
      {children}{sortCol === col ? (sortDir === 'desc' ? ' ↓' : ' ↑') : ''}
    </th>
  );

  return (
    <div style={{ padding: '20px 0' }}>
      {/* Controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, color: 'var(--text-muted)', marginRight: 4 }}>Timeframe</span>
        {[...KL_TIMEFRAMES, { id: 'all', label: 'All Time' }].map(t => (
          <button key={t.id} onClick={() => { setTf(t.id); fetchData(t.id, prox); }}
            style={{ fontSize: 13, padding: '4px 12px', borderRadius: 6, cursor: 'pointer',
              border: `1px solid ${tf === t.id ? 'var(--accent-purple)' : 'var(--border-color)'}`,
              background: tf === t.id ? 'rgba(139,92,246,0.15)' : 'transparent',
              color: tf === t.id ? 'var(--accent-purple)' : 'var(--text-secondary)',
              fontWeight: tf === t.id ? 700 : 400 }}>
            {t.label}
          </button>
        ))}
        <span style={{ fontSize: 13, color: 'var(--text-muted)', marginLeft: 12, marginRight: 4 }}>Zone ±</span>
        {[5, 10, 15, 20].map(p => (
          <button key={p} onClick={() => { setProx(p); fetchData(tf, p); }}
            style={{ fontSize: 13, padding: '4px 10px', borderRadius: 6, cursor: 'pointer',
              border: `1px solid ${prox === p ? '#6366f1' : 'var(--border-color)'}`,
              background: prox === p ? 'rgba(99,102,241,0.12)' : 'transparent',
              color: prox === p ? '#a78bfa' : 'var(--text-secondary)',
              fontWeight: prox === p ? 700 : 400 }}>
            {p}pt
          </button>
        ))}
        {loading && <span style={{ fontSize: 13, color: 'var(--text-muted)', marginLeft: 8 }}>Loading…</span>}

        {/* Filter toggle */}
        <button onClick={() => setFilterOpen(o => !o)}
          style={{ marginLeft: 'auto', fontSize: 13, padding: '4px 12px', borderRadius: 6, cursor: 'pointer',
            border: `1px solid ${(filterNL30||filterOpenCall||filterSessDir) ? '#f97316' : 'var(--border-color)'}`,
            background: (filterNL30||filterOpenCall||filterSessDir) ? 'rgba(249,115,22,0.1)' : 'transparent',
            color: (filterNL30||filterOpenCall||filterSessDir) ? '#f97316' : 'var(--text-muted)' }}>
          {filterOpen ? '▲' : '▼'} Filter {(filterNL30||filterOpenCall||filterSessDir) ? '●' : ''}
        </button>
      </div>

      {/* Filter panel */}
      {filterOpen && (
        <div style={{ padding: '12px 16px', background: 'rgba(249,115,22,0.05)', border: '1px solid rgba(249,115,22,0.25)', borderRadius: 8, marginBottom: 12, fontFamily: 'Arial, sans-serif' }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#f97316', marginBottom: 10 }}>
            Filter touches by session conditions — find your actual edge when the setup is used correctly
          </div>
          <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div>
              <div style={{ fontSize: 13, color: '#94a3b8', marginBottom: 4 }}>NL30 at time of touch</div>
              <select value={filterNL30} onChange={e => setFilterNL30(e.target.value)}
                style={{ background: 'var(--input-bg)', border: '1px solid var(--border-color)', borderRadius: 5, color: 'var(--text-primary)', fontSize: 13, padding: '4px 8px' }}>
                <option value="">All NL30 states</option>
                <option value="BULLISH">Bullish (NL30 &gt; +9)</option>
                <option value="RANGING">Ranging (-9 to +9)</option>
                <option value="BEARISH">Bearish (NL30 &lt; -9)</option>
              </select>
            </div>
            <div>
              <div style={{ fontSize: 13, color: '#94a3b8', marginBottom: 4 }}>Opening call that session</div>
              <select value={filterOpenCall} onChange={e => setFilterOpenCall(e.target.value)}
                style={{ background: 'var(--input-bg)', border: '1px solid var(--border-color)', borderRadius: 5, color: 'var(--text-primary)', fontSize: 13, padding: '4px 8px' }}>
                <option value="">All opening calls</option>
                <option value="OPEN_DRIVE">Open Drive</option>
                <option value="OPEN_TEST_DRIVE">Open Test Drive</option>
                <option value="OPEN_REJECTION_REVERSE">ORR</option>
                <option value="OPEN_AUCTION">Open Auction</option>
              </select>
            </div>
            <div>
              <div style={{ fontSize: 13, color: '#94a3b8', marginBottom: 4 }}>Session direction</div>
              <select value={filterSessDir} onChange={e => setFilterSessDir(e.target.value)}
                style={{ background: 'var(--input-bg)', border: '1px solid var(--border-color)', borderRadius: 5, color: 'var(--text-primary)', fontSize: 13, padding: '4px 8px' }}>
                <option value="">All session directions</option>
                <option value="UP">Up day (&gt;+20pts)</option>
                <option value="DOWN">Down day (&lt;-20pts)</option>
                <option value="RANGE">Range day</option>
              </select>
            </div>
            <button onClick={() => fetchData(tf, prox, { nl30: filterNL30, openCall: filterOpenCall, sessDir: filterSessDir })}
              style={{ padding: '5px 16px', fontSize: 13, borderRadius: 5, cursor: 'pointer', border: '1px solid #f97316', background: 'rgba(249,115,22,0.15)', color: '#f97316', fontWeight: 700 }}>
              Apply filters
            </button>
            {(filterNL30||filterOpenCall||filterSessDir) && (
              <button onClick={() => { setFilterNL30(''); setFilterOpenCall(''); setFilterSessDir(''); fetchData(tf, prox, { nl30:'', openCall:'', sessDir:'' }); }}
                style={{ padding: '5px 12px', fontSize: 13, borderRadius: 5, cursor: 'pointer', border: '1px solid var(--border-color)', background: 'transparent', color: 'var(--text-muted)' }}>
                Clear
              </button>
            )}
          </div>
          <div style={{ marginTop: 8, fontSize: 13, color: '#94a3b8', fontStyle: 'italic' }}>
            Goal: find conditions where IB High resistance exceeds 60% (vs 44.5% unfiltered). Filtered sets will have fewer touches — flag shown when N &lt; 30.
          </div>
        </div>
      )}

      {!loading && data && (
        <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>
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
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: 'rgba(255,255,255,0.06)', borderBottom: '2px solid var(--border-color)' }}>
                  <SortHd col="label">Level</SortHd>
                  <SortHd col="side">Side</SortHd>
                  <th style={{ padding: '8px 10px', textAlign: 'left', color: 'var(--text-secondary)', fontWeight: 600, fontSize: 13 }}>Group</th>
                  <SortHd col="respectRate">Respect %</SortHd>
                  <SortHd col="touches">Touches</SortHd>
                  <SortHd col="mfe"><span title="Max Favorable Excursion — median points the move went in your favor over the next 60 bars after touching the level. Use as a guide for take profit placement.">MFE P50 ⓘ</span></SortHd>
                  <th style={{ padding: '8px 10px', textAlign: 'right', color: 'var(--text-muted)', fontWeight: 500, fontSize: 13, whiteSpace: 'nowrap' }} title="75% of touches saw at least this much favorable move — a conservative take profit target.">MFE P75 ⓘ</th>
                  <SortHd col="mae"><span title="Max Adverse Excursion — median points price moved against you within the same 60-bar window. Use as a guide for stop placement — your stop should absorb at least this much heat.">MAE P50 ⓘ</span></SortHd>
                  <th style={{ padding: '8px 10px', textAlign: 'right', color: 'var(--text-muted)', fontWeight: 500, fontSize: 13 }}>Trades</th>
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
                            style={{ marginRight: 6, background: 'none', border: 'none', cursor: 'pointer', color: isExpanded ? '#a78bfa' : '#64748b', fontSize: 13, padding: '1px 3px', lineHeight: 1 }}
                            title="Show condition breakdown">
                            {isExpanded ? '▼' : '▶'}
                          </button>
                        )}
                        <span onClick={() => clickable && openDetail(r.key, r.label, r.side, sd)} style={{ cursor: clickable ? 'pointer' : 'default' }}>{r.label}</span>
                      </td>
                      <td style={{ padding: '8px 10px', color: isSupport ? 'var(--accent-green)' : 'var(--accent-red)', fontWeight: 600, whiteSpace: 'nowrap' }}>
                        {isSupport ? '↓ Support' : '↑ Resistance'}
                      </td>
                      <td style={{ padding: '8px 10px', color: 'var(--text-muted)', fontSize: 13 }}>{r.group}</td>
                      <td style={{ padding: '8px 10px', textAlign: 'right' }}>
                        <span style={{ color: edgeCol, fontWeight: 700 }}>{sd.respectRate}%</span>
                        <KlSigBadge pValue={sd.pValue} />
                      </td>
                      <td style={{ padding: '8px 10px', textAlign: 'right', color: sd.touches < 30 && (filterNL30||filterOpenCall||filterSessDir) ? '#fbbf24' : 'var(--text-secondary)' }}>
                        {sd.touches}{sd.touches < 30 && (filterNL30||filterOpenCall||filterSessDir) && <span style={{ fontSize: 11, color: '#fbbf24', marginLeft: 3 }}>limited</span>}
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
              <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: '0.05em', textTransform: 'uppercase' }}>Confluence Score Validation</span>
              <span style={{ fontSize: 13, color: '#94a3b8' }}>— does higher confluence predict better level respect? (6 primary levels combined)</span>
            </div>
            <span style={{ color: '#94a3b8', fontSize: 13 }}>{showCombinedConf ? '▲' : '▼'}</span>
          </button>
          {showCombinedConf && (
            <div style={{ padding: '0 14px 14px' }}>
              <div style={{ fontSize: 13, color: '#94a3b8', marginBottom: 10, lineHeight: 1.5 }}>
                Source: <code>daily_performance_log.confluence_score_pre</code> (0–3 scale) matched by session date.
                If higher scores predict stronger level respect, the framework is validated. If flat, confluence needs recalibration.
                Note: only sessions since Nov 2024 have scores — earlier touches show as no-data.
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
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
      <ChartModalOverlay chartModal={chartModal} setChartModal={setChartModal} selectedAccounts={selectedAccounts} />
    </div>
  );
}

// Shared "click a date -> see the chart" modal overlay — was hand-duplicated inline inside
// KeyLevelBT only; factored out 2026-07-28 so Setup Reference's own date links (which used
// to navigate away to the Chart Review tab, losing your place in the table — a real
// complaint) can open the exact same true modal instead of a second, reimplemented copy.
// chartModal shape: { date, dates (sorted newest-first), levelKey (nullable) } | null.
function ChartModalOverlay({ chartModal, setChartModal, selectedAccounts }) {
  if (!chartModal) return null;
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
          <span style={{ fontSize: 13, color: 'var(--text-muted)', marginLeft: 2 }}>{idx + 1} / {dates.length}</span>
          <button onClick={() => setChartModal(null)} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 18, cursor: 'pointer', padding: '2px 6px', lineHeight: 1 }}>✕</button>
        </div>
        <div style={{ overflow: 'auto', flex: 1 }}>
          <ChartReviewSection selectedAccounts={selectedAccounts} initialDate={date} initialLevelKey={chartModal.levelKey} />
        </div>
      </div>
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
              style={{ fontSize: 13, padding: '4px 10px', borderRadius: 6, cursor: 'pointer',
                border: `1px solid ${chartTimeRange === tr.id ? 'var(--accent-purple)' : 'var(--border-color)'}`,
                background: chartTimeRange === tr.id ? 'rgba(139,92,246,0.15)' : 'var(--card-bg)',
                color: chartTimeRange === tr.id ? 'var(--accent-purple)' : 'var(--text-secondary)' }}>
              {tr.label}
            </button>
          ))}
        </div>

        {chartZoomRange && (
          <button onClick={() => setChartZoomRange(null)}
            style={{ fontSize: 13, padding: '4px 10px', borderRadius: 6, cursor: 'pointer',
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
            <label key={grp} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13, cursor: 'pointer' }}>
              <input type="checkbox" checked={allOn} onChange={e => setChartVisibleLevels(prev => {
                const next = { ...prev };
                grpKeys.forEach(k => { next[k] = e.target.checked; });
                return next;
              })} style={{ accentColor: Object.values(LEVEL_CONFIG).find(c => c.group === grp)?.color }} />
              <span style={{ color: Object.values(LEVEL_CONFIG).find(c => c.group === grp)?.color }}>{grp}</span>
            </label>
          );
        })}
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13, cursor: 'pointer' }}>
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
                  <text x={-6} y={yScale(p) + 4} textAnchor="end" fill="#64748b" fontSize={10}>{p}</text>
                </g>
              ))}

              {/* X axis labels */}
              {xLabels.map(({ x, label }, i) => (
                <text key={i} x={x} y={iH + 22} textAnchor="middle" fill="#64748b" fontSize={10}>{label}</text>
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
                    <text x={iW + 6} y={y + 10} fill={cfg.color} fontSize={9} opacity={0.7}>{fmtP(price, 2)}</text>
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
                      fill={isPoc ? '#f59e0b' : isVa ? '#6366f1' : '#94a3b8'}
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
                        fill={col} fontSize={8}>{fmtP(t.entryPrice)}</text>
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
                const pnlStr = `${ht.pnl >= 0 ? '+' : ''}$${fmtP(ht.pnl, 2)}`;
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
                  stroke="#64748b" strokeWidth={0.75} />
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
                    <text x={bx+8} y={35} fill={col} fontSize={10}>O {fmtP(+hoverBar.open, 2)}  H {fmtP(+hoverBar.high, 2)}  L {fmtP(+hoverBar.low, 2)}  C {fmtP(+hoverBar.close, 2)}</text>
                    <text x={bx+8} y={50} fill="#94a3b8" fontSize={9}>Vol {hoverBar.volume?.toLocaleString()}</text>
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
            {ibType && <span style={{ fontSize: 13, padding: '3px 10px', borderRadius: 20, background: 'var(--card-bg)', border: '1px solid var(--border-color)', color: 'var(--text-secondary)' }}>IB Range: {fmtP(l?.ibRange)} pts — {ibType}</span>}
            {gapStr && <span style={{ fontSize: 13, padding: '3px 10px', borderRadius: 20, background: 'var(--card-bg)', border: '1px solid var(--border-color)', color: l.gap > 3 ? 'var(--accent-green)' : l.gap < -3 ? 'var(--accent-red)' : 'var(--text-secondary)' }}>{gapStr} from prior close</span>}
            {l.pdClose != null && <span style={{ fontSize: 13, padding: '3px 10px', borderRadius: 20, background: 'var(--card-bg)', border: '1px solid var(--border-color)', color: 'var(--text-muted)' }}>Prior Close: {fmtP(l.pdClose, 2)}</span>}
          </div>
        );
      })()}

      {/* Trade list for day */}
      {dayTrades.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 13, color: 'var(--text-muted)', fontWeight: 600, marginBottom: 6 }}>{dayTrades.length} TRADES — {chartDate}</div>
          <div style={{ background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderRadius: 8, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
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
                        <span style={{ fontSize: 13, padding: '2px 7px', borderRadius: 10, fontWeight: 600, letterSpacing: '0.02em',
                          background: isLive ? 'rgba(16,185,129,0.12)' : 'rgba(100,116,139,0.15)',
                          color: isLive ? 'var(--accent-green)' : 'var(--text-muted)',
                          border: `1px solid ${isLive ? 'rgba(16,185,129,0.3)' : 'rgba(100,116,139,0.3)'}` }}>
                          {acctShort}
                        </span>
                      </td>
                      <td style={{ padding: '6px 10px' }}>{timeStr} @ {fmtP(ep, 2)}</td>
                      <td style={{ padding: '6px 10px', color: 'var(--text-muted)' }}>{fmtP(xp, 2)}</td>
                      <td style={{ padding: '6px 10px', color: pnl >= 0 ? 'var(--accent-green)' : 'var(--accent-red)', fontWeight: 600 }}>${pnl >= 0 ? '+' : ''}{fmtP(pnl, 2)}</td>
                      <td style={{ padding: '6px 10px' }}>
                        {nearLvls.length ? nearLvls.map(l => (
                          <span key={l} style={{ fontSize: 13, padding: '1px 6px', borderRadius: 10, marginRight: 4, background: 'rgba(139,92,246,0.15)', color: 'var(--accent-purple)', border: '1px solid rgba(139,92,246,0.3)' }}>{l}</span>
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
    <th onClick={() => setSortCol(col)} style={{ padding: '7px 10px', textAlign: col === 'label' ? 'left' : 'right', color: sortCol === col ? 'var(--accent-purple)' : 'var(--text-secondary)', fontWeight: 600, cursor: 'pointer', fontSize: 13, whiteSpace: 'nowrap', userSelect: 'none' }}>
      {children}{sortCol === col ? ' ↓' : ''}
    </th>
  );

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 13, color: 'var(--text-muted)', cursor: 'pointer' }}>
          <input type="checkbox" checked={sigOnly} onChange={e => setSigOnly(e.target.checked)} />
          Significant only (p&lt;0.05)
        </label>
        <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>{rows.length} patterns</span>
      </div>
      <div style={{ background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderRadius: 8, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: 'rgba(255,255,255,0.04)', borderBottom: '2px solid var(--border-color)' }}>
                <SH col="label">Pattern</SH>
                <SH col="n">n</SH>
                <SH col="rate">Rate</SH>
                <th style={{ padding: '7px 8px', textAlign: 'right', color: 'var(--text-secondary)', fontWeight: 600, fontSize: 13 }}>Base</th>
                <SH col="edge_abs">Edge</SH>
                <SH col="pval">Sig</SH>
                <th style={{ padding: '7px 10px', textAlign: 'left', color: 'var(--text-secondary)', fontWeight: 600, fontSize: 13 }}>What it means</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p, i) => {
                const e = p.edge;
                const ec = Math.abs(e) >= 20 ? (e > 0 ? 'var(--accent-green)' : 'var(--accent-red)') : Math.abs(e) >= 10 ? '#f59e0b' : 'var(--text-muted)';
                const sb = p.pValue == null ? null : p.pValue < 0.001 ? ['★★★','#10b981'] : p.pValue < 0.01 ? ['★★','#34d399'] : p.pValue < 0.05 ? ['★','#f59e0b'] : ['ns','#64748b'];
                return (
                  <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', background: i%2===0?'transparent':'rgba(255,255,255,0.01)' }}>
                    <td style={{ padding: '8px 10px', fontWeight: 600, color: 'var(--text-primary)' }}>{p.label}</td>
                    <td style={{ padding: '8px 8px', textAlign: 'right', color: 'var(--text-muted)' }}>{p.n}</td>
                    <td style={{ padding: '8px 8px', textAlign: 'right', fontWeight: 700, color: e > 0 ? 'var(--accent-green)' : 'var(--accent-red)' }}>{p.rate}%</td>
                    <td style={{ padding: '8px 8px', textAlign: 'right', color: 'var(--text-muted)' }}>{p.baseline}%</td>
                    <td style={{ padding: '8px 8px', textAlign: 'right', fontWeight: 700, color: ec }}>{e > 0 ? '+' : ''}{e}%</td>
                    <td style={{ padding: '8px 8px', textAlign: 'right' }}>
                      {sb && <span style={{ color: sb[1], fontWeight: 600, fontSize: 13 }}>{sb[0]}</span>}
                    </td>
                    <td style={{ padding: '8px 10px', color: 'var(--text-muted)', fontSize: 13 }}>{p.description}</td>
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
          {ran && <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>{data?.sessions} sessions · {data?.total} patterns tested</span>}
        </div>
      </div>

      {ran && data && (
        <>
          {/* Category tabs */}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
            {['top', ...categories].map(cat => (
              <button key={cat} onClick={() => setView(cat)}
                style={{ fontSize: 13, padding: '4px 12px', borderRadius: 20, border: `1px solid ${view === cat ? 'var(--accent-purple)' : 'var(--border-color)'}`,
                  background: view === cat ? 'rgba(139,92,246,0.15)' : 'transparent',
                  color: view === cat ? 'var(--accent-purple)' : 'var(--text-secondary)',
                  cursor: 'pointer', fontWeight: view === cat ? 700 : 400 }}>
                {cat === 'top' ? '⭐ Top 25' : cat}
              </button>
            ))}
          </div>
          <EdgePatternTable patterns={activePatterns} />

          {/* Legend */}
          <div style={{ marginTop: 16, fontSize: 13, color: 'var(--text-muted)', display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <span><span style={{ color: '#10b981' }}>★★★</span> p&lt;0.001 (very strong)</span>
            <span><span style={{ color: '#34d399' }}>★★</span> p&lt;0.01 (strong)</span>
            <span><span style={{ color: '#f59e0b' }}>★</span> p&lt;0.05 (significant)</span>
            <span><span style={{ color: '#94a3b8' }}>ns</span> not significant</span>
            <span style={{ marginLeft: 8 }}>Edge = actual rate minus 50% baseline. Green = bullish/confirmatory, Red = bearish/counter.</span>
          </div>
        </>
      )}

      {!ran && !loading && (
        <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-muted)', fontSize: 13 }}>
          Click "Run Discovery Analysis" to scan all your NQ bar history.<br /><br />
          <span style={{ fontSize: 13 }}>
            Covers: time-of-day slot bias · opening drive continuation · AM/PM reversal · bid/ask delta ·
            consecutive day sequences · volume patterns · day-of-week tendencies · open position in prior range · volatility expansion cycles
          </span>
        </div>
      )}
    </div>
  );
}


function PerformanceAuditPanel() {
  const [data, setData] = React.useState(null);
  const [sortCol, setSortCol] = React.useState('ev');
  const [sortDir, setSortDir] = React.useState('desc');
  const [expandedRow, setExpandedRow] = React.useState(null);
  const [colOrder, setColOrder] = React.useState(() => {
    try { const saved = localStorage.getItem('perf-audit-col-order'); return saved ? JSON.parse(saved) : null; } catch (_) { return null; }
  });
  const [dragCol, setDragCol] = React.useState(null);
  React.useEffect(() => { if (colOrder) try { localStorage.setItem('perf-audit-col-order', JSON.stringify(colOrder)); } catch(_) {} }, [colOrder]);

  React.useEffect(() => {
    fetch(`${API_URL}/performance-audit/unified`).then(r => r.json()).then(setData).catch(() => {});
  }, []);

  if (!data || !data.setups?.length) return <div style={{ padding: 20, color: '#94a3b8' }}>No audit data yet. Run the comprehensive backtest script first.</div>;

  const handleSort = (col) => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir('desc'); }
  };

  const sorted = [...data.setups].sort((a, b) => {
    // Status groups always take priority: ACTIVE first, CONTEXT second, REMOVED last
    const statusOrder = { ACTIVE: 0, CONTEXT: 1, REMOVED: 2 };
    const sA = statusOrder[a.status] ?? 3, sB = statusOrder[b.status] ?? 3;
    if (sA !== sB) return sA - sB;
    // Within same status group, sort by selected column
    let vA = a[sortCol], vB = b[sortCol];
    if (vA == null) vA = sortDir === 'desc' ? -Infinity : Infinity;
    if (vB == null) vB = sortDir === 'desc' ? -Infinity : Infinity;
    if (typeof vA === 'string') return sortDir === 'asc' ? vA.localeCompare(vB) : vB.localeCompare(vA);
    return sortDir === 'asc' ? vA - vB : vB - vA;
  });

  const fmtPct = v => v != null ? (v * 100).toFixed(1) + '%' : '--';
  const fmtN = v => v != null ? Math.round(v) : '--';
  const fmtDollar = v => v != null ? '$' + Math.round(v).toLocaleString() : '--';

  const statusColor = s => s === 'ACTIVE' ? '#4ade80' : s === 'CONTEXT' ? '#94a3b8' : '#f87171';
  const statusBg = s => s === 'ACTIVE' ? 'rgba(74,222,128,0.1)' : s === 'CONTEXT' ? 'rgba(148,163,184,0.08)' : 'rgba(248,113,113,0.08)';
  const wrColor = v => v != null ? (v >= 0.80 ? '#4ade80' : v >= 0.65 ? '#a3e635' : v >= 0.50 ? '#fbbf24' : '#f87171') : '#94a3b8';
  const evColor = v => v != null ? (v > 20 ? '#4ade80' : v > 0 ? '#a3e635' : v > -10 ? '#fbbf24' : '#f87171') : '#94a3b8';
  const regimeDot = v => v === 'OUTPERFORMING' ? '#4ade80' : v === 'DEGRADING' ? '#f87171' : '#94a3b8';
  const probColor = v => v === 'VERY_HIGH' ? '#4ade80' : v === 'HIGH' ? '#a3e635' : v === 'MEDIUM' ? '#fbbf24' : v === 'LOW' ? '#94a3b8' : '#64748b';
  const probLabel = v => v === 'VERY_HIGH' ? 'V.HIGH' : v || '--';

  const defaultCols = [
    // Identity
    { key: 'name',         label: 'Signal',       w: 120, tip: 'Setup or level fade name. Click row to expand full trading guide.' },
    { key: 'status',       label: 'Status',        w: 56,  tip: 'ACTIVE=backtested positive EV, tradeable. CONTEXT=use for directional lean only. REMOVED=negative EV, cut from system.' },
    // Win rates (grouped: long → medium → short term)
    { key: 'wr',           label: '180d WR',       w: 52,  tip: 'Win rate from 180-day bar-by-bar system backtest. The long-term baseline.' },
    { key: 'wr30d',        label: '30d WR',        w: 52,  tip: 'Win rate over last 30 trading days. Shows if the edge is holding in the current month. Most reliable recent window.' },
    { key: 'wr10d',        label: '10d WR',        w: 52,  tip: 'Win rate over last 10 trading days. Most recent snapshot — small sample, directional only.' },
    { key: 'trend10d',     label: 'Trend',         w: 42,  tip: 'Is the recent 10d WR higher (↑), lower (↓), or flat (→) vs the 180d baseline? ↑ = edge strengthening, ↓ = degrading.' },
    { key: 'stability',    label: 'Stability',     w: 66,  tip: 'Chronological EV-sign stability check (added 2026-07-14): splits this setup\'s full trade history into 3 non-overlapping thirds and checks if EV keeps the same sign in all 3. STABLE = consistent edge. If unstable, classified as DEGRADING (getting worse), IMPROVING (getting better), NOISY (flips but still net-positive both periods), or THIN (not enough recent data to tell). Informational only — does not affect ACTIVE/CONTEXT/REMOVED status above.' },
    // EV
    { key: 'ev',           label: 'EV/Tr',         w: 50,  tip: 'Expected value per trade. Includes $1 commission. Positive = profitable over many trades.' },
    { key: 'totalPnl',     label: 'P&L',           w: 52,  tip: 'Total P&L contribution over 180 days. Shows which levels carry the system vs dead weight.' },
    // Stops & Targets (grouped)
    { key: 'stop',         label: 'Stop',          w: 42,  tip: 'Stop loss in points. Based on P75 MAE from backtest. Gives room for normal noise without exceeding DLL.' },
    { key: 't1',           label: 'T1',            w: 36,  tip: 'First target. Scale half position here. Based on optimal EV sweep from backtest.' },
    { key: 't2',           label: 'T2 Runner',     w: 52,  tip: 'Runner target = P75 MFE. After T1 hit, move stop to breakeven and hold to T2. Winners run past T1 by 6-25pt on average.' },
    // Risk profile (grouped)
    { key: 'mae',          label: 'MAE',           w: 42,  tip: 'Average Max Adverse Excursion. How far the trade typically goes against you before resolving. Lower = cleaner entry.' },
    { key: 'mfe',          label: 'MFE',           w: 42,  tip: 'Average Max Favorable Excursion. How far the trade goes in your favor. Higher = more room for runners.' },
    { key: 'p50mae',       label: 'P50 MAE',      w: 52,  tip: 'Median MAE. 50% of trades see less heat than this. If P50 < Stop, most trades never get close to stopping out.' },
    { key: 'p75mae',       label: 'P75 MAE',      w: 52,  tip: 'P75 MAE. 75% of trades see less heat than this. This is roughly where your stop should be.' },
    // Sample & regime
    { key: 'n',            label: 'N',             w: 30,  tip: 'Sample size (180d). More trades = more confidence. N<20 = directional, N>50 = statistically robust.' },
    { key: 'regimeFit',    label: 'Regime',         w: 52,  tip: 'How this level performs in the CURRENT market regime. OUT=outperforming baseline, DEG=degrading. Updated nightly.' },
    // Live context
    { key: 'frequency',    label: 'Freq',          w: 48,  tip: 'How often this setup fires per trading day on average.' },
    { key: 'distFromPrice',label: 'Dist',          w: 44,  tip: 'How far current price is from this level in points. Green=close, yellow=medium, gray=far.' },
    { key: 'next2DayProb', label: '2d Prob',       w: 48,  tip: 'Probability of touching this level in next 2 days. Based on distance vs ATR(20). V.HIGH=within 0.5 ATR.' },
  ];
  // Merge in any default column keys missing from a saved order — otherwise a newly-added
  // column (like 'stability' added 2026-07-14) would silently never appear for anyone with a
  // previously-saved column order in localStorage, since a saved order fully overrides
  // defaultCols rather than extending it.
  const effectiveColOrder = colOrder
    ? [...colOrder, ...defaultCols.map(c => c.key).filter(k => !colOrder.includes(k))]
    : defaultCols.map(c => c.key);
  const columns = effectiveColOrder.map(k => defaultCols.find(c => c.key === k)).filter(Boolean);

  const thStyle = (col) => ({
    padding: '8px 8px', textAlign: 'left', color: sortCol === col ? '#e2e8f0' : '#94a3b8',
    fontWeight: 700, fontSize: 13, cursor: 'pointer', userSelect: 'none',
    borderBottom: '2px solid #334155', whiteSpace: 'nowrap', letterSpacing: '0.03em',
    textTransform: 'uppercase',
  });

  // Count by status
  const activeCt = data.setups.filter(s => s.status === 'ACTIVE').length;
  const ctxCt = data.setups.filter(s => s.status === 'CONTEXT').length;
  const cutCt = data.setups.filter(s => s.status === 'REMOVED').length;

  return (
    <div style={{ padding: '16px 0' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 18, color: '#e2e8f0', fontWeight: 800 }}>Unified Signal Table</h2>
          <span style={{ fontSize: 11, color: '#94a3b8' }}>
            Last run: {data.runDate} | {activeCt} active, {ctxCt} context, {cutCt} cut | Click headers to sort
          </span>
        </div>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
          {data.currentPrice && (
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 12, color: '#94a3b8', textTransform: 'uppercase', fontWeight: 700 }}>NQ Price</div>
              <div style={{ fontSize: 16, fontWeight: 900, fontFamily: 'monospace', color: '#e2e8f0' }}>{Math.round(data.currentPrice).toLocaleString()}</div>
            </div>
          )}
          {data.atr20 && (
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 12, color: '#94a3b8', textTransform: 'uppercase', fontWeight: 700 }}>ATR(20)</div>
              <div style={{ fontSize: 16, fontWeight: 900, fontFamily: 'monospace', color: '#94a3b8' }}>{data.atr20}</div>
            </div>
          )}
          {data.currentRegime && (
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 12, color: '#94a3b8', textTransform: 'uppercase', fontWeight: 700 }}>Regime</div>
              <div style={{ fontSize: 11, fontWeight: 700, fontFamily: 'monospace', color: '#94a3b8' }}>
                {data.currentRegime.vol} / {data.currentRegime.dir} / {data.currentRegime.range}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* System Summary Banner */}
      {data.systemSummary && (
        <div style={{ padding: '10px 14px', background: 'rgba(139,92,246,0.06)', border: '1px solid rgba(139,92,246,0.15)', borderRadius: 6, marginBottom: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 12, fontWeight: 800, color: '#a78bfa', letterSpacing: '0.05em' }}>SYSTEM TOTAL</span>
            <div style={{ display: 'flex', gap: 20, alignItems: 'center' }}>
              <span style={{ fontSize: 11, color: '#94a3b8' }}>{data.systemSummary.totalTrades} trades</span>
              <span style={{ fontSize: 11, color: '#94a3b8' }}>{fmtPct(data.systemSummary.wr)} WR</span>
              <span style={{ fontSize: 11, color: '#94a3b8' }}>{fmtDollar(data.systemSummary.ev)}/trade</span>
              <span style={{ fontSize: 16, fontWeight: 900, fontFamily: 'monospace', color: '#4ade80' }}>{fmtDollar(data.systemSummary.totalPnl)}</span>
            </div>
          </div>
          {data.systemSummary.notes && (
            <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 4 }}>{data.systemSummary.notes}</div>
          )}
        </div>
      )}

      {/* Unified Table */}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr>
              {columns.map((c, ci) => (
                <th key={c.key}
                  draggable
                  onDragStart={() => setDragCol(ci)}
                  onDragOver={e => e.preventDefault()}
                  onDrop={() => {
                    if (dragCol == null || dragCol === ci) return;
                    const newOrder = [...effectiveColOrder];
                    const [moved] = newOrder.splice(dragCol, 1);
                    newOrder.splice(ci, 0, moved);
                    setColOrder(newOrder);
                    setDragCol(null);
                  }}
                  onClick={() => handleSort(c.key)}
                  title={c.tip}
                  style={{ ...thStyle(c.key), minWidth: c.w, cursor: 'grab', borderBottom: '1px dotted #64748b' }}>
                  {c.label}{sortCol === c.key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((s, i) => {
              const isRemoved = s.status === 'REMOVED';
              const isContext = s.status === 'CONTEXT';
              const rowOpacity = isRemoved ? 0.45 : isContext ? 0.7 : 1;
              const prevStatus = i > 0 ? sorted[i - 1].status : null;
              const showSep = prevStatus && prevStatus !== s.status;

              return (
                <React.Fragment key={s.rawName + '-' + s.signalType}>
                  {showSep && (
                    <tr><td colSpan={columns.length} style={{ padding: 0, height: 2, background: '#334155' }} /></tr>
                  )}
                  <tr
                    onClick={() => setExpandedRow(expandedRow === s.rawName ? null : s.rawName)}
                    style={{
                      borderBottom: '1px solid #1e293b', opacity: rowOpacity,
                      cursor: 'pointer', background: expandedRow === s.rawName ? 'rgba(148,163,184,0.04)' : 'transparent',
                      transition: 'background 0.1s',
                    }}
                    onMouseEnter={e => e.currentTarget.style.background = 'rgba(148,163,184,0.06)'}
                    onMouseLeave={e => e.currentTarget.style.background = expandedRow === s.rawName ? 'rgba(148,163,184,0.04)' : 'transparent'}
                  >
                    {columns.map(c => {
                      const cs = { padding: '8px 8px', fontFamily: 'monospace', fontSize: 14 };
                      switch (c.key) {
                        case 'name': return <td key={c.key} style={{ ...cs, fontWeight: 700, color: '#e2e8f0', whiteSpace: 'nowrap', fontFamily: 'inherit' }}>{s.name}</td>;
                        case 'wr': return <td key={c.key} style={{ ...cs, fontWeight: 800, color: wrColor(s.wr) }}>{fmtPct(s.wr)}</td>;
                        case 'wr30d': return <td key={c.key} style={{ ...cs, fontWeight: 800, color: s.wr30d != null ? wrColor(s.wr30d) : '#64748b' }}>{s.wr30d != null ? fmtPct(s.wr30d) : '--'}</td>;
                        case 'wr10d': return <td key={c.key} style={{ ...cs, fontWeight: 800, color: s.wr10d != null ? wrColor(s.wr10d) : '#64748b' }}>{s.wr10d != null ? fmtPct(s.wr10d) : '--'}</td>;
                        case 'trend10d': return <td key={c.key} style={{ ...cs, fontWeight: 800, fontSize: 16, color: s.trend10d === 'UP' ? '#4ade80' : s.trend10d === 'DOWN' ? '#f87171' : '#94a3b8' }}>{s.trend10d === 'UP' ? '↑' : s.trend10d === 'DOWN' ? '↓' : s.trend10d === 'FLAT' ? '→' : '--'}</td>;
                        case 'stability': {
                          const stColor = { DEGRADING: '#f87171', IMPROVING: '#4ade80', NOISY_BUT_STABLE: '#94a3b8', THIN: '#64748b', AMBIGUOUS: '#fbbf24' };
                          const stLabel = { DEGRADING: 'Degrading', IMPROVING: 'Improving', NOISY_BUT_STABLE: 'Noisy', THIN: 'Thin', AMBIGUOUS: 'Mixed' };
                          const label = s.stabilityStable === true ? 'Stable' : (s.stabilityTrend ? stLabel[s.stabilityTrend] || s.stabilityTrend : '--');
                          const color = s.stabilityStable === true ? '#4ade80' : (s.stabilityTrend ? stColor[s.stabilityTrend] || '#94a3b8' : '#64748b');
                          return <td key={c.key} style={{ ...cs, fontWeight: 700, fontSize: 12, color }}>{label}</td>;
                        }
                        case 'ev': return <td key={c.key} style={{ ...cs, fontWeight: 800, color: evColor(s.ev) }}>{s.ev != null ? '$' + Math.round(s.ev) : '--'}</td>;
                        case 'stop': return <td key={c.key} style={{ ...cs, color: '#f87171' }}>{s.stop ? fmtN(s.stop) + 'pt' : '--'}</td>;
                        case 't1': return <td key={c.key} style={{ ...cs, color: '#4ade80' }}>
                          {s.t1 ? fmtN(s.t1) + 'pt' : '--'}
                          {s.targetMethod === 'corrected-resim' && (
                            <span title="Chronologically-resimulated, guardrail-validated target (thin-tail/plateau/OOS/rigor-checked) — replaces the older order-blind EV-sweep, which was structurally blind to genuine continuation past target." style={{ marginLeft: 4, fontSize: 9, fontWeight: 800, color: '#a78bfa', background: 'rgba(167,139,250,0.15)', border: '1px solid rgba(167,139,250,0.4)', borderRadius: 3, padding: '0px 4px', cursor: 'help' }}>✓ CAL</span>
                          )}
                        </td>;
                        case 't2': return <td key={c.key} style={{ ...cs, color: s.t2 ? '#22d3ee' : '#64748b' }}>{s.t2 ? fmtN(s.t2) + 'pt' : '--'}</td>;
                        case 'mae': return <td key={c.key} style={{ ...cs, color: '#fb923c' }}>{s.mae != null ? fmtN(s.mae) + 'pt' : '--'}</td>;
                        case 'mfe': return <td key={c.key} style={{ ...cs, color: '#34d399' }}>{s.mfe != null ? fmtN(s.mfe) + 'pt' : '--'}</td>;
                        case 'p50mae': return <td key={c.key} style={{ ...cs, color: '#94a3b8' }}>{s.p50mae != null ? fmtN(s.p50mae) + 'pt' : '--'}</td>;
                        case 'p75mae': return <td key={c.key} style={{ ...cs, color: '#94a3b8' }}>{s.p75mae != null ? fmtN(s.p75mae) + 'pt' : '--'}</td>;
                        case 'n': return <td key={c.key} style={{ ...cs, color: '#94a3b8' }}>{s.n || '--'}</td>;
                        case 'totalPnl': return <td key={c.key} style={{ ...cs, color: evColor(s.totalPnl) }}>{s.totalPnl != null ? '$' + Math.round(s.totalPnl).toLocaleString() : '--'}</td>;
                        case 'regimeFit': return <td key={c.key} style={{ ...cs, whiteSpace: 'nowrap' }}>
                          {s.regimeFit ? (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                              <span style={{ width: 8, height: 8, borderRadius: '50%', background: regimeDot(s.regimeFit), display: 'inline-block' }} />
                              <span style={{ fontSize: 11, color: regimeDot(s.regimeFit), fontWeight: 700 }}>
                                {s.regimeFit === 'OUTPERFORMING' ? 'OUT' : s.regimeFit === 'DEGRADING' ? 'DEG' : 'NRM'}
                              </span>
                            </span>
                          ) : <span style={{ color: '#94a3b8' }}>--</span>}
                        </td>;
                        case 'frequency': return <td key={c.key} style={{ ...cs, color: '#94a3b8', fontSize: 12 }}>{s.frequency || '--'}</td>;
                        case 'distFromPrice': return <td key={c.key} style={{ ...cs,
                          color: s.distFromPrice != null ? (s.distFromPrice <= 50 ? '#4ade80' : s.distFromPrice <= 200 ? '#fbbf24' : '#94a3b8') : '#64748b'
                        }}>{s.distFromPrice != null ? s.distFromPrice + 'pt' : '--'}</td>;
                        case 'next2DayProb': return <td key={c.key} style={{ ...cs }}>
                          {s.next2DayProb ? (
                            <span style={{ fontSize: 12, fontWeight: 800, padding: '2px 6px', borderRadius: 3,
                              background: probColor(s.next2DayProb) + '20', color: probColor(s.next2DayProb),
                            }}>{probLabel(s.next2DayProb)}</span>
                          ) : <span style={{ color: '#94a3b8' }}>--</span>}
                        </td>;
                        case 'status': return <td key={c.key} style={{ ...cs }}>
                      <span style={{
                        fontSize: 12, fontWeight: 800, padding: '2px 6px', borderRadius: 3,
                        background: statusBg(s.status), color: statusColor(s.status),
                        letterSpacing: '0.03em',
                      }}>
                        {s.status}
                      </span>
                    </td>;
                        default: return <td key={c.key} style={{ padding: '8px 6px', color: '#94a3b8', fontSize: 13 }}>--</td>;
                      }
                    })}
                  </tr>
                  {/* Expanded detail row — full trading context */}
                  {expandedRow === s.rawName && (() => {
                    const guides = {
                      'PD_POC': { what: 'Fade at prior day Point of Control. The market\'s accepted value from yesterday — price gravitates here and often bounces.', how: 'AM session, first touch only. Enter on touch with 90pt stop, 40pt target. Scale half at T1, runner with breakeven stop. If delta shows exhaustion (sellers pushing but price holding), higher conviction.', best: 'TREND_UP days: 85%+ WR. Thursday: 71% WR (DOW pattern). 12-2 PM sweet spot historically. Post-flush days with absorption: 82% WR.', avoid: 'Only 44% WR on TREND_DOWN days — POC breaks when market is selling hard. Skip when IB_BEARISH fired and price is driving away.', risk: `Stop: 90pt ($181). Expected heat: P50 MAE ${fmtN(s.p50mae)}pt, P75 ${fmtN(s.p75mae)}pt. MFE: ${fmtN(s.mfe)}pt avg. MFE > MAE = trade works before it hurts.` },
                      '5D_OR_MID': { what: '5-day rolling OR midpoint. Smooths outlier days — represents where the opening range has been centered over the past week. Most stable reference.', how: 'AM session, first touch. 90pt stop, 40pt target. This is the highest EV level in the system ($64/trade). When it fires, take it.', best: 'Works across most regimes. Rolling composite absorbs extreme days. 94% WR over system backtest.', avoid: 'Can be far from price in trending markets. If distance > ATR, unlikely to touch.', risk: `Stop: 90pt ($181). Tightest MAE of composites: P50 ${fmtN(s.p50mae)}pt. Clean level.` },
                      'PD_VAL': { what: 'Fade at prior day Value Area Low. The bottom of yesterday\'s accepted range — institutional support. Buyers defended this yesterday.', how: 'AM session, first touch. 90pt stop, 40pt target. If price broke below and came back — that\'s a failed break, even higher conviction.', best: 'TURBULENT days: 92% WR. Balance days: 80% WR. When market tests yesterday\'s value and holds = strong.', avoid: 'TREND_DOWN days with strong selling — VAL becomes a breakout level, not support.', risk: `Stop: 90pt ($181). P50 MAE: ${fmtN(s.p50mae)}pt. MFE: ${fmtN(s.mfe)}pt.` },
                      'PD_VAH': { what: 'Fade at prior day Value Area High. The top of yesterday\'s accepted range — institutional resistance.', how: 'AM session, first touch. 90pt stop, 40pt target. Highest frequency KEEP level (~1.2/day). Short on approach from below.', best: 'Works well across most day types. High frequency means consistent small wins.', avoid: 'TREND_UP days with strong buying — VAH becomes breakout, not resistance.', risk: `Stop: 90pt ($181). P50 MAE: ${fmtN(s.p50mae)}pt.` },
                      'PD_IB_MID': { what: 'Prior day\'s Initial Balance midpoint. Where the first hour settled yesterday — key mean-reversion level.', how: 'AM session, first touch. 90pt stop, 40pt target. Tightest MAE of any level (20pt P50) — clean entries, minimal heat.', best: 'First touch AM: $44 EV. The cleanest level in the system. 83% WR.', avoid: 'Less reliable when market is far from yesterday\'s range.', risk: `Stop: 90pt ($181). P50 MAE only ${fmtN(s.p50mae)}pt — barely goes against you before working.` },
                      'FLOOR_PIVOT': { what: 'Floor trader pivot point. Computed from prior day H+L+C/3. Structural reference used by institutions.', how: 'AM session, first touch. 90pt stop, 40pt target. 10 AM touch is the classic play (70% WR Thursday).', best: 'TURBULENT days: 100% WR. AM session: $41 EV. Structural level that institutions watch.', avoid: 'Less effective in PM session when volume dries up.', risk: `Stop: 90pt ($181). P50 MAE: ${fmtN(s.p50mae)}pt.` },
                      'OR_HIGH': { what: 'Today\'s Opening Range High. The first 5 minutes establish the range — price respects this level all session.', how: 'Post-OR (after 9:35), first touch. 90pt stop, 40pt target. If approaching from below and failing = short fade.', best: 'High vol expanding regime: +19pp boost. AM session. First touch critical.', avoid: 'TREND_UP open drive — OR High becomes a breakout continuation, not resistance.', risk: `Stop: 90pt ($181). P50 MAE: ${fmtN(s.p50mae)}pt.` },
                      'FLOOR_R1': { what: 'Floor trader R1 resistance. First resistance level above the pivot. Classic fade level.', how: 'AM session, first touch. 90pt stop, 40pt target. Thursday 1 PM is the specialist window (78% WR).', best: 'Thursday afternoon: 78% WR. R1 fades worked for you on Wednesday (the R1 short that banked).', avoid: 'Strong trend days where price drives through R1 with volume.', risk: `Stop: 90pt ($181). P50 MAE: ${fmtN(s.p50mae)}pt.` },
                      'PD_OR_MID': { what: 'Prior day\'s Opening Range midpoint. Where yesterday\'s first 5 minutes centered. Precise structural reference.', how: 'AM session, first touch. 90pt stop, 40pt target. 80% WR.', best: 'AM session: 84% WR. Outperforms when price is within ATR distance.', avoid: 'Can be far from price after big moves.', risk: `Stop: 90pt ($181). P50 MAE: ${fmtN(s.p50mae)}pt.` },
                      'IB_MID_SCALP': { what: 'Today\'s IB midpoint scalp. Price rotates around the first hour\'s midpoint. Quick in-and-out.', how: 'After IB forms (10:30+), fade touches. 50pt stop, 15pt target. 3 trades/day possible. Quick resolution (2-3 min avg).', best: 'AM session: 82% WR. $12/day expected across 3 trades.', avoid: 'Strong trend days — IB mid gets run over.', risk: 'Stop: 50pt ($101). Small target but very high hit rate.' },
                      'OR_MID_AFTER_IB': { what: 'OR midpoint retested after IB forms. The 5-min mid revisited — scalp the bounce.', how: 'After IB (10:30+), first touch of OR mid. 35pt stop, 20pt target. 5 trades/day possible. Your bread-and-butter scalp.', best: 'Highest frequency scalp in the system. $10/day expected.', avoid: 'Choppy days where OR mid is noise.', risk: 'Stop: 35pt ($71). 5 trades/day fits $400 DLL.' },
                      'IB_BEARISH_DIRECTION': { what: 'IB broke to the downside. Not a trade entry — tells you the market\'s lean is SHORT.', how: 'When this fires, look for KEEP level fades in the SHORT direction. PD_POC fade short, Floor R1 fade short.', best: '54% directional accuracy. Combined with level fades = the framework.', avoid: 'Don\'t enter mechanically. 161pt MAE makes it untradeable as a scalp.', risk: 'No stop — this is context, not a trade. 161pt MAE if you tried to trade it.' },
                      'IB_BULLISH_DIRECTION': { what: 'IB broke to the upside. Not a trade entry — tells you the market\'s lean is LONG.', how: 'When this fires, look for KEEP level fades in the LONG direction. PD_VAL fade long, PD_POC fade long.', best: '63% directional accuracy — best ACD signal. Strong LEAN.', avoid: 'Don\'t enter mechanically. 151pt MAE.', risk: 'No stop — context only.' },
                    };
                    const g = guides[s.rawName] || { what: s.bestContext || 'Level fade setup.', how: 'AM session, first touch. 90pt stop, 40pt target.', best: s.bestContext, avoid: 'Check regime fit.', risk: `MAE: ${fmtN(s.mae)}pt, MFE: ${fmtN(s.mfe)}pt.` };
                    const secStyle = { marginBottom: 10 };
                    const headStyle = { color: '#94a3b8', fontWeight: 700, fontSize: 13, textTransform: 'uppercase', marginBottom: 4, letterSpacing: '0.06em' };
                    const bodyStyle = { color: '#cbd5e1', fontSize: 14, lineHeight: 1.7 };
                    return (
                      <tr>
                        <td colSpan={columns.length} style={{ padding: '12px 16px 16px', background: 'rgba(148,163,184,0.03)', borderBottom: '1px solid #334155' }}>
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, fontSize: 11 }}>
                            <div>
                              <div style={secStyle}><div style={headStyle}>What Is This Trade?</div><div style={bodyStyle}>{g.what}</div></div>
                              <div style={secStyle}><div style={headStyle}>How To Trade It</div><div style={bodyStyle}>{g.how}</div></div>
                              <div style={secStyle}><div style={headStyle}>Risk Profile</div><div style={{ ...bodyStyle, fontFamily: 'monospace', color: '#94a3b8' }}>{g.risk}</div></div>
                            </div>
                            <div>
                              <div style={secStyle}><div style={{ ...headStyle, color: '#4ade80' }}>Best Context (When It Works)</div><div style={bodyStyle}>{g.best}</div></div>
                              <div style={secStyle}><div style={{ ...headStyle, color: '#f87171' }}>When To Avoid</div><div style={bodyStyle}>{g.avoid}</div></div>
                              <div style={secStyle}>
                                <div style={headStyle}>MAE / MFE Detail</div>
                                <div style={{ ...bodyStyle, fontFamily: 'monospace', color: '#94a3b8' }}>
                                  MAE — Avg: {fmtN(s.mae)}pt | P50: {fmtN(s.p50mae)}pt | P75: {fmtN(s.p75mae)}pt{s.p90mae != null ? ` | P90: ${fmtN(s.p90mae)}pt` : ''}<br/>
                                  MFE — Avg: {fmtN(s.mfe)}pt | MFE/MAE: {s.mae > 0 ? (s.mfe / s.mae).toFixed(2) + 'x' : '—'}
                                </div>
                              </div>
                              <div style={secStyle}><div style={headStyle}>Tests Applied</div><div style={{ ...bodyStyle, color: '#94a3b8' }}>{s.testsApplied}</div></div>
                            </div>
                          </div>
                        </td>
                      </tr>
                    );
                  })()}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* ── Confluence Pairs Section ─────────────────────────────────── */}
      {data.pairs?.length > 0 && <ConfluencePairsTable pairs={data.pairs} />}
    </div>
  );
}

function ConfluencePairsTable({ pairs }) {
  const [filter, setFilter] = React.useState('TRADE');
  const [search, setSearch] = React.useState('');
  const [sortCol, setSortCol] = React.useState('ev');
  const [sortDir, setSortDir] = React.useState('desc');
  const [expandedPair, setExpandedPair] = React.useState(null);

  const wrColor = v => v != null ? (v >= 75 ? '#4ade80' : v >= 60 ? '#a3e635' : v >= 50 ? '#fbbf24' : '#f87171') : '#94a3b8';
  const evColor = v => v != null ? (v > 30 ? '#4ade80' : v > 0 ? '#a3e635' : v > -20 ? '#fbbf24' : '#f87171') : '#94a3b8';
  const trendIcon = t => t === 'UP' ? <span style={{ color: '#4ade80' }}>↑</span> : t === 'DOWN' ? <span style={{ color: '#f87171' }}>↓</span> : t === 'FLAT' ? <span style={{ color: '#94a3b8' }}>→</span> : <span style={{ color: '#94a3b8' }}>—</span>;
  const recBadge = rec => {
    const c = rec === 'TRADE' ? '#4ade80' : rec === 'CUT' ? '#f87171' : '#94a3b8';
    return <span style={{ fontSize: 11, fontWeight: 800, padding: '1px 6px', borderRadius: 3, background: c + '20', color: c, letterSpacing: '0.04em' }}>{rec}</span>;
  };
  const subTag = (sub, labelKey) => sub
    ? <span title={`N=${sub.n} WR=${sub.wr}% EV=$${sub.ev}`} style={{ fontSize: 11, color: '#94a3b8', cursor: 'default' }}>{sub[labelKey]}</span>
    : <span style={{ color: '#94a3b8' }}>—</span>;

  const filtered = pairs.filter(p => {
    if (filter !== 'ALL' && p.recommendation !== filter) return false;
    if (search) {
      const q = search.toLowerCase();
      if (!p.pair.toLowerCase().includes(q)) return false;
    }
    return true;
  }).sort((a, b) => {
    let vA = a[sortCol], vB = b[sortCol];
    if (vA == null) vA = sortDir === 'desc' ? -Infinity : Infinity;
    if (vB == null) vB = sortDir === 'desc' ? -Infinity : Infinity;
    return sortDir === 'asc' ? vA - vB : vB - vA;
  });

  const handleSort = col => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir('desc'); }
  };

  const tradeCt = pairs.filter(p => p.recommendation === 'TRADE').length;
  const cutCt   = pairs.filter(p => p.recommendation === 'CUT').length;
  const ctxCt   = pairs.filter(p => p.recommendation === 'CONTEXT').length;

  const thS = col => ({
    padding: '7px 8px', textAlign: 'left', fontSize: 12, fontWeight: 700, cursor: 'pointer',
    color: sortCol === col ? '#e2e8f0' : '#64748b', textTransform: 'uppercase', letterSpacing: '0.04em',
    borderBottom: '1px solid #334155', whiteSpace: 'nowrap', userSelect: 'none',
  });

  return (
    <div style={{ marginTop: 40 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 12 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 800, color: '#e2e8f0' }}>Confluence Pairs</h2>
          <span style={{ fontSize: 11, color: '#94a3b8' }}>
            {pairs.length} validated pairs (N≥10, ≥5 distinct sessions, 15pt proximity) · {tradeCt} TRADE · {ctxCt} CONTEXT · {cutCt} CUT · Updated weekly
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Filter by level…"
            style={{ background: 'rgba(30,41,59,0.8)', border: '1px solid #334155', borderRadius: 5, padding: '4px 10px', fontSize: 13, color: '#e2e8f0', width: 160 }}
          />
          {['TRADE', 'CONTEXT', 'CUT', 'ALL'].map(f => (
            <button key={f} onClick={() => setFilter(f)} style={{
              padding: '4px 12px', borderRadius: 5, fontSize: 12, fontWeight: 700, cursor: 'pointer',
              background: filter === f ? (f === 'TRADE' ? '#166534' : f === 'CUT' ? '#7f1d1d' : '#1e293b') : 'transparent',
              color: filter === f ? (f === 'TRADE' ? '#4ade80' : f === 'CUT' ? '#f87171' : '#e2e8f0') : '#64748b',
              border: `1px solid ${filter === f ? (f === 'TRADE' ? '#166534' : f === 'CUT' ? '#7f1d1d' : '#334155') : '#1e293b'}`,
            }}>{f} {f === 'TRADE' ? `(${tradeCt})` : f === 'CUT' ? `(${cutCt})` : f === 'CONTEXT' ? `(${ctxCt})` : `(${pairs.length})`}</button>
          ))}
        </div>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr>
              {[['pair','Pair',160],['n','N',36],['wr','WR (All)',60],['ev','EV (All)',60],
                ['wr6m','6M WR',52],['wr20','20D WR',52],['n20','20D N',40],
                [null,'Trend',36],[null,'Best DOW',70],[null,'Best TOD',80],[null,'Best DT',80],[null,'Worst TOD',80],[null,'Rec',50]
              ].map(([col, lbl, w]) => (
                <th key={lbl} onClick={col ? () => handleSort(col) : undefined}
                  style={{ ...thS(col), minWidth: w, cursor: col ? 'pointer' : 'default' }}>
                  {lbl}{col && sortCol === col ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map(p => (
              <React.Fragment key={p.pair}>
                <tr
                  onClick={() => setExpandedPair(expandedPair === p.pair ? null : p.pair)}
                  style={{ borderBottom: '1px solid #1e293b', cursor: 'pointer' }}
                  onMouseEnter={e => e.currentTarget.style.background = 'rgba(148,163,184,0.05)'}
                  onMouseLeave={e => e.currentTarget.style.background = expandedPair === p.pair ? 'rgba(148,163,184,0.03)' : 'transparent'}
                >
                  <td style={{ padding: '7px 8px', fontWeight: 700, color: '#e2e8f0', fontFamily: 'monospace', whiteSpace: 'nowrap' }}>{p.pair}</td>
                  <td style={{ padding: '7px 8px', fontFamily: 'monospace', color: '#94a3b8' }}>{p.n}</td>
                  <td style={{ padding: '7px 8px', fontFamily: 'monospace', fontWeight: 800, color: wrColor(p.wr) }}>{p.wr != null ? p.wr.toFixed(1) + '%' : '—'}</td>
                  <td style={{ padding: '7px 8px', fontFamily: 'monospace', fontWeight: 800, color: evColor(p.ev) }}>{p.ev != null ? '$' + Math.round(p.ev) : '—'}</td>
                  <td style={{ padding: '7px 8px', fontFamily: 'monospace', color: wrColor(p.wr6m) }}>{p.wr6m != null ? p.wr6m.toFixed(1) + '%' : '—'}</td>
                  <td style={{ padding: '7px 8px', fontFamily: 'monospace', color: wrColor(p.wr20) }}>{p.wr20 != null ? p.wr20.toFixed(1) + '%' : '—'}</td>
                  <td style={{ padding: '7px 8px', fontFamily: 'monospace', color: '#94a3b8' }}>{p.n20 || '—'}</td>
                  <td style={{ padding: '7px 8px', textAlign: 'center' }}>{trendIcon(p.trend)}</td>
                  <td style={{ padding: '7px 8px' }}>{subTag(p.best_dow, 'dow')}</td>
                  <td style={{ padding: '7px 8px' }}>{subTag(p.best_tod, 'tod')}</td>
                  <td style={{ padding: '7px 8px' }}>{subTag(p.best_dt, 'day_type')}</td>
                  <td style={{ padding: '7px 8px', color: p.worst_tod ? '#f87171' : '#475569', fontSize: 11 }}>{p.worst_tod ? p.worst_tod.tod : '—'}</td>
                  <td style={{ padding: '7px 8px' }}>{recBadge(p.recommendation)}</td>
                </tr>
                {expandedPair === p.pair && (
                  <tr>
                    <td colSpan={13} style={{ padding: '10px 16px 14px', background: 'rgba(15,23,42,0.6)', borderBottom: '1px solid #334155' }}>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
                        {/* DOW */}
                        <div>
                          <div style={{ fontSize: 11, fontWeight: 800, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Day of Week</div>
                          {p.dow_breakdown?.length ? p.dow_breakdown.map(d => (
                            <div key={d.dow} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '2px 0', borderBottom: '1px solid rgba(51,65,85,0.3)' }}>
                              <span style={{ color: '#94a3b8', minWidth: 40 }}>{d.dow}</span>
                              <span style={{ fontFamily: 'monospace', color: wrColor(d.wr) }}>{d.wr != null ? d.wr.toFixed(1) + '%' : '—'}</span>
                              <span style={{ fontFamily: 'monospace', color: evColor(d.ev), minWidth: 48, textAlign: 'right' }}>{d.ev != null ? '$' + Math.round(d.ev) : '—'}</span>
                              <span style={{ color: '#94a3b8', minWidth: 26, textAlign: 'right' }}>N={d.n}</span>
                            </div>
                          )) : <span style={{ color: '#94a3b8', fontSize: 12 }}>No data</span>}
                        </div>
                        {/* TOD */}
                        <div>
                          <div style={{ fontSize: 11, fontWeight: 800, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Time of Day</div>
                          {p.tod_breakdown?.length ? p.tod_breakdown.map(d => (
                            <div key={d.tod} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '2px 0', borderBottom: '1px solid rgba(51,65,85,0.3)' }}>
                              <span style={{ color: '#94a3b8', minWidth: 60 }}>{d.tod}</span>
                              <span style={{ fontFamily: 'monospace', color: wrColor(d.wr) }}>{d.wr != null ? d.wr.toFixed(1) + '%' : '—'}</span>
                              <span style={{ fontFamily: 'monospace', color: evColor(d.ev), minWidth: 48, textAlign: 'right' }}>{d.ev != null ? '$' + Math.round(d.ev) : '—'}</span>
                              <span style={{ color: '#94a3b8', minWidth: 26, textAlign: 'right' }}>N={d.n}</span>
                            </div>
                          )) : <span style={{ color: '#94a3b8', fontSize: 12 }}>No data</span>}
                        </div>
                        {/* Day Type */}
                        <div>
                          <div style={{ fontSize: 11, fontWeight: 800, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Day Type</div>
                          {p.dt_breakdown?.length ? p.dt_breakdown.map(d => (
                            <div key={d.day_type} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '2px 0', borderBottom: '1px solid rgba(51,65,85,0.3)' }}>
                              <span style={{ color: '#94a3b8', minWidth: 72 }}>{d.day_type}</span>
                              <span style={{ fontFamily: 'monospace', color: wrColor(d.wr) }}>{d.wr != null ? d.wr.toFixed(1) + '%' : '—'}</span>
                              <span style={{ fontFamily: 'monospace', color: evColor(d.ev), minWidth: 48, textAlign: 'right' }}>{d.ev != null ? '$' + Math.round(d.ev) : '—'}</span>
                              <span style={{ color: '#94a3b8', minWidth: 26, textAlign: 'right' }}>N={d.n}</span>
                            </div>
                          )) : <span style={{ color: '#94a3b8', fontSize: 12 }}>No data</span>}
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && (
          <div style={{ textAlign: 'center', padding: 32, color: '#94a3b8' }}>No pairs match this filter.</div>
        )}
      </div>
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
  const [activeSection, setActiveSection] = useState('alpha'); // default to Alpha Engine
  const [chartReviewDate, setChartReviewDate] = useState('');
  const [srChartModal, setSrChartModal] = useState(null); // Setup Reference's own chart modal (date links) — separate from the Chart Review tab
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

      {priceSyncProgress && priceSyncProgress.status !== 'success' && (
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, borderBottom: '1px solid var(--border-color)', paddingBottom: 0, flexWrap: 'wrap' }}>
        {[
          ['setups', 'Setup Log'],
          ['reference', 'Setup Reference'],
          ['research', 'Research Ledger'],
          ['alpha', 'Alpha Engine'],
          ['audit', 'Performance Audit'],
          ['edge', 'Edge Analysis'],
          ['efficiency', 'Efficiency Analysis'],
          ['volume', 'Volume Profile'],
          ['keylevels', 'Key Levels'],
          ['scenarios', 'Scenarios'],
          ['risk', 'Risk & Sizing'],
          ['playbook', 'Playbook'],
          // chartreview accessible via Key Levels jump, backlog moved to Settings
        ].map(([v, l]) => (
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
          <span style={{ marginLeft: 'auto', fontSize: 13, color: 'var(--text-muted)', whiteSpace: 'nowrap', paddingBottom: 4 }}>
            NQ price data through{' '}
            <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>
              {lastBarDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}
            </span>
          </span>
        )}
      </div>

      {activeSection === 'setups' && <SetupHistoryView />}
      {activeSection === 'reference' && <SetupReferenceView onOpenChart={(date, dates) => setSrChartModal({ date, dates, levelKey: null })} />}
      <ChartModalOverlay chartModal={srChartModal} setChartModal={setSrChartModal} selectedAccounts={selectedAccounts} />
      {activeSection === 'research' && <ResearchLedgerView />}
      {activeSection === 'alpha' && <AlphaEngineOverview />}
      {activeSection === 'scenarios' && <ScenarioTesterView />}
      {activeSection === 'risk' && <Suspense fallback={<div style={{ padding: 40, color: 'var(--text-muted)' }}>Loading…</div>}><RiskView accounts={accounts} selectedAccounts={selectedAccounts} setSelectedAccounts={setSelectedAccounts} /></Suspense>}
      {activeSection === 'audit' && <PerformanceAuditPanel />}

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
              {/* Two-column layout: chart left, boxes right — vertically centered */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 220px', gap: 20, alignItems: 'center' }}>
                {/* Left: all-time efficiency trend — always rendered */}
                <div>
                  {(() => {
                    const chartData = byDateAllTime?.length ? byDateAllTime : byDate;
                    const display = hoveredEffPoint || (chartData?.length ? chartData[chartData.length - 1] : null);
                    const yearMarkers = [];
                    if (chartData?.length) {
                      const years = [...new Set(chartData.map(d => d.log_date.slice(0, 4)))];
                      years.forEach(yr => {
                        const first = chartData.find(d => d.log_date.startsWith(yr));
                        if (first) yearMarkers.push({ date: first.log_date, year: yr });
                      });
                    }
                    return (
                      <>
                      <ResponsiveContainer width="100%" height={220}>
                        <LineChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}
                          onMouseMove={e => { if (e?.activePayload?.[0]) setHoveredEffPoint(e.activePayload[0].payload); }}
                          onMouseLeave={() => setHoveredEffPoint(null)}>
                          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                          <XAxis dataKey="log_date" stroke="#94a3b8" tick={{ fontSize: 13 }}
                            tickFormatter={d => new Date(d+'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                            minTickGap={60} />
                          <YAxis stroke="#94a3b8" tick={{ fontSize: 13 }} tickFormatter={v => `${v}%`} width={42} domain={[-40, 100]} />
                          <Tooltip content={() => null} />
                          <ReferenceLine y={0} stroke="rgba(255,255,255,0.2)" />
                          {yearMarkers.map(({ date, year }) => (
                            <ReferenceLine key={year} x={date}
                              stroke="rgba(255,255,255,0.35)" strokeWidth={1} strokeDasharray="6 3"
                              label={{ value: year, position: 'insideTopLeft', fill: '#94a3b8', fontSize: 13, fontWeight: 700 }} />
                          ))}
                          <Line type="monotone" dataKey="entry_eff" stroke="#3b82f6" strokeWidth={2} dot={false} name="entry_eff" />
                          <Line type="monotone" dataKey="exit_eff"  stroke="#10b981" strokeWidth={2} dot={false} name="exit_eff" />
                          <Line type="monotone" dataKey="total_eff" stroke="#8b5cf6" strokeWidth={1.5} dot={false} name="total_eff" strokeDasharray="4 2" />
                          <Legend iconSize={10} wrapperStyle={{ fontSize: 13, marginTop: 4 }}
                            formatter={v => v === 'entry_eff' ? 'Entry' : v === 'exit_eff' ? 'Exit' : 'Total'} />
                        </LineChart>
                      </ResponsiveContainer>
                      {/* Stats bar below the chart */}
                      <div style={{ display: 'flex', gap: 16, marginTop: 8, padding: '7px 12px', background: 'rgba(0,0,0,0.15)', borderRadius: 6, alignItems: 'center' }}>
                        {display ? (
                          <>
                            <span style={{ fontSize: 13, color: '#94a3b8', fontFamily: 'monospace', minWidth: 100 }}>
                              {display.log_date ? new Date(display.log_date + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}
                              {!hoveredEffPoint && <span style={{ color: '#94a3b8', fontSize: 13 }}> (latest)</span>}
                            </span>
                            {[
                              { label: 'Entry', value: display.entry_eff, color: '#3b82f6' },
                              { label: 'Exit',  value: display.exit_eff,  color: '#10b981' },
                              { label: 'Total', value: display.total_eff, color: '#8b5cf6' },
                            ].map(({ label, value, color }) => (
                              <span key={label} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                                <span style={{ fontSize: 13, color: '#94a3b8' }}>{label}</span>
                                <span style={{ fontSize: 15, fontWeight: 700, color, fontFamily: 'monospace' }}>
                                  {value != null ? `${value}%` : '—'}
                                </span>
                              </span>
                            ))}
                          </>
                        ) : <span style={{ fontSize: 13, color: '#94a3b8' }}>Hover to inspect</span>}
                      </div>
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
                      <div style={{ fontSize: 13, color: '#94a3b8', textAlign: 'right', marginBottom: 2 }}>
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
                            <div style={{ fontSize: 13, color: '#94a3b8', marginBottom: 2, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{box.label}</div>
                            <div style={{ fontSize: 20, fontWeight: 800, color: box.color, fontFamily: 'monospace', lineHeight: 1.2 }}>
                              {box.neg ? '-' : ''}{pts ?? '—'} <span style={{ fontSize: 13, fontWeight: 600 }}>pts</span>
                            </div>
                            <div style={{ fontSize: 13, color: '#94a3b8', marginTop: 1 }}>{box.sub}</div>
                          </div>
                        );
                      })}
                      {d.p50Win != null && d.p50Loss != null && (
                        <div style={{ padding: '8px 14px', background: 'rgba(0,0,0,0.1)', borderRadius: 6, textAlign: 'center' }}>
                          <span style={{ fontSize: 13, color: '#94a3b8' }}>R:R (1 MNQ)  </span>
                          <span style={{ fontWeight: 700, fontFamily: 'monospace', fontSize: 13 }}>
                            <span style={{ color: '#22c55e' }}>{toMnqPts(d.p50Win)}pts</span>
                            <span style={{ color: '#94a3b8', margin: '0 4px' }}>vs</span>
                            <span style={{ color: '#ef4444' }}>{toMnqPts(d.p50Loss)}pts</span>
                            <span style={{ color: '#94a3b8', marginLeft: 6 }}>
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
              <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>
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
                        <span style={{ width: 40, fontSize: 13, color: 'var(--text-muted)' }}>{name}</span>
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
                <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>
                  Entry vs exit efficiency by time of day
                </p>
                <ResponsiveContainer width="100%" height={240}>
                  <BarChart data={byHour.filter(h => h.hour >= 8 && h.hour <= 16)} margin={{ top: 5, right: 10, left: 5, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                    <XAxis dataKey="label" stroke="#94a3b8" tick={{ fontSize: 13 }} />
                    <YAxis stroke="#94a3b8" tick={{ fontSize: 13 }} tickFormatter={v => `${v}%`} width={42} />
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
                <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>
                  Does execution quality drop with more trades?
                </p>
                <ResponsiveContainer width="100%" height={240}>
                  <BarChart data={bySession} margin={{ top: 5, right: 10, left: 5, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                    <XAxis dataKey="label" stroke="#94a3b8" tick={{ fontSize: 13 }} />
                    <YAxis stroke="#94a3b8" tick={{ fontSize: 13 }} tickFormatter={v => `${v}%`} width={42} />
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
                    <div key={s.label} style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                      <b>{s.label}</b>: avg {s.avg_pnl >= 0 ? '+' : ''}${formatNumber(s.avg_pnl)} · {s.sessions} sessions
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Scatter: Total Efficiency vs P&L */}
            <div className="backtest-chart-card">
              <h2>Total Efficiency vs Session P&L</h2>
              <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>
                Does higher efficiency predict better outcomes? Each dot = one session. ({scatter.length} sampled)
              </p>
              <ResponsiveContainer width="100%" height={280}>
                <ComposedChart margin={{ top: 10, right: 20, left: 10, bottom: 10 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                  <XAxis type="number" dataKey="x" stroke="#94a3b8" tick={{ fontSize: 13 }}
                    label={{ value: 'Total Efficiency %', position: 'insideBottom', offset: -5, fill: '#94a3b8', fontSize: 13 }}
                    tickFormatter={v => `${v}%`} domain={[-100, 100]} />
                  <YAxis type="number" dataKey="y" stroke="#94a3b8" tick={{ fontSize: 13 }}
                    tickFormatter={v => `$${formatNumber(v, 0)}`} width={70} />
                  <Tooltip
                    contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 8 }}
                    formatter={(v, name) => name === 'x' ? [`${v}%`, 'Efficiency'] : [`$${formatNumber(v)}`, 'P&L']}
                    labelFormatter={() => ''}
                    content={({ active, payload }) => {
                      if (!active || !payload?.length) return null;
                      const d = payload[0]?.payload;
                      return (
                        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 8, padding: '8px 12px', fontSize: 13 }}>
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
              <label style={{ fontSize: 13, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>Date</label>
              <input type="date" value={vpDate} onChange={e => setVpDate(e.target.value)}
                style={{ background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderRadius: 6,
                  color: 'var(--text-primary)', padding: '6px 10px', fontSize: 13 }} />
            </div>
            <div>
              <label style={{ fontSize: 13, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>Session (EST)</label>
              <div style={{ display: 'flex', gap: 6 }}>
                {[['rth', 'RTH', '9:30–16:14'], ['overnight', 'Overnight', '16:15–9:29'], ['both', 'Both', 'Full Day']].map(([v, l, sub]) => (
                  <button key={v} onClick={() => setVpSession(v)}
                    style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid var(--border-color)',
                      background: vpSession === v ? 'var(--accent-purple)' : 'var(--card-bg)',
                      color: vpSession === v ? '#fff' : 'var(--text-secondary)',
                      cursor: 'pointer', fontSize: 13, fontWeight: vpSession === v ? 600 : 400 }}>
                    {l}<br/><span style={{ fontSize: 13, opacity: 0.8 }}>{sub}</span>
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
              <div style={{ alignSelf: 'flex-end', fontSize: 13, color: 'var(--text-secondary)' }}>
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
                    <span style={{ color: 'var(--accent-purple)', fontWeight: 700 }}>POC {fmtP(poc, 2)}</span>
                    <span style={{ color: 'var(--accent-green)' }}>VAH {fmtP(vah, 2)}</span>
                    <span style={{ color: 'var(--accent-red)' }}>VAL {fmtP(val, 2)}</span>
                    <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
                      <button style={btnStyle} onClick={() => applyZoom(0.6)}>+</button>
                      <button style={btnStyle} onClick={() => applyZoom(1.67)}>−</button>
                      {vpZoom && (
                        <button onClick={() => setVpZoom(null)}
                          style={{ fontSize: 13, padding: '2px 8px', borderRadius: 4, cursor: 'pointer',
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
                          fontSize: 13, fontWeight: 700, color: 'var(--text-primary)',
                          padding: '1px 6px', borderRadius: 3, whiteSpace: 'nowrap', transform: 'translateY(-50%)' }}>
                          {fmtP(vpHover.price, 2)}
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
                    <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 4 }}>Total Volume</div>
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
      {activeSection === 'playbook' && (
        <>
          <PlaybookPage />
          <div style={{ borderTop: '1px solid var(--border-color)', marginTop: 32, paddingTop: 24 }}>
            <PlaybookWeeklyPatternsSection />
          </div>
        </>
      )}
      {activeSection === 'backlog' && <ImprovementsBacklogSection />}
      {activeSection === 'explanations' && <PlaybookWeeklyPatternsSection />}
    </div>
  );
}



export default BacktestView;
