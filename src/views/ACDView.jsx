import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { fmtP } from '../utils/format.js';
import { formatTimestamp, latestOf } from '../utils/timestamps.js';
import { TOOLTIPS } from '../constants/tooltips.js';
import { SETUP_DISPLAY_LABELS, SETUP_RESOLUTION_TEXT, LR_SLATE } from '../constants/setupDisplay.js';
import { DIM } from '../constants/uiStyles.js';
import InfoTooltip from '../components/shared/InfoTooltip.jsx';
import FetchStamp from '../components/shared/FetchStamp.jsx';
import CollapsibleSection from '../components/shared/CollapsibleSection.jsx';
import WinChip from '../components/shared/WinChip.jsx';
import { Dot, useDataUpdateDot, useFieldUpdateDots } from '../components/shared/UpdateDot.jsx';
import { useAcdLive } from '../utils/useAcdLive.js';
import { useSharedPollData, refreshSharedPollData } from '../utils/useSharedPollData.js';
import { ViewActiveProvider, useViewActive } from '../utils/useViewActive.js';
import ErrorBoundary from '../components/shared/ErrorBoundary.jsx';
import MarketPulseBar from '../components/dashboard/MarketPulseBar.jsx';
import SessionForecastPanel from '../components/dashboard/SessionForecastPanel.jsx';
import SessionPulseCard from '../components/dashboard/SessionPulseCard.jsx';
import SessionBiasPanel from '../components/dashboard/SessionBiasPanel.jsx';
import BehavioralPatternsCard from '../components/dashboard/BehavioralPatternsCard.jsx';
import PermSlipAndStackBar from '../components/dashboard/PermSlipAndStackBar.jsx';
import TradeAlertBanner from '../components/dashboard/TradeAlertBanner.jsx';
import VolatilityAlertBanner from '../components/dashboard/VolatilityAlertBanner.jsx';
import VolatilityRegimeCard from '../components/dashboard/VolatilityRegimeCard.jsx';
import TeleprinterFeed from '../components/dashboard/TeleprinterFeed.jsx';
import DayOfWeekPlaybookCard from '../components/dashboard/DayOfWeekPlaybookCard.jsx';
import LivePlaybookCard from '../components/dashboard/LivePlaybookCard.jsx';
import ApproachingLevelBanner from '../components/dashboard/ApproachingLevelBanner.jsx';
import { LevelConfluenceReference, ConditionBacktestInline, PatternStatsPanel } from './PlaybookView.jsx';
import {
  Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, ComposedChart,
} from 'recharts';

import { API_URL } from '../constants/api.js';

// ==================== ACD COMPONENTS ====================

const NL_TREND_COLOR = { TRENDING_UP: '#22c55e', TRENDING_DOWN: '#ef4444', RANGING: '#fbbf24' };
const NL_TREND_LABEL = { TRENDING_UP: 'TRENDING UP', TRENDING_DOWN: 'TRENDING DOWN', RANGING: 'RANGING' };



function NumberLineChart() {
  const [data, setData] = React.useState([]);
  const [range, setRange] = React.useState(180);
  const [hovered, setHovered] = React.useState(null);
  const [fetchedAt, setFetchedAt] = React.useState(null);
  const hoveredRef = React.useRef(null);

  React.useEffect(() => {
    fetch(`${API_URL}/acd/numberline/history`)
      .then(r => r.json())
      .then(d => { setData(d); setFetchedAt(new Date()); })
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
          {fetchedAt && <span style={{ marginLeft: 10 }}><FetchStamp at={fetchedAt} /></span>}
        </div>
        {/* Custom dropdown to avoid native styling issues */}
        <div style={{ display: 'flex', gap: 4 }}>
          {rangeOpts.map(opt => (
            <button key={opt.value} onClick={() => setRange(opt.value)}
              style={{ padding: '3px 8px', fontSize: 13, borderRadius: 5, cursor: 'pointer', border: '1px solid var(--border-color)',
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
          <XAxis dataKey="date" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} tickFormatter={d => d.slice(5)} interval={Math.floor(visible.length / 8)} />
          <YAxis tick={{ fontSize: 11, fill: 'var(--text-muted)' }} domain={['auto', 'auto']} />
          <Tooltip content={tooltipCapture} />
          <ReferenceLine y={9}  stroke="#22c55e" strokeDasharray="4 4" strokeWidth={1} label={{ value: '+9', fill: '#22c55e', fontSize: 13, position: 'right' }} />
          <ReferenceLine y={-9} stroke="#ef4444" strokeDasharray="4 4" strokeWidth={1} label={{ value: '-9', fill: '#ef4444', fontSize: 13, position: 'right' }} />
          <ReferenceLine y={0}  stroke="rgba(255,255,255,0.15)" strokeWidth={1} />
          <Bar dataKey="score" fill="rgba(100,116,139,0.4)" radius={[1,1,0,0]} maxBarSize={8} isAnimationActive={false} />
          <Line type="monotone" dataKey="nl10" stroke="#f59e0b" strokeWidth={1} dot={false} strokeOpacity={0.7} isAnimationActive={false} />
          <Line type="monotone" dataKey="nl30" stroke="#3b82f6" strokeWidth={2} dot={<CustomDot />} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
      <div style={{ display: 'flex', gap: 20, marginTop: 8, fontSize: 13, color: 'var(--text-muted)' }}>
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
              <span style={{ fontSize: 13, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{hovered.date}</span>
              <span style={{ fontWeight: 700, color: trendColor, fontSize: 13 }}>{trendLabel}</span>
              <span style={{ color: '#3b82f6', fontSize: 13 }}>NL30: <strong>{hovered.nl30 > 0 ? '+' : ''}{hovered.nl30}</strong></span>
              <span style={{ color: '#f59e0b', fontSize: 13 }}>NL10: <strong>{hovered.nl10 > 0 ? '+' : ''}{hovered.nl10}</strong></span>
              <span style={{ fontSize: 13, color: '#e2e8f0', flex: 1 }}>{momentum}</span>
              <span style={{ fontSize: 13, fontWeight: 700, color: trendColor, whiteSpace: 'nowrap' }}>{holdRec}</span>
            </div>
          </div>
        );
      })() : (
        <div style={{ marginTop: 10, padding: '8px 14px', background: 'rgba(0,0,0,0.15)', borderRadius: 8, fontSize: 13, color: 'var(--text-muted)', textAlign: 'center' }}>
          Hover over the chart to see the read for that day
        </div>
      )}
    </div>
  );
}

function WeeklyNumberLineChart() {
  const [data, setData] = React.useState(null);
  const [hovered, setHovered] = React.useState(null);
  const [fetchedAt, setFetchedAt] = React.useState(null);
  const hoveredRef = React.useRef(null);
  React.useEffect(() => {
    fetch(`${API_URL}/acd/weekly/numberline`).then(r => r.json()).then(d => { setData(d); setFetchedAt(new Date()); }).catch(console.error);
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
          {fetchedAt && <span style={{ marginLeft: 10 }}><FetchStamp at={fetchedAt} /></span>}
        </div>
        <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>{history.length} weeks</span>
      </div>
      <ResponsiveContainer width="100%" height={180}>
        <ComposedChart data={history} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
          <XAxis dataKey="date" tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
            tickFormatter={d => { const [yr, mo] = d.split('-'); return mo === '01' ? yr : d.slice(5); }}
            interval={Math.floor(history.length / 10)}
          />
          <YAxis tick={{ fontSize: 11, fill: 'var(--text-muted)' }} domain={['auto', 'auto']} />
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
                label={{ value: String(yr), position: 'insideTopLeft', fontSize: 11, fill: 'rgba(255,255,255,0.5)', offset: 4 }} />
            );
          })}
          <Bar dataKey="score" fill="rgba(100,116,139,0.4)" radius={[1,1,0,0]} maxBarSize={10} isAnimationActive={false} />
          <Line type="monotone" dataKey="nl10" stroke="#f59e0b" strokeWidth={1} dot={false} strokeOpacity={0.7} isAnimationActive={false} />
          <Line type="monotone" dataKey="nl30" stroke="#8b5cf6" strokeWidth={2} dot={<CustomDot />} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
      <div style={{ display: 'flex', gap: 20, marginTop: 8, fontSize: 13, color: 'var(--text-muted)', alignItems: 'center' }}>
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
              <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>Week of {hovered.date}</span>
              <span style={{ fontSize: 13, color: '#94a3b8' }}>{scoreLabel}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              <span style={{ fontWeight: 700, color: trendColor, fontSize: 13 }}>{trendLabel}</span>
              <span style={{ color: '#8b5cf6', fontSize: 13 }}>NL30: <strong>{hovered.nl30 > 0 ? '+' : ''}{hovered.nl30}</strong></span>
              <span style={{ color: '#f59e0b', fontSize: 13 }}>NL10: <strong>{hovered.nl10 > 0 ? '+' : ''}{hovered.nl10}</strong></span>
              <span style={{ fontSize: 13, color: '#e2e8f0', flex: 1 }}>{momentum}</span>
              <span style={{ fontSize: 13, fontWeight: 700, color: trendColor, whiteSpace: 'nowrap' }}>{holdRec}</span>
            </div>
          </div>
        );
      })() : (
        <div style={{ marginTop: 10, padding: '8px 14px', background: 'rgba(0,0,0,0.15)', borderRadius: 8, fontSize: 13, color: 'var(--text-muted)', textAlign: 'center' }}>
          Hover over the chart to see the read for that week
        </div>
      )}
    </div>
  );
}

function OvernightContextStrip() {
  // Shared with PermSlipAndStackBar/LivePlaybookCard/EdgeSectionsPanel — was 4
  // independent fetches of the same endpoint on every Morning Prep load, 2026-07-15.
  const isViewActive = useViewActive();
  const [edgesData] = useSharedPollData(isViewActive ? `${API_URL}/antigravity/edges-context` : null, 60000);
  const data = edgesData?.overnightContext;
  const inv = data?.overnight_inventory;
  const ovp = data?.open_vs_prior_value;
  const pdp = data?.prior_day_profile;
  const aligned = (inv === 'SHORT_TRAPPED' && ovp === 'ABOVE_VALUE') || (inv === 'LONG_TRAPPED' && ovp === 'BELOW_VALUE');
  return (
    <div style={{ padding: '8px 12px', borderRadius: 6, background: 'rgba(139,92,246,0.06)', border: `1px solid ${aligned ? 'rgba(34,197,94,0.3)' : 'rgba(139,92,246,0.2)'}`, borderLeft: `3px solid ${aligned ? '#22c55e' : '#a78bfa'}` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: '#a78bfa', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Overnight Structure</span>
        <span style={{ fontSize: 11, color: '#94a3b8' }}>{new Date().toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} ET</span>
      </div>
      {(!inv && !ovp && !pdp) ? (
        <div style={{ fontSize: 12, color: '#475569', fontStyle: 'italic' }}>Loading overnight context…</div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 12 }}>
            {inv && <span>Inventory: <strong style={{ color: inv === 'SHORT_TRAPPED' ? '#22c55e' : inv === 'LONG_TRAPPED' ? '#ef4444' : '#94a3b8' }}>{inv.replace(/_/g, ' ')}</strong></span>}
            {ovp && <span>Open: <strong style={{ color: ovp === 'ABOVE_VALUE' ? '#22c55e' : ovp === 'BELOW_VALUE' ? '#ef4444' : '#94a3b8' }}>{ovp.replace(/_/g, ' ')}</strong></span>}
            {pdp && <span>Prior Day: <strong style={{ color: pdp === 'NONTREND' ? '#fbbf24' : pdp === 'TREND' ? '#22c55e' : '#94a3b8' }}>{pdp}</strong></span>}
          </div>
          <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 4, lineHeight: 1.5 }}>
            {inv === 'LONG_TRAPPED' && 'Yesterday\'s buyers underwater — bearish fuel. '}
            {inv === 'SHORT_TRAPPED' && 'Yesterday\'s sellers squeezed — bullish fuel. '}
            {inv === 'NEUTRAL' && 'No trapped participants. '}
            {ovp === 'BELOW_VALUE' && 'Below yesterday\'s VA — IB_BEARISH 88% WR. '}
            {ovp === 'ABOVE_VALUE' && 'Above yesterday\'s VA — bullish setups 61% WR. '}
            {ovp === 'INSIDE_VALUE' && 'Inside VA — no directional tilt. '}
            {pdp === 'NONTREND' && 'Yesterday balanced — first directional move today is high conviction (61% WR).'}
            {pdp === 'TREND' && 'Yesterday trended — continuation or reversal, wait for OR to confirm.'}
          </div>
          {aligned && <div style={{ fontSize: 12, color: '#22c55e', fontWeight: 700, marginTop: 3 }}>Both aligned — 63% WR (N=113). Size up.</div>}
        </>
      )}
    </div>
  );
}

// Read-only display of the nightly-seeded premarket walkthrough content
// (server/routes/premarketWalkthrough.js, scripts/daily_coaching.js). This backend
// has been generating real content (regime read, DOW-conditioned pattern signals,
// forward-looking watch plan) every weeknight since before this session — it just
// had zero UI ever displaying it (OPEN_DECISION premarket_walkthrough_and_screenshot_upload_orphaned,
// 2026-07-17). Deliberately read-only: the table also has layer1-4_lean/committed_plan
// fields meant for a full interactive guided-reasoning workflow, but that's a real,
// separate UX design decision (how a trader would actually work through 4 reasoning
// layers before market open) that shouldn't be invented unilaterally — this card only
// surfaces what's already being generated for free.
function PremarketWalkthroughCard({ date }) {
  const [data, setData] = useState(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!date) return;
    setLoaded(false);
    fetch(`${API_URL}/premarket-walkthrough/${date}`)
      .then(r => r.json())
      .then(d => { setData(d); setLoaded(true); })
      .catch(() => setLoaded(true));
  }, [date]);

  if (!loaded) return null;
  if (!data) return null; // no seed yet for this date — nothing to show, not an error

  const regimeColor = {
    STRONG_BULL: '#22c55e', MILD_BULL: '#4ade80', NEUTRAL: '#94a3b8',
    MILD_BEAR: '#f87171', STRONG_BEAR: '#ef4444',
  }[data.regime] || '#94a3b8';

  return (
    <div style={{ padding: '8px 12px', borderRadius: 6, background: 'rgba(56,189,248,0.06)', border: '1px solid rgba(56,189,248,0.2)', borderLeft: '3px solid #38bdf8' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: '#38bdf8', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Premarket Walkthrough</span>
        {data.regime && <span style={{ fontSize: 11, fontWeight: 700, color: regimeColor }}>{data.regime.replace(/_/g, ' ')}</span>}
      </div>
      {data.open_notes && (
        <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 4 }}>{data.open_notes}</div>
      )}
      {data.signals_notes && (
        <div style={{ fontSize: 12, color: '#cbd5e1', whiteSpace: 'pre-line', lineHeight: 1.5, marginBottom: 4 }}>
          <span style={{ color: '#64748b' }}>Historical {new Date(date + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })} patterns:</span>{'\n'}{data.signals_notes}
        </div>
      )}
      {data.committed_plan && (
        <div style={{ fontSize: 12, color: '#e2e8f0', marginTop: 4, paddingTop: 4, borderTop: '1px solid rgba(56,189,248,0.15)' }}>
          <span style={{ color: '#38bdf8', fontWeight: 700 }}>Watch: </span>{data.committed_plan}
        </div>
      )}
    </div>
  );
}

function SetupFeedbackForm({ setup, existingFeedback, onSaved }) {
  const [open, setOpen] = React.useState(false);
  const [action, setAction] = React.useState(existingFeedback?.action || '');
  const [tags, setTags] = React.useState(existingFeedback?.tags || []);
  const [note, setNote] = React.useState(existingFeedback?.note || '');
  const [saving, setSaving] = React.useState(false);

  const MGMT_TAGS = ['Good entry', 'Premature exit', 'Held too long', 'Over-sized', 'Under-sized', 'Correct management', 'Missed entry', 'Wrong direction'];
  const toggleTag = t => setTags(prev => prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t]);

  const save = async () => {
    if (!action) return;
    setSaving(true);
    try {
      await fetch(`${API_URL}/acd/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ setupId: setup.id, setupType: setup.setup_type, action, tags, note }),
      });
      onSaved?.();
      setOpen(false);
    } catch (_) {}
    setSaving(false);
  };

  const btnBase = { fontSize: 11, padding: '2px 7px', borderRadius: 3, border: '1px solid', cursor: 'pointer', fontWeight: 700 };
  if (!open) return (
    <button onClick={() => setOpen(true)} style={{ ...btnBase, marginTop: 6, background: 'transparent', borderColor: existingFeedback ? '#6366f1' : 'rgba(100,116,139,0.4)', color: existingFeedback ? '#818cf8' : '#64748b' }}>
      {existingFeedback ? `✓ ${existingFeedback.action}${existingFeedback.tags?.length ? ' · ' + existingFeedback.tags.slice(0,2).join(', ') : ''}` : '+ Feedback'}
    </button>
  );
  return (
    <div style={{ marginTop: 6, padding: '8px 10px', background: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 5 }}>
      <div style={{ display: 'flex', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
        {['TAKEN','PASSED'].map(a => (
          <button key={a} onClick={() => setAction(a)} style={{ ...btnBase, background: action === a ? '#6366f1' : 'transparent', borderColor: action === a ? '#6366f1' : 'rgba(100,116,139,0.4)', color: action === a ? '#fff' : '#94a3b8' }}>{a}</button>
        ))}
        <button onClick={() => setOpen(false)} style={{ ...btnBase, marginLeft: 'auto', background: 'transparent', borderColor: 'transparent', color: '#94a3b8' }}>✕</button>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
        {MGMT_TAGS.map(t => (
          <button key={t} onClick={() => toggleTag(t)} style={{ ...btnBase, fontSize: 11, background: tags.includes(t) ? 'rgba(99,102,241,0.2)' : 'transparent', borderColor: tags.includes(t) ? '#6366f1' : 'rgba(100,116,139,0.3)', color: tags.includes(t) ? '#a5b4fc' : '#64748b' }}>{t}</button>
        ))}
      </div>
      <input value={note} onChange={e => setNote(e.target.value)} placeholder="Optional note..." style={{ width: '100%', background: 'rgba(15,23,42,0.6)', border: '1px solid rgba(51,65,85,0.5)', borderRadius: 4, color: '#cbd5e1', fontSize: 11, padding: '4px 7px', boxSizing: 'border-box', marginBottom: 6 }} />
      <button onClick={save} disabled={!action || saving} style={{ ...btnBase, background: '#6366f1', borderColor: '#6366f1', color: '#fff', opacity: (!action || saving) ? 0.5 : 1 }}>{saving ? 'Saving…' : 'Save'}</button>
    </div>
  );
}

function EdgeSectionsPanel() {
  // Shared with PermSlipAndStackBar/LivePlaybookCard/OvernightContextStrip — was 4
  // independent fetches of the same endpoint on every Morning Prep load, 2026-07-15.
  // This is the fastest-polling subscriber (30s), so it sets the shared cadence.
  const isViewActive = useViewActive();
  const [data, err] = useSharedPollData(isViewActive ? `${API_URL}/antigravity/edges-context` : null, 30000);
  const [showClosed, setShowClosed] = React.useState(false);

  // Shared with PermSlipAndStackBar/App.jsx's LiveSessionPanel — was 3
  // independent fetches of the same endpoint, found 2026-07-15.
  const [setupsTodayData] = useSharedPollData(isViewActive ? `${API_URL}/setups/today` : null, 60000);
  const resolvedSetups = Array.isArray(setupsTodayData?.setups)
    ? setupsTodayData.setups.filter(s => ['RESOLVED', 'EXPIRED'].includes(s.status))
    : [];

  // Shared with SessionBiasPanel's own acd/feedback mount fetch — was 2
  // independent fetchers of the same endpoint, found 2026-07-15. This one stays
  // the canonical 60s poller since SessionBiasPanel only needs one snapshot.
  const feedbackUrl = `${API_URL}/acd/feedback?days=1`;
  const [feedbackData] = useSharedPollData(isViewActive ? feedbackUrl : null, 60000);
  const feedback = feedbackData?.feedback || [];
  const refreshFeedback = () => refreshSharedPollData(feedbackUrl);

  // Must be before early returns — hook call count must be constant across renders
  const feedbackBySetupId = React.useMemo(() => Object.fromEntries(feedback.map(f => [f.setup_id, f])), [feedback]);

  if (err && !data) return <div style={{ fontSize: 12, color: '#ef4444' }}>Edge data error: {err}</div>;
  if (!data) return <div style={{ fontSize: 12, color: '#94a3b8' }}>Loading edge data...</div>;

  const { liveStatus, setups, windows, overnightContext, sessionPermissions, bigMoveSignal, sigmaContinuation, stackVolSignal } = data;
  const last30 = windows?.last30, last90 = windows?.last90, allTime = windows?.allTime;
  const inv = overnightContext?.overnight_inventory;
  const ovp = overnightContext?.open_vs_prior_value;
  const pdp = overnightContext?.prior_day_profile;
  const cellSt = (v) => ({ padding: '6px 10px', fontSize: 12, color: v != null && v >= 60 ? '#22c55e' : v != null && v >= 45 ? '#f59e0b' : '#94a3b8', fontFamily: 'monospace', textAlign: 'center' });

  const dayType = sessionPermissions?.dayType || null;
  // Case engine setup types gated by day_type: show only when day type matches their edge
  const CASE_ENGINE_GATE = {
    'IB_BULLISH':       'TREND',     // 77.8% WR on TREND, -$46.5 on BALANCE
    'C_STANDALONE_UP':  'TREND',     // 63.3% WR on TREND, -$69.9 on BALANCE
    'IB_BEARISH':       'TURBULENT', // 74.2% WR on TURBULENT, -$15 on BALANCE
    'C_STANDALONE_DOWN':'TURBULENT', // 63.3% WR on TURBULENT, -$30 on BALANCE
  };

  const firedTypes = new Set((setups?.list || []).map(s => s.setup_type));
  const potentials = [];
  if (liveStatus?.active) {
    if (liveStatus.gapStatus === 'UP' && !firedTypes.has('GAP_UP_FILL')) potentials.push({ id: 'gap-up', type: 'GAP UP FILL (SHORT)', cond: `Gap up ${liveStatus.gapOpenValue?.toFixed(0)}pts`, dir: 'Fade early highs → yesterday High' });
    if (liveStatus.gapStatus === 'DOWN' && !firedTypes.has('GAP_DOWN_FILL')) potentials.push({ id: 'gap-dn', type: 'GAP DOWN FILL (LONG)', cond: `Gap down ${liveStatus.gapOpenValue?.toFixed(0)}pts`, dir: 'Buy reclaim → yesterday Low' });
    if ((liveStatus.barsCount || 0) <= 120) {
      if (liveStatus.or5Status === 'TIGHT') {
        if (!firedTypes.has('IB_BULLISH')) potentials.push({ id: 'ib-bull', type: 'IB BREAKOUT LONG', cond: `Tight OR (${liveStatus.or5Range?.toFixed(0)}pts)`, dir: 'Break+hold above IB High → 100%/200% expansion' });
        if (!firedTypes.has('IB_BEARISH')) potentials.push({ id: 'ib-bear', type: 'IB BREAKOUT SHORT', cond: `Tight OR (${liveStatus.or5Range?.toFixed(0)}pts)`, dir: 'Break+hold below IB Low → 100%/200% expansion' });
      }
      if (liveStatus.or5Status === 'WIDE' && (liveStatus.range || 0) < (liveStatus.or5Range || 0) * 4) {
        potentials.push({ id: 'trt-l', type: 'TRAPPED SHORTS (TRT LONG)', cond: `Wide OR (${liveStatus.or5Range?.toFixed(0)}pts)`, dir: 'A Down rejects → reclaim OR High' });
        potentials.push({ id: 'trt-s', type: 'TRAPPED LONGS (TRT SHORT)', cond: `Wide OR (${liveStatus.or5Range?.toFixed(0)}pts)`, dir: 'A Up rejects → reclaim OR Low' });
      }
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, fontSize: 12 }}>
      {/* Big-move-day signal — informational only, does not gate any setup. See RESEARCH_CLAIM
          bigmove_realtime_price_progress_promising_volume_weak: a real, monotonic train-split
          lift (+20.3pp vs baseline at this exact threshold) not yet test-confirmed because the
          recent market has been too uniformly volatile to provide a comparison group. */}
      {bigMoveSignal?.active && (
        <div style={{ padding: '10px 14px', background: 'rgba(245,158,11,0.15)', border: '2px solid #f59e0b', borderRadius: 8, color: '#f59e0b', fontWeight: 700, fontSize: 13 }}>
          📈 BIG-MOVE DAY SIGNAL — session range {bigMoveSignal.rangeSoFar}pt already, {bigMoveSignal.minutesRemaining}min left in RTH · historically 57% of days like this finish ≥400pt (vs 37% baseline) · informational only, not a trade signal
        </div>
      )}
      {/* Sigma-continuation signal — RESEARCH_CLAIM sigma_continuation_down_moves. Transient
          (unlike the big-move badge above): only shows if the underlying condition triggered
          within roughly the last 20 minutes (see antigravityEdges.js's recency check). Down
          moves only -- has not been tested for the mirror up-move case. */}
      {sigmaContinuation?.active && (
        <div style={{ padding: '10px 14px', background: 'rgba(239,68,68,0.12)', border: '2px solid #ef4444', borderRadius: 8, color: '#ef4444', fontWeight: 700, fontSize: 13 }}>
          📉 SIGMA CONTINUATION — down move of {sigmaContinuation.sigma}σ detected{sigmaContinuation.expectedExtraPts != null ? ` · historically ~${sigmaContinuation.expectedExtraPts}pt more downside than a random point in time (60min horizon)` : ' · magnitude beyond calibrated range, no specific figure available'} · informational only, not a trade signal
        </div>
      )}
      {/* Stack-break + volume/delta confirmation — RESEARCH_CLAIM
          stack_break_volume_confirmation_promising_not_confirmed. Deliberately the most
          visually urgent of the three informational badges (animated pulse + brighter
          border) because it's the only one of the three that can fire at the START of a
          move (needs one bar, not 60min of realized move or 250pt already covered) — the
          whole point per the user's explicit "catch it intuitively, instantly" directive
          2026-07-27. levelDensity/levels are informational context (how many levels this
          sat under within 40pt) — NOT yet a separately validated factor, only the
          direction/sigma/oneSidedRatio combination has been backtested. */}
      {stackVolSignal?.active && (
        <div style={{ padding: '10px 14px', background: 'rgba(249,115,22,0.15)', border: '2px solid #f97316', borderRadius: 8, color: '#f97316', fontWeight: 700, fontSize: 13, animation: 'pulse 1.2s ease-in-out infinite' }}>
          ⚡ STACK BREAK + VOLUME — {stackVolSignal.direction} confirmed, {stackVolSignal.sigma}σ volume ({Math.round(stackVolSignal.oneSidedRatio * 100)}% one-sided){stackVolSignal.paceZ != null ? ` · pace ${stackVolSignal.paceZ}σ, ${stackVolSignal.consecutiveCount}/5 same-direction` : ''}{stackVolSignal.levelDensity > 0 ? ` · under ${stackVolSignal.levelDensity} levels within 40pt (${stackVolSignal.levels.join(', ')})` : ''}{stackVolSignal.calibratedStop != null ? ` · calibrated stop ${stackVolSignal.calibratedStop}pt (${stackVolSignal.calibratedStopType === 'LEVEL_NEXT' ? 'next level out' : 'fixed fallback'}) / target ${stackVolSignal.calibratedTarget}pt` : ''} · rigor-clean but not yet live-confirmed · informational only, not a trade signal
          {stackVolSignal.manageGuidance && (
            <div style={{ marginTop: 6, fontSize: 12, fontWeight: 500, color: '#fdba74' }}>
              💡 {stackVolSignal.manageGuidance}
            </div>
          )}
        </div>
      )}
      {/* Overnight Structural Context — moved to right column top */}
      {/* Active Setups */}
      <div>
        <div style={{ fontSize: 12, fontWeight: 700, color: '#10b981', marginBottom: 6 }}>
          🎯 Today's Actionable Setups
          {setups?.list?.length > 6 && <span style={{ fontSize: 11, fontWeight: 400, color: '#64748b', marginLeft: 6 }}>({setups.list.length} · scroll)</span>}
        </div>
        {setups?.list?.length > 0 ? (
          <div style={{ maxHeight: 660, overflowY: 'auto', paddingRight: 4, scrollbarWidth: 'thin', scrollbarColor: 'rgba(99,102,241,0.3) transparent' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 8 }}>
            {[...setups.list].sort((a, b) => {
              // Fresh cards (fired ≤10 min ago) bubble to top
              const isFresh = (s) => {
                if (!s.fired_time) return false;
                const [h, m] = s.fired_time.split(':').map(Number);
                const now = new Date();
                const nowET = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
                const firedMin = h * 60 + m;
                const nowMin = nowET.getHours() * 60 + nowET.getMinutes();
                return Math.abs(nowMin - firedMin) <= 10;
              };
              return (isFresh(b) ? 1 : 0) - (isFresh(a) ? 1 : 0);
            }).map(s => {
              // Case engine setups have conditional edge — gate by day type
              const gatedDayType = CASE_ENGINE_GATE[s.setup_type];
              const isGated = gatedDayType != null;
              const dayTypeKnown = !!dayType;
              const isActiveForDayType = !isGated || !dayTypeKnown || dayType === gatedDayType;

              // Fresh = fired within last 10 min → pulse animation
              const isFresh = (() => {
                if (!s.fired_time) return false;
                const [h, m] = s.fired_time.split(':').map(Number);
                const now = new Date();
                const nowET = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
                const firedMin = h * 60 + m;
                const nowMin = nowET.getHours() * 60 + nowET.getMinutes();
                return Math.abs(nowMin - firedMin) <= 10;
              })();

              if (isGated && dayTypeKnown && !isActiveForDayType) {
                return (
                  <div key={s.id} style={{ padding: '5px 10px', borderRadius: 4, background: 'rgba(15,23,42,0.2)', border: '1px solid rgba(51,65,85,0.15)', borderLeft: '3px solid #334155', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 11, color: '#475569', fontWeight: 600 }}>{s.setup_type.replace(/_/g, ' ')}</span>
                    <span style={{ fontSize: 11, color: '#334155' }}>context only · needs {gatedDayType} day</span>
                  </div>
                );
              }

              const cc = s.confidence === 'HIGH' ? '#10b981' : s.confidence === 'MEDIUM' ? '#3b82f6' : s.confidence === 'LOW' ? '#f59e0b' : '#ef4444';
              const edgeCtx = {
                'VALUE_AREA_RESPONSIVE_SHORT': 'Fade 2D VAH. 66.7% WR controlled. Best on BALANCE + NL30 aligned. 15pt stop / 20pt target.',
                'IB_BEARISH': 'IB range break short. 74.2% WR on TURBULENT (N=31). Best on TURBULENT + POC aligned.',
                'IB_BULLISH': 'IB range break long. 77.8% WR on TREND (N=27). Elevated edge today.',
                'OPEN_DRIVE_SHORT': 'Pullback to OR Low after opening drive. 68% WR. Best WED/FRI + tight OR.',
                'OPEN_DRIVE_LONG': 'Pullback to OR High after opening drive. 67% WR. Best TREND + tight OR.',
                'TRT_LONG': 'Trapped shorts reversal. 75% WR at 20 bars. 120-min expiry. Suppress on wide OR.',
                'C_STANDALONE_DOWN': 'C signal break. 63.3% WR on TURBULENT (N=30). Elevated edge today.',
                'C_STANDALONE_UP': 'C signal break. 63.3% WR on TREND (N=30). Elevated edge today.',
                'ABSORPTION_LONG': 'Bullish absorption at support. 71% WR on BALANCE. 2-min bar detection. Runner profile.',
                'EMA_SNAPBACK_LONG': '9 EMA stretch fade long. 96% directional reversion. Scalp toward EMA.',
                'EMA_SNAPBACK_SHORT': '9 EMA stretch fade short. 96% directional reversion. Scalp toward EMA.',
                'COIL_SURGE_LONG': 'Coil + vol surge. Fade toward VWAP. TREND/NL30-aligned only.',
                'COIL_SURGE_SHORT': 'Coil + vol surge. Fade toward VWAP. TREND/NL30-aligned only.',
              }[s.setup_type] || s.recommendation || '';
              const fb = feedbackBySetupId[s.id];
              const isElevated = isGated && dayType === gatedDayType;
              const cardBorderColor = isFresh ? '#fbbf24' : isElevated ? '#f59e0b' : cc;
              return (
                <div key={s.id} className={isFresh ? 'setup-card-fresh' : ''} style={{ padding: '10px 12px', borderRadius: 6, background: isFresh ? 'rgba(251,191,36,0.06)' : isElevated ? 'rgba(245,158,11,0.05)' : 'rgba(15,23,42,0.4)', border: `1px solid ${isElevated ? 'rgba(245,158,11,0.25)' : 'rgba(51,65,85,0.3)'}`, borderLeft: `3px solid ${cardBorderColor}` }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                    <span style={{ fontWeight: 700, color: '#e2e8f0', display: 'flex', alignItems: 'center', gap: 6 }}>
                      {s.setup_type}
                      {isFresh && <span style={{ fontSize: 10, fontWeight: 800, color: '#fbbf24', background: 'rgba(251,191,36,0.15)', padding: '1px 5px', borderRadius: 2, letterSpacing: '0.06em' }}>JUST FIRED</span>}
                      {isElevated && !isFresh && <span style={{ fontSize: 11, fontWeight: 800, color: '#f59e0b', background: 'rgba(245,158,11,0.15)', padding: '1px 5px', borderRadius: 2, marginLeft: 6 }}>{gatedDayType}</span>}
                    </span>
                    <span style={{ fontSize: 11, fontWeight: 800, color: cc, background: `${cc}15`, padding: '1px 6px', borderRadius: 3 }}>{s.confidence}</span>
                  </div>
                  <div style={{ display: 'flex', gap: 12, fontSize: 11, color: '#94a3b8', marginBottom: 4 }}>
                    <span>WR: <strong style={{ color: cc }}>{(s.adjustedWr * 100).toFixed(0)}%</strong> (N={s.sampleN})</span>
                    <span>Fired: {s.fired_time} ET</span>
                  </div>
                  <div style={{ display: 'flex', gap: 12, fontSize: 11, color: '#94a3b8' }}>
                    <span>Entry: {fmtP(s.entry_zone_low, 0)}-{fmtP(s.entry_zone_high, 0)}</span>
                    <span style={{ color: '#f87171' }}>Stop: {fmtP(s.stop_level, 0)}</span>
                    <span style={{ color: '#34d399' }}>T1: {fmtP(s.t1_level, 0)}</span>
                  </div>
                  <div style={{ fontSize: 12, color: '#a78bfa', marginTop: 4, lineHeight: 1.4, fontStyle: 'italic' }}>{edgeCtx}</div>
                  {s.recommendation && s.recommendation !== 'Execute standard risk parameters.' && <div style={{ fontSize: 12, color: '#cbd5e1', marginTop: 2, lineHeight: 1.4 }}>{s.recommendation}</div>}
                  {s.touchQualityStats && (() => {
                    // Mid-trade order-flow signal — only known once this setup's own reaction
                    // window has elapsed (see server/services/touchQuality.js). Informational
                    // only, never affects confidence/recommendation above.
                    const tq = s.touchQualityStats;
                    const label = { HIGH_VOL_ABSORBED: 'Absorbed', HIGH_VOL_OVERRUN: 'Overrun', QUIET: 'Quiet touch' }[tq.bucket] || tq.bucket;
                    const icon = tq.bucket === 'HIGH_VOL_OVERRUN' ? '⚠' : tq.bucket === 'HIGH_VOL_ABSORBED' ? '✓' : '•';
                    const color = tq.ev > 0 ? '#34d399' : tq.ev < 0 ? '#f87171' : '#94a3b8';
                    // rigor.clean === false means this bucket's history is either day-clustered
                    // or chronologically unstable (see server/services/rigorDiagnostics.js) — shown
                    // as a caution dot, not hidden, per that module's own "surface, don't
                    // auto-suppress" convention.
                    const rigorFlag = tq.rigor?.clean === false ? ' ⚠︎' : '';
                    return (
                      <div style={{ fontSize: 11, color, marginTop: 4, fontWeight: 600 }} title={tq.rigor?.clean === false ? 'This bucket\'s history is day-clustered or chronologically unstable — treat directionally, not decisively' : undefined}>
                        {icon} Touch quality: {label} — historically {tq.wr.toFixed(0)}% WR / {tq.ev >= 0 ? '+' : ''}${tq.ev.toFixed(0)} EV (N={tq.n}){rigorFlag}
                      </div>
                    );
                  })()}
                  {s.bar6_checkpoint && (() => {
                    // Bar-6 checkpoint (RESEARCH_CLAIM engagement_bar6_worst_point_passed) —
                    // only known once a still-open position reaches bar 6 without resolving.
                    // Informational only: never gates/delays the original entry, never auto-
                    // adjusts stop/target — a read on a position already held, for the trader
                    // to act on (or not) themselves.
                    const recovering = s.bar6_checkpoint === 'RECOVERING';
                    return (
                      <div style={{ fontSize: 11, color: recovering ? '#34d399' : '#f87171', marginTop: 4, fontWeight: 600 }}
                        title="Historically: worst point already passed by bar 6 → 63-67% WR / +$25 EV. Still deteriorating at bar 6 → 43-47% WR / -$34 EV.">
                        {recovering ? '✓ Bar 6: worst point passed' : '⚠ Bar 6: still deteriorating'} — historically {recovering ? '63-67% WR / +$25 EV' : '43-47% WR / -$34 EV'}
                      </div>
                    );
                  })()}
                  {s.bar6_exit_recommended && (
                    // Distinct, more assertive than the checkpoint badge above -- RESEARCH_CLAIM
                    // target_distance_predictor_real_data_validation_cleared (N=57 real touches,
                    // +$1,260 live-confirmed, 2026-07-26). This system has no order/broker
                    // execution capability -- it can never auto-close anything, so this is still
                    // purely a stronger-worded recommendation, not an automated action.
                    <div style={{ fontSize: 12, color: '#fbbf24', marginTop: 4, fontWeight: 700, background: 'rgba(251,191,36,0.12)', border: '1px solid rgba(251,191,36,0.3)', borderRadius: 4, padding: '3px 6px' }}
                      title="Frozen rule: less than 87.3% of the distance to target still remains at bar 6 -> historically better to take the bar-6 price than hold. N=57 real touches, +$1,260 total, live-confirmed.">
                      🚨 EXIT NOW recommended — take the bar-6 price rather than hold to target
                    </div>
                  )}
                  {s.delta_confirmation_state && (() => {
                    // Cumulative delta confirmation (RESEARCH_CLAIM
                    // cumulative_delta_confirms_breakout_beyond_price_alone /
                    // cumulative_delta_confirms_fades_stronger_than_breakout) — at bar 10
                    // since entry, does cumulative buy/sell-volume delta back up the
                    // favorable price move that's already happened, or is price moving
                    // alone without real order-flow support behind it? Informational only:
                    // does not gate entry, does not adjust the target (both tested
                    // separately and failed) — a read on a position already held.
                    const cfg = {
                      CONFIRMATION: { color: '#34d399', label: '✓ Delta confirms', detail: 'historically 61-83% WR / +$40-43 EV' },
                      PRICE_ONLY_CONTROL: { color: '#f87171', label: '⚠ Price moved, delta didn\'t', detail: 'historically 30-54% WR / -$22-25 EV' },
                      NO_EFFORT: { color: '#94a3b8', label: 'No confirmation yet', detail: 'neither price nor delta built favorably' },
                    }[s.delta_confirmation_state];
                    if (!cfg) return null;
                    return (
                      <div style={{ fontSize: 11, color: cfg.color, marginTop: 4, fontWeight: 600 }}
                        title="At bar 10 since entry: does cumulative delta back up the price move? Validated separately for breakout-continuation and fade setups.">
                        {cfg.label} — {cfg.detail}
                      </div>
                    );
                  })()}
                  {s.hivolLopaceAtDetection && (
                    // RESEARCH_CLAIM hivol_lopace_precursor_confirmed_negative — CONFIRMED
                    // (train/test same-sign both splits, N=1548 full population). High
                    // transactional volume WITHOUT correspondingly large price movement in
                    // the trailing 5 bars before this touch -- the opposite of a "defended
                    // level/absorption" read, historically a real headwind. Informational
                    // only: this app has no order/broker execution capability, so this can
                    // never gate entry or auto-adjust size -- same convention as every other
                    // badge in this family.
                    <div style={{ fontSize: 11, color: '#f87171', marginTop: 4, fontWeight: 600 }}
                      title="Trailing 5 bars into this touch: volume elevated (z>=0.5) but price barely moved (paceZ<1.0) -- historically -$7.91 EV vs +$0.07 control, N=1548, train/test consistent both splits.">
                      ⚠ High volume, low pace into touch — historically a headwind, not absorption
                    </div>
                  )}
                  {s.fadeAgainstBigMoveExit && (
                    // DISABLED 2026-07-27: checkFadeAgainstBigMoveExit() (server/routes/acd.js)
                    // now always returns false, so s.fadeAgainstBigMoveExit is never truthy --
                    // this block is dead in practice, kept only so the JSX doesn't need
                    // restructuring if this is ever re-validated on real data. The original
                    // RESEARCH_CLAIM bigmove_fade_exit_2yr_robustness_confirmed (N=472, $37-46/
                    // trade) was 98.4% BACKFILL/UNKNOWN -- re-checked on real (ACTIVE/SHADOW)
                    // data only and found the trigger condition has occurred ZERO times in the
                    // entire 2-year real trade history. See RESEARCH_CLAIM
                    // bigmove_fade_exit_zero_real_occurrences. Do not re-enable without
                    // re-validating on real data first.
                    <div style={{ fontSize: 12, color: '#fb923c', marginTop: 4, fontWeight: 700, background: 'rgba(251,146,60,0.12)', border: '1px solid rgba(251,146,60,0.3)', borderRadius: 4, padding: '3px 6px' }}
                      title="DISABLED -- zero real-world occurrences found, see bigmove_fade_exit_zero_real_occurrences.">
                      🔶 FADING a big-move day — EXIT NOW recommended
                    </div>
                  )}
                  <SetupFeedbackForm setup={s} existingFeedback={fb} onSaved={refreshFeedback} />
                </div>
              );
            })}
          </div>
          </div>
        ) : <div style={{ fontSize: 11, color: '#94a3b8' }}>No setups active or detected.</div>}
      </div>

      {/* Closed / Resolved Setups */}
      {resolvedSetups.length > 0 && (
        <div>
          <div
            onClick={() => setShowClosed(v => !v)}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', marginBottom: showClosed ? 8 : 0, userSelect: 'none' }}
          >
            <span style={{ fontSize: 12, fontWeight: 700, color: '#94a3b8' }}>
              📋 Closed Today ({resolvedSetups.length})
              {' · '}
              <span style={{ color: '#10b981' }}>{resolvedSetups.filter(s => s.resolution === 'TARGET_HIT').length}W</span>
              {' '}
              <span style={{ color: '#f87171' }}>{resolvedSetups.filter(s => s.resolution === 'STOP_HIT').length}L</span>
              {' · '}
              <span style={{ color: '#a78bfa' }}>${resolvedSetups.reduce((sum, s) => sum + (parseFloat(s.actual_pnl) || 0), 0).toFixed(0)} simulated</span>
            </span>
            <span style={{ fontSize: 11, color: '#94a3b8' }}>{showClosed ? '▲' : '▼'}</span>
          </div>
          {showClosed && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 6 }}>
              {resolvedSetups.map(s => {
                const hit = s.resolution === 'TARGET_HIT';
                const exp = s.resolution === 'TIME_EXPIRED';
                const bc = hit ? '#10b981' : exp ? '#64748b' : '#ef4444';
                const pnl = parseFloat(s.actual_pnl) || 0;
                const firedTime = s.fired_at_str?.slice(11, 16) || '—';
                const resolvedTime = s.resolved_at_str?.slice(11, 16) || '—';
                const fb = feedbackBySetupId[s.id];
                return (
                  <div key={s.id} style={{ padding: '8px 11px', borderRadius: 6, background: 'rgba(15,23,42,0.35)', border: `1px solid ${bc}30`, borderLeft: `3px solid ${bc}` }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                      <span style={{ fontWeight: 700, color: '#cbd5e1', fontSize: 11 }}>{s.setup_type}</span>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <span style={{ fontSize: 11, fontWeight: 800, color: bc }}>{exp ? 'EXPIRED' : hit ? 'HIT ✓' : 'STOPPED ✗'}</span>
                        {pnl !== 0 && <span style={{ fontSize: 11, color: pnl > 0 ? '#10b981' : '#f87171', fontFamily: 'monospace' }}>{pnl > 0 ? '+' : ''}{pnl.toFixed(0)} pts</span>}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 10, fontSize: 11, color: '#94a3b8', marginBottom: 3 }}>
                      <span>Fired {firedTime} → Closed {resolvedTime}</span>
                      <span style={{ color: '#ef4444' }}>Stop {fmtP(s.stop_level, 0)}</span>
                      <span style={{ color: '#34d399' }}>T1 {fmtP(s.t1_level, 0)}</span>
                    </div>
                    <SetupFeedbackForm setup={s} existingFeedback={fb} onSaved={refreshFeedback} />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Potential Watchlist */}
      {potentials.length > 0 && (
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#8b5cf6', marginBottom: 6 }}>👀 Potential Setup Watchlist</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 6 }}>
            {potentials.map(p => (
              <div key={p.id} style={{ padding: '8px 10px', borderRadius: 6, background: 'rgba(15,23,42,0.3)', border: '1px solid rgba(139,92,246,0.15)', borderLeft: '3px solid #8b5cf6' }}>
                <div style={{ fontWeight: 700, color: '#cbd5e1', marginBottom: 2 }}>{p.type}</div>
                <div style={{ fontSize: 12, color: '#94a3b8' }}>{p.cond} — {p.dir}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Dynamic Lookback removed — replaced by nightly pattern scanner */}
    </div>
  );
}



// ==================== PHASE 3: CASE VIEW (MAIN DASHBOARD) ====================
function ACDView({ accounts, selectedAccounts, setSelectedAccounts, setCurrentView, isActive = true }) {
  const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const [tab, setTab] = React.useState(() => {
    return sessionStorage.getItem('acd-dash-tab') || 'dashboard';
  });
  React.useEffect(() => { sessionStorage.setItem('acd-dash-tab', tab); }, [tab]);
  const [nl, setNl] = React.useState(null);
  const [logs, setLogs] = React.useState([]);
  const [pivot, setPivot] = React.useState(null);
  const [loadedAt, setLoadedAt] = React.useState(null);

  // Was 1 of 3 independent fetchers of this exact endpoint (App.jsx's copy turned
  // out to be dead code — fetched but never read, removed; SessionForecastPanel.jsx
  // had its own too) — found 2026-07-15 investigating why this fires 6x per page
  // load. Deduped onto the shared subscription hook.
  const [forecast] = useSharedPollData(`${API_URL}/morning-brief/forecast/${todayET}`, 60000);

  // Shared with LivePlaybookCard.jsx's own /acd/today poll — was 2 independent
  // fetchers of the same endpoint, found 2026-07-15 in the same duplicate-fetch
  // sweep as forecast above.
  const [todayData] = useSharedPollData(isActive ? `${API_URL}/acd/today` : null, 30000);

  const loadAll = React.useCallback(() => {
    Promise.all([
      fetch(`${API_URL}/acd/numberline`).then(r => r.json()).then(setNl).catch(console.error),
      fetch(`${API_URL}/acd/daily?days=60`).then(r => r.json()).then(setLogs).catch(console.error),
      fetch(`${API_URL}/acd/pivot/current`).then(r => r.json()).then(setPivot).catch(console.error),
    ]).then(() => setLoadedAt(new Date()));
  }, []);

  React.useEffect(() => { loadAll(); }, [loadAll]);

  const tabStyle = (t) => ({
    padding: '7px 18px', border: 'none', borderRadius: '6px 6px 0 0', cursor: 'pointer', fontSize: 13, fontWeight: 600,
    background: tab === t ? 'var(--card-bg)' : 'transparent',
    color: tab === t ? 'var(--text-primary)' : 'var(--text-muted)',
    borderBottom: tab === t ? '2px solid #3b82f6' : '2px solid transparent',
  });

  return (
    <ViewActiveProvider value={isActive}>
    <div style={{ fontFamily: 'Arial, sans-serif', fontSize: 13, color: '#94a3b8' }}>

      {/* ── Market Pulse Bar — always on top ── */}
      <MarketPulseBar />
      <PermSlipAndStackBar />

      <div style={{ padding: '12px 20px' }}>
      <div style={{ marginBottom: 12 }}>
        <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>Dashboard</h2>
      </div>

      <div style={{ display: 'flex', gap: 2, marginBottom: 0, borderBottom: '1px solid var(--border-color)' }}>
        {[['dashboard', 'Dashboard'], ['chart', 'NL Chart']].map(([t, label]) => (
          <button key={t} onClick={() => setTab(t)} style={tabStyle(t)}>{label}</button>
        ))}
      </div>

      <div style={{ paddingTop: 20 }}>
        {tab === 'dashboard' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

            {/* ── Alerts ── */}
            <VolatilityAlertBanner />
            <TradeAlertBanner />
            {forecast?.isMacroDay && (
              <div style={{ padding: '10px 16px', background: 'rgba(234, 88, 12, 0.15)', border: '1px solid rgba(234, 88, 12, 0.4)', borderRadius: 8, color: '#fb923c', fontSize: 13, fontWeight: 700 }}>
                ⚠️ MACRO OVERRIDE ACTIVE: {forecast.macroEvents.map(e => e.event_type).join(' + ')} — calendar DOW stats are secondary.
              </div>
            )}

            {/* ── Main console grid: 3 fixed columns ── */}
            {/* Col 1: session intel | Col 2: analysis + newsfeed + briefs | Col 3: live setups */}
            {/* Breakpoints: ≥1400px = 3-col / 900–1399px = 2-col / <900px = 1-col */}
            <div style={{ display: 'grid', gridTemplateColumns: '22fr 28fr 50fr', gap: 14, alignItems: 'start' }}>

              {/* Col 1: Live market data — updates every bar */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, background: 'rgba(8,12,24,0.7)', borderRadius: 8, padding: 10 }}>
                {/* SessionPulseCard removed from here 2026-07-16 — was rendering
                    twice simultaneously with App.jsx's always-visible sidebar copy
                    whenever this tab was open (found via screenshot, user report).
                    The sidebar copy already covers every view, so this one was pure
                    duplication, not a distinct instance. */}
                <ErrorBoundary name="Volatility Regime" compact>
                  <VolatilityRegimeCard />
                </ErrorBoundary>
              </div>

              {/* Col 2: Stats + Patterns + Newsfeed + Briefs below the feed */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, background: 'rgba(12,18,36,0.65)', borderRadius: 8, padding: 10 }}>
                <ErrorBoundary name="Day-of-Week Playbook">
                  <DayOfWeekPlaybookCard todayData={todayData} forecast={forecast} />
                </ErrorBoundary>
                <ErrorBoundary name="Session Signals">
                  <SessionBiasPanel />
                </ErrorBoundary>
                <ErrorBoundary name="Behavioral Patterns">
                  <BehavioralPatternsCard />
                </ErrorBoundary>
                <ErrorBoundary name="Live Commentary">
                  <TeleprinterFeed maxHeight={280} />
                </ErrorBoundary>
                {/* ── Morning/afternoon scripts + overnight brief go below the newsfeed ── */}
                <ErrorBoundary name="Scripts">
                  <SessionForecastPanel date={todayET} section="scripts" />
                </ErrorBoundary>
                <ErrorBoundary name="Overnight Context">
                  <OvernightContextStrip />
                </ErrorBoundary>
                <ErrorBoundary name="Premarket Walkthrough">
                  <PremarketWalkthroughCard date={todayET} />
                </ErrorBoundary>
              </div>

              {/* Col 3: Live execution — near-black so green/red signals pop */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, background: 'rgba(4,6,14,0.85)', borderRadius: 8, padding: 10 }}>
                <ErrorBoundary name="Live Playbook">
                  <LivePlaybookCard date={todayET} />
                </ErrorBoundary>
                <ApproachingLevelBanner />
                <ErrorBoundary name="Edge Sections" compact>
                  <EdgeSectionsPanel />
                </ErrorBoundary>
              </div>

            </div>


          </div>
        )}
        {tab === 'chart' && (
          <div>
            <CollapsibleSection title="30-Day Number Line History" defaultOpen>
              <NumberLineChart />
            </CollapsibleSection>
            <CollapsibleSection title="Weekly Number Line" defaultOpen>
              <WeeklyNumberLineChart />
            </CollapsibleSection>
          </div>
        )}
      </div>
      </div>{/* end padding wrapper */}
    </div>
    </ViewActiveProvider>
  );
}



// QuickTradeLog/SystemHealthSummary now live in components/dashboard/QuickTradeLog.jsx
// (extracted 2026-07-13 so this default export could be lazy-loaded — see App.jsx).
export default ACDView;
