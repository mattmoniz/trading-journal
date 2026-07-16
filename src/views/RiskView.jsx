import React, { useState, useEffect, useCallback } from 'react';
import { fmtP } from '../utils/format.js';
import AccountSelector from '../components/shared/AccountSelector.jsx';

import { API_URL } from '../constants/api.js';
import { INSTRUMENTS } from '../constants/contract.js';

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
      <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 2 }}>{label}</div>
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
        <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>Lookback:</span>
        <select value={lookback} onChange={e => setLookback(parseInt(e.target.value))}
          style={{ background: 'var(--input-bg)', border: '1px solid var(--border-color)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 13, padding: '4px 8px' }}>
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
                <span style={{ fontSize: 13, color: 'var(--text-muted)' }}> — {q1WinRate.trades} trades</span>
              </div>
            );
          })()}
          <div style={{ fontSize: 56, fontWeight: 800, color, lineHeight: 1, fontFamily: 'monospace' }}>
            {(ror * 100).toFixed(1)}%
          </div>
          <div style={{ fontSize: 14, fontWeight: 700, color, marginTop: 4, letterSpacing: '0.08em' }}>{rorLabel(ror)}</div>
          <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 6 }}>
            at {riskPct}% risk per trade · last {lookback} days
          </div>
          {rorData?.compare && (
            <div style={{ display: 'flex', gap: 16, marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--border-color)' }}>
              {[{ pct: 1, val: rorData.compare.at1pct }, { pct: 2, val: rorData.compare.at2pct }, { pct: 3, val: rorData.compare.at3pct }].map(({ pct, val }) => (
                <div key={pct} style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 16, fontWeight: 700, fontFamily: 'monospace', color: rorColor(val) }}>{val !== null ? (val * 100).toFixed(1) + '%' : '—'}</div>
                  <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>at {pct}%</div>
                </div>
              ))}
            </div>
          )}
          <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 12 }}>
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

  // src/constants/contract.js is the single source of truth for this — found 2026-07-16
  // this exact instrument === 'NQ' ? 20 : 2 shape (correct here, but duplicated) is the
  // same pattern that drifted wrong in 2 other places in this codebase the same session.
  const pointValue = (INSTRUMENTS[instrument] || INSTRUMENTS.MNQ).dollarsPerPoint;
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
          <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 4 }}>Instrument</div>
          <select value={instrument} onChange={e => setInstrument(e.target.value)}
            style={{ background: 'var(--input-bg)', border: '1px solid var(--border-color)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 13, padding: '5px 10px' }}>
            {Object.values(INSTRUMENTS).map(i => <option key={i.symbol} value={i.symbol}>{i.label}</option>)}
          </select>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 4 }}>Stop (points)</div>
          <input type="number" value={stopPoints} onChange={e => setStopPoints(parseFloat(e.target.value) || 20)} min={1} max={200}
            style={{ background: 'var(--input-bg)', border: '1px solid var(--border-color)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 13, padding: '5px 10px', width: 80 }} />
        </div>
      </div>

      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 6 }}>
          Risk per trade: <strong style={{ color: 'var(--text-primary)' }}>{localRiskPct.toFixed(2)}%</strong>
        </div>
        <input type="range" min={0.25} max={5} step={0.25} value={localRiskPct}
          onChange={e => setLocalRiskPct(parseFloat(e.target.value))}
          style={{ width: '100%', accentColor: aboveHalfKelly ? '#f97316' : '#3b82f6' }} />
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: 'var(--text-muted)' }}>
          <span>0.25%</span><span>5%</span>
        </div>
      </div>

      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <tbody>
          {[
            ['Kelly Fraction', kelly > 0 ? `${(kelly * 100).toFixed(1)}%` : '—', '#94a3b8'],
            ['Half Kelly (ceiling)', halfKelly > 0 ? `${(halfKelly * 100).toFixed(1)}%` : '—', '#86efac'],
            ['Your risk %', `${localRiskPct.toFixed(2)}%  ${aboveHalfKelly ? '⚠ Above Kelly' : '✓ Within Kelly'}`, aboveHalfKelly ? '#f97316' : '#22c55e'],
            ['Dollar risk/trade', `$${fmtP(dollarRisk)}`, 'var(--text-primary)'],
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
        <div style={{ marginTop: 12, padding: '8px 12px', background: 'rgba(249,115,22,0.1)', border: '1px solid #f97316', borderRadius: 7, fontSize: 13, color: '#f97316' }}>
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
          <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 8 }}>
            EV = (WR × Payoff) − (1 − WR) = {ev >= 0 ? '+' : ''}{ev.toFixed(3)}R
          </div>
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 6 }}>Sensitivity (WR ± 10%)</div>
            <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
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
                <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 2 }}>
                  Expected every ~{every} trades
                </div>
              </div>
            );
          })}
          <div style={{ marginTop: 10, fontSize: 13, color: 'var(--text-muted)', fontStyle: 'italic' }}>
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
          <div style={{ marginTop: 10, fontSize: 13, color: 'var(--text-muted)' }}>
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

  const phaseColors = { pre: '#94a3b8', active: '#22c55e', limit_hit: '#ef4444', closed: '#94a3b8' };
  const borderColor = phaseColors[phase] || '#94a3b8';

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
              {sessionPnl >= 0 ? '+' : ''}${fmtP(sessionPnl, 2)}
            </span>
            <div style={{ flex: 1, minWidth: 120 }}>
              <div style={{ height: 8, background: 'var(--border-color)', borderRadius: 4, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${Math.min(100, pctUsed)}%`, background: barColor, borderRadius: 4, transition: 'width 0.5s' }} />
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 2 }}>
                {pctUsed?.toFixed(0)}% of daily limit (${dailyLimitDollars?.toFixed(0)})
                {pctUsed >= 50 && pctUsed < 75 && ' · Caution'}
                {pctUsed >= 75 && pctUsed < 100 && ' · Consider reducing size'}
                {pctUsed >= 100 && ' · LIMIT HIT'}
              </div>
            </div>
          </>
        )}

        {phase === 'limit_hit' && (
          <div style={{ padding: '6px 12px', background: 'rgba(239,68,68,0.15)', border: '1px solid #ef4444', borderRadius: 7, fontSize: 13, color: '#ef4444', fontWeight: 600 }}>
            No new positions. Edge protection, not punishment.
          </div>
        )}

        {phase === 'closed' && (
          <>
            <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>Morning session closed</span>
            <span style={{ fontSize: 13, fontFamily: 'monospace', fontWeight: 700, color: sessionPnl >= 0 ? '#22c55e' : '#ef4444' }}>
              Final: {sessionPnl >= 0 ? '+' : ''}${fmtP(sessionPnl, 2)}
            </span>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input placeholder="Type OVERRIDE to trade" value={overrideInput} onChange={e => setOverrideInput(e.target.value)}
                style={{ background: 'var(--input-bg)', border: '1px solid var(--border-color)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 13, padding: '4px 8px', width: 180 }} />
              {overrideInput === 'OVERRIDE' && (
                <span style={{ fontSize: 13, color: '#fbbf24' }}>Override active — trade with caution</span>
              )}
            </div>
          </>
        )}

        <span style={{ fontSize: 13, color: 'var(--text-muted)', marginLeft: 'auto' }}>{currentTime} ET</span>
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
      </div>
    </div>
  );
}


export default RiskView;
