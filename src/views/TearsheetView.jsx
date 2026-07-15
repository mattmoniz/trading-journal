import React, { useState, useEffect, useMemo } from 'react';
import {
  BarChart, Bar, ComposedChart, Line, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine,
  ResponsiveContainer, Scatter,
} from 'recharts';
import { formatNumber } from '../utils/format.js';
import { SectionUpdateDot } from '../components/shared/UpdateDot.jsx';

import { API_URL } from '../constants/api.js';

function fmtDur(secs) {
  if (!secs) return '—';
  if (secs < 60) return `${Math.round(secs)}s`;
  if (secs < 3600) return `${Math.round(secs/60)}m`;
  return `${(secs/3600).toFixed(1)}h`;
}

export default function TearsheetView({ accounts, selectedAccounts, setSelectedAccounts }) {
  const [overview, setOverview] = useState(null);
  const [ext, setExt] = useState(null);
  const [daily, setDaily] = useState([]);
  const [dist, setDist] = useState(null);
  const [heatmap, setHeatmap] = useState([]);
  const [rolling, setRolling] = useState([]);
  const [monthlyHeatmap, setMonthlyHeatmap] = useState([]);
  const [excursion, setExcursion] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showMoreStats, setShowMoreStats] = useState(false);
  const [hmTimeframe, setHmTimeframe] = useState('all');

  const account = selectedAccounts?.[0] || '';
  const accountParam = account ? `?account=${encodeURIComponent(account)}` : '';

  useEffect(() => {
    const loadStructural = async () => {
      setLoading(true);
      try {
        const [ov, ex, d, di, mh, exc] = await Promise.all([
          fetch(`${API_URL}/stats/overview${accountParam}`).then(r => r.json()),
          fetch(`${API_URL}/stats/tearsheet-overview${accountParam}`).then(r => r.json()),
          fetch(`${API_URL}/stats/daily${accountParam}`).then(r => r.json()),
          fetch(`${API_URL}/stats/pnl-distribution${accountParam}`).then(r => r.json()),
          fetch(`${API_URL}/stats/monthly-heatmap${accountParam}`).then(r => r.json()),
          fetch(`${API_URL}/stats/excursion${accountParam}`).then(r => r.json()),
        ]);
        setOverview(ov); setExt(ex);
        setDaily(Array.isArray(d) ? d : []);
        setDist(di?.buckets ? di : null);
        setMonthlyHeatmap(Array.isArray(mh) ? mh : []);
        setExcursion(exc?.summary ? exc : null);
      } catch (e) { console.error(e); }
      setLoading(false);
    };
    loadStructural();
  }, [account]);

  useEffect(() => {
    const loadRegime = async () => {
      const rp = new URLSearchParams();
      if (account) rp.set('account', account);
      if (hmTimeframe !== 'all') {
        const days = hmTimeframe === '30d' ? 30 : 90;
        const d = new Date();
        d.setDate(d.getDate() - days);
        rp.set('dateFrom', d.toISOString().split('T')[0]);
      }
      const qs = rp.toString() ? `?${rp.toString()}` : '';
      try {
        const [hm, ro] = await Promise.all([
          fetch(`${API_URL}/stats/timing-heatmap${qs}`).then(r => r.json()),
          fetch(`${API_URL}/stats/rolling${qs}`).then(r => r.json()),
        ]);
        setHeatmap(Array.isArray(hm) ? hm : []);
        setRolling(Array.isArray(ro) ? ro : []);
      } catch (e) { console.error(e); }
    };
    loadRegime();
  }, [account, hmTimeframe]);

  const bestDay = daily.length ? Math.max(...daily.map(d => parseFloat(d.daily_pnl))) : 0;
  const worstDay = daily.length ? Math.min(...daily.map(d => parseFloat(d.daily_pnl))) : 0;

  const pnlColor = (v) => parseFloat(v) >= 0 ? '#10b981' : '#ef4444';

  const mhYears = useMemo(() => [...new Set(monthlyHeatmap.map(r => r.year))].sort(), [monthlyHeatmap]);
  const mhByKey = useMemo(() => {
    const m = {};
    monthlyHeatmap.forEach(r => { m[`${r.year}-${r.month}`] = r; });
    return m;
  }, [monthlyHeatmap]);
  const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  const hmByKey = useMemo(() => {
    const m = {};
    heatmap.forEach(r => { m[`${r.dow}-${r.hour}`] = r; });
    return m;
  }, [heatmap]);
  const hmMaxAbs = useMemo(() => Math.max(...heatmap.map(r => Math.abs(parseFloat(r.avg_pnl || 0))), 1), [heatmap]);
  const DOW_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const HOURS = Array.from({length: 14}, (_, i) => i + 7);

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>Loading tearsheet...</div>;

  const tooltipStyle = { background: 'var(--card-bg)', border: '1px solid var(--border-color)', fontSize: 13 };

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

      <div className="tearsheet-section-label">Performance Summary</div>
      <div className="tearsheet-kpi-grid">
        {[
          { label: 'Total P&L',      value: `$${formatNumber(overview?.total_pnl)}`,            color: pnlColor(overview?.total_pnl) },
          { label: 'Avg P&L/Trade',  value: `$${formatNumber(overview?.avg_pnl)}`,              color: pnlColor(overview?.avg_pnl) },
          { label: 'Avg Win',        value: `$${formatNumber(overview?.avg_win)}`,              color: '#10b981' },
          { label: 'Avg Loss',       value: `$${formatNumber(overview?.avg_loss)}`,             color: '#ef4444' },
          { label: 'Avg Win Day',    value: ext ? `$${formatNumber(ext.avg_win_day)}` : '—',   color: '#10b981' },
          { label: 'Avg Loss Day',   value: ext ? `$${formatNumber(ext.avg_loss_day)}` : '—',  color: '#ef4444' },
          { label: 'Win Rate',       value: `${formatNumber(overview?.win_rate)}%` },
          { label: 'Expectancy',     value: ext ? `$${formatNumber(ext.expectancy)}` : '—' },
          { label: 'Profit Factor',  value: formatNumber(overview?.profit_factor) },
          { label: 'Payoff Ratio',   value: ext?.payoff_ratio ? formatNumber(ext.payoff_ratio, 3) : '—' },
          { label: 'Breakeven WR',   value: ext?.breakeven_wr ? `${ext.breakeven_wr}%` : '—' },
          { label: 'Long Win Rate',  value: ext?.long_win_rate ? `${ext.long_win_rate}%` : '—',  color: '#10b981' },
          { label: 'Short Win Rate', value: ext?.short_win_rate ? `${ext.short_win_rate}%` : '—', color: '#10b981' },
          { label: 'Long P&L',       value: ext ? `$${formatNumber(ext.long_pnl)}` : '—',       color: pnlColor(ext?.long_pnl) },
          { label: 'Short P&L',      value: ext ? `$${formatNumber(ext.short_pnl)}` : '—',      color: pnlColor(ext?.short_pnl) },
        ].map(({ label, value, color }) => (
          <div key={label} className="tearsheet-kpi">
            <div className="tearsheet-kpi-label">{label}</div>
            <div className="tearsheet-kpi-value" style={color ? { color } : {}}>{value ?? '—'}</div>
          </div>
        ))}
      </div>

      <div className="tearsheet-section-label">Risk-Adjusted Performance</div>
      <div className="tearsheet-kpi-grid">
        {[
          { label: 'Sharpe Ratio',  value: ext?.sharpe ?? '—' },
          { label: 'Sortino Ratio', value: ext?.sortino ?? '—' },
          { label: 'Max Drawdown',  value: `$${formatNumber(overview?.max_drawdown)}`, color: '#ef4444' },
          { label: 'Kelly %',       value: ext?.kelly ? `${ext.kelly}%` : '—' },
        ].map(({ label, value, color }) => (
          <div key={label} className="tearsheet-kpi">
            <div className="tearsheet-kpi-label">{label}</div>
            <div className="tearsheet-kpi-value" style={color ? { color } : {}}>{value ?? '—'}</div>
          </div>
        ))}
      </div>

      <button
        onClick={() => setShowMoreStats(s => !s)}
        style={{ background: 'none', border: '1px solid var(--border-color)', borderRadius: 6, color: 'var(--text-muted)', fontSize: 13, padding: '6px 14px', cursor: 'pointer', marginBottom: 16, display: 'block' }}
      >
        {showMoreStats ? '▲ Hide details' : '▼ More stats — P&L breakdown, streaks, duration, profit concentration'}
      </button>
      {showMoreStats && (
        <>
          <div className="tearsheet-section-label">P&amp;L Details</div>
          <div className="tearsheet-kpi-grid">
            {[
              { label: 'Gross Profit', value: `$${formatNumber(overview?.gross_profit)}`,  color: '#10b981' },
              { label: 'Gross Loss',   value: `-$${formatNumber(overview?.gross_loss)}`,   color: '#ef4444' },
              { label: 'Best Day',     value: `$${formatNumber(bestDay)}`,                  color: '#10b981' },
              { label: 'Worst Day',    value: `$${formatNumber(worstDay)}`,                 color: '#ef4444' },
              { label: 'Max Runup',    value: ext ? `$${formatNumber(ext.max_runup)}` : '—', color: '#10b981' },
            ].map(({ label, value, color }) => (
              <div key={label} className="tearsheet-kpi">
                <div className="tearsheet-kpi-label">{label}</div>
                <div className="tearsheet-kpi-value" style={color ? { color } : {}}>{value ?? '—'}</div>
              </div>
            ))}
          </div>
          <div className="tearsheet-section-label">Win / Loss Details</div>
          <div className="tearsheet-kpi-grid">
            {[
              { label: 'Total Trades',         value: overview?.total_trades ?? '—' },
              { label: 'Winning Trades',        value: overview?.winning_trades ?? '—',            color: '#10b981' },
              { label: 'Losing Trades',         value: overview?.losing_trades ?? '—',             color: '#ef4444' },
              { label: 'Win Days',              value: ext?.win_days ?? '—',                       color: '#10b981' },
              { label: 'Loss Days',             value: ext?.loss_days ?? '—',                      color: '#ef4444' },
              { label: '% Profitable Weeks',    value: ext?.pct_profitable_weeks ? `${ext.pct_profitable_weeks}%` : '—' },
              { label: '% Profitable Months',   value: ext?.pct_profitable_months ? `${ext.pct_profitable_months}%` : '—' },
              { label: 'Trading Days',          value: daily.length },
              { label: 'Max Win Streak',        value: overview?.longest_win_streak ?? '—',        color: '#10b981' },
              { label: 'Max Loss Streak',       value: overview?.longest_loss_streak ?? '—',       color: '#ef4444' },
            ].map(({ label, value, color }) => (
              <div key={label} className="tearsheet-kpi">
                <div className="tearsheet-kpi-label">{label}</div>
                <div className="tearsheet-kpi-value" style={color ? { color } : {}}>{value ?? '—'}</div>
              </div>
            ))}
          </div>
          <div className="tearsheet-section-label">Duration &amp; Trade Count</div>
          <div className="tearsheet-kpi-grid">
            {[
              { label: 'Avg Duration',       value: fmtDur(ext?.avg_duration_secs) },
              { label: 'Avg Win Duration',   value: fmtDur(ext?.avg_win_duration_secs),  color: '#10b981' },
              { label: 'Avg Loss Duration',  value: fmtDur(ext?.avg_loss_duration_secs), color: '#ef4444' },
              { label: 'Long Trades',        value: ext?.long_count ?? '—' },
              { label: 'Short Trades',       value: ext?.short_count ?? '—' },
            ].map(({ label, value, color }) => (
              <div key={label} className="tearsheet-kpi">
                <div className="tearsheet-kpi-label">{label}</div>
                <div className="tearsheet-kpi-value" style={color ? { color } : {}}>{value ?? '—'}</div>
              </div>
            ))}
          </div>
          <div className="tearsheet-section-label">Profit Concentration</div>
          <div className="tearsheet-kpi-grid">
            {[
              { label: 'Top-1 Win Share',  value: ext?.top1_profit_share ? `${ext.top1_profit_share}%` : '—' },
              { label: 'Top-5 Win Share',  value: ext?.top5_profit_share ? `${ext.top5_profit_share}%` : '—' },
              { label: 'Top-10 Win Share', value: ext?.top10_profit_share ? `${ext.top10_profit_share}%` : '—' },
            ].map(({ label, value }) => (
              <div key={label} className="tearsheet-kpi">
                <div className="tearsheet-kpi-label">{label}</div>
                <div className="tearsheet-kpi-value">{value}</div>
              </div>
            ))}
          </div>
        </>
      )}

      {dist && (
        <div className="tearsheet-card">
          <h3>Trade P&L Distribution</h3>
          <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 8 }}>
            Mean: <span style={{ color: pnlColor(dist.mean) }}>${formatNumber(dist.mean)}</span>
            &nbsp;&nbsp;Median: <span style={{ color: pnlColor(dist.median) }}>${formatNumber(dist.median)}</span>
          </div>
          <ResponsiveContainer width="100%" height={160}>
            <BarChart data={dist.buckets} margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis dataKey="range" tick={{ fontSize: 13, fill: 'var(--text-muted)' }} tickFormatter={v => `$${v}`} />
              <YAxis tick={{ fontSize: 13, fill: 'var(--text-muted)' }} allowDecimals={false} width={32} />
              <Tooltip formatter={(v) => [v, 'Trades']} labelFormatter={v => `$${v} to $${+v+50}`} contentStyle={tooltipStyle} />
              <Bar dataKey="count" radius={[2, 2, 0, 0]}>
                {dist.buckets.map((e, i) => <Cell key={i} fill={e.range >= 0 ? '#10b981' : '#ef4444'} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      <div id="tearsheet-regime-region" style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span style={{ fontSize: 13, color: 'var(--text-muted)', fontWeight: 500, display: 'flex', alignItems: 'center' }}>
          Regime window:<SectionUpdateDot id="tearsheet-regime-2026-06" />
        </span>
        {[['all', 'All-time'], ['90d', '90d'], ['30d', '30d']].map(([tf, label]) => (
          <button
            key={tf}
            onClick={() => setHmTimeframe(tf)}
            style={{
              padding: '3px 10px', fontSize: 13, cursor: 'pointer', borderRadius: 4,
              border: '1px solid var(--border-color)',
              background: hmTimeframe === tf ? 'rgba(139,92,246,0.75)' : 'transparent',
              color: hmTimeframe === tf ? '#fff' : 'var(--text-muted)',
              fontWeight: hmTimeframe === tf ? 600 : 400,
            }}
          >
            {label}
          </button>
        ))}
        <span style={{ fontSize: 12, color: 'var(--text-muted)', opacity: 0.6, marginLeft: 4 }}>
          — rolling stats &amp; timing heatmap only; KPIs, MFE/MAE, behavior stay all-time
        </span>
      </div>

      {rolling.length > 0 && (
        <div className="tearsheet-card">
          <h3>Rolling 20-Trade Expectancy &amp; Win Rate</h3>
          <ResponsiveContainer width="100%" height={180}>
            <ComposedChart data={rolling} margin={{ top: 4, right: 40, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis dataKey="index" tick={{ fontSize: 13, fill: 'var(--text-muted)' }} tickFormatter={v => `T${v}`} />
              <YAxis yAxisId="exp" tick={{ fontSize: 13, fill: 'var(--text-muted)' }} tickFormatter={v => `$${v}`} width={52} />
              <YAxis yAxisId="wr" orientation="right" tick={{ fontSize: 13, fill: 'var(--text-muted)' }} tickFormatter={v => `${v}%`} width={38} domain={[0,100]} />
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
                      <td style={{ fontWeight: 600, color: 'var(--text-muted)', fontSize: 13 }}>{yr}</td>
                      {MONTH_NAMES.map((_, i) => {
                        const cell = mhByKey[`${yr}-${i+1}`];
                        const v = cell ? parseFloat(cell.pnl) : null;
                        const bg = v === null ? 'transparent' : v > 0 ? `rgba(16,185,129,${Math.min(0.9, 0.15 + Math.abs(v)/2000)})` : `rgba(239,68,68,${Math.min(0.9, 0.15 + Math.abs(v)/2000)})`;
                        return (
                          <td key={i} style={{ background: bg, textAlign: 'right', fontSize: 13, padding: '4px 8px' }}
                            title={cell ? `${cell.trading_days}d, ${cell.win_days}W` : ''}>
                            {v !== null ? `$${(v/1000).toFixed(1)}k` : ''}
                          </td>
                        );
                      })}
                      <td style={{ fontWeight: 700, textAlign: 'right', fontSize: 13, color: pnlColor(yearTotal) }}>
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

      {heatmap.length > 0 && (
        <div className="tearsheet-card">
          <h3>Timing Heatmap — Avg P&L by Day &amp; Hour (ET)</h3>
          <div className="tearsheet-heatmap-scroll">
            <table className="tearsheet-heatmap-table">
              <thead>
                <tr>
                  <th></th>
                  {HOURS.map(h => <th key={h} style={{ fontSize: 13 }}>{h}:00</th>)}
                </tr>
              </thead>
              <tbody>
                {[1,2,3,4,5].map(dow => (
                  <tr key={dow}>
                    <td style={{ fontWeight: 600, color: 'var(--text-muted)', fontSize: 13 }}>{DOW_NAMES[dow]}</td>
                    {HOURS.map(h => {
                      const cell = hmByKey[`${dow}-${h}`];
                      const v = cell ? parseFloat(cell.avg_pnl) : null;
                      const intensity = v !== null ? Math.min(0.9, 0.15 + Math.abs(v) / hmMaxAbs * 0.75) : 0;
                      const bg = v === null ? 'transparent' : v > 0 ? `rgba(16,185,129,${intensity})` : `rgba(239,68,68,${intensity})`;
                      return (
                        <td key={h} style={{ background: bg, textAlign: 'right', fontSize: 13, padding: '4px 6px' }}
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

      {excursion && (
        <>
          <div className="tearsheet-section-label">Excursion &amp; Execution Efficiency
            <span style={{ fontWeight: 400, textTransform: 'none', marginLeft: 8, fontSize: 13 }}>
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
            {excursion.scatter.length > 0 && (
              <div className="tearsheet-card" style={{ flex: 2 }}>
                <h3>MFE vs MAE Scatter (colored by P&L)</h3>
                <ResponsiveContainer width="100%" height={220}>
                  <ComposedChart margin={{ top: 8, right: 16, bottom: 20, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                    <XAxis dataKey="mfe" name="MFE" type="number" tick={{ fontSize: 13, fill: 'var(--text-muted)' }} label={{ value: 'MFE ($)', position: 'insideBottom', offset: -8, fontSize: 13, fill: 'var(--text-muted)' }} />
                    <YAxis dataKey="mae" name="MAE" type="number" tick={{ fontSize: 13, fill: 'var(--text-muted)' }} label={{ value: 'MAE ($)', angle: -90, position: 'insideLeft', fontSize: 13, fill: 'var(--text-muted)' }} width={52} />
                    <Tooltip contentStyle={{ background: 'var(--card-bg)', border: '1px solid var(--border-color)', fontSize: 13 }}
                      formatter={(v, n) => [`$${formatNumber(v)}`, n === 'mfe' ? 'MFE' : n === 'mae' ? 'MAE' : 'P&L']} />
                    <Scatter data={excursion.scatter} fill="#6366f1">
                      {excursion.scatter.map((e, i) => <Cell key={i} fill={e.pnl >= 0 ? 'rgba(16,185,129,0.6)' : 'rgba(239,68,68,0.6)'} />)}
                    </Scatter>
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            )}

            {excursion.entry_eff_dist && (
              <div className="tearsheet-card" style={{ flex: 1 }}>
                <h3>Entry Efficiency Distribution</h3>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={excursion.entry_eff_dist} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                    <XAxis dataKey="range" tick={{ fontSize: 13, fill: 'var(--text-muted)' }} tickFormatter={v => `${v}%`} />
                    <YAxis tick={{ fontSize: 13, fill: 'var(--text-muted)' }} allowDecimals={false} width={32} />
                    <Tooltip contentStyle={{ background: 'var(--card-bg)', border: '1px solid var(--border-color)', fontSize: 13 }}
                      formatter={(v) => [v, 'Trades']} labelFormatter={v => `${v}–${+v+10}%`} />
                    <Bar dataKey="count" fill="#6366f1" radius={[2,2,0,0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            {excursion.exit_eff_dist && (
              <div className="tearsheet-card" style={{ flex: 1 }}>
                <h3>Exit Efficiency Distribution</h3>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={excursion.exit_eff_dist} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                    <XAxis dataKey="range" tick={{ fontSize: 13, fill: 'var(--text-muted)' }} tickFormatter={v => `${v}%`} />
                    <YAxis tick={{ fontSize: 13, fill: 'var(--text-muted)' }} allowDecimals={false} width={32} />
                    <Tooltip contentStyle={{ background: 'var(--card-bg)', border: '1px solid var(--border-color)', fontSize: 13 }}
                      formatter={(v) => [v, 'Trades']} labelFormatter={v => `${v}–${+v+10}%`} />
                    <Bar dataKey="count" fill="#f59e0b" radius={[2,2,0,0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>
        </>
      )}

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
    </div>
  );
}
