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
import { useSharedPollData } from '../utils/useSharedPollData.js';
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

const API_URL = '/api';

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

// ── Trade Timeline — reads from trade_timeline_events, default filter: Significant Only ──
function TradeTimelinePanel() {
  const [events, setEvents] = React.useState([]);
  const [filter, setFilter] = React.useState('significant');
  const [loading, setLoading] = React.useState(false);

  const load = React.useCallback(() => {
    setLoading(true);
    fetch(`${API_URL}/timeline/today?filter=${filter}`)
      .then(r => r.json())
      .then(d => setEvents(d.events || []))
      .catch(() => setEvents([]))
      .finally(() => setLoading(false));
  }, [filter]);

  React.useEffect(() => {
    load();
    const iv = setInterval(load, 60000);
    // Socket: refresh on resolution/expiry
    const sock = window._tradingSocket;
    const refresh = () => load();
    if (sock) { sock.on('setup-expired', refresh); sock.on('setup-resolved', refresh); sock.on('timeline-updated', refresh); }
    return () => {
      clearInterval(iv);
      if (sock) { sock.off('setup-expired', refresh); sock.off('setup-resolved', refresh); sock.off('timeline-updated', refresh); }
    };
  }, [load]);

  const RESOLUTION_STYLE = {
    TARGET_HIT:  { color: '#22c55e', label: '✓ Target Hit' },
    STOP_HIT:    { color: '#ef4444', label: '✗ Stop Hit' },
    TIME_EXPIRED:{ color: '#94a3b8', label: 'Expired' },
    INVALIDATED: { color: '#cbd5e1', label: 'Invalidated' },
    INVALIDATED_POST: { color: '#f59e0b', label: '↺ Stop Triggered' },
    null:        { color: '#94a3b8', label: 'Active' },
  };

  const fmtTime = (ts) => {
    if (!ts) return '—';
    const d = new Date(ts);
    return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/New_York' });
  };

  return (
    <div>
      {/* Filter pills */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center' }}>
        <span style={{ fontSize: 13, color: '#cbd5e1' }}>Filter:</span>
        {[{ id: 'significant', label: 'Significant Only' }, { id: 'all', label: 'All Events' }].map(({ id, label }) => (
          <button key={id} onClick={() => setFilter(id)}
            style={{ fontSize: 13, padding: '3px 10px', borderRadius: 6, border: `1px solid ${filter === id ? '#6366f1' : 'var(--border-color)'}`,
              background: filter === id ? 'rgba(99,102,241,0.15)' : 'transparent',
              color: filter === id ? '#818cf8' : '#94a3b8', cursor: 'pointer', fontWeight: filter === id ? 700 : 400 }}>
            {label}
          </button>
        ))}
        {loading && <span style={{ fontSize: 13, color: '#94a3b8' }}>Loading…</span>}
      </div>

      {events.length === 0 ? (
        <div style={{ fontSize: 13, color: '#94a3b8', padding: '10px 0', textAlign: 'center' }}>
          {filter === 'significant' ? 'No setups with a decisive outcome yet today. Target hit / stop hit results appear here when they resolve.' : 'No setup events recorded today.'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {events.map(ev => {
            const isLong = ev.direction === 'LONG';
            const dirColor = isLong ? '#22c55e' : '#ef4444';
            const isPostEntryInvalidated = ev.resolution === 'INVALIDATED' && ev.invalidation_timing === 'POST_ENTRY';
            const isPreEntryInvalidated  = ev.resolution === 'INVALIDATED' && ev.invalidation_timing !== 'POST_ENTRY';
            const borderColor = ev.resolution === 'TARGET_HIT' ? 'rgba(34,197,94,0.2)'
              : ev.resolution === 'STOP_HIT'  ? 'rgba(239,68,68,0.2)'
              : isPostEntryInvalidated        ? 'rgba(245,158,11,0.25)'
              : !ev.resolution                ? 'rgba(34,197,94,0.15)'
              : 'var(--border-color)';
            const bgColor = ev.resolution === 'TARGET_HIT' ? 'rgba(34,197,94,0.05)'
              : ev.resolution === 'STOP_HIT'  ? 'rgba(239,68,68,0.05)'
              : isPostEntryInvalidated        ? 'rgba(245,158,11,0.04)'
              : !ev.resolution                ? 'rgba(34,197,94,0.03)'
              : 'rgba(255,255,255,0.02)';
            return (
              <div key={ev.id} style={{ display: 'grid', gridTemplateColumns: '52px 1fr auto auto auto', gap: 10, alignItems: 'start',
                padding: '8px 12px', borderRadius: 7, background: bgColor, border: `1px solid ${borderColor}` }}>
                {/* Time */}
                <span style={{ fontSize: 13, color: '#94a3b8', fontFamily: 'monospace', paddingTop: 2 }}>{fmtTime(ev.event_time_str || ev.event_time)}</span>
                {/* Setup label + conviction + extended detail for POST_ENTRY invalidations */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: '#cbd5e1' }}>
                    {ev.setup_type?.replace(/_/g, ' ')}
                    {ev.direction && <span style={{ marginLeft: 6, fontSize: 12, color: dirColor }}>({ev.direction})</span>}
                  </span>
                  {ev.conviction && ev.conviction.stars != null && (() => {
                    const cvn = ev.conviction;
                    const sc = cvn.stars === 3 ? '#22c55e' : cvn.stars === 2 ? '#f59e0b' : '#94a3b8';
                    const sl = cvn.stars === 3 ? 'STRONG' : cvn.stars === 2 ? 'MODERATE' : 'WEAK';
                    const rate = cvn.adjustedRate ?? cvn.baseRate;
                    return (
                      <span style={{ fontSize: 13, color: sc, fontWeight: 600 }}>
                        {'★'.repeat(cvn.stars)}{'☆'.repeat(3 - cvn.stars)} {sl}
                        {rate != null && ` · ${(rate * 100).toFixed(0)}%`}
                        {cvn.n ? ` · ${cvn.n} events` : ''}
                      </span>
                    );
                  })()}
                  {isPostEntryInvalidated && ev.minutes_active != null && (
                    <span style={{ fontSize: 13, color: '#94a3b8' }}>
                      Active {ev.minutes_active}m
                      {ev.mfe_pts != null && ev.mfe_pts > 0 && (
                        <span style={{ color: '#f59e0b', marginLeft: 6 }}>MFE +{ev.mfe_pts} pts available</span>
                      )}
                    </span>
                  )}
                  {isPreEntryInvalidated && (
                    <span style={{ fontSize: 13, color: '#94a3b8' }}>Invalidated before entry window — no trade possible</span>
                  )}
                </div>
                {/* Entry / Stop / T1 */}
                <span style={{ fontSize: 12, color: '#cbd5e1', fontFamily: 'monospace', paddingTop: 2 }}>
                  {ev.entry_zone != null ? `E ${ev.entry_zone}` : ''}
                  {ev.stop_level != null ? ` · S ${ev.stop_level}` : ''}
                  {ev.t1_level != null ? ` · T1 ${ev.t1_level}` : ''}
                </span>
                {/* Win rate */}
                <span style={{ fontSize: 12, color: '#94a3b8', paddingTop: 2 }}>
                  {ev.historical_win_rate != null ? `${(ev.historical_win_rate * 100).toFixed(0)}% (n=${ev.historical_sessions ?? '?'})` : ''}
                </span>
                {/* Resolution badge */}
                {(() => {
                  const pts  = ev.estimated_pts != null ? parseFloat(ev.estimated_pts) : null;
                  const sPts = ev.stop_pts != null ? parseFloat(ev.stop_pts) : null;
                  const pnl  = ev.actual_pnl != null ? parseFloat(ev.actual_pnl) : ev.matched_trade_pnl != null ? parseFloat(ev.matched_trade_pnl) : null;
                  const pnlStr = pnl != null ? (pnl >= 0 ? `+$${fmtP(pnl, 2)} actual` : `−$${Math.abs(pnl).toFixed(2)} actual`) : null;
                  if (!ev.resolution) return (
                    <span style={{ fontSize: 12, fontWeight: 700, color: '#22c55e', display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap', paddingTop: 2 }}>
                      <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#22c55e', display: 'inline-block', flexShrink: 0 }} />
                      ACTIVE
                    </span>
                  );
                  if (ev.resolution === 'TARGET_HIT') return (
                    <span style={{ fontSize: 12, fontWeight: 700, color: '#22c55e', whiteSpace: 'nowrap', paddingTop: 2 }}>
                      ✓ TARGET HIT {pnlStr || (pts != null ? `+${pts.toFixed(0)} pts` : '')}
                    </span>
                  );
                  if (ev.resolution === 'STOP_HIT') return (
                    <span style={{ fontSize: 12, fontWeight: 700, color: '#ef4444', whiteSpace: 'nowrap', paddingTop: 2 }}>
                      ✗ STOPPED {pnlStr || (sPts != null ? `−${sPts.toFixed(0)} pts` : '')}
                    </span>
                  );
                  if (isPostEntryInvalidated) return (
                    <span style={{ fontSize: 12, fontWeight: 700, color: '#f59e0b', whiteSpace: 'nowrap', paddingTop: 2 }}>↺ STOP TRIGGERED</span>
                  );
                  if (isPreEntryInvalidated) return (
                    <span style={{ fontSize: 12, fontWeight: 600, color: '#94a3b8', whiteSpace: 'nowrap', paddingTop: 2 }}>↺ INVALIDATED (pre-entry)</span>
                  );
                  return <span style={{ fontSize: 12, fontWeight: 700, color: '#94a3b8', whiteSpace: 'nowrap', paddingTop: 2 }}>— EXPIRED</span>;
                })()}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ACDSessionTimeline() {
  const live = useAcdLive(30000);

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

  if (!live) return null;

  if (live.marketHoliday) {
    return (
      <div style={{ background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderRadius: 12, padding: '16px 20px', display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ fontSize: 20 }}>🗓</span>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#94a3b8' }}>Market Holiday — {live.reason?.replace('Market Holiday — ', '')}</div>
          <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2 }}>No trading today. Next session opens Monday 9:30 AM ET.</div>
        </div>
      </div>
    );
  }

  if (!live.timeline) return null;

  const { timeline, narrative, orHigh, orLow, aUpLevel, aDownLevel, gLine, pwHigh, pwLow, pmVAH, pmVAL, pmPOC, sessionHigh, sessionLow, currentPrice, barTime, barsAnalyzed } = live;

  return (
    <div style={{ background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderRadius: 12, padding: '20px 24px' }}>
      {live.earlyClose && (
        <div style={{ marginBottom: 12, padding: '6px 12px', background: 'rgba(251,191,36,0.10)', border: '1px solid rgba(251,191,36,0.4)', borderRadius: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: '#fbbf24' }}>⏰ EARLY CLOSE</span>
          <span style={{ fontSize: 12, color: '#fcd34d' }}>{live.earlyClose.label} — RTH ends at 1:00 PM ET. No new setups after noon; manage existing positions into the early close.</span>
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-muted)', letterSpacing: '0.05em', textTransform: 'uppercase' }}>
          Today's Setup Timeline
          <InfoTooltip text="A running log of every ACD setup event that fired today, in order. Multiple setups can occur — for example, A Up can test and fail in the morning, then A Down can fire in the afternoon. Refreshes every 30 seconds." />
        </div>
        <div style={{ display: 'flex', gap: 16, fontSize: 13, color: 'var(--text-muted)', fontFamily: 'monospace' }}>
          <span>OR {fmtP(orHigh)} / {fmtP(orLow)}</span>
          <span style={{ color: '#22c55e' }}>A Up {fmtP(aUpLevel)}</span>
          <span style={{ color: '#ef4444' }}>A Down {fmtP(aDownLevel)}</span>
          {gLine  && <span style={{ color: '#f59e0b' }}>G-Line {fmtP(gLine)}</span>}
          {pwHigh && <span style={{ color: '#c084fc' }}>PW Hi {fmtP(pwHigh)}</span>}
          {pwLow  && <span style={{ color: '#c084fc' }}>PW Lo {fmtP(pwLow)}</span>}
          {pmVAH  && <span style={{ color: '#10b981' }}>PM VAH {fmtP(pmVAH)}</span>}
          {pmVAL  && <span style={{ color: '#10b981' }}>PM VAL {fmtP(pmVAL)}</span>}
          <span>H {fmtP(sessionHigh)} · L {fmtP(sessionLow)}</span>
          <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>Now: {fmtP(currentPrice, 2)}</span>
          <span style={{ color: '#a0aec0', fontSize: 13 }}>updated {barTime} ET</span>
        </div>
      </div>

      {timeline.length === 0 ? (
        <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '12px 0', textAlign: 'center' }}>
          No setups have fired yet today. Watching for price to test A Up ({fmtP(aUpLevel, 2)}) or A Down ({fmtP(aDownLevel, 2)}).
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
                'C Up (no A)': { label: isCUpReversal ? 'C Up REVERSAL — A Down has failed' : 'C Up (standalone) — half conviction', color: isCUpReversal ? '#22c55e' : '#6ee7b7' },
                'C Down (no A)': { label: isCDownReversal ? 'C Down REVERSAL — A Up has failed' : 'C Down (standalone) — half conviction', color: isCDownReversal ? '#ef4444' : '#fda4af' },
                'C Up confirmed': { label: 'C Up confirmed', color: '#22c55e' },
                'C Down confirmed': { label: 'C Down confirmed', color: '#ef4444' },
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
              // Conviction key for this event
              const eventClean = event.event.replace(/ \((re-test|attempt) \d+\)$/, '');
              const EVCK = {
                'A Up fired': 'ib_high', 'A Up + C Confirmed': 'ib_high', 'A Up tested': 'ib_high',
                'Failed A Up': 'ib_high', 'A Down fired': 'ib_low', 'A Down + C Confirmed': 'ib_low',
                'A Down tested': 'ib_low', 'Failed A Down': 'ib_low',
                'C Up (no A)': 'ib_high', 'C Down (no A)': 'ib_low',
                'C Up confirmed': 'ib_high', 'C Down confirmed': 'ib_low',
                'PM VAH tested': 'composite_vah', 'PM VAH broken': 'composite_vah',
                'PM VAL tested': 'composite_val', 'PM VAL broken': 'composite_val',
                'PW High tested': 'prior_week_high', 'PW High broken': 'prior_week_high',
                'PW Low tested': 'prior_week_low', 'PW Low broken': 'prior_week_low',
              };
              const cvnKey = EVCK[eventClean] || EVCK[baseEvent];
              const cvnEntry = cvnKey && live.conviction ? live.conviction[cvnKey] : null;
              const cvn = cvnEntry?.dynamic || cvnEntry;
              return (
            <div key={i} style={{ padding: '10px 14px', background: `${event.color}12`, border: `1px solid ${event.color}50`, borderLeft: `3px solid ${event.color}`, borderRadius: 8 }}>
              {/* Header */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                <span style={{ fontWeight: 700, fontSize: 14, color: event.color }}>
                  {cVariantLabel ?? event.event}
                </span>
                {SETUP_DEFINITIONS[baseEvent] && <InfoTooltip text={SETUP_DEFINITIONS[baseEvent]} />}
                <span style={{ fontFamily: 'monospace', fontSize: 13, color: event.color, opacity: 0.85 }}>
                  {fmtP(event.signal_price, 2)}
                </span>
                <span style={{ fontFamily: 'monospace', fontSize: 13, color: '#94a3b8' }}>
                  {event.time} ET
                </span>
                {dir && (
                  <span style={{ marginLeft: 'auto', fontWeight: 900, fontSize: 18, color: dir.color, letterSpacing: '0.05em' }}>
                    {dir.label}
                  </span>
                )}
              </div>
              {/* Conviction stars */}
              {cvn && cvn.stars != null && (() => {
                const sc = cvn.stars === 3 ? '#22c55e' : cvn.stars === 2 ? '#f59e0b' : '#94a3b8';
                const sl = cvn.stars === 3 ? 'STRONG' : cvn.stars === 2 ? 'MODERATE' : 'WEAK';
                const adjRate = cvn.adjustedRate ?? cvnEntry?.rate;
                const baseRate = cvnEntry?.rate ?? cvn.baseRate;
                const n = cvn.n ?? cvnEntry?.n;
                const tip = [
                  `${'★'.repeat(cvn.stars)}${'☆'.repeat(3-cvn.stars)} ${sl}`,
                  `Base rate: ${baseRate != null ? (baseRate*100).toFixed(0) : '?'}%${n ? ` (${n} events)` : ''}`,
                  ...(cvn.breakdown || []),
                  adjRate != null && adjRate !== baseRate ? `Adjusted: ${(adjRate*100).toFixed(0)}% estimated conviction` : '',
                ].filter(Boolean).join('\n');
                return (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5, marginTop: -2, fontSize: 12 }}>
                    <span style={{ color: sc, fontWeight: 700, letterSpacing: '0.05em' }}>
                      {'★'.repeat(cvn.stars)}{'☆'.repeat(Math.max(0, 3 - cvn.stars))}
                    </span>
                    <span style={{ color: sc, fontWeight: 600 }}>{sl}</span>
                    <span style={{ color: '#cbd5e1' }}>
                      {adjRate != null ? `${(adjRate*100).toFixed(0)}%` : ''} reversal{n ? ` · ${n} events` : ''}
                    </span>
                    {cvn.breakdown?.length > 0 && (
                      <span style={{ color: '#94a3b8', fontSize: 13 }}>({cvn.breakdown.join(' · ')})</span>
                    )}
                    <InfoTooltip text={tip} />
                  </div>
                );
              })()}
              {/* Body */}
              <div style={{ fontSize: 13, color: '#cbd5e1', lineHeight: 1.6 }}>{event.note}</div>
              {/* Footer */}
              <div style={{ marginTop: 6, fontSize: 13, color: 'var(--text-muted)', display: 'flex', gap: 16 }}>
                <span>Session H: <strong style={{ color: '#22c55e', fontFamily: 'monospace' }}>{fmtP(sessionHigh, 2)}</strong></span>
                <span>Session L: <strong style={{ color: '#ef4444', fontFamily: 'monospace' }}>{fmtP(sessionLow, 2)}</strong></span>
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
        <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>{expanded ? '▲ collapse' : '▼ expand'}</span>
      </button>

      {expanded && (
        <div style={{ marginTop: 14 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: '2px solid var(--border-color)' }}>
                {['Setup', 'Direction', 'Strength', 'Requires', 'Action'].map(h => (
                  <th key={h} style={{ padding: '7px 10px', textAlign: 'left', color: 'var(--text-muted)', fontWeight: 600, fontSize: 13 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {setups.map(s => (
                <tr key={s.name} style={{ borderBottom: '1px solid var(--border-color)', verticalAlign: 'top' }}>
                  <td style={{ padding: '8px 10px', fontWeight: 700, color: s.color, whiteSpace: 'nowrap' }}>{s.name}</td>
                  <td style={{ padding: '8px 10px', color: s.dir.includes('Long') ? '#22c55e' : s.dir.includes('Short') ? '#ef4444' : '#94a3b8', fontWeight: 600, whiteSpace: 'nowrap' }}>{s.dir}</td>
                  <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>
                    <span style={{ padding: '2px 7px', borderRadius: 4, fontSize: 13, fontWeight: 700,
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


// ── Auction Read Card ──────────────────────────────────────────────────────────

function generatePhase1Narrative(inv, val, nlTrend, pivotBias, profile, explCtx, ltCtx) {
  if (!inv || !val) return null;
  const aUp   = explCtx?.aUpLevel   ? Math.round(explCtx.aUpLevel)   : null;
  const aDown = explCtx?.aDownLevel ? Math.round(explCtx.aDownLevel) : null;
  const orH   = explCtx?.orHigh     ? Math.round(explCtx.orHigh)     : null;
  const orL   = explCtx?.orLow      ? Math.round(explCtx.orLow)      : null;
  const priorVAH = explCtx?.priorVAH ? Math.round(explCtx.priorVAH) : null;
  const priorVAL = explCtx?.priorVAL ? Math.round(explCtx.priorVAL) : null;
  const priorPOC = explCtx?.priorPOC ? Math.round(explCtx.priorPOC) : null;
  const nlDir  = nlTrend === 'TRENDING_UP' ? 'up' : nlTrend === 'TRENDING_DOWN' ? 'down' : 'ranging';
  const isLong  = (inv === 'SHORT_TRAPPED' && val !== 'BELOW_VALUE') || (inv === 'NEUTRAL' && val === 'ABOVE_VALUE');
  const isShort = (inv === 'LONG_TRAPPED'  && val !== 'ABOVE_VALUE') || (inv === 'NEUTRAL' && val === 'BELOW_VALUE');

  const lines = [];

  // What this structural combination tends to produce
  if (inv === 'SHORT_TRAPPED' && val === 'ABOVE_VALUE') {
    lines.push('WHAT THIS TENDS TO PRODUCE: Short squeeze type day. Short sellers trapped below value are forced to cover as price stays above prior value area — this produces fast, one-way upside moves with little pullback. Buyers don\'t need to add; sellers are doing the work for them.');
    lines.push('WATCH FOR: An A Up signal that holds its first 5-minute test — this is the main entry. Do not short the initial run up; trapped shorts mean the first pullback finds buyers. If OR is above prior VAH' + (priorVAH ? ` (${priorVAH})` : '') + ', the next extension target is the measured move above OR High.');
    lines.push('CAUTION: The squeeze can exhaust quickly. Once short covering is done, the move can stall and reverse sharply. Watch for volume drying up on the push and increasing on pullbacks — that\'s the signal the squeeze is over. Do not hold long past 11 AM if the A Up hasn\'t extended.');
    if (nlDir === 'down') lines.push('CONFLICT: NL is trending down multi-session — this means the larger player selling trend is still active. This long setup is a counter-trend bounce within a bearish environment. Treat it as a session trade only, no overnight holds, exit at T1 rather than trailing.');
  } else if (inv === 'LONG_TRAPPED' && val === 'BELOW_VALUE') {
    lines.push('WHAT THIS TENDS TO PRODUCE: Failed recovery type day. Long buyers trapped above value are forced to liquidate as price stays below prior value area — this produces sustained downside with no meaningful bid. Every rally is a selling opportunity.');
    lines.push('WATCH FOR: An A Down signal that holds its first 5-minute test' + (aDown ? ` (${aDown})` : '') + ' — that\'s the entry for shorts. The first bounce to the OR High' + (orH ? ` (${orH})` : '') + ' or prior VAL' + (priorVAL ? ` (${priorVAL})` : '') + ' is the high-conviction fade. Size full, trail stops above each prior swing high.');
    lines.push('CAUTION: Don\'t chase into the flush. Wait for price to rally to a level, then fail — that failure confirms the trapped long thesis and gives you a clean stop. Chasing a gap-down open without a fade level means poor R:R.');
    if (nlDir === 'up') lines.push('CONFLICT: NL is trending up multi-session — this short setup is fighting structural momentum. Treat as a single-session mean reversion. Be faster to take profit at T1 rather than pressing for a larger trend move.');
  } else if (inv === 'SHORT_TRAPPED' && val === 'INSIDE_VALUE') {
    lines.push('WHAT THIS TENDS TO PRODUCE: Potential inside-out breakout day. Shorts are trapped but price hasn\'t yet moved above value — the setup needs the opening to confirm which way the breakout goes. Inside value means today\'s outcome depends heavily on the opening 30 minutes.');
    lines.push('WATCH FOR: If price opens and pushes above prior VAH' + (priorVAH ? ` (${priorVAH})` : '') + ', shorts begin covering and the breakout accelerates. A Up' + (aUp ? ` (${aUp})` : '') + ' in this scenario is high conviction. If instead price opens and holds inside value, the trapped shorts may get rescued — WAIT for the break before assuming direction.');
    lines.push('CAUTION: Fade plays against the short inventory bias carry extra risk. If price drops below prior VAL' + (priorVAL ? ` (${priorVAL})` : '') + ', trapped shorts are released from pressure and the setup flips — stand aside until new structure forms.');
  } else if (inv === 'LONG_TRAPPED' && val === 'INSIDE_VALUE') {
    lines.push('WHAT THIS TENDS TO PRODUCE: Potential failed recovery day. Longs are trapped but price is inside value — the opening will determine if buyers can reclaim value or if sellers maintain control. High probability of a directional move once the opening call is established.');
    lines.push('WATCH FOR: If price opens below prior VAL' + (priorVAL ? ` (${priorVAL})` : '') + ', longs begin liquidating and the breakdown accelerates — A Down' + (aDown ? ` (${aDown})` : '') + ' is high conviction. If instead price opens and pushes into value, longs may get relieved — wait for A signal confirmation before trading.');
    lines.push('CAUTION: Don\'t sell the initial gap down blindly — trapped longs buying their way out creates sharp counter-moves. Wait for a rally to fail at a level before committing short.');
  } else if (inv === 'NEUTRAL' && val === 'ABOVE_VALUE') {
    lines.push('WHAT THIS TENDS TO PRODUCE: Initiative long day with clean structure. No inventory pressure, just price accepted above prior value — buyers have structural control. The session tends to trend in the direction of the opening call. Typically produces one clean directional move in the first 90 minutes.');
    lines.push('WATCH FOR: The opening call will confirm whether today is a trend or rotation. A Up' + (aUp ? ` (${aUp})` : '') + ' after an Open Drive or OTD opening call is the highest conviction long. Value area above becomes support — pullbacks to prior VAH' + (priorVAH ? ` (${priorVAH})` : '') + ' are buying opportunities, not warnings.');
    lines.push('CAUTION: The cleanest structure sometimes produces the most boring days — price can anchor at a level and do nothing. If A Up fires but immediately comes back inside OR, the breakout has failed and you\'re in a BALANCE day. Do not force continuation if the structure doesn\'t confirm.');
  } else if (inv === 'NEUTRAL' && val === 'BELOW_VALUE') {
    lines.push('WHAT THIS TENDS TO PRODUCE: Initiative short day with clean structure. No inventory pressure, price accepted below prior value — sellers have structural control. Sessions often trend down in the first 90 minutes, with each bounce selling off from a lower high.');
    lines.push('WATCH FOR: A Down' + (aDown ? ` (${aDown})` : '') + ' after an ORR or failed drive opening call is the primary entry. Prior VAL' + (priorVAL ? ` (${priorVAL})` : '') + ' becomes resistance — accept-and-fail at that level gives a tight stop short. Do not be early: wait for the 5-minute sustain below OR Low' + (orL ? ` (${orL})` : '') + '.');
    lines.push('CAUTION: Below-value opens can attract buy-the-dip players and produce a sharp bounce into the value area. If price reclaims prior VAL' + (priorVAL ? ` (${priorVAL})` : '') + ', the short premise is threatened — tighten stops. The bias is only valid if price stays below prior value.');
  } else {
    lines.push('WHAT THIS TENDS TO PRODUCE: Neutral/balanced setup. Both sides have valid arguments — the session will be determined by the opening 30 minutes. Responsive playbook is most likely: fade the high end of the expected range, buy the low end.');
    lines.push('WATCH FOR: The opening call is critical today. An Open Drive will establish the day\'s direction quickly. An Open Auction means a wide-range, two-sided session. With neutral inventory, the A signal is your first strong conviction cue — wait for it rather than front-running.');
    lines.push('CAUTION: Neutral days produce the most whipsaws. Avoid fading an Open Drive — if buyers (or sellers) take control at the open with a clean drive, the lack of opposing inventory means the move can run much farther than expected. Respect the opening call\'s direction.');
  }

  if (profile === 'TREND') {
    lines.push('PRIOR DAY WAS A TREND DAY: This means value migrated in one direction all session. Today\'s OR will likely be set near yesterday\'s close, not the middle of the range. Continuation is the primary scenario until proven otherwise. If you\'re in a trend direction, lean full size on A signal.');
  } else if (profile === 'NORMAL_VARIATION' || profile === 'NORMAL') {
    lines.push('PRIOR DAY WAS NORMAL: Well-behaved day with balanced structure. Standard profiles — both sides had their chance. No inventory excess from yesterday to be resolved. Today starts with a clean slate from yesterday\'s perspective.');
  } else if (profile === 'NEUTRAL' || profile === 'RUNNING_PROFILE_NEUTRAL') {
    lines.push('PRIOR DAY WAS NEUTRAL/BALANCED: Price oscillated, accepting prices in both directions. The prior day left unfinished business — expect today to test at least one extreme of yesterday\'s range before direction is established. The first test of a prior day extreme is a reference, not an entry.');
  } else if (profile === 'NONTREND') {
    lines.push('PRIOR DAY WAS NONTREND: Very narrow range, both sides rejected. Today is likely to resolve the prior balance — watch for a decisive breakout from yesterday\'s high/low. The break of a prior nontrend high or low is typically a reliable directional signal.');
  }

  if (ltCtx?.bracketState === 'TRENDING_UP' && isShort) {
    lines.push('MULTI-TIMEFRAME WARNING: The broader structure is trending UP (multi-week bracket). Today\'s short setup is fighting the larger trend. Treat all short targets conservatively — the structural tailwind is against you on this one. Exit at T1, do not press.');
  } else if (ltCtx?.bracketState === 'TRENDING_DOWN' && isLong) {
    lines.push('MULTI-TIMEFRAME WARNING: The broader structure is trending DOWN (multi-week bracket). Today\'s long setup is a counter-trend bounce. Exit at T1, do not hold overnight, and do not add to the position on strength.');
  }

  return lines.join('\n\n');
}

function generatePhase2Narrative(p1Direction, orCondition, openingCall, aSignal, explCtx, sessionBias) {
  if (!openingCall) return null;
  const aUp   = explCtx?.aUpLevel   ? Math.round(explCtx.aUpLevel)   : null;
  const aDown = explCtx?.aDownLevel ? Math.round(explCtx.aDownLevel) : null;
  const orH   = explCtx?.orHigh     ? Math.round(explCtx.orHigh)     : null;
  const orL   = explCtx?.orLow      ? Math.round(explCtx.orLow)      : null;
  const priorVAH = explCtx?.priorVAH ? Math.round(explCtx.priorVAH) : null;
  const priorVAL = explCtx?.priorVAL ? Math.round(explCtx.priorVAL) : null;
  const isLong  = p1Direction === 'LONG';
  const isShort = p1Direction === 'SHORT';
  const isOD   = openingCall === 'OPEN_DRIVE';
  const isOTD  = openingCall === 'OPEN_TEST_DRIVE';
  const isORR  = openingCall === 'OPEN_REJECTION_REVERSE';
  const isOA   = openingCall === 'OPEN_AUCTION';
  const aFired = aSignal && !aSignal.includes('NO_SIGNAL');
  const aLong  = aSignal && aSignal.includes('A_UP') && !aSignal.includes('FAILED');
  const aShort = aSignal && aSignal.includes('A_DOWN') && !aSignal.includes('FAILED');
  const aFailed = aSignal && aSignal.includes('FAILED');

  const lines = [];

  // Opening call playbook
  if (isOD) {
    lines.push('OPEN DRIVE — what this means: Strong directional conviction at the open with no pause. The dominant side (buyers or sellers) came in with a plan and is executing it immediately. This is the highest-conviction opening type — the day tends to trend strongly in the direction of the drive.');
    lines.push('HOW TO TRADE AN OPEN DRIVE: Do NOT fade the initial drive. Your job is to identify the first meaningful pullback after the drive extends, and enter on the continuation. The entry trigger is: wait for the drive to pause (2–3 bars of sideways action), then enter on the next bar that resumes the original direction. Stop: just below the last swing low of the pullback (longs) or above the last swing high (shorts).');
    if (isLong) lines.push('SPECIFIC WATCH: If drive is up, watch for the first test back to OR High' + (orH ? ` (${orH})` : '') + ' after initial extension. That test — if it holds — is the pullback entry. A Up' + (aUp ? ` (${aUp})` : '') + ' confirmation adds conviction. If price gives back more than 75% of the initial drive, the drive has likely failed.');
    if (isShort) lines.push('SPECIFIC WATCH: First test back to OR Low' + (orL ? ` (${orL})` : '') + ' after the drive down. A Down' + (aDown ? ` (${aDown})` : '') + ' hold is the entry. If price recovers back into OR, the drive is exhausted — stand aside.');
  } else if (isOTD) {
    lines.push('OPEN TEST DRIVE — what this means: Price tested the opposite extreme first (faking out sellers/buyers), then drove back in the primary direction. The participants who chased the initial fake move are now trapped and forced to cover, providing the fuel for the real move.');
    lines.push('HOW TO TRADE AN OTD: The real move is the drive, not the initial test. If you missed the entry, wait for the first pullback after the drive — do not chase. The trapped-participant fuel means the move typically has more follow-through than a standard Open Drive, but the R:R on a chase entry is poor.');
    if (isLong) lines.push('SPECIFIC WATCH: Price tested low (trapping shorts), then drove up. The prior low' + (orL ? ` (${orL} area)` : '') + ' is now key support — a test back to that level that holds is a high-conviction long entry. A Up' + (aUp ? ` (${aUp})` : '') + ' confirms buyers hold control.');
    if (isShort) lines.push('SPECIFIC WATCH: Price tested high (trapping longs), then drove down. Prior high' + (orH ? ` (${orH} area)` : '') + ' is resistance. Test-and-fail at that level = short entry. A Down' + (aDown ? ` (${aDown})` : '') + ' confirms sellers hold control.');
    lines.push('CAUTION: A failed OTD (price tests one side, starts to drive, then reverses back through the test level) is a very bearish/bullish signal in the opposite direction. If you\'re in the trade and price gives back the entire drive and takes out the test low/high, EXIT immediately.');
  } else if (isORR) {
    lines.push('OPEN REJECTION REVERSE — what this means: Price attempted to extend in one direction, got rejected hard, and reversed. This is the "nothing goes as expected at the open" scenario. The side that was right all pre-market is now wrong. The reversal often produces a strong move in the unexpected direction.');
    lines.push('HOW TO TRADE AN ORR: The trade is the reversal. Wait for the rejection to be confirmed (price must CLOSE a bar back inside OR or back through the prior extreme), then enter in the reversal direction. This is the time to fight the morning bias — your pre-market read was right structurally, but today the market is giving you the opposite.');
    if (isLong) lines.push('PRE-MARKET WAS LONG but ORR means price rejected higher and reversed. Watch for the reversal to develop a short opportunity. If A Down' + (aDown ? ` (${aDown})` : '') + ' fires following the rejection, that is your signal the market is going the other way today. This is a difficult trade psychologically — your bias says long but the structure says follow the rejection.');
    if (isShort) lines.push('PRE-MARKET WAS SHORT but ORR means price rejected lower and reversed. Watch for A Up' + (aUp ? ` (${aUp})` : '') + ' following the recovery. The short thesis failed at the open — the long reversal is now the primary setup.');
    lines.push('CAUTION: ORRs can produce whipsaws on both sides. The reversal must be committed — if price is just drifting back rather than driving back, it\'s a balance day masquerading as an ORR. A true ORR reversal has volume and delta confirmation on the reversal bars.');
  } else if (isOA) {
    lines.push('OPEN AUCTION — what this means: Price is rotating both directions inside or near the prior value area. No side has taken conviction control. This is the most balanced opening type and typically leads to either a normal variation day or a nontrend day.');
    lines.push('HOW TO TRADE AN OPEN AUCTION: This is not the time to force a position. The primary play is RESPONSIVE: buy the low end of the IB, sell the high end, targeting the mid. Wait for the IB to be established (by 10:30 AM), then look for acceptance/rejection at IB extremes. A signal' + (aUp ? ` (A Up: ${aUp}, A Down: ${aDown})` : '') + ' will tell you if the auction resolves directionally.');
    lines.push('CAUTION: Open Auction days that produce A signals are the most dangerous. The A signal fires AFTER a period of auction/balance, and the breakout often fails on the first attempt before succeeding on the second. Do not take the first A signal in an Open Auction day at full size — wait for the first attempt to succeed (5-min close, then another bar confirm) before adding.');
  }

  // A signal guidance
  if (aFired && !aFailed) {
    const dir = aLong ? 'long' : 'short';
    const level = aLong ? aUp : aDown;
    const levelStr = level ? ` (${level})` : '';
    lines.push(`A ${aLong ? 'UP' : 'DOWN'} FIRED${levelStr}: Structural control confirmed. Buyers${aLong ? '' : ' failed — sellers'} hold the session. From here:`);
    if (aLong) {
      lines.push(`  • First target: prior day VAH${priorVAH ? ` (${priorVAH})` : ''} then measured move above OR High${orH ? ` (${orH})` : ''}\n  • Stop management: trail above OR Low${orL ? ` (${orL})` : ''} on the first bar, then above each successive higher low as the trend develops\n  • The move is valid as long as price stays above A Up level${level ? ` (${level})` : ''} on a closing bar basis — one touch back through is fine, a close below means the A Up has failed`);
    } else {
      lines.push(`  • First target: prior day VAL${priorVAL ? ` (${priorVAL})` : ''} then measured move below OR Low${orL ? ` (${orL})` : ''}\n  • Stop management: trail below OR High${orH ? ` (${orH})` : ''} on first bar, then below each successive lower high\n  • Valid while price stays below A Down${level ? ` (${level})` : ''} on a closing bar basis`);
    }
  } else if (aFailed) {
    const isFailedAUp = aSignal.includes('A_UP');
    lines.push(`${isFailedAUp ? 'FAILED A UP' : 'FAILED A DOWN'}: The attempted breakout failed. Participants who chased the ${isFailedAUp ? 'long' : 'short'} are now trapped. The counter-move is the trade.`);
    lines.push(isFailedAUp
      ? `Watch for price to break below OR Low${orL ? ` (${orL})` : ''} — that confirms a false breakout and triggers the short. Entry: first close below OR Low. Stop: above OR High${orH ? ` (${orH})` : ''}. Do not short the A Up failure itself until price is clearly back inside OR.`
      : `Watch for price to break above OR High${orH ? ` (${orH})` : ''} — confirms the short failed and triggers the long. Entry: first close above OR High. Stop: below OR Low${orL ? ` (${orL})` : ''}. Do not buy until price has cleared back above OR High.`
    );
  }

  // Session bias interpretation
  if (sessionBias?.level === 'RED') {
    lines.push('SESSION BIAS IS RED — CONFLICTING SIGNALS: Pre-market bias and opening behavior disagree. This is the single most important caution in the read. When pre-market says one thing and the open does another, the most common mistake is forcing your pre-market bias on a market that has already told you it\'s going a different way. STAND ASIDE. Your one job right now is to wait for one side to win cleanly: either price recovers and proves the pre-market bias was right, or price extends in the conflict direction and you acknowledge the bias was wrong today. Half-position or wait.');
  } else if (sessionBias?.level === 'AMBER') {
    lines.push('SESSION BIAS AMBER — PARTIAL CONFIRMATION: Not everything is aligned. The pre-market bias has some confirmation but not full conviction. Reduce position size to 1 contract. Your entry criteria should be tighter than on a GREEN day — wait for the strongest possible setup (A signal hold, not just initial fire) before entering. The partial alignment means a failed trade here should be taken as a signal to step back for the rest of the session.');
  }

  return lines.join('\n\n');
}

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

  const p  = v => v ? fmtP(parseFloat(v), 2) : '—';
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
                ? <span style={{ color: '#cbd5e1' }}> of {match.total_occurrences} total</span>
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

// Renders a narrative string (blocks separated by \n\n, with "LABEL:" headers) —
// shared by the inline Phase 1 card and the Auction Read detail modal.
function NarrativeBlocks({ narrative, title }) {
  const [open, setOpen] = React.useState(false);
  if (!narrative) return null;
  return (
    <div style={{ marginTop: 6 }}>
      <button onClick={() => setOpen(o => !o)}
        style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 12, color: '#94a3b8', padding: 0, fontFamily: 'Arial, sans-serif', display: 'flex', alignItems: 'center', gap: 4 }}>
        {open ? '▲' : '▼'} {title || 'Guidance'}
      </button>
      {open && (
        <div style={{ marginTop: 6, padding: '10px 14px', background: 'rgba(15,23,42,0.5)', border: '1px solid rgba(51,65,85,0.5)', borderRadius: 6 }}>
          {narrative.split('\n\n').map((block, i) => {
            const isHeader = block.match(/^[A-Z][A-Z\s:]+:/);
            return (
              <div key={i} style={{ marginBottom: 8 }}>
                {isHeader ? (
                  <>
                    <div style={{ fontSize: 12, fontWeight: 700, color: '#cbd5e1', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>
                      {block.match(/^([A-Z][A-Z\s:–\-—]+:)/)?.[1]}
                    </div>
                    <div style={{ fontSize: 12, color: '#94a3b8', lineHeight: 1.6, whiteSpace: 'pre-line' }}>
                      {block.replace(/^[A-Z][A-Z\s:–\-—]+:\s*/, '')}
                    </div>
                  </>
                ) : (
                  <div style={{ fontSize: 12, color: '#94a3b8', lineHeight: 1.6, whiteSpace: 'pre-line' }}>{block}</div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Modal: full morning-guidance detail behind the green Pre-Market Bias / Session
// Bias summary boxes — opened on click, keeps the dashboard summary compact.
function AuctionReadDetailModal({ p1Direction, p1Bias, ltSentence, phase1Narrative, sessionBias, phase2Narrative, biasColor, onClose }) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 99999, background: 'rgba(0,0,0,0.78)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#0d1117', border: '1px solid var(--border-color)', borderRadius: 12, padding: '20px 24px', maxWidth: 700, width: '100%', maxHeight: '88vh', overflowY: 'auto', position: 'relative', boxShadow: '0 25px 80px rgba(0,0,0,0.9)', fontFamily: 'Arial, sans-serif' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, borderBottom: '1px solid var(--border-color)', paddingBottom: 12 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.12em' }}>Morning Read — Full Detail</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#cbd5e1', fontSize: 20, cursor: 'pointer', padding: '0 2px', lineHeight: 1 }}>✕</button>
        </div>

        {p1Bias && (
          <div style={{ padding: '10px 14px', background: p1Direction === 'LONG' ? 'rgba(34,197,94,0.08)' : p1Direction === 'SHORT' ? 'rgba(239,68,68,0.08)' : 'rgba(100,116,139,0.08)', border: `1px solid ${p1Direction === 'LONG' ? '#22c55e' : p1Direction === 'SHORT' ? '#ef4444' : '#64748b'}40`, borderRadius: 8, marginBottom: 6 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: p1Direction === 'LONG' ? '#22c55e' : p1Direction === 'SHORT' ? '#ef4444' : '#94a3b8', marginBottom: 4 }}>
              PRE-MARKET BIAS: {p1Direction}
            </div>
            <div style={{ fontSize: 13, color: '#e2e8f0', lineHeight: 1.7 }}>{p1Bias.text}</div>
            {ltSentence && (
              <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid rgba(100,116,139,0.2)', fontSize: 13, color: '#94a3b8', lineHeight: 1.6 }}>
                <span style={{ color: '#cbd5e1', fontWeight: 700 }}>Structural context: </span>{ltSentence}
              </div>
            )}
            <NarrativeBlocks narrative={phase1Narrative} title="Morning Guidance" />
          </div>
        )}

        {sessionBias && (
          <div style={{ padding: '10px 14px', background: `${biasColor[sessionBias.level]}10`, border: `2px solid ${biasColor[sessionBias.level]}`, borderRadius: 8, marginTop: 16, marginBottom: 6 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: biasColor[sessionBias.level], marginBottom: 4 }}>
              SESSION BIAS: {sessionBias.level}
            </div>
            <div style={{ fontSize: 13, color: '#94a3b8', lineHeight: 1.5 }}>{sessionBias.text}</div>
            <NarrativeBlocks narrative={phase2Narrative} title="Opening Guidance" />
          </div>
        )}
      </div>
    </div>
  );
}

function computeContractRec(tpRec, setupStats, setupCard, conf, isCounterTrend) {
  const confScore = tpRec?.confluenceScore ?? (conf ? (conf.structural?.score ?? 0) + (conf.session?.score ?? 0) : 0);
  const wr30 = setupStats?.d30?.winRate ?? null;
  const wrAll = setupStats?.allTime?.winRate ?? (setupCard?.history?.winRate ?? null);
  const winRateOk     = (wr30 != null ? wr30 : wrAll) >= 0.55;
  const winRateHighOk = (wr30 != null ? wr30 : wrAll) >= 0.60;
  const highConvSetups = new Set(['IB_BEARISH','IB_BULLISH','OPEN_DRIVE_LONG','OPEN_DRIVE_SHORT']);
  const isTrendingNow = ['TRENDING_UP','TRENDING_DOWN'].includes(tpRec?.structuralState);

  let contracts = 1, convLabel = 'STANDARD', convColor = '#94a3b8', convReason = '';
  if (confScore >= 11 && highConvSetups.has(setupCard?.type) && winRateHighOk && isTrendingNow && !isCounterTrend) {
    contracts = 3; convLabel = 'HIGH CONVICTION'; convColor = '#22c55e';
    convReason = `IB/Open Drive · Confluence ${confScore} · Trending`;
  } else if (confScore >= 9 && winRateOk && !isCounterTrend) {
    contracts = 2; convLabel = 'ELEVATED CONVICTION'; convColor = '#f59e0b';
    convReason = `Confluence ${confScore}+ · Win rate ${wr30 != null ? Math.round(wr30*100) : wrAll != null ? Math.round(wrAll*100) : '?'}% · Aligned NL30`;
  }

  const toElevated = [];
  const toHigh = [];
  if (contracts < 2) {
    if (confScore < 9) toElevated.push(`confluence needs 9 (currently ${confScore})`);
    if (!winRateOk) toElevated.push(`win rate needs 55% (currently ${wr30 != null ? Math.round(wr30*100) : '?'}%)`);
    if (isCounterTrend) toElevated.push('counter-trend — signal must align with NL30');
  }
  if (contracts < 3) {
    if (!highConvSetups.has(setupCard?.type)) toHigh.push('setup type must be IB or Open Drive');
    if (confScore < 11) toHigh.push(`confluence needs 11 (currently ${confScore})`);
    if (!winRateHighOk) toHigh.push(`win rate needs 60% (currently ${wr30 != null ? Math.round(wr30*100) : '?'}%)`);
    if (!isTrendingNow) toHigh.push(`structural state must be TRENDING (currently ${tpRec?.structuralState ?? 'unknown'})`);
  }
  return { contracts, convLabel, convColor, convReason, toElevated, toHigh };
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
  const [setupCard, setSetupCard] = React.useState(null);
  const [setupStats, setSetupStats] = React.useState(null);
  const [hitRates, setHitRates] = React.useState(null);
  const [levelTouches, setLevelTouches] = React.useState(null);

  React.useEffect(() => {
    fetch(`${API_URL}/acd/nq/latest`).then(r => r.json()).then(setNqLive).catch(() => {});
    fetch(`${API_URL}/auction-read/auto`).then(r => r.json()).then(setAutoDetected).catch(() => {});
    fetch(`${API_URL}/longterm/summary`).then(r => r.json()).then(d => { if (!d.error) setLtSummary(d); }).catch(() => {});
    fetch(`${API_URL}/acd/setup-detection`).then(r => r.json()).then(d => setSetupCard(d.setup || null)).catch(() => {});
    fetch(`${API_URL}/engine-reads/hit-rates`).then(r => r.json()).then(d => { if (!d.error) { setHitRates(d.rates); setLevelTouches(d.levelTouches); } }).catch(() => {});
    const loadConf = () => fetch(`${API_URL}/confluence/today`).then(r => r.json()).then(d => { if (!d.error) setConfluenceData(d); }).catch(() => {});
    loadConf();
    const confIv = setInterval(loadConf, 5 * 60 * 1000);
    const loadLive = () => fetch(`${API_URL}/acd/live`).then(r => r.json()).then(setLiveCtx).catch(() => {});
    loadLive();
    const iv = setInterval(loadLive, 60000);
    return () => { clearInterval(iv); clearInterval(confIv); };
  }, []);

  React.useEffect(() => {
    if (!setupCard?.type) { setSetupStats(null); return; }
    fetch(`${API_URL}/setups/stats?type=${setupCard.type}`).then(r => r.json()).then(setSetupStats).catch(() => setSetupStats(null));
  }, [setupCard?.type]);

  // ET time for phase locking
  const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const etMin  = nowET.getHours() * 60 + nowET.getMinutes();
  const phase1Locked = etMin >= 9 * 60 + 30;
  const phase2Locked = etMin >= 9 * 60 + 45;
  const inSession    = etMin >= 9 * 60 + 45 && etMin < 12 * 60;

  React.useEffect(() => {
    fetch(`${API_URL}/auction-read/today`).then(r => r.json()).then(d => {
      const stored = d || {};
      // Pre-fill auto-detected P1 values for fields not yet set by user.
      // For P3: use prev state (which may have been auto-filled from liveCtx) when DB has null —
      // this prevents the ...stored spread from wiping out live-computed P3 values.
      setRead({
        ...stored,
        overnight_inventory: stored.overnight_inventory || autoDetected.overnight_inventory,
        open_vs_prior_value: stored.open_vs_prior_value || autoDetected.open_vs_prior_value,
        or_condition:        stored.or_condition        || autoDetected.or_condition,
        prior_day_profile:   stored.prior_day_profile   || autoDetected.prior_day_profile,
        opening_call_type:   stored.opening_call_type   || liveCtx?.opening_call_type,
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
  const arcIsCounterTrend = confluenceData?.alignment === 'COUNTER_TREND';
  const contractsRec = computeContractRec(null, setupStats, setupCard, confluenceData, arcIsCounterTrend);

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
                style={{ padding: '5px 12px', fontSize: 13, borderRadius: 5, cursor: locked ? 'default' : 'pointer',
                  border: `1px solid ${isSelected ? '#3b82f6' : 'var(--border-color)'}`,
                  fontWeight: isSelected ? 700 : 500,
                  background: isSelected ? '#3b82f6' : 'var(--input-bg)',
                  color: isSelected ? '#fff' : '#94a3b8',
                  opacity: locked && !isSelected ? 0.45 : 1 }}>
                {label}
                {isAutoThis && <span style={{ fontSize: 11, marginLeft: 4, opacity: 0.8 }}>●</span>}
              </button>
            );
          })}
        </div>
        {isAuto && <div style={{ fontSize: 13, color: '#3b82f6', marginTop: 3 }}>● auto-detected — tap to override</div>}
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
      statusEl = <span style={{ fontSize: 13, color: '#22c55e', fontFamily: 'Arial, sans-serif', fontWeight: 600 }}>✓ manually set {tsStr}</span>;
    } else if (tsStr) {
      statusEl = <span style={{ fontSize: 13, color: '#22c55e', fontFamily: 'Arial, sans-serif', fontWeight: 600 }}>✓ saved {tsStr}</span>;
    } else if (hasAuto) {
      statusEl = <span style={{ fontSize: 13, color: '#3b82f6', fontFamily: 'Arial, sans-serif' }}>● auto-detected — not yet saved</span>;
    } else {
      statusEl = <span style={{ fontSize: 13, color: '#94a3b8', fontFamily: 'Arial, sans-serif' }}>not yet set today</span>;
    }

    return (
    <button onClick={() => togglePhase(num)}
      style={{ width: '100%', background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: openPhases.has(num) ? '1px solid var(--border-color)' : 'none' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: '#3b82f6', letterSpacing: '0.08em' }}>PHASE {num}</span>
        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{title}</span>
        {locked && <span style={{ fontSize: 13, color: '#ef4444', fontWeight: 700, padding: '2px 6px', background: 'rgba(239,68,68,0.15)', borderRadius: 3 }}>LOCKED</span>}
        {timeLabel && !locked && <span style={{ fontSize: 13, color: '#94a3b8', fontFamily: 'Arial, sans-serif' }}>{timeLabel}</span>}
        {statusEl}
      </div>
      <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>{openPhases.has(num) ? '▲' : '▼'}</span>
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
            {fieldTs && <span style={{ fontSize: 13, color: '#94a3b8', fontFamily: 'Arial, sans-serif' }}>{fieldTs}</span>}
            {explanation && (
              <button onClick={() => toggleRow(rowKey)}
                style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: isExpanded ? '#3b82f6' : '#94a3b8',
                  fontSize: 13, fontWeight: 600 }}>
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
        {saving && <span style={{ fontSize: 13, color: '#94a3b8' }}>saving…</span>}
      </div>

      {/* ── PHASE 1 ── */}
      <PhaseHeader num={1} title="Pre-Market" locked={phase1Locked} timeLabel="Fill before 9:30" />
      {openPhases.has(1) && (
        <div style={{ padding: '12px 0' }}>
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
            <div style={{ marginTop: 10, padding: '10px 14px', background: p1Direction === 'LONG' ? 'rgba(34,197,94,0.08)' : p1Direction === 'SHORT' ? 'rgba(239,68,68,0.08)' : 'rgba(100,116,139,0.08)', border: `1px solid ${p1Direction === 'LONG' ? '#22c55e' : p1Direction === 'SHORT' ? '#ef4444' : '#64748b'}40`, borderRadius: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: p1Direction === 'LONG' ? '#22c55e' : p1Direction === 'SHORT' ? '#ef4444' : '#94a3b8' }}>
                  PRE-MARKET BIAS: {p1Direction}
                </div>
                <div style={{ fontSize: 13, color: '#94a3b8', fontFamily: 'Arial, sans-serif' }}>
                  {fmtTs(read.p1_updated_at) || ''}
                </div>
              </div>
              <div style={{ fontSize: 13, color: '#e2e8f0', lineHeight: 1.7 }}>{p1Bias.text}</div>
              {ltSentence && (
                <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid rgba(100,116,139,0.2)', fontSize: 13, color: '#94a3b8', lineHeight: 1.6, fontFamily: 'Arial, sans-serif' }}>
                  <span style={{ color: '#cbd5e1', fontWeight: 700 }}>Structural context: </span>{ltSentence}
                </div>
              )}
              <NarrativeBlocks narrative={generatePhase1Narrative(read.overnight_inventory, read.open_vs_prior_value, nlTrend, pivotBias, read.prior_day_profile, explCtx, ltCtx)} title="Morning Guidance" />
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
              <div style={{ marginLeft: 8, marginBottom: 6, padding: '5px 10px', background: 'rgba(245,158,11,0.07)', borderLeft: '2px solid #f59e0b', borderRadius: '0 4px 4px 0', fontSize: 13, color: '#fcd34d', lineHeight: 1.5 }}>
                {rec}
              </div>
            ) : null;
          })()}
          {/* Statistical OR volatility advisory — fires only when today's OR > avg + 1 stddev */}
          {(() => {
            const rng = autoDetected?.today_or_range;
            const avg = autoDetected?.avg_or_range;
            const sd  = autoDetected?.or_range_stddev;
            if (!rng || !avg || !sd) return null;
            if (rng <= avg + sd) return null;
            return (
              <div style={{ marginLeft: 8, marginBottom: 6, padding: '5px 10px', background: 'rgba(251,191,36,0.07)', borderLeft: '2px solid #fbbf24', borderRadius: '0 4px 4px 0', fontSize: 13, color: '#fbbf24', lineHeight: 1.5 }}>
                High volatility open ({rng.toFixed(0)}pts vs avg {avg.toFixed(0)} ± {sd.toFixed(0)}) — consider 10-min OR instead of 5-min. Standard A signals may be noise.
              </div>
            );
          })()}
          {row('Opening call', (
            <div>
              {autoOpeningCall && !read.opening_call_type && (
                <div style={{ fontSize: 13, color: '#3b82f6', marginBottom: 4 }}>
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
              <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 4 }}>
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
                <div style={{ fontSize: 13, fontWeight: 700, color: biasColor[sessionBias.level] }}>SESSION BIAS: {sessionBias.level}</div>
                <div style={{ fontSize: 13, color: '#cbd5e1', fontFamily: 'Arial, sans-serif' }}>
                  {fmtTs(latestTs(read.p2_updated_at, read.ts_or_condition, read.ts_opening_call_type, read.ts_a_signal_override))
                    || (liveCtx?.barTime ? `${liveCtx.barTime} ET` : null)
                    || 'not yet set'}
                </div>
              </div>
              <div style={{ fontSize: 13, color: '#e2e8f0', lineHeight: 1.6, marginBottom: (sessionBias.level === 'GREEN' || sessionBias.level === 'AMBER') ? 8 : 4 }}>{sessionBias.text}</div>
              {sessionBias.level === 'RED' && liveCtx && (() => {
                const isLongBias = p1Direction === 'LONG';
                const orH = fmtP(liveCtx.orHigh);
                const orL = fmtP(liveCtx.orLow);
                const g = liveCtx.gLine ? fmtP(liveCtx.gLine) : null;
                const days = liveCtx.gLineDaysHeld;
                const cur = liveCtx.currentPrice;
                const aboveGLine = cur != null && liveCtx.gLine != null && cur > liveCtx.gLine;
                const gPts = g && cur != null ? Math.abs(cur - liveCtx.gLine).toFixed(0) : null;
                return (
                  <div style={{ marginTop: 4, padding: '10px 12px', background: 'rgba(0,0,0,0.35)', borderRadius: 6, fontSize: 13 }}>
                    <div style={{ fontSize: 13, color: '#cbd5e1', fontWeight: 700, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                      Stand aside until one of these resolves:
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                      {isLongBias ? (
                        <>
                          <div>
                            <span style={{ color: '#22c55e', fontWeight: 700 }}>↑ LONG clarity: </span>
                            <span style={{ color: '#86efac' }}>Price reclaims OR High </span>
                            <span style={{ color: '#22c55e', fontFamily: 'monospace', fontWeight: 700 }}>{orH || '—'}</span>
                            <span style={{ color: '#94a3b8' }}> — A Down has failed, buyers won</span>
                          </div>
                          <div>
                            <span style={{ color: '#ef4444', fontWeight: 700 }}>↓ SHORT clarity: </span>
                            <span style={{ color: '#fca5a5' }}>C Down fires below OR Low </span>
                            <span style={{ color: '#ef4444', fontFamily: 'monospace', fontWeight: 700 }}>{orL || '—'}</span>
                            <span style={{ color: '#94a3b8' }}> — sellers confirmed twice, bias overrides structure</span>
                          </div>
                        </>
                      ) : (
                        <>
                          <div>
                            <span style={{ color: '#ef4444', fontWeight: 700 }}>↓ SHORT clarity: </span>
                            <span style={{ color: '#fca5a5' }}>Price breaks OR Low </span>
                            <span style={{ color: '#ef4444', fontFamily: 'monospace', fontWeight: 700 }}>{orL || '—'}</span>
                            <span style={{ color: '#94a3b8' }}> — A Up has failed, sellers won</span>
                          </div>
                          <div>
                            <span style={{ color: '#22c55e', fontWeight: 700 }}>↑ LONG clarity: </span>
                            <span style={{ color: '#86efac' }}>C Up fires above OR High </span>
                            <span style={{ color: '#22c55e', fontFamily: 'monospace', fontWeight: 700 }}>{orH || '—'}</span>
                            <span style={{ color: '#94a3b8' }}> — buyers confirmed twice, bias overrides structure</span>
                          </div>
                        </>
                      )}
                      {g && (
                        <div>
                          <span style={{ color: '#f59e0b', fontWeight: 700 }}>⬡ WEEKLY: </span>
                          <span style={{ color: '#fcd34d' }}>G-Line </span>
                          <span style={{ color: '#f59e0b', fontFamily: 'monospace', fontWeight: 700 }}>{g}</span>
                          {days > 0 && <span style={{ color: '#f59e0b' }}> · held {days}d</span>}
                          <span style={{ color: '#94a3b8' }}> — {aboveGLine ? 'hold above = weekly longs intact · break below = weekly bias shifts to sellers' : 'below G-Line = weekly bias with sellers · reclaim = bulls fighting back'}</span>
                          {gPts && cur && (
                            <span style={{ color: '#94a3b8', marginLeft: 8 }}>
                              Current: <span style={{ fontFamily: 'monospace' }}>{fmtP(cur)}</span> is {gPts}pts {aboveGLine ? 'above' : 'below'} G-Line
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })()}
              {/* ── Phase 2 Narrative ── */}
              {(() => {
                const narrative = generatePhase2Narrative(p1Direction, read.or_condition, read.opening_call_type, aSignal, explCtx, sessionBias);
                if (!narrative) return null;
                return (
                  <div style={{ marginTop: 10, padding: '12px 16px', background: 'rgba(15,23,42,0.5)', border: '1px solid rgba(51,65,85,0.5)', borderRadius: 8 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 10 }}>
                      Session Guidance
                    </div>
                    {narrative.split('\n\n').map((block, i) => {
                      const isHeader = block.match(/^[A-Z][A-Z\s:–\-—]+:/);
                      return (
                        <div key={i} style={{ marginBottom: 10 }}>
                          {isHeader ? (
                            <>
                              <div style={{ fontSize: 13, fontWeight: 700, color: '#cbd5e1', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 3 }}>
                                {block.match(/^([A-Z][A-Z\s:–\-—]+:)/)?.[1]}
                              </div>
                              <div style={{ fontSize: 13, color: '#94a3b8', lineHeight: 1.65, whiteSpace: 'pre-line' }}>
                                {block.replace(/^[A-Z][A-Z\s:–\-—]+:\s*/, '')}
                              </div>
                            </>
                          ) : (
                            <div style={{ fontSize: 13, color: '#94a3b8', lineHeight: 1.65, whiteSpace: 'pre-line' }}>{block}</div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
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
                const stopStrong = isLong ? fmtP(orL, 2) : fmtP(orH, 2);
                const stopAggr   = fmtP((orH + orL) / 2, 2);
                return (
                  <div style={{ padding: '8px 10px', background: isCounterTrend ? 'rgba(251,191,36,0.06)' : 'rgba(0,0,0,0.2)', borderRadius: 6, fontSize: 13, color: '#94a3b8', border: isCounterTrend ? '1px solid rgba(251,191,36,0.3)' : 'none' }}>
                    {isCounterTrend && (
                      <div style={{ fontSize: 13, color: '#fbbf24', fontWeight: 700, marginBottom: 5 }}>
                        ⚡ Counter-trend — {ct?.nearestHeadwind ? `${ct.nearestHeadwind.label} (${ct.nearestHeadwind.price}) overhead` : 'structural resistance overhead'}
                      </div>
                    )}
                    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                      <span>Stop (strong): <strong style={{ fontFamily: 'monospace', color: '#ef4444' }}>{stopStrong}</strong> (OR {isLong ? 'low' : 'high'})</span>
                      <span>Stop (aggressive): <strong style={{ fontFamily: 'monospace', color: '#f97316' }}>{stopAggr}</strong> (OR mid)</span>
                      <span>T1: <strong style={{ fontFamily: 'monospace', color: isCounterTrend ? '#fbbf24' : '#22c55e' }}>{t1}</strong>
                        <span style={{ color: '#94a3b8' }}> {t1Label}</span>
                      </span>
                      {!isCounterTrend && <span>T2: prior session hi/lo</span>}
                      <span style={{ color: contractsRec.contracts === 1 ? '#ef4444' : contractsRec.convColor, fontWeight: 700 }}>Max: {contractsRec.contracts} CONTRACT{contractsRec.contracts > 1 ? 'S' : ''}{contractsRec.contracts > 1 ? ` — ${contractsRec.convLabel}` : ''}</span>
                    </div>
                  </div>
                );
              })()}
            </div>
          )}
        </div>
      )}

      {/* ── MID-DAY ── */}
      <MidDaySection hitRates={hitRates} levelTouches={levelTouches} />

      {/* ── PHASE 4 ── */}
      <EODReadSection />
    </div>
  );
}

function MidDaySection({ hitRates, levelTouches }) {
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
          <span style={{ fontSize: 13, fontWeight: 700, color: '#3b82f6', letterSpacing: '0.08em' }}>MID-DAY</span>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>1:45 PM Read</span>
          {!isAfter145 && <span style={{ fontSize: 13, color: '#94a3b8', fontFamily: 'Arial, sans-serif' }}>Available after 1:45 PM ET</span>}
          {genTime
            ? <span style={{ fontSize: 13, color: '#22c55e', fontFamily: 'Arial, sans-serif', fontWeight: 600 }}>✓ updated {genTime} ET</span>
            : isAfter145 && <span style={{ fontSize: 13, color: '#94a3b8', fontFamily: 'Arial, sans-serif' }}>loading…</span>}
        </div>
        <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div style={{ padding: '12px 0' }}>
          {!isAfter145 ? (
            <div style={{ padding: '16px 0', textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>
              Mid-day read populates at 1:45 PM ET — a check-in on whether the morning bias is playing out and what to watch into the close.
            </div>
          ) : !snap?.available ? (
            <div style={{ padding: '16px 0', textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>{snap?.reason || 'Loading…'}</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, fontFamily: 'Arial, sans-serif', fontSize: 13, color: '#94a3b8' }}>

              {/* Status strip */}
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>

                {/* Pre-market bias box — always from structural read (inventory + value position) */}
                <div style={{ padding: '8px 14px', background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border-color)', borderRadius: 7, flex: 1, minWidth: 130 }}>
                  <div style={{ fontSize: 13, color: '#cbd5e1', marginBottom: 3 }}>Pre-market structural bias</div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: biasColor[snap.preMktBias] || '#94a3b8' }}>{snap.preMktBias || 'NEUTRAL'}</div>
                  <div style={{ fontSize: 13, color: '#94a3b8', marginTop: 2 }}>from inventory + value position (before 9:30)</div>
                  {hitRates && (() => {
                    const biasKey = 'BIAS_' + (snap.preMktBias || 'NEUTRAL');
                    const d = hitRates[biasKey]?.overall;
                    if (!d) return null;
                    const hrPct = d.hitRate != null ? Math.round(d.hitRate * 100) : null;
                    const col = hrPct == null ? '#94a3b8' : hrPct >= 65 ? '#22c55e' : hrPct < 55 ? '#ef4444' : '#f59e0b';
                    return d.confident ? (
                      <div style={{ fontSize: 11, fontWeight: 700, color: col, marginTop: 4 }}>{hrPct}% plays out (n={d.decisive})</div>
                    ) : (
                      <div style={{ fontSize: 11, color: '#94a3b8', fontStyle: 'italic', marginTop: 4 }}>n={d.decisive} — limited sample</div>
                    );
                  })()}
                </div>

                {/* Session signal box — only shows when A signal fired */}
                <div style={{ padding: '8px 14px', background: snap.sessionSignal ? `${biasColor[snap.sessionSignal]}10` : 'rgba(0,0,0,0.2)', border: `1px solid ${snap.sessionSignal ? biasColor[snap.sessionSignal]+'40' : 'var(--border-color)'}`, borderRadius: 7, flex: 1, minWidth: 130 }}>
                  <div style={{ fontSize: 13, color: '#cbd5e1', marginBottom: 3 }}>Session signal (A signal)</div>
                  {snap.sessionSignal ? (
                    <>
                      <div style={{ fontSize: 15, fontWeight: 700, color: biasColor[snap.sessionSignal] }}>{snap.sessionSignal}</div>
                      <div style={{ fontSize: 13, color: '#94a3b8', marginTop: 2 }}>
                        {snap.aDownFired ? 'A Down fired — short signal active' : 'A Up fired — long signal active'}
                      </div>
                      {hitRates && (() => {
                        const sigKey = snap.aDownFired ? 'A_DOWN' : 'A_UP';
                        const biasDir = snap.preMktBias === 'LONG' ? 'LONG' : snap.preMktBias === 'SHORT' ? 'SHORT' : 'NEUTRAL';
                        const rBucket = hitRates[sigKey];
                        if (!rBucket) return null;
                        const ctxEntry = rBucket.byBias?.[biasDir];
                        const overall  = rBucket.overall;
                        const display  = ctxEntry?.confident ? ctxEntry : overall;
                        if (!display) return null;
                        const hrPct    = display.hitRate != null ? Math.round(display.hitRate * 100) : null;
                        const isStrong = hrPct != null && hrPct >= 65;
                        const isWeak   = hrPct != null && hrPct < 55;
                        const col      = isStrong ? '#22c55e' : isWeak ? '#ef4444' : '#f59e0b';
                        const isCtxSpec = !!ctxEntry?.confident;
                        const conflict  = (snap.aDownFired && biasDir === 'LONG') || (!snap.aDownFired && biasDir === 'SHORT');
                        const aligned   = (snap.aDownFired && biasDir === 'SHORT') || (!snap.aDownFired && biasDir === 'LONG');
                        return (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 4 }}>
                            {display.confident ? (
                              <span style={{ fontSize: 11, fontWeight: 700, color: col }}>
                                {hrPct}% plays out{isCtxSpec ? ` · bias ${biasDir}` : ' overall'} (n={display.decisive})
                              </span>
                            ) : (
                              <span style={{ fontSize: 11, color: '#94a3b8', fontStyle: 'italic' }}>n={display.decisive} — limited sample</span>
                            )}
                            {conflict && <span style={{ fontSize: 11, fontWeight: 700, color: '#f59e0b' }}>⚠ vs {biasDir} pre-mkt bias</span>}
                            {aligned && display.confident && hrPct >= 60 && <span style={{ fontSize: 11, color: '#22c55e' }}>✓ signal + bias aligned</span>}
                          </div>
                        );
                      })()}
                    </>
                  ) : (
                    <>
                      <div style={{ fontSize: 14, fontWeight: 700, color: '#cbd5e1' }}>No signal yet</div>
                      <div style={{ fontSize: 13, color: '#94a3b8', marginTop: 2 }}>no A signal — structural bias drives</div>
                    </>
                  )}
                </div>

                {/* Price result */}
                <div style={{ padding: '8px 14px', background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border-color)', borderRadius: 7, flex: 1, minWidth: 130 }}>
                  <div style={{ fontSize: 13, color: '#cbd5e1', marginBottom: 3 }}>Price vs open (as of {snap.cutoffTime})</div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: dirColor[snap.dir] }}>{snap.ptsVsOpen > 0 ? '+' : ''}{snap.ptsVsOpen}pts</div>
                  <div style={{ fontSize: 13, color: '#94a3b8', marginTop: 2 }}>{snap.dir}</div>
                </div>

                {/* Bias outcome */}
                <div style={{ padding: '8px 14px', background: snap.biasPlaying ? 'rgba(34,197,94,0.08)' : snap.biasReversed ? 'rgba(239,68,68,0.08)' : 'rgba(0,0,0,0.2)', border: `1px solid ${snap.biasPlaying ? '#22c55e40' : snap.biasReversed ? '#ef444440' : 'var(--border-color)'}`, borderRadius: 7, flex: 1, minWidth: 130 }}>
                  <div style={{ fontSize: 13, color: '#cbd5e1', marginBottom: 3 }}>Bias outcome</div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: snap.biasPlaying ? '#22c55e' : snap.biasReversed ? '#ef4444' : '#94a3b8' }}>
                    {snap.biasPlaying ? '✓ Playing out' : snap.biasReversed ? '✗ Not playing out' : '— Neutral'}
                  </div>
                  <div style={{ fontSize: 13, color: '#94a3b8', marginTop: 2 }}>{snap.sessionSignal ? 'based on A signal direction' : 'based on pre-market read'}</div>
                </div>

                {/* Session range */}
                <div style={{ padding: '8px 14px', background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border-color)', borderRadius: 7, flex: 1, minWidth: 130 }}>
                  <div style={{ fontSize: 13, color: '#cbd5e1', marginBottom: 3 }}>Session range</div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: '#e2e8f0' }}>H {snap.sessHigh} · L {snap.sessLow}</div>
                  <div style={{ fontSize: 13, color: '#94a3b8', marginTop: 2 }}>{snap.sessRange}pts ({snap.rangeVsAvg}% avg)</div>
                </div>

                {/* IB break — level-touch reversal/bounce track record from setup_correlation_cache */}
                {(snap.ibHighBroken || snap.ibLowBroken) && levelTouches && (() => {
                  const levelKey = snap.ibLowBroken ? 'IBL' : 'IBH';
                  const biasDir = snap.preMktBias === 'LONG' ? 'LONG' : snap.preMktBias === 'SHORT' ? 'SHORT' : 'NEUTRAL';
                  const entry = levelTouches[levelKey]?.[biasDir];
                  if (!entry) return null;
                  const col = !entry.confident ? '#94a3b8' : entry.hitRate >= 65 ? '#22c55e' : entry.hitRate < 55 ? '#ef4444' : '#f59e0b';
                  return (
                    <div style={{ padding: '8px 14px', background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border-color)', borderRadius: 7, flex: 1, minWidth: 160 }}>
                      <div style={{ fontSize: 13, color: '#cbd5e1', marginBottom: 3 }}>{levelKey === 'IBL' ? 'IB Low' : 'IB High'} broken</div>
                      <div style={{ fontSize: 14, fontWeight: 700, color: '#e2e8f0' }}>{biasDir} bias</div>
                      {entry.confident ? (
                        <div style={{ fontSize: 11, fontWeight: 700, color: col, marginTop: 4 }}>
                          {entry.hitRate}% reversed/bounced ≥15pts within 30min (n={entry.decisive}{entry.avgPts ? `, avg ${entry.avgPts}pts` : ''})
                        </div>
                      ) : (
                        <div style={{ fontSize: 11, color: '#94a3b8', fontStyle: 'italic', marginTop: 4 }}>n={entry.decisive} — limited sample</div>
                      )}
                    </div>
                  );
                })()}
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
                    <span style={{ color: '#cbd5e1' }}>{label} </span>
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
      .then(d => { setEod(d); setGeneratedAt(d.calculatedAt ? new Date(d.calculatedAt) : null); setLoading(false); })
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
  const patternColor = { V_REVERSAL_UP: '#22c55e', V_REVERSAL_DOWN: '#ef4444', TREND_DAY: '#f97316', BALANCE_DAY: '#94a3b8', FAILED_A_UP: '#f97316', FAILED_A_DOWN: '#a78bfa', NEWS_DRIVEN: '#fbbf24' };

  return (
    <div style={{ marginTop: 8 }}>
      <button onClick={() => setOpen(o => !o)}
        style={{ width: '100%', background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: open ? '1px solid var(--border-color)' : 'none' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: '#3b82f6', letterSpacing: '0.08em' }}>PHASE 4</span>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>End of Day Read</span>
          {!isAfter4pm && <span style={{ fontSize: 13, color: '#94a3b8' }}>Available after 4:00 PM ET</span>}
          {generatedAt && <span style={{ fontSize: 13, color: '#94a3b8', fontFamily: 'Arial, sans-serif' }}>generated {formatTimestamp(generatedAt)}</span>}
        </div>
        <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div style={{ padding: '12px 0' }}>
          {!isAfter4pm ? (
            <div style={{ padding: '20px 0', textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>
              End of day debrief populates after 4:00 PM ET when the full session is complete.
            </div>
          ) : loading && !eod ? (
            <div style={{ padding: '20px 0', textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>Loading EOD analysis…</div>
          ) : !eod?.available ? (
            <div style={{ padding: '20px 0', textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>{eod?.reason || 'No data available.'}</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14, fontFamily: 'Arial, sans-serif', fontSize: 13, color: '#94a3b8' }}>

              {/* Outcome banner */}
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 160, padding: '12px 16px', background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border-color)', borderRadius: 8 }}>
                  <div style={{ fontSize: 13, color: '#cbd5e1', marginBottom: 4, fontWeight: 700, letterSpacing: '0.06em' }}>PRE-MARKET CALL</div>
                  <div style={{ fontSize: 16, fontWeight: 800, color: eod.mornBias === 'LONG' ? '#22c55e' : eod.mornBias === 'SHORT' ? '#ef4444' : '#94a3b8' }}>{eod.mornBias}</div>
                  <div style={{ fontSize: 13, color: '#94a3b8', marginTop: 3 }}>{eod.inv?.replace(/_/g,' ')} · {eod.val?.replace(/_/g,' ')}</div>
                  <div style={{ fontSize: 13, color: '#94a3b8' }}>{eod.priorProfile?.replace(/_/g,' ')} prior day</div>
                  {eod.aUpFired && <div style={{ fontSize: 13, color: '#22c55e', marginTop: 3, fontWeight: 700 }}>A Up fired</div>}
                  {eod.aDownFired && <div style={{ fontSize: 13, color: '#ef4444', marginTop: 3, fontWeight: 700 }}>A Down fired</div>}
                  {!eod.aUpFired && !eod.aDownFired && <div style={{ fontSize: 13, color: '#cbd5e1', marginTop: 3 }}>No A signal</div>}
                </div>
                <div style={{ flex: 1, minWidth: 160, padding: '12px 16px', background: `${outcomeColor[eod.outcome]}10`, border: `1px solid ${outcomeColor[eod.outcome]}40`, borderRadius: 8 }}>
                  <div style={{ fontSize: 13, color: '#cbd5e1', marginBottom: 4, fontWeight: 700, letterSpacing: '0.06em' }}>SESSION RESULT</div>
                  <div style={{ fontSize: 16, fontWeight: 800, color: outcomeColor[eod.outcome] }}>{outcomeIcon[eod.outcome]} {eod.outcome}</div>
                  <div style={{ fontSize: 13, color: eod.ptsVsOpen > 0 ? '#22c55e' : eod.ptsVsOpen < 0 ? '#ef4444' : '#94a3b8', fontWeight: 700, fontFamily: 'monospace', marginTop: 3 }}>{eod.ptsVsOpen > 0 ? '+' : ''}{eod.ptsVsOpen}pts</div>
                  <div style={{ fontSize: 13, color: '#94a3b8', marginTop: 2 }}>Range {eod.sessRange}pts ({eod.rangeVsAvg}% avg) · VWAP {eod.vwap}</div>
                  <div style={{ fontSize: 13, color: '#94a3b8' }}>Open {eod.sessOpen} → Close {eod.sessClose}</div>
                </div>
                <div style={{ flex: '0 0 auto', padding: '12px 16px', background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border-color)', borderRadius: 8, minWidth: 100, textAlign: 'center' }}>
                  <div style={{ fontSize: 13, color: '#cbd5e1', marginBottom: 4, fontWeight: 700, letterSpacing: '0.06em' }}>P3 SCORE</div>
                  <div style={{ fontSize: 24, fontWeight: 800, color: eod.p3Score >= 3 ? '#22c55e' : eod.p3Score >= 2 ? '#fbbf24' : '#ef4444', fontFamily: 'monospace' }}>{eod.p3Score}/5</div>
                  <div style={{ fontSize: 13, color: '#cbd5e1', marginTop: 2 }}>{eod.p3Source || 'auto'}</div>
                </div>
              </div>

              {/* Pre-market narrative */}
              {eod.narrative?.preMarket?.length > 0 && (
                <div style={{ borderLeft: '3px solid #3b82f6', padding: '10px 14px', background: 'rgba(59,130,246,0.05)', borderRadius: '0 8px 8px 0' }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#3b82f6', marginBottom: 8, letterSpacing: '0.06em' }}>PRE-MARKET READ</div>
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
                  <div style={{ fontSize: 13, fontWeight: 700, color: outcomeColor[eod.outcome], marginBottom: 8, letterSpacing: '0.06em' }}>WHAT HAPPENED</div>
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
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#94a3b8', marginBottom: 8, letterSpacing: '0.06em' }}>PATTERNS DETECTED</div>
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
                  <div style={{ fontSize: 13, fontWeight: 700, color: outcomeColor[eod.outcome], marginBottom: 8, letterSpacing: '0.06em' }}>THE VERDICT</div>
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
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#94a3b8', marginBottom: 6, letterSpacing: '0.06em' }}>KEY LEVEL INTERACTIONS</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                    {eod.gNote && <div style={{ padding: '8px 14px', background: 'rgba(245,158,11,0.08)', borderLeft: '3px solid #f59e0b', borderRadius: '0 6px 6px 0', fontSize: 13, color: '#cbd5e1', lineHeight: 1.7 }}><span style={{ color: '#f59e0b', fontWeight: 700 }}>G-Line  </span>{eod.gNote}</div>}
                    {eod.pwNote && <div style={{ padding: '8px 14px', background: 'rgba(192,132,252,0.08)', borderLeft: '3px solid #c084fc', borderRadius: '0 6px 6px 0', fontSize: 13, color: '#cbd5e1', lineHeight: 1.7 }}><span style={{ color: '#c084fc', fontWeight: 700 }}>PW Level  </span>{eod.pwNote}</div>}
                  </div>
                </div>
              )}

              {/* Tomorrow */}
              {eod.narrative?.tomorrow?.length > 0 && (
                <div style={{ padding: '10px 14px', background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.2)', borderRadius: 8 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#3b82f6', marginBottom: 8, letterSpacing: '0.06em' }}>GOING INTO TOMORROW</div>
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
    danger: 'Bracket kills trend traders. You see price hitting a new high, it looks like a breakout, you buy it — the bracket snaps it back. You try again at the next push. Same result. Three stops, same mistake. The trap is that each breakout LOOKS real because price is genuinely moving. But most of them fail and snap back. If you are using trend-following strategies (buying breakouts, adding to winners, holding overnight) in a confirmed bracket, you will consistently lose money until the bracket breaks.',
    green: 'Brackets are clean and profitable when traded correctly. The edge: you know where buyers step in (VAL) and where sellers step in (VAH). Buy near VAL with a stop below it, target the POC. Sell near VAH with a stop above it, target the POC. These are the highest-probability setups in any market condition — they just require patience to wait for price to reach the edge rather than chasing the middle.',
    bullets: [
      'Buy near composite VAL and bracket low, sell near composite VAH and bracket high',
      'Do NOT hold breakouts — most breakout attempts fail in a bracket and snap back',
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
      'The bracket has NOT broken into a trend. Most pushes above VAH fail and return to value. Do not size up on breakouts.',
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
      'The bracket has NOT broken into a downtrend. Most pushes below VAL fail and return to value.',
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
  const mColor = !c.available ? '#94a3b8' : c.met ? '#22c55e' : '#ef4444';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', borderBottom: '1px solid rgba(100,116,139,0.06)' }}>
      <span style={{ width: 14, textAlign: 'center', fontWeight: 700, color: mColor, fontSize: 13, flexShrink: 0 }}>{mark}</span>
      <span style={{ fontSize: 13, color: c.available ? (c.met ? '#cbd5e1' : '#94a3b8') : '#94a3b8', flex: 1, fontFamily: 'Arial, sans-serif' }}>
        {c.label}{COND_TOOLTIPS[c.id] && <InfoTooltip tooltip={COND_TOOLTIPS[c.id]} />}
      </span>
      {c.value && <span style={{ fontSize: 13, color: mColor, fontFamily: 'monospace', flexShrink: 0 }}>{c.value}</span>}
      {c.reason && !c.met && c.available && <span style={{ fontSize: 13, color: '#94a3b8', flexShrink: 0, maxWidth: 160, textAlign: 'right' }}>{c.reason}</span>}
    </div>
  );
}

// ─── StructureInline: alignment + score summary + key conditions + one expand ──
function StructureInline({ defaultOpen = false }) {
  const [data,     setData]     = React.useState(null);
  const [expanded, setExpanded] = React.useState(defaultOpen);

  React.useEffect(() => {
    const load = () => fetch(`${API_URL}/confluence/today`).then(r => r.json()).then(d => { if (!d.error) setData(d); }).catch(() => {});
    load();
    const iv = setInterval(load, 5 * 60 * 1000);
    return () => clearInterval(iv);
  }, []);

  if (!data) return null;

  const { structural, session, alignment, alignColor, alignNote, counterTrendData } = data;
  const allConditions = [...(structural?.conditions || []), ...(session?.conditions || [])];
  const metConds   = allConditions.filter(c => c.available && c.met).slice(0, 4);
  const unmetConds = allConditions.filter(c => c.available && !c.met).slice(0, 3);

  return (
    <div style={{ background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderRadius: 10, padding: '14px 20px', marginBottom: 14, fontFamily: 'Arial, sans-serif' }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: LR_SLATE, textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 8 }}>Structure</div>

      {/* Alignment + score summary row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 14, fontWeight: 800, color: alignColor }}>
          {alignment === 'COUNTER_TREND' ? '⚡ COUNTER-TREND' : alignment === 'ALIGNED' ? '✓ ALIGNED' : '─ NEUTRAL'}
        </span>
        {structural && (
          <span style={{ fontSize: 13, fontFamily: 'monospace', color: structural.color, fontWeight: 600 }}>
            Structural {structural.score}/7 {structural.label} · {structural.dir}
          </span>
        )}
        {session && (
          <span style={{ fontSize: 13, fontFamily: 'monospace', color: session.dir ? session.color : '#94a3b8', fontWeight: 600 }}>
            Session {session.score}/5 {session.label}
          </span>
        )}
      </div>

      {alignment === 'COUNTER_TREND' && alignNote && (
        <div style={{ fontSize: 13, color: '#fbbf24', background: 'rgba(251,191,36,0.07)', border: '1px solid rgba(251,191,36,0.25)', borderRadius: 5, padding: '5px 10px', marginBottom: 8, lineHeight: 1.4 }}>
          {alignNote}
        </div>
      )}

      {/* Key conditions inline */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 8 }}>
        {metConds.map(c => (
          <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
            <span style={{ color: '#22c55e', fontWeight: 700, flexShrink: 0, width: 10 }}>✓</span>
            <span style={{ color: '#94a3b8', flex: 1 }}>{c.label}</span>
            {c.value && <span style={{ color: '#22c55e', fontFamily: 'monospace', flexShrink: 0, fontSize: 12 }}>{c.value}</span>}
          </div>
        ))}
        {unmetConds.map(c => (
          <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
            <span style={{ color: '#ef4444', fontWeight: 700, flexShrink: 0, width: 10 }}>✗</span>
            <span style={{ color: '#cbd5e1', flex: 1 }}>{c.label}</span>
            {c.reason && <span style={{ color: '#94a3b8', fontSize: 12, flexShrink: 0 }}>{c.reason}</span>}
          </div>
        ))}
      </div>

      {counterTrendData && (
        <div style={{ fontSize: 13, color: '#fbbf24', background: 'rgba(251,191,36,0.07)', border: '1px solid rgba(251,191,36,0.25)', borderRadius: 5, padding: '5px 10px', marginBottom: 8 }}>
          ⚡ Counter-trend active — T1 {counterTrendData.t1} ({counterTrendData.nearestTarget?.label})
        </div>
      )}

      <button onClick={() => setExpanded(e => !e)}
        style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 13, color: '#94a3b8', padding: '2px 0', fontFamily: 'Arial, sans-serif' }}>
        {expanded ? '▲ collapse' : '▼ full breakdown'}
      </button>
      {expanded && (
        <div style={{ marginTop: 12, borderTop: '1px solid var(--border-color)', paddingTop: 12 }}>
          <ConfluenceScore />
        </div>
      )}
    </div>
  );
}

function ConfluenceScore() {
  const [data, setData]         = React.useState(null);
  const [patternCtx, setPatternCtx] = React.useState(null);
  const [openS, setOpenS]       = React.useState(true);
  const [openSess, setOpenSess] = React.useState(false);

  React.useEffect(() => {
    const load = () => fetch(`${API_URL}/confluence/today`).then(r => r.json()).then(d => { if (!d.error) setData(d); }).catch(() => {});
    load();
    const iv = setInterval(load, 5 * 60 * 1000);
    return () => clearInterval(iv);
  }, []);

  React.useEffect(() => {
    const loadPattern = () => fetch(`${API_URL}/pattern/today-combination?days=0`)
      .then(r => r.json()).then(setPatternCtx).catch(() => {});
    loadPattern();
    const iv = setInterval(loadPattern, 5 * 60 * 1000);
    return () => clearInterval(iv);
  }, []);

  if (!data) return null;

  const { structural, session, alignment, alignColor, alignNote, counterTrendData, missing, maxPossible, calculatedAt, neutral } = data;
  const nowET    = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const etMin    = nowET.getHours() * 60 + nowET.getMinutes();
  const isLocked = etMin >= 12 * 60;

  const ctx = patternCtx?.context;
  const showNoProcessBanner = ctx &&
    ctx.confBucket === 'WEAK' &&
    ctx.openingCall === 'NO_SIGNAL' &&
    ctx.aQuality === 'NO_SIGNAL';
  const noProcessMatch = patternCtx?.match;
  const noProcessWinRate = noProcessMatch?.win_rate != null
    ? Math.round(noProcessMatch.win_rate * 100)
    : null;
  const isDegrading = noProcessMatch?.win_rate_trend === 'DEGRADING';
  const noProcessN = noProcessMatch?.occurrences ?? 0;

  return (
    <div style={{ marginBottom: 16, fontFamily: 'Arial, sans-serif', display: 'flex', flexDirection: 'column', gap: 8 }}>

      {/* ── NO PROCESS WARNING — shows when WEAK + no opening call + no A signal ── */}
      {showNoProcessBanner && (
        <div style={{ padding: '10px 14px', background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.5)', borderRadius: 8, fontSize: 13, color: '#fcd34d', lineHeight: 1.7 }}>
          <strong style={{ color: '#f59e0b' }}>⚠ No process logged</strong>
          {' — pattern memory shows '}
          <strong style={{ color: noProcessWinRate != null && noProcessWinRate < 40 ? '#ef4444' : '#fbbf24' }}>
            {noProcessWinRate != null ? `${noProcessWinRate}% win rate` : 'low win rate'}
          </strong>
          {' in this condition'}
          {isDegrading && <strong style={{ color: '#ef4444' }}> (DEGRADING)</strong>}
          {noProcessN >= 10 && <span style={{ color: '#94a3b8' }}> — from {noProcessN} sessions</span>}
          {noProcessN > 0 && noProcessN < 10 && <span style={{ color: '#94a3b8' }}> — from {noProcessN} sessions (limited data)</span>}
          .{' '}Complete Morning Prep before entering any trade.
        </div>
      )}

      {/* ── ALIGNMENT BANNER — always visible ── */}
      <div style={{ padding: '10px 16px', background: `${alignColor}12`, border: `2px solid ${alignColor}`, borderRadius: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: '#3b82f6', letterSpacing: '0.08em' }}>CONFLUENCE</span>
          <span style={{ fontSize: 16, fontWeight: 800, color: alignColor, letterSpacing: '0.06em' }}>
            {alignment === 'COUNTER_TREND' ? '⚡ COUNTER-TREND' : alignment === 'ALIGNED' ? '✓ ALIGNED' : '─ NEUTRAL'}
          </span>
          <InfoTooltip tooltip={TOOLTIPS.CONFLUENCE_SCORE} />
          {isLocked && <span style={{ fontSize: 13, color: '#94a3b8', padding: '2px 6px', border: '1px solid #94a3b8', borderRadius: 3 }}>session closed</span>}
        </div>
        <div style={{ fontSize: 13, color: '#cbd5e1', textAlign: 'right' }}>{formatTimestamp(calculatedAt)}</div>
      </div>

      {alignment === 'COUNTER_TREND' && (
        <div style={{ padding: '8px 14px', background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.3)', borderRadius: 8, fontSize: 13, color: '#fbbf24', lineHeight: 1.7 }}>
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
              <div style={{ fontSize: 13, fontWeight: 700, color: '#cbd5e1', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                Structural — The Gravitational Field
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 2 }}>
                <span style={{ fontSize: 24, fontWeight: 900, color: structural.color, fontFamily: 'monospace' }}>{structural.score}</span>
                <span style={{ fontSize: 13, color: '#cbd5e1', fontFamily: 'monospace' }}>/7</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: structural.color }}>{structural.label}</span>
              </div>
              <div style={{ fontSize: 13, color: structural.color, fontWeight: 600, marginTop: 2 }}>{structural.dir}</div>
            </div>
            <span style={{ color: '#cbd5e1', fontSize: 13 }}>{openS ? '▲' : '▼'}</span>
          </button>
          {openS && (
            <div style={{ padding: '8px 14px 10px' }}>
              <div style={{ fontSize: 13, color: '#94a3b8', marginBottom: 4, fontFamily: 'Arial, sans-serif' }}>NL30 direction · c1-c7 · pre-market</div>
              {structural.conditions.map(c => <ConditionRow key={c.id} c={c} />)}
            </div>
          )}
        </div>

        {/* SESSION (intraday weather) */}
        <div style={{ background: 'var(--card-bg)', border: `1px solid ${session.dir ? session.color + '40' : 'var(--border-color)'}`, borderRadius: 10, overflow: 'hidden' }}>
          <button onClick={() => setOpenSess(o => !o)}
            style={{ width: '100%', background: session.dir ? `${session.color}08` : 'transparent', border: 'none', cursor: 'pointer', padding: '10px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#cbd5e1', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                Session — Intraday Weather
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 2 }}>
                <span style={{ fontSize: 24, fontWeight: 900, color: session.dir ? session.color : '#94a3b8', fontFamily: 'monospace' }}>{session.score}</span>
                <span style={{ fontSize: 13, color: '#94a3b8', fontFamily: 'monospace' }}>/5</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: session.dir ? session.color : '#94a3b8' }}>{session.label}</span>
              </div>
              <div style={{ fontSize: 13, color: session.dir ? session.color : '#94a3b8', fontWeight: 600, marginTop: 2 }}>{session.dir || 'No signal yet'}</div>
            </div>
            <span style={{ color: '#cbd5e1', fontSize: 13 }}>{openSess ? '▲' : '▼'}</span>
          </button>
          {openSess && (
            <div style={{ padding: '8px 14px 10px' }}>
              <div style={{ fontSize: 13, color: '#94a3b8', marginBottom: 4, fontFamily: 'Arial, sans-serif' }}>A signal direction · c8-c12 · session</div>
              {session.conditions.map(c => <ConditionRow key={c.id} c={c} />)}
            </div>
          )}
        </div>
      </div>

      {/* ── COUNTER-TREND TRADE PANEL ── */}
      {counterTrendData && <CounterTrendPanel ct={counterTrendData} />}

      {/* ── Max possible footer ── */}
      <div style={{ padding: '6px 12px', background: 'rgba(0,0,0,0.1)', borderRadius: 6, display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#cbd5e1' }}>
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
          <div style={{ fontSize: 13, fontWeight: 700, color: '#fbbf24', letterSpacing: '0.06em', marginBottom: 2 }}>⚡ COUNTER-TREND TRADE MANAGEMENT</div>
          <div style={{ fontSize: 14, fontWeight: 700, color: dirColor }}>{dirLabel}</div>
          <div style={{ fontSize: 13, color: '#94a3b8', marginTop: 2 }}>Against {ct.structuralBias.toLowerCase()} structural backdrop</div>
        </div>
        {ct.t1 && (
          <div style={{ textAlign: 'right', padding: '8px 14px', background: `${dirColor}15`, border: `1px solid ${dirColor}40`, borderRadius: 7 }}>
            <div style={{ fontSize: 13, color: '#cbd5e1' }}>T1</div>
            <div style={{ fontSize: 18, fontWeight: 800, color: dirColor, fontFamily: 'monospace' }}>{ct.t1}</div>
            <div style={{ fontSize: 13, color: '#94a3b8', maxWidth: 160 }}>({ct.nearestTarget?.label})</div>
          </div>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
        {/* Targets */}
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: dirColor, marginBottom: 6, letterSpacing: '0.05em' }}>
            {isShort ? '↓ TARGETS (supports below)' : '↑ TARGETS (resistance above)'}
          </div>
          {ct.targets.slice(0,4).map((t,i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', borderBottom: '1px solid rgba(100,116,139,0.08)', fontSize: 13 }}>
              <span style={{ color: '#94a3b8' }}>{t.label}</span>
              <span style={{ color: dirColor, fontFamily: 'monospace', fontWeight: 600 }}>{t.price}</span>
            </div>
          ))}
          {ct.targets.length === 0 && <div style={{ fontSize: 13, color: '#94a3b8' }}>No structural targets below</div>}
        </div>
        {/* Headwinds */}
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#ef4444', marginBottom: 6, letterSpacing: '0.05em' }}>
            {isShort ? '↑ HEADWINDS (resistance above)' : '↓ HEADWINDS (supports below)'}
          </div>
          {ct.headwinds.slice(0,4).map((h,i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', borderBottom: '1px solid rgba(100,116,139,0.08)', fontSize: 13 }}>
              <span style={{ color: '#94a3b8' }}>{h.label}</span>
              <span style={{ color: '#ef4444', fontFamily: 'monospace', fontWeight: 600 }}>{h.price}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Management rule */}
      <div style={{ padding: '8px 12px', background: 'rgba(251,191,36,0.07)', border: '1px solid rgba(251,191,36,0.25)', borderRadius: 6, fontSize: 13, color: '#fbbf24', lineHeight: 1.7 }}>
        <strong>Rule: </strong>{ct.mgmtRule}
      </div>
    </div>
  );
}

function BigPictureSnapshot({ setCurrentView, defaultOpen = false, initialLt = null }) {
  const [lt, setLt] = React.useState(initialLt);
  const [tpo, setTpo] = React.useState(null);
  const [loading, setLoading] = React.useState(!initialLt);
  const [open, setOpen] = React.useState(defaultOpen);
  const [fetchedAt, setFetchedAt] = React.useState(null);

  React.useEffect(() => {
    const load = () => {
      Promise.all([
        fetch(`${API_URL}/longterm/summary`).then(r => r.json()).then(d => { if (!d.error) { setLt(d); setLoading(false); } }).catch(() => { setLoading(false); }),
        fetch(`${API_URL}/composite-profile?days=5`).then(r => r.json()).then(setTpo).catch(() => {}),
      ]).then(() => setFetchedAt(new Date()));
    };
    load();
    const iv = setInterval(load, 5 * 60 * 1000);
    return () => clearInterval(iv);
  }, []);

  const [updateUnseen, clearUpdateSeen] = useDataUpdateDot('acd-dash-big-picture', 'acd', JSON.stringify({ lt, tpo }));

  if (loading && !lt) return <div style={{ color: '#cbd5e1', fontSize: 12, padding: 8 }}>Loading…</div>;
  if (!lt && !tpo) return <div style={{ color: '#cbd5e1', fontSize: 12, padding: 8 }}>No data available.</div>;

  const stateColor = { TRENDING_UP: '#22c55e', TRENDING_DOWN: '#ef4444', TRANSITIONAL: '#fbbf24', BRACKET: '#3b82f6' };
  const nlColor = n => n > 9 ? '#22c55e' : n < -9 ? '#ef4444' : '#fbbf24';

  const bracketState = lt?.bracketState;
  const acd = lt?.acd;
  const wk = lt?.weeklyStructure;
  const va = lt?.valueMigration;

  return (
    <div style={{ background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderRadius: 10, padding: '14px 20px', marginBottom: 14, fontFamily: 'Arial, sans-serif' }}>

      {/* ── ALWAYS VISIBLE: 3-line headline ── */}
      {(() => {
        const sc       = bracketState?.state;
        const tiltUp   = bracketState?.transitionalNote?.includes('BULLISH');
        const tiltDown = bracketState?.transitionalNote?.includes('BEARISH');
        const stateKey = tiltUp ? 'BRACKET_TILTING_UP' : tiltDown ? 'BRACKET_TILTING_DOWN' : sc;
        const g        = TRADING_GUIDANCE[stateKey] || TRADING_GUIDANCE[sc];
        const scColor  = stateColor[sc] || '#94a3b8';
        const stateLabel = sc === 'TRENDING_UP' ? '↑ TRENDING UP' : sc === 'TRENDING_DOWN' ? '↓ TRENDING DOWN' : sc === 'TRANSITIONAL' ? '⚡ TRANSITIONAL' : '↔ BRACKET';
        const nl30v  = acd?.nl30 ?? 0;
        const vaDir  = va?.direction;
        const vaLabel = vaDir === 'HIGHER' ? '↑ higher' : vaDir === 'LOWER' ? '↓ lower' : '↔ overlapping';
        const weekLabel = wk?.weekType?.replace(/_/g, ' ') || null;
        const summarySentence = lt?.summary?.text?.split('.')[0];
        return (
          <div style={{ marginBottom: 8 }}>
            {/* Line 1: state + chips */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5, flexWrap: 'wrap', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: LR_SLATE, textTransform: 'uppercase', letterSpacing: '0.12em' }}>Big Picture{!open && updateUnseen && <Dot />}</span>
                <span style={{ fontSize: 14, fontWeight: 800, color: scColor }}>
                  {tiltUp ? '⚠ BRACKET tilting up' : tiltDown ? '⚠ BRACKET tilting down' : stateLabel}
                </span>
                {acd && <span style={{ fontSize: 12, fontFamily: 'monospace', color: nlColor(nl30v), fontWeight: 700 }}>NL30 {nl30v > 0 ? '+' : ''}{nl30v}</span>}
                {va  && <span style={{ fontSize: 13, color: vaDir === 'HIGHER' ? '#22c55e' : vaDir === 'LOWER' ? '#ef4444' : '#94a3b8' }}>value {vaLabel}</span>}
                {weekLabel && <span style={{ fontSize: 13, color: '#cbd5e1' }}>{weekLabel} week</span>}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {fetchedAt && <FetchStamp at={fetchedAt} />}
                <button onClick={() => { if (!open) clearUpdateSeen(); setOpen(o => !o); }}
                  style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 13, color: '#94a3b8', padding: '2px 0', fontFamily: 'Arial, sans-serif', display: 'flex', alignItems: 'center', gap: 4 }}>
                  {open ? '▲ collapse' : '▼ full read'}
                </button>
              </div>
            </div>
            {/* Line 2: structure sentence */}
            {summarySentence && (
              <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 4, lineHeight: 1.4 }}>
                <span style={{ color: scColor, fontWeight: 600 }}>Structure says: </span>{summarySentence}.
              </div>
            )}
            {/* Line 3: playbook action */}
            {g?.headline && (
              <div style={{ fontSize: 12, fontWeight: 600, color: '#cbd5e1' }}>→ {g.headline}</div>
            )}
          </div>
        );
      })()}

      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {/* Row 1: key structural numbers */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {acd && (
              <div style={{ padding: '8px 14px', background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border-color)', borderRadius: 7, minWidth: 90 }}>
                <div style={{ fontSize: 13, color: '#cbd5e1', marginBottom: 2, display: 'flex', alignItems: 'center', gap: 3 }}>NL30 <InfoTooltip text="30-session rolling ACD score. Above +9 = confirmed uptrend (OTF buyers consistently in control). Below -9 = confirmed downtrend. Between = ranging — no multi-session directional edge.\n\nFisher: use this as your trend filter. A Up signals in a +9 environment have higher conviction than in a ranging one." /></div>
                <div style={{ fontSize: 18, fontWeight: 800, color: nlColor(acd.nl30), fontFamily: 'monospace' }}>{acd.nl30 > 0 ? '+' : ''}{acd.nl30}</div>
                <div style={{ fontSize: 13, color: nlColor(acd.nl30) }}>{acd.nl30trend}</div>
              </div>
            )}
            {acd && (
              <div style={{ padding: '8px 14px', background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border-color)', borderRadius: 7, minWidth: 80 }}>
                <div style={{ fontSize: 13, color: '#cbd5e1', marginBottom: 2, display: 'flex', alignItems: 'center', gap: 3 }}>NL10 <InfoTooltip text="10-session rolling ACD score. Tracks shorter-term momentum within the 30-day trend.\n\nWhen NL30 is bullish (+9) but NL10 is falling or negative — momentum is weakening. Reduce size on longs. This divergence often precedes a pause or pullback, not necessarily a reversal." /></div>
                <div style={{ fontSize: 15, fontWeight: 800, color: nlColor(acd.nl10), fontFamily: 'monospace' }}>{acd.nl10 > 0 ? '+' : ''}{acd.nl10}</div>
                {acd.nlDiverging && <div style={{ fontSize: 13, color: '#fbbf24' }}>⚠ diverging</div>}
              </div>
            )}
            {bracketState && (
              <div style={{ padding: '8px 14px', background: `${stateColor[bracketState.state] || '#64748b'}10`, border: `1px solid ${stateColor[bracketState.state] || '#64748b'}30`, borderRadius: 7, flex: 1, minWidth: 160 }}>
                <div style={{ fontSize: 13, color: '#cbd5e1', marginBottom: 2, display: 'flex', alignItems: 'center', gap: 3 }}>Market structure <InfoTooltip text="Based on 5-day value area overlap and migration direction.\n\nBRACKET: value areas overlapping — 75% of market time. Fade extremes, buy VAL, sell VAH, expect mean reversion. Breakouts fail most of the time.\n\nTRENDING: value migrating consistently one direction. Go with extensions, do not fade. Buy pullbacks to prior VAH (up) or sell rallies to prior VAL (down).\n\nTRANSITIONAL: 5-day and 10-day disagree. Most dangerous. Neither strategy works cleanly. Reduce size significantly — wait for confirmation." /></div>
                <div style={{ fontSize: 14, fontWeight: 700, color: stateColor[bracketState.state] || '#94a3b8' }}>
                  {bracketState.state === 'TRENDING_UP' ? '↑ Trending Up' : bracketState.state === 'TRENDING_DOWN' ? '↓ Trending Down' : bracketState.state === 'TRANSITIONAL' ? '⚡ Transitional' : '↔ Bracket'}
                </div>
                {bracketState.transitionalNote
                  ? <div style={{ fontSize: 13, color: '#fbbf24', marginTop: 3, fontWeight: 600 }}>⚠ {bracketState.transitionalNote?.includes('BULLISH') ? 'tilting up — breakouts unconfirmed' : bracketState.transitionalNote?.includes('BEARISH') ? 'tilting down — breakouts unconfirmed' : 'transitional'}</div>
                  : <div style={{ fontSize: 13, color: '#94a3b8', marginTop: 2 }}>{bracketState.playbook?.split(' — ')[0]}</div>
                }
              </div>
            )}
            {va && (
              <div style={{ padding: '8px 14px', background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border-color)', borderRadius: 7, minWidth: 110 }}>
                <div style={{ fontSize: 13, color: '#cbd5e1', marginBottom: 2, display: 'flex', alignItems: 'center', gap: 3 }}>Value migration <InfoTooltip text="Direction of daily value area (VAH/POC/VAL) movement over the last 5 sessions.\n\nHIGHER: consecutive days accepting higher prices — buyers in structural control. Dalton: real uptrend = value migrating, not just price moving.\n\nLOWER: consecutive days accepting lower prices — sellers in control.\n\nOVERLAPPING: value areas share significant price range — balanced market, neither side committing. Responsive strategy dominates." /></div>
                <div style={{ fontSize: 14, fontWeight: 700, color: va.direction === 'HIGHER' ? '#22c55e' : va.direction === 'LOWER' ? '#ef4444' : '#94a3b8' }}>
                  {va.direction === 'HIGHER' ? '↑ Higher' : va.direction === 'LOWER' ? '↓ Lower' : '↔ Overlapping'}
                </div>
                <div style={{ fontSize: 13, color: '#cbd5e1' }}>last 5 sessions</div>
              </div>
            )}
            {wk?.weekType && (
              <div style={{ padding: '8px 14px', background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border-color)', borderRadius: 7, minWidth: 110 }}>
                <div style={{ fontSize: 13, color: '#cbd5e1', marginBottom: 2, display: 'flex', alignItems: 'center', gap: 3 }}>This week <InfoTooltip text="Steidlmayer: Monday's range = weekly IB. How far the week extends beyond it reveals OTF conviction.\n\nNORMAL: extends 50% beyond Monday's IB — moderate participation\nNORMAL VARIATION: doubles Monday's IB — meaningful OTF participation\nTREND: closes near extreme, directional throughout — strongest conviction\n\nWeek type can change day by day. A TREND week Monday can become NORMAL by Friday." /></div>
                <div style={{ fontSize: 14, fontWeight: 700, color: wk.weekType === 'TREND' ? '#f97316' : wk.weekType === 'NORMAL_VARIATION' ? '#fbbf24' : '#94a3b8' }}>
                  {wk.weekType?.replace('_',' ')}
                </div>
                <div style={{ fontSize: 13, color: '#cbd5e1' }}>{wk.weekRange?.toFixed(0)}pt range</div>
              </div>
            )}
            {tpo?.available && (
              <div style={{ padding: '8px 14px', background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border-color)', borderRadius: 7, minWidth: 130 }}>
                <div style={{ fontSize: 13, color: '#cbd5e1', marginBottom: 2, display: 'flex', alignItems: 'center', gap: 3 }}>5-day composite POC <InfoTooltip text="Point of Control from the last 5 sessions — the price where the market has spent the most TIME. This is the strongest magnet price.\n\nAbove composite VA: buyers accepting prices above multi-session fair value — initiative territory.\nBelow composite VA: sellers pushing below multi-session fair value.\nInside composite VA: market rotating within accepted range — responsive strategies.\n\nPrice consistently returns to the composite POC. It is the center of gravity for the multi-day auction." /></div>
                <div style={{ fontSize: 15, fontWeight: 700, color: '#e879f9', fontFamily: 'monospace' }}>{fmtP(tpo.poc)}</div>
                <div style={{ fontSize: 13, color: tpo.priceVsVA === 'ABOVE' ? '#22c55e' : tpo.priceVsVA === 'BELOW' ? '#ef4444' : '#fbbf24' }}>
                  price {tpo.priceVsVA?.toLowerCase()} VA ({fmtP(tpo.val)}–{fmtP(tpo.vah)})
                </div>
              </div>
            )}
          </div>

          {/* Row 2: plain-English implication */}
          {lt?.summary && (
            <div style={{ padding: '8px 14px', background: `${stateColor[bracketState?.state] || '#64748b'}08`, borderLeft: `3px solid ${stateColor[bracketState?.state] || '#64748b'}`, borderRadius: '0 6px 6px 0', fontSize: 13, color: '#94a3b8', lineHeight: 1.7 }}>
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
                  <div style={{ fontSize: 13, fontWeight: 700, color: col, letterSpacing: '0.05em' }}>
                    HOW TO TRADE THIS ENVIRONMENT
                  </div>
                  {setCurrentView && (
                    <button onClick={() => setCurrentView('playbook')}
                      style={{ fontSize: 13, color: '#3b82f6', background: 'transparent', border: '1px solid rgba(59,130,246,0.3)', borderRadius: 4, padding: '2px 8px', cursor: 'pointer', fontFamily: 'Arial, sans-serif' }}>
                      Full playbook →
                    </button>
                  )}
                </div>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#e2e8f0', marginBottom: 8 }}>{g.headline}</div>
                {g.danger && (
                  <div style={{ marginBottom: 8, padding: '10px 14px', background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.35)', borderRadius: 6 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#ef4444', marginBottom: 4, letterSpacing: '0.05em' }}>⛔ WHY TRADERS GET BLOWN OUT HERE</div>
                    <div style={{ fontSize: 13, color: '#fca5a5', lineHeight: 1.7, fontFamily: 'Arial, sans-serif' }}>{g.danger}</div>
                  </div>
                )}
                {g.green && (
                  <div style={{ marginBottom: 8, padding: '10px 14px', background: 'rgba(34,197,94,0.06)', border: '1px solid rgba(34,197,94,0.3)', borderRadius: 6 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#22c55e', marginBottom: 4, letterSpacing: '0.05em' }}>✓ THE EDGE IN THIS ENVIRONMENT</div>
                    <div style={{ fontSize: 13, color: '#86efac', lineHeight: 1.7, fontFamily: 'Arial, sans-serif' }}>{g.green}</div>
                  </div>
                )}
                <ul style={{ margin: 0, paddingLeft: 16, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {g.bullets.map((b, i) => (
                    <li key={i} style={{ fontSize: 13, color: '#94a3b8', lineHeight: 1.6, fontFamily: 'Arial, sans-serif' }}>{b}</li>
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

// ── Session Status Bar — "what do I do right now?" ────────────────────────────

function PhaseChangeMonitor({ phaseState }) {
  const [alerts, setAlerts] = React.useState([]);
  const [btResults, setBtResults] = React.useState(null);
  const [overrideState, setOverrideState] = React.useState({});
  const [outcomeForm, setOutcomeForm] = React.useState({}); // alertId → form values
  const [noteForm, setNoteForm] = React.useState({}); // alertId → note input

  const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const hourET = nowET.getHours() + nowET.getMinutes() / 60;
  const isPastElevenET = hourET >= 12; // session closes at noon ET
  const isPast4ET = hourET >= 16;

  React.useEffect(() => {
    const loadAlerts = () => fetch(`${API_URL}/phase-change/alerts/today`)
      .then(r => r.json()).then(setAlerts).catch(() => {});
    const loadBt = () => fetch(`${API_URL}/phase-change/backtest/results`)
      .then(r => r.json()).then(setBtResults).catch(() => {});
    loadAlerts(); loadBt();

    const sock = window._tradingSocket;
    const onAlert = () => loadAlerts();
    if (sock) { sock.on('phase-change-alert', onAlert); }
    return () => { if (sock) sock.off('phase-change-alert', onAlert); };
  }, []);

  const conditionsMet = phaseState?.conditionsMet || 0;
  if (!phaseState || phaseState.outsideHours || conditionsMet < 1) return null;

  const threshold = conditionsMet >= 5 ? { label: 'EXHAUSTION CONFIRMED', color: '#ef4444' }
    : conditionsMet >= 4 ? { label: 'HIGH PROBABILITY', color: '#f97316' }
    : conditionsMet >= 3 ? { label: 'WATCH', color: '#f59e0b' }
    : { label: 'MONITORING', color: '#cbd5e1' };

  const condRows = [
    { key: 'nearLevel', label: 'Near structural level', auto: phaseState.nearLevel, noOverride: true },
    { key: 'volumeDeclining', label: 'Volume declining', auto: phaseState.volumeDeclining },
    { key: 'deltaDiverging', label: 'Delta diverging', auto: phaseState.deltaDiverging, na: !phaseState.hasDelta },
    { key: 'rangeCompressing', label: 'Range compressing', auto: phaseState.rangeCompressing },
    { key: 'profileStopped', label: 'Profile stopped', auto: phaseState.profileStopped },
  ];

  const setOverride = async (alertId, condition, value) => {
    await fetch(`${API_URL}/phase-change/alerts/${alertId}/override`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ condition, value }),
    });
    setOverrideState(prev => ({ ...prev, [`${alertId}_${condition}`]: value }));
    const r = await fetch(`${API_URL}/phase-change/alerts/today`).then(r => r.json());
    setAlerts(r);
  };

  const ack = async (alertId) => {
    await fetch(`${API_URL}/phase-change/alerts/${alertId}/acknowledge`, { method: 'PUT' });
    setAlerts(prev => prev.map(a => a.id === alertId ? { ...a, alert_acknowledged: true } : a));
  };

  const saveOutcome = async (alertId) => {
    const f = outcomeForm[alertId] || {};
    await fetch(`${API_URL}/phase-change/alerts/${alertId}/outcome`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        outcome30min: f.price30 ? parseFloat(f.price30) - (alerts.find(a => a.id === alertId)?.price_at_alert || 0) : null,
        didReverse: f.reversed === 'yes',
        reversalMagnitude: f.magnitude ? parseFloat(f.magnitude) : null,
        notes: noteForm[alertId] || null,
      }),
    });
    setOutcomeForm(prev => ({ ...prev, [alertId]: { saved: true } }));
    const r = await fetch(`${API_URL}/phase-change/alerts/today`).then(r => r.json());
    setAlerts(r);
  };

  const getHistoricalRate = (levelType, conds) => {
    if (!btResults?.results_by_combo) return null;
    const combo = typeof btResults.results_by_combo === 'string'
      ? JSON.parse(btResults.results_by_combo)
      : btResults.results_by_combo;
    const key = `${levelType}_${conds}`;
    const d = combo[key];
    if (!d || d.n < 10) return d ? { n: d.n, insufficient: true } : null;
    return { rate: d.reversalRate, n: d.n, avgMag: d.avgMag };
  };

  const cs = { fontSize: 13, color: '#cbd5e1' };
  const pill = (val, na) => na
    ? <span style={{ fontSize: 13, color: '#cbd5e1' }}>N/A</span>
    : <span style={{ fontSize: 13, fontWeight: 700, color: val ? '#22c55e' : '#ef4444' }}>{val ? 'YES' : 'NO'}</span>;

  return (
    <div style={{ background: 'var(--card-bg)', border: `1px solid ${threshold.color}40`, borderRadius: 10, padding: '14px 16px', marginBottom: 14 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>PHASE CHANGE MONITOR</span>
        <InfoTooltip text="Detects exhaustion conditions when price approaches a structural level during the 9:30–11 AM window. 3+ conditions = elevated reversal probability. All conditions auto-detected from bar data. Manual override available." />
        <span style={{ marginLeft: 'auto', fontSize: 13, color: '#94a3b8' }}>Live — updating on each bar</span>
      </div>

      {phaseState.nearLevelType && (
        <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 8 }}>
          Near: <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
            {phaseState.nearLevelType?.replace(/_/g, ' ')} {phaseState.nearLevelPrice}
          </span>
          {phaseState.distanceToLevel != null && ` (${phaseState.distanceToLevel.toFixed(1)} pts away)`}
        </div>
      )}

      {/* Score bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <span style={{ fontSize: 22, fontWeight: 800, color: threshold.color, fontFamily: 'monospace' }}>
          {conditionsMet}<span style={{ fontSize: 14, color: '#94a3b8' }}>/5</span>
        </span>
        <span style={{ fontSize: 13, fontWeight: 700, color: threshold.color }}>{threshold.label}</span>
        <div style={{ flex: 1, height: 6, background: '#1e293b', borderRadius: 3, overflow: 'hidden' }}>
          <div style={{ width: `${conditionsMet * 20}%`, height: '100%', background: threshold.color, borderRadius: 3, transition: 'width 0.3s' }} />
        </div>
      </div>

      {/* Conditions table */}
      <div style={{ fontSize: 12, marginBottom: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 90px 90px', gap: '4px 8px', marginBottom: 4 }}>
          <span style={cs}>Condition</span>
          <span style={{ ...cs, textAlign: 'center' }}>Auto-Detected</span>
          <span style={{ ...cs, textAlign: 'center' }}>Your Read</span>
        </div>
        {condRows.map(row => (
          <div key={row.key} style={{ display: 'grid', gridTemplateColumns: '1fr 90px 90px', gap: '4px 8px', padding: '3px 0', borderTop: '1px solid #1e293b' }}>
            <span style={{ fontSize: 12, color: 'var(--text-primary)' }}>{row.label}</span>
            <div style={{ textAlign: 'center' }}>{pill(row.auto, row.na)}</div>
            <div style={{ textAlign: 'center' }}>
              {!row.noOverride && alerts.length > 0 && !alerts[alerts.length - 1]?.alert_acknowledged && (
                <div style={{ display: 'flex', gap: 4, justifyContent: 'center' }}>
                  {['yes', 'no'].map(v => {
                    const alertId = alerts[alerts.length - 1]?.id;
                    const current = overrideState[`${alertId}_${row.key}`];
                    const active = current === (v === 'yes');
                    return (
                      <button key={v} onClick={() => setOverride(alertId, row.key, v === 'yes')}
                        style={{ fontSize: 12, padding: '1px 6px', borderRadius: 4, cursor: 'pointer',
                          background: active ? (v === 'yes' ? '#22c55e20' : '#ef444420') : 'transparent',
                          border: `1px solid ${active ? (v === 'yes' ? '#22c55e' : '#ef4444') : '#334155'}`,
                          color: active ? (v === 'yes' ? '#22c55e' : '#ef4444') : '#94a3b8' }}>
                        {v}
                      </button>
                    );
                  })}
                </div>
              )}
              {(row.noOverride || (!alerts.length)) && <span style={{ fontSize: 13, color: '#94a3b8' }}>—</span>}
            </div>
          </div>
        ))}
      </div>

      {/* Prior move */}
      {phaseState.priorDirection && (
        <div style={{ fontSize: 12, color: '#cbd5e1', marginBottom: 10 }}>
          Prior move: <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
            {phaseState.priorDirection}
          </span> | {phaseState.barsInMove || 0} bars
        </div>
      )}

      {/* Historical rate from latest alert */}
      {alerts.length > 0 && (() => {
        const a = alerts[alerts.length - 1];
        const hr = getHistoricalRate(a.level_type, a.conditions_met);
        return (
          <div style={{ fontSize: 12, color: '#cbd5e1', marginBottom: 10, padding: '8px 10px', background: '#0f172a', borderRadius: 6 }}>
            <div style={{ fontWeight: 600, color: 'var(--text-muted)', marginBottom: 4 }}>Historical base rate</div>
            {!btResults ? (
              <span style={{ color: '#94a3b8' }}>Run backtest on Backtest tab to see historical rates</span>
            ) : hr?.insufficient ? (
              <span style={{ color: '#94a3b8' }}>Insufficient data ({hr.n} events)</span>
            ) : hr ? (
              <>
                <span style={{ color: '#94a3b8' }}>
                  {a.level_type?.replace(/_/g, ' ')} · {a.conditions_met} conditions
                </span><br />
                <span style={{ color: '#e2e8f0', fontWeight: 700 }}>→ {(hr.rate * 100).toFixed(0)}% reversal</span>
                <span style={{ color: '#cbd5e1' }}> | avg {hr.avgMag?.toFixed(0)} pts over 30 min</span><br />
                <span style={{ color: '#94a3b8' }}>from {hr.n} historical events</span>
              </>
            ) : (
              <span style={{ color: '#94a3b8' }}>No historical data for this level + condition combo</span>
            )}
          </div>
        );
      })()}

      {/* Alert actions */}
      {alerts.filter(a => !a.alert_acknowledged).map(a => (
        <div key={a.id} style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <button onClick={() => ack(a.id)} style={{
            fontSize: 13, padding: '4px 12px', borderRadius: 6, cursor: 'pointer',
            background: 'transparent', border: '1px solid #334155', color: '#94a3b8',
          }}>Acknowledge</button>
          <button onClick={() => setNoteForm(prev => ({ ...prev, [a.id]: prev[a.id] !== undefined ? undefined : '' }))}
            style={{ fontSize: 13, padding: '4px 12px', borderRadius: 6, cursor: 'pointer',
              background: 'transparent', border: '1px solid #334155', color: '#94a3b8' }}>
            Add note
          </button>
        </div>
      ))}
      {Object.entries(noteForm).map(([alertId, val]) => val !== undefined && (
        <div key={alertId} style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
          <input value={val} onChange={e => setNoteForm(prev => ({ ...prev, [alertId]: e.target.value }))}
            placeholder="Add observation..." style={{ flex: 1, fontSize: 12, padding: '4px 8px', background: '#1e293b', border: '1px solid #334155', borderRadius: 6, color: 'var(--text-primary)' }} />
          <button onClick={async () => {
            await fetch(`${API_URL}/phase-change/alerts/${alertId}/outcome`, {
              method: 'PUT', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ notes: val }),
            });
            setNoteForm(prev => ({ ...prev, [alertId]: undefined }));
          }} style={{ fontSize: 13, padding: '4px 10px', borderRadius: 6, cursor: 'pointer', background: '#1e40af', border: 'none', color: '#fff' }}>Save</button>
        </div>
      ))}

      {/* Post-12PM outcome form */}
      {isPastElevenET && alerts.filter(a => a.did_reverse == null).map(a => (
        outcomeForm[a.id]?.saved ? null : (
          <div key={a.id} style={{ background: '#0f172a', borderRadius: 8, padding: '10px 12px', marginBottom: 8 }}>
            <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 6 }}>
              Outcome — {new Date(a.alert_time).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' })} alert · {a.conditions_met}/5 · {a.level_type?.replace(/_/g, ' ')}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
              <label style={{ fontSize: 13, color: '#cbd5e1' }}>
                Price 30 min later:
                <input type="number" step="0.25" placeholder={a.price_at_alert}
                  value={outcomeForm[a.id]?.price30 || ''}
                  onChange={e => setOutcomeForm(prev => ({ ...prev, [a.id]: { ...prev[a.id], price30: e.target.value } }))}
                  style={{ marginLeft: 6, width: 80, fontSize: 13, padding: '2px 6px', background: '#1e293b', border: '1px solid #334155', borderRadius: 4, color: 'var(--text-primary)' }} />
              </label>
              <label style={{ fontSize: 13, color: '#cbd5e1' }}>Reversed?</label>
              {['yes', 'no'].map(v => (
                <button key={v} onClick={() => setOutcomeForm(prev => ({ ...prev, [a.id]: { ...prev[a.id], reversed: v } }))}
                  style={{ fontSize: 13, padding: '2px 10px', borderRadius: 4, cursor: 'pointer',
                    background: outcomeForm[a.id]?.reversed === v ? '#1e40af' : 'transparent',
                    border: `1px solid ${outcomeForm[a.id]?.reversed === v ? '#3b82f6' : '#334155'}`,
                    color: outcomeForm[a.id]?.reversed === v ? '#fff' : '#94a3b8' }}>
                  {v.toUpperCase()}
                </button>
              ))}
              {outcomeForm[a.id]?.reversed === 'yes' && (
                <label style={{ fontSize: 13, color: '#cbd5e1' }}>
                  Magnitude:
                  <input type="number" step="0.25" placeholder="pts"
                    value={outcomeForm[a.id]?.magnitude || ''}
                    onChange={e => setOutcomeForm(prev => ({ ...prev, [a.id]: { ...prev[a.id], magnitude: e.target.value } }))}
                    style={{ marginLeft: 4, width: 60, fontSize: 13, padding: '2px 6px', background: '#1e293b', border: '1px solid #334155', borderRadius: 4, color: 'var(--text-primary)' }} />
                </label>
              )}
              <button onClick={() => saveOutcome(a.id)} style={{ fontSize: 13, padding: '3px 12px', borderRadius: 5, cursor: 'pointer', background: '#1e40af', border: 'none', color: '#fff' }}>Save outcome</button>
            </div>
          </div>
        )
      ))}
    </div>
  );
}


// ── Collapsible panel group for all analysis sections ─────────────────────────

// updatedAt: string timestamp (e.g. "13:36 ET"). Badge shows when collapsed + unseen.
// Badge disappears permanently after the user opens then closes the section with that updatedAt.
// Reappears if updatedAt changes (new data arrives).
function OvernightContextStrip() {
  // Shared with PermSlipAndStackBar/LivePlaybookCard/EdgeSectionsPanel — was 4
  // independent fetches of the same endpoint on every Morning Prep load, 2026-07-15.
  const [edgesData] = useSharedPollData(`${API_URL}/antigravity/edges-context`, 60000);
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
  const [data, err] = useSharedPollData(`${API_URL}/antigravity/edges-context`, 30000);
  const [resolvedSetups, setResolvedSetups] = React.useState([]);
  const [feedback, setFeedback] = React.useState([]);
  const [showClosed, setShowClosed] = React.useState(false);
  const todayET = React.useMemo(() => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }), []);

  const loadResolved = () => {
    fetch(`${API_URL}/setups/today`).then(r => r.json()).then(d => {
      if (Array.isArray(d.setups)) setResolvedSetups(d.setups.filter(s => ['RESOLVED','EXPIRED'].includes(s.status)));
    }).catch(() => {});
  };
  const loadFeedback = () => {
    fetch(`${API_URL}/acd/feedback?days=1`).then(r => r.json()).then(d => {
      if (d.feedback) setFeedback(d.feedback);
    }).catch(() => {});
  };
  React.useEffect(() => { loadResolved(); loadFeedback(); const iv = setInterval(() => { loadResolved(); loadFeedback(); }, 60000); return () => clearInterval(iv); }, [todayET]);

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
                  <SetupFeedbackForm setup={s} existingFeedback={fb} onSaved={loadFeedback} />
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
                    <SetupFeedbackForm setup={s} existingFeedback={fb} onSaved={loadFeedback} />
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
function ACDView({ accounts, selectedAccounts, setSelectedAccounts, setCurrentView }) {
  const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const [tab, setTab] = React.useState(() => {
    return sessionStorage.getItem('acd-dash-tab') || 'dashboard';
  });
  React.useEffect(() => { sessionStorage.setItem('acd-dash-tab', tab); }, [tab]);
  const [todayData, setTodayData] = React.useState(null);
  const [nl, setNl] = React.useState(null);
  const [logs, setLogs] = React.useState([]);
  const [pivot, setPivot] = React.useState(null);
  const [loadedAt, setLoadedAt] = React.useState(null);

  const [forecast, setForecast] = React.useState(null);

  React.useEffect(() => {
    const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    fetch(`${API_URL}/morning-brief/forecast/${todayET}`).then(r => r.json()).then(setForecast).catch(() => {});
  }, []);


  const loadAll = React.useCallback(() => {
    Promise.all([
      fetch(`${API_URL}/acd/today`).then(r => r.json()).then(setTodayData).catch(console.error),
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
                <ErrorBoundary name="Session Pulse">
                  <SessionPulseCard />
                </ErrorBoundary>
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
  );
}



// QuickTradeLog/SystemHealthSummary now live in components/dashboard/QuickTradeLog.jsx
// (extracted 2026-07-13 so this default export could be lazy-loaded — see App.jsx).
export default ACDView;
