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
import AntigravityEdgesView from '../components/dashboard/AntigravityEdgesView.jsx';
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
        <div><div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 3 }}>Date</div>
          <input type="date" value={form.trade_date} onChange={e => set('trade_date', e.target.value)} style={{ ...inputStyle, width: 140 }} />
        </div>
        <div><div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 3 }}>OR High</div>
          <input type="number" value={form.or_high} onChange={e => set('or_high', e.target.value)} placeholder="OR High" style={{ ...inputStyle, width: 90 }} />
        </div>
        <div><div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 3 }}>OR Low</div>
          <input type="number" value={form.or_low} onChange={e => set('or_low', e.target.value)} placeholder="OR Low" style={{ ...inputStyle, width: 90 }} />
        </div>
        <div><div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 3 }}>A Multiplier</div>
          <input type="number" step="0.01" value={form.a_multiplier} onChange={e => set('a_multiplier', parseFloat(e.target.value))} style={{ ...inputStyle, width: 80 }} />
        </div>
        <div><div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 3 }}>Session Close</div>
          <input type="number" value={form.session_close} onChange={e => set('session_close', e.target.value)} placeholder="Close" style={{ ...inputStyle, width: 90 }} />
        </div>
      </div>

      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 6 }}>What happened today?</div>
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
        <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 6 }}>Profile Shape <span style={{ color: '#94a3b8' }}>(tap after session — leave blank if unsure)</span></div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {[['ELONGATED','Elongated','#f97316'],['FAT','Fat / Balanced','#3b82f6'],['SQUAT','Squat','#fbbf24'],['NONSYMMETRIC_TOP','Top Heavy','#a78bfa'],['NONSYMMETRIC_BOTTOM','Bottom Heavy','#ec4899']].map(([val, label, color]) => (
            <button key={val} onClick={() => set('profile_shape', form.profile_shape === val ? null : val)}
              style={{ padding: '4px 10px', fontSize: 13, borderRadius: 5, cursor: 'pointer', fontWeight: 600, border: `1px solid ${form.profile_shape === val ? color : 'var(--border-color)'}`, background: form.profile_shape === val ? `${color}20` : 'var(--input-bg)', color: form.profile_shape === val ? color : 'var(--text-muted)' }}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 3 }}>Notes</div>
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
  const scoreColor = s => s > 0 ? '#22c55e' : s < 0 ? '#ef4444' : '#64748b';
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ borderBottom: '2px solid var(--border-color)' }}>
            {['Date', 'OR High', 'OR Low', 'A Up', 'A Down', 'Signal', 'Score', 'Close', 'Notes'].map(h => (
              <th key={h} style={{ padding: '8px 10px', textAlign: 'left', color: 'var(--text-muted)', fontWeight: 600, fontSize: 13 }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {logs.map(d => {
            const signal = d.a_up_fired && d.c_up_confirmed ? 'A Up + C' : d.a_up_fired ? 'A Up' : d.a_down_fired && d.c_down_confirmed ? 'A Dn + C' : d.a_down_fired ? 'A Down' : '—';
            const sigColor = d.a_up_fired ? '#22c55e' : d.a_down_fired ? '#ef4444' : '#64748b';
            return (
              <tr key={d.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                <td style={{ padding: '7px 10px', fontFamily: 'monospace', fontSize: 13 }}>{d.trade_date?.toString().slice(0, 10)}</td>
                <td style={{ padding: '7px 10px', fontFamily: 'monospace' }}>{d.or_high ? fmtP(parseFloat(d.or_high), 2) : '—'}</td>
                <td style={{ padding: '7px 10px', fontFamily: 'monospace' }}>{d.or_low ? fmtP(parseFloat(d.or_low), 2) : '—'}</td>
                <td style={{ padding: '7px 10px', fontFamily: 'monospace', color: '#22c55e' }}>{d.a_up_level ? fmtP(parseFloat(d.a_up_level), 2) : '—'}</td>
                <td style={{ padding: '7px 10px', fontFamily: 'monospace', color: '#ef4444' }}>{d.a_down_level ? fmtP(parseFloat(d.a_down_level), 2) : '—'}</td>
                <td style={{ padding: '7px 10px', fontWeight: 600, color: sigColor }}>{signal}</td>
                <td style={{ padding: '7px 10px', fontFamily: 'monospace', fontWeight: 700, color: scoreColor(d.daily_score) }}>
                  {d.daily_score > 0 ? '+' : ''}{d.daily_score}
                </td>
                <td style={{ padding: '7px 10px', fontFamily: 'monospace' }}>{d.session_close ? fmtP(parseFloat(d.session_close), 2) : '—'}</td>
                <td style={{ padding: '7px 10px', color: 'var(--text-muted)', fontSize: 13, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.notes || ''}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}


function ACDBacktestRunner() {
  const [job, setJob] = React.useState({ status: 'idle' });
  const [results, setResults] = React.useState([]);
  const [csvFile, setCsvFile] = React.useState(null);
  const [activePeriod, setActivePeriod] = React.useState('last-30d');
  const [lastRun, setLastRun] = React.useState(null);
  const [fetchedAt, setFetchedAt] = React.useState(null);
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
        setFetchedAt(new Date());
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
            style={{ padding: '8px 16px', background: job.status === 'running' ? '#64748b' : '#3b82f6', border: 'none', borderRadius: 7, color: '#fff', fontWeight: 600, fontSize: 13, cursor: job.status === 'running' ? 'not-allowed' : 'pointer' }}>
            {job.status === 'running' && !job.progress?.days ? 'Running…' : 'All History'}
          </button>
          <button onClick={() => handleRun(30)} disabled={job.status === 'running'}
            style={{ padding: '8px 16px', background: job.status === 'running' ? '#64748b' : '#8b5cf6', border: 'none', borderRadius: 7, color: '#fff', fontWeight: 600, fontSize: 13, cursor: job.status === 'running' ? 'not-allowed' : 'pointer' }}>
            {job.status === 'running' && job.progress?.days === 30 ? 'Running…' : 'Last 30 Days'}
          </button>
          <button onClick={() => handleRun(60)} disabled={job.status === 'running'}
            style={{ padding: '8px 16px', background: job.status === 'running' ? '#64748b' : '#06b6d4', border: 'none', borderRadius: 7, color: '#fff', fontWeight: 600, fontSize: 13, cursor: job.status === 'running' ? 'not-allowed' : 'pointer' }}>
            {job.status === 'running' && job.progress?.days === 60 ? 'Running…' : 'Last 60 Days'}
          </button>
          {job.status === 'running' && job.progress && (
            <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>{job.progress.done} / {job.progress.total} combinations</span>
          )}
          {job.status === 'running' && job.progress && (
            <div style={{ width: 160, height: 6, background: 'var(--border-color)', borderRadius: 3, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${job.progress.done / job.progress.total * 100}%`, background: '#3b82f6', borderRadius: 3, transition: 'width 0.3s' }} />
            </div>
          )}
          {job.status === 'error' && <span style={{ fontSize: 13, color: '#ef4444' }}>{job.error}</span>}
          {job.status === 'complete' && <span style={{ fontSize: 13, color: '#22c55e' }}>Complete — results saved</span>}
        </div>
      </div>

      {results.length > 0 && (
        <div style={{ background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderRadius: 12, padding: '20px 24px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <div>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-muted)', letterSpacing: '0.05em', textTransform: 'uppercase' }}>
                Results (ranked by EV/signal)
              </span>
              {fetchedAt && <span style={{ marginLeft: 10 }}><FetchStamp at={fetchedAt} /></span>}
              {lastRun && (
                <span style={{ marginLeft: 12, fontSize: 13, color: 'var(--text-muted)' }}>
                  Last run: {lastRun}
                </span>
              )}
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              {[['all-time', 'All History'], ['last-30d', 'Last 30 Days'], ['last-60d', 'Last 60 Days']].map(([p, label]) => (
                <button key={p} onClick={() => { setActivePeriod(p); loadResults(p); }}
                  style={{ padding: '3px 10px', fontSize: 13, borderRadius: 5, cursor: 'pointer', border: '1px solid var(--border-color)',
                    background: activePeriod === p ? '#3b82f6' : 'var(--input-bg)',
                    color: activePeriod === p ? '#fff' : 'var(--text-muted)' }}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
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
                    <td style={{ padding: '6px 8px', fontSize: 13, whiteSpace: 'nowrap' }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 3, color: r.filter_label === 'baseline' ? 'var(--text-muted)' : '#f59e0b' }}>
                        {r.filter_label || 'baseline'}
                        <InfoTooltip text={filterTips[r.filter_label] || filterTips['baseline']} />
                      </span>
                    </td>
                    <td style={{ padding: '6px 8px', fontFamily: 'monospace' }}>{r.or_minutes}</td>
                    <td style={{ padding: '6px 8px', fontFamily: 'monospace' }}>{fmtP(parseFloat(r.a_multiplier), 2)}</td>
                    <td style={{ padding: '6px 8px', fontFamily: 'monospace' }}>{r.sustain_minutes}</td>
                    <td style={{ padding: '6px 8px', fontFamily: 'monospace' }}>{r.total_signals}</td>
                    <td style={{ padding: '6px 8px', fontFamily: 'monospace', color: parseFloat(r.win_rate) >= 0.55 ? '#22c55e' : parseFloat(r.win_rate) >= 0.45 ? '#fbbf24' : '#ef4444' }}>{pct(r.win_rate)}</td>
                    <td style={{ padding: '6px 8px', fontFamily: 'monospace', color: '#22c55e' }}>{r.avg_win_r ? fmtP(parseFloat(r.avg_win_r), 2) + 'R' : '—'}</td>
                    <td style={{ padding: '6px 8px', fontFamily: 'monospace', color: '#ef4444' }}>{r.avg_loss_r ? fmtP(parseFloat(r.avg_loss_r), 2) + 'R' : '—'}</td>
                    <td style={{ padding: '6px 8px', fontFamily: 'monospace' }}>{r.payoff_ratio ? fmtP(parseFloat(r.payoff_ratio), 2) : '—'}</td>
                    <td style={{ padding: '6px 8px', fontFamily: 'monospace', fontWeight: i < 3 ? 700 : 400, color: parseFloat(r.ev_per_signal) >= 0 ? '#22c55e' : '#ef4444' }}>{ev(r.ev_per_signal)}</td>
                    <td style={{ padding: '6px 8px', fontFamily: 'monospace' }}>{r.profit_factor ? fmtP(parseFloat(r.profit_factor), 2) : '—'}</td>
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
              Best parameters: <strong>OR {results[0].or_minutes} min · A multiplier {fmtP(parseFloat(results[0].a_multiplier), 2)} · Sustain {results[0].sustain_minutes} min</strong>
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

function ACDAutoPanel({ onComplete }) {
  const [params, setParams] = React.useState({ or_minutes: 5, a_multiplier: 0.25, sustain_minutes: 5 });
  const [bestInfo, setBestInfo] = React.useState(null);
  const [fetchedAt, setFetchedAt] = React.useState(null);

  React.useEffect(() => {
    fetch(`${API_URL}/risk/settings`)
      .then(r => r.json())
      .then(s => {
        if (s.acd_a_multiplier) {
          setParams({ or_minutes: s.acd_or_minutes || 5, a_multiplier: parseFloat(s.acd_a_multiplier) || 0.25, sustain_minutes: s.acd_sustain_minutes || 5 });
          setBestInfo({ period: s.acd_best_params_period, ev: s.acd_best_params_ev });
        }
        setFetchedAt(new Date());
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
      setTodayStatus(`done: OR ${fmtP(parseFloat(d.orHigh))}–${fmtP(parseFloat(d.orLow))}, ${sig}`);
      if (onComplete) onComplete();
    } catch(e) { setTodayStatus(`error: ${e.message}`); }
  };

  const autoPivot = async () => {
    setPivotStatus('running');
    try {
      const r = await fetch(`${API_URL}/acd/pivot/autocompute`, { method: 'POST' });
      const d = await r.json();
      if (d.error) { setPivotStatus(`error: ${d.error}`); return; }
      setPivotStatus(`done: pivot ${fmtP(parseFloat(d.pivot_level), 2)}, R1 ${fmtP(parseFloat(d.pivot_r1), 2)}, S1 ${fmtP(parseFloat(d.pivot_s1), 2)}`);
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
      <div style={{ fontSize: 13, fontWeight: 600, color: '#3b82f6', marginBottom: 12 }}>Auto-Compute from Price Bars
        {fetchedAt && <span style={{ marginLeft: 10, fontWeight: 400 }}><FetchStamp at={fetchedAt} /></span>}
      </div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 14, alignItems: 'flex-end' }}>
        {[['or_minutes', 'OR Min', 'number', '1', '15'], ['a_multiplier', 'A Mult', 'number', '0.01', '1'], ['sustain_minutes', 'Sustain Min', 'number', '1', '10']].map(([k, label, type, min, max]) => (
          <div key={k}><div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 3 }}>{label}</div>
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
          <span style={{ fontSize: 13, color: todayStatus.startsWith('error') ? '#ef4444' : '#22c55e' }}>{todayStatus}</span>
        )}

        <button onClick={autoPivot} disabled={pivotStatus === 'running'} style={btnStyle('#3b82f6')}>
          Auto Monthly Pivot
        </button>
        {pivotStatus && pivotStatus !== 'running' && (
          <span style={{ fontSize: 13, color: pivotStatus.startsWith('error') ? '#ef4444' : '#22c55e' }}>{pivotStatus}</span>
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
          <span style={{ fontSize: 13, color: '#22c55e' }}>Backfilled {bulkJob.total} days</span>
        )}
        {bulkJob.status === 'error' && (
          <span style={{ fontSize: 13, color: '#ef4444' }}>{bulkJob.error}</span>
        )}
      </div>

      <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 10 }}>
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

function BacktestedEdgeStatsCard() {
  const setups = [
    { name: 'VWAP Magnet', wr: '62%', delta: '+12% edge', color: '#94a3b8', status: 'CONTEXT', tip: 'Price 25% of range from VWAP → fade toward VWAP. 62% WR (N=460). Shadow-tracked only (not a primary entry). Self-scaling threshold. Best on BALANCE days (79% WR). 20pt target, 30pt stop.' },
    { name: 'PD_POC Fade', wr: '85%', delta: '$38/trade', color: '#10b981', status: 'ACTIVE', tip: 'Fade at prior day POC. 85% WR (N=40). 90pt stop, 40pt target. System anchor — 22% of total P&L. AM first touch.' },
    { name: '5D OR MID Fade', wr: '94%', delta: '$64/trade', color: '#10b981', status: 'ACTIVE', tip: 'Fade at 5-day rolling OR midpoint. 94% WR (N=17). Best level by EV. Rolling composite smooths outlier days.' },
    { name: 'PD VAL Fade', wr: '82%', delta: '$31/trade', color: '#10b981', status: 'ACTIVE', tip: 'Fade at prior day VAL. 82% WR (N=27). 90pt stop, 40pt target. AM session.' },
    { name: 'PD IB MID Fade', wr: '83%', delta: '$36/trade', color: '#10b981', status: 'ACTIVE', tip: 'Fade at prior day IB midpoint. 83% WR (N=18). Tightest MAE (20pt). Clean level.' },
    { name: 'PD VAH Fade', wr: '77%', delta: '$17/trade', color: '#34d399', status: 'ACTIVE', tip: 'Fade at prior day VAH. 77% WR (N=47). High frequency. AM session.' },
    { name: 'Floor Pivot Fade', wr: '80%', delta: '$16/trade', color: '#34d399', status: 'ACTIVE', tip: 'Fade at Floor Pivot. 80% WR (N=35). Structural reference level.' },
    { name: 'OR High Fade', wr: '77%', delta: '$14/trade', color: '#34d399', status: 'ACTIVE', tip: 'Fade at OR High. 77% WR (N=30). 90pt stop, 40pt target. AM only.' },
    { name: 'Floor R1 Fade', wr: '77%', delta: '$17/trade', color: '#34d399', status: 'ACTIVE', tip: 'Fade at Floor R1. 77% WR (N=22). Thursday 1PM specialist.' },
    { name: 'PD OR MID Fade', wr: '80%', delta: '$15/trade', color: '#34d399', status: 'ACTIVE', tip: 'Fade at prior day OR midpoint. 80% WR (N=20). AM session.' },
    { name: 'OPEN_DRIVE', wr: '40-52%', delta: 'CONTEXT', color: '#94a3b8', status: 'CONTEXT', tip: 'Directional context only. Negative EV as mechanical entry (-$25 to -$44/trade). Use for lean.' },
    { name: 'IB_BEARISH', wr: '54%', delta: 'CONTEXT', color: '#94a3b8', status: 'CONTEXT', tip: 'Directional context only — 54% directional accuracy. Not a trade entry. Use to lean short, then enter at KEEP levels.' },
    { name: 'TRT_LONG', wr: '75%@20bar', delta: '+24% edge', color: '#94a3b8', status: 'CONTEXT', tip: 'A+C failed, price through OR. 75% WR at 20 bars (not 10) — slow burn reversal. Shadow-tracked only. 120 min expiry. High MAE (143pt). Suppressed on wide OR.' },
  ];

  const removed = [
    { name: 'OTD_SHORT', edge: '-5.6%', status: 'REMOVED', color: '#ef4444' },
    { name: 'OTD_LONG', edge: '-20%', status: 'REMOVED', color: '#ef4444' },
    { name: 'IB_BULLISH', edge: '-7.5%', status: 'REMOVED', color: '#ef4444' },
    { name: 'C_STANDALONE_UP', edge: '-6.5%', status: 'REMOVED', color: '#ef4444' },
    { name: 'VA_RESP_LONG', edge: '-5.0%', status: 'REMOVED', color: '#ef4444' },
    { name: 'TRT_SHORT', edge: '-10.1%', status: 'REMOVED', color: '#ef4444' },
    { name: 'BRACKET_BK_LONG', edge: '-14%', status: 'REMOVED', color: '#ef4444' },
    { name: 'BRACKET_BK_SHORT', edge: '-100%', status: 'REMOVED', color: '#ef4444' },
    { name: 'TRT_MAH_SHORT', edge: '-13%', status: 'REMOVED', color: '#ef4444' },
    { name: 'FAILED_AUCTION', edge: '0% WR', status: 'REMOVED', color: '#ef4444' },
  ];

  return (
    <div style={{ padding: '8px 16px' }}>
      <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 10 }}>Controlled tests, 12mo NQ (2025-2026).</div>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 240px', minWidth: 220 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#cbd5e1', borderBottom: '1px solid rgba(51,65,85,0.25)', paddingBottom: 4, marginBottom: 6 }}>RANKED ACTIVE SETUPS</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 11, color: '#94a3b8' }}>
            {setups.map((s, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '2px 0' }} title={s.tip}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  {s.name}
                  <span style={{ fontSize: 11, fontWeight: 800, color: s.status === 'ACTIVE' ? '#10b981' : '#f59e0b', background: s.status === 'ACTIVE' ? 'rgba(16,185,129,0.12)' : 'rgba(245,158,11,0.12)', padding: '0 4px', borderRadius: 2 }}>{s.status}</span>
                </span>
                <span style={{ display: 'flex', gap: 6 }}>
                  <span style={{ color: s.color, fontWeight: 700 }}>{s.wr}</span>
                  <span style={{ color: '#94a3b8', fontSize: 11 }}>{s.delta}</span>
                </span>
              </div>
            ))}
          </div>
        </div>

        <div style={{ flex: '1 1 200px', minWidth: 180 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#cbd5e1', borderBottom: '1px solid rgba(51,65,85,0.25)', paddingBottom: 4, marginBottom: 6 }}>REMOVED / SHADOW TRACKED</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 11 }}>
            {removed.map((s, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '1px 0', color: '#94a3b8' }}>
                <span>{s.name}</span>
                <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  <span style={{ color: '#ef4444', fontWeight: 600, fontSize: 11 }}>{s.edge}</span>
                  <span style={{ fontSize: 7, color: '#ef4444', background: 'rgba(239,68,68,0.12)', padding: '0 3px', borderRadius: 2, fontWeight: 700 }}>SHADOW</span>
                </span>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 8, paddingTop: 4, borderTop: '1px solid rgba(51,65,85,0.2)' }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#cbd5e1', marginBottom: 4 }}>CONFLUENCE COUNT EFFECT</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 12, color: '#94a3b8' }}>
              <div>0 levels: <span style={{ color: '#94a3b8' }}>48.2% WR</span></div>
              <div>2+ levels: <span style={{ color: '#94a3b8' }}>45.0% WR, better MAE</span></div>
              <div>4+ levels: <span style={{ color: '#34d399', fontWeight: 700 }}>57.9% WR</span></div>
            </div>
          </div>
        </div>
      </div>
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

  const { liveStatus, setups, windows, overnightContext, sessionPermissions, cascadeBreaker } = data;
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
      {/* Cascade Breaker Banner */}
      {cascadeBreaker?.active && (
        <div style={{ padding: '10px 14px', background: 'rgba(239,68,68,0.15)', border: '2px solid #ef4444', borderRadius: 8, color: '#ef4444', fontWeight: 700, fontSize: 13 }}>
          ⛔ FADE REGIME OFF — {cascadeBreaker.stopCount} different levels stopped out in {cascadeBreaker.windowMins} min · tape is trending · no new fade entries
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



// ── Phase Change Backtest Panel (Steps 12 & 13) ─────────────────────────────
function PhaseChangeBacktestPanel() {
  const [results, setResults] = React.useState(null);
  const [fwdTest, setFwdTest] = React.useState(null);
  const [fetchedAt, setFetchedAt] = React.useState(null);
  const [jobId, setJobId] = React.useState(null);
  const [jobStatus, setJobStatus] = React.useState(null);
  const [showParams, setShowParams] = React.useState(false);
  const [params, setParams] = React.useState({
    proximityPoints: 20, minConditions: 3, volumeLookback: 3,
    deltaLookback: 5, rangeLookback: 3, forwardWindowMinutes: 30,
    reversalThresholdPoints: 15, startDate: '', endDate: '',
  });

  React.useEffect(() => {
    Promise.all([
      fetch(`${API_URL}/phase-change/backtest/results`).then(r => r.json()).then(setResults).catch(() => {}),
      fetch(`${API_URL}/phase-change/forward-test`).then(r => r.json()).then(setFwdTest).catch(() => {}),
    ]).then(() => setFetchedAt(new Date()));
  }, []);

  React.useEffect(() => {
    if (!jobId || jobStatus === 'complete' || jobStatus === 'error') return;
    const iv = setInterval(async () => {
      const s = await fetch(`${API_URL}/phase-change/backtest/status/${jobId}`).then(r => r.json()).catch(() => null);
      if (!s) return;
      setJobStatus(s.status);
      if (s.status === 'complete') {
        clearInterval(iv);
        const r = await fetch(`${API_URL}/phase-change/backtest/results`).then(r => r.json());
        setResults(r);
        const f = await fetch(`${API_URL}/phase-change/forward-test`).then(r => r.json());
        setFwdTest(f);
        setFetchedAt(new Date());
      }
    }, 2000);
    return () => clearInterval(iv);
  }, [jobId, jobStatus]);

  const runBacktest = async () => {
    const r = await fetch(`${API_URL}/phase-change/backtest/run`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    }).then(r => r.json());
    setJobId(r.jobId);
    setJobStatus('running');
  };

  const pct = (n) => n != null ? `${(n * 100).toFixed(0)}%` : '—';
  const pts = (n) => n != null ? `${fmtP(parseFloat(n))} pts` : '—';
  const sep = { borderBottom: '1px solid #1e293b', paddingBottom: 14, marginBottom: 14 };
  const thStyle = { fontSize: 13, color: '#94a3b8', fontWeight: 600, textAlign: 'right', paddingBottom: 4 };
  const tdStyle = { fontSize: 13, color: 'var(--text-primary)', fontFamily: 'monospace', textAlign: 'right', padding: '3px 0' };

  const parseCombo = (raw) => {
    if (!raw) return {};
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  };

  const byLevel = results ? parseCombo(results.results_by_level) : {};

  return (
    <div style={{ background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderRadius: 12, padding: '20px 24px', marginTop: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>PHASE CHANGE BACKTEST</span>
        {results && <span style={{ fontSize: 12, color: '#94a3b8' }}>Last run: {new Date(results.run_date).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>}
        {fetchedAt && <FetchStamp at={fetchedAt} />}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button onClick={() => setShowParams(p => !p)} style={{ fontSize: 12, padding: '4px 12px', borderRadius: 6, cursor: 'pointer', background: 'transparent', border: '1px solid var(--border-color)', color: 'var(--text-muted)' }}>
            {showParams ? 'Hide' : 'Adjust'} Parameters
          </button>
          <button onClick={runBacktest} disabled={jobStatus === 'running'} style={{ fontSize: 12, padding: '4px 14px', borderRadius: 6, cursor: 'pointer', background: '#1e40af', border: 'none', color: '#fff', opacity: jobStatus === 'running' ? 0.6 : 1 }}>
            {jobStatus === 'running' ? 'Running…' : 'Run Backtest'}
          </button>
        </div>
      </div>

      {showParams && (
        <div style={{ background: '#0f172a', borderRadius: 8, padding: '12px 16px', marginBottom: 16, display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px 16px' }}>
          {[
            ['proximityPoints', 'Proximity (pts)', 1], ['minConditions', 'Min conditions', 1],
            ['volumeLookback', 'Volume lookback (bars)', 1], ['deltaLookback', 'Delta lookback (bars)', 1],
            ['rangeLookback', 'Range lookback (bars)', 1], ['forwardWindowMinutes', 'Forward window (min)', 1],
            ['reversalThresholdPoints', 'Reversal threshold (pts)', 1],
          ].map(([key, label, step]) => (
            <label key={key} style={{ fontSize: 12, color: '#cbd5e1' }}>
              {label}
              <input type="number" step={step} value={params[key]}
                onChange={e => setParams(p => ({ ...p, [key]: e.target.value }))}
                style={{ display: 'block', width: '100%', fontSize: 12, padding: '3px 6px', background: '#1e293b', border: '1px solid #334155', borderRadius: 4, color: 'var(--text-primary)', marginTop: 2 }} />
            </label>
          ))}
          <label style={{ fontSize: 12, color: '#cbd5e1' }}>
            Start date
            <input type="date" value={params.startDate} onChange={e => setParams(p => ({ ...p, startDate: e.target.value }))}
              style={{ display: 'block', width: '100%', fontSize: 12, padding: '3px 6px', background: '#1e293b', border: '1px solid #334155', borderRadius: 4, color: 'var(--text-primary)', marginTop: 2 }} />
          </label>
          <label style={{ fontSize: 12, color: '#cbd5e1' }}>
            End date
            <input type="date" value={params.endDate} onChange={e => setParams(p => ({ ...p, endDate: e.target.value }))}
              style={{ display: 'block', width: '100%', fontSize: 12, padding: '3px 6px', background: '#1e293b', border: '1px solid #334155', borderRadius: 4, color: 'var(--text-primary)', marginTop: 2 }} />
          </label>
        </div>
      )}

      {results && (
        <>
          <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 14 }}>
            Sessions analyzed: <strong style={{ color: 'var(--text-primary)' }}>{results.sessions_analyzed}</strong> &nbsp;|&nbsp;
            Bars scanned: <strong style={{ color: 'var(--text-primary)' }}>{parseInt(results.total_bars_scanned || 0).toLocaleString()}</strong> &nbsp;|&nbsp;
            Parameters: proximity {results.proximity_points}pts · min {results.min_conditions} conditions · {results.forward_window_minutes}min window
          </div>

          <div style={sep}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Results by Condition Count</div>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={{ ...thStyle, textAlign: 'left' }}>Conditions</th>
                <th style={thStyle}>Events</th><th style={thStyle}>Reversal%</th><th style={thStyle}>Avg Move</th>
              </tr></thead>
              <tbody>
                {[
                  ['3 / 5', results.events_3_conditions, results.reversal_rate_3, results.avg_reversal_magnitude_3],
                  ['4 / 5', results.events_4_conditions, results.reversal_rate_4, results.avg_reversal_magnitude_4],
                  ['5 / 5', results.events_5_conditions, results.reversal_rate_5, results.avg_reversal_magnitude_5],
                ].map(([label, n, rate, mag]) => (
                  <tr key={label}>
                    <td style={{ ...tdStyle, textAlign: 'left', color: '#94a3b8' }}>{label}</td>
                    <td style={tdStyle}>{n != null ? n : '—'}</td>
                    <td style={{ ...tdStyle, color: rate >= 0.6 ? '#22c55e' : rate >= 0.45 ? '#f59e0b' : '#ef4444' }}>
                      {n >= 10 ? pct(rate) : n != null ? `Insufficient (${n})` : '—'}
                    </td>
                    <td style={tdStyle}>{pts(mag)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {Object.keys(byLevel).length > 0 && (
            <div style={sep}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Results by Structural Level</div>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>
                  <th style={{ ...thStyle, textAlign: 'left' }}>Level</th>
                  <th style={thStyle}>Events</th><th style={thStyle}>Reversal%</th><th style={thStyle}>Avg Move</th>
                </tr></thead>
                <tbody>
                  {Object.entries(byLevel).sort((a, b) => (b[1].n || 0) - (a[1].n || 0)).map(([lt, d]) => (
                    <tr key={lt}>
                      <td style={{ ...tdStyle, textAlign: 'left', color: '#94a3b8' }}>{lt.replace(/_/g, ' ')}</td>
                      <td style={tdStyle}>{d.n}</td>
                      <td style={{ ...tdStyle, color: d.reversalRate >= 0.6 ? '#22c55e' : d.reversalRate >= 0.45 ? '#f59e0b' : '#ef4444' }}>
                        {d.n >= 10 ? pct(d.reversalRate) : `Insufficient (${d.n})`}
                      </td>
                      <td style={tdStyle}>{pts(d.avgMag)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Forward test validation (Step 13) */}
          {fwdTest && !fwdTest.insufficient && (
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Forward Test Validation</div>
              <div style={{ fontSize: 13, color: 'var(--text-primary)', lineHeight: 1.8 }}>
                Your logged alerts: <strong>{fwdTest.liveAlerts} events</strong>, <strong>{pct(fwdTest.liveReversalRate)}</strong> reversal rate<br />
                vs backtest prediction: <strong>{pct(fwdTest.btPredictedRate)}</strong> at {fwdTest.modalConditionCount} conditions<br />
                <span style={{ color: fwdTest.status === 'within_variance' ? '#22c55e' : fwdTest.status === 'outside_variance' ? '#ef4444' : '#94a3b8', fontWeight: 700 }}>
                  Status: {fwdTest.status === 'within_variance' ? 'Within expected variance'
                    : fwdTest.status === 'outside_variance' ? 'Outside expected variance — review conditions'
                    : 'No backtest to compare against'}
                </span>
              </div>
            </div>
          )}
          {fwdTest?.insufficient && (
            <div style={{ fontSize: 12, color: '#94a3b8' }}>
              Forward Test Validation: {fwdTest.count} alerts have outcomes — need 10+ to show rates.
            </div>
          )}
        </>
      )}

      {!results && jobStatus !== 'running' && (
        <div style={{ fontSize: 13, color: '#94a3b8', padding: '16px 0' }}>
          No backtest results yet. Click "Run Backtest" to analyze historical sessions.
        </div>
      )}
      {jobStatus === 'running' && (
        <div style={{ fontSize: 13, color: '#f59e0b', padding: '8px 0' }}>Running backtest — this may take a minute…</div>
      )}
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
        {[['dashboard', 'Dashboard'], ['edges', 'Antigravity Edges'], ['chart', 'NL Chart'], ['log', 'Daily Log'], ['backtest', 'Backtest']].map(([t, label]) => (
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
        {tab === 'edges' && (
          <ErrorBoundary name="Antigravity Edges">
            <AntigravityEdgesView />
          </ErrorBoundary>
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
        {tab === 'log' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <CollapsibleSection title="Auto Auction Read" defaultOpen>
              <ACDAutoPanel onComplete={loadAll} />
            </CollapsibleSection>
            <CollapsibleSection title="Manual Daily Entry" defaultOpen>
              <ACDDailyInput onSaved={loadAll} />
            </CollapsibleSection>
            <CollapsibleSection title="Last 60 Trading Days" defaultOpen fetchedAt={loadedAt}>
              <ACDDailyLogTable logs={logs} />
            </CollapsibleSection>
          </div>
        )}
        {tab === 'backtest' && (
          <>
            <CollapsibleSection title="Backtested Edge Statistics" defaultOpen>
              <BacktestedEdgeStatsCard />
            </CollapsibleSection>
            <CollapsibleSection title="Level Confluence" defaultOpen>
              <LevelConfluenceReference />
            </CollapsibleSection>
            <CollapsibleSection title="Market Structure Backtest" defaultOpen>
              <ConditionBacktestInline />
            </CollapsibleSection>
            <CollapsibleSection title="Pattern Stats" defaultOpen>
              <PatternStatsPanel />
            </CollapsibleSection>
            <CollapsibleSection title="Backtest Runner" defaultOpen>
              <ACDBacktestRunner />
            </CollapsibleSection>
            <CollapsibleSection title="Phase Change Backtest" defaultOpen>
              <PhaseChangeBacktestPanel />
            </CollapsibleSection>
          </>
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
